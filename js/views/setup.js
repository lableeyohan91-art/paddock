// Préparation d'une session : type, durée, manettes/pilotes/voitures, météo.

import { esc, $, $$ } from '../ui.js';
import { SKY } from '../weather.js';

let app;
let root;

export function defaultSetup(a) {
  return {
    type: 'race',
    mode: 'laps',
    laps: 10,
    duration: 5,
    start: 'lights',
    minLapMs: 1500,
    trackId: a.data.tracks[0]?.id || null,
    weather: { sky: 'sun', dynamic: false, variability: 3, intensity: 1 },
    slots: Array.from({ length: 6 }, (_, i) => ({
      address: i,
      active: i < 2,
      driverId: a.data.drivers[i]?.id || null,
      carId: a.data.cars[i]?.id || null,
      speed: 15,
      brake: 15,
    })),
  };
}

export function mount(main, a) {
  app = a;
  root = main;
  render();
}

function opt(list, sel, empty) {
  return (empty ? `<option value="">${empty}</option>` : '') +
    list.map((x) => `<option value="${esc(x.id)}" ${x.id === sel ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
}

function render() {
  const s = app.setup;
  const isRace = s.type === 'race';
  const timeUsed = !isRace || s.mode === 'time';
  root.innerHTML = `
  <div class="grid grid-2">
    <section class="panel">
      <h2>Type de session</h2>
      <div class="type-cards">
        ${[['practice', '🛞 Essais libres'], ['qualifying', '⏱️ Qualification'], ['race', '🏁 Course']]
          .map(([k, l]) => `<button data-type="${k}" class="${s.type === k ? 'on' : ''}">${l}</button>`).join('')}
      </div>

      ${isRace ? `
      <h3>Format</h3>
      <div class="seg" id="modeSeg">
        <button data-mode="laps" class="${s.mode === 'laps' ? 'on' : ''}">Nombre de tours</button>
        <button data-mode="time" class="${s.mode === 'time' ? 'on' : ''}">Durée</button>
      </div>` : ''}

      <div class="row" style="margin-top:14px">
        ${isRace && s.mode === 'laps' ? `
        <label class="field">Tours<input type="number" id="laps" min="1" max="999" value="${s.laps}" style="width:110px"></label>` : ''}
        ${timeUsed ? `
        <label class="field">Durée (min)${s.type === 'practice' ? ' — 0 = illimité' : ''}
          <input type="number" id="duration" min="0" max="600" value="${s.duration}" style="width:110px"></label>` : ''}
        <label class="field">Circuit
          <select id="track">${opt(app.data.tracks, s.trackId)}</select></label>
      </div>

      ${isRace ? `
      <h3>Départ</h3>
      <div class="seg" id="startSeg">
        <button data-start="lights" class="${s.start === 'lights' ? 'on' : ''}">🚦 Feux de la Control Unit</button>
        <button data-start="immediate" class="${s.start === 'immediate' ? 'on' : ''}">Lancé (immédiat)</button>
      </div>` : `<p class="muted" style="margin-top:14px">Départ libre : le chrono de chaque pilote démarre à son premier passage sur la ligne.</p>`}

      <h3>Météo</h3>
      <div class="sky-buttons" id="skyBtns">
        ${Object.entries(SKY).map(([k, v]) => `<button data-sky="${k}" class="${s.weather.sky === k ? 'on' : ''}">${v.icon}<span>${v.label}</span></button>`).join('')}
      </div>
      <label class="row" style="margin-top:12px"><input type="checkbox" id="wDyn" ${s.weather.dynamic ? 'checked' : ''}> Météo dynamique (le temps change pendant la session)</label>
      <div class="grid grid-2" style="margin-top:8px;gap:12px">
        <label class="field">Variabilité : <span id="wVarL">${['très stable', 'stable', 'normale', 'changeante', 'très changeante'][s.weather.variability - 1]}</span>
          <input type="range" id="wVar" min="1" max="5" value="${s.weather.variability}"></label>
        <label class="field">Effet sur les voitures : <span id="wIntL">${Math.round(s.weather.intensity * 100)} %</span>
          <input type="range" id="wInt" min="50" max="150" step="10" value="${Math.round(s.weather.intensity * 100)}"></label>
      </div>
    </section>

    <section class="panel">
      <h2>Manettes</h2>
      <p class="muted" style="margin-top:-6px">Chaque pilote garde ses réglages du garage pour la voiture choisie. La météo et les autres effets s'appliquent par-dessus.</p>
      <div class="list" id="slots">
        ${s.slots.map((sl) => {
          const t = app.getTune(sl.driverId, sl.carId);
          const p = (v) => Math.round((v / 15) * 100);
          return `
        <div class="slot ${sl.active ? '' : 'off'}" data-slot="${sl.address}">
          <label class="row" style="gap:6px"><input type="checkbox" data-k="active" ${sl.active ? 'checked' : ''}><span class="slot-n">${sl.address + 1}</span></label>
          <select data-k="driverId">${opt(app.data.drivers, sl.driverId, '— Pilote —')}</select>
          <select data-k="carId">${opt(app.data.cars, sl.carId, '— Voiture —')}</select>
          <div class="slot-perf" style="display:flex;gap:14px;align-items:center;font-size:.85rem">
            ${sl.driverId && sl.carId ? `
            <span style="color:var(--green)">Accél. <b class="num">${p(t.speed)} %</b></span>
            <span style="color:var(--accent-2)">Frein <b class="num">${p(t.brake)} %</b></span>
            <span style="color:var(--blue)">Réservoir <b class="num">${p(t.fuel)} %</b></span>
            <button class="btn small ghost" data-garage style="margin-left:auto">Régler au garage →</button>`
              : '<span class="muted">Choisis le pilote et la voiture</span>'}
          </div>
        </div>`;
        }).join('')}
      </div>
    </section>
  </div>
  <div class="row" style="justify-content:flex-end;margin-top:16px">
    ${app.isRacing ? '<button class="btn go big" id="backRace">↩ Revenir à la session en cours</button>' : ''}
    <button class="btn primary big" id="prepare">${app.isRacing ? 'Nouvelle session (arrête l\'actuelle)' : 'Préparer la session →'}</button>
  </div>`;
  bind();
}

function save(rerender = false) {
  app.saveSetup();
  if (rerender) render();
}

function bind() {
  const s = app.setup;
  $$('[data-type]', root).forEach((b) => (b.onclick = () => { s.type = b.dataset.type; save(true); }));
  $$('[data-mode]', root).forEach((b) => (b.onclick = () => { s.mode = b.dataset.mode; save(true); }));
  $$('[data-start]', root).forEach((b) => (b.onclick = () => { s.start = b.dataset.start; save(true); }));
  $$('[data-sky]', root).forEach((b) => (b.onclick = () => { s.weather.sky = b.dataset.sky; save(true); }));
  const num = (id, key, min = 0) => {
    const el = $('#' + id, root);
    if (el) el.onchange = () => { s[key] = Math.max(min, parseInt(el.value, 10) || 0); save(); };
  };
  num('laps', 'laps', 1);
  num('duration', 'duration', 0);
  $('#track', root).onchange = (e) => { s.trackId = e.target.value; save(); };
  $('#wDyn', root).onchange = (e) => { s.weather.dynamic = e.target.checked; save(); };
  $('#wVar', root).oninput = (e) => {
    s.weather.variability = +e.target.value;
    $('#wVarL', root).textContent = ['très stable', 'stable', 'normale', 'changeante', 'très changeante'][s.weather.variability - 1];
    save();
  };
  $('#wInt', root).oninput = (e) => {
    s.weather.intensity = +e.target.value / 100;
    $('#wIntL', root).textContent = e.target.value + ' %';
    save();
  };

  $$('.slot', root).forEach((el) => {
    const sl = s.slots[+el.dataset.slot];
    $$('[data-k]', el).forEach((input) => {
      const k = input.dataset.k;
      const handler = () => {
        if (k === 'active') {
          sl.active = input.checked;
          el.classList.toggle('off', !sl.active);
          save();
        } else {
          sl[k] = input.value || null;
          save(true); // affiche le réglage garage du nouveau couple pilote + voiture
        }
        if (sl.active) app.applyTune(sl.address);
      };
      input.addEventListener('change', handler);
    });
  });
  $$('[data-garage]', root).forEach((b) => (b.onclick = () => app.go('garage')));

  $('#prepare', root).onclick = () => app.prepareSession();
  const back = $('#backRace', root);
  if (back) back.onclick = () => app.go('race');
}

export function refresh() {
  if (root && app.view === 'setup') render();
}
