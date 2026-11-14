// Écran de course en direct : feux, chrono, classement, météo, contrôles.

import { esc, $, $$, modal, confirmBox } from '../ui.js';
import { TYPES, fmtTime, fmtClock } from '../race.js';
import { SKY } from '../weather.js';
import { MODE } from '../cu/protocol.js';
import { avatar } from './drivers.js';

let app;
let root;
const flashes = new Map(); // address -> instant du dernier tour
let lastSig = '';

export function mount(main, a) {
  app = a;
  root = main;
  lastSig = '';
  lastState = null;
  if (!app.session || app.raceMenu) {
    renderMenu();
    return;
  }
  const s = app.session;
  root.innerHTML = `
    <div class="race-head">
      <div>
        <div class="race-title">${s.cfg.quick ? esc(s.cfg.title || '⚡ Course rapide') : esc(TYPES[s.cfg.type])} <span class="muted" style="font-weight:500;font-size:1rem">· ${esc(app.track(s.trackId)?.name || '')}</span></div>
        <div class="muted" id="raceFormat"></div>
      </div>
      <span class="race-state" id="raceState"></span>
      <div class="spacer"></div>
      <div style="text-align:right">
        <div class="clock num" id="clock">0:00</div>
        <div class="lapcount num" id="lapCount"></div>
      </div>
    </div>
    <div class="flagbar idle" id="flagbar"></div>
    <div class="race-layout">
      <div>
        <div class="panel" id="lightsPanel">
          <button class="home-btn" id="bHome" title="Quitter la session et revenir au menu" aria-label="Quitter la session et revenir au menu">🏠</button>
          <div class="lights" id="lights">${'<div class="light"></div>'.repeat(5)}</div>
          <div class="controls" style="justify-content:center;margin:0" id="controls"></div>
        </div>
        <div class="panel" style="margin-top:16px;padding:8px 8px 4px;overflow-x:auto">
          <table class="board" id="board"></table>
        </div>
      </div>
      <aside class="side">
        <section class="panel ${s.cfg.quick ? 'hidden' : ''}">
          <h2>Météo</h2>
          <div class="sky-buttons" id="skyLive">
            ${Object.entries(SKY).map(([k, v]) => `<button data-sky="${k}">${v.icon}<span>${v.label}</span></button>`).join('')}
          </div>
          <div class="row" style="justify-content:space-between;margin:12px 0 6px">
            <span id="trackLabel"></span><span class="muted num" id="wetPct"></span>
          </div>
          <div class="meter"><i id="wetBar" style="width:0"></i></div>
          <p class="muted" id="wEffect" style="margin:8px 0 0;font-size:.85rem"></p>
          <label class="row" style="margin-top:10px"><input type="checkbox" id="wDynLive"> Météo dynamique</label>
          <p class="muted" id="forecast" style="margin:6px 0 0;font-size:.85rem"></p>
        </section>
        <section class="panel" id="simPanel">
          <h2>Simulateur</h2>
          <p class="muted" style="margin-top:-6px;font-size:.85rem">Envoie une voiture virtuelle au stand (ravitaillement).</p>
          <div class="row" id="simPits"></div>
        </section>
      </aside>
    </div>`;

  $$('#skyLive button', root).forEach((b) => (b.onclick = () => app.weather.setSky(b.dataset.sky)));
  $('#wDynLive', root).onchange = (e) => app.weather.setDynamic(e.target.checked);
  const board = $('#board', root);
  const openSwap = (e) => {
    if (e.type === 'click' && e.target.closest('[data-gofuel]')) { app.openFuelSettings(); return; }
    const el = e.target.closest('[data-swap]');
    if (el && (e.type === 'click' || e.key === 'Enter')) swapDialog(+el.dataset.swap);
  };
  board.addEventListener('click', openSwap);
  board.addEventListener('keydown', openSwap);
  $('#bHome', root).onclick = () => app.quitToMenu();
  renderControls();
  tick();
}

/** Menu de l'onglet Course : choix du type de course. */
function renderMenu() {
  const s = app.session;
  const last = s && s.state === 'finished';
  root.innerHTML = `
  <div class="race-menu">
    <h1 class="menu-title">Menu</h1>
    <div class="menu-grid">
      <button class="menu-tile" data-go="practice"><span class="menu-ico">🛞</span><span class="menu-name">Essais libres</span></button>
      <button class="menu-tile" data-go="qualifying"><span class="menu-ico">⏱️</span><span class="menu-name">Qualification</span></button>
      <button class="menu-tile quick" data-go="quick"><span class="menu-ico">⚡</span><span class="menu-name">Course rapide</span></button>
      <button class="menu-tile" data-go="race"><span class="menu-ico">🏁</span><span class="menu-name">Course</span></button>
    </div>
    ${last ? '<button class="btn ghost" id="mLast" style="margin-top:16px">↩ Revoir la dernière session</button>' : ''}
  </div>`;
  root.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => {
    const t = b.dataset.go;
    // les 4 modes partagent le même écran de préparation pour l'instant
    // mode mémorisé dans le setup (synchronisé) : tous les appareils connectés le respectent
    app.quickMode = t;
    app.setup.prepMode = t;
    app.saveSetup();
    app.go('quick');
  }));
  const l = $('#mLast', root);
  if (l) l.onclick = () => { app.raceMenu = false; app.go('race'); };
}

export function unmount() {
  root = null;
}

function stateLabel(s) {
  return {
    ready: 'Prêt', armed: 'Feux', running: s.cfg.type === 'race' ? 'En course' : 'En piste',
    finishing: 'Dernier tour', finished: 'Terminé',
  }[s.state];
}

function renderControls() {
  if (!root) return;
  const s = app.session;
  const el = $('#controls', root);
  const connected = app.cu.connected;
  let html = '';
  if (s.state === 'ready') {
    // Précédent à gauche, GO au milieu, Garage à droite
    html += `<div class="go-row">
      <button class="btn ghost" id="bEdit">← Précédent</button>
      <button class="btn go big" id="bStart">${s.cfg.start === 'lights' ? 'GO' : '▶ Démarrer'}</button>
      <button class="btn" id="bGarage" title="Régler les voitures sans arrêter la session">🔧 Garage</button>
    </div>`;
    if (!connected) html += `<button class="btn big" id="bConn">Connecter le circuit</button>`;
  }
  if (['running', 'finishing'].includes(s.state)) {
    html += `<button class="btn ${s.flag === 'yellow' ? 'go' : 'yellow'} big" id="bYellow">${s.flag === 'yellow' ? '🟢 Drapeau vert' : '🟡 Drapeau jaune'}</button>`;
    html += s.flag === 'red'
      ? `<button class="btn go big" id="bRed" ${s.redResuming ? 'disabled' : ''}>${s.redResuming ? '🚦 Reprise en cours…' : '🟢 Reprendre la course'}</button>`
      : `<button class="btn red icon-sq" id="bRed" title="Drapeau rouge : arrête toutes les voitures" aria-label="Drapeau rouge">🚩</button>`;
    html += `<button class="btn" id="bStop">🏁 Terminer</button>`;
  }
  if (['armed', 'running', 'finishing'].includes(s.state)) {
    html += `<button class="btn" id="bGarage" title="Régler les voitures sans arrêter la session">🔧 Garage</button>`;
  }
  if (s.state === 'finished') {
    html += `<button class="btn primary big" id="bAgain">↻ ${s.cfg.quick && s.cfg.type === 'race' ? 'Relancer la même course' : 'Relancer la même session'}</button>`;
    html += `<button class="btn" id="bResults">Résultats</button>`;
    html += `<button class="btn" id="bSetup">🏠 Menu course</button>`;
  }
  el.innerHTML = html;
  const on = (id, fn) => { const b = $('#' + id, el); if (b) b.onclick = fn; };
  on('bStart', () => app.startSession());
  on('bConn', () => app.openConnectDialog());
  on('bYellow', () => { app.toggleYellow(); renderControls(); });
  on('bRed', async () => { await app.toggleRed(); renderControls(); });
  on('bStop', async () => { if (await confirmBox('Terminer la session maintenant ?')) s.stop(); });
  on('bAgain', () => app.prepareSession(app.lastPrepare || {}));
  on('bResults', () => showResults(app));
  on('bSetup', () => { app.raceMenu = true; app.go('race'); });
  on('bEdit', () => app.go('quick'));
  on('bGarage', () => app.go('garage'));
}

export function flashRow(address) {
  flashes.set(address, performance.now());
}

/** Jauge d'essence simulée : barre + pourcentage, réservoir du garage en repère. */
function fuelCell(c) {
  if (c.fuelPct === null || c.fuelPct === undefined) return '';
  const pct = Math.round(c.fuelPct);
  const warn = app.fuelCfg.lowWarnPct;
  const cls = pct <= 0 ? 'empty' : pct <= warn ? 'low' : pct <= warn * 2.5 ? 'mid' : '';
  const used = c.lastFuelUse ? ` · dernier tour −${c.lastFuelUse} % (${c.lastFuelBand})` : '';
  return `<div class="fuelg ${cls}${c.inPit && pct < c.tankPct ? ' refuel' : ''}" title="Réservoir ${c.tankPct} %${used}">
    <div class="fuelg-bar"><i style="width:${Math.min(100, pct)}%"></i>${c.tankPct < 100 ? `<b style="left:${c.tankPct}%"></b>` : ''}</div>
    <span class="num">${pct <= 0 ? 'À SEC' : pct + ' %'}</span></div>`;
}

function sectorsCell(c, s) {
  const list = c.sectors.length ? c.sectors : c.lastSectors;
  if (!list.length) return '';
  return `<div class="sectors">${list.map((t, i) => {
    const cls = t === s.bestSectors[i] ? 'overall' : t === c.bestSectors[i] ? 'best' : '';
    return `<span class="sector num ${cls}">${fmtTime(t, 2)}</span>`;
  }).join('')}</div>`;
}

function renderBoard() {
  const s = app.session;
  const list = s.order.length ? s.order : [...s.comps.values()];
  const hasSectors = list.some((c) => c.lastSectors.length || c.sectors.length);
  const fuelMode = app.fuelOn();
  const now = performance.now();
  const isRace = s.cfg.type === 'race';

  const head = `<tr>
    <th>P</th><th>Pilote</th><th>Tours</th><th>Dernier</th><th class="hide-sm">Meilleur</th>
    <th class="hide-sm">${isRace ? 'Écart' : 'Écart'}</th>
    ${hasSectors ? '<th class="hide-sm">Secteurs</th>' : ''}
    ${fuelMode ? '<th><button class="th-link" data-gofuel title="Régler la consommation">Essence ⚙</button></th>' : ''}
    <th></th></tr>`;

  const rows = list.map((c) => {
    const flash = now - (flashes.get(c.address) || 0) < 1200;
    const lastCls = c.lastLap && c.lastLap === s.overallBest?.time ? 't-overall' : c.lastLap && c.lastLap === c.bestLap ? 't-best' : '';
    const bestCls = c.bestLap && c.bestLap === s.overallBest?.time ? 't-overall' : '';
    const badge = c.finished ? '<span class="badge fin">🏁</span>' : c.inPit ? '<span class="badge pit">STAND</span>' : '';
    return `<tr class="${flash ? 'flash' : ''}">
      <td class="pos num">${c.lastTs === null && !c.bestLap ? '–' : c.position}</td>
      <td><div class="driver swappable" data-swap="${c.address}" title="Toucher pour changer de pilote ou de voiture" role="button" tabindex="0">
        <span class="mini-av" style="--dc:${esc(c.driver.color)}">${avatar(c.driver, 'mini')}</span>
        <div><div class="driver-name">${esc(c.driver.name)} <span class="swap-ico">⇄</span></div><div class="driver-car">#${c.address + 1} · ${esc(c.car.name)}${c.pitStops ? ` · ${c.pitStops} arrêt${c.pitStops > 1 ? 's' : ''}` : ''}</div></div></div></td>
      <td class="num t-big">${c.laps}</td>
      <td class="num"><div class="t-big ${lastCls}">${fmtTime(c.lastLap)}</div><div class="show-sm ${bestCls}" style="font-size:.8rem">${c.bestLap ? '★ ' + fmtTime(c.bestLap) : ''}</div></td>
      <td class="num hide-sm ${bestCls}">${fmtTime(c.bestLap)}</td>
      <td class="num hide-sm">${esc(c.gap)}</td>
      ${hasSectors ? `<td class="hide-sm">${sectorsCell(c, s)}</td>` : ''}
      ${fuelMode ? `<td>${fuelCell(c)}</td>` : ''}
      <td>${badge}</td>
    </tr>`;
  }).join('');

  const html = head + rows;
  if (html !== lastSig) {
    $('#board', root).innerHTML = html;
    lastSig = html;
  }
}

function renderLights() {
  const s = app.session;
  const st = app.cu.status?.start ?? 0;
  const el = $('#lights', root);
  let on = 0;
  if (s.state === 'armed') {
    if (st >= 2 && st <= 6) on = st - 1;
    else if (st === 7) on = 5;
  }
  el.classList.toggle('ready', s.state === 'armed' && st === 1);
  $$('.light', el).forEach((l, i) => l.classList.toggle('on', on > i || (s.state === 'armed' && st === 1)));
  $('#lightsPanel .lights', root).style.display = s.cfg.start === 'lights' && ['ready', 'armed'].includes(s.state) ? '' : 'none';
}

let lastState = null;
let lastFlag = null;
let lastConn = null;

export function tick() {
  // rien à rafraîchir quand l'onglet affiche le menu (pas d'écran de séance)
  if (!root || !app.session || !$('#controls', root)) return;
  const s = app.session;

  if (s.state !== lastState || s.flag !== lastFlag || app.cu.connected !== lastConn) {
    lastState = s.state;
    lastFlag = s.flag;
    lastConn = app.cu.connected;
    renderControls();
    const st = $('#raceState', root);
    st.textContent = stateLabel(s);
    st.className = 'race-state ' + s.state;
  }

  // Chrono
  const rem = s.remainingMs;
  $('#clock', root).textContent = rem !== null && s.state !== 'ready' ? fmtClock(rem) : fmtClock(s.elapsedMs);
  const fmt = s.cfg.type === 'race'
    ? (s.cfg.mode === 'time' ? `Course de ${s.cfg.duration} min` : `Course de ${s.cfg.laps} tours`)
    : s.lapLimited ? `${s.cfg.laps} tours par pilote` : (s.cfg.duration ? `${s.cfg.duration} min` : 'Durée libre');
  $('#raceFormat', root).textContent = fmt + (app.isSim ? ' · 🎮 simulateur, non enregistré' : '');
  $('#lapCount', root).textContent = s.cfg.type === 'race' && s.cfg.mode !== 'time'
    ? `Tour ${Math.min(s.leaderLaps + (s.state === 'running' ? 1 : 0), s.cfg.laps)} / ${s.cfg.laps}`
    : (s.overallBest ? `Meilleur : ${fmtTime(s.overallBest.time)}` : '');

  // Drapeau
  const fb = $('#flagbar', root);
  fb.className = 'flagbar ' + (s.state === 'finishing' || s.state === 'finished' ? 'chequered'
    : s.flag === 'red' ? 'red' : s.flag === 'yellow' ? 'yellow' : s.state === 'running' ? '' : 'idle');

  renderLights();
  renderBoard();

  // Météo
  const w = app.weather;
  $$('#skyLive button', root).forEach((b) => b.classList.toggle('on', b.dataset.sky === w.sky));
  $('#trackLabel', root).textContent = w.trackLabel;
  $('#wetPct', root).textContent = Math.round(w.wetness * 100) + ' %';
  $('#wetBar', root).style.width = Math.round(w.wetness * 100) + '%';
  const f = w.factors();
  $('#wEffect', root).textContent = w.wetness > 0.01
    ? `Vitesse ×${f.speed.toFixed(2)} · Freinage ×${f.brake.toFixed(2)}`
    : 'Aucun effet sur les voitures';
  $('#wDynLive', root).checked = w.dynamic;
  $('#forecast', root).textContent = w.dynamic ? 'Prévision : ' + (w.forecastText() || '—') : '';

  // Simulateur
  const sim = app.isSim;
  $('#simPanel', root).classList.toggle('hidden', !sim);
  if (sim) {
    const pits = $('#simPits', root);
    const sig = [...s.comps.keys()].join(',') + [...s.comps.values()].map((c) => c.inPit).join('');
    if (pits.dataset.sig !== sig) {
      pits.dataset.sig = sig;
      pits.innerHTML = [...s.comps.values()].map((c) =>
        `<button class="btn small ${c.inPit ? 'go' : ''}" data-pit="${c.address}">#${c.address + 1} ${c.inPit ? 'Sortir' : 'Stand'}</button>`).join('');
      $$('[data-pit]', pits).forEach((b) => (b.onclick = () => {
        const a = +b.dataset.pit;
        const comp = s.comps.get(a);
        app.cu.conn.pit(a, !comp.inPit);
      }));
    }
  }
}

export function refresh() {
  if (root) { lastConn = null; tick(); }
}

/** Changer le pilote et/ou la voiture d'une manette, pendant la session. */
function swapDialog(address) {
  const s = app.session;
  const slot = app.setup.slots[address];
  const comp = s.comps.get(address);
  let driverId = slot.driverId ?? comp?.driver.id ?? null;
  let carId = slot.carId ?? comp?.car.id ?? null;
  const startDriver = driverId;
  // pilotes déjà sur une autre manette de la session
  const busy = new Map();
  for (const c of s.comps.values()) if (c.address !== address && c.driver.id) busy.set(c.driver.id, c.address);
  const carBusy = new Map();
  for (const c of s.comps.values()) if (c.address !== address && c.car.id) carBusy.set(c.car.id, c.address);

  const resetNote = s.cfg.type === 'race'
    ? 'En course, le nouveau pilote reprend les tours et la position de la manette (relais).'
    : 'Le nouveau pilote repart avec son propre chrono. Les tours du pilote précédent restent dans ses statistiques.';

  const m = modal(`
    <h2>Manette ${address + 1}</h2>
    <h3 style="margin-top:4px">Pilote</h3>
    <div class="pick-grid" id="pickDrivers">
      ${app.data.drivers.map((d) => `
      <button class="pick ${d.id === driverId ? 'on' : ''}" data-d="${esc(d.id)}" style="--dc:${esc(d.color)}">
        <span class="pick-av">${avatar(d)}</span>
        <span class="pick-name">${esc(d.name)}</span>
        ${busy.has(d.id) ? `<span class="pick-busy">manette ${busy.get(d.id) + 1}</span>` : ''}
      </button>`).join('')}
    </div>
    <h3>Voiture</h3>
    <div class="pick-cars" id="pickCars">
      ${app.data.cars.map((c) => `
      <button class="pick-car ${c.id === carId ? 'on' : ''}" data-c="${esc(c.id)}">${esc(c.name)}${carBusy.has(c.id) ? ` <small class="muted">· manette ${carBusy.get(c.id) + 1}</small>` : ''}</button>`).join('')}
    </div>
    <p class="muted" id="swapNote" style="font-size:.85rem;margin:12px 0 0"></p>
    <div class="row" style="justify-content:flex-end;margin-top:14px">
      <button class="btn ghost" data-close>Annuler</button>
      <button class="btn primary" id="swapOk">Valider</button>
    </div>`);
  const el = m.el;
  const sync = () => {
    $$('[data-d]', el).forEach((b) => b.classList.toggle('on', b.dataset.d === driverId));
    $$('[data-c]', el).forEach((b) => b.classList.toggle('on', b.dataset.c === carId));
    const t = app.getTune(driverId, carId);
    const p = (v) => Math.round((v / 15) * 100);
    $('#swapNote', el).innerHTML = (driverId && carId
      ? `Réglage garage appliqué : <span style="color:var(--green)">accél. ${p(t.speed)} %</span> · <span style="color:var(--accent-2)">frein ${p(t.brake)} %</span>${t.saved ? '' : ' (par défaut)'}<br>`
      : '') + (driverId !== startDriver && s.state !== 'ready' && s.state !== 'finished' ? resetNote : '');
  };
  $$('[data-d]', el).forEach((b) => (b.onclick = () => { driverId = b.dataset.d; sync(); }));
  $$('[data-c]', el).forEach((b) => (b.onclick = () => { carId = b.dataset.c; sync(); }));
  $('#swapOk', el).onclick = async () => {
    m.close();
    await app.swapEntry(address, driverId, carId);
    lastSig = '';
    tick();
  };
  sync();
}

export function showResults(a) {
  app = a;
  const s = app.session;
  if (!s) return;
  const res = s.results().filter((r) => r.laps > 0 || r.bestLap);
  const isRace = s.cfg.type === 'race';
  const top = res.slice(0, 3);
  const pod = [top[1], top[0], top[2]].map((r, i) => r ? `
    <div class="p${[2, 1, 3][i]}"><b>${[2, 1, 3][i]}</b>${esc(r.driverName)}<br><small>${isRace ? r.laps + ' tours' : fmtTime(r.bestLap)}</small></div>` : '').join('');
  modal(`
    <h2>🏁 Résultats — ${esc(TYPES[s.cfg.type])}</h2>
    ${res.length ? `<div class="podium">${pod}</div>` : '<p class="muted">Aucun tour enregistré.</p>'}
    <table class="simple">
      <tr><th>P</th><th>Pilote</th><th>Tours</th><th>Meilleur</th>${isRace ? '<th>Écart</th>' : ''}</tr>
      ${res.map((r) => `<tr><td>${r.position}</td><td>${esc(r.driverName)}<br><small class="muted">${esc(r.carName)}</small></td>
        <td class="num">${r.laps}</td><td class="num">${fmtTime(r.bestLap)}</td>${isRace ? `<td class="num">${esc(r.gap)}</td>` : ''}</tr>`).join('')}
    </table>
    <p class="muted" style="font-size:.85rem">${(s.simulated ?? app.isSim) ? '🎮 Session simulée : non enregistrée dans les statistiques.' : 'Session enregistrée dans les statistiques.'}</p>
    <div class="row" style="justify-content:flex-end"><button class="btn primary" data-close>Fermer</button></div>`);
}
