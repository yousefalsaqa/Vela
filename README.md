# Vela

A personal assistant with hands. Runs on the Claude Agent SDK, remembers things
between sessions, and can drive a Windows desktop.

## Run it

```bash
npm run dev
```

That's it. No API key — it uses the Claude Code OAuth credentials already on
this machine (`~/.claude/.credentials.json`), so usage draws on the Max
subscription rather than pay-as-you-go API billing.

To rename the assistant, set `VELA_NAME`:

```bash
VELA_NAME=Jarvis npm run dev
```

## What it can do

Built-in from the Agent SDK: read/write/edit files, run shell commands, search
codebases, fetch the web.

Added here (`src/tools.ts`):

| Tool | Purpose |
|---|---|
| `remember` / `recall` / `forget` | Durable memory across sessions |
| `list_projects` / `add_project` | Refer to codebases by nickname |
| `launch_app` | Open apps, URLs, files — knows aliases like `netflix` |
| `media_control` | Play/pause, skip, volume |
| `list_windows` | See what's currently open |
| `watch` / `list_watches` / `resolve_watch` | Keep an eye on something and speak up when it changes |

## Speaking up on its own

Ask it to tell you when something happens — "let me know when the fantasy build
finishes" — and it records a watch. Every few minutes a heartbeat wakes up,
checks the open watches, and prints unprompted only if something actually
changed:

```
you › let me know when that build fini
Vela › Build succeeded in 41s.
you › let me know when that build fini
```

Your half-typed line survives. Tuning:

| Variable | Default | Meaning |
|---|---|---|
| `VELA_HEARTBEAT` | `5` | Minutes between checks, or `off` (also disables triggers) |
| `VELA_HEARTBEAT_MODEL` | `haiku` | Model the heartbeat uses |
| `VELA_THINKING` | `off` | `on` restores extended thinking — slower, better on hard problems |

### Triggers

The timer is a floor, not the only way a watch gets looked at. A watch can
carry a trigger, and then it reports in seconds instead of minutes:

| Kind | Fires when | Good for |
|---|---|---|
| `file` | a file stops being written to | build logs, output files |
| `process` | a process that *was* running exits | "tell me when the build finishes" |

Vela attaches these itself — "let me know when the fantasy build finishes" gets
a `file` trigger on the log without you asking for one. Nothing here calls the
model: [triggers.ts](src/triggers.ts) decides *when* a check is worth making,
[ambient.ts](src/ambient.ts) decides what to say. Waiting is free.

Three numbers keep it honest: writes are debounced 2s, so a log being appended
to fires once when it goes quiet rather than per line; the watch list is
re-read every 15s, so new watches attach and resolved ones let go; and the same
watch won't be checked twice within 60s no matter how much the file thrashes.
A process trigger needs an observed running→gone edge, so a watch created after
the process already exited stays quiet instead of reporting immediately.

## Internet reach

Vela reads the web through [agent-reach](https://github.com/Panniantong/Agent-Reach),
installed on this machine with `uv tool install`. There is no wrapper here and
shouldn't be one — agent-reach routes to per-platform CLIs (`gh`, `yt-dlp`,
Jina Reader, `twitter-cli`, OpenCLI) and Vela calls those directly. The whole
integration is `skills: ["agent-reach"]` on the session options in
[index.ts](src/index.ts) and [ambient.ts](src/ambient.ts).

Live without further setup: **any web page** (Jina Reader), **GitHub** (`gh`),
**YouTube** (`yt-dlp`), **RSS/Atom**, **V2EX**, **Exa semantic search**.

Two need a browser action that can't be scripted:

- **Twitter/X** — export cookies from `x.com` with Cookie-Editor, then
  `agent-reach configure twitter-cookies`.
- **Reddit / Facebook / Instagram** — install the
  [OpenCLI extension](https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk)
  and leave the browser open; they run off your live session.

`agent-reach doctor --json` reports what's actually routing right now. The
heartbeat gets reach too, so a watch can be about a PR or a feed rather than
only something on this machine — it's read-only either way.

## Running as a service

```bash
npm run serve   # Vela in the background, keeping her session and her watches
npm run dev     # attaches to her if she's running; otherwise runs her in-process
```

[core.ts](src/core.ts) is the brain and has no idea a terminal exists — it takes
turns and emits events. The REPL is one renderer over that stream, voice is
another, and both can be attached at once. Without a service running, `npm run
dev` embeds its own core and behaves exactly as it always has.

The service listens on 127.0.0.1 with a random port and a random token, both
written to `data/server.json` (gitignored). The core runs with
`bypassPermissions` and has the whole machine, so "only local" is not on its own
a good enough door.

[client.ts](src/client.ts) is deliberately `node:http` rather than `fetch`. With
`fetch`, an attached REPL would connect happily and then hear nothing at all —
the events stream never ends, and the turn behind it never got through.

## Speaking

```bash
VELA_VOICE=on npm run dev
```

| Variable | Default | Meaning |
|---|---|---|
| `VELA_VOICE` | `off` | `on` makes her speak her replies |
| `VELA_VOICE_NAME` | system default | e.g. `Microsoft Zira Desktop` |
| `VELA_VOICE_RATE` | `1` | -10 (slow) to 10 (fast) |

Windows SAPI, so no install and no network. [voice.ts](src/voice.ts) speaks
sentence by sentence as the reply streams — waiting for the whole answer would
add its length to a latency budget that's already about a second and a half.
`speakable()` strips what reads badly aloud: code blocks become "code block",
links become their label, and a Windows path becomes just the filename.

## Listening

```bash
VELA_LISTEN=on npm run dev
```

Push-to-talk: **Enter on an empty line starts recording, Enter again stops it**,
and the transcript goes into the same queue a typed line would. Using the input
that already exists beats a global-hotkey dependency, and it's deliberately not
a wake word — "Hey Vela" means training a model on synthetic speech, which is
worth doing only once the loop has proved itself.

ffmpeg captures the microphone, `whisper-ctranslate2` transcribes it. Both were
installed with `winget` and `uv` respectively; a few seconds of speech
transcribes in about 1.5s on CPU.

| Variable | Default | Meaning |
|---|---|---|
| `VELA_LISTEN` | `off` | `on` enables push-to-talk |
| `VELA_MIC` | first microphone | Part of the DirectShow device name |
| `VELA_WHISPER_MODEL` | `base.en` | `tiny.en` … `small.en`; bigger is slower, better |
| `VELA_WHISPER_DEVICE` | `cpu` | `cuda` needs the CUDA runtime |
| `VELA_FFMPEG` | `ffmpeg` | Full path, until a shell restart puts it on PATH |

`cleanTranscript()` exists because whisper hallucinates: given a second of room
tone it confidently returns "You." or "Thank you.", and a stray Enter shouldn't
send a phantom turn. Real speech that happens to start with "thanks" survives —
there's a test for exactly that.

**CPU is the default on purpose.** The CUDA runtime is installed (cuBLAS 12.9 and
cuDNN 9.24, as pip wheels inside whisper's own venv rather than the 3GB toolkit),
and `VELA_WHISPER_DEVICE=cuda` works. It just doesn't help, measured on a
three-second clip:

| | GPU (warm) | CPU |
|---|---|---|
| `base.en` | 1.31s | 1.26s |
| `small.en` | 2.17s | 2.51s |

At push-to-talk lengths the time is process startup and model loading, not
inference, so the GPU never gets to matter. The first CUDA run took 21.7s — an
RTX 5060 is Blackwell (`sm_120`), newer than CTranslate2's prebuilt kernels, so
it JIT-compiled them once and cached them. Worth revisiting only for long
recordings or a much bigger model.

## Browser history

[history.ts](src/history.ts) reads Chrome, Edge and Brave history — all SQLite,
so `node:sqlite` handles it with no new dependency. That's what makes "open the
Meet I joined yesterday" work: search history, then `launch_app` the result.
Read-only, entirely local, and the live file is copied first because the browser
holds a lock on it.

Chrome stores timestamps as microseconds since 1601, which run past 2^53 —
`node:sqlite` refuses to return an integer it can't represent exactly, so the
query casts to a float. Real history hits this; a small fixture wouldn't.

## Tests

```bash
npm test              # ~100 tests, no network, under half a second
npm run test:watch    # re-runs on save
npm run test:coverage # same suite, with enforced thresholds
npm run check         # typecheck + test
```

`node:test` and `tsx` — no framework, matching the no-dependencies stance
everywhere else. Everything stubs the model out, so the suite is free to run
and deterministic.

```bash
VELA_LIVE=1 npm run test:live
```

That one does call the model (~12s, real tokens). It exists because nothing
else checks the thing most likely to drift: whether the model actually honours
the `SILENT` / `#id done:` reply contract that `parseReply` is built around.

**What isn't covered, on purpose** — everything that spawns something:

| | why |
|---|---|
| `ps`, `isProcessRunning` | spawn PowerShell |
| `askModel` | calls the SDK |
| `windowsSpeaker` | holds a live speech synthesiser |
| `startRecording`, `transcribe`, `audioDevices` | drive ffmpeg and whisper |
| `launch_app`, `media_control`, `list_windows` handlers | would really open apps and press media keys |

The logic behind each is tested through an injected fake; only the last inch
isn't. The speech chain is covered end to end in `tests/live` instead, where
Vela speaks a known sentence to a wav and transcribes it back — no human
needed, and it catches whisper being missing or on the wrong device.

The one exception is `fs.watch`, which is exercised for real against a temp
file in [tests/triggers.test.ts](tests/triggers.test.ts) — Windows has enough
opinions about how many events an append produces that a fake alone would be
misleading.

Coverage thresholds sit just under the current numbers so they catch a
regression rather than reward padding. To see what's uncovered by name rather
than by line range:

```bash
node --import tsx --test --experimental-test-coverage \
  --test-reporter=lcov --test-reporter-destination=coverage.info "tests/*.test.ts"
grep -B99 'FNDA:0,' coverage.info   # FNDA:0 marks a function never entered
```

## Layout

```
src/
  index.ts     REPL wiring — the one file with no unit tests, by design
  memory.ts    SQLite store + the context block injected each session
  desktop.ts   Windows control via PowerShell
  ambient.ts   Background heartbeat — checks watches, speaks unprompted
  triggers.ts  Wakes a watch on a file write or a process exit; never calls the model
  repl.ts      Terminal rendering: prompts, interjections, stream deltas
  tools.ts     Exposes the above to the model as MCP tools
tests/         Unit tests; tests/live/ needs VELA_LIVE=1
data/
  vela.db      Memory (gitignored)
```

## Design notes

**Memory is a system-prompt injection, not a search.** `buildContextBlock()`
loads the 30 most recent memories plus every project into the system prompt at
session start. Small and always-on beats a retrieval step that might miss.
When memory outgrows that, add embedding search and keep only pinned facts in
the block.

**Extended thinking is off by default.** Measured across four-turn
conversations, thinking on runs 1.6–5.5s per turn; off runs 1.3–2.2s. The
median gain is small — the point is the tail. The 3–5s stalls are what make it
feel sluggish, and they're gone. `VELA_THINKING=on` brings it back for work
that deserves it. Model choice barely moves this: Haiku, Sonnet and Opus all
measured within 0.05s of each other, because the system prompt is cached and
the cost is per-request overhead, not inference.

**The persona is a voice spec, not a capability list.** Vela kept sounding like
a coding assistant writing a report — headers, bullet walls, "Great question".
The prompt in [index.ts](src/index.ts) now spends most of its length on *how it
talks*: plain sentences, no formatting in conversation, lead with the answer,
pick a side instead of offering a menu, bad news first. Capabilities are the
short half.

**One session, not one per turn.** Turns are streamed into a single long-lived
`query()` via [session.ts](src/session.ts). Calling `query()` per turn and
resuming by session id spawned a CLI subprocess and re-loaded the transcript
every time, so cost climbed as you talked — measured at 2.1s, 2.0s, 4.5s for
three trivial turns, against a flat ~1.5s streamed. The REPL also iterates the
readline interface rather than awaiting `question()`, which keeps lines typed
during a turn (and every line of a piped script — `question()` drops those at
EOF).

**A turn shows its work.** Tool calls produce no text, so a turn that reads
twenty files used to look hung. Each one now prints a dim line, and a spinner
carries the elapsed seconds — see `toolActivity` and `createStatus` in
[repl.ts](src/repl.ts). Both go silent when stdout isn't a terminal, so pipes
and logs stay clean.

**The Agent SDK is the whole brain.** There's no router or intent classifier —
the model decides when to reach for memory versus files versus the desktop. New
capability = a new tool in `tools.ts`, nothing else changes.

**Storage is `node:sqlite`** — built into Node 24. No ORM, no native
compilation, no server. Prisma 7 was tried first and rejected: it now requires
a driver adapter that pulls in `better-sqlite3`, which means a native build
toolchain on Windows.

**Permissions are wide open** (`bypassPermissions`) — except in the heartbeat,
which is denied `Write`, `Edit`, `launch_app`, `media_control`, and the memory
writers. Anything running unsupervised on a timer observes; it doesn't act.
That aside, wide-open is correct for a trusted assistant on your own machine and
wrong for anything shared. When this gets network access, gate destructive tools
behind the SDK's `canUseTool` callback.

**Idle heartbeats cost nothing.** No active watches means no model call at all,
and each tick is a fresh session rather than a resumed one — continuity comes
from the watch row (what was said, how long ago), so context doesn't grow all
day. Whether a watch is finished rides in the reply itself (`#3 done: ...`)
rather than depending on the model remembering to call `resolve_watch`.

## Next

1. Voice — wake word (openWakeWord ships a pretrained `hey_jarvis`; a custom
   "Vela" model trains on synthetic TTS audio), streaming STT/TTS. Needs the
   core split into a local server with the REPL as one client.
2. Fabrication — CAD-as-code (`build123d`), slicer CLI, printer REST APIs, each
   as its own tool module.
3. More trigger kinds — a window title appearing, an HTTP endpoint changing
   shape. The `file` and `process` pair covers most of what's wanted so far.
