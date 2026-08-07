// ==UserScript==
// @name         Fonte Antiga - Full-Width Galaxy Map
// @namespace    fa.galaxy-map-full-width
// @version      1.0.3
// @description  Expand the galaxy map canvas to the full width of its frame
// @match        *://antiga.hatedabamboo.me/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
    .galaxy-map-wrap.fa-full-width-map {
      width: 100%;
      max-width: none;
    }

    .galaxy-map-wrap.fa-full-width-map .galaxy-map-canvas {
      width: 100%;
      max-width: none;
      height: 640px !important;
      min-height: 640px;
      max-height: 640px;
      aspect-ratio: auto !important;
    }
  `;
  document.head.appendChild(style);

  const MAP_HEIGHT = 640;

  function resizeCanvasToDisplayWidth(canvas) {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    if (canvas.width === width && canvas.height === MAP_HEIGHT) return false;

    // Match the drawing buffer to the wide CSS box. The game's renderer uses
    // the shorter canvas dimension for its map scale, so systems stay round
    // instead of being stretched into horizontal ovals.
    canvas.width = width;
    canvas.height = MAP_HEIGHT;
    return true;
  }

  function redrawMap() {
    const body = document.getElementById('galaxy-map-body');
    if (!body || body.classList.contains('hidden')) return;
    if (typeof window.drawGalaxyMap !== 'function') return;

    window.drawGalaxyMap();
    // The notification-target script paints its markers after the game's map
    // renderer. Request that overlay again after changing the canvas buffer.
    window.dispatchEvent(new Event('fa-target-system-markers-changed'));
  }

  const resizeObserver = typeof ResizeObserver === 'function'
    ? new ResizeObserver(entries => {
        let changed = false;
        entries.forEach(({ target }) => {
          changed = resizeCanvasToDisplayWidth(target) || changed;
        });
        if (changed) redrawMap();
      })
    : null;

  function update() {
    document.querySelectorAll('.galaxy-map-wrap').forEach(wrap => {
      wrap.classList.add('fa-full-width-map');
      const canvas = wrap.querySelector('.galaxy-map-canvas');
      if (!canvas) return;

      canvas.style.height = `${MAP_HEIGHT}px`;
      canvas.style.aspectRatio = 'auto';
      if (resizeObserver && !canvas.dataset.faResolutionBound) {
        canvas.dataset.faResolutionBound = '1';
        resizeObserver.observe(canvas);
      }
      if (resizeCanvasToDisplayWidth(canvas)) redrawMap();
    });
  }

  let timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      update();
    }, 150);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });

  update();
})();
