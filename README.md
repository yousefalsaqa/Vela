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
| `remember_voice` / `forget_voice` | Save a new person's voiceprint once they say yes; forget one on request |
| `tv_power` / `tv_volume` / `tv_remote` | The living-room TV: on, off, volume, play/pause and the buttons that can't land on the wrong thing |
| `tv_open` / `tv_netflix` / `tv_status` | Open an app on the TV, resume his Netflix show, say what the TV is doing |

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
instead: minted by the server, rotated on every show, and accepted by two
routes: `GET /screen/file`, which serves only the file currently up, and the
map's tiles under `/tiles`. It cannot post a turn, open the event stream, or
reach anything else. Underneath that, the file is served with a CSP that
closes `connect-src`, forms, external scripts and external images, so even a
hostile page has nowhere to send whatever it knows — which is only itself. The hub learns the key over the master-authed
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

## Places, on a live map

Ask where to eat, for coffee, a bar, groceries or a pharmacy, and she puts a
map on the stage: everything measured from his door. Rings mark 5, 10, 15 and
20 minutes on foot; each place is tagged with its own walking time; open places
are lit cyan, closed ones are not; home and whatever he picks are gold. The
list beside it reads like a departures board, soonest first, and a picked place
opens a card with today's hours, **Walk there** and **Ask Vela about it** —
both come back to her as words.

**The map moves; it is never redrawn.** "Expand the search" zooms the same map
out and fills it in. "Food on Princess Street" draws the street and shows what
is on it; "go further down" slides along it, "back" returns, "the third one"
picks it out. The state lives in the service ([places.ts](src/places.ts)),
changes stream to the hub as `map` events, and the hub hands them to the page
([map.html](src/map.html)) — which, like every screen, can reach nothing
itself.

**It answers from memory.** At startup she fetches every eatery, café, bar,
shop and pharmacy within 3.5 km, and the shape of every named street within
2.5 km, from OpenStreetMap, in the background. Searches around home then take
milliseconds; only somewhere further out, or the first time a far street is
named, goes to the network. Measured: a Princess Street search took 19.8 s when
the street was fetched at the moment it was named, and a busy server once made
it 35 s — so streets are learned before he asks.

| Piece | Where |
|---|---|
| Home | `data/home.json` — `{label, city, lat, lon}`, gitignored because the repo is public |
| Places and streets | `data/places-cache.json` (a day), `data/streets-cache.json` (a week) |
| Opening hours | Parsed from OpenStreetMap's `opening_hours`; anything it cannot read says "Hours unclear" rather than guess |
| Tiles | OpenStreetMap, darkened in CSS, fetched by Vela and kept in `data/tiles/` (a week). CARTO's dark tiles now demand an API key |

**The tiles come through her, not straight from OpenStreetMap.** The map runs
in the stage's sandboxed frame, so it has no origin and its requests carry no
Referer; OSM's tile policy wants every request to say who it is, and it
answered each one with a 403 tile reading "Access blocked". The server fetches
them instead ([tiles.ts](src/tiles.ts)), naming itself in its User-Agent and
caching each tile on disk for the week OSM's own headers allow. The page asks
`/tiles/z/x/y.png` with its screen key, which also let the screen's CSP drop
the last outside image host.

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
cadence that gives them away. A [warm worker](scripts/kokoro_worker.py) holds
the model so the 1.2s load is paid once at startup rather than per sentence,
and it only exists while voice is on.

**On the GPU when there is one.** This README used to say the GPU was worth
nothing at these lengths. Measured through the worker on his RTX 5060 laptop
GPU, it is worth most of the gap between her first word being written and him
hearing it:

| Sentence | CPU (24 threads) | GPU |
|---|---|---|
| "Yeah, you sound like Yousef." | 376-449ms | 55-111ms |
| Two sentences, 9 words | 595-676ms | 65-89ms |

The cost is ~1.2GB more RAM (CUDA's libraries), 720MB of video memory, and an
NVIDIA chip kept awake, which is fine on a machine that is mostly plugged in.
cuDNN off saved almost nothing and tripled the time. She uses
`~\.vela-tts-gpu` when it exists and `~\.vela-tts` otherwise. Built with the
driver's CUDA 12.9 in mind (torch's CUDA 13 builds need a newer driver):

```bash
uv pip freeze --python ~/.vela-tts/Scripts/python.exe | grep -v '^torch==' > req.txt
echo "torch==2.11.0+cu128" >> req.txt
uv venv ~/.vela-tts-gpu --python 3.14
uv pip install --python ~/.vela-tts-gpu/Scripts/python.exe -r req.txt \
  --extra-index-url https://download.pytorch.org/whl/cu128 --index-strategy unsafe-best-match
```

Delete `~\.vela-tts-gpu`, or point `VELA_KOKORO_PYTHON` at the CPU venv, to
go back.

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

**`saidSomething()` catches the ones it cannot name.** `cleanTranscript` works
by exact match, so it only ever catches the hallucinations whisper repeats. The
wake word made that insufficient: an open microphone hands whisper room tone all
day, and what comes back is novel, grammatical, and indistinguishable from an
instruction — "For a second, Kokoro" and "I think it's official about more" are
both real, both from a quiet room, and no list would have caught either. So the
worker now reports two numbers next to the text — `no_speech_prob`, whisper's
own belief that the audio was nothing, and `avg_logprob`, how much it believed
the words it picked — taken at their *worst* across segments, because a
hallucination is usually one confident segment beside a doubtful one and a mean
lets the confident half hide the other. Those describe the audio rather than the
words, and room tone scores badly whatever sentence it is turned into.

The bar is asymmetric, and deliberately so. **Push-to-talk is a promise that
speech happened** — he held a key and spoke into it — so the terminal and the
hub's record button pass `HEARD_ANYTHING` and are not filtered at all; the bar
there could only lose him a quiet real sentence. The wake word has no such
promise. It is guessing from loudness alone, which is why it needs the bar and
why it gets the strict one.

`VELA_WAKE_DEBUG=on` prints every utterance the bar threw away, with both
numbers, because a threshold nobody can see is a threshold he cannot move.

**And the wake word decodes with no prior at all.** `WHISPER_VOCABULARY` biases
the decoder towards his own words, which is worth 2.5 points of word error when
he has definitely spoken — and is the opposite of helpful when the caller is
only guessing that anyone spoke. Her name sat first in that list, so whisper,
handed room tone and primed with "Vela", wrote back "Vela": the bias was
manufacturing the exact word that wakes her. `For a second, Kokoro` came out of
a quiet room with Kokoro second in the same list. The prompt is per-utterance
now, so push-to-talk keeps the vocabulary that earns its place and the open
microphone gets `UNPROMPTED`.

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
npm run serve              # she answers to "Hey Vela"
VELA_WAKE=off npm run serve
VELA_WAKE_DEBUG=on npm run serve   # print every transcript and its level
```

Say **"Hey Vela, what's on my calendar"** and she answers out loud. Say just
**"Hey Vela"** and she chimes, and whatever he says next is the question. Only
the background service does this; the terminal has push-to-talk, and two
processes holding the same microphone is one of them getting silence.

**Her name is heard, not read.** For a month the wake word was whisper reading
an open microphone, and it failed in both directions. `base.en` has never seen
"Vela", so a real "Hey Vela" came back as "Hello, are you there?" and she
ignored him; primed with the name, it wrote "Vela" into other people's
sentences — "stick with us, Vela" — and she answered those. The openWakeWord
model trained on synthetic "hey vella" heard 2 of his 5.

[kws_worker.py](scripts/kws_worker.py) is a keyword spotter: sherpa-onnx's
3.3M-parameter streaming recogniser, trained on 10,000 hours of GigaSpeech and
only allowed to say the phrase. Nothing is trained for her. "Vela" does not
have to be a word it knows — it is spelled `▁HE Y ▁ VE LA`, pieces it has seen
thousands of times. Measured before it went in:

| Condition | Heard |
|---|---|
| Clean "Hey Vela", 15 voices × 5 phrasings × 3 speeds | 98% |
| At his microphone's -49 dBFS, lifted 20 dB | 93% |
| Someone else talking 10 dB under him | 92% |
| Someone else talking as loud as him | 40% |
| False wakes in 5.4 hours of LibriSpeech | none |
| Look-alike phrases ("hey bella", "umbrella", "vanilla", …) | 1–6% fire. "Hey Velma" is the one that reliably does |

It fires a median 330ms after he finishes saying "Vela" (never more than
560ms) and costs about 3% of one core.

**Instant is the chime.** The worker plays it itself, with the standard
library's `winsound`, in the same breath as it reports the detection: no pipe,
no player to start. At the same moment the service puts the hub on screen and
pages whisper and Kokoro back in. Idle for an hour, Windows had paged out
all but 113MB of whisper's 1.9GB, and the first transcription took 1.07s
against 0.53s once resident; the half second between the detection and the
utterance closing is where that now happens.

The chime replaces the spoken "Yes?" to her name alone. That line could only
come after whisper had read the utterance, a second after the chime had already
told him to go ahead, and she holds the microphone while she speaks — so it
landed on top of him and cut him off. It still goes on the screen.
`VELA_WAKE_CHIME=off` brings the spoken one back.

**One detection, one sentence.** A detection belongs to the utterance it landed
in and is spent there. It used to stay good for six seconds instead, which cut
both ways: a request longer than that lost its address, and the sentence after
"Hey Vela" was taken as addressed too, so "okay, what time is it" arrived as
"time is it". If the phrase was too quiet to open the gate — the spotter hears
further than the gate opens — nothing will ever claim the detection, so it is
answered as her name there and then.

**If the spotter will not load, she says so and falls back.** A detector that
is present switches the transcript path off, so one that failed to start and
was kept anyway would be an assistant deaf to her own name. The old path — her
name looked for in what whisper wrote down — is still here for that, and is
what `VELA_WAKE_DETECT=off` runs.

Setup, once. The model lives next to the venv, not in the repo:

```powershell
uv venv $HOME\.vela-wake --python 3.14          # if it is not there already
uv pip install --python $HOME\.vela-wake\Scripts\python.exe sherpa-onnx sentencepiece numpy
curl.exe -L -o kws.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2
mkdir $HOME\.vela-wake\kws; tar -xjf kws.tar.bz2 -C $HOME\.vela-wake\kws
```

Everything below still holds: the gate still cuts the room into utterances,
and whisper still reads each one addressed to her, for the question.

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
until she goes deaf. One exception to "only learns while quiet": a "sentence"
that runs the full fifteen seconds without a pause is the room, and the floor
moves up to the quieter part of it. Without that, a capture that opened on a
moment of silence spent four minutes sending fifteen-second blocks of hiss to
whisper before it learned the room.

**If the room reads as pure digital zero between words, it is a noise gate,
not a dead microphone.** On his Acer, PurifiedVoice did that, and cut any voice
not right at the screen along with it — he had to lean in to be heard, and
"you can go now" came back as "Even gone on". Its own console could not connect
to its service, so Windows audio enhancements are off for the microphone
instead (Sound control panel → Recording → Microphone Array → Advanced). Raw,
the array hisses at about -53 dBFS, which is why `vela-service.cmd` sets
`VELA_WAKE_FLOOR=-45` and `VELA_WAKE_MARGIN=10`.

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

**One address is worth one sentence.** Her name, one thing said, done — the
next sentence needs the name again. There is a follow-up window in here, and
it is off: for eight seconds after a turn it took the next sentence without
her name, which is lovely when she is right and is also the only thing between
one mis-fire and a room she keeps answering. A conversation belongs in the
hub, which he can ask her to open. The microphone is for the sentence he wants
said without opening anything.

`VELA_WAKE_FOLLOWUP` turns the window back on, in milliseconds, and
`VELA_WAKE_FOLLOWUPS` caps how many nameless sentences one address buys while
it is open. Two things learned the hard way live in that code: the window is
armed by her *name* alone, never renewed by what it lets through — the first
version renewed on anything and so was a latch, not a timer, and a single
mis-fire during a phone call turned every sentence of the call into a model
turn — and it is measured from when she *stops* talking, so a long answer
doesn't eat it.

**Every turn says what woke her.** The line she prints carries the alias that
matched — `you › (vella) what's on my calendar` — or `(follow-up)` when the
window let it through rather than her name. Answering her name alone prints
too. Without that, the one event worth seeing when she starts answering the
room — the mis-fire that opened the window — was the only one that was silent.

**On the transcript path, her name is a list, not a word.** `base.en` has never heard "Vela" and
reaches for the nearest real word, so `vella`, `veyla` and `velar` all count.
Mishearings that are also ordinary English words — `villa`, `bella`, `wella` —
are deliberately *not* on it: whisper really does produce them, and a name he
might say to another person costs more than it earns. `VELA_WAKE_WORDS` puts
one back if this microphone needs it.
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
| `VELA_WAKE_DETECT` | `on` | `off` drops the model and listens for her name in the transcript instead |
| `VELA_WAKE_ENGINE` | `spotter` | `openwakeword` runs `VELA_WAKE_MODEL` (default `hey_jarvis`) through wake_worker.py instead |
| `VELA_WAKE_PHRASES` | `hey vela,hey vella` | What the spotter listens for. Two spellings of one sound; the model hears them as different pieces |
| `VELA_WAKE_BOOST` | `3.0` | How hard the search favours the phrase. Higher hears more, near-misses included |
| `VELA_WAKE_TRIGGER` | `0.15` | How sure it must be before it fires. Lower hears more. Recall falls off a cliff by 0.25 |
| `VELA_WAKE_GAIN` | `20` | dB of lift before the spotter listens. Only the spotter hears it |
| `VELA_WAKE_CHIME` | `on` | `off` for her spoken "Yes?" instead, or a path to a .wav of his own |
| `VELA_WAKE_SPOTTER_MODEL` | `~\.vela-wake\kws\sherpa-onnx-kws-…` | The model directory |
| `VELA_WAKE_WORDS` | `vela` and its mishearings | Transcript path only. Comma-separated; replaces the list, so it can turn one off |
| `VELA_WAKE_FOLLOWUP` | `30000` | Milliseconds she keeps listening after a turn. `0` is one address, one sentence |
| `VELA_WAKE_FOLLOWUPS` | `6` | Nameless sentences one address buys while that window is open. This is what a mis-fire costs |
| `VELA_WAKE_MARGIN` | `8` | dB over the room before a sound is speech. Lower hears more, including the keyboard |
| `VELA_WAKE_FLOOR` | `-55` | The loudest the gate may believe the room is, in dBFS. Raise it after raising the microphone's input gain |
| `VELA_WAKE_MAX` | `15000` | Longest single utterance sent to whisper |
| `VELA_WAKE_EARLY` | `300` | Milliseconds of quiet before whisper starts reading, inside the gate's own wait. Used only if nothing loud follows; otherwise thrown away and the whole sentence read. `0` reads only after the gate closes |
| `VELA_WAKE_ACK` | `Yes?\|I'm here.\|Right here.\|Go on.\|Yeah?\|Still here.\|Listening.` | What she says to her name alone. Several, split on `\|`, never the same twice running |
| `VELA_WAKE_BYE` | `Okay.\|Alright.\|Sure.\|Right.` | What she says when he tells her they are finished. Same shape |
| `VELA_WAKE_FILLER` | `One sec.\|Let me see.\|Let me check.\|Hang on.` | What she says when she is slow to start answering. `off` for never |
| `VELA_WAKE_FILLER_AFTER` | `4000` | A safety net: milliseconds after the gate closes before a stalled answer is filled. The real trigger is her going to a tool without a word, which fills at once. See `src/filler.ts` |
| `VELA_WAKE_DEBUG` | `off` | Print every transcript with its level and whether it woke her |
| `VELA_SILENCE` | `0.5` | How sure whisper may be that an utterance was silence before it is thrown away. Higher lets more through |
| `VELA_LOGPROB` | `-1.0` | How badly whisper may doubt its own words. Lower lets more through |

**When it goes wrong, `VELA_WAKE_DEBUG=on` says which way.** She never answers,
or she answers the television, and from outside those look identical and have
opposite fixes. The debug line shows which is happening, and the level printed
next to each transcript is what `VELA_WAKE_MARGIN` should be set against.

With the chime off, "Yes?" is canned rather than a model turn on purpose. He has said one word and
is waiting to hear whether she heard it; a second and a half of thinking to
produce "yes?" is the wrong trade, and a different acknowledgement every time
is worse than the same one.

**A conversation that ran out is logged, always.** Talking without her name
just after the window closed prints `(not taken, 34.2s after the conversation
ran out: …)`, or `after 6 turns without her name` when the cap closed it. From
the outside that miss is identical to her having gone deaf, so it is never
behind the debug switch.

**Pressing her face in the hub is "Hey Vela" without the saying.** The next
thing he says is a spoken turn, with follow-ups and "you can go now" working
as they do after her name. Her window loads at boot, before the microphone is
open, so the service announces the room when it comes up; the page used to
look once, find no room, and treat the press as its own push-to-talk for the
rest of the day.

## Knowing when he has finished

The gate decides he is done after a fixed second of quiet. Shorter cut him off
mid-thought, so the second stays, and it is most of the pause between him
finishing and her answering: "how are you?" measured 1.0s of waiting, 1.0s of
the model and 0.2s of Kokoro. A fixed wait is the wrong shape. "How are you?"
is over when it ends; "can you find me, um..." isn't, however long he stops.

[turn.ts](src/turn.ts) takes a guess at every pause, 300ms in, from two clues
that are already to hand there:

- **The words.** Whisper reads what was said so far at that moment anyway (the
  early read). A sentence it closed with `.` `?` or `!` is a finished one,
  unless it is an ellipsis (whisper hearing him trail off) or the last word is
  one no sentence ends on ("and.", "the.", "um.").
- **The sound.** Smart Turn v3.2 ([pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn),
  BSD-2): a Whisper-tiny encoder with one linear layer, trained to hear a
  falling finish against a trailing "um". 8.7MB, about 30ms on one CPU thread.
  It runs in [turn_worker.py](scripts/turn_worker.py) under whisper's Python,
  which already has onnxruntime and numpy; the spectrogram is computed there
  directly and matches the reference to within 1e-6.

Both have to say done. It starts out **taking notes** (`VELA_TURN=shadow`, the
default): the fixed second still decides, and every guess is written to
`data/turns.jsonl` with what he actually did next. Quiet until the gate closed
is a man who had stopped; anything loud after the guess is him carrying on,
and a "done" followed by carrying on is exactly the cut-off acting on it would
have caused. After a few days of his real speech the threshold
(`VELA_TURN_AT`, 0.5 for now) is set from those, and `VELA_TURN=on` closes the
utterance the moment a guess says done. Sentences that weren't said to her
are written down marked `toHer: false`, so the TV doesn't set his threshold.

The model goes in `~/.vela-turn/` (`VELA_TURN_MODEL` to move it):

```
curl -L -o ~/.vela-turn/smart-turn-v3.2-cpu.onnx https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx
```

## Voices

She knows people by voice. Every utterance the gate cuts is turned into a
voiceprint by `scripts/voice_worker.py` (NeMo TitaNet-small through
sherpa-onnx, in the wake word's venv) while whisper is still reading it, so it
adds nothing to the wait. `src/voices.ts` compares it with the prints she has
saved, and each spoken turn reaches the model tagged `[Voice: Yousef]`,
`[Voice: new, not one you know]`, or with no tag when she cannot tell.

A new voice is asked who it is, then asked: "Nice to meet you, Sarah. Is it
okay to save your voiceprint in my memory, so I remember you?" Only on a yes
does she call `remember_voice`. The prints live in the `voice` table of
`data/vela.db` and never leave the machine.

The rules, all in `src/voices.ts` and all tested:

- **Saved only on that person's yes**, and only a voice that spoke *to her*.
  The microphone hears the television too, and it is not who she just asked.
- **A saved name is never overwritten** by a different voice. "I'm Yousef" in
  someone else's voice is refused, not merged into him.
- **Short is unsure, never new.** Below 1.5s of voice she does not call anyone
  a stranger, so a quick "yes" from him is not met with "who am I speaking to?"
- **A print improves as she uses it.** A sure match on 2s or more of voice is
  folded into that person's print, capped so the newest sample always counts
  for at least a thirtieth.

Measured before it went in, on real speech from five people (sherpa-onnx's
speaker-identification set). Equal error rate by length of speech:

| Model | Whole clip | 2.5s | 1.5s | 1.0s | Per utterance |
|---|---|---|---|---|---|
| NeMo TitaNet-small (used) | 0% | 1.4% | 3.1% | 10.5% | 7ms |
| 3D-Speaker ERes2Net | 0% | 0% | 5.0% | 8.6% | 20ms |
| WeSpeaker ResNet34 | 11% | 18% | 23% | 28% | 18ms |
| WeSpeaker CAM++ | 32% | 25% | 23% | 22% | 11ms |

Against a print averaged from two clips, the right person scored a median 0.56
on one second and 0.73 on two and a half; the best wrong person never passed
0.40. Hence the lines: 0.45 and clearly ahead of the next person is them, under
0.30 on 1.5s or more is someone new, and between is unsure. Those numbers are
from clean recordings; the log prints every score (`you › (follow-up · Yousef
0.62) …`) so they can be set against his real microphone.

| Variable | Default | |
|---|---|---|
| `VELA_VOICEPRINT` | `on` | `off` stops knowing anyone by voice. Off by itself when the model is missing |
| `VELA_VOICEPRINT_MODEL` | `~\.vela-wake\speaker\nemo_en_titanet_small.onnx` | Any sherpa-onnx speaker model. ERes2Net is as good and slower |

## The TV

[tv.ts](src/tv.ts) drives the living-room TV, a Fire TV Edition set (Fire OS
8, which is Android 11) on the router by Ethernet. It is adb over the network,
the way a developer would drive it: Developer Options, ADB Debugging on, and
this laptop's key approved once on the TV with "Always allow". Nothing to buy,
no cloud in the middle. adb comes from `winget install Google.PlatformTools`;
the address, AirPlay name and MAC are in `config.ts` (`VELA_TV_HOST`,
`VELA_TV_NAME`, `VELA_TV_MAC`).

**She can't see it.** Netflix refuses screenshots and draws its whole
interface on one canvas the accessibility tree reports as empty. The first
attempt at choosing a profile by pressing Up and OK blind landed on the show's
page and rated it. So the model only gets keys whose meaning doesn't depend on
what's focused (power, volume, play/pause, back, home, rewind, fast forward),
reaches everything else by name (an app's package, a show's link), and every
action reads back what the TV reports instead of trusting the press.

**Off has two depths.** Asleep for a while, it still answers adb, and
KEYCODE_WAKEUP brings it up, screensaver included. Later it drops off the
network entirely, and adb dialling it waits out Windows' 21 seconds. So a
one-and-a-half-second probe of the adb port goes first. For an ask that needs
the TV on (on, open, Netflix), a TV off the network gets a Wake-on-LAN packet,
which on this set is the power button: back on the network in 0.7s, screen on.
For anything else, it's off, said straight away, without waking it.

**Netflix.** "Open Netflix" opens it and stops: he picks the profile. "Resume
my show" uses Continue Watching, which Netflix hands to Fire TV's home screen
in the log about 15 seconds after every start: titles, ids, saved positions.
She keeps the latest copy in `data/netflix.json`, because the log turns over
within minutes of playback. The show's link (`netflix.com/watch/<id>`) skips
"Who's watching?" and plays on whichever profile was used last; that was
tested with the profile screen left up. From a fresh start the show's page is
up by 10 seconds and plays by itself at 25, and OK on that page is Resume, so
she presses OK once at 12 seconds. The check is the position Netflix reports
against the saved one, because the page's trailer also reports "playing", from
zero. If nothing plays by 45 seconds she says so and stops pressing.

If the router ever moves the TV, she finds it again by the name it answers
AirPlay's `/info` with, and only sweeps for it when it has to be on.

**Short commands skip the model.** In his first session "can you pause it?"
took 4.0s before she said anything: the model deciding to use the tool, the
TV doing it, and the model again to talk about it. And he asked her not to
narrate it. So [shortcuts.ts](src/shortcuts.ts) recognises a whole, short TV
command in whisper's text ("pause it", "turn it up a bit", "mute", "turn off
the TV", "resume my show"), does it directly, and stays quiet when it worked:
the TV doing it is the answer. When it didn't, she says why. Only the whole
utterance counts, politeness aside; "pause it, I want to ask you something"
goes to the model as before, because a wrong shortcut does something to his TV
he didn't ask for. A bare "pause" or "play" could be Spotify, so it is only
taken when the TV is on. The model is told what she did on his next turn, so
it isn't a secret from her. `VELA_TV_SHORTCUTS=off` sends everything to the
model.

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
  voices.ts    Who is talking: voiceprints, matching, and the rules for saving one
  tv.ts        The living-room TV over adb: power, volume, apps, Netflix, Wake-on-LAN
  turn.ts      Whether he has finished talking: the words so far and how they ended
  shortcuts.ts Short TV commands she does without the model
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
| 3.8.0 | She knows who is talking. A new voice is asked who it is and asked before its print is kept; his is refined every time she is sure. Her own resident window instead of a Chrome tab, a live map for places, faces, and greetings rendered once and played instantly. Faster everywhere: talking really runs on Sonnet now (the switch had been silently refused, so every spoken turn was Opus), whisper reads during the gate's wait instead of after it, "one sec" only when she is actually slow, and 2.6GB less memory committed. Pressing her face is "Hey Vela", a goodbye ends a longer sentence too, and a conversation that runs out on him is logged rather than looking like her going deaf. |
| 3.9.0 | Hands on the TV. On and off (woken over the network when it has gone fully to sleep), volume, the remote's safe buttons, apps by name, and "resume my show" on Netflix, checked against where he left off rather than assumed. Built around her not being able to see it: no blind Up, Down or OK. |
