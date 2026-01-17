import fs from "node:fs";
import path from "node:path";

const FINN_KEY = process.env.FINNHUB_KEY || "";
const NEWS_KEY = process.env.NEWSAPI_KEY || "";

// ---------- utils ----------
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

// ---------- deterministic wiggly fallback (only if Finnhub fails) ----------
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function randomWalkSeries(seedStr, n, start = 100) {
  const rand = mulberry32(hashStr(seedStr));
  const out = [start];
  let v = start;
  for (let i = 1; i < n; i++) {
    // daily-ish moves, with occasional bigger moves
    const shock = (rand() - 0.5) * 2;              // [-1,1]
    const vol = rand() < 0.07 ? 2.8 : 1.1;         // rare jumps
    const drift = (rand() - 0.48) * 0.12;          // slight drift
    const stepPct = drift + shock * 0.8 * vol;     // percent-ish
    v = Math.max(1, v * (1 + stepPct / 100));
    out.push(Number(v.toFixed(2)));
  }
  return out;
}

// ---------- Finnhub: candles ----------
async function getFinnhubDailyCloses(ticker, fromSec, toSec) {
  if (!FINN_KEY) throw new Error("Missing FINNHUB_KEY");

  const url =
    `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(ticker)}` +
    `&resolution=D&from=${fromSec}&to=${toSec}&token=${FINN_KEY}`;

  const j = await fetchJson(url);

  // Finnhub returns s: "ok" or s: "no_data"
  if (!j || j.s !== "ok" || !Array.isArray(j.c) || j.c.length < 2) {
    throw new Error(`Finnhub candle no_data for ${ticker}`);
  }

  // closes are j.c
  return j.c.map(Number).filter(v => Number.isFinite(v));
}

// ---------- Finnhub: profile (optional for logo) ----------
async function getFinnhubProfile(ticker) {
  if (!FINN_KEY) return null;
  try {
    const j = await fetchJson(
      `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${FINN_KEY}`
    );
    if (j && typeof j === "object" && Object.keys(j).length) return j;
    return null;
  } catch {
    return null;
  }
}

// ---------- News (optional) ----------
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
  } catch {
    return [];
  }
}

// ---------- Logo caching (Finnhub logo -> favicon fallback) ----------
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
    } catch {}
  }

  // 2) Domain favicon fallback (keyless)
  const domain = stock?.domain;
  if (domain) {
    try {
      const favUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
      const buf = await fetchBuffer(favUrl);
      fs.writeFileSync(outPath, buf);
      return;
    } catch {}
  }
}

// ---------- helpers ----------
function last(arr) {
  return arr && arr.length ? arr[arr.length - 1] : 0;
}
function calcOneYearReturn(series) {
  // series is daily closes for ~1y (trading days might be < 365, but ok)
  if (!series || series.length < 10) return 0;
  const a = series[0];
  const b = last(series);
  if (!a) return 0;
  return ((b - a) / a) * 100;
}

// ---------- main ----------
async function main() {
  const stocks = readJson("data/stocks.json");
  if (!Array.isArray(stocks) || stocks.length === 0) {
    throw new Error("data/stocks.json is empty or invalid");
  }

  const dailyPath = "data/daily.json";
  const daily = fs.existsSync(dailyPath) ? readJson(dailyPath) : {};

  const today = todayKeyUTC();

  // Deterministic rotation (same for everyone)
  const dayIndex = Math.floor(Date.now() / 86400000);
  const fallbackTicker = stocks[dayIndex % stocks.length].ticker;

  const ticker = daily[today] || fallbackTicker;
  const stock = stocks.find(s => s.ticker === ticker) || stocks[0];

  // Time windows (UTC seconds)
  const nowSec = Math.floor(Date.now() / 1000);
  const oneDay = 86400;

  // Using calendar days is fine for a game; Finnhub returns trading-day candles.
  const from1m = nowSec - oneDay * 40;    // ~1 month trading + buffer
  const from6m = nowSec - oneDay * 220;   // ~6 months trading + buffer
  const from1y = nowSec - oneDay * 430;   // ~1 year trading + buffer

  let s1m = [];
  let s6m = [];
  let s1y = [];

  try {
    s1m = await getFinnhubDailyCloses(ticker, from1m, nowSec);
    s6m = await getFinnhubDailyCloses(ticker, from6m, nowSec);
    s1y = await getFinnhubDailyCloses(ticker, from1y, nowSec);
  } catch (e) {
    // Fallback only if Finnhub fails — wiggly, not linear
    const seedBase = `${ticker}-${today}`;
    s1m = randomWalkSeries(`${seedBase}-1m`, 22, 100);
    s6m = randomWalkSeries(`${seedBase}-6m`, 132, 100);
    s1y = randomWalkSeries(`${seedBase}-1y`, 264, 100);
  }

  const lastClose = last(s1y) || last(s6m) || last(s1m) || 0;
  const oneYearReturn = calcOneYearReturn(s1y);

  const profile = await getFinnhubProfile(ticker);
  await cacheLogo(ticker, profile, stock);

  const news = await getNews(ticker, stock.name);

  const snap = {
    "1m": s1m,
    "6m": s6m,
    "1y": s1y,
    lastClose,
    oneYearReturn,
    topNews: news,
    insight: `Tracking ${stock.name} (${ticker}).`
  };

  writeJson(`data/snapshots/${ticker}.json`, snap);

  daily[today] = ticker;
  writeJson(dailyPath, daily);

  console.log(`Updated ${today} -> ${ticker} | closes: 1m=${s1m.length} 6m=${s6m.length} 1y=${s1y.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
