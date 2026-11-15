// Essence simulée par l'appli.
// Chaque voiture part avec le niveau de son réservoir (réglage garage, en %).
// À chaque tour, on retire un pourcentage qui dépend du temps du tour :
//   - fourchette nominale (ex. 3,50 à 3,70 s) -> consommation nominale (ex. 5 %)
//   - 4 fourchettes plus rapides -> on consomme plus (6, 7, 8, 10 %...)
//   - 4 fourchettes plus lentes  -> on consomme moins (4, 3, 2, 1 %...)
// Chaque fourchette est réglable (bornes 2-30 s, 1-40 %) et désactivable.
// Au stand (voie des stands), la voiture se ravitaille jusqu'à son réservoir.

export const LIMITS = { tMin: 2, tMax: 30, pMin: 0.5, pMax: 40 };
const half = (x) => Math.round(x * 2) / 2; // consommations au demi-pourcent

export function defaultFuelConfig() {
  return {
    enabled: true,
    mode: 'bands',        // 'bands' = selon le temps au tour ; 'fixed' = toujours la conso nominale
    nominalPct: 5,
    nominal: { min: 3.5, max: 3.7 },
    faster: [             // du plus proche au plus loin de la nominale
      { on: true, min: 3.4, max: 3.5, pct: 6 },
      { on: true, min: 3.3, max: 3.4, pct: 7 },
      { on: true, min: 3.2, max: 3.3, pct: 8 },
      { on: true, min: 3.1, max: 3.2, pct: 10 },
    ],
    slower: [
      { on: true, min: 3.7, max: 3.8, pct: 4 },
      { on: true, min: 3.8, max: 4.0, pct: 3 },
      { on: true, min: 4.0, max: 4.5, pct: 2 },
      { on: true, min: 4.5, max: 6.0, pct: 1 },
    ],
    refuelPerSec: 10,     // % ajoutés par seconde passée au stand
    lowWarnPct: 15,       // annonce "réserve"
    emptyMode: 'fixed',   // panne sèche : vitesse fixe (0-15, comme au garage)
    emptySpeedPct: 40,    //   mode 'pct' : vitesse limitée à ce % jusqu'au ravitaillement
    emptySpeedFixed: 4,   //   mode 'fixed' : vitesse imposée (0-15)
  };
}

/**
 * Réglage "équilibré" pour la course, trouvé par simulation (tools/strategie.mjs) :
 * 100 tours, voie des stands 4 s, plein à 15 %/s, pilotes irréguliers (±0,1 s, sorties).
 * Nominale, Rapide 1 et Rapide 3 finissent à moins d'1 s ; Rapide 4 et 2 à 3-4 s ;
 * les rythmes lents perdent 9 à 19 s (économiser ne suffit pas à gagner).
 */
export function balancedPreset() {
  return {
    mode: 'bands',
    refuelPerSec: 15,
    nominalPct: 5,
    nominal: { min: 3.5, max: 3.7 },
    faster: [
      { on: true, min: 3.4, max: 3.5, pct: 6 },
      { on: true, min: 3.3, max: 3.4, pct: 7 },
      { on: true, min: 3.2, max: 3.3, pct: 7 },
      { on: true, min: 3.1, max: 3.2, pct: 8 },
    ],
    slower: [
      { on: true, min: 3.7, max: 3.9, pct: 4 },
      { on: true, min: 3.9, max: 4.1, pct: 3 },
      { on: true, min: 4.1, max: 4.5, pct: 2 },
      { on: true, min: 4.5, max: 6.0, pct: 1 },
    ],
  };
}

/**
 * Réglage "Sprint 30 tours" (tools/optimise.mjs, 30 tours, mêmes conditions) :
 * comme l'équilibré mais l'attaque coûte un peu moins (Rapide 4 et 2 à -1 %).
 * Sur 30 tours, tous les rythmes de Rapide 4 à Nominale finissent à moins de 2,3 s,
 * attaquer à fond est très légèrement payant, les rythmes lents perdent 6 à 7 s.
 */
export function sprint30Preset() {
  const p = balancedPreset();
  p.faster[1].pct = 6; // Rapide 2
  p.faster[3].pct = 7; // Rapide 4
  return p;
}

/** Toutes les fourchettes actives, avec leur nom, triées de la plus rapide à la plus lente. */
export function activeBands(cfg) {
  const list = [
    ...cfg.faster.map((b, i) => ({ ...b, name: `Rapide ${i + 1}` })),
    { on: true, min: cfg.nominal.min, max: cfg.nominal.max, pct: cfg.nominalPct, name: 'Nominale' },
    ...cfg.slower.map((b, i) => ({ ...b, name: `Lent ${i + 1}` })),
  ];
  return list.filter((b) => b.on && b.max > b.min).sort((a, b) => a.min - b.min);
}

/**
 * Consommation (en % du réservoir plein) pour un tour de lapMs millisecondes.
 * - dans une fourchette active -> son pourcentage
 * - plus rapide que toutes les fourchettes -> celle de la plus rapide
 * - plus lent que toutes -> celle de la plus lente
 * - dans un trou (fourchette désactivée) -> consommation nominale
 */
export function consumption(cfg, lapMs) {
  if (cfg.mode === 'fixed') return { pct: cfg.nominalPct, band: 'Nominale' };
  const t = lapMs / 1000;
  const bands = activeBands(cfg);
  if (!bands.length) return { pct: cfg.nominalPct, band: 'Nominale' };
  const hit = bands.find((b) => t >= b.min && t < b.max);
  if (hit) return { pct: hit.pct, band: hit.name };
  if (t < bands[0].min) return { pct: bands[0].pct, band: bands[0].name + ' (au-delà)' };
  const last = bands[bands.length - 1];
  if (t >= last.max) return { pct: last.pct, band: last.name + ' (au-delà)' };
  return { pct: cfg.nominalPct, band: 'Nominale (fourchette désactivée)' };
}

/** Vérifie et corrige une config (bornes, types). */
export function sanitize(cfg) {
  const d = defaultFuelConfig();
  const c = { ...d, ...cfg };
  const num = (v, lo, hi, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  const band = (b, def) => ({
    on: b?.on ?? def.on,
    min: num(b?.min, LIMITS.tMin, LIMITS.tMax, def.min),
    max: num(b?.max, LIMITS.tMin, LIMITS.tMax, def.max),
    pct: half(num(b?.pct, LIMITS.pMin, LIMITS.pMax, def.pct)),
  });
  c.nominalPct = half(num(c.nominalPct, LIMITS.pMin, LIMITS.pMax, d.nominalPct));
  c.nominal = { min: num(c.nominal?.min, LIMITS.tMin, LIMITS.tMax, d.nominal.min), max: num(c.nominal?.max, LIMITS.tMin, LIMITS.tMax, d.nominal.max) };
  c.faster = d.faster.map((def, i) => band(cfg?.faster?.[i], def));
  c.slower = d.slower.map((def, i) => band(cfg?.slower?.[i], def));
  c.refuelPerSec = num(c.refuelPerSec, 1, 100, d.refuelPerSec);
  c.lowWarnPct = num(c.lowWarnPct, 0, 50, d.lowWarnPct);
  c.emptySpeedPct = Math.round(num(c.emptySpeedPct, 10, 100, d.emptySpeedPct));
  c.emptyMode = 'fixed'; // panne sèche : toujours une vitesse fixe (le mode « % de sa vitesse » a été retiré)
  c.emptySpeedFixed = Math.round(num(c.emptySpeedFixed, 0, 15, d.emptySpeedFixed));
  return c;
}
