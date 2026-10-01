"""Clip worker: her short lines, played the moment node asks.

The chime is instant because the process that hears her name plays it, with
winsound, from a file that already exists. Her spoken lines were not: each one
went through ffplay, which takes about 450ms to start and opens on half a
second of silence, so "Afternoon." arrived over a second after the chime and
the gap between them was the thing he noticed.

So the lines she says to her name are rendered once by Kokoro, kept as .wav
files, and played from here the same way the chime is. This process stays up
and does nothing else, so there is nothing to start when he speaks.

Protocol, one line in, one line out:
    in : play <absolute path to a .wav>
         stop
    out: ready
         ok
         err <message>

stdout is the protocol channel; anything else must go to stderr.
"""
import sys

try:
    import winsound
except Exception as exc:  # noqa: BLE001 - not Windows: say so, don't hang
    print(f"err {exc}", flush=True)
    sys.exit(1)

print("ready", flush=True)

for line in sys.stdin:
    command = line.strip()
    if not command:
        continue
    try:
        if command.startswith("play "):
            # Async, so a second line can stop or replace this one. A new
            # PlaySound ends whatever this process was playing, which is the
            # right thing: she never says two of these at once.
            winsound.PlaySound(
                command[5:],
                winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT,
            )
            print("ok", flush=True)
        elif command == "stop":
            winsound.PlaySound(None, winsound.SND_PURGE)
            print("ok", flush=True)
        else:
            print(f"err unknown command: {command}", flush=True)
    except Exception as exc:  # noqa: BLE001 - one bad file must not end her voice
        print(f"err {exc}", flush=True)
