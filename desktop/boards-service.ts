import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AnalysisProvider } from "../shared/online-models";
import { boardModelContract, validatedBoardExtraction, type BoardExtractionInput, type BoardProgress, type BoardsState } from "../shared/boards";
import { BoardsStore } from "./boards-store";
import { scanBoard } from "./boards-scan";
import type { BoardReader } from "./board-browser";
import { writeProfileSettings } from "./settings-persistence";

export type BoardSelection = { provider: AnalysisProvider; model: string; thinkingLevel: string; ollamaUrl?: string };
type Dependencies<Selection extends BoardSelection> = { profile: string; selection(): Selection;
  reader(signal: AbortSignal): BoardReader;
  extract(selection: Selection, input: BoardExtractionInput, signal: AbortSignal, sourceId: string): Promise<{ value: unknown; acknowledge?: () => Promise<void> }>;
  acknowledgeCached?(selection: Selection, input: BoardExtractionInput, sourceId: string): Promise<void>;
  changed(): void;
};

export class BoardsService<Selection extends BoardSelection> {
  private pending = new Map<string, { progress: BoardProgress; abort: AbortController }>();
  private queue: Promise<unknown> = Promise.resolve();
  error = "";
  constructor(readonly store: BoardsStore, private dependencies: Dependencies<Selection>) {}
  get busy() { return this.pending.size > 0; }
  get state(): BoardsState { return { ...this.store.status, error: this.error, boards: this.store.list(),
    progress: [...this.pending.values()].map(entry => ({ ...entry.progress })) }; }
  changed() { this.dependencies.changed(); }
  assertIdle(id?: string) { if (id ? this.pending.has(id) : this.busy) throw new Error("Finish or cancel the board check before changing this selection."); }
  check(ids?: string[]) {
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 100 || ids.some(id => typeof id !== "string"))) throw new Error("Choose up to 100 saved boards.");
    if (this.store.status.dirty) throw new Error("Use Retry save for Boards before checking again.");
    const boards = ids ? ids.map(id => this.store.get(id)) : this.store.list();
    const selected = this.dependencies.selection(), generation = this.store.generation;
    this.error = "";
    for (const board of boards) {
      if (this.pending.has(board.id)) continue;
      const entry = { abort: new AbortController(), progress: { boardId: board.id, requestId: randomUUID(), phase: "queued" as BoardProgress["phase"], message: "Waiting to check" } };
      this.pending.set(board.id, entry);
      const run = this.queue.then(async () => {
        const signal = entry.abort.signal;
        const report = (message: string, phase: BoardProgress["phase"]) => {
          entry.progress = { ...entry.progress, message, phase }; this.changed();
        };
        try {
          signal.throwIfAborted();
          if (generation !== this.store.generation || this.store.get(board.id).revision !== board.revision) return;
          const cacheRoot = path.join(this.dependencies.profile, "board-extractions");
          await mkdir(cacheRoot, { recursive: true });
          const extract = async (input: BoardExtractionInput) => {
            const digest = createHash("sha256").update(JSON.stringify({ instructions: boardModelContract(input).instructions,
              input, provider: selected.provider, model: selected.model, thinking: selected.thinkingLevel,
              endpoint: selected.provider === "ollama" ? selected.ollamaUrl : "" })).digest("hex");
            const cachePath = path.join(cacheRoot, digest + ".json");
            const sourceId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
            let cached: unknown;
            try {
              cached = JSON.parse(await readFile(cachePath, "utf8"));
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
            let validated;
            try { if (cached) validated = validatedBoardExtraction(cached, input); }
            catch { /* Reject corrupted or obsolete cached results. */ }
            if (validated) {
              await this.dependencies.acknowledgeCached?.(selected, input, sourceId);
              return validated;
            }
            signal.throwIfAborted();
            const response = await this.dependencies.extract(selected, input, signal, sourceId);
            const result = validatedBoardExtraction(response.value, input);
            signal.throwIfAborted();
            // Persist a paid result before acknowledging it. Interrupted scans
            // can reuse this exact extraction without another paid request.
            await writeProfileSettings(cachePath, JSON.stringify(result));
            await response.acknowledge?.();
            return result;
          };
          const scan = await scanBoard({ url: board.url, reader: this.dependencies.reader(signal), extract, signal,
            instructions: board.instructions, knownMatches: board.instructions ? this.store.knownMatches(board.id, board.revision) : undefined,
            provider: selected.provider, model: selected.model, batchSize: selected.provider === "builtin" ? 4 : selected.provider === "ollama" ? 12 : 40,
            progress: report });
          signal.throwIfAborted(); report("Saving check", "saving");
          await this.store.complete(board.id, board.revision, generation, scan);
        } catch (error) {
          if (!signal.aborted) {
            const message = error instanceof Error ? error.message : "The board could not be checked. Try again.";
            try { await this.store.failed(board.id, board.revision, generation, message); }
            catch { this.error = message; }
          }
        } finally { this.pending.delete(board.id); this.changed(); }
      });
      this.queue = run.catch(error => { this.error = String(error); this.pending.delete(board.id); this.changed(); });
    }
    this.changed(); return this.state;
  }
  cancel(id: string) {
    const entry = this.pending.get(id);
    if (!entry || entry.progress.phase === "saving") return false;
    entry.abort.abort(new DOMException("Board check cancelled.", "AbortError")); return true;
  }
  async stop() { for (const id of this.pending.keys()) this.cancel(id); await this.queue; }
}
