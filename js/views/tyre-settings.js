// Réglages → Pneus : deux onglets.
//  - Automatique : l'appli calcule seule l'usure et le temps d'arrêt selon le nombre de tours
//    (rapport 6, partie 8). On y voit ce que donne le calcul pour une course de N tours, et on
//    règle les 2 mesures du circuit dont il dépend (coût d'un cran, voie des stands).
//  - Manuel : des curseurs pour tout régler soi-même, avec la frise de chaque gomme mise à jour
//    en direct (où arrive la chute de grip, la crevaison…) pour bien comprendre.
// La frise : de gauche à droite, les tours roulés avec un même train de pneus.

import { $, toast, confirmBox } from '../ui.js';
import { vscSpeed } from '../performance.js';
import { COMPOUNDS, COMPOUND_INFO, DEFAULT_TYRES, F1_MIN_LAPS, f1Plan, f1TyreCfg, tyreCfg, lapAtHealth } from '../tyres.js';

let app, root, head, rebind;
let sub = null;          // onglet affiché : 'auto' | 'manual'
let previewLaps = 100;   // longueur de course pour l'aperçu
let draft = null;        // réglages en cours de modification (curseurs)

const REF_LAP = 3.4;     // tour de référence pour l'aperçu (en course : meilleur tour du circuit)
const fr = (x, d = 1) => (Math.round(x * 10 ** d) / 10 ** d).toString().replace('.', ',');
const DESC = {
  soft: 'Rapide mais fragile',
  medium: 'Le compromis',
  hard: 'Dure longtemps mais freine moins bien',
};

/** Affiche l'onglet Pneus. headHtml = en-tête de section ; onBind = rebranche le bouton retour. */
export function renderTyreSettings(r, a, headHtml, onBind) {
  root = r; app = a; head = headHtml; rebind = onBind;
  if (!sub) sub = app.tyres.mode === 'manual' ? 'manual' : 'auto';
  render();
}

function render() {
  draft = JSON.parse(JSON.stringify(app.tyres));
  const used = app.tyres.mode === 'manual' ? 'manual' : 'auto';
  root.innerHTML = head + `
  <div class="dev-banner small">🚧 Utilisé par le mode F1 (en développement)</div>
  <div class="row" style="justify-content:center;margin-bottom:12px">
    <div class="seg" id="tySub">
      <button data-sub="auto" class="${sub === 'auto' ? 'on' : ''}">🤖 Automatique${used === 'auto' ? ' ✓' : ''}</button>
      <button data-sub="manual" class="${sub === 'manual' ? 'on' : ''}">🎚️ Manuel${used === 'manual' ? ' ✓' : ''}</button>
    </div>
  </div>
  <section class="panel ty-use">
    ${sub === used
    ? `<p style="margin:0">✓ <b>${used === 'auto' ? 'Automatique' : 'Manuel'}</b> est utilisé en course.</p>`
    : `<p style="margin:0">En course, c'est le réglage <b>${used === 'auto' ? 'Automatique' : 'Manuel'}</b> qui est utilisé.</p>
       <button class="btn small primary" id="tyUse">Utiliser ${sub === 'auto' ? 'Automatique' : 'Manuel'} en course</button>`}
  </section>
  ${sub === 'auto' ? autoHtml() : manualHtml()}`;
  bind();
  refreshLive();
  rebind();
}

// ------------------------------------------------------------------ frise d'une gomme

/** Zones de la vie d'un pneu (en tours depuis le changement). */
function zones(cfg, k) {
  const g = cfg[k];
  const cold = g.warmLaps;
  const cliffA = lapAtHealth(g, cfg.cliffFrom);
  const cliffB = lapAtHealth(g, cfg.cliffTo);
  const punct = lapAtHealth(g, cfg.punctA);
  const big = lapAtHealth(g, cfg.punctB);
  const dead = lapAtHealth(g, 0);
  return { cold, cliffA, cliffB, punct, big, dead };
}

/** Frise : zones colorées sur `scale` tours. */
function laneHtml(cfg, k, scale) {
  const z = zones(cfg, k);
  const cuts = [
    [0, Math.min(z.cold, z.cliffA), 'cold', 'Froids'],
    [z.cold, z.cliffA, 'ok', 'Bon grip'],
    [z.cliffA, z.cliffB, 'cliff', 'Chute de grip possible'],
    [z.cliffB, z.punct, 'worn', 'Usés'],
    [Math.max(z.cliffB, z.punct), z.big, 'punct', 'Crevaison possible'],
    [Math.max(z.cliffB, z.big), z.dead, 'punct2', 'Gros risque de crevaison'],
    [z.dead, Infinity, 'dead', 'Crevaison sûre'],
  ];
  const pct = (x) => (Math.max(0, Math.min(scale, x)) / scale) * 100;
  const segs = cuts
    .filter(([a, b]) => b > a && a < scale)
    .map(([a, b, cls, t]) => `<i class="tz ${cls}" style="left:${pct(a)}%;width:${pct(b) - pct(a)}%" title="${t} : tours ${Math.floor(a) + 1} à ${Number.isFinite(b) ? Math.ceil(b) : '…'}"></i>`)
    .join('');
  const step = scale <= 60 ? 10 : scale <= 150 ? 25 : scale <= 300 ? 50 : 100;
  const ticks = [];
  for (let t = step; t < scale; t += step) ticks.push(`<span style="left:${pct(t)}%">${t}</span>`);
  return `<div class="ty-lane">${segs}</div><div class="ty-ticks">${ticks.join('')}</div>`;
}

/** Ce que fait la gomme, en clair. */
function whatHtml(cfg, k) {
  const g = cfg[k];
  const z = zones(cfg, k);
  const lap = (x) => (Number.isFinite(x) ? Math.max(1, Math.ceil(x)) : '—');
  const speed = g.speedOff ? `ta programmation <b>−${g.speedOff} cran${g.speedOff > 1 ? 's' : ''}</b>` : '<b>ta programmation</b>';
  const brake = g.brakeOff ? `, freinage <b>−${g.brakeOff}</b>` : '';
  const cold = g.warmLaps && g.coldOff ? ` Pneus neufs : −${g.coldOff} cran pendant ${g.warmLaps} tour${g.warmLaps > 1 ? 's' : ''}.` : '';
  return `Vitesse : ${speed}${brake}.${cold} Usure <b>${fr(g.wearPerLap, 2)} %/tour</b> : chute de grip entre le tour <b>${lap(z.cliffA)}</b> et le tour <b>${lap(z.cliffB)}</b> (la voiture ne garde que ${cfg.cliffKeep} % de sa programmation), crevaison possible dès le tour <b>${lap(z.punct)}</b>.`;
}

function legendHtml() {
  return `<div class="ty-legend">
    <span><i class="tz cold"></i>Froids</span><span><i class="tz ok"></i>Bon grip</span>
    <span><i class="tz cliff"></i>Chute de grip possible</span><span><i class="tz worn"></i>Usés</span>
    <span><i class="tz punct"></i>Crevaison possible</span><span><i class="tz dead"></i>Crevaison sûre</span>
  </div>`;
}

function cardsHtml() {
  return COMPOUNDS.map((k) => `
    <div class="ty-card" style="--tc:${COMPOUND_INFO[k].color}">
      <div class="ty-card-h"><span class="tyre-dot" style="--tc:${COMPOUND_INFO[k].color}">${COMPOUND_INFO[k].short}</span><b>${COMPOUND_INFO[k].label}</b><span class="muted">${DESC[k]}</span></div>
      <div data-lane="${k}"></div>
      <p class="ty-what" data-what="${k}"></p>
      ${sub === 'manual' ? compoundSliders(k) : ''}
    </div>`).join('');
}

// ------------------------------------------------------------------ curseurs

/** Un curseur : path = 'cliffFrom' ou 'soft.wearPerLap'. */
function rng(path, label, min, max, step, unit, hint = '') {
  const v = get(path);
  return `<label class="ty-rng"><span class="ty-rng-l">${label}${hint ? `<small>${hint}</small>` : ''}</span>
    <input type="range" data-p="${path}" min="${min}" max="${max}" step="${step}" value="${v}">
    <b class="num"><span data-v="${path}">${fmtVal(path, v)}</span>${unit ? ' ' + unit : ''}</b></label>`;
}
function get(path) {
  const [a, b] = path.split('.');
  return b ? draft[a][b] : draft[a];
}
function set(path, v) {
  const [a, b] = path.split('.');
  if (b) draft[a][b] = v; else draft[a] = v;
}
function fmtVal(path, v) {
  if (path === 'punctSpeedPct') return `${v} % · cran ${vscSpeed(+v)}/15`;
  return fr(+v, 2);
}

function compoundSliders(k) {
  return `<div class="ty-rngs">
    ${rng(`${k}.speedOff`, 'Vitesse', 0, 5, 1, 'cran(s) en moins')}
    ${rng(`${k}.brakeOff`, 'Freinage', 0, 5, 1, 'cran(s) en moins')}
    ${rng(`${k}.wearPerLap`, 'Usure', 0.2, 10, 0.1, '%/tour')}
    ${rng(`${k}.warmLaps`, 'Chauffe', 0, 5, 1, 'tour(s)')}
    ${rng(`${k}.coldOff`, 'À froid', 0, 4, 1, 'cran(s) en moins')}
  </div>`;
}

// ------------------------------------------------------------------ Automatique

function autoHtml() {
  return `
  <section class="panel" style="margin-top:14px">
    <h2>🤖 L'appli règle les pneus toute seule</h2>
    <p class="muted" style="margin:6px 0 0;font-size:.9rem">Au départ d'une course F1, l'appli calcule l'usure des 3 gommes et le temps d'arrêt <b>selon le nombre de tours</b>, pour que les 3 stratégies (Tendre, Medium, Dur) se valent. Plus la course est longue, plus les pneus durent : il y a environ 1 arrêt à 50 tours et 10 à 500 tours, pas plus.</p>
    <div class="ty-rngs" style="margin-top:12px">
      <label class="ty-rng"><span class="ty-rng-l">Aperçu pour une course de</span>
        <input type="range" id="tyLaps" min="${F1_MIN_LAPS}" max="500" step="5" value="${previewLaps}">
        <b class="num" id="tyLapsV">${previewLaps} tours</b></label>
    </div>
    <div class="ty-sum" id="tySum"></div>
  </section>
  <section class="panel" style="margin-top:14px">
    <h2>La vie de chaque gomme <span class="muted" style="font-weight:500;font-size:.85rem">· un train de pneus, tour après tour</span></h2>
    ${legendHtml()}
    ${cardsHtml()}
  </section>
  <section class="panel" style="margin-top:14px">
    <h2>📏 Les 2 mesures de ton circuit</h2>
    <p class="muted" style="margin:6px 0 10px;font-size:.85rem">Le calcul compare des crans à des secondes. Il a besoin de savoir ce que coûte un cran sur ton circuit et ce qu'on perd dans la voie des stands. Les valeurs ci-dessous sont des estimations : mesure-les une fois (essai 12 de la fiche) pour un équilibre juste.</p>
    <div class="ty-rngs">
      ${rng('f1Cran', 'Un cran en moins coûte', 1, 10, 0.5, '% du tour', '10 tours au réglage habituel, puis 10 tours à 1 cran de moins')}
      ${rng('f1Lane', 'Temps perdu dans la voie des stands', 0, 15, 0.2, 's', 'un tour en passant par les stands sans s\'arrêter, comparé à un tour normal')}
    </div>
  </section>
  <section class="panel" style="margin-top:14px">
    <h2>Toujours pareil, quelle que soit la course</h2>
    <ul class="muted" style="margin:6px 0 0;padding-left:18px;font-size:.88rem;line-height:1.5">
      <li><b>Tendre</b> : ta programmation. <b>Medium</b> : 1 cran en moins. <b>Dur</b> : 1 cran en moins et un freinage moins fort.</li>
      <li>Pneus neufs : 1 cran en moins pendant 1 tour (chauffe).</li>
      <li>Chute de grip au hasard entre ${DEFAULT_TYRES.cliffFrom} et ${DEFAULT_TYRES.cliffTo} % de santé : la voiture ne garde que ${DEFAULT_TYRES.cliffKeep} % de sa programmation.</li>
      <li>Sous ${DEFAULT_TYRES.punctA} % de santé, risque de crevaison à chaque passage sur la ligne (${DEFAULT_TYRES.punctAChance} %, puis ${DEFAULT_TYRES.punctBChance} % sous ${DEFAULT_TYRES.punctB} %).</li>
      <li><b>2 gommes obligatoires</b> pendant la course.</li>
    </ul>
  </section>`;
}

/** Réglages calculés pour l'aperçu (avec les mesures en cours de réglage). */
const autoCfg = () => f1TyreCfg(previewLaps, REF_LAP, draft);

// ------------------------------------------------------------------ Manuel

function manualHtml() {
  return `
  <section class="panel" style="margin-top:14px">
    <h2>🎚️ Tu règles tout toi-même</h2>
    <p class="muted" style="margin:6px 0 0;font-size:.9rem">Bouge les curseurs : la frise de chaque gomme montre tout de suite où arrivent la chute de grip et la crevaison. Ces réglages servent en course quand <b>Manuel</b> est choisi.</p>
    <div class="ty-rngs" style="margin-top:12px">
      <label class="ty-rng"><span class="ty-rng-l">Frise sur</span>
        <input type="range" id="tyLaps" min="20" max="200" step="5" value="${Math.min(200, previewLaps)}">
        <b class="num" id="tyLapsV">${Math.min(200, previewLaps)} tours</b></label>
    </div>
    <button class="btn small ghost" id="tyCopy" style="margin-top:8px">📋 Partir du calcul automatique pour ${previewLaps} tours</button>
  </section>
  <section class="panel" style="margin-top:14px">
    <h2>Les 3 gommes</h2>
    ${legendHtml()}
    ${cardsHtml()}
  </section>
  <section class="panel" style="margin-top:14px">
    <h2>Usure : ce qui arrive en fin de vie</h2>
    <div class="ty-rngs">
      ${rng('cliffFrom', 'Chute de grip : à partir de', 0, 100, 1, '% de santé', 'arrive au hasard entre ces deux valeurs')}
      ${rng('cliffTo', 'Chute de grip : au plus tard à', 0, 100, 1, '% de santé')}
      ${rng('cliffKeep', 'Après la chute, la voiture garde', 0, 100, 5, '% de sa programmation')}
      ${rng('punctA', 'Risque de crevaison sous', 0, 100, 1, '% de santé')}
      ${rng('punctAChance', 'Risque à chaque passage', 0, 100, 5, '%')}
      ${rng('punctB', 'Gros risque sous', 0, 100, 1, '% de santé')}
      ${rng('punctBChance', 'Gros risque à chaque passage', 0, 100, 5, '%')}
      ${rng('punctSpeedPct', 'Vitesse en crevaison', 0, 100, 5, '', 'comme le VSC, la même pour toutes les voitures crevées')}
    </div>
    <p class="muted" id="tyEx" style="margin:8px 0 0;font-size:.85rem"></p>
  </section>
  <section class="panel" style="margin-top:14px">
    <h2>Arrêt au stand</h2>
    <div class="ty-rngs">
      ${rng('changeSec', 'Temps d\'arrêt pour changer', 0, 15, 0.5, 's', 'immobile dans la voie des stands, le même pour toutes les gommes')}
    </div>
    <label class="field" style="margin-top:10px;max-width:240px">Gomme de départ
      <select id="tyStart">${COMPOUNDS.map((k) => `<option value="${k}" ${draft.start === k ? 'selected' : ''}>${COMPOUND_INFO[k].label}</option>`).join('')}</select></label>
  </section>
  <button class="btn small ghost" id="tyReset" style="margin-top:14px">↺ Revenir aux réglages d'origine</button>`;
}

// ------------------------------------------------------------------ mise à jour en direct

/** Réglages montrés sur les frises : calculés (Automatique) ou ceux des curseurs (Manuel). */
const shownCfg = () => (sub === 'auto' ? autoCfg() : tyreCfg(draft));

function refreshLive() {
  if (!root) return;
  const cfg = shownCfg();
  const scale = sub === 'auto' ? previewLaps : Math.min(200, previewLaps);
  COMPOUNDS.forEach((k) => {
    const l = root.querySelector(`[data-lane="${k}"]`);
    if (l) l.innerHTML = laneHtml(cfg, k, scale);
    const w = root.querySelector(`[data-what="${k}"]`);
    if (w) w.innerHTML = whatHtml(cfg, k);
  });
  const sum = $('#tySum', root);
  if (sum) {
    const p = f1Plan(previewLaps, REF_LAP, draft.f1Cran, draft.f1Lane);
    const stints = (k) => Math.max(1, Math.ceil(previewLaps / Math.max(1, lapAtHealth(cfg[k], cfg.cliffFrom))));
    sum.innerHTML = `
      <div><span class="muted">Le Tendre tient</span><b>${p.life} tours</b></div>
      <div><span class="muted">Arrêt pour changer</span><b>${p.changeSec} s</b></div>
      <div><span class="muted">Usure T / M / D</span><b>${COMPOUNDS.map((k) => fr(cfg[k].wearPerLap, 1)).join(' / ')} %</b></div>
      <div><span class="muted">Relais si on ne roule qu'avec</span><b>T ${stints('soft')} · M ${stints('medium')} · D ${stints('hard')}</b></div>
      <p class="muted" style="grid-column:1/-1;margin:2px 0 0;font-size:.8rem">Un arrêt complet (voie des stands + changement) doit coûter environ ${fr(p.stopSec)} s : autant qu'un cran perdu pendant 2 relais de Tendre. C'est ce qui équilibre les 3 gommes. En course, le calcul prend le meilleur tour du circuit au lieu de ${fr(REF_LAP)} s.</p>`;
  }
  const ex = $('#tyEx', root);
  if (ex) ex.textContent = `Exemple : une voiture programmée à 8 roule à ${Math.round((8 * cfg.cliffKeep) / 100)} après la chute de grip, à 12 elle roule à ${Math.round((12 * cfg.cliffKeep) / 100)}.`;
}

// ------------------------------------------------------------------ événements

function bind() {
  root.querySelectorAll('[data-sub]').forEach((b) => (b.onclick = () => { sub = b.dataset.sub; render(); }));
  const use = $('#tyUse', root);
  if (use) use.onclick = async () => {
    await app.saveTyres({ ...app.tyres, mode: sub });
    toast(`Pneus : réglage ${sub === 'auto' ? 'Automatique' : 'Manuel'} utilisé en course`, 1800);
    render();
  };
  const laps = $('#tyLaps', root);
  if (laps) laps.oninput = () => {
    previewLaps = +laps.value;
    $('#tyLapsV', root).textContent = `${previewLaps} tours`;
    const copy = $('#tyCopy', root);
    if (copy) copy.textContent = `📋 Partir du calcul automatique pour ${previewLaps} tours`;
    refreshLive();
  };
  root.querySelectorAll('[data-p]').forEach((inp) => {
    const path = inp.dataset.p;
    inp.oninput = () => {
      set(path, +inp.value);
      const v = root.querySelector(`[data-v="${path}"]`);
      if (v) v.textContent = fmtVal(path, +inp.value);
      refreshLive();
    };
    inp.onchange = async () => {
      set(path, +inp.value);
      await app.saveTyres(draft);
      draft = JSON.parse(JSON.stringify(app.tyres));
      refreshLive();
      toast('Enregistré', 900);
    };
  });
  const st = $('#tyStart', root);
  if (st) st.onchange = async () => { await app.saveTyres({ ...app.tyres, start: st.value }); toast('Enregistré', 900); };
  const copy = $('#tyCopy', root);
  if (copy) copy.onclick = async () => {
    const c = f1TyreCfg(previewLaps, REF_LAP, app.tyres);
    await app.saveTyres({ ...c, mode: app.tyres.mode, start: app.tyres.start });
    toast(`Réglage Manuel rempli avec le calcul pour ${previewLaps} tours`, 1800);
    render();
  };
  const reset = $('#tyReset', root);
  if (reset) reset.onclick = async () => {
    if (!(await confirmBox('Revenir aux réglages d\'origine des pneus (Manuel) ?'))) return;
    await app.saveTyres({ ...DEFAULT_TYRES, mode: app.tyres.mode, f1Cran: app.tyres.f1Cran, f1Lane: app.tyres.f1Lane });
    render();
  };
}
