// Réglages → Essence : trois sous-onglets (Consommation, Temps de référence = fourchettes, Formule continue).
//  - Consommation : activer la simulation, consommation nominale par tour, ravitaillement.
//  - Temps de référence : 9 fourchettes de temps au tour (nominale + 4 rapides + 4 lentes),
//    chacune réglable (2-30 s, 1-40 %) et activable/désactivable.

import { esc, $, $$, toast, confirmBox, promptBox } from '../ui.js';
import { LIMITS, activeBands } from '../fuel.js';
import { optimizeFuel, bestOfDrivers, raceMedianOf, median } from '../fuel-calc.js';
import { curveHtml, bindCurve, loadCurveState, lapsTip, curveIntro } from './fuel-curve.js';

let app;
let el;
let sub = 'general';
let cfg;           // copie de travail
let saveTimer = null;
let lapsCache = [];  // tours enregistrés (record, temps médians)
let calc = {};       // saisies du calculateur (gardées d'une fois sur l'autre)
let calcResult = null;
let driversOpen = false; // liste « Pilotes présents » dépliée ?
let calcOpen = false;    // menu « Calcul automatique des valeurs » déplié ?
let manualOpen = false;  // menu « Temps des paliers / réglage manuel » déplié ?

/** Prochain affichage : ouvrir directement ce sous-onglet ('conso', 'ref' ou 'curve'). */
export function openFuelTab(t) { sub = t; }

export async function renderFuel(container, a) {
  app = a;
  el = container;
  cfg = structuredClone(app.fuelCfg);
  await loadSetups();
  lapsCache = await app.db.all('laps');
  calc = await app.db.getSetting('fuelCalc', {});
  await loadCurveState(app);
  draw();
}

function save(redraw = false) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await app.saveFuelCfg(cfg);
    cfg = structuredClone(app.fuelCfg); // valeurs corrigées (bornes)
    if (redraw) draw(); else { updateLive(); updateSetupState(); }
  }, 250);
}

// ---------- Setups (réglages nommés) ----------

let setups = [];
let activeId = null;

const strip = (c) => { const { enabled, ...rest } = c; return JSON.stringify(rest); };

/** Setups de l'onglet affiché : Formule continue, ou Temps de référence (fourchettes). */
const setupsMode = () => (sub === 'curve' ? 'curve' : 'bands');

async function loadSetups() {
  setups = await app.fuelSetups(setupsMode());
  activeId = await app.activeFuelSetup(setupsMode());
}

function setupsHtml() {
  const active = setups.find((s) => s.id === activeId);
  const modified = active && strip(active.cfg) !== strip(app.fuelCfg);
  return `
  <section class="panel setups">
    <div class="setups-head">
      <h2 style="margin:0">💾 Setups ${setupsMode() === 'curve' ? 'Progressif' : 'Paliers'}</h2>
      <span class="setup-state">${active
        ? `Actif : <b>${esc(active.name)}</b>${modified ? ' <span class="badge mod">modifié</span>' : ' <span class="badge ok">enregistré</span>'}`
        : '<span class="muted">Réglage actuel non enregistré</span>'}</span>
    </div>
    <div class="row" style="gap:8px;margin-top:10px">
      <select id="suSel" style="flex:1;min-width:160px" title="Choisir un setup le charge aussitôt">
        ${setups.length ? setups.map((s) => `<option value="${esc(s.id)}" ${s.id === activeId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')
          : '<option value="">— aucun setup enregistré —</option>'}
      </select>
      <button class="btn small primary" id="suSave" ${active ? '' : 'disabled'} title="Écraser le setup actif avec les réglages actuels">💾 Enregistrer</button>
      <button class="btn small" id="suSaveAs">Enregistrer sous…</button>
      <button class="btn small ghost" id="suRename" ${setups.length ? '' : 'disabled'} title="Renommer le setup sélectionné">✎</button>
      <button class="btn small ghost danger" id="suDel" ${setups.length ? '' : 'disabled'} title="Supprimer le setup sélectionné">🗑</button>
    </div>
  </section>`;
}

function bindSetups() {
  const sel = () => $('#suSel', el).value;
  const name = (id) => setups.find((s) => s.id === id)?.name || '';
  // choisir un setup dans la liste le charge aussitôt
  $('#suSel', el).onchange = async () => {
    const id = sel();
    if (!id) return;
    const active = setups.find((s) => s.id === activeId);
    if (active && strip(active.cfg) !== strip(app.fuelCfg) && id !== activeId
      && !(await confirmBox(`Tes modifications sur « ${active.name} » ne sont pas enregistrées. Charger « ${name(id)} » quand même ?`))) {
      $('#suSel', el).value = activeId || '';
      return;
    }
    await app.loadFuelSetup(id);
    cfg = structuredClone(app.fuelCfg);
    toast(`Setup « ${name(id)} » chargé`);
    await refreshAll();
  };
  $('#suSave', el).onclick = async () => {
    const active = setups.find((s) => s.id === activeId);
    if (!active) return;
    await app.saveFuelCfg(cfg);
    await app.saveFuelSetup(active.name, active.id, {}, setupsMode());
    toast(`Setup « ${active.name} » enregistré`);
    await refreshAll();
  };
  $('#suSaveAs', el).onclick = async () => {
    const n = await promptBox('Nom du setup', '', 'Ex. Course 50 tours, Pluie, Débutants…');
    if (!n) return;
    if (setups.some((s) => s.name.toLowerCase() === n.toLowerCase())
      && !(await confirmBox(`Un setup « ${n} » existe déjà. Le remplacer ?`))) return;
    await app.saveFuelCfg(cfg);
    await app.saveFuelSetup(n, null, {}, setupsMode());
    toast(`Setup « ${n} » enregistré`);
    await refreshAll();
  };
  $('#suRename', el).onclick = async () => {
    const id = sel();
    const n = await promptBox('Renommer le setup', name(id));
    if (!n) return;
    await app.renameFuelSetup(id, n);
    await refreshAll();
  };
  $('#suDel', el).onclick = async () => {
    const id = sel();
    if (!(await confirmBox(`Supprimer le setup « ${name(id)} » ? Les réglages en cours ne changent pas.`))) return;
    await app.deleteFuelSetup(id);
    await refreshAll();
  };
}

async function refreshAll() {
  await loadSetups();
  draw();
}

/** Ce que l'onglet Formule continue utilise de cet écran. */
function curveCtx() {
  return { app, el, laps: lapsCache, getCfg: () => cfg, save: () => save(true), redraw: draw, refreshAll };
}

function draw() {
  el.innerHTML = `
  <div class="subtabs small">
    <button data-sub="general" class="${sub === 'general' ? 'on' : ''}">Général</button>
    <button data-sub="conso" class="${sub === 'conso' ? 'on' : ''}">Fixe</button>
    <button data-sub="ref" class="${sub === 'ref' ? 'on' : ''}">Paliers</button>
    <button data-sub="curve" class="${sub === 'curve' ? 'on' : ''}">Progressif</button>
  </div>
  ${sub === 'general' ? generalHtml() : sub === 'conso' ? consoHtml() : sub === 'curve' ? '<div class="dev-banner">🚧 En cours de développement</div>' + curveIntro() + setupsHtml() + curveHtml(curveCtx()) : refIntro() + setupsHtml() + refHtml()}`;
  $$('[data-sub]', el).forEach((b) => (b.onclick = async () => { sub = b.dataset.sub; await loadSetups(); draw(); }));
  if (sub === 'conso' || sub === 'general') bindConso();
  else if (sub === 'curve') bindCurve(curveCtx());
  else { bindRef(); bindCalc(); }
  if (sub !== 'conso' && sub !== 'general') bindSetups(); // setups d'essence : pas dans « Consommation »
  updateLive();
}

/** Met à jour l'état "modifié / enregistré" sans tout redessiner. */
function updateSetupState() {
  const box = el && $('.setup-state', el);
  if (!box) return;
  const active = setups.find((s) => s.id === activeId);
  const modified = active && strip(active.cfg) !== strip(app.fuelCfg);
  box.innerHTML = active
    ? `Actif : <b>${esc(active.name)}</b>${modified ? ' <span class="badge mod">modifié</span>' : ' <span class="badge ok">enregistré</span>'}`
    : '<span class="muted">Réglage actuel non enregistré</span>';
}

// ---------- Sous-onglet Consommation ----------

/** Onglet Général : réglages valables pour tous les modes de consommation. */
function generalHtml() {
  return `
  <div class="grid grid-2">
    <section class="panel">
      <h2>⛽ Panne sèche (0 %)</h2>
      <p class="muted" style="margin-top:-6px;font-size:.88rem">Vitesse de la voiture quand son réservoir est vide, jusqu'à ce qu'elle ravitaille au stand.</p>
      <div class="bar" style="--c:var(--yellow);--p:${Math.round((cfg.emptySpeedFixed / 15) * 100)}%;margin-top:14px">
        <span class="bar-l">Vitesse</span>
        <input type="range" id="fEmptyFix" min="0" max="15" step="1" value="${cfg.emptySpeedFixed}">
        <span class="bar-v num" id="fEmptyFixV">${Math.round((cfg.emptySpeedFixed / 15) * 100)} %</span>
      </div>
      <p class="muted" style="font-size:.85rem;margin-bottom:0">Toutes les voitures à sec roulent à cette vitesse, quel que soit le mode.</p>
    </section>

    <section class="panel">
      <h2>Annonce « réserve »</h2>
      <label class="field">Annonce vocale quand l'essence passe sous (%)
        <input type="number" id="fLow" min="0" max="50" value="${cfg.lowWarnPct}" style="width:120px"></label>
      <p class="muted" style="font-size:.85rem;margin:6px 0 0">Valable pour tous les modes : Fixe, Paliers et Progressif.</p>
    </section>
  </div>`;
}

/** Onglet Fixe : consommation fixe par tour et ravitaillement, quand la course est en mode Fixe. */
function consoHtml() {
  return `
  <div class="grid grid-2">
    <section class="panel">
      <h2>Consommation fixe</h2>
      <div class="fuel-nominal">
        <input type="range" id="fNomR" step="0.5" min="${LIMITS.pMin}" max="${LIMITS.pMax}" value="${cfg.nominalPct}">
        <div class="fuel-nominal-v"><input type="number" id="fNom" step="0.5" min="${LIMITS.pMin}" max="${LIMITS.pMax}" value="${cfg.nominalPct}"> % / tour</div>
      </div>
      <p class="muted" id="fAutonomy" style="margin:8px 0 0"></p>
      <p class="muted" style="font-size:.85rem;margin:6px 0 0">Utilisée quand la préparation de course est sur <b>Fixe</b> : chaque tour consomme cette valeur, quel que soit le temps.</p>
    </section>

    <section class="panel">
      <h2>Ravitaillement</h2>
      <label class="field">Ravitaillement au stand (% par seconde)
        <input type="number" id="fRefuel" min="1" max="100" value="${cfg.refuelPerSec}" style="width:120px"></label>
      <p class="muted" style="font-size:.85rem;margin:6px 0 0">Une voiture dans la voie des stands se remplit à cette vitesse jusqu'à son réservoir. En Paliers et en Progressif, le calcul automatique la règle lui-même.</p>
    </section>
  </div>`;
}

function bindConso() {
  const setNom = (v) => {
    cfg.nominalPct = Math.round(Math.min(LIMITS.pMax, Math.max(LIMITS.pMin, +v || LIMITS.pMin)) * 2) / 2;
    $('#fNomR', el).value = cfg.nominalPct;
    $('#fNom', el).value = cfg.nominalPct;
    save();
  };
  if ($('#fNomR', el)) {
    $('#fNomR', el).oninput = (e) => setNom(e.target.value);
    $('#fNom', el).onchange = (e) => setNom(e.target.value);
  }
  const rf = $('#fRefuel', el);
  if (rf) rf.onchange = (e) => { cfg.refuelPerSec = +e.target.value; save(true); };
  const lw = $('#fLow', el);
  if (lw) lw.onchange = (e) => { cfg.lowWarnPct = +e.target.value; save(true); };
  const fixIn = $('#fEmptyFix', el);
  if (fixIn) fixIn.oninput = () => {
    cfg.emptySpeedFixed = +fixIn.value;
    const pc = Math.round((cfg.emptySpeedFixed / 15) * 100);
    fixIn.parentElement.style.setProperty('--p', pc + '%');
    $('#fEmptyFixV', el).textContent = pc + ' %';
    save();
  };
}

// ---------- Sous-onglet Temps de référence ----------

/** Lignes dans l'ordre d'affichage : plus rapide en haut, plus lent en bas. */
function rows() {
  return [
    ...[3, 2, 1, 0].map((i) => ({ kind: 'faster', i, label: `Rapide ${i + 1}`, b: cfg.faster[i] })),
    { kind: 'nominal', label: 'Nominale', b: { on: true, min: cfg.nominal.min, max: cfg.nominal.max, pct: cfg.nominalPct } },
    ...[0, 1, 2, 3].map((i) => ({ kind: 'slower', i, label: `Lent ${i + 1}`, b: cfg.slower[i] })),
  ];
}

// ---------- Calcul automatique des valeurs (calculateur d'équilibrage) ----------

/** Temps médian d'un pilote : ses 30 derniers tours de course sur ce circuit, sinon la case de son profil. */
function driverMedian(d) {
  const r = raceMedianOf(lapsCache, d.id, calcTrack());
  if (r) return { sec: r.sec, laps: r.laps, src: `${r.laps} tours` };
  if (d.raceMedian > 0) return { sec: d.raceMedian, laps: 0, src: 'profil' };
  return null;
}

/** Conseil affiché si un pilote coché a moins de 30 tours de course récents sur ce circuit. */
function recentTip() {
  return lapsTip(app, calcAuto().present, (id) => raceMedianOf(lapsCache, id, calcTrack())?.laps || 0);
}

/** Valeurs automatiques : record du circuit, temps médian des pilotes cochés. */
/** Circuit du calcul : celui choisi ici, sinon celui de la préparation de course. */
function calcTrack() {
  return app.track(calc.trackId) ? calc.trackId : app.setup?.trackId;
}

function calcAuto() {
  const present = calc.drivers || (app.setup?.slots || []).filter((s) => s.active && s.driverId).map((s) => s.driverId);
  const meds = app.data.drivers.filter((d) => present.includes(d.id)).map((d) => driverMedian(d)?.sec);
  const m = median(meds);
  return { present, record: bestOfDrivers(lapsCache, present, calcTrack()), median: m === null ? null : Math.round(m * 100) / 100 };
}

function calcInputs() {
  const a = calcAuto();
  return {
    record: calc.record ?? a.record,
    median: calc.median ?? a.median,
    pitLap: calc.pitLap ?? null,
    laps: calc.laps ?? 50,
    stops: calc.stops ?? 1,
  };
}

const fmtS = (s) => (s === null || s === undefined ? '' : (+s).toFixed(2));

function calcHtml() {
  const a = calcAuto();
  const v = calcInputs();
  const pitLoss = v.pitLap && v.median ? v.pitLap - v.median : null;
  return `
  <section class="panel">
    <details class="calc-box" id="calcBox" ${calcOpen ? 'open' : ''}>
    <summary><h2 style="margin:0">🧮 Calcul automatique des fourchettes</h2></summary>
    <p class="muted" style="margin:8px 0 12px;font-size:.88rem">Calcule les fourchettes pour équilibrer au mieux ta course.</p>
    <label class="row calc-track">📍 Circuit
      <select id="calcTrack">${app.data.tracks.map((t) => `<option value="${esc(t.id)}" ${t.id === calcTrack() ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select>
    </label>
    ${recentTip()}
    <details class="calc-pick" id="calcPick" ${driversOpen ? 'open' : ''}>
      <summary>
        <span class="calc-pick-title">👉 Choisir les pilotes présents <b>(${a.present.filter((id) => app.driver(id)).length})</b></span>
        <span class="calc-pick-must">À faire en premier : le calcul se base sur eux</span>
        <span class="calc-pick-names">${a.present.map((id) => app.driver(id)?.name).filter(Boolean).map(esc).join(', ') || 'aucun'}</span>
      </summary>
      <div class="calc-drivers">
        ${app.data.drivers.map((d) => `<label class="calc-drv" style="--dc:${esc(d.color)}"><input type="checkbox" data-cd="${esc(d.id)}" ${a.present.includes(d.id) ? 'checked' : ''}><span>${esc(d.name)}</span></label>`).join('') || '<span class="muted">Aucun pilote</span>'}
      </div>
    </details>
    <button class="btn small calc-fill" id="calcAuto">⚡ Remplissage automatique</button>
    <p class="muted" style="font-size:.8rem;margin:4px 0 12px">Choisis le circuit et coche les pilotes présents, puis touche ce bouton : le meilleur tour des pilotes cochés et leur temps médian (sur leurs 30 derniers tours de course) se remplissent tout seuls.</p>
    <div class="calc-grid">
      <label class="field"><span class="calc-l">Meilleur tour (s)<em>des pilotes cochés · cale les paliers rapides</em></span>
        <input type="number" step="0.01" min="1" max="60" data-ci="record" value="${fmtS(v.record)}" placeholder="${a.record ? 'auto : ' + fmtS(a.record) : 'à saisir'}">
        <small class="muted">${a.record ? 'Auto : ' + fmtS(a.record) + ' s' : 'Aucun tour enregistré'}</small></label>
      <label class="field"><span class="calc-l">Temps médian (s)<em>adapte aux pilotes présents</em></span>
        <input type="number" step="0.01" min="1" max="60" data-ci="median" value="${fmtS(v.median)}" placeholder="${a.median ? 'auto : ' + fmtS(a.median) : 'à saisir'}">
        <small class="muted">${a.median ? 'Auto : ' + fmtS(a.median) + ' s (30 derniers tours)' : 'Coche des pilotes ou saisis-le'}</small></label>
      <label class="field"><span class="calc-l">Tour avec arrêt au stand (s)<em>calcule le coût d’un arrêt</em></span>
        <input type="number" step="0.01" min="1" max="60" data-ci="pitLap" value="${fmtS(v.pitLap)}" placeholder="à saisir">
        <small class="muted">Chronomètre un tour où tu passes par les stands, t'arrêtes et repars aussitôt, <b>sans attendre le plein</b> : le temps de remplissage est calculé à part (essence à remettre ÷ vitesse de remplissage).${pitLoss !== null ? ` Ici, passer par les stands coûte <b>${pitLoss.toFixed(2)} s</b> de plus qu'un tour normal.` : ''}</small></label>
      <label class="field"><span class="calc-l">Nombre de tours<em>voulu par l’utilisateur · règle la taille du plein</em></span>
        <input type="number" step="1" min="5" max="500" data-ci="laps" value="${v.laps}"></label>
      <label class="field"><span class="calc-l">Arrêts souhaités<em>au rythme nominal</em></span>
        <input type="number" step="1" min="0" max="20" data-ci="stops" value="${v.stops}"></label>
    </div>
    ${calc.record != null || calc.median != null ? `<p class="warnbox" style="margin-top:12px">✍️ Valeurs saisies à la main : le calcul sera approximatif. <b>Conseil :</b> faites une <b>Course rapide de 30 tours</b> avec les pilotes, puis revenez ici et touchez <b>⚡ Remplissage automatique</b>.</p>` : ''}
    <div class="row" style="gap:8px;margin-top:12px">
      <button class="btn primary" id="calcGo">🧮 Calculer</button>
    </div>
    <div id="calcRes">${calcResultHtml()}</div>
    </details>
  </section>`;
}

function calcResultHtml() {
  const r = calcResult;
  if (!r) return '';
  if (r.error) return `<p class="warnbox" style="margin-top:12px">${esc(r.error)}</p>`;
  const sec = (x) => x.toFixed(1).replace('.', ',') + ' s';
  const v = calcInputs();
  return `
    <div class="calc-res">
      <p style="margin:12px 0 8px">Pour <b>${v.laps} tours</b> : plein en <b>${r.cfg.refuelPerSec} % / s</b>, chaque arrêt coûte <b>${r.pitLoss.toFixed(2)} s</b> de passage par les stands + le temps de remplissage. Temps de course de chaque rythme, s'il est tenu toute la course :</p>
      <div class="table-wrap"><table class="calc-table">
        <thead><tr><th>Rythme</th><th>Temps au tour</th><th>Conso</th><th>Tours / plein</th><th>Arrêts</th><th>Course</th><th>Écart</th></tr></thead>
        <tbody>${r.rows.map((x) => `<tr class="${x.name === 'Nominale' ? 'nom' : ''}">
          <td><b>${x.name}</b></td><td class="num">${x.min.toFixed(2)} – ${x.name.startsWith('Lent') && x === r.rows[r.rows.length - 1] ? '…' : x.max.toFixed(2)}</td>
          <td class="num">${String(x.pct).replace('.', ',')} %</td><td class="num">${x.perTank}</td><td class="num">${x.stops}</td>
          <td class="num">${Math.floor(x.total / 60)} min ${(x.total % 60).toFixed(1).padStart(4, '0').replace('.', ',')}</td>
          <td class="num ${x.gap < -0.05 ? 'good' : x.gap > 0.05 ? 'bad' : ''}">${x.name === 'Nominale' ? '—' : (x.gap >= 0 ? '+' : '−') + sec(Math.abs(x.gap))}</td></tr>`).join('')}</tbody>
      </table></div>
      <p class="muted" style="font-size:.8rem;margin:6px 0 10px">Pilote régulier, sans sortie de piste ni VSC : à vérifier sur la piste. Les fourchettes non gardées seront désactivées.</p>
      <div class="calc-actions">
        <button class="btn primary" id="calcApply">✅ Appliquer ces réglages</button>
        <button class="btn" id="calcSave">💾 Sauvegarder ce setup</button>
      </div>
    </div>`;
}

async function saveCalc() { await app.db.setSetting('fuelCalc', calc, { quiet: true }); }

function bindCalc() {
  const box = $('#calcBox', el);
  if (box) box.ontoggle = () => { calcOpen = box.open; };
  const pick = $('#calcPick', el);
  if (pick) pick.ontoggle = () => { driversOpen = pick.open; };
  $$('[data-cd]', el).forEach((c) => (c.onchange = async () => {
    const set = new Set(calcAuto().present);
    if (c.checked) set.add(c.dataset.cd); else set.delete(c.dataset.cd);
    calc.drivers = [...set];
    calc.median = null; // le temps médian suit les pilotes cochés
    await saveCalc();
    draw();
  }));
  $$('[data-ci]', el).forEach((inp) => (inp.onchange = async () => {
    const n = parseFloat(inp.value);
    calc[inp.dataset.ci] = Number.isFinite(n) ? n : null;
    await saveCalc();
    draw();
  }));
  $('#calcTrack', el).onchange = async (e) => { calc.trackId = e.target.value; await saveCalc(); draw(); };
  $('#calcAuto', el).onclick = async () => {
    // reprend les valeurs calculées sur les tours enregistrés (circuit + pilotes cochés)
    calc.record = null;
    calc.median = null;
    await saveCalc();
    draw();
    const a = calcAuto();
    if (!a.record && !a.median) toast('Aucun tour enregistré pour ce circuit et ces pilotes', 2500);
    else toast(`⚡ Rempli : ${a.record ? 'meilleur tour ' + fmtS(a.record) + ' s' : 'pas de meilleur tour'} · ${a.median ? 'temps médian ' + fmtS(a.median) + ' s' : 'pas de temps médian'}`, 2500);
  };
  $('#calcGo', el).onclick = () => {
    $('#calcRes', el).innerHTML = '<p class="muted" style="margin-top:12px">Calcul en cours…</p>';
    setTimeout(() => { // laisse l'écran afficher « Calcul en cours » avant de calculer
      calcResult = optimizeFuel(calcInputs());
      $('#calcRes', el).innerHTML = calcResultHtml();
      bindApply();
    }, 30);
  };
  bindApply();
}

function bindApply() {
  const b = $('#calcApply', el);
  if (!b) return;
  b.onclick = async () => {
    if (!(await confirmBox('Remplacer tes fourchettes, tes consommations et la vitesse de remplissage par ce réglage ?'))) return;
    Object.assign(cfg, structuredClone(calcResult.cfg));
    calcResult.applied = true; // le bouton « Sauvegarder ce setup » apparaît à droite
    save(true);
    toast('✅ Réglage du calculateur appliqué');
  };
  const sv = $('#calcSave', el);
  if (sv) sv.onclick = async () => {
    if (!calcResult?.applied) { toast("⚠️ Veuillez d'abord appliquer les réglages", 2500); return; }
    const v = calcInputs();
    const name = await promptBox('Nom du setup', `${v.laps} tours · ${v.stops} arrêt${v.stops > 1 ? 's' : ''}`, 'Ex. Course 50 tours, Soirée entre amis…');
    if (!name) return;
    if (setups.some((s) => s.name.toLowerCase() === name.toLowerCase())
      && !(await confirmBox(`Un setup « ${name} » existe déjà. Le remplacer ?`))) return;
    clearTimeout(saveTimer);
    await app.saveFuelCfg(cfg);   // réglages appliqués, enregistrés tout de suite
    await app.saveFuelSetup(name, null, {}, 'bands');
    toast(`💾 Setup « ${name} » enregistré`);
    await refreshAll();
  };
}

/** Explication affichée en entrant dans l'onglet Paliers. */
function refIntro() {
  return `<p class="tab-intro">Plus le tour est rapide, plus il consomme. Le calcul automatique équilibre le tout : au rythme normal, tu fais les arrêts prévus ; attaquer coûte de l'essence.</p>`;
}

function refHtml() {
  return calcHtml() + `
  <section class="panel" style="margin-top:14px">
    <details class="calc-box" id="manualBox" ${manualOpen ? 'open' : ''}>
    <summary><h2 style="margin:0">✍️ Paliers / réglage manuel</h2></summary>
    <p class="muted" style="margin:10px 0 12px;font-size:.88rem">
      Si le tour est bouclé dans une fourchette, on retire son pourcentage d'essence.
      Plus rapide que toutes les fourchettes : on prend la plus rapide ; plus lent que toutes : la plus lente.
      Un temps qui tombe dans une fourchette désactivée compte comme nominal.
      Bornes : ${LIMITS.tMin} à ${LIMITS.tMax} s, ${LIMITS.pMin} à ${LIMITS.pMax} %.
    </p>
    ${cfg.mode === 'fixed' ? '<p class="warnbox">Le calcul est réglé sur <b>Fixe</b> (préparation de course) : ces fourchettes ne sont pas utilisées pour l\'instant.</p>' : ''}
    <div class="bands">
      <div class="band head"><span></span><span>Fourchette</span><span>De (s)</span><span>À (s)</span><span>Conso</span><span></span></div>
      ${rows().map((r) => `
      <div class="band ${r.kind} ${r.b.on ? '' : 'off'}" data-kind="${r.kind}" data-i="${r.i ?? ''}">
        <span>${r.kind === 'nominal' ? '<span class="band-dot"></span>' : `<input type="checkbox" data-f="on" ${r.b.on ? 'checked' : ''} title="Activer / désactiver">`}</span>
        <span class="band-name">${r.label}</span>
        <input type="number" data-f="min" step="0.01" min="${LIMITS.tMin}" max="${LIMITS.tMax}" value="${r.b.min}">
        <input type="number" data-f="max" step="0.01" min="${LIMITS.tMin}" max="${LIMITS.tMax}" value="${r.b.max}">
        <span class="band-pct"><input type="number" data-f="pct" step="0.5" min="${LIMITS.pMin}" max="${LIMITS.pMax}" value="${r.b.pct}"> %</span>
        <span class="band-warn" data-warn></span>
      </div>`).join('')}
    </div>
    <div class="band-scale" id="bandScale"></div>
    </details>
  </section>`;
}

function bindRef() {
  const mb = $('#manualBox', el);
  if (mb) mb.ontoggle = () => { manualOpen = mb.open; };
  $$('.band[data-kind]', el).forEach((row) => {
    const kind = row.dataset.kind;
    const i = row.dataset.i === '' ? null : +row.dataset.i;
    $$('[data-f]', row).forEach((input) => {
      input.addEventListener('change', () => {
        const f = input.dataset.f;
        const v = f === 'on' ? input.checked : +input.value;
        if (kind === 'nominal') {
          if (f === 'pct') cfg.nominalPct = v;
          else cfg.nominal[f] = v;
        } else {
          cfg[kind][i][f] = v;
        }
        if (f === 'on') row.classList.toggle('off', !v);
        save(true);
      });
    });
  });
}

/** Avertissements, échelle visuelle, autonomie : mis à jour sans tout redessiner. */
function updateLive() {
  if (!el) return;
  const aut = $('#fAutonomy', el);
  if (aut) aut.innerHTML = `Avec un réservoir plein, environ <b>${Math.floor(100 / cfg.nominalPct)} tours</b> au rythme nominal.`;

  // contrôles de cohérence par ligne
  const all = rows();
  $$('.band[data-kind]', el).forEach((row, idx) => {
    const r = all[idx];
    const w = $('[data-warn]', row);
    let msg = '';
    if (r.b.max <= r.b.min) msg = '« À » doit être plus grand que « De »';
    else if (r.b.on) {
      const overlap = all.find((o, j) => j !== idx && o.b.on && o.b.max > o.b.min && r.b.min < o.b.max && o.b.min < r.b.max);
      if (overlap) msg = `chevauche ${overlap.label}`;
    }
    w.textContent = msg ? '⚠️ ' + msg : '';
    row.classList.toggle('bad', !!msg);
  });

  // échelle visuelle
  const sc = $('#bandScale', el);
  if (sc) {
    const bands = activeBands(cfg);
    if (bands.length) {
      const lo = bands[0].min, hi = bands[bands.length - 1].max, span = hi - lo || 1;
      sc.innerHTML = bands.map((b) => {
        const left = ((b.min - lo) / span) * 100, width = ((b.max - b.min) / span) * 100;
        const hue = b.name === 'Nominale' ? 'var(--green)' : b.pct > cfg.nominalPct ? 'var(--accent-2)' : 'var(--blue)';
        return `<i style="left:${left}%;width:${width}%;background:${hue}" title="${esc(b.name)} : ${b.min}-${b.max} s → ${b.pct} %"><span>${b.pct}%</span></i>`;
      }).join('') + `<em style="left:0">${lo.toFixed(2)} s</em><em style="right:0">${hi.toFixed(2)} s</em>`;
    } else sc.innerHTML = '';
  }

}
