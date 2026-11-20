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
  mode: 'auto',        // 'auto' : l'appli calcule l'usure selon le nombre de tours ; 'manual' : réglages ci-dessous
  f1Cran: 4,           // automatique : ce que coûte un cran, en % du temps au tour (à mesurer sur le circuit)
  f1Lane: 4.4,         // automatique : temps perdu dans la voie des stands, en s (à mesurer)
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
    mode: saved.mode === 'manual' ? 'manual' : 'auto',
    f1Cran: num(saved.f1Cran, 1, 10, D.f1Cran),
    f1Lane: num(saved.f1Lane, 0, 15, D.f1Lane),
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

// ---------------------------------------------------------------------------------------------
// Mode F1 (en développement) : course sans essence, à partir de 50 tours, 2 gommes obligatoires.
// L'usure et le temps de changement sont calculés selon le nombre de tours (rapport 6, partie 8) :
//   vie du Tendre (tours avant la zone de chute de grip) V = 1,8 × √tours ;
//   usure Tendre = 75 / V %/tour, Medium = moitié, Dur = 3/8 ;
//   arrêt total = 2 × coût d'un cran × V ; changement = arrêt total − voie des stands (au moins 1 s).
// Vitesses du réglage « A » : Tendre normal, Medium −1 cran, Dur −1 cran et −1 de freinage.
export const F1_MIN_LAPS = 50;
export const F1_LIFE_K = 1.8;     // vie du Tendre = 1,8 × √tours

/**
 * Valeurs automatiques pour une course de `laps` tours, tour de référence `lapSec` (s),
 * cran = coût d'un cran en % du tour, lane = temps perdu dans la voie des stands (s).
 */
export function f1Plan(laps, lapSec = 3.4, cranPct = DEFAULT_TYRES.f1Cran, lane = DEFAULT_TYRES.f1Lane) {
  const L = Math.max(F1_MIN_LAPS, laps || 0);
  const life = Math.max(8, Math.round(F1_LIFE_K * Math.sqrt(L)));
  const wear = 75 / life;
  const cran = (cranPct / 100) * (lapSec > 0 ? lapSec : 3.4);
  const stopSec = 2 * cran * life; // arrêt total qui équilibre les 3 gommes
  const changeSec = Math.max(1, Math.min(30, Math.round(stopSec - lane))); // au moins 1 s : il faut vraiment s'arrêter
  const r = (x) => Math.round(x * 100) / 100;
  return { laps: L, life, changeSec, stopSec: r(stopSec), cranSec: r(cran), wear: { soft: r(wear), medium: r(wear / 2), hard: r(wear * 0.375) } };
}

/**
 * Réglages de pneus complets calculés pour une course : chute de grip et crevaisons aux valeurs
 * d'origine (celles de l'étude) ; gomme de départ et vitesse en crevaison : celles du joueur.
 */
export function f1TyreCfg(laps, lapSec, base = DEFAULT_TYRES) {
  const p = f1Plan(laps, lapSec, base.f1Cran, base.f1Lane);
  return tyreCfg({
    ...DEFAULT_TYRES,
    mode: 'auto', f1Cran: base.f1Cran, f1Lane: base.f1Lane,
    punctSpeedPct: base.punctSpeedPct ?? DEFAULT_TYRES.punctSpeedPct,
    changeSec: p.changeSec,
    start: base.start || 'medium',
    soft: { speedOff: 0, brakeOff: 0, wearPerLap: p.wear.soft, warmLaps: 1, coldOff: 1 },
    medium: { speedOff: 1, brakeOff: 0, wearPerLap: p.wear.medium, warmLaps: 1, coldOff: 1 },
    hard: { speedOff: 1, brakeOff: 1, wearPerLap: p.wear.hard, warmLaps: 1, coldOff: 1 },
  });
}

/** Réglages de la course F1 : calculés (Automatique) ou ceux du joueur (Manuel). */
export function raceTyreCfg(laps, lapSec, base = DEFAULT_TYRES) {
  return base.mode === 'manual' ? tyreCfg(base) : f1TyreCfg(laps, lapSec, base);
}

/** Tour (depuis le changement) où la santé descend à h %, ou Infinity si la gomme ne s'use pas. */
export const lapAtHealth = (g, h) => (g.wearPerLap > 0 ? (100 - h) / g.wearPerLap : Infinity);
