// Éclairage synchronisé avec la séance : la rampe LED prend la couleur
// du drapeau en cours (course, essais libres, qualification).

// Palette : couleurs de base des scènes, personnalisables dans Réglages → Éclairage
// (r, g, b de 0 à 100). Les séquences, elles, ne changent pas.
export const DEFAULT_PALETTE = {
  red: [100, 0, 0],
  orange: [100, 30, 0],
  green: [0, 100, 0],
  blue: [0, 0, 100],
  white: [100, 100, 100],
};

// Toutes les couleurs qui peuvent s'afficher en course : chacune se règle à part
// (Réglages → Éclairage → Personnalisation des couleurs). base = couleur d'origine.
export const COLOR_SLOTS = [
  { k: 'ready', label: 'Prêt (avant le GO)', base: 'white' },
  { k: 'lights', label: 'Feux de départ', base: 'red' },
  { k: 'green', label: 'Départ / reprise', base: 'green' },
  { k: 'racing', label: 'Course en cours', base: 'white' },
  { k: 'vsc', label: 'VSC', base: 'orange' },
  { k: 'red', label: 'Drapeau rouge', base: 'red' },
  { k: 'twoLapsA', label: 'Deux tours restants (1re couleur)', base: 'white' },
  { k: 'twoLapsB', label: 'Deux tours restants (2e couleur)', base: 'blue' },
  { k: 'finish', label: 'Arrivée', base: 'blue' },
  { k: 'end', label: 'Fin de séance', base: 'white' },
];
const SLOT = Object.fromEntries(COLOR_SLOTS.map((x) => [x.k, x]));

/**
 * Couleur d'une situation de course (ou d'un nom de base), avec les réglages de l'utilisateur :
 * couleur propre à la situation, sinon sa couleur de base personnalisée, sinon l'origine.
 */
export function paletteColor(app, key) {
  const p = app?.lightSync?.palette || {};
  const slot = SLOT[key];
  if (slot) return p['s:' + key] || p[slot.base] || DEFAULT_PALETTE[slot.base];
  return p[key] || DEFAULT_PALETTE[key];
}
/** Couleur d'origine d'une situation (pour savoir si elle a été modifiée). */
export const originColor = (key) => DEFAULT_PALETTE[SLOT[key]?.base || key];
export const cssOf = (c) => `rgb(${Math.round(c[0] * 2.55)},${Math.round(c[1] * 2.55)},${Math.round(c[2] * 2.55)})`;

export const LIGHT_SCENES = [
  { k: 'ready', label: 'Prêt (avant le GO)', c: 'ready' },
  { k: 'lights', label: 'Feux de départ', c: 'lights' },
  { k: 'green', label: 'Départ / reprise (2 secondes)', c: 'green' },
  { k: 'racing', label: 'Course en cours (rien de spécial)', c: 'racing' },
  { k: 'vsc', label: 'VSC', c: 'vsc' },
  { k: 'red', label: 'Drapeau rouge', c: 'red' },
  { k: 'twoLaps', label: 'Deux tours restants : 2 clignotements rapides blanc / bleu', alt: ['twoLapsA', 'twoLapsB'] },
  { k: 'finish', label: 'Arrivée : bleu fixe 5 s', c: 'finish' },
  { k: 'end', label: 'Ensuite (fin de séance)', c: 'end' },
];

/** Aperçu d'une scène pour le tableau des réglages. */
export function sceneCss(app, scene) {
  if (scene.alt) return `linear-gradient(90deg,${cssOf(paletteColor(app, scene.alt[0]))} 50%,${cssOf(paletteColor(app, scene.alt[1]))} 50%)`;
  return cssOf(paletteColor(app, scene.c));
}

const FINISH_MS = 5000; // alternance bleu / blanc à l'arrivée
const ALT_STEPS = [2000, 1000]; // alternance de l'arrivée : bleu 2 s, puis blanc 1 s, et on recommence
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
  // départ ou reprise (fin de VSC, de drapeau rouge) : vert 2 secondes, puis blanc
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
let flashing = false; // un clignotement ponctuel est en cours (deux tours restants…)

/**
 * Clignotement ponctuel par-dessus la scène en cours, puis retour à la scène.
 * Deux tours restants : blanc / bleu, deux fois, rapidement.
 */
export async function flashTwoLaps(app) {
  const outs = app.lightOutputs ? app.lightOutputs() : [];
  if (!outs.length || !app.lightSync?.enabled || flashing) return;
  flashing = true;
  clearTimeout(blinkTimer);
  const [a, b] = LIGHT_SCENES.find((x) => x.k === 'twoLaps').alt.map((n) => paletteColor(app, n));
  try {
    for (let i = 0; i < 2; i++) {
      for (const c of [a, b]) {
        outs.forEach((o) => o.setColor(...c));
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  } finally {
    flashing = false;
    last = null;
    syncLights(app, { force: true }); // retour à la scène de la course
  }
}

export function syncLights(app, { force = false } = {}) {
  if (flashing) return;
  // toutes les lampes connectées (rampe Chihiros + autres lampes) reçoivent la même scène
  const outs = app.lightOutputs ? app.lightOutputs() : [];
  if (!outs.length || !app.lightSync?.enabled) { last = null; return; }
  const L = { setColor: (r, g, b) => outs.forEach((o) => o.setColor(r, g, b)) };
  const k = sceneFor(app.session);
  if (!k) return;
  noteScene(k);
  const scene = LIGHT_SCENES.find((x) => x.k === k);
  const step = stepFor(app, k);
  // alternance de deux couleurs (arrivée) : bleu 2 s, blanc 1 s…
  let phase = null;
  if (scene.alt) {
    const cycle = ALT_STEPS[0] + ALT_STEPS[1];
    const t = (performance.now() - endSince) % cycle;
    const n = Math.floor((performance.now() - endSince) / cycle);
    phase = t < ALT_STEPS[0] ? `0.${n}` : `1.${n}`; // le n° de cycle distingue chaque passage
  }
  const key = step !== null ? `${k}:${step}` : phase !== null ? `${k}~${phase}` : k;
  if (key === last && !force) return;
  const blink = step !== null && last !== null && key !== last && !force;
  last = key;
  const color = paletteColor(app, scene.alt ? scene.alt[+phase[0]] : scene.c);
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
