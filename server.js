/* ============================================================
   Caption Studio — the site and the service, from one process.

   Serving the page and answering its API from the same origin keeps
   the session cookie simple and means there is one thing to deploy
   rather than two. It also means GitHub Pages is no longer where this
   lives: Pages serves files and cannot run any of this.

   Nothing here is required to edit a video. The captioning, the
   timing, the rendering and every export still happen in the browser
   with no server involved. What the server adds is an account, a place
   to keep work, and an AI key that belongs to us instead of to the
   customer.
   ============================================================ */
const express = require('express');
const path = require('path');

const auth = require('./server/auth');
const aiRoutes = require('./server/ai');
const projectRoutes = require('./server/projects');
const log = require('./server/log');
const { upsertUser, usageThisMonth } = require('./server/db');
const { allowanceSummary } = require('./server/plans');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const SECURE = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1);          // Railway, Fly and Render all sit behind one
app.disable('x-powered-by');

/* The page is public; the API is not. Attaching the user to every
   request keeps that decision in one place. */
app.use(auth.withUser);
app.use(log.requests);

/* Something to point uptime checks at that does not touch Firestore, so
   a database wobble does not read as the whole service being down. */
app.get('/api/health', (req, res) => res.json({ ok: true }));

/* Where the browser sends its own crashes. Deliberately open to
   signed-out visitors — a page that breaks before sign-in is exactly
   the failure nobody would otherwise hear about. */
app.post('/api/oops', express.json({ limit: '32kb', type: () => true }), (req, res) => {
  const b = req.body || {};
  log.warn('browser: ' + String(b.message || 'unknown').slice(0, 300), {
    kind: b.kind, where: b.where, page: b.page, ua: b.ua,
    screen: b.screen, canMp4: b.canMp4,
    stack: b.stack ? String(b.stack).slice(0, 1500) : undefined,
    user: req.user ? req.user.id : null
  });
  res.status(204).end();
});

/* ---------- who am I ---------- */

app.get('/api/config', (req, res) => {
  /* The client ID is public by design — it identifies the app, it does
     not authorise anything. The page needs it to draw the button. */
  res.json({
    googleClientId: auth.CLIENT_ID,
    signInReady: auth.configured(),
    aiReady: !!process.env.GEMINI_API_KEY
  });
});

app.get('/api/me', async (req, res) => {
  if (!req.user) return res.json({ user: null });
  try {
    res.json({
      user: {
        id: req.user.id, email: req.user.email,
        name: req.user.name, picture: req.user.picture, plan: req.user.plan
      },
      allowance: allowanceSummary(req.user, await usageThisMonth(req.user.id))
    });
  } catch (e) {
    res.status(503).json({ error: 'Could not read your account just now.' });
  }
});

app.post('/api/signin', express.json({ limit: '16kb' }), async (req, res) => {
  if (!auth.configured()) {
    return res.status(503).json({ error: 'Sign-in is not configured on this server.' });
  }
  try {
    const profile = await auth.verifyGoogleIdToken(req.body.credential);
    const user = await upsertUser(profile);
    auth.setSessionCookie(res, auth.makeSession(user.id), SECURE);
    res.json({
      user: { id: user.id, email: user.email, name: user.name, picture: user.picture, plan: user.plan },
      allowance: allowanceSummary(user, await usageThisMonth(user.id))
    });
  } catch (e) {
    res.status(401).json({ error: String(e.message || e) });
  }
});

app.post('/api/signout', (req, res) => {
  auth.setSessionCookie(res, '', SECURE);
  res.json({ ok: true });
});

/* ---------- everything that costs money ---------- */
app.use('/api/ai', aiRoutes);
app.use('/api/projects', projectRoutes);

/* An unknown /api path is a bug, not a page. Saying so beats handing
   back index.html and letting the caller parse HTML as JSON. */
app.use('/api', (req, res) => res.status(404).json({ error: 'No such endpoint.' }));

/* ---------- the site ---------- */
app.use(express.static(ROOT, { index: false }));

app.get('*', (req, res) => {
  if (req.path === '/voice-match') return res.sendFile(path.join(ROOT, 'voice-match.html'));
  /* Three names for one page — AdSense and app stores each ask for a
     different one, and all three should land somewhere real. */
  if (['/legal', '/terms', '/privacy'].includes(req.path)) {
    return res.sendFile(path.join(ROOT, 'legal.html'));
  }
  res.sendFile(path.join(ROOT, 'index.html'));
});

/* Last in the chain on purpose: anything a route threw and did not catch
   arrives here instead of becoming Express's default HTML error page. */
app.use(log.errors);

/* A promise rejected with nobody listening kills the process on modern
   Node. Better to write down what it was on the way out, so the crash in
   the logs has a cause next to it rather than just a restart. */
process.on('unhandledRejection', e => log.fromException(e, { fatal: 'unhandledRejection' }));
process.on('uncaughtException', e => {
  log.fromException(e, { fatal: 'uncaughtException' });
  process.exit(1);                   // let Cloud Run start a clean instance
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Caption Studio on http://localhost:${PORT}`);
  if (!auth.configured()) {
    console.log('  sign-in: OFF  (set GOOGLE_CLIENT_ID and SESSION_SECRET)');
  } else {
    console.log('  sign-in: on');
  }
  console.log(`  AI key:  ${process.env.GEMINI_API_KEY ? 'on the server' : 'MISSING — set GEMINI_API_KEY'}`);
});
