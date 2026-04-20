import { createApp, reactive } from 'petite-vue';
import qrcode from 'qrcode-generator';
window.qrcode = qrcode;

import * as Automerge from '@automerge/automerge';
import { Repo, isValidAutomergeUrl } from '@automerge/automerge-repo';
import { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb';
import { BrowserWebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket';

async function initAutomerge(){
    // Avec rspack + =experiments.asyncWebAssembly=, l'entrée
    // =fullfat_bundler= d'Automerge se câble toute seule : =import * from
    // "*.wasm"= produit un module JS dont les exports sont les fonctions
    // wasm-bindgen, le WASM est instancié à l'import. Pas de
    // =initializeWasm= à appeler.
}

async function makeRepo(){
    const params = new URLSearchParams(location.search);
    const fromParam = params.get('sync_url');
    if(fromParam){
        localStorage.setItem('condorcet.sync_url', fromParam);
        const clean = new URL(location);
        clean.searchParams.delete('sync_url');
        history.replaceState(null, '', clean);
    }
    const syncUrl = localStorage.getItem('condorcet.sync_url');
    const network = syncUrl ? [new BrowserWebSocketClientAdapter(syncUrl)] : [];
    return new Repo({
        storage: new IndexedDBStorageAdapter('condorcet'),
        network,
    });
}

async function loadInitialHandle(repo){
    const urlParam = new URLSearchParams(location.search).get('doc');
    if(!urlParam || !isValidAutomergeUrl(urlParam)) return null;
    const handle = repo.find(urlParam);
    await Promise.race([
        handle.whenReady(['ready', 'unavailable']).catch(() => {}),
        new Promise(r => setTimeout(r, 3000)),
    ]);
    return handle;
}

function pairwiseMatrix(candidates, ballots){
    const m = {};
    for(const a of candidates){
        m[a] = {};
        for(const b of candidates) if(b !== a) m[a][b] = 0;
    }
    for(const ballot of ballots){
        const pos = {};
        ballot.ranking.forEach((c, i) => { pos[c] = i; });
        for(let i = 0; i < candidates.length; i++){
            for(let j = i+1; j < candidates.length; j++){
                const a = candidates[i], b = candidates[j];
                if(a in pos && b in pos){
                    if(pos[a] < pos[b]) m[a][b]++;
                    else m[b][a]++;
                }
            }
        }
    }
    return m;
}

function condorcetWinner(candidates, m){
    for(const c of candidates){
        const beatsAll = candidates.every(o => o === c || m[c][o] > m[o][c]);
        if(beatsAll) return c;
    }
    return null;
}

function smithSet(candidates, m){
    let smith = new Set(candidates);
    let changed = true;
    while(changed){
        changed = false;
        for(const c of Array.from(smith)){
            const outsiders = candidates.filter(o => !smith.has(o));
            const beatenByOutside = outsiders.some(o => m[o][c] > m[c][o]);
            if(beatenByOutside){ smith.delete(c); changed = true; }
        }
    }
    return Array.from(smith).sort();
}

async function seedFromBallots(ballots){
    const normalised = ballots
          .map(b => ({voter: b.voter, ranking: b.ranking}))
          .sort((a, b) => a.voter.localeCompare(b.voter));
    const payload = JSON.stringify(normalised);
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    return new Uint8Array(buf);
}

function mulberry32(seed){
    let a = seed >>> 0;
    return function(){
        a |= 0; a = a + 0x6D2B79F5 | 0;
        let t = Math.imul(a ^ a >>> 15, 1 | a);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

async function computeTally(scrutin){
    const m = pairwiseMatrix(scrutin.candidates, scrutin.ballots);
    const w = condorcetWinner(scrutin.candidates, m);
    if(w) return { kind: 'condorcet', winner: w, pairwise: m };
    const smith = smithSet(scrutin.candidates, m);
    const seedBytes = await seedFromBallots(scrutin.ballots);
    const seedInt = new DataView(seedBytes.buffer).getUint32(0);
    const rng = mulberry32(seedInt);
    const pick = smith[Math.floor(rng() * smith.length)];
    const seedShort = Array.from(seedBytes.slice(0, 4))
          .map(b => b.toString(16).padStart(2, '0')).join('');
    return { kind: 'random-smith', winner: pick, smith, pairwise: m, seedShort };
}

function cloneDoc(doc){
    return doc ? JSON.parse(JSON.stringify(doc)) : doc;
}

let _repo = null;
let _handle = null;

const voteStore = {
    scrutin: null,
    tally: null,
    stage: 'pass',       // 'pass' | 'ballot' | 'identify' | 'waiting'
    allVoted: false,
    ui: {},

    get rosterCount(){ return this.scrutin ? this.scrutin.voters.length : 0; },
    get ballotsCount(){ return this.scrutin ? this.scrutin.ballots.length : 0; },
    get nextVoter(){
        if(!this.scrutin) return null;
        const voted = {};
        for(const b of this.scrutin.ballots) voted[b.voter] = true;
        return this.scrutin.voters.find(v => !voted[v]) || null;
    },

    change(fn){
        _handle.change(fn);
        this.scrutin = cloneDoc(_handle.docSync());
        this.syncFlags();
    },

    syncFlags(){
        const s = this.scrutin;
        this.allVoted = !!s && s.ballots.length >= s.voters.length;
    },

    attach(handle){
        _handle = handle;
        const doc = handle.docSync();
        if(doc){
            this.scrutin = cloneDoc(doc);
            this.syncFlags();
            if(doc.closed) computeTally(doc).then(t => { this.tally = t; });
            this.initStage(doc);
        } else {
            this.stage = 'pass';
        }
        handle.on('change', ev => {
            this.scrutin = cloneDoc(ev.doc);
            this.syncFlags();
            if(ev.doc.closed && !this.tally){
                computeTally(ev.doc).then(t => { this.tally = t; });
            }
        });
    },

    initStage(doc){
        if(doc.mode === 'per-device') this.initStagePerDevice(doc);
        else this.stage = 'pass';
    },
};

Object.assign(voteStore.ui, {
    createOpen: false,
    form: {
        title: '',
        candidates: ['', ''],
        voters: [''],
        mode: 'shared-device',
    },
});

Object.defineProperty(voteStore, 'createError', {
    enumerable: true, configurable: true,
    get(){
        const f = this.ui.form;
        const cs = f.candidates.map(s => s.trim()).filter(Boolean);
        const vs = f.voters.map(s => s.trim()).filter(Boolean);
        if(new Set(cs).size !== cs.length) return 'Doublons dans les candidats.';
        if(new Set(vs).size !== vs.length) return 'Doublons dans les votants.';
        return '';
    },
});

Object.defineProperty(voteStore, 'canCreate', {
    enumerable: true, configurable: true,
    get(){
        const f = this.ui.form;
        const cs = f.candidates.map(s => s.trim()).filter(Boolean);
        const vs = f.voters.map(s => s.trim()).filter(Boolean);
        return f.title.trim() && cs.length >= 2 && vs.length >= 1 && !this.createError;
    },
});

Object.assign(voteStore, {
    openCreate(){ this.ui.createOpen = true; },

    createScrutin(){
        const f = this.ui.form;
        const candidates = f.candidates.map(s => s.trim()).filter(Boolean);
        const voters = f.voters.map(s => s.trim()).filter(Boolean);
        const handle = _repo.create({
            title: f.title.trim(),
            candidates,
            voters,
            ballots: [],
            closed: false,
            mode: f.mode,
            method: 'condorcet-random-smith',
            createdAt: Date.now(),
        });
        history.replaceState(null, '', '?doc=' + handle.url);
        this.ui.createOpen = false;
        this.attach(handle);
    },
});

Object.assign(voteStore.ui, {
    qrOpen: false,
    qrSvg: '',
    shareUrl: '',
    shareToast: '',
});

Object.assign(voteStore, {
    currentShareUrl(){
        return location.origin + location.pathname + location.search;
    },

    async shareScrutin(){
        const url = this.currentShareUrl();
        const title = (this.scrutin && this.scrutin.title) || 'Scrutin';
        if(navigator.share){
            try { await navigator.share({ title, url }); return; }
            catch(e){ /* annulé ou non supporté → fallback clipboard */ }
        }
        try {
            await navigator.clipboard.writeText(url);
            this.ui.shareToast = 'Lien copié';
            setTimeout(() => { this.ui.shareToast = ''; }, 2000);
        } catch(e){
            this.ui.shareToast = 'Copie impossible';
            setTimeout(() => { this.ui.shareToast = ''; }, 2000);
        }
    },

    openQR(){
        const url = this.currentShareUrl();
        const qr = window.qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        this.ui.qrSvg = qr.createSvgTag({ cellSize: 6, margin: 2 });
        this.ui.shareUrl = url;
        this.ui.qrOpen = true;
    },
});

function shuffled(arr){
    const a = arr.slice();
    for(let i = a.length - 1; i > 0; i--){
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

Object.assign(voteStore.ui, { ranking: [] });

Object.assign(voteStore, {
    currentVoter: null,

    startBallot(voter){
        this.currentVoter = voter || this.nextVoter;
        this.ui.ranking = shuffled(this.scrutin.candidates);
        this.stage = 'ballot';
    },

    cancelBallot(){
        this.currentVoter = null;
        this.ui.ranking = [];
        if(this.scrutin && this.scrutin.mode === 'per-device'){
            this.identity = null;
            localStorage.removeItem(this.identityKey());
            this.stage = 'identify';
        } else {
            this.stage = 'pass';
        }
    },

    submitBallot(){
        const ranking = this.ui.ranking.slice();
        const voter = this.currentVoter;
        this.change(d => {
            const existing = d.ballots.findIndex(b => b.voter === voter);
            const ballot = { voter, ranking, at: Date.now() };
            if(existing >= 0) d.ballots[existing] = ballot;
            else d.ballots.push(ballot);
        });
        this.currentVoter = null;
        this.ui.ranking = [];
        this.stage = this.scrutin.mode === 'per-device' ? 'waiting' : 'pass';
    },

    bindRankReorder(ol){
        const store = this;
        ol.addEventListener('reorder:move', e => {
            const order = store.ui.ranking.slice();
            const [moved] = order.splice(e.detail.from, 1);
            order.splice(e.detail.to, 0, moved);
            store.ui.ranking = order;
        });
    },
});

Object.assign(voteStore, {
    identity: null,  // le votant attaché à CE navigateur

    identityKey(){ return 'condorcet.identity.' + _handle.url; },

    // Parametré → une méthode, pas un getter.
    hasBallotFor(name){
        return !!this.scrutin && this.scrutin.ballots.some(b => b.voter === name);
    },

    initStagePerDevice(doc){
        const stored = localStorage.getItem(this.identityKey());
        if(stored && doc.voters.includes(stored)){
            this.identity = stored;
            if(doc.ballots.some(b => b.voter === stored)){
                this.stage = 'waiting';
            } else {
                this.startBallot(stored);
            }
        } else {
            this.stage = 'identify';
        }
    },

    chooseIdentity(name){
        this.identity = name;
        localStorage.setItem(this.identityKey(), name);
        if(this.hasBallotFor(name)) this.stage = 'waiting';
        else this.startBallot(name);
    },
});

Object.defineProperty(voteStore, 'tallyExplanation', {
    enumerable: true, configurable: true,
    get(){
        if(!this.tally) return '';
        if(this.tally.kind === 'condorcet')
            return 'Vainqueur de Condorcet strict : bat tous les autres en duel.';
        return 'Aucun vainqueur de Condorcet : cycle détecté. Tirage au sort reproductible dans le Smith set.';
    },
});

Object.assign(voteStore, {
    async close(){
        this.change(d => { d.closed = true; });
        this.tally = await computeTally(this.scrutin);
    },

    newVote(){
        // Repart sur l'empty-state : on strip =?doc=...= et on recharge.
        // Le doc reste persisté en IndexedDB et accessible via son URL ;
        // c'est juste cet onglet qui revient à zéro.
        location.href = location.pathname;
    },
});

Object.assign(voteStore.ui, {
    newVoter: '',
    addVoterError: '',
});

Object.assign(voteStore, {
    addVoter(){
        this.ui.addVoterError = '';
        const name = (this.ui.newVoter || '').trim();
        if(!name){ this.ui.addVoterError = 'Nom requis'; return; }
        if(this.scrutin.voters.includes(name)){
            this.ui.addVoterError = 'Ce nom est déjà dans la liste';
            return;
        }
        const wasIdentifying = this.scrutin.mode === 'per-device' && this.stage === 'identify';
        this.change(d => {
            d.voters.push(name);
            if(d.closed) d.closed = false;
        });
        this.tally = null;
        this.ui.newVoter = '';
        if(wasIdentifying) this.chooseIdentity(name);
    },
});

// ── Drag-and-drop reorder engine (framework-agnostic) ──
// Binds once on document. Handles any =.reorder-list= with =.reorder-item=
// children and a =.reorder-grip= handle on each item. Fires
// =reorder:move= on the list (bubbling CustomEvent with
// =detail = {from, to}=) when the cursor crosses into a new slot during
// drag. Consumers listen and update their own state; the engine never
// mutates the consumer's store.
(function initReorderEngine() {
    var dragging = null;

    function fireMove(list, fromIdx, toIdx) {
        list.dispatchEvent(new CustomEvent('reorder:move', {
            detail: { from: fromIdx, to: toIdx },
            bubbles: true,
        }));
    }

    function markPlaceholder() {
        var items = dragging.list.querySelectorAll('.reorder-item');
        items.forEach(function(el, i) {
            el.classList.toggle('drag-placeholder', i === dragging.curIdx);
        });
    }

    function updateDropLine(clientY) {
        var items = dragging.list.querySelectorAll('.reorder-item');
        var listRect = dragging.list.getBoundingClientRect();
        var lineY = null;
        for (var i = 0; i < items.length; i++) {
            var rect = items[i].getBoundingClientRect();
            var mid = rect.top + rect.height / 2;
            if (clientY < mid) {
                lineY = rect.top - listRect.top - 1;
                break;
            }
        }
        if (lineY === null) {
            var last = items[items.length - 1].getBoundingClientRect();
            lineY = last.bottom - listRect.top + 2;
        }
        dragging.dropLine.style.top = lineY + 'px';
    }

    function stripFrameworkAttrs(root) {
        root.querySelectorAll('*').forEach(function(el) {
            Array.from(el.attributes).forEach(function(a) {
                if (a.name.indexOf('x-') === 0 ||
                    a.name.indexOf('v-') === 0 ||
                    a.name.indexOf(':') === 0 ||
                    a.name.indexOf('@') === 0) {
                    el.removeAttribute(a.name);
                }
            });
        });
    }

    function onStart(e) {
        var grip = e.target.closest('.reorder-grip');
        if (!grip) return;
        var list = grip.closest('.reorder-list');
        var item = grip.closest('.reorder-item');
        if (!list || !item) return;
        var idx = parseInt(item.dataset.idx, 10);
        var rect = item.getBoundingClientRect();
        var clientY = e.clientY;

        var clone = document.createElement('div');
        clone.className = 'drag-clone';
        clone.style.width = rect.width + 'px';
        clone.innerHTML = item.innerHTML;
        stripFrameworkAttrs(clone);
        clone.style.left = rect.left + 'px';
        clone.style.top = rect.top + 'px';
        document.body.appendChild(clone);

        var dropLine = document.createElement('div');
        dropLine.className = 'drag-drop-line';
        list.appendChild(dropLine);

        dragging = {
            list: list, curIdx: idx,
            clone: clone, dropLine: dropLine, offsetY: clientY - rect.top,
        };
        markPlaceholder();
        updateDropLine(clientY);
        e.preventDefault();
    }

    function onMove(e) {
        if (!dragging) return;
        e.preventDefault();
        var clientY = e.clientY;
        dragging.clone.style.top = (clientY - dragging.offsetY) + 'px';
        updateDropLine(clientY);
        var items = dragging.list.querySelectorAll('.reorder-item');
        for (var i = 0; i < items.length; i++) {
            var rect = items[i].getBoundingClientRect();
            if (clientY >= rect.top && clientY <= rect.bottom && i !== dragging.curIdx) {
                fireMove(dragging.list, dragging.curIdx, i);
                dragging.curIdx = i;
                markPlaceholder();
                var rank = dragging.clone.querySelector('.reorder-rank');
                if (rank) rank.textContent = i + 1;
                break;
            }
        }
    }

    function onEnd() {
        if (!dragging) return;
        dragging.clone.remove();
        dragging.dropLine.remove();
        dragging.list.querySelectorAll('.drag-placeholder').forEach(function(el) {
            el.classList.remove('drag-placeholder');
        });
        dragging = null;
    }

    document.addEventListener('pointerdown', function(e) {
        if (e.target.closest('.reorder-grip')) onStart(e);
    });
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);
})();

const reactiveStore = reactive(voteStore);
window.__voteStore = reactiveStore;

// Hook de test : force un ranking sans passer par le drag-and-drop.
window.testForceRanking = function(order){
    reactiveStore.ui.ranking = order.slice();
};

(async function init(){
    await initAutomerge();
    _repo = await makeRepo();
    const handle = await loadInitialHandle(_repo);
    if(handle) reactiveStore.attach(handle);
    createApp(reactiveStore).mount('body');
    document.body.setAttribute('data-app-ready', '1');
})();
