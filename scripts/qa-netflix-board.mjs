import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { load as parseHtml } from "cheerio/slim";
import { BoardBrowser } from "../desktop/board-browser";
import { BoardsService } from "../desktop/boards-service";
import { BoardsStore } from "../desktop/boards-store";

// Run inside the existing isolated Electron QA profile. The careers page's own
// initial state gives us an independent count and the first public position IDs.
export async function verifySavedNetflixBoard(url, output) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200);
  const html = parseHtml(await response.text());
  const reference = JSON.parse(html("#smartApplyData").text());
  assert.equal(reference.domain, "netflix.com");
  for (const key of ["Teams", "Region"]) {
    const saved = new URL(url).searchParams.getAll(key);
    if (saved.length) assert.deepEqual(reference.query[key], saved);
  }
  assert.ok(Number.isSafeInteger(reference.count) && reference.count >= 0);
  console.log("Netflix search page", JSON.stringify({ filters: reference.query, total: reference.count, firstBatch: reference.positions.length }));

  const folder = await mkdtemp(path.join(output, "netflix-history-"));
  const file = path.join(folder, "Boards.sqlite");
  const store = new BoardsStore(path.join(folder, "profile"));
  let service, boardId, interrupt = false, cancelled = false;
  let batches = [];
  try {
    await store.create(file);
    [boardId] = await store.add([{ company: "Netflix", url }]);
    await store.failed(boardId, store.get(boardId).revision, store.generation, "Previous check did not finish");
    await store.close(); await store.open(file);
    assert.equal(store.get(boardId).lastCheckId, 0);

    service = new BoardsService(store, {
      profile: folder, selection: () => ({ provider: "ollama", model: "coverage-test", thinkingLevel: "off" }), changed() {},
      extract: async () => { throw new Error("A Netflix inventory without tracking instructions requested an AI call."); },
      reader: signal => {
        const reader = new BoardBrowser(signal);
        const read = reader.read.bind(reader);
        reader.read = async () => {
          if (interrupt && batches.length === (reference.count > 10 ? 1 : 0)) {
            cancelled = service.cancel(boardId);
            signal.throwIfAborted();
          }
          const page = await read();
          batches.push(page.candidates.length);
          assert.equal(page.expectedTotal, reference.count, "Search membership changed during the live check");
          return page;
        };
        return reader;
      },
    });
    async function check() {
      batches = [];
      service.check([boardId]);
      const deadline = Date.now() + 120000;
      while (service.busy && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
      assert.equal(service.busy, false, "Board check timed out");
      assert.equal(service.error, "");
      return store.get(boardId);
    }
    const baseline = await check();
    assert.equal(baseline.error, "");
    assert.equal(baseline.totalCount, reference.count);
    assert.equal(baseline.newCount, 0);
    assert.ok(baseline.lastCheckedAt && baseline.lastCheckId > 0);
    const history = store.knownMatches(boardId, baseline.revision);
    assert.equal(history.size, reference.count);
    for (const job of reference.positions) assert.ok(history.has(job.canonicalPositionUrl));
    console.log("Saved board baseline", JSON.stringify({ batches, uniqueJobs: history.size, newCount: baseline.newCount }));

    interrupt = true;
    const interrupted = await check();
    assert.equal(cancelled, true);
    assert.equal(interrupted.lastCheckId, baseline.lastCheckId);
    assert.equal(interrupted.lastCheckedAt, baseline.lastCheckedAt);
    assert.deepEqual(store.knownMatches(boardId, baseline.revision), history);
    interrupt = false;
    const retry = await check();
    assert.equal(retry.error, "");
    assert.ok(retry.lastCheckId > baseline.lastCheckId);
    assert.equal(retry.url, url);
    assert.equal(retry.totalCount, reference.count);
    assert.equal(retry.newCount, 0);
    assert.equal(store.list().length, 1);
    console.log("Interrupted scan preserved history; retry completed on the same saved URL.", JSON.stringify({ batches, total: retry.totalCount }));
  } finally {
    if (service) await service.stop();
    await store.close();
  }
}
