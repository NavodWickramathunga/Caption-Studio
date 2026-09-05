/* ============================================================
   The account, the meter, and the ads.

   Kept out of script.js on purpose. Everything here is about who is
   paying; nothing here knows how a caption is timed or a frame is
   drawn. script.js asks this file two questions — am I on the server,
   and who is signed in — and is otherwise untouched by it.

   Two ways to reach Google, decided once at startup:

     server  an account is signed in and the key belongs to us
     key     no server answered, so the visitor brings their own key

   The second is not legacy. GitHub Pages serves files and cannot run
   an API, so the published site keeps working exactly as it did while
   the hosted product runs the same source with a server behind it.
   ============================================================ */
window.CS = window.CS || {};

CS.ai = {
  mode: "key",        // "server" once a server answers with a key of its own
  signInReady: false,
  clientId: "",
  user: null,
  allowance: null
};

CS.onAccountChange = [];                 // script.js pushes redraws in here

function csEmit() {
  CS.onAccountChange.forEach(fn => { try { fn(CS.ai); } catch (e) {} });
}

async function csJSON(url, opts) {
  const res = await fetch(url, Object.assign({ credentials: "same-origin" }, opts || {}));
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.code = body.code;
    err.status = res.status;
    throw err;
  }
  return body;
}

/* ---------- startup ---------- */

async function csInit() {
  try {
    /* A static host answers this with index.html, not JSON, so a parse
       failure here is the signal to stay on the visitor's own key. */
    const cfg = await csJSON("/api/config");
    if (cfg && cfg.aiReady) {
      CS.ai.mode = "server";
      CS.ai.signInReady = !!cfg.signInReady;
      CS.ai.clientId = cfg.googleClientId || "";
      const me = await csJSON("/api/me");
      CS.ai.user = me.user || null;
      CS.ai.allowance = me.allowance || null;
    }
  } catch (e) {
    CS.ai.mode = "key";
  }
  csRender();
  csEmit();
  if (CS.ai.mode === "server" && CS.ai.signInReady && !CS.ai.user) csLoadGoogle();
}

/* ---------- Google's button ---------- */

function csLoadGoogle() {
  if (document.getElementById("gsiScript")) return;
  const s = document.createElement("script");
  s.id = "gsiScript";
  s.src = "https://accounts.google.com/gsi/client";
  s.async = true;
  s.defer = true;
  s.onload = () => {
    if (!window.google || !google.accounts || !google.accounts.id) return;
    google.accounts.id.initialize({
      client_id: CS.ai.clientId,
      callback: csOnCredential
    });
    const host = document.getElementById("gsiButton");
    if (host) {
      google.accounts.id.renderButton(host, {
        theme: "filled_black", size: "medium", text: "signin_with", shape: "pill"
      });
    }
  };
  s.onerror = () => csStatus("Google's sign-in script did not load. Check your connection.", true);
  document.head.appendChild(s);
}

async function csOnCredential(response) {
  try {
    const out = await csJSON("/api/signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: response.credential })
    });
    CS.ai.user = out.user;
    CS.ai.allowance = out.allowance;
    csRender();
    csEmit();
  } catch (e) {
    csStatus(e.message, true);
  }
}

async function csSignOut() {
  try { await csJSON("/api/signout", { method: "POST" }); } catch (e) {}
  if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect();
  CS.ai.user = null;
  CS.ai.allowance = null;
  csRender();
  csEmit();
  csLoadGoogle();
}

/* ---------- the two calls that cost money ---------- */

CS.serverText = async function (prompt, schema) {
  const out = await csJSON("/api/ai/text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, schema })
  });
  return out.text;
};

CS.serverSpeak = async function (payload) {
  const out = await csJSON("/api/ai/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  /* The meter moves on every voiceover, so the answer carries the new
     figures rather than making the page ask again. */
  if (out.allowance) { CS.ai.allowance = out.allowance; csRender(); }
  return out;
};

/* ---------- what it looks like ---------- */

function csStatus(msg, bad) {
  const el = document.getElementById("acctStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.className = "acct-status" + (bad ? " bad" : "");
}

function csRender() {
  const box = document.getElementById("acctBox");
  if (!box) return;
  const { mode, user, allowance, signInReady } = CS.ai;

  /* Nobody should be asked for a key the server already has. */
  const keyBtn = document.getElementById("apiKeyBtn");
  if (keyBtn) keyBtn.style.display = mode === "server" ? "none" : "";

  if (mode === "key") {
    box.innerHTML = `<span class="acct-note">Using your own Gemini key</span>`;
    csAds(false);
    return;
  }

  if (!user) {
    box.innerHTML = signInReady
      ? `<span class="acct-note">Sign in to make voiceovers</span><span id="gsiButton"></span>`
      : `<span class="acct-note">Sign-in is not configured on this server</span>`;
    /* A visitor who has not signed in is still a visitor, and advertising is
       currently the only thing paying for any of this — so the slot runs for
       them too. It stops only for a plan that has bought its way out of it. */
    csAds(true);
    /* renderButton needs the element to exist, so it runs after this. */
    if (signInReady && window.google && google.accounts && google.accounts.id) {
      google.accounts.id.renderButton(document.getElementById("gsiButton"),
        { theme: "filled_black", size: "medium", text: "signin_with", shape: "pill" });
    }
    return;
  }

  const a = allowance || {};

  /* No plan badge and no meter while the only revenue is advertising.
     Naming a tier "Free" tells people there is a paid one and invites the
     question of what it costs, which there is no answer to yet; a counter
     ticking down reads as a trial running out. The monthly ceiling is still
     enforced on the server — it has to be, because speech costs real money
     and ads recover only a fraction of it — but it is a wallet guard, not a
     sales pitch, so it stays out of sight until the user actually reaches
     it and the refusal explains itself. */
  box.innerHTML = `
    <div class="acct">
      ${user.picture ? `<img class="acct-pic" src="${user.picture}" alt="">` : ""}
      <div class="acct-who">
        <b>${csEsc(user.name || user.email)}</b>
      </div>
      <button id="acctOut" class="ghost">Sign out</button>
    </div>
    <div class="acct-status" id="acctStatus"></div>`;
  const out = document.getElementById("acctOut");
  if (out) out.addEventListener("click", csSignOut);

  csAds(!!a.ads);
}

function csEsc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- ads ----------
   Shown to the free plan and to nobody else, which is the whole reason
   to upgrade. The slot and the switching are built; the AdSense snippet
   is not pasted in, because the account has to be approved first and a
   script that renders nothing is worse than an empty box that says why.
   When approval lands, put the <ins class="adsbygoogle"> block inside
   #adSlot and call adsbygoogle.push({}) from csAds. */
function csAds(show) {
  const rail = document.getElementById("adRail");
  if (!rail) return;
  rail.hidden = !show;
}

document.addEventListener("DOMContentLoaded", csInit);
