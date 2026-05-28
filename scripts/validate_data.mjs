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
    assert(Array.isArray(snap["1m"]) && snap["1m"].length > 0, `Snapshot ${t} missing/empty 1m array`);
    assert(Array.isArray(snap["6m"]) && snap["6m"].length > 0, `Snapshot ${t} missing/empty 6m array`);
    assert(Array.isArray(snap["1y"]) && snap["1y"].length > 0, `Snapshot ${t} missing/empty 1y array`);
    assert(typeof snap.lastClose === "number" && Number.isFinite(snap.lastClose), `Snapshot ${t} missing lastClose`);
    assert(typeof snap.oneYearReturn === "number" && Number.isFinite(snap.oneYearReturn), `Snapshot ${t} missing oneYearReturn`);
  }

  if(missing > 0){
    console.warn(`Validation: ${missing}/${checked} past-date snapshots missing — batch build needed.`);
    process.exitCode = 1;
  } else {
    console.log(`Validation OK (${checked} snapshots verified, future dates skipped)`);
  }
}

main();
