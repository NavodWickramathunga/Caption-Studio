"use strict";
const $ = id => document.getElementById(id);
const TTS = window.speechSynthesis;
const ref = $("ref");
const SAVE_KEY = "captionStudio.voice", KEY_STORE = "captionStudio.geminiKey";
let voices = [], starred = new Set(), refURL = null, refFile = null;
let auditionOrder = [], auditionAt = -1, auditioning = false;

/* ============================================================
   Gender by name - the Web Speech API doesn't report it
   ============================================================ */
const FEMALE = new Set(("aria jenny michelle ana ashley cora elizabeth monica sara amber jane nancy emma libby " +
  "sonia maisie natasha freya clara molly luna yan hiumaan xiaoxiao xiaoyi denise eloise vivienne brigitte " +
  "isabella francisca camila elvira dalia salome sofia paloma katja amala louisa ingrid elsa noora swara " +
  "neerja yara zariyah leah mia hoda amina asilia zuri imani nia rehema pallavi sapna nabanita tanishaa " +
  "kalpana gomathi kani venba shruti aarohi kavya sarika heera midori nanami mayu shiori seoyeon sunhi " +
  "jimin gaeul hyunsu premwadee achara pattara thalita yasmin giovanna leticia manuela ines margarida " +
  "raquel fernanda karina veronika svetlana dariya polina daria ekaterina tatyana anu kert liisi kadri " +
  "anna adri mila zofia agnieszka renata vlasta zora viktoria noemi alina ioana mihaela nikolina gabrijela " +
  "dubravka amaya blessica rosa marisa seraphina florence ada nova"
).split(/\s+/));
const MALE = new Set(("guy davis jason tony andrew brian christopher eric roger steffan ryan thomas alfie " +
  "elliot ethan noah oliver liam william connor duncan sam finn james mitchell prabhat madhur mohan kunal " +
  "gagan yunxi yunjian yunyang yunye wanlung danny henry antoine jean remy alain claude thierry maurice " +
  "conrad bernd christoph kasper killian klaus ralf diego jorge liberto alvaro arnau dario elias nil saul " +
  "teo lorenzo gianni calimero benigno cataldo fabiano giuseppe duarte joaquim antonio julio valentino " +
  "keiichiro naoki daichi injoon bongjin gookmin niwat sergey dmitry pavel maxim borys ostap jakub antonin " +
  "marek jozef lukas viktor tamas emil florian razvan goran nikola gabrijel matej rok petar hamed hamid " +
  "moaz shakir bassel taim laith adam"
).split(/\s+/));
const firstName = v => { const m = v.name.replace(/^Microsoft\s+/i,"").match(/^([A-Za-z]+)/); return m ? m[1].toLowerCase() : ""; };
const genderOf = v => { const n = firstName(v); return FEMALE.has(n) ? "f" : MALE.has(n) ? "m" : "?"; };
const isNatural = v => /natural|neural|online/i.test(v.name);

/* ============================================================
   Pitch of the reference clip, measured locally
   ============================================================ */
async function analysePitch(file) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  const ctx = new AC();
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const sr = buf.sampleRate, data = buf.getChannelData(0);
    const win = 2048, hop = 1024;
    const minP = Math.floor(sr/320), maxP = Math.floor(sr/60);
    const frames = [];
    for (let i = 0; i + win < data.length; i += hop) {
      let r = 0; for (let j = 0; j < win; j++) r += data[i+j]*data[i+j];
      frames.push({ i, rms: Math.sqrt(r/win) });
    }
    if (!frames.length) { ctx.close(); return null; }
    const loud = frames.slice().sort((a,b)=>b.rms-a.rms);
    const thresh = loud[Math.floor(loud.length*0.35)].rms;
    const found = [];
    for (const f of frames) {
      if (f.rms < thresh || f.rms < 0.01) continue;
      let e0 = 0; for (let j=0;j<win;j++) e0 += data[f.i+j]*data[f.i+j];
      if (e0 <= 0) continue;
      let best = -1, bestVal = 0;
      for (let p = minP; p <= maxP; p++) {
        let sum=0, e1=0;
        for (let j=0; j+p<win; j++){ sum += data[f.i+j]*data[f.i+j+p]; e1 += data[f.i+j+p]*data[f.i+j+p]; }
        const norm = sum/Math.sqrt(e0*e1+1e-12);
        if (norm > bestVal) { bestVal = norm; best = p; }
      }
      if (best > 0 && bestVal > 0.55) found.push(sr/best);
      if (found.length > 400) break;
    }
    ctx.close();
    if (found.length < 12) return null;
    found.sort((a,b)=>a-b);
    return { medianHz: found[Math.floor(found.length/2)], samples: found.length };
  } catch (e) { try{ctx.close();}catch(_){} return null; }
}

/* ============================================================
   Pull just the audio out, as small mono 16 kHz WAV.
   This is what gets sent - never the video itself.
   ============================================================ */
async function extractAudioWav(file, maxSeconds) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  ctx.close();
  const sr = 16000;
  const dur = Math.min(decoded.duration, maxSeconds || 60);
  const off = new OfflineAudioContext(1, Math.ceil(dur * sr), sr);
  const src = off.createBufferSource();
  src.buffer = decoded; src.connect(off.destination); src.start(0);
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0), n = pcm.length;
  const ab = new ArrayBuffer(44 + n*2), dv = new DataView(ab);
  const w = (o,s) => { for (let i=0;i<s.length;i++) dv.setUint8(o+i, s.charCodeAt(i)); };
  w(0,'RIFF'); dv.setUint32(4,36+n*2,true); w(8,'WAVEfmt ');
  dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,1,true);
  dv.setUint32(24,sr,true); dv.setUint32(28,sr*2,true); dv.setUint16(32,2,true);
  dv.setUint16(34,16,true); w(36,'data'); dv.setUint32(40,n*2,true);
  for (let i=0;i<n;i++){ const s=Math.max(-1,Math.min(1,pcm[i])); dv.setInt16(44+i*2, s<0?s*0x8000:s*0x7FFF, true); }
  return { blob: new Blob([ab], {type:'audio/wav'}), seconds: +dur.toFixed(2) };
}
const toBase64 = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(",")[1]);
  r.onerror = rej;
  r.readAsDataURL(blob);
});

/* ============================================================
   Gemini
   ============================================================ */
const API = "https://generativelanguage.googleapis.com/v1beta";

/* Matches the main page: try this first, fall back when a key can't use it. */
const PREFERRED_MODEL = "gemini-2.5-flash";
const MODEL_REJECTED = new Set();

async function pickModel(key) {
  if (PREFERRED_MODEL && !MODEL_REJECTED.has(PREFERRED_MODEL)) return PREFERRED_MODEL;
  const r = await fetch(API + "/models?key=" + encodeURIComponent(key));
  if (!r.ok) {
    const t = await r.text();
    throw new Error(r.status === 400 || r.status === 403
      ? "That key was rejected by Google. Check you copied all of it."
      : "Couldn't list models (" + r.status + "). " + t.slice(0,120));
  }
  const j = await r.json();
  const usable = (j.models || []).filter(m =>
    (m.supportedGenerationMethods || []).includes("generateContent") &&
    /flash/i.test(m.name) && !/image|tts|embedding|live/i.test(m.name) &&
    !MODEL_REJECTED.has(m.name.replace(/^models\//, "")));
  if (!usable.length) throw new Error("No usable Flash model on this key.");
  // newest version number first, stable before preview, full Flash before Lite
  usable.sort((a, b) => {
    const num  = s => { const m = s.match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
    const lite = s => /lite/i.test(s) ? 1 : 0;
    const prev = s => /preview|exp/i.test(s) ? 1 : 0;
    return (prev(a.name) - prev(b.name)) || (lite(a.name) - lite(b.name)) || (num(b.name) - num(a.name));
  });
  return usable[0].name.replace(/^models\//, "");
}

const SCHEMA = {
  type: "object",
  properties: {
    transcript: { type: "string" },
    voiceDescription: { type: "string" },
    gender: { type: "string", enum: ["male","female","unclear"] },
    accent: { type: "string" },
    pace: { type: "string" },
    energy: { type: "string" },
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          voiceName: { type: "string" },
          why: { type: "string" },
          closeness: { type: "integer" }
        },
        required: ["voiceName","why","closeness"]
      }
    }
  },
  required: ["transcript","voiceDescription","gender","recommendations"]
};

/* ============================================================
   Gemini API Key Modal & State
   ============================================================ */
function getApiKey() {
  return localStorage.getItem("gemini_api_key") || localStorage.getItem("captionStudio.geminiKey") || "";
}
function setApiKey(key) {
  if (key) {
    localStorage.setItem("gemini_api_key", key);
  } else {
    localStorage.removeItem("gemini_api_key");
    localStorage.removeItem("captionStudio.geminiKey");
  }
  updateApiKeyBtnState();
}
function updateApiKeyBtnState() {
  const btn = $("apiKeyBtn");
  if (!btn) return;
  const key = getApiKey();
  if (key) {
    btn.classList.add("active");
    btn.textContent = "🔑 Gemini Connected";
  } else {
    btn.classList.remove("active");
    btn.textContent = "🔑 Gemini Key";
  }
}
if ($("apiKeyBtn")) {
  $("apiKeyBtn").addEventListener("click", () => {
    if ($("apiKeyInput")) $("apiKeyInput").value = getApiKey();
    if ($("apiKeyModal")) $("apiKeyModal").classList.add("open");
  });
}
if ($("modalCloseBtn")) {
  $("modalCloseBtn").addEventListener("click", () => {
    if ($("apiKeyModal")) $("apiKeyModal").classList.remove("open");
  });
}
if ($("apiKeySaveBtn")) {
  $("apiKeySaveBtn").addEventListener("click", () => {
    const val = $("apiKeyInput").value.trim();
    setApiKey(val);
    if ($("apiKeyModal")) $("apiKeyModal").classList.remove("open");
  });
}
if ($("apiKeyClearBtn")) {
  $("apiKeyClearBtn").addEventListener("click", () => {
    setApiKey("");
    if ($("apiKeyInput")) $("apiKeyInput").value = "";
    if ($("apiKeyModal")) $("apiKeyModal").classList.remove("open");
  });
}
updateApiKeyBtnState();

async function analyseWithAI() {
  const st = (m, k) => { $("aiStatus").className = "aistatus" + (k ? " " + k : ""); $("aiStatus").textContent = m; };
  if (!refFile) return st("Load a clip in step 1 first.", "err");

  const candidates = voices.filter(v => v.lang.toLowerCase().startsWith("en"));
  if (!candidates.length) return st("No English voices in this browser to choose from. Open this page in Microsoft Edge.", "err");

  let activeKey = getApiKey();
  if (!activeKey) {
    if ($("apiKeyModal")) {
      $("apiKeyInput").value = "";
      $("apiKeyModal").classList.add("open");
    }
    return st("Please set your Gemini API key in the settings modal.", "err");
  }

  $("analyse").disabled = true;
  $("aiOut").replaceChildren();
  try {
    st("Extracting audio clip...");
    const wav = await extractAudioWav(refFile, 60);
    const b64 = await toBase64(wav.blob);
    st("Asking Gemini to analyze voice characteristics...");

    const promptText = `Analyze the speaker's vocal characteristics (gender, pitch, tone, energy level) in this audio clip. Available TTS voice choices: ${candidates.map(v => v.name).join(", ")}.`;
    const body = JSON.stringify({
      contents: [{
        role: "user",
        parts: [
          { text: promptText },
          { inlineData: { mimeType: "audio/wav", data: b64 } }
        ]
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
        temperature: 0.2
      }
    });

    /* Google only reveals that a key can't use a model when the request is
       made, so a refusal means pick another and try once more. */
    let res, model;
    for (let attempt = 0; attempt < 2; attempt++) {
      model = await pickModel(activeKey);
      res = await fetch(`${API}/models/${model}:generateContent?key=${encodeURIComponent(activeKey)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body
      });
      if (res.ok) break;

      const err = await res.json().catch(() => ({}));
      const msg = err.error?.message || "";
      const refused = res.status === 404 ||
                      /no longer available|not found|not supported|does not exist/i.test(msg);

      if (refused && attempt === 0) { MODEL_REJECTED.add(model); continue; }

      if (res.status === 429) throw new Error("Free-tier rate limit reached. Wait about a minute and try again.");
      if (res.status === 400 && /API key/i.test(msg)) throw new Error("That API key was rejected. Open the 🔑 dialog and paste a fresh one.");
      if (/quota|billing|credits/i.test(msg)) throw new Error("This key's project is out of quota or credits. Make a key in a new project.");
      if (refused) throw new Error(`No Gemini model on this key would accept the request. Last tried "${model}".`);
      throw new Error(msg || `HTTP ${res.status}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Empty response from Gemini");

    const responseObj = JSON.parse(text);
    renderAI(responseObj, candidates);
    st("Analysis complete!", "ok");
  } catch (e) {
    st(String(e.message || e), "err");
  } finally {
    $("analyse").disabled = false;
  }
}

function renderAI(r, candidates) {
  const out = $("aiOut");
  out.replaceChildren();

  // what it heard
  const an = document.createElement("div");
  an.className = "analysis";
  const dl = document.createElement("dl");
  const add = (k, v) => { if (!v) return; const dt=document.createElement("dt"); dt.textContent=k;
                          const dd=document.createElement("dd"); dd.textContent=v; dl.append(dt,dd); };
  add("The voice", r.voiceDescription);
  add("Sounds", [r.gender, r.accent, r.pace, r.energy].filter(Boolean).join(" · "));
  an.appendChild(dl);
  if (r.transcript) {
    const dt = document.createElement("dt"); dt.textContent = "What it says";
    const pre = document.createElement("div"); pre.className = "transcript"; pre.textContent = r.transcript;
    an.append(dt, pre);
    const copy = document.createElement("button");
    copy.textContent = "Copy this as my script";
    copy.style.marginTop = "9px";
    copy.addEventListener("click", () => {
      navigator.clipboard.writeText(r.transcript).then(
        () => copy.textContent = "Copied ✓",
        () => copy.textContent = "Couldn't copy");
    });
    an.appendChild(copy);
  }
  out.appendChild(an);

  // if it says male/female, narrow the manual list to match
  if (r.gender === "male" || r.gender === "female") {
    $("fGender").value = r.gender === "male" ? "m" : "f";
    render();
  }

  (r.recommendations || []).forEach((rec, i) => {
    const match = candidates.find(v => v.name === rec.voiceName) ||
                  candidates.find(v => v.name.toLowerCase().includes(String(rec.voiceName).toLowerCase())) ||
                  candidates.find(v => firstName(v) === String(rec.voiceName).toLowerCase().split(/\s+/)[0]);
    const card = document.createElement("div");
    card.className = "rec" + (i === 0 ? " top" : "");
    const head = document.createElement("div"); head.className = "rt";
    const b = document.createElement("b");
    b.textContent = (match ? match.name.replace(/^Microsoft /,"").replace(/\s*\(Natural\)/i,"") : rec.voiceName);
    head.appendChild(b);
    if (i === 0) { const p=document.createElement("span"); p.className="pill gold"; p.textContent="best match"; head.appendChild(p); }
    if (typeof rec.closeness === "number") {
      const p=document.createElement("span"); p.className="pill"; p.textContent=rec.closeness + "% close"; head.appendChild(p);
    }
    if (!match) { const p=document.createElement("span"); p.className="pill"; p.textContent="not on this machine"; head.appendChild(p); }
    card.appendChild(head);
    const why = document.createElement("p"); why.className="why"; why.textContent = rec.why || "";
    card.appendChild(why);

    const row = document.createElement("div"); row.className = "row";
    if (match) {
      const hear = document.createElement("button");
      hear.textContent = "Hear it";
      hear.addEventListener("click", () => { stopAll(); speak(match, null); });
      const ab = document.createElement("button");
      ab.textContent = "A/B against my clip";
      ab.addEventListener("click", () => {
        stopAll(); ref.currentTime = 0; ref.play().catch(()=>{});
        const wait = Math.min(6, isFinite(ref.duration)?ref.duration:6)*1000 + 300;
        setTimeout(() => { ref.pause(); speak(match, null); }, wait);
      });
      const use = document.createElement("button");
      use.className = "primary"; use.textContent = "Use this voice";
      use.addEventListener("click", () => applyVoice(match));
      row.append(hear, ab, use);
    }
    card.appendChild(row);
    out.appendChild(card);
  });
}

/* ---------- apply + save ---------- */
function applyVoice(v) {
  try { localStorage.setItem(SAVE_KEY, v.name); } catch (e) {}
  starred.add(v.name); render();
  const box = $("savedBox");
  box.style.display = "";
  box.innerHTML = "<b>Saved</b> — " + v.name.replace(/^Microsoft /,"") +
    " is now the voice Caption Studio starts with. <a href='index.html'>Go back and use it →</a>";
  box.scrollIntoView({ block: "nearest" });
}

/* ---------- key storage ---------- */
$("analyse").addEventListener("click", analyseWithAI);

/* ---------- reference clip ---------- */
$("refFile").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  refFile = f;
  if (refURL) URL.revokeObjectURL(refURL);
  refURL = URL.createObjectURL(f);
  ref.src = refURL;
  $("refName").textContent = f.name;
  $("refName").classList.remove("none");

  const v = $("verdict");
  v.style.display = ""; v.className = "verdict";
  v.innerHTML = "<b>Listening to it…</b><span class='num'>measuring pitch</span>";
  const r = await analysePitch(f);
  if (!r) { v.innerHTML = "<b>Couldn't measure it</b><span class='num'>Pick the voice type yourself below.</span>"; return; }
  const hz = Math.round(r.medianHz), g = hz < 155 ? "m" : "f";
  $("fGender").value = g;
  v.className = "verdict ok";
  v.innerHTML = "<b>Sounds like a " + (g==="m"?"male":"female") + " voice</b>" +
    "<span class='num'>average pitch " + hz + " Hz · from " + r.samples + " measurements</span>";
  render();
});
ref.addEventListener("error", () => {
  if (!ref.src) return;
  $("refName").textContent = "couldn't read sound from that file — try another";
  $("refName").classList.add("none");
});
$("playRef").addEventListener("click", () => { stopAll(); ref.currentTime = 0; ref.play().catch(()=>{}); });
$("stopAll").addEventListener("click", stopAll);
function stopAll() {
  auditioning = false; auditionAt = -1;
  if (TTS) TTS.cancel();
  ref.pause();
  $("nowPlaying").textContent = "";
  document.querySelectorAll(".v.playing").forEach(el => el.classList.remove("playing"));
}

/* ---------- voices ---------- */
function loadVoices() {
  if (!TTS) return;
  voices = TTS.getVoices() || [];
  const langs = [...new Set(voices.map(v => v.lang.split("-")[0]))].sort();
  const sel = $("fLang"), keep = sel.value;
  sel.innerHTML = "<option value='en'>English only</option><option value='all'>Every language</option>";
  langs.filter(l => l !== "en").forEach(l => { const o=document.createElement("option"); o.value=l; o.textContent=l; sel.appendChild(o); });
  if (keep) sel.value = keep;
  render();
}
if (TTS) { loadVoices(); TTS.addEventListener("voiceschanged", loadVoices); }
["fLang","fGender","fQuality"].forEach(id => $(id).addEventListener("change", render));

function filtered() {
  const lang = $("fLang").value, gen = $("fGender").value, q = $("fQuality").value;
  return voices.filter(v => {
    if (lang !== "all" && !v.lang.toLowerCase().startsWith(lang)) return false;
    if (q === "natural" && !isNatural(v)) return false;
    if (gen !== "any" && genderOf(v) !== gen) return false;
    return true;
  }).sort((a,b) => (isNatural(b)-isNatural(a)) || a.name.localeCompare(b.name));
}

function speak(v, row, onDone) {
  if (!TTS) return;
  const u = new SpeechSynthesisUtterance($("line") && $("line").value ? $("line").value :
            "Your thyroid sits at the base of your neck.");
  u.voice = v;
  u.onstart = () => {
    document.querySelectorAll(".v.playing").forEach(el => el.classList.remove("playing"));
    if (row) { row.classList.add("playing"); row.scrollIntoView({ block:"nearest" }); }
    $("nowPlaying").textContent = "▶ " + v.name.replace(/^Microsoft /,"");
  };
  u.onend = () => { if (row) row.classList.remove("playing"); if (onDone) onDone(); };
  u.onerror = () => { if (row) row.classList.remove("playing"); if (onDone) onDone(); };
  TTS.speak(u);
}

$("audition").addEventListener("click", () => {
  stopAll();
  auditionOrder = filtered();
  if (!auditionOrder.length) return;
  auditioning = true; auditionAt = -1;
  nextInAudition();
});
function nextInAudition() {
  if (!auditioning) return;
  auditionAt++;
  if (auditionAt >= auditionOrder.length) {
    auditioning = false;
    $("nowPlaying").textContent = "Finished all " + auditionOrder.length + ".";
    return;
  }
  const v = auditionOrder[auditionAt];
  const row = document.querySelector('.v[data-name="' + CSS.escape(v.name) + '"]');
  speak(v, row, () => setTimeout(nextInAudition, 260));
}
document.addEventListener("keydown", e => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return;
  if (e.key === "Escape") { stopAll(); return; }
  if (!auditioning || auditionAt < 0) return;
  if (e.key === "s" || e.key === "S") {
    e.preventDefault();
    const v = auditionOrder[auditionAt];
    starred.has(v.name) ? starred.delete(v.name) : starred.add(v.name);
    render();
  } else if (e.key === "ArrowRight") { e.preventDefault(); if (TTS) TTS.cancel(); }
});

function render() {
  if (!TTS) { $("noVoices").style.display=""; $("noVoices").textContent="This browser has no speech voices."; return; }
  const list = filtered(), wrap = $("vlist");
  wrap.replaceChildren();
  const anyNatural = voices.some(isNatural);
  $("noVoices").style.display = (!anyNatural && $("fQuality").value === "natural") ? "" : "none";
  if (!anyNatural && $("fQuality").value === "natural") {
    $("noVoices").innerHTML = "No natural-sounding voices in <b>this</b> browser. Open this page in <b>Microsoft Edge</b>.";
  }
  list.forEach(v => {
    const row = document.createElement("div");
    row.className = "v" + (starred.has(v.name) ? " starred" : "");
    row.dataset.name = v.name;
    const star = document.createElement("button");
    star.className = "star" + (starred.has(v.name) ? " on" : "");
    star.textContent = starred.has(v.name) ? "★" : "☆";
    star.setAttribute("aria-label","Star " + v.name);
    star.addEventListener("click", () => { starred.has(v.name)?starred.delete(v.name):starred.add(v.name); render(); });
    const name = document.createElement("div"); name.className="vname";
    const b = document.createElement("b");
    b.textContent = v.name.replace(/^Microsoft /,"").replace(/\s*\(Natural\)/i,"");
    const s = document.createElement("span"); s.textContent = v.lang;
    name.append(b,s);
    const g = genderOf(v);
    const tag = document.createElement("span");
    tag.className = "tag " + (g==="?"?"":g);
    tag.textContent = g==="m"?"male":g==="f"?"female":"?";
    const hear = document.createElement("button");
    hear.textContent = "Hear it";
    hear.addEventListener("click", () => { stopAll(); speak(v,row); });
    const use = document.createElement("button");
    use.className="primary"; use.textContent="Use";
    use.title = "Make this the voice Caption Studio starts with";
    use.addEventListener("click", () => applyVoice(v));
    row.append(star,name,tag,hear,use);
    wrap.appendChild(row);
  });
  const cut = voices.length - list.length;
  $("count").innerHTML = "<b>" + list.length + "</b> to listen to" +
    (cut>0 ? " · <span class='cut'>" + cut + " of " + voices.length + " filtered out</span>" : "");
}

window.addEventListener("beforeunload", () => { if (TTS) TTS.cancel(); });
window.__vm = { get voices(){return voices;}, genderOf, isNatural, firstName, filtered, render,
                starred, analysePitch, extractAudioWav, pickModel, applyVoice, SCHEMA };