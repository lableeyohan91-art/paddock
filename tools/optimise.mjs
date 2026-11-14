// Recherche du réglage d'essence le plus équilibré : node tools/optimise.mjs
// Même modèle de course que tools/strategie.mjs (pilotes irréguliers, sorties,
// voie des stands 4 s, plein 15 %/s), avec les MÊMES tirages aléatoires pour
// toutes les combinaisons (comparaison équitable).
// Critère : les 5 rythmes "rapides ou nominal" (Rapide 4 → Nominale) doivent
// finir le plus près possible les uns des autres, et les rythmes lents ne
// doivent jamais gagner (ils doivent perdre au moins quelques secondes).

import { defaultFuelConfig, consumption, sanitize } from '../js/fuel.js';

// TANK=74 node tools/optimise.mjs 30  -> réservoir à 74 % (réglage garage)
const TANK = Number(process.env.TANK) || 100, PIT_LANE = 4, REFUEL = 15;
const SPREAD = 0.10, CRASH = 0.04, CRASH_LOSS = 2.5, PUSH_RISK = 0.02;
const RUNS = Number(process.env.RUNS) || 120;
const TARGETS = [3.15, 3.25, 3.35, 3.45, 3.60, 3.80, 4.00];
const NAMES = ['Rapide 4', 'Rapide 3', 'Rapide 2', 'Rapide 1', 'Nominale', 'Lent 1', 'Lent 2'];

// tirages communs : bruit de chaque tour et dé de sortie de piste
const MAXL = 100;
const noise = Array.from({ length: RUNS }, () => Array.from({ length: MAXL }, () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5 * SPREAD));
const dice = Array.from({ length: RUNS }, () => Array.from({ length: MAXL }, () => Math.random()));

export function cfgOf(p) {
  return sanitize({
    ...defaultFuelConfig(), refuelPerSec: REFUEL, nominalPct: p.nom ?? 5, nominal: { min: 3.5, max: 3.7 },
    faster: [{ on: true, min: 3.4, max: 3.5, pct: p.r1 }, { on: true, min: 3.3, max: 3.4, pct: p.r2 },
      { on: true, min: 3.2, max: 3.3, pct: p.r3 }, { on: true, min: 3.1, max: 3.2, pct: p.r4 }],
    slower: [{ on: true, min: 3.7, max: 3.9, pct: p.l1 }, { on: true, min: 3.9, max: 4.1, pct: p.l2 },
      { on: true, min: 4.1, max: 4.5, pct: p.l3 ?? 2 }, { on: true, min: 4.5, max: 6.0, pct: p.l4 ?? 1 }],
  });
}

function race(cfg, target, laps, run) {
  let fuel = TANK, time = 0;
  const crashP = CRASH + Math.max(0, (3.6 - target) / 0.1) * PUSH_RISK;
  const est = consumption(cfg, target * 1000).pct;
  for (let lap = 1; lap <= laps; lap++) {
    if (fuel < est * 1.3) {
      const add = Math.max(0, Math.min(TANK, (laps - lap + 1) * est + 3) - fuel);
      time += PIT_LANE + add / REFUEL;
      fuel += add;
    }
    let t = target + noise[run][lap - 1];
    if (dice[run][lap - 1] < crashP) t += CRASH_LOSS;
    fuel = Math.max(0, fuel - consumption(cfg, t * 1000).pct);
    time += t;
  }
  return time;
}

export function evaluate(p, laps) {
  const cfg = cfgOf(p);
  return TARGETS.map((t) => {
    let s = 0;
    for (let r = 0; r < RUNS; r++) s += race(cfg, t, laps, r);
    return s / RUNS;
  });
}

export function score(times) {
  const best = Math.min(...times);
  const core = times.slice(0, 5);
  const spread = Math.max(...core) - Math.min(...core);
  const slowMargin = Math.min(times[5], times[6]) - best; // les lents doivent perdre
  const penalty = slowMargin < 3 ? (3 - slowMargin) * 5 : 0;
  return { spread, slowMargin, total: spread + penalty };
}

export function show(label, p, times) {
  const best = Math.min(...times);
  const s = score(times);
  console.log(`\n${label}`);
  console.log(`  R4 ${p.r4} · R3 ${p.r3} · R2 ${p.r2} · R1 ${p.r1} · Nom ${p.nom ?? 5} · L1 ${p.l1} · L2 ${p.l2} · L3 ${p.l3 ?? 2} · L4 ${p.l4 ?? 1}`);
  console.log('  ' + times.map((x, i) => `${NAMES[i]} ${x - best < 0.05 ? '🥇' : '+' + (x - best).toFixed(1)}`).join(' | '));
  console.log(`  écart Rapide 4→Nominale : ${s.spread.toFixed(1)} s · les lents perdent au moins ${s.slowMargin.toFixed(1)} s`);
}

function search(laps) {
  const out = [];
  for (let r1 = 5; r1 <= 7; r1++) for (let r2 = r1; r2 <= 8; r2++) for (let r3 = r2; r3 <= 9; r3++)
    for (let r4 = r3; r4 <= 10; r4++) for (let l1 = 3; l1 <= 4; l1++) for (let l2 = 2; l2 <= l1; l2++) {
      const p = { r1, r2, r3, r4, nom: 5, l1, l2, l3: Math.max(1, l2 - 1), l4: 1 };
      const t = evaluate(p, laps);
      out.push({ p, t, s: score(t) });
    }
  return out.sort((a, b) => a.s.total - b.s.total);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const mode = process.argv[2] || 'both';
  const lengths = mode === 'both' ? [100, 50] : [Number(mode)];
  const found = {};
  for (const laps of lengths) {
    console.log(`\n######## Recherche sur ${laps} tours (${RUNS} courses par stratégie) ########`);
    const res = search(laps);
    found[laps] = res;
    res.slice(0, 3).forEach((r, i) => show(`#${i + 1} sur ${laps} tours`, r.p, r.t));
  }
  if (lengths.length === 2) {
    console.log('\n######## Croisement : chaque meilleur réglage testé sur l\'autre distance ########');
    for (const [a, b] of [[100, 50], [50, 100]]) {
      const p = found[a][0].p;
      show(`Meilleur réglage ${a} tours, joué sur ${b} tours`, p, evaluate(p, b));
    }
    // meilleur compromis : somme des scores sur les deux distances
    const all = found[100].map((r) => {
      const t50 = evaluate(r.p, 50);
      return { p: r.p, t100: r.t, t50, total: r.s.total + score(t50).total };
    }).sort((a, b) => a.total - b.total);
    console.log('\n######## Meilleur compromis 50 ET 100 tours ########');
    show('Compromis · 100 tours', all[0].p, all[0].t100);
    show('Compromis · 50 tours', all[0].p, all[0].t50);
  }
}
