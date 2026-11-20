// Point d'entrée : état global, connexion, cycle de vie des sessions, navigation.

import { ControlUnit } from './cu/controlunit.js';
import { APP_VERSION } from './version.js';
import { cranFor } from './vsc-cal.js';

// feuille de style rechargée à chaque nouvelle version (sinon un téléphone peut garder l'ancienne)
{
  const css = document.querySelector('link[rel="stylesheet"][href^="css/app.css"]');
  if (css && !css.getAttribute('href').endsWith('v=' + APP_VERSION)) css.setAttribute('href', 'css/app.css?v=' + APP_VERSION);
}
import { BleConnection, bluetoothSupported } from './cu/ble.js';
import { SimulatorConnection } from './cu/simulator.js';
import { PerformanceEngine, vscModifier, vscSpeed } from './performance.js';
import { ChihirosLight } from './devices/chihiros.js';
import { checkAutoVsc, shouldEndVsc } from './autovsc.js';
import { GenericLight } from './devices/generic-light.js';
import { syncLights, resetLightSync } from './devices/lightsync.js';
import { Weather, SKY } from './weather.js';
import { RaceSession, TYPES, fmtTime, fmtClock } from './race.js';
import * as db from './db.js';
import * as sync from './sync.js';
import { defaultFuelConfig, consumption, sanitize, balancedPreset, sprint30Preset } from './fuel.js';
import { audio, beep, say, spokenTime, unlockAudio } from './audio.js';
import { $, $$, esc, toast, modal, confirmBox, keepScreenOn } from './ui.js';

import * as raceView from './views/race.js';
import * as garageView from './views/garage.js';
import * as driversView from './views/drivers.js';
import * as driverView from './views/driver.js';
import * as ghostView from './views/ghost.js';
import * as quickView from './views/quick.js';
import { openImport, importDone } from './views/import-records.js';
import * as statsView from './views/stats.js';
import { rotate as rotateMemos, slimSession } from './memo.js';
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
/**
 * Fonctions en cours de développement : réglables dans Réglages et au Garage,
 * mais jamais utilisées en jeu tant qu'elles valent false.
 */
export const IN_GAME = { vscAdaptive: true }; // VSC adaptatif remis en course (v1.85)

// Pénalité : à l'arrêt au stand, la voiture reste immobile `sec` secondes avant qu'on la touche (essence)
export const DEFAULT_PENALTY = { sec: 5 };
const penaltyOf = (v) => ({ sec: Math.max(1, Math.min(60, Math.round(+v?.sec || DEFAULT_PENALTY.sec))) });
const DEFAULT_VSC = { speedPct: 20, adaptive: { on: false, targetSec: 8 } }; // vitesse fixe imposée à toutes les voitures sous VSC, en % de la vitesse max
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
    this.penaltyCfg = penaltyOf(await db.getSetting('penalty', {}));
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

  /**
   * Parc fermé : avec « Essence selon le poids », la vitesse des voitures ne peut plus être
   * modifiée à la main après le Go (ni au garage, ni depuis la vue pilote), jusqu'à l'arrivée.
   */
  parcFerme() {
    const s = this.session;
    return !!(this.fuelCfg.weight?.on && this.fuelOn() && s && s.cfg.type === 'race' && ['running', 'finishing'].includes(s.state));
  },

  async saveTune(driverId, carId, values) {
    if (this.parcFerme() && 'speed' in values) {
      values = { ...values };
      delete values.speed;
      toast('🔒 Parc fermé : la vitesse ne peut plus être modifiée pendant la course', 2500);
      if (!Object.keys(values).length) return false;
    }
    const id = this.tuneId(driverId, carId);
    const t = { ...this.getTune(driverId, carId), ...values, id, driverId, carId, updated: Date.now() };
    delete t.saved;
    this.data.tunes.set(id, t);
    await db.put('tunes', t);
    // applique tout de suite aux manettes qui utilisent ce couple
    (this.setup?.slots || [])
      .filter((s) => s.active && s.driverId === driverId && s.carId === carId)
      .forEach((s) => this.applyTune(s.address, Object.keys(values)));
    return true;
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
    if (keys.includes('fuel') && cu.connected && !this.isRacing) cu.setFuel(address, this.tankFor(t.fuel)); // selon le temps au tour : plein
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
      if (reset || comp.fuelPct === null) this.fillTank(comp, this.tankFor(t.fuel));
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
  lights: new ChihirosLight(), // rampe LED Chihiros (Réglages → Éclairage connecté → Chihiros)
  extraLights: [],             // autres lampes Bluetooth (Réglages → Éclairage connecté → Autres lampes)

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
    updateExtraBar();
  },
  lightSync: { enabled: true, chihiros: false, others: false }, // chihiros : rampe activée (seulement chez qui en a une) ; enabled : elle suit les drapeaux

  async saveLightSync(values) {
    const wasOn = this.lightSync.chihiros;
    const wasOthers = this.lightSync.others;
    this.lightSync = { ...this.lightSync, ...values };
    if ('others' in values && values.others !== wasOthers) {
      if (values.others) autoConnectExtras();
      else { this.extraLights.forEach((l) => l.disconnect()); updateExtraBar(); }
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

  /**
   * VSC adaptatif : cran de cette voiture pour rouler au temps cible (étalonnage du garage,
   * sur le circuit de la séance). null = pas d'adaptatif, ou voiture pas étalonnée ici :
   * elle reçoit alors le VSC normal (même cran pour tous).
   */
  vscTargetFor(address) {
    const a = this.vscCfg.adaptive;
    const s = this.session;
    if (!IN_GAME.vscAdaptive || !a?.on || !s) return null;
    const c = s.comps.get(address);
    const car = c?.car?.id && this.car(c.car.id);
    const r = car && cranFor(car, s.trackId, a.targetSec);
    return r ? r.cran : null;
  },

  penaltyCfg: { ...DEFAULT_PENALTY },

  async savePenaltyCfg(values) {
    this.penaltyCfg = penaltyOf({ ...this.penaltyCfg, ...values });
    await db.setSetting('penalty', this.penaltyCfg);
  },

  /**
   * Pénalité (comme en F1) : à son prochain arrêt au stand, la voiture reste immobile la durée
   * de la pénalité avant qu'on y touche (pas d'essence pendant ce temps). Plusieurs pénalités
   * s'additionnent. Repartir avant la fin : la pénalité reste entière pour l'arrêt suivant.
   */
  givePenalty(address) {
    const s = this.session;
    const c = s?.comps.get(address);
    if (!c || !['running', 'finishing'].includes(s.state)) return;
    const sec = this.penaltyCfg.sec;
    c.penalty = (c.penalty || 0) + sec;
    c.penalties = (c.penalties || 0) + 1;
    c._penSince = null;
    const name = c.driver?.name || `Voiture ${c.address + 1}`;
    say(`${name}, pénalité de ${c.penalty} secondes`, { priority: true });
    toast(`⚠️ ${name} : pénalité de ${c.penalty} s`, 2500);
    this.log(`Pénalité : ${name} (${c.penalty} s à faire au stand)`);
    s.emit('update');
  },

  /** Retire la pénalité en attente (erreur de la direction de course). */
  clearPenalty(address) {
    const s = this.session;
    const c = s?.comps.get(address);
    if (!c?.penalty) return;
    c.penalty = 0;
    c._penSince = null;
    this.log(`Pénalité retirée : ${c.driver?.name}`);
    toast(`Pénalité retirée : ${c.driver?.name || ''}`, 1500);
    s.emit('update');
  },

  /** Pénalité en attente : { sec, left (s), serving (en train d'être purgée au stand) } ou null. */
  penaltyState(c) {
    if (!c?.penalty) return null;
    const serving = c.inPit && c._penSince != null;
    const left = serving ? Math.max(0, c.penalty - (performance.now() - c._penSince) / 1000) : c.penalty;
    return { sec: c.penalty, left, serving };
  },

  /** Purge des pénalités : voiture immobile dans la voie des stands assez longtemps. */
  penaltyTick() {
    const s = this.session;
    if (!s || !['running', 'finishing'].includes(s.state)) return;
    const now = performance.now();
    for (const c of s.comps.values()) {
      if (!c.penalty) continue;
      if (!c.inPit) {
        if (c._penSince != null) { c._penSince = null; s.emit('update'); } // reparti trop tôt : tout est à refaire
        continue;
      }
      if (c._penSince == null) { c._penSince = now; s.emit('update'); continue; }
      if (now - c._penSince >= c.penalty * 1000) {
        const name = c.driver?.name || `Voiture ${c.address + 1}`;
        c.penalty = 0;
        c._penSince = null;
        say(`${name}, pénalité purgée`);
        this.log(`Pénalité purgée : ${name}`);
        s.emit('update');
      }
    }
  },

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

  openAutoVscSettings() {
    settingsView.openAutoVsc();
    this.go('settings');
  },

  openButtonVscSettings() {
    settingsView.openButtonVsc();
    this.go('settings');
  },

  openAdaptiveVscSettings() {
    settingsView.openAdaptiveVsc();
    this.go('settings');
  },

  openFuelSettings(tab) {
    settingsView.openFuel(tab);
    this.go('settings');
  },

  async saveFuelCfg(cfg, opts = {}) {
    this.fuelCfg = sanitize(cfg);
    await db.setSetting('fuel', this.fuelCfg, opts);
  },

  // ---------- Setups d'essence (réglages nommés) ----------
  // Un setup = toute la config essence sauf l'interrupteur "activer".

  /** Mode d'un setup : 'curve' (formule continue) ou 'bands' (temps de référence). */
  setupMode(s) {
    return s?.cfg?.mode === 'curve' ? 'curve' : 'bands';
  },

  /** Setup actif, gardé séparément pour chaque mode. */
  activeSetupKey(mode) {
    return mode === 'curve' ? 'fuelActiveSetupCurve' : 'fuelActiveSetup';
  },

  async activeFuelSetup(mode) {
    return db.getSetting(this.activeSetupKey(mode), null);
  },

  /** Setups enregistrés : tous, ou seulement ceux d'un mode ('bands' / 'curve'). */
  async fuelSetups(mode = null) {
    const all = await db.getSetting('fuelSetups', []);
    return mode ? all.filter((s) => this.setupMode(s) === mode) : all;
  },

  /** Enregistre le réglage actuel comme setup du mode donné (Temps de référence ou Formule continue). */
  async saveFuelSetup(name, id = null, opts = {}, mode = null) {
    const list = await this.fuelSetups();
    const { enabled, ...cfg } = this.fuelCfg;
    if (mode) cfg.mode = mode;
    const m = this.setupMode({ cfg });
    const existing = id ? list.find((s) => s.id === id)
      : list.find((s) => s.name.toLowerCase() === name.toLowerCase() && this.setupMode(s) === m);
    if (existing) Object.assign(existing, { name, cfg, date: Date.now() });
    else list.push({ id: db.uid(), name, cfg, date: Date.now() });
    await db.setSetting('fuelSetups', list, opts);
    await db.setSetting(this.activeSetupKey(m), existing?.id ?? list[list.length - 1].id, opts);
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
    // « Essence selon le poids » est un réglage général : un setup chargé ne le change pas
    await this.saveFuelCfg({ ...s.cfg, enabled: this.fuelCfg.enabled, weight: this.fuelCfg.weight });
    await db.setSetting(this.activeSetupKey(this.setupMode(s)), id);
    return true;
  },

  async deleteFuelSetup(id) {
    const list = (await this.fuelSetups()).filter((s) => s.id !== id);
    await db.setSetting('fuelSetups', list);
    for (const k of ['fuelActiveSetup', 'fuelActiveSetupCurve']) if ((await db.getSetting(k, null)) === id) await db.setSetting(k, null);
  },

  async renameFuelSetup(id, name) {
    const list = await this.fuelSetups();
    const s = list.find((x) => x.id === id);
    if (s) { s.name = name; await db.setSetting('fuelSetups', list); }
  },

  /** Remplit le réservoir d'une voiture (valeur garage 0..15 -> %). */
  /**
   * Réservoir (0-15) d'une voiture pour la séance : en calcul « selon le temps au tour »,
   * toujours le plein (100 %), car les réglages d'essence sont calculés sur un plein de 100 % ;
   * sinon la valeur demandée (réservoir commun de la préparation, ou celui du garage).
   */
  tankFor(tank15) {
    return this.fuelCfg.mode === 'fixed' ? tank15 : 15;
  },

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

  /**
   * Essence selon le poids : réservoir de 80 à 100 % → X crans de moins que la vitesse réglée,
   * de 30 à 80 % → vitesse réglée, sous 30 % → X crans de plus (bornée à 15).
   * Jamais plus lente que la vitesse de panne sèche (sinon une voiture réglée bas resterait à 0).
   * Appliqué dès la grille (feux), pour que le départ se fasse déjà à la bonne vitesse.
   * Sous VSC et en panne sèche, la vitesse imposée l'emporte.
   */
  fuelWeightStep(address) {
    const s = this.session;
    const w = this.fuelCfg.weight;
    if (!w?.on || !this.fuelOn() || !s || !['armed', 'running', 'finishing'].includes(s.state)) return 0;
    if (s.cfg.type !== 'race') return 0; // désactivé en qualification et en essais libres
    const c = s.comps.get(address);
    if (!c || c.fuelPct === null || c.fuelPct === undefined || c.fuelPct <= 0) return 0;
    const ratio = (c.fuelPct / (c.tankPct || 100)) * 100; // % de SON réservoir
    if (ratio >= 80) return -1; // plein : 1 cran de moins (non réglable)
    if (ratio < 30) return 1;   // presque vide : 1 cran de plus
    return 0;
  },

  weightModifier() {
    return {
      id: 'weight',
      label: "Poids de l'essence",
      compute: (address) => {
        const step = this.fuelWeightStep(address);
        if (!step || this.session?.flag === 'vsc' || this.isOutOfFuel(address)) return null;
        const base = perf.bases.get(address)?.speed;
        if (!base) return null;
        // plancher : la vitesse de panne sèche (ou la vitesse réglée si elle est déjà plus basse)
        const floor = Math.min(base, this.fuelCfg.emptySpeedFixed);
        const target = Math.max(floor, Math.min(15, base + step));
        if (target === base) return null;
        return { speed: target / base, note: step < 0 ? `⛽ Réservoir lourd (${step} cran${step < -1 ? 's' : ''})` : `⛽ Réservoir léger (+${step} cran${step > 1 ? 's' : ''})` };
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
    comp.fuelUsed = (comp.fuelUsed || 0) + pct; // total consommé (page de fin de course)
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
    if (this.fuelCfg.weight?.on) perf.update(); // poids : nouveau cran dès le passage d'un seuil
    return pct;
  },

  /** Ravitaillement : appelé en continu ; remplit les voitures qui sont au stand. */
  refuelTick(dtMs) {
    const s = this.session;
    if (!s || !this.fuelOn() || !['running', 'finishing'].includes(s.state)) return;
    for (const c of s.comps.values()) {
      if (!c.inPit || c.fuelPct === null || c.fuelPct >= c.tankPct) continue;
      if (c.penalty) continue; // pénalité en cours : personne ne touche la voiture
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
    // détection automatique dans tous les modes : une voiture qui passe la ligne ajoute sa
    // manette aux participants, quel que soit le mode (course, qualification, essais libres)
    if (slot && !slot.active) {
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

  /** Texte de diagnostic de la connexion (à envoyer pour comprendre un souci). */
  diagnosticText() {
    const c = cu.conn;
    const p = c?.out?.properties;
    const lines = [
      '=== Diagnostic Paddock v' + APP_VERSION + ' ===',
      'Date : ' + new Date().toLocaleString('fr-FR'),
      'Navigateur : ' + navigator.userAgent,
      'Connexion : ' + (c ? `${c.kind} · ${c.name}` : 'aucune') + (cu.reconnecting ? ' (reconnexion en cours)' : ''),
      'Version Control Unit : ' + (cu.version || 'inconnue'),
      c?.modeLabel ? 'Liaison : ' + c.modeLabel : null,
      p ? `Écriture possible : avec accusé ${p.write ? 'oui' : 'non'}, sans réponse ${p.writeWithoutResponse ? 'oui' : 'non'} · lecture ${c.notify?.properties?.read ? 'oui' : 'non'}, notifications ${c.notify?.properties?.notify ? 'oui' : 'non'}` : null,
      `Échanges : ${cu.stats.requests} · erreurs : ${cu.stats.errors} · passages : ${cu.stats.timers}`,
      cu.counts ? 'Réponses : ' + Object.entries(cu.counts).map(([k, v]) => `${k} ${v}`).join(', ') : null,
      cu.status ? `Dernier état : feux ${cu.status.start}, mode ${cu.status.mode}` : null,
      '',
      '--- Dernières réponses brutes du circuit ---',
      ...(cu.trace || []).map((t) => `${t.time}  ${JSON.stringify(t.raw)}  → ${t.desc}`),
      '',
      '--- Journal (30 dernières lignes) ---',
      ...this.logLines.slice(-30),
    ];
    return lines.filter((l) => l !== null).join('\n');
  },

  /** Copie le diagnostic (ou l'affiche à copier à la main si la copie est refusée). */
  async copyDiagnostic() {
    const text = this.diagnosticText();
    try {
      await navigator.clipboard.writeText(text);
      toast('📋 Diagnostic copié : colle-le dans un message', 2500);
    } catch {
      const m = modal(`<h2>Diagnostic</h2>
        <p class="muted" style="font-size:.85rem">Sélectionne tout le texte et copie-le.</p>
        <textarea readonly style="width:100%;height:260px;font-size:.75rem">${esc(text)}</textarea>
        <div class="row" style="justify-content:flex-end;margin-top:8px"><button class="btn ghost" data-close>Fermer</button></div>`);
      const ta = m.el.querySelector('textarea');
      ta.focus(); ta.select();
    }
  },

  /**
   * Circuit (ou simulateur) obligatoire avant d'aller plus loin : s'il est connecté, on
   * continue tout de suite ; sinon la fenêtre de connexion s'ouvre et on continue dès que
   * la connexion est faite (rien si on annule).
   */
  requireConnection(next, reason = 'Connecte le circuit (ou le simulateur) pour continuer.') {
    if (cu.conn && cu.running) { next(); return; }
    this._afterConnect = next;
    this.openConnectDialog({ reason });
  },

  openConnectDialog({ reason } = {}) {
    if (cu.conn) {
      const m = modal(`
        <h2>${cu.reconnecting ? 'Reconnexion en cours…' : 'Connecté'} : ${esc(cu.conn.name)}</h2>
        <p class="muted">Version Control Unit : ${esc(cu.version || 'inconnue')}</p>
        <p class="muted num" id="cuLive"></p>
        <p class="muted" id="cuMode" style="font-size:.8rem"></p>
        <pre class="cu-log" id="cuLog"></pre>
        <div class="row" style="justify-content:flex-end;flex-wrap:wrap">
          <button class="btn ghost" id="diagBtn">📋 Copier le diagnostic</button>
          <button class="btn ghost" data-close>Fermer</button>
          <button class="btn primary" id="discBtn">Déconnecter</button>
        </div>`, { onClose: () => clearInterval(live) });
      m.el.querySelector('#diagBtn').onclick = () => this.copyDiagnostic();
      const upd = () => {
        const el = m.el.querySelector('#cuLive');
        if (el) el.textContent = `Échanges : ${cu.stats.requests} · erreurs : ${cu.stats.errors} · passages : ${cu.stats.timers}`;
        const md = m.el.querySelector('#cuMode');
        if (md) md.textContent = cu.conn?.modeLabel ? 'Liaison : ' + cu.conn.modeLabel : '';
        // dernières lignes du journal : utiles pour comprendre un souci de connexion
        const lg = m.el.querySelector('#cuLog');
        if (lg) lg.textContent = this.logLines.slice(-6).join('\n');
      };
      const live = setInterval(upd, 300);
      upd();
      m.el.querySelector('#discBtn').onclick = async () => { m.close(); await cu.disconnect(); };
      return;
    }
    const bt = bluetoothSupported();
    const m = modal(`
      <h2>Connexion au circuit</h2>
      ${reason ? `<p class="warnbox" style="margin:-4px 0 12px">${esc(reason)}</p>` : ''}
      ${/SamsungBrowser/i.test(navigator.userAgent) ? '<p class="warnbox" style="margin:-4px 0 12px">📱 Tu utilises <b>Samsung Internet</b> : le Bluetooth y fonctionne mal avec le circuit. Ouvre Paddock dans <b>Google Chrome</b> pour te connecter.</p>' : ''}
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
      <div class="row" style="justify-content:flex-end;margin-top:12px">
        ${this.logLines.length ? '<button class="btn ghost" id="diagBtn">📋 Copier le diagnostic</button>' : ''}
        <button class="btn ghost" data-close>Annuler</button></div>`, {
      // fermée sans choisir de connexion : on ne va pas plus loin
      onClose: () => { if (!chosen) this._afterConnect = null; },
    });
    let chosen = false;
    m.el.querySelectorAll('.choice button').forEach((b) => b.addEventListener('click', () => { chosen = true; }, true));
    const dg = m.el.querySelector('#diagBtn');
    if (dg) dg.onclick = () => this.copyDiagnostic();
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
      // connexion demandée avant d'entrer dans un mode de jeu ou au garage : on y va
      const next = this._afterConnect;
      this._afterConnect = null;
      next?.();
    } catch (e) {
      setConn('', 'Non connecté');
      this._afterConnect = null;
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
      kind: opts.kind, // quick | race | practice | qualifying (écran choisi au menu)
      autoVsc: opts.autoVsc !== false, // case « VSC automatique » de la préparation
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
      kind: s.kind,
      autoVsc: s.autoVsc,
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
    perf.addModifier(vscModifier(() => this.session?.flag, () => this.vscCfg.speedPct, (a) => perf.bases.get(a)?.speed, (a) => this.isOutOfFuel(a), (a) => this.vscTargetFor(a)));
    perf.removeModifier('fuel');
    perf.addModifier(this.emptyTankModifier());
    perf.removeModifier('weight');
    perf.addModifier(this.weightModifier());
    entries.forEach((e) => perf.setBase(e.address, e.car.speed, e.car.brake));
    this.calibrateSim();
    // Essence : chaque voiture part avec son réservoir du garage,
    // ou avec le réservoir commun choisi pour la course rapide
    const tankOf = (c) => this.tankFor(s.fuel?.tank15 ?? this.getTune(c.driver.id, c.car.id).fuel);
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
      // course au temps : le premier à passer la ligne n'est pas forcément le vainqueur → pas d'annonce
      if (c.finishPos === 1 && !(session.cfg.type === 'race' && session.cfg.mode === 'time')) {
        say(session.cfg.type === 'race'
          ? `Drapeau à damier ! Victoire de ${c.driver.name}`
          : `Fin de la session. ${c.driver.name} termine premier`, { priority: true });
      }
    });
    // reprise après drapeau rouge : même bip aigu qu'au départ
    session.addEventListener('flag', (e) => {
      if (e.detail?.resumed) {
        beep(1320, 500); // juste le bip, sans voix
        cu.urgent(); perf.resendSpeeds(); // 2e envoi de la vitesse normale, CU repartie
      }
    });
    // voiture ajoutée en cours de séance (détection auto) : elle suit les mêmes règles
    // que les autres (VSC, essence, garage…)
    session.addEventListener('join', (e) => {
      const c = e.detail.comp;
      const slot = this.setup?.slots?.[c.address];
      if (slot?.driverId && this.driver(slot.driverId)) c.driver = this.driver(slot.driverId);
      if (slot?.carId && this.car(slot.carId)) c.car = { ...this.car(slot.carId) };
      const t = this.getTune(c.driver?.id, c.car?.id);
      c.car.speed = t.speed;
      c.car.brake = t.brake;
      if (session.cfg.fuel?.enabled ?? this.fuelOn()) {
        const tank = this.tankFor(session.cfg.fuel?.tank15 ?? t.fuel);
        this.fillTank(c, tank);
        if (cu.connected) cu.setFuel(c.address, tank); // réservoir de la Control Unit recalé aussi
      }
      perf.setBase(c.address, t.speed, t.brake); // bridage VSC, panne sèche… s'appliquent aussi
      this.log(`Manette ${c.address + 1} ajoutée en cours de séance`);
    });
    // faux départ : la CU a coupé la séquence des feux
    session.addEventListener('falsestart', () => {
      // la voix « Faux départ » est dite quand le bouton « Nouvelle relance » apparaît (écran de course)
      toast('⚠️ Faux départ : appuie sur « Nouvelle relance »', 5000);
      this.log('Faux départ détecté pendant les feux');
    });
    // course arrêtée par la CU après le départ : drapeau rouge, on relance avec « Reprendre »
    session.addEventListener('halt', () => {
      say('Faux départ', { priority: true });
      toast('🚩 Course arrêtée par la Control Unit : appuie sur « Reprendre la course »', 6000);
      this.log('La Control Unit a arrêté la course (faux départ ?) : drapeau rouge');
    });
    session.addEventListener('pit', (e) => {
      if (e.detail.in) this.log(`${e.detail.comp.driver.name} entre au stand`);
    });
    session.addEventListener('state', async (e) => {
      const st = e.detail.state;
      this.log('Session : ' + ({ armed: 'feux en cours', running: 'départ donné', finishing: 'dernier tour', finished: 'terminée' }[st] || st));
      // GO : 2e envoi du plein (selon le temps au tour), voitures posées sur la grille
      if (st === 'armed' && cu.connected && this.fuelOn() && this.fuelCfg.mode !== 'fixed') {
        for (const c of session.comps.values()) cu.setFuel(c.address, 15);
      }
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
        // seules les 3 dernières séances gardent tous leurs tours : les autres vont dans les fiches mémo
        setTimeout(() => rotateMemos(this).catch((e) => this.log('Fiches mémo : ' + e.message)), 3000);
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
      // séance allée à son terme (sinon : quittée / arrêtée avant la fin) — seules les séances
      // terminées comptent pour les victoires et les poles ; les tours comptent toujours
      this.sessionRecord.completed = !!s.completed;
      this.sessionRecord = slimSession(this.sessionRecord); // fiche allégée : identifiants, positions, tours, meilleur tour
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

  /**
   * Relance les feux (séquence bloquée, faux départ) : nouvel appui sur START,
   * et 2e appui si la CU reste en attente.
   */
  /** Le bouton « Nouvelle relance » doit-il apparaître (faux départ, feux bloqués) ? */
  canRelaunch() {
    const s = this.session;
    return !!s && (s.state === 'armed' || !!s.redResuming) && raceView.lightsStuck(s);
  },

  async relaunchLights() {
    const s = this.session;
    if (!s || !cu.connected) return;
    if (performance.now() - (s._relaunchAt || 0) < 2000) return; // double appui : ignoré
    s.falseStart = false;
    s._sawLights = s._sawAllLights = s._sawRedLights = s._sawAllRedLights = false;
    s._startChangedAt = performance.now();
    s._prevStart = null;      // la séquence repart de zéro : pas de faux « faux départ »
    if (s.redResuming) { cu.urgent(); perf.resendSpeeds(); } // vitesse normale
    s._relaunchAt = performance.now();
    await cu.pressStart();
    setTimeout(() => { if (cu.status?.start === 1 && (s.state === 'armed' || s.redResuming)) cu.pressStart(); }, 1500);
    s.emit('update');
  },

  async startSession() {
    const s = this.session;
    if (!s) return;
    // déjà en feux ou en course : un 2e départ enverrait START à la CU, qui arrêterait la course
    if (s.state !== 'ready') return;
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
      perf.update(); // poids de l'essence : vitesse « réservoir plein » dès la grille
      await cu.pressStart();
      // Certaines CU demandent un 2e appui pour lancer la séquence des feux
      setTimeout(() => {
        if (s.state === 'armed' && cu.status?.start === 1) cu.pressStart();
      }, 1500);
    } else {
      cu.conn.go?.();
      s.go();
      perf.update(); // poids de l'essence appliqué dès le départ
    }
  },

  /**
   * Drapeau rouge : appui sur START de la Control Unit, qui coupe le courant de la piste
   * (toutes les voitures s'arrêtent). Second appui : la CU relance les feux et la course repart.
   */
  async toggleRed() {
    const s = this.session;
    if (!s || !['running', 'finishing'].includes(s.state)) return;
    // double appui (ou deux demandes rapprochées) : le 2e est ignoré, sinon il relancerait aussitôt
    if (performance.now() - (s._redToggledAt || 0) < 2000) return;
    s._redToggledAt = performance.now();
    if (s.flag !== 'red') {
      this.cancelVscCountdown();
      if (s.flag === 'vsc') this.vscResendUntil = performance.now() + 5000;
      if (s.flag === 'vsc') { s.setFlag('green'); perf.update(); }
      s.redFlag();
      await cu.pressStart();
      say('Drapeau rouge, drapeau rouge', { priority: true });
    } else if (!s.redResuming) {
      s.resumeFromRed();
      // vitesse normale renvoyée à l'appui sur la relance, puis une 2e fois à l'extinction
      // des feux (une consigne envoyée pendant l'arrêt de la CU peut être ignorée : VSC puis drapeau rouge)
      cu.urgent();
      perf.resendSpeeds();
      await cu.pressStart();
      // certaines CU demandent un 2e appui pour lancer la séquence des feux
      setTimeout(() => { if (s.flag === 'red' && s.redResuming && cu.status?.start === 1) cu.pressStart(); }, 1500);
    }
  },

  /** Virtual Safety Car : toutes les voitures bridées à un % de leur vitesse max. */
  toggleVsc(auto = false) {
    const s = this.session;
    if (!s || !['running', 'finishing'].includes(s.state) || s.flag === 'red') return;
    if (s.vscCountdown) return; // décompte déjà lancé
    // double appui : le 2e est ignoré, sinon il lancerait aussitôt la fin du VSC
    if (performance.now() - (s._vscToggledAt || 0) < 2000) return;
    s._vscToggledAt = performance.now();
    if (s.flag !== 'vsc') {
      s.setFlag('vsc');
      s.vscSince = performance.now(); // pour la fin de VSC automatique
      s.vscAuto = auto; // fin automatique seulement pour un VSC déclenché automatiquement
      cu.urgent(); // les voitures sont bridées tout de suite (avant de relire les passages)
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
        cu.urgent(); // vitesse normale rendue tout de suite au « Go »
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
    updateExtraBar();
  });
}

/**
 * Au lancement (ou à l'activation) : reconnexion des autres lampes, puis bandeau
 * « non connectée » pour celles qui n'ont pas répondu (comme pour la rampe).
 */
let extraBarArmed = false;
async function autoConnectExtras() {
  await Promise.all(app.extraLights.map((l) => l.autoConnect().catch(() => false)));
  extraBarArmed = true;
  updateExtraBar();
}

function updateExtraBar() {
  const bar = $('#extraBar');
  if (!bar) return;
  const missing = app.lightSync.others && extraBarArmed ? app.extraLights.filter((l) => !l.connected && l.status !== 'connecting') : [];
  if (!missing.length) { bar.classList.add('hidden'); return; }
  const label = missing.length === 1 ? `${esc(missing[0].name)} non connectée` : `${missing.length} lampes non connectées`;
  bar.innerHTML = `<span>🔦</span><span>${label}</span><b>Connecter</b>`;
  bar.classList.remove('hidden');
  bar.onclick = async () => {
    for (const l of missing) {
      try {
        // un appui permet souvent de rouvrir la lampe déjà autorisée ; sinon on la recherche
        if (l.device) await l.reconnect();
        else { const n = await GenericLight.pick(); app.addExtraLight(n); }
      } catch (e) {
        if (!/cancel|chosen/i.test(e?.message || '')) toast(`${l.name} : ${e.message || e}`, 3500);
        break; // une seule fenêtre de recherche par appui
      }
    }
    updateExtraBar();
  };
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
  app.penaltyCfg = penaltyOf(await db.getSetting('penalty', {}));
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
  app.extraLights.forEach((l) => watchExtraLight(l));
  if (app.lightSync.others) autoConnectExtras();
  // Fiches mémo : verse les séances anciennes (au-delà des 3 dernières) dans les fiches
  setTimeout(() => rotateMemos(app).catch((e) => app.log('Fiches mémo : ' + e.message)), 4000);
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
    if (!b) return;
    // garage : réglages envoyés aux voitures, circuit connecté obligatoire
    if (b.dataset.view === 'garage') app.requireConnection(() => app.go('garage'), 'Connecte le circuit (ou le simulateur) avant d\'entrer au garage : les réglages sont envoyés aux voitures.');
    else app.go(b.dataset.view);
  });
  $('#connBtn').onclick = () => app.openConnectDialog();
  window.addEventListener('hashchange', () => {
    const v = location.hash.slice(1);
    if (v && v !== app.view) app.go(v);
  });

  // Horloge de l'interface
  // « Faux départ » annoncé quand le bouton « Nouvelle relance » apparaît (feux bloqués / faux départ)
  let stuckSaid = false;
  setInterval(() => {
    const s = app.session;
    const stuck = !!s && (s.state === 'armed' || s.redResuming) && raceView.lightsStuck(s);
    if (stuck && !stuckSaid) say('Faux départ', { priority: true });
    stuckSaid = stuck;
    // Fin de VSC automatique : VSC trop long sans drapeau rouge ni fin manuelle → 3, 2, 1, Go
    if (shouldEndVsc(app)) {
      app.log('Fin de VSC automatique');
      app.toggleVsc();
    }
    // VSC automatique : une voiture ne repasse plus (sortie de piste…)
    const hit = checkAutoVsc(app);
    if (hit) {
      hit.comp.autoVscFor = hit.comp.seenAt; // une seule fois tant qu'elle n'est pas repassée
      app.toggleVsc(true);
      const who = hit.comp.driver?.name || `voiture ${hit.comp.address + 1}`;
      toast(`🟨 VSC automatique : ${who} ne repasse plus (${hit.rule}, ${Math.round(hit.secs)} s)`, 5000);
      app.log(`VSC automatique (${hit.rule}) : ${who} sans passage depuis ${hit.secs.toFixed(1)} s`);
    }
  }, 200);
  setInterval(() => {
    app.session?.tick();
    app.penaltyTick();
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

  const ver = document.getElementById('appVer');
  if (ver) ver.textContent = 'v' + APP_VERSION;
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

keepScreenOn(); // pas de mise en veille de l'écran principal
init();

export { TYPES, fmtTime };
