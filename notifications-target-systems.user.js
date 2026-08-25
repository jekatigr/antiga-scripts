// ==UserScript==
// @name         Fonte Antiga - Notification Target Systems
// @namespace    fa.notifications-target-systems
// @version      1.6.3
// @description  Cache notifications locally and mark their target systems on the galaxy map
// @match        *://antiga.hatedabamboo.me/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const TYPES_STORAGE_KEY = 'fa.target-system-types';
  const MAP_CHANGED_EVENT = 'fa-target-system-markers-changed';
  const MARKS_CACHE_KEY = 'fa.target-system-marks-cache-v2';
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
    { key: 'expedition', label: 'Expedition' },
    { key: 'occupied', label: 'Occupied' },
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
    const SERVICE_VERSION = 2;
    if (window[SERVICE_KEY]) {
      if (window[SERVICE_KEY].version !== SERVICE_VERSION) {
        window.alert(`Fonte Antiga notification scripts are incompatible. Update all notification scripts to version ${SERVICE_VERSION}.`);
      }
      return;
    }
    const DB_NAME = 'fa.notifications';
    const DB_VERSION = 1;
    const STORE = 'notifications';
    const META = 'metadata';
    const META_KEY = 'sync';
    const PAGE_SIZE = 10;
    const PAGE_DELAY = 2000;
    const PAGE_TIMEOUT = 30000;
    const UPDATE_EVENT = 'fa-notifications-updated';
    const SYNC_STATE_EVENT = 'fa-notifications-sync-state';
    const CHANNEL = 'fa.notifications';
    let dbPromise = null;
    let syncPromise = null;
    let syncTimer = null;
    let syncPending = false;
    let lastUnread = null;
    let syncState = { state: 'idle', offset: 0, total: 0, cached: 0, error: '' };
    let announceTimer = null;
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
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('Could not open notification cache (timed out; another tab may be blocking IndexedDB).'));
        }, 15000);
        request.onblocked = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(new Error('Could not open notification cache (blocked by another tab).'));
        };
        request.onsuccess = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(request.result);
        };
        request.onerror = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
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
      // Multiple interception layers can observe the same API response in
      // the same turn. Coalesce those notifications so consumers rebuild
      // their indexes at most once per task.
      if (announceTimer) return;
      announceTimer = setTimeout(() => {
        announceTimer = null;
        window.dispatchEvent(new Event(UPDATE_EVENT));
        try { channel?.postMessage({ type: UPDATE_EVENT }); } catch (_) {}
      }, 0);
    }
    function setSyncState(stateName, changes = {}) {
      syncState = { ...syncState, ...changes, state: stateName };
      const detail = { ...syncState };
      window.dispatchEvent(new CustomEvent(SYNC_STATE_EVENT, { detail }));
      try { channel?.postMessage({ type: SYNC_STATE_EVENT, detail }); } catch (_) {}
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
          const installDelays = [100, 250, 500, 1000, 2000, 4000, 8000];
          function tryInstall(attempt = 0) {
            const ready = installFetch() && installXhr();
            if (ready || attempt >= installDelays.length) return;
            window.setTimeout(() => tryInstall(attempt + 1), installDelays[attempt]);
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
    async function upsert(notifications, changes = {}, announceUpdate = true) {
      if (!notifications.length) return null;
      const db = await openDb();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        notifications.forEach(notification => tx.objectStore(STORE).put(notification));
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error || new Error('Could not save notifications.'));
        tx.onabort = () => reject(tx.error || new Error('Could not save notifications.'));
      });
      // count() reflects the actual object-store size, so duplicate IDs do
      // not inflate the cached count. This is intentionally authoritative for
      // network upserts and force sync pages, where an item may already exist.
      const cached = await result(db.transaction(STORE, 'readonly').objectStore(STORE).count());
      await saveMeta(db, { ...changes, cached, updatedAt: new Date().toISOString() });
      if (announceUpdate) announce();
      return { cached };
    }
    async function page(offset) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null;
      const timeout = setTimeout(() => controller?.abort(), PAGE_TIMEOUT);
      try {
        const response = await fetch(`/api/notifications?limit=${PAGE_SIZE}&offset=${offset}`, {
          credentials: 'same-origin', headers: { Accept: 'application/json' },
          ...(controller ? { signal: controller.signal } : {}),
        });
        if (!response.ok) throw new Error(`Notification request failed (HTTP ${response.status}).`);
        const body = await response.json();
        if (!body || !Array.isArray(body.items)) throw new Error('Notification response has an unknown shape.');
        return { notifications: items(body), itemCount: body.items.length, total: Number(body.total) || body.items.length };
      } catch (error) {
        if (controller?.signal.aborted) {
          throw new Error(`Notification request timed out after ${PAGE_TIMEOUT / 1000}s (offset ${offset}).`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }
    async function sync(force = false) {
      if (syncPromise) return syncPromise;
      const runSync = async () => {
        const db = await openDb();
        const previous = await meta(db);
        const keys = new Set((await result(db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys())).map(String));
        let downloaded = 0;
        let cachedCount = keys.size;
        setSyncState('syncing', { offset: 0, total: force ? keys.size : 0, cached: force ? 0 : cachedCount, force, error: '' });
        // A completed sync can stop at the first cached item. An interrupted
        // sync must first reach the last notification committed by its prior
        // run; cached items before that checkpoint do not prove that there is
        // no gap after it.
        const full = force || !previous || previous.status !== 'complete';
        const resumeId = !force && full && previous && previous.status === 'syncing' && previous.lastDownloadedId != null
          ? String(previous.lastDownloadedId) : null;
        let checkpointReached = !resumeId;
        let offset = 0;
        let current = await page(0);
        const syncTotal = force ? Math.max(keys.size, current.total) : current.total;
        setSyncState('syncing', { offset: 0, total: syncTotal, cached: force ? 0 : keys.size });
        await saveMeta(db, { status: 'syncing', total: syncTotal, nextOffset: 0 });
        while (current.itemCount > 0) {
          const notifications = current.notifications;
          const checkpointIndex = !checkpointReached && resumeId
            ? notifications.findIndex(notification => String(notification.id) === resumeId) : -1;
          if (checkpointIndex >= 0) checkpointReached = true;

          // Before the checkpoint, cached records are ignored as stop signals.
          // Once the checkpoint has been reached, or for a completed sync, the
          // first cached record is the safe boundary for this page.
          let boundaryIndex = -1;
          if (!force && (!full || (resumeId && checkpointReached))) {
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
          // Force mode deliberately writes every notification returned by every
          // page, including records already present in IndexedDB. It never
          // uses the cached-record boundary used by the normal sync.
          const saved = await upsert(
            force ? notifications : fresh,
            { status: 'syncing', total: syncTotal, nextOffset: offset, ...checkpoint },
            false,
          );
          offset += current.itemCount;
          if (force) {
            downloaded += notifications.length;
            // The authoritative count from upsert() includes duplicate IDs.
            // Never derive the store size from the number of downloaded rows.
            if (saved) cachedCount = saved.cached;
          } else {
            // `fresh` is filtered against `keys`, so this increments only for
            // IDs not already present, including partially cached pages.
            cachedCount += fresh.length;
          }
          const overallDownloaded = cachedCount;
          await saveMeta(db, {
            status: 'syncing', total: syncTotal, cached: overallDownloaded, nextOffset: offset, ...checkpoint,
          });
          setSyncState('syncing', {
            offset,
            total: syncTotal,
            cached: force ? downloaded : overallDownloaded,
          });
          // Force mode cannot rely on a possibly stale/missing total. Keep
          // paging while the API returns full pages and stop only on a short
          // page (the final page). Normal sync retains its total/boundary stop.
          if (boundaryIndex >= 0 || (!force && offset >= current.total) || (force && current.itemCount < PAGE_SIZE)) break;
          await new Promise(resolve => setTimeout(resolve, PAGE_DELAY));
          current = await page(offset);
        }
        // `cachedCount` is exact: incremental sync adds only fresh IDs, while
        // force sync receives the authoritative object-store count from upsert.
        await saveMeta(db, { status: 'complete', total: syncTotal, cached: cachedCount, nextOffset: offset, updatedAt: new Date().toISOString() });
        setSyncState('complete', { offset, total: syncTotal, cached: cachedCount, force: false, error: '' });
        announce();
        return true;
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
      syncPromise = execute()
        .then(result => {
          if (result === undefined) setSyncState('idle');
          return result;
        })
        .catch(error => {
          const message = error?.message || 'Notification sync failed.';
          setSyncState('error', { error: message, errorAt: new Date().toISOString() });
          // Do not leave a transient network failure looking permanently stuck.
          // The persisted syncing checkpoint lets the next attempt resume safely.
          if (!syncPending && !syncTimer) {
            syncTimer = setTimeout(() => {
              syncTimer = null;
              sync().catch(() => {});
            }, 10000);
          }
          return false;
        })
        .finally(() => {
          syncPromise = null;
        });
      return syncPromise;
    }
    async function forceSync() {
      if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = null;
      }
      syncPending = false;
      if (syncPromise) await syncPromise;
      return sync(true);
    }
    function scheduleSync(delay = 2000) {
      if (syncPromise) {
        syncPending = true;
        return;
      }
      if (syncTimer) return;
      setSyncState('scheduled', { error: '' });
      syncTimer = setTimeout(() => {
        syncTimer = null;
        sync().finally(() => {
          if (syncPending) {
            syncPending = false;
            scheduleSync(2000);
          }
        });
      }, delay);
    }
    async function poll(body) {
      const unread = Number(body && body.notifications_unread);
      if (!Number.isFinite(unread)) return;
      const db = await openDb();
      const saved = await meta(db);
      const old = lastUnread == null ? Number(saved && saved.unreadCount) : lastUnread;
      lastUnread = unread;
      await saveMeta(db, { unreadCount: unread });
      if (Number.isFinite(old) && unread > old) scheduleSync(2000);
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
    // Start a delayed, serialized backfill so the game's initial rendering and
    // requests get priority. Later unread increases schedule a short sync.
    window[SERVICE_KEY] = { version: SERVICE_VERSION, sync, forceSync, getSyncState: () => ({ ...syncState }) };
    scheduleSync(2000);
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
      // Replacing the SVG on every body mutation feeds the observer that
      // calls this function. Keep the existing icon unless the control was
      // actually rebuilt.
      if (!summary.querySelector('svg')) summary.innerHTML = FILTER_ICON_HTML;
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
        const TYPES = new Set(${JSON.stringify(['exploration', 'expedition', 'occupied', 'attack', 'transport', 'harvest', 'trade', 'other'])});
        const EVENT_NAME = 'fa-target-system-markers-changed';
        const RADII = { small: 2.6, mid: 3.4, large: 4.4 };
        let targetMarks = [];
        let marksByType = new Map();
        let marksLoaded = false;
        let marksLoadPromise = null;
        let redrawFrame = null;
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
          if (notificationType === 'expedition_lost') return null;
          if (notificationType === 'expedition_returned' || (missionType === 'expedition' && notificationType !== 'expedition_lost')) return 'expedition';
          if (notificationType === 'exploration' || missionType === 'explore') return 'exploration';
          if (notificationType.includes('attack') || notificationType.includes('battle') || notificationType === 'planet_scanned' || missionType === 'attack') return 'attack';
          if (notificationType.includes('harvest') || missionType === 'harvest') return 'harvest';
          if (notificationType.includes('trade') || missionType === 'trade') return 'trade';
          if (notificationType.includes('transport') || missionType === 'transport') return 'transport';
          return 'other';
        }
        async function readNotificationSignature() {
          if (!window.indexedDB) return null;
          return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = event => {
              const db = event.target.result;
              if (!db.objectStoreNames.contains(STORE_NAME)) event.target.transaction.abort();
            };
            request.onsuccess = () => {
              const db = request.result;
              if (!db.objectStoreNames.contains(STORE_NAME)) { db.close(); resolve(null); return; }
              const store = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME);
              const countRequest = store.count();
              const newestRequest = store.indexNames.contains('created_at')
                ? store.index('created_at').openCursor(null, 'prev') : null;
              let count;
              let newest;
              let countReady = false, newestReady = !newestRequest;
              countRequest.onsuccess = () => { count = countRequest.result; countReady = true; maybeResolve(); };
              if (newestRequest) {
                newestRequest.onsuccess = () => { newest = newestRequest.result?.value; newestReady = true; maybeResolve(); };
                newestRequest.onerror = () => finish(newestRequest.error);
              }
              function maybeResolve() { if (countReady && newestReady) finish(); }
              function finish(error) { db.close(); if (error) reject(error); else resolve(String(count) + ':' + String(newest?.id ?? '') + ':' + String(newest?.created_at ?? '')); }
            };
            request.onerror = () => reject(request.error || new Error('Could not open notification cache.'));
          });
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
            if (!type) continue;
            const types = [type];
            const occupied = notification && (
              notification.exploration?.is_occupied === true
              || notification.notification_type === 'exploration_lost'
              || notification.notification_type === 'planet_scanned'
              || notification.notification_type === 'attack_incoming'
              || notification.notification_type === 'battle_report'
            );
            if (occupied) types.push('occupied');
            for (const markType of types) {
              const key = system + ':' + markType;
              if (seen.has(key)) continue;
              seen.add(key);
              marks.push({ system, type: markType });
            }
          }
          return marks;
        }
        async function loadMarksForVisibleMap() {
          if (marksLoadPromise) return marksLoadPromise;
          marksLoadPromise = (async () => {
            const signature = await readNotificationSignature();
            let cached = null;
            try { cached = JSON.parse(localStorage.getItem('${MARKS_CACHE_KEY}') || 'null'); } catch (_) {}
            const marks = cached && cached.signature === signature
              ? cached.marks
              : await readNotificationMarks();
            if (!cached || cached.signature !== signature) {
              try { localStorage.setItem('${MARKS_CACHE_KEY}', JSON.stringify({ signature, marks })); } catch (_) {}
            }
            targetMarks = Array.isArray(marks) ? marks : [];
            marksByType = new Map();
            for (const mark of targetMarks) {
              if (!marksByType.has(mark.type)) marksByType.set(mark.type, new Set());
              marksByType.get(mark.type).add(Number(mark.system));
            }
            marksLoaded = true;
            scheduleRedraw();
            return targetMarks;
          })().catch(() => {
            marksLoaded = true;
            targetMarks = [];
            return [];
          }).finally(() => { marksLoadPromise = null; });
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
          const markedSystems = new Set();
          for (const type of selected) {
            const systems = marksByType.get(type);
            if (!systems) continue;
            systems.forEach(system => markedSystems.add(system));
          }
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
          // The base map is already painted by the game (or by the
          // full-width companion). Repaint only our overlay to avoid a second
          // expensive canvas render for every filter/resize event.
          drawTargetSystems();
        }
        function scheduleRedraw() {
          if (redrawFrame !== null) return;
          redrawFrame = requestAnimationFrame(() => {
            redrawFrame = null;
            redraw();
          });
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
        const installDelays = [250, 250, 500, 1000, 2000, 4000, 8000];
        function tryInstall(attempt = 0) {
          if (install() || attempt >= installDelays.length) return;
          window.setTimeout(() => tryInstall(attempt + 1), installDelays[attempt]);
        }
        window.addEventListener(EVENT_NAME, scheduleRedraw);
        window.addEventListener('fa-notifications-updated', () => {
          marksLoaded = false;
          if (mapIsVisible()) loadMarksForVisibleMap();
        });
        if (typeof BroadcastChannel !== 'undefined') {
          try {
            const channel = new BroadcastChannel('fa.notifications');
            channel.addEventListener('message', event => {
              if (event.data?.type === 'fa-notifications-updated') {
                marksLoaded = false;
                if (mapIsVisible()) loadMarksForVisibleMap();
              }
            });
          } catch (_) {}
        }
        const visibilityObserver = new MutationObserver(observeMapVisibility);
        const visibilityRoot = document.getElementById('screen-systems') || document.documentElement;
        visibilityObserver.observe(visibilityRoot, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
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

  function mutationTouchesTargetUi(records) {
    return records.some(record => {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (target?.closest('#screen-systems, #panel-notifications')) return true;
      if (record.type !== 'childList') return false;
      return Array.from(record.addedNodes).some(node =>
        node.nodeType === 1 && (
          node.matches('#screen-systems, #panel-notifications') ||
          node.querySelector('#screen-systems, #panel-notifications')
        )
      );
    });
  }

  function schedule(records) {
    if (!mutationTouchesTargetUi(records)) return;
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
