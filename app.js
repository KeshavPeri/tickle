let STOCKS = [];
let DAILY = {};
let ANSWER = null;
let SNAP = null;

let tries = 0;
const maxTries = 6;
let startedAt = null;
let timerInt = null;
let tf = "6m";
let guesses = new Set();

const $ = (id) => document.getElementById(id);

async function loadJSON(path){
  const res = await fetch(path);
  if(!res.ok) throw new Error(`Failed to load ${path} (${res.status})`);
  return await res.json();
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

    // Stagger each flip like Wordle
    setTimeout(() => {
      box.classList.add("flip");
      // Swap the letter mid-flip
      setTimeout(() => {
        box.textContent = ch;
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

function drawChart(){
  const canvas = $("chart");
  if (!canvas || !SNAP) return;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0,0,canvas.width,canvas.height);

  ctx.fillStyle = "rgba(255,255,255,.02)";
  ctx.fillRect(0,0,canvas.width,canvas.height);

  const data = SNAP?.[tf] || [];
  if(data.length < 2) return;

  const pad = {l:34, r:16, t:18, b:26};
  const w = canvas.width - pad.l - pad.r;
  const h = canvas.height - pad.t - pad.b;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = (max - min) || 1;

  // grid lines
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

  const mcap = compareNum(latest.marketCapB, ANSWER.marketCapB);
  const close = compareNum(latest.lastClose, ANSWER.lastClose);
  const ret = compareNum(latest.oneYearReturn, ANSWER.oneYearReturn);

  grid.appendChild(cell("Sector", latest.sector, badgeHtml(sectorCls)));
  grid.appendChild(cell("Industry", latest.industry, badgeHtml(industryCls)));

  grid.appendChild(cell(
    "Market cap",
    `~$${Number(latest.marketCapB).toFixed(0)}B`,
    badgeHtml(mcap.cls, mcap.arrow)
  ));

  grid.appendChild(cell(
    "Last close",
    `$${Number(latest.lastClose).toFixed(2)}`,
    badgeHtml(close.cls, close.arrow)
  ));

  grid.appendChild(cell(
    "1Y return",
    `${Number(latest.oneYearReturn).toFixed(1)}%`,
    badgeHtml(ret.cls, ret.arrow)
  ));

  grid.appendChild(cell(
    "Dividend",
    latest.dividend ? "Yes" : "No",
    badgeHtml(divCls)
  ));
}

/**
 * Hint chips: requires index.html to have:
 * <div class="hintOut" id="hintOut">
 *   <span class="hintChip hintChipMuted" id="hintDefault">No hints used.</span>
 * </div>
 *
 * If you still have a single hintLine instead, this will safely no-op chips and update hintLine instead.
 */
function setHintChip(id, text){
  const out = $("hintOut");
  const hintLine = $("hintLine");

  if (!out){
    // fallback to old single-line setup
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

  // also update hintLine if it exists (harmless)
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
      <div class="pill">Market cap: ~$${ANSWER.marketCapB}B</div>
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

async function init(){
  STOCKS = await loadJSON("./data/stocks.json");
  DAILY = await loadJSON("./data/daily.json");

  const key = todayKey();
  const todaysTicker = DAILY[key] || STOCKS[0].ticker;
  ANSWER = STOCKS.find(s => s.ticker === todaysTicker) || STOCKS[0];

  // Snapshot fallback so the app never goes blank if a file is missing
  try {
    SNAP = await loadJSON(`./data/snapshots/${ANSWER.ticker}.json`);
  } catch (e) {
    SNAP = {
      "1m": [100,101,100,102],
      "6m": [95,96,97,98,99,100],
      "1y": [80,82,85,90,95,100],
      "lastClose": ANSWER.lastClose ?? 0,
      "oneYearReturn": ANSWER.oneYearReturn ?? 0,
      "topNews": [],
      "insight": "Snapshot missing for this ticker."
    };
  }

  populateDatalist();
  renderTickerBoxes(ANSWER.ticker.length);
  renderClues(null);
  updateMeta();
  drawChart();

  document.querySelectorAll(".seg button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seg button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      tf = btn.dataset.tf;
      drawChart();
    });
  });

  $("guessBtn")?.addEventListener("click", () => {
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
    renderClues(sel);

    const win = sel.ticker === ANSWER.ticker;
    if (win) fillTickerBoxes(ANSWER.ticker);
    if(win || tries >= maxTries) reveal(win);

    if ($("search")) $("search").value = "";
  });

  $("search")?.addEventListener("keydown", (e) => {
    if(e.key === "Enter") $("guessBtn")?.click();
  });

  // hints (persist as chips)
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
    img.src = `./assets/logos/${ANSWER.ticker}.png`;
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
}

init().catch(err => {
  console.error(err);
  setNotice("Couldn’t load data. Check console for details.");
});
