const fs = require('fs');
let code = fs.readFileSync('script.js', 'utf8');

const newScript = `
/* ============================================================
   AI Script Tools (Rewrite & Transcribe)
   ============================================================ */
if ($("btnRewrite")) {
  $("btnRewrite").addEventListener("click", async () => {
    const text = scriptEl.value.trim();
    if (!text) {
      alert("Please paste a script first to rewrite.");
      return;
    }
    
    const btn = $("btnRewrite");
    const originalText = btn.textContent;
    btn.textContent = "⏳ Rewriting...";
    btn.disabled = true;
    
    try {
      const res = await fetch("/api/rewrite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: text, tone: "punchy and engaging for short-form video" })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const data = await res.json();
      scriptEl.value = data.script;
      parseScript(); // update words
    } catch (e) {
      console.error(e);
      alert("Failed to rewrite: " + e.message);
    } finally {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  });
}

if ($("btnTranscribe")) {
  $("btnTranscribe").addEventListener("click", async () => {
    const file = $("audioFile").files[0] || $("videoFile").files[0];
    if (!file) {
      alert("Please load a video or audio file first in Step 1.");
      return;
    }
    
    const btn = $("btnTranscribe");
    const originalText = btn.textContent;
    btn.textContent = "⏳ Extracting audio...";
    btn.disabled = true;
    
    try {
      const audioBlob = await extractAudioWav(file, 300);
      btn.textContent = "🎙️ Transcribing...";
      
      const formData = new FormData();
      formData.append("audio", audioBlob);
      // Empty script means transcribe
      
      const res = await fetch("/api/auto-sync", {
        method: "POST",
        body: formData
      });
      if (!res.ok) throw new Error((await res.json()).error);
      const timings = await res.json();
      
      if (!Array.isArray(timings) || timings.length === 0) {
          throw new Error("No transcription returned.");
      }
      
      // We got word objects back {word, start, end}
      S.words = timings.map(t => ({
        text: t.word.toUpperCase(),
        start: t.start,
        end: t.end,
        key: false
      }));
      
      // Update text area
      scriptEl.value = timings.map(t => t.word.toUpperCase()).join(" ");
      
      renderChips();
      refreshExports();
      
      btn.textContent = "✅ Done!";
      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 3000);
    } catch (e) {
      console.error(e);
      alert("Transcription failed: " + e.message);
      btn.textContent = originalText;
      btn.disabled = false;
    }
  });
}
`;

code += "\n\n" + newScript;

// Update the btnAiSync logic to handle case where no words exist yet
code = code.replace(
  'if (!S.words || S.words.length === 0) {',
  'if (!S.words || S.words.length === 0) {\n      alert("Please paste your script first, or use Auto-Transcribe.");\n      return;\n    }\n    if (false) {'
);

fs.writeFileSync('script.js', code);
console.log("Patched script.js with rewrite & transcribe");
