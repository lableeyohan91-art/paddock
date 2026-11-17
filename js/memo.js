// Fiche mémo : le « minimum vital » des statistiques, pour ne garder en détail
// que les 3 dernières séances.
//
// Une fiche par pilote + voiture + circuit (id "pilote|voiture|circuit") :
//   - compteurs : tours roulés, temps de roulage, séances, et par jour (tours, séances) ;
//   - quelques tours « témoins » gardés tels quels (keep) : les 10 meilleurs, le meilleur
//     de chaque jour, les records de secteurs, les 30 derniers tours (course / tous types).
//     Ils suffisent pour : records, tour idéal, graphique de progression, médiane et
//     meilleurs tours du calcul d'essence.
//   - folded : séances déjà versées dans la fiche (jamais comptées deux fois).
//
// Les tours des séances plus anciennes que les 3 dernières sont versés dans leur fiche,
// puis effacés. Les records SmartRace importés et les tours sans séance ne sont jamais effacés.

export const KEEP_SESSIONS = 3;
const TOP = 10;
const RECENT = 30;

export const dayKey = (ts) => new Date(ts).toLocaleDateString('fr-FR');
const green = (l) => !l.flag || l.flag === 'green';
const memoId = (l) => `${l.driverId}|${l.carId}|${l.trackId}`;

/** Tour réduit à ce qui sert aux statistiques. */
function slim(l) {
  return {
    id: l.id, driverId: l.driverId, carId: l.carId, trackId: l.trackId,
    sessionId: l.sessionId, sessionType: l.sessionType, time: l.time,
    sectors: l.sectors?.length ? l.sectors : [], date: l.date, flag: l.flag,
    wetness: l.wetness ?? 0, speed: l.speed ?? null, kept: true,
  };
}

/** Tours témoins à garder parmi une liste (ancienne fiche + tours versés). */
export function pickKeep(list) {
  const keep = new Map();
  const add = (l) => { if (l) keep.set(l.id, l); };
  const clean = list.filter((l) => l.flag !== 'yellow');
  // 10 meilleurs tours
  [...clean].sort((a, b) => a.time - b.time).slice(0, TOP).forEach(add);
  // meilleur tour de chaque jour (graphique de progression)
  const byDay = new Map();
  for (const l of clean) { const k = dayKey(l.date); const c = byDay.get(k); if (!c || l.time < c.time) byDay.set(k, l); }
  byDay.forEach(add);
  // records de secteurs (pour chaque nombre de secteurs, chaque secteur)
  const bySec = new Map();
  for (const l of clean) {
    const n = l.sectors?.length || 0;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const k = n + ':' + i;
      const c = bySec.get(k);
      if (!c || l.sectors[i] < c.sectors[i]) bySec.set(k, l);
    }
  }
  bySec.forEach(add);
  // 30 derniers tours de course sous drapeau vert (calcul d'essence) et 30 derniers tous types (régularité)
  const recent = [...list].filter(green).sort((a, b) => b.date - a.date);
  recent.filter((l) => l.sessionType === 'race').slice(0, RECENT).forEach(add);
  recent.slice(0, RECENT).forEach(add);
  return [...keep.values()].sort((a, b) => a.date - b.date);
}

/** Verse des tours (d'une ou plusieurs séances) dans une fiche. Renvoie la fiche mise à jour. */
export function foldInto(memo, laps) {
  const m = memo ? structuredClone(memo) : null;
  const first = laps[0];
  const out = m || {
    id: memoId(first), driverId: first.driverId, carId: first.carId, trackId: first.trackId,
    laps: 0, drivingMs: 0, sessions: 0, days: {}, keep: [], folded: [],
  };
  const done = new Set(out.folded);
  const fresh = laps.filter((l) => !done.has(l.sessionId));
  if (!fresh.length) return out;
  const sessions = new Set(fresh.map((l) => l.sessionId));
  out.laps += fresh.length;
  out.drivingMs += fresh.reduce((s, l) => s + (l.time || 0), 0);
  out.sessions += sessions.size;
  const perDay = new Map();
  for (const l of fresh) {
    const k = dayKey(l.date);
    if (!perDay.has(k)) perDay.set(k, { laps: 0, sessions: new Set() });
    const d = perDay.get(k);
    d.laps++; d.sessions.add(l.sessionId);
  }
  perDay.forEach((d, k) => {
    const cur = out.days[k] || { laps: 0, sessions: 0 };
    out.days[k] = { laps: cur.laps + d.laps, sessions: cur.sessions + d.sessions.size };
  });
  out.keep = pickKeep([...out.keep, ...fresh.map(slim)]);
  out.folded = [...done, ...sessions];
  return out;
}

/**
 * Plan de rotation (fonction pure) : quelles séances garder en détail, quels tours verser
 * et effacer. sessions = toutes les séances enregistrées ; laps = tous les tours.
 */
export function planRotation(sessions, laps, memos) {
  const recent = new Set([...sessions].sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, KEEP_SESSIONS).map((s) => s.id));
  const foldedBy = new Map(memos.map((m) => [m.id, new Set(m.folded || [])]));
  const toFold = new Map(); // memoId -> tours à verser
  const toDelete = [];
  for (const l of laps) {
    if (l.imported || !l.sessionId || recent.has(l.sessionId)) continue; // records importés, tours sans séance, 3 dernières séances
    if (!l.driverId || !l.trackId) continue;
    toDelete.push(l.id);
    const id = memoId(l);
    if (foldedBy.get(id)?.has(l.sessionId)) continue; // déjà dans la fiche (tour revenu d'un autre appareil)
    if (!toFold.has(id)) toFold.set(id, []);
    toFold.get(id).push(l);
  }
  return { recent, toFold, toDelete };
}

let running = false;

/**
 * Rotation : sauvegarde complète la 1re fois, puis versement des anciennes séances
 * dans les fiches et effacement de leurs tours. Jamais pendant une séance.
 */
export async function rotate(app) {
  if (running || app.isRacing) return null;
  running = true;
  try {
    const db = app.db;
    const [sessions, laps, memos] = await Promise.all([db.all('sessions'), db.all('laps'), db.all('memos')]);
    const plan = planRotation(sessions, laps, memos);
    if (!plan.toDelete.length) return { folded: 0, deleted: 0 };
    // filet de sécurité : une copie complète avant le tout premier effacement
    if (!(await db.getSetting('backupBeforeMemo', null))) {
      await db.setSetting('backupBeforeMemo', { date: Date.now(), data: await db.exportAll() });
    }
    const byId = new Map(memos.map((m) => [m.id, m]));
    const updated = [];
    plan.toFold.forEach((ls, id) => updated.push(foldInto(byId.get(id), ls)));
    if (updated.length) await db.putMany('memos', updated); // la fiche d'abord, l'effacement ensuite
    await db.removeMany('laps', plan.toDelete);
    app.log?.(`Statistiques : ${plan.toDelete.length} tours anciens versés dans ${updated.length} fiche(s) mémo`);
    return { folded: updated.length, deleted: plan.toDelete.length };
  } finally {
    running = false;
  }
}

/**
 * Tours pour les statistiques : tours détaillés (3 dernières séances, records importés)
 * + tours témoins des fiches. Les compteurs, eux, viennent de counts().
 */
export async function statLaps(db, { driverId = null, trackId = null } = {}) {
  let laps = driverId ? await db.byIndex('laps', 'driverId', driverId)
    : trackId ? await db.byIndex('laps', 'trackId', trackId) : await db.all('laps');
  let memos = await db.all('memos');
  if (driverId) { laps = laps.filter((l) => l.driverId === driverId); memos = memos.filter((m) => m.driverId === driverId); }
  if (trackId) { laps = laps.filter((l) => l.trackId === trackId); memos = memos.filter((m) => m.trackId === trackId); }
  return { laps, memos, all: [...laps, ...memos.flatMap((m) => m.keep || [])] };
}

/** Compteurs : tours détaillés non importés + compteurs des fiches. */
export function counts(laps, memos, pick = () => true) {
  const ls = laps.filter((l) => !l.imported && pick(l));
  const ms = memos.filter((m) => pick(m));
  return {
    laps: ls.length + ms.reduce((s, m) => s + (m.laps || 0), 0),
    drivingMs: ls.reduce((s, l) => s + (l.time || 0), 0) + ms.reduce((s, m) => s + (m.drivingMs || 0), 0),
    sessions: new Set(ls.map((l) => l.sessionId)).size + ms.reduce((s, m) => s + (m.sessions || 0), 0),
  };
}
