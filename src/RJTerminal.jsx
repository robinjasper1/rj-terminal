import { useState, useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────
// ⚠️ PASTE YOUR FINNHUB API KEY HERE (news feed)
// ─────────────────────────────────────────────
const FINNHUB_API_KEY = "YOUR_FINNHUB_API_KEY_HERE";

// ─────────────────────────────────────────────
// Railway backend — secure proxy for Massive API
// All price data flows through here
// ─────────────────────────────────────────────
const BACKEND = "https://rj-backend-production.up.railway.app";

// Refresh intervals
const GAPPER_REFRESH_MS  = 5 * 60_000;  // gapper scan every 5 min
const QUOTE_REFRESH_MS   = 30_000;       // quotes every 30 sec
const NEWS_REFRESH_MS    = 60_000;       // news every 60 sec
const NEWS_TICKER_LIMIT  = 10;           // fetch news for top 10 gappers

// Fallback watchlist — used when backend scan returns nothing
const FALLBACK_WATCHLIST = ["NKTR","GME","MARA","SOUN","CELH","BYND","XTIA","CLPS","REBN","MDJH"];

// ─────────────────────────────────────────────
// SCORING ENGINE — runs on live gapper data
// ─────────────────────────────────────────────

// Detect likely track from available signals
function detectTrack(g) {
  const floatM = (g.float || 0) / 1_000_000;
  const rvol   = g.rvol || 0;
  const chg    = g.changePercent || 0;
  // Pump signals: tiny float, extreme RVOL, big move, no catalyst tag
  if (floatM < 10 && rvol > 15 && chg > 20 && !g.tags?.length) return "P";
  return "C1";
}

// Catalyst score 0–100
function scoreGapper(g) {
  let score = 0;
  const floatM  = (g.float || 0) / 1_000_000;
  const rvol    = g.rvol   || 0;
  const chgPct  = Math.abs(g.changePercent || 0);
  const vol     = g.volume || 0;

  // Gap % — up to 20pts
  score += Math.min(20, chgPct * 0.5);
  // RVOL — up to 20pts
  score += Math.min(20, rvol * 2);
  // Float — up to 15pts (smaller = better)
  if (floatM < 5)        score += 15;
  else if (floatM < 20)  score += 12;
  else if (floatM < 50)  score += 8;
  else if (floatM < 200) score += 4;
  // Volume — up to 15pts
  if (vol > 10_000_000)      score += 15;
  else if (vol > 5_000_000)  score += 10;
  else if (vol > 1_000_000)  score += 5;
  // PMH painted bonus — 10pts
  if (g.pmhPainted) score += 10;
  // MDP candidate bonus — 10pts
  if (g.mdpCandidate) score += 10;
  // Cap at 100
  return Math.min(100, Math.round(score));
}

// Setup grade A/B/C/D
function calcGrade(g, score) {
  const floatM = (g.float || 0) / 1_000_000;
  const rvol   = g.rvol || 0;
  if (score >= 80 && g.pmhPainted && floatM < 50 && rvol >= 10) return "A";
  if (score >= 60) return "B";
  if (score >= 45) return "C";
  return "D";
}

// Format float for display
function fmtFloat(shares) {
  if (!shares) return "—";
  const m = shares / 1_000_000;
  return m >= 1000 ? `${(m/1000).toFixed(1)}B` : `${m.toFixed(1)}M`;
}

// Format market cap
function fmtMktCap(n) {
  if (!n) return "—";
  if (n >= 1e9) return `$${(n/1e9).toFixed(1)}B`;
  return `$${(n/1e6).toFixed(0)}M`;
}

// MDP candidate auto-detection from intraday data
function buildMdpSignals(g, intraday) {
  if (!intraday) return null;
  const mdp      = intraday.mdp;
  const floatM   = (g.float || 0) / 1_000_000;
  const vol      = g.volume || 0;
  const score    = g.score || 0;

  const volOk    = vol >= 5_000_000;
  const catOk    = score >= 70;
  const aboveOpen= mdp?.aboveOpen || false;
  const aboveHS  = mdp?.aboveHalfSpike || false;
  const baseMin  = mdp?.baseMinutes || 0;
  const baseOk   = baseMin >= 45;
  const floatOk  = floatM < 50;

  const autoPass = [volOk, catOk, aboveOpen, aboveHS, baseOk, floatOk].filter(Boolean).length;
  const halfSpike= mdp?.halfSpike || 0;
  const open     = mdp?.sessionOpen || 0;
  const high     = mdp?.sessionHigh || 0;
  const price    = mdp?.currentPrice || 0;

  // Spike bar: where is price between open and high?
  const fillPct  = high > open
    ? Math.min(100, Math.round(((price - open) / (high - open)) * 100))
    : 0;

  return {
    autoSignals: [
      { label:"Volume above 5M shares",           state: volOk?"y":"n",  value: vol ? `${(vol/1e6).toFixed(1)}M ${volOk?"✓":"✗"}` : "—" },
      { label:"Strong catalyst (rater score 70+)", state: catOk?"y":"n",  value: `Score ${score} ${catOk?"✓":"✗"}` },
      { label:"Price above open price",            state: aboveOpen?"y":aboveOpen===false?"n":"q", value: open ? `$${price?.toFixed(2)} > $${open?.toFixed(2)} ${aboveOpen?"✓":"✗"}` : "—" },
      { label:"Price held above ½-spike level",    state: aboveHS?"y":"n",value: halfSpike ? `$${price?.toFixed(2)} > $${halfSpike?.toFixed(2)} ${aboveHS?"✓":"✗"}` : "—" },
      { label:"Tight consolidation range >45min",  state: baseOk?"y":baseMin>30?"q":"n", value: baseMin ? `${baseMin}min ${baseOk?"✓":"— wait"}` : "—" },
      { label:"Float — smaller is stronger signal",state: floatOk?"y":"q",value: fmtFloat(g.float) + (floatOk?" ✓":" · large") },
    ],
    manualSignals:[{ label:"Clean chart — no overhead supply", value:"Check TWS" }],
    spike:{
      open:  open  ? `$${open.toFixed(2)}`      : "—",
      half:  halfSpike ? `$${halfSpike.toFixed(2)}` : "—",
      high:  high  ? `$${high.toFixed(2)}`      : "—",
      label: halfSpike ? `½-Spike $${halfSpike.toFixed(2)}` : "½-Spike",
      held:  aboveHS,
      fillPct,
    },
    autoPass,
    score: `${autoPass}/6`,
    status: autoPass >= 5 ? "basing" : autoPass >= 4 ? "watch" : "watch",
    isMdpCandidate: autoPass >= 4,
  };
}

// ─────────────────────────────────────────────
// STATIC FALLBACK DATA — shown while loading
// or when market is closed
// ─────────────────────────────────────────────
const MOCK_GAPPERS = [
  { rank:1, sym:"NKTR", tags:["FDA","MDP"], float:"124M", rotation:"71%", gain:"+41.8%", gainPos:true, pmhPainted:true, pmhLevel:"$9.42", grade:"A", score:94, track:"MDP" },
  { rank:2, sym:"XTIA", tags:["Pump"],      float:"3.2M", rotation:"388%",gain:"+84.2%", gainPos:true, pmhPainted:true, pmhLevel:"$2.18", grade:"A", score:88, track:"P"   },
  { rank:3, sym:"GME",  tags:["Sqze"],      float:"304M", rotation:"24%", gain:"+18.3%", gainPos:true, pmhPainted:true, pmhLevel:"$21.40",grade:"B", score:78, track:"C1"  },
  { rank:4, sym:"SOUN", tags:["8-K","MDP"], float:"8.2M", rotation:"18%", gain:"+9.1%",  gainPos:true, pmhPainted:false,pmhLevel:"$7.88", grade:"B", score:71, track:"MDP" },
  { rank:5, sym:"MARA", tags:["Macro"],     float:"312M", rotation:"11%", gain:"+14.6%", gainPos:true, pmhPainted:false,pmhLevel:"$23.80",grade:"B", score:64, track:"C1"  },
  { rank:6, sym:"CELH", tags:["Earn"],      float:"224M", rotation:"8%",  gain:"+7.8%",  gainPos:true, pmhPainted:false,pmhLevel:"$33.20",grade:"C", score:51, track:"C1"  },
  { rank:7, sym:"BYND", tags:["Earn"],      float:"62M",  rotation:"5%",  gain:"−11.4%", gainPos:false,pmhPainted:false,pmhLevel:"$4.88", grade:"D", score:28, track:"C1"  },
];

const MOCK_PUMPS = [
  { rank:1, sym:"XTIA", country:"Cayman", float:"3.2M", rvol:"38x", prior:"0×", chg:"+84.2%", chgPos:true,  badge:"active" },
  { rank:2, sym:"CLPS", country:"China",  float:"4.8M", rvol:"22x", prior:"4×", chg:"+62.1%", chgPos:false, badge:"fading" },
  { rank:3, sym:"REBN", country:"China",  float:"2.1M", rvol:"31x", prior:"2×", chg:"+47.3%", chgPos:true,  badge:"active" },
  { rank:4, sym:"MDJH", country:"China",  float:"1.8M", rvol:"14x", prior:"1×", chg:"+28.4%", chgPos:true,  badge:"watch"  },
  { rank:5, sym:"CNET", country:"Cayman", float:"3.9M", rvol:"11x", prior:"3×", chg:"+19.2%", chgPos:true,  badge:"watch"  },
];

const MOCK_CATALYST_ROWS = [
  { sym:"NKTR", track:"MDP", score:94, barPct:94, barColor:"linear-gradient(90deg,#f97316,#22d3ee)", badge:"mdp",  factors:"Cat 30 · Gap 19 · RVOL 20 · Float 11 · Src 14 · PMH ✓ · MDP 6/6" },
  { sym:"XTIA", track:"P",   score:88, barPct:88, barColor:"linear-gradient(90deg,#f5a623,#ff4d6a)", badge:"pa",   factors:"Float 25 · RVOL 25 · Country 15 · Prior 13 · SI 10" },
  { sym:"GME",  track:"C1",  score:78, barPct:78, barColor:"linear-gradient(90deg,#f5a623,#00d68f)", badge:"warm", factors:"Cat 10 · Gap 18 · RVOL 20 · SI 28% · PMH ✓" },
  { sym:"SOUN", track:"MDP", score:71, barPct:71, barColor:"linear-gradient(90deg,#f97316,#4d9fff)", badge:"mdp",  factors:"Cat 18 · Gap 10 · RVOL 16 · Float 8.2M · MDP 5/6" },
  { sym:"MARA", track:"C1",  score:64, barPct:64, barColor:"#4d9fff",                               badge:"cool", factors:"Cat 18 · Gap 14 · RVOL 8x · Float 312M" },
  { sym:"CLPS", track:"P",   score:76, barPct:76, barColor:"#f5a623",                               badge:"pf",   factors:"Float 24 · RVOL 22 · Country 15 · Prior ×4" },
];

const MDP_CANDIDATES = [
  {
    sym:"NKTR", tag:"FDA", status:"basing",
    autoSignals:[
      { label:"Volume above 5M shares",           state:"y", value:"18.2M ✓" },
      { label:"Strong catalyst (rater score 70+)", state:"y", value:"Score 94 ✓" },
      { label:"Price above open price",            state:"y", value:"$8.74 > $5.18 ✓" },
      { label:"Price held above ½-spike level",    state:"y", value:"$8.74 > $6.21 ✓" },
      { label:"Tight consolidation range >45min",  state:"q", value:"58min · building" },
      { label:"Float — smaller is stronger signal",state:"q", value:"124M · large" },
    ],
    manualSignals:[{ label:"Clean chart — no overhead supply", value:"Check TWS" }],
    spike:{ open:"$5.18", half:"$6.21", high:"$9.42", label:"½-Spike $6.21", held:true, fillPct:78 },
    score:"6/7", entry:"$7.20 BO", stop:"$6.55", countdownLabel:"48min",
  },
  {
    sym:"SOUN", tag:"8-K", status:"watch",
    autoSignals:[
      { label:"Volume above 5M shares",           state:"y", value:"6.1M ✓" },
      { label:"Strong catalyst (rater score 70+)", state:"y", value:"Score 71 ✓" },
      { label:"Price above open price",            state:"q", value:"$7.33 > $6.71 · slim" },
      { label:"Price held above ½-spike level",    state:"y", value:"$7.33 > $6.88 ✓" },
      { label:"Tight consolidation range >45min",  state:"n", value:"34min — wait" },
      { label:"Float — smaller is stronger signal",state:"y", value:"8.2M ✓" },
    ],
    manualSignals:[{ label:"Clean chart — no overhead supply", value:"Check TWS" }],
    spike:{ open:"$6.71", half:"$6.88", high:"$7.94", label:"½-Spike $6.88", held:true, fillPct:65, gradient:"linear-gradient(90deg,#22d3ee,#4d9fff)" },
    score:"5/7", entry:null, stop:null, countdownLabel:null,
  },
];

// ─────────────────────────────────────────────
// LIVE DATA HOOK — fetches from Railway backend
// Returns: gappers, mdpCandidates, pumps,
//          catalystRows, dataSource, lastUpdate
// ─────────────────────────────────────────────
function useLiveData() {
  const [gappers,       setGappers]       = useState(MOCK_GAPPERS);
  const [mdpCandidates, setMdpCandidates] = useState(MDP_CANDIDATES);
  const [pumps,         setPumps]         = useState(MOCK_PUMPS);
  const [catalystRows,  setCatalystRows]  = useState(MOCK_CATALYST_ROWS);
  const [dataSource,    setDataSource]    = useState("mock"); // "mock"|"live"|"error"
  const [lastUpdate,    setLastUpdate]    = useState(null);
  const [watchlist,     setWatchlist]     = useState(FALLBACK_WATCHLIST);

  const processGappers = useCallback(async (rawGappers) => {
    if (!rawGappers?.length) return;

    // For each gapper fetch PMH and intraday in parallel (top 7 only to stay fast)
    const top = rawGappers.slice(0, 7);
    const [pmhResults, intradayResults] = await Promise.all([
      Promise.allSettled(top.map(g =>
        fetch(`${BACKEND}/api/pmh/${g.sym}`).then(r => r.json())
      )),
      Promise.allSettled(top.map(g =>
        fetch(`${BACKEND}/api/intraday/${g.sym}`).then(r => r.json())
      )),
    ]);

    const enriched = top.map((g, i) => {
      const pmh      = pmhResults[i].status==="fulfilled" ? pmhResults[i].value?.data : null;
      const intraday = intradayResults[i].status==="fulfilled" ? intradayResults[i].value?.data : null;
      const chgPct   = g.changePercent || 0;
      const floatM   = (g.float || 0) / 1_000_000;
      const vol      = g.volume || 0;
      const rvol     = g.rvol || 0;

      // PM Rotation % = premarket volume / float * 100
      const rotPct = g.float && vol ? Math.round((vol / g.float) * 100) : null;

      // MDP signals from intraday
      const mdpSig = buildMdpSignals(g, intraday);

      // Score
      const enrichedG = { ...g, pmhPainted: pmh?.painted || false, mdpCandidate: mdpSig?.isMdpCandidate || false };
      const score  = scoreGapper(enrichedG);
      const grade  = calcGrade(enrichedG, score);
      const track  = detectTrack(enrichedG);

      // Tags
      const tags = [];
      if (track === "P") tags.push("Pump");
      if (mdpSig?.isMdpCandidate) tags.push("MDP");

      return {
        rank:      i + 1,
        sym:       g.sym,
        tags,
        float:     fmtFloat(g.float),
        floatRaw:  g.float,
        rotation:  rotPct != null ? `${rotPct}%` : "—",
        gain:      chgPct >= 0 ? `+${chgPct.toFixed(1)}%` : `${chgPct.toFixed(1)}%`,
        gainPos:   chgPct >= 0,
        pmhPainted:pmh?.painted || false,
        pmhLevel:  pmh?.pmhPrice ? `$${pmh.pmhPrice.toFixed(2)}` : "—",
        grade,
        score,
        track,
        rvol,
        mdpSignals:mdpSig,
        intraday,
        marketCap: g.marketCap,
      };
    });

    setGappers(enriched);

    // Build catalyst rows from enriched gappers
    const cRows = enriched.map(g => {
      const isMdp  = g.track==="MDP" || g.tags.includes("MDP");
      const isPump = g.track==="P";
      const barColor = isMdp ? "linear-gradient(90deg,#f97316,#22d3ee)"
        : isPump ? "linear-gradient(90deg,#f5a623,#ff4d6a)"
        : g.score >= 70 ? "linear-gradient(90deg,#f5a623,#00d68f)"
        : "#4d9fff";
      const badge = isMdp ? "mdp" : isPump && g.score>=75 ? "pa" : isPump ? "pf"
        : g.score>=80 ? "hot" : g.score>=55 ? "warm" : "cool";
      const track = isMdp ? "MDP" : isPump ? "P" : "C1";
      const factors = [
        g.gain && `Gap ${g.gain}`,
        g.rvol && `RVOL ${g.rvol}x`,
        g.float && `Float ${g.float}`,
        g.pmhPainted && "PMH ✓",
        isMdp && `MDP ${g.mdpSignals?.score || ""}`,
      ].filter(Boolean).join(" · ");

      return { sym:g.sym, track, score:g.score, barPct:g.score, barColor, badge, factors };
    });
    setCatalystRows(cRows);

    // Build MDP candidates from enriched gappers
    const mdpList = enriched
      .filter(g => g.mdpSignals?.isMdpCandidate)
      .map(g => ({
        sym:          g.sym,
        tag:          g.tags.find(t=>t!=="MDP") || "Gap",
        status:       g.mdpSignals.status,
        autoSignals:  g.mdpSignals.autoSignals,
        manualSignals:g.mdpSignals.manualSignals,
        spike:        g.mdpSignals.spike,
        score:        g.mdpSignals.score,
        entry:        null,
        stop:         null,
        countdownLabel:null,
      }));
    if (mdpList.length) setMdpCandidates(mdpList);

    // Build pump list
    const pumpList = enriched
      .filter(g => g.track==="P" || g.tags.includes("Pump"))
      .map((g, i) => ({
        rank:    i + 1,
        sym:     g.sym,
        country: "US",
        float:   g.float,
        rvol:    g.rvol ? `${g.rvol}x` : "—",
        prior:   "0×",
        chg:     g.gain,
        chgPos:  g.gainPos,
        badge:   g.score >= 75 ? "active" : "watch",
      }));
    if (pumpList.length) setPumps(pumpList);

    setWatchlist(enriched.map(g => g.sym));
    setDataSource("live");
    setLastUpdate(new Date().toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"America/New_York"}));
  }, []);

  const fetchGappers = useCallback(async () => {
    try {
      const res  = await fetch(`${BACKEND}/api/gappers`);
      const json = await res.json();
      if (json.ok && json.data?.length) {
        await processGappers(json.data);
      } else {
        setDataSource("error");
      }
    } catch(e) {
      console.error("Backend fetch failed:", e.message);
      setDataSource("error");
    }
  }, [processGappers]);

  useEffect(() => {
    fetchGappers();
    const iv = setInterval(fetchGappers, GAPPER_REFRESH_MS);
    return () => clearInterval(iv);
  }, [fetchGappers]);

  return { gappers, mdpCandidates, pumps, catalystRows, dataSource, lastUpdate, watchlist };
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function etClock() {
  return new Date().toLocaleTimeString("en-US", { timeZone:"America/New_York", hour12:false });
}

function etNowParts() {
  const str = new Date().toLocaleString("en-US", { timeZone:"America/New_York", hour12:false });
  const d = new Date(str);
  return { h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() };
}

function mdpWindowStatus() {
  const { h, m, s } = etNowParts();
  const total = h * 3600 + m * 60 + s;
  const open  = 10 * 3600 + 30 * 60;
  const close = 14 * 3600;
  if (total < open) {
    const rem = open - total;
    const mm = String(Math.floor(rem / 60)).padStart(2,"0");
    const ss = String(rem % 60).padStart(2,"0");
    return { phase:"pre", countdown:`${mm}:${ss}`, barPct:0 };
  }
  if (total < close) {
    const elapsed = total - open;
    const duration = close - open;
    const rem = close - total;
    const mm = String(Math.floor(rem / 60)).padStart(2,"0");
    const ss = String(rem % 60).padStart(2,"0");
    return { phase:"live", countdown:"LIVE", cutoff:`${mm}:${ss}`, barPct: Math.round((elapsed/duration)*100) };
  }
  return { phase:"closed", countdown:"CLOSED", barPct:100 };
}

// Detect catalyst tag from headline text
function detectTag(headline, sym) {
  const h = headline.toLowerCase();
  if (h.includes("fda") || h.includes("approval") || h.includes("nda") || h.includes("drug")) return "FDA";
  if (h.includes("earn") || h.includes("eps") || h.includes("revenue") || h.includes("quarter")) return "Earn";
  if (h.includes("8-k") || h.includes("contract") || h.includes("agreement") || h.includes("partner")) return "8-K";
  if (h.includes("short") || h.includes("squeeze")) return "Sqze";
  if (["XTIA","CLPS","REBN","MDJH","CNET"].includes(sym)) return "Pump";
  if (["NKTR","SOUN"].includes(sym)) return "MDP";
  return "News";
}

function tagColor(tag) {
  switch(tag) {
    case "FDA":  return { bg:"rgba(167,139,250,0.14)", color:"#a78bfa", border:"rgba(167,139,250,0.28)" };
    case "Earn": return { bg:"rgba(0,214,143,0.1)",    color:"#00d68f", border:"rgba(0,214,143,0.22)"  };
    case "8-K":  return { bg:"rgba(77,159,255,0.1)",   color:"#4d9fff", border:"rgba(77,159,255,0.22)" };
    case "Sqze": return { bg:"rgba(255,77,106,0.1)",   color:"#ff4d6a", border:"rgba(255,77,106,0.22)" };
    case "Pump": return { bg:"rgba(245,166,35,0.12)",  color:"#f5a623", border:"rgba(245,166,35,0.32)" };
    case "MDP":  return { bg:"rgba(249,115,22,0.07)",  color:"#f97316", border:"rgba(249,115,22,0.22)" };
    default:     return { bg:"rgba(61,81,102,0.2)",    color:"#7a90a4", border:"#1e2d3d"               };
  }
}

function newsRowBorder(tag, sym) {
  if (["NKTR","SOUN"].includes(sym) && tag === "MDP") return "2px solid #f97316";
  if (["XTIA","CLPS","REBN","MDJH","CNET"].includes(sym) || tag === "Pump") return "2px solid #f5a623";
  return "2px solid rgba(0,214,143,0.35)";
}

// ─────────────────────────────────────────────
// STYLES — all in JS objects matching the approved design
// ─────────────────────────────────────────────
const S = {
  body: {
    fontFamily:"'Inter',-apple-system,sans-serif",
    background:"#090c0f",
    color:"#e8eef5",
    fontSize:11,
    lineHeight:1.4,
    height:"100vh",
    overflow:"hidden",
    WebkitFontSmoothing:"antialiased",
    position:"relative",
  },
  scanlines: {
    position:"fixed", inset:0, pointerEvents:"none", zIndex:9999,
    background:"repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.05) 2px,rgba(0,0,0,0.05) 4px)",
  },
  topbar: {
    display:"flex", alignItems:"center", justifyContent:"space-between",
    padding:"0 14px", height:38, background:"#0d1117",
    borderBottom:"1px solid #1e2d3d", flexShrink:0, zIndex:100,
  },
  layout: {
    display:"grid",
    gridTemplateColumns:"1fr 1fr 330px",
    gridTemplateRows:"1fr 1fr",
    height:"calc(100vh - 38px)",
  },
  panel: {
    borderRight:"1px solid #1e2d3d",
    borderBottom:"1px solid #1e2d3d",
    display:"flex", flexDirection:"column",
    overflow:"hidden", minHeight:0,
  },
  ph: {
    display:"flex", alignItems:"center", justifyContent:"space-between",
    padding:"6px 12px", background:"#0d1117",
    borderBottom:"1px solid #1e2d3d", flexShrink:0,
  },
  pscroll: {
    flex:1, overflowY:"auto", overflowX:"hidden", minHeight:0,
  },
};

// ─────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────

function Dot({ color, size=5, anim="pulse" }) {
  const kf = anim === "blink"
    ? `@keyframes blink{0%,100%{opacity:1}50%{opacity:0.2}}`
    : `@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.3;transform:scale(0.6)}}`;
  return (
    <>
      <style>{kf}</style>
      <div style={{ width:size, height:size, background:color, borderRadius:"50%",
        animation:`${anim} ${anim==="blink"?2:1.5}s infinite`, flexShrink:0 }} />
    </>
  );
}

function Badge({ children, variant="default" }) {
  const variants = {
    default: { bg:"#131920", color:"#3d5166", border:"#1e2d3d" },
    live:    { bg:"rgba(0,214,143,0.07)",   color:"#00d68f", border:"rgba(0,214,143,0.2)"   },
    ai:      { bg:"rgba(167,139,250,0.07)", color:"#a78bfa", border:"rgba(167,139,250,0.2)" },
    pump:    { bg:"rgba(245,166,35,0.07)",  color:"#f5a623", border:"rgba(245,166,35,0.2)"  },
    mdp:     { bg:"rgba(249,115,22,0.07)",  color:"#f97316", border:"rgba(249,115,22,0.22)" },
  };
  const v = variants[variant] || variants.default;
  return (
    <span style={{ fontSize:7, fontWeight:700, padding:"2px 5px", borderRadius:3,
      letterSpacing:"0.07em", textTransform:"uppercase",
      background:v.bg, color:v.color, border:`1px solid ${v.border}` }}>
      {children}
    </span>
  );
}

function Tag({ type }) {
  const styles = {
    FDA:  { bg:"rgba(167,139,250,0.14)", color:"#a78bfa", border:"rgba(167,139,250,0.28)" },
    Earn: { bg:"rgba(0,214,143,0.1)",    color:"#00d68f", border:"rgba(0,214,143,0.22)"  },
    Macro:{ bg:"rgba(245,166,35,0.1)",   color:"#f5a623", border:"rgba(245,166,35,0.22)" },
    "8-K":{ bg:"rgba(77,159,255,0.1)",   color:"#4d9fff", border:"rgba(77,159,255,0.22)" },
    Sqze: { bg:"rgba(255,77,106,0.1)",   color:"#ff4d6a", border:"rgba(255,77,106,0.22)" },
    Pump: { bg:"rgba(245,166,35,0.12)",  color:"#f5a623", border:"rgba(245,166,35,0.32)" },
    Dil:  { bg:"rgba(255,77,106,0.1)",   color:"#ff4d6a", border:"rgba(255,77,106,0.22)" },
    MDP:  { bg:"rgba(249,115,22,0.07)",  color:"#f97316", border:"rgba(249,115,22,0.22)" },
    News: { bg:"rgba(61,81,102,0.2)",    color:"#7a90a4", border:"#1e2d3d"               },
  };
  const s = styles[type] || styles.News;
  return (
    <span style={{ display:"inline-block", fontSize:7, fontWeight:700, padding:"1px 4px",
      borderRadius:3, letterSpacing:"0.07em", textTransform:"uppercase", flexShrink:0,
      background:s.bg, color:s.color, border:`1px solid ${s.border}` }}>
      {type === "MDP" ? "⬡ MDP" : type === "Pump" ? "⚠ Pump" : type}
    </span>
  );
}

function MdpFlag() {
  return (
    <>
      <style>{`@keyframes mdpFlash{0%,100%{box-shadow:0 0 0 0 rgba(249,115,22,0.3)}60%{box-shadow:0 0 0 4px rgba(249,115,22,0)}}`}</style>
      <span style={{ fontSize:7, fontWeight:700, padding:"2px 5px", borderRadius:3,
        background:"rgba(249,115,22,0.07)", color:"#f97316",
        border:"1px solid rgba(249,115,22,0.22)", letterSpacing:"0.05em",
        textTransform:"uppercase", whiteSpace:"nowrap", animation:"mdpFlash 2.5s infinite" }}>
        ⬡ MDP
      </span>
    </>
  );
}

function Grade({ g }) {
  const map = {
    A:{ bg:"rgba(0,214,143,0.12)",   color:"#00d68f", border:"rgba(0,214,143,0.3)"   },
    B:{ bg:"rgba(245,166,35,0.1)",   color:"#f5a623", border:"rgba(245,166,35,0.28)" },
    C:{ bg:"rgba(77,159,255,0.08)",  color:"#4d9fff", border:"rgba(77,159,255,0.22)" },
    D:{ bg:"rgba(61,81,102,0.2)",    color:"#7a90a4", border:"#1e2d3d"               },
  };
  const s = map[g] || map.D;
  return (
    <div style={{ display:"inline-flex", alignItems:"center", justifyContent:"center",
      width:26, height:22, fontSize:13, fontWeight:900, borderRadius:4,
      background:s.bg, color:s.color, border:`1px solid ${s.border}` }}>
      {g}
    </div>
  );
}

function ScoreBar({ pct, color, score, trackColor }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", alignItems:"flex-end", gap:3 }}>
      <div style={{ width:44, height:3, background:"#131920", borderRadius:2, overflow:"hidden" }}>
        <div style={{ width:`${pct}%`, height:"100%", background:color, borderRadius:2 }} />
      </div>
      <span style={{ fontSize:11, fontWeight:800, fontVariantNumeric:"tabular-nums", color:trackColor }}>{score}</span>
    </div>
  );
}

function TWSTip({ children, mdp=false }) {
  return (
    <div style={{ padding:"4px 12px", background: mdp?"rgba(249,115,22,0.03)":"rgba(34,211,238,0.03)",
      borderTop:`1px solid ${mdp?"rgba(249,115,22,0.1)":"rgba(34,211,238,0.08)"}`,
      fontSize:8, color:"#3d5166", flexShrink:0, display:"flex", alignItems:"center", gap:5 }}>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────
// PANEL 1 — GAPPER SCANNER
// ─────────────────────────────────────────────
function GapperScanner({ mdpFilter, setMdpFilter, gappers, dataSource, lastUpdate }) {
  const [selected, setSelected] = useState(0);
  const [activeFilter, setActiveFilter] = useState("All");

  const scoreColor = (r) => {
    if (r.track === "MDP") return "#f97316";
    if (r.track === "P")   return "#f5a623";
    if (r.score >= 80)     return "#00d68f";
    if (r.score >= 60)     return "#f5a623";
    if (r.score >= 45)     return "#4d9fff";
    return "#ff4d6a";
  };

  const scoreBarColor = (r) => {
    if (r.track === "MDP") return "linear-gradient(90deg,#f97316,#22d3ee)";
    if (r.track === "P")   return "linear-gradient(90deg,#f5a623,#ff4d6a)";
    if (r.score >= 80)     return "linear-gradient(90deg,#f5a623,#00d68f)";
    if (r.score >= 60)     return "#4d9fff";
    return "#ff4d6a";
  };

  const filters = ["All","FDA","Earn","Sqze","8-K","⚠ Pump","⬡ MDP","Grade A"];

  const visible = gappers.filter(r => {
    if (mdpFilter) return r.tags.includes("MDP");
    if (activeFilter === "All") return true;
    if (activeFilter === "FDA")     return r.tags.includes("FDA");
    if (activeFilter === "Earn")    return r.tags.includes("Earn");
    if (activeFilter === "Sqze")    return r.tags.includes("Sqze");
    if (activeFilter === "8-K")     return r.tags.includes("8-K");
    if (activeFilter === "⚠ Pump") return r.tags.includes("Pump");
    if (activeFilter === "⬡ MDP")  return r.tags.includes("MDP");
    if (activeFilter === "Grade A") return r.grade === "A";
    return true;
  });

  const colGrid = "18px 86px 52px 58px 64px 90px 42px 52px";

  return (
    <div style={{ ...S.panel }}>
      <div style={S.ph}>
        <div style={{ fontSize:9, fontWeight:700, letterSpacing:"0.12em", textTransform:"uppercase",
          color:"#7a90a4", display:"flex", alignItems:"center", gap:5 }}>
          <span style={{ color:"#22d3ee" }}>▲</span> Gapper Scanner
        </div>
        <div style={{ display:"flex", gap:4 }}>
          <Badge variant="live">Massive</Badge>
          <Badge variant="live">Finviz</Badge>
          {dataSource==="live" && lastUpdate && <Badge variant="live">{lastUpdate}</Badge>}
          {dataSource==="mock" && <Badge variant="default">MOCK</Badge>}
          {dataSource==="error" && <Badge variant="pump">ERROR</Badge>}
        </div>
      </div>

      {/* Filter chips */}
      <div style={{ display:"flex", gap:3, padding:"5px 10px", background:"#0d1117",
        borderBottom:"1px solid #1e2d3d", flexShrink:0, flexWrap:"wrap" }}>
        {filters.map(f => {
          const isMdp = f === "⬡ MDP";
          const isPump = f === "⚠ Pump";
          const isOn = isMdp ? mdpFilter : (!mdpFilter && activeFilter === f);
          return (
            <button key={f} onClick={() => {
              if (isMdp) { setMdpFilter(!mdpFilter); setActiveFilter("All"); return; }
              setMdpFilter(false);
              setActiveFilter(f);
            }} style={{
              fontSize:8, fontWeight:600, padding:"2px 6px", borderRadius:3, cursor:"pointer",
              fontFamily:"inherit", letterSpacing:"0.05em", textTransform:"uppercase",
              border: isOn
                ? isMdp ? "1px solid rgba(249,115,22,0.35)" : isPump ? "1px solid rgba(245,166,35,0.28)" : "1px solid rgba(34,211,238,0.28)"
                : "1px solid #1e2d3d",
              background: isOn
                ? isMdp ? "rgba(249,115,22,0.07)" : isPump ? "rgba(245,166,35,0.07)" : "rgba(34,211,238,0.07)"
                : "transparent",
              color: isOn
                ? isMdp ? "#f97316" : isPump ? "#f5a623" : "#22d3ee"
                : "#3d5166",
            }}>{f}</button>
          );
        })}
      </div>

      {/* Col headers */}
      <div style={{ display:"grid", gridTemplateColumns:colGrid, padding:"4px 12px",
        background:"#131920", borderBottom:"1px solid #1e2d3d", gap:4, flexShrink:0 }}>
        {["#","Sym","Float","PM Rot%","PM Gain%","PMH Painted","Grade","Score"].map((h,i) => (
          <span key={h} style={{ fontSize:7, fontWeight:700, color:"#3d5166",
            textTransform:"uppercase", letterSpacing:"0.07em",
            textAlign: i>=2 && i<=4 ? "right" : i===6 ? "center" : "left" }}>{h}</span>
        ))}
      </div>

      <div style={S.pscroll}>
        {visible.map((r, idx) => {
          const isSel = selected === r.rank;
          const isMdp = r.tags.includes("MDP");
          const isPump = r.tags.includes("Pump");
          return (
            <div key={r.sym} onClick={() => setSelected(r.rank)} style={{
              display:"grid", gridTemplateColumns:colGrid,
              padding: isSel||isMdp||isPump ? "7px 12px 7px 10px" : "7px 12px",
              borderBottom:"1px solid rgba(30,45,61,0.5)",
              borderLeft: isSel ? "2px solid #22d3ee" : isMdp ? "2px solid #f97316" : isPump ? "2px solid rgba(245,166,35,0.45)" : "none",
              background: isSel ? "#131920" : isMdp ? "rgba(249,115,22,0.025)" : "transparent",
              cursor:"pointer", gap:4, alignItems:"center",
              transition:"background 0.1s",
            }}>
              <span style={{ fontSize:9, color:"#3d5166", fontWeight:600 }}>{r.rank}</span>
              <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <span style={{ fontWeight:800, fontSize:13, color:"#e8eef5", letterSpacing:"-0.01em", lineHeight:1 }}>{r.sym}</span>
                <div style={{ display:"flex", gap:3, flexWrap:"wrap" }}>
                  {r.tags.filter(t=>t!=="MDP").map(t=><Tag key={t} type={t}/>)}
                  {r.tags.includes("MDP") && <MdpFlag/>}
                </div>
              </div>
              <span style={{ fontSize:10, fontWeight:600, color: parseFloat(r.float)<20?"#f5a623":"#7a90a4", fontVariantNumeric:"tabular-nums" }}>{r.float}</span>
              <span style={{ fontSize:10, fontWeight:600, color: parseFloat(r.rotation)>50?"#f5a623":"#7a90a4", textAlign:"right", fontVariantNumeric:"tabular-nums" }}>{r.rotation}</span>
              <span style={{ fontSize:10, fontWeight:600, color: r.gainPos?"#00d68f":"#ff4d6a", textAlign:"right", fontVariantNumeric:"tabular-nums" }}>{r.gain}</span>
              <div style={{ display:"flex", flexDirection:"column", gap:2 }}>
                <span style={{ display:"inline-flex", alignItems:"center", gap:3, fontSize:8, fontWeight:700,
                  padding:"1px 5px", borderRadius:3, letterSpacing:"0.05em", textTransform:"uppercase", width:"fit-content",
                  background: r.pmhPainted?"rgba(0,214,143,0.1)":"rgba(61,81,102,0.3)",
                  color: r.pmhPainted?"#00d68f":"#3d5166",
                  border: `1px solid ${r.pmhPainted?"rgba(0,214,143,0.25)":"rgba(61,81,102,0.4)"}` }}>
                  {r.pmhPainted?"✓ Painted":"✗ Not yet"}
                </span>
                <span style={{ fontSize:9, fontWeight:700, color:"#f5a623", fontVariantNumeric:"tabular-nums" }}>PMH {r.pmhLevel}</span>
              </div>
              <div style={{ display:"flex", justifyContent:"center" }}><Grade g={r.grade}/></div>
              <ScoreBar pct={r.score} color={scoreBarColor(r)} score={r.score} trackColor={scoreColor(r)}/>
            </div>
          );
        })}
      </div>

      <TWSTip>
        <strong style={{ color:"#22d3ee" }}>→ TWS</strong>
        <span> Orange border = MDP candidate · PMH level = key resistance · Grade A = highest conviction</span>
      </TWSTip>
    </div>
  );
}

// ─────────────────────────────────────────────
// PANEL 2 — CATALYST RATER
// ─────────────────────────────────────────────
function CatalystRater({ catalystRows, dataSource }) {
  const badgeStyle = {
    mdp:  { bg:"rgba(249,115,22,0.07)",  color:"#f97316", border:"rgba(249,115,22,0.22)",  label:"⬡ MDP",    anim:true  },
    pa:   { bg:"rgba(245,166,35,0.1)",   color:"#f5a623", border:"rgba(245,166,35,0.32)",  label:"⚠ Active"  },
    warm: { bg:"rgba(245,166,35,0.1)",   color:"#f5a623", border:"rgba(245,166,35,0.28)",  label:"Warm"      },
    cool: { bg:"rgba(77,159,255,0.1)",   color:"#4d9fff", border:"rgba(77,159,255,0.22)",  label:"Cool"      },
    pf:   { bg:"rgba(255,77,106,0.08)",  color:"#ff4d6a", border:"rgba(255,77,106,0.22)",  label:"⚠ Fading"  },
    hot:  { bg:"rgba(255,77,106,0.1)",   color:"#ff4d6a", border:"rgba(255,77,106,0.28)",  label:"🔥 Hot"     },
  };

  const trackColor = (t) => t==="MDP"?"#f97316":t==="P"?"#f5a623":t==="C1"?"#4d9fff":"#7a90a4";

  return (
    <div style={{ ...S.panel }}>
      <div style={S.ph}>
        <div style={{ fontSize:9, fontWeight:700, letterSpacing:"0.12em", textTransform:"uppercase", color:"#7a90a4", display:"flex", alignItems:"center", gap:5 }}>
          <span style={{ color:"#22d3ee" }}>◉</span> Catalyst Rater
        </div>
        <Badge variant="ai">AI Scored</Badge>
      </div>

      {/* Alert bars */}
      {[
        { variant:"mdp", msg:"NKTR MDP — basing above half-spike $6.21 · Vol 18.2M · Window in 48min" },
        { variant:"green", msg:"NKTR 94 — strongest catalyst · FDA approval · Grade A · PMH painted $9.42" },
        { variant:"amber", msg:"XTIA pump active · RVOL 38x · rotation 388% · No news · Score 88" },
      ].map((a,i) => {
        const colors = {
          mdp:   { bg:"rgba(249,115,22,0.05)",  border:"rgba(249,115,22,0.22)",  dot:"#f97316", text:"#f97316" },
          green: { bg:"rgba(0,214,143,0.05)",    border:"rgba(0,214,143,0.15)",   dot:"#00d68f", text:"#00d68f" },
          amber: { bg:"rgba(245,166,35,0.05)",   border:"rgba(245,166,35,0.18)",  dot:"#f5a623", text:"#f5a623" },
        }[a.variant];
        return (
          <div key={i} style={{ margin: i===0?"6px 12px 0":"3px 12px 0", borderRadius:4, padding:"4px 10px",
            fontSize:8, fontWeight:600, display:"flex", alignItems:"center", gap:5, flexShrink:0,
            background:colors.bg, border:`1px solid ${colors.border}`, color:colors.text }}>
            <Dot color={colors.dot} size={4}/>
            {a.msg}
          </div>
        );
      })}

      <div style={{ ...S.pscroll, marginTop:4 }}>
        {catalystRows.map(r => {
          const b = badgeStyle[r.badge];
          const isMdp = r.track==="MDP";
          const isPump = r.track==="P";
          return (
            <div key={r.sym} style={{
              display:"flex", alignItems:"center", padding:"7px 12px", gap:8, cursor:"pointer",
              borderBottom:"1px solid rgba(30,45,61,0.4)",
              borderLeft: isMdp?"2px solid #f97316":isPump?"2px solid rgba(245,166,35,0.32)":"none",
              paddingLeft: isMdp||isPump ? 10 : 12,
              background: isMdp?"rgba(249,115,22,0.02)":"transparent",
              transition:"background 0.1s",
            }}>
              <span style={{ fontWeight:800, fontSize:12, minWidth:40, letterSpacing:"-0.01em", color:trackColor(r.track) }}>{r.sym}</span>
              <span style={{ fontSize:7, fontWeight:700, minWidth:16, color: isMdp?"#f97316":isPump?"#f5a623":"#3d5166", textTransform:"uppercase" }}>{r.track}</span>
              <div style={{ flex:1, display:"flex", flexDirection:"column", gap:3 }}>
                <div style={{ height:4, background:"#131920", borderRadius:2, overflow:"hidden" }}>
                  <div style={{ width:`${r.barPct}%`, height:"100%", background:r.barColor, borderRadius:2 }}/>
                </div>
                <span style={{ fontSize:7, color:"#3d5166" }}>{r.factors}</span>
              </div>
              <span style={{ fontSize:13, fontWeight:900, minWidth:26, textAlign:"right",
                fontVariantNumeric:"tabular-nums", color:trackColor(r.track) }}>{r.score}</span>
              {b && (
                <span style={{ fontSize:7, fontWeight:700, padding:"2px 5px", borderRadius:3,
                  letterSpacing:"0.05em", textTransform:"uppercase", minWidth:46, textAlign:"center",
                  background:b.bg, color:b.color, border:`1px solid ${b.border}`,
                  ...(b.anim ? { animation:"mdpFlash 2.5s infinite" } : {}) }}>
                  {b.label}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Score breakdown footer */}
      <div style={{ padding:"6px 12px", background:"#131920", borderTop:"1px solid #1e2d3d", flexShrink:0 }}>
        <div style={{ fontSize:8, fontWeight:700, color:"#7a90a4", marginBottom:5, letterSpacing:"0.06em", textTransform:"uppercase" }}>
          NKTR · MDP candidate · 6/6 auto criteria met · chart review in TWS
        </div>
        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
          {[
            {l:"Catalyst",v:"30/30",c:"#00d68f"},{l:"Gap %",v:"19/20",c:"#00d68f"},
            {l:"RVOL",v:"20/20",c:"#00d68f"},{l:"Float",v:"11/15",c:"#f5a623"},
            {l:"Source",v:"14/15",c:"#00d68f"},{l:"PMH",v:"Painted",c:"#00d68f"},
            {l:"Grade",v:"A·MDP",c:"#f97316"},
          ].map(f=>(
            <div key={f.l} style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
              <span style={{ fontSize:7, fontWeight:600, color:"#3d5166", letterSpacing:"0.06em", textTransform:"uppercase" }}>{f.l}</span>
              <span style={{ fontSize:10, fontWeight:700, fontVariantNumeric:"tabular-nums", color:f.c }}>{f.v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// PANEL 3 — MDP WATCH
// ─────────────────────────────────────────────
function MdpWatch({ windowStatus, mdpCandidates }) {
  const dotClass = { y:"#00d68f", n:"#ff4d6a", q:"#f5a623", m:"#3d5166" };
  const dotBg    = { y:"rgba(0,214,143,0.25)", n:"rgba(255,77,106,0.15)", q:"rgba(245,166,35,0.15)", m:"rgba(61,81,102,0.3)" };

  return (
    <div style={{ ...S.panel, borderRight:"none" }}>
      <div style={{ ...S.ph, background:"rgba(249,115,22,0.03)", borderBottomColor:"rgba(249,115,22,0.18)" }}>
        <div style={{ fontSize:9, fontWeight:700, letterSpacing:"0.12em", textTransform:"uppercase", color:"#7a90a4", display:"flex", alignItems:"center", gap:5 }}>
          <span style={{ color:"#f97316" }}>⬡</span> MDP Watch
        </div>
        <Badge variant="mdp">10:30 – 14:00</Badge>
      </div>

      <div style={{ display:"flex", gap:5, padding:"6px 10px", borderBottom:"1px solid #1e2d3d", background:"#131920", flexShrink:0 }}>
        {[{l:"Candidates",v:"2",c:"#f97316"},{l:"Basing",v:"1",c:"#f5a623"},{l:"Watching",v:"1",c:"#22d3ee"},{l:"Triggered",v:"0",c:"#00d68f"}].map(c=>(
          <div key={c.l} style={{ display:"flex", flexDirection:"column", alignItems:"center", background:"#0d1117",
            border:"1px solid #1e2d3d", borderRadius:4, padding:"4px 6px", flex:1 }}>
            <span style={{ fontSize:7, fontWeight:600, color:"#3d5166", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:2 }}>{c.l}</span>
            <span style={{ fontSize:13, fontWeight:800, fontVariantNumeric:"tabular-nums", color:c.c }}>{c.v}</span>
          </div>
        ))}
      </div>

      <div style={S.pscroll}>
        {mdpCandidates.map(card => {
          const isBasing = card.status==="basing";
          return (
            <div key={card.sym} style={{ margin:"8px 10px", borderRadius:6, overflow:"hidden",
              border: isBasing?"1px solid rgba(249,115,22,0.22)":"1px solid rgba(34,211,238,0.2)" }}>

              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"8px 10px 5px" }}>
                <div style={{ display:"flex", alignItems:"center", gap:7 }}>
                  <span style={{ fontSize:15, fontWeight:900, letterSpacing:"-0.02em", color: isBasing?"#f97316":"#22d3ee" }}>{card.sym}</span>
                  <Tag type={card.tag}/>
                </div>
                <span style={{ fontSize:8, fontWeight:700, padding:"2px 7px", borderRadius:3, letterSpacing:"0.06em", textTransform:"uppercase",
                  background: isBasing?"rgba(249,115,22,0.07)":"rgba(34,211,238,0.07)",
                  color: isBasing?"#f97316":"#22d3ee",
                  border: `1px solid ${isBasing?"rgba(249,115,22,0.22)":"rgba(34,211,238,0.2)"}` }}>
                  {isBasing?"⬡ Basing":"👁 Watch"}
                </span>
              </div>

              <div style={{ padding:"0 10px 6px" }}>
                <div style={{ fontSize:7, fontWeight:700, color:"#3d5166", textTransform:"uppercase", letterSpacing:"0.09em", padding:"4px 0 3px" }}>Auto-detected signals</div>
                {card.autoSignals.map((sig,i)=>(
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:6, padding:"3px 0", borderBottom:"1px solid rgba(30,45,61,0.3)" }}>
                    <div style={{ width:8, height:8, borderRadius:"50%", flexShrink:0,
                      background:dotBg[sig.state], border:`1.5px solid ${dotClass[sig.state]}` }}/>
                    <span style={{ flex:1, fontSize:9, color:"#7a90a4" }}>{sig.label}</span>
                    <span style={{ fontSize:6, fontWeight:700, padding:"1px 3px", borderRadius:2,
                      background:"rgba(34,211,238,0.08)", color:"#22d3ee", border:"1px solid rgba(34,211,238,0.18)", flexShrink:0 }}>AUTO</span>
                    <span style={{ fontSize:9, fontWeight:700, textAlign:"right", minWidth:52,
                      color: sig.state==="y"?"#00d68f":sig.state==="n"?"#ff4d6a":"#f5a623" }}>{sig.value}</span>
                  </div>
                ))}
                <div style={{ fontSize:7, fontWeight:700, color:"#3d5166", textTransform:"uppercase", letterSpacing:"0.09em", padding:"4px 0 3px", borderTop:"1px solid rgba(30,45,61,0.5)", marginTop:4 }}>Requires your judgment in TWS</div>
                {card.manualSignals.map((sig,i)=>(
                  <div key={i} style={{ display:"flex", alignItems:"center", gap:6, padding:"3px 0" }}>
                    <div style={{ width:8, height:8, borderRadius:"50%", flexShrink:0, background:"rgba(61,81,102,0.3)", border:"1.5px solid #3d5166" }}/>
                    <span style={{ flex:1, fontSize:9, color:"#7a90a4" }}>{sig.label}</span>
                    <span style={{ fontSize:6, fontWeight:700, padding:"1px 3px", borderRadius:2,
                      background:"rgba(61,81,102,0.2)", color:"#3d5166", border:"1px solid rgba(61,81,102,0.35)", flexShrink:0 }}>MANUAL</span>
                    <span style={{ fontSize:9, fontWeight:700, textAlign:"right", minWidth:52, color:"#3d5166", fontStyle:"italic" }}>{sig.value}</span>
                  </div>
                ))}
              </div>

              {/* Half-spike bar */}
              <div style={{ padding:"5px 10px 4px", borderTop:"1px solid rgba(30,45,61,0.4)" }}>
                <div style={{ fontSize:8, fontWeight:600, color:"#3d5166", marginBottom:4, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <span>{card.spike.label}</span>
                  <span style={{ color:"#00d68f", fontWeight:700 }}>Held ✓</span>
                </div>
                <div style={{ position:"relative", height:6, background:"#090c0f", borderRadius:3, overflow:"visible" }}>
                  <div style={{ width:`${card.spike.fillPct}%`, height:"100%", borderRadius:3,
                    background: card.spike.gradient || "linear-gradient(90deg,#f97316,#fb923c)" }}/>
                  <div style={{ position:"absolute", top:-3, bottom:-3, left:"50%", width:1.5, background:"#3d5166" }}/>
                </div>
                <div style={{ display:"flex", justifyContent:"space-between", marginTop:3, fontSize:7, fontVariantNumeric:"tabular-nums" }}>
                  <span style={{ color:"#3d5166" }}>Open {card.spike.open}</span>
                  <span style={{ color:"#3d5166" }}>½ {card.spike.half}</span>
                  <span style={{ color:"#3d5166" }}>High {card.spike.high}</span>
                </div>
              </div>

              {/* Card bottom */}
              <div style={{ padding:"6px 10px", borderTop:`1px solid ${isBasing?"rgba(249,115,22,0.12)":"rgba(34,211,238,0.12)"}`,
                background: isBasing?"rgba(249,115,22,0.04)":"rgba(34,211,238,0.03)",
                display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                <div>
                  <div style={{ fontSize:14, fontWeight:900, fontVariantNumeric:"tabular-nums", color: isBasing?"#f97316":"#22d3ee" }}>{card.score}</div>
                  <div style={{ fontSize:8, color:"#3d5166", fontWeight:500 }}>{isBasing?"auto + 1 manual":"need 45min+ base"}</div>
                </div>
                <div style={{ fontSize:9, color:"#7a90a4", textAlign:"right", lineHeight:1.5 }}>
                  {isBasing
                    ? <><span>Risk: </span><strong style={{ color:"#e8eef5", fontWeight:700 }}>{card.stop}</strong><span> · Entry: </span><strong style={{ color:"#e8eef5" }}>{card.entry}</strong><br/><span>Wait for window — </span><strong style={{ color:"#e8eef5" }}>{card.countdownLabel}</strong></>
                    : <><span>Wait for base </span><strong style={{ color:"#e8eef5" }}>&gt;45min</strong><br/><span>Half size if enters window early</span></>
                  }
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <TWSTip mdp>
        <strong style={{ color:"#f97316" }}>→ MDP</strong>
        <span> Window 10:30–14:00 · Chart review always in TWS · Stop = below base support</span>
      </TWSTip>
    </div>
  );
}

// ─────────────────────────────────────────────
// PANEL 4 — PUMP SCANNER
// ─────────────────────────────────────────────
function PumpScanner({ pumps, dataSource }) {
  const badgeMap = {
    active: { bg:"rgba(245,166,35,0.1)",  color:"#f5a623", border:"rgba(245,166,35,0.32)", label:"⚠ Active" },
    fading: { bg:"rgba(255,77,106,0.08)", color:"#ff4d6a", border:"rgba(255,77,106,0.22)", label:"⚠ Fading" },
    watch:  { bg:"rgba(77,159,255,0.1)",  color:"#4d9fff", border:"rgba(77,159,255,0.22)", label:"Watch"    },
  };
  const colGrid = "18px 48px 58px 44px 44px 40px 1fr 46px";

  return (
    <div style={{ ...S.panel, borderBottom:"none" }}>
      <div style={S.ph}>
        <div style={{ fontSize:9, fontWeight:700, letterSpacing:"0.12em", textTransform:"uppercase", color:"#7a90a4", display:"flex", alignItems:"center", gap:5 }}>
          <span style={{ color:"#f5a623" }}>⚠</span> Pump Scanner
        </div>
        <Badge variant="pump">Auto-detect</Badge>
      </div>

      {/* Summary */}
      <div style={{ display:"flex", gap:5, padding:"6px 10px", borderBottom:"1px solid #1e2d3d", background:"#131920", flexShrink:0 }}>
        {[{l:"Active",v:"4",c:"#f5a623"},{l:"Avg RVOL",v:"26x",c:"#f5a623"},{l:"China inc",v:"3",c:"#f5a623"},{l:"Fading",v:"1",c:"#ff4d6a"}].map(c=>(
          <div key={c.l} style={{ display:"flex", flexDirection:"column", alignItems:"center", background:"#0d1117",
            border:"1px solid #1e2d3d", borderRadius:4, padding:"4px 6px", flex:1 }}>
            <span style={{ fontSize:7, fontWeight:600, color:"#3d5166", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:2 }}>{c.l}</span>
            <span style={{ fontSize:13, fontWeight:800, fontVariantNumeric:"tabular-nums", color:c.c }}>{c.v}</span>
          </div>
        ))}
      </div>

      <div style={{ display:"grid", gridTemplateColumns:colGrid, padding:"3px 12px",
        borderBottom:"1px solid #1e2d3d", background:"#131920", flexShrink:0, gap:4 }}>
        {["#","Sym","Country","Float","RVOL","Prior","Chg","Score"].map((h,i)=>(
          <span key={h} style={{ fontSize:7, fontWeight:700, color:"#3d5166", textTransform:"uppercase", letterSpacing:"0.07em", textAlign:i===6?"right":"left" }}>{h}</span>
        ))}
      </div>

      <div style={S.pscroll}>
        {pumps.map(r => {
          const b = badgeMap[r.badge];
          const isActive = r.badge==="active";
          const isFading = r.badge==="fading";
          return (
            <div key={r.sym} style={{
              display:"grid", gridTemplateColumns:colGrid, gap:4,
              padding: isActive||isFading ? "6px 12px 6px 10px" : "6px 12px",
              borderBottom:"1px solid rgba(30,45,61,0.4)", cursor:"pointer", alignItems:"center",
              borderLeft: isActive?"2px solid rgba(245,166,35,0.5)":isFading?"2px solid rgba(255,77,106,0.4)":"none",
              transition:"background 0.1s",
            }}>
              <span style={{ fontSize:9, color:"#3d5166", fontWeight:600 }}>{r.rank}</span>
              <span style={{ fontWeight:800, fontSize:12, letterSpacing:"-0.01em",
                color: isFading?"#ff4d6a":isActive?"#f5a623":"#4d9fff" }}>{r.sym}</span>
              <span style={{ fontSize:8, fontWeight:600, color:"#f5a623" }}>{r.country}</span>
              <span style={{ fontSize:9, fontVariantNumeric:"tabular-nums", fontWeight:600, color:"#f5a623" }}>{r.float}</span>
              <span style={{ fontSize:9, fontVariantNumeric:"tabular-nums", fontWeight:600, color: parseInt(r.rvol)>20?"#f5a623":"#7a90a4" }}>{r.rvol}</span>
              <span style={{ fontSize:9, fontVariantNumeric:"tabular-nums", fontWeight:700, color:"#f5a623" }}>{r.prior}</span>
              <span style={{ fontSize:11, fontWeight:800, fontVariantNumeric:"tabular-nums", color: r.chgPos?"#00d68f":"#ff4d6a", textAlign:"right" }}>{r.chg}</span>
              <span style={{ fontSize:7, fontWeight:700, padding:"2px 5px", borderRadius:3, letterSpacing:"0.05em",
                textTransform:"uppercase", textAlign:"right",
                background:b.bg, color:b.color, border:`1px solid ${b.border}` }}>{b.label}</span>
            </div>
          );
        })}
      </div>

      <TWSTip>
        <strong style={{ color:"#22d3ee" }}>→ TWS</strong>
        <span> Load pump ticker · hollow ask + large bid wall = coordinated signal</span>
      </TWSTip>
    </div>
  );
}

// ─────────────────────────────────────────────
// PANEL 5 — NEWS FEED (LIVE via Finnhub)

function NewsFeed({ watchlist: externalWatchlist, dataSource: parentDataSource }) {
  const [activeTab, setActiveTab] = useState("All");
  const [news, setNews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const isMock = FINNHUB_API_KEY === "YOUR_FINNHUB_API_KEY_HERE";
  // Use externally-discovered watchlist from live gapper data, fall back to default
  const watchlist = externalWatchlist?.length ? externalWatchlist : FALLBACK_WATCHLIST;

  const fetchNews = useCallback(async () => {
    if (isMock) { setNews(MOCK_NEWS); setLoading(false); return; }
    try {
      const today     = new Date().toISOString().slice(0,10);
      const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10);
      const topTen    = watchlist.slice(0, NEWS_TICKER_LIMIT);
      const results   = await Promise.allSettled(
        topTen.map(sym =>
          fetch(`https://finnhub.io/api/v1/company-news?symbol=${sym}&from=${yesterday}&to=${today}&token=${FINNHUB_API_KEY}`)
            .then(r=>r.json())
            .then(articles=>(Array.isArray(articles)?articles:[]).slice(0,3).map(a=>({...a,sym})))
        )
      );
      const all = results
        .filter(r=>r.status==="fulfilled")
        .flatMap(r=>r.value)
        .filter(a=>a.headline)
        .sort((a,b)=>b.datetime-a.datetime)
        .slice(0,30);
      setNews(all.map(a=>({
        sym: a.sym,
        time: new Date(a.datetime*1000).toLocaleTimeString("en-US",{hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"America/New_York"}),
        headline: a.headline,
        source: a.source||"Finnhub",
        tag: detectTag(a.headline, a.sym),
        url: a.url,
      })));
      setError(null);
    } catch(e) {
      setError("News fetch failed — check API key");
    } finally {
      setLoading(false);
    }
  }, [isMock, watchlist]);

  useEffect(() => {
    fetchNews();
    const iv = setInterval(fetchNews, NEWS_REFRESH_MS);
    return () => clearInterval(iv);
  }, [fetchNews]);

  const TABS = ["All","FDA","Earn","SEC 8-K","⚠ Pump","⬡ MDP"];

  // For pump/MDP tab filters: detect dynamically from tag rather than hardcoded syms
  const filtered = news.filter(n => {
    if (activeTab === "All") return true;
    if (activeTab === "FDA") return n.tag === "FDA";
    if (activeTab === "Earn") return n.tag === "Earn";
    if (activeTab === "SEC 8-K") return n.tag === "8-K";
    if (activeTab === "⚠ Pump") return n.tag === "Pump";
    if (activeTab === "⬡ MDP") return n.tag === "MDP";
    return true;
  });

  // Status strip text
  const scanStatusLabel = isMock
    ? "· MOCK DATA"
    : scanStatus === "live"
      ? `· ${scanCount} gappers <$500M · top 10 for news · ${lastScan ? `scanned ${lastScan}` : "scanning..."}`
      : scanStatus === "fallback"
        ? "· fallback watchlist · scan returned no results"
        : "· scanning...";

  const scanStatusColor = isMock || scanStatus === "fallback" ? "#f5a623"
    : scanStatus === "live" ? "#00d68f" : "#3d5166";

  return (
    <div style={{ ...S.panel, borderBottom:"none" }}>
      <div style={S.ph}>
        <div style={{ fontSize:9, fontWeight:700, letterSpacing:"0.12em", textTransform:"uppercase", color:"#7a90a4", display:"flex", alignItems:"center", gap:5, flexWrap:"wrap" }}>
          <span style={{ color:"#22d3ee" }}>◈</span> News Feed
          {isMock && <span style={{ fontSize:7, color:"#f5a623", fontWeight:600 }}>· MOCK DATA</span>}
          {!isMock && parentDataSource==="live" && <span style={{ fontSize:7, color:"#00d68f", fontWeight:600 }}>· {watchlist.length} tickers · live</span>}
          {!isMock && parentDataSource==="error" && <span style={{ fontSize:7, color:"#ff4d6a", fontWeight:600 }}>· backend error · fallback list</span>}
        </div>
        <div style={{ display:"flex", gap:4 }}>
          <Badge variant="live">Finnhub</Badge>
          <Badge variant="live">EDGAR</Badge>
        </div>
      </div>

      {/* Watchlist ticker strip */}
      {!isMock && watchlist.length > 0 && (
        <div style={{ padding:"3px 10px", background:"rgba(0,214,143,0.03)",
          borderBottom:"1px solid rgba(0,214,143,0.08)", flexShrink:0,
          display:"flex", gap:4, flexWrap:"wrap", alignItems:"center" }}>
          <span style={{ fontSize:7, color:"#3d5166", fontWeight:600, textTransform:"uppercase", letterSpacing:"0.07em" }}>Watching:</span>
          {watchlist.slice(0, NEWS_TICKER_LIMIT).map(sym => (
            <span key={sym} style={{ fontSize:7, fontWeight:700, padding:"1px 4px", borderRadius:2,
              background:"rgba(34,211,238,0.06)", color:"#22d3ee", border:"1px solid rgba(34,211,238,0.14)" }}>
              {sym}
            </span>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div style={{ display:"flex", borderBottom:"1px solid #1e2d3d", background:"#0d1117", flexShrink:0 }}>
        {TABS.map(tab => {
          const isMdpTab = tab.includes("MDP");
          const isPumpTab = tab.includes("Pump");
          const isOn = activeTab === tab;
          return (
            <button key={tab} onClick={() => setActiveTab(tab)} style={{
              flex:1, textAlign:"center", padding:"5px 2px", fontSize:8, fontWeight:700,
              letterSpacing:"0.07em", textTransform:"uppercase", cursor:"pointer",
              fontFamily:"inherit",
              borderRight:"1px solid #1e2d3d",
              borderBottom: isOn
                ? `1px solid ${isMdpTab?"#f97316":isPumpTab?"#f5a623":"#22d3ee"}`
                : "1px solid transparent",
              background: isOn
                ? isMdpTab?"rgba(249,115,22,0.04)":isPumpTab?"rgba(245,166,35,0.04)":"rgba(34,211,238,0.04)"
                : "transparent",
              color: isOn
                ? isMdpTab?"#f97316":isPumpTab?"#f5a623":"#22d3ee"
                : "#3d5166",
              transition:"all 0.1s",
              border:"none",
              borderRight:"1px solid #1e2d3d",
              borderBottom: isOn
                ? `2px solid ${isMdpTab?"#f97316":isPumpTab?"#f5a623":"#22d3ee"}`
                : "2px solid transparent",
            }}>{tab}</button>
          );
        })}
      </div>

      <div style={S.pscroll}>
        {loading && (
          <div style={{ padding:"20px 12px", textAlign:"center", color:"#3d5166", fontSize:9 }}>
            Loading news...
          </div>
        )}
        {error && (
          <div style={{ margin:"6px 12px", padding:"6px 10px", borderRadius:4, fontSize:8,
            background:"rgba(255,77,106,0.05)", border:"1px solid rgba(255,77,106,0.2)", color:"#ff4d6a" }}>
            ⚠ {error}
          </div>
        )}
        {!loading && filtered.map((n,i) => {
          const isPump = n.tag === "Pump";
          const isMdp = n.tag === "MDP";
          const borderLeft = isMdp ? "2px solid #f97316" : isPump ? "2px solid rgba(245,166,35,0.35)" : "2px solid rgba(0,214,143,0.35)";
          return (
            <div key={i} style={{
              display:"flex", alignItems:"flex-start", padding:"6px 12px 6px 10px",
              borderBottom:"1px solid rgba(30,45,61,0.4)", cursor:"pointer", gap:7,
              borderLeft, background: isMdp?"rgba(249,115,22,0.02)":"transparent",
              transition:"background 0.1s",
            }}>
              <span style={{ fontSize:8, color:"#3d5166", minWidth:34, flexShrink:0, marginTop:1,
                fontVariantNumeric:"tabular-nums", fontWeight:500 }}>{n.time}</span>
              <div style={{ flex:1, overflow:"hidden" }}>
                <div style={{ display:"flex", alignItems:"center", gap:5, marginBottom:2 }}>
                  <span style={{ fontSize:11, fontWeight:800, color:"#e8eef5", letterSpacing:"-0.01em" }}>{n.sym}</span>
                  <Tag type={n.tag}/>
                </div>
                <div style={{ fontSize:10, fontWeight:400, color:"#7a90a4", lineHeight:1.35, marginBottom:3,
                  whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{n.headline}</div>
                <div style={{ display:"flex", gap:5, alignItems:"center" }}>
                  <span style={{ fontSize:8, color:"#3d5166", fontWeight:500 }}>{n.source}</span>
                </div>
              </div>
            </div>
          );
        })}
        {!loading && filtered.length === 0 && (
          <div style={{ padding:"20px 12px", textAlign:"center", color:"#3d5166", fontSize:9 }}>
            No news for this filter
          </div>
        )}
      </div>

      <TWSTip>
        <strong style={{ color:"#22d3ee" }}>→ TWS</strong>
        <span> Auto-scan: top 20 gappers &lt;$500M · news for top 10 · scan every 5min · news every 60s</span>
      </TWSTip>
    </div>
  );
}

// Mock news for when no API key is provided
const MOCK_NEWS = [
  { sym:"NKTR", time:"10:41", headline:"Consolidating $6.80–7.10 above ½-spike $6.21 · 58min base · RVOL 44x · window in 48min", source:"MDP Monitor", tag:"MDP" },
  { sym:"NKTR", time:"07:42", headline:"FDA grants full approval for Rezpegaldesleukin in metastatic melanoma — first-line treatment", source:"SEC EDGAR 8-K", tag:"FDA" },
  { sym:"SOUN", time:"10:38", headline:"Held above ½-spike $6.88 · base only 34min · needs 45min+ · watch for window entry", source:"MDP Monitor", tag:"MDP" },
  { sym:"XTIA", time:"08:12", headline:"No news — Cayman Islands inc · Unknown auditor · Stocktwits +840% in 1hr", source:"EDGAR · Finnhub", tag:"Pump" },
  { sym:"GME",  time:"08:01", headline:"Q1 EPS $0.12 vs est. $0.04 · board approves $100M bitcoin treasury strategy", source:"Finnhub", tag:"Earn" },
  { sym:"CLPS", time:"08:44", headline:"S-3 shelf registration filed — potential dilution · China inc · 4 prior pumps in 12 months", source:"SEC EDGAR", tag:"Pump" },
];

// ─────────────────────────────────────────────
// PANEL 6 — MDP CHECKLIST
// ─────────────────────────────────────────────
const CHECKLIST_ITEMS = [
  { section:"Auto-detected · 6 of 6 computable", items:[
    { label:"Volume 5M+ shares",                    badge:"auto",   value:"18.2M ✓",        valueClass:"ok",   defaultState:"checked" },
    { label:"Strong catalyst — rater score 70+",    badge:"auto",   value:"94 ✓",            valueClass:"ok",   defaultState:"checked" },
    { label:"Price above open ($5.18)",             badge:"auto",   value:"$8.74 ✓",         valueClass:"ok",   defaultState:"checked" },
    { label:"Price held above ½-spike ($6.21)",     badge:"auto",   value:"$8.74 ✓",         valueClass:"ok",   defaultState:"checked" },
    { label:"Tight range 45min+ — base forming",    badge:"auto",   value:"58min · building",valueClass:"warn", defaultState:"warn"    },
    { label:"Float — lower = stronger signal",      badge:"auto",   value:"124M · large",    valueClass:"warn", defaultState:"warn"    },
  ]},
  { section:"Requires judgment · check in TWS", items:[
    { label:"Clean chart — no heavy overhead supply",badge:"manual", value:"→ TWS",           valueClass:"dim",  defaultState:"unchecked" },
  ]},
  { section:"Entry & exit rules · updated for current market", items:[
    { label:"Wait for window open — 10:30 AM ET",   badge:"auto",   value:"48min",           valueClass:"warn", defaultState:"unchecked", id:"windowWait" },
    { label:"Entry on breakout of base range",       badge:"manual", value:"BO ~$7.20",       valueClass:"",     defaultState:"unchecked" },
    { label:"Stop below base support level",         badge:"manual", value:"~$6.55",          valueClass:"",     defaultState:"unchecked" },
    { label:"Size: full if 5/6 auto · half if 4/6", badge:"auto",   value:"Full size ✓",     valueClass:"ok",   defaultState:"unchecked" },
    { label:"Sell all by 14:00 ET — hard cutoff",   badge:"auto",   value:"Alert set",       valueClass:"warn", defaultState:"unchecked" },
  ]},
];

function MdpChecklist({ windowStatus }) {
  const allItems = CHECKLIST_ITEMS.flatMap(s => s.items);
  const [states, setStates] = useState(() => allItems.map(i => i.defaultState));

  const cycle = (idx) => {
    const order = ["unchecked","checked","failed","warn"];
    setStates(prev => {
      const next = [...prev];
      next[idx] = order[(order.indexOf(prev[idx]) + 1) % order.length];
      return next;
    });
  };

  const toggleIcon = { checked:"✓", failed:"✗", warn:"?", unchecked:"" };
  const toggleStyle = (s) => ({
    checked:   { bg:"rgba(0,214,143,0.1)",  color:"#00d68f", border:"rgba(0,214,143,0.3)"  },
    failed:    { bg:"rgba(255,77,106,0.1)", color:"#ff4d6a", border:"rgba(255,77,106,0.3)" },
    warn:      { bg:"rgba(245,166,35,0.1)", color:"#f5a623", border:"rgba(245,166,35,0.3)" },
    unchecked: { bg:"#131920",              color:"#3d5166", border:"#1e2d3d"               },
  }[s]);

  const valueColor = (cls, state) => {
    if (cls==="ok")   return "#00d68f";
    if (cls==="warn") return "#f5a623";
    if (cls==="fail") return "#ff4d6a";
    if (cls==="dim")  return "#3d5166";
    return "#7a90a4";
  };

  // Window timing bar progress
  const barPct = windowStatus.barPct || 0;
  const barColor = windowStatus.phase === "live" ? "linear-gradient(90deg,#f97316,#fb923c)"
    : windowStatus.phase === "closed" ? "#ff4d6a" : "rgba(245,166,35,0.3)";

  let globalIdx = 0;

  return (
    <div style={{ ...S.panel, borderRight:"none", borderBottom:"none" }}>
      <div style={{ ...S.ph, background:"rgba(249,115,22,0.03)", borderBottomColor:"rgba(249,115,22,0.15)" }}>
        <div style={{ fontSize:9, fontWeight:700, letterSpacing:"0.12em", textTransform:"uppercase", color:"#7a90a4", display:"flex", alignItems:"center", gap:5 }}>
          <span style={{ color:"#f97316" }}>⬡</span> MDP Checklist
        </div>
        <Badge variant="mdp">NKTR</Badge>
      </div>

      {/* Selected header */}
      <div style={{ padding:"8px 12px", background:"rgba(249,115,22,0.04)", borderBottom:"1px solid rgba(249,115,22,0.15)",
        display:"flex", justifyContent:"space-between", alignItems:"center", flexShrink:0 }}>
        <div>
          <div style={{ fontSize:16, fontWeight:900, color:"#f97316", letterSpacing:"-0.02em" }}>NKTR</div>
          <div style={{ fontSize:8, color:"#7a90a4", marginTop:2 }}>Float 124M · $8.74 · FDA Approval</div>
        </div>
        <div style={{ textAlign:"right" }}>
          <div style={{ fontSize:16, fontWeight:900, color:"#f97316" }}>6/7</div>
          <div style={{ fontSize:8, color:"#3d5166", fontWeight:500 }}>auto · 1 manual pending</div>
        </div>
      </div>

      {/* Window timing bar */}
      <div style={{ padding:"5px 12px", background:"#131920", borderBottom:"1px solid #1e2d3d",
        display:"flex", alignItems:"center", gap:8, flexShrink:0 }}>
        <span style={{ fontSize:8, fontWeight:700, color:"#3d5166", textTransform:"uppercase", letterSpacing:"0.08em" }}>Window</span>
        <div style={{ flex:1, height:5, background:"#090c0f", borderRadius:3, overflow:"hidden", position:"relative" }}>
          <div style={{ width:`${barPct}%`, height:"100%", borderRadius:3, background:barColor, transition:"width 1s linear" }}/>
        </div>
        <span style={{ fontSize:8, fontWeight:700, fontVariantNumeric:"tabular-nums", color:"#f97316" }}>10:30 ET</span>
        <span style={{ fontSize:8, fontWeight:700, padding:"2px 7px", borderRadius:3, letterSpacing:"0.07em", textTransform:"uppercase",
          background: windowStatus.phase==="live" ? "rgba(0,214,143,0.08)" : windowStatus.phase==="closed" ? "rgba(255,77,106,0.08)" : "rgba(245,166,35,0.08)",
          color: windowStatus.phase==="live" ? "#00d68f" : windowStatus.phase==="closed" ? "#ff4d6a" : "#f5a623",
          border: `1px solid ${windowStatus.phase==="live" ? "rgba(0,214,143,0.25)" : windowStatus.phase==="closed" ? "rgba(255,77,106,0.25)" : "rgba(245,166,35,0.2)"}` }}>
          {windowStatus.phase==="live" ? "LIVE" : windowStatus.phase==="closed" ? "Closed" : "Pre-Window"}
        </span>
      </div>

      <div style={S.pscroll}>
        {CHECKLIST_ITEMS.map(section => (
          <div key={section.section}>
            <div style={{ fontSize:8, fontWeight:700, color:"#3d5166", textTransform:"uppercase", letterSpacing:"0.1em", padding:"6px 12px 3px" }}>
              {section.section}
            </div>
            {section.items.map(item => {
              const idx = globalIdx++;
              const state = states[idx];
              const ts = toggleStyle(state);
              return (
                <div key={item.label} style={{ display:"flex", alignItems:"center", padding:"5px 12px", borderBottom:"1px solid rgba(30,45,61,0.3)", gap:8 }}>
                  <div onClick={() => cycle(idx)} style={{
                    width:18, height:18, borderRadius:3, display:"flex", alignItems:"center", justifyContent:"center",
                    fontSize:10, fontWeight:800, cursor:"pointer", flexShrink:0,
                    background:ts.bg, color:ts.color, border:`1px solid ${ts.border}`, transition:"all 0.15s",
                  }}>{toggleIcon[state]}</div>
                  <div style={{ flex:1, fontSize:9, color:state==="checked"?"#3d5166":"#7a90a4",
                    textDecoration:state==="checked"?"line-through":"none" }}>{item.label}</div>
                  <span style={{ fontSize:6, fontWeight:700, padding:"1px 4px", borderRadius:2, flexShrink:0, letterSpacing:"0.04em",
                    background: item.badge==="auto" ? "rgba(34,211,238,0.08)" : "rgba(61,81,102,0.2)",
                    color: item.badge==="auto" ? "#22d3ee" : "#3d5166",
                    border: `1px solid ${item.badge==="auto" ? "rgba(34,211,238,0.18)" : "rgba(61,81,102,0.35)"}` }}>
                    {item.badge.toUpperCase()}
                  </span>
                  <div style={{ fontSize:9, fontWeight:700, fontVariantNumeric:"tabular-nums", textAlign:"right", minWidth:60,
                    color: valueColor(item.valueClass, state) }}>
                    {item.id==="windowWait" && windowStatus.phase==="pre" ? windowStatus.countdown :
                     item.id==="windowWait" && windowStatus.phase==="live" ? "OPEN ✓" :
                     item.id==="windowWait" ? "Closed" : item.value}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div style={{ padding:"5px 12px", background:"rgba(249,115,22,0.07)", borderTop:"1px solid rgba(249,115,22,0.22)",
        fontSize:8, fontWeight:600, color:"#f97316", display:"flex", alignItems:"center", gap:5, flexShrink:0 }}>
        <Dot color="#f97316" size={4}/>
        NKTR — Base holding above ½-spike · 6/6 auto · Chart check in TWS before entry
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// TOPBAR
// ─────────────────────────────────────────────
function TopBar({ windowStatus, alertsOn, setAlertsOn }) {
  const [clock, setClock] = useState(etClock());
  useEffect(() => {
    const iv = setInterval(() => setClock(etClock()), 1000);
    return () => clearInterval(iv);
  }, []);

  const cdColor = windowStatus.phase==="live" ? "#00d68f" : windowStatus.phase==="closed" ? "#ff4d6a" : "#f5a623";
  const statusLabel = windowStatus.phase==="live" ? `Cutoff ${windowStatus.cutoff}` : windowStatus.phase==="closed" ? "Closed" : "Pre-Window";
  const statusBg = windowStatus.phase==="live" ? "rgba(0,214,143,0.08)" : windowStatus.phase==="closed" ? "rgba(255,77,106,0.08)" : "rgba(245,166,35,0.08)";
  const statusColor = windowStatus.phase==="live" ? "#00d68f" : windowStatus.phase==="closed" ? "#ff4d6a" : "#f5a623";
  const statusBorder = windowStatus.phase==="live" ? "rgba(0,214,143,0.25)" : windowStatus.phase==="closed" ? "rgba(255,77,106,0.25)" : "rgba(245,166,35,0.2)";

  return (
    <div style={S.topbar}>
      {/* Logo */}
      <div style={{ display:"flex", alignItems:"center" }}>
        <span style={{ fontSize:14, fontWeight:900, color:"#22d3ee", letterSpacing:"-0.02em" }}>RJ</span>
        <div style={{ width:1, height:14, background:"#2a3f54", margin:"0 8px" }}/>
        <span style={{ fontSize:9, fontWeight:600, letterSpacing:"0.18em", textTransform:"uppercase", color:"#7a90a4" }}>Intelligence</span>
        <Dot color="#22d3ee" size={5} anim="blink"/>
      </div>

      {/* MDP window indicator */}
      <div style={{ display:"flex", alignItems:"center", gap:6,
        background: windowStatus.phase==="live" ? "rgba(0,214,143,0.07)" : "rgba(249,115,22,0.07)",
        border: `1px solid ${windowStatus.phase==="live" ? "rgba(0,214,143,0.25)" : "rgba(249,115,22,0.22)"}`,
        borderRadius:4, padding:"3px 10px" }}>
        <Dot color={windowStatus.phase==="live" ? "#00d68f" : "#f97316"} size={5}/>
        <span style={{ fontSize:8, fontWeight:700, color:windowStatus.phase==="live"?"#00d68f":"#f97316",
          letterSpacing:"0.09em", textTransform:"uppercase" }}>MDP Window</span>
        <span style={{ fontSize:10, fontWeight:800, color:"#e8eef5", fontVariantNumeric:"tabular-nums", letterSpacing:"0.02em" }}>10:30 – 14:00</span>
        <span style={{ fontSize:10, fontWeight:800, fontVariantNumeric:"tabular-nums", minWidth:36, color:cdColor }}>
          {windowStatus.phase==="live" ? "LIVE" : windowStatus.countdown}
        </span>
        <span style={{ fontSize:8, fontWeight:700, padding:"2px 7px", borderRadius:3, letterSpacing:"0.07em", textTransform:"uppercase",
          background:statusBg, color:statusColor, border:`1px solid ${statusBorder}` }}>{statusLabel}</span>
      </div>

      {/* Right side */}
      <div style={{ display:"flex", alignItems:"center", gap:8 }}>
        <span style={{ fontSize:8, fontWeight:700, padding:"2px 8px", borderRadius:3, letterSpacing:"0.08em", textTransform:"uppercase",
          background:"rgba(34,211,238,0.07)", color:"#22d3ee", border:"1px solid rgba(34,211,238,0.2)" }}>TWS Companion</span>
        <button onClick={() => setAlertsOn(!alertsOn)} style={{
          fontSize:8, fontWeight:700, padding:"2px 8px", borderRadius:3, letterSpacing:"0.07em", textTransform:"uppercase",
          background:"transparent", fontFamily:"inherit", cursor:"pointer",
          color: alertsOn ? "#e8eef5" : "#ff4d6a",
          border: alertsOn ? "1px solid #1e2d3d" : "1px solid rgba(255,77,106,0.3)",
        }}>⚠ Alerts {alertsOn?"ON":"OFF"}</button>
        <div style={{ display:"flex", alignItems:"center", gap:4, fontSize:8, fontWeight:700, color:"#00d68f",
          letterSpacing:"0.1em", textTransform:"uppercase",
          background:"rgba(0,214,143,0.07)", border:"1px solid rgba(0,214,143,0.2)", borderRadius:3, padding:"2px 7px" }}>
          <Dot color="#00d68f" size={4}/>Open
        </div>
        <span style={{ fontSize:10, fontWeight:600, color:"#7a90a4", fontVariantNumeric:"tabular-nums" }}>{clock} ET</span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// ROOT APP
// ─────────────────────────────────────────────
export default function RJTerminal() {
  const [windowStatus, setWindowStatus] = useState(mdpWindowStatus());
  const [alertsOn, setAlertsOn] = useState(true);
  const [mdpFilter, setMdpFilter] = useState(false);

  // Live data from Railway backend
  const { gappers, mdpCandidates, pumps, catalystRows, dataSource, lastUpdate, watchlist } = useLiveData();

  useEffect(() => {
    const iv = setInterval(() => setWindowStatus(mdpWindowStatus()), 1000);
    return () => clearInterval(iv);
  }, []);

  return (
    <div style={S.body}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 2px; }
        ::-webkit-scrollbar-thumb { background: #2a3f54; border-radius: 2px; }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.2} }
        @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:0.3;transform:scale(0.6)} }
        @keyframes mdpFlash { 0%,100%{box-shadow:0 0 0 0 rgba(249,115,22,0.3)} 60%{box-shadow:0 0 0 4px rgba(249,115,22,0)} }
        @keyframes mdpGlow { 0%,100%{border-color:rgba(249,115,22,0.22)} 50%{border-color:rgba(249,115,22,0.5)} }
        button { font-family: 'Inter', -apple-system, sans-serif; }
      `}</style>

      {/* Scanlines overlay */}
      <div style={S.scanlines}/>

      <TopBar windowStatus={windowStatus} alertsOn={alertsOn} setAlertsOn={setAlertsOn}/>

      <div style={S.layout}>
        {/* Row 1 */}
        <GapperScanner mdpFilter={mdpFilter} setMdpFilter={setMdpFilter} gappers={gappers} dataSource={dataSource} lastUpdate={lastUpdate}/>
        <CatalystRater catalystRows={catalystRows} dataSource={dataSource}/>
        <MdpWatch windowStatus={windowStatus} mdpCandidates={mdpCandidates}/>

        {/* Row 2 */}
        <PumpScanner pumps={pumps} dataSource={dataSource}/>
        <NewsFeed watchlist={watchlist} dataSource={dataSource}/>
        <MdpChecklist windowStatus={windowStatus}/>
      </div>
    </div>
  );
}
