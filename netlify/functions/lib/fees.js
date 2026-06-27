"use strict";

const ASSETS = new Set(["NGN", "USDCX", "MON", "ETHX", "cirBTCX", "EURCX"]);

function normalizeAsset(asset) {
  const raw = String(asset || "NGN").trim();
  if (raw.toUpperCase() === "CIRBTCX") return "cirBTCX";
  return raw.toUpperCase();
}

function toAmount(value, label = "amount") {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Enter a valid ${label}.`);
  }
  return Math.round(amount * 1e8) / 1e8;
}

function calculateFee(input = {}) {
  const transactionType = String(input.transaction_type || input.transactionType || "").trim();
  const sourceAsset = normalizeAsset(input.source_asset || input.sourceAsset || "NGN");
  const destinationAsset = normalizeAsset(input.destination_asset || input.destinationAsset || sourceAsset);
  const amount = toAmount(input.amount || 0);
  const amountNgnEquivalent = Number(input.amount_ngn_equivalent || input.amountNgnEquivalent || amount);
  const isInternal = Boolean(input.is_internal ?? input.isInternal);
  const recipientType = String(input.recipient_type || input.recipientType || "").trim();

  if (!ASSETS.has(sourceAsset) || !ASSETS.has(destinationAsset)) {
    throw new Error("Unsupported asset for fee calculation.");
  }

  let platformFee = 0;
  let statutoryFee = 0;
  let gasFeeEstimate = 0;
  let feeReason = "free";
  let feeAsset = sourceAsset;
  let feeRate = 0;

  if (transactionType === "internal_transfer" && isInternal && sourceAsset === destinationAsset) {
    feeReason = sourceAsset === "NGN" ? "free_internal_ngn_transfer" : "free_internal_crypto_transfer";
  } else if (transactionType === "simulated_external_bank_transfer" && sourceAsset === "NGN") {
    const used = Number(input.free_external_ngn_used || input.freeExternalNgnUsed || 0);
    platformFee = used >= 3 ? 10 : 0;
    statutoryFee = amount >= 10000 ? 50 : 0;
    feeReason = "simulated_external_ngn_bank_transfer";
    feeAsset = "NGN";
  } else if (transactionType === "external_crypto_withdrawal") {
    feeRate = 0.003;
    platformFee = amount * feeRate;
    gasFeeEstimate = Number(input.gas_fee_estimate || input.gasFeeEstimate || 0);
    feeReason = "external_crypto_withdrawal";
  } else if (
    transactionType === "ngn_crypto_conversion" ||
    transactionType === "crypto_ngn_conversion" ||
    recipientType === "conversion"
  ) {
    feeRate = 0.006;
    platformFee = amount * feeRate;
    feeReason = "conversion_or_cross_asset_send";
  }

  platformFee = Math.round(platformFee * (sourceAsset === "NGN" ? 100 : 1e8)) / (sourceAsset === "NGN" ? 100 : 1e8);
  statutoryFee = Math.round(statutoryFee * 1e8) / 1e8;
  gasFeeEstimate = Math.round(gasFeeEstimate * 1e8) / 1e8;

  const totalFee = Math.round((platformFee + statutoryFee + gasFeeEstimate) * 1e8) / 1e8;
  const totalDeducted = Math.round((amount + totalFee) * 1e8) / 1e8;

  return {
    platform_fee: platformFee,
    statutory_fee: statutoryFee,
    gas_fee_estimate: gasFeeEstimate,
    total_fee: totalFee,
    total_deducted: totalDeducted,
    fee_asset: feeAsset,
    fee_rate: feeRate,
    fee_reason: feeReason,
    receiver_gets: amount,
    fee_breakdown: {
      amount,
      platform_fee: platformFee,
      statutory_fee: statutoryFee,
      gas_fee_estimate: gasFeeEstimate,
      total_fee: totalFee,
      total_deducted: totalDeducted,
      receiver_gets: amount,
      free_external_ngn_remaining: null,
    },
  };
}

module.exports = {
  calculateFee,
  normalizeAsset,
  toAmount,
};
