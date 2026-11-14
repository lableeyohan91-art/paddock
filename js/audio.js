// Sons (bips des feux) et annonces vocales en français.

let ctx = null;
export const audio = { voice: true, sounds: true };

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function beep(freq = 880, ms = 180, vol = 0.25) {
  if (!audio.sounds) return;
  try {
    const c = ac();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.value = vol;
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + ms / 1000);
    o.connect(g).connect(c.destination);
    o.start();
    o.stop(c.currentTime + ms / 1000);
  } catch { /* audio indisponible */ }
}

/** Débloque l'audio (doit être appelé lors d'un clic). */
export function unlockAudio() {
  try { ac(); } catch { /* ignore */ }
}

let frVoice = null;
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  frVoice = voices.find((v) => v.lang?.startsWith('fr')) || null;
}
if (typeof speechSynthesis !== 'undefined') {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

export function say(text, { priority = false } = {}) {
  if (!audio.voice || typeof speechSynthesis === 'undefined') return;
  if (priority) speechSynthesis.cancel();
  if (speechSynthesis.pending && !priority) return; // évite d'empiler
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'fr-FR';
  if (frVoice) u.voice = frVoice;
  u.rate = 1.1;
  speechSynthesis.speak(u);
}

/** Temps en français parlé : 6234 ms -> "6 secondes 23". */
export function spokenTime(ms) {
  const s = Math.floor(ms / 1000);
  const cs = Math.floor((ms % 1000) / 10);
  if (s >= 60) {
    const m = Math.floor(s / 60);
    return `${m} minute${m > 1 ? 's' : ''} ${s % 60} ${String(cs).padStart(2, '0')}`;
  }
  return `${s} secondes ${String(cs).padStart(2, '0')}`;
}
