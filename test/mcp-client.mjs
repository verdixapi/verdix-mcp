// End-to-end over the real MCP protocol: spawns `node src/index.js` over
// stdio the way Claude Desktop / Cursor do, and calls its tools.
//
//   node test/mcp-client.mjs free   # live API, no payment (no key needed)
//   node test/mcp-client.mjs paid   # ONE real payment: quick tier ($0.02)
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
  check(JSON.stringify(tools.map((t) => t.name).sort()) === '["check_address_risk","get_pricing"]', `tools listed: ${tools.map((t) => t.name).join(", ")}`);
  const pricing = await client.callTool({ name: "get_pricing", arguments: {} });
  const p = JSON.parse(text(pricing));
  check(!pricing.isError && p.tiers.length === 3, `get_pricing (live): ${p.tiers.map((t) => `${t.tier} $${t.price_usd}`).join(", ")}; cap $${p.your_max_price_usd}; wallet ${p.wallet_configured}`);
  const noKey = await client.callTool({ name: "check_address_risk", arguments: { address: ADDRESS, tier: "quick" } });
  check(noKey.isError && /No wallet configured/.test(text(noKey)), `no wallet -> refused: ${text(noKey).slice(0, 70)}...`);
  const bad = await client.callTool({ name: "check_address_risk", arguments: { address: "0x1234", tier: "quick" } });
  check(bad.isError, `malformed address -> rejected by input schema`);
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
  const client = await connect({
    VERDIX_PRIVATE_KEY: process.env.VERDIX_PRIVATE_KEY,
    VERDIX_MAX_PRICE_USD: "0.02",
    ...(process.env.VERDIX_API_URL ? { VERDIX_API_URL: process.env.VERDIX_API_URL } : {}),
  });
  const started = Date.now();
  const res = await client.callTool({ name: "check_address_risk", arguments: { address: ADDRESS, tier: "quick" } }, undefined, { timeout: 120000 });
  console.log(`tool answered in ${((Date.now() - started) / 1000).toFixed(1)}s, isError=${Boolean(res.isError)}`);
  console.log("VERDICT_JSON=" + text(res));
  console.log("PAYMENT=" + JSON.stringify(res._meta?.["com.verdixapi/payment"] ?? null));
  check(!res.isError, "paid check succeeded");
  await client.close();
}
process.exit(failed ? 1 : 0);
