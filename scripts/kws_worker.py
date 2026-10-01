"""Wake word worker: a keyword spotter listening for her name, resident.

The two things before this both failed him, in opposite directions. Whisper
reading an open microphone has never seen "Vela", so a real "Hey Vela" came
back as "Hello" and she never answered; primed with the name, it wrote the name
into other people's sentences and she answered them. The openWakeWord model
trained on synthetic "hey vella" heard 2 of 5 of his real ones.

This is neither. It is a streaming speech recogniser 3.3M parameters small
(sherpa-onnx, zipformer, trained on 10,000 hours of GigaSpeech) that is only
allowed to say one thing: the phrase, spelled as the sub-word pieces it already
knows. Nothing has to be trained, and "Vela" does not have to be a word it
has seen — ▁VE LA is two pieces it has seen thousands of times.

Measured before it went in (see README, "The wake word"): 94-98% of clean
"Hey Vela"s across 15 voices, 93% at his microphone's -49 dBFS, 92% with
someone else talking 10 dB under him, and no false wakes in 5.4 hours of
LibriSpeech. The one near-miss that fires is "Hey Velma".

Protocol, raw bytes in, one line out per event (the same as wake_worker.py):
    in : 16-bit signed mono PCM at 16kHz, straight off ffmpeg's pipe
    out: ready              (the model is loaded and listening)
         wake 1 <PHRASE>    (it heard the phrase; a spotter has no score)
         err <message>

Arguments: model_dir phrases boost trigger gain_db chime
    phrases : comma-separated, e.g. "hey vela,hey vella"
    boost   : how hard the phrase is favoured in the search. Higher hears more
    trigger : how sure it must be before it fires. Lower hears more
    gain_db : lift applied before listening; his microphone runs quiet
    chime   : "on", "off", or a path to a .wav of his own

stdout is the protocol channel; everything else must go to stderr or it
corrupts the stream.
"""
import math
import os
import struct
import sys
import tempfile
import wave

import numpy as np

# 80ms at 16kHz. The spotter takes any length, but this is the read size its
# latency was measured at: a median of 330ms from the end of "Vela" to firing.
FRAME = 1280
WIDTH = 2  # 16-bit
RATE = 16000

# One phrase is often heard twice as the search settles on it. A second chime
# a moment after the first sounds like a fault, and nobody says her name twice
# inside a second and a half.
REFRACTORY = int(1.5 * RATE)

model_dir = sys.argv[1]
phrases = [p.strip() for p in (sys.argv[2] if len(sys.argv) > 2 else "hey vela").split(",") if p.strip()]
boost = float(sys.argv[3]) if len(sys.argv) > 3 else 3.0
trigger = float(sys.argv[4]) if len(sys.argv) > 4 else 0.15
gain = 10 ** (float(sys.argv[5]) / 20) if len(sys.argv) > 5 else 1.0
chime_arg = sys.argv[6] if len(sys.argv) > 6 else "on"


def write_chime(path):
    """Two soft rising notes, 0.2s. Built here so there is no asset to lose.

    A fifth apart (E5 then B5), each struck and left to ring out rather than
    held, which is what makes it read as an acknowledgement and not an alarm.
    """
    rate, length = 24000, 0.22
    out = []
    for i in range(int(rate * length)):
        t = i / rate
        sample = 0.0
        for start, freq in ((0.0, 659.25), (0.07, 987.77)):
            if t >= start:
                s = t - start
                envelope = min(1.0, s / 0.004) * math.exp(-s / 0.06)
                sample += envelope * (math.sin(2 * math.pi * freq * s) + 0.2 * math.sin(4 * math.pi * freq * s))
        out.append(int(max(-1.0, min(1.0, 0.18 * sample)) * 32767))
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack(f"<{len(out)}h", *out))


try:
    import sentencepiece as spm
    import sherpa_onnx

    # The phrase, in the pieces the model spells with. A piece it does not know
    # would be dropped silently by the search, and she would listen for a
    # phrase nobody can say.
    pieces = spm.SentencePieceProcessor(model_file=os.path.join(model_dir, "bpe.model"))
    with open(os.path.join(model_dir, "tokens.txt"), encoding="utf-8") as handle:
        known = {line.split()[0] for line in handle if line.strip()}
    scratch = tempfile.mkdtemp(prefix="vela-kws-")
    keywords = os.path.join(scratch, "keywords.txt")
    with open(keywords, "w", encoding="utf-8") as handle:
        for phrase in phrases:
            spelled = pieces.encode(phrase.upper(), out_type=str)
            missing = [p for p in spelled if p not in known]
            if missing:
                raise ValueError(f"'{phrase}' has pieces the model does not know: {missing}")
            handle.write(" ".join(spelled) + " @" + phrase.upper().replace(" ", "_") + "\n")

    # fp32 rather than the int8 export: it is 12MB either way, and the CPU it
    # costs is about 2% of one core.
    stem = "epoch-12-avg-2-chunk-16-left-64"
    spotter = sherpa_onnx.KeywordSpotter(
        tokens=os.path.join(model_dir, "tokens.txt"),
        encoder=os.path.join(model_dir, f"encoder-{stem}.onnx"),
        decoder=os.path.join(model_dir, f"decoder-{stem}.onnx"),
        joiner=os.path.join(model_dir, f"joiner-{stem}.onnx"),
        keywords_file=keywords,
        num_threads=1,
        keywords_score=boost,
        keywords_threshold=trigger,
        num_trailing_blanks=1,
        max_active_paths=4,
    )
    stream = spotter.create_stream()

    chime = None
    if chime_arg.lower() == "on":
        chime = os.path.join(scratch, "chime.wav")
        write_chime(chime)
    elif chime_arg.lower() != "off":
        chime = chime_arg
    # Played from here rather than from node, because here is where the
    # detection happens: no pipe, no player to start, nothing between hearing
    # her name and answering it. winsound is the standard library on Windows.
    play = None
    if chime:
        import winsound

        def play():
            winsound.PlaySound(chime, winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT)
except Exception as exc:  # noqa: BLE001 - report and exit, don't hang silently
    print(f"err {exc}", flush=True)
    sys.exit(1)

print("ready", flush=True)

pipe = sys.stdin.buffer
heard = 0
last = -REFRACTORY

while True:
    chunk = pipe.read(FRAME * WIDTH)
    if not chunk or len(chunk) < FRAME * WIDTH:
        break
    heard += FRAME
    try:
        audio = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0
        if gain != 1.0:
            audio = np.clip(audio * gain, -1.0, 1.0)
        stream.accept_waveform(RATE, audio)
        while spotter.is_ready(stream):
            spotter.decode_stream(stream)
            phrase = spotter.get_result(stream)
            if not phrase:
                continue
            # Everything before this belongs to the phrase that just fired.
            # Left in, the search carries on from inside it.
            spotter.reset_stream(stream)
            if heard - last < REFRACTORY:
                continue
            last = heard
            # The sound first, then the line: he hears her before node does.
            if play:
                try:
                    play()
                except Exception:  # noqa: BLE001 - a chime is not worth the wake word
                    pass
            print(f"wake 1 {phrase}", flush=True)
    except Exception as exc:  # noqa: BLE001 - one bad frame must not end the stream
        print(f"err {exc}", flush=True)
