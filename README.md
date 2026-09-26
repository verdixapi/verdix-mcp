# verdix-mcp: check an address before your agent sends it money

[![npm](https://img.shields.io/npm/v/verdix-mcp)](https://www.npmjs.com/package/verdix-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-com.verdixapi%2Fverdix-blue)](https://registry.modelcontextprotocol.io/v0/servers?search=com.verdixapi/verdix)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

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
| `get_pricing()` | Current prices, your price cap, and your wallet's public address | free |

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
- **Price cap.** `VERDIX_MAX_PRICE_USD` (default `0.10`) is the most one call may
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
| `VERDIX_PRIVATE_KEY` | for `check_address_risk` | none | Your Base wallet's private key (hex). `EVM_PRIVATE_KEY` is accepted too |
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

The payment receipt (payer, on-chain transaction) is in the tool result's `_meta`
under `com.verdixapi/payment`.

## Troubleshooting

- **"No wallet configured"**: `VERDIX_PRIVATE_KEY` isn't set in this server's `env` block.
- **"Refusing to pay: … above your cap"**: raise `VERDIX_MAX_PRICE_USD`, or use a cheaper tier.
- **"Verdix did not accept the payment"**: the wallet probably has too little USDC on Base.
  Call `get_pricing` to see the wallet address to fund.
- **Answer with HTTP 503**: a data source was down. You weren't charged; retry later.

## License

MIT
