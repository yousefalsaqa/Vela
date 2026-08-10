import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  speakable,
  sentences,
  createVoice,
  PRONOUNCE_PHONEMES,
} from "../src/voice.js";

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
