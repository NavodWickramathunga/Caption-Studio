const express = require('express');
const path = require('path');
const { GoogleGenAI, Type } = require('@google/genai');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

require('dotenv').config();

const app = express();
const PORT = 3000;

app.use(express.static(__dirname));
app.use(express.json({limit: '50mb'}));

let ai = null;
if (process.env.GEMINI_API_KEY) {
  ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

app.post('/api/analyze-voice', upload.single('audio'), async (req, res) => {
  if (!ai) {
    return res.status(500).json({ error: "GEMINI_API_KEY not configured on server" });
  }

  try {
    const b64 = req.file.buffer.toString('base64');
    
    // Schema matches voice-match.js SCHEMA
    const schema = {
      type: Type.OBJECT,
      properties: {
        detectedGender: { type: Type.STRING, description: "Male or Female" },
        vocalCharacteristics: { type: Type.ARRAY, items: { type: Type.STRING }, description: "e.g. deep, raspy, energetic, calm" },
        suggestedVoiceType: { type: Type.STRING, description: "Description of the closest matching TTS voice style" },
        confidence: { type: Type.INTEGER, description: "1-100 confidence score" }
      },
      required: ["detectedGender", "vocalCharacteristics", "suggestedVoiceType", "confidence"]
    };

    const prompt = "Listen to this short audio clip. I am trying to build a captioning tool and want to match the speaker's voice to an available web text-to-speech voice. Analyze the speaker's vocal characteristics (gender, pitch, tone, energy level) and suggest what kind of synthetic voice would be the best match. Keep descriptions brief.";

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
        temperature: 0.2
      }
    });

    const text = response.text;
    res.json(JSON.parse(text));
  } catch (err) {
    console.error("Gemini Error:", err);
    res.status(500).json({ error: err.message });
  }
});


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

    const prompt = `
You are a highly precise audio alignment engine. I will provide an audio clip and the exact sequence of words spoken in the audio.
Your task is to return a JSON array containing the exact start and end timestamps (in seconds) for each word.

THE EXACT WORDS (in order):
${scriptWords.map(w => w.text).join(' ')}

RULES:
1. You MUST return exactly ${scriptWords.length} objects, one for each word in the sequence provided.
2. The timestamps must be sequentially increasing.
3. If there are gaps in the speech, the timestamps should reflect that.
`;

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

app.get('*', (req, res) => {
  if (req.url === '/voice-match') return res.sendFile(path.join(__dirname, 'voice-match.html'));
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
