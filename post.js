/* ============================================================
   Post Creator.

   A story goes in at the top and a finished social post comes out at the
   bottom — headline, picture, layout, and either a still or a short video
   with the headline read aloud over it.

   It shares three things with the captions tool and owns nothing else:

     account.js   who is signed in, and which way the AI is reached
     style.css    the palette, the buttons, the steps
     the meter    every AI call here is charged the same way as one there

   It deliberately does not load script.js. That file is a third of a
   megabyte of caption timing, and none of it is about drawing a square.
   The two small things worth borrowing — the server-or-key decision and
   the PCM-to-WAV header — are short enough to restate honestly rather
   than to reach across for.
   ============================================================ */

(function () {
"use strict";

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ---------- what the page is holding ---------- */

const S = {
  headlines: [],        // the four the model wrote
  picked: -1,
  image: null,          // an HTMLImageElement, once there is one
  imageName: "",
  template: "banner",
  size: "square",
  accent: "#ffd400",
  voice: null,          // { blob, url, seconds }
  music: null           // { buffer, name }
};

const SIZES = {
  square:   { w: 1080, h: 1080, label: "1:1 square",   note: "Feed" },
  portrait: { w: 1080, h: 1350, label: "4:5 portrait", note: "Feed, taller" },
  story:    { w: 1080, h: 1920, label: "9:16 story",   note: "Stories, Reels" }
};

const ACCENTS = ["#ffd400", "#dd5f77", "#5b93d6", "#5ac48a", "#f08c3a", "#efe7d9"];

const EXPORT_SCALE = 2;   // 1080 designs, 2160 files

/* ============================================================
   Reaching the model

   The same two-way decision account.js makes for the captions tool: if a
   server answered at startup it holds the key and counts the spend, and
   the browser never sees either. Otherwise the visitor brought their own
   key and it is used from here.
   ============================================================ */

function ownKey() {
  try { return localStorage.getItem("gemini_api_key") || ""; } catch (e) { return ""; }
}

function onServer() {
  return !!(window.CS && CS.ai.mode === "server");
}

/* Google blocks newer keys from older models and only says so when the
   request is made, so the name is discovered once and remembered. */
let KEY_MODEL = null;
async function pickKeyModel(key) {
  if (KEY_MODEL) return KEY_MODEL;
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?key=" +
                          encodeURIComponent(key) + "&pageSize=200");
  if (!res.ok) throw new Error("Google would not list the models for this key.");
  const names = ((await res.json()).models || [])
    .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map(m => m.name.replace(/^models\//, ""))
    .filter(n => /gemini/.test(n) && !/tts|image|embedding|vision/.test(n));
  const prefer = ["flash-latest", "2.5-flash", "2.0-flash", "flash", "pro"];
  for (const p of prefer) {
    const hit = names.find(n => n.includes(p));
    if (hit) return (KEY_MODEL = hit);
  }
  if (!names.length) throw new Error("That key has no usable text model.");
  return (KEY_MODEL = names[0]);
}

function parseJsonReply(raw) {
  const text = String(raw == null ? "" : raw).trim()
    .replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  return JSON.parse(text);
}

async function ai(prompt, schema) {
  if (onServer()) {
    if (!CS.ai.user) throw new Error("Sign in to use this — the button is in the top right.");
    const raw = await CS.serverText(prompt, schema || undefined);
    return schema ? parseJsonReply(raw) : String(raw).trim();
  }

  const key = ownKey();
  if (!key) {
    $("apiKeyModal").classList.add("open");
    throw new Error("Paste a Gemini key first — the button is in the top right.");
  }

  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }] };
  if (schema) {
    body.generationConfig = {
      responseMimeType: "application/json", responseSchema: schema, temperature: 0.4
    };
  }

  const model = await pickKeyModel(key);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let res;
  try {
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    throw new Error(e.name === "AbortError"
      ? "Google didn't answer in time. Try again."
      : "Couldn't reach Google. Check your connection.");
  } finally { clearTimeout(timer); }

  if (!res.ok) {
    /* A retired model is worth one more try under a different name rather
       than a dead button. */
    if (res.status === 404) { KEY_MODEL = null; }
    let msg = `Google said no (HTTP ${res.status}).`;
    try { const j = await res.json(); if (j.error?.message) msg = j.error.message; } catch (e) {}
    throw new Error(msg);
  }

  const out = await res.json();
  const text = (out.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
  if (!text) throw new Error("The model came back empty. Try again.");
  return schema ? parseJsonReply(text) : text;
}

/* ---------- the key modal, same behaviour as next door ---------- */

$("apiKeyBtn").addEventListener("click", () => {
  $("apiKeyInput").value = ownKey();
  $("apiKeyModal").classList.add("open");
});
$("modalCloseBtn").addEventListener("click", () => $("apiKeyModal").classList.remove("open"));
$("apiKeyModal").addEventListener("click", e => {
  if (e.target === $("apiKeyModal")) $("apiKeyModal").classList.remove("open");
});
$("apiKeySaveBtn").addEventListener("click", () => {
  const k = $("apiKeyInput").value.trim();
  try { k ? localStorage.setItem("gemini_api_key", k) : localStorage.removeItem("gemini_api_key"); } catch (e) {}
  KEY_MODEL = null;
  $("apiKeyModal").classList.remove("open");
});
$("apiKeyClearBtn").addEventListener("click", () => {
  try { localStorage.removeItem("gemini_api_key"); } catch (e) {}
  $("apiKeyInput").value = "";
  KEY_MODEL = null;
});

/* ============================================================
   Drawing

   One paint function serves the preview, the seven layout thumbnails and
   both exports. Anything that only looked right at one size would look
   wrong at the other two, so every measurement below is a fraction of the
   canvas rather than a number of pixels.
   ============================================================ */

/* *Stars* around a word turn it the accent colour — the same yellow-word
   idea the captions carry, so a post and a clip from the same story look
   like they came from the same place. */
function parseHead(str) {
  const out = [];
  String(str || "").split(/(\*[^*]+\*)/).forEach(chunk => {
    if (!chunk) return;
    const hot = chunk.startsWith("*") && chunk.endsWith("*") && chunk.length > 2;
    out.push({ text: hot ? chunk.slice(1, -1) : chunk, hot });
  });
  return out;
}

/* Words carry their own colour flag through the wrap, because a highlight
   that ended at a line break would be a highlight in the wrong place. */
function toWords(parts) {
  const words = [];
  parts.forEach(p => {
    p.text.split(/\s+/).forEach(w => {
      if (!w) return;
      /* A star ends before the question mark it belongs to, which would
         otherwise become a word of its own and wrap onto a line by itself.
         Punctuation with no letters in it joins the word in front. */
      if (words.length && !/[\p{L}\p{N}]/u.test(w)) words[words.length - 1].w += w;
      else words.push({ w: w.toUpperCase(), hot: p.hot });
    });
  });
  return words;
}

function wrap(ctx, words, maxWidth) {
  const lines = [];
  let line = [];
  const width = ws => ctx.measureText(ws.map(x => x.w).join(" ")).width;
  words.forEach(word => {
    line.push(word);
    if (line.length > 1 && width(line) > maxWidth) {
      line.pop();
      lines.push(line);
      line = [word];
    }
  });
  if (line.length) lines.push(line);
  return lines;
}

/* Fit the words into the box by shrinking the type until they do, rather
   than by trusting a size that was chosen for a different headline. */
function layoutHead(ctx, text, boxW, boxH, opts) {
  const o = opts || {};
  const words = toWords(parseHead(text));
  if (!words.length) return null;
  const lh = o.lineHeight || 1.06;
  const family = o.family || '"Anton", "Arial Narrow", Impact, sans-serif';
  let size = o.max || boxH;
  const min = o.min || 12;
  let lines = [];
  while (size > min) {
    ctx.font = `${size}px ${family}`;
    lines = wrap(ctx, words, boxW);
    if (lines.length * size * lh <= boxH && lines.every(l => ctx.measureText(l.map(x => x.w).join(" ")).width <= boxW)) break;
    size -= Math.max(1, Math.round(size * 0.04));
  }
  const font = `${size}px ${family}`;
  ctx.font = font;
  return { lines, size, font, lineHeight: size * lh, height: lines.length * size * lh };
}

/* align: "left" | "center". y is the top of the block.

   The font is set again here rather than inherited from layoutHead. A
   template that draws its kicker between measuring and drawing leaves a
   different face on the context, and the headline came out in it — which
   is a bug you see rather than read, so it is fixed at the source. */
function drawHead(ctx, laid, x, y, boxW, align, base, accent, shadow) {
  if (!laid) return;
  ctx.font = laid.font;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  laid.lines.forEach((line, i) => {
    const text = line.map(w => w.w).join(" ");
    const lineW = ctx.measureText(text).width;
    let cx = align === "center" ? x + (boxW - lineW) / 2 : x;
    const cy = y + laid.lineHeight * i + laid.size * 0.82;
    line.forEach((word, j) => {
      const piece = word.w + (j < line.length - 1 ? " " : "");
      if (shadow) {
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,.55)";
        ctx.shadowBlur = laid.size * 0.10;
        ctx.shadowOffsetY = laid.size * 0.035;
        ctx.fillStyle = word.hot ? accent : base;
        ctx.fillText(piece, cx, cy);
        ctx.restore();
      } else {
        ctx.fillStyle = word.hot ? accent : base;
        ctx.fillText(piece, cx, cy);
      }
      cx += ctx.measureText(piece).width;
    });
  });
}

/* Fill the box with the picture and crop the overflow, the way every feed
   does. Letterboxing a photo inside a post reads as a mistake. */
function cover(ctx, img, x, y, w, h, zoom) {
  const z = zoom || 1;
  const scale = Math.max(w / img.width, h / img.height) * z;
  const dw = img.width * scale, dh = img.height * scale;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

function placeholder(ctx, x, y, w, h) {
  const g = ctx.createLinearGradient(x, y, x + w, y + h);
  g.addColorStop(0, "#1a2734"); g.addColorStop(1, "#0d151d");
  ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "rgba(147,162,176,.5)";
  ctx.font = `${Math.round(h * 0.055)}px "Inter", sans-serif`;
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("your picture goes here", x + w / 2, y + h / 2);
  ctx.textAlign = "left";
}

function scrim(ctx, x, y, w, h, from, to) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, from); g.addColorStop(1, to);
  ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
}

function smallCaps(ctx, text, x, y, size, colour, align) {
  if (!text) return;
  ctx.font = `600 ${size}px "Inter", system-ui, sans-serif`;
  ctx.fillStyle = colour;
  ctx.textAlign = align || "left";
  ctx.textBaseline = "middle";
  /* Canvas has no letter-spacing on older engines, so the string carries
     its own — cheaper than measuring and placing every character. */
  ctx.fillText(text.toUpperCase().split("").join(" "), x, y);
  ctx.textAlign = "left";
}

const INK = "#0c1117";
const NAVY = "#101c2b";

/* ---------- the seven layouts ---------- */

const TEMPLATES = [
  {
    id: "banner", name: "Banner",
    draw(ctx, g) {
      const { W, H, acc } = g;
      g.picture(0, 0, W, H);
      scrim(ctx, 0, H * 0.42, W, H * 0.58, "rgba(8,12,18,0)", "rgba(8,12,18,.94)");
      const pad = W * 0.07;
      const laid = layoutHead(ctx, g.headline, W - pad * 2, H * 0.30, { max: H * 0.105 });
      const top = H * 0.86 - (laid ? laid.height : 0);
      if (g.kicker) {
        ctx.fillStyle = acc;
        ctx.fillRect(pad, top - H * 0.062, W * 0.30, H * 0.008);
        smallCaps(ctx, g.kicker, pad, top - H * 0.036, H * 0.024, acc);
      }
      drawHead(ctx, laid, pad, top, W - pad * 2, "left", "#fff", acc, true);
      smallCaps(ctx, g.footer, pad, H * 0.93, H * 0.021, "rgba(255,255,255,.62)");
    }
  },
  {
    id: "split", name: "Split block",
    draw(ctx, g) {
      const { W, H, acc } = g;
      const cut = H * 0.52;
      g.picture(0, 0, W, cut);
      ctx.fillStyle = NAVY; ctx.fillRect(0, cut, W, H - cut);
      ctx.fillStyle = acc; ctx.fillRect(0, cut, W, H * 0.009);
      const pad = W * 0.08;
      const boxTop = cut + H * 0.07;
      const boxH = H * 0.30;
      const laid = layoutHead(ctx, g.headline, W - pad * 2, boxH, { max: H * 0.095 });
      if (g.kicker) smallCaps(ctx, g.kicker, W / 2, cut + H * 0.045, H * 0.023, acc, "center");
      drawHead(ctx, laid, pad, boxTop, W - pad * 2, "center", "#fff", acc, false);
      smallCaps(ctx, g.footer, W / 2, H * 0.945, H * 0.021, "rgba(239,231,217,.5)", "center");
    }
  },
  {
    id: "poll", name: "Poll panel",
    draw(ctx, g) {
      const { W, H, acc } = g;
      const cut = H * 0.46;
      g.picture(0, 0, W, cut);
      ctx.fillStyle = NAVY; ctx.fillRect(0, cut, W, H - cut);
      const pad = W * 0.08;
      const laid = layoutHead(ctx, g.headline, W - pad * 2, H * 0.24, { max: H * 0.085 });
      drawHead(ctx, laid, pad, cut + H * 0.06, W - pad * 2, "center", "#fff", acc, false);

      /* The two buttons are the whole point of this one: it asks a question
         and shows people where the answer goes. */
      const by = H * 0.845, bh = H * 0.075, bw = W * 0.33;
      ctx.fillStyle = acc; ctx.fillRect(W * 0.5 - W * 0.001, by - bh * 0.55, W * 0.002, bh * 1.1);
      [["YES", W * 0.5 - bw - W * 0.03], ["NO", W * 0.5 + W * 0.03]].forEach(([word, bx], i) => {
        ctx.fillStyle = i === 0 ? acc : "rgba(255,255,255,.10)";
        ctx.beginPath();
        const r = bh / 2;
        ctx.roundRect ? ctx.roundRect(bx, by - bh / 2, bw, bh, r)
                      : ctx.rect(bx, by - bh / 2, bw, bh);
        ctx.fill();
        ctx.font = `${Math.round(bh * 0.46)}px "Anton", Impact, sans-serif`;
        ctx.fillStyle = i === 0 ? INK : "#fff";
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(word, bx + bw / 2, by);
        ctx.textAlign = "left";
      });
      smallCaps(ctx, g.kicker || g.footer, W / 2, cut + H * 0.028, H * 0.021, acc, "center");
    }
  },
  {
    id: "badge", name: "Badge",
    draw(ctx, g) {
      const { W, H, acc } = g;
      g.picture(0, 0, W, H);
      scrim(ctx, 0, H * 0.46, W, H * 0.54, "rgba(8,12,18,0)", "rgba(8,12,18,.96)");
      const pad = W * 0.07;
      if (g.kicker) {
        ctx.font = `600 ${Math.round(H * 0.026)}px "Inter", sans-serif`;
        const tw = ctx.measureText(g.kicker.toUpperCase().split("").join(" ")).width;
        ctx.fillStyle = acc;
        ctx.fillRect(pad, H * 0.062, tw + W * 0.055, H * 0.056);
        smallCaps(ctx, g.kicker, pad + W * 0.027, H * 0.090, H * 0.026, INK);
      }
      const laid = layoutHead(ctx, g.headline, W - pad * 2, H * 0.32, { max: H * 0.11 });
      const top = H * 0.87 - (laid ? laid.height : 0);
      drawHead(ctx, laid, pad, top, W - pad * 2, "left", "#fff", acc, true);
      ctx.fillStyle = acc;
      ctx.fillRect(pad, H * 0.905, W * 0.16, H * 0.006);
      smallCaps(ctx, g.footer, pad, H * 0.94, H * 0.021, "rgba(255,255,255,.62)");
    }
  },
  {
    id: "quote", name: "Centred",
    draw(ctx, g) {
      const { W, H, acc } = g;
      g.picture(0, 0, W, H);
      ctx.fillStyle = "rgba(8,12,18,.66)"; ctx.fillRect(0, 0, W, H);
      const pad = W * 0.10;
      const laid = layoutHead(ctx, g.headline, W - pad * 2, H * 0.42, { max: H * 0.10, lineHeight: 1.1 });
      const h = laid ? laid.height : 0;
      const top = (H - h) / 2;
      ctx.fillStyle = acc;
      ctx.fillRect(W / 2 - W * 0.09, top - H * 0.055, W * 0.18, H * 0.007);
      drawHead(ctx, laid, pad, top, W - pad * 2, "center", "#fff", acc, true);
      ctx.fillStyle = acc;
      ctx.fillRect(W / 2 - W * 0.09, top + h + H * 0.045, W * 0.18, H * 0.007);
      if (g.kicker) smallCaps(ctx, g.kicker, W / 2, H * 0.085, H * 0.023, acc, "center");
      smallCaps(ctx, g.footer, W / 2, H * 0.94, H * 0.021, "rgba(255,255,255,.6)", "center");
    }
  },
  {
    id: "side", name: "Side panel",
    draw(ctx, g) {
      const { W, H, acc } = g;
      const panel = W * 0.46;
      g.picture(panel, 0, W - panel, H);
      ctx.fillStyle = NAVY; ctx.fillRect(0, 0, panel, H);
      ctx.fillStyle = acc; ctx.fillRect(panel - W * 0.008, 0, W * 0.008, H);
      const pad = W * 0.055;
      const laid = layoutHead(ctx, g.headline, panel - pad * 2, H * 0.52, { max: H * 0.075 });
      const top = (H - (laid ? laid.height : 0)) / 2;
      if (g.kicker) smallCaps(ctx, g.kicker, pad, H * 0.09, H * 0.021, acc);
      drawHead(ctx, laid, pad, top, panel - pad * 2, "left", "#fff", acc, false);
      smallCaps(ctx, g.footer, pad, H * 0.93, H * 0.019, "rgba(239,231,217,.5)");
    }
  },
  {
    id: "ticker", name: "Ticker",
    draw(ctx, g) {
      const { W, H, acc } = g;
      g.picture(0, 0, W, H);
      const barTop = H * 0.66;
      scrim(ctx, 0, barTop - H * 0.14, W, H * 0.14, "rgba(8,12,18,0)", "rgba(8,12,18,.92)");
      ctx.fillStyle = "rgba(8,12,18,.92)"; ctx.fillRect(0, barTop, W, H - barTop);
      const pad = W * 0.07;
      const laid = layoutHead(ctx, g.headline, W - pad * 2, H * 0.20, { max: H * 0.088 });
      drawHead(ctx, laid, pad, barTop + H * 0.045, W - pad * 2, "left", "#fff", acc, false);
      /* The strip along the bottom, with the kicker sitting in it the way a
         channel bug does. */
      const sh = H * 0.062;
      ctx.fillStyle = acc; ctx.fillRect(0, H - sh, W, sh);
      smallCaps(ctx, g.kicker || "LIVE", pad, H - sh / 2, H * 0.024, INK);
      smallCaps(ctx, g.footer, W - pad, H - sh / 2, H * 0.022, "rgba(12,17,23,.72)", "right");
    }
  }
];

/* ---------- one paint, three uses ---------- */

function paint(ctx, W, H, opts) {
  const o = opts || {};
  const tpl = TEMPLATES.find(t => t.id === (o.template || S.template)) || TEMPLATES[0];
  const img = o.image !== undefined ? o.image : S.image;

  ctx.save();
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = "left";

  tpl.draw(ctx, {
    W, H,
    acc: o.accent || S.accent,
    headline: o.headline !== undefined ? o.headline : $("pcHeadline").value,
    kicker: (o.kicker !== undefined ? o.kicker : $("pcKicker").value).trim(),
    footer: (o.footer !== undefined ? o.footer : $("pcFooter").value).trim(),
    picture: (x, y, w, h) => img ? cover(ctx, img, x, y, w, h, o.zoom || 1)
                                 : placeholder(ctx, x, y, w, h)
  });

  ctx.restore();
}

/* ---------- the preview ---------- */

const previewCanvas = $("pcCanvas");
const pctx = previewCanvas.getContext("2d");

function hasSomething() {
  return !!($("pcHeadline").value.trim() || S.image);
}

function draw() {
  const { w, h } = SIZES[S.size];
  /* The preview is drawn at a third of the export so it stays cheap to
     repaint on every keystroke, and at device pixel ratio so the type does
     not go soft on a retina screen. */
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.round(w / 3 * dpr), ph = Math.round(h / 3 * dpr);
  if (previewCanvas.width !== pw || previewCanvas.height !== ph) {
    previewCanvas.width = pw; previewCanvas.height = ph;
  }
  $("pcFrame").style.setProperty("--pc-aspect", `${w} / ${h}`);
  pctx.setTransform(pw / w, 0, 0, ph / h, 0, 0);
  paint(pctx, w, h);
  pctx.setTransform(1, 0, 0, 1, 0, 0);

  const ready = hasSomething();
  $("pcEmpty").hidden = ready;
  $("pcPng").disabled = !ready;
  $("pcJpg").disabled = !ready;
  $("pcMp4").disabled = !ready || !CAN_RECORD;
}

/* Anton arrives after the first paint, and a headline measured in the
   fallback face wraps in the wrong place. Redraw once it is here. */
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { draw(); drawThumbs(); });

/* ============================================================
   The steps
   ============================================================ */

function status(id, msg, kind) {
  const el = $(id);
  el.textContent = msg || "";
  el.className = "status" + (kind ? " " + kind : "");
}

/* A button that says what it is doing and cannot be pressed twice. */
async function busy(btn, label, fn) {
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try { return await fn(); }
  finally { btn.disabled = false; btn.textContent = was; }
}

/* ---------- step 1: four headlines ---------- */

const HEADS_SCHEMA = {
  type: "OBJECT",
  properties: {
    headlines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          angle: { type: "STRING" },
          text: { type: "STRING" }
        },
        required: ["angle", "text"]
      }
    }
  },
  required: ["headlines"]
};

function headsPrompt(story, audience) {
  return `You write headlines for social media posts made from news stories.

AUDIENCE: ${audience}

THE STORY:
${story}

Write four headlines, each a different angle on the same story:
1. the plain fact, stated straight
2. the question the story makes a reader want to ask
3. what is at stake for the reader personally
4. the sharpest, most arguable line in the story

RULES
- Write in the same language as the story above. Do not translate it.
- Eight to fourteen words. Short enough to read at a glance.
- Plain words. No jargon, no "amid", no "slams", no colons.
- Wrap the two or three most important words in *stars* — they get printed
  in a highlight colour. Never star more than three words in one headline.
- No hashtags, no emoji, no quotation marks around the whole headline.
- "angle" is a two or three word label for which of the four this is,
  written in English.`;
}

$("pcWriteHeads").addEventListener("click", async e => {
  const story = $("pcStory").value.trim();
  if (story.length < 40) {
    status("pcStoryStatus", "Paste a bit more of the story — a couple of sentences is enough.", "warn");
    return;
  }
  status("pcStoryStatus", "");
  try {
    await busy(e.target, "Writing…", async () => {
      const out = await ai(headsPrompt(story, $("pcAudience").value.trim() || "General readers."),
                           HEADS_SCHEMA);
      const list = (out.headlines || []).filter(h => h && h.text).slice(0, 4);
      if (!list.length) throw new Error("Nothing came back. Try again.");
      S.headlines = list;
      S.picked = -1;
      renderHeads();
      status("pcStoryStatus", "Four angles are waiting in step 2.", "ok");
      $("pstep2").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  } catch (err) {
    status("pcStoryStatus", err.message, "warn");
  }
});

$("pcSkipHeads").addEventListener("click", () => {
  $("pstep2").scrollIntoView({ behavior: "smooth", block: "start" });
  $("pcHeadline").focus();
});

function renderHeads() {
  const host = $("pcHeadList");
  host.innerHTML = "";
  S.headlines.forEach((h, i) => {
    const b = document.createElement("button");
    b.className = "head-opt";
    b.type = "button";
    b.setAttribute("aria-pressed", String(i === S.picked));
    b.innerHTML = `<b>${esc(h.angle || "Angle " + (i + 1))}</b>${esc(h.text)}`;
    b.addEventListener("click", () => {
      S.picked = i;
      $("pcHeadline").value = h.text;
      renderHeads();
      draw(); drawThumbs();
    });
    host.appendChild(b);
  });
}

/* ---------- step 2: the words that get drawn ---------- */

["pcHeadline", "pcKicker", "pcFooter"].forEach(id => {
  $(id).addEventListener("input", () => { draw(); drawThumbs(); });
});

/* ---------- step 3: the picture ---------- */

$("pcBriefBtn").addEventListener("click", async e => {
  const head = $("pcHeadline").value.trim();
  const story = $("pcStory").value.trim();
  if (!head && !story) {
    status("pcPicStatus", "Write a headline first, or paste the story — the brief comes from one of them.", "warn");
    return;
  }
  status("pcPicStatus", "");
  try {
    await busy(e.target, "Writing the brief…", async () => {
      const text = await ai(
`Write a photo brief for a social media post.

HEADLINE: ${head || "(none yet)"}
STORY: ${story.slice(0, 1200) || "(none)"}

Describe one photograph that would sit behind that headline. Say what is in
the frame, the light, the mood and the lens. It must be a real-looking
editorial photograph, not an illustration and not a collage.

RULES
- Write it in English, whatever language the story is in — it is going to an
  image generator that only reads English.
- One paragraph, 30 to 50 words, no line breaks.
- No text, no words, no logos, no signs anywhere in the picture.
- No named real people. Describe people by role and posture instead.
- Return the brief only. No preamble, no quotes, no label.`);
      $("pcBrief").value = text.replace(/^["']|["']$/g, "");
      status("pcPicStatus", "Brief written. Edit it if you like, then generate.", "ok");
    });
  } catch (err) {
    status("pcPicStatus", err.message, "warn");
  }
});

/* The picture is fetched by our own server rather than from here.

   Two reasons, and the second is the one that would have bitten silently.
   The image service refuses a request that arrives from a browser at all.
   And even where a remote picture does load, drawing it on the canvas
   taints it, and a tainted canvas throws on the way out — so every export
   on the page would have broken the moment a generated photo was used.
   Coming back through /api/ai/image it is same-origin, and neither
   problem exists.

   The page therefore only offers this when a server is answering. On a
   static host there is nothing to proxy through, and a button that cannot
   work should say so rather than fail. */
$("pcGenPic").addEventListener("click", async e => {
  const brief = $("pcBrief").value.trim();
  if (!brief) {
    status("pcPicStatus", "There is no brief to draw from. Write one above, or type your own.", "warn");
    return;
  }
  if (!onServer()) {
    status("pcPicStatus", "Photo generation needs the hosted version. Drop your own picture in instead.", "warn");
    return;
  }
  if (!CS.ai.user) {
    status("pcPicStatus", "Sign in to generate a photo — the button is in the top right.", "warn");
    return;
  }

  const { w, h } = SIZES[S.size];
  const seed = Math.floor(Math.random() * 1e9);
  const url = "/api/ai/image?prompt=" + encodeURIComponent(brief) +
              `&w=${w}&h=${h}&seed=${seed}`;
  status("pcPicStatus", "Making the photo… this takes 15 to 40 seconds.");
  try {
    await busy(e.target, "Generating…", () => loadImage(url, "generated photo"));
    status("pcPicStatus", "Done. Press it again for a different take.", "ok");
  } catch (err) {
    status("pcPicStatus", "The image service did not answer. Try again, or drop your own picture in.", "warn");
  }
});

function loadImage(src, name) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    /* Every picture that reaches here is either a file the visitor chose
       (an object URL) or one our own server fetched, so the canvas is
       never tainted and the exports always save. Nothing remote is loaded
       straight into it, and that is deliberate rather than incidental. */
    img.onload = () => {
      S.image = img;
      S.imageName = name;
      $("pcPicName").textContent = name;
      $("pcPicName").classList.remove("none");
      $("pcPicClear").disabled = false;
      draw(); drawThumbs();
      resolve(img);
    };
    img.onerror = () => reject(new Error("That picture would not load."));
    img.src = src;
  });
}

$("pcPicFile").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  loadImage(url, file.name).catch(() => {
    status("pcPicStatus", "That file is not a picture this browser can read.", "warn");
  });
});

$("pcPicClear").addEventListener("click", () => {
  S.image = null; S.imageName = "";
  $("pcPicName").textContent = "No picture";
  $("pcPicName").classList.add("none");
  $("pcPicClear").disabled = true;
  $("pcPicFile").value = "";
  draw(); drawThumbs();
});

/* ---------- step 4: the layout picker ---------- */

function drawThumbs() {
  TEMPLATES.forEach(t => {
    const cv = document.getElementById("tpl-" + t.id);
    if (!cv) return;
    const { w, h } = SIZES[S.size];
    const tw = 240, th = Math.round(240 * h / w);
    if (cv.width !== tw || cv.height !== th) { cv.width = tw; cv.height = th; }
    const c = cv.getContext("2d");
    c.setTransform(tw / w, 0, 0, th / h, 0, 0);
    paint(c, w, h, { template: t.id });
    c.setTransform(1, 0, 0, 1, 0, 0);
  });
}

function buildTemplates() {
  const host = $("pcTemplates");
  host.innerHTML = "";
  TEMPLATES.forEach(t => {
    const b = document.createElement("button");
    b.className = "tpl";
    b.type = "button";
    b.setAttribute("aria-pressed", String(t.id === S.template));
    b.innerHTML = `<canvas id="tpl-${t.id}"></canvas><span>${esc(t.name)}</span>`;
    b.addEventListener("click", () => {
      S.template = t.id;
      [...host.children].forEach(c => c.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
      draw();
    });
    host.appendChild(b);
  });
  drawThumbs();
}

function buildAccents() {
  const host = $("pcAccents");
  host.innerHTML = "";
  ACCENTS.forEach(col => {
    const b = document.createElement("button");
    b.className = "swatch";
    b.type = "button";
    b.style.background = col;
    b.title = col;
    b.setAttribute("aria-pressed", String(col === S.accent));
    b.addEventListener("click", () => {
      S.accent = col;
      [...host.children].forEach(c => c.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
      draw(); drawThumbs();
    });
    host.appendChild(b);
  });
}

/* ---------- step 5: the size ---------- */

function buildSizes() {
  const host = $("pcSizes");
  host.innerHTML = "";
  Object.keys(SIZES).forEach(key => {
    const s = SIZES[key];
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-selected", String(key === S.size));
    b.innerHTML = `${esc(s.label)}<br><span style="opacity:.65;font-size:11px">${s.w} × ${s.h} · ${esc(s.note)}</span>`;
    b.addEventListener("click", () => {
      S.size = key;
      [...host.children].forEach(c => c.setAttribute("aria-selected", "false"));
      b.setAttribute("aria-selected", "true");
      draw(); drawThumbs();
    });
    host.appendChild(b);
  });
}

/* ============================================================
   Saving it
   ============================================================ */

function exportCanvas() {
  const { w, h } = SIZES[S.size];
  const cv = document.createElement("canvas");
  cv.width = w * EXPORT_SCALE;
  cv.height = h * EXPORT_SCALE;
  const c = cv.getContext("2d");
  c.setTransform(EXPORT_SCALE, 0, 0, EXPORT_SCALE, 0, 0);
  paint(c, w, h);
  return cv;
}

function slug() {
  const head = $("pcHeadline").value.replace(/\*/g, "").trim();
  const base = (head || "post").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return (base || "post").slice(0, 48);
}

function save(blob, ext) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${slug()}.${ext}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

function savePicture(type, quality, ext) {
  exportCanvas().toBlob(blob => {
    if (!blob) { status("pcRenderStatus", "The browser would not encode that picture.", "warn"); return; }
    save(blob, ext);
  }, type, quality);
}

$("pcPng").addEventListener("click", () => savePicture("image/png", undefined, "png"));
$("pcJpg").addEventListener("click", () => savePicture("image/jpeg", 0.92, "jpg"));

/* ============================================================
   The voiceover

   The same route, the same narrators and the same allowance as step 2 of
   the captions tool. What differs is only what gets spoken: one headline
   rather than a whole script.
   ============================================================ */

const TTS_VOICES = [
  { id: "Kore",       label: "Aria — warm and steady (female)" },
  { id: "Leda",       label: "Leda — bright and youthful (female)" },
  { id: "Aoede",      label: "Aoede — breezy and upbeat (female)" },
  { id: "Callirrhoe", label: "Callie — soft and easy (female)" },
  { id: "Puck",       label: "Puck — lively and playful (male)" },
  { id: "Charon",     label: "Charon — deep and informative (male)" },
  { id: "Fenrir",     label: "Fenrir — punchy and excitable (male)" },
  { id: "Orus",       label: "Orus — firm and confident (male)" }
];

function buildVoices() {
  const sel = $("pcVoice");
  TTS_VOICES.forEach(v => {
    const o = document.createElement("option");
    o.value = v.id; o.textContent = v.label;
    sel.appendChild(o);
  });
  sel.value = "Charon";
}

/* The model returns headerless 16-bit PCM, which no browser will decode.
   Wrap it in the 44-byte WAV header they all understand. */
function pcmToWavBlob(pcm, sampleRate) {
  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const dv = new DataView(buf);
  const str = (at, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(at + i, s.charCodeAt(i)); };
  str(0, "RIFF"); dv.setUint32(4, 36 + pcm.byteLength, true);
  str(8, "WAVE"); str(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, "data"); dv.setUint32(40, pcm.byteLength, true);
  new Uint8Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function rateFromMime(mime) {
  const m = /rate=(\d+)/.exec(mime || "");
  return m ? parseInt(m[1], 10) : 24000;
}

$("pcSpeak").addEventListener("click", async e => {
  /* The stars are a drawing instruction, not something to read out. */
  const text = $("pcHeadline").value.replace(/\*/g, "").trim();
  if (!text) { status("pcVoiceStatus", "There is no headline to read yet.", "warn"); return; }

  const server = onServer();
  if (server && !CS.ai.user) {
    status("pcVoiceStatus", "Sign in to make a voiceover — the button is in the top right.", "warn");
    return;
  }
  if (!server && !ownKey()) { $("apiKeyModal").classList.add("open"); return; }

  status("pcVoiceStatus", "");
  try {
    await busy(e.target, "Speaking…", async () => {
      const voice = $("pcVoice").value || "Charon";
      const style = $("pcVoiceStyle").value.trim();
      let b64, mime;

      if (server) {
        const out = await CS.serverSpeak({ script: text, voice, style, cast: null });
        b64 = out.audio; mime = out.mimeType;
      } else {
        const key = ownKey();
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=${encodeURIComponent(key)}`,
          { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: style ? `${style}: ${text}` : text }] }],
              generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
              }
            }) });
        if (!res.ok) throw new Error("Google would not speak that with this key.");
        const out = await res.json();
        const part = (out.candidates?.[0]?.content?.parts || []).find(p => p.inlineData?.data);
        if (!part) throw new Error("No sound came back. Try a different narrator.");
        b64 = part.inlineData.data; mime = part.inlineData.mimeType;
      }

      const blob = pcmToWavBlob(b64ToBytes(b64), rateFromMime(mime));
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
      ctx.close();

      if (S.voice) URL.revokeObjectURL(S.voice.url);
      S.voice = { blob, url: URL.createObjectURL(blob), buffer: decoded, seconds: decoded.duration };
      $("pcPlayVoice").disabled = false;
      $("pcClearVoice").disabled = false;
      status("pcVoiceStatus", `${decoded.duration.toFixed(1)} seconds — the MP4 will be that long.`, "ok");
      updateLengthLabel();
    });
  } catch (err) {
    status("pcVoiceStatus", err.message, "warn");
  }
});

$("pcPlayVoice").addEventListener("click", () => {
  if (S.voice) new Audio(S.voice.url).play();
});

$("pcClearVoice").addEventListener("click", () => {
  if (S.voice) URL.revokeObjectURL(S.voice.url);
  S.voice = null;
  $("pcPlayVoice").disabled = true;
  $("pcClearVoice").disabled = true;
  status("pcVoiceStatus", "");
  updateLengthLabel();
});

/* ---------- the music ---------- */

$("pcMusicFile").addEventListener("change", async e => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    ctx.close();
    S.music = { buffer, name: file.name };
    $("pcMusicName").textContent = `${file.name} · ${buffer.duration.toFixed(0)}s`;
    $("pcMusicName").classList.remove("none");
    $("pcMusicClear").disabled = false;
  } catch (err) {
    status("pcRenderStatus", "That audio file would not decode. Try an MP3 or a WAV.", "warn");
  }
});

$("pcMusicClear").addEventListener("click", () => {
  S.music = null;
  $("pcMusicName").textContent = "No track";
  $("pcMusicName").classList.add("none");
  $("pcMusicClear").disabled = true;
  $("pcMusicFile").value = "";
});

$("pcVolume").addEventListener("input", e => { $("pcVolumeOut").textContent = e.target.value + "%"; });
$("pcSeconds").addEventListener("input", () => updateLengthLabel());

/* A voiceover decides the length; the slider only gets a say when there
   is no voice, so a headline is never cut off mid-word. */
function clipSeconds() {
  if (S.voice) return S.voice.seconds + 0.6;
  return parseInt($("pcSeconds").value, 10);
}

function updateLengthLabel() {
  const s = clipSeconds();
  $("pcSecondsOut").textContent = S.voice ? `${s.toFixed(1)}s · from the voice` : `${s}s`;
  $("pcSeconds").disabled = !!S.voice;
}

/* ============================================================
   The MP4

   A still post with a slow push in on the picture, the headline over it,
   and whichever of voice and music exist mixed underneath. The picture
   moving is not decoration — a feed pauses on a video and scrolls past a
   photograph, and a completely static video looks like a broken one.
   ============================================================ */

const CAN_RECORD = !!(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream);

function pickMime() {
  const tries = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  return tries.find(m => MediaRecorder.isTypeSupported(m)) || "";
}

/* Cut the requested seconds out of the track, apply the volume, and taper
   the last two seconds if that box is ticked. */
function sliceMusic(buffer, seconds, volume, fade, ctx) {
  const sr = buffer.sampleRate;
  const frames = Math.min(Math.ceil(seconds * sr), buffer.length);
  const ch = Math.min(2, buffer.numberOfChannels);
  const out = ctx.createBuffer(ch, frames, sr);
  for (let c = 0; c < ch; c++) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < frames; i++) {
      let v = src[i] * volume;
      if (fade && i > frames - sr * 2) v *= Math.max(0, (frames - i) / (sr * 2));
      dst[i] = v;
    }
  }
  return out;
}

$("pcMp4").addEventListener("click", async e => {
  if (!CAN_RECORD) {
    status("pcRenderStatus", "This browser cannot record video. The PNG still works.", "warn");
    return;
  }
  const mime = pickMime();
  if (!mime) {
    status("pcRenderStatus", "This browser cannot record video. The PNG still works.", "warn");
    return;
  }

  const { w, h } = SIZES[S.size];
  const seconds = clipSeconds();
  const fps = 30;

  const cv = document.createElement("canvas");
  cv.width = w; cv.height = h;
  const c = cv.getContext("2d");

  const stream = cv.captureStream(fps);

  /* Both sounds go into one destination node, which joins the video stream
     as its audio track. Two separate tracks would be two things for the
     player to line up, and it does not. */
  let actx = null;
  const wantsSound = !!(S.voice || S.music);
  if (wantsSound) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = actx.createMediaStreamDestination();
    if (S.music) {
      const src = actx.createBufferSource();
      src.buffer = sliceMusic(S.music.buffer, seconds,
                              parseInt($("pcVolume").value, 10) / 100 * (S.voice ? 0.35 : 1),
                              $("pcFade").checked, actx);
      src.connect(dest);
      src.start();
    }
    if (S.voice) {
      const src = actx.createBufferSource();
      src.buffer = S.voice.buffer;
      src.connect(dest);
      src.start();
    }
    dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  }

  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 });
  const chunks = [];
  rec.ondataavailable = ev => { if (ev.data && ev.data.size) chunks.push(ev.data); };

  const done = new Promise(resolve => { rec.onstop = resolve; });

  await busy(e.target, "Rendering…", async () => {
    status("pcRenderStatus", "Recording…");
    rec.start();
    const started = performance.now();

    /* Driven by setTimeout rather than requestAnimationFrame. The sound is
       playing in real time whatever the page does, so the frames have to
       keep coming in real time too — and rAF stops dead the moment the tab
       goes to the background, which left the recorder running against a
       frozen picture. A timer is throttled there rather than stopped, so a
       clip made in a background tab is coarse instead of broken. The clock
       is still the wall clock, so the video and the voice stay together
       either way. */
    await new Promise(resolve => {
      function frame() {
        const t = (performance.now() - started) / 1000;
        if (t >= seconds) { resolve(); return; }
        /* Six percent over the whole clip. Enough to read as motion, not
           enough to crop anything out of the frame. */
        paint(c, w, h, { zoom: 1 + 0.06 * (t / seconds) });
        status("pcRenderStatus", `Recording… ${Math.round(t / seconds * 100)}%`);
        setTimeout(frame, 1000 / fps);
      }
      frame();
    });

    rec.stop();
    await done;
    if (actx) actx.close();

    const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
    save(new Blob(chunks, { type: mime }), ext);
    status("pcRenderStatus",
      ext === "mp4" ? "Saved as MP4."
                    : "Saved as WebM — this browser cannot record MP4. It uploads to Facebook and Instagram as it is.",
      "ok");
  });
});

/* ============================================================
   Start
   ============================================================ */

buildTemplates();
buildAccents();
buildSizes();
buildVoices();
updateLengthLabel();
draw();

/* account.js decides the AI route after its own fetch comes back, and the
   voiceover panel says different things either side of that. */
if (window.CS) CS.onAccountChange.push(() => {
  if (onServer() && !CS.ai.user) {
    status("pcVoiceStatus", "Sign in to make a voiceover.", "");
  }
});

/* The rail highlights whichever step is on screen, the same as next door. */
const rail = [...document.querySelectorAll(".steprail a")];
const spy = new IntersectionObserver(entries => {
  entries.forEach(en => {
    if (!en.isIntersecting) return;
    rail.forEach(a => a.removeAttribute("aria-current"));
    const hit = rail.find(a => a.dataset.step === en.target.id);
    if (hit) hit.setAttribute("aria-current", "step");
  });
}, { rootMargin: "-30% 0px -60% 0px" });
document.querySelectorAll(".step").forEach(s => spy.observe(s));

})();
