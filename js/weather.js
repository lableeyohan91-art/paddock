// Météo : le ciel (sec, nuageux, pluie, orage) fait évoluer l'humidité de la
// piste (0 = sèche, 1 = détrempée). C'est l'humidité, pas le ciel, qui ralentit
// les voitures : la piste mouille progressivement quand il pleut et sèche
// progressivement quand la pluie s'arrête.
// Plus tard, les pneus (pluie / intermédiaires / slicks) moduleront cet effet.

export const SKY = {
  sun:    { label: 'Soleil',       icon: '☀️', target: 0,    rate: 0.10 },
  cloudy: { label: 'Nuageux',      icon: '☁️', target: 0,    rate: 0.06 },
  drizzle:{ label: 'Bruine',       icon: '🌦️', target: 0.4,  rate: 0.15 },
  rain:   { label: 'Pluie',        icon: '🌧️', target: 0.8,  rate: 0.25 },
  storm:  { label: 'Orage',        icon: '⛈️', target: 1,    rate: 0.45 },
};

// Transitions plausibles pour la météo dynamique
const NEXT = {
  sun: ['sun', 'cloudy'],
  cloudy: ['sun', 'cloudy', 'drizzle', 'rain'],
  drizzle: ['cloudy', 'rain', 'drizzle'],
  rain: ['drizzle', 'rain', 'storm', 'cloudy'],
  storm: ['rain', 'drizzle'],
};

export class Weather extends EventTarget {
  constructor() {
    super();
    this.sky = 'sun';
    this.wetness = 0;
    this.dynamic = false;
    this.variability = 3;   // 1 (stable) .. 5 (très changeante)
    this.intensity = 1;     // multiplie l'effet sur les voitures (0.5 .. 1.5)
    this.next = null;       // {sky, at} prévision
    this.history = [];
    this._last = performance.now();
    this._timer = null;
  }

  get label() {
    return SKY[this.sky].label;
  }

  /** Effet sur les voitures pour une humidité donnée. */
  factors(wetness = this.wetness) {
    const w = Math.min(1, wetness * this.intensity);
    return {
      speed: 1 - 0.38 * w,
      brake: 1 - 0.5 * w,
    };
  }

  get trackLabel() {
    const w = this.wetness;
    if (w < 0.05) return 'Piste sèche';
    if (w < 0.3) return 'Piste humide';
    if (w < 0.65) return 'Piste mouillée';
    return 'Piste détrempée';
  }

  setSky(sky, announce = true) {
    if (!SKY[sky] || sky === this.sky) return;
    const prev = this.sky;
    this.sky = sky;
    this.history.push({ sky, at: Date.now() });
    if (this.dynamic) this._planNext();
    this.dispatchEvent(new CustomEvent('change', { detail: { sky, prev, announce } }));
  }

  setDynamic(on) {
    this.dynamic = on;
    if (on) this._planNext();
    else this.next = null;
    this.dispatchEvent(new CustomEvent('update'));
  }

  reset(sky = 'sun') {
    this.sky = sky;
    this.wetness = SKY[sky].target;
    this.history = [{ sky, at: Date.now() }];
    this.next = null;
    if (this.dynamic) this._planNext();
    this.dispatchEvent(new CustomEvent('update'));
  }

  _planNext() {
    // Durée moyenne d'un ciel : 6 min (stable) à 1,5 min (très changeante)
    const mean = [6, 4.5, 3, 2, 1.5][this.variability - 1] * 60000;
    const delay = mean * (0.6 + Math.random() * 0.8);
    const options = NEXT[this.sky].filter((s) => s !== this.sky);
    const sky = options[Math.floor(Math.random() * options.length)];
    this.next = { sky, at: performance.now() + delay };
  }

  start() {
    this.stop();
    this._last = performance.now();
    this._timer = setInterval(() => this.tick(), 1000);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  tick() {
    const now = performance.now();
    const dtMin = (now - this._last) / 60000;
    this._last = now;
    const { target, rate } = SKY[this.sky];
    // séchage plus lent que l'arrosage
    const speed = this.wetness > target ? 0.12 : rate;
    const step = speed * dtMin * 4; // ~15 s pour mouiller sous l'orage
    if (this.wetness < target) this.wetness = Math.min(target, this.wetness + step);
    else if (this.wetness > target) this.wetness = Math.max(target, this.wetness - step);

    if (this.dynamic && this.next && now >= this.next.at) this.setSky(this.next.sky);
    this.dispatchEvent(new CustomEvent('update'));
  }

  /** Effet branché dans le moteur de performance. */
  modifier() {
    return {
      id: 'weather',
      label: 'Météo',
      compute: () => {
        if (this.wetness < 0.01) return null;
        const f = this.factors();
        return { ...f, note: this.trackLabel };
      },
    };
  }

  forecastText() {
    if (!this.next) return '';
    const min = Math.max(0, (this.next.at - performance.now()) / 60000);
    const when = min < 1 ? "moins d'une minute" : `~${Math.round(min)} min`;
    return `${SKY[this.next.sky].icon} ${SKY[this.next.sky].label} dans ${when}`;
  }
}
