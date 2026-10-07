// Offline tests: mocked HTTP, a throwaway key generated on the fly, no
// network, no real payment. Run: npm test
import assert from "node:assert/strict";
import test from "node:test";
import { generatePrivateKey } from "viem/accounts";

import {
  LITE_PRICE_USD,
  LITE_TOOL_DESCRIPTION,
  LITE_TOOL_NAME,
  TIERS,
  USDC_BASE,
  VerdixError,
  checkAddressRisk,
  checkAddressRiskAtTier,
  checkAddressRiskLite,
  getPricing,
  loadConfig,
  makeSelector,
} from "../src/verdix.js";

const ADDRESS = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const PAY_TO = "0x2e5a2170bd812997ae2e5b10921FB55fd0148ccF";
const option = (tier, amount, over = {}) => ({
  scheme: "exact",
  network: "eip155:8453",
  amount: String(amount),
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { tier, name: "USD Coin", version: "2" },
  ...over,
});
const ACCEPTS = [option("quick", 20000), option("standard", 100000), option("deep", 500000)];
const QUOTE = {
  x402Version: 2,
  resource: { url: "https://api.verdixapi.com/risk/address" },
  accepts: ACCEPTS,
};
const quoteHeader = Buffer.from(JSON.stringify(QUOTE)).toString("base64");
// Deliberately odd formatting: the tool must return it byte for byte.
const VERDICT = '{"address":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","chain":"base","tier":"quick","price_usd":0.02,"risk_score":5,"verdict":"safe","reasons":[],"checked":["ofac"],"as_of":"2026-09-26T00:00:00+00:00"}';

// The lite route's own quote: one `accepts`, $0.01.
const LITE_QUOTE_HEADER = Buffer.from(
  JSON.stringify({ x402Version: 2, resource: { url: "https://api.verdixapi.com/risk/address/lite" }, accepts: [option("lite", 10000)] }),
).toString("base64");
const LITE_VERDICT = '{"address":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913","chain":"base","tier":"lite","price_usd":0.01,"risk_score":10,"verdict":"no_known_risk","reasons":[],"checked":["ofac"],"as_of":"2026-10-06T00:00:00+00:00","limited_checks":true,"checks_performed":["ofac"],"not_checked":["address_age"],"full_check":"use quick"}';

/** Mock API: 402 + quote without a payment header, the verdict with one. */
// With no header given, each route answers with its own quote: the lite
// URL with LITE_QUOTE_HEADER, every other URL with the combined quote.
function mockApi(header, verdict = VERDICT) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const paid = req.headers.get("payment-signature") || req.headers.get("x-payment");
    calls.push({ method: req.method, url: req.url, paid: Boolean(paid), paidHeader: paid, body: req.method === "POST" ? await req.clone().text() : null });
    if (!paid) {
      return new Response("{}", { status: 402, headers: { "payment-required": header || (req.url.endsWith("/risk/address/lite") ? LITE_QUOTE_HEADER : quoteHeader), "content-type": "application/json" } });
    }
    return new Response(verdict, { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

test("no key configured: paid tool refuses, nothing sent", async () => {
  const cfg = loadConfig({});
  const { fetchImpl, calls } = mockApi();
  await assert.rejects(checkAddressRisk(cfg, { address: ADDRESS, tier: "quick" }, fetchImpl), /No wallet configured/);
  assert.equal(calls.length, 0);
});

test("malformed key: error never echoes it", () => {
  const secret = "0xdeadbeef-not-a-key-SENTINEL";
  const cfg = loadConfig({ VERDIX_PRIVATE_KEY: secret });
  assert.equal(cfg.account, null);
  assert.ok(cfg.keyError);
  assert.ok(!cfg.keyError.includes("SENTINEL"));
});

test("EVM_PRIVATE_KEY accepted as fallback; key without 0x accepted", () => {
  const key = generatePrivateKey();
  assert.ok(loadConfig({ EVM_PRIVATE_KEY: key }).account);
  assert.ok(loadConfig({ VERDIX_PRIVATE_KEY: key.slice(2) }).account);
});

test("unsubstituted desktop-extension placeholders count as unset", () => {
  const cfg = loadConfig({ VERDIX_PRIVATE_KEY: "${user_config.private_key}", VERDIX_MAX_PRICE_USD: "${user_config.max_price_usd}" });
  assert.equal(cfg.account, null);
  assert.equal(cfg.keyError, null);
  assert.equal(cfg.capError, null);
  assert.equal(cfg.maxPriceUsd, 0.1);
});

test("selector picks the requested tier", () => {
  assert.equal(makeSelector("standard", 0.1)(2, ACCEPTS).extra.tier, "standard");
  assert.equal(makeSelector("quick", 0.02)(2, ACCEPTS).amount, "20000");
});

test("selector refuses above the cap", () => {
  assert.throws(() => makeSelector("deep", 0.1)(2, ACCEPTS), /above your cap of \$0\.10/);
  assert.throws(() => makeSelector("quick", 0.01)(2, ACCEPTS), VerdixError);
});

test("selector refuses anything but USDC on Base mainnet", () => {
  assert.throws(() => makeSelector("quick", 1)(2, [option("quick", 20000, { network: "eip155:84532" })]), /expected USDC on Base/);
  assert.throws(() => makeSelector("quick", 1)(2, [option("quick", 20000, { asset: "0x" + "1".repeat(40) })]), /expected USDC on Base/);
  assert.throws(() => makeSelector("quick", 1)(2, [option("standard", 20000)]), /no payment option for tier "quick"/);
});

test("over the cap: refused after the quote, before any signature", async () => {
  const cfg = loadConfig({ VERDIX_PRIVATE_KEY: generatePrivateKey(), VERDIX_MAX_PRICE_USD: "0.01" });
  const { fetchImpl, calls } = mockApi();
  await assert.rejects(checkAddressRisk(cfg, { address: ADDRESS, tier: "quick" }, fetchImpl), /above your cap/);
  assert.equal(calls.length, 1, "only the unpaid request was made");
  assert.equal(calls[0].paid, false);
});

test("within the cap: pays the requested tier and returns the body unchanged", async () => {
  const cfg = loadConfig({ VERDIX_PRIVATE_KEY: generatePrivateKey(), VERDIX_MAX_PRICE_USD: "0.02" });
  const { fetchImpl, calls } = mockApi();
  const res = await checkAddressRisk(cfg, { address: ADDRESS, tier: "quick" }, fetchImpl);
  assert.equal(res.status, 200);
  assert.equal(res.body, VERDICT, "verdict JSON returned byte for byte");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].paid, true);
  assert.deepEqual(JSON.parse(calls[1].body), { address: ADDRESS, chain: "base", tier: "quick" });
  const signed = JSON.parse(Buffer.from(calls[1].paidHeader, "base64").toString("utf8"));
  assert.equal(signed.accepted.extra.tier, "quick");
  assert.equal(signed.accepted.amount, "20000");
  assert.equal(signed.payload.authorization.to.toLowerCase(), PAY_TO.toLowerCase());
  assert.equal(signed.payload.authorization.value, "20000");
  assert.equal(signed.payload.authorization.from.toLowerCase(), cfg.account.address.toLowerCase());
});

test("bad input rejected before any request", async () => {
  const cfg = loadConfig({ VERDIX_PRIVATE_KEY: generatePrivateKey() });
  const { fetchImpl, calls } = mockApi();
  await assert.rejects(checkAddressRisk(cfg, { address: "0x123", tier: "quick" }, fetchImpl), /40 hex/);
  await assert.rejects(checkAddressRisk(cfg, { address: ADDRESS, tier: "ultra" }, fetchImpl), /tier must be/);
  assert.equal(calls.length, 0);
});

test("invalid cap refuses paid calls", async () => {
  const cfg = loadConfig({ VERDIX_PRIVATE_KEY: generatePrivateKey(), VERDIX_MAX_PRICE_USD: "lots" });
  await assert.rejects(checkAddressRisk(cfg, { address: ADDRESS, tier: "quick" }, mockApi().fetchImpl), /VERDIX_MAX_PRICE_USD/);
});

test("checkAddressRiskAtTier posts to the tier's own URL without a tier field in the body", async () => {
  const cfg = loadConfig({ VERDIX_PRIVATE_KEY: generatePrivateKey(), VERDIX_MAX_PRICE_USD: "0.02" });
  const { fetchImpl, calls } = mockApi();
  const res = await checkAddressRiskAtTier(cfg, { address: ADDRESS, tier: "quick" }, fetchImpl);
  assert.equal(res.status, 200);
  assert.equal(res.body, VERDICT, "verdict JSON returned byte for byte");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.verdixapi.com/risk/address/quick");
  assert.equal(calls[1].url, "https://api.verdixapi.com/risk/address/quick");
  assert.deepEqual(JSON.parse(calls[1].body), { address: ADDRESS, chain: "base" });
  assert.equal(calls[1].paid, true);
});

test("checkAddressRiskAtTier refuses above the cap and bad input, same as checkAddressRisk", async () => {
  const cappedCfg = loadConfig({ VERDIX_PRIVATE_KEY: generatePrivateKey(), VERDIX_MAX_PRICE_USD: "0.01" });
  await assert.rejects(checkAddressRiskAtTier(cappedCfg, { address: ADDRESS, tier: "quick" }, mockApi().fetchImpl), /above your cap/);

  const cfg = loadConfig({ VERDIX_PRIVATE_KEY: generatePrivateKey() });
  await assert.rejects(checkAddressRiskAtTier(cfg, { address: "0x123", tier: "quick" }, mockApi().fetchImpl), /40 hex/);
  await assert.rejects(checkAddressRiskAtTier(cfg, { address: ADDRESS, tier: "ultra" }, mockApi().fetchImpl), /tier must be/);
});

test("get_pricing reads the unpaid quote and signs nothing", async () => {
  const cfg = loadConfig({ VERDIX_MAX_PRICE_USD: "0.10" });
  const { fetchImpl, calls } = mockApi();
  const p = await getPricing(cfg, fetchImpl);
  assert.deepEqual(p.tiers.map((t) => [t.tier, t.price_usd, t.within_your_cap]), [["quick", 0.02, true], ["standard", 0.1, true], ["deep", 0.5, false]]);
  assert.equal(p.tiers[0].asset.toLowerCase(), USDC_BASE);
  assert.equal(p.wallet_configured, false);
  assert.equal(calls.length, 2, "combined quote + lite quote");
  assert.ok(calls.every((c) => c.method === "GET" && !c.paid));
});

test("get_pricing: lite price in its own field, existing fields unchanged", async () => {
  const cfg = loadConfig({ VERDIX_MAX_PRICE_USD: "0.10" });
  const { fetchImpl, calls } = mockApi();
  const p = await getPricing(cfg, fetchImpl);
  // Exactly the 0.2.x fields, same values, plus `lite`.
  assert.deepEqual(Object.keys(p), ["api", "x402_version", "tiers", "your_max_price_usd", "wallet_configured", "wallet_address", "lite"]);
  assert.equal(p.api, "https://api.verdixapi.com/risk/address");
  assert.equal(p.x402_version, 2);
  assert.deepEqual(p.tiers.map((t) => t.tier), ["quick", "standard", "deep"], "lite not added to tiers");
  assert.deepEqual(Object.keys(p.tiers[0]), ["tier", "price_usd", "amount", "asset", "network", "pay_to", "within_your_cap"]);
  assert.equal(p.your_max_price_usd, 0.1);
  assert.equal(p.wallet_address, null);
  assert.equal(p.lite.tier, "lite");
  assert.equal(p.lite.price_usd, 0.01);
  assert.equal(p.lite.amount, "10000");
  assert.equal(p.lite.within_your_cap, true);
  assert.equal(p.lite.api, "https://api.verdixapi.com/risk/address/lite");
  assert.equal(p.lite.tool, "check_address_risk_lite");
  assert.equal(p.lite.never_safe, true);
  assert.equal(calls[1].url, "https://api.verdixapi.com/risk/address/lite");
  const capped = await getPricing(loadConfig({ VERDIX_MAX_PRICE_USD: "0.005" }), mockApi().fetchImpl);
  assert.equal(capped.lite.within_your_cap, false);
});

test("get_pricing: a failed lite quote leaves the rest intact (lite: null + lite_error)", async () => {
  const { fetchImpl: inner } = mockApi();
  const fetchImpl = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/risk/address/lite")) return new Response("down", { status: 502 });
    return inner(input, init);
  };
  const p = await getPricing(loadConfig({}), fetchImpl);
  assert.equal(p.tiers.length, 3);
  assert.equal(p.lite, null);
  assert.match(p.lite_error, /HTTP 502/);
});

test("lite: posts to /risk/address/lite, pays exactly $0.01, body unchanged, no tier field", async () => {
  const cfg = loadConfig({ VERDIX_PRIVATE_KEY: generatePrivateKey() });
  const { fetchImpl, calls } = mockApi(LITE_QUOTE_HEADER, LITE_VERDICT);
  const res = await checkAddressRiskLite(cfg, { address: ADDRESS }, fetchImpl);
  assert.equal(res.status, 200);
  assert.equal(res.body, LITE_VERDICT, "verdict JSON returned byte for byte");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://api.verdixapi.com/risk/address/lite");
  assert.equal(calls[1].url, "https://api.verdixapi.com/risk/address/lite");
  assert.deepEqual(JSON.parse(calls[1].body), { address: ADDRESS, chain: "base" });
  const signed = JSON.parse(Buffer.from(calls[1].paidHeader, "base64").toString("utf8"));
  assert.equal(signed.accepted.extra.tier, "lite");
  assert.equal(signed.payload.authorization.value, "10000");
  assert.equal(signed.payload.authorization.to.toLowerCase(), PAY_TO.toLowerCase());
});

test("lite: refused above the cap before any signature", async () => {
  const cfg = loadConfig({ VERDIX_PRIVATE_KEY: generatePrivateKey(), VERDIX_MAX_PRICE_USD: "0.005" });
  const { fetchImpl, calls } = mockApi(LITE_QUOTE_HEADER, LITE_VERDICT);
  await assert.rejects(checkAddressRiskLite(cfg, { address: ADDRESS }, fetchImpl), /lite tier costs \$0\.01, above your cap of \$0\.005 /);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].paid, false);
});

test("lite: never pays a non-lite option, even if the quote only offers one", async () => {
  const cfg = loadConfig({ VERDIX_PRIVATE_KEY: generatePrivateKey() });
  const { fetchImpl, calls } = mockApi(quoteHeader, VERDICT);
  await assert.rejects(checkAddressRiskLite(cfg, { address: ADDRESS }, fetchImpl), /no payment option for tier "lite"/);
  assert.ok(calls.every((c) => !c.paid));
});

test("lite: no wallet or bad address refused before any request", async () => {
  const { fetchImpl, calls } = mockApi(LITE_QUOTE_HEADER, LITE_VERDICT);
  await assert.rejects(checkAddressRiskLite(loadConfig({}), { address: ADDRESS }, fetchImpl), /No wallet configured/);
  await assert.rejects(checkAddressRiskLite(loadConfig({ VERDIX_PRIVATE_KEY: generatePrivateKey() }), { address: "0x123" }, fetchImpl), /40 hex/);
  assert.equal(calls.length, 0);
});

test("lite: kept out of TIERS, so check_address_risk and get_pricing are unchanged", () => {
  assert.deepEqual(TIERS, ["quick", "standard", "deep"]);
});

test("lite tool description: when to use it, never safe, quick for a safe verdict", () => {
  assert.equal(LITE_TOOL_NAME, "check_address_risk_lite");
  assert.equal(LITE_PRICE_USD, 0.01);
  const d = LITE_TOOL_DESCRIPTION;
  assert.match(d, /\$0\.01/);
  assert.match(d, /before sending it USDC/);
  assert.match(d, /no_known_risk/);
  assert.match(d, /NEVER returns "safe"/);
  assert.match(d, /check_address_risk_quick/);
  assert.ok(!/verdict \(safe/.test(d), "must not list safe as a possible verdict");
});
