const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

const newRoutes = `
app.post('/api/generate-script', express.json(), async (req, res) => {
  if (!ai) return res.status(500).json({ error: "GEMINI_API_KEY not configured" });
  try {
    const topic = req.body.topic;
    const prompt = \`Write a highly engaging, 30-second script for a TikTok/Reels/Shorts video about: "\${topic}". 
Start with a strong viral hook. Keep sentences short and punchy. Do not include visual directions, brackets, or speaker labels. Return ONLY the spoken text.\`;
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });
    res.json({ script: response.text.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/emojify', express.json(), async (req, res) => {
  if (!ai) return res.status(500).json({ error: "GEMINI_API_KEY not configured" });
  try {
    const script = req.body.script;
    const prompt = \`You are an expert short-form video editor. Take the following script and insert a few highly relevant emojis into the text to make it visually engaging. 
RULES:
1. Don't overdo it (max 1-2 emojis per sentence).
2. Place the emoji immediately AFTER the relevant word.
3. DO NOT change any of the actual words or punctuation. Just insert emojis.
SCRIPT:
\${script}\`;
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });
    res.json({ script: response.text.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
`;

code = code.replace("app.get('*',", newRoutes + "\napp.get('*',");
fs.writeFileSync('server.js', code);
