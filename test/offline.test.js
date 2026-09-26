// Offline tests: mocked HTTP, a throwaway key generated on the fly, no
// network, no real payment. Run: npm test
import assert from "node:assert/strict";
import test from "node:test";
import { generatePrivateKey } from "viem/accounts";

import { USDC_BASE, VerdixError, checkAddressRisk, getPricing, loadConfig, makeSelector } from "../src/verdix.js";

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

/** Mock API: 402 + quote without a payment header, the verdict with one. */
function mockApi() {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const paid = req.headers.get("payment-signature") || req.headers.get("x-payment");
    calls.push({ method: req.method, url: req.url, paid: Boolean(paid), paidHeader: paid, body: req.method === "POST" ? await req.clone().text() : null });
    if (!paid) {
      return new Response("{}", { status: 402, headers: { "payment-required": quoteHeader, "content-type": "application/json" } });
    }
    return new Response(VERDICT, { status: 200, headers: { "content-type": "application/json" } });
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

test("get_pricing reads the unpaid quote and signs nothing", async () => {
  const cfg = loadConfig({ VERDIX_MAX_PRICE_USD: "0.10" });
  const { fetchImpl, calls } = mockApi();
  const p = await getPricing(cfg, fetchImpl);
  assert.deepEqual(p.tiers.map((t) => [t.tier, t.price_usd, t.within_your_cap]), [["quick", 0.02, true], ["standard", 0.1, true], ["deep", 0.5, false]]);
  assert.equal(p.tiers[0].asset.toLowerCase(), USDC_BASE);
  assert.equal(p.wallet_configured, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].paid, false);
});
