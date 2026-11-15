// Lampes et rubans LED Bluetooth « grand public » (autres que Chihiros).
// Chaque marque parle sa propre langue : on connaît ici les plus répandues et
// on détecte la bonne d'après les services Bluetooth de la lampe.
// Une lampe suit les mêmes scènes que la rampe (js/devices/lightsync.js) :
// elle n'a besoin que de setColor(r, g, b) avec r, g, b de 0 à 100.

const uuid16 = (x) => `0000${x}-0000-1000-8000-00805f9b34fb`;
const to255 = (v) => Math.max(0, Math.min(255, Math.round((+v || 0) * 2.55)));

/** Govee : trame de 20 octets, dernier octet = XOR des 19 premiers. */
function govee(bytes) {
  const f = new Array(20).fill(0);
  bytes.forEach((b, i) => { f[i] = b; });
  f[19] = f.slice(0, 19).reduce((x, b) => x ^ b, 0);
  return f;
}

export const PROTOCOLS = [
  {
    id: 'elk',
    label: 'ELK-BLEDOM / LEDnet (rubans et lampes LED génériques)',
    service: uuid16('fff0'),
    char: uuid16('fff3'),
    on: () => [[0x7e, 0x00, 0x04, 0xf0, 0x00, 0x01, 0xff, 0x00, 0xef]],
    color: (r, g, b) => [[0x7e, 0x00, 0x05, 0x03, r, g, b, 0x00, 0xef]],
  },
  {
    id: 'triones',
    label: 'Triones / HappyLighting / iLight',
    service: uuid16('ffd5'),
    char: uuid16('ffd9'),
    on: () => [[0xcc, 0x23, 0x33]],
    color: (r, g, b) => [[0x56, r, g, b, 0x00, 0xf0, 0xaa]],
  },
  {
    id: 'govee',
    label: 'Govee (rubans et lampes)',
    service: '00010203-0405-0607-0809-0a0b0c0d1910',
    char: '00010203-0405-0607-0809-0a0b0c0d2b11',
    on: () => [govee([0x33, 0x01, 0x01])],
    // anciens modèles (02) et récents (0d) : on envoie les deux formes
    color: (r, g, b) => [govee([0x33, 0x05, 0x02, r, g, b]), govee([0x33, 0x05, 0x0d, r, g, b])],
  },
];

const CHIHIROS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const ALL_SERVICES = [...PROTOCOLS.map((p) => p.service), CHIHIROS_SERVICE];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export class GenericLight extends EventTarget {
  constructor(saved = null) {
    super();
    this.id = saved?.id || null;
    this.name = saved?.name || null;
    this.protocolId = saved?.protocol || null;
    this.device = null;
    this.char = null;
    this.status = 'off';
    this.error = null;
    this.color = null;
    this.helloing = false;
    this._chain = Promise.resolve();
    this._pending = null;
  }

  get protocol() { return PROTOCOLS.find((p) => p.id === this.protocolId) || null; }
  get connected() { return this.status === 'on'; }

  _set(status, error = null) {
    this.status = status;
    this.error = error;
    this.dispatchEvent(new Event('change'));
  }

  /** Recherche d'une nouvelle lampe : la liste montre tous les appareils Bluetooth. */
  static async pick() {
    if (!navigator.bluetooth) throw new Error('Bluetooth non disponible dans ce navigateur (utilise Chrome).');
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: ALL_SERVICES });
    const l = new GenericLight({ id: device.id, name: device.name || 'Lampe Bluetooth' });
    l._adopt(device);
    await l._open(); // détecte le protocole
    return l;
  }

  _adopt(device) {
    this.device = device;
    this.id = device.id;
    this.name = device.name || this.name || 'Lampe Bluetooth';
    device.addEventListener('gattserverdisconnected', () => { this.char = null; this._set('off'); });
  }

  async _open() {
    this._set('connecting');
    try {
      const server = await this.device.gatt.connect();
      let found = null;
      const order = this.protocol ? [this.protocol, ...PROTOCOLS.filter((p) => p !== this.protocol)] : PROTOCOLS;
      for (const p of order) {
        try {
          const svc = await server.getPrimaryService(p.service);
          this.char = await svc.getCharacteristic(p.char);
          found = p;
          break;
        } catch { /* pas ce protocole */ }
      }
      if (!found) {
        let chihiros = false;
        try { await server.getPrimaryService(CHIHIROS_SERVICE); chihiros = true; } catch { /* non */ }
        try { this.device.gatt.disconnect(); } catch { /* ignore */ }
        throw new Error(chihiros
          ? 'C\'est une rampe Chihiros : connecte-la depuis l\'onglet « Chihiros ».'
          : 'Lampe non reconnue : sa marque utilise un protocole que Paddock ne connaît pas encore.');
      }
      this.protocolId = found.id;
      await this._send(found.on());
      this._set('on');
    } catch (e) {
      this._set('error', e?.message || String(e));
      throw e;
    }
  }

  async reconnect() {
    if (!this.device) throw new Error('Lampe à rechercher à nouveau');
    await this._open();
  }

  /** Lampe déjà autorisée : on la retrouve sans rien demander (si le navigateur le permet). */
  async autoConnect() {
    if (!navigator.bluetooth?.getDevices) return false;
    const d = (await navigator.bluetooth.getDevices()).find((x) => x.id === this.id);
    if (!d) return false;
    this._adopt(d);
    try { await this._open(); return true; } catch { return false; }
  }

  async _write(bytes) {
    const p = this.char.properties;
    const data = Uint8Array.from(bytes);
    if (p.writeWithoutResponse) await this.char.writeValueWithoutResponse(data);
    else await this.char.writeValueWithResponse(data);
  }

  _send(frames) {
    const run = async () => {
      for (let i = 0; i < frames.length; i++) {
        if (i) await wait(30);
        await this._write(frames[i]);
      }
    };
    this._chain = this._chain.then(run, run);
    return this._chain;
  }

  /** Couleur de 0 à 100 par canal (comme la rampe) ; seule la plus récente est envoyée. */
  setColor(r, g, b) {
    const want = [r, g, b];
    const already = !!this._pending;
    this._pending = want;
    if (already) return this._chain;
    return this._chain.then(async () => {
      const c = this._pending;
      this._pending = null;
      if (!c || !this.char || !this.protocol) return;
      await this._send(this.protocol.color(to255(c[0]), to255(c[1]), to255(c[2])));
      this.color = { r: c[0], g: c[1], b: c[2] };
      this.dispatchEvent(new Event('color'));
    }).catch((e) => this._set('error', e?.message || String(e)));
  }

  /** Signal de connexion : 2 clignotements puis allumée (comme la rampe). */
  async hello() {
    this.helloing = true;
    try {
      for (let i = 0; i < 2; i++) {
        await this.setColor(100, 100, 100); await wait(450);
        await this.setColor(0, 0, 0); await wait(450);
      }
      await this.setColor(100, 100, 100);
    } finally { this.helloing = false; }
  }

  disconnect() {
    try { this.device?.gatt?.disconnect(); } catch { /* ignore */ }
    this.char = null;
    this._set('off');
  }

  toJSON() { return { id: this.id, name: this.name, protocol: this.protocolId }; }
}
