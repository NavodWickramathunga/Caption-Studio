# Caption Studio

Karaoke-style captions for short vertical videos — word-level timing without paying
a captioning service.

Two to four words on screen at a time, heavy uppercase, thick black outline, and the
word being spoken flipping to yellow. The look is the easy part; the expensive part
is knowing *exactly* when each word is spoken. Caption Studio produces that three
different ways, and two of them never touch the internet.

**Open it → https://navodwickramathunga.github.io/Caption-Studio/**

---

## Your clip stays on your machine

Video and audio are read straight off disk with `URL.createObjectURL` and every frame
is drawn locally. Nothing is uploaded.

Two features are the exception, and both are optional:

- **Natural voices** — spoken by Microsoft's servers, so your *script* is sent there.
  Your video is not. Tick "Offline voices only" to avoid this entirely.
- **The AI buttons** — send your script, or ~300 KB of audio, to Google's Gemini.
  Your video is never sent.

Everything else — timing, captions, previews, all exports — runs offline.

## Getting a timing

Every word needs a start and an end. Three ways to get there:

| Method | How it works | Needs |
| --- | --- | --- |
| **Speak it and time the words** | The browser reads your script aloud and reports each word as it says it | nothing |
| **⏱ Time it for me** | Reads the loudness of an audio file to find the talking, then spreads words across it by syllable count | nothing |
| **Spacebar** | You tap along in rhythm | nothing |

They all write to the same list, so you can auto-time first and fix a few words by hand.

### Tap controls

- `Space` — mark this word and move on
- `Backspace` — undo one mark
- `R` — clear everything
- Click a word — re-record from there
- Shift-click a word — mark it as important

## Getting the voice inside the video

Facebook and YouTube need the voiceover **inside** the file. How that works depends
on where the voice comes from:

- **An audio file you load** — captured directly. Nothing to configure. **Use this.**
- **A voice the browser speaks** — the browser cannot hand its own speech to a
  recorder, so it has to capture the tab's sound. You must tick
  **"Also share tab audio"** in the box that appears, or the video comes out silent.

The tool checks the finished recording and tells you if it ended up with no sound.

## Voice Match

`voice-match.html` — for finding a voice that matches a clip you like.

Load the clip and its **pitch is measured on your machine** to decide male or female,
which halves the list immediately. Language and quality filters take a 331-voice
catalogue down to about 24. Those play back to back on one button: `S` stars the one
you're hearing, `→` skips, `Esc` stops.

Picking one hands it to Caption Studio, switching off the offline filter if the voice
needs it. Voices are per-browser — a voice chosen in Edge is not installed in Chrome,
and the tool says so rather than failing quietly.

There is also an AI option that listens to your clip and recommends voices, which
needs a Gemini API key.

## Before you post

- **Safe zones** — Facebook covers the top, bottom and right of the frame with its
  own interface. Turn the guides on and the tool warns you if your captions sit
  underneath, where nobody can read them.
- **Dead air** — silences over 0.45s get flagged with their length and position.
  Silence is where viewers leave.
- **Pacing** — words per second, flagged if it drifts slow or too fast.
- **End card** — an optional closing second asking for the follow, with your page name.

## What you can save

| Format | Use it for |
| --- | --- |
| `.ass` | Word-by-word highlight colours. Burn in with ffmpeg for the sharpest result. |
| `.srt` | TikTok and YouTube Shorts. |
| `.en_US.srt` | Facebook. It only accepts SRT, and only with that exact naming. |
| `.json` | Raw word timings, to reuse. |
| `.webm` | The video with captions and voice burned in, recorded in the browser. |

### Burning in with ffmpeg

```
ffmpeg -i clip.mp4 -vf "ass=captions.ass" -c:v libx264 -crf 20 -pix_fmt yuv420p -c:a aac out.mp4
```

Needs the **Anton** font installed on the machine running ffmpeg.

### Converting the recording for Facebook Reels

Reels want MP4, not WebM:

```
ffmpeg -i captioned.webm -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -c:a aac -b:a 128k out.mp4
```

## Browsers

Current Chrome and Edge. They are not equivalent:

| | Chrome | Edge |
| --- | --- | --- |
| Everything below | ✅ | ✅ |
| Natural voices | only 3 basic ones | **322** |
| Gemini AI buttons | ✅ | may be blocked by extensions or policy |

The 322 natural voices are an Edge feature — they are not installed on your computer
and Chrome cannot reach them.

## Files

- `index.html` / `script.js` / `style.css` — the captioning tool
- `voice-match.html` / `voice-match.js` / `voice-match.css` — the voice finder
- `server.js`, `package.json` — optional local Express host; GitHub Pages serves the
  site as static files and does not use these
- `BUILD-PROMPT.md` — the original spec
