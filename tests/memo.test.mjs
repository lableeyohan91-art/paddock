// Fiches mémo : après rotation, les statistiques doivent rester identiques.
// node tests/memo.test.mjs
import { planRotation, foldInto, counts, dayKey, KEEP_SESSIONS } from '../js/memo.js';
import { raceMedianOf, bestOfDrivers, driverStats } from '../js/fuel-calc.js';

let fails = 0;
const ok = (c, m) => { if (!c) fails++; console.log((c ? 'OK   ' : 'ÉCHEC ') + m); };

// --- données de test : 3 pilotes, 2 voitures, 2 circuits, 9 séances sur 6 jours ---
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const drivers = ['d1', 'd2', 'd3'], cars = ['c1', 'c2'], tracks = ['t1', 't2'];
const sessions = [], laps = [];
let id = 0;
for (let s = 0; s < 9; s++) {
  const day = Date.UTC(2026, 10, 1 + Math.floor(s / 2), 14, 0, 0) + s * 3600e3;
  const type = ['race', 'qualifying', 'practice'][s % 3];
  const trackId = tracks[s % 2];
  const sid = 's' + s;
  sessions.push({ id: sid, date: day, type, trackId });
  for (const d of drivers) {
    const carId = cars[(s + d.length) % 2];
    const nSec = s % 4 === 0 ? 0 : 3;
    for (let n = 1; n <= 25; n++) {
      const base = 3400 + drivers.indexOf(d) * 120 + Math.round(rnd() * 400);
      const sectors = nSec ? [1100, 1150, 1150].map((x) => x + Math.round(rnd() * 120)) : [];
      laps.push({
        id: 'l' + (++id), sessionId: sid, sessionType: type, trackId, driverId: d, carId, lapNo: n,
        time: nSec ? sectors.reduce((a, b) => a + b, 0) : base, sectors,
        flag: rnd() < 0.08 ? 'yellow' : 'green', date: day + n * 4000, wetness: 0,
      });
    }
  }
}
// un record importé (jamais effacé)
laps.push({ id: 'imp1', sessionId: 'import-2026-10-01', sessionType: 'import', trackId: 't1', driverId: 'd1', carId: 'c1', time: 3100, sectors: [], flag: 'green', date: Date.UTC(2026, 9, 1, 12), imported: 'smartrace' });

// --- rotation ---
const plan = planRotation(sessions, laps, []);
ok(plan.recent.size === KEEP_SESSIONS, `garde les ${KEEP_SESSIONS} dernières séances`);
const memos = [];
plan.toFold.forEach((ls) => memos.push(foldInto(null, ls)));
const del = new Set(plan.toDelete);
const left = laps.filter((l) => !del.has(l.id));
ok(left.some((l) => l.imported), 'record importé conservé');
ok(left.every((l) => l.imported || plan.recent.has(l.sessionId)), 'seuls restent les tours des 3 dernières séances');
const after = [...left, ...memos.flatMap((m) => m.keep)];

// --- comparaisons ---
const same = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), m + (JSON.stringify(a) === JSON.stringify(b) ? '' : ` (${JSON.stringify(a)} ≠ ${JSON.stringify(b)})`));
const best = (ls) => Math.min(...ls.filter((l) => l.flag !== 'yellow').map((l) => l.time));
const top10 = (ls) => ls.filter((l) => l.flag !== 'yellow').map((l) => l.time).sort((a, b) => a - b).slice(0, 10);
const perDay = (ls) => { const m = {}; for (const l of ls.filter((x) => x.flag !== 'yellow')) { const k = dayKey(l.date); m[k] = Math.min(m[k] ?? Infinity, l.time); } return Object.fromEntries(Object.entries(m).sort()); };
const secBest = (ls) => { const m = {}; for (const l of ls.filter((x) => x.flag !== 'yellow' && x.sectors?.length >= 2)) l.sectors.forEach((t, i) => { const k = l.sectors.length + ':' + i; m[k] = Math.min(m[k] ?? Infinity, t); }); return m; };
for (const d of drivers) for (const t of tracks) {
  const A = laps.filter((l) => l.driverId === d && l.trackId === t);
  const B = after.filter((l) => l.driverId === d && l.trackId === t);
  same(best(B), best(A), `${d}/${t} record`);
  same(top10(B), top10(A), `${d}/${t} 10 meilleurs tours`);
  same(perDay(B), perDay(A), `${d}/${t} meilleur tour par jour`);
  same(secBest(B), secBest(A), `${d}/${t} records de secteurs`);
  const cA = counts(A, []), cB = counts(left.filter((l) => l.driverId === d && l.trackId === t), memos, (x) => x.driverId === d && x.trackId === t);
  same(cB, cA, `${d}/${t} tours, temps de roulage, séances`);
  // calcul d'essence : 30 derniers tours de course, médiane, meilleur tour
  same(raceMedianOf(B, d, t), raceMedianOf(A, d, t), `${d}/${t} médiane des 30 derniers tours de course`);
  const ds = (ls) => { const x = driverStats(ls, d, t); if (x) delete x.laps; return x; }; // laps = nombre total de tours de course (compteur, hors calcul)
  same(ds(B), ds(A), `${d}/${t} statistiques essence (médiane, meilleur, top 10, régularité)`);
}
for (const t of tracks) same(bestOfDrivers(after, drivers, t), bestOfDrivers(laps, drivers, t), `${t} meilleur tour des pilotes`);

// --- idempotence : un tour revenu d'un autre appareil n'est pas compté deux fois ---
const again = planRotation(sessions, [...left, laps.find((l) => del.has(l.id))], memos);
const m2 = [...again.toFold.values()].length;
ok(m2 === 0 && again.toDelete.length === 1, 'tour déjà versé : effacé sans être recompté');
ok(foldInto(memos[0], laps.filter((l) => memos[0].folded.includes(l.sessionId) && `${l.driverId}|${l.carId}|${l.trackId}` === memos[0].id)).laps === memos[0].laps, 'séance déjà versée : compteurs inchangés');

console.log(fails ? `\n${fails} échec(s)` : '\nTout est bon.');
process.exit(fails ? 1 : 0);
