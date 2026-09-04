/* ============================================================
   Saved work.

   Until now a session lived in localStorage: one browser, about five
   megabytes, and gone the moment someone cleared their site data or
   opened the app on a different machine. That is the difference
   between a tool and a toy, and it is what customers ask for refunds
   over.

   What a project holds is the *edit* — the script, the word timings,
   the look, the end cards. Kilobytes. What it deliberately does not
   hold is the footage: a single clip is hundreds of megabytes, which
   is not a database row in any database, and paying to store other
   people's video is a decision to take on purpose rather than by
   accident. Clips are re-attached when a project is opened, and the
   project remembers their names so it can say which ones to find.

   Listing uses a field mask. Without one, asking for a list of twelve
   projects drags twelve full edits across the wire to display twelve
   names.
   ============================================================ */
const express = require('express');
const { store } = require('./db');
const { requireUser } = require('./auth');
const { planFor } = require('./plans');

const users = () => store.collection('users');
const projects = uid => users().doc(uid).collection('projects');

/* Firestore's ceiling is 1 MiB per document, counting field names and
   overhead. Refuse well under it, with a number the caller can act on,
   rather than letting the write fail with something cryptic. */
const MAX_DOC_BYTES = 700 * 1024;

const listShape = (id, d) => ({
  id,
  name: d.name || 'Untitled',
  updatedAt: d.updatedAt || 0,
  createdAt: d.createdAt || 0,
  words: d.words || 0,
  clips: Array.isArray(d.clipNames) ? d.clipNames : []
});

async function listProjects(uid) {
  /* Only the columns the list actually shows. */
  const snap = await projects(uid)
    .select('name', 'updatedAt', 'createdAt', 'words', 'clipNames')
    .orderBy('updatedAt', 'desc')
    .limit(200)
    .get();
  return snap.docs.map(d => listShape(d.id, d.data() || {}));
}

async function countProjects(uid) {
  const snap = await projects(uid).count().get();
  return snap.data().count;
}

async function getProject(uid, id) {
  const snap = await projects(uid).doc(id).get();
  if (!snap.exists) return null;
  const d = snap.data() || {};
  return { ...listShape(id, d), doc: d.doc || null };
}

async function saveProject(uid, id, { name, doc, words, clipNames }) {
  const now = Date.now();
  const ref = id ? projects(uid).doc(id) : projects(uid).doc();
  const body = {
    name: String(name || 'Untitled').slice(0, 120),
    doc: doc || {},
    words: words | 0,
    clipNames: Array.isArray(clipNames) ? clipNames.slice(0, 30).map(String) : [],
    updatedAt: now
  };
  if (!id) body.createdAt = now;
  await ref.set(body, { merge: true });
  return ref.id;
}

async function deleteProject(uid, id) {
  await projects(uid).doc(id).delete();
}

/* ---------- routes ---------- */

const router = express.Router();

/* A saved edit is bigger than a sign-in payload and smaller than a
   video. One megabyte of JSON in gives the 700 KB check something to
   measure rather than being rejected by the body parser first. */
router.use(express.json({ limit: '1mb' }));
router.use(requireUser);

const oops = (res, code, error) => res.status(code).json({ error });

router.get('/', async (req, res) => {
  try {
    res.json({ projects: await listProjects(req.user.id) });
  } catch (e) {
    console.error('projects list:', e);
    oops(res, 500, 'Could not read your saved work.');
  }
});

router.get('/:id', async (req, res) => {
  try {
    const p = await getProject(req.user.id, req.params.id);
    if (!p) return oops(res, 404, 'That project is not there any more.');
    res.json({ project: p });
  } catch (e) {
    console.error('projects get:', e);
    oops(res, 500, 'Could not open that project.');
  }
});

/* One handler for create and update: the only difference is whether an
   id came in, and duplicating it invites the two halves to drift. */
async function put(req, res) {
  const uid = req.user.id;
  const id = req.params.id || null;

  const size = Buffer.byteLength(JSON.stringify(req.body.doc || {}), 'utf8');
  if (size > MAX_DOC_BYTES) {
    return oops(res, 413,
      `This project is ${Math.round(size / 1024)} KB and the limit is ${Math.round(MAX_DOC_BYTES / 1024)} KB. ` +
      `Removing the end-card picture usually does it.`);
  }

  try {
    if (!id) {
      /* The cap is checked on create only. Someone at their limit must
         still be able to save the project they are working in. */
      const cap = planFor(req.user).projects;
      if (cap && (await countProjects(uid)) >= cap) {
        return oops(res, 402,
          `The ${planFor(req.user).label} plan keeps ${cap} projects. ` +
          `Delete one, or upgrade to keep more.`);
      }
    }
    const savedId = await saveProject(uid, id, req.body);
    res.json({ id: savedId, updatedAt: Date.now() });
  } catch (e) {
    console.error('projects save:', e);
    oops(res, 500, 'Could not save that project.');
  }
}

router.post('/', put);
router.put('/:id', put);

router.delete('/:id', async (req, res) => {
  try {
    await deleteProject(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('projects delete:', e);
    oops(res, 500, 'Could not delete that project.');
  }
});

module.exports = router;
module.exports.listProjects = listProjects;
module.exports.getProject = getProject;
module.exports.saveProject = saveProject;
module.exports.deleteProject = deleteProject;
module.exports.countProjects = countProjects;
module.exports.MAX_DOC_BYTES = MAX_DOC_BYTES;
