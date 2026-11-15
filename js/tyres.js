// Pneus (mode arcade) : trois gommes aux comportements bien marqués.
//  - vitesse quand ils sont neufs, usure à chaque tour, « falaise » d'usure (au-delà,
//    la voiture ralentit nettement), tours de chauffe après un changement ;
//  - changement au stand : la voiture reste immobile X secondes dans la voie des stands
//    et repart avec la gomme choisie (vue pilote, ou écran de course) ;
//  - tout se règle par gomme dans Réglages → Pneus.
// Les pneus agissent sur la vitesse (le seul levier de la Control Unit, avec le freinage).

export const COMPOUNDS = ['soft', 'medium', 'hard'];
export const COMPOUND_INFO = {
  soft: { label: 'Tendre', short: 'T', color: '#e10600' },
  medium: { label: 'Medium', short: 'M', color: '#facc15' },
  hard: { label: 'Dur', short: 'D', color: '#f5f5f5' },
};

// Réglages d'origine (arcade : écarts francs entre les gommes)
export const DEFAULT_TYRES = {
  changeSec: 3,          // temps d'arrêt au stand pour changer les pneus
  start: 'medium',       // gomme de départ par défaut
  soft: { newPct: 100, wearPerLap: 8, cliffPct: 70, wornPct: 60, warmLaps: 1, coldPct: 85 },
  medium: { newPct: 90, wearPerLap: 5, cliffPct: 75, wornPct: 65, warmLaps: 1, coldPct: 85 },
  hard: { newPct: 80, wearPerLap: 3, cliffPct: 80, wornPct: 70, warmLaps: 2, coldPct: 85 },
};

const num = (v, min, max, d) => { const n = +v; return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d; };

/** Réglages complets (valeurs de l'utilisateur, sinon celles d'origine), bornés. */
export function tyreCfg(saved = {}) {
  const c = { changeSec: num(saved.changeSec, 0, 30, DEFAULT_TYRES.changeSec), start: COMPOUNDS.includes(saved.start) ? saved.start : DEFAULT_TYRES.start };
  for (const k of COMPOUNDS) {
    const d = DEFAULT_TYRES[k];
    const s = saved[k] || {};
    c[k] = {
      newPct: num(s.newPct, 10, 100, d.newPct),
      wearPerLap: num(s.wearPerLap, 0, 100, d.wearPerLap),
      cliffPct: num(s.cliffPct, 0, 100, d.cliffPct),
      wornPct: num(s.wornPct, 0, 100, d.wornPct),
      warmLaps: num(s.warmLaps, 0, 10, d.warmLaps),
      coldPct: num(s.coldPct, 10, 100, d.coldPct),
    };
  }
  return c;
}

/** Pneus neufs d'une gomme pour une voiture. */
export const freshTyres = (compound, next = compound) => ({ compound, wear: 0, lapsOn: 0, next, warm: false });

/**
 * Facteur de vitesse dû aux pneus (multiplie la vitesse du garage) :
 * neufs → newPct ; au-delà de la falaise, baisse jusqu'à wornPct à 100 % d'usure ;
 * pendant les tours de chauffe, × coldPct.
 */
export function tyreFactor(cfg, t) {
  if (!t) return 1;
  const g = cfg[t.compound];
  let pct = g.newPct;
  if (t.wear > g.cliffPct) {
    const k = Math.min(1, (t.wear - g.cliffPct) / Math.max(1, 100 - g.cliffPct));
    pct = g.newPct + (g.wornPct - g.newPct) * k;
  }
  if (t.lapsOn < g.warmLaps) pct *= g.coldPct / 100;
  return pct / 100;
}

/** État lisible : froid / OK / usé. */
export function tyreState(cfg, t) {
  if (!t) return '';
  const g = cfg[t.compound];
  if (t.lapsOn < g.warmLaps) return 'cold';
  if (t.wear > g.cliffPct) return 'worn';
  return 'ok';
}

/** Un tour bouclé : usure + fin de chauffe. */
export function wearLap(cfg, t) {
  if (!t) return;
  t.wear = Math.min(100, t.wear + cfg[t.compound].wearPerLap);
  t.lapsOn++;
}
