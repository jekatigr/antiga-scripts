// ==UserScript==
// @name         Fonte Antiga - Expand Unread Notifications
// @namespace    fa.notifications-expand-unread
// @version      1.1.0
// @description  Add a button that opens all notifications shown on the current page
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

  const pendingReads = new Map();
  let notificationsWasActive = false;
  let flushingReads = false;

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

  function deferUnreadCard(card) {
    if (card.classList.contains('read')) return;

    const info = getCardReadInfo(card);
    if (!info) return;
    pendingReads.set(`${info.isGameNews ? 'news' : 'notification'}:${info.id}`, info);
  }

  async function markDeferredReads() {
    if (flushingReads || pendingReads.size === 0) return;
    flushingReads = true;
    const reads = Array.from(pendingReads.values());
    pendingReads.clear();

    try {
      for (const { id, isGameNews, card } of reads) {
        const path = isGameNews ? `/game-news/${id}/read` : `/notifications/${id}/read`;
        if (typeof window.req === 'function') {
          await window.req('POST', path);
        } else {
          // Fallback for a page where the game's request helper is not exposed.
          card.querySelector('.notif-summary')?.click();
        }
        card.classList.add('read');
        card.querySelector('.notif-unread-dot')?.remove();
      }
      if (typeof window.syncNotificationBadge === 'function') {
        await window.syncNotificationBadge();
      }
    } finally {
      flushingReads = false;
    }
  }

  function updateNotificationTabState() {
    const panel = document.getElementById('panel-notifications');
    if (!panel) return;

    const isActive = panel.classList.contains('active');
    if (notificationsWasActive && !isActive) markDeferredReads();
    notificationsWasActive = isActive;
  }

  function openAllNotifications() {
    const cards = document.querySelectorAll('#notifications-container .notif-card');
    cards.forEach(card => {
      deferUnreadCard(card);
      // Do not invoke the game's summary handler here: it marks a notification
      // read immediately. The queued unread cards are marked when this tab is
      // left instead.
      card.classList.add('expanded');
    });
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
      button.title = 'Open all notifications shown on this page; mark new ones read when you leave';
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
  updateNotificationTabState();
  updateButton();
})();
