import type { WalletAccess } from "./wallet-access.ts";

export type AnalysisProvider = "ollama" | "builtin" | "openai" | "anthropic" | "credits";
export type AnalysisKind = "plan" | "match" | "resume" | "board_extract";
export const PRICE_VERSION = "2026-10-31-claude-credits";
export const DEFAULT_CREDIT_MODEL = "gpt-6.1-sol";
export const ASTRA_MODEL = "gpt-6-astra";
export const OPUS_MODEL = "claude-opus-5-5";
export const ASTRA_PACK_MESSAGE = "GPT-6 Astra and Claude Opus are included with a $20, $50 or $100 pack.";
export function creditModelNeedsPack(model: string) { return model === ASTRA_MODEL || model === OPUS_MODEL; }
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = typeof EFFORT_LEVELS[number];
export const CREDIT_THINKING_LEVELS = ["off", ...EFFORT_LEVELS] as const;
export type CreditThinkingLevel = typeof CREDIT_THINKING_LEVELS[number];
export type OnlineThinkingLevel = EffortLevel | "off" | "on";
// One credit represents $0.001 of provider usage. Costs use integer nanodollars.
export const NANODOLLARS_PER_CREDIT = 1_000_000;
export const ONLINE_MODELS = [
  { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", provider: "openai", input: 2000, cached: 100, output: 10000 },
  { id: "gpt-6-luna", name: "GPT-6 Luna", provider: "openai", input: 100, cached: 10, output: 500 },
  { id: "gpt-6-astra", name: "GPT-6 Astra", provider: "openai", input: 10000, cached: 1000, output: 50000 },
  { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", provider: "anthropic", input: 100, cached: 10, output: 500 },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", provider: "anthropic", input: 2000, cached: 100, output: 10000 },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", provider: "anthropic", input: 4000, cached: 200, output: 20000 },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "anthropic", input: 1000, cached: 100, output: 5000 },
] as const;
export type OnlineModel = typeof ONLINE_MODELS[number];
// Newest generation first within each provider. Same-release families retain a stable order.
export const CREDIT_MODELS = ONLINE_MODELS.filter((model) => model.id !== "claude-haiku-4-5-20251001");
// Rounded text baseline from a local audit of saved Plans. Provider reasoning was
// not retained, so keep the existing total output allowance as an explicit estimate.
export const CREDIT_ESTIMATE = { model: DEFAULT_CREDIT_MODEL, thinkingLevel: "high", input: 3600,
  visibleOutput: 500, thinkingAllowance: 7500, output: 8000 } as const;
export const CREDIT_ESTIMATE_MODELS = [DEFAULT_CREDIT_MODEL, "gpt-6-luna"] as const;
// Product planning estimates, independent of generation limits and settlement.
// Premium examples assume roughly 125 to 137 credits per completed analysis.
export const PREMIUM_ANALYSIS_ESTIMATES: Readonly<Record<number, number>> = { 500: 0, 3000: 22, 8000: 64, 16000: 121 };
export const CREDIT_ESTIMATE_DESCRIPTION = "Astra and Opus figures are rounded planning estimates of roughly 125 to 137 credits per analysis. Sol and Luna examples use 3,600 input tokens and 8,000 output tokens, including thinking, with input priced as cache writes. Actual usage varies by job, model and thinking level.";
export function creditEstimateThinkingLevel(modelId: string) { return creditModelNeedsPack(modelId) ? "medium" : "high"; }
export function estimatedAnalyses(credits: number, modelId: string = CREDIT_ESTIMATE.model) {
  const model = creditModel(modelId);
  if (creditModelNeedsPack(modelId) && Object.hasOwn(PREMIUM_ANALYSIS_ESTIMATES, credits)) return PREMIUM_ANALYSIS_ESTIMATES[credits];
  const output = creditEstimateThinkingLevel(modelId) === "medium" ? creditOutputLimit("plan", "medium") : CREDIT_ESTIMATE.output;
  const estimate = usageCost(model, { input: 0, cached: 0, cacheWrite: CREDIT_ESTIMATE.input, output });
  return Math.floor(credits * NANODOLLARS_PER_CREDIT / estimate);
}
export const CREDIT_PACKS = [
  { id: "starter", dollars: 5, credits: 500, analyses: estimatedAnalyses(500), astra: false },
  { id: "regular", dollars: 20, credits: 3000, analyses: estimatedAnalyses(3000), astra: true },
  { id: "plus", dollars: 50, credits: 8000, analyses: estimatedAnalyses(8000), astra: true },
  { id: "max", dollars: 100, credits: 16000, analyses: estimatedAnalyses(16000), astra: true },
] as const;
export type CreditPack = typeof CREDIT_PACKS[number];
export function onlineModel(id: string): OnlineModel {
  const model = ONLINE_MODELS.find((item) => item.id === id);
  if (!model) throw new Error("Choose an available online model.");
  return model;
}
export function creditModel(id: string): OnlineModel {
  const model = CREDIT_MODELS.find((item) => item.id === id);
  if (!model) throw new Error("Choose an available model for Zebby credits.");
  return model;
}
export function onlineThinking(model: OnlineModel) {
  if (model.id === "claude-haiku-4-5-20251001") return { values: ["off", "on"] as readonly OnlineThinkingLevel[], defaultValue: "off" as OnlineThinkingLevel };
  const values: readonly OnlineThinkingLevel[] = model.id === "gpt-6-luna" ? ["off", ...EFFORT_LEVELS] : EFFORT_LEVELS;
  return { values, defaultValue: (["claude-opus-5-5", "claude-haiku-5-5"].includes(model.id) ? "medium" : "high") as OnlineThinkingLevel };
}
export function validateOnlineThinking(model: OnlineModel, value?: string): OnlineThinkingLevel {
  const capability = onlineThinking(model), level = value ?? capability.defaultValue;
  if (!capability.values.includes(level as OnlineThinkingLevel)) throw new Error("Choose a thinking level supported by this model.");
  return level as OnlineThinkingLevel;
}
export function creditPack(id: string): CreditPack {
  const pack = CREDIT_PACKS.find((item) => item.id === id);
  if (!pack) throw new Error("Choose an available credit pack.");
  return pack;
}
// Input includes cache reads and excludes separately charged cache writes.
export type TokenUsage = { input: number; cached: number; output: number; cacheWrite?: number; cacheWrite5m?: number; cacheWrite1h?: number };
export function usageCost(model: OnlineModel, usage: TokenUsage): number {
  for (const value of Object.values(usage)) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("The provider returned invalid usage.");
  }
  if (usage.cached > usage.input) throw new Error("The provider returned invalid cached usage.");
  const written = (usage.cacheWrite || 0) + (usage.cacheWrite5m || 0) + (usage.cacheWrite1h || 0);
  const longContext = model.provider === "openai" && usage.input + written > 272000;
  const haikuLongContext = model.id === "claude-haiku-5-5" && usage.input + written > 100000;
  const inputCost = (usage.input - usage.cached) * model.input + usage.cached * model.cached
    + ((usage.cacheWrite || 0) + (usage.cacheWrite5m || 0)) * model.input * 1.25 + (usage.cacheWrite1h || 0) * model.input * 2;
  const cost = (inputCost * (longContext ? 2 : 1) + usage.output * model.output * (longContext ? 1.5 : 1)) * (haikuLongContext ? 5 : 1);
  if (!Number.isSafeInteger(cost)) throw new Error("The provider returned invalid usage cost.");
  return cost;
}
export function outputLimit(kind: AnalysisKind, thinkingLevel: OnlineThinkingLevel = "low") {
  const answer = kind === "resume" ? 10000 : kind === "plan" ? 6000 : 3000;
  // Thinking and the final structured answer share the provider's output budget.
  return thinkingLevel === "max" ? 64000 : thinkingLevel === "xhigh" ? 40000 : thinkingLevel === "high" ? 24000
    : thinkingLevel === "medium" ? 16000 : thinkingLevel === "on" ? answer + 4096 : answer;
}
export function creditOutputLimit(kind: AnalysisKind, thinkingLevel: OnlineThinkingLevel) {
  // Total output includes hidden reasoning. A match returns a score and a short
  // explanation; a Plan also returns keyword/theme lists and a rewritten summary.
  // These ceilings depend on the task and chosen effort, never the wallet balance.
  // Keep personal-key output limits separate until those callers opt into this policy.
  const limits = kind === "resume"
    ? { off: 8192, low: 10240, medium: 12288, high: 16384, xhigh: 28672, max: 53248, on: 12288 }
    : kind === "plan"
    ? { off: 4096, low: 6144, medium: 8192, high: 12288, xhigh: 24576, max: 49152, on: 8192 }
    : { off: 1024, low: 3072, medium: 6144, high: 8192, xhigh: 16384, max: 32768, on: 5120 };
  return limits[thinkingLevel];
}
export function maximumCost(model: OnlineModel, inputTokens: number, maxOutputTokens: number) {
  if (!Number.isSafeInteger(inputTokens) || inputTokens <= 0 || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new Error("Could not determine the analysis token budget.");
  }
  // Count the complete provider request, including instructions and JSON schema.
  // Reserve uncached/cache-write rates; settle the actual cache mix afterwards.
  return usageCost(model, { input: 0, cached: 0, cacheWrite: inputTokens, output: maxOutputTokens });
}
export function formatCredits(nanos: number) {
  return (nanos / NANODOLLARS_PER_CREDIT).toLocaleString(undefined, { maximumFractionDigits: 2 });
}
export type DailyCreditUsage = { date: string; count: number; cost: number };
export type Wallet = { balance: number; reserved: number; used: number; purchased: number; updatedAt: string; completedAnalyses?: number;
  dailyUsage?: DailyCreditUsage[];
  recent: { id: string; model: string; kind: string; cost: number; createdAt: string }[]; astraUnlocked?: boolean };
export type CreditsState = { available: boolean; signedIn: boolean; email: string; wallet: Wallet | null;
  stale: boolean; error: string; model: string; access: WalletAccess | null; recoverySaved: boolean; pendingConnection: boolean };
export type CreditQuote = { id: string; model: string; thinkingLevel?: CreditThinkingLevel; maximum: number; expiresAt: string;
  inputTokens?: number; outputTokens?: number; recovery?: boolean; pending?: boolean; cost?: number };
export type AnalysisSource = { kind: AnalysisKind; id: string };
export function quoteNeedsCredits(quote: CreditQuote, available: number) { return !quote.recovery && available < quote.maximum; }
export function creditReservationMessage(quote: Pick<CreditQuote, "model" | "maximum">, available: number) {
  return `${onlineModel(quote.model).name} needs ${formatCredits(quote.maximum)} credits available to start. You have ${formatCredits(Math.max(0, available))}. Only actual usage is charged.`;
}
