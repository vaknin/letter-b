# Slows every clip in index.html's CLIPS by PCT percent, pitch kept (ffmpeg rubberband), so a non-native
# class hears the words more slowly without the voice getting deeper. Aviv, 2026-11-04: "make sure the
# boy voice ... is also slowed down like the girl Ana, start with 15%".
#   python3 tools/slow.py 15     # 15% slower than the recorded takes
# Always works from the unslowed clips, kept in tools/takes/clips-raw.json the first time it runs after
# tools/apply_picks.py, so running it again with another number never stacks the slowdowns.
import base64, json, re, subprocess, sys, tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILE, RAW = ROOT / "index.html", ROOT / "tools" / "takes" / "clips-raw.json"
BEGIN, END = "/* CLIPS:BEGIN", "/* CLIPS:END */"


def main():
    if len(sys.argv) != 2 or not 0 <= float(sys.argv[1]) < 60:
        sys.exit("usage: python3 tools/slow.py PCT   (0-59, e.g. 15)")
    pct = float(sys.argv[1])
    src = FILE.read_text()
    a, b = src.index(BEGIN), src.index(END)
    blk = src[a:b]
    head = blk.split("\n", 1)[0]
    if "slowed" not in head:  # fresh from apply_picks.py: these are the raw clips
        pairs = re.findall(r'^\s*("(?:[^"\\]|\\.)*"):\s*"data:audio/mpeg;base64,([A-Za-z0-9+/=]+)"', blk, re.M)
        RAW.write_text(json.dumps({"head": head, "clips": {json.loads(k): v for k, v in pairs}}, ensure_ascii=False, indent=0))
    raw = json.loads(RAW.read_text())
    out = {}
    with tempfile.TemporaryDirectory() as d:
        for text, b64 in raw["clips"].items():
            i, o = Path(d, "i.mp3"), Path(d, "o.mp3")
            i.write_bytes(base64.b64decode(b64))
            if pct:
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(i), "-af",
                                f"rubberband=tempo={1 - pct / 100:.4f}:pitch=1", "-ac", "1", "-b:a", "64k", str(o)], check=True)
            else:
                o.write_bytes(i.read_bytes())
            out[text] = base64.b64encode(o.read_bytes()).decode()
    body = ",\n".join(f'  {json.dumps(t)}: "data:audio/mpeg;base64,{v}"' for t, v in out.items())
    new = f"{raw['head'].rstrip()[:-2].rstrip()}; slowed {pct:g}% by tools/slow.py */\nconst CLIPS = {{\n{body}\n}};\n"
    FILE.write_text(src[:a] + new + src[b:])
    print(f"{len(out)} clips slowed {pct:g}%")


if __name__ == "__main__":
    main()
