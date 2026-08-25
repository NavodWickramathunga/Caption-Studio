# Caption Studio

Karaoke-style captions for short vertical videos, tapped in by hand.

2–4 words on screen at a time, heavy uppercase, white with a thick black outline,
and the word currently being spoken flips to yellow. The word-level timing comes
from you tapping the spacebar in rhythm with your own voiceover — no captioning
service, no subscription, no account.

**Open it here → https://navodwickramathunga.github.io/Caption-Studio/**

---

## Nothing leaves your machine

Your video and audio never get uploaded. The page reads them straight off disk
with `URL.createObjectURL`, and every frame is drawn locally in your browser.
There are no API calls, no analytics, no telemetry.

The only network request the page makes is to Google Fonts for the Anton
typeface. If that is blocked, the tool falls back to Impact / Arial Narrow and
keeps working.

## How to use it

1. **Choose your video** — a vertical clip from disk.
2. **Your voiceover** — either let the tool speak your script, or load an audio file.
3. **Paste your script** — plain text. Punctuation is dropped from the captions,
   word order is kept exactly.
4. **Check the timings** — if the tool spoke the script, this is already filled in.
   Otherwise press Play and hit `Space` on each word as you hear it.
   - `Space` — mark this word and move on
   - `Backspace` — undo one mark
   - `R` — clear everything and start over
   - Click any word — re-record from that word onward
5. **Set the look** — words on screen, text size, height on frame, highlight colour.
6. **Save your work.**

## The voiceover times itself

Pick a voice, hit **“Speak it and time the words”**, and the tool reads your script
aloud while writing down when each word actually lands. Step 4 fills in on its own —
no tapping.

It works because the speech engine reports a word boundary as it reaches each word.
The video is started at the moment the voice starts, so both share a clock, and every
boundary is stamped against the video's own timeline. If the engine skips a boundary,
the missing word is interpolated between its neighbours and the status line tells you
how many were estimated.

If the voiceover doesn't match the length of the clip, a **fit to the video** button
appears and offers the speaking rate that would make it line up.

**Voices are offline by default.** The tool lists only voices installed on your
machine (on Windows, the “Microsoft …” ones) — those speak locally and your script
goes nowhere. Untick *Offline voices only* and you get the browser's network voices
too, but then your script is sent to the voice provider to be spoken. The tool warns
you before you do it.

Not every voice reports word boundaries. If you pick one that doesn't, the tool says
so and you can either switch voices or tap the words in by hand.

## What you can save

| Format | Use it for |
| --- | --- |
| `.ass` | The real one. Feed it to ffmpeg for a proper encode — carries the per-word highlight colours. |
| `.srt` | One cue per word group, no highlighting. For platform auto-captions. |
| `.json` | `{"words":[{"text","start","end"}]}` — reuse the timings elsewhere. |
| `.webm` | Captions burned straight into the video, recorded in the browser in real time. |

A spoken voiceover has no audio file behind it, so it can't be captured the usual
way. When you save a burned-in video with a generated voice, the browser asks to
share this tab — tick **“Also share tab audio”** and the voice goes into the
recording. Cancel it and you still get the video, just silent.

### Burning in with ffmpeg

```
ffmpeg -i clip.mp4 -vf "ass=captions.ass" -c:a copy out.mp4
```

The `.ass` file asks for the **Anton** font, so Anton needs to be installed on
whichever machine runs ffmpeg.

## Running it

It is one self-contained `index.html` — no build step, no npm, no server.

- **Hosted:** GitHub Pages serves it from this repo. Open the link above.
- **Local:** download `index.html` and double-click it. It works from `file://`.

Current Chrome and Edge. The burned-in `.webm` export needs `MediaRecorder`; if
your browser doesn't support it, the tool says so and points you at the `.ass`
export instead.

## Repo contents

- `index.html` — the entire tool
- `BUILD-PROMPT.md` — the original spec it was built from
