// Calculateur d'équilibrage de l'essence (Réglages → Essence → Temps de référence).
// À partir de quelques valeurs du circuit (record, temps médian, tour avec arrêt au stand)
// et de la course voulue (nombre de tours, arrêts au rythme nominal), il cherche les
// fourchettes de temps, les consommations et la vitesse de remplissage les plus équilibrées :
//  - au rythme nominal, le plein impose exactement le nombre d'arrêts voulu ;
//  - rouler plus vite fait gagner du temps sur la piste mais coûte de l'essence (arrêts
//    en plus, remplissage plus long) : les rythmes rapides finissent au plus près du nominal ;
//  - rouler lentement pour économiser ne paie pas (un peu plus lent que le nominal) ;
//  - il utilise le plus de fourchettes possible (4 rapides, 4 lentes), sinon 3 ou 2.
// Le calcul est direct (pas de course tour par tour) : quelques millisecondes.

const TANK = 100;
const r2 = (x) => Math.round(x * 100) / 100;

/** Médiane d'une liste de nombres (null si vide). */
export function median(list) {
  const a = list.filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/** Tours d'un circuit (tous si le circuit n'est pas connu sur les tours). */
const onTrack = (laps, trackId) => laps.filter((l) => !trackId || !l.trackId || l.trackId === trackId);

/** Record du circuit (s) : meilleur tour roulé ou importé. */
export function trackRecord(laps, trackId) {
  const t = onTrack(laps, trackId).map((l) => l.time).filter((x) => x > 0);
  return t.length ? r2(Math.min(...t) / 1000) : null;
}

/** Temps médian au tour d'un pilote en course (s), calculé sur ses tours roulés en course, drapeau vert. */
export function raceMedianOf(laps, driverId, trackId) {
  const t = onTrack(laps, trackId)
    .filter((l) => l.driverId === driverId && !l.imported && l.sessionType === 'race' && (!l.flag || l.flag === 'green'))
    .map((l) => l.time / 1000);
  const m = median(t);
  return m === null ? null : { sec: r2(m), laps: t.length };
}

/** Temps total d'une course de L tours à un rythme (temps au tour t, conso p %/tour). */
export function raceTime(L, t, p, pitLoss, refuel) {
  const fuel = L * p;
  const stops = fuel <= TANK ? 0 : Math.ceil((fuel - TANK) / TANK - 1e-9);
  return { total: L * t + stops * pitLoss + Math.max(0, fuel - TANK) / refuel, stops };
}

/** Toutes les suites strictement croissantes de n écarts pris dans steps. */
function* increments(n, steps) {
  if (n === 0) { yield []; return; }
  for (const s of steps) for (const rest of increments(n - 1, steps)) yield [s, ...rest];
}

/**
 * Cherche le réglage le plus équilibré.
 * input : { record, median, pitLap, laps, stops } (temps en secondes).
 * Renvoie { cfg (morceau de configuration essence), rows (tableau des rythmes), pitLoss } ou { error }.
 */
export function optimizeFuel({ record, median: med, pitLap, laps: L, stops: S }) {
  if (!(record > 0 && med > 0 && L > 0 && S >= 0)) return { error: 'Remplis le record, le temps médian, le nombre de tours et d\'arrêts.' };
  if (record >= med) return { error: 'Le record doit être plus rapide que le temps médian.' };
  const pitLoss = Math.max(0, (pitLap || med) - med);

  // conso nominale : le plein (100 %) impose exactement S arrêts sur L tours
  const noms = [];
  for (let p = 0.5; p <= 40; p += 0.5) {
    const { stops } = raceTime(L, med, p, pitLoss, 1);
    if (stops !== S) continue;
    const margin = (L * p) / TANK - S; // 0..1 : part du dernier plein utilisée
    noms.push({ p, margin });
  }
  if (!noms.length) return { error: `Impossible d'obtenir ${S} arrêt(s) sur ${L} tours avec une consommation entre 0,5 et 40 % par tour.` };

  let best = null;
  for (const wPct of [0.01, 0.02, 0.03]) {
    const w = Math.max(0.02, r2(med * wPct));
    const nomMin = r2(med - w), nomMax = r2(med + w);
    if (nomMin <= record) continue;
    for (const { p: pN, margin } of noms) {
      for (const R of [5, 8, 10, 12, 15, 20, 25, 30]) {
        const TN = raceTime(L, med, pN, pitLoss, R).total;
        const marginCost = 0.003 * Math.max(0, 0.3 - margin) / 0.3;

        // rapides : de 2 à 4 fourchettes entre le record et la nominale
        let fast = null;
        for (let nF = 2; nF <= 4; nF++) {
          const width = (nomMin - record) / nF;
          if (width < 0.02) continue;
          const bands = Array.from({ length: nF }, (_, i) => ({ max: r2(nomMin - width * i), min: r2(nomMin - width * (i + 1)) }));
          bands[nF - 1].min = r2(Math.min(bands[nF - 1].min, record) - 0.05); // la plus rapide englobe le record
          for (const inc of increments(nF, [0.5, 1, 1.5, 2, 3])) {
            let p = pN, cost = 0, tooMany = false;
            const out = bands.map((b, i) => {
              p += inc[i];
              const t = i === nF - 1 ? (record + bands[i].max) / 2 : (b.min + b.max) / 2;
              const r = raceTime(L, t, p, pitLoss, R);
              if (r.stops > S + 2) tooMany = true; // attaquer : 2 arrêts de plus au maximum
              cost = Math.max(cost, Math.abs(r.total - TN) / TN);
              return { ...b, pct: p };
            });
            if (p > 40 || tooMany) continue;
            cost += 0.01 * (4 - nF); // le plus de fourchettes possible (course plus vivante)
            if (!fast || cost < fast.cost) fast = { cost, bands: out };
          }
        }
        if (!fast) continue;

        // lentes : de 2 à 4 fourchettes ; la dernière va jusqu'aux tours ratés (sorties, VSC)
        let slow = null;
        const step = Math.max(0.05, r2((nomMin - record) / 3));
        for (let nS = 2; nS <= 4; nS++) {
          const bands = [];
          let lo = nomMax;
          for (let i = 0; i < nS - 1; i++) { bands.push({ min: r2(lo), max: r2(lo + step) }); lo += step; }
          bands.push({ min: r2(lo), max: r2(Math.min(30, Math.max(lo + step, med * 2))) });
          for (const dec of increments(nS, [0.5, 1, 1.5, 2])) {
            let p = pN, cost = 0;
            const out = bands.map((b, i) => {
              p -= dec[i];
              // rythme lent volontaire : doit perdre, de peu (≈ 1 %) ; la dernière fourchette
              // (ouverte jusqu'aux tours ratés) est testée à son début
              const t = i < nS - 1 ? (b.min + b.max) / 2 : b.min + step / 2;
              const T = raceTime(L, t, p, pitLoss, R).total;
              const loss = (T - TN) / TN;
              cost += loss < 0.003 ? 0.05 + 10 * (0.003 - loss) : Math.abs(loss - 0.01); // économiser ne doit jamais payer
              return { ...b, pct: p };
            });
            if (p < 0.5) continue;
            cost = cost / nS + 0.01 * (4 - nS);
            if (!slow || cost < slow.cost) slow = { cost, bands: out };
          }
        }
        if (!slow) continue;

        const score = fast.cost + slow.cost * 0.5 + marginCost;
        if (!best || score < best.score) best = { score, pN, R, nomMin, nomMax, fast: fast.bands, slow: slow.bands, TN, step };
      }
    }
  }
  if (!best) return { error: 'Aucun réglage trouvé : vérifie les temps (record et médian trop proches ?).' };

  // configuration : fourchettes actives, les autres désactivées au-delà
  const faster = [0, 1, 2, 3].map((i) => {
    if (best.fast[i]) return { on: true, ...best.fast[i] };
    const lo = best.fast[best.fast.length - 1].min;
    const k = i - best.fast.length;
    return { on: false, min: r2(Math.max(2, lo - 0.1 * (k + 1))), max: r2(Math.max(2.01, lo - 0.1 * k)), pct: best.fast[best.fast.length - 1].pct };
  });
  const slower = [0, 1, 2, 3].map((i) => {
    if (best.slow[i]) return { on: true, ...best.slow[i] };
    const hi = best.slow[best.slow.length - 1].max;
    const k = i - best.slow.length;
    return { on: false, min: r2(Math.min(29.98, hi + 0.5 * k)), max: r2(Math.min(30, hi + 0.5 * (k + 1))), pct: best.slow[best.slow.length - 1].pct };
  });
  const cfg = { mode: 'bands', nominalPct: best.pN, nominal: { min: best.nomMin, max: best.nomMax }, faster, slower, refuelPerSec: best.R };

  // tableau des rythmes (du plus rapide au plus lent)
  const row = (name, t, p, b) => {
    const r = raceTime(L, t, p, pitLoss, best.R);
    return { name, min: b.min, max: b.max, t: r2(t), pct: p, perTank: Math.floor(TANK / p), stops: r.stops, total: r.total, gap: r.total - best.TN };
  };
  const rows = [
    ...best.fast.map((b, i) => row(`Rapide ${i + 1}`, i === best.fast.length - 1 ? (record + b.max) / 2 : (b.min + b.max) / 2, b.pct, b)).reverse(),
    row('Nominale', med, best.pN, { min: best.nomMin, max: best.nomMax }),
    ...best.slow.map((b, i) => row(`Lent ${i + 1}`, i === best.slow.length - 1 ? b.min + best.step / 2 : (b.min + b.max) / 2, b.pct, b)),
  ];
  return { cfg, rows, pitLoss: r2(pitLoss) };
}

