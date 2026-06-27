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
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

const NETWORKS = {
  "Arc Testnet": {
    env: "ARC_TESTNET_RPC_URL",
    chainId: 5042002,
  },
  "Monad Testnet": {
    env: "MONAD_TESTNET_RPC_URL",
  },
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
  if (error || !data.user) throw new Error("Invalid or expired session.");
  return data.user;
}

function getProvider(network) {
  const config = NETWORKS[network];
  if (!config) throw new Error(`Unsupported faucet network: ${network}`);
  const rpcUrl = process.env[config.env];
  if (!rpcUrl) throw new Error(`${config.env} is not configured.`);
  return new ethers.JsonRpcProvider(rpcUrl, config.chainId ? Number(config.chainId) : undefined);
}

function getWallet(privateKey, provider, label) {
  if (!privateKey) throw new Error(`${label} is not configured.`);
  return new ethers.Wallet(privateKey, provider);
}

function walletAddressFromKey(privateKey) {
  if (!privateKey) return null;
  try {
    return new ethers.Wallet(privateKey).address;
  } catch (_) {
    return null;
  }
}

async function syncPlatformWallets(supabase, network) {
  const rows = [
    ["demo_faucet", process.env.DEMO_FAUCET_PRIVATE_KEY],
    ["treasury", process.env.TREASURY_WALLET_PRIVATE_KEY],
    ["fee", process.env.FEE_WALLET_PRIVATE_KEY],
  ].map(([wallet_type, privateKey]) => ({
    wallet_type,
    network,
    wallet_address: walletAddressFromKey(privateKey) || "not_configured",
    is_active: Boolean(walletAddressFromKey(privateKey)),
  }));

  const { error } = await supabase
    .from("platform_wallets")
    .upsert(rows, { onConflict: "wallet_type,network" });
  if (error) throw error;
}

async function getProfile(supabase, userId) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, full_name, wallet_address")
    .eq("id", userId)
    .single();
  if (error) throw error;
  if (!data?.wallet_address || !ethers.isAddress(data.wallet_address)) {
    throw new Error("User custodial wallet address is missing or invalid.");
  }
  return data;
}

async function getToken(supabase, symbol, network) {
  const { data, error } = await supabase
    .from("supported_tokens")
    .select("id, symbol, name, decimals, network, chain_id, contract_address, is_active, faucet_amount, explorer_base_url")
    .eq("symbol", symbol)
    .eq("network", network)
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.is_active) throw new Error(`${symbol} is not active on ${network}.`);
  if (!ethers.isAddress(data.contract_address)) throw new Error(`${symbol} contract address is invalid.`);
  return data;
}

async function listConfig(supabase, userId) {
  const { data: tokens, error: tokenError } = await supabase
    .from("supported_tokens")
    .select("symbol, name, decimals, network, chain_id, contract_address, is_active, faucet_amount, explorer_base_url")
    .eq("is_active", true)
    .order("network", { ascending: true })
    .order("symbol", { ascending: true });
  if (tokenError) throw tokenError;

  const { data: claims, error: claimsError } = await supabase
    .from("faucet_claims")
    .select("token_symbol, network, amount, tx_hash, status, claimed_at")
    .eq("user_id", userId)
    .order("claimed_at", { ascending: false });
  if (claimsError) throw claimsError;

  const { data: gasSettings, error: gasError } = await supabase
    .from("network_gas_settings")
    .select("network, native_symbol, gas_faucet_amount, gas_faucet_enabled, explorer_base_url");
  if (gasError) throw gasError;

  return { tokens: tokens || [], claims: claims || [], gas_settings: gasSettings || [] };
}

async function claimToken(supabase, userId, body) {
  const network = String(body.network || "Arc Testnet");
  const symbol = String(body.symbol || "").trim();
  if (!symbol) throw new Error("Select a faucet token.");

  await syncPlatformWallets(supabase, network);
  const profile = await getProfile(supabase, userId);
  const token = await getToken(supabase, symbol, network);

  const { data: existing, error: existingError } = await supabase
    .from("faucet_claims")
    .select("id, status, tx_hash")
    .eq("user_id", userId)
    .eq("token_symbol", token.symbol)
    .eq("network", network)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing && existing.status !== "failed") {
    throw new Error(`You have already claimed ${token.symbol} on ${network}.`);
  }

  const provider = getProvider(network);
  const faucetWallet = getWallet(process.env.DEMO_FAUCET_PRIVATE_KEY, provider, "DEMO_FAUCET_PRIVATE_KEY");
  const contract = new ethers.Contract(token.contract_address, ERC20_ABI, faucetWallet);
  const amountUnits = ethers.parseUnits(String(token.faucet_amount), Number(token.decimals));

  const [tokenBalance, nativeBalance] = await Promise.all([
    contract.balanceOf(faucetWallet.address),
    provider.getBalance(faucetWallet.address),
  ]);

  if (tokenBalance < amountUnits) {
    throw new Error(`Demo faucet wallet does not have enough ${token.symbol}.`);
  }
  if (nativeBalance <= 0n) {
    throw new Error("Demo faucet wallet does not have native gas for this network.");
  }

  let claimId = existing?.id;
  if (claimId) {
    const { error } = await supabase
      .from("faucet_claims")
      .update({
        amount: token.faucet_amount,
        tx_hash: null,
        status: "pending",
        claimed_at: new Date().toISOString(),
      })
      .eq("id", claimId);
    if (error) throw error;
  } else {
    const { data, error } = await supabase
      .from("faucet_claims")
      .insert({
        user_id: userId,
        token_symbol: token.symbol,
        network,
        amount: token.faucet_amount,
        status: "pending",
      })
      .select("id")
      .single();
    if (error) throw error;
    claimId = data.id;
  }

  try {
    const tx = await contract.transfer(profile.wallet_address, amountUnits);
    await supabase.from("faucet_claims").update({ tx_hash: tx.hash, status: "submitted" }).eq("id", claimId);
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) {
      throw new Error("On-chain faucet transfer failed.");
    }

    const { error: postedError } = await supabase
      .from("faucet_claims")
      .update({ tx_hash: tx.hash, status: "posted", claimed_at: new Date().toISOString() })
      .eq("id", claimId);
    if (postedError) throw postedError;

    const { data: ledgerTransactionId, error: creditError } = await supabase.rpc("credit_demo_faucet_claim", {
      target_user_id: userId,
      token_symbol: token.symbol,
      token_network: network,
      claim_amount: token.faucet_amount,
      chain_tx_hash: tx.hash,
    });
    if (creditError) throw creditError;

    return {
      tx_hash: tx.hash,
      ledger_transaction_id: ledgerTransactionId,
      amount: token.faucet_amount,
      symbol: token.symbol,
      network,
      explorer_url: token.explorer_base_url ? `${token.explorer_base_url.replace(/\/$/, "")}/tx/${tx.hash}` : null,
    };
  } catch (error) {
    await supabase.from("faucet_claims").update({ status: "failed" }).eq("id", claimId);
    throw error;
  }
}

async function claimNativeGas(supabase, userId, body) {
  const network = String(body.network || "Arc Testnet");
  await syncPlatformWallets(supabase, network);
  const profile = await getProfile(supabase, userId);

  const { data: setting, error: settingError } = await supabase
    .from("network_gas_settings")
    .select("network, native_symbol, gas_faucet_amount, gas_faucet_enabled, explorer_base_url")
    .eq("network", network)
    .maybeSingle();
  if (settingError) throw settingError;
  if (!setting?.gas_faucet_enabled || Number(setting.gas_faucet_amount || 0) <= 0) {
    throw new Error(`Native gas faucet is not enabled for ${network}.`);
  }

  const gasSymbol = `${setting.native_symbol || "NATIVE"}_GAS`;
  const { data: existing, error: existingError } = await supabase
    .from("faucet_claims")
    .select("id, status")
    .eq("user_id", userId)
    .eq("token_symbol", gasSymbol)
    .eq("network", network)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing && existing.status !== "failed") {
    throw new Error(`You have already claimed native gas on ${network}.`);
  }

  const provider = getProvider(network);
  const faucetWallet = getWallet(process.env.DEMO_FAUCET_PRIVATE_KEY, provider, "DEMO_FAUCET_PRIVATE_KEY");
  const value = ethers.parseEther(String(setting.gas_faucet_amount));
  const balance = await provider.getBalance(faucetWallet.address);
  if (balance <= value) throw new Error("Demo faucet wallet does not have enough native gas.");

  const { data: claim, error: claimError } = await supabase
    .from("faucet_claims")
    .upsert({
      user_id: userId,
      token_symbol: gasSymbol,
      network,
      amount: setting.gas_faucet_amount,
      status: "pending",
      tx_hash: null,
      claimed_at: new Date().toISOString(),
    }, { onConflict: "user_id,token_symbol,network" })
    .select("id")
    .single();
  if (claimError) throw claimError;

  try {
    const tx = await faucetWallet.sendTransaction({ to: profile.wallet_address, value });
    await supabase.from("faucet_claims").update({ tx_hash: tx.hash, status: "submitted" }).eq("id", claim.id);
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error("Native gas faucet transfer failed.");
    await supabase.from("faucet_claims").update({ tx_hash: tx.hash, status: "posted", claimed_at: new Date().toISOString() }).eq("id", claim.id);
    return {
      tx_hash: tx.hash,
      amount: setting.gas_faucet_amount,
      symbol: setting.native_symbol,
      network,
      explorer_url: setting.explorer_base_url ? `${setting.explorer_base_url.replace(/\/$/, "")}/tx/${tx.hash}` : null,
    };
  } catch (error) {
    await supabase.from("faucet_claims").update({ status: "failed" }).eq("id", claim.id);
    throw error;
  }
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
    const action = String(body.action || "config");

    if (action === "config") {
      return json(200, await listConfig(supabase, user.id));
    }
    if (action === "claim_token") {
      return json(200, await claimToken(supabase, user.id, body));
    }
    if (action === "claim_native_gas") {
      return json(200, await claimNativeGas(supabase, user.id, body));
    }
    return json(400, { error: "Unsupported faucet action." });
  } catch (error) {
    const message = error.message || "Faucet request failed.";
    const statusCode = /missing authorization|invalid or expired/i.test(message) ? 401 : 400;
    return json(statusCode, { error: message });
  }
};
