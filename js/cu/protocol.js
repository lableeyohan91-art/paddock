// Protocole de la Control Unit Carrera Digital 124/132.
// Implémentation fidèle à la bibliothèque open source carreralib (tkem, MIT).
// Chaque valeur est codée en caractères ASCII : '0' + quartet (0..15).

const BASE = 0x30; // '0'

export const BUTTON = {
  PACE_CAR_ESC: 1,
  START_ENTER: 2,
  SPEED: 5,
  BRAKE: 6,
  FUEL: 7,
  CODE: 8,
};

// Bits du champ "mode" de l'état.
export const MODE = {
  FUEL: 1,          // gestion carburant activée
  REAL: 2,          // mode carburant "réel"
  PIT_LANE: 4,      // adaptateur voie des stands connecté
  LAP_COUNTER: 8,   // compte-tours connecté
};

const nib = (n) => String.fromCharCode(BASE + (n & 0x0f));

/** Somme de contrôle : somme des octets après la lettre de commande, & 0x0F. */
export function checksum(str, offset = 1) {
  let s = 0;
  for (let i = offset; i < str.length; i++) s += str.charCodeAt(i);
  return s & 0x0f;
}

const withChecksum = (body) => body + nib(checksum(body));

/** Octet 'B' : quartet bas puis quartet haut. */
const packByte = (b) => nib(b) + nib(b >> 4);

// ---- Commandes (sans cadrage ; la connexion ajoute '"' et '$' si besoin) ----

export const cmdPoll = () => '?';
export const cmdVersion = () => '0';
export const cmdReset = () => withChecksum('=' + nib(1) + nib(0)); // "=101"
export const cmdPress = (button) => withChecksum('T' + nib(button));
export const cmdIgnore = (mask) => withChecksum(':' + packByte(mask));

export function cmdSetWord(word, address, value, repeat = 1) {
  if (word < 0 || word > 31) throw new RangeError('word');
  if (address < 0 || address > 7) throw new RangeError('address');
  if (value < 0 || value > 15) throw new RangeError('value');
  if (repeat < 1 || repeat > 15) throw new RangeError('repeat');
  return withChecksum('J' + packByte(word | (address << 5)) + nib(value) + nib(repeat));
}

export const cmdSetSpeed = (address, v) => cmdSetWord(0, address, v, 2);
export const cmdSetBrake = (address, v) => cmdSetWord(1, address, v, 2);
export const cmdSetFuel = (address, v) => cmdSetWord(2, address, v, 2);
export const cmdSetPos = (address, pos) => cmdSetWord(6, address, pos);
export const cmdClearPos = () => cmdSetWord(6, 0, 9);
export const cmdSetLapHi = (v) => cmdSetWord(17, 7, v);
export const cmdSetLapLo = (v) => cmdSetWord(18, 7, v);

// ---- Décodage des réponses ----

const vals = (s) => Array.from(s, (c) => c.charCodeAt(0) & 0x0f);

/** Entier 32 bits 'I' : octets gros-boutistes, quartet bas d'abord dans chaque octet. */
export function unpackInt(s) {
  const n = vals(s);
  return (
    ((n[1] << 28) | (n[0] << 24) | (n[3] << 20) | (n[2] << 16) |
     (n[5] << 12) | (n[4] << 8) | (n[7] << 4) | n[6]) >>> 0
  );
}

export function packInt(v) {
  return [24, 28, 16, 20, 8, 12, 0, 4].map((sh) => nib((v >>> sh) & 0xf)).join('');
}

/**
 * Décode une réponse brute (avec ou sans '?' initial, avec ou sans '$' final).
 * Retourne {type:'status'|'timer'|'version'|'unknown', ...}.
 */
export function parseResponse(raw) {
  let s = raw;
  if (s.endsWith('$') || s.endsWith('#')) s = s.slice(0, -1);
  if (s.startsWith('0') && s.length === 6) return { type: 'version', version: s.slice(1, 5) };
  if (s.startsWith('?')) s = s.slice(1);

  if (s.startsWith(':')) {
    // ':' + 8 carburant + départ + mode + pit(2) + affichage [+ 2 inutilisés] + somme
    const v = vals(s.slice(1));
    if (v.length < 13) return { type: 'unknown', raw };
    return {
      type: 'status',
      fuel: v.slice(0, 8),
      start: v[8],
      mode: v[9],
      pit: Array.from({ length: 8 }, (_, i) => ((v[10] | (v[11] << 4)) & (1 << i)) !== 0),
      display: v[12],
    };
  }
  if (s.length >= 11) {
    // adresse(Y) + horodatage(I) + secteur(Y) + somme
    const address = (s.charCodeAt(0) & 0x0f) - 1;
    const timestamp = unpackInt(s.slice(1, 9));
    const sector = s.charCodeAt(9) & 0x0f;
    return { type: 'timer', address, timestamp, sector };
  }
  if (s.length === 5) return { type: 'version', version: s.slice(0, 4) };
  return { type: 'unknown', raw };
}

// ---- Encodage des réponses (utilisé par le simulateur) ----

export function encodeTimer(address, timestamp, sector) {
  return withChecksum('?' + nib(address + 1) + packInt(timestamp) + nib(sector));
}

export function encodeStatus({ fuel, start, mode, pitMask, display }) {
  const body = '?:' + fuel.map(nib).join('') + nib(start) + nib(mode) + packByte(pitMask) + nib(display);
  return body + nib(checksum(body, 2));
}

/** Décode une commande 'J' (pour le simulateur). */
export function parseSetWord(cmd) {
  const v = vals(cmd.slice(1));
  const b = v[0] | (v[1] << 4);
  return { word: b & 0x1f, address: b >> 5, value: v[2], repeat: v[3] };
}
