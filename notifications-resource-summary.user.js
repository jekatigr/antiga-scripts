// ==UserScript==
// @name         Fonte Antiga - Resource Summary
// @namespace    fa.res-summary
// @version      1.1.1
// @description  Show Σ total after resources in notification cards and active fleet cargo rows
// @match        *://antiga.hatedabamboo.me/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
    .fa-res-total {
      font-variant-numeric: tabular-nums;
      margin-left: 0.5em;
    }`;
  document.head.appendChild(style);

  let timer = null;

  function parseNum(text) {
    const m = text.match(/[\d,]+/);
    return m ? parseInt(m[0].replace(/,/g, ''), 10) : 0;
  }

  function fmt(n) { return n.toLocaleString(); }

  function addTotalToRow(row) {
    const mEl = row.querySelector('.stat-m');
    const sEl = row.querySelector('.stat-s');
    const hEl = row.querySelector('.stat-h');

    const existing = row.querySelector('.fa-res-total');
    if (!mEl && !sEl) {
      existing?.remove();
      return; // no resources in this row
    }

    // Find the last resource element (helium > silicon > metal).
    const lastEl = hEl || sEl || mEl;

    let metal = 0, silicon = 0, helium = 0;
    mEl && (metal = parseNum(mEl.textContent));
    sEl && (silicon = parseNum(sEl.textContent));
    hEl && (helium = parseNum(hEl.textContent));

    const total = metal + silicon + helium;
    if (total === 0) {
      existing?.remove();
      return;
    }

    const span = existing || document.createElement('span');
    span.className = 'stat fa-res-total';
    const label = `Σ ${fmt(total)}`;
    if (span.textContent !== label) span.textContent = label;
    if (!existing) row.insertBefore(span, lastEl.nextElementSibling);
    else if (span.previousElementSibling !== lastEl) lastEl.insertAdjacentElement('afterend', span);
  }

  function update() {
    // Update in place. Removing and recreating our own totals on every pass
    // creates a MutationObserver feedback loop and unnecessary layout work.
    const notifContainer = document.getElementById('notifications-container');
    notifContainer?.querySelectorAll('.notif-card .stat-row').forEach(addTotalToRow);

    const fleetsContainer = document.getElementById('fleets-container');
    // Cargo row: <div class="stat-row"><span class="stat muted">Cargo: <span class="stat-m">...</span> ...</span></div>
    fleetsContainer?.querySelectorAll('.card .stat-row').forEach(addTotalToRow);
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(update, 150);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    characterData: true,
    subtree: true,
  });

  update();
})();
