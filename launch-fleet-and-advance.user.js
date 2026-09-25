// ==UserScript==
// @name         Fonte Antiga - Launch Fleet and Advance
// @namespace    fa.fleet-launch-next
// @version      1.4.28
// @description  Add a range launch button to send the selected fleet to multiple destinations
// @match        *://fonteantiga.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
    .fa-launch-max-btn {
      background: var(--panel-alt);
      color: var(--fg);
      border-color: var(--border-soft);
    }
    .fa-launch-max-btn {
      position: relative;
      width: 11rem;
      min-width: 11rem;
      box-sizing: border-box;
      white-space: nowrap;
      overflow: hidden;
    }
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
    .fa-launch-actions {
      display: flex;
      flex: none;
      flex-wrap: nowrap;
      align-items: stretch;
      gap: 0.65rem;
      margin-left: auto;
    }
    .fa-launch-actions .fa-launch-max-wrap {
      position: relative;
      display: flex;
      align-items: stretch;
    }
    .fa-launch-actions .fa-launch-max-btn {
      height: 100%;
      min-height: 0;
    }
    .fa-launch-actions .fa-launch-max-wrap {
      align-self: stretch;
      height: auto !important;
    }
    .fa-launch-actions .fa-launch-max-btn {
      height: 100% !important;
    }
    .fa-launch-max-wrap .fa-launch-max-btn {
      padding-right: 2.1em;
    }
    .fa-launch-cancel-btn {
      display: none;
      position: absolute;
      right: 0.35em;
      top: 0;
      bottom: 0;
      z-index: 3;
      margin-block: auto;
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
    .fa-launch-max-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
    }
    .fa-launch-max-icon svg {
      width: 1em;
      height: 1em;
    }
    @media (max-width: 1280px) {
      #fleet-launch-line {
        display: flex;
        flex-wrap: wrap;
        align-items: stretch;
      }
      #fleet-launch-line > .launch-cell {
        flex: 0 0 auto;
        width: max-content;
        min-width: max-content;
        box-sizing: border-box;
        gap: 5px;
      }
      #fleet-launch-line .launch-cell-label {
        font-size: calc(var(--fs-xs) * .8);
      }
      #fleet-launch-line .launch-cell-value {
        font-size: calc(var(--fs-base) * .8);
      }
      .fa-launch-actions {
        gap: .35rem;
      }
      .fa-launch-actions .fa-launch-max-wrap {
        align-self: stretch;
        height: auto !important;
      }
      .fa-launch-actions .fa-launch-max-btn {
        height: 100% !important;
      }
      .fa-launch-actions > .fa-launch-primary {
        width: 2.5rem;
        min-width: 2.5rem;
        padding: .3rem .5rem;
      }
      .fa-launch-actions > .fa-launch-primary > span {
        display: none !important;
      }
      .fa-launch-actions .fa-launch-max-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: auto;
        min-width: 3.8rem;
        height: 100%;
        padding: .3rem .5rem;
        text-align: center;
      }
      .fa-launch-max-label-prefix {
        display: none;
      }
      .fa-launch-max-label-range {
        white-space: nowrap;
      }
    }
  `;
  document.head.appendChild(style);

  function setDestinationPosition(position) {
    const input = document.getElementById('fleet-dest-position');
    if (!input || !Number.isInteger(position)) return;
    input.value = position;
    input.dispatchEvent(new Event('input', { bubbles: true }));
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

      // Reuse the game's review/submit flow so validation, confirmation,
      // resource refreshes, and all other game-side UI behavior stay native.
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
      scheduleMaximumButtonLabelUpdate(button, 0);
      // The game's fleet refresh is asynchronous and may update the slot
      // counter shortly after submitDeployFleet() resolves.
      scheduleMaximumButtonLabelUpdate(button, 700);
    }
  }

  const labelUpdateTimers = new WeakMap();

  function scheduleMaximumButtonLabelUpdate(button, delay = 150) {
    if (!button) return;
    const previousTimer = labelUpdateTimers.get(button);
    if (previousTimer) clearTimeout(previousTimer);
    const timer = setTimeout(() => {
      labelUpdateTimers.delete(button);
      updateMaximumButtonLabel(button);
    }, delay);
    labelUpdateTimers.set(button, timer);
  }

  async function updateMaximumButtonLabel(button) {
    const systemInput = document.getElementById('fleet-dest-system');
    const positionInput = document.getElementById('fleet-dest-position');
    const system = parseInt(systemInput?.value, 10);
    const currentPosition = parseInt(positionInput?.value, 10);
    if (!button || !system || !currentPosition) return;

    const requestId = (parseInt(button.dataset.requestId, 10) || 0) + 1;
    button.dataset.requestId = requestId;
    const label = button.querySelector('.fa-launch-max-label-range');
    if (!label || button.dataset.launching === 'true') return;
    // Keep the current visual state while the debounced check is in flight.
    // Toggling disabled/label here made overlapping refreshes appear as
    // disabled → enabled → disabled sequences.
    button.dataset.rangeUpdating = 'true';
    let positions;
    try {
      positions = await systemPlanetPositions(system);
    } catch (error) {
      if (parseInt(button.dataset.requestId, 10) === requestId) {
        // A timeout or transient API failure must not strand the button in a
        // disabled state. Keep the last known state and let a later fleet or
        // form refresh retry the calculation.
        delete button.dataset.rangeUpdating;
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
      ? (count === 1 ? String(currentPosition) : `${currentPosition}-${remaining[count - 1]}`)
      : '—';
    button.disabled = !canLaunch;
    button.title = canLaunch
      ? 'Launch the selected fleet to every available planet in this displayed range.'
      : reason;
    delete button.dataset.rangeUpdating;
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
        scheduleMaximumButtonLabelUpdate(button, 250);
      });
      return result;
    };
    wrappedQuickDeployFleet.faRangeHook = true;
    window.quickDeployFleet = wrappedQuickDeployFleet;
  }

  function placeLaunchActions(footer, launchButton, maxWrap) {
    let actions = footer.querySelector('.fa-launch-actions');
    if (!actions) {
      actions = document.createElement('div');
      actions.className = 'fa-launch-actions';
      launchButton.insertAdjacentElement('beforebegin', actions);
    }
    launchButton.classList.add('fa-launch-primary');
    if (!actions.contains(launchButton)) actions.appendChild(launchButton);
    if (!actions.contains(maxWrap)) actions.appendChild(maxWrap);

    // The game may give Launch Fleet a context-dependent height. Match that
    // rendered height exactly so the adjacent range button forms one action row.
    requestAnimationFrame(() => {
      const height = launchButton.getBoundingClientRect().height;
      if (Number.isFinite(height) && height > 0) {
        maxWrap.style.height = `${height}px`;
        maxWrap.querySelector('.fa-launch-max-btn').style.height = `${height}px`;
      }
    });
  }

  function addLaunchButton() {
    installQuickDeployHook();
    const footer = document.querySelector('#deploy-fleet-frame .deploy-fleet-footer');
    const launchButton = footer && footer.querySelector('.deploy-launch-btn:not(.fa-launch-max-btn)');
    if (!launchButton) return;

    const existingWrap = footer.querySelector('.fa-launch-max-wrap');
    if (existingWrap) {
      placeLaunchActions(footer, launchButton, existingWrap);
      return;
    }

    const maxButton = document.createElement('button');
    maxButton.type = 'button';
    maxButton.className = 'deploy-launch-btn fa-launch-max-btn';
    const maxIcon = document.createElement('span');
    maxIcon.className = 'fa-launch-max-icon';
    maxIcon.setAttribute('aria-hidden', 'true');
    const launchIcon = launchButton.querySelector('svg');
    if (launchIcon) maxIcon.appendChild(launchIcon.cloneNode(true));
    maxButton.appendChild(maxIcon);
    const maxLabel = document.createElement('span');
    maxLabel.className = 'fa-launch-max-label';
    maxLabel.innerHTML = '<span class="fa-launch-max-label-prefix">Launch to </span><span class="fa-launch-max-label-range">…</span>';
    maxButton.appendChild(maxLabel);
    const progress = document.createElement('span');
    progress.className = 'inline-progress fa-launch-progress hidden';
    progress.setAttribute('aria-hidden', 'true');
    progress.innerHTML = '<span class="ip-track"><span class="ip-fill"></span></span>';
    maxButton.appendChild(progress);
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

    let labelTimer = null;
    const updateLabel = () => {
      if (labelTimer) clearTimeout(labelTimer);
      labelTimer = setTimeout(() => {
        labelTimer = null;
        scheduleMaximumButtonLabelUpdate(maxButton);
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
    placeLaunchActions(footer, launchButton, maxWrap);

  }

  let timer = null;
  let rangeUpdateTimer = null;

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

  function mutationTouchesFleetAvailability(records) {
    return records.some(record => {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      // Watch only the availability counters. Observing #fleets-container here
      // can race the game's active-fleet renderer while it replaces its cards.
      if (target?.closest('#fleets-stat-fcc-slots, #fleet-ship-inputs')) return true;
      if (record.type !== 'childList') return false;
      return Array.from(record.addedNodes).some(node =>
        node.nodeType === 1 && (
          node.matches('#fleets-stat-fcc-slots, #fleet-ship-inputs') ||
          node.querySelector('#fleets-stat-fcc-slots, #fleet-ship-inputs')
        )
      );
    });
  }

  // Fleet completion refreshes the active-fleet list and the ship/slot
  // counters asynchronously. Debounce this separately from the deploy-frame
  // installer so a burst of mutations produces one range check, not one
  // request per DOM mutation.
  function scheduleRangeButtonUpdate() {
    if (rangeUpdateTimer) clearTimeout(rangeUpdateTimer);
    rangeUpdateTimer = setTimeout(() => {
      rangeUpdateTimer = null;
      document.querySelectorAll('.fa-launch-max-btn').forEach(button => scheduleMaximumButtonLabelUpdate(button, 0));
    }, 200);
  }

  function schedule(records) {
    if (mutationTouchesDeployFrame(records)) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        addLaunchButton();
      }, 100);
    }
    if (mutationTouchesFleetAvailability(records)) scheduleRangeButtonUpdate();
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  addLaunchButton();
})();
