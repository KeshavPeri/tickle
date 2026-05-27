import fs from "node:fs";
import path from "node:path";

const FINN_KEY = process.env.FINNHUB_KEY || "";

function readJson(p){ return JSON.parse(fs.readFileSync(p, "utf8")); }
function writeJson(p, obj){
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

async function fetchJson(url){
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; tickle-bot/1.0)",
      "Accept": "application/json",
    }
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
function calcReturn(first, lastv){ return first ? ((lastv-first)/first)*100 : 0; }
function sliceLastN(arr, n){ return arr.length <= n ? arr.slice() : arr.slice(arr.length - n); }
function todayKeyUTC(){ return new Date().toISOString().slice(0,10); }

// ---------- Yahoo Finance daily closes (FREE, no key) ----------
// Stooq was blocking GitHub Actions IP ranges entirely — switched to Yahoo Finance.
async function getYahooFinanceCloses(ticker){
  const sym = ticker.replace(/\./g, "-");
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1y&includePrePost=false`;

  const data = await fetchJson(url);
  const result = data?.chart?.result?.[0];
  if(!result) throw new Error(`Yahoo Finance: no result for ${ticker}`);

  const rawCloses = result.indicators?.quote?.[0]?.close ?? [];
  const closes = rawCloses.map(Number).filter(v => Number.isFinite(v) && v > 0);

  if(closes.length < 50) throw new Error(`Yahoo Finance: too few closes for ${ticker} (got ${closes.length})`);

  const marketCap = result.meta?.marketCap ?? null;

  return { closes, marketCap };
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

  // 1) Finnhub logo
  const logoUrl = profile?.logo;
  if(logoUrl){
    try{
      const buf = await fetchBuffer(logoUrl);
      fs.writeFileSync(outPath, buf);
      return;
    }catch{}
  }

  // 2) Google favicon fallback (keyless, needs domain)
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

// Freshness check: skip if snapshot was built today
function snapshotIsFreshByBuiltDate(p){
  if(!fs.existsSync(p)) return false;
  try{
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return j?.builtDateUTC === todayKeyUTC();
  }catch{
    return false;
  }
}

async function buildOne(stock){
  const ticker = stock.ticker;
  const snapPath = `data/snapshots/${ticker}.json`;

  if(snapshotIsFreshByBuiltDate(snapPath)) return { ticker, skipped: true };

  const { closes, marketCap } = await getYahooFinanceCloses(ticker);
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
    source: "yahoo-finance",
    "1m": w1m,
    "6m": w6m,
    "1y": w1y,
    lastClose,
    oneYearReturn,
    marketCap,
    topNews: [],
    insight: `Tracking ${stock.name} (${ticker}).`
  };

  writeJson(snapPath, snap);
  return { ticker, skipped: false };
}

async function main(){
  const stocks = readJson("data/stocks.json");
  if(!Array.isArray(stocks) || stocks.length === 0) throw new Error("stocks.json empty");

  const concurrency = 4; // Slightly lower to be gentle on Yahoo Finance rate limits
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
        process.stdout.write(`\rBuilt: ${done}/${stocks.length} | skipped: ${skipped} | failed: ${failed}   `);
      }catch(e){
        failed++;
        process.stdout.write(`\n❌ ${s.ticker}: ${e.message}\n`);
      }
    }
  }

  await Promise.all(Array.from({length: concurrency}, () => worker()));
  process.stdout.write(`\n✅ Batch complete. total=${stocks.length} done=${done} skipped=${skipped} failed=${failed}\n`);

  // Only fail CI if more than 40% of stocks couldn't be fetched — a few failures
  // are expected (delistings, ticker changes, etc.) and shouldn't block the push.
  const failRate = failed / stocks.length;
  if(failRate > 0.40){
    console.error(`❌ Too many failures: ${failed}/${stocks.length} (${(failRate*100).toFixed(0)}%). Aborting.`);
    process.exit(1);
  }

  if(failed > 0){
    console.warn(`⚠️  ${failed} stock(s) failed but under threshold — partial refresh committed.`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
