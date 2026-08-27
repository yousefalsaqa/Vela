import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  speakable,
  sentences,
  clauses,
  createVoice,
  spokenOf,
  withoutSay,
  stripSay,
  pcmFromWav,
  pcmPlayer,
  kokoroSpeaker,
  kokoroSynth,
  synthSpeaker,
  neuralSpeaker,
  windowsSpeaker,
  PRONOUNCE_PHONEMES,
  silence,
  gapFor,
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

      test("respells her own name so it rhymes with umbrella", () => {
        assert.equal(speakable("I'm Vela."), "I'm Vella.");
      });

      test("handles her possessive", () => {
        assert.equal(speakable("Vela's job"), "Vella's job");
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

      test("overrides her own name too", () => {
        assert.equal(say("I'm Vela."), "I'm [Vela](/vˈɛlə/).");
      });

      test("handles her possessive without stranding an apostrophe", () => {
        assert.equal(say("Vela's job"), "[Velas](/vˈɛləz/) job");
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

describe("spokenOf", () => {
  test("only what is inside the tags is meant for the ear", () => {
    assert.equal(
      spokenOf("<say>Three new ones.</say> CMAPSS is a turbofan project.").trim(),
      "Three new ones.",
    );
  });

  test("an unclosed tag is already speakable, so she starts talking before she stops writing", () => {
    // The whole point of putting it first. Waiting for the tag to close would
    // cost the opening the eager-clause work exists to buy back.
    assert.equal(spokenOf("<say>Three new"), "Three new");
  });

  test("a half-arrived closing tag is markup, not something to say", () => {
    // This is the one that matters. push() hands over whatever is new since
    // last time, so anything that appears and then disappears has already
    // been said and cannot be taken back.
    assert.equal(spokenOf("<say>Three new ones.</sa"), "Three new ones.");
  });

  test("what it returns can only ever grow, one character of arrival at a time", () => {
    const whole = "<say>Three new ones.</say> CMAPSS is a turbofan project.";
    let last = "";
    for (let i = 0; i <= whole.length; i++) {
      const now = spokenOf(whole.slice(0, i));
      assert.ok(
        now.startsWith(last),
        `at ${i} chars "${now}" is not a continuation of "${last}" — she would repeat or swallow words`,
      );
      last = now;
    }
  });

  test("a reply with no tags says nothing, which is what leaves the fallback to decide", () => {
    assert.equal(spokenOf("I checked the desktop. Three new ones."), "");
  });
});

describe("withoutSay", () => {
  test("the marks are for the room, so a screen never shows them", () => {
    assert.equal(withoutSay("<say>Done.</say> The long version."), "Done. The long version.");
  });
});

describe("stripSay", () => {
  test("holds back a tag that has only half arrived, rather than printing it", () => {
    // "</sa" on his screen for one chunk, then gone. The terminal writes
    // straight to stdout, so anything printed cannot be taken back.
    assert.deepEqual(stripSay("Done.</sa"), { text: "Done.", held: "</sa" });
  });

  test("the next chunk finishes it, and none of it was ever shown", () => {
    const first = stripSay("Done.</sa");
    const second = stripSay("y> The detail.", first.held);
    assert.equal(first.text + second.text, "Done. The detail.");
    assert.equal(second.held, "");
  });

  test("a real angle bracket prints, one chunk late", () => {
    // The cost of the hold. It has to come out eventually, which is why the
    // turn ends by writing whatever is still held.
    const first = stripSay("a <");
    const second = stripSay(" b", first.held);
    assert.equal(first.text + second.text, "a < b");
  });

  test("a reply arriving one character at a time prints exactly what it would whole", () => {
    const whole = "<say>Done.</say> The detail, at length.";
    let held = "";
    let out = "";
    for (const ch of whole) {
      const step = stripSay(ch, held);
      out += step.text;
      held = step.held;
    }
    // What the turn ending does with the remainder.
    out += held;
    assert.equal(out, withoutSay(whole), "the slowest possible stream must read the same as the fastest");
  });
});

describe("createVoice, splitting what she says from what she writes", () => {
  const heard = () => {
    const said: string[] = [];
    return { said, voice: createVoice((t) => said.push(t)) };
  };

  test("the detail underneath the line is written, not spoken", () => {
    const h = heard();
    h.voice.push("<say>Three new ones.</say> CMAPSS is an end-to-end turbofan");
    h.voice.push(" prognostics project on the NASA dataset. Then tactical-lab.");
    h.voice.flush();
    assert.deepEqual(h.said, ["Three new ones."]);
  });

  test("she forgot the tag, so she says one sentence rather than nothing", () => {
    // Silence is the wrong failure here: from across the room a turn that
    // answers nothing is indistinguishable from one she never heard.
    const h = heard();
    h.voice.push("I checked the desktop. There are three new projects. CMAPSS is the newest.");
    h.voice.flush();
    assert.deepEqual(h.said, ["I checked the desktop."]);
  });

  test("a turn that fell back does not leak into the next one", () => {
    const h = heard();
    h.voice.push("No tag at all here.");
    h.voice.flush();
    h.voice.push("<say>Done.</say> And the rest.");
    h.voice.flush();
    assert.deepEqual(h.said, ["No tag at all here.", "Done."]);
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

  test("stopping kills the player mid-sentence, which is what talking over her needs", () => {
    // Being interrupted has to be immediate. Waiting for the current sentence
    // to finish is exactly the thing he interrupted to avoid.
    const fake = fakeSpawner();
    const player = pcmPlayer({ spawn: fake.spawn });
    player.write(samples);
    player.stop();
    assert.equal(fake.last().proc.killed, true);
  });

  test("says nothing more after being stopped", () => {
    const fake = fakeSpawner();
    const player = pcmPlayer({ spawn: fake.spawn });
    player.stop();
    player.write(samples);
    assert.equal(fake.spawned.length, 0, "a stopped player must not open the device again");
  });

  test("stopping before anything played is not an error", () => {
    const fake = fakeSpawner();
    assert.doesNotThrow(() => pcmPlayer({ spawn: fake.spawn }).stop());
  });

  test("must not open a second device while the last turn is still playing out", async () => {
    // drain() gives up the player the moment it closes the pipe, but the audio
    // already handed over goes on sounding for as long as the tail is. A write
    // arriving there used to start its own player, and the two then sounded at
    // once — which is what two live ffplays in the process list turned out to
    // be, and what "she reads over herself" sounds like from the desk.
    const fake = fakeSpawner();
    const player = pcmPlayer({ spawn: fake.spawn });
    await player.write(samples);
    const draining = player.drain(1_000);
    const next = player.write(samples);
    assert.equal(fake.spawned.length, 1, "the tail of the last turn is still sounding");
    await draining;
    await next;
    assert.equal(fake.spawned.length, 2, "and once it has finished, the next turn opens its own");
  });

  test("cutting does not leave the next sentence waiting on a player it already killed", async () => {
    // The wait exists for a tail. Cutting is the one case with no tail, so
    // carrying the wait over would make being interrupted cost her the start
    // of her next answer.
    const fake = fakeSpawner();
    const player = pcmPlayer({ spawn: fake.spawn });
    await player.write(samples);
    const draining = player.drain(1_000);
    player.cut();
    await player.write(samples);
    assert.equal(fake.spawned.length, 2);
    await draining;
  });

  test("cutting kills the player, rather than letting the sentence it holds finish", () => {
    // The pipe already holds a whole sentence. Ending it politely would play
    // that sentence out, which from the other side of the desk is not being
    // interrupted at all — it is being ignored for another four seconds.
    const fake = fakeSpawner();
    const player = pcmPlayer({ spawn: fake.spawn });
    player.write(samples);
    player.cut();
    assert.equal(fake.last().proc.killed, true);
  });

  test("cutting leaves her able to speak again, which is the whole difference from stopping", () => {
    const fake = fakeSpawner();
    const player = pcmPlayer({ spawn: fake.spawn });
    player.write(samples);
    player.cut();
    player.write(samples);
    assert.equal(fake.spawned.length, 2, "being interrupted must not cost her the voice for the session");
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

describe("kokoroSynth", () => {
  // The hub's voice: a sentence in, a wav back, no player involved.
  const harness = (lazy?: boolean) => {
    const problems: string[] = [];
    const fake = fakeSpawner(({ proc }) =>
      respondToRequests(proc, (request) => {
        writeFileSync(request.out, wavFromPcm(Buffer.from([1, 2, 3, 4]), 24_000));
        return `ok ${request.out}`;
      }),
    );
    const mouth = kokoroSynth({
      python: "python.exe",
      worker: "kokoro_worker.py",
      ...(lazy === undefined ? {} : { lazy }),
      spawn: fake.spawn,
      onProblem: (why: string) => problems.push(why),
    });
    return { mouth, fake, problems };
  };

  test("renders a sentence to a wav", async () => {
    const h = harness();
    const wav = await h.mouth.render("Loud and clear.");
    assert.ok(wav?.length, "the hub plays these bytes");
    assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
    h.mouth.stop();
  });

  test("starts the worker eagerly by default, the way the terminal wants it", () => {
    const h = harness();
    assert.equal(h.fake.spawned.length, 1);
    h.mouth.stop();
  });

  test("starts on the voice and speed it was given", () => {
    const fake = fakeSpawner();
    kokoroSynth({
      python: "python.exe",
      worker: "kokoro_worker.py",
      voice: "bf_isabella",
      speed: 1.3,
      spawn: fake.spawn,
    });
    assert.deepEqual(fake.last().args, ["kokoro_worker.py", "bf_isabella", "1.3"]);
  });

  test("reports a sentence the worker refused, rather than returning silence", async () => {
    const problems: string[] = [];
    const fake = fakeSpawner(({ proc }) => respondToRequests(proc, () => "err out of memory"));
    const mouth = kokoroSynth({
      python: "python.exe",
      worker: "kokoro_worker.py",
      spawn: fake.spawn,
      onProblem: (why: string) => problems.push(why),
    });
    assert.equal(await mouth.render("Anything."), null);
    assert.match(problems[0] ?? "", /out of memory/);
    mouth.stop();
  });

  test("a worker that says ok but writes nothing is a failure, not a wav", async () => {
    const problems: string[] = [];
    const fake = fakeSpawner(({ proc }) =>
      respondToRequests(proc, (request) => `ok ${request.out}`),
    );
    const mouth = kokoroSynth({
      python: "python.exe",
      worker: "kokoro_worker.py",
      spawn: fake.spawn,
      onProblem: (why: string) => problems.push(why),
    });
    assert.equal(await mouth.render("Anything."), null);
    assert.equal(problems.length, 1);
    mouth.stop();
  });

  test("a worker that won't start says so by name", async () => {
    const problems: string[] = [];
    const fake = fakeSpawner(({ proc }) => setImmediate(() => proc.fail("ENOENT")));
    kokoroSynth({
      python: "python.exe",
      worker: "kokoro_worker.py",
      spawn: fake.spawn,
      onProblem: (why: string) => problems.push(why),
    });
    await settle();
    assert.match(problems[0] ?? "", /couldn't start Kokoro/);
  });

  test("serialises two callers, because the worker answers in order", async () => {
    // Two sentences interleaving would hand each caller the other's audio.
    const h = harness();
    const [first, second] = await Promise.all([h.mouth.render("One."), h.mouth.render("Two.")]);
    assert.ok(first?.length);
    assert.ok(second?.length);
    h.mouth.stop();
  });

  describe("lazily", () => {
    test("holds the model until something is actually said out loud", () => {
      // Kokoro is ~1.1GB resident. She runs from boot and most days nobody
      // presses the speaker button, so loading it at start is the single
      // largest cost of her being always-on.
      const h = harness(true);
      assert.equal(h.fake.spawned.length, 0, "an unused voice must not hold 1.1GB");
      h.mouth.stop();
    });

    test("loads on the first sentence and stays warm after it", async () => {
      const h = harness(true);
      assert.ok((await h.mouth.render("First."))?.length);
      assert.ok((await h.mouth.render("Second."))?.length);
      assert.equal(h.fake.spawned.length, 1, "a reload per sentence is what the worker exists to avoid");
      h.mouth.stop();
    });

    test("can be warmed ahead of the first sentence, so the load is not heard as a delay", async () => {
      // The hub calls this the moment he switches the speaker on, which is
      // several seconds before there is anything to say. Measured: a cold
      // first sentence is 4.6s against 0.3s warm.
      const h = harness(true);
      h.mouth.warm();
      assert.equal(h.fake.spawned.length, 1, "warming is what moves the load off the first reply");
      assert.ok((await h.mouth.render("Ready."))?.length);
      assert.equal(h.fake.spawned.length, 1, "warming then speaking must not start two workers");
      h.mouth.stop();
    });

    test("warming twice is not two workers", () => {
      const h = harness(true);
      h.mouth.warm();
      h.mouth.warm();
      assert.equal(h.fake.spawned.length, 1);
      h.mouth.stop();
    });

    test("warming after stopping starts nothing", () => {
      const h = harness(true);
      h.mouth.stop();
      h.mouth.warm();
      assert.equal(h.fake.spawned.length, 0, "a stopped service must stay stopped");
    });

    test("stopping before she ever spoke starts nothing", () => {
      const h = harness(true);
      h.mouth.stop();
      assert.equal(h.fake.spawned.length, 0);
    });

    test("stopping ends the worker it did start", async () => {
      const h = harness(true);
      await h.mouth.render("Something.");
      h.mouth.stop();
      assert.equal(h.fake.last().proc.killed, true, "a stopped service must not leave Kokoro resident");
    });

    test("says nothing after being stopped", async () => {
      const h = harness(true);
      h.mouth.stop();
      assert.equal(await h.mouth.render("Too late."), null);
    });
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

  /* These push tagged text because only tagged text is spoken now. The claims
     are unchanged — streaming, eagerness, cleanup — but an untagged reply no
     longer reaches the ear as it streams, so testing them on one would be
     testing the fallback and calling it something else. */
  test("speaks each sentence as it streams, not at the end", () => {
    const { spoken, voice } = harness();
    voice.push("<say>Renamed it. ");
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
    voice.push("<say>Edit `src/core.ts` now. ");
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

  test("stopping drops what was half-said, so a cut-off turn doesn't leak into the next", () => {
    const { spoken, voice } = harness();
    voice.push("She was in the middle of");
    voice.stop();
    voice.flush();
    assert.deepEqual(spoken, [], "the abandoned half must not surface a turn later");
  });

  test("a name is said the way he says it", () => {
    const spoken: string[] = [];
    const voice = createVoice((t) => spoken.push(t), [[/\bYousef\b/g, "YOO-sef"]]);
    voice.push("<say>Morning, Yousef. ");
    assert.match(spoken[0] ?? "", /YOO-sef/, "every English voice reads it wrong by default");
  });
});

describe("the opening clause", () => {
  test("breaks a long opener at its first comma, so he hears something sooner", () => {
    const { ready, rest } = sentences("Some of that is not me, it is the pipe and ", false, true);
    assert.deepEqual(ready, ["Some of that is not me,"]);
    assert.equal(rest, "it is the pipe and ");
  });

  test("leaves a stub alone, because three words have no run-up", () => {
    assert.deepEqual(sentences("No, ", false, true).ready, []);
  });

  test("a whole sentence still wins over the clause inside it", () => {
    assert.deepEqual(sentences("Loud and clear. ", false, true).ready, ["Loud and clear."]);
  });

  test("never cuts inside a code fence", () => {
    assert.deepEqual(sentences("```ts\nconst a = 1, b = 2;\n", false, true).ready, []);
  });

  test("does nothing once she is already talking", () => {
    assert.deepEqual(sentences("Some of that is not me, it is the pipe and ", false, false).ready, []);
  });

  test("only the first piece of a turn is eager", () => {
    const said: string[] = [];
    const voice = createVoice((t) => said.push(t), []);
    voice.push("<say>Some of that is not me, it is the pipe and ");
    assert.deepEqual(said, ["Some of that is not me,"], "the opener breaks early");
    voice.push("the pipe does not care, it just renders and ");
    assert.deepEqual(said, ["Some of that is not me,"], "the rest waits for a full stop");
  });

  test("a new turn opens from silence and is eager again", () => {
    const said: string[] = [];
    const voice = createVoice((t) => said.push(t), []);
    voice.push("<say>Some of that is not me, it is the pipe.");
    voice.flush();
    said.length = 0;
    voice.push("<say>Another long opening line here, and then some more ");
    assert.deepEqual(said, ["Another long opening line here,"]);
  });
});

describe("clauses inside a sentence", () => {
  // A long sentence went to Kokoro whole, so the only pauses in a reply were
  // the ones between full stops. Three clauses came out as one unbroken run,
  // which is what "it sounds like one long sentence" actually was.
  test("splits a long sentence at its commas, so each clause gets its own beat", () => {
    const { ready, rest } = sentences(
      "Is it the gaps between the sentences, or is it inside the sentences, the way it renders the words? ",
    );
    assert.deepEqual(ready, [
      "Is it the gaps between the sentences,",
      "or is it inside the sentences,",
      "the way it renders the words?",
    ]);
    assert.equal(rest, "");
  });

  test("leaves a short sentence in one piece", () => {
    // Two clauses of four words are a phrase, not a list. Cutting here would
    // put a hole in the middle of something a person says in one breath.
    assert.deepEqual(sentences("Renamed it, tests pass. ").ready, ["Renamed it, tests pass."]);
  });

  test("does not cut a clause too short to stand on its own", () => {
    const { ready } = sentences(
      "No, the whole point of this is that it should not chop the first two words off. ",
    );
    assert.ok(
      ready.every((piece) => piece.split(/\s+/).length >= 3),
      "a two-word fragment is a stutter, not a clause",
    );
  });

  test("never cuts inside a code fence", () => {
    const fenced = "```ts\nconst a = 1, b = 2, c = 3, d = 4, e = 5, f = 6;\n```\n\n";
    assert.deepEqual(sentences(fenced).ready, [fenced.trim()]);
  });

  test("a decimal inside a long sentence is not a clause boundary", () => {
    const { ready } = sentences(
      "The whole suite finished in 1.4 seconds on this machine, which is faster than it was. ",
    );
    assert.ok(
      ready.every((piece) => !/\d\.$/.test(piece)),
      "cutting at a decimal point reads the number wrong",
    );
  });

  test("a long fenced block keeps its commas, because those are code", () => {
    // Long enough to pass the length guard, so this reaches the fence check
    // rather than being spared by being short.
    const fenced = "```ts\nconst a = 1, b = 2, c = 3, d = 4, e = 5, f = 6, g = 7, h = 8;\n```";
    assert.deepEqual(clauses(fenced), [fenced]);
  });

  test("returns the sentence whole when no cut is worth making", () => {
    // Long, and every comma has a stub on one side of it. Splitting on any of
    // them would put a pause inside a phrase.
    const awkward = "The build finished and everything about it passed cleanly, ok, yes.";
    assert.deepEqual(clauses(awkward), [awkward]);
  });

  test("flush splits the trailing fragment too", () => {
    const { ready } = sentences(
      "I think it probably turns out that you are right about this, and the fix is small",
      true,
    );
    assert.ok(ready.length > 1, "the last sentence of a turn is usually the longest");
  });
});

describe("the beat between sentences", () => {
  const GAP_BYTES = Math.round(24_000 * 0.15) * 2;

  test("silence is two bytes a sample, even in length, and actually silent", () => {
    assert.equal(silence(150, 24_000).length, GAP_BYTES);
    assert.equal(silence(150).length % 2, 0);
    assert.deepEqual(silence(150).subarray(0, 8), Buffer.alloc(8));
  });

  test("no beat before her first sentence, which is the one he is waiting on", () => {
    const fake = fakeSpawner();
    pcmPlayer({ gapMs: 150, spawn: fake.spawn }).write(Buffer.alloc(100, 7));
    assert.equal(fake.last().proc.written.length, 100);
  });

  test("a beat before every sentence after it", () => {
    const fake = fakeSpawner();
    const player = pcmPlayer({ gapMs: 150, sampleRate: 24_000, spawn: fake.spawn });
    player.write(Buffer.alloc(100, 7));
    player.write(Buffer.alloc(200, 7));

    const out = fake.last().proc.written;
    assert.equal(out.length, 100 + GAP_BYTES + 200);
    assert.deepEqual(
      out.subarray(100, 100 + GAP_BYTES),
      Buffer.alloc(GAP_BYTES),
      "the beat has to be silence, not more speech",
    );
  });

  test("zero leaves them flush against each other, as they were", () => {
    const fake = fakeSpawner();
    const player = pcmPlayer({ gapMs: 0, spawn: fake.spawn });
    player.write(Buffer.alloc(100, 7));
    player.write(Buffer.alloc(200, 7));
    assert.equal(fake.last().proc.written.length, 300);
  });

  test("a new turn starts a new player, so it opens with no beat again", async () => {
    const fake = fakeSpawner();
    const player = pcmPlayer({ gapMs: 150, spawn: fake.spawn });
    await player.write(Buffer.alloc(100, 7));
    await player.write(Buffer.alloc(100, 7));
    // Awaited, where this used to write straight over an un-awaited drain and
    // assert that the second player was already open. That was the overlap:
    // the claim it was making — a new turn opens clean — is still true, but it
    // opens once the drained one has finished sounding, not beside it.
    await player.drain(10);
    await player.write(Buffer.alloc(100, 7));
    assert.equal(fake.spawned.length, 2, "the drained player has already ended");
    assert.equal(fake.last().proc.written.length, 100, "and the new one opens clean");
  });
});

describe("gapFor", () => {
  test("a clause is barely a beat, a full stop is a real one", () => {
    assert.ok(
      gapFor("Two things bother me,") < gapFor("Two things bother me."),
      "running a comma as long as a full stop is what made it sound read out",
    );
  });

  test("a question hangs longer than a statement", () => {
    assert.ok(gapFor("Are you there?") > gapFor("You are there."));
  });

  test("a paragraph is a proper stop", () => {
    assert.ok(gapFor("Done.\n\n") > gapFor("Done."));
  });

  test("the same sentence always pauses the same way", () => {
    // Otherwise a replayed reply shimmers differently every time.
    assert.equal(gapFor("Loud and clear."), gapFor("Loud and clear."));
  });

  test("different sentences do not all land on the same number", () => {
    const spread = new Set(
      ["Right.", "Done.", "Not quite.", "Fine.", "It passed."].map((s) => gapFor(s)),
    );
    assert.ok(spread.size > 1, "an even pause is as much a tell as an even sentence length");
  });

  test("scales with the base, so VELA_VOICE_GAP still means something", () => {
    assert.ok(gapFor("Done.", 300) > gapFor("Done.", 150));
    assert.equal(gapFor("Done.", 0), 0);
  });
});

describe("a per-sentence pause", () => {
  test("the caller's gap wins over the player's default", () => {
    const fake = fakeSpawner();
    const player = pcmPlayer({ gapMs: 150, sampleRate: 24_000, spawn: fake.spawn });
    player.write(Buffer.alloc(80, 7));
    player.write(Buffer.alloc(80, 7), 60);
    assert.equal(fake.last().proc.written.length, 80 + Math.round(24_000 * 0.06) * 2 + 80);
  });
});

describe("synthSpeaker", () => {
  /** A renderer standing in for the kokoroSynth the service already holds. */
  const harness = (
    render: (text: string) => Promise<Buffer | null> = async () =>
      wavFromPcm(Buffer.from([1, 2, 3, 4]), 24_000),
  ) => {
    const fake = fakeSpawner();
    const problems: string[] = [];
    const asked: string[] = [];
    const speaker = synthSpeaker({
      render: (text) => {
        asked.push(text);
        return render(text);
      },
      play: "ffplay",
      spawn: fake.spawn,
      onProblem: (why) => problems.push(why),
    });
    return { speaker, fake, problems, asked };
  };

  test("a sentence still inside Kokoro when he cuts her off must not play afterwards", async () => {
    // Rendering costs about half a second, so an interruption almost always
    // lands while something is mid-flight. Without the epoch that sentence
    // arrives after the room has gone quiet and she starts talking again on
    // her own, which reads as her ignoring him.
    let release: (() => void) | null = null;
    const h = harness(
      (): Promise<Buffer | null> =>
        new Promise((resolve) => {
          release = () => resolve(wavFromPcm(Buffer.from([1, 2, 3, 4]), 24_000));
        }),
    );
    h.speaker.speak("The rest of what she was going to say.");
    await settle();
    h.speaker.cut!();
    release!();
    await settle();
    await settle();
    assert.equal(h.fake.spawned.length, 0, "a late render must not open the device after he cut her off");
  });

  test("cutting leaves the speaker usable, so the next turn still has a voice", async () => {
    const h = harness();
    h.speaker.speak("First.");
    await h.speaker.drain!(1_000);
    h.speaker.cut!();
    h.speaker.speak("Second.");
    await h.speaker.drain!(1_000);
    assert.deepEqual(h.asked, ["First.", "Second."]);
  });

  test("reports a sentence's real length, because the hub's reading head has no audio to follow", async () => {
    // 24000 frames of 16-bit mono is exactly one second at Kokoro's rate. The
    // hub spreads that across the sentence's characters; if this number is
    // wrong the head drifts off her voice and is worse than no head at all.
    const spoke: [string, number][] = [];
    const fake = fakeSpawner();
    const speaker = synthSpeaker({
      render: async () => wavFromPcm(Buffer.alloc(24_000 * 2), 24_000),
      spawn: fake.spawn,
      onSpoke: (text, ms) => spoke.push([text, ms]),
    });
    speaker.speak("A second of her.");
    await speaker.drain!(1_000);
    assert.deepEqual(spoke, [["A second of her.", 1_000]]);
  });

  test("speaks through the renderer it was handed, not a Kokoro of its own", async () => {
    const h = harness();
    h.speaker.speak("Done.");
    await h.speaker.drain!(1_000);

    assert.deepEqual(h.asked, ["Done."]);
    assert.equal(
      h.fake.spawned.filter((s) => s.command !== "ffplay").length,
      0,
      "a second Kokoro next to the hub's is another 1.1GB of the same model",
    );
    h.speaker.stop();
  });

  test("the samples reach the player without the wav header", async () => {
    const h = harness();
    h.speaker.speak("Done.");
    await h.speaker.drain!(1_000);

    assert.deepEqual(
      h.fake.last().proc.written,
      Buffer.from([1, 2, 3, 4]),
      "a header played as audio is a burst of noise",
    );
    h.speaker.stop();
  });

  test("sentences are played in the order they were written, not the order they render", async () => {
    const holding: (() => void)[] = [];
    const h = harness((text) =>
      new Promise((done) =>
        holding.push(() => done(wavFromPcm(Buffer.from(text, "ascii"), 24_000))),
      ),
    );
    h.speaker.speak("aa");
    h.speaker.speak("bb");
    await settle();

    // Only one render is ever in flight, so the second cannot overtake.
    assert.equal(holding.length, 1, "two renders at once would arrive in either order");
    holding[0]();
    await settle();
    holding[1]?.();
    await h.speaker.drain!(1_000);
    assert.equal(h.fake.last().proc.written.toString("ascii"), "aabb");
    h.speaker.stop();
  });

  test("one player for the whole conversation", async () => {
    const h = harness();
    h.speaker.speak("One.");
    h.speaker.speak("Two.");
    await h.speaker.drain!(1_000);
    assert.equal(h.fake.spawned.length, 1, "a player per sentence costs ~450ms each");
    h.speaker.stop();
  });

  test("a renderer that gives nothing back is silence, not a crash", async () => {
    const h = harness(async () => null);
    h.speaker.speak("Done.");
    await h.speaker.drain!(1_000);
    assert.equal(h.fake.spawned.length, 0, "nothing to play means nothing to open");
    h.speaker.stop();
  });

  test("says so once when what comes back isn't a wav", async () => {
    const h = harness(async () => Buffer.from("not a wav at all"));
    h.speaker.speak("One.");
    h.speaker.speak("Two.");
    await h.speaker.drain!(1_000);
    assert.equal(h.problems.length, 1, "a broken renderer must not narrate every sentence");
    h.speaker.stop();
  });

  test("nothing is spoken after it stops", async () => {
    const h = harness();
    h.speaker.stop();
    h.speaker.speak("Done.");
    await settle();
    assert.deepEqual(h.asked, [], "a shutting-down service must not start rendering");
  });
});
