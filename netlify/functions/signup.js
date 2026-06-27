"use strict";

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { ethers } = require("ethers");

const DEFAULT_ASSETS = ["NGN", "USDCX", "MON", "ETHX", "cirBTCX", "EURCX"];

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};

function json(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function normalizePhone(raw) {
  let digits = String(raw || "").replace(/\D/g, "");
  if (digits.startsWith("234") && digits.length === 13) digits = "0" + digits.slice(3);
  if (digits.length === 10) digits = "0" + digits;
  return digits;
}

function generateAccountNumberFromPhone(phone) {
  const digits = normalizePhone(phone);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 10) return digits;

  let hash = 0;
  for (let i = 0; i < digits.length; i++) {
    hash = ((hash << 5) - hash) + digits.charCodeAt(i);
    hash |= 0;
  }
  return String(Math.abs(hash)).padStart(10, "0").slice(0, 10);
}

function authEmail(phone) {
  return `${normalizePhone(phone)}@auth.nairax.local`;
}

function authPassword(phone, pin) {
  return `NairaX:${normalizePhone(phone)}:${pin}`;
}

function encryptPrivateKey(privateKey) {
  const secret = process.env.WALLET_ENCRYPTION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("WALLET_ENCRYPTION_SECRET must be set to at least 32 characters.");
  }

  const key = crypto.createHash("sha256").update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(privateKey, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    v: 1,
    alg: "AES-256-GCM",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
}

function getAdminClient() {
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

async function createDefaultBalances(supabase, userId) {
  const rows = DEFAULT_ASSETS.map((asset_code) => ({ user_id: userId, asset_code }));
  const { error } = await supabase
    .from("balances")
    .upsert(rows, { onConflict: "user_id,asset_code", ignoreDuplicates: true });
  if (error) throw error;
}

async function createCustomerCustodyLedgerAccounts(supabase, userId) {
  const rows = DEFAULT_ASSETS.map((asset_code) => ({
    owner_type: "customer",
    owner_id: userId,
    account_type: "customer_custody",
    asset_code,
    account_name: `Customer Custody - ${asset_code}`,
    is_system: false,
  }));
  const { error } = await supabase
    .from("ledger_accounts")
    .upsert(rows, { onConflict: "owner_type,owner_id,account_type,asset_code", ignoreDuplicates: true });
  if (error) throw error;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const name = String(body.name || "").trim();
    const phone = normalizePhone(body.phone);
    const pin = String(body.pin || "").trim();

    if (name.length < 2) return json(400, { error: "Enter your full name" });
    if (phone.length < 10) return json(400, { error: "Enter a valid phone number" });
    if (!/^\d{4}$/.test(pin)) return json(400, { error: "PIN must be exactly 4 digits" });

    const supabase = getAdminClient();
    const accountNumber = generateAccountNumberFromPhone(phone);
    const wallet = ethers.Wallet.createRandom();
    const encryptedPrivateKey = encryptPrivateKey(wallet.privateKey);

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email: authEmail(phone),
      password: authPassword(phone, pin),
      email_confirm: true,
      user_metadata: {
        full_name: name,
        phone,
        account_number: accountNumber,
        wallet_address: wallet.address,
      },
    });
    if (authError) {
      const duplicate = /already|registered|exists/i.test(authError.message || "");
      return json(duplicate ? 409 : 400, { error: duplicate ? "Phone already registered" : authError.message });
    }

    const userId = authData.user.id;

    const { error: profileError } = await supabase
      .from("profiles")
      .upsert({
        id: userId,
        full_name: name,
        phone,
        account_number: accountNumber,
        wallet_address: wallet.address,
      }, { onConflict: "id" });
    if (profileError) throw profileError;

    const { error: walletError } = await supabase
      .from("custodial_wallets")
      .insert({
        user_id: userId,
        wallet_address: wallet.address,
        encrypted_private_key: encryptedPrivateKey,
        chain_type: "EVM",
      });
    if (walletError) throw walletError;

    await createDefaultBalances(supabase, userId);
    await createCustomerCustodyLedgerAccounts(supabase, userId);

    return json(201, {
      userId,
      accountNumber,
      walletAddress: wallet.address,
    });
  } catch (error) {
    return json(500, { error: error.message || "Signup failed" });
  }
};
