// Simulateur d'équilibrage des pneus : node tools/pneus.mjs [recherche]
// Utilise exactement le calcul de l'appli (js/tyres.js) : vitesse selon la gomme,
// l'usure (falaise), la chauffe, puis arrondi au cran de la Control Unit (0..15).
//
// Modèle :
//  - temps au tour selon le cran de vitesse, comme le simulateur de l'appli :
//    temps = TOUR_15 × sf(15) / sf(cran), avec sf(v) = 0,45 + 0,55 × v / 15
//  - arrêt au stand = parcours de la voie des stands + temps de changement de pneus ;
//  - pour chaque gomme, on cherche la meilleure stratégie « une seule gomme » (nombre
//    d'arrêts et longueur des relais optimaux), puis la meilleure stratégie mélangée.
// Objectif : que les trois gommes donnent des temps de course proches (chacune peut
// gagner) sur 30, 50 et 100 tours, et qu'un arrêt au stand soit utile sur les courses longues.

import { tyreCfg, freshTyres, tyreFactor, wearLap, COMPOUNDS, DEFAULT_TYRES } from '../js/tyres.js';

const TOUR_15 = 3.4;        // s : tour au cran 15 sur ton circuit (records ~3,3-3,5 s)
const PIT_LANE = 4.0;       // s : traversée de la voie des stands
const BASES = [10, 15];     // crans de vitesse garage testés (réglage moyen / à fond)
const LENGTHS = [30, 50, 100];

const sf = (v) => 0.45 + 0.55 * (v / 15);
const lapTime = (cran) => TOUR_15 * sf(15) / sf(cran);

/** Temps cumulés d'un relais de n tours sur des pneus neufs d'une gomme : stint[n]. */
function stintTimes(cfg, compound, base, maxLaps) {
  const t = freshTyres(compound);
  const out = [0];
  let total = 0;
  for (let n = 1; n <= maxLaps; n++) {
    const cran = Math.max(0, Math.min(15, Math.round(base * tyreFactor(cfg, t))));
    total += lapTime(cran);
    out.push(total);
    wearLap(cfg, t);
  }
  return out;
}

/**
 * Meilleure stratégie sur L tours (programmation dynamique).
 * only : gomme imposée (stratégie mono-gomme) ou null (mélange libre).
 * Renvoie { time, stints: [{c, n}] }.
 */
function best(cfg, base, L, only = null) {
  const pit = PIT_LANE + cfg.changeSec;
  const comps = only ? [only] : COMPOUNDS;
  const st = Object.fromEntries(comps.map((c) => [c, stintTimes(cfg, c, base, L)]));
  const f = new Array(L + 1).fill(Infinity);
  const from = new Array(L + 1);
  f[0] = 0;
  for (let l = 1; l <= L; l++) {
    for (const c of comps) {
      for (let n = 1; n <= l; n++) {
        const v = f[l - n] + (l - n > 0 ? pit : 0) + st[c][n];
        if (v < f[l]) { f[l] = v; from[l] = { c, n }; }
      }
    }
  }
  const stints = [];
  for (let l = L; l > 0; l -= from[l].n) stints.unshift(from[l]);
  return { time: f[L], stints };
}

/** Écart entre les trois gommes (mono) : 0 = parfaitement équilibré. */
function evaluate(cfg) {
  let worst = 0;
  let pitPenalty = 0;
  const detail = [];
  for (const base of BASES) {
    for (const L of LENGTHS) {
      const mono = COMPOUNDS.map((c) => best(cfg, base, L, c));
      const times = mono.map((m) => m.time);
      const spread = (Math.max(...times) - Math.min(...times)) / Math.min(...times);
      worst = Math.max(worst, spread);
      const mixed = best(cfg, base, L);
      // sur 50 et 100 tours, la meilleure stratégie doit comporter au moins un arrêt
      if (L >= 50 && mixed.stints.length < 2) pitPenalty += 0.05;
      // nombre d'arrêts raisonnable pour une soirée : 30 → 1, 50 → 2, 100 → 3 au plus
      // (meilleure stratégie et chaque stratégie mono-gomme ; le tendre a droit à 1 de plus)
      const maxStops = { 30: 1, 50: 2, 100: 3 }[L];
      for (const [i, m] of [...mono.entries(), [-1, mixed]]) {
        const extra = COMPOUNDS[i] === 'soft' ? 1 : 0;
        pitPenalty += 0.05 * Math.max(0, m.stints.length - 1 - maxStops - extra);
      }
      detail.push({ base, L, mono, mixed, spread });
    }
  }
  return { score: worst + pitPenalty, worst, detail };
}

const fmt = (s) => `${Math.floor(s / 60)} min ${(s % 60).toFixed(1).padStart(4, '0')}`;
const plan = (m) => m.stints.map((x) => `${x.c[0].toUpperCase()}${x.n}`).join(' + ');

function report(cfg, title) {
  const r = evaluate(cfg);
  console.log(`\n=== ${title} ===`);
  for (const k of COMPOUNDS) {
    const g = cfg[k];
    console.log(`  ${k.padEnd(6)} neufs ${g.newPct} %, usure ${g.wearPerLap} %/tour, falaise ${g.cliffPct} %, usés ${g.wornPct} %, chauffe ${g.warmLaps} tour(s) à ${g.coldPct} %`);
  }
  console.log(`  écart max entre gommes : ${(r.worst * 100).toFixed(2)} %`);
  for (const d of r.detail) {
    console.log(`  cran ${String(d.base).padStart(2)} · ${String(d.L).padStart(3)} tours : `
      + d.mono.map((m, i) => `${COMPOUNDS[i]} ${fmt(m.time)} (${plan(m)})`).join(' | ')
      + `  → meilleur : ${fmt(d.mixed.time)} (${plan(d.mixed)})`);
  }
  return r;
}

// ---------- 1) réglages d'origine ----------
report(tyreCfg(DEFAULT_TYRES), 'Réglages actuels (origine)');

// ---------- 2) recherche ----------
if (process.argv[2] === 'recherche') {
  let bestCfg = null;
  let bestScore = Infinity;
  const base = DEFAULT_TYRES;
  // arcade : écarts de vitesse francs et fixes (100 / 90 / 80 %), on cherche l'usure
  for (const sw of [3, 4, 5, 6, 7, 8])
    for (const sc of [50, 60, 70])
      for (const mw of [1.5, 2, 2.5, 3, 4])
        for (const mc of [60, 70, 80])
          for (const hw of [0.5, 0.75, 1, 1.5, 2])
            for (const worn of [[50, 60, 70], [60, 65, 70], [70, 75, 80]]) {
              if (mw >= sw || hw >= mw) continue; // le tendre s'use le plus, le dur le moins
              const cfg = tyreCfg({
                ...base,
                soft: { ...base.soft, newPct: 100, wearPerLap: sw, cliffPct: sc, wornPct: worn[0] },
                medium: { ...base.medium, newPct: 90, wearPerLap: mw, cliffPct: mc, wornPct: worn[1] },
                hard: { ...base.hard, newPct: 80, wearPerLap: hw, wornPct: worn[2] },
              });
              const { score } = evaluate(cfg);
              if (score < bestScore) { bestScore = score; bestCfg = cfg; }
            }
  report(bestCfg, 'Réglages proposés (meilleur équilibre trouvé)');
  console.log('\nJSON :', JSON.stringify({ soft: bestCfg.soft, medium: bestCfg.medium, hard: bestCfg.hard }));
}

// ---------- 3) modèle « en crans » (proposition) ----------
// Chaque gomme retire des CRANS (et non un %) : identique pour toutes les voitures,
// et c'est l'unité réelle de la Control Unit.
//   neufs : -0 / -1 / -2 cran ; usés (à 100 %) : -usedLoss crans en plus, au-delà de la falaise ;
//   froids : -1 cran pendant les tours de chauffe.
function stintCrans(g, base, maxLaps) {
  const out = [0];
  let total = 0, wear = 0;
  for (let n = 1; n <= maxLaps; n++) {
    let loss = g.offset;
    if (wear > g.cliff) loss += g.usedLoss * Math.min(1, (wear - g.cliff) / Math.max(1, 100 - g.cliff));
    if (n <= g.warm) loss += 1;
    total += lapTime(Math.max(0, Math.min(15, Math.round(base - loss))));
    out.push(total);
    wear = Math.min(100, wear + g.wear);
  }
  return out;
}
function bestCrans(C, base, L, only = null) {
  const pit = PIT_LANE + C.changeSec;
  const comps = only ? [only] : COMPOUNDS;
  const st = Object.fromEntries(comps.map((c) => [c, stintCrans(C[c], base, L)]));
  const f = new Array(L + 1).fill(Infinity), from = new Array(L + 1);
  f[0] = 0;
  for (let l = 1; l <= L; l++) for (const c of comps) for (let n = 1; n <= l; n++) {
    const v = f[l - n] + (l - n > 0 ? pit : 0) + st[c][n];
    if (v < f[l]) { f[l] = v; from[l] = { c, n }; }
  }
  const stints = [];
  for (let l = L; l > 0; l -= from[l].n) stints.unshift(from[l]);
  return { time: f[L], stints };
}
function evalCrans(C, verbose = false) {
  let worst = 0, pen = 0;
  for (const base of BASES) for (const L of LENGTHS) {
    const mono = COMPOUNDS.map((c) => bestCrans(C, base, L, c));
    const times = mono.map((m) => m.time);
    worst = Math.max(worst, (Math.max(...times) - Math.min(...times)) / Math.min(...times));
    const mixed = bestCrans(C, base, L);
    if (L >= 50 && mixed.stints.length < 2) pen += 0.05;
    const maxStops = { 30: 1, 50: 2, 100: 3 }[L];
    for (const [i, m] of [...mono.entries(), [-1, mixed]]) {
      const extra = COMPOUNDS[i] === 'soft' ? 1 : 0;
      pen += 0.05 * Math.max(0, m.stints.length - 1 - maxStops - extra);
    }
    if (verbose) console.log(`  cran ${String(base).padStart(2)} · ${String(L).padStart(3)} tours : `
      + mono.map((m, i) => `${COMPOUNDS[i]} ${fmt(m.time)} (${plan(m)})`).join(' | ')
      + `  → meilleur : ${fmt(mixed.time)} (${plan(mixed)})`);
  }
  return { score: worst + pen, worst };
}
if (process.argv[2] === 'crans') {
  let bestC = null, bestS = Infinity;
  for (const changeSec of [3, 5, 7])
    for (const sw of [3, 4, 5, 6, 8])
      for (const sc of [50, 60, 70])
        for (const mw of [1.5, 2, 2.5, 3, 4])
          for (const mc of [60, 70, 80])
            for (const hw of [0.5, 1, 1.5, 2])
              for (const used of [2, 3, 4]) {
                if (mw >= sw || hw >= mw) continue;
                const C = {
                  changeSec,
                  soft: { offset: 0, wear: sw, cliff: sc, usedLoss: used, warm: 1 },
                  medium: { offset: 1, wear: mw, cliff: mc, usedLoss: used, warm: 1 },
                  hard: { offset: 2, wear: hw, cliff: 80, usedLoss: used, warm: 2 },
                };
                const { score } = evalCrans(C);
                if (score < bestS) { bestS = score; bestC = C; }
              }
  console.log('\n=== Modèle en crans : meilleur équilibre trouvé ===');
  console.log('  arrêt : voie des stands ' + PIT_LANE + ' s + changement ' + bestC.changeSec + ' s');
  for (const k of COMPOUNDS) {
    const g = bestC[k];
    console.log(`  ${k.padEnd(6)} -${g.offset} cran neufs, usure ${g.wear} %/tour, falaise ${g.cliff} % (≈ ${Math.ceil(g.cliff / g.wear)} tours), usés -${g.usedLoss} crans de plus, chauffe ${g.warm} tour(s) à -1 cran`);
  }
  const r = evalCrans(bestC, true);
  console.log(`  écart max entre gommes : ${(r.worst * 100).toFixed(2)} %`);
}

// ---------- 4) recherche fine sur le modèle de l'appli (applicable tel quel) ----------
if (process.argv[2] === 'fin') {
  let bestCfg = null, bestScore = Infinity;
  const b = DEFAULT_TYRES;
  for (const changeSec of [3, 5])
    for (const mNew of [92, 95])
      for (const hNew of [85, 88])
        for (const sw of [4, 6, 8])
          for (const sc of [50, 70])
            for (const mw of [2, 3, 4])
              for (const mc of [60, 75])
                for (const hw of [1, 1.5, 2])
                  for (const worn of [[60, 65, 70], [70, 75, 80]]) {
                    if (mw >= sw || hw >= mw) continue;
                    const cfg = tyreCfg({ ...b, changeSec,
                      soft: { ...b.soft, newPct: 100, wearPerLap: sw, cliffPct: sc, wornPct: worn[0] },
                      medium: { ...b.medium, newPct: mNew, wearPerLap: mw, cliffPct: mc, wornPct: worn[1] },
                      hard: { ...b.hard, newPct: hNew, wearPerLap: hw, wornPct: worn[2] } });
                    const { score } = evaluate(cfg);
                    if (score < bestScore) { bestScore = score; bestCfg = cfg; }
                  }
  report(bestCfg, 'Recherche fine (modèle de l\'appli)');
  console.log('  changement de pneus : ' + bestCfg.changeSec + ' s');
  console.log('\nJSON :', JSON.stringify({ changeSec: bestCfg.changeSec, soft: bestCfg.soft, medium: bestCfg.medium, hard: bestCfg.hard }));
}
