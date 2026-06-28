"use strict";

const { createClient } = require("@supabase/supabase-js");
const { ethers } = require("ethers");
const crypto = require("crypto");

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

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const NETWORKS = {
  "Arc Testnet": { env: "ARC_TESTNET_RPC_URL", chainId: 5042002 },
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

function roundToDecimals(value, decimals) {
  const factor = 10 ** Math.min(Number(decimals || 18), 18);
  return Math.round(Number(value) * factor) / factor;
}

function parseTokenUnits(value, decimals) {
  const rounded = roundToDecimals(value, decimals);
  return ethers.parseUnits(rounded.toFixed(Number(decimals)), Number(decimals));
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

function getProvider(network) {
  const config = NETWORKS[network];
  if (!config) throw new Error(`Unsupported swap network: ${network}`);
  const rpcUrl = process.env[config.env];
  if (!rpcUrl) throw new Error(`${config.env} is required for on-chain swaps.`);
  return new ethers.JsonRpcProvider(rpcUrl, config.chainId);
}

function requirePrivateKey(envName) {
  const privateKey = process.env[envName];
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error(`${envName} must be configured as a valid EVM private key.`);
  }
  return privateKey;
}

function getTreasuryWallet(provider) {
  return new ethers.Wallet(requirePrivateKey("TREASURY_WALLET_PRIVATE_KEY"), provider);
}

function getFeeWalletAddress() {
  return new ethers.Wallet(requirePrivateKey("FEE_WALLET_PRIVATE_KEY")).address;
}

async function waitForSwapTx(tx, label) {
  const confirmations = Number(process.env.SWAP_WAIT_CONFIRMATIONS || 0);
  if (!Number.isFinite(confirmations) || confirmations <= 0) return;
  const receipt = await tx.wait(confirmations);
  if (!receipt || receipt.status !== 1) throw new Error(`${label} failed on-chain.`);
}

function decryptPrivateKey(encryptedPrivateKey) {
  const secret = process.env.WALLET_ENCRYPTION_SECRET;
  if (!secret || secret.length < 32) throw new Error("WALLET_ENCRYPTION_SECRET must be set to at least 32 characters.");
  const payload = JSON.parse(encryptedPrivateKey);
  const key = crypto.createHash("sha256").update(secret).digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
  decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

async function getUserWallet(supabase, userId, provider) {
  const { data, error } = await supabase
    .from("custodial_wallets")
    .select("wallet_address, encrypted_private_key")
    .eq("user_id", userId)
    .eq("chain_type", "EVM")
    .maybeSingle();
  if (error) throw error;
  if (!data?.encrypted_private_key || !ethers.isAddress(data.wallet_address)) {
    throw new Error("User custodial wallet is missing or invalid.");
  }
  const wallet = new ethers.Wallet(decryptPrivateKey(data.encrypted_private_key), provider);
  if (wallet.address.toLowerCase() !== data.wallet_address.toLowerCase()) {
    throw new Error("Custodial wallet key does not match stored wallet address.");
  }
  return wallet;
}

async function getProfile(supabase, userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("wallet_address")
    .eq("id", userId)
    .single();
  if (error) throw error;
  if (!data?.wallet_address || !ethers.isAddress(data.wallet_address)) throw new Error("User wallet address is missing.");
  return data;
}

async function getToken(supabase, symbol, network) {
  const { data, error } = await supabase
    .from("supported_tokens")
    .select("symbol, decimals, network, chain_id, contract_address, is_active, explorer_base_url")
    .eq("symbol", symbol)
    .eq("network", network)
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.is_active) throw new Error(`${symbol} is not active on ${network}.`);
  if (!ethers.isAddress(data.contract_address)) throw new Error(`${symbol} contract address is invalid.`);
  return data;
}

function explorerUrl(token, txHash) {
  return token.explorer_base_url && txHash ? `${token.explorer_base_url.replace(/\/$/, "")}/tx/${txHash}` : null;
}

async function settleCryptoFeeFromTreasury(supabase, preview, network, provider, treasury) {
  if (!CRYPTO_ASSETS.has(preview.from_asset) || Number(preview.platform_fee_amount || 0) <= 0) {
    return { fee_tx_hash: null, fee_wallet_address: null, fee_settlement_status: "not_required", fee_token_contract: null, fee_settlement_error: null };
  }

  const feeWalletAddress = getFeeWalletAddress();
  const sourceToken = await getToken(supabase, preview.from_asset, network);
  const feeUnits = parseTokenUnits(preview.platform_fee_amount, Number(sourceToken.decimals));
  if (feeUnits <= 0n) {
    return { fee_tx_hash: null, fee_wallet_address: feeWalletAddress, fee_settlement_status: "not_required", fee_token_contract: sourceToken.contract_address, fee_settlement_error: null };
  }

  try {
    const contract = new ethers.Contract(sourceToken.contract_address, ERC20_ABI, treasury);
    const [treasuryTokenBalance, treasuryNativeBalance] = await Promise.all([
      contract.balanceOf(treasury.address),
      provider.getBalance(treasury.address),
    ]);
    if (treasuryTokenBalance < feeUnits) {
      return {
        fee_tx_hash: null,
        fee_wallet_address: feeWalletAddress,
        fee_settlement_status: "pending_treasury_liquidity",
        fee_token_contract: sourceToken.contract_address,
        fee_settlement_error: `Treasury needs ${preview.from_asset} liquidity to settle swap fees on-chain.`,
      };
    }
    if (treasuryNativeBalance <= 0n) {
      return {
        fee_tx_hash: null,
        fee_wallet_address: feeWalletAddress,
        fee_settlement_status: "pending_gas",
        fee_token_contract: sourceToken.contract_address,
        fee_settlement_error: "Treasury wallet needs native gas to settle swap fees.",
      };
    }

    const feeTx = await contract.transfer(feeWalletAddress, feeUnits);
    await waitForSwapTx(feeTx, "Treasury fee settlement");
    return {
      fee_tx_hash: feeTx.hash,
      fee_wallet_address: feeWalletAddress,
      fee_settlement_status: "submitted",
      fee_token_contract: sourceToken.contract_address,
      fee_settlement_error: null,
    };
  } catch (error) {
    return {
      fee_tx_hash: null,
      fee_wallet_address: feeWalletAddress,
      fee_settlement_status: "failed",
      fee_token_contract: sourceToken.contract_address,
      fee_settlement_error: error.message || "Treasury fee settlement failed.",
    };
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
  if (fromAsset !== "NGN" && !CRYPTO_ASSETS.has(fromAsset)) throw new Error(`Unsupported conversion asset: ${fromAsset}`);
  if (toAsset !== "NGN" && !CRYPTO_ASSETS.has(toAsset)) throw new Error(`Unsupported conversion asset: ${toAsset}`);

  const direction = fromAsset === "NGN"
    ? "ngn_crypto_conversion"
    : (toAsset === "NGN" ? "crypto_ngn_conversion" : "crypto_crypto_conversion");

  if (direction === "ngn_crypto_conversion") {
    const { rate, source, base_ngn_usd_rate: baseNgnUsdRate, spread_ngn: spreadNgn, applied_ngn_usd_rate: appliedNgnUsdRate, price_pair: pricePair } = await getRate(supabase, toAsset, direction);
    const platformFee = roundAsset(amount * 0.006, "NGN");
    const statutoryFee = amount >= 10000 ? 50 : 0;
    const totalDeducted = roundAsset(amount + platformFee + statutoryFee, "NGN");
    const toAmountValue = roundAsset(amount / rate, toAsset);
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

  const sourceRate = await getRate(supabase, fromAsset, "crypto_ngn_conversion");
  const preliminaryNetSource = amount / 1.006;
  const preliminaryNgn = preliminaryNetSource * sourceRate.rate;
  const statutoryFeeNgn = direction === "crypto_ngn_conversion" && preliminaryNgn >= 10000 ? 50 : 0;
  const statutorySource = statutoryFeeNgn > 0 ? roundAsset(statutoryFeeNgn / sourceRate.rate, fromAsset) : 0;
  const convertibleSource = roundAsset((amount - statutorySource) / 1.006, fromAsset);
  const platformFeeSource = roundAsset(amount - statutorySource - convertibleSource, fromAsset);
  const ngnAmount = roundAsset(convertibleSource * sourceRate.rate, "NGN");

  if (direction === "crypto_crypto_conversion") {
    const destinationRate = await getRate(supabase, toAsset, "ngn_crypto_conversion");
    const destinationAmount = roundAsset(ngnAmount / destinationRate.rate, toAsset);
    const effectiveRate = roundAsset(destinationAmount / amount, toAsset);
    return {
      direction,
      from_asset: fromAsset,
      to_asset: toAsset,
      from_amount: convertibleSource,
      to_amount: destinationAmount,
      amount_ngn_equivalent: ngnAmount,
      rate_used: effectiveRate,
      source_rate_used: sourceRate.rate,
      destination_rate_used: destinationRate.rate,
      rate_source: `${sourceRate.source}/${destinationRate.source}`,
      base_ngn_usd_rate: sourceRate.base_ngn_usd_rate,
      spread_ngn: sourceRate.spread_ngn,
      applied_ngn_usd_rate: null,
      source_applied_ngn_usd_rate: sourceRate.applied_ngn_usd_rate,
      destination_applied_ngn_usd_rate: destinationRate.applied_ngn_usd_rate,
      price_pair: `${sourceRate.price_pair} -> ${destinationRate.price_pair}`,
      platform_fee_amount: platformFeeSource,
      statutory_fee_amount: statutoryFeeNgn,
      statutory_fee_source_amount: statutorySource,
      total_fee_amount: roundAsset(platformFeeSource + statutorySource, fromAsset),
      total_deducted: roundAsset(amount, fromAsset),
      fee_asset: fromAsset,
      receiver_gets: destinationAmount,
      fee_breakdown: {
        amount: roundAsset(amount, fromAsset),
        converted_source_amount: convertibleSource,
        platform_fee: platformFeeSource,
        statutory_fee: statutorySource,
        statutory_fee_ngn: statutoryFeeNgn,
        gas_fee_estimate: 0,
        total_fee: roundAsset(platformFeeSource + statutorySource, fromAsset),
        total_deducted: roundAsset(amount, fromAsset),
        receiver_gets: destinationAmount,
      },
    };
  }

  return {
    direction,
    from_asset: fromAsset,
    to_asset: toAsset,
    from_amount: convertibleSource,
    to_amount: ngnAmount,
    amount_ngn_equivalent: ngnAmount,
    rate_used: sourceRate.rate,
    rate_source: sourceRate.source,
    base_ngn_usd_rate: sourceRate.base_ngn_usd_rate,
    spread_ngn: sourceRate.spread_ngn,
    applied_ngn_usd_rate: sourceRate.applied_ngn_usd_rate,
    price_pair: sourceRate.price_pair,
    platform_fee_amount: platformFeeSource,
    statutory_fee_amount: statutoryFeeNgn,
    statutory_fee_source_amount: statutorySource,
    total_fee_amount: roundAsset(platformFeeSource + statutorySource, fromAsset),
    total_deducted: roundAsset(amount, fromAsset),
    fee_asset: fromAsset,
    receiver_gets: ngnAmount,
    fee_breakdown: {
      amount: roundAsset(amount, fromAsset),
      converted_source_amount: convertibleSource,
      platform_fee: platformFeeSource,
      statutory_fee: statutorySource,
      statutory_fee_ngn: statutoryFeeNgn,
      gas_fee_estimate: 0,
      total_fee: roundAsset(platformFeeSource + statutorySource, fromAsset),
      total_deducted: roundAsset(amount, fromAsset),
      receiver_gets: ngnAmount,
    },
  };
}

async function settleSwapOnChain(supabase, userId, preview, network = "Arc Testnet") {
  const profile = await getProfile(supabase, userId);

  if (preview.to_asset === "NGN") {
    const provider = getProvider(network);
    const treasury = getTreasuryWallet(provider);
    const feeSettlement = await settleCryptoFeeFromTreasury(supabase, preview, network, provider, treasury);
    return {
      network,
      token: null,
      treasury_tx_hash: null,
      user_wallet_address: profile.wallet_address,
      treasury_wallet_address: treasury.address,
      fee_wallet_address: feeSettlement.fee_wallet_address,
      fee_tx_hash: feeSettlement.fee_tx_hash,
      fee_settlement_status: feeSettlement.fee_settlement_status,
      fee_settlement_error: feeSettlement.fee_settlement_error,
      fee_token_contract: feeSettlement.fee_token_contract,
      settlement_status: "ledger_posted_pending_source_sweep",
      sweep_required: preview.from_asset !== "NGN",
    };
  }

  const token = await getToken(supabase, preview.to_asset, network);
  const provider = getProvider(network);
  const treasury = getTreasuryWallet(provider);
  const contractWithTreasury = new ethers.Contract(token.contract_address, ERC20_ABI, treasury);
  const userTokenAmount = parseTokenUnits(preview.to_amount, Number(token.decimals));
  const [treasuryTokenBalance, treasuryNativeBalance] = await Promise.all([
    contractWithTreasury.balanceOf(treasury.address),
    provider.getBalance(treasury.address),
  ]);
  if (treasuryTokenBalance < userTokenAmount) throw new Error("NairaX treasury has insufficient test token liquidity.");
  if (treasuryNativeBalance <= 0n) throw new Error("NairaX treasury wallet does not have native gas.");

  const tx = await contractWithTreasury.transfer(profile.wallet_address, userTokenAmount);
  await waitForSwapTx(tx, "Treasury crypto settlement");
  const feeSettlement = preview.from_asset !== "NGN"
    ? await settleCryptoFeeFromTreasury(supabase, preview, network, provider, treasury)
    : { fee_tx_hash: null, fee_wallet_address: null, fee_settlement_status: "not_required", fee_token_contract: null, fee_settlement_error: null };

  return {
    network,
    token,
    treasury_tx_hash: tx.hash,
    fee_tx_hash: feeSettlement.fee_tx_hash,
    user_wallet_address: profile.wallet_address,
    treasury_wallet_address: treasury.address,
    fee_wallet_address: feeSettlement.fee_wallet_address,
    fee_settlement_status: feeSettlement.fee_settlement_status,
    fee_settlement_error: feeSettlement.fee_settlement_error,
    fee_token_contract: feeSettlement.fee_token_contract,
    explorer_url: explorerUrl(token, tx.hash),
    fee_explorer_url: explorerUrl(token, feeSettlement.fee_tx_hash),
    settlement_status: preview.from_asset === "NGN" ? "completed" : "completed_pending_source_sweep",
    sweep_required: preview.from_asset !== "NGN",
  };
}

async function recordSwapSettlement(supabase, ledgerTransactionId, settlement) {
  if (!ledgerTransactionId || !settlement) return;
  const conversionUpdate = await supabase
    .from("conversion_transactions")
    .update({
      network: settlement.network,
      token_contract: settlement.token?.contract_address || null,
      treasury_wallet_address: settlement.treasury_wallet_address || null,
      fee_wallet_address: settlement.fee_wallet_address || null,
      user_wallet_address: settlement.user_wallet_address || null,
      treasury_tx_hash: settlement.treasury_tx_hash || null,
      fee_tx_hash: settlement.fee_tx_hash || null,
      settlement_status: settlement.settlement_status || "completed",
    })
    .eq("ledger_transaction_id", ledgerTransactionId);
  if (conversionUpdate.error && process.env.DEBUG_SWAP_SETTLEMENT === "true") {
    console.warn("conversion settlement update skipped:", conversionUpdate.error.message);
  }

  const { data: ledgerRow } = await supabase
    .from("ledger_transactions")
    .select("metadata")
    .eq("id", ledgerTransactionId)
    .maybeSingle();

  const ledgerUpdate = await supabase
    .from("ledger_transactions")
    .update({
      tx_hash: settlement.treasury_tx_hash || null,
      metadata: {
        ...(ledgerRow?.metadata || {}),
        onchain_settlement: true,
        network: settlement.network,
        token_contract: settlement.token?.contract_address || null,
        treasury_tx_hash: settlement.treasury_tx_hash || null,
        fee_tx_hash: settlement.fee_tx_hash || null,
        treasury_wallet_address: settlement.treasury_wallet_address || null,
        fee_wallet_address: settlement.fee_wallet_address || null,
        fee_settlement_status: settlement.fee_settlement_status || null,
        fee_settlement_error: settlement.fee_settlement_error || null,
        fee_token_contract: settlement.fee_token_contract || null,
        user_wallet_address: settlement.user_wallet_address || null,
      },
    })
    .eq("id", ledgerTransactionId);
  if (ledgerUpdate.error && process.env.DEBUG_SWAP_SETTLEMENT === "true") {
    console.warn("ledger settlement update skipped:", ledgerUpdate.error.message);
  }
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
      const settlement = await settleSwapOnChain(supabase, user.id, preview, String(body.network || "Arc Testnet"));
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
      await recordSwapSettlement(supabase, data, settlement);
      return json(200, { transactionId: data, preview, settlement });
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
