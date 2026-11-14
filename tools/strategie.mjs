// Simulateur de stratégie essence : node tools/strategie.mjs
// Utilise exactement le calcul de consommation de l'appli (js/fuel.js).
//
// Modèle d'une course de N tours :
//  - le pilote VISE un rythme, mais il n'est pas régulier : chaque tour varie
//    autour de sa cible (dispersion), il a des passages à vide et des sorties de piste ;
//  - la consommation est celle de la fourchette où tombe réellement chaque tour ;
//  - arrêt au stand quand l'essence ne suffit plus pour un tour ;
//  - au stand : temps de parcours de la voie des stands + temps de remplissage ;
//  - au dernier arrêt on ne remet que l'essence utile (+ une marge).
// Chaque stratégie est répétée RUNS fois ; on compare les moyennes.

import { defaultFuelConfig, consumption, sanitize } from '../js/fuel.js';

const LAPS = 100;
const RUNS = 400;
const TANK = 100;
const PIT_LANE = 4.0;        // s : parcours de la voie des stands
const REFUEL = 15;           // % par seconde (1 s = 15 %)
const SPREAD = 0.10;         // s : dispersion d'un tour à l'autre (pilote "normal")
const CRASH = 0.04;          // probabilité de sortie de piste par tour
const CRASH_LOSS = 2.5;      // s perdues par sortie
const PUSH_RISK = 0.02;      // sorties en plus par tranche de 0,1 s plus vite que la nominale

const rnd = (a, b) => a + Math.random() * (b - a);
const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5; // ~ -1..1

function makeCfg(p) {
  return sanitize({
    ...defaultFuelConfig(),
    refuelPerSec: REFUEL,
    nominalPct: p.nom,
    nominal: { min: 3.5, max: 3.7 },
    faster: [
      { on: true, min: 3.4, max: 3.5, pct: p.r1 },
      { on: true, min: 3.3, max: 3.4, pct: p.r2 },
      { on: true, min: 3.2, max: 3.3, pct: p.r3 },
      { on: true, min: 3.1, max: 3.2, pct: p.r4 },
    ],
    slower: [
      { on: true, min: 3.7, max: 3.9, pct: p.l1 },
      { on: true, min: 3.9, max: 4.1, pct: p.l2 },
      { on: p.l3 !== undefined, min: 4.1, max: 4.5, pct: p.l3 ?? 2 },
      { on: p.l4 !== undefined, min: 4.5, max: 6.0, pct: p.l4 ?? 1 },
    ],
  });
}

const TARGETS = [
  { name: 'Rapide 4  (vise 3,15)', t: 3.15 },
  { name: 'Rapide 3  (vise 3,25)', t: 3.25 },
  { name: 'Rapide 2  (vise 3,35)', t: 3.35 },
  { name: 'Rapide 1  (vise 3,45)', t: 3.45 },
  { name: 'Nominale  (vise 3,60)', t: 3.60 },
  { name: 'Lent 1    (vise 3,80)', t: 3.80 },
  { name: 'Lent 2    (vise 4,00)', t: 4.00 },
];

function race(cfg, target) {
  let fuel = TANK, time = 0, stops = 0;
  const crashP = CRASH + Math.max(0, (3.6 - target) / 0.1) * PUSH_RISK;
  // estimation de la conso moyenne de ce rythme (pour décider quand rentrer)
  let est = 0;
  for (let i = 0; i < 50; i++) est += consumption(cfg, (target + gauss() * SPREAD) * 1000).pct;
  est /= 50;
  for (let lap = 1; lap <= LAPS; lap++) {
    if (fuel < est * 1.3) { // plus assez pour un tour (avec marge) : stand
      const need = Math.min(TANK, (LAPS - lap + 1) * est + 3);
      const add = Math.max(0, need - fuel);
      time += PIT_LANE + add / REFUEL;
      fuel += add;
      stops++;
    }
    let t = target + gauss() * SPREAD;
    if (Math.random() < crashP) t += CRASH_LOSS;
    fuel = Math.max(0, fuel - consumption(cfg, t * 1000).pct);
    time += t;
  }
  return { time, stops };
}

function evaluate(p, label, print = true) {
  const cfg = makeCfg(p);
  const res = TARGETS.map((s) => {
    let t = 0, st = 0;
    for (let i = 0; i < RUNS; i++) { const r = race(cfg, s.t); t += r.time; st += r.stops; }
    return { ...s, time: t / RUNS, stops: st / RUNS };
  });
  const best = Math.min(...res.map((r) => r.time));
  const spread = Math.max(...res.map((r) => r.time)) - best;
  if (print) {
    console.log(`\n=== ${label} ===`);
    console.log(`R4 ${p.r4} · R3 ${p.r3} · R2 ${p.r2} · R1 ${p.r1} · Nom ${p.nom} · L1 ${p.l1} · L2 ${p.l2}${p.l3 ? ' · L3 ' + p.l3 : ''}${p.l4 ? ' · L4 ' + p.l4 : ''}`);
    for (const r of [...res].sort((a, b) => a.time - b.time)) {
      const tt = Math.round(r.time * 10) / 10;
      const m = Math.floor(tt / 60), s = (tt - m * 60).toFixed(1).padStart(4, '0');
      console.log(`  ${r.name}  ${m}:${s}  +${(r.time - best).toFixed(1).padStart(5)} s  arrêts ${r.stops.toFixed(1)}`);
    }
    console.log(`  écart entre la meilleure et la pire stratégie : ${spread.toFixed(1)} s`);
  }
  return { res, spread };
}

const SETS = [
  ['A · tes réglages (Rapide 1 à 6 %)', { r4: 10, r3: 8, r2: 7, r1: 6, nom: 5, l1: 4, l2: 3 }],
  ['B', { r4: 8, r3: 7, r2: 6, r1: 6, nom: 5, l1: 4, l2: 3 }],
  ['C', { r4: 9, r3: 8, r2: 7, r1: 6, nom: 5, l1: 4, l2: 3 }],
  ['D', { r4: 8, r3: 7, r2: 7, r1: 6, nom: 5, l1: 4, l2: 3 }],
  ['E', { r4: 9, r3: 7, r2: 7, r1: 6, nom: 5, l1: 4, l2: 3 }],
  ['Réglage équilibré de l\'appli (D + Lent 3 / Lent 4 actifs)', { r4: 8, r3: 7, r2: 7, r1: 6, nom: 5, l1: 4, l2: 3, l3: 2, l4: 1 }],
];
// node tools/strategie.mjs equilibre  -> ne teste que le réglage équilibré
if (process.argv[2] === 'equilibre') SETS.splice(0, SETS.length - 1);
for (const [label, p] of SETS) evaluate(p, label);
