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
const ROUTE = { webCid: HOST + 'shareddoc', cid: HOST + 'shareddocoriginal' };
const media = (which, doc) => `${ROUTE[which]}?${hash(doc[which] || doc.cid)}`;
const bytes = (which, doc) => fetch(media(which, doc), { credentials: 'include' });
const said = document.getElementById('said');
const say = text => { said.textContent = text; };
const stage = document.getElementById('stage');
function draw(doc){
    const video = String(doc.mimetype || '').startsWith('video/');
    const el = document.createElement(video ? 'video' : 'img');
    el.src = media('webCid', doc);
    if(video) el.controls = true; else el.alt = 'the photo the frame is showing';
    stage.replaceChildren(el);
}
async function send(which){
    const doc = showing; if(!doc) return;
    say('');
    try {
        const blob = await (await bytes(which, doc)).blob();
        const name = nameFor(doc[which] || doc.cid, blob.type);
        await navigator.share({ files: [new File([blob], name, { type: blob.type })] });
    } catch(err){ say(String(err && err.message || err)); }
}
document.getElementById('send-web').onclick = () => send('webCid');
document.getElementById('send-original').onclick = () => send('cid');
let showing = null;
function look(){
    if(!SYNC_URL) return say('open this from the access link once, so it learns the server');
    const doc = room.get('doc');
    if(!doc) return say('no frame has said what it is showing');
    if(showing && doc.cid === showing.cid) return;
    showing = doc; say(''); draw(doc);
}
room.observe(look);
look();
if('serviceWorker' in navigator){
    const wasControlled = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if(wasControlled) location.reload();
    });
    navigator.serviceWorker.register('sw.js').catch(() => {});
}
