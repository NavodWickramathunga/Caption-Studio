/* ============================================================
   The only door to Google.

   The browser used to call Gemini directly with a key the customer had
   gone and fetched themselves. That cannot be sold: nobody buys
   software and then goes to build a Google Cloud project to make it
   work. So the key moves here, where it is ours and never leaves.

   Everything Google-shaped goes through this file, which means the
   place that spends money and the place that counts it are the same
   place. They cannot drift apart, because there is only one of them.
   ============================================================ */
const express = require('express');
const { recordUsage, usageThisMonth } = require('./db');
const { requireUser } = require('./auth');
const { checkAllowance, allowanceSummary, ttsCostMicros,
        TEXT_COST_MICROS, IMAGE_COST_MICROS } = require('./plans');

const router = express.Router();
const KEY = () => process.env.GEMINI_API_KEY || '';
const base = m => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(KEY())}`;

/* ---------- choosing a model ----------
   Named models rot. gemini-2.5-flash is already closed to keys created
   after some cutoff, so a key that worked last year and one made today
   do not see the same catalogue. Ask the key what it can reach.
   The newest is also the busiest, so refusal and silence both mean
   "try the next one". */
let cache = { text: null, tts: null, at: 0 };
const rejected = new Set();

async function listModels() {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(KEY())}&pageSize=200`);
  if (!r.ok) throw new Error('Google would not list the models for this key.');
  return ((await r.json()).models || []).map(m => ({
    name: m.name.replace(/^models\//, ''),
    methods: m.supportedGenerationMethods || []
  }));
}

const ver = n => { const m = n.match(/(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };

async function pickModels() {
  if (cache.text && cache.tts && Date.now() - cache.at < 3600e3) return cache;
  const all = await listModels();

  const text = all
    .filter(m => /flash/i.test(m.name) && !/tts|image|embedding|live|vision/i.test(m.name))
    .filter(m => m.methods.includes('generateContent'))
    .map(m => m.name).filter(n => !rejected.has(n))
    .sort((a, b) => (/preview|exp/i.test(a) - /preview|exp/i.test(b))
                 || (/lite/i.test(a) - /lite/i.test(b))
                 || (ver(b) - ver(a)));

  /* Pro speech has no free tier and answers "quota exceeded" rather
     than anything useful, so it is never chosen. */
  const tts = all.map(m => m.name)
    .filter(n => /tts/i.test(n) && !/pro/i.test(n) && !rejected.has(n))
    .sort((a, b) => ver(b) - ver(a));

  cache = { text: text[0] || 'gemini-flash-latest', tts: tts[0] || 'gemini-2.5-flash-preview-tts', at: Date.now() };
  return cache;
}

/* One request, with a short leash on the first attempt. A busy model
   sometimes accepts and then never answers; waiting the full timeout
   for that is worse than asking somebody else. */
async function callGoogle(kind, body, attempt) {
  const models = await pickModels();
  const model = kind === 'tts' ? models.tts : models.text;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), attempt === 0 ? 25000 : 90000);
  try {
    const res = await fetch(base(model), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    return { res, model };
  } finally {
    clearTimeout(timer);
  }
}

async function callWithFallback(kind, body) {
  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    let res, model;
    try {
      ({ res, model } = await callGoogle(kind, body, attempt));
    } catch (e) {
      /* Aborted: treat the model as unavailable and move on. */
      if (attempt < 2) { cache.at = 0; continue; }
      throw new Error('Google did not answer in time.');
    }
    if (res.ok) return res.json();

    const err = await res.json().catch(() => ({}));
    last = (err.error && err.error.message) || `HTTP ${res.status}`;
    const moveOn = res.status === 404 || res.status === 503 ||
      /no longer available|not found|not supported|does not exist|high demand|overloaded|unavailable/i.test(last);
    if (moveOn && attempt < 2) { rejected.add(model); cache.at = 0; continue; }
    if (res.status === 429) throw new Error('Google is rate limiting us. Try again in a minute.');
    throw new Error(last);
  }
  throw new Error(last || 'No model would take the request.');
}

/* Still frames the page wants the model to look at.

   Sending pictures used to mean falling back to the customer's own Gemini
   key, which is the arrangement this whole file exists to get rid of — so a
   feature that needs to see the video was a feature only a key holder could
   use. A few small JPEGs go through here like everything else.

   Everything about them is checked rather than trusted: the type, the count
   and the size. The count and the size together are what stop a request from
   turning into an upload. */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGES = 6;
const MAX_IMAGE_B64 = 400 * 1024;      // ~300 KB of JPEG, which is a generous still

function shapeImages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_IMAGES).map(im => {
    const mimeType = String((im && im.mimeType) || '').toLowerCase();
    const data = String((im && im.data) || '');
    if (!IMAGE_TYPES.includes(mimeType)) return null;
    if (!data || data.length > MAX_IMAGE_B64) return null;
    /* Base64 and nothing else: any other character in there means this is
       not a picture, whatever the mime type claims. */
    if (data.replace(/[^A-Za-z0-9+/=]/g, '').length !== data.length) return null;
    return { inlineData: { mimeType, data } };
  }).filter(Boolean);
}

/* ---------- what the page is allowed to ask for ---------- */

router.get('/allowance', requireUser, async (req, res) => {
  try {
    res.json(allowanceSummary(req.user, await usageThisMonth(req.user.id)));
  } catch (e) {
    res.status(503).json({ error: 'Could not read your allowance just now.' });
  }
});

router.post('/text', requireUser, express.json({ limit: '4mb' }), async (req, res) => {
  const prompt = String(req.body.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'There is no prompt in that request.' });
  if (prompt.length > 8000) return res.status(400).json({ error: 'That prompt is too long.' });

  const used = await usageThisMonth(req.user.id);
  const gate = checkAllowance(req.user, used, 'text');
  if (!gate.ok) return res.status(402).json({ error: gate.reason, code: gate.code });

  const images = shapeImages(req.body.images);

  try {
    const body = { contents: [{ role: 'user', parts: [{ text: prompt }].concat(images) }] };
    if (req.body.schema) {
      body.generationConfig = { responseMimeType: 'application/json', responseSchema: req.body.schema };
    }
    const out = await callWithFallback('text', body);
    await recordUsage(req.user.id, 'text', 0,
                      TEXT_COST_MICROS + images.length * IMAGE_COST_MICROS);
    const text = (out.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    res.json({ text });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

router.post('/tts', requireUser, express.json({ limit: '256kb' }), async (req, res) => {
  const script = String(req.body.script || '').trim();
  if (!script) return res.status(400).json({ error: 'There is nothing to speak.' });

  const used = await usageThisMonth(req.user.id);
  const gate = checkAllowance(req.user, used, 'tts', script.length);
  if (!gate.ok) return res.status(402).json({ error: gate.reason, code: gate.code });

  const style = String(req.body.style || '').trim();
  const cast = Array.isArray(req.body.cast) ? req.body.cast.slice(0, 2) : null;

  const speechConfig = (cast && cast.length === 2)
    ? { multiSpeakerVoiceConfig: { speakerVoiceConfigs: cast.map(c => ({
        speaker: String(c.name || '').slice(0, 40),
        voiceConfig: { prebuiltVoiceConfig: { voiceName: String(c.voice || 'Kore').slice(0, 40) } }
      })) } }
    : { voiceConfig: { prebuiltVoiceConfig: { voiceName: String(req.body.voice || 'Kore').slice(0, 40) } } };

  try {
    const out = await callWithFallback('tts', {
      contents: [{ role: 'user', parts: [{ text: style ? `${style}: ${script}` : script }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig }
    });

    const part = (out.candidates?.[0]?.content?.parts || []).find(p => p.inlineData?.data);
    if (!part) throw new Error('No sound came back. Try a shorter script or a different narrator.');

    /* Charged on what was actually spoken, after the call succeeded — a
       failed request should never appear on someone's allowance. */
    await recordUsage(req.user.id, 'tts', script.length, ttsCostMicros(script.length));

    res.json({
      audio: part.inlineData.data,                 // base64 PCM, as Google returns it
      mimeType: part.inlineData.mimeType || 'audio/L16;rate=24000',
      allowance: allowanceSummary(req.user, await usageThisMonth(req.user.id))
    });
  } catch (e) {
    res.status(502).json({ error: String(e.message || e) });
  }
});

/* ---------- the picture behind a post ----------

   Pollinations makes the image and asks for nothing in return, but it
   refuses a request that arrives from a browser — the Post Creator got a
   403 calling it directly, and that is not something a header on our side
   can argue with. Asked from here it answers normally.

   Fetching it here rather than in the page buys a second thing that
   matters more than the first: the picture comes back on our own origin,
   so drawing it on the canvas does not taint it and the PNG and the MP4
   still save. A remote image would have poisoned every export on the page.

   It is free, so it does not touch the allowance. What it does have is a
   short cooldown, because a route that fetches an arbitrary URL-shaped
   prompt for anyone who asks is an open proxy if you let it be one. */

const IMAGE_COOLDOWN_MS = 4000;
const lastImageAt = new Map();

router.get('/image', requireUser, async (req, res) => {
  const prompt = String(req.query.prompt || '').trim();
  if (!prompt) return res.status(400).json({ error: 'There is no brief to draw from.' });
  if (prompt.length > 1200) return res.status(400).json({ error: 'That brief is too long.' });

  const now = Date.now();
  const last = lastImageAt.get(req.user.id) || 0;
  if (now - last < IMAGE_COOLDOWN_MS) {
    return res.status(429).json({ error: 'One picture at a time — try again in a moment.' });
  }
  lastImageAt.set(req.user.id, now);

  /* Clamped, because the size decides how long the other end takes and an
     unbounded number here is someone else's bill in wall-clock time. */
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, parseInt(v, 10) || lo));
  const w = clamp(req.query.w, 512, 1440);
  const h = clamp(req.query.h, 512, 2048);
  const seed = clamp(req.query.seed, 1, 999999999);

  const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) +
              `?width=${w}&height=${h}&model=flux&nologo=true&seed=${seed}`;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 75000);
  try {
    const upstream = await fetch(url, { signal: ctl.signal });
    if (!upstream.ok) {
      return res.status(502).json({ error: 'The image service is busy. Try again in a minute.' });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.set('Content-Type', upstream.headers.get('content-type') || 'image/jpeg');
    /* Same prompt and same seed is the same picture, so it is worth keeping.
       A new seed is what "try again" sends. */
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(buf);
  } catch (e) {
    res.status(504).json({
      error: e.name === 'AbortError'
        ? 'The image service took too long. Try again, or use your own picture.'
        : 'Could not reach the image service.'
    });
  } finally {
    clearTimeout(timer);
    /* The cooldown starts when the picture arrives, not when it was asked
       for, or a slow one would leave the next press blocked for no reason. */
    lastImageAt.set(req.user.id, Date.now());
  }
});

module.exports = router;
