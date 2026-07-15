// [[id:4f21ee3e-33b2-40ec-aae8-d45eb8fb38cf][How it all fits together:8]]
import { render, html } from 'uhtml';
import { get, set } from 'idb-keyval';

// the doc, its maps, and its undo manager are created at boot, once Loro's WASM has loaded.
let doc, items, sections, itemSections, outings, outingSections, outingItems, checked, undo;

// view vs edit is per-device UI state — it is not synced and starts off.
// editing holds the "kind:id" being renamed in place, editingText its buffer,
// folded the "kind:id" of every collapsed card, selected the placements picked
// for a batch move/copy (each key is a thing tied to where it sits, so a linked
// thing is picked in one place, not everywhere); adding the section id whose
// inline add-a-thing field is open; filter narrows the catalog to things whose
// label contains it; picker holds the pending 'move'/'copy' while its target
// sheet is up (or null); wiz holds the planning assistant's state (or null);
// focusId the outing shown alone in its packing view (or null for the catalog);
// toast is the current notification { text } (or null).
let editMode = false, editing = null, editingText = '', folded = new Set(), selected = new Set();
let adding = null, filter = '', picker = null;
let wiz = null, focusId = null, toast = null;

// the sync layer's handles: the live socket, the room url, the toolbar state,
// the status code behind a refusal, and the growing wait between reconnects.
let ws, syncUrl, syncState = 'off', syncCode = '', retryDelay;
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
const app = document.getElementById('app');

function paint(){ document.body.toggleAttribute('data-edit', editMode); render(app, view(buildModel())); }

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
armGuard();   // the base entry Back lands on, so leaving the app asks first
if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
function backdropClose(close){ return e => { if(e.target === e.currentTarget) close(); }; }
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

function uncheck(ids){ ids.forEach(id => checked.delete(id)); doc.commit(); }
function uncheckAll(){ uncheck(Object.keys(checked.toJSON())); }
function openAdd(target){
    adding = (adding === target) ? null : target;
    if(adding && target !== ':orphan' && target !== ':section') folded.delete('section:' + target);
    paint();
    const box = document.querySelector('.section-add-input');
    if(box) box.focus();
}

function submitAdd(target){
    const box = document.querySelector('.section-add-input');
    if(target === ':section') addSection(box.value);
    else addItem(box.value, target === ':orphan' ? '' : target);
    box.value = ''; box.focus();
}

function closeAdd(){ adding = null; paint(); }

function addField(target, placeholder, submitLabel){
    return html`
      <div class="add section-add">
        <input class="section-add-input" placeholder=${placeholder}
               onkeydown=${e => e.key === 'Enter' ? submitAdd(target)
                              : e.key === 'Escape' ? closeAdd() : null}>
        <button aria-label=${submitLabel} onclick=${() => submitAdd(target)}>+</button>
      </div>`;
}
function before(k){ return k.slice(0, k.indexOf(':')); }
function after(k){ return k.slice(k.indexOf(':') + 1); }
function nameTaken(map, id, name){
    return Object.entries(map.toJSON()).some(([i, v]) => i !== id && (v.label || v.name) === name);
}
function mergeItems(from, into){
    for(const k of Object.keys(itemSections.toJSON()))
        if(before(k) === from){ itemSections.set(into + ':' + after(k), 1); itemSections.delete(k); }
    for(const k of Object.keys(outingItems.toJSON()))
        if(before(k) === from){ outingItems.set(into + ':' + after(k), 1); outingItems.delete(k); }
    if(checked.get(from)) checked.set(into, 1);
    checked.delete(from);
    items.delete(from);
    doc.commit();
}
function renameItem(id, label){
    label = (label || '').trim();
    if(!label) return;
    const twin = Object.keys(items.toJSON()).find(i => i !== id && items.get(i).label === label);
    if(twin) mergeItems(id, twin);
    else { items.set(id, { label }); doc.commit(); }
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

function removeItemHere(id, name, srcSection, srcOuting){
    if(srcSection){ unlinkItemFromSection(id, srcSection); notify('« ' + name + ' » retiré'); }
    else if(srcOuting){ unlinkItemFromOuting(id, srcOuting); notify('« ' + name + ' » retiré de la sortie'); }
    else { deleteItem(id); notify('« ' + name + ' » supprimé'); }
}

function removeSectionHere(id, name, srcOuting){
    if(srcOuting){ unlinkSectionFromOuting(id, srcOuting); notify('« ' + name + ' » retiré de la sortie'); }
    else { deleteSection(id); notify('« ' + name + ' » supprimé'); }
}

function removeOutingHere(id, name){ deleteOuting(id); notify('« ' + name + ' » supprimé'); }
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
    const looseOf = collect(outingItems, its, chk, {});
    const section = (id) => ({ id, name: secs[id]?.name, items: secItems[id] || [] });

    const ofOuting = {};
    for(const k of Object.keys(outingSections.toJSON())){
        const sec = after(k);
        if(secs[sec]) (ofOuting[before(k)] ||= []).push(sec);
    }
    const outingList = Object.entries(outings.toJSON()).map(([id, v]) =>
        ({ id, name: v.name, sections: (ofOuting[id] || []).map(section), items: looseOf[id] || [] }));
    const catalog = Object.keys(secs).map(section);
    const orphans = Object.entries(its).filter(([id]) => !placed[id])
        .map(([id, v]) => ({ id, label: v.label, done: !!chk[id] }));
    return { outingList, catalog, orphans };
}
function filterBar(){
    return html`
      <div class="filter">
        <input type="search" class="filter-input" placeholder="Filtrer" aria-label="Filtrer"
               oninput=${e => { filter = e.target.value; paint(); }}>
      </div>`;
}

function addSectionActuator(){
    return html`
      <div class="add-section">
        <button class="add-section-btn" aria-label="Nouvelle section"
                onclick=${() => openAdd(':section')}>+ Section</button>
        ${adding === ':section' ? addField(':section', 'Nouvelle section', 'Créer la section') : ''}
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

function itemRows(list, srcSection, srcOuting){
    return html`<ul class="items">${list.map(it => {
      const ek = 'item:' + it.id;                                   // rename key — the thing itself
      const sk = it.id + '|' + (srcSection || '') + '|' + (srcOuting || '');  // select key — this placement
      return html`
      <li class=${(it.done ? 'done' : '') + (selected.has(sk) ? ' selected' : '')}>
        ${editing === ek ? renameField(renameItem, it.id) : html`
          ${editMode && editing !== ek ? html`
            <input type="checkbox" class="select" aria-label="Sélectionner"
                .checked=${selected.has(sk)} onchange=${() => toggleSelect(sk)}>` : ''}
          <span class="check" role="checkbox" aria-checked=${it.done ? 'true' : 'false'}
                onclick=${() => toggleCheck(it.id)}>${it.label}</span>
          ${editMode ? editButtons(() => startEdit(ek, it.label),
                                   () => removeItemHere(it.id, it.label, srcSection, srcOuting)) : ''}`}
      </li>`; })}</ul>`;
}
function toggleFold(k){ folded.has(k) ? folded.delete(k) : folded.add(k); paint(); }

function foldAll(){
    if(folded.size) folded.clear();
    else Object.keys(sections.toJSON()).forEach(id => folded.add('section:' + id));
    paint();
}

function foldTitle(k, name){
    const open = !folded.has(k);
    return html`<span class="fold-title" role="button" tabindex="0"
      aria-expanded=${open ? 'true' : 'false'} onclick=${() => toggleFold(k)}
      ><span class="caret" aria-hidden="true">${open ? '▾' : '▸'}</span>${name}</span>`;
}
function countBadge(list){
    if(!list.length) return '';
    const done = list.filter(it => it.done).length;
    return html`<span class="count">${done}/${list.length}</span>`;
}

function uncheckButton(label, list){
    if(!list.some(it => it.done)) return '';
    return html`<button class="row-btn reset" aria-label=${label}
      onclick=${() => uncheck(list.map(it => it.id))}>↺</button>`;
}
function sectionCard(s, srcOuting){
    const k = 'section:' + s.id;
    return html`
      <section>
        <h3>${countBadge(s.items)}${editing === k ? renameField(renameSection, s.id)
            : html`${foldTitle(k, s.name)}${editMode ? html`${editButtons(() => startEdit(k, s.name),
                                                     () => removeSectionHere(s.id, s.name, srcOuting))}
                     <button class="row-btn" aria-label="Nouvelle chose" onclick=${() => openAdd(s.id)}>+</button>` : ''}`}${uncheckButton('Décocher la section', s.items)}</h3>
        ${folded.has(k) ? '' : html`
          ${editMode && adding === s.id ? addField(s.id, 'Nouvelle chose', 'Créer la chose') : ''}
          ${itemRows(s.items, s.id)}`}</section>`;
}

function outingCard(o){
    const k = 'outing:' + o.id;
    const its = [...o.sections.flatMap(x => x.items), ...o.items];
    return html`
      <article class="outing">
        <h2>${countBadge(its)}${editing === k ? renameField(renameOuting, o.id)
            : html`<span class="grow">${o.name}</span>${editMode ? editButtons(() => startEdit(k, o.name),
                                                    () => removeOutingHere(o.id, o.name)) : ''}`}${uncheckButton('Décocher la sortie', its)}</h2>
        ${o.sections.map(s => sectionCard(s, o.id))}
        ${o.items.length ? html`<h3>Sans section</h3>${itemRows(o.items, '', o.id)}` : ''}</article>`;
}

function orphanCard(orphans){
    if(!orphans.length && !editMode) return '';   // nothing loose, nothing to add — hide it
    return html`
      <section>
        <h3>${countBadge(orphans)}<span class="grow">Sans section</span>${editMode ? html`
          <button class="row-btn" aria-label="Nouvelle chose" onclick=${() => openAdd(':orphan')}>+</button>` : ''}${uncheckButton('Décocher', orphans)}</h3>
        ${editMode && adding === ':orphan' ? addField(':orphan', 'Nouvelle chose', 'Créer la chose') : ''}
        ${itemRows(orphans, '')}</section>`;
}
function openWizard(){
    wiz = { step: 1, kind: 'new', name: '', existing: '', picks: new Set(), itemPicks: new Set(), itemFilter: '', fromFocus: false };
    openScreen(() => { wiz = null; paint(); });
    paint();
}

function sectionsOf(outingId){
    return Object.keys(outingSections.toJSON()).filter(k => before(k) === outingId).map(after);
}

function itemsOf(outingId){
    return Object.keys(outingItems.toJSON()).filter(k => after(k) === outingId).map(before);
}

function modifyOuting(id){
    wiz = { step: 2, kind: 'existing', existing: id,
            picks: new Set(sectionsOf(id)), itemPicks: new Set(itemsOf(id)), itemFilter: '', fromFocus: true };
    openScreen(() => { wiz = null; paint(); });
    paint();
}
function composeOuting(id, picks, itemPicks){
    for(const k of Object.keys(outingSections.toJSON()))
        if(before(k) === id && !picks.has(after(k))) outingSections.delete(k);
    picks.forEach(sid => outingSections.set(id + ':' + sid, 1));
    for(const k of Object.keys(outingItems.toJSON()))
        if(after(k) === id && !itemPicks.has(before(k))) outingItems.delete(k);
    itemPicks.forEach(iid => outingItems.set(iid + ':' + id, 1));
    doc.commit();
}

function wizardNext(){
    if(wiz.kind === 'existing'){
        wiz.existing = wiz.existing || Object.keys(outings.toJSON())[0] || '';
        wiz.picks = new Set(sectionsOf(wiz.existing));
        wiz.itemPicks = new Set(itemsOf(wiz.existing));
    }
    wiz.step = 2; paint();
}

function wizardSubmit(){
    let id = wiz.existing;
    if(wiz.kind === 'new'){ id = slug(wiz.name || 'sortie'); outings.set(id, { name: (wiz.name || 'Sortie').trim() }); }
    const { picks, itemPicks, fromFocus } = wiz;
    composeOuting(id, picks, itemPicks);
    wiz = null;
    focusId = id;
    paint();
    if(fromFocus) goBack();
    else backStack[backStack.length - 1] = () => { focusId = null; paint(); };
}

function wizAddItem(){
    const input = document.querySelector('.wiz-add-input');
    const sel = document.querySelector('.wiz-add-select');
    const label = (input.value || '').trim();
    if(!label) return;
    addItem(label, sel.value);
    wiz.itemPicks.add(slug(label));
    input.value = ''; input.focus();
    paint();
}
function wizardPanel(){
    const outs = Object.entries(outings.toJSON());
    return html`<div class="sheet-back" onclick=${backdropClose(goBack)}><div class="sheet wizard" role="dialog" aria-label="Planifier une sortie">
      ${wiz.step === 1 ? html`
        <h2 class="wiz-title">Planifier une sortie</h2>
        <div class="wizrow">
          <button class=${wiz.kind === 'new' ? 'wiz-on' : 'wiz-off'} onclick=${() => { wiz.kind = 'new'; paint(); }}>Nouvelle</button>
          <button class=${wiz.kind === 'existing' ? 'wiz-on' : 'wiz-off'} onclick=${() => { wiz.kind = 'existing'; paint(); }}>Existante</button>
        </div>
        ${wiz.kind === 'new'
          ? html`<input class="wiz-name" placeholder="Nom de la sortie" oninput=${e => wiz.name = e.target.value}>`
          : html`<select class="wiz-name" aria-label="Sortie existante" onchange=${e => wiz.existing = e.target.value}>
              ${outs.map(([id, v]) => html`<option value=${id}>${v.name}</option>`)}</select>`}
        <div class="wizrow end">
          <button class="wiz-off" onclick=${() => goBack()}>Annuler</button>
          <button class="wiz-on" onclick=${wizardNext}>Suivant</button>
        </div>` : html`
        <h2 class="wiz-title">Quelles sections ?</h2>
        ${Object.entries(sections.toJSON()).map(([id, v]) => html`
          <label class="pick"><input type="checkbox" aria-label=${v.name} .checked=${wiz.picks.has(id)}
            onchange=${() => { wiz.picks.has(id) ? wiz.picks.delete(id) : wiz.picks.add(id); paint(); }}>${v.name}</label>`)}
        <h2 class="wiz-title">Quelles choses ?</h2>
        <input type="search" class="wiz-filter" placeholder="Filtrer" aria-label="Filtrer les choses"
               oninput=${e => { wiz.itemFilter = e.target.value; paint(); }}>
        ${Object.entries(items.toJSON())
          .filter(([id, v]) => v.label.toLowerCase().includes(wiz.itemFilter.trim().toLowerCase()))
          .map(([id, v]) => html`
          <label class="pick"><input type="checkbox" aria-label=${v.label} .checked=${wiz.itemPicks.has(id)}
            onchange=${() => { wiz.itemPicks.has(id) ? wiz.itemPicks.delete(id) : wiz.itemPicks.add(id); paint(); }}>${v.label}</label>`)}
        <div class="add wiz-add">
          <input class="wiz-add-input" placeholder="Nouvelle chose"
                 onkeydown=${e => { if(e.key === 'Enter') wizAddItem(); }}>
          <select class="wiz-add-select" aria-label="Section">
            <option value="">Sans section</option>
            ${Object.entries(sections.toJSON()).map(([id, v]) => html`<option value=${id}>${v.name}</option>`)}
          </select>
          <button aria-label="Ajouter la chose" onclick=${wizAddItem}>+</button>
        </div>
        <div class="wizrow end">
          <button class="wiz-off" onclick=${() => { wiz.step = 1; paint(); }}>Retour</button>
          <button class="wiz-on" onclick=${wizardSubmit}>Valider</button>
        </div>`}
    </div></div>`;
}
function doUndo(){ if(undo.canUndo()) undo.undo(); }
function doRedo(){ if(undo.canRedo()) undo.redo(); }

function outingChip(o){
    const its = o.sections.flatMap(x => x.items), done = its.filter(it => it.done).length;
    return html`<button class="chip" onclick=${() => { focusId = o.id; openScreen(() => { focusId = null; paint(); }); paint(); }}>
      ${o.name} <small>${done}/${its.length}</small></button>`;
}

function focusView(m){
    return html`
      <div class="toolbar">
        <button class="edit-toggle" aria-label="Retour" onclick=${() => goBack()}>← Retour</button>
        <span class="toolbar-actions">
          <button class="row-btn" aria-label="Modifier la sortie" onclick=${() => modifyOuting(focusId)}>✎</button>
          <button class="row-btn" aria-label=${folded.size ? 'Tout déplier' : 'Tout plier'}
                  onclick=${foldAll}>${folded.size ? '⊞' : '⊟'}</button>
          <button class="row-btn" aria-label="Défaire" ?disabled=${!undo.canUndo()} onclick=${doUndo}>↶</button>
          <button class="row-btn" aria-label="Refaire" ?disabled=${!undo.canRedo()} onclick=${doRedo}>↷</button>
          <button class="edit-toggle" onclick=${toggleEdit}>${editMode ? 'Terminé' : 'Modifier'}</button>
        </span>
      </div>
      ${selected.size ? selectionBar() : ''}
      ${outingCard(m.outingList.find(o => o.id === focusId))}
      ${wiz ? wizardPanel() : ''}
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
function leaveEdit(){ editMode = false; editing = null; selected.clear(); adding = null; picker = null; paint(); }

function toggleEdit(){ if(editMode) leaveEdit(); else { editMode = true; paint(); } }

function view(m){
    if(focusId && m.outingList.some(o => o.id === focusId)) return focusView(m);
    focusId = null;   // no outing focused, or the focused one is gone — show the catalog
    const empty = !m.outingList.length && !m.catalog.length && !m.orphans.length;
    const q = filter.trim().toLowerCase();
    const match = it => it.label.toLowerCase().includes(q);
    const catalog = q ? m.catalog.map(s => ({ ...s, items: s.items.filter(match) })).filter(s => s.items.length) : m.catalog;
    const orphans = q ? m.orphans.filter(match) : m.orphans;
    const syncLabel = { off: 'Local', connecting: 'Connexion…', online: 'Synchronisé',
                        offline: 'Hors ligne' + (syncCode ? ' ' + syncCode : '') }[syncState];
    return html`
      <div class="toolbar">
        <span class="sync" data-sync=${syncState}>${syncLabel}</span>
        <span class="toolbar-actions">
          <button class="row-btn" aria-label=${folded.size ? 'Tout déplier' : 'Tout plier'}
                  onclick=${foldAll}>${folded.size ? '⊞' : '⊟'}</button>
          <button class="row-btn" aria-label="Défaire" ?disabled=${!undo.canUndo()}
                  onclick=${doUndo}>↶</button>
          <button class="row-btn" aria-label="Refaire" ?disabled=${!undo.canRedo()}
                  onclick=${doRedo}>↷</button>
          <button class="row-btn" aria-label="Planifier une sortie" onclick=${openWizard}>🧳</button>
          <button class="edit-toggle" onclick=${toggleEdit}>${editMode ? 'Terminé' : 'Modifier'}</button>
          <button class="row-btn" aria-label="Tout décocher" onclick=${uncheckAll}>↺</button>
        </span>
      </div>
      ${selected.size ? selectionBar() : ''}
      ${m.outingList.length ? html`<div class="outings">${m.outingList.map(outingChip)}</div>` : ''}
      ${empty && !editMode ? html`<p class="empty">Rien à prendre pour l'instant.</p>` : html`
        ${empty ? '' : filterBar()}
        ${catalog.map(s => sectionCard(s, ''))}
        ${orphanCard(orphans)}
        ${editMode ? addSectionActuator() : ''}`}
      ${wiz ? wizardPanel() : ''}
      ${picker ? pickerPanel() : ''}
      ${toast ? toastView() : ''}`;
}
function applyPlacement(key, dstSection, mode){
    const [itemId, srcSection, srcOuting] = key.split('|');
    if(srcSection === dstSection) return;
    itemSections.set(itemId + ':' + dstSection, 1);
    if(mode === 'move'){
        if(srcSection) itemSections.delete(itemId + ':' + srcSection);
        else if(srcOuting) outingItems.delete(itemId + ':' + srcOuting);
    }
}

function moveOrCopySelected(dstSection, mode){
    [...selected].forEach(k => applyPlacement(k, dstSection, mode));
    selected.clear();
    doc.commit();
    paint();
}
function openPicker(mode){ picker = mode; openScreen(() => { picker = null; paint(); }); paint(); }
function applyPick(dstSection){
    const mode = picker, name = sections.get(dstSection).name;
    moveOrCopySelected(dstSection, mode);
    notify((mode === 'move' ? 'Déplacé vers « ' : 'Copié vers « ') + name + ' »');
    goBack();
}

function selectionBar(){
    const n = selected.size;
    return html`<div class="selbar">
      <span class="selcount">${n} sélectionné${n > 1 ? 's' : ''}</span>
      <button onclick=${() => openPicker('copy')}>Copier</button>
      <button onclick=${() => openPicker('move')}>Déplacer</button>
      <button class="selclear" aria-label="Tout désélectionner" onclick=${() => { selected.clear(); paint(); }}>✕</button>
    </div>`;
}

function pickerPanel(){
    const verb = picker === 'move' ? 'Déplacer' : 'Copier';
    return html`<div class="sheet-back" onclick=${backdropClose(goBack)}><div class="sheet picker" role="dialog" aria-label=${verb}>
      <p class="sheet-msg">${verb} vers…</p>
      ${Object.entries(sections.toJSON()).map(([id, v]) => html`
        <button class="pick-target" onclick=${() => applyPick(id)}>${v.name}</button>`)}
      <button class="wiz-off" onclick=${() => goBack()}>Annuler</button>
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
    syncUrl = url;
    doc.subscribe((batch) => {
        if(batch.by === 'local' && ws && ws.readyState === WebSocket.OPEN)
            ws.send(doc.export({ mode: 'update' }));
    });
    connect();
}
// How it all fits together:8 ends here
