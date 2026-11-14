// Onglet Pilotes : liste éditable avec photo, nom et couleur.
// Ajouter, modifier, supprimer, trier/filtrer, affichage liste ou grille.

import { esc, $, $$, modal, confirmBox, toast } from '../ui.js';

let app;
let root;
const ui = { layout: 'list', sort: 'name', query: '', filterOpen: false };

export function mount(main, a) {
  app = a;
  root = main;
  render();
}

export function unmount() {
  root = null;
}

export function refresh() {
  if (root && app.view === 'drivers') render();
}

/** Photo du pilote, ou ses initiales sur sa couleur. */
export function avatar(d, cls = '') {
  if (d?.photo) return `<img class="avatar ${cls}" src="${d.photo}" alt="">`;
  const initials = (d?.name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return `<div class="avatar avatar-txt ${cls}" style="background:${esc(d?.color || '#555')}">${esc(initials)}</div>`;
}

function sorted() {
  const q = ui.query.trim().toLowerCase();
  const list = app.data.drivers.filter((d) => !q || d.name.toLowerCase().includes(q));
  const by = {
    name: (a, b) => a.name.localeCompare(b.name, 'fr'),
    nameDesc: (a, b) => b.name.localeCompare(a.name, 'fr'),
    recent: (a, b) => (b.created || 0) - (a.created || 0),
  }[ui.sort];
  return list.sort(by);
}

function render() {
  const list = sorted();
  const total = app.data.drivers.length;
  root.innerHTML = `
  <div class="drivers-wrap">
    <div class="panel drivers-toolbar">
      <div class="row" style="gap:8px">
        <button class="btn go" id="dAdd" style="flex:1">＋ Ajouter</button>
        <button class="btn" id="dImport" title="Importer des pilotes depuis une sauvegarde Paddock">⬆ Import</button>
        <input type="file" id="dImportFile" accept="application/json" hidden>
      </div>
      <div class="row" style="gap:8px;margin-top:8px">
        <button class="btn" id="dFilter" style="flex:1">⚲ Trier et filtrer</button>
        <div class="seg">
          <button data-layout="list" class="${ui.layout === 'list' ? 'on' : ''}" title="Liste">☰</button>
          <button data-layout="grid" class="${ui.layout === 'grid' ? 'on' : ''}" title="Grille">▦</button>
        </div>
      </div>
      ${ui.filterOpen ? `
      <div class="row" style="gap:8px;margin-top:8px">
        <input type="text" id="dSearch" placeholder="Rechercher un pilote…" value="${esc(ui.query)}" style="flex:1;min-width:150px">
        <select id="dSort">
          <option value="name" ${ui.sort === 'name' ? 'selected' : ''}>Nom A → Z</option>
          <option value="nameDesc" ${ui.sort === 'nameDesc' ? 'selected' : ''}>Nom Z → A</option>
          <option value="recent" ${ui.sort === 'recent' ? 'selected' : ''}>Ajoutés récemment</option>
        </select>
      </div>` : ''}
      <div class="drivers-count">${list.length === total ? total : `${list.length} / ${total}`} pilote${total > 1 ? 's' : ''}</div>
    </div>

    <div class="drivers ${ui.layout}">
      ${list.map((d) => `
      <div class="driver-row" data-id="${esc(d.id)}">
        <div class="driver-photo" style="--dc:${esc(d.color)}">${avatar(d)}</div>
        <div class="driver-label">${esc(d.name)}</div>
        <div class="driver-actions">
          <button class="btn icon" data-edit title="Modifier">✎</button>
          <button class="btn icon danger" data-del title="Supprimer">⊖</button>
        </div>
      </div>`).join('') || '<p class="empty">Aucun pilote ne correspond.</p>'}
    </div>
  </div>`;
  bind();
}

function bind() {
  $('#dAdd', root).onclick = () => editDriver(null);
  $('#dFilter', root).onclick = () => { ui.filterOpen = !ui.filterOpen; render(); if (ui.filterOpen) $('#dSearch', root)?.focus(); };
  $$('[data-layout]', root).forEach((b) => (b.onclick = () => { ui.layout = b.dataset.layout; render(); }));
  const search = $('#dSearch', root);
  if (search) {
    search.oninput = () => {
      ui.query = search.value;
      const pos = search.selectionStart;
      render();
      const s = $('#dSearch', root);
      s.focus();
      s.setSelectionRange(pos, pos);
    };
    $('#dSort', root).onchange = (e) => { ui.sort = e.target.value; render(); };
  }
  $$('.driver-row', root).forEach((row) => {
    const d = app.driver(row.dataset.id);
    row.querySelector('[data-edit]').onclick = () => editDriver(d);
    const open = () => { app.driverId = d.id; app.go('driver'); };
    // toute la ligne (photo, nom) ouvre la fiche ; les boutons de droite gardent leur rôle
    row.style.cursor = 'pointer';
    row.onclick = (e) => { if (!e.target.closest('.driver-actions')) open(); };
    row.querySelector('[data-del]').onclick = async () => {
      if (!(await confirmBox(`Supprimer ${d.name} ? Ses tours déjà enregistrés restent dans les statistiques.`))) return;
      await app.db.remove('drivers', d.id);
      await app.loadData();
      toast(`${d.name} supprimé`);
      render();
    };
  });

  const file = $('#dImportFile', root);
  $('#dImport', root).onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const incoming = Array.isArray(data) ? data : data.drivers;
      if (!Array.isArray(incoming)) throw new Error('aucun pilote dans ce fichier');
      let n = 0;
      for (const d of incoming) {
        if (!d?.name) continue;
        await app.db.put('drivers', { id: d.id, name: d.name, color: d.color || '#888', photo: d.photo || null, created: d.created || Date.now() });
        n++;
      }
      await app.loadData();
      toast(`${n} pilote${n > 1 ? 's' : ''} importé${n > 1 ? 's' : ''}`);
      render();
    } catch (e) {
      toast('Import impossible : ' + e.message, 4000);
    }
  };
}

/** Recadre une image au format portrait 3:4 et la compresse (≈ 30 Ko). */
async function toPortrait(fileOrBlob) {
  const url = URL.createObjectURL(fileOrBlob);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('image illisible'));
      i.src = url;
    });
    const W = 300, H = 400;
    const ratio = W / H;
    let sw = img.naturalWidth, sh = img.naturalHeight, sx = 0, sy = 0;
    if (sw / sh > ratio) { sw = sh * ratio; sx = (img.naturalWidth - sw) / 2; }
    else { sh = sw / ratio; sy = (img.naturalHeight - sh) / 4; } // garde plutôt le haut (le visage)
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
    return c.toDataURL('image/jpeg', 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const COLORS = ['#e10600', '#ff8a00', '#facc15', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#ffffff', '#9ca3af'];

export function editDriver(d, onSaved) {
  const isNew = !d;
  const draft = d ? { ...d } : {
    name: '',
    color: COLORS[app.data.drivers.length % COLORS.length],
    photo: null,
  };
  const m = modal(`
    <h2>${isNew ? 'Nouveau pilote' : 'Modifier le pilote'}</h2>
    <div class="driver-edit">
      <div class="driver-edit-photo">
        <div id="pPreview" class="driver-photo big" style="--dc:${esc(draft.color)}">${avatar(draft)}</div>
        <div class="row" style="gap:6px;justify-content:center;margin-top:8px">
          <label class="btn small">📷 Photo<input type="file" id="pFile" accept="image/*" hidden></label>
          <button class="btn small ghost" id="pClear" ${draft.photo ? '' : 'disabled'}>Retirer</button>
        </div>
      </div>
      <div style="display:grid;gap:12px;align-content:start">
        <label class="field">Nom<input type="text" id="pName" maxlength="30" value="${esc(draft.name)}" placeholder="Ex. Tib"></label>
        <div class="field">Couleur
          <div class="swatches">
            ${COLORS.map((c) => `<button class="sw ${c === draft.color ? 'on' : ''}" data-c="${c}" style="background:${c}" aria-label="Couleur ${c}"></button>`).join('')}
            <input type="color" id="pColor" value="${esc(draft.color)}" title="Autre couleur">
          </div>
        </div>
      </div>
    </div>
    <div class="row" style="justify-content:flex-end;margin-top:16px">
      <button class="btn ghost" data-close>Annuler</button>
      <button class="btn primary" id="pSave">${isNew ? 'Ajouter' : 'Enregistrer'}</button>
    </div>`);
  const el = m.el;
  const preview = () => {
    const p = $('#pPreview', el);
    p.style.setProperty('--dc', draft.color);
    p.innerHTML = avatar({ ...draft, name: $('#pName', el).value || draft.name });
    $('#pClear', el).disabled = !draft.photo;
    $$('.sw', el).forEach((s) => s.classList.toggle('on', s.dataset.c === draft.color));
  };
  $('#pName', el).oninput = preview;
  $$('.sw', el).forEach((s) => (s.onclick = () => { draft.color = s.dataset.c; $('#pColor', el).value = draft.color; preview(); }));
  $('#pColor', el).oninput = (e) => { draft.color = e.target.value; preview(); };
  $('#pFile', el).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      draft.photo = await toPortrait(f);
      preview();
    } catch (err) {
      toast('Photo impossible : ' + err.message);
    }
  };
  $('#pClear', el).onclick = () => { draft.photo = null; preview(); };
  $('#pSave', el).onclick = async () => {
    const name = $('#pName', el).value.trim();
    if (!name) { toast('Donne un nom au pilote'); $('#pName', el).focus(); return; }
    draft.name = name;
    if (isNew) draft.created = Date.now();
    await app.db.put('drivers', draft);
    await app.loadData();
    m.close();
    toast(isNew ? `${name} ajouté` : 'Pilote enregistré', 1500);
    if (onSaved) onSaved();
    else if (root) render();
  };
  setTimeout(() => $('#pName', el).focus(), 50);
}
