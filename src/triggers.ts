import { watch as fsWatch } from "node:fs";
import { isProcessRunning } from "./desktop.js";
import type { Store } from "./memory.js";

/**
 * Event-driven watches. The heartbeat's timer is a floor, not the only way a
 * watch gets looked at: a build log that stops being written to, or a process
 * that exits, wakes its watch immediately.
 *
 * Nothing here calls the model. It decides *when* a check is worth making;
 * ambient.ts decides what to say. Waiting is free.
 */

/** The outside world, injected so the tests can drive it. */
export interface TriggerSource {
  /** Call `onChange` whenever the file is written to. Returns a release fn. */
  watchFile(path: string, onChange: () => void): () => void;
  isProcessRunning(name: string): Promise<boolean>;
}

const realWorld: TriggerSource = {
  watchFile(path, onChange) {
    const watcher = fsWatch(path, () => onChange());
    return () => watcher.close();
  },
  isProcessRunning: (name) => isProcessRunning(name),
};

export interface TriggerOptions {
  store: Pick<Store, "listWatches">;
  /** Run a heartbeat check for exactly these watches. */
  onFire: (ids: number[]) => Promise<void> | void;
  source?: TriggerSource;
  /** How often to re-read the watch list and probe processes. */
  pollMs?: number;
  /** Quiet period after the last write before a file counts as settled. */
  debounceMs?: number;
  /** Minimum gap between checks of the same watch. Protects the token budget. */
  cooldownMs?: number;
}

export function startTriggers(opts: TriggerOptions): () => void {
  const source = opts.source ?? realWorld;
  const pollMs = opts.pollMs ?? 15_000;
  const debounceMs = opts.debounceMs ?? 2_000;
  const cooldownMs = opts.cooldownMs ?? 60_000;

  const files = new Map<
    number,
    { path: string; release: () => void; settle?: NodeJS.Timeout }
  >();
  const procs = new Map<number, { name: string; wasRunning: boolean }>();
  const cooling = new Set<number>();
  let stopped = false;

  /**
   * Ask for a check of one watch. Returns false when the cooldown swallowed
   * it — the caller keeps its "something changed" state in that case, so the
   * edge is re-detected rather than lost.
   */
  function fire(id: number): boolean {
    if (stopped || cooling.has(id)) return false;
    cooling.add(id);
    const timer = setTimeout(() => cooling.delete(id), cooldownMs);
    timer.unref?.();
    // A failing check must not take the trigger loop down with it.
    Promise.resolve(opts.onFire([id])).catch(() => {});
    return true;
  }

  function detachFile(id: number): void {
    const entry = files.get(id);
    if (!entry) return;
    clearTimeout(entry.settle);
    entry.release();
    files.delete(id);
  }

  function attachFile(id: number, path: string): void {
    let release: () => void;
    try {
      release = source.watchFile(path, () => {
        const entry = files.get(id);
        if (!entry) return;
        // Restart the clock on every write, so a log being appended to
        // continuously fires once — when it goes quiet — not per line.
        clearTimeout(entry.settle);
        entry.settle = setTimeout(() => fire(id), debounceMs);
        entry.settle.unref?.();
      });
    } catch {
      // The file may not exist yet; the next poll tries again.
      return;
    }
    files.set(id, { path, release });
  }

  async function reconcile(): Promise<void> {
    if (stopped) return;

    const active = opts.store.listWatches();
    const live = new Set<number>();

    for (const w of active) {
      if (w.trigger_kind === "file") {
        live.add(w.id);
        if (files.get(w.id)?.path !== w.trigger_arg) {
          detachFile(w.id);
          attachFile(w.id, w.trigger_arg);
        }
      } else if (w.trigger_kind === "process") {
        live.add(w.id);
        if (procs.get(w.id)?.name !== w.trigger_arg) {
          procs.set(w.id, { name: w.trigger_arg, wasRunning: false });
        }
      }
    }

    // Resolved or retriggered watches let go of their handles.
    for (const id of [...files.keys()]) if (!live.has(id)) detachFile(id);
    for (const id of [...procs.keys()]) if (!live.has(id)) procs.delete(id);

    for (const [id, proc] of procs) {
      let running: boolean;
      try {
        running = await source.isProcessRunning(proc.name);
      } catch {
        continue; // A failed probe means unknown, not exited.
      }
      if (stopped) return;
      if (proc.wasRunning && !running) {
        // Only forget it was running once the check actually went out.
        if (fire(id)) proc.wasRunning = false;
      } else {
        proc.wasRunning = running;
      }
    }
  }

  void reconcile();
  const poll = setInterval(() => void reconcile(), pollMs);
  poll.unref?.();

  return () => {
    stopped = true;
    clearInterval(poll);
    for (const id of [...files.keys()]) detachFile(id);
    procs.clear();
  };
}
