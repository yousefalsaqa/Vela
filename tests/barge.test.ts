import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createBargeWatcher, isHim } from "../src/barge.js";
import { SAMPLE_RATE } from "../src/listen.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Two real recordings off his laptop, raw and as the canceller left them,
 * 2026-10-02: her starting to talk with him quiet (4s, the canceller's
 * adapting half-second included), and him talking over her (3s, his first
 * words at about 1.5s).
 */
const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/barge/${name}.pcm`, import.meta.url)));

/** A steady tone at a given loudness. */
function tone(ms: number, db: number): Buffer {
  const n = Math.round((SAMPLE_RATE * ms) / 1000);
  const amp = Math.pow(10, db / 20) * 32767 * Math.SQRT2;
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE)), i * 2);
  return out;
}

/**
 * The raw microphone and what the canceller made of it, side by side, at the
 * levels measured on his laptop: the quiet room, her echo as the canceller
 * leaves it, him talking over her, and a TV across the room.
 */
const room = (ms: number) => ({ raw: tone(ms, -62), clean: tone(ms, -62) });
const her = (ms: number) => ({ raw: tone(ms, -34), clean: tone(ms, -64) });
const him = (ms: number) => ({ raw: tone(ms, -30), clean: tone(ms, -33) });
// Over the room's 12dB margin, under the -45 bar: only the loudness bar stops it.
const farTv = (ms: number) => ({ raw: tone(ms, -48), clean: tone(ms, -48) });

function watcher() {
  const stops: { lead: Buffer; loud: number }[] = [];
  const w = createBargeWatcher({ onBarge: (lead, loud) => stops.push({ lead, loud }) });
  const play = (...parts: { raw: Buffer; clean: Buffer }[]) => {
    for (const p of parts) w.push(p.clean, p.raw);
  };
  return { w, stops, play };
}

const RULE = { marginDb: 12, minDb: -45, cancelledDb: 8 };

describe("isHim", () => {
  test("sound the canceller left alone, loud and over the room, is him", () => {
    // One of his real interruptions: raw -31, cleaned -33.
    assert.equal(isHim(-33, -31, -62, RULE), true);
  });

  test("sound the canceller took a lot off was her, however loud it still is", () => {
    // Her echo while it was still adapting: raw -35, cleaned -41.
    assert.equal(isHim(-44, -35, -62, RULE), false);
  });

  test("sound left alone and clear of the room, but quiet, is across the room, not at the laptop", () => {
    assert.equal(isHim(-48, -48, -62, RULE), false);
  });

  test("sound no louder than the room is the room", () => {
    assert.equal(isHim(-40, -40, -35, RULE), false);
  });
});

describe("createBargeWatcher", () => {
  test("him over her stops her about a third of a second in, with his first words", () => {
    const { w, stops, play } = watcher();
    play(room(1_000));
    w.arm();
    play(her(500), him(400));
    assert.equal(stops.length, 1);
    assert.ok(stops[0].lead.length >= tone(300, -30).length, "the lead must carry the words that stopped her");
    assert.equal(w.armed(), false, "stopped once is stopped");
  });

  test("her steady echo, 30dB under what she played, never stops her", () => {
    const { w, stops, play } = watcher();
    play(room(1_000));
    w.arm();
    play(her(5_000));
    assert.equal(stops.length, 0);
  });

  test("a TV across the room doesn't stop her", () => {
    const { w, stops, play } = watcher();
    play(room(1_000));
    w.arm();
    play(farTv(3_000));
    assert.equal(stops.length, 0);
  });

  test("a click or one short word isn't him talking over her", () => {
    const { w, stops, play } = watcher();
    play(room(1_000));
    w.arm();
    play(him(100), room(1_000));
    assert.equal(stops.length, 0);
  });

  test("a breath in the middle doesn't start the count again", () => {
    const { w, stops, play } = watcher();
    play(room(1_000));
    w.arm();
    play(him(200), room(200), him(150));
    assert.equal(stops.length, 1);
  });

  test("not armed, nothing stops her: she isn't talking", () => {
    const { w, stops, play } = watcher();
    play(room(1_000), him(1_000));
    assert.equal(stops.length, 0);
    void w;
  });

  test("the room is learned while she's quiet, so it's ready the moment she starts", () => {
    const { w, stops, play } = watcher();
    play(room(1_000));
    w.arm();
    play(him(400));
    assert.equal(stops.length, 1);
  });

  test("audio arriving in odd sizes is still judged in whole moments", () => {
    const { w, stops } = watcher();
    const r = room(1_000);
    w.push(r.clean, r.raw);
    w.arm();
    const h = him(400);
    for (let at = 0; at < h.raw.length; at += 333) w.push(h.clean.subarray(at, at + 333), h.raw.subarray(at, at + 333));
    assert.equal(stops.length, 1);
  });

  describe("on his real recordings", () => {
    /** Feed a recording in 10ms pieces, as the canceller hands it over, armed from the start. */
    const replay = (raw: Buffer, clean: Buffer) => {
      const stops: number[] = [];
      let at = 0;
      const w = createBargeWatcher({ onBarge: () => stops.push(at / 2 / SAMPLE_RATE) });
      w.arm();
      for (; at + 320 <= Math.min(raw.length, clean.length); at += 320) w.push(clean.subarray(at, at + 320), raw.subarray(at, at + 320));
      return stops;
    };

    test("her starting to talk, canceller still adapting, him quiet: she isn't stopped", () => {
      assert.deepEqual(replay(fixture("quiet-raw"), fixture("quiet-clean")), []);
    });

    test("him talking over her: she's stopped within about half a second of his first words", () => {
      const stops = replay(fixture("over-raw"), fixture("over-clean"));
      assert.equal(stops.length, 1);
      assert.ok(stops[0] > 1.4 && stops[0] < 2.1, `stopped at ${stops[0]}s; his first words are at about 1.5s`);
    });
  });
});
