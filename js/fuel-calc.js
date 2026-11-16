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


// ================= Formule continue (3 profils) =================
import { curveConsumption } from './fuel.js';

/**
 * Statistiques d'un pilote sur un circuit, tirées de ses tours enregistrés :
 *  - median : temps médian en course (drapeau vert) ;
 *  - best   : meilleur tour (records importés compris) ;
 *  - top10  : moyenne de ses 10 meilleurs tours en course (rythme d'attaque tenable) ;
 *  - spread : régularité (écart entre ses tours habituels, en % du médian).
 */
export function driverStats(laps, driverId, trackId) {
  const mine = onTrack(driverId ? laps.filter((l) => l.driverId === driverId) : laps, trackId);
  const race = mine.filter((l) => !l.imported && l.sessionType === 'race' && (!l.flag || l.flag === 'green')).map((l) => l.time / 1000);
  const all = mine.map((l) => l.time / 1000).filter((x) => x > 0);
  if (!all.length) return null;
  const sorted = [...race].sort((a, b) => a - b);
  const top = sorted.slice(0, 10);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const med = median(race);
  return {
    median: med === null ? null : r2(med),
    best: r2(Math.min(...all)),
    top10: top.length ? r2(top.reduce((s, x) => s + x, 0) / top.length) : null,
    spread: sorted.length >= 8 && med ? Math.round(((q(0.75) - q(0.25)) / med) * 1000) / 10 : null,
    laps: race.length,
  };
}

const PROFILE_TARGETS = {
  // gains visés (en part du temps de course) par rapport au rythme nominal
  attaque: (g) => Math.abs(g.attack - 0.02) + Math.abs(g.light - 0.01) + 0.5 * Math.abs(g.best - 0.01),
  equilibre: (g) => Math.abs(g.light - 0.006) + 0.5 * Math.abs(g.attack - 0.003) + 3 * Math.max(0, g.best),
  gestion: (g) => Math.abs(g.light + 0.004) + 0.5 * Math.abs(g.attack + 0.01) + 3 * Math.max(0, g.best + 0.015),
};

/**
 * Réglage de la formule continue pour un groupe de pilotes et une course.
 * input : { median, best, top10, pitLap, laps, stops, profile }.
 * Renvoie { cfg, rows, chart, bestMix, pitLoss, paces } ou { error }.
 */
export function optimizeCurve({ median: med, best, top10, pitLap, laps: L, stops: S, profile = 'equilibre' }) {
  if (!(med > 0 && best > 0 && L > 0 && S >= 0)) return { error: 'Remplis le temps médian, le meilleur tour, le nombre de tours et d\'arrêts.' };
  if (best >= med - 0.05) return { error: 'Le meilleur tour doit être nettement plus rapide que le temps médian (au moins 0,05 s).' };
  if (!(pitLap > med)) return { error: 'Le tour avec arrêt au stand doit être plus long que le temps médian.' };
  const pitLoss = pitLap - med;
  const tA = top10 > best && top10 < med ? top10 : best + (med - best) * 0.35; // attaque tenable
  const tR = (tA + med) / 2;                                                   // attaque légère
  // nominale : le plein impose S arrêts, avec une marge (on vise 60 % du dernier plein)
  let pN = Math.round((100 * (S + 0.6)) / L * 10) / 10;
  const stopsOf = (F) => (F <= TANK ? 0 : Math.ceil((F - TANK) / TANK - 1e-9));
  while (pN > 0.2 && stopsOf(L * pN) > S) pN = Math.round((pN - 0.1) * 10) / 10;
  while (stopsOf(L * pN) < S) pN = Math.round((pN + 0.1) * 10) / 10;
  if (pN > LIMIT_P) return { error: `Impossible d'obtenir ${S} arrêt(s) sur ${L} tours.` };

  const race1 = (curve, R, t) => raceTime(L, t, curveConsumption(curve, t).pct, pitLoss, R);
  const slow = [med * 1.03, med * 1.06, med * 1.1];
  let bestCfg = null;
  for (let k = 0; k <= 12; k += 0.25) for (const R of [5, 8, 10, 12, 15, 20, 25, 30]) {
    const curve = { nominalPct: pN, medianSec: med, k, profile };
    const TN = race1(curve, R, med).total;
    const g = (t) => (TN - race1(curve, R, t).total) / TN;
    const gains = { best: g(best), attack: g(tA), light: g(tR) };
    let score = PROFILE_TARGETS[profile](gains);
    for (const t of slow) score += 10 * Math.max(0, g(t) + 0.003); // économiser ne doit jamais payer
    if (!bestCfg || score < bestCfg.score) bestCfg = { score, curve, R, TN };
  }
  const { curve, R, TN } = bestCfg;
  const row = (name, t) => {
    const p = curveConsumption(curve, t).pct;
    const r = raceTime(L, t, p, pitLoss, R);
    return { name, t: r2(t), pct: p, perTank: Math.floor(TANK / p), stops: r.stops, total: r.total, gap: r.total - TN };
  };
  const rows = [
    row('Meilleur tour', best), row('Attaque', tA), row('Attaque légère', tR), row('Nominal', med),
    row('Économie légère', slow[0]), row('Économie', slow[1]), row('Économie forte', slow[2]),
  ];
  // courbe : écart de temps de course selon le rythme tenu
  const chart = [];
  for (let t = best; t <= med * 1.12 + 1e-9; t += (med * 1.12 - best) / 60) chart.push({ t: r2(t), gap: race1(curve, R, t).total - TN });
  // meilleure stratégie possible (mélange de 2 rythmes) : vérifie qu'il n'y a pas de faille
  const paces = []; for (let t = best; t <= med * 1.12 + 1e-9; t += 0.01) paces.push(r2(t));
  const step = Math.max(1, Math.ceil(L / 100));
  let mix = null;
  for (let i = 0; i < paces.length; i++) for (let j = i; j < paces.length; j++) {
    const pi = curveConsumption(curve, paces[i]).pct, pj = curveConsumption(curve, paces[j]).pct;
    for (let a = 0; a <= L; a += step) {
      const F = a * pi + (L - a) * pj;
      const st = stopsOf(F);
      const T = a * paces[i] + (L - a) * paces[j] + st * pitLoss + Math.max(0, F - TANK) / R;
      if (!mix || T < mix.total) mix = { total: T, stops: st, a, ti: paces[i], tj: paces[j] };
      if (i === j) break;
    }
  }
  return {
    cfg: { mode: 'curve', curve, refuelPerSec: R },
    rows, chart, pitLoss: r2(pitLoss),
    bestMix: { gap: mix.total - TN, stops: mix.stops, desc: mix.a === L || mix.a === 0 ? `tous les tours en ${String(mix.a === L ? mix.ti : mix.tj).replace('.', ',')} s` : `${mix.a} tours en ${String(mix.ti).replace('.', ',')} s + ${L - mix.a} en ${String(mix.tj).replace('.', ',')} s` },
  };
}
const LIMIT_P = 40;
