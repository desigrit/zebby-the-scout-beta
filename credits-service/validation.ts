import { z } from "zod";
import type { AnalysisKind } from "../shared/online-models.ts";
import { resumeBlockSchema, tailoredResultSchema, applyResumeEdits } from "../shared/tailored-resume.ts";
import { boardExtractionInput, validatedBoardExtraction } from "../shared/boards.ts";
export const analysisInput = z.object({ resumeText: z.string().min(30).max(120000), jobDescription: z.string().min(80).max(80000),
  company: z.string().max(300).default(""), title: z.string().max(500).default(""),
  currentCvOverview: z.string().max(12000).default(""), url: z.string().max(2000).default(""),
  team: z.string().max(1000).default(""), locations: z.string().max(4000).default("") }).strict();
const recommendation = z.object({ text: z.string().min(1).max(1000), importance: z.number().int().min(0).max(100) }).strict();
const match = z.object({ score: z.number().int().min(0).max(100), explanation: z.string().min(1).max(8000) }).strict();
const plan = match.extend({ keywords: z.array(recommendation.extend({ text: z.string().min(1).max(200) })).min(6).max(20),
  themes: z.array(recommendation).min(5).max(6), overview: z.string().min(1).max(16000), overviewRationale: z.string().min(1).max(8000) });
export function validateInput(value: unknown, kind: AnalysisKind) {
  if (kind === "board_extract") return boardExtractionInput.parse(value);
  if (kind === "resume") return analysisInput.extend({
    resumeBlocks: z.array(resumeBlockSchema).min(1).max(800), suggestedSummary: z.string().max(20000).default(""),
    keywords: z.array(z.string().max(200)).max(100), themes: z.array(z.string().max(1000)).max(100),
  }).superRefine((input, ctx) => {
    if (new Set(input.resumeBlocks.map(block => block.id)).size !== input.resumeBlocks.length ||
        input.resumeBlocks.reduce((sum, block) => sum + block.text.length, 0) > 60000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid resume blocks." });
    }
  }).parse(value);
  return (kind === "plan" ? analysisInput.extend({ jobDescription: z.string().trim().min(100).max(80000) }) : analysisInput).parse(value);
}
export function validateResult(value: unknown, kind: AnalysisKind, input?: unknown) {
  if (kind === "board_extract") return validatedBoardExtraction(value, boardExtractionInput.parse(input));
  const result = (kind === "resume" ? tailoredResultSchema : kind === "plan" ? plan : match).parse(value);
  if (kind === "resume") {
    const source = validateInput(input, "resume");
    if (!("resumeBlocks" in source)) throw new Error("Resume source is missing.");
    applyResumeEdits(z.array(resumeBlockSchema).parse(source.resumeBlocks), result);
  }
  // Sanitize all model strings before they appear in product surfaces.
  return JSON.parse(JSON.stringify(result).replace(/\u2014/g, "-")) as Record<string, unknown>;
}
