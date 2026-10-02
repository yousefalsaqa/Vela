"""Turn worker: has he finished, judged from how the end of what he said sounds.

The gate waits a fixed second of quiet before it decides he is done, because
he pauses mid-thought and being cut off costs the question. That second is
most of the wait between him finishing and her answering. Smart Turn
(pipecat-ai/smart-turn, v3.2, BSD-2) is a Whisper-tiny encoder with one
linear layer, trained to tell a finished sentence from a trailing "um..." by
its tone and pace. It answers in about 30ms on one CPU thread here.

Protocol, one JSON object per line in, one status line out:
    in : {"id": 3, "pcm": "C:/tmp/so-far.pcm", "rate": 16000}
    out: ok {"id": 3, "done": 0.93, "ms": 31}
         err {"id": 3, "error": "<message>"}

`done` is the model's probability that the turn is over. Audio is raw signed
16-bit mono PCM, everything said in the utterance so far.

The features are computed here rather than through faster_whisper's
FeatureExtractor, which imports the whole of faster_whisper (CTranslate2,
PyAV) to compute one spectrogram. These match transformers'
WhisperFeatureExtractor, which the model was trained on, to within 1e-6.

stdout is the protocol channel; everything else must go to stderr.
"""
import json
import sys
import time

import numpy as np
import onnxruntime as ort

RATE = 16000
SECONDS = 8
N = RATE * SECONDS
N_FFT = 400
HOP = 160


def mel_filters(n_mels=80):
    """Slaney mel filters, as librosa and Whisper build them."""
    fftfreqs = np.fft.rfftfreq(n=N_FFT, d=1.0 / RATE)
    mels = np.linspace(0.0, 45.245640471924965, n_mels + 2)
    f_sp = 200.0 / 3
    freqs = f_sp * mels
    min_log_hz = 1000.0
    min_log_mel = min_log_hz / f_sp
    logstep = np.log(6.4) / 27.0
    log_t = mels >= min_log_mel
    freqs[log_t] = min_log_hz * np.exp(logstep * (mels[log_t] - min_log_mel))
    fdiff = np.diff(freqs)
    ramps = freqs.reshape(-1, 1) - fftfreqs.reshape(1, -1)
    lower = -ramps[:-2] / fdiff[:-1, None]
    upper = ramps[2:] / fdiff[1:, None]
    weights = np.maximum(0.0, np.minimum(lower, upper))
    weights *= (2.0 / (freqs[2 : n_mels + 2] - freqs[:n_mels]))[:, None]
    return weights.astype(np.float32)


FILTERS = mel_filters()
WINDOW = np.hanning(N_FFT + 1)[:-1].astype(np.float32)


def features(audio):
    """Eight seconds ending now, as the model's log-mel input: (1, 80, 800)."""
    audio = audio[-N:]
    # Padding goes in front: the model reads the end of the clip as now.
    audio = np.pad(audio, (N - len(audio), 0))
    audio = (audio - audio.mean()) / np.sqrt(audio.var() + 1e-7)
    padded = np.pad(audio, N_FFT // 2, mode="reflect")
    count = 1 + (len(padded) - N_FFT) // HOP
    frames = np.lib.stride_tricks.as_strided(
        padded, shape=(count, N_FFT), strides=(padded.strides[0] * HOP, padded.strides[0])
    )
    power = np.abs(np.fft.rfft(frames * WINDOW, axis=1)).T[:, :-1] ** 2
    log_spec = np.log10(np.clip(FILTERS @ power, 1e-10, None))
    log_spec = np.maximum(log_spec, log_spec.max() - 8.0)
    return ((log_spec + 4.0) / 4.0)[None].astype(np.float32)


options = ort.SessionOptions()
options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
options.inter_op_num_threads = 1
# One thread: 30ms is already far inside the pause it is asked in, and the
# whisper read running beside it wants the cores more.
options.intra_op_num_threads = 1
options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
session = ort.InferenceSession(sys.argv[1], sess_options=options, providers=["CPUExecutionProvider"])


def score(audio):
    return float(np.ravel(session.run(None, {"input_features": features(audio)})[0])[0])


# The first run pays for graph setup; pay it before anyone is waiting.
score(np.zeros(RATE, dtype=np.float32))
print("ready", flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    ident = None
    try:
        request = json.loads(line)
        ident = request.get("id")
        audio = np.fromfile(request["pcm"], dtype=np.int16).astype(np.float32) / 32768.0
        started = time.perf_counter()
        done = score(audio)
        took = round((time.perf_counter() - started) * 1000)
        print(f"ok {json.dumps({'id': ident, 'done': round(done, 4), 'ms': took})}", flush=True)
    except Exception as exc:  # noqa: BLE001 - one bad request must not end the worker
        print(f"err {json.dumps({'id': ident, 'error': str(exc)})}", flush=True)
