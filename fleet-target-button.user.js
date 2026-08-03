// ==UserScript==
// @name         Fonte Antiga - Fleet Target Button
// @namespace    fa.fleet-target
// @version      11.0.0
// @description  Turn each owned planet's coordinates into a target control; clicking fills destination coordinates in the fleet command tab
// @match        *://antiga.hatedabamboo.me/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const TARGET_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5">
    <circle cx="12" cy="12" r="8"></circle>
    <line x1="12" y1="2" x2="12" y2="6"></line>
    <line x1="12" y1="18" x2="12" y2="22"></line>
    <line x1="2" y1="12" x2="6" y2="12"></line>
    <line x1="18" y1="12" x2="22" y2="12"></line>
  </svg>`;

  const style = document.createElement('style');
  style.textContent = `
    .fa-target-btn {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      min-width: 2.5rem;
      min-height: 1.2rem;
      padding: 0 0.2rem;
      border-radius: 3px;
      font-size: 0.62rem;
      color: var(--fg-dim);
      cursor: pointer;
    }
    .fa-target-icon {
      position: absolute;
      inset: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      opacity: 0.35;
      pointer-events: none;
    }
    .fa-target-icon svg {
      width: 1.35em;
      height: 1.35em;
    }
    .fa-target-coords {
      position: relative;
      z-index: 1;
      white-space: nowrap;
    }
    .fa-target-btn:hover {
      background: rgba(255,255,255,0.1);
      color: var(--fg);
    }
  `;
  document.head.appendChild(style);

  let lastSidebarHtml = '';

  function parseCoords(text) {
    const m = text.trim().match(/^(\d+):(\d+)$/);
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
  }

  function fillFleetInputs(system, position) {
    const sysInput = document.getElementById('fleet-dest-system');
    const posInput = document.getElementById('fleet-dest-position');
    if (!sysInput || !posInput) return false;

    sysInput.value = system;
    posInput.value = position;
    // Dispatch input event so the game's oninput="updateFleetSummary()" fires
    sysInput.dispatchEvent(new Event('input', { bubbles: true }));
    posInput.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function setTarget(system, position) {
    // The systems screen is authoritative. The fleet panel can remain active in the
    // background after switchTab(), so it must not take priority over the visible galaxy.
    const screenSystems = document.getElementById('screen-systems');
    if (screenSystems && !screenSystems.classList.contains('hidden')) {
      const navSys = document.getElementById('galaxy-nav-system');
      if (navSys) {
        navSys.value = system;
        jumpToSystem();
      }
      return;
    }

    // Fleet command tab — fill directly only when it is the visible panel.
    const fleetsPanel = document.getElementById('panel-fleets');
    if (fleetsPanel && fleetsPanel.classList.contains('active')) {
      fillFleetInputs(system, position);
      return;
    }

    // Any other game tab: switch to Fleet Command and wait for its async refresh.
    switchTab('fleets');

    const shipContainer = document.getElementById('fleet-ship-inputs');
    if (!shipContainer) return;

    let done = false;
    let fallbackTimer = null;
    const finish = () => {
      if (done) return;
      done = true;
      observer.disconnect();
      if (fallbackTimer) clearTimeout(fallbackTimer);
      fillFleetInputs(system, position);
    };

    const observer = new MutationObserver(() => {
      // renderFleetShipInputs() rebuilds this container after refreshFleets().
      if (document.querySelector('#fleet-ship-inputs [data-shipkey]')) finish();
    });
    observer.observe(shipContainer, { childList: true, subtree: true });

    // The existing ship rows may be stale; wait for refreshFleets() to rebuild them.
    // The fallback covers a render that completed before the observer was attached.
    fallbackTimer = setTimeout(finish, 3000);
  }

  function addTargetButton(pill) {
    const coordsEl = pill.querySelector('.sidebar-planet-coords');
    if (!coordsEl) return;

    const coords = parseCoords(coordsEl.textContent);
    if (!coords) return;

    const [system, position] = coords;
    const meta = pill.querySelector('.sidebar-planet-meta');
    if (!meta) return;

    // The coordinates are the target control now. This keeps the control inside
    // the existing planet pill without creating an invalid nested button.
    coordsEl.classList.add('fa-target-btn');
    coordsEl.title = `Set destination to ${system}:${position}`;

    if (!coordsEl.querySelector('.fa-target-coords')) {
      const label = document.createElement('span');
      label.className = 'fa-target-coords';
      label.textContent = coordsEl.textContent.trim();

      const icon = document.createElement('span');
      icon.className = 'fa-target-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = TARGET_SVG;

      coordsEl.textContent = '';
      coordsEl.append(icon, label);
    }

    if (!coordsEl.dataset.faTargetBound) {
      coordsEl.dataset.faTargetBound = 'true';
      coordsEl.addEventListener('click', e => {
        e.stopPropagation(); // don't trigger the pill's own click (which navigates to the planet)
        const currentCoords = parseCoords(coordsEl.textContent);
        if (currentCoords) setTarget(currentCoords[0], currentCoords[1]);
      });
    }

    // Remove controls left behind by an older version of this script.
    meta.querySelectorAll('.fa-target-btn:not(.sidebar-planet-coords)').forEach(el => el.remove());
  }

  function processSidebar() {
    const sidebar = document.getElementById('sidebar-planets');
    if (!sidebar) return;

    // Detect full sidebar re-render (game replaced the entire container content)
    const currentHtml = sidebar.innerHTML;
    if (currentHtml !== lastSidebarHtml) {
      lastSidebarHtml = currentHtml;
      // Sidebar was re-rendered — process ALL pills (no .fa-done gate needed since DOM is fresh)
      const pills = sidebar.querySelectorAll('.sidebar-planet-pill');
      for (const pill of pills) {
        addTargetButton(pill);
      }
    } else {
      // Incremental update — only process pills that don't have a button yet
      const pills = sidebar.querySelectorAll('.sidebar-planet-pill');
      for (const pill of pills) {
        const meta = pill.querySelector('.sidebar-planet-meta');
        if (!meta || !meta.querySelector('.fa-target-btn')) {
          addTargetButton(pill);
        }
      }
    }
  }

  let timer = null;

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(processSidebar, 50);
  }

  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      if (m.type === 'childList') {
        const added = Array.from(m.addedNodes);
        const removed = Array.from(m.removedNodes);

        // Check if sidebar container or its pills were touched
        const touchedSidebar =
          added.some(n => n.nodeType === 1 && (
            n.id === 'sidebar-planets' ||
            n.closest('#sidebar-planets') ||
            n.querySelector?.('.sidebar-planet-pill')
          )) ||
          removed.some(n => n.nodeType === 1 && (
            n.id === 'sidebar-planets' ||
            n.classList?.contains('sidebar-planet-pill')
          ));

        if (touchedSidebar) {
          // Process immediately for sidebar changes — no visible gap
          processSidebar();
          return;
        }
      }
    }
    schedule();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  processSidebar();
})();
