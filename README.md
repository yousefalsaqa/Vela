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

## Memory is an Obsidian vault

What she knows about Yousef lives in `vault/Memory` as one markdown note per
fact, not as rows. A SQLite row is a fine place to put a fact and a terrible
place to read one. As notes he can open the vault, see everything she believes
about him, correct what's wrong, and link facts together, and she reads the
edit back on the next recall.

```
vault/Memory/
  yousef-graduated-basc-mechatronics-robotics-engineering.md
  yousef-has-used-typescript-for-his.md
  fabrication-is-aspirational-as-of-aug.md
```

Notes are named after the sentence rather than an id, because that name is
what Obsidian links with. Frontmatter carries `kind`, `tags` and the dates, and
any key it doesn't recognise is written back untouched, so a plugin's metadata
survives her next write. Notes he writes by hand with no frontmatter at all are
read as plain facts.

Projects and watches stay in SQLite. They're operational state, and `last_spoke`
churning every few minutes would make the vault noisy for no reading benefit.
An older database is drained into the vault on first open; the table is emptied
as it goes, so it happens once.

Two vaults are registered with Obsidian: `Desktop\Vela\vault` on its own, and
`Desktop\Vault`, which holds directory junctions to both Vela's notes and
Claude Code's own memory folder so the whole graph is browsable in one place.
`vault/` is gitignored, since this repo is public and the notes are about him.

| Variable | Default | Meaning |
|---|---|---|
| `VELA_VAULT` | `<repo>/vault` | Vault root; notes go in its `Memory` folder |

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
Jina Reader, `twitter-cli`, OpenCLI) and Vela calls those directly. It is
one name in a list; see [Skills](#skills) below.

Live without further setup: **any web page** (Jina Reader), **GitHub** (`gh`),
**YouTube** (`yt-dlp`), **RSS/Atom**, **V2EX**, **Exa semantic search**.

Two need a browser action that can't be scripted:

- **Twitter/X** — export cookies from `x.com` with Cookie-Editor, then
  `agent-reach configure twitter-cookies`.
- **Reddit / Facebook / Instagram** — install the
  [OpenCLI extension](https://chromewebstore.google.com/detail/opencli/ildkmabpimmkaediidaifkhjpohdnifk)
  and leave the browser open; they run off your live session.

`agent-reach doctor --json` reports what's actually routing right now.

## Skills

Skills are not listed in the source. `discoverSkills()` in
[config.ts](src/config.ts) reads `~/.claude/skills` at startup and treats any
folder holding a `SKILL.md` as a skill, so anything installed for Claude Code
is installed for Vela.

That used to be a literal array, which meant a skill she wrote for herself with
`skill-creator` was unreachable until someone edited TypeScript. Discovering
them instead is what makes her able to grow her own hands, and it costs one
`readdirSync` per start.

The heartbeat gets a separate, shorter list. It runs unsupervised on a timer,
so it observes and does not act, the same reason it is denied `Write`, `Edit`
and the memory writers. `agent-reach` is read-only and stays on it; anything
that writes files does not.

| Variable | Default | Meaning |
|---|---|---|
| `VELA_SKILLS_DIR` | `~/.claude/skills` | Where to look |
| `VELA_SKILLS` | everything found there | Comma-separated override for the session |
| `VELA_SKILLS_EXCEPT` | none | Names to drop; a trailing `*` drops a family |
| `VELA_HEARTBEAT_SKILLS` | `agent-reach`, `gws-calendar-agenda` | Comma-separated override for the tick |

What is installed, and why:

| Skill | For |
|---|---|
| `agent-reach` | The internet, as above |
| `council` | A cross-model second opinion on a hard call |
| `skill-creator` | Writing and evaluating her own skills |
| `frontend-design`, `theme-factory` | Design that doesn't read as a template |
| `webapp-testing` | Driving and screenshotting a local page with Playwright |
| `xlsx`, `docx`, `pdf`, `pptx` | The documents his actual job is made of |
| `claude-api` | The SDK she is built on, for when he asks her to change it |
| `gws-*` | Calendar, mail, tasks, drive and sheets, through the `gws` CLI |
| `cad-khana` | build123d, with interference, clearance and printability checks |
| `systematic-debugging`, `test-driven-development`, `verification-before-completion` | How to work, from obra/superpowers |
| `copywriting`, `copy-editing`, `seo-audit`, `content-strategy`, `marketing-psychology`, `cro` | Marketing, six of forty-nine |
| `backtest-review`, `strategy-critique`, `risk-report`, `indicator-design`, `data-scrub`, `hedge-lab` | Reviewing a trading idea sceptically |
| `strategy-framework`, `risk-management`, `position-sizing`, `portfolio-analytics`, `ohlcv-processing`, `pandas-ta`, `backtrader`, `walk-forward-validation`, `options-pricing`, `volatility-modeling`, `token-economics`, `coingecko-api` | The background, for equities and crypto both |

Deliberately not installed: `discernment-nudge`, which runs a check before
every substantive reply, for the same reason the humanizer skill isn't here.
An extra pass per turn is the cost the voice spec exists to avoid.

The Google ones need `gws auth setup` once, which wants the `gcloud` CLI
present, then creates a Cloud project and opens a browser to log in. Until that
runs they are inert. `cad-khana` needs `pip install build123d`.

Two things about that setup are worth writing down, because neither error says
what it means. A Google account that has never touched Cloud cannot create a
project at all until the Cloud Terms of Service are accepted once in a browser,
and the wizard swallows that failure and re-prompts for the project name, which
looks exactly like the name being rejected. Separately, `gmail.modify` and full
`drive` are restricted scopes: publishing the consent screen to production
without Google's verification gets them refused with a 403, so the app stays in
testing, and a testing app's refresh token expires every seven days. Full Gmail
and Drive access costs a weekly `gws auth login`. Dropping to Calendar, Tasks
and Sheets, which are only sensitive, buys a token that doesn't expire. Afterwards,
`VELA_HEARTBEAT_SKILLS=agent-reach,gws-calendar-agenda` is what makes "your 2pm
moved" something she says on her own.

`skill-creator` shells out to `claude -p` for description optimisation and
evals. That binary ships inside the SDK, under a package whose name carries the
platform, and it is not on PATH by itself. `ensureClaudeOnPath()` in
[config.ts](src/config.ts) finds it by looking rather than by guessing and
prepends the directory at startup, so an SDK upgrade can't strand a copy at an
old version.

Ninety of them is about 5,400 tokens of names and descriptions in every system
prompt. That is cached after the first call so it costs almost nothing in
speed, but a long menu is a worse menu, and `VELA_SKILLS_EXCEPT=kalshi-*` is
the short way to shorten it. Discovery is the right default and a bad
absolute: once a repo of sixty trading skills is on disk, the choice is either
naming the eighty he wants or the twenty he doesn't.

Set-but-empty means none, which is not the same as unset. An empty skills
directory means no skills rather than a fallback set: if it isn't there then
neither is agent-reach, and naming it anyway would only send her reaching
through something that doesn't exist.

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

Three engines, one env var apart:

| `VELA_VOICE_ENGINE` | What | Cost |
|---|---|---|
| `kokoro` *(default)* | [Kokoro-82M](https://github.com/hexgrad/kokoro) running locally, voice `bf_emma` | ~1GB resident while speech is on; offline |
| `neural` | edge-tts, Microsoft's cloud voices, `en-GB-LibbyNeural` | nothing local; a network round trip per sentence |
| `sapi` | built-in Windows voices | nothing; sounds like 2003 |

Kokoro is the default because the cloud voices have an even, over-articulated
cadence that gives them away. It runs on CPU — the GPU is worth nothing at
these lengths and is better left for other things. A [warm
worker](scripts/kokoro_worker.py) holds the model so the 1.2s load is paid once
at startup rather than per sentence, and it only exists while voice is on.

| Variable | Default | Meaning |
|---|---|---|
| `VELA_VOICE` | `off` | `on` makes her speak her replies |
| `VELA_KOKORO_VOICE` | `bf_emma` | also `bf_isabella`, `bf_alice`, `bf_lily` |
| `VELA_KOKORO_SPEED` | `1.1` | 1.0 is normal |
| `VELA_VOICE_NAME` | per engine | edge-tts voice, or a SAPI voice name |
| `VELA_VOICE_RATE` / `_PITCH` | `12` / `-8` | edge-tts only: percent and Hz |

**Names get pronounced, not guessed at.** Every English voice reads "Yousef" as
"YO-sef". Kokoro takes inline phonemes — `[Yousef](/jˈuːsəf/)` — which say
exactly what's wanted; the other two get a phonetic respelling instead, since
they'd read the brackets aloud. Hence two tables in
[voice.ts](src/voice.ts), applied *after* the markdown cleanup, because the
link-stripping rule would otherwise flatten the phoneme markup back to plain
text. Anything else she mangles is one line to fix.

[voice.ts](src/voice.ts) speaks
sentence by sentence as the reply streams — waiting for the whole answer would
add its length to a latency budget that's already about a second and a half.
`speakable()` strips what reads badly aloud: code blocks become "code block",
links become their label, and a Windows path becomes just the filename.

**One player, not one per sentence.** Spawning a player per utterance costs
~450ms of process start and audio-device open, and that lands as a gap of
silence between every sentence — which is what made her sound hesitant rather
than slow. `pcmPlayer()` keeps a single ffplay reading raw samples off a pipe
for the whole conversation. Measured over a four-sentence reply:

| | Player per sentence | One player |
|---|---|---|
| Dead air, 4 sentences | ~1.9s | ~0.6s, nearly all of it the one startup |

Handing samples to it returns immediately, so the next sentence is synthesised
while the current one is still playing instead of after it. That's the other
~500ms a sentence.

**She's told when she's being heard.** Speech is not writing: a paragraph he'd
skim in two seconds takes twenty to say, and he can't skip the middle. With
`VELA_VOICE=on` the persona gains [a section](src/config.ts) that caps replies
at a sentence or two and bans the running commentary — "let me check X", pause,
"now let me look at Y" — which was most of what made her feel slow, since each
of those lines is a synthesis, a playback, and then silence while the tool
actually runs.

## Listening

```bash
VELA_LISTEN=on npm run dev
```

Push-to-talk: **Enter on an empty line starts recording, Enter again stops it**,
and the transcript goes into the same queue a typed line would. Using the input
that already exists beats a global-hotkey dependency, and it's deliberately not
a wake word — "Hey Vela" means training a model on synthetic speech, which is
worth doing only once the loop has proved itself.

ffmpeg captures the microphone and whisper transcribes it. Both were installed
with `winget` and `uv` respectively.

**Nothing waits for a file.** ffmpeg writes raw samples down a pipe rather than
a wav on disk, so stopping is immediate — there's no header to finalise, and
none of the 1.2s that dshow takes to close the capture device politely. A [warm
worker](scripts/whisper_worker.py) then holds the model, the same way Kokoro's
does, instead of reloading it per utterance:

| Six seconds of speech | Cold CLI, per utterance | Warm worker |
|---|---|---|
| `base.en`, CPU | ~1.4s | ~0.4s |

The worker needs a Python that can import `faster_whisper`; `uv tool install
whisper-ctranslate2` leaves one behind, which is the default path below. If it
isn't there, transcription silently falls back to the CLI and pays the reload.

| Variable | Default | Meaning |
|---|---|---|
| `VELA_LISTEN` | `off` | `on` enables push-to-talk |
| `VELA_MIC` | first microphone | Part of the DirectShow device name |
| `VELA_WHISPER_MODEL` | `base.en` | `tiny.en` … `small.en`; bigger is slower, better |
| `VELA_WHISPER_DEVICE` | `cpu` | `cuda` needs the CUDA runtime |
| `VELA_WHISPER_PYTHON` | whisper's uv venv | A Python that can import `faster_whisper` |
| `VELA_WHISPER_VOCABULARY` | his names and tools | Words to bias the decoder towards |
| `VELA_KEEP_AUDIO` | `off` | `on` saves every recording to `data/heard` next to its transcript |

**When she mishears, `VELA_KEEP_AUDIO=on` says which half is at fault.** Bad
audio (clipped at the front, too quiet, too much room) and a bad transcription
of good audio need opposite fixes, and the wav sitting next to the text it
produced settles it without another round trip.
| `VELA_FFMPEG` | `ffmpeg` | Full path, until a shell restart puts it on PATH |

**It waits for the microphone before saying "listening".** dshow takes about
1.3s to open the device, and anything said before that is not quiet, it does
not exist. The first word or two of a sentence would vanish and whisper would
be left guessing at a fragment, which is the single biggest cause of it
mishearing him.

**Telling it his own words beats a bigger model.** Measured over five sentences
of his actual vocabulary:

| | word error | cost |
|---|---|---|
| `base.en`, beam 1 | 12.2% | 382ms |
| `base.en`, beam 5 | 9.8% | 391ms |
| **`base.en`, beam 5 + vocabulary** | **7.3%** | **408ms** |
| `small.en`, beam 1 | 7.3% | 1140ms |

`VELA_WHISPER_VOCABULARY` is fed to whisper as an `initial_prompt`. It buys the
same accuracy as a model three times the size, for 26ms. Add a word to it any
time she mangles a name.

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

**Everything that spawns is tested through the seam, not around it.**
[proc.ts](src/proc.ts) is the one place the app touches the operating system,
and everything that speaks, listens or drives the desktop takes its `Spawner`
as an argument. A test hands over a child process that never existed, then
drives both sides of it: what Vela wrote, and what it says back. That leaves
the parts most likely to break actually covered — the line protocol she talks
to her workers over, the queueing that stops two sentences playing at once, a
worker that reports success and writes nothing, and a player that won't start.

`proc.ts` itself is excluded from the coverage gate, along with `index.ts`. It
is six lines of delegation with no logic in it; testing the call itself is what
`tests/live` is for.

**What genuinely isn't covered, on purpose:**

| | why |
|---|---|
| `ps`, `isProcessRunning` | spawn PowerShell directly |
| `askModel` | calls the SDK |
| `launch_app`, `media_control`, `list_windows` handlers | would really open apps and press media keys |

The speech chain is covered end to end in `tests/live` instead, where Vela
speaks a known sentence to a wav and transcribes it back through both the
warm worker and the CLI — no human needed, and it catches whisper being
missing or on the wrong device.

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
  config.ts    Persona, voice spec, and which skills each half is given
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

## Versions

The version in `package.json` is read at startup and printed with the commit
under it, so `Vela 1.3.0 (c5e439d)` in the banner says exactly what is running.
She's told her own version too, which is what she answers with when asked.

The minor number goes up when she gains a sense or a limb; the patch when
something that was broken isn't. It stayed at 1.0.0 for three releases because
nothing read it, so if you add to this list, bump it.

| Version | What she gained |
| --- | --- |
| 1.0.0 | Hands: files, shell, the Windows desktop, durable memory, an ambient heartbeat with watches. |
| 1.1.0 | The core split out of the terminal, so she survives the window closing. Service mode, edge-tts speech, push-to-talk. |
| 1.2.0 | A Kokoro voice worth listening to, one player for the whole conversation, and his name said right. |
| 1.3.0 | Whisper kept warm instead of reloaded per utterance, memory as an Obsidian vault, and the spoken turn cut down to where it feels live. |
| 1.4.0 | Skills discovered rather than listed, so she can be handed new hands without a code change. Thirty-four of them, and a voice spec that now says how to recover from a slip. |
