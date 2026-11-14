// Tests du protocole : node tests/protocol.test.mjs
import assert from 'node:assert/strict';
import * as P from '../js/cu/protocol.js';

// Valeurs de référence calculées depuis carreralib
assert.equal(P.cmdPress(2), 'T22');
assert.equal(P.cmdReset(), '=101');
// setword(0, address 1, value 10, repeat 2): B(0|1<<5=32) -> '0','2' ; Y 10 -> ':' ; Y 2 -> '2'
// somme: 0x30+0x32+0x3a+0x32 = 0xce -> 0xe -> '>'
assert.equal(P.cmdSetSpeed(1, 10), 'J02:2>');
assert.deepEqual(P.parseSetWord(P.cmdSetSpeed(3, 7)), { word: 0, address: 3, value: 7, repeat: 2 });

// Entier 32 bits aller-retour
for (const v of [0, 1, 0x12345678, 0xffffffff, 987654321]) {
  assert.equal(P.unpackInt(P.packInt(v)), v);
}

// Réponse timer (voiture adresse 2, secteur 1)
const t = P.parseResponse(P.encodeTimer(2, 123456, 1) + '$');
assert.deepEqual(t, { type: 'timer', address: 2, timestamp: 123456, sector: 1 });
// Format BLE : sans le '?' initial
const tBle = P.parseResponse(P.encodeTimer(5, 42, 1).slice(1) + '$');
assert.equal(tBle.address, 5);
assert.equal(tBle.timestamp, 42);

// Réponse état
const s = P.parseResponse(P.encodeStatus({
  fuel: [15, 14, 13, 12, 11, 10, 9, 8], start: 3, mode: 5, pitMask: 0b101, display: 1,
}) + '$');
assert.equal(s.type, 'status');
assert.deepEqual(s.fuel, [15, 14, 13, 12, 11, 10, 9, 8]);
assert.equal(s.start, 3);
assert.equal(s.mode, 5);
assert.deepEqual(s.pit.slice(0, 3), [true, false, true]);

// Version : série "0xxxxC" et BLE sans préfixe
assert.equal(P.parseResponse('053370$').version, '5337');
assert.equal(P.parseResponse('53370$').version, '5337');

console.log('Protocole : tous les tests passent');
