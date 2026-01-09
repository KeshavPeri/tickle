import fs from "node:fs";
import path from "node:path";

const AV_KEY = process.env.ALPHAVANTAGE_KEY || "";
const FINN_KEY = process.env.FINNHUB_KEY || "";
const NEWS_KEY = process.env.NEWSAPI_KEY || "";

function readJson(p){ return JSON.parse(fs.readFileSync(p, "utf8")); }
function writeJson(p, obj){
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
function todayKeyUTC(){
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth()+1).padStart(2,"0");
  const dd = String(d.getUTCDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}
async function fetchJson(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}
async function fetchBuffer(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

function pickTicker(stocks, dailyObj, key){
  if (dailyObj[key]) return dailyObj[key];
  const dayIndex = Math.floor(Date.now() / 86400000);
  return stocks[dayIndex % stocks.length].ticker;
}

function buildWindows(closes){
  const vals = closes.map(x => x.close);
  const takeLast = (n) => vals.slice(Math.max(0, vals.length - n));
  return {
    "1m": takeLast(22),
    "6m": takeLast(132),
    "1y": takeLast(264),
  };
}

async function getAVDailyAdjusted(ticker){
  if(!AV_KEY) throw new Error("Missing ALPHAVANTAGE_KEY");
  const url =
    `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(ticker)}&outputsize=full&apikey=${AV_KEY}`;
  const j = await fetchJson(url);

  const ts = j["Time Series (Daily)"];
  if(!ts) throw new Error(`AlphaVantage missing time series for ${ticker}`);

  return Object.entries(ts)
    .map(([date, o]) => ({ date, close: Number(o["4. close"]) }))
    .filter(r => Number.isFinite(r.close))
    .sort((a,b) => a.date.localeCompare(b.date));
}

async function getFinnhubProfile(ticker){
  if(!FINN_KEY) return null;
  const url =
    `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${FINN_KEY}`;
  const j = await fetchJson(url);
  return j && Object.keys(j).length ? j : null;
}

async function getNews(ticker, companyName){
  if(!NEWS_KEY) return [];
  const q = encodeURIComponent(companyName || ticker);
  const url = `https://newsapi.org/v2/everything?q=${q}&pageSize=3&sortBy=publishedAt&apiKey=${NEWS_KEY}`;
  const j = await fetchJson(url);
  const arts = Array.isArray(j.articles) ? j.articles : [];
  return arts.slice(0,3).map(a => ({
    headline: a.title || "",
    source: a.source?.name || "",
    when: (a.publishedAt || "").slice(0,10),
    url: a.url || ""
  }));
}

async function cacheLogo(ticker, profile){
  const logoUrl = profile?.logo;
  if(!logoUrl) return;

  const outPath = path.join("assets", "logos", `${ticker}.png`);
  if (fs.existsSync(outPath)) return;

  const buf = await fetchBuffer(logoUrl);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buf);
}

function computeOneYearReturn(rows){
  if(rows.length < 260) return 0;
  const last = rows[rows.length - 1].close;
  const prior = rows[rows.length - 253].close;
  if(!prior) return 0;
  return ((last - prior) / prior) * 100;
}

async function main(){
  const stocks = readJson("data/stocks.json");
  const dailyPath = "data/daily.json";
  const daily = fs.existsSync(dailyPath) ? readJson(dailyPath) : {};

  const key = todayKeyUTC();
  const ticker = pickTicker(stocks, daily, key);
  const stock = stocks.find(s => s.ticker === ticker) || stocks[0];

  const rows = await getAVDailyAdjusted(ticker);
  const windows = buildWindows(rows);
  const lastClose = rows[rows.length - 1]?.close ?? 0;
  const oneYearReturn = computeOneYearReturn(rows);

  const profile = await getFinnhubProfile(ticker);
  await cacheLogo(ticker, profile);

  const news = await getNews(ticker, stock.name);

  const snap = {
    ...windows,
    lastClose,
    oneYearReturn,
    topNews: news.map(n => ({ headline: n.headline, source: n.source, when: n.when, url: n.url })),
    insight: `Tracking ${stock.name} (${ticker}).`,
  };
  writeJson(`data/snapshots/${ticker}.json`, snap);

  daily[key] = ticker;
  writeJson(dailyPath, daily);

  console.log(`Updated ${key} -> ${ticker}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
