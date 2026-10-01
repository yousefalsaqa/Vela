"""Voiceprint worker: who said that, as a vector, resident.

Every utterance the wake word's gate cuts out of the room comes here while
whisper is reading it, and leaves as a voiceprint: 192 numbers that are close
together for one person and far apart for two. Comparing them, saving them and
deciding what counts as close is done on the Node side, in src/voices.ts, where
it can be tested without a model. This only turns sound into the vector.

The model is NeMo's TitaNet-small through sherpa-onnx, which the wake word's
venv already has. Measured before it went in, on real speech from five people
(sherpa-onnx's own speaker-identification set): no errors on whole clips, 1.4%
equal error rate on 2.5s of speech, 3.1% on 1.5s, 10.5% on 1s, about 7ms an
utterance on this machine. WeSpeaker's CAM++ models scored 25-48% under the
same test and are not usable here. 3D-Speaker's ERes2Net is as good and three
times slower; pass its path to use it instead.

Protocol, one JSON object per line in, one line out per request:
    in : {"id": 7, "pcm": "C:/tmp/7.pcm"}  (raw 16-bit mono at 16kHz, as the gate cut it)
    out: ok {"id": 7, "print": [...], "speech": 2.31}
         ok {"id": 7, "print": null, "speech": 0.4}  (too little voice to say anything)
         err {"id": 7, "error": "<message>"}
Startup prints "ready" once the model is loaded.

The id is echoed so a reply is matched to its request by name rather than by
position. Matched by position, one reply that never came puts every answer
after it on the wrong utterance, and here that is the wrong person.

stdout is the protocol channel; everything else must go to stderr or it
corrupts the stream.
"""
import json
import sys

import numpy as np
import sherpa_onnx

RATE = 16000
# 20ms frames for deciding which parts of the clip are him.
FRAME = RATE // 50
# The gate hands over a second of room in front and a second behind. Room tone
# says nothing about who is talking and pulls every print towards the same
# place, so only frames within this much of the loudest are kept.
KEEP_WITHIN_DB = 30.0
# Less voice than this and the print is noise: the error rate at one second of
# speech is already one in ten.
MIN_SPEECH = 0.5

model = sys.argv[1]
extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
    sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=model, num_threads=1)
)


def voiced(audio):
    """The frames that are speech, joined, with the room between them dropped."""
    usable = len(audio) // FRAME * FRAME
    if not usable:
        return audio[:0]
    frames = audio[:usable].reshape(-1, FRAME)
    level = 10 * np.log10(np.mean(frames**2, axis=1) + 1e-12)
    keep = level >= level.max() - KEEP_WITHIN_DB
    return frames[keep].reshape(-1)


def embed(audio):
    stream = extractor.create_stream()
    stream.accept_waveform(RATE, audio)
    stream.input_finished()
    return extractor.compute(stream)


# Warm the graph, so the first real utterance is not the slow one.
try:
    embed(np.random.default_rng(0).normal(0, 0.05, RATE).astype(np.float32))
except Exception as exc:  # noqa: BLE001 - report and keep serving
    print(f"err warm-up failed: {exc}", flush=True)

print("ready", flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    ident = None
    try:
        request = json.loads(line)
        ident = request.get("id")
        with open(request["pcm"], "rb") as handle:
            raw = handle.read()
        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        speech = voiced(audio)
        seconds = round(len(speech) / RATE, 2)
        vector = None
        if seconds >= MIN_SPEECH:
            vector = [round(float(x), 5) for x in embed(speech)]
        print(f"ok {json.dumps({'id': ident, 'print': vector, 'speech': seconds})}", flush=True)
    except Exception as exc:  # noqa: BLE001 - one bad line must not kill the worker
        print(f"err {json.dumps({'id': ident, 'error': str(exc)})}", flush=True)
