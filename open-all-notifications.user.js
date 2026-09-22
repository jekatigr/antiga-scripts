// ==UserScript==
// @name         Fonte Antiga - Open All Notifications
// @namespace    fa.notifications-open-all
// @version      1.4.6
// @description  Open all notifications and mark them read without changing their appearance until leaving the current view
// @match        *://fonteantiga.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
    .fa-expand-unread-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 1.9rem;
      margin: 0;
      white-space: nowrap;
    }
  `;
  document.head.appendChild(style);

  // A read request is sent immediately, but its visual state is held until the
  // user leaves the current notification tab/page. This keeps the page stable
  // while still updating the server as soon as a notification is opened.
  const readRequests = new Map();
  let notificationsWasActive = false;
  let allNotificationsOpen = false;

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

  function updateNotificationTabState() {
    const panel = document.getElementById('panel-notifications');
    if (!panel) return;

    const isActive = panel.classList.contains('active');
    if (notificationsWasActive && !isActive) {
      allNotificationsOpen = false;
      finalizeReads();
      updateButton();
    }
    notificationsWasActive = isActive;
  }

  function toggleAllNotifications() {
    const cards = document.querySelectorAll('#notifications-container .notif-card');
    const rows = document.querySelectorAll('#notifications-container .notif-row');
    // v0.5.1 replaced expandable notification cards with selectable rows and
    // a split reader. Let the game's own row handler open/read each report.
    if (rows.length && !cards.length) {
      if (allNotificationsOpen) {
        document.querySelector('#notif-reader .notif-reader-back')?.click();
        allNotificationsOpen = false;
      } else {
        allNotificationsOpen = true;
        rows.forEach(row => row.click());
      }
      updateButton();
      return;
    }
    if (allNotificationsOpen) {
      allNotificationsOpen = false;
      cards.forEach(card => card.classList.remove('expanded'));
      // Closing the group is the point where the user has finished reviewing
      // the current page. Apply successful read results immediately instead of
      // keeping the unread styling until the Notifications tab is left.
      finalizeReads();
    } else {
      allNotificationsOpen = true;
      cards.forEach(card => {
        // Send the read request now, but keep the unread appearance until this
        // page/filter or the Notifications tab is left.
        requestRead(card);
        card.classList.add('expanded');
      });
    }
    updateButton();
  }

  function flushBeforeNotificationNavigation(event) {
    const target = event.target instanceof Element
      ? event.target.closest('.tab-btn[data-tab="notifications"], #notif-filter-bar .sub-tab-btn, #notif-scope-bar .sub-tab-btn, #notif-filter-list .notif-filter-row, #notif-pager #notif-prev, #notif-pager #notif-next')
      : null;
    if (!target || target.disabled) return;
    allNotificationsOpen = false;
    finalizeReads();
    updateButton();
  }

  function updateButton() {
    const bar = document.getElementById('notif-filter-bar')
      || document.querySelector('#panel-notifications .notif-toolbar');
    if (!bar) return;

    let button = document.querySelector('.fa-expand-unread-btn');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'action-btn fa-expand-unread-btn';
      button.addEventListener('click', toggleAllNotifications);
    }

    const readAllButton = document.getElementById('notif-read-all-btn');
    const clearButton = document.getElementById('notif-clear-btn');
    const anchor = readAllButton && readAllButton.parentElement === bar.querySelector('.notif-toolbar-actions') ? readAllButton : clearButton;
    if (anchor && anchor.parentElement && anchor.previousElementSibling !== button) {
      anchor.insertAdjacentElement('beforebegin', button);
    }

    const cards = document.querySelectorAll('#notifications-container .notif-card');
    const rows = document.querySelectorAll('#notifications-container .notif-row');
    const itemCount = cards.length || rows.length;
    if (itemCount === 0) allNotificationsOpen = false;
    button.disabled = itemCount === 0;
    const text = allNotificationsOpen ? 'Close all' : 'Open all';
    if (button.textContent !== text) button.textContent = text;
    const title = allNotificationsOpen
      ? 'Close all notifications shown on this page'
      : 'Open all notifications shown on this page; mark them read now but keep the unread style until you leave';
    if (button.title !== title) button.title = title;
  }

  let timer = null;
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      updateButton();
    }, 100);
  }

  const observer = new MutationObserver(records => {
    const relevant = records.some(record => {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (target?.closest('#panel-notifications')) return true;
      if (record.type !== 'childList') return false;
      return Array.from(record.addedNodes).some(node =>
        node.nodeType === 1 && (node.matches('#panel-notifications') || node.querySelector('#panel-notifications'))
      );
    });
    if (!relevant) return;
    updateNotificationTabState();
    // Do not wait for the debounce timer once cards are present. The
    // notifications panel can keep mutating classes while it finishes its
    // render, repeatedly postponing the timer and leaving Open all disabled.
    // A card insertion is enough information to enable the button now.
    if (document.querySelector('#notifications-container .notif-card')) {
      updateButton();
    } else {
      schedule();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  // Filter and pager buttons are re-rendered by the game, so use delegation.
  // Capture phase runs before the game's own click handlers start refreshing.
  document.addEventListener('click', flushBeforeNotificationNavigation, true);
  updateNotificationTabState();
  updateButton();
})();
