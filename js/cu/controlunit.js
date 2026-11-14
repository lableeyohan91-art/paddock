// Pilote de la Control Unit : boucle d'interrogation ('?') en continu,
// file de commandes prioritaires (vitesse, freinage, boutons...) et événements.
//
// Événements émis (EventTarget) :
//   'timer'  {address, timestamp, sector}   passage d'une voiture sur un capteur
//   'status' {fuel[], start, mode, pit[], display}
//   'connection' {state: 'connected'|'disconnected'|'error', message?}
//   'log' {message}

import * as P from './protocol.js';

export class ControlUnit extends EventTarget {
  constructor() {
    super();
    this.conn = null;
    this.version = null;
    this.status = null;
    this.commands = [];
    this.running = false;
    this.stats = { requests: 0, errors: 0, timers: 0 };
    this._lastTimer = new Map(); // anti-doublon
  }

  get connected() {
    return !!this.conn && this.running;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  log(message) {
    this.emit('log', { message });
  }

  async connect(conn) {
    await this.disconnect();
    this.conn = conn;
    conn.ondisconnect = () => this._lost();
    await conn.open();
    this.running = true;
    try {
      const v = P.parseResponse(await conn.request(P.cmdVersion()));
      this.version = v.type === 'version' ? v.version : null;
    } catch (e) {
      this.log('Version illisible : ' + e.message);
    }
    this.emit('connection', { state: 'connected', name: conn.name, version: this.version });
    this._loop();
  }

  async disconnect() {
    this.running = false;
    if (this.conn) {
      const c = this.conn;
      this.conn = null;
      await c.close();
      this.emit('connection', { state: 'disconnected' });
    }
  }

  async _lost() {
    if (!this.running || this._reconnecting) return;
    this._reconnecting = true;
    this.reconnecting = true;
    this.log(`Bluetooth coupé après ${this.stats.requests} échanges (${this.stats.errors} erreurs)`);
    this.emit('connection', { state: 'error', message: 'Connexion perdue, tentative de reconnexion…' });
    const conn = this.conn;
    for (let i = 0; i < 5 && this.running && conn?.reconnect; i++) {
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      try {
        await conn.reconnect();
        this._reconnecting = false;
        this.reconnecting = false;
        this.log('Reconnexion réussie');
        this.emit('connection', { state: 'connected', name: conn.name, version: this.version });
        return;
      } catch (e) {
        this.log(`Reconnexion ${i + 1}/5 échouée : ${e.message}`);
      }
    }
    this._reconnecting = false;
    this.reconnecting = false;
    // Échec définitif : on libère complètement la connexion pour un état cohérent
    this.running = false;
    this.conn = null;
    try { await conn?.close(); } catch { /* ignore */ }
    this.emit('connection', { state: 'disconnected', message: 'Connexion perdue. Reconnecte le circuit.' });
  }

  /** Met une commande en file ; elle passe avant le prochain '?'. */
  send(cmd) {
    if (!this.conn) return Promise.resolve(null);
    return new Promise((resolve) => this.commands.push({ cmd, resolve }));
  }

  /** Remplace une commande "à clé" encore en attente (évite d'empiler les réglages). */
  sendKeyed(key, cmd) {
    const existing = this.commands.find((c) => c.key === key);
    if (existing) {
      existing.cmd = cmd;
      return;
    }
    if (!this.conn) return;
    this.commands.push({ key, cmd, resolve: () => {} });
  }

  async _loop() {
    while (this.running && this.conn) {
      const item = this.commands.shift();
      const cmd = item ? item.cmd : P.cmdPoll();
      try {
        const raw = await this.conn.request(cmd);
        this.stats.requests++;
        if (item) {
          item.resolve(raw);
        } else {
          const r = P.parseResponse(raw);
          this._trace(raw, r);
          this._handle(r);
        }
      } catch (e) {
        this.stats.errors++;
        if (this.stats.errors <= 5 || this.stats.errors % 50 === 0) {
          this.log(`Erreur d'échange n°${this.stats.errors} (${cmd[0]}) : ${e.message}`);
        }
        item?.resolve(null);
        if (!this.running) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  }

  /** Garde les dernières réponses brutes différentes (diagnostic). */
  _trace(raw, r) {
    this.counts = this.counts || { status: 0, timer: 0, version: 0, unknown: 0 };
    this.counts[r.type] = (this.counts[r.type] || 0) + 1;
    this.trace = this.trace || [];
    if (this.trace.length && this.trace[this.trace.length - 1].raw === raw) return;
    const desc = r.type === 'timer' ? `passage voiture ${r.address + 1}, capteur ${r.sector}, t=${r.timestamp}`
      : r.type === 'status' ? `état : feux=${r.start} mode=${r.mode} carburant=${r.fuel.join(',')}`
        : r.type;
    this.trace.push({ time: new Date().toLocaleTimeString('fr-FR'), raw, desc });
    if (this.trace.length > 15) this.trace.shift();
  }

  _handle(r) {
    if (r.type === 'timer') {
      if (r.address < 0 || r.address > 7) return;
      const key = r.address * 16 + r.sector;
      if (this._lastTimer.get(key) === r.timestamp) return; // même passage répété
      this._lastTimer.set(key, r.timestamp);
      this.stats.timers++;
      this.emit('timer', r);
    } else if (r.type === 'status') {
      this.status = r;
      this.emit('status', r);
    }
  }

  // ---- Raccourcis ----
  pressStart() { return this.send(P.cmdPress(P.BUTTON.START_ENTER)); }
  pressEsc() { return this.send(P.cmdPress(P.BUTTON.PACE_CAR_ESC)); }
  resetTimer() { this._lastTimer.clear(); return this.send(P.cmdReset()); }
  setSpeed(a, v) { this.sendKeyed('speed' + a, P.cmdSetSpeed(a, clamp15(v))); }
  setBrake(a, v) { this.sendKeyed('brake' + a, P.cmdSetBrake(a, clamp15(v))); }
  setFuel(a, v) { this.sendKeyed('fuel' + a, P.cmdSetFuel(a, clamp15(v))); }
  setPosition(a, pos) { return this.send(P.cmdSetPos(a, Math.min(8, Math.max(1, pos)))); }
  clearPositions() { return this.send(P.cmdClearPos()); }
  setLap(v) {
    v = Math.max(0, Math.min(255, v));
    this.send(P.cmdSetLapHi(v >> 4));
    return this.send(P.cmdSetLapLo(v & 0xf));
  }
}

const clamp15 = (v) => Math.max(0, Math.min(15, Math.round(v)));
