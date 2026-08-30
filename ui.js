/* ============================================================
   The step rail.

   Deliberately outside script.js: this watches which section is on
   screen and moves a highlight. It reads no app state and writes none,
   so it cannot be the reason an export goes wrong.
   ============================================================ */
(function () {
  const rail = document.getElementById("stepRail");
  if (!rail) return;

  const links = Array.prototype.slice.call(rail.querySelectorAll("a[data-step]"));
  const steps = links
    .map(a => ({ a, el: document.getElementById(a.dataset.step) }))
    .filter(s => s.el);
  if (!steps.length) return;

  function mark(el) {
    steps.forEach(s => {
      if (s.el === el) s.a.setAttribute("aria-current", "step");
      else s.a.removeAttribute("aria-current");
    });
  }

  /* Whichever step sits under a line near the top of the window is the one
     you are on. Measuring at the middle put step 2 under it while the page
     was still scrolled to the top, which read as skipping step 1. */
  function pick() {
    const doc = document.documentElement;
    const max = doc.scrollHeight - window.innerHeight;
    const y = window.scrollY || doc.scrollTop || 0;
    if (y <= 4) return mark(steps[0].el);                   // at the top, step 1
    if (max > 0 && y >= max - 4) return mark(steps[steps.length - 1].el);

    const probe = window.innerHeight * 0.20;   // just under the sticky rail
    let best = steps[0].el, bestDist = Infinity;
    for (const s of steps) {
      const r = s.el.getBoundingClientRect();
      const dist = r.top > probe ? r.top - probe : (r.bottom < probe ? probe - r.bottom : 0);
      if (dist < bestDist) { bestDist = dist; best = s.el; }
    }
    mark(best);
  }

  /* Five getBoundingClientRect calls per scroll is nothing, and doing it
     straight means the highlight still tracks in a tab the browser has
     throttled — requestAnimationFrame stops firing there, and a rail that
     freezes is worse than no rail. */
  window.addEventListener("scroll", pick, { passive: true });
  window.addEventListener("resize", pick);

  steps.forEach(s => s.a.addEventListener("click", e => {
    e.preventDefault();
    s.el.scrollIntoView({ behavior: "smooth", block: "start" });
  }));

  pick();
})();
