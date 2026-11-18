# Birding by Ear

**Identify birds by their sound, and hear the answer spoken aloud.**

Birding by Ear is a small web app you run on your own computer. Record a bird
singing outside, or choose an audio file, and the app tells you out loud which
bird it is. It then reads a short memory phrase that helps you recognize that
song next time. For example, a Carolina Wren's song goes *"teakettle,
teakettle, teakettle"*.

The app is built for birders who are blind or have low vision. You can do
everything with a keyboard and your ears, without looking at the screen.

---

## Why this exists

Birding is often described as a visual hobby: binoculars, field marks, colorful
feathers. But most birds are heard long before they are seen, and many
experienced birders identify the majority of birds by ear.
[Birdability](https://www.birdability.org/) works to make birding welcoming
and accessible to everyone, including people who are blind or have low vision.
This project follows that idea.

Most bird ID apps show their answers on screen, in layouts that can be hard to
use with a screen reader. Birding by Ear starts from the opposite assumption:
**the whole experience has to work by sound alone.** Visual design matters,
but it comes second.

## What it does

1. **You record or upload a short clip** of a bird calling or singing.
2. **[BirdNET](https://github.com/birdnet-team/birdnet) identifies the species.**
   BirdNET is an open-source bird sound model from the Cornell Lab of
   Ornithology and Chemnitz University of Technology, and it runs on your
   computer.
3. **The app speaks the result:** the bird's name, then its memory phrase.
4. **You can play real reference recordings** of that species' songs and
   calls, so you can compare them with what you heard.

The memory phrases in `mnemonics.json` cover about 55 common North American
birds. They were written during a volunteer birding-by-ear project. If BirdNET
identifies a bird that isn't in the file, the app says its name and skips the
phrase.

---

## Accessibility features

Every part of the app was designed to be used without seeing the screen.

**Everything is spoken or announced**
- Each step (getting ready, listening, identifying, done) is announced through
  an ARIA live region, so screen readers such as VoiceOver, NVDA and JAWS read
  it automatically.
- Results are also spoken in the app's own voice, using the browser's built-in
  speech. If you use a screen reader and hear everything twice, you can turn
  the app's voice off in Settings.
- You can choose a slow, normal or fast speaking speed.
- "Say it again" repeats the result. "Hear other birds" reads any other birds
  found in the same clip.

**Recording without looking**
- When you press Record, the app tells you what's about to happen, then plays
  a **rising tone** when it starts listening and a **falling tone** when it
  stops.
- Nothing is spoken while the microphone is listening, so the app's voice
  never ends up in your recording.
- Recording stops by itself after 15 seconds, or press the button again to
  stop early.
- The microphone's "phone call" filters (noise suppression, echo
  cancellation) are turned off, because they treat bird song as noise and
  remove it.

**Keyboard and screen reader friendly**
- Every control is a standard button, checkbox or menu, reachable with Tab and
  activated with Enter or Space.
- **Escape** stops the app's voice and any recording that's playing, at any
  time.
- Buttons are never disabled while the app is busy, since that can knock
  keyboard focus off them. Pressing one tells you why it can't act yet.
- Uses proper headings, labels and landmarks, plus a "Skip to recording" link.
- Reference recordings are labeled in plain words, for example "Play song, 31
  seconds, recorded in Minnesota".

**Honest about uncertainty**
- A confident match is spoken plainly. A weaker match is spoken as "Possibly
  …, but I'm not sure."
- If no bird is found, the app says so and suggests how to get a better
  recording.

**For low vision**
- Large text and large buttons, at least about 60 pixels tall.
- High-contrast warm colors with an automatic dark mode.
- A thick, clearly visible focus outline.
- Respects the system "reduce motion" setting.

---

## Running it on your computer

These steps are written for macOS. You don't need any programming experience,
an account or an API key. Expect about 10 minutes the first time, most of it
waiting for downloads.

### What you need

- A Mac (Apple Silicon or Intel) with an internet connection for the first
  setup.
- Google Chrome is recommended. Safari and Firefox should also work.
- A microphone, if you want to record live. The built-in one works.

### Step 1: Download this project

1. Download the project as a ZIP file from this direct link:
   **https://github.com/mckenzieclosen/birding-by-ear/archive/refs/heads/main.zip**

   Or go to the project page at
   https://github.com/mckenzieclosen/birding-by-ear, activate the green
   **Code** button near the top, and choose **Download ZIP**.
2. Open your Downloads folder and double-click the ZIP file to unzip it. You
   now have a folder called `birding-by-ear-main`.

### Step 2: Open Terminal

Terminal is a built-in Mac app where you type commands.

- Press **Command + Space** to open Spotlight, type **Terminal**, and press
  **Return**.

### Step 3: Install uv (one time only)

uv is a small free tool that installs the right version of Python for this app.
It doesn't change anything else on your Mac. Copy this line, paste it into
Terminal and press **Return**:

```
curl -LsSf https://astral.sh/uv/install.sh | sh
```

When it says `everything's installed!`, **quit Terminal (Command + Q) and open
it again** so it can find uv.

### Step 4: Go to the project folder

Type `cd` followed by a space, then drag the unzipped project folder from
Finder onto the Terminal window and press **Return**. If you'd rather type it,
and the folder is in Downloads:

```
cd ~/Downloads/birding-by-ear-main
```

### Step 5: Start the app

```
uv run python server.py
```

**The first time,** this downloads Python, BirdNET and its bird models (a few
hundred megabytes) and may take several minutes. Later starts take a few
seconds. It's ready when you see a line containing:

```
Uvicorn running on http://127.0.0.1:8000
```

Keep this Terminal window open while you use the app.

### Step 6: Open the app

Open your web browser and go to **http://localhost:8000**.

The first time you press Record, the browser asks for permission to use the
microphone. Choose **Allow**.

### Stopping and starting again

- **To stop the app:** click into the Terminal window and press
  **Control + C**.
- **To start it again later:** open Terminal and repeat Steps 4 and 5. You
  never need to repeat Step 3.

### Troubleshooting

| Problem | What to try |
|---|---|
| `command not found: uv` | Quit and reopen Terminal after Step 3. If that doesn't work, run `~/.local/bin/uv run python server.py` instead. |
| "Address already in use" | The app is already running in another Terminal window. Use that one, or stop it with Control + C. |
| "Microphone access was blocked" | In Chrome, open the site settings (the icon left of the address) and allow the microphone. On a Mac, also check System Settings → Privacy & Security → Microphone. |
| "Couldn't reach the recordings library" | Reference recordings need an internet connection. Identifying birds does not. |
| Wrong or exotic birds suggested | Turn on **Use my approximate location** in Settings. It rules out birds that don't live near you at this time of year. |

---

## Privacy

- **Bird identification happens entirely on your computer.** Your recordings
  are never uploaded anywhere and are deleted right after being analyzed.
- **Location is off unless you turn it on.** When on, it's rounded to about
  10 km, used only to filter the bird list, and never stored.
- **Reference recordings** are fetched from Wikimedia Commons. Only the
  species' scientific name is sent.

## Tips for better results

- Record when the bird is actively singing, and get as close as you
  comfortably can.
- Wind, traffic and talking reduce accuracy.
- Turn on location. It makes the biggest single difference.
- Faint or distant birds can still be identified, usually with lower
  confidence ("Possibly …").

---

## For developers

- **Backend:** `server.py` uses Python 3.12 and FastAPI. It runs BirdNET
  version 2.4 (via the [`birdnet`](https://pypi.org/project/birdnet/)
  package), and can filter by location with BirdNET's geo model.
- **Frontend:** plain HTML, CSS and JavaScript in `static/`, with no build
  step.
- **Audio conversion:** the browser converts every recording or upload to 48
  kHz mono WAV with the Web Audio API before uploading, so the server doesn't
  need ffmpeg.
- **Reference recordings:** fetched from the Wikimedia Commons API (no key
  needed), using its MP3 copies so playback works in every browser.
- **Adding memory phrases:** edit `mnemonics.json`. Keys must match BirdNET's
  English common names, such as `"Black-capped Chickadee"`. Matching ignores
  capitalization.

The server stays on your own computer (`127.0.0.1`). It isn't set up to be put
on the public internet as-is.

## Credits and licenses

- **App code:** MIT License, see [LICENSE](LICENSE).
- **Memory phrases** (`mnemonics.json`): written for a volunteer
  birding-by-ear project, licensed
  [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Reuse with
  credit.
- **BirdNET** by the K. Lisa Yang Center for Conservation Bioacoustics at the
  Cornell Lab of Ornithology and Chemnitz University of Technology. The
  `birdnet` package is MIT licensed. The **BirdNET 2.4 models are licensed
  [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)**,
  which means non-commercial use only.
- **Reference recordings** come from
  [Wikimedia Commons](https://commons.wikimedia.org/), many originally from
  [xeno-canto](https://xeno-canto.org/). Each is credited to its recordist,
  with its license, in the app.
- Inspired by the mission of [Birdability](https://www.birdability.org/).
  This project is independent and not affiliated with Birdability, the Cornell
  Lab of Ornithology or xeno-canto.
