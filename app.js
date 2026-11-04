import { aggregate, score, parseRug, metrics, analyzeCandles, isLaunchpadMint, PARTS } from './scoring.js';

// ───────────────────────── config ─────────────────────────
const DS = 'https://api.dexscreener.com';
const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
const RC = 'https://api.rugcheck.xyz/v1/tokens';
const STORE_KEY = 'solmon.v2'; // v2 = bottom-bounce mode (v1 data is ignored)
const MAX_TRACKED = 500;
const HISTORY_MAX = 90;
const HIST_TTL = 30 * 60e3; // re-pull candles every 30 min (live price comes from DexScreener)
const RUG_TTL = 30 * 60e3;

const DEFAULTS = {
  minAge: 12,           // hours since graduation
  minLiq: 20000,
  maxMcap: 10_000_000,
  minScore: 0,
  alertAt: 60,
  refreshSec: 30,
  safeOnly: true,       // RugCheck clean + passes sanity gates
  nearBottom: true,     // ≥60% below ATH and ≤60% above the floor
  compact: true,
};

// ───────────────────────── state ─────────────────────────
const state = {
  settings: { ...DEFAULTS },
  tokens: new Map(), // mint -> {mint, sources[], firstSeen, data, history[], hist, safety, misses, lastAlert}
  signals: [],
  sources: {},
  sort: { key: 'score', dir: -1 },
  selected: null,
  unseen: 0,
  nextAt: 0,
  lastDiscover: 0,
  busy: false,
};

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!s) return;
    for (const k of Object.keys(DEFAULTS)) if (s.settings && k in s.settings) state.settings[k] = s.settings[k];
    for (const t of s.tokens || []) state.tokens.set(t.mint, t);
    state.signals = s.signals || [];
  } catch { /* storage unavailable */ }
}
function save() {
  try {
    const tokens = [...state.tokens.values()].map(({ result, ...t }) => ({ ...t, history: t.history.slice(-HISTORY_MAX) }));
    localStorage.setItem(STORE_KEY, JSON.stringify({ settings: state.settings, tokens, signals: state.signals.slice(0, 50) }));
  } catch { /* quota or disabled */ }
}

// ───────────────────────── network ─────────────────────────
async function getJSON(url, name) {
  const src = (state.sources[name] ||= { ok: null, t: 0, err: '', count: 0 });
  try {
    const r = await fetch(url, { headers: { accept: 'application/json' } });
    if (r.status === 429) throw new Error('rate limited');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    src.ok = true; src.t = Date.now(); src.err = '';
    return j;
  } catch (e) {
    src.ok = false; src.t = Date.now(); src.err = String(e.message || e);
    return null;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GeckoTerminal's public API blocks far below its documented 30/min (measured: 429s even at
// one call per 6 s; a 429 shows up in the browser as a CORS error), so every GT call goes
// through one queue: 12 s apart, 30 s after a block.
let gtChain = Promise.resolve(), gtNext = 0;
function gtGet(url, name) {
  const p = gtChain.then(async () => {
    const wait = gtNext - Date.now();
    if (wait > 0) await sleep(wait);
    const j = await getJSON(url, name);
    gtNext = Date.now() + (j ? 12000 : 30000);
    return j;
  });
  gtChain = p.catch(() => {});
  return p;
}

function track(mint, source) {
  if (!isLaunchpadMint(mint)) return; // only pump.fun / letsbonk coins
  let t = state.tokens.get(mint);
  if (!t) {
    t = { mint, sources: [], firstSeen: Date.now(), data: null, history: [], hist: null, safety: null, misses: 0 };
    state.tokens.set(mint, t);
  }
  if (!t.sources.includes(source)) t.sources.push(source);
}

// ───────────────────────── discovery ─────────────────────────
const DS_JOBS = [
  ['DS profiles', `${DS}/token-profiles/latest/v1`, 'profile'],
  ['DS boosts', `${DS}/token-boosts/latest/v1`, 'boost'],
  ['DS top boosts', `${DS}/token-boosts/top/v1`, 'boost'],
  ['DS takeovers', `${DS}/community-takeovers/latest/v1`, 'cto'],
];
const PS = `${GT}/dexes/pumpswap/pools`;
// One per discovery round (~1/min), rotating; the busiest lists come up most often.
// The rest of the GT budget goes to candle history.
const GT_JOBS = [
  ['PumpSwap active', `${PS}?page=1&sort=h24_tx_count_desc`, 'pumpswap'],
  ['PumpSwap volume', `${PS}?page=1&sort=h24_volume_usd_desc`, 'pumpswap'],
  ['PumpSwap active p2', `${PS}?page=2&sort=h24_tx_count_desc`, 'pumpswap'],
  ['GT trending 6h', `${GT}/trending_pools?page=1&duration=6h`, 'trending'],
  ['PumpSwap active', `${PS}?page=1&sort=h24_tx_count_desc`, 'pumpswap'],
  ['PumpSwap volume p2', `${PS}?page=2&sort=h24_volume_usd_desc`, 'pumpswap'],
  ['PumpSwap active p3', `${PS}?page=3&sort=h24_tx_count_desc`, 'pumpswap'],
  ['GT trending', `${GT}/trending_pools?page=1`, 'trending'],
  ['PumpSwap active', `${PS}?page=1&sort=h24_tx_count_desc`, 'pumpswap'],
  ['Raydium active', `${GT}/dexes/raydium/pools?page=1&sort=h24_tx_count_desc`, 'raydium'],
  ['PumpSwap active p4', `${PS}?page=4&sort=h24_tx_count_desc`, 'pumpswap'],
  ['GT trending 1h', `${GT}/trending_pools?page=1&duration=1h`, 'trending'],
];
let gtRound = 0;

async function discover() {
  const ds = DS_JOBS.map(async ([name, url, tag]) => {
    const j = await getJSON(url, name);
    if (!Array.isArray(j)) return;
    const sol = j.filter((x) => x.chainId === 'solana');
    sol.forEach((x) => track(x.tokenAddress, tag));
    state.sources[name].count = sol.length;
  });
  const gt = [GT_JOBS[gtRound++ % GT_JOBS.length]].map(async ([name, url, tag]) => {
    const j = await gtGet(url, name);
    if (!j) return;
    for (const p of j.data || []) {
      for (const side of ['base_token', 'quote_token']) {
        const id = p.relationships?.[side]?.data?.id || '';
        if (id.startsWith('solana_')) track(id.slice(7), tag);
      }
    }
    state.sources[name].count = (j.data || []).length;
  });
  // GT results land in the background (the queue is slow); they get enriched next cycle
  Promise.all(gt).then(() => render());
  await Promise.all(ds);
  state.lastDiscover = Date.now();
}

// ───────────────────────── enrichment ─────────────────────────
async function enrich() {
  const mints = [...state.tokens.keys()];
  const now = Date.now();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    const j = await getJSON(`${DS}/tokens/v1/solana/${chunk.join(',')}`, 'DS pairs');
    if (!Array.isArray(j)) { await sleep(400); continue; }
    for (const mint of chunk) {
      const t = state.tokens.get(mint);
      if (!t) continue;
      const agg = aggregate(mint, j);
      if (!agg) { t.misses++; continue; }
      if (!agg.graduated) { state.tokens.delete(mint); continue; } // still on the bonding curve
      t.misses = 0;
      if (t.data && t.data.pairAddress !== agg.pairAddress) t.hist = null; // main pool changed
      t.data = agg;
      const m = metrics(agg, now);
      t.history.push({ t: now, price: agg.priceUsd, liq: agg.liq, mcap: agg.mcap, br1: m.br1 });
      if (t.history.length > HISTORY_MAX) t.history.splice(0, t.history.length - HISTORY_MAX);
    }
    await sleep(250); // stay well under 300 req/min
  }
}

/** Worth spending GT / RugCheck calls on? Graduated, alive, old enough, not obviously dead. */
function prequalified(t) {
  const d = t.data, s = state.settings;
  if (!d || !t.result) return false;
  if (t.result.m.ageH < Math.min(s.minAge, 6)) return false;
  if (d.liq < Math.min(s.minLiq, 10000) || d.mcap < 30000) return false;
  if (s.maxMcap && d.mcap > s.maxMcap) return false;
  if (d.vol.h24 < 10000) return false;
  return true;
}

// Candle history (ATH, floor) from GeckoTerminal, a few tokens per cycle
let histBusy = false;
async function histQueue() {
  if (histBusy) return;
  histBusy = true;
  try {
    const now = Date.now();
    const want = [...state.tokens.values()]
      .filter((t) => prequalified(t) && (!t.hist || now - t.hist.t > HIST_TTL) && (!t.histFail || now - t.histFail > 10 * 60e3))
      .sort((a, b) => (a.hist ? 1 : 0) - (b.hist ? 1 : 0) || (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 3);
    for (const t of want) {
      const j = await gtGet(`${GT}/pools/${t.data.pairAddress}/ohlcv/hour?aggregate=1&limit=1000&currency=usd`, 'GT candles');
      if (!j) continue; // blocked: retry next cycle
      const h = analyzeCandles(j.data?.attributes?.ohlcv_list);
      if (h) { t.hist = h; t.histFail = 0; } else t.histFail = Date.now(); // too few candles yet
      rescore(t);
      render();
    }
  } finally { histBusy = false; }
}

// RugCheck: one at a time, for coins that pass everything else
let rugBusy = false;
async function rugQueue() {
  if (rugBusy) return;
  rugBusy = true;
  try {
    const now = Date.now();
    const want = [...state.tokens.values()]
      .filter((t) => prequalified(t) && t.hist && (!t.safety || now - t.safety.t > RUG_TTL))
      .filter((t) => !t.result.gates.hard.length)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 10);
    for (const t of want) {
      const j = await getJSON(`${RC}/${t.mint}/report/summary`, 'RugCheck');
      t.safety = j ? parseRug(j) : { error: state.sources.RugCheck?.err || 'failed', t: Date.now(), risks: [] };
      rescore(t);
      render();
      await sleep(1500);
    }
  } finally { rugBusy = false; }
}

// ───────────────────────── scoring + alerts ─────────────────────────
function rescore(t) {
  if (!t.data) return;
  const r = score(t.data, t.history, t.safety, t.hist);
  t.result = r;
  t.score = r.score;
}

function checkAlerts() {
  const now = Date.now();
  for (const t of state.tokens.values()) {
    if (!t.result || !visible(t)) continue;
    if (t.score >= state.settings.alertAt && (!t.lastAlert || now - t.lastAlert > 30 * 60e3)) {
      t.lastAlert = now;
      t.flashUntil = now + 15e3;
      state.signals.unshift({ t: now, mint: t.mint, symbol: t.data.symbol, score: t.score, mcap: t.data.mcap, price: t.data.priceUsd });
      state.unseen++;
    }
  }
  state.signals = state.signals.slice(0, 50);
}

function prune() {
  for (const [mint, t] of state.tokens) if (t.misses >= 3) state.tokens.delete(mint);
  if (state.tokens.size > MAX_TRACKED) {
    const keep = (t) => (prequalified(t) ? 1 : 0);
    const victims = [...state.tokens.values()]
      .sort((a, b) => keep(a) - keep(b) || (a.score ?? -1) - (b.score ?? -1) || a.firstSeen - b.firstSeen)
      .slice(0, state.tokens.size - MAX_TRACKED);
    victims.forEach((v) => state.tokens.delete(v.mint));
  }
}

async function cycle() {
  if (state.busy) return;
  state.busy = true;
  setStatus('Refreshing…');
  try {
    if (Date.now() - state.lastDiscover > 55e3) await discover();
    await enrich();
    for (const t of state.tokens.values()) rescore(t);
    prune();
    checkAlerts();
    save();
  } finally {
    state.busy = false;
    state.nextAt = Date.now() + state.settings.refreshSec * 1000;
    setStatus('');
    render();
    histQueue(); rugQueue();
  }
}

// ───────────────────────── filters ─────────────────────────
function visible(t) {
  const s = state.settings, d = t.data, r = t.result;
  if (!d || !r) return false;
  if (r.m.ageH < s.minAge) return false;
  if (d.liq < s.minLiq) return false;
  if (s.maxMcap && d.mcap > s.maxMcap) return false;
  if (t.score < s.minScore) return false;
  if (s.safeOnly && (r.gates.hard.length || r.gates.unchecked)) return false;
  if (s.nearBottom && (!r.pos || r.pos.dd < 0.6 || r.pos.fromLow > 0.6)) return false;
  return true;
}

// ───────────────────────── formatting ─────────────────────────
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function usd(v) {
  if (!v) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'K';
  return '$' + v.toFixed(0);
}
function price(v) {
  if (!v) return '—';
  if (v >= 1) return '$' + v.toFixed(3);
  const s = v.toExponential(2).split('e-');
  const zeros = Number(s[1]) - 1;
  if (zeros >= 4) return `$0.0<sub>${zeros}</sub>${(v * 10 ** (zeros + 1) * 1000).toFixed(0)}`;
  return '$' + v.toPrecision(3);
}
const pct = (v) => `<span class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${v > 0 ? '+' : ''}${(v ?? 0).toFixed(Math.abs(v) >= 100 ? 0 : 1)}%</span>`;
function age(h) {
  if (h >= 999) return '—';
  if (h < 1) return Math.max(1, Math.round(h * 60)) + 'm';
  if (h < 48) return h.toFixed(h < 10 ? 1 : 0) + 'h';
  return Math.round(h / 24) + 'd';
}
const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h'; };
const scoreClass = (s) => (s >= 70 ? 's-hot' : s >= 50 ? 's-warm' : s >= 30 ? 's-mid' : 's-cold');

function spark(hist, key = 'mcap') {
  const pts = hist.slice(-40).map((h) => h[key]).filter((v) => v != null && v > 0);
  if (pts.length < 2) return '<span class="dim">…</span>';
  const min = Math.min(...pts), max = Math.max(...pts);
  const w = 70, h = 20;
  const d = pts.map((v, i) => `${(i / (pts.length - 1)) * w},${max === min ? h / 2 : h - ((v - min) / (max - min)) * (h - 2) - 1}`).join(' ');
  const up = pts[pts.length - 1] >= pts[0];
  return `<svg class="spark" width="${w}" height="${h}"><polyline points="${d}" class="${up ? 'up' : 'down'}"/></svg>`;
}

const TAG_TITLE = {
  BOTTOMED: '70%+ below ATH and within 35% of the floor',
  BASE: 'Spent many hours near the floor and the range is tightening',
  WAKING: 'Volume picking up vs the previous day, buyers in control',
  BREAKOUT: 'Price just broke above its 12h high with buyers in control',
  FALLING: 'Still making new lows — no floor yet',
  BOUNCED: 'Already 2×+ off the low; the easy part may be gone',
  SAFE: 'RugCheck: no danger flags, passes sanity checks',
  UNCHECKED: 'RugCheck has not reported yet',
  RISKY: 'Fails a safety/sanity check (open for reasons)',
  'NO HISTORY': 'Candle history not loaded yet',
};
const tagHTML = (tags) => tags.map((g) => `<span class="tag t-${g.toLowerCase().replace(' ', '-')}" title="${TAG_TITLE[g] || ''}">${g}</span>`).join('');

function safeCell(t) {
  const g = t.result.gates;
  if (!t.safety) return '<span class="dim" title="Waiting for RugCheck">…</span>';
  if (t.safety.error) return `<span class="dim" title="${esc(t.safety.error)}">n/a</span>`;
  if (g.hard.length) return `<span class="down" title="${esc(g.hard.join('\n'))}">⚠ ${g.hard.length}</span>`;
  const warn = t.safety.risks.length;
  return `<span class="${warn ? 'warn' : 'up'}" title="${esc(t.safety.risks.map((x) => x.name).join(', ') || 'No risks reported')}">✓${warn ? ' ' + warn : ''}</span>`;
}

// ───────────────────────── render ─────────────────────────
// [key, label, shown in compact view, right-aligned]
const COLS = [
  ['rank', '#', 1, 0], ['symbol', 'Token', 1, 0], ['score', 'Score', 1, 0], ['tags', 'Signals', 1, 0],
  ['mcap', 'MCap · Price', 1, 1], ['ath', 'From ATH · Low', 1, 1], ['spark', 'Trend', 1, 0],
  ['m5', '5m', 0, 1], ['h1', '1h', 1, 1], ['h6', '6h', 0, 1], ['h24', '24h', 0, 1], ['liq', 'Liq', 1, 1],
  ['vol1', 'Vol 1h', 0, 1], ['bs', 'Buys/Sells 1h', 1, 0], ['age', 'Since grad', 1, 1], ['safe', 'Safety', 1, 1],
];
const SORTERS = {
  score: (t) => t.score, symbol: (t) => t.data.symbol.toLowerCase(), mcap: (t) => t.data.mcap,
  ath: (t) => t.result.pos?.dd ?? -1, m5: (t) => t.data.pc.m5, h1: (t) => t.data.pc.h1, h6: (t) => t.data.pc.h6,
  h24: (t) => t.data.pc.h24, liq: (t) => t.data.liq, vol1: (t) => t.data.vol.h1, bs: (t) => t.result.m.br1,
  age: (t) => t.result.m.ageH, safe: (t) => t.result.gates.hard.length * 10 + (t.safety ? t.safety.risks.length : 5),
};
const VISIBLE_TAGS = new Set(['BOTTOMED', 'BASE', 'WAKING', 'BREAKOUT', 'FALLING', 'BOUNCED']);

function render() {
  const rows = [...state.tokens.values()].filter(visible);
  const key = state.sort.key, dir = state.sort.dir, f = SORTERS[key] || SORTERS.score;
  rows.sort((a, b) => { const x = f(a), y = f(b); return (x > y ? 1 : x < y ? -1 : 0) * dir || b.score - a.score; });
  const now = Date.now();
  const compact = state.settings.compact;
  const cols = COLS.filter((c) => !compact || c[2]);
  document.body.classList.toggle('compact', compact);

  $('#thead').innerHTML = '<tr>' + cols.map(([k, l, , num]) =>
    `<th data-k="${k}" class="${SORTERS[k] ? 'sortable' : ''} ${num ? 'r' : ''} ${key === k ? (dir < 0 ? 'desc' : 'asc') : ''}">${l}</th>`).join('') + '</tr>';

  $('#tbody').innerHTML = rows.slice(0, 150).map((t, i) => {
    const d = t.data, r = t.result, m = r.m, p = r.pos;
    const b = d.txns.h1.buys, s = d.txns.h1.sells, bw = b + s ? (b / (b + s)) * 100 : 50;
    const cell = {
      rank: `<td class="dim">${i + 1}</td>`,
      symbol: `<td class="tok">${d.icon ? `<img src="${esc(d.icon)}" loading="lazy" onerror="this.remove()">` : '<span class="ph"></span>'}<div><b>${esc(d.symbol)}</b><small>${esc(d.name.slice(0, compact ? 16 : 22))}</small></div></td>`,
      score: `<td><div class="score ${scoreClass(t.score)}"><span>${r.pos ? t.score : '…'}</span><i style="width:${t.score}%"></i></div></td>`,
      tags: `<td><div class="tags nowrap">${tagHTML(compact ? r.tags.filter((g) => VISIBLE_TAGS.has(g)) : r.tags)}</div></td>`,
      mcap: `<td class="num pm"><b>${usd(d.mcap)}</b><small>${price(d.priceUsd)}</small></td>`,
      ath: p
        ? `<td class="num pm" title="ATH MCap ${usd(p.athMcap)} · floor MCap ${usd(p.floorMcap)}"><b class="down">−${(p.dd * 100).toFixed(0)}%</b><small>${p.newLow ? '<span class="down">new low</span>' : '+' + (p.fromLow * 100).toFixed(0) + '% off low'}</small></td>`
        : '<td class="num dim">…</td>',
      spark: `<td>${spark(t.history)}</td>`,
      m5: `<td class="num">${pct(d.pc.m5)}</td>`, h1: `<td class="num">${pct(d.pc.h1)}</td>`,
      h6: `<td class="num">${pct(d.pc.h6)}</td>`, h24: `<td class="num">${pct(d.pc.h24)}</td>`,
      liq: `<td class="num">${usd(d.liq)}</td>`, vol1: `<td class="num">${usd(d.vol.h1)}</td>`,
      bs: `<td><div class="bs" title="${b} buys / ${s} sells"><i style="width:${bw}%"></i><span>${b}/${s}</span></div></td>`,
      age: `<td class="num">${age(m.ageH)}</td>`,
      safe: `<td class="num">${safeCell(t)}</td>`,
    };
    return `<tr data-mint="${t.mint}" class="${t.flashUntil > now ? 'flash' : ''} ${state.selected === t.mint ? 'sel' : ''}">${cols.map(([k]) => cell[k]).join('')}</tr>`;
  }).join('') || `<tr><td colspan="${cols.length}" class="empty">${emptyMsg()}</td></tr>`;

  // signals strip: MCap when it fired → MCap now
  $('#signals').innerHTML = state.signals.length
    ? state.signals.slice(0, 12).map((g) => {
        const nowMcap = state.tokens.get(g.mint)?.data?.mcap;
        const move = g.mcap && nowMcap ? ((nowMcap - g.mcap) / g.mcap) * 100 : null;
        const mc = g.mcap ? ` <span class="dim">${usd(g.mcap)}</span>${move != null && Math.abs(move) >= 0.5 ? `→${usd(nowMcap)} ${pct(move)}` : ''}` : '';
        return `<button class="sig" data-mint="${g.mint}"><b>${esc(g.symbol)}</b> <span class="${scoreClass(g.score)}">${g.score}</span>${mc} <small>${ago(g.t)}</small></button>`;
      }).join('')
    : `<span class="dim">Coins crossing score ${state.settings.alertAt} will appear here.</span>`;
  $('#sigcount').textContent = state.unseen ? state.unseen : '';
  $('#sigcount').hidden = !state.unseen;
  document.title = (state.unseen ? `(${state.unseen}) ` : '') + 'SolMon — graduated bottom monitor';

  // stats
  const all = [...state.tokens.values()].filter((t) => t.result);
  const pre = all.filter(prequalified);
  const withHist = pre.filter((t) => t.hist).length;
  const safe = pre.filter((t) => t.safety && !t.result.gates.hard.length && !t.result.gates.unchecked).length;
  $('#stats').innerHTML = `<span title="Graduated pump.fun/letsbonk coins with DEX data">Graduated <b>${all.length}</b></span>`
    + `<span title="Old enough, liquid, trading">Qualified <b>${pre.length}</b></span>`
    + `<span title="ATH/floor history loaded">History <b>${withHist}</b></span>`
    + `<span title="RugCheck clean">Safe <b class="up">${safe}</b></span>`
    + `<span>Showing <b>${rows.length}</b></span>`;

  $('#sources').innerHTML = Object.entries(state.sources).map(([k, v]) =>
    `<span class="src ${v.ok ? 'ok' : v.ok === false ? 'bad' : ''}" title="${esc(v.err || (v.t ? 'ok ' + ago(v.t) + ' ago' : ''))}">${k}</span>`).join('');

  if (state.selected) renderDetail();
}

function emptyMsg() {
  if (!state.tokens.size) return 'Collecting graduated coins… first results in a few seconds.';
  const pending = [...state.tokens.values()].filter((t) => prequalified(t) && (!t.hist || !t.safety)).length;
  if (pending) return `Checking history and safety for ${pending} coins… (a few per cycle to respect API limits)`;
  return 'No coins match the current filters right now.';
}

function renderDetail() {
  const t = state.tokens.get(state.selected);
  const el = $('#detail');
  if (!t || !t.result) { el.hidden = true; return; }
  el.hidden = false;
  const d = t.data, r = t.result, m = r.m, p = r.pos, h = t.hist, tr = r.tr;
  el.innerHTML = `
    <button class="close" id="closeDetail" aria-label="Close">×</button>
    <div class="dh">${d.icon ? `<img src="${esc(d.icon)}" onerror="this.remove()">` : ''}<div><h2>${esc(d.symbol)} <small>${esc(d.name)}</small></h2>
      <code class="mint" title="Click to copy" data-copy="${t.mint}">${t.mint.slice(0, 6)}…${t.mint.slice(-6)}</code></div>
      <div class="bigscore ${scoreClass(t.score)}">${t.score}</div></div>
    <div class="dpm">
      <div><small>MCap</small><b>${usd(d.mcap)}</b></div>
      <div><small>Price</small><b>${price(d.priceUsd)}</b></div>
      <div><small>ATH MCap</small><b>${p ? usd(p.athMcap) : '…'}</b></div>
      <div><small>Floor MCap</small><b>${p ? usd(p.floorMcap) : '…'}</b></div>
    </div>
    <div class="tags">${tagHTML(r.tags)}</div>
    ${r.gates.hard.length ? `<h3>Not safe because</h3><ul class="risks">${r.gates.hard.map((x) => `<li class="danger">${esc(x)}</li>`).join('')}</ul>` : ''}
    <h3>Why this score</h3>
    ${Object.entries(PARTS).map(([k, [label, max]]) => `<div class="part"><span>${label}</span><div class="pbar"><i style="width:${(r.parts[k] / max) * 100}%"></i></div><b>${r.parts[k].toFixed(1)}<small>/${max}</small></b></div>`).join('')}
    ${r.penalties.map((x) => `<div class="part pen"><span>${esc(x.label)}</span><div></div><b>−${x.pts}</b></div>`).join('')}
    <h3>Bottom</h3>
    ${h && p ? `<dl>
      <dt>Below ATH</dt><dd>−${(p.dd * 100).toFixed(1)}% · ATH ${age(h.athAgoH)} ago</dd>
      <dt>Above floor</dt><dd>${p.newLow ? '<span class="down">at a new low</span>' : '+' + (p.fromLow * 100).toFixed(1) + '%'} · floor ${age(h.lowAgoH)} ago</dd>
      <dt>Hours near floor (48h)</dt><dd>${h.tests}</dd>
      <dt>Range last 12h vs before</dt><dd>${h.compression != null ? h.compression.toFixed(2) + '×' : '—'}</dd>
      <dt>Volume 6h vs prior day</dt><dd>${h.volWake != null ? h.volWake.toFixed(2) + '×' : '—'}</dd>
      <dt>History covers</dt><dd>${age(h.spanH)} · pulled ${ago(h.t)} ago</dd>
    </dl>` : '<p class="dim">Loading candle history…</p>'}
    <h3>Numbers</h3>
    <dl>
      <dt>Change 5m / 1h / 6h / 24h</dt><dd>${pct(d.pc.m5)} ${pct(d.pc.h1)} ${pct(d.pc.h6)} ${pct(d.pc.h24)}</dd>
      <dt>Buy ratio 5m / 1h / 6h</dt><dd>${(m.br5 * 100).toFixed(0)}% / ${(m.br1 * 100).toFixed(0)}% / ${(m.br6 * 100).toFixed(0)}%</dd>
      <dt>Txns 1h</dt><dd>${d.txns.h1.buys} buys · ${d.txns.h1.sells} sells</dd>
      <dt>Avg trade 1h</dt><dd>${usd(m.avgTx1)}</dd>
      <dt>Liquidity / MCap</dt><dd>${usd(d.liq)} · ${(m.liqRatio * 100).toFixed(1)}%</dd>
      <dt>Vol 1h / 6h / 24h</dt><dd>${usd(d.vol.h1)} / ${usd(d.vol.h6)} / ${usd(d.vol.h24)}</dd>
      <dt>Graduated to</dt><dd>${esc(d.dexId)} · ${age(m.ageH)} ago</dd>
      <dt>Found via</dt><dd>${t.sources.join(', ')}</dd>
      <dt>Live trend</dt><dd>${tr ? `liq ${(tr.liqG * 100).toFixed(1)}%, mcap ${(tr.mcapG * 100).toFixed(1)}% over ${tr.spanMin.toFixed(0)}m` : '<span class="dim">needs ~3 min</span>'}</dd>
    </dl>
    <h3>MCap since tracked</h3><div class="bigspark">${spark(t.history).replace('width="70" height="20"', 'width="100%" height="60" viewBox="0 0 70 20" preserveAspectRatio="none"')}</div>
    <h3>Safety (RugCheck)</h3>
    ${!t.safety ? '<p class="dim">Queued — checked once history is loaded and sanity checks pass.</p>'
      : t.safety.error ? `<p class="dim">Unavailable: ${esc(t.safety.error)}</p>`
      : `<p>Risk score <b>${t.safety.score}</b>${t.safety.lpLockedPct != null ? ` · LP locked/burned <b>${t.safety.lpLockedPct.toFixed(0)}%</b>` : ''}</p>
         <ul class="risks">${t.safety.risks.map((x) => `<li class="${x.level}"><b>${esc(x.name)}</b> ${esc(x.value || '')}<br><small>${esc(x.description || '')}</small></li>`).join('') || '<li class="good">No risks reported</li>'}</ul>`}
    <div class="links">
      <a href="${esc(d.url)}" target="_blank" rel="noopener">DexScreener</a>
      ${t.mint.endsWith('pump') ? `<a href="https://pump.fun/coin/${t.mint}" target="_blank" rel="noopener">pump.fun</a>` : ''}
      <a href="https://gmgn.ai/sol/token/${t.mint}" target="_blank" rel="noopener">GMGN</a>
      <a href="https://rugcheck.xyz/tokens/${t.mint}" target="_blank" rel="noopener">RugCheck</a>
      <a href="https://solscan.io/token/${t.mint}" target="_blank" rel="noopener">Solscan</a>
      <a href="https://jup.ag/swap/SOL-${t.mint}" target="_blank" rel="noopener">Jupiter</a>
      ${d.socials.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.type || 'social')}</a>`).join('')}
      ${d.websites.slice(0, 1).map((w) => `<a href="${esc(w.url)}" target="_blank" rel="noopener">web</a>`).join('')}
    </div>`;
}

function setStatus(msg) { $('#status').textContent = msg; }

// ───────────────────────── controls ─────────────────────────
function bindControls() {
  const s = state.settings;
  const bind = (id, key, parse = (v) => v) => {
    const el = $('#' + id);
    if (el.type === 'checkbox') el.checked = s[key]; else el.value = s[key];
    el.addEventListener('change', () => {
      s[key] = el.type === 'checkbox' ? el.checked : parse(el.value);
      save(); render(); histQueue(); rugQueue();
    });
  };
  bind('minAge', 'minAge', Number);
  bind('minLiq', 'minLiq', Number);
  bind('maxMcap', 'maxMcap', Number);
  bind('minScore', 'minScore', Number);
  bind('alertAt', 'alertAt', Number);
  bind('refreshSec', 'refreshSec', Number);
  bind('safeOnly', 'safeOnly');
  bind('nearBottom', 'nearBottom');
  bind('compact', 'compact');

  $('#thead').addEventListener('click', (e) => {
    const k = e.target.closest('th')?.dataset.k;
    if (!k || !SORTERS[k]) return;
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === 'symbol' || k === 'age' || k === 'safe' ? 1 : -1) };
    render();
  });
  const open = (mint) => { state.selected = mint; render(); };
  $('#tbody').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-mint]'); if (tr) open(tr.dataset.mint); });
  $('#signals').addEventListener('click', (e) => { const b = e.target.closest('[data-mint]'); if (b) open(b.dataset.mint); });
  $('#sigbell').addEventListener('click', () => { state.unseen = 0; render(); });
  $('#detail').addEventListener('click', async (e) => {
    if (e.target.id === 'closeDetail') { state.selected = null; $('#detail').hidden = true; render(); }
    const c = e.target.closest('[data-copy]');
    if (c) { try { await navigator.clipboard.writeText(c.dataset.copy); c.classList.add('copied'); setTimeout(() => c.classList.remove('copied'), 900); } catch {} }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.selected) { state.selected = null; $('#detail').hidden = true; render(); } });
  $('#refresh').addEventListener('click', () => { state.lastDiscover = 0; cycle(); });
  $('#reset').addEventListener('click', () => {
    state.tokens.clear(); state.signals = []; state.unseen = 0; state.selected = null; $('#detail').hidden = true;
    save(); state.lastDiscover = 0; cycle();
  });
  $('#helpBtn').addEventListener('click', () => { $('#help').hidden = !$('#help').hidden; });
}

function tick() {
  const left = Math.max(0, Math.ceil((state.nextAt - Date.now()) / 1000));
  if (!state.busy) $('#countdown').textContent = state.nextAt ? `next ${left}s` : '';
  if (!state.busy && state.nextAt && Date.now() >= state.nextAt) cycle();
  document.querySelectorAll('tr.flash').forEach((tr) => {
    const t = state.tokens.get(tr.dataset.mint);
    if (!t || !(t.flashUntil > Date.now())) tr.classList.remove('flash');
  });
}

// ───────────────────────── boot ─────────────────────────
try { localStorage.removeItem('solmon.v1'); } catch {}
load();
for (const t of state.tokens.values()) rescore(t);
bindControls();
render();
cycle();
setInterval(tick, 1000);
window.__solmon = state; // handy for debugging in the console
