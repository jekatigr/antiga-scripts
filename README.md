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
Adds an **"Open all"** button to the notifications panel. One click expands every notification currently shown and marks unread items read on the server immediately, while preserving their unread appearance until leaving the Notifications tab or changing the page/filter. Clicking an individual notification behaves the same way.

### Resource Summary
Appends a **Σ total** value after the resource columns in notification cards (exploration reports, battle results, harvests) and active fleet cargo rows. Gives you a quick sense of total haul without mentally adding Metal + Silicon + Helium.

### Dashboard Resource Separators
Adds spaces between thousands in the dashboard's available/storage resource amounts, so `100000/7654321` is displayed as `100 000/7 654 321`.

### Notification Target Systems
When the Galaxy tab opens, downloads all regular notifications in pages of 10 with a one-second pause between requests. Complete notification objects are cached in IndexedDB, and later syncs download only missing records. A progress bar shows the sync status, then the script rebuilds target-system highlights from the cached data. The map includes notification-type filters for Exploration, Attack, Transport, Harvest, Trade, and Other; filter choices persist in localStorage.

### Full-Width Galaxy Map
Expands the galaxy map canvas to use the full width of the map frame instead of the game's default 640px limit, while keeping its default 640px height and circular system markers.

### Planets Summary
Adds a locally persisted Planet Summary table with separate **My planets** and **Explored planets** tabs. My planets show current API-observed economy, queues, buildings, defenses, stationed ships, and active fleets; explored planets show only information that can be known from notifications, without pretending to know private queues or current resources. Report-count columns were replaced with known Buildings and Known fleet information; explored rows do not show actions. Results are paginated at 20 rows per page so large notification caches are not rendered into the DOM at once. It passively observes successful API responses already requested by the game for planet data; it does not automatically request or synchronize anything. Owned-planet rows also have an optional manual update button. The overview is refreshed automatically from the live sidebar, intercepted game API responses, and local IndexedDB caches; opening and closing the popup only changes its visibility. The table combines current observed planet/economy/building/defense/queue data with read-only historical intelligence from the notification cache created by Notification Target Systems. Every category displays its own relative observation or report age. Unknown planets and fields remain marked as unknown rather than being fetched automatically.

## Notes

- All scripts are self-contained and independent — install any combination you like
- Scripts use the game's own DOM structure and global functions (`req()`, `switchTab()`, etc.)
- If a script stops working after a game update, check that the relevant DOM elements still match what the script expects
