# Fonte Antiga – Tampermonkey Scripts

Quality-of-life userscripts for [Fonte Antiga](https://antiga.hatedabamboo.me), a browser-based space strategy game.

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

### Fleet Target Button
Turns each owned planet's coordinates (in the right sidebar) into a clickable target control. Clicking fills that planet's system and position into the fleet command destination fields, so you can quickly set your own planets as transport or attack targets without manually typing coordinates.

### Expand Unread Notifications
Adds an **"Expand unread"** button to the notifications panel. One click expands all currently visible unread notifications and marks them as read — no need to click each one individually.

### Resource Summary
Appends a **Σ total** value after the resource columns in notification cards (exploration reports, battle results, harvests) and active fleet cargo rows. Gives you a quick sense of total haul without mentally adding Metal + Silicon + Helium.

## Notes

- All scripts are self-contained and independent — install any combination you like
- Scripts use the game's own DOM structure and global functions (`req()`, `switchTab()`, etc.)
- If a script stops working after a game update, check that the relevant DOM elements still match what the script expects
