# SolMon — graduated Solana coins near the bottom

A live, browser-only dashboard that finds **graduated** pump.fun / letsbonk coins that have **bled out, built a floor, and are starting to wake up**, and hides the ones with known rug signals.

**Live:** https://hunteralf1.github.io/solmon/

No backend, no API keys. The page polls free public APIs straight from your browser and keeps settings and snapshot history in `localStorage`.

## What counts

- **Graduated:** the mint ends in `pump` (pump.fun) or `bonk` (letsbonk) and it trades in a real DEX pool (PumpSwap, Raydium, …), not on the bonding curve. Coins still on the curve are dropped.
- **Near bottom** (filter, on by default): at least 60% below its all-time high and no more than 60% above its post-ATH floor.
- **Safe only** (filter, on by default): RugCheck has checked it and reports no danger flags (mint/freeze authority, top-holder concentration, single big holder, low liquidity, rugged). It must also have MCap ≥ $30K, ≥ $10K 24h volume and ≥ 10 trades/hour, no bot-spam trading, liquidity between 3% and 120% of MCap, and not be down 97%+.

## Data sources

| Source | Used for | Limit |
|---|---|---|
| GeckoTerminal `dexes/pumpswap/pools` (by trades and by volume, several pages), `dexes/raydium…/pools`, `trending_pools` | Discovering graduated coins; 1 call per round, rotated | ~5 req/min in practice |
| DexScreener `token-profiles`, `token-boosts`, `community-takeovers` | Discovering candidates | 60 req/min |
| DexScreener `tokens/v1/solana/{mints}` | Price, txns, volume, liquidity, MCap (30 per call) | 300 req/min |
| GeckoTerminal `pools/{pool}/ohlcv/hour` (up to 1000 candles) | ATH, floor, floor retests, range compression, volume revival; refreshed every 30 min | shares the GT queue |
| RugCheck `tokens/{mint}/report/summary` | Safety flags; cached 30 min | — |

All GeckoTerminal calls go through one queue: 12 s apart, 30 s after a blocked call (its public API returns 429s well below the documented 30/min). Candles and RugCheck are fetched a few coins per cycle, so the list fills in over the first few minutes.

## Score (0–100)

| Part | Max | Meaning |
|---|---|---|
| Off the top | 20 | Drawdown from ATH: counts from −50%, full at −70% to −92%, fades to 0 past −97% |
| Floor holding | 25 | Within ~35% of the floor, floor ≥ ~12h old, retested, 6h not bleeding |
| Sellers exhausted | 20 | Buys ≥ sells over 6h and 1h; 12h range tighter than the 36h before |
| Waking up | 25 | 6h hourly volume vs the day before, 1h vs 6h pace, 5m buyers, early lift |
| Liquidity health | 10 | Liquidity at 8–50% of MCap, plus dollar depth |

**Penalties:** already 2×+ off the low, still making new lows, +50% in 1h, sellers in control, liquidity pulled >15% in 15 min, 1h volume >10× liquidity, no socials, RugCheck warnings.

**Tags:** `BOTTOMED`, `BASE`, `WAKING`, `BREAKOUT`, `FALLING`, `BOUNCED`, `SAFE`, `UNCHECKED`, `RISKY`.

The **Compact** view (default) shows MCap with price underneath and drawdown from ATH with distance above the floor. The ⚡ Signals strip shows MCap when the signal fired → MCap now.

The scoring lives in `scoring.js` as pure functions, so it's easy to tune.

## Run locally

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

(ES modules need to be served over http, not opened as `file://`.)

## Disclaimer

"Safe" only means the known rug signals are absent. A bottomed memecoin can still go to zero, and devs or whales can still dump. The score is a filter for what deserves a manual look, not a prediction. Not financial advice.
