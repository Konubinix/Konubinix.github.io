function itemTemplate(id, item){
    return html`
      <li class="item" data-item-id=${id} data-draggable
          @click=${() => openItemEdit(id, item)}>
        ${item.image ? html`<img class="item-thumb" src=${item.image} alt=${item.name}>` : ''}
        <span class="item-name">${item.name}</span>
      </li>
    `;
}

function boxTemplate(id, idx, row, itemsById, itemMatches){
    return html`
      <li
        class="box reorder-item"
        data-box-id=${id}
        data-idx=${idx}
        data-drop-target
      >
        <button type="button" class="box-photo"
                aria-label="Box ${row.photoName}"
                @click=${() => openBoxEdit(id, row)}>
          <img class="box-photo-thumb" src=${row.photo} alt="">
        </button>

        #+NAME: js-render-box-items
        #+BEGIN_SRC html :noweb-ref render-box-items
          <ul class="items-in-box">
            ${Object.keys(itemsById)
              .filter(iid => itemsById[iid].boxId === id && itemMatches(itemsById[iid].name))
              .map(iid => itemTemplate(iid, itemsById[iid]))}
          </ul>
        <button type="button" class="reorder-grip" aria-label="Reorder ${row.photoName}">
          <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
            <circle cx="2" cy="3" r="1.3"/><circle cx="8" cy="3" r="1.3"/>
            <circle cx="2" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/>
            <circle cx="2" cy="13" r="1.3"/><circle cx="8" cy="13" r="1.3"/>
          </svg>
        </button>
      </li>
    `;
}

function emptyStateTemplate(){
    const empty = !Object.keys(store.getTable('boxes')).length
               && !Object.keys(store.getTable('items')).length;
    if(!empty) return '';
    return html`
      <div class="empty-state">
        <div class="emoji">&#x1f4e6;</div>
        <h1>Organiser</h1>
        <p>No boxes yet.</p>
      </div>
    `;
}

function boxFormTemplate(){
    const {photo, photoName} = ui.boxForm;
    return html`
      <form class="add-form" @submit=${onBoxFormSubmit}>
        <label>Photo
          <input type="file" accept="image/*" capture="environment"
                 @change=${onBoxPhotoChange}>
        </label>
        ${photo ? html`
          <img class="box-photo-preview"
               src=${photo}
               alt=${photoName ? `Photo preview ${photoName}` : 'Photo preview'}>
        ` : ''}
        <div class="add-form-actions">
          <button type="submit">Save</button>
          <button type="button" @click=${closeForm}>Cancel</button>
          ${ui.boxForm.editingId ? html`
            <button type="button" class="danger" @click=${onBoxFormDelete}>Delete</button>
          ` : ''}
        </div>
      </form>
    `;
}

function boxesListTemplate(){
    const rows = store.getTable('boxes');
    const itemsById = store.getTable('items');
    const queryB = ui.searchQuery.trim().toLowerCase();
    const itemMatchesB = name => !queryB || name.toLowerCase().includes(queryB);
    const sortedIds = Object.keys(rows).sort((a, b) =>
        (rows[a].order ?? 0) - (rows[b].order ?? 0));
    const ids = sortedIds.filter(id => {
        if(!queryB) return true;
        return Object.keys(itemsById).some(iid =>
            itemsById[iid].boxId === id && itemMatchesB(itemsById[iid].name));
    });
    if(!ids.length) return '';
    return html`
      <ul class="boxes-list reorder-list" data-reorder="boxes" aria-label="Boxes">
        ${ids.map((id, idx) =>
            boxTemplate(id, idx, rows[id], itemsById, itemMatchesB))}
      </ul>
    `;
}

function itemFormTemplate(){
    const {name, image, nameError} = ui.itemForm;
    return html`
      <form class="add-form" @submit=${onItemFormSubmit}>
        <label>Item name
          <input type="text" placeholder="e.g. 3mm screw" required
                 .value=${name}
                 @input=${onItemNameInput}>
        </label>
        ${ui.itemForm.nameError ? html`
          <p class="form-error" role="alert">An item with this name already exists.</p>
        ` : ''}
        <label>Image
          <input type="file" accept="image/*" capture="environment"
                 @change=${onItemImageChange}>
        </label>
        ${image ? html`
          <img class="item-image-preview" src=${image} alt="Image preview">
        ` : ''}
        <div class="add-form-actions">
          <button type="submit">Save</button>
          <button type="button" @click=${closeForm}>Cancel</button>
          ${ui.itemForm.editingId ? html`
            <button type="button" class="danger" @click=${onItemFormDelete}>Delete</button>
          ` : ''}
        </div>
      </form>
    `;
}

function unassignedSectionTemplate(){
    const itemsTable = store.getTable('items');
    const queryU = ui.searchQuery.trim().toLowerCase();
    const unassignedIds = Object.keys(itemsTable).filter(id => {
        if(itemsTable[id].boxId) return false;
        return !queryU || itemsTable[id].name.toLowerCase().includes(queryU);
    });
    if(!unassignedIds.length) return '';
    return html`
      <section class="unassigned" data-drop-target>
        <h2>Unassigned</h2>
        <ul class="items-list">
          ${unassignedIds.map(id => itemTemplate(id, itemsTable[id]))}
        </ul>
      </section>
    `;
}

function setSyncStatus(s){
    setUI({syncStatus: s});
}

async function startSync(){
    const params = new URLSearchParams(location.search);
    const fromParam = params.get('sync_url');
    if(fromParam){
        localStorage.setItem('organiser.sync_url', fromParam);
        const clean = new URL(location);
        clean.searchParams.delete('sync_url');
        history.replaceState(null, '', clean);
    }
    const syncUrl = localStorage.getItem('organiser.sync_url');
    if(!syncUrl){ setSyncStatus('off'); return; }
    setSyncStatus('connecting');
    const ws = new WebSocket(syncUrl);
    ws.addEventListener('open', () => setSyncStatus('connected'));
    ws.addEventListener('close', () => setSyncStatus('disconnected'));
    ws.addEventListener('error', () => setSyncStatus('disconnected'));
    const sync = await createWsSynchronizer(store, ws);
    await sync.startSync();
}

const ui = {
    formOpen: null,
    boxForm: {photo: '', photoName: '', editingId: ''},
    itemForm: {name: '', image: '', editingId: '', nameError: false},
    searchQuery: '',
    syncStatus: 'off',
};

function setUI(updates){
    Object.assign(ui, updates);
    renderApp();
}

const appRoot = document.getElementById('app');

function appTemplate(){
    return html`
      <header class="app-bar">
        <span class="sync-status" data-status=${ui.syncStatus} role="status">Sync ${ui.syncStatus}</span>
        <div class="app-bar-actions">
          <button type="button" @click=${openBoxForm}>Add a box</button>
          <button type="button" @click=${openItemForm}>Add an item</button>
        </div>
        <input type="search" placeholder="Search…" aria-label="Search"
               .value=${ui.searchQuery}
               @input=${e => setUI({searchQuery: e.target.value})}>
      </header>
      ${ui.formOpen === 'box' ? boxFormTemplate() : ''}
      ${ui.formOpen === 'item' ? itemFormTemplate() : ''}
      ${emptyStateTemplate()}
      ${boxesListTemplate()}
      ${unassignedSectionTemplate()}
    `;
}

function renderApp(){
    renderLit(appTemplate(), appRoot);
}

import { createMergeableStore } from 'tinybase';
import { createIndexedDbPersister } from 'tinybase/persisters/persister-indexed-db';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import { html, render as renderLit } from 'lit-html';

const store = createMergeableStore();
const persister = createIndexedDbPersister(store, 'organiser');

await persister.startAutoLoad();
store.addTablesListener(renderApp);
renderApp();
await persister.startAutoSave();
document.body.setAttribute('data-app-ready', '1');
startSync();

async function fileToThumbnail(file){
    const url = URL.createObjectURL(file);
    try {
        const img = await new Promise((res, rej) => {
            const i = new Image();
            i.onload = () => res(i);
            i.onerror = rej;
            i.src = url;
        });
        const max = 200;
        const scale = Math.min(max / img.width, max / img.height, 1);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/jpeg', 0.85);
    } finally {
        URL.revokeObjectURL(url);
    }
}
async function onBoxPhotoChange(e){
    const file = e.target.files[0];
    if(!file){
        setUI({boxForm: {...ui.boxForm, photo: '', photoName: ''}});
        return;
    }
    const photo = await fileToThumbnail(file);
    const photoName = file.name.replace(/\.[^.]+$/, '');
    setUI({boxForm: {...ui.boxForm, photo, photoName}});
}

function openBoxForm(){
    setUI({
        formOpen: 'box',
        boxForm: {photo: '', photoName: '', editingId: ''},
    });
}

function closeForm(){
    setUI({
        formOpen: null,
        boxForm: {photo: '', photoName: '', editingId: ''},
        itemForm: {name: '', image: '', editingId: '', nameError: false},
    });
}
function onBoxFormSubmit(e){
    e.preventDefault();
    const {photo, photoName, editingId} = ui.boxForm;
    if(!photo) return;
    const id = editingId || crypto.randomUUID();
    const existing = store.getRow('boxes', id);
    const orders = Object.values(store.getTable('boxes')).map(r => r.order ?? 0);
    const order = existing?.order ?? (orders.length ? Math.max(...orders) + 1 : 0);
    store.setRow('boxes', id, {photo, photoName, order});
    closeForm();
}

function itemNameExists(name, exceptId){
    const items = store.getTable('items');
    const lower = name.toLowerCase();
    return Object.entries(items).some(([id, item]) =>
        id !== exceptId && item.name.toLowerCase() === lower);
}
function onItemNameInput(e){
    setUI({itemForm: {...ui.itemForm, name: e.target.value, nameError: false}});
}
async function onItemImageChange(e){
    const file = e.target.files[0];
    if(!file){
        setUI({itemForm: {...ui.itemForm, image: ''}});
        return;
    }
    const image = await fileToThumbnail(file);
    setUI({itemForm: {...ui.itemForm, image}});
}

function openItemForm(){
    setUI({
        formOpen: 'item',
        itemForm: {name: '', image: '', editingId: '', nameError: false},
    });
}
function onItemFormSubmit(e){
    e.preventDefault();
    const {name: raw, image, editingId} = ui.itemForm;
    const name = raw.trim();
    if(!name) return;
    if(itemNameExists(name, editingId)){
        setUI({itemForm: {...ui.itemForm, nameError: true}});
        return;
    }
    if(editingId){
        const existing = store.getRow('items', editingId);
        store.setRow('items', editingId, {
            name, image, boxId: existing?.boxId || '',
        });
    } else {
        store.setRow('items', crypto.randomUUID(), {
            name, image, boxId: '',
        });
    }
    closeForm();
}

function openBoxEdit(id, row){
    setUI({
        formOpen: 'box',
        boxForm: {
            photo: row.photo || '',
            photoName: row.photoName || '',
            editingId: id,
        },
    });
}

function onBoxFormDelete(){
    const {editingId} = ui.boxForm;
    if(!editingId) return;
    if(!confirm('Delete this box? Items inside go back to Unassigned.')) return;
    const items = store.getTable('items');
    for(const id of Object.keys(items)){
        if(items[id].boxId === editingId){
            store.setCell('items', id, 'boxId', '');
        }
    }
    store.delRow('boxes', editingId);
    closeForm();
}

function openItemEdit(id, item){
    setUI({
        formOpen: 'item',
        itemForm: {
            name: item.name || '',
            image: item.image || '',
            editingId: id,
            nameError: false,
        },
    });
}

function onItemFormDelete(){
    const {editingId} = ui.itemForm;
    if(!editingId) return;
    if(!confirm('Delete this item?')) return;
    store.delRow('items', editingId);
    closeForm();
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

document.addEventListener('dropzone:drop', e => {
    const itemId = e.detail.sourceEl.dataset.itemId;
    if(!itemId) return;
    const boxId = e.target.dataset.boxId || '';
    store.setCell('items', itemId, 'boxId', boxId);
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

document.addEventListener('reorder:move', e => {
    if(e.target.dataset?.reorder !== 'boxes') return;
    const { from, to } = e.detail;
    const rows = store.getTable('boxes');
    const ordered = Object.keys(rows).sort((a, b) =>
        (rows[a].order ?? 0) - (rows[b].order ?? 0));
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
    store.transaction(() => {
        ordered.forEach((id, idx) => store.setCell('boxes', id, 'order', idx));
    });
});
