import { test, describe, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { createFiller } from "../src/filler.js";

describe("createFiller", () => {
  let said: number;
  let clock: number;
  const build = (afterMs = 1_500) =>
    createFiller({ afterMs, now: () => clock, say: () => (said += 1) });

  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout"] });
    said = 0;
    clock = 10_000;
  });
  afterEach(() => mock.timers.reset());

  test("a reply that starts in time is never preceded by a filler", () => {
    // The complaint this exists for: "one sec" in front of every answer,
    // including the ones that took half a second.
    const filler = build();
    filler.expect(clock);
    mock.timers.tick(900);
    filler.started();
    mock.timers.tick(5_000);
    assert.equal(said, 0);
  });

  test("silence that runs past the wait is filled, once", () => {
    const filler = build();
    filler.expect(clock);
    mock.timers.tick(1_500);
    filler.expect(clock);
    mock.timers.tick(5_000);
    assert.equal(said, 1, "two fillers in one turn is her stalling, not her having heard");
  });

  test("the wait counts from when the gate closed, not from when whisper finished", () => {
    // A follow-up is only known to be one once whisper has read it, half a
    // second after the close. That half second is silence he already sat
    // through, and it counts.
    const filler = build();
    const closed = clock;
    clock += 500;
    filler.expect(closed);
    mock.timers.tick(999);
    assert.equal(said, 0);
    mock.timers.tick(1);
    assert.equal(said, 1);
  });

  test("going to a tool with nothing said fills at once, because that silence will be long", () => {
    const filler = build();
    filler.expect(clock);
    mock.timers.tick(200);
    filler.working();
    assert.equal(said, 1);
    mock.timers.tick(5_000);
    assert.equal(said, 1);
  });

  test("going to a tool after she has started talking needs nothing: she said her own opener", () => {
    const filler = build();
    filler.expect(clock);
    filler.started();
    filler.working();
    assert.equal(said, 0);
  });

  test("a turn that turned out not to be one is never filled", () => {
    // "Hey Vela, you can go now" closes like a question and is a goodbye.
    // Filling it was her saying "hang on" to him leaving.
    const filler = build();
    filler.expect(clock);
    filler.reset();
    mock.timers.tick(5_000);
    assert.equal(said, 0);
  });

  test("each turn gets its own chance, so one filled turn does not silence the next", () => {
    const filler = build();
    filler.expect(clock);
    mock.timers.tick(1_500);
    filler.reset();
    clock += 20_000;
    filler.expect(clock);
    mock.timers.tick(1_500);
    assert.equal(said, 2);
  });
});
