// ==UserScript==
// @name         Fonte Antiga - Resource Summary
// @namespace    fa.res-summary
// @version      1.1.4
// @description  Show Σ total after resources in notification cards and active fleet cargo rows
// @match        *://fonteantiga.com/*
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

  function addTotalToNotificationGrid(grid) {
    const cells = [...grid.querySelectorAll('.notif-res[data-res]')];
    const existing = grid.querySelector('.fa-res-total');
    if (!cells.length) { existing?.remove(); return; }
    const total = cells.reduce((sum, cell) => sum + parseNum(cell.querySelector('.notif-res-val')?.textContent || ''), 0);
    if (!total) { existing?.remove(); return; }
    const span = existing || document.createElement('span');
    span.className = 'stat fa-res-total';
    span.textContent = `Σ ${fmt(total)}`;
    if (!existing) grid.appendChild(span);
  }

  function update() {
    // v0.5.1 renders notification resources as .notif-res chips instead of
    // the former .stat-m/.stat-s/.stat-h notification rows.
    const notifContainer = document.getElementById('notifications-container');
    notifContainer?.querySelectorAll('.notif-res-grid').forEach(addTotalToNotificationGrid);
    notifContainer?.querySelectorAll('.notif-card .stat-row').forEach(addTotalToRow);

    const fleetsContainer = document.getElementById('fleets-container');
    // Cargo row: <div class="stat-row"><span class="stat muted">Cargo: <span class="stat-m">...</span> ...</span></div>
    fleetsContainer?.querySelectorAll('.card .stat-row').forEach(addTotalToRow);
  }

  function mutationTouchesResourceRows(records) {
    return records.some(record => {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (target?.closest('#notifications-container, #fleets-container')) return true;
      if (record.type !== 'childList') return false;
      return Array.from(record.addedNodes).some(node =>
        node.nodeType === 1 && (
          node.matches('#notifications-container, #fleets-container') ||
          node.querySelector('#notifications-container, #fleets-container')
        )
      );
    });
  }

  function schedule(records) {
    if (!mutationTouchesResourceRows(records)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(update, 150);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, characterData: true, subtree: true });

  update();
})();
