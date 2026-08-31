/* ============================================================
   A plain static host, and nothing more.

   This file used to carry seven API endpoints — TTS, script writing,
   rewriting, emoji, auto-sync, voice analysis — every one of them a
   second implementation of something script.js already does directly
   against Google. The browser never called a single one of them.

   Two implementations of the same job is exactly the shape of the bug
   that left captions drifting: gatherExportAudio had been fixed and
   gatherTimingAudio had not, because nobody remembered there were two.
   So the duplicates are gone. The key lives in the browser, put there
   by the 🔑 Gemini Key button, and this only serves files.
   ============================================================ */
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get('*', (req, res) => {
  if (req.url === '/voice-match') return res.sendFile(path.join(__dirname, 'voice-match.html'));
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Caption Studio on http://localhost:${PORT}`);
});
