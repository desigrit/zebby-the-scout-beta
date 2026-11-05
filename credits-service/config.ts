import { trustedProxyHops } from "./client-address.ts";
import { isIP } from "node:net";

export type ServiceConfig = { supabaseUrl: string; supabaseKey: string; publicUrl: string; stripeKey: string;
  stripeWebhookSecret: string; openaiKey: string; anthropicKey: string; live: boolean; port: number; trustedProxyHops?: number; bindAddress?: string;
  boardsWalletIds?: string[] };
export function serviceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  function required(key: string) { const value = env[key]?.trim(); if (!value) throw new Error(`Set ${key} before starting the credits service.`); return value; }
  function https(value: string) { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Service URLs must use HTTPS."); return url.origin; }
  const stripeKey = required("STRIPE_SECRET_KEY"), live = env.ZEBBY_ALLOW_LIVE_PAYMENTS === "true";
  const stripePrefixes = live ? ["sk_live_", "rk_live_"] : ["sk_test_", "rk_test_"];
  if (!stripePrefixes.some((prefix) => stripeKey.startsWith(prefix))) throw new Error("The Stripe secret key must match the configured payment mode.");
  const bindAddress = env.ZEBBY_BIND_ADDRESS?.trim() || "0.0.0.0";
  if (!isIP(bindAddress)) throw new Error("ZEBBY_BIND_ADDRESS must be an IP address.");
  return { supabaseUrl: https(required("SUPABASE_URL")), supabaseKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    publicUrl: https(required("ZEBBY_PUBLIC_SERVICE_URL")), stripeKey, stripeWebhookSecret: required("STRIPE_WEBHOOK_SECRET"),
    openaiKey: env.OPENAI_API_KEY || "", anthropicKey: env.ANTHROPIC_API_KEY || "", live, port: Number(env.PORT || 8080),
    trustedProxyHops: trustedProxyHops(env.ZEBBY_TRUST_PROXY_HOPS), bindAddress,
    boardsWalletIds: (env.ZEBBY_BOARDS_WALLET_IDS || "").split(",").map(value => value.trim()).filter(Boolean) };
}
