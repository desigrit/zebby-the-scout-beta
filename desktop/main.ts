import { planInstructions, planSchema, matchInstructions, matchSchema } from "./analysis-contracts";
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, safeStorage, screen, shell } from "electron";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchJobPosting } from "../lib/job-fetch";
import type { ApplicationInput } from "../lib/application-types";
import { analyzeWithOllama, DEFAULT_OLLAMA_URL, listOllamaModels, normalizeOllamaUrl, ollamaThinkingCapability } from "./ollama";
import { extractResumeText } from "./resume-text";
import { DesktopStore, type PlanInput } from "./store";
import { getLocalModel, LOCAL_MODELS } from "./local-model-catalog";
import { LocalModelDownloads } from "./local-model-downloads";
import { LocalModelEngine } from "./local-model-engine";
import { publicAnalysisText, runSelectedAnalysis } from "./analysis-routing";
import { deleteDownloadedModel } from "./local-model-removal";
import { localModelFolder } from "./local-model-storage";
import { acceptModelTerms, modelTermsAccepted, type AcceptedModelTerms } from "./local-model-consent";
import { parsePlanRecommendations } from "./plan-importance";
import { freemem, totalmem, hostname } from "node:os";
import { migrateApplicationProfile, migrateModelFolder } from "./app-identity";
import { CORE_APP_NAME as APP_NAME, configureCoreProfile as configureApplicationProfile } from "./beta-identity";
import { ReleaseUpdates } from "./release-updates";
import { SelfUpdater } from "./self-update";
import { nativeWindowShell, windowColors, type Appearance } from "./window-appearance";
import { DiagnosticLog } from "./diagnostic-log";
import { randomUUID, createHash } from "node:crypto";
import { AnalysisRequests } from "./analysis-requests";
import { editingCommand } from "./editing-commands";
import type { ReportAnalysisProgress } from "../shared/analysis-progress";
import { CreditsClient } from "./credits-client";
import { onlineAnalysis } from "./online-analysis";
import { OnlineAnalysisError } from "./online-response";
import { creditModel, DEFAULT_CREDIT_MODEL, onlineModel, validateOnlineThinking, type AnalysisProvider, type AnalysisSource } from "../shared/online-models";
import { maskedApiKey, onlineThinkingCapability, selectedThinking, thinkingKey, type ThinkingPreferences } from "../shared/thinking";
import { writeProfileSettings } from "./settings-persistence";
import { restoreStartupDatabase } from "./startup-database";
import { readResumeBlocks, resumeDocx, resumeHtml, tailoredBaseName } from "./tailored-resume";
import { applyResumeEdits, tailoringInstructions, tailoringSchema } from "../shared/tailored-resume";
import { printResumePdf } from "./resume-pdf";
import { materializeTailoredResume } from "./resume-files";
import { BoardsStore } from "./boards-store";
import { BoardsService } from "./boards-service";
import { BoardBrowser } from "./board-browser";
import { boardExtractionInstructions, boardExtractionSchema, type BoardInput } from "../shared/boards";
import { CREDIT_SERVICE_URL } from "../shared/credit-service";
import { distributionChannel as resolveDistributionChannel, readStorePackageFamily,
  requireDurableDatabase, storeDataPaths, STORE_UPDATES_URI } from "./distribution";

protocol.registerSchemesAsPrivileged([{
  scheme: "tracker", privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

const appRoot = __dirname;
const rendererRoot = path.join(appRoot, "renderer");
const distributionChannel = resolveDistributionChannel(process.platform, process.windowsStore, process.env.ZEBBY_DISTRIBUTION_CHANNEL);
const storeEdition = distributionChannel === "store";
let storePaths: ReturnType<typeof storeDataPaths> | undefined;
let mainWindow: BrowserWindow | null = null;
let store: DesktopStore;
let boardsStore: BoardsStore;
let boards: BoardsService<ReturnType<typeof selectedAnalysis>>;
let apiKey = "";
let anthropicKey = "";
let creditsClient: CreditsClient;
const paidQuotes = new Map<string, { source: AnalysisSource; model: string; thinkingLevel?: string; hash: string; expires: number; recovery?: boolean }>();
let startupError = "";
let modelDownloads: LocalModelDownloads;
let modelEngine: LocalModelEngine;
let shuttingDown = false;
let selfUpdater: SelfUpdater | undefined;
let installingUpdate = false;
let activeApiRequests = 0;
let activeSettingsRequests = 0;
const analysisRequests = new AnalysisRequests((progress) => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
  try { mainWindow.webContents.send("desktop:analysis-progress", progress); }
  catch (error) { logDiagnostic("Could not send analysis progress", error); }
});
const updates = new ReleaseUpdates({ version: app.getVersion(), platform: process.platform, arch: process.arch, channel: distributionChannel, enabled: false,
  onChange: (value) => mainWindow?.webContents.send("desktop:updates-changed", value),
  onError: (error) => logDiagnostic("Could not check for updates", error) });
let settings: { databasePath?: string; boardsDatabasePath?: string; encryptedApiKey?: string; appearance?: Appearance; sidebarCollapsed?: boolean;
  analysisProvider?: AnalysisProvider; ollamaUrl?: string; ollamaModel?: string; builtInModelId?: string;
  encryptedAnthropicKey?: string; encryptedCreditSession?: string; openaiModel?: string; anthropicModel?: string; creditModel?: string;
  thinkingLevels?: ThinkingPreferences;
  acceptedModelTerms?: AcceptedModelTerms } = {};
let unreadableProfile = false;
const diagnosticLog = new DiagnosticLog(() => logsPath(), () => [apiKey, anthropicKey, ...(creditsClient?.secrets() || [])]);

function settingsPath() { return path.join(app.getPath("userData"), "settings.json"); }
function logsPath() { return path.join(app.getPath("userData"), "Logs"); }

function directUpdater(): SelfUpdater {
  throw new Error("Install a Zebby Core beta build to update this app.");
}

function checkDatabaseLocation(filePath: string) {
  if (storePaths) requireDurableDatabase(filePath, storePaths.packageRoot);
}

function logDiagnostic(message: string, error?: unknown) {
  diagnosticLog.error(message, error);
}
function logEvent(message: string, error?: unknown) {
  if (error) diagnosticLog.error(message, error);
  else diagnosticLog.event(message);
}

async function saveSettings() {
  settingsWrites = settingsWrites.catch(() => undefined).then(() => writeProfileSettings(settingsPath(), JSON.stringify(settings, null, 2)));
  await settingsWrites;
}
let settingsWrites: Promise<unknown> = Promise.resolve();
async function persistAnalysisSettings(change: Partial<typeof settings> | (() => Partial<typeof settings>)) {
  settingsWrites = settingsWrites.catch(() => undefined).then(async () => {
    const patch = typeof change === "function" ? change() : change;
    await writeProfileSettings(settingsPath(), JSON.stringify({ ...settings, ...patch }, null, 2));
    Object.assign(settings, patch);
  });
  await settingsWrites;
}
function thinkingLevel(provider: "openai" | "anthropic" | "credits", model: string) {
  return selectedThinking(settings.thinkingLevels, thinkingKey(provider, model), onlineThinkingCapability(model));
}

async function loadSettings() {
  try { settings = JSON.parse(await readFile(settingsPath(), "utf8")); }
  catch (error) {
    settings = {};
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") { unreadableProfile = true; logDiagnostic("Could not read local settings", error); }
  }
  if (!["auto", "dark", "light"].includes(settings.appearance || "auto")) settings.appearance = "auto";
  if (!["ollama", "openai", "builtin", "anthropic", "credits"].includes(settings.analysisProvider || "")) {
    settings.analysisProvider = settings.encryptedApiKey ? "openai" : "ollama";
  }
  settings.ollamaUrl ||= DEFAULT_OLLAMA_URL;
  settings.ollamaModel ||= "";
  try { if (settings.builtInModelId) getLocalModel(settings.builtInModelId); }
  catch { settings.builtInModelId = ""; }
  if (!settings.acceptedModelTerms || typeof settings.acceptedModelTerms !== "object" || Array.isArray(settings.acceptedModelTerms)) {
    settings.acceptedModelTerms = {};
  }
  delete (settings as typeof settings & { captureLogs?: boolean }).captureLogs;
  if (settings.encryptedApiKey && safeStorage.isEncryptionAvailable()) {
    try { apiKey = safeStorage.decryptString(Buffer.from(settings.encryptedApiKey, "base64")); }
    catch (error) { apiKey = ""; logDiagnostic("Could not read the saved API key", error); }
  }
  for (const [field, fallback, provider] of [["openaiModel", "gpt-6.1-sol", "openai"],
    ["anthropicModel", "claude-sonnet-5-5", "anthropic"], ["creditModel", DEFAULT_CREDIT_MODEL, "credits"]] as const) {
    try { if (provider !== "credits" && onlineModel(settings[field] || fallback).provider !== provider) throw new Error();
      if (provider === "credits") creditModel(settings[field] || fallback); else onlineModel(settings[field] || fallback); }
    catch { settings[field] = fallback; }
  }
  if (settings.encryptedAnthropicKey && safeStorage.isEncryptionAvailable()) {
    try { anthropicKey = safeStorage.decryptString(Buffer.from(settings.encryptedAnthropicKey, "base64")); }
    catch (error) { logDiagnostic("Could not read the saved Anthropic key", error); }
  }
  creditsClient = new CreditsClient(process.env.ZEBBY_CREDITS_SERVICE_URL || CREDIT_SERVICE_URL, {
    save: async (value) => {
      if (value && !safeStorage.isEncryptionAvailable()) throw new Error("Secure storage is unavailable. Restore access to Windows secure storage or Mac Keychain before using paid credits.");
      const previous = settings.encryptedCreditSession;
      try {
        if (value) settings.encryptedCreditSession = safeStorage.encryptString(value).toString("base64");
        else delete settings.encryptedCreditSession;
        await saveSettings();
      } catch (error) { settings.encryptedCreditSession = previous; throw error; }
    },
    onChange: () => mainWindow?.webContents.send("desktop:credits-changed", state()),
    deviceName: `${process.platform === "darwin" ? "Mac" : "Windows"} Ã‚Â· ${hostname().slice(0, 60)}`,
  });
  if (unreadableProfile || settings.encryptedCreditSession && !safeStorage.isEncryptionAvailable()) creditsClient.restoreFailed();
  if (settings.encryptedCreditSession && safeStorage.isEncryptionAvailable()) {
    try { creditsClient.restore(safeStorage.decryptString(Buffer.from(settings.encryptedCreditSession, "base64"))); }
    catch (error) { creditsClient.restoreFailed(); logDiagnostic("Could not restore wallet access", error); }
  }
  try {
    const localPaths = storePaths ? [storePaths.database] : [
      path.join(app.getPath("userData"), "PM Applications.sqlite"),
      path.join(app.getPath("userData"), "Zebby Applications.sqlite"),
    ];
    const restored = await restoreStartupDatabase(settings.databasePath, localPaths, async (filePath) => {
      checkDatabaseLocation(filePath);
      await store.open(filePath);
    });
    if (restored && !settings.databasePath) {
      settings.databasePath = restored;
      await saveSettings();
    }
    if (!restored) logEvent("First launch: waiting for a database to be created or opened");
  } catch (error) {
    startupError = error instanceof Error ? error.message : "The last database could not be opened.";
    logDiagnostic("Could not restore the database; keeping its saved selection", error);
  }
}

function state() {
  return {
    ...store.status, startupError, hasApiKey: Boolean(apiKey), hasAnthropicKey: Boolean(anthropicKey),
    apiKeyHint: maskedApiKey(apiKey, "openai"), anthropicKeyHint: maskedApiKey(anthropicKey, "anthropic"),
    thinkingLevels: settings.thinkingLevels || {},
    openaiModel: settings.openaiModel || "gpt-6.1-sol", anthropicModel: settings.anthropicModel || "claude-sonnet-5-5",
    credits: creditsClient.state(settings.creditModel || DEFAULT_CREDIT_MODEL),
    analysisProvider: settings.analysisProvider || "ollama",
    ollamaUrl: settings.ollamaUrl || DEFAULT_OLLAMA_URL,
    ollamaModel: settings.ollamaModel || "",
    builtInModelId: settings.builtInModelId || "",
    acceptedModelTerms: LOCAL_MODELS.filter((model) => model.license && modelTermsAccepted(model, settings.acceptedModelTerms))
      .map((model) => model.id),
    localModels: modelDownloads?.list() || [], modelsFolder: modelDownloads?.folder || "",
    localEngine: { status: modelEngine?.status || "idle", modelId: modelEngine?.modelId || "",
      backend: modelEngine?.backend || "cpu", cpuFallback: modelEngine?.cpuFallback || false },
    localCompute: modelEngine?.compute,
    totalMemory: totalmem(), availableMemory: freemem(),
    canSaveApiKey: safeStorage.isEncryptionAvailable(),
    appearance: settings.appearance || "auto", sidebarCollapsed: settings.sidebarCollapsed === true,
    logsPath: logsPath(),
    platform: process.platform,
    distributionChannel, appName: APP_NAME, manualUpdates: true,
    updates: updates.state,
  };
}

async function chooseDatabase(kind: "open" | "create") {
  if (activeApiRequests || analysisRequests.busy) throw new Error("Finish or cancel analysis and saving before switching databases.");
  if (kind !== "open" && kind !== "create") throw new Error("Choose whether to open or create a database.");
  const parent = mainWindow || undefined;
  const defaultPath = settings.databasePath ? path.dirname(settings.databasePath) : app.getPath("documents");
  let filePath = "";
  if (kind === "open") {
    const result = await dialog.showOpenDialog(parent!, {
      title: "Open application database", defaultPath,
      properties: ["openFile"],
      filters: [{ name: "SQLite databases", extensions: ["sqlite", "db"] }],
    });
    if (result.canceled) return null;
    if (activeApiRequests || analysisRequests.busy) throw new Error("Finish or cancel analysis and saving before switching databases.");
    filePath = result.filePaths[0];
    checkDatabaseLocation(filePath);
    await store.open(filePath);
  } else {
    const result = await dialog.showSaveDialog(parent!, {
      title: "Create new database", defaultPath: path.join(defaultPath, "Zebby Applications.sqlite"),
      filters: [{ name: "SQLite database", extensions: ["sqlite"] }],
    });
    if (result.canceled || !result.filePath) return null;
    if (activeApiRequests || analysisRequests.busy) throw new Error("Finish or cancel analysis and saving before switching databases.");
    filePath = result.filePath;
    checkDatabaseLocation(filePath);
    await store.create(filePath);
  }
  settings.databasePath = filePath;
  startupError = "";
  await saveSettings();
  logEvent(`Database selected (${kind}, ${filePath})`);
  mainWindow?.webContents.send("desktop:database-changed", state());
  return state();
}

function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

async function captureListing<T extends { listingUrl?: string; snapshotText?: string;
  snapshotSource?: "page" | "manual" | "saved" | ""; jobDescription?: string; description?: string }>(
  input: T, saved?: { listingUrl: string; snapshotText: string }): Promise<T> {
  const url = input?.listingUrl?.trim() || "";
  if (!/^https:\/\//i.test(url) || url.length > 2000 || input.snapshotText?.trim() ||
      saved?.listingUrl === url && saved.snapshotText) return input;
  try {
    const { text } = await fetchJobPosting(url);
    if (text) return { ...input, snapshotText: text, snapshotSource: "page",
      jobDescription: input.jobDescription || text, description: input.description || text };
  } catch { /* The user can save a manually pasted description when a site blocks reading. */ }
  return input;
}

function selectedAnalysis() {
  const provider = settings.analysisProvider || "ollama";
  const model = provider === "openai" ? settings.openaiModel || "gpt-6.1-sol" : provider === "anthropic" ? settings.anthropicModel || "claude-sonnet-5-5"
    : provider === "credits" ? settings.creditModel || DEFAULT_CREDIT_MODEL : provider === "builtin" ? settings.builtInModelId || "" : settings.ollamaModel || "";
  return { provider: settings.analysisProvider || "ollama", ollamaUrl: settings.ollamaUrl || DEFAULT_OLLAMA_URL,
    ollamaModel: settings.ollamaModel || "", builtInModelId: settings.builtInModelId || "", model, apiKey: provider === "anthropic" ? anthropicKey : apiKey,
    thinkingLevels: { ...settings.thinkingLevels },
    thinkingLevel: ["openai", "anthropic", "credits"].includes(provider) ? thinkingLevel(provider as "openai" | "anthropic" | "credits", model)
      : settings.thinkingLevels?.[thinkingKey(provider, model, settings.ollamaUrl || DEFAULT_OLLAMA_URL)] || "off" };
}

function analysisHash(input: unknown) { return createHash("sha256").update(JSON.stringify(input)).digest("hex"); }
async function tailoringInput(id: string) {
  const plan = store.getPlan(id), resume = plan?.resumeId && store.getResume(plan.resumeId);
  if (!plan || !resume) throw new Error("Save this plan with a resume first.");
  if (!plan.matchAnalyzedAt && !plan.keywords.length) throw new Error("Analyze this plan before creating a tailored resume.");
  const resumeBlocks = await readResumeBlocks(resume.resume.filename, resume.data);
  return { plan, resume, input: { url: plan.listingUrl, company: plan.company, title: plan.title, team: plan.team, locations: plan.locations,
    jobDescription: plan.description, currentCvOverview: plan.currentOverview, resumeText: resumeBlocks.map(block => block.text).join("\n"),
    resumeBlocks, suggestedSummary: plan.overview, keywords: plan.keywords, themes: plan.themes } };
}
async function quoteAnalysis(source: AnalysisSource) {
  if (!source || !["plan", "match", "resume"].includes(source.kind) || typeof source.id !== "string" || !/^[\da-f-]{36}$/i.test(source.id)) throw new Error("Choose a saved job to analyze.");
  let input: Record<string, unknown>;
  if (source.kind === "resume") input = (await tailoringInput(source.id)).input;
  else if (source.kind === "plan") {
    const plan = store.getPlan(source.id), resume = plan?.resumeId && store.getResume(plan.resumeId);
    if (!plan || !resume) throw new Error("Save the plan with a resume before analyzing it.");
    const description = plan.description.trim();
    if (description.length < 100) throw new Error("Add a job description with at least 100 characters.");
    input = { url: plan.listingUrl, company: plan.company, title: plan.title, team: plan.team, locations: plan.locations,
      jobDescription: description, currentCvOverview: plan.currentOverview, resumeText: await extractResumeText(resume.resume.filename, resume.data) };
  } else {
    const item = store.listApplications().find((value) => value.id === source.id), resume = item?.resumeId && store.getResume(item.resumeId);
    if (!item || !resume) throw new Error("Add a resume before analyzing the match.");
    const description = item.jobDescription.trim();
    if (description.length < 80) throw new Error("Add a job description with at least 80 characters before analyzing the match.");
    input = { resumeText: await extractResumeText(resume.resume.filename, resume.data), company: item.company,
      title: item.title, jobDescription: description.slice(0, 80000) };
  }
  for (const [id, quote] of paidQuotes) if (quote.expires < Date.now()) paidQuotes.delete(id);
  if (paidQuotes.size >= 20) paidQuotes.delete(paidQuotes.keys().next().value!);
  const recovery = await creditsClient.recoveryQuote(source, input);
  if (recovery) { paidQuotes.set(recovery.id, { source, model: recovery.model, hash: analysisHash(input), expires: Date.parse(recovery.expiresAt), recovery: true }); return recovery; }
  const model = settings.creditModel || DEFAULT_CREDIT_MODEL, level = thinkingLevel("credits", model);
  const quote = await creditsClient.quote(source.kind, input, model, level);
  paidQuotes.set(quote.id, { source, model: quote.model, thinkingLevel: level, hash: analysisHash(input), expires: Date.parse(quote.expiresAt) });
  return quote;
}

async function analyzeWithSelectedProvider(instructions: string, input: unknown, name: string,
  schema: Record<string, unknown>, failure: string, selected: ReturnType<typeof selectedAnalysis>, signal: AbortSignal,
  paid?: { quoteId: string; source: AnalysisSource }, progress?: ReportAnalysisProgress): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  progress?.("waiting");
  logEvent(`Analysis provider selected (${name}, ${selected.provider}, ${selected.model || "default"}, thinking ${selected.thinkingLevel})`);
  return runSelectedAnalysis(selected, {
    ollama: async (baseUrl, model, prompt, content, format) => {
      const capability = await ollamaThinkingCapability(baseUrl, model, fetch, signal).catch(() => null);
      signal?.throwIfAborted();
      const level = capability ? selectedThinking(selected.thinkingLevels, thinkingKey("ollama", model, baseUrl), capability) : selected.thinkingLevel;
      return analyzeWithOllama({ baseUrl, model, instructions: prompt, content: JSON.stringify(content), schema: format, thinkingLevel: level, signal, onProgress: progress });
    },
    openai: async (prompt, content, formatName, format) => (await onlineAnalysis({ model: selected.model, key: selected.apiKey, instructions: prompt,
      input: content, name: formatName, schema: format, kind: formatName === "board_extract" ? "board_extract" : formatName === "tailored_resume" ? "resume" : formatName === "resume_plan" ? "plan" : "match", thinkingLevel: selected.thinkingLevel, signal })).result,
    anthropic: async (prompt, content, formatName, format) => (await onlineAnalysis({ model: selected.model,
      key: selected.apiKey, instructions: prompt, input: content, name: formatName, schema: format,
      kind: formatName === "board_extract" ? "board_extract" : formatName === "tailored_resume" ? "resume" : formatName === "resume_plan" ? "plan" : "match", thinkingLevel: selected.thinkingLevel, signal })).result,
    credits: async () => {
      const quote = paid && paidQuotes.get(paid.quoteId);
      if (!paid || !quote || quote.source.id !== paid.source.id || quote.source.kind !== paid.source.kind || quote.expires < Date.now()
        || !quote.recovery && (quote.model !== selected.model || quote.thinkingLevel !== selected.thinkingLevel) || quote.hash !== analysisHash(input)) {
        throw new Error("Analysis settings or job details changed. Click Analyze to try again.");
      }
      return creditsClient.analyze(paid.quoteId, input, signal, paid.source, quote.model);
    },
    ready: (id) => {
      acceptModelTerms(getLocalModel(id), settings.acceptedModelTerms || {});
      return modelDownloads.readyPath(id);
    },
    local: (id, prompt, content, format, maxTokens) => modelEngine.analyze(id, prompt, content, format, maxTokens, signal, selected.thinkingLevel, progress),
  }, instructions, input, name, schema, failure);
}

async function createTailoredResume(id: string, signal: AbortSignal, commit: <T>(persist: () => Promise<T>) => Promise<T>, quoteId = "", progress?: ReportAnalysisProgress) {
  const selected = selectedAnalysis();
  const { plan, resume, input } = await tailoringInput(id);
  signal.throwIfAborted();
  const infer = (value: unknown) => analyzeWithSelectedProvider(tailoringInstructions, value, "tailored_resume", tailoringSchema,
    "The tailored resume could not be created.", selected, signal, { quoteId, source: { kind: "resume", id } }, progress);
  let result: Record<string, unknown>;
  if (selected.provider === "builtin" && getLocalModel(selected.builtInModelId).basic && input.resumeBlocks.some(block => block.editable)) {
    const edits: unknown[] = [];
    // Small downloaded models receive one editable paragraph at a time. All
    // other source paragraphs stay intact in the output document.
    for (const block of input.resumeBlocks.filter(block => block.editable)) {
      signal.throwIfAborted();
      const partial = await infer({ jobDescription: input.jobDescription.slice(0, 1800), keywords: input.keywords.slice(0, 12), resumeBlocks: [block] });
      applyResumeEdits([block], partial);
      edits.push(...partial.edits as unknown[]);
    }
    result = { edits };
  } else result = await infer(input);
  signal.throwIfAborted();
  progress?.("generating");
  const blocks = applyResumeEdits(input.resumeBlocks, result);
  const [docx, pdf] = await Promise.all([resumeDocx(blocks), printResumePdf(resumeHtml(blocks), signal)]);
  const saved = await commit(() => store.saveTailoredResume(id, plan.updatedAt,
    tailoredBaseName(resume.resume.filename, plan.listingUrl, id), analysisHash(input), docx, pdf));
  if (selected.provider === "credits") await creditsClient.acknowledge(quoteId);
  // The database holds both originals of the generated files, including when
  // Documents is temporarily unavailable. Revealing the link retries export.
  try { await Promise.all((["docx", "pdf"] as const).map(format => materializeTailoredResume(store, app.getPath("documents"), id, format))); }
  catch (error) { logDiagnostic("Tailored resume export will be retried when opened", error); }
  return saved;
}

async function analyzePlan(id: string, signal: AbortSignal, commit: <T>(persist: () => Promise<T>) => Promise<T>, quoteId = "", progress?: ReportAnalysisProgress) {
  const selected = selectedAnalysis();
  const plan = store.getPlan(id);
  if (!plan) throw new Error("Plan not found.");
  if (!plan.resumeId) throw new Error("Choose a resume for this plan before analyzing it.");
  const resume = store.getResume(plan.resumeId);
  if (!resume) throw new Error("The selected resume could not be found.");
  const description = plan.description.trim();
  if (description.length < 100) {
    throw new Error("Add a job description with at least 100 characters.");
  }
  const job = { url: plan.listingUrl, company: plan.company, title: plan.title, team: plan.team,
    locations: plan.locations, jobDescription: description, currentCvOverview: plan.currentOverview };
  const input = selected.provider !== "openai"
    ? { ...job, resumeText: await extractResumeText(resume.resume.filename, resume.data) }
    : [{ role: "user", content: [
      { type: "input_file", filename: resume.resume.filename,
        file_data: `data:${resume.resume.contentType};base64,${Buffer.from(resume.data).toString("base64")}` },
      { type: "input_text", text: JSON.stringify(job) },
    ] }];
  const analysis = await analyzeWithSelectedProvider(planInstructions,
    input, "resume_plan", planSchema,
    "The analysis was incomplete. Try again.", selected, signal, { quoteId, source: { kind: "plan", id } }, progress);
  signal.throwIfAborted();
  const keywords = parsePlanRecommendations(analysis.keywords, 6, 20, 200);
  const themes = parsePlanRecommendations(analysis.themes, 5, 6, 1000);
  const overview = typeof analysis.overview === "string" ? publicAnalysisText(analysis.overview.trim()) : "";
  const rawRationale = typeof analysis.overviewRationale === "string" ? publicAnalysisText(analysis.overviewRationale.trim()) : "";
  const sameOverview = overview.replace(/\s+/g, " ") === plan.currentOverview.trim().replace(/\s+/g, " ");
  const claimedEdit = /\b(?:I|we)\s+(?:changed|rewrote|replaced|added|removed|shifted|refocused|emphasized)\b/i.test(rawRationale);
  const overviewRationale = sameOverview && claimedEdit
    ? "The overview was returned unchanged. Review it against the role and edit it if you want to emphasize different experience."
    : rawRationale;
  const score = analysis.score;
  const explanation = typeof analysis.explanation === "string" ? publicAnalysisText(analysis.explanation.trim()) : "";
  if (keywords.length < 6 || keywords.length > 20 || themes.length < 5 || themes.length > 6 || !overview || !overviewRationale ||
      !explanation || typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100) {
    throw new Error("The analysis was incomplete. Try again.");
  }
  const saved = await commit(() => store.savePlanAnalysis(id, plan.updatedAt, keywords.map((item) => item.text),
    themes.map((item) => item.text), overview, overviewRationale, score,
    keywords.map((item) => item.importance), themes.map((item) => item.importance), explanation));
  if (selected.provider === "credits") { await creditsClient.acknowledge(quoteId).catch((error) => logDiagnostic("Could not clear completed credit recovery", error)); paidQuotes.delete(quoteId); }
  return saved;
}

async function analyzeApplicationMatch(id: string, signal: AbortSignal, commit: <T>(persist: () => Promise<T>) => Promise<T>, quoteId = "") {
  const selected = selectedAnalysis();
  const application = store.listApplications().find((item) => item.id === id);
  if (!application) throw new Error("Application not found.");
  if (!application.resumeId) throw new Error("Add a resume to this application, then analyze the match.");
  const resume = store.getResume(application.resumeId);
  if (!resume) throw new Error("The selected resume could not be found.");
  // The editable description is authoritative. Never silently replace user edits
  // with an older archive, another Plan, or a newly fetched page during analysis.
  const description = application.jobDescription.trim();
  if (description.length < 80) {
    throw new Error("Add a job description with at least 80 characters before analyzing the match.");
  }
  const input = selected.provider !== "openai"
    ? { resumeText: await extractResumeText(resume.resume.filename, resume.data),
      company: application.company, title: application.title, jobDescription: description.slice(0, 80_000) }
    : [{ role: "user", content: [
      { type: "input_file", filename: resume.resume.filename,
        file_data: `data:${resume.resume.contentType};base64,${Buffer.from(resume.data).toString("base64")}` },
      { type: "input_text", text: JSON.stringify({ company: application.company,
        title: application.title, jobDescription: description.slice(0, 80_000) }) },
    ] }];
  const analysis = await analyzeWithSelectedProvider(matchInstructions, input,
    "application_match", matchSchema, "The match analysis was incomplete. Try again.", selected, signal, { quoteId, source: { kind: "match", id } });
  signal.throwIfAborted();
  const score = analysis.score;
  const explanation = typeof analysis.explanation === "string" ? publicAnalysisText(analysis.explanation.trim()) : "";
  if (typeof score !== "number" || !Number.isInteger(score) || score < 0 || score > 100 || !explanation) {
    throw new Error("The match analysis was incomplete. Try again.");
  }
  const saved = await commit(() => store.saveMatchAnalysis(id, application.updatedAt, score, explanation, description));
  if (selected.provider === "credits") { await creditsClient.acknowledge(quoteId).catch((error) => logDiagnostic("Could not clear completed credit recovery", error)); paidQuotes.delete(quoteId); }
  return saved;
}

async function handleApi(request: Request, pathname: string): Promise<Response> {
  const method = request.method.toUpperCase();
  const started = Date.now();
  if (installingUpdate && method !== "GET") return jsonError("Zebby is restarting to install an update.", 503);
  activeApiRequests++;
  if (method !== "GET") logEvent(`Request started (${method} ${pathname})`);
  try {
    if (pathname === "/api/locations/recent" && method === "GET") {
      return Response.json({ locations: store.listRecentLocations() });
    }
    if (pathname === "/api/applications") {
      if (method === "GET") return Response.json({ applications: store.listApplications() });
      if (method === "POST") return Response.json({ application: await store.saveApplication(
        await captureListing(await request.json() as ApplicationInput)) }, { status: 201 });
    }
    const applicationId = pathname.match(/^\/api\/applications\/([\da-f-]+)$/i)?.[1];
    if (applicationId) {
      if (method === "PATCH" || method === "DELETE") analysisRequests.assertEditable(`match:${applicationId}`);
      if (method === "PATCH") return Response.json({ application: await store.saveApplication(
        await captureListing(await request.json() as ApplicationInput,
          store.listApplications().find((item) => item.id === applicationId)),
        applicationId) });
      if (method === "DELETE") { await store.deleteApplication(applicationId); return new Response(null, { status: 204 }); }
    }
    const matchId = pathname.match(/^\/api\/applications\/([\da-f-]+)\/analyze$/i)?.[1];
    if (matchId && method === "POST") return Response.json({ application: await analysisRequests.run(
      request.headers.get("X-Zebby-Analysis-ID") || randomUUID(), (signal, commit) => analyzeApplicationMatch(matchId, signal, commit,
        request.headers.get("X-Zebby-Credit-Quote") || ""), `match:${matchId}`) });
    const notesId = pathname.match(/^\/api\/applications\/([\da-f-]+)\/notes$/i)?.[1];
    if (notesId && method === "PATCH") {
      analysisRequests.assertEditable(`match:${notesId}`);
      const input = await request.json() as { notes?: unknown };
      return Response.json({ application: await store.saveApplicationNotes(notesId, input?.notes) });
    }
    if (pathname === "/api/resumes") {
      if (method === "GET") return Response.json({ resumes: store.listResumes() });
      if (method === "POST") {
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) return jsonError("Choose a resume file.");
        const extension = file.name.split(".").pop()?.toLowerCase() || "";
        const allowed: Record<string, string> = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", doc: "application/msword" };
        if (!allowed[extension]) return jsonError("Upload a PDF, DOCX, or DOC file.");
        if (!file.size) return jsonError("This file is empty. Choose another resume.");
        if (file.size > 10 * 1024 * 1024) return jsonError("Choose a resume under 10 MB.");
        const filename = file.name.replace(/[\r\n\\/]/g, " ").trim().slice(0, 180);
        if (!filename) return jsonError("Give the resume file a name.");
        return Response.json({ resume: await store.addResume(filename, allowed[extension], new Uint8Array(await file.arrayBuffer())) }, { status: 201 });
      }
    }
    if (pathname === "/api/job-details" && method === "POST") {
      const input = await request.json() as { url?: string };
      if (!input?.url || input.url.length > 2000) return jsonError("Enter a valid job listing link.");
      const { details } = await fetchJobPosting(input.url);
      return Response.json({ details });
    }
    if (pathname === "/api/job-posting" && method === "POST") {
      const input = await request.json() as { url?: string };
      if (!input?.url || input.url.length > 2000) return jsonError("Enter a valid job listing link.");
      return Response.json(await fetchJobPosting(input.url));
    }
    if (pathname === "/api/plans") {
      if (method === "GET") return Response.json({ plans: store.listPlans(), lastCurrentOverview: store.getLastCurrentOverview() });
      if (method === "POST") return Response.json({ plan: await store.savePlan(
        await captureListing(await request.json() as PlanInput)) }, { status: 201 });
    }
    const planId = pathname.match(/^\/api\/plans\/([\da-f-]+)$/i)?.[1];
    if (planId) {
      if (method === "PUT" || method === "DELETE") analysisRequests.assertEditable(`plan:${planId}`);
      if (method === "PUT") return Response.json({ plan: await store.savePlan(
        await captureListing(await request.json() as PlanInput, store.getPlan(planId) || undefined), planId) });
      if (method === "DELETE") { await store.deletePlan(planId); return new Response(null, { status: 204 }); }
    }
    const applyPlanId = pathname.match(/^\/api\/plans\/([\da-f-]+)\/apply$/i)?.[1];
    if (applyPlanId && method === "POST") {
      analysisRequests.assertEditable(`plan:${applyPlanId}`);
      const input = await request.json() as { expectedUpdatedAt?: unknown };
      if (typeof input?.expectedUpdatedAt !== "string") return jsonError("Save this plan before moving it to Applied.");
      const result = await store.applyPlan(applyPlanId, input.expectedUpdatedAt);
      return Response.json(result, { status: result.created ? 201 : 200 });
    }
    const tailoringId = pathname.match(/^\/api\/plans\/([\da-f-]+)\/tailor$/i)?.[1];
    if (tailoringId && method === "POST") return Response.json({ plan: await analysisRequests.run(
      request.headers.get("X-Zebby-Analysis-ID") || randomUUID(), (signal, commit, progress) => createTailoredResume(tailoringId, signal, commit,
        request.headers.get("X-Zebby-Credit-Quote") || "", progress), `plan:${tailoringId}`) });
    const analysisId = pathname.match(/^\/api\/plans\/([\da-f-]+)\/analyze$/i)?.[1];
    if (analysisId && method === "POST") return Response.json({ plan: await analysisRequests.run(
      request.headers.get("X-Zebby-Analysis-ID") || randomUUID(), (signal, commit, progress) => analyzePlan(analysisId, signal, commit,
        request.headers.get("X-Zebby-Credit-Quote") || "", progress), `plan:${analysisId}`) });
    return jsonError("Not found.", 404);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      logEvent(`Request cancelled (${method} ${pathname}, ${Date.now() - started} ms)`);
      return jsonError("Analysis cancelled.", 499);
    }
    console.error("Desktop API request failed", pathname, error);
    if (error instanceof OnlineAnalysisError) logEvent(`Online analysis rejected (${error.diagnostic})`);
    logDiagnostic(`Request failed (${method} ${pathname})`, error);
    const message = error instanceof Error ? error.message : "The request could not be completed.";
    return jsonError(message, /changed outside|changed while/.test(message) ? 409 : 400);
  } finally {
    activeApiRequests--;
    if (method !== "GET") logEvent(`Request finished (${method} ${pathname}, ${Date.now() - started} ms)`);
  }
}

function registerProtocol() {
  protocol.handle("tracker", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return new Response("Not found", { status: 404 });
    if (url.pathname.startsWith("/api/")) return handleApi(request, url.pathname);
    const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const target = path.resolve(rendererRoot, "." + pathname);
    const relative = path.relative(rendererRoot, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return new Response("Not found", { status: 404 });
    if (!(await stat(target).catch(() => null))?.isFile()) return new Response("Not found", { status: 404 });
    const mime: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
      ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
    return new Response(await readFile(target), {
      headers: { "Content-Type": mime[path.extname(target)] || "application/octet-stream", "X-Content-Type-Options": "nosniff" },
    });
  });
}

function registerIpc() {
  function walletChangesAllowed() {
    if (analysisRequests.busy || boards.busy) throw new Error("Finish or cancel analysis and board checks before changing credit access.");
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure storage is unavailable. Restore access to Windows secure storage or Mac Keychain before using paid credits.");
  }
  function handle<Args extends unknown[], Result>(channel: string,
    listener: (event: Electron.IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>) {
    ipcMain.handle(channel, async (event, ...args: Args) => {
      if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error("This request must come from the Zebby workspace.");
      const started = Date.now();
      const trace = !["desktop:state", "desktop:refresh-credits", "desktop:credit-checkout-status"].includes(channel);
      const changing = !["desktop:state", "desktop:check-updates", "desktop:open-store-updates", "desktop:download-update", "desktop:install-update",
        "desktop:list-ollama-models", "desktop:ollama-thinking-capability", "desktop:open-logs", "desktop:open-model-folder", "desktop:download-resume",
        "desktop:warm-credits-service"].includes(channel);
      if (installingUpdate && changing) throw new Error("Zebby is restarting to install an update.");
      if (changing) activeSettingsRequests++;
      if (trace) logEvent(`Setting request started (${channel})`);
      try { return await listener(event, ...args); }
      catch (error) { logDiagnostic(`Request failed (${channel})`, error); throw error; }
      finally {
        if (changing) activeSettingsRequests--;
        if (trace) logEvent(`Setting request finished (${channel}, ${Date.now() - started} ms)`);
      }
    });
  }
  handle("desktop:state", () => state());
  handle("boards:state", () => boards.state);
  handle("boards:choose-database", async (_event, kind: "open" | "create") => {
    boards.assertIdle();
    if (!["open", "create"].includes(kind)) throw new Error("Choose whether to create or open a Boards database.");
    const configured = settings.boardsDatabasePath || settings.databasePath;
    const oneDrive = process.env.OneDrive || process.env.OneDriveConsumer;
    const suggested = oneDrive ? path.join(oneDrive, "Work Applications") : "";
    const folder = configured ? path.dirname(configured) : suggested && (await stat(suggested).catch(() => null))?.isDirectory() ? suggested : app.getPath("documents");
    let file = "";
    if (kind === "open") {
      const result = await dialog.showOpenDialog(mainWindow!, { title: "Open Boards database", defaultPath: folder,
        properties: ["openFile"], filters: [{ name: "Boards database", extensions: ["sqlite"] }] });
      if (result.canceled) return null; file = result.filePaths[0];
    } else {
      const result = await dialog.showSaveDialog(mainWindow!, { title: "Create Boards database", defaultPath: path.join(folder, "Zebby Boards.sqlite"),
        filters: [{ name: "Boards database", extensions: ["sqlite"] }] });
      if (result.canceled || !result.filePath) return null; file = result.filePath;
    }
    boards.assertIdle();
    if (kind === "create") await boardsStore.create(file); else await boardsStore.open(file);
    await persistAnalysisSettings({ boardsDatabasePath: file });
    boards.error = ""; boards.changed(); return boards.state;
  });
  handle("boards:retry-save", async () => {
    try { await boardsStore.retrySave(); boards.error = ""; }
    finally { boards.changed(); }
    return boards.state;
  });
  handle("boards:save-recovery", async () => {
    boards.assertIdle();
    const result = await dialog.showSaveDialog(mainWindow!, { title: "Save Boards recovery copy", defaultPath: "Zebby Boards Recovery.sqlite",
      filters: [{ name: "Boards database", extensions: ["sqlite"] }] });
    if (result.canceled || !result.filePath) return null;
    await boardsStore.saveRecoveryCopy(result.filePath);
    await boardsStore.open(result.filePath);
    await persistAnalysisSettings({ boardsDatabasePath: result.filePath });
    boards.error = ""; boards.changed(); return boards.state;
  });
  handle("boards:add", async (_event, inputs: BoardInput[]) => {
    if (!Array.isArray(inputs)) throw new Error("Add one board link per line.");
    try { const ids = await boardsStore.add(inputs); return boards.check(ids); }
    finally { boards.changed(); }
  });
  handle("boards:update", async (_event, id: string, input: BoardInput) => {
    boards.assertIdle(id);
    try { await boardsStore.update(id, input); return boards.state; }
    finally { boards.changed(); }
  });
  handle("boards:remove", async (_event, id: string) => {
    boards.assertIdle(id);
    const board = boardsStore.get(id);
    const response = await dialog.showMessageBox(mainWindow!, { type: "question", title: "Remove board?",
      message: `Remove ${board.company} and its check history?`, buttons: ["Cancel", "Remove board"], defaultId: 0, cancelId: 0 });
    if (response.response === 1) { boards.assertIdle(id); await boardsStore.remove(id); boards.changed(); }
    return boards.state;
  });
  handle("boards:check", (_event, ids?: string[]) => boards.check(ids));
  handle("boards:cancel", (_event, id: string) => boards.cancel(id));
  handle("boards:reviewed", async (_event, id: string, through: number) => {
    try { await boardsStore.reviewed(id, through); return boards.state; }
    finally { boards.changed(); }
  });
  handle("desktop:warm-credits-service", () => creditsClient.warmService());
  handle("desktop:refresh-credits", async () => { await creditsClient.refreshWallet(); return state(); });
  handle("desktop:refresh-credit-access", async () => { walletChangesAllowed(); await creditsClient.refreshAccess(); return state(); });
  handle("desktop:connect-credit-wallet", async (_event, kind: "restore" | "connect", code: string) => {
    walletChangesAllowed();
    if (!["restore", "connect"].includes(kind) || typeof code !== "string" || code.length > 100) throw new Error("Enter a valid recovery or pairing code.");
    if (state().credits.signedIn && state().credits.wallet?.purchased) {
      const access = await creditsClient.refreshAccess();
      if (!access.hasRecoveryCode) throw new Error("Save a recovery code for your current wallet before switching wallets.");
      if (creditsClient.hasCurrentRecoveryCode() && !state().credits.recoverySaved) throw new Error("Save your current wallet's recovery code to a file before switching wallets.");
      const response = await dialog.showMessageBox(mainWindow!, { type: "question", title: "Switch credit wallets?",
        message: "Connect this computer to another credit wallet?", detail: "Your current wallet keeps its credits. You can reconnect using its recovery code.",
        buttons: ["Cancel", "Switch wallet"], defaultId: 0, cancelId: 0, noLink: true });
      if (response.response !== 1) return { connected: false, state: state() };
    }
    walletChangesAllowed(); paidQuotes.clear();
    await creditsClient.connectWallet(kind, code); return { connected: true, state: state() };
  });
  handle("desktop:save-credit-recovery", async (_event, rotate = false) => {
    walletChangesAllowed();
    if (typeof rotate !== "boolean") throw new Error("Invalid recovery request.");
    const access = await creditsClient.refreshAccess();
    if (access.hasRecoveryCode && (rotate || !creditsClient.hasCurrentRecoveryCode())) {
      const response = await dialog.showMessageBox(mainWindow!, { type: "question", title: "Replace recovery code?",
        message: "Create a new recovery code?", detail: "The previous recovery code will stop working. Connected computers keep their access.",
        buttons: ["Cancel", "Create new code"], defaultId: 0, cancelId: 0, noLink: true });
      if (response.response !== 1) return { saved: false, state: state() };
    }
    const selected = await dialog.showSaveDialog(mainWindow!, { title: "Save Zebby recovery code", defaultPath: "Zebby recovery code.txt",
      filters: [{ name: "Text file", extensions: ["txt"] }] });
    if (selected.canceled || !selected.filePath) return { saved: false, state: state() };
    const target = path.resolve(selected.filePath);
    if (path.extname(target).toLowerCase() !== ".txt" || target.toLowerCase() === path.resolve(state().filePath || settingsPath()).toLowerCase()) {
      throw new Error("Choose a text file for the recovery code. Your database cannot be used.");
    }
    walletChangesAllowed();
    const code = await creditsClient.recoveryCode(rotate);
    await writeFile(target, `Zebby credit wallet recovery code\n\n${code}\n\nKeep this file private. Anyone with this code can use your remaining credits.\nTo restore access, open Zebby Settings, Credits, Restore credits.\nA new recovery code replaces this one.\n`, { encoding: "utf8", mode: 0o600 });
    await creditsClient.markRecoverySaved(); return { saved: true, state: state() };
  });
  handle("desktop:create-credit-pairing", async () => { walletChangesAllowed(); return creditsClient.startPairing(); });
  handle("desktop:cancel-credit-pairing", () => creditsClient.cancelPairing());
  handle("desktop:remove-credit-device", async (_event, id: string) => {
    walletChangesAllowed();
    const device = (await creditsClient.refreshAccess()).devices.find((item) => item.id === id && !item.current);
    if (!device) throw new Error("Choose another connected computer.");
    const result = await dialog.showMessageBox(mainWindow!, { type: "question", title: "Disconnect computer?", message: `Disconnect ${device.name}?`,
      detail: "It will need a new pairing or recovery code to use this wallet again. Your credits stay in the wallet.",
      buttons: ["Cancel", "Disconnect"], defaultId: 0, cancelId: 0, noLink: true });
    if (result.response === 1) { walletChangesAllowed(); await creditsClient.removeDevice(id); }
    return state();
  });
  handle("desktop:start-credit-checkout", async (_event, pack: string) => {
    walletChangesAllowed();
    const checkout = await creditsClient.checkout(pack); await shell.openExternal(checkout.url);
    return { id: checkout.id, mode: checkout.mode };
  });
  handle("desktop:credit-checkout-status", (_event, id: string) => creditsClient.checkoutStatus(id));
  handle("desktop:quote-credit-analysis", (_event, source: AnalysisSource) => quoteAnalysis(source));
  handle("desktop:set-online-model", async (_event, provider: string, model: string) => {
    const selected = onlineModel(model);
    if (!["openai", "anthropic", "credits"].includes(provider) || provider !== "credits" && selected.provider !== provider) throw new Error("Choose a model for this provider.");
    if (provider === "credits") creditModel(model);
    await persistAnalysisSettings({ [provider === "credits" ? "creditModel" : provider === "openai" ? "openaiModel" : "anthropicModel"]: model });
    paidQuotes.clear(); return state();
  });
  handle("desktop:set-thinking-level", async (_event, value: { provider: AnalysisProvider; model: string; level: string }) => {
    if (!value || !["openai", "anthropic", "credits", "ollama", "builtin"].includes(value.provider) || typeof value.level !== "string" || value.level.length > 80
      || typeof value.model !== "string" || !value.model || value.model.length > 200) throw new Error("Choose a model and thinking level.");
    const { provider, model, level } = value;
    if (["openai", "anthropic", "credits"].includes(provider)) {
      const chosen = provider === "credits" ? creditModel(model) : onlineModel(model);
      if (provider !== "credits" && chosen.provider !== provider) throw new Error("Choose a model for this provider.");
      validateOnlineThinking(chosen, level);
    } else if (provider === "builtin") {
      const chosen = getLocalModel(model);
      if (!["off", "on"].includes(level) || level === "on" && !chosen.supportsThinking) throw new Error("This downloaded model does not support that thinking level.");
    } else {
      const capability = await ollamaThinkingCapability(settings.ollamaUrl || DEFAULT_OLLAMA_URL, model);
      if (!capability.options.some((item) => item.value === level)) throw new Error("Choose a thinking level supported by this model.");
    }
    const preferenceKey = thinkingKey(provider, model, settings.ollamaUrl || DEFAULT_OLLAMA_URL);
    await persistAnalysisSettings(() => ({ thinkingLevels: { ...settings.thinkingLevels, [preferenceKey]: level } }));
    paidQuotes.clear(); return state();
  });
  handle("desktop:set-anthropic-key", async (_event, value: string) => {
    if (typeof value !== "string" || value.length > 500) throw new Error("Enter an Anthropic API key.");
    const next = value.trim();
    await persistAnalysisSettings({ encryptedAnthropicKey: next && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(next).toString("base64") : undefined });
    anthropicKey = next; return state();
  });
  handle("desktop:cancel-analysis", (_event, id: string) => {
    const accepted = analysisRequests.cancel(id);
    logEvent(`Analysis cancellation requested (${id}, accepted ${accepted})`);
    return accepted;
  });
  handle("desktop:check-updates", () => updates.check(true));
  handle("desktop:open-store-updates", async () => {
    if (!storeEdition) throw new Error("This installation receives updates in Zebby.");
    await shell.openExternal(STORE_UPDATES_URI);
  });
  handle("desktop:confirm-update-loaded", () => undefined);
  handle("desktop:download-update", async () => {
    const updater = directUpdater();
    if (!app.isPackaged) throw new Error("Automatic updates are available in the installed app.");
    const available = updates.state.available;
    if (!available) throw new Error("Check for an available update first.");
    await updater.download(available);
    return updates.state;
  });
  handle("desktop:install-update", async () => {
    const updater = directUpdater();
    if (installingUpdate) return;
    if (!app.isPackaged || updates.state.download.phase !== "ready") throw new Error("Download the update before restarting.");
    if (activeApiRequests || activeSettingsRequests) throw new Error("Wait for analysis and saving to finish, then restart to update.");
    installingUpdate = true;
    try {
      await store.retrySync();
      await Promise.all([modelDownloads.pause(), modelEngine.shutdown()]);
      await store.retrySync();
      await diagnosticLog.flush();
      await updater.install();
      shuttingDown = true;
      setImmediate(() => app.quit());
    } catch (error) { installingUpdate = false; throw error; }
  });
  handle("desktop:choose-database", (_event, kind: "open" | "create") => chooseDatabase(kind));
  handle("desktop:retry-sync", () => store.retrySync());
  handle("desktop:set-appearance", async (_event, value: Appearance) => {
    if (value !== "auto" && value !== "dark" && value !== "light") throw new Error("Choose an appearance option.");
    settings.appearance = value;
    nativeTheme.themeSource = value === "auto" ? "system" : value;
    updateWindowAppearance();
    await saveSettings();
    return state();
  });
  handle("desktop:set-sidebar-collapsed", async (_event, value: boolean) => {
    if (typeof value !== "boolean") throw new Error("Choose a navigation layout.");
    const previous = settings.sidebarCollapsed;
    settings.sidebarCollapsed = value;
    try { await saveSettings(); return state(); }
    catch (error) { settings.sidebarCollapsed = previous; throw error; }
  });
  handle("desktop:open-logs", async () => {
    await mkdir(logsPath(), { recursive: true });
    const error = await shell.openPath(logsPath());
    if (error) throw new Error(error);
  });
  ipcMain.on("desktop:renderer-error", (_event, message: unknown) => {
    if (typeof message === "string") logDiagnostic("Renderer error", message.slice(0, 4000));
  });
  handle("desktop:set-api-key", async (_event, value: string) => {
    if (typeof value !== "string" || value.length > 500) throw new Error("The API key is invalid.");
    const next = value.trim();
    await persistAnalysisSettings({ encryptedApiKey: next && safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(next).toString("base64") : undefined });
    apiKey = next;
    return state();
  });
  handle("desktop:set-analysis-provider", async (_event, value: AnalysisProvider) => {
    if (!["ollama", "openai", "builtin", "anthropic", "credits"].includes(value)) throw new Error("Choose an analysis provider.");
    await persistAnalysisSettings({ analysisProvider: value });
    return state();
  });
  handle("desktop:set-ollama-config", async (_event, value: { url?: string; model?: string }) => {
    if (!value || typeof value.url !== "string" || typeof value.model !== "string" ||
        value.model.length > 200 || /[\r\n]/.test(value.model)) {
      throw new Error("Enter an Ollama server URL and model.");
    }
    await persistAnalysisSettings({ ollamaUrl: normalizeOllamaUrl(value.url), ollamaModel: value.model.trim() });
    return state();
  });
  handle("desktop:list-ollama-models", async (_event, url: string) => {
    if (typeof url !== "string" || url.length > 500) throw new Error("Enter an Ollama server URL.");
    return listOllamaModels(url);
  });
  handle("desktop:ollama-thinking-capability", (_event, url: string, model: string) => {
    if (typeof url !== "string" || url.length > 500 || typeof model !== "string") throw new Error("Choose a server and model.");
    return ollamaThinkingCapability(url, model);
  });
  handle("desktop:select-local-model", async (_event, id: string) => {
    const model = getLocalModel(id);
    settings.builtInModelId = id;
    await saveSettings();
    if (modelTermsAccepted(model, settings.acceptedModelTerms)) await modelDownloads.start(id);
    else await modelDownloads.pause();
    return state();
  });
  handle("desktop:pause-model-download", async () => { await modelDownloads.pause(); return state(); });
  handle("desktop:stop-model-download", async (_event, id: string) => {
    getLocalModel(id);
    await modelDownloads.stop(id);
    return state();
  });
  handle("desktop:resume-model-download", async (_event, id: string, termsVersion?: string) => {
    const accepted = settings.acceptedModelTerms || {};
    const next = acceptModelTerms(getLocalModel(id), accepted, termsVersion);
    if (next !== accepted) { settings.acceptedModelTerms = next; await saveSettings(); }
    await modelDownloads.start(id); return state();
  });
  handle("desktop:delete-local-model", async (_event, id: string) => {
    await deleteDownloadedModel(id, { engine: modelEngine, downloads: modelDownloads,
      confirm: async (options) => (await dialog.showMessageBox(mainWindow!, options)).response === 1,
    });
    return state();
  });
  handle("desktop:open-model-folder", () => shell.openPath(modelDownloads.folder));
  handle("desktop:reveal-tailored-resume", async (_event, id: string, format: "docx" | "pdf") => {
    const filePath = await materializeTailoredResume(store, app.getPath("documents"), id, format);
    shell.showItemInFolder(filePath);
  });
  handle("desktop:download-resume", async (_event, id: string) => {
    const file = store.getResume(id);
    if (!file) throw new Error("Resume not found.");
    const result = await dialog.showSaveDialog(mainWindow!, { defaultPath: file.resume.filename,
      title: "Save resume" });
    if (!result.canceled && result.filePath) await writeFile(result.filePath, file.data);
    return !result.canceled;
  });
}

function createMenu() {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: app.name, submenu: [
    { role: "about" }, { type: "separator" }, { role: "services" }, { type: "separator" },
    { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" },
  ] }]));
}

function openWebLink(url: string) {
  try {
    const target = new URL(url);
    if (target.protocol === "http:" || target.protocol === "https:") {
      void shell.openExternal(target.toString()).catch((error) => logDiagnostic("Could not open web link", error));
    }
  } catch { /* Ignore malformed links. */ }
}

function updateWindowAppearance() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const colors = windowColors(settings.appearance, nativeTheme.shouldUseDarkColors);
  mainWindow.setBackgroundColor(colors.background);
  if (process.platform !== "darwin") {
    mainWindow.setTitleBarOverlay({ color: colors.background, symbolColor: colors.foreground });
  }
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    show: !(process.env.PM_TRACKER_TEST_USER_DATA && process.env.PM_TRACKER_TEST_HIDE_WINDOW),
    width: Math.min(1550, workArea.width), height: Math.min(850, workArea.height),
    minWidth: Math.min(790, workArea.width), minHeight: Math.min(620, workArea.height),
    ...nativeWindowShell(process.platform, settings.appearance, nativeTheme.shouldUseDarkColors),
    title: APP_NAME, autoHideMenuBar: true,
    icon: path.join(rendererRoot, "icon.png"),
    webPreferences: { preload: path.join(appRoot, "preload.cjs"), contextIsolation: true,
      nodeIntegration: false, sandbox: true, webSecurity: true,
      ...(process.env.PM_TRACKER_TEST_USER_DATA && process.env.PM_TRACKER_TEST_HIDE_WINDOW ? { backgroundThrottling: false } : {}) },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openWebLink(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("tracker://app/")) {
      event.preventDefault();
      openWebLink(url);
    }
  });
  mainWindow.webContents.on("before-input-event", (event, input) => {
    const command = editingCommand(input, process.platform);
    if (command) { event.preventDefault(); mainWindow?.webContents[command](); }
  });
  mainWindow.webContents.on("context-menu", (_event, params) => {
    if (!mainWindow || !params.isEditable && !params.selectionText) return;
    const flags = params.editFlags;
    Menu.buildFromTemplate(params.isEditable ? [
      { role: "cut", enabled: flags.canCut }, { role: "copy", enabled: flags.canCopy },
      { role: "paste", enabled: flags.canPaste }, { type: "separator" }, { role: "selectAll", enabled: flags.canSelectAll },
    ] : [{ role: "copy", enabled: flags.canCopy }]).popup({ window: mainWindow });
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) =>
    logDiagnostic("Renderer process stopped", `${details.reason}, exit code ${details.exitCode}`));
  void mainWindow.loadURL("tracker://app/");
  mainWindow.on("closed", () => { mainWindow = null; void boards?.stop(); });
  mainWindow.on("focus", () => { if (!storeEdition) void updates.check(); });
}

if (process.env.PM_TRACKER_TEST_USER_DATA) app.setPath("userData", path.resolve(process.env.PM_TRACKER_TEST_USER_DATA));
let profile: ReturnType<typeof configureApplicationProfile> | undefined;
let profileError: unknown;
if (storeEdition) {
  try {
    const isolatedFolder = process.env.PM_TRACKER_TEST_USER_DATA;
    storePaths = storeDataPaths({ packageFamilyName: isolatedFolder ? undefined : readStorePackageFamily(process.resourcesPath),
      localAppData: process.env.LOCALAPPDATA, home: app.getPath("home"), documents: app.getPath("documents"), isolatedFolder });
    // Store and direct installations use independent profiles and instance locks.
    // Do not import private keys or move models out of the direct installation.
    profile = configureApplicationProfile(app, storePaths.profile);
  } catch (error) { profileError = error; }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  if (!storeEdition) {
    try { profile = configureApplicationProfile(app, process.env.PM_TRACKER_TEST_USER_DATA); }
    catch (error) { profileError = error; }
  }
  app.on("second-instance", () => { mainWindow?.show(); mainWindow?.focus(); });
  app.whenReady().then(async () => {
    if (!profile) throw profileError || new Error("The Zebby data folder could not be created.");
    if (!storeEdition) await migrateApplicationProfile(profile);
    logEvent(`Zebby starting (${app.getVersion()}, ${process.platform}/${process.arch}, profile ${app.getPath("userData")})`);
    store = new DesktopStore(storePaths?.recovery || app.getPath("userData"), logEvent);
    await loadSettings();
    boardsStore = new BoardsStore(app.getPath("userData"));
    boards = new BoardsService(boardsStore, {
      profile: app.getPath("userData"), selection: selectedAnalysis, reader: signal => new BoardBrowser(signal),
      changed: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("boards:changed", boards.state); },
      acknowledgeCached: async (selected, input, sourceId) => {
        if (selected.provider === "credits") await creditsClient.acknowledgeCachedSource({ kind: "board_extract", id: sourceId }, input);
      },
      extract: async (selected, input, signal, sourceId) => {
        if (selected.provider === "credits") {
          const source = { kind: "board_extract" as const, id: sourceId };
          const quote = await creditsClient.recoveryQuote(source, input) || await creditsClient.quote("board_extract", input, selected.model, selected.thinkingLevel);
          signal.throwIfAborted();
          const value = await creditsClient.analyze(quote.id, input, signal, source, quote.model);
          return { value, acknowledge: () => creditsClient.acknowledge(quote.id) };
        }
        const value = await analyzeWithSelectedProvider(boardExtractionInstructions, input, "board_extract", boardExtractionSchema,
          "The board links could not be read.", selected, signal);
        return { value };
      },
    });
    try {
      if (!await boardsStore.recoverOnStartup() && settings.boardsDatabasePath) await boardsStore.open(settings.boardsDatabasePath);
    } catch (error) { boards.error = error instanceof Error ? error.message : "The Boards database could not be opened."; }
    nativeTheme.themeSource = settings.appearance === "auto" || !settings.appearance ? "system" : settings.appearance;
    nativeTheme.on("updated", updateWindowAppearance);
    const downloadErrors = new Map<string, string>();
    const modelsChanged = () => {
      for (const model of modelDownloads?.list() || []) {
        if (model.status === "error" && model.error) {
          if (downloadErrors.get(model.id) !== model.error) logDiagnostic(`Model download failed (${model.id})`, model.error);
          downloadErrors.set(model.id, model.error);
        } else downloadErrors.delete(model.id);
      }
      mainWindow?.webContents.send("desktop:local-models-changed", state());
    };
    const platformFolder = `${process.platform === "darwin" ? "mac" : "win"}-${process.arch}`;
    const runtimeFolder = app.isPackaged ? path.join(process.resourcesPath, "local-runtime")
      : path.resolve(appRoot, "../build/llama", platformFolder);
    const localAppData: string | undefined = undefined;
    const modelsFolder = localModelFolder(app.getPath("userData"), process.platform, localAppData);
    if (!storeEdition) {
      await migrateModelFolder(path.join(profile.folder, "Models"), modelsFolder);

    }
    modelDownloads = new LocalModelDownloads(modelsFolder, { onChange: modelsChanged, licensesFolder: path.join(runtimeFolder, "model-licenses") });
    await modelDownloads.initialize();
    modelEngine = new LocalModelEngine({ downloads: modelDownloads, onChange: modelsChanged, onDiagnostic: logEvent,
      runtimeFolder,
      workerPath: path.join(appRoot, "local-runtime-worker.cjs") });
    if (!storeEdition) selfUpdater = new SelfUpdater({ folder: path.join(path.dirname(modelsFolder), "Updates"), platform: process.platform,
      executable: app.getPath("exe"), onChange: (download) => updates.setDownload(download) });
    registerProtocol();
    registerIpc();
    createMenu();
    createWindow();
    void modelEngine.detectHardware();
    if (!storeEdition) void updates.check();
    app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  }).catch((error) => { console.error("Could not start Zebby", error);
    logDiagnostic("Could not start the app", error);
    dialog.showErrorBox("Could not start Zebby", String(error)); app.quit(); });
  app.on("before-quit", (event) => {
    if (store?.status.dirty) {
      event.preventDefault();
      logEvent("Close deferred because database changes have not reached the selected file");
      dialog.showMessageBoxSync({ type: "warning", title: "Changes have not synced",
        message: "The latest changes are still on this computer.",
        detail: "Open Settings and use Retry save before closing the app.", buttons: ["Keep app open"] });
    } else if (!shuttingDown) {
      event.preventDefault(); shuttingDown = true;
      logEvent("Zebby closing; stopping model workers and flushing logs");
      analysisRequests.cancelAll();
      void Promise.all([boards?.stop(), modelDownloads?.pause(), modelEngine?.shutdown(), selfUpdater?.cancel()])
        .catch((error) => logDiagnostic("Could not stop the local model", error))
        .then(async () => { store?.close(); await boardsStore?.close(); await diagnosticLog.flush(); })
        .finally(() => app.quit());
    } else store?.close();
  });
}
