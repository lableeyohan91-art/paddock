// Réglages : connexion, sons, sauvegarde, diagnostic.

import { esc, $, toast, download, confirmBox, modal } from '../ui.js';
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
  { k: 'devices', ico: '🔌', name: 'Appareils connectés' },
];
let tab = 'menu';

// Aide de chaque tuile (bouton « ? ») : à quoi sert la fonction et comment elle marche
const HELP = {
  general: `
    <p>Les réglages de base de l'appli.</p>
    <ul>
      <li><b>Circuit</b> : connecter ou déconnecter la Control Unit (Bluetooth AppConnect ou simulateur), voir sa version et ce qu'elle détecte (mode carburant, voie des stands).</li>
      <li><b>Seuil anti-rebond</b> : un passage plus court que ce temps est ignoré (évite qu'une voiture compte deux tours d'un coup sur la ligne).</li>
      <li><b>Sons et annonces</b> : bips et annonces vocales (départ, meilleurs tours, drapeaux, VSC…).</li>
      <li><b>Sauvegarde</b> : exporter / importer toutes les données, effacer les statistiques, importer des records SmartRace.</li>
      <li><b>Diagnostic</b> : ce que la Control Unit répond, en direct. Utile si les tours ne se comptent pas.</li>
    </ul>`,
  fuel: `
    <p>L'appli <b>simule l'essence</b> de chaque voiture pendant la course : plus on roule vite, plus on consomme.</p>
    <ul>
      <li><b>Consommation</b> : chaque tour retire un pourcentage selon le temps au tour (9 fourchettes, de très rapide à très lent).</li>
      <li><b>Stand</b> : une voiture arrêtée dans la voie des stands fait le plein (15 % par seconde par défaut).</li>
      <li><b>Panne sèche</b> : à 0 %, la voiture est bridée (en % de sa vitesse ou à une vitesse fixe) jusqu'à ce qu'elle ravitaille.</li>
      <li><b>Setups</b> : enregistre tes réglages (ex. « Équilibré 50/100 tours », « Sprint 30 tours ») et recharge-les d'un clic.</li>
    </ul>
    <p class="muted">En course, l'essence s'active ou se désactive dans la case Essence de l'écran de préparation, avec la taille du réservoir.</p>`,
  vsc: `
    <p>Le <b>Virtual Safety Car</b> neutralise la course sans l'arrêter, par exemple après une sortie de piste.</p>
    <ul>
      <li>En course, le bouton <b>VSC</b> met <b>toutes les voitures à la même vitesse fixe</b>, quel que soit leur réglage du garage. Ce réglage fixe cette vitesse, en % de la vitesse max (20 % = vitesse 3/15).</li>
      <li>Une voiture <b>en panne sèche</b> garde sa vitesse de panne sèche : le VSC ne s'y ajoute pas.</li>
      <li>La vitesse est <b>renvoyée deux fois par seconde</b> : une voiture remise en piste ralentit tout de suite.</li>
      <li>Un second appui lance un <b>décompte de 3 secondes</b> (« Fin du VSC dans 3, 2, 1, Go ! ») puis chacun retrouve sa vitesse.</li>
      <li>Les pilotes peuvent aussi le déclencher depuis leur <b>vue pilote</b> (QR code).</li>
    </ul>`,
};

HELP.devices = `
    <p>Les appareils que Paddock peut piloter en plus du circuit.</p>
    <ul>
      <li><b>Éclairage</b> : une rampe LED <b>Chihiros WRGB II</b> en Bluetooth. Paddock change sa couleur. Prochaine étape : la couleur suit la course (jaune au drapeau jaune, rouge au drapeau rouge…).</li>
      <li>La rampe se connecte depuis ce téléphone en Bluetooth, en même temps que la Control Unit. Ferme l'appli « My Chihiros » avant, sinon elle garde la rampe pour elle.</li>
    </ul>`;

function showHelp(k) {
  const sec = SECTIONS.find((x) => x.k === k);
  modal(`<h2 style="margin-top:0">${sec.ico} ${sec.name}</h2><div class="help-body">${HELP[k] || ''}</div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn primary" data-close>Compris</button></div>`);
}
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
  root.querySelectorAll('[data-help]').forEach((b) => (b.onclick = () => showHelp(b.dataset.help)));
  const back = root.querySelector('[data-back]');
  if (back) back.onclick = () => { tab = 'menu'; render(); window.scrollTo(0, 0); };
}

function render() {
  if (tab === 'menu') {
    root.innerHTML = `
    <div class="race-menu">
      <h1 class="menu-title">Réglages</h1>
      <div class="menu-grid">
        ${SECTIONS.map((x) => `<div class="tile-wrap">
          <button class="menu-tile" data-tab="${x.k}"><span class="menu-ico">${x.ico}</span><span class="menu-name">${x.name}</span></button>
          <button class="tile-help" data-help="${x.k}" title="À quoi sert ${x.name} ?" aria-label="Aide : ${x.name}">?</button>
        </div>`).join('')}
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
  if (tab === 'devices') {
    renderDevices();
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

/** Réglages → Appareils connectés : pour l'instant un onglet Éclairage (rampe Chihiros). */
let devTab = 'lights';
const PRESETS = [
  { k: 'red', label: 'Rouge', c: [100, 0, 0], css: '#e10600' },
  { k: 'yellow', label: 'Jaune', c: [100, 60, 0], css: '#facc15' },
  { k: 'green', label: 'Vert', c: [0, 100, 0], css: '#22c55e' },
  { k: 'blue', label: 'Bleu', c: [0, 0, 100], css: '#3b82f6' },
  { k: 'white', label: 'Blanc', c: [100, 100, 100], css: '#ffffff' },
  { k: 'off', label: 'Éteint', c: [0, 0, 0], css: '#222' },
];

function renderDevices() {
  const L = app.lights;
  const st = L.status;
  const c = L.color || { r: 100, g: 100, b: 100 };
  root.innerHTML = sectionHead() + `
  <div class="subtabs small"><button class="on" data-devtab="lights">💡 Éclairage</button></div>
  <section class="panel">
    <h2>Rampe LED Chihiros</h2>
    ${!L.supported ? '<p class="warn-note">Bluetooth indisponible dans ce navigateur : utilise Chrome sur le téléphone ou le PC.</p>' : ''}
    <p id="lightState" class="light-state ${st}">${
      st === 'on' ? `✅ Connectée : <b>${esc(L.name)}</b>`
        : st === 'connecting' ? '⏳ Connexion…'
          : st === 'error' ? `⚠️ ${esc(L.error || 'Erreur')}`
            : L.name ? `Déconnectée (${esc(L.name)})` : 'Aucune rampe connectée.'}</p>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      ${st === 'on'
        ? '<button class="btn" id="lOff">Déconnecter</button>'
        : `<button class="btn primary" id="lConn" ${L.supported ? '' : 'disabled'}>🔗 Connecter ma rampe</button>
           ${L.device ? '<button class="btn" id="lRe">↻ Reconnecter</button>' : ''}
           <button class="btn ghost small" id="lAll" ${L.supported ? '' : 'disabled'}>Rampe introuvable ? Afficher tous les appareils</button>`}
    </div>
    <p class="muted" style="font-size:.85rem;margin:10px 0 0">Allume la rampe et <b>ferme l'appli My Chihiros</b> (une rampe n'accepte qu'une seule connexion à la fois). Le nom d'une WRGB II commence en général par <b>DY</b> (ex. DYWRGB…, DYNW…).</p>
  </section>

  <section class="panel" style="margin-top:14px">
    <h2>Essai des couleurs</h2>
    <div class="light-presets">
      ${PRESETS.map((p) => `<button class="light-chip" data-preset="${p.k}" ${st === 'on' ? '' : 'disabled'}><i style="background:${p.css}"></i>${p.label}</button>`).join('')}
    </div>
    <h3>Couleur sur mesure</h3>
    ${[['r', 'Rouge', '#e10600'], ['g', 'Vert', '#22c55e'], ['b', 'Bleu', '#3b82f6']].map(([k, l, col]) => `
    <div class="bar" style="--c:${col};--p:${c[k]}%">
      <span class="bar-l">${l}</span>
      <input type="range" min="0" max="100" step="5" value="${c[k]}" data-rgb="${k}" ${st === 'on' ? '' : 'disabled'} aria-label="${l}">
      <span class="bar-v num">${c[k]} %</span>
    </div>`).join('')}
    <div class="light-preview" id="lPreview"></div>
  </section>`;

  const preview = () => {
    const v = (k) => +$(`[data-rgb="${k}"]`, root).value;
    $('#lPreview', root).style.background = `rgb(${v('r') * 2.55},${v('g') * 2.55},${v('b') * 2.55})`;
  };
  preview();
  const act = async (fn) => { try { await fn(); } catch (e) { toast(e.message || String(e), 3500); } renderDevices(); bindTabs(); };
  const conn = $('#lConn', root);
  if (conn) conn.onclick = () => act(async () => { await L.connect(); toast('💡 Rampe connectée'); });
  const all = $('#lAll', root);
  if (all) all.onclick = () => act(async () => { await L.connect({ showAll: true }); toast('💡 Rampe connectée'); });
  const re = $('#lRe', root);
  if (re) re.onclick = () => act(() => L.reconnect());
  const off = $('#lOff', root);
  if (off) off.onclick = () => act(() => L.disconnect());
  root.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => {
    const p = PRESETS.find((x) => x.k === b.dataset.preset);
    L.setColor(...p.c);
    ['r', 'g', 'b'].forEach((k, i) => {
      const r = $(`[data-rgb="${k}"]`, root);
      r.value = p.c[i];
      r.parentElement.style.setProperty('--p', p.c[i] + '%');
      r.parentElement.querySelector('.bar-v').textContent = p.c[i] + ' %';
    });
    preview();
  }));
  root.querySelectorAll('[data-rgb]').forEach((r) => r.addEventListener('input', () => {
    r.parentElement.style.setProperty('--p', r.value + '%');
    r.parentElement.querySelector('.bar-v').textContent = r.value + ' %';
    preview();
    const v = (k) => +$(`[data-rgb="${k}"]`, root).value;
    L.setColor(v('r'), v('g'), v('b'));
  }));
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
