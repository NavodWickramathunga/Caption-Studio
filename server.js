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
  // Script is now optional for auto-transcription

  try {
    const b64 = req.file.buffer.toString('base64');
    let scriptWords = [];
    if (req.body.script && req.body.script !== "[]") {
      scriptWords = JSON.parse(req.body.script);
    }
    
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

    
    let prompt = "";
    if (scriptWords.length > 0) {
      prompt = `You are a highly precise audio alignment engine. I will provide an audio clip and the exact sequence of words spoken in the audio.
Your task is to return a JSON array containing the exact start and end timestamps (in seconds) for each word.

THE EXACT WORDS (in order):
${scriptWords.map(w => w.text).join(' ')}

RULES:
1. You MUST return exactly ${scriptWords.length} objects, one for each word in the sequence provided.
2. The timestamps must be sequentially increasing.
3. If there are gaps in the speech, the timestamps should reflect that.`;
    } else {
      prompt = `You are a highly precise audio transcription and alignment engine. Listen to the audio clip and transcribe the spoken words.
Your task is to return a JSON array containing the exact start and end timestamps (in seconds) for each word spoken.

RULES:
1. Do not include punctuation in the 'word' field.
2. The timestamps must be sequentially increasing.
3. Transcribe exactly what is spoken, broken down word by word. Do not chunk words together.`;
    }


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


app.post('/api/rewrite', express.json(), async (req, res) => {
  if (!ai) return res.status(500).json({ error: "GEMINI_API_KEY not configured on server" });
  if (!req.body.script) return res.status(400).json({ error: "No script provided" });

  try {
    const tone = req.body.tone || "punchy";
    const prompt = `Rewrite the following script to make it ${tone}. Keep it extremely concise and suitable for a fast-paced short-form video (TikTok/Reels). Do not use punctuation like commas or periods in the output since it will be used for captions. Return ONLY the text, no markdown.

SCRIPT:
${req.body.script}`;

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


app.post('/api/generate-script', express.json(), async (req, res) => {
  if (!ai) return res.status(500).json({ error: "GEMINI_API_KEY not configured" });
  try {
    const topic = req.body.topic;
    const prompt = `Write a highly engaging, 30-second script for a TikTok/Reels/Shorts video about: "${topic}". 
Start with a strong viral hook. Keep sentences short and punchy. Do not include visual directions, brackets, or speaker labels. Return ONLY the spoken text.`;
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
    const prompt = `You are an expert short-form video editor. Take the following script and insert a few highly relevant emojis into the text to make it visually engaging. 
RULES:
1. Don't overdo it (max 1-2 emojis per sentence).
2. Place the emoji immediately AFTER the relevant word.
3. DO NOT change any of the actual words or punctuation. Just insert emojis.
SCRIPT:
${script}`;
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });
    res.json({ script: response.text.trim() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ============================================================
   The voiceover, as real sound.

   A voice spoken by the browser exists only as playback — there is no way
   to read it back as samples. That is the whole reason putting the voice
   into an export meant sharing the screen and hoping the right boxes were
   ticked. Synthesising it here returns actual audio, so the exporter can
   mux it straight in and the screen never has to be shared at all.
   ============================================================ */

/* The first eight earned their place by sounding right on short-form. The rest
   are everything else the model offers, carrying Google's own one-word descriptor
   rather than a gender I would only be guessing at. */
const TTS_VOICES = [
  { id: "Kore",          label: "Aria — warm and steady (female)", group: "Suggested" },
  { id: "Leda",          label: "Leda — bright and youthful (female)", group: "Suggested" },
  { id: "Aoede",         label: "Aoede — breezy and upbeat (female)", group: "Suggested" },
  { id: "Callirrhoe",    label: "Callie — soft and easy (female)", group: "Suggested" },
  { id: "Puck",          label: "Puck — lively and playful (male)", group: "Suggested" },
  { id: "Charon",        label: "Charon — deep and informative (male)", group: "Suggested" },
  { id: "Fenrir",        label: "Fenrir — punchy and excitable (male)", group: "Suggested" },
  { id: "Orus",          label: "Orus — firm and confident (male)", group: "Suggested" },
  { id: "Zephyr",        label: "Zephyr — bright",                 group: "More voices" },
  { id: "Autonoe",       label: "Autonoe — bright",                group: "More voices" },
  { id: "Enceladus",     label: "Enceladus — breathy",             group: "More voices" },
  { id: "Iapetus",       label: "Iapetus — clear",                 group: "More voices" },
  { id: "Erinome",       label: "Erinome — clear",                 group: "More voices" },
  { id: "Umbriel",       label: "Umbriel — easy-going",            group: "More voices" },
  { id: "Algieba",       label: "Algieba — smooth",                group: "More voices" },
  { id: "Despina",       label: "Despina — smooth",                group: "More voices" },
  { id: "Algenib",       label: "Algenib — gravelly",              group: "More voices" },
  { id: "Rasalgethi",    label: "Rasalgethi — informative",        group: "More voices" },
  { id: "Laomedeia",     label: "Laomedeia — upbeat",              group: "More voices" },
  { id: "Achernar",      label: "Achernar — soft",                 group: "More voices" },
  { id: "Alnilam",       label: "Alnilam — firm",                  group: "More voices" },
  { id: "Schedar",       label: "Schedar — even",                  group: "More voices" },
  { id: "Gacrux",        label: "Gacrux — mature",                 group: "More voices" },
  { id: "Pulcherrima",   label: "Pulcherrima — forward",           group: "More voices" },
  { id: "Achird",        label: "Achird — friendly",               group: "More voices" },
  { id: "Zubenelgenubi", label: "Zubenelgenubi — casual",          group: "More voices" },
  { id: "Vindemiatrix",  label: "Vindemiatrix — gentle",           group: "More voices" },
  { id: "Sadachbia",     label: "Sadachbia — lively",              group: "More voices" },
  { id: "Sadaltager",    label: "Sadaltager — knowledgeable",      group: "More voices" },
  { id: "Sulafat",       label: "Sulafat — warm",                  group: "More voices" },
];

app.get('/api/tts/voices', (req, res) => {
  res.json({ ok: !!ai, voices: TTS_VOICES });
});

/* Gemini hands back headerless 16-bit PCM. Browsers will not decode that,
   so wrap it in the 44-byte WAV header they do understand. */
function pcmToWav(pcm, sampleRate, channels) {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);            // PCM chunk size
  head.writeUInt16LE(1, 20);             // format: PCM
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * blockAlign, 28);
  head.writeUInt16LE(blockAlign, 32);
  head.writeUInt16LE(8 * bytesPerSample, 34);
  head.write('data', 36);
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}

app.post('/api/tts', express.json(), async (req, res) => {
  if (!ai) return res.status(500).json({ error: "GEMINI_API_KEY not configured on server" });

  const script = String(req.body.script || "").trim();
  if (!script) return res.status(400).json({ error: "No script provided" });
  /* One request is one render's worth of speech. Well past any short-form
     script, and short enough that a runaway paste cannot bill for a novel. */
  if (script.length > 5000) {
    return res.status(400).json({ error: "That script is too long to speak in one go — keep it under 5000 characters." });
  }

  const voice = TTS_VOICES.some(v => v.id === req.body.voice) ? req.body.voice : "Kore";
  const style = String(req.body.style || "").trim();

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ role: 'user', parts: [{ text: style ? `${style}: ${script}` : script }] }],
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
      }
    });

    const part = response.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data);
    if (!part) throw new Error("The model returned no audio.");

    /* The mime type carries the rate, e.g. audio/L16;codec=pcm;rate=24000.
       Read it rather than assuming — a wrong rate plays at the wrong pitch. */
    const rate = parseInt((part.inlineData.mimeType || "").match(/rate=(\d+)/)?.[1], 10) || 24000;
    const wav = pcmToWav(Buffer.from(part.inlineData.data, 'base64'), rate, 1);

    res.set('Content-Type', 'audio/wav');
    res.set('Content-Length', String(wav.length));
    res.send(wav);
  } catch (err) {
    console.error("TTS error:", err);
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
