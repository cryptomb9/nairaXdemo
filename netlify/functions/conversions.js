"use strict";

const { createClient } = require("@supabase/supabase-js");

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const CRYPTO_ASSETS = new Set(["USDCX", "MON", "ETHX", "cirBTCX", "EURCX"]);
const PRICE_MAP = {
  USDCX: ["USDC"],
  EURCX: ["EUR", "EURC"],
  ETHX: ["ETH"],
  cirBTCX: ["BTC"],
  MON: ["MON"],
};

const STATIC_USD_FALLBACKS = {
  USDCX: { usdPrice: 1, source: "fallback_static_usdc" },
  EURCX: { usdPrice: 1.08, source: "fallback_static_eur" },
  ETHX: { usdPrice: 3500, source: "fallback_static_eth" },
  cirBTCX: { usdPrice: 65000, source: "fallback_static_btc" },
  MON: { usdPrice: 1, source: "fallback_static_mon" },
};

const PRICE_CACHE_TTL_MS = 5 * 60 * 1000;
let priceCache = null;
const rateSaveWarnings = new Set();

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

function normalizeAsset(asset) {
  const raw = String(asset || "").trim();
  if (raw.toUpperCase() === "CIRBTCX") return "cirBTCX";
  return raw.toUpperCase();
}

function roundAsset(value, asset) {
  const decimals = asset === "NGN" ? 2 : 8;
  const factor = 10 ** decimals;
  return Math.round(Number(value) * factor) / factor;
}

function toAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a valid conversion amount.");
  return amount;
}

function getManualUsdRate(asset) {
  const key = `${asset.toUpperCase()}_USD_RATE`;
  const value = Number(process.env[key] || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function fallbackUsdPrice(asset) {
  const manual = getManualUsdRate(asset);
  if (manual) return { usdPrice: manual, source: "manual_env", error: null };
  if (asset === "EURCX") {
    const eur = Number(process.env.EUR_USD_RATE || STATIC_USD_FALLBACKS.EURCX.usdPrice);
    return { usdPrice: Number.isFinite(eur) && eur > 0 ? eur : STATIC_USD_FALLBACKS.EURCX.usdPrice, source: "fallback_static_eur", error: null };
  }
  const fallback = STATIC_USD_FALLBACKS[asset];
  if (fallback) return { ...fallback, error: null };
  return { usdPrice: null, source: "unavailable", error: `${asset}_USD_RATE is not configured and Coinbase price fetch failed.` };
}

async function fetchCoinbaseUsdPrice(asset) {
  const mappedAssets = PRICE_MAP[asset];
  if (!mappedAssets) throw new Error(`No Coinbase price mapping for ${asset}.`);
  if (mappedAssets.includes("MON")) {
    const manual = getManualUsdRate(asset);
    if (manual) return { usdPrice: manual, pricePair: "MON/USD manual" };
    throw new Error("MON_USD_RATE is required before converting MON.");
  }

  let lastError = null;
  for (const mapped of mappedAssets) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200);
    try {
      const response = await fetch(`https://api.coinbase.com/v2/prices/${mapped}-USD/spot`, {
        headers: { "Accept": "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Coinbase price fetch failed for ${mapped}/USD.`);
      const payload = await response.json();
      const amount = Number(payload?.data?.amount);
      if (!Number.isFinite(amount) || amount <= 0) throw new Error(`Invalid Coinbase price for ${mapped}/USD.`);
      return { usdPrice: amount, pricePair: `${mapped}/USD` };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error(`Coinbase price fetch failed for ${asset}.`);
}

async function getNgnUsdRate(supabase) {
  const manual = Number(process.env.NGN_USD_RATE || process.env.MANUAL_NGN_USD_RATE || 0);
  if (Number.isFinite(manual) && manual > 0) return { rate: manual, source: "manual_env" };

  const { data, error } = await supabase
    .from("exchange_rates")
    .select("rate, source")
    .eq("base_asset", "USD")
    .eq("quote_asset", "NGN")
    .order("fetched_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (data?.rate) return { rate: Number(data.rate), source: data.source || "manual_db" };

  return { rate: 1400, source: "manual_default" };
}

async function saveRate(supabase, baseAsset, quoteAsset, rate, source) {
  const { error } = await supabase.from("exchange_rates").insert({
    base_asset: baseAsset,
    quote_asset: quoteAsset,
    rate,
    source,
  });
  if (error && process.env.DEBUG_EXCHANGE_RATE_SAVES === "true") {
    const key = `${baseAsset}/${quoteAsset}:${error.message}`;
    if (!rateSaveWarnings.has(key)) {
      rateSaveWarnings.add(key);
      console.warn("exchange_rates save skipped:", error.message);
    }
  }
}

function getSpread() {
  const spread = Number(process.env.SPREAD_NGN || 5);
  return Number.isFinite(spread) && spread >= 0 ? spread : 5;
}

async function getRate(supabase, cryptoAsset, direction) {
  const { rate: ngnUsd, source: ngnSource } = await getNgnUsdRate(supabase);
  const spread = getSpread();
  const adjustedNgnUsd = direction === "ngn_crypto_conversion" ? ngnUsd + spread : ngnUsd - spread;
  const rateQuoteAsset = direction === "ngn_crypto_conversion" ? "NGN_BUY" : "NGN_SELL";
  if (adjustedNgnUsd <= 0) throw new Error("NGN/USD spread configuration is invalid.");

  let usdPrice;
  let source;
  let pair;

  try {
    const fetched = await fetchCoinbaseUsdPrice(cryptoAsset);
    usdPrice = fetched.usdPrice;
    pair = fetched.pricePair;
    source = "coinbase";
  } catch (error) {
    const fallback = fallbackUsdPrice(cryptoAsset);
    if (fallback.usdPrice) {
      usdPrice = fallback.usdPrice;
      source = fallback.source;
      pair = `${cryptoAsset}/USD fallback`;
    } else {
      const { data, error: dbError } = await supabase
        .from("exchange_rates")
        .select("rate, source")
        .eq("base_asset", cryptoAsset)
        .eq("quote_asset", rateQuoteAsset)
        .order("fetched_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (dbError) throw dbError;
      if (data?.rate) return { rate: Number(data.rate), source: data.source || "stored_fallback" };
      throw error;
    }
  }

  const ngnRate = usdPrice * adjustedNgnUsd;
  await saveRate(supabase, "USD", "NGN", ngnUsd, ngnSource);
  await saveRate(supabase, "USD", rateQuoteAsset, adjustedNgnUsd, `${ngnSource}_spread_${spread}`);
  await saveRate(supabase, cryptoAsset, "USD", usdPrice, source);
  await saveRate(supabase, cryptoAsset, rateQuoteAsset, ngnRate, `${source}_${direction}`);
  return { rate: ngnRate, source, base_ngn_usd_rate: ngnUsd, spread_ngn: spread, applied_ngn_usd_rate: adjustedNgnUsd, price_pair: pair };
}

async function getAssetPrices(supabase) {
  if (priceCache && Date.now() - priceCache.cachedAt < PRICE_CACHE_TTL_MS) {
    return { ...priceCache.data, cached: true };
  }

  const { rate: baseNgnUsdRate, source: ngnSource } = await getNgnUsdRate(supabase);
  const spread = getSpread();
  const buyRate = baseNgnUsdRate + spread;
  const sellRate = baseNgnUsdRate - spread;
  const now = new Date().toISOString();
  const prices = [{
    asset_symbol: "NGN",
    usd_price: baseNgnUsdRate > 0 ? 1 / baseNgnUsdRate : null,
    ngn_mid_price: 1,
    ngn_buy_price: 1,
    ngn_sell_price: 1,
    source: ngnSource,
    updated_at: now,
    error: null,
  }];

  const cryptoRows = await Promise.all(Array.from(CRYPTO_ASSETS).map(async (asset) => {
    let usdPrice = null;
    let source = "coinbase";
    let error = null;
    try {
      const fetched = await fetchCoinbaseUsdPrice(asset);
      usdPrice = fetched.usdPrice;
      source = fetched.pricePair;
    } catch (fetchError) {
      const fallback = fallbackUsdPrice(asset);
      usdPrice = fallback.usdPrice;
      source = fallback.source;
      error = fallback.error || fetchError.message || null;
    }

    return {
      asset_symbol: asset,
      usd_price: usdPrice,
      ngn_mid_price: usdPrice ? usdPrice * baseNgnUsdRate : null,
      ngn_buy_price: usdPrice ? usdPrice * buyRate : null,
      ngn_sell_price: usdPrice ? usdPrice * sellRate : null,
      source,
      updated_at: now,
      error,
    };
  }));
  prices.push(...cryptoRows);

  const data = {
    base_ngn_usd_rate: baseNgnUsdRate,
    spread_ngn: spread,
    ngn_buy_rate: buyRate,
    ngn_sell_rate: sellRate,
    prices,
    updated_at: now,
  };

  priceCache = { cachedAt: Date.now(), data };

  Promise.allSettled([
    saveRate(supabase, "USD", "NGN", baseNgnUsdRate, ngnSource),
    saveRate(supabase, "USD", "NGN_BUY", buyRate, `${ngnSource}_spread_${spread}`),
    saveRate(supabase, "USD", "NGN_SELL", sellRate, `${ngnSource}_spread_${spread}`),
    ...cryptoRows
      .filter((row) => row.usd_price)
      .flatMap((row) => [
        saveRate(supabase, row.asset_symbol, "USD", row.usd_price, row.source),
        saveRate(supabase, row.asset_symbol, "NGN", row.ngn_mid_price, row.source),
        saveRate(supabase, row.asset_symbol, "NGN_BUY", row.ngn_buy_price, row.source),
        saveRate(supabase, row.asset_symbol, "NGN_SELL", row.ngn_sell_price, row.source),
      ]),
  ]).catch((error) => console.warn("exchange_rates batch save skipped:", error.message));

  return data;
}

async function buildPreview(supabase, fromAsset, toAsset, rawAmount) {
  const amount = toAmount(rawAmount);
  if (fromAsset === toAsset) throw new Error("Choose two different assets.");
  if (fromAsset !== "NGN" && toAsset !== "NGN") throw new Error("Phase 9 supports NGN-to-crypto and crypto-to-NGN only.");
  const cryptoAsset = fromAsset === "NGN" ? toAsset : fromAsset;
  if (!CRYPTO_ASSETS.has(cryptoAsset)) throw new Error(`Unsupported conversion asset: ${cryptoAsset}`);

  const direction = fromAsset === "NGN" ? "ngn_crypto_conversion" : "crypto_ngn_conversion";
  const { rate, source, base_ngn_usd_rate: baseNgnUsdRate, spread_ngn: spreadNgn, applied_ngn_usd_rate: appliedNgnUsdRate, price_pair: pricePair } = await getRate(supabase, cryptoAsset, direction);

  if (direction === "ngn_crypto_conversion") {
    const platformFee = roundAsset(amount * 0.006, "NGN");
    const statutoryFee = amount >= 10000 ? 50 : 0;
    const totalDeducted = roundAsset(amount + platformFee + statutoryFee, "NGN");
    const toAmountValue = roundAsset(amount / rate, cryptoAsset);
    return {
      direction,
      from_asset: fromAsset,
      to_asset: toAsset,
      from_amount: roundAsset(amount, "NGN"),
      to_amount: toAmountValue,
      amount_ngn_equivalent: roundAsset(amount, "NGN"),
      rate_used: rate,
      rate_source: source,
      base_ngn_usd_rate: baseNgnUsdRate,
      spread_ngn: spreadNgn,
      applied_ngn_usd_rate: appliedNgnUsdRate,
      price_pair: pricePair,
      platform_fee_amount: platformFee,
      statutory_fee_amount: statutoryFee,
      statutory_fee_source_amount: statutoryFee,
      total_fee_amount: roundAsset(platformFee + statutoryFee, "NGN"),
      total_deducted: totalDeducted,
      fee_asset: "NGN",
      receiver_gets: toAmountValue,
      fee_breakdown: {
        amount: roundAsset(amount, "NGN"),
        platform_fee: platformFee,
        statutory_fee: statutoryFee,
        gas_fee_estimate: 0,
        total_fee: roundAsset(platformFee + statutoryFee, "NGN"),
        total_deducted: totalDeducted,
        receiver_gets: toAmountValue,
      },
    };
  }

  const ngnAmount = roundAsset(amount * rate, "NGN");
  const platformFeeSource = roundAsset(amount * 0.006, cryptoAsset);
  const statutoryFeeNgn = ngnAmount >= 10000 ? 50 : 0;
  const statutorySource = statutoryFeeNgn > 0 ? roundAsset(statutoryFeeNgn / rate, cryptoAsset) : 0;
  const totalDeducted = roundAsset(amount + platformFeeSource + statutorySource, cryptoAsset);
  return {
    direction,
    from_asset: fromAsset,
    to_asset: toAsset,
    from_amount: roundAsset(amount, cryptoAsset),
    to_amount: ngnAmount,
    amount_ngn_equivalent: ngnAmount,
    rate_used: rate,
    rate_source: source,
    base_ngn_usd_rate: baseNgnUsdRate,
    spread_ngn: spreadNgn,
    applied_ngn_usd_rate: appliedNgnUsdRate,
    price_pair: pricePair,
    platform_fee_amount: platformFeeSource,
    statutory_fee_amount: statutoryFeeNgn,
    statutory_fee_source_amount: statutorySource,
    total_fee_amount: roundAsset(platformFeeSource + statutorySource, cryptoAsset),
    total_deducted: totalDeducted,
    fee_asset: cryptoAsset,
    receiver_gets: ngnAmount,
    fee_breakdown: {
      amount: roundAsset(amount, cryptoAsset),
      platform_fee: platformFeeSource,
      statutory_fee: statutorySource,
      statutory_fee_ngn: statutoryFeeNgn,
      gas_fee_estimate: 0,
      total_fee: roundAsset(platformFeeSource + statutorySource, cryptoAsset),
      total_deducted: totalDeducted,
      receiver_gets: ngnAmount,
    },
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const supabase = getServiceClient();
    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "");

    if (action === "prices") {
      return json(200, await getAssetPrices(supabase));
    }

    const user = await getAuthenticatedUser(supabase, event);

    if (action === "preview") {
      const preview = await buildPreview(
        supabase,
        normalizeAsset(body.from_asset || body.fromAsset),
        normalizeAsset(body.to_asset || body.toAsset),
        body.amount,
      );
      return json(200, preview);
    }

    if (action === "convert") {
      const preview = await buildPreview(
        supabase,
        normalizeAsset(body.from_asset || body.fromAsset),
        normalizeAsset(body.to_asset || body.toAsset),
        body.amount,
      );
      const { data, error } = await supabase.rpc("execute_asset_conversion", {
        p_user_id: user.id,
        p_from_asset: preview.from_asset,
        p_to_asset: preview.to_asset,
        p_from_amount: preview.from_amount,
        p_to_amount: preview.to_amount,
        p_rate_used: preview.rate_used,
        p_amount_ngn_equivalent: preview.amount_ngn_equivalent,
        p_platform_fee_amount: preview.platform_fee_amount,
        p_statutory_fee_amount: preview.statutory_fee_amount,
        p_statutory_fee_source_amount: preview.statutory_fee_source_amount,
        p_total_fee_amount: preview.total_fee_amount,
        p_total_deducted: preview.total_deducted,
        p_rate_source: preview.rate_source,
      });
      if (error) throw error;
      return json(200, { transactionId: data, preview });
    }

    return json(400, { error: "Unsupported conversion action." });
  } catch (error) {
    const message = error.message || "Conversion request failed.";
    const statusCode = /missing authorization|invalid or expired/i.test(message) ? 401 : 400;
    return json(statusCode, { error: message });
  }
};

module.exports.buildConversionPreview = buildPreview;
module.exports.getConversionRate = getRate;
module.exports.getAssetPrices = getAssetPrices;
module.exports.normalizeAsset = normalizeAsset;
module.exports.roundAsset = roundAsset;
