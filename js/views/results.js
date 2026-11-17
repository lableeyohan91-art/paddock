// Page de fin de course : podium, meilleur tour, graphique des positions tour par tour
// et onglet « Pilotes » (temps moyen, arrêts, essence utilisée).
// Tout est calculé à partir de la séance en mémoire : rien n'est enregistré en plus.

import { esc, $, $$, modal } from '../ui.js';
import { TYPES, fmtTime } from '../race.js'; // fmtTime : podium des essais / qualifs

const s3 = (ms) => (ms > 0 ? (ms / 1000).toFixed(3).replace('.', ',') : '—');
const pctTxt = (x) => `${Math.round(x)} %`;

/**
 * Position de chaque voiture à chaque tour : ordre de passage sur la ligne au tour n
 * (une voiture qui n'a pas encore bouclé ce tour est derrière celles qui l'ont bouclé).
 */
function positionsByLap(comps) {
  const maxLaps = Math.max(0, ...comps.map((c) => c.laps));
  const lines = comps.map((c) => ({ c, pts: [] }));
  for (let n = 1; n <= maxLaps; n++) {
    for (const l of lines) {
      const t = l.c.lapTs[n];
      if (t === undefined) continue;
      const ahead = comps.filter((o) => o !== l.c && o.lapTs[n] !== undefined && o.lapTs[n] < t).length;
      l.pts.push([n, ahead + 1]);
    }
  }
  return { maxLaps, lines };
}

/** Graphique SVG : en bas les tours, à gauche les positions, une ligne par pilote (sa couleur). */
function chartSvg(comps) {
  const { maxLaps, lines } = positionsByLap(comps);
  const n = comps.length;
  if (maxLaps < 2 || n < 2) return '<p class="muted">Pas assez de tours pour tracer le graphique.</p>';
  // largeur du dessin = largeur réelle de l'écran : textes lisibles sur téléphone
  const W = Math.round(Math.max(300, Math.min(680, (window.innerWidth || 680) - 70))), H = Math.max(176, 50 + n * 36), L = 34, R = 14, T = 14, B = 38;
  const x = (lap) => L + ((lap - 1) / (maxLaps - 1)) * (W - L - R);
  const y = (pos) => T + (n === 1 ? 0 : ((pos - 1) / (n - 1)) * (H - T - B));
  const step = Math.max(1, Math.ceil(maxLaps / 10));
  const ticks = [];
  for (let k = 1; k <= maxLaps; k += step) ticks.push(k);
  if (ticks[ticks.length - 1] !== maxLaps) ticks.push(maxLaps);
  const grid = Array.from({ length: n }, (_, i) => i + 1).map((p) => `
    <line x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}" class="rs-grid"/>
    <text x="${L - 8}" y="${y(p) + 4}" text-anchor="end" class="rs-ax">P${p}</text>`).join('');
  const xs = ticks.map((k) => `<text x="${x(k)}" y="${H - 20}" text-anchor="middle" class="rs-ax">${k}</text>`).join('');
  const paths = lines.filter((l) => l.pts.length).map((l) => {
    const col = esc(l.c.driver?.color || '#888');
    const d = l.pts.map(([lap, pos], i) => `${i ? 'L' : 'M'}${x(lap).toFixed(1)},${y(pos).toFixed(1)}`).join(' ');
    const [ll, lp] = l.pts[l.pts.length - 1];
    return `<path d="${d}" fill="none" stroke="${col}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(ll)}" cy="${y(lp)}" r="4.5" fill="${col}"/>`;
  }).join('');
  return `<svg class="rs-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Positions des pilotes tour par tour">
    ${grid}${xs}${paths}
    <text x="${(L + W - R) / 2}" y="${H - 3}" text-anchor="middle" class="rs-ax rs-ax-t">Tours</text>
  </svg>
  <div class="rs-legend">${comps.map((c) => `<span><i style="background:${esc(c.driver?.color || '#888')}"></i>${esc(c.driver?.name || '')}</span>`).join('')}</div>`;
}

function courseTab(s, res, isRace) {
  const top = res.slice(0, 3);
  const pod = [top[1], top[0], top[2]].map((r, i) => r ? `
    <div class="p${[2, 1, 3][i]}"><b>${[2, 1, 3][i]}</b>${esc(r.driverName)}<br><small>${isRace ? r.laps + ' tours' : fmtTime(r.bestLap)}</small></div>` : '').join('');
  const best = s.overallBest ? s.comps.get(s.overallBest.address) : null;
  const comps = s.order.length ? s.order : [...s.comps.values()];
  return `
    ${res.length ? `<div class="podium">${pod}</div>` : '<p class="muted">Aucun tour enregistré.</p>'}
    ${best ? `<div class="rs-best" style="--dc:${esc(best.driver?.color || '#888')}">
      <span>⏱️ Meilleur tour en course</span>
      <b>${esc(best.driver?.name || '')}</b>
      <span class="num">${s3(s.overallBest.time)} s</span>
    </div>` : ''}
    ${isRace ? `<h3 style="margin:18px 0 6px">Positions tour par tour</h3>${chartSvg(comps.filter((c) => c.laps > 0))}` : ''}`;
}

function driversTab(s, res, fuelOn) {
  return `<div class="rs-drivers">${res.map((r) => {
    const c = s.comps.get(r.address);
    const avg = r.laps ? (r.totalTime || c.lapTimes.reduce((a, b) => a + b, 0)) / r.laps : null;
    return `<div class="rs-drv" style="--dc:${esc(c?.driver?.color || '#888')}">
      <div class="rs-drv-h"><b>P${r.position}</b> ${esc(r.driverName)} <small class="muted">· ${esc(r.carName)}</small></div>
      <div class="rs-drv-g">
        <span>Tours<b class="num">${r.laps}</b></span>
        <span>Meilleur tour<b class="num">${s3(r.bestLap)} s</b></span>
        <span>Temps moyen au tour<b class="num">${s3(avg)} s</b></span>
        <span>Arrêts au stand<b class="num">${r.pitStops || 0}</b></span>
        ${fuelOn ? `<span>Essence utilisée<b class="num">${pctTxt(c?.fuelUsed || 0)}</b></span>` : ''}
        ${s.cfg.type === 'race' && r.position > 1 ? `<span>Écart<b class="num">${esc(r.gap || '—')}</b></span>` : ''}
      </div>
    </div>`;
  }).join('')}</div>
  ${fuelOn ? '<p class="muted" style="font-size:.8rem;margin:10px 0 0">Essence utilisée : total consommé pendant la course, en % de réservoir (100 % = un plein).</p>' : ''}`;
}

export function showResultsPage(app) {
  const s = app.session;
  if (!s) return;
  const res = s.results().filter((r) => r.laps > 0 || r.bestLap);
  const isRace = s.cfg.type === 'race';
  const fuelOn = app.fuelOn();
  let tab = 'course';
  const m = modal(`<div id="rsBody"></div>`);
  m.el.classList.add('results-page');
  const draw = () => {
    $('#rsBody', m.el).innerHTML = `
      <h2 style="margin-top:0">🏁 Résultats — ${esc(TYPES[s.cfg.type])}</h2>
      <div class="subtabs small">
        <button data-rs="course" class="${tab === 'course' ? 'on' : ''}">🏆 ${isRace ? 'Course' : 'Classement'}</button>
        <button data-rs="pilotes" class="${tab === 'pilotes' ? 'on' : ''}">👤 Pilotes</button>
      </div>
      ${tab === 'course' ? courseTab(s, res, isRace) : driversTab(s, res, fuelOn)}
      <p class="muted" style="font-size:.85rem">${(s.simulated ?? app.isSim) ? '🎮 Session simulée : non enregistrée dans les statistiques.' : 'Session enregistrée dans les statistiques.'}</p>
      <div class="row" style="justify-content:flex-end"><button class="btn primary" data-close>Fermer</button></div>`;
    $$('[data-rs]', m.el).forEach((b) => (b.onclick = () => { tab = b.dataset.rs; draw(); }));
  };
  draw();
}
