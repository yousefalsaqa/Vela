"""Echo canceller: the microphone with her own voice taken out of it.

The laptop's speakers are centimetres from its microphone, and her voice comes
back into it at -34.5 dBFS, as loud as his. That is why she has always shut
her ears while she talks, and why he could never talk over her. WebRTC's
canceller (AEC3, through LiveKit's bindings, Apache-2.0) takes it down to
-70..-75 dBFS, under the microphone's own hiss, measured on this laptop.

A canceller needs to know what was played. Rather than have every one of her
sounds (Kokoro's sentences, the rendered greetings, the wake chime) report
itself, this records what the speakers are playing, through WASAPI loopback.
That is everything she plays, and it is captured just before it leaves the
machine, so it always arrives ahead of its echo in the microphone, which is
the order the canceller needs. It finds the remaining delay itself: measured,
a reference 100 to 400ms early made no difference to what was left.

Protocol, binary, no lines:
    stdin : raw signed 16-bit mono 16 kHz PCM, the microphone, as it comes
    stdout: the same, cleaned, 10ms for every 10ms in
stderr carries "ready" once both streams are open, and any problem.

Only the echo canceller is on. Noise suppression and gain control would also
change what the wake word and whisper hear when she is silent, and they were
tuned on the microphone as it is.
"""
import queue
import sys
import threading

import numpy as np
import soundcard as sc
from livekit import rtc

RATE = 16000
FRAME = RATE // 100  # 10ms, the only frame size the canceller takes
BYTES = FRAME * 2

apm = rtc.AudioProcessingModule(
    echo_cancellation=True, noise_suppression=False, high_pass_filter=False, auto_gain_control=False
)
played: "queue.Queue[bytes]" = queue.Queue(maxsize=200)


def listen_to_speakers():
    """What the speakers play, in 10ms frames, for as long as she runs."""
    speaker = sc.default_speaker()
    loopback = sc.get_microphone(id=str(speaker.name), include_loopback=True)
    with loopback.recorder(samplerate=RATE, channels=1, blocksize=FRAME) as rec:
        print("ready", file=sys.stderr, flush=True)
        while True:
            audio = rec.record(numframes=FRAME)
            frame = (np.clip(audio[:, 0], -1, 1) * 32767).astype(np.int16).tobytes()
            try:
                played.put_nowait(frame)
            except queue.Full:
                # Nothing is reading the microphone; keep the newest.
                played.get_nowait()
                played.put_nowait(frame)


threading.Thread(target=listen_to_speakers, daemon=True).start()

stdin = sys.stdin.buffer
stdout = sys.stdout.buffer
pending = b""
while True:
    chunk = stdin.read1(4096) if hasattr(stdin, "read1") else stdin.read(BYTES)
    if not chunk:
        break
    pending += chunk
    while len(pending) >= BYTES:
        near, pending = pending[:BYTES], pending[BYTES:]
        # Everything played up to now goes in first, so the canceller always
        # knows the sound before it hears the echo.
        while True:
            try:
                apm.process_reverse_stream(rtc.AudioFrame(played.get_nowait(), RATE, 1, FRAME))
            except queue.Empty:
                break
        apm.set_stream_delay_ms(0)
        frame = rtc.AudioFrame(near, RATE, 1, FRAME)
        apm.process_stream(frame)
        stdout.write(bytes(frame.data))
    stdout.flush()
