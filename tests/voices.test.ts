import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  cosine,
  blend,
  identify,
  voiceTag,
  describe as describeVoice,
  unit,
  createVoices,
  openVoiceprinter,
  LIMITS,
  MAX_SAMPLES,
  type Heard,
  type Identity,
} from "../src/voices.js";
import { createStore, type Store } from "../src/memory.js";
import { fakeSpawner, settle } from "./helpers/proc.js";

/**
 * Prints are 192 numbers in the real thing. Four is enough to place people
 * exactly where a test needs them: him on one axis, someone else on another,
 * and anything in between by mixing.
 */
const HIM = [1, 0, 0, 0];
const SARAH = [0, 1, 0, 0];
const STRANGER = [0, 0, 1, 0];
const OTHER_STRANGER = [0, 0, 0, 1];
/** A print `score` of the way from `from` towards `to`, as a cosine to `from`. */
const near = (from: number[], to: number[], score: number) =>
  from.map((x, i) => x * score + to[i] * Math.sqrt(1 - score * score));

async function until(check: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`timed out waiting for ${what}`);
}

describe("cosine and blend", () => {
  test("the same direction scores 1 however loud, because loudness is the microphone", () => {
    assert.equal(cosine([1, 2, 3], [2, 4, 6]).toFixed(6), "1.000000");
  });

  test("prints of different lengths never match, so a print from another model is nobody", () => {
    assert.equal(cosine([1, 0], [1, 0, 0]), 0);
  });

  test("an all-zero print stays zero rather than turning into NaN, which would poison any print it touched", () => {
    assert.deepEqual(unit([0, 0, 0]), [0, 0, 0]);
  });

  test("blending averages directions, so a loud sentence does not outvote a quiet one", () => {
    const mixed = blend([{ print: [10, 0] }, { print: [0, 0.1] }]);
    assert.equal(cosine(mixed, [1, 0]).toFixed(3), cosine(mixed, [0, 1]).toFixed(3));
  });
});

describe("identify", () => {
  const known = [
    { name: "Yousef", print: HIM, samples: 3 },
    { name: "Sarah", print: SARAH, samples: 2 },
  ];

  test("close to one saved voice and clearly ahead of the rest is that person", () => {
    const who = identify(near(HIM, STRANGER, 0.7), 2, known);
    assert.equal(who.kind, "known");
    assert.equal((who as { name: string }).name, "Yousef");
  });

  test("two saved people too close to call is nobody, rather than a coin toss between them", () => {
    // Halfway between them scores the same against both. Picking one would be
    // her calling Sarah by his name half the time, with full confidence.
    const who = identify(blend([{ print: HIM }, { print: SARAH }]), 3, known);
    assert.equal(who.kind, "unsure");
  });

  test("far from everyone, with enough voice, is someone new", () => {
    assert.equal(identify(STRANGER, LIMITS.minSpeech + 0.5, known).kind, "new");
  });

  test("far from everyone on a short sentence is not called new", () => {
    // Measured: on one second of speech, one in twenty-five of a person's own
    // utterances scored under the stranger line against their print. Calling
    // those new is her asking him who he is because he said "yes" quickly.
    assert.equal(identify(STRANGER, 1.0, known).kind, "unsure");
  });

  test("between being them and being a stranger is neither", () => {
    const who = identify(near(HIM, STRANGER, 0.38), 3, known);
    assert.equal(who.kind, "unsure", "0.38 is above every wrong person measured and below most right ones");
  });

  test("with nobody saved, a long sentence is new, which is how he is met the first time", () => {
    assert.equal(identify(HIM, 2, []).kind, "new");
  });

  test("too little voice for a print is unsure, not new", () => {
    assert.equal(identify(null, 0.3, known).kind, "unsure");
  });
});

describe("voiceTag", () => {
  test("names someone she knows, and says plainly when the voice is new", () => {
    assert.equal(voiceTag({ kind: "known", name: "Sarah", score: 0.7, speech: 2 }), "[Voice: Sarah]");
    assert.match(voiceTag({ kind: "new", score: 0.1, speech: 2 }), /new/);
  });

  test("says nothing when unsure, so she does not hedge about who he is on every short sentence", () => {
    assert.equal(voiceTag({ kind: "unsure", score: 0.38, speech: 0.8 }), "");
    assert.equal(voiceTag(null), "");
  });
});

describe("the log line", () => {
  // The thresholds came from clean recordings and get set against his real
  // microphone from this line, so it has to carry the score every time, and
  // for an unsure voice the two things that made it unsure: who was nearest,
  // and how little voice there was.
  test("carries the score, and for an unsure voice the nearest person and the length", () => {
    assert.equal(describeVoice({ kind: "known", name: "Yousef", score: 0.623, speech: 2 }), "Yousef 0.62");
    assert.equal(describeVoice({ kind: "new", score: 0.18, speech: 2 }), "new voice 0.18");
    assert.equal(
      describeVoice({ kind: "unsure", score: 0.38, speech: 0.94, nearest: "Yousef" }),
      "voice unsure 0.38 ~Yousef, 0.9s",
    );
    assert.equal(describeVoice(null), "voice unknown");
  });
});

describe("createVoices", () => {
  let store: Store;
  let queue: (Heard | null | Error)[];
  let clock: number;

  const build = () =>
    createVoices({
      store,
      now: () => clock,
      print: async () => {
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return next ?? null;
      },
    });
  /** He said something to her in this voice. */
  const says = async (voices: ReturnType<typeof build>, print: number[], speech = 2.5) => {
    queue.push({ print, speech });
    const who = await voices.listen(Buffer.alloc(2));
    voices.met(who);
    return who;
  };

  beforeEach(() => {
    store = createStore(":memory:");
    queue = [];
    clock = 1_000_000;
  });

  test("a new voice is kept only after remember, which is her having been told yes", async () => {
    const voices = build();
    await says(voices, STRANGER);
    assert.deepEqual(store.listVoices(), [], "a voiceprint is theirs to give, so nothing is saved by hearing it");
    assert.match(voices.remember("Sarah"), /Saved/);
    assert.deepEqual(store.listVoices().map((v) => v.name), ["Sarah"]);
  });

  test("once saved, the same voice is known by name", async () => {
    const voices = build();
    await says(voices, STRANGER);
    voices.remember("Sarah");
    queue.push({ print: near(STRANGER, OTHER_STRANGER, 0.8), speech: 2 });
    const who = await voices.listen(Buffer.alloc(2));
    assert.deepEqual([who.kind, (who as { name?: string }).name], ["known", "Sarah"]);
  });

  test("only a stranger who spoke to her can be saved, not every voice the microphone heard", async () => {
    // Everything the gate cuts is listened to, the television included. A
    // voice that never addressed her is not the one she just asked for a name.
    const voices = build();
    queue.push({ print: STRANGER, speech: 3 });
    await voices.listen(Buffer.alloc(2));
    assert.match(voices.remember("Sarah"), /no new voice/i);
    assert.deepEqual(store.listVoices(), []);
  });

  test("two strangers in one conversation are saved apart: the name goes to the latest", async () => {
    const voices = build();
    await says(voices, OTHER_STRANGER);
    await says(voices, STRANGER);
    voices.remember("Sarah");
    const [sarah] = store.listVoices();
    assert.ok(cosine(sarah.print, STRANGER) > 0.99, "the first stranger blended in is two people under one name");
  });

  test("a name already saved is refused for a voice that is not it, so saying 'I'm Yousef' cannot overwrite him", async () => {
    store.saveVoice("Yousef", HIM, 5);
    const voices = build();
    await says(voices, STRANGER);
    assert.match(voices.remember("yousef"), /Not saved/);
    const [him] = store.listVoices();
    assert.deepEqual([him.print, him.samples], [HIM, 5]);
  });

  test("a voice that is already someone's is not saved again under a second name", async () => {
    // Reachable only when a print sits in the gap: far enough to have been
    // heard as new against a print that has since moved, close enough now.
    const voices = build();
    await says(voices, STRANGER);
    store.saveVoice("Sarah", near(STRANGER, OTHER_STRANGER, 0.9), 2);
    assert.match(voices.remember("Sam"), /already saved as Sarah/);
  });

  test("a confident match on enough voice is folded into their print, so a rough first print improves", async () => {
    store.saveVoice("Yousef", HIM, 1);
    const voices = build();
    const heard = near(HIM, STRANGER, 0.8);
    queue.push({ print: heard, speech: 3 });
    await voices.listen(Buffer.alloc(2));
    const [him] = store.listVoices();
    assert.equal(him.samples, 2);
    assert.ok(cosine(him.print, heard) > 0.8, "the print should have moved towards how he sounds now");
  });

  test("a short sentence is not folded in, so one misheard 'yes' cannot drag his print", async () => {
    store.saveVoice("Yousef", HIM, 1);
    const voices = build();
    queue.push({ print: near(HIM, STRANGER, 0.8), speech: 1 });
    await voices.listen(Buffer.alloc(2));
    assert.deepEqual(store.listVoices()[0].print, HIM);
  });

  test("however long he has been known, the newest sample still counts", async () => {
    // Capped, the print keeps moving with his microphone and his room. An
    // uncapped average of a thousand sentences would stop listening to him.
    store.saveVoice("Yousef", HIM, 500);
    const voices = build();
    queue.push({ print: near(HIM, STRANGER, 0.8), speech: 3 });
    await voices.listen(Buffer.alloc(2));
    const [him] = store.listVoices();
    assert.equal(him.samples, MAX_SAMPLES);
    assert.ok(cosine(him.print, HIM) < 0.9999, "a sample that moves nothing has stopped counting");
  });

  test("a stranger heard ten minutes ago can no longer be saved, because she is not talking to them now", async () => {
    const voices = build();
    await says(voices, STRANGER);
    clock += 11 * 60_000;
    assert.match(voices.remember("Sarah"), /no new voice/i);
  });

  test("a worker that failed is unsure, and the turn goes on as if voices were off", async () => {
    const voices = build();
    queue.push(new Error("worker gone"));
    const who: Identity = await voices.listen(Buffer.alloc(2));
    assert.equal(who.kind, "unsure");
  });

  test("a blank name is not saved, and she is told to ask for one", async () => {
    const voices = build();
    await says(voices, STRANGER);
    assert.match(voices.remember("  "), /No name/);
    assert.deepEqual(store.listVoices(), []);
  });

  test("forgetting a voice removes it, and says so when there was none", async () => {
    store.saveVoice("Sarah", SARAH, 2);
    const voices = build();
    assert.deepEqual(voices.names(), ["Sarah"]);
    assert.match(voices.forget("sarah"), /Forgot/);
    assert.deepEqual(store.listVoices(), []);
    assert.match(voices.forget("Sarah"), /No saved voice/);
  });
});

describe("openVoiceprinter", () => {
  const open = (timeoutMs = 10_000) => {
    const fake = fakeSpawner();
    const problems: string[] = [];
    const printer = openVoiceprinter({
      python: "py",
      worker: "voice_worker.py",
      model: "titanet.onnx",
      spawn: fake.spawn,
      timeoutMs,
      onProblem: (why) => problems.push(why),
    });
    const requests = () => fake.last().proc.lines.map((l) => JSON.parse(l) as { id: number; pcm: string });
    return { fake, printer, problems, requests };
  };

  test("is ready when the worker says so, and not before", async () => {
    const { fake, printer } = open();
    let up: boolean | null = null;
    void printer.ready.then((v) => (up = v));
    await settle();
    assert.equal(up, null);
    fake.last().proc.say("ready");
    await until(() => up === true, "ready");
    printer.stop();
  });

  test("replies find their own utterance by id, whatever order they arrive in", async () => {
    // Matched by position, one missing reply shifts every answer after it onto
    // the sentence before — and here that means the wrong person.
    const { fake, printer, requests } = open();
    const first = printer.print(Buffer.alloc(32));
    const second = printer.print(Buffer.alloc(32));
    await until(() => requests().length === 2, "both requests");
    const [a, b] = requests();
    fake.last().proc.say(`ok ${JSON.stringify({ id: b.id, print: [0, 1], speech: 2 })}`);
    fake.last().proc.say(`ok ${JSON.stringify({ id: a.id, print: [1, 0], speech: 3 })}`);
    assert.deepEqual(await first, { print: [1, 0], speech: 3 });
    assert.deepEqual(await second, { print: [0, 1], speech: 2 });
    printer.stop();
  });

  test("a reply that never comes costs that utterance, not the ones after it", async () => {
    const { fake, printer, requests } = open(20);
    const lost = printer.print(Buffer.alloc(32));
    assert.equal(await lost, null);
    const next = printer.print(Buffer.alloc(32));
    await until(() => requests().length === 2, "the second request");
    fake.last().proc.say(`ok ${JSON.stringify({ id: requests()[1].id, print: [1], speech: 2 })}`);
    assert.deepEqual(await next, { print: [1], speech: 2 });
    printer.stop();
  });

  test("an error on one utterance is that utterance's, and is said", async () => {
    const { fake, printer, problems, requests } = open();
    const bad = printer.print(Buffer.alloc(32));
    await until(() => requests().length === 1, "the request");
    fake.last().proc.say(`err ${JSON.stringify({ id: requests()[0].id, error: "bad audio" })}`);
    assert.equal(await bad, null);
    assert.deepEqual(problems, ["bad audio"]);
    printer.stop();
  });

  test("startup noise is said, and is not taken as anyone's answer", async () => {
    // Whisper's worker had this bug: a warm-up failure printed as an error
    // line was taken as the reply to the first real request, and every reply
    // after it went to the request before.
    const { fake, printer, problems, requests } = open();
    const first = printer.print(Buffer.alloc(32));
    await until(() => requests().length === 1, "the request");
    fake.last().proc.say("err warm-up failed: no model");
    fake.last().proc.say(`ok ${JSON.stringify({ id: requests()[0].id, print: [1], speech: 2 })}`);
    assert.deepEqual(await first, { print: [1], speech: 2 });
    assert.deepEqual(problems, ["warm-up failed: no model"]);
    printer.stop();
  });

  test("a worker that cannot start says so, and is never ready", async () => {
    const { fake, printer, problems } = open();
    fake.last().proc.fail("python not found");
    assert.equal(await printer.ready, false);
    assert.match(problems[0], /python not found/);
    printer.stop();
  });

  test("a worker that dies answers everything waiting with nothing, rather than leaving turns hanging", async () => {
    const { fake, printer } = open();
    const waiting = printer.print(Buffer.alloc(32));
    await settle();
    fake.last().proc.close();
    assert.equal(await waiting, null);
    let up: boolean | null = null;
    void printer.ready.then((v) => (up = v));
    await until(() => up === false, "ready to say it never came up");
  });
});
