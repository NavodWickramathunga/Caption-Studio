/* ============================================================
   When it breaks in someone else's browser.

   A crash in a customer's tab currently reaches nobody. They see a
   button that does nothing, and the most you ever hear is "it didn't
   work" — with no browser, no clip size and no idea which line gave up.

   This catches what the page throws and posts it once. Deliberately
   small: no third-party script, nothing to sign up for, no cookie of
   its own. It sends what a developer needs and nothing that identifies
   anyone beyond the account already signed in.
   ============================================================ */
(function () {
  var SENT = 0, MAX = 5;          // a render loop can throw sixty times a second
  var seen = {};

  function report(kind, message, extra) {
    /* Same fault twice is the same bug. Sending it a hundred times only
       costs money and buries the other ones. */
    var fingerprint = kind + '|' + String(message).slice(0, 120);
    if (seen[fingerprint] || SENT >= MAX) return;
    seen[fingerprint] = true;
    SENT++;

    var body = {
      kind: kind,
      message: String(message || '').slice(0, 500),
      stack: extra && extra.stack ? String(extra.stack).slice(0, 1500) : undefined,
      where: extra && extra.where,
      page: location.pathname,
      ua: navigator.userAgent.slice(0, 200),
      screen: (window.innerWidth || 0) + 'x' + (window.innerHeight || 0),
      /* What the app can do here decides half the bug reports: an export
         that fails on a machine with no VideoEncoder is not a bug. */
      canMp4: !!(window.VideoEncoder && window.AudioEncoder)
    };

    try {
      /* sendBeacon survives the page being closed, which is exactly when
         the interesting failures happen. */
      var blob = new Blob([JSON.stringify(body)], { type: 'application/json' });
      if (!navigator.sendBeacon || !navigator.sendBeacon('/api/oops', blob)) {
        fetch('/api/oops', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          keepalive: true
        }).catch(function () {});
      }
    } catch (e) { /* never let the reporter be the thing that breaks */ }
  }

  window.addEventListener('error', function (e) {
    if (!e) return;
    report('error', e.message, {
      stack: e.error && e.error.stack,
      where: (e.filename || '') + ':' + (e.lineno || 0)
    });
  });

  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    report('unhandled-promise', (r && r.message) || String(r), { stack: r && r.stack });
  });

  /* Let the app hand over failures it caught itself and turned into a
     polite message — those are invisible otherwise, and they are the
     ones customers actually complain about. */
  window.CS = window.CS || {};
  window.CS.reportProblem = function (message, where) {
    report('handled', message, { where: where });
  };
})();
