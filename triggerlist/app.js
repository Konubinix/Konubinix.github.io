// [[id:4f21ee3e-33b2-40ec-aae8-d45eb8fb38cf][How it all fits together:6]]
import { render, html } from 'uhtml';
import { get, set } from 'idb-keyval';

// the doc, its maps, and its undo manager are created at boot, once Loro's WASM has loaded.
let doc, items, sections, itemSections, outings, outingSections, outingItems, checked, undo;

// view vs edit is per-device UI state — it is not synced and starts off.
// editing holds the "kind:id" being renamed in place, editingText its buffer.
let editMode = false, editing = null, editingText = '';
const DOC_KEY = 'triggerlist-doc';

async function loadDoc(){
    const saved = await get(DOC_KEY);
    if(saved) doc.import(saved);
}

let saveTimer;
function persist(){
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => set(DOC_KEY, doc.export({ mode: 'snapshot' })), 100);
}
const app = document.getElementById('app');

function paint(){ render(app, view(buildModel())); }

const { LoroDoc, UndoManager } = await import('loro-crdt');
doc = new LoroDoc();
items = doc.getMap('items');
sections = doc.getMap('sections');
itemSections = doc.getMap('itemSections');
outings = doc.getMap('outings');
outingSections = doc.getMap('outingSections');
outingItems = doc.getMap('outingItems');
checked = doc.getMap('checked');
undo = new UndoManager(doc, { mergeInterval: 0 });

await loadDoc();
doc.subscribe(() => { paint(); persist(); });
paint();
document.body.setAttribute('data-app-ready', '1');
startSync();
function slug(s){
    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function addItem(label, sectionId){
    label = (label || '').trim();
    if(!label) return;
    const id = slug(label);
    items.set(id, { label });
    if(sectionId) itemSections.set(id + ':' + sectionId, 1);
    doc.commit();
}

function addSection(name){
    name = (name || '').trim();
    if(name){ sections.set(slug(name), { name }); doc.commit(); }
}

function addOuting(name){
    name = (name || '').trim();
    if(name){ outings.set(slug(name), { name }); doc.commit(); }
}

function toggleCheck(itemId){
    checked.get(itemId) ? checked.delete(itemId) : checked.set(itemId, 1);
    doc.commit();
}
function submitOuting(){
    const input = document.querySelector('.outing-input');
    addOuting(input.value); input.value = ''; input.focus();
}

function submitSection(){
    const input = document.querySelector('.section-input');
    addSection(input.value); input.value = ''; input.focus();
}

function submitAdd(){
    const input = document.querySelector('.add-input');
    const sel = document.querySelector('.section-select');
    addItem(input.value, sel.value); input.value = ''; input.focus();
}
function nameTaken(map, id, name){
    return Object.entries(map.toJSON()).some(([i, v]) => i !== id && (v.label || v.name) === name);
}
function renameItem(id, label){
    label = (label || '').trim();
    if(label && !nameTaken(items, id, label)){ items.set(id, { label }); doc.commit(); }
}
function renameSection(id, name){
    name = (name || '').trim();
    if(name && !nameTaken(sections, id, name)){ sections.set(id, { name }); doc.commit(); }
}
function renameOuting(id, name){
    name = (name || '').trim();
    if(name && !nameTaken(outings, id, name)){ outings.set(id, { name }); doc.commit(); }
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
function before(k){ return k.slice(0, k.indexOf(':')); }
function after(k){ return k.slice(k.indexOf(':') + 1); }
function removeKeys(map, part, id){
    for(const k of Object.keys(map.toJSON())) if(part(k) === id) map.delete(k);
}

function deleteItem(id){
    items.delete(id); checked.delete(id);
    removeKeys(itemSections, before, id);
    removeKeys(outingItems, before, id);
    doc.commit();
}

function deleteSection(id){
    sections.delete(id);
    removeKeys(itemSections, after, id);
    removeKeys(outingSections, after, id);
    doc.commit();
}

function deleteOuting(id){
    outings.delete(id);
    removeKeys(outingSections, before, id);
    removeKeys(outingItems, after, id);
    doc.commit();
}
function unlinkItemFromSection(id, sectionId){ itemSections.delete(id + ':' + sectionId); doc.commit(); }
function unlinkItemFromOuting(id, outingId){ outingItems.delete(id + ':' + outingId); doc.commit(); }
function unlinkSectionFromOuting(id, outingId){ outingSections.delete(outingId + ':' + id); doc.commit(); }

function askConfirm(name, onYes){
    const back = document.createElement('div');
    back.className = 'sheet-back';
    render(back, html`
      <div class="sheet" role="dialog" aria-label="Supprimer">
        <p class="sheet-msg">Supprimer « ${name} » ?</p>
        <button onclick=${() => { back.remove(); onYes(); }}>Supprimer</button>
        <button onclick=${() => back.remove()}>Annuler</button>
      </div>`);
    document.body.appendChild(back);
}

function removeItemHere(id, name, srcSection, srcOuting){
    if(srcSection) unlinkItemFromSection(id, srcSection);
    else if(srcOuting) unlinkItemFromOuting(id, srcOuting);
    else askConfirm(name, () => deleteItem(id));
}

function removeSectionHere(id, name, srcOuting){
    if(srcOuting) unlinkSectionFromOuting(id, srcOuting);
    else askConfirm(name, () => deleteSection(id));
}

function removeOutingHere(id, name){ askConfirm(name, () => deleteOuting(id)); }
function collect(map, its, chk, placed){
    const byContainer = {};
    for(const k of Object.keys(map.toJSON())){
        const id = before(k);
        if(!its[id]) continue;
        (byContainer[after(k)] ||= []).push({ id, label: its[id].label, done: !!chk[id] });
        placed[id] = true;
    }
    return byContainer;
}
function buildModel(){
    const its = items.toJSON(), secs = sections.toJSON(), chk = checked.toJSON(), placed = {};
    const secItems = collect(itemSections, its, chk, placed);
    const looseOf  = collect(outingItems, its, chk, placed);
    const section = (id) => ({ id, name: secs[id]?.name, items: secItems[id] || [] });

    const ofOuting = {}, taken = {};
    for(const k of Object.keys(outingSections.toJSON())){
        const sec = after(k);
        if(secs[sec]){ (ofOuting[before(k)] ||= []).push(sec); taken[sec] = true; }
    }
    const outingList = Object.entries(outings.toJSON()).map(([id, v]) =>
        ({ id, name: v.name, sections: (ofOuting[id] || []).map(section),
           items: looseOf[id] || [] }));
    const looseSections = Object.keys(secs).filter(id => !taken[id]).map(section);
    const orphans = Object.entries(its).filter(([id]) => !placed[id])
        .map(([id, v]) => ({ id, label: v.label, done: !!chk[id] }));
    return { outingList, looseSections, orphans };
}
function addBar(){
    const secs = Object.entries(sections.toJSON()).map(([id, v]) => ({ id, name: v.name }));
    return html`
      <div class="add">
        <input class="outing-input" placeholder="Nouvelle sortie"
               onkeydown=${e => { if(e.key === 'Enter') submitOuting(); }}>
        <button onclick=${submitOuting}>Créer la sortie</button>
      </div>
      <div class="add">
        <input class="section-input" placeholder="Nouvelle section"
               onkeydown=${e => { if(e.key === 'Enter') submitSection(); }}>
        <button onclick=${submitSection}>Créer la section</button>
      </div>
      <div class="add">
        <input class="add-input" placeholder="Ajouter un article"
               onkeydown=${e => { if(e.key === 'Enter') submitAdd(); }}>
        <select class="section-select" aria-label="Section">
          <option value="">Sans section</option>
          ${secs.map(s => html`<option value=${s.id}>${s.name}</option>`)}
        </select>
        <button onclick=${submitAdd}>Ajouter</button>
      </div>`;
}
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

function itemRows(list, srcSection, srcOuting){
    return html`<ul class="items">${list.map(it => { const k = 'item:' + it.id; return html`
      <li class=${it.done ? 'done' : ''} ?data-draggable=${editMode && editing !== k}
          data-kind="item" data-id=${it.id} data-src-section=${srcSection} data-src-outing=${srcOuting}>
        ${editing === k ? renameField(renameItem, it.id) : html`
          <span class="check" role="checkbox" aria-checked=${it.done ? 'true' : 'false'}
                onclick=${() => toggleCheck(it.id)}>${it.label}</span>
          ${editMode ? editButtons(() => startEdit(k, it.label),
                                   () => removeItemHere(it.id, it.label, srcSection, srcOuting)) : ''}`}
      </li>`; })}</ul>`;
}
function sectionCard(s, srcOuting){
    const k = 'section:' + s.id;
    return html`
      <section ?data-drop-target=${editMode} data-kind="section" data-id=${s.id}
               ?data-draggable=${editMode && editing !== k} data-src-outing=${srcOuting}>
        <h3>${editing === k ? renameField(renameSection, s.id)
            : html`${s.name}${editMode ? editButtons(() => startEdit(k, s.name),
                                                     () => removeSectionHere(s.id, s.name, srcOuting)) : ''}`}</h3>
        ${itemRows(s.items, s.id, '')}</section>`;
}

function outingCard(o){
    const k = 'outing:' + o.id;
    return html`
      <article class="outing" ?data-drop-target=${editMode} data-kind="outing" data-id=${o.id}>
        <h2>${editing === k ? renameField(renameOuting, o.id)
            : html`${o.name}${editMode ? editButtons(() => startEdit(k, o.name),
                                                    () => removeOutingHere(o.id, o.name)) : ''}`}</h2>
        ${o.sections.map(s => sectionCard(s, o.id))}
        ${o.items.length ? itemRows(o.items, '', o.id) : ''}</article>`;
}
function toggleEdit(){ editMode = !editMode; editing = null; paint(); }
function doUndo(){ if(undo.canUndo()) undo.undo(); }
function doRedo(){ if(undo.canRedo()) undo.redo(); }

function view(m){
    const empty = !m.outingList.length && !m.looseSections.length && !m.orphans.length;
    return html`
      <div class="toolbar">
        <button class="row-btn" aria-label="Défaire" ?disabled=${!undo.canUndo()}
                onclick=${doUndo}>↶</button>
        <button class="row-btn" aria-label="Refaire" ?disabled=${!undo.canRedo()}
                onclick=${doRedo}>↷</button>
        <button class="edit-toggle" onclick=${toggleEdit}>${editMode ? 'Terminé' : 'Modifier'}</button>
      </div>
      ${editMode ? addBar() : ''}
      ${empty ? html`<p class="empty">Rien à prendre pour l'instant.</p>` : html`
        ${m.outingList.map(outingCard)}
        ${m.looseSections.map(s => sectionCard(s, ''))}
        ${m.orphans.length
          ? html`<section><h3>Sans section</h3>${itemRows(m.orphans, '', '')}</section>`
          : ''}`}`;
}
// ── Drop-zone drag engine (framework-agnostic) ──
// Bound once on document. Anything matching =[data-draggable]= can be
// grabbed; anything matching =[data-drop-target]= accepts drops. On
// pointerup over a target, fires =dropzone:drop= on it as a bubbling
// CustomEvent with =detail = { sourceEl }=. Consumers listen on the
// target (or any ancestor — document works) and mutate their store.
(function initDropZoneEngine() {
    var THRESHOLD_PX = 6;
    var drag = null;

    function activate() {
        var rect = drag.item.getBoundingClientRect();
        var clone = drag.item.cloneNode(true);
        clone.classList.add('drag-clone');
        clone.style.left = rect.left + 'px';
        clone.style.top = rect.top + 'px';
        clone.style.width = rect.width + 'px';
        document.body.appendChild(clone);
        drag.clone = clone;
        drag.offsetX = drag.startX - rect.left;
        drag.offsetY = drag.startY - rect.top;
        drag.item.classList.add('drag-source');
        drag.active = true;
    }

    function setHover(el) {
        if (drag.lastTarget === el) return;
        if (drag.lastTarget) drag.lastTarget.classList.remove('drop-hover');
        drag.lastTarget = el;
        if (el) el.classList.add('drop-hover');
    }

    document.addEventListener('pointerdown', function(e) {
        if (drag) return;
        var item = e.target.closest('[data-draggable]');
        if (!item) return;
        drag = {
            item: item,
            pointerId: e.pointerId,
            startX: e.clientX, startY: e.clientY,
            active: false,
            clone: null,
            lastTarget: null,
        };
    });

    document.addEventListener('pointermove', function(e) {
        if (!drag || drag.pointerId !== e.pointerId) return;
        if (!drag.active) {
            var dx = e.clientX - drag.startX;
            var dy = e.clientY - drag.startY;
            if (Math.hypot(dx, dy) < THRESHOLD_PX) return;
            activate();
        }
        e.preventDefault();
        drag.clone.style.left = (e.clientX - drag.offsetX) + 'px';
        drag.clone.style.top  = (e.clientY - drag.offsetY) + 'px';
        drag.clone.style.display = 'none';
        var under = document.elementFromPoint(e.clientX, e.clientY);
        drag.clone.style.display = '';
        var tgt = under ? under.closest('[data-drop-target]') : null;
        // Don't highlight the item's own current container as a drop target
        // when the cursor hasn't yet left it — feels like nothing happens
        // on drop. Simpler: still highlight; consumers can ignore same-container drops.
        setHover(tgt);
    });

    function onEnd(e) {
        if (!drag || drag.pointerId !== e.pointerId) return;
        if (drag.active && drag.lastTarget) {
            drag.lastTarget.dispatchEvent(new CustomEvent('dropzone:drop', {
                detail: { sourceEl: drag.item },
                bubbles: true,
            }));
        }
        if (drag.lastTarget) drag.lastTarget.classList.remove('drop-hover');
        if (drag.item) drag.item.classList.remove('drag-source');
        if (drag.clone) drag.clone.remove();
        drag = null;
    }

    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);
    document.addEventListener('contextmenu', function(e) {
        if (e.target.closest('[data-draggable]')) e.preventDefault();
    });
})();
function placeItemInSection(itemId, dstSection, srcSection, mode){
    itemSections.set(itemId + ':' + dstSection, 1);
    if(mode === 'move' && srcSection) itemSections.delete(itemId + ':' + srcSection);
    doc.commit();
}

function placeSectionInOuting(sectionId, dstOuting, srcOuting, mode){
    outingSections.set(dstOuting + ':' + sectionId, 1);
    if(mode === 'move' && srcOuting) outingSections.delete(srcOuting + ':' + sectionId);
    doc.commit();
}

function placeItemInOuting(itemId, dstOuting, srcOuting, mode){
    outingItems.set(itemId + ':' + dstOuting, 1);
    if(mode === 'move' && srcOuting) outingItems.delete(itemId + ':' + srcOuting);
    doc.commit();
}
function askMoveLink(onPick){
    const back = document.createElement('div');
    back.className = 'sheet-back';
    render(back, html`
      <div class="sheet" role="dialog" aria-label="Déplacer ou lier">
        <button onclick=${() => { back.remove(); onPick('move'); }}>Déplacer</button>
        <button onclick=${() => { back.remove(); onPick('link'); }}>Lier</button>
      </div>`);
    document.body.appendChild(back);
}

document.addEventListener('dropzone:drop', (e) => {
    const src = e.detail.sourceEl, dst = e.target.closest('[data-drop-target]');
    if(!dst) return;
    const kind = src.dataset.kind, into = dst.dataset.kind, id = dst.dataset.id;
    if(kind === 'item' && into === 'section'){
        const from = src.dataset.srcSection || '';
        if(from !== id) askMoveLink(m => placeItemInSection(src.dataset.id, id, from, m));
    } else if(kind === 'section' && into === 'outing'){
        const from = src.dataset.srcOuting || '';
        if(from !== id) askMoveLink(m => placeSectionInOuting(src.dataset.id, id, from, m));
    } else if(kind === 'item' && into === 'outing'){
        const from = src.dataset.srcOuting || '';
        if(from !== id) askMoveLink(m => placeItemInOuting(src.dataset.id, id, from, m));
    }
});
function startSync(){
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
    if(!url) return;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(doc.export({ mode: 'snapshot' }));
    ws.onmessage = (e) => doc.import(new Uint8Array(e.data));
    doc.subscribe((batch) => {
        if(batch.by === 'local' && ws.readyState === WebSocket.OPEN)
            ws.send(doc.export({ mode: 'update' }));
    });
}
// How it all fits together:6 ends here
