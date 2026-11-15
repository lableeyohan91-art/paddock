// Course rapide : préparation en un écran.
// Participants (manettes, pilote, voiture), nombre de tours, essence
// (activée ou non, setup, réservoir commun à toutes les voitures).
// Jamais de météo ni de pneus ici : c'est voulu.

import { esc, $, $$, toast, promptBox } from '../ui.js';
import { avatar } from './drivers.js';

let app;
let root;
let prefs = null; // dernières valeurs choisies
let setups = [];
let activeSetup = null;

const MIN_CHIPS = [1, 2, 5, 10];                     // essais libres, qualification (minutes)
const PQ_LAP_CHIPS = [3, 5, 10, 20];                 // essais libres, qualification (tours)
const RACE_MIN_CHIPS = [5, 10, 30, 60];              // course au temps (endurance), minutes
const RACE_LAP_CHIPS = [20, 30, 50, 75, 100];     // course, course rapide
export const START_MSG = "* Il peut être nécessaire d'appuyer sur le bouton START de votre Control Unit pour lancer la course.";
export const PLACE_CARS_MSG = "* Les réglages doivent s'effectuer avec l'ensemble des voitures déjà posées sur votre piste.";

export async function mount(main, a) {
  app = a;
  root = main;
  // participants par défaut (2 en course, 1 en essais libres / qualification), seulement si le
  // circuit n'est pas connecté : connecté, on peut partir de 0 et chaque voiture qui passe la ligne s'ajoute
  const min = mode().type === 'race' ? 2 : 1;
  if (!app.cu.connected && app.setup.slots.filter((s) => s.active).length < min) {
    app.setup.slots.slice(0, min).forEach((s) => (s.active = true));
    app.saveSetup();
  }
  if (!app.track(app.setup.trackId) && app.data.tracks[0]) { app.setup.trackId = app.data.tracks[0].id; app.saveSetup(); }
  prefs = { laps: 30, minutes: 5, pqByLaps: false, pqLaps: 5, raceByTime: false, raceMinutes: 10, fuelOn: true, tank15: 15, autoVsc: true, tyresOn: false, ...(await app.db.getSetting('quickRace', {})) };
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

const MODES = {
  quick: { title: '⚡ Course rapide', type: 'race' },
  race: { title: '🏁 Course', type: 'race' },
  practice: { title: '🛞 Essais libres', type: 'practice' },
  qualifying: { title: '⏱️ Qualification', type: 'qualifying' },
};
const mode = () => MODES[app.quickMode || app.setup?.prepMode] || MODES.quick;
const title = () => mode().title;
const isRace = () => mode().type === 'race';
const savePrefs = () => app.db.setSetting('quickRace', prefs);
const pct15 = (v) => Math.round((v / 15) * 100);
/** Calcul « selon le temps au tour » : réservoir bloqué à 100 %. */
const tankLocked = () => app.fuelCfg.mode === 'bands';
const tank15 = () => (tankLocked() ? 15 : prefs.tank15);

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
      <button class="btn small ghost" id="qBack">← Menu</button>
      <h1 class="menu-title" style="margin:0">${title()}</h1>
      <span style="width:80px"></span>
    </div>

    <section class="panel q-track">
      <label class="row" style="gap:10px;flex-wrap:wrap">
        <h2 style="margin:0">📍 Circuit</h2>
        <select id="qTrack" style="flex:1;min-width:160px">
          ${app.data.tracks.map((t) => `<option value="${esc(t.id)}" ${t.id === app.setup.trackId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
        </select>
        <button class="btn small ghost" id="qTrackAdd" title="Ajouter un circuit">＋ Nouveau</button>
      </label>
      <p class="muted" style="margin:6px 0 0;font-size:.8rem">Les tours, records et statistiques de la séance seront rangés sur ce circuit.</p>
    </section>

    <section class="panel" style="margin-top:14px">
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
      ${isRace() ? `
      <div class="row" style="justify-content:space-between;margin-bottom:10px">
        <h2 style="margin:0">2. ${prefs.raceByTime ? 'Durée' : 'Nombre de tours'}</h2>
        <button class="btn small ghost" id="qUnit" title="Changer entre nombre de tours et durée">⇄ ${prefs.raceByTime ? 'Passer en tours' : 'Passer en durée'}</button>
      </div>
      ${prefs.raceByTime ? `
      <div class="q-laps">
        ${RACE_MIN_CHIPS.map((m) => `<button class="chip ${prefs.raceMinutes === m ? 'on' : ''}" data-rmin="${m}">${m} min</button>`).join('')}
        <input type="number" id="qRMin" min="1" max="600" value="${prefs.raceMinutes}" aria-label="Durée en minutes">
        <span class="muted">min</span>
      </div>` : `
      <div class="q-laps">
        ${RACE_LAP_CHIPS.map((l) => `<button class="chip ${prefs.laps === l ? 'on' : ''}" data-laps="${l}">${l}</button>`).join('')}
        <input type="number" id="qLaps" min="1" max="999" value="${prefs.laps}" aria-label="Nombre de tours">
      </div>`}` : `
      <div class="row" style="justify-content:space-between;margin-bottom:10px">
        <h2 style="margin:0">2. ${prefs.pqByLaps ? 'Nombre de tours' : 'Durée'}</h2>
        <button class="btn small ghost" id="qUnit" title="Changer entre durée et nombre de tours">⇄ ${prefs.pqByLaps ? 'Passer en durée' : 'Passer en tours'}</button>
      </div>
      ${prefs.pqByLaps ? `
      <div class="q-laps">
        ${PQ_LAP_CHIPS.map((l) => `<button class="chip ${prefs.pqLaps === l ? 'on' : ''}" data-pqlaps="${l}">${l}</button>`).join('')}
        <input type="number" id="qPqLaps" min="1" max="999" value="${prefs.pqLaps}" aria-label="Nombre de tours">
        <span class="muted">tours</span>
      </div>` : `
      <div class="q-laps">
        ${MIN_CHIPS.map((m) => `<button class="chip ${prefs.minutes === m ? 'on' : ''}" data-min="${m}">${m} min</button>`).join('')}
        <input type="number" id="qMin" min="1" max="600" value="${prefs.minutes}" aria-label="Durée en minutes">
        <span class="muted">min</span>
      </div>`}`}
    </section>

    <section class="panel" style="margin-top:14px">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">3. Essence</h2>
        <label class="switch"><input type="checkbox" id="qFuel" ${prefs.fuelOn ? 'checked' : ''}><span></span> ${prefs.fuelOn ? 'Activée' : 'Désactivée'}</label>
      </div>
      ${prefs.fuelOn ? `
      <div class="q-fuel-mode">
        <span class="muted" style="font-size:.85rem">Calcul de la consommation</span>
        <div class="seg" id="qFuelMode">
          <button data-qfm="bands" class="${app.fuelCfg.mode === 'bands' ? 'on' : ''}">Selon le temps au tour</button>
          <button data-qfm="fixed" class="${app.fuelCfg.mode === 'fixed' ? 'on' : ''}">Fixe</button>
        </div>
        <span class="muted" style="font-size:.8rem">${app.fuelCfg.mode === 'fixed'
          ? `Chaque tour consomme ${String(app.fuelCfg.nominalPct).replace('.', ',')} % d'essence, quel que soit le temps. <a href="#" id="qFuelNom">Se change dans Réglages → Essence</a>.`
          : 'Plus on roule vite, plus on consomme (fourchettes de temps de référence).'}</span>
      </div>
      <div class="q-fuel">
        ${app.fuelCfg.mode === 'fixed' ? '' : `<label class="field"><span>Setup d'essence <button class="q-gear" id="qFuelCfg" title="Réglages essence">⚙</button></span>
          <select id="qSetup">${setups.length ? setups.map((s) => `<option value="${esc(s.id)}" ${s.id === activeSetup ? 'selected' : ''}>${esc(s.name)}</option>`).join('')
            : '<option value="">Réglage actuel</option>'}</select></label>`}
        <div>
          <div class="bar" style="--c:var(--blue);--p:${pct15(tank15())}%">
            <span class="bar-l">Réservoir</span>
            <input type="range" id="qTank" min="1" max="15" value="${tank15()}" ${tankLocked() ? 'disabled' : ''}>
            <span class="bar-v num" id="qTankV">${pct15(tank15())} %</span>
          </div>
          ${tankLocked() ? '<p class="muted" style="font-size:.8rem;margin:4px 0 0">🔒 Réservoir à 100 % : le calcul selon le temps au tour est réglé sur un plein. Toutes les voitures sont remises à 100 % au départ.</p>' : ''}
          <p class="muted" style="font-size:.8rem;margin:4px 0 0">Même réservoir pour toutes les voitures de la course.</p>
        </div>
      </div>` : '<p class="muted" style="margin:8px 0 0">Pas de consommation : les voitures roulent sans jamais s\'arrêter.</p>'}
      <p class="warn-note">${PLACE_CARS_MSG}</p>
    </section>

    ${isRace() ? `
    <section class="panel" style="margin-top:14px">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">4. VSC automatique</h2>
        <label class="switch"><input type="checkbox" id="qAutoVsc" ${prefs.autoVsc ? 'checked' : ''}><span></span> ${prefs.autoVsc ? 'Activé' : 'Désactivé'}</label>
      </div>
      <p class="muted" style="margin:8px 0 0;font-size:.85rem">${prefs.autoVsc
        ? 'Le VSC se déclenche (et se termine) tout seul selon les réglages de Réglages → VSC → VSC automatique.'
        : 'Course sans VSC automatique : seul le bouton VSC fonctionne.'}</p>
    </section>

    <section class="panel" style="margin-top:14px">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">5. Pneus</h2>
        <label class="switch"><input type="checkbox" id="qTyres" ${prefs.tyresOn ? 'checked' : ''}><span></span> ${prefs.tyresOn ? 'Activés' : 'Désactivés'}</label>
      </div>
      <p class="muted" style="margin:8px 0 0;font-size:.85rem">${prefs.tyresOn
        ? 'Usure, chauffe et changement au stand (Réglages → Pneus). Chaque pilote choisit sa gomme sur sa vue pilote, ou toi sur l\'écran de course.'
        : 'Course sans gestion des pneus.'}</p>
    </section>` : ''}

    <div class="q-go">
      <button class="depart" id="qStart">
        <span class="depart-lights"><i></i><i></i><i></i><i></i><i></i></span>
        <span class="depart-txt">DÉPART</span>
        <span class="depart-sub">${isRace() ? (prefs.raceByTime ? prefs.raceMinutes + ' min' : prefs.laps + ' tours') : prefs.pqByLaps ? prefs.pqLaps + ' tours' : prefs.minutes + ' min'} · ${n} pilote${n > 1 ? 's' : ''} · ${prefs.fuelOn ? `essence ${pct15(tank15())} %` : 'sans essence'}</span>
      </button>
    </div>
    <p class="warn-note q-start-note">${START_MSG}</p>
  </div>`;
  bind();
  tick();
}

function bind() {
  $('#qBack', root).onclick = () => { app.raceMenu = true; app.go('race'); };
  $('#qTrack', root).onchange = (e) => { app.setup.trackId = e.target.value; app.saveSetup(); toast('Circuit : ' + (app.track(e.target.value)?.name || ''), 1200); };
  $('#qTrackAdd', root).onclick = async () => {
    const name = await promptBox('Nouveau circuit', '', 'Ex. Circuit du salon, Grand ovale…');
    if (!name) return;
    const t = { id: app.db.uid(), name: name.trim().slice(0, 40), length: 0, created: Date.now() };
    await app.db.put('tracks', t);
    await app.loadData();
    app.setup.trackId = t.id;
    app.saveSetup();
    toast(`Circuit « ${t.name} » ajouté`);
    render();
  };

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
    app.saveSetup();
    app.applyTune(slot.address);
    render();
  };
  const gear = $('#qFuelCfg', root);
  if (gear) gear.onclick = (e) => { e.preventDefault(); app.openFuelSettings(); };
  const nomLink = $('#qFuelNom', root);
  if (nomLink) nomLink.onclick = (e) => { e.preventDefault(); app.openFuelSettings(); };

  $$('[data-laps]', root).forEach((b) => (b.onclick = () => { prefs.laps = +b.dataset.laps; savePrefs(); render(); }));
  const ql = $('#qLaps', root);
  if (ql) ql.onchange = (e) => { prefs.laps = Math.max(1, Math.min(999, parseInt(e.target.value, 10) || 1)); savePrefs(); render(); };
  $$('[data-min]', root).forEach((b) => (b.onclick = () => { prefs.minutes = +b.dataset.min; savePrefs(); render(); }));
  const qu = $('#qUnit', root);
  if (qu) qu.onclick = () => {
    if (isRace()) prefs.raceByTime = !prefs.raceByTime; else prefs.pqByLaps = !prefs.pqByLaps;
    savePrefs(); render();
  };
  $$('[data-rmin]', root).forEach((b) => (b.onclick = () => { prefs.raceMinutes = +b.dataset.rmin; savePrefs(); render(); }));
  const qrm = $('#qRMin', root);
  if (qrm) qrm.onchange = (e) => { prefs.raceMinutes = Math.max(1, Math.min(600, parseInt(e.target.value, 10) || 1)); savePrefs(); render(); };
  $$('[data-pqlaps]', root).forEach((b) => (b.onclick = () => { prefs.pqLaps = +b.dataset.pqlaps; savePrefs(); render(); }));
  const qpl = $('#qPqLaps', root);
  if (qpl) qpl.onchange = (e) => { prefs.pqLaps = Math.max(1, Math.min(999, parseInt(e.target.value, 10) || 1)); savePrefs(); render(); };
  const qm = $('#qMin', root);
  if (qm) qm.onchange = (e) => { prefs.minutes = Math.max(1, Math.min(600, parseInt(e.target.value, 10) || 1)); savePrefs(); render(); };

  $('#qFuel', root).onchange = (e) => { prefs.fuelOn = e.target.checked; savePrefs(); render(); };
  // calcul de la consommation : même réglage que dans Réglages → Essence
  $$('[data-qfm]', root).forEach((b) => (b.onclick = async () => {
    await app.saveFuelCfg({ ...app.fuelCfg, mode: b.dataset.qfm });
    render();
  }));
  const av = $('#qAutoVsc', root);
  if (av) av.onchange = (e) => { prefs.autoVsc = e.target.checked; savePrefs(); render(); };
  const ty = $('#qTyres', root);
  if (ty) ty.onchange = (e) => { prefs.tyresOn = e.target.checked; savePrefs(); render(); };
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
    // Départ : on prépare la séance et on passe à l'écran de course ; le lancement se fait avec GO
    const pqLaps = !isRace() && prefs.pqByLaps;
    await app.prepareQuickRace({ laps: pqLaps ? prefs.pqLaps : prefs.laps, fuelOn: prefs.fuelOn, tank15: tank15(), title: title(), type: mode().type, kind: app.quickMode || app.setup?.prepMode || 'quick', autoVsc: prefs.autoVsc, tyresOn: isRace() && prefs.tyresOn, minutes: isRace() ? (prefs.raceByTime ? prefs.raceMinutes : 0) : pqLaps ? 0 : prefs.minutes });
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
  if (l) l.textContent = !app.cu.connected ? 'Circuit non connecté' : live ? `● ${live} voiture${live > 1 ? 's' : ''} en piste` : 'Passe la ligne avec une voiture : elle s\'ajoute toute seule';
}
