// ==UserScript==
// @name         Fonte Antiga - Explore From Nearest Colony
// @namespace    fa.galaxy-explore-nearest-colony
// @version      1.1.5
// @description  Start Galaxy exploration missions from the closest owned colony
// @match        *://fonteantiga.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const WRAPPED_FLAG = '__faExploreNearestColonyWrapped';
  const ORIGIN_EVENT = 'fa-explore-nearest-colony-origin';
  const ORIGIN_BRIDGE_MARKER = 'faExploreNearestColonyBridge';
  // Colony coordinates change infrequently. Retaining them avoids a
  // /planets/me request when several exploration fleets are launched in one
  // session, while still allowing eventual discovery of a new/relocated colony.
  const PLANETS_CACHE_TTL = 5 * 60 * 1000;
  let planetsCache = null;
  let planetsCacheAt = 0;
  let mapCache = null;
  let mapCoordinates = null;

  function numeric(value) {
    const result = Number(value);
    return Number.isFinite(result) ? result : null;
  }

  function installPageBridge() {
    const root = document.documentElement;
    if (!root || root.dataset[ORIGIN_BRIDGE_MARKER]) return;

    const bridge = document.createElement('script');
    bridge.textContent = `
      (function () {
        var root = document.documentElement;
        if (!root || root.dataset.${ORIGIN_BRIDGE_MARKER}) return;
        root.dataset.${ORIGIN_BRIDGE_MARKER} = '1';
        document.addEventListener(${JSON.stringify(ORIGIN_EVENT)}, function (event) {
          var id = Number(event.detail);
          if (!Number.isSafeInteger(id) || typeof state === 'undefined') return;
          state.currentPlanetId = id;
          state.lastPlanetId = id;
          localStorage.setItem('galaxygame_planet', String(id));
          document.querySelectorAll('#colony-picker-list .colony-picker-row').forEach(function (pill) {
            pill.classList.toggle('active', pill.dataset.planetId === String(id));
          });
          if (typeof refreshTopbarPlanets === 'function') {
            try {
              var refresh = refreshTopbarPlanets();
              if (refresh && typeof refresh.catch === 'function') refresh.catch(function () {});
            } catch (_) {}
          }
          if (typeof showScreen === 'function') showScreen('planet');
          // openPlanet() normally starts the game's one-second fleet ticker and
          // poll loop. This bridge intentionally skips openPlanet() so the
          // dashboard is not refreshed, so restart those loops explicitly.
          if (typeof startTicking === 'function') startTicking();
        });
      })();
    `;
    root.appendChild(bridge);
    bridge.remove();
  }

  function setFleetOrigin(planetId) {
    const root = document.documentElement;
    if (!root || !root.dataset[ORIGIN_BRIDGE_MARKER]) return false;
    document.dispatchEvent(new CustomEvent(ORIGIN_EVENT, { detail: String(planetId) }));
    return true;
  }

  async function loadOwnedPlanets() {
    const now = Date.now();
    if (planetsCache && now - planetsCacheAt < PLANETS_CACHE_TTL) return planetsCache;

    // refreshFleets already keeps this list in state, so use it when possible.
    const fromState = typeof state !== 'undefined' && Array.isArray(state.myPlanets)
      ? state.myPlanets
      : null;
    if (fromState && fromState.length > 0) {
      planetsCache = fromState;
      planetsCacheAt = now;
      return planetsCache;
    }

    if (typeof window.req !== 'function') return [];
    const response = await window.req('GET', '/planets/me');
    const planets = response && Array.isArray(response.body) ? response.body : [];
    planetsCache = planets;
    planetsCacheAt = now;
    return planets;
  }

  async function loadGalaxySystems() {
    // Keep the map for the lifetime of this page. A full page reload starts a
    // new script instance and therefore picks up a new map automatically.
    if (mapCache) return mapCache;

    const fromState = typeof state !== 'undefined' && Array.isArray(state.galaxyMapSystems)
      ? state.galaxyMapSystems
      : null;
    if (fromState && fromState.length > 0) {
      mapCache = fromState;
      return mapCache;
    }

    if (typeof window.req !== 'function') return [];
    const response = await window.req('GET', '/universe/map');
    const systems = response && Array.isArray(response.body) ? response.body : [];
    mapCache = systems;
    mapCoordinates = new Map();
    systems.forEach(item => {
      const galaxy = numeric(item.galaxy);
      const system = numeric(item.system);
      const x = numeric(item.x);
      const y = numeric(item.y);
      if (galaxy !== null && system !== null && x !== null && y !== null) {
        mapCoordinates.set(`${galaxy}:${system}`, { x, y });
      }
    });
    return systems;
  }

  function systemCoordinates(systems, galaxy, system) {
    if (!mapCoordinates) {
      mapCoordinates = new Map();
      systems.forEach(item => {
        const itemGalaxy = numeric(item.galaxy);
        const itemSystem = numeric(item.system);
        const x = numeric(item.x);
        const y = numeric(item.y);
        if (itemGalaxy !== null && itemSystem !== null && x !== null && y !== null) {
          mapCoordinates.set(`${itemGalaxy}:${itemSystem}`, { x, y });
        }
      });
    }
    return mapCoordinates.get(`${galaxy}:${system}`) || null;
  }

  function distanceToTarget(source, target, systems) {
    const sourceGalaxy = numeric(source.galaxy) ?? 1;
    const targetGalaxy = numeric(target.galaxy) ?? 1;
    const sourceSystem = numeric(source.system);
    const targetSystem = numeric(target.system);
    const sourcePosition = numeric(source.position) ?? 0;
    const targetPosition = numeric(target.position) ?? 0;

    if (sourceSystem === null || targetSystem === null) return Infinity;

    // System coordinates reflect the actual galaxy layout. Planet position is
    // only used to break ties inside one system, where it is the useful part
    // of the distance.
    const sourcePoint = systemCoordinates(systems, sourceGalaxy, sourceSystem);
    const targetPoint = systemCoordinates(systems, targetGalaxy, targetSystem);
    if (sourcePoint && targetPoint && sourceGalaxy === targetGalaxy) {
      const systemDistance = Math.hypot(sourcePoint.x - targetPoint.x, sourcePoint.y - targetPoint.y);
      return systemDistance + Math.abs(sourcePosition - targetPosition) * 1e-6;
    }

    // The game currently deploys Galaxy 1 destinations. This fallback also
    // keeps the script useful if the map endpoint is unavailable.
    const galaxyDistance = Math.abs(sourceGalaxy - targetGalaxy) * 1e6;
    return galaxyDistance + Math.abs(sourceSystem - targetSystem)
      + Math.abs(sourcePosition - targetPosition) * 1e-6;
  }

  async function findNearestColony(destSystem, destPosition) {
    const [planets, systems] = await Promise.all([loadOwnedPlanets(), loadGalaxySystems()]);
    const target = { galaxy: 1, system: numeric(destSystem), position: numeric(destPosition) };
    if (target.system === null || target.position === null || planets.length === 0) return null;

    let nearest = null;
    planets.forEach((planet, index) => {
      if (numeric(planet.id) === null) return;
      const distance = distanceToTarget(planet, target, systems);
      if (!nearest || distance < nearest.distance ||
          (distance === nearest.distance && index < nearest.index)) {
        nearest = { planet, index, distance };
      }
    });
    return nearest?.planet || null;
  }

  function install() {
    const original = window.quickDeployFleet;
    if (typeof original !== 'function' || original[WRAPPED_FLAG]) return;

    async function quickDeployFromNearestColony(destSystem, destPosition, mission) {
      if (mission !== 'explore') return original.apply(this, arguments);

      try {
        const nearest = await findNearestColony(destSystem, destPosition);
        if (nearest && setFleetOrigin(nearest.id)) {
          // quickDeployFleet normally calls openPlanet() when the selected
          // origin differs from the current one. The page-context bridge sets
          // the origin directly without running the overview refresh, so the
          // next native action is the Fleet tab itself.
          // Keep fuel/resource calculations correct without showing the
          // dashboard first.
          if (typeof window.syncResources === 'function') await window.syncResources();
        }
      } catch (_) {
        // Fall through to the game's normal origin-selection behavior.
      }
      return original.apply(this, arguments);
    }

    quickDeployFromNearestColony[WRAPPED_FLAG] = true;
    quickDeployFromNearestColony.__faOriginal = original;
    window.quickDeployFleet = quickDeployFromNearestColony;
  }

  installPageBridge();
  install();
  const installDelays = [250, 250, 500, 1000, 2000, 4000, 8000];
  function retryInstall(attempt = 0) {
    install();
    if (typeof window.quickDeployFleet === 'function' && window.quickDeployFleet[WRAPPED_FLAG]) return;
    if (attempt >= installDelays.length) return;
    setTimeout(() => retryInstall(attempt + 1), installDelays[attempt]);
  }
  retryInstall();
})();
