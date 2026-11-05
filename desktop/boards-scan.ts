import { boardJobIdentity } from "../lib/board-identity";
import { validatedBoardExtraction, type BoardCandidate, type BoardExtractionInput, type BoardScan } from "../shared/boards";
import { knownListing, knownNext, type BoardPage } from "./board-page";
import type { BoardReader } from "./board-browser";

export type BoardExtractor = (input: BoardExtractionInput, signal: AbortSignal) => Promise<unknown>;
export async function scanBoard(options: { url: string; reader: BoardReader; extract: BoardExtractor; signal: AbortSignal;
  provider: string; model: string; batchSize?: number; progress(message: string, phase: "reading" | "extracting"): void }): Promise<BoardScan> {
  const { reader, signal } = options;
  const candidates = new Map<string, BoardCandidate>(), expected = new Set<string>(), pageSignatures = new Set<string>();
  let expectedTotal: number | null = null, page: BoardPage | null = null, pages = 0, explicitlyEmpty = false;
  async function extract(input: BoardExtractionInput) {
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal.throwIfAborted();
      try { return validatedBoardExtraction(await options.extract(input, signal), input); }
      catch (error) { signal.throwIfAborted(); last = error; }
    }
    throw last;
  }
  try {
    await reader.open(options.url);
    while (pages < 100) {
      signal.throwIfAborted(); options.progress(`Reading page ${pages + 1}`, "reading");
      const previousPage = page?.pageNumber;
      page = await reader.read(); pages++;
      if (previousPage && page.pageNumber && page.pageNumber !== previousPage + 1) {
        throw new Error("The board skipped a results page. Try the check again.");
      }
      const signature = JSON.stringify(page.candidates.map(candidate => candidate.url).sort());
      if (pageSignatures.has(signature)) throw new Error("The board repeated a results page. Try the check again.");
      pageSignatures.add(signature);
      if (page.expectedTotal !== null) {
        if (expectedTotal !== null && expectedTotal !== page.expectedTotal) throw new Error("The board's result count changed during this check. Try again.");
        expectedTotal = page.expectedTotal;
      }
      explicitlyEmpty ||= page.empty;
      for (const candidate of page.candidates) {
        candidates.set(candidate.url, candidate);
        if (knownListing(candidate.url, options.url)) expected.add(boardJobIdentity(candidate.url).key);
      }
      if (candidates.size > 10000) throw new Error("This board has too many results. Save a more specific filtered link.");
      let next = knownNext(page);
      if (next === null) {
        options.progress(`Reading navigation on page ${pages}`, "extracting");
        next = (await extract({ task: "navigation", pageUrl: page.url, pageTitle: page.title, summary: page.summary,
          candidates: [], controls: page.controls, expectedListingCount: 0 })).nextControlId;
        if (!next && (page.pageNumber && page.pageCount && page.pageNumber < page.pageCount ||
            page.controls.some(control => !control.disabled && /next page|load more (?:jobs|results)|show more (?:jobs|results)/i.test(control.text)))) {
          throw new Error("The selected model could not identify every results page. Try another model in Settings.");
        }
      }
      if (!next) break;
      if (pages === 100) throw new Error("This board has more than 100 pages. Save a more specific filtered link.");
      await reader.next(next);
    }
    if (!page) throw new Error("The board could not be read.");
    // Known sites supply an independent coverage check; AI still classifies the
    // observed links. Other sites retain their complete candidate inventory.
    const links = [...candidates.values()].filter(candidate => knownListing(candidate.url, options.url) !== false)
      .map((candidate, index) => ({ ...candidate, id: `l${index}` }));
    const size = Math.max(1, Math.min(options.batchSize || 40, 60)), jobs = new Map<string, ReturnType<typeof boardJobIdentity>>();
    for (let index = 0; index < links.length; index += size) {
      signal.throwIfAborted(); options.progress(`Identifying listings ${Math.min(index + size, links.length)} of ${links.length}`, "extracting");
      const batch = links.slice(index, index + size);
      const response = await extract({ task: "listings", pageUrl: options.url, pageTitle: page.title,
        summary: "Identify specific vacancy links. The saved board filters have already been applied.", candidates: batch, controls: [],
        expectedListingCount: knownListing(options.url, options.url) === null ? null : batch.length });
      for (const id of response.listingIds) { const job = boardJobIdentity(batch.find(candidate => candidate.id === id)!.url); jobs.set(job.key, job); }
    }
    if (knownListing(options.url, options.url) !== null && (jobs.size !== expected.size || [...expected].some(id => !jobs.has(id)))) {
      throw new Error("The selected model did not identify every job link. Try the check again or choose another model in Settings.");
    }
    if (expectedTotal !== null && jobs.size !== expectedTotal) throw new Error(`Only ${jobs.size} of ${expectedTotal} listings could be verified. Try the check again.`);
    if (!jobs.size && !explicitlyEmpty) throw new Error("No job links could be verified. The board did not confirm that it has no openings.");
    signal.throwIfAborted();
    return { jobs: [...jobs.values()], pages, provider: options.provider, model: options.model };
  } finally { reader.close(); }
}
