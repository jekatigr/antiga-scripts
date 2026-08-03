// ==UserScript==
// @name         Fonte Antiga - Fleet Block Order
// @namespace    fa.fleet-block-order
// @version      1.0.0
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

    const activeFrame = fleetsContainer.closest('fieldset.frame');
    if (!activeFrame || activeFrame.parentElement !== panel || deployFrame.parentElement !== panel) return;

    const lockedIsInPanel = lockedFrame && lockedFrame.parentElement === panel;
    const alreadyOrdered =
      deployFrame.nextElementSibling === activeFrame &&
      (!lockedIsInPanel || lockedFrame.nextElementSibling === deployFrame);
    if (alreadyOrdered) return;

    // Keep the locked message with the deploy block. It is hidden when deployment
    // is available, but should occupy the same position when it is shown.
    if (lockedIsInPanel) panel.insertBefore(lockedFrame, activeFrame);
    panel.insertBefore(deployFrame, activeFrame);
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
  observer.observe(document.body, { childList: true, subtree: true });

  moveFleetBlocks();
})();
