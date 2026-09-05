/* ============================================================
   Brand kits.

   A project is one video. A kit is the part that should be identical
   across every video you ever make: the caption colours, the
   animation, how many words sit on screen, the narrator and how they
   read, the end card wording for each platform, and the logo.

   Rebuilding that by hand each time is where an account's videos stop
   looking like they came from the same account, which for anyone
   posting regularly is the whole point.

   Kits are small and few, so unlike projects there is no field mask
   here — a list of five kits is cheaper to fetch whole than to fetch
   twice. The one thing that can be large is the profile picture, which
   arrives already squared and shrunk to 320px by the browser.
   ============================================================ */
const express = require('express');
const { store } = require('./db');
const { requireUser } = require('./auth');

const router = express.Router();
const kits = uid => store.collection('users').doc(uid).collection('kits');

/* Well under Firestore's 1 MiB ceiling. A 320px JPEG is about 7 KB, so
   this is generous unless something has gone wrong. */
const MAX_DOC_BYTES = 400 * 1024;
const MAX_KITS = 25;

const clean = s => String(s == null ? '' : s).slice(0, 400);

/* Only these fields are stored. An allow-list rather than "whatever the
   browser sent" — otherwise the shape of a kit becomes whatever some
   future version of the page happens to put in the object, and a
   document grows fields nobody meant to keep. */
function shapeKit(body) {
  const b = body || {};
  const look = b.look || {};
  const voice = b.voice || {};
  const cards = b.endCards || {};

  const kit = {
    name: clean(b.name) || 'Untitled kit',
    look: {
      animStyle: clean(look.animStyle),
      hlColor: clean(look.hlColor),
      keyColor: clean(look.keyColor),
      emphasise: !!look.emphasise,
      wps: Number(look.wps) || 3,
      sizePct: Number(look.sizePct) || 8.5,
      posPct: Number(look.posPct) || 72,
      quality: clean(look.quality)
    },
    voice: {
      narrator: clean(voice.narrator),
      style: clean(voice.style),
      twoVoices: !!voice.twoVoices,
      speakerOne: clean(voice.speakerOne),
      speakerTwo: clean(voice.speakerTwo),
      voiceOne: clean(voice.voiceOne),
      voiceTwo: clean(voice.voiceTwo),
      language: clean(voice.language)
    },
    endCards: {},
    endCardSecs: Number(b.endCardSecs) || 1.2,
    picture: typeof b.picture === 'string' && b.picture.startsWith('data:image/')
      ? b.picture.slice(0, 300 * 1024)
      : null,
    updatedAt: Date.now()
  };

  /* One set of words per platform, because you do not subscribe to a
     Facebook page and you do not follow a YouTube channel. */
  for (const key of ['facebook', 'youtube', 'tiktok']) {
    const c = cards[key] || {};
    kit.endCards[key] = { text: clean(c.text), handle: clean(c.handle) };
  }
  return kit;
}

const tooBig = obj => Buffer.byteLength(JSON.stringify(obj), 'utf8') > MAX_DOC_BYTES;

router.get('/', requireUser, async (req, res) => {
  try {
    const snap = await kits(req.user.id).orderBy('updatedAt', 'desc').limit(MAX_KITS).get();
    res.json({ kits: snap.docs.map(d => Object.assign({ id: d.id }, d.data())) });
  } catch (e) {
    res.status(503).json({ error: 'Could not read your kits just now.' });
  }
});

async function save(req, res) {
  const kit = shapeKit(req.body);
  if (tooBig(kit)) {
    return res.status(413).json({ error: 'That kit is too large — try a smaller profile picture.' });
  }
  try {
    const col = kits(req.user.id);

    if (req.params.id) {
      await col.doc(req.params.id).set(kit, { merge: true });
      return res.json(Object.assign({ id: req.params.id }, kit));
    }

    /* A cap that exists to stop a runaway loop filling the database,
       not to sell anything — so the number is high and the message
       says what to do rather than what to buy. */
    const count = (await col.count().get()).data().count;
    if (count >= MAX_KITS) {
      return res.status(409).json({
        error: `That is ${MAX_KITS} kits, which is as many as one account keeps. Delete one you no longer use.`
      });
    }
    const ref = await col.add(Object.assign({ createdAt: Date.now() }, kit));
    res.json(Object.assign({ id: ref.id }, kit));
  } catch (e) {
    res.status(503).json({ error: 'Could not save that kit just now.' });
  }
}

router.post('/', requireUser, express.json({ limit: '1mb' }), save);
router.put('/:id', requireUser, express.json({ limit: '1mb' }), save);

router.delete('/:id', requireUser, async (req, res) => {
  try {
    await kits(req.user.id).doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (e) {
    res.status(503).json({ error: 'Could not delete that kit just now.' });
  }
});

module.exports = router;
