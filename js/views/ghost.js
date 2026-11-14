// Onglet Voiture fantôme : une voiture qui roule seule (adresse "autonome" de la CU).
// On la programme sur la Control Unit, on la règle ici (garage dédié),
// puis Start / Stop. Son chrono s'affiche en direct : pratique pour les tests.

import { esc, $, $$, confirmBox, toast } from '../ui.js';
import { fmtTime } from '../race.js';
import { BUTTON, cmdPress } from '../cu/protocol.js';

let app;
let root;

const pct = (v) => Math.round((v / 15) * 100);
const BARS = [
  { k: 'speed', label: 'Vitesse', color: 'var(--green)' },
  { k: 'brake', label: 'Freinage', color: 'var(--accent-2)' },
];

export function mount(main, a) {
  app = a;
  root = main;
  render();
}

export function unmount() {
  root = null;
}

export function refresh() {
  if (root && app.view === 'ghost') render();
}

function render() {
  const g = app.ghost.settings;
  const connected = app.cu.connected;
  const racing = app.isRacing;
  root.innerHTML = `
  <div class="ghost-wrap">
    <section class="panel ghost-hero">
      <div class="ghost-icon">👻</div>
      <div style="flex:1;min-width:200px">
        <h2 style="margin:0">Voiture fantôme</h2>
        <p class="muted" style="margin:4px 0 0">Une voiture qui tourne toute seule, sans manette. Idéal pour tester la piste, les capteurs ou les réglages.</p>
      </div>
      <div class="ghost-state" id="gState"></div>
    </section>

    <div class="grid grid-2" style="margin-top:16px">
      <section class="panel">
        <h2>1. Programmer la voiture (une fois)</h2>
        <ol class="steps">
          <li>Pose <b>la voiture seule</b> sur la piste, circuit allumé.</li>
          <li>Appuie sur <b>Programmer le fantôme</b> ci-dessous : l'appli appuie <b>2 fois sur CODE</b> → <b>2 LED</b> s'allument sur la Control Unit.</li>
          <li>Prends une manette et appuie <b>une fois</b> sur son <b>bouton de changement de voie</b> : les phares de la voiture clignotent, les LED de la Control Unit s'allument l'une après l'autre.</li>
          <li>Quand <b>seule la LED du milieu</b> reste allumée, roule avec la manette à une <b>vitesse constante</b>, sans sortir de la piste et <b>sans changer de voie</b> : c'est cette vitesse que le fantôme gardera.</li>
          <li>Quand la vitesse te convient, appuie <b>à nouveau sur le bouton de changement de voie</b>. C'est enregistré : la voiture roule seule.</li>
        </ol>
        <button class="btn primary" id="gCode" ${connected && !racing ? '' : 'disabled'}>👻 Programmer le fantôme (CODE × 2)</button>
        <p class="muted" style="font-size:.8rem;margin:10px 0 0">Pour lui rendre une manette plus tard : programme-la comme d'habitude (CODE puis bouton de la manette).<br>Source : <a href="https://www.smartrace.de/en/the-smartrace-manual/tipps-tricks/program-ghost-car-for-carrera-digital/" target="_blank" rel="noopener">guide SmartRace</a>.</p>
      </section>

      <section class="panel">
        <h2>2. Vitesse du fantôme</h2>
        <p style="margin-top:-4px">Sa vitesse est <b>celle à laquelle tu l'as fait rouler</b> pendant la programmation (étape 4). Pour la changer, reprogramme-le à une autre vitesse.</p>
        <details class="ghost-exp">
          <summary>Essai : régler depuis l'appli (expérimental)</summary>
          <p class="muted" style="font-size:.8rem">Envoie un réglage vitesse / freinage à l'adresse du fantôme. Rien ne garantit que la Control Unit en tienne compte : si la voiture ne change pas d'allure, c'est qu'elle l'ignore.</p>
        <div class="ghost-bars">
          ${BARS.map((b) => `
          <div class="bar" style="--c:${b.color};--p:${pct(g[b.k])}%">
            <span class="bar-l">${b.label}</span>
            <input type="range" min="0" max="15" step="1" value="${g[b.k]}" data-bar="${b.k}" aria-label="${b.label}">
            <span class="bar-v num">${pct(g[b.k])} %</span>
          </div>`).join('')}
        </div>
        </details>
      </section>
    </div>

    <section class="panel" style="margin-top:16px">
      <h2>3. Départ</h2>
      <div class="row" style="gap:10px">
        <button class="btn go big" id="gStart" ${connected && !racing ? '' : 'disabled'}>▶ Start</button>
        <button class="btn big" id="gStop" ${connected && !racing ? '' : 'disabled'}>⏹ Stop</button>
        <button class="btn ghost" id="gReset">↺ Remettre le chrono à zéro</button>
      </div>
      <p class="muted" style="font-size:.85rem;margin:10px 0 0">
        ${!connected ? 'Connecte le circuit (ou le simulateur) pour démarrer le fantôme.'
          : racing ? 'Une session est en cours : Start / Stop sont désactivés pour ne pas la perturber.'
            : 'Une fois programmé, le fantôme roule tout seul. <b>Stop</b> l\'arrête comme le bouton START de la Control Unit (les 5 LED rouges s\'allument) ; <b>Start</b> relance la séquence des feux et il repart.'}
      </p>
    </section>

    <section class="panel" style="margin-top:16px">
      <h2>Chrono du fantôme</h2>
      <div id="gTiming"></div>
    </section>
  </div>`;
  bind();
  tick();
  renderTiming();
}

let timers = {};
function bind() {
  const g = app.ghost.settings;
  $$('[data-bar]', root).forEach((range) => {
    range.addEventListener('input', () => {
      const k = range.dataset.bar;
      const v = +range.value;
      const bar = range.parentElement;
      bar.style.setProperty('--p', pct(v) + '%');
      bar.querySelector('.bar-v').textContent = pct(v) + ' %';
      clearTimeout(timers[k]);
      timers[k] = setTimeout(() => app.saveGhost({ [k]: v }), 150);
    });
  });
  $('#gCode', root).onclick = async () => {
    // 2 appuis sur CODE, comme sur la Control Unit
    await app.cu.send(codeCmd());
    await new Promise((r) => setTimeout(r, 400));
    await app.cu.send(codeCmd());
    toast('CODE × 2 envoyé : 2 LED doivent être allumées. Étape suivante : bouton de changement de voie de la manette.', 6000);
    app.log('Fantôme : programmation lancée (CODE × 2)');
  };
  $('#gStart', root).onclick = async () => {
    app.resetGhostTiming();
    await app.cu.pressStart();
    // certaines CU demandent un 2e appui pour lancer la séquence des feux
    setTimeout(() => { if (app.cu.status?.start === 1) app.cu.pressStart(); }, 1500);
    toast('👻 Feux lancés : le fantôme repart au vert');
    app.log('Fantôme : départ (START)');
  };
  $('#gStop', root).onclick = async () => {
    // d'après le guide SmartRace : le fantôme s'arrête via le bouton START (5 LED rouges)
    await app.cu.pressStart();
    toast('⏹ Fantôme arrêté (START)');
    app.log('Fantôme : arrêt (START)');
  };
  $('#gReset', root).onclick = async () => {
    if (!app.ghost.laps.length || await confirmBox('Effacer le chrono du fantôme ?')) {
      app.resetGhostTiming();
      renderTiming();
    }
  };
}

const codeCmd = () => cmdPress(BUTTON.CODE);

const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const std = (a) => { const m = avg(a); return Math.sqrt(avg(a.map((x) => (x - m) ** 2))); };

function renderTiming() {
  const el = root && $('#gTiming', root);
  if (!el) return;
  const g = app.ghost;
  const laps = g.laps;
  if (!laps.length) {
    el.innerHTML = `<p class="muted">${g.lastTs !== null ? 'Premier passage enregistré : le chrono tourne…' : 'Aucun tour pour le moment. Ses tours s\'afficheront ici dès qu\'il passera sur la ligne.'}</p>`;
    return;
  }
  const best = Math.min(...laps);
  const last = laps[laps.length - 1];
  const recent = laps.slice(-10).reverse();
  el.innerHTML = `
    <div class="stat-cards">
      <div class="stat"><div class="l">Tours</div><div class="v num">${laps.length}</div></div>
      <div class="stat"><div class="l">Dernier</div><div class="v num ${last === best ? 't-overall' : ''}">${fmtTime(last)}</div></div>
      <div class="stat"><div class="l">Meilleur</div><div class="v num t-overall">${fmtTime(best)}</div></div>
      <div class="stat"><div class="l">Moyenne</div><div class="v num">${fmtTime(avg(laps))}</div></div>
      <div class="stat"><div class="l">Régularité</div><div class="v num">${laps.length > 2 ? '±' + fmtTime(std(laps), 2) : '—'}</div></div>
    </div>
    ${g.lastSectors.length ? `<p style="margin:12px 0 0">Secteurs du dernier tour : ${g.lastSectors.map((s, i) => `<span class="sector num">S${i + 1} ${fmtTime(s)}</span>`).join(' ')}</p>` : ''}
    <h3>10 derniers tours</h3>
    <div class="ghost-laps">
      ${recent.map((t, i) => `<div class="ghost-lap"><span class="muted">T${laps.length - i}</span>
        <span class="ghost-lap-bar"><i style="width:${Math.max(8, Math.round((best / t) * 100))}%"></i></span>
        <b class="num ${t === best ? 't-overall' : ''}">${fmtTime(t)}</b></div>`).join('')}
    </div>`;
}

export function onLap() {
  renderTiming();
}

export function tick() {
  const el = root && $('#gState', root);
  if (!el) return;
  const ago = app.ghost.seenAt ? (performance.now() - app.ghost.seenAt) / 1000 : null;
  // "en piste" tant qu'il n'a pas mis plus de 2,5 tours à repasser (8 à 30 s)
  const lastLap = app.ghost.laps[app.ghost.laps.length - 1];
  const win = lastLap ? Math.min(30, Math.max(8, (lastLap * 2.5) / 1000)) : 30;
  const live = ago !== null && ago < win;
  el.className = 'ghost-state' + (live ? ' on' : '');
  el.textContent = !app.cu.connected ? 'Circuit non connecté' : live ? '● EN PISTE' : 'À l\'arrêt';
}
