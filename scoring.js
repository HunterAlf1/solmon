// SolMon scoring engine — pure functions, no network.
// Turns DexScreener pair data (+ our own snapshot history + RugCheck) into a 0–100 score.

export const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const TF = ['m5', 'h1', 'h6', 'h24'];

/** Merge every Solana pair where `mint` is the base token into one token view. */
export function aggregate(mint, pairs) {
  const own = (pairs || []).filter(
    (p) => p && p.chainId === 'solana' && p.baseToken?.address === mint
  );
  if (!own.length) return null;
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
    createdAt: Number.isFinite(created) ? created : 0,
    boosts: n(top.boosts?.active),
    socials: top.info?.socials || [],
    websites: top.info?.websites || [],
  };
}

const ratio = (t) => (t.buys + t.sells > 0 ? t.buys / (t.buys + t.sells) : 0.5);

/** Derived metrics shared by scoring and UI. */
export function metrics(t, now = Date.now()) {
  const ageH = t.createdAt ? Math.max((now - t.createdAt) / 3.6e6, 0.01) : 999;
  const br5 = ratio(t.txns.m5), br1 = ratio(t.txns.h1), br6 = ratio(t.txns.h6);
  const tx1 = t.txns.h1.buys + t.txns.h1.sells;
  const tx5 = t.txns.m5.buys + t.txns.m5.sells;
  // hourly baseline: h6 window, but a token younger than 6h only has ageH hours of volume in it
  const baseHours = clamp(ageH, 0.25, 6);
  const hourlyBase = t.vol.h6 / baseHours;
  const accel1 = hourlyBase > 0 ? t.vol.h1 / hourlyBase : 0;
  // 5m vs the last hour's average 5m slice
  const h1Hours = clamp(ageH, 1 / 12, 1);
  const fiveBase = t.vol.h1 / (h1Hours * 12);
  const accel5 = fiveBase > 0 ? t.vol.m5 / fiveBase : 0;
  const liqRatio = t.mcap > 0 ? t.liq / t.mcap : 0;
  return { ageH, br5, br1, br6, tx1, tx5, accel1, accel5, liqRatio };
}

/** Trend from our own snapshots (last ~15 min). */
export function trend(history, now = Date.now()) {
  const pts = (history || []).filter((h) => now - h.t <= 15 * 60e3);
  if (pts.length < 3 || pts[pts.length - 1].t - pts[0].t < 3 * 60e3) return null;
  const a = pts[0], b = pts[pts.length - 1];
  const liqG = a.liq > 0 ? (b.liq - a.liq) / a.liq : 0;
  const mcapG = a.mcap > 0 ? (b.mcap - a.mcap) / a.mcap : 0;
  const brAvg = pts.reduce((s, p) => s + p.br1, 0) / pts.length;
  const brMin = Math.min(...pts.map((p) => p.br1));
  return { liqG, mcapG, brAvg, brMin, spanMin: (b.t - a.t) / 60e3, n: pts.length };
}

/**
 * Is this a coin worth looking at at all?
 * `hard` reasons hide it in "Sensible only" mode; `soft` ones become score penalties.
 */
export function quality(t, m, safety = null) {
  const hard = [], soft = [];
  const avgTx1 = m.tx1 > 0 ? t.vol.h1 / m.tx1 : 0;
  if (t.mcap > 0 && t.mcap < 20000) hard.push('MCap under $20K');
  if (m.tx1 < 20) hard.push('Under 20 trades in the last hour');
  if (m.tx1 >= 100 && avgTx1 < 10) hard.push('Bot spam: average trade under $10');
  if (m.liqRatio > 0 && m.liqRatio < 0.02) hard.push('Liquidity under 2% of MCap');
  if (m.liqRatio > 1.2) hard.push('Liquidity larger than MCap (odd pool)');
  if (t.pc.h24 < -70) hard.push('Down 70%+ in 24h');
  if (m.br1 < 0.4 && t.pc.h1 < -25) hard.push('Being dumped');
  if (safety && !safety.error) {
    if (safety.rugged) hard.push('Marked rugged');
    if (safety.risks.some((r) => r.level === 'danger' && /mint|freeze/i.test(r.name || '')))
      hard.push('Mint or freeze authority still enabled');
  }
  if (t.liq > 0 && t.vol.h1 / t.liq > 10) soft.push({ label: '1h volume >10× liquidity (wash?)', pts: 10 });
  if (!t.socials.length && !t.websites.length) soft.push({ label: 'No socials or website', pts: 8 });
  if (m.tx1 >= 60 && avgTx1 >= 10 && avgTx1 < 25) soft.push({ label: 'Tiny average trade size', pts: 5 });
  return { hard, soft, avgTx1 };
}

/**
 * Score a token.
 * Parts (max): pressure 25, accel 25, quiet accumulation 20, liquidity 15, trend 15 = 100.
 */
export function score(t, history = [], safety = null, now = Date.now()) {
  const m = metrics(t, now);
  const tr = trend(history, now);
  const parts = {};
  const penalties = [];
  const tags = [];

  // 1) Buy pressure — weighted by activity so 3 buys / 1 sell doesn't count much
  const act1 = clamp(m.tx1 / 60), act5 = clamp(m.tx5 / 8);
  parts.pressure =
    clamp((m.br1 - 0.5) / 0.2) * 15 * act1 + clamp((m.br5 - 0.5) / 0.2) * 10 * act5;

  // 2) Volume acceleration
  const a1 = m.ageH >= 1.5 ? clamp((m.accel1 - 1) / 2) : 0.5 * clamp(m.tx1 / 150); // fresh: activity proxy
  parts.accel = a1 * 15 + clamp((m.accel5 - 1) / 2) * 10;

  // 3) Quiet accumulation: buyers stepping in, volume rising, price not yet run
  const quietBase =
    m.br1 > 0.55 && (m.accel1 > 1.2 || m.ageH < 1.5) && Math.abs(t.pc.h1) < 20 && t.pc.h6 > -25 && t.pc.h6 < 60;
  parts.quiet = quietBase
    ? 20 * clamp((m.br1 - 0.55) / 0.12) * (1 - Math.abs(t.pc.h1) / 20) * act1
    : 0;

  // 4) Liquidity health
  const lr = m.liqRatio;
  const ratioPts = lr >= 0.05 && lr <= 0.35 ? 8 : lr > 0.35 ? 4 : clamp(lr / 0.05) * 6;
  parts.liquidity = ratioPts + clamp(Math.log10(Math.max(t.liq, 1) / 10000) / Math.log10(20)) * 7; // $10k→0, $200k→7

  // 5) Trend memory
  if (tr) {
    parts.trend =
      clamp(tr.liqG / 0.15) * 6 + clamp(tr.mcapG / 0.3) * 4 + clamp((tr.brAvg - 0.5) / 0.15) * 5;
    if (tr.liqG < -0.15) penalties.push({ label: 'Liquidity dropping', pts: 20 });
  } else {
    parts.trend = 0;
  }

  // Penalties
  if (t.pc.h24 > 500) penalties.push({ label: '+500% in 24h (late)', pts: 20 });
  else if (t.pc.h24 > 250) penalties.push({ label: '+250% in 24h', pts: 10 });
  if (t.pc.h1 > 80) penalties.push({ label: '+80% in 1h (chasing)', pts: 10 });
  if (m.br1 < 0.45 && t.pc.h1 < -10) penalties.push({ label: 'Sellers in control', pts: 15 });
  if (t.pc.h6 < -40) penalties.push({ label: '-40% in 6h', pts: 10 });
  if (m.tx1 < 15) penalties.push({ label: 'Barely trading', pts: 10 });
  if (safety && !safety.error) {
    const danger = safety.risks.filter((r) => r.level === 'danger');
    const warn = safety.risks.filter((r) => r.level === 'warn');
    if (danger.length) penalties.push({ label: `${danger.length} RugCheck danger flag(s)`, pts: Math.min(30, danger.length * 12) });
    if (warn.length) penalties.push({ label: `${warn.length} RugCheck warning(s)`, pts: Math.min(9, warn.length * 3) });
    if (safety.rugged) penalties.push({ label: 'Marked rugged', pts: 100 });
  }
  const q = quality(t, m, safety);
  penalties.push(...q.soft);

  const raw = Object.values(parts).reduce((s, v) => s + v, 0);
  const pen = penalties.reduce((s, p) => s + p.pts, 0);
  const total = Math.round(clamp(raw - pen, 0, 100));

  // Tags
  if (parts.quiet >= 8) tags.push('ACCUMULATING');
  if (t.pc.m5 > 4 && m.accel5 > 2 && m.br5 > 0.6) tags.push('BREAKOUT');
  if (t.pc.h24 > 250 || t.pc.h1 > 80) tags.push('LATE');
  if (m.br1 < 0.45 && t.pc.h1 < -10) tags.push('DUMPING');
  if (safety && !safety.error && (safety.rugged || safety.risks.some((r) => r.level === 'danger'))) tags.push('RISKY');
  if (tr && tr.liqG < -0.15) tags.push('RISKY');
  if (m.ageH < 1) tags.push('NEW');
  if (t.boosts > 0) tags.push('BOOSTED');
  if (q.hard.length) tags.push('JUNK');

  return { score: total, raw, parts, penalties, tags: [...new Set(tags)], m, tr, quality: q };
}

/** Normalise RugCheck /report/summary into {score, risks[], rugged}. */
export function parseRug(j) {
  if (!j || typeof j !== 'object') return { error: 'bad response' };
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
