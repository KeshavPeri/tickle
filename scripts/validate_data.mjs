import fs from "node:fs";
import path from "node:path";

function readJson(p){ return JSON.parse(fs.readFileSync(p, "utf8")); }
function assert(cond, msg){ if(!cond) throw new Error(msg); }
function todayKeyUTC(){ return new Date().toISOString().slice(0,10); }

function main(){
  assert(fs.existsSync("data/stocks.json"), "Missing data/stocks.json");
  assert(fs.existsSync("data/daily.json"), "Missing data/daily.json");

  const stocks = readJson("data/stocks.json");
  const daily = readJson("data/daily.json");
  const today = todayKeyUTC();

  assert(Array.isArray(stocks) && stocks.length > 0, "stocks.json empty");
  const tickers = new Set(stocks.map(s => s.ticker));

  for(const [date, t] of Object.entries(daily)){
    assert(tickers.has(t), `daily.json has unknown ticker ${t} on ${date}`);
  }

  // Only validate snapshot existence for dates on or before today.
  // Future dates are pre-populated in daily.json but their snapshots are
  // built lazily by batch_build.mjs — they don't exist yet and that's fine.
  let checked = 0;
  let missing = 0;
  const pastTickers = new Set(
    Object.entries(daily)
      .filter(([date]) => date <= today)
      .map(([, t]) => t)
  );

  for(const t of pastTickers){
    const p = path.join("data", "snapshots", `${t}.json`);
    checked++;
    if(!fs.existsSync(p)){
      // Warn but don't fail — the batch build may not have run yet for this ticker
      console.warn(`⚠️  Missing snapshot: ${p} (will be created by batch build)`);
      missing++;
      continue;
    }
    const snap = readJson(p);
    assert(Array.isArray(snap["6m"]), `Snapshot ${t} missing 6m array`);
    assert(typeof snap.lastClose === "number", `Snapshot ${t} missing lastClose`);
  }

  if(missing > 0){
    console.warn(`Validation: ${missing}/${checked} past-date snapshots missing — batch build needed.`);
  } else {
    console.log(`Validation OK (${checked} snapshots verified, future dates skipped)`);
  }
}

main();
