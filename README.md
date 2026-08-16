# Fonte Antiga – Tampermonkey Scripts

Quality-of-life userscripts for [Fonte Antiga](https://antiga.hatedabamboo.me), a browser-based space strategy game.

## Tested With

| Game Version |
|----------|
| 0.3.3 |

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
Adds an **"Open all"** button to the notifications panel. One click expands every unread notification currently shown and marks them read on the server immediately, while preserving their unread appearance until leaving the Notifications tab or changing the page/filter. Individual notification clicks retain the game's normal behavior.

### Resource Summary
Appends a **Σ total** value after the resource columns in notification cards (exploration reports, battle results, harvests) and active fleet cargo rows. Gives you a quick sense of total haul without mentally adding Metal + Silicon + Helium.

### Dashboard Resource Separators
Adds spaces between thousands in the dashboard's available/storage resource amounts, so `100000/7654321` is displayed as `100 000/7 654 321`.

### Notification Cache
`Universe Overview` and `Notification Target Systems` include the same singleton notification-cache service. Whichever script is installed starts one shared service that captures notification responses already requested by the game and keeps the shared `fa.notifications` IndexedDB cache synchronized. The initial backfill is delayed and serialized, and unread increases schedule a short follow-up sync so normal game startup remains responsive. Updates are broadcast to all installed consumers.

### Notification Target Systems
Reads the shared notification cache directly from IndexedDB when the Galaxy tab opens, then marks matching systems on the map in memory. It does not persist notification marks in localStorage. Notification-type filters persist in localStorage.

### Full-Width Galaxy Map
Expands the galaxy map canvas to use the full width of the map frame instead of the game's default 640px limit, while keeping its default 640px height and circular system markers.

### Explore From Nearest Colony
Changes the Galaxy tab's **Explore** action to open the closest owned colony before preparing the exploration fleet, using the galaxy system coordinates and planet position as a tie-breaker.

### Universe Overview
Adds a locally persisted Universe Overview table with **My colonies** and **Explored planets** tabs. My colonies contains Overview, Buildings, Ships, and Defenses subtabs; inventory subtabs add one quantity column per observed item across the colonies. Building, ship, and defense queue quantities appear as compact second-line text in the matching item cell, with the per-item build duration when available. My-colony rows are not expandable. Fewer than 100 owned colonies remain on one page; larger owned lists use the existing 20-row pagination, while explored results retain their existing pagination. It passively observes successful planet API responses already requested by the game and reads the shared notification cache; notification synchronization is handled by the delayed, serialized shared cache service, with no automatic game polling requests. A button above the table updates every owned colony one by one with a short delay, displays batch progress, and stays disabled while the batch is in progress; each row also has a manual update button beside the planet name. With default sorting, the last colony opened from the game sidebar is highlighted and pinned to the first row; after sorting a column, it follows the selected sort order. Unknown data remains marked as unknown rather than being fetched automatically.

## Notes

- All scripts are self-contained and independent — install any combination you like
- Scripts use the game's own DOM structure and global functions (`req()`, `switchTab()`, etc.)
- If a script stops working after a game update, check that the relevant DOM elements still match what the script expects
