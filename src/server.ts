import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreEvent } from "./core.js";

/**
 * Vela as a local service, so she outlives the window you started her from and
 * can wear more than one face — the REPL now, a voice loop next.
 *
 * Bound to 127.0.0.1 and gated on a token written to disk beside the database.
 * The core runs with bypassPermissions and has the whole machine, so "only
 * local" is not on its own a good enough door.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ENDPOINT_FILE = resolve(here, "../data/server.json");

export interface Endpoint {
  port: number;
  token: string;
  pid: number;
}

/** What the server needs from the core — kept narrow so tests can fake it. */
export interface ServableCore {
  send: (text: string) => void;
  subscribe: (listener: (event: CoreEvent) => void) => () => void;
  isBusy: () => boolean;
}

export function readEndpoint(file = ENDPOINT_FILE): Endpoint | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Endpoint;
  } catch {
    return null; // not running, or never has
  }
}

export interface ServeOptions {
  core: ServableCore;
  port?: number;
  /** Where to advertise the endpoint. Tests point this somewhere disposable. */
  endpointFile?: string;
  name?: string;
}

export interface RunningServer {
  endpoint: Endpoint;
  close: () => Promise<void>;
}

export function serve(opts: ServeOptions): Promise<RunningServer> {
  const endpointFile = opts.endpointFile ?? ENDPOINT_FILE;
  const token = randomBytes(24).toString("hex");
  const name = opts.name ?? "Vela";
  const clients = new Set<{ write: (chunk: string) => void }>();

  const authed = (auth: string | undefined) => auth === `Bearer ${token}`;

  const server: Server = createServer((req, res) => {
    const url = req.url ?? "/";

    if (!authed(req.headers.authorization)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad or missing token" }));
      return;
    }

    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ name, busy: opts.core.isBusy(), pid: process.pid }));
      return;
    }

    // Everything the core does, as it happens.
    if (req.method === "GET" && url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const client = { write: (chunk: string) => res.write(chunk) };
      clients.add(client);
      req.on("close", () => clients.delete(client));
      return;
    }

    if (req.method === "POST" && url === "/turn") {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const { text } = JSON.parse(body || "{}") as { text?: string };
          if (!text?.trim()) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "text is required" }));
            return;
          }
          opts.core.send(text);
          res.writeHead(202, { "content-type": "application/json" });
          res.end(JSON.stringify({ accepted: true }));
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "body must be JSON" }));
        }
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no such route" }));
  });

  const unsubscribe = opts.core.subscribe((event) => {
    const frame = `data: ${JSON.stringify(event)}\n\n`;
    for (const c of [...clients]) {
      try {
        c.write(frame);
      } catch {
        clients.delete(c); // a client that hung up mustn't take the rest down
      }
    }
  });

  return new Promise((fulfil) => {
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const endpoint: Endpoint = { port, token, pid: process.pid };

      mkdirSync(dirname(endpointFile), { recursive: true });
      writeFileSync(endpointFile, JSON.stringify(endpoint, null, 2));

      fulfil({
        endpoint,
        close: () =>
          new Promise<void>((done) => {
            unsubscribe();
            for (const c of clients) {
              try {
                (c as { end?: () => void }).end?.();
              } catch {
                /* already gone */
              }
            }
            clients.clear();
            try {
              rmSync(endpointFile, { force: true });
            } catch {
              /* nothing to clean up */
            }
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}
