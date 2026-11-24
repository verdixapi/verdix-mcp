# verdix-mcp: check an address before your agent sends it money

[![npm](https://img.shields.io/npm/v/verdix-mcp)](https://www.npmjs.com/package/verdix-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-com.verdixapi%2Fverdix-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=com.verdixapi/verdix)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![verdixapi/verdix-mcp MCP server](https://glama.ai/mcp/servers/verdixapi/verdix-mcp/badges/score.svg)](https://glama.ai/mcp/servers/verdixapi/verdix-mcp)

An [MCP](https://modelcontextprotocol.io) server that lets your AI agent check an
EVM address on **Base** before sending it funds or approving a contract. It calls
[Verdix](https://api.verdixapi.com), which answers **safe**, **caution** or **danger**
with the reasons. It checks:

- OFAC sanctions
- scam, phishing and exploit lists
- **address-poisoning lookalikes**, built from a live watch of every token transfer on Base
- contract age, code and provenance
- burn addresses

Each check is paid per call in USDC on Base via [x402](https://x402.org), **from
your own wallet**. There is no account, no API key and no subscription. Your key
never leaves your machine, and a price cap is enforced before anything is signed.

> *"Send 50 USDC to 0x4c3f…9e21"*: the agent calls `check_address_risk` first,
> gets `"verdict": "danger", "reasons": ["address_poisoning"]`, and stops to ask you.

| Tool | What it does | Cost |
|---|---|---|
| `check_address_risk(address, tier)` | Verdix's verdict JSON, returned unchanged | quick $0.02 · standard $0.10 (default) · deep $0.50 |
| `check_address_risk_quick(address)` | Same, pinned to the quick tier | $0.02 |
| `check_address_risk_standard(address)` | Same, pinned to the standard tier | $0.10 |
| `check_address_risk_deep(address)` | Same, pinned to the deep tier | $0.50 |
| `check_address_risk_lite(address, chain)` | Cheapest check; never answers `safe` (see [Lite](#lite-001-never-safe)). `chain`: `base` (default) or `ethereum` (daily data, see [Ethereum](#ethereum-lite-and-free-lookup-daily-not-live)) | $0.01 |
| `check_address_poisoning(address, chain)` | Has Verdix's poisoning watcher flagged this address? Base (live) or Ethereum (daily). Not a safety verdict | free |
| `get_pricing()` | Current prices (lite in its own `lite` field), your price cap, and your wallet's public address | free |

`check_address_risk` takes a `tier` argument, but an agent framework whose x402
client always pays the **first** price it's offered will end up paying quick
regardless of what `tier` it asked for. The three `check_address_risk_<tier>`
tools avoid that: each calls Verdix's single-tier endpoint
(`/risk/address/<tier>`), which offers exactly one price, so any x402 client
pays the tier the tool name says. Use whichever is simpler for your client;
both reach the same risk checks.

### Lite ($0.01, never "safe")

`check_address_risk_lite` is the cheapest check, meant for a quick screen
before sending USDC to an address you don't know. It calls
`/risk/address/lite`, which checks OFAC sanctions, scam and phishing lists,
address-poisoning lookalikes, burn addresses, phishing tokens and flagged
contract deployers. It skips address age and the caution-only contract checks.

Its verdict is `no_known_risk`, `caution` or `danger`, **never `safe`**.
`no_known_risk` only means the address is on none of those lists. It is not a
safety verdict. If you need `safe` (say, before a large transfer), use
`check_address_risk_quick` ($0.02). The answer also carries `limited_checks:
true`, `checks_performed`, `not_checked` and `full_check`. `get_pricing` lists
quick/standard/deep in `tiers`, as before, and lite's price in a separate
`lite` field.

### Ethereum (lite and free lookup, daily, not live)

Since 0.4.0, `check_address_risk_lite` and `check_address_poisoning` take an
optional `chain`: `base` (the default, unchanged) or `ethereum` (Ethereum
mainnet). Every other tool stays Base only.

- **Lite on Ethereum** ($0.01, still paid in USDC **on Base**) checks OFAC
  sanctions, scam and phishing lists, burn addresses and address-poisoning
  lookalikes. Phishing-token and deployer checks are Base only, and there is
  no quick/standard/deep for Ethereum.
- The Ethereum poisoning data comes from a **daily scan, not live**. Every
  Ethereum answer carries `data_through` (the last complete UTC day) and
  `coverage: "daily, not live"`. A lookalike planted after `data_through`
  isn't seen yet. If the data is out of date, Verdix answers 503 and you
  aren't charged.
- `check_address_poisoning` is free (no wallet, nothing signed) and calls
  `GET /check/api`. It answers only `flagged`, `first_seen` and `kind` (plus
  `data_through`/`coverage` on Ethereum). `flagged: false` is **not** a safety
  verdict: it covers address poisoning only. It's rate-limited per IP (30 per
  minute, 500 per day).

```json
{"flagged": false, "first_seen": null, "kind": null, "data_through": "2026-10-30", "coverage": "daily, not live"}
```

## What you need

- **Node.js 18 or newer** (it runs through `npx`, so there's nothing to install).
- **A Base wallet holding a little USDC.** You don't need ETH for gas: x402
  payments are signed by you and settled on-chain by the payment facilitator.
  Use a **dedicated wallet with a small balance** (a few dollars) for your agent,
  not your main wallet.

## Safety

- **Your key stays on your machine.** It is read from this server's environment
  and used only to sign each payment locally. It is never sent to Verdix or
  anywhere else, and never logged.
- **Price cap.** `VERDIX_MAX_PRICE_USD` (default `0.10`, enough for lite, quick and standard) is the most one call may
  cost. A call above it is refused **before anything is signed**. To allow the
  deep tier, set it to `0.50`.
- **Only USDC on Base mainnet.** Any other asset or network is refused.
- **You pay only for complete answers.** If Verdix can't complete a check (a data
  source is down), it answers 503 and the payment is not settled.

## Setup

Replace `0xYOUR_PRIVATE_KEY` with the key of your dedicated Base wallet.

### Claude Desktop: one-click extension

1. Download `verdix-mcp-<version>.mcpb` from the
   [latest release](https://github.com/verdixapi/verdix-mcp/releases/latest).
2. In Claude Desktop, open **Settings → Extensions** and drag the file in.
3. Click **Install**, then enter your wallet key and price cap.

The key is stored in your OS keychain. Node.js doesn't need to be installed, because
Claude Desktop runs the extension with its own Node.js.

### Claude Desktop: config file

Open *Settings → Developer → Edit Config*, which opens `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Add:

```json
{
  "mcpServers": {
    "verdix": {
      "command": "npx",
      "args": ["-y", "verdix-mcp"],
      "env": {
        "VERDIX_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY",
        "VERDIX_MAX_PRICE_USD": "0.10"
      }
    }
  }
}
```

Then restart Claude Desktop.

### Cursor

Put the same block in `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json`
(one project):

```json
{
  "mcpServers": {
    "verdix": {
      "command": "npx",
      "args": ["-y", "verdix-mcp"],
      "env": {
        "VERDIX_PRIVATE_KEY": "0xYOUR_PRIVATE_KEY",
        "VERDIX_MAX_PRICE_USD": "0.10"
      }
    }
  }
}
```

Don't commit a project-level `.cursor/mcp.json` that contains your key.

### Claude Code

```bash
claude mcp add verdix -e VERDIX_PRIVATE_KEY=0xYOUR_PRIVATE_KEY -e VERDIX_MAX_PRICE_USD=0.10 -- npx -y verdix-mcp
```

### Agent frameworks

Any MCP client that can launch a stdio server works. The command is
`npx -y verdix-mcp`, with the environment variables below. Python example with the
official MCP SDK:

```python
from mcp import StdioServerParameters

verdix = StdioServerParameters(
    command="npx",
    args=["-y", "verdix-mcp"],
    env={"VERDIX_PRIVATE_KEY": os.environ["AGENT_WALLET_KEY"], "VERDIX_MAX_PRICE_USD": "0.10"},
)
```

## Environment variables

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `VERDIX_PRIVATE_KEY` | for the paid check tools (not `get_pricing` or `check_address_poisoning`) | none | Your Base wallet's private key (hex). `EVM_PRIVATE_KEY` is accepted too |
| `VERDIX_MAX_PRICE_USD` | no | `0.10` | Most one call may cost, in USD |
| `VERDIX_API_URL` | no | `https://api.verdixapi.com` | Only for testing against another deployment |

## What an answer looks like

`check_address_risk` returns Verdix's JSON exactly as the API sent it:

```json
{
  "address": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  "chain": "base",
  "tier": "quick",
  "price_usd": 0.02,
  "risk_score": 5,
  "verdict": "safe",
  "reasons": [],
  "checked": ["ofac", "scam_lists", "poisoning_watch", "onchain_age", "contract_code", "burn_list", "provenance"],
  "as_of": "2026-09-26T13:15:10.524501+00:00"
}
```

- **`danger`**: sanctioned, a known scam, exploit or phishing address, an
  address-poisoning lookalike, a burn address and similar. Don't send funds.
- **`caution`**: not enough evidence to call it safe. For example, it's new, an
  unverified contract, or one of the data sources was unavailable. Ask the user
  before sending.
- **`safe`**: every check ran and found nothing.
- **`no_known_risk`** (lite only, instead of `safe`): none of lite's lists know
  the address. Not a safety verdict; use quick if you need one.

The payment receipt (payer, on-chain transaction) is in the tool result's `_meta`
under `com.verdixapi/payment`.

## Troubleshooting

- **"No wallet configured"**: `VERDIX_PRIVATE_KEY` isn't set in this server's `env` block.
- **"Refusing to pay: … above your cap"**: raise `VERDIX_MAX_PRICE_USD`, or use a cheaper tier
  (lite is $0.01).
- **"Verdix did not accept the payment"**: the wallet probably has too little USDC on Base.
  Call `get_pricing` to see the wallet address to fund.
- **Answer with HTTP 503**: a data source was down. You weren't charged; retry later.

## License

MIT
