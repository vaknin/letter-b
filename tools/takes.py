# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = ["omnivoice==0.2.1", "torch==2.8.0", "torchaudio==2.8.0", "soundfile"]
# [tool.uv.sources]
# torch = { index = "pytorch-cpu" }
# torchaudio = { index = "pytorch-cpu" }
# [[tool.uv.index]]
# name = "pytorch-cpu"
# url = "https://download.pytorch.org/whl/cpu"
# explicit = true
# ///
# Records several takes of every word and line with one OmniVoice voice (k2-fsa/OmniVoice, the default
# engine of VoiceStudio), so Aviv can pick the best take of each on voices-pick.html.
# Python because OmniVoice only ships as a PyTorch model; there is no Rust or ONNX path for it.
#   uv run tools/takes.py ref     design the voice: a boy of about 8 (tools/takes/voice-ref.wav)
#   uv run tools/takes.py takes   record every take into tools/takes/ (skips takes already there)
#   uv run tools/takes.py page    build voices-pick.html from tools/takes/
# Then: uv run tools/apply_picks.py "book 3 · bag 1 · he1 2"  (see that file).
# Runs on the CPU; needs ffmpeg and node. The voice is designed once from words, then cloned for every
# take, so all takes are the same boy; takes differ by STYLES (speed, punctuation, sampling).
import base64, html, json, os, subprocess, sys, tempfile, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TAKES = Path(os.environ.get("TAKES_DIR", ROOT / "tools" / "takes"))
DEVICE = os.environ.get("DEVICE", "cpu")  # "cuda" on a rented GPU
REF, REF_TEXT = ROOT / "tools" / "takes" / "voice-ref.wav", "Hi! I'm so happy to see you. Look, a big red ball and a yellow banana. Let's play together!"
# The English boy cloned into Hebrew has an English accent and drops single words, so Hebrew clones its own
# reference: the same description without "american accent", designed in Hebrew.
HE_REF, HE_REF_TEXT = ROOT / "tools" / "takes" / "voice-ref-he.wav", "שלום חברים! היום נלמד את האות בּ. תסתכלו, כדור גדול ובננה צהובה. בואו נשחק ביחד!"
VOICE = os.environ.get("VOICE", "male, child, american accent")  # fallback: "female, child, american accent"
VOICE_HE = os.environ.get("VOICE_HE", "male, child")
REF_SEED = int(os.environ.get("REF_SEED", "4"))
HE_REF_SEED = int(os.environ.get("HE_REF_SEED", "5"))  # of 5 seeds, the one Whisper heard best
# Take n of a line is said in style n. "end" replaces a bare word's full stop ("ball." / "ball!").
STYLES = {
    1: {"name": "calm", "speed": 0.80, "end": "."},
    2: {"name": "happy", "speed": 0.80, "end": "!"},
    3: {"name": "slow", "speed": 0.75, "end": "."},
    4: {"name": "bright", "speed": 0.90, "end": "!"},
    5: {"name": "free", "speed": 0.80, "end": ".", "class_temperature": 0.5},
}
# Takes whose first seed came out as noise, a wrong word or too short (checked with Whisper), and the seed that came out right.
SEEDS = {"book 2": 12, "book 3": 23, "bag 5": 35, "ball 3": 33, "dog 4": 34, "dog 5": 25, "sun 2": 12, "sun 3": 13, "sun 5": 25, "fish 2": 42, "apple 1": 31, "apple 2": 22, "apple 4": 34, "what 2": 12, "itsa 2": 52, "pop 1": 21, "pop 2": 12, "buh 1": 11, "buh 2": 72, "buh 3": 43, "he1 1": 41, "he1 2": 22, "he1 3": 53, "he4 1": 11, "he4 3": 13, "he5 1": 41, "he5 3": 13, "he9 1": 41, "he9 2": 72, "he10 1": 31, "he10 2": 32, "he10 3": 13, "he11 1": 31, "he11 2": 12, "he11 3": 13, "he13 2": 22, "he14 1": 11, "he14 3": 13}
# The sentences on the picker, by their key in the copy line. Texts are the site's own CLIPS keys.
SENTENCES = {"what": "What is it?", "itsa": "It's a ball.", "pop": "Pop the... balloon!", "buh": "B. Buh."}


def lesson():
    """LESSON, PHRASES(LESSON) and the site's own strings, read from index.html through node."""
    src = (ROOT / "index.html").read_text()
    code = src[src.index("const LESSON = {"):src.index("/* CLIPS:BEGIN")]
    js = code + "\nconsole.log(JSON.stringify({L: LESSON, phrases: PHRASES(LESSON)}));"
    return json.loads(subprocess.run(["node", "-e", js], capture_output=True, text=True, check=True).stdout)


def items():
    """Every line on the picker: (key, text, lang, takes). Hebrew keys he1.. are LESSON.hebrew then the word meanings."""
    if os.environ.get("ITEMS"):  # a box without node or index.html gets the list as a file (takes.py items > F)
        return [tuple(x) for x in json.loads(Path(os.environ["ITEMS"]).read_text())]
    d = lesson()["L"]
    out = [(w["id"], w["id"], "en", 5) for w in d["words"] + d["notB"]]
    out += [(k, s, "en", 3) for k, s in SENTENCES.items()]
    he = list(d["hebrew"].values()) + [w["he"] for w in d["words"]]
    out += [(f"he{k + 1}", t, "he", 3) for k, t in enumerate(he)]
    return out


def slug(key):
    return "".join(c for c in key.lower().replace(" ", "-") if c.isalnum() or c == "-").strip("-")


_model, _prompt, _prompt_he = None, None, None


def model():
    global _model, _prompt, _prompt_he
    if _model is None:
        import torch
        from omnivoice import OmniVoice
        torch.set_num_threads(int(os.environ.get("THREADS", "6")))
        _model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map=DEVICE, dtype=torch.float16 if DEVICE == "cuda" else torch.float32)
        if REF.exists():
            _prompt = _model.create_voice_clone_prompt(ref_audio=str(REF), ref_text=REF_TEXT)
        if HE_REF.exists():
            _prompt_he = _model.create_voice_clone_prompt(ref_audio=str(HE_REF), ref_text=HE_REF_TEXT)
    return _model


def to_mp3(wav, out):
    """Silence cut at both ends, loudness to -16 LUFS, mono 24 kHz mp3 at 64 kbps."""
    trim = "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05"
    af = f"{trim},areverse,{trim},areverse,loudnorm=I=-16:TP=-1.5:LRA=11,adelay=40"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", wav, "-af", af, "-ac", "1", "-ar", "24000", "-b:a", "64k", str(out)], check=True)


def say(text, lang, style, out, seed=0):
    """Records TEXT in the cloned voice, in STYLES[style], into OUT (mp3). Returns the seconds it took."""
    import soundfile as sf, torch
    from omnivoice.models.omnivoice import OmniVoiceGenerationConfig
    m, st = model(), STYLES[style]
    if lang == "en" and " " not in text and text[-1:].isalpha():
        text = text + st["end"]
    cfg = OmniVoiceGenerationConfig(class_temperature=st.get("class_temperature", 0.0))
    torch.manual_seed(seed or style)
    t = time.time()
    voice = {"voice_clone_prompt": _prompt_he if lang == "he" else _prompt}
    # OmniVoice guesses a clip's length from the text, and for a short line the guess is too short: the
    # word comes out clipped or empty (a lower speed makes it shorter still). A short line gets a length
    # from its letters, slowed by the style; about half of it comes out as speech, the rest is cut as silence.
    if len(text) < 25:
        voice["duration"] = (0.5 + (0.11 if lang == "he" else 0.08) * len(text)) / st["speed"]
    else:
        voice["speed"] = st["speed"]
    a = m.generate(text=text, language=lang, generation_config=cfg, **voice)[0]
    dt = time.time() - t
    with tempfile.NamedTemporaryFile(suffix=".wav") as f:
        sf.write(f.name, a, 24000)
        to_mp3(f.name, out)
    return dt


def cmd_ref(lang="en", seed=None):
    """Designs the voice from words (VOICE, VOICE_HE) and keeps one clip as the reference every take clones."""
    import soundfile as sf, torch
    ref, text, voice = (REF, REF_TEXT, VOICE) if lang == "en" else (HE_REF, HE_REF_TEXT, VOICE_HE)
    seed = seed or (REF_SEED if lang == "en" else HE_REF_SEED)
    ref.parent.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(seed)
    a = model().generate(text=text, instruct=voice, language=lang, speed=0.85)[0]
    sf.write(ref, a, 24000)
    print(f"{ref.name}: {len(a) / 24000:.1f} s of '{voice}', seed {seed}")


def cmd_takes():
    if not REF.exists():
        sys.exit("no voice yet: run `uv run tools/takes.py ref` first")
    man_f = TAKES / "takes.json"
    man = json.loads(man_f.read_text()) if man_f.exists() else {}
    for key, text, lang, n in items():
        for k in range(1, n + 1):
            out = TAKES / f"{slug(key)}-{k}.mp3"
            if out.exists() and f"{key} {k}" in man:
                continue
            seed = SEEDS.get(f"{key} {k}", k)
            dt = say(text, lang, k, out, seed)
            man[f"{key} {k}"] = {"text": text, "lang": lang, "style": k, "seed": seed, "file": out.name, "secs": round(dt, 1)}
            man_f.write_text(json.dumps(man, ensure_ascii=False, indent=1) + "\n")
            print(f"{key} {k}: {dt:.1f} s", flush=True)
    secs = [v["secs"] for v in man.values() if v["secs"] is not None] or [0]
    print(f"{len(secs)} takes, {sum(secs) / len(secs):.1f} s each on average, {sum(secs) / 60:.1f} min in all")


def cmd_page():
    man = json.loads((TAKES / "takes.json").read_text())
    rows = []
    for key, text, lang, n in items():
        uris = []
        for k in range(1, n + 1):
            b = (TAKES / man[f"{key} {k}"]["file"]).read_bytes()
            uris.append("data:audio/mpeg;base64," + base64.b64encode(b).decode())
        kind = "he" if lang == "he" else "sentence" if key in SENTENCES else "word"
        rows.append({"key": key, "text": text, "lang": lang, "kind": kind, "takes": uris})
    tpl = (ROOT / "tools" / "voices-pick.tpl.html").read_text()
    page = tpl.replace("/*ROWS*/[]", json.dumps(rows, ensure_ascii=False)).replace("{{VOICE}}", html.escape(VOICE))
    (ROOT / "voices-pick.html").write_text(page)
    print(f"voices-pick.html: {len(rows)} rows, {len(page) / 1024:.0f} KB")


if __name__ == "__main__":
    {"ref": cmd_ref, "ref-he": lambda: cmd_ref("he"), "takes": cmd_takes, "page": cmd_page,
     "items": lambda: print(json.dumps(items(), ensure_ascii=False))}[sys.argv[1] if len(sys.argv) > 1 else "takes"]()
