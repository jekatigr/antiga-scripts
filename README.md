# Fonte Antiga – Tampermonkey Scripts

Quality-of-life userscripts for [Fonte Antiga](https://antiga.hatedabamboo.me), a browser-based space strategy game.

## Tested With

| Game Version |
|----------|
| 0.3.1 |

## Installation

1. Install the [Tampermonkey](https://tampermonkey.net/) browser extension
2. Click on any script below to open its source file
3. Tampermonkey will detect the `.user.js` and prompt you to install it — click **Install**

Alternatively, right-click a script link → **Save As…** then in Tampermonkey go to **Dashboard → + (Create a new blank user script)** and paste the contents.

## Scripts

### Fleet Block Order
Moves the "Deploy Fleet" block above the "Active Fleets" list on the fleets tab — no more scrolling back and forth between deployment controls and your active missions.

### Launch Fleet and Advance
Adds a **"Launch Fleet +1"** button next to the normal launch button. After a successful launch, it automatically increments the destination planet position by 1 — useful when launching fleets sequentially across multiple planets in the same system.

### Open All Notifications
Adds an **"Open all"** button to the notifications panel. One click expands every notification currently shown on the page; unread items are marked as read when leaving the Notifications tab or changing the notification page/filter.

### Resource Summary
Appends a **Σ total** value after the resource columns in notification cards (exploration reports, battle results, harvests) and active fleet cargo rows. Gives you a quick sense of total haul without mentally adding Metal + Silicon + Helium.

### Notification Target Systems
Automatically saves the system number from rendered notification targets and highlights those systems on the galaxy map. The map includes notification-type filters for Exploration, Attack, Transport, Harvest, Trade, and Other. Filter choices and saved targets persist in localStorage, and the map provides a button to clear all saved target systems.

### Full-Width Galaxy Map
Expands the galaxy map canvas to use the full width of the map frame instead of the game's default 640px limit, while keeping its default 640px height and circular system markers.

## Notes

- All scripts are self-contained and independent — install any combination you like
- Scripts use the game's own DOM structure and global functions (`req()`, `switchTab()`, etc.)
- If a script stops working after a game update, check that the relevant DOM elements still match what the script expects
