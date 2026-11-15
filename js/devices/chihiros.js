// Rampe LED Chihiros (WRGB II et famille) en Bluetooth (Web Bluetooth).
// Protocole repris du projet libre chihiros-led-control (TheMicDiet), rétro-conçu
// depuis l'appli « My Chihiros » :
//   trame = [cmd, 0x01, longueur, id_haut, id_bas, mode, paramètres…, somme]
//   somme = XOR des octets 1 à n-2 ; cmd 0x5A ; l'identifiant saute toute valeur 0x5A.
//   Couleur manuelle : mode 0x05 [11,255,255] (passage en manuel), puis mode 0x07
//   [canal, niveau] par canal (rouge 0, vert 1, bleu 2), niveau 0..100.

const UART_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const UART_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const HM10_SERVICE = '0000ffe0-0000-1000-8000-00805f9b34fb';
const HM10_CHAR = '0000ffe1-0000-1000-8000-00805f9b34fb';
const CMD = 0x5a;
const GAP_MS = 30; // pause entre deux trames (comme l'appli d'origine)
const SAVED_ID = 'paddock.lightId';
const SAVED_NAME = 'paddock.lightName';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function checksum(bytes) {
  let c = bytes[1];
  for (let i = 2; i < bytes.length; i++) c ^= bytes[i];
  return c & 0xff;
}

export function frame(mode, msgId, params) {
  const f = [CMD, 0x01, params.length + 5, msgId[0], msgId[1], mode, ...params];
  f.push(checksum(f));
  return Uint8Array.from(f);
}

/** Identifiant de message suivant (aucun octet ne doit valoir 0x5A). */
export function nextMsgId([hi, lo]) {
  do {
    lo++;
    if (lo > 255) { lo = 0; hi++; }
    if (hi > 255) { hi = 0; lo = 1; }
  } while (hi === CMD || lo === CMD);
  return [hi, lo];
}

const clamp100 = (v) => Math.max(0, Math.min(100, Math.round(+v || 0)));

export class ChihirosLight extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.rx = null;
    this.status = 'off'; // off | connecting | on | error
    this.error = null;
    this.name = null;
    this.color = null;   // dernière couleur envoyée {r,g,b}
    this._msg = [0, 0];
    this._chain = Promise.resolve();
    this._pending = null; // couleur en attente (on n'envoie que la plus récente)
  }

  get supported() { return !!navigator.bluetooth; }
  get connected() { return this.status === 'on'; }

  _set(status, error = null) {
    this.status = status;
    this.error = error;
    this.dispatchEvent(new Event('change'));
  }

  /** Choisir et connecter la rampe (doit partir d'un appui de l'utilisateur). */
  async connect({ showAll = false, name = null } = {}) {
    if (!this.supported) throw new Error('Bluetooth non disponible dans ce navigateur (utilise Chrome).');
    this._set('connecting');
    try {
      const opts = showAll
        ? { acceptAllDevices: true, optionalServices: [UART_SERVICE, HM10_SERVICE] }
        : name
          ? { filters: [{ name }], optionalServices: [UART_SERVICE, HM10_SERVICE] } // seulement la rampe habituelle
          : { filters: [{ namePrefix: 'DY' }, { services: [UART_SERVICE] }], optionalServices: [UART_SERVICE, HM10_SERVICE] };
      const device = await navigator.bluetooth.requestDevice(opts);
      this._manualOff = false;
      this._adopt(device);
      await this._open();
      this._remember();
      return this.name;
    } catch (e) {
      const msg = /cancel|chosen/i.test(e?.message || '') ? 'Aucun appareil choisi' : (e?.message || String(e));
      this._set('error', msg);
      throw new Error(msg);
    }
  }

  /** Mémorise la rampe choisie, pour la reconnecter seule au prochain lancement. */
  _remember() {
    try {
      localStorage.setItem(SAVED_ID, this.device.id);
      localStorage.setItem(SAVED_NAME, this.device.name || '');
    } catch { /* stockage indisponible */ }
  }

  /** Nom de la rampe utilisée la dernière fois (ou null). */
  get savedName() {
    try { return localStorage.getItem(SAVED_NAME) || null; } catch { return null; }
  }

  /**
   * Au lancement : reconnecte la rampe déjà autorisée, sans rien demander.
   * Renvoie 'on', 'waiting' (on attend qu'elle soit allumée / à portée),
   * 'none' (aucune rampe enregistrée) ou 'unsupported' (navigateur sans cette fonction).
   */
  async autoConnect() {
    if (!this.supported || !navigator.bluetooth.getDevices) return this.savedName ? 'unsupported' : 'none';
    let id = null;
    try { id = localStorage.getItem(SAVED_ID); } catch { /* ignore */ }
    const devices = await navigator.bluetooth.getDevices();
    const d = devices.find((x) => x.id === id) || devices.find((x) => /^DY/i.test(x.name || ''));
    if (!d) return this.savedName ? 'unsupported' : 'none';
    this._adopt(d);
    try {
      this._set('connecting');
      await this._open();
      this._remember();
      return 'on';
    } catch {
      this._set('off');
      this._waitAdvert();
      return 'waiting';
    }
  }

  /** Attend que la rampe émette (allumée, à portée) pour s'y connecter. */
  _waitAdvert() {
    const d = this.device;
    if (!d?.watchAdvertisements || this._watching) { this._retryLater(); return; }
    this._watching = true;
    const ac = new AbortController();
    d.addEventListener('advertisementreceived', async () => {
      ac.abort();
      this._watching = false;
      try { this._set('connecting'); await this._open(); } catch { this._set('off'); this._retryLater(); }
    }, { once: true });
    d.watchAdvertisements({ signal: ac.signal }).catch(() => { this._watching = false; this._retryLater(); });
  }

  /** Nouvel essai de connexion dans 10 s (rampe coupée, hors de portée…). */
  _retryLater() {
    clearTimeout(this._retry);
    if (this._manualOff || !this.device) return;
    this._retry = setTimeout(async () => {
      if (this.connected || this._manualOff) return;
      try { this._set('connecting'); await this._open(); } catch { this._set('off'); this._retryLater(); }
    }, 10000);
  }

  _adopt(device) {
    if (this.device === device) return;
    this.device = device;
    this.name = device.name || 'Rampe Chihiros';
    device.addEventListener('gattserverdisconnected', () => {
      this.rx = null;
      this._set('off');
      this._retryLater(); // coupure imprévue : on la reconnecte seule
    });
  }

  /** Reconnexion à la rampe déjà choisie (sans redemander). */
  async reconnect() {
    if (!this.device) throw new Error('Aucune rampe choisie');
    this._manualOff = false;
    this._set('connecting');
    try { await this._open(); this._remember(); } catch (e) { this._set('error', e?.message || String(e)); throw e; }
  }

  async _open() {
    const server = await this.device.gatt.connect();
    let rx = null;
    try {
      const svc = await server.getPrimaryService(UART_SERVICE);
      rx = await svc.getCharacteristic(UART_RX);
      try {
        const tx = await svc.getCharacteristic(UART_TX);
        if (tx.properties.notify) await tx.startNotifications();
      } catch { /* notifications facultatives */ }
    } catch {
      const svc = await server.getPrimaryService(HM10_SERVICE); // anciens modèles
      rx = await svc.getCharacteristic(HM10_CHAR);
    }
    this.rx = rx;
    this._msg = [0, 0];
    // prélude (une fois par connexion) : statut, puis heure de la rampe
    const d = new Date();
    await this._send([
      frame(0x04, this._id(), [1]),
      frame(0x09, this._id(), [d.getFullYear() - 2000, d.getMonth() + 1, d.getDay() || 7, d.getHours(), d.getMinutes(), d.getSeconds()]),
    ]);
    this._set('on');
  }

  _id() { this._msg = nextMsgId(this._msg); return this._msg; }

  async _write(bytes) {
    if (!this.rx) throw new Error('Rampe non connectée');
    if (this.rx.properties.write) await this.rx.writeValueWithResponse(bytes);
    else await this.rx.writeValueWithoutResponse(bytes);
  }

  /** Envoie des trames une par une (file d'attente : jamais deux écritures en même temps). */
  _send(frames) {
    const run = async () => {
      for (let i = 0; i < frames.length; i++) {
        if (i) await wait(GAP_MS);
        await this._write(frames[i]);
      }
    };
    this._chain = this._chain.then(run, run);
    return this._chain;
  }

  /**
   * Couleur de la rampe : rouge, vert, bleu de 0 à 100.
   * Si plusieurs demandes arrivent vite (curseurs), seule la dernière est envoyée.
   */
  setColor(r, g, b) {
    const want = { r: clamp100(r), g: clamp100(g), b: clamp100(b) };
    const already = !!this._pending;
    this._pending = want;
    if (already) return this._chain;
    return this._chain.then(async () => {
      const c = this._pending;
      this._pending = null;
      if (!c || !this.rx) return;
      await this._send([
        frame(0x05, this._id(), [11, 255, 255]), // passage en mode manuel
        frame(0x07, this._id(), [0, c.r]),
        frame(0x07, this._id(), [1, c.g]),
        frame(0x07, this._id(), [2, c.b]),
      ]);
      this.color = c;
      this.dispatchEvent(new Event('color'));
    }).catch((e) => { this._set('error', e?.message || String(e)); });
  }

  off() { return this.setColor(0, 0, 0); }

  /** Signal de connexion : la rampe clignote 2 fois (allumée / éteinte). */
  async hello() {
    for (let i = 0; i < 2; i++) {
      await this.setColor(100, 100, 100);
      await wait(450);
      await this.setColor(0, 0, 0);
      await wait(450);
    }
    await this.setColor(100, 100, 100); // on finit allumée
  }

  disconnect() {
    this._manualOff = true; // déconnexion voulue : pas de reconnexion automatique
    clearTimeout(this._retry);
    try { this.device?.gatt?.disconnect(); } catch { /* ignore */ }
    this.rx = null;
    this._set('off');
  }
}
