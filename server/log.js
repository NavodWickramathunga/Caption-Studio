/* ============================================================
   Finding out it broke before the customer tells you.

   Cloud Run collects whatever the process writes to stdout, so there is
   no service to sign up for and nothing to install — but it only
   understands the lines that arrive as JSON with a severity on them.
   A bare console.log lands as undifferentiated text and cannot be
   filtered, which is the same as not having it when something is
   actually on fire at two in the morning.

   So everything goes out as one JSON object per line, in the shape
   Cloud Logging already knows how to read.
   ============================================================ */

/* Anything that might carry a key, a token or a cookie gets replaced
   rather than logged. A log that quietly captures credentials is worse
   than no log, because it looks safe. */
const SECRET_ISH = /(key|token|secret|password|credential|cookie|authorization)/i;

function scrub(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (typeof value === 'string') {
    /* Google keys and long opaque strings, wherever they turn up. */
    return value
      .replace(/AIza[0-9A-Za-z\-_]{20,}/g, '[key]')
      .replace(/AQ\.[0-9A-Za-z\-_]{20,}/g, '[key]')
      .replace(/eyJ[0-9A-Za-z\-_]{20,}\.[0-9A-Za-z\-_.]+/g, '[token]');
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(v => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_ISH.test(k) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

function write(severity, message, fields) {
  const entry = Object.assign(
    { severity, message: String(message).slice(0, 2000), time: new Date().toISOString() },
    scrub(fields || {})
  );
  try {
    process.stdout.write(JSON.stringify(entry) + '\n');
  } catch (e) {
    /* Logging must never be the thing that takes the request down. */
    process.stdout.write(JSON.stringify({ severity: 'ERROR', message: 'log write failed' }) + '\n');
  }
}

const info  = (msg, f) => write('INFO', msg, f);
const warn  = (msg, f) => write('WARNING', msg, f);
const error = (msg, f) => write('ERROR', msg, f);

/* An error carries a stack; a string does not. Take whichever is there. */
function fromException(e, fields) {
  error((e && e.message) || String(e), Object.assign({
    stack: e && e.stack ? String(e.stack).split('\n').slice(0, 12).join('\n') : undefined
  }, fields));
}

/* One line per request, so latency and status are answerable without
   adding a metrics product. Health checks are skipped: they are the
   majority of traffic on an idle service and say nothing. */
function requests(req, res, next) {
  if (req.path === '/api/health') return next();
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    const severity = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARNING' : 'INFO';
    /* A 402 is the quota working as designed, not a fault. */
    if (res.statusCode === 402) return write('INFO', 'allowance refused', { path: req.path, ms });
    if (severity === 'INFO' && !req.path.startsWith('/api/')) return;   // static files are noise
    write(severity, `${req.method} ${req.path} ${res.statusCode}`, {
      status: res.statusCode, ms, user: req.user ? req.user.id : null
    });
  });
  next();
}

/* The last stop. Without this an unhandled throw inside a route becomes
   Express's default HTML error page — a 500 the customer cannot read and
   you never hear about. */
function errors(err, req, res, next) {
  fromException(err, { path: req.path, method: req.method, user: req.user ? req.user.id : null });
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong at our end. It has been logged.' });
}

module.exports = { info, warn, error, fromException, requests, errors, scrub };
