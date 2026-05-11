function renderItemEl(id, item){
    const li = document.createElement('li');
    li.className = 'item';
    li.setAttribute('data-item-id', id);
    li.setAttribute('data-draggable', '');
    if(item.image){
        const img = document.createElement('img');
        img.className = 'item-thumb';
        img.src = item.image;
        img.alt = item.name;
        li.append(img);
    }
    const nameEl = document.createElement('span');
    nameEl.className = 'item-name';
    nameEl.textContent = item.name;
    li.append(nameEl);
    return li;
}

function renderBoxEl(id, idx, row, itemsById, itemMatches){
    const li = document.createElement('li');
    li.className = 'box reorder-item';
    li.setAttribute('data-box-id', id);
    li.setAttribute('data-drop-target', '');
    li.setAttribute('data-idx', idx);

    const photoBtn = document.createElement('button');
    photoBtn.type = 'button';
    photoBtn.className = 'box-photo';
    photoBtn.setAttribute('aria-label', `Box ${row.photoName}`);
    const photoImg = document.createElement('img');
    photoImg.className = 'box-photo-thumb';
    photoImg.src = row.photo;
    photoImg.alt = '';
    photoBtn.append(photoImg);

    const itemsList = document.createElement('ul');
    itemsList.className = 'items-in-box';
    const containedIds = Object.keys(itemsById).filter(iid =>
        itemsById[iid].boxId === id && itemMatches(itemsById[iid].name));
    for(const iid of containedIds){
        itemsList.append(renderItemEl(iid, itemsById[iid]));
    }

    const grip = document.createElement('button');
    grip.type = 'button';
    grip.className = 'reorder-grip';
    grip.setAttribute('aria-label', `Reorder ${row.photoName}`);
    grip.innerHTML = '<svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">'
        + '<circle cx="2" cy="3" r="1.3"/><circle cx="8" cy="3" r="1.3"/>'
        + '<circle cx="2" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/>'
        + '<circle cx="2" cy="13" r="1.3"/><circle cx="8" cy="13" r="1.3"/>'
        + '</svg>';

    li.append(photoBtn, itemsList, grip);
    return li;
}

function setSyncStatus(s){
    const el = document.querySelector('[data-sync-status]');
    el.textContent = `Sync ${s}`;
    el.dataset.status = s;
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
    console.log('[sync] opening', syncUrl);
    setSyncStatus('connecting');
    const ws = new WebSocket(syncUrl);
    ws.addEventListener('open', () => { console.log('[sync] open'); setSyncStatus('connected'); });
    ws.addEventListener('close', e => { console.log('[sync] close', e.code, e.reason); setSyncStatus('disconnected'); });
    ws.addEventListener('error', e => { console.log('[sync] error', e); setSyncStatus('disconnected'); });
    const sync = await createWsSynchronizer(store, ws);
    await sync.startSync();
}

import { createMergeableStore } from 'tinybase';
import { createIndexedDbPersister } from 'tinybase/persisters/persister-indexed-db';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';

// MergeableStore (not the plain Store) is what the WS synchronizer
// requires — it carries the per-cell HLC timestamps that make
// conflict-free merges possible across devices.
const store = createMergeableStore();
const persister = createIndexedDbPersister(store, 'organiser');

function render(){
  const noBoxes = !Object.keys(store.getTable('boxes')).length;
  const noItems = !Object.keys(store.getTable('items')).length;
  document.querySelector('[data-empty-state]').hidden = !(noBoxes && noItems);
  const list = document.querySelector('[data-boxes-list]');
  const rows = store.getTable('boxes');
  const itemsById = store.getTable('items');
  const queryB = (document.querySelector('[data-search]')?.value || '').trim().toLowerCase();
  const itemMatchesB = name => !queryB || name.toLowerCase().includes(queryB);
  const sortedIds = Object.keys(rows).sort((a, b) =>
      (rows[a].order ?? 0) - (rows[b].order ?? 0));
  const ids = sortedIds.filter(id => {
      if(!queryB) return true;
      return Object.keys(itemsById).some(iid =>
          itemsById[iid].boxId === id && itemMatchesB(itemsById[iid].name));
  });
  list.hidden = !ids.length;
  list.replaceChildren(...ids.map((id, idx) =>
      renderBoxEl(id, idx, rows[id], itemsById, itemMatchesB)));
  const unassignedSection = document.querySelector('[data-unassigned]');
  const unassignedList = document.querySelector('[data-unassigned-items]');
  const itemsTable = store.getTable('items');
  const queryU = (document.querySelector('[data-search]')?.value || '').trim().toLowerCase();
  const unassignedIds = Object.keys(itemsTable).filter(id => {
      if(itemsTable[id].boxId) return false;
      return !queryU || itemsTable[id].name.toLowerCase().includes(queryU);
  });
  unassignedSection.hidden = !unassignedIds.length;
  unassignedList.replaceChildren(...unassignedIds.map(id =>
      renderItemEl(id, itemsTable[id])));
}

await persister.startAutoLoad();
store.addTablesListener(render);
render();
await persister.startAutoSave();
document.body.setAttribute('data-app-ready', '1');
startSync();

let editingItemId = '';
let pendingImage = '';

function resetItemImagePreview(src){
    const preview = document.querySelector('[data-item-image-preview]');
    if(src){
        preview.src = src;
        preview.hidden = false;
    } else {
        preview.hidden = true;
        preview.removeAttribute('src');
    }
}

function itemNameExists(name, exceptId){
    const items = store.getTable('items');
    const lower = name.toLowerCase();
    return Object.entries(items).some(([id, item]) =>
        id !== exceptId && item.name.toLowerCase() === lower);
}

document.querySelector('#addItemName').addEventListener('input', () => {
    document.querySelector('[data-item-name-error]').hidden = true;
});

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

document.querySelector('#addItemImage').addEventListener('change', async e => {
    const file = e.target.files[0];
    if(!file){
        pendingImage = '';
        resetItemImagePreview('');
        return;
    }
    pendingImage = await fileToThumbnail(file);
    resetItemImagePreview(pendingImage);
});

document.querySelector('[data-open-add-item]').addEventListener('click', () => {
    editingItemId = '';
    pendingImage = '';
    document.querySelector('#addItemName').value = '';
    document.querySelector('#addItemImage').value = '';
    resetItemImagePreview('');
    document.querySelector('[data-item-name-error]').hidden = true;
    document.querySelector('[data-delete-item]').hidden = true;
    openForm('[data-add-item-form]');
    document.querySelector('#addItemName').focus();
});

document.querySelector('[data-cancel-add-item]').addEventListener('click', () => {
    editingItemId = '';
    pendingImage = '';
    document.querySelector('[data-add-item-form]').hidden = true;
});

document.querySelector('[data-add-item-form]').addEventListener('submit', e => {
    e.preventDefault();
    const name = document.querySelector('#addItemName').value.trim();
    if(!name) return;
    if(itemNameExists(name, editingItemId)){
        document.querySelector('[data-item-name-error]').hidden = false;
        return;
    }
    if(editingItemId){
        const existing = store.getRow('items', editingItemId);
        store.setRow('items', editingItemId, {
            name, image: pendingImage, boxId: existing?.boxId || '',
        });
        editingItemId = '';
    } else {
        store.setRow('items', crypto.randomUUID(), {
            name, image: pendingImage, boxId: '',
        });
    }
    pendingImage = '';
    document.querySelector('#addItemName').value = '';
    document.querySelector('#addItemImage').value = '';
    resetItemImagePreview('');
    document.querySelector('[data-add-item-form]').hidden = true;
});

function openForm(which){
    const forms = ['[data-add-form]', '[data-add-item-form]'];
    for(const sel of forms){
        document.querySelector(sel).hidden = (sel !== which);
    }
}

let editingBoxId = '';
let pendingBoxPhoto = '';
let pendingBoxPhotoName = '';

function resetBoxPhotoPreview(src){
    const preview = document.querySelector('[data-box-photo-preview]');
    if(src){
        preview.src = src;
        preview.hidden = false;
    } else {
        preview.hidden = true;
        preview.removeAttribute('src');
    }
}

document.querySelector('#addBoxPhoto').addEventListener('change', async e => {
    const file = e.target.files[0];
    if(!file){
        pendingBoxPhoto = '';
        pendingBoxPhotoName = '';
        resetBoxPhotoPreview('');
        return;
    }
    pendingBoxPhoto = await fileToThumbnail(file);
    pendingBoxPhotoName = file.name.replace(/\.[^.]+$/, '');
    resetBoxPhotoPreview(pendingBoxPhoto);
});

document.querySelector('[data-open-add]').addEventListener('click', () => {
    editingBoxId = '';
    pendingBoxPhoto = '';
    pendingBoxPhotoName = '';
    document.querySelector('#addBoxPhoto').value = '';
    resetBoxPhotoPreview('');
    document.querySelector('[data-delete-box]').hidden = true;
    openForm('[data-add-form]');
});

document.querySelector('[data-cancel-add]').addEventListener('click', () => {
    editingBoxId = '';
    document.querySelector('[data-add-form]').hidden = true;
});

document.querySelector('[data-add-form]').addEventListener('submit', e => {
    e.preventDefault();
    if(!pendingBoxPhoto) return;
    const id = editingBoxId || crypto.randomUUID();
    const existing = store.getRow('boxes', id);
    const orders = Object.values(store.getTable('boxes')).map(r => r.order ?? 0);
    const order = existing?.order ?? (orders.length ? Math.max(...orders) + 1 : 0);
    store.setRow('boxes', id, {
        photo: pendingBoxPhoto,
        photoName: pendingBoxPhotoName,
        order,
    });
    editingBoxId = '';
    pendingBoxPhoto = '';
    pendingBoxPhotoName = '';
    document.querySelector('[data-add-form]').hidden = true;
});

document.addEventListener('click', e => {
    if(e.target.closest('[data-draggable]')) return;
    if(e.target.closest('.reorder-grip')) return;
    const box = e.target.closest('[data-box-id]');
    if(!box) return;
    const row = store.getRow('boxes', box.dataset.boxId);
    if(!row) return;
    editingBoxId = box.dataset.boxId;
    pendingBoxPhoto = row.photo || '';
    pendingBoxPhotoName = row.photoName || '';
    document.querySelector('#addBoxPhoto').value = '';
    resetBoxPhotoPreview(pendingBoxPhoto);
    document.querySelector('[data-delete-box]').hidden = false;
    openForm('[data-add-form]');
});

document.querySelector('[data-delete-box]').addEventListener('click', () => {
    if(!editingBoxId) return;
    if(!confirm('Delete this box? Items inside go back to Unassigned.')) return;
    const items = store.getTable('items');
    for(const id of Object.keys(items)){
        if(items[id].boxId === editingBoxId){
            store.setCell('items', id, 'boxId', '');
        }
    }
    store.delRow('boxes', editingBoxId);
    editingBoxId = '';
    document.querySelector('[data-add-form]').hidden = true;
});

document.addEventListener('click', e => {
    const item = e.target.closest('[data-draggable]');
    if(!item) return;
    const row = store.getRow('items', item.dataset.itemId);
    if(!row) return;
    editingItemId = item.dataset.itemId;
    pendingImage = row.image || '';
    document.querySelector('#addItemName').value = row.name;
    document.querySelector('#addItemImage').value = '';
    resetItemImagePreview(pendingImage);
    document.querySelector('[data-item-name-error]').hidden = true;
    document.querySelector('[data-delete-item]').hidden = false;
    openForm('[data-add-item-form]');
    document.querySelector('#addItemName').focus();
});

document.querySelector('[data-delete-item]').addEventListener('click', () => {
    if(!editingItemId) return;
    if(!confirm('Delete this item?')) return;
    store.delRow('items', editingItemId);
    editingItemId = '';
    document.querySelector('[data-add-item-form]').hidden = true;
});

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

document.querySelector('[data-search]').addEventListener('input', render);
