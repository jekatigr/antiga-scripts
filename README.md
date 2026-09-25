# Fonte Antiga – Tampermonkey Scripts

Quality-of-life userscripts for [Fonte Antiga](https://fonteantiga.com), a browser-based space strategy game.

## Tested With

| Game Version |
|----------|
| 0.5.1 |

## Installation

1. Install the [Tampermonkey](https://tampermonkey.net/) browser extension.
2. Click a script name below to open its source file on GitHub.
3. On GitHub, click the **Raw** button in the upper-right corner of the file view.
4. Tampermonkey will detect the `.user.js` file and prompt you to install it — click **Install**.

Alternatively, right-click a script link → **Save As…** then in Tampermonkey go to **Dashboard → + (Create a new blank user script)** and paste the contents.

All scripts are self-contained and independent, so you can install any combination you like.

## Scripts

### [Universe Overview](https://github.com/jekatigr/antiga-scripts/blob/master/universe-overview.user.js)
Adds a Universe popup for your colonies and explored planets. Browse **My colonies** or **Explored planets**, then switch between colony overview, buildings, ships, and defenses. See resources, production, storage, capacities, queues, observed buildings, fleets, and defenses in one table, with search, sorting, filters, pagination, and per-colony update buttons. Voyager system-scan reports are expanded into individual explored-planet entries. The Explored planets view includes a per-page selector for 10, 20, 50, 100, 500, or 1000 rows. Use the Galaxy button beside a planet to jump directly to its galaxy system, or use the Explore button to launch the same exploration action available from the Galaxy planet list. It also highlights notification-related systems directly on the Galaxy map with filters for Planet exploration, System exploration, Expedition, Occupied, Attack, Transport, Harvest, and Other.

> **Note:** The Explored planets view shows information learned from exploration reports and notifications. Notification synchronization appears on the Explored planets tab with progress and a red **Force re-sync** option when you need to rebuild the complete history. On the My colonies tab, **Refresh all colonies** updates your colonies one by one and shows the current progress.

### [Fleet Block Order](https://github.com/jekatigr/antiga-scripts/blob/master/fleet-block-order.user.js)
Keeps the **Deploy Fleet** controls above your **Active Fleets**, so you can launch missions without scrolling back and forth.

### [Launch Fleet Range](https://github.com/jekatigr/antiga-scripts/blob/master/launch-fleet-and-advance.user.js)
Adds a range-labelled launch button next to the normal launch button. For example, **Launch to 5-20** repeats the currently selected fleet configuration for the planets at and after the current position, stopping at the first limit reached: available ships, remaining fleet-command slots, or planets left in the system. While launching, it shows progress and waits 1 second between fleets.

### [Resource Summary](https://github.com/jekatigr/antiga-scripts/blob/master/resource-summary.user.js)
Shows a **Σ total** beside resource amounts in exploration reports, battle results, harvest reports, and active fleet cargo, so you can see the combined haul without adding Metal, Silicon, and Helium yourself.

### [Explore From Nearest Colony](https://github.com/jekatigr/antiga-scripts/blob/master/explore-from-nearest-colony.user.js)
When you choose **Explore** in the Galaxy tab, opens the closest colony first so the fleet launches from a nearby location and uses less travel time.
