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

async function makeRepo(onSync){
    const params = new URLSearchParams(location.search);
    const fromParam = params.get('sync_url');
    if(fromParam){
        localStorage.setItem('condorcet.sync_url', fromParam);
        const clean = new URL(location);
        clean.searchParams.delete('sync_url');
        history.replaceState(null, '', clean);
    }
    const syncUrl = localStorage.getItem('condorcet.sync_url');
    let adapter = null;
    if(syncUrl){
        adapter = new BrowserWebSocketClientAdapter(syncUrl);
        adapter.on('peer-candidate', () => onSync?.('connected'));
        adapter.on('peer-disconnected', () => onSync?.('disconnected'));
        onSync?.('connecting');
    } else {
        onSync?.('off');
    }
    return new Repo({
        storage: new IndexedDBStorageAdapter('condorcet'),
        network: adapter ? [adapter] : [],
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
    stage: 'identify',   // 'identify' | 'ballot' | 'waiting'
    allVoted: false,
    syncStatus: 'off',   // 'off' | 'connecting' | 'connected' | 'disconnected'
    ui: {},

    get rosterCount(){ return this.scrutin ? this.scrutin.voters.length : 0; },
    get ballotsCount(){ return this.scrutin ? this.scrutin.ballots.length : 0; },
    get nextVoter(){
        if(!this.scrutin) return null;
        const voted = {};
        for(const b of this.scrutin.ballots) voted[b.voter] = true;
        return this.scrutin.voters.find(v => !voted[v]) || null;
    },
    get syncStatusLabel(){
        return ({
            connecting: 'Connexion au serveur…',
            connected: 'Synchronisé',
            disconnected: 'Hors ligne',
        })[this.syncStatus] || '';
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
            this.stage = 'identify';
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
        else this.stage = 'identify';
    },
};

function initialForm(){
    return {
        title: '',
        candidates: ['', ''],
        candidateImages: ['', ''],
        voters: [''],
        mode: 'shared-device',
    };
}

Object.assign(voteStore.ui, {
    createOpen: false,
    form: initialForm(),
});

Object.defineProperty(voteStore, 'candidatesError', {
    enumerable: true, configurable: true,
    get(){
        const cs = this.ui.form.candidates.map(s => s.trim()).filter(Boolean);
        return new Set(cs).size !== cs.length ? 'Doublons dans les candidats.' : '';
    },
});

Object.defineProperty(voteStore, 'votersError', {
    enumerable: true, configurable: true,
    get(){
        const vs = this.ui.form.voters.map(s => s.trim()).filter(Boolean);
        return new Set(vs).size !== vs.length ? 'Doublons dans les votants.' : '';
    },
});

Object.defineProperty(voteStore, 'canCreate', {
    enumerable: true, configurable: true,
    get(){
        const f = this.ui.form;
        const cs = f.candidates.map(s => s.trim()).filter(Boolean);
        const vs = f.voters.map(s => s.trim()).filter(Boolean);
        return f.title.trim() && cs.length >= 2 && vs.length >= 1
            && !this.candidatesError && !this.votersError;
    },
});

const DRAFT_KEY = 'condorcet.form-draft';

function hasNonEmptyDraft(){
    try {
        const raw = localStorage.getItem(DRAFT_KEY);
        if(!raw) return false;
        const d = JSON.parse(raw);
        if(d.title && d.title.trim()) return true;
        if((d.candidates || []).some(c => c && c.trim())) return true;
        if((d.voters || []).some(v => v && v.trim())) return true;
        return false;
    } catch(e){ return false; }
}

Object.assign(voteStore, {
    saveFormDraft(){
        try {
            localStorage.setItem(DRAFT_KEY, JSON.stringify(this.ui.form));
        } catch(e) {}
    },

    restoreFormDraft(){
        try {
            const raw = localStorage.getItem(DRAFT_KEY);
            if(raw) Object.assign(this.ui.form, JSON.parse(raw));
        } catch(e) {}
    },

    clearFormDraft(){
        localStorage.removeItem(DRAFT_KEY);
    },

    cancelCreate(){
        this.clearFormDraft();
        Object.assign(this.ui.form, initialForm());
        this.ui.createOpen = false;
    },
});

function focusFormField(prefix, idx){
    document.querySelector(
        `#createModal input[placeholder="${prefix} ${idx + 1}"]`)?.focus();
}

Object.assign(voteStore, {
    onCandidateTab(i, e){
        if(e.shiftKey) return;
        const arr = this.ui.form.candidates;
        const isLast = i >= arr.length - 1;
        if(isLast && arr[i].trim() === '') return;
        e.preventDefault();
        if(isLast){
            arr.push('');
            this.ui.form.candidateImages.push('');
        }
        requestAnimationFrame(() => focusFormField('Candidat', i + 1));
    },
    onVoterTab(i, e){
        if(e.shiftKey) return;
        const arr = this.ui.form.voters;
        const isLast = i >= arr.length - 1;
        if(isLast && arr[i].trim() === '') return;
        e.preventDefault();
        if(isLast) arr.push('');
        requestAnimationFrame(() => focusFormField('Votant', i + 1));
    },
});

Object.assign(voteStore, {
    openCreate(){ this.restoreFormDraft(); this.ui.createOpen = true; },
    createScrutin(){
        const f = this.ui.form;
        const candidateImages = {};
        const candidates = [];
        f.candidates.forEach((raw, i) => {
            const name = raw.trim();
            if(!name) return;
            candidates.push(name);
            if(f.candidateImages[i]) candidateImages[name] = f.candidateImages[i];
        });
        const voters = f.voters.map(s => s.trim()).filter(Boolean);
        const handle = _repo.create({
            title: f.title.trim(),
            candidates,
            candidateImages,
            voters,
            ballots: [],
            closed: false,
            mode: f.mode,
            method: 'condorcet-random-smith',
            createdAt: Date.now(),
        });
        history.replaceState(null, '', '?doc=' + handle.url);
        this.clearFormDraft();
        this.ui.createOpen = false;
        this.attach(handle);
    },
});

const IMAGE_MAX_DIM = 512;
const IMAGE_QUALITY = 0.75;

function compressImageToDataUrl(file){
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('image load failed'));
            img.onload = () => {
                const scale = Math.min(1, IMAGE_MAX_DIM / Math.max(img.width, img.height));
                const w = Math.round(img.width * scale);
                const h = Math.round(img.height * scale);
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', IMAGE_QUALITY));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

Object.assign(voteStore, {
    async setCandidateImage(i, file){
        if(!file) return;
        try {
            const dataUrl = await compressImageToDataUrl(file);
            this.ui.form.candidateImages[i] = dataUrl;
            this.saveFormDraft();
        } catch(e){
            console.error('compression image candidat', e);
        }
    },

    handleCandidatePaste(i, ev){
        const items = ev.clipboardData && ev.clipboardData.items;
        if(!items) return;
        for(const item of items){
            if(item.kind === 'file' && item.type.startsWith('image/')){
                ev.preventDefault();
                const file = item.getAsFile();
                if(file) this.setCandidateImage(i, file);
                return;
            }
        }
    },

    removeCandidateImage(i){
        this.ui.form.candidateImages[i] = '';
        this.saveFormDraft();
    },
});

Object.assign(voteStore.ui, {
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
});

Object.assign(voteStore.ui, {
    qrOpen: false,
    qrSvg: '',
    shareUrl: '',
});

Object.assign(voteStore, {
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

    // Parametré → une méthode, pas un getter.
    hasBallotFor(name){
        return !!this.scrutin && this.scrutin.ballots.some(b => b.voter === name);
    },

    chooseIdentity(name){
        if(this.scrutin.mode === 'per-device'){
            this.identity = name;
            localStorage.setItem(this.identityKey(), name);
            if(this.hasBallotFor(name)){ this.stage = 'waiting'; return; }
        }
        this.startBallot(name);
    },

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
        }
        this.stage = 'identify';
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
        this.stage = this.scrutin.mode === 'per-device' ? 'waiting' : 'identify';
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
        location.href = location.pathname;
    },

    redoScrutin(){
        const s = this.scrutin;
        const draft = {
            title: s.title,
            candidates: [...s.candidates],
            candidateImages: s.candidates.map(c =>
                (s.candidateImages && s.candidateImages[c]) || ''),
            voters: [...s.voters],
            mode: s.mode,
        };
        try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch(e) {}
        location.href = location.pathname;
    },
});

Object.assign(voteStore.ui, {
    anim: { active: false, step: 0, total: 0, pairs: [], ballots: [],
            full: null, timer: null, legend: '', breakdown: [],
            pairIdx: 0, ballotIdx: 0, speed: 1, _lastPair: -1 },
});

Object.defineProperty(voteStore, 'animCounterText', {
    enumerable: true, configurable: true,
    get(){
        const a = this.ui.anim;
        if(!a.active || !a.pairs.length) return '';
        return `Duel ${a.pairIdx+1}/${a.pairs.length}` +
               ` · Bulletin ${a.ballotIdx+1}/${a.ballots.length}`;
    },
});

Object.assign(voteStore, {
    pairCurrent(a, b){
        if(!this.ui.anim.active || a === b) return false;
        const cur = this.ui.anim.pairs[this.ui.anim.pairIdx];
        if(!cur) return false;
        return (a === cur[0] && b === cur[1]) || (a === cur[1] && b === cur[0]);
    },

    _ballotPref(ballot, a, b){
        const pa = ballot.ranking.indexOf(a);
        const pb = ballot.ranking.indexOf(b);
        if(pa === -1 || pb === -1) return null;
        return pa < pb ? a : b;
    },
});

Object.assign(voteStore, {
    _animPartial(pairIdx, ballotIdx){
        const cs = this.scrutin.candidates;
        const m = {};
        for(const a of cs){
            m[a] = {};
            for(const b of cs) if(b !== a) m[a][b] = '…';
        }
        for(let k = 0; k < pairIdx; k++){
            const [a, b] = this.ui.anim.pairs[k];
            m[a][b] = this.ui.anim.full[a][b];
            m[b][a] = this.ui.anim.full[b][a];
        }
        const [a, b] = this.ui.anim.pairs[pairIdx];
        let xa = 0, xb = 0;
        for(let i = 0; i <= ballotIdx; i++){
            const pref = this._ballotPref(this.ui.anim.ballots[i], a, b);
            if(pref === a) xa++;
            else if(pref === b) xb++;
        }
        m[a][b] = xa;
        m[b][a] = xb;
        return m;
    },

    _animRender(){
        const B = this.ui.anim.ballots.length;
        const s = this.ui.anim.step;
        const p = Math.floor(s / B);
        const bi = s % B;
        const samePair = this.ui.anim._lastPair === p;
        this.ui.anim._lastPair = p;
        this.ui.anim.pairIdx = p;
        this.ui.anim.ballotIdx = bi;
        this.tally.pairwise = this._animPartial(p, bi);
        const [a, b] = this.ui.anim.pairs[p];
        const ballot = this.ui.anim.ballots[bi];
        this.ui.anim.legend = `Duel ${a} vs ${b} — bulletin de ${ballot.voter}`;
        const breakdown = [];
        for(let i = 0; i < B; i++){
            const bal = this.ui.anim.ballots[i];
            breakdown.push({
                voter: bal.voter,
                prefers: this._ballotPref(bal, a, b),
                processed: i <= bi,
                current: i === bi,
            });
        }
        this.ui.anim.breakdown = breakdown;
        if(samePair) this._animValueFlash();
    },

    _animValueFlash(){
        requestAnimationFrame(() => {
            document.querySelectorAll('.pairwise td.pair-current').forEach(el => {
                el.animate([
                    { backgroundColor: 'rgba(249,168,38,.6)' },
                    { backgroundColor: 'rgba(249,168,38,.22)' },
                ], { duration: 400, easing: 'ease-out' });
            });
        });
    },
});

Object.assign(voteStore, {
    animateStart(){
        if(!this.tally || this.ui.anim.active) return;
        const cs = this.scrutin.candidates;
        const pairs = [];
        for(let i = 0; i < cs.length; i++)
            for(let j = i+1; j < cs.length; j++)
                pairs.push([cs[i], cs[j]]);
        const ballots = this.scrutin.ballots.slice();
        if(pairs.length === 0 || ballots.length === 0) return;
        this.ui.anim.full = this.tally.pairwise;
        this.ui.anim.pairs = pairs;
        this.ui.anim.ballots = ballots;
        this.ui.anim.total = pairs.length * ballots.length;
        this.ui.anim.step = 0;
        this.ui.anim.active = true;
        this.ui.anim._lastPair = -1;
        this._animRender();
    },

    animatePlay(){
        if(this.ui.anim.timer) return;
        const interval = 1500 / this.ui.anim.speed;
        this.ui.anim.timer = setInterval(() => {
            if(this.ui.anim.step >= this.ui.anim.total - 1){
                this.animatePause();
                return;
            }
            this.ui.anim.step++;
            this._animRender();
        }, interval);
    },

    animatePause(){
        if(this.ui.anim.timer){
            clearInterval(this.ui.anim.timer);
            this.ui.anim.timer = null;
        }
    },

    animateToggle(){
        if(this.ui.anim.timer){ this.animatePause(); return; }
        if(this.ui.anim.step >= this.ui.anim.total - 1){
            this.ui.anim.step = 0;
            this._animRender();
        }
        this.animatePlay();
    },

    animateNext(){
        if(this.ui.anim.step >= this.ui.anim.total - 1) return;
        this.animatePause();
        this.ui.anim.step++;
        this._animRender();
    },

    animatePrev(){
        if(this.ui.anim.step <= 0) return;
        this.animatePause();
        this.ui.anim.step--;
        this._animRender();
    },

    animateCycleSpeed(){
        const speeds = [1, 2, 0.5];
        const i = speeds.indexOf(this.ui.anim.speed);
        this.ui.anim.speed = speeds[(i + 1) % speeds.length];
        if(this.ui.anim.timer){
            this.animatePause();
            this.animatePlay();
        }
    },

    animateStop(){
        this.animatePause();
        if(this.ui.anim.full) this.tally.pairwise = this.ui.anim.full;
        this.ui.anim.active = false;
        this.ui.anim.legend = '';
        this.ui.anim.pairs = [];
        this.ui.anim.ballots = [];
        this.ui.anim.breakdown = [];
        this.ui.anim.step = 0;
        this.ui.anim.total = 0;
        this.ui.anim.full = null;
        this.ui.anim._lastPair = -1;
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
    _repo = await makeRepo(s => { reactiveStore.syncStatus = s; });
    const handle = await loadInitialHandle(_repo);
    if(handle) reactiveStore.attach(handle);
    createApp(reactiveStore).mount('body');
    document.body.setAttribute('data-app-ready', '1');
    if(!handle && hasNonEmptyDraft()) reactiveStore.openCreate();
})();
