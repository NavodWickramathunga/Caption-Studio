"use strict";

/* ============================================================
   State
   ============================================================ */
const S = {
  animStyle: "none", hlColor: "#FACC15",
  words: [],            // {raw, text, start, end}
  wps: 3,
  sizePct: 8.5,
  posPct: 72,
  hlColor: "#FFD400",
  emphasise: false,         // pick out the meaningful words
  keyColor: "#FF8A3D",
  hasAudio: false,          // a voiceover FILE is loaded
  voMode: "generated",      // "generated" (spoken here) or "file"
  rate: 1,                  // speaking speed
  spokenDur: 0,             // how long the last spoken run actually took
  videoName: "",
  recording: false
};

const COLORS = [
  ["#FFD400", "Caption yellow"],
  ["#5CE08A", "Mint"],
  ["#41D6EE", "Cyan"],
  ["#FF5C7A", "Rose"],
  ["#FFFFFF", "White"]
];
const KEY_COLORS = [
  ["#FF8A3D", "Orange"],
  ["#5CE08A", "Mint"],
  ["#41D6EE", "Cyan"],
  ["#FF5C7A", "Rose"]
];

const FONT_STACK = 'Anton, "Arial Narrow", Impact, Haettenschweiler, sans-serif';

const $ = id => document.getElementById(id);
const video = $("video"), audio = $("audio"), overlay = $("overlay");
const octx = overlay.getContext("2d");

/* ============================================================
   Media loading + A/V sync
   ============================================================ */
let videoURL = null, audioURL = null;

$("videoFile").addEventListener("change", e => {
  const f = e.target.files[0]; if (!f) return;
  if (videoURL) URL.revokeObjectURL(videoURL);
  videoURL = URL.createObjectURL(f);
  S.videoName = f.name.replace(/\.[^.]+$/, "");
  video.src = videoURL;
  video.load();
  $("videoName").textContent = f.name;
  $("videoName").classList.remove("none");
  $("stageEmpty").style.display = "none";
});

$("audioFile").addEventListener("change", e => {
  const f = e.target.files[0]; if (!f) return;
  if (audioURL) URL.revokeObjectURL(audioURL);
  audioURL = URL.createObjectURL(f);
  audio.src = audioURL; audio.load();
  S.hasAudio = true; video.muted = true;
  $("audioName").textContent = f.name;
  $("audioName").classList.remove("none");
  $("clearAudio").style.display = "";
  syncTransport();
});

$("clearAudio").addEventListener("click", () => {
  pauseAll();
  if (audioURL) { URL.revokeObjectURL(audioURL); audioURL = null; }
  audio.removeAttribute("src"); audio.load();
  S.hasAudio = false; video.muted = false;
  $("audioFile").value = "";
  $("audioName").textContent = "using the video's own audio";
  $("audioName").classList.add("none");
  $("clearAudio").style.display = "none";
  syncTransport();
});

// The element that owns the timeline. With a separate voiceover the audio leads,
// because that is what you are tapping along to.
const master = () => (S.hasAudio && audio.src) ? audio : video;
const nowTime = () => master().currentTime || 0;
const totalTime = () => {
  const dv = isFinite(video.duration) ? video.duration : 0;
  const da = (S.hasAudio && isFinite(audio.duration)) ? audio.duration : 0;
  return Math.max(dv, da);
};

function playAll() {
  if (!video.src) return;
  video.play().catch(() => {});
  if (S.hasAudio && audio.src) audio.play().catch(() => {});
}
function pauseAll() { video.pause(); if (audio.src) audio.pause(); }
function seekAll(t) {
  t = Math.max(0, t);
  if (video.src && isFinite(video.duration)) video.currentTime = Math.min(t, video.duration);
  if (S.hasAudio && audio.src && isFinite(audio.duration)) audio.currentTime = Math.min(t, audio.duration);
}
function togglePlay() { (master().paused) ? playAll() : pauseAll(); }

$("playBtn").addEventListener("click", togglePlay);
$("restartBtn").addEventListener("click", () => seekAll(0));

video.addEventListener("loadedmetadata", () => {
  overlay.width = video.videoWidth || 1080;
  overlay.height = video.videoHeight || 1920;
  syncTransport();
});
audio.addEventListener("loadedmetadata", () => {
  // A video file loaded here contributes its sound only. If it carries no
  // audio track at all there is nothing to use, so say so plainly.
  if (!isFinite(audio.duration) || audio.duration === 0) {
    $("audioName").textContent = "that file has no usable sound — try another";
    $("audioName").classList.add("none");
  }
  syncTransport();
});
audio.addEventListener("error", () => {
  if (!audio.src) return;
  $("audioName").textContent = "couldn't read the sound from that file — try another";
  $("audioName").classList.add("none");
  S.hasAudio = false;
  video.muted = false;
  syncTransport();
});
[video, audio].forEach(el => {
  el.addEventListener("play", syncTransport);
  el.addEventListener("pause", syncTransport);
});
video.addEventListener("ended", closeFinalWord);
audio.addEventListener("ended", closeFinalWord);

function syncTransport() {
  const ready = !!video.src;
  $("playBtn").disabled = !ready;
  $("restartBtn").disabled = !ready;
  $("playBtn").textContent = (ready && !master().paused) ? "Pause" : "Play";
  $("tEnd").textContent = fmtClock(totalTime());
}

/* ============================================================
   Script parsing
   ============================================================ */
const scriptEl = $("script");
let parseTimer = null;
scriptEl.addEventListener("input", () => {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(parseScript, 220);
});

/* ------------------------------------------------------------
   Picking out the words worth emphasising.

   This is a rule of thumb, not a language model: everyday filler words
   are ignored, and numbers plus longer / technical-looking words are
   treated as the ones carrying the meaning. It gets anatomy and health
   terms right most of the time. Shift-click any word to overrule it.
   ------------------------------------------------------------ */
const STOPWORDS = new Set(("a about above after again against all am an and any are aren't as at be because been " +
  "before being below between both but by can cannot could couldn't did didn't do does doesn't doing don't down " +
  "during each few for from further had hadn't has hasn't have haven't having he her here hers herself him " +
  "himself his how i if in into is isn't it its itself just let's me more most mustn't my myself no nor not of " +
  "off on once only or other ought our ours ourselves out over own same shan't she should shouldn't so some " +
  "such than that the their theirs them themselves then there these they this those through to too under until " +
  "up very was wasn't we were weren't what when where which while who whom why with won't would wouldn't you " +
  "your yours yourself yourselves get got make made take takes go goes going come comes one two three like " +
  "really actually never always every much many lot lots thing things way ways new old good bad big small"
).split(" "));

function isKeyWord(text) {
  const t = text.toLowerCase();
  if (/\d/.test(text)) return true;          // numbers, doses, percentages
  if (STOPWORDS.has(t)) return false;
  if (text.length >= 6) return true;         // the technical term is usually the long one
  return false;
}

function parseScript() {
  const raw = scriptEl.value;
  const next = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const text = m[0].replace(/[^\p{L}\p{N}'’\-]/gu, "").toUpperCase();
    // pos = where this word starts in the raw script, so speech boundary
    // events (which report a character index) can be mapped back to it.
    if (text) next.push({ raw: m[0], text, pos: m.index, start: null, end: null,
                          key: isKeyWord(text), keyManual: false });
  }
  // Keep timings for the unchanged leading run, so light edits don't wipe your work.
  const old = S.words;
  for (let i = 0; i < next.length; i++) {
    if (old[i] && old[i].text === next[i].text) {
      next[i].start = old[i].start; next[i].end = old[i].end;
      // keep any emphasis you set by hand
      if (old[i].keyManual) { next[i].key = old[i].key; next[i].keyManual = true; }
    } else break;
  }
  S.words = next;
  renderChips();
  const n = next.length;
  if ($("wordCount")) {
    $("wordCount").textContent = n ? (n + (n === 1 ? " word ready to sync." : " words ready to sync.")) : "No words yet.";
  }
}

/* cursor = first word with no start; everything before it is marked. */
function cursorIndex() {
  for (let i = 0; i < S.words.length; i++) if (S.words[i].start === null) return i;
  return S.words.length;
}
function isClosed() {
  const n = S.words.length;
  return n > 0 && S.words[n - 1].end !== null;
}
function allTimed() {
  return S.words.length > 0 && S.words.every(w => w.start !== null && w.end !== null && w.end > w.start);
}

/* ============================================================
   Tap to sync
   ============================================================ */
document.addEventListener("keydown", e => {
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "textarea" || tag === "input" || e.target.isContentEditable) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.code === "Space") { e.preventDefault(); markWord(); }
  else if (e.code === "Backspace") { e.preventDefault(); undoMark(); }
  else if (e.key === "r" || e.key === "R") { e.preventDefault(); clearAll(); }
});

function markWord() {
  if (!S.words.length) return;
  const t = nowTime();
  const i = cursorIndex();
  if (i < S.words.length) {
    if (i > 0) {
      S.words[i - 1].end = Math.max(t, (S.words[i - 1].start || 0) + 0.02);
      S.words[i].start = S.words[i - 1].end;
    } else {
      S.words[0].start = t;
    }
  } else if (!isClosed()) {
    const last = S.words[S.words.length - 1];
    last.end = Math.max(t, last.start + 0.02);
  }
  renderChips();
}

function undoMark() {
  if (!S.words.length) return;
  if (isClosed()) {
    S.words[S.words.length - 1].end = null;
  } else {
    const i = cursorIndex() - 1;
    if (i < 0) return;
    S.words[i].start = null; S.words[i].end = null;
    if (i - 1 >= 0) S.words[i - 1].end = null;
  }
  renderChips();
}

function clearAll() {
  S.words.forEach(w => { w.start = null; w.end = null; });
  seekAll(0);
  renderChips();
}

function resyncFrom(k) {
  for (let i = k; i < S.words.length; i++) { S.words[i].start = null; S.words[i].end = null; }
  if (k - 1 >= 0) S.words[k - 1].end = null;
  const back = (k - 1 >= 0 && S.words[k - 1].start !== null) ? S.words[k - 1].start : 0;
  seekAll(back);
  renderChips();
}

/* Playback ran out with the last word still open — close it at the end of the media. */
function closeFinalWord() {
  const n = S.words.length;
  if (n) {
    const last = S.words[n - 1];
    if (last.start !== null && last.end === null) {
      last.end = Math.max(totalTime(), last.start + 0.02);
      renderChips();
    }
  }
  syncTransport();
}

/* ============================================================
   Voiceover — spoken here, timed automatically

   The speech engine fires a "boundary" event as it reaches each word.
   We stamp the video's clock at that moment, which is exactly what a
   spacebar tap does — so the same timing logic serves both.
   ============================================================ */
const TTS = window.speechSynthesis;
const CAN_SPEAK = !!(TTS && window.SpeechSynthesisUtterance);
let voices = [], utter = null, speakRun = null;

function loadVoices() {
  if (!CAN_SPEAK) return;
  voices = TTS.getVoices() || [];
  const sel = $("voice"), localOnly = $("localOnly").checked;
  const list = voices
    .map((v, i) => ({ v, i }))
    .filter(o => !localOnly || o.v.localService)
    .sort((a, b) => (b.v.lang.startsWith("en") - a.v.lang.startsWith("en")) ||
                     a.v.name.localeCompare(b.v.name));

  if (!list.length) {
    sel.innerHTML = "<option value=''>" +
      (voices.length ? "No offline voices installed" : "No voices available") + "</option>";
    setVoStatus(voices.length
      ? "No offline voices found. Untick the box above, or load an audio file instead."
      : "This browser has no speech voices. Use the “Load a file” tab instead.", "warn");
    return;
  }
  const keep = sel.value;
  sel.innerHTML = "";
  // Natural / neural voices sound far better than the old built-in ones,
  // so surface them in their own group at the top.
  const natural = list.filter(o => /natural|neural/i.test(o.v.name));
  const plain = list.filter(o => !/natural|neural/i.test(o.v.name));
  const addTo = (parent, o) => {
    const opt = document.createElement("option");
    opt.value = String(o.i);
    opt.textContent = o.v.name.replace(/^Microsoft /, "") + " · " + o.v.lang +
                      (o.v.localService ? "" : " · online");
    parent.appendChild(opt);
  };
  if (natural.length) {
    const g = document.createElement("optgroup");
    g.label = "Natural sounding (" + natural.length + ")";
    natural.forEach(o => addTo(g, o));
    sel.appendChild(g);
    const g2 = document.createElement("optgroup");
    g2.label = "Basic";
    plain.forEach(o => addTo(g2, o));
    if (plain.length) sel.appendChild(g2);
  } else {
    plain.forEach(o => addTo(sel, o));
  }
  if (keep && sel.querySelector('option[value="' + keep + '"]')) sel.value = keep;
  else {
    // a voice chosen over in Voice Match becomes the one we start with
    let saved = null;
    try { saved = localStorage.getItem("captionStudio.voice"); } catch (e) {}
    if (saved) {
      const idx = voices.findIndex(v => v.name === saved);
      if (idx >= 0 && sel.querySelector('option[value="' + idx + '"]')) {
        sel.value = String(idx);
        $("savedVoice").style.display = "";
        $("savedVoice").textContent = "Using " + saved.replace(/^Microsoft /, "") + ", picked in Voice Match.";
      }
    }
  }

  $("edgeTip").style.display = (!natural.length && localOnly) ? "" : "none";
  setVoStatus(natural.length ? natural.length + " natural-sounding voices available." : "");
}
if (CAN_SPEAK) {
  loadVoices();
  TTS.addEventListener("voiceschanged", loadVoices);
}
$("localOnly").addEventListener("change", e => {
  $("netWarn").style.display = e.target.checked ? "none" : "";
  loadVoices();
});

function setVoStatus(msg, kind) {
  const el = $("voStatus");
  el.className = "status" + (kind ? " " + kind : "");
  el.textContent = msg;
}

/* --- mode switching --- */
function setMode(mode) {
  S.voMode = mode;
  const gen = mode === "generated";
  $("modeGen").setAttribute("aria-selected", gen ? "true" : "false");
  $("modeFile").setAttribute("aria-selected", gen ? "false" : "true");
  $("genPanel").style.display = gen ? "" : "none";
  $("filePanel").style.display = gen ? "none" : "";
  if (gen) stopSpeaking();
  video.muted = (!gen && S.hasAudio);
  syncTransport();
}
$("modeGen").addEventListener("click", () => setMode("generated"));
$("modeFile").addEventListener("click", () => setMode("file"));

bindRange("rate", "rate", v => v.toFixed(2) + "×");

/* --- map a character index in the script back to a word --- */
function wordIndexAtChar(charIndex) {
  let found = -1;
  for (let i = 0; i < S.words.length; i++) {
    if (S.words[i].pos <= charIndex) found = i; else break;
  }
  return found;
}

/* --- set one word's start without disturbing the rest --- */
function setStartAt(i, t) {
  const w = S.words[i];
  if (!w || w.start !== null) return;
  w.start = t;
  const p = S.words[i - 1];
  if (p && p.start !== null && p.end === null) p.end = Math.max(t, p.start + 0.02);
}

/* --- after a run, interpolate anything the engine skipped and chain the ends --- */
function normalizeTimings(finalEnd) {
  const n = S.words.length;
  if (!n) return 0;
  if (S.words[0].start === null) S.words[0].start = 0;
  let filled = 0;
  let i = 1;
  while (i < n) {
    if (S.words[i].start !== null) { i++; continue; }
    let j = i;
    while (j < n && S.words[j].start === null) j++;
    const a = S.words[i - 1].start;
    const b = (j < n) ? S.words[j].start : Math.max(finalEnd, a + 0.2 * (j - i + 1));
    const steps = j - i + 1;
    for (let k = i; k < j; k++) { S.words[k].start = a + (b - a) * ((k - i + 1) / steps); filled++; }
    i = j;
  }
  for (let k = 0; k < n - 1; k++) S.words[k].end = S.words[k + 1].start;
  const last = S.words[n - 1];
  last.end = Math.max(finalEnd, last.start + 0.15);
  return filled;
}

/* --- speak; optionally record the timings as it goes --- */
function speakScript(recordTimings) {
  if (!CAN_SPEAK) { setVoStatus("This browser can't speak. Use the “Load a file” tab.", "warn"); return; }
  const text = scriptEl.value.trim();
  if (!text) { setVoStatus("Paste your script in step 3 first.", "warn"); return; }
  if (!video.src) { setVoStatus("Load a video in step 1 first — the timings are measured against it.", "warn"); return; }
  const vi = $("voice").value;
  if (vi === "") { setVoStatus("Pick a voice first.", "warn"); return; }

  stopSpeaking();
  if (recordTimings) clearAll();

  const u = new SpeechSynthesisUtterance(text);
  u.voice = voices[+vi];
  u.rate = S.rate;
  u.pitch = 1;
  utter = u;
  speakRun = { boundaries: 0, recording: !!recordTimings, lastIdx: -1 };

  pauseAll();
  seekAll(0);
  video.muted = true;

  // The video starts when the voice does, so the clock and the speech
  // share an origin on every run — timing and playback stay consistent.
  u.onstart = () => {
    video.play().catch(() => {});
    setVoStatus(recordTimings ? "Listening and timing the words…" : "Playing…");
    $("voStatus").classList.add("speaking");
  };

  u.onboundary = e => {
    if (e.name && e.name !== "word") return;
    speakRun.boundaries++;
    if (!speakRun.recording) return;
    const i = wordIndexAtChar(e.charIndex);
    if (i < 0 || i <= speakRun.lastIdx) return;
    speakRun.lastIdx = i;
    setStartAt(i, video.currentTime);
    renderChips();
  };

  u.onend = () => {
    const spoken = video.currentTime;
    video.pause();
    video.muted = false;
    $("voStatus").classList.remove("speaking");
    $("speakStop").disabled = true;
    utter = null;

    if (speakRun && speakRun.recording) {
      if (!speakRun.boundaries) {
        setVoStatus("This voice doesn't report word boundaries, so it can't self-time. " +
                    "Try a “Microsoft …” voice, or tap the words in yourself in step 4.", "warn");
        renderChips();
        return;
      }
      const filled = normalizeTimings(spoken);
      S.spokenDur = spoken;
      renderChips();
      let msg = "Timed " + S.words.length + " words from the voiceover";
      if (filled) msg += " (" + filled + " estimated between boundaries)";
      msg += ". Voiceover " + spoken.toFixed(1) + "s · video " + totalTime().toFixed(1) + "s.";
      setVoStatus(msg, "ok");
      offerFit(spoken);
    } else {
      setVoStatus("");
    }
    speakRun = null;
    syncTransport();
  };

  u.onerror = ev => {
    $("voStatus").classList.remove("speaking");
    $("speakStop").disabled = true;
    video.muted = false;
    utter = null; speakRun = null;
    if (ev.error !== "interrupted" && ev.error !== "canceled") {
      setVoStatus("The voice stopped: " + ev.error + ". Try another voice.", "warn");
    }
    syncTransport();
  };

  $("speakStop").disabled = false;
  setVoStatus("Warming up the voice…");
  TTS.speak(u);
}

function stopSpeaking() {
  if (!CAN_SPEAK) return;
  if (TTS.speaking || TTS.pending) TTS.cancel();
  utter = null; speakRun = null;
  video.pause();
  video.muted = (S.voMode === "file" && S.hasAudio);
  $("speakStop").disabled = true;
  $("voStatus").classList.remove("speaking");
}

/* --- when the voiceover overruns the clip, offer to slow it to fit --- */
function offerFit(spoken) {
  const vid = isFinite(video.duration) ? video.duration : 0;
  const btn = $("fitVideo");
  if (!vid || !spoken || Math.abs(spoken - vid) < 0.35) { btn.style.display = "none"; return; }
  // rate is a speed multiplier, so duration goes as 1/rate:
  // to stretch a `spoken`-second read into `vid` seconds, scale the rate by spoken/vid.
  const ideal = S.rate * (spoken / vid);
  const target = Math.min(2, Math.max(0.5, ideal));
  btn.textContent = (spoken > vid ? "Speed it up" : "Slow it down") +
                    " to fit the video (" + target.toFixed(2) + "×)";
  btn.title = Math.abs(ideal - target) > 0.01
    ? "Clamped to " + target.toFixed(2) + "× — a natural-sounding voice only stretches so far, so this gets closer without fitting exactly."
    : "";
  btn.style.display = "";
  btn.onclick = () => {
    $("rate").value = target;
    $("rate").dispatchEvent(new Event("input"));
    btn.style.display = "none";
    speakScript(true);
  };
}

$("speakTime").addEventListener("click", () => speakScript(true));
$("speakPlay").addEventListener("click", () => speakScript(false));
$("speakStop").addEventListener("click", () => { stopSpeaking(); setVoStatus(""); });
window.addEventListener("beforeunload", () => { if (CAN_SPEAK) TTS.cancel(); });

if (!CAN_SPEAK) {
  $("speakTime").disabled = true;
  $("speakPlay").disabled = true;
  setVoStatus("This browser has no speech engine. Use the “Load a file” tab instead.", "warn");
}

/* ============================================================
   Chip strip
   ============================================================ */
const chipsEl = $("chips");


  const p = document.createElement("div");
  p.className = "time-editor";
  p.style.display = "none";
  document.body.appendChild(p);

  let editingIdx = -1;
  function openTimeEditor(idx, buttonEl) {
    editingIdx = idx;
    const w = S.words[idx];
    const rect = buttonEl.getBoundingClientRect();
    
    p.innerHTML = `
      <div style="font-size:11px; margin-bottom:5px; color:var(--ivory-dim)">Editing: "${w.text}"</div>
      <label style="display:flex; gap:5px; align-items:center; margin-bottom:5px">
        Start: <input type="number" step="0.01" id="editStart" value="${w.start !== null ? w.start.toFixed(2) : ''}" style="width:60px; font:inherit; font-size:12px; background:var(--panel-2); color:white; border:1px solid var(--line); border-radius:4px; padding:2px">
      </label>
      <label style="display:flex; gap:5px; align-items:center; margin-bottom:5px">
        End: <input type="number" step="0.01" id="editEnd" value="${w.end !== null ? w.end.toFixed(2) : ''}" style="width:60px; font:inherit; font-size:12px; background:var(--panel-2); color:white; border:1px solid var(--line); border-radius:4px; padding:2px">
      </label>
      <div style="display:flex; gap:5px; justify-content:space-between">
         <button id="editSave" style="padding:4px 8px; font-size:11px; background:var(--vein-deep); border:0; color:white; border-radius:4px; cursor:pointer">Save</button>
         <button id="editCancel" style="padding:4px 8px; font-size:11px; background:transparent; border:1px solid var(--line); color:white; border-radius:4px; cursor:pointer">Cancel</button>
      </div>
    `;
    p.style.display = "block";
    p.style.position = "absolute";
    p.style.left = rect.left + "px";
    p.style.top = (rect.bottom + window.scrollY + 5) + "px";
    p.style.background = "var(--panel)";
    p.style.border = "1px solid var(--vein)";
    p.style.padding = "10px";
    p.style.borderRadius = "8px";
    p.style.boxShadow = "0 10px 25px rgba(0,0,0,0.5)";
    p.style.zIndex = "1000";

    document.getElementById("editSave").onclick = () => {
      const s = parseFloat(document.getElementById("editStart").value);
      const e = parseFloat(document.getElementById("editEnd").value);
      if(!isNaN(s)) S.words[editingIdx].start = s;
      if(!isNaN(e)) S.words[editingIdx].end = e;
      p.style.display = "none";
      renderChips();
    };
    document.getElementById("editCancel").onclick = () => {
      p.style.display = "none";
    };
  }

function renderChips() {
  if (!S.words.length) {
    chipsEl.className = "chips empty-state";
    chipsEl.textContent = "Paste a script in step 3. Then let step 2 speak it and time it for you — or press Play and hit Space on every word you hear.";
    $("tapProgress").style.width = "0%";
    refreshExports();
    return;
  }
  chipsEl.className = "chips";
  const cur = cursorIndex(), closed = isClosed();
  const frag = document.createDocumentFragment();

  S.words.forEach((w, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (w.start !== null ? " done" : "") + ((i === cur && !closed) ? " now" : "");
    b.title = "Click to edit time · Alt-click to re-record from ' “" + w.text + "” onward · Shift-click to emphasise'";
    const label = document.createElement("span");
    label.textContent = w.text;
    if (S.emphasise && w.key) {
      label.style.color = S.keyColor;
      b.title = "“" + w.text + "” is marked important · Shift-click to unmark";
    }
    const time = document.createElement("span");
    time.className = "t";
    time.textContent = w.start !== null ? w.start.toFixed(2) : "––––";
    b.append(label, time);
    b.addEventListener("click", ev => {
      if (ev.shiftKey) {                 // overrule the automatic pick
        w.key = !w.key; w.keyManual = true;
        if (!S.emphasise) {
          S.emphasise = true;
          if ($("emphasise")) $("emphasise").checked = true;
          if ($("keyRow")) $("keyRow").style.display = "";
        }
        renderChips();
        return;
      }
      if (ev.altKey) { resyncFrom(i); } else { openTimeEditor(i, b); }
    });
    frag.appendChild(b);
  });

  if (cur >= S.words.length && !closed) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip now";
    b.title = "Tap Space once more to close the last word";
    const l = document.createElement("span"); l.textContent = "END";
    const t = document.createElement("span"); t.className = "t"; t.textContent = "SPACE";
    b.append(l, t);
    b.addEventListener("click", markWord);
    frag.appendChild(b);
  }

  chipsEl.replaceChildren(frag);
  const keyN = S.words.filter(w => w.key).length;
  if ($("keyCount")) $("keyCount").textContent = S.emphasise ? keyN + " of " + S.words.length : "";
  const marked = S.words.filter(w => w.start !== null).length + (closed ? 1 : 0);
  $("tapProgress").style.width = Math.round(marked / (S.words.length + 1) * 100) + "%";

  const active = chipsEl.querySelector(".now");
  if (active) active.scrollIntoView({ block: "nearest", inline: "center" });
  refreshExports();
}

/* ============================================================
   Style controls
   ============================================================ */
/* Controls are optional: the layout has moved around, and a missing one
   must never stop the rest of this file from running. */
function bindRange(id, key, fmt, onInput) {
  const el = $(id), out = $(id + "Val");
  if (!el) return;
  const apply = () => {
    S[key] = parseFloat(el.value);
    if (out) out.textContent = fmt(S[key]);
  };
  el.addEventListener("input", apply);
  if (onInput) el.addEventListener("input", onInput);
  apply();
}
bindRange("wps", "wps", v => v, renderChips);
bindRange("size", "sizePct", v => String(v).replace(/\.0+$/, "") + "%");
bindRange("pos", "posPct", v => v + "%");

function buildSwatches(wrap, list, get, set) {
  if (!wrap) return;
  list.forEach(([hex, name]) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "swatch"; b.style.background = hex;
    b.title = name; b.setAttribute("aria-label", name);
    b.setAttribute("aria-pressed", hex === get() ? "true" : "false");
    b.addEventListener("click", () => {
      set(hex);
      [...wrap.children].forEach(c => c.setAttribute("aria-pressed", c === b ? "true" : "false"));
    });
    wrap.appendChild(b);
  });
}
buildSwatches($("swatches"), COLORS, () => S.hlColor, v => S.hlColor = v);
buildSwatches($("keySwatches"), KEY_COLORS, () => S.keyColor, v => S.keyColor = v);

if ($("emphasise")) {
  $("emphasise").addEventListener("change", e => {
    S.emphasise = e.target.checked;
    if ($("keyRow")) $("keyRow").style.display = S.emphasise ? "" : "none";
    renderChips();
  });
}

/* ============================================================
   Caption rendering
   ============================================================ */
function activeIndexAt(t) {
  for (let i = 0; i < S.words.length; i++) {
    const w = S.words[i];
    if (w.start !== null && w.end !== null && t >= w.start && t < w.end) return i;
  }
  return -1;
}

function groupOf(i) {
  const n = S.wps, g = Math.floor(i / n);
  return { from: g * n, words: S.words.slice(g * n, g * n + n) };
}

function drawCaptions(ctx, W, H, t) {
  const idx = activeIndexAt(t);
  if (idx < 0) return;                       // between groups: show nothing
  const g = groupOf(idx);
  const words = g.words;

  let fontPx = (S.sizePct / 100) * H;
  const maxW = W * 0.88;

  const measure = () => {
    ctx.font = fontPx + "px " + FONT_STACK;
    const ws = words.map(w => ctx.measureText(w.text).width);
    const gap = fontPx * 0.28;
    return { ws, gap, total: ws.reduce((a, b) => a + b, 0) + gap * (words.length - 1) };
  };

  let m = measure();
  if (m.total > maxW) { fontPx *= maxW / m.total; m = measure(); }  // shrink to fit, never clip

  const y = (S.posPct / 100) * H;
  let x = (W - m.total) / 2;

  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;
  ctx.lineWidth = fontPx * 0.17;
  ctx.strokeStyle = "#000";

  words.forEach((w, k) => {
    const isCurrent = (g.from + k === idx);
    let wordY = y;
    let wordScale = 1;
    let wordAlpha = 1;
    let shadowGlow = false;

    if (isCurrent && w.start !== null && w.end !== null) {
      const dur = Math.max(0.08, w.end - w.start);
      const prog = Math.min(1, Math.max(0, (t - w.start) / dur));

      if (S.animStyle === "pop") {
        wordScale = 1 + 0.18 * Math.sin(prog * Math.PI);
      } else if (S.animStyle === "bounce") {
        wordY -= fontPx * 0.12 * Math.sin(prog * Math.PI);
      } else if (S.animStyle === "fade") {
        wordAlpha = Math.min(1, prog * 3);
      } else if (S.animStyle === "glow") {
        shadowGlow = true;
      } else if (S.animStyle === "slide") {
        wordY += fontPx * 0.2 * (1 - Math.min(1, prog * 2.5));
      }
    }

    ctx.save();
    if (wordAlpha < 1) ctx.globalAlpha = wordAlpha;
    if (wordScale !== 1) {
      ctx.translate(x + m.ws[k] / 2, wordY);
      ctx.scale(wordScale, wordScale);
      ctx.translate(-(x + m.ws[k] / 2), -wordY);
    }

    if (shadowGlow && isCurrent) {
      ctx.shadowColor = S.hlColor;
      ctx.shadowBlur = fontPx * 0.4;
    } else {
      ctx.shadowColor = "rgba(0,0,0,0.45)";
      ctx.shadowBlur = fontPx * 0.14;
      ctx.shadowOffsetY = fontPx * 0.06;
    }

    ctx.strokeText(w.text, x, wordY);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

    ctx.fillStyle = isCurrent ? S.hlColor
                  : (S.emphasise && w.key) ? S.keyColor
                  : "#FFFFFF";
    ctx.fillText(w.text, x, wordY);
    ctx.restore();

    x += m.ws[k] + m.gap;
  });
  ctx.restore();
}

function frameLoop() {
  const W = overlay.width, H = overlay.height;
  octx.clearRect(0, 0, W, H);
  if (video.src) {
    // keep the two elements from drifting apart
    if (S.hasAudio && audio.src && !audio.paused && isFinite(video.duration)) {
      if (Math.abs(video.currentTime - audio.currentTime) > 0.12 && audio.currentTime <= video.duration) {
        video.currentTime = audio.currentTime;
      }
    }
    drawCaptions(octx, W, H, nowTime());
    $("tNow").textContent = fmtClock(nowTime());
  }
  requestAnimationFrame(frameLoop);
}
requestAnimationFrame(frameLoop);

/* ============================================================
   Formatting helpers
   ============================================================ */
function fmtClock(s) {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60), r = s - m * 60;
  return m + ":" + (r < 10 ? "0" : "") + r.toFixed(2);
}
function assTime(s) {
  s = Math.max(0, s || 0);
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const cs = Math.round(s * 100);
  const ss = Math.floor(cs / 100), cc = cs % 100;
  return h + ":" + String(m).padStart(2, "0") + ":" + String(ss).padStart(2, "0") + "." + String(cc).padStart(2, "0");
}
function srtTime(s) {
  s = Math.max(0, s || 0);
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const ms = Math.round(s * 1000);
  const ss = Math.floor(ms / 1000), mmm = ms % 1000;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" +
         String(ss).padStart(2, "0") + "," + String(mmm).padStart(3, "0");
}
/* ASS colours are &HAABBGGRR — blue first, red last. */
function assColor(hex) {
  const h = hex.replace("#", "");
  const r = h.slice(0, 2), g = h.slice(2, 4), b = h.slice(4, 6);
  return "&H00" + (b + g + r).toUpperCase() + "&";
}
function download(name, data, mime) {
  const blob = (data instanceof Blob) ? data : new Blob([data], { type: mime || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
const baseName = () => (S.videoName || "captions");

/* ============================================================
   Exports
   ============================================================ */
function groups() {
  const out = [];
  for (let i = 0; i < S.words.length; i += S.wps) out.push(S.words.slice(i, i + S.wps));
  return out;
}

function buildASS() {
  const W = video.videoWidth || 1080, H = video.videoHeight || 1920;
  const fontSize = Math.round((S.sizePct / 100) * H);
  const outline = Math.max(1, +((fontSize * 0.085).toFixed(1)));
  const shadow = Math.max(0, +((fontSize * 0.05).toFixed(1)));
  const x = Math.round(W / 2), y = Math.round((S.posPct / 100) * H);
  const WHITE = "&H00FFFFFF&";
  const HL = assColor(S.hlColor);

  const L = [];
  L.push("[Script Info]");
  L.push("; Generated by Caption Studio");
  L.push("ScriptType: v4.00+");
  L.push("WrapStyle: 2");
  L.push("ScaledBorderAndShadow: yes");
  L.push("YCbCr Matrix: TV.709");
  L.push("PlayResX: " + W);
  L.push("PlayResY: " + H);
  L.push("");
  L.push("[V4+ Styles]");
  L.push("Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding");
  L.push("Style: Karaoke,Anton," + fontSize + ",&H00FFFFFF,&H000000FF,&H00000000,&H73000000,0,0,0,0,100,100,0,0,1," +
         outline + "," + shadow + ",5,40,40,40,1");
  L.push("");
  L.push("[Events]");
  L.push("Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text");

  S.words.forEach((w, i) => {
    if (w.start === null || w.end === null) return;
    const g = groupOf(i);
    const KEY = assColor(S.keyColor);
    const text = g.words.map((word, k) => {
      if (g.from + k === i) return "{\\c" + HL + "}" + word.text + "{\\c" + WHITE + "}";
      if (S.emphasise && word.key) return "{\\c" + KEY + "}" + word.text + "{\\c" + WHITE + "}";
      return word.text;
    }).join(" ");
    let fx = "";
    if (S.animStyle === "pop") fx = "\\fscx0\\fscy0\\t(0,150,\\fscx100\\fscy100)";
    if (S.animStyle === "bounce") fx = "\\fscx0\\fscy0\\t(0,100,\\fscx120\\fscy120)\\t(100,200,\\fscx100\\fscy100)";
    if (S.animStyle === "fade") fx = "\\fad(200,0)";
    
    L.push("Dialogue: 0," + assTime(w.start) + "," + assTime(w.end) +
           ",Karaoke,,0,0,0,,{\\pos(" + x + "," + y + ")" + fx + "}" + text);
  });
  return L.join("\r\n") + "\r\n";
}

function buildSRT() {
  const out = [];
  let n = 1;
  groups().forEach(g => {
    const timed = g.filter(w => w.start !== null && w.end !== null);
    if (!timed.length) return;
    out.push(String(n++));
    out.push(srtTime(timed[0].start) + " --> " + srtTime(timed[timed.length - 1].end));
    out.push(g.map(w => w.text).join(" "));
    out.push("");
  });
  return out.join("\r\n");
}

function buildJSON() {
  return JSON.stringify({
    words: S.words.map(w => ({
      text: w.text,
      start: +(w.start || 0).toFixed(3),
      end: +(w.end || 0).toFixed(3)
    }))
  }, null, 2);
}

const bindExportBtn = (id1, id2, fn) => {
  const btn = $(id1) || $(id2);
  if (btn) btn.addEventListener("click", fn);
};

bindExportBtn("expAss", "btnExportAss", () => { download(baseName() + ".ass", buildASS()); say("Saved " + baseName() + ".ass", "ok"); });
bindExportBtn("expSrt", "btnExportSrt", () => { download(baseName() + ".srt", buildSRT()); say("Saved " + baseName() + ".srt", "ok"); });
bindExportBtn("expJson", "btnExportJson", () => { download(baseName() + ".json", buildJSON(), "application/json"); say("Saved " + baseName() + ".json", "ok"); });

function say(msg, kind) {
  const el = $("exportStatus");
  if (el) {
    el.textContent = msg;
    el.className = "status" + (kind ? " " + kind : "");
  }
}

function refreshExports() {
  const ok = allTimed();
  ["expAss", "btnExportAss", "expSrt", "btnExportSrt", "expJson", "btnExportJson", "expBurn", "btnExportWebm"].forEach(id => {
    if ($(id)) $(id).disabled = !ok || S.recording;
  });
  if (S.recording) return;
  if (!S.words.length) { say(""); return; }
  if (!ok) {
    const left = S.words.filter(w => w.start === null).length;
    say(left ? left + " word" + (left === 1 ? "" : "s") + " still to tap." : "One more tap on Space closes the last word.");
  } else {
    say("All " + S.words.length + " words timed. Ready to save.", "ok");
  }
  if (typeof saveSessionState === "function") saveSessionState();
}

/* ============================================================
   Burn-in recorder
   ============================================================ */
const CAN_RECORD = !!(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream);

["expBurn", "btnExportWebm"].forEach(id => {
  if ($(id)) $(id).addEventListener("click", burnIn);
});

async function burnIn() {
  if (!CAN_RECORD) {
    say("This browser can't record video. Save the .ass file and burn it in with ffmpeg instead.", "warn");
    return;
  }
  const W = video.videoWidth, H = video.videoHeight;
  if (!W || !H) { say("Load a video first.", "warn"); return; }

  const mimes = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  const mime = mimes.find(m => MediaRecorder.isTypeSupported(m));
  if (!mime) { say("This browser can't record WebM. Save the .ass file and burn it in with ffmpeg instead.", "warn"); return; }

  const rc = document.createElement("canvas");
  rc.width = W; rc.height = H;
  const rctx = rc.getContext("2d");
  const stream = rc.captureStream(30);

  // Getting the sound in depends on where the voiceover comes from.
  const speaking = S.voMode === "generated" && CAN_SPEAK && $("voice").value !== "";
  let tabStream = null;

  if (speaking) {
    // A spoken voice has no media element behind it, so there is nothing to
    // captureStream() from. The only way to record it is to capture this tab's
    // own audio — which Chrome will ask you to allow.
    try {
      tabStream = await navigator.mediaDevices.getDisplayMedia({
        video: true, audio: true, preferCurrentTab: true
      });
      const at = tabStream.getAudioTracks();
      tabStream.getVideoTracks().forEach(t => t.stop());   // we draw our own frames
      if (at.length) stream.addTrack(at[0]);
      else say("No tab audio was shared, so the voice won't be recorded. Re-run and tick “Also share tab audio”.", "warn");
    } catch (err) {
      say("Sharing was cancelled — recording the video without the voiceover.", "warn");
      tabStream = null;
    }
  } else {
    // Pull the audio off whichever element is actually making sound.
    const src = master();
    try {
      const ms = src.captureStream ? src.captureStream() : (src.mozCaptureStream ? src.mozCaptureStream() : null);
      if (ms) ms.getAudioTracks().forEach(t => stream.addTrack(t));
    } catch (err) {
      say("Recording without sound — the browser blocked audio capture.", "warn");
    }
  }

  let rec;
  try { rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 }); }
  catch (err) { say("Recording wouldn't start. Save the .ass file and burn it in with ffmpeg instead.", "warn"); return; }

  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };

  const dur = totalTime();
  S.recording = true;
  refreshExports();
  pauseAll();
  seekAll(0);
  await new Promise(r => setTimeout(r, 200));

  rec.onstop = () => {
    stream.getTracks().forEach(t => { if (t.kind === "video") t.stop(); });
    if (tabStream) tabStream.getTracks().forEach(t => t.stop());
    if (speaking) stopSpeaking();
    S.recording = false;
    pauseAll();
    video.muted = (S.voMode === "file" && S.hasAudio);
    download(baseName() + "-captioned.webm", new Blob(chunks, { type: mime }));
    say("Saved " + baseName() + "-captioned.webm", "ok");
    refreshExports();
  };

  rec.start(250);
  if (speaking) speakScript(false);   // starts the video itself, in step with the voice
  else playAll();

  const wallStart = performance.now();
  const tick = () => {
    rctx.drawImage(video, 0, 0, W, H);
    const t = nowTime();
    drawCaptions(rctx, W, H, t);
    say("Recording… " + Math.min(100, Math.round(t / dur * 100)) + "%");
    const finished = t >= dur - 0.04 || (video.ended && (!S.hasAudio || audio.ended));
    // backstop: never spin forever if the voice fails to start at all
    const stalled = performance.now() - wallStart > (dur + 20) * 1000;
    if (finished || stalled) { rec.stop(); return; }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/* ============================================================
   Boot
   ============================================================ */
if (!CAN_RECORD) {
  ["expBurn", "btnExportWebm"].forEach(id => {
    if ($(id)) $(id).title = "Not supported in this browser — use the .ass export with ffmpeg.";
  });
}
if (document.fonts && document.fonts.load) {
  document.fonts.load('400 100px Anton', 'AA').catch(() => {});
}
parseScript();
setMode("generated");
syncTransport();

/* Exposed only so the acceptance checks can be run from the console. */
window.__cs = { S, buildASS, buildSRT, buildJSON, markWord, undoMark, resyncFrom, clearAll,
                activeIndexAt, drawCaptions, parseScript, cursorIndex, allTimed, assColor,
                wordIndexAtChar, setStartAt, normalizeTimings, speakScript, stopSpeaking,
                setMode, loadVoices, CAN_SPEAK, get voices() { return voices; } };


/* ============================================================
   Gemini API Key & Client-Side Cloud Integration
   ============================================================ */
function getApiKey() {
  return localStorage.getItem("gemini_api_key") || "";
}

function setApiKey(key) {
  if (key) {
    localStorage.setItem("gemini_api_key", key);
  } else {
    localStorage.removeItem("gemini_api_key");
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
    $("apiKeyInput").value = getApiKey();
    $("apiKeyModal").classList.add("open");
  });
}
if ($("modalCloseBtn")) {
  $("modalCloseBtn").addEventListener("click", () => {
    $("apiKeyModal").classList.remove("open");
  });
}
if ($("apiKeySaveBtn")) {
  $("apiKeySaveBtn").addEventListener("click", () => {
    const val = $("apiKeyInput").value.trim();
    setApiKey(val);
    $("apiKeyModal").classList.remove("open");
  });
}
if ($("apiKeyClearBtn")) {
  $("apiKeyClearBtn").addEventListener("click", () => {
    setApiKey("");
    $("apiKeyInput").value = "";
    $("apiKeyModal").classList.remove("open");
  });
}
updateApiKeyBtnState();

async function callGeminiApi(promptText, audioBlob = null, jsonSchema = null) {
  const apiKey = getApiKey();
  if (!apiKey) {
    $("apiKeyModal").classList.add("open");
    throw new Error("Please set your Gemini API key in the settings modal first.");
  }

  const parts = [{ text: promptText }];

  if (audioBlob) {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64Audio = btoa(binary);
    parts.push({
      inlineData: {
        mimeType: audioBlob.type || "audio/wav",
        data: base64Audio
      }
    });
  }

  const reqBody = {
    contents: [{ role: "user", parts: parts }]
  };

  if (jsonSchema) {
    reqBody.generationConfig = {
      responseMimeType: "application/json",
      responseSchema: jsonSchema,
      temperature: 0.1
    };
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(reqBody)
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error?.message || `Gemini API HTTP Error ${res.status}`);
  }

  const data = await res.json();
  const resText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!resText) throw new Error("Empty response from Gemini API");

  return jsonSchema ? JSON.parse(resText) : resText.trim();
}

async function extractAudioWav(file, maxSeconds = 300) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  ctx.close();
  const sr = 16000;
  const dur = Math.min(decoded.duration, maxSeconds);
  const off = new OfflineAudioContext(1, Math.ceil(dur * sr), sr);
  const src = off.createBufferSource();
  src.buffer = decoded; src.connect(off.destination); src.start(0);
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0), n = pcm.length;
  const ab = new ArrayBuffer(44 + n * 2), dv = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([ab], { type: 'audio/wav' });
}

/* ============================================================
   AI Feature Event Handlers
   ============================================================ */
if ($("btnGenerate")) {
  $("btnGenerate").addEventListener("click", async () => {
    const topic = $("topicInput").value.trim();
    if (!topic) return alert("Enter a topic first!");
    const btn = $("btnGenerate");
    const orig = btn.textContent;
    btn.textContent = "⏳ Generating...";
    btn.disabled = true;
    try {
      const prompt = `Write a highly engaging, 30-second script for a TikTok/Reels video about: "${topic}". Start with a strong hook. Keep sentences short and punchy. Return ONLY the spoken script text, no punctuation or markdown.`;
      const result = await callGeminiApi(prompt);
      scriptEl.value = result;
      parseScript();
      btn.textContent = "✨ Done!";
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
    } catch(e) {
      alert(e.message);
      btn.textContent = orig; btn.disabled = false;
    }
  });
}

if ($("btnRewrite")) {
  $("btnRewrite").addEventListener("click", async () => {
    const text = scriptEl.value.trim();
    if (!text) return alert("Please paste a script first!");
    const btn = $("btnRewrite");
    const orig = btn.textContent;
    btn.textContent = "⏳ Rewriting...";
    btn.disabled = true;
    try {
      const prompt = `Rewrite the following script to make it punchy, energetic, and concise for a TikTok/Shorts video caption. Return ONLY the spoken text, without punctuation.\n\nSCRIPT:\n${text}`;
      const result = await callGeminiApi(prompt);
      scriptEl.value = result;
      parseScript();
      btn.textContent = "✨ Rewritten!";
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
    } catch(e) {
      alert(e.message);
      btn.textContent = orig; btn.disabled = false;
    }
  });
}

if ($("btnEmojify")) {
  $("btnEmojify").addEventListener("click", async () => {
    const text = scriptEl.value.trim();
    if (!text) return alert("Please paste a script first!");
    const btn = $("btnEmojify");
    const orig = btn.textContent;
    btn.textContent = "⏳ Adding Emojis...";
    btn.disabled = true;
    try {
      const prompt = `Take the following script and insert relevant emojis into the text (max 1 emoji per sentence/phrase). Keep original words intact.\n\nSCRIPT:\n${text}`;
      const result = await callGeminiApi(prompt);
      scriptEl.value = result;
      parseScript();
      btn.textContent = "😊 Emojified!";
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
    } catch(e) {
      alert(e.message);
      btn.textContent = orig; btn.disabled = false;
    }
  });
}

if ($("btnTranscribe")) {
  $("btnTranscribe").addEventListener("click", async () => {
    const file = $("audioFile").files[0] || $("videoFile").files[0];
    if (!file) return alert("Please load a video or audio file first.");
    const btn = $("btnTranscribe");
    const orig = btn.textContent;
    btn.textContent = "⏳ Extracting audio...";
    btn.disabled = true;
    try {
      const audioBlob = await extractAudioWav(file, 300);
      btn.textContent = "🧠 Gemini transcribing...";
      const schema = {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            word: { type: "STRING" },
            start: { type: "NUMBER" },
            end: { type: "NUMBER" }
          },
          required: ["word", "start", "end"]
        }
      };
      const prompt = `Listen to this audio clip and transcribe the spoken words with exact start and end timestamps in seconds. Do not include punctuation in the word field.`;
      const timings = await callGeminiApi(prompt, audioBlob, schema);
      if (Array.isArray(timings) && timings.length > 0) {
        S.words = timings.map(t => ({
          text: t.word.toUpperCase(),
          start: t.start,
          end: t.end,
          key: false
        }));
        scriptEl.value = timings.map(t => t.word.toUpperCase()).join(" ");
        renderChips();
        refreshExports();
        btn.textContent = "✅ Transcribed!";
      } else {
        throw new Error("Invalid response from Gemini.");
      }
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
    } catch(e) {
      alert("Transcription failed: " + e.message);
      btn.textContent = orig; btn.disabled = false;
    }
  });
}

if ($("btnAiSync")) {
  $("btnAiSync").addEventListener("click", async () => {
    const file = $("audioFile").files[0] || $("videoFile").files[0];
    if (!file) return alert("Please load a video or audio file first.");
    if (!S.words || S.words.length === 0) return alert("Please paste your script first.");
    const btn = $("btnAiSync");
    const orig = btn.textContent;
    btn.textContent = "⏳ Extracting audio...";
    btn.disabled = true;
    try {
      const audioBlob = await extractAudioWav(file, 300);
      btn.textContent = "🧠 Gemini aligning...";
      const schema = {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            word: { type: "STRING" },
            start: { type: "NUMBER" },
            end: { type: "NUMBER" }
          },
          required: ["word", "start", "end"]
        }
      };
      const scriptWordsStr = S.words.map(w => w.text).join(" ");
      const prompt = `Align this audio clip with the exact word sequence:\n"${scriptWordsStr}"\n\nReturn exact start and end timestamps in seconds for each word.`;
      const timings = await callGeminiApi(prompt, audioBlob, schema);
      if (Array.isArray(timings) && timings.length > 0) {
        for (let i = 0; i < S.words.length; i++) {
          const t = timings[i];
          if (t) {
            S.words[i].start = t.start;
            S.words[i].end = t.end;
          }
        }
        renderChips();
        refreshExports();
        btn.textContent = "✅ Synced!";
      } else {
        throw new Error("Invalid response from Gemini.");
      }
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 3000);
    } catch(e) {
      alert("AI Sync failed: " + e.message);
      btn.textContent = orig; btn.disabled = false;
    }
  });
}

/* ============================================================
   Step 4 UI Events & Color Swatches
   ============================================================ */
if ($("captionAnimStyle")) {
  $("captionAnimStyle").addEventListener("change", e => {
    S.animStyle = e.target.value;
    saveSessionState();
  });
}
if ($("customHlColor")) {
  $("customHlColor").addEventListener("input", e => {
    S.hlColor = e.target.value;
    if ($("colorPresets")) {
      const pills = $("colorPresets").querySelectorAll(".color-preset-pill");
      pills.forEach(p => p.classList.remove("active"));
    }
    saveSessionState();
  });
}
if ($("colorPresets")) {
  const pills = $("colorPresets").querySelectorAll(".color-preset-pill");
  pills.forEach(pill => {
    pill.addEventListener("click", () => {
      pills.forEach(p => p.classList.remove("active"));
      pill.classList.add("active");
      const hex = pill.getAttribute("data-color");
      S.hlColor = hex;
      if ($("customHlColor")) $("customHlColor").value = hex;
      saveSessionState();
    });
  });
}

/* ============================================================
   Auto-Save & Session Persistence (localStorage)
   ============================================================ */
const AUTO_SAVE_KEY = "captionStudio_savedSession";

function saveSessionState() {
  try {
    const data = {
      scriptText: scriptEl ? scriptEl.value : "",
      words: S.words,
      animStyle: S.animStyle,
      hlColor: S.hlColor,
      keyColor: S.keyColor,
      emphasise: S.emphasise,
      wps: S.wps,
      sizePct: S.sizePct,
      posPct: S.posPct,
      rate: S.rate,
      updatedAt: Date.now()
    };
    localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(data));
    showAutoSaveBadge();
  } catch (e) {
    console.warn("Auto-save failed:", e);
  }
}

function loadSessionState() {
  try {
    const raw = localStorage.getItem(AUTO_SAVE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data) return false;

    if (data.scriptText !== undefined && scriptEl) {
      scriptEl.value = data.scriptText;
    }
    if (Array.isArray(data.words) && data.words.length > 0) {
      S.words = data.words;
    }
    if (data.animStyle) {
      S.animStyle = data.animStyle;
      if ($("captionAnimStyle")) $("captionAnimStyle").value = data.animStyle;
    }
    if (data.hlColor) {
      S.hlColor = data.hlColor;
      if ($("customHlColor")) $("customHlColor").value = data.hlColor;
      if ($("colorPresets")) {
        const pills = $("colorPresets").querySelectorAll(".color-preset-pill");
        pills.forEach(p => {
          if (p.getAttribute("data-color") === data.hlColor) p.classList.add("active");
          else p.classList.remove("active");
        });
      }
    }
    if (data.keyColor) S.keyColor = data.keyColor;
    if (data.emphasise !== undefined) {
      S.emphasise = data.emphasise;
      if ($("emphasise")) $("emphasise").checked = data.emphasise;
    }
    if (data.wps !== undefined) {
      S.wps = data.wps;
      if ($("wps")) $("wps").value = data.wps;
    }
    if (data.sizePct !== undefined) {
      S.sizePct = data.sizePct;
      if ($("size")) $("size").value = data.sizePct;
    }
    if (data.posPct !== undefined) {
      S.posPct = data.posPct;
      if ($("pos")) $("pos").value = data.posPct;
    }
    if (data.rate !== undefined) {
      S.rate = data.rate;
      if ($("rate")) $("rate").value = data.rate;
      if ($("rateVal")) $("rateVal").textContent = data.rate.toFixed(2) + "×";
    }

    renderChips();
    refreshExports();
    showAutoSaveBadge();
    return true;
  } catch (e) {
    console.warn("Failed to load session:", e);
    return false;
  }
}

function clearSessionState() {
  localStorage.removeItem(AUTO_SAVE_KEY);
  S.words = [];
  if (scriptEl) scriptEl.value = "";
  renderChips();
  refreshExports();
  hideAutoSaveBadge();
}

function showAutoSaveBadge() {
  const badge = $("autoSaveBadge");
  if (badge) badge.style.display = "inline-flex";
}

function hideAutoSaveBadge() {
  const badge = $("autoSaveBadge");
  if (badge) badge.style.display = "none";
}

if ($("autoSaveBadge")) {
  $("autoSaveBadge").addEventListener("click", () => {
    if (confirm("Clear auto-saved script, timings, and style session?")) {
      clearSessionState();
    }
  });
}

// Restore session state automatically on startup
loadSessionState();


