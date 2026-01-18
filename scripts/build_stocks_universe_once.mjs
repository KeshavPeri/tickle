import fs from "node:fs";
import path from "node:path";

function writeJson(p, obj){
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

async function fetchText(url){
  const res = await fetch(url, { headers: { "User-Agent": "tickle-bot" }});
  if(!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

function stripTags(s){
  return String(s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseFirstMatch(html, re){
  const m = html.match(re);
  return m ? m[1] : "";
}

function parseHtmlTableRows(tableHtml){
  const rows = [];
  const trMatches = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for(const tr of trMatches){
    const cells = tr.match(/<(td|th)[\s\S]*?<\/(td|th)>/gi) || [];
    const vals = cells.map(c => stripTags(c));
    if(vals.length) rows.push(vals);
  }
  return rows;
}

function normalizeTicker(t){
  // Keep only A–Z tickers for now (matches your current input rules)
  const raw = String(t || "").trim().toUpperCase();
  if(!raw) return "";
  if(!/^[A-Z]+$/.test(raw)) return "";
  return raw;
}

function classifyTier(stock, pinnedSet){
  const t = stock.ticker;
  if(pinnedSet.has(t)) return "A";

  const sector = (stock.sector || "").toLowerCase();
  const industry = (stock.industry || "").toLowerCase();
  const name = (stock.name || "").toLowerCase();

  const techLike =
    sector.includes("information technology") ||
    sector.includes("technology");

  const aiKeywords = [
    "semiconductor", "chip", "electronics",
    "software", "application software", "systems software",
    "cloud", "data", "analytics", "ai", "artificial",
    "cyber", "security", "network", "infrastructure"
  ];

  const hasKeyword = aiKeywords.some(k =>
    industry.includes(k) || name.includes(k)
  );

  // Tier B = tech/ai-ish companies
  if(techLike || hasKeyword) return "B";

  return "C";
}

function scoreForInclusion(stock){
  // Used only to rank within a tier to pick ~400.
  // Higher score = more likely included.
  const sector = (stock.sector || "").toLowerCase();
  const industry = (stock.industry || "").toLowerCase();

  let s = 0;

  // Bias towards tech/ai/data/cyber/semis
  if(sector.includes("technology")) s += 40;
  if(industry.includes("semiconductor")) s += 50;
  if(industry.includes("software")) s += 35;
  if(industry.includes("it services")) s += 25;
  if(industry.includes("internet")) s += 20;
  if(industry.includes("data")) s += 20;
  if(industry.includes("cyber") || industry.includes("security")) s += 30;
  if(industry.includes("cloud")) s += 25;

  // Keep finance / consumer / comms meaningful too
  if(sector.includes("communication")) s += 12;
  if(sector.includes("consumer")) s += 10;
  if(sector.includes("financial")) s += 8;

  return s;
}

async function main(){
  const url = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies";
  const html = await fetchText(url);

  const tableHtml = parseFirstMatch(html, /(<table[^>]*class="[^"]*wikitable[^"]*"[\s\S]*?<\/table>)/i);
  if(!tableHtml) throw new Error("Could not locate S&P 500 wikitable.");

  const rows = parseHtmlTableRows(tableHtml);
  if(rows.length < 10) throw new Error("Parsed too few rows.");

  const header = rows[0].map(h => h.toLowerCase());
  const idxSymbol = header.findIndex(x => x.includes("symbol"));
  const idxSecurity = header.findIndex(x => x.includes("security"));
  const idxSector = header.findIndex(x => x.includes("gics sector"));
  const idxIndustry = header.findIndex(x => x.includes("gics sub-industry"));

  if(idxSymbol < 0 || idxSecurity < 0 || idxSector < 0 || idxIndustry < 0){
    throw new Error("Unexpected table columns (Wikipedia layout changed).");
  }

  // Small manual list (design intent) — edit anytime
  const PINNED = [
    "MSFT","AAPL","AMZN","GOOGL","META","NVDA","TSLA",
    "AVGO","AMD","INTC","QCOM","TXN","MU","ADI","LRCX","AMAT","KLAC",
    "CRM","NOW","ORCL","PLTR","SNOW","DDOG","NET","CRWD","PANW","ZS",
    "ANET","DELL","SMCI","IBM","INTU","ADBE","CSCO","UBER"
  ];
  const pinnedSet = new Set(PINNED);

  // Parse S&P 500 into a pool
  const byTicker = new Map();

  for(let i=1;i<rows.length;i++){
    const r = rows[i];
    const ticker = normalizeTicker(r[idxSymbol]);
    if(!ticker) continue;

    const name = stripTags(r[idxSecurity] || "");
    const sector = stripTags(r[idxSector] || "");
    const industry = stripTags(r[idxIndustry] || "");
    if(!name || !sector || !industry) continue;

    byTicker.set(ticker, {
      ticker,
      name,
      sector,
      industry,
      dividend: false,
      domain: ""
    });
  }

  const pool = Array.from(byTicker.values());

  // Add tier + score
  const enriched = pool.map(s => {
    const tier = classifyTier(s, pinnedSet);
    const score = scoreForInclusion(s);
    return { ...s, tier, _score: score };
  });

  // Ensure pinned included
  const pinned = enriched.filter(s => pinnedSet.has(s.ticker));

  // For each tier, sort by score desc, then ticker asc
  function sortTier(arr){
    return arr.slice().sort((a,b) => {
      if(b._score !== a._score) return b._score - a._score;
      return a.ticker.localeCompare(b.ticker);
    });
  }

  const A = sortTier(enriched.filter(s => s.tier === "A" && !pinnedSet.has(s.ticker)).concat(pinned));
  const B = sortTier(enriched.filter(s => s.tier === "B" && !pinnedSet.has(s.ticker)));
  const C = sortTier(enriched.filter(s => s.tier === "C" && !pinnedSet.has(s.ticker)));

  // Target sizes (tweak anytime)
  // We’ll bias A + B heavily, keep C small.
  const TARGET = 400;
  const targetA = Math.min(140, A.length);     // more popular/familiar
  const targetB = Math.min(220, B.length);     // tech/ai-ish
  const targetC = Math.min(TARGET - targetA - targetB, C.length);

  const picked = []
    .concat(A.slice(0, targetA))
    .concat(B.slice(0, targetB))
    .concat(C.slice(0, targetC));

  // If we still aren’t at TARGET, top up from remaining B then C then A
  const pickedSet = new Set(picked.map(x => x.ticker));
  function topUp(fromArr){
    for(const s of fromArr){
      if(picked.length >= TARGET) break;
      if(pickedSet.has(s.ticker)) continue;
      picked.push(s);
      pickedSet.add(s.ticker);
    }
  }
  topUp(B);
  topUp(C);
  topUp(A);

  // Strip internal score field and sort alphabetically for dropdown
  const finalList = picked.slice(0, TARGET).map(({_score, ...rest}) => rest);
  finalList.sort((a,b) => a.ticker.localeCompare(b.ticker));

  writeJson("data/stocks.json", finalList);

  const counts = finalList.reduce((acc,s)=>{ acc[s.tier]=(acc[s.tier]||0)+1; return acc; }, {});
  console.log(`✅ Wrote data/stocks.json: ${finalList.length} stocks. Tier counts:`, counts);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});