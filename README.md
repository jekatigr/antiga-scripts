# Fonte Antiga – Tampermonkey Scripts

Quality-of-life userscripts for [Fonte Antiga](https://antiga.hatedabamboo.me), a browser-based space strategy game.

## Tested With

| Game Version |
|----------|
| 0.5.0 |

## Installation

1. Install the [Tampermonkey](https://tampermonkey.net/) browser extension.
2. Click a script name below to open its source file on GitHub.
3. On GitHub, click the **Raw** button in the upper-right corner of the file view.
4. Tampermonkey will detect the `.user.js` file and prompt you to install it — click **Install**.

Alternatively, right-click a script link → **Save As…** then in Tampermonkey go to **Dashboard → + (Create a new blank user script)** and paste the contents.

All scripts are self-contained and independent, so you can install any combination you like.

## Scripts

### [Universe Overview](https://github.com/jekatigr/antiga-scripts/blob/master/universe-overview.user.js)
Adds an overview popup for your colonies and explored planets. Browse **My colonies** or **Explored planets**, then switch between colony overview, buildings, ships, and defenses. See resources, production, storage, capacities, queues, observed buildings, fleets, and defenses in one table, with search, sorting, filters, pagination, and per-colony update buttons. Voyager system-scan reports are expanded into individual explored-planet entries. The Explored planets view includes a per-page selector for 10, 20, 50, 100, 500, or 1000 rows. Use the Galaxy button beside a planet to jump directly to its galaxy system, or use the Explore button to launch the same exploration action available from the Galaxy planet list.

> **Note:** The Explored planets view shows information learned from exploration reports and notifications. Notification synchronization appears on the Explored planets tab with progress and a red **Force re-sync** option when you need to rebuild the complete history. On the My colonies tab, **Refresh all colonies** updates your colonies one by one and shows the current progress.

### [Fleet Block Order](https://github.com/jekatigr/antiga-scripts/blob/master/fleet-block-order.user.js)
Keeps the **Deploy Fleet** controls above your **Active Fleets**, so you can launch missions without scrolling back and forth.

### [Launch Fleet and Advance](https://github.com/jekatigr/antiga-scripts/blob/master/launch-fleet-and-advance.user.js)
Adds **Launch Fleet +1** and a range-labelled launch button next to the normal launch button. After each successful launch, **Launch Fleet +1** advances the destination position by one. The range-labelled button, for example **Launch to 5-20**, repeats the currently selected fleet configuration for the planets at and after the current position, stopping at the first limit reached: available ships, remaining fleet-command slots, or planets left in the system. While launching, it shows progress and waits 1 second between fleets.

### [Open All Notifications](https://github.com/jekatigr/antiga-scripts/blob/master/open-all-notifications.user.js)
Adds **Open all** to the Notifications panel. It expands every notification currently shown and marks them as read, while keeping their unread appearance until you leave the current page or notification view.

### [Resource Summary](https://github.com/jekatigr/antiga-scripts/blob/master/resource-summary.user.js)
Shows a **Σ total** beside resource amounts in exploration reports, battle results, harvest reports, and active fleet cargo, so you can see the combined haul without adding Metal, Silicon, and Helium yourself.

### [Dashboard Resource Separators](https://github.com/jekatigr/antiga-scripts/blob/master/dashboard-resource-separators.user.js)
Makes large resource values easier to read by separating thousands. For example, `100000/7654321` becomes `100 000/7 654 321`.

### [Notification Target Systems](https://github.com/jekatigr/antiga-scripts/blob/master/notification-target-systems.user.js)
Highlights relevant systems directly on the Galaxy map based on your notification history. Use separate filters for Planet exploration and System exploration, plus Expedition, Occupied, Attack, Transport, Harvest, Trade, and Other.

### [Full-Width Galaxy Map](https://github.com/jekatigr/antiga-scripts/blob/master/full-width-galaxy-map.user.js)
Expands the Galaxy map to use the available width of the map frame, giving you more room to view distant systems while keeping the normal map height and system markers.

### [Explore From Nearest Colony](https://github.com/jekatigr/antiga-scripts/blob/master/explore-from-nearest-colony.user.js)
When you choose **Explore** in the Galaxy tab, opens the closest colony first so the fleet launches from a nearby location and uses less travel time.
