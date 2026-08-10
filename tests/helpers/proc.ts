import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import type { Spawner } from "../../src/proc.js";

/**
 * A child process that never existed.
 *
 * Speech, listening and the desktop all work by spawning something, so testing
 * them for real means making noise, opening the microphone, and asserting on
 * whatever happens to be installed. This stands in for the child and lets a
 * test drive both halves: what Vela wrote to it, and what it says back.
 */
export class FakeProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  private exited = false;
  private readonly chunks: Buffer[] = [];

  constructor() {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.chunks.push(Buffer.from(chunk)));
    // Closing the input is what a real player treats as end of stream.
    this.stdin.on("finish", () => this.close());
  }

  /** Everything written to the child, as bytes. */
  get written(): Buffer {
    return Buffer.concat(this.chunks);
  }

  /** Everything written to the child, as the lines it would have read. */
  get lines(): string[] {
    return this.written.toString("utf8").split("\n").filter((l) => l.trim());
  }

  /** Pretend the child printed a line on its protocol channel. */
  say(line: string): void {
    this.stdout.write(`${line}\n`);
  }

  /** Pretend the child couldn't be started at all. */
  fail(message: string): void {
    this.emit("error", new Error(message));
  }

  close(code = 0): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("close", code);
  }

  kill(): boolean {
    this.killed = true;
    this.close();
    return true;
  }
}

export interface Spawned {
  command: string;
  args: string[];
  options: SpawnOptions;
  proc: FakeProcess;
  /** The value of `--voice`, `-ar` and so on, so tests read as intent. */
  flag: (name: string) => string | undefined;
}

/**
 * A `Spawner` that records what would have been run. `behaviour` is called as
 * each child appears, which is where a test scripts what it says back.
 */
export function fakeSpawner(behaviour?: (spawned: Spawned) => void): {
  spawn: Spawner;
  spawned: Spawned[];
  last: () => Spawned;
} {
  const spawned: Spawned[] = [];

  const spawn: Spawner = (command, args, options) => {
    const proc = new FakeProcess();
    const record: Spawned = {
      command,
      args,
      options,
      proc,
      flag: (name) => {
        const at = args.indexOf(name);
        return at < 0 ? undefined : args[at + 1];
      },
    };
    spawned.push(record);
    behaviour?.(record);
    return proc as unknown as ChildProcess;
  };

  return { spawn, spawned, last: () => spawned[spawned.length - 1] };
}

/**
 * Answer a worker's line protocol. `handler` gets each JSON request and
 * returns the status line to send back, or nothing to stay silent.
 */
export function respondToRequests(
  proc: FakeProcess,
  handler: (request: Record<string, string>) => string | undefined,
): void {
  let buffered = "";
  proc.stdin.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (;;) {
      const cut = buffered.indexOf("\n");
      if (cut < 0) break;
      const line = buffered.slice(0, cut).trim();
      buffered = buffered.slice(cut + 1);
      if (!line) continue;
      const reply = handler(JSON.parse(line));
      if (reply !== undefined) proc.say(reply);
    }
  });
}

/** Let queued promises settle. */
export const settle = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
