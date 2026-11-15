// Éclairage synchronisé avec la séance : la rampe LED prend la couleur
// du drapeau en cours (course, essais libres, qualification).

export const LIGHT_SCENES = [
  { k: 'ready', label: 'Prêt (avant le GO)', c: [100, 100, 100], css: '#ffffff' },
  { k: 'lights', label: 'Feux de départ', c: [100, 0, 0], css: '#e10600' },
  { k: 'green', label: 'Course / séance en cours', c: [0, 100, 0], css: '#22c55e' },
  { k: 'yellow', label: 'Drapeau jaune', c: [100, 60, 0], css: '#facc15' },
  { k: 'vsc', label: 'VSC', c: [100, 30, 0], css: '#fb923c' },
  { k: 'red', label: 'Drapeau rouge', c: [100, 0, 0], css: '#e10600' },
  { k: 'end', label: 'Damier (fin)', c: [100, 100, 100], css: '#ffffff' },
];

/** Scène lumineuse correspondant à l'état de la séance (null : on ne touche à rien). */
export function sceneFor(session) {
  const s = session;
  if (!s) return null;
  if (s.state === 'ready') return 'ready';
  if (s.state === 'armed') return 'lights';
  if (s.state === 'finishing' || s.state === 'finished') return 'end';
  if (s.flag === 'red') return 'red';
  if (s.flag === 'vsc') return 'vsc';
  if (s.flag === 'yellow') return 'yellow';
  return 'green';
}

let last = null;
let blinkTimer = null;

/**
 * Étape de clignotement : chaque feu de départ de la Control Unit, et chaque
 * chiffre du décompte de fin de VSC (3, 2, 1) fait clignoter la rampe.
 */
function stepFor(app, k) {
  const s = app.session;
  if (k === 'lights') return app.cu?.status?.start ?? 0;
  if (k === 'vsc' && s?.vscCountdown) return s.vscCountdown;
  return null;
}

/**
 * À appeler régulièrement : envoie la couleur à la rampe quand la scène change.
 * force : renvoie même si rien n'a changé (rampe qui vient de se connecter…).
 */
export function syncLights(app, { force = false } = {}) {
  const L = app.lights;
  if (!L?.connected || !app.lightSync?.enabled || !app.lightSync?.chihiros) { last = null; return; }
  if (app.lightHello) return; // la rampe fait son signal de connexion
  const k = sceneFor(app.session);
  if (!k) return;
  const step = stepFor(app, k);
  const key = step === null ? k : `${k}:${step}`;
  if (key === last && !force) return;
  const blink = step !== null && last !== null && key !== last && !force;
  last = key;
  const scene = LIGHT_SCENES.find((x) => x.k === k);
  clearTimeout(blinkTimer);
  if (blink) {
    // flash : éteint un court instant, puis la couleur revient
    L.setColor(0, 0, 0);
    blinkTimer = setTimeout(() => { if (last === key) L.setColor(...scene.c); }, 300);
  } else {
    L.setColor(...scene.c);
  }
}

export function resetLightSync() { last = null; }
