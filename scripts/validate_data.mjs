import fs from "node:fs";
import path from "node:path";

function readJson(p){ return JSON.parse(fs.readFileSync(p, "utf8")); }
function assert(cond, msg){ if(!cond) throw new Error(msg); }

function main(){
  assert(fs.existsSync("data/stocks.json"), "Missing data/stocks.json");
  assert(fs.existsSync("data/daily.json"), "Missing data/daily.json");

  const stocks = readJson("data/stocks.json");
  const daily = readJson("data/daily.json");

  assert(Array.isArray(stocks) && stocks.length > 0, "stocks.json empty");
  const tickers = new Set(stocks.map(s => s.ticker));

  for(const [date, t] of Object.entries(daily)){
    assert(tickers.has(t), `daily.json has unknown ticker ${t} on ${date}`);
  }

  for(const t of new Set(Object.values(daily))){
    const p = path.join("data", "snapshots", `${t}.json`);
    assert(fs.existsSync(p), `Missing snapshot: ${p}`);
    const snap = readJson(p);
    assert(Array.isArray(snap["6m"]), `Snapshot ${t} missing 6m array`);
    assert(typeof snap.lastClose === "number", `Snapshot ${t} missing lastClose`);
  }

  console.log("Validation OK");
}

main();
