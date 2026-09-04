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

app.get('/api/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({
    user: {
      id: req.user.id, email: req.user.email,
      name: req.user.name, picture: req.user.picture, plan: req.user.plan
    },
    allowance: allowanceSummary(req.user, usageThisMonth(req.user.id))
  });
});

app.post('/api/signin', express.json({ limit: '16kb' }), async (req, res) => {
  if (!auth.configured()) {
    return res.status(503).json({ error: 'Sign-in is not configured on this server.' });
  }
  try {
    const profile = await auth.verifyGoogleIdToken(req.body.credential);
    const user = upsertUser(profile);
    auth.setSessionCookie(res, auth.makeSession(user.id), SECURE);
    res.json({
      user: { id: user.id, email: user.email, name: user.name, picture: user.picture, plan: user.plan },
      allowance: allowanceSummary(user, usageThisMonth(user.id))
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

/* An unknown /api path is a bug, not a page. Saying so beats handing
   back index.html and letting the caller parse HTML as JSON. */
app.use('/api', (req, res) => res.status(404).json({ error: 'No such endpoint.' }));

/* ---------- the site ---------- */
app.use(express.static(ROOT, { index: false }));

app.get('*', (req, res) => {
  if (req.path === '/voice-match') return res.sendFile(path.join(ROOT, 'voice-match.html'));
  res.sendFile(path.join(ROOT, 'index.html'));
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
