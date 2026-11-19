// Fiches mémo : après rotation, les statistiques doivent rester identiques.
// node tests/memo.test.mjs
import { planRotation, foldInto, counts, dayKey, KEEP_SESSIONS, memoLaps, compactMemo, pickKeep, slimSession, upkeep, MEMO_V, voidInMemo, statLaps } from '../js/memo.js';
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
const after = [...left, ...memos.flatMap(memoLaps)];

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

// --- v1.99.1 : meilleur tour du jour en compact ---
ok(memos.every((m) => m.v === MEMO_V && Object.values(m.days).every((d) => d.best && d.best.t > 0)), 'chaque jour a son meilleur tour en compact');
// ancienne fiche (v1.99) : meilleur tour du jour gardé comme tour témoin complet
const oldPick = (list) => { const k = new Map(pickKeep(list).map((l) => [l.id, l])); const byDay = new Map();
  for (const l of list.filter((x) => x.flag !== 'yellow')) { const d = dayKey(l.date); const c = byDay.get(d); if (!c || l.time < c.time) byDay.set(d, l); }
  byDay.forEach((l) => k.set(l.id, l)); return [...k.values()]; };
const olds = memos.map((m) => { const o = structuredClone(m); delete o.v; o.days = Object.fromEntries(Object.entries(o.days).map(([k, d]) => [k, { laps: d.laps, sessions: d.sessions }]));
  const src = laps.filter((l) => `${l.driverId}|${l.carId}|${l.trackId}` === m.id && del.has(l.id)); o.keep = oldPick(src.map((l) => ({ ...l, kept: true }))); return o; });
const news = olds.map((o) => compactMemo(o));
ok(news.every((n) => n && n.v === MEMO_V), 'ancienne fiche convertie');
ok(compactMemo(news[0]) === null, 'fiche déjà convertie : rien à refaire');
const afterOld = [...left, ...olds.flatMap((m) => m.keep)], afterNew = [...left, ...news.flatMap(memoLaps)];
let sameAll = true;
for (const d of drivers) for (const t of tracks) {
  const A = afterOld.filter((l) => l.driverId === d && l.trackId === t), B = afterNew.filter((l) => l.driverId === d && l.trackId === t);
  if (JSON.stringify(perDay(A)) !== JSON.stringify(perDay(B)) || best(A) !== best(B) || JSON.stringify(top10(A)) !== JSON.stringify(top10(B))) sameAll = false;
}
ok(sameAll, 'conversion : record, 10 meilleurs, meilleur tour par jour identiques');
const sz = (a) => JSON.stringify(a).length;
// 300 jours de roulage (1 séance de 20 tours par jour) : c'est là que le gain se voit
const long = [];
for (let j = 0; j < 300; j++) for (let n = 0; n < 20; n++) long.push({ id: `L${j}-${n}`, sessionId: 'S' + j, sessionType: 'race', trackId: 't1', driverId: 'd1', carId: 'c1',
  time: 3300 + Math.round(rnd() * 500), sectors: [], flag: 'green', date: Date.UTC(2026, 0, 1 + j, 14) + n * 4000, wetness: 0 });
const mNew = foldInto(null, long);
const mOld = structuredClone(mNew); delete mOld.v;
mOld.days = Object.fromEntries(Object.entries(mOld.days).map(([k, d]) => [k, { laps: d.laps, sessions: d.sessions }]));
mOld.keep = oldPick(long.map((l) => ({ ...l, kept: true })));
console.log(`     fiche de 300 jours : avant ${sz(mOld)} o, après ${sz(mNew)} o`);
ok(sz(mNew) < sz(mOld) * 0.6, 'fiche de 300 jours nettement plus légère');
ok(JSON.stringify(perDay(memoLaps(mNew))) === JSON.stringify(perDay(long)), 'fiche de 300 jours : meilleur tour de chaque jour exact');

// --- tours sans pilote : effacés avec leur séance, jamais versés ---
const orphan = { id: 'o1', sessionId: 's0', sessionType: 'race', trackId: 't1', driverId: null, carId: 'c1', time: 3000, date: sessions[0].date };
const p3 = planRotation(sessions, [...laps, orphan], []);
ok(p3.toDelete.includes('o1') && ![...p3.toFold.values()].flat().some((l) => l.id === 'o1'), 'tour sans pilote d’une vieille séance : effacé, pas versé');
const p4 = planRotation(sessions, [...laps, { ...orphan, id: 'o2', sessionId: [...p3.recent][0] }], []);
ok(!p4.toDelete.includes('o2'), 'tour sans pilote d’une des 3 dernières séances : gardé');

// --- fiches de séance allégées ---
const fat = { id: 'sx', state: 'finished', type: 'race', date: 1, trackId: 't1', bestLap: 3000, completed: true,
  entries: [{ address: 0, driverId: 'd1', carId: 'c1' }],
  results: [{ position: 1, address: 0, driverId: 'd1', driverName: 'Nom', carId: 'c1', carName: 'Voiture', laps: 20, bestLap: 3000, totalTime: 70000, gap: 0, pitStops: 1 }] };
const slim = slimSession(fat);
ok(!slim.entries && JSON.stringify(slim.results) === JSON.stringify([{ position: 1, driverId: 'd1', carId: 'c1', laps: 20, bestLap: 3000 }]), 'fiche de séance allégée');
ok(slimSession({ ...fat, state: 'running' }).entries, 'séance en cours : inchangée');
console.log(`     fiche de séance : avant ${sz(fat)} o, après ${sz(slim)} o`);

// --- entretien : sauvegarde vidée après 30 jours ---
const store = { settings: new Map(), memos: [], sessions: [] };
const fakeDb = { putMany: async (n, l) => store[n].push(...l), getSetting: async (k, f) => store.settings.get(k) ?? f, setSetting: async (k, v) => store.settings.set(k, v) };
store.settings.set('backupBeforeMemo', { date: Date.now() - 31 * 864e5, data: { gros: 'x'.repeat(1000) } });
const ss = [fat], ms = [olds[0]];
const r = await upkeep(fakeDb, ss, ms);
ok(r.memos === 1 && r.sessions === 1 && ms[0].v === MEMO_V && !ss[0].entries, 'entretien : fiche mémo et fiche de séance converties');
ok(store.settings.get('backupBeforeMemo').data === null && store.settings.get('backupBeforeMemo').date, 'sauvegarde de plus de 30 jours vidée (date gardée)');
store.settings.set('backupBeforeMemo', { date: Date.now() - 5 * 864e5, data: { a: 1 } });
const r2 = await upkeep(fakeDb, ss, ms);
ok(store.settings.get('backupBeforeMemo').data && r2.memos === 0 && r2.sessions === 0, 'sauvegarde récente gardée, rien à refaire');

// --- tours annulés (non homologués) ---
{
  const m0 = memos[0];
  const top = [...memoLaps(m0)].sort((a, b) => a.time - b.time)[0];
  const v = voidInMemo(m0, top.id);
  ok(v && !memoLaps(v).some((l) => l.id === top.id), 'tour annulé : retiré des tours témoins et du meilleur tour du jour');
  ok(v.laps === m0.laps && v.drivingMs === m0.drivingMs, 'tour annulé : toujours compté dans les tours et le temps de roulage');
  ok(voidInMemo(m0, 'inconnu') === null, 'tour absent de la fiche : rien à faire');
  // tour annulé avant d'être versé : compté, jamais gardé comme témoin
  const src = laps.filter((l) => [l.driverId, l.carId, l.trackId].join('|') === m0.id && del.has(l.id));
  const best1 = [...src].filter((l) => l.flag !== 'yellow').sort((a, b) => a.time - b.time)[0];
  const f2 = foldInto(null, src.map((l) => (l.id === best1.id ? { ...l, voided: 1 } : l)));
  ok(f2.laps === m0.laps && !memoLaps(f2).some((l) => l.id === best1.id), 'tour annulé puis versé : compté, mais pas dans les records');
  // statLaps : les tours annulés sortent des records, pas des compteurs
  const fake = { all: async (n) => (n === 'laps' ? [{ ...left[0], voided: 1 }, left[1]] : []), byIndex: async () => [] };
  const sl = await statLaps(fake);
  ok(sl.all.length === 1 && sl.laps.length === 2, 'statLaps : tour annulé hors records, gardé pour les compteurs');
}

console.log(fails ? `\n${fails} échec(s)` : '\nTout est bon.');
process.exit(fails ? 1 : 0);
