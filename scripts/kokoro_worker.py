"""Kokoro speech worker: load the model once, then synthesise on demand.

Vela speaks a sentence at a time, and loading the model costs ~1.2s. Spawning
a process per sentence would pay that every time, so this stays warm and reads
requests from stdin instead.

Protocol, one JSON object per line in, one status line out:
    in : {"text": "Morning, Yoosef.", "out": "C:/tmp/1.wav", "voice": "bf_emma"}
    out: ok C:/tmp/1.wav        (the file is written and closed)
         err <message>          (nothing was written)

stdout is the protocol channel; everything else must go to stderr or it
corrupts the stream.
"""
import json
import sys

import numpy as np
import soundfile as sf
from kokoro import KPipeline

SAMPLE_RATE = 24000

# 'b' is British English. Kokoro's American voices need 'a'.
pipeline = KPipeline(lang_code="b")
default_voice = sys.argv[1] if len(sys.argv) > 1 else "bf_emma"
speed = float(sys.argv[2]) if len(sys.argv) > 2 else 1.1

# Warm the graph so the first real sentence isn't slower than the rest.
try:
    for _ in pipeline("Ready.", voice=default_voice, speed=speed):
        pass
except Exception as exc:  # noqa: BLE001 - report and keep serving
    print(f"err warm-up failed: {exc}", flush=True)

print("ready", flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        request = json.loads(line)
        text = request["text"]
        out = request["out"]
        voice = request.get("voice", default_voice)

        chunks = [audio for _, _, audio in pipeline(text, voice=voice, speed=speed)]
        if not chunks:
            print("err no audio produced", flush=True)
            continue

        sf.write(out, np.concatenate(chunks), SAMPLE_RATE)
        print(f"ok {out}", flush=True)
    except Exception as exc:  # noqa: BLE001 - one bad line must not kill the worker
        print(f"err {exc}", flush=True)
