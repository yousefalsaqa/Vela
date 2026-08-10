import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  speakable,
  sentences,
  createVoice,
  pcmFromWav,
  pcmPlayer,
  kokoroSpeaker,
  neuralSpeaker,
  windowsSpeaker,
  PRONOUNCE_PHONEMES,
} from "../src/voice.js";
import { wavFromPcm } from "../src/listen.js";
import { fakeSpawner, respondToRequests, settle } from "./helpers/proc.js";

describe("speakable", () => {
  test("replaces a code block rather than reading it out", () => {
    assert.equal(
      speakable("Try this:\n```ts\nconst x = 1;\n```\nthen run it."),
      "Try this: code block. then run it.",
    );
  });

  test("keeps inline code, minus the backticks", () => {
    assert.equal(speakable("run `npm test` now"), "run npm test now");
  });

  test("says a link's label, not its URL", () => {
    assert.equal(speakable("see [the docs](https://example.com/x)"), "see the docs");
  });

  test("collapses a bare URL", () => {
    assert.equal(speakable("go to https://example.com/a/b now"), "go to a link now");
  });

  test("drops markdown emphasis and headers", () => {
    assert.equal(speakable("## Result\n**done** and _ready_"), "Result done and ready");
  });

  test("reads a path as its filename", () => {
    assert.equal(
      speakable("edit C:/Users/Yousef/Desktop/Vela/src/core.ts today"),
      "edit core.ts today",
    );
  });

  test("strips list bullets", () => {
    assert.equal(speakable("- one\n- two"), "one two");
  });

  test("leaves plain prose alone", () => {
    assert.equal(speakable("Build succeeded in 41 seconds."), "Build succeeded in 41 seconds.");
  });

  describe("pronunciation", () => {
    // Left alone, every en-GB voice says "YO-sef". This only affects what's
    // spoken; the printed text keeps the real spelling.
    describe("respelling, for edge-tts and SAPI", () => {
      test("respells his name so it comes out you-sef", () => {
        assert.equal(speakable("Morning, Yousef."), "Morning, Yoosef.");
      });

      test("handles the possessive", () => {
        assert.equal(speakable("that's Yousef's call"), "that's Yoosef's call");
      });

      test("is case insensitive", () => {
        assert.equal(speakable("YOUSEF, look"), "Yoosef, look");
      });

      test("does not touch a word that merely contains it", () => {
        assert.equal(speakable("Yousef_Portfolio is fine"), "Yousef_Portfolio is fine");
      });
    });

    describe("phonemes, for Kokoro", () => {
      const say = (t: string) => speakable(t, PRONOUNCE_PHONEMES);

      test("emits an inline phoneme override", () => {
        assert.equal(say("Morning, Yousef."), "Morning, [Yousef](/jˈuːsəf/).");
      });

      test("handles the possessive without stranding an apostrophe", () => {
        assert.equal(say("Yousef's build"), "[Yousefs](/jˈuːsəfs/) build");
      });

      test("survives the markdown cleanup that would strip it", () => {
        // Pronunciation runs after link-stripping for exactly this reason —
        // applied first, [Yousef](/…/) would be flattened back to "Yousef".
        assert.equal(
          say("see [the docs](https://example.com), Yousef"),
          "see the docs, [Yousef](/jˈuːsəf/)",
        );
      });

      test("leaves other words alone", () => {
        assert.equal(say("the build passed"), "the build passed");
      });
    });
  });
});

describe("sentences", () => {
  test("holds back a sentence that isn't finished", () => {
    assert.deepEqual(sentences("The build is "), { ready: [], rest: "The build is " });
  });

  test("releases one as soon as it completes", () => {
    assert.deepEqual(sentences("Done. And then"), {
      ready: ["Done."],
      rest: "And then",
    });
  });

  test("releases several at once", () => {
    const { ready, rest } = sentences("One. Two! Three? Four");
    assert.deepEqual(ready, ["One.", "Two!", "Three?"]);
    assert.equal(rest, "Four");
  });

  test("treats a blank line as an ending", () => {
    assert.deepEqual(sentences("ok\n\nnext"), { ready: ["ok"], rest: "next" });
  });

  test("does not split on a single newline, which would cut a code block open", () => {
    assert.deepEqual(sentences("```ts\nconst x = 1\n```\n"), {
      ready: [],
      rest: "```ts\nconst x = 1\n```\n",
    });
  });

  test("flush releases the trailing fragment", () => {
    assert.deepEqual(sentences("no final period", true), {
      ready: ["no final period"],
      rest: "",
    });
  });

  test("flush on an empty buffer says nothing", () => {
    assert.deepEqual(sentences("   ", true), { ready: [], rest: "   " });
  });

  test("does not split an ellipsis into three sentences", () => {
    const { ready } = sentences("wait... ok. ");
    assert.deepEqual(ready, ["wait...", "ok."]);
  });

  // A spoken reply is usually one sentence, and one sentence has no space
  // after its full stop. Waiting for flush() meant saying nothing at all until
  // the turn was over, then synthesising from cold.
  test("releases a sentence sitting at the end of the buffer", () => {
    assert.deepEqual(sentences("Yeah, I'm here."), {
      ready: ["Yeah, I'm here."],
      rest: "",
    });
  });

  test("releases the last sentence of several", () => {
    const { ready, rest } = sentences("Renamed it. Tests pass.");
    assert.deepEqual(ready, ["Renamed it.", "Tests pass."]);
    assert.equal(rest, "");
  });

  test("holds a full stop that a number is going to continue", () => {
    assert.deepEqual(sentences("it wants version 2."), {
      ready: [],
      rest: "it wants version 2.",
    });
  });

  test("holds a full stop that belongs to an abbreviation", () => {
    assert.deepEqual(sentences("ask Dr."), { ready: [], rest: "ask Dr." });
  });

  test("holds a bare full stop with no sentence in front of it", () => {
    assert.deepEqual(sentences("..."), { ready: [], rest: "..." });
  });

  test("does not release a line inside an unclosed code fence", () => {
    // Left to itself this ends in a full stop and looks exactly like a
    // finished sentence, which is how speakable() loses the fence around it.
    const open = "```\nprint(hello world.)\n";
    assert.deepEqual(sentences(open), { ready: [], rest: open });
  });

  test("still holds a sentence that hasn't finished", () => {
    assert.deepEqual(sentences("I checked the"), {
      ready: [],
      rest: "I checked the",
    });
  });
});

describe("pcmFromWav", () => {
  const samples = Buffer.from([0x01, 0x00, 0xff, 0x7f, 0x00, 0x80, 0x02, 0x00]);

  test("finds the audio in a plain wav", () => {
    assert.deepEqual(pcmFromWav(wavFromPcm(samples, 24_000)), samples);
  });

  test("finds it after a chunk it doesn't care about", () => {
    // Some writers put a LIST chunk before the audio. Assuming the header is
    // always 44 bytes plays that metadata as a burst of noise.
    const plain = wavFromPcm(samples, 24_000);
    const list = Buffer.alloc(8 + 10);
    list.write("LIST", 0, "ascii");
    list.writeUInt32LE(10, 4);
    const withList = Buffer.concat([plain.subarray(0, 12), list, plain.subarray(12)]);
    withList.writeUInt32LE(withList.length - 8, 4); // fix the RIFF size

    assert.deepEqual(pcmFromWav(withList), samples);
  });

  test("skips the pad byte after an odd-sized chunk", () => {
    const plain = wavFromPcm(samples, 24_000);
    const odd = Buffer.alloc(8 + 3 + 1); // 3 bytes of body, then a pad byte
    odd.write("junk", 0, "ascii");
    odd.writeUInt32LE(3, 4);
    const padded = Buffer.concat([plain.subarray(0, 12), odd, plain.subarray(12)]);
    padded.writeUInt32LE(padded.length - 8, 4);

    assert.deepEqual(pcmFromWav(padded), samples);
  });

  test("does not read past the end when the size field lies", () => {
    const truncated = wavFromPcm(samples, 24_000).subarray(0, 44 + 4);
    assert.deepEqual(pcmFromWav(truncated), samples.subarray(0, 4));
  });

  test("returns null for something that isn't a wav", () => {
    assert.equal(pcmFromWav(Buffer.from("not audio at all, sorry")), null);
  });

  test("returns null for a wav with no audio chunk", () => {
    const headerOnly = wavFromPcm(Buffer.alloc(0)).subarray(0, 36);
    assert.equal(pcmFromWav(headerOnly), null);
  });
});

describe("pcmPlayer", () => {
  const samples = Buffer.from([0x01, 0x02, 0x03, 0x04]);

  test("doesn't open the audio device until there is something to play", () => {
    const { spawned } = fakeSpawner();
    pcmPlayer({ spawn: fakeSpawner().spawn });
    assert.equal(spawned.length, 0, "constructing a player must be free");
  });

  test("tells the player exactly what the samples are", () => {
    const fake = fakeSpawner();
    pcmPlayer({ spawn: fake.spawn, play: "ffplay", sampleRate: 24_000 }).write(samples);

    const { args, flag } = fake.last();
    assert.equal(flag("-ar"), "24000");
    assert.equal(flag("-f"), "s16le");
    // ffplay 9 dropped -ac; getting this wrong plays mono at double speed.
    assert.equal(flag("-ch_layout"), "mono");
    assert.ok(args.includes("-nodisp"), "a window would steal focus mid-sentence");
  });

  test("plays every sentence through one player, not one each", () => {
    // This is the whole point: a player per sentence costs ~450ms of startup
    // and lands as a gap of silence between each one.
    const fake = fakeSpawner();
    const player = pcmPlayer({ spawn: fake.spawn });
    player.write(samples);
    player.write(samples);
    player.write(samples);

    assert.equal(fake.spawned.length, 1);
    assert.equal(fake.last().proc.written.length, samples.length * 3);
  });

  test("passes the samples through untouched", () => {
    const fake = fakeSpawner();
    pcmPlayer({ spawn: fake.spawn }).write(samples);
    assert.deepEqual(fake.last().proc.written, samples);
  });

  test("ignores an empty buffer rather than starting a player for it", () => {
    const fake = fakeSpawner();
    pcmPlayer({ spawn: fake.spawn }).write(Buffer.alloc(0));
    assert.equal(fake.spawned.length, 0);
  });

  test("draining closes the stream and waits for the tail to play out", async () => {
    const fake = fakeSpawner();
    const player = pcmPlayer({ spawn: fake.spawn });
    player.write(samples);

    await player.drain(1000);
    assert.equal(fake.last().proc.stdin.writableEnded, true, "the player needs an end of stream");
  });

  test("draining before anything was said returns at once", async () => {
    const fake = fakeSpawner();
    await pcmPlayer({ spawn: fake.spawn }).drain(1000);
    assert.equal(fake.spawned.length, 0);
  });

  test("a sentence after a drain gets a fresh player", async () => {
    const fake = fakeSpawner();
    const player = pcmPlayer({ spawn: fake.spawn });
    player.write(samples);
    await player.drain(1000);
    player.write(samples);

    assert.equal(fake.spawned.length, 2, "the drained player has already reached its end");
  });

  test("stop kills the player and nothing is played after it", () => {
    const fake = fakeSpawner();
    const player = pcmPlayer({ spawn: fake.spawn });
    player.write(samples);
    const first = fake.last().proc;
    player.stop();
    player.write(samples);

    assert.equal(first.killed, true);
    assert.equal(fake.spawned.length, 1, "stop means stop");
  });

  test("says why when the player won't start", async () => {
    const problems: string[] = [];
    // A real spawn reports ENOENT on the next tick, after the caller has had a
    // chance to attach its listener.
    const fake = fakeSpawner(({ proc }) => setImmediate(() => proc.fail("ENOENT")));
    pcmPlayer({ spawn: fake.spawn, play: "ffplay", onProblem: (w) => problems.push(w) })
      .write(samples);
    await settle();

    assert.match(problems[0] ?? "", /ffplay/, "silence must not be the only symptom");
  });
});

describe("kokoroSpeaker", () => {
  // The worker writes real files, so the speaker gets real bytes to forward.
  const harness = (opts: { reply?: (out: string) => string; pcm?: Buffer } = {}) => {
    const dir = mkdtempSync(join(tmpdir(), "vela-test-kokoro-"));
    const pcm = opts.pcm ?? Buffer.from([0x0a, 0x0b, 0x0c, 0x0d]);
    const problems: string[] = [];

    const fake = fakeSpawner((spawned) => {
      // The first child is the worker; the second is the player it feeds.
      if (spawned.command !== "python.exe") return;
      respondToRequests(spawned.proc, (request) => {
        if (opts.reply) return opts.reply(request.out);
        writeFileSync(request.out, wavFromPcm(pcm, 24_000));
        return `ok ${request.out}`;
      });
    });

    const speaker = kokoroSpeaker({
      python: "python.exe",
      worker: "kokoro_worker.py",
      spawn: fake.spawn,
      onProblem: (why) => problems.push(why),
    });

    return {
      speaker,
      problems,
      pcm,
      worker: () => fake.spawned[0].proc,
      workerArgs: () => fake.spawned[0].args,
      player: () => fake.spawned.find((s) => s.command !== "python.exe"),
      cleanup: () => {
        speaker.stop();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  };

  test("starts the worker with the voice it was asked for", () => {
    const fake = fakeSpawner();
    kokoroSpeaker({
      python: "python.exe",
      worker: "kokoro_worker.py",
      voice: "bf_isabella",
      speed: 1.3,
      spawn: fake.spawn,
    });
    assert.deepEqual(fake.last().args, ["kokoro_worker.py", "bf_isabella", "1.3"]);
  });

  test("sends each sentence to the worker as one JSON line", async () => {
    const h = harness();
    h.speaker.speak("Renamed it.");
    await settle();

    const request = JSON.parse(h.worker().lines[0]);
    assert.equal(request.text, "Renamed it.");
    assert.ok(request.out, "the worker needs somewhere to write");
    h.cleanup();
  });

  test("forwards the audio to the player without the wav header", async () => {
    const h = harness();
    h.speaker.speak("Renamed it.");
    await h.speaker.drain!(1000);

    assert.deepEqual(h.player()?.proc.written, h.pcm, "a header played as audio is a burst of noise");
    h.cleanup();
  });

  test("keeps sentences in order instead of talking over itself", async () => {
    const h = harness();
    h.speaker.speak("One.");
    h.speaker.speak("Two.");
    h.speaker.speak("Three.");
    await h.speaker.drain!(1000);

    const said = h.worker().lines.map((l) => JSON.parse(l).text);
    assert.deepEqual(said, ["One.", "Two.", "Three."]);
    h.cleanup();
  });

  test("ignores the loader's own chatter on the protocol channel", async () => {
    // Kokoro prints warnings to stdout, sharing the line protocol's channel.
    const h = harness();
    h.worker().say("some torch deprecation warning");
    h.speaker.speak("Renamed it.");
    await h.speaker.drain!(1000);

    assert.deepEqual(h.player()?.proc.written, h.pcm, "noise must not be read as a reply");
    h.cleanup();
  });

  test("says why when the worker reports a failure", async () => {
    const h = harness({ reply: () => "err out of memory" });
    h.speaker.speak("Renamed it.");
    await h.speaker.drain!(1000);

    assert.match(h.problems[0] ?? "", /out of memory/);
    assert.equal(h.player(), undefined, "nothing to play");
    h.cleanup();
  });

  test("says why when the worker claims success but wrote nothing", async () => {
    const h = harness({ reply: (out) => `ok ${out}` }); // reports ok, writes no file
    h.speaker.speak("Renamed it.");
    await h.speaker.drain!(1000);

    assert.equal(h.problems.length, 1, "a missing file is silence, and silence needs explaining");
    assert.equal(h.player(), undefined);
    h.cleanup();
  });

  test("says why when the worker wrote something that isn't audio", async () => {
    const h = harness({
      reply: (out) => {
        writeFileSync(out, "this is not a wav");
        return `ok ${out}`;
      },
    });
    h.speaker.speak("Renamed it.");
    await h.speaker.drain!(1000);

    assert.match(h.problems[0] ?? "", /wav/, "playing a non-wav is a burst of noise");
    h.cleanup();
  });

  test("complains only once, however many sentences fail", async () => {
    const h = harness({ reply: () => "err out of memory" });
    h.speaker.speak("One.");
    h.speaker.speak("Two.");
    await h.speaker.drain!(1000);

    assert.equal(h.problems.length, 1, "one warning is a warning; three is noise");
    h.cleanup();
  });

  test("says nothing after stop", async () => {
    const h = harness();
    h.speaker.stop();
    h.speaker.speak("Renamed it.");
    await settle();

    assert.equal(h.worker().lines.length, 0);
    assert.equal(h.worker().killed, true);
    h.cleanup();
  });
});

describe("neuralSpeaker", () => {
  test("asks edge-tts for the voice, rate and pitch it was given", async () => {
    const fake = fakeSpawner(({ proc }) => setImmediate(() => proc.close()));
    const speaker = neuralSpeaker("en-GB-LibbyNeural", 12, -8, { tts: "edge-tts", play: "ffplay" }, fake.spawn);
    speaker.speak("Renamed it.");
    await speaker.drain!(1000);

    const { flag } = fake.spawned[0];
    assert.equal(flag("--voice"), "en-GB-LibbyNeural");
    // edge-tts wants them signed, and rejects them otherwise.
    assert.equal(flag("--rate"), "+12%");
    assert.equal(flag("--pitch"), "-8Hz");
    assert.equal(flag("--text"), "Renamed it.");
    speaker.stop();
  });

  test("plays what edge-tts wrote, once it has written it", async () => {
    const fake = fakeSpawner((spawned) => {
      // Stand in for edge-tts actually fetching the audio.
      if (spawned.command === "edge-tts") {
        writeFileSync(spawned.flag("--write-media")!, "mp3 bytes");
      }
      setImmediate(() => spawned.proc.close());
    });
    const speaker = neuralSpeaker("en-GB-LibbyNeural", 0, 0, { tts: "edge-tts", play: "ffplay" }, fake.spawn);
    speaker.speak("Renamed it.");
    await speaker.drain!(1000);

    const player = fake.spawned.find((s) => s.command === "ffplay");
    assert.ok(player, "the audio was fetched and then never played");
    assert.ok(player.args.includes("-nodisp"));
    speaker.stop();
  });

  test("leaves the rate and pitch alone when they're zero", async () => {
    const fake = fakeSpawner(({ proc }) => setImmediate(() => proc.close()));
    const speaker = neuralSpeaker("en-GB-LibbyNeural", 0, 0, { tts: "edge-tts", play: "ffplay" }, fake.spawn);
    speaker.speak("Renamed it.");
    await speaker.drain!(1000);

    assert.equal(fake.spawned[0].flag("--rate"), undefined);
    assert.equal(fake.spawned[0].flag("--pitch"), undefined);
    speaker.stop();
  });

  test("says why when edge-tts isn't installed", async () => {
    const stderr: string[] = [];
    const written = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => (stderr.push(String(s)), true)) as typeof written;

    const fake = fakeSpawner(({ proc }) => setImmediate(() => proc.fail("ENOENT")));
    const speaker = neuralSpeaker("en-GB-LibbyNeural", 12, -8, { tts: "edge-tts", play: "ffplay" }, fake.spawn);
    try {
      speaker.speak("Renamed it.");
      await speaker.drain!(1000);
    } finally {
      process.stderr.write = written;
      speaker.stop();
    }

    assert.match(stderr.join(""), /edge-tts/);
  });

  test("says nothing after stop", async () => {
    const fake = fakeSpawner(({ proc }) => setImmediate(() => proc.close()));
    const speaker = neuralSpeaker("en-GB-LibbyNeural", 12, -8, { tts: "edge-tts", play: "ffplay" }, fake.spawn);
    speaker.stop();
    speaker.speak("Renamed it.");
    await speaker.drain!(1000);

    assert.equal(fake.spawned.length, 0);
  });

  test("says why when edge-tts produced no audio", async () => {
    // Nothing writes the file, so this is the no-network case.
    const stderr: string[] = [];
    const written = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => (stderr.push(String(s)), true)) as typeof written;

    const fake = fakeSpawner(({ proc }) => setImmediate(() => proc.close()));
    const speaker = neuralSpeaker("en-GB-LibbyNeural", 12, -8, { tts: "edge-tts", play: "ffplay" }, fake.spawn);
    try {
      speaker.speak("Renamed it.");
      await speaker.drain!(1000);
    } finally {
      process.stderr.write = written;
      speaker.stop();
    }

    assert.match(stderr.join(""), /no audio|network/i);
  });
});

describe("windowsSpeaker", () => {
  test("loads the synthesiser once, up front", () => {
    const fake = fakeSpawner();
    windowsSpeaker("Microsoft Hazel Desktop", 2, fake.spawn);

    const setup = fake.last().proc.written.toString("utf8");
    assert.match(setup, /System\.Speech/);
    assert.match(setup, /\$s\.Rate = 2/);
    assert.match(setup, /SelectVoice\('Microsoft Hazel Desktop'\)/);
  });

  test("clamps the rate to what SAPI will accept", () => {
    const fake = fakeSpawner();
    windowsSpeaker(undefined, 99, fake.spawn);
    assert.match(fake.last().proc.written.toString("utf8"), /\$s\.Rate = 10/);
  });

  test("speaks through the shell it already has open", () => {
    const fake = fakeSpawner();
    const speaker = windowsSpeaker(undefined, 1, fake.spawn);
    speaker.speak("Renamed it.");

    assert.equal(fake.spawned.length, 1, "a shell per sentence costs ~300ms each");
    assert.match(fake.last().proc.written.toString("utf8"), /\$s\.Speak\('Renamed it\.'\)/);
  });

  test("quotes text that would otherwise end the command early", () => {
    const fake = fakeSpawner();
    windowsSpeaker(undefined, 1, fake.spawn).speak("that's Yousef's call");
    assert.match(fake.last().proc.written.toString("utf8"), /'that''s Yousef''s call'/);
  });

  test("says nothing after stop", () => {
    const fake = fakeSpawner();
    const speaker = windowsSpeaker(undefined, 1, fake.spawn);
    speaker.stop();
    const before = fake.last().proc.written.length;
    speaker.speak("Renamed it.");

    assert.equal(fake.last().proc.written.length, before);
  });

  test("goes quiet rather than throwing when the shell won't start", async () => {
    const fake = fakeSpawner(({ proc }) => setImmediate(() => proc.fail("ENOENT")));
    const speaker = windowsSpeaker(undefined, 1, fake.spawn);
    await settle();

    assert.doesNotThrow(() => speaker.speak("Renamed it."));
    assert.doesNotThrow(() => speaker.stop());
  });

  test("skips SelectVoice when no voice was named", () => {
    const fake = fakeSpawner();
    windowsSpeaker(undefined, 1, fake.spawn);
    assert.doesNotMatch(fake.last().proc.written.toString("utf8"), /SelectVoice/);
  });
});

describe("createVoice", () => {
  const harness = () => {
    const spoken: string[] = [];
    return { spoken, voice: createVoice((t) => spoken.push(t)) };
  };

  test("speaks each sentence as it streams, not at the end", () => {
    const { spoken, voice } = harness();
    voice.push("Renamed it. ");
    assert.deepEqual(spoken, ["Renamed it."], "waiting for the full reply adds latency");
    voice.push("Tests pass. ");
    assert.deepEqual(spoken, ["Renamed it.", "Tests pass."]);
  });

  test("says nothing until a sentence is whole", () => {
    const { spoken, voice } = harness();
    voice.push("The build ");
    voice.push("succeeded");
    assert.deepEqual(spoken, []);
    voice.flush();
    assert.deepEqual(spoken, ["The build succeeded"]);
  });

  test("cleans what it speaks", () => {
    const { spoken, voice } = harness();
    voice.push("Edit `src/core.ts` now. ");
    assert.deepEqual(spoken, ["Edit src/core.ts now."]);
  });

  test("skips an utterance that is nothing but markup", () => {
    const { spoken, voice } = harness();
    voice.push("```\ncode\n```\n");
    voice.flush();
    assert.deepEqual(spoken, ["code block."]);
  });

  test("an unprompted line is spoken on its own", () => {
    const { spoken, voice } = harness();
    voice.push("half a sentence");
    voice.say("Build succeeded.");
    assert.deepEqual(spoken, ["Build succeeded."], "must not swallow the interjection");
  });

  test("flushing twice does not repeat itself", () => {
    const { spoken, voice } = harness();
    voice.push("Done");
    voice.flush();
    voice.flush();
    assert.deepEqual(spoken, ["Done"]);
  });
});
