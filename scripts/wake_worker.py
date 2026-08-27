"""Wake word worker: one model, resident, scoring a stream of microphone audio.

Her name went through whisper before this existed, and whisper is a general
transcriber being asked a question it cannot answer. It has never seen "Vela",
so it wrote back the nearest English it knew and the wake word never saw the
name at all. Priming it with the name fixed that and broke the other half: a
decoder told to expect a rare word writes that word out of room tone, and she
started answering an empty room. One knob, two failures, pulling opposite ways.

openWakeWord answers exactly one question and returns one number for it. A
frame is 80ms of audio and comes back scored between 0 and 1, which is the
confidence the whole arrangement was missing.

Protocol, raw bytes in, one line out per event:
    in : 16-bit signed mono PCM at 16kHz, straight off ffmpeg's pipe
    out: ready              (the model is loaded and scoring)
         wake <score>       (a frame crossed the threshold)
         err <message>

stdout is the protocol channel; everything else must go to stderr or it
corrupts the stream.
"""
import sys

import numpy as np

# 80ms at 16kHz, which is the frame size the models were trained on. Anything
# else is resampled internally and costs accuracy for no gain.
FRAME = 1280
WIDTH = 2  # 16-bit

model_name = sys.argv[1] if len(sys.argv) > 1 else "hey_jarvis"
threshold = float(sys.argv[2]) if len(sys.argv) > 2 else 0.5
# Silero, bundled with openWakeWord. A score only counts when a real
# voice-activity model agrees something was spoken, which is the half the old
# loudness floor could never do: a door closing is loud and is not speech.
vad = float(sys.argv[3]) if len(sys.argv) > 3 else 0.5

try:
    from openwakeword.model import Model

    model = Model(
        wakeword_models=[model_name],
        inference_framework="onnx",
        vad_threshold=vad,
    )
    # The key the scores come back under: a path becomes its filename, a
    # bundled name stays as it is.
    key = list(model.models.keys())[0]
except Exception as exc:  # noqa: BLE001 - report and exit, don't hang silently
    print(f"err {exc}", flush=True)
    sys.exit(1)

print("ready", flush=True)

stream = sys.stdin.buffer
# True while a detection is still sounding, so one spoken phrase reports once
# rather than once per frame for as long as it stays above the line.
firing = False

while True:
    chunk = stream.read(FRAME * WIDTH)
    if not chunk or len(chunk) < FRAME * WIDTH:
        break
    try:
        audio = np.frombuffer(chunk, dtype=np.int16)
        score = float(model.predict(audio).get(key, 0.0))
    except Exception as exc:  # noqa: BLE001 - one bad frame must not end the stream
        print(f"err {exc}", flush=True)
        continue

    if score >= threshold:
        if not firing:
            firing = True
            print(f"wake {score:.3f}", flush=True)
            # Everything before the trigger belongs to the phrase that just
            # fired. Left in, the next phrase is scored against audio she has
            # already answered.
            model.reset()
    elif firing and score < threshold * 0.5:
        # Hysteresis: coming back down through the same number the frame went
        # up through would re-arm on the tail of the word that just fired.
        firing = False
