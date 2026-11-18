"""Birding by Ear — backend.

Receives one short audio clip, runs BirdNET on it, and returns the most likely
species plus the memory phrase (mnemonic) from mnemonics.json.

Run with:  uv run python server.py   then open http://localhost:8000
"""

from __future__ import annotations

import csv
import html
import datetime as dt
import json
import logging
import math
import re
import tempfile
import threading
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from pathlib import Path

import birdnet
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).parent
STATIC = ROOT / "static"
MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # ~2 min of 48 kHz mono 16-bit WAV

# A species must reach this confidence in at least one 3-second window to count.
MIN_CONFIDENCE = 0.25
# Geo model: species below this "expected here this week" score are filtered out
# (0.03 is BirdNET-Analyzer's default location filter threshold).
GEO_THRESHOLD = 0.03

log = logging.getLogger("birding-by-ear")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")


# ---------------------------------------------------------------- mnemonics
def load_mnemonics() -> dict[str, str]:
    with open(ROOT / "mnemonics.json", encoding="utf-8") as f:
        data = json.load(f)
    # Case-insensitive lookup on the common name.
    return {name.strip().casefold(): phrase for name, phrase in data.items()}


MNEMONICS = load_mnemonics()


# ---------------------------------------------------------------- BirdNET
_models: dict[str, object] = {}
_model_lock = threading.Lock()  # BirdNET calls are not guaranteed thread-safe


def acoustic_model():
    if "acoustic" not in _models:
        log.info("Loading BirdNET acoustic model (first run downloads it)…")
        _models["acoustic"] = birdnet.load("acoustic", "2.4", "tf", library="litert")
    return _models["acoustic"]


def geo_model():
    if "geo" not in _models:
        log.info("Loading BirdNET location model…")
        _models["geo"] = birdnet.load("geo", "2.4", "tf", library="litert")
    return _models["geo"]


def read_csv_rows(predictions) -> list[dict[str, str]]:
    """BirdNET documents to_csv() as its stable output format, so we use it."""
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "out.csv"
        predictions.to_csv(str(out))
        with open(out, newline="", encoding="utf-8") as f:
            return list(csv.DictReader(f))


def split_name(species_name: str) -> tuple[str, str]:
    """'Turdus migratorius_American Robin' -> ('Turdus migratorius', 'American Robin')."""
    scientific, _, common = species_name.partition("_")
    return scientific.strip(), (common or scientific).strip()


def birdnet_week(today: dt.date) -> int:
    """BirdNET uses a 48-week year: four 'weeks' per month."""
    return (today.month - 1) * 4 + min(4, math.ceil(today.day / 7))


def species_expected_here(lat: float, lon: float) -> set[str]:
    week = birdnet_week(dt.date.today())
    rows = read_csv_rows(geo_model().predict(lat, lon, week=week))
    return {
        r["species_name"] for r in rows if float(r["confidence"]) >= GEO_THRESHOLD
    }


def identify(wav_path: Path, lat: float | None, lon: float | None) -> dict:
    with _model_lock:
        rows = read_csv_rows(acoustic_model().predict(str(wav_path)))
        allowed = None
        location_used = False
        if lat is not None and lon is not None:
            try:
                allowed = species_expected_here(lat, lon)
                location_used = True
            except Exception:  # location is a nice-to-have; never fail on it
                log.exception("Location filter failed; continuing without it")

    # Best confidence per species across all 3-second windows.
    best: dict[str, float] = {}
    for r in rows:
        name = r["species_name"]
        conf = float(r["confidence"])
        scientific, common = split_name(name)
        # Non-bird classes (Engine_Engine, Dog_Dog, Human vocal_Human vocal, …)
        # repeat the same text on both sides; never report them as a species.
        if scientific == common:
            continue
        if allowed is not None and name not in allowed:
            continue
        best[name] = max(conf, best.get(name, 0.0))

    ranked = sorted(
        ((n, c) for n, c in best.items() if c >= MIN_CONFIDENCE),
        key=lambda nc: nc[1],
        reverse=True,
    )

    results = []
    for name, conf in ranked[:3]:
        scientific, common = split_name(name)
        results.append(
            {
                "common_name": common,
                "scientific_name": scientific,
                "confidence": round(conf, 3),
                "mnemonic": MNEMONICS.get(common.casefold()),
            }
        )
    return {"results": results, "location_used": location_used}


# ---------------------------------------------------------------- reference recordings
# BirdNET ships no example audio, so reference songs and calls come from
# Wikimedia Commons: freely licensed, no API key, many recordings mirrored from
# xeno-canto with a "Type: song / call" field. Commons also provides an MP3
# copy of every file, which every browser can play.
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
USER_AGENT = "BirdingByEar/0.1 (local accessibility app)"
_recording_cache: dict[str, list[dict]] = {}


def _strip_html(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html.unescape(s or ""))).strip()


def _desc_lines(s: str) -> str:
    """Like _strip_html, but each HTML element becomes its own line, so the
    "Type: song" / "Location: ..." fields from xeno-canto stay separate."""
    text = re.sub(r"<[^>]+>", "\n", html.unescape(s or ""))
    return "\n".join(line.strip() for line in text.splitlines() if line.strip())


def _field(desc: str, label: str) -> str | None:
    m = re.search(rf"^{label}:\s*(.+)$", desc, re.MULTILINE)
    return m.group(1).strip() if m else None


def _kind(desc_type: str | None, title: str) -> str:
    text = f"{desc_type or ''} {title}".lower()
    if "song" in text:
        return "song"
    if "drum" in text:
        return "drumming"
    if "call" in text:
        return "call"
    return "recording"


def fetch_recordings(scientific: str) -> list[dict]:
    key = scientific.casefold()
    if key in _recording_cache:
        return _recording_cache[key]

    params = urllib.parse.urlencode({
        "action": "query", "format": "json", "formatversion": "2",
        "generator": "search", "gsrnamespace": "6", "gsrlimit": "40",
        "gsrsearch": f'"{scientific}" filetype:audio',
        "prop": "videoinfo", "viprop": "url|mime|extmetadata|derivatives|size",
    })
    req = urllib.request.Request(f"{COMMONS_API}?{params}", headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=10) as resp:
        pages = json.load(resp).get("query", {}).get("pages", [])

    found = []
    for p in pages:
        title = p.get("title", "")
        if scientific.casefold() not in title.casefold():
            continue  # search is fuzzy; keep only files named for this species
        info = (p.get("videoinfo") or [{}])[0]
        meta = info.get("extmetadata", {})
        desc = _desc_lines(meta.get("ImageDescription", {}).get("value", ""))
        duration = info.get("duration")
        if not duration or duration < 2 or duration > 180:
            continue
        mp3 = next((d["src"] for d in info.get("derivatives", []) if d.get("type") == "audio/mpeg"), None)
        url = mp3 or info.get("url")
        if not url:
            continue
        place = _field(desc, "Location")
        country = _field(desc, "Country")
        region = place.split(",")[-1].strip() if place else None
        artist = _strip_html(meta.get("Artist", {}).get("value", ""))
        artist = artist[:80] if artist else "Unknown"
        if re.fullmatch(r"(Unknown author\s*)+", artist):
            artist = "Unknown"
        found.append({
            "kind": _kind(_field(desc, "Type"), title),
            "duration": round(duration),
            "place": region or country,
            "url": url,
            "artist": artist,
            "license": meta.get("LicenseShortName", {}).get("value", ""),
            "source": info.get("descriptionurl") or "",
        })

    # Prefer clips of 5 to 60 seconds, then up to 2 songs, 2 calls and 1 other.
    found.sort(key=lambda r: (not 5 <= r["duration"] <= 60, r["duration"]))
    limits = {"song": 2, "call": 2, "drumming": 1, "recording": 1}
    picked, counts = [], {}
    for r in found:
        if counts.get(r["kind"], 0) < limits[r["kind"]]:
            counts[r["kind"]] = counts.get(r["kind"], 0) + 1
            picked.append(r)
    order = {"song": 0, "call": 1, "drumming": 2, "recording": 3}
    picked.sort(key=lambda r: order[r["kind"]])
    _recording_cache[key] = picked
    return picked


# ---------------------------------------------------------------- web app
@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Load the model at startup so the first identification isn't extra slow.
    acoustic_model()
    yield


app = FastAPI(title="Birding by Ear", lifespan=lifespan)


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.post("/api/identify")
def api_identify(
    audio: UploadFile = File(...),
    lat: float | None = Form(None),
    lon: float | None = Form(None),
):
    data = audio.file.read(MAX_UPLOAD_BYTES + 1)
    if not data:
        raise HTTPException(400, "The audio clip was empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "That clip is too long. Please use under two minutes.")

    # Round location to ~10 km: plenty for range filtering, kinder to privacy.
    if lat is not None and lon is not None:
        lat, lon = round(lat, 1), round(lon, 1)

    with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
        tmp.write(data)
        tmp.flush()
        try:
            return identify(Path(tmp.name), lat, lon)
        except Exception:
            log.exception("BirdNET failed")
            raise HTTPException(
                500, "Sorry, the bird identifier had a problem with that clip."
            )


@app.get("/api/recordings")
def api_recordings(species: str):
    """Reference recordings for one species, by scientific name."""
    species = species.strip()
    if not re.fullmatch(r"[A-Za-z][A-Za-z .\-]{2,80}", species):
        raise HTTPException(400, "Unknown species name.")
    try:
        return {"recordings": fetch_recordings(species)}
    except Exception:
        log.exception("Fetching recordings failed")
        raise HTTPException(502, "Couldn't reach the recordings library. Are you online?")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


if __name__ == "__main__":  # guard needed: BirdNET uses 'spawn' multiprocessing
    uvicorn.run(app, host="127.0.0.1", port=8000)
