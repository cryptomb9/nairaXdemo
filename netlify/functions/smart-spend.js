"use strict";

const { createClient } = require("@supabase/supabase-js");
const { normalizeAsset, roundAsset } = require("./conversions");

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const ASSETS = ["NGN", "USDCX", "MON", "ETHX", "cirBTCX", "EURCX"];
const CRYPTO_ASSETS = new Set(["USDCX", "MON", "ETHX", "cirBTCX", "EURCX"]);
const STATIC_USD_PRICES = {
  USDCX: 1,
  EURCX: 1.08,
  ETHX: 3500,
  cirBTCX: 65000,
  MON: 1,
};

function json(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  return createClient(url, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
}

function getBearerToken(event) {
  const header = event.headers.authorization || event.headers.Authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

async function getAuthenticatedUser(supabase, event) {
  const token = getBearerToken(event);
  if (!token) throw new Error("Missing authorization token.");
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new Error("Invalid or expired session.");
  return data.user;
}

function toAmount(value, label = "amount") {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Enter a valid ${label}.`);
  return amount;
}

function getNgnUsdRate() {
  const rate = Number(process.env.NGN_USD_RATE || process.env.MANUAL_NGN_USD_RATE || 1400);
  return Number.isFinite(rate) && rate > 0 ? rate : 1400;
}

function getSpread() {
  const spread = Number(process.env.SPREAD_NGN || 5);
  return Number.isFinite(spread) && spread >= 0 ? spread : 5;
}

function getUsdPrice(asset) {
  const manual = Number(process.env[`${asset.toUpperCase()}_USD_RATE`] || 0);
  if (Number.isFinite(manual) && manual > 0) return { usdPrice: manual, source: "manual_env" };
  return { usdPrice: STATIC_USD_PRICES[asset] || 1, source: "smart_spend_fallback" };
}

function getLocalRate(asset, direction) {
  const baseRate = getNgnUsdRate();
  const spread = getSpread();
  const appliedRate = direction === "ngn_crypto_conversion" ? baseRate + spread : baseRate - spread;
  if (appliedRate <= 0) throw new Error("NGN/USD spread configuration is invalid.");
  const { usdPrice, source } = getUsdPrice(asset);
  return {
    rate: usdPrice * appliedRate,
    source,
    base_ngn_usd_rate: baseRate,
    spread_ngn: spread,
    applied_ngn_usd_rate: appliedRate,
  };
}

async function getBalances(supabase, userId) {
  const { data, error } = await supabase
    .from("balances")
    .select("asset_code, available")
    .eq("user_id", userId);
  if (error) throw error;
  return new Map((data || []).map((row) => [row.asset_code, Number(row.available || 0)]));
}

function getLagosDayBounds() {
  const lagosOffsetMs = 60 * 60 * 1000;
  const lagosNow = new Date(Date.now() + lagosOffsetMs);
  const startUtc = Date.UTC(lagosNow.getUTCFullYear(), lagosNow.getUTCMonth(), lagosNow.getUTCDate()) - lagosOffsetMs;
  return {
    start: new Date(startUtc).toISOString(),
    end: new Date(startUtc + 24 * 60 * 60 * 1000).toISOString(),
  };
}

async function getExternalNgnTransferCount(supabase, userId) {
  const { start, end } = getLagosDayBounds();
  const { count, error } = await supabase
    .from("ledger_transactions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("transaction_type", "simulated_external_bank_transfer")
    .eq("status", "posted")
    .gte("created_at", start)
    .lt("created_at", end);
  if (error) throw error;
  return count || 0;
}

function externalNgnFees(amount, usedCount) {
  const platformFee = usedCount >= 3 ? 10 : 0;
  const statutoryFee = amount >= 10000 ? 50 : 0;
  return { platformFee, statutoryFee, totalFee: platformFee + statutoryFee, usedCount };
}

async function buildCandidate(supabase, input, payAsset, balances, externalNgnUsed) {
  const receiveAsset = input.receive_asset;
  const receiveAmount = input.receive_amount;
  const recipientType = input.recipient_type;
  const payBalance = balances.get(payAsset) || 0;

  if (payAsset === receiveAsset) {
    let platformFee = 0;
    let statutoryFee = 0;
    let totalDeducted = receiveAmount;
    if (recipientType === "external_bank") {
      const fees = externalNgnFees(receiveAmount, externalNgnUsed);
      platformFee = fees.platformFee;
      statutoryFee = fees.statutoryFee;
      totalDeducted = roundAsset(receiveAmount + fees.totalFee, "NGN");
    }
    return {
      source_asset: payAsset,
      destination_asset: receiveAsset,
      receive_amount: receiveAmount,
      source_amount: receiveAmount,
      total_deducted: totalDeducted,
      platform_fee_amount: platformFee,
      statutory_fee_amount: statutoryFee,
      statutory_fee_source_amount: statutoryFee,
      rate_used: null,
      rate_source: "none",
      base_ngn_usd_rate: null,
      spread_ngn: 0,
      applied_ngn_usd_rate: null,
      conversion_required: false,
      can_execute: payBalance >= totalDeducted,
      available: payBalance,
    };
  }

  if (payAsset === "NGN" && CRYPTO_ASSETS.has(receiveAsset)) {
    const rate = getLocalRate(receiveAsset, "ngn_crypto_conversion");
    const ngnEquivalent = roundAsset(receiveAmount * rate.rate, "NGN");
    const platformFee = roundAsset(ngnEquivalent * 0.006, "NGN");
    const statutoryFee = ngnEquivalent >= 10000 ? 50 : 0;
    const totalDeducted = roundAsset(ngnEquivalent + platformFee + statutoryFee, "NGN");
    return {
      source_asset: "NGN",
      destination_asset: receiveAsset,
      receive_amount: receiveAmount,
      source_amount: ngnEquivalent,
      amount_ngn_equivalent: ngnEquivalent,
      total_deducted: totalDeducted,
      platform_fee_amount: platformFee,
      statutory_fee_amount: statutoryFee,
      statutory_fee_source_amount: statutoryFee,
      rate_used: rate.rate,
      rate_source: rate.source,
      base_ngn_usd_rate: rate.base_ngn_usd_rate,
      spread_ngn: rate.spread_ngn,
      applied_ngn_usd_rate: rate.applied_ngn_usd_rate,
      conversion_required: true,
      can_execute: payBalance >= totalDeducted,
      available: payBalance,
    };
  }

  if (CRYPTO_ASSETS.has(payAsset) && receiveAsset === "NGN") {
    const rate = getLocalRate(payAsset, "crypto_ngn_conversion");
    const sourceAmount = roundAsset(receiveAmount / rate.rate, payAsset);
    const platformFee = roundAsset(sourceAmount * 0.006, payAsset);
    const statutoryFee = receiveAmount >= 10000 ? 50 : 0;
    const statutorySource = statutoryFee > 0 ? roundAsset(statutoryFee / rate.rate, payAsset) : 0;
    const totalDeducted = roundAsset(sourceAmount + platformFee + statutorySource, payAsset);
    return {
      source_asset: payAsset,
      destination_asset: "NGN",
      receive_amount: receiveAmount,
      source_amount: sourceAmount,
      amount_ngn_equivalent: receiveAmount,
      total_deducted: totalDeducted,
      platform_fee_amount: platformFee,
      statutory_fee_amount: statutoryFee,
      statutory_fee_source_amount: statutorySource,
      rate_used: rate.rate,
      rate_source: rate.source,
      base_ngn_usd_rate: rate.base_ngn_usd_rate,
      spread_ngn: rate.spread_ngn,
      applied_ngn_usd_rate: rate.applied_ngn_usd_rate,
      conversion_required: true,
      can_execute: payBalance >= totalDeducted,
      available: payBalance,
    };
  }

  return null;
}

async function buildPreview(supabase, userId, body) {
  const recipientType = String(body.recipient_type || body.recipientType || "").trim();
  const receiveAsset = normalizeAsset(body.receive_asset || body.receiveAsset || body.asset || "NGN");
  const receiveAmount = roundAsset(toAmount(body.receive_amount || body.receiveAmount || body.amount), receiveAsset);
  const preferredPayAsset = body.preferred_pay_asset || body.preferredPayAsset
    ? normalizeAsset(body.preferred_pay_asset || body.preferredPayAsset)
    : null;

  if (!["nairax_user", "external_bank", "external_wallet"].includes(recipientType)) {
    throw new Error("Unsupported recipient type.");
  }
  if (!ASSETS.includes(receiveAsset)) throw new Error("Unsupported receive asset.");
  if (recipientType === "external_bank" && receiveAsset !== "NGN") throw new Error("External bank recipients must receive NGN.");
  if (recipientType === "external_wallet") throw new Error("Smart Spend auto-conversion for external wallets is not enabled yet. Use direct external crypto send.");

  const balances = await getBalances(supabase, userId);
  const externalNgnUsed = recipientType === "external_bank" ? await getExternalNgnTransferCount(supabase, userId) : 0;
  const candidateAssets = preferredPayAsset
    ? [preferredPayAsset]
    : [
      receiveAsset,
      receiveAsset === "NGN" ? "USDCX" : "NGN",
      ...ASSETS,
    ].filter(Boolean);
  const seen = new Set();
  const candidates = [];
  for (const asset of candidateAssets) {
    if (seen.has(asset) || !ASSETS.includes(asset)) continue;
    seen.add(asset);
    const candidate = await buildCandidate(supabase, { recipient_type: recipientType, receive_asset: receiveAsset, receive_amount: receiveAmount }, asset, balances, externalNgnUsed);
    if (candidate) candidates.push(candidate);
  }

  const selected = candidates.find((candidate) => candidate.can_execute) || candidates[0];
  if (!selected) throw new Error("No supported Smart Spend funding route was found.");

  return {
    recipient_type: recipientType,
    recipient_identifier: String(body.recipient_identifier || body.recipientIdentifier || body.recipient || ""),
    receive_asset: receiveAsset,
    receive_amount: receiveAmount,
    narration: body.narration ? String(body.narration) : null,
    bank_name: body.bankName || body.bank_name ? String(body.bankName || body.bank_name) : null,
    recipient_name: body.accountName || body.recipient_name ? String(body.accountName || body.recipient_name) : null,
    selected,
    alternatives: candidates,
    message: selected.can_execute
      ? `You are paying with ${selected.source_asset}. Recipient receives ${receiveAmount} ${receiveAsset}.`
      : `Insufficient balance. Best route needs ${selected.total_deducted} ${selected.source_asset}.`,
  };
}

async function executeSmartSpend(supabase, userId, preview) {
  if (!preview.selected.can_execute) throw new Error("Insufficient balance for Smart Spend.");
  const { data, error } = await supabase.rpc("smart_spend_execute", {
    p_sender_user_id: userId,
    p_recipient_type: preview.recipient_type,
    p_recipient_identifier: preview.recipient_identifier,
    p_bank_name: preview.bank_name,
    p_recipient_name: preview.recipient_name,
    p_receive_asset: preview.receive_asset,
    p_receive_amount: preview.receive_amount,
    p_source_asset: preview.selected.source_asset,
    p_source_amount: preview.selected.source_amount,
    p_total_deducted: preview.selected.total_deducted,
    p_platform_fee_amount: preview.selected.platform_fee_amount,
    p_statutory_fee_amount: preview.selected.statutory_fee_amount,
    p_statutory_fee_source_amount: preview.selected.statutory_fee_source_amount,
    p_rate_used: preview.selected.rate_used,
    p_spread_ngn: preview.selected.spread_ngn,
    p_applied_ngn_usd_rate: preview.selected.applied_ngn_usd_rate,
    p_rate_source: preview.selected.rate_source,
    p_conversion_required: preview.selected.conversion_required,
    p_narration: preview.narration,
  });
  if (error) throw error;
  return data;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const supabase = getServiceClient();
    const user = await getAuthenticatedUser(supabase, event);
    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "");
    const preview = await buildPreview(supabase, user.id, body);
    if (action === "preview") return json(200, preview);
    if (action === "execute") {
      const transactionId = await executeSmartSpend(supabase, user.id, preview);
      return json(200, { transactionId, preview });
    }
    return json(400, { error: "Unsupported Smart Spend action." });
  } catch (error) {
    const message = error.message || "Smart Spend failed.";
    const statusCode = /missing authorization|invalid or expired/i.test(message) ? 401 : 400;
    return json(statusCode, { error: message });
  }
};
