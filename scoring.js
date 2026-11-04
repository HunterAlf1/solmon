// SolMon scoring engine — pure functions, no network.
// Finds graduated launchpad coins that have bled out, built a floor, and are starting to wake up.

export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const TF = ['m5', 'h1', 'h6', 'h24'];
const H = 3.6e6;

/** Launchpad mints: pump.fun vanity "…pump", letsbonk "…bonk". */
export const isLaunchpadMint = (mint) => /(pump|bonk)$/.test(mint || '');

/** DexScreener dexIds that are bonding curves, i.e. NOT graduated yet. */
const CURVE = new Set(['pumpfun', 'launchlab', 'meteoradbc', 'boop', 'moonit', 'moonshot', 'believe']);

/**
 * Merge every graduated Solana pair where `mint` is the base token into one token view.
 * Returns null when DexScreener knows no pair; `{ graduated: false }` when only a bonding curve exists.
 */
export function aggregate(mint, pairs) {
  const all = (pairs || []).filter((p) => p && p.chainId === 'solana' && p.baseToken?.address === mint);
  if (!all.length) return null;
  const own = all.filter((p) => !CURVE.has(p.dexId));
  if (!own.length) return { mint, graduated: false };
  own.sort((a, b) => n(b.liquidity?.usd) - n(a.liquidity?.usd));
  const top = own[0];
  const txns = {}, vol = {};
  for (const tf of TF) {
    txns[tf] = { buys: 0, sells: 0 };
    vol[tf] = 0;
    for (const p of own) {
      txns[tf].buys += n(p.txns?.[tf]?.buys);
      txns[tf].sells += n(p.txns?.[tf]?.sells);
      vol[tf] += n(p.volume?.[tf]);
    }
  }
  const created = Math.min(...own.map((p) => n(p.pairCreatedAt) || Infinity));
  return {
    mint,
    graduated: true,
    symbol: top.baseToken?.symbol || '?',
    name: top.baseToken?.name || '',
    icon: top.info?.imageUrl || '',
    url: top.url || `https://dexscreener.com/solana/${top.pairAddress}`,
    pairAddress: top.pairAddress,
    dexId: top.dexId,
    pairs: own.length,
    priceUsd: n(top.priceUsd),
    pc: { m5: n(top.priceChange?.m5), h1: n(top.priceChange?.h1), h6: n(top.priceChange?.h6), h24: n(top.priceChange?.h24) },
    txns,
    vol,
    liq: own.reduce((s, p) => s + n(p.liquidity?.usd), 0),
    mcap: n(top.marketCap) || n(top.fdv),
    createdAt: Number.isFinite(created) ? created : 0, // = graduation time for launchpad coins
    boosts: n(top.boosts?.active),
    socials: top.info?.socials || [],
    websites: top.info?.websites || [],
  };
}

const ratio = (t) => (t.buys + t.sells > 0 ? t.buys / (t.buys + t.sells) : 0.5);

/** Derived metrics shared by scoring and UI. */
export function metrics(t, now = Date.now()) {
  const ageH = t.createdAt ? Math.max((now - t.createdAt) / H, 0.01) : 999;
  const br5 = ratio(t.txns.m5), br1 = ratio(t.txns.h1), br6 = ratio(t.txns.h6);
  const tx1 = t.txns.h1.buys + t.txns.h1.sells;
  const tx5 = t.txns.m5.buys + t.txns.m5.sells;
  const hourlyBase = t.vol.h6 / clamp(ageH, 0.25, 6);
  const accel1 = hourlyBase > 0 ? t.vol.h1 / hourlyBase : 0;
  const liqRatio = t.mcap > 0 ? t.liq / t.mcap : 0;
  const avgTx1 = tx1 > 0 ? t.vol.h1 / tx1 : 0;
  return { ageH, br5, br1, br6, tx1, tx5, accel1, liqRatio, avgTx1 };
}

/**
 * Price history from GeckoTerminal hourly candles ([ts, o, h, l, c, v], any order).
 * Uses closes, not wicks: thin pools print absurd highs.
 */
export function analyzeCandles(list, now = Date.now()) {
  const c = (list || [])
    .map((x) => ({ t: n(x[0]) * 1000, c: n(x[4]), v: n(x[5]) }))
    .filter((x) => x.c > 0)
    .sort((a, b) => a.t - b.t);
  if (c.length < 6) return null;
  let athI = 0;
  c.forEach((x, i) => { if (x.c > c[athI].c) athI = i; });
  let lowI = athI;
  for (let i = athI; i < c.length; i++) if (c[i].c < c[lowI].c) lowI = i;
  const floor = c[lowI].c;
  const within = (a, b) => c.filter((x) => now - x.t > a * H && now - x.t <= b * H);
  const range = (arr) => {
    if (arr.length < 3) return null;
    const hi = Math.max(...arr.map((x) => x.c)), lo = Math.min(...arr.map((x) => x.c));
    return lo > 0 ? (hi - lo) / lo : null;
  };
  const avgV = (arr) => (arr.length ? arr.reduce((s, x) => s + x.v, 0) / arr.length : 0);
  const r12 = range(within(0, 12)), rOld = range(within(12, 48));
  const v6 = avgV(within(0, 6)), vPrev = avgV(within(6, 30));
  const last12 = within(1, 12);
  return {
    ath: c[athI].c,
    athAgoH: (now - c[athI].t) / H,
    floor,
    lowAgoH: (now - c[lowI].t) / H,
    tests: within(0, 48).filter((x) => x.c <= floor * 1.15).length, // hours spent near the floor, last 48h
    compression: r12 != null && rOld ? r12 / rOld : null, // < 1 = range tightening
    volWake: vPrev > 0 ? v6 / vPrev : null, // last 6h hourly volume vs the 24h before
    hi12: last12.length ? Math.max(...last12.map((x) => x.c)) : 0,
    spanH: (c[c.length - 1].t - c[0].t) / H,
    t: now,
  };
}

/** Where the live price sits against the history. */
export function position(t, hist) {
  if (!hist || !t.priceUsd) return null;
  const floor = Math.min(hist.floor, t.priceUsd);
  return {
    dd: 1 - t.priceUsd / hist.ath, // 0.84 = 84% below ATH
    fromLow: t.priceUsd / floor - 1, // 0.12 = 12% above the floor
    athMcap: t.mcap * (hist.ath / t.priceUsd),
    floorMcap: t.mcap * (floor / t.priceUsd),
    newLow: t.priceUsd <= hist.floor,
  };
}

/** Trend from our own snapshots (last ~15 min). */
export function trend(history, now = Date.now()) {
  const pts = (history || []).filter((h) => now - h.t <= 15 * 60e3);
  if (pts.length < 3 || pts[pts.length - 1].t - pts[0].t < 3 * 60e3) return null;
  const a = pts[0], b = pts[pts.length - 1];
  const liqG = a.liq > 0 ? (b.liq - a.liq) / a.liq : 0;
  const mcapG = a.mcap > 0 ? (b.mcap - a.mcap) / a.mcap : 0;
  const brAvg = pts.reduce((s, p) => s + p.br1, 0) / pts.length;
  return { liqG, mcapG, brAvg, spanMin: (b.t - a.t) / 60e3, n: pts.length };
}

/**
 * Hard safety/sanity gates. Anything in `hard` hides the coin in "Safe only" mode.
 * `unchecked` = RugCheck has not reported yet (also hidden in Safe only).
 */
export function gates(t, m, safety, pos) {
  const hard = [];
  if (t.mcap < 30000) hard.push('MCap under $30K');
  if (t.vol.h24 < 10000 || m.tx1 < 10) hard.push('Barely trading (under $10K/24h or 10 trades/h)');
  if (m.tx1 >= 100 && m.avgTx1 < 10) hard.push('Bot spam: average trade under $10');
  if (m.liqRatio > 0 && m.liqRatio < 0.03) hard.push('Liquidity under 3% of MCap');
  if (m.liqRatio > 1.2) hard.push('Liquidity larger than MCap (odd pool)');
  if (pos && pos.dd > 0.97) hard.push('Down 97%+ from ATH (dead)');
  let unchecked = false;
  if (!safety) unchecked = true;
  else if (safety.error) unchecked = true;
  else {
    if (safety.rugged) hard.push('Marked rugged by RugCheck');
    for (const r of safety.risks) if (r.level === 'danger') hard.push(`RugCheck: ${r.name}`);
  }
  return { hard, unchecked };
}

/**
 * Bottom-bounce score, 0–100.
 * Parts (max): off the top 20, floor holding 25, sellers exhausted 20, waking up 25, liquidity 10.
 */
export const PARTS = {
  drop: ['Off the top (drawdown from ATH)', 20],
  floor: ['Floor holding', 25],
  exhaust: ['Sellers exhausted', 20],
  wake: ['Waking up (volume + buyers)', 25],
  liquidity: ['Liquidity health', 10],
};

export function score(t, history = [], safety = null, hist = null, now = Date.now()) {
  const m = metrics(t, now);
  const tr = trend(history, now);
  const pos = position(t, hist);
  const g = gates(t, m, safety, pos);
  const parts = { drop: 0, floor: 0, exhaust: 0, wake: 0, liquidity: 0 };
  const penalties = [];
  const tags = [];
  const act1 = clamp(m.tx1 / 60);

  // Liquidity health (always available)
  const lr = m.liqRatio;
  parts.liquidity =
    (lr >= 0.08 && lr <= 0.5 ? 5 : lr > 0.5 ? 3 : clamp(lr / 0.08) * 4) +
    clamp(Math.log10(Math.max(t.liq, 1) / 15000)) * 5; // $15K→0, $150K→5

  if (pos) {
    const dd = pos.dd;
    // 1) Off the top: 50% down starts counting, 70–92% is the sweet spot, beyond 97% it's dead
    parts.drop = dd < 0.5 ? 0 : dd <= 0.7 ? (20 * (dd - 0.5)) / 0.2 : dd <= 0.92 ? 20 : dd <= 0.97 ? (20 * (0.97 - dd)) / 0.05 : 0;

    // Floor/exhaustion/wake-up only mean something once the coin has actually bled out:
    // 0 at −40% from ATH, full from −70%.
    const bottomness = clamp((dd - 0.4) / 0.3);

    // 2) Floor holding: close to the floor, floor is not brand new, it has been retested, 6h not bleeding
    const near = clamp(1 - pos.fromLow / 0.35);
    const aged = clamp(hist.lowAgoH / 12);
    const tested = clamp(hist.tests / 8);
    parts.floor = bottomness * 25 * near * (0.4 * aged + 0.35 * tested + 0.25 * (t.pc.h6 > -10 ? 1 : 0));

    // 3) Sellers exhausted: buys ≥ sells over 6h and 1h, range tightening
    parts.exhaust = bottomness * (
      8 * clamp((m.br6 - 0.45) / 0.15) +
      6 * clamp((m.br1 - 0.45) / 0.15) * act1 +
      6 * (hist.compression != null ? clamp((1 - hist.compression) / 0.6) : 0));

    // 4) Waking up: volume returning, buyers stepping in, an early lift (not a pump yet)
    const lift = t.pc.h1 > 0 && t.pc.h1 < 30 ? clamp(t.pc.h1 / 8) : 0;
    parts.wake = bottomness * (
      9 * clamp(((hist.volWake ?? 0) - 1) / 2) +
      6 * clamp((m.accel1 - 1) / 2) +
      5 * clamp((m.br5 - 0.5) / 0.2) * clamp(m.tx5 / 8) +
      5 * lift * act1);

    // Penalties
    if (pos.fromLow > 1) penalties.push({ label: 'Already 2×+ off the low (late)', pts: 15 });
    else if (pos.fromLow > 0.6) penalties.push({ label: 'Already +60% off the low', pts: 6 });
    if (pos.newLow || (hist.lowAgoH < 3 && t.pc.h6 < -15)) penalties.push({ label: 'Still making new lows', pts: 15 });
  }

  if (t.pc.h1 > 50) penalties.push({ label: '+50% in 1h (chasing)', pts: 10 });
  if (m.br1 < 0.42 && t.pc.h1 < -8) penalties.push({ label: 'Sellers in control', pts: 10 });
  if (tr && tr.liqG < -0.15) penalties.push({ label: 'Liquidity being pulled', pts: 20 });
  if (t.liq > 0 && t.vol.h1 / t.liq > 10) penalties.push({ label: '1h volume >10× liquidity (wash?)', pts: 10 });
  if (!t.socials.length && !t.websites.length) penalties.push({ label: 'No socials or website', pts: 8 });
  if (safety && !safety.error) {
    const warn = safety.risks.filter((r) => r.level === 'warn');
    if (warn.length) penalties.push({ label: `${warn.length} RugCheck warning(s)`, pts: Math.min(9, warn.length * 3) });
  }

  const raw = Object.values(parts).reduce((s, v) => s + v, 0);
  const pen = penalties.reduce((s, p) => s + p.pts, 0);
  const total = Math.round(clamp(raw - pen, 0, 100));

  // Tags
  if (pos) {
    const falling = pos.newLow || (hist.lowAgoH < 3 && t.pc.h6 < -15);
    const bled = pos.dd >= 0.5;
    if (pos.dd >= 0.7 && pos.fromLow <= 0.35 && !falling) tags.push('BOTTOMED');
    if (bled && hist.tests >= 6 && hist.compression != null && hist.compression < 0.6) tags.push('BASE');
    if (bled && (hist.volWake ?? 0) >= 1.8 && m.br1 >= 0.55) tags.push('WAKING');
    if (bled && hist.hi12 > 0 && t.priceUsd > hist.hi12 && m.br5 > 0.55 && t.pc.h1 > 5) tags.push('BREAKOUT');
    if (falling) tags.push('FALLING');
    if (pos.fromLow > 1) tags.push('BOUNCED');
  } else tags.push('NO HISTORY');
  if (g.hard.length) tags.push('RISKY');
  else if (!g.unchecked) tags.push('SAFE');
  else tags.push('UNCHECKED');

  return { score: total, raw, parts, penalties, tags, m, tr, pos, gates: g };
}

/** Normalise RugCheck /report/summary into {score, risks[], rugged}. */
export function parseRug(j) {
  if (!j || typeof j !== 'object') return { error: 'bad response', t: Date.now(), risks: [] };
  return {
    score: n(j.score_normalised ?? j.score),
    risks: (j.risks || []).map((r) => ({
      name: r.name, level: r.level, description: r.description, value: r.value,
    })),
    rugged: !!j.rugged,
    lpLockedPct: j.lpLockedPct != null ? n(j.lpLockedPct) : null,
    t: Date.now(),
  };
}
