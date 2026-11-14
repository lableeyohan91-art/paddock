// Compte et synchronisation : connexion Google (Firebase Auth) + copie en ligne
// des données (Firestore), pour retrouver pilotes, records, setups… sur le PC
// comme sur le téléphone.
//
// Principe : l'appli reste "locale d'abord" (IndexedDB). Chaque écriture locale
// est recopiée en ligne dans users/{uid}/{store}/{id}. À la connexion, on fusionne
// (la donnée la plus récente gagne ; une donnée par défaut ne gagne jamais contre
// une vraie). Ensuite, les changements faits sur un autre appareil arrivent en direct.
// Les documents sont stockés en JSON (champ "json") pour éviter les limites de Firestore.

import { FIREBASE_CONFIG } from './firebase-config.js';
import * as db from './db.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const SYNCED = ['drivers', 'cars', 'tracks', 'sessions', 'laps', 'settings', 'tunes'];

let fb = null;        // modules Firebase
let auth = null;
let fs = null;        // Firestore
let user = null;
let app = null;
let unsubs = [];
let applying = false; // écritures venues d'en ligne : pas d'écho
let reloadTimer = null;

export const state = { enabled: false, user: null, status: 'off', pending: 0, error: null, lastSync: null };
const listeners = new Set();
export const onState = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = () => listeners.forEach((fn) => { try { fn(state); } catch { /* ignore */ } });
const set = (patch) => { Object.assign(state, patch); emit(); };

export const configured = () => !!FIREBASE_CONFIG?.apiKey;

async function load() {
  if (fb) return fb;
  const [appMod, authMod, fsMod] = await Promise.all([
    import(SDK + 'firebase-app.js'),
    import(SDK + 'firebase-auth.js'),
    import(SDK + 'firebase-firestore.js'),
  ]);
  fb = { ...appMod, ...authMod, ...fsMod };
  return fb;
}

/** Démarre la synchronisation (appelé au lancement de l'appli). */
export async function initSync(theApp) {
  app = theApp;
  if (!configured()) { set({ status: 'unconfigured' }); return; }
  try {
    await load();
    const fbApp = fb.initializeApp(FIREBASE_CONFIG);
    auth = fb.getAuth(fbApp);
    fs = fb.getFirestore(fbApp);
    await fb.setPersistence(auth, fb.browserLocalPersistence);
    set({ enabled: true, status: 'signed-out' });
    db.setSyncHook(onLocalChange);
    // retour d'une connexion par redirection (téléphone)
    fb.getRedirectResult(auth).catch((e) => set({ error: friendly(e) }));
    fb.onAuthStateChanged(auth, (u) => {
      user = u;
      // connexion anonyme (vue pilote en direct) : pas de synchronisation des données
      if (u && !u.isAnonymous) startSync(); else stopSync();
    });
  } catch (e) {
    set({ status: 'error', error: 'Service de compte injoignable (' + (e.message || e) + ')' });
  }
}

function friendly(e) {
  const c = e?.code || '';
  if (c.includes('popup-closed')) return 'Connexion annulée';
  if (c.includes('unauthorized-domain')) return 'Cette adresse n\'est pas autorisée dans Firebase (domaines autorisés).';
  if (c.includes('network')) return 'Pas de connexion internet';
  return e?.message || String(e);
}

export async function signIn() {
  if (!auth) throw new Error('Compte non disponible');
  const provider = new fb.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    await fb.signInWithPopup(auth, provider);
  } catch (e) {
    // fenêtre bloquée (fréquent dans une appli installée) : on passe par une redirection
    if (/popup-blocked|operation-not-supported|cancelled-popup/.test(e.code || '')) {
      await fb.signInWithRedirect(auth, provider);
    } else {
      set({ error: friendly(e) });
      throw e;
    }
  }
}

export async function signOut() {
  if (auth) await fb.signOut(auth);
}

// ---------- Synchronisation ----------

const col = (store) => fb.collection(fs, 'users', user.uid, store);
const docRef = (store, id) => fb.doc(fs, 'users', user.uid, store, String(id));
const pack = (obj) => ({ json: JSON.stringify(obj), _upd: obj._upd || 0, _seed: !!obj._seed, _deleted: false });

function onLocalChange(store, op, obj) {
  if (!user || applying || !SYNCED.includes(store)) return;
  if (store === 'settings' && db.LOCAL_SETTINGS.has(obj.key)) return;
  const id = db.keyOf(store, obj);
  if (id === undefined || id === null) return;
  const data = op === 'delete'
    ? { json: null, _upd: Date.now(), _seed: false, _deleted: true }
    : pack(obj);
  set({ pending: state.pending + 1 });
  fb.setDoc(docRef(store, id), data)
    .then(() => set({ pending: Math.max(0, state.pending - 1), lastSync: Date.now(), error: null }))
    .catch((e) => set({ pending: Math.max(0, state.pending - 1), error: friendly(e) }));
}

/** Les anciens tours avaient des numéros (1, 2, 3…) : on leur donne un identifiant unique. */
async function migrateLapIds() {
  const laps = await db.all('laps');
  const numeric = laps.filter((l) => typeof l.id === 'number');
  for (const l of numeric) {
    await db.applyRemoteDelete('laps', l.id);
    l.id = 'l' + db.uid() + l.id;
    await db.applyRemote('laps', l);
  }
}

async function startSync() {
  set({ user: { name: user.displayName, email: user.email, photo: user.photoURL }, status: 'syncing', error: null });
  try {
    // filet de sécurité : copie complète des données locales avant la 1re synchro de ce compte
    if (!(await db.getSetting('backupBeforeSync:' + user.uid, null))) {
      await db.setSetting('backupBeforeSync:' + user.uid, await db.exportAll(), { quiet: true });
    }
    await migrateLapIds();
    let changedLocal = false;
    const batchSize = 400;
    for (const store of SYNCED) {
      const snap = await fb.getDocs(col(store));
      const remote = new Map();
      snap.forEach((d) => remote.set(d.id, d.data()));
      const local = new Map((await db.all(store)).map((o) => [String(db.keyOf(store, o)), o]));
      const plan = planMerge(store, local, remote);
      for (const o of plan.toLocal) { await db.applyRemote(store, o); changedLocal = true; }
      for (const id of plan.deleteLocal) { await db.applyRemoteDelete(store, id); changedLocal = true; }
      let batch = fb.writeBatch(fs);
      let n = 0;
      const flush = async () => { if (n) { await batch.commit(); batch = fb.writeBatch(fs); n = 0; } };
      for (const o of plan.toRemote) {
        batch.set(docRef(store, db.keyOf(store, o)), pack(o)); n++;
        if (n >= batchSize) await flush();
      }
      await flush();
    }
    set({ status: 'synced', lastSync: Date.now() });
    if (changedLocal) await reloadApp();
    listen();
  } catch (e) {
    set({ status: 'error', error: friendly(e) });
  }
}

/**
 * Plan de fusion d'une collection (fonction pure, testée dans tests/sync.test.mjs).
 * local : Map id -> objet local ; remote : Map id -> {json, _upd, _seed, _deleted}
 * Renvoie ce qu'il faut écrire en local, supprimer en local, et envoyer en ligne.
 */
export function planMerge(store, local, remote) {
  const toLocal = [], deleteLocal = [], toRemote = [];
  const skip = (id) => store === 'settings' && db.LOCAL_SETTINGS.has(id);
  for (const [id, r] of remote) {
    if (skip(id)) continue;
    const l = local.get(id);
    const rMeta = { _upd: r._upd || 0, _seed: !!r._seed };
    if (!l) {
      if (!r._deleted) toLocal.push(JSON.parse(r.json));
    } else if (db.wins(l, rMeta)) {
      toRemote.push(l);                       // le local est plus récent (ou vraie donnée vs défaut)
    } else if (r._deleted) {
      deleteLocal.push(db.keyOf(store, l));   // supprimé sur un autre appareil
    } else if (JSON.stringify(l) !== r.json) {
      toLocal.push(JSON.parse(r.json));       // l'autre appareil est plus récent
    }
  }
  for (const [id, l] of local) {
    if (!remote.has(id) && !skip(id)) toRemote.push(l); // inconnu en ligne : on l'envoie
  }
  return { toLocal, deleteLocal, toRemote };
}

/** Changements faits sur un autre appareil, en direct. */
function listen() {
  stopListening();
  for (const store of SYNCED) {
    const un = fb.onSnapshot(col(store), (snap) => {
      if (snap.metadata.hasPendingWrites) return; // nos propres écritures
      let changed = false;
      const tasks = [];
      snap.docChanges().forEach((ch) => {
        const r = ch.doc.data();
        const id = ch.doc.id;
        if (store === 'settings' && db.LOCAL_SETTINGS.has(id)) return;
        tasks.push((async () => {
          const local = await db.get(store, id);
          const rMeta = { _upd: r._upd || 0, _seed: !!r._seed };
          if (local && !db.wins(rMeta, local)) return; // le local est plus récent
          if (r._deleted) { if (local) { await db.applyRemoteDelete(store, id); changed = true; } return; }
          if (local && JSON.stringify(local) === r.json) return;
          await db.applyRemote(store, JSON.parse(r.json));
          changed = true;
        })());
      });
      Promise.all(tasks).then(() => {
        if (changed) { set({ lastSync: Date.now() }); scheduleReload(); }
      });
    }, (e) => set({ error: friendly(e) }));
    unsubs.push(un);
  }
}

function stopListening() {
  unsubs.forEach((u) => u());
  unsubs = [];
}

function stopSync() {
  stopListening();
  set({ user: null, status: auth ? 'signed-out' : state.status });
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reloadApp, 400);
}

/** Recharge l'état de l'appli depuis la base locale (sans recharger la page). */
async function reloadApp() {
  if (!app) return;
  if (app.isRacing) { scheduleLater(); return; } // jamais en pleine course
  await app.reloadFromDb();
}
function scheduleLater() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reloadApp, 5000);
}

/**
 * Accès Firestore pour la vue pilote en direct (js/live.js).
 * Sans compte Google, on se connecte en anonyme (aucune donnée synchronisée).
 */
export async function liveAccess() {
  if (!configured()) throw new Error('Firebase non configuré');
  for (let i = 0; i < 50 && !auth && state.status !== 'error'; i++) await new Promise((r) => setTimeout(r, 200));
  if (!auth) throw new Error(state.error || 'Service en ligne injoignable');
  if (!auth.currentUser) await fb.signInAnonymously(auth);
  return { fb, fs, uid: auth.currentUser.uid };
}
