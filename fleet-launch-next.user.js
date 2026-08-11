// ==UserScript==
// @name         Fonte Antiga - Launch Fleet and Advance
// @namespace    fa.fleet-launch-next
// @version      1.1.0
// @description  Add a second fleet launch button that advances the destination planet after a successful launch
// @match        *://antiga.hatedabamboo.me/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
    .fa-launch-next-btn {
      background: var(--panel-alt);
      color: var(--fg);
      border-color: var(--border-soft);
    }
    .fa-launch-next-btn:hover {
      background: var(--panel);
      border-color: var(--accent);
    }
  `;
  document.head.appendChild(style);

  function advanceDestinationPlanet() {
    const input = document.getElementById('fleet-dest-position');
    if (!input) return;

    const minimum = parseInt(input.min, 10) || 1;
    const current = parseInt(input.value, 10) || minimum;
    input.value = Math.max(minimum, current + 1);
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

  async function launchAndAdvance(button) {
    if (button.disabled || typeof window.reviewDeployFleet !== 'function') return;

    button.disabled = true;
    try {
      if (await launchFleet()) advanceDestinationPlanet();
    } finally {
      button.disabled = false;
    }
  }

  function addLaunchButton() {
    const footer = document.querySelector('#deploy-fleet-frame .deploy-fleet-footer');
    const launchButton = footer && footer.querySelector('.deploy-launch-btn:not(.fa-launch-next-btn)');
    if (!launchButton || footer.querySelector('.fa-launch-next-btn')) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'deploy-launch-btn fa-launch-next-btn';
    button.textContent = 'Launch Fleet +1';
    button.title = 'Launch this fleet, then advance to the next planet';
    button.addEventListener('click', () => launchAndAdvance(button));
    launchButton.insertAdjacentElement('afterend', button);
  }

  let timer = null;
  function schedule() {
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
