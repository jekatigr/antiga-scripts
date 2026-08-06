// ==UserScript==
// @name         Fonte Antiga - Fleet Block Order
// @namespace    fa.fleet-block-order
// @version      1.1.0
// @description  Place the Deploy Fleet block above the Active Fleets block
// @match        *://antiga.hatedabamboo.me/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const PANEL_SELECTOR = '#panel-fleets';
  const ACTIVE_FLEETS_SELECTOR = '#fleets-container';
  const DEPLOY_SELECTOR = '#deploy-fleet-frame';
  const LOCKED_SELECTOR = '#deploy-fleet-locked';

  function moveFleetBlocks() {
    const panel = document.querySelector(PANEL_SELECTOR);
    const fleetsContainer = document.querySelector(ACTIVE_FLEETS_SELECTOR);
    const deployFrame = document.querySelector(DEPLOY_SELECTOR);
    const lockedFrame = document.querySelector(LOCKED_SELECTOR);

    if (!panel || !fleetsContainer || !deployFrame) return;

    // Use the frame class rather than the element type: the game has changed
    // the wrapper markup between releases (fieldset/div), but the frame itself
    // remains the block that must be reordered.
    const activeFrame = fleetsContainer.closest('.frame');
    if (!activeFrame || activeFrame.parentElement !== panel || deployFrame.parentElement !== panel) return;

    const lockedIsInPanel = lockedFrame && lockedFrame.parentElement === panel;
    const alreadyOrdered =
      deployFrame.nextElementSibling === activeFrame &&
      (!lockedIsInPanel || lockedFrame.nextElementSibling === deployFrame);
    if (alreadyOrdered) return;

    // Move the deploy frame first, then put the locked notice immediately
    // before it. Doing this in the opposite order can leave the notice behind
    // the active-fleets block when the update renders `active, deploy, locked`.
    panel.insertBefore(deployFrame, activeFrame);
    if (lockedIsInPanel) panel.insertBefore(lockedFrame, deployFrame);
  }

  let timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      moveFleetBlocks();
    }, 100);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class']
  });

  moveFleetBlocks();
})();
