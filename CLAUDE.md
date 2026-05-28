# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

TICKle is a daily Wordle-style stock guessing game hosted as a static site on GitHub Pages. Players guess a mystery stock ticker from its price chart and incremental clues (sector, industry, price, return, dividend). No build step, no framework, no npm.

## Development commands

**Serve locally**
```bash
python3 -m http.server 8080
# open http://localhost:8080
```

**Data pipeline scripts** (Node 20+, run from repo root)
```bash
# Refresh today's snapshot + advance daily.json
FINNHUB_KEY=<optional> node scripts/update_daily.mjs

# Rebuild all ~400 snapshots (concurrency=4, skips fresh ones)
FINNHUB_KEY=<optional> node scripts/batch_build.mjs

# Validate snapshot coverage and shape — exits 1 on missing snapshots
node scripts/validate_data.mjs

# One-time: scrape Wikipedia S&P 500 table to rebuild stocks.json
node scripts/build_stocks_universe_once.mjs
```

`FINNHUB_KEY` is optional — used only for company logos. Yahoo Finance (no key) is the price data source. Google News RSS (no key) is the news source.

## Architecture

### Frontend (no build step)
The entire UI is `index.html` + `app.js` + `styles.css`. There are no modules, no bundler, no dependencies.

`app.js` is one flat script that runs `init()` on load:
1. Fetches `data/stocks.json` (universe) and `data/daily.json` (date→ticker map)
2. Resolves today's ticker via `todayKey()` (UTC date string)
3. Fetches `data/snapshots/<TICKER>.json` for the answer and each guess
4. Renders the chart, clues, hints, and guess history via DOM manipulation

### Data flow
```
data/daily.json          — { "2026-01-06": "AAPL", ... }  (puzzle schedule)
data/stocks.json         — [{ ticker, name, sector, industry, dividend, tier }, ...]
data/snapshots/<T>.json  — { "1m": number[], "6m": number[], "1y": number[],
                              lastClose, oneYearReturn, marketCap,
                              topNews: [{headline, source, when, url}] }
assets/logos/<T>.png     — cached company logos
```

Snapshots are the only data fetched at game time (beyond the two JSON indexes). The pipeline scripts write them; the frontend reads them.

### Theming
The dark/light toggle adds/removes the `light` class on `<html>`. All colours are CSS custom properties defined on `:root` (dark) and overridden on `html.light`. The preference is stored in `localStorage` under `tickle-theme` and restored by an inline `<script>` in `<head>` before first paint to prevent flash.

The canvas chart reads `--chart-bg`, `--chart-grid`, and `--chart-line` via `getComputedStyle(document.documentElement)` so it repaints correctly on theme switch.

### CI automation
Two GitHub Actions workflows run nightly:
- `daily-update.yml` (01:10 UTC) — runs `update_daily.mjs` for just today's ticker, commits snapshot + `daily.json`
- `batch-build.yml` (01:30 UTC) — runs `batch_build.mjs` for all tickers, skipping ones already built today

### Key helpers in app.js
- `$(id)` — `document.getElementById` shorthand
- `esc(s)` — HTML-escape any external/user data before inserting via `innerHTML`
- `isSafeUrl(u)` — validates `http:`/`https:` before using a URL as an `href`
- `normTf(x)` — normalises timeframe strings (`"1M"`, `"6mo"`, etc.) to `"1m"` / `"6m"` / `"1y"`
- `todayKey()` — returns UTC date string `YYYY-MM-DD`; must match the pipeline's `todayKeyUTC()`

### Clue comparison logic
`compareNum(guess, answer)` returns a badge class (`good` / `yellow` / `orange` / `bad`) based on % difference thresholds (≤5% / ≤12% / ≤25%). `compareCat` does exact string match for categorical fields (sector, industry, dividend).
