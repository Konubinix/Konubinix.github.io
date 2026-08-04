import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

const SYNC_ROOM = 'memories-nowshowing';
const given = new URLSearchParams(location.search).get('sync_url');
if(given){
    localStorage.setItem('frameshare.sync_url', given);
    const clean = new URL(location.href);
    clean.searchParams.delete('sync_url');
    history.replaceState(null, '', clean);
}
const SYNC_URL = localStorage.getItem('frameshare.sync_url');

const shared = new Y.Doc();
const provider = SYNC_URL ? new WebsocketProvider(SYNC_URL, SYNC_ROOM, shared) : null;
const room = shared.getMap('showing');
const pointed = shared.getMap('pointed');
const linkState = document.getElementById('link');
const showLink = word => { linkState.textContent = word; linkState.dataset.state = word; };
showLink(provider ? 'connecting' : 'offline');
if(provider) provider.on('status', e => showLink(e.status === 'connected' ? 'live' : 'offline'));
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/heic': '.heic',
              'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm' };
const hash = address => String(address).split('/').filter(Boolean).pop();
const nameFor = (address, type) =>
    hash(address) + (EXT[type] || '.' + ((type || '').split('/')[1] || 'bin'));
const HOST = 'https://konubinix.eu/';
const ROUTE = { webCid: HOST + 'shareddoc/web', cid: HOST + 'shareddoc/original' };
const OPENED = String(Date.now());
const media = (which, doc) => `${ROUTE[which]}?${doc ? hash(doc[which] || doc.cid) : OPENED}`;
const bytes = (which, doc) => fetch(media(which, doc), { credentials: 'include' });
const said = document.getElementById('said');
const say = text => { said.textContent = text; };
const stage = document.getElementById('stage');
function paint(kind, doc){
    const el = document.createElement(kind);
    el.src = media('webCid', doc);
    if(kind === 'video') el.controls = true; else el.alt = 'the photo the frame is showing';
    stage.replaceChildren(el);
}
const kindOf = doc => String(doc.mimetype || '').startsWith('video/') ? 'video' : 'img';
async function draw(doc){
    if(doc) return paint(kindOf(doc), doc);
    let kind = 'img';
    try {
        const head = await fetch(media('webCid', null), { method: 'HEAD', credentials: 'include' });
        if(String(head.headers.get('content-type') || '').startsWith('video/')) kind = 'video';
    } catch(err){}
    if(!showing) paint(kind, null);
}
async function send(which){
    if(movedOn) return say(MOVED_ON);
    const doc = showing;
    say('');
    try {
        const answer = await bytes(which, doc);
        const blob = await answer.blob();
        const named = doc ? (doc[which] || doc.cid) : (answer.headers.get('x-ipfs-path') || 'photo');
        await navigator.share({ files: [new File([blob], nameFor(named, blob.type), { type: blob.type })] });
    } catch(err){ say(String(err && err.message || err)); }
}
document.getElementById('send-web').onclick = () => send('webCid');
document.getElementById('send-original').onclick = () => send('cid');
const MOVED_ON = 'the frame has moved on — one moment';
const NO_LINK = 'open this from the access link once, so it learns the server';
const NO_FRAME = 'no frame has said what it is showing';
let showing = null, movedOn = false, asked = false;
function look(){
    const doc = room.get('doc'), receipt = pointed.get('cid');
    const vouched = doc && receipt === doc.cid ? doc : null;
    movedOn = !!(doc && receipt !== undefined && receipt !== doc.cid);
    if(vouched && (!showing || vouched.cid !== showing.cid)){ showing = vouched; draw(vouched); }
    else if(!vouched && !asked){ asked = true; draw(null); }
    say(movedOn ? MOVED_ON : !SYNC_URL ? NO_LINK : !doc ? NO_FRAME : '');
}
room.observe(look);
pointed.observe(look);
look();
if('serviceWorker' in navigator){
    const wasControlled = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if(wasControlled) location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
}
