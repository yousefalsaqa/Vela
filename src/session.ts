/**
 * A queue of user turns feeding one long-lived SDK query.
 *
 * Vela used to call `query()` once per turn and resume by session id, which
 * spawned a CLI subprocess and re-loaded the transcript every time — turn three
 * cost more than twice turn two, and kept climbing. Streaming input keeps a
 * single process alive, so the cost per turn stays flat.
 */

export interface UserTurn {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

export interface TurnQueue {
  /** Hand a turn to the running session. */
  send: (text: string) => void;
  /** Stop the stream, ending the session's input. */
  end: () => void;
  /** The stream handed to `query({ prompt })`. */
  stream: () => AsyncGenerator<UserTurn>;
}

export function createTurnQueue(): TurnQueue {
  const pending: UserTurn[] = [];
  let wake: (() => void) | null = null;
  let ended = false;

  const nudge = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  return {
    send(text: string) {
      if (ended) return;
      pending.push({
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        session_id: "",
      });
      nudge();
    },

    end() {
      ended = true;
      nudge();
    },

    async *stream() {
      while (true) {
        // Drain what's queued before waiting again, so a burst keeps its order.
        while (pending.length) yield pending.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}
