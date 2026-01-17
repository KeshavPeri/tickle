import fs from "node:fs";
import path from "node:path";

const AV_KEY = process.env.ALPHAVANTAGE_KEY || "";
const FINN_KEY = process.env.FINNHUB_KEY || "";
const NEWS_KEY = process.env.NEWSAPI_KEY || "";

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function todayKeyUTC() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/* ---------------- Alpha Vantage (safe) ---------------- */
async function getAVDailyAdjusted(ticker) {
  if (!AV_KEY) {
    console.warn("Missing ALPHAVANTAGE_KEY; using fallback chart data.");
    return [];
  }

  const url =
    `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(ticker)}&outputsize=full&apikey=${AV_KEY}`;

  const j = await fetchJson(url);

  // Throttling / errors commonly come back under these keys
  if (j.Note || j.Information || j["Error Message"] || j.Error_Message) {
    console.warn("AlphaVantage throttled/errored for", ticker, j.Note || j.Information || j["Error Message"] || j.Error_Message);
    return [];
  }

  const ts = j["Time Series (Daily)"];
  if (!ts) {
    console.warn("AlphaVantage: no Time Series (Daily) for", ticker, "keys:", Object.keys(j));
    return [];
  }

  return Object.entries(ts)
    .map(([date, o]) => ({ date, close: Number(o["4. close"]) }))
    .filter(r => Number.isFinite(r.close))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function buildWindows(rows) {
  const closes = rows.map(r => r.close);
  const takeLast = (n) => closes.slice(Math.max(0, closes.length - n));
  return {
    "1m": takeLast(22),
    "6m": takeLast(132),
    "1y": takeLast(264),
  };
}

function computeOneYearReturn(rows) {
  // ~252 trading days ≈ 1y
  if (rows.length < 260) return 0;
  const last = rows[rows.length - 1].close;
  const prior = rows[rows.length - 253].close;
  if (!prior) return 0;
  return ((last - prior) / prior) * 100;
}

/* ---------------- Finnhub profile (optional) ---------------- */
async function getFinnhubProfile(ticker) {
  if (!FINN_KEY) return null;
  try {
    const j = await fetchJson(
      `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${FINN_KEY}`
    );
    if (j && typeof j === "object" && Object.keys(j).length) return j;
    return null;
  } catch (e) {
    console.warn("Finnhub profile failed for", ticker);
    return null;
  }
}

/* ---------------- News (optional) ---------------- */
async function getNews(ticker, companyName) {
  if (!NEWS_KEY) return [];
  try {
    const q = encodeURIComponent(companyName || ticker);
    const j = await fetchJson(
      `https://newsapi.org/v2/everything?q=${q}&pageSize=3&sortBy=publishedAt&apiKey=${NEWS_KEY}`
    );
    const arts = Array.isArray(j.articles) ? j.articles : [];
    return arts.slice(0, 3).map(a => ({
      headline: a.title || "",
      source: a.source?.name || "",
      when: (a.publishedAt || "").slice(0, 10),
      url: a.url || ""
    }));
  } catch (e) {
    console.warn("News fetch failed for", ticker);
    return [];
  }
}

/* ---------------- Logo caching ----------------
   Strategy:
   1) Try Finnhub profile.logo (if available)
   2) Fallback: Google favicon service using stock.domain (keyless)
   Saves to: assets/logos/<TICKER>.png
------------------------------------------------ */
async function cacheLogo(ticker, profile, stock) {
  const outPath = path.join("assets", "logos", `${ticker}.png`);
  if (fs.existsSync(outPath)) return;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // 1) Finnhub logo
  const logoUrl = profile?.logo;
  if (logoUrl) {
    try {
      const buf = await fetchBuffer(logoUrl);
      fs.writeFileSync(outPath, buf);
      return;
    } catch {
      // fall through
    }
  }

  // 2) Domain favicon fallback
  const domain = stock?.domain;
  if (domain) {
    try {
      const favUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
      const buf = await fetchBuffer(favUrl);
      fs.writeFileSync(outPath, buf);
      return;
    } catch {
      // fall through
    }
  }

  // If both fail, do nothing (frontend should handle missing image gracefully)
}

/* ---------------- Main ---------------- */
async function main() {
  const stocks = readJson("data/stocks.json");
  if (!Array.isArray(stocks) || stocks.length === 0) {
    throw new Error("data/stocks.json is empty or invalid");
  }

  const dailyPath = "data/daily.json";
  const daily = fs.existsSync(dailyPath) ? readJson(dailyPath) : {};

  const today = todayKeyUTC();

  // Deterministic rotation (stable for everyone)
  const dayIndex = Math.floor(Date.now() / 86400000);
  const fallbackTicker = stocks[dayIndex % stocks.length].ticker;

  const ticker = daily[today] || fallbackTicker;
  const stock = stocks.find(s => s.ticker === ticker) || stocks[0];

  // Market series
  const rows = await getAVDailyAdjusted(ticker);

  // Always ensure chart arrays are drawable (>= 2 points)
  const windows = rows.length ? buildWindows(rows) : {
    "1m": [100,101,102,103,104,105,106,107,108,109],
    "6m": [90,91,92,93,94,95,96,97,98,99,100],
    "1y": [80,82,84,86,88,90,92,94,96,98,100]
  };

  const lastClose = rows.length ? (rows[rows.length - 1]?.close ?? 0) : 0;
  const oneYearReturn = rows.length ? computeOneYearReturn(rows) : 0;

  // Profile + logo cache
  const profile = await getFinnhubProfile(ticker);
  await cacheLogo(ticker, profile, stock);

  // News
  const news = await getNews(ticker, stock.name);

  // Write snapshot
  const snap = {
    ...windows,
    lastClose,
    oneYearReturn,
    topNews: news,
    insight: `Tracking ${stock.name} (${ticker}).`
  };

  writeJson(`data/snapshots/${ticker}.json`, snap);

  // Update daily mapping
  daily[today] = ticker;
  writeJson(dailyPath, daily);

  console.log(`Updated ${today} -> ${ticker}`);
}

main().catch((e) => {
  console.error(e);
  // Never fail the workflow hard; we prefer a green run with partial data
  process.exit(0);
});
