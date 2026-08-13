// ==UserScript==
// @name         Fonte Antiga - Expand Unread Notifications
// @namespace    fa.notifications-expand-unread
// @version      1.3.0
// @description  Open notifications and mark them read without changing their appearance until leaving the current view
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

  // A read request is sent immediately, but its visual state is held until the
  // user leaves the current notification tab/page. This keeps the page stable
  // while still updating the server as soon as a notification is opened.
  const readRequests = new Map();
  let notificationsWasActive = false;

  function getCardReadInfo(card) {
    const deleteButton = card.querySelector('[data-action="delete"][data-id]');
    if (!deleteButton) return null;

    const badge = card.querySelector('.card-badge');
    return {
      id: deleteButton.dataset.id,
      isGameNews: badge?.textContent.trim().toUpperCase() === 'GAME NEWS',
      card,
    };
  }

  function getReadKey(info) {
    return `${info.isGameNews ? 'news' : 'notification'}:${info.id}`;
  }

  function applyReadStyle(record) {
    if (!record.succeeded || !record.card.isConnected) return;
    record.card.classList.add('read');
    record.card.querySelector('.notif-unread-dot')?.remove();
  }

  function requestRead(card) {
    if (card.classList.contains('read')) return;

    const info = getCardReadInfo(card);
    if (!info) return;

    const key = getReadKey(info);
    let record = readRequests.get(key);
    if (!record) {
      record = { ...info, requested: false, succeeded: false };
      readRequests.set(key, record);
    }
    if (record.requested || record.succeeded) return;

    record.requested = true;
    const path = info.isGameNews ? `/game-news/${info.id}/read` : `/notifications/${info.id}/read`;
    record.promise = Promise.resolve()
      .then(() => {
        if (typeof window.req !== 'function') throw new Error('Game request helper unavailable');
        return window.req('POST', path);
      })
      .then(response => {
        if (!response || response.status < 200 || response.status >= 300) {
          throw new Error(`Read request failed: ${response?.status ?? 'no response'}`);
        }
        record.succeeded = true;
        if (!notificationsWasActive) applyReadStyle(record);
      })
      .catch(() => {
        // Allow a later click/navigation to retry a transient failure.
        record.requested = false;
      });
  }

  function finalizeReads() {
    const records = Array.from(readRequests.values());
    if (records.length === 0) return;

    // Do not race the badge refresh against the read POSTs. The cards can be
    // replaced by a page/filter refresh while this waits, which is intentional.
    Promise.all(records.map(record => record.promise)).then(() => {
      records.forEach(applyReadStyle);
      records.forEach(record => readRequests.delete(getReadKey(record)));
      if (typeof window.syncNotificationBadge === 'function') {
        return Promise.resolve(window.syncNotificationBadge()).catch(() => {});
      }
    });
  }

  function interceptNotificationOpen(event) {
    const target = event.target instanceof Element
      ? event.target.closest('.notif-summary')
      : null;
    if (!target || event.target.closest('[data-action="delete"]')) return;

    const card = target.closest('.notif-card');
    if (!card) return;

    // The game's handler marks the card visually before awaiting its API call.
    // Replace it so only the server-side read happens now.
    event.preventDefault();
    event.stopImmediatePropagation();
    card.classList.toggle('expanded');
    requestRead(card);
  }

  function updateNotificationTabState() {
    const panel = document.getElementById('panel-notifications');
    if (!panel) return;

    const isActive = panel.classList.contains('active');
    if (notificationsWasActive && !isActive) finalizeReads();
    notificationsWasActive = isActive;
  }

  function openAllNotifications() {
    const cards = document.querySelectorAll('#notifications-container .notif-card');
    cards.forEach(card => {
      // Send the read request now, but keep the unread appearance until this
      // page/filter or the Notifications tab is left.
      requestRead(card);
      card.classList.add('expanded');
    });
  }

  function flushBeforeNotificationNavigation(event) {
    const target = event.target instanceof Element
      ? event.target.closest('#notif-filter-bar .sub-tab-btn, #notif-pager #notif-prev, #notif-pager #notif-next')
      : null;
    if (!target || target.disabled) return;
    finalizeReads();
  }

  function updateButton() {
    const bar = document.getElementById('notif-filter-bar');
    if (!bar) return;

    let button = document.querySelector('.fa-expand-unread-btn');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'action-btn fa-expand-unread-btn';
      button.textContent = 'Open all';
      button.title = 'Open all notifications shown on this page; mark them read now but keep the unread style until you leave';
      button.addEventListener('click', openAllNotifications);
    }

    const clearButton = document.getElementById('notif-clear-btn');
    if (
      clearButton &&
      clearButton.parentElement === bar.parentElement &&
      clearButton.previousElementSibling !== button
    ) {
      clearButton.insertAdjacentElement('beforebegin', button);
    }

    const cards = document.querySelectorAll('#notifications-container .notif-card');
    button.disabled = cards.length === 0;
  }

  let timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      updateButton();
    }, 100);
  }

  const observer = new MutationObserver(() => {
    updateNotificationTabState();
    schedule();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });
  // Filter and pager buttons are re-rendered by the game, so use delegation.
  // Capture phase runs before the game's own click handlers start refreshing.
  document.addEventListener('click', interceptNotificationOpen, true);
  document.addEventListener('click', flushBeforeNotificationNavigation, true);
  updateNotificationTabState();
  updateButton();
})();
