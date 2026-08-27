import { buildContextBlock, close } from "./memory.js";
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
} from "./listen.js";
import { kokoroSynth, synthSpeaker, createVoice, PRONOUNCE_PHONEMES } from "./voice.js";
import { startWakeListener, type WakeListener } from "./wake.js";
import { openDetector } from "./detect.js";
import { existsSync } from "node:fs";
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
  oneOf,
  WAKE_DEBUG,
  WAKE_MARGIN_DB,
  WAKE_MAX_MS,
  WAKE_PREROLL_MS,
  WAKE_FLOOR_MAX,
  WAKE_VOCABULARY,
  WAKE_FOLLOWUP_MS,
  WAKE_FOLLOWUPS,
  WAKE_BYES,
  WAKE_DETECT,
  WAKE_MODEL,
  WAKE_PYTHON,
  WAKE_WORKER,
  WAKE_SCORE,
  WAKE_VAD,
  WAKE_DETECT_MS,
} from "./config.js";

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
    thinking: THINKING_ON,
    effort: EFFORT,
    skills: SKILLS,
    heartbeatSkills: HEARTBEAT_SKILLS,
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

    /**
     * The wake word model, if she has one.
     *
     * Null falls back to the old path — her name looked for in whatever
     * whisper wrote down — which still works and is still tested, and is what
     * runs on a machine where openwakeword was never installed.
     */
    const detector =
      WAKE_DETECT && existsSync(WAKE_PYTHON)
        ? openDetector({
            python: WAKE_PYTHON,
            worker: WAKE_WORKER,
            model: WAKE_MODEL,
            threshold: WAKE_SCORE,
            vad: WAKE_VAD,
            onWake: (score) =>
              WAKE_DEBUG && console.log(`  [90m^ ${score.toFixed(3)} wake[0m`),
            onProblem: (why) => console.log(`  [33mWake model:[0m ${why}`),
          })
        : null;
    // Loading onnxruntime and the model costs about a second. Doing it here
    // rather than inside his first sentence is the same trade the speech
    // models already make above.
    if (detector) await detector.ready;

    const speaker = synthSpeaker({
      render: (text) => mouth.render(text),
      play: resolveFfplay() ?? "ffplay",
      gapMs: VOICE_GAP_MS,
      onProblem: (why) => console.log(`  Voice: ${why}`),
      // A turn that renders nothing reports nothing, which is what silence
      // looked like from the outside. This says a sentence reached the player.
      onSpoke: (text, ms) => {
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
    const finish = async () => {
      if (!answering) return;
      answering = false;
      server.announce({ type: "aloud", value: false });
      voice.flush();
      await speaker.drain?.().catch(() => {});
      listenAgain();
    };

    core.subscribe((event) => {
      if (!answering) return;
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
    let lastLine = "";
    const sayLine = (lines: string[]) => {
      const line = oneOf(lines, lastLine);
      lastLine = line;
      lastSaid = { text: line, at: Date.now() };
      server.announce({ type: "say", text: line });
      if (speakingAloud) voice.say(line);
    };

    const listener = startWakeListener({
      device,
      detector,
      detectMs: WAKE_DETECT_MS,
      ffmpeg,
      words: WAKE_WORDS,
      requireLead: WAKE_LEAD_REQUIRED,
      followUpMs: WAKE_FOLLOWUP_MS,
      followUps: WAKE_FOLLOWUPS,
      segment: {
        marginDb: WAKE_MARGIN_DB,
        maxMs: WAKE_MAX_MS,
        floorMax: WAKE_FLOOR_MAX,
        preRollMs: WAKE_PREROLL_MS,
      },
      // No prior by default, because nobody has promised that anyone spoke. A
      // decoder primed with her name is a decoder that writes her name when
      // guessing, and one did: "For a second, Kokoro" came out of a quiet room
      // with Kokoro sitting second in the vocabulary. See UNPROMPTED.
      //
      // The other side of that trade is a microphone whose real "Vela" never
      // survives base.en, which is what VELA_WAKE_VOCABULARY is for.
      hear: (pcm) => ears.hear(pcm, wakePrior(WAKE_VOCABULARY)),

      onCommand: (text, woke) => {
        const how = woke.followUp ? "follow-up" : woke.word;
        console.log(`  \x1b[36myou ›\x1b[0m \x1b[90m(${how})\x1b[0m ${text}`);
        listener.hold();
        answering = true;
        cutTurn = false;
        showHer();
        // The hub plays what the core says. This reply is already going to be
        // said out loud in the room, so tell it to stay quiet for this one.
        server.announce({ type: "aloud", value: true });
        core.send(text);
      },

      // He said her name and nothing else. Answering that with a model turn
      // would put a second and a half between the name and the reply.
      onDismiss: () => {
        console.log(`  \x1b[90m(session closed)\x1b[0m`);
        listener.hold();
        // The goodbye before the window is asked to go, so a hub that cannot
        // close itself is left showing it rather than the last reply.
        sayLine(WAKE_BYES);
        hideHer();
        void Promise.resolve(speaker.drain?.())
          .catch(() => {})
          .then(() => listenAgain());
      },

      onName: (word) => {
        console.log(`  \x1b[36myou ›\x1b[0m \x1b[90m(${word})\x1b[0m`);
        listener.hold();
        // Her name on its own is still her being addressed, and it is how he
        // opens a conversation. Without this she answers "yes" to a laptop
        // showing nothing, which is the exact thing showHer exists to prevent.
        showHer();
        sayLine(WAKE_ACKS);
        void Promise.resolve(speaker.drain?.())
          .catch(() => {})
          .then(() => listenAgain());
      },

      onCaptured: ({ ms, level }) => {
        if (WAKE_DEBUG) {
          console.log(`  \x1b[90m~ ${level.toFixed(0)}dB  ${ms}ms of room\x1b[0m`);
        }
      },

      onHeard: ({ text, woke, level }) => {
        if (WAKE_DEBUG) {
          console.log(`  \x1b[90m${woke ? "→" : "·"} ${level.toFixed(0)}dB  ${text || "(whisper heard nothing)"}\x1b[0m`);
        }
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

    /**
     * From here the hub is the controls for this room, not a second one.
     *
     * Published only once the microphone is actually capturing, because the
     * hub draws its buttons from this: offering a mute for a microphone that
     * never opened is the broken control the smaller face exists to avoid.
     */
    room = {
      hearing: () => hearing,
      setHearing: (on) => {
        if (on === hearing) return;
        hearing = on;
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

    console.log(
      detector
        ? `  Wake word on (${device}), model ${WAKE_MODEL}.`
        // What it prints has to be what actually wakes her. A banner naming a
        // word the matcher will not accept is how an afternoon goes missing.
        : `  Wake word on (${device}). Say "${
            WAKE_LEAD_REQUIRED ? `Hey ${NAME}` : NAME
          }".`,
    );
    stopListening = () => {
      detector?.stop();
      listener.stop();
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
  if (OPEN_HUB) openInBrowser(hub);

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
