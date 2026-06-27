"use strict";

const ACCOUNT_TYPES = Object.freeze({
  CUSTOMER_CUSTODY: "customer_custody",
  TREASURY_SETTLEMENT: "treasury_settlement",
  FEE_REVENUE: "fee_revenue",
  RESERVE_SHOCK: "reserve_shock",
  SIMULATED_NGN_CORPORATE_RESERVE: "simulated_ngn_corporate_reserve",
  DEMO_NGN_MINT_SOURCE: "demo_ngn_mint_source",
  DEMO_NGN_BURN_SINK: "demo_ngn_burn_sink",
  SIMULATED_EXTERNAL_BANK_SETTLEMENT_SINK: "simulated_external_bank_settlement_sink",
  STATUTORY_FEE_PAYABLE: "statutory_fee_payable",
  GAS_FEE_RECOVERY: "gas_fee_recovery",
});

const ENTRY_ROLES = Object.freeze({
  USER_DEBIT: "user_debit",
  USER_CREDIT: "user_credit",
  TREASURY_MOVEMENT: "treasury_movement",
  FEE_MOVEMENT: "fee_movement",
  RESERVE_MOVEMENT: "reserve_movement",
  CORPORATE_RESERVE_MOVEMENT: "corporate_reserve_movement",
  DEMO_MINT_MOVEMENT: "demo_mint_movement",
  DEMO_BURN_MOVEMENT: "demo_burn_movement",
  EXTERNAL_BANK_SETTLEMENT_MOVEMENT: "external_bank_settlement_movement",
  STATUTORY_FEE_MOVEMENT: "statutory_fee_movement",
  GAS_FEE_MOVEMENT: "gas_fee_movement",
});

const ROLE_ACCOUNT_TYPES = Object.freeze({
  [ENTRY_ROLES.USER_DEBIT]: ACCOUNT_TYPES.CUSTOMER_CUSTODY,
  [ENTRY_ROLES.USER_CREDIT]: ACCOUNT_TYPES.CUSTOMER_CUSTODY,
  [ENTRY_ROLES.TREASURY_MOVEMENT]: ACCOUNT_TYPES.TREASURY_SETTLEMENT,
  [ENTRY_ROLES.FEE_MOVEMENT]: ACCOUNT_TYPES.FEE_REVENUE,
  [ENTRY_ROLES.RESERVE_MOVEMENT]: ACCOUNT_TYPES.RESERVE_SHOCK,
  [ENTRY_ROLES.CORPORATE_RESERVE_MOVEMENT]: ACCOUNT_TYPES.SIMULATED_NGN_CORPORATE_RESERVE,
  [ENTRY_ROLES.DEMO_MINT_MOVEMENT]: ACCOUNT_TYPES.DEMO_NGN_MINT_SOURCE,
  [ENTRY_ROLES.DEMO_BURN_MOVEMENT]: ACCOUNT_TYPES.DEMO_NGN_BURN_SINK,
  [ENTRY_ROLES.EXTERNAL_BANK_SETTLEMENT_MOVEMENT]: ACCOUNT_TYPES.SIMULATED_EXTERNAL_BANK_SETTLEMENT_SINK,
  [ENTRY_ROLES.STATUTORY_FEE_MOVEMENT]: ACCOUNT_TYPES.STATUTORY_FEE_PAYABLE,
  [ENTRY_ROLES.GAS_FEE_MOVEMENT]: ACCOUNT_TYPES.GAS_FEE_RECOVERY,
});

async function getLedgerAccount(supabase, { accountType, assetCode, userId = null }) {
  let query = supabase
    .from("ledger_accounts")
    .select("id, account_type, asset_code, owner_type, owner_id")
    .eq("account_type", accountType)
    .eq("asset_code", assetCode);

  if (accountType === ACCOUNT_TYPES.CUSTOMER_CUSTODY) {
    if (!userId) throw new Error("Customer custody account lookup requires userId.");
    query = query.eq("owner_type", "customer").eq("owner_id", userId);
  } else {
    query = query.eq("owner_type", "platform").is("owner_id", null);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`Ledger account not found for ${accountType}/${assetCode}.`);
  return data;
}

async function createLedgerTransaction(supabase, transaction, entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("Ledger transactions require at least one ledger entry.");
  }

  const { data: tx, error: txError } = await supabase
    .from("ledger_transactions")
    .insert(transaction)
    .select("id")
    .single();
  if (txError) throw txError;

  const rows = [];
  for (const entry of entries) {
    const expectedAccountType = ROLE_ACCOUNT_TYPES[entry.entryRole];
    if (!expectedAccountType) throw new Error(`Unsupported ledger entry role: ${entry.entryRole}`);

    const account = await getLedgerAccount(supabase, {
      accountType: expectedAccountType,
      assetCode: entry.assetCode,
      userId: entry.userId || transaction.user_id || null,
    });

    rows.push({
      transaction_id: tx.id,
      account_id: account.id,
      user_id: entry.userId || null,
      entry_role: entry.entryRole,
      direction: entry.direction,
      asset_code: entry.assetCode,
      amount: entry.amount,
      memo: entry.memo || null,
    });
  }

  const { error: entriesError } = await supabase.from("ledger_entries").insert(rows);
  if (entriesError) throw entriesError;
  return tx.id;
}

module.exports = {
  ACCOUNT_TYPES,
  ENTRY_ROLES,
  createLedgerTransaction,
  getLedgerAccount,
};
