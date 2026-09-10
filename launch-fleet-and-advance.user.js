// ==UserScript==
// @name         Fonte Antiga - Launch Fleet and Advance
// @namespace    fa.fleet-launch-next
// @version      1.3.6
// @description  Add buttons to launch one fleet and to launch as many fleets as possible while advancing destinations
// @match        *://antiga.hatedabamboo.me/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
    .fa-launch-next-btn,
    .fa-launch-max-btn {
      background: var(--panel-alt);
      color: var(--fg);
      border-color: var(--border-soft);
    }
    .fa-launch-max-btn {
      position: relative;
      overflow: hidden;
    }
    .fa-launch-next-btn:hover,
    .fa-launch-max-btn:hover {
      background: var(--panel);
      border-color: var(--accent);
    }
    /* The construction/research controls use a thin progress strip at the
       bottom of the action area. Keep it inside the button so its height does
       not change when progress is shown. */
    .fa-launch-progress {
      display: block !important;
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      width: auto;
      height: 3px;
      min-height: 3px;
      margin: 0;
      background: var(--bg-alt);
      border-radius: 0;
      pointer-events: none;
    }
    .fa-launch-progress.hidden {
      display: none !important;
    }
    .fa-launch-progress .ip-track {
      display: block !important;
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      background: transparent;
    }
    .fa-launch-progress .ip-fill {
      display: block;
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      z-index: 1;
    }
    .fa-launch-progress .ip-label {
      display: none;
    }
    .fa-launch-max-wrap {
      position: relative;
      display: inline-flex;
    }
    .fa-launch-max-wrap .fa-launch-max-btn {
      padding-right: 2.1em;
    }
    .fa-launch-cancel-btn {
      display: none;
      position: absolute;
      right: 0.35em;
      top: 50%;
      z-index: 3;
      transform: translateY(-50%);
      align-items: center;
      justify-content: center;
      width: 1.35em;
      height: 1.35em;
      padding: 0;
      border: 0;
      border-radius: 50%;
      box-sizing: border-box;
      background: var(--panel-alt);
      color: var(--fg-dim);
      cursor: pointer;
    }
    .fa-launch-cancel-btn .icon-slot {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
    }
    .fa-launch-cancel-btn .icon-slot svg {
      width: 1em;
      height: 1em;
    }
    .fa-launch-max-wrap.fa-launching .fa-launch-cancel-btn {
      display: inline-flex;
    }
    .fa-launch-max-wrap.fa-launching .fa-launch-max-btn:hover {
      background: var(--panel-alt);
      border-color: var(--border-soft);
    }
    .fa-launch-max-wrap.fa-launching .fa-launch-cancel-btn:hover {
      color: var(--accent);
      background: var(--panel);
      border-color: var(--accent);
    }
  `;
  document.head.appendChild(style);

  function setDestinationPosition(position) {
    const input = document.getElementById('fleet-dest-position');
    if (!input || !Number.isInteger(position)) return;
    input.value = position;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function advanceDestinationPlanet() {
    const systemInput = document.getElementById('fleet-dest-system');
    const positionInput = document.getElementById('fleet-dest-position');
    const system = parseInt(systemInput?.value, 10);
    const current = parseInt(positionInput?.value, 10);
    if (!system || !current) return;

    const positions = await systemPlanetPositions(system);
    const next = positions.find(position => position > current);
    if (next != null) setDestinationPosition(next);
  }

  async function launchFleet() {
    // The current game validates in reviewDeployFleet() and submits through a
    // separate async helper. Capture that helper's result because the review
    // function itself does not return or await the submission promise.
    if (typeof window.reviewDeployFleet !== 'function' || typeof window.submitDeployFleet !== 'function') return false;

    const originalSubmit = window.submitDeployFleet;
    let submission = null;
    const wrappedSubmit = function (...args) {
      submission = Promise.resolve(originalSubmit.apply(this, args));
      return submission;
    };
    window.submitDeployFleet = wrappedSubmit;
    try {
      window.reviewDeployFleet();
      // Validation failures and colonization confirmation do not submit yet.
      if (!submission) return false;
      return (await submission) === true;
    } finally {
      if (window.submitDeployFleet === wrappedSubmit) window.submitDeployFleet = originalSubmit;
    }
  }

  async function launchAndAdvance(button) {
    if (button.disabled || typeof window.reviewDeployFleet !== 'function') return;

    button.disabled = true;
    try {
      if (await launchFleet()) await advanceDestinationPlanet();
    } finally {
      button.disabled = false;
    }
  }

  function selectedShips() {
    const ships = {};
    document.querySelectorAll('#fleet-ship-inputs input[data-shipkey]').forEach(input => {
      const quantity = parseInt(input.value, 10) || 0;
      if (quantity > 0) ships[input.dataset.shipkey] = quantity;
    });
    return ships;
  }

  function fleetSlotLimit() {
    const text = document.querySelector('#fleets-stat-fcc-slots')?.textContent || '';
    const match = text.match(/(\d+)\s*\/\s*(\d+)/);
    // The stat can be temporarily absent while the fleets panel refreshes;
    // do not turn that transient state into a false zero-capacity result.
    if (!match) return Number.MAX_SAFE_INTEGER;
    return Math.max(0, parseInt(match[2], 10) - parseInt(match[1], 10));
  }

  function fleetShipInput(shipKey) {
    return Array.from(document.querySelectorAll('#fleet-ship-inputs input[data-shipkey]'))
      .find(input => input.dataset.shipkey === shipKey);
  }

  function availableShipFleetCount(ships) {
    if (Object.keys(ships).length === 0) return 0;
    return Object.entries(ships).reduce((count, [key, perFleet]) => {
      const input = fleetShipInput(key);
      // During a fleet refresh the input may briefly lose its max attribute.
      // Treat that as unknown rather than as zero available ships.
      const available = input && input.max !== ''
        ? (parseInt(input.max, 10) || 0)
        : Number.MAX_SAFE_INTEGER;
      return Math.min(count, Math.floor(available / perFleet));
    }, Number.MAX_SAFE_INTEGER);
  }

  function possibleFleetCount(ships) {
    return Math.min(fleetSlotLimit(), availableShipFleetCount(ships));
  }

  function launchBlockReason(positions, ships) {
    if (Object.keys(ships).length === 0) return 'Select at least one ship to launch.';
    if (positions.length === 0) return 'No target planets remain in this system.';
    if (fleetSlotLimit() <= 0) return 'No Fleet Command slots are available.';
    if (availableShipFleetCount(ships) <= 0) return 'Not enough available ships for the selected fleet.';
    return '';
  }

  async function systemPlanetPositions(system) {
    const response = await Promise.race([
      window.req('GET', `/universe/system?galaxy=1&system=${system}`),
      wait(5000).then(() => null),
    ]);
    if (!response || response.status !== 200 || !Array.isArray(response.body)) return [];
    return response.body
      .filter(planet => Number.isInteger(planet.position) && planet.slot_kind !== 'expedition')
      .map(planet => planet.position)
      .sort((a, b) => a - b);
  }

  function setLaunchProgress(button, completed, total, visible = true) {
    const progress = button.querySelector('.fa-launch-progress');
    const fill = button.querySelector('.fa-launch-progress .ip-fill');
    if (!progress || !fill) return;
    progress.classList.toggle('hidden', !visible);
    fill.style.width = total > 0 ? `${Math.round(completed * 100 / total)}%` : '0%';
  }

  function wait(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  function cancelMaximum(button) {
    if (button.dataset.launching !== 'true') return;
    button.dataset.cancelled = 'true';
  }

  async function launchMaximum(button) {
    if (button.disabled || typeof window.reviewDeployFleet !== 'function') return;
    const mission = document.querySelector('#fleet-mission-buttons .mission-btn.active')?.dataset.mission;
    if (mission === 'colonize' || mission === 'expedition') {
      window.alert('Launch maximum is not available for colonization or expedition fleets.');
      return;
    }

    const systemInput = document.getElementById('fleet-dest-system');
    const positionInput = document.getElementById('fleet-dest-position');
    const ships = selectedShips();
    const currentPosition = parseInt(positionInput?.value, 10);
    const system = parseInt(systemInput?.value, 10);
    if (!system || !currentPosition || Object.keys(ships).length === 0) return;

    button.disabled = true;
    try {
      const positions = (await systemPlanetPositions(system)).filter(position => position >= currentPosition);
      if (!positions.length) return;

      // A fleet uses the selected composition. The same fleet is repeated only
      // while every ship type and the fleet-command limit allow another launch.
      const count = Math.min(positions.length, possibleFleetCount(ships));
      if (!count) return;

      button.dataset.launching = 'true';
      delete button.dataset.cancelled;
      const wrapper = button.closest('.fa-launch-max-wrap');
      wrapper?.classList.add('fa-launching');
      button.title = 'Launching fleets';
      // The separate cancel control remains clickable while this launch
      // button itself stays disabled.
      setLaunchProgress(button, 0, count);

      // Reuse the same path as the normal +1 button. This keeps validation,
      // confirmation, resource refreshes, and all other game-side UI behavior
      // in the game's own review/submit flow rather than duplicating it here.
      for (let i = 0; i < count; i += 1) {
        if (button.dataset.cancelled === 'true') break;
        if (i > 0) await wait(1000);
        if (button.dataset.cancelled === 'true') break;
        if (!(await launchFleet())) break;
        if (button.dataset.cancelled === 'true') break;
        if (positions[i + 1] != null) setDestinationPosition(positions[i + 1]);
        setLaunchProgress(button, i + 1, count);
      }
    } finally {
      setLaunchProgress(button, 0, 0, false);
      delete button.dataset.launching;
      delete button.dataset.cancelled;
      button.closest('.fa-launch-max-wrap')?.classList.remove('fa-launching');
      button.disabled = false;
      updateMaximumButtonLabel(button);
      // The game's fleet refresh is asynchronous and may update the slot
      // counter shortly after submitDeployFleet() resolves.
      setTimeout(() => updateMaximumButtonLabel(button), 700);
    }
  }

  async function updateMaximumButtonLabel(button) {
    const systemInput = document.getElementById('fleet-dest-system');
    const positionInput = document.getElementById('fleet-dest-position');
    const system = parseInt(systemInput?.value, 10);
    const currentPosition = parseInt(positionInput?.value, 10);
    if (!button || !system || !currentPosition) return;

    const requestId = (parseInt(button.dataset.requestId, 10) || 0) + 1;
    button.dataset.requestId = requestId;
    const label = button.querySelector('.fa-launch-max-label');
    if (!label || button.dataset.launching === 'true') return;
    button.disabled = true;
    button.title = 'Checking target planets, available ships, and fleet slots…';
    label.textContent = 'Launch to …';
    let positions;
    try {
      positions = await systemPlanetPositions(system);
    } catch (error) {
      if (parseInt(button.dataset.requestId, 10) === requestId) {
        label.textContent = 'Launch to —';
        button.disabled = true;
        button.title = 'Cannot launch: no available target planets, ships, or fleet-command slots.';
      }
      return;
    }
    if (parseInt(button.dataset.requestId, 10) !== requestId) return;
    const remaining = positions.filter(position => position >= currentPosition);
    const ships = selectedShips();
    const count = Math.min(remaining.length, possibleFleetCount(ships));
    const canLaunch = count > 0;
    const reason = launchBlockReason(remaining, ships);
    label.textContent = canLaunch
      ? `Launch to ${currentPosition}-${remaining[count - 1]}`
      : 'Launch to —';
    button.disabled = !canLaunch;
    button.title = canLaunch
      ? 'Launch the selected fleet to every available planet in this displayed range.'
      : reason;
  }

  function installQuickDeployHook() {
    if (typeof window.quickDeployFleet !== 'function' || window.quickDeployFleet.faRangeHook) return;
    const originalQuickDeployFleet = window.quickDeployFleet;
    const wrappedQuickDeployFleet = async function (...args) {
      const result = await originalQuickDeployFleet.apply(this, args);
      // quickDeployFleet sets the destination fields programmatically after
      // refreshDeployForm(), so normal input/change listeners cannot reliably
      // observe the final values. Refresh after the whole operation completes.
      document.querySelectorAll('.fa-launch-max-btn').forEach(button => {
        setTimeout(() => updateMaximumButtonLabel(button), 250);
      });
      return result;
    };
    wrappedQuickDeployFleet.faRangeHook = true;
    window.quickDeployFleet = wrappedQuickDeployFleet;
  }

  function addLaunchButton() {
    installQuickDeployHook();
    const footer = document.querySelector('#deploy-fleet-frame .deploy-fleet-footer');
    const launchButton = footer && footer.querySelector('.deploy-launch-btn:not(.fa-launch-next-btn):not(.fa-launch-max-btn)');
    if (!launchButton || footer.querySelector('.fa-launch-next-btn')) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'deploy-launch-btn fa-launch-next-btn';
    button.textContent = 'Launch Fleet +1';
    button.title = 'Launch this fleet, then advance to the next planet';
    button.addEventListener('click', () => launchAndAdvance(button));

    const maxButton = document.createElement('button');
    maxButton.type = 'button';
    maxButton.className = 'deploy-launch-btn fa-launch-max-btn';
    maxButton.innerHTML = '<span class="fa-launch-max-label">Launch to …</span><span class="inline-progress fa-launch-progress hidden" aria-hidden="true"><span class="ip-track"><span class="ip-fill"></span></span></span>';
    maxButton.title = 'Cannot launch until the target range and available fleet resources are checked.';
    maxButton.disabled = true;
    maxButton.addEventListener('click', () => launchMaximum(maxButton));

    const maxWrap = document.createElement('span');
    maxWrap.className = 'fa-launch-max-wrap';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'fa-launch-cancel-btn';
    cancelButton.title = 'Cancel launching';
    cancelButton.setAttribute('aria-label', 'Cancel launching');
    cancelButton.innerHTML = '<span class="icon-slot" data-icon="cancel"></span>';
    cancelButton.addEventListener('click', event => {
      event.stopPropagation();
      cancelMaximum(maxButton);
    });
    maxWrap.append(maxButton, cancelButton);
    if (typeof window.fillIcons === 'function') window.fillIcons(cancelButton);

    launchButton.insertAdjacentElement('afterend', button);
    let labelTimer = null;
    const updateLabel = () => {
      if (labelTimer) clearTimeout(labelTimer);
      labelTimer = setTimeout(() => {
        labelTimer = null;
        updateMaximumButtonLabel(maxButton);
      }, 150);
    };
    document.getElementById('fleet-dest-system')?.addEventListener('input', updateLabel);
    document.getElementById('fleet-dest-system')?.addEventListener('change', updateLabel);
    document.getElementById('fleet-dest-position')?.addEventListener('input', updateLabel);
    document.getElementById('fleet-dest-position')?.addEventListener('change', updateLabel);

    // The game's arrow buttons and own-planet shortcut buttons change the
    // input value programmatically without emitting an input/change event.
    // Refresh after their click handlers have finished updating the fields.
    document.getElementById('deploy-fleet-frame')?.addEventListener('click', event => {
      if (!event.target.closest('.coord-input-row, #fleet-own-planet-shortcuts')) return;
      setTimeout(updateLabel, 0);
    });
    document.getElementById('fleet-ship-inputs')?.addEventListener('input', updateLabel);
    // The game's MIN/MAX and +/- controls change the quantity programmatically
    // and therefore do not emit an input event.
    document.getElementById('fleet-ship-inputs')?.addEventListener('click', () => {
      setTimeout(updateLabel, 0);
    });
    updateLabel();
    button.insertAdjacentElement('afterend', maxWrap);

  }

  let timer = null;
  function mutationTouchesDeployFrame(records) {
    return records.some(record => {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (target?.closest('#deploy-fleet-frame')) return true;
      if (record.type !== 'childList') return false;
      return Array.from(record.addedNodes).some(node =>
        node.nodeType === 1 && (node.matches('#deploy-fleet-frame') || node.querySelector('#deploy-fleet-frame'))
      );
    });
  }

  function schedule(records) {
    if (!mutationTouchesDeployFrame(records)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      addLaunchButton();
    }, 100);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  addLaunchButton();
})();
