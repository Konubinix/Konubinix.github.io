import { createApp, reactive } from 'petite-vue';
import qrcode from 'qrcode-generator';
window.qrcode = qrcode;

// Modules Automerge chargés dynamiquement à la première demande.
// Avec rspack + =experiments.asyncWebAssembly=, l'entrée
// =fullfat_bundler= se câble toute seule : =import * from "*.wasm"=
// produit un module JS dont les exports sont les fonctions
// wasm-bindgen, le WASM est instancié à l'import dynamique.
let _automergePromise = null;
function loadAutomerge(){
    if(!_automergePromise){
        _automergePromise = (async () => {
            const [repoMod, idbMod, wsMod] = await Promise.all([
                import('@automerge/automerge-repo'),
                import('@automerge/automerge-repo-storage-indexeddb'),
                import('@automerge/automerge-repo-network-websocket'),
            ]);
            return {
                Repo: repoMod.Repo,
                isValidAutomergeUrl: repoMod.isValidAutomergeUrl,
                IndexedDBStorageAdapter: idbMod.IndexedDBStorageAdapter,
                WebSocketClientAdapter: wsMod.WebSocketClientAdapter,
            };
        })();
    }
    return _automergePromise;
}

async function makeRepo(onSync){
    const am = await loadAutomerge();
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
        adapter = new am.WebSocketClientAdapter(syncUrl);
        adapter.on('peer-candidate', () => onSync?.('connected'));
        adapter.on('peer-disconnected', () => onSync?.('disconnected'));
        onSync?.('connecting');
    } else {
        onSync?.('off');
    }
    return new am.Repo({
        storage: new am.IndexedDBStorageAdapter('condorcet'),
        network: adapter ? [adapter] : [],
    });
}

let _repoPromise = null;
function ensureRepo(reactiveStore){
    if(!_repoPromise){
        _repoPromise = makeRepo(s => { reactiveStore.syncStatus = s; })
            .then(repo => { _repo = repo; return repo; });
    }
    return _repoPromise;
}

async function loadInitialHandle(repo){
    const am = await loadAutomerge();
    const urlParam = new URLSearchParams(location.search).get('doc');
    if(!urlParam || !am.isValidAutomergeUrl(urlParam)) return null;
    return await repo.find(urlParam);
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

function dataUrlToBytes(dataUrl){
    const b64 = dataUrl.split(',', 2)[1];
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for(let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
function bytesToObjectUrl(bytes){
    return URL.createObjectURL(new Blob([bytes], {type: 'image/jpeg'}));
}
function bytesToDataUrl(bytes){
    let bin = '';
    for(let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return 'data:image/jpeg;base64,' + btoa(bin);
}

function cloneDoc(doc){
    if(!doc) return doc;
    const { candidateImages, ...rest } = doc;
    return JSON.parse(JSON.stringify(rest));
}

let _repo = null;
let _handle = null;

const voteStore = {
    scrutin: null,
    candidateImageUrls: {},
    tally: null,
    stage: 'identify',   // 'identify' | 'ballot' | 'waiting'
    allVoted: false,
    syncStatus: 'off',   // 'off' | 'connecting' | 'connected' | 'disconnected'
    loadingDoc: false,   // true tant qu'on attend la résolution d'un =?doc=...= (cf. init lazy)
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

    _refreshImageUrls(doc){
        for(const u of Object.values(this.candidateImageUrls)) URL.revokeObjectURL(u);
        const map = {};
        if(doc && doc.candidateImages){
            for(const [name, bytes] of Object.entries(doc.candidateImages)){
                map[name] = bytesToObjectUrl(bytes);
            }
        }
        this.candidateImageUrls = map;
    },

    change(fn){
        _handle.change(fn);
        const doc = _handle.doc();
        this.scrutin = cloneDoc(doc);
        this._refreshImageUrls(doc);
        this.syncFlags();
    },

    syncFlags(){
        const s = this.scrutin;
        this.allVoted = !!s && s.ballots.length >= s.voters.length;
    },

    attach(handle){
        _handle = handle;
        const doc = handle.doc();
        if(doc){
            this.scrutin = cloneDoc(doc);
            this._refreshImageUrls(doc);
            this.syncFlags();
            this.recordScrutin(handle.url, doc.title);
            if(doc.closed) computeTally(doc).then(t => { this.tally = t; });
            this.initStage(doc);
        } else {
            this.stage = 'identify';
        }
        handle.on('change', ev => {
            this.scrutin = cloneDoc(ev.doc);
            this._refreshImageUrls(ev.doc);
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

const PAST_KEY = 'condorcet.past-scrutins';

function loadPastScrutins(){
    try {
        const raw = localStorage.getItem(PAST_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return arr.sort((a, b) => b.at - a.at);
    } catch(e){ return []; }
}

function savePastScrutins(arr){
    try { localStorage.setItem(PAST_KEY, JSON.stringify(arr)); } catch(e) {}
}

Object.assign(voteStore, {
    pastScrutins: [],

    recordScrutin(url, title){
        const arr = (this.pastScrutins || []).filter(s => s.url !== url);
        arr.push({ url, title: title || '', at: Date.now() });
        arr.sort((a, b) => b.at - a.at);
        this.pastScrutins = arr;
        savePastScrutins(arr);
    },

    forgetScrutin(url){
        if(!confirm("Retirer ce scrutin de la liste ? Le doc reste sur l'appareil.")) return;
        const arr = (this.pastScrutins || []).filter(s => s.url !== url);
        this.pastScrutins = arr;
        savePastScrutins(arr);
    },
});

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

function _findDuplicates(items){
    const counts = {};
    items.forEach(s => {
        const t = s.trim();
        if(!t) return;
        counts[t] = (counts[t] || 0) + 1;
    });
    return Object.keys(counts).filter(k => counts[k] > 1);
}

Object.defineProperty(voteStore, 'duplicateCandidates', {
    enumerable: true, configurable: true,
    get(){ return _findDuplicates(this.ui.form.candidates); },
});

Object.defineProperty(voteStore, 'duplicateVoters', {
    enumerable: true, configurable: true,
    get(){ return _findDuplicates(this.ui.form.voters); },
});

Object.defineProperty(voteStore, 'candidatesError', {
    enumerable: true, configurable: true,
    get(){ return this.duplicateCandidates.length > 0 ? 'Doublons dans les candidats.' : ''; },
});

Object.defineProperty(voteStore, 'votersError', {
    enumerable: true, configurable: true,
    get(){ return this.duplicateVoters.length > 0 ? 'Doublons dans les votants.' : ''; },
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
        if(hasNonEmptyDraft() && !confirm("Annuler ? Le brouillon (titre, candidats, votants) sera effacé.")) return;
        this._doCancelCreate();
        if(history.state && history.state.overlay === 'create') history.back();
    },

    _doCancelCreate(){
        this.clearFormDraft();
        Object.assign(this.ui.form, initialForm());
        this.ui.importUrl = '';
        this.ui.importError = '';
        this.ui.createOpen = false;
    },
});

Object.assign(voteStore.ui, {
    importUrl: '',
    importError: '',
});

Object.assign(voteStore, {
    async importFromUrl(){
        this.ui.importError = '';
        const raw = (this.ui.importUrl || '').trim();
        if(!raw) return;
        let url = raw;
        if(/^https?:\/\//.test(raw)){
            try {
                url = new URL(raw).searchParams.get('doc') || '';
            } catch(e){ this.ui.importError = 'URL invalide'; return; }
        }
        const am = await loadAutomerge();
        if(!am.isValidAutomergeUrl(url)){
            this.ui.importError = 'Pas un lien automerge:';
            return;
        }
        try {
            const repo = await ensureRepo(this);
            const handle = await repo.find(url);
            const doc = handle.doc();
            if(!doc){ this.ui.importError = 'Doc introuvable'; return; }
            const cands = [...(doc.candidates || [])];
            Object.assign(this.ui.form, {
                title: doc.title || '',
                candidates: cands.length ? cands : ['', ''],
                candidateImages: cands.map(c => {
                    const bytes = doc.candidateImages && doc.candidateImages[c];
                    return bytes ? bytesToDataUrl(bytes) : '';
                }),
                voters: doc.voters && doc.voters.length ? [...doc.voters] : [''],
                mode: doc.mode || 'shared-device',
            });
            this.saveFormDraft();
            this.ui.importUrl = '';
        } catch(e){
            this.ui.importError = 'Erreur : ' + e.message;
        }
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
    openCreate(){
        this.restoreFormDraft();
        this.ui.createOpen = true;
        pushOverlay('create');
    },
    async createScrutin(){
        const repo = await ensureRepo(this);
        const f = this.ui.form;
        const candidateImages = {};
        const candidates = [];
        f.candidates.forEach((raw, i) => {
            const name = raw.trim();
            if(!name) return;
            candidates.push(name);
            if(f.candidateImages[i]) candidateImages[name] = dataUrlToBytes(f.candidateImages[i]);
        });
        const voters = f.voters.map(s => s.trim()).filter(Boolean);
        const handle = repo.create({
            title: f.title.trim(),
            candidates,
            candidateImages,
            voters,
            ballots: [],
            drafts: {},
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
        if(!confirm('Retirer cette photo ?')) return;
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
        pushOverlay('qr');
    },

    closeQR(){
        this._doCloseQR();
        if(history.state && history.state.overlay === 'qr') history.back();
    },

    _doCloseQR(){
        this.ui.qrOpen = false;
    },
});

Object.assign(voteStore, {
    goToMenu(){
        location.search = '';
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

Object.assign(voteStore.ui, {
    ranking: [],
    confirmingSubmit: false,
    ballotLayout: localStorage.getItem('condorcet.ballot-layout') || 'grid',
});

Object.assign(voteStore, {
    toggleBallotLayout(){
        this.ui.ballotLayout = this.ui.ballotLayout === 'grid' ? 'column' : 'grid';
        localStorage.setItem('condorcet.ballot-layout', this.ui.ballotLayout);
    },
});

Object.assign(voteStore, {
    currentVoter: null,

    // Parametré → une méthode, pas un getter.
    hasBallotFor(name){
        return !!this.scrutin && this.scrutin.ballots.some(b => b.voter === name);
    },

    loadSubmitted(voter){
        return this.scrutin?.ballots.find(b => b.voter === voter)?.ranking;
    },

    switchMode(){
        const newMode = this.scrutin.mode === 'per-device' ? 'shared-device' : 'per-device';
        this.change(d => { d.mode = newMode; });
        if(newMode === 'shared-device' && this.stage === 'waiting'){
            this.identity = null;
            localStorage.removeItem(this.identityKey());
            this.stage = 'identify';
        }
    },

    loadPartial(voter){
        const drafts = (this.scrutin && this.scrutin.drafts) || {};
        const draft = drafts[voter];
        if(!draft) return null;
        const order = draft.ranking;
        const candidates = this.scrutin.candidates;
        if(!Array.isArray(order) || order.length !== candidates.length) return null;
        const cs = new Set(candidates);
        if(!order.every(c => cs.has(c)) || new Set(order).size !== order.length) return null;
        return order;
    },

    savePartial(voter, ranking){
        this.change(d => {
            if(!d.drafts) d.drafts = {};
            d.drafts[voter] = { ranking, at: Date.now() };
        });
    },

    clearPartial(voter){
        this.change(d => {
            if(d.drafts && d.drafts[voter]) delete d.drafts[voter];
        });
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
        this.ui.ranking = this.loadPartial(this.currentVoter)
            || this.loadSubmitted(this.currentVoter)
            || shuffled(this.scrutin.candidates);
        this.stage = 'ballot';
        pushOverlay('ballot');
    },

    cancelBallot(){
        this._doCancelBallot();
        if(history.state && history.state.overlay === 'ballot') history.back();
    },

    _doCancelBallot(){
        this.currentVoter = null;
        this.ui.ranking = [];
        this.ui.confirmingSubmit = false;
        if(this.scrutin && this.scrutin.mode === 'per-device'){
            this.identity = null;
            localStorage.removeItem(this.identityKey());
        }
        this.stage = 'identify';
    },

    submitBallot(){
        this.ui.confirmingSubmit = true;
    },

    cancelSubmit(){
        this.ui.confirmingSubmit = false;
    },

    confirmSubmit(){
        this.ui.confirmingSubmit = false;
        const ranking = this.ui.ranking.slice();
        const voter = this.currentVoter;
        this.change(d => {
            const existing = d.ballots.findIndex(b => b.voter === voter);
            const ballot = { voter, ranking, at: Date.now() };
            if(existing >= 0) d.ballots[existing] = ballot;
            else d.ballots.push(ballot);
            if(d.drafts && d.drafts[voter]) delete d.drafts[voter];
        });
        this.currentVoter = null;
        this.ui.ranking = [];
        this.stage = this.scrutin.mode === 'per-device' ? 'waiting' : 'identify';
        if(history.state && history.state.overlay === 'ballot') history.back();
    },

    bindRankReorder(ol){
        const store = this;
        ol.addEventListener('reorder:move', e => {
            const order = store.ui.ranking.slice();
            const [moved] = order.splice(e.detail.from, 1);
            order.splice(e.detail.to, 0, moved);
            store.ui.ranking = order;
            if(store.currentVoter) store.savePartial(store.currentVoter, order);
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
        const liveImages = (_handle && _handle.doc() && _handle.doc().candidateImages) || {};
        const draft = {
            title: s.title,
            candidates: [...s.candidates],
            candidateImages: s.candidates.map(c => {
                const bytes = liveImages[c];
                return bytes ? bytesToDataUrl(bytes) : '';
            }),
            voters: [...s.voters],
            mode: s.mode,
        };
        try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch(e) {}
        location.href = location.pathname;
    },

    editBallotAfterTally(){
        this.change(d => { d.closed = false; });
        this.tally = null;
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

function pluralityResult(candidates, ballots){
    const counts = {};
    for(const c of candidates) counts[c] = 0;
    for(const b of ballots){
        const first = b.ranking[0];
        if(first in counts) counts[first]++;
    }
    const top = Math.max(0, ...Object.values(counts));
    const winners = candidates.filter(c => counts[c] === top);
    return { counts, winners };
}

Object.defineProperty(voteStore, 'plurality', {
    enumerable: true, configurable: true,
    get(){
        if(!this.scrutin || !this.tally) return null;
        return pluralityResult(this.scrutin.candidates, this.scrutin.ballots);
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

Object.assign(voteStore, {
    removeVoter(name){
        if(!confirm(`Retirer ${name} ? Son bulletin et son brouillon seront effacés.`)) return;
        const vIdx = this.scrutin.voters.indexOf(name);
        const bIdx = this.scrutin.ballots.findIndex(b => b.voter === name);
        this.change(d => {
            d.voters.splice(vIdx, 1);
            if(bIdx >= 0) d.ballots.splice(bIdx, 1);
            if(d.drafts && d.drafts[name]) delete d.drafts[name];
            if(d.closed) d.closed = false;
        });
        this.tally = null;
    },
});

function pushOverlay(name){
    history.pushState({ overlay: name }, '');
}

function syncOverlaysFromHistory(store){
    const overlay = history.state && history.state.overlay;
    if(store.ui.qrOpen && overlay !== 'qr') store._doCloseQR();
    if(store.ui.createOpen && overlay !== 'create') store._doCancelCreate();
    if(store.stage === 'ballot' && overlay !== 'ballot') store._doCancelBallot();
}

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
        items.forEach(function(el) {
            el.classList.toggle('drag-placeholder', el === dragging.itemEl);
        });
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
        var clientX = e.clientX;
        var clientY = e.clientY;

        var clone = document.createElement('div');
        clone.className = 'drag-clone';
        clone.style.width = rect.width + 'px';
        clone.innerHTML = item.innerHTML;
        stripFrameworkAttrs(clone);
        clone.style.left = rect.left + 'px';
        clone.style.top = rect.top + 'px';
        document.body.appendChild(clone);

        dragging = {
            list: list, curIdx: idx, itemEl: item, clone: clone,
            offsetX: clientX - rect.left, offsetY: clientY - rect.top,
            clientX: clientX, clientY: clientY, scrollRaf: 0,
        };
        markPlaceholder();
        e.preventDefault();
    }

    function applyPointer(clientX, clientY) {
        dragging.clone.style.left = (clientX - dragging.offsetX) + 'px';
        dragging.clone.style.top = (clientY - dragging.offsetY) + 'px';
        var items = dragging.list.querySelectorAll('.reorder-item');
        for (var i = 0; i < items.length; i++) {
            if (i === dragging.curIdx) continue;
            var rect = items[i].getBoundingClientRect();
            if (clientX >= rect.left && clientX <= rect.right &&
                clientY >= rect.top  && clientY <= rect.bottom) {
                fireMove(dragging.list, dragging.curIdx, i);
                dragging.curIdx = i;
                markPlaceholder();
                var rank = dragging.clone.querySelector('.reorder-rank');
                if (rank) rank.textContent = i + 1;
                break;
            }
        }
    }

    function autoScrollTick() {
        if (!dragging) return;
        var margin = 80;
        var y = dragging.clientY;
        var dy = 0;
        if (y < margin) dy = -Math.ceil((margin - y) / 6);
        else if (y > window.innerHeight - margin)
            dy = Math.ceil((y - (window.innerHeight - margin)) / 6);
        if (dy) {
            window.scrollBy(0, dy);
            applyPointer(dragging.clientX, y);
        }
        dragging.scrollRaf = requestAnimationFrame(autoScrollTick);
    }

    function onMove(e) {
        if (!dragging) return;
        e.preventDefault();
        dragging.clientX = e.clientX;
        dragging.clientY = e.clientY;
        applyPointer(e.clientX, e.clientY);
        if (!dragging.scrollRaf)
            dragging.scrollRaf = requestAnimationFrame(autoScrollTick);
    }

    function onEnd() {
        if (!dragging) return;
        if (dragging.scrollRaf) cancelAnimationFrame(dragging.scrollRaf);
        dragging.clone.remove();
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
    document.addEventListener('contextmenu', function(e) {
        if (e.target.closest('.reorder-item')) e.preventDefault();
    });
})();

const reactiveStore = reactive(voteStore);
reactiveStore.pastScrutins = loadPastScrutins();

window.addEventListener('popstate', () => syncOverlaysFromHistory(reactiveStore));

(async function init(){
    const urlParam = new URLSearchParams(location.search).get('doc');
    reactiveStore.loadingDoc = !!urlParam;

    createApp(reactiveStore).mount('body');

    if(urlParam){
        const repo = await ensureRepo(reactiveStore);
        const handle = await loadInitialHandle(repo);
        if(handle) reactiveStore.attach(handle);
        reactiveStore.loadingDoc = false;
    } else {
        // Préchauffe Automerge en tâche de fond pour que le clic
        // sur =Créer= ne paie pas le téléchargement.
        ensureRepo(reactiveStore).catch(() => {});
        if(hasNonEmptyDraft()) reactiveStore.openCreate();
    }

    document.getElementById('loading')?.remove();
})();
