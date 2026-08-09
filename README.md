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

**What isn't covered, on purpose.** Exactly six functions, all of them sitting
on a process boundary: `ps` (spawns PowerShell), `askModel` (calls the SDK), the
real `isProcessRunning` probe, and the `launch_app` / `media_control` /
`list_windows` tool handlers, which would really open applications and press
media keys if invoked. The logic behind each is tested through an injected fake;
only the last inch isn't. That's the whole gap — if function coverage drops
below 90%, something else went untested.

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
