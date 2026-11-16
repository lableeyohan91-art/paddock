// Réglages → Essence → Formule continue.
// conso = nominale × (temps médian ÷ temps du tour)^k : réglée automatiquement selon le profil
// (Prime à l'attaque, Équilibré, Gestion) à partir des tours des pilotes présents.

import { esc, $, $$, toast, confirmBox, promptBox } from '../ui.js';
import { CURVE_PROFILES } from '../fuel.js';
import { optimizeCurve, driverStats, median, RECENT_LAPS } from '../fuel-calc.js';

/**
 * Conseil en couleur : si un pilote coché a moins de 30 tours de course récents sur ce circuit,
 * proposer une Course rapide de 30 tours avant le calcul automatique.
 */
export function lapsTip(app, ids, countOf) {
  const short = [...new Set(ids)].map((id) => app.driver(id)).filter(Boolean)
    .map((d) => ({ d, n: countOf(d.id) })).filter((x) => x.n < RECENT_LAPS);
  if (!short.length) return '';
  const list = short.map((x) => `${esc(x.d.name)} : ${x.n}/${RECENT_LAPS}`).join(' · ');
  return `<p class="tipbox">💡 Pour optimiser les réglages, faites d'abord une <b>Course rapide de ${RECENT_LAPS} tours</b> avec les pilotes présents, puis lancez le calcul automatique.<br><small>Tours de course récents sur ce circuit — ${list}</small></p>`;
}

let st = {};          // saisies (gardées d'une fois sur l'autre)
let result = null;    // dernier calcul
let pickOpen = false; // liste des pilotes dépliée ?
let ctx;              // { app, el, getCfg, setCfg, save, refreshAll, laps }

const PROFILE_HELP = {
  attaque: 'Aller vite est clairement récompensé : attaquer bat le nominal de plusieurs secondes.',
  equilibre: 'Attaquer un peu bat le nominal de peu ; rouler à fond tout le temps ne paie pas.',
  gestion: 'Le rythme nominal est le meilleur choix : attaquer coûte un peu.',
};
const r2 = (x) => Math.round(x * 100) / 100;
const fmtS = (s) => (s === null || s === undefined || s === '' ? '' : (+s).toFixed(2));
const comma = (x, d = 1) => (+x).toFixed(d).replace('.', ',');

export async function loadCurveState(app) {
  st = await app.db.getSetting('fuelCurveCalc', {});
}
const saveSt = () => ctx.app.db.setSetting('fuelCurveCalc', st, { quiet: true });

function trackOf() {
  const app = ctx.app;
  return app.track(st.trackId) ? st.trackId : app.setup?.trackId;
}
function present() {
  const app = ctx.app;
  return st.drivers || (app.setup?.slots || []).filter((s) => s.active && s.driverId).map((s) => s.driverId);
}

/** Valeurs tirées des profils des pilotes présents (sur le circuit choisi). */
function autoValues() {
  const app = ctx.app;
  const stats = app.data.drivers.filter((d) => present().includes(d.id)).map((d) => {
    const s = driverStats(ctx.laps, d.id, trackOf()) || {};
    if (!(s.median > 0) && d.raceMedian > 0) s.median = d.raceMedian; // case du profil : seulement en secours
    return s;
  });
  const avg = (k) => { const v = stats.map((s) => s[k]).filter((x) => x > 0); return v.length ? r2(v.reduce((a, b) => a + b, 0) / v.length) : null; };
  const med = median(stats.map((s) => s.median).filter((x) => x > 0));
  return { median: med === null ? null : r2(med), best: avg('best'), top10: avg('top10'), spread: avg('spread'), n: stats.filter((s) => s.median || s.best).length };
}

function inputs() {
  const a = st.auto || {};
  return {
    median: st.median ?? a.median ?? null,
    best: st.best ?? a.best ?? null,
    top10: st.top10 ?? a.top10 ?? null,
    pitLap: st.pitLap ?? null,
    laps: st.laps ?? 50,
    stops: st.stops ?? 1,
    profile: st.profile || 'equilibre',
  };
}

export function curveHtml(c) {
  ctx = c;
  const app = ctx.app;
  const v = inputs();
  const a = st.auto;
  const manual = !a || ['median', 'best', 'top10'].some((k) => st[k] !== undefined && st[k] !== null);
  const field = (key, label, why, hint) => `
      <label class="field"><span class="calc-l">${label}<em>${why}</em></span>
        <input type="number" step="0.01" min="1" max="60" data-cv="${key}" value="${fmtS(v[key])}" placeholder="à saisir">
        ${hint ? `<small class="muted">${hint}</small>` : ''}</label>`;
  return `
  <section class="panel">
    <h2>📈 Progressif</h2>
    <p class="muted" style="margin:-4px 0 12px;font-size:.88rem">Chaque tour consomme selon son temps, au centième près (les pilotes ne voient que des valeurs arrondies) :
      <b>conso = nominale × (temps médian ÷ temps du tour)<sup>k</sup></b>. Plus de fourchettes : pas de temps « gratuit » au bord d'une fourchette.</p>

    <div class="field" style="margin-bottom:12px">Profil
      <div class="seg cv-profile">
        ${Object.entries(CURVE_PROFILES).map(([k, p]) => `<button data-cvp="${k}" class="${v.profile === k ? 'on' : ''}">${p.label}</button>`).join('')}
      </div>
      <small class="muted">${PROFILE_HELP[v.profile]}</small>
    </div>

    <label class="row calc-track">📍 Circuit
      <select id="cvTrack">${app.data.tracks.map((t) => `<option value="${esc(t.id)}" ${t.id === trackOf() ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
    </label>
    ${lapsTip(app, present(), (id) => driverStats(ctx.laps, id, trackOf())?.recent || 0)}
    <details class="calc-pick" id="cvPick" ${pickOpen ? 'open' : ''}>
      <summary>
        <span>👥 Pilotes présents <b>(${present().filter((id) => app.driver(id)).length})</b></span>
        <span class="calc-pick-names">${present().map((id) => app.driver(id)?.name).filter(Boolean).map(esc).join(', ') || 'aucun'}</span>
      </summary>
      <div class="calc-drivers">
        ${app.data.drivers.map((d) => `<label class="calc-drv" style="--dc:${esc(d.color)}"><input type="checkbox" data-cvd="${esc(d.id)}" ${present().includes(d.id) ? 'checked' : ''}><span>${esc(d.name)}</span></label>`).join('')}
      </div>
    </details>
    <button class="btn small calc-fill" id="cvAuto">⚡ Remplissage automatique</button>
    <p class="muted" style="font-size:.8rem;margin:4px 0 12px">Récupère sur les profils des pilotes cochés : temps médian sur leurs 30 derniers tours de course, moyenne des meilleurs tours et moyenne des 10 meilleurs tours en course${a ? ` — <b>rempli</b> (${a.n} pilote${a.n > 1 ? 's' : ''}${a.spread ? `, régularité ±${comma(a.spread)} %` : ''})` : ''}.</p>

    <div class="calc-grid">
      ${field('median', 'Temps médian (s)', 'le rythme nominal', a?.median ? `Auto : ${fmtS(a.median)} s` : '')}
      ${field('best', 'Meilleur tour (s)', 'moyenne des pilotes', a?.best ? `Auto : ${fmtS(a.best)} s` : '')}
      ${field('top10', '10 meilleurs tours (s)', 'rythme d’attaque', a?.top10 ? `Auto : ${fmtS(a.top10)} s` : 'Facultatif')}
      ${field('pitLap', 'Tour avec arrêt au stand (s)', 'coût d’un arrêt', 'Passage par les stands et arrêt, sans attendre le plein')}
      <label class="field"><span class="calc-l">Nombre de tours<em>taille du plein</em></span>
        <input type="number" step="1" min="5" max="1000" data-cv="laps" value="${v.laps}"></label>
      <label class="field"><span class="calc-l">Arrêts souhaités<em>au rythme nominal</em></span>
        <input type="number" step="1" min="0" max="60" data-cv="stops" value="${v.stops}"></label>
    </div>
    ${manual ? `<p class="warnbox" style="margin-top:12px">✍️ Valeurs saisies à la main : le calcul sera approximatif. <b>Conseil :</b> faites une <b>Course rapide de 30 tours</b> avec les pilotes, puis revenez ici et touchez <b>⚡ Remplissage automatique</b>.</p>` : ''}

    <button class="btn primary" id="cvGo" style="margin-top:12px">🧮 Calculer</button>
    <div id="cvRes">${resultHtml()}</div>
  </section>`;
}

/** Courbe « écart de temps de course selon le rythme tenu ». */
function chartSvg(r) {
  const W = 640, H = 220, P = { l: 44, r: 12, t: 12, b: 30 };
  const xs = r.chart.map((p) => p.t), ys = r.chart.map((p) => p.gap);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const lim = Math.max(5, Math.min(60, Math.max(...ys.map(Math.abs))));
  const X = (t) => P.l + ((t - x0) / (x1 - x0)) * (W - P.l - P.r);
  const Y = (g) => P.t + ((Math.max(-lim, Math.min(lim, g)) + lim) / (2 * lim)) * (H - P.t - P.b);
  const path = r.chart.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.gap).toFixed(1)}`).join(' ');
  const nom = r.rows.find((x) => x.name === 'Nominal');
  const ticks = [-lim, -lim / 2, 0, lim / 2, lim].map((g) => `<text x="${P.l - 6}" y="${Y(g) + 4}" text-anchor="end">${g > 0 ? '+' : ''}${Math.round(g)} s</text>`).join('');
  const xt = [x0, (x0 + x1) / 2, x1].map((t) => `<text x="${X(t)}" y="${H - 8}" text-anchor="middle">${comma(t, 2)} s</text>`).join('');
  return `<svg class="cv-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Temps de course selon le rythme">
    <rect x="${P.l}" y="${Y(-lim)}" width="${W - P.l - P.r}" height="${Y(0) - Y(-lim)}" class="cv-good"/>
    <line x1="${P.l}" x2="${W - P.r}" y1="${Y(0)}" y2="${Y(0)}" class="cv-zero"/>
    <path d="${path}" class="cv-line"/>
    <circle cx="${X(nom.t)}" cy="${Y(0)}" r="5" class="cv-nom"/>
    ${ticks}${xt}
    <text x="${P.l + 6}" y="${Y(-lim) + 14}" class="cv-lbl">plus rapide que le nominal</text>
  </svg>
  <p class="muted" style="font-size:.78rem;margin:2px 0 0">Temps de course gagné ou perdu si le rythme est tenu toute la course (le point vert = nominal). Au-dessus de la ligne : plus rapide que le nominal.</p>`;
}

function resultHtml() {
  const r = result;
  if (!r) return '';
  if (r.error) return `<p class="warnbox" style="margin-top:12px">${esc(r.error)}</p>`;
  const v = inputs();
  const sec = (x) => (Math.abs(x) < 0.05 ? '±0,0 s' : (x > 0 ? '+' : '−') + comma(Math.abs(x)) + ' s');
  const c = r.cfg.curve;
  return `
    <div class="calc-res">
      <p style="margin:12px 0 8px"><b>${CURVE_PROFILES[c.profile].label}</b> pour <b>${v.laps} tours</b> : nominale <b>${comma(c.nominalPct, 2)} %</b> par tour à ${comma(c.medianSec, 2)} s,
        pente <b>k = ${comma(c.k, 2)}</b>, plein en <b>${r.cfg.refuelPerSec} % / s</b>, passage par les stands +${comma(r.pitLoss, 2)} s (+ le remplissage).</p>
      <div class="table-wrap"><table class="calc-table">
        <thead><tr><th>Rythme</th><th>Tour</th><th>Conso</th><th>Tours / plein</th><th>Arrêts</th><th>Course</th><th>Écart</th></tr></thead>
        <tbody>${r.rows.map((x) => `<tr class="${x.name === 'Nominal' ? 'nom' : ''}">
          <td><b>${x.name}</b></td><td class="num">${comma(x.t, 2)} s</td><td class="num">${comma(x.pct, 1)} %</td><td class="num">${x.perTank}</td><td class="num">${x.stops}</td>
          <td class="num">${Math.floor(x.total / 60)} min ${comma(x.total % 60).padStart(4, '0')}</td>
          <td class="num ${x.gap < -0.05 ? 'good' : x.gap > 0.05 ? 'bad' : ''}">${x.name === 'Nominal' ? '—' : sec(x.gap)}</td></tr>`).join('')}</tbody>
      </table></div>
      ${chartSvg(r)}
      <p class="cv-mix">🔎 Meilleure stratégie possible pour un pilote malin : <b>${sec(r.bestMix.gap)}</b> sur le nominal (${esc(r.bestMix.desc)}, ${r.bestMix.stops} arrêt${r.bestMix.stops > 1 ? 's' : ''}).</p>
      <div class="calc-actions">
        <button class="btn primary" id="cvApply">✅ Appliquer ces réglages</button>
        <button class="btn" id="cvSave">💾 Sauvegarder ce setup</button>
      </div>
    </div>`;
}

export function bindCurve(c) {
  ctx = c;
  const { el, app } = ctx;
  const redraw = () => ctx.redraw();
  $$('[data-cvp]', el).forEach((b) => (b.onclick = async () => { st.profile = b.dataset.cvp; result = null; await saveSt(); redraw(); }));
  $('#cvTrack', el).onchange = async (e) => { st.trackId = e.target.value; st.auto = null; await saveSt(); redraw(); };
  const pick = $('#cvPick', el);
  pick.ontoggle = () => { pickOpen = pick.open; };
  $$('[data-cvd]', el).forEach((cb) => (cb.onchange = async () => {
    const set = new Set(present());
    if (cb.checked) set.add(cb.dataset.cvd); else set.delete(cb.dataset.cvd);
    st.drivers = [...set];
    await saveSt(); redraw();
  }));
  $('#cvAuto', el).onclick = async () => {
    const a = autoValues();
    if (!a.median && !a.best) { toast('Aucun tour enregistré pour ce circuit et ces pilotes', 2500); return; }
    st.auto = a;
    st.median = null; st.best = null; st.top10 = null; // les valeurs automatiques reprennent la main
    await saveSt(); redraw();
    toast(`⚡ Rempli : médian ${fmtS(a.median) || '—'} s · meilleur ${fmtS(a.best) || '—'} s · 10 meilleurs ${fmtS(a.top10) || '—'} s`, 3000);
  };
  $$('[data-cv]', el).forEach((inp) => (inp.onchange = async () => {
    const n = parseFloat(inp.value);
    st[inp.dataset.cv] = Number.isFinite(n) ? n : null;
    await saveSt(); redraw();
  }));
  $('#cvGo', el).onclick = () => {
    $('#cvRes', el).innerHTML = '<p class="muted" style="margin-top:12px">Calcul en cours…</p>';
    setTimeout(() => {
      result = optimizeCurve(inputs());
      $('#cvRes', el).innerHTML = resultHtml();
      bindResult();
    }, 30);
  };
  bindResult();
}

function bindResult() {
  const { el, app } = ctx;
  const ap = $('#cvApply', el);
  if (ap) ap.onclick = async () => {
    if (!(await confirmBox('Passer la consommation en formule continue avec ces réglages ?'))) return;
    const cfg = ctx.getCfg();
    Object.assign(cfg, structuredClone(result.cfg));
    result.applied = true;
    ctx.save();
    toast('✅ Réglage progressif appliqué');
  };
  const sv = $('#cvSave', el);
  if (sv) sv.onclick = async () => {
    if (!result?.applied) { toast('⚠️ Veuillez d\'abord appliquer les réglages', 2500); return; }
    const v = inputs();
    const name = await promptBox('Nom du setup', `${CURVE_PROFILES[v.profile].short} · ${v.laps} tours · ${v.stops} arrêt${v.stops > 1 ? 's' : ''}`, 'Ex. Course 50 tours, Soirée entre amis…');
    if (!name) return;
    const list = await app.fuelSetups('curve');
    if (list.some((s) => s.name.toLowerCase() === name.toLowerCase())
      && !(await confirmBox(`Un setup « ${name} » existe déjà. Le remplacer ?`))) return;
    await app.saveFuelCfg(ctx.getCfg());
    await app.saveFuelSetup(name, null, {}, 'curve');
    toast(`💾 Setup « ${name} » enregistré`);
    await ctx.refreshAll();
  };
}
