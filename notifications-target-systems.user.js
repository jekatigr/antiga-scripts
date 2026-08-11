// ==UserScript==
// @name         Fonte Antiga - Notification Target Systems
// @namespace    fa.notifications-target-systems
// @version      1.2.0
// @description  Cache notifications locally and mark their target systems on the galaxy map
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
  // This is a shared contract for companion userscripts. The notifications
  // store contains the complete raw object returned by /notifications.
  const NOTIFICATION_DB_NAME = 'fa.notifications';
  const NOTIFICATION_DB_VERSION = 1;
  const NOTIFICATION_STORE = 'notifications';
  const NOTIFICATION_META_STORE = 'metadata';
  const NOTIFICATION_SYNC_META_KEY = 'sync';
  const NOTIFICATION_PAGE_SIZE = 10;
  const NOTIFICATION_REQUEST_DELAY_MS = 1000;
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
    .fa-target-map-legend {
      color: var(--fa-target-system-color);
    }
    .fa-target-overlay-canvas {
      position: absolute;
      z-index: 1;
      pointer-events: none;
    }
    .fa-target-sync {
      margin-top: 0.55rem;
      padding-top: 0.55rem;
      border-top: 1px solid var(--border-soft);
    }
    .fa-target-sync-btn {
      width: 100%;
      white-space: nowrap;
    }
    .fa-target-sync-btn:disabled {
      opacity: 0.65;
      cursor: wait;
    }
    .fa-target-sync-progress {
      display: block;
      width: 100%;
      height: 0.7rem;
      margin-top: 0.45rem;
      accent-color: var(--fa-target-system-color);
    }
    .fa-target-sync-status {
      margin-top: 0.4rem;
      padding: 0.4rem 0.5rem;
      border: 1px solid var(--border-soft);
      border-radius: 0.25rem;
      background: var(--panel);
      font-size: 0.72rem;
      line-height: 1.35;
      text-align: center;
      white-space: pre-line;
      overflow-wrap: anywhere;
      font-variant-numeric: tabular-nums;
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

  const syncState = {
    status: 'idle',
    total: 0,
    cached: 0,
    newCount: 0,
    error: '',
    updatedAt: null,
  };
  let syncPromise = null;

  function idbRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
    });
  }

  function openNotificationDb() {
    if (!window.indexedDB) return Promise.reject(new Error('IndexedDB is unavailable.'));
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(NOTIFICATION_DB_NAME, NOTIFICATION_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        let store;
        if (!db.objectStoreNames.contains(NOTIFICATION_STORE)) {
          store = db.createObjectStore(NOTIFICATION_STORE, { keyPath: 'id' });
        } else {
          store = request.transaction.objectStore(NOTIFICATION_STORE);
        }
        if (!store.indexNames.contains('created_at')) store.createIndex('created_at', 'created_at');
        if (!store.indexNames.contains('destination_system')) store.createIndex('destination_system', 'destination_system');
        if (!store.indexNames.contains('notification_type')) store.createIndex('notification_type', 'notification_type');
        if (!db.objectStoreNames.contains(NOTIFICATION_META_STORE)) {
          db.createObjectStore(NOTIFICATION_META_STORE, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open notification cache.'));
    });
  }

  function getNotificationMeta(db) {
    return idbRequest(db.transaction(NOTIFICATION_META_STORE, 'readonly')
      .objectStore(NOTIFICATION_META_STORE).get(NOTIFICATION_SYNC_META_KEY));
  }

  function saveNotificationMeta(db, value) {
    return idbRequest(db.transaction(NOTIFICATION_META_STORE, 'readwrite')
      .objectStore(NOTIFICATION_META_STORE).put({ ...value, key: NOTIFICATION_SYNC_META_KEY }));
  }

  function getStoredNotificationKeys(db) {
    return idbRequest(db.transaction(NOTIFICATION_STORE, 'readonly')
      .objectStore(NOTIFICATION_STORE).getAllKeys());
  }

  function getStoredNotifications(db) {
    return idbRequest(db.transaction(NOTIFICATION_STORE, 'readonly')
      .objectStore(NOTIFICATION_STORE).getAll());
  }

  function putStoredNotifications(db, notifications) {
    if (notifications.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(NOTIFICATION_STORE, 'readwrite');
      const store = tx.objectStore(NOTIFICATION_STORE);
      for (const notification of notifications) store.put(notification);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error || new Error('Could not save notifications.'));
      tx.onabort = () => reject(tx.error || new Error('Could not save notifications.'));
    });
  }

  function notificationTypeForData(notification) {
    const notificationType = String(notification && notification.notification_type || '').toLowerCase();
    const missionType = String(notification && notification.mission_type || '').toLowerCase();
    if (notificationType.includes('explor') || missionType === 'explore') return 'exploration';
    if (notificationType.includes('attack') || notificationType.includes('battle') || notificationType === 'planet_scanned' || missionType === 'attack') return 'attack';
    if (notificationType.includes('harvest') || missionType === 'harvest') return 'harvest';
    if (notificationType.includes('trade') || missionType === 'trade') return 'trade';
    if (notificationType.includes('transport') || missionType === 'transport') return 'transport';
    return 'other';
  }

  function targetSystemForData(notification) {
    const system = Number(notification && notification.destination_system);
    return Number.isSafeInteger(system) && system > 0 ? system : null;
  }

  function marksFromStoredNotifications(notifications) {
    return normalizeMarks(notifications.map(notification => {
      const system = targetSystemForData(notification);
      return system ? { system, type: notificationTypeForData(notification) } : null;
    }).filter(Boolean));
  }

  async function rebuildMarksFromNotificationCache(db) {
    const notifications = await getStoredNotifications(db);
    // If the server has no notifications at all, retain migrated legacy marks
    // until a notification is available to provide their source data.
    if (notifications.length > 0 || syncState.total > 0) {
      marks = marksFromStoredNotifications(notifications);
      saveMarks();
      notifyMapChanged();
    }
  }

  function updateSyncControls() {
    const controls = document.querySelectorAll('.fa-target-sync');
    if (controls.length === 0) return;

    const syncing = syncState.status === 'syncing';
    const total = Math.max(0, Number(syncState.total) || 0);
    const cached = Math.max(0, Number(syncState.cached) || 0);
    const progress = Math.min(cached, total);
    let statusText = 'Not synced yet';
    if (syncing) {
      statusText = `Downloaded ${progress.toLocaleString()} / ${total.toLocaleString()}`;
      if (syncState.newCount > 0) statusText += ` · ${syncState.newCount.toLocaleString()} new`;
    } else if (syncState.status === 'complete') {
      statusText = `${cached.toLocaleString()} cached`;
      if (syncState.newCount > 0) statusText += ` · ${syncState.newCount.toLocaleString()} new`;
      if (syncState.updatedAt) statusText += `\nUpdated ${new Date(syncState.updatedAt).toLocaleString()}`;
    } else if (syncState.status === 'error') {
      statusText = `Sync failed\n${syncState.error || 'Unknown error'}`;
    }

    controls.forEach(control => {
      const button = control.querySelector('.fa-target-sync-btn');
      const progressBar = control.querySelector('.fa-target-sync-progress');
      const status = control.querySelector('.fa-target-sync-status');
      if (button) {
        button.disabled = syncing;
        button.textContent = syncing ? 'Syncing notifications…' : 'Sync notifications';
      }
      if (progressBar) {
        progressBar.max = total || 1;
        progressBar.value = progress;
        progressBar.classList.toggle('hidden', !syncing);
      }
      if (status) status.textContent = statusText;
    });
  }

  function setSyncState(changes) {
    Object.assign(syncState, changes);
    updateSyncControls();
  }

  function notificationPageFromResponse(response) {
    const body = response && response.body;
    if (!response || response.status !== 200 || !body || !Array.isArray(body.notifications)) {
      throw new Error((body && body.error) || `Notification request failed (HTTP ${response && response.status || 0}).`);
    }
    return {
      notifications: body.notifications,
      total: typeof body.total === 'number' ? body.total : body.notifications.length,
    };
  }

  async function fetchNotificationPage(offset, limit = NOTIFICATION_PAGE_SIZE) {
    return notificationPageFromResponse(await req('GET', `/notifications?limit=${limit}&offset=${offset}`));
  }

  function wait(milliseconds) {
    return new Promise(resolve => window.setTimeout(resolve, milliseconds));
  }

  async function runNotificationSync() {
    let db = null;
    let offset = 0;
    try {
      db = await openNotificationDb();
      const previousMeta = await getNotificationMeta(db);
      const knownKeys = new Set((await getStoredNotificationKeys(db)).map(String));
      const wasComplete = previousMeta && previousMeta.status === 'complete';
      const firstPage = await fetchNotificationPage(0, NOTIFICATION_PAGE_SIZE);
      const total = Math.max(0, firstPage.total);
      setSyncState({
        status: 'syncing',
        total,
        cached: knownKeys.size,
        newCount: 0,
        error: '',
      });

      let page = firstPage;
      while (page.notifications.length > 0) {
        const newNotifications = page.notifications.filter(notification => {
          if (!notification || notification.id == null) return false;
          const key = String(notification.id);
          if (knownKeys.has(key)) return false;
          knownKeys.add(key);
          return true;
        });
        await putStoredNotifications(db, newNotifications);
        setSyncState({ cached: knownKeys.size, newCount: syncState.newCount + newNotifications.length });

        offset += page.notifications.length;
        await saveNotificationMeta(db, {
          status: 'syncing', total, cached: knownKeys.size,
          nextOffset: offset, updatedAt: syncState.updatedAt,
        });

        if (offset >= total) break;
        // Once a completed cache reaches an already-known record, all older
        // records are cached too because the API is newest-first. This avoids
        // downloading every historical page on every visit.
        const reachedKnownRecord = wasComplete && page.notifications.some(notification => notification && notification.id != null && !newNotifications.includes(notification));
        if (wasComplete && reachedKnownRecord) break;
        await wait(NOTIFICATION_REQUEST_DELAY_MS);
        page = await fetchNotificationPage(offset);
      }

      if (!wasComplete && offset < total) {
        throw new Error('The server returned an incomplete notification page.');
      }

      const updatedAt = new Date().toISOString();
      setSyncState({ status: 'complete', cached: knownKeys.size, updatedAt, error: '' });
      await saveNotificationMeta(db, {
        status: 'complete', total, cached: knownKeys.size,
        nextOffset: offset, updatedAt,
      });
      await rebuildMarksFromNotificationCache(db);
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      setSyncState({ status: 'error', error: message });
      if (db) {
        try {
          await saveNotificationMeta(db, {
            status: 'error', total: syncState.total, cached: syncState.cached,
            nextOffset: offset, error: message, updatedAt: syncState.updatedAt,
          });
        } catch (_) {
          // The visible error is sufficient if IndexedDB also failed.
        }
      }
    } finally {
      if (db) db.close();
    }
  }

  function syncNotifications() {
    if (syncPromise) return syncPromise;
    syncPromise = runNotificationSync().finally(() => {
      syncPromise = null;
      updateSyncControls();
    });
    return syncPromise;
  }

  function loadPersistedSyncState() {
    openNotificationDb().then(async db => {
      try {
        const meta = await getNotificationMeta(db);
        if (meta && syncState.status === 'idle') {
          setSyncState({
            status: meta.status === 'complete' ? 'complete' : 'idle',
            total: meta.total || 0,
            cached: meta.cached || 0,
            updatedAt: meta.updatedAt || null,
            error: meta.error || '',
          });
        }
      } finally {
        db.close();
      }
    }).catch(() => {
      // The automatic sync will show a useful error if storage is unavailable.
    });
  }

  function createSyncControls() {
    const wrap = document.createElement('div');
    wrap.className = 'fa-target-sync';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'action-btn fa-target-sync-btn';
    button.addEventListener('click', syncNotifications);

    const progress = document.createElement('progress');
    progress.className = 'fa-target-sync-progress hidden';
    progress.max = 1;
    progress.value = 0;
    progress.setAttribute('aria-label', 'Notification download progress');

    const status = document.createElement('div');
    status.className = 'muted fa-target-sync-status';
    status.setAttribute('aria-live', 'polite');

    wrap.append(button, progress, status);
    updateSyncControls();
    return wrap;
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
    panel.appendChild(createSyncControls());

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
  let galaxyTabWasOpen = false;
  function update() {
    timer = null;
    ensureMapControls();
    updateSyncControls();

    const galaxyTab = document.getElementById('screen-systems');
    const galaxyTabOpen = !!galaxyTab && !galaxyTab.classList.contains('hidden');
    if (galaxyTabOpen && !galaxyTabWasOpen) syncNotifications();
    galaxyTabWasOpen = galaxyTabOpen;
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(update, 150);
  }

  document.addEventListener('click', event => {
    document.querySelectorAll('.fa-target-filter[open]').forEach(filter => {
      if (!filter.contains(event.target)) filter.removeAttribute('open');
    });
  });

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });

  injectMapHook();
  update();
  loadPersistedSyncState();
})();
