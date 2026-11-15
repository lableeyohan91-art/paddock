// Simulateur d'équilibrage des pneus : node tools/pneus.mjs [recherche]
// Utilise le calcul de l'appli (js/tyres.js) : crans retirés à la programmation du pilote,
// tours de chauffe, chute de grip (prise au milieu de sa plage), crevaison.
//
// Modèle :
//  - temps au tour selon le cran de vitesse : temps = TOUR_15 × sf(15) / sf(cran),
//    avec sf(v) = 0,45 + 0,55 × v / 15 (comme le simulateur de l'appli) ;
//  - arrêt au stand = voie des stands + temps de changement de pneus ;
//  - un pilote prudent s'arrête avant la zone de crevaison : un relais ne descend pas
//    sous punctA % de santé ;
//  - pour chaque gomme, meilleure stratégie « une seule gomme » (programmation dynamique),
//    puis meilleure stratégie mélangée.
// Objectif : trois gommes aux temps de course proches sur 30, 50 et 100 tours, avec un
// nombre d'arrêts raisonnable.

import { tyreCfg, freshTyres, tyreTarget, wearLap, tyreHealth, COMPOUNDS, DEFAULT_TYRES } from '../js/tyres.js';

const TOUR_15 = 3.4;          // s : tour au cran 15 (records ~3,3-3,5 s)
const PIT_LANE = 4.0;         // s : traversée de la voie des stands
const BASES = [6, 8, 10, 12]; // programmations de vitesse des pilotes testées
const LENGTHS = [30, 50, 100];

const sf = (v) => 0.45 + 0.55 * (v / 15);
const lapTime = (cran) => (cran <= 0 ? 60 : TOUR_15 * sf(15) / sf(cran));

/** Temps cumulés d'un relais sur pneus neufs ; s'arrête avant la zone de crevaison. */
function stintTimes(cfg, compound, base, maxLaps) {
  const mid = (cfg.cliffFrom + cfg.cliffTo) / 2;
  const t = { ...freshTyres(compound, compound, cfg), cliffAt: mid };
  const out = [0];
  let total = 0;
  for (let n = 1; n <= maxLaps; n++) {
    total += lapTime(tyreTarget(cfg, t, { speed: base, brake: 15 }).speed);
    out.push(total);
    wearLap(cfg, t, () => 1); // jamais de crevaison tirée ici
    if (tyreHealth(t) <= cfg.punctA) break;
  }
  return out;
}

function best(cfg, base, L, only = null) {
  const pit = PIT_LANE + cfg.changeSec;
  const comps = only ? [only] : COMPOUNDS;
  const st = Object.fromEntries(comps.map((c) => [c, stintTimes(cfg, c, base, L)]));
  const f = new Array(L + 1).fill(Infinity);
  const from = new Array(L + 1);
  f[0] = 0;
  for (let l = 1; l <= L; l++)
    for (const c of comps)
      for (let n = 1; n <= l && n < st[c].length; n++) {
        const v = f[l - n] + (l - n > 0 ? pit : 0) + st[c][n];
        if (v < f[l]) { f[l] = v; from[l] = { c, n }; }
      }
  const stints = [];
  for (let l = L; l > 0; l -= from[l].n) stints.unshift(from[l]);
  return { time: f[L], stints };
}

function evaluate(cfg) {
  let worst = 0, pen = 0;
  const detail = [];
  for (const base of BASES) for (const L of LENGTHS) {
    const mono = COMPOUNDS.map((c) => best(cfg, base, L, c));
    const times = mono.map((m) => m.time);
    const spread = (Math.max(...times) - Math.min(...times)) / Math.min(...times);
    worst = Math.max(worst, spread);
    const mixed = best(cfg, base, L);
    const maxStops = { 30: 1, 50: 2, 100: 4 }[L];
    for (const m of [...mono, mixed]) pen += 0.02 * Math.max(0, m.stints.length - 1 - maxStops);
    detail.push({ base, L, mono, mixed, spread });
  }
  return { score: worst + pen, worst, detail };
}

const fmt = (s) => `${Math.floor(s / 60)} min ${(s % 60).toFixed(1).padStart(4, '0')}`;
const plan = (m) => m.stints.map((x) => `${x.c[0].toUpperCase()}${x.n}`).join(' + ');

function report(cfg, title) {
  const r = evaluate(cfg);
  console.log(`\n=== ${title} ===`);
  for (const k of COMPOUNDS) {
    const g = cfg[k];
    console.log(`  ${k.padEnd(6)} -${g.speedOff} cran vitesse, -${g.brakeOff} freinage, usure ${g.wearPerLap} %/tour, chauffe ${g.warmLaps} tour(s) à -${g.coldOff}`);
  }
  console.log(`  écart max entre gommes : ${(r.worst * 100).toFixed(2)} %`);
  for (const d of r.detail) {
    console.log(`  prog. ${String(d.base).padStart(2)} · ${String(d.L).padStart(3)} tours : `
      + d.mono.map((m, i) => `${COMPOUNDS[i]} ${fmt(m.time)} (${plan(m)})`).join(' | ')
      + `  → meilleur : ${fmt(d.mixed.time)} (${plan(d.mixed)})`);
  }
  return r;
}

report(tyreCfg(DEFAULT_TYRES), 'Réglages d\'origine');

if (process.argv[2] === 'recherche') {
  const D = DEFAULT_TYRES;
  let bestCfg = null, bestScore = Infinity;
  for (const sw of [4, 5, 6, 7, 8, 10])
    for (const mw of [2.5, 3, 3.5, 4, 5, 6])
      for (const hw of [1, 1.5, 2, 2.5, 3])
        for (const changeSec of [2, 3, 5]) {
          if (mw >= sw || hw >= mw) continue;
          const cfg = tyreCfg({ ...D, changeSec,
            soft: { ...D.soft, wearPerLap: sw }, medium: { ...D.medium, wearPerLap: mw }, hard: { ...D.hard, wearPerLap: hw } });
          const { score } = evaluate(cfg);
          if (score < bestScore) { bestScore = score; bestCfg = cfg; }
        }
  report(bestCfg, 'Meilleur équilibre trouvé');
  console.log('  changement de pneus : ' + bestCfg.changeSec + ' s');
}
