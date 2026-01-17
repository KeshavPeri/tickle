import fs from "node:fs";
import path from "node:path";

const FINN_KEY = process.env.FINNHUB_KEY || "";
const NEWS_KEY = process.env.NEWSAPI_KEY || "";

// ---------- utils ----------
function readJson(p){ return JSON.parse(fs.readFileSync(p, "utf8")); }
function writeJson(p, obj){
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
function todayKeyUTC(){ return new Date().toISOString().slice(0,10); }

async function fetchText(url){
  const res = await fetch(url, { headers: { "User-Agent": "tickle-bot" }});
  if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}
async function fetchJson(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}
async function fetchBuffer(url){
  const res = await fetch(url);
  if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function last(arr){ return arr && arr.length ? arr[arr.length - 1] : 0; }
function calcReturn(first, lastv){
  if(!first) return 0;
  return ((lastv - first) / first) * 100;
}

// ---------- Stooq daily closes (FREE) ----------
// Stooq uses lowercase tickers and often needs ".us" suffix for US stocks.
async function getStooqDailyCloses(ticker){
  // Try a couple of common symbol formats
  const candidates = [
    `${ticker.toLowerCase()}.us`,
    ticker.toLowerCase()
  ];

  let csv = "";
  let used = "";
  for(const sym of candidates){
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=d`;
    try {
      csv = await fetchText(url);
      used = sym;
      if (csv && csv.includes("Date,Open,High,Low,Close")) break;
    } catch {}
  }

  if(!csv || !csv.includes("Date,Open,High,Low,Close")){
    throw new Error(`Stooq: no CSV header for ${ticker}`);
  }

  // Parse CSV (Date,Open,High,Low,Close,Volume)
  const lines = csv.trim().split("\n");
  if(lines.length < 5) throw new Error(`Stooq: too few rows for ${ticker}`);

  const closes = [];
  for(let i=1;i<lines.length;i++){
    const cols = lines[i].split(",");
    const close = Number(cols[4]);
    if(Number.isFinite(close) && close > 0) closes.push(close);
  }

  if(closes.length < 10) throw new Error(`Stooq: too few close values for ${ticker}`);

  return { closes, symbolUsed: used };
}

// ---------- Finnhub profile (optional for logo) ----------
async function getFinnhubProfile(ticker){
  if(!FINN_KEY) return null;
  try{
    const j = await fetchJson(
      `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${FINN_KEY}`
    );
    if(j && typeof j === "object" && Object.keys(j).length) return j;
    return null;
  }catch{
    return null;
  }
}

// ---------- News (optional) ----------
async function getNews(ticker, companyName){
  if(!NEWS_KEY) return [];
  try{
    const q = encodeURIComponent(companyName || ticker);
    const j = await fetchJson(
      `https://newsapi.org/v2/everything?q=${q}&pageSize=3&sortBy=publishedAt&apiKey=${NEWS_KEY}`
    );
    const arts = Array.isArray(j.articles) ? j.articles : [];
    return arts.slice(0,3).map(a => ({
      headline: a.title || "",
      source: a.source?.name || "",
      when: (a.publishedAt || "").slice(0,10),
      url: a.url || ""
    }));
  }catch{
    return [];
  }
}

// ---------- Logo caching (Finnhub logo -> favicon fallback) ----------
async function cacheLogo(ticker, profile, stock){
  const outPath = path.join("assets","logos",`${ticker}.png`);
  if(fs.existsSync(outPath)) return;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // 1) Finnhub logo
  const logoUrl = profile?.logo;
  if(logoUrl){
    try{
      const buf = await fetchBuffer(logoUrl);
      fs.writeFileSync(outPath, buf);
      return;
    }catch{}
  }

  // 2) Domain favicon fallback (keyless)
  const domain = stock?.domain;
  if(domain){
    try{
      const favUrl = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`;
      const buf = await fetchBuffer(favUrl);
      fs.writeFileSync(outPath, buf);
      return;
    }catch{}
  }
}

// ---------- build windows ----------
function sliceLastN(arr, n){
  if(arr.length <= n) return arr.slice();
  return arr.slice(arr.length - n);
}

function buildWindowsFromCloses(closes){
  // Approx trading-day counts
  const w1m = sliceLastN(closes, 22);
  const w6m = sliceLastN(closes, 132);
  const w1y = sliceLastN(closes, 264);
  return { w1m, w6m, w1y };
}

// ---------- main ----------
async function main(){
  const stocks = readJson("data/stocks.json");
  if(!Array.isArray(stocks) || stocks.length === 0) throw new Error("data/stocks.json empty/invalid");

  const dailyPath = "data/daily.json";
  const daily = fs.existsSync(dailyPath) ? readJson(dailyPath) : {};

  const today = todayKeyUTC();

  // deterministic daily rotation
  const dayIndex = Math.floor(Date.now()/86400000);
  const fallbackTicker = stocks[dayIndex % stocks.length].ticker;

  const ticker = daily[today] || fallbackTicker;
  const stock = stocks.find(s => s.ticker === ticker) || stocks[0];

  // ----- REAL DATA: Stooq -----
  const { closes, symbolUsed } = await getStooqDailyCloses(ticker);
  const { w1m, w6m, w1y } = buildWindowsFromCloses(closes);

  const lastClose = last(w1y) || last(w6m) || last(w1m) || 0;
  const oneYearReturn = w1y.length >= 2 ? calcReturn(w1y[0], last(w1y)) : 0;

  // optional logo (Finnhub) + fallback favicon
  const profile = await getFinnhubProfile(ticker);
  await cacheLogo(ticker, profile, stock);

  const news = await getNews(ticker, stock.name);

  const snap = {
    source: "stooq",
    normalized: false,
    symbolUsed,
    "1m": w1m,
    "6m": w6m,
    "1y": w1y,
    lastClose,
    oneYearReturn,
    topNews: news,
    insight: `Tracking ${stock.name} (${ticker}).`
  };

  writeJson(`data/snapshots/${ticker}.json`, snap);

  daily[today] = ticker;
  writeJson(dailyPath, daily);

  console.log(`Updated ${today} -> ${ticker} | source=stooq (${symbolUsed}) | 1m=${w1m.length} 6m=${w6m.length} 1y=${w1y.length}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
