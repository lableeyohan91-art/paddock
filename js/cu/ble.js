// Connexion Bluetooth (Web Bluetooth) au Carrera AppConnect (30369).
// UUIDs repris de carreralib. En BLE, les commandes partent sans cadrage
// et les réponses arrivent par notification, terminées par '$'.
//
// Selon la version de l'AppConnect / de la Control Unit et le téléphone, l'échange
// ne se passe pas toujours pareil ; la connexion s'adapte toute seule (alignée sur OpenLap) :
//  - écriture : « sans réponse » d'abord (comme OpenLap), sans attendre la fin de l'envoi :
//    c'est l'arrivée de la réponse qui compte. Si l'AppConnect décroche dans ce mode, on
//    revient à l'écriture avec accusé de réception (la façon de la v1.27) ;
//  - réponse : par notification ; une réponse coupée en plusieurs morceaux est recollée
//    jusqu'au '$' ; si aucune notification n'arrive jamais, on lit la réponse directement.

export const SERVICE_UUID = '39df7777-b1b4-b90b-57f1-7144ae4e4a6a';
export const OUTPUT_UUID = '39df8888-b1b4-b90b-57f1-7144ae4e4a6a';
export const NOTIFY_UUID = '39df9999-b1b4-b90b-57f1-7144ae4e4a6a';

const enc = new TextEncoder();
const dec = new TextDecoder('latin1');
const WRITE_TIMEOUT = 800;  // ms : au-delà, l'écriture est considérée comme bloquée
const PIECE_WAIT = 40;      // ms : attente d'un morceau suivant quand la réponse n'a pas de '$'

export function bluetoothSupported() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

export class BleConnection {
  constructor() {
    this.kind = 'ble';
    this.device = null;
    this.out = null;
    this.notify = null;
    this._pending = null;
    this._buf = '';
    this.ondisconnect = null;
    this.onlog = null;
    this.writeMode = null;     // 'response' | 'noresponse'
    this.readMode = false;     // true : réponse lue directement (pas de notification)
    this.notifications = 0;
    this._timeouts = 0;
    this._writeFails = 0;
    this._resetting = false;
    this._onNotify = this._onNotify.bind(this);
  }

  get name() {
    return this.device?.name || 'AppConnect';
  }

  /** Mode d'échange lisible (fenêtre de connexion). */
  get modeLabel() {
    const w = this.writeMode === 'response' ? 'écriture avec accusé' : 'écriture sans réponse';
    return `${w} · ${this.readMode ? 'lecture directe' : 'notifications'} (${this.notifications} reçues)`;
  }

  log(m) { this.onlog?.(m); }

  async open() {
    if (!bluetoothSupported()) {
      throw new Error("Ce navigateur ne gère pas le Bluetooth. Utilise Chrome ou Edge (PC ou Android).");
    }
    // L'AppConnect n'annonce pas toujours son service : on cherche aussi par nom.
    // showAll = liste tous les appareils Bluetooth (secours si rien n'est trouvé).
    this.device = await navigator.bluetooth.requestDevice(this.showAll
      ? { acceptAllDevices: true, optionalServices: [SERVICE_UUID] }
      : {
        filters: [
          { services: [SERVICE_UUID] },
          { name: 'Control_Unit' },
          { namePrefix: 'Control' },
          { namePrefix: 'Carrera' },
          { namePrefix: 'CU' },
          { namePrefix: 'AppConnect' },
        ],
        optionalServices: [SERVICE_UUID],
      });
    this.device.addEventListener('gattserverdisconnected', () => {
      if (this._resetting) return; // coupure volontaire (remise à zéro de la liaison)
      if (this.writeMode === 'noresponse' && this.out?.properties.write) {
        // secours : l'AppConnect a décroché en écriture sans réponse → façon de la v1.27
        this.writeMode = 'response';
        this.log('AppConnect décroché : retour à l\'écriture avec accusé (comme la v1.27)');
      }
      this._reject(new Error('Déconnecté'));
      this.ondisconnect?.();
    });
    await this._connectGatt();
  }

  async _connectGatt() {
    let server;
    // certains téléphones ratent la première connexion : on réessaie
    for (let i = 0; ; i++) {
      try {
        server = await withTimeout(this.device.gatt.connect(), 10000, 'Connexion Bluetooth trop longue');
        break;
      } catch (e) {
        if (i >= 2) throw e;
        this.log(`Connexion Bluetooth ratée (${e.message}), nouvel essai…`);
        await sleep(600);
      }
    }
    let service;
    try {
      service = await server.getPrimaryService(SERVICE_UUID);
    } catch {
      this.device.gatt.disconnect();
      throw new Error(`« ${this.device.name || 'Cet appareil'} » n'est pas un Carrera AppConnect`);
    }
    this.out = await service.getCharacteristic(OUTPUT_UUID);
    this.notify = await service.getCharacteristic(NOTIFY_UUID);
    const p = this.out.properties;
    if (!this.writeMode) this.writeMode = p.writeWithoutResponse ? 'noresponse' : 'response';
    try {
      await this.notify.startNotifications();
      this.notify.removeEventListener('characteristicvaluechanged', this._onNotify);
      this.notify.addEventListener('characteristicvaluechanged', this._onNotify);
    } catch (e) {
      // notifications refusées : on lira les réponses directement
      this.log(`Notifications indisponibles (${e.message}) : lecture directe des réponses`);
      this.readMode = true;
    }
  }

  /** Reconnexion sans redemander l'appareil (après une coupure). */
  async reconnect() {
    if (!this.device) throw new Error('Aucun appareil');
    await this._connectGatt();
  }

  /** Reconnexion complète (circuit muet depuis plusieurs secondes, comme OpenLap). */
  async restart() {
    this._reject(new Error('Reconnexion'));
    await this._resetGatt();
  }

  /** Coupe et rétablit la liaison (une écriture restée bloquée bloque toutes les suivantes). */
  async _resetGatt() {
    this._resetting = true;
    try {
      try { this.device.gatt.disconnect(); } catch { /* ignore */ }
      await sleep(300);
      await this._connectGatt();
    } finally {
      this._resetting = false;
    }
  }

  _onNotify(ev) {
    this.notifications++;
    this._buf += dec.decode(ev.target.value);
    const p = this._pending;
    if (!p) { this._buf = ''; return; }
    clearTimeout(p.pieceTimer);
    if (/[$#]$/.test(this._buf)) this._finish();
    else p.pieceTimer = setTimeout(() => this._finish(), PIECE_WAIT); // réponse en plusieurs morceaux, ou sans '$'
  }

  _finish() {
    const p = this._pending;
    if (!p) return;
    this._pending = null;
    clearTimeout(p.timer);
    clearTimeout(p.pieceTimer);
    const text = this._buf;
    this._buf = '';
    this._timeouts = 0;
    p.resolve(text);
  }

  _reject(err) {
    const p = this._pending;
    if (p) {
      this._pending = null;
      clearTimeout(p.timer);
      clearTimeout(p.pieceTimer);
      this._buf = '';
      p.reject(err);
    }
  }

  async _write(data) {
    const o = this.out;
    if (this.writeMode === 'response' && o.writeValueWithResponse) return o.writeValueWithResponse(data);
    if (this.writeMode === 'noresponse' && o.writeValueWithoutResponse) return o.writeValueWithoutResponse(data);
    return o.writeValue(data);
  }

  /** Passe à l'autre façon d'écrire, si l'AppConnect la propose. */
  _switchWrite(why) {
    const p = this.out.properties;
    const other = this.writeMode === 'response' ? 'noresponse' : 'response';
    if ((other === 'response' && !p.write) || (other === 'noresponse' && !p.writeWithoutResponse)) return false;
    this.writeMode = other;
    this.log(`${why} : passage en ${other === 'response' ? 'écriture avec accusé' : 'écriture sans réponse'}`);
    return true;
  }

  /** Envoie une commande et attend la réponse (notification, ou lecture directe). */
  async request(cmd, timeoutMs = 1000) {
    if (this._pending) throw new Error('Requête déjà en cours');
    this._buf = '';
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending = null;
        this._buf = '';
        this._noAnswer();
        reject(new Error('Délai dépassé'));
      }, timeoutMs);
      this._pending = { resolve, reject, timer };
    });
    result.catch(() => {}); // évite une alerte « promesse rejetée » si l'écriture échoue avant
    const data = enc.encode(cmd);
    const mine = this._pending;
    try {
      if (!this.device?.gatt?.connected) throw new Error('Bluetooth non connecté');
      const sent = withTimeout(this._write(data), WRITE_TIMEOUT, 'Écriture bloquée');
      if (this.readMode) {
        // pas de notification : on attend la fin de l'envoi puis on lit la réponse
        await sent;
        this._writeFails = 0;
        if (this._pending === mine) {
          await sleep(15);
          const v = await this.notify.readValue();
          this._buf = dec.decode(v);
          this._finish();
        }
      } else {
        // comme OpenLap : on n'attend pas la fin de l'envoi, c'est la réponse qui compte
        sent.then(() => { this._writeFails = 0; }, (e) => {
          if (this._pending === mine) this._reject(e);
          this._writeProblem(e);
        });
      }
    } catch (e) {
      if (this._pending === mine) this._reject(e);
      await this._writeProblem(e);
    }
    return result;
  }

  /** Écriture ratée ou bloquée : on change de façon d'écrire, et on rétablit la liaison si besoin. */
  async _writeProblem(e) {
    if (/non connecté|Déconnecté|Reconnexion/.test(e.message) || !this.device?.gatt?.connected) return; // Bluetooth coupé : rien à voir avec la façon d'écrire
    this._writeFails++;
    if (this._writeFails < 2 && !/bloquée/.test(e.message)) return;
    this._writeFails = 0;
    this._switchWrite(`Écriture impossible (${e.message})`);
    if (/bloquée|in progress|GATT/i.test(e.message) && this.device?.gatt) {
      try { await this._resetGatt(); } catch (err) { this.log('Liaison Bluetooth non rétablie : ' + err.message); }
    }
  }

  /** Aucune réponse : après plusieurs silences, on essaie une autre façon d'échanger. */
  _noAnswer() {
    this._timeouts++;
    if (this._timeouts < 3) return;
    this._timeouts = 0;
    if (!this.notifications && !this.readMode && this.notify?.properties.read) {
      this.readMode = true;
      this.log('Aucune notification reçue : lecture directe des réponses');
    } else if (!this.notifications) {
      this.readMode = false;
      this._switchWrite('Aucune réponse de la Control Unit');
    }
  }

  async close() {
    try {
      this.notify?.removeEventListener('characteristicvaluechanged', this._onNotify);
      if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    } catch { /* ignore */ }
  }
}
