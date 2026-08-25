const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');

const newRoute = `
app.post('/api/auto-sync', upload.single('audio'), async (req, res) => {
  if (!ai) return res.status(500).json({ error: "GEMINI_API_KEY not configured on server" });
  if (!req.body.script) return res.status(400).json({ error: "No script provided" });

  try {
    const b64 = req.file.buffer.toString('base64');
    const scriptWords = JSON.parse(req.body.script);
    
    // We expect the model to return an array of timestamps.
    const schema = {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          word: { type: Type.STRING },
          start: { type: Type.NUMBER },
          end: { type: Type.NUMBER }
        },
        required: ["word", "start", "end"]
      }
    };

    const prompt = \`
You are a highly precise audio alignment engine. I will provide an audio clip and the exact sequence of words spoken in the audio.
Your task is to return a JSON array containing the exact start and end timestamps (in seconds) for each word.

THE EXACT WORDS (in order):
\${scriptWords.map(w => w.text).join(' ')}

RULES:
1. You MUST return exactly \${scriptWords.length} objects, one for each word in the sequence provided.
2. The timestamps must be sequentially increasing.
3. If there are gaps in the speech, the timestamps should reflect that.
\`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: 'user',
          parts: [
            { text: prompt },
            {
              inlineData: {
                data: b64,
                mimeType: req.file.mimetype || 'audio/wav'
              }
            }
          ]
        }
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: schema,
        temperature: 0.1
      }
    });

    res.json(JSON.parse(response.text));
  } catch (err) {
    console.error("Auto-sync error:", err);
    res.status(500).json({ error: err.message });
  }
});
`;

code = code.replace("app.get('*',", newRoute + "\napp.get('*',");
fs.writeFileSync('server.js', code);
console.log("Patched server.js");
