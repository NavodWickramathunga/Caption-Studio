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
2. **Add your voiceover** (optional) — if the narration is a separate file. The
   video's own sound is muted and the two play as one.
3. **Paste your script** — plain text. Punctuation is dropped from the captions,
   word order is kept exactly.
4. **Tap the words in** — press Play, then hit `Space` on each word as you hear it.
   - `Space` — mark this word and move on
   - `Backspace` — undo one mark
   - `R` — clear everything and start over
   - Click any word — re-record from that word onward
5. **Set the look** — words on screen, text size, height on frame, highlight colour.
6. **Save your work.**

## What you can save

| Format | Use it for |
| --- | --- |
| `.ass` | The real one. Feed it to ffmpeg for a proper encode — carries the per-word highlight colours. |
| `.srt` | One cue per word group, no highlighting. For platform auto-captions. |
| `.json` | `{"words":[{"text","start","end"}]}` — reuse the timings elsewhere. |
| `.webm` | Captions burned straight into the video, recorded in the browser in real time. |

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
