// Statistiques : records par circuit, pilotes, voitures, progression, historique.

import { esc, $, $$, fmtDate } from '../ui.js';
import { fmtTime, TYPES } from '../race.js';
import { statLaps, counts, dayKey } from '../memo.js';

let app;
let root;
const filter = { trackId: null, driverId: null };

export function mount(main, a) {
  app = a;
  root = main;
  if (!filter.trackId || !app.track(filter.trackId)) filter.trackId = app.data.tracks[0]?.id || null;
  render();
}

const avg = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const std = (a) => {
  const m = avg(a);
  return Math.sqrt(avg(a.map((x) => (x - m) ** 2)));
};

/** Tours "propres" : sous drapeau vert et pas plus de 50 % au-dessus du meilleur. */
function clean(laps) {
  if (!laps.length) return [];
  const best = Math.min(...laps.map((l) => l.time));
  return laps.filter((l) => l.time <= best * 1.5);
}

function groupBy(list, key) {
  const m = new Map();
  for (const x of list) {
    const k = x[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

async function render() {
  // tours détaillés (3 dernières séances, records importés) + tours témoins des fiches mémo
  const src = filter.trackId ? await statLaps(app.db, { trackId: filter.trackId }) : { laps: [], memos: [], all: [] };
  const laps = src.all.filter((l) => l.flag !== 'yellow');
  const total = counts(src.laps, src.memos);
  const sessions = (await app.db.all('sessions'))
    .filter((s) => s.trackId === filter.trackId)
    .sort((a, b) => b.date - a.date);

  const record = laps.length ? laps.reduce((a, b) => (b.time < a.time ? b : a)) : null;
  const byDriver = groupBy(laps.filter((l) => l.driverId), 'driverId');
  const byCar = groupBy(laps.filter((l) => l.carId), 'carId');

  const driverRows = [...byDriver.entries()].map(([id, ls]) => {
    const times = ls.map((l) => l.time).sort((a, b) => a - b);
    // régularité : ses 30 derniers tours
    const last30 = [...ls].filter((l) => !l.imported).sort((a, b) => b.date - a.date).slice(0, 30);
    const c = clean(last30).map((l) => l.time);
    const n = counts(src.laps, src.memos, (x) => x.driverId === id);
    return {
      id,
      name: app.driver(id)?.name || '(supprimé)',
      color: app.driver(id)?.color || '#888',
      best: times[0],
      top5: avg(times.slice(0, 5)),
      consistency: c.length > 2 ? std(c) : null,
      count: n.laps,
      sessions: n.sessions,
    };
  }).sort((a, b) => a.best - b.best);

  const carRows = [...byCar.entries()].map(([id, ls]) => {
    const best = ls.reduce((a, b) => (b.time < a.time ? b : a));
    return {
      name: app.car(id)?.name || '(supprimée)',
      best: best.time,
      by: app.driver(best.driverId)?.name || '—',
      count: counts(src.laps, src.memos, (x) => x.carId === id).laps,
    };
  }).sort((a, b) => a.best - b.best);

  if (!filter.driverId || !byDriver.has(filter.driverId)) filter.driverId = driverRows[0]?.id || null;

  root.innerHTML = `
  <div class="row" style="margin-bottom:16px">
    <label class="field">Circuit<select id="fTrack">${app.data.tracks.map((t) =>
      `<option value="${esc(t.id)}" ${t.id === filter.trackId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
  </div>

  ${!laps.length ? `<div class="panel empty">Aucun tour enregistré sur ce circuit.<br>Lance une session : chaque tour est sauvegardé automatiquement.</div>` : `
  <div class="stat-cards" style="margin-bottom:16px">
    <div class="stat"><div class="l">Record du circuit</div><div class="v num t-overall">${fmtTime(record.time)}</div>
      <div class="muted" style="font-size:.85rem">${esc(app.driver(record.driverId)?.name || '—')} · ${esc(app.car(record.carId)?.name || '—')}</div></div>
    <div class="stat"><div class="l">Tours enregistrés</div><div class="v num">${total.laps}</div></div>
    <div class="stat"><div class="l">Sessions</div><div class="v num">${sessions.length}</div></div>
    <div class="stat"><div class="l">Distance parcourue</div><div class="v num">${app.track(filter.trackId)?.length ? ((total.laps * app.track(filter.trackId).length) / 1000).toFixed(2) + ' km' : '—'}</div>
      ${app.track(filter.trackId)?.length ? '' : '<div class="muted" style="font-size:.75rem">Indique la longueur du circuit</div>'}</div>
  </div>

  <div class="grid grid-2">
    <section class="panel">
      <h2>Pilotes</h2>
      <table class="simple">
        <tr><th>Pilote</th><th>Meilleur</th><th>Moy. 5 meilleurs</th><th title="Écart-type des tours propres : plus c'est bas, plus le pilote est régulier">Régularité</th><th>Tours</th></tr>
        ${driverRows.map((d) => `<tr>
          <td><span class="swatch" style="display:inline-block;height:14px;vertical-align:middle;background:${esc(d.color)}"></span> ${esc(d.name)}</td>
          <td class="num">${fmtTime(d.best)}</td><td class="num">${fmtTime(d.top5)}</td>
          <td class="num">${d.consistency !== null ? '±' + fmtTime(d.consistency, 2) : '—'}</td><td class="num">${d.count}</td></tr>`).join('')}
      </table>
    </section>

    <section class="panel">
      <h2>Progression</h2>
      <div class="row" style="margin-bottom:8px">
        <select id="fDriver">${driverRows.map((d) =>
          `<option value="${esc(d.id)}" ${d.id === filter.driverId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
        <span class="muted" style="font-size:.85rem">Meilleur tour par jour</span>
      </div>
      <div id="chart"></div>
    </section>

    <section class="panel">
      <h2>Voitures</h2>
      <table class="simple">
        <tr><th>Voiture</th><th>Meilleur</th><th>Par</th><th>Tours</th></tr>
        ${carRows.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${fmtTime(c.best)}</td><td>${esc(c.by)}</td><td class="num">${c.count}</td></tr>`).join('')}
      </table>
    </section>

    <section class="panel">
      <h2>Dernières sessions</h2>
      <table class="simple">
        <tr><th>Date</th><th>Type</th><th>Vainqueur / 1er</th><th>Meilleur tour</th></tr>
        ${sessions.slice(0, 15).map((s) => {
          const w = s.results?.[0];
          return `<tr><td>${fmtDate(s.date)}</td><td>${esc(TYPES[s.type] || s.type)}</td>
            <td>${s.completed === false || s.state !== 'finished' ? '<span class="muted">interrompue</span>' : esc(w?.driverName || '—')}</td>
            <td class="num">${fmtTime(s.bestLap)}</td></tr>`;
        }).join('')}
      </table>
    </section>
  </div>`}`;

  $('#fTrack', root).onchange = (e) => { filter.trackId = e.target.value; render(); };
  const fd = $('#fDriver', root);
  if (fd) {
    fd.onchange = (e) => { filter.driverId = e.target.value; drawChart(byDriver.get(filter.driverId) || []); };
    drawChart(byDriver.get(filter.driverId) || []);
  }
}

function drawChart(laps) {
  const el = $('#chart', root);
  // meilleur tour de chaque jour (les fiches mémo gardent le meilleur tour de chaque jour)
  const byDay = new Map();
  for (const l of laps) { const k = dayKey(l.date); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(l); }
  const pts = [...byDay.values()]
    .map((ls) => ({ date: Math.min(...ls.map((l) => l.date)), best: Math.min(...ls.map((l) => l.time)) }))
    .sort((a, b) => a.date - b.date);
  if (pts.length < 2) {
    el.innerHTML = `<p class="muted">Il faut au moins deux jours de roulage pour voir une progression.${pts.length ? ` Meilleur tour actuel : <b class="num">${fmtTime(pts[0].best)}</b>` : ''}</p>`;
    return;
  }
  const W = 600, H = 200, P = 36;
  const min = Math.min(...pts.map((p) => p.best));
  const max = Math.max(...pts.map((p) => p.best));
  const span = max - min || 1;
  const x = (i) => P + (i * (W - P * 1.5)) / (pts.length - 1);
  const y = (v) => 14 + ((v - min) / span) * (H - 40); // plus rapide = plus haut
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.best).toFixed(1)}`).join(' ');
  const gain = pts[0].best - pts[pts.length - 1].best;
  el.innerHTML = `
    <svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Progression du meilleur tour">
      <line x1="${P}" x2="${W - 10}" y1="${y(min)}" y2="${y(min)}" stroke="var(--line)" stroke-dasharray="4 4"/>
      <text x="4" y="${y(min) + 4}" fill="var(--muted)" font-size="11">${fmtTime(min, 2)}</text>
      <text x="4" y="${y(max) + 4}" fill="var(--muted)" font-size="11">${fmtTime(max, 2)}</text>
      <path d="${path}" fill="none" stroke="var(--green)" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
      ${pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.best)}" r="4" fill="${p.best === min ? 'var(--purple)' : 'var(--green)'}"><title>${fmtDate(p.date)} : ${fmtTime(p.best)}</title></circle>`).join('')}
    </svg>
    <p class="muted" style="margin:6px 0 0;font-size:.85rem">${gain > 0 ? `▲ ${fmtTime(gain)} gagnées depuis le premier jour` : gain < 0 ? `▼ ${fmtTime(-gain)} perdues depuis le premier jour` : 'Stable'}</p>`;
}
