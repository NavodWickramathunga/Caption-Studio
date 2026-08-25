const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

const newRoutes = `
app.post('/api/rewrite', express.json(), async (req, res) => {
  if (!ai) return res.status(500).json({ error: "GEMINI_API_KEY not configured on server" });
  if (!req.body.script) return res.status(400).json({ error: "No script provided" });

  try {
    const tone = req.body.tone || "punchy";
    const prompt = \`Rewrite the following script to make it \${tone}. Keep it extremely concise and suitable for a fast-paced short-form video (TikTok/Reels). Do not use punctuation like commas or periods in the output since it will be used for captions. Return ONLY the text, no markdown.\n\nSCRIPT:\n\${req.body.script}\`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { temperature: 0.7 }
    });

    res.json({ script: response.text.trim() });
  } catch (err) {
    console.error("Rewrite error:", err);
    res.status(500).json({ error: err.message });
  }
});
`;

// Also, update auto-sync to handle transcription when no script is provided
code = code.replace(
  'if (!req.body.script) return res.status(400).json({ error: "No script provided" });',
  '// Script is now optional for auto-transcription'
);

code = code.replace(
  'const scriptWords = JSON.parse(req.body.script);',
  `let scriptWords = [];
    if (req.body.script && req.body.script !== "[]") {
      scriptWords = JSON.parse(req.body.script);
    }`
);

// We need to change the prompt if scriptWords is empty
const newPromptBlock = `
    let prompt = "";
    if (scriptWords.length > 0) {
      prompt = \`You are a highly precise audio alignment engine. I will provide an audio clip and the exact sequence of words spoken in the audio.
Your task is to return a JSON array containing the exact start and end timestamps (in seconds) for each word.

THE EXACT WORDS (in order):
\${scriptWords.map(w => w.text).join(' ')}

RULES:
1. You MUST return exactly \${scriptWords.length} objects, one for each word in the sequence provided.
2. The timestamps must be sequentially increasing.
3. If there are gaps in the speech, the timestamps should reflect that.\`;
    } else {
      prompt = \`You are a highly precise audio transcription and alignment engine. Listen to the audio clip and transcribe the spoken words.
Your task is to return a JSON array containing the exact start and end timestamps (in seconds) for each word spoken.

RULES:
1. Do not include punctuation in the 'word' field.
2. The timestamps must be sequentially increasing.
3. Transcribe exactly what is spoken, broken down word by word. Do not chunk words together.\`;
    }
`;

code = code.replace(
  "const prompt = `\n" +
  "You are a highly precise audio alignment engine. I will provide an audio clip and the exact sequence of words spoken in the audio.\n" +
  "Your task is to return a JSON array containing the exact start and end timestamps (in seconds) for each word.\n" +
  "\n" +
  "THE EXACT WORDS (in order):\n" +
  "${scriptWords.map(w => w.text).join(' ')}\n" +
  "\n" +
  "RULES:\n" +
  "1. You MUST return exactly ${scriptWords.length} objects, one for each word in the sequence provided.\n" +
  "2. The timestamps must be sequentially increasing.\n" +
  "3. If there are gaps in the speech, the timestamps should reflect that.\n" +
  "`;",
  newPromptBlock
);

code = code.replace("app.get('*',", newRoutes + "\napp.get('*',");
fs.writeFileSync('server.js', code);
console.log("Patched server.js for Rewrite and Auto-Transcribe");
