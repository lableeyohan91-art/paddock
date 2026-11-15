// Éclairage synchronisé avec la séance : la rampe LED prend la couleur
// du drapeau en cours (course, essais libres, qualification).

const C = {
  white: [100, 100, 100],
  red: [100, 0, 0],
  green: [0, 100, 0],
  yellow: [100, 60, 0],
};

// Tableau affiché dans Réglages → Éclairage ; alt = alternance de deux couleurs
export const LIGHT_SCENES = [
  { k: 'ready', label: 'Prêt (avant le GO)', c: C.white, css: '#ffffff' },
  { k: 'lights', label: 'Feux de départ (un flash par feu)', c: C.red, css: '#e10600' },
  { k: 'green', label: 'Départ / reprise : vert 2 s (1 s après un VSC)', c: C.green, css: '#22c55e' },
  { k: 'racing', label: 'Course en cours (rien de spécial)', c: C.white, css: '#ffffff' },
  { k: 'yellow', label: 'Drapeau jaune', c: C.yellow, css: '#facc15' },
  { k: 'vscIn', label: 'VSC déclenché : jaune / rouge 2 s', alt: [C.yellow, C.red], css: 'linear-gradient(90deg,#facc15 50%,#e10600 50%)' },
  { k: 'vsc', label: 'VSC en cours', c: C.yellow, css: '#facc15' },
  { k: 'vscOut', label: 'Fin de VSC : jaune / vert jusqu\'au Go', alt: [C.yellow, C.green], css: 'linear-gradient(90deg,#facc15 50%,#22c55e 50%)' },
  { k: 'red', label: 'Drapeau rouge', c: C.red, css: '#e10600' },
  { k: 'end', label: 'Damier (fin)', c: C.white, css: '#ffffff' },
];
const SCENE = Object.fromEntries(LIGHT_SCENES.map((x) => [x.k, x]));

const ALT_MS = 400;        // durée de chaque couleur dans une alternance
const VSC_IN_MS = 2000;    // alternance jaune / rouge au déclenchement du VSC
const GREEN_MS = 2000;     // vert après un départ / une reprise…
const GREEN_AFTER_VSC = 1000; // … et après la fin d'un VSC

// mémoire de la séquence en cours
let forSession = null;
let vscSince = null;   // début du VSC
let greenSince = null; // début de la période verte
let greenMs = GREEN_MS;
let prevScene = null;

/** Scène lumineuse correspondant à l'état de la séance (null : on ne touche à rien). */
export function sceneFor(session) {
  const s = session;
  if (!s) return null;
  if (forSession !== s) { forSession = s; vscSince = greenSince = prevScene = null; }
  const now = performance.now();
  let k;
  if (s.state === 'ready') k = 'ready';
  else if (s.state === 'armed') k = 'lights';
  else if (s.state === 'finishing' || s.state === 'finished') k = 'end';
  else if (s.flag === 'red') k = s.redResuming ? 'lights' : 'red'; // reprise : suit les feux de la CU
  else if (s.flag === 'vsc') {
    if (vscSince === null) vscSince = now;
    k = s.vscCountdown ? 'vscOut' : now - vscSince < VSC_IN_MS ? 'vscIn' : 'vsc';
  } else if (s.flag === 'yellow') k = 'yellow';
  else {
    // départ ou reprise : vert un instant, puis blanc
    if (greenSince === null) {
      greenSince = now;
      greenMs = prevScene === 'vscOut' || prevScene === 'vsc' ? GREEN_AFTER_VSC : GREEN_MS;
    }
    k = now - greenSince < greenMs ? 'green' : 'racing';
  }
  if (k !== 'green' && k !== 'racing') greenSince = null;
  if (s.flag !== 'vsc') vscSince = null;
  if (k !== prevScene && !(prevScene === 'green' && k === 'racing')) sceneStart = now;
  prevScene = k;
  return k;
}

let sceneStart = 0; // début de la scène (pour les alternances)
let last = null;
let blinkTimer = null;

/** Feux de départ de la Control Unit : chaque feu fait clignoter la rampe. */
function stepFor(app, k) {
  if (k === 'lights') return app.cu?.status?.start ?? 0;
  return null;
}

/**
 * À appeler souvent (100 ms) : envoie la couleur à la rampe quand elle doit changer.
 * force : renvoie même si rien n'a changé (rampe qui vient de se connecter…).
 */
export function syncLights(app, { force = false } = {}) {
  const L = app.lights;
  if (!L?.connected || !app.lightSync?.enabled || !app.lightSync?.chihiros) { last = null; return; }
  if (app.lightHello) return; // la rampe fait son signal de connexion
  const k = sceneFor(app.session);
  if (!k) return;
  const scene = SCENE[k];
  const step = stepFor(app, k);
  const phase = scene.alt ? Math.floor((performance.now() - sceneStart) / ALT_MS) % 2 : null;
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
