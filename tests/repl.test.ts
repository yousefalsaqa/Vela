import { test, describe, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { formatStatus, createStatus } from "../src/repl.js";
import {
  isExit,
  interjection,
  streamedText,
  toolActivity,
} from "../src/repl.js";

describe("isExit", () => {
  for (const word of ["exit", "quit", "bye", "  BYE  ", "Quit"]) {
    test(`treats ${JSON.stringify(word)} as a goodbye`, () => {
      assert.equal(isExit(word), true);
    });
  }

  for (const word of ["exits", "goodbye", "quite", "", "exit the loop"]) {
    test(`keeps going on ${JSON.stringify(word)}`, () => {
      assert.equal(isExit(word), false);
    });
  }
});

describe("interjection", () => {
  test("erases the prompt line before writing, on a terminal", () => {
    const out = interjection("Vela", "Build succeeded.", true);
    assert.ok(
      out.startsWith("\r\x1b[2K"),
      "must return to column 0 and clear, or it prints after the prompt",
    );
    assert.match(out, /Vela ›/);
    assert.match(out, /Build succeeded\./);
    assert.ok(out.endsWith("\n"), "must end the line so the prompt redraws below");
  });

  test("emits no escape sequences when the output is piped", () => {
    const out = interjection("Vela", "Build succeeded.", false);
    assert.equal(out, "Vela › Build succeeded.\n");
    assert.doesNotMatch(out, /\x1b/, "escape codes would corrupt a log or a pipe");
  });

  test("honours a renamed assistant", () => {
    assert.match(interjection("Jarvis", "hi", false), /^Jarvis ›/);
  });
});

describe("formatStatus", () => {
  test("shows what it's doing and how long it's been", () => {
    assert.equal(formatStatus("Read index.html", 12_400, 0), "  ⠋ Read index.html · 12s");
  });

  test("floors the seconds rather than rounding up", () => {
    assert.match(formatStatus("x", 999, 0), /· 0s$/);
    assert.match(formatStatus("x", 1_999, 0), /· 1s$/);
  });

  test("cycles the spinner and wraps around", () => {
    const frames = Array.from({ length: 11 }, (_, i) => formatStatus("x", 0, i)[2]);
    assert.equal(new Set(frames).size, 10, "ten distinct frames");
    assert.equal(frames[10], frames[0], "wraps");
  });

  test("survives a negative frame index rather than printing undefined", () => {
    assert.equal(formatStatus("x", 0, -1)[2], formatStatus("x", 0, 9)[2]);
  });

  test("truncates a long label instead of wrapping the line", () => {
    const line = formatStatus("y".repeat(200), 0, 0);
    assert.ok(line.length < 80, `too long: ${line.length}`);
    assert.match(line, /…/);
  });
});

describe("createStatus", () => {
  afterEach(() => mock.timers.reset());

  const harness = (isTty = true) => {
    mock.timers.enable({ apis: ["setInterval"] });
    const written: string[] = [];
    let clock = 0;
    const status = createStatus({
      write: (s) => written.push(s),
      isTty,
      now: () => clock,
      intervalMs: 100,
    });
    return { status, written, advance: (ms: number) => { clock += ms; mock.timers.tick(ms); } };
  };

  test("draws as soon as it is set", () => {
    const { status, written } = harness();
    status.set("thinking");
    assert.equal(written.length, 1);
    assert.match(written[0], /thinking · 0s/);
    status.stop();
  });

  test("redraws in place, never on a new line", () => {
    const { status, written, advance } = harness();
    status.set("thinking");
    advance(300);
    assert.ok(written.length > 1, "should have ticked");
    for (const w of written) {
      assert.ok(w.startsWith("\r\x1b[2K"), "each draw must rewind and clear");
      assert.doesNotMatch(w, /\n/, "a newline would leave a trail of spinners");
    }
    status.stop();
  });

  test("keeps the clock running across a label change", () => {
    const { status, written, advance } = harness();
    status.set("thinking");
    advance(5_000);
    status.set("Read index.html");
    assert.match(written.at(-1)!, /Read index\.html · 5s/, "elapsed is the turn, not the label");
    status.stop();
  });

  test("clear erases the line so someone else can write there", () => {
    const { status, written } = harness();
    status.set("thinking");
    status.clear();
    assert.equal(written.at(-1), "\r\x1b[2K");
  });

  test("clearing twice does not emit a second erase", () => {
    const { status, written } = harness();
    status.set("thinking");
    status.clear();
    const after = written.length;
    status.clear();
    assert.equal(written.length, after);
  });

  test("stop ends the ticking", () => {
    const { status, written, advance } = harness();
    status.set("thinking");
    status.stop();
    const after = written.length;
    advance(1_000);
    assert.equal(written.length, after, "a stopped status must not keep drawing");
  });

  test("works on its own defaults, with no clock or interval supplied", () => {
    const written: string[] = [];
    const status = createStatus({ write: (s) => written.push(s), isTty: true });
    status.set("thinking");
    assert.match(written[0], /thinking · 0s/);
    status.stop();
    assert.equal(written.at(-1), "\r\x1b[2K");
  });

  test("writes nothing at all when the output is piped", () => {
    const { status, written, advance } = harness(false);
    status.set("thinking");
    advance(1_000);
    status.clear();
    status.stop();
    assert.deepEqual(written, [], "escape codes would corrupt a log or a pipe");
  });
});

describe("toolActivity", () => {
  const assistant = (...blocks: unknown[]) => ({
    type: "assistant",
    message: { content: blocks },
  });
  const use = (name: string, input: Record<string, unknown> = {}) => ({
    type: "tool_use",
    name,
    input,
  });

  test("names the file being read, not the whole path", () => {
    assert.deepEqual(
      toolActivity(assistant(use("Read", { file_path: "C:/a/b/index.html" }))),
      ["Read index.html"],
    );
  });

  test("reports every tool in one message, in order", () => {
    assert.deepEqual(
      toolActivity(
        assistant(
          use("Read", { file_path: "a.html" }),
          use("Read", { file_path: "b.html" }),
        ),
      ),
      ["Read a.html", "Read b.html"],
    );
  });

  test("shows the command for a shell call", () => {
    assert.deepEqual(toolActivity(assistant(use("Bash", { command: "ls -la" }))), [
      "Bash ls -la",
    ]);
  });

  test("truncates a long command rather than flooding the terminal", () => {
    const [line] = toolActivity(
      assistant(use("Bash", { command: "x".repeat(200) })),
    );
    assert.ok(line.length <= 70, `too long: ${line.length}`);
    assert.ok(line.endsWith("…"), "should show it was cut");
  });

  test("collapses a command's newlines onto one line", () => {
    assert.deepEqual(
      toolActivity(assistant(use("Bash", { command: "cd x\nnpm test" }))),
      ["Bash cd x npm test"],
    );
  });

  test("shows the pattern for a search", () => {
    assert.deepEqual(
      toolActivity(assistant(use("Grep", { pattern: "TODO" }))),
      ["Grep TODO"],
    );
  });

  test("strips the mcp prefix off Vela's own tools", () => {
    assert.deepEqual(
      toolActivity(assistant(use("mcp__vela__list_windows"))),
      ["list_windows"],
    );
  });

  test("falls back to the bare tool name when there's nothing useful to show", () => {
    assert.deepEqual(toolActivity(assistant(use("SomeNewTool"))), ["SomeNewTool"]);
  });

  const ignored: [string, unknown][] = [
    ["a text block", { type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }],
    ["a result message", { type: "result", result: "done" }],
    ["a stream event", { type: "stream_event", event: {} }],
    ["a message with no content", { type: "assistant", message: {} }],
    ["undefined", undefined],
    ["null", null],
  ];
  for (const [name, msg] of ignored) {
    test(`returns nothing for ${name}`, () => {
      assert.deepEqual(toolActivity(msg), []);
    });
  }
});

describe("streamedText", () => {
  const delta = (text: string) => ({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  });

  test("pulls text out of a text delta", () => {
    assert.equal(streamedText(delta("hello")), "hello");
  });

  test("passes an empty delta through rather than treating it as absent", () => {
    assert.equal(streamedText(delta("")), "");
  });

  const ignored: [string, unknown][] = [
    ["a result message", { type: "result", result: "done" }],
    ["an init message", { type: "system", subtype: "init" }],
    ["a non-text delta", {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta" } },
    }],
    ["a block start", { type: "stream_event", event: { type: "content_block_start" } }],
    ["a stream event with no event", { type: "stream_event" }],
    ["undefined", undefined],
    ["null", null],
  ];
  for (const [name, msg] of ignored) {
    test(`ignores ${name}`, () => {
      assert.equal(streamedText(msg), null);
    });
  }
});
