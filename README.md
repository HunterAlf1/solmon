# SolMon — Solana memecoin accumulation monitor

A live, browser-only dashboard that ranks Solana memecoins by how strongly they look like they are being **accumulated before a move**. Inspired by WavesMon.

**Live:** https://hunteralf1.github.io/solmon/

No backend, no API keys. The page polls free public APIs straight from your browser and keeps settings and snapshot history in `localStorage`.

## Data sources

| Source | Used for | Limit |
|---|---|---|
| DexScreener `token-profiles`, `token-boosts` (latest/top), `community-takeovers` | Discovering candidates | 60 req/min |
| GeckoTerminal `trending_pools` (default, 5m, 1h, page 2), `new_pools` (pages 1–2), `pools?sort=h24_tx_count_desc`, `pools?sort=h24_volume_usd_desc` | Discovering candidates; 4 calls per round, rotated so each refreshes every ~2 min | ~30 req/min, bursts get blocked |
| DexScreener `tokens/v1/solana/{mints}` | Price, txns, volume, liquidity, mcap for every tracked token (30 per call) | 300 req/min |
| RugCheck `tokens/{mint}/report/summary` | Safety flags, queried only for tokens scoring ≥ 35, cached 30 min | — |

Discovery runs about once a minute. Enrichment runs every refresh (20/30/60 s). Up to 500 tokens are tracked; tokens with no pool for 3 cycles are dropped, and junk is dropped first when the cap is hit.

**Blind spot:** only tokens with a DEX pool are visible. pump.fun tokens show up once they graduate from the bonding curve.

## Score (0–100)

| Part | Max | Meaning |
|---|---|---|
| Buy pressure | 25 | Buy share of transactions in 1h and 5m, weighted by activity |
| Volume acceleration | 25 | 1h volume vs 6h hourly average; 5m vs the hour's pace |
| Quiet accumulation | 20 | Buyers dominate and volume rises while price is still roughly flat |
| Liquidity health | 15 | Liquidity at 5–35% of mcap, plus dollar depth |
| Live trend | 15 | From the page's own snapshots: liquidity/mcap growth and sustained buy ratio over ~15 min |

**Penalties:** +250%/+500% in 24h, +80% in 1h, sellers in control, −40% in 6h, barely trading, liquidity pulled >15%, RugCheck danger/warn flags, rugged, 1h volume >10× liquidity (wash-like), no socials or website, tiny average trade size.

**Sensible only** (on by default) hides coins tagged `JUNK`: MCap under $20K, under 20 trades in the last hour, bot spam (average trade under $10), liquidity under 2% or over 120% of MCap, down 70%+ in 24h, being dumped, rugged, or mint/freeze authority still enabled. Open a coin to see why it was flagged.

**Compact** (on by default) shows fewer columns, with MCap and price stacked in one cell and an MCap trend line. The ⚡ Signals strip shows MCap when the signal fired → MCap now.

**Tags:** `ACCUMULATING`, `BREAKOUT`, `LATE`, `DUMPING`, `RISKY`, `NEW`, `BOOSTED`, `JUNK`.

**Signals:** when a visible token crosses the "Signal at" threshold, it flashes in the table and appears in the ⚡ Signals strip. The tab title shows the unseen count. Each token re-signals at most once per 30 min.

The scoring lives in `scoring.js` as pure functions, so it's easy to tune.

## Run locally

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

(ES modules need to be served over http, not opened as `file://`.)

## Disclaimer

The score is a filter for what deserves a manual look, not a prediction. Most memecoins go to zero. Not financial advice.
