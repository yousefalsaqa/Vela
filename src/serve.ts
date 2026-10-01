import { buildContextBlock, close, listVoices, saveVoice, forgetVoice } from "./memory.js";
import { createVoices, openVoiceprinter, useVoices, voiceTag, describe, type Identity, type Voices } from "./voices.js";
import { createCore } from "./core.js";
import { serve, readEndpoint, hubUrl, type RoomControls } from "./server.js";
import { reachable } from "./client.js";
import { spawn } from "./proc.js";
import {
  createTranscriber,
  cliTranscriber,
  pcmFromAudio,
  resolveFfmpeg,
  resolveFfplay,
  audioDevices,
  pickDevice,
  HEARD_ANYTHING,
  wakePrior,
  wavFromPcm,
} from "./listen.js";
import { DATA_DIR } from "./paths.js";
import { kokoroSynth, synthSpeaker, createVoice, speakable, PRONOUNCE_PHONEMES } from "./voice.js";
import { startWakeListener, type WakeListener } from "./wake.js";
import { openDetector, openSpotter, type WakeDetector } from "./detect.js";
import { places } from "./places.js";
import { createTiles } from "./tiles.js";
import { existsSync, createWriteStream, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BUILD } from "./version.js";
import {
  PERSONA,
  VOICE_PERSONA,
  VOICE_ON,
  HEARTBEAT_MS,
  HEARTBEAT_MODEL,
  HEARTBEAT_SKILLS,
  ensureClaudeOnPath,
  THINKING_ON,
  MODEL,
  TALK_MODEL,
  BUILTIN_TOOLS,
  EFFORT,
  SKILLS,
  NAME,
  OPEN_HUB,
  WAKE_OPENS_HUB,
  WAKE_CLOSES_HUB,
  PORT,
  KEEP_TOKEN,
  LAZY_WORKERS,
  WHISPER_PYTHON,
  WHISPER_WORKER,
  WHISPER_MODEL,
  WHISPER_DEVICE,
  WHISPER_VOCABULARY,
  WHISPER_MAX_SILENCE,
  WHISPER_MIN_LOGPROB,
  KOKORO_PYTHON,
  KOKORO_WORKER,
  KOKORO_VOICE,
  KOKORO_SPEED,
  FFMPEG,
  MIC,
  VOICE_GAP_MS,
  WAKE_ON,
  WAKE_WORDS,
  WAKE_LEAD_REQUIRED,
  WAKE_ACKS,
  WAKE_FILLERS,
  oneOf,
  WAKE_DEBUG,
  WAKE_MARGIN_DB,
  WAKE_MAX_MS,
  WAKE_PREROLL_MS,
  WAKE_HANGOVER_MS,
  WAKE_FLOOR_MAX,
  WAKE_VOCABULARY,
  WAKE_FOLLOWUP_MS,
  WAKE_FOLLOWUPS,
  WAKE_BYES,
  WAKE_DETECT,
  WAKE_ENGINE,
  WAKE_MODEL,
  WAKE_PYTHON,
  WAKE_WORKER,
  WAKE_SCORE,
  WAKE_VAD,
  KWS_WORKER,
  WAKE_SPOTTER_MODEL,
  WAKE_PHRASES,
  WAKE_BOOST,
  WAKE_TRIGGER,
  WAKE_GAIN_DB,
  WAKE_CHIME,
  WAKE_TAPE,
  WAKE_NAME_QUIET_MS,
  pickGreeting,
  ALL_GREETINGS,
  CLIP_PYTHON,
  CLIP_WORKER,
  CLIP_DIR,
  CLIP_TAIL_MS,
  WINDOW_ON,
  WINDOW_PYTHON,
  WINDOW_WORKER,
  WINDOW_STORAGE,
  VOICEPRINT_ON,
  WAKE_EARLY_MS,
  WAKE_FILL_AFTER_MS,
  VOICEPRINT_MODEL,
  VOICEPRINT_WORKER,
} from "./config.js";
import { createClips, type Clips } from "./clips.js";
import { createFiller } from "./filler.js";
import { openWindow, type DeskWindow } from "./window.js";

/**
 * Hand the URL to whatever the machine uses for links.
 *
 * `start` is a cmd builtin rather than a program, and its first quoted
 * argument is taken as the window title, hence the empty one.
 */
function openInBrowser(url: string) {
  try {
    spawn("cmd.exe", ["/c", "start", "", url], { windowsHide: true, stdio: "ignore" });
  } catch {
    /* she is still running; he can click the printed link */
  }
}

/** Released on shutdown. A no-op until the wake word actually starts. */
let stopListening: () => void = () => {};

/**
 * Vela as a background service. Clients — the REPL, the hub, and the wake word
 * — attach and detach; she keeps her session, her watches and her memory
 * throughout.
 */
async function main() {
  // Double-clicking the shortcut twice should show her, not fail to bind a
  // port. If she is already up, this process has nothing to add: point the
  // browser at the one that is running and get out of the way.
  const running = readEndpoint();
  if (running && (await reachable(running))) {
    console.log(`\n  ${NAME} is already running (pid ${running.pid}). Opening the hub.\n`);
    openInBrowser(hubUrl(running));
    close();
    return;
  }

  // Same reason as the REPL: the bundled `claude` is not on PATH by itself.
  ensureClaudeOnPath();
  const context = buildContextBlock();
  // The prompt lives here, but the speaking happens in whichever client
  // attached — so the service has to be told that its replies will be heard.
  const persona = VOICE_ON ? `${PERSONA}\n\n${VOICE_PERSONA}` : PERSONA;
  const core = createCore({
    systemPrompt: context ? `${persona}\n\n${context}` : persona,
    heartbeatMs: HEARTBEAT_MS,
    heartbeatModel: HEARTBEAT_MODEL,
    model: MODEL,
    talkModel: TALK_MODEL,
    tools: BUILTIN_TOOLS,
    thinking: THINKING_ON,
    effort: EFFORT,
    skills: SKILLS,
    heartbeatSkills: HEARTBEAT_SKILLS,
    onProblem: (why) => console.log(`  \x1b[33mModel:\x1b[0m ${why}`),
  });

  // The service grows ears and a voice of its own, for the hub. The terminal
  // client keeps its own pair; these never play or record anything locally,
  // they only turn bytes into words and back for whoever is holding the page.
  const ffmpeg = resolveFfmpeg(process.env.VELA_FFMPEG) ?? FFMPEG;
  const ears = existsSync(WHISPER_PYTHON)
    ? createTranscriber({
        python: WHISPER_PYTHON,
        worker: WHISPER_WORKER,
        model: WHISPER_MODEL,
        computeDevice: WHISPER_DEVICE,
        vocabulary: WHISPER_VOCABULARY,
        // She sits idle most of the day; the model can wait until he speaks.
        lazy: LAZY_WORKERS,
        // One transcriber serves both the hub's button and the open microphone.
        // The gate matters for the second — a hallucinated sentence there is a
        // session nobody started — and costs the first nothing, because a press
        // whisper scores as silence is a press that recorded silence.
        maxSilence: WHISPER_MAX_SILENCE,
        minLogprob: WHISPER_MIN_LOGPROB,
        onDropped: ({ text, silence, logprob }) => {
          if (WAKE_DEBUG) {
            console.log(
              `  [90m× silence ${silence?.toFixed(2)} logprob ${logprob?.toFixed(2)}  ${text}[0m`,
            );
          }
        },
        // The scores a wake was accepted on. Without these the log showed
        // every utterance she ignored and nothing about the one she answered,
        // which is the only one a false wake can be.
        onKept: ({ text, silence, logprob }) => {
          if (WAKE_DEBUG) {
            console.log(
              `  [90m✓ silence ${silence?.toFixed(2)} logprob ${logprob?.toFixed(2)}  ${text}[0m`,
            );
          }
        },
        onProblem: (why) => console.log(`  Transcription: ${why}`),
      })
    : cliTranscriber({ model: WHISPER_MODEL, computeDevice: WHISPER_DEVICE });

  const mouth = existsSync(KOKORO_PYTHON)
    ? kokoroSynth({
        python: KOKORO_PYTHON,
        worker: KOKORO_WORKER,
        voice: KOKORO_VOICE,
        speed: KOKORO_SPEED,
        // 1.1GB she only needs if he presses the speaker button.
        lazy: LAZY_WORKERS,
        onProblem: (why) => console.log(`  Voice: ${why}`),
      })
    : null;

  /**
   * True only for a turn the wake word started, and she is speaking it aloud.
   *
   * Declared out here because two things need it: the room's own mouth, below,
   * and the handshake a hub does when it attaches. A hub that opens part-way
   * through a spoken turn has to be told the room is not silent, or it says
   * the rest of the reply over her.
   */
  let answering = false;

  /**
   * The last line she said that was not a turn — "Yes?" to her name — and
   * when. Same reason as `answering`: the hub her name opened is still
   * starting when she says it, so the announcement misses it and the
   * handshake has to carry it. See `sayLine`.
   */
  let lastSaid: { text: string; at: number } | null = null;

  /**
   * The room's controls, once there is a room.
   *
   * Null until the wake word is listening, and null forever on a service that
   * has no microphone or no voice — which is what tells the hub to fall back
   * to its own. Late-bound because the room is built after the server: the
   * wake word needs somewhere to announce before it can listen.
   */
  let room: RoomControls | null = null;

  const server = await serve({
    core,
    name: NAME,
    map: places(),
    tiles: createTiles(),
    aloud: () => answering,
    lastSaid: () => lastSaid,
    room: () => room,
    // A fixed port and a kept token are what make her hub pinnable.
    port: PORT,
    keepToken: KEEP_TOKEN,
    // He pressed record and spoke, so the confidence bar the wake word needs
    // would only lose him a quiet real sentence here. See HEARD_ANYTHING.
    hear: async (audio) =>
      ears.hear(await pcmFromAudio(audio, { ffmpeg }), HEARD_ANYTHING),
    ...(mouth ? { render: (text: string) => mouth.render(text) } : {}),
    // The hub says so the moment he presses record or switches sound on, so a
    // deferred model loads in that gap instead of after it.
    warm: (what) => (what === "ears" ? ears.warm() : mouth?.warm()),
  });

  /**
   * Her own window, made now and kept loaded behind the scenes, so that being
   * called puts her on screen in the time it takes to show a window rather
   * than start a browser. See scripts/window_worker.py.
   *
   * Null without its Python, and then everything that would show it opens the
   * browser as before. A window that dies is dropped the same way: the page
   * it was holding is gone, and showing nothing is worse than a slow tab.
   */
  let desk: DeskWindow | null =
    WINDOW_ON && existsSync(WINDOW_PYTHON)
      ? openWindow({
          python: WINDOW_PYTHON,
          worker: WINDOW_WORKER,
          url: hubUrl(server.endpoint),
          title: NAME,
          storage: WINDOW_STORAGE,
          onProblem: (why) => {
            console.log(`  [33mWindow:[0m ${why}`);
          },
        })
      : null;
  if (desk) {
    void desk.ready.then((up) => {
      if (up) console.log(`  [90m(her window is loaded, out of sight until she's called)[0m`);
      else desk = null;
    });
  }
  /** Her window if she has one, the browser if she does not. */
  const showWindow = (url: string) => {
    if (!desk?.show()) openInBrowser(url);
  };
  /**
   * Her ears, always open.
   *
   * The hub's microphone button and the terminal's push-to-talk both say when
   * a turn starts. This has to work that out from the room, so it has a mouth
   * of its own as well: a reply that only appears in a browser tab is no use
   * to someone who never opened one.
   */
  async function startListening(): Promise<WakeListener | null> {
    const off = (why: string) => {
      console.log(`  \x1b[33mWake word off:\x1b[0m ${why}`);
      return null;
    };
    if (!mouth) {
      return off(
        "Kokoro isn't installed, so she'd have no way to answer out loud." +
          " Set VELA_KOKORO_PYTHON, or VELA_WAKE=off to stop saying this.",
      );
    }
    const device = pickDevice(await audioDevices(ffmpeg), MIC);
    if (!device) return off("ffmpeg found no microphone. Check sound settings, or set VELA_MIC.");

    // Every firing, debug or not. A chime with no answer after it is the one
    // failure this line exists to make visible.
    const heardIt = (score: number) =>
      console.log(`  \x1b[90m^ heard her name${WAKE_DEBUG ? ` (${score.toFixed(3)})` : ""}\x1b[0m`);
    const complain = (why: string) => console.log(`  \x1b[33mWake model:\x1b[0m ${why}`);
    /**
     * The wake word model, if she has one.
     *
     * Null falls back to the old path — her name looked for in whatever
     * whisper wrote down — which still works and is still tested, and is what
     * runs on a machine where the model was never installed. Saying which one
     * is running matters, because a model that quietly failed to load looks
     * exactly like a room nobody has spoken in.
     */
    const openModel = (): WakeDetector | null => {
      if (!WAKE_DETECT || !existsSync(WAKE_PYTHON)) return null;
      if (WAKE_ENGINE === "openwakeword") {
        return openDetector({
          python: WAKE_PYTHON,
          worker: WAKE_WORKER,
          model: WAKE_MODEL,
          threshold: WAKE_SCORE,
          vad: WAKE_VAD,
          onWake: heardIt,
          onProblem: complain,
        });
      }
      if (!existsSync(WAKE_SPOTTER_MODEL)) {
        complain(`no spotter model at ${WAKE_SPOTTER_MODEL}; see README, "The wake word".`);
        return null;
      }
      return openSpotter({
        python: WAKE_PYTHON,
        worker: KWS_WORKER,
        model: WAKE_SPOTTER_MODEL,
        phrases: WAKE_PHRASES,
        boost: WAKE_BOOST,
        trigger: WAKE_TRIGGER,
        gainDb: WAKE_GAIN_DB,
        chime: WAKE_CHIME,
        onWake: heardIt,
        onProblem: complain,
      });
    };
    // Loading the model costs under a second. Doing it here rather than
    // inside his first sentence is the same trade the speech models make.
    //
    // One that never came up is dropped rather than kept: present, it would
    // switch the transcript path off, and she would hear nothing at all.
    const opened = openModel();
    const detector = opened && (await opened.ready) ? opened : null;
    if (opened && !detector) {
      opened.stop();
      complain("it did not load, so her name is listened for in the transcript instead.");
    }
    /**
     * Who is talking. See src/voices.ts.
     *
     * Loaded alongside the wake model, for the same reason: the first sentence
     * he says is the one it is needed for. One that never came up is dropped,
     * and she carries on exactly as before, without knowing anyone by voice.
     */
    const openVoices = async (): Promise<{ voices: Voices; stop: () => void } | null> => {
      if (!VOICEPRINT_ON || !existsSync(WAKE_PYTHON) || !existsSync(VOICEPRINT_MODEL)) return null;
      const printer = openVoiceprinter({
        python: WAKE_PYTHON,
        worker: VOICEPRINT_WORKER,
        model: VOICEPRINT_MODEL,
        onProblem: (why) => console.log(`  \x1b[33mVoices:\x1b[0m ${why}`),
      });
      if (!(await printer.ready)) {
        printer.stop();
        return null;
      }
      const voices = createVoices({ print: printer.print, store: { listVoices, saveVoice, forgetVoice } });
      useVoices(voices);
      return {
        voices,
        stop: () => {
          useVoices(null);
          printer.stop();
        },
      };
    };
    const known = await openVoices();
    const voices = known?.voices ?? null;

    /**
     * Whose voice it was, if that is known in time to matter.
     *
     * It started when the gate cut the sentence and takes milliseconds, so by
     * the time whisper is done it is done. The wait is bounded anyway: a worker
     * that has wedged must cost the tag, never the turn.
     */
    const voiceOf = (who: Promise<Identity | null>): Promise<Identity | null> =>
      Promise.race([who, new Promise<null>((r) => setTimeout(() => r(null), 400).unref?.())]);

    /** She answers her name with the chime, so a spoken "Yes?" would be a second answer. */
    const chiming = detector !== null && WAKE_ENGINE === "spotter" && WAKE_CHIME !== "off";

    /**
     * Where the seconds of a spoken turn went, printed as she starts to speak:
     * whisper reading what he said, the model thinking, and its first words
     * becoming sound. What he waits through is these three plus the 0.7s the
     * gate holds to be sure he has stopped — and without the split, "she takes
     * a while" has no answer but a guess.
     */
    let lastCut = 0;
    let clock: { cut: number; heard: number; thought?: number } | null = null;
    const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

    const speaker = synthSpeaker({
      render: (text) => mouth.render(text),
      play: resolveFfplay() ?? "ffplay",
      gapMs: VOICE_GAP_MS,
      onProblem: (why) => console.log(`  Voice: ${why}`),
      // A turn that renders nothing reports nothing, which is what silence
      // looked like from the outside. This says a sentence reached the player.
      onSpoke: (text, ms) => {
        // The filler is not part of the reply the hub is drawing, so it gets
        // no reading head and does not count as her starting to answer.
        if (fillerWords.has(text)) {
          console.log(`  \x1b[90m(${text})\x1b[0m`);
          return;
        }
        if (clock?.thought) {
          const now = Date.now();
          console.log(
            `  \x1b[90m(read ${secs(clock.heard - clock.cut)} · thought ${secs(clock.thought - clock.heard)}` +
              ` · voiced ${secs(now - clock.thought)})\x1b[0m`,
          );
          clock = null;
        }
        console.log(`  \x1b[90m(speaking)\x1b[0m`);
        // A hub cannot hear the room, so the reading head it draws over her
        // words has no clock to follow. This is that clock: the sentence that
        // just started, and how long its samples last. See sweep() in hub.html.
        server.announce({ type: "saying", text, ms });
      },
    });
    // Kokoro takes inline phonemes rather than a respelling; see voice.ts.
    const voice = createVoice(speaker.speak, PRONOUNCE_PHONEMES);

    /**
     * Her answers to her name, rendered once and played like the chime. See
     * src/clips.ts. Null without a Python to play them, and then she answers
     * the slow way, through Kokoro and ffplay, as before.
     */
    const clips: Clips | null = existsSync(CLIP_PYTHON)
      ? createClips({
          dir: CLIP_DIR,
          render: (spoken) => mouth.render(spoken),
          speak: (line) => speakable(line, PRONOUNCE_PHONEMES),
          voice: `${KOKORO_VOICE}@${KOKORO_SPEED}`,
          python: CLIP_PYTHON,
          worker: CLIP_WORKER,
          onProblem: (why) => console.log(`  \x1b[33mClips:\x1b[0m ${why}`),
        })
      : null;

    /**
     * The two mutes, which are the hub's two buttons.
     *
     * Muting him is not the same as the hold she puts on the microphone while
     * she is talking, even though both stop her hearing: the hold is hers and
     * ends when she stops, this is his and ends when he says so. Everything
     * that resumes after a reply has to ask this first, or her own hold would
     * quietly un-mute him at the end of every turn.
     *
     * Muting her is narrower than it sounds. She still takes the turn, still
     * thinks, still writes every word into the hub — she just does not say it
     * into the room. Which is the point: he wanted to stop the noise without
     * stopping her.
     */
    let hearing = true;
    let speakingAloud = true;
    /**
     * He has heard enough of this particular reply.
     *
     * Narrower than muting her, and it has to be per-turn: voice.stop() only
     * empties the buffer, so without a flag every delta still arriving would
     * be spoken straight past the interruption. Cleared when the next turn
     * opens, because being cut off once is not a setting.
     */
    let cutTurn = false;
    const listenAgain = () => {
      if (hearing) listener.resume();
    };

    /**
     * The end of a spoken turn: say the last fragment, wait for the room to
     * go quiet, and only then start listening again. Without the wait she
     * hears the tail of her own sentence and takes it for his.
     *
     * Draining closes the player, so the next reply starts a new one and pays
     * ffplay's ~450ms startup before its first word. The terminal keeps one
     * player for a whole conversation and pays that once, but it has a key
     * press telling it when a turn begins and can afford to. Nothing here
     * says when she has finished being heard except the player closing. The
     * alternative is timing the tail from the samples written, which is exact
     * arithmetic over an inexact start, and getting it wrong means she
     * answers herself.
     */
    /**
     * This reply ends the conversation: he said something and then that he
     * was going. Her window goes once she has finished saying it.
     */
    let lastWord = false;
    const finish = async () => {
      if (!answering) return;
      answering = false;
      filler.reset();
      const going = lastWord;
      lastWord = false;
      server.announce({ type: "aloud", value: false });
      voice.flush();
      await speaker.drain?.().catch(() => {});
      // After she has been heard, not before: the window carries her reply.
      if (going) {
        console.log(`  \x1b[90m(session closed, after answering)\x1b[0m`);
        hideHer();
      }
      listenAgain();
    };

    core.subscribe((event) => {
      if (!answering) return;
      if ((event.type === "delta" || event.type === "result") && clock && !clock.thought) {
        clock.thought = Date.now();
      }
      // Her reply has begun, so there is no silence left to fill; or she has
      // gone to a tool without a word, and the silence is going to be long.
      if (event.type === "delta" || event.type === "result") filler.started();
      else if (event.type === "activity") filler.working();
      if (event.type === "delta") { if (speakingAloud && !cutTurn) voice.push(event.text); }
      else if (event.type === "result") {
        if (event.text && speakingAloud && !cutTurn) voice.push(event.text);
        void finish();
      } else if (event.type === "error") void finish();
    });

    /**
     * Put her on screen, because she has just been spoken to.
     *
     * Being answered by a voice from a laptop showing nothing is the problem
     * this solves: he cannot see what she is doing, what she is working from,
     * or how to stop her. A hub opened the moment she is addressed is all
     * three, and it is already the thing that can stop her.
     *
     * Not once per turn. A tab already attached is the one he is looking at,
     * and the seconds a browser takes to start and connect are seconds when
     * nothing is attached yet — so a follow-up in that gap would open a second
     * window on top of the first. The stamp covers the gap, `attached` the rest.
     */
    let openedAt = 0;
    const showHer = () => {
      if (!WAKE_OPENS_HUB) return;
      // Her own window is already loaded and attached, so it is shown every
      // time — the attached count would otherwise say she is already up.
      if (desk?.show()) return;
      if (server.attached() > 0) return;
      if (openedAt && Date.now() - openedAt < 20_000) return;
      openedAt = Date.now();
      openInBrowser(hubUrl(server.endpoint));
    };

    /**
     * Take it away again, now the conversation is over.
     *
     * Announced rather than done, because nothing on this side of the socket
     * can close a browser window: the page has to close itself, and only some
     * browsers will let it. So this is a request, the hub obeys it if it can,
     * and a hub that cannot says so on screen instead.
     *
     * Every hub hears it, not one chosen window. Telling them apart needed an
     * id in the address bar, and that made the link different every time —
     * which cost the pinnable link this release exists for, to protect a tab
     * he was happy to have closed.
     *
     * The count is logged because the failure is otherwise invisible from
     * either side: `announce` only reaches hubs that are attached *now*, so a
     * window still starting up when he says goodbye never hears it and stays
     * open forever, looking exactly like a page that ignored the request.
     *
     * Forgetting the window matters as much as asking it to go, or `openedAt`
     * would suppress the next one for twenty seconds after the tab it was
     * guarding has gone.
     */
    const hideHer = () => {
      if (!WAKE_CLOSES_HUB) return;
      console.log(`  [90m(closing the hub; ${server.attached()} attached)[0m`);
      server.announce({ type: "dismissed" });
      // Her window cannot close itself and should not: it is hidden instead,
      // loaded and ready for the next time.
      desk?.hide();
      openedAt = 0;
    };

    /**
     * A canned line: her acknowledgement, her goodbye.
     *
     * Out loud, and on the screen. The hub only ever draws what comes down
     * the event stream, and these never went down it — they are not model
     * turns — so "Yes?" was a voice from a page showing nothing, which is the
     * exact complaint showHer answers. Announced as a "say", the shape the
     * hub already draws for a line she started herself.
     *
     * Never the same one twice running, which is the persona's rule for this
     * and the reason the lines are lists. Announced even when she is muted:
     * muting her stops the noise, not the writing.
     */
    /**
     * The player opened on a guess — the model fired, so something is likely
     * to be said — and closed again if nothing is. An opened player is an open
     * audio stream, and a bare "Hey Vela" in chime mode says nothing through
     * it; the guess must not hold the device for the rest of the day.
     */
    let unused: ReturnType<typeof setTimeout> | null = null;
    const openAhead = () => {
      if (!speakingAloud) return;
      speaker.open?.();
      if (unused) clearTimeout(unused);
      unused = setTimeout(() => {
        unused = null;
        if (!answering) void speaker.drain?.();
      }, 8_000);
      unused.unref?.();
    };

    /**
     * "One sec", when she is slow and only then. See src/filler.ts for when,
     * and WAKE_FILLERS for which. Rendered at startup so it costs nothing to
     * say, and never the same one twice.
     */
    let lastFill = "";
    const filler = createFiller({
      afterMs: WAKE_FILL_AFTER_MS,
      say: () => {
        if (!speakingAloud || !WAKE_FILLERS.length) return;
        const line = oneOf(WAKE_FILLERS, lastFill);
        lastFill = line;
        voice.say(line);
      },
    });
    /** What a filler looks like by the time it reaches the speaker. */
    const fillerWords = new Set(WAKE_FILLERS.map((l) => speakable(l, PRONOUNCE_PHONEMES)));

    /** "1:29 pm, Wednesday 30 September", the way he would say it. */
    const timeNow = () => {
      const d = new Date();
      const h = d.getHours();
      const clockFace = `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
      const day = d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
      return `${clockFace}, ${day}`;
    };

    let lastLine = "";
    /** Put a canned line on the screen, as hers. */
    const tell = (line: string) => {
      lastLine = line;
      lastSaid = { text: line, at: Date.now() };
      server.announce({ type: "say", text: line });
    };
    const sayLine = (lines: string[], aloud = true) => {
      const line = oneOf(lines, lastLine);
      tell(line);
      if (speakingAloud && aloud) voice.say(line);
    };

    /**
     * Say a line from its file, and hold the microphone for exactly as long
     * as it lasts plus the echo's way back. False when it cannot be played
     * that way, and the caller says it the slow way instead.
     *
     * The hold is the same one a reply takes, for the same reason: she is in
     * the room with the microphone. Timed rather than awaited, because winsound
     * says nothing when it finishes and the length is already known exactly.
     */
    let clipDone: ReturnType<typeof setTimeout> | null = null;
    const sayClip = (line: string): boolean => {
      if (!clips || !speakingAloud) return false;
      const ms = clips.play(line);
      if (ms === null) return false;
      listener.hold();
      if (clipDone) clearTimeout(clipDone);
      clipDone = setTimeout(() => {
        clipDone = null;
        if (!answering) listenAgain();
      }, ms + CLIP_TAIL_MS);
      return true;
    };

    /**
     * What she will say to her name this time, chosen the moment the model
     * hears it so the choice costs nothing when it is needed. A greeting the
     * first time in a while, an acknowledgement otherwise. See pickGreeting.
     */
    let calledAt = 0;
    let greeting = "";
    const nextGreeting = () => {
      const now = new Date();
      const line = pickGreeting({ now, lastAt: calledAt, last: lastLine });
      calledAt = now.getTime();
      return line;
    };

    /**
     * The attempts at her name that came before the one she heard. See
     * onMissed in wake.ts. Kept as .wav so they can be replayed through the
     * spotter, and only the most recent, since this is diagnosis rather than
     * an archive of the room.
     */
    const missedDir = join(DATA_DIR, "wake-missed");
    const keepMissed = (missed: { pcm: Buffer; level: number; agoMs: number }[]) => {
      try {
        mkdirSync(missedDir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        missed.forEach((m, i) =>
          writeFileSync(
            join(missedDir, `${stamp}-${i}-${Math.round(m.level)}dB-${(m.agoMs / 1000).toFixed(1)}s-before.wav`),
            wavFromPcm(m.pcm),
          ),
        );
        const all = readdirSync(missedDir).sort();
        for (const old of all.slice(0, Math.max(0, all.length - 60))) rmSync(join(missedDir, old), { force: true });
        console.log(
          `  \x1b[90m(kept ${missed.length} sound${missed.length === 1 ? "" : "s"} she may have missed her name in)\x1b[0m`,
        );
      } catch {
        /* diagnostics must never cost her the turn */
      }
    };

    // What she heard, for when she did not answer. See WAKE_TAPE.
    const tape = WAKE_TAPE ? createWriteStream(WAKE_TAPE, { flags: "a" }) : null;
    if (tape) console.log(`  \x1b[33mRecording what she hears to ${WAKE_TAPE}\x1b[0m`);

    const listener = startWakeListener({
      device,
      detector,
      ffmpeg,
      ...(tape ? { onAudio: (pcm: Buffer) => void tape.write(pcm) } : {}),
      words: WAKE_WORDS,
      requireLead: WAKE_LEAD_REQUIRED,
      followUpMs: WAKE_FOLLOWUP_MS,
      followUps: WAKE_FOLLOWUPS,
      nameQuietMs: WAKE_NAME_QUIET_MS,
      onMissed: keepMissed,
      ...(voices ? { who: (pcm: Buffer) => voices.listen(pcm) } : {}),
      segment: {
        marginDb: WAKE_MARGIN_DB,
        maxMs: WAKE_MAX_MS,
        floorMax: WAKE_FLOOR_MAX,
        preRollMs: WAKE_PREROLL_MS,
        hangoverMs: WAKE_HANGOVER_MS,
        pauseMs: WAKE_EARLY_MS,
      },
      // No prior by default, because nobody has promised that anyone spoke. A
      // decoder primed with her name is a decoder that writes her name when
      // guessing, and one did: "For a second, Kokoro" came out of a quiet room
      // with Kokoro sitting second in the vocabulary. See UNPROMPTED.
      //
      // The other side of that trade is a microphone whose real "Vela" never
      // survives base.en, which is what VELA_WAKE_VOCABULARY is for.
      hear: (pcm) => ears.hear(pcm, wakePrior(WAKE_VOCABULARY)),

      // The model heard her name, a third of a second after he said it and
      // before the sentence around it has closed. The chime has already
      // played, from the worker. What is left to do now rather than later is
      // be seen, and have both speech models paged back in before they are
      // needed: whisper in the half second before the utterance closes, Kokoro
      // in the seconds before a reply has anything to say.
      onWake: () => {
        greeting = nextGreeting();
        showHer();
        ears.prime();
        void mouth.render("Mm.").catch(() => null);
        // So that whatever she says next — the filler, the answer — starts
        // on a player that is already up.
        openAhead();
      },

      // A question addressed to her just ended; whisper is only now reading
      // it. The filler goes here rather than after the transcript, which puts
      // it 0.7s after he stops talking instead of 1.2s.
      onAsked: () => filler.expect(lastCut),

      onCommand: (text, woke) => {
        const how = woke.followUp ? "follow-up" : woke.word;
        listener.hold();
        answering = true;
        cutTurn = false;
        clock = { cut: lastCut, heard: Date.now() };
        // The turn's own end drains the player now, so the guess-timer that
        // would have closed an unused one is not needed.
        if (unused) clearTimeout(unused);
        unused = null;
        // Already expected at the close if the model fired in this one; a
        // nameless follow-up only now, once it is known not to be a goodbye.
        // Measured from the close either way, because that is when the
        // silence he is sitting in began.
        filler.expect(lastCut);
        showHer();
        // The hub plays what the core says. This reply is already going to be
        // said out loud in the room, so tell it to stay quiet for this one.
        server.announce({ type: "aloud", value: true });
        // She has no clock. Asked the time, she ran a PowerShell command for
        // it, which was three of the four seconds that turn took. Handed it
        // with the question, she just answers. Who said it rides along too.
        void voiceOf(woke.who).then((who) => {
          const heard = voices ? ` · ${describe(who)}` : "";
          console.log(`  \x1b[36myou ›\x1b[0m \x1b[90m(${how}${heard})\x1b[0m ${text}`);
          // A stranger who spoke to her is one she may now be asked to save.
          voices?.met(who);
          const tag = voiceTag(who);
          // He is going. Do what he asked, if anything, and do not ask him
          // something back he will not be there to answer.
          lastWord = woke.leaving;
          const going = woke.leaving ? " [He is wrapping up after this: a few words, nothing asked back.]" : "";
          core.send(`[It is ${timeNow()}.]${tag ? ` ${tag}` : ""}${going} ${text}`, { spoken: true });
        });
      },

      // He said her name and nothing else. Answering that with a model turn
      // would put a second and a half between the name and the reply.
      onDismiss: () => {
        console.log(`  \x1b[90m(session closed)\x1b[0m`);
        filler.reset();
        // The goodbye before the window is asked to go, so a hub that cannot
        // close itself is left showing it rather than the last reply.
        const bye = oneOf(WAKE_BYES, lastLine);
        tell(bye);
        hideHer();
        if (sayClip(bye)) return;
        listener.hold();
        if (speakingAloud) voice.say(bye);
        void Promise.resolve(speaker.drain?.())
          .catch(() => {})
          .then(() => listenAgain());
      },

      onName: (word, { paused }) => {
        console.log(`  \x1b[36myou ›\x1b[0m \x1b[90m(${word}${paused ? ", then quiet" : ""})\x1b[0m`);
        filler.reset();
        // Her name on its own is still her being addressed, and it is how he
        // opens a conversation. Without this she answers "yes" to a laptop
        // showing nothing, which is the exact thing showHer exists to prevent.
        showHer();
        const line = greeting || nextGreeting();
        greeting = "";
        // He stopped at her name and the room has stayed quiet: answer now,
        // from a file, in the gap he left for it. This is the one place a
        // spoken answer to her name is never late.
        if (paused && sayClip(line)) {
          console.log(`  \x1b[90m(${line})\x1b[0m`);
          tell(line);
          return;
        }
        // Known only once whisper has read it, a second and more after he
        // stopped. A spoken answer then would arrive on top of him starting to
        // talk — and she holds the microphone while she speaks, so it would cut
        // him off as well. The chime already answered; the line goes on screen.
        if (chiming) {
          tell(line);
          return;
        }
        listener.hold();
        tell(line);
        if (speakingAloud) voice.say(line);
        void Promise.resolve(speaker.drain?.())
          .catch(() => {})
          .then(() => listenAgain());
      },

      onCaptured: ({ ms, level }) => {
        lastCut = Date.now();
        if (WAKE_DEBUG) {
          console.log(`  \x1b[90m~ ${level.toFixed(0)}dB  ${ms}ms of room\x1b[0m`);
        }
      },

      onHeard: ({ text, woke, level }) => {
        if (WAKE_DEBUG) {
          console.log(`  \x1b[90m${woke ? "→" : "·"} ${level.toFixed(0)}dB  ${text || "(whisper heard nothing)"}\x1b[0m`);
        }
      },
      onLapsed: ({ text, lateMs, spent }) => {
        const why = spent
          ? `after ${WAKE_FOLLOWUPS} turns without her name`
          : `${secs(lateMs)} after the conversation ran out`;
        console.log(`  \x1b[90m(not taken, ${why}: ${text})\x1b[0m`);
      },
      onProblem: (why) => console.log(`  \x1b[33mWake word:\x1b[0m ${why}`),
    });

    await listener.ready;
    /**
     * Both speech models, loaded now rather than inside his first sentence.
     *
     * LAZY_WORKERS defers 1.1GB of Kokoro and 226MB of whisper until something
     * asks for them, and the hub can afford that because pressing record warms
     * them in the gap before he speaks. The wake word has no such gap: the
     * first thing he says *is* the trigger, so both loads land inside the turn
     * he is already waiting on and she looks broken rather than slow. Holding
     * the microphone open all day is the commitment; the memory saved by not
     * being able to answer is not worth having.
     */
    ears.warm();
    mouth.warm();
    // Every canned line, rendered now in the order they are likely to be
    // needed, so none of them waits on Kokoro when he is listening for it.
    //
    // With clips, the acknowledgements and goodbyes are files and only the
    // fillers need holding in memory: they go into the same player as the
    // reply, so that the two never overlap.
    void speaker.prime?.(
      [...new Set([...WAKE_FILLERS, ...(clips ? [] : [...WAKE_ACKS, ...WAKE_BYES])])].map((l) =>
        speakable(l, PRONOUNCE_PHONEMES),
      ),
    );
    // Rendered once, ever: a file that exists costs a stat. On a first start
    // this is about thirty lines of Kokoro, queued behind the fillers.
    if (clips) {
      void clips
        .prepare([...new Set([...ALL_GREETINGS, ...WAKE_ACKS, ...WAKE_BYES])])
        .then((n) => {
          if (n) console.log(`  \x1b[90m(recorded ${n} of her lines to ${CLIP_DIR})\x1b[0m`);
        })
        .catch((err: Error) => console.log(`  \x1b[33mClips:\x1b[0m couldn't record her lines (${err.message})`));
    }

    /**
     * From here the hub is the controls for this room, not a second one.
     *
     * Published only once the microphone is actually capturing, because the
     * hub draws its buttons from this: offering a mute for a microphone that
     * never opened is the broken control the smaller face exists to avoid.
     */
    /**
     * Tell every hub the state of the room's two switches.
     *
     * Her window loads at boot, seconds before the microphone is open, and
     * its one look at /health found no room. It then treated pressing her as
     * its own push-to-talk for the rest of the day: the turn went to the model
     * as typed, past the wake word, so "you can go now" was a sentence to
     * answer rather than a goodbye. Announced when the room appears, a hub
     * that was early learns it; announced on every change, two hubs agree.
     */
    const announceRoom = () =>
      server.announce({ type: "room", hearing, speaking: speakingAloud });

    room = {
      listen: () => {
        // Pressing her is asking to be heard, so a muted microphone comes
        // back on for it rather than leaving the press to do nothing.
        if (!hearing) room?.setHearing(true);
        listener.open();
        console.log(`  \x1b[90m(he pressed her; listening without her name)\x1b[0m`);
      },
      hearing: () => hearing,
      setHearing: (on) => {
        if (on === hearing) return;
        hearing = on;
        announceRoom();
        // Never un-mute into the middle of her own sentence: she is holding
        // the microphone so as not to transcribe herself, and finish() will
        // call listenAgain when she stops.
        if (!on) listener.hold();
        else if (!answering) listener.resume();
        console.log(`  [90m(${on ? "listening" : "muted"})[0m`);
      },
      speaking: () => speakingAloud,
      setSpeaking: (on) => {
        if (on === speakingAloud) return;
        speakingAloud = on;
        announceRoom();
        // Drop what has not been spoken yet. flush() would do the opposite —
        // it means "end of turn, say the rest" — and muting her by saying the
        // remainder out loud is the joke version of this feature. The sentence
        // already handed to the player still finishes; stopping that needs
        // speaker.stop(), which is teardown and does not come back.
        if (!on) voice.stop();
        console.log(`  [90m(${on ? "out loud" : "silent"})[0m`);
      },
      cut: () => {
        // Three things, and all three are needed. The flag stops the rest of
        // the reply being spoken as it streams in, voice.stop() drops the
        // half-sentence already buffered, and speaker.cut() ends the one
        // actually sounding — which is the only one he can hear, and so the
        // only one that makes this feel like interrupting a person.
        cutTurn = true;
        voice.stop();
        speaker.cut?.();
      },
    };
    announceRoom();

    console.log(
      detector
        ? WAKE_ENGINE === "spotter"
          ? `  Wake word on (${device}), listening for "${WAKE_PHRASES[0]}"${chiming ? " with a chime" : ""}.`
          : `  Wake word on (${device}), model ${WAKE_MODEL}.`
        // What it prints has to be what actually wakes her. A banner naming a
        // word the matcher will not accept is how an afternoon goes missing.
        : `  Wake word on (${device}). Say "${
            WAKE_LEAD_REQUIRED ? `Hey ${NAME}` : NAME
          }".`,
    );
    if (voices) {
      const names = voices.names();
      console.log(`  Voices on: ${names.length ? `she knows ${names.join(", ")}` : "she knows nobody by voice yet"}.`);
    }
    stopListening = () => {
      known?.stop();
      detector?.stop();
      listener.stop();
      tape?.end();
      clips?.close();
      voice.stop();
      speaker.stop();
    };
    return listener;
  }

  const hub = hubUrl(server.endpoint);
  console.log(
    `\n  ${NAME} ${BUILD} listening on 127.0.0.1:${server.endpoint.port} (pid ${process.pid}).` +
      `\n  Hub:    ${hub}` +
      `\n  Attach: npm run dev` +
      `\n  Ctrl+C to stop.\n`,
  );
  if (OPEN_HUB) showWindow(hub);

  // Everything within half an hour's walk of his door, fetched now so that
  // "where can I eat" is answered from memory in milliseconds. In the
  // background: a slow or absent OpenStreetMap must not hold her up.
  places()
    .warm()
    .catch((err: Error) => console.log(`  \x1b[33mPlaces:\x1b[0m couldn't prefetch (${err.message}); searches will fetch live.`));

  // After the banner: opening the microphone takes about 1.3s, and the address
  // is the thing worth reading first.
  if (WAKE_ON) await startListening();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("\n  Shutting down.");
    await server.close();
    stopListening();
    desk?.stop();
    core.stop();
    ears.stop();
    mouth?.stop();
    close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  close();
  process.exit(1);
});
