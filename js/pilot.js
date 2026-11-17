// Vue pilote : page ouverte en scannant le QR code de l'écran de course.
// Aucune installation : on suit la séance en direct (live/{code} dans Firestore),
// on peut déclencher VSC / drapeau rouge et régler SA voiture. Les commandes sont
// déposées dans live/{code}/cmds ; le téléphone du circuit les applique.

import { FIREBASE_CONFIG } from './firebase-config.js';
import { esc, $, $$, toast } from './ui.js';
import { fmtTime, fmtClock } from './race.js';
import { APP_VERSION } from './version.js';

// styles rechargés à chaque nouvelle version (sinon un téléphone peut garder les anciens)
document.querySelectorAll('link[rel="stylesheet"][href^="css/"]').forEach((l) => {
  const href = l.getAttribute('href').split('?')[0];
  if (!l.getAttribute('href').endsWith('v=' + APP_VERSION)) l.setAttribute('href', href + '?v=' + APP_VERSION);
});

const TYRES = {
  soft: { label: 'Tendre', short: 'T', color: '#e10600' },
  medium: { label: 'Medium', short: 'M', color: '#facc15' },
  hard: { label: 'Dur', short: 'D', color: '#f5f5f5' },
};

const SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
const code = (new URLSearchParams(location.search).get('c') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const PICK_KEY = 'paddock.pilot.' + code;

let fb = null;
let fs = null;
let data = null;          // dernier instantané reçu
let me = null;            // adresse de la manette choisie
let lastUpdate = 0;
let touchingUntil = 0;    // pendant un réglage au doigt, on ne redessine pas le garage
const view = $('#pv');
const status = $('#pvStatus');

try { const v = localStorage.getItem(PICK_KEY); if (v !== null) me = +v; } catch { /* ignore */ }

const pct = (v) => Math.round((v / 15) * 100);

async function start() {
  if (!code) { view.innerHTML = '<section class="panel pv-msg">Lien incomplet : scanne à nouveau le QR code de l\'écran de course.</section>'; status.textContent = ''; return; }
  try {
    const [appMod, authMod, fsMod] = await Promise.all([
      import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js'),
    ]);
    fb = { ...appMod, ...authMod, ...fsMod };
    const app = fb.initializeApp(FIREBASE_CONFIG);
    const auth = fb.getAuth(app);
    fs = fb.getFirestore(app);
    // connexion gardée en mémoire seulement : n'écrase jamais celle de l'appli Paddock
    // si le même téléphone a les deux ouverts
    await fb.setPersistence(auth, fb.inMemoryPersistence);
    await fb.signInAnonymously(auth);
    fb.onSnapshot(fb.doc(fs, 'live', code), onData, (e) => fail(e));
    // retour sur la page (Safari met les pages en pause) : on relit tout de suite l'état
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  } catch (e) { fail(e); }
}

function onData(snap) {
  if (!snap.exists()) { data = null; status.textContent = 'Code ' + code; render(); return; }
  try { data = JSON.parse(snap.data().json); } catch { data = null; }
  lastUpdate = Date.now();
  status.textContent = '● En direct';
  status.classList.add('on');
  render();
}

/** Relit l'état de la course (mise à jour manquée, page remise au premier plan). */
let refreshing = false;
async function refresh() {
  if (!fs || refreshing) return;
  refreshing = true;
  try { onData(await fb.getDoc(fb.doc(fs, 'live', code))); } catch { /* réseau : on réessaiera */ }
  refreshing = false;
}

function fail(e) {
  const c = e?.code || e?.message || '';
  status.textContent = 'Hors ligne';
  status.classList.remove('on');
  view.innerHTML = `<section class="panel pv-msg">Impossible de rejoindre la course${/permission|admin-restricted|operation-not-allowed/.test(c) ? ' (accès refusé : la vue pilote n\'est pas encore activée sur ce circuit)' : ' : vérifie ta connexion internet'}.<br><small class="muted">${esc(c)}</small></section>`;
}

const mine = () => data?.comps?.find((c) => c.a === me) || null;

function render() {
  if (!data || data.state === 'none') {
    view.innerHTML = '<section class="panel pv-msg">⏳ En attente d\'une séance sur le circuit…</section>';
    return;
  }
  if (me === null || !mine()) { renderPick(); return; }
  renderPilot();
}

/** Choix du pilote après le scan. */
function renderPick() {
  view.innerHTML = `
  <section class="pv-pick">
    <h1 class="menu-title">Qui es-tu ?</h1>
    <p class="muted" style="text-align:center;margin:-6px 0 14px">${esc(data.title)} · touche ton nom</p>
    <div class="driver-tiles">
      ${data.comps.map((c) => `<button class="driver-tile" data-a="${c.a}" style="--dc:${esc(c.color)}"><div class="driver-label">${esc(c.name)}</div></button>`).join('')}
    </div>
  </section>`;
  $$('[data-a]', view).forEach((b) => (b.onclick = () => {
    me = +b.dataset.a;
    try { localStorage.setItem(PICK_KEY, String(me)); } catch { /* ignore */ }
    render();
  }));
}

function flagInfo() {
  const d = data;
  if (d.state === 'ready') return ['idle', 'Prêt · en attente du GO'];
  if (d.state === 'armed') return ['idle', '🚦 Feux…'];
  if (d.state === 'finished') return ['chequered', '🏁 Terminé'];
  if (d.flag === 'red') return [d.redResuming ? 'red resume' : 'red', d.redResuming ? '🚦 Reprise : attention aux feux' : '🚩 Drapeau rouge : tout le monde s\'arrête'];
  if (d.flag === 'vsc') return ['vsc', d.vscCountdown ? `Fin du VSC dans ${d.vscCountdown}` : 'VSC · vitesse limitée'];
  if (d.state === 'finishing') return ['chequered', '🏁 Dernier tour'];
  return ['green', 'Course en cours'];
}

function clockText() {
  const d = data;
  if (!d.startWall) return d.durationMs ? fmtClock(d.durationMs) : '0:00';
  const elapsed = (d.endWall ?? Date.now()) - d.startWall;
  return d.durationMs ? fmtClock(Math.max(0, d.durationMs - elapsed)) : fmtClock(elapsed);
}

function lapText() {
  const d = data;
  if (d.type === 'race' && d.mode !== 'time') return `Tour ${Math.min(d.leaderLaps + (d.state === 'running' ? 1 : 0), d.laps)} / ${d.laps}`;
  if (d.type !== 'race' && d.mode === 'laps' && d.laps) return `${d.laps} tours par pilote`;
  return d.overallBest ? `Meilleur : ${fmtTime(d.overallBest.time)}` : '';
}

function renderPilot() {
  const d = data;
  const c = mine();
  const [fcls, ftxt] = flagInfo();
  const live = ['running', 'finishing'].includes(d.state);
  const best = d.overallBest && d.overallBest.address === c.a;
  // réglage en cours au doigt : on garde le garage tel quel (pas de saut du curseur)
  const oldGarage = Date.now() < touchingUntil ? $('#pvGarage', view) : null;
  view.innerHTML = `
  <div class="pv">
    <div class="pv-head">
      <div><div class="pv-title">${esc(d.title)}</div><div class="muted pv-sub" id="pvLapTxt">${esc(lapText())}</div></div>
      <div class="clock num pv-clock" id="pvClock">${clockText()}</div>
    </div>
    ${d.relaunch ? '' : `<div class="pv-flag ${fcls}">${esc(ftxt)}</div>`}

    <section class="panel pv-me" style="--dc:${esc(c.color)}">
      <div class="pv-pos">${c.pos ? 'P' + c.pos : '–'}</div>
      <div class="pv-id">
        <div class="pv-name">${esc(c.name)} <button class="pv-change" id="pvChange">changer</button></div>
        <div class="muted">${esc(c.car)}${c.inPit ? ' · <b class="pv-pit">STAND</b>' : ''}${c.finished ? ' · 🏁' : ''}</div>
      </div>
      <div class="pv-stats">
        <div><span>Tours</span><b class="num">${c.laps}</b></div>
        <div><span>Dernier</span><b class="num">${fmtTime(c.last)}</b></div>
        <div><span>Meilleur</span><b class="num ${best ? 't-overall' : ''}">${fmtTime(c.best)}</b></div>
        <div><span>Écart</span><b class="num">${esc(c.gap || '—')}</b></div>
      </div>
      ${d.fuel && c.fuelPct !== null ? `<div class="pv-fuel"><span>Essence</span><div class="fuelg-bar"><i style="width:${Math.max(0, Math.min(100, c.fuelPct))}%"></i></div><b class="num">${c.fuelPct <= 0 ? 'À SEC' : c.fuelPct + ' %'}</b></div>` : ''}
      ${c.recent?.length ? `<div class="pv-recent muted">Derniers tours : ${c.recent.slice().reverse().map((t) => `<span class="num">${fmtTime(t)}</span>`).join(' · ')}</div>` : ''}
    </section>

    ${d.relaunch ? '<section class="panel pv-actions"><button class="btn go" id="pvRelaunch">🟢 Nouvelle relance</button><span class="pv-act-l">Feux bloqués ou faux départ</span></section>' : ''}
    <section class="panel pv-actions">
      <button class="btn icon-sq vsc-btn ${d.flag === 'vsc' ? 'go' : ''}" id="pvVsc" ${!live || d.flag === 'red' || d.vscCountdown ? 'disabled' : ''} title="Virtual Safety Car">${d.vscCountdown || 'VSC'}</button>
      <span class="pv-act-l">${d.flag === 'vsc' ? 'Fin du VSC' : 'VSC'}</span>
      ${d.flag === 'red'
        ? `<button class="btn go" id="pvRed" ${d.redResuming ? 'disabled' : ''}>${d.redResuming ? '🚦 Reprise…' : '🟢 Reprendre la course'}</button>`
        : `<button class="btn red icon-sq" id="pvRed" ${!live ? 'disabled' : ''} title="Drapeau rouge">🚩</button><span class="pv-act-l">Drapeau rouge</span>`}
    </section>

    ${d.tyres && c.tyre ? tyresPanel(d, c) : ''}

    <section class="panel" id="pvGarage">${oldGarage ? '' : garage(c)}</section>

    <section class="panel pv-board">
      <h2>Classement</h2>
      ${d.comps.map((x) => `
      <div class="pv-row ${x.a === c.a ? 'me' : ''}" style="--dc:${esc(x.color)}">
        <span class="pv-rpos num">${x.pos || '–'}</span>
        <span class="pv-rname">${esc(x.name)}</span>
        <span class="num">${x.laps}</span>
        <span class="num pv-rbest">${fmtTime(x.best)}</span>
        <span class="num pv-rgap">${esc(x.gap || '')}</span>
      </div>`).join('')}
    </section>
  </div>`;
  if (oldGarage) $('#pvGarage', view).replaceWith(oldGarage);
  bind(c, !oldGarage);
}

/** Mes pneus : gomme, usure, état, et choix de la gomme (départ ou prochain arrêt). */
function tyresPanel(d, c) {
  const t = c.tyre;
  const g = TYRES[t.c];
  const before = !['running', 'finishing'].includes(d.state);
  const want = before ? t.c : (t.n || t.c);
  const st = t.st === 'puncture' ? '💥 Crevaison ! Passe au stand' : t.st === 'cold' ? '❄️ Froids' : t.st === 'worn' ? '⚠️ Usés' : '✅ OK';
  return `
    <section class="panel pv-tyres">
      <h2 style="margin-bottom:8px">🛞 Mes pneus</h2>
      <div class="pv-tyre-now">
        <span class="tyre-dot" style="--tc:${g.color}">${g.short}</span>
        <b>${g.label}</b><span class="muted">${st}</span>
        <div class="fuelg-bar" style="flex:1"><i style="width:${100 - t.w}%;background:${['worn', 'puncture'].includes(t.st) ? 'var(--accent)' : 'var(--green)'}"></i></div>
        <b class="num">${100 - t.w} %</b>
      </div>
      <p class="muted" style="margin:10px 0 6px;font-size:.85rem">${before ? 'Pneus de départ :' : 'Gomme pour le prochain arrêt au stand :'}</p>
      <div class="pv-tyre-pick">
        ${Object.entries(TYRES).map(([k, x]) => `<button class="pv-tyre-btn ${want === k ? 'on' : ''}" data-tyre="${k}" style="--tc:${x.color}"><span class="tyre-dot" style="--tc:${x.color}">${x.short}</span>${x.label}</button>`).join('')}
      </div>
    </section>`;
}

function garage(c) {
  return `
    <h2 style="margin-bottom:6px">🔧 Ma voiture</h2>
    <p class="muted" style="margin:0 0 10px;font-size:.85rem">Réglage de <b>${esc(c.name)}</b> sur <b>${esc(c.car)}</b>, appliqué tout de suite au circuit.</p>
    ${data.parcFerme ? '<p class="warnbox" style="margin:0 0 10px">🔒 <b>Parc fermé</b> : la vitesse ne peut plus être modifiée jusqu’à l’arrivée.</p>' : ''}
    ${[['speed', 'Accélération', 'var(--green)'], ['brake', 'Freinage', 'var(--accent-2)']].map(([k, l, col]) => `
    <div class="bar" style="--c:${col};--p:${pct(c[k])}%">
      <span class="bar-l">${l}</span>
      <input type="range" min="0" max="15" step="1" value="${c[k]}" data-k="${k}" aria-label="${l}" ${k === 'speed' && data.parcFerme ? 'disabled' : ''}>
      <span class="bar-v num">${pct(c[k])} %</span>
    </div>`).join('')}`;
}

async function send(type, extra = {}) {
  try {
    await fb.addDoc(fb.collection(fs, 'live', code, 'cmds'), { type, ...extra, by: mine()?.name || '', at: Date.now() });
    return true;
  } catch (e) {
    toast('Envoi impossible : ' + (e.code || e.message), 3500);
    return false;
  }
}

function bind(c, bindGarage = true) {
  $('#pvChange', view).onclick = () => { me = null; try { localStorage.removeItem(PICK_KEY); } catch { /* ignore */ } render(); };
  const vsc = $('#pvVsc', view);
  // la commande dit ce que le pilote veut (d'après son écran), pas « change l'état » :
  // deux pilotes qui appuient en même temps ne s'annulent plus
  if (vsc) vsc.onclick = async () => {
    const want = data.flag === 'vsc' ? 'off' : 'on';
    if (await send('vsc', { want })) toast(want === 'off' ? 'Fin du VSC demandée' : 'VSC demandé', 1500);
  };
  const rl = $('#pvRelaunch', view);
  if (rl) rl.onclick = async () => { rl.disabled = true; if (await send('relaunch')) toast('Nouvelle relance demandée', 1500); };
  const red = $('#pvRed', view);
  // la commande dit ce que le pilote veut (drapeau rouge / reprise), avec confirmation dans les deux cas
  if (red) red.onclick = async () => {
    const want = data.flag === 'red' ? 'off' : 'on';
    if (await send('red', { want })) toast(want === 'off' ? 'Reprise demandée' : 'Drapeau rouge demandé', 1500);
  };
  $$('[data-tyre]', view).forEach((b) => (b.onclick = async () => {
    if (await send('tyre', { a: c.a, compound: b.dataset.tyre })) toast(`Pneus ${TYRES[b.dataset.tyre].label} demandés`, 1500);
  }));
  if (bindGarage) $$('#pvGarage [data-k]', view).forEach((r) => {
    const show = () => {
      const bar = r.parentElement;
      bar.style.setProperty('--p', pct(+r.value) + '%');
      bar.querySelector('.bar-v').textContent = pct(+r.value) + ' %';
    };
    r.addEventListener('input', () => { touchingUntil = Date.now() + 2500; show(); });
    r.addEventListener('change', () => { touchingUntil = Date.now() + 2500; send('tune', { a: c.a, k: r.dataset.k, v: +r.value }); });
  });
}

// chrono : mis à jour localement entre deux instantanés
setInterval(() => {
  if (!data || me === null) return;
  const el = $('#pvClock', view);
  if (el) el.textContent = clockText();
  // le circuit envoie un signal toutes les 5 s : sans nouvelles depuis 8 s, on relit l'état
  if (lastUpdate && Date.now() - lastUpdate > 8000) {
    status.textContent = '⚠️ Mise à jour…';
    status.classList.remove('on');
    refresh();
  }
}, 250);

start();
