// Stockage local (IndexedDB) : pilotes, voitures, circuits, sessions, tours, réglages.
// Tout reste sur l'appareil. Export/import JSON pour sauvegarder ou transférer.

const DB_NAME = 'paddock';
const DB_VERSION = 3; // v3 : remise à zéro des statistiques (tours de test / simulateur)
// tunes = réglages du garage, un par couple pilote + voiture (id "pilote|voiture")
export const STORES = ['drivers', 'cars', 'tracks', 'sessions', 'laps', 'settings', 'tunes'];

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
      for (const name of ['drivers', 'cars', 'tracks', 'sessions', 'tunes']) {
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

export async function all(name) {
  return wrap((await store(name)).getAll());
}
export async function get(name, id) {
  return wrap((await store(name)).get(id));
}
export async function put(name, obj) {
  if (name !== 'laps' && name !== 'settings' && !obj.id) obj.id = uid();
  await wrap((await store(name, 'readwrite')).put(obj));
  return obj;
}
export async function remove(name, id) {
  return wrap((await store(name, 'readwrite')).delete(id));
}
export async function byIndex(name, index, value) {
  return wrap((await store(name)).index(index).getAll(value));
}

export async function putMany(name, list) {
  const db = await open();
  const tx = db.transaction(name, 'readwrite');
  const os = tx.objectStore(name);
  list.forEach((o) => os.put(o));
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

/** Efface toutes les statistiques (tours et sessions). Pilotes, voitures, réglages conservés. */
export async function clearStats() {
  const db = await open();
  const tx = db.transaction(['laps', 'sessions'], 'readwrite');
  tx.objectStore('laps').clear();
  tx.objectStore('sessions').clear();
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function getSetting(key, fallback) {
  const r = await get('settings', key);
  return r ? r.value : fallback;
}
export async function setSetting(key, value) {
  return put('settings', { key, value });
}

export async function exportAll() {
  const out = { app: 'paddock', version: DB_VERSION, date: new Date().toISOString() };
  for (const s of STORES) out[s] = await all(s);
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
  await putMany('drivers', colors.map((color, i) => ({
    id: 'd' + (i + 1), name: 'Pilote ' + (i + 1), color, created: Date.now(),
  })));
  await putMany('cars', colors.map((_, i) => ({
    id: 'c' + (i + 1), name: 'Voiture ' + (i + 1), speed: 15, brake: 15, fuelCapacity: 15, created: Date.now(),
  })));
  await put('tracks', { id: 't1', name: 'Mon circuit', length: 0, created: Date.now() });
}
