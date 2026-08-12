// ==UserScript==
// @name         Fonte Antiga - Dashboard Resource Separators
// @namespace    fa.dashboard-resource-separators
// @version      1.2.0
// @description  Add space separators to available and storage resource amounts on the dashboard
// @match        *://antiga.hatedabamboo.me/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const RESOURCE_VALUE = /(\d[\d, ]*)\s*\/\s*(\d[\d, ]*)\s*\(\s*(\d+)\s*%\s*\)/;
  const style = document.createElement('style');
  style.textContent = `
    .fa-resource-separators {
      font-size: 0 !important;
    }
    .fa-resource-separators::after {
      content: attr(data-fa-resource-text);
      color: var(--fa-resource-color);
      font-family: var(--fa-resource-font-family);
      font-size: var(--fa-resource-font-size);
      font-style: var(--fa-resource-font-style);
      font-weight: var(--fa-resource-font-weight);
      letter-spacing: var(--fa-resource-letter-spacing);
      line-height: var(--fa-resource-line-height);
    }
  `;
  document.documentElement.appendChild(style);

  function formatNumber(value) {
    const digits = value.replace(/[\s,]/g, '');
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  function formatResourceText(text) {
    return text.replace(RESOURCE_VALUE, (_, available, storage, percent) =>
      `${formatNumber(available)}/${formatNumber(storage)} (${percent}%)`
    );
  }

  function update() {
    const resourceBars = document.querySelectorAll('#resource-bars .res-bar-text, .res-bar-text');
    resourceBars.forEach((element) => {
      const match = element.textContent.match(RESOURCE_VALUE);
      // The game may replace the text node in several steps. Keep the last
      // formatted pseudo-value during a transient incomplete value instead of
      // revealing the raw text for a frame.
      if (!match) return;

      // Capture the original styles only once. Removing the class on every
      // update briefly paints the game's unformatted value and causes flicker.
      if (!element.classList.contains('fa-resource-separators')) {
        const computed = getComputedStyle(element);
        element.style.setProperty('--fa-resource-color', computed.color);
        element.style.setProperty('--fa-resource-font-family', computed.fontFamily);
        element.style.setProperty('--fa-resource-font-size', computed.fontSize);
        element.style.setProperty('--fa-resource-font-style', computed.fontStyle);
        element.style.setProperty('--fa-resource-font-weight', computed.fontWeight);
        element.style.setProperty('--fa-resource-letter-spacing', computed.letterSpacing);
        element.style.setProperty('--fa-resource-line-height', computed.lineHeight);
      }
      element.dataset.faResourceText = formatResourceText(element.textContent);
      element.classList.add('fa-resource-separators');
    });
  }

  function schedule() {
    // MutationObserver runs before the next paint, so update synchronously.
    update();
  }

  function start() {
    update();

    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  if (document.body) {
    start();
  } else {
    new MutationObserver((_, observer) => {
      if (!document.body) return;
      observer.disconnect();
      start();
    }).observe(document.documentElement, { childList: true, subtree: true });
  }
})();
