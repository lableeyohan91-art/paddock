// Stockage local (IndexedDB) : pilotes, voitures, circuits, sessions, tours, réglages.
// Tout reste sur l'appareil. Export/import JSON pour sauvegarder ou transférer.

const DB_NAME = 'paddock';
const DB_VERSION = 4; // v3 : remise à zéro des statistiques ; v4 : fiches mémo (memos)
// tunes = réglages du garage, un par couple pilote + voiture (id "pilote|voiture")
// memos = fiche mémo par pilote + voiture + circuit (js/memo.js) : statistiques des séances anciennes
export const STORES = ['drivers', 'cars', 'tracks', 'sessions', 'laps', 'settings', 'tunes', 'memos'];

let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      // Passage en v3 : on vide une fois les tours et sessions enregistrés jusque-là
      // (ils mélangeaient essais et simulateur). Pilotes, voitures et réglages restent.
      if (ev.oldVersion > 0 && ev.oldVersion < 3) {
        const tx = req.transaction;
        for (const name of ['laps', 'sessions']) {
          if (db.objectStoreNames.contains(name)) tx.objectStore(name).clear();
        }
      }
      for (const name of ['drivers', 'cars', 'tracks', 'sessions', 'tunes', 'memos']) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('laps')) {
        const laps = db.createObjectStore('laps', { keyPath: 'id', autoIncrement: true });
        laps.createIndex('sessionId', 'sessionId');
        laps.createIndex('driverId', 'driverId');
        laps.createIndex('carId', 'carId');
        laps.createIndex('trackId', 'trackId');
      }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---- Synchronisation (compte) ----
// Chaque écriture porte un horodatage _upd et est signalée au module de
// synchronisation, qui la recopie en ligne. Les écritures "quiet" (données de
// départ, migrations automatiques) ne sont pas signalées et gardent _upd = 0 :
// elles ne remplacent jamais des données plus récentes venues d'un autre appareil.
let syncHook = null;
export function setSyncHook(fn) { syncHook = fn; }
/**
 * Horodatage d'une écriture. Une écriture "quiet" (valeur par défaut, migration)
 * est marquée _seed : elle ne gagne jamais contre une vraie donnée d'un autre appareil.
 */
function stamp(obj, quiet, now = Date.now()) {
  if (quiet) { obj._upd = obj._upd || 0; if (!obj._upd) obj._seed = true; }
  else { obj._upd = now; delete obj._seed; }
}
/** a doit-il remplacer b ? (vraie donnée > donnée par défaut, puis la plus récente) */
export function wins(a, b) {
  if (!!a._seed !== !!b._seed) return !a._seed;
  return (a._upd || 0) > (b._upd || 0);
}
const keyOf = (name, obj) => (name === 'settings' ? obj.key : obj.id);
const notify = (name, op, obj) => { try { syncHook?.(name, op, obj); } catch { /* hors ligne */ } };

export async function all(name) {
  return wrap((await store(name)).getAll());
}
export async function get(name, id) {
  return wrap((await store(name)).get(id));
}
export async function put(name, obj, { quiet = false } = {}) {
  if (name !== 'settings' && (obj.id === undefined || obj.id === null)) obj.id = uid();
  stamp(obj, quiet);
  await wrap((await store(name, 'readwrite')).put(obj));
  if (!quiet) notify(name, 'put', obj);
  return obj;
}
export async function remove(name, id) {
  await wrap((await store(name, 'readwrite')).delete(id));
  notify(name, 'delete', { id, key: id });
}

/** Écriture venue d'un autre appareil : pas de nouvel horodatage, pas d'écho. */
export async function applyRemote(name, obj) {
  return wrap((await store(name, 'readwrite')).put(obj));
}
export async function applyRemoteDelete(name, id) {
  return wrap((await store(name, 'readwrite')).delete(id));
}
export { keyOf };
export async function byIndex(name, index, value) {
  return wrap((await store(name)).index(index).getAll(value));
}

/** Efface plusieurs objets d'un coup (une seule transaction), avec synchronisation. */
export async function removeMany(name, ids) {
  if (!ids.length) return;
  const db = await open();
  const tx = db.transaction(name, 'readwrite');
  const os = tx.objectStore(name);
  ids.forEach((id) => os.delete(id));
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  ids.forEach((id) => notify(name, 'delete', { id, key: id }));
}

export async function putMany(name, list, { quiet = false } = {}) {
  const db = await open();
  const tx = db.transaction(name, 'readwrite');
  const os = tx.objectStore(name);
  const now = Date.now();
  list.forEach((o) => {
    if (name !== 'settings' && (o.id === undefined || o.id === null)) o.id = uid();
    stamp(o, quiet, now);
    os.put(o);
  });
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  if (!quiet) list.forEach((o) => notify(name, 'put', o));
}

/** Efface toutes les statistiques (tours, sessions, fiches mémo). Pilotes, voitures, réglages conservés. */
export async function clearStats() {
  const victims = { laps: await all('laps'), sessions: await all('sessions'), memos: await all('memos') };
  const db = await open();
  const tx = db.transaction(['laps', 'sessions', 'memos'], 'readwrite');
  tx.objectStore('laps').clear();
  tx.objectStore('sessions').clear();
  tx.objectStore('memos').clear();
  await new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  for (const [name, list] of Object.entries(victims)) list.forEach((o) => notify(name, 'delete', o));
}

export async function getSetting(key, fallback) {
  const r = await get('settings', key);
  return r ? r.value : fallback;
}
// réglages propres à cet appareil : jamais synchronisés
export const LOCAL_SETTINGS = {
  has: (key) => key === 'lastConnection' || key === 'backupBeforeMemo' || key === 'remoteLapsPurge' || String(key).startsWith('backupBeforeSync:'),
};
export async function setSetting(key, value, { quiet = false } = {}) {
  return put('settings', { key, value }, { quiet: quiet || LOCAL_SETTINGS.has(key) });
}

export async function exportAll() {
  const out = { app: 'paddock', version: DB_VERSION, date: new Date().toISOString() };
  for (const s of STORES) out[s] = await all(s);
  out.settings = out.settings.filter((x) => !String(x.key).startsWith('backupBeforeSync:') && x.key !== 'backupBeforeMemo');
  return out;
}

export async function importAll(data) {
  if (data?.app !== 'paddock') throw new Error("Ce fichier n'est pas une sauvegarde Paddock");
  for (const s of STORES) if (Array.isArray(data[s])) await putMany(s, data[s]);
}

/** Données de départ au premier lancement. */
export async function seed() {
  if ((await all('drivers')).length) return;
  const colors = ['#e10600', '#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#fb8c00'];
  // "quiet" : ces données de départ ne remplacent jamais celles d'un compte
  await putMany('drivers', colors.map((color, i) => ({
    id: 'd' + (i + 1), name: 'Pilote ' + (i + 1), color, created: Date.now(),
  })), { quiet: true });
  await putMany('cars', colors.map((_, i) => ({
    id: 'c' + (i + 1), name: 'Voiture ' + (i + 1), speed: 15, brake: 15, fuelCapacity: 15, created: Date.now(),
  })), { quiet: true });
  await put('tracks', { id: 't1', name: 'Mon circuit', length: 0, created: Date.now() }, { quiet: true });
}
