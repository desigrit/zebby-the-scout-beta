import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { needsServiceWakeup, waitForCreditsService } from "./credits-service-ready.ts";
import { walletStorageOrigin } from "../shared/credit-service.ts";
import { analysisFetch } from "./analysis-fetch.ts";
import { creditModel, DEFAULT_CREDIT_MODEL, CREDIT_THINKING_LEVELS, validateOnlineThinking, type AnalysisSource, type CreditQuote, type CreditsState, type Wallet, type AnalysisKind } from "../shared/online-models.ts";
import { deviceNameSchema, deviceTokenSchema, guestSessionSchema, pairingCodeSchema, pairingSchema, recoveryCodeSchema,
  walletAccessSchema, type WalletAccess, type WalletPairing } from "../shared/wallet-access.ts";
const integer = z.number().int().safe();
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((date) => {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date;
});
function walletTimestamp(value: string): bigint {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return BigInt(0);
  const fraction = value.match(/\.(\d+)/)?.[1] || "";
  return BigInt(Math.floor(milliseconds / 1000)) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, "0").slice(0, 6) || "0");
}
const walletSchema = z.object({ balance: integer, reserved: integer.nonnegative(), used: integer.nonnegative(),
  astraUnlocked: z.boolean().optional(), completedAnalyses: integer.nonnegative().optional(),
  dailyUsage: z.array(z.object({ date: daySchema, count: integer.nonnegative(), cost: integer.nonnegative() })).length(84)
    .refine((days) => days.every((day, index) => !index || Date.parse(day.date) - Date.parse(days[index - 1].date) === 86_400_000)).optional(),
  purchased: integer.nonnegative(), updatedAt: z.string(), recent: z.array(z.object({ id: z.string().uuid(),
    model: z.string(), kind: z.string(), cost: integer.nonnegative(), createdAt: z.string() })).max(10) });
const sessionSchema = z.object({ access_token: z.string().min(1).max(8192), refresh_token: z.string().min(1).max(8192),
  expires_at: z.number().optional(), expires_in: z.number().optional(), user: z.object({ email: z.string().email(), id: z.string().uuid() }) });
const pendingSchema = z.object({ quoteId: z.string().uuid(), requestId: z.string().uuid(), userId: z.string().uuid(), hash: z.string(),
  model: z.string(), expires: z.number(), source: z.object({ kind: z.enum(["plan", "match", "resume", "board_extract"]), id: z.string().uuid() }) });
const recoveredSchema = z.object({ status: z.enum(["reserved", "completed", "failed"]), result: z.record(z.unknown()).nullable(),
  model: z.string(), kind: z.enum(["plan", "match", "resume", "board_extract"]), cost: integer.nonnegative(), quoteId: z.string().uuid(), wallet: walletSchema });
type PendingRun = z.infer<typeof pendingSchema>;
const storedSessionSchema = z.object({ access: z.string().min(1).max(8192), refresh: z.string().min(1).max(8192), expires: z.number(),
  email: z.union([z.string().email(), z.literal("")]), id: z.string().uuid(), kind: z.enum(["guest", "account"]).default("account"), deviceId: z.string().uuid().optional() });
const candidateSchema = z.object({ token: deviceTokenSchema, name: deviceNameSchema, kind: z.enum(["guest", "restore", "connect", "legacy"]),
  intentHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), code: z.union([recoveryCodeSchema, pairingCodeSchema]).optional() })
  .refine((value) => !value.code || ["restore", "connect"].includes(value.kind) &&
    (value.kind === "restore" ? recoveryCodeSchema : pairingCodeSchema).safeParse(value.code).success &&
    value.intentHash === createHash("sha256").update(value.code).digest("hex"));
const recoverySchema = z.object({ code: recoveryCodeSchema, walletId: z.string().uuid(), version: z.string().uuid().nullable(), saved: z.boolean() });
// With no service origin, no request could have registered this pending guest.
// Keep its persisted credential when the first configured build supplies an origin.
const unconfiguredGuestSchema = z.object({ url: z.literal(""), session: z.null(), wallet: z.null(),
  pending: z.array(z.never()).max(0), recovery: z.null(), candidate: candidateSchema })
  .strict().refine((value) => value.candidate.kind === "guest" && !value.candidate.code && !value.candidate.intentHash);
type Session = z.infer<typeof storedSessionSchema>;
type Candidate = z.infer<typeof candidateSchema>;
type ClientOptions = { save: (value: string) => Promise<void>; onChange: () => void; fetcher?: typeof fetch; deviceName?: string };
class HttpError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status; } }
const hashInput = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
export class CreditsClient {
  private session: Session | null = null;
  private wallet: Wallet | null = null;
  private stale = true;
  private error = "";
  private generation = 0;
  private refreshing: { generation: number; promise: Promise<void> } | null = null;
  private walletRefresh: { generation: number; promise: Promise<void> } | null = null;
  private controllers = new Set<AbortController>();
  private pending = new Map<string, PendingRun>();
  private access: WalletAccess | null = null;
  private candidate: Candidate | null = null;
  private recovery: z.infer<typeof recoverySchema> | null = null;
  private accessWorking = false;
  private pairing: WalletPairing | null = null;
  private secretHistory: string[] = [];
  private unreadableStorage = false;
  private lastServiceResponse = 0;
  private serviceWarmup: { controller: AbortController; promise: Promise<void>; waiters: number } | null = null;
  readonly url: string;
  private options: ClientOptions;
  constructor(url: string, options: ClientOptions) {
    this.options = options;
    if (url) { const parsed = new URL(url); if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") throw new Error("The credits service URL must be an HTTPS origin."); this.url = parsed.origin; }
    else this.url = "";
  }
  restore(value: string) {
    try {
      const stored = JSON.parse(value);
      if (!this.url) return;
      if (walletStorageOrigin(stored.url) !== walletStorageOrigin(this.url)) {
        const unconfigured = unconfiguredGuestSchema.safeParse(stored);
        if (unconfigured.success) this.candidate = unconfigured.data.candidate;
        else this.restoreFailed();
        return;
      }
      this.session = stored.session ? storedSessionSchema.parse(stored.session) : null;
      this.wallet = this.session ? walletSchema.safeParse(stored.wallet).data || null : null;
      this.candidate = candidateSchema.safeParse(stored.candidate).data || null;
      if (stored.candidate && !this.candidate) this.restoreFailed();
      this.recovery = recoverySchema.safeParse(stored.recovery).data || null;
      for (const entry of Array.isArray(stored.pending) ? stored.pending.slice(0, 20) : []) {
        const item = pendingSchema.safeParse(entry);
        if (item.success && item.data.expires > Date.now()) this.pending.set(item.data.quoteId, item.data);
      }
    } catch { this.restoreFailed(); }
  }
  restoreFailed() { this.unreadableStorage = true; this.error = "Saved wallet access could not be read. Restore credits with your recovery code or connect this computer again."; }
  state(model: string): CreditsState { return { available: Boolean(this.url), signedIn: Boolean(this.session),
    email: this.session?.email || "", wallet: this.wallet, stale: this.stale, error: this.error, model, access: this.access,
    recoverySaved: Boolean(this.recovery?.saved && this.recovery.walletId === this.session?.id && this.access?.recoveryVersion === this.recovery.version),
    pendingConnection: Boolean(this.candidate) }; }
  secrets() { return [this.session?.access || "", this.session?.refresh || "", this.candidate?.token || "", this.candidate?.code || "",
    this.candidate?.kind === "connect" ? this.candidate.code?.replace(/(.{4})(.{4})/, "$1-$2") || "" : "", this.recovery?.code || "", this.pairing?.code || "",
    this.pairing?.code.replace(/(.{4})(.{4})/, "$1-$2") || "", ...this.secretHistory]; }
  private rememberSecret(value: string) { this.secretHistory.push(value); if (this.secretHistory.length > 16) this.secretHistory.shift(); }
  private checkGeneration(generation: number) { if (generation !== this.generation) throw new DOMException("The credit wallet changed.", "AbortError"); }
  private invalidate(clearPending = false) {
    this.generation++; for (const controller of this.controllers) controller.abort(); this.controllers.clear();
    this.session = null; this.wallet = null; this.stale = true; this.error = "";
    this.access = null; this.pairing = null;
    if (clearPending) this.pending.clear();
  }
  private async persist() {
    for (const [id, run] of this.pending) if (run.expires < Date.now()) this.pending.delete(id);
    await this.options.save(this.session || this.pending.size || this.candidate || this.recovery ? JSON.stringify({ url: walletStorageOrigin(this.url), session: this.session,
      wallet: this.wallet, pending: [...this.pending.values()], candidate: this.candidate, recovery: this.recovery }) : "");
  }
  // Public health only. Opening the purchase flow must not create a wallet or checkout.
  async warmService(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!this.url || !needsServiceWakeup(this.url, this.lastServiceResponse)) return;
    let warmup = this.serviceWarmup;
    if (!warmup || warmup.controller.signal.aborted) {
      const controller = new AbortController();
      const promise = waitForCreditsService(this.url, this.options.fetcher || fetch, controller.signal)
        .then(() => { this.lastServiceResponse = Date.now(); })
        .finally(() => { if (this.serviceWarmup?.controller === controller) this.serviceWarmup = null; });
      warmup = { controller, promise, waiters: 0 };
      this.serviceWarmup = warmup;
    }
    warmup.waiters++;
    let onAbort: (() => void) | undefined;
    try {
      await (signal ? Promise.race([warmup.promise, new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      })]) : warmup.promise);
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      // One cancelled request cannot stop another request or the purchase flow's warmup.
      if (--warmup.waiters === 0) {
        warmup.controller.abort();
        if (this.serviceWarmup === warmup) this.serviceWarmup = null;
      }
    }
  }
  private async request(path: string, body?: unknown, authenticated = true, signal?: AbortSignal, deviceToken?: string): Promise<unknown> {
    if (!this.url) throw new Error("Could not reach the credits service. Try again.");
    const generation = this.generation;
    if (authenticated) {
      if (!this.session) throw new Error("Buy credits, restore your wallet, or connect this computer in Settings.");
      if (this.session.kind === "account" && this.session.expires < Date.now() + 60000) {
        if (this.refreshing?.generation !== generation) {
          const promise = this.refreshSession(generation).finally(() => { if (this.refreshing?.generation === generation) this.refreshing = null; });
          this.refreshing = { generation, promise };
        }
        await this.refreshing.promise;
      }
      this.checkGeneration(generation);
    }
    const controller = new AbortController(); this.controllers.add(controller);
    try {
      const fetcher = this.options.fetcher || (path === "/v1/analysis" ? analysisFetch : fetch);
      const activeSignal = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
      if (needsServiceWakeup(this.url, this.lastServiceResponse)) {
        await this.warmService(activeSignal);
        this.checkGeneration(generation); activeSignal.throwIfAborted();
      }
      const response = await fetcher(this.url + path, { method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", ...((authenticated || deviceToken) ? { Authorization: `Bearer ${deviceToken || this.session!.access}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([activeSignal, AbortSignal.timeout(path === "/v1/analysis" ? 510000 : 20000)]) });
      let result: unknown;
      try { result = await response.json(); } catch { throw new Error("The credit service returned an unreadable response."); }
      this.checkGeneration(generation);
      this.lastServiceResponse = Date.now();
      if (!response.ok) {
        // Keep the credential and cached balance on authentication or network failures.
        // An automatic empty replacement wallet could strand a purchase.
        if (response.status === 401 && authenticated) { this.stale = true; this.error = "Restore credits or reconnect this computer in Settings."; this.options.onChange(); }
        const error = z.object({ error: z.string() }).safeParse(result);
        throw new HttpError(error.success ? error.data.error.slice(0, 400) : "The credit service is unavailable. Try again.", response.status);
      }
      return result;
    } finally { this.controllers.delete(controller); }
  }
  private async setSession(value: unknown, generation: number, expectedUser?: string) {
    this.checkGeneration(generation);
    const parsed = sessionSchema.parse(value);
    if (expectedUser && parsed.user.id !== expectedUser) throw new Error("The wallet identity changed. Restore credits or reconnect this computer.");
    this.session = { access: parsed.access_token, refresh: parsed.refresh_token,
      expires: parsed.expires_at ? parsed.expires_at * 1000 : Date.now() + (parsed.expires_in || 3600) * 1000,
      email: parsed.user.email, id: parsed.user.id, kind: "account" };
    for (const [id, run] of this.pending) if (run.userId !== parsed.user.id) this.pending.delete(id);
    await this.persist(); this.checkGeneration(generation);
  }
  private async refreshSession(generation: number) {
    const session = this.session!;
    try { await this.setSession(await this.request("/v1/auth/refresh", { refreshToken: session.refresh }, false), generation, session.id); }
    catch (error) {
      if (generation === this.generation && error instanceof HttpError && error.status === 401) { this.stale = true; this.error = "Restore credits or reconnect this computer in Settings."; this.options.onChange(); }
      throw error;
    }
  }
  async sendCode(email: string) { z.string().email().max(254).parse(email); await this.request("/v1/auth/send-code", { email }, false); }
  async verify(email: string, code: string) {
    this.invalidate(); const generation = this.generation;
    await this.persist(); this.options.onChange();
    await this.setSession(await this.request("/v1/auth/verify", { email, code }, false), generation);
    await this.refreshWallet();
  }
  async signOut() {
    const session = this.session; this.invalidate(true); this.candidate = null; this.recovery = null; await this.persist(); this.options.onChange();
    // Revoke this device's old refresh session without allowing its reply to change a newer account.
    if (session && this.url) await (this.options.fetcher || fetch)(this.url + "/v1/auth/logout", { method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access}` }, body: "{}", signal: AbortSignal.timeout(10000) }).catch(() => undefined);
  }
  async refreshWallet() {
    if (this.candidate && !this.accessWorking) await this.resumeConnection();
    if (!this.session) return;
    const generation = this.generation;
    if (this.walletRefresh?.generation === generation) return this.walletRefresh.promise;
    const operation = async () => {
      try { const wallet = walletSchema.parse(await this.request("/v1/wallet")); this.checkGeneration(generation);
        // A background refresh may arrive after a newer settlement or checkout.
        // Keep that newer wallet instead of restoring the earlier balance.
        if (this.wallet && walletTimestamp(wallet.updatedAt) < walletTimestamp(this.wallet.updatedAt)) return;
        this.wallet = wallet; this.stale = false; this.error = ""; await this.persist(); }
      catch (error) { if (generation === this.generation) { this.stale = true; this.error = error instanceof Error ? error.message : "Could not refresh credits."; } throw error; }
      finally { if (generation === this.generation) this.options.onChange(); }
    };
    const promise = operation().finally(() => { if (this.walletRefresh?.generation === generation) this.walletRefresh = null; });
    this.walletRefresh = { generation, promise }; return promise;
  }
  private async accessAction<T>(operation: () => Promise<T>) {
    if (this.accessWorking) throw new Error("A wallet connection is already being updated. Try again shortly.");
    this.accessWorking = true;
    try { return await operation(); }
    finally { this.accessWorking = false; this.options.onChange(); }
  }
  private async acceptConnection(candidate: Candidate, value: unknown) {
    const next = guestSessionSchema.parse(value);
    const previous = { session: this.session, wallet: this.wallet, access: this.access, pending: new Map(this.pending) };
    this.generation++;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.session = { id: next.walletId, deviceId: next.deviceId, access: candidate.token, refresh: candidate.token,
      expires: Number.MAX_SAFE_INTEGER, email: "", kind: "guest" };
    if (previous.session?.id !== next.walletId) { this.wallet = null; this.access = null; }
    for (const [id, run] of this.pending) if (run.userId !== next.walletId) this.pending.delete(id);
    this.stale = true; this.error = ""; this.candidate = null;
    this.unreadableStorage = false;
    try { await this.persist(); }
    catch (error) {
      this.session = previous.session; this.wallet = previous.wallet; this.access = previous.access; this.pending = previous.pending;
      this.candidate = candidate;
      throw error;
    }
  }
  private async resolveCandidate() {
    const candidate = this.candidate;
    if (!candidate) return false;
    try {
      const result = await this.request("/v1/wallet/session", undefined, false, undefined, candidate.token);
      await this.acceptConnection(candidate, result);
      return true;
    } catch (error) { if (error instanceof HttpError && error.status === 401) return false; throw error; }
  }
  private async resumeConnection() {
    return this.accessAction(async () => {
      const candidate = this.candidate;
      if (!candidate) return false;
      // Older pending records can be recovered by token, but never rebound to a new code.
      if (["restore", "connect"].includes(candidate.kind) && !candidate.code) return this.resolveCandidate();
      await this.connect(candidate.kind, candidate.code); return true;
    });
  }
  private async connect(kind: Candidate["kind"], code?: string) {
    const intentHash = code ? createHash("sha256").update(code).digest("hex") : undefined;
    if (this.candidate && (this.candidate.kind !== kind || this.candidate.intentHash !== intentHash)) {
      throw new Error("A different wallet connection is pending. Refresh balance to finish it before entering another code.");
    }
    if (await this.resolveCandidate()) return;
    if (!this.candidate) {
      const candidate: Candidate = { token: "zby_device_" + randomBytes(32).toString("hex"),
        kind, name: deviceNameSchema.parse(this.options.deviceName || "This computer"), ...(code ? { code, intentHash } : {}) };
      this.candidate = candidate;
      // Persist the new credential before the server can link or consume a code.
      try { await this.persist(); } catch (error) { this.candidate = null; throw error; }
    }
    const candidate = this.candidate;
    try {
      const value = await this.request(kind === "legacy" ? "/v1/wallet/device" : "/v1/wallet/" + kind,
        { deviceToken: candidate.token, name: candidate.name, ...(code ? { code } : {}) }, kind === "legacy");
      await this.acceptConnection(candidate, value);
    } catch (error) {
      // A definitive validation failure never committed a link. Transport failures
      // retain the encrypted candidate so a restart can find the linked wallet.
      if (error instanceof HttpError && error.status === 400) { this.candidate = null; await this.persist(); }
      throw error;
    }
  }
  private async ensureGuest() {
    if (this.unreadableStorage && !this.session && !this.candidate) throw new Error(this.error);
    if (this.session?.kind === "guest" && !this.candidate) return;
    if (this.candidate) await this.resumeConnection();
    else await this.accessAction(() => this.connect(this.session ? "legacy" : "guest"));
  }
  async refreshAccess(): Promise<WalletAccess> {
    await this.ensureGuest();
    const generation = this.generation;
    const access = walletAccessSchema.parse(await this.request("/v1/wallet/access"));
    this.checkGeneration(generation); this.access = access; this.options.onChange(); return access;
  }
  async connectWallet(kind: "restore" | "connect", suppliedCode: string) {
    this.rememberSecret(suppliedCode);
    const code = (kind === "restore" ? recoveryCodeSchema : pairingCodeSchema).parse(suppliedCode);
    this.rememberSecret(code);
    if (this.session && this.wallet?.purchased) {
      const access = walletAccessSchema.parse(await this.request("/v1/wallet/access"));
      if (!access.hasRecoveryCode) throw new Error("Save a recovery code for your current wallet before switching wallets.");
      if (this.recovery?.walletId === this.session.id && !this.recovery.saved &&
        (this.recovery.version === null || this.recovery.version === access.recoveryVersion)) {
        throw new Error("Save your current wallet's recovery code to a file before switching wallets.");
      }
    }
    await this.accessAction(() => this.connect(kind, code));
    await this.refreshWallet(); await this.refreshAccess();
  }
  hasCurrentRecoveryCode() {
    return Boolean(this.recovery && this.recovery.walletId === this.session?.id &&
      (this.recovery.version === null || this.recovery.version === this.access?.recoveryVersion));
  }
  async recoveryCode(rotate = false) {
    await this.refreshAccess();
    return this.accessAction(async () => {
      if (!rotate && this.hasCurrentRecoveryCode() && this.recovery?.version) return this.recovery.code;
      if (rotate || !this.hasCurrentRecoveryCode()) {
        const previous = this.recovery;
        this.recovery = { walletId: this.session!.id, code: "ZEBBY-" + randomBytes(20).toString("hex").toUpperCase().match(/.{8}/g)!.join("-"), version: null, saved: false };
        try { await this.persist(); } catch (error) { this.recovery = previous; throw error; }
      }
      const result = z.object({ version: z.string().uuid() }).parse(await this.request("/v1/wallet/recovery", { code: this.recovery!.code }));
      this.recovery!.version = result.version;
      if (this.access) this.access = { ...this.access, hasRecoveryCode: true, recoveryVersion: result.version };
      await this.persist(); return this.recovery!.code;
    });
  }
  async markRecoverySaved() {
    if (!this.recovery?.version || this.recovery.walletId !== this.session?.id) throw new Error("Save your current wallet's recovery code first.");
    this.recovery.saved = true; await this.persist(); this.options.onChange();
  }
  async startPairing() {
    await this.ensureGuest();
    const value = pairingSchema.parse(await this.request("/v1/wallet/pairing", {}));
    this.pairing = value; this.rememberSecret(value.code); return value;
  }
  async cancelPairing() {
    if (!this.pairing) return;
    const pairing = this.pairing;
    await this.request("/v1/wallet/pairing/cancel", { code: pairing.code });
    if (this.pairing === pairing) this.pairing = null;
  }
  async removeDevice(id: string) {
    z.string().uuid().parse(id);
    await this.request("/v1/wallet/devices/" + id + "/remove", {}); await this.refreshAccess();
  }
  async checkout(pack: string) {
    await this.ensureGuest();
    const generation = this.generation;
    const result = z.object({ id: z.string().regex(/^cs_[a-zA-Z0-9_]+$/), url: z.string().url(), mode: z.enum(["test", "live"]) })
      .parse(await this.request("/v1/checkout", { pack, requestId: randomUUID() })); this.checkGeneration(generation);
    const url = new URL(result.url);
    if (url.protocol !== "https:" || url.hostname !== "checkout.stripe.com" || url.username || url.password) throw new Error("The payment provider returned an invalid checkout link.");
    return result;
  }
  async checkoutStatus(id: string) {
    if (!/^cs_[a-zA-Z0-9_]+$/.test(id)) throw new Error("Invalid checkout session.");
    const generation = this.generation;
    const result = z.object({ status: z.enum(["paid", "pending", "expired"]), wallet: walletSchema.optional() }).parse(await this.request("/v1/checkout/" + id));
    this.checkGeneration(generation);
    if (result.status === "paid") { this.wallet = walletSchema.parse(result.wallet); this.stale = false; this.error = ""; await this.persist(); this.options.onChange(); }
    return result.status;
  }
  async quote(kind: AnalysisKind, input: unknown, model: string, thinkingLevel?: string): Promise<CreditQuote> {
    const level = validateOnlineThinking(creditModel(model), thinkingLevel);
    const quote = z.object({ id: z.string().uuid(), model: z.string(), thinkingLevel: z.enum(CREDIT_THINKING_LEVELS), maximum: integer.positive(), expiresAt: z.string(),
      inputTokens: integer.positive().optional(), outputTokens: integer.positive().optional() })
      .parse(await this.request("/v1/quotes", { kind, input, model, thinkingLevel: level }));
    if (quote.model !== model || quote.thinkingLevel !== level) throw new Error("The service returned a different model or thinking level. Request a fresh quote.");
    return quote;
  }
  private async inspect(run: PendingRun) {
    const generation = this.generation;
    const result = recoveredSchema.parse(await this.request("/v1/analyses/" + run.requestId));
    this.checkGeneration(generation);
    if (result.quoteId !== run.quoteId || result.model !== run.model) throw new Error("The recovered analysis does not match this job.");
    this.wallet = result.wallet; this.stale = false; this.error = ""; await this.persist(); this.options.onChange();
    return result;
  }
  async recoveryQuote(source: AnalysisSource, input: unknown): Promise<CreditQuote | null> {
    const hash = hashInput(input);
    const run = [...this.pending.values()].find((item) => item.userId === this.session?.id && item.source.id === source.id && item.source.kind === source.kind && item.hash === hash);
    if (!run) return null;
    try {
      const result = await this.inspect(run);
      if (result.status === "failed" || result.status === "completed" && !result.result) { await this.acknowledge(run.quoteId); return null; }
      return { id: run.quoteId, model: run.model, maximum: 0, expiresAt: new Date(run.expires).toISOString(),
        recovery: true, pending: result.status === "reserved", cost: result.cost };
    } catch (error) { if (error instanceof HttpError && error.status === 404) { await this.acknowledge(run.quoteId); return null; } throw error; }
  }
  async acknowledge(quoteId: string) { this.pending.delete(quoteId); await this.persist(); }
  async acknowledgeCachedSource(source: AnalysisSource, input: unknown) {
    const hash = hashInput(input);
    for (const [id, run] of this.pending) if (run.userId === this.session?.id && run.source.kind === source.kind &&
        run.source.id === source.id && run.hash === hash) this.pending.delete(id);
    await this.persist();
  }
  async analyze(quoteId: string, input: unknown, signal: AbortSignal, source?: AnalysisSource, model = DEFAULT_CREDIT_MODEL) {
    z.string().uuid().parse(quoteId);
    const generation = this.generation, hash = hashInput(input);
    let run = this.pending.get(quoteId);
    if (run && (run.userId !== this.session?.id || run.hash !== hash)) throw new Error("This analysis belongs to different source data or another wallet.");
    if (!run) {
      if (!this.session) throw new Error("Connect this computer to your credits in Settings.");
      if (this.pending.size >= 20) throw new Error("Finish or recover your pending analyses first.");
      run = { quoteId, requestId: randomUUID(), userId: this.session.id, hash, model,
        expires: Date.now() + 24 * 3600000, source: source || { kind: "match", id: quoteId } };
      this.pending.set(quoteId, run); await this.persist();
    }
    this.checkGeneration(generation); signal.throwIfAborted();
    try {
      const body = { quoteId, requestId: run.requestId, input };
      let response: { result: Record<string, unknown>; wallet: Wallet };
      try { response = z.object({ result: z.record(z.unknown()), wallet: walletSchema }).parse(await this.request("/v1/analysis", body, true, signal)); }
      catch (error) {
        this.checkGeneration(generation); signal.throwIfAborted();
        // A lost reply may follow a successful settlement. Inspect, never create another paid run.
        const recovered = await this.inspect(run).catch(() => null);
        this.checkGeneration(generation); signal.throwIfAborted();
        if (recovered?.status === "completed" && recovered.result) response = { result: recovered.result, wallet: recovered.wallet };
        else { if (recovered?.status === "failed") await this.acknowledge(quoteId); throw error; }
      }
      this.checkGeneration(generation); signal.throwIfAborted();
      this.wallet = response.wallet; this.stale = false; this.error = ""; await this.persist(); this.options.onChange();
      // Main acknowledges only after the result has been saved to the selected database.
      return response.result;
    } finally { if (generation === this.generation) void this.refreshWallet().catch(() => undefined); }
  }
}
