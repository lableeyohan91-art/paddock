// Petits utilitaires d'interface.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let toastTimer = null;
export function toast(msg, ms = 2500) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

export function modal(html, { onClose } = {}) {
  const root = document.getElementById('modalRoot');
  root.innerHTML = `<div class="modal-back"><div class="modal">${html}</div></div>`;
  const back = root.firstElementChild;
  const close = () => {
    root.innerHTML = '';
    onClose?.();
  };
  back.addEventListener('click', (e) => {
    if (e.target === back || e.target.closest('[data-close]')) close();
  });
  return { el: back.firstElementChild, close };
}

export function confirmBox(text) {
  return new Promise((resolve) => {
    const m = modal(`
      <p style="margin-top:0">${esc(text)}</p>
      <div class="row" style="justify-content:flex-end">
        <button class="btn ghost" data-close>Annuler</button>
        <button class="btn primary" id="okBtn">Confirmer</button>
      </div>`, { onClose: () => resolve(false) });
    m.el.querySelector('#okBtn').onclick = () => {
      resolve(true);
      document.getElementById('modalRoot').innerHTML = '';
    };
  });
}

/** Demande un texte (nom…). Résout la chaîne saisie, ou null si annulé. */
export function promptBox(title, value = '', placeholder = '') {
  return new Promise((resolve) => {
    let done = false;
    const m = modal(`
      <h2 style="margin-top:0">${esc(title)}</h2>
      <input type="text" id="pbIn" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="40" style="width:100%">
      <div class="row" style="justify-content:flex-end;margin-top:14px">
        <button class="btn ghost" data-close>Annuler</button>
        <button class="btn primary" id="pbOk">Valider</button>
      </div>`, { onClose: () => { if (!done) resolve(null); } });
    const input = m.el.querySelector('#pbIn');
    const ok = () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      done = true;
      m.close();
      resolve(v);
    };
    m.el.querySelector('#pbOk').onclick = ok;
    input.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    setTimeout(() => { input.focus(); input.select(); }, 50);
  });
}

export function download(filename, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const fmtDate = (ts) => new Date(ts).toLocaleString('fr-FR', {
  day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
});
