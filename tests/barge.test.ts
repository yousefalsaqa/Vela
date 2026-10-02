import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createBargeWatcher, mayStopHer } from "../src/barge.js";
import { SAMPLE_RATE } from "../src/listen.js";
import type { Identity } from "../src/voices.js";

/** A steady tone at a given loudness, as the cleaned microphone would deliver it. */
function tone(ms: number, db: number): Buffer {
  const n = Math.round((SAMPLE_RATE * ms) / 1000);
  const amp = Math.pow(10, db / 20) * 32767 * Math.SQRT2;
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE)), i * 2);
  return out;
}
// Measured on his laptop through the canceller: the room -60, what is left of
// her while she talks about the same, his voice -35.
const room = (ms: number) => tone(ms, -60);
const her = (ms: number) => tone(ms, -55);
const him = (ms: number) => tone(ms, -35);

const yousef: Identity = { kind: "known", name: "Yousef", score: 0.7, speech: 0.6 };
const tv: Identity = { kind: "unsure", score: 0.12, speech: 0.6, nearest: "Yousef" };

/** A watcher whose voice check is scripted, and which records what it was asked. */
function watcher(answer: () => Promise<Identity | null> = async () => yousef) {
  const asked: Buffer[] = [];
  const stops: { lead: Buffer; who: Identity }[] = [];
  const w = createBargeWatcher({
    who: (pcm) => {
      asked.push(pcm);
      return answer();
    },
    threshold: 0.3,
    onBarge: (lead, who) => stops.push({ lead, who }),
  });
  return { w, asked, stops };
}

const settle = () => new Promise((r) => setImmediate(r));

describe("mayStopHer", () => {
  test("someone she knows stops her", () => {
    assert.equal(mayStopHer(yousef, 0.3), true);
  });

  test("a short clip of him that only leans his way still stops her", () => {
    // His own half-second clips scored "unsure, nearest Yousef" at 0.34-0.46.
    assert.equal(mayStopHer({ kind: "unsure", score: 0.34, speech: 0.6, nearest: "Yousef" }, 0.3), true);
  });

  test("a voice leaning nowhere much, the TV or what's left of her, doesn't", () => {
    assert.equal(mayStopHer(tv, 0.3), false);
    assert.equal(mayStopHer({ kind: "unsure", score: 0.5, speech: 0.6 }, 0.3), false, "no one nearest is no one she knows");
    assert.equal(mayStopHer({ kind: "new", score: 0.1, speech: 2 }, 0.3), false);
    assert.equal(mayStopHer(null, 0.3), false);
  });
});

describe("createBargeWatcher", () => {
  test("his voice over her stops her, with what he said from just before he started", async () => {
    const { w, asked, stops } = watcher();
    w.push(room(1_000));
    w.arm();
    w.push(her(500));
    w.push(him(400));
    await settle();
    assert.equal(asked.length, 1);
    assert.equal(stops.length, 1);
    assert.equal(stops[0].who, yousef);
    // His first syllables are in the lead, and some of the moment before.
    assert.ok(stops[0].lead.length >= him(300).length, "the lead must carry the words that triggered it");
    assert.equal(w.armed(), false, "stopped once is stopped");
  });

  test("not armed, nothing is checked however loud: she isn't talking", async () => {
    const { w, asked } = watcher();
    w.push(room(1_000));
    w.push(him(1_000));
    await settle();
    assert.equal(asked.length, 0);
  });

  test("what's left of her echo never starts a check", async () => {
    // The point of cancelling it first: under the bar, her own voice is not
    // a voice to ask about.
    const { w, asked } = watcher();
    w.push(room(1_000));
    w.arm();
    w.push(her(3_000));
    await settle();
    assert.equal(asked.length, 0);
  });

  test("a click or one short word isn't worth asking about", async () => {
    const { w, asked } = watcher();
    w.push(room(1_000));
    w.arm();
    w.push(him(100));
    w.push(room(500));
    await settle();
    assert.equal(asked.length, 0);
  });

  test("a voice she doesn't know doesn't stop her, and isn't asked about again until it pauses", async () => {
    // The TV talking for a minute would otherwise be a voiceprint every 300ms.
    const { w, asked, stops } = watcher(async () => tv);
    w.push(room(1_000));
    w.arm();
    w.push(him(400));
    await settle();
    w.push(him(2_000));
    await settle();
    assert.equal(asked.length, 1);
    assert.equal(stops.length, 0);
    w.push(room(400));
    w.push(him(400));
    await settle();
    assert.equal(asked.length, 2, "a new voice after a pause is checked afresh");
  });

  test("an answer that comes back after she stopped talking lands nowhere", async () => {
    let answer!: (who: Identity) => void;
    const { w, stops } = watcher(() => new Promise((r) => (answer = r)));
    w.push(room(1_000));
    w.arm();
    w.push(him(400));
    w.disarm();
    answer(yousef);
    await settle();
    assert.equal(stops.length, 0, "stopping a reply that already ended would cut the next one");
  });

  test("the room is learned while she's quiet, so it's ready the moment she starts", async () => {
    const { w, asked } = watcher();
    w.push(room(1_000));
    w.arm();
    w.push(him(400));
    await settle();
    assert.equal(asked.length, 1);
  });

  test("a failed voice check is no, not a crash and not a stop", async () => {
    const { w, stops } = watcher(() => Promise.reject(new Error("worker gone")));
    w.push(room(1_000));
    w.arm();
    w.push(him(400));
    await settle();
    await settle();
    assert.equal(stops.length, 0);
  });
});
