// Import des records SmartRace : chaque nom est associé à un profil pilote
// existant (ou créé), chaque voiture à une voiture existante (ou créée).
// Les records deviennent des tours "importés" : ils comptent pour les meilleurs
// temps et le graphique de progression, pas pour les compteurs (tours, roulage).

import { esc, $, $$, modal, toast } from '../ui.js';
import { fmtTime } from '../race.js';
// Le fichier des records (prénoms + temps) reste sur le PC : il n'est pas publié
// en ligne (.gitignore). Il est chargé seulement s'il est présent.
let RECORDS = [];
let IMPORT_ID = 'smartrace-2026-11-14';
async function loadRecords() {
  try {
    const m = await import('../imports/smartrace-records.js');
    RECORDS = m.RECORDS;
    IMPORT_ID = m.IMPORT_ID;
    return RECORDS.length > 0;
  } catch {
    return false;
  }
}

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Profil existant le plus probable pour un nom (exact, puis début de nom). */
function guess(list, name) {
  const n = norm(name);
  return list.find((x) => norm(x.name) === n)
    || list.find((x) => norm(x.name).length >= 3 && (n.startsWith(norm(x.name)) || norm(x.name).startsWith(n)))
    || null;
}

export async function importDone(app) {
  if (!(await loadRecords())) return true; // rien à importer sur cet appareil
  return app.db.getSetting('import:' + IMPORT_ID, false);
}

export async function openImport(app, { onDone } = {}) {
  if (!(await loadRecords())) {
    toast('Aucun record SmartRace à importer sur cet appareil (fais l\'import sur le PC puis Exporter → Importer).', 5000);
    return;
  }
  const names = [...new Set(RECORDS.map((r) => r.driver))];
  const cars = [...new Set(RECORDS.map((r) => r.car))];
  const drvOpts = (name) => {
    const g = guess(app.data.drivers, name);
    return `<option value="__new">➕ Créer « ${esc(name)} »</option>` +
      app.data.drivers.map((d) => `<option value="${esc(d.id)}" ${g?.id === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
  };
  const carOpts = (name) => {
    const g = guess(app.data.cars, name);
    return `<option value="__new">➕ Créer « ${esc(name)} »</option>` +
      app.data.cars.map((c) => `<option value="${esc(c.id)}" ${g?.id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  };
  const today = new Date().toISOString().slice(0, 10);
  const future = RECORDS.filter((r) => r.date > today);

  const m = modal(`
    <h2>📥 Import des records SmartRace</h2>
    <p class="muted" style="margin-top:-6px;font-size:.88rem">${RECORDS.length} meilleurs temps pour ${names.length} pilotes.
      Vérifie à quel profil va chaque nom, puis importe. Ils apparaîtront dans les records et le graphique de chaque fiche pilote.</p>
    <label class="field" style="margin-bottom:12px">Circuit de ces records
      <select id="imTrack">${app.data.tracks.map((t) => `<option value="${esc(t.id)}" ${t.id === app.setup?.trackId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
    <h3>Pilotes</h3>
    <div class="imp-grid">
      ${names.map((n) => `
      <div class="imp-row"><span class="imp-name">${esc(n)}</span>
        <select data-drv="${esc(n)}">${drvOpts(n)}</select>
        <span class="muted num imp-times">${RECORDS.filter((r) => r.driver === n).map((r) => fmtTime(r.time)).join(' · ')}</span></div>`).join('')}
    </div>
    <h3>Voitures</h3>
    <div class="imp-grid">
      ${cars.map((c) => `<div class="imp-row"><span class="imp-name">${esc(c)}</span><select data-car="${esc(c)}">${carOpts(c)}</select></div>`).join('')}
    </div>
    ${future.length ? `<p class="warnbox" style="margin-top:12px">⚠️ Date dans le futur : ${future.map((r) => `${esc(r.driver)} ${fmtTime(r.time)} le ${r.date.split('-').reverse().join('/')}`).join(', ')}. Importé tel quel : dis-le-moi si c'est une faute de frappe.</p>` : ''}
    <div class="row" style="justify-content:flex-end;margin-top:14px">
      <button class="btn ghost" data-close>Plus tard</button>
      <button class="btn primary" id="imGo">Importer ${RECORDS.length} records</button>
    </div>`);

  $('#imGo', m.el).onclick = async () => {
    const trackId = $('#imTrack', m.el).value;
    const drvMap = {}, carMap = {};
    const colors = ['#e10600', '#ff8a00', '#facc15', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899'];
    let created = 0;
    for (const sel of $$('[data-drv]', m.el)) {
      let id = sel.value;
      if (id === '__new') {
        const d = await app.db.put('drivers', { name: sel.dataset.drv, color: colors[created++ % colors.length], photo: null, created: Date.now() });
        id = d.id;
      }
      drvMap[sel.dataset.drv] = id;
    }
    for (const sel of $$('[data-car]', m.el)) {
      let id = sel.value;
      if (id === '__new') id = (await app.db.put('cars', { name: sel.dataset.car, created: Date.now() })).id;
      carMap[sel.dataset.car] = id;
    }
    const laps = RECORDS.map((r) => ({
      sessionId: 'import-' + r.date,
      sessionType: 'import',
      trackId,
      driverId: drvMap[r.driver],
      carId: carMap[r.car],
      lapNo: 1,
      time: r.time,
      sectors: [],
      flag: 'green',
      wetness: 0,
      date: new Date(r.date + 'T12:00:00').getTime(),
      imported: IMPORT_ID,
    }));
    await app.db.putMany('laps', laps);
    await app.db.setSetting('import:' + IMPORT_ID, true);
    await app.loadData();
    m.close();
    toast(`📥 ${laps.length} records SmartRace importés`);
    app.log(`Import SmartRace : ${laps.length} records`);
    onDone?.();
  };
}

/** Retire tous les tours importés (pour recommencer l'import). */
export async function removeImport(app) {
  await loadRecords();
  const all = await app.db.all('laps');
  const ids = all.filter((l) => l.imported === IMPORT_ID).map((l) => l.id);
  for (const id of ids) await app.db.remove('laps', id);
  await app.db.setSetting('import:' + IMPORT_ID, false);
  return ids.length;
}
