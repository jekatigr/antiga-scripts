// ==UserScript==
// @name         Fonte Antiga - Expand Unread Notifications
// @namespace    fa.notifications-expand-unread
// @version      1.0.0
// @description  Add a button that expands and marks all shown unread notifications as read
// @match        *://antiga.hatedabamboo.me/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
    .fa-expand-unread-btn {
      white-space: nowrap;
    }
  `;
  document.head.appendChild(style);

  function updateButton() {
    const bar = document.getElementById('notif-filter-bar');
    if (!bar) return;

    let button = document.querySelector('.fa-expand-unread-btn');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'action-btn fa-expand-unread-btn';
      button.textContent = 'Expand unread';
      button.title = 'Expand and mark all shown unread notifications as read';
      button.addEventListener('click', () => {
        const unreadCards = document.querySelectorAll(
          '#notifications-container .notif-card:not(.read)'
        );

        unreadCards.forEach(card => {
          // Use the game's own click handler so it marks both notifications and
          // game news as read through the correct API endpoint.
          card.querySelector('.notif-summary')?.click();
          card.classList.add('expanded');
        });
      });
    }

    const clearButton = document.getElementById('notif-clear-btn');
    if (
      clearButton &&
      clearButton.parentElement === bar.parentElement &&
      clearButton.previousElementSibling !== button
    ) {
      clearButton.insertAdjacentElement('beforebegin', button);
    }

    const unreadCards = document.querySelectorAll(
      '#notifications-container .notif-card:not(.read)'
    );
    button.disabled = unreadCards.length === 0;
  }

  let timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      updateButton();
    }, 100);
  }

  const observer = new MutationObserver(schedule);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });
  updateButton();
})();
