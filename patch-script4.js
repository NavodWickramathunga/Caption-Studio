const fs = require('fs');
let code = fs.readFileSync('script.js', 'utf8');

// Replace the setMode function
const oldSetMode = `function setMode(m) {
  const gen = m === "generated";
  $("modeGen").setAttribute("aria-selected", gen ? "true" : "false");
  $("modeFile").setAttribute("aria-selected", gen ? "false" : "true");
  $("genPanel").style.display = gen ? "" : "none";
  $("filePanel").style.display = gen ? "none" : "";
  if (gen) stopSpeaking();
  video.muted = (!gen && S.hasAudio);
  syncTransport();
}
$("modeGen").addEventListener("click", () => setMode("generated"));
$("modeFile").addEventListener("click", () => setMode("file"));`;

const newSetMode = `function setMode(m) {
  $("modeGen").setAttribute("aria-selected", m === "generated" ? "true" : "false");
  $("modeFile").setAttribute("aria-selected", m === "file" ? "true" : "false");
  if ($("modePremium")) $("modePremium").setAttribute("aria-selected", m === "premium" ? "true" : "false");
  
  $("genPanel").style.display = m === "generated" ? "" : "none";
  $("filePanel").style.display = m === "file" ? "" : "none";
  if ($("premiumPanel")) $("premiumPanel").style.display = m === "premium" ? "" : "none";
  
  if (m === "generated") stopSpeaking();
  video.muted = (m !== "generated" && S.hasAudio);
  syncTransport();
}
$("modeGen").addEventListener("click", () => setMode("generated"));
$("modeFile").addEventListener("click", () => setMode("file"));
if ($("modePremium")) $("modePremium").addEventListener("click", () => setMode("premium"));

/* ============================================================
   Premium ElevenLabs TTS Integration
   ============================================================ */
if ($("elevenKey")) {
  // Load saved key
  const savedKey = localStorage.getItem("elevenlabs_key");
  if (savedKey) $("elevenKey").value = savedKey;
  
  $("elevenKey").addEventListener("change", (e) => {
    localStorage.setItem("elevenlabs_key", e.target.value.trim());
  });

  $("btnGeneratePremium").addEventListener("click", async () => {
    const key = $("elevenKey").value.trim();
    if (!key) return alert("Please enter your ElevenLabs API Key.");
    
    const script = scriptEl.value.trim();
    if (!script) return alert("Please paste or generate a script in Step 3 first!");
    
    const voiceId = $("elevenVoice").value;
    const btn = $("btnGeneratePremium");
    const status = $("premiumStatus");
    const origText = btn.textContent;
    
    btn.textContent = "⏳ Generating Voice...";
    btn.disabled = true;
    status.textContent = "Calling ElevenLabs API... (This takes a few seconds)";
    status.className = "status";
    
    try {
      const response = await fetch("https://api.elevenlabs.io/v1/text-to-speech/" + voiceId, {
        method: "POST",
        headers: {
          "Accept": "audio/mpeg",
          "Content-Type": "application/json",
          "xi-api-key": key
        },
        body: JSON.stringify({
          text: script,
          model_id: "eleven_monolingual_v1",
          voice_settings: { stability: 0.5, similarity_boost: 0.75 }
        })
      });
      
      if (!response.ok) {
        let errMsg = "API Error";
        try {
          const errData = await response.json();
          errMsg = errData.detail.message || "Failed";
        } catch(e) {}
        throw new Error(errMsg);
      }
      
      const blob = await response.blob();
      
      // We have the audio! Now we load it just like a local file
      if (audioURL) URL.revokeObjectURL(audioURL);
      audioURL = URL.createObjectURL(blob);
      audio.src = audioURL;
      audio.load();
      S.hasAudio = true;
      video.muted = true;
      $("audioName").textContent = "Premium AI Voice (ElevenLabs)";
      $("audioName").classList.remove("none");
      $("clearAudio").style.display = "";
      syncTransport();
      
      status.textContent = "✅ Voice generated! Now click '✨ Auto-Sync' in Step 4 to time the words.";
      status.className = "status ok";
      
      // Auto-switch to file mode so they see the loaded audio
      // setMode("file"); // Optional, but let's just let them see it here.
    } catch (err) {
      console.error(err);
      status.textContent = "❌ Error: " + err.message;
      status.className = "status warn";
    } finally {
      btn.textContent = origText;
      btn.disabled = false;
    }
  });
}
`;

code = code.replace(oldSetMode, newSetMode);

fs.writeFileSync('script.js', code);
console.log("Patched script.js with ElevenLabs TTS logic");
