"use strict";

const { createClient } = require("@supabase/supabase-js");
const { ethers } = require("ethers");

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
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

function getProvider(network) {
  const config = NETWORKS[network];
  if (!config) throw new Error(`Unsupported crypto network: ${network}`);
  const rpcUrl = process.env[config.env];
  if (!rpcUrl) throw new Error(`${config.env} is not configured.`);
  return new ethers.JsonRpcProvider(rpcUrl, config.chainId);
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

function normalizeSymbol(symbol) {
  const raw = String(symbol || "").trim();
  return raw.toUpperCase() === "CIRBTCX" ? "cirBTCX" : raw.toUpperCase();
}

function toAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Enter a valid amount.");
  return amount;
}

async function getProfile(supabase, userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, wallet_address")
    .eq("id", userId)
    .single();
  if (error) throw error;
  if (!data?.wallet_address || !ethers.isAddress(data.wallet_address)) throw new Error("User custodial wallet address is missing or invalid.");
  return data;
}

async function getToken(supabase, symbol, network) {
  const { data, error } = await supabase
    .from("supported_tokens")
    .select("symbol, name, decimals, network, chain_id, contract_address, is_active, explorer_base_url")
    .eq("symbol", symbol)
    .eq("network", network)
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.is_active) throw new Error(`${symbol} is not active on ${network}.`);
  if (!ethers.isAddress(data.contract_address)) throw new Error(`${symbol} contract address is invalid.`);
  return data;
}

function explorerUrl(token, txHash) {
  return token.explorer_base_url ? `${token.explorer_base_url.replace(/\/$/, "")}/tx/${txHash}` : null;
}

async function listConfig(supabase, userId) {
  const [tokensResult, depositsResult, withdrawalsResult, profile] = await Promise.all([
    supabase.from("supported_tokens").select("symbol, name, decimals, network, chain_id, contract_address, is_active, explorer_base_url").eq("is_active", true).order("symbol"),
    supabase.from("crypto_deposits").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(50),
    supabase.from("crypto_withdrawals").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(50),
    getProfile(supabase, userId),
  ]);
  if (tokensResult.error) throw tokensResult.error;
  if (depositsResult.error) throw depositsResult.error;
  if (withdrawalsResult.error) throw withdrawalsResult.error;
  return {
    wallet_address: profile.wallet_address,
    tokens: tokensResult.data || [],
    deposits: depositsResult.data || [],
    withdrawals: withdrawalsResult.data || [],
  };
}

async function verifyDeposit(supabase, userId, body) {
  const network = String(body.network || "Arc Testnet");
  const symbol = normalizeSymbol(body.symbol);
  const txHash = String(body.txHash || body.tx_hash || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("Enter a valid transaction hash.");

  const profile = await getProfile(supabase, userId);
  const token = await getToken(supabase, symbol, network);
  const provider = getProvider(network);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error("Transaction was not found on Arc Testnet.");
  if (receipt.status !== 1) throw new Error("Transaction did not succeed on-chain.");

  const iface = new ethers.Interface(ERC20_ABI);
  let transferred = 0n;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token.contract_address.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name !== "Transfer") continue;
      const to = String(parsed.args.to || "").toLowerCase();
      if (to === profile.wallet_address.toLowerCase()) transferred += parsed.args.value;
    } catch (_) {
      // Ignore unrelated logs from the same receipt.
    }
  }
  if (transferred <= 0n) throw new Error("No matching token transfer to your NairaX wallet was found.");

  const amount = Number(ethers.formatUnits(transferred, Number(token.decimals)));
  const { data: ledgerTransactionId, error } = await supabase.rpc("credit_verified_crypto_deposit", {
    target_user_id: userId,
    deposit_network: network,
    deposit_chain_id: token.chain_id,
    deposit_token_symbol: token.symbol,
    deposit_token_contract: token.contract_address,
    deposit_wallet_address: profile.wallet_address,
    deposit_amount: amount,
    deposit_tx_hash: txHash,
  });
  if (error) throw error;

  return {
    ledger_transaction_id: ledgerTransactionId,
    tx_hash: txHash,
    amount,
    symbol: token.symbol,
    network,
    explorer_url: explorerUrl(token, txHash),
  };
}

async function previewWithdrawal(supabase, body) {
  const network = String(body.network || "Arc Testnet");
  const symbol = normalizeSymbol(body.symbol);
  const amount = toAmount(body.amount);
  const token = await getToken(supabase, symbol, network);
  const { data: gasSetting, error: gasError } = await supabase
    .from("network_gas_settings")
    .select("withdrawal_gas_fee_amount")
    .eq("network", network)
    .maybeSingle();
  if (gasError) throw gasError;
  const platformFee = Math.round(amount * 0.003 * 1e8) / 1e8;
  const gasFeeEstimate = Math.max(0, Number(gasSetting?.withdrawal_gas_fee_amount || 0));
  return {
    amount,
    platform_fee: platformFee,
    gas_fee_estimate: gasFeeEstimate,
    total_deducted: Math.round((amount + platformFee + gasFeeEstimate) * 1e8) / 1e8,
    token,
  };
}

async function withdrawExternal(supabase, userId, body) {
  const network = String(body.network || "Arc Testnet");
  const symbol = normalizeSymbol(body.symbol);
  const amount = toAmount(body.amount);
  const recipient = String(body.recipient || body.recipientAddress || "").trim();
  if (!ethers.isAddress(recipient)) throw new Error("Enter a valid recipient wallet address.");

  const token = await getToken(supabase, symbol, network);
  const preview = await previewWithdrawal(supabase, { network, symbol, amount });
  const provider = getProvider(network);
  const treasury = getTreasuryWallet(provider);
  const feeWalletAddress = getFeeWalletAddress();
  const contract = new ethers.Contract(token.contract_address, ERC20_ABI, treasury);
  const amountUnits = ethers.parseUnits(String(amount), Number(token.decimals));
  const platformFeeUnits = ethers.parseUnits(String(preview.platform_fee), Number(token.decimals));

  const [treasuryTokenBalance, treasuryNativeBalance] = await Promise.all([
    contract.balanceOf(treasury.address),
    provider.getBalance(treasury.address),
  ]);
  if (treasuryTokenBalance < amountUnits + platformFeeUnits) throw new Error("NairaX treasury has insufficient test token liquidity.");
  if (treasuryNativeBalance <= 0n) throw new Error("NairaX treasury wallet does not have native gas for this network.");

  let withdrawalId = null;
  try {
    const { data, error } = await supabase.rpc("create_crypto_withdrawal_pending", {
      sender_user_id: userId,
      withdrawal_network: network,
      withdrawal_chain_id: token.chain_id,
      withdrawal_token_symbol: token.symbol,
      withdrawal_token_contract: token.contract_address,
      withdrawal_recipient_address: recipient,
      withdrawal_amount: amount,
      withdrawal_platform_fee: preview.platform_fee,
      withdrawal_gas_fee_estimate: preview.gas_fee_estimate,
    });
    if (error) throw error;
    withdrawalId = data;

    const tx = await contract.transfer(recipient, amountUnits);
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error("On-chain withdrawal transaction failed.");

    let feeTxHash = null;
    let feeSettlementStatus = preview.platform_fee > 0 ? "pending" : "not_required";
    let feeSettlementError = null;

    if (preview.platform_fee > 0) {
      try {
        const feeTx = await contract.transfer(feeWalletAddress, platformFeeUnits);
        const feeReceipt = await feeTx.wait(1);
        if (!feeReceipt || feeReceipt.status !== 1) throw new Error("On-chain fee settlement transaction failed.");
        feeTxHash = feeTx.hash;
        feeSettlementStatus = "completed";
      } catch (feeError) {
        feeSettlementStatus = "failed";
        feeSettlementError = feeError.message || "Fee settlement failed.";
      }
    }

    const { data: ledgerTransactionId, error: completeError } = await supabase.rpc("complete_crypto_withdrawal", {
      withdrawal_id: withdrawalId,
      chain_tx_hash: tx.hash,
    });
    if (completeError) throw completeError;

    const feeSettlementUpdate = {
      fee_wallet_address: preview.platform_fee > 0 ? feeWalletAddress : null,
      fee_tx_hash: feeTxHash,
      fee_settlement_status: feeSettlementStatus,
      fee_settlement_error: feeSettlementError,
    };
    const { error: feeUpdateError } = await supabase
      .from("crypto_withdrawals")
      .update(feeSettlementUpdate)
      .eq("id", withdrawalId);
    if (feeUpdateError) {
      feeSettlementStatus = "failed";
      feeSettlementError = feeUpdateError.message || feeSettlementError || "Could not save fee settlement status.";
    }

    return {
      withdrawal_id: withdrawalId,
      ledger_transaction_id: ledgerTransactionId,
      tx_hash: tx.hash,
      amount,
      symbol: token.symbol,
      network,
      platform_fee: preview.platform_fee,
      gas_fee_estimate: preview.gas_fee_estimate,
      total_deducted: preview.total_deducted,
      fee_tx_hash: feeTxHash,
      fee_settlement_status: feeSettlementStatus,
      explorer_url: explorerUrl(token, tx.hash),
    };
  } catch (error) {
    if (withdrawalId) {
      await supabase.rpc("fail_crypto_withdrawal_refund", {
        withdrawal_id: withdrawalId,
        reason: error.message || "Withdrawal failed.",
      });
    }
    throw error;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST") return json(405, { error: "Method not allowed" });

  try {
    const supabase = getServiceClient();
    const user = await getAuthenticatedUser(supabase, event);
    const body = JSON.parse(event.body || "{}");
    const action = String(body.action || "config");

    if (action === "config") return json(200, await listConfig(supabase, user.id));
    if (action === "verify_deposit") return json(200, await verifyDeposit(supabase, user.id, body));
    if (action === "withdrawal_preview") return json(200, await previewWithdrawal(supabase, body));
    if (action === "external_withdrawal") return json(200, await withdrawExternal(supabase, user.id, body));
    return json(400, { error: "Unsupported crypto action." });
  } catch (error) {
    const message = error.message || "Crypto request failed.";
    const statusCode = /missing authorization|invalid or expired/i.test(message) ? 401 : 400;
    return json(statusCode, { error: message });
  }
};
