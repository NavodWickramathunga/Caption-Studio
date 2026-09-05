/* ============================================================
   Brand kits, in the page.

   Reads the current look out of the controls and writes a saved one
   back into them. Everything here goes through the same inputs a person
   would use and then fires the events those inputs already listen for,
   rather than reaching into script.js and setting state directly —
   which means applying a kit takes exactly the same path as changing a
   setting by hand, and cannot drift away from it.
   ============================================================ */
window.CS = window.CS || {};

(function () {
  const $ = id => document.getElementById(id);
  const val = (id, fallback) => ($(id) ? $(id).value : fallback);
  const checked = id => !!($(id) && $(id).checked);

  /* Setting .value alone updates the box and nothing else — the page
     only reacts to events. */
  function put(id, value, event) {
    const el = $(id);
    if (!el || value == null || value === '') return;
    el.value = value;
    el.dispatchEvent(new Event(event || 'change', { bubbles: true }));
  }

  function putChecked(id, on) {
    const el = $(id);
    if (!el) return;
    el.checked = !!on;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ---------- reading the current look ---------- */

  CS.readKit = function (name) {
    /* The end card wording is per platform and only one platform's is in
       the boxes at a time, so ask the page for the whole set. */
    const cards = (window.CS.allEndCards && window.CS.allEndCards()) || {};
    return {
      name: name,
      look: {
        animStyle: val('captionAnimStyle'),
        hlColor: val('customHlColor'),
        keyColor: window.CS.currentKeyColor ? window.CS.currentKeyColor() : '',
        emphasise: checked('emphasise'),
        wps: Number(val('wps', 3)),
        sizePct: window.CS.currentSizePct ? window.CS.currentSizePct() : 8.5,
        posPct: window.CS.currentPosPct ? window.CS.currentPosPct() : 72,
        quality: val('outQuality')
      },
      voice: {
        narrator: val('aiVoice'),
        style: val('aiVoiceStyle'),
        twoVoices: checked('twoVoices'),
        speakerOne: val('spk1Name'),
        speakerTwo: val('spk2Name'),
        voiceOne: val('spk1Voice'),
        voiceTwo: val('spk2Voice'),
        language: val('autoLang')
      },
      endCards: cards,
      endCardSecs: Number(val('endCardSecs', 1.2)),
      picture: window.CS.currentPicture ? window.CS.currentPicture() : null
    };
  };

  /* ---------- putting a saved one back ---------- */

  CS.applyKit = function (kit) {
    if (!kit) return;
    const look = kit.look || {}, voice = kit.voice || {};

    put('captionAnimStyle', look.animStyle);
    put('customHlColor', look.hlColor, 'input');
    put('wps', look.wps, 'input');
    put('outQuality', look.quality);
    putChecked('emphasise', look.emphasise);

    put('aiVoice', voice.narrator);
    put('aiVoiceStyle', voice.style, 'input');
    put('autoLang', voice.language);
    put('autoVoice', voice.narrator);

    /* The two-speaker row has to be revealed before the names inside it
       can be set, and revealing it is what the change event does. */
    putChecked('twoVoices', voice.twoVoices);
    put('spk1Name', voice.speakerOne, 'input');
    put('spk2Name', voice.speakerTwo, 'input');
    put('spk1Voice', voice.voiceOne);
    put('spk2Voice', voice.voiceTwo);

    put('endCardSecs', kit.endCardSecs, 'input');

    if (window.CS.setAllEndCards) window.CS.setAllEndCards(kit.endCards || {});
    if (window.CS.setPicture) window.CS.setPicture(kit.picture || null);

    /* Sliders and colours that script.js owns need it to recompute. */
    if (window.CS.afterKitApplied) window.CS.afterKitApplied(look);
  };

  /* ---------- talking to the server ---------- */

  const api = async (path, opts) => {
    const res = await fetch('/api/kits' + path,
      Object.assign({ credentials: 'same-origin' }, opts || {}));
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    return body;
  };

  CS.kits = {
    list:   () => api('/').then(r => r.kits || []),
    create: kit => api('/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(kit)
    }),
    update: (id, kit) => api('/' + encodeURIComponent(id), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(kit)
    }),
    remove: id => api('/' + encodeURIComponent(id), { method: 'DELETE' })
  };
})();

/* ============================================================
   The bar itself.
   ============================================================ */
(function () {
  const $ = id => document.getElementById(id);
  let loaded = [];

  function say(msg, kind) {
    const el = $('kitStatus');
    if (!el) return;
    el.className = 'kit-status' + (kind ? ' ' + kind : '');
    el.textContent = msg || '';
  }

  /* Update and Delete only mean something once a kit is picked. */
  function syncButtons() {
    const picked = !!($('kitPick') && $('kitPick').value);
    if ($('kitUpdate')) $('kitUpdate').hidden = !picked;
    if ($('kitDelete')) $('kitDelete').hidden = !picked;
    if ($('kitApply')) $('kitApply').disabled = !picked;
  }

  function draw(selectId) {
    const sel = $('kitPick');
    if (!sel) return;
    sel.innerHTML = '<option value="">None</option>' + loaded.map(k =>
      '<option value="' + k.id + '">' + String(k.name).replace(/[<>&"]/g, '') + '</option>'
    ).join('');
    if (selectId) sel.value = selectId;
    syncButtons();
  }

  async function refresh(selectId) {
    try {
      loaded = await CS.kits.list();
      draw(selectId);
    } catch (e) {
      say(e.message, 'bad');
    }
  }

  /* The bar is only useful to someone with an account to keep kits in. */
  function show() {
    const on = !!(CS.ai && CS.ai.mode === 'server' && CS.ai.user);
    const bar = $('kitBar');
    if (bar) bar.hidden = !on;
    if (on && !loaded.length) refresh();
  }

  CS.onAccountChange = CS.onAccountChange || [];
  CS.onAccountChange.push(show);
  document.addEventListener('DOMContentLoaded', show);

  document.addEventListener('DOMContentLoaded', function () {
    if ($('kitPick')) $('kitPick').addEventListener('change', () => { say(''); syncButtons(); });

    if ($('kitApply')) $('kitApply').addEventListener('click', () => {
      const kit = loaded.find(k => k.id === $('kitPick').value);
      if (!kit) return say('Pick a kit first.', 'bad');
      CS.applyKit(kit);
      say('Applied "' + kit.name + '" — colours, narrator and end cards are set.', 'ok');
    });

    if ($('kitSave')) $('kitSave').addEventListener('click', async () => {
      const name = window.prompt('Name this kit — a channel or a client works well:', '');
      if (name === null) return;
      if (!name.trim()) return say('A kit needs a name.', 'bad');
      say('Saving…');
      try {
        const made = await CS.kits.create(CS.readKit(name.trim()));
        await refresh(made.id);
        say('Saved "' + made.name + '".', 'ok');
      } catch (e) { say(e.message, 'bad'); }
    });

    if ($('kitUpdate')) $('kitUpdate').addEventListener('click', async () => {
      const kit = loaded.find(k => k.id === $('kitPick').value);
      if (!kit) return;
      say('Updating…');
      try {
        await CS.kits.update(kit.id, CS.readKit(kit.name));
        await refresh(kit.id);
        say('"' + kit.name + '" now matches what is on screen.', 'ok');
      } catch (e) { say(e.message, 'bad'); }
    });

    if ($('kitDelete')) $('kitDelete').addEventListener('click', async () => {
      const kit = loaded.find(k => k.id === $('kitPick').value);
      if (!kit) return;
      if (!window.confirm('Delete the kit "' + kit.name + '"? Videos already made are unaffected.')) return;
      try {
        await CS.kits.remove(kit.id);
        await refresh();
        say('Deleted.', 'ok');
      } catch (e) { say(e.message, 'bad'); }
    });

    syncButtons();
  });
})();
