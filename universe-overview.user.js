// ==UserScript==
// @name         Fonte Antiga - Universe Overview
// @namespace    fa.universe-overview
// @version      2.52.0
// @description  Locally summarize colonies with overview, building, ship, and defense inventory tabs
// @match        *://antiga.hatedabamboo.me/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const DB_NAME = 'fa.planets-summary';
  const DB_VERSION = 2;
  const PLANET_STORE = 'planets';
  const METADATA_STORE = 'metadata';
  const NOTIFICATION_DB_NAME = 'fa.notifications';
  const NOTIFICATION_STORE = 'notifications';
  const NOTIFICATION_SYNC_STATE_EVENT = 'fa-notifications-sync-state';
  // req() expects application paths and adds /api itself.
  const REFRESH_ENDPOINTS = [
    id => `/planets/${id}`,
    id => `/planets/${id}/resources`,
    id => `/planets/${id}/buildings`,
    id => `/planets/${id}/build-queue`,
    id => `/planets/${id}/research-queue`,
    id => `/planets/${id}/ship-queue`,
    id => `/planets/${id}/defense-queue`,
    id => `/planets/${id}/defenses`,
    id => `/planets/${id}/ships`,
  ];
  const REFRESH_ENDPOINT_DELAY = 100;
  const REFRESH_PLANET_DELAY = 500;
  const CATEGORY_BY_SUFFIX = {
    '': 'base',
    '/resources': 'resources',
    '/buildings': 'buildings',
    '/build-queue': 'buildQueue',
    '/research-queue': 'researchQueue',
    '/ship-queue': 'shipQueue',
    '/defense-queue': 'defenseQueue',
    '/defenses': 'defenses',
    '/ships': 'ships',
  };
  const NOTIFICATION_LABELS = [
    ['exploration', 'Exploration'],
    ['scan', 'Scans'],
    ['attack', 'Attacks'],
    ['battle', 'Battles'],
    ['transport', 'Transport'],
    ['harvest', 'Harvest'],
    ['relocation', 'Relocation'],
    ['recovery', 'Recovery'],
    ['trade', 'Trade'],
  ];

  const state = {
    db: null,
    records: new Map(),
    recordsNeedCanonicalize: false,
    notificationIndex: new Map(),
    notificationByPlanetId: new Map(),
    notificationByLocation: new Map(),
    notificationsLoaded: false,
    notificationSync: null,
    panel: null,
    expanded: new Set(),
    search: '',
    view: 'owned',
    ownedSubview: 'overview',
    page: 0,
    pageSize: 20,
    sort: 'name',
    sortDirection: 1,
    sortActivated: false,
    statusFilters: new Set(),
    featureFilters: new Set(),
    openFilterColumn: null,
    filterOutsideListenerInstalled: false,
    refreshing: new Set(),
    refreshingAll: false,
    refreshProgress: { completed: 0, total: 0, endpointCompleted: 0, endpointTotal: REFRESH_ENDPOINTS.length, current: '' },
    lastError: '',
    renderTimer: null,
    searchTimer: null,
    renderedView: null,
    persistChain: Promise.resolve(),
    lastOpenedPlanetId: null,
    sidebarSignature: '',
    sidebarSyncTimer: null,
    notificationsLoadPromise: null,
    notificationsLoadQueued: false,
  };

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
    const SYNC_STATE_EVENT = 'fa-notifications-sync-state';
    const CHANNEL = 'fa.notifications';
    let dbPromise = null;
    let syncPromise = null;
    let syncTimer = null;
    let syncPending = false;
    let lastUnread = null;
    let syncState = { state: 'idle', offset: 0, total: 0, cached: 0, error: '' };
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
        setSyncState('syncing', { offset: 0, total: 0, error: '' });
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
        setSyncState('syncing', { offset: 0, total: current.total, cached: keys.size });
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
          setSyncState('syncing', { offset, total: current.total, cached: keys.size });
          if (boundaryIndex >= 0 || offset >= current.total) break;
          await new Promise(resolve => setTimeout(resolve, PAGE_DELAY));
          current = await page(offset);
        }
        await saveMeta(db, { status: 'complete', total: current.total, cached: keys.size, nextOffset: offset, updatedAt: new Date().toISOString() });
        setSyncState('complete', { offset, total: current.total, cached: keys.size, error: '' });
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
          setSyncState('error', { error: error?.message || 'Notification sync failed.' });
        })
        .finally(() => {
          syncPromise = null;
        });
      return syncPromise;
    }
    function scheduleSync(delay = 1500) {
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
            scheduleSync(500);
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
      if (Number.isFinite(old) && unread > old) scheduleSync(500);
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
    window[SERVICE_KEY] = { sync, getSyncState: () => ({ ...syncState }) };
    scheduleSync(1500);
  })();

  const style = document.createElement('style');
  style.textContent = `
    .planet-sidebar-title { display: flex; align-items: center; justify-content: space-between; gap: .5rem; }
    .fa-summary-sidebar-btn { flex: 0 0 auto; margin: 0; padding: .35rem .65rem; white-space: nowrap; }
    .fa-summary-overlay { position: fixed; inset: 0; z-index: 10000; display: flex; justify-content: center; align-items: flex-start; padding: 1vh .5vw; background: rgba(0,0,0,.7); }
    .fa-summary-overlay.hidden { display: none; }
    .fa-summary-dialog { display: flex; flex-direction: column; width: min(99.5vw, 2400px); max-height: 98vh; overflow: hidden; color: var(--fg); background: var(--bg, #0a0d13); border: 1px solid var(--border-soft); box-shadow: 0 1rem 3rem rgba(0,0,0,.5); }

    .fa-summary-header { display: flex; align-items: center; justify-content: space-between; gap: .75rem; padding: .8rem 1rem; border-bottom: 1px solid var(--border-soft); }
    .fa-summary-header h2 { margin: 0; font-size: 1.1rem; }
    .fa-summary-close { min-width: 2rem; }
    .fa-summary-controls { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; padding: .65rem 1rem; background: var(--panel-alt); border-bottom: 1px solid var(--border-soft); }
    .fa-summary-tabs { display: flex; gap: .35rem; width: 100%; padding-bottom: .15rem; }
    .fa-summary-subtabs { padding-top: .05rem; padding-left: 0; }
    .fa-summary-subtabs[hidden] { display: none; }
    .fa-summary-tab { min-width: 8.5rem; border-color: var(--border-soft); background: var(--bg, #0a0d13); color: var(--muted); font-weight: 600; opacity: .65; }
    .fa-summary-tab:hover, .fa-summary-tab:focus-visible { opacity: 1; }
    .fa-summary-tab.active { color: var(--fg); border-color: var(--accent); background: var(--panel); opacity: 1; box-shadow: inset 0 -2px 0 var(--accent); }
    .fa-summary-toolbar { display: flex; align-items: center; gap: .5rem; width: 100%; }
    .fa-summary-update-all { flex: 0 0 auto; white-space: nowrap; }
    .fa-summary-update-all[hidden] { display: none !important; }
    .fa-summary-bulk-controls { display: flex; flex: 0 0 auto; flex-direction: column; align-items: flex-end; gap: .25rem; min-width: 0; margin-left: auto; }
    .fa-summary-progress { display: flex; flex: 0 1 auto; align-items: center; gap: .4rem; width: 18rem; min-width: 12rem; max-width: 100%; }
    .fa-summary-progress[hidden] { display: none !important; }
    .fa-summary-progress-bar { flex: 1 1 auto; width: 8rem; height: .7rem; accent-color: var(--accent); }
    .fa-summary-progress-label { min-width: max-content; color: var(--muted); font-size: .72rem; white-space: nowrap; }
    .fa-summary-filter-head { display: flex; align-items: flex-end; width: 100%; min-width: 0; gap: .3rem; box-sizing: border-box; white-space: normal; }
    .fa-summary-filter-head > span:first-child { flex: 1 1 auto; min-width: 0; overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: normal; word-break: normal; line-height: 1.15; }
    .fa-summary-filter-head .fa-summary-sort-indicator { flex: 0 0 1em; }
    .fa-summary-filter-head > .fa-summary-filter-button { flex: 0 0 1.25rem; }
    .fa-summary-table th.fa-summary-has-filter { padding-right: .5rem; }
    .fa-summary-filter-button { position: static; display: inline-flex !important; align-items: center; justify-content: center; width: 1.25rem; min-width: 1.25rem; height: 1.25rem; margin: 0; padding: .15rem; box-sizing: border-box; transform: none; border: 0; background: transparent; color: var(--muted); cursor: pointer; line-height: 1; }
    .fa-summary-filter-button:hover, .fa-summary-filter-button:focus-visible, .fa-summary-filter-button.fa-summary-filter-active { color: var(--accent); }
    .fa-summary-filter-button svg { display: block !important; width: 100%; height: 100%; fill: currentColor !important; overflow: visible; }
    .fa-summary-filter-menu { position: fixed; top: 0; left: 0; z-index: 100000; display: flex; visibility: hidden; flex-direction: column; gap: .35rem; min-width: 9rem; padding: .55rem .65rem; border: 1px solid var(--border-soft); border-radius: .2rem; background: var(--panel, #10151d); box-shadow: 0 .35rem .8rem rgba(0,0,0,.45); color: var(--fg); font-weight: 400; white-space: nowrap; }
    .fa-summary-filter-menu.fa-summary-filter-positioned { visibility: visible; }
    .fa-summary-filter-menu[hidden] { display: none; }

    .fa-summary-filter-option { display: flex; align-items: center; gap: .35rem; color: var(--fg); font-size: .75rem; }
    .fa-summary-filter-option input { width: .85rem; height: .85rem; margin: 0; accent-color: var(--accent); }
    .fa-summary-search { position: relative; flex: 0 1 22rem; width: 22rem; max-width: 32vw; }
    .fa-summary-search input { width: 100%; min-width: 0; padding-right: 2rem; box-sizing: border-box; }
    .fa-summary-search-clear { position: absolute; top: 50%; right: .25rem; display: block; width: 1.5rem; min-width: 0; height: 1.5rem; margin: 0; padding: 0; transform: translateY(-50%); appearance: none; border: 0 !important; border-radius: .2rem; background: transparent !important; color: var(--muted) !important; font: inherit; font-size: 1rem; line-height: 1.3; cursor: pointer; }
    .fa-summary-search-clear:hover, .fa-summary-search-clear:focus-visible { background: var(--panel-alt) !important; color: var(--fg) !important; }
    .fa-summary-search-clear[hidden] { display: none !important; }
    .fa-summary-sort-indicator { display: inline-block; width: 1em; margin-left: .25rem; color: var(--accent); font-size: .85em; }
    .fa-summary-page { display: inline-flex; align-items: center; gap: .35rem; white-space: nowrap; }
    .fa-summary-page[hidden] { display: none !important; }
    @media (max-width: 900px) {
      .fa-summary-toolbar { flex-wrap: wrap; }
      .fa-summary-search { flex: 1 1 14rem; width: auto; max-width: none; }
      .fa-summary-bulk-controls { flex: 0 0 100%; }
    }

    .fa-summary-page-label { min-width: 6rem; text-align: center; color: var(--muted); font-size: .78rem; }
    .fa-summary-status { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; flex: 1 1 100%; min-height: 1.1em; font-size: .78rem; white-space: pre-line; }
    .fa-summary-status-text { min-width: 0; }
    .fa-summary-status .fa-summary-update-all { flex: 0 0 auto; margin-left: .5rem; }
    .fa-summary-status .fa-summary-progress { flex: 0 1 18rem; width: 18rem; min-width: 12rem; max-width: 100%; margin-left: 0; }
    .fa-summary-sync-state { margin-left: auto; padding: .18rem .45rem; border: 1px solid currentColor; border-radius: .2rem; white-space: nowrap; font-size: .7rem; line-height: 1.1; }
    .fa-summary-sync-idle { color: var(--muted); }
    .fa-summary-sync-scheduled { color: #ffcc66; }
    .fa-summary-sync-syncing { color: var(--accent); }
    .fa-summary-sync-complete { color: #9be37a; }
    .fa-summary-sync-error { color: #ff8d8d; }

    .fa-summary-table-wrap { overflow: auto; container-type: inline-size; }
    .fa-summary-table { width: 100%; min-width: 0; table-layout: fixed; border-collapse: collapse; font-size: .78rem; }
    .fa-summary-table th, .fa-summary-table td { box-sizing: border-box; padding: .45rem .5rem; vertical-align: top; border-bottom: 1px solid var(--border-soft); text-align: left; }
    .fa-summary-table th { overflow: visible; vertical-align: bottom; }
    .fa-summary-table td { overflow: hidden; }
    .fa-summary-table td > div:not(.fa-summary-icon-line):not(.fa-summary-actions-inner):not(.fa-summary-name-content):not(.fa-summary-inventory-queue) { overflow: hidden; text-overflow: ellipsis; }
    .fa-summary-table .fa-summary-sub { overflow: hidden; text-overflow: ellipsis; }
    .fa-summary-table tbody td { position: relative; min-height: 0; }
    .fa-summary-table tbody td > .fa-summary-time { float: none; flex: none; }
    .fa-summary-table thead { position: sticky; top: -1px; z-index: 5; box-shadow: 0 1px 0 var(--border-soft), 0 2px 3px rgba(0,0,0,.2); }
    .fa-summary-table th { color: var(--muted); background: var(--bg, #0a0d13); white-space: nowrap; cursor: default; }
    .fa-summary-table th.fa-summary-inventory-header { white-space: normal; }
    .fa-summary-table th.fa-summary-inventory-header .fa-summary-filter-head { align-items: flex-end; white-space: normal; }
    .fa-summary-table th.fa-summary-inventory-header .fa-summary-filter-head > span:first-child { overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: normal; word-break: normal; }
    .fa-summary-table th.fa-summary-sortable { cursor: pointer; }
    .fa-summary-table tbody tr { background: var(--bg, #0a0d13); }
    .fa-summary-table tbody tr:hover { background: var(--panel-alt) !important; }
    .fa-summary-table tbody tr:hover > td { background: transparent !important; }
    .fa-summary-table th.fa-summary-planet-sticky { position: sticky; left: 0; z-index: 7; background: var(--bg, #0a0d13); box-shadow: 1px 0 0 var(--border-soft); }
    .fa-summary-table td.fa-summary-planet-sticky { position: sticky; left: 0; z-index: 2; background: var(--bg, #0a0d13); box-shadow: 1px 0 0 var(--border-soft); }
    .fa-summary-table tbody tr:hover > td.fa-summary-planet-sticky,
    .fa-summary-table tbody tr.fa-summary-row-expanded > td.fa-summary-planet-sticky { background: var(--panel-alt) !important; }
    .fa-summary-table tbody tr.fa-summary-data-row { cursor: pointer; }
    .fa-summary-table tbody tr.fa-summary-data-row.fa-summary-nonexpandable { cursor: default; }
    .fa-summary-table tbody tr.fa-summary-data-row.fa-summary-row-expanded { background: var(--panel-alt); }
    .fa-summary-table .fa-summary-name { font-weight: 600; white-space: nowrap; }
    .fa-summary-name-content { display: flex; align-items: center; gap: .4rem; min-width: 0; }
    .fa-summary-name-content > .fa-summary-name { flex: 1 1 auto; min-width: 0; overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
    .fa-summary-name-content > .fa-summary-actions-inner { flex: 0 0 auto; width: auto; margin-left: auto; justify-content: flex-start; }
    .fa-summary-name-content .fa-summary-actions-inner button { flex: 0 0 1.8rem !important; width: 1.8rem !important; min-width: 1.8rem !important; max-width: 1.8rem !important; box-sizing: border-box; }
    .fa-summary-number { width: 2.5rem; color: var(--muted); text-align: right !important; }
    .fa-summary-time { position: absolute !important; inset-inline-start: auto; inset-inline-end: .25rem; inset-block-end: .15rem; z-index: 0; display: block; width: max-content; max-width: calc(100% - .5rem); margin: 0; padding: .04rem .2rem; border: 1px solid var(--border-soft); border-radius: .15rem; background: var(--panel-alt) !important; color: var(--fg-dim, #8993a8) !important; font-size: .6rem; line-height: 1; white-space: nowrap; pointer-events: none; opacity: .9; contain: layout paint; }
    .fa-summary-time.fa-summary-time-stale { background: var(--fg) !important; border-color: var(--fg); color: var(--bg, #0a0d13) !important; opacity: 1; }
    .fa-summary-sub { display: block; margin-top: .15rem; color: var(--muted); font-size: .72rem; white-space: nowrap; }
    .fa-summary-inventory-queue { display: inline-block; max-width: 100%; margin-top: .15rem; padding: .08rem .22rem; box-sizing: border-box; overflow: visible !important; text-overflow: clip !important; border: 1px solid var(--border-soft); border-radius: .2rem; background: var(--panel-alt); color: var(--fg); font-size: .62rem; line-height: 1.1; white-space: normal; overflow-wrap: normal; word-break: normal; }
    .fa-summary-stale { color: var(--muted); }
    .fa-summary-warn { color: #ffcc66; }
    .fa-summary-good { color: #9be37a; }
    .fa-summary-bad { color: #ff8d8d; }
    .fa-summary-na, .fa-summary-na *, .fa-summary-empty { color: var(--fg-dim, #8993a8) !important; }
    .fa-summary-na:not(td), .fa-summary-na:not(td) *, .fa-summary-empty:not(td) { opacity: .42; }
    .fa-summary-status-value { color: var(--fg) !important; opacity: 1 !important; }
    .fa-summary-table tbody tr > td.fa-summary-na, .fa-summary-table tbody tr > td.fa-summary-empty,
    .fa-summary-table tbody tr > td:has(> .fa-summary-na), .fa-summary-table tbody tr > td:has(> .fa-summary-empty) { background: var(--bg, #0a0d13) !important; opacity: 1; }
    .fa-summary-table tbody tr:hover > td.fa-summary-na, .fa-summary-table tbody tr:hover > td.fa-summary-empty,
    .fa-summary-table tbody tr:hover > td:has(> .fa-summary-na), .fa-summary-table tbody tr:hover > td:has(> .fa-summary-empty),
    .fa-summary-table tbody tr.fa-summary-row-expanded > td.fa-summary-na, .fa-summary-table tbody tr.fa-summary-row-expanded > td.fa-summary-empty,
    .fa-summary-table tbody tr.fa-summary-row-expanded > td:has(> .fa-summary-na), .fa-summary-table tbody tr.fa-summary-row-expanded > td:has(> .fa-summary-empty) { background: transparent !important; opacity: 1; }
    .fa-summary-table tbody tr.fa-summary-row-current > td { background: rgba(var(--accent-rgb), .12) !important; }
    .fa-summary-table tbody tr.fa-summary-row-current > td.fa-summary-planet-sticky { background: rgba(var(--accent-rgb), .12) !important; box-shadow: inset 3px 0 0 var(--accent), 1px 0 0 var(--border-soft); }
    .fa-summary-table tbody tr.fa-summary-row-current:hover > td { background: var(--panel-alt) !important; }
    .fa-summary-table tbody tr.fa-summary-row-current:hover > td.fa-summary-planet-sticky { background: var(--panel-alt) !important; }
    .fa-summary-table tbody tr.fa-summary-row-current:hover > td.fa-summary-na,
    .fa-summary-table tbody tr.fa-summary-row-current:hover > td.fa-summary-empty,
    .fa-summary-table tbody tr.fa-summary-row-current:hover > td:has(> .fa-summary-na),
    .fa-summary-table tbody tr.fa-summary-row-current:hover > td:has(> .fa-summary-empty) { background: var(--panel-alt) !important; opacity: 1; }
    .fa-summary-galaxy { color: var(--muted) !important; opacity: .25; }
    .fa-summary-queue-values { display: flex; flex-wrap: nowrap; gap: .2rem .3rem; min-width: 0; color: var(--fg); }
    .fa-summary-table td > .fa-summary-queue-values { overflow: visible !important; text-overflow: clip !important; }
    @media (max-width: 900px) {
      .fa-summary-queue-cell > .fa-summary-queue-values { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; box-sizing: border-box; gap: .2rem .25rem; }
    }
    @container (max-width: 900px) {
      .fa-summary-queue-cell > .fa-summary-queue-values { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); width: 100%; box-sizing: border-box; gap: .2rem .25rem; }
    }
    .fa-summary-queue-item { white-space: nowrap; }
    .fa-summary-queue-item.fa-summary-zero { color: var(--muted) !important; opacity: .2; }
    .fa-summary-actions-inner { display: flex; align-items: center; gap: .25rem; width: 100%; }
    .fa-summary-actions-inner button { display: inline-flex; flex: 1 1 0; align-items: center; justify-content: center; min-width: 0; height: 1.8rem; margin: 0; padding: 0; appearance: none; line-height: 1; }
    .fa-summary-action-glyph { display: block; font-size: 1rem; line-height: 1; pointer-events: none; }
    .fa-summary-icon-line { display: flex; align-items: center; min-width: 0; min-height: 1.25em; }
    .fa-summary-survivors { display: inline-flex; align-items: center; gap: .2rem; white-space: nowrap; }
    .fa-summary-survivors-separator { color: var(--fg-dim, #8993a8); opacity: .45; }
    .fa-summary-capacity-value { display: inline-flex; flex: 0 0 auto; align-items: baseline; min-width: max-content; white-space: nowrap; }
    .fa-summary-capacity-part { white-space: nowrap; }
    .fa-summary-capacity-provided { margin-left: .25em; }
    .fa-summary-inline-icon { display: inline-flex; flex: 0 0 1.15em; align-items: center; justify-content: center; width: 1.15em; height: 1.15em; margin-right: .3em; color: currentColor; }
    .fa-summary-inline-icon svg { display: block; width: 100%; height: 100%; }
    .fa-summary-feature-line { display: inline-flex; align-items: center; min-height: 1.35em; margin-right: .3rem; }
    .fa-summary-feature-line .fa-summary-inline-icon { width: 1.35em; height: 1.35em; margin-right: 0; }
    .fa-summary-feature-relic { color: var(--gold, #d6ad55); }
    .fa-summary-feature-stellar { color: var(--fg-dim, var(--muted)); }
    .fa-summary-over { color: #ff8d8d !important; }
    .fa-summary-under { color: #ffcc66 !important; }
    .fa-summary-full { color: #ff8d8d !important; }
    .fa-summary-detail-row td { padding: .75rem; background: var(--panel-alt); }
    .fa-summary-detail { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: .7rem; }
    .fa-summary-detail section { min-width: 0; }
    .fa-summary-detail h4 { margin: 0 0 .3rem; color: var(--muted); font-size: .75rem; text-transform: uppercase; }
    .fa-summary-detail ul { margin: 0; padding-left: 1.1rem; }
    .fa-summary-detail pre { max-height: 14rem; overflow: auto; margin: 0; font-size: .68rem; white-space: pre-wrap; word-break: break-word; }
    .fa-summary-pill { display: inline-block; margin: 0 .2rem .2rem 0; padding: .12rem .35rem; border: 1px solid var(--border-soft); border-radius: .25rem; }
    .fa-summary-muted { color: var(--muted); }
  `;
  function installStyle() {
    if (!document.head || document.head.contains(style)) return;
    document.head.appendChild(style);
  }
  if (document.head) installStyle();
  else document.addEventListener('DOMContentLoaded', installStyle, { once: true });

  function now() { return Date.now(); }
  function number(value) { return typeof value === 'number' && Number.isFinite(value) ? value : Number(value) || 0; }
  function lastOpenedOwnedPlanetId() {
    const activePill = document.querySelector('#sidebar-planets .sidebar-planet-pill.active[data-planet-id]');
    const activeId = Number(activePill?.dataset.planetId);
    if (Number.isSafeInteger(activeId) && activeId > 0) {
      state.lastOpenedPlanetId = activeId;
      return activeId;
    }
    let savedId = null;
    try {
      const saved = localStorage.getItem('galaxygame_planet');
      savedId = saved == null ? null : Number(saved);
    } catch (_) {}
    state.lastOpenedPlanetId = Number.isSafeInteger(savedId) && savedId > 0 ? savedId : null;
    return state.lastOpenedPlanetId;
  }
  function fmt(value) { return number(value).toLocaleString(); }
  function fmtMaybe(value, known = true) { return value == null || value === '' ? (known ? '—' : '?') : fmt(value); }
  function escapeText(value) { return value == null || value === '' ? '—' : String(value); }
  function unknownOrDash(known, value = '—') { return known ? value : '?'; }
  function age(timestamp) {
    if (!timestamp) return '—';
    const seconds = Math.max(0, Math.floor((now() - new Date(timestamp).getTime()) / 1000));
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
  }
  function ageShort(timestamp) {
    const value = age(timestamp);
    if (value === 'just now') return 'now';
    return value.endsWith(' ago') ? value.slice(0, -4) : value;
  }
  function elapsedDetailed(timestamp) {
    if (!timestamp) return '—';
    const seconds = Math.max(0, Math.floor((now() - new Date(timestamp).getTime()) / 1000));
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes || !parts.length) parts.push(`${minutes}m`);
    return `${parts.join(' ')} ago`;
  }
  function cell(primary, secondary, className = '', observedAt, timestampTitle, staleAllowed = true) {
    const td = document.createElement('td');
    const main = document.createElement('div'); main.className = className; if (primary === '—') main.classList.add('fa-summary-na'); main.textContent = escapeText(primary); td.appendChild(main);
    if (secondary) { const sub = document.createElement('span'); sub.className = `fa-summary-sub ${className}`; sub.textContent = secondary; td.appendChild(sub); }
    appendTimestamp(td, observedAt, timestampTitle, staleAllowed);
    return td;
  }
  function coordinateCell(location) {
    const td = document.createElement('td');
    const main = document.createElement('div');
    main.textContent = String(location || '—');
    td.appendChild(main);
    return td;
  }
  const SUMMARY_ICONS = {
    metal: '<svg viewBox="0 0 200 200" fill="none" stroke="currentColor" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"><polygon points="35,175 165,175 145,100 55,100"/><polygon points="55,100 145,100 170,70 80,70"/><polygon points="145,100 170,70 190,140 165,175"/><path d="M75,138 L78,145 L85,148 L78,151 L75,158 L72,151 L65,148 L72,145 Z" fill="currentColor" stroke="none"/></svg>',
    silicon: '<svg viewBox="0 0 200 200" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"><polygon points="100,28 152,62 165,105 138,168 100,182 62,168 35,105 48,62"/><line x1="100" y1="28" x2="100" y2="182"/><line x1="35" y1="105" x2="165" y2="105"/><line x1="48" y1="62" x2="100" y2="105"/><line x1="152" y1="62" x2="100" y2="105"/></svg>',
    helium: '<svg viewBox="0 0 200 200" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="100" cy="100" rx="85" ry="34" transform="rotate(35 100 100)"/><ellipse cx="100" cy="100" rx="85" ry="34" transform="rotate(-35 100 100)"/><circle cx="100" cy="100" r="18" fill="currentColor" stroke="none"/><circle cx="177" cy="122" r="9" fill="currentColor" stroke="none"/><circle cx="23" cy="78" r="9" fill="currentColor" stroke="none"/></svg>',
    person: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7.5 2a2 2 0 0 1 2 2a2 2 0 0 1-2 2a2 2 0 0 1-2-2a2 2 0 0 1 2-2M6 7h3a2 2 0 0 1 2 2v5.5H9.5V22h-4v-7.5H4V9a2 2 0 0 1 2-2m10.5-5a2 2 0 0 1 2 2a2 2 0 0 1-2 2a2 2 0 0 1-2-2a2 2 0 0 1 2-2M15 22v-6h-3l2.59-7.59C14.84 7.59 15.6 7 16.5 7s1.66.59 1.91 1.41L21 16h-3v6z"/></svg>',
    automaton: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 11V8c0-1.1-.9-2-2-2h-6V4.61c.3-.27.5-.67.5-1.11c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5c0 .44.2.84.5 1.11V6H5c-1.1 0-2 .9-2 2v3c-.55 0-1 .45-1 1v4c0 .55.45 1 1 1v3c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-3c.55 0 1-.45 1-1v-4c0-.55-.45-1-1-1M7 12c0-1.1.67-2 1.5-2s1.5.9 1.5 2s-.67 2-1.5 2S7 13.1 7 12m9 6H8v-2h8zm-.5-4c-.83 0-1.5-.9-1.5-2s.67-2 1.5-2s1.5.9 1.5 2s-.67 2-1.5 2"/></svg>',
    energy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path d="m6.194 11.397l5.998-8.085c.47-.632 1.348-.239 1.348.603v6.258c0 .505.345.913.77.913h2.918c.663 0 1.016.927.578 1.518l-5.998 8.084c-.47.632-1.348.239-1.348-.603v-6.258c0-.505-.345-.913-.77-.913H6.771c-.663 0-1.016-.927-.578-1.517"/></svg>',
  };
  SUMMARY_ICONS.relic = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"><path d="M8.5 17H4c-1.655 0-2 .345-2 2v1c0 1.655.345 2 2 2h16c1.655 0 2-.345 2-2v-1c0-1.655-.345-2-2-2h-4.5M9 12H6c-1.655 0-2 .345-2 2v3m11-5h3c1.655 0 2 .345 2 2v3M6 12V9c0-1.655.345-2 2-2h8c1.655 0 2 .345 2 2v3M9 7V4c0-1.655.345-2 2-2h2c1.655 0 2 .345 2 2v3m-1.5 0L16 22M10.5 7L8 22"/></svg>';
  SUMMARY_ICONS.stellar_object = '<svg viewBox="0 0 512 512" fill="currentColor"><path d="M331.924 20.385c-36.708.887-82.53 60.972-116.063 147.972h.003c30.564-65.57 71.17-106.39 97.348-99.378c28.058 7.516 37.11 69.42 24.847 148.405c-.895-.32-1.773-.642-2.672-.96c.893.367 1.765.738 2.65 1.106c-2.988 19.215-7.22 39.424-12.767 60.12a597 597 0 0 1-8.936 30.14c-24.996-3.82-52.374-9.537-80.82-17.16c-105.856-28.36-186.115-72.12-179.307-97.53c4.257-15.884 42.167-23.775 95.908-20.29c-74.427-8.7-128.912-2.044-135.035 20.803c-9.038 33.73 89.168 89.372 219.147 124.2c24.436 6.55 48.267 11.897 70.918 16.042c-28.965 75.878-68.293 126.078-96.653 118.48c-21.817-5.85-35.995-45.443-36.316-100.206c-4.79 75.476 9.278 131.945 40.66 140.356c38.836 10.407 91.394-54.998 127.896-152.98c80.12 10.74 138.958 4.278 145.38-19.682c6.384-23.82-41.025-58.44-115.102-89.03c20.713-109.022 8.483-198.5-31.96-209.34a32.1 32.1 0 0 0-9.124-1.07zm40.568 213.086c44.65 22.992 71.146 47.135 67.07 62.348c-4.055 15.13-38.104 20.457-87.333 16.303a684 684 0 0 0 9.63-32.663a677 677 0 0 0 10.632-45.986z"/></svg>';
  function summaryIcon(key) {
    const icon = document.createElement('span'); icon.className = 'fa-summary-inline-icon'; icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = SUMMARY_ICONS[key] || ''; return icon;
  }
  function iconStackedCell(lines, observedAt, className = '') {
    const td = document.createElement('td');
    lines.forEach(([iconKey, value]) => { const div = document.createElement('div'); div.className = `fa-summary-icon-line ${className}${value === '—' ? ' fa-summary-na' : ''}`; div.append(summaryIcon(iconKey), document.createTextNode(escapeText(value))); td.appendChild(div); });
    appendTimestamp(td, observedAt); return td;
  }
  function stackedCell(lines, observedAt, className = '') {
    const td = document.createElement('td');
    lines.forEach(line => { const div = document.createElement('div'); div.className = `${className}${line === '—' ? ' fa-summary-na' : ''}`; div.textContent = escapeText(line); td.appendChild(div); });
    appendTimestamp(td, observedAt);
    return td;
  }
  function featureCell(features, known) {
    if (!known) return stackedCell(['?']);
    if (!features.length) { const td = document.createElement('td'); const value = document.createElement('div'); value.className = 'fa-summary-empty'; value.textContent = '—'; td.appendChild(value); return td; }
    const td = document.createElement('td');
    features.forEach(feature => {
      const key = feature === 'stellar' ? 'stellar_object' : 'relic';
      const line = document.createElement('span'); line.className = `fa-summary-feature-line fa-summary-feature-${feature}`;
      const icon = summaryIcon(key); icon.title = feature === 'stellar' ? 'Stellar object' : 'Ausente relic';
      line.appendChild(icon); td.appendChild(line);
    });
    return td;
  }
  function capacityClass(used, provided) {
    if (used == null || provided == null) return '';
    const usedValue = number(used);
    const providedValue = number(provided);
    if (providedValue <= 0) return usedValue > 0 ? 'fa-summary-over' : '';
    if (usedValue > providedValue) return 'fa-summary-over';
    if (usedValue / providedValue < .7) return 'fa-summary-under';
    return '';
  }
  function capacityCell(rows, observedAt, known = true) {
    const td = document.createElement('td');
    rows.forEach(({ label, used, provided }) => {
      const line = document.createElement('div'); line.className = 'fa-summary-icon-line';
      line.append(summaryIcon(label));
      const value = document.createElement('span'); value.className = 'fa-summary-capacity-value';
      const usedSpan = document.createElement('span'); usedSpan.className = 'fa-summary-capacity-part';
      const usedClass = known ? capacityClass(used, provided) : '';
      if (usedClass) usedSpan.classList.add(usedClass);
      if (usedClass === 'fa-summary-over') usedSpan.style.setProperty('color', '#ff8d8d', 'important');
      if (usedClass === 'fa-summary-under') usedSpan.style.setProperty('color', '#ffcc66', 'important');
      usedSpan.textContent = fmtMaybe(used, known);
      if (usedSpan.textContent === '—') usedSpan.classList.add('fa-summary-na');
      const providedSpan = document.createElement('span'); providedSpan.className = 'fa-summary-capacity-part fa-summary-capacity-provided'; providedSpan.textContent = `/ ${fmtMaybe(provided, known)}`;
      if (providedSpan.textContent.includes('—')) providedSpan.classList.add('fa-summary-na');
      value.append(usedSpan, providedSpan);
      line.appendChild(value);
      td.appendChild(line);
    });
    appendTimestamp(td, observedAt);
    return td;
  }
  function storageCell(rows, known = true) {
    const td = document.createElement('td');
    rows.forEach(({ label, current, capacity }) => {
      const line = document.createElement('div'); line.className = 'fa-summary-icon-line';
      line.append(summaryIcon(label));
      const value = document.createElement('span');
      value.textContent = known ? percent(current, capacity) : '?';
      if (value.textContent === '—') value.classList.add('fa-summary-na');
      if (known && capacity != null && number(capacity) > 0 && Math.round(number(current) / number(capacity) * 100) >= 100) {
        value.className = 'fa-summary-full';
        value.style.setProperty('color', '#ff8d8d', 'important');
      }
      line.appendChild(value);
      td.appendChild(line);
    });
    return td;
  }
  function actionButton(glyph, title, onClick) {
    const button = document.createElement('button');
    button.type = 'button'; button.title = title; button.setAttribute('aria-label', title);
    const icon = document.createElement('span'); icon.className = 'fa-summary-action-glyph'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = glyph;
    button.appendChild(icon); button.addEventListener('click', onClick);
    return button;
  }
  function queueTimestampTitle(record) {
    const labels = [['buildQueue', 'construction'], ['researchQueue', 'research'], ['shipQueue', 'ship'], ['defenseQueue', 'defense']];
    const parts = labels.map(([category, label]) => { const timestamp = stampFor(record, category); return timestamp ? `${label}: ${new Date(timestamp).toLocaleString()}` : `${label}: not observed`; });
    return `Oldest queue observation — ${parts.join('; ')}`;
  }
  function queueCell(record, counts, observedAt) {
    const td = document.createElement('td'); td.className = 'fa-summary-queue-cell';
    const values = document.createElement('div'); values.className = 'fa-summary-queue-values';
    [['B', counts.build], ['R', counts.research], ['S', counts.ships], ['D', counts.defense]].forEach(([label, count]) => {
      const unknown = count == null;
      const item = document.createElement('span'); item.className = `fa-summary-queue-item${count === 0 ? ' fa-summary-zero' : ''}${unknown ? ' fa-summary-unknown' : ''}`;
      if (count === 0) { item.style.setProperty('color', 'var(--muted)', 'important'); item.style.opacity = '.2'; }
      item.textContent = `${label}${unknown ? '?' : count}`; item.title = `${label === 'B' ? 'Construction' : label === 'R' ? 'Research' : label === 'S' ? 'Ships' : 'Defense'} queue: ${unknown ? 'not observed' : count}`; values.appendChild(item);
    });
    td.appendChild(values);
    appendTimestamp(td, observedAt, queueTimestampTitle(record), record.owned === true);
    return td;
  }
  function appendTimestamp(td, observedAt, timestampTitle, staleAllowed = true) {
    if (observedAt === undefined) return;
    const time = document.createElement('span'); time.className = 'fa-summary-time';
    if (staleAllowed && observedAt && now() - new Date(observedAt).getTime() >= 2 * 24 * 60 * 60 * 1000) {
      time.classList.add('fa-summary-time-stale');
      time.style.setProperty('background', 'var(--fg)', 'important');
      time.style.setProperty('border-color', 'var(--fg)', 'important');
      time.style.setProperty('color', 'var(--bg, #0a0d13)', 'important');
      time.style.opacity = '1';
    }
    time.textContent = observedAt ? ageShort(observedAt) : '—';
    time.title = timestampTitle || (observedAt ? `Observed/reported ${new Date(observedAt).toLocaleString()}` : 'Not observed');
    td.appendChild(time);
  }
  function timestampMs(value) {
    if (value == null || value === '') return null;
    if (value instanceof Date) {
      const time = value.getTime();
      return Number.isFinite(time) ? time : null;
    }
    const text = String(value).trim();
    if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) {
      const numeric = Number(text);
      if (!Number.isFinite(numeric)) return null;
      return Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
    }
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  }
  function iso(value) {
    const time = timestampMs(value);
    return time == null ? null : new Date(time).toISOString();
  }
  function coords(galaxy, system, position) {
    const g = Number(galaxy), s = Number(system), p = Number(position);
    return [g, s, p].every(Number.isSafeInteger) ? `${g}:${s}:${p}` : null;
  }
  function displayCoords(system, position) {
    const s = Number(system), p = Number(position);
    return [s, p].every(Number.isSafeInteger) ? `${s}:${p}` : null;
  }
  function coordsFromText(text) {
    const match = String(text || '').match(/(\d+)\s*:\s*(\d+)/);
    return match ? { system: Number(match[1]), position: Number(match[2]) } : null;
  }
  function endpointUrl(path) { return new URL(path, location.href).href; }
  function validGalaxy(value, fallback = null) {
    const galaxy = Number(value);
    return Number.isSafeInteger(galaxy) && galaxy > 0 ? galaxy : fallback;
  }
  function keyFor(data) {
    const coordinateKey = coords(validGalaxy(data.galaxy, data.owned === true ? 1 : null), data.system, data.position);
    const system = Number(data.system), position = Number(data.position);
    const unknownGalaxyKey = data.allowUnknownGalaxy && Number.isSafeInteger(system) && Number.isSafeInteger(position)
      ? `location:${system}:${position}` : null;
    return coordinateKey || unknownGalaxyKey || (data.planetId != null ? `planet:${data.planetId}` : null);
  }
  function blankRecord(data = {}) {
    return {
      key: keyFor(data) || `unknown:${Math.random().toString(36).slice(2)}`,
      planetId: data.planetId == null ? null : Number(data.planetId),
      // The sidebar exposes system:position only; galaxy 1 is a temporary
      // local fallback until the planet API response supplies the value.
      galaxy: validGalaxy(data.galaxy, data.owned === true ? 1 : null),
      system: data.system == null ? null : Number(data.system),
      position: data.position == null ? null : Number(data.position),
      name: data.name || null,
      owned: data.owned == null ? null : Boolean(data.owned),
      observed: {},
      updatedAt: null,
    };
  }
  function canonicalizeRecords() {
    const groups = [];
    const byId = new Map();
    const byCoords = new Map();
    for (const source of state.records.values()) {
      const record = { ...source, observed: { ...(source.observed || {}) } };
      if (record.owned === true && !validGalaxy(record.galaxy)) record.galaxy = 1;
      if (record.galaxy != null && !validGalaxy(record.galaxy)) record.galaxy = null;
      const recordId = record.planetId == null ? null : Number(record.planetId);
      const recordCoords = coords(record.galaxy, record.system, record.position);
      const existing = (recordId != null && byId.get(recordId)) || (recordCoords && byCoords.get(recordCoords));
      if (existing) {
        existing.record = mergeRecords(existing.record, record);
        existing.planetId = existing.record.planetId == null ? existing.planetId : Number(existing.record.planetId);
        existing.coords = coords(existing.record.galaxy, existing.record.system, existing.record.position) || existing.coords;
        if (existing.planetId != null) byId.set(existing.planetId, existing);
        if (existing.coords) byCoords.set(existing.coords, existing);
      } else {
        const group = { record, planetId: recordId, coords: recordCoords };
        groups.push(group);
        if (recordId != null) byId.set(recordId, group);
        if (recordCoords) byCoords.set(recordCoords, group);
      }
    }
    state.records.clear();
    for (const group of groups) {
      const record = group.record;
      record.key = record.planetId != null ? `planet:${Number(record.planetId)}` : group.coords || record.key;
      state.records.set(record.key, record);
    }
    state.recordsNeedCanonicalize = false;
  }
  function mergeRecords(a, b) {
    const merged = { ...a, ...b, key: a.key, observed: { ...(a.observed || {}), ...(b.observed || {}) } };
    for (const field of ['planetId', 'galaxy', 'system', 'position', 'name']) if (b[field] == null || b[field] === '') merged[field] = a[field];
    if (a.owned === true || b.owned === true) merged.owned = true;
    else if (a.owned == null) merged.owned = b.owned;
    merged.updatedAt = Object.values(merged.observed).reduce((latest, item) => Math.max(latest, new Date(item.observedAt).getTime() || 0), 0) || null;
    return merged;
  }
  function findRecord(data) {
    const desired = keyFor(data);
    if (data.planetId != null) {
      for (const record of state.records.values()) if (Number(record.planetId) === Number(data.planetId)) return record;
    }
    if (desired && state.records.has(desired)) return state.records.get(desired);
    return null;
  }
  function getOrCreateRecord(data = {}) {
    const existing = findRecord(data);
    if (existing) {
      const desired = keyFor(data);
      if (desired && desired !== existing.key) {
        const target = state.records.get(desired);
        if (target && target !== existing) {
          state.records.set(desired, mergeRecords(target, existing));
          state.records.delete(existing.key);
          state.recordsNeedCanonicalize = true;
          return state.records.get(desired);
        }
        state.records.delete(existing.key);
        existing.key = desired;
        state.records.set(desired, existing);
        state.recordsNeedCanonicalize = true;
      }
      return existing;
    }
    const record = blankRecord(data);
    state.records.set(record.key, record);
    state.recordsNeedCanonicalize = true;
    return record;
  }
  function touchRecord(record, category, value, endpoint, observedAt = new Date().toISOString()) {
    record.observed[category] = { value, observedAt, endpoint };
    record.updatedAt = observedAt;
    if (category === 'base' && value && typeof value === 'object') {
      Object.assign(record, {
        planetId: value.id == null ? record.planetId : Number(value.id),
        galaxy: validGalaxy(value.galaxy, record.galaxy),
        system: value.system == null ? record.system : Number(value.system),
        position: value.position == null ? record.position : Number(value.position),
        name: value.name || record.name,
      });
    }
    return record;
  }

  function openOwnDb() {
    if (state.db) return Promise.resolve(state.db);
    if (state.dbPromise) return state.dbPromise;
    state.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(PLANET_STORE)) db.createObjectStore(PLANET_STORE, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(METADATA_STORE)) db.createObjectStore(METADATA_STORE, { keyPath: 'key' });
      };
      request.onsuccess = () => { state.db = request.result; resolve(state.db); };
      request.onerror = () => reject(request.error || new Error('Could not open planet summary database.'));
    });
    return state.dbPromise;
  }
  function idbRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
    });
  }
  async function loadOwnData() {
    try {
      const db = await openOwnDb();
      const values = await idbRequest(db.transaction(PLANET_STORE, 'readonly').objectStore(PLANET_STORE).getAll());
      values.forEach(record => state.records.set(record.key, record));
      canonicalizeRecords();
      scheduleRender();
    } catch (error) { state.lastError = error.message; }
  }
  function saveRecord(record) {
    state.persistChain = state.persistChain.then(async () => {
      const db = await openOwnDb();
      await idbRequest(db.transaction(PLANET_STORE, 'readwrite').objectStore(PLANET_STORE).put(record));
    }).catch(error => { state.lastError = error.message; });
    return state.persistChain;
  }
  function apiInfo(url) {
    let parsed;
    try { parsed = new URL(url, location.href); } catch (_) { return null; }
    if (parsed.origin !== location.origin || !parsed.pathname.startsWith('/api/')) return null;
    const planetMatch = parsed.pathname.match(/^\/api\/planets\/(\d+)(\/.*)?$/);
    if (planetMatch) {
      const suffix = planetMatch[2] || '';
      const category = CATEGORY_BY_SUFFIX[suffix];
      return category ? { kind: 'planet', id: Number(planetMatch[1]), category, endpoint: parsed.pathname } : null;
    }
    return null;
  }
  function statusBody(result) {
    if (!result) return { status: 0, body: null };
    if (Object.prototype.hasOwnProperty.call(result, 'body')) return { status: Number(result.status) || 200, body: result.body };
    return { status: 200, body: result };
  }
  async function applyApiResponse(url, status, body, observedAt = new Date().toISOString()) {
    const info = apiInfo(url);
    if (!info || status < 200 || status >= 300 || body == null) return;
    const bodyObject = Array.isArray(body) ? body[0] : body;
    const record = getOrCreateRecord({
      planetId: info.id,
      galaxy: bodyObject && bodyObject.galaxy,
      system: bodyObject && bodyObject.system,
      position: bodyObject && bodyObject.position,
      name: bodyObject && bodyObject.name,
    });
    const originalTime = new Date().toISOString();
    touchRecord(record, info.category, body, observedAt || originalTime);
    await saveRecord(record);
    scheduleRender();
  }
  function observeApiResponse(url, response) {
    const info = apiInfo(url);
    if (!info || !response || !response.ok) return;
    response.clone().json().then(body => applyApiResponse(url, response.status, body)).catch(() => {});
  }
  function installFetchHook() {
    if (!window.fetch || window.fetch.__faPlanetsSummary) return;
    const nativeFetch = window.fetch;
    function wrappedFetch(...args) {
      let url = args[0] && args[0].url ? args[0].url : args[0];
      const promise = nativeFetch.apply(this, args);
      if (apiInfo(url)) promise.then(response => observeApiResponse(url, response)).catch(() => {});
      return promise;
    }
    wrappedFetch.__faPlanetsSummary = true;
    window.fetch = wrappedFetch;
  }
  function installXhrHook() {
    if (!window.XMLHttpRequest || XMLHttpRequest.prototype.__faPlanetsSummary) return;
    const nativeOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...args) {
      this.__faPlanetsSummaryUrl = url;
      return nativeOpen.call(this, method, url, ...args);
    };
    const nativeSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (...args) {
      this.addEventListener('load', () => {
        const url = this.__faPlanetsSummaryUrl;
        const info = apiInfo(url);
        if (!info || this.status < 200 || this.status >= 300) return;
        try { applyApiResponse(url, this.status, JSON.parse(this.responseText)); } catch (_) {}
      });
      return nativeSend.apply(this, args);
    };
    XMLHttpRequest.prototype.__faPlanetsSummary = true;
  }
  installFetchHook();
  installXhrHook();

  function sidebarPlanets(shouldCanonicalize = true) {
    const result = [];
    document.querySelectorAll('#sidebar-planets .sidebar-planet-pill[data-planet-id]').forEach(pill => {
      const planetId = Number(pill.dataset.planetId);
      if (!Number.isSafeInteger(planetId)) return;
      const location = coordsFromText(pill.querySelector('.sidebar-planet-coords')?.textContent);
      const sidebarName = pill.querySelector('.sidebar-planet-name')?.textContent.trim() || null;
      const record = getOrCreateRecord({ planetId, name: sidebarName, system: location?.system, position: location?.position, owned: true });
      record.owned = true;
      // The live sidebar is authoritative for the current owned-planet name.
      if (sidebarName) record.name = sidebarName;
      // Sidebar coordinates are system:position and do not include galaxy.
      // Current colonies are in galaxy 1; an API observation replaces this.
      if (!validGalaxy(record.galaxy)) record.galaxy = 1;
      result.push(record);
    });
    // `owned` is authoritative from the live sidebar. Older cached records
    // may have been incorrectly marked as owned by stale observations.
    // Reconcile them whenever the sidebar has finished rendering.
    if (result.length > 0) {
      const ownedIds = new Set(result.map(record => Number(record.planetId)));
      for (const record of state.records.values()) {
        if (record.planetId != null) record.owned = ownedIds.has(Number(record.planetId));
      }
      if (shouldCanonicalize) canonicalizeRecords();
    }
    return result;
  }
  function notificationType(notification) {
    const value = String(notification?.notification_type || '').toLowerCase();
    if (value === 'exploration') return 'exploration';
    if (value === 'exploration_lost') return 'exploration_lost';
    if (value === 'planet_scanned' || value === 'scan_repelled') return 'scan';
    if (value === 'attack_incoming') return 'attack';
    if (value === 'battle_report') return 'battle';
    if (value.includes('transport')) return 'transport';
    if (value.includes('harvest')) return 'harvest';
    if (value.includes('relocat')) return 'relocation';
    if (value.includes('recover')) return 'recovery';
    if (value.includes('trade')) return 'trade';
    return null;
  }
  function notificationTarget(notification) {
    const nested = notification?.exploration || notification?.battle || notification?.transport || notification?.relocate || notification?.recover || {};
    return {
      planetId: nested.planet_id,
      name: nested.planet_name,
      galaxy: notification?.destination_galaxy,
      system: notification?.destination_system,
      position: notification?.destination_position,
    };
  }
  function isTradeGuildPlanetName(name) {
    return /galactic\s+trade\s+guild/i.test(String(name || ''));
  }
  function addNotification(index, notification) {
    const type = notificationType(notification);
    // Transport deliveries describe resource movement, not planet intelligence.
    // Do not create or enrich explored-planet records from them.
    if (type === 'transport') return;
    const target = notificationTarget(notification);
    if (isTradeGuildPlanetName(target.name)) return;
    const key = keyFor({ ...target, allowUnknownGalaxy: true }) || (target.planetId != null ? `planet:${target.planetId}` : null);
    if (!type || !key) return;
    const date = iso(notification.created_at) || iso(notification.arrives_at) || new Date().toISOString();
    let entry = index.get(key);
    if (!entry) {
      entry = {
        key,
        planetId: target.planetId == null ? null : Number(target.planetId),
        name: target.name || null,
        galaxy: target.galaxy == null ? null : Number(target.galaxy),
        system: target.system == null ? null : Number(target.system),
        position: target.position == null ? null : Number(target.position),
        counts: {},
        latest: {},
        exploration: null,
        explorationAt: null,
        explorationLost: false,
        explorationLostAt: null,
        scanRepelled: false,
        scanRepelledAt: null,
      };
      index.set(key, entry);
    }
    if (target.name) entry.name = target.name;
    if (target.planetId != null) entry.planetId = Number(target.planetId);
    if (target.galaxy != null) entry.galaxy = Number(target.galaxy);
    if (target.system != null) entry.system = Number(target.system);
    if (target.position != null) entry.position = Number(target.position);
    entry.counts[type] = (entry.counts[type] || 0) + 1;
    if (!entry.latest[type] || new Date(entry.latest[type]).getTime() < new Date(date).getTime()) entry.latest[type] = date;
    if (type === 'exploration_lost') {
      entry.explorationLost = true;
      if (!entry.explorationLostAt || new Date(entry.explorationLostAt).getTime() < new Date(date).getTime()) entry.explorationLostAt = date;
    }
    if (notification.notification_type === 'scan_repelled') {
      entry.scanRepelled = true;
      if (!entry.scanRepelledAt || new Date(entry.scanRepelledAt).getTime() < new Date(date).getTime()) entry.scanRepelledAt = date;
    }
    // A destroyed explorer has no scan payload. Keep the newest successful
    // exploration separately so a lost attempt never erases known data.
    if (type === 'exploration' && notification.notification_type === 'exploration' && notification.exploration && (!entry.exploration || new Date(entry.explorationAt || 0).getTime() < new Date(date).getTime())) {
      entry.exploration = notification.exploration;
      entry.explorationAt = date;
    }
  }
  async function loadNotifications() {
    if (state.notificationsLoadPromise) {
      state.notificationsLoadQueued = true;
      return state.notificationsLoadPromise;
    }
    const load = async () => {
      if (!window.indexedDB) return;
      try {
      if (indexedDB.databases) {
        const databases = await indexedDB.databases();
        if (!databases.some(item => item.name === NOTIFICATION_DB_NAME)) return;
      }
      const notifications = await new Promise((resolve, reject) => {
        const request = indexedDB.open(NOTIFICATION_DB_NAME, 1);
        request.onupgradeneeded = event => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(NOTIFICATION_STORE)) { event.target.transaction.abort(); }
        };
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(NOTIFICATION_STORE)) { db.close(); resolve([]); return; }
          const read = db.transaction(NOTIFICATION_STORE, 'readonly').objectStore(NOTIFICATION_STORE).getAll();
          read.onsuccess = () => { db.close(); resolve(read.result || []); };
          read.onerror = () => { db.close(); reject(read.error); };
        };
        request.onerror = () => reject(request.error);
      });
      const index = new Map();
      notifications.forEach(notification => addNotification(index, notification));
      const byPlanetId = new Map();
      const byLocation = new Map();
      for (const entry of index.values()) {
        if (entry.planetId != null) byPlanetId.set(Number(entry.planetId), entry);
        if (Number.isSafeInteger(Number(entry.system)) && Number.isSafeInteger(Number(entry.position))) {
          byLocation.set(`location:${Number(entry.system)}:${Number(entry.position)}`, entry);
        }
      }
      state.notificationIndex = index;
      state.notificationByPlanetId = byPlanetId;
      state.notificationByLocation = byLocation;
      state.notificationsLoaded = true;
      for (const entry of index.values()) {
        const data = { planetId: entry.planetId, name: entry.name, galaxy: entry.galaxy, system: entry.system, position: entry.position, allowUnknownGalaxy: true };
        const existed = findRecord(data);
        const record = getOrCreateRecord(data);
        let changed = !existed;
        if (entry.name && !record.name) {
          record.name = entry.name;
          changed = true;
        }
        if (changed) await saveRecord(record);
      }
      scheduleRender();
      } catch (error) { state.lastError = `Notifications: ${error.message}`; }
    };
    state.notificationsLoadPromise = load().finally(() => {
      state.notificationsLoadPromise = null;
      if (state.notificationsLoadQueued) {
        state.notificationsLoadQueued = false;
        setTimeout(() => loadNotifications(), 100);
      }
    });
    return state.notificationsLoadPromise;
  }

  function recordNotifications(record) {
    const locationKey = Number.isSafeInteger(Number(record.system)) && Number.isSafeInteger(Number(record.position))
      ? `location:${Number(record.system)}:${Number(record.position)}` : null;
    const direct = state.notificationIndex.get(record.key)
      || (record.planetId != null ? state.notificationIndex.get(`planet:${record.planetId}`) : null)
      || (locationKey ? state.notificationIndex.get(locationKey) : null);
    return direct
      || (record.planetId != null ? state.notificationByPlanetId.get(Number(record.planetId)) : null)
      || (locationKey ? state.notificationByLocation.get(locationKey) : null)
      || null;
  }
  function latestObservation(record) {
    return Object.values(record.observed || {}).reduce((latest, item) => !latest || new Date(item.observedAt) > new Date(latest) ? item.observedAt : latest, null);
  }
  function oldestTimestamp(...timestamps) {
    return timestamps.filter(Boolean).sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0] || null;
  }
  function economyTimestamp(record) {
    return oldestTimestamp(latestObservation(record), stampFor(record, 'resources'), stampFor(record, 'base'));
  }
  function economyTimestampTitle(record, timestamp) {
    if (!timestamp) return 'No observation available';
    const baseAt = stampFor(record, 'base');
    const resourcesAt = stampFor(record, 'resources');
    const parts = [
      baseAt ? `planet data/capacity: ${new Date(baseAt).toLocaleString()}` : null,
      resourcesAt ? `resources/production/storage: ${new Date(resourcesAt).toLocaleString()}` : null,
    ].filter(Boolean);
    return `Oldest observation used for economy data${parts.length ? ` — ${parts.join('; ')}` : ''}`;
  }
  function explorationTimestampTitle(timestamp, successful = true) {
    if (!timestamp) return 'No historical exploration attempt available';
    return `${successful ? 'Latest successful exploration report' : 'Latest destroyed exploration attempt'}: ${new Date(timestamp).toLocaleString()}`;
  }
  function explorationAttemptAt(notification) {
    // A successful report wins over destroyed attempts, even when older.
    return notification?.explorationAt || notification?.explorationLostAt || null;
  }
  function valueFor(record, category) { return record.observed?.[category]?.value; }
  function stampFor(record, category) { return record.observed?.[category]?.observedAt; }
  function latestBase(record) { return valueFor(record, 'base') || {}; }
  function latestResources(record) { return valueFor(record, 'resources') || latestBase(record); }
  function sumShips(list) { return (Array.isArray(list) ? list : []).reduce((total, ship) => total + number(ship.quantity), 0); }
  function groupShips(list) {
    const groups = {};
    (Array.isArray(list) ? list : []).forEach(ship => { const group = ship.class || (ship.ship_key || '').split('_')[0] || 'other'; groups[group] = (groups[group] || 0) + number(ship.quantity); });
    return Object.entries(groups).map(([key, total]) => `${key} ${fmt(total)}`).join(' · ') || 'none';
  }
  function percent(current, capacity) { return current == null || capacity == null || number(capacity) <= 0 ? '—' : `${Math.min(999, number(current) / number(capacity) * 100).toFixed(0)}%`; }
  function observedStamp(record, category) {
    return stampFor(record, category) || (category === 'resources' ? stampFor(record, 'base') : null);
  }
  function observedCell(record, category, primary, extra = '') {
    const observedAt = observedStamp(record, category);
    return cell(primary, extra, observedAt ? '' : 'fa-summary-na', observedAt, undefined, record.owned === true);
  }
  function statusCell(value, reportedAt, sourceLabel) { return cell(value, sourceLabel || null, `fa-summary-status-value${reportedAt ? '' : ' fa-summary-na'}`, reportedAt); }
  function exploredReportValue(report, group, key) {
    if (!report || !Object.prototype.hasOwnProperty.call(report, group || key)) return '?';
    const source = group ? report[group] : report;
    if (!source || !Object.prototype.hasOwnProperty.call(source, key) || source[key] == null) return '?';
    return number(source[key]) === 0 ? '—' : fmt(source[key]);
  }
  function exploredReportCell(report, group, key) {
    const value = exploredReportValue(report, group, key);
    return cell(value, null, value === '—' ? 'fa-summary-na' : '');
  }
  function exploredResourceCell(report, group, key, iconKey) {
    const value = exploredReportValue(report, group, key);
    return iconStackedCell([[iconKey, value]]);
  }
  function exploredSurvivorsCell(report, status) {
    const td = document.createElement('td');
    const line = document.createElement('div'); line.className = 'fa-summary-survivors';
    const values = status === 'Occupied' ? ['—', '—'] : !report ? ['?', '?'] : [exploredReportValue(report, null, 'population'), exploredReportValue(report, null, 'automatons')];
    [['person', values[0]], ['automaton', values[1]]].forEach(([iconKey, value], index) => {
      if (index) { const separator = document.createElement('span'); separator.className = 'fa-summary-survivors-separator'; separator.textContent = '·'; line.appendChild(separator); }
      const item = document.createElement('span'); item.className = value === '—' ? 'fa-summary-na' : '';
      item.append(summaryIcon(iconKey), document.createTextNode(value)); line.appendChild(item);
    });
    td.appendChild(line); return td;
  }
  function currentOccupancy(record, notification) {
    const base = latestBase(record);
    if (record.owned === true) return { value: 'Owned', date: stampFor(record, 'base') };
    if (notification?.explorationLost || notification?.scanRepelled) return { value: 'Occupied', date: null };
    if (base.claimed === true) return { value: 'Occupied', date: stampFor(record, 'base') };
    if (base.claimed === false) return { value: 'Unoccupied', date: stampFor(record, 'base') };
    if (notification?.exploration && typeof notification.exploration.is_occupied === 'boolean') return { value: notification.exploration.is_occupied ? 'Occupied' : 'Unoccupied', date: null };
    return { value: '?', date: null };
  }
  function recordFeatures(record, notification) {
    const base = latestBase(record);
    const exploration = notification?.exploration;
    const known = record.owned === true
      ? Object.prototype.hasOwnProperty.call(base, 'has_relic_building') || Object.prototype.hasOwnProperty.call(base, 'has_stellar_object_feature')
      : exploration != null || notification?.explorationLost === true;
    if (!known) return ['unknown'];
    const features = [];
    if (base.has_relic_building === true || exploration?.relic_detected === true) features.push('relic');
    if (base.has_stellar_object_feature === true || exploration?.stellar_object_detected === true) features.push('stellar');
    return features.length ? features : ['none'];
  }
  function matchesFilters(record) {
    const notification = recordNotifications(record);
    const status = currentOccupancy(record, notification).value;
    if (state.statusFilters.size && !state.statusFilters.has(status)) return false;
    const features = recordFeatures(record, notification);
    if (state.featureFilters.size) {
      const hasRelic = features.includes('relic');
      const hasStellar = features.includes('stellar');
      const matchesFeature = [...state.featureFilters].some(feature =>
        feature === 'both' ? hasRelic && hasStellar : features.includes(feature)
      );
      if (!matchesFeature) return false;
    }
    return true;
  }

  function buildingLabel(building) {
    return `${building.name || building.building_name || building.type || 'building'}${building.amount != null ? `: ${building.amount}` : ''}`;
  }
  function knownBuildings(record, notification) {
    const observedBuildings = valueFor(record, 'buildings');
    if (record.owned === true) {
      if (Array.isArray(observedBuildings)) return { items: observedBuildings.filter(building => number(building.amount) > 0), observedAt: stampFor(record, 'buildings'), known: true };
      return { items: [], observedAt: null, known: false };
    }
    const exploration = notification?.exploration;
    if (exploration && Array.isArray(exploration.buildings)) return { items: exploration.buildings.filter(building => number(building.amount ?? building.level ?? 1) > 0), observedAt: notification.latest.exploration, known: true };
    if (exploration || notification?.explorationLost) return { items: [], observedAt: null, known: true };
    return { items: [], observedAt: null, known: false };
  }
  function knownShips(record, notification) {
    const stationed = valueFor(record, 'ships');
    if (record.owned === true) {
      if (Array.isArray(stationed)) return { items: stationed.filter(ship => number(ship.quantity) > 0), observedAt: stampFor(record, 'ships'), known: true };
      return { items: [], observedAt: null, known: false };
    }
    const exploration = notification?.exploration;
    const ships = exploration && Array.isArray(exploration.fleet) ? exploration.fleet : null;
    if (Array.isArray(ships)) return { items: ships.filter(ship => number(ship.quantity) > 0), observedAt: notification.latest.exploration, known: true };
    if (exploration || notification?.explorationLost) return { items: [], observedAt: null, known: true };
    return { items: [], observedAt: null, known: false };
  }
  function knownBuildingsCell(record, notification) {
    const known = knownBuildings(record, notification);
    return cell(known.items.length ? fmt(known.items.length) : (known.known ? '—' : '?'), null, known.items.length ? '' : 'fa-summary-na', record.owned === true ? known.observedAt : undefined, undefined, record.owned === true);
  }
  function knownFleetCell(record, notification) {
    const known = knownShips(record, notification);
    return cell(known.items.length ? fmt(sumShips(known.items)) : (known.known ? '—' : '?'), null, known.items.length ? '' : 'fa-summary-na', record.owned === true ? known.observedAt : undefined, undefined, record.owned === true);
  }
  function knownDefenses(record, notification) {
    const observed = valueFor(record, 'defenses');
    if (record.owned === true) {
      if (Array.isArray(observed)) return { items: observed.filter(item => number(item.quantity) > 0), observedAt: stampFor(record, 'defenses'), known: true };
      return { items: [], observedAt: null, known: false };
    }
    const exploration = notification?.exploration;
    if (exploration && Array.isArray(exploration.defense)) return { items: exploration.defense.filter(item => number(item.quantity) > 0), observedAt: notification.latest.exploration, known: true };
    if (exploration || notification?.explorationLost) return { items: [], observedAt: null, known: true };
    return { items: [], observedAt: null, known: false };
  }
  function knownDefenseCell(record, notification) {
    const known = knownDefenses(record, notification);
    const total = known.items.reduce((sum, item) => sum + number(item.quantity), 0);
    return cell(total ? fmt(total) : (known.known ? '—' : '?'), null, total ? '' : 'fa-summary-na', record.owned === true ? known.observedAt : undefined, undefined, record.owned === true);
  }
  function detailSection(title, content) {
    const section = document.createElement('section');
    const heading = document.createElement('h4'); heading.textContent = title; section.appendChild(heading);
    if (typeof content === 'string') { const div = document.createElement('div'); div.textContent = content; section.appendChild(div); }
    else section.appendChild(content);
    return section;
  }
  function listElement(items) {
    const ul = document.createElement('ul');
    if (!items.length) { const li = document.createElement('li'); li.textContent = '—'; ul.appendChild(li); return ul; }
    items.forEach(item => { const li = document.createElement('li'); li.textContent = item; ul.appendChild(li); });
    return ul;
  }
  function renderDetails(record, colspan) {
    const tr = document.createElement('tr'); tr.className = 'fa-summary-detail-row';
    const td = document.createElement('td'); td.colSpan = colspan;
    const grid = document.createElement('div'); grid.className = 'fa-summary-detail';
    const base = latestBase(record), resources = latestResources(record), notif = recordNotifications(record);
    const displayNotif = record.owned === true ? null : notif;
    const exploration = displayNotif?.exploration;
    const buildings = knownBuildings(record, displayNotif);
    const ships = knownShips(record, displayNotif);
    const exploredDefenses = knownDefenses(record, displayNotif);

    if (record.owned === true) {
      const defenses = valueFor(record, 'defenses') || [];
      const queues = [
        ['Construction', 'buildQueue'], ['Research', 'researchQueue'], ['Ships queue', 'shipQueue'], ['Defense queue', 'defenseQueue'],
      ].map(([label, category]) => { const list = valueFor(record, category) || []; return `${label}: ${list.length ? list.map(item => `${item.building_name || item.tech_name || item.ship_name || item.ship_key || 'item'} ×${item.quantity || item.remaining || item.target_level || item.target_amount || 1}`).join(', ') : 'idle'} (${ageShort(stampFor(record, category))})`; });
      grid.appendChild(detailSection('Economy', `Metal ${fmtMaybe(resources.metal)} / ${fmtMaybe(resources.capacity_metal)} · Silicon ${fmtMaybe(resources.silicon)} / ${fmtMaybe(resources.capacity_silicon)} · Helium ${fmtMaybe(resources.helium)}\nPopulation ${fmtMaybe(base.population_used)} / ${fmtMaybe(base.population)} · Automatons ${fmtMaybe(base.automatons_used)} / ${fmtMaybe(base.automatons)} · Energy ${fmtMaybe(base.energy_used)} / ${fmtMaybe(base.energy)}\nBuildable space ${fmtMaybe(base.buildable_space_used)} / ${fmtMaybe(base.buildable_space)}\nObserved ${ageShort(stampFor(record, 'resources') || stampFor(record, 'base'))}`));
      grid.appendChild(detailSection('Buildings', listElement(buildings.items.map(buildingLabel))));
      grid.appendChild(detailSection('Defenses', listElement(defenses.filter(item => number(item.quantity) > 0).map(item => `${item.name || item.key}: ${fmt(item.quantity)}`))));
      grid.appendChild(detailSection('Stationed fleet', listElement(ships.items.map(item => `${item.name || item.ship_name || item.key}: ${fmt(item.quantity)}`))));
      grid.appendChild(detailSection('Queues', listElement(queues)));
    } else {
      grid.appendChild(detailSection('Known buildings', listElement(buildings.items.map(buildingLabel))));
      grid.appendChild(detailSection('Known fleet', listElement(ships.items.map(item => `${item.ship_name || item.name || item.ship_key || 'ship'}${item.quantity != null ? ` ×${fmt(item.quantity)}` : ''}`))));
      grid.appendChild(detailSection('Known defenses', listElement(exploredDefenses.items.map(item => `${item.ship_name || item.name || item.ship_key || 'defense'}${item.quantity != null ? ` ×${fmt(item.quantity)}` : ''}`))));
    }
    if (record.owned !== true) grid.appendChild(detailSection('Reported exploration', exploration ? `Occupied: ${exploration.is_occupied ? 'yes' : 'no'}\nTemperature: ${exploration.temperature ?? '—'}°C\nResources: M ${fmtMaybe(exploration.resources?.metal)} · S ${fmtMaybe(exploration.resources?.silicon)} · H ${fmtMaybe(exploration.resources?.helium)}\nDebris: M ${fmtMaybe(exploration.debris?.metal)} · S ${fmtMaybe(exploration.debris?.silicon)} · H ${fmtMaybe(exploration.debris?.helium)}\nRelic: ${exploration.relic_detected ? 'yes' : 'no'} · Stellar object: ${exploration.stellar_object_detected ? 'yes' : 'no'}` : '—'));
    if (record.owned === true) {
    }
    td.appendChild(grid); tr.appendChild(td); return tr;
  }

  const OWNED_SUBVIEWS = [
    ['overview', 'Overview'],
    ['buildings', 'Buildings'],
    ['ships', 'Ships'],
    ['defenses', 'Defences']
  ];

  function inventorySpec() {
    const specs = {
      buildings: {
        dataKey: 'buildings', queueKey: 'buildQueue',
        itemKey: item => item.type ?? item.building_key ?? item.key,
        itemName: item => item.name || item.building_name || item.type || item.building_key || 'Building',
        quantity: item => item.amount ?? item.quantity ?? item.level ?? 0,
        queueKeyFor: item => item.building_key ?? item.type ?? item.key,
      },
      ships: {
        dataKey: 'ships', queueKey: 'shipQueue',
        itemKey: item => item.key ?? item.ship_key ?? item.type,
        itemName: item => item.name || item.ship_name || item.key || item.ship_key || 'Ship',
        quantity: item => item.quantity ?? item.amount ?? 0,
        queueKeyFor: item => item.ship_key ?? item.key ?? item.type,
      },
      defenses: {
        dataKey: 'defenses', queueKey: 'defenseQueue',
        itemKey: item => item.key ?? item.ship_key ?? item.type,
        itemName: item => item.name || item.ship_name || item.key || item.ship_key || 'Defense',
        quantity: item => item.quantity ?? item.amount ?? 0,
        queueKeyFor: item => item.ship_key ?? item.key ?? item.type,
      },
    };
    return specs[state.ownedSubview] || null;
  }

  function inventoryColumnKey(itemKey) { return `inventory:${itemKey}`; }
  function inventoryItemKey(spec, item) {
    const key = spec?.itemKey(item);
    return key == null || key === '' ? null : String(key);
  }
  function inventoryCatalog() {
    const spec = inventorySpec();
    if (!spec) return [];
    const catalog = new Map();
    for (const record of state.records.values()) {
      if (record.owned !== true) continue;
      [valueFor(record, spec.dataKey), valueFor(record, spec.queueKey)].forEach(items => {
        if (!Array.isArray(items)) return;
        items.forEach((item, index) => {
          const key = inventoryItemKey(spec, item);
          if (!key) return;
          const label = String(spec.itemName(item));
          const current = catalog.get(key);
          if (!current) catalog.set(key, { key, label, order: index });
          else if (/^(Building|Ship|Defense)$/.test(current.label) && label !== current.label) current.label = label;
        });
      });
    }
    return [...catalog.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
  }
  function inventoryQuantity(spec, item) { return Math.max(0, number(spec.quantity(item))); }
  function formatDurationPerItem(seconds) {
    const total = Math.max(0, Math.round(number(seconds)));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainder = total % 60;
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (remainder || !parts.length) parts.push(`${remainder}s`);
    return parts.join(' ');
  }
  function queuedInventory(spec, record, itemKey, inventoryItem) {
    const queue = valueFor(record, spec.queueKey);
    if (!Array.isArray(queue)) return null;
    const matching = queue.filter(item => {
      const key = spec.queueKeyFor(item);
      return key != null && String(key) === itemKey;
    });
    if (!matching.length) return null;
    const quantity = matching.reduce((total, item) => {
      const queued = item.remaining ?? item.quantity ?? item.amount;
      return total + (queued == null ? 1 : Math.max(0, number(queued)));
    }, 0);
    if (quantity <= 0) return null;
    const durationSource = inventoryItem?.next_build_time_seconds
      ?? matching.find(item => item.next_build_time_seconds != null)?.next_build_time_seconds
      ?? matching.find(item => item.build_time_seconds != null)?.build_time_seconds
      ?? matching.find(item => item.duration_seconds != null)?.duration_seconds;
    const perItemSeconds = durationSource == null || number(durationSource) <= 0 ? null : number(durationSource);
    return { quantity, perItemSeconds };
  }
  function inventoryCell(record, spec, catalogItem) {
    const items = valueFor(record, spec.dataKey);
    const known = Array.isArray(items);
    const item = known ? items.find(candidate => inventoryItemKey(spec, candidate) === catalogItem.key) : null;
    const primary = !known ? '?' : item && inventoryQuantity(spec, item) > 0 ? fmt(inventoryQuantity(spec, item)) : '—';
    const queued = known ? queuedInventory(spec, record, catalogItem.key, item) : null;
    const td = document.createElement('td'); td.className = 'fa-summary-inventory-cell';
    const value = document.createElement('div'); value.className = 'fa-summary-inventory-value'; value.textContent = primary;
    if (primary === '—') value.classList.add('fa-summary-na');
    td.appendChild(value);
    if (queued) {
      const queue = document.createElement('div'); queue.className = 'fa-summary-inventory-queue';
      const count = document.createElement('span');
      const tooltip = queued.perItemSeconds == null ? 'queued' : `queued, ${formatDurationPerItem(queued.perItemSeconds)} per item`;
      count.textContent = queued.perItemSeconds == null ? `+${fmt(queued.quantity)} queued` : `+${fmt(queued.quantity)}`;
      count.title = tooltip; count.setAttribute('aria-label', tooltip);
      queue.appendChild(count);
      queue.title = tooltip; td.appendChild(queue);
    }
    return td;
  }

  function columnsForView() {
    if (state.view === 'explored') return [
      ['Location', 'coordinates'], ['Planet', 'name'], ['Last exploration', 'explorationAt'], ['Size', 'sizeTotal'], ['Status', 'status'], ['Features', 'features'], ['Buildings', 'buildings'], ['Known fleet', 'knownFleet'], ['Known defense', 'knownDefense'], ['Metal', 'exploredMetal'], ['Silicon', 'exploredSilicon'], ['Helium', 'exploredHelium'], ['Debris M', 'debrisMetal'], ['Debris S', 'debrisSilicon'], ['Survivors', 'exploredSurvivors'],
    ];
    if (state.ownedSubview !== 'overview') {
      return [
        ['Location', 'coordinates'], ['Planet', 'name'],
        ...inventoryCatalog().map(item => [item.label, inventoryColumnKey(item.key)]),
      ];
    }
    return [
      ['Location', 'coordinates'], ['Planet', 'name'], ['Size', 'sizeTotal'], ['Used size', 'sizeUsed'], ['Resources', 'resources'], ['Production / h', 'production'], ['Storage', 'storage'], ['Capacity', 'capacity'], ['Features', 'features'], ['Buildings', 'buildings'], ['Ships', 'ships'], ['Defenses', 'defenses'], ['Queues', 'queues'],
    ];
  }
  function makeRow(record, rowNumber) {
    const base = latestBase(record), resourcesData = valueFor(record, 'resources'), resources = resourcesData || {}, notif = recordNotifications(record), occupancy = currentOccupancy(record, notif);
    const baseKnown = valueFor(record, 'base') != null;
    const resourcesKnown = resourcesData != null;
    const row = document.createElement('tr');
    row.className = 'fa-summary-data-row';
    if (state.view === 'owned') row.classList.add('fa-summary-nonexpandable');
    if (state.view === 'owned' && state.lastOpenedPlanetId === Number(record.planetId)) {
      row.classList.add('fa-summary-row-current');
      row.setAttribute('aria-current', 'true');
    }
    if (state.view !== 'owned') {
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.setAttribute('aria-expanded', String(state.expanded.has(record.key)));
      row.title = 'Click to show or hide details';
      const toggleDetails = () => {
        const isExpanded = state.expanded.has(record.key);
        if (isExpanded) {
          state.expanded.delete(record.key);
          const detail = row.nextElementSibling;
          if (detail?.classList.contains('fa-summary-detail-row')) detail.remove();
          row.classList.remove('fa-summary-row-expanded');
        } else {
          state.expanded.add(record.key);
          row.after(renderDetails(record, columnsForView().length));
          row.classList.add('fa-summary-row-expanded');
        }
        row.setAttribute('aria-expanded', String(!isExpanded));
      };
      row.addEventListener('click', event => {
        if (event.target.closest('button, input, select, textarea, a')) return;
        toggleDetails();
      });
      row.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        toggleDetails();
      });
    }
    const displayNotif = record.owned === true ? null : notif;
    const reportAt = explorationAttemptAt(displayNotif);
    const name = record.name || (record.owned === true ? null : displayNotif?.name) || `Planet ${record.system ?? '—'}-${record.position ?? '—'}`;
    const location = displayCoords(record.system, record.position) || '?';
    const shipsData = valueFor(record, 'ships');
    const defensesData = valueFor(record, 'defenses');
    const ships = Array.isArray(shipsData) ? shipsData : [];
    const defenses = Array.isArray(defensesData) ? defensesData : [];
    const shipsKnown = Array.isArray(shipsData);
    const defensesKnown = Array.isArray(defensesData);
    const sizeSource = record.owned === true ? base : (displayNotif?.exploration || {});
    const sizeKnown = record.owned === true ? baseKnown : displayNotif?.exploration != null;
    const usedSize = sizeSource.buildable_space_used ?? sizeSource.building_space_used ?? sizeSource.used_buildable_space;
    const totalSize = sizeSource.buildable_space ?? sizeSource.building_space ?? sizeSource.buildable_space_total;
    const featureParts = [];
    if (base.has_relic_building === true || displayNotif?.exploration?.relic_detected === true) featureParts.push('relic');
    if (base.has_stellar_object_feature === true || displayNotif?.exploration?.stellar_object_detected === true) featureParts.push('stellar');
    const featuresKnown = record.owned === true ? baseKnown : displayNotif?.exploration != null || displayNotif?.explorationLost === true;
    const cells = {
      number: cell(rowNumber, null),
      name: cell(name, null, 'fa-summary-name', record.owned === true ? economyTimestamp(record) : undefined, record.owned === true ? economyTimestampTitle(record, economyTimestamp(record)) : undefined, record.owned === true),
      explorationAt: cell(record.owned === true ? '—' : (reportAt ? elapsedDetailed(reportAt) : '?'), null, reportAt ? '' : 'fa-summary-na', undefined, undefined, false),
      coordinates: coordinateCell(location),
      sizeUsed: cell(sizeKnown ? percent(usedSize, totalSize) : '?', null, usedSize == null || totalSize == null ? 'fa-summary-na' : ''),
      sizeTotal: cell(fmtMaybe(totalSize, sizeKnown), null, totalSize == null ? 'fa-summary-na' : ''),
      status: statusCell(record.owned === true ? 'Owned by me' : occupancy.value, undefined, null),
      features: featureCell(featureParts, featuresKnown),
      buildings: knownBuildingsCell(record, displayNotif),
      knownFleet: knownFleetCell(record, displayNotif),
      knownDefense: knownDefenseCell(record, displayNotif),
    };
    if (state.view === 'explored') {
      const report = displayNotif?.exploration;
      cells.exploredMetal = exploredResourceCell(report, 'resources', 'metal', 'metal');
      cells.exploredSilicon = exploredResourceCell(report, 'resources', 'silicon', 'silicon');
      cells.exploredHelium = exploredResourceCell(report, 'resources', 'helium', 'helium');
      cells.debrisMetal = exploredResourceCell(report, 'debris', 'metal', 'metal');
      cells.debrisSilicon = exploredResourceCell(report, 'debris', 'silicon', 'silicon');
      cells.exploredSurvivors = exploredSurvivorsCell(report, occupancy.value);
    }
    if (state.view === 'owned') {
      const buildingQueueData = valueFor(record, 'buildQueue'), researchQueueData = valueFor(record, 'researchQueue'), shipQueueData = valueFor(record, 'shipQueue'), defenseQueueData = valueFor(record, 'defenseQueue');
      const buildingQueue = Array.isArray(buildingQueueData) ? buildingQueueData : [], researchQueue = Array.isArray(researchQueueData) ? researchQueueData : [], shipQueue = Array.isArray(shipQueueData) ? shipQueueData : [], defenseQueue = Array.isArray(defenseQueueData) ? defenseQueueData : [];
      const queueObservedAt = ['buildQueue', 'researchQueue', 'shipQueue', 'defenseQueue'].map(category => stampFor(record, category)).filter(Boolean).sort()[0] || null;
      const resourceStamp = observedStamp(record, 'resources');
      cells.resources = iconStackedCell([
        ['metal', fmtMaybe(resources.metal, resourcesKnown)],
        ['silicon', fmtMaybe(resources.silicon, resourcesKnown)],
        ['helium', fmtMaybe(resources.helium, resourcesKnown)],
      ], undefined, resourceStamp ? '' : 'fa-summary-na');
      cells.production = iconStackedCell([
        ['metal', resources.rate_metal_per_hour == null ? (resourcesKnown ? '—' : '?') : `+${fmt(resources.rate_metal_per_hour)}/h`],
        ['silicon', resources.rate_silicon_per_hour == null ? (resourcesKnown ? '—' : '?') : `+${fmt(resources.rate_silicon_per_hour)}/h`],
        ['helium', resources.rate_helium_per_hour == null ? (resourcesKnown ? '—' : '?') : `+${fmt(resources.rate_helium_per_hour)}/h`],
      ], undefined, resourceStamp ? '' : 'fa-summary-na');
      cells.storage = storageCell([
        { label: 'metal', current: resources.metal, capacity: resources.capacity_metal },
        { label: 'silicon', current: resources.silicon, capacity: resources.capacity_silicon },
        { label: 'helium', current: resources.helium, capacity: resources.capacity_helium },
      ], resourcesKnown);
      cells.capacity = capacityCell([
        { label: 'person', used: base.population_used, provided: base.population },
        { label: 'automaton', used: base.automatons_used, provided: base.automatons },
        { label: 'energy', used: base.energy_used, provided: base.energy },
      ], undefined, baseKnown);
      const shipsTotal = sumShips(ships);
      const defensesTotal = defenses.reduce((total, item) => total + number(item.quantity), 0);
      cells.ships = observedCell(record, 'ships', shipsKnown ? (shipsTotal ? fmt(shipsTotal) : '—') : '?');
      cells.defenses = observedCell(record, 'defenses', defensesKnown ? (defensesTotal ? fmt(defensesTotal) : '—') : '?');
      if (shipsKnown && !shipsTotal) cells.ships.classList.add('fa-summary-na');
      cells.queues = queueCell(record, { build: buildingQueueData == null ? null : buildingQueue.length, research: researchQueueData == null ? null : researchQueue.length, ships: shipQueueData == null ? null : shipQueue.length, defense: defenseQueueData == null ? null : defenseQueue.length }, queueObservedAt);
      if (state.ownedSubview !== 'overview') {
        const spec = inventorySpec();
        inventoryCatalog().forEach(item => { cells[inventoryColumnKey(item.key)] = inventoryCell(record, spec, item); });
      }
    }
    if (state.view === 'owned' && record.planetId != null) {
      const actionInner = document.createElement('div'); actionInner.className = 'fa-summary-actions-inner';
      const updating = state.refreshing.has(record.planetId);
      const blocked = updating || state.refreshingAll;
      const update = actionButton('↻', blocked ? (state.refreshingAll ? 'Updating all planet data…' : 'Updating planet data…') : 'Update planet data', event => { event.stopPropagation(); manualRefresh(record); });
      update.disabled = blocked; actionInner.appendChild(update);
      const move = actionButton('↗', 'Open planet', event => { event.stopPropagation(); closePanel(); if (typeof window.openPlanet === 'function') window.openPlanet(record.planetId); });
      actionInner.appendChild(move);
      const nameContent = document.createElement('div'); nameContent.className = 'fa-summary-name-content';
      const nameMain = cells.name.querySelector('.fa-summary-name');
      if (nameMain) nameMain.remove();
      nameContent.append(nameMain || document.createTextNode(''), actionInner);
      cells.name.prepend(nameContent);
    }
    for (const [, key] of columnsForView()) { const current = cells[key]; if (current) { if (key === 'number') current.classList.add('fa-summary-number'); if (key === 'name') current.classList.add('fa-summary-planet-sticky'); row.appendChild(current); } }
    return row;
  }
  function columnSortValue(record, columnKey) {
    const notification = record.owned === true ? null : recordNotifications(record);
    const report = notification?.exploration || {};
    const base = latestBase(record);
    const resources = record.owned === true ? latestResources(record) : {};
    const knownBuildingsData = knownBuildings(record, notification);
    if (columnKey.startsWith('inventory:')) {
      const spec = inventorySpec();
      const itemKey = columnKey.slice('inventory:'.length);
      const items = spec ? valueFor(record, spec.dataKey) : null;
      if (!Array.isArray(items)) return -1;
      const item = items.find(candidate => inventoryItemKey(spec, candidate) === itemKey);
      return item ? inventoryQuantity(spec, item) : 0;
    }
    switch (columnKey) {
      case 'number': return 0;
      case 'coordinates': return displayCoords(record.system, record.position) || '';
      case 'name': return record.name || notification?.name || '';
      case 'explorationAt': return record.owned === true ? '' : (explorationAttemptAt(notification) || '');
      case 'sizeUsed': {
        const used = record.owned === true ? (base.buildable_space_used ?? base.building_space_used ?? base.used_buildable_space) : (report.buildable_space_used ?? report.building_space_used ?? report.used_buildable_space);
        const total = record.owned === true ? (base.buildable_space ?? base.building_space ?? base.buildable_space_total) : (report.buildable_space ?? report.building_space ?? report.buildable_space_total);
        return used == null || total == null || number(total) <= 0 ? -1 : number(used) / number(total) * 100;
      }
      case 'sizeTotal': return number(record.owned === true ? (base.buildable_space ?? base.building_space ?? base.buildable_space_total) : (report.buildable_space ?? report.building_space ?? report.buildable_space_total)) || -1;
      case 'status': return currentOccupancy(record, notification).value;
      case 'features': return recordFeatures(record, notification).join(',');
      case 'buildings': return knownBuildingsData.known ? knownBuildingsData.items.length : -1;
      case 'knownFleet': return knownShips(record, notification).known ? sumShips(knownShips(record, notification).items) : -1;
      case 'knownDefense': return knownDefenses(record, notification).known ? knownDefenses(record, notification).items.reduce((sum, item) => sum + number(item.quantity), 0) : -1;
      case 'exploredMetal': return report.resources?.metal == null ? -1 : number(report.resources.metal);
      case 'exploredSilicon': return report.resources?.silicon == null ? -1 : number(report.resources.silicon);
      case 'exploredHelium': return report.resources?.helium == null ? -1 : number(report.resources.helium);
      case 'debrisMetal': return report.debris?.metal == null ? -1 : number(report.debris.metal);
      case 'debrisSilicon': return report.debris?.silicon == null ? -1 : number(report.debris.silicon);
      case 'exploredSurvivors': return currentOccupancy(record, notification).value === 'Occupied' ? -1 : (report.population == null && report.automatons == null ? -1 : number(report.population) + number(report.automatons));
      case 'resources': return resources.metal == null && resources.silicon == null && resources.helium == null ? -1 : number(resources.metal) + number(resources.silicon) + number(resources.helium);
      case 'production': return number(resources.rate_metal_per_hour) + number(resources.rate_silicon_per_hour) + number(resources.rate_helium_per_hour);
      case 'storage': return resources.capacity_metal == null && resources.capacity_silicon == null && resources.capacity_helium == null ? -1 : Math.max(...['metal', 'silicon', 'helium'].map(key => resources[`capacity_${key}`] > 0 ? number(resources[key]) / number(resources[`capacity_${key}`]) : 0));
      case 'capacity': return number(base.population) + number(base.automatons) + number(base.energy);
      case 'ships': return sumShips(valueFor(record, 'ships'));
      case 'defenses': return (Array.isArray(valueFor(record, 'defenses')) ? valueFor(record, 'defenses') : []).reduce((total, item) => total + number(item.quantity), 0);
      case 'queues': return ['buildQueue', 'researchQueue', 'shipQueue', 'defenseQueue'].reduce((total, key) => total + (Array.isArray(valueFor(record, key)) ? valueFor(record, key).length : 0), 0);
      default: return '';
    }
  }
  function matchingRecords() {
    sidebarPlanets(false);
    lastOpenedOwnedPlanetId();
    if (state.recordsNeedCanonicalize) canonicalizeRecords();
    const query = state.search.trim().toLowerCase();
    const unique = new Map();
    for (const record of state.records.values()) {
      if (state.view === 'owned' && record.owned !== true) continue;
      if (state.view === 'explored' && (record.owned === true || isTradeGuildPlanetName(record.name) || !recordNotifications(record))) continue;
      if (!matchesFilters(record)) continue;
      if (query && ![record.name, record.planetId, record.system, record.position, displayCoords(record.system, record.position)].some(value => String(value ?? '').toLowerCase().includes(query))) continue;
      const identity = record.planetId != null
        ? `planet:${Number(record.planetId)}`
        : coords(record.galaxy, record.system, record.position) || record.key;
      const existing = unique.get(identity);
      unique.set(identity, existing ? mergeRecords(existing, record) : record);
    }
    const records = [...unique.values()];
    const sortValues = new Map(records.map(record => [record.key, columnSortValue(record, state.sort)]));
    const currentPlanetId = state.view === 'owned' && !state.sortActivated ? state.lastOpenedPlanetId : null;
    return records.sort((a, b) => {
      const aIsCurrent = currentPlanetId != null && Number(a.planetId) === currentPlanetId;
      const bIsCurrent = currentPlanetId != null && Number(b.planetId) === currentPlanetId;
      if (aIsCurrent !== bIsCurrent) return aIsCurrent ? -1 : 1;
      const left = sortValues.get(a.key), right = sortValues.get(b.key);
      return (left < right ? -1 : left > right ? 1 : 0) * state.sortDirection;
    });
  }
  function columnWidthWeight(key) {
    return {
      number: 42, name: 150, coordinates: 92, sizeUsed: 74, sizeTotal: 70,
      status: 96, features: 96, resources: 124, production: 124, storage: 78,
      capacity: 180, buildings: 78, knownFleet: 78, knownDefense: 88, ships: 70, defenses: 78,
      exploredMetal: 78, exploredSilicon: 78, exploredHelium: 78,
      debrisMetal: 78, debrisSilicon: 78,
      exploredSurvivors: 96,
      queues: 92,
    }[key] || (key.startsWith('inventory:') ? 88 : 100);
  }
  function applyColumnWidths(table, viewColumns) {
    table.querySelector('colgroup')?.remove();
    const group = document.createElement('colgroup');
    viewColumns.forEach(([, key]) => {
      const col = document.createElement('col'); col.style.width = `${columnWidthWeight(key)}px`; group.appendChild(col);
    });
    table.prepend(group);
  }
  function updateRefreshProgressUi() {
    if (!state.panel) return;
    const progressWrap = state.panel.querySelector('.fa-summary-progress');
    if (!progressWrap) return;
    const progress = progressWrap.querySelector('.fa-summary-progress-bar');
    const progressLabel = progressWrap.querySelector('.fa-summary-progress-label');
    if (!progress || !progressLabel) return;
    const { completed, total, endpointCompleted, endpointTotal, current } = state.refreshProgress;
    const fraction = total ? Math.min(1, (completed + endpointCompleted / Math.max(1, endpointTotal)) / total) : 0;
    progressWrap.hidden = state.view !== 'owned' || !state.refreshingAll;
    progress.value = fraction;
    progressLabel.textContent = `${completed}/${total} planets${current ? ` · ${current}` : ''}`;
    progressWrap.title = current ? `Updating ${current}` : 'Updating owned planets';
  }
  function notificationSyncDisplay() {
    const sync = state.notificationSync || { state: 'idle' };
    const status = ['scheduled', 'syncing', 'complete', 'error'].includes(sync.state) ? sync.state : 'idle';
    if (status === 'scheduled') return { status, text: 'Notifications: scheduled', title: 'Notification synchronization is queued.' };
    if (status === 'syncing') {
      const progress = sync.total > 0 ? ` ${Math.min(sync.offset || 0, sync.total)}/${sync.total}` : '…';
      return { status, text: `Notifications: syncing${progress}`, title: 'Notification history is being synchronized in the background.' };
    }
    if (status === 'complete') return { status, text: `Notifications: synced${sync.cached != null ? ` · ${sync.cached} cached` : ''}`, title: 'Notification cache is synchronized.' };
    if (status === 'error') return { status, text: 'Notifications: sync error', title: sync.error || 'Notification synchronization failed.' };
    return { status, text: 'Notifications: idle', title: 'Notification synchronization is idle.' };
  }

  function renderTable() {
    if (!state.panel) return;
    const tableWrap = state.panel.querySelector('.fa-summary-table-wrap');
    const viewKey = `${state.view}:${state.ownedSubview}`;
    const viewChanged = state.renderedView !== viewKey;
    const tbody = state.panel.querySelector('.fa-summary-body');
    if (!tbody) return;
    tbody.replaceChildren();
    const allRecords = matchingRecords();
    const paginationEnabled = state.view !== 'owned' || allRecords.length >= 100;
    const effectivePageSize = paginationEnabled ? (state.view === 'explored' ? 25 : state.pageSize) : Math.max(1, allRecords.length);
    const pageCount = Math.max(1, Math.ceil(allRecords.length / effectivePageSize));
    state.page = paginationEnabled ? Math.min(state.page, pageCount - 1) : 0;
    const start = state.page * effectivePageSize;
    const records = allRecords.slice(start, start + effectivePageSize);
    const viewColumns = columnsForView();
    const table = state.panel.querySelector('.fa-summary-table');
    if (table) applyColumnWidths(table, viewColumns);
    const colspan = viewColumns.length;
    records.forEach((record, index) => {
      tbody.appendChild(makeRow(record, start + index + 1));
      if (state.view !== 'owned' && state.expanded.has(record.key)) tbody.appendChild(renderDetails(record, colspan));
    });
    const updateAll = state.panel.querySelector('.fa-summary-update-all');
    const progressWrap = state.panel.querySelector('.fa-summary-progress');
    const status = state.panel.querySelector('.fa-summary-status');
    if (status) {
      const shown = allRecords.length ? `${start + 1}–${Math.min(start + effectivePageSize, allRecords.length)}` : '0';
      const rangeText = pageCount > 1 ? ` · showing ${shown}` : '';
      const statusText = `${allRecords.length} ${state.view === 'owned' ? 'owned' : 'explored'} planet${allRecords.length === 1 ? '' : 's'}${rangeText}${state.lastError ? `\n${state.lastError}` : ''}`;
      status.replaceChildren();
      const statusLabel = document.createElement('span'); statusLabel.className = 'fa-summary-status-text'; statusLabel.textContent = statusText; status.appendChild(statusLabel);
      if (updateAll) status.appendChild(updateAll);
      if (progressWrap) status.appendChild(progressWrap);
      const syncDisplay = notificationSyncDisplay();
      const syncBadge = document.createElement('span');
      syncBadge.className = `fa-summary-sync-state fa-summary-sync-${syncDisplay.status}`;
      syncBadge.textContent = syncDisplay.text;
      syncBadge.title = syncDisplay.title;
      status.appendChild(syncBadge);
    }
    if (updateAll) {
      const bulkInProgress = state.refreshingAll;
      const anotherUpdateInProgress = state.refreshing.size > 0;
      updateAll.hidden = state.view !== 'owned';
      updateAll.disabled = bulkInProgress || anotherUpdateInProgress;
      updateAll.textContent = bulkInProgress ? 'Refreshing…' : 'Refresh all colonies';
      updateAll.title = bulkInProgress ? 'Refreshing owned colonies…' : anotherUpdateInProgress ? 'Wait for the current colony refresh to finish' : 'Refresh all owned colonies one by one';
      updateAll.setAttribute('aria-busy', String(bulkInProgress));
    }
    updateRefreshProgressUi();
    const pageControl = state.panel.querySelector('.fa-summary-page');
    const pageLabel = state.panel.querySelector('.fa-summary-page-label');
    const previous = state.panel.querySelector('.fa-summary-page-prev');
    const next = state.panel.querySelector('.fa-summary-page-next');
    if (pageControl) pageControl.hidden = !paginationEnabled || pageCount <= 1;
    if (pageLabel) pageLabel.textContent = `Page ${state.page + 1} / ${pageCount}`;
    if (previous) previous.disabled = state.page === 0;
    if (next) next.disabled = state.page >= pageCount - 1;
    const headerRow = state.panel.querySelector('.fa-summary-table thead tr');
    if (headerRow) {
      headerRow.replaceChildren();
      document.querySelectorAll('.fa-summary-filter-menu').forEach(menu => menu.remove());
      const descriptions = {
        exploration: 'Historical exploration notifications for this planet.',
        scan: 'Historical planet-scan notifications.',
        attack: 'Historical incoming-attack notifications.',
        battle: 'Historical battle reports involving this planet.',
        transport: 'Historical transport notifications.',
        harvest: 'Historical debris-harvest notifications.',
        relocation: 'Historical fleet-relocation notifications.',
        recovery: 'Historical population/automaton recovery notifications.',
        trade: 'Historical trade notifications.',
      };
      viewColumns.forEach(([label, columnKey]) => {
        const th = document.createElement('th'); th.dataset.sort = columnKey; th.dataset.label = label; th.title = descriptions[columnKey] || label;
        if (columnKey.startsWith('inventory:')) th.classList.add('fa-summary-inventory-header');
        if (columnKey === 'name') th.classList.add('fa-summary-planet-sticky');
        const sortableKey = columnKey === 'number' ? null : columnKey;
        const head = document.createElement('span'); head.className = 'fa-summary-filter-head';
        const labelText = document.createElement('span'); labelText.textContent = label; head.appendChild(labelText);
        const indicator = document.createElement('span'); indicator.className = 'fa-summary-sort-indicator'; indicator.setAttribute('aria-hidden', 'true'); indicator.textContent = sortableKey === state.sort ? (state.sortDirection === 1 ? '↑' : '↓') : ''; head.appendChild(indicator); th.appendChild(head);
        if (sortableKey) { th.classList.add('fa-summary-sortable'); th.setAttribute('aria-sort', sortableKey === state.sort ? (state.sortDirection === 1 ? 'ascending' : 'descending') : 'none'); th.addEventListener('click', () => { state.sortActivated = true; if (state.sort === sortableKey) state.sortDirection *= -1; else { state.sort = sortableKey; state.sortDirection = 1; } renderTable(); }); }
        headerRow.appendChild(th);
        addFilterMenu(th, columnKey);
      });
    }
    state.panel.querySelectorAll('.fa-summary-main-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === state.view));
    const subTabs = state.panel.querySelector('.fa-summary-subtabs');
    if (subTabs) {
      subTabs.hidden = state.view !== 'owned';
      subTabs.setAttribute('aria-hidden', String(state.view !== 'owned'));
      subTabs.querySelectorAll('.fa-summary-subtab').forEach(tab => {
        const active = state.view === 'owned' && tab.dataset.subview === state.ownedSubview;
        tab.classList.toggle('active', active);
        tab.setAttribute('aria-selected', String(active));
      });
    }
    if (viewChanged && tableWrap) { tableWrap.scrollLeft = 0; tableWrap.scrollTop = 0; }
    state.renderedView = viewKey;
  }
  const FILTER_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 .8 1.6L15 13.333V19a1 1 0 0 1-.553.894l-4 2A1 1 0 0 1 9 19v-5.667L3.2 5.6A1 1 0 0 1 3 5Z"/></svg>';
  function filterOptions(columnKey) {
    if (columnKey === 'status') return state.view === 'explored'
      ? [['Occupied', 'Occupied'], ['Unoccupied', 'Unoccupied']]
      : [['Owned', 'Owned'], ['Occupied', 'Occupied'], ['Unoccupied', 'Unoccupied']];
    if (columnKey === 'features') return [['relic', 'Relic'], ['stellar', 'Stellar'], ['both', 'Both relic + stellar'], ['none', 'None']];
    return [];
  }
  function filterSetFor(columnKey) { return columnKey === 'status' ? state.statusFilters : state.featureFilters; }
  function closeFilterMenus() {
    state.openFilterColumn = null;
    document.querySelectorAll('.fa-summary-filter-menu').forEach(menu => { menu.hidden = true; menu.classList.remove('fa-summary-filter-positioned'); });
    document.querySelectorAll('.fa-summary-filter-button').forEach(button => { button.setAttribute('aria-expanded', 'false'); });
  }
  function installFilterOutsideListener() {
    if (state.filterOutsideListenerInstalled) return;
    state.filterOutsideListenerInstalled = true;
    document.addEventListener('click', event => {
      if (event.target.closest('.fa-summary-filter-button, .fa-summary-filter-menu')) return;
      closeFilterMenus();
    });

  }
  function positionFilterMenu(menu, button) {
    const rect = button.getBoundingClientRect();
    const width = menu.offsetWidth || 160;
    const height = menu.offsetHeight || 160;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const top = rect.bottom + height <= window.innerHeight - 8 ? rect.bottom : Math.max(8, rect.top - height);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.classList.add('fa-summary-filter-positioned');
  }
  function addFilterMenu(th, columnKey) {
    const options = filterOptions(columnKey);
    if (!options.length) return;
    th.style.position = 'relative';
    th.classList.add('fa-summary-has-filter');
    const head = th.querySelector('.fa-summary-filter-head');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'fa-summary-filter-button'; button.innerHTML = FILTER_ICON; button.title = `Filter ${th.dataset.label}`; button.setAttribute('aria-label', `Filter ${th.dataset.label}`); button.setAttribute('aria-expanded', 'false');
    const menu = document.createElement('div'); menu.className = 'fa-summary-filter-menu'; menu.hidden = state.openFilterColumn !== columnKey; menu.tabIndex = -1; menu.setAttribute('role', 'group'); menu.setAttribute('aria-label', `${th.dataset.label} filters`);
    const selected = filterSetFor(columnKey);
    const sync = () => { button.classList.toggle('fa-summary-filter-active', selected.size > 0); button.setAttribute('aria-expanded', String(!menu.hidden)); };
    options.forEach(([value, text]) => {
      const option = document.createElement('label'); option.className = 'fa-summary-filter-option';
      const input = document.createElement('input'); input.type = 'checkbox'; input.value = value; input.checked = selected.has(value);
      input.addEventListener('change', () => { input.checked ? selected.add(value) : selected.delete(value); state.page = 0; state.openFilterColumn = columnKey; setTimeout(renderTable, 0); });
      option.append(input, document.createTextNode(text)); menu.appendChild(option);
    });
    button.addEventListener('click', event => { event.stopPropagation(); const opening = menu.hidden; closeFilterMenus(); state.openFilterColumn = opening ? columnKey : null; menu.hidden = !opening; if (!menu.hidden) requestAnimationFrame(() => { positionFilterMenu(menu, button); menu.focus(); }); sync(); });
    menu.addEventListener('click', event => event.stopPropagation());
    head.appendChild(button);
    document.body.appendChild(menu);
    if (!menu.hidden) requestAnimationFrame(() => { positionFilterMenu(menu, button); menu.focus(); });
    sync();
  }
  function scheduleRender() { if (!state.panel || state.refreshingAll || state.renderTimer) return; state.renderTimer = setTimeout(() => { state.renderTimer = null; renderTable(); }, 80); }
  function openPanel() {
    if (!state.panel) return;
    state.panel.classList.remove('hidden');
    state.renderedView = null;
    loadNotifications();
    renderTable();
  }
  function closePanel() { state.panel?.classList.add('hidden'); }

  async function refreshPlanet(record, allowBulk = false) {
    if (!record.planetId || !window.req || state.refreshing.has(record.planetId) || (state.refreshingAll && !allowBulk)) return [];
    const id = record.planetId;
    state.refreshing.add(id); state.lastError = '';
    if (!allowBulk) renderTable();
    const errors = [];
    try {
      for (let endpointIndex = 0; endpointIndex < REFRESH_ENDPOINTS.length; endpointIndex += 1) {
        const path = REFRESH_ENDPOINTS[endpointIndex](id);
        try {
          const result = statusBody(await window.req('GET', path));
          if (result.status < 200 || result.status >= 300) throw new Error(`HTTP ${result.status}`);
          await applyApiResponse(endpointUrl(`/api${path}`), result.status, result.body);
        } catch (error) { errors.push(`${path}: ${error.message}`); }
        if (allowBulk) {
          state.refreshProgress.endpointCompleted = endpointIndex + 1;
          updateRefreshProgressUi();
        }
        await new Promise(resolve => setTimeout(resolve, REFRESH_ENDPOINT_DELAY));
      }
    } finally {
      state.refreshing.delete(id);
      if (errors.length) state.lastError = errors.join('\n');
      if (!allowBulk) renderTable();
    }
    return errors;
  }

  async function manualRefresh(record) {
    await refreshPlanet(record);
  }

  async function refreshAllOwned() {
    if (state.refreshingAll || state.refreshing.size > 0 || !window.req) return;
    const records = sidebarPlanets().filter(record => record.owned === true && record.planetId != null);
    if (!records.length) return;
    if (state.renderTimer) { clearTimeout(state.renderTimer); state.renderTimer = null; }
    state.refreshingAll = true;
    state.refreshProgress = { completed: 0, total: records.length, endpointCompleted: 0, endpointTotal: REFRESH_ENDPOINTS.length, current: '' };
    state.lastError = '';
    renderTable();
    const errors = [];
    try {
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        state.refreshProgress.current = record.name || `Planet ${record.system ?? '—'}-${record.position ?? '—'}`;
        state.refreshProgress.endpointCompleted = 0;
        updateRefreshProgressUi();
        errors.push(...await refreshPlanet(record, true));
        state.refreshProgress.completed = index + 1;
        state.refreshProgress.endpointCompleted = 0;
        updateRefreshProgressUi();
        if (index < records.length - 1) await new Promise(resolve => setTimeout(resolve, REFRESH_PLANET_DELAY));
      }
    } finally {
      state.refreshingAll = false;
      state.refreshProgress.current = '';
      if (errors.length) state.lastError = errors.join('\n');
      renderTable();
    }
  }

  function ensurePanel() {
    if (!document.body) return;
    if (!state.panel) {
      const overlay = document.createElement('div'); overlay.className = 'fa-summary-overlay hidden';
      const dialog = document.createElement('div'); dialog.className = 'fa-summary-dialog';
      const header = document.createElement('div'); header.className = 'fa-summary-header';
      const title = document.createElement('h2'); title.textContent = 'Universe overview';
      const close = document.createElement('button'); close.className = 'fa-summary-close'; close.type = 'button'; close.textContent = '×'; close.title = 'Close'; close.addEventListener('click', closePanel);
      header.append(title, close);
      const controls = document.createElement('div'); controls.className = 'fa-summary-controls';
      const tabs = document.createElement('div'); tabs.className = 'fa-summary-tabs'; tabs.setAttribute('role', 'tablist');
      [['owned', 'My colonies'], ['explored', 'Explored planets']].forEach(([view, label]) => {
        const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'fa-summary-tab fa-summary-main-tab'; tab.dataset.view = view; tab.textContent = label; tab.setAttribute('role', 'tab');
        tab.addEventListener('click', () => {
          state.view = view; state.page = 0; state.statusFilters.clear(); state.featureFilters.clear(); state.search = ''; state.expanded.clear(); closeFilterMenus();
          if (state.searchTimer) { clearTimeout(state.searchTimer); state.searchTimer = null; }
          search.value = ''; syncSearchClear();
          state.sort = view === 'explored' ? 'explorationAt' : 'name';
          state.sortDirection = view === 'explored' ? -1 : 1;
          state.sortActivated = false;
          renderTable();
        }); tabs.appendChild(tab);
      });
      const subTabs = document.createElement('div'); subTabs.className = 'fa-summary-tabs fa-summary-subtabs'; subTabs.setAttribute('role', 'tablist'); subTabs.setAttribute('aria-label', 'My colony views');
      OWNED_SUBVIEWS.forEach(([subview, label]) => {
        const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'fa-summary-tab fa-summary-subtab'; tab.dataset.subview = subview; tab.textContent = label; tab.setAttribute('role', 'tab');
        tab.addEventListener('click', () => {
          state.view = 'owned'; state.ownedSubview = subview; state.page = 0; state.statusFilters.clear(); state.featureFilters.clear(); state.expanded.clear(); closeFilterMenus();
          state.sort = 'name'; state.sortDirection = 1; state.sortActivated = false;
          renderTable();
        }); subTabs.appendChild(tab);
      });
      const searchWrap = document.createElement('div'); searchWrap.className = 'fa-summary-search';
      const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search planet or coordinates…';
      const clearSearch = document.createElement('button'); clearSearch.type = 'button'; clearSearch.className = 'fa-summary-search-clear'; clearSearch.textContent = '×'; clearSearch.setAttribute('aria-label', 'Clear search');
      const syncSearchClear = () => { clearSearch.hidden = !search.value; };
      search.addEventListener('input', () => {
        state.search = search.value; state.page = 0; syncSearchClear();
        if (state.searchTimer) clearTimeout(state.searchTimer);
        state.searchTimer = setTimeout(() => { state.searchTimer = null; renderTable(); }, 180);
      });
      clearSearch.addEventListener('click', () => {
        search.value = ''; state.search = ''; state.page = 0; syncSearchClear();
        if (state.searchTimer) { clearTimeout(state.searchTimer); state.searchTimer = null; }
        search.focus(); renderTable();
      });
      searchWrap.append(search, clearSearch);
      syncSearchClear();
      const page = document.createElement('span'); page.className = 'fa-summary-page';
      const previous = document.createElement('button'); previous.type = 'button'; previous.className = 'fa-summary-page-prev'; previous.textContent = '←'; previous.title = 'Previous page'; previous.addEventListener('click', () => { state.page = Math.max(0, state.page - 1); renderTable(); });
      const pageLabel = document.createElement('span'); pageLabel.className = 'fa-summary-page-label';
      const next = document.createElement('button'); next.type = 'button'; next.className = 'fa-summary-page-next'; next.textContent = '→'; next.title = 'Next page'; next.addEventListener('click', () => { state.page += 1; renderTable(); });
      page.append(previous, pageLabel, next);
      const updateAll = document.createElement('button'); updateAll.type = 'button'; updateAll.className = 'fa-summary-update-all'; updateAll.textContent = 'Refresh all colonies'; updateAll.title = 'Refresh all owned colonies one by one'; updateAll.addEventListener('click', refreshAllOwned);
      const progressWrap = document.createElement('div'); progressWrap.className = 'fa-summary-progress'; progressWrap.hidden = true;
      const progressBar = document.createElement('progress'); progressBar.className = 'fa-summary-progress-bar'; progressBar.max = 1; progressBar.value = 0; progressBar.setAttribute('aria-label', 'Planet update progress');
      const progressLabel = document.createElement('span'); progressLabel.className = 'fa-summary-progress-label';
      progressWrap.append(progressBar, progressLabel);
      const toolbar = document.createElement('div'); toolbar.className = 'fa-summary-toolbar';
      toolbar.append(searchWrap, page);
      const status = document.createElement('div'); status.className = 'fa-summary-status';
      status.append(updateAll, progressWrap);
      controls.append(tabs, subTabs, toolbar, status);
      const wrap = document.createElement('div'); wrap.className = 'fa-summary-table-wrap';
      const table = document.createElement('table'); table.className = 'fa-summary-table';
      const thead = document.createElement('thead'); const tr = document.createElement('tr'); thead.appendChild(tr);
      const tbody = document.createElement('tbody'); tbody.className = 'fa-summary-body'; table.append(thead, tbody); wrap.appendChild(table); dialog.append(header, controls, wrap); overlay.appendChild(dialog); overlay.addEventListener('click', event => { if (event.target === overlay) closePanel(); }); document.body.appendChild(overlay); state.panel = overlay;
    }
    installFilterOutsideListener();
    const title = document.querySelector('#planet-sidebar .planet-sidebar-title');
    if (title && !title.querySelector('.fa-summary-sidebar-btn')) { const button = document.createElement('button'); button.type = 'button'; button.className = 'fa-summary-sidebar-btn'; button.textContent = 'Overview'; button.addEventListener('click', openPanel); title.appendChild(button); }
  }

  function observeDom() {
    ensurePanel();
    const records = sidebarPlanets();
    const signature = records.map(record => [
      record.planetId,
      record.name || '',
      record.system ?? '',
      record.position ?? '',
    ].join(':')).join('|');
    if (signature !== state.sidebarSignature) {
      state.sidebarSignature = signature;
      records.forEach(saveRecord);
    }
    scheduleRender();
  }

  function scheduleSidebarSync() {
    if (state.sidebarSyncTimer) return;
    state.sidebarSyncTimer = setTimeout(() => {
      state.sidebarSyncTimer = null;
      observeDom();
    }, 100);
  }
  function handleNotificationSyncState(detail) {
    if (!detail || typeof detail !== 'object') return;
    state.notificationSync = { ...detail };
    scheduleRender();
  }
  state.notificationSync = window.__faNotificationCacheService?.getSyncState?.() || { state: 'idle' };
  window.addEventListener(NOTIFICATION_SYNC_STATE_EVENT, event => handleNotificationSyncState(event.detail));
  window.addEventListener('fa-notifications-updated', () => loadNotifications());
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      const notificationChannel = new BroadcastChannel('fa.notifications');
      notificationChannel.addEventListener('message', event => {
        if (event.data && event.data.type === 'fa-notifications-updated') loadNotifications();
        if (event.data && event.data.type === NOTIFICATION_SYNC_STATE_EVENT) handleNotificationSyncState(event.data.detail);
      });
    } catch (_) {}
  }

  function start() {
    loadOwnData();
    loadNotifications();
    ensurePanel();
    let sidebarObserver = null;
    const attachSidebarObserver = () => {
      const sidebar = document.querySelector('#sidebar-planets');
      if (!sidebar) return false;
      if (sidebarObserver) sidebarObserver.disconnect();
      sidebarObserver = new MutationObserver(() => {
        ensurePanel();
        scheduleSidebarSync();
      });
      sidebarObserver.observe(sidebar, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
      return true;
    };
    // Observe only the owned-planet sidebar. Watching the whole body caused
    // unrelated game widgets (including resource formatting) to be repeatedly
    // reprocessed by this companion script.
    if (!attachSidebarObserver() && document.body) {
      const bootstrapObserver = new MutationObserver(() => {
        if (attachSidebarObserver()) bootstrapObserver.disconnect();
      });
      bootstrapObserver.observe(document.body, { childList: true, subtree: true });
    }
    window.addEventListener('fa-target-system-markers-changed', loadNotifications);
    observeDom();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
