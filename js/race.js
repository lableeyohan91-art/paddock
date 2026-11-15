// Moteur de session : essais libres, qualification, course (tours ou temps).
// Reçoit les passages de la Control Unit, calcule tours, classement, écarts,
// secteurs, arrêts aux stands, et détecte la fin de session.
//
// Événements : 'update', 'lap' {comp, lap, isBest, isOverallBest},
//              'state' {state}, 'finish' {comp}, 'pit' {comp, in}

export const TYPES = {
  practice: 'Essais libres',
  qualifying: 'Qualification',
  race: 'Course',
};

export class RaceSession extends EventTarget {
  /**
   * @param {object} cfg
   *  type: 'practice'|'qualifying'|'race'
   *  mode: 'laps'|'time'           (course)
   *  laps: nombre de tours         (course aux tours)
   *  duration: minutes             (temps ; 0 = illimité en essais)
   *  minLapMs: tour minimum valide (anti-rebond)
   *  start: 'lights'|'immediate'
   *  entries: [{address, driver, car}]
   *  autoAdd: ajouter les manettes non configurées
   */
  constructor(cfg) {
    super();
    this.cfg = { minLapMs: 1500, autoAdd: true, ...cfg };
    this.id = null;
    this.state = 'ready'; // ready | armed | running | finishing | finished
    this.startedAt = null; // performance.now() au départ
    this.finishingAt = null;
    this.endedAt = null;
    this.comps = new Map();
    this.overallBest = null; // {time, address}
    this.bestSectors = [];
    this.order = [];
    this.flag = 'green';
    for (const e of cfg.entries || []) this._addComp(e.address, e.driver, e.car);
  }

  emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _addComp(address, driver, car) {
    const c = {
      address,
      driver: driver || { id: null, name: 'Manette ' + (address + 1), color: '#888' },
      car: car || { id: null, name: '—', speed: 15, brake: 15 },
      laps: 0,
      lapTs: [],        // horodatage CU de chaque passage (index = tours complétés)
      lastTs: null,
      lastLap: null,
      bestLap: null,
      lapTimes: [],
      sectorTs: null,
      sectors: [],      // secteurs du tour en cours
      lastSectors: [],
      bestSectors: [],
      finished: false,
      finishPos: null,
      inPit: false,
      pitStops: 0,
      cuFuel: null,     // carburant vu par la Control Unit (0-15), info seulement
      fuelPct: null,    // essence simulée par l'appli (%)
      tankPct: 100,     // taille du réservoir (réglage garage, %)
      lastFuelUse: null,
      position: 0,
      gap: '',
      onTrack: false,
    };
    this.comps.set(address, c);
    return c;
  }

  get elapsedMs() {
    if (!this.startedAt) return 0;
    return (this.endedAt ?? performance.now()) - this.startedAt;
  }

  get durationMs() {
    const t = this.cfg.type;
    if (t === 'race' && this.cfg.mode !== 'time') return 0;
    return (this.cfg.duration || 0) * 60000;
  }

  /** Essais / qualif avec un nombre de tours par pilote. */
  get lapLimited() {
    return this.cfg.type !== 'race' && this.cfg.mode === 'laps' && this.cfg.laps > 0;
  }

  get remainingMs() {
    return this.durationMs ? Math.max(0, this.durationMs - this.elapsedMs) : null;
  }

  get leaderLaps() {
    return Math.max(0, ...[...this.comps.values()].map((c) => c.laps));
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', { state: s });
    this.emit('update');
  }

  arm() {
    this._startChangedAt = performance.now();
    this._prevStart = null;
    this._relaunchAt = performance.now();
    this.falseStart = false;
    this.setState('armed');
  }

  go() {
    if (this.state === 'running') return;
    this.startedAt = performance.now();
    this.setState('running');
  }

  stop() {
    if (this.state === 'finished') return;
    this.endedAt = performance.now();
    this._rank();
    this.setState('finished');
  }

  setFlag(flag) {
    if (flag === 'green' && this.flag !== 'green') this.greenSince = performance.now();
    this.flag = flag;
    this.emit('update');
  }

  /** Drapeau rouge : toutes les voitures arrêtées (bouton START de la CU). */
  redFlag() {
    this.flag = 'red';
    this.redResuming = false;
    this._sawRedLights = false;
    this._sawAllRedLights = false;
    this.emit('flag', { flag: 'red' });
    this.emit('update');
  }

  /** Reprise demandée : la CU relance la séquence des feux. */
  resumeFromRed() {
    if (this.flag !== 'red') return;
    this.redResuming = true;
    this._startChangedAt = performance.now();
    this._prevStart = null;
    this._relaunchAt = performance.now();
    this._sawRedLights = false;
    this._sawAllRedLights = false;
    this.emit('update');
  }

  _endRed() {
    this.redResuming = false;
    this.falseStart = false;
    this._goStart = undefined; // nouvelle référence après la reprise
    this.greenSince = performance.now();
    this.flag = 'green';
    this.emit('flag', { flag: 'green', resumed: true });
    this.emit('update');
  }

  /** À appeler régulièrement (horloge). */
  tick() {
    if (this.state === 'running' && this.durationMs && this.elapsedMs >= this.durationMs) {
      this._startFinishing();
    }
    // essais / qualif aux tours : fin quand tous les pilotes en piste ont fait leurs tours
    if (this.state === 'running' && this.lapLimited) {
      const onTrack = [...this.comps.values()].filter((c) => c.onTrack);
      if (onTrack.length && onTrack.every((c) => c.finished)) { this.completed = true; this.stop(); }
    }
    if (this.state === 'finishing') {
      const slowest = Math.max(10000, ...[...this.comps.values()].map((c) => (c.bestLap || 0) * 3));
      const all = [...this.comps.values()].filter((c) => c.onTrack).every((c) => c.finished);
      if (all || performance.now() - this.finishingAt > slowest) this.stop();
    }
  }

  _startFinishing() {
    if (this.state !== 'running') return;
    this.completed = true; // fin normale (tours ou temps écoulés) : compte pour victoires / poles
    this.finishingAt = performance.now();
    this.setState('finishing');
  }

  onStatus(st) {
    const now = performance.now();
    if (st.start !== this._prevStart) this._startChangedAt = now;
    const prev = this._prevStart;
    this._prevStart = st.start;

    // Faux départ pendant les feux : la séquence repart en arrière (la CU a tout arrêté)
    const lightsPhase = this.state === 'armed' || (this.flag === 'red' && this.redResuming);
    // (pas juste après un appui sur START de l'appli : la CU repasse alors par 1 normalement)
    const justPressed = now - (this._relaunchAt || 0) < 2500;
    if (lightsPhase && !justPressed && prev != null && prev >= 2 && st.start !== 0 && st.start < prev) {
      this._sawLights = this._sawAllLights = this._sawRedLights = this._sawAllRedLights = false;
      this.falseStart = true;
      this.emit('falsestart');
      this.emit('update');
      return;
    }

    // Course lancée mais la CU s'est arrêtée d'elle-même (faux départ repéré après
    // l'extinction des feux, START appuyé sur le boîtier…) : on passe en drapeau rouge
    if (this.state === 'running' && this.flag !== 'red') {
      if (this._goStart === undefined) this._goStart = st.start; // valeur juste après le départ
      else if (st.start === 0) this._goStart = 0;
      else if (st.start !== this._goStart && (st.start <= 6 || st.start >= 8) && now - this.startedAt > 1000) {
        this._goStart = st.start;
        this.redFlag();
        this.emit('halt');
        return;
      }
    }

    // Feux : départ quand la séquence de la CU se termine
    if (this.state === 'armed') {
      if (st.start > 0) this._sawLights = true;
      if (st.start >= 2) this.falseStart = false; // les feux repartent : alerte levée
      // après le 5e feu (valeur 6), le premier changement = extinction des feux = départ
      // (certaines CU ne repassent pas tout de suite à 0)
      if (this._sawAllLights && st.start !== 6) this.go();
      else if (st.start === 6) this._sawAllLights = true;
      else if (st.start === 0 && this._sawLights) this.go();
    }
    // Drapeau rouge : la reprise est faite quand la séquence des feux de la CU se termine
    if (this.flag === 'red' && this.redResuming) {
      if (st.start > 0) this._sawRedLights = true;
      // comme au départ : après le 5e feu (6), le premier changement = extinction des feux
      if (this._sawAllRedLights && st.start !== 6) this._endRed();
      else if (st.start === 6) this._sawAllRedLights = true;
      else if (st.start === 0 && this._sawRedLights) this._endRed();
    }
    for (const c of this.comps.values()) {
      c.cuFuel = st.fuel[c.address];
      const pit = !!st.pit[c.address];
      if (pit !== c.inPit) {
        c.inPit = pit;
        if (!pit) c.pitOutAt = performance.now(); // sortie du stand : le compte repart de là
        if (pit) c.pitStops++;
        this.emit('pit', { comp: c, in: pit });
      }
    }
    this.emit('update');
  }

  onTimer({ address, timestamp, sector }) {
    // Feux allumés puis une voiture passe la ligne : la course est forcément
    // lancée, même si la fin de séquence des feux n'a pas été reconnue.
    if (this.state === 'armed' && this._sawLights) this.go();
    // reprise demandée et une voiture repasse la ligne : la course est repartie
    if (this.flag === 'red' && this.redResuming) this._endRed();
    if (!['running', 'finishing'].includes(this.state)) return;
    let c = this.comps.get(address);
    if (!c) {
      if (!this.cfg.autoAdd) return;
      c = this._addComp(address);
      this.emit('join', { comp: c }); // nouvelle voiture en cours de séance (détection auto)
    }
    if (c.finished) return;
    c.onTrack = true;
    // heures (appli) des passages : VSC automatique (voiture qui ne repasse plus)
    c.seenAt = performance.now();
    if (sector > 1) c.sawSector = true; else c.lineAt = c.seenAt;

    if (sector > 1) {
      // Capteur intermédiaire (Check Lane) : fin d'un secteur
      if (c.lastTs === null) return;
      const from = c.sectorTs ?? c.lastTs;
      c.sectors.push(timestamp - from);
      c.sectorTs = timestamp;
      this.emit('update');
      return;
    }

    if (c.lastTs === null) {
      // premier passage : début du chronométrage de ce pilote
      c.lastTs = timestamp;
      c.lapTs[0] = timestamp;
      c.sectorTs = null;
      c.sectors = [];
      this._rank();
      this.emit('update');
      return;
    }

    const lap = timestamp - c.lastTs;
    if (lap < this.cfg.minLapMs) return; // rebond / double détection

    // secteur final = depuis le dernier capteur intermédiaire jusqu'à la ligne
    if (c.sectors.length) c.sectors.push(timestamp - c.sectorTs);
    c.lastSectors = c.sectors;
    c.lastSectors.forEach((s, i) => {
      if (!c.bestSectors[i] || s < c.bestSectors[i]) c.bestSectors[i] = s;
      if (!this.bestSectors[i] || s < this.bestSectors[i]) this.bestSectors[i] = s;
    });
    c.sectors = [];
    c.sectorTs = null;

    c.laps++;
    c.lastTs = timestamp;
    c.lapTs[c.laps] = timestamp;
    c.lastLap = lap;
    c.lapTimes.push(lap);
    const isBest = !c.bestLap || lap < c.bestLap;
    if (isBest) c.bestLap = lap;
    const isOverallBest = !this.overallBest || lap < this.overallBest.time;
    if (isOverallBest) this.overallBest = { time: lap, address };

    const lapRecord = { lapNo: c.laps, time: lap, sectors: c.lastSectors.slice() };

    // Fin de session ?
    if (this.state === 'finishing') {
      this._finish(c);
    } else if (this.cfg.type === 'race' && this.cfg.mode !== 'time' && c.laps >= this.cfg.laps) {
      this._startFinishing();
      this._finish(c);
    } else if (this.lapLimited && c.laps >= this.cfg.laps) {
      // essais / qualif aux tours : ce pilote a fait ses N tours
      this._finish(c);
    }

    this._rank();
    this.emit('lap', { comp: c, lap: lapRecord, isBest, isOverallBest });
    this.emit('update');
  }

  /**
   * Change le pilote et/ou la voiture d'une manette en cours de session.
   * resetTiming : le nouveau pilote repart de zéro (essais, qualif) ;
   * sinon il reprend tours et position (relais en course).
   */
  reassign(address, driver, car, { resetTiming = false } = {}) {
    let c = this.comps.get(address);
    if (!c) c = this._addComp(address, driver, car);
    c.history = c.history || [];
    c.history.push({ driver: c.driver, car: c.car, laps: c.laps, at: Date.now() });
    c.driver = driver || c.driver;
    c.car = car || c.car;
    if (resetTiming) {
      Object.assign(c, {
        laps: 0, lapTs: [], lastTs: null, lastLap: null, bestLap: null, lapTimes: [],
        sectorTs: null, sectors: [], lastSectors: [], bestSectors: [], gap: '',
      });
    }
    this._rank();
    this.emit('update');
    return c;
  }

  _finish(c) {
    c.finished = true;
    c.finishPos = [...this.comps.values()].filter((x) => x.finished).length;
    this.emit('finish', { comp: c });
  }

  _rank() {
    const list = [...this.comps.values()];
    if (this.cfg.type === 'race') {
      list.sort((a, b) => {
        if (b.laps !== a.laps) return b.laps - a.laps;
        if (a.lastTs === null) return 1;
        if (b.lastTs === null) return -1;
        return a.lastTs - b.lastTs;
      });
      const leader = list[0];
      list.forEach((c, i) => {
        c.position = i + 1;
        if (i === 0 || c.lastTs === null) c.gap = i === 0 ? 'Leader' : '';
        else if (leader.laps > c.laps) {
          const d = leader.laps - c.laps;
          c.gap = '+' + d + (d > 1 ? ' tours' : ' tour');
        } else {
          c.gap = '+' + fmtGap(c.lastTs - leader.lapTs[c.laps]);
        }
      });
    } else {
      list.sort((a, b) => {
        if (a.bestLap === null && b.bestLap === null) return a.address - b.address;
        if (a.bestLap === null) return 1;
        if (b.bestLap === null) return -1;
        return a.bestLap - b.bestLap;
      });
      const best = list[0]?.bestLap;
      list.forEach((c, i) => {
        c.position = i + 1;
        c.gap = i === 0 || c.bestLap === null || !best ? '' : '+' + fmtGap(c.bestLap - best);
      });
    }
    this.order = list;
  }

  results() {
    this._rank();
    return this.order.map((c) => ({
      position: c.position,
      address: c.address,
      driverId: c.driver.id,
      driverName: c.driver.name,
      carId: c.car.id,
      carName: c.car.name,
      laps: c.laps,
      bestLap: c.bestLap,
      totalTime: c.lapTs.length > 1 ? c.lastTs - c.lapTs[0] : null,
      gap: c.gap,
      pitStops: c.pitStops,
    }));
  }
}

export function fmtTime(ms, digits = 3) {
  if (ms === null || ms === undefined || !isFinite(ms)) return '—';
  const neg = ms < 0;
  ms = Math.abs(ms);
  const m = Math.floor(ms / 60000);
  const s = (ms % 60000) / 1000;
  const sStr = s.toFixed(digits);
  const out = m ? `${m}:${sStr.padStart(digits + 3, '0')}` : sStr;
  return (neg ? '-' : '') + out;
}

export const fmtGap = (ms) => fmtTime(ms, 3);

export function fmtClock(ms) {
  if (ms === null || ms === undefined) return '—';
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}
