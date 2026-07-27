function jumpToBox(boxId){
    setUI({catalogOpen: false});
    const sel = boxId
        ? `li[data-box-id="${boxId}"]`
        : '.unassigned';
    const el = document.querySelector(sel);
    if(!el) return;
    el.scrollIntoView({behavior: 'smooth', block: 'center'});
    el.classList.remove('spotlight');
    void el.offsetWidth;
    el.classList.add('spotlight');
    el.addEventListener('animationend',
        () => el.classList.remove('spotlight'),
        {once: true});
}

function setSyncStatus(s){
    setUI({syncStatus: s});
}
function openSocket(url){
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.addEventListener('open', () => resolve(ws), {once: true});
        ws.addEventListener('error', reject, {once: true});
    });
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
    let backoff = 0;
    while(true){
        if(backoff) await new Promise(r => setTimeout(r, backoff));
        setSyncStatus('connecting');
        try {
            const ws = await openSocket(syncUrl);
            setSyncStatus('connected');
            backoff = 0;
            const sync = await createWsSynchronizer(store, ws);
            await sync.startSync();
            await new Promise(resolve =>
                ws.addEventListener('close', resolve, {once: true}));
        } catch(_){}
        setSyncStatus('disconnected');
        backoff = Math.min(30000, backoff ? backoff * 2 : 1000);
    }
}

const ui = {
    formOpen: null,
    boxForm: {photo: '', editingId: ''},
    itemForm: {name: '', image: '', bgColor: '', whereabouts: '', editingId: '', nameError: false, boxId: ''},
    searchQuery: '',
    syncStatus: 'off',
    dragEnabled: false,
    contextMenu: null,
    catalogOpen: false,
};

function setUI(updates){
    Object.assign(ui, updates);
    renderApp();
}

class AppRoot extends LitElement {
    createRenderRoot(){ return this; }
    connectedCallback(){
        super.connectedCallback();
        installAppRootHandlers(this);
    }
    render(){ return appTemplate(this); }
}
customElements.define('app-root', AppRoot);
function installAppRootHandlers(root){
    const on = (type, fn) => root.addEventListener(type, fn);
    on('open-box-form', () => openBoxForm());
    on('close-form', () => closeForm());
    on('box-photo-change', e => onBoxPhotoChange(e.detail.file));
    on('submit-box', () => onBoxFormSubmit());
    on('edit-box', e => openBoxEdit(e.detail.boxId, e.detail.row));
    on('delete-box', () => onBoxFormDelete());
    on('open-item-form', e => openItemForm(e.detail || {}));
    on('item-name-input', e => onItemNameInput(e.detail.value));
    on('item-image-change', e => onItemImageChange(e.detail.file));
    on('submit-item', () => onItemFormSubmit());
    on('edit-item', e => openItemEdit(e.detail.itemId, e.detail.item));
    on('delete-item', () => onItemFormDelete());
    on('item-colour-pick', e => setItemFormColour(e.detail.value));
    on('item-whereabouts-input', e => onItemWhereaboutsInput(e.detail.value));
    on('toggle-drag', () => setUI({dragEnabled: !ui.dragEnabled, contextMenu: null}));
    on('add-item-here', e => openItemForm({boxId: e.detail.boxId}));
    on('open-catalog', () => setUI({catalogOpen: true}));
    on('close-catalog', () => setUI({catalogOpen: false}));
    on('catalog-jump', e => jumpToBox(e.detail.boxId));
}
function appTemplate(root){
    return html`
      <header class="app-bar">
        <sync-indicator .status=${ui.syncStatus}></sync-indicator>
        <div class="app-bar-actions">
          <add-box-button></add-box-button>
          <add-item-button></add-item-button>
          <catalog-button></catalog-button>
        </div>
        <sl-input type="search" placeholder="Search…" aria-label="Search" clearable
                  .value=${ui.searchQuery}
                  @sl-input=${e => setUI({searchQuery: e.target.value})}></sl-input>
      </header>
      ${ui.formOpen === 'box' ? html`<box-form .draft=${ui.boxForm}></box-form>` : ''}
      ${ui.formOpen === 'item' ? html`<item-form .draft=${ui.itemForm}></item-form>` : ''}
      <catalog-overlay .open=${ui.catalogOpen}
                       .items=${store.getTable('items')}
                       .query=${ui.searchQuery}></catalog-overlay>
      ${!Object.keys(store.getTable('boxes')).length
        && !Object.keys(store.getTable('items')).length
          ? html`<empty-state></empty-state>` : ''}
      <box-list .rows=${store.getTable('boxes')}
                .items=${store.getTable('items')}
                .query=${ui.searchQuery}></box-list>
      <unassigned-list .items=${store.getTable('items')}
                       .query=${ui.searchQuery}></unassigned-list>
      <context-menu .pos=${ui.contextMenu}></context-menu>
    `;
}
class EmptyState extends LitElement {
    createRenderRoot(){ return this; }
    render(){
        return html`
          <div class="empty-state">
            <div class="emoji">&#x1f4e6;</div>
            <h1>Organiser</h1>
            <p>No boxes yet.</p>
          </div>
        `;
    }
}
customElements.define('empty-state', EmptyState);
class AddBoxButton extends LitElement {
    createRenderRoot(){ return this; }
    render(){
        return html`<sl-button @click=${() =>
            this.dispatchEvent(new CustomEvent('open-box-form', {bubbles: true}))}>Add a box</sl-button>`;
    }
}
customElements.define('add-box-button', AddBoxButton);
class BoxForm extends LitElement {
    static properties = { draft: {} };
    createRenderRoot(){ return this; }
    render(){
        const {photo} = this.draft;
        return modalShellTemplate(html`
          <form class="add-form" @submit=${e => { e.preventDefault();
              this.dispatchEvent(new CustomEvent('submit-box', {bubbles: true})); }}>
            <label>Photo
              <input type="file" accept="image/*" capture="environment"
                     @change=${e => this.dispatchEvent(new CustomEvent('box-photo-change',
                         {bubbles: true, detail: {file: e.target.files[0] || null}}))}>
            </label>
            ${photo ? html`
              <img class="box-photo-preview" src=${photo} alt="">
            ` : ''}
            <div class="add-form-actions">
              <sl-button type="submit" variant="primary">Save</sl-button>
              <sl-button @click=${() =>
                  this.dispatchEvent(new CustomEvent('close-form', {bubbles: true}))}>Cancel</sl-button>
              ${deleteBoxButton(this)}
            </div>
          </form>
        `);
    }
}
customElements.define('box-form', BoxForm);
class BoxList extends LitElement {
    static properties = { rows: {}, items: {}, query: {} };
    createRenderRoot(){ return this; }
    render(){
        const rows = this.rows;
        const itemsById = this.items;
        const query = (this.query || '').trim().toLowerCase();
        const itemMatches = name => !query || name.toLowerCase().includes(query);
        const sortedIds = Object.keys(rows).sort((a, b) =>
            (rows[a].order ?? 0) - (rows[b].order ?? 0));
        const ids = sortedIds.filter(id => {
            if(!query) return true;
            return Object.keys(itemsById).some(iid =>
                itemsById[iid].boxId === id && itemMatches(itemsById[iid].name));
        });
        if(!ids.length) return '';
        return html`
          <ul class="boxes-list reorder-list" data-reorder="boxes" aria-label="Boxes">
            ${ids.map((id, idx) => html`
              <box-card .boxId=${id} .idx=${idx} .row=${rows[id]}
                        .itemsById=${itemsById} .query=${query}></box-card>
            `)}
          </ul>
        `;
    }
}
customElements.define('box-list', BoxList);
class BoxCard extends LitElement {
    static properties = {
        boxId: {}, idx: {}, row: {}, itemsById: {}, query: {},
    };
    createRenderRoot(){ return this; }
    render(){
        const { boxId: id, idx } = this;
        return html`
          <li class="box reorder-item"
              data-box-id=${id}
              data-idx=${idx}
              ?data-drop-target=${ui.dragEnabled}>
            ${boxCardBase(this)}
            ${boxCardItems(this)}
            ${boxCardGrip(this)}
          </li>
        `;
    }
}
customElements.define('box-card', BoxCard);
function boxCardBase(card){
    const { boxId: id, row } = card;
    return html`
      <button type="button" class="box-photo"
              @click=${() => card.dispatchEvent(new CustomEvent('edit-box',
                  {bubbles: true, detail: {boxId: id, row}}))}>
        <img class="box-photo-thumb" src=${row.photo} alt="">
      </button>
    `;
}
function deleteBoxButton(form){
    return ui.boxForm.editingId ? html`
      <sl-button variant="danger" @click=${() =>
          form.dispatchEvent(new CustomEvent('delete-box', {bubbles: true}))}>Delete</sl-button>
    ` : '';
}
function boxCardGrip(card){
    return ui.dragEnabled ? html`
      <button type="button" class="reorder-grip">
        <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true">
          <circle cx="2" cy="3" r="1.3"/><circle cx="8" cy="3" r="1.3"/>
          <circle cx="2" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/>
          <circle cx="2" cy="13" r="1.3"/><circle cx="8" cy="13" r="1.3"/>
        </svg>
      </button>
    ` : '';
}
class AddItemButton extends LitElement {
    createRenderRoot(){ return this; }
    render(){
        return html`<sl-button @click=${() =>
            this.dispatchEvent(new CustomEvent('open-item-form', {bubbles: true}))}>Add an item</sl-button>`;
    }
}
customElements.define('add-item-button', AddItemButton);
class ItemForm extends LitElement {
    static properties = { draft: {} };
    createRenderRoot(){ return this; }
    render(){ return modalShellTemplate(itemFormMarkup(this)); }
}
customElements.define('item-form', ItemForm);
function itemFormMarkup(form){
    const {name, image} = form.draft;
    return html`
      <form class="add-form" @submit=${e => { e.preventDefault();
          form.dispatchEvent(new CustomEvent('submit-item', {bubbles: true})); }}>
        <sl-input label="Item name" placeholder="e.g. 3mm screw" required
                  .value=${name}
                  @sl-input=${e => form.dispatchEvent(new CustomEvent('item-name-input',
                      {bubbles: true, detail: {value: e.target.value}}))}></sl-input>
        ${itemNameError(form)}
        <label>Image
          <input type="file" accept="image/*" capture="environment"
                 @change=${e => form.dispatchEvent(new CustomEvent('item-image-change',
                     {bubbles: true, detail: {file: e.target.files[0] || null}}))}>
        </label>
        ${image ? html`
          <img class="item-image-preview" src=${image} alt="Image preview">
        ` : ''}
        ${itemFormColour(form)}
        ${itemFormWhereabouts(form)}
        <div class="add-form-actions">
          <sl-button type="submit" variant="primary">Save</sl-button>
          <sl-button @click=${() =>
              form.dispatchEvent(new CustomEvent('close-form', {bubbles: true}))}>Cancel</sl-button>
          ${deleteItemButton(form)}
        </div>
      </form>
    `;
}
class ItemChip extends LitElement {
    static properties = { itemId: {}, item: {} };
    createRenderRoot(){ return this; }
    render(){
        const { itemId: id, item } = this;
        return html`
          <li class="item" data-item-id=${id} ?data-draggable=${ui.dragEnabled}
              ?data-away=${!!item.whereabouts}
              style=${item.bgColor ? `background:${item.bgColor};color:${readableForeground(item.bgColor)}` : ''}
              @click=${() => this.dispatchEvent(new CustomEvent('edit-item',
                  {bubbles: true, detail: {itemId: id, item}}))}>
            ${item.image ? html`<img class="item-thumb" src=${item.image} alt=${item.name}>` : ''}
            <span class="item-name">${item.name}</span>
            ${itemAwayBadge(item)}
          </li>
        `;
    }
}
customElements.define('item-chip', ItemChip);
class UnassignedList extends LitElement {
    static properties = { items: {}, query: {} };
    createRenderRoot(){ return this; }
    render(){
        const itemsTable = this.items;
        const query = (this.query || '').trim().toLowerCase();
        const unassignedIds = Object.keys(itemsTable)
            .filter(id => {
                if(itemsTable[id].boxId) return false;
                return !query || itemsTable[id].name.toLowerCase().includes(query);
            })
            .sort((a, b) => itemsTable[a].name.localeCompare(itemsTable[b].name));
        if(!unassignedIds.length) return '';
        return html`
          <section class="unassigned" ?data-drop-target=${ui.dragEnabled}>
            <h2>Unassigned</h2>
            <ul class="items-list">
              ${unassignedIds.map(id => html`
                <item-chip .itemId=${id} .item=${itemsTable[id]}></item-chip>
              `)}
            </ul>
          </section>
        `;
    }
}
customElements.define('unassigned-list', UnassignedList);
function boxCardItems(card){
    const { boxId: id, itemsById } = card;
    const query = (card.query || '').trim().toLowerCase();
    const itemMatches = name => !query || name.toLowerCase().includes(query);
    return html`
      <ul class="items-in-box">
        ${Object.keys(itemsById)
          .filter(iid => itemsById[iid].boxId === id && itemMatches(itemsById[iid].name))
          .sort((a, b) => itemsById[a].name.localeCompare(itemsById[b].name))
          .map(iid => html`
            <item-chip .itemId=${iid} .item=${itemsById[iid]}></item-chip>
          `)}
      </ul>
    `;
}
function deleteItemButton(form){
    return ui.itemForm.editingId ? html`
      <sl-button variant="danger" @click=${() =>
          form.dispatchEvent(new CustomEvent('delete-item', {bubbles: true}))}>Delete</sl-button>
    ` : '';
}
function itemFormColour(form){
    return html`
      <label>Background colour
        <input type="color" .value=${ui.itemForm.bgColor || '#000000'}
               @input=${e => form.dispatchEvent(new CustomEvent('item-colour-pick',
                   {bubbles: true, detail: {value: e.target.value}}))}>
      </label>
      <div class="colour-swatches" role="group" aria-label="Recently used colours">
        <button type="button" class="colour-swatch colour-none"
                aria-label="No colour"
                @click=${() => form.dispatchEvent(new CustomEvent('item-colour-pick',
                    {bubbles: true, detail: {value: ''}}))}></button>
        ${usedItemColours().map(c => html`
          <button type="button" class="colour-swatch"
                  style=${`background:${c}`}
                  aria-label="Use colour ${c}"
                  @click=${() => form.dispatchEvent(new CustomEvent('item-colour-pick',
                      {bubbles: true, detail: {value: c}}))}></button>
        `)}
      </div>
    `;
}
function itemFormWhereabouts(form){
    return html`
      <label>Where has it gone?
        <input type="text" placeholder="e.g. lent to Paul, in the living room"
               .value=${ui.itemForm.whereabouts || ''}
               @input=${e => form.dispatchEvent(new CustomEvent('item-whereabouts-input',
                   {bubbles: true, detail: {value: e.target.value}}))}>
      </label>
    `;
}
function itemAwayBadge(item){
    return item.whereabouts
        ? html`<span class="item-away">${item.whereabouts}</span>`
        : '';
}
function itemNameError(form){
    return ui.itemForm.nameError ? html`
      <p class="form-error" role="alert">An item with this name already exists.</p>
    ` : '';
}
class ContextMenu extends LitElement {
    static properties = { pos: {} };
    createRenderRoot(){ return this; }
    render(){
        const pos = this.pos;
        if(!pos) return '';
        return html`
          <sl-menu class="context-menu"
                   style="left:${pos.x}px; top:${pos.y}px">
            ${contextMenuAddItemEntry(this, pos)}
            ${contextMenuToggleEntry(this)}
          </sl-menu>
        `;
    }
}
customElements.define('context-menu', ContextMenu);
function contextMenuToggleEntry(menu){
    return html`
      <sl-menu-item @click=${() =>
          menu.dispatchEvent(new CustomEvent('toggle-drag', {bubbles: true}))}>
        ${ui.dragEnabled ? 'Done' : 'Rearrange'}
      </sl-menu-item>
    `;
}
function contextMenuAddItemEntry(menu, pos){
    return pos.boxId ? html`
      <sl-menu-item @click=${() => menu.dispatchEvent(new CustomEvent('add-item-here',
          {bubbles: true, detail: {boxId: pos.boxId}}))}>
        Add item here
      </sl-menu-item>
    ` : '';
}
class CatalogButton extends LitElement {
    createRenderRoot(){ return this; }
    render(){
        return html`<sl-button @click=${() =>
            this.dispatchEvent(new CustomEvent('open-catalog', {bubbles: true}))}>Catalog</sl-button>`;
    }
}
customElements.define('catalog-button', CatalogButton);
function catalogItemIds(itemsTable, query){
    return Object.keys(itemsTable)
        .filter(id => !query ||
                      itemsTable[id].name.toLowerCase().includes(query))
        .sort((a, b) => itemsTable[a].name.localeCompare(itemsTable[b].name));
}
function catalogChip(host, item){
    const style = item.bgColor
        ? `background:${item.bgColor};color:${readableForeground(item.bgColor)}`
        : '';
    return html`
      <button type="button" class="all-items-chip"
              data-name=${item.name}
              aria-label=${item.name}
              style=${style}
              @click=${() => host.dispatchEvent(new CustomEvent('catalog-jump',
                  {bubbles: true, detail: {boxId: item.boxId}}))}>
      </button>
    `;
}
class CatalogOverlay extends LitElement {
    static properties = { open: {}, items: {}, query: {} };
    createRenderRoot(){ return this; }
    render(){
        if(!this.open) return '';
        const query = (this.query || '').trim().toLowerCase();
        const ids = catalogItemIds(this.items, query);
        return html`
          <sl-dialog label="All items" open
                     style="--width: 480px;"
                     @sl-request-close=${() =>
                         this.dispatchEvent(new CustomEvent('close-catalog', {bubbles: true}))}>
            <section class="all-items" aria-label="All items">
              ${ids.map(id => catalogChip(this, this.items[id]))}
            </section>
          </sl-dialog>
        `;
    }
}
customElements.define('catalog-overlay', CatalogOverlay);
class SyncIndicator extends LitElement {
    static properties = { status: {} };
    createRenderRoot(){ return this; }
    render(){
        return html`<span class="sync-status" data-status=${this.status} role="status">Sync ${this.status}</span>`;
    }
}
customElements.define('sync-indicator', SyncIndicator);

import { createMergeableStore } from 'tinybase';
import { createIndexedDbPersister } from 'tinybase/persisters/persister-indexed-db';
import { createWsSynchronizer } from 'tinybase/synchronizers/synchronizer-ws-client';
import { html, LitElement } from 'lit';

const store = createMergeableStore();
const persister = createIndexedDbPersister(store, 'organiser');
const appRootEl = document.querySelector('app-root');
function renderApp(){ appRootEl?.requestUpdate(); }

await persister.startAutoLoad();
store.addTablesListener(renderApp);
renderApp();
await persister.startAutoSave();

document.getElementById('loading')?.remove();
startSync();

function modalShellTemplate(form){
    return html`
      <sl-dialog
          open
          no-header
          @sl-request-close=${e => e.preventDefault()}>
        ${form}
      </sl-dialog>
    `;
}
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
async function onBoxPhotoChange(file){
    if(!file){
        setUI({boxForm: {...ui.boxForm, photo: ''}});
        return;
    }
    const photo = await fileToThumbnail(file);
    setUI({boxForm: {...ui.boxForm, photo}});
}

function openBoxForm(){
    setUI({
        formOpen: 'box',
        boxForm: {photo: '', editingId: ''},
    });
}

function closeForm(){
    setUI({
        formOpen: null,
        boxForm: {photo: '', editingId: ''},
        itemForm: {name: '', image: '', bgColor: '', whereabouts: '', editingId: '', nameError: false},
    });
}
function onBoxFormSubmit(){
    const {photo, editingId} = ui.boxForm;
    if(!photo) return;
    const id = editingId || crypto.randomUUID();
    const existing = store.getRow('boxes', id);
    const orders = Object.values(store.getTable('boxes')).map(r => r.order ?? 0);
    const order = existing?.order ?? (orders.length ? Math.max(...orders) + 1 : 0);
    store.setRow('boxes', id, {photo, order});
    closeForm();
}

function itemNameExists(name, exceptId){
    const items = store.getTable('items');
    const lower = name.toLowerCase();
    return Object.entries(items).some(([id, item]) =>
        id !== exceptId && item.name.toLowerCase() === lower);
}
function onItemNameInput(value){
    setUI({itemForm: {...ui.itemForm, name: value, nameError: false}});
}
async function onItemImageChange(file){
    if(!file){
        setUI({itemForm: {...ui.itemForm, image: ''}});
        return;
    }
    const image = await fileToThumbnail(file);
    setUI({itemForm: {...ui.itemForm, image}});
}
function readableForeground(hex){
    const h = hex.replace('#', '');
    const channel = i => {
        const c = parseInt(h.substr(i, 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const L = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
    return L > 0.179 ? '#111' : '#fff';
}
function usedItemColours(){
    const items = store.getTable('items');
    const seen = new Set();
    for(const id of Object.keys(items)){
        const c = (items[id].bgColor || '').toLowerCase();
        if(c) seen.add(c);
    }
    return [...seen].sort();
}
function setItemFormColour(value){
    setUI({itemForm: {...ui.itemForm, bgColor: value || ''}});
}
function onItemWhereaboutsInput(value){
    setUI({itemForm: {...ui.itemForm, whereabouts: value}});
}

function openItemForm(opts = {}){
    setUI({
        formOpen: 'item',
        itemForm: {name: '', image: '', bgColor: '', whereabouts: '', editingId: '',
                   nameError: false, boxId: opts.boxId || ''},
        contextMenu: null,
    });
}
function onItemFormSubmit(){
    const {name: raw, image, bgColor, whereabouts, editingId, boxId} = ui.itemForm;
    const name = raw.trim();
    if(!name) return;
    if(itemNameExists(name, editingId)){
        setUI({itemForm: {...ui.itemForm, nameError: true}});
        return;
    }
    if(editingId){
        const existing = store.getRow('items', editingId);
        store.setRow('items', editingId, {
            name, image, bgColor, whereabouts, boxId: existing?.boxId || '',
        });
        closeForm();
        return;
    }
    store.setRow('items', crypto.randomUUID(), {
        name, image, bgColor, whereabouts, boxId: boxId || '',
    });
    if(boxId){
        setUI({itemForm: {name: '', image: '', bgColor: '', whereabouts: '', editingId: '',
                          nameError: false, boxId}});
    } else {
        closeForm();
    }
}

function openBoxEdit(id, row){
    setUI({
        formOpen: 'box',
        boxForm: {
            photo: row.photo || '',
            editingId: id,
        },
    });
}

function onBoxFormDelete(){
    const {editingId} = ui.boxForm;
    if(!editingId) return;
    if(!confirm('Delete this box? Items inside go back to Unassigned.')) return;
    store.transaction(() => {
        const items = store.getTable('items');
        for(const id of Object.keys(items)){
            if(items[id].boxId === editingId){
                store.setCell('items', id, 'boxId', '');
            }
        }
        store.delRow('boxes', editingId);
    });
    closeForm();
}

function openItemEdit(id, item){
    setUI({
        formOpen: 'item',
        itemForm: {
            name: item.name || '',
            image: item.image || '',
            bgColor: item.bgColor || '',
            whereabouts: item.whereabouts || '',
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

document.addEventListener('contextmenu', e => {
    if (e.target.closest('input, textarea, select, .context-menu')) return;
    e.preventDefault();
    const onChip = !!e.target.closest('[data-item-id]');
    const boxEl = onChip ? null : e.target.closest('[data-box-id]');
    setUI({contextMenu: {
        x: e.clientX, y: e.clientY,
        boxId: boxEl ? boxEl.dataset.boxId : null,
    }});
});
document.addEventListener('click', e => {
    if (!ui.contextMenu) return;
    if (e.target.closest('.context-menu')) return;
    setUI({contextMenu: null});
});
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && ui.contextMenu) setUI({contextMenu: null});
});
