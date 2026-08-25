# Build prompt — paste everything below into Claude Code

---

Build me a single-file browser tool for adding karaoke-style captions to short vertical videos. I make faceless anatomy and health-explainer content for Facebook Reels, roughly 10 seconds per clip, generated with Veo and narrated with AI text-to-speech.

## Hard constraints

These are non-negotiable — I'm on a locked-down office laptop:

- **One file.** A single `.html` with CSS and JS inline. I open it by double-clicking it.
- **No installs, no build step, no server, no npm.** It must work from `file://`.
- **No external dependencies** except web fonts from Google Fonts via a `<link>` tag. If a font fails to load, fall back gracefully.
- **Nothing leaves the machine.** All processing happens in the browser with `URL.createObjectURL`. No uploads, no API calls, no analytics, no telemetry of any kind.
- Must work in current Chrome and Edge. Don't worry about older browsers.

## What it does

The effect I'm copying: 2–4 words on screen at a time in heavy uppercase, white with a thick black outline, and the word currently being spoken flips to yellow. Standard short-form caption style.

The problem it solves: getting word-level timing without paying for a captioning service. I'll produce the timing by **tapping in rhythm with my own voiceover**.

### Core flow

1. **Load a video file** from disk. Show it in a 9:16 preview.
2. **Optionally load a separate audio file** for the voiceover. When present, mute the video's own audio and keep the two elements in sync (seek both together, play/pause both together).
3. **Paste the script** as plain text. Split it into words. Strip punctuation for display but keep the word order exactly.
4. **Tap-to-sync.** I press Play and hit the spacebar as each word is spoken. Each tap records `video.currentTime` as that word's start, and closes out the previous word's end. Controls:
   - `Space` — mark the current word and advance
   - `Backspace` — undo the last mark
   - `R` — clear all timings and start over
   - Clicking any word — re-record from that word onward, seeking the video back to the previous word's timestamp
5. **Live preview.** Draw the captions on a canvas overlaid on the video, updating every frame via `requestAnimationFrame`, so I see the real result while I adjust settings.
6. **Style controls:** words per screen (1–5), text size, vertical position, and a small set of highlight colors.
7. **Export.**

### Export formats

- **`.ass` subtitle file** — this is the important one. Use the `[V4+ Styles]` format with a style block, then emit one `Dialogue` line per word-active window, with the active word wrapped in inline `{\c&H00BBGGRR}` color tags. Remember ASS colors are **BGR, not RGB** — get this right. This file is what I feed to ffmpeg for a real encode.
- **`.srt`** — one cue per word group, plain text, no highlighting. For platform auto-captions.
- **`.json`** — `{"words": [{"text","start","end"}]}` so I can reuse the timings.
- **Burned-in video** — render video frames plus captions to a canvas, capture with `canvas.captureStream()`, pull the audio track off the playing media element with `captureStream()`, combine into one `MediaStream`, and record with `MediaRecorder` to WebM. Show a progress percentage while it records. Handle the case where the browser doesn't support it by telling me to use the `.ass` export instead.

## Caption rendering details

Get these right — they're what makes it look professional rather than homemade:

- Uppercase, heavy condensed face (Anton), sized as a percentage of **video height** so it looks identical on 720×1280 and 1080×1920.
- Thick black outline: `strokeText` before `fillText`, `lineWidth` around 17% of font size, `lineJoin: 'round'`.
- Soft drop shadow underneath, subtle.
- Words centered as a group horizontally. If a line would overflow the frame width, shrink the font to fit rather than wrapping or clipping.
- The active word changes color; the others stay white. No scaling, bouncing, or pop animation — it reads as cheap.
- Between word groups, show nothing rather than lingering on the previous group.

## Design

Don't give me a generic dark dashboard. The subject is anatomical illustration, so pull the palette from that world: a deep slate ground, bone ivory for text, a muscle rose as the primary accent, a vein blue as the secondary. Use the caption yellow *only* where it represents actual caption output, never as UI decoration.

Use Anton for headings — the tool should look like the thing it produces — and a monospace face for timecodes and numeric data, since those are data and should read as data.

The tap-sync strip is the centerpiece. Lay the script out as a row of word chips that visibly fill in as I tap through them, with the timestamp appearing under each one and a clear marker on the word I'm about to hit. Make that element the memorable part and keep everything around it quiet.

Meet a quality floor without making a fuss about it: keyboard focus visible, `prefers-reduced-motion` respected, layout collapsing sensibly on a narrow window.

## Copy

Write the interface labels from my side of the screen, in plain language. "Save video with captions", not "Export MediaRecorder output". Empty states should tell me what to do next. Number the steps, because this genuinely is a sequence and the order matters.

## Acceptance check

Before you tell me it's done, verify:

- Loading a video, pasting three words, tapping three times, and exporting `.ass` produces a valid file with correct BGR color tags.
- The live preview highlights the correct word at any given playback position.
- Undo and click-to-re-sync both leave the timing array in a consistent state.
- Export buttons stay disabled until every word has both a start and an end.
- A long word group shrinks to fit instead of running off the frame.

Build it, then tell me what you'd improve if I asked for a v2.
