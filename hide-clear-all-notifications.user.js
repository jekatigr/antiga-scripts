// ==UserScript==
// @name         Fonte Antiga - Hide Clear All Notifications
// @namespace    fa.hide-clear-all-notifications
// @version      1.0.0
// @description  Hides the Clear All button in the notifications panel.
// @match        *://fonteantiga.com/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = '#notif-clear-btn { display: none !important; }';
  (document.head || document.documentElement).appendChild(style);
})();
