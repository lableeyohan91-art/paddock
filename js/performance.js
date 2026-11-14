// Moteur de performance : calcule en continu la vitesse et le freinage de
// chaque voiture à partir de son réglage de base et d'une liste d'effets
// (météo, drapeau jaune, et plus tard pneus, carburant, dégâts...).
//
//   valeur envoyée à la CU = arrondi(base × produit des facteurs), bornée 0..15
//
// Ajouter un effet = ajouter un objet { id, label, compute(address, ctx) }
// qui renvoie { speed: facteur, brake: facteur, note?: texte } ou null.

export class PerformanceEngine extends EventTarget {
  constructor(cu) {
    super();
    this.cu = cu;
    this.modifiers = new Map();
    this.bases = new Map();  // address -> {speed, brake}
    this.sent = new Map();   // address -> {speed, brake} dernière valeur envoyée
    this.current = new Map(); // address -> détail du calcul (pour l'affichage)
    this.enabled = true;
    this._timer = null;
  }

  addModifier(mod) {
    this.modifiers.set(mod.id, mod);
    this.update();
  }

  removeModifier(id) {
    this.modifiers.delete(id);
    this.update();
  }

  setBase(address, speed, brake) {
    this.bases.set(address, { speed, brake });
    this.update();
  }

  clearBases() {
    this.bases.clear();
    this.sent.clear();
    this.current.clear();
  }

  start(intervalMs = 1000) {
    this.stop();
    this._timer = setInterval(() => this.update(), intervalMs);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = null;
  }

  /**
   * Renvoie la vitesse actuelle de chaque voiture, même inchangée.
   * Une voiture hors de la piste ne reçoit pas les commandes : en les répétant,
   * elle prend la bonne vitesse dès qu'on la repose.
   */
  resendSpeeds() {
    for (const address of this.bases.keys()) {
      const r = this.current.get(address);
      if (r) this.cu.setSpeed(address, r.speed);
    }
  }

  /** Remet chaque voiture à sa valeur de base (fin de session). */
  restore() {
    for (const [address, base] of this.bases) {
      this.cu.setSpeed(address, base.speed);
      this.cu.setBrake(address, base.brake);
      this.current.set(address, { address, base, speedF: 1, brakeF: 1, speed: base.speed, brake: base.brake, effects: [] });
    }
    this.sent.clear();
    this.dispatchEvent(new CustomEvent('update'));
  }

  compute(address) {
    const base = this.bases.get(address) || { speed: 15, brake: 15 };
    let speedF = 1;
    let brakeF = 1;
    const effects = [];
    if (this.enabled) {
      for (const mod of this.modifiers.values()) {
        const r = mod.compute(address);
        if (!r) continue;
        const s = r.speed ?? 1;
        const b = r.brake ?? 1;
        if (s !== 1 || b !== 1 || r.note) {
          effects.push({ id: mod.id, label: mod.label, speed: s, brake: b, note: r.note });
        }
        speedF *= s;
        brakeF *= b;
      }
    }
    const speed = clamp(Math.round(base.speed * speedF));
    const brake = clamp(Math.round(base.brake * brakeF));
    return { address, base, speedF, brakeF, speed, brake, effects };
  }

  update() {
    for (const address of this.bases.keys()) {
      const r = this.compute(address);
      this.current.set(address, r);
      const prev = this.sent.get(address);
      if (!prev || prev.speed !== r.speed) this.cu.setSpeed(address, r.speed);
      if (!prev || prev.brake !== r.brake) this.cu.setBrake(address, r.brake);
      this.sent.set(address, { speed: r.speed, brake: r.brake });
    }
    this.dispatchEvent(new CustomEvent('update'));
  }
}

const clamp = (v) => Math.max(0, Math.min(15, v));

/** Drapeau jaune : toutes les voitures ralenties. */
export function yellowFlagModifier(getFlag, factor = 0.55) {
  return {
    id: 'flag',
    label: 'Drapeau jaune',
    compute() {
      return getFlag() === 'yellow' ? { speed: factor, brake: 1, note: 'Drapeau jaune' } : null;
    },
  };
}

/** Vitesse imposée sous VSC (0..15) pour un pourcentage de la vitesse max du circuit. */
export const vscSpeed = (pct) => Math.max(0, Math.min(15, Math.round((15 * pct) / 100)));

/**
 * Virtual Safety Car : toutes les voitures roulent à la MÊME vitesse fixe,
 * quel que soit leur réglage garage (comme la panne sèche en vitesse fixe).
 * Ex. 20 % → vitesse 3/15 pour tout le monde. Une voiture déjà plus lente n'est pas accélérée.
 * Panne sèche prioritaire : une voiture à sec garde la vitesse de panne sèche, sans VSC en plus.
 */
export function vscModifier(getFlag, getPct, getBase, isOutOfFuel = () => false) {
  return {
    id: 'vsc',
    label: 'Virtual Safety Car',
    compute(address) {
      if (getFlag() !== 'vsc') return null;
      if (isOutOfFuel(address)) return null;
      const target = vscSpeed(getPct());
      const base = getBase(address) || 15;
      return { speed: Math.min(1, target / base), brake: 1, note: `VSC (vitesse ${target}/15)` };
    },
  };
}
