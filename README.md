# STS2 Dashboard

A desktop statistics dashboard for **Slay the Spire 2** run history. Watches your `.run` folder, parses every run, and shows stats, run details, deck evolution, and aggregate insights — no browser or Python required.

---

## Quickstart

1. Launch `STS2 Dashboard 1.0.2.exe`.
2. On first run, browse to your STS2 history folder (where the game writes `.run` files) → **Continue to Dashboard**.
3. Click **Update Resources** in the header to download wiki data (relic/card images and descriptions). One-time step.

The folder is remembered; future launches go straight to the dashboard.

---

## Dashboard

![Dashboard top — filters and stats summary](docs/screenshots/01a-dashboard-top.png)

The home view has three stacked sections:

- **Filters bar** — game mode (All / Solo / Co-op / **Shared**), character, ascension multi-select, win-only, abandoned handling, min duration, and tag-based **Has Card / Relic** + **Exclude Card / Relic** searches. All filters apply live to the stats and the run list.
- **Stats summary** — total runs, win rate, wins/losses, avg duration, character breakdown, top death causes, ascension distribution.
- **Run list** — every `.run` file as a row (character, ascension, outcome, date, duration). Click a row to open the detail view. Star a row to favorite it. The list auto-refreshes when files change in the folder.

![Dashboard run list](docs/screenshots/01b-dashboard-runs.png)

The **Shared** mode tab lists runs you've imported via 📂 Open Run (from disk or Pastebin); they're stored separately from your own runs at `%APPDATA%\sts2-dashboard\Shared Runs\` and don't mix into your stats.

---

## Run Detail

![Run detail view](docs/screenshots/02-run-detail.png)

Click any run to open its full detail page:

- **Meta header** — character(s), ascension, outcome, date, duration, floor, seed, gold, score. Co-op runs show a player tab bar that swaps the graph/relics/deck per player.
- **HP Journey graph** — current HP (green), max HP (blue dashed), color-coded HP dots, and act bands. **Click any node icon** under the graph for a popup with damage taken, healing, enemies fought, event chosen, relic picks, or rest action.
- **Relics** — every relic held at run end. Click for a popup with the wiki description.
- **Deck** — final deck as card images, with enchantment badges and upgraded artwork. Sort toggle switches between acquisition order and grouped (Powers → Attacks → Skills → Curses → Statuses).
- **Header buttons** — ★ Favorite, 📋 Copy `.run` to clipboard, 📤 Pastebin export, 🪜 Deck Stepper.

Almost everything is clickable for a detail popup: relics, cards (in the deck or in stepper rewards), enchantment badges, event names, potions, and HP-graph nodes all open a popup with the wiki description, image, and rarity/character info when available.

---

## Deck Stepper

![Deck stepper overlay](docs/screenshots/03-deck-stepper.png)

A full-screen overlay that walks through the run node by node. Use the arrows or arrow keys to move between stops.

Each step shows: HP / Max HP / Gold with deltas, potions and relics held (newly acquired ones highlighted), card rewards offered (with the picked card highlighted, multiple rewards split into rows), shop inventory with purchases highlighted, and any cards added / removed / upgraded / transformed / enchanted. The current deck is rendered at the bottom. Co-op runs keep the player tabs in the header so you can switch players without losing your place.

---

## Insights

![Insights aggregate stats](docs/screenshots/04-insights.png)

Click **📊 Insights** in the header for aggregate stats across the currently filtered runs:

- Most-picked relics and cards (with seen-in counts)
- Win rate by character / ascension / relic / card
- Top death causes, deck size and act-clear distributions, and more

Each table is collapsible and sortable. Insight rows respect the same filters as the run list — narrow to a single character or ascension to see stats just for that slice.

---

## Update Resources

Card and relic art, descriptions, and event/potion data come from [slaythespire.wiki.gg](https://slaythespire.wiki.gg) — they aren't bundled with the app.

**On first launch the update runs automatically** when no cached data is detected, so the dashboard is fully populated by the time it opens. After that, click **🔄 Update Resources** in the header to re-scrape on demand — do this whenever a new patch adds cards, relics, or events to the wiki.

What gets downloaded:

- `relics.json`, `cards.json`, `enchantments.json`, `events.json`, `potions.json`
- All matching images (relic icons, card art, enchantment badges, event splash images, potion icons, map node icons)

Progress is logged live in a panel and can be cancelled at any time. The header label next to the button shows the date of the last successful update.

Cached data lives at `%APPDATA%\sts2-dashboard\Assets\data\` and `Assets\images\`.

---

## Sharing & Importing Runs

- **📂 Open Run ▾** (header) → **From disk** opens any `.run` file; **From Pastebin** fetches a paste URL. Either way, the run is saved into the **Shared Runs** folder so it persists under the **Shared** mode tab.
- **📤 Pastebin** (run detail) uploads the current run and copies the URL to your clipboard. Requires a Pastebin API dev key — the app will prompt for it on first export.
- **📋 Copy** (run detail or run row) copies the `.run` file itself to the clipboard, ready to paste into a folder or chat.

---

## Data Storage

Everything lives under `%APPDATA%\sts2-dashboard\`:

```
sts2-dashboard\
├── Assets\
│   ├── data\        ← relics.json, cards.json, enchantments.json, events.json, potions.json
│   ├── images\      ← relic_images, card_images, enchantment_images, event_images, potion_images, map_icons
│   └── settings\    ← config.json, favorites.json, resource_meta.json
└── Shared Runs\     ← runs imported via Open Run
```

To reset the app to first-run state, delete `Assets\settings\config.json`. To re-pull all wiki data, clear `Assets\data\` and `Assets\images\` and run **Update Resources** again.

---

## Building from Source

Requires Node.js 18+.

```bash
npm install
npm run build
```

Output: `dist/STS2 Dashboard 1.0.2.exe` (portable executable).
