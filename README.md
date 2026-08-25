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
| `capture_screen` | Look at what's actually on his monitors |
| `show_screen` / `clear_screen` | Put a page on her own screen in the hub |
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
| `VELA_EFFORT` | `high` while thinking is off | `low` … `max`; raising it only means something with thinking on |

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

## The hub

```
Vela.bat          double-click it
npm run serve     then open the Hub line it prints
```

Her second face, at `/` on the same service the REPL attaches to. Same session,
not a second one: type in the terminal and it appears in the browser, because
both are clients of one core.

**It is a desk rather than a page.** There are no sections, no cards, no
sidebar and no counters printed across the top because the values happen to
exist. The conversation is the base layer and keeps the left; two panels float
over the rest of it — what she is showing, and what she is doing — and where
he puts them is where they stay. Not windows in the operating-system sense:
no title bar, no minimise, no z-order to think about. A hairline round
something, its name as the handle, a corner that pulls. Positions are kept per
panel and per rough window size, because a layout arranged on the wide monitor
is wrong on the laptop and being handed the wrong one is worse than being
handed none; double-clicking a panel's name puts it back.

Dragging happens under a full-window shield, because her screen is an iframe
and an iframe swallows the pointer the moment it crosses — without it the drag
stops dead halfway across.

**The work is visible while it happens.** One dim line in the rail is right for
a turn that reads a file and answers, and useless for watching her build
something, which is the case where he actually wants to see the machine work.
So the Work panel carries the steps as they land: reads stay faint, writes and
edits are cyan, the newest is the lit one, nine at a time. It empties when the
turn ends and the record folds into the transcript.

There is no audio-reactive core any more. It was a good centrepiece for a page
that was mostly empty and decoration once the room had real content in it. The
one piece of information in it — whether the microphone is hearing him, whether
she is making sound — is a two pixel line on the dock's own rule, present only
while one of those is true.

Two typefaces, doing two jobs. Serif is her; mono is the instrument she lives
inside — his typing, tool names, state, times. Cyan is her working, gold is her
speaking, and pale is him; their scarcity is what makes them mean anything.

The work she did in a turn folds into one line of English — "read two files and
ran a command · 4.2s" — that opens on click. Only the last seven steps are
built; anything older is one more click away and is not put in the page until
he asks, because thirty nodes under every exchange is a cost nobody reads the
bottom of.

**Her markdown is taken out twice, differently.** Set in the display serif,
`**like this**` reads as broken; handed to Kokoro, it is read aloud as
asterisks. So the page strips the markers for the eye and keeps what they
wrapped, and cleans separately for the ear the way `speakable()` does in
[voice.ts](src/voice.ts) — code fences become "code block", a Windows path
becomes its filename. A marker whose other half hasn't streamed in yet is held
back rather than drawn, so nothing flickers between literal and formatted.

On a phone it is not the desk folded up. Her state, the one thing that matters
now, and a way to answer; what she is showing takes the whole screen; and the
conversation is pulled up when he wants it rather than being the default view.

[hub.html](src/hub.html) is one file with no build step. The only thing it
fetches from outside is the fonts.

**A browser cannot send an `Authorization` header on a navigation, and
`EventSource` cannot send one at all**, so the token is also accepted as `?k=`.
The page reads it once and calls `history.replaceState` immediately, so it
stops living in the address bar and the history.

**Which is why the page itself is the one route with no lock on it.** Stripping
`?k=` means every reload after the first arrives bare, and behind the gate that
is a dead tab — the pinned tab a fixed address exists for could be opened
exactly once. The page holds no secrets and every route that carries anything
of his is still shut, so the door that opens is the doorframe, not the house.
The key is kept in the page's own `localStorage`, which the sandboxed screen
frame has no way to read, and a tab that has none says so and points at
`data/server.json` rather than sitting there dead.

**The core is driven by real audio, not by a loop.** The rail on the left is a
canvas whose rim follows the amplitude of whatever is actually making noise:
her voice when she is speaking, his when the microphone is open, both through
an `AnalyserNode`. It has one job, which is to be readable from across the room
without reading anything. Cyan is her working, gold is her speaking, and they
never appear together because they mean opposite things. Tool calls send a ring
outward, one each, so activity is countable rather than decorative.

A first attempt drew the constellation Vela behind the transcript. It was
cropped by `preserveAspectRatio="slice"` into three floating Greek letters and
no shape, which is a good reminder that a clever idea executed badly is just
mess. It was cut rather than fixed: the core does the same job better, because
it is driven by something real.

[anime.js](https://animejs.com) drives the load sequence, message entrances and
the state tweens. It is vendored and served from `/anime.js` rather than a CDN,
because she works with the network down and her own face should not be the
thing that stops. The page checks for it and runs still if it is missing, and
honours `prefers-reduced-motion`.

| Route | For |
|---|---|
| `GET /` | the page; the one route with no key on it, see below |
| `GET /events` | everything the core does, as it happens |
| `POST /turn` | say something to her |
| `POST /hear` | a browser recording in, words out |
| `POST /speak` | a sentence in, a wav out |
| `POST /warm` | he is about to speak or listen; load that model now |
| `GET /screen` | what she is showing: title, note, and the screen's own key |
| `GET /screen/file` | the shown file itself — the one route that key opens |
| `GET /anime.js` | the vendored motion library; the one unauthenticated route |

**The voice buttons are her voice, not the browser's.** `POST /speak` runs the
same Kokoro worker the terminal uses and returns the wav; `POST /hear` runs the
same warm whisper worker, with ffmpeg converting the browser's webm on the way
in. Measured on a round trip where she transcribed her own sentence: 0.36s to
render, 0.45s to read back, and the words came back exactly.

`/health` reports `canHear` and `canSpeak`, and the page hides the buttons it
cannot back, because a control that does nothing is worse than no control.

**Talking over her counts as an answer.** Pressing the microphone while she is
still speaking stops her mid-word and sets `cutOff` on the turn that follows.
The server prefixes that turn with a note saying she was interrupted and that
the last reply was longer than it needed to be. Feedback she never hears is
feedback wasted, and the fix she needs is a shorter next answer rather than an
apology for the last one. Typing over her does the same thing.

## Eyes

```
you › why does this look wrong
        · capture_screen the layout he says looks wrong
Vela › The right column is under the fold at that width.
```

`capture_screen` takes a picture of a monitor or a single window and hands it
back as an image. It exists for the questions whose answer is on screen and
can't be retyped: a schematic, a CAD viewport, an error dialog, a chart that
looks off. Pass part of a window title from `list_windows` to grab one app, or
a 1-based monitor number for a whole screen.

**It is pull-only, and that is the whole safety model.** It reads whatever
happens to be up, which will sometimes be his mail or a password manager, so
it is never on the heartbeat, never reachable from a watch, and only ever
happens because he asked in that turn. Every capture also lands as a PNG under
`data/screen/`, so there is a record on disk of exactly what was seen rather
than it being invisible.

The cost of this feature is pixels, so the picture is scaled on the way out:
800px on the long edge by default, 1568 with `detail`, and never upscaled. At
800 a schematic's labels are gone but "which app is that" survives, which is
most of what gets asked. Above 1568 an image stops buying readable detail and
only costs more.

Failures are sentences rather than throws, because the reader is the model and
the message is the fix: a window that isn't open names itself and points at
`list_windows`, a minimised one says it's minimised. A monitor number he
doesn't have falls back to the primary instead of refusing, on the grounds
that he miscounted and a picture of the wrong screen is answerable in one line
where an error is a wasted round trip.

## The screen

```
you › walk me through why the HPT blades fail
Vela › Creep, mostly. Look at the screen.
        · on screen: The high-pressure turbine
```

The stage: a panel in the hub that Vela can put a page on. She writes a
self-contained HTML file (usually under `data/screen/`), calls the
`show_screen` tool with a path and a title, and it appears beside the
conversation — a schematic, a chart, a table, anything a paragraph tells
badly. `clear_screen` takes it down; a new show replaces the old one. Each
showing gets its own id, which is what "go back to the engine" will resolve
against when screen history exists.

**Clicks come back as words.** A page can call
`parent.postMessage({ vela: "he clicked sensor 9, HPC outlet temperature" }, "*")`
and that sentence arrives as a turn, prefixed so she knows it came from the
screen rather than the keyboard. That is the whole interaction contract: her
pages don't get an API, they get her ear. The hub caps the payload at a
sentence's worth and only accepts it from the stage's own window.

**The page never holds the master token.** A sandboxed iframe can still read
its own URL, and she writes these pages with scripting on — some of them from
things she read on the internet. So the iframe's URL carries a *screen key*
instead: minted by the server, rotated on every show, and accepted by exactly
one route, `GET /screen/file`, which serves only the file currently up. It
cannot post a turn, open the event stream, or reach anything else. Underneath
that, the file is served with a CSP that closes `connect-src`, forms and
external scripts, so even a hostile page has nowhere to send whatever it
knows — which is only itself. The hub learns the key over the master-authed
channels (`/events` and `GET /screen`), where the browser page — his, not
hers — already holds the master token.

`GET /anime.js` became the one unauthenticated route for the same reason: a
sandboxed page has no token to offer, and a public copy of a public library
guards nothing. Everything else her pages might reference has to be inlined,
which is the point rather than a limitation — one file, no build step, same
as the hub itself.

**A screen is part of a conversation, and conversations end.** Reloading the
hub keeps it, because refreshing is not the same act as being finished with
it. The × takes it down everywhere, not just in that tab: it used to hide
locally, which meant the next page to open asked what was up and got back the
thing he had just closed. And a screen is only restored to a page opening
within `RESTORE_WITHIN_MS` (30 minutes) — otherwise the turbofan he looked at
this morning is still there tonight, and every time he opens her he is greeted
by the last thing she happened to show, which reads as her not having moved
on.

## Pauses

Sentences used to arrive flush against each other, because each one is
synthesised separately and the samples went straight after the last lot. A
fixed gap fixed that and introduced a worse problem: an even pause is as much a
tell as an even sentence length, and it lands as a machine reading a list.

`gapFor()` in [voice.ts](src/voice.ts) grades the pause by the mark the
sentence ended on. Measured at the default 150ms base:

| Ending | Example | Pause |
|---|---|---|
| clause | "Two things bother me," | ~105ms |
| statement | "Loud and clear." | ~185ms |
| question | "Are you there?" | ~250ms |
| paragraph | a blank line | ~395ms |

The jitter is a hash of the sentence, so the same words always pause the same
way and a replayed reply does not shimmer. The hub carries its own copy of the
same function, so both faces breathe alike rather than the browser inheriting
whatever the network gave it.

**The pauses only exist between pieces, so a long sentence has to become
several.** Speech was cut at `.`, `!` and `?` only, which meant a sentence with
three clauses in it went to Kokoro whole and came back as one unbroken run: the
comma got whatever prosody the model invents, which is close to none. Written
down it was three things; heard, it was one long line. `clauses()` in
[voice.ts](src/voice.ts) breaks a sentence at its commas, semicolons and colons
so each part is synthesised on its own and earns a beat after it.

It leaves things alone as often as it splits them. Under 70 characters is one
breath and cutting it invents a pause nobody would make ("Renamed it, tests
pass."). A fragment under three words is a stutter rather than a clause, so a
comma with too little on either side is passed over. Anything containing a code
fence is left whole, because those commas are code. The hub does the same
split, carrying character offsets with each piece so the reading head still
sweeps the right words.

## Always on

```powershell
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1           # start with Windows
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Remove   # stop doing that
```

She runs from logon, hidden, at one address: **http://127.0.0.1:4823**. Pin
that tab, install it as a browser app, give it a hotkey. There is no window to
find and nothing to start.

Two things had to change for an address to be worth pinning. The port was
random, and so was the token, both minted fresh on every start — correct for
something you launch and read a link out of, useless for something that is
simply always there, because the link died every restart. Now the port is
fixed (`VELA_PORT`) and the token is kept in `data/hub-token` and reused
(`VELA_KEEP_TOKEN`). If something else already holds the port she takes any
free one rather than failing to come up; a lost address beats no assistant.

A scheduled task rather than a Startup shortcut, because Startup runs the
`.bat` and that leaves a console window in the taskbar all day. The task runs
her through `wscript`, which is the one way on Windows to get a genuinely
invisible process: `-WindowStyle Hidden` on powershell.exe still flashes a
console. Her log goes to `data/service.log`.

**Idle, she is about 460MB and no measurable CPU.** She was 1.5GB, because the
service loaded both speech models at start: 1.1GB of Kokoro and 226MB of
whisper, held all day whether or not anyone ever pressed the microphone or the
speaker. Both are deferred now, and the hub warms whichever one he is about to
need at the gesture rather than at the sentence — `POST /warm` when he presses
record, or switches sound on. Measured:

| First sentence out of her | |
|---|---|
| cold, model loading | 4.65s |
| warmed at the button press | 0.30s |
| every sentence after | ~0.27s |

The terminal keeps loading both eagerly, since there he presses Enter and
talks and the load would land in the middle of that. `VELA_LAZY_WORKERS=off`
for the old behaviour.

| Variable | Default | Meaning |
|---|---|---|
| `VELA_PORT` | `4823` | Her fixed address. `0` asks the OS for any free port |
| `VELA_KEEP_TOKEN` | `on` | Reuse the saved key, so a pinned link keeps working |
| `VELA_LAZY_WORKERS` | `on` | Hold Kokoro and whisper until first use |

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
npm run dev            # she speaks
VELA_VOICE=off npm run dev
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
| `VELA_VOICE` | `on` | `off` for a quiet session |
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
speech on, the persona gains [a section](src/config.ts) that caps replies
at a sentence or two and bans the running commentary — "let me check X", pause,
"now let me look at Y" — which was most of what made her feel slow, since each
of those lines is a synthesis, a playback, and then silence while the tool
actually runs.

## Listening

```bash
npm run dev             # push-to-talk is on
VELA_LISTEN=off npm run dev
```

Push-to-talk: **Enter on an empty line starts recording, Enter again stops it**,
and the transcript goes into the same queue a typed line would. Using the input
that already exists beats a global-hotkey dependency. The terminal stays
push-to-talk on purpose: if a window is already open, pressing Enter is less
work than saying a name. The service listens for the name instead — see [the
wake word](#the-wake-word).

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
| `VELA_LISTEN` | `on` | `off` disables push-to-talk |
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

## The wake word

```bash
npm run serve              # she answers to her name
VELA_WAKE=off npm run serve
VELA_WAKE_DEBUG=on npm run serve   # print every transcript and its level
```

Say **"Vela, what's on my calendar"** and she answers out loud. Say just
**"Vela"** and she says "Yes?". Only the background service does this; the
terminal has push-to-talk, and two processes holding the same microphone is one
of them getting silence.

**It is not a wake-word model.** [listen.ts](src/listen.ts) used to say a wake
word meant training one on synthetic speech, and that is still true of the
usual approach and still not what this is. The microphone stays open, an energy
gate cuts the room into utterances, and the whisper worker that already exists
reads each one. What that trades is worth being plain about: a real wake model
runs on a 30ms frame for almost no CPU, where a whisper pass costs ~0.4s and
runs on everything said near the machine — locally, and nothing leaves it, but
on everything. In exchange there is no model to train, no new dependency, and
the decoder that already knows his voice does the recognising. The gate is the
seam: put a real wake model in front of it and whisper only sees what it
passes.

**Silence costs nothing.** The gate is what makes this affordable to leave on
all day. Nothing that isn't louder than the room ever becomes an utterance, so
an idle Vela with her ears open is the same idle Vela as before — no
transcription, no model call, nothing.

**The bar is relative, not fixed.** His microphone puts speech at about -49
dBFS, far below where any fixed threshold would sit, and a different room moves
that number again. So the gate learns what quiet sounds like here and asks only
that speech be louder than it, falling to a quiet room quickly and rising to a
noisy one slowly. It stops learning while he is talking — a floor that learned
from his voice would close the gate in the middle of his sentence — and it is
capped below where speech lives, so a fan starting up cannot raise the bar
until she goes deaf.

**The utterance carries the moment before it.** 600ms of pre-roll rides in
front of the opening frame, because the wake word is the *first* thing said and
a gate that starts recording once it is sure would clip the name off every
time.

**She doesn't hear herself.** The speakers are in the same room as the
microphone, so she stops listening while she talks and starts again once the
audio has actually finished playing. Without that she transcribes her own
reply, hears her own name in it, and answers it.

Waiting costs something: the player has to close for her to know the room is
quiet, so the next reply starts a fresh `ffplay` and pays its ~450ms startup
before the first word. The terminal keeps one player for a whole conversation
and pays that once, but it has a key press telling it when a turn begins.
Nothing here says when she has finished being heard except the player closing.

**The name isn't needed twice.** For eight seconds after a turn, the next thing
he says is taken as a turn without it — otherwise a conversation becomes a
command line. The window is measured from when she *stops* talking, not when
she started, so a long answer doesn't eat it.

**Her name is a list, not a word.** `base.en` has never heard "Vela" and
reaches for the nearest real word, so `villa`, `bella` and `vella` all count.
The name has to be at the front of the utterance or at the very end — "Vela,
what time is it" or "what time is it, Vela". A name in the middle is him
talking *about* her to someone else, and answering that is worse than missing
it.

She speaks these replies through the Kokoro the service already holds for the
hub, rather than a second copy of the same 1.1GB model. Only turns the wake
word started are played out here: a sentence typed into the hub is the
browser's to say, or it would be said twice.

| Variable | Default | Meaning |
|---|---|---|
| `VELA_WAKE` | `on` | `off` releases the microphone entirely |
| `VELA_WAKE_WORDS` | `vela` and its mishearings | Comma-separated; replaces the list, so it can turn one off |
| `VELA_WAKE_FOLLOWUP` | `8000` | Milliseconds she keeps listening after a turn; `0` requires the name every time |
| `VELA_WAKE_MARGIN` | `8` | dB over the room before a sound is speech. Lower hears more, including the keyboard |
| `VELA_WAKE_MAX` | `15000` | Longest single utterance sent to whisper |
| `VELA_WAKE_ACK` | `Yes?` | What she says to her name alone |
| `VELA_WAKE_DEBUG` | `off` | Print every transcript with its level and whether it woke her |

**When it goes wrong, `VELA_WAKE_DEBUG=on` says which way.** She never answers,
or she answers the television, and from outside those look identical and have
opposite fixes. The debug line shows which is happening, and the level printed
next to each transcript is what `VELA_WAKE_MARGIN` should be set against.

"Yes?" is canned rather than a model turn on purpose. He has said one word and
is waiting to hear whether she heard it; a second and a half of thinking to
produce "yes?" is the wrong trade, and a different acknowledgement every time
is worse than the same one.

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

The hub is a face and has no unit tests, for the same reason `index.ts`
doesn't. What it has instead is a pair of browser checks that drive the real
page against the real server, with a scripted core in place of the model, so
every state they put it in is one the core can actually produce:

```bash
npm run check:room                                  # in one terminal
uv run --with playwright python scripts/room-check.py       # then these
uv run --with playwright python scripts/room-idle-check.py
```

Between them they cover the states a screenshot can't: working with the tool
in the rail, the fold opening, one exchange at full weight, a line she started
herself, the stage taking the room and giving it back, a click inside her page
arriving as a turn, the screen key never being the master token, markdown
gone from both the page and her mouth, and the phone laying out as a phone
rather than a squeezed desk. They wait on conditions rather than clocks —
a fixed sleep passes on a fast machine and fails on a busy one, which is how a
suite learns to be ignored.

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

**A turn that only promised is handed straight back.** She had a habit of
answering "I'll fetch a real diagram and put it up, give me a second" and then
stopping — which ends the turn, because a turn ends the moment she stops
writing. There is no second, and he is left watching a finished reply for work
that never starts.

Prose alone did not fix it, because from inside the turn the sentence is true
when she writes it. What gives it away is the pair: the reply ends on an
intention *and* nothing ran. `endedOnAPromise()` in [core.ts](src/core.ts)
checks exactly that, and the core sends `UNFINISHED` back into the same turn,
the same way `CUT_OFF` tells her she was talked over. It fires once — a second
one would be a loop — it keeps her marked busy so the heartbeat doesn't cut in,
and it only looks at the tail of the reply, because narrating and then doing
the work is a different complaint. A turn with a tool call in it is never
touched.

**Thinking off has to carry an effort with it.** Claude Code's own
`settings.json` holds an `effortLevel`, the SDK inherits it, and `xhigh` with
thinking disabled is refused outright: every turn comes back as `API Error:
400`. Started from a shell that had already overridden it, this never showed
up. Started clean from the scheduled task at logon, she answered nothing else.
`sessionOptions` in [core.ts](src/core.ts) pins `effort: high` whenever
thinking is off, and `VELA_EFFORT` overrides it.

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
   "Vela" model trains on synthetic TTS audio, which Kokoro can generate),
   streaming STT/TTS. The core split it needed shipped in 1.1.0; what's left
   is the worker, the VAD endpointing, and thresholds tuned on a live mic.
2. Fabrication — CAD-as-code (`build123d`), slicer CLI, printer REST APIs, each
   as its own tool module.
3. More trigger kinds — a window title appearing, an HTTP endpoint changing
   shape. The `file` and `process` pair covers most of what's wanted so far.

## Versions

The version in `package.json` is read at startup and printed with the commit
under it, so `Vela 1.3.0 (c5e439d)` in the banner says exactly what is running.
She's told her own version too, which is what she answers with when asked.

The minor number goes up when she gains a sense or a limb; the patch when
something that was broken isn't. The major is for a change in what she is
rather than what she can do: 2.0.0 is where she stopped being something he
starts. It stayed at 1.0.0 for three releases because nothing read it, so if
you add to this list, bump it.

| Version | What she gained |
| --- | --- |
| 1.0.0 | Hands: files, shell, the Windows desktop, durable memory, an ambient heartbeat with watches. |
| 1.1.0 | The core split out of the terminal, so she survives the window closing. Service mode, edge-tts speech, push-to-talk. |
| 1.2.0 | A Kokoro voice worth listening to, one player for the whole conversation, and his name said right. |
| 1.3.0 | Whisper kept warm instead of reloaded per utterance, memory as an Obsidian vault, and the spoken turn cut down to where it feels live. |
| 1.4.0 | Skills discovered rather than listed, so she can be handed new hands without a code change. Thirty-four of them, and a voice spec that now says how to recover from a slip. |
| 1.4.1 | Speaking and listening on by default, because remembering a variable to be spoken to was the surprise, not the speech. The first and last sentence of every reply now get checked before it goes out, which is where she was still giving herself away. |
| 1.5.0 | A second face: a hub in the browser, with her own voice and her own ears behind it rather than the browser's. |
| 1.6.0 | A screen. She writes a page — a schematic, a chart, a clickable diagram — and puts it on the hub's stage, and what he does on it comes back to her as words. The page gets a key that opens one route and a CSP that closes the rest. |
| 2.0.0 | Always on. She starts with Windows, hidden, at one address worth pinning, and idles at 430MB instead of 1.5GB because the speech models wait until they are wanted. The major number is the point: she stopped being something he starts. Booting her from a clean environment is also what found the effort bug that would have made every turn a 400. |
| 2.0.1 | The pinned tab actually survives being reloaded. A fixed address and a page that threw its key away were two halves of this release contradicting each other. |
| 3.0.0 | A room instead of a page, and eyes. The hub stopped being a chat window with her bolted to the side: her presence is the ground, the stage takes the floor when she has something to show, and on a phone she is a different body rather than a squeezed desk. `capture_screen` lets her look at what is actually on his monitors. Her markdown stopped being read out loud. |
| 3.0.1 | A turn that only promised to do something gets handed back to her, so "give me a second" stops being where the work ends. |
| 3.0.2 | A screen she showed stops following him around: closing it closes it everywhere, and one he left this morning is not put back in front of him tonight. |
| 3.1.0 | A desk he can arrange. The work she is doing and the thing she is showing became panels he drags where he wants and that stay there, and the audio circle went, since the room has real content in it now. |
| 3.2.0 | She survives losing the model. A session that dies now surfaces the drop and stands itself back up instead of leaving her silently stuck, so a hit usage limit is a pause rather than a wedge. The work panel arrives with the first tool and leaves with the turn; talking over her stops her instead of reading into the mic. |
| 3.2.1 | A keep toggle on the Work panel pins it open between turns, remembered across reloads, for watching a long run from one place. |
| 3.3.0 | She hears the room. The service holds the microphone open and answers to her name, out loud, with no window open and nothing pressed — an energy gate keeps silence free, and the whisper worker she already had does the recognising rather than a wake model trained for it. |
