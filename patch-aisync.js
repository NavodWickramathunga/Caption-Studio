const fs = require('fs');
let code = fs.readFileSync('script.js', 'utf8');

const aiSyncCode = `
/* ============================================================
   AI Auto-Sync (Gemini)
   ============================================================ */
async function extractAudioWav(file, maxSeconds) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
  ctx.close();
  const sr = 16000;
  const dur = Math.min(decoded.duration, maxSeconds || 300); // Up to 5 minutes
  const off = new OfflineAudioContext(1, Math.ceil(dur * sr), sr);
  const src = off.createBufferSource();
  src.buffer = decoded; src.connect(off.destination); src.start(0);
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0), n = pcm.length;
  const ab = new ArrayBuffer(44 + n*2), dv = new DataView(ab);
  const w = (o,s) => { for (let i=0;i<s.length;i++) dv.setUint8(o+i, s.charCodeAt(i)); };
  w(0,'RIFF'); dv.setUint32(4,36+n*2,true); w(8,'WAVEfmt ');
  dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,1,true);
  dv.setUint32(24,sr,true); dv.setUint32(28,sr*2,true); dv.setUint16(32,2,true);
  dv.setUint16(34,16,true); w(36,'data'); dv.setUint32(40,n*2,true);
  for (let i=0;i<n;i++){ const s=Math.max(-1,Math.min(1,pcm[i])); dv.setInt16(44+i*2, s<0?s*0x8000:s*0x7FFF, true); }
  return new Blob([ab], {type:'audio/wav'});
}

if ($("btnAiSync")) {
  $("btnAiSync").addEventListener("click", async () => {
    const file = $("audioFile").files[0] || $("videoFile").files[0];
    if (!file) {
      alert("Please load a video or audio file first.");
      return;
    }
    if (!S.words || S.words.length === 0) {
      alert("Please paste your script first.");
      return;
    }
    
    const btn = $("btnAiSync");
    const originalText = btn.textContent;
    btn.textContent = "⏳ Extracting audio...";
    btn.disabled = true;

    try {
      const audioBlob = await extractAudioWav(file, 300);
      
      btn.textContent = "🧠 Gemini is aligning...";
      
      const formData = new FormData();
      formData.append("audio", audioBlob);
      formData.append("script", JSON.stringify(S.words));
      
      const res = await fetch("/api/auto-sync", {
        method: "POST",
        body: formData
      });
      
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Server error");
      }
      
      const timings = await res.json();
      
      if (!Array.isArray(timings) || timings.length === 0) {
          throw new Error("Invalid response from Gemini.");
      }
      
      // Map timings back to words
      for (let i = 0; i < S.words.length; i++) {
        const t = timings[i];
        if (t) {
            S.words[i].start = t.start;
            S.words[i].end = t.end;
        }
      }
      
      renderChips();
      refreshExports();
      btn.textContent = "✅ Done!";
      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 3000);
    } catch (e) {
      console.error(e);
      alert("AI Sync failed: " + e.message);
      btn.textContent = originalText;
      btn.disabled = false;
    }
  });
}
`;

code += "\n\n" + aiSyncCode;
fs.writeFileSync('script.js', code);
console.log("Patched script.js with AI auto sync");
