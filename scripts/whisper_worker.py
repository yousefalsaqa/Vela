"""Whisper transcription worker: load the model once, then listen on demand.

The CLI reloads the model on every utterance, which put about a second of dead
air between Yousef finishing a sentence and Vela starting to think about it.
This keeps the model resident, the same way the Kokoro worker does for speech.

Protocol, one JSON object per line in, one status line out:
    in : {"pcm": "C:/tmp/take.pcm", "rate": 16000}
    out: ok {"text": "open the fantasy project", "silence": 0.02, "logprob": -0.31}
         err <message>

The two numbers beside the text are how sure the decoder was that it was
decoding anything at all. Whisper does not return nothing when handed room
tone: it returns a sentence, confidently punctuated, that was never said. The
text alone cannot be told apart from speech, so the caller needs the numbers to
throw it away. See `silence` and `logprob` below for what they mean.

Audio arrives as raw signed 16-bit mono PCM — no container. The recorder pipes
it straight out of ffmpeg, so there is no header to finalise and no wait for
the capture device to shut down.

stdout is the protocol channel; everything else must go to stderr or it
corrupts the stream.
"""
import json
import sys

import numpy as np
from faster_whisper import WhisperModel

model_name = sys.argv[1] if len(sys.argv) > 1 else "base.en"
device = sys.argv[2] if len(sys.argv) > 2 else "cpu"
# Words whisper has no reason to expect and gets wrong every time. Biasing the
# decoder with them is worth more than a bigger model: measured over five
# sentences of his own vocabulary, base.en went from 9.8% to 7.3% word error,
# which is what small.en scores at three times the cost.
vocabulary = sys.argv[3] if len(sys.argv) > 3 else ""
# int8 on CPU is roughly twice as fast as float32 and the difference is not
# audible on a few seconds of close-mic speech.
compute_type = "int8" if device == "cpu" else "float16"

model = WhisperModel(model_name, device=device, compute_type=compute_type)

# Warm the graph, so the first real utterance isn't slower than the rest. The
# arguments have to match the real ones: vad_filter pulls in a second model
# (silero, through onnxruntime) and warming without it just moved that load
# onto the first thing he actually said.
try:
    for _ in model.transcribe(
        np.zeros(16000, dtype=np.float32),
        language="en",
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=False,
    )[0]:
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
        with open(request["pcm"], "rb") as handle:
            raw = handle.read()

        # int16 -> the float32 in [-1, 1] that whisper expects.
        audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

        segments, _ = model.transcribe(
            audio,
            language="en",
            # A beam of 1 saves ~25ms and costs 2.4 points of word error. He
            # notices the errors and not the 25ms.
            beam_size=5,
            initial_prompt=vocabulary or None,
            # Trim the silence either side of the push-to-talk press. Less audio
            # to decode, and fewer of the hallucinations whisper produces when
            # handed room tone.
            vad_filter=True,
            # Each utterance is its own instruction. Carrying the last one over
            # is how whisper talks itself into repeating a previous sentence.
            condition_on_previous_text=False,
        )
        # Consumed once: the generator decodes lazily, so the segments have to
        # be held to be measured as well as joined.
        found = list(segments)
        text = " ".join(segment.text.strip() for segment in found).strip()

        # How sure it was that the audio was silence, and how likely it thought
        # the words it chose were.
        #
        # Taken at their worst rather than averaged. A hallucination is usually
        # one confident segment riding alongside a doubtful one, and a mean
        # lets the confident half hide the other. The caller is deciding
        # whether this was speech at all, so it should see the weakest link.
        silence = max((segment.no_speech_prob for segment in found), default=1.0)
        logprob = min((segment.avg_logprob for segment in found), default=-10.0)
        print(
            f"ok {json.dumps({'text': text, 'silence': silence, 'logprob': logprob})}",
            flush=True,
        )
    except Exception as exc:  # noqa: BLE001 - one bad line must not kill the worker
        print(f"err {exc}", flush=True)
