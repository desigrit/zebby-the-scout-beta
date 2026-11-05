import { getLocalModel } from "./local-model-catalog.ts";
import { analyzeBasicLocal } from "./basic-local-analysis.ts";
import type { AnalysisProvider } from "../shared/online-models.ts";

export type AnalysisSelection = {
  provider: AnalysisProvider;
  ollamaUrl: string;
  ollamaModel: string;
  builtInModelId: string;
};
type Generate = (instructions: string, input: unknown, schema: Record<string, unknown>, maxTokens?: number) => Promise<Record<string, unknown>>;
type Providers = {
  ollama: (url: string, model: string, instructions: string, input: unknown, schema: Record<string, unknown>) => Promise<Record<string, unknown>>;
  openai: (instructions: string, input: unknown, name: string, schema: Record<string, unknown>, failure: string) => Promise<Record<string, unknown>>;
  anthropic?: (instructions: string, input: unknown, name: string, schema: Record<string, unknown>, failure: string) => Promise<Record<string, unknown>>;
  credits?: (instructions: string, input: unknown, name: string, schema: Record<string, unknown>, failure: string) => Promise<Record<string, unknown>>;
  ready: (id: string) => Promise<unknown>;
  local: (id: string, ...args: Parameters<Generate>) => ReturnType<Generate>;
};

export function publicAnalysisText(text: string) { return text.replace(/\u2014/g, "-"); }

// Choose one provider for the entire request. A local failure is reported to the
// user, never routed to a smaller model, a keyword scorer, or a cloud service.
export async function runSelectedAnalysis(selected: AnalysisSelection, providers: Providers,
  instructions: string, input: unknown, name: string, schema: Record<string, unknown>, failure: string) {
  if (selected.provider === "ollama") {
    return providers.ollama(selected.ollamaUrl, selected.ollamaModel, instructions, input, schema);
  }
  if (selected.provider === "openai") return providers.openai(instructions, input, name, schema, failure);
  if (selected.provider === "anthropic" || selected.provider === "credits") {
    const provider = providers[selected.provider];
    if (!provider) throw new Error("This analysis method is not configured.");
    return provider(instructions, input, name, schema, failure);
  }
  const model = getLocalModel(selected.builtInModelId);
  await providers.ready(model.id);
  if (model.basic && (name === "resume_plan" || name === "resume_match")) return analyzeBasicLocal(input as Record<string, unknown>, name === "resume_plan",
    (...args) => providers.local(model.id, ...args));
  return providers.local(model.id, instructions, input, schema);
}
