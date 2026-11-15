// Éclairage synchronisé avec la séance : la rampe LED prend la couleur
// du drapeau en cours (course, essais libres, qualification).

export const LIGHT_SCENES = [
  { k: 'ready', label: 'Prêt (avant le GO)', c: [100, 100, 100], css: '#ffffff' },
  { k: 'lights', label: 'Feux de départ', c: [100, 0, 0], css: '#e10600' },
  { k: 'green', label: 'Départ / reprise (2 secondes)', c: [0, 100, 0], css: '#22c55e' },
  { k: 'racing', label: 'Course en cours (rien de spécial)', c: [100, 100, 100], css: '#ffffff' },
  { k: 'yellow', label: 'Drapeau jaune', c: [100, 60, 0], css: '#facc15' },
  { k: 'vsc', label: 'VSC', c: [100, 30, 0], css: '#fb923c' },
  { k: 'red', label: 'Drapeau rouge', c: [100, 0, 0], css: '#e10600' },
  { k: 'finish', label: 'Arrivée : bleu / blanc pendant 5 s', alt: [[0, 0, 100], [100, 100, 100]], css: 'linear-gradient(90deg,#3b82f6 50%,#ffffff 50%)' },
  { k: 'end', label: 'Ensuite (fin de séance)', c: [100, 100, 100], css: '#ffffff' },
];

const FINISH_MS = 5000; // alternance bleu / blanc à l'arrivée
const ALT_MS = 400;     // durée de chaque couleur dans une alternance
let endSince = null;    // début de l'arrivée
let endFor = null;

/** Scène lumineuse correspondant à l'état de la séance (null : on ne touche à rien). */
export function sceneFor(session) {
  const s = session;
  if (!s) return null;
  if (s.state === 'ready') return 'ready';
  if (s.state === 'armed') return 'lights';
  if (s.state === 'finishing' || s.state === 'finished') {
    // arrivée : 5 secondes d'alternance bleu / blanc, puis blanc
    if (endFor !== s) { endFor = s; endSince = performance.now(); }
    return performance.now() - endSince < FINISH_MS ? 'finish' : 'end';
  }
  if (s.flag === 'red') return s.redResuming ? 'lights' : 'red'; // reprise : suit les feux de la CU comme au départ
  if (s.flag === 'vsc') return 'vsc';
  if (s.flag === 'yellow') return 'yellow';
  // départ ou reprise (fin de drapeau jaune, de VSC, de drapeau rouge) : vert 2 secondes, puis blanc
  if (greenFor !== s || greenSince === null) { greenFor = s; greenSince = performance.now(); }
  return performance.now() - greenSince < GREEN_MS ? 'green' : 'racing';
}

const GREEN_MS = 2000;
let greenSince = null; // début de la dernière période « vert »
let greenFor = null;   // séance concernée

/** Toute situation autre que la course normale remet le compteur du vert à zéro. */
function noteScene(k) { if (k !== 'green' && k !== 'racing') greenSince = null; }

let last = null;
let blinkTimer = null;

/**
 * Étape de clignotement : chaque feu de départ de la Control Unit, et chaque
 * chiffre du décompte de fin de VSC (3, 2, 1) fait clignoter la rampe.
 */
function stepFor(app, k) {
  const s = app.session;
  if (k === 'lights') return app.cu?.status?.start ?? 0;
  if (k === 'vsc' && typeof s?.vscCountdown === 'number' && s.vscCountdown > 0) return s.vscCountdown; // 3, 2, 1
  return null;
}

/**
 * À appeler régulièrement : envoie la couleur à la rampe quand la scène change.
 * force : renvoie même si rien n'a changé (rampe qui vient de se connecter…).
 */
export function syncLights(app, { force = false } = {}) {
  // toutes les lampes connectées (rampe Chihiros + autres lampes) reçoivent la même scène
  const outs = app.lightOutputs ? app.lightOutputs() : [];
  if (!outs.length || !app.lightSync?.enabled) { last = null; return; }
  const L = { setColor: (r, g, b) => outs.forEach((o) => o.setColor(r, g, b)) };
  const k = sceneFor(app.session);
  if (!k) return;
  noteScene(k);
  const scene = LIGHT_SCENES.find((x) => x.k === k);
  const step = stepFor(app, k);
  // alternance de deux couleurs (arrivée) : la couleur change toutes les ALT_MS
  const phase = scene.alt ? Math.floor((performance.now() - endSince) / ALT_MS) % 2 : null;
  const key = step !== null ? `${k}:${step}` : phase !== null ? `${k}~${phase}` : k;
  if (key === last && !force) return;
  const blink = step !== null && last !== null && key !== last && !force;
  last = key;
  const color = scene.alt ? scene.alt[phase] : scene.c;
  clearTimeout(blinkTimer);
  if (blink) {
    // flash : éteint un court instant, puis la couleur revient
    L.setColor(0, 0, 0);
    blinkTimer = setTimeout(() => { if (last === key) L.setColor(...color); }, 300);
  } else {
    L.setColor(...color);
  }
}

export function resetLightSync() { last = null; }
