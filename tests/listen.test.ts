import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseAudioDevices,
  pickDevice,
  cleanTranscript,
  wavFromPcm,
  normalise,
  levelDb,
  startRecording,
  openMic,
  captureArgs,
  createTranscriber,
  saidSomething,
  HEARD_ANYTHING,
  UNPROMPTED,
  wakePrior,
  isStutter,
  cliTranscriber,
  resolveWinGetBinary,
  audioDevices,
  transcribe,
  SAMPLE_RATE,
  pcmFromAudio,
} from "../src/listen.js";
import { fakeSpawner, respondToRequests, settle } from "./helpers/proc.js";

// Real ffmpeg output, trimmed. Video devices are listed the same way, which is
// the whole reason this needs parsing rather than a regex over quotes.
const FFMPEG_DEVICES = `
[dshow @ 000001] "HD Webcam" (video)
[dshow @ 000001]   Alternative name "@device_pnp_\\\\?\\usb#vid_1234"
[dshow @ 000001] "Microphone Array (Intel® Smart Sound Technology for Digital Microphones)" (audio)
[dshow @ 000001]   Alternative name "@device_cm_{33D9A762}\\wave_{9B365890}"
[dshow @ 000001] "Line In (Realtek Audio)" (audio)
dummy: Immediate exit requested
`;

describe("parseAudioDevices", () => {
  test("returns audio devices only, not the webcam", () => {
    assert.deepEqual(parseAudioDevices(FFMPEG_DEVICES), [
      "Microphone Array (Intel® Smart Sound Technology for Digital Microphones)",
      "Line In (Realtek Audio)",
    ]);
  });

  test("keeps non-ASCII in the name, which has to match exactly", () => {
    assert.ok(parseAudioDevices(FFMPEG_DEVICES)[0].includes("®"));
  });

  test("ignores the alternative-name lines", () => {
    assert.equal(
      parseAudioDevices(FFMPEG_DEVICES).filter((d) => d.startsWith("@device")).length,
      0,
    );
  });

  test("returns nothing when there are no devices", () => {
    assert.deepEqual(parseAudioDevices("no devices found"), []);
  });

  test("survives empty output", () => {
    assert.deepEqual(parseAudioDevices(""), []);
  });
});

describe("pickDevice", () => {
  const devices = ["Line In (Realtek Audio)", "Microphone Array (Intel)", "Stereo Mix"];

  test("takes an exact match first", () => {
    assert.equal(pickDevice(devices, "Stereo Mix"), "Stereo Mix");
  });

  test("falls back to a partial match, case insensitively", () => {
    assert.equal(pickDevice(devices, "microphone array"), "Microphone Array (Intel)");
  });

  test("prefers something that sounds like a microphone", () => {
    assert.equal(pickDevice(devices), "Microphone Array (Intel)");
  });

  test("takes the first device when nothing looks like a mic", () => {
    assert.equal(pickDevice(["Stereo Mix", "What U Hear"]), "Stereo Mix");
  });

  test("returns null when there is nothing to pick", () => {
    assert.equal(pickDevice([]), null);
  });

  test("ignores a preference that matches nothing", () => {
    assert.equal(pickDevice(devices, "usb headset"), "Microphone Array (Intel)");
  });
});

/** A run of samples at a given amplitude, as the mic would deliver them. */
const tone = (amplitude: number, count = 200): Buffer => {
  const pcm = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    pcm.writeInt16LE(Math.round(amplitude * Math.sin((i / 16) * Math.PI * 2)), i * 2);
  }
  return pcm;
};

describe("levelDb", () => {
  test("reads full scale as roughly 0 dB", () => {
    assert.ok(levelDb(tone(32767)) > -4);
  });

  test("reads a quiet capture as far below it", () => {
    // What his microphone array actually delivers.
    assert.ok(levelDb(tone(120)) < -45);
  });

  test("calls digital silence silence", () => {
    assert.equal(levelDb(Buffer.alloc(64)), -Infinity);
    assert.equal(levelDb(Buffer.alloc(0)), -Infinity);
  });
});

describe("normalise", () => {
  test("lifts a quiet capture towards full scale", () => {
    // Measured: speech arrives at about -49 dBFS, a hundredth of what whisper
    // is trained on, which leaves the decoder working at its floor.
    const quiet = tone(1000);
    assert.ok(levelDb(normalise(quiet)) > levelDb(quiet) + 15);
  });

  test("leaves a healthy capture alone rather than squashing it", () => {
    const loud = tone(30000);
    assert.deepEqual(normalise(loud), loud);
  });

  test("won't amplify an empty room into something that sounds like speech", () => {
    const hiss = tone(20);
    const gained = levelDb(normalise(hiss)) - levelDb(hiss);
    assert.ok(gained <= 21.6, `capped the gain, got ${gained.toFixed(1)} dB`);
  });

  test("leaves pure silence exactly as it was", () => {
    const silence = Buffer.alloc(64);
    assert.deepEqual(normalise(silence), silence);
  });

  test("survives having recorded nothing", () => {
    assert.equal(normalise(Buffer.alloc(0)).length, 0);
  });

  test("clamps instead of wrapping, because a wrapped sample is a click", () => {
    const pcm = Buffer.alloc(4);
    pcm.writeInt16LE(20000, 0);
    pcm.writeInt16LE(-20000, 2);
    const out = normalise(pcm);
    assert.ok(out.readInt16LE(0) <= 32767 && out.readInt16LE(0) > 0);
    assert.ok(out.readInt16LE(2) >= -32768 && out.readInt16LE(2) < 0);
  });
});

describe("wavFromPcm", () => {
  // The mic now hands back raw samples, so this header is the only thing
  // standing between them and a whisper that reads them as garbage.
  const pcm = Buffer.alloc(320); // 10ms at 16 kHz
  const wav = wavFromPcm(pcm);
  const at = (offset: number) => wav.toString("ascii", offset, offset + 4);

  test("declares itself a wav", () => {
    assert.equal(at(0), "RIFF");
    assert.equal(at(8), "WAVE");
    assert.equal(at(36), "data");
  });

  test("describes the format both ffmpeg and whisper are using", () => {
    assert.equal(wav.readUInt16LE(20), 1, "uncompressed PCM");
    assert.equal(wav.readUInt16LE(22), 1, "mono");
    assert.equal(wav.readUInt32LE(24), SAMPLE_RATE);
    assert.equal(wav.readUInt16LE(34), 16, "bits per sample");
  });

  test("gets the derived byte rates right", () => {
    assert.equal(wav.readUInt32LE(28), SAMPLE_RATE * 2, "bytes per second");
    assert.equal(wav.readUInt16LE(32), 2, "bytes per frame");
  });

  test("states both lengths, which is what a truncated file gets wrong", () => {
    assert.equal(wav.readUInt32LE(4), 36 + pcm.length, "RIFF size");
    assert.equal(wav.readUInt32LE(40), pcm.length, "data size");
    assert.equal(wav.length, 44 + pcm.length);
  });

  test("keeps the samples byte for byte", () => {
    const speech = Buffer.from([0x11, 0x22, 0x33, 0x44]);
    assert.deepEqual(wavFromPcm(speech).subarray(44), speech);
  });

  test("survives having recorded nothing", () => {
    assert.equal(wavFromPcm(Buffer.alloc(0)).length, 44);
  });
});

describe("audioDevices", () => {
  test("reads the list off stderr even when ffmpeg exits cleanly", async () => {
    const run = async () => ({ stdout: "", stderr: FFMPEG_DEVICES });
    assert.equal((await audioDevices("ffmpeg", run)).length, 2);
  });

  test("reads it off stderr when ffmpeg exits non-zero, which older builds do", async () => {
    // The dummy input always fails on some versions; the device list is still
    // the thing we came for.
    const run = async () => {
      throw Object.assign(new Error("exit 1"), { stderr: FFMPEG_DEVICES });
    };
    assert.equal((await audioDevices("ffmpeg", run)).length, 2);
  });

  test("returns nothing rather than throwing when ffmpeg says nothing at all", async () => {
    const run = async () => {
      throw new Error("ENOENT");
    };
    assert.deepEqual(await audioDevices("ffmpeg", run), []);
  });
});

describe("startRecording", () => {
  test("asks ffmpeg for raw mono samples at whisper's rate", () => {
    const fake = fakeSpawner();
    startRecording("Microphone Array", { ffmpeg: "ffmpeg.exe", spawn: fake.spawn });

    const { args, flag } = fake.last();
    assert.equal(flag("-i"), "audio=Microphone Array");
    assert.equal(flag("-ar"), String(SAMPLE_RATE));
    assert.equal(flag("-ac"), "1");
    // Raw down a pipe, so there's no header to finalise and no wait for the
    // capture device to close politely.
    assert.ok(args.includes("pipe:1"), "a file on disk costs 1.2s to stop");
    assert.ok(args.includes("s16le"));
  });

  test("hands back everything that came down the pipe", async () => {
    const fake = fakeSpawner();
    const recorder = startRecording("mic", { spawn: fake.spawn });

    fake.last().proc.stdout.write(Buffer.from([1, 2]));
    fake.last().proc.stdout.write(Buffer.from([3, 4]));
    await settle();

    assert.deepEqual(await recorder.stop(), Buffer.from([1, 2, 3, 4]));
  });

  test("asks ffmpeg to quit before killing it, so the last syllable survives", async () => {
    const fake = fakeSpawner();
    const recorder = startRecording("mic", { spawn: fake.spawn });
    await recorder.stop();

    assert.equal(fake.last().proc.written.toString("utf8"), "q");
    assert.equal(fake.last().proc.killed, true, "the rest of its exit is device teardown");
  });

  test("isn't ready until samples are actually arriving", async () => {
    // dshow takes ~1.3s to open the device. Telling him to talk before then is
    // how the first word of a sentence stops existing.
    const fake = fakeSpawner();
    const recorder = startRecording("mic", { spawn: fake.spawn });
    let ready = false;
    void recorder.ready.then(() => (ready = true));

    await settle();
    assert.equal(ready, false, "nothing has come off the device yet");

    fake.last().proc.stdout.write(Buffer.from([1, 2]));
    await settle();
    assert.equal(ready, true);
  });

  test("gives up waiting when the microphone never opens", async () => {
    const fake = fakeSpawner(({ proc }) => setImmediate(() => proc.fail("ENOENT")));
    const recorder = startRecording("mic", { spawn: fake.spawn });
    // Must not hang forever on a device that isn't coming.
    await recorder.ready;
  });

  test("returns nothing when the microphone produced nothing", async () => {
    const fake = fakeSpawner();
    const recorder = startRecording("mic", { spawn: fake.spawn });
    assert.equal((await recorder.stop()).length, 0);
  });

  test("a microphone that won't open doesn't take the process down", async () => {
    const fake = fakeSpawner(({ proc }) => setImmediate(() => proc.fail("ENOENT")));
    const recorder = startRecording("mic", { spawn: fake.spawn });
    await settle();
    assert.equal((await recorder.stop()).length, 0);
  });
});

describe("createTranscriber", () => {
  const harness = (reply: (request: Record<string, string>) => string | undefined) => {
    const problems: string[] = [];
    const fake = fakeSpawner(({ proc }) => respondToRequests(proc, reply));
    const ears = createTranscriber({
      python: "python.exe",
      worker: "whisper_worker.py",
      model: "base.en",
      computeDevice: "cpu",
      spawn: fake.spawn,
      onProblem: (why) => problems.push(why),
    });
    return { ears, problems, worker: () => fake.spawned[0] };
  };

  const heard = (text: string) => () => `ok ${JSON.stringify({ text })}`;

  /** What the worker really sends back: the text and how sure it was. */
  const scored = (text: string, silence: number, logprob: number) => () =>
    `ok ${JSON.stringify({ text, silence, logprob })}`;

  test("a sentence the decoder scored as silence never reaches the caller", async () => {
    const dropped: string[] = [];
    const fake = fakeSpawner(({ proc }) =>
      respondToRequests(proc, scored("Vela, run doggy run doggy.", 0.93, -0.4)),
    );
    const ears = createTranscriber({
      python: "python.exe",
      worker: "whisper_worker.py",
      spawn: fake.spawn,
      onDropped: (h) => dropped.push(h.text),
    });
    assert.equal(await ears.hear(Buffer.alloc(320)), "", "nobody said this");
    assert.deepEqual(
      dropped,
      ["Vela, run doggy run doggy."],
      "a bar nobody can see is a bar he cannot move",
    );
    ears.stop();
  });

  test("an open microphone decodes with no prior, so whisper cannot be led", async () => {
    const asked: Record<string, unknown>[] = [];
    const fake = fakeSpawner(({ proc }) =>
      respondToRequests(proc, (request) => {
        asked.push(request);
        return heard("vela")();
      }),
    );
    const ears = createTranscriber({
      python: "python.exe",
      worker: "whisper_worker.py",
      vocabulary: "Vela, Kokoro, ffmpeg",
      spawn: fake.spawn,
    });
    await ears.hear(Buffer.alloc(320), UNPROMPTED);
    assert.equal(
      asked[0].prompt,
      "",
      "priming the decoder with her name is what made it write her name from noise",
    );
    ears.stop();
  });

  test("a caller that says nothing about the prior keeps the worker's own", async () => {
    const asked: Record<string, unknown>[] = [];
    const fake = fakeSpawner(({ proc }) =>
      respondToRequests(proc, (request) => {
        asked.push(request);
        return heard("open the fantasy project")();
      }),
    );
    const ears = createTranscriber({
      python: "python.exe",
      worker: "whisper_worker.py",
      vocabulary: "Vela, Kokoro, ffmpeg",
      spawn: fake.spawn,
    });
    await ears.hear(Buffer.alloc(320), HEARD_ANYTHING);
    assert.equal(
      "prompt" in asked[0],
      false,
      "push-to-talk still wants the vocabulary, which is worth 2.5 points of error",
    );
    ears.stop();
  });

  test("the same utterance survives when the caller says a key was held", async () => {
    const fake = fakeSpawner(({ proc }) =>
      respondToRequests(proc, scored("open the fantasy project", 0.93, -0.4)),
    );
    const ears = createTranscriber({
      python: "python.exe",
      worker: "whisper_worker.py",
      spawn: fake.spawn,
    });
    assert.equal(
      await ears.hear(Buffer.alloc(320), HEARD_ANYTHING),
      "open the fantasy project",
      "push-to-talk already knows speech happened, so the bar is the wrong tool",
    );
    ears.stop();
  });

  test("starts the worker on the model and device it was given", () => {
    const fake = fakeSpawner();
    createTranscriber({
      python: "python.exe",
      worker: "whisper_worker.py",
      model: "small.en",
      computeDevice: "cuda",
      spawn: fake.spawn,
    });
    assert.deepEqual(fake.last().args, ["whisper_worker.py", "small.en", "cuda", ""]);
  });

  test("passes the vocabulary through, which is worth more than a bigger model", () => {
    // Measured on his own words: biasing the decoder took base.en from 9.8% to
    // 7.3% word error, which is what small.en scores at three times the cost.
    const fake = fakeSpawner();
    createTranscriber({
      python: "python.exe",
      worker: "whisper_worker.py",
      vocabulary: "Vela, Yousef, Kokoro.",
      spawn: fake.spawn,
    });
    assert.equal(fake.last().args[3], "Vela, Yousef, Kokoro.");
  });

  test("returns what the worker heard", async () => {
    const h = harness(heard("open the fantasy project"));
    assert.equal(await h.ears.hear(Buffer.from([1, 2, 3, 4])), "open the fantasy project");
    h.ears.stop();
  });

  test("tells the worker where the samples are and at what rate", async () => {
    let seen: Record<string, string> = {};
    const h = harness((request) => {
      seen = request;
      return `ok ${JSON.stringify({ text: "hello" })}`;
    });
    await h.ears.hear(Buffer.from([1, 2, 3, 4]));

    assert.equal(Number(seen.rate), SAMPLE_RATE);
    assert.ok(seen.pcm, "the worker needs a file to read");
    h.ears.stop();
  });

  test("drops what whisper hallucinates out of room tone", async () => {
    // Same guard the CLI path has: a stray Enter must not send a phantom turn.
    const h = harness(heard("Thank you."));
    assert.equal(await h.ears.hear(Buffer.from([1, 2, 3, 4])), "");
    h.ears.stop();
  });

  test("keeps a real sentence that happens to start with thanks", async () => {
    const h = harness(heard("thanks, now open chrome"));
    assert.equal(await h.ears.hear(Buffer.from([1, 2, 3, 4])), "thanks, now open chrome");
    h.ears.stop();
  });

  test("ignores the loader's chatter on the protocol channel", async () => {
    const h = harness(heard("open chrome"));
    h.worker().proc.say("Model was trained with torch 1.10");
    assert.equal(await h.ears.hear(Buffer.from([1, 2, 3, 4])), "open chrome");
    h.ears.stop();
  });

  describe("lazily", () => {
    const lazyHarness = (reply: (request: Record<string, string>) => string | undefined) => {
      const fake = fakeSpawner(({ proc }) => respondToRequests(proc, reply));
      const ears = createTranscriber({
        python: "python.exe",
        worker: "whisper_worker.py",
        lazy: true,
        spawn: fake.spawn,
      });
      return { ears, fake };
    };

    test("costs nothing until something is actually said", () => {
      // She runs from boot now. A hub nobody has spoken into must not hold
      // 226MB of resident whisper all day waiting for a microphone press.
      const { fake } = lazyHarness(() => "ok {}");
      assert.equal(fake.spawned.length, 0, "an unused microphone must not load a model");
    });

    test("starts the worker on the first utterance, and returns what it heard", async () => {
      const { ears, fake } = lazyHarness(heard("open the fantasy project"));
      assert.equal(await ears.hear(Buffer.from([1, 2, 3, 4])), "open the fantasy project");
      assert.equal(fake.spawned.length, 1);
      assert.deepEqual(fake.last().args, ["whisper_worker.py", "base.en", "cpu", ""]);
      ears.stop();
    });

    test("stays warm after that, rather than reloading per utterance", async () => {
      // The whole reason the worker exists: 1.4s cold against 0.4s warm.
      const { ears, fake } = lazyHarness(heard("again"));
      await ears.hear(Buffer.from([1, 2, 3, 4]));
      await ears.hear(Buffer.from([5, 6, 7, 8]));
      assert.equal(fake.spawned.length, 1, "a second spawn would pay the model load twice");
      ears.stop();
    });

    test("can be warmed while he is still talking, so the load costs nothing", () => {
      // The hub calls this when recording starts. Opening the microphone and
      // saying a sentence takes seconds; the model loads inside that.
      const { ears, fake } = lazyHarness(heard("ready"));
      ears.warm();
      assert.equal(fake.spawned.length, 1);
      ears.stop();
    });

    test("warming twice is not two workers", () => {
      const { ears, fake } = lazyHarness(heard("ready"));
      ears.warm();
      ears.warm();
      assert.equal(fake.spawned.length, 1);
      ears.stop();
    });

    test("warming after stopping starts nothing", () => {
      const { ears, fake } = lazyHarness(heard("ready"));
      ears.stop();
      ears.warm();
      assert.equal(fake.spawned.length, 0, "a stopped service must stay stopped");
    });

    test("stopping before anything was said starts nothing", () => {
      const { ears, fake } = lazyHarness(() => "ok {}");
      ears.stop();
      assert.equal(fake.spawned.length, 0);
    });

    test("stopping ends the worker it did start", async () => {
      const { ears, fake } = lazyHarness(heard("hello"));
      await ears.hear(Buffer.from([1, 2, 3, 4]));
      ears.stop();
      assert.equal(fake.last().proc.killed, true, "a stopped service must not leave whisper resident");
    });

    test("says nothing more after being stopped", async () => {
      const { ears } = lazyHarness(heard("too late"));
      ears.stop();
      assert.equal(await ears.hear(Buffer.from([1, 2, 3, 4])), "");
    });

    test("silence is not worth starting a model for", async () => {
      const { ears, fake } = lazyHarness(heard("nothing"));
      assert.equal(await ears.hear(Buffer.alloc(0)), "");
      assert.equal(fake.spawned.length, 0, "an empty recording must not load whisper");
      ears.stop();
    });
  });

  test("defaults to base.en on cpu when it wasn't told otherwise", () => {
    const fake = fakeSpawner();
    createTranscriber({ python: "python.exe", worker: "whisper_worker.py", spawn: fake.spawn });
    assert.deepEqual(fake.last().args, ["whisper_worker.py", "base.en", "cpu", ""]);
  });

  test("treats a reply with no text as having heard nothing", async () => {
    const h = harness(() => "ok {}");
    assert.equal(await h.ears.hear(Buffer.from([1, 2, 3, 4])), "");
    h.ears.stop();
  });

  test("says why when the worker fails, rather than looking deaf", async () => {
    const h = harness(() => "err model not found");
    assert.equal(await h.ears.hear(Buffer.from([1, 2, 3, 4])), "");
    assert.match(h.problems[0] ?? "", /model not found/);
    h.ears.stop();
  });

  /** Wait on the thing rather than a tick count. */
  const until = async (check: () => boolean, what: string) => {
    for (let i = 0; i < 200; i++) {
      if (check()) return;
      await new Promise((r) => setImmediate(r));
    }
    assert.fail(`timed out waiting for ${what}`);
  };

  /**
   * A worker whose replies the test writes by hand, by request id, in any
   * order it likes, so what arrives when can be the thing under test.
   */
  const byHand = () => {
    const fake = fakeSpawner();
    const problems: string[] = [];
    const ears = createTranscriber({
      python: "python.exe",
      worker: "whisper_worker.py",
      spawn: fake.spawn,
      onProblem: (why) => problems.push(why),
    });
    const proc = () => fake.last().proc;
    const ids = () => proc().lines.map((l) => (JSON.parse(l) as { id: number }).id);
    const reply = (id: number, text: string) => proc().say(`ok ${JSON.stringify({ id, text })}`);
    return { ears, problems, proc, ids, reply };
  };

  test("garbage on the channel is nobody's reply, so it never becomes a transcript", async () => {
    // This was "survives a reply that isn't JSON", with the garbage standing
    // in as the reply. With replies matched by id a line naming no request is
    // not a reply to anything; the request waits for its own.
    const h = byHand();
    const said = h.ears.hear(Buffer.from([1, 2, 3, 4]));
    await until(() => h.ids().length === 1, "the request");
    h.proc().say("ok not json at all");
    h.reply(h.ids()[0], "open chrome");
    assert.equal(await said, "open chrome");
    h.ears.stop();
  });

  test("replies find their own sentence by id, whatever order they arrive in", async () => {
    const h = byHand();
    const first = h.ears.hear(Buffer.from([1, 2, 3, 4]));
    const second = h.ears.hear(Buffer.from([5, 6, 7, 8]));
    await until(() => h.ids().length === 2, "both requests");
    const [a, b] = h.ids();
    h.reply(b, "and the second");
    h.reply(a, "the first thing");
    assert.deepEqual([await first, await second], ["the first thing", "and the second"]);
    h.ears.stop();
  });

  test("an error printed at startup is not taken as the answer to the first thing he says", async () => {
    // By position it was: the worker's warm-up failure line answered his
    // first sentence, and every sentence after got the transcript of the one
    // before it.
    const h = byHand();
    const said = h.ears.hear(Buffer.from([1, 2, 3, 4]));
    await until(() => h.ids().length === 1, "the request");
    h.proc().say("err warm-up failed: out of memory");
    h.reply(h.ids()[0], "what time is it");
    assert.equal(await said, "what time is it");
    assert.match(h.problems.join(" "), /warm-up failed/, "and it is still said, not swallowed");
    h.ears.stop();
  });

  test("a sentence given up on cannot have its late reply land on the next one", async (t) => {
    // The failure the ids exist for. A read that timed out stayed in the
    // queue, so when its answer finally came it was handed to the sentence
    // after, as what he said.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const h = byHand();
    const lost = h.ears.hear(Buffer.from([1, 2, 3, 4]));
    await until(() => h.ids().length === 1, "the first request");
    t.mock.timers.tick(120_000);
    assert.equal(await lost, "");
    const next = h.ears.hear(Buffer.from([5, 6, 7, 8]));
    await until(() => h.ids().length === 2, "the second request");
    const [late, mine] = h.ids();
    // In this order, by position, his reply went to the dead request and the
    // stale one, arriving after, became what he said.
    h.reply(mine, "the sentence he just said");
    h.reply(late, "the stale sentence");
    assert.equal(await next, "the sentence he just said");
    h.ears.stop();
  });

  test("doesn't trouble the worker when nothing was recorded", async () => {
    const h = harness(heard("something"));
    assert.equal(await h.ears.hear(Buffer.alloc(0)), "");
    assert.equal(h.worker().proc.lines.length, 0);
    h.ears.stop();
  });

  test("hears nothing after stop", async () => {
    const h = harness(heard("open chrome"));
    h.ears.stop();
    assert.equal(await h.ears.hear(Buffer.from([1, 2, 3, 4])), "");
    assert.equal(h.worker().proc.killed, true);
  });
});

describe("cliTranscriber", () => {
  // The fallback for machines without a Python that can import faster_whisper.
  // It pays a model load per utterance, so it must at least be correct.
  test("wraps the raw samples in a wav, which is all the CLI will read", async () => {
    let given = "";
    const run = async (_cmd: string, args: string[]) => {
      given = args[0];
      return { stdout: "", stderr: "" };
    };
    const ears = cliTranscriber({ run });
    await ears.hear(Buffer.from([1, 2, 3, 4]));

    assert.match(given, /\.wav$/, "whisper-ctranslate2 won't read raw samples");
    ears.stop();
  });

  test("returns what whisper wrote next to the wav", async () => {
    const run = async (_cmd: string, args: string[]) => {
      // The CLI writes <name>.txt into --output_dir.
      const dir = args[args.indexOf("--output_dir") + 1];
      writeFileSync(join(dir, "0.txt"), "open the fantasy project\n");
      return { stdout: "", stderr: "" };
    };
    const ears = cliTranscriber({ run });
    assert.equal(await ears.hear(Buffer.from([1, 2, 3, 4])), "open the fantasy project");
    ears.stop();
  });

  test("doesn't run whisper at all when nothing was recorded", async () => {
    let ran = false;
    const run = async () => {
      ran = true;
      return { stdout: "", stderr: "" };
    };
    const ears = cliTranscriber({ run });
    assert.equal(await ears.hear(Buffer.alloc(0)), "");
    assert.equal(ran, false);
    ears.stop();
  });

  test("warming it does nothing, because this path has nothing to keep", async () => {
    // It reloads the model per utterance by design, so the hub's warm call
    // must be harmless here rather than an error the service has to guard.
    let ran = false;
    const run = async () => {
      ran = true;
      return { stdout: "", stderr: "" };
    };
    const ears = cliTranscriber({ run });
    assert.doesNotThrow(() => ears.warm());
    assert.equal(ran, false);
    ears.stop();
  });
});

describe("resolveWinGetBinary", () => {
  // winget adds ffmpeg to PATH, but existing shells don't see it until they
  // restart — which turns "push-to-talk does nothing" into a mystery.
  let root: string;
  const saved = process.env.LOCALAPPDATA;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "vela-winget-"));
    process.env.LOCALAPPDATA = root;
  });

  after(() => {
    process.env.LOCALAPPDATA = saved;
    rmSync(root, { recursive: true, force: true });
  });

  test("takes a bare name on trust, since PATH will resolve it", () => {
    assert.equal(resolveWinGetBinary("ffmpeg", "ffmpeg"), "ffmpeg");
  });

  test("rejects a full path that isn't there, rather than failing later", () => {
    assert.equal(resolveWinGetBinary("ffmpeg", join(root, "nope", "ffmpeg.exe")), null);
  });

  test("accepts a full path that is", () => {
    const exe = join(root, "custom.exe");
    writeFileSync(exe, "");
    assert.equal(resolveWinGetBinary("ffmpeg", exe), exe);
  });

  test("returns null when winget has nothing installed", () => {
    assert.equal(resolveWinGetBinary("ffmpeg"), null);
  });

  test("finds it inside the package directory when the link isn't there", () => {
    const bin = join(root, "Microsoft", "WinGet", "Packages", "Gyan.FFmpeg_x", "build-9.0", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "ffmpeg.exe"), "");
    assert.equal(resolveWinGetBinary("ffmpeg"), join(bin, "ffmpeg.exe"));
  });

  test("prefers the links directory, which is the stable path", () => {
    const links = join(root, "Microsoft", "WinGet", "Links");
    mkdirSync(links, { recursive: true });
    writeFileSync(join(links, "ffmpeg.exe"), "");
    assert.equal(resolveWinGetBinary("ffmpeg"), join(links, "ffmpeg.exe"));
  });
});

describe("transcribe", () => {
  test("asks the CLI for plain text next to the wav it was given", async () => {
    let seen: string[] = [];
    const run = async (_cmd: string, args: string[]) => {
      seen = args;
      return { stdout: "", stderr: "" };
    };
    // No .txt appears, so this returns empty — the point is the request.
    await transcribe("C:/tmp/take.wav", { run, model: "small.en", computeDevice: "cuda" });

    assert.equal(seen[seen.indexOf("--model") + 1], "small.en");
    assert.equal(seen[seen.indexOf("--device") + 1], "cuda");
    assert.equal(seen[seen.indexOf("--output_format") + 1], "txt");
  });

  test("returns nothing when whisper wrote no transcript", async () => {
    const run = async () => ({ stdout: "", stderr: "" });
    assert.equal(await transcribe("C:/tmp/take.wav", { run }), "");
  });
});

describe("cleanTranscript", () => {
  test("keeps real speech", () => {
    assert.equal(cleanTranscript(" open netflix please \n"), "open netflix please");
  });

  test("drops whisper's silence markers", () => {
    assert.equal(cleanTranscript("[BLANK_AUDIO]"), "");
    assert.equal(cleanTranscript("[INAUDIBLE]"), "");
  });

  test("strips a marker embedded in real speech", () => {
    assert.equal(cleanTranscript("open [NOISE] netflix"), "open netflix");
  });

  test("drops a sound description on its own line", () => {
    assert.equal(cleanTranscript("(upbeat music)"), "");
  });

  test("treats whisper's near-silence hallucinations as nothing said", () => {
    // These are what it emits for a second of room tone.
    for (const noise of ["you", "You.", "Thank you.", "thanks", "Bye.", ".", ""]) {
      assert.equal(cleanTranscript(noise), "", `should have ignored ${JSON.stringify(noise)}`);
    }
  });

  test("does not swallow a real sentence that starts with thanks", () => {
    assert.equal(cleanTranscript("thanks for that, now open chrome"), "thanks for that, now open chrome");
  });

  test("collapses whisper's line wrapping", () => {
    assert.equal(cleanTranscript("open the\nfantasy project"), "open the fantasy project");
  });
});

describe("saidSomething", () => {
  // The numbers here are what faster-whisper actually reports: real close-mic
  // speech through base.en sits near no_speech_prob 0.02 and avg_logprob -0.3,
  // and audio it is confident was silence comes back near 0.9.
  const speech = { text: "open the fantasy project", silence: 0.02, logprob: -0.31 };

  test("keeps speech the decoder was sure about", () => {
    assert.equal(saidSomething(speech), true);
  });

  test("drops a fluent sentence the decoder thinks was silence", () => {
    // This is the failure the whole change exists for. cleanTranscript cannot
    // catch it: the text is novel, grammatical, and indistinguishable from a
    // real instruction. Only the numbers know nobody said it.
    assert.equal(saidSomething({ text: "Vela, run doggy run doggy.", silence: 0.91, logprob: -0.4 }), false);
  });

  test("drops words the decoder barely believed in", () => {
    // Confident it was speech, unsure what the speech was. Gibberish scores
    // here rather than on no_speech_prob.
    assert.equal(saidSomething({ text: "zabatongshu", silence: 0.2, logprob: -2.4 }), false);
  });

  test("lets a transcript with no numbers through", () => {
    // The CLI fallback reports neither. Missing evidence is not evidence of
    // silence — dropping every utterance on that path would make the fallback
    // deaf rather than slow.
    assert.equal(saidSomething({ text: "open chrome" }), true);
  });

  test("says nothing was said when there is no text", () => {
    assert.equal(saidSomething({ text: "", silence: 0.01, logprob: -0.2 }), false);
  });

  test("takes the caller's bar rather than the default", () => {
    // Because the right threshold is a property of his room and his
    // microphone, and he is going to have to move it.
    assert.equal(saidSomething(speech, { maxSilence: 0.01 }), false);
    assert.equal(saidSomething({ ...speech, silence: 0.8 }, { maxSilence: 0.9 }), true);
  });
});

describe("saidSomething, told to let everything through", () => {
  test("a held key is not judged by the wake word's bar", () => {
    // Push-to-talk is a promise that speech happened. The same quiet sentence
    // the wake word is right to doubt is the one the terminal must not lose.
    const quiet = { text: "open the fantasy project", silence: 0.94, logprob: -2.8 };
    assert.equal(saidSomething(quiet), false, "the wake word is right to drop this");
    assert.equal(
      saidSomething(quiet, HEARD_ANYTHING),
      true,
      "he pressed a key and spoke; losing it costs him the sentence",
    );
  });

  test("it still takes nothing for something", () => {
    assert.equal(
      saidSomething({ text: "" }, HEARD_ANYTHING),
      false,
      "an empty transcript is empty however generous the bar is",
    );
  });
});

describe("pcmFromAudio", () => {
  test("asks ffmpeg for exactly what the warm worker takes", async () => {
    const fake = fakeSpawner((s) => setImmediate(() => s.proc.close()));
    await pcmFromAudio(Buffer.from("webm"), { ffmpeg: "ffmpeg", spawn: fake.spawn });

    const { flag, args } = fake.last();
    assert.equal(flag("-ar"), "16000", "whisper is trained at 16 kHz");
    assert.equal(flag("-ac"), "1", "and on mono");
    assert.equal(flag("-f"), "s16le");
    assert.ok(args.includes("pipe:0") && args.includes("pipe:1"), "nothing touches the disk");
  });

  test("hands the recording down the pipe rather than writing a file", async () => {
    const fake = fakeSpawner((s) => setImmediate(() => s.proc.close()));
    const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
    await pcmFromAudio(audio, { spawn: fake.spawn });
    assert.deepEqual(fake.last().proc.written, audio);
  });

  test("a conversion that fails is silence, which reads as 'didn't catch that'", async () => {
    const fake = fakeSpawner((s) => setImmediate(() => s.proc.emit("error", new Error("ENOENT"))));
    assert.equal((await pcmFromAudio(Buffer.from("x"), { spawn: fake.spawn })).length, 0);
  });
});

describe("captureArgs", () => {
  test("asks for exactly what whisper reads: mono, 16 kHz, signed 16-bit", () => {
    const args = captureArgs("Microphone Array");
    assert.equal(args[args.indexOf("-ac") + 1], "1");
    assert.equal(args[args.indexOf("-ar") + 1], String(SAMPLE_RATE));
    assert.equal(args[args.indexOf("-f", args.indexOf("-ar")) + 1], "s16le");
  });

  test("the device name goes in whole, because dshow matches it exactly", () => {
    const args = captureArgs("Microphone Array (Intel® Smart Sound)");
    assert.equal(args[args.indexOf("-i") + 1], "audio=Microphone Array (Intel® Smart Sound)");
  });
});

describe("openMic", () => {
  test("hands over chunks as they arrive rather than at the end", async () => {
    const fake = fakeSpawner();
    const chunks: Buffer[] = [];
    const mic = openMic("mic", { spawn: fake.spawn, onAudio: (c) => chunks.push(c) });

    fake.last().proc.stdout.write(Buffer.from([1, 2]));
    await settle();
    // Nothing has stopped, so a recorder would still be holding all of this.
    assert.equal(chunks.length, 1, "a wake word cannot wait for the end of an utterance");
    mic.close();
  });

  test("ready waits for samples, not for the process, because dshow takes ~1.3s to open", async () => {
    const fake = fakeSpawner();
    let capturing = false;
    const mic = openMic("mic", { spawn: fake.spawn, onAudio: () => {} });
    void mic.ready.then(() => (capturing = true));

    await settle();
    assert.equal(capturing, false, "spawned is not the same as listening");
    fake.last().proc.stdout.write(Buffer.from([1, 2]));
    await settle();
    assert.equal(capturing, true);
    mic.close();
  });

  test("a device pulled out of the socket reports the end once, not twice", async () => {
    const fake = fakeSpawner();
    const ends: string[] = [];
    openMic("mic", { spawn: fake.spawn, onAudio: () => {}, onEnd: (why) => ends.push(why) });

    // Real ffmpeg fires both when the device disappears.
    fake.last().proc.fail("I/O error");
    fake.last().proc.close();
    await settle();
    assert.equal(ends.length, 1, "a caller that reopens per event opens two microphones");
  });

  test("closing it is not an end, because the caller asked for it", async () => {
    const fake = fakeSpawner();
    const ends: string[] = [];
    const mic = openMic("mic", { spawn: fake.spawn, onAudio: () => {}, onEnd: (why) => ends.push(why) });

    mic.close();
    await settle();
    assert.equal(ends.length, 0, "a listener that reopens on its own shutdown never shuts down");
    assert.equal(fake.last().proc.killed, true);
  });

  test("ready resolves even if the microphone never opens at all", async () => {
    const fake = fakeSpawner();
    const mic = openMic("mic", { spawn: fake.spawn, onAudio: () => {} });
    fake.last().proc.fail("no such device");
    // A caller waiting on a device that will never open waits forever.
    await mic.ready;
    mic.close();
  });
});

describe("wakePrior", () => {
  /**
   * The default has to stay no-prior. Priming the decoder with her name is what
   * made a quiet room produce "For a second, Kokoro", and the wake word is the
   * one caller that cannot promise anyone spoke.
   */
  test("no vocabulary is UNPROMPTED, not a missing prompt", () => {
    assert.equal(wakePrior("").vocabulary, "");
    assert.deepEqual(wakePrior(""), UNPROMPTED);
  });

  /**
   * "" and undefined mean opposite things on the wire: the worker reads an
   * absent prompt as "use your startup vocabulary" and an empty one as "no
   * prior at all". Returning undefined here would hand the wake word the very
   * list it was taken off.
   */
  test("never leaves the prompt absent, which the worker reads as the vocabulary", () => {
    assert.notEqual(wakePrior("").vocabulary, undefined);
  });

  /** Her name alone, when base.en cannot otherwise produce it. */
  test("passes a prior through when this microphone needs one", () => {
    assert.deepEqual(wakePrior("Vela."), { vocabulary: "Vela." });
  });
});

/**
 * The failure a prompt causes, which the confidence numbers cannot see.
 *
 * `maxSilence` and `minLogprob` describe the audio, which is what lets them
 * judge a sentence nobody has said before. Priming the decoder with a rare
 * word breaks that: it returns the word it was handed, several times over, and
 * scores itself confident because it is repeating rather than inventing. This
 * is what "Vela. Vela. Vela. Vela." out of a film soundtrack looked like.
 */
describe("isStutter", () => {
  test("her name four times out of a soundtrack is not someone saying it", () => {
    assert.equal(isStutter("Vela. Vela. Vela. Vela.", 3), true);
  });

  test("punctuation and case do not hide the repetition", () => {
    assert.equal(isStutter("vela vela VELA!", 3), true);
  });

  /** Two is a real thing to say, so the bar sits above it. */
  test("saying it twice is a person being emphatic", () => {
    assert.equal(isStutter("Vela, Vela", 3), false);
  });

  /**
   * Only when the repetition is the *whole* transcript. A sentence that
   * happens to repeat a word is still a sentence, and throwing it away would
   * cost him the turn.
   */
  test("a real sentence carrying a repeat is left alone", () => {
    assert.equal(isStutter("Vela, Vela, are you there", 3), false);
    assert.equal(isStutter("no no no I meant the other one", 3), false);
  });

  test("a plain sentence is not a stutter", () => {
    assert.equal(isStutter("what is on my calendar today", 3), false);
  });

  test("nothing at all is not a stutter", () => {
    assert.equal(isStutter("", 3), false);
  });

  test("0 turns it off, which is what a held key gets", () => {
    assert.equal(isStutter("Vela. Vela. Vela. Vela.", 0), false);
  });
});

describe("saidSomething, against a confident repetition", () => {
  /**
   * The point of the whole guard: this scores *well*. The decoder was not
   * unsure, it was echoing, so nothing about the audio gives it away.
   */
  test("throws out a repetition that the confidence numbers happily allow", () => {
    const echo = { text: "Vela. Vela. Vela. Vela.", silence: 0.01, logprob: -0.2 };
    assert.equal(saidSomething(echo, { maxSilence: 0.5, minLogprob: -1 }), false);
  });

  test("a held key still gets it, because he promised he spoke", () => {
    const echo = { text: "Vela. Vela. Vela. Vela.", silence: 0.01, logprob: -0.2 };
    assert.equal(saidSomething(echo, HEARD_ANYTHING), true);
  });

  test("a real sentence with good scores is untouched", () => {
    const real = { text: "Vela, what is on my calendar", silence: 0.02, logprob: -0.3 };
    assert.equal(saidSomething(real), true);
  });
});

describe("priming whisper when her name is heard", () => {
  test("the warm-up goes first and its answer is nobody's, so the question still gets its own", async () => {
    // The wake word fires half a second before the utterance around it closes,
    // and that is when the paged-out model is touched. The worker answers in
    // order, one line per request; a warm-up answer taken for the question's
    // would hand her an empty transcript for the thing he actually asked.
    const asked: Record<string, string>[] = [];
    const fake = fakeSpawner(({ proc }) =>
      respondToRequests(proc, (request) => {
        asked.push(request);
        return request.warm ? `ok ${JSON.stringify({ text: "", silence: 1, logprob: 0 })}` : `ok ${JSON.stringify({ text: "what time is it" })}`;
      }),
    );
    const ears = createTranscriber({ python: "python.exe", worker: "whisper_worker.py", spawn: fake.spawn });
    ears.prime();
    const said = await ears.hear(Buffer.alloc(3200, 1));
    assert.equal(said, "what time is it");
    assert.equal(asked[0]?.warm, true as unknown as string, "the page-in was asked for first");
    ears.stop();
  });
});
