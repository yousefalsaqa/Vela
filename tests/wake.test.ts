import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  matchWake,
  isDismissal,
  createSegmenter,
  startWakeListener,
  WAKE_WORDS,
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

describe("isDismissal", () => {
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
  } = {}) {
    const fake = fakeSpawner();
    const commands: string[] = [];
    const names: number[] = [];
    const byes: number[] = [];
    const heard: Buffer[] = [];
    const queue = [...(opts.transcripts ?? [])];

    const wake = startWakeListener({
      device: "Microphone Array",
      spawn: fake.spawn,
      reopenMs: [0],
      followUpMs: opts.followUpMs,
      ...(opts.followUps === undefined ? {} : { followUps: opts.followUps }),
      ...(opts.now ? { now: opts.now } : {}),
      segment: { frameMs: 10, preRollMs: 20, minMs: 20, hangoverMs: 30, maxMs: 5_000 },
      hear: async (pcm) => {
        heard.push(pcm);
        return queue.shift() ?? "";
      },
      onCommand: (text) => commands.push(text),
      onName: () => names.push(1),
      onDismiss: () => byes.push(1),
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

    return { wake, fake, commands, names, byes, heard, play, utterance };
  }

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
