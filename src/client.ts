import { request as httpRequest, Agent, type IncomingMessage } from "node:http";
import type { CoreEvent } from "./core.js";
import { readEndpoint, type Endpoint } from "./server.js";

/**
 * The other end of server.ts. Presents the same shape the REPL already uses
 * for an embedded core, so index.ts doesn't care which it got.
 *
 * Deliberately node:http and not fetch. Node's fetch pools connections per
 * origin, so the open /events response — which by design never ends — sits at
 * the head of the queue and every POST /turn behind it is never sent. The
 * symptom is an attached client that connects happily and then hears nothing
 * for ever. keepAlive: false gives each request its own socket.
 */

const agent = new Agent({ keepAlive: false });

export interface RemoteCore {
  send: (text: string) => void;
  subscribe: (listener: (event: CoreEvent) => void) => () => void;
  isBusy: () => boolean;
  stop: () => void;
}

/** Split an SSE stream into whole `data:` payloads. */
export function parseFrames(buffer: string): { events: string[]; rest: string } {
  const events: string[] = [];
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? ""; // last piece may be half a frame
  for (const part of parts) {
    for (const line of part.split("\n")) {
      if (line.startsWith("data: ")) events.push(line.slice(6));
    }
  }
  return { events, rest };
}

function call(
  endpoint: Endpoint,
  path: string,
  method: "GET" | "POST",
  body?: string,
  timeoutMs = 5_000,
): Promise<{ status: number; text: string }> {
  return new Promise((fulfil, fail) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: endpoint.port,
        path,
        method,
        agent,
        headers: {
          authorization: `Bearer ${endpoint.token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => fulfil({ status: res.statusCode ?? 0, text }));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timed out")));
    req.on("error", fail);
    req.end(body);
  });
}

/** Is a server up and answering with this token? */
export async function reachable(endpoint: Endpoint): Promise<boolean> {
  try {
    const { status } = await call(endpoint, "/health", "GET", undefined, 1_000);
    return status === 200;
  } catch {
    return false; // stale endpoint file, wrong token, nobody home
  }
}

export async function connect(endpoint: Endpoint): Promise<RemoteCore> {
  const listeners = new Set<(event: CoreEvent) => void>();
  let busy = false;

  const req = httpRequest({
    host: "127.0.0.1",
    port: endpoint.port,
    path: "/events",
    method: "GET",
    agent,
    headers: { authorization: `Bearer ${endpoint.token}`, accept: "text/event-stream" },
  });

  const res = await new Promise<IncomingMessage>((fulfil, fail) => {
    req.on("response", fulfil);
    req.on("error", fail);
    req.end();
  });

  if (res.statusCode !== 200) {
    req.destroy();
    throw new Error(`could not open the event stream (${res.statusCode})`);
  }

  let buffer = "";
  res.setEncoding("utf8");
  res.on("data", (chunk: string) => {
    buffer += chunk;
    const { events, rest } = parseFrames(buffer);
    buffer = rest;
    for (const raw of events) {
      let event: CoreEvent;
      try {
        event = JSON.parse(raw) as CoreEvent;
      } catch {
        continue; // a half-written frame is not worth crashing over
      }
      if (event.type === "result" || event.type === "error") busy = false;
      for (const l of [...listeners]) l(event);
    }
  });
  // The stream ending means the service went away; nothing useful to say.
  res.on("error", () => {});

  return {
    send(text: string) {
      busy = true;
      void call(endpoint, "/turn", "POST", JSON.stringify({ text })).catch(() => {
        busy = false;
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isBusy: () => busy,
    stop() {
      listeners.clear();
      res.destroy();
      req.destroy();
    },
  };
}

/** Connect to a running Vela, or null if there isn't one. */
export async function connectIfRunning(): Promise<RemoteCore | null> {
  const endpoint = readEndpoint();
  if (!endpoint || !(await reachable(endpoint))) return null;
  return connect(endpoint);
}
