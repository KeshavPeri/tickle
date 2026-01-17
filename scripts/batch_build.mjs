import fs from "node:fs";
import path from "node:path";

const FINN_KEY = process.env.FINNHUB_KEY || "";

function readJson(p){ return JSON.parse(fs.readFileSync(p, "utf8")); }
function writeJson(p, obj){
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
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
function calcReturn(first, lastv){ return first ? ((lastv-first)/first)*100 : 0; }
function sliceLastN(arr, n){ return arr.length <= n ? arr.slice() : arr.slice(arr.length - n); }

function todayKeyUTC(){ return new Date().toISOString().slice(0,10); }

async function getStooqDailyCloses(ticker){
  const candidates = [`${ticker.toLowerCase()}.us`, ticker.toLowerCase()];
  let csv = "";
  let used = "";
  for(const sym of candidates){
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=d`;
    try{
      csv = await fetchText(url);
      used = sym;
      if (csv && csv.includes("Date,Open,High,Low,Close")) break;
    }catch{}
  }
  if(!csv || !csv.includes("Date,Open,High,Low,Close")){
    throw new Error(`Stooq: no CSV for ${ticker}`);
  }

  const lines = csv.trim().split("\n");
  if(lines.length < 5) throw new Error(`Stooq: too few rows for ${ticker}`);

  const closes = [];
  for(let i=1;i<lines.length;i++){
    const cols = lines[i].split(",");
    const c = Number(cols[4]);
    if(Number.isFinite(c) && c > 0) closes.push(c);
  }
  if(closes.length < 50) throw new Error(`Stooq: too few closes for ${ticker}`);
  return { closes, symbolUsed: used };
}

async function getFinnhubProfile(ticker){
  if(!FINN_KEY) return null;
  try{
    const j = await fetchJson(`https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker)}&token=${FINN_KEY}`);
    if(j && typeof j === "object" && Object.keys(j).length) return j;
    return null;
  }catch{
    return null;
  }
}

async function cacheLogo(ticker, profile, stock){
  const outPath = path.join("assets","logos",`${ticker}.png`);
  if(fs.existsSync(outPath)) return;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const logoUrl = profile?.logo;
  if(logoUrl){
    try{
      const buf = await fetchBuffer(logoUrl);
      fs.writeFileSync(outPath, buf);
      return;
    }catch{}
  }

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

// ✅ Freshness based on embedded snapshot date (not filesystem mtime)
function snapshotIsFreshByBuiltDate(p){
  if(!fs.existsSync(p)) return false;
  try{
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const builtDateUTC = j?.builtDateUTC;
    return builtDateUTC === todayKeyUTC();
  }catch{
    return false;
  }
}

async function buildOne(stock){
  const ticker = stock.ticker;
  const snapPath = `data/snapshots/${ticker}.json`;

  if(snapshotIsFreshByBuiltDate(snapPath)) return { ticker, skipped: true };

  const { closes, symbolUsed } = await getStooqDailyCloses(ticker);
  const w1m = sliceLastN(closes, 22);
  const w6m = sliceLastN(closes, 132);
  const w1y = sliceLastN(closes, 264);

  const lastClose = last(w1y) || last(w6m) || last(w1m) || 0;
  const oneYearReturn = w1y.length >= 2 ? calcReturn(w1y[0], last(w1y)) : 0;

  const profile = await getFinnhubProfile(ticker);
  await cacheLogo(ticker, profile, stock);

  const snap = {
    builtAt: new Date().toISOString(),
    builtDateUTC: todayKeyUTC(),
    source: "stooq",
    normalized: false,
    symbolUsed,
    "1m": w1m,
    "6m": w6m,
    "1y": w1y,
    lastClose,
    oneYearReturn,
    topNews: [],
    insight: `Tracking ${stock.name} (${ticker}).`
  };

  writeJson(snapPath, snap);
  return { ticker, skipped: false };
}

async function main(){
  const stocks = readJson("data/stocks.json");
  if(!Array.isArray(stocks) || stocks.length === 0) throw new Error("stocks.json empty");

  const concurrency = 6;
  let idx = 0;
  let done = 0;
  let skipped = 0;
  let failed = 0;

  async function worker(){
    while(idx < stocks.length){
      const i = idx++;
      const s = stocks[i];
      try{
        const r = await buildOne(s);
        done++;
        if(r.skipped) skipped++;
        process.stdout.write(`\rBuilt: ${done}/${stocks.length} | skipped: ${skipped} | failed: ${failed}`);
      }catch(e){
        failed++;
        process.stdout.write(`\n❌ ${s.ticker}: ${e.message}\n`);
      }
    }
  }

  await Promise.all(Array.from({length: concurrency}, () => worker()));
  process.stdout.write(`\n✅ Batch complete. total=${stocks.length} done=${done} skipped=${skipped} failed=${failed}\n`);

  if(failed > 0) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
