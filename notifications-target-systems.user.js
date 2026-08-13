// ==UserScript==
// @name         Fonte Antiga - Notification Target Systems
// @namespace    fa.notifications-target-systems
// @version      1.6.0
// @description  Cache notifications locally and mark their target systems on the galaxy map
// @match        *://antiga.hatedabamboo.me/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const TYPES_STORAGE_KEY = 'fa.target-system-types';
  const MAP_CHANGED_EVENT = 'fa-target-system-markers-changed';
  // This is a shared contract for companion userscripts. The notifications
  // store contains the complete raw notification object from /notifications
  // (unwrapped from the combined feed on v0.3.3+).
  const NOTIFICATION_DB_NAME = 'fa.notifications';
  // Keep this database/store contract stable so notifications cached by older
  // script versions remain readable after a userscript update.
  const NOTIFICATION_DB_VERSION = 1;
  const NOTIFICATION_STORE = 'notifications';
  const NOTIFICATION_META_STORE = 'metadata';
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

  // Shared notification-cache service. This intentionally lives in every
  // notification consumer so either script works when installed alone.
  (function startNotificationCacheService() {
    const SERVICE_KEY = '__faNotificationCacheService';
    if (window[SERVICE_KEY]) return;
    const DB_NAME = 'fa.notifications';
    const DB_VERSION = 1;
    const STORE = 'notifications';
    const META = 'metadata';
    const META_KEY = 'sync';
    const PAGE_SIZE = 10;
    const PAGE_DELAY = 1000;
    const UPDATE_EVENT = 'fa-notifications-updated';
    const CHANNEL = 'fa.notifications';
    let dbPromise = null;
    let syncPromise = null;
    let lastUnread = null;
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);

    function result(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
      });
    }
    function openDb() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        if (!indexedDB) return reject(new Error('IndexedDB is unavailable.'));
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          const store = db.objectStoreNames.contains(STORE)
            ? request.transaction.objectStore(STORE)
            : db.createObjectStore(STORE, { keyPath: 'id' });
          if (!store.indexNames.contains('created_at')) store.createIndex('created_at', 'created_at');
          if (!store.indexNames.contains('destination_system')) store.createIndex('destination_system', 'destination_system');
          if (!store.indexNames.contains('notification_type')) store.createIndex('notification_type', 'notification_type');
          if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
        };
        request.onsuccess = () => {
          resolve(request.result);
        };
        request.onerror = () => {
          reject(request.error || new Error('Could not open notification cache.'));
        };
      });
      dbPromise.catch(() => { dbPromise = null; });
      return dbPromise;
    }
    async function meta(db) { return result(db.transaction(META, 'readonly').objectStore(META).get(META_KEY)); }
    async function saveMeta(db, changes) {
      const current = (await meta(db)) || {};
      return result(db.transaction(META, 'readwrite').objectStore(META).put({ ...current, ...changes, key: META_KEY }));
    }
    function items(body) {
      return body && Array.isArray(body.items) ? body.items
        .filter(item => item && item.kind !== 'game_news' && item.notification && item.notification.id != null)
        .map(item => item.notification) : [];
    }
    function announce() {
      window.dispatchEvent(new Event(UPDATE_EVENT));
      try { channel?.postMessage({ type: UPDATE_EVENT }); } catch (_) {}
    }
    function installPageNetworkBridge() {
      const script = document.createElement('script');
      script.textContent = `
        (function () {
          'use strict';
          if (window.__faNotificationNetworkBridge) return;
          window.__faNotificationNetworkBridge = true;
          const SOURCE = 'fa.notifications.network';
          function report(url, status, text) {
            let path;
            try { path = new URL(url, location.href).pathname; } catch (_) { return; }
            if (path !== '/api/poll' && path !== '/api/notifications') return;
            let body;
            try { body = JSON.parse(text); } catch (_) { return; }
            window.postMessage({ source: SOURCE, path, status, body }, '*');
          }
          function installFetch() {
            if (!window.fetch || window.fetch.__faNotificationNetworkBridge) return !!window.fetch;
            const nativeFetch = window.fetch;
            function wrappedFetch(...args) {
              const url = args[0] && args[0].url ? args[0].url : args[0];
              const request = nativeFetch.apply(this, args);
              request.then(response => response.clone().text().then(text => report(url, response.status, text))).catch(() => {});
              return request;
            }
            wrappedFetch.__faNotificationNetworkBridge = true;
            window.fetch = wrappedFetch;
            return true;
          }
          function installXhr() {
            if (!window.XMLHttpRequest || XMLHttpRequest.prototype.__faNotificationNetworkBridge) return !!window.XMLHttpRequest;
            const nativeOpen = XMLHttpRequest.prototype.open;
            const nativeSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function (method, url, ...args) {
              this.__faNotificationNetworkBridgeUrl = url;
              return nativeOpen.call(this, method, url, ...args);
            };
            XMLHttpRequest.prototype.send = function (...args) {
              this.addEventListener('load', () => report(this.__faNotificationNetworkBridgeUrl, this.status, this.responseText));
              return nativeSend.apply(this, args);
            };
            XMLHttpRequest.prototype.__faNotificationNetworkBridge = true;
            return true;
          }
          function tryInstall() {
            const ready = installFetch() && installXhr();
            if (!ready) window.setTimeout(tryInstall, 50);
          }
          tryInstall();
        })();
      `;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
    }
    function handlePageNetworkMessage(event) {
      if (!event.data || event.data.source !== 'fa.notifications.network' || event.data.status < 200 || event.data.status >= 300) return;
      if (event.data.path === '/api/poll') poll(event.data.body).catch(() => {});
      if (event.data.path === '/api/notifications') upsert(items(event.data.body)).catch(() => {});
    }
    window.addEventListener('message', handlePageNetworkMessage);
    installPageNetworkBridge();
    async function upsert(notifications, changes = {}) {
      if (!notifications.length) return;
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        notifications.forEach(notification => tx.objectStore(STORE).put(notification));
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('Could not save notifications.'));
        tx.onabort = () => reject(tx.error || new Error('Could not save notifications.'));
      });
      const cached = await result(db.transaction(STORE, 'readonly').objectStore(STORE).count());
      await saveMeta(db, { ...changes, cached, updatedAt: new Date().toISOString() });
      announce();
    }
    async function page(offset) {
      const response = await fetch(`/api/notifications?limit=${PAGE_SIZE}&offset=${offset}`, {
        credentials: 'same-origin', headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error(`Notification request failed (HTTP ${response.status}).`);
      const body = await response.json();
      if (!body || !Array.isArray(body.items)) throw new Error('Notification response has an unknown shape.');
      return { notifications: items(body), itemCount: body.items.length, total: Number(body.total) || body.items.length };
    }
    async function sync() {
      if (syncPromise) return syncPromise;
      const runSync = async () => {
        const db = await openDb();
        const previous = await meta(db);
        const keys = new Set((await result(db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys())).map(String));
        // A completed sync can stop at the first cached item. An interrupted
        // sync must first reach the last notification committed by its prior
        // run; cached items before that checkpoint do not prove that there is
        // no gap after it.
        const full = !previous || previous.status !== 'complete';
        const resumeId = full && previous && previous.status === 'syncing' && previous.lastDownloadedId != null
          ? String(previous.lastDownloadedId) : null;
        let checkpointReached = !resumeId;
        let offset = 0;
        let current = await page(0);
        await saveMeta(db, { status: 'syncing', total: current.total, nextOffset: 0 });
        while (current.itemCount > 0) {
          const notifications = current.notifications;
          const checkpointIndex = !checkpointReached && resumeId
            ? notifications.findIndex(notification => String(notification.id) === resumeId) : -1;
          if (checkpointIndex >= 0) checkpointReached = true;

          // Before the checkpoint, cached records are ignored as stop signals.
          // Once the checkpoint has been reached, or for a completed sync, the
          // first cached record is the safe boundary for this page.
          let boundaryIndex = -1;
          if (!full || (resumeId && checkpointReached)) {
            const searchFrom = checkpointIndex >= 0 ? checkpointIndex + 1 : 0;
            boundaryIndex = notifications.findIndex((notification, index) =>
              index >= searchFrom && keys.has(String(notification.id)));
          }
          const pageNotifications = boundaryIndex >= 0
            ? notifications.slice(0, boundaryIndex) : notifications;
          const fresh = pageNotifications.filter(notification => {
            const key = String(notification.id);
            if (keys.has(key)) return false;
            keys.add(key);
            return true;
          });
          const lastDownloaded = pageNotifications[pageNotifications.length - 1];
          const checkpoint = checkpointReached && lastDownloaded
            ? { lastDownloadedId: String(lastDownloaded.id) } : {};
          await upsert(fresh, { status: 'syncing', total: current.total, nextOffset: offset, ...checkpoint });
          offset += current.itemCount;
          await saveMeta(db, {
            status: 'syncing', total: current.total, cached: keys.size, nextOffset: offset, ...checkpoint,
          });
          if (boundaryIndex >= 0 || offset >= current.total) break;
          await new Promise(resolve => setTimeout(resolve, PAGE_DELAY));
          current = await page(offset);
        }
        await saveMeta(db, { status: 'complete', total: current.total, cached: keys.size, nextOffset: offset, updatedAt: new Date().toISOString() });
        announce();
      };
      const execute = async () => {
        if (navigator.locks && typeof navigator.locks.request === 'function') {
          return navigator.locks.request('fa.notifications.sync', { ifAvailable: true }, lock => {
            if (!lock) return undefined;
            return runSync();
          });
        }
        return runSync();
      };
      syncPromise = execute().catch(() => {}).finally(() => {
        syncPromise = null;
      });
      return syncPromise;
    }
    async function poll(body) {
      const unread = Number(body && body.notifications_unread);
      if (!Number.isFinite(unread)) return;
      const db = await openDb();
      const saved = await meta(db);
      const old = lastUnread == null ? Number(saved && saved.unreadCount) : lastUnread;
      lastUnread = unread;
      await saveMeta(db, { unreadCount: unread });
      // Only start another synchronization when the unread count increases.
      // Do not queue a second full sync while the initial backfill is still
      // running; otherwise each poll restarts the pagination after completion.
      if (Number.isFinite(old) && unread > old && !syncPromise) sync();
    }
    function inspect(url, response) {
      if (!response || !response.ok) return;
      let path = '';
      try { path = new URL(url, location.href).pathname; } catch (_) { return; }
      if (path === '/api/poll') response.clone().json().then(poll).catch(() => {});
      if (path === '/api/notifications') response.clone().json().then(body => upsert(items(body))).catch(() => {});
    }
    if (window.fetch && !window.fetch.__faNotificationCache) {
      const nativeFetch = window.fetch;
      const wrappedFetch = function (...args) {
        const url = args[0] && args[0].url ? args[0].url : args[0];
        const request = nativeFetch.apply(this, args);
        request.then(response => inspect(url, response)).catch(() => {});
        return request;
      };
      wrappedFetch.__faNotificationCache = true;
      window.fetch = wrappedFetch;
    }
    if (window.XMLHttpRequest && !XMLHttpRequest.prototype.__faNotificationCache) {
      const nativeOpen = XMLHttpRequest.prototype.open;
      const nativeSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url, ...args) {
        this.__faNotificationCacheUrl = url;
        return nativeOpen.call(this, method, url, ...args);
      };
      XMLHttpRequest.prototype.send = function (...args) {
        this.addEventListener('load', () => {
          if (this.status >= 200 && this.status < 300) {
            try { inspect(this.__faNotificationCacheUrl, new Response(this.responseText, { status: this.status })); } catch (_) {}
          }
        });
        return nativeSend.apply(this, args);
      };
      XMLHttpRequest.prototype.__faNotificationCache = true;
    }
    window[SERVICE_KEY] = { sync };
    sync();
  })();

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
  `;
  try {
    localStorage.removeItem('fa.target-system-marks');
    localStorage.removeItem('fa.target-systems');
  } catch (_) {}

  const appendStyle = () => (document.head || document.documentElement)?.appendChild(style);
  if (document.head) appendStyle();
  else document.addEventListener('DOMContentLoaded', appendStyle, { once: true });

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

  function loadSelectedTypes() {
    const value = readStorage(TYPES_STORAGE_KEY, null);
    if (!Array.isArray(value)) return new Set(ALL_TYPE_KEYS);
    return new Set(value.filter(type => TYPE_KEYS.has(type)));
  }

  let selectedTypes = loadSelectedTypes();

  function saveSelectedTypes() {
    saveStorage(TYPES_STORAGE_KEY, Array.from(selectedTypes));
  }

  function setSelectedTypes(types) {
    selectedTypes = new Set(types.filter(type => TYPE_KEYS.has(type)));
    saveSelectedTypes();
    syncFilterControls();
    window.dispatchEvent(new Event(MAP_CHANGED_EVENT));
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
        window.dispatchEvent(new Event(MAP_CHANGED_EVENT));
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
        const DB_NAME = 'fa.notifications';
        const DB_VERSION = 1;
        const STORE_NAME = 'notifications';
        const TYPES = new Set(${JSON.stringify(['exploration', 'attack', 'transport', 'harvest', 'trade', 'other'])});
        const EVENT_NAME = 'fa-target-system-markers-changed';
        const RADII = { small: 2.6, mid: 3.4, large: 4.4 };
        let targetMarks = [];
        let marksLoaded = false;
        let marksLoadPromise = null;
        let systemsScreenWasVisible = false;
        let mapWasVisible = false;

        function requestResult(request) {
          return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
          });
        }
        function notificationType(notification) {
          const notificationType = String(notification && notification.notification_type || '').toLowerCase();
          const missionType = String(notification && notification.mission_type || '').toLowerCase();
          if (notificationType.includes('explor') || missionType === 'explore') return 'exploration';
          if (notificationType.includes('attack') || notificationType.includes('battle') || notificationType === 'planet_scanned' || missionType === 'attack') return 'attack';
          if (notificationType.includes('harvest') || missionType === 'harvest') return 'harvest';
          if (notificationType.includes('trade') || missionType === 'trade') return 'trade';
          if (notificationType.includes('transport') || missionType === 'transport') return 'transport';
          return 'other';
        }
        async function readNotificationMarks() {
          if (!window.indexedDB) return [];
          if (indexedDB.databases) {
            const databases = await indexedDB.databases();
            if (!databases.some(database => database.name === DB_NAME)) return [];
          }
          const notifications = await new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = event => {
              const db = event.target.result;
              if (!db.objectStoreNames.contains(STORE_NAME)) event.target.transaction.abort();
            };
            request.onsuccess = () => {
              const db = request.result;
              if (!db.objectStoreNames.contains(STORE_NAME)) { db.close(); resolve([]); return; }
              const read = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
              read.onsuccess = () => { db.close(); resolve(read.result || []); };
              read.onerror = () => { db.close(); reject(read.error || new Error('Could not read notifications.')); };
            };
            request.onerror = () => reject(request.error || new Error('Could not open notification cache.'));
          });
          const seen = new Set();
          const marks = [];
          for (const notification of notifications) {
            const system = Number(notification && notification.destination_system);
            if (!Number.isSafeInteger(system) || system < 1) continue;
            const type = notificationType(notification);
            const key = system + ':' + type;
            if (seen.has(key)) continue;
            seen.add(key);
            marks.push({ system, type });
          }
          return marks;
        }
        async function loadMarksForVisibleMap() {
          if (marksLoadPromise) return marksLoadPromise;
          marksLoadPromise = readNotificationMarks().then(marks => {
            targetMarks = marks;
            marksLoaded = true;
            marksLoadPromise = null;
            redraw();
            return marks;
          }).catch(error => {
            marksLoadPromise = null;
            return [];
          });
          return marksLoadPromise;
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
        function mapIsVisible() {
          const body = document.getElementById('galaxy-map-body');
          return !!body && !body.classList.contains('hidden');
        }
        function observeMapVisibility() {
          const systemsScreen = document.getElementById('screen-systems');
          const systemsVisible = !!systemsScreen && !systemsScreen.classList.contains('hidden');
          const visible = mapIsVisible();
          // Leaving and returning to the Galaxy tab is a reload trigger even
          // when the map itself remained expanded in the background.
          if (systemsVisible && !systemsScreenWasVisible) {
            marksLoaded = false;
            loadMarksForVisibleMap();
          } else if (visible && !mapWasVisible) {
            marksLoaded = false;
            loadMarksForVisibleMap();
          }
          systemsScreenWasVisible = systemsVisible;
          mapWasVisible = visible;
        }
        function drawTargetSystems() {
          let points;
          try { points = state.galaxyMapPoints; } catch (_) { return; }
          const canvas = document.getElementById('galaxy-map-canvas');
          if (!canvas || !Array.isArray(points)) return;
          const overlay = getTargetOverlay(canvas);
          if (!overlay) return;
          const ctx = overlay.getContext('2d');
          ctx.clearRect(0, 0, overlay.width, overlay.height);
          if (!marksLoaded) return;
          const selected = readSelectedTypes();
          const markedSystems = new Set(targetMarks.filter(mark => selected.has(mark.type)).map(mark => Number(mark.system)));
          if (markedSystems.size === 0) return;
          const color = getComputedStyle(document.documentElement).getPropertyValue('--fa-target-system-color').trim() || '#b7ff00';
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
        function redraw() {
          if (typeof window.drawGalaxyMap === 'function') window.drawGalaxyMap();
          drawTargetSystems();
        }
        function install() {
          const original = window.drawGalaxyMap;
          if (typeof original !== 'function') return false;
          if (original.__faTargetSystemsWrapped) return true;
          function wrappedDrawGalaxyMap() {
            const result = original.apply(this, arguments);
            observeMapVisibility();
            drawTargetSystems();
            return result;
          }
          wrappedDrawGalaxyMap.__faTargetSystemsWrapped = true;
          window.drawGalaxyMap = wrappedDrawGalaxyMap;
          observeMapVisibility();
          drawTargetSystems();
          return true;
        }
        function tryInstall() {
          if (install()) return;
          window.setTimeout(tryInstall, 250);
        }
        window.addEventListener(EVENT_NAME, redraw);
        const visibilityObserver = new MutationObserver(observeMapVisibility);
        visibilityObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        tryInstall();
      })();
    `;
    (document.head || document.documentElement).appendChild(pageScript);
    pageScript.remove();
  }

  let timer = null;
  function update() {
    timer = null;
    ensureMapControls();
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

  function startDomFeatures() {
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
    injectMapHook();
    update();
  }

  if (document.body) startDomFeatures();
  else document.addEventListener('DOMContentLoaded', startDomFeatures, { once: true });
})();
