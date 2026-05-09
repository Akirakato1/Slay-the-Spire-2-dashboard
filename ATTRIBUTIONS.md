# Attributions

**STS2 Dashboard is not affiliated with, endorsed by, or sponsored by Mega Crit.** *Slay the Spire 2* is a trademark of Mega Crit. This dashboard is an unofficial fan-made tool for browsing your local `.run` save files.

## Game data extraction

Card / relic / event / potion / enchantment data is extracted from your local Slay the Spire 2 install on each `Update Resources` run. Three external tools drive this:

- **GDRE Tools** (https://github.com/GDRETools/gdsdecomp) — MIT. Recovers Godot PCK contents: localization JSON, images, fonts.
- **dnSpyEx** (https://github.com/dnSpyEx/dnSpy) — **GPL-3.0**. Decompiles `sts2.dll` into C#, the source of truth for card / relic stats and effects. Ships as a standalone .NET Framework binary, no separate runtime needed.
- **spire-codex** (https://github.com/ptrlrd/spire-codex) — **PolyForm Noncommercial 1.0.0**. The parsers under `scripts/parsers/` are a JavaScript port of spire-codex's Python parsers. Original Python reference is kept under `scripts/parsers/_reference/` for traceability. **Distribution or monetization of this dashboard would require relicensing spire-codex's parser logic; review carefully if you fork.**

GDRE and dnSpyEx are downloaded on first run; spire-codex's parser logic is bundled directly.

## Card rendering

- **Slay-the-Spire-2-Card-Maker** by WanderZil (https://github.com/WanderZil/Slay-the-Spire-2-Card-Maker) — **MIT** (code) / separate `ASSET_LICENSE.md` (game-asset overlays). The Canvas-2D card renderer (`scripts/render/renderer.js`) is a JavaScript port of WanderZil's `renderer.py`: same 8-step layer pipeline, YIQ-space HSV color-shift math, layout coordinates, and per-rarity / per-character HSV tables. `Icons/star_icon.png` is vendored from WanderZil's `assets/icons/`. All other render assets (frames, banners, mana orbs, portrait borders, type plaque, Kreon font) come from the dashboard's own GDRE extraction.

The renderer runs once per `Update Resources` to bake every card (current data + per-version kernel variants) into static PNGs under `Assets/images/cards/`. Runtime hydration is plain `<img src>` — no canvas at runtime.

## Patch notes / kernels

Backward-delta version kernels under the dashboard's GitHub repo (`version_kernels/`) and map icons under `map_icons/` are hand-curated from the [Slay the Spire 2 Wiki Patch Notes](https://slaythespire.wiki.gg/wiki/Slay_the_Spire_2:Patch_Notes) page. Wiki content is community-authored and licensed CC BY-SA 3.0 unless otherwise noted. The kernel-editor (`kernel-editor/`, separate from the shipped app) generates draft scaffolds via `parse_patch_notes.js`. The dashboard fetches the finalized kernels and map icons from GitHub on each pipeline run.

## Runtime dependencies

- **Electron** (https://github.com/electron/electron) — MIT
- **chokidar** (https://github.com/paulmillr/chokidar) — MIT

See `package.json` for the full dependency tree.
