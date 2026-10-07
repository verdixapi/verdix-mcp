// End-to-end over the real MCP protocol: spawns `node src/index.js` over
// stdio the way Claude Desktop / Cursor do, and calls its tools.
//
//   node test/mcp-client.mjs free   # live API, no payment (no key needed)
//   node test/mcp-client.mjs paid   # ONE real payment: quick tier ($0.02)
//   TEST_TIER=standard node test/mcp-client.mjs paid   # ONE $0.10 (deep: $0.50)
//   TEST_TIER=lite node test/mcp-client.mjs paid       # ONE $0.01 via check_address_risk_lite
//
// The paid mode needs VERDIX_PRIVATE_KEY in this process's environment and
// passes it only to the spawned server. It is never printed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generatePrivateKey } from "viem/accounts";

const mode = process.argv[2] || "free";
const ADDRESS = process.env.TEST_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

async function connect(env) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL("../src/index.js", import.meta.url).pathname],
    env: { PATH: process.env.PATH, ...env },
    stderr: "ignore",
  });
  const client = new Client({ name: "verdix-e2e", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const text = (r) => r.content.map((c) => c.text).join("\n");
let failed = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) failed++;
};

if (mode === "free") {
  let client = await connect({});
  const { tools } = await client.listTools();
  const expectedTools = JSON.stringify(
    [
      "check_address_risk",
      "check_address_risk_deep",
      "check_address_risk_quick",
      "check_address_risk_standard",
      "get_pricing",
      "check_address_risk_lite",
    ].sort(),
  );
  check(JSON.stringify(tools.map((t) => t.name).sort()) === expectedTools, `tools listed: ${tools.map((t) => t.name).join(", ")}`);
  const pricing = await client.callTool({ name: "get_pricing", arguments: {} });
  const p = JSON.parse(text(pricing));
  check(!pricing.isError && p.tiers.length === 3, `get_pricing (live): ${p.tiers.map((t) => `${t.tier} $${t.price_usd}`).join(", ")}; cap $${p.your_max_price_usd}; wallet ${p.wallet_configured}`);
  check(p.lite && p.lite.tier === "lite" && p.lite.price_usd === 0.01 && !p.tiers.some((t) => t.tier === "lite"), `get_pricing (live) lite field: $${p.lite && p.lite.price_usd}, tiers unchanged`);
  const noKey = await client.callTool({ name: "check_address_risk", arguments: { address: ADDRESS, tier: "quick" } });
  check(noKey.isError && /No wallet configured/.test(text(noKey)), `no wallet -> refused: ${text(noKey).slice(0, 70)}...`);
  const bad = await client.callTool({ name: "check_address_risk", arguments: { address: "0x1234", tier: "quick" } });
  check(bad.isError, `malformed address -> rejected by input schema`);
  const noKeyQuick = await client.callTool({ name: "check_address_risk_quick", arguments: { address: ADDRESS } });
  check(noKeyQuick.isError && /No wallet configured/.test(text(noKeyQuick)), `no wallet -> refused (quick tier tool): ${text(noKeyQuick).slice(0, 70)}...`);
  const lite = tools.find((t) => t.name === "check_address_risk_lite");
  check(Boolean(lite) && /NEVER returns "safe"/.test(lite.description) && /no_known_risk/.test(lite.description), "lite tool description says no_known_risk, never safe");
  const noKeyLite = await client.callTool({ name: "check_address_risk_lite", arguments: { address: ADDRESS } });
  check(noKeyLite.isError && /No wallet configured/.test(text(noKeyLite)), `no wallet -> refused (lite tool): ${text(noKeyLite).slice(0, 70)}...`);
  await client.close();

  // Lite costs $0.01, so it needs a cap below that to be refused by the
  // live 402 before anything is signed.
  client = await connect({ VERDIX_PRIVATE_KEY: generatePrivateKey(), VERDIX_MAX_PRICE_USD: "0.005" });
  const cappedLite = await client.callTool({ name: "check_address_risk_lite", arguments: { address: ADDRESS } });
  check(cappedLite.isError && /lite tier costs \$0\.01, above your cap of \$0\.005 /.test(text(cappedLite)), `live lite cap refusal: ${text(cappedLite)}`);
  await client.close();

  // Throwaway, unfunded key + a cap below the price: the live 402 must be
  // refused before anything is signed.
  client = await connect({ VERDIX_PRIVATE_KEY: generatePrivateKey(), VERDIX_MAX_PRICE_USD: "0.01" });
  const capped = await client.callTool({ name: "check_address_risk", arguments: { address: ADDRESS, tier: "quick" } });
  check(capped.isError && /above your cap/.test(text(capped)), `live cap refusal: ${text(capped)}`);
  const deep = await client.callTool({ name: "check_address_risk", arguments: { address: ADDRESS, tier: "deep" } });
  check(deep.isError && /deep tier costs \$0\.50/.test(text(deep)), `deep tier over default-style cap refused`);
  await client.close();
} else if (mode === "paid") {
  if (!process.env.VERDIX_PRIVATE_KEY) throw new Error("VERDIX_PRIVATE_KEY not set");
  // TEST_TIER=standard|deep|lite pays that tier instead; the cap is its exact price.
  const tier = process.env.TEST_TIER || "quick";
  const cap = { lite: "0.01", quick: "0.02", standard: "0.10", deep: "0.50" }[tier];
  if (!cap) throw new Error(`TEST_TIER must be lite, quick, standard or deep, got "${tier}"`);
  const client = await connect({
    VERDIX_PRIVATE_KEY: process.env.VERDIX_PRIVATE_KEY,
    VERDIX_MAX_PRICE_USD: cap,
    ...(process.env.VERDIX_API_URL ? { VERDIX_API_URL: process.env.VERDIX_API_URL } : {}),
  });
  console.log(`paying tier=${tier}, cap $${cap}`);
  const started = Date.now();
  const call =
    tier === "lite"
      ? { name: "check_address_risk_lite", arguments: { address: ADDRESS } }
      : { name: "check_address_risk", arguments: { address: ADDRESS, tier } };
  const res = await client.callTool(call, undefined, { timeout: 120000 });
  console.log(`tool answered in ${((Date.now() - started) / 1000).toFixed(1)}s, isError=${Boolean(res.isError)}`);
  console.log("VERDICT_JSON=" + text(res));
  console.log("PAYMENT=" + JSON.stringify(res._meta?.["com.verdixapi/payment"] ?? null));
  check(!res.isError, "paid check succeeded");
  if (tier === "lite") check(!/"verdict":\s*"safe"/.test(text(res)), "lite never answers safe");
  await client.close();
}
process.exit(failed ? 1 : 0);
