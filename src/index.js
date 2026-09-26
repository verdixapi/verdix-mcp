#!/usr/bin/env node
// Verdix MCP server (stdio). Tools:
//   check_address_risk(address, tier) - paid via x402 from the caller's wallet
//   get_pricing()                     - free
// stdout carries the MCP protocol only; diagnostics go to stderr.

import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { TIERS, VerdixError, checkAddressRisk, getPricing, loadConfig } from "./verdix.js";

const { version: VERSION } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const config = loadConfig();

const server = new McpServer({ name: "verdix", version: VERSION });

function errorResult(message, extra = {}) {
  return { isError: true, content: [{ type: "text", text: message }], ...extra };
}

server.registerTool(
  "check_address_risk",
  {
    title: "Check an address before sending it funds",
    description:
      "Screen an EVM address on Base before sending it money or interacting with it. Returns Verdix's " +
      "verdict JSON unchanged: verdict (safe | caution | danger), risk_score (0-100), reasons, checked, " +
      "tier, price_usd, as_of. 'danger' means sanctioned, a known scam/exploit/phishing address, an " +
      "address-poisoning lookalike, a burn address or similar - do not send funds. 'caution' means not " +
      "enough evidence to call it safe (new, unverified, or a data source was unavailable) - confirm " +
      "with the user first. PAID: each call costs USDC on Base via x402, paid from the wallet configured " +
      "in this server (VERDIX_PRIVATE_KEY), never more than VERDIX_MAX_PRICE_USD. Tiers: quick ($0.02), " +
      "standard ($0.10, default), deep ($0.50); call get_pricing for current prices. A 503 answer " +
      "(data unavailable) is not charged.",
    inputSchema: {
      address: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/, "0x followed by 40 hex characters")
        .describe("The EVM address to check (the recipient, contract or counterparty)"),
      tier: z
        .enum(TIERS)
        .default("standard")
        .describe("Analysis depth and price: quick ($0.02), standard ($0.10), deep ($0.50)"),
    },
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ address, tier }) => {
    try {
      const { status, body, payment } = await checkAddressRisk(config, { address, tier });
      const meta = payment ? { _meta: { "com.verdixapi/payment": payment } } : {};
      if (status === 200) {
        let structured;
        try {
          structured = JSON.parse(body);
        } catch {
          structured = undefined;
        }
        return {
          content: [{ type: "text", text: body }],
          ...(structured && typeof structured === "object" ? { structuredContent: structured } : {}),
          ...meta,
        };
      }
      const why =
        status === 503
          ? "Verdix could not complete the check (a data source was unavailable); you were not charged. Retry later. "
          : status === 402
            ? "Verdix did not accept the payment (check the wallet's USDC balance on Base). "
            : `Verdix answered HTTP ${status}. `;
      return errorResult(why + body, meta);
    } catch (err) {
      const message = err instanceof VerdixError ? err.message : `Payment or request failed: ${err && err.message}`;
      return errorResult(message);
    }
  },
);

server.registerTool(
  "get_pricing",
  {
    title: "Verdix prices per tier",
    description:
      "Free. Current Verdix price per tier (USDC on Base, via x402), the payment recipient, your " +
      "configured max price per call, and whether a wallet is configured (with its public address, " +
      "so it can be funded). Nothing is signed or paid.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const pricing = await getPricing(config);
      return { content: [{ type: "text", text: JSON.stringify(pricing, null, 2) }], structuredContent: pricing };
    } catch (err) {
      return errorResult(`Could not fetch pricing: ${err && err.message}`);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `verdix-mcp ${VERSION} ready (api ${config.apiUrl}, max $${config.maxPriceUsd} per call, ` +
    `wallet ${config.account ? config.account.address : "not configured"})`,
);
