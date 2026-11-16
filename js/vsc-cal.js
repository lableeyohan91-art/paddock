// VSC adaptatif : étalonnage de chaque voiture, par circuit.
// Un « test 12 tours » mesure le temps au tour médian d'une voiture à un cran donné
// (manette enfoncée à 100 %). Avec 4 mesures (0 %, 13 %, 27 %, 33 % = crans 0, 2, 4, 5),
// on déduit le temps à chaque cran de 0 à 5, puis le cran qui fait rouler la voiture
// au plus près du temps au tour cible du VSC.
// Mesures rangées dans la voiture : car.vscCal[trackId][cran] = { sec, laps, date } ou { impossible: true, date }.

export const CAL_TESTS = [
  { cran: 0, pct: 0 },
  { cran: 2, pct: 13 },
  { cran: 4, pct: 27 },
  { cran: 5, pct: 33 },
];
export const CAL_LAPS = 12;   // tours chronométrés (le 1er, de lancement, est écarté du calcul)
export const MAX_CRAN = 5;

/** Mesures d'une voiture sur un circuit. */
export const calOf = (car, trackId) => car?.vscCal?.[trackId] || {};

/** Temps au tour (s) à chaque cran 0..5 : mesuré, sinon déduit entre deux mesures voisines. */
export function timesByCran(cal) {
  const pts = Object.entries(cal)
    .filter(([, v]) => v && v.sec > 0)
    .map(([c, v]) => [+c, v.sec])
    .sort((a, b) => a[0] - b[0]);
  const out = Array(MAX_CRAN + 1).fill(null);
  for (let c = 0; c <= MAX_CRAN; c++) {
    const exact = pts.find((p) => p[0] === c);
    if (exact) { out[c] = exact[1]; continue; }
    const lo = [...pts].reverse().find((p) => p[0] < c);
    const hi = pts.find((p) => p[0] > c);
    if (lo && hi) out[c] = lo[1] + ((hi[1] - lo[1]) * (c - lo[0])) / (hi[0] - lo[0]);
  }
  return out;
}

/** Temps possibles pour cette voiture sur ce circuit : { min, max } (s), ou null si pas étalonnée. */
export function reach(car, trackId) {
  const t = timesByCran(calOf(car, trackId)).filter((x) => x > 0);
  return t.length >= 2 ? { min: Math.min(...t), max: Math.max(...t) } : null;
}

/**
 * Cran qui fait rouler la voiture au plus près du temps cible.
 * Renvoie { cran, sec, ok } (ok = cible atteignable), ou null si pas assez de mesures.
 */
export function cranFor(car, trackId, targetSec) {
  const times = timesByCran(calOf(car, trackId));
  const r = reach(car, trackId);
  if (!r || !(targetSec > 0)) return null;
  let best = null;
  times.forEach((sec, cran) => {
    if (!(sec > 0)) return;
    const d = Math.abs(sec - targetSec);
    if (!best || d < best.d) best = { cran, sec, d };
  });
  const tol = 0.15; // s : un peu de marge au bord de ce que la voiture sait faire
  return { cran: best.cran, sec: best.sec, ok: targetSec >= r.min - tol && targetSec <= r.max + tol };
}

/** Médiane des temps (s). */
export function medianOf(list) {
  const a = [...list].sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
