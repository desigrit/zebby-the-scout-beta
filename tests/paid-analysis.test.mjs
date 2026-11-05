import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { CREDIT_PACKS, CREDIT_ESTIMATE, CREDIT_MODELS, NANODOLLARS_PER_CREDIT, estimatedAnalyses, onlineModel, usageCost, maximumCost, creditOutputLimit, quoteNeedsCredits } from "../shared/online-models.ts";
import { onlineAnalysis } from "../desktop/online-analysis.ts";
import { CreditsClient } from "../desktop/credits-client.ts";
import { createService } from "../credits-service/service.ts";
import { serviceConfig } from "../credits-service/config.ts";
import { verifyStripeEvent } from "../credits-service/stripe.ts";
import { runSelectedAnalysis } from "../desktop/analysis-routing.ts";
import { creditUsage } from "../shared/credit-usage.ts";
import { CREDIT_SERVICE_URL, LEGACY_CREDIT_SERVICE_URL } from "../shared/credit-service.ts";
import { analysisFetch } from "../desktop/analysis-fetch.ts";
import { createServer } from "node:http";
import { once } from "node:events";

test("credit usage shows the remaining share of purchased credits", () => {
  const { percentUsed, ...usage } = creditUsage({ balance: 2790_000_000, reserved: 0, used: 210_000_000, purchased: 3000_000_000 });
  assert.deepEqual(usage, { available: 2790_000_000, total: 3000_000_000, used: 210_000_000, percentRemaining: 93 });
  assert.ok(Math.abs(percentUsed - 7) < 0.000001);
});
test("credit usage excludes reservations without counting them as spent", () => {
  const value = creditUsage({ balance: 2790_000_000, reserved: 300_000_000, used: 210_000_000, purchased: 3000_000_000 });
  assert.equal(value.available, 2490_000_000);
  assert.equal(value.percentRemaining, 83);
  assert.equal(value.used, 210_000_000);
  assert.ok(Math.abs(value.percentUsed - 7) < 0.000001);
  assert.equal(creditUsage({ balance: 100, reserved: 110, used: 0, purchased: 100 }).available, 0);
});
test("credit usage handles empty, exhausted and restored balances", () => {
  assert.deepEqual(creditUsage({ balance: 0, reserved: 0, used: 0, purchased: 0 }),
    { available: 0, total: 0, used: 0, percentRemaining: 0, percentUsed: 0 });
  assert.equal(creditUsage({ balance: 0, reserved: 0, used: 500_000_000, purchased: 500_000_000 }).percentRemaining, 0);
  assert.equal(creditUsage({ balance: 100_000_000, reserved: 0, used: 0, purchased: 0 }).percentRemaining, 100);
  assert.equal(creditUsage({ balance: 0, reserved: 0, used: 500_000_000, purchased: 500_000_000 }).percentUsed, 100);
  assert.equal(creditUsage({ balance: 100, reserved: 100, used: 0, purchased: 100 }).percentUsed, 0);
  assert.equal(creditUsage({ balance: -10, reserved: 0, used: 110, purchased: 100 }).percentUsed, 100);
  assert.equal(creditUsage({ balance: 499_080_000, reserved: 0, used: 920_000, purchased: 500_000_000 }).percentUsed, 0.184);
});

const userId = "11111111-1111-4111-8111-111111111111", otherId = "22222222-2222-4222-8222-222222222222";
const config = { supabaseUrl: "https://database.example", supabaseKey: "server-secret", publicUrl: "https://credits.example",
  stripeKey: "sk_test_fixture", stripeWebhookSecret: "whsec_fixture", openaiKey: "openai-fixture", anthropicKey: "claude-fixture", live: false, port: 8080 };
const input = { company: "Example", title: "Product Manager", jobDescription: "Lead customer discovery and product strategy. Own product outcomes and work across design and engineering. ".repeat(220),
  resumeText: "Product manager with experience in customer discovery, roadmaps, product strategy and measurement.", currentCvOverview: "Product manager turning customer insights into useful products." };
const match = { score: 68, explanation: "Product strategy is demonstrated. Enterprise risk experience is not demonstrated." };
const plan = { ...match, keywords: Array.from({ length: 6 }, (_, i) => ({ text: "Keyword " + i, importance: 95 - i * 5 })),
  themes: Array.from({ length: 5 }, (_, i) => ({ text: "Theme " + i, importance: 92 - i * 5 })),
  overview: "Product manager turning discovery into measurable product outcomes.", overviewRationale: "Aligned the wording with product outcomes." };
function signature(event, secret = config.stripeWebhookSecret, timestamp = Math.floor(Date.now() / 1000)) {
  const raw = Buffer.from(JSON.stringify(event));
  return { raw, signature: `t=${timestamp},v1=${createHmac("sha256", secret).update(timestamp + ".").update(raw).digest("hex")}` };
}
test("credit pack counts use the sampled Plan baseline with separate estimated thinking tokens", () => {
  const example = usageCost(onlineModel(CREDIT_ESTIMATE.model), { input: 0, cached: 0, cacheWrite: CREDIT_ESTIMATE.input, output: CREDIT_ESTIMATE.output });
  assert.equal(CREDIT_ESTIMATE.input, 3600);
  assert.equal(CREDIT_ESTIMATE.visibleOutput, 500);
  assert.equal(CREDIT_ESTIMATE.output, CREDIT_ESTIMATE.visibleOutput + CREDIT_ESTIMATE.thinkingAllowance);
  assert.equal(example / NANODOLLARS_PER_CREDIT, 89);
  assert.deepEqual(CREDIT_PACKS.map((pack) => pack.analyses), [5, 33, 89, 179]);
  assert.deepEqual(CREDIT_MODELS.map((model) => model.id), ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
  const lunaExample = usageCost(onlineModel("gpt-6-luna"), { input: 0, cached: 0, cacheWrite: CREDIT_ESTIMATE.input, output: CREDIT_ESTIMATE.output });
  assert.equal(lunaExample / NANODOLLARS_PER_CREDIT, 4.45);
  assert.deepEqual(CREDIT_PACKS.map((pack) => estimatedAnalyses(pack.credits, "gpt-6-luna")), [112, 674, 1797, 3595]);
  assert.deepEqual(CREDIT_PACKS.map((pack) => estimatedAnalyses(pack.credits, "gpt-6-astra")), [0, 22, 64, 121]);
  assert.deepEqual(CREDIT_PACKS.map((pack) => estimatedAnalyses(pack.credits, "claude-opus-5-5")), [0, 22, 64, 121]);
  assert.deepEqual(CREDIT_PACKS.map((pack) => estimatedAnalyses(pack.credits, "claude-sonnet-5-5")), [5, 33, 89, 179]);
  assert.deepEqual(CREDIT_PACKS.map((pack) => estimatedAnalyses(pack.credits, "claude-haiku-5-5")), [112, 674, 1797, 3595]);
  for (const pack of CREDIT_PACKS) {
    assert.ok(pack.analyses * example <= pack.credits * NANODOLLARS_PER_CREDIT);
    assert.ok(pack.credits * NANODOLLARS_PER_CREDIT - pack.analyses * example < example);
    const lunaCount = estimatedAnalyses(pack.credits, "gpt-6-luna");
    assert.ok(lunaCount * lunaExample <= pack.credits * NANODOLLARS_PER_CREDIT);
    assert.ok(pack.credits * NANODOLLARS_PER_CREDIT - lunaCount * lunaExample < lunaExample);
  }
  assert.equal(usageCost(onlineModel("gpt-6-astra"), { input: 20000, cached: 0, output: 6000 }) / NANODOLLARS_PER_CREDIT, 500);
  assert.equal(usageCost(onlineModel("gpt-6-luna"), { input: 100, cached: 50, output: 10 }), 10500);
  assert.throws(() => usageCost(onlineModel("gpt-6-luna"), { input: 1, cached: 2, output: 0 }));
  assert.throws(() => usageCost(onlineModel("gpt-6-luna"), { input: NaN, cached: 0, output: 0 }));
});

test("Haiku 5.5 accounts for its higher rate above 100,000 input tokens", () => {
  const model = onlineModel("claude-haiku-5-5");
  assert.equal(usageCost(model, { input: 100000, cached: 0, output: 500 }), 10_250_000);
  assert.equal(usageCost(model, { input: 100001, cached: 0, output: 500 }), 51_250_500);
  assert.equal(usageCost(model, { input: 99999, cached: 500, cacheWrite5m: 2, output: 500 }), 51_025_750);
});
test("Stripe signatures reject changes, stale events, and invalid signatures", () => {
  const event = { id: "evt_fixture", livemode: false }, signed = signature(event);
  assert.deepEqual(verifyStripeEvent(signed.raw, signed.signature, config.stripeWebhookSecret), event);
  assert.throws(() => verifyStripeEvent(Buffer.from("{}"), signed.signature, config.stripeWebhookSecret));
  assert.throws(() => verifyStripeEvent(signed.raw, "t=1,v1=abc", config.stripeWebhookSecret));
  const old = signature(event, config.stripeWebhookSecret, 1);
  assert.throws(() => verifyStripeEvent(old.raw, old.signature, config.stripeWebhookSecret));
});

test("OpenAI cache writes are charged once at the published rate", async () => {
  const response = await onlineAnalysis({ model: "gpt-6-luna", key: "fixture", instructions: "Compare evidence.", input,
    name: "resume_match", schema: { type: "object" }, kind: "match", fetcher: async () => Response.json({
      status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(match) }] }],
      usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 200 }, output_tokens: 25 },
    }) });
  assert.deepEqual(response.usage, { input: 800, cached: 100, cacheWrite: 200, output: 25 });
  assert.equal(usageCost(onlineModel("gpt-6-luna"), response.usage), 108500);
  assert.ok(maximumCost(onlineModel("gpt-6-luna"), 1000, 25) >= 108500);
});

test("OpenAI maximum quotes cover cache writes and long-context pricing", () => {
  const model = onlineModel("gpt-6-luna");
  assert.equal(usageCost(model, { input: 272000, cached: 0, output: 6000 }), 30200000);
  assert.equal(usageCost(model, { input: 272001, cached: 0, output: 6000 }), 58900200);
  const bound = maximumCost(model, 280000, 6000);
  for (const usage of [
    { input: 0, cached: 0, cacheWrite: 280000, output: 6000 },
    { input: 140000, cached: 100000, cacheWrite: 140000, output: 6000 },
  ]) assert.ok(usageCost(model, usage) <= bound);
  assert.throws(() => usageCost(model, { input: -1, cached: 0, cacheWrite: 1001, output: 0 }));
});

test("Sonnet 5.5 cache hits use its published five-percent input rate", () => {
  assert.equal(usageCost(onlineModel("claude-sonnet-5-5"), { input: 100, cached: 50, output: 10 }), 205000);
});
test("recovering an already paid result is allowed with zero or negative balance", () => {
  const recovery = { id: randomUUID(), model: "gpt-6-luna", maximum: 0, expiresAt: new Date(Date.now()+60000).toISOString(), recovery: true };
  assert.equal(quoteNeedsCredits(recovery, 0), false); assert.equal(quoteNeedsCredits(recovery, -5000000), false);
  assert.equal(quoteNeedsCredits({ ...recovery, recovery: false, maximum: 5000000 }, 0), true);
});
test("service configuration defaults to test mode and rejects accidental live keys", () => {
  const env = { SUPABASE_URL: config.supabaseUrl, SUPABASE_SERVICE_ROLE_KEY: config.supabaseKey, ZEBBY_PUBLIC_SERVICE_URL: config.publicUrl,
    STRIPE_SECRET_KEY: "sk_test_fixture", STRIPE_WEBHOOK_SECRET: config.stripeWebhookSecret };
  assert.equal(serviceConfig(env).live, false);
  assert.equal(serviceConfig({ ...env, STRIPE_SECRET_KEY: "rk_test_fixture" }).live, false);
  assert.throws(() => serviceConfig({ ...env, STRIPE_SECRET_KEY: "sk_live_fixture" }));
  assert.throws(() => serviceConfig({ ...env, STRIPE_SECRET_KEY: "rk_live_fixture" }));
  const liveEnv = { ...env, ZEBBY_ALLOW_LIVE_PAYMENTS: "true" };
  for (const prefix of ["sk_live_", "rk_live_"]) assert.equal(serviceConfig({ ...liveEnv, STRIPE_SECRET_KEY: prefix + "fixture" }).live, true);
  for (const prefix of ["sk_test_", "rk_test_", "pk_live_", "pk_test_"]) assert.throws(() => serviceConfig({ ...liveEnv, STRIPE_SECRET_KEY: prefix + "fixture" }));
  assert.throws(() => serviceConfig({ ...env, ZEBBY_PUBLIC_SERVICE_URL: "http://credits.example" }));
  assert.equal(serviceConfig(env).bindAddress, "0.0.0.0");
  assert.equal(serviceConfig({ ...env, ZEBBY_BIND_ADDRESS: "127.0.0.1" }).bindAddress, "127.0.0.1");
  assert.equal(serviceConfig({ ...env, ZEBBY_BIND_ADDRESS: "::1" }).bindAddress, "::1");
  assert.throws(() => serviceConfig({ ...env, ZEBBY_BIND_ADDRESS: "untrusted.example" }), /IP address/);
});

test("Azure carries the existing wallet, recovery code and pending receipts without creating another wallet", async () => {
  const snapshot = { url: LEGACY_CREDIT_SERVICE_URL,
    session: { access: "zby_device_" + "a".repeat(64), refresh: "zby_device_" + "a".repeat(64), expires: Number.MAX_SAFE_INTEGER,
      email: "", id: userId, deviceId: randomUUID(), kind: "guest" },
    wallet: { balance: 450000000, reserved: 0, used: 50000000, purchased: 500000000, updatedAt: new Date().toISOString(), recent: [] },
    recovery: { code: "ZEBBY-" + Array(5).fill("ABCDEF12").join("-"), walletId: userId, version: randomUUID(), saved: true },
    pending: [{ quoteId: randomUUID(), requestId: randomUUID(), userId, hash: "fixture-hash", model: "gpt-6.1-sol",
      expires: Date.now() + 60000, source: { kind: "match", id: randomUUID() } }] };
  let saved;
  const migrated = new CreditsClient(CREDIT_SERVICE_URL, { save: async value => { saved = JSON.parse(value); }, onChange() {},
    fetcher: async (url, options) => {
      assert.equal(url, CREDIT_SERVICE_URL + "/v1/wallet");
      assert.equal(options.headers.Authorization, "Bearer " + snapshot.session.access);
      return Response.json(snapshot.wallet);
    } });
  migrated.restore(JSON.stringify(snapshot));
  assert.equal(migrated.state("gpt-6.1-sol").signedIn, true);
  await migrated.refreshWallet();
  assert.equal(saved.url, LEGACY_CREDIT_SERVICE_URL);
  assert.deepEqual(saved.session, snapshot.session);
  assert.deepEqual(saved.wallet, snapshot.wallet);
  assert.deepEqual(saved.recovery, snapshot.recovery);
  assert.deepEqual(saved.pending, snapshot.pending);
  const rollback = new CreditsClient(LEGACY_CREDIT_SERVICE_URL, { save: async () => {}, onChange() {} });
  rollback.restore(JSON.stringify(saved));
  assert.equal(rollback.state("gpt-6.1-sol").signedIn, true);
  for (const url of ["https://other.example", CREDIT_SERVICE_URL + ".example"]) {
    const unknown = new CreditsClient(url, { save: async () => assert.fail("Preserve wallet access"), onChange() {},
      fetcher: () => assert.fail("Never send a wallet credential to an unapproved host") });
    unknown.restore(JSON.stringify(snapshot));
    await assert.rejects(unknown.checkout("starter"), /could not be read/);
  }
});

test("analysis transport uses a compatible dispatcher, preserves POST data and cancels without replay", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    requests.push({ method: request.method, path: request.url, body });
    if (request.url === "/wait") return;
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await analysisFetch(url + "/analysis", { method: "POST", body: JSON.stringify({ model: "fixture" }) });
    assert.deepEqual(await response.json(), { ok: true });
    await assert.rejects(analysisFetch(url + "/wait", { signal: AbortSignal.timeout(60) }), { name: "TimeoutError" });
    assert.deepEqual(requests, [{ method: "POST", path: "/analysis", body: '{"model":"fixture"}' }, { method: "GET", path: "/wait", body: "" }]);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test("Anthropic uses structured Messages output and charges reported cache and output usage", async () => {
  let body;
  const response = await onlineAnalysis({ model: "claude-haiku-4-5-20251001", key: "fixture", instructions: "Compare evidence.", input,
    name: "resume_match", schema: { type: "object" }, kind: "match", fetcher: async (url, options) => {
      assert.equal(url, "https://api.anthropic.com/v1/messages"); assert.equal(options.headers["anthropic-version"], "2023-06-01");
      body = JSON.parse(options.body);
      return Response.json({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(match) }],
        usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 }, output_tokens: 25 } });
    } });
  assert.equal(body.output_config.format.type, "json_schema"); assert.equal(body.max_tokens, 3000);
  assert.equal(body.messages[0].content, JSON.stringify(input)); assert.deepEqual(response.result, match);
  assert.equal(usageCost(onlineModel("claude-haiku-4-5-20251001"), response.usage), 282500);
});
test("selected cloud providers never fall back to a smaller local model", async () => {
  const selection = { provider: "anthropic", ollamaUrl: "", ollamaModel: "", builtInModelId: "smollm2-360m" };
  await assert.rejects(runSelectedAnalysis(selection, { anthropic: async () => { throw new Error("offline"); },
    ready: () => assert.fail("fallback"), local: () => assert.fail("fallback"), openai: () => assert.fail("fallback"), ollama: () => assert.fail("fallback") },
    "", input, "resume_match", {}, ""), /offline/);
});
test("desktop paid session stays private, is recoverable, and cannot move to another service origin", async () => {
  let saved = "", requests = [];
  const wallet = { balance: 500000000, reserved: 0, used: 0, purchased: 500000000, updatedAt: new Date().toISOString(), recent: [] };
  const client = new CreditsClient(config.publicUrl, { save: async (value) => { saved = value; }, onChange() {}, fetcher: async (url, options) => {
    requests.push([url, options]);
    if (url.endsWith("/auth/verify")) return Response.json({ access_token: "private-access", refresh_token: "private-refresh", expires_in: 3600, user: { email: "peer@example.com", id: userId } });
    if (url.endsWith("/auth/logout")) return Response.json({ signedOut: true });
    return Response.json(wallet);
  } });
  await client.verify("peer@example.com", "123456");
  assert.equal(client.state("gpt-6-luna").wallet.balance, wallet.balance);
  assert.doesNotMatch(JSON.stringify(client.state("gpt-6-luna")), /private-access|private-refresh/);
  const restored = new CreditsClient(config.publicUrl, { save: async () => {}, onChange() {} }); restored.restore(saved);
  assert.equal(restored.state("gpt-6-luna").signedIn, true); assert.equal(restored.state("gpt-6-luna").stale, true);
  const moved = new CreditsClient("https://other.example", { save: async () => {}, onChange() {} }); moved.restore(saved);
  assert.equal(moved.state("gpt-6-luna").signedIn, false);
  await client.signOut(); assert.equal(saved, ""); assert.equal(client.state("gpt-6-luna").wallet, null);
  assert.equal(requests.at(-1)[1].headers.Authorization, "Bearer private-access");
});

test("late account A responses cannot replace account B wallet or persisted session", async () => {
  let saved = "", release, started, delay = false;
  const ready = new Promise((resolve) => { started = resolve; });
  const wallet = (amount) => ({ balance: amount, reserved: 0, used: 0, purchased: amount, updatedAt: new Date().toISOString(), recent: [] });
  const client = new CreditsClient(config.publicUrl, { save: async (value) => { saved = value; }, onChange() {}, fetcher: async (url, options) => {
    if (url.endsWith("/auth/verify")) { const email = JSON.parse(options.body).email, isA = email === "a@example.com";
      return Response.json({ access_token: isA ? "access-a" : "access-b", refresh_token: isA ? "refresh-a" : "refresh-b", expires_in: 3600, user: { id: isA ? userId : otherId, email } }); }
    if (url.endsWith("/auth/logout")) return Response.json({ signedOut: true });
    if (options.headers.Authorization === "Bearer access-a" && delay) { started(); return new Promise((resolve) => { release = () => resolve(Response.json(wallet(500000000))); }); }
    return Response.json(wallet(options.headers.Authorization === "Bearer access-a" ? 500000000 : 9000000));
  } });
  await client.verify("a@example.com", "123456"); delay = true;
  const old = client.refreshWallet(), rejected = assert.rejects(old, /wallet changed/); await ready;
  await client.signOut(); await client.verify("b@example.com", "123456"); release(); await rejected;
  assert.equal(client.state("gpt-6-luna").email, "b@example.com"); assert.equal(client.state("gpt-6-luna").wallet.balance, 9000000);
  assert.equal(JSON.parse(saved).session.id, otherId); assert.equal(JSON.parse(saved).wallet.balance, 9000000);
});
test("simultaneous wallet refreshes are coalesced", async () => {
  let calls = 0;
  const wallet = { balance: 0, reserved: 0, used: 0, purchased: 0, updatedAt: new Date().toISOString(), recent: [] };
  const client = new CreditsClient(config.publicUrl, { save: async () => {}, onChange() {}, fetcher: async () => { calls++; return Response.json(wallet); } });
  client.restore(JSON.stringify({ url: config.publicUrl, session: { access: "fixture", refresh: "fixture", expires: Date.now() + 3600000, email: "peer@example.com", id: userId } }));
  await Promise.all([client.refreshWallet(), client.refreshWallet(), client.refreshWallet()]); assert.equal(calls, 1);
});

test("wallet totals include every completed analysis and keep recent usage bounded", async () => {
  const db = new PGlite();
  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
    await db.exec(await readFile(new URL("../credits-service/schema.sql", import.meta.url), "utf8"));
    await db.query("insert into zebby_wallets(user_id,balance,used,purchased) values($1,470000000,30000000,500000000)", [userId]);
    for (let index = 0; index < 17; index++) {
      const quote = randomUUID(), owner = index === 16 ? otherId : userId;
      const status = index < 13 || index === 16 ? "completed" : index === 13 ? "reserved" : "failed";
      await db.query("insert into zebby_quotes(id,user_id,model,kind,content_hash,maximum,price_version,expires_at) values($1,$2,'gpt-6.1-sol','plan','fixture',100000000,'fixture',now()+interval '1 hour')", [quote, owner]);
      await db.query("insert into zebby_runs(id,user_id,quote_id,model,kind,maximum,cost,status,created_at) values($1,$2,$3,'gpt-6.1-sol','plan',100000000,$4,$5,$6)",
        [randomUUID(), owner, quote, index * 100000, status, new Date(Date.UTC(2026, 9, index + 1)).toISOString()]);
    }
    const wallet = async () => (await db.query("select zebby_wallet($1) as result", [userId])).rows[0].result;
    const before = await wallet();
    assert.equal(before.completedAnalyses, 13);
    assert.equal(before.recent.length, 10);
    assert.equal(before.recent[0].cost, 1200000);
    assert.equal(before.used, 30000000);
    const savedRuns = (await db.query("select * from zebby_runs order by id")).rows;
    const migration = await readFile(new URL("../credits-service/migrations/20261027_wallet_usage.sql", import.meta.url), "utf8");
    await db.exec(migration); await db.exec(migration);
    assert.deepEqual(await wallet(), before);
    assert.deepEqual((await db.query("select * from zebby_runs order by id")).rows, savedRuns);
    await assert.rejects(db.transaction(async (tx) => { await tx.exec("set local role anon"); await tx.query("select zebby_wallet($1)", [userId]); }), /permission denied/);
  } finally { await db.close(); }
});

test("wallet activity covers 84 complete UTC days without recent-row, status or wallet leakage", async () => {
  const db = new PGlite();
  try {
    await db.exec("create role anon; create role authenticated; create role service_role bypassrls; set timezone = 'America/Los_Angeles';");
    await db.exec(await readFile(new URL("../credits-service/schema.sql", import.meta.url), "utf8"));
    const today = (await db.query("select to_char((now() at time zone 'UTC')::date,'YYYY-MM-DD') as day")).rows[0].day;
    const midnight = Date.parse(`${today}T00:00:00Z`), day = 86_400_000;
    async function run({ owner = userId, status = "completed", at = midnight + 12 * 3600000, cost = 1000000 } = {}) {
      const quote = randomUUID();
      await db.query("insert into zebby_quotes(id,user_id,model,kind,content_hash,maximum,price_version,expires_at) values($1,$2,'gpt-6.1-sol','plan','fixture',100000000,'fixture',now()+interval '1 hour')", [quote, owner]);
      await db.query("insert into zebby_runs(id,user_id,quote_id,model,kind,maximum,cost,status,created_at) values($1,$2,$3,'gpt-6.1-sol','plan',100000000,$4,$5,$6)",
        [randomUUID(), owner, quote, cost, status, new Date(at).toISOString()]);
    }
    for (let index = 0; index < 15; index++) await run();
    await run({ at: midnight - 83 * day, cost: 2000000 });
    await run({ at: midnight - 83 * day - 1, cost: 3000000 });
    await run({ at: midnight + day - 1, cost: 4000000 });
    await run({ at: midnight + day, cost: 5000000 });
    await run({ status: "failed", cost: 6000000 });
    await run({ status: "reserved", cost: 6000000 });
    await run({ owner: otherId, cost: 7000000 });
    const wallet = async () => (await db.query("select zebby_wallet($1) as result", [userId])).rows[0].result;
    const before = await wallet();
    assert.equal(before.recent.length, 10);
    assert.equal(before.completedAnalyses, 19);
    assert.equal(before.dailyUsage.length, 84);
    assert.deepEqual(before.dailyUsage[0], { date: new Date(midnight - 83 * day).toISOString().slice(0, 10), count: 1, cost: 2000000 });
    assert.deepEqual(before.dailyUsage.at(-1), { date: today, count: 16, cost: 19000000 });
    assert.equal(before.dailyUsage.reduce((total, value) => total + value.count, 0), 17);
    assert.equal(before.dailyUsage.reduce((total, value) => total + value.cost, 0), 21000000);
    assert.equal(before.dailyUsage.filter((value) => value.count === 0 && value.cost === 0).length, 82);
    const migration = await readFile(new URL("../credits-service/migrations/20261027_wallet_usage.sql", import.meta.url), "utf8");
    await db.exec(migration); await db.exec(migration);
    assert.deepEqual(await wallet(), before);
  } finally { await db.close(); }
});

test("credits client retains complete daily usage and accepts older wallets without it", async () => {
  const base = { balance: 100000000, used: 0, reserved: 0, purchased: 100000000, updatedAt: new Date().toISOString(), recent: [] };
  const dailyUsage = Array.from({ length: 84 }, (_, index) => ({ date: new Date(Date.UTC(2026, 9, 27) - (83 - index) * 86400000).toISOString().slice(0, 10), count: index % 3, cost: index * 1000 }));
  let payload = { ...base, dailyUsage };
  const client = new CreditsClient(config.publicUrl, { save: async () => {}, onChange() {}, fetcher: async () => Response.json(payload) });
  client.restore(JSON.stringify({ url: config.publicUrl, session: { access: "fixture", refresh: "fixture", expires: Date.now() + 3600000, email: "peer@example.com", id: userId } }));
  await client.refreshWallet();
  assert.deepEqual(client.state("gpt-6.1-sol").wallet.dailyUsage, payload.dailyUsage);
  payload = base;
  await client.refreshWallet();
  assert.equal(client.state("gpt-6.1-sol").wallet.dailyUsage, undefined);
  for (const days of [dailyUsage.slice(1), dailyUsage.map((value, index) => index === 4 ? { ...value, date: "2026-02-31" } : value),
    dailyUsage.map((value, index) => index === 4 ? dailyUsage[3] : value),
    dailyUsage.map((value, index) => index === 4 ? dailyUsage[5] : value)]) {
    payload = { ...base, dailyUsage: days };
    await assert.rejects(client.refreshWallet());
  }
});

test("cached Boards results acknowledge only matching receipts and retain other pending work", async () => {
  const source = { kind: "board_extract", id: randomUUID() }, value = { candidates: ["l0"] };
  const hash = createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const receipt = { quoteId: randomUUID(), requestId: randomUUID(), userId, hash, model: "gpt-6-luna", expires: Date.now() + 60000, source };
  const other = { ...receipt, quoteId: randomUUID(), source: { kind: "plan", id: randomUUID() } };
  let saved;
  const client = new CreditsClient(config.publicUrl, { save: async snapshot => { saved = JSON.parse(snapshot); }, onChange() {},
    fetcher: async () => { throw new Error("Cached results must not make a new paid request"); } });
  client.restore(JSON.stringify({ url: config.publicUrl, session: { access: "fixture", refresh: "fixture", expires: Date.now() + 3600000, email: "peer@example.com", id: userId }, pending: [receipt, other] }));
  await client.acknowledgeCachedSource(source, { candidates: ["different"] }); assert.equal(saved.pending.length, 2);
  await client.acknowledgeCachedSource(source, value); assert.deepEqual(saved.pending, [other]);
});

test("a delayed refresh cannot replace a newer checkout wallet, including sub-millisecond ledger timestamps", async () => {
  const oldWallet = { balance: 1000000, used: 0, reserved: 0, purchased: 1000000, updatedAt: "2026-10-27T12:00:00.000001Z", recent: [] };
  const newWallet = { ...oldWallet, balance: 501000000, purchased: 501000000, updatedAt: "2026-10-27T12:00:00.000002+00:00" };
  let finish, entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  const client = new CreditsClient(config.publicUrl, { save: async () => {}, onChange() {}, fetcher: async (url) => {
    if (url.endsWith("/wallet")) { entered(); return new Promise((resolve) => { finish = () => resolve(Response.json(oldWallet)); }); }
    return Response.json({ status: "paid", wallet: newWallet });
  } });
  client.restore(JSON.stringify({ url: config.publicUrl, session: { access: "fixture", refresh: "fixture", expires: Date.now() + 3600000, email: "peer@example.com", id: userId } }));
  const refresh = client.refreshWallet(); await waiting;
  await client.checkoutStatus("cs_fixture"); finish(); await refresh;
  assert.deepEqual(client.state("gpt-6.1-sol").wallet, newWallet);
});

test("PostgreSQL ledger and service integration", async (t) => {
  const db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  await db.exec(await readFile(new URL("../credits-service/schema.sql", import.meta.url), "utf8"));
  async function rpc(name, data) {
    const keys = Object.keys(data), placeholders = keys.map((key, i) => `${key} => $${i + 1}`).join(",");
    const { rows } = await db.query(`select public.zebby_${name}(${placeholders}) as result`, Object.values(data)); return rows[0].result;
  }
  let providerCalls = 0, failProvider = false, abortProvider = false, providerResult = plan, lastProviderRequest, expectedModel = "gpt-6.1-sol";
  const fetcher = async (target, options = {}) => {
    const url = new URL(target);
    if (url.hostname === "database.example") {
      if (url.pathname === "/auth/v1/user") { const id = options.headers.Authorization === "Bearer other" ? otherId : userId;
        if (options.headers.Authorization === "Bearer invalid") return Response.json({}, { status: 401 });
        return Response.json({ id, email: "peer@example.com", email_confirmed_at: new Date().toISOString() }); }
      const name = url.pathname.split("/").at(-1);
      if (url.pathname.includes("/rpc/")) {
        try { return Response.json(await rpc(name.replace("zebby_", ""), JSON.parse(options.body))); }
        catch (error) { return Response.json({ message: error.message }, { status: 400 }); }
      }
      assert.match(name, /^zebby_(purchases|quotes|runs)$/);
      const body = options.body ? JSON.parse(options.body) : null;
      if (options.method === "POST") {
        const keys = Object.keys(body), values = keys.map((_, i) => "$" + (i + 1));
        return Response.json((await db.query(`insert into ${name}(${keys.join(",")}) values(${values.join(",")}) returning *`, Object.values(body))).rows);
      }
      const parameters = [], where = [];
      for (const [key, value] of url.searchParams) if (key !== "select") {
        assert.match(key, /^[a-z_]+$/); assert.ok(value.startsWith("eq.")); parameters.push(value.slice(3)); where.push(`${key}=$${parameters.length}`);
      }
      if (options.method === "PATCH") {
        const assignments = Object.entries(body).map(([key, value]) => { parameters.push(value); return `${key}=$${parameters.length}`; });
        await db.query(`update ${name} set ${assignments.join(",")} where ${where.join(" and ")}`, parameters); return new Response(null, { status: 204 });
      }
      return Response.json((await db.query(`select * from ${name} where ${where.join(" and ") || "true"}`, parameters)).rows);
    }
    if (url.hostname === "api.stripe.com") {
      if (options.method === "POST") { const fields = new URLSearchParams(options.body); assert.equal(fields.get("line_items[0][price_data][unit_amount]"), "500");
        return Response.json({ id: "cs_test_fixture", url: "https://checkout.stripe.com/c/pay/fixture" }); }
      return Response.json({ status: "open" });
    }
    assert.equal(url.hostname, "api.openai.com");
    if (url.pathname === "/v1/responses/input_tokens") return Response.json({ object: "response.input_tokens", input_tokens: 20000 });
    providerCalls++;
    const request = JSON.parse(options.body); lastProviderRequest = request; assert.equal(request.model, expectedModel); assert.equal(request.store, false);
    if (abortProvider) { await new Promise((_, reject) => { options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }); }); }
    if (failProvider) return Response.json({ error: { message: "private resume content" } }, { status: 500 });
    return Response.json({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(providerResult) }] }],
      usage: { input_tokens: 20000, input_tokens_details: { cached_tokens: 0 }, output_tokens: Math.min(6000, request.max_output_tokens) } });
  };
  const service = createService(config, { fetcher }), controller = new AbortController();
  const handle = (method, path, value, token = "owner", signal = controller.signal) => service.handle(method, path, value, token, signal);
  const wallet = () => rpc("wallet", { p_user: userId });
  const newQuote = (thinkingLevel = "low") => handle("POST", "/v1/quotes", { model: "gpt-6.1-sol", thinkingLevel, kind: "plan", input });
  const analyze = (quoteId, requestId = randomUUID(), value = input, token = "owner", signal = controller.signal) =>
    handle("POST", "/v1/analysis", { quoteId, requestId, input: value }, token, signal);
  try {
    await t.test("checkout cannot credit a wallet until a signed matching paid event", async () => {
      const id = randomUUID(); await handle("POST", "/v1/checkout", { pack: "starter", requestId: id }); assert.equal((await wallet()).balance, 0);
      const event = { id: "evt_purchase", livemode: false, type: "checkout.session.completed", data: { object: {
        id: "cs_test_fixture", payment_status: "paid", currency: "usd", amount_subtotal: 500, client_reference_id: userId,
        payment_intent: "pi_fixture", metadata: { user_id: userId, purchase_id: id, pack: "starter" } } } };
      const unpaid = signature({ ...event, id: "evt_unpaid", data: { object: { ...event.data.object, payment_status: "unpaid" } } });
      await service.webhook(unpaid.raw, unpaid.signature); assert.equal((await wallet()).balance, 0);
      const tampered = signature({ ...event, id: "evt_bad", data: { object: { ...event.data.object, amount_subtotal: 50 } } });
      await assert.rejects(service.webhook(tampered.raw, tampered.signature), /does not match/);
      const live = signature({ ...event, livemode: true }); await assert.rejects(service.webhook(live.raw, live.signature), /mode/);
      const valid = signature(event); await service.webhook(valid.raw, valid.signature); await service.webhook(valid.raw, valid.signature);
      assert.equal((await wallet()).balance, 500 * NANODOLLARS_PER_CREDIT); assert.equal((await wallet()).purchased, 500 * NANODOLLARS_PER_CREDIT);
      assert.equal((await handle("GET", "/v1/checkout/cs_test_fixture")).status, "paid");
      await assert.rejects(handle("GET", "/v1/checkout/cs_test_fixture", undefined, "other"), /not found/);
    });
    await t.test("paid quotes bind thinking and reject unsupported models or request overrides", async () => {
      const high = await newQuote("high"), low = await newQuote(), calls = providerCalls;
      assert.equal(high.thinkingLevel, "high"); assert.ok(high.maximum > low.maximum);
      const stored = (await db.query("select thinking_level from zebby_quotes where id=$1", [high.id])).rows[0];
      assert.equal(stored.thinking_level, "high");
      assert.deepEqual((await handle("GET", "/v1/catalog")).models.map((model) => model.id), ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra", "claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
      for (const model of ["unknown-model", "claude-sonnet-5-5"]) await assert.rejects(handle("POST", "/v1/quotes", { model, kind: "plan", input }));
      await assert.rejects(newQuote("off"));
      await assert.rejects(handle("POST", "/v1/quotes", { model: "gpt-6-astra", thinkingLevel: "off", kind: "plan", input }));
      await assert.rejects(handle("POST", "/v1/analysis", { quoteId: high.id, requestId: randomUUID(), input, thinkingLevel: "max" }));
      assert.equal(providerCalls, calls); assert.equal((await wallet()).reserved, 0);
      // Apply the additive migration twice to an existing quote without losing it.
      const migration = await readFile(new URL("../credits-service/migrations/20261010_analysis_thinking.sql", import.meta.url), "utf8");
      await db.exec(migration); await db.exec(migration);
      assert.equal((await db.query("select thinking_level from zebby_quotes where id=$1", [high.id])).rows[0].thinking_level, "high");
      // Reproduce the previous constraint, then upgrade twice without changing quotes or wallets.
      await db.exec("alter table zebby_quotes drop constraint zebby_quotes_thinking_level_check; alter table zebby_quotes add constraint zebby_quotes_thinking_level_check check(thinking_level in ('low','medium','high','xhigh','max'));");
      const beforeQuotes = (await db.query("select * from zebby_quotes order by id")).rows, beforeWallet = await wallet();
      const lunaMigration = await readFile(new URL("../credits-service/migrations/20261010_credit_luna.sql", import.meta.url), "utf8");
      await db.exec(lunaMigration); await db.exec(lunaMigration);
      assert.deepEqual((await db.query("select * from zebby_quotes order by id")).rows, beforeQuotes);
      assert.deepEqual(await wallet(), beforeWallet);
    });
    await t.test("quotes bind ownership and content, and duplicate analysis charges once", async () => {
      const quote = await newQuote(), id = randomUUID();
      await assert.rejects(analyze(quote.id, id, input, "other"), /fresh/);
      await assert.rejects(analyze(quote.id, id, { ...input, resumeText: input.resumeText + "invented" }));
      const response = await analyze(quote.id, id); assert.equal(response.result.score, 68); assert.equal(response.wallet.used, 100 * NANODOLLARS_PER_CREDIT);
      assert.equal(lastProviderRequest.reasoning.effort, "low"); assert.equal(lastProviderRequest.max_output_tokens, creditOutputLimit("plan", "low"));
      assert.equal(response.wallet.reserved, 0); const calls = providerCalls;
      await analyze(quote.id, id); assert.equal(providerCalls, calls); assert.equal((await wallet()).used, 100 * NANODOLLARS_PER_CREDIT);
      await assert.rejects(analyze(quote.id));
    });
    await t.test("lost paid replies recover with the same request, including after a restart before local save", async () => {
      let stored = "", loseReply = true;
      const source = { kind: "plan", id: randomUUID() }, quote = await newQuote(), before = (await wallet()).used, calls = providerCalls;
      const bridgeFetch = async (url, options) => {
        const parsed = new URL(url), body = options.body ? JSON.parse(options.body) : undefined;
        try {
          const result = await handle(options.method || "GET", parsed.pathname, body, "owner", options.signal);
          if (parsed.pathname === "/v1/analysis" && loseReply) { loseReply = false; throw new TypeError("Connection lost after settlement"); }
          return Response.json(result);
        } catch (error) { if (error instanceof TypeError) throw error; return Response.json({ error: error.message }, { status: error.status || 503 }); }
      };
      const options = { save: async (value) => { stored = value; }, onChange() {}, fetcher: bridgeFetch };
      const client = new CreditsClient(config.publicUrl, options);
      client.restore(JSON.stringify({ url: config.publicUrl, session: { access: "owner", refresh: "fixture", expires: Date.now() + 3600000, email: "peer@example.com", id: userId } }));
      assert.equal((await client.analyze(quote.id, input, new AbortController().signal, source)).score, 68);
      assert.equal(providerCalls, calls + 1); assert.equal((await wallet()).used, before + 100 * NANODOLLARS_PER_CREDIT);
      const originalId = JSON.parse(stored).pending[0].requestId;
      const restarted = new CreditsClient(config.publicUrl, options); restarted.restore(stored);
      const recovery = await restarted.recoveryQuote(source, input); assert.equal(recovery.recovery, true); assert.equal(recovery.maximum, 0);
      assert.equal((await restarted.analyze(quote.id, input, new AbortController().signal, source)).score, 68);
      assert.equal(JSON.parse(stored).pending[0].requestId, originalId); assert.equal(providerCalls, calls + 1);
      await restarted.acknowledge(quote.id); assert.equal(JSON.parse(stored).pending.length, 0);
      assert.equal((await wallet()).used, before + 100 * NANODOLLARS_PER_CREDIT);
    });
    await t.test("Luna High and Off pass through desktop quotes and charge only Luna usage", async () => {
      const client = new CreditsClient(config.publicUrl, { save: async () => {}, onChange() {}, fetcher: async (url, options) => {
        assert.equal(new URL(url).pathname, "/v1/quotes");
        return Response.json(await handle("POST", "/v1/quotes", JSON.parse(options.body)));
      } });
      client.restore(JSON.stringify({ url: config.publicUrl, session: { access: "owner", refresh: "fixture", expires: Date.now() + 3600000, email: "peer@example.com", id: userId } }));
      expectedModel = "gpt-6-luna";
      try {
        let highMaximum;
        for (const level of ["high", "off"]) {
          const before = await wallet(), quote = await client.quote("plan", input, expectedModel, level);
          assert.equal(quote.thinkingLevel, level);
          if (level === "high") highMaximum = quote.maximum; else assert.ok(quote.maximum < highMaximum);
          const response = await analyze(quote.id);
          assert.equal(lastProviderRequest.model, "gpt-6-luna");
          assert.equal(lastProviderRequest.reasoning.effort, level === "off" ? "none" : "high");
          assert.equal(lastProviderRequest.max_output_tokens, creditOutputLimit("plan", level));
          assert.equal(response.result.score, plan.score);
          const cost = usageCost(onlineModel("gpt-6-luna"), { input: 20000, cached: 0, output: Math.min(6000, creditOutputLimit("plan", level)) });
          assert.equal(response.wallet.used - before.used, cost);
          assert.equal(response.wallet.balance, before.balance - cost);
          assert.equal(response.wallet.reserved, 0);
        }
      } finally { expectedModel = "gpt-6.1-sol"; }
    });
    await t.test("malformed model output and provider failures refund the hold", async () => {
      const previous = await wallet(); failProvider = true;
      await assert.rejects(analyze((await newQuote()).id), /service error/); failProvider = false;
      providerResult = { ...plan, score: 101 }; await assert.rejects(analyze((await newQuote()).id)); providerResult = plan;
      assert.equal((await wallet()).balance, previous.balance); assert.equal((await wallet()).reserved, 0);
    });
    await t.test("cancelling propagates upstream and releases reserved credits", async () => {
      const previous = await wallet(), quote = await newQuote(), cancellation = new AbortController(); abortProvider = true;
      const result = analyze(quote.id, randomUUID(), input, "owner", cancellation.signal);
      const timer = setTimeout(() => cancellation.abort(new DOMException("Cancelled", "AbortError")), 150);
      await assert.rejects(result); clearTimeout(timer); abortProvider = false;
      assert.equal((await wallet()).reserved, 0); assert.equal((await wallet()).balance, previous.balance);
    });
    await t.test("holds reject overspending and restart cleanup releases abandoned holds", async () => {
      const available = (await wallet()).balance;
      await db.query("update zebby_wallets set balance=1000000 where user_id=$1", [userId]);
      const quote = await newQuote(); await assert.rejects(analyze(quote.id));
      await db.query("update zebby_wallets set balance=$2 where user_id=$1", [userId, available]);
      const fresh = await newQuote(), record = (await db.query("select content_hash from zebby_quotes where id=$1", [fresh.id])).rows[0];
      await rpc("reserve", { p_user: userId, p_id: randomUUID(), p_quote: fresh.id, p_hash: record.content_hash });
      assert.ok((await wallet()).reserved > 0);
      await db.exec("update zebby_runs set expires_at=now()-interval '1 minute' where status='reserved'");
      await service.cleanup(); assert.equal((await wallet()).reserved, 0);
    });
    await t.test("expired quotes and invalid authentication never invoke a provider", async () => {
      const quote = await newQuote(), calls = providerCalls;
      await db.query("update zebby_quotes set expires_at=now()-interval '1 second' where id=$1", [quote.id]);
      await assert.rejects(analyze(quote.id)); await assert.rejects(analyze(quote.id, randomUUID(), input, "invalid")); assert.equal(providerCalls, calls);
    });
    await t.test("tailored resumes migrate safely, preserve the chosen model and charge valid edits once", async () => {
      const migration = await readFile(new URL("../credits-service/migrations/20261031_tailored_resumes.sql", import.meta.url), "utf8");
      const before = await wallet();
      await db.exec("alter table zebby_quotes drop constraint zebby_quotes_kind_check; alter table zebby_quotes add constraint zebby_quotes_kind_check check(kind in ('plan','match'));");
      await db.exec(migration); await db.exec(migration);
      assert.deepEqual(await wallet(), before);
      const resumeInput = { ...input, resumeBlocks: [
        { id: 0, text: "Alex Morgan", style: "name", editable: false },
        { id: 1, text: "Led customer discovery and partnered with engineering to improve activation by 18%.", style: "bullet", editable: true },
      ], suggestedSummary: "", keywords: [], themes: [] };
      expectedModel = "gpt-6-luna";
      const quote = () => handle("POST", "/v1/quotes", { model: expectedModel, thinkingLevel: "high", kind: "resume", input: resumeInput });
      try {
        providerResult = { edits: [{ id: 0, text: "Invented name" }] };
        await assert.rejects(analyze((await quote()).id, randomUUID(), resumeInput));
        assert.equal((await wallet()).balance, before.balance);
        assert.equal((await wallet()).reserved, 0);
        providerResult = { edits: [{ id: 1, text: "Partnered with engineering on customer discovery, improving activation by 18%." }] };
        const quoted = await quote(), requestId = randomUUID();
        const response = await analyze(quoted.id, requestId, resumeInput);
        assert.deepEqual(response.result, providerResult);
        assert.equal(lastProviderRequest.model, "gpt-6-luna");
        assert.equal(lastProviderRequest.reasoning.effort, "high");
        assert.equal(lastProviderRequest.max_output_tokens, creditOutputLimit("resume", "high"));
        assert.equal(response.wallet.reserved, 0);
        const calls = providerCalls, charged = (await wallet()).used;
        await analyze(quoted.id, requestId, resumeInput);
        assert.equal(providerCalls, calls); assert.equal((await wallet()).used, charged);
      } finally { expectedModel = "gpt-6.1-sol"; providerResult = plan; }
    });
    await t.test("Boards credits are owner-gated, validate observed IDs, migrate safely and charge once", async () => {
      const before = await wallet(), quotes = (await db.query("select * from zebby_quotes order by id")).rows;
      const migration = await readFile(new URL("../credits-service/migrations/20261104_boards.sql", import.meta.url), "utf8");
      await db.exec(migration); await db.exec(migration);
      assert.deepEqual(await wallet(), before); assert.deepEqual((await db.query("select * from zebby_quotes order by id")).rows, quotes);
      const boardInput = { task: "listings", pageUrl: "https://jobs.uber.com/en/jobs/?team=Product", pageTitle: "Product jobs", summary: "Public listing links",
        candidates: [{ id: "l0", url: "https://jobs.uber.com/en/jobs/123/", text: "Product Manager" }], controls: [], expectedListingCount: 1 };
      const enabled = createService({ ...config, boardsWalletIds: [userId] }, { fetcher });
      const call = (method, path, value, token = "owner") => enabled.handle(method, path, value, token, controller.signal);
      const payload = { model: "gpt-6-luna", thinkingLevel: "high", kind: "board_extract", input: boardInput };
      const quote = () => call("POST", "/v1/quotes", payload);
      const calls = providerCalls;
      await assert.rejects(handle("POST", "/v1/quotes", payload), /not enabled/);
      await assert.rejects(call("POST", "/v1/quotes", payload, "other"), /not enabled/);
      assert.equal(providerCalls, calls);
      expectedModel = "gpt-6-luna";
      try {
        providerResult = { listingIds: ["invented"], nextControlId: "" };
        await assert.rejects(call("POST", "/v1/analysis", { quoteId: (await quote()).id, requestId: randomUUID(), input: boardInput }));
        assert.equal((await wallet()).balance, before.balance); assert.equal((await wallet()).reserved, 0);
        providerResult = { listingIds: ["l0"], nextControlId: "" };
        const quoted = await quote(), request = { quoteId: quoted.id, requestId: randomUUID(), input: boardInput };
        await assert.rejects(handle("POST", "/v1/analysis", request), /not enabled/);
        const response = await call("POST", "/v1/analysis", request);
        assert.deepEqual(response.result, providerResult); assert.equal(lastProviderRequest.model, "gpt-6-luna");
        assert.equal(lastProviderRequest.reasoning.effort, "high"); assert.equal(lastProviderRequest.text.format.name, "board_extract");
        const charged = (await wallet()).used, invoked = providerCalls;
        await call("POST", "/v1/analysis", request);
        assert.equal((await wallet()).used, charged); assert.equal(providerCalls, invoked);
        const roleInput = { task: "roles", criteria: "Senior or Principal Product Manager roles only.",
          candidates: [{ ...boardInput.candidates[0], title: "Product Manager", department: "Product" }] };
        const roleQuote = async () => (await call("POST", "/v1/quotes", { ...payload, input: roleInput })).id;
        providerResult = { decisions: {} };
        await assert.rejects(call("POST", "/v1/analysis", { quoteId: await roleQuote(), requestId: randomUUID(), input: roleInput }), /required format/);
        assert.equal((await wallet()).used, charged);
        providerResult = { decisions: { l0: false } };
        const classified = await call("POST", "/v1/analysis", { quoteId: await roleQuote(), requestId: randomUUID(), input: roleInput });
        assert.deepEqual(classified.result, providerResult);
        assert.deepEqual(lastProviderRequest.text.format.schema.properties.decisions.required, ["l0"]);
      } finally { expectedModel = "gpt-6.1-sol"; providerResult = plan; }
    });
    await t.test("refunds are cumulative and idempotent, and disputes freeze spending", async () => {
      const previous = (await wallet()).balance;
      const event = signature({ id: "evt_partial_refund", livemode: false, type: "charge.refunded", data: { object: { payment_intent: "pi_fixture", amount_refunded: 100, disputed: false } } });
      await service.webhook(event.raw, event.signature); await service.webhook(event.raw, event.signature);
      assert.equal((await wallet()).balance, previous - 100 * NANODOLLARS_PER_CREDIT);
      const equalIncrement = signature({ id: "evt_equal_refund", livemode: false, type: "charge.refunded", data: { object: { payment_intent: "pi_fixture", amount_refunded: 200, disputed: false } } });
      await service.webhook(equalIncrement.raw, equalIncrement.signature); await service.webhook(equalIncrement.raw, equalIncrement.signature);
      assert.equal((await wallet()).balance, previous - 200 * NANODOLLARS_PER_CREDIT);
      await rpc("reverse", { p_event: "evt_dispute", p_payment: "pi_fixture", p_refunded: 100, p_disputed: true });
      await assert.rejects(analyze((await newQuote()).id));
      await rpc("reverse", { p_event: "evt_won", p_payment: "pi_fixture", p_refunded: 100, p_disputed: false });
      await rpc("reverse", { p_event: "evt_full_refund", p_payment: "pi_fixture", p_refunded: 500, p_disputed: false });
      assert.ok((await wallet()).balance < 0); assert.equal((await wallet()).reserved, 0);
    });
    await t.test("ordinary signed-in clients cannot edit the ledger or call privileged functions", async () => {
      await assert.rejects(db.transaction(async (tx) => { await tx.exec("set local role authenticated"); await tx.query("update zebby_wallets set balance=999999999999"); }), /permission denied/);
      await assert.rejects(db.transaction(async (tx) => { await tx.exec("set local role anon"); await tx.query("select zebby_wallet($1)", [userId]); }), /permission denied/);
    });
  } finally { await db.close(); }
});
