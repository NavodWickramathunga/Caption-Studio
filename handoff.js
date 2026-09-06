/* ============================================================
   Passing a story from one tool to the other.

   The Post Creator turns a news story into words. Caption Studio turns
   words into a captioned vertical video. They are two pages, so the
   words have to survive a navigation to get from one to the other.

   What crosses is small and deliberate: the spoken script, which
   narrator to read it, the headline, and a thumbnail of the picture for
   the end card. Not the footage — that is hundreds of megabytes and it
   is already sitting on the machine of the person who is about to add
   it. Not the layouts or the sizes either; a reel is not a square post
   and carrying the post's look over would only be something to undo.

   localStorage rather than sessionStorage, because sessionStorage is per
   tab and someone who middle-clicks the button lands in a new one with
   nothing in it. It is written once and deleted the moment it is read,
   so it is a message rather than a saved state — nothing here should
   still be true on the next visit.
   ============================================================ */
window.CSHandoff = (function () {
  "use strict";

  const KEY = "captionStudio.handoff";

  /* Stale is worse than absent. If a handoff is somehow still sitting
     there tomorrow, it belongs to a session nobody remembers starting. */
  const GOOD_FOR_MS = 10 * 60 * 1000;

  return {
    /* payload: { script, voice, headline, picture, from } */
    put(payload) {
      try {
        localStorage.setItem(KEY, JSON.stringify(
          Object.assign({ at: Date.now() }, payload)));
        return true;
      } catch (e) {
        /* A picture too big for the quota should not lose the words, so
           try again without it rather than failing the whole handoff. */
        try {
          const { picture, ...rest } = payload;
          localStorage.setItem(KEY, JSON.stringify(
            Object.assign({ at: Date.now() }, rest)));
          return true;
        } catch (e2) { return false; }
      }
    },

    /* Reading it consumes it. Called twice, the second call finds nothing,
       which is what should happen — a reload is not a second handoff. */
    take() {
      let raw = null;
      try { raw = localStorage.getItem(KEY); } catch (e) { return null; }
      if (!raw) return null;
      try { localStorage.removeItem(KEY); } catch (e) {}
      try {
        const data = JSON.parse(raw);
        if (!data || !data.at || Date.now() - data.at > GOOD_FOR_MS) return null;
        return data;
      } catch (e) { return null; }
    }
  };
})();
