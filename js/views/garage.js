// Garage : réglages accélération / freinage / réservoir pour chaque manette.
// Un réglage appartient au couple PILOTE + VOITURE : quand Tib prend la
// Ferrari, il retrouve son réglage Ferrari, quelle que soit la manette.
// En dessous : gestion des voitures et circuits (les pilotes ont leur onglet).

import { esc, $, $$, confirmBox, toast } from '../ui.js';
import { PLACE_CARS_MSG } from './quick.js';

let app;
let root;
let showAll = false;

const BARS = [
  { k: 'speed', label: 'Accélération', color: 'var(--green)' },
  { k: 'brake', label: 'Freinage', color: 'var(--accent-2)' },
  { k: 'fuel', label: 'Réservoir', color: 'var(--blue)' },
];

const pct = (v) => Math.round((v / 15) * 100);

export function mount(main, a) {
  app = a;
  root = main;
  render();
}

function opt(list, sel, empty) {
  return `<option value="">${empty}</option>` +
    list.map((x) => `<option value="${esc(x.id)}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
}

function tuneCard(slot) {
  const t = app.getTune(slot.driverId, slot.carId);
  const d = app.driver(slot.driverId);
  const ready = slot.driverId && slot.carId;
  return `
  <div class="tune ${slot.active ? '' : 'off'}" data-slot="${slot.address}" style="--dc:${esc(d?.color || '#555')}">
    <div class="tune-id">
      <div class="tune-n">${slot.address + 1}</div>
      <div class="tune-live" data-live>● EN PISTE</div>
      <label class="tune-on" title="Manette utilisée"><input type="checkbox" data-k="active" ${slot.active ? 'checked' : ''}> active</label>
    </div>
    <div class="tune-body">
      <div class="tune-who">
        <select data-k="driverId" class="tune-driver">${opt(app.data.drivers, slot.driverId, '— Pilote —')}</select>
        <select data-k="carId">${opt(app.data.cars, slot.carId, '— Voiture —')}</select>
      </div>
      ${ready ? BARS.map((b) => `
      <div class="bar" style="--c:${b.color};--p:${pct(t[b.k])}%">
        <span class="bar-l">${b.label}</span>
        <input type="range" min="0" max="15" step="1" value="${t[b.k]}" data-bar="${b.k}" aria-label="${b.label}">
        <span class="bar-v num">${pct(t[b.k])} %</span>
      </div>`).join('') : '<p class="muted" style="margin:6px 0 0">Choisis le pilote et la voiture pour régler.</p>'}
      ${ready && !t.saved ? '<p class="muted tune-hint">Première fois pour ce pilote sur cette voiture : réglage par défaut.</p>' : ''}
      ${ready && slot.address >= 4 ? '<p class="muted tune-hint">⚠️ Manettes 5 et 6 : le réservoir doit être réglé sur la Control Unit (bug du firmware Carrera).</p>' : ''}
    </div>
  </div>`;
}

function render() {
  const { cars, tracks } = app.data;
  const slots = app.setup.slots;
  const visible = showAll ? slots : slots.filter((s) => s.active);
  root.innerHTML = `
  <p class="warn-note top">${PLACE_CARS_MSG}</p>
  <section class="panel" style="margin-bottom:16px">
    <div class="row" style="justify-content:space-between">
      <div><h2 style="margin:0">Réglage des voitures</h2><span class="live-hint" id="liveHint"></span></div>
      <button class="btn small ghost" id="toggleAll">${showAll ? 'Masquer les manettes inactives' : 'Afficher les 6 manettes'}</button>
    </div>
    <p class="muted" style="margin:6px 0 14px;font-size:.9rem">
      Chaque réglage est mémorisé pour le <b>pilote</b> sur <b>cette voiture</b>, et envoyé tout de suite au circuit.
      ${app.isRacing ? '<br>Course en cours : accélération et freinage s\'appliquent immédiatement, le réservoir à la prochaine session.' : ''}
    </p>
    <div class="tunes" id="tunes">
      ${visible.length ? visible.map(tuneCard).join('') : '<p class="muted">Aucune manette en piste. Clique sur « Afficher les 6 manettes ».</p>'}
    </div>
  </section>

  <div class="grid grid-2">
    <section class="panel">
      <h2>Voitures</h2>
      <div class="list">
        ${cars.map((c) => `
        <div class="item" data-store="cars" data-id="${esc(c.id)}">
          <input type="text" data-k="name" value="${esc(c.name)}" maxlength="40" placeholder="Nom (ex. Ferrari 499P)">
          <button class="btn small ghost" data-del title="Supprimer">🗑</button>
        </div>`).join('')}
      </div>
      <button class="btn" style="margin-top:10px" data-add="cars">+ Ajouter une voiture</button>
    </section>

    <section class="panel">
      <h2>Circuits</h2>
      <p class="muted" style="margin-top:-6px;font-size:.85rem">Un circuit par tracé : les records et statistiques sont rangés par circuit.</p>
      <div class="list">
        ${tracks.map((t) => `
        <div class="item" data-store="tracks" data-id="${esc(t.id)}">
          <input type="text" data-k="name" value="${esc(t.name)}" maxlength="40">
          <label class="field" style="width:110px">Longueur (m)<input type="number" data-k="length" min="0" step="0.1" value="${t.length || ''}"></label>
          <button class="btn small ghost" data-del title="Supprimer">🗑</button>
        </div>`).join('')}
      </div>
      <button class="btn" style="margin-top:10px" data-add="tracks">+ Ajouter un circuit</button>
    </section>
  </div>`;
  bindTunes();
  bindLists();
}

const timers = new Map();

function bindTunes() {
  $('#toggleAll', root).onclick = () => { showAll = !showAll; render(); };
  $$('.tune', root).forEach((card) => {
    const slot = app.setup.slots[+card.dataset.slot];

    $$('[data-k]', card).forEach((input) => {
      input.addEventListener('change', () => {
        const k = input.dataset.k;
        if (k === 'active') slot.active = input.checked;
        else slot[k] = input.value || null;
        app.saveSetup();
        if (slot.active) app.applyTune(slot.address);
        render(); // recharge le réglage du nouveau couple pilote + voiture
      });
    });

    $$('[data-bar]', card).forEach((range) => {
      range.addEventListener('input', () => {
        const k = range.dataset.bar;
        const v = +range.value;
        const bar = range.parentElement;
        bar.style.setProperty('--p', pct(v) + '%');
        bar.querySelector('.bar-v').textContent = pct(v) + ' %';
        // enregistre et envoie au circuit après un court délai (glissement continu)
        clearTimeout(timers.get(card.dataset.slot + k));
        timers.set(card.dataset.slot + k, setTimeout(() => {
          app.saveTune(slot.driverId, slot.carId, { [k]: v });
        }, 150));
      });
    });
  });
}

const NUMERIC = new Set(['length']);

function bindLists() {
  $$('.item', root).forEach((row) => {
    const store = row.dataset.store;
    const id = row.dataset.id;
    $$('[data-k]', row).forEach((input) => {
      input.addEventListener('change', async () => {
        const obj = app.data[store].find((x) => x.id === id);
        const k = input.dataset.k;
        let v = input.value;
        if (NUMERIC.has(k)) v = parseFloat(v) || 0;
        else if (k === 'name') { v = v.trim() || obj.name; input.value = v; }
        obj[k] = v;
        await app.db.put(store, obj);
        toast('Enregistré', 1000);
        if (store !== 'tracks') render(); // met à jour les listes du haut
      });
    });
    $('[data-del]', row).onclick = async () => {
      if (!(await confirmBox('Supprimer cet élément ? Les tours déjà enregistrés sont conservés.'))) return;
      await app.db.remove(store, id);
      await app.loadData();
      render();
    };
  });
  $$('[data-add]', root).forEach((b) => (b.onclick = async () => {
    const store = b.dataset.add;
    const n = app.data[store].length + 1;
    const obj = store === 'drivers'
      ? { name: 'Pilote ' + n, color: '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0') }
      : store === 'cars' ? { name: 'Voiture ' + n } : { name: 'Circuit ' + n, length: 0 };
    obj.created = Date.now();
    await app.db.put(store, obj);
    await app.loadData();
    render();
  }));
}

export function refresh() {
  if (root && app.view === 'garage') render();
}

/** Surbrillance des manettes dont la voiture roule (passage récent sur la ligne). */
const LIVE_S = 30; // une voiture est "en piste" si elle est passée il y a moins de 30 s
export function tick() {
  if (!root || app.view !== 'garage') return;
  $$('.tune', root).forEach((card) => {
    const ago = app.seenAgo(+card.dataset.slot);
    const live = ago !== null && ago < LIVE_S;
    card.classList.toggle('live', live);
    card.classList.toggle('pulse', live && ago < 1.2);
  });
  const hint = $('#liveHint', root);
  if (hint) {
    const n = app.setup.slots.filter((s) => { const a = app.seenAgo(s.address); return a !== null && a < LIVE_S; }).length;
    hint.textContent = n
      ? `${n} voiture${n > 1 ? 's' : ''} en piste`
      : (app.cu.connected ? 'Fais rouler une voiture : sa manette s\'allume ici.' : 'Connecte le circuit pour détecter les voitures en piste.');
  }
}

export function unmount() {
  root = null;
}
