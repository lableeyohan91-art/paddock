// Fiche pilote : le centre des statistiques individuelles.
// En-tête (photo, nom, couleur, modifier), chiffres clés, records par circuit
// avec détail des secteurs, records de secteurs et tour idéal.

import { esc, $, $$, modal, fmtDate, confirmBox, toast } from '../ui.js';
import { fmtTime, TYPES } from '../race.js';
import { avatar, editDriver } from './drivers.js';
import { statLaps, counts, dayKey, voidLap } from '../memo.js';

let app;
let root;
let sheetTrack;  // circuit affiché sur la fiche ('' = tous les circuits)
let lastSt = null; // derniers chiffres affichés (pour rouvrir la liste des meilleurs tours)

export function mount(main, a) {
  app = a;
  root = main;
  const d = app.driver(app.driverId);
  if (!d) { app.go('drivers'); return; }
  // par défaut : le circuit en cours (celui de la préparation de course)
  if (sheetTrack === undefined || (sheetTrack && !app.track(sheetTrack))) sheetTrack = app.setup?.trackId || '';
  render(d);
}

export function unmount() {
  root = null;
}

export function refresh() {
  const d = app.driver(app.driverId);
  if (root && app.view === 'driver' && d) render(d);
}

/** Durée de roulage lisible : "2 h 05 min", "12 min 30 s". */
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(s % 60).padStart(2, '0')} s`;
  return `${s} s`;
}

const wet = (l) => (l.wetness ?? 0) >= 0.05;

async function compute(d) {
  const onTrack = (x) => !sheetTrack || x.trackId === sheetTrack;
  // tours détaillés (3 dernières séances, records importés) + tours témoins des fiches mémo
  const src = await statLaps(app.db, { driverId: d.id });
  const laps = src.all.filter(onTrack);
  const detail = src.laps.filter(onTrack);
  const memos = src.memos.filter(onTrack);
  const sessions = (await app.db.all('sessions')).filter(onTrack);
  const lapSessions = new Set(laps.map((l) => l.sessionId));
  const mine = sessions.filter((s) => s.state === 'finished' &&
    (lapSessions.has(s.id) || (s.results || s.entries || []).some((e) => e.driverId === d.id))); // fiche allégée : seulement results
  // courses / qualifs : seulement celles allées à leur terme (une séance interrompue ne compte pas)
  const ofType = (t) => mine.filter((s) => s.type === t && (t === 'practice' || s.completed !== false)
    && (!d.resultsResetAt || (s.date || 0) > d.resultsResetAt)); // remise à zéro propre à ce pilote
  const first = (s) => s.results?.[0]?.driverId === d.id;

  // Records par circuit (meilleur tour, hors drapeau jaune)
  const clean = laps.filter((l) => l.flag !== 'yellow');
  const byTrack = new Map();
  for (const l of clean) {
    if (!byTrack.has(l.trackId)) byTrack.set(l.trackId, []);
    byTrack.get(l.trackId).push(l);
  }
  const records = [...byTrack.entries()].map(([trackId, ls]) => {
    const best = ls.reduce((a, b) => (b.time < a.time ? b : a));
    // records de secteurs : sur les tours qui ont le nombre de secteurs le plus courant
    const withSec = ls.filter((l) => (l.sectors?.length || 0) >= 2);
    let sectors = null;
    if (withSec.length) {
      const n = Math.max(...withSec.map((l) => l.sectors.length));
      const comparable = withSec.filter((l) => l.sectors.length === n);
      sectors = Array.from({ length: n }, (_, i) => comparable.reduce((a, b) => (b.sectors[i] < a.sectors[i] ? b : a)))
        .map((l, i) => ({ time: l.sectors[i], lap: l }));
    }
    return {
      trackId,
      track: app.track(trackId)?.name || '(circuit supprimé)',
      best,
      top: [...new Map(ls.map((l) => [l.id, l])).values()].sort((a, b) => a.time - b.time).slice(0, 10), // 10 meilleurs tours (toutes voitures)
      laps: counts(detail, memos, (x) => x.trackId === trackId).laps, // tours roulés dans Paddock (hors records importés)
      sectors,
      ideal: sectors ? sectors.reduce((s, x) => s + x.time, 0) : null,
    };
  }).sort((a, b) => b.laps - a.laps);

  const total = counts(detail, memos);
  return {
    laps,
    memos,
    // les records importés (SmartRace) ne sont qu'un meilleur tour : hors compteurs
    totalLaps: total.laps,
    drivingMs: total.drivingMs,
    races: ofType('race').length,
    wins: ofType('race').filter(first).length,
    quals: ofType('qualifying').length,
    poles: ofType('qualifying').filter(first).length,
    practices: ofType('practice').length,
    records,
  };
}

async function render(d) {
  root.innerHTML = '<p class="muted">Chargement…</p>';
  const st = await compute(d);
  lastSt = st;
  if (!root) return;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) + ' %' : '—');

  root.innerHTML = `
  <div class="sheet" style="--dc:${esc(d.color)}">
    <button class="btn small ghost" id="back">← Pilotes</button>

    <header class="sheet-head">
      <div class="driver-photo sheet-photo" style="--dc:${esc(d.color)}">${avatar(d)}</div>
      <div class="sheet-id">
        <h1 class="sheet-name">${esc(d.name)}</h1>
        <div class="row" style="gap:8px">
          <span class="sheet-color" style="background:${esc(d.color)}"></span>
          <button class="btn small" id="edit">✎ Modifier</button>
          <button class="btn small ghost danger" id="del">🗑 Supprimer</button>
        </div>
      </div>
    </header>

    ${app.data.tracks.length > 1 ? `
    <label class="row sheet-track">📍 Circuit
      <select id="sheetTrack">
        <option value="" ${!sheetTrack ? 'selected' : ''}>Tous les circuits</option>
        ${app.data.tracks.map((t) => `<option value="${esc(t.id)}" ${t.id === sheetTrack ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}
      </select>
    </label>` : ''}

    <section class="key-stats">
      <div class="kstat"><div class="v num">${st.totalLaps}</div><div class="l">Tours effectués</div></div>
      <div class="kstat"><div class="v num">${st.drivingMs ? fmtDuration(st.drivingMs) : '—'}</div><div class="l">Temps de roulage</div></div>
      <div class="kstat"><div class="v num">${st.races} <small>/</small> <span class="gold">${st.wins}</span></div>
        <div class="l">Courses / victoires</div><div class="s">${st.races ? pct(st.wins, st.races) + ' de victoires' : ''}</div></div>
      <div class="kstat"><div class="v num">${st.quals} <small>/</small> <span class="purple">${st.poles}</span></div>
        <div class="l">Qualifs / pole positions</div><div class="s">${st.quals ? pct(st.poles, st.quals) + ' de poles' : ''}</div></div>
    </section>

    <section class="panel" style="margin-top:16px">
      <h2>${sheetTrack ? 'Record sur ce circuit' : 'Records par circuit'}</h2>
      ${st.records.length ? `
      <div class="records">
        ${st.records.map((r, i) => `
        <button class="record" data-rec="${i}">
          <div class="rec-track">${esc(r.track)}<small>${r.laps ? `${r.laps} tour${r.laps > 1 ? 's' : ''}` : 'record SmartRace'}</small></div>
          <div class="rec-time num">${fmtTime(r.best.time)}${wet(r.best) ? ' <span title="Piste mouillée">🌧️</span>' : ''}</div>
          <div class="rec-meta">${esc(app.car(r.best.carId)?.name || '—')} · ${r.best.imported ? new Date(r.best.date).toLocaleDateString('fr-FR') + ' · 📥 SmartRace' : fmtDate(r.best.date)}</div>
          <div class="rec-more">${r.best.sectors?.length ? `${r.best.sectors.length} secteurs ›` : 'détails ›'}</div>
        </button>
        <button class="btn small ghost rec-top" data-top="${i}">🏁 ${r.top.length > 1 ? `${r.top.length} meilleurs tours` : 'Meilleur tour'} · annuler un tour</button>
        ${r.sectors ? `
        <div class="rec-sectors">
          <span class="muted">Records de secteurs :</span>
          ${r.sectors.map((s, j) => `<span class="sector overall num" title="${esc(app.car(s.lap.carId)?.name || '')} · ${fmtDate(s.lap.date)}">S${j + 1} ${fmtTime(s.time)}</span>`).join('')}
          <span class="muted">· tour idéal</span> <b class="num">${fmtTime(r.ideal)}</b>
        </div>` : ''}`).join('')}
      </div>` : '<p class="muted">Aucun tour enregistré pour l\'instant. Ses records apparaîtront ici après sa première session sur le circuit (hors simulateur).</p>'}
    </section>

    ${st.records.length ? `
    <section class="panel" style="margin-top:16px">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">Progression : meilleur tour par jour</h2>
        ${st.records.length > 1 ? `<select id="progTrack">${st.records.map((r) =>
          `<option value="${esc(r.trackId)}" ${r.trackId === chartTrack(st) ? 'selected' : ''}>${esc(r.track)}</option>`).join('')}</select>`
          : `<span class="muted">${esc(st.records[0].track)}</span>`}
      </div>
      <div class="prog-chart" id="progChart"></div>
    </section>` : ''}
  </div>`;

  $('#back', root).onclick = () => app.go('drivers');
  const tr = $('#sheetTrack', root);
  if (tr) tr.onchange = () => { sheetTrack = tr.value; progTrack = null; render(d); };
  $('#edit', root).onclick = () => editDriver(d, () => refresh());
  $('#del', root).onclick = async () => {
    if (!(await confirmBox(`Supprimer ${d.name} ? Ses tours déjà enregistrés restent dans les statistiques.`))) return;
    await app.db.remove('drivers', d.id);
    await app.loadData();
    toast(`${d.name} supprimé`);
    app.go('drivers');
  };
  $$('[data-rec]', root).forEach((b) => (b.onclick = () => showLap(d, st.records[+b.dataset.rec])));
  $$('[data-top]', root).forEach((b) => (b.onclick = () => showTop(d, st.records[+b.dataset.top])));
  const sel = $('#progTrack', root);
  if (sel) sel.onchange = () => { progTrack = sel.value; drawProgress(d, st); };
  if (st.records.length) drawProgress(d, st);
}

// ---------- Graphique de progression ----------

let progTrack = null;
/** Circuit affiché : celui choisi, sinon celui où le pilote a le plus roulé. */
function chartTrack(st) {
  if (progTrack && st.records.some((r) => r.trackId === progTrack)) return progTrack;
  return st.records[0]?.trackId;
}

const TYPE_LABEL = { race: 'Course', qualifying: 'Qualif', practice: 'Essais' };

function drawProgress(d, st) {
  const el = $('#progChart', root);
  if (!el) return;
  const trackId = chartTrack(st);
  // meilleur tour de chaque JOUR sur ce circuit (hors drapeau jaune),
  // toutes sessions de la journée confondues
  // (les tours témoins des fiches mémo ne comptent que pour le meilleur tour du jour ;
  //  leurs tours et séances viennent des compteurs de la fiche)
  const byDay = new Map();
  for (const l of st.laps) {
    if (l.trackId !== trackId || l.flag === 'yellow') continue;
    const k = dayKey(l.date);
    let cur = byDay.get(k);
    if (!cur) { cur = { best: l, sessions: new Set(), laps: 0, extraSessions: 0 }; byDay.set(k, cur); }
    if (l.time < cur.best.time) cur.best = l;
    if (!l.kept && !l.imported) { cur.sessions.add(l.sessionId); cur.laps++; }
  }
  for (const m of st.memos.filter((x) => x.trackId === trackId)) {
    for (const [k, v] of Object.entries(m.days || {})) {
      const cur = byDay.get(k);
      if (cur) { cur.laps += v.laps; cur.extraSessions += v.sessions; }
    }
  }
  const days = [...byDay.values()].sort((a, b) => a.best.date - b.best.date);
  const pts = days.map((d) => d.best);
  if (!pts.length) { el.innerHTML = '<p class="muted">Pas encore de tour sur ce circuit.</p>'; return; }

  // dessiné à la largeur réelle de l'écran : textes lisibles aussi sur téléphone
  const W = Math.max(300, Math.round(el.clientWidth || 760)), H = 280, L = 58, R = 18, T = 18, B = 46;
  const times = pts.map((p) => p.time);
  let lo = Math.min(...times), hi = Math.max(...times);
  const pad = Math.max((hi - lo) * 0.15, 100);
  lo -= pad; hi += pad;
  const n = pts.length;
  // abscisse : une session après l'autre, datée (espacement régulier, lisible même le même jour)
  const x = (i) => (n === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (n - 1));
  const y = (t) => T + ((t - lo) / (hi - lo)) * (H - T - B); // temps croissant vers le bas : progresser = monter

  // graduations des temps : ~5 valeurs rondes
  const step = niceStep((hi - lo) / 5);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  // dates : au plus ~7 étiquettes
  const every = Math.max(1, Math.ceil(n / Math.max(3, Math.floor((W - L - R) / 70))));
  const best = Math.min(...times);
  const bestIdx = times.indexOf(best);
  const fmtD = (ts) => new Date(ts).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.time).toFixed(1)}`).join(' ');

  el.innerHTML = `
  <div class="prog-wrap">
    <svg viewBox="0 0 ${W} ${H}" class="prog-svg" role="img" aria-label="Meilleur tour de ${esc(d.name)} à chaque session">
      ${ticks.map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="prog-grid"/>
        <text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="prog-ax">${fmtTime(v, 2)}</text>`).join('')}
      ${pts.map((p, i) => (i % every === 0 || i === n - 1)
        ? `<text x="${x(i)}" y="${H - B + 20}" text-anchor="middle" class="prog-ax">${fmtD(p.date)}</text>` : '').join('')}
      <text x="${L}" y="${H - 6}" class="prog-ax">Jours de roulage →</text>
      <text x="12" y="${T + 2}" class="prog-ax" transform="rotate(-90 12 ${T + 2})" text-anchor="end">Temps au tour (s)</text>
      ${n > 1 ? `<path d="${line}" class="prog-line" style="stroke:${esc(d.color)}"/>` : ''}
      ${pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.time)}" r="${i === bestIdx ? 7 : 5}" class="prog-dot ${i === bestIdx ? 'best' : ''}" style="fill:${i === bestIdx ? 'var(--purple)' : esc(d.color)}"/>`).join('')}
      <text x="${Math.min(W - R - 4, Math.max(L + 4, x(bestIdx)))}" y="${y(best) - 14}" text-anchor="middle" class="prog-best">${fmtTime(best)}</text>
      ${pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.time)}" r="16" class="prog-hit" data-i="${i}"/>`).join('')}
    </svg>
    <div class="prog-tip hidden" id="progTip"></div>
  </div>
  <p class="muted" style="font-size:.82rem;margin:6px 0 0">Chaque point = son meilleur tour de la journée, toutes sessions confondues. Plus le point est haut, plus le tour est rapide. Point violet = record.</p>`;

  const tip = $('#progTip', el);
  const svg = $('svg', el);
  $$('.prog-hit', el).forEach((c) => {
    const show = () => {
      const day = days[+c.dataset.i];
      const p = day.best;
      const prev = pts[+c.dataset.i - 1];
      const delta = prev ? p.time - prev.time : null;
      const ns = day.sessions.size + day.extraSessions;
      tip.innerHTML = `<b>${new Date(p.date).toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit', year: '2-digit' })}</b><br>
        <span class="muted">${p.imported ? '📥 record importé de SmartRace'
          : `${ns} session${ns > 1 ? 's' : ''} · ${day.laps} tours · record du jour en ${(TYPE_LABEL[p.sessionType] || '').toLowerCase()} à ${new Date(p.date).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`}</span><br>
        <span class="num" style="font-size:1.1rem;font-weight:800">${fmtTime(p.time)}</span>
        ${delta !== null ? `<span class="num ${delta < 0 ? 't-best' : 'muted'}"> ${delta < 0 ? '−' : '+'}${fmtTime(Math.abs(delta))}</span>` : ''}
        <br><span class="muted">${esc(app.car(p.carId)?.name || '')}${(p.wetness ?? 0) >= 0.05 ? ' · 🌧️' : ''}</span>`;
      const r = svg.getBoundingClientRect();
      const cx = (+c.getAttribute('cx') / W) * r.width;
      const cy = (+c.getAttribute('cy') / H) * r.height;
      tip.style.left = Math.min(r.width - 170, Math.max(0, cx - 85)) + 'px';
      tip.style.top = (cy > r.height / 2 ? cy - 110 : cy + 14) + 'px';
      tip.classList.remove('hidden');
    };
    c.addEventListener('mouseenter', show);
    c.addEventListener('click', show);
    c.addEventListener('mouseleave', () => tip.classList.add('hidden'));
  });
}

/** Pas "rond" pour les graduations (ms) : 50, 100, 200, 250, 500, 1000… */
function niceStep(raw) {
  const steps = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
  return steps.find((s) => s >= raw) || 10000;
}

/** Détail du meilleur tour : secteurs comparés aux records de secteurs du pilote. */
/** 10 meilleurs tours du pilote sur un circuit, avec annulation d'un tour non homologué. */
function showTop(d, r) {
  const m = modal(`
    <h2>${esc(d.name)} — ${esc(r.track)}</h2>
    <p class="muted" style="margin-top:0;font-size:.85rem">${r.top.length > 1 ? `Ses ${r.top.length} meilleurs tours` : 'Son meilleur tour'}, toutes voitures confondues (hors drapeau jaune).
      🗑 annule un tour non homologué (sortie en fin de tour…) : il sort des records mais reste compté dans les tours effectués.</p>
    <table class="simple top-laps">
      <tr><th>#</th><th>Temps</th><th>Voiture · date</th><th></th></tr>
      ${r.top.map((l, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td class="num ${i === 0 ? 't-overall' : ''}">${fmtTime(l.time)}${wet(l) ? ' 🌧️' : ''}</td>
        <td>${esc(app.car(l.carId)?.name || '—')}<br><small class="muted">${l.imported ? new Date(l.date).toLocaleDateString('fr-FR') + ' · 📥 SmartRace' : fmtDate(l.date) + (TYPES[l.sessionType] ? ' · ' + esc(TYPES[l.sessionType]) : '')}</small></td>
        <td><button class="btn small ghost danger" data-void="${i}" title="Annuler ce tour (non homologué)">🗑</button></td>
      </tr>`).join('')}
    </table>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn primary" data-close>Fermer</button></div>`);
  m.el.querySelectorAll('[data-void]').forEach((b) => (b.onclick = async () => {
    const l = r.top[+b.dataset.void];
    if (!(await confirmBox(`Annuler le tour de ${fmtTime(l.time)} (${fmtDate(l.date)}) comme non homologué ? Il ne comptera plus dans les records de ${d.name}. Impossible de revenir en arrière.`))) {
      showTop(d, r);
      return;
    }
    await voidLap(app.db, l);
    toast(`Tour de ${fmtTime(l.time)} annulé`);
    await render(d);
    const again = lastSt?.records.find((x) => x.trackId === r.trackId);
    if (again?.top.length) showTop(d, again);
  }));
}

function showLap(d, r) {
  const l = r.best;
  const secs = l.sectors || [];
  const max = Math.max(...secs, 1);
  modal(`
    <h2>${esc(d.name)} — ${esc(r.track)}</h2>
    <div class="lap-detail">
      <div class="lap-big num">${fmtTime(l.time)}</div>
      <div class="muted">${esc(app.car(l.carId)?.name || '—')} · ${l.imported ? new Date(l.date).toLocaleDateString('fr-FR') + ' · 📥 importé de SmartRace' : fmtDate(l.date) + ' · ' + esc(TYPES[l.sessionType] || '')}
        ${wet(l) ? ' · 🌧️ piste mouillée' : ''}${l.speed !== null && l.speed !== undefined ? ` · vitesse ${Math.round((l.speed / 15) * 100)} %` : ''}</div>
    </div>
    ${secs.length ? `
    <h3>Secteurs de ce tour</h3>
    <div class="sec-bars">
      ${secs.map((t, i) => {
        const rec = r.sectors?.[i]?.time;
        const isRec = rec !== undefined && t === rec;
        const diff = rec !== undefined && !isRec ? `+${fmtTime(t - rec)}` : '';
        return `<div class="sec-row">
          <span class="sec-n">S${i + 1}</span>
          <div class="sec-track"><i class="${isRec ? 'rec' : ''}" style="width:${Math.round((t / max) * 100)}%"></i></div>
          <span class="num sec-t ${isRec ? 't-overall' : ''}">${fmtTime(t)}</span>
          <span class="num muted sec-d">${isRec ? 'record' : diff}</span>
        </div>`;
      }).join('')}
    </div>
    ${r.ideal ? `<p class="muted" style="font-size:.85rem">Tour idéal (meilleurs secteurs additionnés) : <b class="num" style="color:var(--text)">${fmtTime(r.ideal)}</b> — ${fmtTime(l.time - r.ideal)} à gagner.</p>` : ''}`
    : '<p class="muted">Pas de secteurs pour ce tour : le circuit n\'était pas équipé de Check Lane.</p>'}
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn primary" data-close>Fermer</button></div>`);
}
