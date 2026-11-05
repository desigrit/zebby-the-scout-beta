import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "playwright-core";
import { LOCAL_MODELS } from "../desktop/local-model-catalog.ts";
import { importanceForTerms } from "../desktop/plan-importance.ts";
import { parseLocations } from "../lib/locations.ts";
import { checkBoardsRenderer } from "./qa-boards-renderer.mjs";

// Checks the compiled renderer with synthetic data in an invisible browser.
// It does not launch Electron, read settings, or open an application database.
const renderer = path.resolve("desktop-dist/renderer");
const output = path.resolve("qa-output/renderer-1.5.0");
const captureImages = process.env.ZEBBY_QA_CHECKS_ONLY !== "1";
const captureNames = (process.env.ZEBBY_QA_CAPTURE_NAMES || "").split(",").filter(Boolean);
const { version: appVersion } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const executablePath = process.env.PM_TRACKER_BROWSER || [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((candidate) => existsSync(candidate));
const description = "Responsibilities\n\n• Lead discovery and product strategy\n• Prioritize roadmap work with design and engineering\n\nQualifications\n\nExperience delivering products and measuring customer outcomes.";
const resume = { id: "resume-1", filename: "Sample Product CV.pdf", contentType: "application/pdf", size: 4, createdAt: "2026-09-01T12:00:00Z" };
const base = { team: "", listingUrl: "https://example.org/jobs/pm", jobDescription: description, notes: description,
  snapshotText: description, snapshotSource: "page", snapshotCapturedAt: "2026-09-29T12:00:00Z",
  appliedDate: "2026-09-29", matchStrength: 92, matchNotes: "Strong product strategy experience.", matchAnalyzedAt: "2026-09-29T12:00:00Z",
  resumeId: resume.id, resumeName: resume.filename, status: "Applied", createdAt: "2026-09-29T12:00:00Z", updatedAt: "2026-09-29T12:00:00Z" };
let applications = [
  { ...base, id: "app-1", company: "Expedia Group", title: "Senior Product Manager", team: "Search & Recommendations Quality", locations: "Seattle, WA, United States" },
  { ...base, id: "app-2", company: "Meta", title: "Product Manager", locations: "Sunnyvale, CA; Bellevue, WA; Redmond, WA; Menlo Park, CA; Burlingame, CA; New York, NY; Seattle, WA; San Francisco, CA" },
  ...Array.from({ length: 9 }, (_, index) => ({ ...base, id: `older-${index}`, company: "Northstar Labs", title: "Product Manager",
    locations: "Remote", appliedDate: `2026-09-${String(6 + index * 2).padStart(2, "0")}`, matchStrength: index % 2 ? 83 : null, resumeId: "", resumeName: "",
    status: index % 3 ? "Applied" : "Heard back" })),
];
let plan = { id: "plan-1", listingUrl: "https://example.org/jobs/pm", company: "Expedia Group", title: "Senior Product Manager", team: "Growth", locations: "Seattle, WA",
  description, snapshotText: description, snapshotSource: "page", snapshotCapturedAt: "2026-09-29T12:00:00Z",
  currentOverview: "I help teams find customer needs and build useful products with clear priorities.", resumeId: resume.id,
  keywords: ["Product strategy", "Customer discovery", "Roadmap", "Analytics", "Prioritization", "Leadership"], themes: ["Lead discovery", "Shape strategy", "Prioritize roadmap", "Measure outcomes", "Align teams"],
  keywordImportance: [96, 94, 89, 82, 80, 73], themeImportance: [95, 92, 87, 81, 76],
  overview: "I help teams find customer needs and build useful products with clear priorities.", overviewRationale: "The overview already reflects discovery and priorities.",
  matchStrength: 84, matchNotes: "", matchAnalyzedAt: "2026-09-29T12:00:00Z", createdAt: "2026-09-29T12:00:00Z", updatedAt: "2026-09-29T12:00:00Z" };
let plans = [plan];
let lastCurrentOverview = plan.currentOverview;
const state = { appName: "Zebby - Beta", filePath: "example.sqlite", filename: "Applications.sqlite", dirty: false, startupError: "", hasApiKey: false,
  hasAnthropicKey: false, apiKeyHint: "", anthropicKeyHint: "", thinkingLevels: {}, openaiModel: "gpt-6.1-sol", anthropicModel: "claude-sonnet-5-5",
  credits: { available: false, signedIn: false, email: "", wallet: null, stale: true, error: "", model: "gpt-6.1-sol",
    access: null, recoverySaved: false, pendingConnection: false },
  analysisProvider: "ollama", ollamaUrl: "http://localhost:11434", ollamaModel: "qwen3.8:27b", canSaveApiKey: true,
  appearance: "light", sidebarCollapsed: false, logsPath: "", platform: "win32",
  builtInModelId: "", acceptedModelTerms: [], localModels: LOCAL_MODELS.map(({ id }) =>
    ({ id, status: "not-installed", downloadedBytes: 0, error: "" })), modelsFolder: "example/Models",
  localEngine: { status: "idle", modelId: "" }, totalMemory: 32e9, availableMemory: 16e9,
  updates: { currentVersion: appVersion, checking: false, checkedAt: "", error: "", available: null,
    download: { phase: "idle", received: 0, total: 0, error: "" } } };
const pending = new Map();
const requested = new Map();
const analysisRequestIds = new Map();
const paidAnalysisRequests = [];
async function waitForAnalysis(pathname) {
  if (!pending.has(pathname)) await new Promise((resolve) => requested.set(pathname, resolve));
}
async function completeAnalysis(pathname) {
  await waitForAnalysis(pathname);
  pending.get(pathname)();
}
const server = createServer(async (request, response) => {
  const file = path.resolve(renderer, `.${new URL(request.url, "http://localhost").pathname === "/" ? "/index.html" : new URL(request.url, "http://localhost").pathname}`);
  if (!file.startsWith(renderer + path.sep)) { response.writeHead(403); response.end(); return; }
  try {
    const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" }[path.extname(file)] || "application/octet-stream";
    response.writeHead(200, { "Content-Type": mime }); response.end(await readFile(file));
  } catch { response.writeHead(404); response.end(); }
});
let browser;
checks: try {
  await mkdir(output, { recursive: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  const page = await browser.newPage({ viewport: { width: 1550, height: 850 }, timezoneId: "America/Los_Angeles", locale: "en-US" });
  await page.clock.setFixedTime(new Date("2026-09-30T20:00:00Z"));
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  async function assertApplicationMetrics() {
    const geometry = await page.locator(".application-row").evaluateAll((rows) => rows.slice(0, 4).map((row) => {
      const metrics = row.querySelector(".application-row-metrics"), date = metrics.firstElementChild, match = metrics.lastElementChild;
      const summary = row.querySelector(".application-row-summary"), main = row.querySelector(".application-row-main");
      const controls = [main, date, match, summary.querySelector(".status-select"), summary.querySelector(".row-actions")];
      const boxes = controls.map((element) => element.getBoundingClientRect());
      const stacked = boxes[0].bottom <= boxes[1].top;
      const aligned = stacked ? controls.slice(1) : controls;
      const alignedBoxes = stacked ? boxes.slice(1) : boxes;
      const gaps = alignedBoxes.slice(1).map((box, index) => box.left - alignedBoxes[index].right);
      const mid = alignedBoxes[0].top + alignedBoxes[0].height / 2;
      const buttons = [...summary.querySelectorAll(".row-actions > button")];
      const meta = main.querySelector(".application-row-meta").getBoundingClientRect();
      const heading = main.querySelector(".application-row-select").getBoundingClientRect();
      const location = main.querySelector(".role-context")?.getBoundingClientRect(), listing = main.querySelector(".listing-link")?.getBoundingClientRect();
      return { dateFirst: date.tagName === "TIME", matchSecond: match.classList.contains("match-control"), gaps,
        lineOffset: Math.max(...[...aligned, ...buttons].map((element) => { const b = element.getBoundingClientRect(); return Math.abs(b.top + b.height / 2 - mid); })),
        stacked, titleWidth: boxes[0].width / summary.clientWidth,
        actionCount: buttons.length, twoRows: heading.bottom < meta.top && (stacked || heading.height < 26),
        metadataOffset: location && listing ? Math.abs(location.top + location.height / 2 - listing.top - listing.height / 2) : 0,
        width: summary.clientWidth, overflow: row.scrollWidth > row.clientWidth };
    }));
    assert.ok(geometry.length);
    for (const row of geometry) {
      assert.equal(row.dateFirst && row.matchSecond, true);
      assert.ok(row.gaps.every((gap) => gap >= 7), `Separated groups ${JSON.stringify(row)}`);
      if (!row.stacked) assert.ok(Math.max(...row.gaps) - Math.min(...row.gaps) <= 1, `Evenly separated groups ${JSON.stringify(row)}`);
      else assert.ok(row.titleWidth > .9, 'Compact rows give the role identity the full width');
      if (row.width >= 850) assert.ok(row.gaps[1] > 64);
      assert.ok(row.lineOffset <= 1, "Date, match, status and all actions vertically center on the job block");
      assert.equal(row.actionCount, 3); assert.equal(row.twoRows, true); assert.ok(row.metadataOffset <= 1, JSON.stringify(row));
      assert.equal(row.overflow, false);
    }
  }
  async function captureSettings(filename, fullPage = true) {
    if (await page.locator('.settings-page').count()) await page.locator('.desktop-workspace').evaluate(element => element.scrollTo({ top: 0, behavior: 'instant' }));
    await page.evaluate(async () => {
      window.scrollTo({ top: 0, behavior: "instant" });
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.all(document.getAnimations().filter((animation) =>
        animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined)));
    });
    if (filename.startsWith("credits-") && await page.locator(".analysis-dialog[open]").count()) {
      const bounds = await page.locator(".analysis-dialog[open]").evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewportWidth: innerWidth, viewportHeight: innerHeight };
      });
      assert.ok(bounds.x >= 16 && bounds.y >= 16, "Analysis dialogs leave space around the window edges");
      assert.ok(Math.abs(bounds.x + bounds.width / 2 - bounds.viewportWidth / 2) <= 1, "Analysis dialogs center horizontally");
      assert.ok(Math.abs(bounds.y + bounds.height / 2 - bounds.viewportHeight / 2) <= 1, "Analysis dialogs center vertically");
    }
    if (captureImages || captureNames.includes(filename)) await page.screenshot({ path: path.join(output, filename), fullPage });
  }
  async function assertFullTextRows(paragraphs) {
    const rows = await paragraphs.evaluateAll((elements) => elements.map((element) => {
      const parent = element.parentElement, style = getComputedStyle(parent);
      return { text: element.textContent.slice(0, 60), width: element.clientWidth,
        available: parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        overflow: element.scrollWidth > element.clientWidth };
    }));
    assert.ok(rows.length > 0, "The expected text is rendered");
    for (const row of rows) {
      assert.ok(Math.abs(row.width - row.available) <= 2, `Text uses the available row: ${JSON.stringify(row)}`);
      assert.equal(row.overflow, false, `Text wraps within its row: ${row.text}`);
    }
  }
  async function assertSettingsActions() {
    await settleSidebar();
    const actions = await page.locator('.settings-page button:not(.settings-link):not(.credit-activity-day):not([role="switch"]):not([role="radio"]):visible').evaluateAll((buttons) => buttons.map((button) => {
      const style = getComputedStyle(button), icon = button.querySelector('svg');
      return { label: button.getAttribute('aria-label') || button.innerText, shared: button.classList.contains('settings-action'),
        height: button.getBoundingClientRect().height, size: style.fontSize, weight: style.fontWeight,
        radius: style.borderRadius, gap: style.gap, iconWidth: icon ? parseFloat(getComputedStyle(icon).width) : undefined,
        iconHeight: icon ? parseFloat(getComputedStyle(icon).height) : undefined };
    }));
    assert.ok(actions.length > 0);
    for (const action of actions) {
      assert.equal(action.shared, true, `${action.label} uses the common Settings control`);
      assert.equal(action.height, 36, `${action.label} has a consistent target height`);
      assert.equal(action.size, '13px'); assert.equal(action.weight, '650');
      assert.equal(action.radius, '8px'); assert.equal(action.gap, '8px');
      if (action.iconWidth !== undefined) { assert.equal(action.iconWidth, 16); assert.equal(action.iconHeight, 16); }
    }
    const rows = await page.locator('.settings-page .analysis-setting-row').evaluateAll(elements => elements.map(element => ({
      overflow: element.scrollWidth > element.clientWidth,
      label: element.querySelector('.analysis-setting-label').getBoundingClientRect().left,
    })));
    assert.ok(rows.length >= 2);
    assert.equal(rows.some(row => row.overflow), false, 'Quiet rows fit the available width');
    assert.ok(rows.every(row => Math.abs(row.label - rows[0].label) <= 1), `Preference labels align: ${JSON.stringify(rows)}`);
    assert.equal(await page.locator('.analysis-configuration').getByText(/Job and resume text go to|receives job and resume content/).count(), 0);
  }
  async function assertActivityTooltipBounds() {
    const bounds = await page.locator('.activity-bars').boundingBox();
    for (const index of [0, 3, 6, 14, 23, 26, 29]) {
      const day = page.locator('.activity-day').nth(index);
      await day.focus();
      const tooltip = await day.locator('.activity-tooltip').boundingBox();
      assert.ok(tooltip.x >= bounds.x - 1 && tooltip.x + tooltip.width <= bounds.x + bounds.width + 1,
        `Day ${index + 1} tooltip stays within the chart at ${page.viewportSize().width}px`);
    }
    await page.locator('.application-row-select').first().focus();
  }
  async function settleSidebar() {
    await page.evaluate(async () => {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.all(document.getAnimations().filter((animation) =>
        animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined)));
    });
  }
  async function assertLocationKeyboard(editor, label) {
    const add = editor.getByRole("button", { name: "Add location", exact: true });
    await add.click();
    const input = editor.getByRole("combobox", { name: "New location", exact: true });
    const recents = page.getByRole("listbox", { name: "Recents", exact: true });
    await recents.waitFor();
    const popupBounds = await page.locator(".location-recents").boundingBox();
    const viewport = page.viewportSize();
    assert.ok(popupBounds.x >= 0 && popupBounds.y >= 0 && popupBounds.x + popupBounds.width <= viewport.width &&
      popupBounds.y + popupBounds.height <= viewport.height, `${label}: suggestions fit inside the window`);
    for (const location of await editor.locator(".location-chip > span").allTextContents()) {
      assert.equal(await recents.getByRole("option", { name: location, exact: true }).count(), 0, `${label}: chosen locations stay out of Recents`);
    }
    await captureSettings(`locations-${label.startsWith("Windows") ? "windows" : "mac"}.png`, false);
    if (label.startsWith("Mac")) {
      await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
      await captureSettings("locations-mac-dark.png", false);
      await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
    }
    const keyboardLocation = await recents.getByRole("option").first().innerText();
    await input.fill(keyboardLocation.toLowerCase());
    assert.equal(await recents.getByRole("option").count(), 1, `${label}: case-insensitive filtering`);
    await input.press("ArrowDown"); await input.press("Enter");
    assert.equal(await editor.locator(".location-chip").filter({ hasText: keyboardLocation }).count(), 1);
    assert.equal(await add.evaluate((element) => document.activeElement === element), true);
    await page.keyboard.press("Enter"); await recents.waitFor();
    assert.equal(await recents.getByRole("option", { name: keyboardLocation, exact: true }).count(), 0);
    const pointerLocation = await recents.getByRole("option").first().innerText();
    await recents.getByRole("option", { name: pointerLocation, exact: true }).click();
    assert.equal(await editor.locator(".location-chip").filter({ hasText: pointerLocation }).count(), 1);
    assert.equal(await add.evaluate((element) => document.activeElement === element), true);
    for (const location of [keyboardLocation, pointerLocation]) {
      await editor.getByRole("button", { name: `Remove ${location}`, exact: true }).click();
    }
    await add.click();
    for (const location of ["Portland, OR", "Austin, TX"]) {
      assert.equal(await input.evaluate((element) => document.activeElement === element), true, `${label}: input gets focus`);
      await input.fill(location); await input.press("Enter");
      assert.equal(await editor.locator(".location-chip").filter({ hasText: location }).count(), 1);
      assert.equal(await add.evaluate((element) => document.activeElement === element), true, `${label}: focus returns to plus`);
      assert.equal(await add.evaluate((element) => getComputedStyle(element).backgroundColor), "rgb(248, 232, 225)");
      await page.keyboard.press("Enter");
    }
    await input.press("Enter");
    assert.equal(await input.isVisible(), true, "Blank Enter stays in the input");
    await input.press("Escape");
    assert.equal(await add.evaluate((element) => document.activeElement === element), true);
    await page.keyboard.press("Enter");
    await editor.getByRole("button", { name: "Cancel adding location", exact: true }).click();
    assert.equal(await add.evaluate((element) => document.activeElement === element), true);
    for (const location of ["Portland, OR", "Austin, TX"]) await editor.getByRole("button", { name: `Remove ${location}`, exact: true }).click();
    await add.click(); await recents.waitFor();
    await input.press("Tab"); await page.keyboard.press("Tab");
    assert.equal(await recents.count(), 0, `${label}: leaving the field dismisses suggestions`);
  }
  async function captureAnalysis(filename, docsFilename) {
    const viewport = page.viewportSize();
    await page.setViewportSize({ ...viewport, height: 1200 });
    const section = page.locator(".analysis-section");
    await section.evaluate((element) => window.scrollTo({
      top: element.getBoundingClientRect().top + window.scrollY - 68, behavior: "instant",
    }));
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await Promise.all(document.getAnimations().filter((animation) =>
        animation.effect?.getTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => undefined)));
    });
    if (captureImages) await section.screenshot({ path: path.join(output, filename) });
    if (captureImages && process.env.ZEBBY_CAPTURE_DOCS && docsFilename) await page.screenshot({ path: path.join(output, docsFilename) });
    await page.setViewportSize(viewport);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  }
  await page.addInitScript(({ initialState, licenseVersions }) => {
    window.controlsQA = { copied: "", failCopy: false, revealed: [] };
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text) => {
      if (window.controlsQA.failCopy) throw new Error("Synthetic clipboard failure");
      window.controlsQA.copied = text;
    } }, configurable: true });
    const listeners = new Set(), updateListeners = new Set(), creditListeners = new Set(), analysisListeners = new Set(), databaseListeners = new Set();
    window.analysisQA = { cancelled: [], progress: (event) => { for (const listener of analysisListeners) listener(event); } };
    const snapshot = () => structuredClone(initialState);
    const update = (id, change) => { initialState.localModels = initialState.localModels.map((item) =>
      item.id === id ? { ...item, ...change } : item); for (const listener of listeners) listener(snapshot()); };
    const updateState = (change) => {
      initialState.updates = { ...initialState.updates, ...change };
      for (const listener of updateListeners) listener(structuredClone(initialState.updates));
    };
    const updateCredits = (change) => {
      initialState.credits = { ...initialState.credits, ...change };
      for (const listener of creditListeners) listener(snapshot());
    };
    const wallet = { balance: 500000000, reserved: 0, used: 0, purchased: 500000000,
      updatedAt: "2026-09-30T20:00:00Z", recent: [] };
    const firstDevice = { id: "11111111-1111-4111-8111-111111111111", name: "Windows desktop", current: true,
      createdAt: "2026-09-30T20:00:00Z", lastSeenAt: "2026-09-30T20:00:00Z" };
    const secondDevice = { ...firstDevice, id: "22222222-2222-4222-8222-222222222222", name: "Mac laptop", current: false };
    const walletAccess = { hasRecoveryCode: false, recoveryVersion: null, devices: [firstDevice] };
    window.creditQA = { update: updateCredits, checkouts: [], models: [], connections: [], recoverySaves: [],
      cancelRecovery: false, confirmDisconnect: false, disconnects: [], pairingCancelled: 0, payment: "open", quote: null,
      resumeMode: "none", failedResumes: 0, warmups: 0, warmupMode: "ready", finishWarmup: null,
      quoteRequests: [], quoteMode: "ready", finishQuote: null, finishedQuotes: 0 };
    window.modelQA = { confirmDelete: false, deleteRequests: [], selections: [], rejectSidebarSave: false,
      updateState, installRequests: 0, failInstall: false, failCheck: false, finishDownload: null,
      logOpens: 0, failLogOpen: false, failKeySave: false, keySaveAttempts: 0, thinkingSelections: [], databaseRequests: [], stopRequests: [], update,
      databaseResult: "cancel",
      setDatabase: (change) => { Object.assign(initialState, change); for (const listener of databaseListeners) listener(snapshot()); },
      setPlatform: (platform) => { initialState.platform = platform; },
      setCompute: (compute) => { initialState.localCompute = compute; for (const listener of listeners) listener(snapshot()); } };
    window.desktop = { state: async () => initialState,
      boardsState: async () => ({ filePath: "", filename: "", dirty: false, error: "", boards: [], progress: [] }),
      onBoardsChanged: () => () => {},
      onDatabaseChanged: (listener) => { databaseListeners.add(listener); return () => databaseListeners.delete(listener); }, onNavigate: () => () => {},
      onAnalysisProgress: (listener) => { analysisListeners.add(listener); return () => analysisListeners.delete(listener); },
      cancelAnalysis: async (id) => { window.analysisQA.cancelled.push(id); return true; },
      onLocalModelsChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      onUpdatesChanged: (listener) => { updateListeners.add(listener); return () => updateListeners.delete(listener); },
      onCreditsChanged: (listener) => { creditListeners.add(listener); return () => creditListeners.delete(listener); },
      refreshCredits: async () => {
        if (window.creditQA.resumeMode === "error") { window.creditQA.failedResumes++; throw new Error("Connection interrupted. Retry when online."); }
        if (window.creditQA.resumeMode === "complete") updateCredits({ signedIn: true, pendingConnection: false, wallet: { ...wallet }, access: walletAccess, error: "", stale: false });
        return snapshot();
      },
      refreshCreditAccess: async () => snapshot(),
      saveCreditRecoveryCode: async (rotate = false) => {
        window.creditQA.recoverySaves.push(rotate);
        if (window.creditQA.cancelRecovery) return { saved: false, state: snapshot() };
        updateCredits({ recoverySaved: true, access: { ...initialState.credits.access, hasRecoveryCode: true,
          recoveryVersion: "33333333-3333-4333-8333-333333333333" } });
        return { saved: true, state: snapshot() };
      },
      connectCreditWallet: async (kind, code) => {
        window.creditQA.connections.push({ kind, code });
        if (code === "BAD-CODE") throw new Error("That pairing code was used or expired. Generate a new code on your other computer.");
        updateCredits({ access: { ...initialState.credits.access, devices: [firstDevice, secondDevice] } });
        return { connected: true, state: snapshot() };
      },
      createCreditPairing: async () => ({ code: "ABCD2345", expiresAt: new Date(Date.now() + 600000).toISOString() }),
      cancelCreditPairing: async () => { window.creditQA.pairingCancelled++; },
      removeCreditDevice: async (id) => {
        window.creditQA.disconnects.push(id);
        if (window.creditQA.confirmDisconnect) updateCredits({ access: { ...initialState.credits.access,
          devices: initialState.credits.access.devices.filter((item) => item.id !== id) } });
        return snapshot();
      },
      warmCreditsService: async () => {
        window.creditQA.warmups++;
        if (window.creditQA.warmupMode === "error") throw new Error("The credits service did not become ready. Try again shortly.");
        if (window.creditQA.warmupMode === "pending") await new Promise(resolve => { window.creditQA.finishWarmup = resolve; });
      },
      startCreditCheckout: async (pack) => {
        if (!initialState.credits.available) throw new Error("Could not reach the credits service. Try again.");
        window.creditQA.checkouts.push(pack);
        updateCredits({ signedIn: true, wallet: { ...wallet, balance: 0, purchased: 0 }, access: walletAccess, stale: false });
        return { id: "cs_test_fixture", mode: "test" }; },
      creditCheckoutStatus: async () => {
        if (window.creditQA.payment === "paid") updateCredits({ wallet: { ...wallet }, stale: false });
        return window.creditQA.payment;
      },
      quoteCreditAnalysis: async (source) => {
        const quote = window.creditQA.quote || { id: "quote-fixture", model: initialState.credits.model,
          thinkingLevel: initialState.thinkingLevels[JSON.stringify(["credits", initialState.credits.model])] || "high",
          maximum: 20000000, expiresAt: new Date(Date.now() + 300000).toISOString() };
        window.creditQA.quoteRequests.push({ source, model: quote.model, thinking: quote.thinkingLevel });
        if (window.creditQA.quoteMode === "error") throw new Error("Could not reach the credits service. Try again.");
        if (window.creditQA.quoteMode === "pending") await new Promise(resolve => { window.creditQA.finishQuote = resolve; });
        window.creditQA.finishedQuotes++; return quote;
      },
      setThinkingLevel: async ({ provider, model, level }) => {
        const key = JSON.stringify(provider === "ollama" ? [provider, initialState.ollamaUrl, model] : [provider, model]);
        initialState.thinkingLevels[key] = level; window.modelQA.thinkingSelections.push({ provider, model, level }); return snapshot();
      },
      ollamaThinkingCapability: async () => ({ options: [{ value: "off", label: "Off" }, { value: "on", label: "On" }], defaultValue: "off", known: true }),
      setOnlineModel: async (provider, model) => {
        window.creditQA.models.push({ provider, model });
        await new Promise(resolve => setTimeout(resolve, 25));
        if (provider === "credits") updateCredits({ model });
        else if (provider === "openai") initialState.openaiModel = model;
        else initialState.anthropicModel = model;
        return snapshot();
      },
      confirmUpdateLoaded: async () => {},
      checkForUpdates: async () => {
        updateState({ checking: true }); await new Promise(resolve => setTimeout(resolve, 25));
        updateState({ checking: false, checkedAt: new Date().toISOString(), error: window.modelQA.failCheck ? "Could not check for updates. Try again." : "" });
        return structuredClone(initialState.updates);
      },
      downloadUpdate: async () => {
        updateState({ download: { phase: "downloading", received: 40, total: 100, error: "" } });
        await new Promise(resolve => { window.modelQA.finishDownload = resolve; });
        return structuredClone(initialState.updates);
      },
      installUpdate: async () => { window.modelQA.installRequests++;
        if (window.modelQA.failInstall) throw new Error("Synthetic database save failure. Try again.");
        updateState({ download: { phase: "installing", received: 100, total: 100, error: "" } });
      },
      downloadResume: async () => true,
      revealTailoredResume: async (id, format) => { window.controlsQA.revealed.push({ id, format }); },
      chooseDatabase: async (kind) => {
        window.modelQA.databaseRequests.push(kind);
        if (window.modelQA.databaseResult === "error") throw new Error("The selected database could not be opened.");
        if (window.modelQA.databaseResult === "cancel") return null;
        Object.assign(initialState, { filePath: "/fixture/Applications.sqlite", filename: "Applications.sqlite", startupError: "" });
        return snapshot();
      },
      openLogs: async () => { if (window.modelQA.failLogOpen) throw new Error("Synthetic logs folder error"); window.modelQA.logOpens++; },
      listOllamaModels: async () => ["qwen3.8:27b", "qwen3:8b"],
      setAnalysisProvider: async (provider) => { initialState.analysisProvider = provider; return snapshot(); },
      setOllamaConfig: async ({ url, model }) => { initialState.ollamaUrl = url; initialState.ollamaModel = model; return snapshot(); },
      setApiKey: async (key) => {
        window.modelQA.keySaveAttempts++;
        if (window.modelQA.failKeySave) throw new Error("Could not save this key.");
        initialState.hasApiKey = Boolean(key); initialState.apiKeyHint = key ? "sk-••••••••" + key.slice(-4) : ""; return snapshot();
      },
      setAnthropicKey: async (key) => {
        window.modelQA.keySaveAttempts++;
        if (window.modelQA.failKeySave) throw new Error("Could not save this key.");
        initialState.hasAnthropicKey = Boolean(key); initialState.anthropicKeyHint = key ? "sk-ant-••••••••" + key.slice(-4) : ""; return snapshot();
      },
      setAppearance: async (appearance) => { initialState.appearance = appearance; return snapshot(); },
      setSidebarCollapsed: async (collapsed) => {
        if (window.modelQA.rejectSidebarSave) throw new Error("Synthetic settings save error");
        initialState.sidebarCollapsed = collapsed; return snapshot();
      },
      selectLocalModel: async (id) => { window.modelQA.selections.push(id); initialState.builtInModelId = id;
        if ((!licenseVersions[id] || initialState.acceptedModelTerms.includes(id)) &&
          initialState.localModels.find((item) => item.id === id).status !== "ready")
          update(id, { status: "downloading", downloadedBytes: 0, error: "" }); return snapshot(); },
      pauseModelDownload: async () => { for (const item of initialState.localModels)
        if (["downloading", "verifying"].includes(item.status)) update(item.id, { status: "paused" }); return snapshot(); },
      stopModelDownload: async (id) => { window.modelQA.stopRequests.push(id);
        if (initialState.localModels.find(item => item.id === id).status !== "ready")
          update(id, { status: "not-installed", downloadedBytes: 0, error: "" }); return snapshot(); },
      resumeModelDownload: async (id, termsVersion) => {
        if (licenseVersions[id] && !initialState.acceptedModelTerms.includes(id)) {
          if (termsVersion !== licenseVersions[id]) throw new Error("Review the model terms first.");
          initialState.acceptedModelTerms.push(id);
        }
        if (initialState.localModels.find((item) => item.id === id).status !== "ready")
          update(id, { status: "downloading", error: "" }); return snapshot(); },
      deleteLocalModel: async (id) => { window.modelQA.deleteRequests.push(id);
        if (window.modelQA.confirmDelete) update(id, { status: "not-installed", downloadedBytes: 0, error: "" }); return snapshot(); },
      openModelFolder: async () => "",
    };
  }, { initialState: state, licenseVersions: Object.fromEntries(LOCAL_MODELS.filter((model) => model.license)
    .map((model) => [model.id, model.license.version])) });
  let failNextStatusSave = false;
  let failNextPlanAnalysis = false;
  let failNextPlanMove = false;
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    let data;
    if (pathname === "/api/applications") data = { applications };
    else if (pathname === "/api/locations/recent") data = { locations: parseLocations([...applications, ...plans]
      .map((item) => item.locations).join("; ")) };
    else if (pathname === "/api/job-posting") data = { details: { company: "Example", title: "Product Manager", team: "", locations: "Remote" }, text: description };
    else if (pathname === "/api/resumes") data = { resumes: [resume] };
    else if (pathname === "/api/plans" && method === "GET") data = { plans, lastCurrentOverview };
    else if (pathname === "/api/plans" && method === "POST") {
      const input = route.request().postDataJSON();
      const saved = { ...plan, ...input, id: `plan-${plans.length + 1}`, keywordImportance: [], themeImportance: [], matchStrength: null,
        matchAnalyzedAt: "", matchNotes: "", overviewRationale: "", updatedAt: "2026-09-30T20:00:00Z" };
      plans = [saved, ...plans]; lastCurrentOverview = saved.currentOverview;
      data = { plan: saved };
    }
    else if (pathname.endsWith("/apply") && method === "POST") {
      if (failNextPlanMove) {
        failNextPlanMove = false;
        await route.fulfill({ status: 400, json: { error: "The database could not be saved. Try again." } }); return;
      }
      const saved = plans.find((item) => item.id === pathname.split("/")[3]);
      assert.equal(route.request().postDataJSON().expectedUpdatedAt, saved.updatedAt);
      const existing = applications.find((item) => item.listingUrl === saved.listingUrl);
      const now = new Date();
      const application = existing || { ...base, id: `application-from-${saved.id}`, company: saved.company,
        title: saved.title, team: saved.team, locations: saved.locations, listingUrl: saved.listingUrl,
        jobDescription: saved.description, notes: saved.description, snapshotText: saved.snapshotText,
        snapshotSource: saved.snapshotSource, snapshotCapturedAt: saved.snapshotCapturedAt,
        resumeId: saved.resumeId, resumeName: resume.filename, matchStrength: saved.matchStrength,
        matchNotes: saved.matchNotes, matchAnalyzedAt: saved.matchAnalyzedAt, status: "Applied",
        appliedDate: new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10) };
      if (!existing) applications = [application, ...applications];
      data = { application, created: !existing };
    }
    else if (pathname.endsWith("/analyze") || pathname.endsWith("/tailor")) {
      if (route.request().headers()["x-zebby-credit-quote"]) paidAnalysisRequests.push({ pathname, quoteId: route.request().headers()["x-zebby-credit-quote"] });
      const requestId = route.request().headers()["x-zebby-analysis-id"];
      analysisRequestIds.set(pathname, requestId);
      await new Promise((resolve) => { pending.set(pathname, resolve); requested.get(pathname)?.(); requested.delete(pathname); });
      pending.delete(pathname);
      if (await page.evaluate((id) => window.analysisQA.cancelled.includes(id), requestId)) {
        await route.abort().catch(() => undefined); return;
      }
      if (pathname.startsWith("/api/plans/") && failNextPlanAnalysis) {
        failNextPlanAnalysis = false;
        await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Synthetic interrupted analysis. Try again." }) }); return;
      }
      if (pathname.startsWith("/api/applications/")) {
        const id = pathname.split("/")[3];
        applications = applications.map((item) => item.id === id ? { ...item, matchStrength: 89, updatedAt: "2026-09-30T20:00:00Z" } : item);
        data = { application: applications.find((item) => item.id === id) };
      } else if (pathname.endsWith("/tailor")) {
        const id = pathname.split("/")[3];
        plans = plans.map(item => item.id !== id ? item : { ...item, tailoredResume: {
          docx: { id: "tailored-word", filename: "Sample Product CV - 123456 - tailored.docx" },
          pdf: { id: "tailored-pdf", filename: "Sample Product CV - 123456 - tailored.pdf" }, generatedAt: "2026-10-31T20:00:00Z", sourceHash: "fixture" } });
        plan = plans.find(item => item.id === id); data = { plan };
      } else { plan = { ...plan, matchStrength: 86,
        matchNotes: "Customer discovery and roadmap delivery are well demonstrated in the selected resume. The posting asks for deeper experimentation experience than the resume shows. The candidate has led product strategy, worked with design and engineering, and used customer evidence to prioritize work. The main gaps are direct experience in the posting's domain and clearer examples of experiments that connect product decisions to measured outcomes. The score reflects strong transferable product experience with room to demonstrate those specific requirements more clearly." };
        plans = plans.map((item) => item.id === plan.id ? plan : item); data = { plan }; }
    } else if (pathname.startsWith("/api/plans/") && method === "PUT") {
      const id = pathname.split("/")[3];
      const previous = plans.find((item) => item.id === id);
      const input = route.request().postDataJSON();
      const saved = { ...previous, ...input,
        keywordImportance: importanceForTerms(previous.keywords, previous.keywordImportance, input.keywords),
        themeImportance: importanceForTerms(previous.themes, previous.themeImportance, input.themes), updatedAt: "2026-09-30T20:00:00Z" };
      plans = plans.map((item) => item.id === id ? saved : item); if (id === plan.id) plan = saved;
      lastCurrentOverview = saved.currentOverview; data = { plan: saved };
    } else if (pathname.endsWith("/notes") && method === "PATCH") {
      const id = pathname.split("/")[3];
      applications = applications.map((item) => item.id === id ? { ...item, notes: route.request().postDataJSON().notes } : item);
      data = { application: applications.find((item) => item.id === id) };
    } else if (pathname.startsWith("/api/applications/") && method === "PATCH") {
      if (failNextStatusSave) { failNextStatusSave = false;
        await route.fulfill({ status: 500, json: { error: "Could not save status." } }); return; }
      const id = pathname.split("/")[3];
      const input = route.request().postDataJSON();
      applications = applications.map((item) => item.id === id ? { ...item, ...input, notes: item.notes } : item);
      data = { application: applications.find((item) => item.id === id) };
    } else throw new Error(`Unexpected mock API request: ${method} ${pathname}`);
    await route.fulfill({ json: data });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const nav = page.getByRole("navigation", { name: "Workspace" });
  await page.getByRole("main", { name: "Plan", exact: true }).waitFor();
  await checkBoardsRenderer(page, nav);
  if (process.env.ZEBBY_QA_BOARDS_ONLY === "1") { assert.deepEqual(errors, []); console.log("Boards renderer checks passed."); break checks; }
  const originalDatabase = await page.evaluate(() => window.desktop.state());
  for (const platform of ["win32", "darwin"]) {
    await page.evaluate(platform => {
      document.documentElement.dataset.platform = platform;
      window.modelQA.setDatabase({ platform, filePath: "", filename: "", startupError: "" });
    }, platform);
    const welcome = page.getByRole("main", { name: "Welcome", exact: true });
    await welcome.getByRole("heading", { name: "Your search, in one place.", exact: true }).waitFor();
    for (const label of ["Create database", "Open existing database"]) {
      await welcome.getByRole("button", { name: label, exact: true }).click();
      assert.equal(await welcome.isVisible(), true, "Canceling the file picker keeps the welcome screen");
    }
    await captureSettings(`welcome-${platform === "win32" ? "windows" : "mac"}.png`, false);
  }
  await page.evaluate(() => { window.modelQA.databaseResult = "error"; });
  await page.getByRole("button", { name: "Open existing database", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "The selected database could not be opened." }).waitFor();
  await page.evaluate(() => { window.modelQA.databaseResult = "success"; });
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByRole("main", { name: "Plan", exact: true }).waitFor();
  await page.evaluate(original => {
    window.modelQA.databaseResult = "cancel"; window.modelQA.databaseRequests = [];
    document.documentElement.dataset.platform = original.platform;
    window.modelQA.setDatabase(original);
  }, originalDatabase);
  await page.getByRole("main", { name: "Plan", exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector(".desktop-sidebar nav button")?.getBoundingClientRect().height > 0);
  assert.equal(await page.title(), "Zebby - Beta");
  assert.equal(await page.locator(".desktop-titlebar").innerText(), "Zebby - Beta");
  assert.equal(await page.locator(".sidebar-brand").innerText(), "");
  const chrome = await page.locator(".desktop-titlebar").evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    background: getComputedStyle(element).backgroundColor,
    drag: getComputedStyle(element).getPropertyValue("-webkit-app-region"),
    sidebar: getComputedStyle(document.querySelector(".titlebar-sidebar")).backgroundColor,
    sidebarBody: getComputedStyle(document.querySelector(".desktop-sidebar")).backgroundColor,
  }));
  assert.equal(chrome.height, 44);
  assert.equal(chrome.background, "rgb(248, 246, 243)");
  assert.equal(chrome.drag, "drag");
  assert.equal(chrome.sidebar, chrome.sidebarBody);
  assert.equal(await page.getByRole("heading", { name: "Plan", exact: true }).count(), 0);
  // Restoring the database can replace the sidebar between locator resolution
  // and evaluation. Resolve and measure the current node in one browser task.
  const sidebarPosition = await page.evaluate(() => {
    const element = document.querySelector(".desktop-sidebar");
    return {
    padding: getComputedStyle(element).paddingTop,
    brandBottom: getComputedStyle(element.querySelector(".sidebar-brand")).paddingBottom,
    zebraTop: element.querySelector(".brand-mark").getBoundingClientRect().top - element.getBoundingClientRect().top,
    zebraLeft: element.querySelector(".brand-mark").getBoundingClientRect().left - element.getBoundingClientRect().left,
    iconSize: element.querySelector(".navigation-icon").getBoundingClientRect().width,
    navHeight: element.querySelector("nav button").getBoundingClientRect().height,
    };
  });
  assert.deepEqual(sidebarPosition, { padding: "22px", brandBottom: "12px", zebraTop: 26, zebraLeft: 26, iconSize: 24, navHeight: 48 });
  await page.waitForFunction(() => [...document.querySelectorAll('.navigation-icon')].every(icon => icon.dataset.ready === "true"));
  assert.equal(await nav.locator('.navigation-icon-player svg').count(), 4);
  const animatedPlan = nav.locator('[data-kind="plan"]');
  // Compare painted geometry with subpixel tolerance rather than serialized
  // SVG bookkeeping, which need not be identical after an animation.
  await animatedPlan.evaluate((element) => {
    const number = (value) => String(Math.round(Number(value) * 1000) / 1000);
    const geometry = () => JSON.stringify([...element.querySelectorAll('.navigation-icon-player svg :is(g, path)')].map((shape) => ({
      kind: shape.tagName,
      path: (shape.getAttribute('d') || '').replace(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi, number),
      transform: (shape.getAttribute('transform') || '').replace(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi, number),
      opacity: number(getComputedStyle(shape).opacity),
      strokeWidth: number(Number.parseFloat(getComputedStyle(shape).strokeWidth)),
    })));
    window.__zebbyIconGeometry = geometry;
    window.__zebbyRestGeometry = geometry();
  });
  // Observe real SVG changes inside the browser before clicking. A fixed delay
  // between remote calls can miss this short animation on a busy CI runner.
  await animatedPlan.evaluate((element) => {
    const player = element.querySelector('.navigation-icon-player');
    const probe = { changed: false, returnedToRest: false };
    const observer = new MutationObserver(() => {
      const geometry = window.__zebbyIconGeometry();
      if (geometry !== window.__zebbyRestGeometry) probe.changed = true;
      else if (probe.changed) probe.returnedToRest = true;
    });
    observer.observe(player, { childList: true, subtree: true, attributes: true });
    window.__zebbyMotionProbe = probe;
    window.__stopZebbyMotionProbe = () => observer.disconnect();
  });
  await nav.getByRole("button", { name: "Plan", exact: true }).click();
  await page.waitForFunction(() => window.__zebbyMotionProbe.changed, null, { timeout: 5000 });
  await captureSettings("navigation-click-motion.png", false);
  await page.waitForFunction(() => window.__zebbyMotionProbe.returnedToRest &&
    document.querySelector('[data-kind="plan"]').dataset.playing === "false", null, { timeout: 5000 }).catch(async (error) => {
    const diagnostic = await page.evaluate(() => ({
      probe: window.__zebbyMotionProbe,
      playing: document.querySelector('[data-kind="plan"]').dataset.playing,
      expected: window.__zebbyRestGeometry,
      actual: window.__zebbyIconGeometry(),
    }));
    throw new Error(`Navigation icon did not return to rest: ${JSON.stringify(diagnostic)}`, { cause: error });
  });
  assert.equal(await page.evaluate(() => window.__zebbyIconGeometry() === window.__zebbyRestGeometry), true);
  await page.evaluate(() => {
    window.__stopZebbyMotionProbe();
    delete window.__stopZebbyMotionProbe;
    delete window.__zebbyMotionProbe;
    delete window.__zebbyIconGeometry;
    delete window.__zebbyRestGeometry;
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await nav.getByRole("button", { name: "Plan", exact: true }).focus();
  await page.keyboard.press("Enter");
  assert.equal(await animatedPlan.getAttribute("data-playing"), "false");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const control of [page.locator('.sidebar-toggle'), nav.getByRole('button', { name: 'Plan', exact: true }),
    page.locator('.match-why summary'), page.getByRole('button', { name: 'Analyze', exact: true })]) {
    assert.equal(await control.evaluate(element => getComputedStyle(element).cursor), "default");
  }
  assert.equal(await page.getByRole('textbox', { name: 'Current summary', exact: true }).evaluate(element => getComputedStyle(element).cursor), "text");
  await page.locator(".match-why summary").click();
  assert.equal(await page.locator(".match-why").getByRole("button", { name: "Add explanation", exact: true }).count(), 1);
  assert.equal(await page.locator(".cv-section").getByRole("button", { name: "Analyze", exact: true }).count(), 1);
  assert.equal(await page.locator(".analysis-section").getByRole("button", { name: "Analyze", exact: true }).count(), 0);
  const analyzePosition = await page.locator(".cv-section").evaluate((element) =>
    element.querySelector(".plan-analyze-actions").getBoundingClientRect().top >= element.querySelector(".resume-field").getBoundingClientRect().bottom);
  assert.equal(analyzePosition, true);
  const progressSlotHeight = await page.locator('.plan-progress-slot').evaluate(element => element.getBoundingClientRect().height);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.getByRole("status", { name: "Analyzing role" }).waitFor();
  assert.doesNotMatch(await page.locator(".match-result").innerText(), /Analyzing|Calculating/);
  assert.equal(await page.locator(".match-why").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Analysis in progress", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Move to Applied", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Copy keyword 1", exact: true }).isDisabled(), true);
  const planAnalysisPath = "/api/plans/plan-1/analyze";
  await waitForAnalysis(planAnalysisPath);
  async function reportPlanProgress(stage, requestId = analysisRequestIds.get(planAnalysisPath)) {
    await page.evaluate(event => window.analysisQA.progress(event), { stage, requestId });
  }
  const planProgress = page.locator('.plan-analysis-progress');
  const announcedProgress = page.getByRole('status', { name: 'Analyzing role' });
  assert.equal(await announcedProgress.innerText(), 'Preparing analysis');
  await reportPlanProgress('saving', '11111111-1111-4111-8111-111111111111');
  assert.equal(await announcedProgress.innerText(), 'Preparing analysis');
  await reportPlanProgress('waiting');
  await page.waitForFunction(() => document.querySelector('.plan-analysis-progress')?.dataset.stage === 'waiting');
  await planProgress.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => undefined)));
  });
  await reportPlanProgress('thinking');
  await page.waitForFunction(() => document.querySelector('.plan-analysis-progress')?.dataset.stage === 'thinking');
  const rollingMotion = await planProgress.evaluate(element => element.getAnimations({ subtree: true }).map(animation =>
    ({ name: animation.animationName, timing: animation.effect.getTiming(), frames: animation.effect.getKeyframes().map(frame => frame.transform) })));
  assert.equal(rollingMotion.length, 2);
  assert.equal(rollingMotion[0].timing.duration, rollingMotion[1].timing.duration);
  assert.equal(rollingMotion[0].timing.easing, rollingMotion[1].timing.easing);
  assert.ok(rollingMotion.some(animation => animation.name === 'plan-status-enter' && animation.frames[0] === 'translateY(-100%)'));
  assert.ok(rollingMotion.some(animation => animation.name === 'plan-status-leave' && animation.frames.at(-1) === 'translateY(100%)'));
  await planProgress.scrollIntoViewIfNeeded();
  await captureSettings('plan-progress-windows-light.png', false);
  assert.equal(await page.locator('.plan-progress-slot').evaluate(element => element.getBoundingClientRect().height), progressSlotHeight);
  const progressGeometry = await planProgress.evaluate(element => {
    const label = element.querySelector('.plan-progress-label:not(.is-leaving)');
    const range = document.createRange(); range.selectNodeContents(label);
    const time = element.querySelector('.plan-progress-time').getBoundingClientRect();
    const separator = element.querySelector('.plan-progress-separator');
    return { timerFirst: time.right < label.getBoundingClientRect().left, separator: separator.textContent,
      labelWidth: range.getBoundingClientRect().width, viewportWidth: label.clientWidth,
      belowButton: element.getBoundingClientRect().top >= document.querySelector('.plan-analyze-actions').getBoundingClientRect().bottom };
  });
  assert.ok(progressGeometry.labelWidth <= progressGeometry.viewportWidth); assert.equal(progressGeometry.belowButton, true);
  assert.equal(progressGeometry.timerFirst, true); assert.equal(progressGeometry.separator, '·');
  const activeTimer = await planProgress.locator('.plan-progress-time').innerText();
  await nav.getByRole('button', { name: 'Applications', exact: true }).click();
  await nav.getByRole('button', { name: 'Settings', exact: true }).click();
  await nav.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('status', { name: 'Analyzing role' }).waitFor();
  assert.equal(await announcedProgress.innerText(), 'Thinking');
  assert.equal(await page.getByLabel('Current summary', { exact: true }).isDisabled(), true);
  assert.ok(await planProgress.locator('.plan-progress-time').innerText() >= activeTimer);
  assert.deepEqual(await page.evaluate(() => window.analysisQA.cancelled), []);
  const runningPlan = await page.locator('.plan-item[aria-current="page"] strong').innerText();
  await page.getByRole('button', { name: 'New plan', exact: true }).click();
  const secondOverview = 'A new draft remains editable while another role is analyzed.';
  await page.getByLabel('Current summary', { exact: true }).fill(secondOverview);
  await reportPlanProgress('generating');
  assert.equal(await page.getByLabel('Current summary', { exact: true }).inputValue(), secondOverview);
  assert.equal(await planProgress.count(), 0);
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.plan-item').filter({ has: page.locator('strong').filter({ hasText: runningPlan }) }).click();
  await page.getByRole('status', { name: 'Analyzing role' }).waitFor();
  assert.equal(await announcedProgress.innerText(), 'Generating results');
  assert.equal(await page.getByLabel('Current summary', { exact: true }).isDisabled(), true);
  await page.setViewportSize({ width: 790, height: 850 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.dataset.platform = 'darwin'; });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await reportPlanProgress('generating');
  await page.waitForFunction(() => document.querySelector('.plan-analysis-progress')?.dataset.stage === 'generating');
  assert.deepEqual(await planProgress.evaluate(element => element.getAnimations({ subtree: true }).map(animation => animation.animationName)), []);
  await reportPlanProgress('generating'); await reportPlanProgress('thinking');
  assert.equal(await announcedProgress.innerText(), 'Generating results');
  await planProgress.scrollIntoViewIfNeeded();
  await captureSettings('plan-progress-mac-dark-narrow.png', false);
  assert.equal(await page.locator('.plan-document-scroll').evaluate(element => element.scrollWidth > element.clientWidth), false);
  await page.setViewportSize({ width: 1550, height: 850 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; document.documentElement.dataset.platform = 'win32'; });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await reportPlanProgress('saving');
  await page.waitForFunction(() => document.querySelector('.plan-analysis-progress')?.dataset.stage === 'saving');
  assert.equal(await page.locator('.plan-analyze-actions').getByRole('button', { name: 'Cancel', exact: true }).isDisabled(), true);
  const finishedRequestId = analysisRequestIds.get(planAnalysisPath);
  await completeAnalysis("/api/plans/plan-1/analyze");
  await page.locator(".match-result").getByText("86%").waitFor();
  assert.equal(await planProgress.count(), 0);
  assert.equal(await page.locator('.plan-progress-slot').evaluate(element => element.getBoundingClientRect().height), progressSlotHeight);
  await reportPlanProgress('thinking', finishedRequestId);
  assert.equal(await planProgress.count(), 0);
  // Cancellation, failure, and retry each reset the line while retaining saved results.
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await waitForAnalysis(planAnalysisPath);
  const cancelledRequestId = analysisRequestIds.get(planAnalysisPath);
  await reportPlanProgress('waiting');
  await page.locator('.plan-analyze-actions').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.plan-analysis-progress'));
  assert.equal(await page.getByText('Analysis cancelled.', { exact: true }).count(), 0);
  assert.equal(await planProgress.count(), 0);
  assert.match(await page.locator('.match-result').innerText(), /86%/);
  await completeAnalysis(planAnalysisPath);
  await page.waitForFunction(() => window.analysisQA.cancelled.length === 1);
  failNextPlanAnalysis = true;
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await waitForAnalysis(planAnalysisPath);
  await reportPlanProgress('saving', cancelledRequestId);
  assert.equal(await announcedProgress.innerText(), 'Preparing analysis');
  await reportPlanProgress('waiting');
  await completeAnalysis(planAnalysisPath);
  await page.getByText('Synthetic interrupted analysis. Try again.', { exact: true }).waitFor();
  assert.equal(await planProgress.count(), 0);
  assert.match(await page.locator('.match-result').innerText(), /86%/);
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await waitForAnalysis(planAnalysisPath);
  await page.evaluate(requestId => {
    for (const stage of ['waiting', 'thinking', 'generating']) window.analysisQA.progress({ requestId, stage });
  }, analysisRequestIds.get(planAnalysisPath));
  await page.waitForFunction(() => document.querySelector('.plan-analysis-progress')?.dataset.stage === 'generating');
  assert.ok(await page.locator('.plan-progress-label').count() <= 2);
  await completeAnalysis(planAnalysisPath);
  // A previous save confirmation can still be visible while this request settles.
  // Wait for this analysis to finish before asserting its feedback and unlocked UI.
  await planProgress.waitFor({ state: 'hidden' });
  await page.locator('.workspace-save-feedback').getByText('Saved', { exact: true }).waitFor();
  assert.equal(await planProgress.count(), 0);
  await page.locator(".match-why summary").focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(".match-why").getAttribute("open"), "");
  assert.match(await page.locator(".match-why").innerText(), /deeper experimentation experience/);
  await assertFullTextRows(page.locator(".match-why p"));
  await page.locator(".match-why").scrollIntoViewIfNeeded();
  await captureSettings("plan-score-copy-wide-light.png", false);
  await page.setViewportSize({ width: 790, height: 850 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await assertFullTextRows(page.locator(".match-why p"));
  assert.equal(await page.locator(".plan-document-scroll").evaluate(element => element.scrollWidth > element.clientWidth), false);
  await page.locator(".match-why").scrollIntoViewIfNeeded();
  await captureSettings("plan-score-copy-narrow-dark.png", false);
  await page.setViewportSize({ width: 1550, height: 850 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.locator(".plan-document-scroll").evaluate(element => { element.scrollTop = 0; });
  const keywordRows = page.locator(".recommendations-keywords .recommendation-row");
  const themeRows = page.locator(".recommendations-themes .recommendation-row");
  assert.equal(await keywordRows.first().locator(".recommendation-importance").innerText(), "96%");
  assert.equal(await themeRows.first().locator(".recommendation-importance").innerText(), "95%");
  assert.equal(await page.getByRole("button", { name: "Copy ATS keywords", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Copy resume themes", exact: true }).count(), 0);
  await page.getByRole("button", { name: "Copy keyword 1", exact: true }).click();
  assert.equal(await page.evaluate(() => window.controlsQA.copied), "Product strategy");
  await page.getByRole("button", { name: "Copy theme 1", exact: true }).click();
  assert.equal(await page.evaluate(() => window.controlsQA.copied), "Lead discovery");
  await page.getByText("Copied theme 1", { exact: true }).waitFor();
  const copyPosition = await themeRows.first().getByRole("button", { name: "Copy theme 1", exact: true }).boundingBox();
  const removePosition = await themeRows.first().getByRole("button", { name: "Remove theme 1", exact: true }).boundingBox();
  assert.ok(copyPosition.x + copyPosition.width <= removePosition.x);
  await page.evaluate(() => { window.controlsQA.failCopy = true; });
  await page.getByRole("button", { name: "Copy theme 1", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Could not copy. Select the text and copy it." }).waitFor();
  await page.evaluate(() => { window.controlsQA.failCopy = false; });
  await page.getByRole("button", { name: "Copy theme 1", exact: true }).click();
  assert.equal(await page.getByRole("alert").filter({ hasText: "Could not copy." }).count(), 0);
  assert.equal(await page.getByText("Estimated job importance.", { exact: false }).count(), 0);
  assert.equal(await page.locator('.importance-column').getByText('Importance', { exact: true }).count(), 2);
  assert.equal(await page.locator(".brand-mark").evaluate((element) => element.complete && element.naturalWidth > 0), true);
  await captureSettings("plan-windows-light.png");
  if (captureImages) await page.locator(".cv-section").screenshot({ path: path.join(output, "plan-cv-actions-light.png") });
  const overviewBeforeCollapse = await page.getByRole("textbox", { name: "Current summary", exact: true }).inputValue();
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector(".sidebar-toggle")?.getAttribute("aria-expanded") === "false" && !document.querySelector(".sidebar-toggle")?.disabled);
  await settleSidebar();
  assert.equal(await nav.locator(".nav-label").first().isVisible(), false);
  assert.equal(await nav.getByRole("button", { name: "Plan", exact: true }).isVisible(), true);
  assert.equal(await page.locator(".desktop-sidebar").evaluate((element) => element.getBoundingClientRect().width), 96);
  assert.equal(await page.locator(".titlebar-sidebar").evaluate((element) => element.getBoundingClientRect().width), 96);
  assert.equal(await page.getByRole("textbox", { name: "Current summary", exact: true }).inputValue(), overviewBeforeCollapse);
  assert.equal(await page.evaluate(async () => (await window.desktop.state()).sidebarCollapsed), true);
  assert.equal(await page.locator(".sidebar-database").count(), 0);
  await captureSettings("plan-windows-collapsed-light.png");
  await page.getByRole("button", { name: "Expand navigation", exact: true }).focus();
  await page.keyboard.press("Space");
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).waitFor();
  await settleSidebar();
  assert.equal(await nav.locator(".nav-label").first().isVisible(), true);
  await captureAnalysis("plan-analysis-light.png", "readme-plan.png");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await captureSettings("plan-windows-dark.png");
  await captureAnalysis("plan-analysis-dark.png");
  if (captureImages) await page.locator(".cv-section").screenshot({ path: path.join(output, "plan-cv-actions-dark.png") });
  await page.setViewportSize({ width: 1050, height: 900 });
  await captureSettings("plan-windows-compact.png");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 790, height: 850 });
  await captureSettings("plan-windows-narrow.png");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.setViewportSize({ width: 1550, height: 850 });
  // Percentages survive CV edits but become unknown when the job or term changes.
  const currentOverview = page.getByRole("textbox", { name: "Current summary", exact: true });
  const originalOverview = await currentOverview.inputValue();
  await currentOverview.fill("I lead product teams and measure customer outcomes.");
  assert.equal(await page.locator(".match-why").count(), 0);
  assert.equal(await page.locator(".match-result").getByText("Not analyzed", { exact: true }).count(), 1);
  assert.equal(await keywordRows.first().locator(".recommendation-importance").innerText(), "96%");
  await currentOverview.fill(originalOverview);
  await page.getByRole("textbox", { name: "Core ATS keyword 1", exact: true }).fill("Product vision");
  await page.getByRole("button", { name: "Copy keyword 1", exact: true }).click();
  assert.equal(await page.evaluate(() => window.controlsQA.copied), "Product vision");
  assert.equal(await keywordRows.first().locator(".recommendation-importance").innerText(), "Unrated");
  assert.equal(await keywordRows.nth(1).locator(".recommendation-importance").innerText(), "94%");
  await page.getByRole("textbox", { name: "Core ATS keyword 1", exact: true }).fill("Product strategy");
  await page.getByRole("textbox", { name: "Company", exact: true }).fill("Changed company");
  assert.equal(await page.locator(".recommendation-importance:not(.unrated)").count(), 0);
  await page.getByRole("textbox", { name: "Company", exact: true }).fill("Expedia Group");
  await page.getByRole("button", { name: "Add keyword", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Copy keyword 7", exact: true }).isDisabled(), true);
  await page.getByRole("textbox", { name: "Core ATS keyword 7", exact: true }).fill("SQL");
  assert.equal(await keywordRows.last().locator(".recommendation-importance").innerText(), "Unrated");
  await page.getByRole("button", { name: "Remove keyword 7", exact: true }).click();
  await page.getByRole("button", { name: "New plan", exact: true }).click();
  assert.equal(await currentOverview.inputValue(), originalOverview);
  assert.equal(await page.getByText("Unsaved changes", { exact: true }).count(), 0);
  assert.equal(await keywordRows.count(), 0);
  await currentOverview.fill("I lead discovery and turn evidence into clear product decisions.");
  await page.getByRole("textbox", { name: "Job listing link", exact: true }).fill("https://example.org/new-role");
  await page.getByRole("button", { name: "Save plan", exact: true }).click();
  await page.locator(".workspace-save-feedback").getByText("Saved", { exact: true }).waitFor();
  await page.getByRole("button", { name: "New plan", exact: true }).click();
  assert.equal(await currentOverview.inputValue(), lastCurrentOverview);
  assert.equal(lastCurrentOverview, "I lead discovery and turn evidence into clear product decisions.");
  await page.getByRole("button", { name: /Senior Product Manager.*Expedia Group.*Edited/ }).click();
  assert.equal(await currentOverview.inputValue(), originalOverview, "Opening an existing plan keeps that plan's overview.");
  const savedPriority = plan.keywordImportance;
  plan = { ...plan, keywordImportance: [], themeImportance: [] }; plans = [plan, ...plans.filter((item) => item.id !== plan.id)];
  await page.reload();
  await page.getByRole("textbox", { name: "Core ATS keyword 1", exact: true }).waitFor();
  assert.equal(await page.locator(".recommendation-importance:not(.unrated)").count(), 0);
  plan = { ...plan, keywordImportance: savedPriority, themeImportance: [95, 92, 87, 81, 76] }; plans = plans.map((item) => item.id === plan.id ? plan : item);
  await page.reload();
  await page.getByRole("textbox", { name: "Core ATS keyword 1", exact: true }).waitFor();
  // Moving a plan saves edits and opens the exact application without invoking analysis or credits.
  const beforeMovePlans = [...plans], beforeMoveApplications = [...applications];
  const movePlan = { ...plan, id: "plan-transfer", listingUrl: "https://example.org/roles/transfer",
    title: "Transfer Product Manager", company: "Example Move" };
  plans = [movePlan, ...plans];
  await page.reload();
  const moveButton = page.getByRole("button", { name: "Move to Applied", exact: true });
  await moveButton.waitFor();
  await page.setViewportSize({ width: 1550, height: 850 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  const saveBounds = await page.getByRole("button", { name: "Save plan", exact: true }).boundingBox();
  const moveBounds = await moveButton.boundingBox();
  assert.ok(moveBounds.x > saveBounds.x + saveBounds.width);
  assert.equal(moveBounds.y, saveBounds.y);
  await captureSettings("plan-move-windows-light.png", false);
  await page.setViewportSize({ width: 790, height: 850 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; document.documentElement.dataset.platform = "darwin"; });
  assert.equal(await page.locator(".plan-actions").evaluate(element => element.scrollWidth > element.clientWidth), false);
  await captureSettings("plan-move-mac-dark.png", false);
  await page.setViewportSize({ width: 1550, height: 850 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; document.documentElement.dataset.platform = "win32"; });
  await page.getByRole("textbox", { name: "Suggested edits - Resume summary", exact: true }).fill("An edited overview to preserve.");
  const moveRequests = [], recordMoveRequest = request => moveRequests.push(new URL(request.url()).pathname);
  const quoteCountBeforeMove = await page.evaluate(() => window.creditQA.quoteRequests.length);
  page.on("request", recordMoveRequest);
  failNextPlanMove = true;
  await moveButton.click();
  await page.getByText("The database could not be saved. Try again.", { exact: true }).waitFor();
  assert.equal(await moveButton.isEnabled(), true);
  assert.equal(await page.getByRole("textbox", { name: "Suggested edits - Resume summary", exact: true }).inputValue(), "An edited overview to preserve.");
  await moveButton.click();
  await page.getByText("Moved to Applied.", { exact: true }).waitFor();
  await page.locator(".application-row.selected").getByText(movePlan.title, { exact: true }).waitFor();
  const moved = applications.find((item) => item.listingUrl === movePlan.listingUrl);
  assert.equal(moved.matchStrength, movePlan.matchStrength);
  assert.equal(moved.matchNotes, movePlan.matchNotes);
  assert.equal(plans.find((item) => item.id === movePlan.id).overview, "An edited overview to preserve.");
  assert.equal(moveRequests.includes(`/api/plans/${movePlan.id}`), true, "Unsaved Plan edits are saved before moving.");
  await nav.getByRole("button", { name: "Plan", exact: true }).click();
  await moveButton.click();
  await page.getByText("This job is already in Applications.", { exact: true }).waitFor();
  assert.equal(applications.length, beforeMoveApplications.length + 1);
  assert.equal(moveRequests.some(url => url.endsWith("/analyze")), false);
  assert.equal(await page.evaluate(() => window.creditQA.quoteRequests.length), quoteCountBeforeMove);
  page.off("request", recordMoveRequest);
  plans = beforeMovePlans; applications = beforeMoveApplications;
  await page.reload();
  await page.getByRole("textbox", { name: "Core ATS keyword 1", exact: true }).waitFor();
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  assert.equal(await page.getByText("Analysis details", { exact: true }).count(), 0);
  const tailorButton = page.getByRole("button", { name: "Create tailored resume", exact: true });
  const tailoringPath = `/api/plans/${plans[0].id}/tailor`;
  await tailorButton.click(); await waitForAnalysis(tailoringPath);
  await page.locator('.tailored-resume-section .plan-analysis-progress').waitFor();
  await captureSettings("plan-tailoring.png", false);
  await nav.getByRole("button", { name: "Settings", exact: true }).click();
  await nav.getByRole("button", { name: "Plan", exact: true }).click();
  await page.locator('.tailored-resume-section .plan-analysis-progress').waitFor();
  await completeAnalysis(tailoringPath);
  await page.locator('.tailored-resume-files').waitFor();
  await page.getByRole("button", { name: /Sample Product CV.*tailored.docx/ }).click();
  await page.getByRole("button", { name: /Sample Product CV.*tailored.pdf/ }).click();
  assert.deepEqual(await page.evaluate(() => window.controlsQA.revealed.map(item => item.format)), ['docx', 'pdf']);
  await captureSettings("plan-tailored-files.png", false);
  await tailorButton.click(); await waitForAnalysis(tailoringPath);
  await page.locator('.tailored-resume-section').getByRole('button', { name: 'Cancel', exact: true }).click();
  await tailorButton.waitFor();
  assert.equal(await page.locator('.tailored-resume-files button').count(), 2);
  await completeAnalysis(tailoringPath);
  await nav.getByRole("button", { name: "Applications", exact: true }).click();
  await page.getByRole("main", { name: "Applications", exact: true }).waitFor();
  const table = page.locator(".application-list");
  await table.getByText("Expedia Group", { exact: true }).waitFor();
  await assertApplicationMetrics();
  const pane = page.getByRole("complementary", { name: "Selected role details", exact: true });
  const firstRow = table.locator(".application-row").first(), firstSelector = firstRow.locator(".application-row-select");
  const listWidth = await table.evaluate((element) => element.clientWidth);
  await pane.getByRole("button", { name: "Close details", exact: true }).click();
  assert.equal(await pane.count(), 0);
  assert.equal(await firstSelector.evaluate((element) => element === document.activeElement), true);
  assert.ok(await table.evaluate((element) => element.clientWidth) > listWidth + 300);
  const firstBox = await firstRow.boundingBox();
  await firstRow.click({ position: { x: firstBox.width / 2, y: firstBox.height - 8 } });
  await pane.waitFor();
  assert.equal(await firstSelector.getAttribute("aria-expanded"), "true");
  await pane.getByRole("button", { name: "Close details", exact: true }).click();
  await firstSelector.press("Space"); await pane.waitFor();
  assert.equal(await page.getByRole("heading", { name: "Applications", exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Analyze again" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Saved copy" }).count(), 0);
  assert.equal(await page.locator(".activity-day").count(), 30);
  assert.match(await page.locator(".activity-caption").innerText(), /11 applications/);
  const today = page.getByRole("button", { name: "Sep 30, 2026: 0 applications", exact: true });
  await today.focus(); await today.press("ArrowLeft");
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Sep 29, 2026: 2 applications, Applied: 2");
  await page.locator(".activity-day:focus").press("Home");
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), "Sep 1, 2026: 0 applications");
  assert.equal(await page.locator('.activity-legend').count(), 0);
  const statusDay = page.locator('.activity-day[data-date="2026-09-29"]');
  const originalBarHeight = await statusDay.locator('.activity-bar').evaluate(element => element.getBoundingClientRect().height);
  const firstStatus = firstRow.getByRole('combobox', { name: 'Status for Senior Product Manager at Expedia Group', exact: true });
  assert.equal(await firstStatus.locator('option').count(), 5);
  failNextStatusSave = true;
  await firstStatus.selectOption('Offer received');
  await page.getByText('Could not save status.', { exact: true }).waitFor();
  assert.equal(await firstStatus.inputValue(), 'Applied');
  assert.equal(await page.locator('.offer-confetti').count(), 0, 'Failed status saves never celebrate');
  await firstStatus.selectOption('Offer received');
  await page.locator('.offer-confetti').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.offer-confetti').evaluate(element => getComputedStyle(element).pointerEvents), 'none');
  assert.equal(await firstStatus.evaluate(element => getComputedStyle(element).color), 'rgb(32, 90, 154)');
  await page.waitForFunction(() => document.querySelector('.activity-segment[data-status="Offer received"]')?.dataset.count === '1');
  await page.waitForTimeout(650);
  await captureSettings('applications-offer-windows-light.png', false);
  await page.locator('.offer-confetti').waitFor({ state: 'detached', timeout: 3500 });
  await firstStatus.selectOption('Offer received');
  assert.equal(await page.locator('.offer-confetti').count(), 0, 'Reselecting an existing offer does not replay confetti');
  const statusFilter = page.getByRole('combobox', { name: 'Filter by status', exact: true });
  assert.equal(await statusFilter.getByRole('option', { name: 'Offer received (1)', exact: true }).count(), 1);
  await statusFilter.selectOption('Offer received');
  assert.equal(await table.locator('.application-row').count(), 1);
  await statusFilter.selectOption('All statuses');
  await firstStatus.selectOption('Applied');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await firstStatus.selectOption('Offer received');
  await page.getByText('Offer received. Congratulations!', { exact: true }).waitFor();
  assert.equal(await page.locator('.offer-confetti').isVisible(), false, 'Reduced motion retains success feedback without flying particles');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const status of ['Heard back', 'Interview scheduled', 'Rejected']) {
    await firstStatus.selectOption(status);
    await page.waitForFunction((status) => document.querySelector(`.activity-day[data-date="2026-09-29"] .activity-segment[data-status="${status}"]`)?.dataset.count === '1', status);
    assert.equal(await statusDay.locator('.activity-segment[data-status="Applied"]').getAttribute('data-count'), '1');
    assert.equal(await page.locator('.activity-day[data-date="2026-09-30"] .activity-segment').count(), 0);
  }
  await table.getByRole('combobox', { name: 'Status for Product Manager at Meta', exact: true }).selectOption('Interview scheduled');
  await page.waitForFunction(() => !document.querySelector('.activity-day[data-date="2026-09-29"] .activity-segment[data-status="Applied"]'));
  assert.equal(await statusDay.locator('.activity-segment[data-status="Interview scheduled"]').getAttribute('data-count'), '1');
  assert.equal(await statusDay.locator('.activity-segment[data-status="Rejected"]').getAttribute('data-count'), '1');
  assert.equal(await statusDay.locator('.activity-bar').evaluate(element => element.getBoundingClientRect().height), originalBarHeight);
  await assertActivityTooltipBounds();
  await statusDay.focus();
  await captureSettings('applications-status-tooltip-windows-light.png', false);
  await statusDay.press('Escape');
  assert.equal(await statusDay.locator('.activity-tooltip').evaluate(element => getComputedStyle(element).visibility), 'hidden');
  await firstSelector.focus();
  await page.getByRole("button", { name: "Show all 8 locations" }).click();
  const expanded = page.locator(".location-expanded");
  assert.equal(await expanded.locator(".location-place").count(), 8);
  assert.equal(await expanded.isVisible(), true);
  await page.getByRole("button", { name: "Hide extra locations" }).click();
  assert.equal(await expanded.isVisible(), false);
  await table.getByRole("button", { name: "Edit Senior Product Manager at Expedia Group" }).click();
  await assertLocationKeyboard(page.locator(".editor .location-editor"), "Windows Applications");
  await page.getByLabel("Team", { exact: true }).fill("Search & Recommendations");
  await table.getByRole("button", { name: "Notes for Senior Product Manager at Expedia Group" }).click();
  const notes = page.getByRole("dialog", { name: "Notes" }).getByRole("textbox", { name: "Notes" });
  assert.equal(await notes.inputValue(), description);
  await notes.fill(`${description}\n\nRecruiter: Sam`);
  await captureSettings("notes.png", false);
  await page.getByRole("button", { name: "Save notes" }).click();
  await page.locator(".workspace-save-feedback").getByText("Saved", { exact: true }).waitFor();
  assert.equal(applications[0].notes, `${description}\n\nRecruiter: Sam`);
  await page.getByRole("button", { name: "Save changes" }).click();
  await page.locator('.workspace-save-feedback').getByText('Saved', { exact: true }).waitFor();
  assert.equal(applications[0].notes, `${description}\n\nRecruiter: Sam`);
  await table.getByRole("button", { name: "Refresh match for Senior Product Manager at Expedia Group" }).click();
  await table.getByRole("status", { name: "Analyzing resume match" }).first().waitFor();
  assert.equal(await table.locator(".match-control").first().innerText(), "");
  assert.equal(await table.getByRole("button", { name: "Refresh match for Product Manager at Meta" }).count(), 1);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await captureSettings("applications-light.png", false);
  await page.getByRole("button", { name: "Refresh match for Product Manager at Meta" }).click();
  assert.equal(await table.getByRole("status", { name: "Analyzing resume match" }).count(), 2);
  await nav.getByRole('button', { name: 'Settings', exact: true }).click();
  await completeAnalysis("/api/applications/app-1/analyze");
  await nav.getByRole('button', { name: 'Applications', exact: true }).click();
  await table.getByText("89%").first().waitFor();
  assert.equal(await table.getByRole('button', { name: 'Edit Product Manager at Meta', exact: true }).isDisabled(), true);
  assert.equal(await table.getByRole('button', { name: 'Edit Senior Product Manager at Expedia Group', exact: true }).isDisabled(), false);
  assert.equal(await table.getByRole('status', { name: 'Analyzing resume match' }).count(), 1);
  await completeAnalysis("/api/applications/app-2/analyze");
  await table.getByText("89%").first().waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".match-progress").length === 0);
  await captureSettings("applications-ready-light.png", false);
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
  await page.getByRole("button", { name: "Expand navigation", exact: true }).waitFor();
  await captureSettings("applications-collapsed-light.png", false);
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await captureSettings("applications-collapsed-dark.png", false);
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).waitFor();
  if (process.env.ZEBBY_CAPTURE_DOCS) {
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await page.getByRole("button", { name: "Applications", exact: true }).click();
    await page.getByRole("button", { name: "Add application", exact: true }).waitFor();
    await page.mouse.move(30, 30);
    await captureSettings("readme-applications.png", false);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await captureSettings("applications-dark.png", false);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await table.getByRole("button", { name: "Refresh match for Senior Product Manager at Expedia Group" }).click();
  await table.getByRole("status", { name: "Analyzing resume match" }).first().waitFor();
  assert.equal(await table.locator(".match-progress-arc").evaluate((element) => getComputedStyle(element).animationName), "none");
  await completeAnalysis("/api/applications/app-1/analyze");
  await page.waitForFunction(() => document.querySelectorAll(".match-progress").length === 0);
  await page.setViewportSize({ width: 1050, height: 900 });
  await captureSettings("applications-compact.png", false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.locator(".application-inspector").count(), 0);
  assert.equal(await table.locator(".row-actions").first().evaluate((element) => element.getBoundingClientRect().right <= innerWidth), true);
  await page.setViewportSize({ width: 780, height: 900 });
  await assertApplicationMetrics();
  await assertActivityTooltipBounds();
  await captureSettings("applications-narrow.png", false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

  // Provider choice, download lifecycle, deletion cancellation, and reuse.
  // The native confirmation itself is covered in the model removal tests.
  await page.setViewportSize({ width: 1440, height: 960 });
  await nav.getByRole("button", { name: "Settings", exact: true }).click();
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  const provider = page.getByRole("combobox", { name: "Analyze with", exact: true });
  await page.getByRole("main", { name: "Settings", exact: true }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Settings", exact: true }).count(), 0);
  assert.equal(await page.getByText("Preferences for this computer.", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("switch", { name: /logs|errors/i }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Create database copy", exact: true }).count(), 0);
  assert.doesNotMatch(await page.locator(".settings-page").innerText(), /weekly backups|Logs may include/i);
  assert.equal(await page.getByText("Quit Zebby and wait for file sync before switching computers.", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "Create new database", exact: true }).click();
  await page.getByRole("button", { name: "Open database", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.modelQA.databaseRequests), ["create", "open"]);
  assert.equal(await page.getByRole("link", { name: "Report an issue", exact: true }).getAttribute("href"),
    "https://github.com/desigrit/zebby-the-scout-beta/issues/new");
  assert.equal(await page.getByRole("link", { name: "Report an issue", exact: true }).getAttribute("target"), "_blank");
  await page.evaluate(() => { window.modelQA.failLogOpen = true; });
  await page.getByRole("button", { name: "Open logs folder", exact: true }).click();
  await page.getByRole("alert").getByText("Synthetic logs folder error", { exact: true }).waitFor();
  await page.evaluate(() => { window.modelQA.failLogOpen = false; });
  await page.getByRole("button", { name: "Open logs folder", exact: true }).click();
  assert.equal(await page.evaluate(() => window.modelQA.logOpens), 1);
  assert.equal(await page.getByRole("alert").count(), 0);
  await page.getByRole("combobox", { name: "Model", exact: true }).getByRole("option", { name: "qwen3.8:27b", exact: true }).waitFor({ state: "attached" });
  await assertSettingsActions();
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('qwen3:8b');
  await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('qwen3.8:27b');
  assert.equal(await page.evaluate(() => window.desktop.state().then(state => state.ollamaModel)), 'qwen3.8:27b');
  await page.getByRole('switch', { name: 'Extended thinking', exact: true }).click();
  await captureSettings('settings-actions-server-windows-light.png', false);
  await provider.selectOption("builtin");
  const localModel = page.getByRole("combobox", { name: "Local model", exact: true });
  await localModel.waitFor();
  assert.equal(await localModel.getByRole("option").count(), LOCAL_MODELS.length + 1);
  assert.equal(await page.getByRole("button", { name: /Delete SmolLM2/ }).count(), 0);
  await localModel.selectOption("smollm2-360m");
  await page.getByRole('status').filter({ hasText: 'Downloading' }).waitFor();
  assert.equal(await page.getByRole('switch', { name: 'Extended thinking', exact: true }).count(), 0);
  assert.equal(await page.getByRole('radiogroup', { name: 'Thinking level', exact: true }).count(), 0);
  await page.evaluate(() => window.modelQA.update("smollm2-360m", { downloadedBytes: 81000000 }));
  await page.getByText("81 MB / 271 MB", { exact: true }).waitFor();
  assert.equal(await page.locator('.local-model-picker .model-size-badge').innerText(), '271 MB');
  await assertSettingsActions();
  const progress = page.getByRole("progressbar", { name: "SmolLM2 360M download progress" });
  assert.equal(await progress.getAttribute("max"), "270590880");
  await captureSettings("settings-windows-download.png");
  const pauseDownload = page.getByRole('button', { name: 'Pause SmolLM2 360M download', exact: true });
  assert.equal(await pauseDownload.innerText(), '');
  assert.equal(await pauseDownload.evaluate(element => getComputedStyle(element).borderWidth), '0px');
  await pauseDownload.click();
  await page.getByText("Paused", { exact: true }).waitFor();
  const resumeDownload = page.getByRole('button', { name: 'Resume SmolLM2 360M download', exact: true });
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Resume SmolLM2 360M download');
  assert.equal(await resumeDownload.evaluate(element => element === document.activeElement), true);
  await captureSettings('analysis-quiet-paused-windows-light.png', false);
  await resumeDownload.click();
  await page.evaluate(() => window.modelQA.update("smollm2-360m", { status: "error", error: "The download stopped early. Choose Retry download to continue." }));
  await page.getByRole("alert").getByText(/stopped early/).waitFor();
  await captureSettings('analysis-quiet-error-windows-light.png', false);
  await page.getByRole('button', { name: 'Retry SmolLM2 360M download', exact: true }).click();
  await page.getByRole('button', { name: 'Stop SmolLM2 360M download', exact: true }).click();
  await page.getByText('Not downloaded', { exact: true }).waitFor();
  assert.equal(await page.getByRole('progressbar', { name: 'SmolLM2 360M download progress' }).count(), 0);
  assert.deepEqual(await page.evaluate(() => window.modelQA.stopRequests), ['smollm2-360m']);
  await page.getByRole('button', { name: 'Download model', exact: true }).click();
  await page.evaluate(() => window.modelQA.update("smollm2-360m", { status: "verifying", downloadedBytes: 270590880 }));
  await page.getByText("Verifying", { exact: true }).waitFor();
  await page.evaluate(() => window.modelQA.update("smollm2-360m", { status: "ready" }));
  await page.getByText("Installed", { exact: true }).waitFor();
  assert.equal(await progress.count(), 0);
  await page.locator('.local-model-library > summary').click();
  // Transfer actions stay on the unselected library model, then return to the
  // library disclosure when Stop removes its partial file and row.
  await page.evaluate(() => window.modelQA.update('qwen3-06b', { status: 'paused', downloadedBytes: 1000000, error: '' }));
  const libraryResume = page.getByRole('button', { name: 'Resume Qwen3 0.6B download', exact: true });
  await libraryResume.focus(); await libraryResume.press('Enter');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Pause Qwen3 0.6B download');
  assert.equal(await localModel.inputValue(), 'smollm2-360m');
  const libraryPause = page.getByRole('button', { name: 'Pause Qwen3 0.6B download', exact: true });
  await libraryPause.press('Enter');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Resume Qwen3 0.6B download');
  await captureSettings('analysis-library-paused-focus-windows-light.png', false);
  const libraryStop = page.getByRole('button', { name: 'Stop Qwen3 0.6B download', exact: true });
  await libraryStop.focus(); await libraryStop.press('Enter');
  await page.waitForFunction(() => document.activeElement === document.querySelector('.local-model-library > summary'));
  assert.equal(await page.locator('.local-model-library [data-model-id="qwen3-06b"]').count(), 0);
  assert.equal(await localModel.inputValue(), 'smollm2-360m');
  assert.deepEqual(await page.evaluate(() => window.modelQA.stopRequests), ['smollm2-360m', 'qwen3-06b']);
  await captureSettings('analysis-library-stopped-focus-windows-light.png', false);
  const deleteModel = page.getByRole("button", { name: "Remove SmolLM2 360M", exact: true });
  await deleteModel.click(); // Simulated native Cancel result.
  assert.equal(await page.getByText("Installed", { exact: true }).count(), 1);
  await provider.selectOption("openai");
  await page.getByRole("textbox", { name: "API key", exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'API key', exact: true }).fill('sk-fixture-only');
  assert.equal(await page.getByRole('button', { name: 'Save key', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0);
  await page.getByRole('textbox', { name: 'API key', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Remove key', exact: true }).waitFor();
  await assertSettingsActions();
  assert.equal(await page.getByRole('textbox', { name: 'API key', exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Saved API key', { exact: true }).innerText(), 'sk-••••••••only');
  assert.equal(await page.evaluate(() => window.modelQA.keySaveAttempts), 1);
  const analysisModel = page.getByRole('combobox', { name: 'Model', exact: true });
  const thinking = page.getByRole('radiogroup', { name: 'Thinking level', exact: true });
  assert.deepEqual(await analysisModel.locator('option').evaluateAll(options => options.map(option => option.value)),
    ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-6-astra']);
  await thinking.getByRole('radio', { name: 'Maximum', exact: true }).click(); await analysisModel.selectOption('gpt-6-luna');
  await thinking.getByRole('radio', { name: 'Off', exact: true }).waitFor();
  await thinking.getByRole('radio', { name: 'High', checked: true, exact: true }).waitFor();
  await thinking.getByRole('radio', { name: 'Off', exact: true }).click();
  await analysisModel.selectOption('gpt-6.1-sol');
  await thinking.getByRole('radio', { name: 'Maximum', checked: true, exact: true }).waitFor();
  await thinking.getByRole('radio', { name: 'High', exact: true }).click();
  await thinking.getByRole('radio', { name: 'High', checked: true, exact: true }).waitFor();
  await thinking.getByRole('radio', { name: 'High', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await thinking.getByRole('radio', { name: 'Extra high', checked: true, exact: true }).waitFor();
  await thinking.getByRole('radio', { name: 'High', exact: true }).click();
  await captureSettings('settings-actions-key-windows-light.png', false);
  const changeKey = page.getByRole('button', { name: 'Change key', exact: true });
  await changeKey.click();
  const newKey = page.getByRole('textbox', { name: 'New API key', exact: true });
  assert.equal(await newKey.evaluate(element => element === document.activeElement), true);
  await newKey.fill('sk-abandoned-fixture'); await newKey.press('Escape');
  assert.equal(await newKey.count(), 0); assert.equal(await changeKey.evaluate(element => element === document.activeElement), true);
  await changeKey.click(); await newKey.fill('sk-cancelled-STOP');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await newKey.count(), 0);
  assert.equal(await page.evaluate(() => window.modelQA.keySaveAttempts), 1);
  await changeKey.click(); await newKey.fill('sk-replacement-fixture');
  await page.evaluate(() => { window.modelQA.failKeySave = true; });
  await newKey.press('Enter');
  await page.getByRole('alert').getByText('Could not save this key.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').getByRole('button', { name: 'Retry', exact: true }).isVisible(), true);
  assert.equal(await newKey.inputValue(), 'sk-replacement-fixture');
  assert.equal(await page.evaluate(() => window.desktop.state().then(state => state.apiKeyHint)), 'sk-••••••••only');
  await captureSettings('analysis-key-error-windows-light.png', false);
  await page.evaluate(() => { window.modelQA.failKeySave = false; });
  await newKey.press('Enter');
  await changeKey.waitFor(); await page.waitForFunction(() => document.activeElement?.textContent.includes('Change key'));
  assert.equal(await page.getByLabel('Saved API key', { exact: true }).innerText(), 'sk-••••••••ture');
  await page.setViewportSize({ width: 790, height: 850 });
  await page.evaluate(() => { document.documentElement.dataset.platform = 'darwin'; document.documentElement.dataset.theme = 'dark'; });
  await captureSettings('analysis-key-saved-mac-dark-narrow.png', false);
  await changeKey.click(); await captureSettings('analysis-key-change-mac-dark-narrow.png', false);
  await newKey.fill('sk-cancelled-STOP');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.getByLabel('Saved API key', { exact: true }).innerText(), 'sk-••••••••ture');
  await changeKey.click(); await newKey.fill('sk-autosave-ENDS');
  await newKey.press('Tab');
  assert.equal(await page.getByRole('button', { name: 'Cancel', exact: true }).evaluate(element => element === document.activeElement), true);
  assert.equal(await page.evaluate(() => window.modelQA.keySaveAttempts), 3);
  await page.keyboard.press('Tab');
  await page.getByLabel('Saved API key', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Saved API key', { exact: true }).innerText(), 'sk-••••••••ENDS');
  assert.equal(await page.evaluate(() => window.modelQA.keySaveAttempts), 4);
  assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).count(), 0);
  await page.setViewportSize({ width: 1550, height: 850 });
  await page.evaluate(() => { document.documentElement.dataset.platform = 'win32'; document.documentElement.dataset.theme = 'light'; });
  await page.getByRole('button', { name: 'Remove key', exact: true }).click();
  await page.getByRole('button', { name: 'Remove key', exact: true }).waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('textbox', { name: 'API key', exact: true }).evaluate(element => element === document.activeElement), true);
  await provider.selectOption('anthropic');
  await page.getByRole('textbox', { name: 'API key', exact: true }).fill('sk-ant-fixture-only');
  await page.getByRole('textbox', { name: 'API key', exact: true }).press('Tab');
  await page.getByRole('button', { name: 'Remove key', exact: true }).waitFor();
  await assertSettingsActions();
  await analysisModel.selectOption('claude-haiku-4-5-20251001');
  const binaryThinking = page.getByRole('switch', { name: 'Extended thinking', exact: true });
  await binaryThinking.waitFor();
  assert.equal(await thinking.count(), 0);
  await binaryThinking.click(); await analysisModel.selectOption('claude-sonnet-5-5');
  await thinking.getByRole('radio', { name: 'High', exact: true }).waitFor();
  assert.equal(await thinking.getByRole('radio').count(), 5);
  await captureSettings('analysis-anthropic-windows-light.png', false);
  await page.getByRole('button', { name: 'Remove key', exact: true }).click();
  await page.getByRole('button', { name: 'Remove key', exact: true }).waitFor({ state: 'detached' });
  await provider.selectOption("ollama");
  assert.equal(await page.getByRole("textbox", { name: "Server URL", exact: true }).inputValue(), "http://localhost:11434");
  assert.equal(await page.getByRole("combobox", { name: "Model", exact: true }).inputValue(), "qwen3.8:27b");
  await provider.selectOption("builtin");
  await page.getByText("Installed", { exact: true }).waitFor();
  assert.equal(await page.getByText("Installed", { exact: true }).count(), 1);
  await captureSettings("settings-windows-ready.png");
  await nav.getByRole("button", { name: "Plan", exact: true }).click();
  await page.getByText("Compact mode uses basic keyword coverage and limited overview suggestions.").waitFor();
  await nav.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("radio", { name: "Dark", exact: true }).check();
  await captureSettings("settings-windows-dark.png");
  await localModel.selectOption("qwen3-4b");
  await page.evaluate(() => window.modelQA.update("qwen3-4b", { status: "ready", downloadedBytes: 2497280256 }));
  await page.locator('.local-model-library > summary').click();
  await page.getByRole("button", { name: "Remove SmolLM2 360M", exact: true }).waitFor();
  await page.setViewportSize({ width: 790, height: 850 });
  await captureSettings("settings-windows-compact.png");
  await assertSettingsActions();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.evaluate(() => { window.modelQA.confirmDelete = true; });
  await page.getByRole("button", { name: "Remove SmolLM2 360M", exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Remove SmolLM2 360M', exact: true }).count(), 0);
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.evaluate(() => { window.modelQA.setPlatform("darwin"); });
  await page.getByRole("radio", { name: "Light", exact: true }).check();
  if (process.env.ZEBBY_CAPTURE_DOCS) await captureSettings("readme-settings.png", false);
  await page.getByText("Storage and privacy", { exact: true }).click();
  await page.getByText("Delete models here before removing Zebby from your Mac.", { exact: false }).waitFor();
  assert.equal(await page.getByRole("button", { name: /uninstall/i }).count(), 0);
  await captureSettings("settings-mac-ready.png");
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
  await page.getByRole("button", { name: "Expand navigation", exact: true }).waitFor();
  await captureSettings("settings-mac-collapsed-light.png");
  assert.equal(await page.getByRole("button", { name: "Database settings", exact: true }).count(), 0);
  assert.equal(await page.locator(".sidebar-database").count(), 0);
  assert.equal(await nav.getByRole("button", { name: "Settings", exact: true }).getAttribute("aria-current"), "page");
  await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).waitFor();
  await page.setViewportSize({ width: 790, height: 850 });
  await page.getByRole("radio", { name: "Dark", exact: true }).check();
  await captureSettings("settings-mac-compact-dark.png");
  await assertSettingsActions();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  // The newly added models require explicit agreement before download.
  for (const id of ["lfm25-350m", "gemma3-270m"]) {
    await page.evaluate((platform) => window.modelQA.setPlatform(platform), id === "lfm25-350m" ? "win32" : "darwin");
    await page.setViewportSize(id === "lfm25-350m" ? { width: 1440, height: 960 } : { width: 790, height: 850 });
    await page.getByRole("radio", { name: id === "lfm25-350m" ? "Light" : "Dark", exact: true }).check();
    await localModel.selectOption(id);
    await page.getByText("Review model terms to continue", { exact: true }).waitFor();
    assert.equal(await page.getByRole("progressbar").count(), 0);
    assert.equal(await page.getByRole("link", { name: "Model terms", exact: true }).getAttribute("target"), "_blank");
    if (id === "gemma3-270m") {
      assert.equal(await page.getByRole("link", { name: "Use restrictions", exact: true }).getAttribute("href"),
        "https://ai.google.dev/gemma/prohibited_use_policy");
    }
    await captureSettings(`settings-${id}-terms.png`);
    await page.getByRole("button", { name: "Agree and download", exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Downloading' }).waitFor();
    await page.evaluate(({ id, bytes }) => window.modelQA.update(id, { status: "ready", downloadedBytes: bytes }),
      { id, bytes: LOCAL_MODELS.find((model) => model.id === id).bytes });
    await page.getByText("Installed", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Agree and download", exact: true }).count(), 0);
    await nav.getByRole("button", { name: "Plan", exact: true }).click();
    assert.equal(await page.locator(".plan-analyze-actions small").innerText(), LOCAL_MODELS.find((model) => model.id === id).name);
    assert.equal(await page.getByText("Compact mode uses basic keyword coverage and limited overview suggestions.").count(), 0);
    await nav.getByRole("button", { name: "Settings", exact: true }).click();
    await captureSettings(`settings-${id}-ready.png`);
  }
  await page.setViewportSize({ width: 1550, height: 850 });
  await page.evaluate(() => window.modelQA.setPlatform("darwin"));
  await provider.selectOption("ollama");
  await page.getByRole("radio", { name: "Light", exact: true }).check();
  await nav.getByRole("button", { name: "Plan", exact: true }).click();
  await page.getByRole("textbox", { name: "Core ATS keyword 1", exact: true }).waitFor();
  await captureSettings("plan-mac-light.png");
  await page.getByRole("button", { name: "Copy theme 1", exact: true }).click();
  assert.equal(await page.evaluate(() => window.controlsQA.copied), await page.getByRole("textbox", { name: "Core resume theme 1", exact: true }).inputValue());
  await page.locator(".analysis-section").evaluate((element) => {
    const scroll = element.closest(".plan-document-scroll");
    scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 24;
  });
  await captureSettings("plan-mac-item-copy-light.png", false);
  await nav.getByRole("button", { name: "Applications", exact: true }).click();
  const macRow = page.locator(".application-row").first(), macSelector = macRow.locator(".application-row-select");
  await pane.getByRole("button", { name: "Close details", exact: true }).click();
  assert.equal(await macSelector.evaluate((element) => element === document.activeElement), true);
  await captureSettings("applications-mac-pane-closed.png", false);
  const macBox = await macRow.boundingBox();
  await macRow.click({ position: { x: macBox.width / 2, y: macBox.height - 8 } });
  await pane.waitFor();
  await captureSettings("applications-mac-pane-open.png", false);
  await assertApplicationMetrics();
  await nav.getByRole("button", { name: "Plan", exact: true }).click();
  await page.setViewportSize({ width: 790, height: 850 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await captureSettings("plan-mac-compact-dark.png");
  await page.locator(".analysis-section").evaluate((element) => {
    const scroll = element.closest(".plan-document-scroll");
    scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 24;
  });
  await captureSettings("plan-mac-item-copy-compact-dark.png", false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.evaluate(() => { window.modelQA.rejectSidebarSave = true; });
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Could not save the navigation preference. Try again." }).waitFor();
  assert.equal(await page.locator(".desktop-shell").evaluate((element) => element.classList.contains("sidebar-collapsed")), false);
  await page.evaluate(() => { window.modelQA.rejectSidebarSave = false; });
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
  await page.getByRole("button", { name: "Expand navigation", exact: true }).waitFor();
  assert.equal(await page.getByRole("alert").filter({ hasText: "Could not save the navigation preference. Try again." }).count(), 0);
  await captureSettings("plan-mac-collapsed-dark.png");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.locator('.brand-mark').evaluate(element => element.getBoundingClientRect().top), 69);
  const macInsets = await page.locator(".desktop-sidebar").evaluate((element) => {
    const icon = element.querySelector(".brand-mark").getBoundingClientRect(), box = element.getBoundingClientRect();
    return { top: icon.top - box.top, left: icon.left - box.left };
  });
  assert.deepEqual(macInsets, { top: 25, left: 25 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
  await assertLocationKeyboard(page.locator(".location-editor"), "Mac Plan");
  await page.getByRole("button", { name: "Save plan", exact: true }).click();
  await page.locator(".workspace-save-feedback").getByText("Saved", { exact: true }).waitFor();
  // All payment and guest-wallet traffic below uses the synthetic desktop bridge.
  // These checks send no email, open no checkout, and request no provider inference.
  await nav.getByRole("button", { name: "Settings", exact: true }).click();
  await page.setViewportSize({ width: 1550, height: 850 });
  await page.evaluate(() => { window.modelQA.setPlatform("win32"); document.documentElement.dataset.platform = "win32"; document.documentElement.dataset.theme = "light"; });
  const emptyCredits = page.getByRole("region", { name: "Credits", exact: true });
  const settingsPage = page.locator(".settings-page");
  // Rapid changes settle on the last destination without an inert workspace.
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('.sidebar-nav button')];
    for (const name of ["Plan", "Applications", "Plan", "Settings"]) buttons.find(button => button.textContent.trim() === name).click();
  });
  await settingsPage.waitFor();
  await page.waitForFunction(() => !document.querySelector('.desktop-workspace')?.inert);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await nav.getByRole("button", { name: "Applications", exact: true }).click();
  await nav.getByRole("button", { name: "Settings", exact: true }).click();
  await settingsPage.waitFor();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const guideLink = settingsPage.getByRole("button", { name: "Need help deciding?", exact: true });
  await page.mouse.move(0, 0);
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".analysis-guide-link")).color === "rgb(166, 74, 52)");
  await guideLink.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".analysis-guide-link")).color === "rgb(142, 61, 42)");
  await guideLink.click();
  const analysisGuide = page.getByRole("dialog", { name: "Need help deciding?", exact: true });
  await analysisGuide.waitFor();
  assert.equal(await analysisGuide.locator("dt").count(), 4);
  assert.ok((await analysisGuide.boundingBox()).width <= 680);
  assert.equal(await analysisGuide.locator(".analysis-guide-options > div").evaluateAll(rows => rows.every(row =>
    row.querySelector("dt").getBoundingClientRect().right < row.querySelector("dd").getBoundingClientRect().left &&
    getComputedStyle(row).borderTopWidth === "0px")), true);
  await captureSettings("analysis-guide-windows-light.png", false);
  await page.keyboard.press("Escape"); await analysisGuide.waitFor({ state: "hidden" });
  assert.equal(await guideLink.evaluate(element => element === document.activeElement), true);
  await page.getByRole("combobox", { name: "Analyze with", exact: true }).selectOption("builtin");
  const beforeHardware = await page.evaluate(() => window.modelQA.selections.length);
  for (const backend of ["vulkan", "metal", "cpu"]) {
    await page.evaluate((backend) => window.modelQA.setCompute({ status: "ready", backend,
      devices: backend === "cpu" ? [] : [{ id: backend === "metal" ? "Metal" : "Vulkan0", name: backend === "metal" ? "Apple M3" : "NVIDIA RTX", memory: 16e9, freeMemory: 12e9 }],
      availableMemory: 16e9, recommendedModelIds: backend === "cpu" ? ["qwen3-06b", "lfm25-350m"] : ["qwen3-8b", "qwen3-4b"] }), backend);
    const picker = page.getByRole("combobox", { name: "Local model", exact: true });
    await picker.locator(`optgroup[label="Recommended for your ${backend === "cpu" ? "CPU" : "GPU"}"]`).waitFor({ state: "attached" });
    assert.equal(await picker.locator("option[value]:not([value=''])").count(), LOCAL_MODELS.length);
    assert.match(await page.locator(".model-compute-hint").innerText(), backend === "cpu" ? /^CPU$/ : backend === "metal" ? /Apple M3.*Metal/ : /NVIDIA RTX.*Vulkan/);
    if (backend === "vulkan") await captureSettings("analysis-hardware-windows-light.png", false);
  }
  assert.equal(await page.evaluate(() => window.modelQA.selections.length), beforeHardware, "Hardware detection must not select or download a model");
  for (const method of ["ollama", "builtin", "openai", "anthropic"]) {
    await page.getByRole("combobox", { name: "Analyze with", exact: true }).selectOption(method);
    assert.equal(await settingsPage.getByRole("button", { name: "Buy credits", exact: true }).count(), 1);
  }
  await page.getByRole("combobox", { name: "Analyze with", exact: true }).selectOption("credits");
  assert.equal(await settingsPage.getByRole("button", { name: "Buy credits", exact: true }).count(), 2);
  assert.equal(await emptyCredits.getByRole("button", { name: "Buy credits", exact: true }).isEnabled(), true);
  assert.equal(await emptyCredits.getByRole("button", { name: "Buy credits", exact: true }).count(), 1);
  assert.equal(await emptyCredits.getByRole("combobox").count(), 0);
  assert.doesNotMatch(await settingsPage.innerText(), /Paid credits are not|not connected yet/);
  await settingsPage.evaluate(element => { element.scrollTop = 0; });
  await assertSettingsActions();
  await captureSettings("credits-empty-windows-light.png", false);
  await page.setViewportSize({ width: 790, height: 850 });
  await page.evaluate(() => { window.modelQA.setPlatform("darwin"); document.documentElement.dataset.platform = "darwin"; document.documentElement.dataset.theme = "dark"; });
  await captureSettings("credits-empty-mac-dark-narrow.png", false);
  assert.equal(await emptyCredits.getByRole("button", { name: "Restore credits", exact: true }).count(), 0);
  assert.equal(await emptyCredits.getByRole("button", { name: "Connect this computer", exact: true }).count(), 0);
  await emptyCredits.getByRole("button", { name: "Manage credits", exact: true }).click();
  const creditHelp = page.locator(".credit-help-dialog");
  await creditHelp.getByRole("heading", { name: "Manage credits", exact: true }).waitFor();
  assert.match(await creditHelp.innerText(), /saved recovery code/);
  assert.equal(await creditHelp.locator("details").count(), 0);
  assert.ok((await creditHelp.boundingBox()).width > 480);
  await captureSettings("credits-help-empty-mac-dark-narrow.png", false);
  await page.keyboard.press("Escape");
  await creditHelp.waitFor({ state: "hidden" });
  assert.equal(await emptyCredits.getByRole("button", { name: "Manage credits", exact: true }).evaluate(element => element === document.activeElement), true);
  // A cold or unavailable host must not hold up choosing a pack or cancelling.
  await page.evaluate(() => { window.creditQA.warmupMode = "pending"; });
  await emptyCredits.getByRole("button", { name: "Buy credits", exact: true }).click();
  const pricingDialog = page.getByRole("dialog", { name: "A little fuel for your next move", exact: true });
  await pricingDialog.getByRole("radio", { name: /\$5\b/ }).waitFor();
  assert.equal(await page.evaluate(() => window.creditQA.warmups), 1);
  assert.equal(await page.evaluate(() => window.creditQA.checkouts.length), 0);
  assert.equal(await pricingDialog.getByRole("button", { name: "Continue to checkout · $5", exact: true }).isEnabled(), true);
  await pricingDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await pricingDialog.waitFor({ state: "hidden" });
  await page.evaluate(() => { window.creditQA.finishWarmup(); window.creditQA.finishWarmup = null; window.creditQA.warmupMode = "error"; });
  await emptyCredits.getByRole("button", { name: "Buy credits", exact: true }).click();
  await pricingDialog.getByRole("radio", { name: /\$5\b/ }).waitFor();
  assert.equal(await pricingDialog.getByRole("alert").count(), 0);
  assert.equal(await pricingDialog.getByRole("button", { name: "Continue to checkout · $5", exact: true }).isEnabled(), true);
  await pricingDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await pricingDialog.waitFor({ state: "hidden" });
  await page.evaluate(() => { window.creditQA.warmupMode = "ready"; });
  await page.getByRole("combobox", { name: "Analyze with", exact: true }).selectOption("openai");
  await nav.getByRole("button", { name: "Plan", exact: true }).click();
  const analyze = page.getByRole("button", { name: "Analyze", exact: true });
  const analysisDialog = page.getByRole("dialog");
  await analyze.click();
  await analysisDialog.getByRole("heading", { name: "Choose how to analyze", exact: true }).waitFor();
  assert.equal(await analysisDialog.getByRole("radio").count(), 5);
  // Setup must not analyze with an old key while its replacement is unsaved or failed.
  await analysisDialog.getByRole("radio", { name: /^OpenAI API key/ }).check();
  await analysisDialog.getByRole("button", { name: "Continue", exact: true }).click();
  const setupContinue = analysisDialog.getByRole("button", { name: "Continue to analysis", exact: true });
  const setupKey = analysisDialog.getByRole("textbox", { name: "API key", exact: true });
  await setupKey.fill("sk-setup-fixture-only"); await setupKey.press("Enter");
  await analysisDialog.getByRole("button", { name: "Change key", exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('dialog[open] button, [role="dialog"] button')]
    .some(element => element.textContent.trim() === "Continue to analysis" && !element.disabled));
  assert.equal(await setupContinue.isEnabled(), true);
  await analysisDialog.getByRole("button", { name: "Change key", exact: true }).click();
  const setupReplacement = analysisDialog.getByRole("textbox", { name: "New API key", exact: true });
  await setupReplacement.fill("sk-unsaved-replacement");
  await page.waitForFunction(() => [...document.querySelectorAll('dialog[open] button, [role="dialog"] button')]
    .some(element => element.textContent.trim() === "Continue to analysis" && element.disabled));
  assert.equal(await setupContinue.isEnabled(), false);
  await page.evaluate(() => { window.modelQA.failKeySave = true; });
  await setupReplacement.press("Enter");
  await analysisDialog.getByRole("alert").getByText("Could not save this key.", { exact: true }).waitFor();
  assert.equal(await setupContinue.isEnabled(), false);
  await analysisDialog.locator(".api-key-editor").getByRole("button", { name: "Cancel", exact: true }).click();
  await analysisDialog.getByRole("button", { name: "Change key", exact: true }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('dialog[open] button, [role="dialog"] button')]
    .some(element => element.textContent.trim() === "Continue to analysis" && !element.disabled));
  assert.equal(await setupContinue.isEnabled(), true);
  await page.evaluate(() => { window.modelQA.failKeySave = false; });
  await analysisDialog.getByRole("button", { name: "Remove key", exact: true }).click();
  await setupKey.waitFor();
  await analysisDialog.getByRole("button", { name: "Close", exact: true }).click();
  await analysisDialog.waitFor({ state: "hidden" }); await analyze.click();
  await analysisDialog.getByRole("heading", { name: "Choose how to analyze", exact: true }).waitFor();
  for (const name of ["Local server", "Download a model", "OpenAI API key", "Anthropic API key", "Buy Zebby credits"]) {
    assert.equal(await analysisDialog.getByRole("radio", { name: new RegExp(name) }).count(), 1);
  }
  await page.setViewportSize({ width: 1550, height: 850 });
  await page.evaluate(() => { window.modelQA.setPlatform("win32"); document.documentElement.dataset.platform = "win32";
    document.documentElement.dataset.theme = "light"; });
  await captureSettings("credits-choice-windows-light.png", false);
  await analysisDialog.getByRole("radio", { name: /^Local server/ }).check();
  const warmupsBeforeChoice = await page.evaluate(() => window.creditQA.warmups);
  await analysisDialog.getByRole("radio", { name: /Buy Zebby credits/ }).check();
  assert.equal(await page.evaluate(() => window.creditQA.warmups), warmupsBeforeChoice + 1);
  assert.equal(await page.evaluate(() => window.creditQA.checkouts.length), 0);
  await analysisDialog.getByRole("button", { name: "Continue", exact: true }).click();
  assert.equal(await analysisDialog.getByRole("radio").count(), 4);
  assert.equal(await analysisDialog.getByRole("combobox").count(), 0);
  assert.equal(await analysisDialog.getByText("Unlocks Astra and Opus", { exact: true }).count(), 3);
  assert.match(await analysisDialog.locator(".credit-pack").nth(1).innerText(), /~22 analyses\s+Astra or Opus \(Medium\)/);
  assert.deepEqual(await analysisDialog.locator(".credit-pack").nth(1).locator(".credit-estimate-model").allTextContents(), ["Astra or Opus (Medium)", "GPT-6.1 Sol (High)", "GPT-6 Luna (High)"]);
  assert.deepEqual(await analysisDialog.locator(".credit-pack").first().locator(".credit-estimate-model").allTextContents(), ["GPT-6.1 Sol (High)", "GPT-6 Luna (High)"]);
  assert.match(await analysisDialog.innerText(), /Choose or change your model in Settings after purchase/);
  assert.equal(await analysisDialog.getByRole("button", { name: "Continue to checkout · $5", exact: true }).isEnabled(), true);
  assert.doesNotMatch(await analysisDialog.innerText(), /Paid credits are not|not connected yet/);
  await assertFullTextRows(analysisDialog.locator(".analysis-intro, .analysis-dialog-body > p.settings-help"));
  await captureSettings("credits-packs-windows-light.png", false);
  await page.setViewportSize({ width: 951, height: 850 });
  await assertFullTextRows(analysisDialog.locator(".analysis-intro, .analysis-dialog-body > p.settings-help"));
  await captureSettings("credits-packs-row-951-light.png", false);
  await page.setViewportSize({ width: 790, height: 850 });
  await page.evaluate(() => { window.modelQA.setPlatform("darwin"); document.documentElement.dataset.platform = "darwin";
    document.documentElement.dataset.theme = "dark"; });
  assert.equal(await analysisDialog.evaluate(element => element.scrollWidth > element.clientWidth), false);
  await assertFullTextRows(analysisDialog.locator(".analysis-intro, .analysis-dialog-body > p.settings-help"));
  await captureSettings("credits-packs-mac-dark-narrow.png", false);
  await analysisDialog.getByRole("button", { name: "Continue to checkout · $5", exact: true }).click();
  await analysisDialog.getByRole("alert").filter({ hasText: "Could not reach the credits service. Try again." }).waitFor();
  await analysisDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await analysisDialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.matches('.analysis-button'));
  assert.equal(await analyze.evaluate(element => element === document.activeElement), true);
  assert.equal(await page.evaluate(() => window.creditQA.checkouts.length), 0);
  await page.evaluate(() => window.creditQA.update({ available: true }));
  await analyze.click();
  await analysisDialog.getByRole("radio", { name: /Buy Zebby credits/ }).check();
  await analysisDialog.getByRole("button", { name: "Continue", exact: true }).click();
  await analysisDialog.getByRole("radio", { name: /\$5\b/ }).check();
  await analysisDialog.getByRole("button", { name: "Continue to checkout · $5", exact: true }).click();
  await analysisDialog.getByText("Test checkout. No real payment is taken.", { exact: true }).waitFor();
  assert.equal(await analysisDialog.getByRole("textbox").count(), 0);
  assert.equal(await analysisDialog.getByRole("combobox").count(), 0);
  await page.evaluate(() => { window.creditQA.payment = "paid"; });
  await analysisDialog.getByRole("button", { name: "Check payment", exact: true }).click();
  await analysisDialog.getByRole("heading", { name: "Your credits are ready", exact: true }).waitFor();
  await captureSettings("credits-ready-mac-dark-narrow.png", false);
  await page.setViewportSize({ width: 1550, height: 850 });
  await page.evaluate(() => { window.modelQA.setPlatform("win32"); document.documentElement.dataset.platform = "win32"; document.documentElement.dataset.theme = "light"; });
  await captureSettings("credits-ready-windows-light.png", false);
  await page.setViewportSize({ width: 790, height: 850 });
  await page.evaluate(() => { window.modelQA.setPlatform("darwin"); document.documentElement.dataset.platform = "darwin"; document.documentElement.dataset.theme = "dark"; });
  await page.evaluate(() => { window.creditQA.cancelRecovery = true; });
  await analysisDialog.getByRole("button", { name: "Save recovery code", exact: true }).click();
  assert.equal(await analysisDialog.getByRole("button", { name: "Save recovery code", exact: true }).isVisible(), true);
  await page.evaluate(() => { window.creditQA.cancelRecovery = false; });
  await analysisDialog.getByRole("button", { name: "Save recovery code", exact: true }).click();
  await analysisDialog.getByText("Recovery code saved.", { exact: true }).waitFor();
  await analysisDialog.getByRole("button", { name: "Change in Settings", exact: true }).click();
  await analysisDialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => {
    const heading = document.getElementById("ai-settings");
    return heading && heading.getBoundingClientRect().top >= 44 && heading.getBoundingClientRect().top < 120;
  });
  await nav.getByRole("button", { name: "Plan", exact: true }).click();
  await analyze.click();
  await page.waitForFunction(() => window.creditQA.quoteRequests.length > 0);
  const paidPlanSource = await page.evaluate(() => window.creditQA.quoteRequests.at(-1).source);
  const paidPlanPath = `/api/plans/${paidPlanSource.id}/analyze`;
  await waitForAnalysis(paidPlanPath);
  assert.equal(await analysisDialog.count(), 0);
  assert.equal(paidAnalysisRequests.at(-1).quoteId, "quote-fixture");
  // Plan and match can both prepare funded requests without a global modal lock.
  await nav.getByRole("button", { name: "Applications", exact: true }).click();
  await table.getByRole("button", { name: "Refresh match for Senior Product Manager at Expedia Group", exact: true }).click();
  await waitForAnalysis("/api/applications/app-1/analyze");
  assert.equal(await analysisDialog.count(), 0);
  assert.equal(pending.has(paidPlanPath), true);
  await completeAnalysis("/api/applications/app-1/analyze");
  await completeAnalysis(paidPlanPath);
  await nav.getByRole("button", { name: "Plan", exact: true }).click();
  await analyze.waitFor();
  // Credit checks fail inline and can retry. Cancel also works during a cold start.
  await page.evaluate(() => { window.creditQA.quoteMode = "error"; });
  await analyze.click();
  await page.getByRole("alert").filter({ hasText: "Could not reach the credits service. Try again." }).waitFor();
  assert.equal(await analysisDialog.count(), 0);
  const paidCallsBeforeCancel = paidAnalysisRequests.length;
  await page.evaluate(() => { window.creditQA.quoteMode = "pending"; });
  await analyze.click(); await page.waitForFunction(() => window.creditQA.finishQuote !== null);
  await page.locator(".plan-analyze-actions").getByRole("button", { name: "Cancel", exact: true }).click();
  await analyze.waitFor();
  await page.evaluate(() => { window.creditQA.finishQuote(); window.creditQA.finishQuote = null; window.creditQA.quoteMode = "ready"; });
  // Funds reserved elsewhere cannot be reused. This opens packs, never an analysis review.
  await page.evaluate(() => window.creditQA.update({ wallet: { balance: 500000000, reserved: 490000000, used: 0, purchased: 500000000, recent: [] } }));
  await analyze.click();
  await analysisDialog.getByRole("heading", { name: "A little fuel for your next move", exact: true }).waitFor();
  assert.equal(paidAnalysisRequests.length, paidCallsBeforeCancel);
  await analysisDialog.getByRole("alert").filter({ hasText: "needs 20 credits available to start. You have 10." }).waitFor();
  await captureSettings("credits-counted-budget-error.png", false);
  await analysisDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  // A paid result can be recovered for free even with no balance. An unfinished
  // prior run reports inline and cannot accidentally create a second charge.
  await page.evaluate(() => {
    window.creditQA.update({ wallet: { balance: 0, reserved: 0, used: 500000000, purchased: 500000000, recent: [] } });
    window.creditQA.quote = { id: "recovery-fixture", model: "gpt-6.1-sol", maximum: 0, recovery: true, pending: true,
      expiresAt: new Date(Date.now() + 300000).toISOString() };
  });
  await analyze.click();
  await page.getByRole("alert").filter({ hasText: "Your previous analysis is still running. Try again shortly." }).waitFor();
  assert.equal(await analysisDialog.count(), 0); assert.equal(paidAnalysisRequests.length, paidCallsBeforeCancel);
  await page.evaluate(() => { window.creditQA.quote.pending = false; });
  await analyze.click(); await waitForAnalysis(paidPlanPath);
  assert.equal(paidAnalysisRequests.at(-1).quoteId, "recovery-fixture"); assert.equal(await analysisDialog.count(), 0);
  await completeAnalysis(paidPlanPath); await analyze.waitFor();
  await page.evaluate(() => {
    window.creditQA.quote = null;
    window.creditQA.update({ wallet: { balance: 500000000, reserved: 0, used: 0, purchased: 500000000, recent: [] } });
  });
  const sidebarWallet = page.locator(".sidebar-credit-button");
  await sidebarWallet.click();
  await analysisDialog.getByRole("heading", { name: "A little fuel for your next move", exact: true }).waitFor();
  await analysisDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await nav.getByRole("button", { name: "Settings", exact: true }).click();
  const creditsSettings = page.getByRole("region", { name: "Credits", exact: true });
  const paidSettingsModel = settingsPage.getByRole("combobox", { name: "Model", exact: true });
  await paidSettingsModel.waitFor();
  assert.deepEqual(await paidSettingsModel.locator("option").evaluateAll(options => options.map(option => option.value)), ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
  await page.evaluate(() => window.creditQA.update({ wallet: { balance: 450000000, reserved: 0, used: 50000000, purchased: 500000000, recent: [], astraUnlocked: false } }));
  await settingsPage.getByText("GPT-6 Astra and Claude Opus are included with a $20, $50 or $100 pack.", { exact: true }).waitFor();
  assert.equal(await paidSettingsModel.locator('option[value="gpt-6-astra"]').innerText(), "GPT-6 Astra · Locked");
  await captureSettings("credits-astra-locked.png", false);
  const savedModel = await paidSettingsModel.inputValue();
  assert.equal(await paidSettingsModel.locator('option[value="claude-opus-5-5"]').innerText(), "Claude Opus 5.5 · Locked");
  await paidSettingsModel.focus();
  await paidSettingsModel.selectOption("claude-opus-5-5");
  await analysisDialog.getByRole("button", { name: "Continue to checkout · $20", exact: true }).waitFor();
  assert.equal(await paidSettingsModel.inputValue(), savedModel);
  await analysisDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await analysisDialog.waitFor({ state: "hidden" });
  await paidSettingsModel.focus();
  await page.waitForFunction(() => document.activeElement?.tagName === "SELECT");
  await paidSettingsModel.selectOption("gpt-6-astra");
  await analysisDialog.getByRole("button", { name: "Continue to checkout · $20", exact: true }).waitFor();
  assert.equal(await paidSettingsModel.inputValue(), savedModel);
  await analysisDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await analysisDialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.tagName === "SELECT");
  await page.evaluate(() => window.creditQA.update({ model: "gpt-6-astra" }));
  await page.waitForFunction(() => document.querySelector('select:has(option[value="locked-premium"])')?.value === "locked-premium");
  await captureSettings("credits-astra-current-locked.png", false);
  await paidSettingsModel.selectOption("gpt-6-astra");
  await analysisDialog.getByRole("button", { name: "Continue to checkout · $20", exact: true }).waitFor();
  await analysisDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await analysisDialog.waitFor({ state: "hidden" });
  await page.evaluate(() => window.creditQA.update({ wallet: { balance: 3000000000, reserved: 0, used: 0, purchased: 3000000000, recent: [], astraUnlocked: true } }));
  await page.waitForFunction(() => [...document.querySelectorAll("option")].some(option => option.value === "gpt-6-astra" && option.textContent === "GPT-6 Astra"));
  await paidSettingsModel.selectOption("claude-opus-5-5");
  await page.waitForFunction(() => document.querySelector('select:has(option[value="claude-opus-5-5"])')?.value === "claude-opus-5-5");
  await settingsPage.getByRole("radiogroup", { name: "Thinking level", exact: true }).getByRole("radio", { name: "Medium", exact: true }).waitFor();
  await paidSettingsModel.selectOption("gpt-6-luna");
  await settingsPage.getByRole("radiogroup", { name: "Thinking level", exact: true }).getByRole("radio", { name: "Off", exact: true }).click();
  await paidSettingsModel.selectOption("gpt-6-astra");
  await settingsPage.getByRole("radiogroup", { name: "Thinking level", exact: true }).getByRole("radio", { name: "High", exact: true }).click();
  await nav.getByRole("button", { name: "Plan", exact: true }).click();
  await analyze.click(); await waitForAnalysis(paidPlanPath);
  assert.deepEqual(await page.evaluate(() => ({ model: window.creditQA.quoteRequests.at(-1).model,
    thinking: window.creditQA.quoteRequests.at(-1).thinking })), { model: "gpt-6-astra", thinking: "high" });
  assert.equal(await analysisDialog.count(), 0);
  await completeAnalysis(paidPlanPath); await analyze.waitFor();
  await nav.getByRole("button", { name: "Settings", exact: true }).click();
  assert.equal(await paidSettingsModel.inputValue(), "gpt-6-astra");
  assert.equal(await creditsSettings.getByRole("combobox", { name: "Model", exact: true }).count(), 0);
  assert.equal(await settingsPage.getByRole("button", { name: "Buy credits", exact: true }).count(), 2);
  assert.equal(await creditsSettings.getByRole("button", { name: "Buy credits", exact: true }).count(), 1);
  assert.equal(await creditsSettings.getByRole("button", { name: "Sign out", exact: true }).count(), 0);
  await creditsSettings.getByRole("button", { name: "Manage credits", exact: true }).click();
  await creditsSettings.getByRole("button", { name: "Connect another computer", exact: true }).click();
  await creditsSettings.getByLabel("Pairing code", { exact: true }).waitFor();
  await creditsSettings.getByRole("button", { name: "Copy code", exact: true }).click();
  assert.equal(await page.evaluate(() => window.controlsQA.copied), "ABCD-2345");
  await assertSettingsActions();
  await captureSettings("credits-wallet-pairing-mac-dark-narrow.png", false);
  assert.equal(await creditsSettings.evaluate(element => element.scrollWidth > element.clientWidth), false);
  await creditsSettings.getByRole("button", { name: "Cancel pairing", exact: true }).click();
  assert.equal(await page.evaluate(() => window.creditQA.pairingCancelled), 1);
  assert.equal(await creditsSettings.getByRole("button", { name: "Connect this computer", exact: true }).isEnabled(), true);
  await creditsSettings.getByRole("button", { name: "Connect this computer", exact: true }).click();
  const pairInput = creditsSettings.getByLabel("Pairing code", { exact: true });
  assert.equal(await pairInput.evaluate(element => element === document.activeElement), true);
  await pairInput.fill("BAD-CODE"); await pairInput.press("Enter");
  await creditsSettings.getByRole("alert").filter({ hasText: "That pairing code was used or expired" }).waitFor();
  assert.equal(await pairInput.inputValue(), "BAD-CODE");
  await pairInput.fill("ABCD-2345"); await pairInput.press("Enter");
  await creditsSettings.getByText("Computer connected.", { exact: true }).waitFor();
  assert.equal(await creditsSettings.getByRole("button", { name: "Connect this computer", exact: true }).evaluate(element => element === document.activeElement), true);
  await creditsSettings.getByRole("heading", { name: "Connected computers", exact: true }).waitFor();
  await creditsSettings.getByText("Mac laptop", { exact: true }).waitFor();
  await creditsSettings.getByRole("button", { name: "Disconnect Mac laptop", exact: true }).click();
  assert.equal(await creditsSettings.getByText("Mac laptop", { exact: true }).isVisible(), true);
  await page.evaluate(() => { window.creditQA.confirmDisconnect = true; });
  await creditsSettings.getByRole("button", { name: "Disconnect Mac laptop", exact: true }).click();
  assert.equal(await creditsSettings.getByText("Mac laptop", { exact: true }).count(), 0);
  await creditsSettings.getByRole("button", { name: "Restore credits", exact: true }).click();
  const recoveryInput = creditsSettings.getByLabel("Recovery code", { exact: true });
  await recoveryInput.fill("synthetic private recovery code"); await recoveryInput.press("Escape");
  assert.equal(await recoveryInput.count(), 0);
  assert.equal(await creditsSettings.getByRole("button", { name: "Restore credits", exact: true }).evaluate(element => element === document.activeElement), true);
  await creditHelp.getByRole("button", { name: "Close credits and devices", exact: true }).click();
  await page.setViewportSize({ width: 1550, height: 850 });
  await page.evaluate(() => { window.modelQA.setPlatform("win32"); document.documentElement.dataset.platform = "win32"; document.documentElement.dataset.theme = "light"; });
  await page.evaluate(() => { window.creditQA.update({ wallet: { astraUnlocked: true, balance: 499000000, reserved: 0, used: 1000000, purchased: 500000000,
    updatedAt: "2026-09-30T20:00:00Z", recent: [] } }); });
  await page.waitForFunction(() => document.querySelector(".sidebar-credit-button")?.getAttribute("aria-label") === "Buy credits. 1 of 500 credits used, 100% remaining.");
  assert.equal(await sidebarWallet.locator(".sidebar-credit-percent").innerText(), "100%");
  assert.equal(await sidebarWallet.locator(".sidebar-credit-track > span").evaluate(element => element.style.width), "99.8%");
  await page.evaluate(() => {
    const recent = [4.8, 1.3, .9, 3.7, 2.1, 4.2, .5, 6.8, .7, 2].map((cost, index) => ({ id: `usage-${index}`,
      model: ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"][index % 3], kind: index % 2 ? "match" : "plan", cost: cost * 1000000,
      createdAt: new Date(Date.parse("2026-09-30T20:00:00Z") - index * 2 * 86400000).toISOString() }));
    const dailyUsage = Array.from({ length: 84 }, (_, index) => ({ date: new Date(Date.parse("2026-09-30T00:00:00Z") - (83 - index) * 86400000).toISOString().slice(0, 10), count: 0, cost: 0 }));
    for (const item of recent) { const day = dailyUsage.find(day => item.createdAt.startsWith(day.date)); day.count++; day.cost += item.cost; }
    [.5, .6, .7, 1, 1.4, 1.8, 2].forEach((cost, index) => { const day = dailyUsage[7 + index * 7]; day.count++; day.cost += cost * 1000000; });
    window.creditQA.update({ wallet: { astraUnlocked: true, balance: 465000000, reserved: 0, used: 35000000, purchased: 500000000, completedAnalyses: 17,
      updatedAt: "2026-09-30T20:00:00Z", recent, dailyUsage } });
  });
  const creditBar = creditsSettings.getByRole("progressbar", { name: "Credits remaining", exact: true });
  await page.waitForFunction(() => document.querySelector('[role="progressbar"][aria-label="Credits remaining"]')?.getAttribute("aria-valuenow") === "93");
  assert.equal(await creditBar.getAttribute("aria-valuenow"), "93");
  assert.match(await creditBar.getAttribute("aria-valuetext"), /465 credits available, 35 used/);
  await page.getByRole("button", { name: "Expand navigation", exact: true }).click();
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).waitFor();
  assert.equal(await sidebarWallet.getAttribute("aria-label"), "Buy credits. 35 of 500 credits used, 93% remaining.");
  assert.equal(await sidebarWallet.locator(".sidebar-credit-amount").isVisible(), true);
  assert.equal(await sidebarWallet.locator(".sidebar-credit-track > span").evaluate(element => element.style.width), "93%");
  await captureSettings("credits-sidebar-expanded-windows-light.png", false);
  await sidebarWallet.click();
  await analysisDialog.getByRole("heading", { name: "A little fuel for your next move", exact: true }).waitFor();
  await analysisDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await analysisDialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.classList.contains("sidebar-credit-button"));
  await page.getByRole("button", { name: "Collapse navigation", exact: true }).click();
  await page.getByRole("button", { name: "Expand navigation", exact: true }).waitFor();
  assert.equal(await sidebarWallet.locator(".sidebar-credit-amount").isVisible(), false);
  assert.equal(await sidebarWallet.locator(".sidebar-credit-percent").innerText(), "93%");
  await settingsPage.evaluate(element => { element.scrollTop = 0; });
  await assertSettingsActions();
  await captureSettings("credits-wallet-settings-windows-light.png", false);
  await page.setViewportSize({ width: 790, height: 850 });
  await page.evaluate(() => { window.modelQA.setPlatform("darwin"); document.documentElement.dataset.platform = "darwin"; document.documentElement.dataset.theme = "dark"; });
  await settingsPage.evaluate(element => { element.scrollTop = 0; });
  await captureSettings("credits-funded-mac-dark-narrow.png", false);
  await captureSettings("credits-sidebar-collapsed-mac-dark.png", false);
  await sidebarWallet.press("Enter");
  await analysisDialog.getByRole("heading", { name: "A little fuel for your next move", exact: true }).waitFor();
  await page.keyboard.press("Escape"); await analysisDialog.waitFor({ state: "hidden" });
  await paidSettingsModel.selectOption("gpt-6.1-sol");
  await paidSettingsModel.selectOption("gpt-6-astra");
  await page.setViewportSize({ width: 1550, height: 850 });
  await page.evaluate(() => { window.modelQA.setPlatform("win32"); document.documentElement.dataset.platform = "win32"; document.documentElement.dataset.theme = "light"; });
  await creditsSettings.getByRole("button", { name: "Manage credits", exact: true }).click();
  await assertSettingsActions();
  assert.equal(await creditHelp.locator("details").count(), 0);
  assert.equal(await creditHelp.getByRole("list", { name: "Credit usage history" }).locator("li").count(), 10);
  assert.equal(await creditHelp.locator(".credit-history-totals dd").allTextContents().then(values => values.join(",")), "17,35");
  const activityDays = creditHelp.locator(".credit-activity-day");
  assert.equal(await activityDays.count(), 84);
  assert.equal(await creditHelp.locator(".credit-history-bar").count(), 0);
  await activityDays.last().click();
  assert.match(await creditHelp.locator(".credit-activity-detail").innerText(), /Sep 30\s+1 analysis · 4.8 credits/);
  await page.keyboard.press("Home");
  assert.equal(await activityDays.first().getAttribute("aria-pressed"), "true");
  await page.keyboard.press("ArrowRight");
  assert.equal(await activityDays.nth(7).getAttribute("aria-pressed"), "true");
  assert.match(await creditHelp.locator(".credit-activity-detail").innerText(), /1 analysis · 0.5 credits/);
  await page.keyboard.press("End");
  assert.equal(await activityDays.last().getAttribute("aria-pressed"), "true");
  const accessBox = await creditHelp.locator(".credit-manager-access").boundingBox(), activityBox = await creditHelp.locator(".credit-manager-activity").boundingBox();
  assert.ok(accessBox.x + accessBox.width < activityBox.x);
  assert.equal(await creditHelp.evaluate(element => element.scrollWidth > element.clientWidth), false);
  await captureSettings("credits-help-windows-light.png", false);
  await page.setViewportSize({ width: 600, height: 800 });
  await page.evaluate(() => { window.modelQA.setPlatform("darwin"); document.documentElement.dataset.platform = "darwin"; document.documentElement.dataset.theme = "dark"; });
  await creditHelp.getByRole("button", { name: "Refresh credits and devices", exact: true }).click();
  await page.locator(".desktop-shell.platform-mac").waitFor();
  assert.equal(await creditHelp.evaluate(element => element.scrollWidth > element.clientWidth), false);
  await captureSettings("credits-manager-mac-dark-narrow.png", false);
  await creditHelp.locator(".credit-history").scrollIntoViewIfNeeded();
  await captureSettings("credits-manager-mac-dark-usage.png", false);
  await page.setViewportSize({ width: 1550, height: 850 });
  await page.evaluate(() => { window.modelQA.setPlatform("win32"); document.documentElement.dataset.platform = "win32"; document.documentElement.dataset.theme = "light"; });
  await creditHelp.getByRole("button", { name: "Refresh credits and devices", exact: true }).click();
  await creditHelp.getByRole("button", { name: "Close credits and devices", exact: true }).click();
  assert.equal(await creditsSettings.evaluate(element => element.scrollWidth > element.clientWidth), false);
  await page.evaluate(() => {
    window.creditQA.resumeMode = "error";
    window.creditQA.update({ signedIn: false, pendingConnection: true, wallet: null, access: null, error: "Connection interrupted. Retry when online." });
  });
  await page.waitForFunction(() => window.creditQA.failedResumes > 0);
  await creditsSettings.getByText("Connection interrupted.", { exact: true }).waitFor();
  assert.equal(await creditsSettings.getByText(/No credits found/).count(), 0);
  await creditsSettings.scrollIntoViewIfNeeded();
  await captureSettings("credits-wallet-pending-windows-light.png", false);
  await page.setViewportSize({ width: 790, height: 850 });
  await page.evaluate(() => { window.modelQA.setPlatform("darwin"); document.documentElement.dataset.platform = "darwin"; document.documentElement.dataset.theme = "dark"; });
  await creditsSettings.scrollIntoViewIfNeeded();
  await captureSettings("credits-wallet-pending-mac-dark-narrow.png", false);
  await creditsSettings.getByRole("button", { name: "Retry connection", exact: true }).click();
  assert.equal(await creditsSettings.getByRole("alert").count(), 0);
  assert.equal(await creditsSettings.getByRole("button", { name: "Retry connection", exact: true }).isEnabled(), true);
  await page.evaluate(() => { window.creditQA.resumeMode = "complete"; });
  await creditsSettings.getByRole("button", { name: "Retry connection", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector(".credit-connection-pending"));
  assert.equal(await creditsSettings.getByRole("alert").count(), 0);
  await paidSettingsModel.waitFor();
  assert.deepEqual(await page.evaluate(() => window.creditQA.checkouts), ["starter"]);
  await page.getByRole("combobox", { name: "Analyze with", exact: true }).selectOption("ollama");
  await sidebarWallet.click();
  await analysisDialog.getByRole("heading", { name: "A little fuel for your next move", exact: true }).waitFor();
  await analysisDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.setViewportSize({ width: 1550, height: 850 });
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  // Updates are available in both navigation modes and Settings, without opening an installer during QA.
  await nav.getByRole("button", { name: "Settings", exact: true }).click();
  const updatesSettings = page.getByRole('region', { name: 'Updates', exact: true });
  await updatesSettings.getByRole('button', { name: 'Check for updates', exact: true }).click();
  await page.getByText('Up to date', { exact: true }).waitFor();
  await page.evaluate(() => window.modelQA.updateState({ available: { version: '2.7.0-beta.10', size: 100, sha256: 'a'.repeat(64),
    installerUrl: 'https://github.com/desigrit/zebby-the-scout-beta/releases/download/v2.7.0-beta.10/Zebby-Beta-2.7.0-beta.10-mac-arm64.dmg',
    releaseUrl: 'https://github.com/desigrit/zebby-the-scout-beta/releases/tag/v2.7.0-beta.10' } }));
  await page.locator('.desktop-sidebar').getByRole('button', { name: 'Update to 2.7.0-beta.10', exact: true }).waitFor();
  assert.equal(await page.locator('.sidebar-database').count(), 0);
  await captureSettings('updates-mac-collapsed.png');
  await updatesSettings.getByRole('button', { name: 'Update to 2.7.0-beta.10', exact: true }).click();
  await page.getByRole('button', { name: 'Downloading 40%', exact: true }).first().waitFor();
  assert.equal(await nav.getByRole('button', { name: 'Plan', exact: true }).isEnabled(), true);
  await page.evaluate(() => {
    window.modelQA.updateState({ download: { phase: 'ready', received: 100, total: 100, error: '' } });
    window.modelQA.finishDownload();
  });
  await page.getByRole('button', { name: 'Restart to update', exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Expand navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Collapse navigation', exact: true }).waitFor();
  await captureSettings('updates-mac-ready-dark.png');
  await page.evaluate(() => { window.modelQA.failInstall = true; });
  await updatesSettings.getByRole('button', { name: 'Restart to update', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Synthetic database save failure' }).waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('.desktop-workspace').inert), false);
  await page.evaluate(() => { window.modelQA.failInstall = false; });
  await nav.getByRole('button', { name: 'Applications', exact: true }).click();
  await page.getByRole('button', { name: 'Add application', exact: true }).click();
  await page.locator('.desktop-dashboard .editor').waitFor();
  await page.getByRole('textbox', { name: 'Company', exact: true }).fill('Unsaved company fixture');
  await page.locator('.desktop-sidebar').getByRole('button', { name: 'Restart to update', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Finish editing the open form or dialog before updating.' }).waitFor();
  assert.equal(await page.evaluate(() => window.modelQA.installRequests), 1);
  assert.equal(await page.getByRole('textbox', { name: 'Company', exact: true }).inputValue(), 'Unsaved company fixture');
  await page.getByRole('button', { name: 'Close form', exact: true }).click();
  await nav.getByRole('button', { name: 'Plan', exact: true }).click();
  await page.getByRole('textbox', { name: 'Core ATS keyword 1', exact: true }).waitFor();
  await page.getByRole('textbox', { name: 'Current summary', exact: true }).fill('Unsaved update guard fixture');
  await page.locator('.save-state.unsaved').waitFor();
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('.desktop-sidebar').getByRole('button', { name: 'Restart to update', exact: true }).click();
  assert.equal(await page.evaluate(() => window.modelQA.installRequests), 1);
  assert.equal(await page.getByRole('textbox', { name: 'Current summary', exact: true }).inputValue(), 'Unsaved update guard fixture');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('.desktop-sidebar').getByRole('button', { name: 'Restart to update', exact: true }).click();
  await page.getByRole('button', { name: 'Restarting', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.querySelector('.desktop-workspace').inert), true);
  assert.equal(await page.evaluate(() => window.modelQA.installRequests), 2);
  assert.deepEqual(errors, []);
  console.log(`Headless renderer checks passed. No desktop app was launched. ${captureImages || captureNames.length ? `Screenshots: ${output}` : "No new screenshots were captured."}`);
} finally {
  for (const resolve of pending.values()) resolve();
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
