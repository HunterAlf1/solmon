import { aggregate, score, parseRug, metrics } from './scoring.js';

// ───────────────────────── config ─────────────────────────
const DS = 'https://api.dexscreener.com';
const GT = 'https://api.geckoterminal.com/api/v2/networks/solana';
const RC = 'https://api.rugcheck.xyz/v1/tokens';
const STORE_KEY = 'solmon.v1';
const MAX_TRACKED = 500;
const HISTORY_MAX = 90;
const EXCLUDE = new Set([
  'So11111111111111111111111111111111111111112', // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

const DEFAULTS = {
  horizon: 'both',      // fresh (<1h) | young (1–24h) | both (<24h) | all
  minLiq: 15000,
  maxMcap: 50_000_000,
  minScore: 0,
  alertAt: 60,
  refreshSec: 30,
  rugcheck: true,
  hideRisky: false,
  sensible: true,       // hide junk (dust mcap, dead, bot spam, dumped, mint/freeze on)
  compact: true,        // fewer columns, MCap + price in one cell
};

// ───────────────────────── state ─────────────────────────
const state = {
  settings: { ...DEFAULTS },
  tokens: new Map(), // mint -> {mint, sources[], firstSeen, data, history[], safety, misses, aboveSince, lastAlert}
  signals: [],       // {t, mint, symbol, score, tags}
  sources: {},       // name -> {ok, t, err, count}
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
    Object.assign(state.settings, s.settings || {});
    for (const t of s.tokens || []) state.tokens.set(t.mint, t);
    state.signals = s.signals || [];
  } catch { /* storage unavailable */ }
}
function save() {
  try {
    const tokens = [...state.tokens.values()].map((t) => ({ ...t, history: t.history.slice(-HISTORY_MAX) }));
    localStorage.setItem(STORE_KEY, JSON.stringify({ settings: state.settings, tokens, signals: state.signals.slice(0, 50) }));
  } catch { /* quota or disabled */ }
}

// ───────────────────────── network ─────────────────────────
async function getJSON(url, name, opts = {}) {
  const src = (state.sources[name] ||= { ok: null, t: 0, err: '', count: 0 });
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', ...(opts.headers || {}) } });
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

function track(mint, source) {
  if (!mint || EXCLUDE.has(mint)) return;
  let t = state.tokens.get(mint);
  if (!t) {
    t = { mint, sources: [], firstSeen: Date.now(), data: null, history: [], safety: null, misses: 0 };
    state.tokens.set(mint, t);
  }
  if (!t.sources.includes(source)) t.sources.push(source);
}

let gtRound = 0;
async function discover() {
  const sol = (arr) => (Array.isArray(arr) ? arr.filter((x) => x.chainId === 'solana') : []);
  const dsJobs = [
    ['DS profiles', `${DS}/token-profiles/latest/v1`, (j) => sol(j).forEach((x) => track(x.tokenAddress, 'profile'))],
    ['DS boosts', `${DS}/token-boosts/latest/v1`, (j) => sol(j).forEach((x) => track(x.tokenAddress, 'boost'))],
    ['DS top boosts', `${DS}/token-boosts/top/v1`, (j) => sol(j).forEach((x) => track(x.tokenAddress, 'boost'))],
    ['DS takeovers', `${DS}/community-takeovers/latest/v1`, (j) => sol(j).forEach((x) => track(x.tokenAddress, 'cto'))],
  ];
  // GeckoTerminal allows ~30 req/min, so these run one after another
  const gtJobs = [
    // round A
    ['GT trend 5m', `${GT}/trending_pools?page=1&duration=5m`, gt('trending')],
    ['GT new', `${GT}/new_pools?page=1`, gt('new')],
    ['GT top tx', `${GT}/pools?page=1&sort=h24_tx_count_desc`, gt('active')],
    ['GT trending', `${GT}/trending_pools?page=1`, gt('trending')],
    // round B
    ['GT trend 1h', `${GT}/trending_pools?page=1&duration=1h`, gt('trending')],
    ['GT new p2', `${GT}/new_pools?page=2`, gt('new')],
    ['GT top vol', `${GT}/pools?page=1&sort=h24_volume_usd_desc`, gt('active')],
    ['GT trending p2', `${GT}/trending_pools?page=2`, gt('trending')],
  ];
  const run = async ([name, url, fn]) => {
    const j = await getJSON(url, name);
    if (j) { fn(j); state.sources[name].count = Array.isArray(j) ? j.length : (j.data || []).length; }
  };
  // GT rate-limits bursts (a 429 reaches the browser as a CORS error), so rotate:
  // 4 GT calls per discovery round, each source refreshed every other round (~2 min)
  const half = gtJobs.length / 2;
  const batch = gtJobs.slice((gtRound % 2) * half, (gtRound % 2) * half + half);
  gtRound++;
  await Promise.all([
    ...dsJobs.map(run),
    (async () => { for (const job of batch) { await run(job); await sleep(1500); } })(),
  ]);
  state.lastDiscover = Date.now();
}
function gt(tag) {
  return (j) =>
    (j.data || []).forEach((p) => {
      const id = p.relationships?.base_token?.data?.id || '';
      if (id.startsWith('solana_')) track(id.slice(7), tag);
    });
}

async function enrich() {
  const mints = [...state.tokens.keys()];
  const now = Date.now();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    const j = await getJSON(`${DS}/tokens/v1/solana/${chunk.join(',')}`, 'DS pairs');
    if (!Array.isArray(j)) { await sleep(400); continue; }
    for (const mint of chunk) {
      const t = state.tokens.get(mint);
      const agg = aggregate(mint, j);
      if (!agg) { t.misses++; continue; }
      t.misses = 0;
      t.data = agg;
      const m = metrics(agg, now);
      t.history.push({ t: now, price: agg.priceUsd, liq: agg.liq, mcap: agg.mcap, br1: m.br1, score: t.score ?? null });
      if (t.history.length > HISTORY_MAX) t.history.splice(0, t.history.length - HISTORY_MAX);
    }
    await sleep(250); // stay well under 300 req/min
  }
}

// RugCheck: one request at a time, only for tokens that look interesting
let rugBusy = false;
async function rugQueue() {
  if (!state.settings.rugcheck || rugBusy) return;
  rugBusy = true;
  try {
    const now = Date.now();
    const want = [...state.tokens.values()]
      .filter((t) => t.data && (t.score ?? 0) >= 30 && !t.result?.quality?.hard.length && (!t.safety || now - t.safety.t > 30 * 60e3))
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
  const r = score(t.data, t.history, state.settings.rugcheck ? t.safety : null);
  t.result = r;
  t.score = r.score;
  const last = t.history[t.history.length - 1];
  if (last) last.score = r.score;
}

function checkAlerts() {
  const now = Date.now();
  for (const t of state.tokens.values()) {
    if (!t.result || !visible(t)) continue;
    if (t.score >= state.settings.alertAt) {
      if (!t.lastAlert || now - t.lastAlert > 30 * 60e3) {
        t.lastAlert = now;
        t.flashUntil = now + 15e3;
        state.signals.unshift({ t: now, mint: t.mint, symbol: t.data.symbol, score: t.score, tags: t.result.tags, mcap: t.data.mcap, price: t.data.priceUsd });
        state.unseen++;
      }
    }
  }
  state.signals = state.signals.slice(0, 50);
}

function prune() {
  for (const [mint, t] of state.tokens) {
    if (t.misses >= 3) state.tokens.delete(mint);
  }
  if (state.tokens.size > MAX_TRACKED) {
    const junk = (t) => (t.result?.quality?.hard.length ? 0 : 1);
    const victims = [...state.tokens.values()]
      .sort((a, b) => junk(a) - junk(b) || (a.score ?? -1) - (b.score ?? -1) || a.firstSeen - b.firstSeen)
      .slice(0, state.tokens.size - MAX_TRACKED);
    victims.forEach((v) => state.tokens.delete(v.mint));
  }
}

async function cycle() {
  if (state.busy) return;
  state.busy = true;
  setStatus('Refreshing…');
  try {
    // discovery endpoints are 60 req/min; 7 calls per minute is fine
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
    rugQueue();
  }
}

// ───────────────────────── filters ─────────────────────────
function visible(t) {
  const s = state.settings;
  const d = t.data;
  if (!d || !t.result) return false;
  const age = t.result.m.ageH;
  if (s.horizon === 'fresh' && age >= 1) return false;
  if (s.horizon === 'young' && (age < 1 || age > 24)) return false;
  if (s.horizon === 'both' && age > 24) return false;
  if (d.liq < s.minLiq) return false;
  if (s.maxMcap && d.mcap > s.maxMcap) return false;
  if (t.score < s.minScore) return false;
  if (s.hideRisky && t.result.tags.includes('RISKY')) return false;
  if (s.sensible && t.result.quality.hard.length) return false;
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

function spark(hist, key = 'price') {
  const pts = hist.slice(-40).map((h) => h[key]).filter((v) => v != null && v > 0);
  if (pts.length < 2) return '<span class="dim">…</span>';
  const min = Math.min(...pts), max = Math.max(...pts);
  const w = 70, h = 20;
  const d = pts.map((v, i) => `${(i / (pts.length - 1)) * w},${max === min ? h / 2 : h - ((v - min) / (max - min)) * (h - 2) - 1}`).join(' ');
  const up = pts[pts.length - 1] >= pts[0];
  return `<svg class="spark" width="${w}" height="${h}"><polyline points="${d}" class="${up ? 'up' : 'down'}"/></svg>`;
}

const TAG_TITLE = {
  ACCUMULATING: 'Buyers dominating and volume rising while price is still flat',
  BREAKOUT: 'Sharp 5-minute move on surging volume and buys',
  LATE: 'Already ran hard; high risk of buying the top',
  DUMPING: 'Sellers in control and price falling',
  RISKY: 'RugCheck danger flags or liquidity being pulled',
  NEW: 'Pool is less than 1 hour old',
  BOOSTED: 'Paid DexScreener boost active',
  JUNK: 'Fails the "Sensible only" quality check (open for reasons)',
};
const tagHTML = (tags) => tags.map((g) => `<span class="tag t-${g.toLowerCase()}" title="${TAG_TITLE[g] || ''}">${g}</span>`).join('');

// ───────────────────────── render ─────────────────────────
// [key, label, shown in compact view, right-aligned]
const COLS = [
  ['rank', '#', 1, 0], ['symbol', 'Token', 1, 0], ['score', 'Score', 1, 0], ['tags', 'Signals', 1, 0],
  ['mcap', 'MCap · Price', 1, 1], ['spark', 'Trend', 1, 0],
  ['m5', '5m', 0, 1], ['h1', '1h', 1, 1], ['h6', '6h', 0, 1], ['h24', '24h', 1, 1], ['liq', 'Liq', 1, 1],
  ['vol1', 'Vol 1h', 0, 1], ['accel', 'Accel', 0, 1], ['bs', 'Buys/Sells 1h', 1, 0], ['age', 'Age', 1, 1], ['safe', 'Safety', 0, 1],
];
const SORTERS = {
  score: (t) => t.score, symbol: (t) => t.data.symbol.toLowerCase(), price: (t) => t.data.priceUsd,
  m5: (t) => t.data.pc.m5, h1: (t) => t.data.pc.h1, h6: (t) => t.data.pc.h6, h24: (t) => t.data.pc.h24,
  mcap: (t) => t.data.mcap, liq: (t) => t.data.liq, vol1: (t) => t.data.vol.h1, accel: (t) => t.result.m.accel1,
  bs: (t) => t.result.m.br1, age: (t) => t.result.m.ageH, safe: (t) => t.safety?.score ?? 1e9,
};

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
    const d = t.data, r = t.result, m = r.m;
    const b = d.txns.h1.buys, s = d.txns.h1.sells, bw = b + s ? (b / (b + s)) * 100 : 50;
    const safe = !state.settings.rugcheck ? '<span class="dim">off</span>'
      : !t.safety ? '<span class="dim">…</span>'
      : t.safety.error ? '<span class="dim" title="' + esc(t.safety.error) + '">n/a</span>'
      : `<span class="${t.safety.risks.some((x) => x.level === 'danger') ? 'down' : t.safety.risks.length ? 'warn' : 'up'}" title="${esc(t.safety.risks.map((x) => x.name).join(', ') || 'No risks reported')}">${t.safety.risks.filter((x) => x.level === 'danger').length ? '⚠ ' : '✓ '}${t.safety.risks.length}</span>`;
    const cell = {
      rank: `<td class="dim">${i + 1}</td>`,
      symbol: `<td class="tok">${d.icon ? `<img src="${esc(d.icon)}" loading="lazy" onerror="this.remove()">` : '<span class="ph"></span>'}<div><b>${esc(d.symbol)}</b><small>${esc(d.name.slice(0, compact ? 16 : 22))}</small></div></td>`,
      score: `<td><div class="score ${scoreClass(t.score)}"><span>${t.score}</span><i style="width:${t.score}%"></i></div></td>`,
      tags: `<td><div class="tags nowrap">${tagHTML(compact ? r.tags.filter((g) => g !== 'BOOSTED') : r.tags)}</div></td>`,
      mcap: `<td class="num pm"><b>${usd(d.mcap)}</b><small>${price(d.priceUsd)}</small></td>`,
      spark: `<td>${spark(t.history, 'mcap')}</td>`,
      m5: `<td class="num">${pct(d.pc.m5)}</td>`, h1: `<td class="num">${pct(d.pc.h1)}</td>`,
      h6: `<td class="num">${pct(d.pc.h6)}</td>`, h24: `<td class="num">${pct(d.pc.h24)}</td>`,
      liq: `<td class="num">${usd(d.liq)}</td>`, vol1: `<td class="num">${usd(d.vol.h1)}</td>`,
      accel: `<td class="num ${m.accel1 >= 2 ? 'up' : m.accel1 < 0.7 ? 'dim' : ''}">${m.ageH < 1.5 ? '<span class="dim">new</span>' : m.accel1.toFixed(1) + '×'}</td>`,
      bs: `<td><div class="bs" title="${b} buys / ${s} sells"><i style="width:${bw}%"></i><span>${b}/${s}</span></div></td>`,
      age: `<td class="num">${age(m.ageH)}</td>`,
      safe: `<td class="num">${safe}</td>`,
    };
    return `<tr data-mint="${t.mint}" class="${t.flashUntil > now ? 'flash' : ''} ${state.selected === t.mint ? 'sel' : ''}">${cols.map(([k]) => cell[k]).join('')}</tr>`;
  }).join('') || `<tr><td colspan="${cols.length}" class="empty">${state.tokens.size ? 'No tokens match the current filters.' : 'Collecting candidates… first results in a few seconds.'}</td></tr>`;

  // signals strip: MCap when it fired → MCap now
  $('#signals').innerHTML = state.signals.length
    ? state.signals.slice(0, 12).map((g) => {
        const nowMcap = state.tokens.get(g.mint)?.data?.mcap;
        const move = g.mcap && nowMcap ? ((nowMcap - g.mcap) / g.mcap) * 100 : null;
        const mc = g.mcap ? ` <span class="dim">${usd(g.mcap)}</span>${nowMcap && move != null && Math.abs(move) >= 0.5 ? `→${usd(nowMcap)} ${pct(move)}` : ''}` : '';
        return `<button class="sig" data-mint="${g.mint}" title="${g.price ? 'Price at signal ' + price(g.price).replace(/<\/?sub>/g, '') : ''}"><b>${esc(g.symbol)}</b> <span class="${scoreClass(g.score)}">${g.score}</span>${mc} <small>${ago(g.t)}</small></button>`;
      }).join('')
    : `<span class="dim">Tokens crossing score ${state.settings.alertAt} will appear here.</span>`;
  $('#sigcount').textContent = state.unseen ? state.unseen : '';
  $('#sigcount').hidden = !state.unseen;
  document.title = (state.unseen ? `(${state.unseen}) ` : '') + 'SolMon — Solana memecoin monitor';

  // stats
  const withData = [...state.tokens.values()].filter((t) => t.result);
  const junk = withData.filter((t) => t.result.quality.hard.length).length;
  $('#stats').innerHTML = `<span>Tracking <b>${withData.length}</b></span><span title="Hidden by Sensible only">Junk <b>${junk}</b></span><span>Showing <b>${rows.length}</b></span><span>Hot ≥${state.settings.alertAt}: <b class="s-hot">${rows.filter((t) => t.score >= state.settings.alertAt).length}</b></span>`;

  // sources
  $('#sources').innerHTML = Object.entries(state.sources).map(([k, v]) =>
    `<span class="src ${v.ok ? 'ok' : v.ok === false ? 'bad' : ''}" title="${esc(v.err || (v.t ? 'ok ' + ago(v.t) + ' ago' : ''))}">${k}</span>`).join('');

  if (state.selected) renderDetail();
}

function renderDetail() {
  const t = state.tokens.get(state.selected);
  const el = $('#detail');
  if (!t || !t.result) { el.hidden = true; return; }
  el.hidden = false;
  const d = t.data, r = t.result, m = r.m;
  const MAX = { pressure: 25, accel: 25, quiet: 20, liquidity: 15, trend: 15 };
  const LABEL = { pressure: 'Buy pressure', accel: 'Volume acceleration', quiet: 'Quiet accumulation', liquidity: 'Liquidity health', trend: 'Live trend (our snapshots)' };
  const tr = r.tr;
  el.innerHTML = `
    <button class="close" id="closeDetail" aria-label="Close">×</button>
    <div class="dh">${d.icon ? `<img src="${esc(d.icon)}" onerror="this.remove()">` : ''}<div><h2>${esc(d.symbol)} <small>${esc(d.name)}</small></h2>
      <code class="mint" title="Click to copy" data-copy="${t.mint}">${t.mint.slice(0, 6)}…${t.mint.slice(-6)}</code></div>
      <div class="bigscore ${scoreClass(t.score)}">${t.score}</div></div>
    <div class="dpm"><div><small>MCap</small><b>${usd(d.mcap)}</b></div><div><small>Price</small><b>${price(d.priceUsd)}</b></div><div><small>Liq</small><b>${usd(d.liq)}</b></div><div><small>24h</small><b>${pct(d.pc.h24)}</b></div></div>
    <div class="tags">${tagHTML(r.tags)}</div>
    ${r.quality.hard.length ? `<h3>Filtered as junk</h3><ul class="risks">${r.quality.hard.map((x) => `<li class="danger">${esc(x)}</li>`).join('')}</ul>` : ''}
    <h3>Why this score</h3>
    ${Object.keys(MAX).map((k) => `<div class="part"><span>${LABEL[k]}</span><div class="pbar"><i style="width:${(r.parts[k] / MAX[k]) * 100}%"></i></div><b>${r.parts[k].toFixed(1)}<small>/${MAX[k]}</small></b></div>`).join('')}
    ${r.penalties.map((p) => `<div class="part pen"><span>${esc(p.label)}</span><div></div><b>−${p.pts}</b></div>`).join('')}
    <h3>Numbers</h3>
    <dl>
      <dt>Buy ratio 5m / 1h / 6h</dt><dd>${(m.br5 * 100).toFixed(0)}% / ${(m.br1 * 100).toFixed(0)}% / ${(m.br6 * 100).toFixed(0)}%</dd>
      <dt>Txns 1h</dt><dd>${d.txns.h1.buys} buys · ${d.txns.h1.sells} sells</dd>
      <dt>Avg trade 1h</dt><dd>${usd(r.quality.avgTx1)}</dd>
      <dt>Volume 1h vs hourly avg</dt><dd>${m.accel1.toFixed(2)}×</dd>
      <dt>Volume 5m vs 1h pace</dt><dd>${m.accel5.toFixed(2)}×</dd>
      <dt>Liquidity / MCap</dt><dd>${(m.liqRatio * 100).toFixed(1)}%</dd>
      <dt>Vol 5m / 1h / 6h / 24h</dt><dd>${usd(d.vol.m5)} / ${usd(d.vol.h1)} / ${usd(d.vol.h6)} / ${usd(d.vol.h24)}</dd>
      <dt>Pools · DEX</dt><dd>${d.pairs} · ${esc(d.dexId)}</dd>
      <dt>Found via</dt><dd>${t.sources.join(', ')} · ${ago(t.firstSeen)} ago</dd>
      <dt>Live trend</dt><dd>${tr ? `liq ${(tr.liqG * 100).toFixed(1)}%, mcap ${(tr.mcapG * 100).toFixed(1)}% over ${tr.spanMin.toFixed(0)}m (${tr.n} snapshots)` : '<span class="dim">needs ~3 min of snapshots</span>'}</dd>
    </dl>
    <h3>MCap since tracked</h3><div class="bigspark">${spark(t.history, 'mcap').replace('width="70" height="20"', 'width="100%" height="60" viewBox="0 0 70 20" preserveAspectRatio="none"')}</div>
    <h3>Safety (RugCheck)</h3>
    ${!state.settings.rugcheck ? '<p class="dim">RugCheck disabled.</p>'
      : !t.safety ? '<p class="dim">Queued — checked once score ≥ 35.</p>'
      : t.safety.error ? `<p class="dim">Unavailable: ${esc(t.safety.error)}</p>`
      : `<p>Risk score <b>${t.safety.score}</b>${t.safety.lpLockedPct != null ? ` · LP locked <b>${t.safety.lpLockedPct.toFixed(0)}%</b>` : ''}</p>
         <ul class="risks">${t.safety.risks.map((x) => `<li class="${x.level}"><b>${esc(x.name)}</b> ${esc(x.value || '')}<br><small>${esc(x.description || '')}</small></li>`).join('') || '<li class="good">No risks reported</li>'}</ul>`}
    <div class="links">
      <a href="${esc(d.url)}" target="_blank" rel="noopener">DexScreener</a>
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
      if (key === 'rugcheck') for (const t of state.tokens.values()) rescore(t);
      save(); render(); if (key === 'rugcheck') rugQueue();
    });
  };
  bind('minLiq', 'minLiq', Number);
  bind('maxMcap', 'maxMcap', Number);
  bind('minScore', 'minScore', Number);
  bind('alertAt', 'alertAt', Number);
  bind('refreshSec', 'refreshSec', Number);
  bind('rugcheck', 'rugcheck');
  bind('hideRisky', 'hideRisky');
  bind('sensible', 'sensible');
  bind('compact', 'compact');

  document.querySelectorAll('#horizon button').forEach((b) => {
    b.classList.toggle('on', b.dataset.h === s.horizon);
    b.addEventListener('click', () => {
      s.horizon = b.dataset.h;
      document.querySelectorAll('#horizon button').forEach((x) => x.classList.toggle('on', x === b));
      save(); render();
    });
  });

  $('#thead').addEventListener('click', (e) => {
    const k = e.target.closest('th')?.dataset.k;
    if (!k || !SORTERS[k]) return;
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === 'symbol' || k === 'age' ? 1 : -1) };
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
  // clear expired row flashes
  document.querySelectorAll('tr.flash').forEach((tr) => {
    const t = state.tokens.get(tr.dataset.mint);
    if (!t || !(t.flashUntil > Date.now())) tr.classList.remove('flash');
  });
}

// ───────────────────────── boot ─────────────────────────
load();
for (const t of state.tokens.values()) rescore(t);
bindControls();
render();
cycle();
setInterval(tick, 1000);
window.__solmon = state; // handy for debugging in the console
