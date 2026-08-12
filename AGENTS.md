# Fonte Antiga – Tampermonkey Scripts

Browser-based space strategy game at `https://antiga.hatedabamboo.me`.  
This project contains Tampermonkey userscripts to enhance gameplay.

## Source snapshots

The `sources/` folder is a separate Git repository nested inside this project. It must contain only saved game source snapshots (HTML, JavaScript, CSS, and required assets) used as local reference when checking compatibility. Commit source snapshot changes in the `sources/` repository itself with `git -C sources ...`; do not add userscripts, project documentation, or other project files there.

## Game Overview

- **Resources:** Metal (M), Silicon (S), Helium (H)
- **Planets:** Player-owned planets with production buildings, storage, shipyards
- **Planet features:** Ausente relics (`has_relic_building`), stellar objects (`has_stellar_object_feature`, `stellar_object_name`, `stellar_object_description`) — both provide resource income bonuses
- **Fleet actions:** Explore, Colonize, Attack, Transport, Harvest debris
- **Notifications:** Exploration reports, battle results, transport deliveries, harvest results, incoming attacks

## Architecture

### API

All server calls go through `/api/*` (cookie-based auth). The game uses a shared `req()` helper:

```js
// req(method, path, body) → { status, body }
req('GET', '/notifications?limit=10&offset=0')
req('GET', '/notifications/unread-count')
req('POST', `/notifications/${id}/read`)
req('DELETE', `/notifications/${id}`)
req('DELETE', '/notifications?mission_type=transport')
```

#### Known Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/notifications` | Paginated notifications (`limit`, `offset`, `mission_type`) |
| GET | `/notifications/unread-count` | `{ unread_count: N }` |
| GET | `/notifications/by-fleet/:id` | Single notification by fleet ID |
| POST | `/notifications/:id/read` | Mark as read |
| DELETE | `/notifications/:id` | Dismiss one |
| DELETE | `/notifications` or `?mission_type=X` | Clear all / by type |
| GET | `/game-news` | Game news list |
| GET | `/game-news/unread-count` | `{ unread_count: N }` |
| DELETE | `/game-news/:id` | Dismiss game news |
| GET | `/planets/:id` | Planet details (name, system, position, distance, temperature, zone, `has_relic_building`, `has_stellar_object_feature`, `stellar_object_name`, `stellar_object_description`) |
| GET | `/planets/:id/resources` | Current resources, capacities, production rates, income breakdown, and colony pools |
| GET | `/planets/:id/buildings` | Building levels, effects, workloads, and upgrade metadata |
| GET | `/planets/:id/build-queue` | Construction queue |
| GET | `/planets/:id/research-queue` | Research queue |
| GET | `/planets/:id/ship-queue` | Ship construction queue |
| GET | `/planets/:id/defense-queue` | Defense construction queue |
| GET | `/planets/:id/defenses` | Planetary defense inventory and stats |
| GET | `/planets/:id/ships` | Stationed ship inventory and stats |
| GET | `/fleets?active=true` | Active outbound/inbound fleets, ships, cargo, mission, and timing |

#### Notification Types

- `attack_incoming` – enemy fleet inbound
- `planet_scanned` – another player scanned your planet
- `scan_repelled` – your defenses destroyed an exploration fleet before its scan completed
- `exploration_lost` – exploration fleet destroyed
- `exploration` – exploration report (buildings, fleet, resources, debris). May include `stellar_object_detected`, `stellar_object_name`, `stellar_object_description` when a stellar object is found via Voyager Probe
- `transport_delivered` / `transport_gathered` – resource transfer
- `debris_harvested` – harvest result (metal + silicon only, no helium)
- `relocate_arrived` – fleet relocation
- `recover_gathered` – recovered population and automatons
- `battle_report` – attack/defense outcome with loot

#### Representative notification object shapes

These examples document fields used by the saved notification renderer and summary script; they are representative contracts, not a dump of a live account database:

```js
{
  notification_type: 'exploration',
  created_at: '2026-01-15T12:00:00Z',
  destination_system: 9,
  destination_position: 7,
  exploration: {
    planet_id: 123,
    planet_name: 'Mordor',
    is_occupied: true,
    resources: { metal: 83119, silicon: 1384413, helium: 928245 },
    buildings: [{ name: 'Metal Mine', key: 'metal_mine', amount: 12 }],
    ships: [{ ship_name: 'Scout', ship_key: 'scout', quantity: 3 }],
    relic_detected: false,
    stellar_object_detected: false,
  },
}
```

A failed exploration has no scan payload. Its notification means the target is defended/occupied, but it must not replace a successful report from another attempt:

```js
{
  notification_type: 'exploration_lost',
  created_at: '2026-01-15T12:05:00Z',
  destination_system: 9,
  destination_position: 7,
  exploration: null,
}
```

When both exist, the summary marks the planet **Occupied** and retains the newest successful exploration's resources, buildings, and ships. Multiple successful exploration notifications are reduced to the newest successful report; failed attempts only contribute the occupied signal.

No saved notification object or renderer field identifies a Galactic Trade Guild headquarters. Guild planets are identified by game API fields instead: the systems payload uses `guild_kind`, while `/trade/guild-planets` objects use `kind` (`headquarters` or `chapter`) and `name`.

### DOM Structure

```
#panel-notifications          ← active tab panel
  #notif-filter-bar           ← All / Explore / Attack / Transport / Harvest / Game News
  #notif-clear-btn            ← clear button
  #notifications-container    ← card list
    .notif-card               ← individual notification
      .notif-summary          ← header (click to expand/collapse)
        .card-badge           ← mission type badge
        .notif-title          ← title text
        .notif-time           ← timestamp
      .notif-detail.card-body  ← details (visible when expanded)
        .stat-row             ← resource row
          .stat.stat-m        ← metal value (+ icon)
          .stat.stat-s        ← silicon value (+ icon)
          .stat.stat-h        ← helium value (+ icon, may be absent for debris)
```

#### Planet Feature Markers

On the systems view and planet dashboard, special icons indicate planet features:

| Element | Class | Description |
|---------|-------|-------------|
| `#dash-planet-relic` | `.prelic` (gold) | Ausente relic building present (`has_relic_building`) |
| `#dash-planet-stellar-object` | `.pstellar` (dim) | Stellar object detected (`has_stellar_object_feature`). Tooltip: `<name>: <description>` |
| Systems planet card | `.pdebris` (dim) | Debris field present |

All three share `.pdebris, .prelic, .pstellar` base styles (`inline-flex`, `1.15em`). Icons are filled via `fillIcons()` and use `data-icon="relic"` / `data-icon="stellar_object"`.

#### Income Breakdown

Per-hour resource income is computed as:

```
basic + mine_raw + workload_loss + efficiency_loss
+ zone_bonus - fusion_tax + tech_bonus + relic_bonus
+ stellar_object_bonus + building_bonus
```

Each component appears in the income popover (`.income-popover-row`). The `stellar_object_bonus` row is shown only when a planet has an active stellar object.

### Key JS Modules (from saved page source)

These are the actual JavaScript modules loaded by the saved page. Userscripts in the project root are separate from the game source modules.

| File | Purpose |
|------|---------|
| `icons_*.js` | Shared icon definitions and icon rendering |
| `core_*.js` | Global state, `req()`, theme, resource projection, and shared helpers |
| `cardgrid_*.js` | Shared card-grid rendering helpers |
| `dashboard_*.js` | Dashboard and resource/income overview |
| `buildings_*.js` | Construction and building cards/queues |
| `research_*.js` | Research tree and research queue |
| `ships_*.js` | Shipyard and ship definitions |
| `modal_*.js` | Help, release, and modal dialogs |
| `auth_*.js` | Authentication and session actions |
| `systems_*.js` | System view and planet list |
| `galaxymap_*.js` | Galaxy map visualization |
| `fleets_*.js` | Fleet deployment, active fleets, and mission dispatch |
| `trade_*.js` | Interstellar Commerce and trade fleets |
| `notifications_*.js` | Notifications and game-news feed rendering; v0.3.3 uses combined `body.items` feed entries |
| `planet_*.js` | Planet dashboard, resources, and queues |
| `main_*.js` | Page startup, tab switching, and initialization |

### Global State (`state` object)

```ts
{
  playerId: number, username: string, email: string, isAdmin: boolean,
  currentPlanetId: number, ownedPlanetIds: number[],
  resources: { metal, silicon, helium, rate_*_per_hour, capacity_*, fetchedAt },
  buildQueue, researchQueue, shipQueue,
  fleetsData, myPlanets,
  notifFilter, notifOffset, notifTotal,
  activeTab: 'dashboard' | 'buildings' | 'research' | 'ships' | 'fleets' | 'notifications',

  // Planet feature flags (from /planets/:id)
  has_relic_building: boolean,
  has_stellar_object_feature: boolean,
  stellar_object_name?: string,
  stellar_object_description?: string,
}
```

## Script Conventions

### Template

```js
// ==UserScript==
// @name         Fonte Antiga - <Feature Name>
// @namespace    fa.<feature-slug>
// @version      1.0.0
// @description  <What it does>
// @match        *://antiga.hatedabamboo.me/*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Inject styles with .fa- prefix to avoid collisions
  const style = document.createElement('style');
  style.textContent = `...`;
  document.head.appendChild(style);

  // Use MutationObserver for SPA reactivity (debounced)
  let timer = null;
  function schedule() { if (timer) clearTimeout(timer); timer = setTimeout(update, 150); }
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

  function update() { /* ... */ }
  update();
})();
```

### Rules

0. **Update tested version:** When making changes to scripts, update the "Tested With" table in README.md with the current game version (found in page source HTML as `version` in `<head>`). This keeps users informed about compatibility.
1. **Local files only:** Always check local project files before anything else. Never use web search — all research and answers must come from local files (saved HTML, JS modules, existing scripts, AGENTS.md).
1. **CSS class prefix:** Always use `.fa-` to avoid colliding with game styles
2. **No `@grant`:** Don't use Tampermonkey GM_* APIs unless needed — the game's `req()` is already global
3. **MutationObserver + debounce:** The game is a SPA; always watch for DOM changes, never rely on one-time injection
4. **Idempotent updates:** Remove stale elements before re-rendering (`.fa-*` selectors)
5. **Resource parsing:** Use `parseNum()` to extract numbers from text that includes SVG icons — match `/[\d,]+/` and strip commas
6. **Handle missing resources:** Debris harvest has only M+S; battle loot may have all three. Always check element existence before reading
7. **Planet feature badges:** `.prelic` and `.pstellar` elements use `classList.toggle('hidden', !body.has_...)` pattern. Set tooltip via `.title = \\<name>: \<description>\\

### Resource Icons

Resources are rendered as `<span class="stat stat-m">` containing an inline SVG icon + number text. To extract the value, parse with regex — never use `textContent` directly (it includes the SVG markup).

## Existing Scripts

| Script | Description |
|--------|-------------|
| `notifications-resource-summary.user.js` | Adds `Σ total` inline after resources in each notification card's stat row |
| `notifications-open-all.user.js` | Adds an "Open all" button for currently shown notifications |
| `planets-summary.user.js` | Adds a local summary of observed planets, queues, defenses, stationed ships, active fleets, and notification intelligence |

## Planet Summary Data Contracts

`planets-summary.user.js` uses a separate IndexedDB database named `fa.planets-summary` with `planets` and `metadata` stores. It reads the existing `fa.notifications` / `notifications` store without modifying it. Notification Target Systems targets the current game response shape only (`body.items`), but must preserve and read notification records cached by previous script versions. Planet records are merged primarily by `galaxy:system:position`; `planet_id` is retained as a secondary identifier. API observations and notification reports remain separate, and every category has its own observation timestamp. Relative ages must not be treated as current game state when the source is a historical notification.

The summary observes these game API responses when the game requests them: `/api/planets/:id`, `/resources`, `/buildings`, `/build-queue`, `/research-queue`, `/ship-queue`, `/defense-queue`, `/defenses`, `/ships`, and `/api/fleets?active=true`. It must not create automatic polling or notification synchronization requests. The optional per-owned-planet update action may request the known planet endpoints explicitly.

The summary has separate paginated views for **My planets** and **Explored planets**. Private API-derived fields such as resources, production, capacities, buildings, defenses, stationed ships, and queues are shown only for owned planets. The explored view shows only notification-derived/public intelligence and must not imply knowledge of another planet's queues or current private state. Use `—` for unknown or unavailable values rather than misleading zeroes or textual unknown states. Only 20 rows should be rendered per page. The live owned-planet sidebar is authoritative; cached records must be canonicalized by `planet_id` where available and otherwise by `galaxy:system:position` to prevent duplicate rows.

## Stellar Objects

- **Discovery:** Send an exploration fleet with a Voyager Probe (`exploration_voyager`) ship. Unlike Ausente relics, only the Voyager Probe is needed.
- **Effect:** Provides a flat per-hour resource production bonus to the owning planet (`stellar_object_bonus` in income calculation)
- **Server data:** `has_stellar_object_feature`, `stellar_object_name`, `stellar_object_description` on `/planets/:id`
- **Exploration notification fields:** `stellar_object_detected`, `stellar_object_name`, `stellar_object_description`
- **UI markers:** `.pstellar` icon (comet/star SVG, `data-icon="stellar_object"`) shown on systems view and planet dashboard (`#dash-planet-stellar-object`). Tooltip format: `<name>: <description>`
- **Example type:** "S-type ring"
- **Prerequisite research:** Sensor Arrays (`tier2_sensor_arrays`) — enables deep-space survey scanning
