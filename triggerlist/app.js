// [[id:4f21ee3e-33b2-40ec-aae8-d45eb8fb38cf][How it all fits together:9]]
import { render, html, svg } from 'uhtml';
import { get, set, del } from 'idb-keyval';

// created at boot, once Loro's WASM has loaded
let doc, items, tags, tagged, gathers, checked, order, undo;
let editMode = false, editing = null, editingText = '', folded = new Set(), selected = new Set();
let adding = null, addText = '', filter = '', picker = null;
let plan = null, focusId = null, toast = null, hideChecked = false, historyOpen = false, activeItem = null;
let viewingFrontier = null, viewingLabel = '', previewDoc = null;
let histRowHeights = null;
let pageShown;      // set by onArrival
let floatSet = null;   // set by onArrival, read by itemRows
let ws, syncUrl, syncState = 'off', syncCode = '', retryDelay, syncUrlShown = false;

const UI_KEY = 'triggerlist.ui';
const PEER_KEY = 'triggerlist.peer';
let uiTimer;
function docKey(){ return 'triggerlist-doc:' + (syncUrl || 'local'); }

async function loadDoc(){
    let saved = await get(docKey());
    if(!saved && syncUrl)                         // a room joined for the first time
        saved = await get('triggerlist-doc:local');   // seeds from the offline list, not from other rooms
    if(!saved){                                   // an install from before per-room keying
        const legacy = await get('triggerlist-doc');
        if(legacy){ saved = legacy; await del('triggerlist-doc'); }
    }
    if(saved) doc.import(saved);
}

let saveTimer;
function persist(){
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => set(docKey(), doc.export({ mode: 'snapshot' })), 100);
}
const LEGACY = ['sections', 'outings', 'itemSections', 'outingItems', 'outingSections'];

function adoptTags(){
    const old = {};
    for(const n of LEGACY) old[n] = doc.getMap(n).toJSON();   // getMap first: an unclaimed root reads as nothing
    if(!LEGACY.some(n => Object.keys(old[n]).length)) return;

    for(const [id, v] of Object.entries(old.sections))
        if(!tags.get(id)) tags.set(id, { name: v.name });
    for(const [id, v] of Object.entries(old.outings))
        if(!tags.get(id)?.trip) tags.set(id, { name: v.name, trip: 1 });
    for(const k of Object.keys(old.itemSections)) tagged.set(k, 1);
    for(const k of Object.keys(old.outingItems)) tagged.set(k, 1);   // itemId:outingId, already the right way round
    for(const k of Object.keys(old.outingSections)) gathers.set(k, 1);

    for(const n of LEGACY){ const m = doc.getMap(n); for(const k of Object.keys(old[n])) m.delete(k); }
    commit('liste reprise en étiquettes');
    persist();   // the subscribe that saves is not wired yet
}
const backStack = [];
let leaving = false;

function openScreen(close){
    backStack.push(close);
    history.pushState({ depth: backStack.length }, '');
}

function goBack(){ history.back(); }

function armGuard(){ history.pushState({ guard: true }, ''); }

function confirmExit(){
    if(document.querySelector('.exit-sheet')) return;   // already asking
    const back = document.createElement('div');
    back.className = 'sheet-back exit-sheet';
    back.onclick = backdropClose(() => back.remove());
    render(back, html`
      <div class="sheet" role="dialog" aria-label="Quitter">
        <p class="sheet-msg">Quitter l'application ?</p>
        <button onclick=${() => { back.remove(); leaving = true; history.go(-2); }}>Quitter</button>
        <button onclick=${() => back.remove()}>Annuler</button>
      </div>`);
    document.body.appendChild(back);
}

window.addEventListener('popstate', () => {
    const close = backStack.pop();
    if(close){ close(); return; }
    if(leaving) return;   // exit confirmed — let the browser walk out
    armGuard();           // no screen left: stay put and ask before leaving
    confirmExit();
});
function saveUi(){
    clearTimeout(uiTimer);
    uiTimer = setTimeout(() => localStorage.setItem(UI_KEY,
        JSON.stringify({ focusId, scrollY: window.scrollY })), 150);
}
function restoreUi(){
    let u = {};
    try { u = JSON.parse(localStorage.getItem(UI_KEY) || '{}'); } catch {}
    if(u.focusId && tags.get(u.focusId)) focusId = u.focusId;
    return u;
}
window.addEventListener('scroll', saveUi, { passive: true });

function devicePeerId(){
    let p = localStorage.getItem(PEER_KEY);
    if(!p){
        const r = new Uint32Array(2); crypto.getRandomValues(r);
        p = ((BigInt(r[0]) << 31n) | BigInt(r[1] >>> 1)).toString();   // 63 bits, inside Loro's peer-id range
        localStorage.setItem(PEER_KEY, p);
    }
    return BigInt(p);
}
const app = document.getElementById('app');

function paint(){ document.body.toggleAttribute('data-edit', editMode); document.body.toggleAttribute('data-viewing', !!viewingFrontier); render(app, view(buildModel())); saveUi(); if(historyOpen) requestAnimationFrame(relayoutHistory); }

const { LoroDoc, UndoManager } = await import('loro-crdt');
doc = new LoroDoc();
doc.setPeerId(devicePeerId());
doc.setRecordTimestamp(true);   // each change carries a time
items = doc.getMap('items');
tags = doc.getMap('tags');
tagged = doc.getMap('tagged');
gathers = doc.getMap('gathers');
checked = doc.getMap('checked');
order = doc.getMap('order');
undo = new UndoManager(doc, { mergeInterval: 0 });

resolveSyncUrl();
await loadDoc();
adoptTags();
const savedUi = restoreUi();
doc.subscribe(() => { paint(); persist(); });
paint();
document.getElementById('loading')?.remove();
if(savedUi.scrollY) requestAnimationFrame(() => window.scrollTo(0, savedUi.scrollY));
startSync();
armGuard();
if(focusId) openScreen(() => { focusId = null; paint(); });   // the restored screen needs its entry too
if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
function backdropClose(close){ return e => { if(e.target === e.currentTarget) close(); }; }
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
let dragOrder = null;

document.addEventListener('reorder:move', (e) => {
    const key = e.target.closest('.reorder-list')?.dataset.reorder;
    if(!key) return;
    if(!dragOrder || dragOrder.key !== key) dragOrder = { key, from: e.detail.from, to: e.detail.to };
    else dragOrder.to = e.detail.to;
});
document.addEventListener('pointerup', () => {
    if(!dragOrder) return;
    const { key, from, to } = dragOrder;
    dragOrder = null;
    if(from === to) return;
    if(key === 'tags'){
        const kf = (id) => 't:' + id;
        const ids = Object.keys(tags.toJSON()).filter(id => !tags.get(id).trip);
        applyReorder(sortByOrder(ids, kf), kf, from, to);
    } else if(key.startsWith('tag:')){
        const tag = key.slice(4), kf = (id) => 'i:' + id + ':' + tag;
        applyReorder(sortByOrder(taggedWith(tag), kf), kf, from, to);
    }
});
function taggedWith(tag){
    return Object.keys(tagged.toJSON()).filter(k => after(k) === tag && items.get(before(k))).map(before);
}
function sortByOrder(ids, keyOf){
    return ids.map((id, i) => ({ id, pos: order.get(keyOf(id)) ?? i })).sort((a, b) => a.pos - b.pos).map(x => x.id);
}
function applyReorder(ids, keyOf, from, to){
    if(from < 0 || from >= ids.length) return;
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    ids.forEach((id, i) => order.set(keyOf(id), i));
    commit('réordonné');
}
function sortTagAlpha(tag){
    const ids = taggedWith(tag)
        .sort((a, b) => (items.get(a)?.label || '').localeCompare(items.get(b)?.label || '', 'fr'));
    ids.forEach((id, i) => order.set('i:' + id + ':' + tag, i));
    commit('« ' + (tags.get(tag)?.name || tag) + ' » trié A→Z');
}
function flashItem(id){
    requestAnimationFrame(() => document.querySelectorAll('[data-item="' + CSS.escape(id) + '"]')
        .forEach(el => el.animate(
            [{ boxShadow: '0 0 0 3px #f6c453' }, { boxShadow: '0 0 0 0 rgba(246,196,83,0)' }],
            { duration: 500, easing: 'ease-out' })));
}
function toggleHideChecked(){ hideChecked = !hideChecked; paint(); }
function collapseThenCheck(itemId){
    const rows = [...document.querySelectorAll('[data-item="' + CSS.escape(itemId) + '"]')];
    if(!rows.length){ applyCheck(itemId, true); return; }
    let pending = rows.length;
    const done = () => { if(--pending === 0) applyCheck(itemId, true); };
    rows.forEach(el => {
        const h = el.offsetHeight;
        el.style.overflow = 'hidden';
        const anim = el.animate(
            [{ backgroundColor: '#f6c453', maxHeight: h + 'px', opacity: 1 },
             { backgroundColor: '#f6c453', maxHeight: h + 'px', opacity: 1, offset: .3 },
             { backgroundColor: 'transparent', maxHeight: '0px', opacity: 0, transform: 'scale(.9)' }],
            { duration: 380, easing: 'ease-in' });
        anim.onfinish = anim.oncancel = done;   // a repaint that cancels the animation still lands the tick
    });
}
function slug(s){
    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function commit(message){ doc.commit({ message }); }   // the message names the step in the history

function addItem(label, tagId){
    label = (label || '').trim();
    if(!label) return;
    const id = slug(label);
    items.set(id, { label });
    if(tagId) tagged.set(id + ':' + tagId, 1);
    commit('« ' + label + ' » ajouté');
}

function addTag(name, trip){
    name = (name || '').trim();
    if(!name) return '';
    const id = slug(name);
    tags.set(id, trip ? { name, trip: 1 } : { name });
    commit((trip ? 'sortie « ' : 'étiquette « ') + name + ' » ajoutée');
    return id;
}

function toggleTag(itemId, tagId){
    const k = itemId + ':' + tagId;
    const label = items.get(itemId)?.label, name = tags.get(tagId)?.name;
    if(tagged.get(k)){ tagged.delete(k); commit('« ' + label + " » n'est plus « " + name + ' »'); }
    else { tagged.set(k, 1); commit('« ' + label + ' » étiqueté « ' + name + ' »'); }
}

function toggleCheck(itemId){
    const nowChecked = !checked.get(itemId);
    if(nowChecked && hideChecked && !editMode){ collapseThenCheck(itemId); return; }
    applyCheck(itemId, nowChecked);
    flashItem(itemId);
}

function applyCheck(itemId, on){
    on ? checked.set(itemId, 1) : checked.delete(itemId);
    commit('« ' + items.get(itemId)?.label + ' » ' + (on ? 'coché' : 'décoché'));
}

function uncheck(ids, message){ ids.forEach(id => checked.delete(id)); commit(message); }
function uncheckAll(){
    const ids = Object.keys(checked.toJSON());
    if(!ids.length) return;
    uncheck(ids, 'Tout décoché');
    notify('Tout décoché');
}
function openAdd(target){
    adding = (adding === target) ? null : target;
    addText = '';
    if(adding && target !== ':untagged' && target !== ':tag') folded.delete('tag:' + target);
    paint();
    const box = document.querySelector('.section-add-input');
    if(box) box.focus();
}

function closeAdd(){ adding = null; addText = ''; paint(); }
function submitAdd(target, sel){
    const box = document.querySelector(sel || '.section-add-input');
    const val = box.value;
    box.value = ''; addText = '';
    if(target === ':tag') addTag(val);
    else addItem(val, target === ':untagged' ? '' : target);
    box.focus();
}
document.addEventListener('pointerdown', e => {
    if(adding && !editMode && !e.target.closest('.section-add')) closeAdd();
});
function addSuggestions(){
    const q = slug(addText);
    if(!q) return '';                                       // an empty field has no spelling to steer
    const hits = Object.values(items.toJSON()).filter(v => slug(v.label).includes(q));
    return hits.length ? html`
      <ul class="section-suggest">
        ${hits.map(v => html`<li><button type="button" onclick=${() => pickSuggestion(v.label)}>${v.label}</button></li>`)}
      </ul>` : '';
}

function pickSuggestion(label){
    const box = document.querySelector('.section-add-input');
    if(box){ box.value = label; box.focus(); }
    addText = label; paint();
}
function addField(target, placeholder, submitLabel){
    const thing = target !== ':tag';   // a tag name has no catalog to complete against
    return html`
      <div class="section-add">
        <div class="add">
          <input class="section-add-input" placeholder=${placeholder}
                 oninput=${e => { addText = e.target.value; paint(); }}
                 onkeydown=${e => e.key === 'Enter' ? submitAdd(target)
                                : e.key === 'Escape' ? closeAdd() : null}>
          <button aria-label=${submitLabel} onclick=${() => submitAdd(target)}>+</button>
        </div>
        ${thing ? addSuggestions() : ''}
      </div>`;
}
function mainAddField(){
    return html`
      <div class="add main-add">
        <input class="main-add-input" placeholder="Ajouter une chose" aria-label="Ajouter une chose"
               onkeydown=${e => { if(e.key === 'Enter') submitAdd(focusId || ':untagged', '.main-add-input'); }}>
        <button aria-label="Ajouter la chose"
                onclick=${() => submitAdd(focusId || ':untagged', '.main-add-input')}>+</button>
      </div>`;
}
let pressTimer, pressFired = false;
function longPressStart(action){
    pressFired = false;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => { pressFired = true; action(); }, 500);
}
function longPressCancel(){ clearTimeout(pressTimer); }
function longPressed(){ const was = pressFired; pressFired = false; return was; }
function before(k){ return k.slice(0, k.indexOf(':')); }
function after(k){ return k.slice(k.indexOf(':') + 1); }
function nameTaken(map, id, name){
    return Object.entries(map.toJSON()).some(([i, v]) => i !== id && (v.label || v.name) === name);
}
function mergeItems(from, into){
    for(const k of Object.keys(tagged.toJSON()))
        if(before(k) === from){ tagged.set(into + ':' + after(k), 1); tagged.delete(k); }
    if(checked.get(from)) checked.set(into, 1);
    checked.delete(from);
    items.delete(from);
    commit('« ' + (items.get(into)?.label || into) + ' » fusionné');
}
function renameItem(id, label){
    label = (label || '').trim();
    if(!label) return;
    const twin = Object.keys(items.toJSON()).find(i => i !== id && items.get(i).label === label);
    if(twin) mergeItems(id, twin);
    else { items.set(id, { label }); commit('renommé « ' + label + ' »'); }
}
function renameTag(id, name){
    name = (name || '').trim();
    if(!name || nameTaken(tags, id, name)) return;
    tags.set(id, { ...tags.get(id), name });   // keep the trip flag: a rename is not a change of kind
    commit('étiquette renommée « ' + name + ' »');
}

function startEdit(key, current){
    editing = key; editingText = current; paint();
    const box = document.querySelector('.rename-input');
    if(box){ box.focus(); box.select(); }
}

function commitEdit(rename, id){
    if(editing === null) return;   // Enter already committed; ignore the trailing blur
    const text = editingText; editing = null; rename(id, text); paint();
}

function cancelEdit(){ editing = null; paint(); }
function removeKeys(map, part, id){
    for(const k of Object.keys(map.toJSON())) if(part(k) === id) map.delete(k);
}

function deleteItem(id, msg){
    items.delete(id); checked.delete(id);
    removeKeys(tagged, before, id);
    commit(msg);
}

function deleteTag(id, msg){
    tags.delete(id);
    removeKeys(tagged, after, id);
    removeKeys(gathers, before, id);   // the tags it gathered
    removeKeys(gathers, after, id);    // and the trips that gathered it
    commit(msg);
}
function removeItemHere(id, name, srcTag){
    if(srcTag){ const m = '« ' + name + ' » retiré'; tagged.delete(id + ':' + srcTag); commit(m); notify(m); }
    else { const m = '« ' + name + ' » supprimé'; deleteItem(id, m); notify(m); }
}

function removeTagHere(id, name, srcTrip){
    if(srcTrip){ const m = '« ' + name + ' » retiré de la sortie'; gathers.delete(srcTrip + ':' + id); commit(m); notify(m); }
    else { const m = '« ' + name + ' » supprimé'; deleteTag(id, m); notify(m); }
}
function collect(tgd, its, chk, carried, ord){
    const byTag = {};
    for(const k of Object.keys(tgd.toJSON())){
        const id = before(k);
        if(!its[id]) continue;
        (byTag[after(k)] ||= []).push({ id, label: its[id].label, done: !!chk[id] });
        carried[id] = true;
    }
    for(const t in byTag){
        byTag[t].forEach((it, i) => { it.pos = ord.get('i:' + it.id + ':' + t) ?? i; });
        byTag[t].sort((a, b) => a.pos - b.pos);
    }
    return byTag;
}
function buildModel(){
    // a preview reads a detached fork; everything else reads the live doc
    const src = previewDoc || doc;
    const items = src.getMap('items'), tags = src.getMap('tags'), checked = src.getMap('checked'),
          tagged = src.getMap('tagged'), gathers = src.getMap('gathers'), order = src.getMap('order');
    const its = items.toJSON(), tgs = tags.toJSON(), chk = checked.toJSON(), carried = {};
    const ofTag = collect(tagged, its, chk, carried, order);
    const card = (id) => ({ id, name: tgs[id]?.name, items: ofTag[id] || [] });

    const gathered = {};
    for(const k of Object.keys(gathers.toJSON()))
        if(tgs[after(k)]) (gathered[before(k)] ||= []).push(after(k));
    const trips = Object.entries(tgs).filter(([, v]) => v.trip).map(([id, v]) =>
        ({ id, name: v.name, tags: (gathered[id] || []).map(card), items: ofTag[id] || [] }));
    const catalog = Object.keys(tgs).filter(id => !tgs[id].trip)
        .map((id, i) => ({ id, pos: order.get('t:' + id) ?? i }))
        .sort((a, b) => a.pos - b.pos)
        .map(x => card(x.id));
    const untagged = Object.entries(its).filter(([id]) => !carried[id])
        .map(([id, v]) => ({ id, label: v.label, done: !!chk[id] }));
    return { trips, catalog, untagged };
}
function foldText(s){ return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''); }

function matchesFilter(label, query){
    const hay = foldText(label);
    return foldText(query).split(/\s+/).filter(Boolean).every(word => hay.includes(word));
}

function filterBar(){
    return html`
      <div class="filter">
        <input type="search" class="filter-input" placeholder="Filtrer" aria-label="Filtrer"
               oninput=${e => { filter = e.target.value; paint(); }}>
      </div>`;
}

function addTagActuator(){
    return html`
      <div class="add-section">
        <button class="add-section-btn" aria-label="Nouvelle étiquette"
                onclick=${() => openAdd(':tag')}>+ Étiquette</button>
        ${adding === ':tag' ? addField(':tag', 'Nouvelle étiquette', "Créer l'étiquette") : ''}
      </div>`;
}
function toggleSelect(k){ selected.has(k) ? selected.delete(k) : selected.add(k); paint(); }

function editButtons(onRename, onRemove){
    return html`
      <button class="row-btn" aria-label="Renommer" onclick=${onRename}>✎</button>
      <button class="row-btn" aria-label="Supprimer" onclick=${onRemove}>✕</button>`;
}

function renameField(rename, id){
    return html`<input class="rename-input" value=${editingText}
      oninput=${e => editingText = e.target.value}
      onkeydown=${e => e.key === 'Enter' ? commitEdit(rename, id)
                     : e.key === 'Escape' ? cancelEdit() : null}
      onblur=${() => commitEdit(rename, id)}>`;
}
function tagChips(itemId){
    const carried = new Set(Object.keys(tagged.toJSON()).filter(k => before(k) === itemId).map(after));
    return html`<div class="row-tags">${Object.entries(tags.toJSON())
      .filter(([, v]) => !v.trip)
      .map(([id, v]) => html`
        <button class="tagchip" aria-pressed=${carried.has(id) ? 'true' : 'false'}
                onclick=${() => toggleTag(itemId, id)}>${v.name}</button>`)}</div>`;
}
function rowsOnScreen(list, reorderable){
    const kept = (!editMode && hideChecked) ? list.filter(it => !it.done) : list;
    return (floatSet && !reorderable)   // arrival left a floatSet: lift its stragglers up, but never mid-drag
        ? [...kept].sort((a, b) => floatSet.has(b.id) - floatSet.has(a.id)) : kept;
}
function itemRows(list, srcTag){
    const skOf = it => it.id + '|' + (srcTag || '');
    const activeHere = !!srcTag && list.some(it => skOf(it) === activeItem);
    const reorderable = (editMode || (activeHere && !hideChecked)) && !!srcTag;
    return html`<ul class=${'items' + (reorderable ? ' reorder-list' : '') + (activeHere ? ' solo' : '')}
                     data-reorder=${reorderable ? 'tag:' + srcTag : null}>${
      rowsOnScreen(list, reorderable).map((it, i) => {
        const ek = 'item:' + it.id, sk = skOf(it);
        const controls = editMode || sk === activeItem || selected.has(sk);
        const grip = reorderable && (editMode || sk === activeItem);
        return html`
      <li class=${(it.done ? 'done' : '') + (selected.has(sk) ? ' selected' : '') + (reorderable ? ' reorder-item' : '') + (sk === activeItem ? ' active' : '')}
          data-idx=${reorderable ? i : null} data-item=${it.id}>
        ${editing === ek ? renameField(renameItem, it.id) : html`
          ${grip ? html`<span class="reorder-grip" aria-label="Réordonner">⠿</span>` : ''}
          ${controls ? html`
            <input type="checkbox" class="select" aria-label="Sélectionner"
                .checked=${selected.has(sk)} onchange=${() => toggleSelect(sk)}>` : ''}
          <span class="check" role="checkbox" aria-checked=${it.done ? 'true' : 'false'} aria-label=${it.label}
                onpointerdown=${editMode ? null : () => longPressStart(() => activate(sk))}
                onpointerup=${editMode ? null : longPressCancel}
                onpointercancel=${editMode ? null : longPressCancel}
                onclick=${() => { if(longPressed()) return; toggleCheck(it.id); }}></span>
          <span class="label"
                onpointerdown=${editMode ? null : () => longPressStart(() => activate(sk))}
                onpointerup=${editMode ? null : longPressCancel}
                onpointercancel=${editMode ? null : longPressCancel}>${it.label}</span>
          ${controls ? editButtons(() => startEdit(ek, it.label),
                                   () => removeItemHere(it.id, it.label, srcTag)) : ''}`}
        ${sk === activeItem ? tagChips(it.id) : ''}
      </li>`; })}</ul>`;
}
function activate(sk){ activeItem = sk; paint(); }

document.addEventListener('pointerdown', e => {   // a press away from the revealed row puts it back to plain
    if(activeItem && !editMode && !e.target.closest('li.active')){ activeItem = null; paint(); }
});
function toggleFold(k){ folded.has(k) ? folded.delete(k) : folded.add(k); paint(); }

function foldAll(){
    if(folded.size) folded.clear();
    else Object.keys(tags.toJSON()).forEach(id => folded.add('tag:' + id));
    paint();
}

function cardComplete(s){ return s.items.length > 0 && s.items.every(it => it.done); }

function pageRemaining(m){
    // the still-unticked things on the page arrived at — the trip's, or the whole catalog's
    const o = focusId && m.trips.find(x => x.id === focusId);
    const its = o ? [...o.tags.flatMap(s => s.items), ...o.items] : [...m.catalog.flatMap(s => s.items), ...m.untagged];
    return new Set(its.filter(it => !it.done).map(it => it.id));
}

function onArrival(m){
    const FINAL_STRETCH = 15;
    if(focusId === pageShown) return;   // still on the same page — nothing arrived at
    pageShown = focusId;
    if(editMode){ floatSet = null; return; }   // curating, not packing — leave the view as it is
    for(const s of m.catalog) if(cardComplete(s)) folded.add('tag:' + s.id);   // done cards fold away
    const remaining = pageRemaining(m);
    floatSet = remaining.size < FINAL_STRETCH ? remaining : null;
}

function foldTitle(k, name, trailing, onLong){
    const open = !folded.has(k);
    return html`<span class="fold-title" role="button" tabindex="0"
      aria-expanded=${open ? 'true' : 'false'}
      onpointerdown=${onLong ? () => longPressStart(onLong) : null}
      onpointerup=${onLong ? longPressCancel : null}
      onpointercancel=${onLong ? longPressCancel : null}
      onclick=${() => { if(longPressed()) return; toggleFold(k); }}
      ><span class="caret" aria-hidden="true">${open ? '▾' : '▸'}</span>${name}${trailing || ''}</span>`;
}
function countBadge(list){
    if(!list.length) return '';
    const done = list.filter(it => it.done).length;
    return html`<span class="count">${done}/${list.length}</span>`;
}

function uncheckButton(label, list, msg){
    if(!list.some(it => it.done)) return '';
    return html`<button class="row-btn reset" aria-label=${label}
      onclick=${() => { uncheck(list.map(it => it.id), msg); notify(msg); }}>↺</button>`;
}
function tagCard(s, srcTrip, idx){
    const k = 'tag:' + s.id;
    const reorderable = editMode && !srcTrip;   // catalog cards drag; trip-gathered ones do not
    const complete = !editMode && cardComplete(s);
    return html`
      <section class=${(reorderable ? 'reorder-item' : '') + (complete ? ' complete' : '')} data-idx=${reorderable ? idx : null}>
        <h3>${reorderable ? html`<span class="reorder-grip" aria-label="Réordonner">⠿</span>` : ''}${editing === k ? renameField(renameTag, s.id)
            : html`${foldTitle(k, s.name, countBadge(s.items), () => openAdd(s.id))}${editMode ? html`${editButtons(() => startEdit(k, s.name),
                                                     () => removeTagHere(s.id, s.name, srcTrip))}
                     <button class="row-btn" aria-label="Nouvelle chose" onclick=${() => openAdd(s.id)}>+</button>
                     ${s.items.length > 1 ? html`<button class="row-btn" aria-label="Trier de A à Z" onclick=${() => sortTagAlpha(s.id)}>A↓</button>` : ''}` : ''}`}${uncheckButton("Décocher l'étiquette", s.items, 'Étiquette décochée')}</h3>
        ${folded.has(k) ? '' : html`
          ${adding === s.id ? addField(s.id, 'Nouvelle chose', 'Créer la chose') : ''}
          ${itemRows(s.items, s.id)}`}</section>`;
}

function tripCard(o){
    const k = 'tag:' + o.id;
    const its = [...o.tags.flatMap(x => x.items), ...o.items];
    const complete = !editMode && its.length > 0 && its.every(it => it.done);
    return html`
      <article class=${'trip' + (complete ? ' complete' : '')}>
        <h2>${editing === k ? renameField(renameTag, o.id)
            : html`<span class="grow">${o.name}${countBadge(its)}</span>${editMode ? editButtons(() => startEdit(k, o.name),
                                                    () => removeTagHere(o.id, o.name)) : ''}`}${uncheckButton('Décocher la sortie', its, 'Sortie décochée')}</h2>
        ${o.tags.map(s => tagCard(s, o.id))}
        ${o.items.length ? html`<h3>Ses propres choses</h3>${itemRows(o.items, o.id)}` : ''}</article>`;
}

function untaggedCard(untagged){
    if(!untagged.length && !editMode) return '';   // nothing loose, nothing to add — hide it
    return html`
      <section>
        <h3><span class="grow">Sans étiquette${countBadge(untagged)}</span>${editMode ? html`
          <button class="row-btn" aria-label="Nouvelle chose" onclick=${() => openAdd(':untagged')}>+</button>` : ''}${uncheckButton('Décocher', untagged, 'Décoché')}</h3>
        ${editMode && adding === ':untagged' ? addField(':untagged', 'Nouvelle chose', 'Créer la chose') : ''}
        ${itemRows(untagged, '')}</section>`;
}
function openPlanner(tripId){
    plan = { id: tripId || '', name: tripId ? (tags.get(tripId)?.name || '') : '',
             filter: '', fromFocus: !!tripId };
    openScreen(() => {
        const { id, fromFocus } = plan;
        plan = null;
        if(id && !fromFocus){                                  // planning is the prelude to packing
            focusId = id;
            openScreen(() => { focusId = null; paint(); });    // so the trip gets the entry the planner had
        }
        paint();
    });
    paint();
}

function modifyTrip(id){ openPlanner(id); }
function planTrip(){
    if(plan.id) return plan.id;
    const name = (plan.name || '').trim();
    if(!name){ document.querySelector('.plan-name')?.focus(); return ''; }
    const taken = tags.get(slug(name));
    if(taken && !taken.trip){ notify('« ' + taken.name + ' » est déjà une étiquette'); return ''; }
    plan.id = taken ? slug(name) : addTag(name, true);
    return plan.id;
}
function togglePlanTag(tagId){
    const id = planTrip(); if(!id) return;
    const k = id + ':' + tagId;
    if(gathers.get(k)) gathers.delete(k); else gathers.set(k, 1);
    commit('sortie « ' + tags.get(id).name + ' » composée');
    paint();
}

function togglePlanItem(itemId){
    const id = planTrip(); if(!id) return;
    toggleTag(itemId, id);
    paint();
}

function planAddItem(){
    const id = planTrip(); if(!id) return;
    const box = document.querySelector('.plan-add-input');
    const val = box.value;
    box.value = '';
    addItem(val, id);
    box.focus();
}
function planTrips(){
    const q = slug(plan.name);
    if(!q || plan.id) return [];
    return Object.entries(tags.toJSON()).filter(([, v]) => v.trip && slug(v.name).includes(q));
}

function planCovered(){
    const mine = new Set(Object.keys(gathers.toJSON()).filter(k => before(k) === plan.id).map(after));
    const covered = new Set();
    for(const k of Object.keys(tagged.toJSON())) if(mine.has(after(k))) covered.add(before(k));
    return covered;
}
function pickTrip(id, name){
    const box = document.querySelector('.plan-name');
    if(box) box.value = name;
    plan.id = id; plan.name = name; paint();
}

function plannerPanel(){
    const trip = plan.id, hits = planTrips(), covered = trip ? planCovered() : new Set();
    const q = plan.filter.trim();
    return html`<div class="sheet-back" onclick=${backdropClose(goBack)}><div class="sheet planner" role="dialog" aria-label="Planifier une sortie">
      <h2 class="sheet-title">Planifier une sortie</h2>
      <input class="sheet-name plan-name" placeholder="Nom de la sortie" aria-label="Nom de la sortie"
             oninput=${e => { plan.name = e.target.value; paint(); }}>
      ${hits.length ? html`<div class="planner-trips">${hits.map(([id, v]) => html`
        <button class="pick-target" onclick=${() => pickTrip(id, v.name)}>${v.name}</button>`)}</div>` : ''}
      <h3 class="sheet-group">Quelles étiquettes ?</h3>
      <div class="planner-tags">${Object.entries(tags.toJSON()).filter(([, v]) => !v.trip).map(([id, v]) => html`
        <button class="tagchip" aria-pressed=${trip && gathers.get(trip + ':' + id) ? 'true' : 'false'}
                onclick=${() => togglePlanTag(id)}>${v.name}</button>`)}</div>
      <h3 class="sheet-group">Quelles choses en plus ?</h3>
      <input type="search" class="sheet-filter" placeholder="Filtrer" aria-label="Filtrer les choses"
             oninput=${e => { plan.filter = e.target.value; paint(); }}>
      <div class="planner-things">${Object.entries(items.toJSON())
        .filter(([id, v]) => !covered.has(id) && matchesFilter(v.label, q))
        .map(([id, v]) => html`
          <button class="tagchip" aria-pressed=${trip && tagged.get(id + ':' + trip) ? 'true' : 'false'}
                  onclick=${() => togglePlanItem(id)}>${v.label}</button>`)}</div>
      <div class="add">
        <input class="plan-add-input" placeholder="Ajouter une chose" aria-label="Ajouter une chose"
               onkeydown=${e => { if(e.key === 'Enter') planAddItem(); }}>
        <button aria-label="Ajouter la chose" onclick=${planAddItem}>+</button>
      </div>
    </div></div>`;
}
function doUndo(){ if(undo.canUndo()) undo.undo(); }
function doRedo(){ if(undo.canRedo()) undo.redo(); }

function tripChip(o){
    const its = [...o.tags.flatMap(x => x.items), ...o.items], done = its.filter(it => it.done).length;
    return html`<button class="chip" onclick=${() => { focusId = o.id; openScreen(() => { focusId = null; paint(); }); paint(); }}>
      ${o.name} <small>${done}/${its.length}</small></button>`;
}

function focusView(m){
    const o = m.trips.find(x => x.id === focusId);
    const q = filter.trim();
    const match = it => matchesFilter(it.label, q);
    const fo = q ? { ...o, tags: o.tags.map(s => ({ ...s, items: s.items.filter(match) })).filter(s => s.items.length),
                     items: o.items.filter(match) } : o;
    return html`
      <div class="toolbar">
        <button class="edit-toggle" aria-label="Retour" onclick=${() => goBack()}>← Retour</button>
        <span class="toolbar-actions">
          <button class="row-btn" aria-label="Modifier la sortie" onclick=${() => modifyTrip(focusId)}>✎</button>
          <button class="row-btn" aria-label=${folded.size ? 'Tout déplier' : 'Tout plier'}
                  onclick=${foldAll}>${folded.size ? '⊞' : '⊟'}</button>
          <button class="row-btn" aria-label=${hideChecked ? 'Afficher les choses cochées' : 'Masquer les choses cochées'}
                  onclick=${toggleHideChecked}>${hideChecked ? '☐' : '☑'}</button>
          <button class="row-btn" aria-label="Défaire" ?disabled=${!undo.canUndo()} onclick=${doUndo}>↶</button>
          <button class="row-btn" aria-label="Refaire" ?disabled=${!undo.canRedo()} onclick=${doRedo}>↷</button>
          <button class="edit-toggle" onclick=${toggleEdit}>${editMode ? 'Terminé' : 'Modifier'}</button>
        </span>
      </div>
      ${selected.size ? selectionBar() : ''}
      ${mainAddField()}
      ${filterBar()}
      ${tripCard(fo)}
      ${plan ? plannerPanel() : ''}
      ${picker ? pickerPanel() : ''}
      ${toast ? toastView() : ''}`;
}
let toastTimer;
function notify(text){
    toast = { text };
    paint();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = null; paint(); }, 5000);
}
function dismissToast(){ clearTimeout(toastTimer); toast = null; paint(); }
function undoToast(){ dismissToast(); doUndo(); }

function toastView(){
    return html`<div class="toast" role="status">
      <span class="toast-msg">${toast.text}</span>
      <button class="toast-undo" onclick=${undoToast}>Annuler</button>
    </div>`;
}
function leaveEdit(){ editMode = false; editing = null; selected.clear(); adding = null; picker = null; activeItem = null; paint(); }

function toggleEdit(){ if(editMode) leaveEdit(); else { editMode = true; activeItem = null; paint(); } }

function view(m){
    onArrival(m);   // on arriving at a page, settle it: fold the done cards, float up the last stragglers
    if(focusId && m.trips.some(o => o.id === focusId)) return focusView(m);
    focusId = null;   // no trip focused, or the focused one is gone — show the catalog
    const empty = !m.trips.length && !m.catalog.length && !m.untagged.length;
    const q = filter.trim();
    const match = it => matchesFilter(it.label, q);
    const catalog = q ? m.catalog.map(s => ({ ...s, items: s.items.filter(match) })).filter(s => s.items.length) : m.catalog;
    const untagged = q ? m.untagged.filter(match) : m.untagged;
    const syncLabel = { off: 'Local', connecting: 'Connexion…', online: 'Synchronisé',
                        offline: 'Hors ligne' + (syncCode ? ' ' + syncCode : '') }[syncState];
    return html`
      <div class="toolbar">
        <button class=${'sync' + (onProd() ? '' : ' offprod')} data-sync=${syncState} aria-label="État de synchronisation"
                onclick=${() => { syncUrlShown = !syncUrlShown; paint(); }}>${syncLabel}</button>
        <span class="toolbar-actions">
          <button class="row-btn" aria-label=${folded.size ? 'Tout déplier' : 'Tout plier'}
                  onclick=${foldAll}>${folded.size ? '⊞' : '⊟'}</button>
          <button class="row-btn" aria-label=${hideChecked ? 'Afficher les choses cochées' : 'Masquer les choses cochées'}
                  onclick=${toggleHideChecked}>${hideChecked ? '☐' : '☑'}</button>
          <button class="row-btn" aria-label="Défaire" ?disabled=${!undo.canUndo()}
                  onclick=${doUndo}>↶</button>
          <button class="row-btn" aria-label="Refaire" ?disabled=${!undo.canRedo()}
                  onclick=${doRedo}>↷</button>
          <button class="row-btn" aria-label="Historique" onclick=${openHistory}>🕘</button>
          <button class="row-btn" aria-label="Planifier une sortie" onclick=${() => openPlanner()}>🧳</button>
          <button class="edit-toggle" onclick=${toggleEdit}>${editMode ? 'Terminé' : 'Modifier'}</button>
          <button class="row-btn" aria-label="Tout décocher" onclick=${uncheckAll}>↺</button>
        </span>
      </div>
      ${syncUrlShown ? html`<div class="sync-url">${syncUrl || 'Local — pas de synchronisation'}</div>` : ''}
      ${selected.size ? selectionBar() : ''}
      ${m.trips.length ? html`<div class="trips">${m.trips.map(tripChip)}</div>` : ''}
      ${mainAddField()}
      ${empty && !editMode ? html`<p class="empty">Rien à prendre pour l'instant.</p>` : html`
        ${empty ? '' : filterBar()}
        <div class=${editMode ? 'reorder-list' : ''} data-reorder=${editMode ? 'tags' : null}>${catalog.map((s, i) => tagCard(s, '', i))}</div>
        ${untaggedCard(untagged)}
        ${editMode ? addTagActuator() : ''}`}
      ${plan ? plannerPanel() : ''}
      ${picker ? pickerPanel() : ''}
      ${viewingFrontier ? viewingBar() : ''}
      ${historyOpen ? historyView() : ''}
      ${toast ? toastView() : ''}`;
}
function tagSelected(tagId, mode){
    [...selected].forEach(k => {
        const itemId = k.split('|')[0];
        if(mode === 'untag') tagged.delete(itemId + ':' + tagId);
        else tagged.set(itemId + ':' + tagId, 1);
    });
    selected.clear();
    commit((mode === 'untag' ? 'détaché de « ' : 'étiqueté « ') + (tags.get(tagId)?.name || tagId) + ' »');
    paint();
}
function openPicker(mode){ picker = mode; openScreen(() => { picker = null; paint(); }); paint(); }
function applyPick(tagId){
    const mode = picker, name = tags.get(tagId).name;
    tagSelected(tagId, mode);
    notify((mode === 'untag' ? 'Détaché de « ' : 'Étiqueté « ') + name + ' »');
    goBack();
}

function selectionBar(){
    const n = selected.size;
    return html`<div class="selbar">
      <span class="selcount">${n} sélectionné${n > 1 ? 's' : ''}</span>
      <button onclick=${() => openPicker('tag')}>Étiqueter</button>
      <button onclick=${() => openPicker('untag')}>Détacher</button>
      <button class="selclear" aria-label="Tout désélectionner" onclick=${() => { selected.clear(); paint(); }}>✕</button>
    </div>`;
}

function pickerPanel(){
    const verb = picker === 'untag' ? 'Détacher' : 'Étiqueter';
    return html`<div class="sheet-back" onclick=${backdropClose(goBack)}><div class="sheet picker" role="dialog" aria-label=${verb}>
      <p class="sheet-msg">${verb}…</p>
      ${Object.entries(tags.toJSON()).filter(([, v]) => !v.trip).map(([id, v]) => html`
        <button class="pick-target" onclick=${() => applyPick(id)}>${v.name}</button>`)}
      <button class="sheet-quiet" onclick=${() => goBack()}>Annuler</button>
    </div></div>`;
}
function setSync(state, code = ''){ syncState = state; syncCode = code; paint(); }

async function probeStatus(){
    try {
        const res = await fetch(syncUrl.replace(/^ws/, 'http'), { credentials: 'include' });
        return res.status >= 400 ? String(res.status) : '';
    } catch { return ''; }
}

function connect(){
    const RECONNECT_MIN = 1000, RECONNECT_MAX = 30000;
    retryDelay ??= RECONNECT_MIN;
    setSync('connecting');
    ws = new WebSocket(syncUrl);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { setSync('online'); retryDelay = RECONNECT_MIN; ws.send(doc.export({ mode: 'snapshot' })); };
    ws.onmessage = (e) => doc.import(new Uint8Array(e.data));
    ws.onclose = () => {
        setSync('offline');
        probeStatus().then((code) => code && setSync('offline', code));
        setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, RECONNECT_MAX);
    };
}
function resolveSyncUrl(){
    const params = new URLSearchParams(location.search);
    let url = params.get('sync_url');
    if(url){
        localStorage.setItem('triggerlist.sync_url', url);
        params.delete('sync_url');
        const q = params.toString();
        history.replaceState(null, '', location.pathname + (q ? '?' + q : ''));
    } else {
        url = localStorage.getItem('triggerlist.sync_url');
    }
    syncUrl = url || undefined;
}

function onProd(){ return !!syncUrl && syncUrl.endsWith('lorosync/triggerlist'); }

function startSync(){
    if(!syncUrl) return;
    doc.subscribe((batch) => {
        if(batch.by === 'local' && ws && ws.readyState === WebSocket.OPEN)
            ws.send(doc.export({ mode: 'update' }));
    });
    connect();
}
function relativeTime(ts){
    if(!ts) return '';
    const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    if(s < 60) return "à l'instant";
    if(s < 3600) return 'il y a ' + Math.floor(s / 60) + ' min';
    if(s < 86400) return 'il y a ' + Math.floor(s / 3600) + ' h';
    return 'il y a ' + Math.floor(s / 86400) + ' j';
}

function historyChanges(){
    const out = [];
    for(const [, changes] of doc.getAllChanges())
        for(const c of changes)
            out.push({ msg: c.message, ts: c.timestamp, lamport: c.lamport,
                       peer: String(c.peer), counter: c.counter, length: c.length, deps: c.deps,
                       frontier: [{ peer: c.peer, counter: c.counter + c.length - 1 }] });
    return out.sort((a, b) => (a.lamport ?? a.ts) - (b.lamport ?? b.ts));
}
function endPreview(){ previewDoc = null; viewingFrontier = null; }

function openHistory(){
    if(!viewingFrontier) openScreen(() => { historyOpen = false; histRowHeights = null; endPreview(); paint(); });
    historyOpen = true;
    paint();
}

function sameFrontier(a, b){
    return a.length === b.length && a.every((x, i) => b[i] && x.peer === b[i].peer && x.counter === b[i].counter);
}

function goToPoint(c){
    const all = historyChanges();
    const latest = all.length ? all[all.length - 1].frontier : null;
    if(latest && sameFrontier(c.frontier, latest)){ backToPresent(); return; }
    const fork = new LoroDoc();
    fork.import(doc.export({ mode: 'snapshot' }));   // a preview reads a fork, never the live doc
    fork.checkout(c.frontier);
    previewDoc = fork;
    viewingFrontier = c.frontier;
    viewingLabel = c.msg || 'modification';
    historyOpen = false;
    paint();
}

function backToPresent(){ goBack(); }   // the closer drops the preview and repaints

function restoreHere(){
    const f = viewingFrontier;
    endPreview();
    doc.revertTo(f);
    goBack();
    notify('État restauré');
}
const PEER_COLORS = ['#4c6ef5', '#e8590c', '#0ca678', '#ae3ec9', '#f08c00', '#1098ad'];
const HIST_ROW_H = 40, HIST_LANE_W = 20, HIST_PAD = 14, HIST_DOT_R = 5;

function historyGraph(shown, here, heights){
    const rows = shown.slice().reverse();                 // newest first (row 0 at the top)
    const peers = [...new Set(shown.map(n => n.peer))];    // colour is per device; the lane is per branch
    const color = p => PEER_COLORS[peers.indexOf(p) % PEER_COLORS.length];
    const rowH = i => (heights && heights[i]) || HIST_ROW_H;   // a row's measured height, or the default before layout
    const top = []; for(let i = 0; i < rows.length; i++) top[i] = i ? top[i-1] + rowH(i-1) : 0;
    const rowY = i => top[i] + rowH(i) / 2;                // a dot sits on its row's centre, whatever its height
    const laneX = c => HIST_PAD + c * HIST_LANE_W;
    const rowOf = new Map(rows.map((n, i) => [n, i]));
    const depNode = d => rows.find(n => n.peer === String(d.peer) && d.counter >= n.counter && d.counter < n.counter + n.length);

    const lanes = [], col = new Map();
    let maxCol = 0;
    for(const n of rows){
        let c = lanes.indexOf(n);
        if(c === -1){ c = lanes.indexOf(null); if(c === -1) c = lanes.length; }
        else for(let k = c + 1; k < lanes.length; k++) if(lanes[k] === n) lanes[k] = null;   // children converging on a fork
        col.set(n, c);
        const parents = (n.deps || []).map(depNode).filter(Boolean);
        lanes[c] = parents[0] || null;                    // the first parent continues this lane
        for(let k = 1; k < parents.length; k++){          // a merge: each extra parent claims a lane
            let pk = lanes.indexOf(parents[k]);
            if(pk === -1){ pk = lanes.indexOf(null); if(pk === -1) pk = lanes.length; lanes[pk] = parents[k]; }
        }
        maxCol = Math.max(maxCol, c, lanes.length - 1);
    }

    const edges = [];
    rows.forEach((n, i) => {
        for(const d of (n.deps || [])){
            const p = depNode(d);
            if(!p) continue;                              // parent off the top of the list
            edges.push({ x1: laneX(col.get(p)), y1: rowY(rowOf.get(p)), x2: laneX(col.get(n)), y2: rowY(i), color: color(n.peer) });
        }
    });
    const dots = rows.map((n, i) => ({ cx: laneX(col.get(n)), cy: rowY(i), color: color(n.peer),
                                       cur: sameFrontier(n.frontier, here) }));
    const height = rows.length ? top[rows.length-1] + rowH(rows.length-1) : 0;
    return { rows, edges, dots, width: HIST_PAD * 2 + maxCol * HIST_LANE_W, height };
}
function historyView(){
    const all = historyChanges();
    const shown = all.slice(-50);                       // oldest to newest, in order for the edges
    const more = all.length - shown.length;
    const here = viewingFrontier || doc.frontiers();
    const g = historyGraph(shown, here, histRowHeights);
    return html`<div class="sheet-back" onclick=${backdropClose(goBack)}><div class="sheet history" role="dialog" aria-label="Historique">
      <p class="sheet-msg">Historique</p>
      <div class="hist-graph-wrap" style=${`min-height:${g.height}px`}>
        <svg class="hist-graph" width=${g.width} height=${g.height} style=${`width:${g.width}px;height:${g.height}px`}>
          ${g.edges.map(e => svg`<line class="hist-edge" x1=${e.x1} y1=${e.y1} x2=${e.x2} y2=${e.y2} stroke=${e.color} stroke-width="2"/>`)}
          ${g.dots.map(d => svg`<circle cx=${d.cx} cy=${d.cy} r=${HIST_DOT_R} fill=${d.color} stroke=${d.cur ? '#1b1d2e' : d.color} stroke-width=${d.cur ? 3 : 1}/>`)}
        </svg>
        <div class="hist-rows" style=${`margin-left:${g.width}px`}>
          ${g.rows.map(c => { const cur = sameFrontier(c.frontier, here); return html`<button class=${'hist-row' + (cur ? ' hist-here' : '')} onclick=${() => goToPoint(c)}>
            <span class="hist-msg">${cur ? '▸ ' : ''}${c.msg || 'modification'}</span>
            <span class="hist-time">${relativeTime(c.ts)}</span></button>`; })}
        </div>
      </div>
      ${more > 0 ? html`<p class="hist-more">+ ${more} plus anciennes</p>` : ''}
      <button class="sheet-quiet" onclick=${() => goBack()}>Fermer</button>
    </div></div>`;
}

function relayoutHistory(){
    const hs = [...app.querySelectorAll('.hist-row')].map(r => r.offsetHeight);
    if(histRowHeights && hs.length === histRowHeights.length
       && hs.every((v, i) => Math.abs(v - histRowHeights[i]) < 1)) return;   // the rail already fits these rows
    histRowHeights = hs;
    paint();                                             // repaint the rail against the just-measured rows
}

function viewingBar(){
    return html`<div class="viewing-bar" role="dialog" aria-label="Aperçu">
      <span class="viewing-msg">Aperçu — ${viewingLabel}</span>
      <span class="viewing-acts">
        <button onclick=${() => { historyOpen = true; paint(); }}>Historique</button>
        <button onclick=${restoreHere}>Restaurer ici</button>
        <button onclick=${backToPresent}>Revenir au présent</button>
      </span>
    </div>`;
}
// How it all fits together:9 ends here
