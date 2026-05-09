# Changelog

## 1.0.3

- **Local game extraction** replaces wiki scraping. `Update Resources` now runs **GDRE Tools** (Godot PCK extractor) to recover images, fonts, and localization JSON from the installed STS2 PCK, and **dnSpyEx** to decompile `sts2.dll` into C# source. The dashboard's parsers (a JavaScript port of [spire-codex](https://github.com/ptrlrd/spire-codex)) read the decompiled C# to produce card / relic / event / potion / enchantment data.
- **Pre-baked card images.** All cards are rendered once during `Update Resources` and saved as PNGs under `Assets/images/cards/`. The Canvas-2D renderer is a JS port of [WanderZil's Slay-the-Spire-2-Card-Maker](https://github.com/WanderZil/Slay-the-Spire-2-Card-Maker) (8-step layer pipeline, YIQ-space HSV color shifts), running once at pipeline time. Runtime card display is plain `<img src>` with zero canvas work, eliminating the per-card render lag that affected the run-detail view.
- **Period-accurate cards on old saves.** Backward-delta version kernels (curated from the [Slay the Spire 2 Wiki Patch Notes](https://slaythespire.wiki.gg/wiki/Slay_the_Spire_2:Patch_Notes) via a separate kernel-editor and fetched at runtime via the GitHub Contents API) drive a per-version PNG bake, so opening a save built on an older patch shows that patch's stats and text.
- **Faster pipeline.** Tool downloads, extraction (GDRE), and decompilation (dnSpy) now run in parallel via `Promise.all` where independent. First-run pipeline time drops from ~140s to ~95s; subsequent runs from ~95s to ~50s.
- **Run list: Version column** on the home page, sourced from each save file's `build_id`. Replaces the prior `NR · NC` deck-summary column with a simple deck-size number.

## 1.0.2

Previous baseline (wiki-scrape era).

  │ Local extraction  │ GDRE Tools (PCK), dnSpyEx (DLL → C#), spire-codex (parser logic, JS port)   │
  ├───────────────────┼─────────────────────────────────────────────────────────────────────────────┤
  │ Pre-baked images  │ WanderZil's Card-Maker (Canvas-2D port), <img src> for runtime              │
  ├───────────────────┼─────────────────────────────────────────────────────────────────────────────┤
  │ Old-save accuracy │ Hand-curated kernels from Wiki Patch Notes, fetched via GitHub Contents API │
  ├───────────────────┼─────────────────────────────────────────────────────────────────────────────┤
  │ Pipeline speedup  │ Promise.all for parallel stages — no new libraries, just restructuring 