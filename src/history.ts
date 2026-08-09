import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * What Yousef has had open. "Open that Meet I was on yesterday" needs somewhere
 * to look it up, and the browsers already keep it — Chrome and Edge both store
 * history in SQLite, which node:sqlite reads without any new dependency.
 *
 * Read-only and local. Nothing here leaves the machine.
 */

export interface Visit {
  url: string;
  title: string;
  visits: number;
  lastVisit: Date;
  browser: string;
}

/**
 * Chrome counts microseconds from 1601-01-01, which is 11,644,473,600 seconds
 * before the Unix epoch.
 */
export function chromeTimeToDate(microseconds: number): Date {
  return new Date(microseconds / 1000 - 11_644_473_600_000);
}

export function dateToChromeTime(date: Date): number {
  return (date.getTime() + 11_644_473_600_000) * 1000;
}

/** Where the Chromium-family browsers keep it, newest profile conventions. */
export function historyFiles(
  localAppData = process.env.LOCALAPPDATA ?? "",
): { browser: string; file: string }[] {
  const candidates = [
    ["Chrome", join(localAppData, "Google", "Chrome", "User Data", "Default", "History")],
    ["Edge", join(localAppData, "Microsoft", "Edge", "User Data", "Default", "History")],
    ["Brave", join(localAppData, "BraveSoftware", "Brave-Browser", "User Data", "Default", "History")],
  ] as const;
  return candidates
    .map(([browser, file]) => ({ browser, file }))
    .filter((c) => existsSync(c.file));
}

export interface SearchOptions {
  limit?: number;
  /** Only visits this recent. Omit for all of it. */
  sinceDays?: number;
  /** Override which files to read; tests point this at a fixture. */
  files?: { browser: string; file: string }[];
}

/**
 * Search one history database. Exported separately so it can be tested against
 * a fixture without copying anything.
 */
export function searchOne(
  file: string,
  browser: string,
  query: string,
  opts: SearchOptions = {},
): Visit[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.trim()) {
      where.push("(url LIKE ? OR title LIKE ?)");
      params.push(`%${query}%`, `%${query}%`);
    }
    if (opts.sinceDays) {
      where.push("last_visit_time > ?");
      params.push(dateToChromeTime(new Date(Date.now() - opts.sinceDays * 86_400_000)));
    }
    // Chrome's microsecond timestamps run past 2^53, and node:sqlite refuses to
    // return an integer it can't represent exactly. Reading it as a float costs
    // a couple of microseconds of precision and nothing that matters.
    const sql =
      `SELECT url, title, visit_count,` +
      ` CAST(last_visit_time AS REAL) AS last_visit_time FROM urls` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ORDER BY last_visit_time DESC LIMIT ?`;
    params.push(opts.limit ?? 20);

    const rows = db.prepare(sql).all(...(params as never[])) as unknown as {
      url: string;
      title: string;
      visit_count: number;
      last_visit_time: number;
    }[];

    return rows.map((r) => ({
      url: r.url,
      title: r.title || r.url,
      visits: r.visit_count,
      lastVisit: chromeTimeToDate(r.last_visit_time),
      browser,
    }));
  } finally {
    db.close();
  }
}

/**
 * Search every browser's history. The live file is locked while the browser is
 * running, so each one is copied somewhere disposable first.
 */
export function searchHistory(query: string, opts: SearchOptions = {}): Visit[] {
  const files = opts.files ?? historyFiles();
  const scratch = mkdtempSync(join(tmpdir(), "vela-history-"));
  try {
    const found: Visit[] = [];
    for (const { browser, file } of files) {
      const copy = join(scratch, `${browser}-History`);
      try {
        copyFileSync(file, copy);
        found.push(...searchOne(copy, browser, query, opts));
      } catch {
        continue; // a browser mid-write, or a profile we can't read
      }
    }
    return found
      .sort((a, b) => b.lastVisit.getTime() - a.lastVisit.getTime())
      .slice(0, opts.limit ?? 20);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** How long ago, in words, for something being read aloud or skimmed. */
export function ago(when: Date, now = new Date()): string {
  const minutes = Math.max(0, Math.round((now.getTime() - when.getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days}d ago`;
}
