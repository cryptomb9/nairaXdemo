"use strict";

const { createClient } = require("@supabase/supabase-js");
const { calculateFee, normalizeAsset, toAmount } = require("./lib/fees");

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
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

function normalizeAmount(value, label = "amount") {
  return toAmount(value, label);
}

async function runRpc(supabase, functionName, params) {
  const { data, error } = await supabase.rpc(functionName, params);
  if (error) throw error;
  return data;
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

async function countExternalNgnTransfers(supabase, userId) {
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
    const action = String(body.action || "");

    let transactionId;
    if (action === "simulate_deposit") {
      transactionId = await runRpc(supabase, "simulate_ngn_deposit", {
        target_user_id: user.id,
        deposit_amount: normalizeAmount(body.amount === undefined ? 100000 : body.amount),
      });
    } else if (action === "lookup_recipient") {
      const rows = await runRpc(supabase, "resolve_nairax_recipient", {
        requesting_user_id: user.id,
        recipient_identifier: String(body.recipient || ""),
      });
      return json(200, { recipient: Array.isArray(rows) && rows.length ? rows[0] : null });
    } else if (action === "fee_preview") {
      const transactionType = String(body.transactionType || body.transaction_type || "");
      const asset = normalizeAsset(body.asset || body.source_asset || "NGN");
      const freeExternalNgnUsed = transactionType === "simulated_external_bank_transfer"
        ? await countExternalNgnTransfers(supabase, user.id)
        : 0;

      return json(200, calculateFee({
        transaction_type: transactionType,
        source_asset: asset,
        destination_asset: body.destinationAsset || body.destination_asset || asset,
        amount: normalizeAmount(body.amount),
        amount_ngn_equivalent: body.amountNgnEquivalent || body.amount_ngn_equivalent || body.amount,
        is_internal: Boolean(body.isInternal ?? body.is_internal),
        recipient_type: body.recipientType || body.recipient_type,
        free_external_ngn_used: freeExternalNgnUsed,
        gas_fee_estimate: body.gasFeeEstimate || body.gas_fee_estimate || 0,
      }));
    } else if (action === "internal_transfer") {
      const asset = normalizeAsset(body.asset || "NGN");
      transactionId = await runRpc(supabase, "internal_asset_transfer", {
        sender_user_id: user.id,
        recipient_identifier: String(body.recipient || ""),
        transfer_asset: asset,
        transfer_amount: normalizeAmount(body.amount),
        transfer_note: body.note ? String(body.note) : null,
      });
    } else if (action === "external_bank_transfer") {
      transactionId = await runRpc(supabase, "simulated_external_bank_transfer", {
        sender_user_id: user.id,
        bank_name: String(body.bankName || ""),
        destination_account_number: String(body.accountNumber || ""),
        transfer_amount: normalizeAmount(body.amount),
        transfer_note: body.note ? String(body.note) : null,
        destination_account_name: body.accountName ? String(body.accountName) : null,
      });
    } else {
      return json(400, { error: "Unsupported NGN banking action." });
    }

    return json(200, { transactionId });
  } catch (error) {
    const message = error.message || "NGN banking operation failed.";
    const statusCode = /missing authorization|invalid or expired/i.test(message) ? 401 : 400;
    return json(statusCode, { error: message });
  }
};
