/* ============================================================
   Who is asking.

   Sign-in is Google's, verified here rather than trusted from the
   browser. The page asks Google for an ID token; this checks the
   signature against Google's published keys, checks it was issued for
   us and has not expired, and only then believes the name on it.

   Deliberately the token-only flow, not the redirect one: it needs a
   client ID, which is public, and no client secret at all. One less
   secret to leak, and no callback URL to keep in step across
   localhost, staging and production.

   After that we mint our own session cookie so the rest of the app
   never has to talk to Google again.
   ============================================================ */
const crypto = require('crypto');
const { upsertUser, getUser } = require('./db');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const COOKIE = 'cs_session';
const SESSION_DAYS = 30;

/* Google rotates its signing keys, so they are fetched and cached
   rather than pinned. An hour is well inside the rotation period. */
let jwks = { keys: [], fetchedAt: 0 };
async function googleKeys() {
  if (jwks.keys.length && Date.now() - jwks.fetchedAt < 3600e3) return jwks.keys;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs');
  if (!res.ok) throw new Error('Could not reach Google to check the sign-in.');
  const body = await res.json();
  jwks = { keys: body.keys || [], fetchedAt: Date.now() };
  return jwks.keys;
}

const b64urlToBuf = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

async function verifyGoogleIdToken(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('That sign-in token is malformed.');

  const header = JSON.parse(b64urlToBuf(parts[0]).toString('utf8'));
  const payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));

  const key = (await googleKeys()).find(k => k.kid === header.kid);
  if (!key) throw new Error('That sign-in was signed with a key Google does not publish.');

  const ok = crypto.verify(
    'RSA-SHA256',
    Buffer.from(parts[0] + '.' + parts[1]),
    crypto.createPublicKey({ key, format: 'jwk' }),
    b64urlToBuf(parts[2])
  );
  if (!ok) throw new Error('That sign-in token failed its signature check.');

  /* Signature alone is not enough: a valid token issued for somebody
     else's app would sail through it. */
  const iss = payload.iss || '';
  if (iss !== 'accounts.google.com' && iss !== 'https://accounts.google.com') {
    throw new Error('That sign-in did not come from Google.');
  }
  if (!CLIENT_ID || payload.aud !== CLIENT_ID) {
    throw new Error('That sign-in was issued for a different application.');
  }
  if (!payload.exp || payload.exp * 1000 < Date.now()) {
    throw new Error('That sign-in has expired — try again.');
  }
  if (payload.email_verified === false) {
    throw new Error('That Google account has an unverified email address.');
  }

  return {
    id: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture
  };
}

/* ---------- our own session ---------- */

function sign(data) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
}

function makeSession(userId) {
  const body = Buffer.from(JSON.stringify({
    u: userId,
    e: Date.now() + SESSION_DAYS * 864e5
  })).toString('base64url');
  return body + '.' + sign(body);
}

function readSession(cookie) {
  if (!cookie || !SESSION_SECRET) return null;
  const [body, mac] = String(cookie).split('.');
  if (!body || !mac) return null;
  const expected = sign(body);
  /* Fixed-time compare: a plain === leaks how much of the signature
     was right, one byte at a time. */
  const a = Buffer.from(mac), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const { u, e } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!u || !e || e < Date.now()) return null;
    return u;
  } catch { return null; }
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, value, secure) {
  const bits = [
    `${COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',                       // script.js must never be able to read it
    'SameSite=Lax',
    `Max-Age=${value ? SESSION_DAYS * 86400 : 0}`
  ];
  if (secure) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

/* Attaches req.user when there is one. Never rejects — routes that
   require a user say so themselves, so a public route stays public.
   A lookup that fails is treated as "nobody": the page is public, and
   a database wobble should not turn it into a 500. */
async function withUser(req, res, next) {
  const id = readSession(parseCookies(req)[COOKIE]);
  try {
    req.user = id ? await getUser(id) : null;
  } catch (e) {
    console.error('user lookup failed:', e.message);
    req.user = null;
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Sign in to use this.', code: 'signin_required' });
  }
  next();
}

const configured = () => !!(CLIENT_ID && SESSION_SECRET);

module.exports = {
  CLIENT_ID, COOKIE, configured,
  verifyGoogleIdToken, upsertUser,
  makeSession, setSessionCookie, withUser, requireUser
};
