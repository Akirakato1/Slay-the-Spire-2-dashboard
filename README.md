# STS2 Stats

A desktop statistics dashboard for **Slay the Spire 2** run history. Built with Electron — no browser or Python required.

---

## Setup

### First Run

1. Launch `STS2 Stats.exe`.
2. A setup screen will appear asking you to locate your **STS2 history folder**. This is the folder where the game saves `.run` files after each run.
3. Click **Browse…**, select the folder, then click **Continue to Dashboard**.

Your folder path is saved automatically. Future launches will go straight to the dashboard.

> **Assets path:** Game data (relics, cards, events, images) is stored at  
> `%APPDATA%\STS2S\Assets\`  
> This is shown on the setup screen for reference.

---

### Loading Wiki Data (Required for Images & Descriptions)

On first use, card images, relic images, and item descriptions will be missing until you download them from the wiki.

1. Click the **Update Resources** button in the dashboard (top-right area).
2. The app will scrape [slaythespire.wiki.gg](https://slaythespire.wiki.gg) and download:
   - `relics.json` — relic names, descriptions, and images
   - `cards.json` — card names, types, rarities, and images
   - `enchantments.json` — enchantment data
   - `events.json` — event names and descriptions
   - Map node icons
3. Progress is logged live. The update can be cancelled at any time.

You only need to do this once, or again when new content is added to the game.

---

## Dashboard Overview

### Stats Summary Bar

Displayed at the top of the dashboard across all filtered runs:

| Stat | Description |
|---|---|
| Total Runs | Number of runs matching the current filters |
| Win Rate | Percentage of non-abandoned runs that were won |
| Wins / Losses | Raw win and loss counts |
| Avg Duration | Average run time in hours/minutes |

### Character Breakdown

A table showing wins, losses, and win rate per character across the filtered run set.

### Top Deaths

A bar chart of the top 5 encounters or events that ended runs (losses only).

### Ascension Distribution

A bar chart showing how many runs were played at each Ascension level.

---

## Run List

All `.run` files in your history folder are loaded and displayed as cards. Each card shows:

- Character name(s)
- Ascension level
- Outcome (Victory / defeat cause / Abandoned)
- Date and duration

Clicking a run card opens the **Run Detail View**.

The list updates automatically whenever `.run` files are added, changed, or removed from your history folder — no manual refresh needed.

---

## Filters

Filters are applied live and affect both the stats summary and the run list.

| Filter | Description |
|---|---|
| **Game Mode** | All / Solo / Co-op |
| **Character** | Filter by character name (text match) |
| **Ascension** | Multi-select dropdown to include specific Ascension levels |
| **Wins Only** | Show only victorious runs |
| **Abandoned** | Include / Exclude / Only abandoned runs |
| **Min Duration** | Hide runs shorter than N minutes |
| **Card / Relic Search** | Tag-based search — type a card or relic name, select from the dropdown, and only runs containing all selected items are shown. Relic tags show their icon. |
| **Favorites Only** | Show only runs you have starred |

---

## Run Detail View

Click any run in the list to open its full detail view.

### Meta Stats

Displayed across the top:

- Character(s), Ascension, Outcome, Date, Duration, Floor Reached, Seed
- Score and Gold (when present in the run file)

For **co-op runs**, a tab bar lets you switch between players. The HP graph, relics, and deck all update to reflect the selected player.

---

### HP Journey Graph

An SVG graph plotting HP over the course of the run, node by node.

- **Green line** — current HP at each node
- **Blue dashed line** — max HP ceiling (shows HP upgrades over time)
- **Shaded area** — HP health zone (green fill under the current HP line)
- **HP dots** — color-coded: green (>50%), orange (25–50%), red (<25%)
- **Act bands** — subtle background shading separates acts, labelled by act name
- **Node icons** — displayed below the graph, one per map stop

#### Node Icons

Each icon represents a map node type:

| Icon | Type |
|---|---|
| Monster skull | Hallway Fight |
| Purple skull | Elite Fight |
| Large skull | Boss Fight |
| Chest | Treasure |
| Merchant | Shop |
| Campfire | Rest Site |
| Scroll | Event |
| Ancient symbol | Ancient (Relic Choice) |
| Dim variants | Hidden Fight / Shop / Treasure |

**Click any node icon** to open a popup with details for that encounter:

- HP at that node, damage taken, HP healed
- Fight nodes: enemy names
- Event nodes: event name, chosen option, event image and description (if wiki data is loaded)
- Ancient nodes: the three relic options offered, with the chosen one highlighted
- Elite/Treasure nodes: relic choices offered, with the picked one highlighted
- Rest sites: action taken (Rest, Upgrade, Remove card, etc.)

---

### Relics

All relics held at the end of the run, shown as icon buttons. If wiki data is loaded, each button displays the relic's image. Hover for the relic name.

---

### Deck

All cards in the final deck, displayed as a grid of card images.

- **Upgraded cards** use their upgraded artwork when available
- **Enchanted cards** show a small enchantment icon badge in the corner; hover to see the enchantment name
- **Sort button** — toggles between acquisition order (default) and sorted by type → rarity → name (Powers → Attacks → Skills → Curses → Statuses)
- Placeholder text labels are shown for any cards missing wiki images

---

### Favorites

- Click the **star button** on a run detail view to favorite or unfavorite it.
- The star icon also appears on run cards in the list.
- Use the **Favorites Only** filter to view starred runs.
- Favorites are persisted to `%APPDATA%\STS2S\Assets\settings\favorites.json`.

---

### Copy Run File

A **Copy File** button in the run detail view copies the `.run` file itself to the Windows clipboard, so you can paste it into a folder or share it.

---

## Data Storage

All app data is stored in your Windows AppData folder — nothing is written next to the `.exe`.

```
%APPDATA%\STS2S\Assets\
├── data\
│   ├── relics.json
│   ├── cards.json
│   ├── enchantments.json
│   └── events.json
├── images\
│   ├── relic_images\
│   ├── card_images\
│   ├── event_images\
│   └── map_icons\
└── settings\
    ├── config.json          ← history folder path
    ├── favorites.json       ← starred runs
    ├── resource_meta.json   ← wiki update timestamps
    └── map_icons_meta.json
```

To reset the app to first-run state, delete `config.json`.  
To re-download all wiki assets, delete the contents of the `data\` and `images\` folders and run **Update Resources** again.

---

## Building from Source

Requirements: [Node.js](https://nodejs.org) 18+

```bash
npm install
npm run build
```

Output: `dist/STS2 Stats 1.0.0.exe` (portable executable)
