# NairaX Supabase Setup

1. Create a Supabase project.
2. Run `supabase/schema.sql` in the Supabase SQL editor.
3. In Supabase Auth settings, disable email confirmation for this Phase 1 PIN-based demo flow.
4. Copy `.env.example` to `.env` locally, then set the same environment variables in Netlify.
5. Run the app through Netlify Dev or deploy it to Netlify so `/.netlify/functions/signup` and `/.netlify/functions/config` are available.

The app uses Supabase Auth with a deterministic internal email derived from the phone number. The 4-digit PIN is used as part of the Supabase auth password and is not stored in `profiles`.

Naira banking is simulated. Crypto runs on real EVM testnets using deployed demo tokens, real testnet gas, real on-chain transfers, and real transaction hashes. No real money.

Wallet creation is backend-only. `netlify/functions/signup.js` generates real custodial EVM wallets with `ethers.Wallet.createRandom()`, encrypts private keys with `WALLET_ENCRYPTION_SECRET`, stores encrypted keys in `custodial_wallets`, and exposes only `profiles.wallet_address` to the browser.

The MVP platform wallet model is:

- `TREASURY_WALLET_PRIVATE_KEY`: real EVM testnet wallet that holds deployed demo tokens, pays gas for external withdrawals, receives external crypto deposits, and sends external crypto withdrawals.
- `FEE_WALLET_PRIVATE_KEY`: real EVM testnet wallet that receives crypto fees where needed.
- NGN fees are database-only because the NGN banking layer is simulated.

Fund segregation is built in from Phase 1:

- `balances` is only the customer-facing custody snapshot.
- `ledger_accounts.account_type = 'customer_custody'` stores customer custody accounts per user and asset.
- `treasury_settlement` stores NairaX treasury/settlement funds.
- `fee_revenue` stores NairaX fee revenue and must never be mixed with user custody.
- `reserve_shock` stores the reserve/shock fund.
- `simulated_ngn_corporate_reserve` stores the simulated NGN corporate reserve.
- `demo_ngn_mint_source` stores demo-only simulated NGN funding source balances.
- `demo_ngn_burn_sink` stores demo-only simulated NGN burn/sink balances.
- `simulated_external_bank_settlement_sink` stores simulated bank payouts leaving the NairaX demo environment.

Every future transaction must create `ledger_entries` under a `ledger_transactions` record. Entries must use explicit roles: `user_debit`, `user_credit`, `treasury_movement`, `fee_movement`, `reserve_movement`, `corporate_reserve_movement`, `demo_mint_movement`, `demo_burn_movement`, or `external_bank_settlement_movement`. The database rejects entries posted to the wrong segregated account type, and browser roles cannot read ledger or custodial wallet tables directly.

Phase 2 simulated NGN banking adds:

- `ledger_account_balances` for backend-only custody, reserve, treasury, and fee account balances.
- `user_transactions` for user-facing history with RLS select access for the owning user only.
- `simulate_ngn_deposit()`, `internal_ngn_transfer()`, and `simulated_external_bank_transfer()` RPCs. Browser roles cannot execute these directly; the backend `ngn-banking` function calls them with the service role after verifying the user's Supabase session.
- A seeded demo NGN mint source of `1,000,000,000` backed by the `demo_ngn_mint_source` ledger account. Simulated deposits debit this account and credit user custody. They do not touch reserve/shock or corporate reserve.
- Simulated external bank transfers debit user custody and credit `simulated_external_bank_settlement_sink`. They do not credit reserve/shock or corporate reserve.
