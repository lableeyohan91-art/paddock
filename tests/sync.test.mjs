// Tests de la fusion de synchronisation : node tests/sync.test.mjs
import assert from 'node:assert/strict';
import { planMerge } from '../js/sync.js';

const R = (obj, extra = {}) => ({ json: JSON.stringify(obj), _upd: obj._upd || 0, _seed: !!obj._seed, _deleted: false, ...extra });
const ids = (list) => list.map((o) => o.id ?? o).sort();

// 1. Téléphone neuf (données par défaut) qui se connecte à un compte rempli depuis le PC
{
  const local = new Map([['d1', { id: 'd1', name: 'Pilote 1', _upd: 0, _seed: true }]]);
  const remote = new Map([
    ['d1', R({ id: 'd1', name: 'Florent', _upd: 0 })],          // PC : ancienne donnée sans horodatage
    ['d9', R({ id: 'd9', name: 'Yohan', _upd: 500 })],
  ]);
  const p = planMerge('drivers', local, remote);
  assert.deepEqual(ids(p.toLocal), ['d1', 'd9']);                 // le vrai nom remplace "Pilote 1"
  assert.equal(p.toRemote.length, 0);                              // rien du téléphone ne remonte
}
// 2. PC (vraies données sans horodatage) qui se connecte après un téléphone neuf
{
  const local = new Map([['d1', { id: 'd1', name: 'Florent' }]]);
  const remote = new Map([['d1', R({ id: 'd1', name: 'Pilote 1', _seed: true })]]);
  const p = planMerge('drivers', local, remote);
  assert.deepEqual(ids(p.toRemote), ['d1']);                       // la vraie donnée gagne
  assert.equal(p.toLocal.length, 0);
}
// 3. La plus récente gagne ; égalité -> en ligne
{
  const local = new Map([['a', { id: 'a', v: 1, _upd: 100 }], ['b', { id: 'b', v: 1, _upd: 300 }], ['c', { id: 'c', v: 1, _upd: 50 }]]);
  const remote = new Map([['a', R({ id: 'a', v: 2, _upd: 200 })], ['b', R({ id: 'b', v: 2, _upd: 200 })], ['c', R({ id: 'c', v: 2, _upd: 50 })]]);
  const p = planMerge('cars', local, remote);
  assert.deepEqual(ids(p.toLocal), ['a', 'c']);
  assert.deepEqual(ids(p.toRemote), ['b']);
}
// 4. Suppressions
{
  const local = new Map([['x', { id: 'x', _upd: 100 }], ['y', { id: 'y', _upd: 900 }]]);
  const remote = new Map([
    ['x', { json: null, _upd: 200, _seed: false, _deleted: true }],  // supprimé ailleurs après -> supprimer
    ['y', { json: null, _upd: 200, _seed: false, _deleted: true }],  // modifié ici après -> on le renvoie
    ['z', { json: null, _upd: 200, _seed: false, _deleted: true }],  // inconnu ici -> rien
  ]);
  const p = planMerge('laps', local, remote);
  assert.deepEqual(p.deleteLocal, ['x']);
  assert.deepEqual(ids(p.toRemote), ['y']);
  assert.equal(p.toLocal.length, 0);
}
// 5. Réglages propres à l'appareil jamais synchronisés
{
  const local = new Map([['lastConnection', { key: 'lastConnection', value: 'ble' }], ['voice', { key: 'voice', value: true, _upd: 5 }]]);
  const p = planMerge('settings', local, new Map([['lastConnection', R({ key: 'lastConnection', value: 'sim', _upd: 9 })]]));
  assert.deepEqual(p.toRemote.map((o) => o.key), ['voice']);
  assert.equal(p.toLocal.length, 0);
}
console.log('Synchronisation : tous les tests passent');
