// Vue pilote en direct : le téléphone branché au circuit publie l'état de la
// séance dans Firestore (live/{code}), et chaque pilote le suit sur son propre
// téléphone en scannant un QR code (pilote.html?c=CODE, sans installer l'appli).
// Les pilotes peuvent aussi envoyer des commandes (VSC, drapeau rouge, réglage de
// LEUR voiture) dans live/{code}/cmds : c'est ce téléphone-ci qui les applique.

import * as sync from './sync.js';
import { toast } from './ui.js';
import { tyreState } from './tyres.js';

const PUBLIC_URL = 'https://lableeyohan91-art.github.io/paddock/';
const CODE_KEY = 'paddock.liveCode';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans 0/O, 1/I

export const live = { code: null, status: 'off', error: null };

let app = null;
let api = null;       // { fb, fs, uid }
let timer = null;
let unsubCmds = null;
let lastJson = '';
let startWall = null; // heure (Date.now) du départ de la séance en cours
let wallFor = null;
let wallPaused = 0; // temps de drapeau rouge déjà pris en compte dans startWall

/** Adresse de la vue pilote (toujours le site en ligne : les téléphones n'ont pas accès au PC). */
export function pilotUrl(code = live.code) {
  const here = location.hostname.endsWith('github.io') ? location.origin + location.pathname.replace(/[^/]*$/, '') : PUBLIC_URL;
  return `${here}pilote.html?c=${code}`;
}

function newCode() {
  let c = '';
  const r = crypto.getRandomValues(new Uint8Array(6));
  for (const x of r) c += ALPHABET[x % ALPHABET.length];
  return c;
}

/** Démarre la diffusion (une fois) : même code toute la soirée, les pilotes ne rescannent pas. */
export async function startLive(theApp) {
  app = theApp;
  if (live.status === 'on' || live.status === 'starting') return live.code;
  live.status = 'starting';
  live.error = null;
  try {
    api = await sync.liveAccess();
    let code = null;
    try { code = localStorage.getItem(CODE_KEY); } catch { /* stockage indisponible */ }
    if (!code) {
      code = newCode();
      try { localStorage.setItem(CODE_KEY, code); } catch { /* ignore */ }
    }
    live.code = code;
    lastJson = '';
    try {
      await publish(true);
    } catch (e) {
      // code créé par un autre compte (ex. connexion Google depuis) : on en prend un neuf
      if (!/permission/i.test(e?.code || e?.message || '')) throw e;
      live.code = newCode();
      try { localStorage.setItem(CODE_KEY, live.code); } catch { /* ignore */ }
      await publish(true);
    }
    listenCommands();
    clearInterval(timer);
    timer = setInterval(() => publish().catch(onPublishError), 1000);
    live.status = 'on';
  } catch (e) {
    live.status = 'error';
    live.error = friendly(e);
  }
  return live.code;
}

function friendly(e) {
  const c = e?.code || e?.message || String(e);
  if (/admin-restricted-operation|operation-not-allowed/.test(c)) return 'Connexion anonyme non activée dans Firebase (Authentication → Sign-in method → Anonyme).';
  if (/permission-denied|insufficient permissions/i.test(c)) return 'Règles Firestore à mettre à jour (collection « live »).';
  if (/network|unavailable|offline/i.test(c)) return 'Pas de connexion internet.';
  return e?.message || String(e);
}

const ref = (...path) => api.fb.doc(api.fs, 'live', live.code, ...path);

/** Instantané de la séance pour les téléphones des pilotes. */
function snapshot() {
  const s = app.session;
  if (!s) return { state: 'none' };
  if (wallFor !== s) { wallFor = s; startWall = null; }
  // après un drapeau rouge, le départ « virtuel » est décalé du temps d'arrêt
  if (s.startedAt && (startWall === null || wallPaused !== s.pausedMs)) { startWall = Date.now() - s.elapsedMs; wallPaused = s.pausedMs; }
  const list = s.order.length ? s.order : [...s.comps.values()];
  return {
    title: s.cfg.title || s.cfg.type,
    type: s.cfg.type,
    mode: s.cfg.mode,
    laps: s.cfg.laps,
    durationMs: s.durationMs || 0,
    state: s.state,
    flag: s.flag,
    vscCountdown: s.vscCountdown || null,
    redResuming: !!s.redResuming,
    relaunch: app.canRelaunch?.() || false, // bouton « Nouvelle relance » (faux départ)
    startWall,
    // chrono figé : fin de séance ou drapeau rouge (les téléphones affichent le même temps que l'écran)
    endWall: (s.endedAt || s.redSince !== null) && startWall !== null ? startWall + s.elapsedMs : null,
    leaderLaps: s.leaderLaps,
    fuel: app.fuelOn(),
    tyres: app.tyresOn(),
    overallBest: s.overallBest ? { time: s.overallBest.time, address: s.overallBest.address } : null,
    comps: list.map((c) => {
      const t = app.getTune(c.driver?.id, c.car?.id);
      // séance en cours : vitesse et freinage RÉELS envoyés au circuit (poids de l'essence, VSC, panne sèche…)
      const real = ['armed', 'running', 'finishing'].includes(s.state) ? app.perf?.current.get(c.address) : null;
      return {
        a: c.address,
        name: c.driver?.name || `Manette ${c.address + 1}`,
        color: c.driver?.color || '#888',
        car: c.car?.name || '',
        pos: c.position,
        laps: c.laps,
        last: c.lastLap,
        best: c.bestLap,
        gap: c.gap,
        recent: c.lapTimes.slice(-5),
        fuelPct: c.fuelPct === null ? null : Math.round(c.fuelPct),
        inPit: c.inPit,
        pitStops: c.pitStops,
        finished: c.finished,
        tyre: c.tyre ? { c: c.tyre.compound, w: Math.round(c.tyre.wear), n: c.tyre.next, st: tyreState(app.tyres, c.tyre) } : null,
        speed: real ? real.speed : t.speed,
        brake: real ? real.brake : t.brake,
      };
    }),
  };
}

/** Écriture refusée (compte changé entre-temps…) : on redémarre la diffusion. */
function onPublishError(e) {
  console.warn('[live] publication impossible', e?.code || e);
  lastJson = '';
  if (/permission/i.test(e?.code || e?.message || '') && live.status === 'on') {
    clearInterval(timer);
    if (unsubCmds) { unsubCmds(); unsubCmds = null; }
    live.status = 'off';
    startLive(app);
  }
}

let lastWrite = 0;
async function publish(force = false) {
  if (!api || !live.code || !app) return;
  const json = JSON.stringify(snapshot());
  // rien de neuf : pas d'écriture, sauf un signal toutes les 5 s (les vues pilote savent
  // ainsi qu'elles sont à jour, et en rattrapent une manquée)
  if (!force && json === lastJson && Date.now() - lastWrite < 5000) return;
  lastJson = json;
  lastWrite = Date.now();
  await api.fb.setDoc(ref(), { owner: api.uid, json, updatedAt: Date.now() });
}

/** Commandes envoyées par les pilotes : appliquées ici, puis effacées. */
function listenCommands() {
  if (unsubCmds) unsubCmds();
  const col = api.fb.collection(api.fs, 'live', live.code, 'cmds');
  unsubCmds = api.fb.onSnapshot(col, (snap) => {
    snap.docChanges().forEach((ch) => {
      if (ch.type !== 'added') return;
      const cmd = ch.doc.data();
      api.fb.deleteDoc(ch.doc.ref).catch(() => {});
      if (Date.now() - (cmd.at || 0) > 30000) return; // commande trop ancienne
      handle(cmd);
    });
  }, (e) => { live.error = friendly(e); });
}

function handle(cmd) {
  const s = app.session;
  if (!s) return;
  const who = cmd.by ? ` (${cmd.by})` : '';
  if (cmd.type === 'vsc') {
    if (s.vscCountdown) return;
    // intention du pilote : « on » = VSC, « off » = fin du VSC (anciennes vues pilote : bascule)
    const want = cmd.want || (s.flag === 'vsc' ? 'off' : 'on');
    if (want === 'on' && s.flag === 'vsc') return;  // déjà en VSC : on le garde
    if (want === 'off' && s.flag !== 'vsc') return; // pas de VSC à terminer
    // fin demandée juste après le déclenchement : le pilote voyait encore l'ancien état
    if (want === 'off' && performance.now() - (s.vscSince || 0) < 2000) return;
    app.toggleVsc();
    toast(s.flag === 'vsc' ? `🟨 VSC déclenché${who}` : `Fin du VSC demandée${who}`);
  } else if (cmd.type === 'red') {
    if (s.flag === 'red' && s.redResuming) return;
    // intention du pilote : « on » = drapeau rouge, « off » = reprise (anciennes vues pilote : bascule)
    const want = cmd.want || (s.flag === 'red' ? 'off' : 'on');
    if (want === 'on' && s.flag === 'red') return;  // course déjà arrêtée : elle le reste
    if (want === 'off' && s.flag !== 'red') return; // pas de drapeau rouge : rien à reprendre
    app.toggleRed();
    toast(s.flag === 'red' ? `🚩 Drapeau rouge${who}` : `Reprise demandée${who}`);
  } else if (cmd.type === 'relaunch') {
    // faux départ : relance demandée depuis une vue pilote
    if (!app.canRelaunch()) return;
    app.relaunchLights();
    toast(`🟢 Nouvelle relance${who}`);
  } else if (cmd.type === 'tyre') {
    // gomme choisie par le pilote (pneus de départ avant le GO, sinon pour le prochain arrêt)
    app.setTyreNext(cmd.a, cmd.compound);
  } else if (cmd.type === 'tune') {
    // un pilote ne règle que SA voiture : celle de la manette indiquée
    const c = s.comps.get(cmd.a);
    const k = cmd.k;
    const v = Math.round(+cmd.v);
    if (!c?.driver?.id || !c?.car?.id || !['speed', 'brake'].includes(k) || !(v >= 0 && v <= 15)) return;
    app.saveTune(c.driver.id, c.car.id, { [k]: v }); // appliqué tout de suite à sa manette
    toast(`🔧 ${c.driver.name} : ${k === 'speed' ? 'accélération' : 'freinage'} ${Math.round((v / 15) * 100)} %`, 1500);
  }
  app.refresh?.();
  publish().catch(() => {});
}

/** Dessine le QR code de la vue pilote dans un élément (bibliothèque chargée à la demande). */
export async function drawQr(el, text) {
  if (!window.qrcode) {
    await new Promise((resolve, reject) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
      sc.onload = resolve;
      sc.onerror = () => reject(new Error('QR code indisponible (pas de connexion ?)'));
      document.head.appendChild(sc);
    });
  }
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  el.innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
}

/** Traite une commande de pilote comme si elle venait de Firestore (essais au simulateur). */
export function handleCommand(theApp, cmd) {
  if (!app) app = theApp;
  handle({ at: Date.now(), ...cmd });
}
