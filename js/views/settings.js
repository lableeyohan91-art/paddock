// Réglages : connexion, sons, sauvegarde, diagnostic.

import { esc, $, toast, download, confirmBox } from '../ui.js';
import { audio, say } from '../audio.js';
import { MODE } from '../cu/protocol.js';
import { renderFuel } from './fuel-settings.js';
import { vscSpeed } from '../performance.js';
import { openImport, importDone, removeImport } from './import-records.js';

let app;
let root;

// Écran d'accueil des Réglages : des tuiles, comme le menu (Général, Essence…)
const SECTIONS = [
  { k: 'general', ico: '⚙️', name: 'Général' },
  { k: 'fuel', ico: '⛽', name: 'Essence' },
  { k: 'vsc', ico: '<span class="vsc-ico">VSC</span>', name: 'VSC' }, // même icône que le bouton en course
];
let tab = 'menu';
let openFuelNext = false;

export function mount(main, a) {
  app = a;
  root = main;
  tab = openFuelNext ? 'fuel' : 'menu'; // l'onglet Réglages s'ouvre sur les tuiles
  openFuelNext = false;
  render();
}

/** En-tête d'une section : retour aux tuiles + titre. */
function sectionHead() {
  const sec = SECTIONS.find((x) => x.k === tab);
  return `<div class="row" style="justify-content:space-between;margin-bottom:12px">
      <button class="btn small ghost" data-back>← Réglages</button>
      <h1 class="menu-title" style="margin:0">${sec.ico} ${sec.name}</h1>
      <span style="width:80px"></span>
    </div>`;
}

function bindTabs() {
  root.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(); window.scrollTo(0, 0); }));
  const back = root.querySelector('[data-back]');
  if (back) back.onclick = () => { tab = 'menu'; render(); window.scrollTo(0, 0); };
}

function render() {
  if (tab === 'menu') {
    root.innerHTML = `
    <div class="race-menu">
      <h1 class="menu-title">Réglages</h1>
      <div class="menu-grid">
        ${SECTIONS.map((x) => `<button class="menu-tile" data-tab="${x.k}"><span class="menu-ico">${x.ico}</span><span class="menu-name">${x.name}</span></button>`).join('')}
      </div>
    </div>`;
    bindTabs();
    return;
  }
  if (tab === 'vsc') {
    renderVsc();
    bindTabs();
    return;
  }
  if (tab === 'fuel') {
    root.innerHTML = sectionHead() + '<div id="fuelRoot"></div>';
    bindTabs();
    renderFuel($('#fuelRoot', root), app);
    return;
  }
  renderGeneral();
  bindTabs();
}

/** Réglages → VSC : vitesse imposée aux voitures pendant le Virtual Safety Car. */
function renderVsc() {
  const pct = app.vscCfg.speedPct;
  root.innerHTML = sectionHead() + `
  <section class="panel">
    <h2>Virtual Safety Car</h2>
    <p class="muted" style="margin-top:-4px">En course, le bouton <b>VSC</b> met immédiatement <b>toutes les voitures à la même vitesse fixe</b>, quel que soit leur réglage du garage (comme la panne sèche en vitesse fixe). Un second appui rend la course.</p>
    <div class="row" style="gap:14px;margin-top:14px">
      <label class="field" style="flex:1">Vitesse sous VSC
        <input type="range" id="vscPct" min="5" max="100" step="5" value="${pct}"></label>
      <span class="vsc-pct num" id="vscPctV">${pct} %</span>
    </div>
    <p class="muted" style="font-size:.85rem;margin:8px 0 0" id="vscEx"></p>
    <button class="btn small ghost" id="vscReset" style="margin-top:10px">Revenir à 20 % (nominal)</button>
  </section>`;
  const r = $('#vscPct', root);
  const show = (v) => {
    $('#vscPctV', root).textContent = v + ' %';
    $('#vscEx', root).textContent = `${v} % de la vitesse max = vitesse ${vscSpeed(v)}/15 pour toutes les voitures (une voiture réglée plus lentement garde son allure).`;
  };
  show(pct);
  r.oninput = () => show(+r.value);
  r.onchange = async () => { await app.saveVscCfg({ speedPct: +r.value }); toast('VSC : ' + r.value + ' %', 1200); };
  $('#vscReset', root).onclick = async () => { await app.saveVscCfg({ speedPct: 20 }); renderVsc(); bindTabs(); };
}

/** Ouvre directement Réglages → Essence (depuis un autre écran). */
export function openFuel() {
  openFuelNext = true;
}

function renderGeneral() {
  const cu = app.cu;
  root.innerHTML = sectionHead() + `
  <div class="grid grid-2">
    <section class="panel">
      <h2>Circuit</h2>
      <p>${cu.conn ? `✅ Connecté à <b>${esc(cu.conn.name)}</b> — Control Unit version ${esc(cu.version || '?')}` : 'Non connecté.'}</p>
      <div id="cuInfo" class="muted" style="font-size:.9rem"></div>
      <div class="row" style="margin-top:12px">
        <button class="btn primary" id="conn">${cu.conn ? 'Déconnecter' : 'Connecter'}</button>
      </div>
      <h3>Seuil anti-rebond</h3>
      <label class="field">Tour minimum valide (secondes) : ignore les doubles détections sur la ligne
        <input type="number" id="minLap" min="0.5" max="30" step="0.1" value="${(app.setup.minLapMs / 1000).toFixed(1)}" style="width:110px"></label>
    </section>

    <section class="panel">
      <h2>Sons et annonces</h2>
      <label class="row"><input type="checkbox" id="voice" ${audio.voice ? 'checked' : ''}> Annonces vocales (meilleurs tours, météo, drapeaux, arrivée)</label>
      <label class="row" style="margin-top:8px"><input type="checkbox" id="sounds" ${audio.sounds ? 'checked' : ''}> Bips des feux de départ</label>
      <button class="btn" style="margin-top:12px" id="testVoice">🔊 Tester la voix</button>
    </section>

    <section class="panel">
      <h2>Sauvegarde</h2>
      <p class="muted" style="margin-top:-6px">Les données restent dans ce navigateur. Exporte-les pour les sauvegarder ou les transférer sur ton téléphone.</p>
      <div class="row">
        <button class="btn" id="exp">⬇ Exporter</button>
        <label class="btn">⬆ Importer<input type="file" id="imp" accept="application/json" hidden></label>
      </div>
      <h3>Statistiques</h3>
      <p class="muted" style="margin:0 0 8px;font-size:.85rem">Les tours faits avec le simulateur ne sont jamais enregistrés.</p>
      <button class="btn danger" id="clearStats">🗑 Réinitialiser les statistiques</button>
      <h3>Records SmartRace</h3>
      <div class="row">
        <button class="btn" id="impOpen">📥 Importer les records SmartRace</button>
        <button class="btn ghost" id="impUndo">Annuler l'import</button>
      </div>
    </section>

    <section class="panel">
      <h2>Diagnostic</h2>
      <div class="muted" id="diag" style="font-size:.85rem;margin-bottom:8px"></div>
      <div class="log" id="log">${app.logLines.map(esc).join('<br>')}</div>
      <h3>Dernières réponses du circuit</h3>
      <div class="log" id="trace" style="max-height:260px"></div>
      <h3>Session</h3>
      <div class="muted" id="sessDiag" style="font-size:.85rem"></div>
    </section>
  </div>`;

  $('#conn', root).onclick = async () => {
    if (cu.conn) { await cu.disconnect(); render(); } else app.openConnectDialog();
  };
  $('#minLap', root).onchange = (e) => {
    app.setup.minLapMs = Math.round(Math.max(0.5, parseFloat(e.target.value) || 1.5) * 1000);
    app.saveSetup();
    if (app.session) app.session.cfg.minLapMs = app.setup.minLapMs;
  };
  $('#voice', root).onchange = (e) => { audio.voice = e.target.checked; app.db.setSetting('voice', audio.voice); };
  $('#sounds', root).onchange = (e) => { audio.sounds = e.target.checked; app.db.setSetting('sounds', audio.sounds); };
  $('#testVoice', root).onclick = () => say('Meilleur tour pour Pilote 1, 6 secondes 23', { priority: true });
  $('#exp', root).onclick = async () => {
    const data = await app.db.exportAll();
    download(`paddock-sauvegarde-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data));
  };
  $('#impOpen', root).onclick = async () => {
    if (await importDone(app)) { toast('Déjà importés. « Annuler l\'import » pour recommencer.', 3500); return; }
    openImport(app);
  };
  $('#impUndo', root).onclick = async () => {
    if (!(await confirmBox('Retirer les records SmartRace importés ? Les pilotes et voitures créés à l\'import restent.'))) return;
    const n = await removeImport(app);
    toast(`${n} records retirés`);
  };
  $('#clearStats', root).onclick = async () => {
    if (!(await confirmBox('Effacer définitivement tous les tours et sessions enregistrés ? Les pilotes, voitures et réglages du garage sont conservés. Pense à exporter une sauvegarde avant si besoin.'))) return;
    await app.db.clearStats();
    toast('Statistiques remises à zéro');
  };
  $('#imp', root).onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    if (!(await confirmBox('Importer cette sauvegarde ? Les éléments de même identifiant seront remplacés.'))) return;
    try {
      await app.db.importAll(JSON.parse(await f.text()));
      await app.loadData();
      toast('Sauvegarde importée');
    } catch (err) {
      toast('Import impossible : ' + err.message, 4000);
    }
  };
  tick();
}

export function tick() {
  if (!root) return;
  const cu = app.cu;
  const st = cu.status;
  const info = $('#cuInfo', root);
  if (info) {
    info.innerHTML = st ? [
      st.mode & MODE.FUEL ? '⛽ Mode carburant activé' : 'Mode carburant désactivé',
      st.mode & MODE.PIT_LANE ? '🔧 Voie des stands détectée' : 'Voie des stands non détectée',
      st.mode & MODE.LAP_COUNTER ? 'Compte-tours détecté' : '',
    ].filter(Boolean).join('<br>') : '';
  }
  const d = $('#diag', root);
  if (d) {
    const c = cu.counts || {};
    d.textContent = (app.version ? `Version de l'appli : ${new Date(app.version).toLocaleString('fr-FR')} · ` : '') + `Requêtes : ${cu.stats.requests} · erreurs : ${cu.stats.errors} · passages : ${cu.stats.timers}`
      + ` · réponses état/passage/inconnues : ${c.status || 0}/${c.timer || 0}/${c.unknown || 0}`;
  }
  const tr = $('#trace', root);
  if (tr) {
    const html = (cu.trace || []).slice().reverse()
      .map((x) => `${esc(x.time)}  <b>${esc(JSON.stringify(x.raw))}</b>  → ${esc(x.desc)}`).join('<br>');
    if (tr.innerHTML !== html) tr.innerHTML = html || 'Aucune réponse pour le moment.';
  }
  const sd = $('#sessDiag', root);
  if (sd) {
    const s = app.session;
    sd.textContent = s
      ? `Type : ${s.cfg.type} · état : ${s.state} · départ : ${s.cfg.start} · pilotes : ${[...s.comps.values()].map((x) => `#${x.address + 1}=${x.laps} tours`).join(', ')}`
      : 'Aucune session préparée.';
  }
}

export function onLog(line) {
  const el = root && $('#log', root);
  if (!el) return;
  el.insertAdjacentHTML('beforeend', (el.innerHTML ? '<br>' : '') + esc(line));
  el.scrollTop = el.scrollHeight;
}

export function unmount() {
  root = null;
}

export function refresh() {
  if (root && tab === 'general') render(); // ne pas casser une saisie en cours dans l'onglet Essence
}
