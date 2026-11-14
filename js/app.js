// Point d'entrée : état global, connexion, cycle de vie des sessions, navigation.

import { ControlUnit } from './cu/controlunit.js';
import { BleConnection, bluetoothSupported } from './cu/ble.js';
import { SimulatorConnection } from './cu/simulator.js';
import { PerformanceEngine, yellowFlagModifier } from './performance.js';
import { Weather, SKY } from './weather.js';
import { RaceSession, TYPES, fmtTime, fmtClock } from './race.js';
import * as db from './db.js';
import * as sync from './sync.js';
import { defaultFuelConfig, consumption, sanitize, balancedPreset, sprint30Preset } from './fuel.js';
import { audio, beep, say, spokenTime, unlockAudio } from './audio.js';
import { $, $$, esc, toast, modal, confirmBox } from './ui.js';

import * as raceView from './views/race.js';
import * as setupView from './views/setup.js';
import * as garageView from './views/garage.js';
import * as driversView from './views/drivers.js';
import * as driverView from './views/driver.js';
import * as ghostView from './views/ghost.js';
import * as quickView from './views/quick.js';
import { openImport, importDone } from './views/import-records.js';
import * as statsView from './views/stats.js';
import * as settingsView from './views/settings.js';

const VIEWS = { race: raceView, setup: setupView, garage: garageView, drivers: driversView, driver: driverView, ghost: ghostView, quick: quickView, stats: statsView, settings: settingsView };

const cu = new ControlUnit();
export const GHOST = 6; // adresse de la voiture autonome (fantôme) ; 7 = pace car
const perf = new PerformanceEngine(cu);
const weather = new Weather();

export const app = {
  cu, perf, weather, db,
  session: null,
  sessionRecord: null,
  data: { drivers: [], cars: [], tracks: [] },
  setup: null,
  view: 'race',
  logLines: [],

  log(msg) {
    const line = new Date().toLocaleTimeString('fr-FR') + '  ' + msg;
    this.logLines.push(line);
    if (this.logLines.length > 200) this.logLines.shift();
    VIEWS[this.view]?.onLog?.(line);
  },

  /** Relit tout depuis la base locale (après une synchronisation venue d'un autre appareil). */
  async reloadFromDb() {
    await this.loadData();
    this.setup = await db.getSetting('setup', null) || setupView.defaultSetup(this);
    this.fuelCfg = sanitize(await db.getSetting('fuel', defaultFuelConfig()));
    this.ghost.settings = { ...this.ghost.settings, ...(await db.getSetting('ghost', {})) };
    audio.voice = await db.getSetting('voice', true);
    audio.sounds = await db.getSetting('sounds', true);
    if (!this.isRacing) this.go(this.view);
    this.log('Données synchronisées depuis ton compte');
  },

  async loadData() {
    this.data.drivers = (await db.all('drivers')).sort((a, b) => a.name.localeCompare(b.name));
    this.data.cars = (await db.all('cars')).sort((a, b) => a.name.localeCompare(b.name));
    this.data.tracks = (await db.all('tracks')).sort((a, b) => a.name.localeCompare(b.name));
    this.data.tunes = new Map((await db.all('tunes')).map((t) => [t.id, t]));
  },

  // ---------- Garage : réglages par couple pilote + voiture ----------

  tuneId(driverId, carId) {
    return `${driverId || '-'}|${carId || '-'}`;
  },

  /** Réglage du pilote sur cette voiture (valeurs 0..15). */
  getTune(driverId, carId) {
    const t = this.data.tunes.get(this.tuneId(driverId, carId));
    if (t) return { speed: t.speed, brake: t.brake, fuel: t.fuel, saved: true };
    const car = this.car(carId);
    return { speed: car?.speed ?? 15, brake: car?.brake ?? 15, fuel: car?.fuelCapacity ?? 15, saved: false };
  },

  async saveTune(driverId, carId, values) {
    const id = this.tuneId(driverId, carId);
    const t = { ...this.getTune(driverId, carId), ...values, id, driverId, carId, updated: Date.now() };
    delete t.saved;
    this.data.tunes.set(id, t);
    await db.put('tunes', t);
    // applique tout de suite aux manettes qui utilisent ce couple
    (this.setup?.slots || [])
      .filter((s) => s.active && s.driverId === driverId && s.carId === carId)
      .forEach((s) => this.applyTune(s.address, Object.keys(values)));
  },

  /** Envoie le réglage d'une manette à la Control Unit (et au moteur de performance). */
  applyTune(address, keys = ['speed', 'brake', 'fuel']) {
    const slot = this.setup?.slots?.[address];
    if (!slot) return;
    const t = this.getTune(slot.driverId, slot.carId);
    const s = this.session;
    const comp = s?.comps.get(address);
    if (comp) {
      comp.car.speed = t.speed;
      comp.car.brake = t.brake;
    }
    if (keys.includes('speed') || keys.includes('brake')) {
      if (comp && s.state !== 'finished') perf.setBase(address, t.speed, t.brake);
      else if (cu.connected) { cu.setSpeed(address, t.speed); cu.setBrake(address, t.brake); }
    }
    // le réservoir ne change pas en pleine course (il remplirait les voitures)
    if (keys.includes('fuel') && cu.connected && !this.isRacing) cu.setFuel(address, t.fuel);
  },

  /**
   * Change le pilote et/ou la voiture d'une manette, y compris en pleine session.
   * Le réglage garage du nouveau couple pilote + voiture est appliqué aussitôt.
   */
  async swapEntry(address, driverId, carId) {
    const slot = this.setup.slots[address];
    const prevDriver = this.driver(slot.driverId);
    const changedDriver = slot.driverId !== driverId;
    const changedCar = slot.carId !== carId;
    if (!changedDriver && !changedCar) return;

    slot.driverId = driverId;
    slot.carId = carId;
    slot.active = true;
    await this.saveSetup();

    const s = this.session;
    const driver = this.driver(driverId);
    const t = this.getTune(driverId, carId);
    const car = { ...(this.car(carId) || { id: carId, name: '—' }), speed: t.speed, brake: t.brake, fuel: t.fuel };
    if (s && s.state !== 'finished') {
      // en essais/qualif, un nouveau pilote a son propre chrono ; en course c'est un relais
      const reset = changedDriver && s.cfg.type !== 'race';
      const comp = s.reassign(address, driver, car, { resetTiming: reset });
      // essence : nouveau pilote en essais/qualif = plein ; sinon on garde le niveau
      if (reset || comp.fuelPct === null) this.fillTank(comp, t.fuel);
      else {
        comp.tankPct = Math.round((t.fuel / 15) * 100);
        comp.fuelPct = Math.min(comp.fuelPct, comp.tankPct);
      }
      if (this.sessionRecord) {
        this.sessionRecord.entries = [...s.comps.values()].map((c) => ({ address: c.address, driverId: c.driver.id, carId: c.car.id }));
        db.put('sessions', this.sessionRecord);
      }
    }
    this.applyTune(address, ['speed', 'brake']);

    const n = address + 1;
    if (changedDriver) {
      const msg = `${driver?.name || 'Nouveau pilote'} prend la manette ${n}` + (prevDriver ? ` à la place de ${prevDriver.name}` : '');
      this.log(msg);
      if (s && s.state !== 'finished') say(msg);
      toast('🔄 ' + msg);
    }
    if (changedCar) {
      const msg = `Manette ${n} : ${driver?.name || ''} passe sur ${car.name}`;
      this.log(msg);
      if (!changedDriver) toast('🔄 ' + msg);
    }
    this.refresh();
  },

  // ---------- Essence simulée ----------

  fuelCfg: defaultFuelConfig(),

  /** Temps au tour du simulateur : le milieu de la fourchette nominale d'essence. */
  simBaseLap() {
    const n = this.fuelCfg.nominal;
    return Math.round(((n.min + n.max) / 2) * 1000);
  },

  /** Simulateur : chaque voiture tourne au temps de base avec son réglage garage actuel. */
  calibrateSim() {
    const sim = cu.conn;
    if (sim?.kind !== 'sim') return;
    sim.baseLap = this.simBaseLap();
    for (const [address, base] of perf.bases) sim.calibrate(address, base.speed, base.brake);
    // seules les voitures de la session roulent (+ la voiture fantôme)
    if (perf.bases.size) sim.cars.forEach((c, i) => { if (i !== 6) c.active = perf.bases.has(i); });
  },

  openFuelSettings() {
    settingsView.openFuel();
    this.go('settings');
  },

  async saveFuelCfg(cfg, opts = {}) {
    this.fuelCfg = sanitize(cfg);
    await db.setSetting('fuel', this.fuelCfg, opts);
  },

  // ---------- Setups d'essence (réglages nommés) ----------
  // Un setup = toute la config essence sauf l'interrupteur "activer".

  async fuelSetups() {
    return db.getSetting('fuelSetups', []);
  },

  async saveFuelSetup(name, id = null, opts = {}) {
    const list = await this.fuelSetups();
    const { enabled, ...cfg } = this.fuelCfg;
    const existing = id ? list.find((s) => s.id === id) : list.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (existing) Object.assign(existing, { name, cfg, date: Date.now() });
    else list.push({ id: db.uid(), name, cfg, date: Date.now() });
    await db.setSetting('fuelSetups', list, opts);
    await db.setSetting('fuelActiveSetup', existing?.id ?? list[list.length - 1].id, opts);
    return list;
  },

  /** Ajoute un setup tout fait sans le rendre actif (remplace s'il existe déjà). */
  async addFuelSetup(name, cfgPart, opts = {}) {
    const list = await this.fuelSetups();
    const { enabled, ...base } = this.fuelCfg;
    const cfg = { ...sanitize({ ...base, ...cfgPart }) };
    delete cfg.enabled;
    const existing = list.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (existing) Object.assign(existing, { cfg, date: Date.now() });
    else list.push({ id: db.uid(), name, cfg, date: Date.now() });
    await db.setSetting('fuelSetups', list, opts);
  },

  async loadFuelSetup(id) {
    const s = (await this.fuelSetups()).find((x) => x.id === id);
    if (!s) return false;
    await this.saveFuelCfg({ ...s.cfg, enabled: this.fuelCfg.enabled });
    await db.setSetting('fuelActiveSetup', id);
    return true;
  },

  async deleteFuelSetup(id) {
    const list = (await this.fuelSetups()).filter((s) => s.id !== id);
    await db.setSetting('fuelSetups', list);
    if ((await db.getSetting('fuelActiveSetup', null)) === id) await db.setSetting('fuelActiveSetup', null);
  },

  async renameFuelSetup(id, name) {
    const list = await this.fuelSetups();
    const s = list.find((x) => x.id === id);
    if (s) { s.name = name; await db.setSetting('fuelSetups', list); }
  },

  /** Remplit le réservoir d'une voiture (valeur garage 0..15 -> %). */
  fillTank(comp, tank15 = 15) {
    comp.tankPct = Math.round((tank15 / 15) * 100);
    comp.fuelPct = comp.tankPct;
    comp.lowWarned = false;
    comp.lastFuelUse = null;
  },

  /** Effet "panne sèche" pour le moteur de performance : vitesse bridée à 0 %. */
  emptyTankModifier() {
    return {
      id: 'fuel',
      label: 'Panne sèche',
      compute: (address) => {
        const c = this.session?.comps.get(address);
        if (!this.fuelOn() || !c || c.fuelPct === null || c.fuelPct > 0) return null;
        if (!['running', 'finishing'].includes(this.session.state)) return null;
        const f = this.fuelCfg;
        if (f.emptyMode === 'fixed') {
          // vitesse imposée : facteur = vitesse voulue / vitesse de base de la voiture
          const base = perf.bases.get(address)?.speed || 15;
          return { speed: Math.min(1, f.emptySpeedFixed / base), note: `⛽ Panne sèche (vitesse ${f.emptySpeedFixed}/15)` };
        }
        return { speed: f.emptySpeedPct / 100, note: '⛽ Panne sèche' };
      },
    };
  },

  /** Retire l'essence du tour qui vient d'être bouclé. Renvoie le % consommé. */
  burnFuel(comp, lapMs) {
    if (!this.fuelOn()) return null;
    if (comp.fuelPct === null || comp.fuelPct === undefined) this.fillTank(comp, 15);
    const { pct, band } = consumption(this.fuelCfg, lapMs);
    comp.fuelPct = Math.max(0, comp.fuelPct - pct);
    comp.lastFuelUse = pct;
    comp.lastFuelBand = band;
    if (!comp.lowWarned && comp.fuelPct > 0 && comp.fuelPct <= this.fuelCfg.lowWarnPct) {
      comp.lowWarned = true;
      say(`${comp.driver.name}, réserve d'essence`);
    }
    if (comp.fuelPct === 0 && !comp.emptyWarned) {
      comp.emptyWarned = true;
      say(`${comp.driver.name}, panne sèche ! Passe au stand`, { priority: true });
      this.log(`${comp.driver.name} : panne sèche`);
      perf.update(); // bride la voiture tout de suite
    }
    return pct;
  },

  /** Ravitaillement : appelé en continu ; remplit les voitures qui sont au stand. */
  refuelTick(dtMs) {
    const s = this.session;
    if (!s || !this.fuelOn() || !['running', 'finishing'].includes(s.state)) return;
    for (const c of s.comps.values()) {
      if (!c.inPit || c.fuelPct === null || c.fuelPct >= c.tankPct) continue;
      const wasEmpty = c.fuelPct <= 0;
      c.fuelPct = Math.min(c.tankPct, c.fuelPct + (this.fuelCfg.refuelPerSec * dtMs) / 1000);
      if (wasEmpty && c.fuelPct > 0) perf.update(); // la voiture retrouve sa vitesse
      // simulateur : la voiture repart toute seule une fois le plein fait
      if (c.fuelPct >= c.tankPct && this.isSim) cu.conn.pit?.(c.address, false);
      if (c.fuelPct > this.fuelCfg.lowWarnPct) { c.lowWarned = false; c.emptyWarned = false; }
    }
  },

  // ---------- Voiture fantôme (adresse 7 de la CU = index 6) ----------
  // Chrono indépendant des sessions : sert aux tests (régularité, réglages).

  ghost: {
    settings: { speed: 10, brake: 15 },
    laps: [],        // temps des tours (ms)
    lastTs: null,
    sectorTs: null,
    sectors: [],
    lastSectors: [],
    seenAt: null,
  },

  onGhostTimer({ timestamp, sector }) {
    const g = this.ghost;
    g.seenAt = performance.now();
    if (sector > 1) {
      if (g.lastTs !== null) { g.sectors.push(timestamp - (g.sectorTs ?? g.lastTs)); g.sectorTs = timestamp; }
      return;
    }
    if (g.lastTs !== null) {
      const lap = timestamp - g.lastTs;
      if (lap >= (this.setup?.minLapMs || 1500)) {
        if (g.sectors.length) g.sectors.push(timestamp - g.sectorTs);
        g.lastSectors = g.sectors;
        g.laps.push(lap);
        if (g.laps.length > 200) g.laps.shift();
      } else return;
    }
    g.sectors = [];
    g.sectorTs = null;
    g.lastTs = timestamp;
    VIEWS.ghost?.onLap?.();
  },

  resetGhostTiming() {
    Object.assign(this.ghost, { laps: [], lastTs: null, sectorTs: null, sectors: [], lastSectors: [] });
  },

  async saveGhost(values) {
    Object.assign(this.ghost.settings, values);
    await db.setSetting('ghost', this.ghost.settings);
    this.applyGhost(Object.keys(values));
  },

  /** Envoie vitesse/freinage du fantôme à la CU (si elle l'accepte pour l'adresse 7). */
  applyGhost(keys = ['speed', 'brake']) {
    if (!cu.connected) return;
    const g = this.ghost.settings;
    if (keys.includes('speed')) cu.setSpeed(GHOST, g.speed);
    if (keys.includes('brake')) cu.setBrake(GHOST, g.brake);
  },

  // ---------- Détection des voitures en piste ----------
  // Une manette est "en piste" dès que sa voiture passe sur la ligne.
  seen: {},

  /** Secondes depuis le dernier passage de cette manette (null = jamais vue). */
  seenAgo(address) {
    const t = this.seen[address];
    return t ? (performance.now() - t) / 1000 : null;
  },

  markSeen(address) {
    const first = !this.seen[address];
    this.seen[address] = performance.now();
    const slot = this.setup?.slots?.[address];
    if (slot && !slot.active) {
      slot.active = true;
      this.saveSetup();
      this.applyTune(address);
      const who = this.driver(slot.driverId)?.name;
      toast(`🏎️ Manette ${address + 1} détectée en piste${who ? ' — ' + who : ''}`);
      this.log(`Manette ${address + 1} détectée en piste`);
      if (['garage', 'setup', 'quick'].includes(this.view)) VIEWS[this.view].refresh?.();
    } else if (first && this.view === 'garage') {
      VIEWS.garage.refresh?.();
    }
  },

  get isRacing() {
    return !!this.session && ['armed', 'running', 'finishing'].includes(this.session.state);
  },

  driver(id) { return this.data.drivers.find((d) => d.id === id); },
  car(id) { return this.data.cars.find((c) => c.id === id); },
  track(id) { return this.data.tracks.find((t) => t.id === id); },

  go(view) {
    if (!VIEWS[view]) view = 'race';
    VIEWS[this.view]?.unmount?.();
    this.view = view;
    const tab = view === 'driver' ? 'drivers' : (view === 'quick' || view === 'setup') ? 'race' : view; // la fiche pilote dépend de l'onglet Pilotes
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === tab));
    window.scrollTo(0, 0);
    const main = $('#main');
    main.innerHTML = '';
    VIEWS[view].mount(main, this);
    if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
  },

  refresh() {
    VIEWS[this.view]?.refresh?.();
  },

  // ---------- Connexion ----------

  openConnectDialog() {
    if (cu.conn) {
      const m = modal(`
        <h2>${cu.reconnecting ? 'Reconnexion en cours…' : 'Connecté'} : ${esc(cu.conn.name)}</h2>
        <p class="muted">Version Control Unit : ${esc(cu.version || 'inconnue')}</p>
        <p class="muted num" id="cuLive"></p>
        <div class="row" style="justify-content:flex-end">
          <button class="btn ghost" data-close>Fermer</button>
          <button class="btn primary" id="discBtn">Déconnecter</button>
        </div>`, { onClose: () => clearInterval(live) });
      const upd = () => {
        const el = m.el.querySelector('#cuLive');
        if (el) el.textContent = `Échanges : ${cu.stats.requests} · erreurs : ${cu.stats.errors} · passages : ${cu.stats.timers}`;
      };
      const live = setInterval(upd, 300);
      upd();
      m.el.querySelector('#discBtn').onclick = async () => { m.close(); await cu.disconnect(); };
      return;
    }
    const bt = bluetoothSupported();
    const m = modal(`
      <h2>Connexion au circuit</h2>
      <div class="choice">
        <button id="cBle" ${bt ? '' : 'disabled'}>
          <strong>🔵 Carrera AppConnect (Bluetooth)</strong>
          <span class="muted">${bt ? 'Allume la Control Unit avec l\'AppConnect branché, puis choisis-le dans la liste.' : 'Bluetooth indisponible dans ce navigateur : utilise Chrome ou Edge.'}</span>
        </button>
        ${bt ? `<button id="cBleAll">
          <strong>🔍 AppConnect introuvable ?</strong>
          <span class="muted">Affiche tous les appareils Bluetooth autour du PC. Choisis celui qui ressemble à la Control Unit.</span>
        </button>` : ''}
        <button id="cSim">
          <strong>🎮 Simulateur</strong>
          <span class="muted">Des voitures virtuelles pour tester l'appli sans le circuit.</span>
        </button>
      </div>
      <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn ghost" data-close>Annuler</button></div>`);
    m.el.querySelector('#cBle').onclick = () => { m.close(); this.connect(new BleConnection()); };
    const all = m.el.querySelector('#cBleAll');
    if (all) all.onclick = () => {
      m.close();
      const c = new BleConnection();
      c.showAll = true;
      this.connect(c);
    };
    m.el.querySelector('#cSim').onclick = () => {
      m.close();
      const n = Math.max(2, (this.setup?.slots || []).filter((s) => s.active).length);
      this.connect(new SimulatorConnection({ cars: n, baseLap: this.simBaseLap() }));
    };
  },

  async connect(conn) {
    unlockAudio();
    setConn('warn', 'Connexion…');
    try {
      await cu.connect(conn);
      await db.setSetting('lastConnection', conn.kind);
    } catch (e) {
      setConn('', 'Non connecté');
      if (e.name !== 'NotFoundError') toast('Connexion impossible : ' + e.message, 5000);
      this.log('Erreur de connexion : ' + e.message);
    }
  },

  get isSim() {
    return cu.conn?.kind === 'sim';
  },

  // ---------- Sessions ----------

  async saveSetup() {
    await db.setSetting('setup', this.setup);
  },

  /**
   * Course rapide : course aux tours, feux de départ, sans météo.
   * opts : { laps, fuelOn, tank15 (0-15, même réservoir pour tous) }
   */
  async prepareQuickRace(opts) {
    return this.prepareSession({
      type: opts.type || 'race', mode: 'laps', laps: opts.laps, start: 'lights',
      weather: { sky: 'sun', dynamic: false, variability: 1, intensity: 1 },
      quick: true,
      title: opts.title,
      fuel: { enabled: !!opts.fuelOn, tank15: opts.tank15 },
    });
  },

  /** L'essence est-elle gérée pour la session en cours ? (une course rapide peut la couper) */
  fuelOn() {
    return this.session?.cfg.fuel?.enabled ?? this.fuelCfg.enabled;
  },

  async prepareSession(over = {}) {
    if (this.isRacing) {
      const ok = await confirmBox(`Une session (${TYPES[this.session.cfg.type]}) est en cours. L'arrêter pour en préparer une nouvelle ?`);
      if (!ok) { this.go('race'); return false; }
      this.session.stop();
    }
    const s = { ...this.setup, ...over };
    this.lastPrepare = over;   // pour "Relancer la même course"
    this.raceMenu = false;
    const entries = s.slots.filter((x) => x.active).map((x) => {
      const t = this.getTune(x.driverId, x.carId); // réglage garage du pilote sur cette voiture
      return {
        address: x.address,
        driver: this.driver(x.driverId),
        car: { ...(this.car(x.carId) || {}), speed: t.speed, brake: t.brake, fuel: t.fuel },
      };
    });
    if (!entries.length) {
      toast('Active au moins une manette');
      return false;
    }
    const session = new RaceSession({
      type: s.type,
      mode: s.mode,
      laps: s.laps,
      duration: s.duration,
      start: s.type === 'race' ? s.start : 'immediate',
      minLapMs: s.minLapMs,
      entries,
      autoAdd: true, // une manette non configurée apparaît quand même au classement
      quick: !!s.quick,
      title: s.title,
      fuel: s.fuel, // course rapide : essence activée ou non + réservoir commun
    });
    session.trackId = s.trackId;
    this.session = session;
    this._wireSession(session);

    // Moteur de performance
    perf.clearBases();
    perf.removeModifier('weather');
    perf.removeModifier('flag');
    if (!s.quick) perf.addModifier(weather.modifier()); // pas de météo en course rapide
    perf.addModifier(yellowFlagModifier(() => this.session?.flag));
    perf.removeModifier('fuel');
    perf.addModifier(this.emptyTankModifier());
    entries.forEach((e) => perf.setBase(e.address, e.car.speed, e.car.brake));
    this.calibrateSim();
    // Essence : chaque voiture part avec son réservoir du garage,
    // ou avec le réservoir commun choisi pour la course rapide
    const tankOf = (c) => s.fuel?.tank15 ?? this.getTune(c.driver.id, c.car.id).fuel;
    for (const c of session.comps.values()) this.fillTank(c, tankOf(c));
    perf.start();
    if (cu.connected) for (const c of session.comps.values()) cu.setFuel(c.address, tankOf(c));

    // Météo (aucune en course rapide)
    weather.variability = s.weather.variability;
    weather.intensity = s.weather.intensity;
    weather.dynamic = s.weather.dynamic;
    weather.reset(s.weather.sky);
    if (s.quick) weather.stop(); else weather.start();

    this.sessionRecord = null;
    this.go('race');
    return true;
  },

  _wireSession(session) {
    session.addEventListener('lap', (e) => this._onLap(e.detail));
    session.addEventListener('finish', (e) => {
      const c = e.detail.comp;
      if (c.finishPos === 1) {
        say(session.cfg.type === 'race'
          ? `Drapeau à damier ! Victoire de ${c.driver.name}`
          : `Fin de la session. ${c.driver.name} termine premier`, { priority: true });
      }
    });
    session.addEventListener('pit', (e) => {
      if (e.detail.in) this.log(`${e.detail.comp.driver.name} entre au stand`);
    });
    session.addEventListener('state', async (e) => {
      const st = e.detail.state;
      this.log('Session : ' + ({ armed: 'feux en cours', running: 'départ donné', finishing: 'dernier tour', finished: 'terminée' }[st] || st));
      if (st === 'running') {
        beep(1320, 500);
        await this._saveSessionRecord('running');
        if (session.durationMs) say(session.cfg.type === 'race' ? 'Départ !' : 'La session commence');
        else say('Départ !');
      }
      if (st === 'finishing' && session.cfg.type !== 'race') say('Fin du temps. Dernier tour.');
      if (st === 'finishing' && session.cfg.type === 'race' && session.cfg.mode === 'time') say('Fin du temps, dernier tour !');
      if (st === 'finished') {
        // simulateur : les voitures virtuelles s'arrêtent à la fin de la session
        if (this.isSim) cu.conn.running = false;
        await this._saveSessionRecord('finished');
        perf.stop();
        perf.restore();
        weather.stop();
        raceView.showResults?.(this);
      }
    });
  },

  async _saveSessionRecord(state) {
    const s = this.session;
    if (!s) return;
    if (s.simulated ?? this.isSim) return; // le simulateur n'alimente pas les statistiques
    if (!this.sessionRecord) {
      this.sessionRecord = {
        id: db.uid(),
        type: s.cfg.type,
        mode: s.cfg.mode,
        laps: s.cfg.laps,
        duration: s.cfg.duration,
        trackId: s.trackId,
        date: Date.now(),
        entries: [...s.comps.values()].map((c) => ({ address: c.address, driverId: c.driver.id, carId: c.car.id })),
        weatherStart: weather.sky,
      };
      s.id = this.sessionRecord.id;
    }
    this.sessionRecord.state = state;
    if (state === 'finished') {
      this.sessionRecord.results = s.results();
      this.sessionRecord.ended = Date.now();
      this.sessionRecord.bestLap = s.overallBest?.time ?? null;
    }
    await db.put('sessions', this.sessionRecord);
  },

  async _onLap({ comp, lap, isBest, isOverallBest }) {
    const s = this.session;
    const p = perf.current.get(comp.address);
    const fuelUsed = this.burnFuel(comp, lap.time);
    if (!(s.simulated ?? this.isSim)) db.put('laps', {
      fuelUsed,
      fuelLeft: comp.fuelPct,
      sessionId: s.id,
      sessionType: s.cfg.type,
      trackId: s.trackId,
      driverId: comp.driver.id,
      carId: comp.car.id,
      address: comp.address,
      lapNo: lap.lapNo,
      time: lap.time,
      sectors: lap.sectors,
      sky: weather.sky,
      wetness: Math.round(weather.wetness * 100) / 100,
      speed: p?.speed ?? null,
      flag: s.flag,
      date: Date.now(),
    }).catch((e) => this.log('Sauvegarde du tour impossible : ' + e.message));

    if (isOverallBest && comp.laps > 1) {
      say(`Meilleur tour, ${comp.driver.name}, ${spokenTime(lap.time)}`);
    } else if (isBest && s.cfg.type !== 'race' && comp.laps > 1) {
      say(`${comp.driver.name}, ${spokenTime(lap.time)}`);
    }
    if (s.cfg.type === 'race' && s.cfg.mode !== 'time' && comp.position === 1) {
      const left = s.cfg.laps - comp.laps;
      if (left === 1) say('Dernier tour !');
    }
    raceView.flashRow?.(comp.address);
  },

  async startSession() {
    const s = this.session;
    if (!s) return;
    if (!cu.connected) {
      toast('Connecte d\'abord le circuit ou le simulateur');
      this.openConnectDialog();
      return;
    }
    unlockAudio();
    s.simulated = this.isSim; // fixé au départ : une session simulée ne sera jamais enregistrée
    if (s.cfg.start === 'lights') {
      await cu.resetTimer();
      s.arm();
      await cu.pressStart();
      // Certaines CU demandent un 2e appui pour lancer la séquence des feux
      setTimeout(() => {
        if (s.state === 'armed' && cu.status?.start === 1) cu.pressStart();
      }, 1500);
    } else {
      cu.conn.go?.();
      s.go();
    }
  },

  toggleYellow() {
    const s = this.session;
    if (!s || !['running', 'finishing'].includes(s.state)) return;
    s.setFlag(s.flag === 'yellow' ? 'green' : 'yellow');
    perf.update();
    say(s.flag === 'yellow' ? 'Drapeau jaune ! Ralentissez' : 'Drapeau vert, la course reprend', { priority: true });
  },
};

// ---------- Indicateur de connexion ----------

function setConn(state, label) {
  $('#connDot').className = 'dot' + (state === 'on' ? ' on' : state === 'warn' ? ' warn' : '');
  $('#connLabel').textContent = label;
}

cu.addEventListener('connection', (e) => {
  const d = e.detail;
  if (d.state === 'connected') {
    setConn('on', d.name);
    app.log(`Connecté à ${d.name} (CU ${d.version || '?'})`);
    toast('Connecté : ' + d.name);
    perf.sent.clear();
    perf.update();
    app.calibrateSim();
    // envoie les réglages du garage dès la connexion
    if (!app.isRacing) (app.setup?.slots || []).filter((s) => s.active).forEach((s) => app.applyTune(s.address));
  } else if (d.state === 'error') {
    setConn('warn', 'Reconnexion…');
    app.log(d.message);
  } else {
    setConn('', 'Non connecté');
    app.log('Déconnecté' + (d.message ? ' : ' + d.message : ''));
    if (d.message) toast(d.message, 4000);
  }
  app.refresh();
});

let lastStart = null;
cu.addEventListener('status', (e) => {
  const st = e.detail;
  if (st.start !== lastStart) {
    if (st.start >= 2 && st.start <= 6) beep(660, 220);
    lastStart = st.start;
  }
  app.session?.onStatus(st);
});

cu.addEventListener('timer', (e) => {
  const t = e.detail;
  if (t.address <= 5) app.markSeen(t.address);
  if (t.address === GHOST) app.onGhostTimer(t);
  const s = app.session;
  if (!s) return;
  if (t.address > 5 && !s.comps.has(t.address)) return; // voiture autonome / pace car
  s.onTimer(t);
});

cu.addEventListener('log', (e) => app.log(e.detail.message));

weather.addEventListener('change', (e) => {
  const { sky, announce } = e.detail;
  app.log('Météo : ' + SKY[sky].label);
  if (announce && app.session && ['running', 'finishing'].includes(app.session.state)) {
    const msg = {
      sun: 'Le soleil revient, la piste va sécher',
      cloudy: 'Les nuages arrivent',
      drizzle: 'Il commence à bruiner',
      rain: 'La pluie tombe sur le circuit',
      storm: 'Orage ! La piste devient très glissante',
    }[sky];
    say(msg);
    toast(SKY[sky].icon + ' ' + msg);
  }
  updateWeatherChip();
});
weather.addEventListener('update', updateWeatherChip);

function updateWeatherChip() {
  $('#weatherChip').textContent = app.session && !app.session.cfg.quick
    ? `${SKY[weather.sky].icon} ${weather.label} · ${weather.trackLabel}`
    : '';
}

// ---------- Bandeau "session en cours" (visible hors de l'écran Course) ----------

function updateLiveBar() {
  const bar = $('#liveBar');
  const s = app.session;
  const live = s && ['armed', 'running', 'finishing'].includes(s.state);
  bar.classList.toggle('hidden', !live || app.view === 'race');
  $('#tabs [data-view="race"]').classList.toggle('live', !!live);
  if (!live || app.view === 'race') return;
  const rem = s.remainingMs;
  const clock = rem !== null ? fmtClock(rem) : fmtClock(s.elapsedMs);
  const lead = s.order[0];
  const txt = `${TYPES[s.cfg.type]} en cours · ${clock}` +
    (s.cfg.type === 'race' && s.cfg.mode !== 'time' ? ` · tour ${Math.min(s.leaderLaps + 1, s.cfg.laps)}/${s.cfg.laps}` : '') +
    (lead && lead.laps ? ` · P1 ${lead.driver.name}` : '');
  const html = `<span class="live-dot"></span><span>${esc(txt)}</span><b>Retour à la piste →</b>`;
  if (bar.innerHTML !== html) bar.innerHTML = html;
}

// ---------- Nouvelle version disponible ----------
// Le serveur local indique la date de dernière modification de l'appli.
// Si elle change, on propose de recharger (sans jamais interrompre une session).

let bootVersion = null;
async function checkVersion() {
  try {
    const r = await fetch('__version', { cache: 'no-store' });
    if (!r.ok) return;
    const { v } = await r.json();
    if (bootVersion === null) { bootVersion = v; app.version = v; return; }
    if (v !== bootVersion && !$('#updateBar')) {
      const b = document.createElement('button');
      b.id = 'updateBar';
      b.className = 'updatebar';
      b.innerHTML = '🔄 Nouvelle version de Paddock disponible — <b>Recharger</b>';
      b.onclick = async () => {
        if (app.isRacing && !(await confirmBox('Une session est en cours : recharger l\'appli l\'arrêtera. Continuer ?'))) return;
        location.reload();
      };
      document.body.appendChild(b);
    }
  } catch { /* serveur sans contrôle de version (ex. hébergement en ligne) */ }
}

// ---------- Compte (synchronisation) ----------

function updateAcct(st) {
  const ico = $('#acctIco'), lab = $('#acctLabel'), btn = $('#acctBtn');
  if (!ico) return;
  btn.classList.toggle('hidden', st.status === 'unconfigured');
  btn.classList.toggle('on', !!st.user);
  btn.classList.toggle('err', !!st.error);
  if (st.user) {
    ico.innerHTML = st.user.photo ? `<img src="${esc(st.user.photo)}" alt="" referrerpolicy="no-referrer">` : '👤';
    lab.textContent = st.status === 'syncing' || st.pending ? 'Synchro…' : (st.user.name || 'Compte').split(' ')[0];
  } else {
    ico.textContent = '👤';
    lab.textContent = 'Se connecter';
  }
  if (app.view === 'settings') VIEWS.settings.onAcct?.();
}

function openAccount() {
  const st = sync.state;
  const when = st.lastSync ? new Date(st.lastSync).toLocaleTimeString('fr-FR') : '—';
  const m = modal(st.user ? `
    <h2>👤 Ton compte</h2>
    <div class="row" style="gap:12px">
      ${st.user.photo ? `<img src="${esc(st.user.photo)}" alt="" referrerpolicy="no-referrer" style="width:48px;height:48px;border-radius:50%">` : ''}
      <div><b>${esc(st.user.name || '')}</b><br><span class="muted">${esc(st.user.email || '')}</span></div>
    </div>
    <p style="margin-top:14px">${st.status === 'syncing' ? '🔄 Synchronisation en cours…' : st.error ? '⚠️ ' + esc(st.error) : '✅ Synchronisé'} <span class="muted">· dernière synchro ${when}</span></p>
    <p class="muted" style="font-size:.85rem">Pilotes, photos, voitures, réglages du garage, setups d'essence, sessions et records sont sauvegardés sur ton compte et se retrouvent sur tous les appareils où tu te connectes.</p>
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" id="acOut">Se déconnecter</button>
      <button class="btn primary" data-close>Fermer</button>
    </div>` : `
    <h2>👤 Se connecter</h2>
    <p>Connecte-toi avec ton compte Google pour retrouver tes pilotes, records, setups et réglages <b>sur le PC et sur le téléphone</b>, synchronisés automatiquement.</p>
    <p class="muted" style="font-size:.85rem">Tes données restent aussi sur cet appareil : sans internet, l'appli marche comme avant.</p>
    ${st.error ? `<p class="warnbox">${esc(st.error)}</p>` : ''}
    <div class="row" style="justify-content:flex-end">
      <button class="btn ghost" data-close>Plus tard</button>
      <button class="btn primary" id="acIn">Se connecter avec Google</button>
    </div>`);
  const out = m.el.querySelector('#acOut');
  if (out) out.onclick = async () => { await sync.signOut(); m.close(); toast('Déconnecté. Les données restent sur cet appareil.'); };
  const inn = m.el.querySelector('#acIn');
  if (inn) inn.onclick = async () => {
    try { await sync.signIn(); m.close(); toast('Connecté : synchronisation en cours…'); } catch { /* message affiché */ }
  };
}

// ---------- Démarrage ----------

async function init() {
  await db.seed();
  await app.loadData();
  audio.voice = await db.getSetting('voice', true);
  audio.sounds = await db.getSetting('sounds', true);
  app.ghost.settings = { ...app.ghost.settings, ...(await db.getSetting('ghost', {})) };
  app.fuelCfg = sanitize(await db.getSetting('fuel', defaultFuelConfig()));
  // Une seule fois : on installe le réglage équilibré (validé par simulation 50 et 100 tours)
  // et on l'enregistre comme setup nommé.
  if (!(await db.getSetting('fuelBalancedApplied', false))) {
    // "quiet" : ne remplace jamais les réglages d'un compte déjà synchronisé
    await app.saveFuelCfg({ ...app.fuelCfg, ...balancedPreset() }, { quiet: true });
    await app.saveFuelSetup('Équilibré 50/100 tours', null, { quiet: true });
    await db.setSetting('fuelBalancedApplied', true, { quiet: true });
    app.log('Essence : réglage équilibré installé');
  }
  // Setup "Sprint 30 tours" ajouté à la liste (sans changer le réglage en cours)
  if (!(await db.getSetting('fuelSprint30Added', false))) {
    await app.addFuelSetup('Sprint 30 tours', sprint30Preset(), { quiet: true });
    await db.setSetting('fuelSprint30Added', true, { quiet: true });
  }
  app.setup = await db.getSetting('setup', null) || setupView.defaultSetup(app);

  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) app.go(b.dataset.view);
  });
  $('#connBtn').onclick = () => app.openConnectDialog();
  window.addEventListener('hashchange', () => {
    const v = location.hash.slice(1);
    if (v && v !== app.view) app.go(v);
  });

  // Horloge de l'interface
  setInterval(() => {
    app.session?.tick();
    app.refuelTick(200);
    VIEWS[app.view]?.tick?.();
    updateLiveBar();
  }, 200);
  $('#liveBar').onclick = () => app.go('race');
  checkVersion();
  setInterval(checkVersion, 15000);

  app.go(location.hash.slice(1) || 'race'); // accueil : menu Course

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.paddock = app; // pratique pour le débogage

  // Compte : connexion Google et synchronisation entre appareils
  sync.onState(updateAcct);
  updateAcct(sync.state);
  $('#acctBtn').onclick = () => openAccount();
  sync.initSync(app);

  // Records SmartRace à importer (une fois) : on propose la fenêtre d'association
  if (!(await importDone(app))) openImport(app, { onDone: () => app.refresh() });
}

init();

export { TYPES, fmtTime };
