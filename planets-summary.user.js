// ==UserScript==
// @name         Fonte Antiga - Universe Overview
// @namespace    fa.planets-summary
// @version      1.23.0
// @description  Locally summarize observed planets, queues, buildings, active fleets, and notification intelligence
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
    notificationIndex: new Map(),
    notificationsLoaded: false,
    panel: null,
    expanded: new Set(),
    search: '',
    view: 'owned',
    page: 0,
    pageSize: 20,
    sort: 'coordinates',
    sortDirection: 1,
    refreshing: new Set(),
    lastError: '',
    renderTimer: null,
    persistChain: Promise.resolve(),
  };

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
    .fa-summary-tabs { display: flex; gap: .25rem; width: 100%; }
    .fa-summary-tab.active { color: var(--fg); border-color: var(--accent); background: var(--panel); }
    .fa-summary-toolbar { display: flex; align-items: center; gap: .5rem; width: 100%; }
    .fa-summary-search { position: relative; flex: 0 1 22rem; width: 22rem; max-width: 32vw; }
    .fa-summary-search input { width: 100%; min-width: 0; padding-right: 2rem; box-sizing: border-box; }
    .fa-summary-search-clear { position: absolute; top: 50%; right: .25rem; display: block; width: 1.5rem; min-width: 0; height: 1.5rem; margin: 0; padding: 0; transform: translateY(-50%); appearance: none; border: 0 !important; border-radius: .2rem; background: transparent !important; color: var(--muted) !important; font: inherit; font-size: 1rem; line-height: 1.3; cursor: pointer; }
    .fa-summary-search-clear:hover, .fa-summary-search-clear:focus-visible { background: var(--panel-alt) !important; color: var(--fg) !important; }
    .fa-summary-search-clear[hidden] { display: none !important; }
    .fa-summary-sort-indicator { display: inline-block; width: 1em; margin-left: .25rem; color: var(--accent); font-size: .85em; }
    .fa-summary-page { display: inline-flex; align-items: center; gap: .35rem; white-space: nowrap; }
    @media (max-width: 900px) {
      .fa-summary-toolbar { flex-wrap: wrap; }
      .fa-summary-search { flex: 1 1 14rem; width: auto; max-width: none; }
    }

    .fa-summary-page-label { min-width: 6rem; text-align: center; color: var(--muted); font-size: .78rem; }
    .fa-summary-status { flex: 1 1 100%; min-height: 1.1em; font-size: .78rem; white-space: pre-line; }
    .fa-summary-table-wrap { overflow: auto; }
    .fa-summary-table { width: 100%; min-width: 1380px; border-collapse: collapse; font-size: .78rem; }
    .fa-summary-table th, .fa-summary-table td { padding: .45rem .5rem; vertical-align: top; border-bottom: 1px solid var(--border-soft); text-align: left; }
    .fa-summary-table tbody td { position: relative; min-height: 2.8rem; padding-bottom: 1.65rem; }
    .fa-summary-table thead { position: sticky; top: -1px; z-index: 5; }
    .fa-summary-table th { color: var(--muted); background: var(--bg, #0a0d13); white-space: nowrap; cursor: default; }
    .fa-summary-table th.fa-summary-sortable { cursor: pointer; }
    .fa-summary-table tbody tr { background: var(--bg, #0a0d13); }
    .fa-summary-table tbody tr:hover { background: var(--panel-alt); }
    .fa-summary-table tbody tr.fa-summary-data-row { cursor: pointer; }
    .fa-summary-table tbody tr.fa-summary-data-row.fa-summary-row-expanded { background: var(--panel-alt); }
    .fa-summary-table .fa-summary-name { font-weight: 600; white-space: nowrap; }
    .fa-summary-number { width: 2.5rem; color: var(--muted); text-align: right !important; }
    .fa-summary-time { position: absolute; right: .45rem; bottom: .25rem; z-index: 0; display: block; width: max-content; max-width: calc(100% - .9rem); margin: 0; padding: .08rem .28rem; border: 1px solid var(--border-soft); border-radius: .2rem; background: var(--panel-alt); color: var(--muted); font-size: .68rem; line-height: 1.2; white-space: nowrap; }
    .fa-summary-sub { display: block; margin-top: .15rem; color: var(--muted); font-size: .72rem; white-space: nowrap; }
    .fa-summary-stale { color: var(--muted); }
    .fa-summary-warn { color: #ffcc66; }
    .fa-summary-good { color: #9be37a; }
    .fa-summary-bad { color: #ff8d8d; }
    .fa-summary-na { color: var(--muted); }
    .fa-summary-actions { white-space: nowrap; }
    .fa-summary-actions button { margin: 0 .15rem .15rem 0; }
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
  function fmt(value) { return number(value).toLocaleString(); }
  function fmtMaybe(value) { return value == null || value === '' ? '—' : fmt(value); }
  function escapeText(value) { return value == null || value === '' ? '—' : String(value); }
  function age(timestamp) {
    if (!timestamp) return '—';
    const seconds = Math.max(0, Math.floor((now() - new Date(timestamp).getTime()) / 1000));
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;
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
  function cell(primary, secondary, className = '', observedAt) {
    const td = document.createElement('td');
    const main = document.createElement('div'); main.textContent = escapeText(primary); td.appendChild(main);
    if (secondary) { const sub = document.createElement('span'); sub.className = `fa-summary-sub ${className}`; sub.textContent = secondary; td.appendChild(sub); }
    appendTimestamp(td, observedAt);
    return td;
  }
  function stackedCell(lines, observedAt, className = '') {
    const td = document.createElement('td');
    lines.forEach(line => { const div = document.createElement('div'); div.className = className; div.textContent = escapeText(line); td.appendChild(div); });
    appendTimestamp(td, observedAt);
    return td;
  }
  function appendTimestamp(td, observedAt) {
    if (observedAt === undefined) return;
    const time = document.createElement('span'); time.className = 'fa-summary-time'; time.textContent = observedAt ? ageShort(observedAt) : '—';
    time.title = observedAt ? `Observed/reported ${new Date(observedAt).toLocaleString()}` : 'Not observed';
    td.appendChild(time);
  }
  function iso(value) {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  function coords(galaxy, system, position) {
    const g = Number(galaxy), s = Number(system), p = Number(position);
    return [g, s, p].every(Number.isSafeInteger) ? `${g}:${s}:${p}` : null;
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
    for (const source of state.records.values()) {
      const record = { ...source, observed: { ...(source.observed || {}) } };
      if (record.owned === true && !validGalaxy(record.galaxy)) record.galaxy = 1;
      if (record.galaxy != null && !validGalaxy(record.galaxy)) record.galaxy = null;
      const recordId = record.planetId == null ? null : Number(record.planetId);
      const recordCoords = coords(record.galaxy, record.system, record.position);
      const existing = groups.find(group => (recordId != null && group.planetId === recordId) || (recordCoords && group.coords === recordCoords));
      if (existing) {
        existing.record = mergeRecords(existing.record, record);
        existing.planetId = existing.record.planetId == null ? existing.planetId : Number(existing.record.planetId);
        existing.coords = coords(existing.record.galaxy, existing.record.system, existing.record.position) || existing.coords;
      } else {
        groups.push({ record, planetId: recordId, coords: recordCoords });
      }
    }
    state.records.clear();
    for (const group of groups) {
      const record = group.record;
      record.key = record.planetId != null ? `planet:${Number(record.planetId)}` : group.coords || record.key;
      state.records.set(record.key, record);
    }
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
          return state.records.get(desired);
        }
        state.records.delete(existing.key);
        existing.key = desired;
        state.records.set(desired, existing);
      }
      return existing;
    }
    const record = blankRecord(data);
    state.records.set(record.key, record);
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
    if (parsed.pathname === '/api/fleets' && parsed.searchParams.get('active') === 'true') {
      return { kind: 'fleets', category: 'activeFleets', endpoint: parsed.pathname + parsed.search };
    }
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
  async function applyActiveFleetResponse(url, body, observedAt) {
    const fleets = Array.isArray(body) ? body : [];
    const byOrigin = new Map();
    fleets.forEach(fleet => {
      const originId = Number(fleet?.origin_planet_id);
      if (!Number.isSafeInteger(originId)) return;
      if (!byOrigin.has(originId)) byOrigin.set(originId, []);
      byOrigin.get(originId).push(fleet);
    });

    // The response is account-wide. Keep it only on the owned origin planet,
    // never on an explored destination whose private fleet data is unknown.
    for (const originId of byOrigin.keys()) getOrCreateRecord({ planetId: originId, owned: true });
    const ownedRecords = [...state.records.values()].filter(record => record.owned === true && record.planetId != null);
    await Promise.all(ownedRecords.map(record => {
      const fleetsForPlanet = byOrigin.get(Number(record.planetId)) || [];
      touchRecord(record, 'activeFleets', fleetsForPlanet, url, observedAt);
      return saveRecord(record);
    }));
    scheduleRender();
  }
  async function applyApiResponse(url, status, body, observedAt = new Date().toISOString()) {
    const info = apiInfo(url);
    if (!info || status < 200 || status >= 300 || body == null) return;
    if (info.kind === 'fleets') {
      await applyActiveFleetResponse(url, body, observedAt);
      return;
    }
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

  function sidebarPlanets() {
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
      canonicalizeRecords();
    }
    return result;
  }
  function notificationType(notification) {
    const value = String(notification?.notification_type || '').toLowerCase();
    if (value === 'exploration' || value === 'exploration_lost') return 'exploration';
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
  function addNotification(index, notification) {
    const type = notificationType(notification);
    const target = notificationTarget(notification);
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
    if (type === 'exploration_lost' || notification.notification_type === 'exploration_lost') {
      entry.explorationLost = true;
      if (!entry.explorationLostAt || new Date(entry.explorationLostAt).getTime() < new Date(date).getTime()) entry.explorationLostAt = date;
    }
    if (notification.notification_type === 'scan_repelled') {
      entry.scanRepelled = true;
      if (!entry.scanRepelledAt || new Date(entry.scanRepelledAt).getTime() < new Date(date).getTime()) entry.scanRepelledAt = date;
    }
    // A destroyed explorer has no scan payload. Keep the newest successful
    // exploration separately so a lost attempt never erases known data.
    if (type === 'exploration' && notification.exploration && (!entry.exploration || new Date(entry.explorationAt || 0).getTime() < new Date(date).getTime())) {
      entry.exploration = notification.exploration;
      entry.explorationAt = date;
    }
  }
  async function loadNotifications() {
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
      state.notificationIndex = index;
      state.notificationsLoaded = true;
      for (const entry of index.values()) {
        const record = getOrCreateRecord({ planetId: entry.planetId, name: entry.name, galaxy: entry.galaxy, system: entry.system, position: entry.position, allowUnknownGalaxy: true });
        if (entry.name && !record.name) record.name = entry.name;
        await saveRecord(record);
      }
      scheduleRender();
    } catch (error) { state.lastError = `Notifications: ${error.message}`; }
  }

  function recordNotifications(record) {
    const locationKey = Number.isSafeInteger(Number(record.system)) && Number.isSafeInteger(Number(record.position))
      ? `location:${Number(record.system)}:${Number(record.position)}` : null;
    const direct = state.notificationIndex.get(record.key)
      || (record.planetId != null ? state.notificationIndex.get(`planet:${record.planetId}`) : null)
      || (locationKey ? state.notificationIndex.get(locationKey) : null);
    if (direct) return direct;
    if (record.planetId != null) {
      for (const entry of state.notificationIndex.values()) if (Number(entry.planetId) === Number(record.planetId)) return entry;
    }
    return null;
  }
  function latestObservation(record) {
    return Object.values(record.observed || {}).reduce((latest, item) => !latest || new Date(item.observedAt) > new Date(latest) ? item.observedAt : latest, null);
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
    return cell(primary, extra, observedAt ? '' : 'fa-summary-na', observedAt);
  }
  function statusCell(value, reportedAt, sourceLabel) { return cell(value, sourceLabel || null, reportedAt ? '' : 'fa-summary-na', reportedAt); }
  function currentOccupancy(record, notification) {
    const base = latestBase(record);
    if (record.owned === true) return { value: 'Owned', date: stampFor(record, 'base') };
    if (notification?.explorationLost || notification?.scanRepelled) return { value: 'Occupied', date: null };
    if (base.claimed === true) return { value: 'Occupied', date: stampFor(record, 'base') };
    if (base.claimed === false) return { value: 'Unoccupied', date: stampFor(record, 'base') };
    if (notification?.exploration && typeof notification.exploration.is_occupied === 'boolean') return { value: notification.exploration.is_occupied ? 'Occupied' : 'Unoccupied', date: null };
    return { value: '—', date: null };
  }

  function buildingLabel(building) {
    return `${building.name || building.building_name || building.type || 'building'}${building.amount != null ? `: ${building.amount}` : ''}`;
  }
  function knownBuildings(record, notification) {
    const observedBuildings = valueFor(record, 'buildings');
    if (record.owned === true && Array.isArray(observedBuildings)) {
      return { items: observedBuildings.filter(building => number(building.amount) > 0), observedAt: stampFor(record, 'buildings') };
    }
    const exploration = notification?.exploration;
    if (exploration && Array.isArray(exploration.buildings)) {
      return { items: exploration.buildings.filter(building => number(building.amount ?? building.level ?? 1) > 0), observedAt: notification.latest.exploration };
    }
    return { items: [], observedAt: null };
  }
  function knownShips(record, notification) {
    const stationed = valueFor(record, 'ships');
    if (record.owned === true && Array.isArray(stationed)) return { items: stationed.filter(ship => number(ship.quantity) > 0), observedAt: stampFor(record, 'ships') };
    const exploration = notification?.exploration;
    const ships = exploration && (Array.isArray(exploration.fleet) ? exploration.fleet : Array.isArray(exploration.ships) ? exploration.ships : null);
    return { items: ships ? ships.filter(ship => number(ship.quantity) > 0) : [], observedAt: ships ? notification.latest.exploration : null };
  }
  function knownBuildingsCell(record, notification) {
    const known = knownBuildings(record, notification);
    const details = known.items.slice(0, 4).map(buildingLabel).join(' · ') || '—';
    const label = known.items.length ? `${known.items.length} ${record.owned === true ? 'building' : 'known building'}${known.items.length === 1 ? '' : 's'}` : '—';
    return cell(label, details, known.items.length ? '' : 'fa-summary-na', known.observedAt);
  }
  function knownFleetCell(record, notification) {
    const known = knownShips(record, notification);
    const details = known.items.slice(0, 5).map(ship => `${ship.ship_name || ship.name || ship.ship_key || 'ship'}${ship.quantity != null ? ` ×${fmt(ship.quantity)}` : ''}`).join(' · ') || '—';
    return cell(known.items.length ? `${fmt(sumShips(known.items))} ships` : '—', details, known.items.length ? '' : 'fa-summary-na', known.observedAt);
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
    const base = latestBase(record), resources = latestResources(record), notif = recordNotifications(record), exploration = notif?.exploration;
    const buildings = knownBuildings(record, notif);
    const ships = knownShips(record, notif);

    if (record.owned === true) {
      const defenses = valueFor(record, 'defenses') || [];
      const queues = [
        ['Construction', 'buildQueue'], ['Research', 'researchQueue'], ['Ships queue', 'shipQueue'], ['Defense queue', 'defenseQueue'],
      ].map(([label, category]) => { const list = valueFor(record, category) || []; return `${label}: ${list.length ? list.map(item => `${item.building_name || item.tech_name || item.ship_name || item.ship_key || 'item'} ×${item.quantity || item.remaining || item.target_level || item.target_amount || 1}`).join(', ') : 'idle'} (${ageShort(stampFor(record, category))})`; });
      grid.appendChild(detailSection('Economy', `Metal ${fmtMaybe(resources.metal)} / ${fmtMaybe(resources.capacity_metal)} · Silicon ${fmtMaybe(resources.silicon)} / ${fmtMaybe(resources.capacity_silicon)} · Helium ${fmtMaybe(resources.helium)}\nPopulation ${fmtMaybe(base.population_used)} / ${fmtMaybe(base.population)} · Automatons ${fmtMaybe(base.automatons_used)} / ${fmtMaybe(base.automatons)} · Energy ${fmtMaybe(base.energy_used)} / ${fmtMaybe(base.energy)}\nBuildable space ${fmtMaybe(base.buildable_space_used)} / ${fmtMaybe(base.buildable_space)}\nObserved ${ageShort(stampFor(record, 'resources') || stampFor(record, 'base'))}`));
      grid.appendChild(detailSection('Buildings', listElement(buildings.items.map(buildingLabel))));
      grid.appendChild(detailSection('Defenses', listElement(defenses.filter(item => number(item.quantity) > 0).map(item => `${item.name || item.key}: ${fmt(item.quantity)}`))));
      grid.appendChild(detailSection('Stationed fleet', listElement(ships.items.map(item => `${item.name || item.ship_name || item.key}: ${fmt(item.quantity)}`))));
      const activeFleets = valueFor(record, 'activeFleets') || [];
      grid.appendChild(detailSection('Active fleets', listElement(activeFleets.map(fleet => `${fleet.mission_type || 'mission'} → ${fleet.destination_system ?? '—'}:${fleet.destination_position ?? '—'} (${fleet.status || '—'})`))));
      grid.appendChild(detailSection('Queues', listElement(queues)));
    } else {
      grid.appendChild(detailSection('Known buildings', listElement(buildings.items.map(buildingLabel))));
      grid.appendChild(detailSection('Known fleet', listElement(ships.items.map(item => `${item.ship_name || item.name || item.ship_key || 'ship'}${item.quantity != null ? ` ×${fmt(item.quantity)}` : ''}`))));
    }
    grid.appendChild(detailSection('Reported exploration', exploration ? `Occupied: ${exploration.is_occupied ? 'yes' : 'no'}\nTemperature: ${exploration.temperature ?? '—'}°C\nResources: M ${fmtMaybe(exploration.resources?.metal)} · S ${fmtMaybe(exploration.resources?.silicon)} · H ${fmtMaybe(exploration.resources?.helium)}\nDebris: M ${fmtMaybe(exploration.debris?.metal)} · S ${fmtMaybe(exploration.debris?.silicon)} · H ${fmtMaybe(exploration.debris?.helium)}\nRelic: ${exploration.relic_detected ? 'yes' : 'no'} · Stellar object: ${exploration.stellar_object_detected ? 'yes' : 'no'}` : '—'));
    if (record.owned === true) {
      const raw = document.createElement('pre'); raw.textContent = JSON.stringify({ base, resources }, null, 2); grid.appendChild(detailSection('Raw observed summary', raw));
    }
    td.appendChild(grid); tr.appendChild(td); return tr;
  }

  function columnsForView() {
    if (state.view === 'explored') return [
      ['#', 'number'], ['Planet', 'name'], ['Location', 'coordinates'], ['Total size', 'sizeTotal'], ['Status', 'status'], ['Features', 'features'], ['Buildings', 'buildings'], ['Known fleet', 'knownFleet'],
    ];
    return [
      ['#', 'number'], ['Planet', 'name'], ['Location', 'coordinates'], ['Used size', 'sizeUsed'], ['Total size', 'sizeTotal'], ['Resources', 'resources'], ['Production / h', 'production'], ['Storage', 'storage'], ['Capacity', 'capacity'], ['Features', 'features'], ['Buildings', 'buildings'], ['Ships', 'ships'], ['Defenses', 'defenses'], ['Queues', 'queues'], ['Active fleets', 'activeFleets'], ['Actions', 'actions'],
    ];
  }
  function makeRow(record, rowNumber) {
    const base = latestBase(record), resources = latestResources(record), notif = recordNotifications(record), occupancy = currentOccupancy(record, notif);
    const row = document.createElement('tr');
    row.className = 'fa-summary-data-row';
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.setAttribute('aria-expanded', String(state.expanded.has(record.key)));
    row.title = 'Click to show or hide details';
    const toggleDetails = () => {
      if (state.expanded.has(record.key)) state.expanded.delete(record.key);
      else state.expanded.add(record.key);
      renderTable();
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
    const reportAt = notif?.latest?.exploration || null;
    const name = record.name || notif?.name || `Planet ${record.system ?? '—'}-${record.position ?? '—'}`;
    const location = coords(record.galaxy, record.system, record.position) || '—';
    const ships = valueFor(record, 'ships') || [];
    const defenses = valueFor(record, 'defenses') || [];
    const sizeSource = record.owned === true ? base : (notif?.exploration || {});
    const usedSize = sizeSource.buildable_space_used ?? sizeSource.building_space_used ?? sizeSource.used_buildable_space;
    const totalSize = sizeSource.buildable_space ?? sizeSource.building_space ?? sizeSource.buildable_space_total;
    const featureParts = [];
    if (base.has_relic_building === true || notif?.exploration?.relic_detected === true) featureParts.push('relic');
    if (base.has_stellar_object_feature === true || notif?.exploration?.stellar_object_detected === true) featureParts.push('stellar');
    const cells = {
      number: cell(rowNumber, null),
      name: cell(name, null, '', record.owned ? latestObservation(record) : reportAt),
      coordinates: cell(location, null, '', undefined),
      sizeUsed: cell(usedSize == null ? '—' : fmtMaybe(usedSize), null, usedSize == null ? 'fa-summary-na' : ''),
      sizeTotal: cell(totalSize == null ? '—' : fmtMaybe(totalSize), null, totalSize == null ? 'fa-summary-na' : ''),
      status: statusCell(record.owned === true ? 'Owned by me' : occupancy.value, undefined, null),
      features: cell(featureParts.join(' · ') || '—', null, featureParts.length ? 'fa-summary-good' : 'fa-summary-na', undefined),
      buildings: knownBuildingsCell(record, notif),
      knownFleet: knownFleetCell(record, notif),
    };
    if (state.view === 'owned') {
      const buildingQueue = valueFor(record, 'buildQueue') || [], researchQueue = valueFor(record, 'researchQueue') || [], shipQueue = valueFor(record, 'shipQueue') || [], defenseQueue = valueFor(record, 'defenseQueue') || [];
      const queueObservedAt = ['buildQueue', 'researchQueue', 'shipQueue', 'defenseQueue'].map(category => stampFor(record, category)).filter(Boolean).sort().pop();
      const queueText = queueObservedAt ? (`${buildingQueue.length ? 'build' : ''}${researchQueue.length ? ' research' : ''}${shipQueue.length ? ' ships' : ''}${defenseQueue.length ? ' defense' : ''}`.trim() || 'idle') : '—';
      const resourceStamp = observedStamp(record, 'resources');
      cells.resources = stackedCell([
        `M ${fmtMaybe(resources.metal)}`,
        `S ${fmtMaybe(resources.silicon)}`,
        `H ${fmtMaybe(resources.helium)}`,
      ], resourceStamp, resourceStamp ? '' : 'fa-summary-na');
      cells.production = stackedCell([
        `M ${resources.rate_metal_per_hour == null ? '—' : `+${fmt(resources.rate_metal_per_hour)}/h`}`,
        `S ${resources.rate_silicon_per_hour == null ? '—' : `+${fmt(resources.rate_silicon_per_hour)}/h`}`,
        `H ${resources.rate_helium_per_hour == null ? '—' : `+${fmt(resources.rate_helium_per_hour)}/h`}`,
      ], resourceStamp, resourceStamp ? '' : 'fa-summary-na');
      cells.storage = stackedCell([
        `M ${percent(resources.metal, resources.capacity_metal)}`,
        `S ${percent(resources.silicon, resources.capacity_silicon)}`,
        `H ${percent(resources.helium, resources.capacity_helium)}`,
      ], resourceStamp, resourceStamp ? '' : 'fa-summary-na');
      cells.capacity = stackedCell([
        `P ${fmtMaybe(base.population_used)} / ${fmtMaybe(base.population)}`,
        `A ${fmtMaybe(base.automatons_used)} / ${fmtMaybe(base.automatons)}`,
        `E ${fmtMaybe(base.energy_used)} / ${fmtMaybe(base.energy)}`,
      ], observedStamp(record, 'base'), observedStamp(record, 'base') ? '' : 'fa-summary-na');
      cells.ships = observedCell(record, 'ships', Array.isArray(valueFor(record, 'ships')) ? `${fmt(sumShips(ships))} ships` : '—', Array.isArray(valueFor(record, 'ships')) ? groupShips(ships) : '—');
      cells.defenses = observedCell(record, 'defenses', Array.isArray(valueFor(record, 'defenses')) ? `${fmt(defenses.reduce((total, item) => total + number(item.quantity), 0))} defenses` : '—');
      const activeFleets = valueFor(record, 'activeFleets');
      cells.activeFleets = observedCell(record, 'activeFleets', Array.isArray(activeFleets) ? `${activeFleets.length} active` : '—', Array.isArray(activeFleets) ? activeFleets.map(fleet => `${fleet.mission_type || 'mission'} → ${fleet.destination_system ?? '—'}:${fleet.destination_position ?? '—'} (${fleet.status || '—'})`).join(' · ') || '—' : '—');
      cells.queues = cell(queueText, queueObservedAt ? `B${buildingQueue.length} · R${researchQueue.length} · S${shipQueue.length} · D${defenseQueue.length}` : '—', '', queueObservedAt);
    }
    const action = document.createElement('td'); action.className = 'fa-summary-actions';
    if (record.owned === true && record.planetId != null) { const update = document.createElement('button'); update.type = 'button'; update.textContent = state.refreshing.has(record.planetId) ? 'Updating…' : 'Update'; update.disabled = state.refreshing.has(record.planetId); update.addEventListener('click', event => { event.stopPropagation(); manualRefresh(record); }); action.appendChild(update); }
    if (state.view === 'owned') cells.actions = action;
    for (const [, key] of columnsForView()) { const current = cells[key]; if (current) { if (key === 'number') current.classList.add('fa-summary-number'); row.appendChild(current); } }
    return row;
  }
  function matchingRecords() {
    sidebarPlanets();
    canonicalizeRecords();
    const query = state.search.trim().toLowerCase();
    const unique = new Map();
    for (const record of state.records.values()) {
      if (state.view === 'owned' && record.owned !== true) continue;
      if (state.view === 'explored' && (record.owned === true || !recordNotifications(record))) continue;
      if (query && ![record.name, record.planetId, record.galaxy, record.system, record.position, coords(record.galaxy, record.system, record.position)].some(value => String(value ?? '').toLowerCase().includes(query))) continue;
      const identity = record.planetId != null
        ? `planet:${Number(record.planetId)}`
        : coords(record.galaxy, record.system, record.position) || record.key;
      const existing = unique.get(identity);
      unique.set(identity, existing ? mergeRecords(existing, record) : record);
    }
    return [...unique.values()].sort((a, b) => {
      let left, right;
      if (state.sort === 'name') { left = a.name || ''; right = b.name || ''; }
      else if (state.sort === 'updated') { left = latestObservation(a) || ''; right = latestObservation(b) || ''; }
      else if (state.sort === 'ships') { left = sumShips(valueFor(a, 'ships')); right = sumShips(valueFor(b, 'ships')); }
      else if (state.sort === 'sizeUsed') { left = number(latestBase(a).buildable_space_used); right = number(latestBase(b).buildable_space_used); }
      else if (state.sort === 'sizeTotal') { left = number(latestBase(a).buildable_space); right = number(latestBase(b).buildable_space); }
      else { left = coords(a.galaxy, a.system, a.position) || a.key; right = coords(b.galaxy, b.system, b.position) || b.key; }
      return (left < right ? -1 : left > right ? 1 : 0) * state.sortDirection;
    });
  }
  function renderTable() {
    if (!state.panel) return;
    const tbody = state.panel.querySelector('.fa-summary-body');
    if (!tbody) return;
    tbody.replaceChildren();
    const allRecords = matchingRecords();
    const pageCount = Math.max(1, Math.ceil(allRecords.length / state.pageSize));
    state.page = Math.min(state.page, pageCount - 1);
    const start = state.page * state.pageSize;
    const records = allRecords.slice(start, start + state.pageSize);
    const viewColumns = columnsForView();
    const colspan = viewColumns.length;
    records.forEach((record, index) => { tbody.appendChild(makeRow(record, start + index + 1)); if (state.expanded.has(record.key)) tbody.appendChild(renderDetails(record, colspan)); });
    const status = state.panel.querySelector('.fa-summary-status');
    if (status) {
      const shown = allRecords.length ? `${start + 1}–${Math.min(start + state.pageSize, allRecords.length)}` : '0';
      status.textContent = `${allRecords.length} ${state.view === 'owned' ? 'owned' : 'explored'} planet${allRecords.length === 1 ? '' : 's'} · showing ${shown} · ${state.records.size} stored · Notifications ${state.notificationsLoaded ? 'loaded' : 'not available'}${state.lastError ? `\n${state.lastError}` : ''}`;
    }
    const pageLabel = state.panel.querySelector('.fa-summary-page-label');
    const previous = state.panel.querySelector('.fa-summary-page-prev');
    const next = state.panel.querySelector('.fa-summary-page-next');
    if (pageLabel) pageLabel.textContent = `Page ${state.page + 1} / ${pageCount}`;
    if (previous) previous.disabled = state.page === 0;
    if (next) next.disabled = state.page >= pageCount - 1;
    const headerRow = state.panel.querySelector('.fa-summary-table thead tr');
    if (headerRow) {
      headerRow.replaceChildren();
      const descriptions = {
        fleets: 'Currently active outbound/inbound fleets observed from the game API.',
        activeFleets: 'Currently active fleets originating from this owned planet.',
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
        const th = document.createElement('th'); th.dataset.sort = columnKey; th.title = descriptions[columnKey] || label;
        const sortableKey = columnKey === 'coordinates' ? 'coordinates' : columnKey === 'name' ? 'name' : (columnKey === 'sizeUsed' || columnKey === 'sizeTotal') ? columnKey : (columnKey === 'ships' || columnKey === 'knownFleet') ? 'ships' : null;
        const labelText = document.createElement('span'); labelText.textContent = label; th.appendChild(labelText);
        const indicator = document.createElement('span'); indicator.className = 'fa-summary-sort-indicator'; indicator.setAttribute('aria-hidden', 'true'); indicator.textContent = sortableKey === state.sort ? (state.sortDirection === 1 ? '↑' : '↓') : ''; th.appendChild(indicator);
        if (sortableKey) { th.classList.add('fa-summary-sortable'); th.setAttribute('aria-sort', sortableKey === state.sort ? (state.sortDirection === 1 ? 'ascending' : 'descending') : 'none'); th.addEventListener('click', () => { if (state.sort === sortableKey) state.sortDirection *= -1; else { state.sort = sortableKey; state.sortDirection = 1; } renderTable(); }); }
        headerRow.appendChild(th);
      });
    }
    state.panel.querySelectorAll('.fa-summary-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.view === state.view));
  }
  function scheduleRender() { if (!state.panel || state.renderTimer) return; state.renderTimer = setTimeout(() => { state.renderTimer = null; renderTable(); }, 80); }
  function openPanel() { if (!state.panel) return; state.panel.classList.remove('hidden'); loadNotifications(); renderTable(); }
  function closePanel() { state.panel?.classList.add('hidden'); }

  async function manualRefresh(record) {
    if (!record.planetId || !window.req || state.refreshing.has(record.planetId)) return;
    const id = record.planetId;
    state.refreshing.add(id); state.lastError = ''; renderTable();
    const errors = [];
    try {
      for (const makePath of REFRESH_ENDPOINTS) {
        const path = makePath(id);
        try {
          const result = statusBody(await window.req('GET', path));
          if (result.status < 200 || result.status >= 300) throw new Error(`HTTP ${result.status}`);
          await applyApiResponse(endpointUrl(`/api${path}`), result.status, result.body);
        } catch (error) { errors.push(`${path}: ${error.message}`); }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } finally {
      state.refreshing.delete(id);
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
      const tabs = document.createElement('div'); tabs.className = 'fa-summary-tabs';
      [['owned', 'My planets'], ['explored', 'Explored planets']].forEach(([view, label]) => {
        const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'fa-summary-tab'; tab.dataset.view = view; tab.textContent = label;
        tab.addEventListener('click', () => { state.view = view; state.page = 0; renderTable(); }); tabs.appendChild(tab);
      });
      const searchWrap = document.createElement('div'); searchWrap.className = 'fa-summary-search';
      const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Search planet or coordinates…';
      const clearSearch = document.createElement('button'); clearSearch.type = 'button'; clearSearch.className = 'fa-summary-search-clear'; clearSearch.textContent = '×'; clearSearch.setAttribute('aria-label', 'Clear search');
      const syncSearchClear = () => { clearSearch.hidden = !search.value; };
      search.addEventListener('input', () => { state.search = search.value; state.page = 0; syncSearchClear(); renderTable(); });
      clearSearch.addEventListener('click', () => { search.value = ''; state.search = ''; state.page = 0; syncSearchClear(); search.focus(); renderTable(); });
      searchWrap.append(search, clearSearch);
      syncSearchClear();
      const page = document.createElement('span'); page.className = 'fa-summary-page';
      const previous = document.createElement('button'); previous.type = 'button'; previous.className = 'fa-summary-page-prev'; previous.textContent = '←'; previous.title = 'Previous page'; previous.addEventListener('click', () => { state.page = Math.max(0, state.page - 1); renderTable(); });
      const pageLabel = document.createElement('span'); pageLabel.className = 'fa-summary-page-label';
      const next = document.createElement('button'); next.type = 'button'; next.className = 'fa-summary-page-next'; next.textContent = '→'; next.title = 'Next page'; next.addEventListener('click', () => { state.page += 1; renderTable(); });
      page.append(previous, pageLabel, next);
      const toolbar = document.createElement('div'); toolbar.className = 'fa-summary-toolbar';
      toolbar.append(searchWrap, page);
      const status = document.createElement('div'); status.className = 'fa-summary-status';
      controls.append(tabs, toolbar, status);
      const wrap = document.createElement('div'); wrap.className = 'fa-summary-table-wrap';
      const table = document.createElement('table'); table.className = 'fa-summary-table';
      const thead = document.createElement('thead'); const tr = document.createElement('tr'); thead.appendChild(tr);
      const tbody = document.createElement('tbody'); tbody.className = 'fa-summary-body'; table.append(thead, tbody); wrap.appendChild(table); dialog.append(header, controls, wrap); overlay.appendChild(dialog); overlay.addEventListener('click', event => { if (event.target === overlay) closePanel(); }); document.body.appendChild(overlay); state.panel = overlay;
    }
    const title = document.querySelector('#planet-sidebar .planet-sidebar-title');
    if (title && !title.querySelector('.fa-summary-sidebar-btn')) { const button = document.createElement('button'); button.type = 'button'; button.className = 'fa-summary-sidebar-btn'; button.textContent = 'Overview'; button.addEventListener('click', openPanel); title.appendChild(button); }
  }

  function observeDom() {
    ensurePanel();
    sidebarPlanets().forEach(saveRecord);
    scheduleRender();
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
        observeDom();
      });
      sidebarObserver.observe(sidebar, { childList: true, subtree: true });
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
