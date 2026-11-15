// Réglages : connexion, sons, sauvegarde, diagnostic.

import { esc, $, toast, download, confirmBox, modal } from '../ui.js';
import { audio, say } from '../audio.js';
import { MODE } from '../cu/protocol.js';
import { renderFuel, openFuelTab } from './fuel-settings.js';
import { vscSpeed } from '../performance.js';
import { autoCfg } from '../autovsc.js';
import { COMPOUNDS, COMPOUND_INFO, DEFAULT_TYRES } from '../tyres.js';
import { LIGHT_SCENES, COLOR_SLOTS, paletteColor, sceneCss, cssOf } from '../devices/lightsync.js';
import { GenericLight, PROTOCOLS } from '../devices/generic-light.js';
import { openImport, importDone, removeImport } from './import-records.js';

let app;
let root;

// Écran d'accueil des Réglages : des tuiles, comme le menu (Général, Essence…)
const SECTIONS = [
  { k: 'general', ico: '⚙️', name: 'Général' },
  { k: 'fuel', ico: '⛽', name: 'Essence' },
  { k: 'vsc', ico: '<span class="vsc-ico">VSC</span>', name: 'VSC' }, // même icône que le bouton en course
  { k: 'tyres', ico: '🛞', name: 'Pneus' },
  { k: 'devices', ico: '💡', name: 'Éclairage connecté' },
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
      <li><b>VSC automatique</b> (2e onglet) : le VSC se déclenche tout seul quand une voiture ne repasse plus — <b>par tour</b> (pas de passage sur la ligne depuis X s) ou <b>par secteur</b> avec les Check Lane (Y s). Les voitures au stand, en panne sèche ou arrivées sont exclues.</li>
    </ul>`,
};

HELP.tyres = `
    <p>Trois gommes aux comportements bien marqués (mode arcade).</p>
    <ul>
      <li>Chaque gomme retire des <b>crans</b> à la programmation du pilote sur <b>sa</b> voiture : <b>Tendre</b> = sa programmation, <b>Medium</b> = 1 cran en dessous, <b>Dur</b> = 2 crans en dessous et un freinage moins fort. Le Tendre s'use vite, le Dur dure longtemps.</li>
      <li><b>Chute de grip</b> : elle arrive au hasard quand il reste entre 25 % et 15 % de santé. La voiture ne garde alors que 50 % de sa programmation (réglée à 8 → roule à 4).</li>
      <li><b>Crevaison</b> : sous 15 % de santé, risque à chaque passage sur la ligne (20 %, puis 50 % sous 7 %). À 0 %, c'est la crevaison. Une voiture crevée roule à la vitesse choisie (comme le VSC) jusqu'au stand.</li>
      <li><b>Chauffe</b> : après un changement, la voiture perd un cran pendant les tours de chauffe.</li>
      <li><b>Changement</b> : rester immobile quelques secondes dans la voie des stands. Chaque pilote choisit sa gomme sur sa <b>vue pilote</b> (ou on la choisit sur l'écran de course).</li>
      <li>Les pneus s'activent course par course sur l'écran de préparation. Pas d'effet pendant un VSC ou une panne sèche.</li>
    </ul>`;

HELP.devices = `
    <p>Les lampes que Paddock peut piloter en plus du circuit : elles prennent la couleur de la course.</p>
    <ul>
      <li><b>Chihiros</b> : une rampe LED <b>Chihiros WRGB II</b> en Bluetooth. Pendant une séance, elle prend la couleur de la situation : vert au départ, orange en VSC, rouge au drapeau rouge, blanc à l'arrivée (interrupteur « Couleurs en course »).</li>
      <li><b>Autres lampes</b> : rubans LED, ampoules et lampes Bluetooth des marques courantes (ELK-BLEDOM / LEDnet, Triones / HappyLighting, Govee). Bouton « Rechercher une lampe » : Paddock reconnaît sa marque et lui applique les mêmes couleurs en course que la rampe.</li>
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
  if (tab === 'tyres') { renderTyres(); bindTabs(); return; }
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
let autoSectorOpen = false;
/** Onglet « VSC automatique » : le VSC se déclenche tout seul quand une voiture ne repasse plus. */
function renderAutoVsc() {
  const c = autoCfg(app);
  const sw = (id, on) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span> ${on ? 'Activé' : 'Désactivé'}</label>`;
  root.innerHTML = sectionHead() + vscTabs() + `
  <section class="panel">
    <h2>VSC automatique</h2>
    <p class="muted" style="margin:-4px 0 12px;font-size:.9rem">Le VSC se déclenche tout seul quand une voiture ne repasse plus (sortie de piste, voiture arrêtée). Tu le termines comme d'habitude avec le bouton VSC.</p>
    <p class="warn-note top">⚠️ Le VSC automatique n'est pas disponible en Essais libres et en Qualification.</p>

    <div class="auto-rule">
      <div class="row" style="justify-content:space-between"><h3 style="margin:0">Par tour</h3>${sw('avLap', c.lapOn)}</div>
      <p class="muted" style="margin:6px 0 8px;font-size:.85rem">Si une voiture ne boucle pas son tour en :</p>
      <div class="row" style="gap:8px;align-items:center">
        <input type="number" id="avLapSec" min="2" max="120" step="0.5" value="${c.lapSec}" style="width:90px"> <span>secondes → VSC</span>
      </div>
    </div>

    <details class="color-box auto-rule" id="avSectorBox" ${autoSectorOpen ? 'open' : ''}>
      <summary><h3 style="margin:0">Par secteur (Check Lane)</h3>${sw('avSector', c.sectorOn).replace('<label class="switch"', '<label class="switch" id="avSectorWrap"')}</summary>
      <p class="muted" style="margin:6px 0 8px;font-size:.85rem">Plus rapide que par tour : si une voiture ne passe pas le capteur suivant (ligne ou Check Lane) en :</p>
      <div class="row" style="gap:8px;align-items:center">
        <input type="number" id="avSectorSec" min="1" max="60" step="0.5" value="${c.sectorSec}" style="width:90px"> <span>secondes → VSC</span>
      </div>
      <p class="muted" style="margin:8px 0 0;font-size:.8rem">Ne s'applique qu'aux voitures déjà passées sur une Check Lane pendant la séance : sans Check Lane, rien ne se passe.</p>
    </details>

    <div class="auto-rule">
      <div class="row" style="justify-content:space-between"><h3 style="margin:0">Fin automatique</h3>${sw('avEnd', c.endOn)}</div>
      <p class="muted" style="margin:6px 0 8px;font-size:.85rem">Si le VSC (manuel ou automatique) dure plus de :</p>
      <div class="row" style="gap:8px;align-items:center">
        <input type="number" id="avEndSec" min="3" max="60" step="1" value="${c.endSec}" style="width:90px"> <span>secondes → reprise : « Fin de VSC dans… 3, 2, 1, Go »</span>
      </div>
      <p class="muted" style="margin:8px 0 0;font-size:.8rem">Sauf si un drapeau rouge est sorti ou si tu as déjà lancé la fin du VSC toi-même. Reprise habituelle : voix, bips, éclairage.</p>
    </div>

    <p class="muted" style="margin:14px 0 0;font-size:.8rem"><b>Jamais de VSC automatique pour :</b> une voiture au stand (le compte repart à sa sortie), en panne sèche, déjà arrivée ou pas encore partie ; ni pendant un VSC, un drapeau rouge ou la fin de course. Après chaque reprise, le compte repart de zéro. Une voiture qui a déclenché le VSC ne le redéclenche pas tant qu'elle n'est pas repassée.</p>
  </section>`;
  bindVscTabs();
  const save = async (values) => { await app.saveVscCfg({ auto: { ...autoCfg(app), ...values } }); };
  const box = $('#avSectorBox', root);
  box.addEventListener('toggle', () => { autoSectorOpen = box.open; });
  $('#avSectorWrap', root).addEventListener('click', (e) => e.stopPropagation());
  $('#avLap', root).onchange = async (e) => { await save({ lapOn: e.target.checked }); renderAutoVsc(); bindTabs(); };
  $('#avSector', root).onchange = async (e) => { await save({ sectorOn: e.target.checked }); renderAutoVsc(); bindTabs(); };
  $('#avEnd', root).onchange = async (e) => { await save({ endOn: e.target.checked }); renderAutoVsc(); bindTabs(); };
  const num = (id, k, min, max) => {
    $(id, root).onchange = async (e) => {
      const v = Math.max(min, Math.min(max, parseFloat(e.target.value) || min));
      e.target.value = v;
      await save({ [k]: v });
      toast(`Enregistré : ${v} s`, 1200);
    };
  };
  num('#avLapSec', 'lapSec', 2, 120);
  num('#avSectorSec', 'sectorSec', 1, 60);
  num('#avEndSec', 'endSec', 3, 60);
}

let vscTab = 'button'; // onglets du VSC : « Bouton VSC » et « VSC automatique »
function vscTabs() {
  return `<div class="subtabs small">
    <button class="${vscTab === 'button' ? 'on' : ''}" data-vsctab="button">Bouton VSC</button>
    <button class="${vscTab === 'auto' ? 'on' : ''}" data-vsctab="auto">VSC automatique</button>
  </div>`;
}
function bindVscTabs() {
  root.querySelectorAll('[data-vsctab]').forEach((b) => (b.onclick = () => { vscTab = b.dataset.vsctab; renderVsc(); bindTabs(); }));
}

function renderVsc() {
  if (vscTab === 'auto') { renderAutoVsc(); return; }
  const pct = app.vscCfg.speedPct;
  root.innerHTML = sectionHead() + vscTabs() + `
  <section class="panel">
    <h2>Virtual Safety Car</h2>
    <p class="muted" style="margin-top:-4px">En course, le bouton <b>VSC</b> met immédiatement <b>toutes les voitures à la même vitesse fixe</b>, quel que soit leur réglage du garage (comme la panne sèche en vitesse fixe). Un second appui rend la course.</p>
    <div class="row" style="gap:14px;margin-top:14px">
      <label class="field" style="flex:1">Vitesse sous VSC
        <input type="range" id="vscPct" min="0" max="100" step="5" value="${pct}"></label>
      <span class="vsc-pct num" id="vscPctV">${pct} %<small>cran ${vscSpeed(pct)}/15</small></span>
    </div>
    <p class="muted" style="font-size:.85rem;margin:8px 0 0" id="vscEx"></p>
    <button class="btn small ghost" id="vscReset" style="margin-top:10px">Revenir à 20 % (nominal)</button>
  </section>`;
  const r = $('#vscPct', root);
  const show = (v) => {
    $('#vscPctV', root).innerHTML = `${v} %<small>cran ${vscSpeed(v)}/15</small>`;
    $('#vscEx', root).textContent = `${v} % de la vitesse max = cran ${vscSpeed(v)}/15 pour toutes les voitures${vscSpeed(v) === 0 ? ' (le plus lent que permet la Control Unit)' : ''}. Une voiture réglée plus lentement garde son allure.`;
  };
  show(pct);
  r.oninput = () => show(+r.value);
  r.onchange = async () => { await app.saveVscCfg({ speedPct: +r.value }); toast('VSC : ' + r.value + ' %', 1200); };
  $('#vscReset', root).onclick = async () => { await app.saveVscCfg({ speedPct: 20 }); renderVsc(); bindTabs(); };
  bindVscTabs();
}

/** Réglages → Pneus : par gomme, des crans retirés à la programmation du pilote. */
const TYRE_FIELDS = [
  ['speedOff', 'Vitesse', 'crans en moins', 0, 15, 1],
  ['brakeOff', 'Freinage', 'crans en moins', 0, 15, 1],
  ['wearPerLap', 'Usure par tour', '%', 0, 100, 0.5],
  ['warmLaps', 'Tours de chauffe', 'tours', 0, 10, 1],
  ['coldOff', 'À froid', 'crans en moins', 0, 15, 1],
];
const TYRE_WEAR_FIELDS = [
  ['cliffFrom', 'Chute de grip : de', '% de santé', 0, 100, 1],
  ['cliffTo', 'à', '% de santé', 0, 100, 1],
  ['cliffKeep', 'Après la chute, la voiture garde', '% de sa programmation', 0, 100, 5],
  ['punctA', 'Risque de crevaison sous', '% de santé', 0, 100, 1],
  ['punctAChance', 'Risque à chaque passage', '%', 0, 100, 5],
  ['punctB', 'Gros risque sous', '% de santé', 0, 100, 1],
  ['punctBChance', 'Risque à chaque passage', '%', 0, 100, 5],
];
function renderTyres() {
  const t = app.tyres;
  const lapsTo = (h, g) => (g.wearPerLap ? Math.floor((100 - h) / g.wearPerLap) : '∞');
  const ex = (b) => Math.round((b * t.cliffKeep) / 100);
  root.innerHTML = sectionHead() + `
  <section class="panel">
    <h2>Arrêt au stand</h2>
    <div class="row" style="gap:14px;flex-wrap:wrap">
      <label class="field">Temps de changement (s)<input type="number" id="tyChange" min="0" max="30" step="0.5" value="${t.changeSec}" style="width:90px"></label>
      <label class="field">Gomme de départ
        <select id="tyStart">${COMPOUNDS.map((k) => `<option value="${k}" ${t.start === k ? 'selected' : ''}>${COMPOUND_INFO[k].label}</option>`).join('')}</select></label>
    </div>
    <p class="muted" style="margin:8px 0 0;font-size:.85rem">La voiture doit rester immobile ce temps-là dans la voie des stands pour repartir avec la gomme choisie. La gomme de départ peut être changée par chaque pilote sur sa vue pilote avant le GO.</p>
  </section>
  <section class="panel" style="margin-top:14px">
    <h2>Usure et crevaison</h2>
    <div class="tyre-grid">
      ${TYRE_WEAR_FIELDS.map(([f, l, u, mn, mx, st]) => `<label class="field">${l} (${u})<input type="number" data-tyg="${f}" min="${mn}" max="${mx}" step="${st}" value="${t[f]}"></label>`).join('')}
    </div>
    <p class="muted" style="margin:8px 0 0;font-size:.85rem">Exemple : une voiture programmée à 8 roule à ${ex(8)} après la chute de grip, à 12 elle roule à ${ex(12)}. À 0 % de santé, la crevaison est sûre.</p>
    <div class="row" style="gap:14px;margin-top:14px">
      <label class="field" style="flex:1">Vitesse en crevaison
        <input type="range" id="tyPunct" min="0" max="100" step="5" value="${t.punctSpeedPct}"></label>
      <span class="vsc-pct num" id="tyPunctV">${t.punctSpeedPct} %<small>cran ${vscSpeed(t.punctSpeedPct)}/15</small></span>
    </div>
    <p class="muted" style="font-size:.85rem;margin:4px 0 0">Comme le VSC : % de la vitesse max du circuit, la même pour toutes les voitures crevées (0 % = voiture arrêtée).</p>
  </section>
  ${COMPOUNDS.map((k) => {
    const g = t[k];
    return `
  <section class="panel tyre-card" style="margin-top:14px;--tc:${COMPOUND_INFO[k].color}">
    <h2><span class="tyre-dot">${COMPOUND_INFO[k].short}</span> ${COMPOUND_INFO[k].label}</h2>
    <div class="tyre-grid">
      ${TYRE_FIELDS.map(([f, l, u, mn, mx, st]) => `<label class="field">${l} (${u})<input type="number" data-ty="${k}.${f}" min="${mn}" max="${mx}" step="${st}" value="${g[f]}"></label>`).join('')}
    </div>
    <p class="muted" style="margin:8px 0 0;font-size:.8rem">Chute de grip entre le ${lapsTo(t.cliffFrom, g)}e et le ${lapsTo(t.cliffTo, g)}e tour ; risque de crevaison à partir du ${lapsTo(t.punctA, g)}e tour.</p>
  </section>`;
  }).join('')}
  <button class="btn small ghost" id="tyReset" style="margin-top:14px">↺ Revenir aux réglages d'origine</button>`;

  const save = async (patch) => { await app.saveTyres({ ...app.tyres, ...patch }); };
  $('#tyChange', root).onchange = async (e) => { await save({ changeSec: +e.target.value }); toast('Enregistré', 1000); };
  $('#tyStart', root).onchange = async (e) => { await save({ start: e.target.value }); toast('Enregistré', 1000); };
  root.querySelectorAll('[data-tyg]').forEach((inp) => (inp.onchange = async () => {
    await save({ [inp.dataset.tyg]: +inp.value });
    renderTyres(); bindTabs();
    toast('Enregistré', 1000);
  }));
  const pr = $('#tyPunct', root);
  pr.oninput = () => { $('#tyPunctV', root).innerHTML = `${pr.value} %<small>cran ${vscSpeed(+pr.value)}/15</small>`; };
  pr.onchange = async () => { await save({ punctSpeedPct: +pr.value }); toast('Crevaison : ' + pr.value + ' %', 1200); };
  root.querySelectorAll('[data-ty]').forEach((inp) => (inp.onchange = async () => {
    const [k, f] = inp.dataset.ty.split('.');
    await save({ [k]: { ...app.tyres[k], [f]: +inp.value } });
    renderTyres(); bindTabs();
    toast('Enregistré', 1000);
  }));
  $('#tyReset', root).onclick = async () => {
    if (!(await confirmBox('Revenir aux réglages d\'origine des pneus ?'))) return;
    await app.saveTyres(DEFAULT_TYRES);
    renderTyres(); bindTabs();
  };
}

/** Réglages → Éclairage connecté : onglets « Chihiros » (rampe) et « Autres lampes ». */
let devTab = 'lights';
let selColor = 'racing'; // couleur (situation de course) en cours de réglage
let colorsOpen = false;  // case « Test des couleurs » dépliée ?

/** Envoie une couleur d'essai à toutes les lampes connectées. */
function testColor(c) {
  const outs = [];
  if (app.lightSync.chihiros && app.lights.connected) outs.push(app.lights);
  if (app.lightSync.others) app.extraLights.forEach((l) => { if (l.connected) outs.push(l); });
  outs.forEach((o) => o.setColor(...c));
  return outs.length;
}

/** Case « Test des couleurs » : choisir une couleur, la régler aux curseurs, revenir à l'origine. */
function colorsPanel() {
  const c = selColor === 'off' ? [0, 0, 0] : paletteColor(app, selColor);
  const edited = !!app.lightSync.palette && Object.keys(app.lightSync.palette).length > 0;
  const sel = COLOR_SLOTS.find((x) => x.k === selColor);
  return `
  <section class="panel" style="margin-top:14px">
  <details class="color-box" id="colorsBox" ${colorsOpen ? 'open' : ''}>
    <summary><h2>Test des couleurs</h2></summary>
    <p class="muted" style="font-size:.85rem;margin:6px 0 10px">Toutes les couleurs qui peuvent s'afficher en course. Touche-en une pour l'essayer, puis règle-la avec les curseurs : elle est enregistrée et utilisée en course.</p>
    <div class="light-presets slots">
      ${COLOR_SLOTS.map((x) => `<button class="light-chip ${selColor === x.k ? 'sel' : ''}" data-preset="${x.k}"><i style="background:${cssOf(paletteColor(app, x.k))}"></i>${esc(x.label)}</button>`).join('')}
      <button class="light-chip ${selColor === 'off' ? 'sel' : ''}" data-preset="off"><i style="background:#222"></i>Éteint</button>
    </div>
    ${selColor === 'off' ? '<p class="muted" style="margin:12px 0 0;font-size:.85rem">Éteint : rien à régler.</p>' : `
    <h3>Réglage : ${esc(sel?.label || '')}</h3>
    ${[['r', 'Rouge', '#e10600', 0], ['g', 'Vert', '#22c55e', 1], ['b', 'Bleu', '#3b82f6', 2]].map(([k, l, col, i]) => `
    <div class="bar" style="--c:${col};--p:${c[i]}%">
      <span class="bar-l">${l}</span>
      <input type="range" min="0" max="100" step="5" value="${c[i]}" data-rgb="${i}" aria-label="${l}">
      <span class="bar-v num">${c[i]} %</span>
    </div>`).join('')}`}
    <div class="light-preview" id="lPreview" style="background:${cssOf(c)}"></div>
    <button class="btn small ghost" id="lReset" style="margin-top:10px" ${edited ? '' : 'disabled'}>↺ Revenir aux couleurs d'origine</button>
  </details>
  </section>`;
}

let paletteTimer = null;
function bindColorsPanel() {
  const box = $('#colorsBox', root);
  if (box) box.addEventListener('toggle', () => { colorsOpen = box.open; });
  root.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => {
    selColor = b.dataset.preset;
    testColor(selColor === 'off' ? [0, 0, 0] : paletteColor(app, selColor));
    renderDevices(); bindTabs();
  }));
  root.querySelectorAll('[data-rgb]').forEach((r) => r.addEventListener('input', () => {
    r.parentElement.style.setProperty('--p', r.value + '%');
    r.parentElement.querySelector('.bar-v').textContent = r.value + ' %';
    const c = [0, 1, 2].map((i) => +$(`[data-rgb="${i}"]`, root).value);
    $('#lPreview', root).style.background = cssOf(c);
    const dot = root.querySelector(`[data-preset="${selColor}"] i`);
    if (dot) dot.style.background = cssOf(c);
    testColor(c);
    // enregistrée dans la palette (un court délai pendant qu'on fait glisser)
    app.lightSync.palette = { ...(app.lightSync.palette || {}), ['s:' + selColor]: c };
    clearTimeout(paletteTimer);
    paletteTimer = setTimeout(async () => {
      await app.saveLightSync({ palette: app.lightSync.palette });
      const rs = $('#lReset', root);
      if (rs) rs.disabled = false;
    }, 400);
  }));
  const reset = $('#lReset', root);
  if (reset) reset.onclick = async () => {
    if (!(await confirmBox('Revenir aux couleurs d\'origine pour toutes les couleurs ?'))) return;
    await app.saveLightSync({ palette: {} });
    testColor(selColor === 'off' ? [0, 0, 0] : paletteColor(app, selColor));
    toast('Couleurs d\'origine rétablies', 1500);
    renderDevices(); bindTabs();
  };
}

/** Onglets d'Éclairage connecté : la rampe Chihiros et les autres lampes. */
function devTabs() {
  return `<div class="subtabs small">
    <button class="${devTab === 'lights' ? 'on' : ''}" data-devtab="lights">💡 Chihiros</button>
    <button class="${devTab === 'others' ? 'on' : ''}" data-devtab="others">🔦 Autres lampes</button>
  </div>`;
}
function bindDevTabs() {
  root.querySelectorAll('[data-devtab]').forEach((b) => (b.onclick = () => { devTab = b.dataset.devtab; renderDevices(); bindTabs(); }));
}

/** Case commune aux deux onglets : les couleurs en course valent pour toutes les lampes. */
let scenesOpen = false; // case « Couleurs en course » dépliée ?
const toHex = (c) => '#' + c.map((v) => Math.round(v * 2.55).toString(16).padStart(2, '0')).join('');
const fromHex = (h) => [1, 3, 5].map((i) => Math.round(parseInt(h.slice(i, i + 2), 16) / 2.55));

/** Pastille cliquable : ouvre le sélecteur de couleur du téléphone pour cette situation. */
const swatch = (slot) => `<label class="scene-pick" title="Changer la couleur"><input type="color" value="${toHex(paletteColor(app, slot))}" data-slot="${slot}"><i style="background:${cssOf(paletteColor(app, slot))}"></i></label>`;

function scenesPanel() {
  return `
  <section class="panel" style="margin-top:14px">
  <details class="color-box" id="scenesBox" ${scenesOpen ? 'open' : ''}>
    <summary>
      <h2>Couleurs en course</h2>
      <label class="switch" id="lSyncWrap"><input type="checkbox" id="lSync" ${app.lightSync.enabled ? 'checked' : ''}><span></span> ${app.lightSync.enabled ? 'Activé' : 'Désactivé'}</label>
    </summary>
    <p class="muted" style="font-size:.85rem;margin:8px 0 10px">Pendant une course, des essais libres ou une qualification, <b>toutes les lampes connectées</b> (rampe Chihiros et autres lampes) prennent la couleur de la situation. <b>Touche une pastille</b> pour choisir une autre couleur.</p>
    <div class="light-scenes">
      ${LIGHT_SCENES.map((x) => `<div class="light-scene">${x.alt ? x.alt.map(swatch).join('') : swatch(x.c)}<span>${x.label}</span></div>`).join('')}
    </div>
  </details>
  </section>`;
}
function bindScenesPanel() {
  const box = $('#scenesBox', root);
  if (box) box.addEventListener('toggle', () => { scenesOpen = box.open; });
  // l'interrupteur ne doit pas replier / déplier la case
  const wrap = $('#lSyncWrap', root);
  if (wrap) wrap.addEventListener('click', (e) => e.stopPropagation());
  const sync = $('#lSync', root);
  if (sync) sync.onchange = async (e) => { await app.saveLightSync({ enabled: e.target.checked }); renderDevices(); bindTabs(); };
  root.querySelectorAll('[data-slot]').forEach((inp) => {
    inp.addEventListener('input', () => {
      inp.nextElementSibling.style.background = inp.value;
      testColor(fromHex(inp.value)); // aperçu en direct sur les lampes
    });
    inp.addEventListener('change', async () => {
      const c = fromHex(inp.value);
      await app.saveLightSync({ palette: { ...(app.lightSync.palette || {}), ['s:' + inp.dataset.slot]: c } });
      toast('Couleur enregistrée', 1200);
      renderDevices(); bindTabs();
    });
  });
}

/** Onglet « Autres lampes » : rechercher n'importe quelle lampe Bluetooth reconnue. */
function renderOtherLights() {
  const lights = app.extraLights;
  const enabled = !!app.lightSync.others;
  const sw = `<label class="switch"><input type="checkbox" id="olEnable" ${enabled ? 'checked' : ''}><span></span> ${enabled ? 'Activées' : 'Désactivées'}</label>`;
  const bindSw = () => {
    $('#olEnable', root).onchange = async (e) => { await app.saveLightSync({ others: e.target.checked }); renderDevices(); bindTabs(); };
  };
  // désactivé (cas de ceux qui n'ont pas d'autre lampe) : juste l'interrupteur, comme pour Chihiros
  if (!enabled) {
    root.innerHTML = sectionHead() + devTabs() + `
    <section class="panel">
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">Autres lampes Bluetooth</h2>${sw}</div>
      <p class="muted" style="margin:10px 0 0">Tu as un ruban LED, une ampoule ou une lampe Bluetooth ? Active-les : tu pourras les rechercher, et elles prendront la couleur des drapeaux en course comme la rampe.</p>
    </section>`;
    bindSw();
    bindDevTabs();
    return;
  }
  root.innerHTML = sectionHead() + devTabs() + `
  <section class="panel">
    <div class="row" style="justify-content:space-between;margin-bottom:6px"><h2 style="margin:0">Autres lampes Bluetooth</h2>${sw}</div>
    <p class="muted" style="margin:-4px 0 12px;font-size:.9rem">Rubans LED, ampoules, lampes : Paddock les pilote comme la rampe et leur applique les mêmes couleurs en course.</p>
    ${navigator.bluetooth ? '' : '<p class="warn-note">Bluetooth indisponible dans ce navigateur : utilise Chrome.</p>'}
    <div class="other-lights">
      ${lights.length ? lights.map((l) => `
      <div class="other-light" data-lid="${esc(l.id)}">
        <div class="ol-id"><b>${esc(l.name)}</b><span class="muted">${esc(l.protocol?.label || '')}</span></div>
        <span class="ol-state ${l.status}">${l.status === 'on' ? '● connectée' : l.status === 'connecting' ? '⏳' : l.status === 'error' ? '⚠️ ' + esc(l.error || '') : 'déconnectée'}</span>
        <div class="ol-act">
          ${l.status === 'on'
            ? `<button class="btn small" data-ltest>🎨 Tester</button><button class="btn small ghost" data-loff>Déconnecter</button>`
            : `<button class="btn small" data-lre>↻ Reconnecter</button>`}
          <button class="btn small ghost danger" data-ldel title="Retirer cette lampe">🗑</button>
        </div>
      </div>`).join('') : '<p class="muted">Aucune lampe ajoutée.</p>'}
    </div>
    <button class="btn primary" id="olSearch" style="margin-top:12px" ${navigator.bluetooth ? '' : 'disabled'}>🔍 Rechercher une lampe</button>
    <details class="ghost-exp" style="margin-top:12px">
      <summary>Lampes reconnues</summary>
      <ul style="margin:8px 0 0;padding-left:18px;font-size:.85rem">
        ${PROTOCOLS.map((x) => `<li>${esc(x.label)}</li>`).join('')}
      </ul>
      <p class="muted" style="font-size:.8rem;margin:6px 0 0">Chaque marque a son propre langage Bluetooth : une lampe non reconnue peut être ajoutée plus tard si l'on connaît son protocole. Ferme l'appli de la lampe avant la recherche (une seule connexion à la fois).</p>
    </details>
  </section>` + scenesPanel() + colorsPanel();

  bindDevTabs();
  bindColorsPanel();
  bindSw();
  bindScenesPanel();
  const again = () => { renderDevices(); bindTabs(); };
  $('#olSearch', root).onclick = async () => {
    try {
      const l = await GenericLight.pick();
      app.addExtraLight(l);
      toast(`🔦 ${l.name} ajoutée (${l.protocol.label})`, 3000);
    } catch (e) {
      if (!/cancel|chosen/i.test(e?.message || '')) toast(e.message || String(e), 4500);
    }
    again();
  };
  root.querySelectorAll('[data-lid]').forEach((row) => {
    const l = lights.find((x) => x.id === row.dataset.lid);
    const on = (sel, fn) => { const b = row.querySelector(sel); if (b) b.onclick = fn; };
    on('[data-ltest]', async () => {
      // petit tour des couleurs pour vérifier que la lampe répond
      for (const c of [[100, 0, 0], [0, 100, 0], [0, 0, 100], [100, 100, 100]]) { l.setColor(...c); await new Promise((r) => setTimeout(r, 700)); }
    });
    on('[data-loff]', () => { l.disconnect(); again(); });
    on('[data-lre]', async () => {
      try { await l.reconnect(); } catch (e) {
        // lampe à re-sélectionner (nouveau lancement sans reconnexion automatique)
        try { const n = await GenericLight.pick(); app.addExtraLight(n); } catch (e2) { if (!/cancel|chosen/i.test(e2?.message || '')) toast(e2.message || String(e2), 4000); }
      }
      again();
    });
    on('[data-ldel]', async () => { if (await confirmBox(`Retirer ${l.name} ?`)) { app.removeExtraLight(l.id); again(); } });
    // l'écran se met à jour quand la lampe change d'état (connexion, perte…)
    if (!l._uiBound) { l._uiBound = true; l.addEventListener('change', () => { if (root && tab === 'devices' && devTab === 'others') { renderDevices(); bindTabs(); } }); }
  });
}

function renderDevices() {
  if (devTab === 'others') { renderOtherLights(); return; }
  const L = app.lights;
  const enableSwitch = (on) => `<label class="switch"><input type="checkbox" id="lEnable" ${on ? 'checked' : ''}><span></span> ${on ? 'Activée' : 'Désactivée'}</label>`;
  const bindEnable = () => {
    $('#lEnable', root).onchange = async (e) => { await app.saveLightSync({ chihiros: e.target.checked }); renderDevices(); bindTabs(); };
  };
  // rampe non activée (cas de tous ceux qui n'en ont pas) : juste l'interrupteur
  if (!app.lightSync.chihiros) {
    root.innerHTML = sectionHead() + `
    ${devTabs()}
    <section class="panel">
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">Rampe LED Chihiros</h2>${enableSwitch(false)}</div>
      <p class="muted" style="margin:10px 0 0">Tu as une rampe LED Chihiros (WRGB II) ? Active-la : Paddock s'y connectera à chaque lancement et elle prendra la couleur des drapeaux en course.</p>
    </section>`;
    bindEnable();
    bindDevTabs();
    return;
  }
  const st = L.status;
  root.innerHTML = sectionHead() + `
  ${devTabs()}
  <section class="panel">
    <div class="row" style="justify-content:space-between;margin-bottom:10px"><h2 style="margin:0">Rampe LED Chihiros</h2>${enableSwitch(true)}</div>
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

` + scenesPanel() + colorsPanel();
  bindDevTabs();
  bindColorsPanel();
  const act = async (fn) => { try { await fn(); } catch (e) { toast(e.message || String(e), 3500); } renderDevices(); bindTabs(); };
  const conn = $('#lConn', root);
  if (conn) conn.onclick = () => act(async () => { await L.connect(); toast('💡 Rampe connectée'); });
  const all = $('#lAll', root);
  if (all) all.onclick = () => act(async () => { await L.connect({ showAll: true }); toast('💡 Rampe connectée'); });
  const re = $('#lRe', root);
  if (re) re.onclick = () => act(() => L.reconnect());
  const off = $('#lOff', root);
  if (off) off.onclick = () => act(() => L.disconnect());
  bindEnable();
  bindScenesPanel();
}

/** Ouvre directement Réglages → Essence (depuis un autre écran). */
export function openFuel(tab) {
  openFuelNext = true;
  if (tab) openFuelTab(tab);
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
      <button class="btn ghost" style="margin-top:12px;margin-left:6px" id="cuMute">🔇 Couper le son de la Control Unit</button>
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
      <button class="btn" id="resetResults" style="margin-bottom:8px">🏁 Remettre à zéro courses / victoires et qualifs / poles</button><br>
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
  // Le son de la Control Unit ne se règle pas à distance : on explique la manipulation (manuel Carrera)
  $('#cuMute', root).onclick = () => modal(`<h2 style="margin-top:0">🔇 Son de la Control Unit</h2>
    <p>La Control Unit ne permet pas de couper son son depuis une appli : ça se fait sur le boîtier.</p>
    <ol class="steps">
      <li><b>Éteins</b> le circuit.</li>
      <li><b>Maintiens</b> le bouton <b>START/ENTER</b> de la Control Unit enfoncé.</li>
      <li><b>Rallume</b> le circuit sans lâcher le bouton.</li>
      <li><b>Relâche</b> START/ENTER.</li>
    </ol>
    <p class="muted" style="font-size:.85rem">Coupe le bip des capteurs et le son des touches. Refais la même chose pour le remettre. Le bip de mise sous tension, lui, reste (manuel Carrera 30352).</p>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn primary" data-close>Compris</button></div>`);
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
  $('#resetResults', root).onclick = async () => {
    const list = (await app.db.all('sessions')).filter((x) => x.type === 'race' || x.type === 'qualifying');
    if (!list.length) { toast('Aucune course ni qualif enregistrée'); return; }
    if (!(await confirmBox(`Effacer définitivement les ${list.length} courses et qualifs enregistrées ? Les compteurs courses / victoires et qualifs / poles de tous les pilotes repartent de zéro. Les tours, temps de roulage et records sont conservés.`))) return;
    for (const x of list) await app.db.remove('sessions', x.id);
    toast('Courses et qualifs remises à zéro');
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
