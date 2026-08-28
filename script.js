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

/* ============================================================
   Several clips, one timeline.

   Each clip keeps its own <video> element, preloaded, so moving from one
   to the next is a switch rather than a load - no black frame in the
   middle of a recording. Everything downstream still asks the same
   questions (what time is it, how long is it, seek there), so captions,
   timing and export never learn there is more than one file.
   ============================================================ */
S.clips = [];          // { file, url, el, duration, start }

const clipEls = document.createElement("div");
clipEls.style.display = "none";
document.body.appendChild(clipEls);

function totalClipDuration() {
  return S.clips.reduce((a, c) => a + (isFinite(c.duration) ? c.duration : 0), 0);
}

function recomputeClipStarts() {
  let t = 0;
  S.clips.forEach(c => { c.start = t; t += isFinite(c.duration) ? c.duration : 0; });
}

/* Which clip is on screen at timeline second t, and where inside it. */
function clipAt(t) {
  if (!S.clips.length) return null;
  for (let i = 0; i < S.clips.length; i++) {
    const c = S.clips[i];
    if (t < c.start + c.duration || i === S.clips.length - 1) {
      return { i, clip: c, local: Math.max(0, Math.min(c.duration, t - c.start)) };
    }
  }
  return null;
}

let activeClip = 0;
const activeEl = () => S.clips.length ? S.clips[activeClip].el : video;

function loadClipFiles(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  let pending = list.length;

  list.forEach(f => {
    const url = URL.createObjectURL(f);
    const el = document.createElement("video");
    el.preload = "auto";
    el.playsInline = true;
    el.src = url;
    clipEls.appendChild(el);
    const clip = { file: f, url, el, duration: 0, start: 0, name: f.name };
    S.clips.push(clip);
    el.addEventListener("loadedmetadata", () => {
      clip.duration = isFinite(el.duration) ? el.duration : 0;
      if (--pending === 0) afterClipsLoaded();
      recomputeClipStarts();
      renderClipList();
      syncTransport();
    });
    el.addEventListener("error", () => {
      clip.duration = 0;
      if (--pending === 0) afterClipsLoaded();
      renderClipList();
    });
  });
}

function afterClipsLoaded() {
  recomputeClipStarts();
  const first = S.clips[0];
  if (first) {
    S.videoName = first.name.replace(/\.[^.]+$/, "");
    overlay.width = first.el.videoWidth || 1080;
    overlay.height = first.el.videoHeight || 1920;
    $("stageEmpty").style.display = "none";
  }
  activeClip = 0;
  showActiveClip();
  renderClipList();
  syncTransport();
  updateSafeZoneWarning();
}

/* The on-stage <video> mirrors whichever clip is current, so the preview
   keeps working exactly as it did with a single file. */
function showActiveClip() {
  const c = S.clips[activeClip];
  if (!c) return;
  if (video.src !== c.url) { video.src = c.url; video.load(); }
}

function removeClip(i) {
  const c = S.clips[i];
  if (!c) return;
  try { URL.revokeObjectURL(c.url); } catch (e) {}
  c.el.remove();
  S.clips.splice(i, 1);
  recomputeClipStarts();
  activeClip = Math.min(activeClip, Math.max(0, S.clips.length - 1));
  if (!S.clips.length) {
    video.removeAttribute("src"); video.load();
    $("stageEmpty").style.display = "";
  } else showActiveClip();
  renderClipList();
  syncTransport();
}

function moveClip(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= S.clips.length) return;
  const [c] = S.clips.splice(i, 1);
  S.clips.splice(j, 0, c);
  recomputeClipStarts();
  renderClipList();
  syncTransport();
}

function renderClipList() {
  const box = $("clipList");
  if (!box) return;
  box.replaceChildren();
  if (!S.clips.length) { box.style.display = "none"; return; }
  box.style.display = "";

  S.clips.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "clip-row";

    const num = document.createElement("span");
    num.className = "clip-num";
    num.textContent = i + 1;

    const name = document.createElement("span");
    name.className = "clip-name";
    name.textContent = c.name;

    const dur = document.createElement("span");
    dur.className = "clip-dur";
    dur.textContent = c.duration ? c.duration.toFixed(1) + "s" : "…";

    const up = document.createElement("button");
    up.textContent = "↑"; up.title = "Move earlier"; up.disabled = i === 0;
    up.addEventListener("click", () => moveClip(i, -1));

    const down = document.createElement("button");
    down.textContent = "↓"; down.title = "Move later"; down.disabled = i === S.clips.length - 1;
    down.addEventListener("click", () => moveClip(i, 1));

    const del = document.createElement("button");
    del.textContent = "✕"; del.title = "Remove this clip";
    del.addEventListener("click", () => removeClip(i));

    row.append(num, name, dur, up, down, del);
    box.appendChild(row);
  });

  const sum = document.createElement("div");
  sum.className = "clip-total";
  sum.textContent = S.clips.length === 1
    ? "1 clip · " + totalClipDuration().toFixed(1) + "s"
    : S.clips.length + " clips joined · " + totalClipDuration().toFixed(1) + "s total";
  box.appendChild(sum);
}

$("videoFile").addEventListener("change", e => {
  const files = e.target.files;
  if (!files || !files.length) return;
  loadClipFiles(files);
  $("videoName").textContent = files.length === 1
    ? files[0].name
    : files.length + " clips added";
  $("videoName").classList.remove("none");
  e.target.value = "";     // so the same file can be added again
});

/* ============================================================
   Dropping clips in.

   The drop zone and the preview frame both accept them. Files arrive in
   the order they were selected, which is the order they will play, and
   dropping again adds to what is already there rather than replacing it.
   ============================================================ */
function videoFilesFrom(dt) {
  const out = [];
  if (!dt) return out;
  // items[] carries the kind; files[] is the fallback for older paths
  if (dt.files && dt.files.length) {
    Array.from(dt.files).forEach(f => {
      const ext = f.name.includes(".") ? f.name.toLowerCase().split(".").pop() : "";
      const looksVideo = /^video\//.test(f.type) ||
                         ["mp4","mov","webm","m4v","avi","mkv","mpg","mpeg"].includes(ext);
      if (looksVideo) out.push(f);
    });
  }
  return out;
}

function wireDropTarget(el, activeClass) {
  if (!el) return;
  let depth = 0;   // dragenter/leave fire for children too, so count them
  const on = () => el.classList.add(activeClass);
  const off = () => el.classList.remove(activeClass);

  el.addEventListener("dragenter", e => {
    e.preventDefault(); depth++; on();
  });
  el.addEventListener("dragover", e => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  el.addEventListener("dragleave", e => {
    e.preventDefault(); depth = Math.max(0, depth - 1); if (!depth) off();
  });
  el.addEventListener("drop", e => {
    e.preventDefault(); depth = 0; off();
    const files = videoFilesFrom(e.dataTransfer);
    if (!files.length) {
      const any = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length;
      $("videoName").textContent = any
        ? "That isn't a video — drop an .mp4, .mov or .webm."
        : "Nothing was dropped.";
      $("videoName").classList.add("none");
      return;
    }
    const before = S.clips.length;
    loadClipFiles(files);
    $("videoName").textContent = before
      ? files.length + (files.length === 1 ? " clip added" : " clips added")
      : (files.length === 1 ? files[0].name : files.length + " clips added");
    $("videoName").classList.remove("none");
    if ($("dropHint")) $("dropHint").textContent = "Drop more clips here";
  });
}

wireDropTarget($("dropzone"), "over");
wireDropTarget(document.querySelector(".frame"), "over");

// a file dropped anywhere else shouldn't navigate away from the page
["dragover", "drop"].forEach(evt => {
  window.addEventListener(evt, e => {
    const inZone = e.target.closest && (e.target.closest("#dropzone") || e.target.closest(".frame"));
    if (!inZone) e.preventDefault();
  });
});

if ($("clearClips")) {
  $("clearClips").addEventListener("click", () => {
    while (S.clips.length) removeClip(0);
    $("videoName").textContent = "nothing loaded";
    $("videoName").classList.add("none");
    if ($("dropHint")) $("dropHint").textContent = "Drop clips here";
  });
}

$("audioFile").addEventListener("change", e => {
  const f = e.target.files[0]; if (!f) return;
  S.audioFileName = f.name;

  // Catch the obvious mistakes before the media element even tries.
  const ext = f.name.includes(".") ? f.name.toLowerCase().split(".").pop() : "";
  if (NOT_AUDIO[ext]) {
    $("audioName").textContent =
      `That's ${NOT_AUDIO[ext]}, not a voiceover — this needs an audio file (MP3, WAV, M4A) or a video.`;
    $("audioName").classList.add("none");
    e.target.value = "";
    S.hasAudio = false; video.muted = false;
    syncTransport();
    return;
  }

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

/* Timeline position across every clip, not just the one playing. */
const nowTime = () => {
  if (S.hasAudio && audio.src) return audio.currentTime || 0;
  if (!S.clips.length) return video.currentTime || 0;
  const c = S.clips[activeClip];
  return (c ? c.start : 0) + (video.currentTime || 0);
};

const totalTime = () => {
  const dv = S.clips.length ? totalClipDuration()
                            : (isFinite(video.duration) ? video.duration : 0);
  const da = (S.hasAudio && isFinite(audio.duration)) ? audio.duration : 0;
  return Math.max(dv, da);
};

function playAll() {
  if (!video.src && !S.clips.length) return;
  video.play().catch(() => {});
  if (S.hasAudio && audio.src) audio.play().catch(() => {});
}
function pauseAll() { video.pause(); if (audio.src) audio.pause(); }

/* Seeking means picking the right clip first, then the moment inside it. */
function seekAll(t) {
  t = Math.max(0, t);
  if (S.clips.length) {
    const hit = clipAt(t);
    if (hit) {
      if (hit.i !== activeClip) {
        activeClip = hit.i;
        showActiveClip();
        const go = () => { try { video.currentTime = hit.local; } catch (e) {} };
        if (video.readyState >= 1) go();
        else video.addEventListener("loadedmetadata", go, { once: true });
      } else if (isFinite(video.duration)) {
        video.currentTime = Math.min(hit.local, video.duration);
      }
    }
  } else if (video.src && isFinite(video.duration)) {
    video.currentTime = Math.min(t, video.duration);
  }
  if (S.hasAudio && audio.src && isFinite(audio.duration)) audio.currentTime = Math.min(t, audio.duration);
}

/* When a clip runs out, roll straight into the next one. */
function advanceClipIfEnded() {
  if (!S.clips.length || activeClip >= S.clips.length - 1) return false;
  const nearEnd = video.ended ||
                  (isFinite(video.duration) && video.currentTime >= video.duration - 0.05);
  if (!nearEnd) return false;
  const wasPlaying = !video.paused || S.recording;
  activeClip++;
  showActiveClip();
  const go = () => {
    try { video.currentTime = 0; } catch (e) {}
    if (wasPlaying) video.play().catch(() => {});
  };
  if (video.readyState >= 1) go();
  else video.addEventListener("loadedmetadata", go, { once: true });
  return true;
}

/* True only when the LAST clip has finished. */
function timelineEnded() {
  if (!S.clips.length) return video.ended;
  return activeClip >= S.clips.length - 1 && video.ended;
}
function togglePlay() { (master().paused) ? playAll() : pauseAll(); }

$("playBtn").addEventListener("click", togglePlay);
$("restartBtn").addEventListener("click", () => seekAll(0));
if ($("backBtn")) $("backBtn").addEventListener("click", () => seekAll(nowTime() - 1));
if ($("fwdBtn"))  $("fwdBtn").addEventListener("click",  () => seekAll(nowTime() + 1));

/* ============================================================
   The scrubber.

   Drag anywhere on the timeline to review a moment. Because seeking goes
   through seekAll, dragging works across joined clips as one strip. The
   bar also shows where the clips meet and where the talking is, so a
   silent gap or a bad join can be found by eye.
   ============================================================ */
let scrubbing = false;

function scrubFraction(ev) {
  const el = $("scrub");
  const r = el.getBoundingClientRect();
  const x = (ev.clientX !== undefined ? ev.clientX : 0) - r.left;
  return Math.max(0, Math.min(1, r.width ? x / r.width : 0));
}

function scrubTo(ev) {
  const dur = totalTime();
  if (!dur) return;
  seekAll(scrubFraction(ev) * dur);
  paintScrub();
}

if ($("scrub")) {
  const el = $("scrub");
  el.addEventListener("pointerdown", e => {
    if (!totalTime()) return;
    scrubbing = true;
    el.setPointerCapture(e.pointerId);
    scrubTo(e);
  });
  el.addEventListener("pointermove", e => { if (scrubbing) scrubTo(e); });
  const stop = e => {
    if (!scrubbing) return;
    scrubbing = false;
    try { el.releasePointerCapture(e.pointerId); } catch (err) {}
  };
  el.addEventListener("pointerup", stop);
  el.addEventListener("pointercancel", stop);
  el.addEventListener("keydown", e => {
    const step = e.shiftKey ? 5 : (e.key === "ArrowLeft" || e.key === "ArrowRight" ? 0.25 : 1);
    if (e.key === "ArrowLeft")  { e.preventDefault(); seekAll(nowTime() - step); }
    if (e.key === "ArrowRight") { e.preventDefault(); seekAll(nowTime() + step); }
    if (e.key === "Home")       { e.preventDefault(); seekAll(0); }
    if (e.key === "End")        { e.preventDefault(); seekAll(totalTime() - 0.05); }
  });
}

/* Where the clips meet, drawn once per change rather than every frame. */
function paintScrubMarks() {
  const joins = $("scrubJoins"), said = $("scrubSaid");
  if (!joins || !said) return;
  const dur = totalTime();
  joins.replaceChildren();
  said.replaceChildren();
  if (!dur) return;

  // clip boundaries
  S.clips.slice(1).forEach(c => {
    const i = document.createElement("i");
    i.style.left = (c.start / dur * 100) + "%";
    i.title = "Clip starts here";
    joins.appendChild(i);
  });

  // where words actually are, so silence shows as a gap
  S.words.forEach(w => {
    if (w.start === null || w.end === null) return;
    const i = document.createElement("i");
    i.style.left = (w.start / dur * 100) + "%";
    i.style.width = Math.max(0.4, (w.end - w.start) / dur * 100) + "%";
    said.appendChild(i);
  });
}

function paintScrub() {
  const dur = totalTime();
  const t = nowTime();
  const pct = dur ? Math.max(0, Math.min(100, t / dur * 100)) : 0;
  const fill = $("scrubFill"), head = $("scrubHead"), scrub = $("scrub");
  if (fill) fill.style.width = pct + "%";
  if (head) head.style.left = pct + "%";
  if (scrub) {
    scrub.setAttribute("aria-valuemax", dur.toFixed(1));
    scrub.setAttribute("aria-valuenow", t.toFixed(1));
    scrub.setAttribute("aria-valuetext", fmtClock(t) + " of " + fmtClock(dur));
  }
  const lbl = $("scrubWord");
  if (lbl) {
    const idx = activeIndexAt(t);
    const clip = S.clips.length > 1 ? clipAt(t) : null;
    const where = clip ? "clip " + (clip.i + 1) + " · " : "";
    lbl.innerHTML = idx >= 0
      ? where + "<b>" + S.words[idx].text + "</b>"
      : (dur ? where + "—" : "");
  }
}

/* The output size is fixed by the FIRST clip. Later clips of a different
   size are fitted into it, so the frame never changes shape part-way through. */
function outputSize() {
  const first = S.clips[0];
  const w = (first && first.el.videoWidth) || video.videoWidth || 1080;
  const h = (first && first.el.videoHeight) || video.videoHeight || 1920;
  return { w, h };
}

/* Fit a clip into the output frame without distorting it. */
function drawClipFitted(ctx, el, W, H) {
  const vw = el.videoWidth, vh = el.videoHeight;
  if (!vw || !vh) return;
  const scale = Math.min(W / vw, H / vh);
  const dw = vw * scale, dh = vh * scale;
  if (dw < W || dh < H) { ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H); }
  ctx.drawImage(el, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

video.addEventListener("loadedmetadata", () => {
  const { w, h } = outputSize();
  overlay.width = w;
  overlay.height = h;
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
/* Subtitle and text files get picked here by mistake, because they are the
   other thing this tool produces. Say what the file actually is rather than
   blaming the sound. */
const NOT_AUDIO = {
  ass: "a subtitle file", ssa: "a subtitle file", srt: "a subtitle file",
  vtt: "a subtitle file", json: "a timings file", txt: "a text file",
  pdf: "a document", doc: "a document", docx: "a document",
  png: "an image", jpg: "an image", jpeg: "an image", gif: "an image"
};

audio.addEventListener("error", () => {
  if (!audio.src) return;
  const name = (S.audioFileName || "").toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop() : "";
  const kind = NOT_AUDIO[ext];
  const el = $("audioName");
  el.textContent = kind
    ? `That's ${kind}, not a voiceover — this needs an audio file (MP3, WAV, M4A) or a video.`
    : "Couldn't read any sound from that file — this needs an audio file (MP3, WAV, M4A) or a video.";
  el.classList.add("none");
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
  if ($("backBtn")) $("backBtn").disabled = !ready;
  if ($("fwdBtn"))  $("fwdBtn").disabled  = !ready;
  paintScrubMarks();
  updatePlatformNote();
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
let savedVoiceApplied = false;   // the Voice Match pick is applied once, then you're in charge

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
  /* The voice chosen in Voice Match wins the first time the list is built.
     After that, whatever is selected is respected - including when this
     function re-runs because the browser reported more voices. */
  let applied = false;
  if (!savedVoiceApplied) {
    let saved = null;
    try { saved = localStorage.getItem("captionStudio.voice"); } catch (e) {}
    if (saved && $("savedVoice")) {
      const idx = voices.findIndex(v => v.name === saved);
      if (idx < 0) {
        savedVoiceApplied = true;
        $("savedVoice").style.display = "";
        $("savedVoice").style.color = "#e0b341";
        $("savedVoice").textContent = "“" + saved.replace(/^Microsoft /, "") +
          "” was picked in Voice Match but isn't installed in this browser. " +
          "Open this page in the browser you chose it in.";
      } else if (!voices[idx].localService && localOnly) {
        // Natural voices are online ones, so the offline filter would hide
        // the choice. Turn it off and rebuild rather than dropping it.
        $("localOnly").checked = false;
        $("netWarn").style.display = "";
        loadVoices();
        return;
      } else if (sel.querySelector('option[value="' + idx + '"]')) {
        sel.value = String(idx);
        applied = true;
        savedVoiceApplied = true;
        $("savedVoice").style.display = "";
        $("savedVoice").style.color = "#7fc9a4";
        $("savedVoice").textContent = "Using " + saved.replace(/^Microsoft /, "") + ", picked in Voice Match.";
      }
    } else if (!saved) {
      savedVoiceApplied = true;   // nothing saved, so stop looking
    }
  }
  if (!applied && keep && sel.querySelector('option[value="' + keep + '"]')) sel.value = keep;

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
/* Three places a voice can come from:
     "own"       - already inside the clips (Veo and anything filmed with sound)
     "generated" - spoken here by the browser
     "file"      - a separate audio file you load                            */
function setMode(mode) {
  S.voMode = mode;
  const panels = { own: "ownPanel", generated: "genPanel", file: "filePanel" };
  const tabs   = { own: "modeOwn",  generated: "modeGen",  file: "modeFile"  };
  Object.keys(panels).forEach(k => {
    const p = $(panels[k]), t = $(tabs[k]);
    if (p) p.style.display = (k === mode) ? "" : "none";
    if (t) t.setAttribute("aria-selected", k === mode ? "true" : "false");
  });
  if (mode !== "generated") stopSpeaking();
  // Only mute the clip when something else is providing the voice.
  video.muted = (mode === "file" && S.hasAudio);
  S.clips.forEach(c => { c.el.muted = video.muted; });
  syncTransport();
}
if ($("modeOwn"))  $("modeOwn").addEventListener("click",  () => setMode("own"));
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
    // The voice has started, so this instant is time zero for both.
    speakRun.t0 = performance.now();
    video.play().then(
      () => { speakRun.videoPlaying = true; },
      err => {
        // Playback refused. Timing must not silently fall back to a frozen
        // clock - that produced files with every word stamped at the same
        // moment. The voice's own elapsed time is used instead.
        speakRun.videoPlaying = false;
        speakRun.playError = String((err && err.message) || err);
      }
    );
    setVoStatus(recordTimings ? "Listening and timing the words…" : "Playing…");
    $("voStatus").classList.add("speaking");
  };

  /* Where are we, in seconds from the moment the voice began?
     The video's clock is preferred while it is genuinely running and agrees;
     otherwise the voice's own elapsed time carries the run. */
  function runClock() {
    const wall = speakRun && speakRun.t0 ? (performance.now() - speakRun.t0) / 1000 : 0;
    const vt = video.currentTime;
    const videoUsable = speakRun && speakRun.videoPlaying &&
                        !video.paused && !video.ended && Math.abs(vt - wall) < 0.6;
    if (videoUsable) return vt;
    speakRun.usedWallClock = true;
    return wall;
  }

  u.onboundary = e => {
    if (e.name && e.name !== "word") return;
    speakRun.boundaries++;
    if (!speakRun.recording) return;
    const i = wordIndexAtChar(e.charIndex);
    if (i < 0 || i <= speakRun.lastIdx) return;
    speakRun.lastIdx = i;
    setStartAt(i, runClock());
    renderChips();
  };

  u.onend = () => {
    const wall = speakRun && speakRun.t0 ? (performance.now() - speakRun.t0) / 1000 : 0;
    const spoken = (speakRun && speakRun.usedWallClock) ? wall : (video.currentTime || wall);
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
        speakRun = null; syncTransport();
        return;
      }

      /* A run only counts if the words are actually spread out. A clock that
         never moved produces every word at the same instant, which is how a
         file full of 0.02s captions got made. Refuse it rather than export it. */
      const marked = S.words.filter(w => w.start !== null);
      const spread = marked.length > 1 ? marked[marked.length - 1].start - marked[0].start : 0;
      if (spread < Math.min(1.0, spoken * 0.3)) {
        S.words.forEach(w => { w.start = null; w.end = null; });
        renderChips();
        setVoStatus("That run didn't record properly — every word landed at the same moment, " +
                    "so the timings were thrown away. Press Play first to check the video runs, " +
                    "then try again. Or use “⏱ Time it for me” in step 4.", "warn");
        speakRun = null; syncTransport();
        return;
      }

      const filled = normalizeTimings(spoken);
      S.spokenDur = spoken;
      renderChips();
      let msg = "Timed " + S.words.length + " words from the voiceover";
      if (filled) msg += " (" + filled + " estimated between boundaries)";
      msg += ". Voiceover " + spoken.toFixed(1) + "s · video " + totalTime().toFixed(1) + "s.";
      if (speakRun.usedWallClock) {
        msg += " (the video wouldn't play, so timings came from the voice itself — press Play to check they line up)";
      }
      setVoStatus(msg, speakRun.usedWallClock ? "warn" : "ok");
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

  paintScrubMarks();
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

/* ============================================================
   Facebook covers parts of the frame with its own interface. Text
   underneath is simply unreadable, and an unreadable caption wastes the
   whole clip - so show where not to put it, and say so if you have.
   Guides are preview-only; they are never drawn into an export.
   ============================================================ */
/* ============================================================
   Each platform covers a different part of the frame with its own
   interface and accepts caption files on different terms. These are
   working approximations from the current apps - the exact overlay shifts
   with device and app version, so treat the shading as "keep clear of
   this", not a pixel guarantee.
   ============================================================ */
const PLATFORMS = {
  facebook: {
    label: "Facebook",
    safe: { top: 0.08, bottom: 0.20, right: 0.15 },
    maxSeconds: 90,
    captionExt: ".en_US.srt",
    captionNote: "Facebook takes only .srt, and only when the name ends .en_US.srt.",
    lengthNote: "Reels run up to 90 seconds."
  },
  youtube: {
    label: "YouTube Shorts",
    safe: { top: 0.06, bottom: 0.16, right: 0.12 },
    maxSeconds: 180,
    captionExt: ".srt",
    captionNote: "YouTube takes .srt with any filename. Upload it on the video's subtitles page.",
    lengthNote: "Shorts run up to 3 minutes; anything longer becomes a normal video."
  },
  tiktok: {
    label: "TikTok",
    safe: { top: 0.10, bottom: 0.26, right: 0.16 },
    maxSeconds: 600,
    captionExt: ".srt",
    captionNote: "TikTok takes .srt on upload, under “Show more”.",
    lengthNote: "TikTok allows up to 10 minutes, but short still holds attention best."
  }
};

let platform = "facebook";
try { platform = localStorage.getItem("captionStudio.platform") || "facebook"; } catch (e) {}
if (!PLATFORMS[platform]) platform = "facebook";

const plat = () => PLATFORMS[platform];
Object.defineProperty(window, "SAFE_DEBUG", { get: () => plat().safe, configurable: true });

/* Kept as a name because the drawing code reads it every frame. */
let SAFE = plat().safe;

function drawSafeZones(ctx, W, H) {
  ctx.save();
  ctx.fillStyle = "rgba(221,95,119,0.14)";
  ctx.fillRect(0, 0, W, H * SAFE.top);
  ctx.fillRect(0, H * (1 - SAFE.bottom), W, H * SAFE.bottom);
  ctx.fillRect(W * (1 - SAFE.right), H * SAFE.top, W * SAFE.right, H * (1 - SAFE.top - SAFE.bottom));
  ctx.strokeStyle = "rgba(221,95,119,0.55)";
  ctx.lineWidth = Math.max(2, H * 0.002);
  ctx.setLineDash([H * 0.012, H * 0.012]);
  ctx.beginPath();
  ctx.moveTo(0, H * SAFE.top);              ctx.lineTo(W, H * SAFE.top);
  ctx.moveTo(0, H * (1 - SAFE.bottom));     ctx.lineTo(W, H * (1 - SAFE.bottom));
  ctx.moveTo(W * (1 - SAFE.right), 0);      ctx.lineTo(W * (1 - SAFE.right), H);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = Math.round(H * 0.016) + "px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(plat().label + " buttons sit here", W * 0.02, H * (1 - SAFE.bottom) + H * 0.03);
  ctx.restore();
}

/* Where would the caption band actually sit, at the current settings? */
function captionBand(H) {
  const fontPx = (S.sizePct / 100) * H;
  const y = (S.posPct / 100) * H;
  return { top: y - fontPx * 0.72, bottom: y + fontPx * 0.72 };
}

function safeZoneVerdict(H) {
  const band = captionBand(H);
  const topLine = H * SAFE.top, bottomLine = H * (1 - SAFE.bottom);
  if (band.bottom > bottomLine) {
    const over = Math.round(((band.bottom - bottomLine) / H) * 100);
    return { ok: false, msg: `Captions run ${over}% into ${plat().label}'s button area — raise “Height on frame” until this clears.` };
  }
  if (band.top < topLine) {
    return { ok: false, msg: `Captions run into ${plat().label}'s top bar — lower “Height on frame”.` };
  }
  return { ok: true, msg: `Captions clear ${plat().label}'s interface.` };
}

function updateSafeZoneWarning() {
  const el = $("safeWarn");
  if (!el) return;
  const H = overlay.height || 1920;
  const v = safeZoneVerdict(H);
  el.style.display = v.ok ? "none" : "";
  el.textContent = v.msg;
}

function frameLoop() {
  const W = overlay.width, H = overlay.height;
  octx.clearRect(0, 0, W, H);
  if ($("showSafe") && $("showSafe").checked && W && H) drawSafeZones(octx, W, H);
  if (!video.paused) advanceClipIfEnded();
  if (video.src) {
    // keep the two elements from drifting apart
    if (S.hasAudio && audio.src && !audio.paused && isFinite(video.duration)) {
      if (Math.abs(video.currentTime - audio.currentTime) > 0.12 && audio.currentTime <= video.duration) {
        video.currentTime = audio.currentTime;
      }
    }
    drawCaptions(octx, W, H, nowTime());
    $("tNow").textContent = fmtClock(nowTime());
    if (!scrubbing) paintScrub();
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
  const { w: W, h: H } = outputSize();
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

/* Facebook rejects a caption file unless the name ends .<lang>_<COUNTRY>.srt.
   The others are relaxed about it, so the name follows whichever platform
   is selected rather than always assuming Facebook. */
function platformSrtName() {
  const base = baseName().replace(/\.[a-z]{2}_[A-Z]{2}$/, "");
  return base + plat().captionExt;
}
bindExportBtn("expFbSrt", "btnExportFbSrt", () => {
  const name = platformSrtName();
  download(name, buildSRT());
  say("Saved " + name + " — " + plat().captionNote, "ok");
});

/* ---------- platform picker ---------- */
function applyPlatform(key) {
  if (!PLATFORMS[key]) return;
  platform = key;
  SAFE = plat().safe;
  try { localStorage.setItem("captionStudio.platform", key); } catch (e) {}

  Object.keys(PLATFORMS).forEach(k => {
    const btn = $("plat" + k.charAt(0).toUpperCase() + k.slice(1));
    if (btn) btn.setAttribute("aria-pressed", k === key ? "true" : "false");
  });

  const btn = $("btnExportFbSrt");
  if (btn) {
    btn.childNodes[0].nodeValue = "Save captions for " + plat().label;
    const small = btn.querySelector("small");
    if (small) small.textContent = plat().captionExt.replace(/^\./, "") + " · named the way it wants";
  }
  updatePlatformNote();
  updateSafeZoneWarning();
}

function updatePlatformNote() {
  const el = $("platNote");
  if (!el) return;
  const p = plat();
  const dur = totalTime();
  const over = dur > p.maxSeconds;
  el.className = "plat-note" + (over ? " over" : "");
  el.innerHTML = over
    ? `<b>Too long for ${p.label}.</b> Your video is ${dur.toFixed(0)}s and the limit is ${p.maxSeconds}s — trim it or remove a clip.`
    : `<b>${p.label}:</b> ${p.captionNote} ${p.lengthNote}` +
      (dur ? ` Yours is ${dur.toFixed(0)}s.` : "");
}

["facebook", "youtube", "tiktok"].forEach(k => {
  const btn = $("plat" + k.charAt(0).toUpperCase() + k.slice(1));
  if (btn) btn.addEventListener("click", () => applyPlatform(k));
});

function say(msg, kind) {
  const el = $("exportStatus");
  if (el) {
    el.textContent = msg;
    el.className = "status" + (kind ? " " + kind : "");
  }
}

function refreshExports() {
  const ok = allTimed();
  ["expAss", "btnExportAss", "expSrt", "btnExportSrt", "expFbSrt", "btnExportFbSrt",
   "expJson", "btnExportJson", "expBurn", "btnExportWebm"].forEach(id => {
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
  const { w: W, h: H } = outputSize();
  if (!W || !H) { say("Load a video first.", "warn"); return; }

  const mimes = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  const mime = mimes.find(m => MediaRecorder.isTypeSupported(m));
  if (!mime) { say("This browser can't record WebM. Save the .ass file and burn it in with ffmpeg instead.", "warn"); return; }

  const rc = document.createElement("canvas");
  rc.width = W; rc.height = H;
  const rctx = rc.getContext("2d");
  const stream = rc.captureStream(30);

  // Getting the sound in depends on where the voiceover comes from.
  // Only a voice spoken by the browser needs screen capture. A clip that
  // already carries its own sound, or a loaded voiceover file, is taken
  // straight off the media element.
  const speaking = S.voMode === "generated" && CAN_SPEAK && $("voice").value !== "";
  let tabStream = null;
  let levelMeter = null;

  if (speaking) {
    // A spoken voice has no media element behind it, so there is nothing to
    // captureStream() from. The only way to record it is to capture this tab's
    // own audio — which the browser will ask you to allow. Say what to tick
    // before the box appears, because getting it wrong costs a whole render.
    const ok = window.confirm(
      "To put the voice inside the video, the browser has to record the sound.\n\n" +
      "In the box that appears next:\n" +
      "  1. Choose ENTIRE SCREEN  (not the tab — tab audio records silence)\n" +
      "  2. Tick “Also share system audio”  ← without this the video is silent\n" +
      "  3. Press Share\n\n" +
      "Only the sound is used. The screen picture is discarded immediately —\n" +
      "the video you get is your own clip, not a recording of your screen.\n\n" +
      "Tip: run “Test the sound first” once to confirm this works.\n\n" +
      "Press OK to continue, or Cancel to stop."
    );
    if (!ok) {
      S.recording = false;
      say("Recording cancelled.", "warn");
      refreshExports();
      return;
    }
    try {
      tabStream = await navigator.mediaDevices.getDisplayMedia({
        // No preferCurrentTab: Windows plays the speech outside the tab, so tab
        // audio records silence. The whole picker must stay available so
        // "Entire Screen" with system audio can be chosen instead.
        video: true, audio: true, systemAudio: "include"
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
    // Take the sound straight off the element that is playing it. Routed
    // through Web Audio rather than captureStream, because the visible
    // element swaps source as clips change and the graph must outlive that.
    try {
      const track = stableAudioTrack(master());
      if (track) stream.addTrack(track);
      else say("Recording without sound — the browser wouldn't give up the audio.", "warn");
    } catch (err) {
      say("Recording without sound — " + (err.message || err), "warn");
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
    const peak = levelMeter ? levelMeter.peak() : 0;
    const hadAudio = stream.getAudioTracks().length > 0 && peak >= AUDIBLE;
    if (levelMeter) levelMeter.close();
    stream.getTracks().forEach(t => { if (t.kind === "video") t.stop(); });
    if (tabStream) tabStream.getTracks().forEach(t => t.stop());
    if (speaking) stopSpeaking();
    S.recording = false;
    pauseAll();
    video.muted = (S.voMode === "file" && S.hasAudio);
    download(baseName() + "-captioned.webm", new Blob(chunks, { type: mime }));

    /* Facebook and YouTube need the voice inside the file - a silent export
       is a wasted render, so say so plainly rather than letting it be
       discovered after upload. */
    if (hadAudio) {
      say(`Saved ${baseName()}-captioned.webm — with sound (level ${(peak * 100).toFixed(0)}%).`, "ok");
    } else if (speaking) {
      say(`Saved ${baseName()}-captioned.webm — but it came out SILENT (level ${(peak * 100).toFixed(1)}%). ` +
          `You most likely shared a tab or window instead of “Entire Screen”. ` +
          `Press “🔊 Test the sound first”, pick Entire Screen and tick “Also share system audio”, ` +
          `then record again.`, "warn");
    } else {
      say(`Saved ${baseName()}-captioned.webm — but it has NO SOUND. ` +
          `The voiceover track couldn't be captured.`, "warn");
    }
    refreshExports();
  };

  rec.start(250);
  if (speaking) speakScript(false);   // starts the video itself, in step with the voice
  else playAll();

  // watch the level for the whole recording, so silence is caught not guessed
  levelMeter = makeLevelMeter(stream);

  const wallStart = performance.now();
  const cardSecs = endCardSeconds();
  let cardStart = 0;              // wall-clock ms when the end card began

  const tick = () => {
    if (levelMeter) levelMeter.sample();
    advanceClipIfEnded();               // roll into the next clip mid-recording
    const t = nowTime();
    const clipDone = t >= dur - 0.04 || (timelineEnded() && (!S.hasAudio || audio.ended));

    if (!clipDone) {
      drawClipFitted(rctx, video, W, H);
      drawCaptions(rctx, W, H, t);
      say("Recording… " + Math.min(100, Math.round(t / dur * 100)) + "%");
    } else if (cardSecs > 0) {
      // Hold the last frame and fade the call to action over it.
      if (!cardStart) cardStart = performance.now();
      const elapsed = (performance.now() - cardStart) / 1000;
      drawClipFitted(rctx, video, W, H);
      drawEndCard(rctx, W, H, elapsed / cardSecs);
      say("Recording the end card… " + Math.min(100, Math.round((elapsed / cardSecs) * 100)) + "%");
      if (elapsed >= cardSecs) { rec.stop(); return; }
    } else {
      rec.stop();
      return;
    }

    // backstop: never spin forever if the voice fails to start at all
    if (performance.now() - wallStart > (dur + cardSecs + 20) * 1000) { rec.stop(); return; }
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
applyPlatform(platform);
setMode("own");   // most clips arrive with their voice already in them
syncTransport();

/* Exposed only so the acceptance checks can be run from the console. */
window.__cs = { S, buildASS, buildSRT, buildJSON, markWord, undoMark, resyncFrom, clearAll,
                activeIndexAt, drawCaptions, parseScript, cursorIndex, allTimed, assColor,
                wordIndexAtChar, setStartAt, normalizeTimings, speakScript, stopSpeaking,
                setMode, loadVoices, CAN_SPEAK, get voices() { return voices; },
                // clip timeline
                clipAt, totalClipDuration, recomputeClipStarts, renderClipList, outputSize,
                seekAll, nowTime, totalTime, moveClip, removeClip,
                get activeClip() { return activeClip; }, set activeClip(v) { activeClip = v; } };


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

  /* Google blocks newer keys from older models, and the block shows up only
     when the request is made. So if the chosen model is refused, drop it,
     pick another, and retry once - without making you click the button again. */
  let res, model, lastMsg = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    model = await resolveGeminiModel(apiKey);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort("timeout"), 90000);
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reqBody), signal: ctrl.signal }
      );
    } catch (netErr) {
      if (netErr && netErr.name === "AbortError") {
        throw new Error("Gemini didn't answer within 90s. Your network may be blocking it — try again.");
      }
      throw new Error("Couldn't reach Google. Check your connection and try again.");
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) break;

    const errData = await res.json().catch(() => ({}));
    lastMsg = errData.error?.message || "";
    const refused = res.status === 404 ||
                    /no longer available|not found|not supported|does not exist/i.test(lastMsg);

    if (refused && attempt === 0) {
      GEMINI_REJECTED.add(model);   // never offer this one again this session
      GEMINI_MODEL = null;
      continue;                      // resolve a different model and try again
    }

    if (res.status === 429) throw new Error("Free-tier rate limit reached. Wait about a minute and try again.");
    if (res.status === 400 && /API key/i.test(lastMsg)) throw new Error("That API key was rejected. Open the 🔑 dialog and paste a fresh one.");
    if (/quota|billing|credits/i.test(lastMsg)) throw new Error("This key's project is out of quota or credits. Make a key in a new project.");
    if (refused) throw new Error(`No Gemini model on this key would accept the request. Last tried "${model}".`);
    throw new Error(lastMsg || `Gemini API HTTP Error ${res.status}`);
  }

  const data = await res.json();
  const resText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!resText) throw new Error("Empty response from Gemini API");

  return jsonSchema ? JSON.parse(resText) : resText.trim();
}

/* Google retires model names on their own schedule, so ask the key which
   models it can actually reach rather than hardcoding one that goes stale.
   Resolved once per page load, then reused. */
/* Try this one first. Older keys can still use it; keys made after Google's
   cut-off get refused, and the caller then falls through to a current model
   automatically. Set to null to always take the newest available instead. */
const PREFERRED_MODEL = "gemini-2.5-flash";

let GEMINI_MODEL = null;
const GEMINI_REJECTED = new Set();   // models this key was refused, so we stop offering them

async function resolveGeminiModel(apiKey) {
  if (GEMINI_MODEL) return GEMINI_MODEL;
  if (PREFERRED_MODEL && !GEMINI_REJECTED.has(PREFERRED_MODEL)) {
    GEMINI_MODEL = PREFERRED_MODEL;
    return GEMINI_MODEL;
  }
  const ver  = s => { const m = s.match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
  const lite = s => /lite/i.test(s) ? 1 : 0;
  const prev = s => /preview|exp/i.test(s) ? 1 : 0;
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=" + encodeURIComponent(apiKey));
    if (r.ok) {
      const j = await r.json();
      const usable = (j.models || [])
        .map(m => m.name.replace(/^models\//, ""))
        .filter(n => /flash/i.test(n) && !/image|tts|embedding|live|vision/i.test(n))
        .filter(n => !GEMINI_REJECTED.has(n));
      const withMethod = (j.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map(m => m.name.replace(/^models\//, ""));
      const pool = usable.filter(n => withMethod.includes(n));
      if (pool.length) {
        // newest stable full Flash first
        pool.sort((a, b) => prev(a) - prev(b) || lite(a) - lite(b) || ver(b) - ver(a));
        GEMINI_MODEL = pool[0];
        return GEMINI_MODEL;
      }
    }
  } catch (e) { /* fall through to the defaults below */ }
  // Couldn't ask, so work down a list of current names, skipping any already refused.
  const fallbacks = ["gemini-flash-latest", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
  GEMINI_MODEL = fallbacks.find(n => !GEMINI_REJECTED.has(n)) || "gemini-flash-latest";
  return GEMINI_MODEL;
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
   Timing the words straight from the audio - no network, no key

   Speech has a shape: loud where words are, quiet between them. Find the
   loud stretches, then hand the words out across them in proportion to
   how long each word takes to say. Pauses land between words instead of
   stretching one, because words are only ever placed inside a loud
   stretch, never across a gap.
   ============================================================ */

function detectSpeechSegments(pcm, sr) {
  const win = Math.round(sr * 0.02);      // 20 ms frames
  const hop = Math.round(sr * 0.01);      // 10 ms steps
  const rms = [];
  for (let i = 0; i + win <= pcm.length; i += hop) {
    let s = 0;
    for (let j = 0; j < win; j++) { const v = pcm[i + j]; s += v * v; }
    rms.push(Math.sqrt(s / win));
  }
  if (!rms.length) return [];

  const sorted = rms.slice().sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.20)];        // background level
  const peak  = sorted[Math.floor(sorted.length * 0.95)];        // loud level
  const thresh = Math.max(floor * 2.5, peak * 0.08, 1e-4);

  // frames -> raw segments
  const segs = [];
  let start = -1;
  for (let i = 0; i < rms.length; i++) {
    const loud = rms[i] >= thresh;
    if (loud && start < 0) start = i;
    if (!loud && start >= 0) { segs.push([start, i]); start = -1; }
  }
  if (start >= 0) segs.push([start, rms.length]);

  const toSec = f => f * hop / sr;
  const MERGE_GAP = 0.12;   // a gap shorter than this is inside a word, not between words
  const MIN_SEG   = 0.06;   // ignore clicks and breaths
  const PAD       = 0.03;   // speech starts a touch before it crosses the threshold

  const merged = [];
  for (const [a, b] of segs) {
    const s = Math.max(0, toSec(a) - PAD), e = toSec(b) + PAD;
    const last = merged[merged.length - 1];
    if (last && s - last.end < MERGE_GAP) last.end = e;
    else merged.push({ start: s, end: e });
  }
  return merged.filter(m => m.end - m.start >= MIN_SEG);
}

/* Roughly how long a word takes to say, so longer words get more time. */
function spokenWeight(word) {
  const w = String(word || "").toLowerCase().replace(/[^a-z0-9']/g, "");
  if (!w) return 1;
  if (/^\d+$/.test(w)) return 1 + w.length * 0.6;          // digits are read out
  const groups = w.match(/[aeiouy]+/g);
  let syl = groups ? groups.length : 1;
  if (/[^aeiouy]e$/.test(w) && syl > 1) syl--;             // silent trailing e
  return Math.max(1, syl) + 0.35;                          // + a little per-word overhead
}

/* Spread S.words across the detected speech. Returns a short report. */
function timeWordsFromSegments(segments, mediaDuration) {
  const words = S.words;
  if (!words.length) throw new Error("Paste your script in step 3 first.");
  if (!segments.length) throw new Error("Couldn't hear any speech in that audio.");

  const weights = words.map(w => spokenWeight(w.text));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const totalSpeech = segments.reduce((a, s) => a + (s.end - s.start), 0);
  const perWeight = totalSpeech / totalWeight;

  // Give each segment its share of words, so no word straddles a pause.
  let wi = 0;
  segments.forEach((seg, si) => {
    if (wi >= words.length) return;
    const segDur = seg.end - seg.start;
    const isLast = si === segments.length - 1;
    let budget = segDur / perWeight;
    const take = [];
    while (wi < words.length && (isLast || budget > 0 || !take.length)) {
      take.push(wi);
      budget -= weights[wi];
      wi++;
      if (!isLast && budget <= 0) break;
    }
    const wSum = take.reduce((a, i) => a + weights[i], 0) || 1;
    let t = seg.start;
    take.forEach(i => {
      const dur = segDur * (weights[i] / wSum);
      words[i].start = t;
      words[i].end = Math.min(seg.end, t + dur);
      t += dur;
    });
  });

  // Anything left over (shouldn't normally happen) rides out the last segment.
  if (wi < words.length) {
    const last = segments[segments.length - 1];
    const remaining = words.length - wi;
    const tail = Math.max(0.25, (mediaDuration || last.end) - last.end);
    const step = tail / remaining;
    let t = last.end;
    for (; wi < words.length; wi++) { words[wi].start = t; words[wi].end = t + step; t += step; }
  }

  // Never let a word be zero-length or run backwards.
  for (let i = 0; i < words.length; i++) {
    if (words[i].end <= words[i].start) words[i].end = words[i].start + 0.08;
    if (i && words[i].start < words[i - 1].end) words[i].start = words[i - 1].end;
    if (words[i].end <= words[i].start) words[i].end = words[i].start + 0.08;
  }
  return { segments: segments.length, speechSeconds: +totalSpeech.toFixed(2) };
}

/* Silence is where viewers leave. The speech map already knows where it is,
   so report the gaps worth cutting instead of letting you find out later. */
const DEAD_AIR_MIN = 0.45;

function findDeadAir(segments, duration) {
  const gaps = [];
  if (!segments.length) return gaps;
  if (segments[0].start >= DEAD_AIR_MIN) {
    gaps.push({ start: 0, end: segments[0].start, where: "at the start" });
  }
  for (let i = 1; i < segments.length; i++) {
    const g = segments[i].start - segments[i - 1].end;
    if (g >= DEAD_AIR_MIN) {
      gaps.push({ start: segments[i - 1].end, end: segments[i].start, where: "in the middle" });
    }
  }
  const tail = (duration || 0) - segments[segments.length - 1].end;
  if (tail >= DEAD_AIR_MIN) {
    gaps.push({ start: segments[segments.length - 1].end, end: duration, where: "at the end" });
  }
  return gaps;
}

function describeDeadAir(gaps) {
  if (!gaps.length) return "";
  const worst = gaps.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
  const total = gaps.reduce((a, g) => a + (g.end - g.start), 0);
  const one = (worst.end - worst.start).toFixed(1) + "s of silence " + worst.where +
              " (" + worst.start.toFixed(1) + "s)";
  return gaps.length === 1
    ? one + " — trimming it holds attention."
    : gaps.length + " silent gaps, " + total.toFixed(1) + "s in total. Longest: " + one + ".";
}

/* Words per second, so slow stretches are visible before you post. */
function pacingReport() {
  const w = S.words.filter(x => x.start !== null && x.end !== null);
  if (w.length < 3) return "";
  const span = w[w.length - 1].end - w[0].start;
  if (span <= 0) return "";
  const wps = w.length / span;
  if (wps < 2.0) return `Pace is ${wps.toFixed(1)} words/sec — slow for a Reel. Try speeding the voice up.`;
  if (wps > 4.5) return `Pace is ${wps.toFixed(1)} words/sec — very fast; captions may be hard to read.`;
  return `Pace is ${wps.toFixed(1)} words/sec — good for short-form.`;
}

/* Pull the sound out of one file as mono at a known rate. */
async function decodeMono(file, sr) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  let decoded;
  try { decoded = await ctx.decodeAudioData(await file.arrayBuffer()); }
  finally { try { ctx.close(); } catch (e) {} }
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * sr)), sr);
  const src = off.createBufferSource();
  src.buffer = decoded; src.connect(off.destination); src.start(0);
  const out = await off.startRendering();
  return out.getChannelData(0);
}

/* The sound the captions should follow, laid end to end across every clip
   so a joined timeline is timed as one piece. */
async function gatherTimingAudio() {
  const SR = 16000;
  const voiceover = $("audioFile").files && $("audioFile").files[0];
  if (S.hasAudio && voiceover) {
    return { pcm: await decodeMono(voiceover, SR), sr: SR, from: "your voiceover file" };
  }
  if (S.clips.length) {
    const parts = [];
    for (const c of S.clips) {
      try { parts.push(await decodeMono(c.file, SR)); }
      catch (e) { parts.push(new Float32Array(Math.ceil((c.duration || 0) * SR))); }
    }
    const total = parts.reduce((a, p) => a + p.length, 0);
    const pcm = new Float32Array(total);
    let at = 0;
    parts.forEach(p => { pcm.set(p, at); at += p.length; });
    return { pcm, sr: SR,
             from: S.clips.length === 1 ? "your clip's own sound"
                                        : "the sound across all " + S.clips.length + " clips" };
  }
  throw new Error("Add your clips in step 1 first.");
}

/* The same joined audio, packaged as a WAV so it can be sent somewhere.
   Uses every clip, not just the first - a file input can no longer be the
   source because the clip list clears it after loading. */
async function gatherTimingWav(maxSeconds) {
  const { pcm, sr, from } = await gatherTimingAudio();
  const n = Math.min(pcm.length, Math.floor((maxSeconds || 300) * sr));
  const ab = new ArrayBuffer(44 + n * 2), dv = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true); w(36, "data"); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    dv.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return { blob: new Blob([ab], { type: "audio/wav" }), seconds: n / sr, from };
}

/* Is there anything to listen to at all? */
function haveTimingSource() {
  return S.clips.length > 0 || (S.hasAudio && $("audioFile").files[0]);
}

async function autoTimeFromAudio() {
  const { pcm, sr, from } = await gatherTimingAudio();
  const duration = pcm.length / sr;
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 7) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; }
  if (peak < 0.005) {
    throw new Error("There's no sound in that to listen to. If your clips are silent, " +
                    "load a voiceover under “Load a file”, or use “Make one here”.");
  }
  const segs = detectSpeechSegments(pcm, sr);
  const report = timeWordsFromSegments(segs, duration);
  report.deadAir = findDeadAir(segs, duration);
  report.from = from;
  return report;
}

if ($("btnAutoTime")) {
  $("btnAutoTime").addEventListener("click", async () => {
    const btn = $("btnAutoTime");
    if (!haveTimingSource()) { say("Add your clips in step 1 first.", "warn"); return; }
    if (!S.words.length) { say("Paste your script in step 3 first.", "warn"); return; }

    startAiClock(btn, "Listening");
    try {
      const report = await autoTimeFromAudio();
      renderChips();
      refreshExports();
      const heard = report.segments === 1 ? "1 stretch of speech" : report.segments + " stretches of speech";
      const notes = [describeDeadAir(report.deadAir || []), pacingReport()].filter(Boolean);
      say(`Timed ${S.words.length} words from ${report.from} — ${heard}, ` +
          `${report.speechSeconds}s of talking. Click any word that looks off.`, "ok");
      showCoachNotes(notes, (report.deadAir || []).length > 0);
      stopAiClock(btn, "✅ Timed!", 2200);
    } catch (e) {
      stopAiClock(btn);
      say(String(e.message || e), "warn");
    }
  });
}

/* ---- wiring for the safe zones and end card ---- */
if ($("showSafe")) {
  $("showSafe").addEventListener("change", updateSafeZoneWarning);
}
if ($("endCardOn")) {
  $("endCardOn").addEventListener("change", e => {
    $("endCardRow").style.display = e.target.checked ? "flex" : "none";
  });
}
if ($("endCardSecs")) {
  const sync = () => { $("endCardSecsVal").textContent = parseFloat($("endCardSecs").value).toFixed(1); };
  $("endCardSecs").addEventListener("input", sync);
  sync();
}
// moving the caption changes whether it clears Facebook's interface
["pos", "size", "wps"].forEach(id => {
  if ($(id)) $(id).addEventListener("input", updateSafeZoneWarning);
});
video.addEventListener("loadedmetadata", updateSafeZoneWarning);

/* ============================================================
   Write the captions from the voice itself.

   Pasting a script only works if it matches what was actually said. When
   the narration came with the clip, it often doesn't - so listen to the
   audio, write down the words, and time them. Runs on this machine: the
   model downloads once (about 40 MB) and is then cached by the browser.
   ============================================================ */
const WHISPER_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5";
const WHISPER_MODEL = "onnx-community/whisper-tiny.en";
let whisperPipe = null;

async function getWhisper(onProgress) {
  if (whisperPipe) return whisperPipe;
  const { pipeline } = await import(WHISPER_URL);
  whisperPipe = await pipeline("automatic-speech-recognition", WHISPER_MODEL, {
    dtype: "q8", device: "wasm",
    progress_callback: p => {
      if (p && p.progress != null && onProgress) onProgress(Math.round(p.progress));
    }
  });
  return whisperPipe;
}

/* Whisper gives sentences with times. Words inside a sentence are spread
   across it by how long each takes to say - the same weighting the
   offline timer uses, which already tested well. */
function applyTranscript(chunks, totalDuration) {
  let text = "";
  const ranges = [];
  chunks.forEach(ch => {
    const piece = (ch.text || "").trim();
    if (!piece) return;
    const from = text.length ? text.length + 1 : 0;
    text += (text ? " " : "") + piece;
    let [t0, t1] = ch.timestamp || [];
    if (t0 == null) t0 = ranges.length ? ranges[ranges.length - 1].t1 : 0;
    if (t1 == null) t1 = totalDuration;
    ranges.push({ from, to: text.length, t0, t1 });
  });
  if (!text) throw new Error("Nothing was said in that audio — or it was too quiet to make out.");

  scriptEl.value = text;
  parseScript();                       // builds the word list, with character positions
  if (!S.words.length) throw new Error("Couldn't turn that into words.");

  // hand each word to the sentence it came from
  const buckets = ranges.map(() => []);
  S.words.forEach((w, i) => {
    let r = ranges.findIndex(rg => w.pos >= rg.from && w.pos < rg.to);
    if (r < 0) r = ranges.length - 1;
    buckets[r].push(i);
  });

  buckets.forEach((idxs, r) => {
    if (!idxs.length) return;
    const { t0, t1 } = ranges[r];
    const span = Math.max(0.12, t1 - t0);
    const weights = idxs.map(i => spokenWeight(S.words[i].text));
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    let t = t0;
    idxs.forEach((i, k) => {
      const d = span * (weights[k] / sum);
      S.words[i].start = t;
      S.words[i].end = Math.min(t1, t + d);
      t += d;
    });
  });

  // keep it strictly in order
  for (let i = 0; i < S.words.length; i++) {
    const w = S.words[i];
    if (w.start === null) w.start = i ? S.words[i - 1].end : 0;
    if (i && w.start < S.words[i - 1].end) w.start = S.words[i - 1].end;
    if (w.end === null || w.end <= w.start) w.end = w.start + 0.1;
  }
  return { words: S.words.length, sentences: ranges.length, text };
}

async function transcribeFromVoice() {
  const btn = $("btnTranscribeLocal");
  if (!haveTimingSource()) { say("Add your clips in step 1 first.", "warn"); return; }
  startAiClock(btn, "Listening");
  try {
    setAiClockLabel(btn, "Reading the sound");
    const { pcm, sr, from } = await gatherTimingAudio();
    const seconds = pcm.length / sr;

    let peak = 0;
    for (let i = 0; i < pcm.length; i += 7) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; }
    if (peak < 0.005) throw new Error("That audio is silent — there is no voice to write down.");

    setAiClockLabel(btn, "Fetching the listener (first time only)");
    const asr = await getWhisper(pct => setAiClockLabel(btn, "Downloading listener " + pct + "%"));

    setAiClockLabel(btn, "Writing down " + Math.round(seconds) + "s");
    const out = await asr(pcm, { return_timestamps: true, chunk_length_s: 30 });

    const res = applyTranscript(out.chunks || [{ text: out.text, timestamp: [0, seconds] }], seconds);
    renderChips();
    refreshExports();
    updateSafeZoneWarning();
    say(`Wrote ${res.words} words from ${from} and timed them. ` +
        `The script box now holds exactly what was said — check step 4 and click any word that looks off.`, "ok");
    showCoachNotes([pacingReport()].filter(Boolean), false);
    stopAiClock(btn, "✅ Written!", 2200);
  } catch (e) {
    stopAiClock(btn);
    const why = String((e && e.message) || e);
    say(/Failed to fetch|NetworkError|dynamically imported/i.test(why)
        ? "Couldn't download the listener — check your connection and try again. It only downloads once."
        : why, "warn");
  }
}
if ($("btnTranscribeLocal")) $("btnTranscribeLocal").addEventListener("click", transcribeFromVoice);

/* Turn a Gemini failure into a few plain words, for a message that is
   mostly about what happened next. */
function shortReason(e) {
  const m = String((e && e.message) || e);
  if (/rate limit|quota|429/i.test(m))       return "Google's free limit was reached";
  if (/API key|rejected|400/i.test(m))       return "The API key wasn't accepted";
  if (/didn't answer|timed out|90s/i.test(m)) return "Google didn't answer in time";
  if (/reach Google|Failed to fetch|network/i.test(m)) return "Google couldn't be reached";
  if (/no longer available|model/i.test(m))  return "That Gemini model wasn't available";
  return "Gemini wasn't available";
}

/* ---- the coaching panel: what would cost you views ---- */
function showCoachNotes(notes, isWarning) {
  const box = $("coachNotes");
  if (!box) return;
  if (!notes.length) { box.style.display = "none"; return; }
  box.style.display = "";
  box.style.borderColor = isWarning ? "rgba(224,179,65,.4)" : "var(--line)";
  box.replaceChildren();
  notes.forEach(n => {
    const p = document.createElement("div");
    p.style.cssText = "display:flex;gap:8px;align-items:flex-start";
    const dot = document.createElement("span");
    dot.textContent = /silen|slow|fast/i.test(n) ? "⚠" : "✓";
    dot.style.cssText = "flex:none;color:" + (/silen|slow|fast/i.test(n) ? "#e0b341" : "#7fc9a4");
    const t = document.createElement("span");
    t.textContent = n;
    p.append(dot, t);
    box.appendChild(p);
  });
}

/* ============================================================
   Is there actually sound on this stream?

   A captured audio track can exist and still be pure silence - which is
   how a render comes back mute despite everything "working". So measure
   the real level rather than trusting the track's presence.
   ============================================================ */
/* A recordable audio track for a media element.

   createMediaElementSource can only be called once per element, and the
   visible <video> changes source every time a clip ends - so build the
   graph once and keep it. The element is also reconnected to the speakers,
   because routing it through Web Audio otherwise silences playback. */
const audioGraphs = new WeakMap();

function stableAudioTrack(el) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC || !el) return null;
  let g = audioGraphs.get(el);
  if (!g) {
    const ac = new AC();
    const src = ac.createMediaElementSource(el);
    const dest = ac.createMediaStreamDestination();
    src.connect(dest);
    src.connect(ac.destination);          // keep it audible while recording
    g = { ac, dest };
    audioGraphs.set(el, g);
  }
  if (g.ac.state === "suspended") g.ac.resume().catch(() => {});
  const tracks = g.dest.stream.getAudioTracks();
  return tracks.length ? tracks[0] : null;
}

function makeLevelMeter(stream) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const tracks = stream.getAudioTracks();
  if (!AC || !tracks.length) return null;
  try {
    const ac = new AC();
    if (ac.state === "suspended") ac.resume().catch(() => {});
    const src = ac.createMediaStreamSource(new MediaStream([tracks[0]]));
    const an = ac.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    const buf = new Float32Array(an.fftSize);
    let peak = 0;
    const sample = () => {
      an.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]);
        if (v > peak) peak = v;
      }
      return peak;
    };
    return { sample, peak: () => peak, close: () => { try { ac.close(); } catch (e) {} } };
  } catch (e) { return null; }
}

const AUDIBLE = 0.02;   // anything under this is silence for practical purposes

/* A five-second dry run, so a mute render is discovered before it costs a
   full recording. Speaks a short line and reports what was captured. */
async function testVoiceCapture() {
  const btn = $("btnTestSound");
  if (!CAN_SPEAK || $("voice").value === "") { say("Pick a voice in step 2 first.", "warn"); return; }

  const ok = window.confirm(
    "This checks whether your voice can be recorded, before you spend a full render.\n\n" +
    "In the box that appears, choose ENTIRE SCREEN — not the tab.\n" +
    "Then tick “Also share system audio” and press Share.\n\n" +
    "Windows plays the speech outside the browser tab, so “tab audio” records\n" +
    "silence. Sharing the screen with system audio is what actually captures it.\n\n" +
    "Only the sound is kept — the picture is thrown away immediately."
  );
  if (!ok) return;

  startAiClock(btn, "Testing");
  let ds = null, meter = null;
  try {
    // The full picker must stay available so "Entire Screen" can be chosen;
    // restricting it to this tab guarantees a silent capture on Windows.
    ds = await navigator.mediaDevices.getDisplayMedia({
      video: true, audio: true, systemAudio: "include"
    });
    ds.getVideoTracks().forEach(t => t.stop());
    if (!ds.getAudioTracks().length) {
      throw new Error("No sound was shared at all — the “Also share system audio” box wasn’t ticked. " +
                      "Run this again, choose Entire Screen, and tick that box.");
    }
    meter = makeLevelMeter(ds);
    if (!meter) throw new Error("Couldn't listen to the shared sound on this browser.");

    // speak something while we listen
    const u = new SpeechSynthesisUtterance("Testing the voice recording, one two three.");
    u.voice = voices[+$("voice").value];
    u.rate = S.rate;
    TTS.cancel();
    TTS.speak(u);

    const t0 = performance.now();
    while (performance.now() - t0 < 4200) {
      meter.sample();
      await new Promise(r => setTimeout(r, 60));
    }
    TTS.cancel();

    const peak = meter.peak();
    if (peak >= AUDIBLE) {
      say(`Sound captured — level ${(peak * 100).toFixed(0)}%. Your voice WILL be in the video. ` +
          `Share the same way when you record.`, "ok");
    } else {
      say(`Silent — nothing was captured (level ${(peak * 100).toFixed(1)}%). ` +
          `You most likely shared a tab or a window. Run this again and pick ` +
          `“Entire Screen”, then tick “Also share system audio”. ` +
          `Also check your speakers aren't muted — the sound has to be playing to be recorded.`, "warn");
    }
  } catch (e) {
    const why = String((e && e.message) || e);
    say(/Permission|denied|NotAllowed/i.test(why)
        ? "Sharing was cancelled, so nothing could be tested."
        : why, "warn");
  } finally {
    if (meter) meter.close();
    if (ds) ds.getTracks().forEach(t => t.stop());
    stopAiClock(btn);
  }
}
if ($("btnTestSound")) $("btnTestSound").addEventListener("click", testVoiceCapture);

/* ============================================================
   The end card: one second that asks for the follow.
   Drawn onto the recording after the clip finishes.
   ============================================================ */
function endCardSeconds() {
  const on = $("endCardOn");
  return (on && on.checked) ? Math.max(0.6, Math.min(3, parseFloat($("endCardSecs").value) || 1.2)) : 0;
}

function drawEndCard(ctx, W, H, progress) {
  const line1 = ($("endCardText").value || "Follow for more").trim();
  const line2 = ($("endCardHandle").value || "").trim();

  ctx.save();
  ctx.fillStyle = "rgba(8,12,16," + (0.55 + 0.35 * Math.min(1, progress * 3)) + ")";
  ctx.fillRect(0, 0, W, H);

  const fit = (text, targetPx, maxW) => {
    let px = targetPx;
    ctx.font = px + "px " + FONT_STACK;
    while (ctx.measureText(text).width > maxW && px > 10) {
      px *= maxW / ctx.measureText(text).width;
      ctx.font = px + "px " + FONT_STACK;
    }
    return px;
  };

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";

  const big = fit(line1.toUpperCase(), H * 0.075, W * 0.84);
  ctx.font = big + "px " + FONT_STACK;
  ctx.lineWidth = big * 0.17;
  ctx.strokeStyle = "#000";
  ctx.strokeText(line1.toUpperCase(), W / 2, H * 0.46);
  ctx.fillStyle = S.hlColor || "#FFD400";
  ctx.fillText(line1.toUpperCase(), W / 2, H * 0.46);

  if (line2) {
    const small = fit(line2, H * 0.038, W * 0.8);
    ctx.font = small + "px " + FONT_STACK;
    ctx.lineWidth = small * 0.17;
    ctx.strokeStyle = "#000";
    ctx.strokeText(line2, W / 2, H * 0.56);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillText(line2, W / 2, H * 0.56);
  }
  ctx.restore();
}

/* ============================================================
   AI Feature Event Handlers
   ============================================================ */

/* A button frozen on "Generating…" gives you no way to tell slow from dead,
   so count the seconds on the button itself. */
const aiClocks = new WeakMap();

function startAiClock(btn, label) {
  stopAiClock(btn);
  if (!btn.dataset.origLabel) btn.dataset.origLabel = btn.textContent;
  const state = { t0: Date.now(), label };
  const tick = () => {
    btn.textContent = `⏳ ${state.label} ${Math.round((Date.now() - state.t0) / 1000)}s`;
  };
  tick();
  btn.disabled = true;
  state.timer = setInterval(tick, 1000);
  aiClocks.set(btn, state);
}

function setAiClockLabel(btn, label) {
  const state = aiClocks.get(btn);
  if (state) state.label = label;
}

function stopAiClock(btn, doneLabel, holdMs) {
  const state = aiClocks.get(btn);
  if (state) { clearInterval(state.timer); aiClocks.delete(btn); }
  const orig = btn.dataset.origLabel || btn.textContent;
  if (doneLabel) {
    btn.textContent = doneLabel;
    setTimeout(() => { stopAiClock(btn); }, holdMs || 2000);
  } else {
    btn.textContent = orig;
    btn.disabled = false;
  }
}
if ($("btnGenerate")) {
  $("btnGenerate").addEventListener("click", async () => {
    const topic = $("topicInput").value.trim();
    if (!topic) { say("Type a topic first — a few words is enough.", "warn"); return; }
    const btn = $("btnGenerate");
    const orig = btn.textContent;
    startAiClock(btn, "Generating");
    try {
      const prompt = `Write a highly engaging, 30-second script for a TikTok/Reels video about: "${topic}". Start with a strong hook. Keep sentences short and punchy. Return ONLY the spoken script text, no punctuation or markdown.`;
      const result = await callGeminiApi(prompt);
      scriptEl.value = result;
      parseScript();
      const doneLabel = "✨ Done!";
      stopAiClock(btn, doneLabel, 2000);
    } catch(e) {
      say(e.message, "warn");
      stopAiClock(btn);
    }
  });
}

if ($("btnRewrite")) {
  $("btnRewrite").addEventListener("click", async () => {
    const text = scriptEl.value.trim();
    if (!text) { say("There is no script yet — paste one, or press “Write the captions from the voice”.", "warn"); return; }
    const btn = $("btnRewrite");
    const orig = btn.textContent;
    startAiClock(btn, "Rewriting");
    try {
      const prompt = `Rewrite the following script to make it punchy, energetic, and concise for a TikTok/Shorts video caption. Return ONLY the spoken text, without punctuation.\n\nSCRIPT:\n${text}`;
      const result = await callGeminiApi(prompt);
      scriptEl.value = result;
      parseScript();
      const doneLabel = "✨ Rewritten!";
      stopAiClock(btn, doneLabel, 2000);
    } catch(e) {
      say(e.message, "warn");
      stopAiClock(btn);
    }
  });
}

if ($("btnEmojify")) {
  $("btnEmojify").addEventListener("click", async () => {
    const text = scriptEl.value.trim();
    if (!text) { say("There is no script yet — paste one, or press “Write the captions from the voice”.", "warn"); return; }
    const btn = $("btnEmojify");
    const orig = btn.textContent;
    startAiClock(btn, "Adding emojis");
    try {
      const prompt = `Take the following script and insert relevant emojis into the text (max 1 emoji per sentence/phrase). Keep original words intact.\n\nSCRIPT:\n${text}`;
      const result = await callGeminiApi(prompt);
      scriptEl.value = result;
      parseScript();
      const doneLabel = "😊 Emojified!";
      stopAiClock(btn, doneLabel, 2000);
    } catch(e) {
      say(e.message, "warn");
      stopAiClock(btn);
    }
  });
}

if ($("btnTranscribe")) {
  $("btnTranscribe").addEventListener("click", async () => {
    if (!haveTimingSource()) { say("Add your clips in step 1 first.", "warn"); return; }
    const btn = $("btnTranscribe");
    const orig = btn.textContent;
    startAiClock(btn, "Reading audio");
    try {
      const audioBlob = (await gatherTimingWav(300)).blob;
      setAiClockLabel(btn, "Transcribing");
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
      stopAiClock(btn, doneLabel, 3000);
    } catch(e) {
      // Same idea: the local listener can write the words without Google.
      stopAiClock(btn);
      say(shortReason(e) + " — writing the captions here instead…");
      await transcribeFromVoice();
    }
  });
}

if ($("btnAiSync")) {
  $("btnAiSync").addEventListener("click", async () => {
    if (!haveTimingSource()) { say("Add your clips in step 1 first.", "warn"); return; }
    if (!S.words || S.words.length === 0) { say("Paste your script in step 3 first.", "warn"); return; }
    const btn = $("btnAiSync");
    const orig = btn.textContent;
    startAiClock(btn, "Reading audio");
    try {
      const audioBlob = (await gatherTimingWav(300)).blob;
      setAiClockLabel(btn, "Aligning");
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
      stopAiClock(btn, doneLabel, 3000);
    } catch(e) {
      /* Gemini is a shortcut, not the only way. When it is rate limited,
         blocked or keyless, do the same job here instead of stopping. */
      setAiClockLabel(btn, "Doing it here instead");
      try {
        const report = await autoTimeFromAudio();
        renderChips();
        refreshExports();
        const notes = [describeDeadAir(report.deadAir || []), pacingReport()].filter(Boolean);
        showCoachNotes(notes, (report.deadAir || []).length > 0);
        say(`${shortReason(e)} — so I timed the words here instead, from ${report.from}. ` +
            `Same result, no key needed: that's what “⏱ Time it for me” does.`, "ok");
        stopAiClock(btn, "✅ Timed here", 2600);
      } catch (local) {
        say("AI Sync failed (" + shortReason(e) + "), and timing it here also failed: " +
            (local.message || local), "warn");
        stopAiClock(btn);
      }
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


