// Garage → chaque voiture → « 🟨 VSC adaptatif » : étalonnage par circuit (tests 12 tours)
// et écran de test (la voiture roule au cran du test, manette enfoncée à 100 %).

import { esc, $, $$, toast, modal, confirmBox } from '../ui.js';
import { CAL_TESTS, CAL_LAPS, calOf, timesByCran, medianOf } from '../vsc-cal.js';

const fmtDate = (d) => new Date(d).toLocaleDateString('fr-FR');
const sec2 = (x) => (+x).toFixed(2).replace('.', ',');
const openCars = new Set(); // sections dépliées (gardées d'un affichage à l'autre)
const carTrack = {};        // circuit choisi par voiture

/** Manette qui utilise cette voiture (sinon la 1re). */
function addressOf(app, car) {
  return app.setup.slots.find((s) => s.active && s.carId === car.id)?.address ?? 0;
}

/** Section repliable d'une voiture dans le Garage. */
export function calSectionHtml(app, car) {
  const trackId = carTrack[car.id] || app.setup?.trackId || app.data.tracks[0]?.id;
  const cal = calOf(car, trackId);
  const times = timesByCran(cal);
  const done = Object.values(cal).filter((v) => v?.sec || v?.impossible);
  const last = done.length ? Math.max(...done.map((v) => v.date || 0)) : null;
  const addr = carTrack[car.id + ':m'] ?? addressOf(app, car);
  return `
  <details class="cal" data-cal="${esc(car.id)}" ${openCars.has(car.id) ? 'open' : ''}>
    <summary>🟨 VSC adaptatif <span class="muted">· ${done.length}/${CAL_TESTS.length} tests sur ${esc(app.track(trackId)?.name || 'ce circuit')}</span></summary>
    <div class="row" style="gap:10px;flex-wrap:wrap;margin:8px 0">
      <label class="field">Circuit<select data-cal-track>${app.data.tracks.map((t) => `<option value="${esc(t.id)}" ${t.id === trackId ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</select></label>
      <label class="field">Manette du test<select data-cal-addr>${[0, 1, 2, 3, 4, 5].map((a) => `<option value="${a}" ${a === addr ? 'selected' : ''}>Manette ${a + 1}</option>`).join('')}</select></label>
    </div>
    <div class="cal-rows">
      ${CAL_TESTS.map((t) => {
        const v = cal[t.cran];
        const state = v?.impossible ? '<span class="bad">impossible</span>'
          : v?.sec ? `<b class="num">${sec2(v.sec)} s</b> <span class="muted">(${fmtDate(v.date)})</span>` : '<span class="muted">à faire</span>';
        return `<div class="cal-row">
          <span class="cal-pct"><b>${t.pct} %</b> <small class="muted">cran ${t.cran}</small></span>
          <span class="cal-state">${state}</span>
          <button class="btn small primary" data-cal-go="${t.cran}">▶ Démarrer le test</button>
          <button class="btn small ghost" data-cal-no="${t.cran}" title="La voiture ne roule pas à cette valeur, manette à fond">Impossible</button>
        </div>`;
      }).join('')}
    </div>
    ${times.some((x) => x > 0) ? `<p class="muted cal-deduced">Temps déduits : ${times.map((x, c) => (x > 0 ? `cran ${c} → ${sec2(x)} s` : null)).filter(Boolean).join(' · ')}</p>` : ''}
    <p class="warn-note">⚠️ La voiture doit être <b>sur la piste</b> avant d'appuyer sur « Démarrer le test ».</p>
    <p class="muted cal-cond"><b>Conditions du test :</b> ${CAL_LAPS} tours chronométrés, <b>manette enfoncée à 100 %</b> du début à la fin. Si la voiture ne roule pas à cette valeur, touchez <b>Impossible</b>. Les tests sont enregistrés <b>par circuit</b>.</p>
    <p class="muted cal-cond">🔧 Les voitures s'usent (aimants, tresses, pneus) : refaites l'étalonnage de temps en temps${last ? ` — dernier test le <b>${fmtDate(last)}</b>` : ''}.</p>
  </details>`;
}

export function bindCalSections(app, root, rerender) {
  $$('[data-cal]', root).forEach((box) => {
    const car = app.car(box.dataset.cal);
    if (!car) return;
    box.ontoggle = () => { if (box.open) openCars.add(car.id); else openCars.delete(car.id); };
    $('[data-cal-track]', box).onchange = (e) => { carTrack[car.id] = e.target.value; rerender(); };
    $('[data-cal-addr]', box).onchange = (e) => { carTrack[car.id + ':m'] = +e.target.value; };
    const trackId = () => carTrack[car.id] || app.setup?.trackId || app.data.tracks[0]?.id;
    const addr = () => +$('[data-cal-addr]', box).value;
    $$('[data-cal-no]', box).forEach((b) => (b.onclick = async () => {
      await saveCal(app, car, trackId(), +b.dataset.calNo, { impossible: true, date: Date.now() });
      toast(`${car.name} : ${CAL_TESTS.find((t) => t.cran === +b.dataset.calNo).pct} % marqué impossible`, 1800);
      rerender();
    }));
    $$('[data-cal-go]', box).forEach((b) => (b.onclick = () => {
      app.requireConnection(() => openTest(app, car, trackId(), +b.dataset.calGo, addr(), rerender),
        'Connecte le circuit (ou le simulateur) pour faire le test.');
    }));
  });
}

async function saveCal(app, car, trackId, cran, value) {
  const fresh = { ...(app.car(car.id) || car) };
  fresh.vscCal = { ...(fresh.vscCal || {}) };
  fresh.vscCal[trackId] = { ...(fresh.vscCal[trackId] || {}), [cran]: value };
  await app.db.put('cars', fresh);
  await app.loadData();
}

/** Écran de test : la voiture roule au cran du test, on chronomètre 12 tours. */
function openTest(app, car, trackId, cran, address, rerender) {
  const { cu, perf } = app;
  if (app.isRacing) { toast('Une séance est en cours : arrête-la avant de faire un test'); return; }
  const test = CAL_TESTS.find((t) => t.cran === cran);
  const passes = [];   // horodatages des passages sur la ligne (ms, horloge de la CU)
  let finished = false;
  const m = modal(`
    <h2>🟨 Test ${test.pct} % — ${esc(car.name)}</h2>
    <p class="muted" style="margin-top:-4px">Manette ${address + 1} · cran ${cran}/15 · ${esc(app.track(trackId)?.name || '')}</p>
    <p class="warnbox"><b>Manette enfoncée à 100 %</b> pendant tout le test. La voiture doit être sur la piste.</p>
    <div class="cal-live"><span class="cal-count num" id="ctCount">0 / ${CAL_LAPS}</span><span class="muted" id="ctState">En attente du premier passage sur la ligne…</span></div>
    <div class="cal-laps num" id="ctLaps"></div>
    <div class="row" style="justify-content:flex-end;gap:8px;margin-top:12px">
      <button class="btn ghost" id="ctCancel">Annuler le test</button>
      <button class="btn primary" id="ctDone" hidden>Terminer</button>
    </div>`, { onClose: () => stop(false) });

  // la voiture passe au cran du test (renvoyé chaque seconde : une voiture reposée le reprend)
  perf.stop();
  const send = () => cu.setSpeed(address, cran);
  send();
  const keep = setInterval(send, 1000);
  if (app.isSim && !cu.conn.running) cu.conn.go?.(); // simulateur : les voitures roulent

  const onTimer = (e) => {
    const t = e.detail;
    if (finished || t.address !== address || t.sector !== 1) return;
    passes.push(t.timestamp);
    const laps = passes.slice(1).map((ts, i) => (ts - passes[i]) / 1000);
    $('#ctCount', m.el).textContent = `${laps.length} / ${CAL_LAPS}`;
    $('#ctState', m.el).textContent = laps.length ? 'Chronométrage en cours…' : 'Premier passage : c\'est parti !';
    $('#ctLaps', m.el).innerHTML = laps.map((x, i) => `<span class="${i === 0 ? 'muted' : ''}" title="${i === 0 ? 'tour de lancement, non compté' : ''}">${sec2(x)}</span>`).join('');
    if (laps.length >= CAL_LAPS) finish(laps);
  };
  cu.addEventListener('timer', onTimer);

  async function finish(laps) {
    finished = true;
    const counted = laps.slice(1); // le 1er tour (lancement) est écarté
    const sec = Math.round(medianOf(counted) * 1000) / 1000;
    await saveCal(app, car, trackId, cran, { sec, laps: counted.length, date: Date.now() });
    stop(true);
    $('#ctState', m.el).innerHTML = `✅ Temps médian : <b>${sec2(sec)} s</b> (${counted.length} tours, le tour de lancement écarté). Enregistré.`;
    $('#ctCancel', m.el).hidden = true;
    $('#ctDone', m.el).hidden = false;
  }

  let stopped = false;
  function stop(keepResult) {
    if (stopped) return;
    stopped = true;
    finished = true;
    clearInterval(keep);
    cu.removeEventListener('timer', onTimer);
    app.applyTune(address, ['speed', 'brake']); // la voiture retrouve son réglage
    if (app.session && app.session.state !== 'finished') perf.start();
    if (!keepResult) toast('Test annulé', 1500);
    rerender();
  }
  $('#ctCancel', m.el).onclick = async () => {
    if (passes.length > 2 && !(await confirmBox('Annuler le test en cours ?'))) return;
    m.close();
  };
  $('#ctDone', m.el).onclick = () => m.close();
}
