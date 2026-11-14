// Recherche de pourcentages équilibrés : node tools/equilibrage.mjs
// Modèle "espérance" (rapide) de la course, puis on teste toutes les combinaisons
// et on garde celles où les stratégies sont proches, sans que les rythmes lents gagnent.

import { defaultFuelConfig, consumption, sanitize } from '../js/fuel.js';

const LAPS = 100, TANK = 100, PIT_LANE = 4, REFUEL = 15;
const SPREAD = 0.10, CRASH = 0.04, CRASH_LOSS = 2.5, PUSH_RISK = 0.02;
const TARGETS = [3.15, 3.25, 3.35, 3.45, 3.60, 3.80, 4.00];
const NAMES = ['Rapide 4', 'Rapide 3', 'Rapide 2', 'Rapide 1', 'Nominale', 'Lent 1', 'Lent 2'];

// échantillons fixes de la dispersion du pilote (même tirage pour toutes les combinaisons)
const N = 400;
const noise = Array.from({ length: N }, () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5 * SPREAD);

function cfgOf(p) {
  return sanitize({
    ...defaultFuelConfig(), refuelPerSec: REFUEL, nominalPct: p.nom, nominal: { min: 3.5, max: 3.7 },
    faster: [{ on: true, min: 3.4, max: 3.5, pct: p.r1 }, { on: true, min: 3.3, max: 3.4, pct: p.r2 },
      { on: true, min: 3.2, max: 3.3, pct: p.r3 }, { on: true, min: 3.1, max: 3.2, pct: p.r4 }],
    slower: [{ on: true, min: 3.7, max: 3.9, pct: p.l1 }, { on: true, min: 3.9, max: 4.1, pct: p.l2 },
      { on: true, min: 4.1, max: 4.5, pct: p.l3 }, { on: true, min: 4.5, max: 6.0, pct: p.l4 }],
  });
}

function expected(p) {
  const cfg = cfgOf(p);
  return TARGETS.map((target) => {
    let c = 0;
    for (const n of noise) c += consumption(cfg, (target + n) * 1000).pct;
    c /= N;
    const crashP = CRASH + Math.max(0, (3.6 - target) / 0.1) * PUSH_RISK;
    const fuel = Math.max(0, LAPS * c - TANK + 3);
    const stops = Math.ceil(fuel / (TANK - 1.3 * c - 3));
    return LAPS * (target + crashP * CRASH_LOSS) + stops * PIT_LANE + fuel / REFUEL;
  });
}

let best = [];
for (let r1 = 5; r1 <= 7; r1++) for (let r2 = r1; r2 <= 9; r2++) for (let r3 = r2; r3 <= 10; r3++)
  for (let r4 = r3; r4 <= 12; r4++) for (let l1 = 3; l1 <= 5; l1++) for (let l2 = 2; l2 <= l1; l2++) {
    const p = { r1, r2, r3, r4, nom: 5, l1, l2, l3: Math.max(1, l2 - 1), l4: 1 };
    const t = expected(p);
    const min = Math.min(...t);
    // stratégies "jouables" : Rapide 3 à Lent 1 ; on veut qu'elles soient proches
    const core = t.slice(1, 6);
    const spread = Math.max(...core) - Math.min(...core);
    const slowBest = Math.min(t[5], t[6]) <= min + 0.5;       // un rythme lent gagne : refusé
    const fastAdv = Math.min(t[1], t[2], t[3]) - t[4];           // < 0 : attaquer rapporte un peu
    const r4gap = t[0] - min;
    if (slowBest) continue;
    const score = spread + Math.max(0, r4gap - 8) * 0.5 + Math.abs(fastAdv + 1.5) * 0.5;
    best.push({ p, t, score, spread });
  }
best.sort((a, b) => a.score - b.score);
for (const b of best.slice(0, 5)) {
  const m = Math.min(...b.t);
  console.log(`R4 ${b.p.r4} · R3 ${b.p.r3} · R2 ${b.p.r2} · R1 ${b.p.r1} · Nom 5 · L1 ${b.p.l1} · L2 ${b.p.l2} · L3 ${b.p.l3} · L4 1   (écart ${b.spread.toFixed(1)} s)`);
  console.log('   ' + b.t.map((x, i) => `${NAMES[i]} +${(x - m).toFixed(1)}`).join(' | '));
}
