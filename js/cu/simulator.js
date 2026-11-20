// Control Unit simulée : répond aux mêmes commandes que la vraie, au niveau
// des octets du protocole. Permet de tester toute l'appli sans circuit.
// La vitesse réglée par l'appli (commande J) influence réellement les temps.

import {
  BUTTON, MODE, encodeTimer, encodeStatus, parseSetWord,
} from './protocol.js';

const rand = (a, b) => a + Math.random() * (b - a);

export class SimulatorConnection {
  constructor({ cars = 4, baseLap = 6000, checkLane = true } = {}) {
    this.kind = 'sim';
    this.name = 'Simulateur';
    this.ondisconnect = null;
    this.t0 = performance.now();
    this.queue = [];          // réponses "timer" en attente
    this.start = 0;           // état des feux (0 = course)
    this.startTimer = null;
    this.cars = Array.from({ length: 8 }, (_, i) => ({
      active: i < cars || i === 6, // 6 = voiture fantôme (autonome)
      speed: 15,
      brake: 15,
      fuel: 15,
      skill: rand(0.94, 1.06), // talent du pilote virtuel
      nextAt: null,             // prochain passage sur la ligne (ms horloge CU)
      midAt: null,              // prochain passage sur la Check Lane simulée
      split: rand(0.45, 0.55),  // part du tour avant la Check Lane
      inPit: false,
      lapsOnTank: 0,
    }));
    this.baseLap = baseLap;
    this.running = false;
    this.checkLane = checkLane; // capteur intermédiaire (secteurs) à mi-parcours
    this.pitLaneLoss = 4000;    // ms perdues à parcourir la voie des stands (hors remplissage)
  }

  now() {
    return Math.floor(performance.now() - this.t0);
  }

  async open() {
    await new Promise((r) => setTimeout(r, 300));
  }

  async close() {
    clearInterval(this.startTimer);
  }

  /**
   * Réglage "de référence" d'une voiture : à ce réglage, elle tourne autour du
   * temps de base. Seuls les écarts (météo, drapeau jaune, réglage changé en
   * session…) la rendent plus rapide ou plus lente.
   */
  calibrate(address, speed, brake) {
    const car = this.cars[address];
    if (car) { car.refSpeed = speed; car.refBrake = brake; }
  }

  _lapTime(car) {
    // vitesse 15 = 100 %, vitesse 0 ~ 45 % ; freinage faible = un peu plus lent
    const sf = (v) => 0.45 + 0.55 * (v / 15);
    const bf = (v) => 0.9 + 0.1 * (v / 15);
    const speedF = sf(car.speed) / sf(car.refSpeed ?? 15);
    const brakeF = bf(car.brake) / bf(car.refBrake ?? 15);
    let t = this.baseLap * car.skill / (speedF * brakeF);
    t *= rand(0.97, 1.05);
    if (Math.random() < 0.04) t *= rand(1.3, 2.2); // sortie de piste
    return Math.round(t);
  }

  _tick() {
    if (!this.running) { this._last = null; return; }
    const now = this.now();
    const dt = this._last === null || this._last === undefined ? 0 : now - this._last;
    this._last = now;
    this.cars.forEach((car, address) => {
      if (!car.active) return;
      if (car.nextAt === null) {
        car.nextAt = now + Math.round(rand(200, 1500)); // départ décalé
        return;
      }
      // À l'arrêt au stand : la voiture ne progresse pas (son prochain passage recule)
      if (car.inPit) {
        car.nextAt += dt;
        if (car.midAt !== null && car.midAt !== undefined) car.midAt += dt;
        // comme la vraie Control Unit : arrêtée au stand, bouton appuyé, l'essence monte d'un cran toutes les 0,4 s
        car.fillMs = (car.fillMs || 0) + dt;
        while (car.fillMs >= 400 && car.fuel < 15) { car.fillMs -= 400; car.fuel++; car.lapsOnTank = (15 - car.fuel) * 2; }
        return;
      }
      // Check Lane simulée à mi-parcours : capteur "secteur 2"
      if (this.checkLane && car.midAt !== null && car.midAt !== undefined && now >= car.midAt) {
        this.queue.push(encodeTimer(address, car.midAt, 2));
        car.midAt = null;
      }
      if (now >= car.nextAt) {
        this.queue.push(encodeTimer(address, car.nextAt, 1));
        car.lapsOnTank++;
        car.fuel = Math.max(0, 15 - Math.floor(car.lapsOnTank / 2));
        const lap = this._lapTime(car);
        // le 1er secteur fait ~45-55 % du tour selon le pilote et le tour
        car.midAt = car.nextAt + Math.round(lap * (car.split + rand(-0.03, 0.03)));
        car.nextAt += lap;
      }
    });
  }

  _pressStart() {
    // en pleine course : la CU coupe la piste (drapeau rouge), feux allumés
    if (this.running) {
      this.running = false;
      this.halted = true;
      clearInterval(this.startTimer);
      this.start = 1;
      return;
    }
    if (this.halted || (this.start === 0 && !this.running)) {
      this.halted = false;
      // séquence des feux : 1 = prêt, 2..6 = feux rouges, puis départ
      this.start = 1;
      clearInterval(this.startTimer);
      let step = 1;
      this.startTimer = setInterval(() => {
        step++;
        if (step <= 6) {
          this.start = step;
        } else {
          clearInterval(this.startTimer);
          // 5 feux allumés (valeur 6) pendant un délai aléatoire, puis extinction = départ
          setTimeout(() => {
            this.start = 0;
            this.running = true;
            this.cars.forEach((c) => { c.nextAt = null; c.midAt = null; });
          }, rand(200, 1500));
        }
      }, 800);
    }
  }

  async request(cmd) {
    await new Promise((r) => setTimeout(r, 15)); // latence BLE simulée
    this._tick();
    const c = cmd[0];
    if (c === '?') {
      if (this.queue.length) return this.queue.shift() + '$';
      const pitMask = this.cars.reduce((m, car, i) => m | (car.inPit ? 1 << i : 0), 0);
      return encodeStatus({
        fuel: this.cars.map((car) => car.fuel),
        start: this.start,
        mode: MODE.FUEL | MODE.PIT_LANE,
        pitMask,
        display: 0,
      }) + '$';
    }
    if (c === '0') return '05337' + '0$';
    if (c === '=') {
      this.running = false;
      this.start = 0;
      this.queue = [];
      this.t0 = performance.now();
      this.cars.forEach((car) => { car.nextAt = null; car.midAt = null; car.lapsOnTank = 0; car.fuel = 15; });
      return '=$';
    }
    if (c === 'T') {
      const id = cmd.charCodeAt(1) & 0x0f;
      if (id === BUTTON.START_ENTER) this._pressStart();
      if (id === BUTTON.PACE_CAR_ESC) this.running = !this.running;
      return 'T$';
    }
    if (c === 'J') {
      const { word, address, value } = parseSetWord(cmd);
      const car = this.cars[address];
      if (car) {
        if (word === 0) car.speed = value;
        if (word === 1) car.brake = value;
        if (word === 2) { car.fuel = value; car.lapsOnTank = (15 - value) * 2; }
      }
      return 'J$';
    }
    return cmd[0] + '$';
  }

  /** Simulation : démarre directement sans feux (essais libres). */
  go() {
    this.start = 0;
    this.running = true;
  }

  /** Simulation : envoie une voiture au stand (ravitaillement). */
  pit(address, on) {
    const car = this.cars[address];
    if (!car || car.inPit === on) return;
    this._tick(); // fige le temps écoulé avant de changer d'état
    car.inPit = on;
    if (on) {
      car.fillMs = 0; // le plein se fait peu à peu pendant l'arrêt (voir _tick)
    } else if (car.nextAt !== null) {
      // traverser la voie des stands (freiner, ressortir) coûte un peu de temps
      car.nextAt += this.pitLaneLoss;
      if (car.midAt !== null && car.midAt !== undefined) car.midAt += this.pitLaneLoss;
    }
  }
}
