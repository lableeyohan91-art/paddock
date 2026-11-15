// Pneus (mode arcade) : trois gommes aux comportements bien marqués.
//  - chaque gomme retire des CRANS à la programmation du pilote sur SA voiture
//    (Tendre = sa programmation, Medium = 1 cran en dessous, Dur = 2 crans en dessous),
//    et peut aussi freiner moins bien (crans de freinage en moins) ;
//  - usure à chaque tour ; la chute de grip arrive au hasard quand il reste entre 25 % et
//    15 % de santé : la voiture ne garde alors que 50 % de sa programmation (8 → 4) ;
//  - sous 15 % de santé, risque de crevaison à chaque passage sur la ligne (20 %, puis
//    50 % sous 7 %) ; à 0 % c'est la crevaison : vitesse imposée comme le VSC ;
//  - tours de chauffe après un changement (crans en moins) ;
//  - changement au stand : la voiture reste immobile X secondes dans la voie des stands
//    et repart avec la gomme choisie (vue pilote, ou écran de course).
// Tout se règle dans Réglages → Pneus.

import { vscSpeed } from './performance.js';

export const COMPOUNDS = ['soft', 'medium', 'hard'];
export const COMPOUND_INFO = {
  soft: { label: 'Tendre', short: 'T', color: '#e10600' },
  medium: { label: 'Medium', short: 'M', color: '#facc15' },
  hard: { label: 'Dur', short: 'D', color: '#f5f5f5' },
};

// Réglages d'origine
export const DEFAULT_TYRES = {
  changeSec: 3,        // temps d'arrêt au stand pour changer les pneus
  start: 'medium',     // gomme de départ par défaut
  cliffFrom: 25,       // chute de grip au hasard entre 25 %…
  cliffTo: 15,         // …et 15 % de santé restante
  cliffKeep: 50,       // après la chute : % de la programmation conservé (8 → 4)
  punctA: 15,          // sous 15 % de santé…
  punctAChance: 20,    // …20 % de risque de crevaison à chaque passage sur la ligne
  punctB: 7,           // sous 7 % de santé…
  punctBChance: 50,    // …50 % de risque
  punctSpeedPct: 20,   // vitesse en crevaison : % de la vitesse max du circuit (comme le VSC)
  soft: { speedOff: 0, brakeOff: 0, wearPerLap: 4, warmLaps: 1, coldOff: 1 },
  medium: { speedOff: 1, brakeOff: 0, wearPerLap: 2.5, warmLaps: 1, coldOff: 1 },
  hard: { speedOff: 2, brakeOff: 2, wearPerLap: 1, warmLaps: 2, coldOff: 1 },
};

const num = (v, min, max, d) => { const n = +v; return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d; };

/** Réglages complets (valeurs de l'utilisateur, sinon celles d'origine), bornés. */
export function tyreCfg(saved = {}) {
  const D = DEFAULT_TYRES;
  const c = {
    changeSec: num(saved.changeSec, 0, 30, D.changeSec),
    start: COMPOUNDS.includes(saved.start) ? saved.start : D.start,
    cliffKeep: num(saved.cliffKeep, 0, 100, D.cliffKeep),
    punctAChance: num(saved.punctAChance, 0, 100, D.punctAChance),
    punctBChance: num(saved.punctBChance, 0, 100, D.punctBChance),
    punctSpeedPct: num(saved.punctSpeedPct, 0, 100, D.punctSpeedPct),
  };
  // bornes dans le bon ordre (« de » ≥ « à »)
  const a = num(saved.cliffFrom, 0, 100, D.cliffFrom), b = num(saved.cliffTo, 0, 100, D.cliffTo);
  c.cliffFrom = Math.max(a, b); c.cliffTo = Math.min(a, b);
  const p = num(saved.punctA, 0, 100, D.punctA), q = num(saved.punctB, 0, 100, D.punctB);
  c.punctA = Math.max(p, q); c.punctB = Math.min(p, q);
  // réglages enregistrés avec l'ancien modèle (en % de vitesse) : on repart des valeurs d'origine
  const oldModel = COMPOUNDS.some((k) => saved[k] && saved[k].speedOff === undefined);
  for (const k of COMPOUNDS) {
    const d = D[k];
    const s = (!oldModel && saved[k]) || {};
    c[k] = {
      speedOff: num(s.speedOff, 0, 15, d.speedOff),
      brakeOff: num(s.brakeOff, 0, 15, d.brakeOff),
      wearPerLap: num(s.wearPerLap, 0, 100, d.wearPerLap),
      warmLaps: num(s.warmLaps, 0, 10, d.warmLaps),
      coldOff: num(s.coldOff, 0, 15, d.coldOff),
    };
  }
  return c;
}

/**
 * Pneus neufs d'une gomme pour une voiture. La chute de grip est tirée au hasard
 * (santé restante entre cliffFrom et cliffTo) : personne ne sait exactement quand.
 */
export function freshTyres(compound, next = compound, cfg = DEFAULT_TYRES, rnd = Math.random) {
  const cliffAt = cfg.cliffTo + rnd() * (cfg.cliffFrom - cfg.cliffTo);
  return { compound, wear: 0, lapsOn: 0, next, cliffAt: Math.round(cliffAt * 10) / 10, punctured: false };
}

/** Santé restante du pneu (100 = neuf, 0 = crevé). */
export const tyreHealth = (t) => Math.max(0, 100 - (t?.wear || 0));

/** Le pneu a-t-il passé sa chute de grip ? */
const pastCliff = (t) => tyreHealth(t) <= (t.cliffAt ?? 20);

/**
 * Crans imposés par les pneus, à partir de la programmation du pilote sur SA voiture
 * (base = { speed, brake }, 0..15). Renvoie { speed, brake }.
 */
export function tyreTarget(cfg, t, base) {
  const g = cfg[t.compound];
  let speed = base.speed - g.speedOff;
  if (t.lapsOn < g.warmLaps) speed -= g.coldOff;
  speed = Math.max(0, speed);
  if (pastCliff(t)) speed = Math.round((speed * cfg.cliffKeep) / 100);
  if (t.punctured) speed = Math.min(speed, vscSpeed(cfg.punctSpeedPct));
  const brake = Math.max(0, base.brake - g.brakeOff);
  return { speed: Math.max(0, Math.min(15, speed)), brake: Math.min(15, brake) };
}

/** État lisible : crevé / froid / usé (chute de grip passée) / OK. */
export function tyreState(cfg, t) {
  if (!t) return '';
  if (t.punctured) return 'puncture';
  if (t.lapsOn < cfg[t.compound].warmLaps) return 'cold';
  if (pastCliff(t)) return 'worn';
  return 'ok';
}

/**
 * Un tour bouclé (passage sur la ligne) : usure, fin de chauffe, puis tirage de la crevaison.
 * Renvoie l'événement à annoncer : 'cliff' (chute de grip), 'puncture' (crevaison) ou null.
 */
export function wearLap(cfg, t, rnd = Math.random) {
  if (!t || t.punctured) return null;
  const wasPast = pastCliff(t);
  t.wear = Math.min(100, t.wear + cfg[t.compound].wearPerLap);
  t.lapsOn++;
  const h = tyreHealth(t);
  const chance = h <= 0 ? 100 : h <= cfg.punctB ? cfg.punctBChance : h <= cfg.punctA ? cfg.punctAChance : 0;
  if (chance && rnd() * 100 < chance) { t.punctured = true; return 'puncture'; }
  return !wasPast && pastCliff(t) ? 'cliff' : null;
}
