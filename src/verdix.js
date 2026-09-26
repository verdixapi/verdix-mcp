// Verdix client: pricing quote (free) and paid address checks via x402.
//
// Payment always comes from the CALLER's wallet: the private key is read
// from the caller's own environment (VERDIX_PRIVATE_KEY, or EVM_PRIVATE_KEY),
// used only to sign the x402 payment locally, and never sent anywhere or
// logged. Before anything is signed, the requested tier's price is checked
// against a max-price cap (VERDIX_MAX_PRICE_USD, default 0.10), and only
// USDC on Base mainnet is accepted.

import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

export const DEFAULT_API_URL = "https://api.verdixapi.com";
export const DEFAULT_MAX_PRICE_USD = 0.1;
export const TIERS = ["quick", "standard", "deep"];
export const BASE_MAINNET = "eip155:8453";
export const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const USDC_DECIMALS = 6;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export class VerdixError extends Error {}

/** Settings from the caller's environment. The key is kept private: only
 *  the derived account (address + local signer) leaves this function. */
export function loadConfig(env = process.env) {
  // A desktop-extension host may pass an unset optional field through as its
  // literal "${user_config.x}" placeholder; treat that as unset.
  env = Object.fromEntries(Object.entries(env).filter(([, v]) => !(typeof v === "string" && v.startsWith("${"))));
  const apiUrl = (env.VERDIX_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");
  const rawCap = env.VERDIX_MAX_PRICE_USD;
  const maxPriceUsd = rawCap === undefined || rawCap === "" ? DEFAULT_MAX_PRICE_USD : Number(rawCap);
  const capError =
    Number.isFinite(maxPriceUsd) && maxPriceUsd >= 0
      ? null
      : `VERDIX_MAX_PRICE_USD must be a number of US dollars, got "${rawCap}"`;

  let account = null;
  let keyError = null;
  const rawKey = (env.VERDIX_PRIVATE_KEY || env.EVM_PRIVATE_KEY || "").trim();
  if (rawKey) {
    const key = rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`;
    if (/^0x[0-9a-fA-F]{64}$/.test(key)) {
      account = privateKeyToAccount(key);
    } else {
      // Never echo the value.
      keyError = "VERDIX_PRIVATE_KEY is not a 32-byte hex private key";
    }
  }
  return { apiUrl, maxPriceUsd, capError, account, keyError };
}

export function usdToAtomic(usd) {
  return BigInt(Math.round(usd * 10 ** USDC_DECIMALS));
}

function atomicToUsd(amount) {
  return Number(BigInt(amount)) / 10 ** USDC_DECIMALS;
}

function decodeBase64Json(value) {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

/** Pick the payment option for `tier`, refusing - before anything is
 *  signed - anything that isn't USDC on Base or costs more than the cap. */
export function makeSelector(tier, maxPriceUsd) {
  const cap = usdToAtomic(maxPriceUsd);
  return (_x402Version, accepts) => {
    const option = (accepts || []).find(
      (a) => a && a.extra && a.extra.tier === tier && a.scheme === "exact",
    );
    if (!option) {
      throw new VerdixError(`Verdix offered no payment option for tier "${tier}"`);
    }
    if (option.network !== BASE_MAINNET || String(option.asset).toLowerCase() !== USDC_BASE) {
      throw new VerdixError(
        `Refusing to pay: expected USDC on Base (${BASE_MAINNET}), got ${option.asset} on ${option.network}`,
      );
    }
    if (BigInt(option.amount) > cap) {
      throw new VerdixError(
        `Refusing to pay: the ${tier} tier costs $${atomicToUsd(option.amount).toFixed(2)}, ` +
          `above your cap of $${maxPriceUsd.toFixed(2)} (raise VERDIX_MAX_PRICE_USD to allow it)`,
      );
    }
    return option;
  };
}

/** Prices per tier, from the API's own unpaid quote. Free: nothing is signed. */
export async function getPricing(config, fetchImpl = fetch) {
  const resp = await fetchImpl(`${config.apiUrl}/risk/address`, { method: "GET" });
  const header = resp.headers.get("payment-required");
  if (resp.status !== 402 || !header) {
    throw new VerdixError(`Unexpected pricing answer from Verdix: HTTP ${resp.status}`);
  }
  const quote = decodeBase64Json(header);
  const tiers = (quote.accepts || [])
    .filter((a) => a.extra && a.extra.tier)
    .map((a) => ({
      tier: a.extra.tier,
      price_usd: atomicToUsd(a.amount),
      amount: String(a.amount),
      asset: a.asset,
      network: a.network,
      pay_to: a.payTo,
      within_your_cap: BigInt(a.amount) <= usdToAtomic(config.maxPriceUsd),
    }));
  return {
    api: `${config.apiUrl}/risk/address`,
    x402_version: quote.x402Version,
    tiers,
    your_max_price_usd: config.maxPriceUsd,
    wallet_configured: Boolean(config.account),
    wallet_address: config.account ? config.account.address : null,
  };
}

/** Paid check. Returns { status, body, payment }: `body` is Verdix's
 *  answer exactly as sent (unchanged), `payment` the decoded settlement
 *  receipt when one was returned. */
export async function checkAddressRisk(config, { address, tier = "standard", chain = "base" }, fetchImpl = fetch) {
  if (!ADDRESS_RE.test(address || "")) {
    throw new VerdixError("address must be 0x followed by 40 hex characters");
  }
  if (!TIERS.includes(tier)) {
    throw new VerdixError(`tier must be one of ${TIERS.join(", ")}`);
  }
  if (config.capError) throw new VerdixError(config.capError);
  if (config.keyError) throw new VerdixError(config.keyError);
  if (!config.account) {
    throw new VerdixError(
      "No wallet configured: set VERDIX_PRIVATE_KEY (a Base wallet holding a little USDC) " +
        "in this MCP server's environment. Verdix charges per call via x402.",
    );
  }

  // The x402 library wraps errors thrown by the selector; keep ours so the
  // caller sees the plain refusal.
  let refusal = null;
  const select = makeSelector(tier, config.maxPriceUsd);
  const payingFetch = wrapFetchWithPaymentFromConfig(fetchImpl, {
    schemes: [{ network: BASE_MAINNET, client: new ExactEvmScheme(config.account) }],
    paymentRequirementsSelector: (version, accepts) => {
      try {
        return select(version, accepts);
      } catch (err) {
        refusal = err;
        throw err;
      }
    },
  });
  let resp;
  try {
    resp = await payingFetch(`${config.apiUrl}/risk/address`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, chain, tier }),
    });
  } catch (err) {
    throw refusal || err;
  }
  const body = await resp.text();
  const receiptHeader = resp.headers.get("payment-response");
  let payment = null;
  if (receiptHeader) {
    try {
      payment = decodePaymentResponseHeader(receiptHeader);
    } catch {
      payment = null;
    }
  }
  return { status: resp.status, body, payment };
}
