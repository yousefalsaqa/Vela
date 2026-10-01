import type { ChildProcess } from "node:child_process";
import { spawn as realSpawn, type Spawner } from "./proc.js";

/**
 * Her hub in a window of her own, made once and shown when she is called.
 *
 * See scripts/window_worker.py for why it is not a browser tab any more. What
 * this side owns is the protocol and the one piece of state worth having: is
 * she on his screen right now. That answer comes from the worker, never from
 * what was last asked for, because he can close the window himself.
 */
export interface DeskWindow {
  /** Resolves true once the window exists; false if it never will. */
  ready: Promise<boolean>;
  /** Put her in front of him. False when there is no window to show. */
  show: () => boolean;
  /** Put her away. She stays loaded behind it. */
  hide: () => void;
  /** On his screen, as of the worker's last word. */
  showing: () => boolean;
  stop: () => void;
}

export function openWindow(opts: {
  python: string;
  worker: string;
  url: string;
  title: string;
  width?: number;
  height?: number;
  /** Where WebView2 keeps the page's storage between runs. */
  storage: string;
  /** He closed it himself, rather than her putting it away. */
  onClosedByHim?: () => void;
  onProblem?: (why: string) => void;
  spawn?: Spawner;
}): DeskWindow {
  const spawn = opts.spawn ?? realSpawn;
  let proc: ChildProcess | null = null;
  let stopped = false;
  let visible = false;
  /** Hides asked for and not yet answered, so his own close can be told apart. */
  let hidesAsked = 0;

  let settle: ((up: boolean) => void) | null = null;
  const ready = new Promise<boolean>((resolve) => (settle = resolve));
  const up = (ok: boolean) => {
    settle?.(ok);
    settle = null;
  };

  const child = spawn(
    opts.python,
    [
      opts.worker,
      opts.url,
      opts.title,
      String(opts.width ?? 1280),
      String(opts.height ?? 820),
      opts.storage,
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
  );

  let rest = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    rest += chunk.toString("utf8");
    const lines = rest.split(/\r?\n/);
    rest = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (line === "ready") up(true);
      else if (line === "shown") visible = true;
      else if (line === "hidden") {
        visible = false;
        if (hidesAsked > 0) hidesAsked--;
        else opts.onClosedByHim?.();
      } else if (line.startsWith("err ")) opts.onProblem?.(line.slice(4));
    }
  });
  child.on("error", (err) => {
    proc = null;
    up(false);
    opts.onProblem?.(`couldn't open her window: ${err.message}`);
  });
  child.on("close", () => {
    proc = null;
    visible = false;
    up(false);
    if (!stopped) opts.onProblem?.("her window closed; she'll open in the browser instead");
  });
  child.stdin?.on("error", () => {});
  proc = child;

  const send = (command: string): boolean => {
    if (stopped || !proc?.stdin?.writable) return false;
    proc.stdin.write(`${command}\n`);
    return true;
  };

  return {
    ready,
    show: () => send("show"),
    hide() {
      if (send("hide")) hidesAsked++;
    },
    showing: () => visible,
    stop() {
      send("quit");
      stopped = true;
      proc?.stdin?.end();
      // A window that does not go when asked is killed: one left behind by a
      // stopped service is a face with nobody behind it.
      const p = proc;
      setTimeout(() => p?.kill(), 3_000).unref?.();
      proc = null;
    },
  };
}
