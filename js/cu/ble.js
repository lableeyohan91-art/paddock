// Connexion Bluetooth (Web Bluetooth) au Carrera AppConnect (30369).
// UUIDs repris de carreralib. En BLE, les commandes partent sans cadrage
// et les réponses arrivent par notification, terminées par '$'.

export const SERVICE_UUID = '39df7777-b1b4-b90b-57f1-7144ae4e4a6a';
export const OUTPUT_UUID = '39df8888-b1b4-b90b-57f1-7144ae4e4a6a';
export const NOTIFY_UUID = '39df9999-b1b4-b90b-57f1-7144ae4e4a6a';

const enc = new TextEncoder();
const dec = new TextDecoder('latin1');

export function bluetoothSupported() {
  return typeof navigator !== 'undefined' && !!navigator.bluetooth;
}

export class BleConnection {
  constructor() {
    this.kind = 'ble';
    this.device = null;
    this.out = null;
    this.notify = null;
    this._pending = null;
    this.ondisconnect = null;
    this._onNotify = this._onNotify.bind(this);
  }

  get name() {
    return this.device?.name || 'AppConnect';
  }

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
        ],
        optionalServices: [SERVICE_UUID],
      });
    this.device.addEventListener('gattserverdisconnected', () => {
      this._reject(new Error('Déconnecté'));
      this.ondisconnect?.();
    });
    await this._connectGatt();
  }

  async _connectGatt() {
    const server = await this.device.gatt.connect();
    let service;
    try {
      service = await server.getPrimaryService(SERVICE_UUID);
    } catch {
      this.device.gatt.disconnect();
      throw new Error(`« ${this.device.name || 'Cet appareil'} » n'est pas un Carrera AppConnect`);
    }
    this.out = await service.getCharacteristic(OUTPUT_UUID);
    this.notify = await service.getCharacteristic(NOTIFY_UUID);
    await this.notify.startNotifications();
    this.notify.addEventListener('characteristicvaluechanged', this._onNotify);
  }

  /** Reconnexion sans redemander l'appareil (après une coupure). */
  async reconnect() {
    if (!this.device) throw new Error('Aucun appareil');
    await this._connectGatt();
  }

  _onNotify(ev) {
    const text = dec.decode(ev.target.value);
    const p = this._pending;
    if (p) {
      this._pending = null;
      clearTimeout(p.timer);
      p.resolve(text);
    }
  }

  _reject(err) {
    const p = this._pending;
    if (p) {
      this._pending = null;
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  /** Envoie une commande et attend la notification de réponse. */
  async request(cmd, timeoutMs = 1000) {
    if (this._pending) throw new Error('Requête déjà en cours');
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending = null;
        reject(new Error('Délai dépassé'));
      }, timeoutMs);
      this._pending = { resolve, reject, timer };
    });
    const data = enc.encode(cmd);
    try {
      if (!this.device?.gatt?.connected) throw new Error('Bluetooth non connecté');
      // Écriture avec accusé de réception si possible : plus lente mais plus
      // sûre (une écriture "sans réponse" trop rapide peut faire décrocher l'AppConnect).
      const props = this.out.properties;
      if (props.write && this.out.writeValueWithResponse) {
        await this.out.writeValueWithResponse(data);
      } else if (props.writeWithoutResponse && this.out.writeValueWithoutResponse) {
        await this.out.writeValueWithoutResponse(data);
      } else {
        await this.out.writeValue(data);
      }
    } catch (e) {
      this._reject(e);
    }
    return result;
  }

  async close() {
    try {
      this.notify?.removeEventListener('characteristicvaluechanged', this._onNotify);
      if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    } catch { /* ignore */ }
  }
}
