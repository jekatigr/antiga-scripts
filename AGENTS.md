# Fonte Antiga – Tampermonkey Scripts

Browser-based space strategy game at `https://antiga.hatedabamboo.me`.  
This project contains Tampermonkey userscripts to enhance gameplay.

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

#### Notification Types

- `attack_incoming` – enemy fleet inbound
- `planet_scanned` – another player scanned your planet
- `exploration_lost` – exploration fleet destroyed
- `exploration` – exploration report (buildings, fleet, resources, debris). May include `stellar_object_detected`, `stellar_object_name`, `stellar_object_description` when a stellar object is found via Voyager Probe
- `transport_delivered` / `transport_gathered` – resource transfer
- `debris_harvested` – harvest result (metal + silicon only, no helium)
- `relocate_arrived` – fleet relocation
- `battle_report` – attack/defense outcome with loot

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

| File | Purpose |
|------|---------|
| `core_*.js` | Global state, `req()`, theme, resource projection, formatting |
| `notifications_*.js` | Notification rendering, pagination, filters, badge sync |
| `fleets_*.js` | Fleet command, mission dispatch, ship selection |
| `planet_*.js` | Planet view, buildings overview |
| `buildings_*.js` | Construction queue, building cards |
| `ships_*.js` | Shipyard, ship definitions |
| `research_*.js` | Research tree and queue |
| `dashboard_*.js` | Overview tab |
| `galaxymap_*.js` | Galaxy map visualization |

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

## Stellar Objects

- **Discovery:** Send an exploration fleet with a Voyager Probe (`exploration_voyager`) ship. Unlike Ausente relics, only the Voyager Probe is needed.
- **Effect:** Provides a flat per-hour resource production bonus to the owning planet (`stellar_object_bonus` in income calculation)
- **Server data:** `has_stellar_object_feature`, `stellar_object_name`, `stellar_object_description` on `/planets/:id`
- **Exploration notification fields:** `stellar_object_detected`, `stellar_object_name`, `stellar_object_description`
- **UI markers:** `.pstellar` icon (comet/star SVG, `data-icon="stellar_object"`) shown on systems view and planet dashboard (`#dash-planet-stellar-object`). Tooltip format: `<name>: <description>`
- **Example type:** "S-type ring"
- **Prerequisite research:** Sensor Arrays (`tier2_sensor_arrays`) — enables deep-space survey scanning
