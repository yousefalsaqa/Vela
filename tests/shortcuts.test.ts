import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { bare, tvIntent, couldBeLaptop, worked, didLine, STEP, type TvIntent } from "../src/shortcuts.js";

describe("bare", () => {
  test("takes the politeness off both ends, however much of it there is", () => {
    assert.equal(bare("Okay, can you pause it please?"), "pause it");
    assert.equal(bare("Um, so could you just turn off the TV for me, thanks."), "turn off the tv");
  });

  test("leaves a word that is part of the command alone", () => {
    assert.equal(bare("Play."), "play");
  });
});

describe("tvIntent", () => {
  const cases: [string, TvIntent][] = [
    // What he actually said in his first session with the TV tools.
    ["Can you pause it?", { kind: "remote", button: "pause" }],
    ["can you turn off the TV?", { kind: "power", on: false }],
    ["Pause the show.", { kind: "remote", button: "pause" }],
    ["Play.", { kind: "remote", button: "play" }],
    ["Resume it.", { kind: "remote", button: "play" }],
    ["Unpause Netflix", { kind: "remote", button: "play" }],
    ["Resume my show.", { kind: "resume" }],
    ["Put on what I was watching on the TV.", { kind: "resume" }],
    ["Turn the TV on.", { kind: "power", on: true }],
    ["TV off", { kind: "power", on: false }],
    ["Mute it.", { kind: "volume", mute: true }],
    ["Unmute.", { kind: "volume", mute: false }],
    ["Louder.", { kind: "volume", by: STEP.plain }],
    ["A bit louder please.", { kind: "volume", by: STEP.little }],
    ["Turn it down a little.", { kind: "volume", by: -STEP.little }],
    ["Turn the volume up.", { kind: "volume", by: STEP.plain }],
    ["Way louder.", { kind: "volume", by: STEP.lot }],
    ["Quieter.", { kind: "volume", by: -STEP.plain }],
    ["Volume down.", { kind: "volume", by: -STEP.plain }],
    ["Set the volume to 20.", { kind: "volume", to: 20 }],
  ];
  for (const [said, intent] of cases) {
    test(`"${said}"`, () => assert.deepEqual(tvIntent(said), intent));
  }

  test("anything more than the command goes to the model, because a wrong shortcut does something he didn't ask", () => {
    for (const said of [
      "Pause it, I want to ask you something.",
      "Okay, so from now on when I say pause or play you don't need to tell me.",
      "What does pause mean?",
      "Play some music.",
      "Turn it off.", // the laptop's music as easily as the TV
      "Turn off the lights.",
      "Resume the download.",
      "How are you?",
      "",
    ]) {
      assert.equal(tvIntent(said), null, `"${said}" was taken as a TV command`);
    }
  });
});

describe("couldBeLaptop", () => {
  test("a bare pause or play could be Spotify, so it waits on whether the TV is on", () => {
    assert.equal(couldBeLaptop("Pause it.", { kind: "remote", button: "pause" }), true);
    assert.equal(couldBeLaptop("Play.", { kind: "remote", button: "play" }), true);
  });

  test("naming the TV or the show settles it", () => {
    assert.equal(couldBeLaptop("Pause the TV.", { kind: "remote", button: "pause" }), false);
    assert.equal(couldBeLaptop("Unpause Netflix", { kind: "remote", button: "play" }), false);
  });

  test("only play and pause are ambiguous; the rest only exist on the TV", () => {
    assert.equal(couldBeLaptop("Louder.", { kind: "volume", by: 5 }), false);
    assert.equal(couldBeLaptop("Resume my show.", { kind: "resume" }), false);
  });
});

describe("worked", () => {
  test("'The TV is off.' is a turn-off done and a pause that never happened", () => {
    // The flaw this exists to prevent: one success test for every action
    // would stay quiet when he asked for a pause and the TV was off.
    assert.equal(worked({ kind: "power", on: false }, "The TV is off."), true);
    assert.equal(worked({ kind: "remote", button: "pause" }, "The TV is off."), false);
    assert.equal(worked({ kind: "volume", by: 5 }, "The TV is off, so there's no volume to change."), false);
  });

  test("already being so counts: he wanted it muted, and it is", () => {
    assert.equal(worked({ kind: "volume", mute: true }, "It's already muted."), true);
    assert.equal(worked({ kind: "power", on: false }, "The TV is already off."), true);
  });

  test("a resume that played somewhere other than his spot is not quietly accepted", () => {
    assert.equal(worked({ kind: "resume" }, 'Playing The Mentalist, S2 E10 "Throwing Fire" from 22:49.'), true);
    assert.equal(worked({ kind: "resume" }, "Netflix is playing, but at 5:00, not where you left The Mentalist (22:51)."), false);
  });
});

describe("didLine", () => {
  test("says what she did in words the model can carry into its next turn", () => {
    assert.equal(didLine({ kind: "remote", button: "pause" }), "paused the TV");
    assert.equal(didLine({ kind: "volume", by: -3 }), "turned the TV down");
    assert.equal(didLine({ kind: "volume", to: 20 }), "set the TV volume to 20");
    assert.equal(didLine({ kind: "volume", mute: true }), "muted the TV");
    assert.equal(didLine({ kind: "power", on: true }), "turned the TV on");
    assert.equal(didLine({ kind: "resume" }), "resumed his show on Netflix");
  });
});
