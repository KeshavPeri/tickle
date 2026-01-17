let STOCKS = [];
let DAILY = {};
let ANSWER = null;
let SNAP = null;              // answer snapshot
let ANSWER_STATS = null;      // baseline dynamic numbers for comparisons

let tries = 0;
const maxTries = 6;
let startedAt = null;
let timerInt = null;
let tf = "6m";
let guesses = new Set();

// snapshot cache so we don't refetch the same ticker
const SNAP_CACHE = new Map();

const $ = (id) => document.getElementById(id);

// Cache-busting helper (helps with GitHub Pages caching)
function withBust(url){
  const u = String(url);
  const sep = u.includes("?") ? "&" : "?";
  return `${u}${sep}v=${Date.now()}`;
}

// Normalize TF values (accepts 1M/6M/1Y too)
function normTf(x){
  const t = String(x || "").trim().toLowerCase();
  if (t === "1m" || t === "1mo" || t === "1month" || t === "1-month") return "1m";
  if (t === "6m" || t === "6mo" || t === "6month" || t === "6-month") return "6m";
  if (t === "1y" || t === "1yr" || t === "1year" || t === "1-year") return "1y";
  if (t === "1m" || t === "6m" || t === "1y") return t;
  // handle common UI casing like "1M"
  if (t === "1m") return "1m";
  if (t === "6m") return "6m";
  if (t === "1y") return "1y";
  return "6m";
}

async function loadJSON(path){
  const res = await fetch(withBust(path), { cache: "no-store" });
  if(!res.ok) throw new Error(`Failed to load ${path} (${res.status})`);
  return await res.json();
}

async function loadSnapshot(ticker){
  const t = String(ticker || "").toUpperCase();
  if (!t) return null;

  if (SNAP_CACHE.has(t)) return SNAP_CACHE.get(t);

  try{
    const snap = await loadJSON(`./data/snapshots/${t}.json`);
    SNAP_CACHE.set(t, snap);
    return snap;
  }catch{
    return null;
  }
}

function todayKey(){
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}

function renderTickerBoxes(n){
  const el = $("tickerBoxes");
  if (!el) return;
  el.innerHTML = "";
  for(let i=0;i<n;i++){
    const b = document.createElement("div");
    b.className = "box";
    b.textContent = "•";
    el.appendChild(b);
  }
}

function fillTickerBoxes(ticker){
  const el = $("tickerBoxes");
  if (!el) return;

  const boxes = el.querySelectorAll(".box");
  const letters = String(ticker || "").split("");

  boxes.forEach((b) => b.classList.remove("flip"));

  letters.forEach((ch, i) => {
    const box = boxes[i];
    if (!box) return;

    // stagger like Wordle
    setTimeout(() => {
      box.classList.add("flip");
      setTimeout(() => {
        box.textContent = ch;
        // Optional: fill solved letters green if you have CSS for .solved
        // box.classList.add("solved");
      }, 210);
    }, i * 120);
  });
}

function populateDatalist(){
  const dl = $("stocklist");
  if (!dl) return;
  dl.innerHTML = "";
  STOCKS.forEach(s => {
    const opt = document.createElement("option");
    opt.value = `${s.ticker} — ${s.name}`;
    dl.appendChild(opt);
  });
}

function parseSelection(txt){
  const t = (txt || "").trim();
  if(!t) return null;

  const parts = t.split("—").map(x => x.trim());
  if(parts.length >= 2){
    const ticker = parts[0].toUpperCase().replace(/[^A-Z]/g,"");
    return STOCKS.find(s => s.ticker === ticker) || null;
  }
  const maybeTicker = t.toUpperCase().replace(/[^A-Z]/g,"");
  return STOCKS.find(s => s.ticker === maybeTicker) || null;
}

function setNotice(msg){
  const el = $("notice");
  if(!el) return;
  if(!msg){
    el.style.display = "none";
    el.textContent = "";
  } else {
    el.style.display = "block";
    el.textContent = msg;
  }
}

function updateMeta(){
  const el = $("attempts");
  if (el) el.textContent = `${tries} / 6`;
}

function startTimer(){
  if(startedAt) return;
  startedAt = Date.now();
  timerInt = setInterval(() => {
    const s = Math.floor((Date.now() - startedAt)/1000);
    const mm = Math.floor(s/60);
    const ss = String(s%60).padStart(2,"0");
    const t = $("timer");
    if (t) t.textContent = `${mm}:${ss}`;
  }, 250);
}

function stopTimer(){
  if(timerInt) clearInterval(timerInt);
  timerInt = null;
}

function resizeCanvasToDisplaySize(canvas){
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const displayW = Math.max(1, Math.round(rect.width * dpr));
  const displayH = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== displayW || canvas.height !== displayH) {
    canvas.width = displayW;
    canvas.height = displayH;
    return true;
  }
  return false;
}

function getChartSeries(){
  if (!SNAP) return [];
  const key = normTf(tf);
  const series = SNAP[key] || SNAP[key.toUpperCase()] || [];
  return Array.isArray(series) ? series.map(Number).filter(v => Number.isFinite(v)) : [];
}

function drawChart(){
  const canvas = $("chart");
  if (!canvas || !SNAP) return;

  resizeCanvasToDisplaySize(canvas);

  const ctx = canvas.getContext("2d");
  ctx.clearRect(0,0,canvas.width,canvas.height);

  ctx.fillStyle = "rgba(255,255,255,.02)";
  ctx.fillRect(0,0,canvas.width,canvas.height);

  const data = getChartSeries();
  if(data.length < 2) return;

  const pad = {l:34, r:16, t:18, b:26};
  const w = canvas.width - pad.l - pad.r;
  const h = canvas.height - pad.t - pad.b;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = (max - min) || 1;

  // grid
  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = "rgba(255,255,255,.35)";
  ctx.lineWidth = 2;
  for(let i=1;i<=3;i++){
    const y = pad.t + (h*i/4);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l+w, y);
    ctx.stroke();
  }
  ctx.restore();

  // line
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,.82)";
  ctx.lineWidth = 5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  data.forEach((v,i) => {
    const x = pad.l + (w * (i/(data.length-1)));
    const y = pad.t + (h * (1 - ((v-min)/range)));
    if(i===0) ctx.moveTo(x,y);
    else ctx.lineTo(x,y);
  });
  ctx.stroke();
  ctx.restore();
}

function letterFeedback(guess, answer){
  const g = guess.split("");
  const a = answer.split("");
  const res = g.map(ch => ({letter: ch, state: "bad"}));
  const usedA = Array(a.length).fill(false);
  const usedG = Array(g.length).fill(false);

  for(let i=0;i<g.length;i++){
    if(g[i] === a[i]){
      res[i].state = "good";
      usedA[i]=true; usedG[i]=true;
    }
  }
  for(let i=0;i<g.length;i++){
    if(usedG[i]) continue;
    const idx = a.findIndex((ch,j) => !usedA[j] && ch === g[i]);
    if(idx !== -1){
      res[i].state = "mid";
      usedA[idx]=true;
    }
  }
  return res;
}

function compareNum(guess, answer){
  if (
    typeof guess !== "number" ||
    typeof answer !== "number" ||
    !Number.isFinite(guess) ||
    !Number.isFinite(answer) ||
    answer === 0
  ) {
    return { cls: "bad", arrow: "" };
  }

  const diffPct = Math.abs((guess - answer) / answer) * 100;

  let cls = "bad";
  if (diffPct <= 5) cls = "good";
  else if (diffPct <= 12) cls = "yellow";
  else if (diffPct <= 25) cls = "orange";

  const arrow =
    cls === "good"
      ? ""
      : guess < answer
        ? "⬆︎"
        : "⬇︎";

  return { cls, arrow };
}

function badgeHtml(cls, arrow=""){
  const label =
    cls === "good" ? "match" :
    cls === "yellow" ? "near" :
    cls === "orange" ? "far" : "off";

  return `<span class="badge ${cls}">${arrow ? `${arrow} ` : ""}${label}</span>`;
}

function compareCat(a,b){
  return (String(a).toLowerCase() === String(b).toLowerCase()) ? "good" : "bad";
}

function cell(k,v,badge){
  const d = document.createElement("div");
  d.className = "cell";
  d.innerHTML = `<div class="k">${k}</div><div class="v"><div>${v}</div>${badge || ""}</div>`;
  return d;
}

/**
 * IMPORTANT:
 * - Sector/Industry/Dividend come from STOCKS.json (static).
 * - lastClose/oneYearReturn come ONLY from snapshots.
 * - Market cap is shown as — for now (backend enrichment later).
 */
function renderClues(latest){
  const grid = $("cluesGrid");
  if (!grid) return;
  grid.innerHTML = "";

  if(!latest){
    grid.appendChild(cell("Sector","—",""));
    grid.appendChild(cell("Industry","—",""));
    grid.appendChild(cell("Market cap","—",""));
    grid.appendChild(cell("Last close","—",""));
    grid.appendChild(cell("1Y return","—",""));
    grid.appendChild(cell("Dividend","—",""));
    return;
  }

  const latestEl = $("latest");
  if (latestEl) latestEl.textContent = `Latest: ${latest.ticker}`;

  const sectorCls = compareCat(latest.sector, ANSWER.sector);
  const industryCls = compareCat(latest.industry, ANSWER.industry);
  const divCls = compareCat(latest.dividend, ANSWER.dividend);

  // Market cap placeholder (backend later)
  const mcapBadge = `<span class="badge bad">—</span>`;

  const close = compareNum(Number(latest.lastClose), Number(ANSWER_STATS?.lastClose));
  const ret   = compareNum(Number(latest.oneYearReturn), Number(ANSWER_STATS?.oneYearReturn));

  grid.appendChild(cell("Sector", latest.sector, badgeHtml(sectorCls)));
  grid.appendChild(cell("Industry", latest.industry, badgeHtml(industryCls)));

  grid.appendChild(cell("Market cap", "—", mcapBadge));

  grid.appendChild(cell(
    "Last close",
    Number.isFinite(latest.lastClose) ? `$${latest.lastClose.toFixed(2)}` : "—",
    badgeHtml(close.cls, close.arrow)
  ));

  grid.appendChild(cell(
    "1Y return",
    Number.isFinite(latest.oneYearReturn) ? `${latest.oneYearReturn.toFixed(1)}%` : "—",
    badgeHtml(ret.cls, ret.arrow)
  ));

  grid.appendChild(cell(
    "Dividend",
    latest.dividend ? "Yes" : "No",
    badgeHtml(divCls)
  ));
}

/**
 * Hint chips:
 * If hintOut doesn't exist, falls back to hintLine.
 */
function setHintChip(id, text){
  const out = $("hintOut");
  const hintLine = $("hintLine");

  if (!out){
    if (hintLine) hintLine.textContent = text;
    return;
  }

  const def = $("hintDefault");
  if (def) def.remove();

  let chip = document.getElementById(id);
  if (!chip){
    chip = document.createElement("span");
    chip.className = "hintChip";
    chip.id = id;
    out.appendChild(chip);
  }
  chip.textContent = text;
  if (hintLine) hintLine.textContent = text;
}

function addHistoryRow(stock){
  const wrap = document.createElement("div");
  wrap.className = "row";

  const top = document.createElement("div");
  top.className = "rowTop";

  const label = document.createElement("div");
  label.className = "subtle";
  label.textContent = `${stock.ticker} — ${stock.name}`;

  const tiles = document.createElement("div");
  tiles.className = "tiles";
  const fb = letterFeedback(stock.ticker, ANSWER.ticker);
  fb.forEach(x => {
    const t = document.createElement("div");
    t.className = `tile ${x.state}`;
    t.textContent = x.letter;
    tiles.appendChild(t);
  });

  top.appendChild(label);
  top.appendChild(tiles);
  wrap.appendChild(top);

  const hist = $("history");
  if (hist) hist.prepend(wrap);
}

function reveal(win){
  stopTimer();
  const el = $("reveal");
  if (!el) return;

  el.style.display = "block";
  el.innerHTML = `
    <div style="font-weight:700;margin-bottom:6px;">Revealed</div>
    <div style="color:rgba(255,255,255,.75);font-size:12px;margin-bottom:10px;">
      ${win ? `Solved in ${tries} tries.` : `Out of tries.`} Answer: ${ANSWER.ticker} — ${ANSWER.name}
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
      <div class="pill">Last close: $${Number(SNAP?.lastClose ?? 0).toFixed(2)}</div>
      <div class="pill">1Y return: ${Number(SNAP?.oneYearReturn ?? 0).toFixed(1)}%</div>
      <div class="pill">Market cap: —</div>
      <div class="pill">1Y target: —</div>
      <div class="pill">Outlook: —</div>
    </div>
    <div style="font-size:12px;color:rgba(255,255,255,.75);margin-bottom:10px;">
      <span style="font-weight:700;color:rgba(255,255,255,.92);">Today’s insight:</span> ${SNAP?.insight || "—"}
    </div>
    <div style="border-top:1px solid rgba(255,255,255,.12);padding-top:10px;">
      <div style="font-weight:700;font-size:12px;margin-bottom:8px;">Top news</div>
      ${(SNAP?.topNews||[]).slice(0,3).map(n =>
        `<div style="margin-bottom:8px;">
           <div style="font-size:12px;">${n.headline}</div>
           <div style="font-size:11px;color:rgba(255,255,255,.55);">${n.source} • ${n.when}</div>
         </div>`
      ).join("")}
    </div>
  `;
}

function setLogoSrcForAnswer(){
  const img = $("logoImg");
  if (!img) return;

  img.src = withBust(`./assets/logos/${ANSWER.ticker}.png`);

  img.onerror = () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="128" height="128">
        <rect width="100%" height="100%" rx="24" ry="24" fill="rgba(255,255,255,0.10)"/>
        <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle"
              font-family="ui-sans-serif, -apple-system, system-ui" font-size="40"
              fill="rgba(255,255,255,0.85)" font-weight="700">${ANSWER.ticker}</text>
      </svg>
    `.trim();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  };
}

async function init(){
  STOCKS = await loadJSON("./data/stocks.json");
  DAILY = await loadJSON("./data/daily.json");

  const key = todayKey();
  const todaysTicker = DAILY[key] || STOCKS[0].ticker;
  ANSWER = STOCKS.find(s => s.ticker === todaysTicker) || STOCKS[0];

  // Answer snapshot (real numbers)
  SNAP = await loadSnapshot(ANSWER.ticker);
  if (!SNAP){
    // keep app alive if snapshot missing
    SNAP = {
      "1m": [100,101,100,102,101,103,102,104],
      "6m": [95,96,97,98,99,100,99,101,100,102],
      "1y": [80,82,85,84,88,90,92,91,95,100],
      lastClose: 0,
      oneYearReturn: 0,
      topNews: [],
      insight: "Snapshot missing for this ticker."
    };
  }

  ANSWER_STATS = {
    lastClose: Number(SNAP.lastClose ?? 0),
    oneYearReturn: Number(SNAP.oneYearReturn ?? 0),
  };

  populateDatalist();
  renderTickerBoxes(ANSWER.ticker.length);
  renderClues(null);
  updateMeta();

  setLogoSrcForAnswer();

  tf = normTf(tf);
  drawChart();

  // timeframe toggles
  document.querySelectorAll(".seg button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seg button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      tf = normTf(btn.dataset.tf);
      drawChart();
    });
  });

  // guess handling (IMPORTANT: do NOT spread sel into clue object)
  $("guessBtn")?.addEventListener("click", async () => {
    if(tries >= maxTries) return;

    const sel = parseSelection($("search")?.value);
    if(!sel) return setNotice("Pick a stock from the dropdown.");

    if(sel.ticker.length !== ANSWER.ticker.length) return setNotice("Wrong ticker length for today.");
    if(guesses.has(sel.ticker)) return setNotice("You already guessed that one.");

    setNotice("");
    startTimer();
    guesses.add(sel.ticker);
    tries += 1;
    updateMeta();

    addHistoryRow(sel);

    // Load real dynamic numbers for the guessed ticker
    const gsnap = await loadSnapshot(sel.ticker);

    // Build clues object explicitly so placeholder numbers in stocks.json can never leak in
    const latestForClues = {
      ticker: sel.ticker,
      name: sel.name,
      sector: sel.sector,
      industry: sel.industry,
      dividend: sel.dividend,
      lastClose: Number(gsnap?.lastClose),
      oneYearReturn: Number(gsnap?.oneYearReturn),
    };

    renderClues(latestForClues);

    const win = sel.ticker === ANSWER.ticker;
    if (win) fillTickerBoxes(ANSWER.ticker);
    if(win || tries >= maxTries) reveal(win);

    if ($("search")) $("search").value = "";
  });

  $("search")?.addEventListener("keydown", (e) => {
    if(e.key === "Enter") $("guessBtn")?.click();
  });

  // hints
  $("hintSector")?.addEventListener("click", () => {
    setHintChip("hintChipSector", `Sector: ${ANSWER.sector}`);
    $("hintSector").disabled = true;
  });

  $("hintIndustry")?.addEventListener("click", () => {
    setHintChip("hintChipIndustry", `Industry: ${ANSWER.industry}`);
    $("hintIndustry").disabled = true;
  });

  let logoStage = 0;
  $("hintLogo")?.addEventListener("click", () => {
    logoStage = Math.min(3, logoStage + 1);

    const wrap = $("logoWrap");
    const img = $("logoImg");
    if (!wrap || !img) return;

    wrap.style.display = "flex";
    setLogoSrcForAnswer();

    img.classList.remove("stage2", "stage3");

    if (logoStage === 1) {
      setHintChip("hintChipLogo", "Logo: blurred");
    } else if (logoStage === 2) {
      img.classList.add("stage2");
      setHintChip("hintChipLogo", "Logo: clearer");
    } else if (logoStage === 3) {
      img.classList.add("stage3");
      setHintChip("hintChipLogo", "Logo: full");
      $("hintLogo").disabled = true;
    }
  });

  window.addEventListener("resize", () => drawChart());
}

init().catch(err => {
  console.error(err);
  setNotice("Couldn’t load data. Check console for details.");
});
