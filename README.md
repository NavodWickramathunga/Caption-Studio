# Caption Studio

Karaoke-style captions for short vertical videos — word-level timing without paying
a captioning service.

Two to four words on screen at a time, heavy uppercase, thick black outline, and the
word being spoken flipping to yellow. The look is the easy part; the expensive part
is knowing *exactly* when each word is spoken. Caption Studio produces that five
different ways, and three of them never touch the internet.

**Open it → https://navodwickramathunga.github.io/Caption-Studio/**

---

## The fast way

**Fast track** is the card at the top. Type what the video is about, pick a
narrator, press one button. It writes the script, speaks it, times every word
against that exact recording, and leaves you at the export.

Steps 1–5 below it are the same job by hand, for when you want to steer.

The order matters and this is why the button exists: the voice has to be made
*before* the words are timed, because the timing is measured from the recording.
Timing first and generating the voice afterwards leaves captions drifting
against a voiceover they were never measured against.

Tick **…and save the finished MP4** and it renders and downloads the video too,
so the one button really is the whole job.

**Make several at once** takes one topic per line. Each gets its own script, its
own voice and its own timings, renders over the same clips, and lands in your
downloads named after its topic. They run one after another, because each pass
owns the script box, the voiceover and the timings — two at once would be two
runs fighting over one set of state. A topic that fails is reported by name and
the rest carry on.

You still add your own clips in step 1 — the fast track does the words, the
voice and the timing, not the footage.

### The key

The AI parts talk to Google straight from your browser using a key you paste
into **🔑 Gemini Key** once. There is no server in the loop and no `.env` to
set up — the key is kept in that browser's local storage and goes nowhere else.

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

## Taking a watermark off the clip

A logo burned into the footage is under everything else, so it has to come off
before the captions go on. **Remove a watermark**, in step 1.

**🔍 Find the watermark** sends three stills from each clip to Gemini and asks
which rectangle the mark sits in. Three rather than one because a watermark is
the thing that *doesn't* move while the footage under it does, and one frame
cannot show that. The clip is never uploaded — three JPEGs are.

The removal itself never leaves this machine. Sending nine hundred frames to a
model would cost real money, take an hour, and flicker, because every frame
would be invented with no memory of the one before it. Instead the picture
around the mark is grown inward, frame by frame, which is instant and steady —
the same input always gives the same output, so there is nothing to shimmer.

Three ways to cover it:

| | What it does | Where it shows |
| --- | --- | --- |
| **Fill it in** | Grows the surrounding picture inward over the mark, then puts back as much grain as the neighbours have | A still, flat background |
| **Blur it** | Smears the area into itself until the mark is unreadable | Everywhere — that is the point |
| **Block it out** | A flat patch the colour of what surrounds it | Everywhere, honestly |

Every area is draggable on the preview — drag the middle to move it, the corner
to resize, or drag on empty picture to add one Gemini missed. A box drawn by
hand needs no key at all. Areas belong to the clip they were drawn on, so clips
of different sizes each mark their own; tick **use these same areas on every
clip** when the mark is in the same place throughout.

What you see on the preview is what the export gets — both go through the same
repair.

> This is for footage you own or are licensed to use. Taking someone else's mark
> off their work and posting it as yours is not what it is for.

## Getting a timing

Every word needs a start and an end. Three ways to get there:

| Method | How it works | Needs |
| --- | --- | --- |
| **Speak it and time the words** | The browser reads your script aloud and reports each word as it says it | nothing |
| **⏱ Time it for me** | Reads the loudness of an audio file to find the talking, then spreads words across it by syllable count | nothing |
| **Spacebar** | You tap along in rhythm | nothing |
| **Write the captions from the voice** | Whisper runs on this machine and reports a real start and end for every word. The tightest of the lot | nothing, after a one-off 40 MB download |
| **Auto-Sync** | Asks Gemini for the timings, and falls back to doing it here | a key |

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
- `ui.js` — the step rail, kept apart from `script.js` because it only reads
  what is on screen
- `server.js`, `package.json` — optional local host for `npm run dev`. It serves
  files and nothing else: it used to carry seven API endpoints that the browser
  never called, every one a second copy of something `script.js` already did,
  and duplicates like that are where the caption drift came from. GitHub Pages
  does not use these at all
- `BUILD-PROMPT.md` — the original spec
