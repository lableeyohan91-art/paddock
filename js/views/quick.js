// Course rapide : préparation en un écran.
// Participants (manettes, pilote, voiture), nombre de tours, essence
// (activée ou non, setup, réservoir commun à toutes les voitures).
// Jamais de météo ni de pneus ici : c'est voulu.

import { esc, $, $$, toast } from '../ui.js';
import { avatar } from './drivers.js';

let app;
let root;
let prefs = null; // dernières valeurs choisies
let setups = [];
let activeSetup = null;

const LAP_CHIPS = [10, 20, 30, 50, 100];

export async function mount(main, a) {
  app = a;
  root = main;
  // au moins 2 participants affichés par défaut
  if (app.setup.slots.filter((s) => s.active).length < 2) {
    app.setup.slots.slice(0, 2).forEach((s) => (s.active = true));
    app.saveSetup();
  }
  prefs = { laps: 30, fuelOn: true, tank15: 15, ...(await app.db.getSetting('quickRace', {})) };
  setups = await app.fuelSetups();
  activeSetup = await app.db.getSetting('fuelActiveSetup', null);
  render();
}

export function unmount() {
  root = null;
}

export function refresh() {
  if (root && app.view === 'quick') render();
}

const savePrefs = () => app.db.setSetting('quickRace', prefs);
const pct15 = (v) => Math.round((v / 15) * 100);

function opt(list, sel, empty) {
  return `<option value="">${empty}</option>` +
    list.map((x) => `<option value="${esc(x.id)}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
}

function render() {
  if (!root) return;
  const slots = app.setup.slots;
  const n = slots.filter((s) => s.active).length;
  root.innerHTML = `
  <div class="quick">
    <div class="row" style="justify-content:space-between;margin-bottom:12px">
      <button class="btn small ghost" id="qBack">← Course</button>
      <h1 class="menu-title" style="margin:0">⚡ Course rapide</h1>
      <span style="width:80px"></span>
    </div>

    <section class="panel">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">1. Participants <span class="muted" style="font-weight:500">(${n})</span></h2>
        <span class="muted" style="font-size:.85rem" id="qLive"></span>
      </div>
      <div class="q-slots">
        ${slots.filter((s) => s.active).map((s) => {
          const d = app.driver(s.driverId);
          return `
        <div class="q-slot on" data-slot="${s.address}" style="--dc:${esc(d?.color || '#555')}">
          <span class="q-n" title="Manette ${s.address + 1}">${s.address + 1}</span>
          <select data-k="driverId">${opt(app.data.drivers, s.driverId, '— Pilote —')}</select>
          <select data-k="carId">${opt(app.data.cars, s.carId, '— Voiture —')}</select>
          <button class="q-del" data-del title="Retirer ce participant">✕</button>
        </div>`;
        }).join('')}
      </div>
      ${slots.some((s) => !s.active) ? '<button class="q-plus" id="qAdd" title="Ajouter un participant">＋</button>' : ''}
    </section>

    <section class="panel" style="margin-top:14px">
      <h2>2. Nombre de tours</h2>
      <div class="q-laps">
        ${LAP_CHIPS.map((l) => `<button class="chip ${prefs.laps === l ? 'on' : ''}" data-laps="${l}">${l}</button>`).join('')}
        <input type="number" id="qLaps" min="1" max="999" value="${prefs.laps}" aria-label="Nombre de tours">
      </div>
    </section>

    <section class="panel" style="margin-top:14px">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">3. Essence</h2>
        <label class="switch"><input type="checkbox" id="qFuel" ${prefs.fuelOn ? 'checked' : ''}><span></span> ${prefs.fuelOn ? 'Activée' : 'Désactivée'}</label>
      </div>
      ${prefs.fuelOn ? `
      <div class="q-fuel">
        <label class="field"><span>Setup d'essence <button class="q-gear" id="qFuelCfg" title="Réglages essence">⚙</button></span>
          <select id="qSetup">${setups.length ? setups.map((s) => `<option value="${esc(s.id)}" ${s.id === activeSetup ? 'selected' : ''}>${esc(s.name)}</option>`).join('')
            : '<option value="">Réglage actuel</option>'}</select></label>
        <div>
          <div class="bar" style="--c:var(--blue);--p:${pct15(prefs.tank15)}%">
            <span class="bar-l">Réservoir</span>
            <input type="range" id="qTank" min="1" max="15" value="${prefs.tank15}">
            <span class="bar-v num" id="qTankV">${pct15(prefs.tank15)} %</span>
          </div>
          <p class="muted" style="font-size:.8rem;margin:4px 0 0">Même réservoir pour toutes les voitures de la course.</p>
        </div>
      </div>` : '<p class="muted" style="margin:8px 0 0">Pas de consommation : les voitures roulent sans jamais s\'arrêter.</p>'}
    </section>

    <div class="q-go">
      <button class="depart" id="qStart">
        <span class="depart-lights"><i></i><i></i><i></i><i></i><i></i></span>
        <span class="depart-txt">DÉPART</span>
        <span class="depart-sub">${prefs.laps} tours · ${n} pilote${n > 1 ? 's' : ''} · ${prefs.fuelOn ? `essence ${pct15(prefs.tank15)} %` : 'sans essence'}</span>
      </button>
    </div>
  </div>`;
  bind();
  tick();
}

function bind() {
  $('#qBack', root).onclick = () => { app.raceMenu = true; app.go('race'); };

  $$('.q-slot', root).forEach((row) => {
    const slot = app.setup.slots[+row.dataset.slot];
    $$('[data-k]', row).forEach((input) => input.addEventListener('change', () => {
      slot[input.dataset.k] = input.value || null;
      app.saveSetup();
      app.applyTune(slot.address);
      render();
    }));
    $('[data-del]', row).onclick = () => {
      slot.active = false;
      app.mutedSlots.add(slot.address); // ne pas la rajouter automatiquement
      app.saveSetup();
      render();
    };
  });
  const add = $('#qAdd', root);
  if (add) add.onclick = () => {
    // ajoute la manette libre suivante (3, puis 4, 5, 6)
    const slot = app.setup.slots.find((s) => !s.active);
    if (!slot) return;
    slot.active = true;
    app.mutedSlots.delete(slot.address);
    app.saveSetup();
    app.applyTune(slot.address);
    render();
  };
  const gear = $('#qFuelCfg', root);
  if (gear) gear.onclick = (e) => { e.preventDefault(); app.openFuelSettings(); };

  $$('[data-laps]', root).forEach((b) => (b.onclick = () => { prefs.laps = +b.dataset.laps; savePrefs(); render(); }));
  $('#qLaps', root).onchange = (e) => { prefs.laps = Math.max(1, Math.min(999, parseInt(e.target.value, 10) || 1)); savePrefs(); render(); };

  $('#qFuel', root).onchange = (e) => { prefs.fuelOn = e.target.checked; savePrefs(); render(); };
  const sel = $('#qSetup', root);
  if (sel && setups.length) sel.onchange = async () => {
    await app.loadFuelSetup(sel.value);
    activeSetup = sel.value;
    toast(`Setup « ${setups.find((s) => s.id === sel.value)?.name} » chargé`);
  };
  const tank = $('#qTank', root);
  if (tank) tank.oninput = () => {
    prefs.tank15 = +tank.value;
    tank.parentElement.style.setProperty('--p', pct15(prefs.tank15) + '%');
    $('#qTankV', root).textContent = pct15(prefs.tank15) + ' %';
    savePrefs();
  };

  $('#qStart', root).onclick = async () => {
    const parts = app.setup.slots.filter((s) => s.active);
    if (!parts.length) { toast('Coche au moins un participant'); return; }
    if (parts.some((s) => !s.driverId)) { toast('Choisis un pilote pour chaque participant coché'); return; }
    // Départ : on prépare la course et on lance directement les feux
    const ok = await app.prepareQuickRace({ laps: prefs.laps, fuelOn: prefs.fuelOn, tank15: prefs.tank15 });
    if (ok) await app.startSession(); // non connecté : l'appli propose de connecter le circuit
  };
}

/** Met en évidence les manettes dont la voiture roule. */
export function tick() {
  if (!root) return;
  let live = 0;
  $$('.q-slot', root).forEach((row) => {
    const ago = app.seenAgo(+row.dataset.slot);
    const on = ago !== null && ago < 30;
    if (on) live++;
    row.classList.toggle('live', on);
  });
  const l = $('#qLive', root);
  if (l) l.textContent = !app.cu.connected ? 'Circuit non connecté' : live ? `● ${live} voiture${live > 1 ? 's' : ''} en piste` : 'Fais rouler une voiture pour la détecter';
}
