import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const root = await mkdtemp(path.join(tmpdir(), "zebby-boards-"));
const bundle = path.join(root, "boards.mjs");
await build({ stdin: { contents: `
  export * from './desktop/boards-store'; export * from './desktop/boards-scan';
  export * from './desktop/boards-service'; export * from './desktop/board-page';
  export * from './desktop/beta-identity'; export * from './lib/board-identity';
  export * from './shared/boards';`, resolveDir: process.cwd() },
  outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node22" });
const { BoardsStore, BoardsService, scanBoard, boardJobIdentity, boardSearchKey, boardUrl,
  configureBetaProfile, validatedBoardExtraction } = await import(pathToFileURL(bundle).href);
after(async () => { assert.ok(root.startsWith(path.resolve(tmpdir()) + path.sep)); await rm(root, { recursive: true, force: true }); });

async function fixture(work) {
  const folder = await mkdtemp(path.join(root, "case-")), profile = path.join(folder, "profile"), file = path.join(folder, "Boards.sqlite");
  const store = new BoardsStore(profile);
  try { await store.create(file); await work({ store, folder, profile, file }); }
  finally { await store.close(); }
}
const saved = { company: "Uber", url: "https://jobs.uber.com/en/jobs/?team=Product&countries=United+States" };
const jobs = (...ids) => ids.map(id => boardJobIdentity(`https://jobs.uber.com/en/jobs/${id}/`));
const scan = (...ids) => ({ jobs: jobs(...ids), pages: 1, provider: "openai", model: "selected-model" });
const complete = (store, id, ...ids) => store.complete(id, store.get(id).revision, store.generation, scan(...ids));

test("the first check is a baseline, discoveries accumulate, and reviews use the displayed watermark", () => fixture(async ({ store }) => {
  const [id] = await store.add([saved]);
  await complete(store, id, 1, 2); assert.equal(store.get(id).newCount, 0);
  await complete(store, id, 3, 2, 1); const displayed = store.get(id).lastCheckId;
  assert.equal(store.get(id).newCount, 1);
  await complete(store, id, 1, 2, 3); assert.equal(store.get(id).newCount, 1);
  await complete(store, id, 2, 4); assert.equal(store.get(id).newCount, 2, "A disappeared but unreviewed listing still needs review");
  await store.reviewed(id, displayed); assert.equal(store.get(id).newCount, 1, "A stale review cannot acknowledge later discoveries");
  await store.reviewed(id, store.get(id).lastCheckId); assert.equal(store.get(id).newCount, 0);
  await complete(store, id, 4, 3, 2, 1); assert.equal(store.get(id).newCount, 0, "Reappearance and ordering do not create new jobs");
}));

test("a failed scan preserves the last successful count and timestamp", () => fixture(async ({ store }) => {
  const [id] = await store.add([saved]); await complete(store, id, 1); await complete(store, id, 1, 2);
  const before = store.get(id);
  await store.failed(id, before.revision, store.generation, "Pagination unavailable");
  const result = store.get(id);
  assert.equal(result.lastCheckedAt, before.lastCheckedAt); assert.equal(result.lastCheckId, before.lastCheckId);
  assert.equal(result.newCount, 1); assert.equal(result.error, "Pagination unavailable");
}));

test("renaming preserves history, changing filters creates a new baseline, and stale checks are rejected", () => fixture(async ({ store }) => {
  const [id] = await store.add([saved]); await complete(store, id, 1); await complete(store, id, 1, 2);
  const before = store.get(id), generation = store.generation;
  await store.update(id, { ...saved, company: "Uber Product" }); assert.equal(store.get(id).newCount, 1);
  await store.update(id, { ...saved, url: saved.url + "&city=Seattle" });
  assert.equal(store.get(id).lastCheckedAt, ""); assert.equal(store.get(id).newCount, 0);
  await assert.rejects(store.complete(id, before.revision, generation, scan(1, 2, 3)), /changed/);
  await assert.rejects(store.reviewed(id, before.lastCheckId), /Refresh/);
  await complete(store, id, 5, 6); assert.equal(store.get(id).newCount, 0);
  await store.remove(id); assert.deepEqual(store.list(), []);
}));

test("duplicate links roll back the entire add, with no partial records", () => fixture(async ({ store }) => {
  await assert.rejects(store.add([saved, { ...saved, url: "https://jobs.uber.com/en/jobs?countries=United+States&team=Product" }]), /already saved/);
  assert.equal(store.list().length, 0); assert.equal(store.status.dirty, false);
}));

test("Boards cannot open or modify an Applications database", () => fixture(async ({ store, folder }) => {
  const file = path.join(folder, "Applications.sqlite"), db = new DatabaseSync(file);
  db.exec("CREATE TABLE applications (id TEXT); PRAGMA user_version=10;"); db.close();
  const before = await readFile(file);
  await assert.rejects(store.open(file), /separate file/); assert.deepEqual(await readFile(file), before);
  await assert.rejects(store.create(file), { code: "EEXIST" }); assert.deepEqual(await readFile(file), before);
}));

test("cloud saves preserve file identity and reopen the same job history", () => fixture(async ({ store, file }) => {
  const original = await stat(file, { bigint: true }), [id] = await store.add([saved]);
  await complete(store, id, 1); await complete(store, id, 1, 2);
  assert.equal((await stat(file, { bigint: true })).ino, original.ino);
  const before = await readFile(file); await store.close(); await store.open(file);
  assert.deepEqual(await readFile(file), before); assert.equal(store.get(id).newCount, 1);
}));

test("a locked OneDrive file recovers pending local work across restart", () => fixture(async ({ store, profile, file }) => {
  const observer = new DatabaseSync(file), before = await readFile(file);
  observer.exec("BEGIN; SELECT * FROM boards;");
  try {
    await assert.rejects(store.add([saved]), /Retry save/);
    assert.equal(store.status.dirty, true); assert.equal(store.list().length, 1);
    assert.deepEqual(await readFile(file), before);
  } finally { observer.exec("ROLLBACK"); observer.close(); }
  await store.close();
  const reopened = new BoardsStore(profile);
  try {
    assert.equal(await reopened.recoverOnStartup(), true); assert.equal(reopened.status.dirty, true);
    assert.equal(reopened.list()[0].company, "Uber"); await reopened.retrySave();
    assert.equal(reopened.status.dirty, false);
    const savedDb = new DatabaseSync(file, { readOnly: true });
    try { assert.equal(savedDb.prepare("SELECT COUNT(*) AS n FROM boards").get().n, 1); } finally { savedDb.close(); }
  } finally { await reopened.close(); }
}));

test("an external writer cannot be overwritten, and pending work can be recovered separately", () => fixture(async ({ store, folder, file }) => {
  const observer = new DatabaseSync(file); observer.exec("BEGIN; SELECT * FROM boards;");
  try { await assert.rejects(store.add([saved]), /Retry save/); }
  finally { observer.exec("ROLLBACK"); }
  observer.exec("INSERT INTO boards(id,company,url,search_key,created_at) VALUES('other','External','https://example.org/jobs','external','now');"); observer.close();
  const external = await readFile(file);
  await assert.rejects(store.retrySave(), /changed outside/); assert.deepEqual(await readFile(file), external);
  const recovery = path.join(folder, "Recovered.sqlite"); await store.saveRecoveryCopy(recovery); await store.open(recovery);
  assert.equal(store.list()[0].company, "Uber"); assert.deepEqual(await readFile(file), external);
}));

test("a crash after successful publication clears the stale recovery marker without a conflict", () => fixture(async ({ store, profile, file }) => {
  const oldHash = createHash("sha256").update(await readFile(file)).digest("hex"); await store.add([saved]); await store.close();
  const working = path.join(profile, (await readdir(profile)).find(name => /^boards-[a-f0-9]{64}\.sqlite$/.test(name)));
  await writeFile(path.join(profile, "boards-pending.json"), JSON.stringify({ target: file, working, hash: oldHash }));
  assert.equal(await store.recoverOnStartup(), true); assert.equal(store.status.dirty, false); assert.equal(store.list().length, 1);
}));

test("a missing cloud file is not recreated by a write", () => fixture(async ({ store, file }) => {
  await rename(file, file + ".moved"); await assert.rejects(store.add([saved]), /missing/);
  await assert.rejects(stat(file), { code: "ENOENT" }); assert.equal(store.list().length, 0);
}));

test("identities preserve filter semantics but ignore known job slugs and tracking", () => {
  assert.notEqual(boardSearchKey(saved.url), boardSearchKey(saved.url + "&city=Seattle"));
  assert.notEqual(boardSearchKey("https://example.org/jobs#remote"), boardSearchKey("https://example.org/jobs#office"));
  assert.equal(boardJobIdentity("https://www.metacareers.com/profile/job_details/123/?utm_source=one").key,
    boardJobIdentity("https://metacareers.com/jobs/job_details/123/").key);
  assert.equal(boardJobIdentity("https://salesforce.wd12.myworkdayjobs.com/en-US/Slack/job/Seattle/Old-title_JR123").key,
    boardJobIdentity("https://salesforce.wd12.myworkdayjobs.com/Slack/job/NY/New-title_JR123").key);
  assert.notEqual(boardJobIdentity("https://example.org/job?id=1").key, boardJobIdentity("https://example.org/job?id=2").key);
  assert.equal(boardJobIdentity("https://example.org/job?id=1&utm_source=one").key, boardJobIdentity("https://example.org/job?id=1").key);
  for (const url of ["http://example.org", "https://localhost", "https://site.internal", "https://user:pass@example.org", "https://example.org:4433"]) assert.throws(() => boardUrl(url));
});

const page = (ids, overrides = {}) => ({ url: saved.url, title: "Product jobs", summary: "Jobs", candidates: ids.map((id, i) => ({ id: "l" + i, url: jobs(id)[0].url, text: "Product role" })),
  controls: [], expectedTotal: null, pageNumber: null, pageCount: null, empty: false, loading: false, blocked: false, atBottom: true, scrollY: 0, height: 900, ...overrides });
function readerFor(pages) {
  let index = 0;
  return { closed: false, opens: 0, clicks: [], async open() { this.opens++; }, async read() { return pages[index]; },
    async next(id) { this.clicks.push(id); index = Math.min(index + 1, pages.length - 1); }, close() { this.closed = true; } };
}
const allLinks = async input => ({ listingIds: input.candidates.map(candidate => candidate.id), nextControlId: "" });
const run = (reader, extract = allLinks, overrides = {}) => scanBoard({ url: saved.url, reader, extract, signal: new AbortController().signal,
  provider: "openai", model: "selected-model", progress() {}, ...overrides });
const next = { id: "c0", text: "Go to next page", context: "", disabled: false };

test("scanner walks every page, deduplicates IDs, and sends listing links rather than job descriptions", async () => {
  const reader = readerFor([page([1, 2], { controls: [next], pageNumber: 1, pageCount: 2, expectedTotal: 3 }), page([2, 3], { pageNumber: 2, pageCount: 2, expectedTotal: 3 })]);
  const inputs = [], result = await run(reader, async input => { inputs.push(input); return allLinks(input); });
  assert.equal(result.pages, 2); assert.equal(result.jobs.length, 3); assert.deepEqual(reader.clicks, ["c0"]); assert.equal(reader.closed, true);
  assert.equal(inputs[0].task, "listings"); assert.equal(inputs[0].expectedListingCount, 3);
});

test("partial, skipped, repeated, blocked-model, and unverified empty scans cannot become baselines", async () => {
  for (const pages of [
    [page([1], { expectedTotal: 2 })], [page([])],
    [page([1], { pageNumber: 1, pageCount: 2 })],
    [page([1], { controls: [next] }), page([1])],
    [page([1], { pageNumber: 1, pageCount: 3, controls: [next] }), page([2], { pageNumber: 3, pageCount: 3 })],
  ]) { const reader = readerFor(pages); await assert.rejects(run(reader)); assert.equal(reader.closed, true); }
  await assert.rejects(run(readerFor([page([1, 2])]), async () => ({ listingIds: ["invented"], nextControlId: "" })), /selected model/);
  assert.equal((await run(readerFor([page([], { empty: true, expectedTotal: 0 })]))).jobs.length, 0);
});

test("an AI navigation omission does not truncate an unfamiliar board", async () => {
  const reader = readerFor([page([1], { url: "https://example.org/jobs", controls: [next] })]);
  await assert.rejects(run(reader, allLinks, { url: "https://example.org/jobs" }), /every results page/);
});

test("invalid model output retries once and cancellation never creates a result", async () => {
  let attempts = 0;
  const result = await run(readerFor([page([1])]), async input => {
    if (!attempts++) throw new Error("Invalid structured response"); return allLinks(input);
  }); assert.equal(result.jobs.length, 1); assert.equal(attempts, 2);
  const controller = new AbortController(); controller.abort(); const reader = readerFor([page([1])]);
  await assert.rejects(run(reader, allLinks, { signal: controller.signal })); assert.equal(reader.closed, true);
  assert.throws(() => validatedBoardExtraction({ listingIds: ["l0", "l0"], nextControlId: "" },
    { task: "listings", candidates: [{ id: "l0" }], controls: [], expectedListingCount: null }));
});

test("coordinator deduplicates concurrent checks and reuses validated extractions without another charge", () => fixture(async ({ store, profile }) => {
  const [id] = await store.add([saved]); let calls = 0, acknowledgements = 0, runs = 0;
  const service = new BoardsService(store, { profile, selection: () => ({ provider: "credits", model: "selected-model", thinkingLevel: "low" }),
    reader: () => { runs++; return readerFor([page([1])]); }, changed() {},
    extract: async (_selection, input) => { calls++; return { value: await allLinks(input), acknowledge: async () => { acknowledgements++; } }; } });
  service.check([id]); service.check([id]); assert.throws(() => service.assertIdle(), /Finish or cancel/);
  while (service.busy) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runs, 1); assert.equal(calls, 1); assert.equal(acknowledgements, 1); assert.equal(store.get(id).totalCount, 1);
  service.check([id]); while (service.busy) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(runs, 2); assert.equal(calls, 1); assert.equal(store.get(id).newCount, 0);
  await service.stop();
}));

test("the beta display name preserves its existing profile folder", async () => {
  const appData = path.join(root, "profiles"); await mkdir(appData);
  const paths = { appData, userData: path.join(appData, "Zebby") }, names = [];
  const profile = configureBetaProfile({ getPath: name => paths[name], setPath: (name, value) => paths[name] = value, setName: name => names.push(name) });
  assert.equal(profile.folder, path.join(appData, "Zebby Core"));
  assert.deepEqual(profile.legacyFolders, []);
  assert.equal(names.at(-1), "Zebby - Beta");
});

test("a failed receipt acknowledgement resumes from the saved extraction without another charge", () => fixture(async ({ store, profile }) => {
  const [id] = await store.add([saved]); let calls = 0, recovered = 0, source;
  const service = new BoardsService(store, { profile, selection: () => ({ provider: "credits", model: "selected-model", thinkingLevel: "low" }),
    reader: () => readerFor([page([1])]), changed() {},
    extract: async (_selection, input, _signal, sourceId) => { calls++; source = sourceId;
      return { value: await allLinks(input), acknowledge: async () => { throw new Error("Receipt save interrupted"); } }; },
    acknowledgeCached: async (_selection, _input, sourceId) => { assert.equal(sourceId, source); recovered++; } });
  service.check([id]); while (service.busy) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls, 1); assert.equal(recovered, 1); assert.equal(store.get(id).totalCount, 1); assert.equal(store.get(id).error, "");
  await service.stop();
}));
