// Réglages → Essence : deux sous-onglets.
//  - Consommation : activer la simulation, consommation nominale par tour, ravitaillement.
//  - Temps de référence : 9 fourchettes de temps au tour (nominale + 4 rapides + 4 lentes),
//    chacune réglable (2-30 s, 1-40 %) et activable/désactivable.

import { esc, $, $$, toast, confirmBox, promptBox } from '../ui.js';
import { LIMITS, defaultFuelConfig, consumption, activeBands, balancedPreset } from '../fuel.js';

let app;
let el;
let sub = 'conso';
let cfg;           // copie de travail
let saveTimer = null;

export async function renderFuel(container, a) {
  app = a;
  el = container;
  cfg = structuredClone(app.fuelCfg);
  await loadSetups();
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

async function loadSetups() {
  setups = await app.fuelSetups();
  activeId = await app.db.getSetting('fuelActiveSetup', null);
}

function setupsHtml() {
  const active = setups.find((s) => s.id === activeId);
  const modified = active && strip(active.cfg) !== strip(app.fuelCfg);
  return `
  <section class="panel setups">
    <div class="setups-head">
      <h2 style="margin:0">💾 Setups d'essence</h2>
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
    await app.saveFuelSetup(active.name, active.id);
    toast(`Setup « ${active.name} » enregistré`);
    await refreshAll();
  };
  $('#suSaveAs', el).onclick = async () => {
    const n = await promptBox('Nom du setup', '', 'Ex. Course 50 tours, Pluie, Débutants…');
    if (!n) return;
    if (setups.some((s) => s.name.toLowerCase() === n.toLowerCase())
      && !(await confirmBox(`Un setup « ${n} » existe déjà. Le remplacer ?`))) return;
    await app.saveFuelCfg(cfg);
    await app.saveFuelSetup(n);
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

function draw() {
  el.innerHTML = setupsHtml() + `
  <div class="subtabs small">
    <button data-sub="conso" class="${sub === 'conso' ? 'on' : ''}">Consommation</button>
    <button data-sub="ref" class="${sub === 'ref' ? 'on' : ''}">Temps de référence</button>
  </div>
  ${sub === 'conso' ? consoHtml() : refHtml()}`;
  $$('[data-sub]', el).forEach((b) => (b.onclick = () => { sub = b.dataset.sub; draw(); }));
  if (sub === 'conso') bindConso(); else bindRef();
  bindSetups();
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

function consoHtml() {
  return `
  <div class="grid grid-2">
    <section class="panel">
      <h2>Essence simulée</h2>
      <label class="row"><input type="checkbox" id="fEnabled" ${cfg.enabled ? 'checked' : ''}> Activer la gestion de l'essence pendant les sessions</label>
      <p class="muted" style="font-size:.85rem">Chaque voiture part avec le <b>réservoir</b> réglé au garage (barre bleue) et consomme à chaque tour. La jauge s'affiche sur l'écran de course.</p>
      <h3>Calcul de la consommation</h3>
      <div class="seg" id="fMode">
        <button data-mode="bands" class="${cfg.mode === 'bands' ? 'on' : ''}">Selon le temps au tour</button>
        <button data-mode="fixed" class="${cfg.mode === 'fixed' ? 'on' : ''}">Fixe</button>
      </div>
      <p class="muted" style="font-size:.85rem;margin-bottom:0">${cfg.mode === 'bands'
        ? 'Plus on roule vite, plus on consomme : voir l\'onglet « Temps de référence ».'
        : 'Chaque tour consomme la valeur nominale, quel que soit le temps.'}</p>
    </section>

    <section class="panel">
      <h2>Consommation nominale</h2>
      <div class="fuel-nominal">
        <input type="range" id="fNomR" min="${LIMITS.pMin}" max="${LIMITS.pMax}" value="${cfg.nominalPct}">
        <div class="fuel-nominal-v"><input type="number" id="fNom" min="${LIMITS.pMin}" max="${LIMITS.pMax}" value="${cfg.nominalPct}"> % / tour</div>
      </div>
      <p class="muted" id="fAutonomy" style="margin:8px 0 0"></p>
    </section>

    <section class="panel">
      <h2>Stand et alertes</h2>
      <div class="row" style="gap:16px">
        <label class="field">Ravitaillement au stand (% par seconde)
          <input type="number" id="fRefuel" min="1" max="100" value="${cfg.refuelPerSec}" style="width:120px"></label>
        <label class="field">Annonce « réserve » sous (%)
          <input type="number" id="fLow" min="0" max="50" value="${cfg.lowWarnPct}" style="width:120px"></label>
      </div>
      <p class="muted" style="font-size:.85rem;margin-bottom:0">Une voiture dans la voie des stands se remplit jusqu'à son réservoir.</p>
    </section>

    <section class="panel">
      <h2>⛽ Panne sèche (0 %)</h2>
      <p class="muted" style="margin-top:-6px;font-size:.88rem">Vitesse de la voiture quand son réservoir est vide, jusqu'à ce qu'elle ravitaille au stand.</p>
      <div class="seg" id="fEmptyMode">
        <button data-em="pct" class="${cfg.emptyMode === 'pct' ? 'on' : ''}">% de sa vitesse</button>
        <button data-em="fixed" class="${cfg.emptyMode === 'fixed' ? 'on' : ''}">Vitesse fixe</button>
      </div>
      ${cfg.emptyMode === 'pct' ? `
      <div class="bar" style="--c:var(--yellow);--p:${cfg.emptySpeedPct}%;margin-top:14px">
        <span class="bar-l">Vitesse</span>
        <input type="range" id="fEmptyPct" min="10" max="100" step="5" value="${cfg.emptySpeedPct}">
        <span class="bar-v num" id="fEmptyPctV">${cfg.emptySpeedPct} %</span>
      </div>
      <p class="muted" style="font-size:.85rem;margin-bottom:0">Ex. 40 % : une voiture réglée à 80 % au garage tombe à 32 %. 100 % = pas de pénalité.</p>`
      : `
      <div class="bar" style="--c:var(--yellow);--p:${Math.round((cfg.emptySpeedFixed / 15) * 100)}%;margin-top:14px">
        <span class="bar-l">Vitesse</span>
        <input type="range" id="fEmptyFix" min="0" max="15" step="1" value="${cfg.emptySpeedFixed}">
        <span class="bar-v num" id="fEmptyFixV">${Math.round((cfg.emptySpeedFixed / 15) * 100)} %</span>
      </div>
      <p class="muted" style="font-size:.85rem;margin-bottom:0">Toutes les voitures à sec roulent à cette vitesse (même échelle que la barre verte du garage), quel que soit leur réglage. Une voiture déjà réglée plus lentement garde sa vitesse.</p>`}
    </section>
  </div>`;
}

function bindConso() {
  $('#fEnabled', el).onchange = (e) => { cfg.enabled = e.target.checked; save(); };
  $$('[data-mode]', el).forEach((b) => (b.onclick = () => { cfg.mode = b.dataset.mode; save(); draw(); }));
  const setNom = (v) => {
    cfg.nominalPct = Math.round(Math.min(LIMITS.pMax, Math.max(LIMITS.pMin, +v || LIMITS.pMin)));
    $('#fNomR', el).value = cfg.nominalPct;
    $('#fNom', el).value = cfg.nominalPct;
    save();
  };
  $('#fNomR', el).oninput = (e) => setNom(e.target.value);
  $('#fNom', el).onchange = (e) => setNom(e.target.value);
  $('#fRefuel', el).onchange = (e) => { cfg.refuelPerSec = +e.target.value; save(true); };
  $('#fLow', el).onchange = (e) => { cfg.lowWarnPct = +e.target.value; save(true); };
  $$('[data-em]', el).forEach((b) => (b.onclick = () => { cfg.emptyMode = b.dataset.em; save(); draw(); }));
  const pctIn = $('#fEmptyPct', el);
  if (pctIn) pctIn.oninput = () => {
    cfg.emptySpeedPct = +pctIn.value;
    pctIn.parentElement.style.setProperty('--p', pctIn.value + '%');
    $('#fEmptyPctV', el).textContent = pctIn.value + ' %';
    save();
  };
  const fixIn = $('#fEmptyFix', el);
  if (fixIn) fixIn.oninput = () => {
    cfg.emptySpeedFixed = +fixIn.value;
    const p = Math.round((cfg.emptySpeedFixed / 15) * 100);
    fixIn.parentElement.style.setProperty('--p', p + '%');
    $('#fEmptyFixV', el).textContent = p + ' %';
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

function refHtml() {
  return `
  <section class="panel">
    <h2>Fourchettes de temps au tour</h2>
    <p class="muted" style="margin-top:-6px;font-size:.88rem">
      Si le tour est bouclé dans une fourchette, on retire son pourcentage d'essence.
      Plus rapide que toutes les fourchettes : on prend la plus rapide ; plus lent que toutes : la plus lente.
      Un temps qui tombe dans une fourchette désactivée compte comme nominal.
      Bornes : ${LIMITS.tMin} à ${LIMITS.tMax} s, ${LIMITS.pMin} à ${LIMITS.pMax} %.
    </p>
    ${cfg.mode === 'fixed' ? '<p class="warnbox">Le calcul est réglé sur <b>Fixe</b> (onglet Consommation) : ces fourchettes ne sont pas utilisées pour l\'instant.</p>' : ''}
    <div class="bands">
      <div class="band head"><span></span><span>Fourchette</span><span>De (s)</span><span>À (s)</span><span>Conso</span><span></span></div>
      ${rows().map((r) => `
      <div class="band ${r.kind} ${r.b.on ? '' : 'off'}" data-kind="${r.kind}" data-i="${r.i ?? ''}">
        <span>${r.kind === 'nominal' ? '<span class="band-dot"></span>' : `<input type="checkbox" data-f="on" ${r.b.on ? 'checked' : ''} title="Activer / désactiver">`}</span>
        <span class="band-name">${r.label}</span>
        <input type="number" data-f="min" step="0.01" min="${LIMITS.tMin}" max="${LIMITS.tMax}" value="${r.b.min}">
        <input type="number" data-f="max" step="0.01" min="${LIMITS.tMin}" max="${LIMITS.tMax}" value="${r.b.max}">
        <span class="band-pct"><input type="number" data-f="pct" min="${LIMITS.pMin}" max="${LIMITS.pMax}" value="${r.b.pct}"> %</span>
        <span class="band-warn" data-warn></span>
      </div>`).join('')}
    </div>
    <div class="band-scale" id="bandScale"></div>

    <div class="grid grid-2" style="margin-top:16px;gap:12px">
      <div class="panel inner">
        <h3 style="margin-top:0">Tester un temps</h3>
        <div class="row"><input type="number" id="tryT" step="0.01" min="1" max="60" value="${((cfg.nominal.min + cfg.nominal.max) / 2).toFixed(2)}" style="width:110px"> s
          <span id="tryRes" class="try-res"></span></div>
      </div>
      <div class="panel inner">
        <h3 style="margin-top:0">Remplissage automatique</h3>
        <p class="muted" style="font-size:.8rem;margin:0 0 8px">Recale les 8 fourchettes autour de la nominale, collées les unes aux autres, avec ce pas (les pourcentages ne changent pas).</p>
        <div class="row"><input type="number" id="autoStep" step="0.05" min="0.05" max="5" value="0.1" style="width:90px"> s
          <button class="btn small" id="autoFill">Recaler</button>
          <button class="btn small ghost" id="resetBands">Valeurs par défaut</button></div>
      </div>
    </div>
    <div class="panel inner" style="margin-top:12px">
      <h3 style="margin-top:0">⚖️ Réglage équilibré (course)</h3>
      <p class="muted" style="font-size:.85rem;margin:0 0 8px">Trouvé par simulation de courses de 100 tours (voie des stands 4 s, plein 15 % / s, pilotes irréguliers) :
        rouler en nominale, en Rapide 1 ou en Rapide 3 se vaut à moins d'1 s ; attaquer à fond ou rouler lentement ne paie pas.
        Fourchettes 3,1 → 6 s, consommations 8 / 7 / 7 / 6 / <b>5</b> / 4 / 3 / 2 / 1 %.</p>
      <button class="btn small primary" id="balanced">Appliquer le réglage équilibré</button>
    </div>
  </section>`;
}

function bindRef() {
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
  $('#tryT', el).oninput = updateLive;
  $('#autoFill', el).onclick = () => {
    const step = Math.max(0.05, +$('#autoStep', el).value || 0.1);
    const r2 = (x) => Math.round(x * 100) / 100;
    let lo = cfg.nominal.min;
    cfg.faster.forEach((b) => { b.max = r2(lo); b.min = r2(Math.max(LIMITS.tMin, lo - step)); lo = b.min; });
    let hi = cfg.nominal.max;
    cfg.slower.forEach((b, k) => { const w = step * (k < 2 ? 1 : k === 2 ? 3 : 10); b.min = r2(hi); b.max = r2(Math.min(LIMITS.tMax, hi + w)); hi = b.max; });
    save(true);
    toast('Fourchettes recalées autour de la nominale');
  };
  $('#balanced', el).onclick = async () => {
    if (!(await confirmBox('Remplacer tes fourchettes, la consommation nominale et la vitesse de plein (15 % / s) par le réglage équilibré ?'))) return;
    Object.assign(cfg, balancedPreset());
    save(true);
    toast('⚖️ Réglage équilibré appliqué');
  };
  $('#resetBands', el).onclick = async () => {
    if (!(await confirmBox('Remettre les 9 fourchettes et la consommation nominale aux valeurs par défaut ?'))) return;
    const d = defaultFuelConfig();
    Object.assign(cfg, { nominal: d.nominal, nominalPct: d.nominalPct, faster: d.faster, slower: d.slower });
    save(true);
  };
}

/** Avertissements, échelle visuelle, autonomie, testeur : mis à jour sans tout redessiner. */
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

  const t = $('#tryT', el);
  if (t) {
    const s = parseFloat(t.value);
    $('#tryRes', el).innerHTML = Number.isFinite(s)
      ? (() => { const r = consumption(cfg, s * 1000); return `→ <b>−${r.pct} %</b> <span class="muted">(${esc(r.band)})</span>`; })()
      : '';
  }
}
