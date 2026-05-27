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

async function fetchJson(url, opts = {}){
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; tickle-bot/1.0)",
      "Accept": "application/json",
      ...opts.headers,
    },
    ...opts,
  });
  if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}
async function fetchBuffer(url){
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; tickle-bot/1.0)" }
  });
  if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function last(arr){ return arr && arr.length ? arr[arr.length - 1] : 0; }
function calcReturn(first, lastv){
  if(!first) return 0;
  return ((lastv - first) / first) * 100;
}

// ---------- Yahoo Finance daily closes (FREE, no key) ----------
// Replaces Stooq which blocks GitHub Actions IP ranges entirely.
async function getYahooFinanceCloses(ticker){
  // Yahoo uses hyphens for dots: BRK.B -> BRK-B
  const sym = ticker.replace(/\./g, "-");
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1y&includePrePost=false`;

  const data = await fetchJson(url);
  const result = data?.chart?.result?.[0];
  if(!result) throw new Error(`Yahoo Finance: no result for ${ticker}`);

  const rawCloses = result.indicators?.quote?.[0]?.close ?? [];
  // Filter out null/NaN values Yahoo sometimes returns for non-trading days
  const closes = rawCloses.map(Number).filter(v => Number.isFinite(v) && v > 0);

  if(closes.length < 10) throw new Error(`Yahoo Finance: too few closes for ${ticker} (got ${closes.length})`);

  // Extract market cap from meta
  const marketCap = result.meta?.marketCap ?? null;

  return { closes, marketCap };
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

// ---------- Logo caching ----------
async function cacheLogo(ticker, profile, stock){
  const outPath = path.join("assets","logos",`${ticker}.png`);
  if(fs.existsSync(outPath)) return;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // 1) Finnhub logo (needs FINNHUB_KEY)
  const logoUrl = profile?.logo;
  if(logoUrl){
    try{
      const buf = await fetchBuffer(logoUrl);
      fs.writeFileSync(outPath, buf);
      return;
    }catch{}
  }

  // 2) Domain favicon via Google (keyless)
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

  console.log(`Fetching data for ${today} -> ${ticker} (${stock.name})`);

  // ----- REAL DATA: Yahoo Finance -----
  const { closes, marketCap } = await getYahooFinanceCloses(ticker);
  const { w1m, w6m, w1y } = buildWindowsFromCloses(closes);

  const lastClose = last(w1y) || last(w6m) || last(w1m) || 0;
  const oneYearReturn = w1y.length >= 2 ? calcReturn(w1y[0], last(w1y)) : 0;

  // optional logo (Finnhub) + fallback favicon
  const profile = await getFinnhubProfile(ticker);
  await cacheLogo(ticker, profile, stock);

  const news = await getNews(ticker, stock.name);

  const snap = {
    builtAt: new Date().toISOString(),
    builtDateUTC: today,
    source: "yahoo-finance",
    "1m": w1m,
    "6m": w6m,
    "1y": w1y,
    lastClose,
    oneYearReturn,
    marketCap,
    topNews: news,
    insight: `Tracking ${stock.name} (${ticker}).`
  };

  writeJson(`data/snapshots/${ticker}.json`, snap);

  daily[today] = ticker;
  writeJson(dailyPath, daily);

  console.log(`✅ Updated ${today} -> ${ticker} | source=yahoo-finance | 1m=${w1m.length} 6m=${w6m.length} 1y=${w1y.length} | lastClose=${lastClose.toFixed(2)} | mktCap=${marketCap ? (marketCap/1e9).toFixed(1)+"B" : "n/a"}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
