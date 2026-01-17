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
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/* ---------- SAFE Alpha Vantage ---------- */
async function getAVDailyAdjusted(ticker) {
  if (!AV_KEY) return [];

  const url =
    `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${ticker}&outputsize=full&apikey=${AV_KEY}`;

  const j = await fetchJson(url);

  if (j.Note || j.Information || j["Error Message"]) {
    console.warn("AlphaVantage throttled:", ticker);
    return [];
  }

  const ts = j["Time Series (Daily)"];
  if (!ts) return [];

  return Object.entries(ts)
    .map(([date, o]) => ({ date, close: Number(o["4. close"]) }))
    .filter(r => Number.isFinite(r.close))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function buildWindows(rows) {
  const closes = rows.map(r => r.close);
  const take = n => closes.slice(-n);

  return {
    "1m": take(22),
    "6m": take(132),
    "1y": take(264)
  };
}

function computeOneYearReturn(rows) {
  if (rows.length < 260) return 0;
  const last = rows.at(-1).close;
  const prior = rows.at(-253).close;
  return ((last - prior) / prior) * 100;
}

/* ---------- Optional APIs ---------- */
async function getFinnhubProfile(ticker) {
  if (!FINN_KEY) return null;
  return fetchJson(
    `https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${FINN_KEY}`
  );
}

async function getNews(ticker, name) {
  if (!NEWS_KEY) return [];
  const q = encodeURIComponent(name || ticker);
  const j = await fetchJson(
    `https://newsapi.org/v2/everything?q=${q}&pageSize=3&sortBy=publishedAt&apiKey=${NEWS_KEY}`
  );
  return (j.articles || []).slice(0, 3).map(a => ({
    headline: a.title || "",
    source: a.source?.name || "",
    when: (a.publishedAt || "").slice(0, 10),
    url: a.url || ""
  }));
}

async function cacheLogo(ticker, profile) {
  const logo = profile?.logo;
  if (!logo) return;

  const out = `assets/logos/${ticker}.png`;
  if (fs.existsSync(out)) return;

  const buf = await fetchBuffer(logo);
  fs.mkdirSync("assets/logos", { recursive: true });
  fs.writeFileSync(out, buf);
}

/* ---------- MAIN ---------- */
async function main() {
  const stocks = readJson("data/stocks.json");
  const dailyPath = "data/daily.json";
  const daily = fs.existsSync(dailyPath) ? readJson(dailyPath) : {};

  const today = todayKeyUTC();
  const index = Math.floor(Date.now() / 86400000) % stocks.length;
  const ticker = daily[today] || stocks[index].ticker;
  const stock = stocks.find(s => s.ticker === ticker);

  const rows = await getAVDailyAdjusted(ticker);

  const windows = rows.length
    ? buildWindows(rows)
    : { "1m": [100], "6m": [100], "1y": [100] };

  const lastClose = rows.length ? rows.at(-1).close : 0;
  const oneYearReturn = rows.length ? computeOneYearReturn(rows) : 0;

  const profile = await getFinnhubProfile(ticker);
  await cacheLogo(ticker, profile);

  const news = await getNews(ticker, stock.name);

  writeJson(`data/snapshots/${ticker}.json`, {
    ...windows,
    lastClose,
    oneYearReturn,
    insight: `Tracking ${stock.name} (${ticker})`,
    topNews: news
  });

  daily[today] = ticker;
  writeJson(dailyPath, daily);

  console.log("Updated:", ticker);
}

main().catch(e => {
  console.error(e);
  process.exit(0); // NEVER fail the workflow
});