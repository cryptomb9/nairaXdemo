"use strict";

const { createClient } = require("@supabase/supabase-js");
const { ethers } = require("ethers");
const crypto = require("crypto");
const { getAssetPrices } = require("./conversions");

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const NETWORKS = {
  "Arc Testnet": { env: "ARC_TESTNET_RPC_URL", chainId: 5042002 },
  "Monad Testnet": { env: "MONAD_TESTNET_RPC_URL" },
};

function json(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.");
  }
  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
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
  if (error || !data.user) {
    throw new Error("Invalid or expired session.");
  }
  return data.user;
}

async function assertAdmin(supabase, userId) {
  const { data, error } = await supabase
    .from("admin_users")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

function sumBy(rows, keyField, valueField = "available") {
  return (rows || []).reduce((acc, row) => {
    const key = row[keyField] || "UNKNOWN";
    acc[key] = (acc[key] || 0) + Number(row[valueField] || 0);
    return acc;
  }, {});
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

function walletAddressFromKey(privateKey) {
  if (!privateKey) return "not_configured";
  try {
    return new ethers.Wallet(privateKey).address;
  } catch (_) {
    return "invalid_private_key";
  }
}

function getProvider(network) {
  const config = NETWORKS[network];
  if (!config) return null;
  const rpcUrl = process.env[config.env];
  if (!rpcUrl) return null;
  return new ethers.JsonRpcProvider(rpcUrl, config.chainId ? Number(config.chainId) : undefined);
}

function normalizeSymbol(symbol) {
  const raw = String(symbol || "").trim();
  return raw.toUpperCase() === "CIRBTCX" ? "cirBTCX" : raw.toUpperCase();
}

function getTreasuryWallet(provider) {
  const privateKey = process.env.TREASURY_WALLET_PRIVATE_KEY;
  if (!privateKey) throw new Error("TREASURY_WALLET_PRIVATE_KEY is not configured.");
  return new ethers.Wallet(privateKey, provider);
}

function getFeeWalletAddress() {
  const privateKey = process.env.FEE_WALLET_PRIVATE_KEY;
  if (!privateKey) throw new Error("FEE_WALLET_PRIVATE_KEY is not configured.");
  return new ethers.Wallet(privateKey).address;
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

function getWaitConfirmations(envName, fallback = 0) {
  const raw = Number(process.env[envName] ?? fallback);
  if (!Number.isFinite(raw) || raw < 0) return fallback;
  return Math.floor(raw);
}

async function maybeWaitForTx(tx, confirmations) {
  if (!confirmations) return null;
  return tx.wait(confirmations);
}

async function getLedgerFeeRevenue(supabase) {
  const [accountsResult, balancesResult] = await Promise.all([
    supabase.from("ledger_accounts").select("id, asset_code").eq("owner_type", "platform").eq("account_type", "fee_revenue"),
    supabase.from("ledger_account_balances").select("account_id, asset_code, available"),
  ]);
  if (accountsResult.error) throw accountsResult.error;
  if (balancesResult.error) throw balancesResult.error;

  const feeAccountIds = new Set((accountsResult.data || []).map((account) => account.id));
  return (balancesResult.data || [])
    .filter((balance) => feeAccountIds.has(balance.account_id))
    .reduce((acc, balance) => {
      acc[balance.asset_code] = (acc[balance.asset_code] || 0) + Number(balance.available || 0);
      return acc;
    }, {});
}

function completedSettlementTotals(rows = []) {
  return rows
    .filter((row) => row.status === "completed")
    .reduce((acc, row) => {
      acc[row.asset_symbol] = (acc[row.asset_symbol] || 0) + Number(row.amount || 0);
      return acc;
    }, {});
}

function calculateUnsettledCryptoFees(ledgerFeeRevenue, settlements) {
  const settled = completedSettlementTotals(settlements);
  return Object.entries(ledgerFeeRevenue || {}).reduce((acc, [asset, amount]) => {
    if (asset === "NGN") return acc;
    const unsettled = Math.max(0, Number(amount || 0) - Number(settled[asset] || 0));
    if (unsettled > 0) acc[asset] = Math.round(unsettled * 1e8) / 1e8;
    return acc;
  }, {});
}

function roundToDecimals(value, decimals) {
  const safeDecimals = Math.max(0, Math.min(Number(decimals) || 0, 18));
  const factor = 10 ** safeDecimals;
  return Math.floor((Number(value) + Number.EPSILON) * factor) / factor;
}

function calculateVolumeAnalytics(entries = [], transactions = [], feeRevenue = {}) {
  const transactionById = new Map((transactions || []).map((tx) => [tx.id, tx]));
  const byAsset = {};
  const byType = {};

  for (const entry of entries || []) {
    if (entry.entry_role !== "user_debit" || entry.direction !== "debit") continue;
    const amount = Number(entry.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const asset = entry.asset_code || "UNKNOWN";
    const txType = transactionById.get(entry.transaction_id)?.transaction_type || "unknown";
    byAsset[asset] = (byAsset[asset] || 0) + amount;
    byType[txType] = byType[txType] || {};
    byType[txType][asset] = (byType[txType][asset] || 0) + amount;
  }

  const profitabilityByAsset = Object.entries(byAsset).reduce((acc, [asset, volume]) => {
    const feeAmount = Number(feeRevenue[asset] || 0);
    acc[asset] = {
      volume,
      platform_fee_revenue: feeAmount,
      fee_take_rate_percent: volume > 0 ? (feeAmount / volume) * 100 : 0,
    };
    return acc;
  }, {});

  return { by_asset: byAsset, by_transaction_type: byType, profitability_by_asset: profitabilityByAsset };
}

function estimateNgnVolume(volumeByAsset = {}, priceData = {}) {
  const prices = new Map((priceData.prices || []).map((row) => [row.asset_symbol, Number(row.ngn_mid_price || 0)]));
  return Object.entries(volumeByAsset).reduce((sum, [asset, amount]) => {
    const value = asset === "NGN" ? Number(amount || 0) : Number(amount || 0) * Number(prices.get(asset) || 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);
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

async function settleCryptoFees(supabase, adminUserId, body) {
  const network = String(body.network || "Arc Testnet");
  const symbol = normalizeSymbol(body.asset_symbol || body.symbol);
  if (symbol === "NGN") throw new Error("NGN fees are ledger-only and cannot be settled to an on-chain wallet.");

  const { data: settlements, error: settlementsError } = await supabase
    .from("crypto_fee_settlements")
    .select("asset_symbol, amount, status");
  if (settlementsError) throw settlementsError;

  const ledgerFeeRevenue = await getLedgerFeeRevenue(supabase);
  const unsettled = calculateUnsettledCryptoFees(ledgerFeeRevenue, settlements || []);
  const available = Number(unsettled[symbol] || 0);
  const requestedAmount = body.amount ? Number(body.amount) : available;
  const amount = Math.round(requestedAmount * 1e8) / 1e8;
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`No unsettled ${symbol} fees to settle.`);

  const token = await getToken(supabase, symbol, network);
  const decimals = Number(token.decimals);
  const roundedAvailable = roundToDecimals(available, decimals);
  const roundedAmount = roundToDecimals(amount, decimals);
  if (roundedAmount <= 0) throw new Error(`Unsettled ${symbol} fee is below the token decimal precision.`);
  if (roundedAmount > roundedAvailable + 1e-12) throw new Error(`Cannot settle more than unsettled ${symbol} fees.`);
  const provider = getProvider(network);
  if (!provider) throw new Error(`${network} RPC is not configured.`);
  const treasury = getTreasuryWallet(provider);
  const feeWalletAddress = getFeeWalletAddress();
  const contract = new ethers.Contract(token.contract_address, ERC20_ABI, treasury);
  const amountUnits = ethers.parseUnits(roundedAmount.toFixed(decimals), decimals);
  const treasuryTokenBalance = await contract.balanceOf(treasury.address);
  if (treasuryTokenBalance < amountUnits) throw new Error(`Treasury wallet has insufficient ${symbol} to settle fees.`);

  const { data: settlement, error: insertError } = await supabase
    .from("crypto_fee_settlements")
    .insert({
      admin_user_id: adminUserId,
      network,
      asset_symbol: symbol,
      token_contract: token.contract_address,
      amount: roundedAmount,
      treasury_wallet_address: treasury.address,
      fee_wallet_address: feeWalletAddress,
      status: "pending",
    })
    .select("*")
    .single();
  if (insertError) throw insertError;

  try {
    const tx = await contract.transfer(feeWalletAddress, amountUnits);
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error("Fee settlement transaction failed on-chain.");
    const { data, error } = await supabase
      .from("crypto_fee_settlements")
      .update({ status: "completed", tx_hash: tx.hash, completed_at: new Date().toISOString(), failure_reason: null })
      .eq("id", settlement.id)
      .select("*")
      .single();
    if (error) throw error;
    return data;
  } catch (error) {
    await supabase
      .from("crypto_fee_settlements")
      .update({ status: "failed", failure_reason: error.message || "Fee settlement failed." })
      .eq("id", settlement.id);
    throw error;
  }
}

async function sweepCustodialWallets(supabase, body) {
  const network = String(body.network || "Arc Testnet");
  const symbol = normalizeSymbol(body.asset_symbol || body.symbol);
  const limit = Math.max(1, Math.min(Number(body.limit || 5), 10));
  const token = await getToken(supabase, symbol, network);
  const provider = getProvider(network);
  if (!provider) throw new Error(`${network} RPC is not configured.`);

  const treasury = getTreasuryWallet(provider);
  const gasTopUpEth = String(body.gas_top_up || process.env.SWEEP_GAS_TOPUP_NATIVE || "0.001");
  const gasTopUp = ethers.parseEther(gasTopUpEth);
  const minGas = gasTopUp / 3n;
  const waitConfirmations = getWaitConfirmations("SWEEP_WAIT_CONFIRMATIONS", 0);
  const treasuryContract = new ethers.Contract(token.contract_address, ERC20_ABI, treasury);
  const treasuryAddress = treasury.address;

  const { data: wallets, error } = await supabase
    .from("custodial_wallets")
    .select("user_id, wallet_address, encrypted_private_key")
    .eq("chain_type", "EVM")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;

  const results = [];
  for (const row of wallets || []) {
    const result = {
      user_id: row.user_id,
      wallet_address: row.wallet_address,
      symbol: token.symbol,
      gas_top_up_tx_hash: null,
      sweep_tx_hash: null,
      swept_amount: 0,
      status: "skipped",
      reason: null,
    };
    try {
      if (!ethers.isAddress(row.wallet_address)) throw new Error("Invalid wallet address.");
      const tokenBalance = await treasuryContract.balanceOf(row.wallet_address);
      if (tokenBalance <= 0n) {
        result.reason = "No token balance to sweep.";
        results.push(result);
        continue;
      }

      const nativeBalance = await provider.getBalance(row.wallet_address);
      if (nativeBalance < minGas) {
        const gasTx = await treasury.sendTransaction({ to: row.wallet_address, value: gasTopUp });
        await maybeWaitForTx(gasTx, waitConfirmations);
        result.gas_top_up_tx_hash = gasTx.hash;
        result.status = "gas_topped_up";
        result.reason = "Gas top-up submitted. Run sweep again after it confirms.";
        results.push(result);
        continue;
      }

      const userWallet = new ethers.Wallet(decryptPrivateKey(row.encrypted_private_key), provider);
      if (userWallet.address.toLowerCase() !== row.wallet_address.toLowerCase()) {
        throw new Error("Encrypted key does not match wallet address.");
      }
      const userContract = new ethers.Contract(token.contract_address, ERC20_ABI, userWallet);
      const sweepTx = await userContract.transfer(treasuryAddress, tokenBalance);
      await maybeWaitForTx(sweepTx, waitConfirmations);
      result.sweep_tx_hash = sweepTx.hash;
      result.swept_amount = Number(ethers.formatUnits(tokenBalance, Number(token.decimals)));
      result.status = waitConfirmations ? "completed" : "submitted";
    } catch (sweepError) {
      result.status = "failed";
      result.reason = sweepError.message || "Sweep failed.";
    }
    results.push(result);
  }

  return { network, symbol: token.symbol, treasury_wallet_address: treasuryAddress, results };
}

async function syncPlatformWallets(supabase) {
  const networks = ["Arc Testnet", "Monad Testnet"];
  const walletConfigs = [
    ["demo_faucet", process.env.DEMO_FAUCET_PRIVATE_KEY],
    ["treasury", process.env.TREASURY_WALLET_PRIVATE_KEY],
    ["fee", process.env.FEE_WALLET_PRIVATE_KEY],
  ];

  const rows = [];
  for (const network of networks) {
    for (const [wallet_type, privateKey] of walletConfigs) {
      const wallet_address = walletAddressFromKey(privateKey);
      rows.push({
        wallet_type,
        network,
        wallet_address,
        is_active: wallet_address !== "not_configured" && wallet_address !== "invalid_private_key",
      });
    }
  }

  const { error } = await supabase
    .from("platform_wallets")
    .upsert(rows, { onConflict: "wallet_type,network" });
  if (error) throw error;
}

async function saveSupportedToken(supabase, body) {
  const token = body.token || {};
  const symbol = String(token.symbol || "").trim();
  const network = String(token.network || "").trim();
  const contractAddress = String(token.contract_address || "").trim();
  if (!symbol || !network || !contractAddress) {
    throw new Error("Token symbol, network, and contract address are required.");
  }
  if (!ethers.isAddress(contractAddress)) {
    throw new Error("Token contract address is invalid.");
  }

  const row = {
    symbol,
    name: String(token.name || `${symbol} Demo Token`),
    decimals: Number(token.decimals),
    network,
    chain_id: Number(token.chain_id || 0),
    contract_address: contractAddress,
    is_active: token.is_active !== false,
    faucet_amount: Number(token.faucet_amount || 0),
    explorer_base_url: token.explorer_base_url ? String(token.explorer_base_url) : null,
  };

  if (!Number.isInteger(row.decimals) || row.decimals < 0) throw new Error("Token decimals must be valid.");
  if (!row.chain_id) throw new Error("Chain ID is required.");
  if (!Number.isFinite(row.faucet_amount) || row.faucet_amount <= 0) throw new Error("Faucet amount must be greater than zero.");

  const { data, error } = await supabase
    .from("supported_tokens")
    .upsert(row, { onConflict: "symbol,network" })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function getWalletTokenBalances(tokens, privateKey, walletType) {
  const walletAddress = walletAddressFromKey(privateKey);
  if (!ethers.isAddress(walletAddress)) return [];

  const rows = [];
  for (const token of tokens || []) {
    try {
      const provider = getProvider(token.network);
      if (!provider || !ethers.isAddress(token.contract_address)) continue;
      const contract = new ethers.Contract(token.contract_address, ERC20_ABI, provider);
      const raw = await contract.balanceOf(walletAddress);
      rows.push({
        wallet_type: walletType,
        network: token.network,
        symbol: token.symbol,
        wallet_address: walletAddress,
        balance: Number(ethers.formatUnits(raw, Number(token.decimals))),
      });
    } catch (error) {
      rows.push({
        wallet_type: walletType,
        network: token.network,
        symbol: token.symbol,
        wallet_address: walletAddress,
        balance: null,
        error: error.message || "Balance check failed",
      });
    }
  }
  return rows;
}

async function getPlatformBalances(supabase) {
  const [ledgerAccountsResult, ledgerBalancesResult] = await Promise.all([
    supabase.from("ledger_accounts").select("id, account_type, asset_code, account_name"),
    supabase.from("ledger_account_balances").select("account_id, asset_code, available"),
  ]);
  if (ledgerAccountsResult.error) throw ledgerAccountsResult.error;
  if (ledgerBalancesResult.error) throw ledgerBalancesResult.error;

  const accountById = new Map((ledgerAccountsResult.data || []).map((account) => [account.id, account]));
  const platformBalances = (ledgerBalancesResult.data || []).map((balance) => {
    const account = accountById.get(balance.account_id) || {};
    return {
      account_type: account.account_type || "unknown",
      account_name: account.account_name || "Unknown",
      asset_code: balance.asset_code,
      available: Number(balance.available || 0),
    };
  });
  return { platformBalances, accountById };
}

function balancesByType(platformBalances) {
  return (platformBalances || []).reduce((acc, row) => {
    acc[row.account_type] = acc[row.account_type] || {};
    acc[row.account_type][row.asset_code] = (acc[row.account_type][row.asset_code] || 0) + row.available;
    return acc;
  }, {});
}

async function getVolumeData(supabase, priceData, ledgerFeeRevenue) {
  const [volumeEntriesResult, volumeTransactionsResult] = await Promise.all([
    supabase.from("ledger_entries").select("transaction_id, entry_role, direction, asset_code, amount").eq("entry_role", "user_debit").eq("direction", "debit").limit(10000),
    supabase.from("ledger_transactions").select("id, transaction_type").limit(10000),
  ]);
  if (volumeEntriesResult.error) throw volumeEntriesResult.error;
  if (volumeTransactionsResult.error) throw volumeTransactionsResult.error;
  const volumeAnalytics = calculateVolumeAnalytics(volumeEntriesResult.data || [], volumeTransactionsResult.data || [], ledgerFeeRevenue || {});
  volumeAnalytics.estimated_ngn_volume = estimateNgnVolume(volumeAnalytics.by_asset, priceData || {});
  return volumeAnalytics;
}

async function buildAdminOverview(supabase) {
  const [{ platformBalances }, usersResult, transactionsResult, balancesResult] = await Promise.all([
    getPlatformBalances(supabase),
    supabase.from("profiles").select("id", { count: "exact", head: true }),
    supabase.from("ledger_transactions").select("id", { count: "exact", head: true }),
    supabase.from("balances").select("asset_code, available"),
  ]);
  if (usersResult.error) throw usersResult.error;
  if (transactionsResult.error) throw transactionsResult.error;
  if (balancesResult.error) throw balancesResult.error;

  const priceData = await getAssetPrices(supabase).catch((error) => ({
    prices: [],
    error: error.message || "Price fetch failed",
  }));
  const ledgerFeeRevenue = platformBalances
    .filter((row) => row.account_type === "fee_revenue")
    .reduce((acc, row) => {
      acc[row.asset_code] = (acc[row.asset_code] || 0) + row.available;
      return acc;
    }, {});
  const volumeAnalytics = await getVolumeData(supabase, priceData, ledgerFeeRevenue);

  return {
    user_count: usersResult.count || 0,
    transaction_count: transactionsResult.count || 0,
    customer_liabilities: sumBy(balancesResult.data || [], "asset_code"),
    ledger_fee_revenue: ledgerFeeRevenue,
    volume_analytics: volumeAnalytics,
    price_data: priceData,
  };
}

async function buildAdminFees(supabase) {
  const [{ platformBalances }, feesResult, feeSettlementsResult, cryptoWithdrawalsResult] = await Promise.all([
    getPlatformBalances(supabase),
    supabase.from("fee_events").select("asset_symbol, fee_amount, platform_fee_amount, statutory_fee_amount, gas_fee_amount, total_fee_amount"),
    supabase.from("crypto_fee_settlements").select("*").order("created_at", { ascending: false }).limit(100),
    supabase.from("crypto_withdrawals").select("*").order("created_at", { ascending: false }).limit(100),
  ]);
  if (feesResult.error) throw feesResult.error;
  if (feeSettlementsResult.error) throw feeSettlementsResult.error;
  if (cryptoWithdrawalsResult.error) throw cryptoWithdrawalsResult.error;

  const feeRows = feesResult.data || [];
  const ledgerFeeRevenue = platformBalances
    .filter((row) => row.account_type === "fee_revenue")
    .reduce((acc, row) => {
      acc[row.asset_code] = (acc[row.asset_code] || 0) + row.available;
      return acc;
    }, {});
  const ledgerCbnPayable = platformBalances
    .filter((row) => row.account_type === "statutory_fee_payable")
    .reduce((acc, row) => {
      acc[row.asset_code] = (acc[row.asset_code] || 0) + row.available;
      return acc;
    }, {});
  const feeSettlements = feeSettlementsResult.data || [];
  return {
    fees: {
      platform: sumBy(feeRows.map((fee) => ({ asset: fee.asset_symbol, value: fee.platform_fee_amount })), "asset", "value"),
      statutory: sumBy(feeRows.map((fee) => ({ asset: fee.asset_symbol, value: fee.statutory_fee_amount })), "asset", "value"),
      gas: sumBy(feeRows.map((fee) => ({ asset: fee.asset_symbol, value: fee.gas_fee_amount })), "asset", "value"),
      total: sumBy(feeRows.map((fee) => ({ asset: fee.asset_symbol, value: fee.total_fee_amount })), "asset", "value"),
    },
    ledger_fee_revenue: ledgerFeeRevenue,
    settled_crypto_fee_revenue: completedSettlementTotals(feeSettlements),
    unsettled_fee_amounts: calculateUnsettledCryptoFees(ledgerFeeRevenue, feeSettlements),
    cbn_statutory_payable: ledgerCbnPayable,
    crypto_fee_settlements: feeSettlements,
    crypto_withdrawals: cryptoWithdrawalsResult.data || [],
  };
}

async function buildAdminTab(supabase, action) {
  if (action === "overview") return buildAdminOverview(supabase);
  if (action === "fees") return buildAdminFees(supabase);
  if (action === "volume") {
    const priceData = await getAssetPrices(supabase).catch((error) => ({ prices: [], error: error.message || "Price fetch failed" }));
    return { volume_analytics: await getVolumeData(supabase, priceData, await getLedgerFeeRevenue(supabase)), price_data: priceData };
  }
  if (action === "pools") {
    const { platformBalances } = await getPlatformBalances(supabase);
    return { platform_balances: platformBalances, platform_balances_by_type: balancesByType(platformBalances) };
  }
  if (action === "users") {
    const { start, end } = getLagosDayBounds();
    const [profilesResult, usageResult] = await Promise.all([
      supabase.from("profiles").select("id, full_name, phone, account_number, created_at").order("created_at", { ascending: false }).limit(100),
      supabase.from("ledger_transactions").select("user_id, transaction_type, status").eq("transaction_type", "simulated_external_bank_transfer").eq("status", "posted").gte("created_at", start).lt("created_at", end),
    ]);
    if (profilesResult.error) throw profilesResult.error;
    if (usageResult.error) throw usageResult.error;
    const usage = (usageResult.data || []).reduce((acc, row) => {
      if (row.user_id) acc[row.user_id] = (acc[row.user_id] || 0) + 1;
      return acc;
    }, {});
    return { users: (profilesResult.data || []).map((profile) => ({ ...profile, external_ngn_transfer_count: usage[profile.id] || 0 })) };
  }
  if (action === "ledger") {
    const [{ accountById }, entriesResult] = await Promise.all([
      getPlatformBalances(supabase),
      supabase.from("ledger_entries").select("id, transaction_id, account_id, entry_role, direction, asset_code, amount, memo, created_at").order("created_at", { ascending: false }).limit(100),
    ]);
    if (entriesResult.error) throw entriesResult.error;
    return {
      recent_ledger_entries: (entriesResult.data || []).map((entry) => ({
        ...entry,
        account_type: accountById.get(entry.account_id)?.account_type || "unknown",
        account_name: accountById.get(entry.account_id)?.account_name || "Unknown",
      })),
    };
  }
  if (action === "tokens") {
    const { data, error } = await supabase.from("supported_tokens").select("*").order("network", { ascending: true }).order("symbol", { ascending: true });
    if (error) throw error;
    return { supported_tokens: data || [] };
  }
  if (action === "wallets") {
    await syncPlatformWallets(supabase);
    const { data, error } = await supabase.from("platform_wallets").select("*").order("network", { ascending: true }).order("wallet_type", { ascending: true });
    if (error) throw error;
    return { platform_wallets: data || [] };
  }
  if (action === "faucet") {
    const { data, error } = await supabase.from("faucet_claims").select("id, user_id, token_symbol, network, amount, tx_hash, status, claimed_at").order("claimed_at", { ascending: false }).limit(100);
    if (error) throw error;
    return { faucet_claims: data || [] };
  }
  if (action === "treasury") {
    const { data, error } = await supabase.from("supported_tokens").select("*").eq("is_active", true).order("network", { ascending: true }).order("symbol", { ascending: true });
    if (error) throw error;
    return { treasury_token_balances: await getWalletTokenBalances(data || [], process.env.TREASURY_WALLET_PRIVATE_KEY, "treasury") };
  }
  if (action === "deposits") {
    const { data, error } = await supabase.from("crypto_deposits").select("*").order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    return { crypto_deposits: data || [] };
  }
  if (action === "withdrawals") {
    const { data, error } = await supabase.from("crypto_withdrawals").select("*").order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    return { crypto_withdrawals: data || [] };
  }
  if (action === "conversions") {
    const { data, error } = await supabase.from("conversion_transactions").select("*").order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    return { conversions: data || [] };
  }
  if (action === "rates") {
    const [priceData, ratesResult] = await Promise.all([
      getAssetPrices(supabase).catch((error) => ({ prices: [], error: error.message || "Price fetch failed" })),
      supabase.from("exchange_rates").select("*").order("fetched_at", { ascending: false }).limit(100),
    ]);
    if (ratesResult.error) throw ratesResult.error;
    return { price_data: priceData, exchange_rates: ratesResult.data || [] };
  }
  throw new Error("Unsupported admin action.");
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  try {
    const supabase = getServiceClient();
    const user = await getAuthenticatedUser(supabase, event);
    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "summary");
    const isAdmin = await assertAdmin(supabase, user.id);

    if (action === "me") return json(200, { isAdmin });
    if (!isAdmin) return json(403, { error: "Admin access required." });
    if (action === "save_supported_token") {
      return json(200, { token: await saveSupportedToken(supabase, body) });
    }
    if (action === "settle_crypto_fees") {
      return json(200, { settlement: await settleCryptoFees(supabase, user.id, body) });
    }
    if (action === "sweep_custodial_wallets") {
      return json(200, { sweep: await sweepCustodialWallets(supabase, body) });
    }
    if (action !== "summary") {
      return json(200, await buildAdminTab(supabase, action));
    }

    await syncPlatformWallets(supabase);
    const { start: usageStart, end: usageEnd } = getLagosDayBounds();

    const [
      usersResult,
      transactionsResult,
      balancesResult,
      ledgerAccountsResult,
      ledgerBalancesResult,
      feesResult,
      recentTransactionsResult,
      recentEntriesResult,
      profilesResult,
      externalTransferUsageResult,
      failedTransactionsResult,
      supportedTokensResult,
      platformWalletsResult,
      faucetClaimsResult,
      cryptoDepositsResult,
      cryptoWithdrawalsResult,
      conversionsResult,
      exchangeRatesResult,
      feeSettlementsResult,
      volumeEntriesResult,
      volumeTransactionsResult,
    ] = await Promise.all([
      supabase.from("profiles").select("id", { count: "exact", head: true }),
      supabase.from("ledger_transactions").select("id", { count: "exact", head: true }),
      supabase.from("balances").select("asset_code, available"),
      supabase.from("ledger_accounts").select("id, account_type, asset_code, account_name"),
      supabase.from("ledger_account_balances").select("account_id, asset_code, available"),
      supabase.from("fee_events").select("asset_symbol, fee_amount, platform_fee_amount, statutory_fee_amount, gas_fee_amount, total_fee_amount"),
      supabase.from("ledger_transactions").select("id, transaction_type, status, asset_code, amount, description, created_at").order("created_at", { ascending: false }).limit(20),
      supabase.from("ledger_entries").select("id, transaction_id, account_id, entry_role, direction, asset_code, amount, memo, created_at").order("created_at", { ascending: false }).limit(50),
      supabase.from("profiles").select("id, full_name, phone, account_number, created_at").order("created_at", { ascending: false }).limit(50),
      supabase.from("ledger_transactions").select("user_id, transaction_type, status").eq("transaction_type", "simulated_external_bank_transfer").eq("status", "posted").gte("created_at", usageStart).lt("created_at", usageEnd),
      supabase.from("ledger_transactions").select("id, transaction_type, status, asset_code, amount, description, created_at").neq("status", "posted").order("created_at", { ascending: false }).limit(20),
      supabase.from("supported_tokens").select("*").order("network", { ascending: true }).order("symbol", { ascending: true }),
      supabase.from("platform_wallets").select("*").order("network", { ascending: true }).order("wallet_type", { ascending: true }),
      supabase.from("faucet_claims").select("id, user_id, token_symbol, network, amount, tx_hash, status, claimed_at").order("claimed_at", { ascending: false }).limit(100),
      supabase.from("crypto_deposits").select("*").order("created_at", { ascending: false }).limit(100),
      supabase.from("crypto_withdrawals").select("*").order("created_at", { ascending: false }).limit(100),
      supabase.from("conversion_transactions").select("*").order("created_at", { ascending: false }).limit(100),
      supabase.from("exchange_rates").select("*").order("fetched_at", { ascending: false }).limit(100),
      supabase.from("crypto_fee_settlements").select("*").order("created_at", { ascending: false }).limit(100),
      supabase.from("ledger_entries").select("transaction_id, entry_role, direction, asset_code, amount").eq("entry_role", "user_debit").eq("direction", "debit").limit(10000),
      supabase.from("ledger_transactions").select("id, transaction_type").limit(10000),
    ]);

    const results = [usersResult, transactionsResult, balancesResult, ledgerAccountsResult, ledgerBalancesResult, feesResult, recentTransactionsResult, recentEntriesResult, profilesResult, externalTransferUsageResult, failedTransactionsResult, supportedTokensResult, platformWalletsResult, faucetClaimsResult, cryptoDepositsResult, cryptoWithdrawalsResult, conversionsResult, exchangeRatesResult, feeSettlementsResult, volumeEntriesResult, volumeTransactionsResult];
    const failed = results.find((result) => result.error);
    if (failed) throw failed.error;

    const accountById = new Map((ledgerAccountsResult.data || []).map((account) => [account.id, account]));
    const platformBalances = (ledgerBalancesResult.data || []).map((balance) => {
      const account = accountById.get(balance.account_id) || {};
      return {
        account_type: account.account_type || "unknown",
        account_name: account.account_name || "Unknown",
        asset_code: balance.asset_code,
        available: Number(balance.available || 0),
      };
    });

    const feeRows = feesResult.data || [];
    const priceData = await getAssetPrices(supabase).catch((error) => ({
      prices: [],
      error: error.message || "Price fetch failed",
    }));
    const treasuryTokenBalances = await getWalletTokenBalances(supportedTokensResult.data || [], process.env.TREASURY_WALLET_PRIVATE_KEY, "treasury");
    const feeWalletTokenBalances = await getWalletTokenBalances(supportedTokensResult.data || [], process.env.FEE_WALLET_PRIVATE_KEY, "fee");
    const externalUsageByUser = (externalTransferUsageResult.data || []).reduce((acc, row) => {
      if (!row.user_id) return acc;
      acc[row.user_id] = (acc[row.user_id] || 0) + 1;
      return acc;
    }, {});
    const feeSummary = {
      platform: sumBy(feeRows.map((fee) => ({ asset: fee.asset_symbol, value: fee.platform_fee_amount })), "asset", "value"),
      statutory: sumBy(feeRows.map((fee) => ({ asset: fee.asset_symbol, value: fee.statutory_fee_amount })), "asset", "value"),
      gas: sumBy(feeRows.map((fee) => ({ asset: fee.asset_symbol, value: fee.gas_fee_amount })), "asset", "value"),
      total: sumBy(feeRows.map((fee) => ({ asset: fee.asset_symbol, value: fee.total_fee_amount })), "asset", "value"),
    };
    const ledgerFeeRevenue = platformBalances
      .filter((row) => row.account_type === "fee_revenue")
      .reduce((acc, row) => {
        acc[row.asset_code] = (acc[row.asset_code] || 0) + row.available;
        return acc;
      }, {});
    const ledgerCbnPayable = platformBalances
      .filter((row) => row.account_type === "statutory_fee_payable")
      .reduce((acc, row) => {
        acc[row.asset_code] = (acc[row.asset_code] || 0) + row.available;
        return acc;
      }, {});
    const feeSettlements = feeSettlementsResult.data || [];
    const settledCryptoFees = completedSettlementTotals(feeSettlements);
    const unsettledCryptoFees = calculateUnsettledCryptoFees(ledgerFeeRevenue, feeSettlements);
    const volumeAnalytics = calculateVolumeAnalytics(volumeEntriesResult.data || [], volumeTransactionsResult.data || [], ledgerFeeRevenue);
    volumeAnalytics.estimated_ngn_volume = estimateNgnVolume(volumeAnalytics.by_asset, priceData);

    return json(200, {
      user_count: usersResult.count || 0,
      transaction_count: transactionsResult.count || 0,
      customer_liabilities: sumBy(balancesResult.data || [], "asset_code"),
      platform_balances: platformBalances,
      platform_balances_by_type: platformBalances.reduce((acc, row) => {
        acc[row.account_type] = acc[row.account_type] || {};
        acc[row.account_type][row.asset_code] = (acc[row.account_type][row.asset_code] || 0) + row.available;
        return acc;
      }, {}),
      fees: feeSummary,
      volume_analytics: volumeAnalytics,
      ledger_fee_revenue: ledgerFeeRevenue,
      settled_crypto_fee_revenue: settledCryptoFees,
      price_data: priceData,
      cbn_statutory_payable: ledgerCbnPayable,
      recent_transactions: recentTransactionsResult.data || [],
      failed_transactions: failedTransactionsResult.data || [],
      recent_ledger_entries: (recentEntriesResult.data || []).map((entry) => ({
        ...entry,
        account_type: accountById.get(entry.account_id)?.account_type || "unknown",
        account_name: accountById.get(entry.account_id)?.account_name || "Unknown",
      })),
      transaction_counts_by_type: (recentTransactionsResult.data || []).reduce((acc, row) => {
        const key = row.transaction_type || "unknown";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
      users: (profilesResult.data || []).map((profile) => ({
        ...profile,
        external_ngn_transfer_count: externalUsageByUser[profile.id] || 0,
      })),
      supported_tokens: supportedTokensResult.data || [],
      platform_wallets: platformWalletsResult.data || [],
      treasury_token_balances: treasuryTokenBalances,
      fee_wallet_token_balances: feeWalletTokenBalances,
      unsettled_fee_amounts: unsettledCryptoFees,
      unsettled_withdrawal_fee_amounts: sumBy((cryptoWithdrawalsResult.data || [])
        .filter((row) => Number(row.platform_fee || 0) > 0 && row.fee_settlement_status !== "completed")
        .map((row) => ({ asset: row.token_symbol, value: row.platform_fee })), "asset", "value"),
      crypto_fee_settlements: feeSettlements,
      faucet_claims: faucetClaimsResult.data || [],
      crypto_deposits: cryptoDepositsResult.data || [],
      crypto_withdrawals: cryptoWithdrawalsResult.data || [],
      conversions: conversionsResult.data || [],
      exchange_rates: exchangeRatesResult.data || [],
    });
  } catch (error) {
    const message = error.message || "Admin request failed.";
    const statusCode = /missing authorization|invalid or expired/i.test(message) ? 401 : 400;
    return json(statusCode, { error: message });
  }
};
