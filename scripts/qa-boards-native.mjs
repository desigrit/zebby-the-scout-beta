import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { _electron } from "playwright-core";

// Opt-in native integration check using a local Ollama model and public links.
// Settings and the Boards database live entirely inside the test output folder.
const output = path.resolve("qa-output/boards-native"), profile = path.join(output, `profile-${Date.now()}`);
await mkdir(profile, { recursive: true });
const bundle = path.join(output, "store.mjs"), file = path.join(profile, "Zebby Boards.sqlite");
await build({ entryPoints: ["desktop/boards-store.ts"], outfile: bundle, bundle: true, platform: "node", format: "esm", target: "node22" });
const { BoardsStore } = await import(pathToFileURL(bundle).href), store = new BoardsStore(profile);
const boardUrl = process.env.ZEBBY_QA_BOARD_URL || "https://slack.com/careers/dept/product";
const instructions = process.env.ZEBBY_QA_BOARD_INSTRUCTIONS || "";
const expectedMatches = process.env.ZEBBY_QA_EXPECTED_MATCHES;
await store.create(file); await store.close();
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ boardsDatabasePath: file, analysisProvider: "ollama",
  ollamaUrl: "http://localhost:11434", ollamaModel: process.env.ZEBBY_QA_BOARD_MODEL || "qwen3.5:9b", appearance: "light" }));
const env = { ...process.env, PM_TRACKER_TEST_USER_DATA: profile, PM_TRACKER_TEST_HIDE_WINDOW: "1" }; delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.ZEBBY_QA_EXECUTABLE || path.resolve("node_modules/electron/dist/electron.exe");
const args = process.env.ZEBBY_QA_EXECUTABLE ? [] : [process.cwd()];
let app;
const report = { checks: [] };
try {
  for (let launch = 0; launch < 2; launch++) {
    app = await _electron.launch({ executablePath, args, cwd: process.cwd(), env });
    const page = await app.firstWindow(); page.setDefaultTimeout(15000);
    await page.getByRole("navigation", { name: "Workspace" }).getByRole("button", { name: "Boards", exact: true }).click();
    await page.getByRole("main", { name: "Boards", exact: true }).waitFor();
    const state = await page.evaluate(() => window.desktop.state());
    assert.equal(state.appName, "Zebby - Beta"); assert.equal(state.filePath, "");
    if (launch === 0) {
      await page.getByRole("button", { name: "Add your first boards" }).click();
      await page.getByRole("textbox", { name: "Board links", exact: true }).fill(boardUrl);
      if (instructions) await page.getByRole("textbox", { name: "Tracking instructions (optional)" }).fill(instructions);
      await page.getByRole("button", { name: "Add and check" }).click();
      console.log("Native Boards: waiting for first live model check");
      await page.locator(".board-row time, .board-check-error, .boards-error").first().waitFor({ timeout: 180000 });
      await page.locator(".board-progress").waitFor({ state: "hidden", timeout: 180000 });
    }
    const boards = await page.evaluate(() => window.desktop.boardsState());
    await writeFile(path.join(output, `state-${launch}.json`), JSON.stringify(boards, null, 2));
    assert.equal(boards.error, ""); assert.equal(boards.boards[0].error, ""); assert.equal(boards.boards[0].instructions, instructions);
    if (expectedMatches !== undefined) assert.equal(boards.boards[0].totalCount, Number(expectedMatches));
    else if (!process.env.ZEBBY_QA_BOARD_URL && !instructions) assert.equal(boards.boards[0].totalCount, 2);
    if (launch === 1) assert.equal(boards.boards[0].totalCount, report.checks[0].total);
    assert.equal(boards.boards[0].newCount, 0); assert.ok(boards.boards[0].lastCheckedAt);
    assert.equal(boards.filePath, file); assert.equal(boards.dirty, false);
    report.checks.push({ launch, total: boards.boards[0].totalCount, newCount: boards.boards[0].newCount, baseline: true });
    console.log(`Native Boards: ${launch ? "restart history" : "baseline"} verified`);
    await app.close(); app = null;
  }
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
} finally { await app?.close(); }
