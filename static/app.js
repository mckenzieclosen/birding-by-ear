// Birding by Ear — front end.
// Design rule: every step must be understandable by sound alone.
//  * Status and results go to the polite live region (#status) for screen readers.
//  * Results are also spoken with the Web Speech API (can be turned off).
//  * Tones mark when the microphone starts and stops listening, so nothing
//    needs to be spoken while recording (speech would end up in the clip).
"use strict";

const MAX_RECORD_SECONDS = 15;
const MAX_CLIP_SECONDS = 60;
const TARGET_RATE = 48000; // BirdNET's native sample rate
const CONFIDENT = 0.5;     // at or above this we name the bird plainly

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const recordBtn = $("record-btn");
const recordLabel = $("record-label");
const fileInput = $("file-input");
const resultSection = $("result");
const resultBody = $("result-body");
const replayBtn = $("replay-btn");
const othersBtn = $("others-btn");
const stopSpeakingBtn = $("stop-speaking-btn");
const voiceToggle = $("voice-toggle");
const locationToggle = $("location-toggle");
const rateSelect = $("rate");

let state = "idle"; // idle | preparing | recording | processing
let audioCtx = null;
let recorder = null;
let micStream = null;
let stopTimer = null;
let prepTimer = null;
let lastSpoken = "";
let lastOthers = "";

// ------------------------------------------------------------------ settings
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("bbe-settings") || "{}");
    if (typeof s.voice === "boolean") voiceToggle.checked = s.voice;
    if (typeof s.location === "boolean") locationToggle.checked = s.location;
    if (s.rate) rateSelect.value = s.rate;
  } catch { /* storage unavailable: defaults are fine */ }
}
function saveSettings() {
  try {
    localStorage.setItem("bbe-settings", JSON.stringify({
      voice: voiceToggle.checked,
      location: locationToggle.checked,
      rate: rateSelect.value,
    }));
  } catch { /* ignore */ }
}

// ------------------------------------------------------------------ announce & speak
let announceSeq = 0;
function announce(text) {
  // Clearing first makes screen readers re-read identical messages.
  const seq = ++announceSeq;
  statusEl.textContent = "";
  setTimeout(() => { if (seq === announceSeq) statusEl.textContent = text; }, 60);
}

function speak(text, { force = false } = {}) {
  return new Promise((resolve) => {
    if ((!voiceToggle.checked && !force) || !("speechSynthesis" in window)) return resolve();
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = parseFloat(rateSelect.value) || 1;
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

function stopSpeaking() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

// ------------------------------------------------------------------ tones
function ctx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

function tone(fromHz, toHz, seconds = 0.35) {
  return new Promise((resolve) => {
    const c = ctx();
    const osc = c.createOscillator();
    const gain = c.createGain();
    const t = c.currentTime;
    osc.type = "sine";
    osc.frequency.setValueAtTime(fromHz, t);
    osc.frequency.exponentialRampToValueAtTime(toHz, t + seconds);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + seconds);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + seconds + 0.02);
    osc.onended = () => resolve();
  });
}
const startTone = () => tone(440, 880);
const stopTone = () => tone(880, 440);

// ------------------------------------------------------------------ recording
function setRecordButton(recordingUi) {
  recordLabel.textContent = recordingUi ? "Stop recording" : "Record";
  recordBtn.classList.toggle("recording", recordingUi);
}

async function onRecordPress() {
  if (state === "processing") {
    announce("Still identifying the last clip. Please wait.");
    return;
  }
  if (state === "preparing") return cancelPreparing();
  if (state === "recording") return finishRecording();
  await startRecording();
}

async function startRecording() {
  stopPlayback();
  stopSpeaking();
  ctx(); // create the audio context inside the key press / click
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    announce("This browser can't record audio. You can choose an audio file instead.");
    return;
  }
  state = "preparing";
  setRecordButton(true);
  try {
    // Turn off voice-call processing: it treats bird song as noise and removes it.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    state = "idle";
    setRecordButton(false);
    announce(err && err.name === "NotAllowedError"
      ? "Microphone access was blocked. Allow the microphone in your browser settings, or choose an audio file instead."
      : "I couldn't find a microphone. You can choose an audio file instead.");
    return;
  }
  if (state !== "preparing") return; // cancelled while the permission prompt was open

  // Say everything now, before listening, so no speech lands in the recording.
  const prep = `Get ready. After the rising tone, I'll listen for up to ${MAX_RECORD_SECONDS} seconds. Press the button again to stop early.`;
  announce(prep);
  // Give a screen reader time to finish (we can't detect when it's done).
  const spoken = speak(prep);
  await new Promise((r) => { prepTimer = setTimeout(r, 4500); });
  await spoken;
  if (state !== "preparing") return;

  await startTone();
  if (state !== "preparing") return;

  const chunks = [];
  recorder = new MediaRecorder(micStream);
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = async () => {
    releaseMic();
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    await stopTone();
    await identifyBlob(blob, "Got it. Identifying the bird. This takes a few seconds.");
  };
  recorder.start();
  state = "recording";
  stopTimer = setTimeout(finishRecording, MAX_RECORD_SECONDS * 1000);
}

function cancelPreparing() {
  clearTimeout(prepTimer);
  stopSpeaking();
  releaseMic();
  state = "idle";
  setRecordButton(false);
  announce("Recording cancelled.");
}

function finishRecording() {
  if (state !== "recording") return;
  clearTimeout(stopTimer);
  state = "processing";
  setRecordButton(false);
  recorder.stop(); // continues in recorder.onstop
}

function releaseMic() {
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
}

// ------------------------------------------------------------------ upload
function onFileChosen() {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = ""; // allow choosing the same file again
  if (!file) return;
  if (state === "recording" || state === "preparing") {
    announce("Please stop recording first.");
    return;
  }
  if (state === "processing") {
    announce("Still identifying the last clip. Please wait.");
    return;
  }
  stopSpeaking();
  state = "processing";
  identifyBlob(file, `Got ${file.name}. Identifying the bird. This takes a few seconds.`);
}

// ------------------------------------------------------------------ audio → WAV
async function toWav(blob) {
  const raw = await blob.arrayBuffer();
  const decoded = await ctx().decodeAudioData(raw);
  const seconds = Math.min(decoded.duration, MAX_CLIP_SECONDS);
  if (seconds < 1) throw new Error("too-short");
  // Render through a mono 48 kHz context: resamples and mixes down in one step.
  const off = new OfflineAudioContext(1, Math.ceil(seconds * TARGET_RATE), TARGET_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
  const rendered = await off.startRendering();
  return encodeWav(rendered.getChannelData(0), TARGET_RATE);
}

function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0, o = 44; i < samples.length; i++, o += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: "audio/wav" });
}

// ------------------------------------------------------------------ location
function getLocation() {
  return new Promise((resolve) => {
    if (!locationToggle.checked || !navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude }),
      () => resolve(null),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60 * 60 * 1000 },
    );
  });
}

function onLocationToggle() {
  saveSettings();
  if (!locationToggle.checked) {
    announce("Location off.");
    return;
  }
  if (!navigator.geolocation) {
    locationToggle.checked = false;
    saveSettings();
    announce("This browser can't share location. Location is off.");
    return;
  }
  announce("Checking your location.");
  navigator.geolocation.getCurrentPosition(
    () => announce("Location on. Results will favor birds found near you this time of year."),
    () => {
      locationToggle.checked = false;
      saveSettings();
      announce("I couldn't get your location, so location is off. Identification still works without it.");
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 60 * 60 * 1000 },
  );
}

// ------------------------------------------------------------------ identify
async function identifyBlob(blob, message) {
  state = "processing";
  recordBtn.setAttribute("aria-disabled", "true");
  announce(message);
  const slow = setTimeout(() => announce("Still working…"), 9000);

  try {
    let wav;
    try {
      wav = await toWav(blob);
    } catch (e) {
      throw new Error(e.message === "too-short"
        ? "That clip was too short. Please use at least one second of audio."
        : "I couldn't read that audio file. Try a different file, such as an MP3 or WAV.");
    }

    const form = new FormData();
    form.append("audio", wav, "clip.wav");
    const loc = await getLocation();
    if (loc) { form.append("lat", loc.lat); form.append("lon", loc.lon); }

    let res;
    try {
      res = await fetch("/api/identify", { method: "POST", body: form });
    } catch {
      throw new Error("I couldn't reach the bird identifier. Is the server running?");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Something went wrong identifying that clip.");

    clearTimeout(slow);
    showResults(data);
  } catch (err) {
    clearTimeout(slow);
    announce(err.message);
    speak(err.message);
  } finally {
    state = "idle";
    recordBtn.removeAttribute("aria-disabled");
  }
}

function describe(r) {
  const name = r.confidence >= CONFIDENT ? `${r.common_name}.` : `Possibly ${r.common_name}, but I'm not sure.`;
  return r.mnemonic ? `${name} Memory phrase: ${r.mnemonic}.` : name;
}

function showResults(data) {
  stopPlayback();
  const results = data.results || [];
  resultBody.replaceChildren();
  resultSection.hidden = false;

  if (!results.length) {
    lastSpoken = "I couldn't identify a bird in that clip. Try getting closer to the bird, or record while it is calling, with less background noise.";
    lastOthers = "";
    const p = document.createElement("p");
    p.textContent = lastSpoken;
    resultBody.append(p);
  } else {
    const [top, ...rest] = results;
    // A clip often holds more than one bird. Mention other confident ones by
    // name; their memory phrases are one button press away.
    const alsoHeard = rest.filter((r) => r.confidence >= CONFIDENT).map((r) => r.common_name);
    lastSpoken = describe(top) +
      (alsoHeard.length ? ` I also heard: ${alsoHeard.join(", and ")}.` : "");
    lastOthers = rest.length
      ? "Other birds in this clip. " + rest.map(describe).join(" Next: ")
      : "";

    results.forEach((r, i) => resultBody.append(speciesBlock(r, i === 0)));

    // One-time tips per page visit, so regular users don't hear them every time.
    const tips = [];
    if (!tipsGiven.recordings) { tips.push("Press Tab to find recordings of its song and calls."); tipsGiven.recordings = true; }
    if (!locationToggle.checked && !tipsGiven.location) {
      tips.push("Tip: turning on location, in Settings, makes results more accurate.");
      tipsGiven.location = true;
    }
    if (tips.length) lastSpoken += " " + tips.join(" ");
  }

  othersBtn.hidden = !lastOthers;
  const extra = lastOthers ? " Press Hear other birds to learn more." : "";
  announce(lastSpoken + extra);
  speak(lastSpoken);
}
const tipsGiven = { recordings: false, location: false };

function speciesBlock(r, isTop) {
  const section = document.createElement("section");
  section.className = "species" + (isTop ? " top" : "");
  const id = "sp-" + r.scientific_name.replace(/\W+/g, "-");
  section.setAttribute("aria-labelledby", id);

  const h = document.createElement("h3");
  h.id = id;
  h.className = isTop ? "bird-name" : "bird-name small";
  h.textContent = r.common_name;
  const sci = document.createElement("p");
  sci.className = "sci-name";
  sci.lang = "la";
  sci.textContent = r.scientific_name;
  section.append(h, sci);

  if (r.mnemonic) {
    const m = document.createElement("p");
    m.className = "mnemonic";
    m.textContent = `“${r.mnemonic}”`;
    section.append(m);
  }
  const c = document.createElement("p");
  c.className = "confidence";
  c.textContent = r.confidence >= CONFIDENT ? "Confident match" : "Possible match — not certain";
  section.append(c);

  const recs = document.createElement("div");
  recs.className = "recordings";
  const rh = document.createElement("h4");
  rh.textContent = `Recordings of the ${r.common_name}`;
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = "Finding recordings…";
  recs.append(rh, note);
  section.append(recs);
  loadRecordings(r, recs, note);
  return section;
}

// ------------------------------------------------------------------ reference recordings
const player = new Audio();
player.preload = "none";
let playingBtn = null;

function seconds(n) { return n === 1 ? "1 second" : n < 90 ? `${n} seconds` : `${Math.round(n / 60)} minutes`; }

async function loadRecordings(r, container, note) {
  let list;
  try {
    const res = await fetch("/api/recordings?species=" + encodeURIComponent(r.scientific_name));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Couldn't load recordings.");
    list = data.recordings || [];
  } catch (err) {
    note.textContent = err.message || "Couldn't load recordings.";
    return;
  }
  if (!list.length) {
    note.textContent = "No recordings are available for this species yet.";
    return;
  }
  note.remove();
  const ul = document.createElement("ul");
  ul.className = "rec-list";
  list.forEach((rec) => {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "rec-btn";
    const desc = `${rec.kind}, ${seconds(rec.duration)}` + (rec.place ? `, recorded in ${rec.place}` : "");
    btn.dataset.desc = desc;
    btn.textContent = `Play ${desc}`;
    btn.addEventListener("click", () => togglePlayback(btn, rec));

    const credit = document.createElement("p");
    credit.className = "credit";
    credit.append(`Recorded by ${rec.artist}${rec.license ? ", " + rec.license : ""}. `);
    if (rec.source) {
      const a = document.createElement("a");
      a.href = rec.source;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Source on Wikimedia Commons (opens in a new tab)";
      credit.append(a);
    }
    li.append(btn, credit);
    ul.append(li);
  });
  container.append(ul);
}

function setPlaying(btn, on) {
  btn.textContent = `${on ? "Stop" : "Play"} ${btn.dataset.desc}`;
  btn.classList.toggle("playing", on);
}

function stopPlayback() {
  if (!playingBtn) return;
  player.pause();
  setPlaying(playingBtn, false);
  playingBtn = null;
}

function togglePlayback(btn, rec) {
  stopSpeaking();
  if (playingBtn === btn) { stopPlayback(); return; }
  stopPlayback();
  if (state === "recording" || state === "preparing") {
    announce("Please stop recording first.");
    return;
  }
  playingBtn = btn;
  setPlaying(btn, true);
  player.src = rec.url;
  player.play().catch(() => {
    if (playingBtn === btn) { setPlaying(btn, false); playingBtn = null; }
    announce("Sorry, that recording couldn't be played.");
  });
}

player.addEventListener("ended", () => {
  if (!playingBtn) return;
  setPlaying(playingBtn, false);
  playingBtn = null;
  announce("Recording finished.");
});
player.addEventListener("error", () => {
  if (!playingBtn) return;
  setPlaying(playingBtn, false);
  playingBtn = null;
  announce("Sorry, that recording couldn't be played. You may be offline.");
});

// ------------------------------------------------------------------ wiring
recordBtn.addEventListener("click", onRecordPress);
fileInput.addEventListener("change", onFileChosen);
replayBtn.addEventListener("click", () => { stopPlayback(); announce(lastSpoken); speak(lastSpoken); });
othersBtn.addEventListener("click", () => { stopPlayback(); announce(lastOthers); speak(lastOthers); });
stopSpeakingBtn.addEventListener("click", () => { stopSpeaking(); stopPlayback(); announce("Stopped."); });
voiceToggle.addEventListener("change", () => {
  saveSettings();
  announce(voiceToggle.checked ? "App voice on." : "App voice off.");
});
rateSelect.addEventListener("change", () => { saveSettings(); speak("This is the new speaking speed."); });
locationToggle.addEventListener("change", onLocationToggle);
// Escape silences everything: the app's voice and any recording playing.
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { stopSpeaking(); stopPlayback(); } });

loadSettings();
