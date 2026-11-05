import { z } from "zod";
import type { BoardPage } from "./board-page";

type FetchBatch = (url: string, init: RequestInit) => Promise<Response>;
const ORIGIN = "https://explore.jobs.netflix.net";
const BATCH_SIZE = 10;
const searchOptions = new Set(["domain", "pid", "start", "num", "sort_by", "triggerGoButton"]);
const position = z.object({
  id: z.union([z.number().int().positive().safe(), z.string().regex(/^[1-9]\d*$/)]),
  name: z.string().trim().min(1), canonicalPositionUrl: z.string(),
  department: z.string().nullish(), location: z.string().nullish(), locations: z.array(z.string()).nullish(),
  isPrivate: z.literal(false).optional(),
});
const results = z.object({
  domain: z.literal("netflix.com"), query: z.record(z.unknown()),
  count: z.number().int().nonnegative().safe(), positions: z.array(position).max(BATCH_SIZE),
});

export function isNetflixSearch(url: URL) {
  return url.origin === ORIGIN && /^\/careers\/?$/.test(url.pathname);
}

export function isNetflixPosition(url: URL) {
  return url.origin === ORIGIN && !url.username && !url.password && /^\/careers\/job\/[1-9]\d*\/?$/.test(url.pathname);
}

function checkFilters(saved: URL, applied: Record<string, unknown>) {
  for (const key of new Set(saved.searchParams.keys())) {
    if (searchOptions.has(key) || /^utm_/i.test(key)) continue;
    const wanted = saved.searchParams.getAll(key).sort();
    const value = applied[key];
    const actual = typeof value === "string" ? [value] : Array.isArray(value) ? [...value] : [];
    if (actual.some(item => typeof item !== "string") || JSON.stringify(actual.sort()) !== JSON.stringify(wanted)) {
      throw new Error(`Netflix did not confirm the saved ${key} filter. Try checking the board again.`);
    }
  }
}

// Netflix's Show More Positions button requests another batch. Each response
// includes the applied search, its full count, and canonical URLs for that batch.
export class NetflixBoardPages {
  private offset = 0;
  private pageNumber = 1;
  private nextOffset: number | null = null;
  private readonly board: URL;
  private readonly request: FetchBatch;
  private readonly signal: AbortSignal;
  constructor(board: URL, request: FetchBatch, signal: AbortSignal) {
    if (!isNetflixSearch(board) || board.hash || board.searchParams.getAll("domain").some(domain => domain !== "netflix.com")) {
      throw new Error("Use the filtered Netflix careers search link.");
    }
    this.board = board; this.request = request; this.signal = signal;
  }

  async read(): Promise<BoardPage> {
    this.signal.throwIfAborted();
    const url = new URL("/api/apply/v2/jobs", ORIGIN);
    url.search = this.board.search;
    url.searchParams.delete("pid");
    url.searchParams.set("domain", "netflix.com");
    url.searchParams.set("start", String(this.offset));
    url.searchParams.set("num", String(BATCH_SIZE));
    const response = await this.request(url.href, { credentials: "omit", redirect: "error",
      headers: { Accept: "application/json" }, signal: AbortSignal.any([this.signal, AbortSignal.timeout(30_000)]) });
    if (!response.ok) throw new Error(`Netflix could not load results batch ${this.pageNumber} (HTTP ${response.status}). Try again.`);
    const parsed = results.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new Error("Netflix returned an incomplete results batch. Try checking the board again.");
    const { count, positions, query } = parsed.data;
    checkFilters(this.board, query);
    if (count > 10_000) throw new Error("This Netflix search has too many openings to check. Use a more specific filtered link.");
    const end = this.offset + positions.length;
    if (end > count || (positions.length === 0 && this.offset < count)) {
      throw new Error(`Netflix returned an incomplete batch at ${this.offset} of ${count} openings. Try again.`);
    }
    const candidates = positions.map((job, index) => {
      const canonical = new URL(`/careers/job/${job.id}`, ORIGIN);
      if (job.canonicalPositionUrl !== canonical.href && job.canonicalPositionUrl !== canonical.href + "/") {
        throw new Error("Netflix returned an opening whose link did not match its job ID. Try again.");
      }
      const title = job.name.slice(0, 300), department = (job.department || "").slice(0, 200);
      const locations = job.locations?.join(", ") || job.location || "";
      return { id: "l" + index, url: canonical.href, title, department, text: [title, department, locations].filter(Boolean).join(" · ").slice(0, 600) };
    });
    this.nextOffset = end < count ? end : null;
    return { url: this.board.href, title: "Netflix Careers", summary: "", candidates,
      controls: this.nextOffset === null ? [] : [{ id: "c0", text: "Show more positions", context: "", disabled: false }],
      expectedTotal: count, pageNumber: this.pageNumber, pageCount: null, empty: count === 0,
      loading: false, blocked: false, atBottom: true, scrollY: 0, height: 0 };
  }

  next(id: string) {
    if (id !== "c0" || this.nextOffset === null) throw new Error("The next Netflix results batch is unavailable.");
    this.offset = this.nextOffset; this.nextOffset = null; this.pageNumber++;
  }
}
