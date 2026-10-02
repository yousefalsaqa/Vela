import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  matchWake,
  isDismissal,
  createSegmenter,
  startWakeListener,
  afterAddress,
  WAKE_WORDS,
  LAPSED_WITHIN_MS,
  endsInGoodbye,
  type TurnNote,
} from "../src/wake.js";
import { SAMPLE_RATE, levelDb } from "../src/listen.js";
import { fakeSpawner, settle } from "./helpers/proc.js";

/**
 * Loop on a condition rather than sleeping, so a slow machine can't flake.
 *
 * Yields through a timer rather than the usual setImmediate, because the
 * reopen-after-a-dead-microphone path is itself a timer: a loop of immediates
 * can run two hundred times inside the same millisecond and never let one
 * fire, which passes or fails depending on how fast the machine is.
 */
async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.fail(`timed out waiting for ${what}`);
}

/**
 * `ms` of sound whose RMS is exactly `db` dBFS.
 *
 * Alternating full-amplitude samples, so the level is the amplitude and the
 * tests can name a loudness instead of hoping one falls out of a waveform.
 */
function tone(ms: number, db: number, rate = SAMPLE_RATE): Buffer {
  const samples = Math.round((rate * ms) / 1000);
  const pcm = Buffer.alloc(samples * 2);
  const amplitude = Math.round(32768 * 10 ** (db / 20));
  for (let i = 0; i < samples; i++) {
    pcm.writeInt16LE(i % 2 ? amplitude : -amplitude, i * 2);
  }
  return pcm;
}

/** Room tone, and a voice over it. Roughly what his microphone measures. */
const room = (ms: number) => tone(ms, -70);
const voice = (ms: number) => tone(ms, -45);

describe("matchWake", () => {
  test("her name at the front is an address, and what follows is the ask", () => {
    assert.deepEqual(matchWake("Vela, what time is it"), {
      heard: true,
      rest: "what time is it",
      word: "vela",
    });
  });

  test("her name on its own is a call, not a question", () => {
    assert.deepEqual(matchWake("Vela?"), { heard: true, rest: "", word: "vela" });
  });

  test("a filler in front doesn't push the name out of the front position", () => {
    for (const said of ["Hey Vela, open the hub", "okay Vela, open the hub", "um, uh, Vela open the hub"]) {
      assert.equal(matchWake(said).heard, true, `"${said}" is her being addressed`);
    }
  });

  test("her name at the very end addresses her too", () => {
    assert.deepEqual(matchWake("what time is it, Vela"), {
      heard: true,
      rest: "what time is it",
      word: "vela",
    });
  });

  test("her name in the middle is him talking about her, not to her", () => {
    assert.equal(
      matchWake("I told Sam that Vela handles the calendar now").heard,
      false,
      "answering a sentence she was only mentioned in is worse than missing one",
    );
  });

  test("nothing that sounds like her name is not for her", () => {
    assert.equal(matchWake("what time is it").heard, false);
  });

  test("punctuation and case are not part of the name", () => {
    for (const said of ["VELA!", "vela.", "Vela,", "Vela's there"]) {
      assert.equal(matchWake(said).heard, true, `"${said}" is still her name`);
    }
  });

  test("what whisper actually writes down counts as her name", () => {
    // base.en has never heard "Vela" and lands on a different vowel each time.
    for (const misheard of ["Vella, what's the weather", "Veyla, what's the weather"]) {
      assert.equal(matchWake(misheard).heard, true, `"${misheard}" is a real mishearing`);
    }
  });

  test("a mishearing that is also an ordinary word is not her name", () => {
    // These were on the list, and one of them woke her during a phone call.
    // Whisper really does write them down, so this is a deliberate deafness:
    // a name he might say to someone else costs more than it is worth.
    for (const said of ["Bella, what's the weather", "Villa, what's the weather"]) {
      assert.equal(matchWake(said).heard, false, `"${said}" is a word he might say to a person`);
    }
  });

  test("a custom list can put a risky mishearing back", () => {
    assert.equal(
      matchWake("Bella, what's the weather", ["vela", "bella"]).heard,
      true,
      "the defaults are a starting point, not a ceiling",
    );
  });

  test("the ask keeps its own casing and punctuation, because the model reads it", () => {
    assert.equal(
      matchWake("Vela, open Yousef's PR on GitHub").rest,
      "open Yousef's PR on GitHub",
    );
  });

  test("a custom list replaces the defaults rather than adding to them", () => {
    assert.equal(matchWake("Jarvis, lights", ["jarvis"]).heard, true);
    assert.equal(
      matchWake("Vela, lights", ["jarvis"]).heard,
      false,
      "VELA_WAKE_WORDS has to be able to turn a mishearing off, not only add one",
    );
  });

  test("an empty transcript is not an address", () => {
    assert.equal(matchWake("").heard, false);
    assert.equal(matchWake("   ").heard, false);
  });

  test("the shipped list is lowercase, because that is what it is matched as", () => {
    assert.deepEqual(WAKE_WORDS, WAKE_WORDS.map((w) => w.toLowerCase()));
  });
});

/**
 * The name on its own is the whole false-positive surface: base.en writes
 * "Vela" out of room tone, and every one of those becomes a turn. Requiring a
 * word in front of it costs him nothing he was not already saying and takes
 * the hallucinated single word off the table.
 */
describe("matchWake requiring a lead-in", () => {
  test("an addressed name still gets through, with the address off the front", () => {
    assert.deepEqual(matchWake("Hey Vela, what time is it", WAKE_WORDS, true), {
      heard: true,
      rest: "what time is it",
      word: "vela",
    });
  });

  test("every lead-in counts, not just hey", () => {
    for (const said of ["okay Vela, lights", "hi Vela, lights", "yo Vela, lights"]) {
      assert.equal(
        matchWake(said, WAKE_WORDS, true).heard,
        true,
        `"${said}" is him addressing her`,
      );
    }
  });

  test("the bare name is no longer an address", () => {
    assert.equal(
      matchWake("Vela, what time is it", WAKE_WORDS, true).heard,
      false,
      "the name alone is what whisper invents out of silence",
    );
  });

  test("the name trailing a sentence is no longer an address either", () => {
    assert.equal(
      matchWake("what time is it, Vela", WAKE_WORDS, true).heard,
      false,
      "a name appended to a sentence is the other way a mishearing lands",
    );
  });

  test("a lead-in with no name is still nothing", () => {
    assert.equal(matchWake("hey, what time is it", WAKE_WORDS, true).heard, false);
  });

  test("off by default, so this changes nothing he did not ask for", () => {
    assert.equal(matchWake("Vela, what time is it").heard, true);
    assert.equal(matchWake("what time is it, Vela").heard, true);
  });

  test("afterAddress strips the lead-in along with the name", () => {
    assert.equal(
      afterAddress("Hey Vela, open the PR", WAKE_WORDS, true),
      "open the PR",
    );
  });
});

describe("endsInGoodbye", () => {
  test("a goodbye after something else he said is still him leaving", () => {
    // His two: nine and eight words, past the short-utterance limit, and both
    // answered "Okay" while she stayed.
    assert.equal(endsInGoodbye("Ah, don't worry about that, you can go now."), true);
    assert.equal(endsInGoodbye("Thank you for that, you can go now"), true);
    assert.equal(endsInGoodbye("Add milk to the shopping list, that's all."), true);
  });

  test("manners at the end of a request are not leaving, or the request is the last thing she hears", () => {
    assert.equal(endsInGoodbye("Set a timer for ten minutes, thanks."), false);
    assert.equal(endsInGoodbye("Can you open Netflix, thank you"), false);
  });

  test("'you can go on' in a sentence is him asking her to carry on, not to go", () => {
    assert.equal(endsInGoodbye("I'm listening, you can go on"), false);
  });

  test("a one-word goodbye has to start its own clause", () => {
    assert.equal(endsInGoodbye("Okay, that's great. Bye."), true);
    assert.equal(endsInGoodbye("how do I say goodbye"), false, "a question about the word is not the word");
  });

  test("her name after the goodbye does not hide it", () => {
    assert.equal(endsInGoodbye("Don't worry about it, you can go now, Vela."), true);
  });
});

describe("isDismissal", () => {
  test("the phrase he actually uses to let her go", () => {
    // "go on" is what whisper wrote down for it, both times it was tried. The
    // list has to carry the transcript, not the sentence.
    for (const said of [
      "you can go now",
      "okay you can go now",
      "Okay, you can go on",
      "Even gone on.",
    ]) {
      assert.equal(isDismissal(said), true, `"${said}" is him finishing`);
    }
  });

  /**
   * In a follow-up she is handed the sentence whole, name and all, so the name
   * has to come off before the phrase is matched or the dismissal never lands.
   */
  test("her name on either end is not part of the phrase", () => {
    for (const said of [
      "you can go now, Vela",
      "Vela, you can go now",
      "thanks Vela",
      "Vela that's all",
    ]) {
      assert.equal(isDismissal(said), true, `"${said}" is still him finishing`);
    }
  });

  /**
   * The phrase is matched on the end of what he said, so a sentence that ends
   * in it would close the session. "now" is what keeps the bare "you can go"
   * out of the list: "tell me when you can go" is a question, not a goodbye.
   */
  test("a sentence that merely contains the words is not a dismissal", () => {
    for (const said of [
      "can you go to the kitchen and check",
      "tell me when you can go",
      "you can go through the list",
      // "go on" is him telling her to continue, and "gone on" ends a question.
      "go on",
      "what's gone on",
    ]) {
      assert.equal(isDismissal(said), false, `"${said}" is not him finishing`);
    }
  });

  test("the ways he actually ends a conversation", () => {
    for (const said of [
      "thanks",
      "okay thank you",
      "thank you, we're done",
      "alright that's all",
      "never mind",
      "bye",
      "okay we are done",
    ]) {
      assert.equal(isDismissal(said), true, `"${said}" is him letting her go`);
    }
  });

  test("a request that merely ends in one of those words is not a goodbye", () => {
    for (const said of [
      "tell me when the timer is done",
      "put the kettle on and stop the music after",
      "what did he say thank you for",
    ]) {
      assert.equal(
        isDismissal(said),
        false,
        `"${said}" is an instruction, and dropping it costs him the turn`,
      );
    }
  });

  test("a long sentence is never a goodbye, however it ends", () => {
    assert.equal(
      isDismissal("okay so the thing I actually wanted to ask you about was that we are done"),
      false,
      "the length cap is what keeps a real sentence from closing the session",
    );
  });
});

describe("createSegmenter", () => {
  /** Collect what the gate decides was said. */
  const listening = (opts = {}) => {
    const said: Buffer[] = [];
    const seg = createSegmenter((pcm) => said.push(pcm), opts);
    return { seg, said };
  };

  test("a quiet room is never an utterance, so an idle day never reaches whisper", () => {
    const { seg, said } = listening();
    seg.push(room(5_000));
    assert.equal(said.length, 0, "silence that costs a transcription costs it all day");
  });

  test("digital silence is not mistaken for a very quiet room", () => {
    const { seg, said } = listening();
    // A muted or dead device reads as -Infinity, which must not drag the bar
    // below everything and turn nothing into speech.
    seg.push(Buffer.alloc(SAMPLE_RATE * 2 * 3));
    assert.equal(said.length, 0);
  });

  test("speech over the room is one utterance", () => {
    const { seg, said } = listening();
    seg.push(room(1_000));
    seg.push(voice(800));
    seg.push(room(1_500));
    assert.equal(said.length, 1);
  });

  test("finish closes the open utterance now, without waiting out the hangover", () => {
    const { seg, said } = listening();
    seg.push(room(1_000));
    seg.push(voice(800));
    seg.push(room(200));
    assert.equal(said.length, 0, "still inside the 700ms hangover");
    assert.equal(seg.finish(seg.opened(), seg.heard()), true);
    assert.equal(said.length, 1);
  });

  test("finish refuses once he has spoken again since the guess, so a guess can't cut him off", () => {
    const { seg, said } = listening();
    seg.push(room(1_000));
    seg.push(voice(800));
    seg.push(room(200));
    const guessedAt = seg.heard();
    seg.push(voice(300));
    assert.equal(seg.finish(seg.opened(), guessedAt), false);
    assert.equal(said.length, 0);
  });

  test("finish refuses a guess about an utterance that is already over", () => {
    const { seg, said } = listening();
    seg.push(room(1_000));
    seg.push(voice(800));
    seg.push(room(200));
    const stale = seg.opened();
    const at = seg.heard();
    seg.push(room(1_500));
    seg.push(voice(800));
    seg.push(room(200));
    assert.equal(seg.finish(stale, at), false, "the next sentence is not the one guessed about");
    assert.equal(said.length, 1);
  });

  test("a gap between words does not end the sentence", () => {
    const { seg, said } = listening();
    seg.push(room(1_000));
    seg.push(voice(400));
    seg.push(room(300)); // shorter than the 700ms hangover
    seg.push(voice(400));
    seg.push(room(1_500));
    assert.equal(said.length, 1, "cutting on every breath would send half-sentences");
  });

  test("the pause afterwards does end it", () => {
    const { seg, said } = listening();
    seg.push(room(1_000));
    seg.push(voice(400));
    seg.push(room(1_500)); // longer than the hangover
    seg.push(voice(400));
    seg.push(room(1_500));
    assert.equal(said.length, 2);
  });

  test("the utterance carries the moment before it, so the first syllable survives", () => {
    const { seg, said } = listening();
    seg.push(room(2_000));
    seg.push(voice(500));
    seg.push(room(1_500));
    // The wake word is the first thing said, so a gate that starts recording
    // when it is already sure would clip the name off every time.
    const bytes = (ms: number) => Math.round((SAMPLE_RATE * ms) / 1000) * 2;
    assert.ok(
      said[0].length > bytes(500),
      "an utterance no longer than the speech in it means the opening was clipped",
    );
  });

  test("a single click is not a sentence", () => {
    const { seg, said } = listening();
    seg.push(room(1_000));
    seg.push(voice(100)); // one frame
    seg.push(room(1_500));
    assert.equal(said.length, 0, "a keystroke costing a whisper pass is the whole day's cost");
  });

  test("one long noise is cut rather than left holding the gate open", () => {
    const { seg, said } = listening({ maxMs: 1_000 });
    seg.push(room(500));
    seg.push(voice(4_000));
    assert.ok(said.length >= 3, "a vacuum cleaner must not become one 4-second utterance");
  });

  test("the bar follows the room, so a quiet voice in a quiet room still opens it", () => {
    const { seg, said } = listening();
    seg.push(tone(2_000, -78)); // a very quiet room
    seg.push(tone(600, -62)); // and a voice only 16dB over it
    seg.push(tone(1_500, -78));
    assert.equal(said.length, 1, "a fixed threshold would never hear this at all");
  });

  test("a louder microphone can move the ceiling with it", async () => {
    // The default ceiling was measured against a microphone putting speech at
    // -49 dBFS. Turn the gain up and the room climbs past it, the bar stops
    // rising, and room tone starts clearing a threshold it should not. The
    // ceiling has to be able to follow the microphone.
    const said: number[] = [];
    const gate = createSegmenter((_pcm, level) => said.push(level), {
      frameMs: 10,
      minMs: 20,
      hangoverMs: 30,
      marginDb: 8,
      floorMax: -30,
    });
    // A room at -40 with the ceiling raised: the bar sits at -32, and speech
    // this loud is under it.
    for (let i = 0; i < 60; i++) gate.push(tone(10, -40));
    gate.push(tone(200, -36));
    for (let i = 0; i < 10; i++) gate.push(tone(10, -40));
    assert.equal(said.length, 0, "a ceiling that cannot rise is a room she transcribes all day");
  });

  test("a loud room cannot raise the bar above where speech lives", () => {
    const { seg } = listening();
    seg.push(tone(60_000, -20)); // a minute of something very loud
    assert.ok(
      seg.floor() <= -55,
      `the floor climbed to ${seg.floor().toFixed(0)}dB; above -55 the bar sits over his voice and she goes deaf`,
    );
  });

  test("the floor stops learning while he is talking", () => {
    const { seg, said } = listening();
    seg.push(room(1_000));
    const before = seg.floor();
    seg.push(voice(6_000)); // a long sentence
    seg.push(room(1_500));
    assert.ok(
      Math.abs(seg.floor() - before) < 1,
      "a floor that learns from his voice would close the gate mid-sentence",
    );
    assert.equal(said.length, 1);
  });

  test("audio that doesn't land on a frame boundary is kept, not dropped", () => {
    const { seg, said } = listening();
    // ffmpeg hands over whatever the pipe had, which is never a round number.
    const stream = Buffer.concat([room(1_000), voice(800), room(1_500)]);
    for (let at = 0; at < stream.length; at += 1_234) {
      seg.push(stream.subarray(at, Math.min(at + 1_234, stream.length)));
    }
    assert.equal(said.length, 1, "dropping the remainder of every chunk drops most of the audio");
  });

  test("reset throws away what is in flight without saying it was said", () => {
    const { seg, said } = listening();
    seg.push(room(1_000));
    seg.push(voice(400));
    seg.reset();
    seg.push(room(1_500));
    assert.equal(said.length, 0, "the half-sentence she interrupted is not a turn");
  });

  test("the level it reports is the loudest the utterance got", () => {
    const said: number[] = [];
    const seg = createSegmenter((_pcm, level) => said.push(level));
    seg.push(room(1_000));
    seg.push(voice(800));
    seg.push(room(1_500));
    // What VELA_WAKE_MARGIN is tuned against, so it has to describe his voice
    // rather than the silence either side of it.
    assert.ok(Math.abs(said[0] - levelDb(voice(100))) < 1);
  });

  test("knows when it last heard speech, without waiting for the sentence to close", () => {
    // The early answer to her name asks "has he stopped?" a third of a second
    // after it, long before the gate's own second of hangover would say.
    const seg = createSegmenter(() => {});
    assert.equal(seg.lastLoud(), -Infinity);
    seg.push(room(1_000));
    seg.push(voice(300));
    assert.equal(seg.lastLoud(), 1_300, "the end of the last frame over the bar");
    seg.push(room(200));
    assert.equal(seg.lastLoud(), 1_300, "quiet after it does not move it");
    assert.equal(seg.speaking(), true, "and the sentence is still open while it says so");
  });
});

describe("createSegmenter, on a microphone with its own hiss", () => {
  test("a floor that started below the room learns it from one cut, not minutes of them", () => {
    // His raw microphone hisses at -53 dBFS. A capture that opens on a moment
    // of digital silence puts the floor at the bottom, every frame after it
    // clears the bar, and the floor never gets a quiet moment to learn in. On
    // his tape that was four minutes of fifteen-second "sentences" of hiss.
    const cuts: number[] = [];
    const seg = createSegmenter((pcm) => cuts.push(pcm.length / 2 / SAMPLE_RATE), {
      frameMs: 10,
      preRollMs: 20,
      minMs: 20,
      hangoverMs: 30,
      maxMs: 1_000,
      floorMax: -45,
      marginDb: 10,
    });
    seg.push(Buffer.alloc(320)); // one frame of digital silence as it opens
    seg.push(tone(10_000, -53));
    assert.equal(cuts.length, 1, "one cut of room is the evidence; the rest is the floor learning from it");
    seg.push(Buffer.concat([tone(300, -33), tone(300, -53)]));
    assert.equal(cuts.length, 2, "and his voice over it still opens the gate");
  });
});

describe("afterAddress", () => {
  const words = ["vela", "vella"];

  test("cuts at the name when whisper managed to write it", () => {
    assert.equal(afterAddress("Vela, open the door.", words), "open the door.");
  });

  test("cuts at 'hey something' when it did not, which is the normal case", () => {
    // The model heard "hey jarvis". Whisper, which has never seen the word,
    // wrote down something else for it. Handing her own trigger back as the
    // question is worse than guessing at the shape of one.
    assert.equal(afterAddress("Hey Jarvis, what's the weather?", words), "what's the weather?");
    assert.equal(afterAddress("Hey Darvis - open the door.", words), "open the door.");
  });

  test("leaves a sentence with no address on the front alone", () => {
    assert.equal(afterAddress("open the door.", words), "open the door.");
  });

  test("a bare 'hey something' is the address itself, with nothing said after it", () => {
    // This is only ever reached once the model has fired, so "hey <word>" at
    // the front is the phrase it fired on rather than a greeting. Empty is the
    // right answer and is load-bearing: it is what tells the listener he said
    // her name and nothing else, which she answers with "Yes?" rather than a
    // model turn.
    assert.equal(afterAddress("Hey there.", words), "");
  });

  test("the same address with nothing after it and no full stop is still only the address", () => {
    // Whisper wrote a bare "Hey Vela" as "Hey fellow", no punctuation, and the
    // rule needed a separator after the word — so it cut nothing, and she was
    // asked "Hey fellow" as a question.
    assert.equal(afterAddress("Hey fellow", words), "");
    assert.equal(afterAddress("Hey fellow what time is it", words), "what time is it");
  });
});

describe("startWakeListener", () => {
  /**
   * A listener with a scripted whisper and a microphone that never opens.
   * `say` plays audio loud enough to open the gate and hands back `text`.
   */
  function listener(opts: {
    transcripts?: string[];
    followUpMs?: number;
    followUps?: number;
    now?: () => number;
    /** Give her a wake word model — a stand-in for src/detect.ts. `fire` is it hearing her. */
    detector?: boolean;
    /** Runs inside whisper's read, so a test can let the clock move while it reads. */
    reading?: () => void;
    /** Read early on a pause this long. See WAKE_EARLY_MS. Off unless given. */
    pauseMs?: number;
    /** Guess at each pause whether he has finished. See src/turn.ts. */
    turn?: { judge: (pcm: Buffer) => Promise<number | null>; act?: boolean };
  } = {}) {
    const fake = fakeSpawner();
    const commands: string[] = [];
    const lapses: { text: string; lateMs: number; spent: boolean }[] = [];
    /** Turns that ended with him leaving. */
    const leaving: string[] = [];
    const names: number[] = [];
    const byes: number[] = [];
    const woken: number[] = [];
    /** What she was told, in the order she was told it. */
    const order: string[] = [];
    /** Whisper being asked to read, and the gate closing, in the order they happened. */
    const timeline: string[] = [];
    const heard: Buffer[] = [];
    const notes: TurnNote[] = [];
    const queue = [...(opts.transcripts ?? [])];
    let fired: ((score: number) => void) | null = null;

    const wake = startWakeListener({
      device: "Microphone Array",
      spawn: fake.spawn,
      reopenMs: [0],
      followUpMs: opts.followUpMs,
      ...(opts.followUps === undefined ? {} : { followUps: opts.followUps }),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.turn
        ? { turn: { judge: opts.turn.judge, threshold: 0.5, act: opts.turn.act ?? false, onNote: (n: TurnNote) => notes.push(n) } }
        : {}),
      ...(opts.detector
        ? {
            detector: {
              push: () => {},
              onFire: (fn: (score: number) => void) => {
                fired = fn;
              },
              firedSince: () => false,
              lastScore: () => 1,
              ready: Promise.resolve(true),
              stop: () => {},
            },
          }
        : {}),
      segment: {
        frameMs: 10,
        preRollMs: 20,
        minMs: 20,
        hangoverMs: 30,
        maxMs: 5_000,
        ...(opts.pauseMs ? { pauseMs: opts.pauseMs } : {}),
      },
      onCaptured: () => timeline.push("cut"),
      hear: async (pcm) => {
        heard.push(pcm);
        timeline.push("read");
        opts.reading?.();
        return queue.shift() ?? "";
      },
      onCommand: (text, woke) => {
        commands.push(text);
        order.push("command");
        if (woke.leaving) leaving.push(text);
      },
      onLapsed: (lapsed) => lapses.push(lapsed),
      onName: () => {
        names.push(1);
        order.push("name");
      },
      onDismiss: () => byes.push(1),
      onWake: () => woken.push(1),
      onAsked: () => order.push("asked"),
    });

    /** Push audio down the microphone's pipe, as ffmpeg would. */
    const play = async (pcm: Buffer) => {
      fake.last().proc.stdout.write(pcm);
      await settle();
    };
    /** A sentence: quiet, speech, quiet. The gate needs all three. */
    const utterance = async () => {
      await play(Buffer.concat([room(200), voice(200), room(200)]));
    };
    /** The model hears her name. */
    const fire = () => fired?.(1);
    /**
     * A sentence the model hears her name in: it fires part-way through, the
     * way the real one does, a third of a second after "Vela" and before the
     * gate has closed.
     */
    const addressed = async () => {
      await play(Buffer.concat([room(200), voice(100)]));
      fire();
      await play(Buffer.concat([voice(100), room(200)]));
    };

    return { wake, fake, commands, lapses, leaving, names, byes, woken, order, timeline, heard, notes, play, utterance, fire, addressed };
  }

  test("a question said to her is acknowledged as it ends, before whisper has read it", async () => {
    // His idea: answer with something ready-made while the real answer is
    // made. Waiting for the transcript put that half a second later than it
    // needed to be; the model firing with speech after the name already says
    // it is a question.
    const { wake, order, addressed } = listener({
      transcripts: ["Hey Vela, what time is it"],
      detector: true,
    });
    await addressed();
    await until(() => order.includes("command"), "the question");
    assert.deepEqual(order, ["asked", "command"]);
    wake.stop();
  });

  test("her name on its own is not taken for a question, so there is nothing to fill", async () => {
    const { wake, order, play, fire } = listener({ transcripts: ["Hey Vela."], detector: true });
    await play(Buffer.concat([room(200), voice(200), room(10)]));
    fire();
    await play(room(200));
    await until(() => order.includes("name"), "her name");
    assert.deepEqual(order, ["name"], "a filler here would be her answering a question nobody asked");
    wake.stop();
  });

  test("with a model, what whisper wrote down has no say in whether she was addressed", async () => {
    // The whole reason for the model. base.en has never seen her name, so a
    // real address came back as "Hello, are you there?" and the old path threw
    // it away for not containing a name it was never going to be able to
    // spell. The model heard the phrase; the transcript only has to carry the
    // question.
    const { wake, commands, addressed } = listener({
      transcripts: ["Hello, are you there?"],
      detector: true,
    });
    await addressed();
    await until(() => commands.length === 1, "the command to be taken");
    assert.deepEqual(commands, ["Hello, are you there?"]);
    wake.stop();
  });

  test("and her name in a transcript is not an address if the model never fired", async () => {
    // The other half, and the one that stops a room talking to itself. Whisper
    // wrote her name into other people's sentences — "stick with us, Vela" —
    // and each of those was a session nobody opened.
    const { wake, commands, utterance } = listener({
      transcripts: ["Vela, open the door."],
      detector: true,
    });
    await utterance();
    await settle();
    assert.deepEqual(commands, [], "only the model decides she was spoken to");
    wake.stop();
  });

  test("a detection with nothing after it is only her name, whatever whisper spelled", async () => {
    // "Hey Vela" alone came back as "Hey fellow" and as "Hello.", and went to
    // the model as a question. No rule about the words can fix "Hello." — it
    // is an ordinary word — so what decides it is where the detection landed:
    // the model fires after "Vela" ends, and when the utterance closes less
    // than the gate's own wait after that, there was nothing more to hear.
    const { wake, names, commands, play, fire } = listener({
      transcripts: ["Hello."],
      detector: true,
    });
    await play(Buffer.concat([room(200), voice(200), room(10)]));
    fire();
    await play(room(200));
    await until(() => names.length === 1, "her name to be answered");
    assert.deepEqual(commands, [], "an address is not a question for the model");
    wake.stop();
  });

  test("the model firing is answered at once, before whisper has read a word", async () => {
    // "Instant" lives here. The chime, the window and the models paging back
    // in all hang off this, and the utterance around her name has not even
    // closed yet — nothing that wanted to be instant can wait for a transcript.
    const { wake, woken, heard, play, fire } = listener({ detector: true });
    await play(Buffer.concat([room(200), voice(100)]));
    fire();
    assert.equal(woken.length, 1);
    assert.equal(heard.length, 0, "no transcript exists yet, and nothing should wait for one");
    wake.stop();
  });

  test("whisper throwing the audio away does not overrule the model hearing her name", async () => {
    // "Hey Vela" on its own is short and scores as doubtful, so the silence bar
    // dropped it and whisper handed back nothing. The model had heard him; she
    // did not answer. What was said to her is the model's call, not the bar's.
    const { wake, names, commands, addressed } = listener({ transcripts: [""], detector: true });
    await addressed();
    await until(() => names.length === 1, "her name to be answered");
    assert.equal(commands.length, 0);
    wake.stop();
  });

  test("a name too quiet to open the gate is still answered, and straight away", async () => {
    // The spotter hears further than the loudness gate opens: it listens with
    // 20 dB of lift and the gate does not. Called from across the room, the
    // model fires and no utterance ever closes around it — so if nothing is in
    // flight to claim the detection, nothing ever will.
    const { wake, names, heard, fire } = listener({ detector: true });
    fire();
    assert.equal(names.length, 1);
    assert.equal(heard.length, 0);
    wake.stop();
  });

  test("one detection addresses one sentence, so the next keeps its first words", async () => {
    // A detection used to stay good for six seconds, so the sentence after
    // "Hey Vela" was addressed as well — and afterAddress, guessing where a
    // name it could not see was, cut "okay, what" off the front of it.
    const { wake, names, commands, addressed, utterance } = listener({
      transcripts: ["Hey Vela.", "Okay, what time is it?"],
      followUpMs: 30_000,
      detector: true,
    });
    await addressed();
    await until(() => names.length === 1, "her name to be answered");
    await utterance();
    await until(() => commands.length === 1, "the question");
    assert.deepEqual(commands, ["Okay, what time is it?"], "said to her, whole");
    assert.equal(names.length, 1, "and her name was answered once, not twice");
    wake.stop();
  });

  test("her name at the start of a long sentence addresses all of it", async () => {
    // The six seconds cut this the other way too: a request that ran longer
    // than that closed after its own address had expired. What decides it is
    // whether the model fired inside the sentence, however long the sentence.
    let clock = 1_000;
    const { wake, commands, play, fire } = listener({
      transcripts: ["Hey Vela, and then the long part of the request"],
      detector: true,
      now: () => clock,
    });
    await play(Buffer.concat([room(200), voice(100)]));
    fire();
    clock += 3_000;
    await play(Buffer.concat([voice(2_900), room(200)]));
    await until(() => commands.length === 1, "the request");
    assert.deepEqual(commands, ["and then the long part of the request"]);
    wake.stop();
  });

  test("a recording of what she heard is every byte the model heard, in order", async () => {
    // The tape exists to answer "why didn't she wake". A recording with a
    // chunk missing, or of a different stream, answers a different question.
    const fake = fakeSpawner();
    const taped: Buffer[] = [];
    const wake = startWakeListener({
      device: "Microphone Array",
      spawn: fake.spawn,
      hear: async () => "",
      onCommand: () => {},
      onAudio: (pcm) => taped.push(Buffer.from(pcm)),
    });
    const sent = [room(100), voice(100), room(100)];
    for (const pcm of sent) fake.last().proc.stdout.write(pcm);
    await settle();
    assert.deepEqual(Buffer.concat(taped), Buffer.concat(sent));
    wake.stop();
  });

  /** A listener whose only interest is what it says about the microphone. */
  const watchMic = () => {
    const fake = fakeSpawner();
    const problems: string[] = [];
    const wake = startWakeListener({
      device: "Microphone Array",
      spawn: fake.spawn,
      deadMs: 1_000,
      hear: async () => "",
      onCommand: () => {},
      onProblem: (why) => problems.push(why),
    });
    const play = async (pcm: Buffer) => {
      fake.last().proc.stdout.write(pcm);
      await settle();
    };
    return { wake, problems, play, zeros: (ms: number) => Buffer.alloc(ms * 32) };
  };

  test("a microphone that has sent nothing but silence is said out loud, once, and so is its return", async () => {
    // A muted or wedged device keeps delivering samples, all of them zero.
    // Everything downstream works perfectly on nothing, which from his side
    // is her ignoring him with no reason given.
    const { wake, problems, play, zeros } = watchMic();
    await play(zeros(3_000));
    assert.equal(problems.length, 1, "said once, not once a chunk");
    assert.match(problems[0], /silence/);
    await play(room(200));
    assert.match(problems[1] ?? "", /again/);
    wake.stop();
  });

  test("silence after the room has been heard is his microphone's gate, not a fault", async () => {
    // Acer PurifiedVoice cuts a quiet room to digital zero between sentences.
    // Treated as a fault, that was a warning every time he stopped talking —
    // and it sent the diagnosis after a broken microphone that was not broken.
    const { wake, problems, play, zeros } = watchMic();
    await play(room(500));
    await play(zeros(3_000));
    assert.deepEqual(problems, []);
    wake.stop();
  });

  test("she opens the microphone in the format whisper reads", async () => {
    const { wake, fake } = listener();
    assert.equal(fake.last().flag("-ar"), String(SAMPLE_RATE));
    assert.equal(fake.last().flag("-ac"), "1");
    assert.equal(fake.last().flag("-i"), "audio=Microphone Array");
    wake.stop();
  });

  test("a silent room never reaches whisper, so an idle Vela costs nothing", async () => {
    const { wake, heard, play } = listener();
    await play(room(3_000));
    assert.equal(heard.length, 0, "transcribing silence is the whole cost of being always-on");
    wake.stop();
  });

  test("an utterance that doesn't name her is heard and dropped", async () => {
    const { wake, commands, heard, utterance } = listener({
      transcripts: ["so I said we should ship it on Friday"],
    });
    await utterance();
    await until(() => heard.length === 1, "the utterance to be transcribed");
    await settle();
    assert.equal(commands.length, 0, "she must not answer a conversation she isn't in");
    wake.stop();
  });

  test("naming her sends the rest of the sentence as a turn", async () => {
    const { wake, commands, utterance } = listener({
      transcripts: ["Vela, what's on my calendar"],
    });
    await utterance();
    await until(() => commands.length === 1, "the command");
    assert.equal(commands[0], "what's on my calendar", "the name is not part of the ask");
    wake.stop();
  });

  test("her name on its own is acknowledged rather than sent to the model", async () => {
    const { wake, commands, names, utterance } = listener({ transcripts: ["Vela?"] });
    await utterance();
    await until(() => names.length === 1, "the acknowledgement");
    assert.equal(commands.length, 0, "a model turn to say 'yes?' is a second and a half of nothing");
    wake.stop();
  });

  test("the next sentence after a turn does not need her name again", async () => {
    const { wake, commands, utterance } = listener({
      transcripts: ["Vela, what's on my calendar", "and what about tomorrow"],
    });
    await utterance();
    await until(() => commands.length === 1, "the first command");
    await utterance();
    await until(() => commands.length === 2, "the follow-up");
    assert.equal(commands[1], "and what about tomorrow");
    wake.stop();
  });

  test("once the window has passed, she needs her name again", async () => {
    let clock = 1_000;
    const { wake, commands, utterance } = listener({
      transcripts: ["Vela, what's on my calendar", "so anyway, Friday"],
      followUpMs: 5_000,
      now: () => clock,
    });
    await utterance();
    await until(() => commands.length === 1, "the first command");
    clock += 6_000;
    await utterance();
    await settle();
    assert.equal(commands.length, 1, "a conversation with someone else must not become turns");
    wake.stop();
  });

  test("capped, a sentence she was not addressed in cannot hold the window open", async () => {
    let clock = 1_000;
    const { wake, commands, utterance } = listener({
      transcripts: [
        "Vela, what's on my calendar",
        "so I told him it was fine",
        "and then we went to dinner",
      ],
      followUpMs: 5_000,
      followUps: 1,
      now: () => clock,
    });
    await utterance();
    await until(() => commands.length === 1, "the address");
    clock += 4_000;
    await utterance();
    await until(() => commands.length === 2, "the sentence the window exists for");
    clock += 4_000;
    await utterance();
    await settle();
    assert.equal(
      commands.length,
      2,
      "a window a nameless sentence can renew turns one mis-fire into the whole conversation",
    );
    wake.stop();
  });

  test("capped at one, the window is spent by the sentence it was opened for", async () => {
    const { wake, commands, utterance } = listener({
      transcripts: ["Vela, what's on my calendar", "and tomorrow", "did you see the game"],
      followUpMs: 5_000,
      followUps: 1,
    });
    await utterance();
    await until(() => commands.length === 1, "the address");
    await utterance();
    await until(() => commands.length === 2, "the follow-up she was owed");
    await utterance();
    await settle();
    assert.equal(
      commands.length,
      2,
      "an unspent window is a room she keeps answering, however quickly he is talking",
    );
    wake.stop();
  });

  test("uncapped by the caller, a mis-fire still runs out on its own", async () => {
    // The cap existed and defaulted to Infinity, which is the same as not
    // having it: one hallucinated wake, and every noise in the room for the
    // next several minutes arrived as a turn — each one pushing the deadline
    // out again, so the timer alone never closed it. What makes this the
    // default rather than a setting is that the failure is silent from the
    // outside: she looks like she is listening, and nobody in the room knows
    // she is answering them.
    let clock = 1_000;
    const noise = Array.from({ length: 12 }, (_, i) => `bop bop bop ${i}`);
    const { wake, commands, utterance } = listener({
      transcripts: ["Vela", ...noise],
      followUpMs: 30_000,
      now: () => clock,
    });
    await utterance();
    for (const _ of noise) {
      clock += 1_000;
      await utterance();
      await settle();
    }
    // Named, so a change to the number is a change to this line rather than a
    // test that quietly still passes at eleven.
    assert.equal(
      commands.length,
      6,
      "one mis-fire must cost a bounded number of turns, not the rest of the conversation",
    );
    wake.stop();
  });

  test("a conversation stays open for as long as it is a conversation", async () => {
    let clock = 1_000;
    const { wake, commands, utterance } = listener({
      transcripts: [
        "Vela, what's on my calendar",
        "can you hear me",
        "what about tomorrow",
        "and the day after",
      ],
      followUpMs: 30_000,
      now: () => clock,
    });
    await utterance();
    await until(() => commands.length === 1, "the address");
    // Each reply lands well inside the session, and pushes it along.
    for (let i = 2; i <= 4; i++) {
      clock += 20_000;
      await utterance();
      await until(() => commands.length === i, `sentence ${i}`);
    }
    assert.equal(
      commands.length,
      4,
      "saying her name before every sentence is what makes a wake word tiring",
    );
    wake.stop();
  });

  test("the session ends when nothing has been said to her, not when she is bored", async () => {
    let clock = 1_000;
    const { wake, commands, utterance } = listener({
      transcripts: ["Vela, open Netflix", "so anyway I told him it was fine"],
      followUpMs: 30_000,
      now: () => clock,
    });
    await utterance();
    await until(() => commands.length === 1, "the address");
    clock += 31_000;
    await utterance();
    await settle();
    assert.equal(commands.length, 1, "she has to let go of a room she is no longer part of");
    wake.stop();
  });

  test("telling her they're done closes it there and then", async () => {
    const { wake, commands, byes, utterance } = listener({
      transcripts: ["Vela, open Netflix", "okay thank you, we're done", "did you see the game"],
      followUpMs: 30_000,
    });
    await utterance();
    await until(() => commands.length === 1, "the address");
    await utterance();
    await until(() => byes.length === 1, "the goodbye");
    await utterance();
    await settle();
    assert.equal(
      commands.length,
      1,
      "a session he has closed must not still be open, or the timer is the only way out",
    );
    wake.stop();
  });

  test("a longer sentence ending in a goodbye is answered, and then nothing more is taken", async () => {
    // It may carry a request, so it goes to her rather than straight to a
    // goodbye; but he has gone, so what is said after it is the room.
    const { wake, commands, leaving, byes, utterance } = listener({
      transcripts: [
        "Vela, what's on my calendar",
        "Ah, don't worry about that, you can go now.",
        "so anyway, Friday",
      ],
      followUpMs: 30_000,
    });
    await utterance();
    await until(() => commands.length === 1, "the address");
    await utterance();
    await until(() => commands.length === 2, "the sentence he left on");
    assert.deepEqual(leaving, ["Ah, don't worry about that, you can go now."]);
    assert.equal(byes.length, 0, "not an instant goodbye: she answers it first");
    await utterance();
    await settle();
    assert.equal(commands.length, 2, "the conversation closed with that sentence");
    wake.stop();
  });

  test("a goodbye in the same breath as her name still lets her go", async () => {
    // "Hey Vela, you can go now", which whisper wrote as "Okay, you can go now."
    // The model says he addressed her, the transcript carries no name, and
    // afterAddress guesses that "okay, you" was it. Matched on what was left,
    // the dismissal missed and she answered it as a question. It has to be
    // matched on what he said.
    const { wake, commands, byes, addressed } = listener({
      transcripts: ["Okay, you can go now."],
      followUpMs: 30_000,
      detector: true,
    });
    await addressed();
    await until(() => byes.length === 1, "the goodbye");
    assert.deepEqual(commands, [], "a goodbye is not a question for the model");
    wake.stop();
  });

  test("the window is measured from when she stops talking, not when she started", async () => {
    let clock = 1_000;
    const { wake, commands, utterance } = listener({
      transcripts: ["Vela, read me the release notes", "what about the second one"],
      followUpMs: 5_000,
      now: () => clock,
    });
    await utterance();
    await until(() => commands.length === 1, "the first command");

    // A long answer: held while she talks, and the whole window elapses.
    wake.hold();
    clock += 30_000;
    wake.resume();

    await utterance();
    await until(() => commands.length === 2, "the follow-up");
    assert.equal(
      commands[1],
      "what about the second one",
      "a window that runs down while she is still talking is never open when he replies",
    );
    wake.stop();
  });

  test("a reply he started inside the window is his, however long whisper took to read it", async () => {
    // The window used to be asked about once the transcript came back. A
    // sentence begun with a second to spare, and read in two, arrived after
    // the deadline and was dropped as the room.
    let clock = 1_000;
    let slow = false;
    const { wake, commands, utterance } = listener({
      transcripts: ["Vela, what's on my calendar", "and what about tomorrow"],
      followUpMs: 5_000,
      now: () => clock,
      reading: () => {
        if (slow) clock += 2_000;
      },
    });
    await utterance();
    await until(() => commands.length === 1, "the address");
    clock += 4_000;
    slow = true;
    await utterance();
    await until(() => commands.length === 2, "the reply");
    assert.equal(commands[1], "and what about tomorrow");
    wake.stop();
  });

  test("a sentence just after the window ran out is reported, with how late it was", async () => {
    // The miss that looks exactly like her breaking: she was talking to him a
    // moment ago and now she is not. Unreported, it cannot be told apart in the
    // log from her having gone deaf, and an afternoon went on not knowing which.
    let clock = 1_000;
    const { wake, commands, lapses, utterance } = listener({
      transcripts: ["Vela, what's on my calendar", "so what's for dinner"],
      followUpMs: 5_000,
      now: () => clock,
    });
    await utterance();
    await until(() => commands.length === 1, "the address");
    clock += 9_000;
    await utterance();
    await until(() => lapses.length === 1, "the lapse to be reported");
    assert.equal(commands.length, 1, "reported, not taken: the window still means what it meant");
    assert.equal(lapses[0].text, "so what's for dinner");
    assert.equal(lapses[0].spent, false);
    assert.ok(lapses[0].lateMs > 0 && lapses[0].lateMs <= 4_000, `late by ${lapses[0].lateMs}ms`);
    wake.stop();
  });

  test("a window closed by the cap says so, rather than looking like time ran out", async () => {
    const { wake, commands, lapses, utterance } = listener({
      transcripts: ["Vela, what's on my calendar", "and tomorrow", "and the day after"],
      followUpMs: 30_000,
      followUps: 1,
    });
    await utterance();
    await until(() => commands.length === 1, "the address");
    await utterance();
    await until(() => commands.length === 2, "the one follow-up");
    await utterance();
    await until(() => lapses.length === 1, "the lapse to be reported");
    assert.equal(lapses[0].spent, true, "the two need different fixes: one is the timer, one is the cap");
    wake.stop();
  });

  test("a conversation he ended is not reported as one that ran out on him", async () => {
    const { wake, lapses, byes, utterance } = listener({
      transcripts: ["Vela, open Netflix", "okay thank you, we're done", "did you see the game"],
      followUpMs: 30_000,
    });
    await utterance();
    await utterance();
    await until(() => byes.length === 1, "the goodbye");
    await utterance();
    await settle();
    assert.deepEqual(lapses, [], "after a goodbye, the room is just the room");
    wake.stop();
  });

  test("the room long after a conversation is not reported, or the log becomes a transcript of it", async () => {
    let clock = 1_000;
    const { wake, lapses, commands, utterance } = listener({
      transcripts: ["Vela, open Netflix", "did you see the game"],
      followUpMs: 5_000,
      now: () => clock,
    });
    await utterance();
    await until(() => commands.length === 1, "the address");
    clock += 5_000 + LAPSED_WITHIN_MS + 1_000;
    await utterance();
    await settle();
    assert.deepEqual(lapses, []);
    wake.stop();
  });

  test("pressing her opens a conversation without her name", async () => {
    // Her face on the screen is the other way of saying "Hey Vela". It used to
    // be a mute in a room, and in a hub that had not learned it was in one it
    // was a push-to-talk that went round the wake word entirely.
    const { wake, commands, utterance } = listener({
      transcripts: ["what's the weather", "what's the weather"],
      followUpMs: 30_000,
    });
    await utterance();
    await settle();
    assert.equal(commands.length, 0, "before the press, a nameless sentence is the room");
    wake.open();
    await utterance();
    await until(() => commands.length === 1, "the sentence after the press");
    assert.equal(commands[0], "what's the weather");
    wake.stop();
  });

  test("pressed while she is talking, the window starts when she stops", async () => {
    let clock = 1_000;
    const { wake, commands, utterance } = listener({
      transcripts: ["and what about tomorrow"],
      followUpMs: 5_000,
      now: () => clock,
    });
    wake.hold();
    wake.open();
    clock += 30_000;
    wake.resume();
    await utterance();
    await until(() => commands.length === 1, "the sentence after she stopped");
    wake.stop();
  });

  test("whose voice it was is asked when the gate cuts the sentence, and handed over with the turn", async () => {
    // Asked at the cut, it is worked out in the half second whisper is taking
    // anyway. Asked once the transcript said it was a turn, it would be added
    // to every answer's wait.
    const fake = fakeSpawner();
    let askedBeforeReading = false;
    let asked = 0;
    const whos: unknown[] = [];
    const sarah = { kind: "known" as const, name: "Sarah", score: 0.7, speech: 2 };
    const wake = startWakeListener({
      device: "Microphone Array",
      spawn: fake.spawn,
      segment: { frameMs: 10, preRollMs: 20, minMs: 20, hangoverMs: 30, maxMs: 5_000 },
      who: async () => {
        asked++;
        return sarah;
      },
      hear: async () => {
        askedBeforeReading = asked === 1;
        return "Vela, what time is it";
      },
      onCommand: (_text, woke) => void woke.who.then((w) => whos.push(w)),
    });
    fake.last().proc.stdout.write(Buffer.concat([room(200), voice(200), room(200)]));
    await until(() => whos.length === 1, "the turn, with its voice");
    assert.equal(askedBeforeReading, true);
    assert.deepEqual(whos, [sarah]);
    wake.stop();
  });

  test("a sentence with nothing after it is read once, and the read starts before the gate closes", async () => {
    // The point of reading early: the second the gate waits to be sure he has
    // stopped is spent reading, so the transcript is there when it closes.
    const { wake, commands, timeline, utterance } = listener({
      transcripts: ["Vela, what time is it"],
      pauseMs: 10,
    });
    await utterance();
    await until(() => commands.length === 1, "the command");
    assert.deepEqual(timeline, ["read", "cut"], "read once, before the close, and that read is the one used");
    assert.equal(commands[0], "what time is it");
    wake.stop();
  });

  test("carrying on after a pause throws the early read away, so starting early never costs a word", async () => {
    // "Vela, what time is it ... in Tokyo". The read taken at the pause has
    // only the first half; the one taken after the last word has all of it.
    const { wake, commands, play } = listener({
      transcripts: ["Vela, what time is it", "Vela, what time is it in Tokyo"],
      pauseMs: 10,
    });
    await play(Buffer.concat([room(200), voice(100), room(10), voice(100), room(200)]));
    await until(() => commands.length === 1, "the command");
    assert.equal(commands[0], "what time is it in Tokyo");
    wake.stop();
  });

  test("talking on after a pause until the length limit cuts it reads the whole thing, not the part before the pause", async () => {
    // Every other close passes through a fresh pause first, and that newer
    // read replaces the old. A sentence cut at the limit closes mid-word,
    // with no pause after the last word, so the only early read is the stale
    // one from the middle, and it must not stand in for the sentence.
    const { wake, commands, play } = listener({
      transcripts: ["Vela, the first half", "Vela, the first half and all of the rest"],
      pauseMs: 10,
    });
    await play(Buffer.concat([room(200), voice(100), room(10), voice(5_200)]));
    await until(() => commands.length === 1, "the cut sentence");
    assert.equal(commands[0], "the first half and all of the rest");
    wake.stop();
  });

  test("an early read of a sentence she stopped hearing is never handed to the next one", async () => {
    // She started talking mid-sentence and held the microphone, so that
    // sentence is gone, read half-way. The next one must be read for itself.
    // It is too short to be read early on its own pause, so the only early
    // read in existence is the stale one, and it must go unused.
    const { wake, commands, heard, play } = listener({
      transcripts: ["Vela, the stale half", "Vela, the sentence he just said"],
      pauseMs: 10,
    });
    await play(Buffer.concat([room(200), voice(100), room(10)]));
    await until(() => heard.length === 1, "the early read of the first sentence");
    wake.hold();
    wake.resume();
    await play(Buffer.concat([room(200), voice(20), room(200)]));
    await until(() => commands.length === 1, "the second sentence");
    assert.equal(commands[0], "the sentence he just said");
    wake.stop();
  });

  test("with reading early off, whisper reads after the gate closes, as it always did", async () => {
    const { wake, commands, timeline, utterance } = listener({ transcripts: ["Vela, what time is it"] });
    await utterance();
    await until(() => commands.length === 1, "the command");
    assert.deepEqual(timeline, ["cut", "read"]);
    wake.stop();
  });

  test("held, she does not hear herself", async () => {
    const { wake, heard, utterance } = listener({ transcripts: ["Vela, hello"] });
    wake.hold();
    await utterance();
    await settle();
    assert.equal(
      heard.length,
      0,
      "the speakers are in the same room; transcribing her own reply is a loop",
    );
    wake.stop();
  });

  test("a microphone that dies is opened again", async () => {
    const { wake, fake } = listener();
    assert.equal(fake.spawned.length, 1);
    fake.last().proc.close();
    await until(() => fake.spawned.length === 2, "the microphone to be reopened");
    wake.stop();
  });

  test("a microphone that dies reports it once, not once per event", async () => {
    const fake = fakeSpawner();
    const problems: string[] = [];
    const wake = startWakeListener({
      device: "mic",
      spawn: fake.spawn,
      reopenMs: [0],
      hear: async () => "",
      onCommand: () => {},
      onProblem: (why) => problems.push(why),
    });
    // A device pulled out of the socket fires both error and close.
    fake.last().proc.fail("device disconnected");
    fake.last().proc.close();
    await until(() => fake.spawned.length === 2, "the microphone to be reopened");
    assert.equal(problems.length, 1, "two reports means two microphones were opened");
    wake.stop();
  });

  test("stopping does not reopen the microphone", async () => {
    const { wake, fake } = listener();
    wake.stop();
    fake.last().proc.close();
    await settle();
    await settle();
    assert.equal(fake.spawned.length, 1, "a listener that reopens on its own shutdown never shuts down");
  });

  describe("knowing when he has finished", () => {
    /** listener()'s gate waits 30ms and reads early after 10. */
    const sure = async () => 0.9;
    const unsure = async () => 0.1;

    test("taking notes: each pause is written down with both clues and what he did, and the gate still decides", async () => {
      const { wake, commands, notes, play } = listener({ transcripts: ["Vela, how are you?"], pauseMs: 10, turn: { judge: sure } });
      await play(Buffer.concat([room(200), voice(100), room(10)]));
      await settle();
      assert.equal(commands.length, 0, "taking notes must not change when she answers");
      await play(room(200));
      await until(() => notes.length === 1, "the note");
      assert.deepEqual(
        { ...notes[0], decidedMs: 0 },
        { atMs: notes[0].atMs, text: "Vela, how are you?", textDone: true, p: 0.9, call: "done", decidedMs: 0, outcome: "stopped", acted: false, toHer: true },
      );
      assert.deepEqual(commands, ["how are you?"]);
      wake.stop();
    });

    test("a guess he talked on after is written down as him carrying on, which is the cut-off it would have been", async () => {
      // The whole point of taking notes first: a "done" followed by more of the
      // sentence is the mistake that acting on it would have made.
      const { wake, notes, play } = listener({
        transcripts: ["Vela, what time is it?", "Vela, what time is it in Tokyo?"],
        pauseMs: 10,
        turn: { judge: sure },
      });
      await play(Buffer.concat([room(200), voice(100), room(10), voice(100), room(200)]));
      await until(() => notes.length === 2, "both notes");
      assert.deepEqual(
        notes.map((n) => [n.call, n.outcome]),
        [["done", "carried-on"], ["done", "stopped"]],
      );
      wake.stop();
    });

    test("the room's sentences are written down as not to her, so his numbers aren't the TV's", async () => {
      const { wake, notes, commands, play } = listener({ transcripts: ["and that's the weather."], pauseMs: 10, turn: { judge: sure } });
      await play(Buffer.concat([room(200), voice(100), room(200)]));
      await until(() => notes.length === 1, "the note");
      assert.equal(notes[0].toHer, false);
      assert.equal(commands.length, 0);
      wake.stop();
    });

    test("switched on, a pause that sounds finished both ways is answered without waiting out the gate", async () => {
      const { wake, commands, notes, play } = listener({ transcripts: ["Vela, how are you?"], pauseMs: 10, turn: { judge: sure, act: true } });
      await play(Buffer.concat([room(200), voice(100), room(10)]));
      await until(() => commands.length === 1, "an answer before the gate's own wait is up");
      assert.deepEqual(commands, ["how are you?"]);
      await until(() => notes.length === 1, "the note");
      assert.equal(notes[0].acted, true);
      wake.stop();
    });

    test("switched on, either clue saying he isn't finished leaves it to the gate", async () => {
      // Trailing words on the page, or a trailing sound: both have to agree,
      // because answering early is only worth it if it never cuts him off.
      for (const [text, judge] of [
        ["Vela, can you find me...", sure],
        ["Vela, how are you?", unsure],
      ] as const) {
        const { wake, commands, notes, play } = listener({ transcripts: [text], pauseMs: 10, turn: { judge, act: true } });
        await play(Buffer.concat([room(200), voice(100), room(10)]));
        await settle();
        await settle();
        assert.equal(commands.length, 0, `answered early on "${text}"`);
        await play(room(200));
        await until(() => notes.length === 1, "the note");
        assert.equal(notes[0].acted, false);
        wake.stop();
      }
    });

    test("a judge that never answers costs nothing: the gate's own wait still closes it", async () => {
      const { wake, commands, play } = listener({
        transcripts: ["Vela, how are you?"],
        pauseMs: 10,
        turn: { judge: () => new Promise<number | null>(() => {}), act: true },
      });
      await play(Buffer.concat([room(200), voice(100), room(200)]));
      await until(() => commands.length === 1, "the command, on the gate's own time");
      wake.stop();
    });
  });
});

describe("startWakeListener, answering her name the moment he stops", () => {
  /**
   * A listener with a model, and a gate that waits longer than the quiet the
   * early answer needs — the real one waits a second, the model fires a third
   * of a second after her name. The shared helper above closes utterances in
   * 30ms, which is shorter than the model takes, so it cannot show this.
   */
  function early(opts: { transcripts?: string[]; now?: () => number; hangoverMs?: number; slowHear?: boolean } = {}) {
    const fake = fakeSpawner();
    const names: boolean[] = [];
    const commands: string[] = [];
    const asked: number[] = [];
    const missed: Buffer[][] = [];
    const heard: Buffer[] = [];
    const queue = [...(opts.transcripts ?? [])];
    let release: (() => void) | null = null;
    let fired: ((score: number) => void) | null = null;

    const wake = startWakeListener({
      device: "Microphone Array",
      spawn: fake.spawn,
      reopenMs: [0],
      followUpMs: 30_000,
      ...(opts.now ? { now: opts.now } : {}),
      detector: {
        push: () => {},
        onFire: (fn: (score: number) => void) => {
          fired = fn;
        },
        firedSince: () => false,
        lastScore: () => 1,
        ready: Promise.resolve(true),
        stop: () => {},
      },
      segment: { frameMs: 10, preRollMs: 20, minMs: 20, hangoverMs: opts.hangoverMs ?? 600, maxMs: 5_000 },
      nameQuietMs: 200,
      nameWatchMs: 200,
      hear: async (pcm) => {
        heard.push(pcm);
        if (opts.slowHear) await new Promise<void>((r) => (release = r));
        return queue.shift() ?? "";
      },
      onCommand: (text) => commands.push(text),
      onName: (_word, how) => names.push(how.paused),
      onAsked: () => asked.push(1),
      onMissed: (clips) => missed.push(clips.map((c) => c.pcm)),
    });

    const play = async (pcm: Buffer) => {
      fake.last().proc.stdout.write(pcm);
      await settle();
    };
    const fire = () => fired?.(1);
    /** "Hey Vela", and the quiet the model fires in, 250ms after it. */
    const name = async () => {
      await play(Buffer.concat([room(200), voice(200), room(250)]));
      fire();
    };
    return { wake, names, commands, asked, missed, heard, play, fire, name, release: () => release?.() };
  }

  test("her name and then quiet is answered before the sentence closes, and never reaches whisper", async () => {
    // The gap he heard. The chime came instantly and then nothing, because
    // the bare name was only known once the gate's second of hangover had
    // passed and whisper had read it. Answered here, the greeting can be
    // played half a second after he stops. And whisper never sees it, which
    // is what sent "Hey fellow" to the model as a question.
    const { wake, names, heard, name, play } = early({ transcripts: ["Hey fellow"] });
    await name();
    assert.deepEqual(names, [], "200ms of quiet before the model fired is not yet enough");
    await play(room(250));
    assert.deepEqual(names, [true], "answered, and marked as him having stopped");
    await play(room(1_000));
    assert.equal(heard.length, 0, "the name's own audio is spent, not transcribed");
    wake.stop();
  });

  test("speech after the detection means a question is coming, and the transcript decides", async () => {
    // The case the early answer must never take: "Hey Vela, what time is it"
    // with a breath after the name. A greeting there plays over his question,
    // and the microphone she holds while she speaks would cut it off.
    const { wake, names, commands, asked, name, play } = early({
      transcripts: ["Hey Vela, what time is it?"],
    });
    await name();
    await play(Buffer.concat([voice(150), room(700)]));
    await until(() => commands.length === 1, "the question");
    assert.deepEqual(names, [], "no answer to her name over the top of him");
    assert.deepEqual(commands, ["what time is it?"]);
    assert.equal(asked.length, 1, "and it is still filled as a question");
    wake.stop();
  });

  test("a detection that lands before he has been quiet long enough waits for the transcript", async () => {
    // The bar is measured at the moment the model fires. A detection inside a
    // pause shorter than that could be the comma in "Hey Vela, what...", so it
    // is not treated as him stopping; the slow path still answers the name,
    // flagged so the service puts it on screen rather than speak over him.
    const { wake, names, play, fire } = early({ transcripts: ["Hey Vela."] });
    await play(Buffer.concat([room(200), voice(200), room(100)]));
    fire();
    await play(room(700));
    await until(() => names.length === 1, "her name");
    assert.deepEqual(names, [false]);
    wake.stop();
  });

  test("a name answered early is not answered again when whisper catches up with it", async () => {
    // Only reachable with a gate that closes faster than the model fires:
    // the utterance holding the name is already with whisper when it is
    // answered. Read late, "Hey fellow" falls inside the window the answer
    // opened, and without this it goes to the model as a nameless question.
    const { wake, names, commands, missed, name, play, release } = early({
      transcripts: ["Hey fellow"],
      hangoverMs: 30,
      slowHear: true,
    });
    await name();
    await play(room(250));
    assert.deepEqual(names, [true]);
    release();
    await settle();
    assert.deepEqual(commands, [], "her name is not a question for the model");
    assert.deepEqual(names, [true], "and it is answered once");
    assert.deepEqual(missed, [], "the name's own audio is not an earlier attempt at it");
    wake.stop();
  });

  test("her starting to speak mid-watch abandons the early answer", async () => {
    // A hold means her own voice is about to fill the room. Answering her name
    // after it, out of a watch that started before, would be her talking over
    // herself.
    const { wake, names, name, play } = early();
    await name();
    wake.hold();
    wake.resume();
    await play(room(250));
    assert.deepEqual(names, []);
    wake.stop();
  });
});

describe("startWakeListener, keeping the attempts she missed", () => {
  /** The same listener, on a clock the test moves. */
  function missing(transcripts: string[], followUpMs = 8_000) {
    let clock = 1_000;
    const fake = fakeSpawner();
    const missed: Buffer[][] = [];
    const heard: Buffer[] = [];
    const commands: string[] = [];
    const queue = [...transcripts];
    let fired: ((score: number) => void) | null = null;
    const wake = startWakeListener({
      device: "Microphone Array",
      spawn: fake.spawn,
      followUpMs,
      now: () => clock,
      detector: {
        push: () => {},
        onFire: (fn: (score: number) => void) => {
          fired = fn;
        },
        firedSince: () => false,
        lastScore: () => 1,
        ready: Promise.resolve(true),
        stop: () => {},
      },
      segment: { frameMs: 10, preRollMs: 20, minMs: 20, hangoverMs: 600, maxMs: 5_000 },
      nameQuietMs: 200,
      nameWatchMs: 200,
      hear: async (pcm) => {
        heard.push(pcm);
        return queue.shift() ?? "";
      },
      onCommand: (text) => commands.push(text),
      onMissed: (clips) => missed.push(clips.map((c) => c.pcm)),
    });
    const play = async (pcm: Buffer) => {
      fake.last().proc.stdout.write(pcm);
      await settle();
    };
    /** Something said that the model did not fire on. */
    const unheard = async () => {
      await play(Buffer.concat([room(200), voice(300), room(700)]));
      await until(() => heard.length > 0, "whisper to read it");
    };
    /** Her name, heard, and answered early. */
    const name = async () => {
      await play(Buffer.concat([room(200), voice(200), room(250)]));
      fired?.(1);
      await play(room(250));
    };
    return { wake, missed, heard, commands, play, unheard, name, later: (ms: number) => (clock += ms) };
  }

  test("the attempt just before the one she heard is kept, as the audio the model was given", async () => {
    // "I have to say it twice." The second one woke her; the first is the
    // miss, and it is only worth anything for tuning if it is exactly what
    // the model heard, which is the same bytes the gate handed whisper.
    const { wake, missed, heard, unheard, name, later } = missing(["Hey fellow"]);
    await unheard();
    later(3_000);
    await name();
    assert.equal(missed.length, 1);
    assert.deepEqual(missed[0], [heard[0]]);
    wake.stop();
  });

  test("what he said to her inside a conversation is not a miss", async () => {
    // A follow-up was a turn she took, not her failing to hear her name.
    // Inside an open session the name is optional, so nothing he says there
    // is evidence about the model at all.
    const { wake, missed, commands, play, name, later } = missing(["what time is it?"]);
    await name();
    later(1_000);
    await play(Buffer.concat([room(200), voice(300), room(700)]));
    await until(() => commands.length === 1, "the follow-up");
    later(2_000);
    await name();
    assert.deepEqual(missed, []);
    wake.stop();
  });

  test("an attempt more than ten seconds before is not this one", async () => {
    const { wake, missed, unheard, name, later } = missing(["something else entirely"]);
    await unheard();
    later(12_000);
    await name();
    assert.deepEqual(missed, []);
    wake.stop();
  });

  test("a miss is kept once, not again by the next time she hears her name", async () => {
    // The second call comes after the first conversation has lapsed and while
    // the miss is still inside ten seconds, so the only thing stopping it being
    // kept twice is that it was already kept.
    const { wake, missed, unheard, name, later } = missing(["Hey fellow"], 1_000);
    await unheard();
    later(2_000);
    await name();
    later(3_000);
    await name();
    assert.equal(missed.length, 1);
    wake.stop();
  });
});

describe("startWakeListener, when things go wrong", () => {
  test("every transcript is reported, so a wake word that never fires can be seen", async () => {
    const fake = fakeSpawner();
    const seen: { text: string; woke: boolean; level: number }[] = [];
    const queue = ["the dog needs feeding", "Vela, what time is it"];
    const wake = startWakeListener({
      device: "mic",
      spawn: fake.spawn,
      segment: { frameMs: 10, preRollMs: 20, minMs: 20, hangoverMs: 30 },
      hear: async () => queue.shift() ?? "",
      onCommand: () => {},
      onHeard: (heard) => seen.push(heard),
    });

    const say = async () => {
      fake.last().proc.stdout.write(Buffer.concat([room(200), voice(200), room(200)]));
      await settle();
    };
    await say();
    await until(() => seen.length === 1, "the first transcript");
    await say();
    await until(() => seen.length === 2, "the second transcript");

    // The two ways this goes wrong — she never answers, or she answers the
    // television — look the same from outside and have opposite fixes.
    assert.equal(seen[0].woke, false);
    assert.equal(seen[1].woke, true);
    assert.ok(seen[0].level < 0, "the level is what VELA_WAKE_MARGIN gets tuned against");
    wake.stop();
  });

  test("whisper failing is a missed sentence, not a deaf assistant", async () => {
    const fake = fakeSpawner();
    const commands: string[] = [];
    let asked = 0;
    const wake = startWakeListener({
      device: "mic",
      spawn: fake.spawn,
      segment: { frameMs: 10, preRollMs: 20, minMs: 20, hangoverMs: 30 },
      hear: async () => {
        asked++;
        if (asked === 1) throw new Error("the worker died");
        return "Vela, try again";
      },
      onCommand: (text) => commands.push(text),
    });

    const say = async () => {
      fake.last().proc.stdout.write(Buffer.concat([room(200), voice(200), room(200)]));
      await settle();
    };
    await say();
    await until(() => asked === 1, "the failing transcription");
    await say();
    await until(() => commands.length === 1, "the sentence after it");
    assert.equal(commands[0], "try again");
    wake.stop();
  });

  test("with the window off, every sentence needs her name", async () => {
    const fake = fakeSpawner();
    const commands: string[] = [];
    const queue = ["Vela, what's on my calendar", "and tomorrow"];
    const wake = startWakeListener({
      device: "mic",
      spawn: fake.spawn,
      followUpMs: 0,
      segment: { frameMs: 10, preRollMs: 20, minMs: 20, hangoverMs: 30 },
      hear: async () => queue.shift() ?? "",
      onCommand: (text) => commands.push(text),
    });

    const say = async () => {
      fake.last().proc.stdout.write(Buffer.concat([room(200), voice(200), room(200)]));
      await settle();
    };
    await say();
    await until(() => commands.length === 1, "the first command");
    await say();
    await until(() => queue.length === 0, "the second transcript");
    assert.equal(commands.length, 1, "VELA_WAKE_FOLLOWUP=0 has to actually turn it off");
    wake.stop();
  });

  test("stopping mid-sentence drops the turn rather than answering after she's gone", async () => {
    const fake = fakeSpawner();
    const commands: string[] = [];
    let release: (text: string) => void = () => {};
    let asked = 0;
    const wake = startWakeListener({
      device: "mic",
      spawn: fake.spawn,
      segment: { frameMs: 10, preRollMs: 20, minMs: 20, hangoverMs: 30 },
      hear: () =>
        new Promise((done) => {
          asked++;
          release = done;
        }),
      onCommand: (text) => commands.push(text),
    });

    fake.last().proc.stdout.write(Buffer.concat([room(200), voice(200), room(200)]));
    await until(() => asked === 1, "the transcription to be in flight");

    wake.stop();
    release("Vela, shut everything down");
    await settle();
    assert.equal(commands.length, 0, "a turn sent to a stopped core goes nowhere");
  });
});

describe("startWakeListener, across a microphone that came back", () => {
  const say = async (proc: { stdout: { write: (b: Buffer) => unknown } }) => {
    proc.stdout.write(Buffer.concat([room(200), voice(200), room(200)]));
    await settle();
  };

  test("she is still listening on the microphone she reopened", async () => {
    const fake = fakeSpawner();
    const commands: string[] = [];
    const wake = startWakeListener({
      device: "mic",
      spawn: fake.spawn,
      reopenMs: [0],
      segment: { frameMs: 10, preRollMs: 20, minMs: 20, hangoverMs: 30 },
      hear: async () => "Vela, are you still there",
      onCommand: (text) => commands.push(text),
    });

    fake.last().proc.close();
    await until(() => fake.spawned.length === 2, "the microphone to be reopened");
    await say(fake.last().proc);
    // Reopening a device she then ignores is the same as not reopening it.
    await until(() => commands.length === 1, "a turn from the new microphone");
    assert.equal(commands[0], "are you still there");
    wake.stop();
  });

  test("a sentence said while she's still reading the last one replaces it", async () => {
    const fake = fakeSpawner();
    const commands: string[] = [];
    const queue = ["Vela, one", "Vela, two", "Vela, three"];
    const holding: (() => void)[] = [];
    const wake = startWakeListener({
      device: "mic",
      spawn: fake.spawn,
      segment: { frameMs: 10, preRollMs: 20, minMs: 20, hangoverMs: 30 },
      hear: () =>
        new Promise((done) => holding.push(() => done(queue.shift() ?? ""))),
      onCommand: (text) => commands.push(text),
    });

    await say(fake.last().proc); // starts transcribing, and blocks
    await until(() => holding.length === 1, "the first transcription");
    await say(fake.last().proc); // queued behind it
    await say(fake.last().proc); // and this replaces that

    holding[0]();
    await until(() => holding.length === 2, "the backlog to be picked up");
    holding[1]();
    await until(() => commands.length === 2, "both turns");
    await settle();

    // Two utterances waited; only the later one survived. A queue here would
    // have her answering a question from a minute ago.
    assert.deepEqual(commands, ["one", "two"]);
    assert.equal(holding.length, 2, "the middle sentence was dropped, not queued");
    wake.stop();
  });
});
