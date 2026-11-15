// Point d'entrée : état global, connexion, cycle de vie des sessions, navigation.

import { ControlUnit } from './cu/controlunit.js';
import { BleConnection, bluetoothSupported } from './cu/ble.js';
import { SimulatorConnection } from './cu/simulator.js';
import { PerformanceEngine, vscModifier } from './performance.js';
import { ChihirosLight } from './devices/chihiros.js';
import { GenericLight } from './devices/generic-light.js';
import { syncLights, resetLightSync } from './devices/lightsync.js';
import { Weather, SKY } from './weather.js';
import { RaceSession, TYPES, fmtTime, fmtClock } from './race.js';
import * as db from './db.js';
import * as sync from './sync.js';
import { defaultFuelConfig, consumption, sanitize, balancedPreset, sprint30Preset } from './fuel.js';
import { audio, beep, say, spokenTime, unlockAudio } from './audio.js';
import { $, $$, esc, toast, modal, confirmBox } from './ui.js';

import * as raceView from './views/race.js';
import * as garageView from './views/garage.js';
import * as driversView from './views/drivers.js';
import * as driverView from './views/driver.js';
import * as ghostView from './views/ghost.js';
import * as quickView from './views/quick.js';
import { openImport, importDone } from './views/import-records.js';
import * as statsView from './views/stats.js';
import * as settingsView from './views/settings.js';

/** Réglages de session par défaut (participants, circuit ; météo gardée en sommeil). */
function defaultSetup(a) {
  return {
    type: 'race',
    mode: 'laps',
    laps: 10,
    duration: 5,
    start: 'lights',
    minLapMs: 1500,
    trackId: a.data.tracks[0]?.id || null,
    weather: { sky: 'sun', dynamic: false, variability: 3, intensity: 1 },
    slots: Array.from({ length: 6 }, (_, i) => ({
      address: i,
      active: i < 2,
      driverId: a.data.drivers[i]?.id || null,
      carId: a.data.cars[i]?.id || null,
      speed: 15,
      brake: 15,
    })),
  };
}

const VIEWS = { race: raceView, garage: garageView, drivers: driversView, driver: driverView, ghost: ghostView, quick: quickView, stats: statsView, settings: settingsView };

const cu = new ControlUnit();
const DEFAULT_TUNE = { speed: 8, brake: 6 }; // réglage d'un couple pilote + voiture jamais joué : ~54 % accélération, 40 % freinage
const DEFAULT_VSC = { speedPct: 20 }; // vitesse fixe imposée à toutes les voitures sous VSC, en % de la vitesse max
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
    this.setup = await db.getSetting('setup', null) || defaultSetup(this);
    this.fuelCfg = sanitize(await db.getSetting('fuel', defaultFuelConfig()));
    this.vscCfg = { ...DEFAULT_VSC, ...(await db.getSetting('vsc', {})) };
    this.lightSync = { enabled: true, ...(await db.getSetting('lightSync', {})) };
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
    // jamais joué (pilote + voiture) : réglage prudent, pour éviter les sorties de piste
    const car = this.car(carId);
    return { speed: DEFAULT_TUNE.speed, brake: DEFAULT_TUNE.brake, fuel: car?.fuelCapacity ?? 15, saved: false };
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
  lights: new ChihirosLight(), // rampe LED Chihiros (Réglages → Appareils connectés → Éclairage)
  extraLights: [],             // autres lampes Bluetooth (Réglages → Appareils connectés → Autres lampes)

  /** Lampes qui reçoivent les scènes de course (celles qui font leur signal de connexion attendent). */
  lightOutputs() {
    const outs = [];
    if (this.lightSync.chihiros && this.lights.connected && !this.lightHello) outs.push(this.lights);
    if (this.lightSync.others) this.extraLights.forEach((l) => { if (l.connected && !l.helloing) outs.push(l); });
    return outs;
  },

  /** Ajoute une lampe trouvée par la recherche (et la garde pour les prochains lancements). */
  addExtraLight(l) {
    this.extraLights = this.extraLights.filter((x) => x.id !== l.id);
    this.extraLights.push(l);
    watchExtraLight(l, true);
    saveExtraLights();
    l.dispatchEvent(new Event('change'));
  },

  removeExtraLight(id) {
    const l = this.extraLights.find((x) => x.id === id);
    l?.disconnect();
    this.extraLights = this.extraLights.filter((x) => x.id !== id);
    saveExtraLights();
  },
  lightSync: { enabled: true, chihiros: false, others: false }, // chihiros : rampe activée (seulement chez qui en a une) ; enabled : elle suit les drapeaux

  async saveLightSync(values) {
    const wasOn = this.lightSync.chihiros;
    const wasOthers = this.lightSync.others;
    this.lightSync = { ...this.lightSync, ...values };
    if ('others' in values && values.others !== wasOthers) {
      if (values.others) this.extraLights.forEach((l) => l.autoConnect().catch(() => {}));
      else this.extraLights.forEach((l) => l.disconnect());
    }
    if ('chihiros' in values && values.chihiros !== wasOn) {
      if (values.chihiros) autoConnectLights();
      else { this.lights.disconnect(); $('#lightBar').classList.add('hidden'); }
    }
    await db.setSetting('lightSync', this.lightSync);
    resetLightSync();
    syncLights(this, { force: true });
  },
  vscCfg: { ...DEFAULT_VSC },

  async saveVscCfg(values) {
    this.vscCfg = { ...this.vscCfg, ...values };
    await db.setSetting('vsc', this.vscCfg);
    perf.update(); // VSC en cours : la nouvelle vitesse s'applique tout de suite
  },

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
  /** La voiture est-elle en panne sèche (essence gérée, réservoir vide, séance en cours) ? */
  isOutOfFuel(address) {
    const c = this.session?.comps.get(address);
    if (!this.fuelOn() || !c || c.fuelPct === null || c.fuelPct > 0) return false;
    return ['running', 'finishing'].includes(this.session.state);
  },

  emptyTankModifier() {
    return {
      id: 'fuel',
      label: 'Panne sèche',
      compute: (address) => {
        if (!this.isOutOfFuel(address)) return null;
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
    // essais libres / qualification : un participant retiré à la main n'est jamais rajouté
    const noAuto = ['practice', 'qualifying'].includes(this.setup?.prepMode || this.quickMode);
    if (slot && !slot.active && !noAuto) {
      slot.active = true;
      this.saveSetup();
      this.applyTune(address);
      const who = this.driver(slot.driverId)?.name;
      toast(`🏎️ Manette ${address + 1} détectée en piste${who ? ' — ' + who : ''}`);
      this.log(`Manette ${address + 1} détectée en piste`);
      if (['garage', 'quick'].includes(this.view)) VIEWS[this.view].refresh?.();
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
    const tab = view === 'driver' ? 'drivers' : view === 'quick' ? 'race' : view; // la fiche pilote dépend de l'onglet Pilotes
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === tab));
    window.scrollTo(0, 0);
    const main = $('#main');
    main.innerHTML = '';
    VIEWS[view].mount(main, this);
    if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view);
    this.updateTabsLock();
  },

  /**
   * Écran de session (course, essais, qualif) et son garage : seuls Course et Garage
   * restent accessibles. On en sort par la maison (retour au menu).
   */
  updateTabsLock() {
    const locked = !!this.session && !this.raceMenu && ['race', 'garage'].includes(this.view);
    document.body.classList.toggle('session-lock', locked);
    const label = $('#tabs [data-view="race"] span');
    if (label) label.textContent = locked ? 'Course' : 'Menu';
    const ico = $('#tabs [data-view="race"] i');
    if (ico) ico.textContent = locked ? '🏁' : '🏠'; // même maison que sur l'écran de course
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
      type: opts.type || 'race', laps: opts.laps, start: 'lights',
      // essais / qualif : au temps (minutes) ; course : aux tours
      mode: opts.minutes ? 'time' : 'laps', duration: opts.minutes || 0,
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
    perf.removeModifier('vsc');
    perf.addModifier(vscModifier(() => this.session?.flag, () => this.vscCfg.speedPct, (a) => perf.bases.get(a)?.speed, (a) => this.isOutOfFuel(a)));
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
        // quitté par la maison : pas de fenêtre de résultats, on est déjà au menu
        if (session._quit) return;
        raceView.showResults?.(this);
      }
    });
  },

  /** Maison de l'écran de course : arrête la session en cours (après confirmation) et revient au menu. */
  async quitToMenu() {
    const s = this.session;
    if (s && ['armed', 'running', 'finishing'].includes(s.state)) {
      const ok = await confirmBox('Cette action entraîne l\'arrêt de la session en cours. Êtes-vous sûr ?');
      if (!ok) return;
      s._quit = true;
      s.stop();
    }
    this.raceMenu = true;
    this.go('race');
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
      if (left === 2 && !s._twoLapsDone) {
        // à deux tours de l'arrivée : annonce vocale
        s._twoLapsDone = true;
        say('Deux tours restants', { priority: true });
      }
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

  /**
   * Drapeau rouge : appui sur START de la Control Unit, qui coupe le courant de la piste
   * (toutes les voitures s'arrêtent). Second appui : la CU relance les feux et la course repart.
   */
  async toggleRed() {
    const s = this.session;
    if (!s || !['running', 'finishing'].includes(s.state)) return;
    if (s.flag !== 'red') {
      this.cancelVscCountdown();
      if (s.flag === 'vsc') this.vscResendUntil = performance.now() + 5000;
      if (s.flag === 'vsc') { s.setFlag('green'); perf.update(); }
      s.redFlag();
      await cu.pressStart();
      say('Drapeau rouge ! Tout le monde s\'arrête', { priority: true });
    } else if (!s.redResuming) {
      s.resumeFromRed();
      await cu.pressStart();
      // certaines CU demandent un 2e appui pour lancer la séquence des feux
      setTimeout(() => { if (s.flag === 'red' && s.redResuming && cu.status?.start === 1) cu.pressStart(); }, 1500);
      say('Reprise de la course, attention aux feux', { priority: true });
    }
  },

  /** Virtual Safety Car : toutes les voitures bridées à un % de leur vitesse max. */
  toggleVsc() {
    const s = this.session;
    if (!s || !['running', 'finishing'].includes(s.state) || s.flag === 'red') return;
    if (s.vscCountdown) return; // décompte déjà lancé
    if (s.flag !== 'vsc') {
      s.setFlag('vsc');
      perf.update();
      say('Virtual Safety Car ! Vitesse limitée', { priority: true });
      return;
    }
    // Fin du VSC : décompte de 3 secondes (affiché et annoncé), puis vitesse normale
    // « Fin de VSC dans… » puis 3, 2, 1, Go à une seconde d'intervalle,
    // chaque chiffre avec le même bip que les feux de départ de la Control Unit
    const steps = [
      { n: '…', text: 'Fin de VSC dans', at: 0 },
      { n: 3, text: '3', at: 1300 },
      { n: 2, text: '2', at: 2300 },
      { n: 1, text: '1', at: 3300 },
      { n: 0, text: 'Go !', at: 4300 },
    ];
    s.vscCountdown = '…';
    s.emit('update');
    s._vscTimers = steps.map((st) => setTimeout(() => {
      // annulé entre-temps (drapeau rouge, fin de session…)
      if (s.flag !== 'vsc' || !['running', 'finishing'].includes(s.state)) { this.cancelVscCountdown(); return; }
      say(st.text, { priority: true });
      if (typeof st.n === 'number') beep(st.n ? 660 : 990, st.n ? 220 : 500);
      s.vscCountdown = st.n;
      if (st.n === 0) {
        s.vscCountdown = null;
        s.setFlag('green');
        perf.update();
        this.vscResendUntil = performance.now() + 5000; // voiture sortie pendant le VSC : elle retrouve aussi sa vitesse
      }
      s.emit('update');
    }, st.at));
  },

  cancelVscCountdown() {
    const s = this.session;
    if (!s) return;
    (s._vscTimers || []).forEach(clearTimeout);
    s._vscTimers = null;
    s.vscCountdown = null;
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
// Diagnostic du départ : valeurs « feux » de la CU et leurs instants, enregistrés
// pour caler précisément l'extinction des feux (réglage startSeq, synchronisé)
let startSeq = null;
function recordStart(v) {
  const s = app.session;
  const now = performance.now();
  if (!startSeq && s?.state === 'armed') {
    startSeq = { t0: now, steps: [], firstLap: null, goAt: null };
    setTimeout(saveStartSeq, 30000); // filet : enregistré même sans passage
  }
  if (!startSeq) return;
  startSeq.steps.push({ v, t: Math.round(now - startSeq.t0) });
  if (s?.state === 'running' && startSeq.goAt === null) startSeq.goAt = Math.round(s.startedAt - startSeq.t0);
}
function saveStartSeq() {
  if (!startSeq) return;
  const s = app.session;
  if (s?.startedAt && startSeq.goAt === null) startSeq.goAt = Math.round(s.startedAt - startSeq.t0);
  const rec = { at: new Date().toISOString(), version: cu.version, sim: app.isSim, ...startSeq };
  delete rec.t0;
  db.setSetting('startSeq', rec);
  app.log('Départ enregistré : ' + rec.steps.map((x) => `${x.v}@${x.t}`).join(' ') + ` | départ appli @${rec.goAt} | 1er passage @${rec.firstLap}`);
  startSeq = null;
}
cu.addEventListener('status', (e) => {
  const st = e.detail;
  if (st.start !== lastStart) {
    if (st.start >= 2 && st.start <= 6) beep(660, 220);
    lastStart = st.start;
    recordStart(st.start);
  }
  app.session?.onStatus(st);
  syncLights(app); // éclairage : réagit dès que la CU change d'état (feux, départ)
});

cu.addEventListener('timer', (e) => {
  const t = e.detail;
  if (startSeq && startSeq.firstLap === null && t.address <= 5) {
    startSeq.firstLap = Math.round(performance.now() - startSeq.t0); // 1er passage après le départ
    setTimeout(saveStartSeq, 1500);
  }
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

// ---------- Autres lampes Bluetooth ----------
const EXTRA_KEY = 'paddock.extraLights'; // gardées sur ce téléphone (les lampes y sont appairées)
function saveExtraLights() {
  try { localStorage.setItem(EXTRA_KEY, JSON.stringify(app.extraLights.map((l) => l.toJSON()))); } catch { /* ignore */ }
}
/** Une lampe qui se connecte fait 2 clignotements, puis prend la couleur de la séance. */
function watchExtraLight(l, fresh = false) {
  if (l._watched) return;
  l._watched = true;
  let wasOn = fresh ? false : l.connected; // fresh : lampe tout juste ajoutée (elle fait son signal)
  l.addEventListener('change', async () => {
    if (l.connected && !wasOn) {
      wasOn = true;
      try { await l.hello(); } catch { /* ignore */ }
      resetLightSync();
      syncLights(app, { force: true });
    } else if (!l.connected) wasOn = false;
  });
}

// ---------- Rampe LED : connexion automatique au lancement ----------
// La rampe déjà choisie une fois se reconnecte seule. Si le navigateur ne le
// permet pas, un bandeau propose de la reconnecter d'un seul appui.
export async function autoConnectLights() {
  const L = app.lights;
  let r = 'none';
  try { r = await L.autoConnect(); } catch { r = L.savedName ? 'unsupported' : 'none'; }
  app.log(`Rampe LED au lancement : ${r}${L.savedName ? ' (' + L.savedName + ')' : ''}`);
  if (r === 'on') { toast(`💡 Rampe connectée : ${L.name}`); return; }
  if (r === 'none') return; // aucune rampe utilisée jusqu'ici
  // pas connectée tout de suite (navigateur qui demande un appui, rampe éteinte…) :
  // on continue d'essayer en arrière-plan ET on propose de la connecter d'un appui
  const bar = $('#lightBar');
  const name = L.savedName || L.name;
  bar.innerHTML = `<span>💡</span><span>Rampe ${esc(name || '')} non connectée</span><b>Connecter</b>`;
  bar.classList.remove('hidden');
  bar.onclick = async () => {
    try {
      // un appui permet souvent de rouvrir la rampe déjà autorisée ; sinon on la redemande
      if (L.device) { try { await L.reconnect(); } catch { await L.connect({ name }); } } else await L.connect({ name });
      toast('💡 Rampe connectée');
      bar.classList.add('hidden');
    } catch (e) { toast(e.message || String(e), 3000); }
  };
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
  app.fuelCfg = sanitize(await db.getSetting('fuel', defaultFuelConfig()));
  app.vscCfg = { ...DEFAULT_VSC, ...(await db.getSetting('vsc', {})) };
  app.lightSync = { enabled: true, ...(await db.getSetting('lightSync', {})) };
  // rampe qui (re)vient : elle reprend tout de suite la couleur de la séance
  let lightWasOn = false;
  app.lights.addEventListener('change', async () => {
    const on = app.lights.connected;
    if (on && !lightWasOn) {
      // vient de se connecter : 2 clignotements pour le signaler, puis la couleur de la séance
      lightWasOn = true;
      $('#lightBar').classList.add('hidden');
      app.lightHello = true;
      try { await app.lights.hello(); } catch { /* ignore */ }
      app.lightHello = false;
      resetLightSync();
      syncLights(app, { force: true });
    } else if (!on) lightWasOn = false;
  });
  if (app.lightSync.chihiros) autoConnectLights(); // rampe activée dans Réglages → Éclairage
  // autres lampes déjà ajoutées : reconnexion automatique quand le navigateur le permet
  let savedLights = [];
  try { savedLights = JSON.parse(localStorage.getItem(EXTRA_KEY) || '[]'); } catch { /* ignore */ }
  app.extraLights = savedLights.map((x) => new GenericLight(x));
  app.extraLights.forEach((l) => { watchExtraLight(l); if (app.lightSync.others) l.autoConnect().catch(() => {}); });
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
  app.setup = await db.getSetting('setup', null) || defaultSetup(app);

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
  // VSC : vitesse renvoyée 2 fois par seconde tant qu'il est actif (et 5 s après),
  // pour qu'une voiture remise en piste prenne aussi la bonne vitesse
  setInterval(() => {
    const s = app.session;
    if (!s || !cu.connected || !['running', 'finishing'].includes(s.state)) return;
    if (s.flag === 'vsc' || performance.now() < (app.vscResendUntil || 0)) perf.resendSpeeds();
  }, 500);
  // Éclairage : la rampe prend la couleur du drapeau en cours
  setInterval(() => syncLights(app), 100); // 100 ms : alternances régulières
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
