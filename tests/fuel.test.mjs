// Tests de la consommation d'essence : node tests/fuel.test.mjs
import assert from 'node:assert/strict';
import { defaultFuelConfig, consumption, sanitize } from '../js/fuel.js';

const c = defaultFuelConfig();
const p = (s) => consumption(c, s * 1000).pct;
assert.equal(p(3.6), 5);    // nominale
assert.equal(p(3.45), 6);   // rapide 1
assert.equal(p(3.35), 7);
assert.equal(p(3.25), 8);
assert.equal(p(3.15), 10);
assert.equal(p(2.9), 10);   // plus rapide que tout -> la plus rapide
assert.equal(p(3.75), 4);   // lent 1
assert.equal(p(3.9), 3);
assert.equal(p(7), 1);      // plus lent que tout -> la plus lente
c.faster[0].on = false;     // fourchette désactivée -> trou -> nominale
assert.equal(p(3.45), 5);
c.mode = 'fixed';
assert.equal(p(3.15), 5);
const s = sanitize({ nominalPct: 99, faster: [{ pct: 0, min: 1, max: 50 }] });
assert.equal(s.nominalPct, 40);
assert.deepEqual([s.faster[0].pct, s.faster[0].min, s.faster[0].max], [1, 2, 30]);
console.log('Essence : tous les tests passent');
