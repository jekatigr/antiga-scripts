// ==UserScript==
// @name         Fonte Antiga - Notification Target Systems
// @namespace    fa.notifications-target-systems
// @version      1.1.0
// @description  Mark galaxy systems mentioned by selected notification types
// @match        *://antiga.hatedabamboo.me/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const MARKS_STORAGE_KEY = 'fa.target-system-marks';
  const LEGACY_MARKS_STORAGE_KEY = 'fa.target-systems';
  const TYPES_STORAGE_KEY = 'fa.target-system-types';
  const MAP_CHANGED_EVENT = 'fa-target-system-markers-changed';
  const MARK_COLOR = '#b7ff00';
  const FILTER_ICON_HTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v5l-4 2v-7L3 5z" fill="currentColor"></path></svg>';

  const NOTIFICATION_TYPES = [
    { key: 'exploration', label: 'Exploration' },
    { key: 'attack', label: 'Attack' },
    { key: 'transport', label: 'Transport' },
    { key: 'harvest', label: 'Harvest' },
    { key: 'trade', label: 'Trade' },
    { key: 'other', label: 'Other' },
  ];
  const TYPE_KEYS = new Set(NOTIFICATION_TYPES.map(type => type.key));
  const ALL_TYPE_KEYS = NOTIFICATION_TYPES.map(type => type.key);

  const style = document.createElement('style');
  style.textContent = `
    :root {
      --fa-target-system-color: ${MARK_COLOR};
    }
    .fa-target-filter {
      position: relative;
      display: block;
    }
    .fa-target-filter > summary {
      width: 2rem;
      padding: 0.3rem 0;
      margin: 0;
      cursor: pointer;
      list-style: none;
      text-align: center;
      white-space: nowrap;
      background: var(--panel-alt);
    }
    .fa-target-filter > summary::-webkit-details-marker {
      display: none;
    }
    .fa-target-filter-panel {
      position: absolute;
      z-index: 20;
      top: calc(100% + 0.35rem);
      right: 0;
      min-width: 12rem;
      padding: 0.65rem;
      border: 1px solid var(--border-soft);
      background: var(--panel-alt);
      box-shadow: 0 0.4rem 1rem rgba(0, 0, 0, 0.35);
    }
    .fa-target-filter-option {
      display: grid;
      grid-template-columns: 1.1rem minmax(0, 1fr);
      align-items: center;
      column-gap: 0.5rem;
      width: 100%;
      box-sizing: border-box;
      padding: 0.2rem 0;
      text-align: left;
      white-space: nowrap;
    }
    .fa-target-filter-option input {
      width: 1rem;
      height: 1rem;
      margin: 0;
      justify-self: start;
      accent-color: var(--fa-target-system-color);
    }
    .fa-target-filter-option span {
      text-align: left;
    }
    .fa-target-filter-summary svg {
      width: 1.1em;
      height: 1.1em;
      vertical-align: -0.15em;
    }
    .fa-target-filter-actions {
      display: flex;
      gap: 0.35rem;
      margin-top: 0.55rem;
      padding-top: 0.55rem;
      border-top: 1px solid var(--border-soft);
    }
    .fa-target-filter-actions button {
      flex: 1;
      white-space: nowrap;
    }
    .fa-target-clear-btn {
      width: 100%;
      margin-top: 0.35rem;
      white-space: nowrap;
    }
    .fa-target-clear-btn:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .fa-target-map-legend {
      color: var(--fa-target-system-color);
    }
    .fa-target-overlay-canvas {
      position: absolute;
      z-index: 1;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);

  function readStorage(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function saveStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {
      // Keep the feature usable for sessions where storage is unavailable.
    }
  }

  function normalizeMarks(value) {
    if (!Array.isArray(value)) return [];

    const seen = new Set();
    const marks = [];
    for (const entry of value) {
      const isLegacyNumber = typeof entry === 'number' || typeof entry === 'string';
      const system = isLegacyNumber
        ? Number(entry)
        : entry && typeof entry === 'object' ? Number(entry.system) : NaN;
      const type = isLegacyNumber
        ? 'other'
        : entry && typeof entry === 'object' ? entry.type || 'other' : '';
      if (!Number.isSafeInteger(system) || system < 1 || !TYPE_KEYS.has(type)) continue;

      const key = `${system}:${type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      marks.push({ system, type });
    }
    return marks;
  }

  function loadSelectedTypes() {
    const value = readStorage(TYPES_STORAGE_KEY, null);
    if (!Array.isArray(value)) return new Set(ALL_TYPE_KEYS);
    return new Set(value.filter(type => TYPE_KEYS.has(type)));
  }

  const storedMarks = readStorage(MARKS_STORAGE_KEY, null);
  const marksFromStorage = storedMarks === null
    ? readStorage(LEGACY_MARKS_STORAGE_KEY, [])
    : storedMarks;
  let marks = normalizeMarks(marksFromStorage);
  let selectedTypes = loadSelectedTypes();

  // Keep the current object-based format, while migrating older arrays of
  // plain system numbers without discarding any saved targets.
  if (storedMarks === null && marks.length > 0) saveStorage(MARKS_STORAGE_KEY, marks);

  function saveMarks() {
    saveStorage(MARKS_STORAGE_KEY, marks);
  }

  function saveSelectedTypes() {
    saveStorage(TYPES_STORAGE_KEY, Array.from(selectedTypes));
  }

  function notifyMapChanged() {
    window.dispatchEvent(new Event(MAP_CHANGED_EVENT));
  }

  function notificationTypeForCard(card) {
    const badge = card.querySelector('.card-badge');
    const label = badge ? badge.textContent.trim().toLowerCase() : '';
    if (!label || label === 'game news') return null;
    if (label.includes('explor')) return 'exploration';
    if (label.includes('attack') || label.includes('battle')) return 'attack';
    if (label.includes('transport')) return 'transport';
    if (label.includes('harvest')) return 'harvest';
    if (label.includes('trade')) return 'trade';
    return 'other';
  }

  function targetSystemForCard(card) {
    for (const coordinate of card.querySelectorAll('.notif-coord')) {
      const match = coordinate.textContent.trim().match(/^Target:\s*(\d+)\s*:/i);
      if (match) return Number(match[1]);
    }

    // Fallback for a markup change that leaves coordinates in the title.
    const title = card.querySelector('.notif-title');
    const match = title && title.textContent.match(/\bPlanet\s+(\d+)\s*-\s*\d+\b/i);
    return match ? Number(match[1]) : null;
  }

  function scanRenderedNotifications() {
    const cards = document.querySelectorAll('#notifications-container .notif-card');
    let changed = false;
    const existing = new Set(marks.map(mark => `${mark.system}:${mark.type}`));

    for (const card of cards) {
      const system = targetSystemForCard(card);
      const type = notificationTypeForCard(card);
      if (!system || !type) continue;

      const key = `${system}:${type}`;
      if (existing.has(key)) continue;
      existing.add(key);
      marks.push({ system, type });
      changed = true;
    }

    if (changed) {
      saveMarks();
      notifyMapChanged();
    }
  }

  function storedSystemCount() {
    return new Set(marks.map(mark => mark.system)).size;
  }

  function setSelectedTypes(types) {
    selectedTypes = new Set(types.filter(type => TYPE_KEYS.has(type)));
    saveSelectedTypes();
    syncFilterControls();
    notifyMapChanged();
  }

  function syncFilterControls() {
    const filter = document.querySelector('.fa-target-filter');
    if (!filter) return;

    const summary = filter.querySelector('.fa-target-filter-summary');
    if (summary) {
      summary.innerHTML = FILTER_ICON_HTML;
      summary.title = `Notification filters (${selectedTypes.size}/${NOTIFICATION_TYPES.length} selected)`;
      summary.setAttribute('aria-label', summary.title);
    }

    filter.querySelectorAll('[data-fa-target-type]').forEach(input => {
      input.checked = selectedTypes.has(input.dataset.faTargetType);
    });
  }

  function updateClearButton() {
    const buttons = document.querySelectorAll('.fa-target-clear-btn');
    if (buttons.length === 0) return;

    const count = storedSystemCount();
    buttons.forEach(button => {
      button.textContent = `Clear marked systems${count ? ` (${count})` : ''}`;
      button.disabled = count === 0;
    });
  }

  function clearMarkedSystems() {
    if (storedSystemCount() === 0) return;
    if (!window.confirm('Clear all saved notification target systems?')) return;
    marks = [];
    saveMarks();
    updateClearButton();
    notifyMapChanged();
  }

  function createFilterControls() {
    const details = document.createElement('details');
    details.className = 'fa-target-filter';

    const summary = document.createElement('summary');
    summary.className = 'action-btn fa-target-filter-summary';
    summary.innerHTML = FILTER_ICON_HTML;
    summary.title = 'Notification filters';
    summary.setAttribute('aria-label', summary.title);
    details.appendChild(summary);

    const panel = document.createElement('div');
    panel.className = 'fa-target-filter-panel';
    for (const type of NOTIFICATION_TYPES) {
      const label = document.createElement('label');
      label.className = 'fa-target-filter-option';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.dataset.faTargetType = type.key;
      input.addEventListener('change', () => {
        if (input.checked) selectedTypes.add(type.key);
        else selectedTypes.delete(type.key);
        saveSelectedTypes();
        syncFilterControls();
        notifyMapChanged();
      });

      const text = document.createElement('span');
      text.textContent = type.label;
      label.append(input, text);
      panel.appendChild(label);
    }

    const actions = document.createElement('div');
    actions.className = 'fa-target-filter-actions';

    const selectAll = document.createElement('button');
    selectAll.type = 'button';
    selectAll.className = 'action-btn';
    selectAll.textContent = 'Select all';
    selectAll.addEventListener('click', () => setSelectedTypes(ALL_TYPE_KEYS));

    const clearAll = document.createElement('button');
    clearAll.type = 'button';
    clearAll.className = 'action-btn';
    clearAll.textContent = 'Clear all';
    clearAll.addEventListener('click', () => setSelectedTypes([]));

    actions.append(selectAll, clearAll);
    panel.appendChild(actions);

    const clearMarked = document.createElement('button');
    clearMarked.type = 'button';
    clearMarked.className = 'action-btn fa-target-clear-btn';
    clearMarked.addEventListener('click', clearMarkedSystems);
    panel.appendChild(clearMarked);

    details.appendChild(panel);
    return details;
  }

  function ensureMapControls() {
    const frame = document.getElementById('galaxy-map-frame');
    const mapControls = frame && frame.querySelector('.galaxy-map-controls');
    if (!frame || !mapControls) return;

    // Remove controls from the previous layout if the script is updated while
    // the game page remains open. The filter and clear action now live only in
    // the map-control dropdown.
    frame.querySelectorAll('.fa-target-controls, .fa-target-header-clear').forEach(legacy => legacy.remove());

    if (!mapControls.querySelector('.fa-target-filter')) {
      mapControls.appendChild(createFilterControls());
    }

    syncFilterControls();
    updateClearButton();
  }

  function injectMapHook() {
    const pageScript = document.createElement('script');
    pageScript.textContent = `
      (function () {
        'use strict';
        const MARKS_STORAGE_KEY = '${MARKS_STORAGE_KEY}';
        const LEGACY_MARKS_STORAGE_KEY = '${LEGACY_MARKS_STORAGE_KEY}';
        const TYPES = new Set(${JSON.stringify(ALL_TYPE_KEYS)});
        const EVENT_NAME = '${MAP_CHANGED_EVENT}';
        const RADII = { small: 2.6, mid: 3.4, large: 4.4 };

        function readMarks() {
          try {
            const primary = localStorage.getItem(MARKS_STORAGE_KEY);
            const raw = primary == null
              ? localStorage.getItem(LEGACY_MARKS_STORAGE_KEY) || '[]'
              : primary;
            const value = JSON.parse(raw);
            if (!Array.isArray(value)) return [];
            return value.map(mark => typeof mark === 'number' || typeof mark === 'string'
              ? { system: mark, type: 'other' }
              : mark);
          } catch (_) {
            return [];
          }
        }

        function readSelectedTypes() {
          try {
            const value = JSON.parse(localStorage.getItem('${TYPES_STORAGE_KEY}') || 'null');
            return new Set(Array.isArray(value) ? value.filter(type => TYPES.has(type)) : Array.from(TYPES));
          } catch (_) {
            return new Set(TYPES);
          }
        }

        function getTargetOverlay(sourceCanvas) {
          const wrap = sourceCanvas.parentElement;
          if (!wrap) return null;

          let overlay = wrap.querySelector('.fa-target-overlay-canvas');
          if (!overlay) {
            overlay = document.createElement('canvas');
            overlay.className = 'fa-target-overlay-canvas';
            sourceCanvas.insertAdjacentElement('afterend', overlay);
          }

          const sourceRect = sourceCanvas.getBoundingClientRect();
          const wrapRect = wrap.getBoundingClientRect();
          overlay.style.left = (sourceRect.left - wrapRect.left) + 'px';
          overlay.style.top = (sourceRect.top - wrapRect.top) + 'px';
          overlay.style.width = sourceRect.width + 'px';
          overlay.style.height = sourceRect.height + 'px';
          if (overlay.width !== sourceCanvas.width) overlay.width = sourceCanvas.width;
          if (overlay.height !== sourceCanvas.height) overlay.height = sourceCanvas.height;
          return overlay;
        }

        function drawTargetSystems() {
          let points;
          try {
            points = state.galaxyMapPoints;
          } catch (_) {
            return;
          }
          const canvas = document.getElementById('galaxy-map-canvas');
          if (!canvas || !Array.isArray(points)) return;

          const overlay = getTargetOverlay(canvas);
          if (!overlay) return;
          const ctx = overlay.getContext('2d');
          ctx.clearRect(0, 0, overlay.width, overlay.height);

          const selected = readSelectedTypes();
          const markedSystems = new Set(
            readMarks()
              .filter(mark => selected.has(mark.type))
              .map(mark => Number(mark.system))
          );
          if (markedSystems.size === 0) return;

          const color = getComputedStyle(document.documentElement)
            .getPropertyValue('--fa-target-system-color').trim() || '#b7ff00';
          ctx.save();
          ctx.fillStyle = color;
          for (const point of points) {
            if (!markedSystems.has(Number(point.system))) continue;
            if (!Number.isFinite(point.px) || !Number.isFinite(point.py)) continue;

            const radius = RADII[point.size] || RADII.small;
            ctx.beginPath();
            ctx.arc(point.px, point.py, radius, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        }

        function install() {
          const original = window.drawGalaxyMap;
          if (typeof original !== 'function') return false;
          if (original.__faTargetSystemsWrapped) {
            // Allow an updated copy of this script to recover without requiring
            // the page to be reopened when an older wrapper is still present.
            drawTargetSystems();
            return true;
          }

          function wrappedDrawGalaxyMap() {
            const result = original.apply(this, arguments);
            drawTargetSystems();
            return result;
          }
          wrappedDrawGalaxyMap.__faTargetSystemsWrapped = true;
          window.drawGalaxyMap = wrappedDrawGalaxyMap;
          drawTargetSystems();
          return true;
        }

        let attempts = 0;
        function tryInstall() {
          if (install() || attempts++ >= 30) return;
          window.setTimeout(tryInstall, 100);
        }

        window.addEventListener(EVENT_NAME, function () {
          if (typeof window.drawGalaxyMap === 'function') window.drawGalaxyMap();
          drawTargetSystems();
        });
        tryInstall();
      })();
    `;
    (document.head || document.documentElement).appendChild(pageScript);
    pageScript.remove();
  }

  let timer = null;
  function update() {
    timer = null;
    scanRenderedNotifications();
    ensureMapControls();
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(update, 150);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });

  injectMapHook();
  update();
})();
