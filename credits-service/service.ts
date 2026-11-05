import { createHash, randomUUID } from "node:crypto";
import type { ServiceConfig } from "./config.ts";
import { CREDIT_PACKS, CREDIT_MODELS, CREDIT_THINKING_LEVELS, PRICE_VERSION, NANODOLLARS_PER_CREDIT, creditPack, creditModel, onlineModel,
  maximumCost, creditOutputLimit, creditReservationMessage, usageCost, validateOnlineThinking, creditModelNeedsPack, ASTRA_PACK_MESSAGE, type Wallet } from "../shared/online-models.ts";
import { planInstructions, planSchema, matchInstructions, matchSchema } from "../desktop/analysis-contracts.ts";
import { tailoringInstructions, tailoringSchema } from "../shared/tailored-resume.ts";
import { onlineAnalysis } from "../desktop/online-analysis.ts";
import { countOpenAIAnalysisInput } from "../desktop/openai-request.ts";
import { countAnthropicAnalysisInput } from "../desktop/anthropic-request.ts";
import { validateInput, validateResult } from "./validation.ts";
import { stripeRequest, verifyStripeEvent } from "./stripe.ts";
import { ServiceError } from "./errors.ts";
import { createWalletAccess } from "./wallet-access.ts";
import { createWalletUsage } from "./wallet-usage.ts";
import { z } from "zod";
import { boardExtractionInstructions, boardExtractionSchema } from "../shared/boards.ts";

const uuid = z.string().uuid();
const kindSchema = z.enum(["plan", "match", "resume", "board_extract"]);
function contract(kind: "plan" | "match" | "resume" | "board_extract") {
  if (kind === "board_extract") return { instructions: boardExtractionInstructions, schema: boardExtractionSchema, name: "board_extract" };
  return kind === "resume" ? { instructions: tailoringInstructions, schema: tailoringSchema, name: "tailored_resume" }
    : kind === "plan" ? { instructions: planInstructions, schema: planSchema, name: "resume_plan" }
    : { instructions: matchInstructions, schema: matchSchema, name: "resume_match" };
}
type PurchaseRow = { id: string; user_id: string; pack: string; cents: number; session_id: string | null; paid: boolean };
type QuoteRow = { id: string; kind: "plan" | "match" | "resume" | "board_extract"; model: string; thinking_level: string; price_version: string;
  input_tokens: number; output_limit: number; maximum: number };
type RunRow = { status: "reserved" | "completed" | "failed"; fresh?: boolean; result?: Record<string, unknown> | null;
  id: string; quote_id: string; model: string; kind: "plan" | "match" | "resume" | "board_extract"; cost: number };
const stripeCheckout = z.object({ id: z.string().regex(/^cs_[a-zA-Z0-9_]+$/), url: z.string().url() });
const paidSession = z.object({ id: z.string(), payment_status: z.string(), currency: z.string(), amount_subtotal: z.number().int(),
  client_reference_id: uuid, payment_intent: z.string().startsWith("pi_"), metadata: z.object({ user_id: uuid, purchase_id: uuid, pack: z.string() }) });
export { ServiceError } from "./errors.ts";
export type Dependencies = { fetcher?: typeof fetch; now?: () => number };
export function createService(config: ServiceConfig, dependencies: Dependencies = {}) {
  function allowBoards(kind: string, walletId: string) {
    if (kind === "board_extract" && !config.boardsWalletIds?.includes(walletId)) {
      throw new ServiceError("Boards checks with Zebby credits are not enabled for this wallet.", 403);
    }
  }
  const send = dependencies.fetcher || fetch, now = dependencies.now || Date.now;
  const limits = new Map<string, { count: number; until: number }>();
  function rateLimit(key: string, maximum: number, duration = 60000) {
    if (limits.size > 10000) for (const [id, value] of limits) if (value.until < now()) limits.delete(id);
    if (limits.size > 20000) throw new ServiceError("Please try again shortly.", 429);
    const previous = limits.get(key);
    const value = !previous || previous.until <= now() ? { count: 0, until: now() + duration } : previous;
    value.count++; limits.set(key, value);
    if (value.count > maximum) throw new ServiceError("Please try again shortly.", 429);
  }
  async function supabase<T = unknown>(path: string, options: RequestInit = {}, token = config.supabaseKey): Promise<T> {
    const response = await send(config.supabaseUrl + path, { ...options, headers: { apikey: config.supabaseKey,
      Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...options.headers },
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    if (!response.ok) {
      if (path === "/rest/v1/rpc/zebby_reserve") {
        // Translate only known ledger rejections; never expose raw SQL errors.
        const error = await response.json().catch(() => null) as { message?: string } | null;
        if (error?.message === "Not enough credits for this analysis") throw new ServiceError("Not enough credits for this analysis.", 402);
        if (error?.message === ASTRA_PACK_MESSAGE.replace(/\.$/, "")) throw new ServiceError(ASTRA_PACK_MESSAGE, 403);
      }
      throw new ServiceError(path.startsWith("/auth/") ? "Existing wallet access could not be refreshed. Restore credits or reconnect this computer." : "The credit service could not complete this request.", path.startsWith("/auth/") ? 401 : 503);
    }
    if (response.status === 204) return null as T;
    return response.json() as Promise<T>;
  }
  async function rpc<T = unknown>(name: string, value: unknown, signal?: AbortSignal) { return supabase<T>(`/rest/v1/rpc/zebby_${name}`, { method: "POST", body: JSON.stringify(value), signal }); }
  const access = createWalletAccess({ rpc, rateLimit });
  const enrichWalletUsage = createWalletUsage({ url: config.supabaseUrl, key: config.supabaseKey, fetcher: send, now,
    onFailure: () => console.warn("Credit activity is temporarily unavailable; wallet balance is unchanged.") });
  async function rows<T>(table: string, query: string) { return supabase<T[]>(`/rest/v1/zebby_${table}?${query}`); }
  async function insert<T>(table: string, value: unknown) { return supabase<T[]>(`/rest/v1/zebby_${table}`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(value) }); }
  async function user(token: string) {
    if (token.startsWith("zby_device_")) return access.authenticate(token);
    if (!token || token.length > 8192) throw new ServiceError("Connect this computer to a credit wallet.", 401);
    const account = await supabase<{ id: string; email: string; email_confirmed_at: string }>("/auth/v1/user", {}, token);
    if (!uuid.safeParse(account.id).success || !account.email || !account.email_confirmed_at) throw new ServiceError("Restore credits or reconnect this computer.", 401);
    return { id: account.id as string, email: account.email as string };
  }
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const providerKey = (model: string) => onlineModel(model).provider === "openai" ? config.openaiKey : config.anthropicKey;
  function configuredModel(id: string) { const model = creditModel(id); if (!providerKey(id)) throw new ServiceError("This online provider is not available yet.", 503); return model; }
  async function webhook(raw: Buffer, signature: string) {
    let event: { id: string; livemode: boolean; type: string; data: { object?: unknown } };
    try { event = z.object({ id: z.string(), livemode: z.boolean(), type: z.string(), data: z.object({ object: z.unknown() }) })
      .parse(verifyStripeEvent(raw, signature, config.stripeWebhookSecret, now())); }
    catch { throw new ServiceError("Invalid webhook signature.", 400); }
    if (event.livemode !== config.live) throw new ServiceError("Webhook mode does not match the service.");
    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
      if (z.object({ payment_status: z.string() }).parse(event.data.object).payment_status !== "paid") return { received: true };
      const object = paidSession.parse(event.data.object);
      if (object.payment_status !== "paid") return { received: true };
      const id = uuid.parse(object.metadata?.purchase_id);
      const [purchase] = await rows<PurchaseRow>("purchases", `id=eq.${id}&select=*`);
      if (!purchase || object.currency !== "usd" || object.amount_subtotal !== purchase.cents || object.client_reference_id !== purchase.user_id
        || object.metadata.user_id !== purchase.user_id || object.metadata.pack !== purchase.pack || object.id !== purchase.session_id) throw new ServiceError("Payment does not match the purchase.");
      await rpc("payment", { p_event: event.id, p_purchase: id, p_session: object.id,
        p_payment: z.string().startsWith("pi_").parse(object.payment_intent), p_cents: object.amount_subtotal });
    } else if (event.type === "charge.refunded") {
      const object = z.object({ payment_intent: z.string().startsWith("pi_"), amount_refunded: z.number().int().nonnegative(), disputed: z.boolean() }).parse(event.data.object);
      await rpc("reverse", { p_event: event.id, p_payment: z.string().startsWith("pi_").parse(object.payment_intent),
        p_refunded: z.number().int().nonnegative().parse(object.amount_refunded), p_disputed: Boolean(object.disputed) });
    } else if (["charge.dispute.created", "charge.dispute.closed"].includes(event.type)) {
      const object = z.object({ charge: z.string().startsWith("ch_"), status: z.string() }).parse(event.data.object);
      const charge = z.object({ payment_intent: z.string().startsWith("pi_"), amount_refunded: z.number().int().nonnegative() })
        .parse(await stripeRequest(config.stripeKey, `charges/${encodeURIComponent(object.charge)}`, undefined, undefined, send));
      await rpc("reverse", { p_event: event.id, p_payment: z.string().startsWith("pi_").parse(charge.payment_intent),
        p_refunded: charge.amount_refunded, p_disputed: event.type === "charge.dispute.created" || object.status !== "won" });
    }
    return { received: true };
  }
  async function handle(method: string, path: string, body: unknown, token: string, signal: AbortSignal, ip = "unknown") {
    rateLimit("ip:" + ip, 120);
    if (method === "GET" && path === "/health") return { ok: true, mode: config.live ? "live" : "test" };
    if (method === "GET" && path === "/v1/catalog") return { packs: CREDIT_PACKS, models: CREDIT_MODELS,
      priceVersion: PRICE_VERSION, mode: config.live ? "live" : "test" };
    if (method === "POST" && path === "/v1/auth/refresh") {
      const value = z.object({ refreshToken: z.string().min(1).max(8192) }).strict().parse(body);
      return supabase("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: value.refreshToken }) });
    }
    if (method === "POST" && ["/v1/wallet/guest", "/v1/wallet/connect", "/v1/wallet/restore"].includes(path)) return access.connect(path, body, ip);
    const account = await user(token);
    rateLimit("user:" + account.id, 60);
    const managed = await access.manage(method, path, body, account);
    if (managed !== undefined) return managed;
    if (method === "POST" && path === "/v1/auth/logout") { await supabase("/auth/v1/logout?scope=local", { method: "POST" }, token); return { signedOut: true }; }
    if (method === "GET" && path === "/v1/wallet") {
      const readWallet = (requestSignal: AbortSignal) => rpc<Wallet>("wallet", { p_user: account.id }, requestSignal);
      return enrichWalletUsage(account.id, await readWallet(signal), readWallet, signal);
    }
    if (method === "GET" && /^\/v1\/analyses\/[\da-f-]{36}$/i.test(path)) {
      const id = uuid.parse(path.split("/").at(-1));
      const [run] = await rows<RunRow>("runs", `id=eq.${id}&user_id=eq.${account.id}&select=*`);
      if (!run) throw new ServiceError("Analysis not found.", 404);
      allowBoards(run.kind, account.id);
      return { status: run.status, result: run.result, model: run.model, kind: run.kind, cost: run.cost,
        quoteId: run.quote_id, wallet: await rpc("wallet", { p_user: account.id }) };
    }
    if (method === "POST" && path === "/v1/checkout") {
      const value = z.object({ pack: z.string(), requestId: uuid }).strict().parse(body), pack = creditPack(value.pack);
      rateLimit("checkout:" + account.id, 10, 15 * 60000);
      let [purchase] = await rows<PurchaseRow>("purchases", `id=eq.${value.requestId}&select=*`);
      if (purchase && (purchase.user_id !== account.id || purchase.pack !== pack.id)) throw new ServiceError("This checkout request cannot be reused.");
      if (!purchase) [purchase] = await insert<PurchaseRow>("purchases", { id: value.requestId, user_id: account.id, pack: pack.id,
        cents: pack.dollars * 100, amount: pack.credits * NANODOLLARS_PER_CREDIT });
      const fields = new URLSearchParams({ mode: "payment", customer_creation: "if_required", client_reference_id: account.id,
        success_url: config.publicUrl + "/checkout/return?session_id={CHECKOUT_SESSION_ID}", cancel_url: config.publicUrl + "/checkout/cancel",
        "metadata[purchase_id]": purchase.id, "metadata[user_id]": account.id, "metadata[pack]": pack.id,
        "payment_intent_data[metadata][purchase_id]": purchase.id, "payment_intent_data[metadata][user_id]": account.id,
        "line_items[0][quantity]": "1", "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": String(pack.dollars * 100),
        "line_items[0][price_data][product_data][name]": `Zebby, ${pack.credits.toLocaleString("en-US")} credits` });
      if (account.email) fields.set("customer_email", account.email);
      const session = stripeCheckout.parse(await stripeRequest(config.stripeKey, "checkout/sessions", fields, purchase.id, send));
      await supabase(`/rest/v1/zebby_purchases?id=eq.${purchase.id}`, { method: "PATCH", body: JSON.stringify({ session_id: session.id }) });
      return { id: session.id, url: session.url, mode: config.live ? "live" : "test" };
    }
    if (method === "GET" && /^\/v1\/checkout\/cs_[a-zA-Z0-9_]+$/.test(path)) {
      const id = path.split("/").at(-1)!;
      const [purchase] = await rows<Pick<PurchaseRow, "paid">>("purchases", `session_id=eq.${id}&user_id=eq.${account.id}&select=paid`);
      if (!purchase) throw new ServiceError("Checkout not found.", 404);
      // A redirect or client success message never awards credits.
      if (purchase.paid) return { status: "paid", wallet: await rpc("wallet", { p_user: account.id }) };
      const session = z.object({ status: z.string() }).parse(await stripeRequest(config.stripeKey, `checkout/sessions/${id}`, undefined, undefined, send));
      return { status: session.status === "expired" ? "expired" : "pending" };
    }
    if (method === "POST" && path === "/v1/quotes") {
      const value = z.object({ model: z.string(), kind: kindSchema, thinkingLevel: z.enum(CREDIT_THINKING_LEVELS).default("high"), input: z.unknown() }).strict().parse(body);
      allowBoards(value.kind, account.id);
      const model = configuredModel(value.model), input = validateInput(value.input, value.kind);
      const thinkingLevel = validateOnlineThinking(model, value.thinkingLevel);
      if (creditModelNeedsPack(model.id)) {
        const wallet = await rpc<Wallet>("wallet", { p_user: account.id });
        if (!wallet.astraUnlocked) throw new ServiceError(ASTRA_PACK_MESSAGE, 403);
      }
      const countInput = model.provider === "openai" ? countOpenAIAnalysisInput : countAnthropicAnalysisInput;
      const inputTokens = await countInput({ model: model.id, key: providerKey(model.id), input, ...contract(value.kind),
        thinkingLevel, signal, fetcher: send });
      signal.throwIfAborted();
      const outputTokens = creditOutputLimit(value.kind, thinkingLevel);
      const maximum = maximumCost(model, inputTokens, outputTokens);
      const quote = { id: randomUUID(), user_id: account.id, model: model.id, kind: value.kind, thinking_level: thinkingLevel,
        input_tokens: inputTokens, output_limit: outputTokens,
        content_hash: digest(JSON.stringify(input)), maximum, price_version: PRICE_VERSION, expires_at: new Date(now() + 5 * 60000).toISOString() };
      await insert("quotes", quote);
      return { id: quote.id, model: quote.model, thinkingLevel, maximum, inputTokens, outputTokens, expiresAt: quote.expires_at };
    }
    if (method === "POST" && path === "/v1/analysis") {
      const value = z.object({ quoteId: uuid, requestId: uuid, input: z.unknown() }).strict().parse(body);
      const [quote] = await rows<QuoteRow>("quotes", `id=eq.${value.quoteId}&user_id=eq.${account.id}&select=*`);
      if (!quote || quote.price_version !== PRICE_VERSION) throw new ServiceError("Request a fresh analysis quote.");
      allowBoards(quote.kind, account.id);
      const kind = kindSchema.parse(quote.kind), model = configuredModel(quote.model), input = validateInput(value.input, kind);
      const thinkingLevel = validateOnlineThinking(model, quote.thinking_level);
      if (quote.output_limit !== creditOutputLimit(kind, thinkingLevel) ||
          quote.maximum !== maximumCost(model, quote.input_tokens, quote.output_limit)) throw new ServiceError("Request a fresh analysis quote.");
      const run = await rpc<RunRow>("reserve", { p_user: account.id, p_id: value.requestId, p_quote: quote.id, p_hash: digest(JSON.stringify(input)) })
        .catch(async (error: unknown) => {
          if (error instanceof ServiceError && error.status === 402) {
            const wallet = await rpc<Wallet>("wallet", { p_user: account.id });
            throw new ServiceError(creditReservationMessage(quote, wallet.balance - wallet.reserved), 402);
          }
          throw error;
        });
      if (!run.fresh) {
        if (run.status === "completed" && run.result) return { result: run.result, wallet: await rpc("wallet", { p_user: account.id }) };
        throw new ServiceError(run.status === "reserved" ? "This analysis is already running." : "This analysis has ended. Request a new quote.", 409);
      }
      try {
        signal.throwIfAborted();
        const response = await onlineAnalysis({ model: model.id, key: providerKey(model.id), kind,
          ...contract(kind), input, thinkingLevel, signal, fetcher: dependencies.fetcher, billingOwner: "zebby",
          maxOutputTokens: quote.output_limit });
        signal.throwIfAborted();
        const result = validateResult(response.result, kind, input), cost = usageCost(model, response.usage);
        const settled = await rpc<RunRow>("finish", { p_user: account.id, p_id: value.requestId, p_cost: cost, p_result: result, p_success: true });
        if (settled.status !== "completed") throw new ServiceError("This analysis expired. Your reserved credits were released.");
        return { result, wallet: await rpc("wallet", { p_user: account.id }) };
      } catch (error) {
        await rpc("finish", { p_user: account.id, p_id: value.requestId, p_cost: 0, p_result: null, p_success: false }).catch(() => undefined);
        throw error;
      }
    }
    throw new ServiceError("Request not found.", 404);
  }
  return { handle, webhook, cleanup: () => rpc("cleanup", {}) };
}
