'use strict';

// ── Name parsing helpers ──────────────────────────────────────────────────────

function parsePrefixed(raw) {
  if (!raw || typeof raw !== 'string') return '—';
  const dotIdx = raw.indexOf('.');
  const slug = dotIdx >= 0 ? raw.slice(dotIdx + 1) : raw;
  if (slug === 'NONE' || slug === '' ) return null;
  return slug
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseCharacter(raw) {
  return parsePrefixed(raw) || 'Unknown';
}

function parseEncounter(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const parsed = parsePrefixed(raw);
  if (!parsed) return null;
  return parsed;
}

function outcomeLabel(run) {
  if (run.win)           return { label: 'Victory', type: 'win' };
  if (run.was_abandoned) return { label: 'Abandoned', type: 'abandoned' };

  const enc   = parseEncounter(run.killed_by_encounter);
  const event = parseEncounter(run.killed_by_event);
  const cause = enc || event || 'Unknown';
  return { label: 'Defeat', type: 'loss', cause };
}

// ── Time formatting ───────────────────────────────────────────────────────────

function formatDate(unixSeconds) {
  if (!unixSeconds) return '—';
  const d = new Date(unixSeconds * 1000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDurationFull(seconds) {
  if (!seconds && seconds !== 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// ── Asset data & lookup ───────────────────────────────────────────────────────

let relicsMap       = new Map(); // normalized name → relic object
let cardsMap        = new Map(); // normalized name → card object
let enchantmentsMap = new Map(); // normalized name → enchantment object
let eventsMap       = new Map(); // normalized name → event object
let potionsMap      = new Map(); // normalized name → potion object

function normalizeName(str) {
  return str.toLowerCase()
    .replace(/[()'']/g, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadAssetData() {
  try {
    const [rRes, cRes, eRes, evRes, pRes] = await Promise.all([
      fetch('appdata://data/relics.json'),
      fetch('appdata://data/cards.json'),
      fetch('appdata://data/enchantments.json'),
      fetch('appdata://data/events.json'),
      fetch('appdata://data/potions.json'),
    ]);
    const relics       = await rRes.json();
    const cards        = await cRes.json();
    const enchantments = await eRes.json();
    const events       = await evRes.json();
    const potions      = await pRes.json();
    for (const r of relics)       relicsMap.set(normalizeName(r.name), r);
    for (const c of cards)        cardsMap.set(normalizeName(c.name), c);
    for (const e of enchantments) enchantmentsMap.set(normalizeName(e.name), e);
    for (const ev of events)      eventsMap.set(normalizeName(ev.name), ev);
    for (const p of potions)      potionsMap.set(normalizeName(p.name), p);
  } catch (e) {
    console.warn('Asset data load failed:', e);
  }
}

function idToDisplayName(id) {
  if (!id || typeof id !== 'string') return '?';
  const slug = id.includes('.') ? id.split('.').slice(1).join(' ') : id;
  return slug
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function lookupRelicData(id) {
  const name = idToDisplayName(id);
  return relicsMap.get(normalizeName(name)) || null;
}

function lookupCardData(id) {
  const name = idToDisplayName(id);
  return cardsMap.get(normalizeName(name)) || null;
}

function lookupEnchantmentData(id) {
  const name = idToDisplayName(id);
  return enchantmentsMap.get(normalizeName(name)) || null;
}

function lookupPotionData(id) {
  const name = idToDisplayName(id);
  return potionsMap.get(normalizeName(name)) || null;
}

// ── Ascension filter ─────────────────────────────────────────────────────────

let _ascAllLevels = [];

function updateAscBtn() {
  const btn = document.getElementById('ascFilterBtn');
  if (!btn) return;
  const sel = currentFilters.ascLevels;
  if (sel === null || sel.size === _ascAllLevels.length) {
    btn.textContent = 'All';
  } else if (sel.size === 0) {
    btn.textContent = 'None';
  } else if (sel.size <= 5) {
    btn.textContent = [...sel].sort((a, b) => a - b).map(l => `A${l}`).join(', ');
  } else {
    btn.textContent = `${sel.size} of ${_ascAllLevels.length}`;
  }
}

function initAscFilter(allLevels) {
  _ascAllLevels = allLevels;
  const list = document.getElementById('ascCheckboxList');
  if (!list) return;
  list.innerHTML = allLevels.map(lvl => {
    const checked = currentFilters.ascLevels === null || currentFilters.ascLevels.has(lvl);
    return `<label class="asc-checkbox-item">
      <input type="checkbox" class="asc-checkbox" data-level="${lvl}"${checked ? ' checked' : ''} />
      Ascension ${lvl}
    </label>`;
  }).join('');
  updateAscBtn();
}

// ── Card / Relic search filter ────────────────────────────────────────────────

function searchCardsAndRelics(query) {
  const q = normalizeName(query);
  if (!q) return [];
  const results = [];
  for (const [key, relic] of relicsMap) {
    if (key.includes(q)) results.push({ type: 'relic', normalizedName: key, name: relic.name, imageFile: relic.imageFile || '', startsWith: key.startsWith(q) });
  }
  for (const [key, card] of cardsMap) {
    if (key.includes(q)) results.push({ type: 'card', normalizedName: key, name: card.name, imageFile: card.imageFile || '', startsWith: key.startsWith(q) });
  }
  results.sort((a, b) => {
    if (a.startsWith !== b.startsWith) return a.startsWith ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return results.slice(0, 12);
}

function renderSearchTokens() {
  const wrap     = document.getElementById('tagInputWrap');
  const input    = document.getElementById('searchFilterInput');
  const clearBtn = document.getElementById('searchFilterClearAll');
  wrap.querySelectorAll('.search-token').forEach(el => el.remove());
  for (const token of currentFilters.searchTokens) {
    const el = document.createElement('span');
    el.className = 'search-token';
    el.dataset.normalizedName = token.normalizedName;
    if (token.type === 'relic' && token.imageFile) {
      el.title = token.name;
      el.innerHTML = `<img src="appdata://images/relic_images/${escHtml(token.imageFile)}" alt="${escHtml(token.name)}" /><span class="search-token-x">×</span>`;
    } else {
      el.innerHTML = `<span class="search-token-name">${escHtml(token.name)}</span><span class="search-token-x">×</span>`;
    }
    wrap.insertBefore(el, input);
  }
  clearBtn.style.display = currentFilters.searchTokens.length > 0 ? '' : 'none';
}

function renderExcludeTokens() {
  const wrap     = document.getElementById('excludeTagInputWrap');
  const input    = document.getElementById('excludeFilterInput');
  const clearBtn = document.getElementById('excludeFilterClearAll');
  wrap.querySelectorAll('.search-token').forEach(el => el.remove());
  for (const token of currentFilters.excludeTokens) {
    const el = document.createElement('span');
    el.className = 'search-token search-token--exclude';
    el.dataset.normalizedName = token.normalizedName;
    if (token.type === 'relic' && token.imageFile) {
      el.title = token.name;
      el.innerHTML = `<img src="appdata://images/relic_images/${escHtml(token.imageFile)}" alt="${escHtml(token.name)}" /><span class="search-token-x">×</span>`;
    } else {
      el.innerHTML = `<span class="search-token-name">${escHtml(token.name)}</span><span class="search-token-x">×</span>`;
    }
    wrap.insertBefore(el, input);
  }
  clearBtn.style.display = currentFilters.excludeTokens.length > 0 ? '' : 'none';
}

function updateExcludeDropdown() {
  const input    = document.getElementById('excludeFilterInput');
  const dropdown = document.getElementById('excludeFilterDropdown');
  const q = input.value.trim();
  if (!q) { dropdown.style.display = 'none'; return; }

  const activeSet = new Set(currentFilters.excludeTokens.map(t => t.normalizedName));
  const results   = searchCardsAndRelics(q).filter(r => !activeSet.has(r.normalizedName));

  if (!results.length) {
    dropdown.innerHTML = `<div class="search-dropdown-empty">No matches</div>`;
    dropdown.style.display = '';
    return;
  }

  dropdown.innerHTML = results.map(r => {
    const icon = r.type === 'relic' && r.imageFile
      ? `<img class="search-dropdown-icon" src="appdata://images/relic_images/${escHtml(r.imageFile)}" alt="" />`
      : `<div class="search-dropdown-card-stub">C</div>`;
    return `<div class="search-dropdown-item"
      data-normalized="${escHtml(r.normalizedName)}"
      data-type="${r.type}"
      data-name="${escHtml(r.name)}"
      data-img-file="${escHtml(r.imageFile)}">
      ${icon}
      <span class="search-dropdown-name">${escHtml(r.name)}</span>
      <span class="search-dropdown-badge ${r.type}">${r.type === 'relic' ? 'Relic' : 'Card'}</span>
    </div>`;
  }).join('');
  dropdown.style.display = '';
}

function updateSearchDropdown() {
  const input    = document.getElementById('searchFilterInput');
  const dropdown = document.getElementById('searchFilterDropdown');
  const q = input.value.trim();
  if (!q) { dropdown.style.display = 'none'; return; }

  const activeSet = new Set(currentFilters.searchTokens.map(t => t.normalizedName));
  const results   = searchCardsAndRelics(q).filter(r => !activeSet.has(r.normalizedName));

  if (!results.length) {
    dropdown.innerHTML = `<div class="search-dropdown-empty">No matches</div>`;
    dropdown.style.display = '';
    return;
  }

  dropdown.innerHTML = results.map(r => {
    const icon = r.type === 'relic' && r.imageFile
      ? `<img class="search-dropdown-icon" src="appdata://images/relic_images/${escHtml(r.imageFile)}" alt="" />`
      : `<div class="search-dropdown-card-stub">C</div>`;
    return `<div class="search-dropdown-item"
      data-normalized="${escHtml(r.normalizedName)}"
      data-type="${r.type}"
      data-name="${escHtml(r.name)}"
      data-img-file="${escHtml(r.imageFile)}">
      ${icon}
      <span class="search-dropdown-name">${escHtml(r.name)}</span>
      <span class="search-dropdown-badge ${r.type}">${r.type === 'relic' ? 'Relic' : 'Card'}</span>
    </div>`;
  }).join('');
  dropdown.style.display = '';
}

// ── Filters ───────────────────────────────────────────────────────────────────

const currentFilters = {
  abandoned: 'include',
  minDuration: 0,
  mode: 'solo',        // 'all' | 'solo' | 'coop'
  winOnly: false,
  character: 'all',
  searchTokens: [],    // { type, normalizedName, name, imageFile }
  excludeTokens: [],   // { type, normalizedName, name, imageFile }
  ascLevels: null,     // null = all; Set<number> = specific levels
  favoritedOnly: false,
};

function isCoop(run) {
  return Array.isArray(run.players) && run.players.length > 1;
}

function applyFilters(allRuns, filters) {
  return allRuns.filter((run) => {
    if (filters.mode === 'solo' && isCoop(run)) return false;
    if (filters.mode === 'coop' && !isCoop(run)) return false;

    if (run.was_abandoned) {
      if (filters.abandoned === 'exclude') return false;
    } else {
      if (filters.abandoned === 'only') return false;
    }

    if (filters.minDuration > 0) {
      const runTime = typeof run.run_time === 'number' ? run.run_time : 0;
      if (runTime < filters.minDuration * 60) return false;
    }

    if (filters.winOnly && !run.win) return false;

    if (filters.character !== 'all') {
      const q = filters.character.toLowerCase();
      const anyMatch = (run.players || []).some(p => parseCharacter(p.character).toLowerCase().includes(q));
      if (!anyMatch) return false;
    }

    if (filters.ascLevels !== null) {
      const asc = typeof run.ascension === 'number' ? run.ascension : 0;
      if (!filters.ascLevels.has(asc)) return false;
    }

    if (filters.favoritedOnly && !favoritesSet.has(runKey(run))) return false;

    if (filters.searchTokens && filters.searchTokens.length > 0) {
      const allRelics = (run.players || []).flatMap(p => p.relics ?? []);
      const allDeck   = (run.players || []).flatMap(p => p.deck   ?? []);
      for (const token of filters.searchTokens) {
        let found = false;
        if (token.type === 'relic') {
          found = allRelics.some(r => normalizeName(idToDisplayName(r.id)) === token.normalizedName);
        } else {
          found = allDeck.some(c => normalizeName(idToDisplayName(c.id)) === token.normalizedName);
        }
        if (!found) return false;
      }
    }

    if (filters.excludeTokens && filters.excludeTokens.length > 0) {
      const allRelics = (run.players || []).flatMap(p => p.relics ?? []);
      const allDeck   = (run.players || []).flatMap(p => p.deck   ?? []);
      for (const token of filters.excludeTokens) {
        let found = false;
        if (token.type === 'relic') {
          found = allRelics.some(r => normalizeName(idToDisplayName(r.id)) === token.normalizedName);
        } else {
          found = allDeck.some(c => normalizeName(idToDisplayName(c.id)) === token.normalizedName);
        }
        if (found) return false;
      }
    }

    return true;
  });
}

// ── Stats calculation ─────────────────────────────────────────────────────────

function computeStats(runs) {
  const wins      = runs.filter((r) => r.win);
  const losses    = runs.filter((r) => !r.win);
  const abandoned = runs.filter((r) => r.was_abandoned);

  const winRate = runs.length > 0
    ? ((wins.length / runs.length) * 100).toFixed(1)
    : null;

  const durations = runs
    .map((r) => r.run_time)
    .filter((t) => typeof t === 'number' && t > 0);
  const avgDuration = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 60)
    : null;

  const charMap = new Map();
  for (const run of runs) {
    const char = parseCharacter(run.players?.[0]?.character);
    if (!charMap.has(char)) charMap.set(char, { wins: 0, losses: 0 });
    const entry = charMap.get(char);
    if (run.win) entry.wins++;
    else         entry.losses++;
  }
  const charBreakdown = [...charMap.entries()]
    .map(([char, { wins: w, losses: l }]) => ({
      char, wins: w, losses: l, total: w + l,
      winRate: w + l > 0 ? ((w / (w + l)) * 100).toFixed(1) : '—'
    }))
    .sort((a, b) => b.total - a.total);

  const deathMap = new Map();
  for (const run of losses) {
    const enc   = parseEncounter(run.killed_by_encounter);
    const event = parseEncounter(run.killed_by_event);
    const cause = enc || event || 'Unknown';
    if (cause.toLowerCase() === 'neow') continue;
    deathMap.set(cause, (deathMap.get(cause) || 0) + 1);
  }
  const topDeaths = [...deathMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, count]) => ({ name, count }));

  const ascMap = new Map();
  for (const run of runs) {
    const asc = typeof run.ascension === 'number' ? run.ascension : 0;
    ascMap.set(asc, (ascMap.get(asc) || 0) + 1);
  }
  const ascDistribution = [...ascMap.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([level, count]) => ({ level, count }));

  return {
    totalRuns: runs.length,
    abandonedCount: abandoned.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    avgDuration,
    charBreakdown,
    topDeaths,
    ascDistribution
  };
}

// ── List view renderers ───────────────────────────────────────────────────────

function renderSummary(stats) {
  document.getElementById('statTotal').textContent    = stats.totalRuns;
  document.getElementById('statAbandoned').textContent =
    stats.abandonedCount > 0 ? `${stats.abandonedCount} abandoned` : '';
  document.getElementById('statWinRate').textContent  =
    stats.winRate !== null ? `${stats.winRate}%` : '—';
  document.getElementById('statWinRateSub').textContent =
    stats.winRate !== null ? `${stats.wins}W / ${stats.losses}L` : 'No runs yet';
  document.getElementById('statWins').textContent    = stats.wins;
  document.getElementById('statLosses').textContent  = stats.losses;
  document.getElementById('statAvgDur').textContent  =
    stats.avgDuration !== null ? stats.avgDuration : '—';
}

function renderCharBreakdown(chars) {
  const container = document.getElementById('charBreakdown');
  if (chars.length === 0) {
    container.innerHTML = '<div class="empty-state">No run data found.</div>';
    return;
  }
  const rows = chars.map((c) => {
    const pct = c.total > 0 ? ((c.wins / c.total) * 100) : 0;
    return `
      <tr>
        <td class="char-name">${escHtml(c.char)}</td>
        <td style="color:var(--green)">${c.wins}</td>
        <td style="color:#e74c3c">${c.losses}</td>
        <td>
          <div class="win-rate-bar-wrap">
            <div class="win-rate-bar">
              <div class="win-rate-fill" style="width:${pct.toFixed(1)}%"></div>
            </div>
            <span class="win-rate-pct">${c.winRate}%</span>
          </div>
        </td>
      </tr>`;
  }).join('');
  container.innerHTML = `
    <table class="data-table">
      <thead><tr>
        <th>Character</th><th>W</th><th>L</th><th>Win Rate</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderDeathList(deaths) {
  const list = document.getElementById('deathList');
  if (deaths.length === 0) {
    list.innerHTML = '<li style="color:var(--text-muted);padding:12px 0;">No losses recorded.</li>';
    return;
  }
  const maxCount = deaths[0].count;
  list.innerHTML = deaths.map(({ name, count }) => {
    const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
    return `
      <li>
        <span class="death-name">${escHtml(name)}</span>
        <div class="death-bar-wrap">
          <div class="death-bar-fill" style="width:${pct.toFixed(1)}%"></div>
        </div>
        <span class="death-count">${count}</span>
      </li>`;
  }).join('');
}

function renderAscDistribution(dist) {
  const container = document.getElementById('ascBars');
  if (dist.length === 0) {
    container.innerHTML = '<div class="empty-state">No data yet.</div>';
    return;
  }
  const maxCount = Math.max(...dist.map((d) => d.count));
  container.innerHTML = dist.map(({ level, count }) => {
    const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
    return `
      <div class="asc-row">
        <span class="asc-label">Asc ${level}</span>
        <div class="asc-bar-wrap">
          <div class="asc-bar-fill" style="width:${pct.toFixed(1)}%"></div>
        </div>
        <span class="asc-count">${count}</span>
      </div>`;
  }).join('');
}

// ── Run detail view ───────────────────────────────────────────────────────────

let currentDetailRelics = [];

// ── HP Journey Graph ──────────────────────────────────────────────────────────

const NODE_CFG = {
  ancient:          { img: 'Map-Event.png',    color: '#c9a227', bg: '#ffffff' },
  monster:          { img: 'Map-Monster.png',  color: '#aaa',    bg: '#000000' },
  elite:            { img: 'Map-Elite.png',    color: '#c084f5', bg: '#2e0a4a' },
  boss:             { img: 'Map-Boss.png',     color: '#9b59b6', bg: '#ffffff' },
  shop:             { img: 'Map-Merchant.png', color: '#1a1a00', bg: '#e6b800' },
  rest_site:        { img: 'Map-RestSite.png', color: '#27ae60', bg: '#8b0000' },
  treasure:         { img: 'Map-Treasure.png', color: '#e5c100', bg: '#ffffff' },
  event:            { img: 'Map-Event.png',    color: '#c8a820', bg: '#5a4800' },
  unknown_fight:    { img: 'Map-Monster.png',  color: '#c8a820', bg: '#5a4800', dim: true },
  unknown_shop:     { img: 'Map-Merchant.png', color: '#c8a820', bg: '#5a4800', dim: true },
  unknown_treasure: { img: 'Map-Treasure.png', color: '#c8a820', bg: '#5a4800', dim: true },
};

const ACT_BAND_COLORS = [
  'rgba(39,174,96,0.05)',
  'rgba(230,126,34,0.05)',
  'rgba(155,89,182,0.05)',
];

function parseRunMap(run, playerIdx = 0) {
  const nodes = [];
  const actHistory = run.map_point_history || [];
  for (let actIdx = 0; actIdx < actHistory.length; actIdx++) {
    for (const node of actHistory[actIdx]) {
      const ps   = node.player_stats?.[playerIdx] ?? node.player_stats?.[0] ?? {};
      const room = node.rooms?.[0] ?? {};
      const roomType = room.room_type || node.map_point_type;
      const modelId  = room.model_id  || null;
      let category = node.map_point_type;
      if (node.map_point_type === 'unknown') {
        if      (roomType === 'monster')  category = 'unknown_fight';
        else if (roomType === 'shop')     category = 'unknown_shop';
        else if (roomType === 'treasure') category = 'unknown_treasure';
        else                              category = 'event';
      }
      nodes.push({
        actIdx, mapType: node.map_point_type, category,
        hp: ps.current_hp ?? null, maxHp: ps.max_hp ?? null,
        damageTaken: ps.damage_taken ?? 0, hpHealed: ps.hp_healed ?? 0,
        modelId, monsterIds: room.monster_ids ?? [], roomType,
        eventChoices:  ps.event_choices    ?? [],
        ancientChoices:ps.ancient_choice   ?? [],
        relicChoices:  ps.relic_choices    ?? [],
        restChoices:   ps.rest_site_choices ?? [],
      });
    }
  }
  return nodes;
}

let _currentRunNodes = [];

function lookupEventByModelId(modelId) {
  if (!modelId || !modelId.startsWith('EVENT.')) return null;
  const slug = modelId.slice(6);
  const name = slug.split('_').map(w => w[0] + w.slice(1).toLowerCase()).join(' ');
  return eventsMap.get(normalizeName(name)) || null;
}

function formatModelDisplay(modelId) {
  if (!modelId) return '—';
  const slug = modelId.includes('.') ? modelId.split('.').slice(1).join('_') : modelId;
  return slug.split('_')
    .map(w => w[0].toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
    .replace(/ (Weak|Normal|Elite|Boss)$/, s => ` (${s.trim()})`)
    .trim();
}

function formatMonsterId(mId) {
  if (!mId) return '?';
  const slug = mId.includes('.') ? mId.split('.')[1] : mId;
  return slug.split('_').map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function renderHpGraph(run, playerIdx = 0) {
  const section = document.getElementById('hpGraphSection');
  const wrap    = document.getElementById('hpGraphSvgWrap');
  const nodes   = parseRunMap(run, playerIdx);
  _currentRunNodes = nodes;

  if (!nodes.length) { section.style.display = 'none'; return; }
  section.style.display = '';

  const N = nodes.length;
  // Fixed viewBox coordinate space
  const VW = 1000;
  const PAD_L = 36, PAD_R = 8, PAD_T = 22, PAD_B = 10;
  const GRAPH_H = 74;
  const ICON_PAD = 5;
  const ICON_R   = 8;
  const DOT_R    = 2.5;
  const VH = PAD_T + GRAPH_H + ICON_PAD + ICON_R * 2 + PAD_B; // ≈131

  const usableW   = VW - PAD_L - PAD_R;
  const maxHpEver = Math.max(...nodes.filter(n => n.maxHp !== null).map(n => n.maxHp), 1);
  const xOf  = (i)  => PAD_L + (i + 0.5) * (usableW / N);
  const yHp  = (hp) => PAD_T + GRAPH_H - (hp / maxHpEver) * GRAPH_H;
  const iconCY = PAD_T + GRAPH_H + ICON_PAD + ICON_R;

  // Compute act bands
  const actBands = [];
  let bStart = 0, bAct = nodes[0].actIdx;
  for (let i = 1; i <= N; i++) {
    if (i === N || nodes[i].actIdx !== bAct) {
      actBands.push({ actIdx: bAct, start: bStart, end: i - 1 });
      if (i < N) { bStart = i; bAct = nodes[i].actIdx; }
    }
  }

  // HP line points (only valid HP nodes)
  const hpPairs = nodes
    .map((n, i) => n.hp !== null ? { i, hp: n.hp, maxHp: n.maxHp } : null)
    .filter(Boolean);

  const lineStr = hpPairs.map(p => `${xOf(p.i).toFixed(1)},${yHp(p.hp).toFixed(1)}`).join(' ');

  const areaStr = hpPairs.length > 1 ? [
    ...hpPairs.map(p => `${xOf(p.i).toFixed(1)},${yHp(p.hp).toFixed(1)}`),
    `${xOf(hpPairs[hpPairs.length - 1].i).toFixed(1)},${(PAD_T + GRAPH_H).toFixed(1)}`,
    `${xOf(hpPairs[0].i).toFixed(1)},${(PAD_T + GRAPH_H).toFixed(1)}`,
  ].join(' ') : '';

  // Act names
  const actNames = (run.acts || []).map(a => idToDisplayName(a));

  const svg = [];
  svg.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${VH}" style="width:100%;height:auto;display:block;">`);
  svg.push(`<defs>`);
  svg.push(`<linearGradient id="hpAreaFill" x1="0" y1="0" x2="0" y2="1">`);
  svg.push(`<stop offset="0%" stop-color="#27ae60" stop-opacity="0.30"/>`);
  svg.push(`<stop offset="100%" stop-color="#27ae60" stop-opacity="0.03"/>`);
  svg.push(`</linearGradient>`);
  svg.push(`</defs>`);

  // Act bands
  for (const band of actBands) {
    const x1 = xOf(band.start) - usableW / N * 0.5;
    const x2 = xOf(band.end)   + usableW / N * 0.5;
    const col = ACT_BAND_COLORS[band.actIdx % ACT_BAND_COLORS.length];
    svg.push(`<rect x="${x1.toFixed(1)}" y="0" width="${(x2-x1).toFixed(1)}" height="${VH}" fill="${col}"/>`);
    const label = escHtml(actNames[band.actIdx] || `Act ${band.actIdx + 1}`);
    svg.push(`<text x="${((x1+x2)/2).toFixed(1)}" y="13" text-anchor="middle" font-size="8.5" fill="rgba(255,255,255,0.3)" font-family="sans-serif">${label}</text>`);
    if (band.actIdx < actBands.length - 1) {
      svg.push(`<line x1="${x2.toFixed(1)}" y1="${PAD_T}" x2="${x2.toFixed(1)}" y2="${iconCY + ICON_R}" stroke="rgba(255,255,255,0.1)" stroke-width="1" stroke-dasharray="3,3"/>`);
    }
  }

  // Y-axis
  svg.push(`<line x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${PAD_T + GRAPH_H}" stroke="rgba(255,255,255,0.1)" stroke-width="1"/>`);
  const yTicks = [maxHpEver, Math.round(maxHpEver / 2), 0];
  for (const hpVal of yTicks) {
    const yt = yHp(hpVal).toFixed(1);
    svg.push(`<line x1="${PAD_L}" y1="${yt}" x2="${VW - PAD_R}" y2="${yt}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>`);
    svg.push(`<text x="${PAD_L - 4}" y="${(parseFloat(yt) + 3).toFixed(1)}" text-anchor="end" font-size="7.5" fill="rgba(255,255,255,0.28)" font-family="sans-serif">${hpVal}</text>`);
  }

  // Max HP line
  const maxHpPairs = nodes
    .map((n, i) => n.maxHp !== null ? { i, maxHp: n.maxHp } : null)
    .filter(Boolean);
  const maxHpLineStr = maxHpPairs.map(p => `${xOf(p.i).toFixed(1)},${yHp(p.maxHp).toFixed(1)}`).join(' ');
  if (maxHpLineStr) svg.push(`<polyline points="${maxHpLineStr}" fill="none" stroke="#4a9fd4" stroke-width="1.2" stroke-dasharray="4,3" stroke-linejoin="round" stroke-linecap="round" opacity="0.7"/>`);

  // Current HP area + line
  if (areaStr) svg.push(`<polygon points="${areaStr}" fill="url(#hpAreaFill)"/>`);
  if (lineStr)  svg.push(`<polyline points="${lineStr}" fill="none" stroke="#27ae60" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`);

  // Connector stubs from HP dot to icon
  for (const p of hpPairs) {
    const x  = xOf(p.i).toFixed(1);
    const y1 = (yHp(p.hp) + DOT_R + 1).toFixed(1);
    const y2 = (iconCY - ICON_R - 1).toFixed(1);
    if (parseFloat(y2) > parseFloat(y1)) {
      svg.push(`<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="rgba(255,255,255,0.08)" stroke-width="0.8"/>`);
    }
  }

  // HP dots (color by health %)
  for (const p of hpPairs) {
    const pct = p.hp / p.maxHp;
    const dc  = pct > 0.5 ? '#2ecc71' : pct > 0.25 ? '#e67e22' : '#e74c3c';
    svg.push(`<circle cx="${xOf(p.i).toFixed(1)}" cy="${yHp(p.hp).toFixed(1)}" r="${DOT_R}" fill="${dc}" stroke="rgba(0,0,0,0.4)" stroke-width="0.7"/>`);
  }

  // Node icons (clickable)
  for (let i = 0; i < N; i++) {
    const n   = nodes[i];
    const cfg = NODE_CFG[n.category] || NODE_CFG.event;
    const x   = xOf(i);
    const cx  = x.toFixed(1);
    const cy  = iconCY.toFixed(1);
    svg.push(`<g class="graph-node-icon" data-node-idx="${i}" style="cursor:pointer">`);
    // Background circle (colored per encounter type)
    svg.push(`<circle cx="${cx}" cy="${cy}" r="${ICON_R}" fill="${cfg.bg}" stroke="none" style="pointer-events:none"/>`);
    // Dashed outline for unknown/dim variants
    if (cfg.dim) {
      svg.push(`<circle cx="${cx}" cy="${cy}" r="${(ICON_R + 1.5).toFixed(1)}" fill="none" stroke="${cfg.color}" stroke-width="1.2" stroke-dasharray="2.5,2" opacity="0.85" style="pointer-events:none"/>`);
    }
    svg.push(`<image href="appdata://images/map_icons/${cfg.img}" x="${(x - ICON_R).toFixed(1)}" y="${(iconCY - ICON_R).toFixed(1)}" width="${ICON_R * 2}" height="${ICON_R * 2}" style="pointer-events:none"/>`);
    // Invisible hit target on top to capture hover/click
    svg.push(`<circle cx="${cx}" cy="${cy}" r="${ICON_R}" fill="transparent" stroke="none"/>`);
    svg.push(`</g>`);
  }

  svg.push(`</svg>`);
  wrap.innerHTML = svg.join('');
}

// Parse a localization title key into { name, option }
// e.g. "JUNGLE_MAZE_ADVENTURE.pages.INITIAL.options.SOLO_QUEST.title"
//   → { name: "Jungle Maze Adventure", option: "Solo Quest" }
// e.g. "STONE_HUMIDIFIER.title" (table=relics)
//   → { name: "Stone Humidifier", option: null }
function parseTitleKey(key) {
  if (!key) return { name: '—', option: null };
  const parts = key.split('.');
  const name  = idToDisplayName(parts[0]);
  const optIdx = parts.indexOf('options');
  const option = (optIdx >= 0 && optIdx + 1 < parts.length)
    ? idToDisplayName(parts[optIdx + 1])
    : null;
  return { name, option };
}

function openNodePopup(nodeIdx) {
  const node = _currentRunNodes[nodeIdx];
  if (!node) return;

  const cfg = NODE_CFG[node.category] || NODE_CFG.event;

  const catLabels = {
    ancient: 'Ancient', monster: 'Hallway Fight', elite: 'Elite Fight',
    boss: 'Boss Fight', shop: 'Shop', rest_site: 'Rest Site', treasure: 'Treasure',
    event: 'Event', unknown_fight: 'Hidden Fight', unknown_shop: 'Hidden Shop',
    unknown_treasure: 'Hidden Treasure',
  };

  const hpText   = node.hp !== null ? `${node.hp} / ${node.maxHp} HP` : '—';
  const dmgText  = node.damageTaken > 0 ? `${node.damageTaken} damage taken` : 'no damage taken';
  const healText = node.hpHealed > 0 ? `, +${node.hpHealed} healed` : '';

  // Primary name: derive from title.key (most accurate) or model_id
  let primaryName = formatModelDisplay(node.modelId);
  let chosenOption = null;

  const firstChoice = node.eventChoices[0];
  if (firstChoice?.title?.key) {
    const parsed = parseTitleKey(firstChoice.title.key);
    primaryName  = parsed.name;
    chosenOption = parsed.option;
  }

  let detailsHtml = '';

  // Fight nodes: encounter name from model_id + monster list
  if (['monster', 'elite', 'boss', 'unknown_fight'].includes(node.category)) {
    if (node.monsterIds.length) {
      const unique = [...new Set(node.monsterIds.map(formatMonsterId))];
      detailsHtml += `<div class="node-popup-tags">${unique.map(m => `<span class="node-popup-tag">${escHtml(m)}</span>`).join('')}</div>`;
    }
  }

  // Event nodes: chosen option + data from events.json
  if (['event', 'unknown_fight'].includes(node.category) || node.roomType === 'event') {
    if (chosenOption) {
      detailsHtml += `<p class="node-popup-chose">Chose: <strong>${escHtml(chosenOption)}</strong></p>`;
    }
    const evData = lookupEventByModelId(node.modelId);
    if (evData) {
      if (evData.imageFile) {
        detailsHtml += `<img src="appdata://images/event_images/${escHtml(evData.imageFile)}" alt="${escHtml(evData.name)}" class="node-popup-event-img"/>`;
      }
      if (evData.description) {
        detailsHtml += `<p class="node-popup-desc">${escHtml(evData.description)}</p>`;
      } else if (evData.flavor) {
        detailsHtml += `<p class="node-popup-desc node-popup-flavor">${escHtml(evData.flavor)}</p>`;
      }
    }
  }

  // Ancient: show all 3 relic options (which was picked)
  if (node.category === 'ancient' && node.ancientChoices.length) {
    primaryName = 'Ancient Relic Choice';
    const tags = node.ancientChoices.map(c => {
      const key  = c.TextKey || c.textKey || '?';
      const name = idToDisplayName(key);
      return `<span class="node-popup-tag${c.was_chosen ? ' chosen' : ''}">${c.was_chosen ? '✓ ' : ''}${escHtml(name)}</span>`;
    }).join('');
    detailsHtml += `<div class="node-popup-tags">${tags}</div>`;
  }

  // Relic choices from elite/treasure
  if (['elite', 'treasure', 'unknown_treasure'].includes(node.category) && node.relicChoices.length) {
    const tags = node.relicChoices.map(c => {
      const name = idToDisplayName(c.choice || '');
      return `<span class="node-popup-tag${c.was_picked ? ' chosen' : ''}">${c.was_picked ? '✓ ' : ''}${escHtml(name)}</span>`;
    }).join('');
    detailsHtml += `<div class="node-popup-tags">${tags}</div>`;
  }

  // Rest site: what action was taken
  if (node.category === 'rest_site' && node.restChoices.length) {
    const actionLabels = { HEAL: 'Rest (heal)', SMITH: 'Upgrade a card', RECALL: 'Lift a curse', LIFT: 'Lift curse', PURGE: 'Remove a card' };
    const actions = node.restChoices.map(a => actionLabels[a] || idToDisplayName(a));
    detailsHtml += `<div class="node-popup-tags">${actions.map(a => `<span class="node-popup-tag chosen">${escHtml(a)}</span>`).join('')}</div>`;
  }

  const badge = document.getElementById('nodePopupCatBadge');
  badge.textContent    = catLabels[node.category] || node.category;
  badge.style.color    = cfg.color;
  badge.style.borderColor = cfg.color;

  document.getElementById('nodePopupName').textContent   = primaryName;
  document.getElementById('nodePopupHp').textContent     = `${hpText}  ·  ${dmgText}${healText}`;
  document.getElementById('nodePopupDetails').innerHTML  = detailsHtml;
  document.getElementById('nodePopup').style.display     = 'flex';
}

function showRunDetail(run) {
  _currentDetailRun = run;
  _detailPlayerIdx  = 0;
  document.getElementById('mainContent').style.display = 'none';
  document.getElementById('runDetailView').style.display = '';
  document.getElementById('runDetailView').scrollTop = 0;

  _deckSorted = false;  // reset sort state for each new run
  const sortBtn = document.getElementById('deckSortBtn');
  if (sortBtn) sortBtn.textContent = 'Unsorted';

  renderDetailMeta(run);
  renderHpGraph(run, 0);

  const players = run.players || [];
  const tabsWrap = document.getElementById('detailPlayerTabsWrap');
  const tabsEl   = document.getElementById('detailPlayerTabs');

  if (isCoop(run)) {
    // Build tab buttons
    tabsEl.innerHTML = players.map((p, i) =>
      `<button class="player-tab-btn${i === 0 ? ' active' : ''}" data-player-idx="${i}">${escHtml(parseCharacter(p.character))}</button>`
    ).join('');
    tabsWrap.style.display = '';

    // Tab click handler
    tabsEl.onclick = (e) => {
      const btn = e.target.closest('.player-tab-btn');
      if (!btn) return;
      tabsEl.querySelectorAll('.player-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const idx = parseInt(btn.dataset.playerIdx, 10);
      _detailPlayerIdx = idx;
      renderHpGraph(run, idx);
      renderDetailRelics(players[idx]?.relics || []);
      renderDetailDeck(players[idx]?.deck || []);
    };

    renderDetailRelics(players[0]?.relics || []);
    renderDetailDeck(players[0]?.deck || []);
  } else {
    tabsWrap.style.display = 'none';
    tabsEl.innerHTML = '';
    renderDetailRelics(players[0]?.relics || []);
    renderDetailDeck(players[0]?.deck || []);
  }

  // Update favorite button state
  const btn = document.getElementById('detailFavBtn');
  const isFav = favoritesSet.has(runKey(run));
  btn.classList.toggle('active', isFav);
  btn.dataset.runKey = runKey(run);
}

function hideRunDetail() {
  document.getElementById('runDetailView').style.display = 'none';
  document.getElementById('mainContent').style.display = '';
}

function renderDetailMeta(run) {
  const coop    = isCoop(run);
  const players = run.players || [];
  const asc     = run.ascension != null ? run.ascension : '—';
  const outcome = outcomeLabel(run);
  const date    = formatDate(run.start_time);
  const dur     = formatDurationFull(run.run_time);
  const floor   = run.floor_reached != null ? run.floor_reached : '—';
  const seed    = run.seed_played != null ? run.seed_played : (run.seed != null ? run.seed : '—');

  const charLabel = coop ? 'Players' : 'Character';
  const charValue = coop
    ? players.map(p => parseCharacter(p.character)).join(' & ')
    : parseCharacter(players[0]?.character);

  const stats = [
    { label: charLabel, value: charValue },
    { label: 'Ascension', value: `Asc ${asc}` },
    { label: 'Outcome',   value: outcome.label, cls: `outcome-${outcome.type}` },
    { label: 'Date',      value: date },
    { label: 'Duration',  value: dur },
    { label: 'Floor',     value: floor },
    { label: 'Seed',      value: seed, mono: true },
  ];

  if (run.score != null) stats.push({ label: 'Score', value: run.score });
  if (run.gold  != null) stats.push({ label: 'Gold',  value: `${run.gold}g` });

  document.getElementById('detailMetaRow').innerHTML = stats.map(({ label, value, cls, mono }) => `
    <div class="detail-stat">
      <span class="detail-stat-label">${escHtml(label)}</span>
      <span class="detail-stat-value${mono ? ' mono' : ''}${cls ? ' ' + cls : ''}">${escHtml(String(value))}</span>
    </div>`).join('');
}

function renderDetailRelics(relics) {
  currentDetailRelics = relics;
  const count = document.getElementById('detailRelicsCount');
  const row   = document.getElementById('detailRelicsRow');
  count.textContent = `(${relics.length})`;

  if (relics.length === 0) {
    row.innerHTML = '<div style="color:var(--text-muted);padding:8px 0;">No relics.</div>';
    return;
  }

  row.innerHTML = relics.map((r, i) => {
    const id   = r.id || r;
    const name = typeof id === 'string' ? idToDisplayName(id) : String(r);
    const data = typeof id === 'string' ? lookupRelicData(id) : null;

    const imgHtml = data?.imageFile
      ? `<img src="appdata://images/relic_images/${escHtml(data.imageFile)}" alt="${escHtml(name)}" />`
      : `<div class="relic-icon-placeholder">${escHtml(name.slice(0, 2).toUpperCase())}</div>`;

    return `
      <button class="relic-icon-btn" data-relic-idx="${i}" title="${escHtml(name)}">
        ${imgHtml}
        <span class="relic-icon-name">${escHtml(name)}</span>
      </button>`;
  }).join('');
}

// ── Deck sort ─────────────────────────────────────────────────────────────────

const CARD_TYPE_ORDER   = { Power: 0, Attack: 1, Skill: 2, Curse: 3, Status: 4, Quest: 5 };
const CARD_RARITY_ORDER = { Basic: 0, Token: 0, Status: 0, Common: 1, Uncommon: 2, Rare: 3, Ancient: 4, Event: 4, Quest: 4, Curse: 4 };

let _deckSorted = false;       // current toggle state
let _currentDeck = [];         // original order, preserved for unsorted restore
let _currentDetailRun = null;  // run currently shown in detail view
let _detailPlayerIdx  = 0;    // which player tab is active in detail view

function cardSortKey(card) {
  const id   = card.id || card;
  const data = typeof id === 'string' ? lookupCardData(id) : null;
  const typeOrd   = CARD_TYPE_ORDER[data?.type]   ?? 6;
  const rarityOrd = CARD_RARITY_ORDER[data?.rarity] ?? 5;
  return [typeOrd, rarityOrd];
}

function getSortedDeck(deck) {
  return [...deck].sort((a, b) => {
    const [at, ar] = cardSortKey(a);
    const [bt, br] = cardSortKey(b);
    if (at !== bt) return at - bt;
    if (ar !== br) return ar - br;
    const an = idToDisplayName(a.id || a).toLowerCase();
    const bn = idToDisplayName(b.id || b).toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

function renderDetailDeck(deck) {
  _currentDeck = deck;
  const count = document.getElementById('detailDeckCount');
  const grid  = document.getElementById('detailCardGrid');
  const btn   = document.getElementById('deckSortBtn');
  if (btn) btn.classList.toggle('active', _deckSorted);
  count.textContent = `(${deck.length})`;

  if (deck.length === 0) {
    grid.innerHTML = '<div style="color:var(--text-muted);padding:8px 0;">No cards.</div>';
    return;
  }

  const displayDeck = _deckSorted ? getSortedDeck(deck) : deck;

  grid.innerHTML = displayDeck.map((card) => {
    const id       = card.id || card;
    const upgraded = (card.current_upgrade_level || 0) >= 1;
    const name     = typeof id === 'string' ? idToDisplayName(id) : String(card);
    const data     = typeof id === 'string' ? lookupCardData(id) : null;

    const enchId   = card.enchantment?.id;
    const enchData = enchId ? lookupEnchantmentData(enchId) : null;
    const enchName = enchData?.name || (enchId ? idToDisplayName(enchId) : null);

    let inner;
    if (data?.imageFile) {
      const imgFile = upgraded && data.imageFileUpgraded ? data.imageFileUpgraded : data.imageFile;
      const displayName = data.name || name;
      inner = `<img src="appdata://images/card_images/${escHtml(imgFile)}" alt="${escHtml(displayName)}" loading="lazy" />`;
    } else {
      inner = `<div class="card-img-placeholder">${escHtml(name)}</div>`;
    }

    const enchIconHtml = enchName && enchData?.imageFile
      ? `<button class="card-enchant-icon" data-enchant-id="${escHtml(enchId)}" title="${escHtml(enchName)}">
           <img src="appdata://images/enchantment_images/${escHtml(enchData.imageFile)}" alt="${escHtml(enchName)}" />
         </button>`
      : '';

    return `
      <div class="card-grid-item">
        ${inner}
        ${enchIconHtml}
      </div>`;
  }).join('');
}

// ── Relic popup ───────────────────────────────────────────────────────────────

function openRelicPopup(relicEntry) {
  const id   = relicEntry?.id || relicEntry;
  const name = typeof id === 'string' ? idToDisplayName(id) : '?';
  const data = typeof id === 'string' ? lookupRelicData(id) : null;

  const imgWrap = document.getElementById('popupRelicImgWrap');
  imgWrap.innerHTML = data?.imageFile
    ? `<img src="appdata://images/relic_images/${escHtml(data.imageFile)}" alt="${escHtml(name)}" />`
    : `<div class="relic-icon-placeholder large">${escHtml(name.slice(0, 2).toUpperCase())}</div>`;

  document.getElementById('popupRelicName').textContent = data?.name || name;

  const metaParts = [];
  if (data?.rarity)    metaParts.push(data.rarity);
  if (data?.character) metaParts.push(data.character);
  document.getElementById('popupRelicMeta').textContent = metaParts.join(' · ');

  document.getElementById('popupRelicDesc').textContent = data?.description || '—';

  document.getElementById('relicPopup').style.display = 'flex';
}

function closeRelicPopup() {
  document.getElementById('relicPopup').style.display = 'none';
}

function openRelicPopupByName(name) {
  const data = relicsMap.get(normalizeName(name));
  const imgWrap = document.getElementById('popupRelicImgWrap');
  imgWrap.innerHTML = data?.imageFile
    ? `<img src="appdata://images/relic_images/${escHtml(data.imageFile)}" alt="${escHtml(name)}" />`
    : `<div class="relic-icon-placeholder large">${escHtml(name.slice(0, 2).toUpperCase())}</div>`;
  document.getElementById('popupRelicName').textContent = data?.name || name;
  const metaParts = [];
  if (data?.rarity)    metaParts.push(data.rarity);
  if (data?.character) metaParts.push(data.character);
  document.getElementById('popupRelicMeta').textContent = metaParts.join(' · ');
  document.getElementById('popupRelicDesc').textContent = data?.description || '—';
  document.getElementById('relicPopup').style.display = 'flex';
}

function openCardPopup(cardName) {
  const data = cardsMap.get(normalizeName(cardName));
  document.getElementById('cardPopupName').textContent = data?.name || cardName;
  const metaParts = [];
  if (data?.type)   metaParts.push(data.type);
  if (data?.rarity) metaParts.push(data.rarity);
  document.getElementById('cardPopupMeta').textContent = metaParts.join(' · ');

  const baseImg = data?.imageFile
    ? `<img src="appdata://images/card_images/${escHtml(data.imageFile)}" alt="${escHtml(cardName)}" />`
    : `<div class="card-img-placeholder">${escHtml(cardName)}</div>`;
  const upImg = data?.imageFileUpgraded
    ? `<img src="appdata://images/card_images/${escHtml(data.imageFileUpgraded)}" alt="${escHtml(cardName)}+" />`
    : '';

  document.getElementById('cardPopupImages').innerHTML =
    `<div class="card-popup-img-wrap"><p>Base</p>${baseImg}</div>` +
    (upImg ? `<div class="card-popup-img-wrap"><p>Upgraded</p>${upImg}</div>` : '');

  document.getElementById('cardPopup').style.display = 'flex';
}

function closeCardPopup() {
  document.getElementById('cardPopup').style.display = 'none';
}

function openEventPopup(name) {
  const data = eventsMap.get(normalizeName(name));
  const imgWrap = document.getElementById('eventPopupImgWrap');
  imgWrap.innerHTML = data?.imageFile
    ? `<img src="appdata://images/event_images/${escHtml(data.imageFile)}" alt="${escHtml(name)}" />`
    : `<div class="event-img-placeholder">${escHtml(name.slice(0, 2).toUpperCase())}</div>`;
  document.getElementById('eventPopupName').textContent = data?.name || name;
  document.getElementById('eventPopupFlavor').textContent = data?.flavor || '';
  document.getElementById('eventPopupFlavor').style.display = data?.flavor ? '' : 'none';
  document.getElementById('eventPopupDesc').textContent = data?.description || '—';
  document.getElementById('eventPopup').style.display = 'flex';
}

function closeEventPopup() {
  document.getElementById('eventPopup').style.display = 'none';
}

function openPotionPopup(id) {
  const name = typeof id === 'string' ? idToDisplayName(id) : String(id);
  const data = typeof id === 'string' ? lookupPotionData(id) : null;

  const imgWrap = document.getElementById('popupPotionImgWrap');
  imgWrap.innerHTML = data?.imageFile
    ? `<img src="appdata://images/potion_images/${escHtml(data.imageFile)}" alt="${escHtml(data.name || name)}" />`
    : `<div class="relic-icon-placeholder large">${escHtml(name.slice(0, 2).toUpperCase())}</div>`;

  document.getElementById('popupPotionName').textContent = data?.name || name;

  const metaParts = [];
  if (data?.rarity)    metaParts.push(data.rarity);
  if (data?.character) metaParts.push(data.character);
  document.getElementById('popupPotionMeta').textContent = metaParts.join(' · ');

  document.getElementById('popupPotionDesc').textContent = data?.description || '—';

  document.getElementById('potionPopup').style.display = 'flex';
}

function closePotionPopup() {
  document.getElementById('potionPopup').style.display = 'none';
}

function openEnchantmentPopup(data) {
  const imgWrap = document.getElementById('popupRelicImgWrap');
  imgWrap.innerHTML = data.imageFile
    ? `<img src="appdata://images/enchantment_images/${escHtml(data.imageFile)}" alt="${escHtml(data.name)}" />`
    : `<div class="relic-icon-placeholder large">${escHtml((data.name || '?').slice(0, 2).toUpperCase())}</div>`;

  document.getElementById('popupRelicName').textContent = data.name || '—';

  const metaParts = [];
  if (data.source)     metaParts.push(`Source: ${data.source}`);
  if (data.targetCard) metaParts.push(`Applies to: ${data.targetCard}`);
  document.getElementById('popupRelicMeta').textContent = metaParts.join(' · ');

  document.getElementById('popupRelicDesc').textContent = data.description || '—';

  document.getElementById('relicPopup').style.display = 'flex';
}

// ── Runs table ────────────────────────────────────────────────────────────────

const PAGE_SIZE = 12;

let currentFolder    = null;
let refreshDebounce  = null;
let currentRunPage   = 0;
let lastFilteredRuns = [];
let allSortedRuns    = [];
let allFiles         = [];
let favoritesSet     = new Set();

function runKey(run) {
  return `${run.start_time || 0}_${run.run_time || 0}_${run.players?.[0]?.character || ''}`;
}

async function doExportToPastebin(apiKey) {
  const btn = document.getElementById('detailPastebinBtn');
  if (!_currentDetailRun?._filePath) {
    btn.textContent = '⚠ No file path';
    setTimeout(() => { btn.textContent = '📤 Pastebin'; }, 2000);
    return;
  }
  const orig = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Uploading…';
  const result = await window.electronAPI.exportToPastebin(_currentDetailRun._filePath, apiKey);
  btn.disabled = false;
  if (result.error) {
    btn.textContent = '⚠ Failed';
    setTimeout(() => { btn.textContent = orig; }, 2500);
    console.error('Pastebin export error:', result.error);
  } else {
    btn.textContent = '✓ Link Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  }
}

async function copyRunToClipboard(run, btn) {
  try {
    const ok = run._filePath
      ? await window.electronAPI.copyFile(run._filePath)
      : false;
    if (ok && btn) {
      const orig = btn.textContent;
      btn.classList.add('copied');
      btn.textContent = btn.id ? '✓ Copied!' : '✓';
      setTimeout(() => { btn.classList.remove('copied'); btn.textContent = orig; }, 1500);
    }
  } catch (_) {}
}

function renderAllRuns(runs) {
  const container  = document.getElementById('allRunsWrap');
  const pagination = document.getElementById('runsPagination');

  const sorted  = [...runs]
    .filter((r) => typeof r.start_time === 'number')
    .sort((a, b) => b.start_time - a.start_time);
  const noDate  = runs.filter((r) => typeof r.start_time !== 'number');
  allSortedRuns = [...sorted, ...noDate];

  const totalPages = Math.max(1, Math.ceil(allSortedRuns.length / PAGE_SIZE));
  currentRunPage   = Math.min(currentRunPage, totalPages - 1);

  const pageStart = currentRunPage * PAGE_SIZE;
  const pageRuns  = allSortedRuns.slice(pageStart, pageStart + PAGE_SIZE);

  pagination.innerHTML = `
    <span class="page-info">${allSortedRuns.length} run${allSortedRuns.length !== 1 ? 's' : ''}</span>
    <button class="page-btn" id="pagePrev" ${currentRunPage === 0 ? 'disabled' : ''}>&#8592;</button>
    <span class="page-info">Page ${currentRunPage + 1} of ${totalPages}</span>
    <button class="page-btn" id="pageNext" ${currentRunPage >= totalPages - 1 ? 'disabled' : ''}>&#8594;</button>`;

  document.getElementById('pagePrev').addEventListener('click', () => {
    if (currentRunPage > 0) { currentRunPage--; renderAllRuns(lastFilteredRuns); }
  });
  document.getElementById('pageNext').addEventListener('click', () => {
    if (currentRunPage < totalPages - 1) { currentRunPage++; renderAllRuns(lastFilteredRuns); }
  });

  if (allSortedRuns.length === 0) {
    container.innerHTML = '<div class="empty-state">No runs match the current filters.</div>';
    return;
  }

  const rows = pageRuns.map((run, localIdx) => {
    const globalIdx = pageStart + localIdx;
    const coop      = isCoop(run);
    const players   = run.players || [];
    const charCell  = coop
      ? players.map(p => escHtml(parseCharacter(p.character))).join(' <span style="color:var(--text-muted)">＆</span> ')
          + ' <span class="coop-badge">CO-OP</span>'
      : escHtml(parseCharacter(players[0]?.character));
    const asc       = typeof run.ascension === 'number' ? run.ascension : '?';
    const date      = formatDate(run.start_time);
    const dur       = formatDurationFull(run.run_time);
    const outcome   = outcomeLabel(run);
    const relicCount = players.reduce((s, p) => s + (p.relics || []).length, 0);
    const cardCount  = players.reduce((s, p) => s + (p.deck   || []).length, 0);
    const isFav      = favoritesSet.has(runKey(run));

    let badgeClass = 'badge-abandoned';
    if (outcome.type === 'win')  badgeClass = 'badge-win';
    if (outcome.type === 'loss') badgeClass = 'badge-loss';

    const resultBadge = `<span class="badge ${badgeClass}">${escHtml(outcome.label)}</span>`;
    const deathCell   = outcome.type === 'loss'
      ? `<span class="run-death">${escHtml(outcome.cause)}</span>`
      : `<span style="color:var(--text-muted);">—</span>`;

    return `
      <tr class="run-row${isFav ? ' favorited' : ''}" data-idx="${globalIdx}">
        <td class="col-fav"><button class="fav-btn${isFav ? ' active' : ''}" title="${isFav ? 'Unfavorite' : 'Favorite'}">★</button></td>
        <td class="col-copy"><button class="copy-btn" title="Copy run to clipboard">📋</button></td>
        <td class="col-char run-char">${charCell}</td>
        <td class="col-asc">${asc}</td>
        <td class="col-result">${resultBadge}</td>
        <td class="col-date run-date">${date}</td>
        <td class="col-death">${deathCell}</td>
        <td class="col-dur run-dur">${dur}</td>
        <td class="col-counts"><span class="run-counts">${relicCount}R · ${cardCount}C</span></td>
        <td class="col-arrow">›</td>
      </tr>`;
  }).join('');

  container.innerHTML = `
    <table class="data-table runs-table">
      <thead>
        <tr>
          <th class="col-fav"></th>
          <th class="col-copy"></th>
          <th class="col-char">Character</th>
          <th class="col-asc">Asc</th>
          <th class="col-result">Result</th>
          <th class="col-date">Date</th>
          <th class="col-death">Killed By</th>
          <th class="col-dur">Duration</th>
          <th class="col-counts"></th>
          <th class="col-arrow"></th>
        </tr>
      </thead>
      <tbody id="runsTableBody">${rows}</tbody>
    </table>`;

  document.getElementById('runsTableBody').addEventListener('click', async (e) => {
    // Copy button
    const copyBtn = e.target.closest('.copy-btn');
    if (copyBtn) {
      const row = copyBtn.closest('.run-row');
      const idx = parseInt(row?.dataset.idx, 10);
      if (!isNaN(idx) && allSortedRuns[idx]) {
        await copyRunToClipboard(allSortedRuns[idx], copyBtn);
      }
      return;
    }

    // Favorite button takes priority
    const favBtn = e.target.closest('.fav-btn');
    if (favBtn) {
      const row = favBtn.closest('.run-row');
      const idx = parseInt(row?.dataset.idx, 10);
      if (!isNaN(idx) && allSortedRuns[idx]) {
        const run   = allSortedRuns[idx];
        const key   = runKey(run);
        const newFavs = await window.electronAPI.toggleFavorite(key);
        favoritesSet  = new Set(newFavs);
        const nowFav  = favoritesSet.has(key);
        favBtn.classList.toggle('active', nowFav);
        favBtn.title = nowFav ? 'Unfavorite' : 'Favorite';
        row.classList.toggle('favorited', nowFav);
        // If filtering by favorites, unfavoriting should remove the row
        if (currentFilters.favoritedOnly) {
          const filtered = applyFilters(allFiles, currentFilters);
          lastFilteredRuns = filtered;
          currentRunPage   = 0;
          const stats = computeStats(filtered);
          renderSummary(stats);
          renderCharBreakdown(stats.charBreakdown);
          renderDeathList(stats.topDeaths);
          renderAscDistribution(stats.ascDistribution);
          renderAllRuns(filtered);
        }
      }
      return;
    }

    const row = e.target.closest('.run-row');
    if (!row) return;
    const idx = parseInt(row.dataset.idx, 10);
    if (!isNaN(idx) && allSortedRuns[idx]) showRunDetail(allSortedRuns[idx]);
  });
}

// ── Utility ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Insights View ─────────────────────────────────────────────────────────────

const MIN_SAMPLES = 3;  // used for upgrade, pick rates
let _relicMinSamples     = 3;
let _cardMinSamples      = 3;
let _relicPairMinSamples = 3;
let _cardDuoMinSamples   = 3;
let _cardTrioMinSamples  = 3;
let _eventMinSamples     = 3;
let _ancientMinSamples   = 1;
let _upgradeMinSamples   = 3;

let _relicSortDesc     = true;
let _cardSortDesc      = true;
let _eventSortDesc     = true;
let _ancientSortDesc   = true;
let _upgradeSortDesc   = true;
let _relicPairSortDesc = true;
let _cardDuoSortDesc   = true;
let _cardTrioSortDesc  = true;
let _insightSortHandlers = null;

function showInsights() {
  document.getElementById('mainContent').style.display   = 'none';
  document.getElementById('runDetailView').style.display = 'none';
  document.getElementById('insightsView').style.display  = '';
  document.getElementById('insightsView').scrollTop      = 0;
  renderInsightsView(lastFilteredRuns);
}

function hideInsights() {
  const v = document.getElementById('insightsView');
  if (v) v.style.display = 'none';
}

// Starter relics excluded from relic statistics (always in every run, skew data)
const STARTER_RELIC_NORMS = new Set([
  'burning blood', 'ring of the snake', 'divine right', 'bound phylactery', 'cracked core',
].map(normalizeName));

// Cards excluded from statistics — starter deck cards present in every run.
// IDs are like CARD.STRIKE_IRONCLAD, CARD.DEFEND_NECROBINDER, CARD.ASCENDERS_BANE, etc.
// \b fails for STRIKE_IRONCLAD because _ is a word character, so match explicitly.
const EXCLUDED_CARD_NORMS = new Set([
  'ascenders bane',
  // Character starter cards (in every run for their respective character)
  'bash', 'venerate', 'falling star', 'survivor', 'neutralize',
  'unleash', 'bodyguard', 'zap', 'dualcast',
]);

function isBasicStarterCard(id) {
  if (/(?:^|\.)(STRIKE|DEFEND)_/i.test(id)) return true;
  const norm = normalizeName(idToDisplayName(id));
  return EXCLUDED_CARD_NORMS.has(norm);
}

function computeInsights(runs) {
  if (!runs.length) return null;
  const N = runs.length;
  const getRelics = (r) => r.players?.[0]?.relics  ?? [];
  const getDeck   = (r) => r.players?.[0]?.deck     ?? [];

  // ── Relic win rate ────────────────────────────────────────────────────────
  const relicWrMap = new Map();
  for (const run of runs) {
    const seen = new Set();
    for (const r of getRelics(run)) {
      const norm = normalizeName(idToDisplayName(r.id));
      if (STARTER_RELIC_NORMS.has(norm)) continue;
      if (seen.has(norm)) continue; seen.add(norm);
      if (!relicWrMap.has(norm)) {
        const rd = relicsMap.get(norm);
        relicWrMap.set(norm, { name: rd?.name || idToDisplayName(r.id), imageFile: rd?.imageFile || '', w: 0, t: 0 });
      }
      const s = relicWrMap.get(norm); s.t++; if (run.win) s.w++;
    }
  }
  const relicRankingAll = [...relicWrMap.values()]
    .map(s => ({ ...s, wr: s.w / s.t }))
    .sort((a, b) => b.wr - a.wr);
  const relicMaxSamples = relicRankingAll.length ? Math.max(...relicRankingAll.map(r => r.t)) : 0;

  // ── Card win rate ─────────────────────────────────────────────────────────
  const cardWrMapLocal = new Map();
  for (const run of runs) {
    const seen = new Set();
    for (const c of getDeck(run)) {
      if (isBasicStarterCard(c.id)) continue;
      const norm = normalizeName(idToDisplayName(c.id));
      if (seen.has(norm)) continue; seen.add(norm);
      if (!cardWrMapLocal.has(norm)) {
        cardWrMapLocal.set(norm, { name: idToDisplayName(c.id), w: 0, t: 0 });
      }
      const s = cardWrMapLocal.get(norm); s.t++; if (run.win) s.w++;
    }
  }
  const cardRankingAll = [...cardWrMapLocal.values()]
    .map(s => ({ ...s, wr: s.w / s.t }))
    .sort((a, b) => b.wr - a.wr);
  const cardMaxSamples = cardRankingAll.length ? Math.max(...cardRankingAll.map(c => c.t)) : 0;

  // ── Card upgrade impact ───────────────────────────────────────────────────
  // Per run: a card is "has base" if ≥1 non-upgraded copy is in deck,
  // "has upgraded" if ≥1 upgraded copy is in deck. Counted once per run each.
  const upgradeMap = new Map();
  for (const run of runs) {
    const seenBase = new Set();
    const seenUp   = new Set();
    for (const c of getDeck(run)) {
      if (isBasicStarterCard(c.id)) continue;
      const norm = normalizeName(idToDisplayName(c.id));
      if (!upgradeMap.has(norm)) upgradeMap.set(norm, { name: idToDisplayName(c.id), base: {w:0,t:0}, up: {w:0,t:0} });
      const s = upgradeMap.get(norm);
      if ((c.current_upgrade_level || 0) > 0) {
        if (!seenUp.has(norm)) { seenUp.add(norm); s.up.t++; if (run.win) s.up.w++; }
      } else {
        if (!seenBase.has(norm)) { seenBase.add(norm); s.base.t++; if (run.win) s.base.w++; }
      }
    }
  }
  const upgradeRankingAll = [...upgradeMap.values()]
    .filter(s => s.up.t > 0 && s.base.t > 0)
    .map(s => ({
      name: s.name,
      baseWR: s.base.w / s.base.t, upWR: s.up.w / s.up.t,
      delta: (s.up.w / s.up.t) - (s.base.w / s.base.t),
      baseTotal: s.base.t, upTotal: s.up.t,
      minTotal: Math.min(s.base.t, s.up.t),
    }))
    .sort((a, b) => b.delta - a.delta);
  const upgradeMaxSamples = upgradeRankingAll.length
    ? Math.max(...upgradeRankingAll.map(u => u.minTotal))
    : 0;

  // ── Strike / defend removal ───────────────────────────────────────────────
  const strikeImpact = { removed: {w:0,t:0}, kept: {w:0,t:0} };
  const defendImpact = { removed: {w:0,t:0}, kept: {w:0,t:0} };
  for (const run of runs) {
    const deck = getDeck(run);
    const hasStrike = deck.some(c => isBasicStarterCard(c.id) && /STRIKE/i.test(c.id));
    const hasDefend = deck.some(c => isBasicStarterCard(c.id) && /DEFEND/i.test(c.id));
    const sb = hasStrike ? strikeImpact.kept   : strikeImpact.removed;
    const db = hasDefend ? defendImpact.kept   : defendImpact.removed;
    sb.t++; if (run.win) sb.w++;
    db.t++; if (run.win) db.w++;
  }

  // ── Deck size vs win rate ─────────────────────────────────────────────────
  const deckBuckets = new Map();
  for (const run of runs) {
    const sz = getDeck(run).length;
    const b  = Math.floor(sz / 5) * 5;
    if (!deckBuckets.has(b)) deckBuckets.set(b, {w:0,t:0});
    const bkt = deckBuckets.get(b); bkt.t++; if (run.win) bkt.w++;
  }
  const deckSizeData = [...deckBuckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, v]) => v.t >= MIN_SAMPLES)
    .map(([b, v]) => ({ label: `${b}–${b+4}`, wr: v.w / v.t, total: v.t, wins: v.w }));

  // ── Relic pairs ───────────────────────────────────────────────────────────
  const relicPairMap = new Map();
  for (const run of runs) {
    const relics = [...new Set(getRelics(run).map(r => normalizeName(idToDisplayName(r.id))))].filter(n => !STARTER_RELIC_NORMS.has(n));
    for (let i = 0; i < relics.length; i++) {
      for (let j = i+1; j < relics.length; j++) {
        const key = [relics[i], relics[j]].sort().join('\x00');
        if (!relicPairMap.has(key)) {
          const [a, bk] = key.split('\x00');
          const rdA = relicsMap.get(a), rdB = relicsMap.get(bk);
          relicPairMap.set(key, { nameA: rdA?.name||a, nameB: rdB?.name||bk, imgA: rdA?.imageFile||'', imgB: rdB?.imageFile||'', w:0, t:0 });
        }
        const s = relicPairMap.get(key); s.t++; if (run.win) s.w++;
      }
    }
  }
  const relicPairRankingAll = [...relicPairMap.values()]
    .map(s => ({ ...s, wr: s.w / s.t }))
    .sort((a, b) => b.wr - a.wr);
  const relicPairMaxSamples = relicPairRankingAll.length ? Math.max(...relicPairRankingAll.map(r => r.t)) : 0;

  // ── Card pairs & trios (limited to top-30 most-seen cards) ────────────────
  const cardFreqMap = new Map();
  for (const run of runs) {
    const seen = new Set();
    for (const c of getDeck(run)) {
      if (isBasicStarterCard(c.id)) continue;
      const norm = normalizeName(idToDisplayName(c.id));
      if (!seen.has(norm)) { seen.add(norm); cardFreqMap.set(norm, (cardFreqMap.get(norm) || 0) + 1); }
    }
  }
  const topCardNorms = [...cardFreqMap.entries()].sort((a,b) => b[1]-a[1]).map(([n]) => n);
  const top30 = new Set(topCardNorms.slice(0, 30));
  const top20 = new Set(topCardNorms.slice(0, 20));

  const cardPairMap = new Map();
  const cardTrioMap = new Map();
  for (const run of runs) {
    const deck30 = [...new Set(getDeck(run).map(c => normalizeName(idToDisplayName(c.id))))].filter(n => top30.has(n));
    const deck20 = deck30.filter(n => top20.has(n));
    // pairs
    for (let i = 0; i < deck30.length; i++) {
      for (let j = i+1; j < deck30.length; j++) {
        const key = [deck30[i], deck30[j]].sort().join('\x00');
        if (!cardPairMap.has(key)) {
          const [a,b] = key.split('\x00');
          cardPairMap.set(key, { nameA: cardWrMapLocal.get(a)?.name||a, nameB: cardWrMapLocal.get(b)?.name||b, w:0, t:0 });
        }
        const s = cardPairMap.get(key); s.t++; if (run.win) s.w++;
      }
    }
    // trios
    for (let i = 0; i < deck20.length; i++) {
      for (let j = i+1; j < deck20.length; j++) {
        for (let k = j+1; k < deck20.length; k++) {
          const key = [deck20[i], deck20[j], deck20[k]].sort().join('\x00');
          if (!cardTrioMap.has(key)) {
            const [a,b,c] = key.split('\x00');
            cardTrioMap.set(key, { nameA: cardWrMapLocal.get(a)?.name||a, nameB: cardWrMapLocal.get(b)?.name||b, nameC: cardWrMapLocal.get(c)?.name||c, w:0, t:0 });
          }
          const s = cardTrioMap.get(key); s.t++; if (run.win) s.w++;
        }
      }
    }
  }
  const cardPairRankingAll = [...cardPairMap.values()]
    .map(s => ({ ...s, wr: s.w / s.t }))
    .sort((a, b) => b.wr - a.wr);
  const cardPairMaxSamples = cardPairRankingAll.length ? Math.max(...cardPairRankingAll.map(p => p.t)) : 0;

  const cardTrioRankingAll = [...cardTrioMap.values()]
    .map(s => ({ ...s, wr: s.w / s.t }))
    .sort((a, b) => b.wr - a.wr);
  const cardTrioMaxSamples = cardTrioRankingAll.length ? Math.max(...cardTrioRankingAll.map(p => p.t)) : 0;

  // ── Event win rate ────────────────────────────────────────────────────────
  const eventWrMap = new Map();
  for (const run of runs) {
    const seen = new Set();
    const nodes = parseRunMap(run);
    for (const node of nodes) {
      if (node.category === 'ancient') continue;
      if (node.category !== 'event' && !node.modelId?.startsWith('EVENT.')) continue;
      let displayName = null;
      if (node.modelId && node.modelId.startsWith('EVENT.')) {
        displayName = idToDisplayName(node.modelId);
      } else {
        continue;
      }
      const norm = normalizeName(displayName);
      if (seen.has(norm)) continue; seen.add(norm);
      if (!eventWrMap.has(norm)) {
        const ev = eventsMap.get(norm);
        eventWrMap.set(norm, { name: ev?.name || displayName, imageFile: ev?.imageFile || '', w: 0, t: 0 });
      }
      const s = eventWrMap.get(norm); s.t++; if (run.win) s.w++;
    }
  }
  const eventRankingAll = [...eventWrMap.values()]
    .map(s => ({ ...s, wr: s.w / s.t }))
    .sort((a, b) => b.wr - a.wr);
  const eventMaxSamples = eventRankingAll.length ? Math.max(...eventRankingAll.map(e => e.t)) : 0;

  // ── Ancient win rate ──────────────────────────────────────────────────────
  const ancientWrMap = new Map();
  for (const run of runs) {
    const seen = new Set();
    const nodes = parseRunMap(run);
    for (const node of nodes) {
      if (node.category !== 'ancient') continue;
      if (!node.modelId?.startsWith('EVENT.')) continue;
      const displayName = idToDisplayName(node.modelId);
      const norm = normalizeName(displayName);
      if (seen.has(norm)) continue; seen.add(norm);
      if (!ancientWrMap.has(norm)) {
        const ev = eventsMap.get(norm);
        ancientWrMap.set(norm, { name: ev?.name || displayName, w: 0, t: 0 });
      }
      const s = ancientWrMap.get(norm); s.t++; if (run.win) s.w++;
    }
  }
  const ancientRankingAll = [...ancientWrMap.values()]
    .map(s => ({ ...s, wr: s.w / s.t }))
    .sort((a, b) => b.wr - a.wr);
  const ancientMaxSamples = ancientRankingAll.length ? Math.max(...ancientRankingAll.map(e => e.t)) : 0;

  // ── Pick rates ────────────────────────────────────────────────────────────
  const relicPickRate = [...relicWrMap.values()]
    .map(s => ({ ...s, rate: N > 0 ? s.t / N : 0 }))
    .sort((a, b) => b.t - a.t).slice(0, 20);
  const cardPickRate = [...cardWrMapLocal.values()]
    .map(s => ({ ...s, rate: N > 0 ? s.t / N : 0 }))
    .sort((a, b) => b.t - a.t).slice(0, 20);

  // ── Longest win streak ────────────────────────────────────────────────────
  let longestStreak = 0, curStreak = 0;
  const sorted = [...runs].sort((a, b) => (a.start_time || 0) - (b.start_time || 0));
  for (const run of sorted) {
    if (run.win) { curStreak++; longestStreak = Math.max(longestStreak, curStreak); }
    else curStreak = 0;
  }

  // ── Character rankings ────────────────────────────────────────────────────
  const charWrMap = new Map();
  for (const run of runs) {
    const char = parseCharacter(run.players?.[0]?.character);
    if (!charWrMap.has(char)) charWrMap.set(char, {w:0,t:0});
    const s = charWrMap.get(char); s.t++; if (run.win) s.w++;
  }
  const charRanking = [...charWrMap.entries()]
    .map(([char, s]) => ({ char, wins: s.w, losses: s.t - s.w, total: s.t, wr: s.t > 0 ? s.w/s.t : 0 }))
    .sort((a, b) => b.total - a.total);

  return {
    relicRankingAll,     relicMaxSamples,
    cardRankingAll,      cardMaxSamples,
    relicPairRankingAll, relicPairMaxSamples,
    cardPairRankingAll,  cardPairMaxSamples,
    cardTrioRankingAll,  cardTrioMaxSamples,
    eventRankingAll,     eventMaxSamples,
    ancientRankingAll,   ancientMaxSamples,
    upgradeRankingAll,   upgradeMaxSamples,
    strikeImpact, defendImpact, deckSizeData,
    relicPickRate, cardPickRate,
    longestStreak, charRanking, totalRuns: N,
  };
}

function renderInsightsView(runs) {
  const content = document.getElementById('insightsContent');

  // Filter context label
  const ctx = [];
  if (currentFilters.character !== 'all') ctx.push(currentFilters.character);
  if (currentFilters.ascLevels !== null) {
    const lvls = [...currentFilters.ascLevels].sort((a,b)=>a-b);
    ctx.push(lvls.length <= 3 ? lvls.map(l=>`A${l}`).join(', ') : `${lvls.length} ascension levels`);
  }
  if (currentFilters.winOnly)  ctx.push('Wins only');
  if (currentFilters.abandoned === 'exclude') ctx.push('No abandoned');
  document.getElementById('insightsFilterNote').textContent =
    `${runs.length} runs${ctx.length ? ' · Filters: ' + ctx.join(' · ') : ''}`;

  if (!runs.length) {
    content.innerHTML = '<div class="empty-state" style="margin:60px auto;text-align:center">No runs match current filters.</div>';
    return;
  }

  const ins = computeInsights(runs);
  if (!ins) { content.innerHTML = '<div class="empty-state">No data.</div>'; return; }

  // ── Helpers ───────────────────────────────────────────────────────────────
  const wrBar = (wr, total) => {
    const pct   = (wr * 100).toFixed(1);
    const color = wr >= 0.6 ? '#27ae60' : wr >= 0.4 ? '#e67e22' : '#e74c3c';
    return `<div class="wr-bar-wrap">
      <div class="wr-bar"><div class="wr-fill" style="width:${pct}%;background:${color}"></div></div>
      <span class="wr-pct">${pct}%</span>
      <span class="wr-n">(${total})</span>
    </div>`;
  };
  const relicIcon = (imgFile, name) => {
    const inner = imgFile
      ? `<img src="appdata://images/relic_images/${escHtml(imgFile)}" alt="${escHtml(name)}" class="insight-relic-icon" title="${escHtml(name)}" />`
      : `<span class="insight-relic-placeholder" title="${escHtml(name)}">${escHtml(name.slice(0,2))}</span>`;
    return `<span class="insight-relic-clickable" data-relic-name="${escHtml(name)}">${inner}</span>`;
  };
  const cardLink = (name) =>
    `<span class="insight-card-link" data-insight-card="${escHtml(name)}">${escHtml(name)}</span>`;
  const eventLink = (name) =>
    `<span class="insight-event-link" data-insight-event="${escHtml(name)}">${escHtml(name)}</span>`;
  const card = (title, body, note = '') => `
    <div class="card insight-card collapsed">
      <div class="card-header" style="display:flex;align-items:center;">
        <h2 style="flex:1;margin:0">${title}</h2>${note ? `<span class="insight-note">${note}</span>` : ''}
      </div>
      <div class="insight-card-body">${body}</div>
    </div>`;
  const emptyState = '<div class="empty-state" style="padding:16px">No entries meet the minimum sample threshold.</div>';
  const tableWrap = (thead, tbody) => tbody
    ? `<div class="insight-table-wrap"><table class="data-table insight-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`
    : emptyState;

  // Clamp persisted values to current dataset maxes (initial load defaults are 3)
  _relicMinSamples     = Math.min(_relicMinSamples,     ins.relicMaxSamples);
  _cardMinSamples      = Math.min(_cardMinSamples,      ins.cardMaxSamples);
  _relicPairMinSamples = Math.min(_relicPairMinSamples, ins.relicPairMaxSamples);
  _cardDuoMinSamples   = Math.min(_cardDuoMinSamples,   ins.cardPairMaxSamples);
  _cardTrioMinSamples  = Math.min(_cardTrioMinSamples,  ins.cardTrioMaxSamples);
  _eventMinSamples     = Math.min(_eventMinSamples,     ins.eventMaxSamples);
  _ancientMinSamples   = Math.min(_ancientMinSamples,   ins.ancientMaxSamples);
  _upgradeMinSamples   = Math.min(_upgradeMinSamples,   ins.upgradeMaxSamples);

  const buildRelicWrRows = (minN) => {
    const rows = ins.relicRankingAll.filter(r => r.t >= minN);
    if (!_relicSortDesc) rows.reverse();
    return rows.slice(0, 25).map((r, i) =>
      `<tr><td class="insight-rank">${i+1}</td><td>${relicIcon(r.imageFile, r.name)}</td><td><span class="insight-relic-clickable" data-relic-name="${escHtml(r.name)}">${escHtml(r.name)}</span></td><td>${wrBar(r.wr, r.t)}</td></tr>`
    ).join('');
  };

  const buildCardWrRows = (minN) => {
    const rows = ins.cardRankingAll.filter(c => c.t >= minN);
    if (!_cardSortDesc) rows.reverse();
    return rows.slice(0, 25).map((c, i) =>
      `<tr><td class="insight-rank">${i+1}</td><td>${cardLink(c.name)}</td><td>${wrBar(c.wr, c.t)}</td></tr>`
    ).join('');
  };

  const buildEventWrRows = (minN) => {
    const rows = ins.eventRankingAll.filter(e => e.t >= minN);
    if (!_eventSortDesc) rows.reverse();
    return rows.slice(0, 25).map((e, i) =>
      `<tr><td class="insight-rank">${i+1}</td><td>${eventLink(e.name)}</td><td>${wrBar(e.wr, e.t)}</td></tr>`
    ).join('');
  };

  const buildAncientWrRows = (minN) => {
    const rows = ins.ancientRankingAll.filter(e => e.t >= minN);
    if (!_ancientSortDesc) rows.reverse();
    return rows.map((e, i) =>
      `<tr><td class="insight-rank">${i+1}</td><td>${eventLink(e.name)}</td><td>${wrBar(e.wr, e.t)}</td></tr>`
    ).join('');
  };

  const sortBtn = (key, desc) =>
    `<button class="sort-toggle-btn ${desc ? 'sort-desc' : 'sort-asc'}" data-sort-toggle="${key}" title="${desc ? 'Highest first' : 'Lowest first'}">${desc ? '↓' : '↑'}</button>`;

  const relicSlider = `
    <div class="insight-slider-wrap">
      <span class="insight-slider-label">Min samples: <strong id="relicMinSamplesVal">${_relicMinSamples}</strong></span>
      <input type="range" class="insight-slider" id="relicMinSamplesSlider"
        min="0" max="${ins.relicMaxSamples}" value="${_relicMinSamples}" />
      ${sortBtn('relicWr', _relicSortDesc)}
    </div>`;
  const cardSlider = `
    <div class="insight-slider-wrap">
      <span class="insight-slider-label">Min samples: <strong id="cardMinSamplesVal">${_cardMinSamples}</strong></span>
      <input type="range" class="insight-slider" id="cardMinSamplesSlider"
        min="0" max="${ins.cardMaxSamples}" value="${_cardMinSamples}" />
      ${sortBtn('cardWr', _cardSortDesc)}
    </div>`;

  const sections = [];

  // ── 1. Relic & Card Win Rate ──────────────────────────────────────────────
  sections.push(`<div class="two-col">
    ${card('Relic Win Rate', relicSlider + `<div id="relicWrTableWrap">${tableWrap('<tr><th>#</th><th></th><th>Relic</th><th>Win Rate</th></tr>', buildRelicWrRows(_relicMinSamples))}</div>`)}
    ${card('Card Win Rate',  cardSlider  + `<div id="cardWrTableWrap">${tableWrap('<tr><th>#</th><th>Card</th><th>Win Rate</th></tr>',           buildCardWrRows(_cardMinSamples))}</div>`)}
  </div>`);

  // ── 2. Best Relic Pairs ───────────────────────────────────────────────────
  const buildRelicPairRows = (minN) => {
    const rows = ins.relicPairRankingAll.filter(p => p.t >= minN);
    if (!_relicPairSortDesc) rows.reverse();
    return rows.slice(0, 15).map((p, i) => `<tr><td class="insight-rank">${i+1}</td>
     <td><div class="combo-icons">${relicIcon(p.imgA, p.nameA)}${relicIcon(p.imgB, p.nameB)}</div></td>
     <td class="combo-names"><span class="insight-relic-clickable" data-relic-name="${escHtml(p.nameA)}">${escHtml(p.nameA)}</span> <span class="combo-plus">+</span> <span class="insight-relic-clickable" data-relic-name="${escHtml(p.nameB)}">${escHtml(p.nameB)}</span></td>
     <td>${wrBar(p.wr, p.t)}</td></tr>`).join('');
  };

  const buildCardDuoRows = (minN) => {
    const rows = ins.cardPairRankingAll.filter(p => p.t >= minN);
    if (!_cardDuoSortDesc) rows.reverse();
    return rows.slice(0, 15).map((p, i) => `<tr><td class="insight-rank">${i+1}</td>
     <td class="combo-names">${cardLink(p.nameA)} <span class="combo-plus">+</span> ${cardLink(p.nameB)}</td>
     <td>${wrBar(p.wr, p.t)}</td></tr>`).join('');
  };

  const buildCardTrioRows = (minN) => {
    const rows = ins.cardTrioRankingAll.filter(p => p.t >= minN);
    if (!_cardTrioSortDesc) rows.reverse();
    return rows.slice(0, 12).map((p, i) => `<tr><td class="insight-rank">${i+1}</td>
     <td class="combo-names">${cardLink(p.nameA)} <span class="combo-plus">+</span> ${cardLink(p.nameB)} <span class="combo-plus">+</span> ${cardLink(p.nameC)}</td>
     <td>${wrBar(p.wr, p.t)}</td></tr>`).join('');
  };

  const mkSlider = (id, valId, max, val, sortKey, sortDesc) => `
    <div class="insight-slider-wrap">
      <span class="insight-slider-label">Min samples: <strong id="${valId}">${val}</strong></span>
      <input type="range" class="insight-slider" id="${id}" min="0" max="${max}" value="${val}" />
      ${sortBtn(sortKey, sortDesc)}
    </div>`;

  // ── 1b. Event & Ancient Win Rate ──────────────────────────────────────────
  sections.push(`<div class="two-col">
    ${card('Event Win Rate',
      mkSlider('eventWrSlider', 'eventWrVal', ins.eventMaxSamples, _eventMinSamples, 'eventWr', _eventSortDesc) +
      `<div id="eventWrTableWrap">${tableWrap('<tr><th>#</th><th>Event</th><th>Win Rate</th></tr>', buildEventWrRows(_eventMinSamples))}</div>`)}
    ${card('Ancient Win Rate',
      mkSlider('ancientWrSlider', 'ancientWrVal', ins.ancientMaxSamples, _ancientMinSamples, 'ancientWr', _ancientSortDesc) +
      `<div id="ancientWrTableWrap">${tableWrap('<tr><th>#</th><th>Ancient</th><th>Win Rate</th></tr>', buildAncientWrRows(_ancientMinSamples))}</div>`)}
  </div>`);

  sections.push(card('Best Relic Pairs',
    mkSlider('relicPairSlider', 'relicPairVal', ins.relicPairMaxSamples, _relicPairMinSamples, 'relicPair', _relicPairSortDesc) +
    `<div id="relicPairWrap">${tableWrap('<tr><th>#</th><th></th><th>Combination</th><th>Win Rate</th></tr>', buildRelicPairRows(_relicPairMinSamples))}</div>`));

  // ── 3. Best Card Duos ─────────────────────────────────────────────────────
  sections.push(card('Best Card Duos',
    mkSlider('cardDuoSlider', 'cardDuoVal', ins.cardPairMaxSamples, _cardDuoMinSamples, 'cardDuo', _cardDuoSortDesc) +
    `<div id="cardDuoWrap">${tableWrap('<tr><th>#</th><th>Combination</th><th>Win Rate</th></tr>', buildCardDuoRows(_cardDuoMinSamples))}</div>`,
    'top 30 most-seen cards'));

  // ── 4. Best Card Trios ────────────────────────────────────────────────────
  sections.push(card('Best Card Trios',
    mkSlider('cardTrioSlider', 'cardTrioVal', ins.cardTrioMaxSamples, _cardTrioMinSamples, 'cardTrio', _cardTrioSortDesc) +
    `<div id="cardTrioWrap">${tableWrap('<tr><th>#</th><th>Combination</th><th>Win Rate</th></tr>', buildCardTrioRows(_cardTrioMinSamples))}</div>`,
    'top 20 most-seen cards'));

  // ── 5. Card Upgrade Impact ────────────────────────────────────────────────
  const buildUpgradeRows = (minN) => {
    const rows = ins.upgradeRankingAll.filter(u => u.minTotal >= minN);
    if (!_upgradeSortDesc) rows.reverse();
    return rows.slice(0, 25).map((u, i) => {
      const d   = (u.delta * 100).toFixed(1);
      const cls = u.delta >= 0.03 ? 'delta-pos' : u.delta <= -0.03 ? 'delta-neg' : 'delta-neu';
      return `<tr>
        <td class="insight-rank">${i+1}</td>
        <td>${cardLink(u.name)}</td>
        <td>${(u.baseWR*100).toFixed(1)}% <span class="wr-n">(${u.baseTotal})</span></td>
        <td>${(u.upWR*100).toFixed(1)}% <span class="wr-n">(${u.upTotal})</span></td>
        <td class="${cls}">${u.delta >= 0 ? '+' : ''}${d}%</td>
      </tr>`;
    }).join('');
  };
  sections.push(card('Card Upgrade Impact',
    mkSlider('upgradeSlider', 'upgradeVal', ins.upgradeMaxSamples, _upgradeMinSamples, 'upgrade', _upgradeSortDesc) +
    `<div id="upgradeWrap">${tableWrap('<tr><th>#</th><th>Card</th><th>Base WR</th><th>Upgraded WR</th><th>Delta</th></tr>', buildUpgradeRows(_upgradeMinSamples))}</div>`,
    'min of base / upgraded samples'));

  // ── 6. Strike & Defend Removal ────────────────────────────────────────────
  const impactCard = (title, impact) => {
    const { removed, kept } = impact;
    const removedWR = removed.t > 0 ? removed.w / removed.t : null;
    const keptWR    = kept.t    > 0 ? kept.w    / kept.t    : null;
    return card(title, `<table class="data-table insight-table">
      <thead><tr><th>State</th><th>Win Rate</th></tr></thead>
      <tbody>
        <tr><td>Kept all</td><td>${keptWR !== null ? wrBar(keptWR, kept.t) : '<span class="wr-n">—</span>'}</td></tr>
        <tr><td>Removed all</td><td>${removedWR !== null ? wrBar(removedWR, removed.t) : '<span class="wr-n">—</span>'}</td></tr>
      </tbody></table>`);
  };
  sections.push(`<div class="two-col">
    ${impactCard('Strike Removal Impact', ins.strikeImpact)}
    ${impactCard('Defend Removal Impact', ins.defendImpact)}
  </div>`);

  // ── 7. Deck Size vs Win Rate ──────────────────────────────────────────────
  if (ins.deckSizeData.length) {
    const maxWr = Math.max(...ins.deckSizeData.map(d => d.wr), 0.01);
    const deckBars = ins.deckSizeData.map(d => {
      const barW  = ((d.wr / maxWr) * 100).toFixed(1);
      const color = d.wr >= 0.6 ? '#27ae60' : d.wr >= 0.4 ? '#e67e22' : '#e74c3c';
      return `<div class="deck-size-row">
        <span class="deck-size-label">${d.label} cards</span>
        <div class="deck-size-bar-wrap"><div class="deck-size-bar" style="width:${barW}%;background:${color}"></div></div>
        <span class="deck-size-wr">${(d.wr*100).toFixed(1)}%</span>
        <span class="wr-n">${d.total} runs</span>
      </div>`;
    }).join('');
    sections.push(card('Deck Size vs Win Rate', `<div class="deck-size-chart">${deckBars}</div>`));
  }

  // ── 8. Most Picked Relics & Cards ────────────────────────────────────────
  const relicPickRows = ins.relicPickRate.map((r, i) =>
    `<tr><td class="insight-rank">${i+1}</td><td>${relicIcon(r.imageFile, r.name)}</td><td><span class="insight-relic-clickable" data-relic-name="${escHtml(r.name)}">${escHtml(r.name)}</span></td>
     <td>${r.t} <span class="wr-n">${(r.rate*100).toFixed(0)}% of runs</span></td></tr>`
  ).join('');
  const cardPickRows = ins.cardPickRate.map((c, i) =>
    `<tr><td class="insight-rank">${i+1}</td><td>${cardLink(c.name)}</td>
     <td>${c.t} <span class="wr-n">${(c.rate*100).toFixed(0)}%</span></td></tr>`
  ).join('');
  sections.push(`<div class="two-col">
    ${card('Most Picked Relics', tableWrap('<tr><th>#</th><th></th><th>Relic</th><th>Seen in</th></tr>', relicPickRows))}
    ${card('Most Picked Cards',  tableWrap('<tr><th>#</th><th>Card</th><th>Seen in</th></tr>', cardPickRows))}
  </div>`);

  // ── 9. Character Rankings & Win Streak ───────────────────────────────────
  const charRows = ins.charRanking.map(c => `
    <tr>
      <td>${escHtml(c.char)}</td>
      <td style="color:var(--green)">${c.wins}</td>
      <td style="color:#e74c3c">${c.losses}</td>
      <td>${wrBar(c.wr, c.total)}</td>
    </tr>`).join('');
  const streakHtml = `<div class="streak-block">
    <div class="streak-stat">
      <div class="streak-value">${ins.longestStreak}</div>
      <div class="streak-label">Longest Win Streak</div>
    </div>
    <div class="streak-stat">
      <div class="streak-value">${ins.totalRuns}</div>
      <div class="streak-label">Runs Analyzed</div>
    </div>
    <div class="streak-stat">
      <div class="streak-value">${ins.totalRuns > 0 ? (runs.filter(r=>r.win).length / ins.totalRuns * 100).toFixed(1) : '—'}%</div>
      <div class="streak-label">Overall Win Rate</div>
    </div>
  </div>`;
  sections.push(`<div class="two-col">
    ${card('Summary', streakHtml)}
    ${card('Character Rankings', tableWrap('<tr><th>Character</th><th>W</th><th>L</th><th>Win Rate</th></tr>', charRows))}
  </div>`);

  // ── Sort handler registry (used by the delegated click handler) ──────────
  _insightSortHandlers = {
    relicWr:   { get: () => _relicSortDesc,   set: v => { _relicSortDesc = v; },   wrapId: 'relicWrTableWrap',
                 render: () => tableWrap('<tr><th>#</th><th></th><th>Relic</th><th>Win Rate</th></tr>', buildRelicWrRows(_relicMinSamples)) },
    cardWr:    { get: () => _cardSortDesc,    set: v => { _cardSortDesc = v; },    wrapId: 'cardWrTableWrap',
                 render: () => tableWrap('<tr><th>#</th><th>Card</th><th>Win Rate</th></tr>', buildCardWrRows(_cardMinSamples)) },
    eventWr:   { get: () => _eventSortDesc,   set: v => { _eventSortDesc = v; },   wrapId: 'eventWrTableWrap',
                 render: () => tableWrap('<tr><th>#</th><th>Event</th><th>Win Rate</th></tr>', buildEventWrRows(_eventMinSamples)) },
    ancientWr: { get: () => _ancientSortDesc, set: v => { _ancientSortDesc = v; }, wrapId: 'ancientWrTableWrap',
                 render: () => tableWrap('<tr><th>#</th><th>Ancient</th><th>Win Rate</th></tr>', buildAncientWrRows(_ancientMinSamples)) },
    upgrade:   { get: () => _upgradeSortDesc, set: v => { _upgradeSortDesc = v; }, wrapId: 'upgradeWrap',
                 render: () => tableWrap('<tr><th>#</th><th>Card</th><th>Base WR</th><th>Upgraded WR</th><th>Delta</th></tr>', buildUpgradeRows(_upgradeMinSamples)) },
    relicPair: { get: () => _relicPairSortDesc, set: v => { _relicPairSortDesc = v; }, wrapId: 'relicPairWrap',
                 render: () => tableWrap('<tr><th>#</th><th></th><th>Combination</th><th>Win Rate</th></tr>', buildRelicPairRows(_relicPairMinSamples)) },
    cardDuo:   { get: () => _cardDuoSortDesc,   set: v => { _cardDuoSortDesc = v; },   wrapId: 'cardDuoWrap',
                 render: () => tableWrap('<tr><th>#</th><th>Combination</th><th>Win Rate</th></tr>', buildCardDuoRows(_cardDuoMinSamples)) },
    cardTrio:  { get: () => _cardTrioSortDesc,  set: v => { _cardTrioSortDesc = v; },  wrapId: 'cardTrioWrap',
                 render: () => tableWrap('<tr><th>#</th><th>Combination</th><th>Win Rate</th></tr>', buildCardTrioRows(_cardTrioMinSamples)) },
  };

  content.innerHTML = sections.join('');

  // ── Wire up min-samples sliders ───────────────────────────────────────────
  const relicSliderEl = document.getElementById('relicMinSamplesSlider');
  const relicValEl    = document.getElementById('relicMinSamplesVal');
  const relicWrapEl   = document.getElementById('relicWrTableWrap');
  relicSliderEl.addEventListener('input', () => {
    _relicMinSamples = parseInt(relicSliderEl.value, 10);
    relicValEl.textContent = _relicMinSamples;
    relicWrapEl.innerHTML = tableWrap(
      '<tr><th>#</th><th></th><th>Relic</th><th>Win Rate</th></tr>',
      buildRelicWrRows(_relicMinSamples)
    );
  });

  const cardSliderEl = document.getElementById('cardMinSamplesSlider');
  const cardValEl    = document.getElementById('cardMinSamplesVal');
  const cardWrapEl   = document.getElementById('cardWrTableWrap');
  cardSliderEl.addEventListener('input', () => {
    _cardMinSamples = parseInt(cardSliderEl.value, 10);
    cardValEl.textContent = _cardMinSamples;
    cardWrapEl.innerHTML = tableWrap(
      '<tr><th>#</th><th>Card</th><th>Win Rate</th></tr>',
      buildCardWrRows(_cardMinSamples)
    );
  });

  const wireSlider = (sliderId, valId, wrapId, statVar, setter, buildFn, thead) => {
    const sl = document.getElementById(sliderId);
    const vl = document.getElementById(valId);
    const wp = document.getElementById(wrapId);
    sl.addEventListener('input', () => {
      setter(parseInt(sl.value, 10));
      vl.textContent = sl.value;
      wp.innerHTML = tableWrap(thead, buildFn(parseInt(sl.value, 10)));
    });
  };

  wireSlider('relicPairSlider', 'relicPairVal', 'relicPairWrap', _relicPairMinSamples,
    v => { _relicPairMinSamples = v; }, buildRelicPairRows,
    '<tr><th>#</th><th></th><th>Combination</th><th>Win Rate</th></tr>');

  wireSlider('cardDuoSlider', 'cardDuoVal', 'cardDuoWrap', _cardDuoMinSamples,
    v => { _cardDuoMinSamples = v; }, buildCardDuoRows,
    '<tr><th>#</th><th>Combination</th><th>Win Rate</th></tr>');

  wireSlider('cardTrioSlider', 'cardTrioVal', 'cardTrioWrap', _cardTrioMinSamples,
    v => { _cardTrioMinSamples = v; }, buildCardTrioRows,
    '<tr><th>#</th><th>Combination</th><th>Win Rate</th></tr>');

  wireSlider('eventWrSlider', 'eventWrVal', 'eventWrTableWrap', _eventMinSamples,
    v => { _eventMinSamples = v; }, buildEventWrRows,
    '<tr><th>#</th><th>Event</th><th>Win Rate</th></tr>');

  wireSlider('ancientWrSlider', 'ancientWrVal', 'ancientWrTableWrap', _ancientMinSamples,
    v => { _ancientMinSamples = v; }, buildAncientWrRows,
    '<tr><th>#</th><th>Ancient</th><th>Win Rate</th></tr>');

  wireSlider('upgradeSlider', 'upgradeVal', 'upgradeWrap', _upgradeMinSamples,
    v => { _upgradeMinSamples = v; }, buildUpgradeRows,
    '<tr><th>#</th><th>Card</th><th>Base WR</th><th>Upgraded WR</th><th>Delta</th></tr>');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function loadAndRender() {
  if (!currentFolder) return;

  // Always return to the main list view (handles refresh from detail/insights page)
  hideRunDetail();
  hideInsights();

  const { error, files } = await window.electronAPI.readRunFiles(currentFolder);

  if (error) {
    document.getElementById('mainContent').style.display = 'none';
    document.getElementById('errorState').style.display = 'block';
    document.getElementById('errorMsg').textContent = `Error reading runs: ${error}`;
    return;
  }

  allFiles = files; // store unfiltered for favorites toggling

  document.getElementById('errorState').style.display = 'none';
  document.getElementById('mainContent').style.display = 'block';

  // Build ascension level list from all runs (unfiltered)
  const ascLevels = [...new Set(
    files.map(r => r.ascension).filter(n => typeof n === 'number')
  )].sort((a, b) => a - b);
  initAscFilter(ascLevels);

  const filtered = applyFilters(files, currentFilters);
  lastFilteredRuns = filtered;
  currentRunPage   = 0;
  const stats = computeStats(filtered);

  renderSummary(stats);
  renderCharBreakdown(stats.charBreakdown);
  renderDeathList(stats.topDeaths);
  renderAscDistribution(stats.ascDistribution);
  renderAllRuns(filtered);
}

function flashRefreshIndicator() {
  const el = document.getElementById('refreshIndicator');
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
}

function scheduleRefresh() {
  clearTimeout(refreshDebounce);
  refreshDebounce = setTimeout(async () => {
    await loadAndRender();
    flashRefreshIndicator();
  }, 500);
}

async function init() {
  const config = await window.electronAPI.getConfig();

  if (!config || !config.historyFolder) {
    await window.electronAPI.navigateToSetup();
    return;
  }

  currentFolder = config.historyFolder;
  document.getElementById('headerFolder').textContent = currentFolder;

  document.getElementById('headerFolderBtn').addEventListener('click', () => {
    const el = document.getElementById('headerFolder');
    el.style.display = el.style.display === 'none' ? '' : 'none';
  });

  refreshResourceLabel();

  // First launch: auto-update resources if data files are missing
  const dataExists = await window.electronAPI.checkDataExists();
  if (!dataExists) {
    await runUpdateResources();
  }

  // Load asset data (relics + cards JSON) and favorites
  await Promise.all([
    loadAssetData(),
    window.electronAPI.getFavorites().then(favs => { favoritesSet = new Set(favs); }),
  ]);

  // Load run data
  await loadAndRender();

  // Hide loading overlay
  const overlay = document.getElementById('loadingOverlay');
  overlay.classList.add('hidden');
  setTimeout(() => overlay.remove(), 400);

  // File watcher
  window.electronAPI.onRunsChanged(scheduleRefresh);

  // Header buttons
  document.getElementById('refreshBtn').addEventListener('click', async () => {
    await loadAndRender();
    flashRefreshIndicator();
  });
  document.getElementById('changeFolderBtn').addEventListener('click', async () => {
    await window.electronAPI.navigateToSetup();
  });
  document.getElementById('retryBtn').addEventListener('click', async () => {
    await loadAndRender();
  });

  // Back button in detail view
  document.getElementById('backBtn').addEventListener('click', () => {
    hideRunDetail();
    renderAllRuns(lastFilteredRuns);
  });

  // Open Run dropdown
  const openRunMenu = document.getElementById('openRunMenu');
  document.getElementById('openRunBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    openRunMenu.style.display = openRunMenu.style.display === 'none' ? '' : 'none';
  });
  document.addEventListener('click', () => { openRunMenu.style.display = 'none'; });

  document.getElementById('openRunDiskBtn').addEventListener('click', async () => {
    openRunMenu.style.display = 'none';
    const run = await window.electronAPI.openRunFile();
    if (!run || run.error) return;
    showRunDetail(run);
  });

  document.getElementById('insightsBtn').addEventListener('click', () => {
    showInsights();
  });
  document.getElementById('backFromInsightsBtn').addEventListener('click', () => {
    hideInsights();
    document.getElementById('mainContent').style.display = 'block';
  });

  // Relic click → popup (event delegation on the row container)
  document.getElementById('detailRelicsRow').addEventListener('click', (e) => {
    const btn = e.target.closest('.relic-icon-btn');
    if (!btn) return;
    const idx = parseInt(btn.dataset.relicIdx, 10);
    if (!isNaN(idx) && currentDetailRelics[idx]) {
      openRelicPopup(currentDetailRelics[idx]);
    }
  });

  // Enchantment icon click → popup (event delegation on card grid)
  document.getElementById('detailCardGrid').addEventListener('click', (e) => {
    const btn = e.target.closest('.card-enchant-icon');
    if (!btn) return;
    e.stopPropagation();
    const enchantId = btn.dataset.enchantId;
    const data = enchantId ? lookupEnchantmentData(enchantId) : null;
    if (data) openEnchantmentPopup(data);
  });

  // Close relic/enchantment popup
  document.getElementById('relicPopupClose').addEventListener('click', closeRelicPopup);
  document.getElementById('relicPopup').addEventListener('click', (e) => {
    if (e.target === document.getElementById('relicPopup')) closeRelicPopup();
  });

  // Close card popup
  document.getElementById('cardPopupClose').addEventListener('click', closeCardPopup);
  document.getElementById('cardPopup').addEventListener('click', (e) => {
    if (e.target === document.getElementById('cardPopup')) closeCardPopup();
  });

  // Close event popup
  document.getElementById('eventPopupClose').addEventListener('click', closeEventPopup);
  document.getElementById('eventPopup').addEventListener('click', (e) => {
    if (e.target === document.getElementById('eventPopup')) closeEventPopup();
  });

  // Close potion popup
  document.getElementById('potionPopupClose').addEventListener('click', closePotionPopup);
  document.getElementById('potionPopup').addEventListener('click', (e) => {
    if (e.target === document.getElementById('potionPopup')) closePotionPopup();
  });

  // Insights: relic, card, event clicks + sort toggle via event delegation
  document.getElementById('insightsContent').addEventListener('click', (e) => {
    // Collapse/expand card on header click
    const cardHeader = e.target.closest('.insight-card .card-header');
    if (cardHeader && !e.target.closest('[data-sort-toggle]')) {
      const clickedCard = cardHeader.closest('.insight-card');
      const twoCol = clickedCard.closest('.two-col');
      const targets = twoCol
        ? [...twoCol.querySelectorAll('.insight-card')]
        : [clickedCard];
      const collapsed = !clickedCard.classList.contains('collapsed');
      targets.forEach(c => c.classList.toggle('collapsed', collapsed));
      return;
    }

    // Sort toggle — check first so button clicks don't bubble to popup handlers
    const sortToggleEl = e.target.closest('[data-sort-toggle]');
    if (sortToggleEl && _insightSortHandlers) {
      const cfg = _insightSortHandlers[sortToggleEl.dataset.sortToggle];
      if (cfg) {
        cfg.set(!cfg.get());
        const desc = cfg.get();
        sortToggleEl.textContent = desc ? '↓' : '↑';
        sortToggleEl.className   = `sort-toggle-btn ${desc ? 'sort-desc' : 'sort-asc'}`;
        sortToggleEl.title       = desc ? 'Highest first' : 'Lowest first';
        document.getElementById(cfg.wrapId).innerHTML = cfg.render();
      }
      return;
    }
    const relicEl = e.target.closest('[data-relic-name]');
    if (relicEl) { openRelicPopupByName(relicEl.dataset.relicName); return; }
    const cardEl = e.target.closest('[data-insight-card]');
    if (cardEl) { openCardPopup(cardEl.dataset.insightCard); return; }
    const eventEl = e.target.closest('[data-insight-event]');
    if (eventEl) { openEventPopup(eventEl.dataset.insightEvent); return; }
  });

  // HP graph node click → node popup
  document.getElementById('hpGraphSvgWrap').addEventListener('click', (e) => {
    const g = e.target.closest('.graph-node-icon');
    if (!g) return;
    const idx = parseInt(g.dataset.nodeIdx, 10);
    if (!isNaN(idx)) openNodePopup(idx);
  });

  // Close node popup
  const closeNodePopup = () => { document.getElementById('nodePopup').style.display = 'none'; };
  document.getElementById('nodePopupClose').addEventListener('click', closeNodePopup);
  document.getElementById('nodePopup').addEventListener('click', (e) => {
    if (e.target === document.getElementById('nodePopup')) closeNodePopup();
  });

  // HP Legend popup
  const legendPopup = document.getElementById('hpLegendPopup');
  const legendBtn   = document.getElementById('hpLegendBtn');
  legendBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (legendPopup.style.display !== 'none') {
      legendPopup.style.display = 'none';
      return;
    }
    // Populate icon rows
    const iconContainer = document.getElementById('hpLegendIcons');
    const NODE_LABELS = [
      { key: 'monster',          label: 'Hallway Fight' },
      { key: 'elite',            label: 'Elite Fight' },
      { key: 'boss',             label: 'Boss' },
      { key: 'shop',             label: 'Shop' },
      { key: 'rest_site',        label: 'Campfire (Rest Site)' },
      { key: 'treasure',         label: 'Relic Chest (Treasure)' },
      { key: 'ancient',          label: 'Ancient' },
      { key: 'event',            label: 'Question Mark (Event / Unknown)' },
    ];
    iconContainer.innerHTML = NODE_LABELS.map(({ key, label }) => {
      const cfg = NODE_CFG[key];
      const bg  = cfg.bg === 'none' ? 'transparent' : cfg.bg;
      const dim = key === 'event' ? ' border:1.5px dashed ' + cfg.color + ';' : '';
      return `<div class="hp-legend-icon-row">
        <div class="hp-legend-icon-wrap" style="background:${bg};${dim}">
          <img src="appdata://images/map_icons/${cfg.img}" alt="${label}"/>
        </div>
        <span>${label}</span>
      </div>`;
    }).join('');

    // Position below the button
    const btnRect = legendBtn.getBoundingClientRect();
    const parentRect = legendBtn.closest('.card').getBoundingClientRect();
    legendPopup.style.top  = (btnRect.bottom - parentRect.top + 6) + 'px';
    legendPopup.style.right = '16px';
    legendPopup.style.left  = 'auto';
    legendPopup.style.position = 'absolute';
    legendBtn.closest('.card').style.position = 'relative';
    legendBtn.closest('.card').appendChild(legendPopup);
    legendPopup.style.display = '';
  });
  document.addEventListener('click', (e) => {
    if (!legendPopup.contains(e.target) && e.target !== legendBtn) {
      legendPopup.style.display = 'none';
    }
  });

  // Help overlay
  const helpOverlay = document.getElementById('helpOverlay');
  document.getElementById('helpBtn').addEventListener('click', () => {
    helpOverlay.style.display = 'flex';
  });
  document.getElementById('helpClose').addEventListener('click', () => {
    helpOverlay.style.display = 'none';
  });
  helpOverlay.addEventListener('click', (e) => {
    if (e.target === helpOverlay) helpOverlay.style.display = 'none';
  });

  document.addEventListener('keydown', (e) => {
    if (_stepperOpen) {
      if (e.key === 'ArrowLeft')  { navigateStepper(-1); e.preventDefault(); return; }
      if (e.key === 'ArrowRight') { navigateStepper(1);  e.preventDefault(); return; }
      if (e.key === 'Escape')     { closeDeckStepper(); return; }
      return;
    }
    if (e.key === 'Escape') {
      closeRelicPopup(); closeCardPopup(); closeNodePopup(); closePotionPopup();
      legendPopup.style.display = 'none';
      helpOverlay.style.display = 'none';
    }
  });

  // ── Filter controls ──────────────────────────────────────────────────────

  document.getElementById('resetFiltersBtn').addEventListener('click', async () => {
    // Reset filter state
    currentFilters.abandoned     = 'include';
    currentFilters.minDuration   = 0;
    currentFilters.mode          = 'solo';
    currentFilters.winOnly       = false;
    currentFilters.character     = 'all';
    currentFilters.searchTokens  = [];
    currentFilters.excludeTokens = [];
    currentFilters.ascLevels     = null;
    currentFilters.favoritedOnly = false;

    // Reset UI controls
    document.getElementById('filterAbandoned').value  = 'include';
    document.getElementById('filterMinDur').value     = 0;
    document.getElementById('minDurValue').textContent = '0';
    document.getElementById('filterWinOnly').checked  = false;
    document.getElementById('filterFavorited').checked = false;
    document.getElementById('filterCharacter').value  = 'all';

    // Mode toggle
    document.querySelectorAll('.mode-toggle-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === 'solo');
    });

    // Clear search tokens
    document.getElementById('tagInputWrap').querySelectorAll('.search-token').forEach(t => t.remove());
    document.getElementById('searchFilterClearAll').style.display = 'none';
    document.getElementById('excludeTagInputWrap').querySelectorAll('.search-token').forEach(t => t.remove());
    document.getElementById('excludeFilterClearAll').style.display = 'none';

    // Ascension: check all
    document.getElementById('ascCheckboxList').querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = true;
    });

    await loadAndRender();
  });

  document.getElementById('filterAbandoned').addEventListener('change', async (e) => {
    currentFilters.abandoned = e.target.value;
    await loadAndRender();
  });

  const minDurSlider = document.getElementById('filterMinDur');
  const minDurValue  = document.getElementById('minDurValue');
  minDurSlider.addEventListener('input', (e) => {
    minDurValue.textContent = e.target.value;
  });
  minDurSlider.addEventListener('change', async (e) => {
    currentFilters.minDuration = parseInt(e.target.value, 10);
    await loadAndRender();
  });

  document.getElementById('filterModeToggle').addEventListener('click', async (e) => {
    const btn = e.target.closest('.mode-toggle-btn');
    if (!btn) return;
    document.querySelectorAll('.mode-toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilters.mode = btn.dataset.mode;
    await loadAndRender();
  });
  document.getElementById('filterWinOnly').addEventListener('change', async (e) => {
    currentFilters.winOnly = e.target.checked;
    await loadAndRender();
  });
  document.getElementById('filterFavorited').addEventListener('change', async (e) => {
    currentFilters.favoritedOnly = e.target.checked;
    await loadAndRender();
  });

  // Detail view favorite button
  document.getElementById('deckSortBtn').addEventListener('click', () => {
    _deckSorted = !_deckSorted;
    document.getElementById('deckSortBtn').textContent = _deckSorted ? 'Sorted' : 'Unsorted';
    renderDetailDeck(_currentDeck);
  });

  document.getElementById('detailCopyBtn').addEventListener('click', async (e) => {
    if (_currentDetailRun) await copyRunToClipboard(_currentDetailRun, e.currentTarget);
  });

  initDeckStepper();

  // ── Pastebin export ───────────────────────────────────────────────────────
  document.getElementById('detailPastebinBtn').addEventListener('click', async () => {
    if (!_currentDetailRun) return;
    const config = await window.electronAPI.getConfig();
    const apiKey = config?.pastebinApiKey || '';
    if (!apiKey) {
      // Show API key modal
      document.getElementById('pastebinApiKeyInput').value = '';
      document.getElementById('pastebinApiKeyError').style.display = 'none';
      document.getElementById('pastebinApiKeyOverlay').style.display = 'flex';
      document.getElementById('pastebinApiKeyInput').focus();
    } else {
      await doExportToPastebin(apiKey);
    }
  });

  document.getElementById('pastebinApiKeyCloseBtn').addEventListener('click', () => {
    document.getElementById('pastebinApiKeyOverlay').style.display = 'none';
  });
  document.getElementById('pastebinApiKeyCancelBtn').addEventListener('click', () => {
    document.getElementById('pastebinApiKeyOverlay').style.display = 'none';
  });
  document.getElementById('pastebinApiKeySaveBtn').addEventListener('click', async () => {
    const key = document.getElementById('pastebinApiKeyInput').value.trim();
    const errEl = document.getElementById('pastebinApiKeyError');
    if (!key) {
      errEl.textContent = 'Please enter your Pastebin API dev key.';
      errEl.style.display = '';
      return;
    }
    // Save to config
    const config = await window.electronAPI.getConfig();
    await window.electronAPI.saveConfig({ ...config, pastebinApiKey: key });
    document.getElementById('pastebinApiKeyOverlay').style.display = 'none';
    await doExportToPastebin(key);
  });

  // ── Pastebin import panel ─────────────────────────────────────────────────
  document.getElementById('pastebinImportBtn').addEventListener('click', () => {
    openRunMenu.style.display = 'none';
    document.getElementById('pastebinImportInput').value = '';
    document.getElementById('pastebinImportError').style.display = 'none';
    document.getElementById('pastebinImportOverlay').style.display = 'flex';
    document.getElementById('pastebinImportInput').focus();
  });

  function closePastebinImport() {
    document.getElementById('pastebinImportOverlay').style.display = 'none';
  }
  document.getElementById('pastebinImportCloseBtn').addEventListener('click', closePastebinImport);
  document.getElementById('pastebinImportCloseBtn2').addEventListener('click', closePastebinImport);

  document.getElementById('pastebinImportOpenBtn').addEventListener('click', async () => {
    const url = document.getElementById('pastebinImportInput').value.trim();
    const errEl = document.getElementById('pastebinImportError');
    const openBtn = document.getElementById('pastebinImportOpenBtn');
    errEl.style.display = 'none';
    if (!url) {
      errEl.textContent = 'Please enter a Pastebin URL.';
      errEl.style.display = '';
      return;
    }
    openBtn.disabled = true;
    openBtn.textContent = 'Loading…';
    const result = await window.electronAPI.fetchPastebin(url);
    openBtn.disabled = false;
    openBtn.textContent = 'Open Run';
    if (result.error) {
      errEl.textContent = result.error;
      errEl.style.display = '';
      return;
    }
    closePastebinImport();
    showRunDetail(result.data);
  });

  document.getElementById('detailFavBtn').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const key = btn.dataset.runKey;
    if (!key) return;
    const newFavs = await window.electronAPI.toggleFavorite(key);
    favoritesSet  = new Set(newFavs);
    const nowFav  = favoritesSet.has(key);
    btn.classList.toggle('active', nowFav);
    btn.textContent = nowFav ? '★ Favorited' : '☆ Favorite';
  });
  document.getElementById('filterCharacter').addEventListener('change', async (e) => {
    currentFilters.character = e.target.value;
    await loadAndRender();
  });

  // ── Ascension filter ────────────────────────────────────────────────────

  // Stop clicks inside the wrap from bubbling to document (keeps panel open)
  document.getElementById('ascFilterWrap').addEventListener('click', (e) => e.stopPropagation());

  document.getElementById('ascFilterBtn').addEventListener('click', () => {
    const panel = document.getElementById('ascFilterPanel');
    panel.style.display = panel.style.display === 'none' ? '' : 'none';
  });

  document.getElementById('ascCheckAll').addEventListener('click', async () => {
    currentFilters.ascLevels = null;
    initAscFilter(_ascAllLevels);
    await loadAndRender();
  });

  document.getElementById('ascUncheckAll').addEventListener('click', async () => {
    currentFilters.ascLevels = new Set();
    initAscFilter(_ascAllLevels);
    await loadAndRender();
  });

  document.getElementById('ascCheckboxList').addEventListener('change', async (e) => {
    const cb = e.target.closest('.asc-checkbox');
    if (!cb) return;
    const lvl = parseInt(cb.dataset.level, 10);
    // Expand null → full Set before mutating
    if (currentFilters.ascLevels === null) {
      currentFilters.ascLevels = new Set(_ascAllLevels);
    }
    if (cb.checked) {
      currentFilters.ascLevels.add(lvl);
    } else {
      currentFilters.ascLevels.delete(lvl);
    }
    // Normalize back to null when everything is checked
    if (currentFilters.ascLevels.size === _ascAllLevels.length) {
      currentFilters.ascLevels = null;
    }
    updateAscBtn();
    await loadAndRender();
  });

  // Close panel when clicking outside
  document.addEventListener('click', () => {
    const panel = document.getElementById('ascFilterPanel');
    if (panel) panel.style.display = 'none';
  });

  // ── Card / Relic search filter ──────────────────────────────────────────

  const searchInput  = document.getElementById('searchFilterInput');
  const searchDropdown = document.getElementById('searchFilterDropdown');

  searchInput.addEventListener('input', updateSearchDropdown);
  searchInput.addEventListener('focus', updateSearchDropdown);
  searchInput.addEventListener('blur', () => {
    // Delay so mousedown on a dropdown item fires before blur hides it
    setTimeout(() => { searchDropdown.style.display = 'none'; }, 160);
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { searchDropdown.style.display = 'none'; searchInput.blur(); }
  });

  // Dropdown item click (mousedown so it fires before blur)
  searchDropdown.addEventListener('mousedown', async (e) => {
    const item = e.target.closest('.search-dropdown-item');
    if (!item) return;
    e.preventDefault(); // prevent input blur
    const nn = item.dataset.normalized;
    if (currentFilters.searchTokens.some(t => t.normalizedName === nn)) return;
    currentFilters.searchTokens.push({
      type: item.dataset.type,
      normalizedName: nn,
      name: item.dataset.name,
      imageFile: item.dataset.imgFile || '',
    });
    searchInput.value = '';
    searchDropdown.style.display = 'none';
    renderSearchTokens();
    await loadAndRender();
  });

  // Token removal (event delegation on the tag wrap)
  document.getElementById('tagInputWrap').addEventListener('click', async (e) => {
    const token = e.target.closest('.search-token');
    if (!token) {
      searchInput.focus(); // clicking empty space focuses input
      return;
    }
    const nn = token.dataset.normalizedName;
    currentFilters.searchTokens = currentFilters.searchTokens.filter(t => t.normalizedName !== nn);
    renderSearchTokens();
    await loadAndRender();
  });

  // Clear all tokens
  document.getElementById('searchFilterClearAll').addEventListener('click', async () => {
    currentFilters.searchTokens = [];
    renderSearchTokens();
    await loadAndRender();
  });

  // ── Exclude card/relic filter ────────────────────────────────────────────
  const excludeInput    = document.getElementById('excludeFilterInput');
  const excludeDropdown = document.getElementById('excludeFilterDropdown');

  excludeInput.addEventListener('input', updateExcludeDropdown);
  excludeInput.addEventListener('focus', updateExcludeDropdown);
  excludeInput.addEventListener('blur', () => {
    setTimeout(() => { excludeDropdown.style.display = 'none'; }, 160);
  });
  excludeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { excludeDropdown.style.display = 'none'; excludeInput.blur(); }
  });

  excludeDropdown.addEventListener('mousedown', async (e) => {
    const item = e.target.closest('.search-dropdown-item');
    if (!item) return;
    e.preventDefault();
    const nn = item.dataset.normalized;
    if (currentFilters.excludeTokens.some(t => t.normalizedName === nn)) return;
    currentFilters.excludeTokens.push({
      type: item.dataset.type,
      normalizedName: nn,
      name: item.dataset.name,
      imageFile: item.dataset.imgFile || '',
    });
    excludeInput.value = '';
    excludeDropdown.style.display = 'none';
    renderExcludeTokens();
    await loadAndRender();
  });

  document.getElementById('excludeTagInputWrap').addEventListener('click', async (e) => {
    const token = e.target.closest('.search-token');
    if (!token) {
      excludeInput.focus();
      return;
    }
    const nn = token.dataset.normalizedName;
    currentFilters.excludeTokens = currentFilters.excludeTokens.filter(t => t.normalizedName !== nn);
    renderExcludeTokens();
    await loadAndRender();
  });

  document.getElementById('excludeFilterClearAll').addEventListener('click', async () => {
    currentFilters.excludeTokens = [];
    renderExcludeTokens();
    await loadAndRender();
  });
}

// ── Resource last-updated label ──────────────────────────────────────────────

function formatResourceAge(ts) {
  if (!ts) return 'never updated';
  const mins  = Math.floor((Date.now() - ts) / 60000);
  if (mins < 2)   return 'updated just now';
  if (mins < 60)  return `updated ${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  const days  = Math.floor(hours / 24);
  return `last updated ${days} day${days === 1 ? '' : 's'} ago`;
}

async function refreshResourceLabel() {
  const meta = await window.electronAPI.getResourceMeta();
  const el   = document.getElementById('resourceLastUpdatedLabel');
  if (el) el.textContent = formatResourceAge(meta.lastUpdated || null);
}

async function markResourceUpdated() {
  await window.electronAPI.setResourceMeta({ lastUpdated: Date.now() });
  refreshResourceLabel();
}

// ── Update Resources overlay ─────────────────────────────────────────────────

// ── Update progress system ────────────────────────────────────────────────────
//
// Heuristic item counts (intentional over-estimates so bar fills smoothly
// and snaps to 100% when the section finishes, typical loading bar behaviour).
const PARSE_HEURISTICS = { relics: 300, cards: 600, enchantments: 20, events: 70 };

// Per-section progress ranges.  Each section has:
//   header    – % when the ━━━ SECTION ━━━ line is seen
//   parseStart/parseEnd – % range swept by per-item "item [N]" prints
//   scraped   – % when "Scraped N / Total unique cards / Found N" is seen
//   imgStart/imgEnd – % range swept by "[N/M]" image download prints
// 0-9%: parallel wiki page fetch phase
// 10-99%: section processing
const SECTION_PROGRESS = {
  relics:       { header: 10, parseStart: 10, parseEnd: 18, scraped: 18, imgStart: 18, imgEnd: 30 },
  cards:        { header: 31, parseStart: 31, parseEnd: 46, scraped: 46, imgStart: 46, imgEnd: 72 },
  enchantments: { header: 73, parseStart: 73, parseEnd: 76, scraped: 76, imgStart: 76, imgEnd: 79 },
  events:       { header: 80, parseStart: 80, parseEnd: 85, scraped: 85, imgStart: 85, imgEnd: 88 },
  map_icons:    { header: 89, parseStart: 89, parseEnd: 89, scraped: 89, imgStart: 89, imgEnd: 99 },
};

let _updateSection = 'relics';
let _fetchedPages  = 0;

function parseUpdateProgress(line, currentPct) {
  // ── Script startup ─────────────────────────────────────────────────────
  if (/Connecting to wiki/.test(line)) return Math.max(currentPct, 1);

  // ── Parallel fetch phase ───────────────────────────────────────────────
  if (/Fetching \d+ wiki page/.test(line)) return Math.max(currentPct, 2);
  if (/✓ Fetched /.test(line)) {
    _fetchedPages++;
    return Math.max(currentPct, 2 + _fetchedPages * 2); // 4, 6, 8, (10 = relics header)
  }

  // ── Section header detection ────────────────────────────────────────────
  if (/━━━ RELICS ━━━/.test(line))       { _updateSection = 'relics';       return Math.max(currentPct, SECTION_PROGRESS.relics.header); }
  if (/━━━ CARDS ━━━/.test(line))        { _updateSection = 'cards';        return Math.max(currentPct, SECTION_PROGRESS.cards.header); }
  if (/━━━ ENCHANTMENTS ━━━/.test(line)) { _updateSection = 'enchantments'; return Math.max(currentPct, SECTION_PROGRESS.enchantments.header); }
  if (/━━━ EVENTS ━━━/.test(line))       { _updateSection = 'events';       return Math.max(currentPct, SECTION_PROGRESS.events.header); }
  if (/━━━ MAP ICONS ━━━/.test(line))    { _updateSection = 'map_icons';    return Math.max(currentPct, SECTION_PROGRESS.map_icons.header); }

  const sp = SECTION_PROGRESS[_updateSection];
  if (!sp) return currentPct;

  // ── Per-item parse progress: "item [N]" ───────────────────────────────
  const itemM = line.match(/\bitem \[(\d+)\]/);
  if (itemM) {
    const n = parseInt(itemM[1]);
    const heuristic = PARSE_HEURISTICS[_updateSection] || 1;
    const ratio = Math.min(n / heuristic, 1.0);
    return Math.max(currentPct, sp.parseStart + ratio * (sp.parseEnd - sp.parseStart));
  }

  // ── End of parse phase (JSON written) ─────────────────────────────────
  if (/Scraped \d+|Total unique cards|Found \d+ (relic|card|event|icon)/.test(line)) {
    return Math.max(currentPct, sp.scraped);
  }

  // ── Image download start ───────────────────────────────────────────────
  if (/Images: downloading \d+|Downloading \d+ icon/.test(line)) return Math.max(currentPct, sp.imgStart);

  // ── Per-image progress: "[N/M] ✓ filename" ────────────────────────────
  const imgM = line.match(/\[(\d+)\/(\d+)\]/);
  if (imgM) {
    const ratio = parseInt(imgM[1]) / Math.max(parseInt(imgM[2]), 1);
    return Math.max(currentPct, sp.imgStart + ratio * (sp.imgEnd - sp.imgStart));
  }

  // ── Images done ────────────────────────────────────────────────────────
  if (/Images done:/.test(line)) return Math.max(currentPct, sp.imgEnd);

  // ── All done ───────────────────────────────────────────────────────────
  if (/✓ Done\./.test(line)) return 100;

  return currentPct;
}

function appendUpdateLog(log, text, isErr) {
  const span = document.createElement('span');
  span.textContent = text + '\n';
  if (isErr) span.style.color = '#e57373';
  log.appendChild(span);
  log.scrollTop = log.scrollHeight;
}

function setUpdateProgress(pct) {
  const bar  = document.getElementById('updateProgressBar');
  const pctEl = document.getElementById('updateOverlayPct');
  const clamped = Math.min(100, Math.max(0, pct));
  bar.style.width = clamped.toFixed(1) + '%';
  pctEl.textContent = Math.round(clamped) + '%';
}

async function runUpdateResources() {
  // Reset progress state
  _updateSection = 'relics';
  _fetchedPages  = 0;
  let currentPct = 0;

  // Open overlay
  const overlay  = document.getElementById('updateOverlay');
  const log      = document.getElementById('updateOverlayLog');
  const statusEl = document.getElementById('updateOverlayStatus');
  const cancelBtn = document.getElementById('updateCancelBtn');
  const closeBtn  = document.getElementById('updateCloseBtn');

  log.textContent = '';
  statusEl.textContent = 'Starting…';
  statusEl.style.color = 'var(--text-muted)';
  setUpdateProgress(0);
  cancelBtn.style.display = '';
  cancelBtn.disabled = false;
  closeBtn.style.display = 'none';
  overlay.style.display = 'flex';

  window.electronAPI.onUpdateProgress(({ type, data }) => {
    appendUpdateLog(log, data, type === 'stderr');
    statusEl.textContent = data.length > 80 ? data.slice(0, 77) + '…' : data;
    const newPct = parseUpdateProgress(data, currentPct);
    if (newPct !== currentPct) {
      currentPct = newPct;
      setUpdateProgress(currentPct);
    }
  });

  const result = await window.electronAPI.runUpdateResources();
  window.electronAPI.removeUpdateListeners();

  // Final state
  cancelBtn.style.display = 'none';
  closeBtn.style.display = '';

  if (result.cancelled) {
    setUpdateProgress(currentPct);
    statusEl.textContent = 'Cancelled.';
    statusEl.style.color = '#e57373';
    appendUpdateLog(log, '\n✗ Update cancelled by user.', true);
  } else if (result.error) {
    statusEl.textContent = result.error;
    statusEl.style.color = '#e57373';
    appendUpdateLog(log, '\n✗ ' + result.error, true);
  } else if (result.success) {
    setUpdateProgress(100);
    statusEl.textContent = 'Done — reloading data…';
    statusEl.style.color = 'var(--green)';
    appendUpdateLog(log, '\n✓ Update complete. Reloading data…', false);
    await loadAssetData();
    markResourceUpdated();
    statusEl.textContent = 'Done.';
  } else {
    statusEl.textContent = 'Failed (exit ' + result.code + ')';
    statusEl.style.color = '#e57373';
  }
}

document.getElementById('updateCancelBtn').addEventListener('click', async () => {
  document.getElementById('updateCancelBtn').disabled = true;
  document.getElementById('updateOverlayStatus').textContent = 'Cancelling…';
  await window.electronAPI.cancelUpdate();
});

document.getElementById('updateCloseBtn').addEventListener('click', () => {
  document.getElementById('updateOverlay').style.display = 'none';
});

document.getElementById('updateResourcesBtn').addEventListener('click', () => {
  runUpdateResources();
});

// ═══════════════════════════════════════════════════════════════════════════
// DECK BUILD STEPPER
// ═══════════════════════════════════════════════════════════════════════════

let _stepperData    = [];   // array of step objects built by buildStepperData()
let _stepperIdx     = 0;    // current step index
let _stepperOpen    = false;

// ── Card matching helper ──────────────────────────────────────────────────────
// During backward reconstruction, find a card in `deck` matching `cardRef`.
// Priority: exact floor match → node floor match → highest-floor copy → first copy.
function findCardForBackward(deck, cardRef, nodeFloor) {
  const id = cardRef?.id || cardRef;
  if (!id) return -1;
  const candidates = [];
  for (let i = 0; i < deck.length; i++) {
    if ((deck[i].id || deck[i]) === id) candidates.push(i);
  }
  if (candidates.length === 0) return -1;
  if (candidates.length === 1) return candidates[0];

  // Exact floor match
  const exact = candidates.filter(i => (deck[i].floor_added_to_deck ?? -1) === (cardRef.floor_added_to_deck ?? -2));
  if (exact.length > 0) return exact[0];

  // Node floor match
  const nodeMatch = candidates.filter(i => (deck[i].floor_added_to_deck ?? -1) === nodeFloor);
  if (nodeMatch.length > 0) return nodeMatch[0];

  // Highest floor fallback
  return candidates.reduce((best, i) =>
    (deck[i].floor_added_to_deck ?? -1) > (deck[best].floor_added_to_deck ?? -1) ? i : best
  , candidates[0]);
}

// ── Stepper data builder ──────────────────────────────────────────────────────
// Returns an array of step objects, one per map node that has any deck/relic
// interaction (or any node, so the player can see every stop).
function buildStepperData(run, playerIdx) {
  const actHistory = run.map_point_history || [];
  const player     = run.players?.[playerIdx] || run.players?.[0] || {};
  const finalDeck  = (player.deck || []).map(c => ({ ...c }));

  // Collect all nodes in order
  const allNodes = [];
  for (let a = 0; a < actHistory.length; a++) {
    for (let n = 0; n < actHistory[a].length; n++) {
      allNodes.push({ actIdx: a, nodeInAct: n, raw: actHistory[a][n] });
    }
  }

  const N = allNodes.length;

  // ── Backward pass: reconstruct deck state BEFORE each node ──────────────
  // We start from the final deck and reverse-apply deltas node by node (backwards).
  // deckBefore[i] = deck state BEFORE node i's changes.
  const deckSnapshots = new Array(N + 1);
  deckSnapshots[N] = finalDeck.map(c => ({ ...c })); // after last node

  for (let i = N - 1; i >= 0; i--) {
    const ps    = allNodes[i].raw.player_stats?.[playerIdx] ?? allNodes[i].raw.player_stats?.[0] ?? {};
    const floor = i + 1;
    const deck  = deckSnapshots[i + 1].map(c => ({ ...c }));

    // Reverse cards_gained: remove them from deck
    const gainedIds = new Set();
    for (const gained of (ps.cards_gained || [])) {
      const idx = findCardForBackward(deck, gained, floor);
      if (idx !== -1) deck.splice(idx, 1);
      if (gained?.id) gainedIds.add(gained.id);
    }

    // Reverse card_choices picked: remove the picked card.
    // Skip cards already removed via cards_gained (shop purchases are tracked twice).
    for (const ch of (ps.card_choices || [])) {
      if (ch.was_picked && !gainedIds.has(ch.card?.id)) {
        const idx = findCardForBackward(deck, ch.card, floor);
        if (idx !== -1) deck.splice(idx, 1);
      }
    }

    // Reverse cards_transformed: replace final_card back with original_card
    for (const tx of (ps.cards_transformed || [])) {
      const idx = findCardForBackward(deck, tx.final_card, floor);
      if (idx !== -1) {
        deck[idx] = { ...tx.original_card };
      } else {
        deck.push({ ...tx.original_card });
      }
    }

    // Reverse cards_enchanted: restore to un-enchanted version
    for (const enc of (ps.cards_enchanted || [])) {
      const idx = findCardForBackward(deck, enc.card, floor);
      if (idx !== -1) {
        const copy = { ...deck[idx] };
        delete copy.enchantment;
        deck[idx] = copy;
      }
    }

    // Reverse upgraded_cards (smith): downgrade by 1
    for (const cardId of (ps.upgraded_cards || [])) {
      const idx = findCardForBackward(deck, { id: cardId, floor_added_to_deck: undefined }, floor);
      if (idx !== -1) {
        const copy = { ...deck[idx] };
        copy.current_upgrade_level = Math.max(0, (copy.current_upgrade_level || 1) - 1);
        deck[idx] = copy;
      }
    }

    // Reverse cards_removed: put them back
    for (const removed of (ps.cards_removed || [])) {
      deck.push({ ...removed });
    }

    // Reverse bought_colorless: remove those cards
    for (const cardId of (ps.bought_colorless || [])) {
      const idx = findCardForBackward(deck, { id: cardId }, floor);
      if (idx !== -1) deck.splice(idx, 1);
    }

    deckSnapshots[i] = deck;
  }

  // ── Forward pass: track potions ───────────────────────────────────────────
  // potionsBefore[i] = potions available before node i (snapshot at card-reward time for fights)
  const potionSnapshots = new Array(N + 1);
  potionSnapshots[0] = [];
  for (let i = 0; i < N; i++) {
    const ps = allNodes[i].raw.player_stats?.[playerIdx] ?? allNodes[i].raw.player_stats?.[0] ?? {};
    let potions = [...(potionSnapshots[i] || [])];

    // Apply: gained via choices (covers both fight rewards and shop purchases —
    // shop purchases appear in potion_choices with was_picked=true, so don't
    // read bought_potions to avoid double-counting).
    for (const pc of (ps.potion_choices || [])) {
      if (pc.was_picked) potions.push(pc.choice);
    }
    // Remove: used + discarded
    for (const pu of (ps.potion_used || [])) {
      const idx = potions.indexOf(pu);
      if (idx !== -1) potions.splice(idx, 1);
    }
    for (const pd of (ps.potion_discarded || [])) {
      const idx = potions.indexOf(pd);
      if (idx !== -1) potions.splice(idx, 1);
    }
    potionSnapshots[i + 1] = potions;
  }

  // ── Build step objects ────────────────────────────────────────────────────
  const steps = [];
  for (let i = 0; i < N; i++) {
    const { actIdx, raw } = allNodes[i];
    const ps    = raw.player_stats?.[playerIdx] ?? raw.player_stats?.[0] ?? {};
    const room  = raw.rooms?.[0] ?? {};
    const floor = i + 1;

    const mapType  = raw.map_point_type || 'event';
    const roomType = room.room_type || mapType;
    let category = mapType;
    if (mapType === 'unknown') {
      if      (roomType === 'monster')  category = 'unknown_fight';
      else if (roomType === 'shop')     category = 'unknown_shop';
      else if (roomType === 'treasure') category = 'unknown_treasure';
      else                              category = 'event';
    }

    const isFight = ['monster', 'elite', 'boss', 'unknown_fight'].includes(category);

    // HP snapshot: for fights, show post-fight HP (the stat at this node = after fight)
    const hpVal     = ps.current_hp   ?? null;
    const maxHpVal  = ps.max_hp      ?? null;
    const currentGold = ps.current_gold ?? null;

    // Potions: for fight nodes, same post-fight timing (after fight, before reward)
    // potionSnapshots[i] = before node; potionSnapshots[i+1] = after node
    // For fights, card rewards come after combat, so use potionSnapshots[i+1]
    // For non-fights, use potionSnapshots[i] (before node actions)
    const potions = isFight ? [...potionSnapshots[i + 1]] : [...potionSnapshots[i]];

    // Relics: all relics with floor_added_to_deck <= floor
    const relicsAtNode = (player.relics || []).filter(r => (r.floor_added_to_deck ?? 1) <= floor);

    // Card choices
    const cardChoices = ps.card_choices || [];
    const anyPicked   = cardChoices.some(c => c.was_picked);

    // Other deck changes at this node
    const changes = [];
    for (const c of (ps.cards_gained || [])) {
      changes.push({ type: 'gained', card: c });
    }
    for (const c of (ps.cards_removed || [])) {
      changes.push({ type: 'removed', card: c });
    }
    for (const c of (ps.cards_transformed || [])) {
      changes.push({ type: 'transformed', original: c.original_card, final: c.final_card });
    }
    for (const c of (ps.cards_enchanted || [])) {
      changes.push({ type: 'enchanted', card: c.card, enchantment: c.enchantment });
    }
    for (const id of (ps.upgraded_cards || [])) {
      changes.push({ type: 'upgraded', cardId: id });
    }
    for (const id of (ps.bought_colorless || [])) {
      changes.push({ type: 'bought', cardId: id });
    }

    steps.push({
      nodeIdx: i,
      floor,
      actIdx,
      category,
      mapType,
      roomType,
      modelId:    room.model_id || null,
      monsterIds: room.monster_ids || [],
      isFight,
      hpVal,
      maxHpVal,
      currentGold,
      potions,
      relicsAtNode,
      deckBefore:  deckSnapshots[i],
      cardChoices,
      anyPicked,
      changes,
      eventChoices:    ps.event_choices    || [],
      restChoices:     ps.rest_site_choices || [],
      relicChoices:    ps.relic_choices    || [],
      potionChoices:   ps.potion_choices   || [],
      boughtColorless: ps.bought_colorless || [],
      ancientChoices:  ps.ancient_choice   || [],
    });
  }

  return steps;
}

// ── Card reward grouping ──────────────────────────────────────────────────────
// Normal card rewards are ALWAYS blocks of 3 cards.
// Any leftover cards at the front (N % 3) are special 1-card rewards that
// appear before the normal reward — e.g., Thieving Hopper returning a stolen
// card, or the Lantern Key event granting the Key.
function groupCardChoices(choices) {
  if (!choices.length) return [];

  const N = choices.length;
  const groups = [];
  const specialCount = N % 3;

  for (let i = 0; i < specialCount; i++) {
    groups.push([choices[i]]);
  }
  for (let i = specialCount; i < N; i += 3) {
    groups.push(choices.slice(i, i + 3));
  }
  return groups;
}

// ── Stepper open/close/navigate ───────────────────────────────────────────────

let _stepperPlayerIdx = 0;   // which player's data the stepper is showing

function openDeckStepper() {
  const run = _currentDetailRun;
  if (!run) return;
  _stepperPlayerIdx = typeof _detailPlayerIdx === 'number' ? _detailPlayerIdx : 0;
  _stepperData  = buildStepperData(run, _stepperPlayerIdx);
  _stepperIdx   = 0;
  _stepperOpen  = true;
  document.getElementById('deckStepperOverlay').style.display = 'flex';
  renderStepperPlayerTabs();
  renderStepperStep(0);
}

function closeDeckStepper() {
  _stepperOpen = false;
  document.getElementById('deckStepperOverlay').style.display = 'none';
}

function navigateStepper(delta) {
  if (!_stepperOpen) return;
  const next = _stepperIdx + delta;
  if (next < 0 || next >= _stepperData.length) return;
  _stepperIdx = next;
  renderStepperStep(_stepperIdx);
}

function setStepperPlayer(newIdx) {
  const run = _currentDetailRun;
  if (!run || !_stepperOpen) return;
  const players = run.players || [];
  if (newIdx < 0 || newIdx >= players.length) return;
  if (newIdx === _stepperPlayerIdx) return;
  _stepperPlayerIdx = newIdx;
  // Rebuild data for new player but preserve current step index
  const keepIdx = _stepperIdx;
  _stepperData = buildStepperData(run, _stepperPlayerIdx);
  _stepperIdx = Math.min(keepIdx, _stepperData.length - 1);
  renderStepperPlayerTabs();
  renderStepperStep(_stepperIdx);
}

function renderStepperPlayerTabs() {
  const wrap = document.getElementById('stepperPlayerTabs');
  if (!wrap) return;
  const run = _currentDetailRun;
  const players = run?.players || [];
  if (players.length < 2) {
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  wrap.style.display = '';
  wrap.innerHTML = players.map((p, i) => {
    const label = escHtml(parseCharacter(p?.character || ''));
    const active = i === _stepperPlayerIdx ? ' active' : '';
    return `<button class="stepper-player-tab${active}" data-player-idx="${i}">${label}</button>`;
  }).join('');
}

// ── Render one stepper step ───────────────────────────────────────────────────

function stepperCardHtml(card, extraClass = '', labelHtml = '') {
  const id       = card?.id || card;
  const upgraded = (card?.current_upgrade_level || 0) >= 1;
  const name     = typeof id === 'string' ? idToDisplayName(id) : String(card);
  const data     = typeof id === 'string' ? lookupCardData(id) : null;
  const enchId   = card?.enchantment?.id;
  const enchData = enchId ? lookupEnchantmentData(enchId) : null;
  const enchName = enchData?.name || (enchId ? idToDisplayName(enchId) : null);

  let inner;
  if (data?.imageFile) {
    const imgFile = upgraded && data.imageFileUpgraded ? data.imageFileUpgraded : data.imageFile;
    inner = `<img src="appdata://images/card_images/${escHtml(imgFile)}" alt="${escHtml(data.name || name)}" loading="lazy" />`;
  } else {
    inner = `<div class="card-img-placeholder">${escHtml(name)}</div>`;
  }

  const enchIcon = enchName && enchData?.imageFile
    ? `<button class="card-enchant-icon" data-enchant-id="${escHtml(enchId)}" title="${escHtml(enchName)}"><img src="appdata://images/enchantment_images/${escHtml(enchData.imageFile)}" alt="${escHtml(enchName)}" /></button>`
    : '';

  return `<div class="stepper-card-wrap ${escHtml(extraClass)}" title="${escHtml(name)}">${inner}${enchIcon}${labelHtml}</div>`;
}

function renderStepperStep(idx) {
  if (!_stepperData.length) return;
  const step = _stepperData[idx];
  const total = _stepperData.length;

  document.getElementById('stepperStepInfo').textContent = `Step ${idx + 1} / ${total}`;

  const prevBtn = document.getElementById('stepperPrevBtn');
  const nextBtn = document.getElementById('stepperNextBtn');
  prevBtn.disabled = idx === 0;
  nextBtn.disabled = idx === total - 1;

  // ── Node label ──────────────────────────────────────────────────────────
  const catLabels = {
    monster: 'Monster Fight', elite: 'Elite Fight', boss: 'Boss Fight',
    event: 'Event', ancient: 'Ancient', shop: 'Shop', rest_site: 'Rest Site',
    treasure: 'Treasure', unknown_fight: 'Unknown Fight', unknown_shop: 'Unknown Shop',
    unknown_treasure: 'Unknown Treasure',
  };
  const catLabel = catLabels[step.category] || step.category;
  const cfg = NODE_CFG[step.category] || NODE_CFG.event;

  let nodeName = catLabel;
  if (step.modelId) {
    const formatted = formatModelDisplay(step.modelId);
    if (formatted && formatted !== '—') nodeName = formatted;
  }

  // Act label
  const actLabel = `Act ${step.actIdx + 1}`;

  // ── HP row ──────────────────────────────────────────────────────────────
  let hpHtml = '';
  let deltaHtml = '';
  if (step.hpVal !== null) {
    const pct = step.maxHpVal ? Math.round((step.hpVal / step.maxHpVal) * 100) : null;
    const hpColor = pct !== null
      ? (pct > 60 ? '#4caf50' : pct > 30 ? '#ff9800' : '#f44336')
      : '#aaa';
    const hpLabel = step.isFight ? 'HP after fight' : 'HP';
    const goldHtml = step.currentGold !== null
      ? `<span class="stepper-gold-val">🪙 ${step.currentGold}g</span>`
      : '';
    hpHtml = `<span class="stepper-hp-val" style="color:${hpColor}">❤ ${step.hpVal}/${step.maxHpVal}</span>
              <span style="color:var(--text-muted);font-size:0.8em;">${escHtml(hpLabel)}</span>
              ${goldHtml}`;

    // Deltas vs previous node — only show if there's at least one change
    if (idx > 0) {
      const prev = _stepperData[idx - 1];
      const deltaHp   = (prev.hpVal        != null && step.hpVal        != null) ? step.hpVal        - prev.hpVal        : 0;
      const deltaMax  = (prev.maxHpVal     != null && step.maxHpVal     != null) ? step.maxHpVal     - prev.maxHpVal     : 0;
      const deltaGold = (prev.currentGold  != null && step.currentGold  != null) ? step.currentGold  - prev.currentGold  : 0;

      const chips = [];
      const fmt = (v) => (v > 0 ? `+${v}` : `${v}`);
      const cls = (v) => v > 0 ? 'stepper-delta-pos' : (v < 0 ? 'stepper-delta-neg' : '');
      if (deltaHp   !== 0) chips.push(`<span class="stepper-delta ${cls(deltaHp)}" title="HP change">❤ ${fmt(deltaHp)}</span>`);
      if (deltaMax  !== 0) chips.push(`<span class="stepper-delta ${cls(deltaMax)}" title="Max HP change">✚ ${fmt(deltaMax)}</span>`);
      if (deltaGold !== 0) chips.push(`<span class="stepper-delta ${cls(deltaGold)}" title="Gold change">🪙 ${fmt(deltaGold)}</span>`);
      if (chips.length > 0) {
        deltaHtml = `<span class="stepper-deltas">${chips.join('')}</span>`;
      }
    }
  }

  // ── Potions row ─────────────────────────────────────────────────────────
  let potionsHtml = '';
  if (step.potions.length > 0) {
    potionsHtml = step.potions.map(pid => {
      const name = idToDisplayName(pid);
      const data = lookupPotionData(pid);
      const inner = data?.imageFile
        ? `<img src="appdata://images/potion_images/${escHtml(data.imageFile)}" alt="${escHtml(data.name || name)}" />`
        : escHtml(name);
      return `<span class="stepper-potion-chip" data-potion-id="${escHtml(pid)}" title="${escHtml(name)}" style="cursor:pointer;">${inner}</span>`;
    }).join('');
  }

  // ── Shop section (replaces Card Reward for shop nodes) ──────────────────
  const isShop = ['shop', 'unknown_shop'].includes(step.category);
  let shopHtml = '';
  if (isShop) {
    // Build the shop's full card inventory by merging:
    //   1. card_choices (remaining unsold cards — kept in their original position)
    //   2. cards_gained at this node (colored cards bought — removed from card_choices)
    //   3. bought_colorless (colorless cards bought — not in card_choices)
    //
    // For the buggy shop cases where bought cards are missing from card_choices:
    // - Bought colored cards (from cards_gained) go at the FRONT
    // - Bought colorless cards (from bought_colorless) go at the BACK
    // - card_choices entries stay in the middle in their original order
    const cardChoiceIds = new Set(step.cardChoices.map(ch => ch.card?.id).filter(Boolean));
    const colorlessSet = new Set(step.boughtColorless || []);

    const frontBought = []; // colored bought (missing from card_choices) — prepended
    const middle = [];      // card_choices, in original order
    const backBought = [];  // colorless bought — appended
    const seenIds = new Set();

    // 1. Middle: existing card_choices (preserve order)
    for (const ch of step.cardChoices) {
      const id = ch.card?.id;
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      middle.push({ card: ch.card, bought: !!ch.was_picked });
    }

    // 2. Front: colored bought cards missing from card_choices
    for (const change of step.changes) {
      if (change.type !== 'gained') continue;
      const id = change.card?.id;
      if (!id || seenIds.has(id)) continue;
      if (cardChoiceIds.has(id)) continue;  // already in middle
      if (colorlessSet.has(id)) continue;   // colorless → goes to back
      seenIds.add(id);
      frontBought.push({ card: change.card, bought: true });
    }

    // 3. Back: colorless bought cards
    for (const id of step.boughtColorless) {
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      backBought.push({ card: { id }, bought: true });
    }

    const shopCards = [...frontBought, ...middle, ...backBought];

    const shopCardItems = shopCards.map(item => {
      const cls = item.bought ? 'chosen' : '';
      return `<div class="stepper-choice-wrap">
        ${stepperCardHtml(item.card, `stepper-choice-card ${cls}`)}
        ${item.bought ? '<div class="stepper-choice-lbl chosen-lbl">Bought</div>' : ''}
      </div>`;
    }).join('');

    const cardsRow = shopCardItems
      ? `<div class="stepper-shop-row">
          <div class="stepper-shop-sub">Cards for Sale</div>
          <div class="stepper-choices">${shopCardItems}</div>
        </div>`
      : '';

    // Relics for sale
    const relicItems = step.relicChoices.map(rc => {
      const id   = rc.choice;
      const name = idToDisplayName(id);
      const data = lookupRelicData(id);
      const bought = rc.was_picked;
      const imgHtml = data?.imageFile
        ? `<img src="appdata://images/relic_images/${escHtml(data.imageFile)}" alt="${escHtml(name)}" />`
        : `<div class="relic-icon-placeholder" style="width:36px;height:36px;font-size:0.6em;">${escHtml(name.slice(0, 2).toUpperCase())}</div>`;
      return `<div class="stepper-shop-relic${bought ? ' bought' : ''}" data-relic-id="${escHtml(id)}" title="${escHtml(name)}">
        ${imgHtml}
        ${bought ? '<div class="stepper-shop-badge">✓</div>' : ''}
      </div>`;
    }).join('');

    const relicsRow = step.relicChoices.length > 0
      ? `<div class="stepper-shop-row">
          <div class="stepper-shop-sub">Relics for Sale</div>
          <div class="stepper-shop-grid">${relicItems}</div>
        </div>`
      : '';

    // Potions for sale
    const potionItems = step.potionChoices.map(pc => {
      const id   = pc.choice;
      const name = idToDisplayName(id);
      const data = lookupPotionData(id);
      const bought = pc.was_picked;
      const inner = data?.imageFile
        ? `<img src="appdata://images/potion_images/${escHtml(data.imageFile)}" alt="${escHtml(name)}" />`
        : escHtml(name);
      return `<div class="stepper-shop-potion${bought ? ' bought' : ''}" data-potion-id="${escHtml(id)}" title="${escHtml(name)}">
        ${inner}
        ${bought ? '<div class="stepper-shop-badge">✓</div>' : ''}
      </div>`;
    }).join('');

    const potionsRow = step.potionChoices.length > 0
      ? `<div class="stepper-shop-row">
          <div class="stepper-shop-sub">Potions for Sale</div>
          <div class="stepper-shop-grid">${potionItems}</div>
        </div>`
      : '';

    if (cardsRow || relicsRow || potionsRow) {
      shopHtml = `<div class="stepper-section">
        <div class="stepper-sec-title">Shop Inventory</div>
        ${cardsRow}${relicsRow}${potionsRow}
      </div>`;
    }
  }

  // ── Card reward section (non-shop only) ──────────────────────────────────
  const cardChoicesIds = new Set(step.cardChoices.map(ch => ch.card?.id).filter(Boolean));
  const removedIds = new Set(
    step.changes.filter(c => c.type === 'removed').map(c => c.card?.id).filter(Boolean)
  );

  // Thieving Hopper: stolen card is in cards_removed + cards_gained but not
  // in card_choices. Each becomes its own 1-card "Picked" reward batch.
  const stolenReturned = [];
  for (const c of step.changes) {
    if (c.type !== 'gained') continue;
    const id = c.card?.id;
    if (!id || !removedIds.has(id) || cardChoicesIds.has(id)) continue;
    stolenReturned.push({ card: c.card, was_picked: true });
  }

  // Event bonus cards: card given by an event (e.g., Lantern Key, Brain Leech)
  // appears in cards_gained only, not in card_choices (because the event's
  // single-card "reward" isn't stored as a choice). Each becomes its own
  // 1-card reward batch at the top.
  // Skip if card_choices is empty AND there are many gained cards (Reflections
  // event restores the full starting deck — these aren't rewards).
  const bonusRewards = [];
  const gainedCount = step.changes.filter(c => c.type === 'gained').length;
  const allowBonus = step.cardChoices.length > 0 || gainedCount <= 2;
  if (allowBonus) {
    for (const c of step.changes) {
      if (c.type !== 'gained') continue;
      const id = c.card?.id;
      if (!id) continue;
      if (cardChoicesIds.has(id)) continue;
      if (removedIds.has(id)) continue; // already handled by stolenReturned
      bonusRewards.push({ card: c.card, was_picked: true });
    }
  }

  // Lead Paperweight / Neow: card_choices lists ONLY the unpicked options.
  // The actually-picked card is only in cards_gained. Only apply at Neow
  // (nodes with ancient_choice) where the reward may be a non-standard size.
  const isNeow = step.ancientChoices && step.ancientChoices.length > 0;
  let incompleteNeowBatch = null;
  if (isNeow && step.cardChoices.length > 0 && !step.anyPicked && bonusRewards.length > 0) {
    incompleteNeowBatch = [...bonusRewards, ...step.cardChoices];
  }

  let choicesHtml = '';
  const hasChoicesContent = incompleteNeowBatch
    || stolenReturned.length > 0
    || bonusRewards.length > 0
    || step.cardChoices.length > 0;
  if (!isShop && hasChoicesContent) {
    let groups;
    if (incompleteNeowBatch) {
      // Neow / Lead Paperweight: dedicated single batch combining synthesized
      // picked card(s) with remaining unpicked options. Bypasses standard
      // N%3 grouping (which would wrongly split a 2-card reward).
      groups = [incompleteNeowBatch];
      if (stolenReturned.length > 0) {
        groups = [...stolenReturned.map(c => [c]), ...groups];
      }
    } else {
      // Build groups explicitly: stolen-returned and bonus cards each get
      // their own 1-card batch, then card_choices go through standard
      // N%3 grouping (where card_choices alone should always be multiples of 3).
      groups = [];
      for (const c of stolenReturned) groups.push([c]);
      for (const c of bonusRewards) groups.push([c]);
      if (step.cardChoices.length > 0) {
        groups.push(...groupCardChoices(step.cardChoices));
      }
    }

    const groupRows = groups.map((group, gi) => {
      const batchPicked = group.some(c => c.was_picked);
      const cards = group.map(ch => {
        const cls = ch.was_picked ? 'chosen' : '';
        return `<div class="stepper-choice-wrap">
          ${stepperCardHtml(ch.card, `stepper-choice-card ${cls}`)}
          ${ch.was_picked ? '<div class="stepper-choice-lbl chosen-lbl">Picked</div>' : ''}
        </div>`;
      }).join('');

      const skipClass = !batchPicked ? 'chosen' : '';
      const skipCard = `<div class="stepper-choice-wrap">
        <div class="stepper-skip-card ${skipClass}">SKIP</div>
        ${!batchPicked ? '<div class="stepper-choice-lbl chosen-lbl">Chosen</div>' : ''}
      </div>`;

      const label = groups.length > 1 ? `Card Reward ${gi + 1}` : 'Card Reward';
      return `<div class="stepper-reward-group">
        <div class="stepper-reward-group-label">${escHtml(label)}</div>
        <div class="stepper-choices">${cards}${skipCard}</div>
      </div>`;
    }).join('');

    choicesHtml = `<div class="stepper-section">
      <div class="stepper-sec-title">Card Reward${groups.length > 1 ? 's' : ''}</div>
      ${groupRows}
    </div>`;
  }

  // ── Cards Added (all cards gained, including shop purchases) ────────────
  let gainedHtml = '';
  const gained = step.changes.filter(c => c.type === 'gained');
  if (gained.length > 0) {
    const cards = gained.map(ch =>
      `<div class="stepper-choice-wrap">${stepperCardHtml(ch.card, 'stepper-choice-card')}</div>`
    ).join('');
    gainedHtml = `<div class="stepper-section">
      <div class="stepper-sec-title">Cards Added</div>
      <div class="stepper-choices">${cards}</div>
    </div>`;
  }

  // ── Card removal section ────────────────────────────────────────────────
  // Filter out cards that were removed AND returned at the same node
  // (e.g., Thieving Hopper steals a card then returns it on kill).
  let removalsHtml = '';
  const gainedIdsAtStep = new Set(
    step.changes.filter(c => c.type === 'gained').map(c => c.card?.id).filter(Boolean)
  );
  const removals = step.changes.filter(
    c => c.type === 'removed' && !gainedIdsAtStep.has(c.card?.id)
  );
  if (removals.length > 0) {
    const cards = removals.map(ch =>
      `<div class="stepper-choice-wrap">${stepperCardHtml(ch.card, 'stepper-choice-card removal')}</div>`
    ).join('');
    removalsHtml = `<div class="stepper-section">
      <div class="stepper-sec-title">Card Removal</div>
      <div class="stepper-choices">${cards}</div>
    </div>`;
  }

  // ── Card upgrade section ─────────────────────────────────────────────────
  let upgradesHtml = '';
  const upgrades = step.changes.filter(c => c.type === 'upgraded');
  if (upgrades.length > 0) {
    const cards = upgrades.map(ch =>
      `<div class="stepper-choice-wrap">${stepperCardHtml({ id: ch.cardId, current_upgrade_level: 1 }, 'stepper-choice-card')}</div>`
    ).join('');
    upgradesHtml = `<div class="stepper-section">
      <div class="stepper-sec-title">Upgraded</div>
      <div class="stepper-choices">${cards}</div>
    </div>`;
  }

  // ── Card transform section ───────────────────────────────────────────────
  let transformsHtml = '';
  const transforms = step.changes.filter(c => c.type === 'transformed');
  if (transforms.length > 0) {
    const items = transforms.map(ch =>
      `<div class="stepper-transform-pair">
        ${stepperCardHtml(ch.original, 'stepper-choice-card')}
        <span class="stepper-transform-arrow">⇒</span>
        ${stepperCardHtml(ch.final, 'stepper-choice-card')}
      </div>`
    ).join('');
    transformsHtml = `<div class="stepper-section">
      <div class="stepper-sec-title">Transformed</div>
      <div class="stepper-choices">${items}</div>
    </div>`;
  }

  // ── Card enchant section ────────────────────────────────────────────────
  // ch.card already has `enchantment: {id, amount}` nested. The outer
  // ch.enchantment is just a string id (redundant).
  let enchantsHtml = '';
  const enchants = step.changes.filter(c => c.type === 'enchanted');
  if (enchants.length > 0) {
    const items = enchants.map(ch => {
      const enchId = ch.card?.enchantment?.id;
      const enchName = enchId
        ? (lookupEnchantmentData(enchId)?.name || idToDisplayName(enchId))
        : '';
      return `<div class="stepper-choice-wrap">
        ${stepperCardHtml(ch.card, 'stepper-choice-card')}
        ${enchName ? `<div class="stepper-choice-lbl">${escHtml(enchName)}</div>` : ''}
      </div>`;
    }).join('');
    enchantsHtml = `<div class="stepper-section">
      <div class="stepper-sec-title">Enchanted</div>
      <div class="stepper-choices">${items}</div>
    </div>`;
  }

  // ── Relics row ───────────────────────────────────────────────────────────
  let relicsHtml = '';
  if (step.relicsAtNode.length > 0) {
    // Determine which relics are "new" at this floor
    const newFloors = new Set();
    if (idx > 0) {
      const prevRelics = _stepperData[idx - 1].relicsAtNode;
      const prevIds = new Set(prevRelics.map(r => r.id || r));
      step.relicsAtNode.forEach(r => {
        if (!prevIds.has(r.id || r)) newFloors.add(r.id || r);
      });
    } else {
      // First node: all relics gained at floor 1 are "new"
      step.relicsAtNode.forEach(r => {
        if ((r.floor_added_to_deck ?? 1) === 1) newFloors.add(r.id || r);
      });
    }

    const chips = step.relicsAtNode.map(r => {
      const id   = r.id || r;
      const name = idToDisplayName(id);
      const data = lookupRelicData(id);
      const isNew = newFloors.has(id);
      const imgHtml = data?.imageFile
        ? `<img src="appdata://images/relic_images/${escHtml(data.imageFile)}" alt="${escHtml(name)}" />`
        : `<div class="relic-icon-placeholder" style="width:24px;height:24px;font-size:0.6em;">${escHtml(name.slice(0, 2).toUpperCase())}</div>`;
      return `<span class="stepper-relic-chip${isNew ? ' new-relic' : ''}" data-relic-id="${escHtml(id)}" title="${escHtml(name)}" style="cursor:pointer;">${imgHtml}</span>`;
    }).join('');

    relicsHtml = `<div class="stepper-section">
      <div class="stepper-sec-title">Relics (${step.relicsAtNode.length})</div>
      <div class="stepper-relics-row">${chips}</div>
    </div>`;
  }

  // ── Deck section ──────────────────────────────────────────────────────────
  const deckCards = step.deckBefore.map(card => stepperCardHtml(card)).join('');
  const deckHtml = `<div class="stepper-section">
    <div class="stepper-sec-title">Deck Before This Node (${step.deckBefore.length} cards)</div>
    <div class="stepper-deck-grid">${deckCards || '<span style="color:var(--text-muted)">Empty</span>'}</div>
  </div>`;

  // ── Node header ────────────────────────────────────────────────────────────
  const iconHtml = `<img src="appdata://images/map_icons/${escHtml(cfg.img)}" alt="${escHtml(catLabel)}" style="width:20px;height:20px;vertical-align:middle;margin-right:6px;" />`;

  // Make node name clickable if it has event data in the events json
  const evData = lookupEventByModelId(step.modelId);
  const nameClickable = !!evData;
  const nameAttrs = nameClickable
    ? ` data-stepper-event="${escHtml(evData.name)}" style="cursor:pointer;text-decoration:underline dotted;text-underline-offset:3px;"`
    : '';

  const nodeHeaderHtml = `<div class="stepper-node-info">
    <div class="stepper-node-header">
      <span class="stepper-node-name"${nameAttrs}>${iconHtml}${escHtml(nodeName)}</span>
      <span style="color:var(--text-muted);font-size:0.85em;">${escHtml(actLabel)} · Floor ${step.floor}</span>
    </div>
    <div class="stepper-hp-row">
      ${hpHtml}
      ${potionsHtml ? `<span style="margin-left:8px;">${potionsHtml}</span>` : ''}
      ${deltaHtml}
    </div>
  </div>`;

  document.getElementById('stepperBody').innerHTML =
    nodeHeaderHtml + shopHtml + choicesHtml + gainedHtml + removalsHtml + upgradesHtml + transformsHtml + enchantsHtml + relicsHtml + deckHtml;
}

// ── Stepper event wiring (called from init) ───────────────────────────────────

function initDeckStepper() {
  document.getElementById('deckStepperBtn').addEventListener('click', () => openDeckStepper());
  document.getElementById('stepperCloseBtn').addEventListener('click', () => closeDeckStepper());
  document.getElementById('stepperPrevBtn').addEventListener('click', () => navigateStepper(-1));
  document.getElementById('stepperNextBtn').addEventListener('click', () => navigateStepper(1));
  document.getElementById('stepperPlayerTabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.stepper-player-tab');
    if (!btn) return;
    const idx = parseInt(btn.dataset.playerIdx, 10);
    if (!isNaN(idx)) setStepperPlayer(idx);
  });

  // Close on overlay background click
  document.getElementById('deckStepperOverlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('deckStepperOverlay')) closeDeckStepper();
  });

  // Click delegation: enchant icon → enchantment popup, node name → event popup,
  // relic chips → relic popup, potion chips → potion popup
  document.getElementById('stepperBody').addEventListener('click', (e) => {
    const enchBtn = e.target.closest('.card-enchant-icon');
    if (enchBtn) {
      e.stopPropagation();
      const enchId = enchBtn.dataset.enchantId;
      const data = enchId ? lookupEnchantmentData(enchId) : null;
      if (data) openEnchantmentPopup(data);
      return;
    }
    const eventEl = e.target.closest('[data-stepper-event]');
    if (eventEl) { openEventPopup(eventEl.dataset.stepperEvent); return; }
    const relicChip = e.target.closest('[data-relic-id]');
    if (relicChip) { openRelicPopup(relicChip.dataset.relicId); return; }
    const potionChip = e.target.closest('[data-potion-id]');
    if (potionChip) { openPotionPopup(potionChip.dataset.potionId); return; }
  });
}

init().catch(console.error);
