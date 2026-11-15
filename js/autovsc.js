// VSC automatique : le VSC se déclenche tout seul quand une voiture ne repasse plus.
//  - par tour    : pas de passage sur la ligne depuis X secondes
//  - par secteur : pas de passage sur un capteur (ligne ou Check Lane) depuis Y secondes
//    (seulement pour les voitures déjà vues sur une Check Lane)
// Exclus : voiture au stand, en panne sèche, arrivée, pas encore partie ; pendant un VSC,
// un drapeau rouge ou la fin de course. Le compte repart à chaque passage, à la sortie
// du stand et à chaque reprise (fin de VSC, de drapeau rouge, départ).

export const DEFAULT_AUTO = { lapOn: false, lapSec: 12, sectorOn: false, sectorSec: 7 };

export const autoCfg = (app) => ({ ...DEFAULT_AUTO, ...(app.vscCfg?.auto || {}) });

/** Renvoie { comp, rule, secs } si une voiture doit déclencher le VSC, sinon null. */
export function checkAutoVsc(app, now = performance.now()) {
  const s = app.session;
  const cfg = autoCfg(app);
  if (!s || s.state !== 'running' || (!cfg.lapOn && !cfg.sectorOn)) return null;
  if (s.flag === 'vsc' || s.flag === 'red' || s.vscCountdown) return null;
  const base = Math.max(s.greenSince || 0, s.startedAt || 0);
  for (const c of s.comps.values()) {
    if (!c.onTrack || c.inPit || c.finished || app.isOutOfFuel?.(c.address)) continue;
    if (c.autoVscFor !== undefined && c.autoVscFor === c.seenAt) continue; // déjà signalée, pas repassée depuis
    const ref = (t) => Math.max(t || 0, base, c.pitOutAt || 0);
    if (cfg.lapOn) {
      const secs = (now - ref(c.lineAt)) / 1000;
      if (secs > cfg.lapSec) return { comp: c, rule: 'tour', secs };
    }
    if (cfg.sectorOn && c.sawSector) {
      const secs = (now - ref(c.seenAt)) / 1000;
      if (secs > cfg.sectorSec) return { comp: c, rule: 'secteur', secs };
    }
  }
  return null;
}
