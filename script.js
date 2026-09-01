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
  endCardPic: null,         // the profile picture, squared and shrunk, as a data URL
  hasAudio: false,          // a voiceover FILE is loaded
  voiceoverBlob: null,      // that voiceover's bytes, wherever it came from
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

/* Anton carries no Sinhala or Tamil glyphs, so a Sinhala caption in it draws
   as a row of boxes. Uppercasing is just as wrong: neither script has cases,
   and toUpperCase leaves the text alone while implying it did something. Pick
   the face and the casing from what the words actually are. */
const SINHALA_RANGE = /[\u0D80-\u0DFF]/;
const TAMIL_RANGE   = /[\u0B80-\u0BFF]/;

function scriptKind(text) {
  const t = String(text || "");
  if (SINHALA_RANGE.test(t)) return "sinhala";
  if (TAMIL_RANGE.test(t))   return "tamil";
  return "latin";
}

/* A webfont nothing on the page uses is never actually fetched, and canvas
   does not wait for one — it quietly draws with a fallback, which for these
   two scripts means boxes. So ask for the face the moment a script turns out
   to need it. The preview repaints every frame anyway, so it picks the real
   face up on its own once it lands; the chips are DOM and need telling. An
   English session never asks, and pays nothing. */
const FACE_ASKED = new Set();
function ensureFace(kind) {
  if (kind === "latin" || FACE_ASKED.has(kind)) return;
  FACE_ASKED.add(kind);
  if (!(document.fonts && document.fonts.load)) return;
  const family = kind === "sinhala" ? '"Noto Sans Sinhala"' : '"Noto Sans Tamil"';
  const sample = kind === "sinhala" ? "ක" : "க";
  document.fonts.load('700 100px ' + family, sample)
    .then(() => { try { renderChips(); } catch (e) {} })
    .catch(() => {});
}

/* The face used on the canvas. */
function fontFor(text) {
  const kind = scriptKind(text);
  ensureFace(kind);
  switch (kind) {
    case "sinhala": return '"Noto Sans Sinhala", ' + FONT_STACK;
    case "tamil":   return '"Noto Sans Tamil", ' + FONT_STACK;
    default:        return FONT_STACK;
  }
}

/* The name ffmpeg will look for when burning the .ass in. */
function assFontFor(text) {
  switch (scriptKind(text)) {
    case "sinhala": return "Noto Sans Sinhala";
    case "tamil":   return "Noto Sans Tamil";
    default:        return "Anton";
  }
}

/* Shout in Latin, leave every other script as written. */
function captionCase(text) {
  return scriptKind(text) === "latin" ? String(text).toUpperCase() : String(text);
}

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

/* Off the screen, but NOT display:none. A hidden video element is not
   decoded, so drawing it to a canvas paints black - which is exactly how
   an export came back with captions and sound over an empty picture. */
const clipEls = document.createElement("div");
clipEls.style.cssText =
  "position:fixed;left:-10000px;top:0;width:2px;height:2px;overflow:hidden;" +
  "opacity:0.01;pointer-events:none;z-index:-1";
clipEls.setAttribute("aria-hidden", "true");
document.body.appendChild(clipEls);

/* How much of a clip can actually be played.

   A container can claim a length the media does not deliver - a file that
   says 30s but stops at 28.13s. Trusting the claim lets the timeline seek
   into nothing and leaves the recorder waiting for an end that never
   comes, so take whichever is smaller: the stated duration or the last
   position the browser says it can seek to. */
function playableLength(el) {
  const stated = isFinite(el.duration) ? el.duration : 0;
  let seekable = 0;
  try {
    if (el.seekable && el.seekable.length) seekable = el.seekable.end(el.seekable.length - 1);
  } catch (e) {}
  if (!isFinite(seekable) || seekable <= 0) return stated;
  if (!stated) return seekable;
  // a small gap is normal rounding; a large one means the file is overstating
  return (stated - seekable > 0.25) ? seekable : stated;
}

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
      clip.duration = playableLength(el);
      if (--pending === 0) afterClipsLoaded();
      recomputeClipStarts();
      renderClipList();
      syncTransport();
      checkClipSound(clip);      // so a silent clip is obvious before anything is pressed
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

/* Does this clip actually carry a voice? Answered once, on load, so the
   list can say so before any button is pressed. */
async function checkClipSound(clip) {
  clip.sound = "checking";
  renderClipList();
  // Only the fast read here - playing every clip through on load would make
  // adding five clips take a minute. The slow path runs when it is needed.
  try {
    const pcm = await decodeMono(clip.file, 16000);
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 5) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; }
    clip.peak = peak;
    clip.sound = peak >= 0.005 ? "yes" : "maybe";
  } catch (e) {
    clip.sound = "maybe";
  }
  renderClipList();
  updateSoundSummary();
}

function updateSoundSummary() {
  const el = $("clipSound");
  if (!el) return;
  const done = S.clips.filter(c => c.sound && c.sound !== "checking");
  if (!S.clips.length || done.length < S.clips.length) { el.style.display = "none"; return; }
  const bad = done.filter(c => c.sound !== "yes");
  if (!bad.length) { el.style.display = "none"; return; }
  el.style.display = "";
  el.textContent = (bad.length === done.length
    ? "No sound was found in the file itself. "
    : bad.length + " of your clips gave no sound from the file. ") +
    "That does not mean they are silent - the browser is fussy about reading audio out of some " +
    "videos. Press “⏱ Time it for me” and they will be played through to capture it, which takes " +
    "about as long as the clips themselves.";
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

    const snd = document.createElement("span");
    snd.className = "clip-snd";
    if (c.sound === "yes")         { snd.textContent = "🔊"; snd.title = "Has a voice in it"; snd.classList.add("ok"); }
    else if (c.sound === "maybe")  { snd.textContent = "🔈"; snd.title = "No sound found in the file - it will be played through to check"; }
    else                           { snd.textContent = "·";  snd.title = "Checking for sound…"; }

    const up = document.createElement("button");
    up.textContent = "↑"; up.title = "Move earlier"; up.disabled = i === 0;
    up.addEventListener("click", () => moveClip(i, -1));

    const down = document.createElement("button");
    down.textContent = "↓"; down.title = "Move later"; down.disabled = i === S.clips.length - 1;
    down.addEventListener("click", () => moveClip(i, 1));

    const del = document.createElement("button");
    del.textContent = "✕"; del.title = "Remove this clip";
    del.addEventListener("click", () => removeClip(i));

    row.append(num, name, snd, dur, up, down, del);
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
    S.hasAudio = false; S.voiceoverBlob = null; video.muted = false;
    syncTransport();
    return;
  }

  useVoiceover(f, f.name);
});

/* Take a blob as THE voiceover. Shared by the file picker and by the
   voice generated from your script, so a made voice behaves in every
   later step exactly like one you loaded yourself — timing, preview,
   and both exporters all read it from the same place. */
function useVoiceover(blob, name) {
  if (audioURL) URL.revokeObjectURL(audioURL);
  audioURL = URL.createObjectURL(blob);
  audio.src = audioURL; audio.load();
  S.hasAudio = true; video.muted = true;
  S.clips.forEach(c => { c.el.muted = true; });
  S.audioFileName = name;
  S.voiceoverBlob = blob;       // the exporters decode this, not the file input
  $("audioName").textContent = name;
  $("audioName").classList.remove("none");
  $("clearAudio").style.display = "";
  syncTransport();
}

$("clearAudio").addEventListener("click", () => {
  pauseAll();
  if (audioURL) { URL.revokeObjectURL(audioURL); audioURL = null; }
  audio.removeAttribute("src"); audio.load();
  S.hasAudio = false; video.muted = false;
  S.voiceoverBlob = null;
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
/* Every platform tops out at 1080 across for vertical video, so anything
   larger is bytes nobody sees: a 1440-wide clip carries 78% more pixels
   than 1080 and is re-encoded down on upload anyway. Cap it, keeping the
   shape, and round to even numbers because encoders require it. */
const MAX_OUT_WIDTH = 1080, MAX_OUT_HEIGHT = 1920;

function outputSize() {
  const first = S.clips[0];
  let w = (first && first.el.videoWidth) || video.videoWidth || 1080;
  let h = (first && first.el.videoHeight) || video.videoHeight || 1920;
  const scale = Math.min(1, MAX_OUT_WIDTH / w, MAX_OUT_HEIGHT / h);
  if (scale < 1) {
    w = Math.round(w * scale / 2) * 2;
    h = Math.round(h * scale / 2) * 2;
  }
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
    /* \p{M} matters as much as \p{L} here. In Sinhala and Tamil the vowel
       signs and the virama are combining marks, not letters, so a filter of
       letters alone quietly ate them: කොළඹ came through as කළඹ. Latin never
       noticed because it keeps its vowels inside its letters. */
    const text = captionCase(m[0].replace(/[^\p{L}\p{M}\p{N}'’\-]/gu, ""));
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

  // Say which voice the timing button will listen to, so the two paths
  // read as one choice rather than two competing buttons.
  const t = $("btnAutoTime");
  if (t) {
    const label = mode === "generated" ? "⏱ Speak it and time it"
                : mode === "file"      ? "⏱ Time it from your file"
                :                        "⏱ Time it for me";
    t.textContent = label;
    t.dataset.origLabel = label;
    t.title = mode === "generated"
      ? "Reads your script aloud with the voice from step 2 and times it as it goes"
      : mode === "file"
      ? "Listens to the voiceover file you loaded and times the words to it"
      : "Listens to the sound already in your clips and times the words to it";
  }
  syncTransport();
}
if ($("modeOwn"))  $("modeOwn").addEventListener("click",  () => setMode("own"));
/* The ElevenLabs tab is gone. It sat in prime position and its only job was
   to admit it did nothing; making the voice elsewhere and loading it under
   "Load a file" was always the answer, and that tab says so itself. The
   guard stays for a saved session that still names the old mode. */
if ($("modePremium")) {
  $("modePremium").addEventListener("click", () => setMode("file"));
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

      // Correct the speed and go again if the voice missed the video's
      // length. autoFit reports the outcome itself, so only speak here
      // when it has decided nothing more is needed.
      const retrying = autoFit(spoken);
      if (!retrying) {
        let extra = "";
        if (filled) extra += " " + filled + " word" + (filled === 1 ? " was" : "s were") + " estimated between boundaries.";
        if (speakRun.usedWallClock) {
          extra += " The video wouldn't play, so the timings came from the voice itself — press Play to check they line up.";
        }
        if (extra) setVoStatus($("voStatus").textContent + extra, speakRun.usedWallClock ? "warn" : "ok");
        refreshExports();
      }
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
/* ============================================================
   Make the voice fit the video by itself.

   Speaking a script takes however long it takes, which is rarely the
   length of the clip. Measuring that and offering a button put the work
   back on you. Instead: speak, measure, correct the speed, speak again -
   and stop. One press, and the voice lands on the video.
   ============================================================ */
const FIT_TOLERANCE = 0.04;   // within 4% is close enough to leave alone
let fitAttempt = 0;           // guards against speaking in circles

function autoFit(spoken) {
  const btn = $("fitVideo");
  const vid = totalTime() || (isFinite(video.duration) ? video.duration : 0);
  if (btn) btn.style.display = "none";
  if (!vid || !spoken) return false;

  const off = Math.abs(spoken - vid) / vid;
  if (off <= FIT_TOLERANCE) {
    fitAttempt = 0;
    setVoStatus(`Timed ${S.words.length} words. The voice fits the video — ` +
                `${spoken.toFixed(1)}s against ${vid.toFixed(1)}s.`, "ok");
    return false;
  }

  // rate is a speed multiplier, so duration goes as 1/rate
  const ideal = S.rate * (spoken / vid);
  const target = Math.min(2, Math.max(0.5, ideal));

  if (fitAttempt >= 2 || Math.abs(target - S.rate) < 0.01) {
    // As close as the voice will stretch. Say where it landed and why.
    fitAttempt = 0;
    const clamped = Math.abs(ideal - target) > 0.01;
    setVoStatus(
      `Timed ${S.words.length} words. Voice ${spoken.toFixed(1)}s, video ${vid.toFixed(1)}s — ` +
      (clamped
        ? `as close as the voice will stretch. Shorten or lengthen the script to close the rest.`
        : `close enough.`),
      clamped ? "warn" : "ok");
    if (btn && clamped) {
      btn.textContent = spoken > vid ? "Try speeding it up further" : "Try slowing it down further";
      btn.style.display = "";
      btn.onclick = () => {
        $("rate").value = Math.min(2, Math.max(0.5, S.rate * (spoken / vid)));
        $("rate").dispatchEvent(new Event("input"));
        btn.style.display = "none";
        fitAttempt = 0;
        speakScript(true);
      };
    }
    return false;
  }

  // Adjust and go again, without asking.
  fitAttempt++;
  $("rate").value = target.toFixed(2);
  $("rate").dispatchEvent(new Event("input"));
  setVoStatus(`Voice was ${spoken.toFixed(1)}s against a ${vid.toFixed(1)}s video — ` +
              `${spoken > vid ? "speeding up" : "slowing down"} to ${target.toFixed(2)}× and re-timing…`);
  setTimeout(() => speakScript(true), 350);
  return true;
}

$("speakTime").addEventListener("click", () => { fitAttempt = 0; speakScript(true); });
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
          if ($("keyRow")) $("keyRow").style.display = "inline-flex";
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
/* Both of these used to be handed containers that no markup defined, so each
   call returned at its first line and the colour lists were unreachable. The
   highlight colour has its own picker in the markup; the key colour now has
   a real row to draw into. */
buildSwatches($("keySwatches"), KEY_COLORS, () => S.keyColor, v => S.keyColor = v);

if ($("emphasise")) {
  $("emphasise").addEventListener("change", e => {
    S.emphasise = e.target.checked;
    if ($("keyRow")) $("keyRow").style.display = S.emphasise ? "inline-flex" : "none";
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

  const face = fontFor(words.map(w => w.text).join(""));
  const measure = () => {
    ctx.font = fontPx + "px " + face;
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
    lengthNote: "Reels run up to 90 seconds.",
    /* You do not subscribe to a Facebook page and you do not follow a YouTube
       channel, so one shared end card was always going to be wrong somewhere. */
    cardText: "Follow the page", cardWhat: "page"
  },
  youtube: {
    label: "YouTube Shorts",
    safe: { top: 0.06, bottom: 0.16, right: 0.12 },
    maxSeconds: 180,
    captionExt: ".srt",
    captionNote: "YouTube takes .srt with any filename. Upload it on the video's subtitles page.",
    lengthNote: "Shorts run up to 3 minutes; anything longer becomes a normal video.",
    cardText: "Subscribe the channel", cardWhat: "channel"
  },
  tiktok: {
    label: "TikTok",
    safe: { top: 0.10, bottom: 0.26, right: 0.16 },
    maxSeconds: 600,
    captionExt: ".srt",
    cardText: "Follow for more", cardWhat: "account",
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
    return { ok: false, msg: `Captions run ${over}% into ${possessive(plat().label)} button area — raise “Height on frame” until this clears.` };
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
  L.push("Style: Karaoke," + assFontFor(S.words.map(w => w.text).join("")) + "," + fontSize +
         ",&H00FFFFFF,&H000000FF,&H00000000,&H73000000,0,0,0,0,100,100,0,0,1," +
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
/* What each platform's end card says. Filled from the platform's own defaults
   the first time it is opened, and kept as edited after that. */
const END_CARDS = {};
function endCardFor(key) {
  if (!END_CARDS[key]) {
    END_CARDS[key] = { text: (PLATFORMS[key] && PLATFORMS[key].cardText) || "Follow for more", handle: "" };
  }
  return END_CARDS[key];
}
function stashEndCard(key) {
  if (!key || !$("endCardText")) return;
  const c = endCardFor(key);
  c.text = $("endCardText").value;
  c.handle = $("endCardHandle").value;
}
function loadEndCard(key) {
  if (!$("endCardText")) return;
  const c = endCardFor(key);
  $("endCardText").value = c.text;
  $("endCardHandle").value = c.handle;
  const p = PLATFORMS[key] || {};
  $("endCardHandle").placeholder = key === "youtube" ? "e.g. @TheBodyMechanicz" : "e.g. @AnatomyDaily";
  if ($("endCardWho")) {
    $("endCardWho").textContent =
      "These two lines belong to " + (p.label || key) + " — each platform keeps its own, " +
      "because you do not subscribe to a page or follow a channel.";
  }
}

function applyPlatform(key) {
  if (!PLATFORMS[key]) return;
  /* Hand the outgoing platform its words back before taking the new ones. */
  if (platform && platform !== key) stashEndCard(platform);
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
  loadEndCard(key);
  if ($("safeWho")) $("safeWho").textContent = plat().label;
  updatePlatformNote();
  updateSafeZoneWarning();
}

function possessive(name) {
  return /s$/i.test(name) ? name + "\u2019" : name + "\u2019s";
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
   "expJson", "btnExportJson", "expBurn", "btnExportWebm", "btnExportMp4"].forEach(id => {
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
   Saving as MP4.

   MediaRecorder only makes WebM, which Facebook Reels will not take, and
   converting it needs ffmpeg this machine does not have. The browser can
   encode H.264 and AAC directly, so build the file here instead: frames
   from the same canvas the preview uses, sound from whatever is playing,
   muxed into a real MP4 with a proper duration.
   ============================================================ */
const MP4_MUXER_URL = "https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.1/+esm";
let muxerLib = null;

async function getMuxer() {
  if (!muxerLib) muxerLib = await import(MP4_MUXER_URL);
  return muxerLib;
}

const CAN_MP4 = !!(window.VideoEncoder && window.AudioEncoder &&
                   window.VideoFrame && window.AudioData);

/* Best H.264 profile this machine will take at the given size. */
async function pickH264(width, height, framerate) {
  const tries = ["avc1.640028", "avc1.4D0028", "avc1.42E01F"];
  for (const codec of tries) {
    try {
      const s = await VideoEncoder.isConfigSupported({
        codec, width, height, bitrate: 8e6, framerate
      });
      if (s.supported) return codec;
    } catch (e) {}
  }
  return null;
}

/* Park a clip on an exact moment and wait until the frame is really there.
   Drawing before this resolves is what put blank frames at the start. */
function seekElement(el, t) {
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      el.removeEventListener("seeked", onSeeked);
      resolve();
    };
    /* 'seeked' can fire before there is a frame to paint, and readyState
       only says data has arrived — not that the decoder has handed over a
       picture. requestVideoFrameCallback fires exactly when a frame is
       presentable, which is the signal we actually want; readyState is the
       fallback for browsers that do not have it. */
    const whenReady = (tries = 0) => {
      if (typeof el.requestVideoFrameCallback === "function") {
        el.requestVideoFrameCallback(() => finish());
        return;
      }
      if (el.readyState >= 2 || tries > 40) return finish();
      setTimeout(() => whenReady(tries + 1), 15);
    };
    const onSeeked = () => whenReady();
    if (Math.abs(el.currentTime - t) < 0.001 && el.readyState >= 2) return finish();
    el.addEventListener("seeked", onSeeked);
    try { el.currentTime = t; } catch (e) { return finish(); }
    setTimeout(finish, 1200);     // never hang on a clip that will not seek
  });
}

/* Is anything actually painted here, or is it an empty frame?

   This used to read only the top 200 rows and ask for a bright average,
   which called a letterboxed clip — black bars across the top — empty and
   refused to render it. A clip that simply opens on a dark shot was thrown
   out the same way. So read the whole frame, and accept it if ANY pixel is
   clearly not black: one lit pixel proves the decoder delivered. */
function canvasHasPicture(ctx, W, H) {
  let d;
  try { d = ctx.getImageData(0, 0, W, H).data; }
  catch (e) { return true; }          // can't look — don't block the render
  const step = 4 * Math.max(1, Math.floor((W * H) / 20000));
  let sum = 0, n = 0, max = 0;
  for (let i = 0; i < d.length; i += step) {
    const v = (d[i] + d[i + 1] + d[i + 2]) / 3;
    sum += v; n++;
    if (v > max) max = v;
  }
  if (!n) return false;
  return max > 24 || (sum / n) > 2;
}

/* ============================================================
   A voice spoken by the browser exists only while it is speaking - there
   is no file to read it from. So record it once, up front, and hand the
   samples to the renderer. One pass of listening, then the picture is
   built frame by frame around it.
   ============================================================ */
async function captureSpokenAudio(onProgress) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error("No audio support in this browser.");

  const ok = window.confirm(
    "Your voice is spoken by the browser, so it has to be recorded before the video can be built.\n\n" +
    "In the box that appears:\n" +
    "  1. Choose ENTIRE SCREEN  (not the tab — tab audio records silence)\n" +
    "  2. Tick “Also share system audio”\n" +
    "  3. Press Share\n\n" +
    "Only the sound is kept; the screen picture is thrown away. It takes about\n" +
    "as long as your script to read out, then the video is rendered.\n\n" +
    "Press OK to continue."
  );
  if (!ok) throw new Error("cancelled");

  const ds = await navigator.mediaDevices.getDisplayMedia({
    video: true, audio: true, systemAudio: "include"
  });
  ds.getVideoTracks().forEach(t => t.stop());
  const tracks = ds.getAudioTracks();
  if (!tracks.length) {
    ds.getTracks().forEach(t => t.stop());
    throw new Error("no sound was shared — “Also share system audio” wasn't ticked");
  }

  const ac = new AC();
  const src = ac.createMediaStreamSource(new MediaStream([tracks[0]]));
  const proc = ac.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  let peak = 0;
  proc.onaudioprocess = e => {
    const inBuf = e.inputBuffer.getChannelData(0);
    const copy = new Float32Array(inBuf.length);
    copy.set(inBuf);
    for (let i = 0; i < copy.length; i += 7) { const v = Math.abs(copy[i]); if (v > peak) peak = v; }
    chunks.push(copy);
  };
  src.connect(proc);
  proc.connect(ac.destination);

  try {
    await new Promise((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(scriptEl.value.trim());
      u.voice = voices[+$("voice").value];
      u.rate = S.rate;
      u.onend = resolve;
      u.onerror = e => reject(new Error("the voice stopped: " + e.error));
      TTS.cancel();
      TTS.speak(u);
      const started = performance.now();
      const tick = setInterval(() => {
        const secs = (performance.now() - started) / 1000;
        if (onProgress) onProgress(secs, peak);
        if (!TTS.speaking && !TTS.pending && secs > 1) { clearInterval(tick); resolve(); }
        if (secs > 600) { clearInterval(tick); resolve(); }
      }, 250);
    });
  } finally {
    try { proc.disconnect(); src.disconnect(); } catch (e) {}
    proc.onaudioprocess = null;
    ds.getTracks().forEach(t => t.stop());
  }

  const total = chunks.reduce((a, c) => a + c.length, 0);
  const joined = new Float32Array(total);
  let at = 0;
  chunks.forEach(c => { joined.set(c, at); at += c.length; });
  const rate = ac.sampleRate;
  try { ac.close(); } catch (e) {}

  if (peak < 0.02) {
    throw new Error("nothing was captured (level " + (peak * 100).toFixed(1) + "%) — " +
                    "you most likely shared a tab or window instead of Entire Screen");
  }
  return { pcm: joined, sampleRate: rate, seconds: total / rate, peak };
}

/* When does the talking actually begin in these samples? */
function firstSoundAt(pcm, rate) {
  const win = Math.max(1, Math.round(rate * 0.02));
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 5) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; }
  const thresh = Math.max(0.02, peak * 0.12);
  for (let i = 0; i + win <= pcm.length; i += win) {
    let m = 0;
    for (let j = 0; j < win; j++) { const v = Math.abs(pcm[i + j]); if (v > m) m = v; }
    if (m >= thresh) return i / rate;
  }
  return 0;
}

/* Where does the talking stop? Used to catch drift across a whole read. */
function lastSoundAt(pcm, rate) {
  const win = Math.max(1, Math.round(rate * 0.02));
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 5) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; }
  const thresh = Math.max(0.02, peak * 0.12);
  for (let i = pcm.length - win; i >= 0; i -= win) {
    let m = 0;
    for (let j = 0; j < win; j++) { const v = Math.abs(pcm[i + j]); if (v > m) m = v; }
    if (m >= thresh) return (i + win) / rate;
  }
  return pcm.length / rate;
}

/* Aligning the start is not enough on its own: if this reading ran a
   little faster or slower than the one the captions were timed against,
   the two drift apart by the end. Stretch the timings to match the
   recording, keeping every word in the same relative place. */
function matchTimingsToAudio(pcm, rate) {
  if (!S.words.length) return 0;
  const first = S.words[0], last = S.words[S.words.length - 1];
  if (first.start === null || last.end === null) return 0;

  const heardStart = firstSoundAt(pcm, rate);
  const heardEnd = lastSoundAt(pcm, rate);
  const heardSpan = heardEnd - heardStart;
  const captionSpan = last.end - first.start;
  if (heardSpan <= 0.3 || captionSpan <= 0.3) return 0;

  const k = heardSpan / captionSpan;
  if (Math.abs(k - 1) < 0.02) return 0;          // under 2%, leave it alone

  const base = first.start;
  S.words.forEach(w => {
    w.start = base + (w.start - base) * k;
    w.end   = base + (w.end   - base) * k;
  });
  return k;
}

/* Line the recording up with the captions.

   The captions were timed during one reading; the audio was captured
   during another, and recording starts before the voice does. That
   lead-in pushes the whole soundtrack late. Measure where the voice
   really starts and slide the audio so it lands exactly where the first
   caption expects it. */
function alignCapturedAudio(pcm, rate, expectedFirstWord) {
  const onset = firstSoundAt(pcm, rate);
  const want = Math.max(0, expectedFirstWord || 0);
  const shift = onset - want;                 // positive: audio starts too late
  const samples = Math.round(Math.abs(shift) * rate);
  if (samples < Math.round(rate * 0.02)) return { pcm, shift: 0, onset };

  if (shift > 0) {
    const out = pcm.subarray(samples);        // trim the dead air off the front
    return { pcm: out, shift, onset };
  }
  const out = new Float32Array(pcm.length + samples);   // or pad it out
  out.set(pcm, samples);
  return { pcm: out, shift, onset };
}

/* The whole soundtrack, decoded up front at full quality, so the audio
   does not depend on anything happening in real time. */
async function gatherExportAudio(sr) {
  /* S.voiceoverBlob, not the file input: a voice generated from the script
     never passes through a file picker, and reading only the input is what
     left those exports silent. */
  const voiceover = S.voiceoverBlob ||
                    ($("audioFile").files && $("audioFile").files[0]);
  if (S.hasAudio && voiceover) {
    try { return await decodeMono(voiceover, sr); } catch (e) { return null; }
  }
  if (!S.clips.length) return null;
  const parts = [];
  let any = false;
  for (const c of S.clips) {
    let pcm = null;
    try { pcm = await decodeMono(c.file, sr); } catch (e) {}
    if (!pcm || !pcm.length) pcm = new Float32Array(Math.ceil((c.duration || 0) * sr));
    else any = true;
    parts.push(pcm);
  }
  if (!any) return null;
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  parts.forEach(p => { out.set(p, at); at += p.length; });
  return out;
}

/* ============================================================
   Rendering an MP4 frame by frame.

   Recording in real time captures whatever the canvas happens to hold,
   which at the start is nothing - the opening was corrupted because the
   encoder began before the first frame existed. Rendering instead means
   every frame is drawn deliberately: park the clip on the exact moment,
   wait for it, draw, encode. Nothing depends on playback keeping up.
   ============================================================ */
async function renderMp4() {
  const { w: W, h: H } = outputSize();
  const FPS = 30, SR = 48000, CH = 1;
  const dur = totalTime();
  const cardSecs = endCardSeconds();
  const btn = $("btnExportMp4");
  let frameCount = Math.max(1, Math.round((dur + cardSecs) * FPS));

  const { Muxer, ArrayBufferTarget } = await getMuxer();
  const codec = await pickH264(W, H, FPS);
  if (!codec) throw new Error("This browser won't encode H.264 at " + W + "×" + H + ".");

  /* Where the sound comes from depends on which voice is in use. A spoken
     voice has to be recorded first; a file or a clip's own audio can just
     be read. Either way the renderer receives plain samples. */
  const speaking = S.voMode === "generated" && CAN_SPEAK && $("voice").value !== "";
  let pcm = null, audioRate = SR;

  if (speaking) {
    setAiClockLabel(btn, "Recording the voice");
    const cap = await captureSpokenAudio((secs, peak) => {
      say(`Recording the voice — ${secs.toFixed(0)}s, level ${(peak * 100).toFixed(0)}%…`);
    });
    /* Slide the recording so its first word lands where the first caption
       expects it. Without this the captions run ahead of the voice by
       however long the share dialog and the speech engine took to start. */
    const firstWord = (S.words[0] && S.words[0].start) || 0;
    const aligned = alignCapturedAudio(cap.pcm, cap.sampleRate, firstWord);
    pcm = aligned.pcm;
    audioRate = cap.sampleRate;

    // then correct any speed difference across the whole read
    const stretch = matchTimingsToAudio(pcm, audioRate);
    if (stretch) {
      renderChips();
      frameCount = Math.max(frameCount,
        Math.round(((S.words[S.words.length - 1].end || 0) + cardSecs + 0.2) * FPS));
    }
    const heard = pcm.length / audioRate;

    // Never cut the voice off: if it ran past the clips, hold the last
    // frame for the remainder rather than ending mid-sentence.
    if (heard > dur + cardSecs + 0.1) frameCount = Math.round(heard * FPS);

    const bits = [];
    if (Math.abs(aligned.shift) >= 0.02) {
      bits.push(`shifted the sound ${aligned.shift > 0 ? "earlier" : "later"} by ` +
                `${Math.abs(aligned.shift).toFixed(2)}s`);
    }
    if (stretch) {
      bits.push(`stretched the captions ${((stretch - 1) * 100).toFixed(1)}% to match the reading`);
    }
    say(`Captured ${heard.toFixed(1)}s of voice — ` +
        (bits.length ? bits.join(" and ") + "." : "it already lined up.") +
        ` Now building the picture…`);
  } else {
    setAiClockLabel(btn, "Reading the sound");
    pcm = await gatherExportAudio(SR);
  }

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width: W, height: H },
    ...(pcm ? { audio: { codec: "aac", numberOfChannels: CH, sampleRate: audioRate } } : {}),
    fastStart: "in-memory"
  });

  let encErr = null;
  const venc = new VideoEncoder({
    output: (c, m) => muxer.addVideoChunk(c, m),
    error: e => { encErr = e; }
  });
  venc.configure({ codec, width: W, height: H, bitrate: 8e6, framerate: FPS });

  let aenc = null;
  if (pcm) {
    aenc = new AudioEncoder({
      output: (c, m) => muxer.addAudioChunk(c, m),
      error: e => { encErr = e; }
    });
    aenc.configure({ codec: "mp4a.40.2", numberOfChannels: CH, sampleRate: audioRate, bitrate: 128000 });
  }

  const rc = document.createElement("canvas");
  rc.width = W; rc.height = H;
  const rctx = rc.getContext("2d", { alpha: false });

  pauseAll();
  S.clips.forEach(c => { try { c.el.pause(); } catch (e) {} });

  for (let i = 0; i < frameCount; i++) {
    if (encErr) throw encErr;
    const t = i / FPS;

    if (t < dur) {
      const hit = clipAt(t);
      if (hit) {
        await seekElement(hit.clip.el, Math.min(hit.local, Math.max(0, hit.clip.duration - 0.02)));
        drawClipFitted(rctx, hit.clip.el, W, H);

        /* Check the very first frame really carries the footage. A hidden
           video element paints nothing, and shipping a black render is far
           worse than stopping and saying so. */
        if (i === 0 && !canvasHasPicture(rctx, W, H)) {
          // one retry: give the element a moment and draw again
          await new Promise(r => setTimeout(r, 250));
          drawClipFitted(rctx, hit.clip.el, W, H);
          if (!canvasHasPicture(rctx, W, H)) {
            throw new Error("the picture isn't coming through — the clip decoded to an empty frame. " +
                            "Try the .webm button, or reload the page and load the clip again.");
          }
        }
      } else {
        rctx.fillStyle = "#000"; rctx.fillRect(0, 0, W, H);
      }
      drawCaptions(rctx, W, H, t);
    } else {
      // hold the final frame and fade the call to action over it
      const last = S.clips[S.clips.length - 1];
      if (last) {
        await seekElement(last.el, Math.max(0, last.duration - 0.05));
        drawClipFitted(rctx, last.el, W, H);
      }
      drawEndCard(rctx, W, H, (t - dur) / Math.max(0.01, cardSecs));
    }

    const vf = new VideoFrame(rc, {
      timestamp: Math.round(i * 1e6 / FPS),
      duration: Math.round(1e6 / FPS)
    });
    venc.encode(vf, { keyFrame: i % 60 === 0 });
    vf.close();

    if (venc.encodeQueueSize > 16) await new Promise(r => setTimeout(r, 4));
    if (i % 5 === 0) {
      const pct = Math.round((i / frameCount) * 100);
      setAiClockLabel(btn, "Rendering " + pct + "%");
      say(`Rendering frame ${i + 1} of ${frameCount} — ${pct}%`);
    }
  }

  if (pcm && aenc) {
    setAiClockLabel(btn, "Adding the sound");
    const CHUNK = 4096;
    const wanted = pcm.length;   // keep the whole voice, however long it ran
    for (let off = 0; off < wanted; off += CHUNK) {
      const n = Math.min(CHUNK, wanted - off);
      const slice = new Float32Array(n);
      slice.set(pcm.subarray(off, off + n));
      const ad = new AudioData({
        format: "f32-planar", sampleRate: audioRate, numberOfFrames: n,
        numberOfChannels: CH, timestamp: Math.round(off * 1e6 / audioRate), data: slice
      });
      aenc.encode(ad);
      ad.close();
      if (aenc.encodeQueueSize > 16) await new Promise(r => setTimeout(r, 4));
    }
  }

  setAiClockLabel(btn, "Finishing");
  await venc.flush();
  if (aenc) await aenc.flush();
  muxer.finalize();
  try { venc.close(); } catch (e) {}
  try { if (aenc) aenc.close(); } catch (e) {}
  if (encErr) throw encErr;

  return {
    blob: new Blob([muxer.target.buffer], { type: "video/mp4" }),
    frames: frameCount, seconds: frameCount / FPS, hadAudio: !!pcm, W, H
  };
}

async function exportMp4() {
  if (!CAN_MP4) { say("This browser can't build MP4 files. Use the .webm button instead.", "warn"); return; }
  if (!S.clips.length) { say("Add your clips in step 1 first.", "warn"); return; }
  if (!allTimed()) { say("Finish the timings in step 4 first.", "warn"); return; }

  /* The MP4 is built from decoded audio, and a voice spoken by the browser
     produces no audio to decode — there is no way to read it back. Say that
     BEFORE the render rather than after, because "SILENT" arriving at the
     end of a full render reads as a bug and costs the whole wait. */
  if (S.voMode === "generated" && CAN_SPEAK && $("voice").value !== "") {
    const go = window.confirm(
      "The MP4 cannot carry a voice spoken by the browser.\n\n" +
      "The browser gives no way to read that speech back as sound, so this\n" +
      "MP4 will contain your clips' own audio only — and nothing at all if\n" +
      "the clips are silent.\n\n" +
      "To get the voice into the file, press “🎙 Make the voice a real file”\n" +
      "in step 2 first. It speaks your script into an actual audio file, which\n" +
      "is written straight into the MP4 — no screen sharing, every time.\n\n" +
      "Press OK to render a silent MP4 anyway, or Cancel to go back."
    );
    if (!go) {
      say("MP4 export cancelled. Press “🎙 Make the voice a real file” in step 2, " +
          "then export again — the voice will be in the file.", "warn");
      return;
    }
  }

  const btn = $("btnExportMp4");
  S.recording = true;
  refreshExports();
  startAiClock(btn, "Preparing");
  const wasMuted = video.muted;
  try {
    const r = await renderMp4();
    if (!(await opensCleanly(r.blob))) {
      throw new Error("the finished file would not open");
    }
    download(baseName() + "-captioned.mp4", r.blob);
    say(`Saved ${baseName()}-captioned.mp4 — ${r.W}×${r.H}, ${r.seconds.toFixed(1)}s, ` +
        `${(r.blob.size / 1048576).toFixed(1)} MB` +
        (r.hadAudio ? ", with sound."
                    : (S.voMode === "generated"
                       ? ", but SILENT — a browser-spoken voice can't be written into an MP4."
                       : ", but SILENT — no sound was found in the clips.")) +
        ` Every frame was drawn one at a time, so the start is clean. Ready for ${plat().label}.`,
        r.hadAudio ? "ok" : "warn");
    stopAiClock(btn, "✅ Saved MP4", 2600);
  } catch (e) {
    stopAiClock(btn);
    say("MP4 export failed: " + (e.message || e) + " — the .webm button still works.", "warn");
  } finally {
    S.recording = false;
    video.muted = wasMuted;
    pauseAll();
    refreshExports();
  }
}

if ($("btnExportMp4")) $("btnExportMp4").addEventListener("click", exportMp4);

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
      "There is now a better way: press “🎙 Make the voice a real file” in step 2.\n" +
      "That turns your script into an actual audio file, which goes straight into\n" +
      "the export — MP4 included — with nothing shared. Cancel and use that if you can.\n\n" +
      "Otherwise: to put a Windows-spoken voice inside the video, the browser has to\n" +
      "record the sound off your screen.\n\n" +
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

  const recStart = performance.now();
  rec.onstop = async () => {
    const peak = levelMeter ? levelMeter.peak() : 0;
    const hadAudio = stream.getAudioTracks().length > 0 && peak >= AUDIBLE;
    if (levelMeter) levelMeter.close();
    stream.getTracks().forEach(t => { if (t.kind === "video") t.stop(); });
    if (tabStream) tabStream.getTracks().forEach(t => t.stop());
    if (speaking) stopSpeaking();
    S.recording = false;
    pauseAll();
    video.muted = (S.voMode === "file" && S.hasAudio);

    // How long the recording actually ran, which is what players need told.
    const recorded = (performance.now() - recStart) / 1000;
    say("Finishing the file…");
    const original = new Blob(chunks, { type: mime });
    let out = original;
    if (original.size > 1024) {
      const patched = await withWebmDuration(original, recorded);
      // Only hand over the patched file if it still opens. A missing
      // duration is a nuisance; a file that will not play is a lost render.
      out = (patched !== original && await opensCleanly(patched)) ? patched : original;
    }
    download(baseName() + "-captioned.webm", out);

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

  /* requestAnimationFrame stops dead while the tab is hidden — and picking
     "Entire Screen" in the share box is exactly what sends this tab to the
     background. The whole loop lives here, the stop condition included, so
     a hidden tab meant a frozen picture and a recording that never ended.
     Fall back to a timer whenever the tab is not visible: a page holding a
     capture stream is exempt from Chrome's background timer clamp. */
  const schedule = fn => {
    if (document.hidden) setTimeout(fn, 33);
    else requestAnimationFrame(fn);
  };

  let lastT = -1, lastMoved = performance.now();
  const tick = () => {
    if (levelMeter) levelMeter.sample();
    advanceClipIfEnded();               // roll into the next clip mid-recording
    const t = nowTime();

    /* A file that overstates its length simply stops advancing, and waiting
       for an 'ended' that never fires produced a recording of a frozen
       frame. Treat a stalled clock as the end. */
    if (Math.abs(t - lastT) > 0.01) { lastT = t; lastMoved = performance.now(); }
    const stalledHere = !video.paused && (performance.now() - lastMoved > 1600);

    const clipDone = t >= dur - 0.04 || stalledHere ||
                     (timelineEnded() && (!S.hasAudio || audio.ended));

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
    schedule(tick);
  };
  schedule(tick);
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
                checkClipSound, updateSoundSummary, gatherTimingAudio, decodeMono, shortReason,
                withWebmDuration, captureClipAudio, clipAudio, opensCleanly, playableLength,
                autoFit, FIT_TOLERANCE, exportMp4, CAN_MP4, pickH264, outputSize,
                renderMp4, seekElement, gatherExportAudio,
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
  for (let attempt = 0; attempt < 3; attempt++) {
    model = await resolveGeminiModel(apiKey);
    /* A busy model does not always refuse. Sometimes it accepts the request and
       simply never answers, and the newest model is the busiest one there is.
       So the first pick gets a short leash: if it has said nothing in twenty
       seconds it is not going to, and another model is a better use of the
       wait than the rest of a minute and a half. */
    const patience = attempt === 0 ? 20000 : 90000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort("timeout"), patience);
    let stalled = false;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reqBody), signal: ctrl.signal }
      );
    } catch (netErr) {
      if (netErr && netErr.name === "AbortError") {
        if (attempt < 2) { GEMINI_REJECTED.add(model); GEMINI_MODEL = null; stalled = true; }
        else throw new Error("Gemini didn't answer in time. Your network may be blocking it — try again.");
      } else {
        throw new Error("Couldn't reach Google. Check your connection and try again.");
      }
    } finally {
      clearTimeout(timer);
    }
    if (stalled) continue;
    if (res.ok) break;

    const errData = await res.json().catch(() => ({}));
    lastMsg = errData.error?.message || "";
    /* Two different things send us to another model. A retired one is gone for
       good. A model "experiencing high demand" is not gone, but the newest is
       the busiest, and waiting out a spike is worse than reading the same
       question to a model that is free right now. */
    const gone     = res.status === 404 ||
                     /no longer available|not found|not supported|does not exist/i.test(lastMsg);
    const swamped  = res.status === 503 ||
                     /high demand|overloaded|unavailable|try again later/i.test(lastMsg);

    if ((gone || swamped) && attempt < 2) {
      GEMINI_REJECTED.add(model);   // never offer this one again this session
      GEMINI_MODEL = null;
      continue;                      // resolve a different model and try again
    }

    if (res.status === 429) throw new Error("Free-tier rate limit reached. Wait about a minute and try again.");
    if (res.status === 400 && /API key/i.test(lastMsg)) throw new Error("That API key was rejected. Open the 🔑 dialog and paste a fresh one.");
    if (/quota|billing|credits/i.test(lastMsg)) throw new Error("This key's project is out of quota or credits. Make a key in a new project.");
    if (gone || swamped) throw new Error(`No Gemini model on this key would take the request. Last tried "${model}".`);
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
/* Naming a favourite here was how this rotted: gemini-2.5-flash is now closed
   to new keys, so every fresh session spent its first call being refused
   before the retry found something that worked. Ask what the key can actually
   reach instead — that answer cannot go stale. */
const PREFERRED_MODEL = null;

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

/* ============================================================
   MediaRecorder writes WebM with no Duration at all, so players cannot
   tell how long the video is. They then refuse to seek and often appear
   to stall before the end - the footage is all there, but nothing knows
   where the end is.

   The Segment is written with unknown size and there are no Cues, so a
   Duration can be inserted into the Info block without disturbing a
   single byte of the media that follows.
   ============================================================ */
function ebmlVint(bytes, at) {
  const first = bytes[at];
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { mask >>= 1; len++; }
  if (len > 8) return null;
  let val = first & (mask - 1);
  let allOnes = (first & (mask - 1)) === (mask - 1);
  for (let i = 1; i < len; i++) {
    val = val * 256 + bytes[at + i];
    if (bytes[at + i] !== 0xff) allOnes = false;
  }
  return { len, val, unknown: allOnes };
}

function encodeVint(value) {
  for (let len = 1; len <= 8; len++) {
    if (value <= Math.pow(2, 7 * len) - 2) {
      const out = new Uint8Array(len);
      let v = value;
      for (let i = len - 1; i > 0; i--) { out[i] = v & 0xff; v = Math.floor(v / 256); }
      out[0] = (v & 0xff) | (0x80 >> (len - 1));
      return out;
    }
  }
  return null;
}

function findEbmlId(bytes, hex, from, to) {
  const id = [];
  for (let i = 0; i < hex.length; i += 2) id.push(parseInt(hex.substr(i, 2), 16));
  const end = Math.min(to, bytes.length - id.length);
  for (let i = from; i <= end; i++) {
    let ok = true;
    for (let j = 0; j < id.length; j++) if (bytes[i + j] !== id[j]) { ok = false; break; }
    if (ok) return i;
  }
  return -1;
}

/* Can the browser still open this? Used to prove a patched file before it
   is handed over, so a header edit can never cost a whole render. */
function opensCleanly(blob) {
  return new Promise(res => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(blob);
    let settled = false;
    const done = ok => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      res(ok);
    };
    v.preload = "metadata";
    v.onloadedmetadata = () => done(v.videoWidth > 0 || isFinite(v.duration));
    v.onerror = () => done(false);
    setTimeout(() => done(false), 6000);
    v.src = url;
  });
}

/* Returns a new Blob with the duration written in. On anything unexpected
   it returns the original untouched - a file with no duration is far
   better than one that has been mangled. */
async function withWebmDuration(blob, seconds) {
  try {
    if (!isFinite(seconds) || seconds <= 0) return blob;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length < 64) return blob;
    if (!(bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)) return blob;

    const SEARCH = Math.min(bytes.length, 8192);
    const infoAt = findEbmlId(bytes, "1549a966", 0, SEARCH);
    if (infoAt < 0) return blob;

    const sz = ebmlVint(bytes, infoAt + 4);
    if (!sz || sz.unknown) return blob;
    const contentAt = infoAt + 4 + sz.len;
    const contentEnd = contentAt + sz.val;
    if (contentEnd > bytes.length) return blob;

    let scale = 1000000;
    const tsAt = findEbmlId(bytes, "2ad7b1", contentAt, contentEnd);
    if (tsAt >= 0) {
      const tsz = ebmlVint(bytes, tsAt + 3);
      if (tsz && !tsz.unknown && tsz.val <= 8) {
        let v = 0;
        for (let i = 0; i < tsz.val; i++) v = v * 256 + bytes[tsAt + 3 + tsz.len + i];
        if (v > 0) scale = v;
      }
    }
    const ticks = seconds * 1e9 / scale;

    const durAt = findEbmlId(bytes, "4489", contentAt, contentEnd);
    if (durAt >= 0) {
      const dsz = ebmlVint(bytes, durAt + 2);
      if (!dsz || dsz.val !== 8) return blob;
      const copy = bytes.slice();
      new DataView(copy.buffer).setFloat64(durAt + 2 + dsz.len, ticks, false);
      return new Blob([copy], { type: blob.type });
    }

    const dur = new Uint8Array(11);
    dur[0] = 0x44; dur[1] = 0x89; dur[2] = 0x88;
    new DataView(dur.buffer).setFloat64(3, ticks, false);

    const newSize = encodeVint(sz.val + dur.length);
    if (!newSize) return blob;

    return new Blob([
      bytes.slice(0, infoAt + 4),
      newSize,
      bytes.slice(contentAt, contentEnd),
      dur,
      bytes.slice(contentEnd)
    ], { type: blob.type });
  } catch (e) {
    return blob;
  }
}

/* ============================================================
   Getting the sound out, the slow but reliable way.

   decodeAudioData reads a file directly and is fast, but it is fussier
   than the video player: some clips it simply refuses. When that happens,
   play the clip through the audio graph instead and record what comes
   out. That takes as long as the clip, but it works on anything the
   browser can play - which is the whole point of the fallback.
   ============================================================ */
const elementGraphs = new WeakMap();

function captureClipAudio(clip, sr, onProgress) {
  return new Promise((resolve, reject) => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return reject(new Error("No audio support in this browser."));
    const el = clip.el;
    let g = elementGraphs.get(el);
    try {
      if (!g) {
        const ac = new AC();
        const src = ac.createMediaElementSource(el);
        g = { ac, src };
        elementGraphs.set(el, g);
      }
    } catch (e) { return reject(new Error("Couldn't listen to that clip.")); }

    const { ac, src } = g;
    if (ac.state === "suspended") ac.resume().catch(() => {});
    const proc = ac.createScriptProcessor(4096, 1, 1);
    const chunks = [];
    let done = false;

    const finish = err => {
      if (done) return;
      done = true;
      try { proc.disconnect(); src.disconnect(proc); } catch (e) {}
      el.pause();
      el.muted = true;
      if (err) return reject(err);
      // stitch, then resample to the rate the analysis wants
      const total = chunks.reduce((a, c) => a + c.length, 0);
      const joined = new Float32Array(total);
      let at = 0;
      chunks.forEach(c => { joined.set(c, at); at += c.length; });
      if (ac.sampleRate === sr || !total) return resolve(joined);
      const ratio = ac.sampleRate / sr;
      const out = new Float32Array(Math.floor(total / ratio));
      for (let i = 0; i < out.length; i++) out[i] = joined[Math.floor(i * ratio)] || 0;
      resolve(out);
    };

    proc.onaudioprocess = e => {
      chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      if (onProgress && el.duration) onProgress(Math.min(1, el.currentTime / el.duration));
    };
    src.connect(proc);
    proc.connect(ac.destination);

    el.onended = () => finish(null);
    el.onerror = () => finish(new Error("That clip wouldn't play."));
    el.muted = false;
    el.currentTime = 0;
    el.play().catch(() => finish(new Error("The browser wouldn't play that clip.")));

    // never hang if 'ended' does not arrive
    const cap = ((clip.duration || 30) + 8) * 1000;
    setTimeout(() => finish(null), cap);
  });
}

/* Fast read first, then the slow one if it comes back empty. */
async function clipAudio(clip, sr, onNote) {
  try {
    const pcm = await decodeMono(clip.file, sr);
    let peak = 0;
    for (let i = 0; i < pcm.length; i += 5) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; }
    if (peak >= 0.005) return { pcm, how: "read from the file" };
  } catch (e) { /* fall through to playing it */ }

  if (onNote) onNote(clip);
  const pcm = await captureClipAudio(clip, sr);
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 5) { const v = Math.abs(pcm[i]); if (v > peak) peak = v; }
  if (peak < 0.005) throw new Error("silent");
  return { pcm, how: "captured while playing" };
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
  /* S.voiceoverBlob, not the file input — the same trap that once left
     exports silent, and here it was worse than silence. A voice made from
     your script never touches a file picker, so this read nothing, fell
     through to the clips, and timed the words against the video's own
     soundtrack. The export then muxed in the voiceover instead, and the
     captions ran against a recording they had never heard. */
  const voiceover = S.voiceoverBlob ||
                    ($("audioFile").files && $("audioFile").files[0]);
  if (S.hasAudio && voiceover) {
    return { pcm: await decodeMono(voiceover, SR), sr: SR, from: "your voiceover" };
  }
  if (S.clips.length) {
    const parts = [];
    const failed = [];
    let playedAny = false;
    for (const c of S.clips) {
      try {
        const r = await clipAudio(c, SR, clip => {
          playedAny = true;
          say(`Reading “${clip.name}” the slow way — playing it through to capture the sound. ` +
              `This takes about ${Math.round(clip.duration || 10)}s.`);
        });
        parts.push(r.pcm);
      } catch (e) {
        // A clip that will not give up its sound is NOT the same as a quiet
        // one, and both are now reported for what they are.
        failed.push(c.name);
        parts.push(new Float32Array(Math.ceil((c.duration || 0) * SR)));
      }
    }
    if (failed.length === S.clips.length) {
      const what = failed.length === 1
        ? `“${failed[0]}” has no sound in it`
        : `None of the ${failed.length} clips have any sound in them`;
      // Point at whatever is actually available, rather than a generic list.
      const voiceReady = CAN_SPEAK && $("voice") && $("voice").value !== "";
      const how = voiceReady
        ? `You already have a voice picked in step 2 — switch step 2 to “Make one here” and press ` +
          `“Speak it and time the words”. That reads your script aloud and times it as it goes.`
        : `Add a voice in step 2: “Make one here” speaks your script, or “Load a file” uses a recording.`;
      throw new Error(`${what} — the file was read and played through, and both were silent. ${how}`);
    }
    if (failed.length) {
      say(`No sound in ${failed.join(", ")} — those stretches are treated as silence.`, "warn");
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
  return S.clips.length > 0 ||
         (S.hasAudio && (S.voiceoverBlob || $("audioFile").files[0]));
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

    /* Timing means listening to a voice. Which voice depends on what step 2
       is set to, so send this to the right place rather than always reading
       the clips - a clip with no sound is not a failure when the voice is
       being spoken here. */
    if (S.voMode === "generated" && CAN_SPEAK && $("voice").value !== "") {
      say("Using the voice from step 2 — speaking it, timing it, and fitting it to the video.");
      fitAttempt = 0;
      speakScript(true);
      return;
    }

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
          `Usually that means a tab or a window was shared instead of “Entire Screen”, ` +
          `or the speakers are muted — the sound has to be playing to be recorded. ` +
          `Rather than fight this: press “🎙 Make the voice a real file” in step 2. ` +
          `It turns your script into an actual audio file, which goes straight into ` +
          `the export — MP4 included — with nothing shared and nothing to tick.`, "warn");
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

/* The decoded picture, ready to draw. Kept decoded because the renderer draws
   frames one after another with no chance to wait for an image to load. */
let endCardImg = null;

function drawEndCard(ctx, W, H, progress) {
  const line1 = ($("endCardText").value || plat().cardText || "Follow for more").trim();
  const line2 = ($("endCardHandle").value || "").trim();
  const pic = (endCardImg && endCardImg.complete && endCardImg.naturalWidth) ? endCardImg : null;

  ctx.save();
  ctx.fillStyle = "rgba(8,12,16," + (0.55 + 0.35 * Math.min(1, progress * 3)) + ")";
  ctx.fillRect(0, 0, W, H);

  const cardFace = fontFor(String(line1 || "") + String(line2 || ""));
  const fit = (text, targetPx, maxW) => {
    let px = targetPx;
    ctx.font = px + "px " + cardFace;
    while (ctx.measureText(text).width > maxW && px > 10) {
      px *= maxW / ctx.measureText(text).width;
      ctx.font = px + "px " + cardFace;
    }
    return px;
  };

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";

  /* With a face on the card everything below it shifts down to make room; with
     no picture the wording sits exactly where it always did. */
  const yHead = pic ? 0.545 : 0.46;
  const yHandle = pic ? 0.625 : 0.56;

  if (pic) {
    const r = H * 0.085;
    const cx = W / 2, cy = H * 0.40;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    /* Cover, not stretch: a rectangular avatar should be cropped square, not
       squashed into an oval. */
    const scale = Math.max(r * 2 / pic.naturalWidth, r * 2 / pic.naturalHeight);
    const dw = pic.naturalWidth * scale, dh = pic.naturalHeight * scale;
    ctx.drawImage(pic, cx - dw / 2, cy - dh / 2, dw, dh);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.lineWidth = Math.max(2, r * 0.085);
    ctx.strokeStyle = S.hlColor || "#FFD400";
    ctx.stroke();
  }

  const headline = captionCase(line1);
  const big = fit(headline, H * 0.075, W * 0.84);
  ctx.font = big + "px " + cardFace;
  ctx.lineWidth = big * 0.17;
  ctx.strokeStyle = "#000";
  ctx.strokeText(headline, W / 2, H * yHead);
  ctx.fillStyle = S.hlColor || "#FFD400";
  ctx.fillText(headline, W / 2, H * yHead);

  if (line2) {
    const small = fit(line2, H * 0.038, W * 0.8);
    ctx.font = small + "px " + cardFace;
    ctx.lineWidth = small * 0.17;
    ctx.strokeStyle = "#000";
    ctx.strokeText(line2, W / 2, H * yHandle);
    ctx.fillStyle = "#FFFFFF";
    ctx.fillText(line2, W / 2, H * yHandle);
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
/* ============================================================
   Making the voiceover a real file.

   A voice spoken by the browser exists only while it is playing. There is
   no way to read it back as sound, which is why getting it into an export
   meant sharing the whole screen and trusting two checkboxes — and why a
   render so often came back silent. Synthesising the script instead returns
   actual samples, so the exporter writes them straight in. Nothing shared,
   nothing to get wrong, and the MP4 can carry the voice at last.
   ============================================================ */
/* The speech models are all previews, and previews get retired — that is
   exactly how the text side broke. So pick one from what the key can see,
   newest first, and remember any that refuse. Pro is skipped on purpose: it
   has no free tier and answers "exceeded your quota" rather than anything
   useful. */
let TTS_MODEL = null;
const TTS_REJECTED = new Set();

async function resolveTtsModel(apiKey) {
  if (TTS_MODEL && !TTS_REJECTED.has(TTS_MODEL)) return TTS_MODEL;
  const ver = n => { const m = n.match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
  try {
    const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=" +
                          encodeURIComponent(apiKey) + "&pageSize=200");
    if (r.ok) {
      const j = await r.json();
      const pool = (j.models || [])
        .map(m => m.name.replace(/^models\//, ""))
        .filter(n => /tts/i.test(n) && !/pro/i.test(n))
        .filter(n => !TTS_REJECTED.has(n));
      if (pool.length) {
        pool.sort((a, b) => ver(b) - ver(a));
        TTS_MODEL = pool[0];
        return TTS_MODEL;
      }
    }
  } catch (e) { /* fall through to the names below */ }
  const fallbacks = ["gemini-3.1-flash-tts-preview", "gemini-2.5-flash-preview-tts"];
  TTS_MODEL = fallbacks.find(n => !TTS_REJECTED.has(n)) || "gemini-2.5-flash-preview-tts";
  return TTS_MODEL;
}
/* The first eight earned their place by sounding right on short-form. The rest
   are everything else the model offers, carrying Google's own one-word descriptor
   rather than a gender I would only be guessing at. */
const TTS_VOICES = [
  { id: "Kore",          label: "Aria — warm and steady (female)", group: "Suggested" },
  { id: "Leda",          label: "Leda — bright and youthful (female)", group: "Suggested" },
  { id: "Aoede",         label: "Aoede — breezy and upbeat (female)", group: "Suggested" },
  { id: "Callirrhoe",    label: "Callie — soft and easy (female)", group: "Suggested" },
  { id: "Puck",          label: "Puck — lively and playful (male)", group: "Suggested" },
  { id: "Charon",        label: "Charon — deep and informative (male)", group: "Suggested" },
  { id: "Fenrir",        label: "Fenrir — punchy and excitable (male)", group: "Suggested" },
  { id: "Orus",          label: "Orus — firm and confident (male)", group: "Suggested" },
  { id: "Zephyr",        label: "Zephyr — bright",                 group: "More voices" },
  { id: "Autonoe",       label: "Autonoe — bright",                group: "More voices" },
  { id: "Enceladus",     label: "Enceladus — breathy",             group: "More voices" },
  { id: "Iapetus",       label: "Iapetus — clear",                 group: "More voices" },
  { id: "Erinome",       label: "Erinome — clear",                 group: "More voices" },
  { id: "Umbriel",       label: "Umbriel — easy-going",            group: "More voices" },
  { id: "Algieba",       label: "Algieba — smooth",                group: "More voices" },
  { id: "Despina",       label: "Despina — smooth",                group: "More voices" },
  { id: "Algenib",       label: "Algenib — gravelly",              group: "More voices" },
  { id: "Rasalgethi",    label: "Rasalgethi — informative",        group: "More voices" },
  { id: "Laomedeia",     label: "Laomedeia — upbeat",              group: "More voices" },
  { id: "Achernar",      label: "Achernar — soft",                 group: "More voices" },
  { id: "Alnilam",       label: "Alnilam — firm",                  group: "More voices" },
  { id: "Schedar",       label: "Schedar — even",                  group: "More voices" },
  { id: "Gacrux",        label: "Gacrux — mature",                 group: "More voices" },
  { id: "Pulcherrima",   label: "Pulcherrima — forward",           group: "More voices" },
  { id: "Achird",        label: "Achird — friendly",               group: "More voices" },
  { id: "Zubenelgenubi", label: "Zubenelgenubi — casual",          group: "More voices" },
  { id: "Vindemiatrix",  label: "Vindemiatrix — gentle",           group: "More voices" },
  { id: "Sadachbia",     label: "Sadachbia — lively",              group: "More voices" },
  { id: "Sadaltager",    label: "Sadaltager — knowledgeable",      group: "More voices" },
  { id: "Sulafat",       label: "Sulafat — warm",                  group: "More voices" },
];

/* Who is in the scene, or null when it is just the one narrator. The names are
   what the model matches against the script, so a blank or duplicated one is
   no scene at all. */
function twoSpeakers() {
  if (!$("twoVoices") || !$("twoVoices").checked) return null;
  const a = ($("spk1Name").value || "").trim();
  const b = ($("spk2Name").value || "").trim();
  if (!a || !b || a.toLowerCase() === b.toLowerCase()) return null;
  return [
    { name: a, voice: $("spk1Voice").value || "Puck" },
    { name: b, voice: $("spk2Voice").value || "Charon" }
  ];
}

/* Does the script actually give these two anything to say? */
function hasTurnsFor(text, cast) {
  const esc = n => n.replace(/[.*+?^${}()|[\]\\]/g, m => "\\" + m);
  return new RegExp("^\\s*(" + cast.map(c => esc(c.name)).join("|") + ")\\s*:", "im").test(text);
}

function setAiVoiceStatus(msg, kind) {
  const el = $("aiVoiceStatus");
  if (!el) return;
  el.className = "status" + (kind ? " " + kind : "");
  el.textContent = msg;
}

/* The model returns headerless 16-bit PCM, which no browser will decode.
   Wrap it in the 44-byte WAV header they all understand. */
function pcmToWavBlob(pcm, sampleRate) {
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const dv = new DataView(buf);
  const str = (at, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(at + i, s.charCodeAt(i)); };
  str(0, "RIFF");
  dv.setUint32(4, 36 + pcm.byteLength, true);
  str(8, "WAVE");
  str(12, "fmt ");
  dv.setUint32(16, 16, true);          // PCM chunk size
  dv.setUint16(20, 1, true);           // format: PCM
  dv.setUint16(22, 1, true);           // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);           // block align
  dv.setUint16(34, 16, true);          // bits per sample
  str(36, "data");
  dv.setUint32(40, pcm.byteLength, true);
  new Uint8Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}

async function makeVoiceFile() {
  const btn = $("btnMakeVoiceFile");
  const text = scriptEl.value.trim();
  if (!text) { setAiVoiceStatus("Paste your script in step 3 first — that's what gets spoken.", "warn"); return; }
  if (text.length > 5000) {
    setAiVoiceStatus("That script is too long to speak in one go — keep it under 5000 characters.", "warn");
    return;
  }
  const apiKey = getApiKey();
  if (!apiKey) { $("apiKeyModal").classList.add("open"); return; }

  const voice = $("aiVoice").value || "Kore";
  const style = ($("aiVoiceStyle").value || "").trim();
  const cast = twoSpeakers();

  /* The model pairs the names in speechConfig with the names in the text. A
     script with no turns would come back as one voice reading the whole thing,
     so say that now rather than after the wait and the spend. */
  if (cast && !hasTurnsFor(text, cast)) {
    setAiVoiceStatus("Two speakers are on, but the script has no lines for them. Write it as \"" +
      cast[0].name + ": ...\" and \"" + cast[1].name + ": ...\", one turn per line.", "warn");
    return;
  }

  startAiClock(btn, "Speaking your script");
  setAiVoiceStatus("");
  try {
    /* A refused model is dropped and another tried once, so a retired preview
       costs a round trip rather than the whole feature. */
    let res, model, lastMsg = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      model = await resolveTtsModel(apiKey);
      /* Same short leash on the first pick, for the same reason. Speech takes
         longer to make than a sentence of text, so the patience is larger. */
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort("timeout"), attempt === 0 ? 45000 : 120000);
      let stalled = false;
      try {
        res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: ctrl.signal,
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: style ? `${style}: ${text}` : text }] }],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: cast
                  ? { multiSpeakerVoiceConfig: { speakerVoiceConfigs: cast.map(c => ({
                      speaker: c.name,
                      voiceConfig: { prebuiltVoiceConfig: { voiceName: c.voice } }
                    })) } }
                  : { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
              }
            })
          }
        );
      } catch (netErr) {
        if (netErr && netErr.name === "AbortError" && attempt === 0) {
          TTS_REJECTED.add(model); TTS_MODEL = null; stalled = true;
        } else if (netErr && netErr.name === "AbortError") {
          throw new Error("Google didn't answer in time. Try a shorter script.");
        } else {
          throw new Error("Couldn't reach Google. Check your connection and try again.");
        }
      } finally {
        clearTimeout(timer);
      }
      if (stalled) continue;
      if (res.ok) break;

      lastMsg = (await res.json().catch(() => ({}))).error?.message || `HTTP ${res.status}`;
      const moveOn = res.status === 404 || res.status === 503 ||
                     /no longer available|not found|not supported|does not exist|high demand|overloaded|unavailable/i.test(lastMsg);
      if (moveOn && attempt === 0) { TTS_REJECTED.add(model); TTS_MODEL = null; continue; }
      throw new Error(/quota|billing/i.test(lastMsg)
        ? "Google refused the request — this key has no quota left for the voice model."
        : lastMsg);
    }
    const data = await res.json();
    const part = (data.candidates?.[0]?.content?.parts || []).find(p => p.inlineData?.data);
    if (!part) throw new Error("No sound came back. Try a shorter script, or a different narrator.");

    /* The rate rides in the mime type (audio/L16;codec=pcm;rate=24000).
       Read it rather than assuming — a wrong rate plays at the wrong pitch. */
    const rate = parseInt((part.inlineData.mimeType || "").match(/rate=(\d+)/)?.[1], 10) || 24000;
    const bin = atob(part.inlineData.data);
    const pcm = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) pcm[i] = bin.charCodeAt(i);
    const wav = pcmToWavBlob(pcm, rate);

    // Hand it over as THE voiceover, then switch to the tab that shows it,
    // so what happens next is visible rather than silently rearranged.
    useVoiceover(wav, "voice-" +
      (cast ? cast.map(c => c.name.toLowerCase()).join("-") : voice.toLowerCase()) + ".wav");
    setMode("file");
    stopAiClock(btn, "✅ Voice made", 2600);
    /* Any timing from before this voice existed was taken against a
       different reading — a tap-along, or the browser speaking at its own
       pace. Saying nothing is how captions end up drifting against a
       voiceover that sounds fine on its own. */
    const stale = S.words.some(w => w.start !== null);
    say(`Voice made — ${(wav.size / 1048576).toFixed(1)} MB, ${rate / 1000} kHz. ` +
        `It's loaded as your voiceover, so the MP4 will carry it. ` +
        (stale
          ? `Your word timings were taken against a different reading, so they no longer ` +
            `match — re-time them in step 4 before exporting, or the captions will drift.`
          : `Time it in step 4, then export — no screen sharing needed.`),
        stale ? "warn" : "ok");
  } catch (e) {
    stopAiClock(btn);
    const why = String((e && e.message) || e);
    setAiVoiceStatus(/abort|timeout/i.test(why)
      ? "Google didn't answer in time. Try a shorter script."
      : why, "warn");
  }
}

/* Writing a delivery note from scratch is the blank page that stops people
   using the field at all. These five are the reads that actually change how
   short-form lands, and the text stays editable once one is dropped in. */
const VOICE_STYLES = [
  { name: "Upbeat hook",    text: "excited and fast, like you're revealing a secret" },
  { name: "Calm explainer", text: "calm and clear, unhurried, like explaining it to a friend" },
  { name: "Urgent",         text: "urgent and intense, low and serious" },
  { name: "Storyteller",    text: "warm and unhurried, like telling a story" },
  { name: "Deadpan",        text: "flat and deadpan, completely straight-faced" },
  /* The direction does not have to hold for the whole script — the model will
     change delivery partway through if you ask it to, and a read that turns is
     what makes a hook land. Nothing in the old one-line box suggested this. */
  { name: "Hook, then tell",
    text: "say the first line as an urgent whisper, then relax and tell the rest normally" },
  { name: "Build to it",
    text: "start flat and bored, get faster and more excited with every line" },
  { name: "Land the last line",
    text: "read it briskly, then slow right down and land the final line hard" }
];

if ($("aiVoice")) {
  /* Thirty names in one flat list is a wall. The eight that suit short-form
     go on top; the rest stay one scroll away rather than hidden. */
  const groups = [];
  TTS_VOICES.forEach(v => {
    let g = groups.find(x => x.name === v.group);
    if (!g) groups.push(g = { name: v.group, items: [] });
    g.items.push(v);
  });
  $("aiVoice").innerHTML = groups.map(g =>
    `<optgroup label="${g.name}">` +
    g.items.map(v => `<option value="${v.id}">${v.label}</option>`).join("") +
    `</optgroup>`).join("");
  $("aiVoiceBox").style.display = "";
  $("btnMakeVoiceFile").addEventListener("click", makeVoiceFile);
}

/* ============================================================
   Fast track.

   Every piece of this already existed as its own button. What was missing
   was the order, and the order is the whole game: the words have to be
   spoken before they can be timed, and the timing has to be taken from
   that recording rather than from whatever else is lying around. Doing it
   by hand in the wrong order is exactly how captions end up drifting
   against a voice they were never measured against.
   ============================================================ */
/* A filename that says which topic it came from, so a batch of ten does not
   arrive as ten files with the same name and numbers bolted on. */
function topicSlug(t) {
  return String(t || "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42) || "video";
}

/* One pass of the whole job. Fast track runs it once, the batch runs it down
   a list, and both come through here — so there is only ever one order, and
   only one place it could be got wrong. */
async function runPipeline(topic, opts) {
  const report = (opts && opts.report) || function () {};

  if (topic) {
    report("Writing the script…");
    /* When two people are in the scene the script has to be written as turns,
       or the voice call gets a monologue and reads both parts in one voice. */
    const cast = twoSpeakers();
    const inLang = (opts && opts.lang)
      ? ` Write it entirely in ${opts.lang}, in that language's own script, not transliterated.`
      : "";
    const prompt = cast
      ? `Write a 30-second TikTok/Reels script about: "${topic}", as a conversation ` +
        `between two people called ${cast[0].name} and ${cast[1].name}. ` +
        `Open on a hook in the first line. Keep every turn short and spoken, and alternate them. ` +
        `Return ONLY the dialogue, one turn per line, each line exactly "Name: what they say". ` +
        `No stage directions, no markdown, no other punctuation than what is spoken.` + inLang
      : `Write a highly engaging, 30-second script for a TikTok/Reels video about: "${topic}". ` +
        `Start with a strong hook. Keep sentences short and punchy. ` +
        `Return ONLY the spoken script text, no punctuation or markdown.` + inLang;
    scriptEl.value = await callGeminiApi(prompt);
    parseScript();
  }
  if (!scriptEl.value.trim()) throw new Error("No script came back — try wording the topic differently.");

  report("Speaking it…");
  if ($("aiVoice") && opts && opts.voice) $("aiVoice").value = opts.voice;   // keep step 2 honest
  await makeVoiceFile();
  if (!S.voiceoverBlob) throw new Error("The voice was not made, so there is nothing to time against.");

  /* Whisper, on this machine, against the recording just made — the only
     audio that can possibly be the right one. */
  report("Timing every word against that recording…");
  await transcribeFromVoice();
  if (!allTimed()) {
    throw new Error("It spoke, but the words were not all timed. Open step 4 and press “⏱ Time it for me”.");
  }

  if (opts && opts.render) {
    if (!CAN_MP4) throw new Error("This browser cannot build MP4 files — save the .webm from step 5 instead.");
    if (!S.clips.length) throw new Error("There are no clips to render the captions over — add them in step 1.");
    report("Rendering the MP4…");
    /* exportMp4 names the file from S.videoName. Lend it the topic for the
       length of the render, then give the clip its name back. */
    const keep = S.videoName;
    if (opts.name) S.videoName = opts.name;
    try { await exportMp4(); } finally { S.videoName = keep; }
  }
  return S.words.length;
}

async function autoMakeVideo() {
  const btn = $("btnAutoMake");
  const set = (msg, kind) => {
    const el = $("autoStatus");
    if (el) { el.className = "status" + (kind ? " " + kind : ""); el.textContent = msg; }
  };

  const topic = ($("autoTopic").value || "").trim();
  if (!topic && !scriptEl.value.trim()) {
    set("Give it a topic, or put a script in step 3 — it needs words before it can speak.", "warn");
    return;
  }
  /* Ask once, here, rather than letting the run die halfway through. */
  if (!getApiKey()) { $("apiKeyModal").classList.add("open"); return; }

  const render = !!($("autoRender") && $("autoRender").checked);
  btn.disabled = true;
  try {
    const lang = $("autoLang") ? $("autoLang").value : "";
    const n = await runPipeline(topic, {
      report: set,
      voice: $("autoVoice").value,
      lang: lang,
      render: render,
      name: topic ? topicSlug(topic) + (lang ? "-" + lang.toLowerCase() : "") : null
    });
    if (render) {
      set(`Done — ${n} words timed, and the MP4 is in your downloads.`, "ok");
    } else {
      set(`Done — ${n} words timed to the voice you just heard. Look over step 4, then export.`, "ok");
      const five = document.getElementById("step5");
      if (five) five.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (e) {
    set(String((e && e.message) || e), "warn");
  } finally {
    btn.disabled = false;
  }
}

/* The same clips, one video per line. Sequential on purpose: every pass owns
   the script box, the voiceover and the timings, so two at once would be two
   runs fighting over one set of state. */
async function runBatch() {
  const btn = $("btnBatchRun");
  const set = (msg, kind) => {
    const el = $("batchStatus");
    if (el) { el.className = "status" + (kind ? " " + kind : ""); el.textContent = msg; }
  };

  const topics = ($("batchTopics").value || "").split(/\r?\n/)
    .map(t => t.trim()).filter(Boolean);
  if (!topics.length) { set("Put one topic on each line first.", "warn"); return; }
  if (!getApiKey()) { $("apiKeyModal").classList.add("open"); return; }
  if (!S.clips.length) {
    set("Add your clips in step 1 first — every video in the batch is cut over the same footage.", "warn");
    return;
  }

  /* Every topic, in every language that is lit. Two topics in three languages
     is six videos, and each one is a full pass of its own. */
  const langs = $("batchLangs")
    ? [...$("batchLangs").children].filter(b => b.getAttribute("aria-pressed") === "true")
        .map(b => b.dataset.lang)
    : [""];
  if (!langs.length) { set("Pick at least one language.", "warn"); return; }

  const jobs = [];
  topics.forEach(t => langs.forEach(l => jobs.push({ topic: t, lang: l })));

  btn.disabled = true;
  const failed = [];
  let made = 0;
  try {
    for (let i = 0; i < jobs.length; i++) {
      const { topic: t, lang: l } = jobs[i];
      const label = t.slice(0, 32) + (l ? " (" + l + ")" : "");
      const tag = "[" + (i + 1) + "/" + jobs.length + "] " + label + " — ";
      try {
        await runPipeline(t, {
          report: m => set(tag + m),
          voice: $("autoVoice").value,
          lang: l,
          render: true,
          name: topicSlug(t) + (l ? "-" + l.toLowerCase() : "")
        });
        made++;
      } catch (e) {
        /* One bad job should not take the other five down with it. */
        failed.push(label + " (" + String((e && e.message) || e).slice(0, 60) + ")");
      }
    }
    set(made + " of " + jobs.length + " rendered." +
        (failed.length ? " Did not finish: " + failed.join("; ")
                       : " They are all in your downloads."),
        failed.length ? "warn" : "ok");
  } finally {
    btn.disabled = false;
  }
}

if ($("btnAutoMake")) {
  /* One list of narrators, not two that can disagree. */
  if ($("autoVoice") && $("aiVoice")) $("autoVoice").innerHTML = $("aiVoice").innerHTML;
  $("btnAutoMake").addEventListener("click", autoMakeVideo);
}
if ($("batchLangs")) {
  $("batchLangs").addEventListener("click", e => {
    const b = e.target.closest("button[data-lang]");
    if (!b) return;
    b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true");
  });
}
if ($("btnBatchRun")) $("btnBatchRun").addEventListener("click", runBatch);

if ($("twoVoices")) {
  /* Both lists are built from the narrator list, so a voice cannot exist in
     one place and be missing from another. */
  ["spk1Voice", "spk2Voice"].forEach((id, i) => {
    if ($(id) && $("aiVoice")) {
      $(id).innerHTML = $("aiVoice").innerHTML;
      $(id).value = i === 0 ? "Puck" : "Charon";
    }
  });
  $("twoVoices").addEventListener("change", e => {
    $("twoVoiceRow").style.display = e.target.checked ? "" : "none";
  });
}

if ($("aiVoiceStyles")) {
  const box = $("aiVoiceStyles"), input = $("aiVoiceStyle");
  box.innerHTML = VOICE_STYLES.map(s =>
    `<button type="button" class="stylechip" aria-pressed="false" data-text="${s.text}">${s.name}</button>`).join("");
  /* Lit only while the box still holds exactly that preset, so an edited
     preset stops claiming to be one. */
  const sync = () => box.querySelectorAll(".stylechip").forEach(b =>
    b.setAttribute("aria-pressed", String(b.dataset.text === input.value.trim())));
  box.addEventListener("click", e => {
    const b = e.target.closest(".stylechip");
    if (!b) return;
    // Pressing the lit one clears it — a preset is never a one-way door.
    input.value = input.value.trim() === b.dataset.text ? "" : b.dataset.text;
    sync();
  });
  input.addEventListener("input", sync);
  sync();
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
          text: captionCase(t.word),
          start: t.start,
          end: t.end,
          key: false
        }));
        scriptEl.value = timings.map(t => captionCase(t.word)).join(" ");
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

/* The picture is squared off and shrunk before it is kept. A phone photo is
   several megabytes and the card draws it the size of a thumbnail, so storing
   the original would blow the auto-save budget for no visible gain. */
function setEndCardPic(dataUrl, name) {
  if (!dataUrl) {
    endCardImg = null;
    S.endCardPic = null;
    if ($("endCardPicName")) { $("endCardPicName").textContent = "no picture"; $("endCardPicName").classList.add("none"); }
    if ($("endCardPicClear")) $("endCardPicClear").style.display = "none";
    return;
  }
  const img = new Image();
  img.onload = () => { endCardImg = img; };
  img.src = dataUrl;
  S.endCardPic = dataUrl;
  if ($("endCardPicName")) { $("endCardPicName").textContent = name || "picture set"; $("endCardPicName").classList.remove("none"); }
  if ($("endCardPicClear")) $("endCardPicClear").style.display = "";
}

function readEndCardPic(file) {
  const fr = new FileReader();
  fr.onload = () => {
    const img = new Image();
    img.onload = () => {
      const SIDE = 320;                       // plenty for a circle a tenth of the frame high
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement("canvas");
      c.width = c.height = SIDE;
      const cx = c.getContext("2d");
      cx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2,
                   side, side, 0, 0, SIDE, SIDE);
      setEndCardPic(c.toDataURL("image/jpeg", 0.86), file.name);
      saveSessionState();
    };
    img.onerror = () => say("That image could not be read — try a JPG or PNG.", "warn");
    img.src = fr.result;
  };
  fr.onerror = () => say("That image could not be read — try a JPG or PNG.", "warn");
  fr.readAsDataURL(file);
}

if ($("endCardPic")) {
  $("endCardPic").addEventListener("change", e => {
    const f = e.target.files && e.target.files[0];
    if (f) readEndCardPic(f);
  });
}
if ($("endCardPicClear")) {
  $("endCardPicClear").addEventListener("click", () => {
    if ($("endCardPic")) $("endCardPic").value = "";
    setEndCardPic(null);
    saveSessionState();
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
      /* The words belong to the platform, so the current box is folded back in
         before the whole set is written out. */
      endCards: (stashEndCard(platform), END_CARDS),
      endCardPic: S.endCardPic || null,
      platform: platform,
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
    /* Restore every platform's wording, then let applyPlatform put the right
       one in the boxes — otherwise switching tabs would wipe what came back. */
    if (data.endCards && typeof data.endCards === "object") {
      Object.keys(data.endCards).forEach(k => {
        if (PLATFORMS[k]) END_CARDS[k] = {
          text: String(data.endCards[k].text || ""),
          handle: String(data.endCards[k].handle || "")
        };
      });
      applyPlatform(data.platform && PLATFORMS[data.platform] ? data.platform : platform);
    }
    if (data.endCardPic) setEndCardPic(data.endCardPic, "saved picture");
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


