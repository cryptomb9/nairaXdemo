/**
 * NairaX Phase 1
 * Supabase-backed auth, profiles, and balances.
 */
"use strict";

const PUBLIC_CONFIG = {
  supabaseUrl: "",
  supabaseAnonKey: "",
};

const DEFAULT_ASSETS = ["NGN", "USDCX", "MON", "ETHX", "cirBTCX", "EURCX"];

const ASSET_META = {
  NGN: { name: "Nigerian Naira", detail: "Fiat Balance", icon: "N", color: "#00A86B", decimals: 2 },
  USDCX: { name: "USDCX", detail: "Dollar Stable Balance", icon: "$", color: "#2775CA", decimals: 2 },
  MON: { name: "MON", detail: "Monad Balance", icon: "M", color: "#7b3fe4", decimals: 6 },
  ETHX: { name: "ETHX", detail: "Ethereum Balance", icon: "E", color: "#627eea", decimals: 6 },
  cirBTCX: { name: "cirBTCX", detail: "Bitcoin Balance", icon: "B", color: "#f7931a", decimals: 6 },
  EURCX: { name: "EURCX", detail: "Euro Stable Balance", icon: "EUR", color: "#1A73E8", decimals: 2 },
};

const LOCAL_PRICE_USD = {
  USDCX: 1,
  EURCX: 1.08,
  ETHX: 3500,
  cirBTCX: 65000,
  MON: 1,
};

function buildLocalPriceData() {
  const baseRate = 1400;
  const spread = 5;
  const now = new Date().toISOString();
  const prices = [{
    asset_symbol: "NGN",
    usd_price: 1 / baseRate,
    ngn_mid_price: 1,
    ngn_buy_price: 1,
    ngn_sell_price: 1,
    source: "frontend_fallback",
    updated_at: now,
    error: null,
  }];
  Object.entries(LOCAL_PRICE_USD).forEach(([asset, usdPrice]) => {
    prices.push({
      asset_symbol: asset,
      usd_price: usdPrice,
      ngn_mid_price: usdPrice * baseRate,
      ngn_buy_price: usdPrice * (baseRate + spread),
      ngn_sell_price: usdPrice * (baseRate - spread),
      source: "frontend_fallback",
      updated_at: now,
      error: null,
    });
  });
  return {
    base_ngn_usd_rate: baseRate,
    spread_ngn: spread,
    ngn_buy_rate: baseRate + spread,
    ngn_sell_rate: baseRate - spread,
    prices,
    updated_at: now,
    fallback: true,
  };
}

const State = {
  currentUser: null,
  currentProfile: null,
  currentBalances: [],
  currentTransactions: [],
  balanceVisible: true,
  sendType: "bank",
  pinBuffer: "",
  currentNetwork: "MTN",
  authBusy: false,
  feePreviewSeq: 0,
  billPreviewSeq: 0,
  recipientLookupSeq: 0,
  isAdmin: false,
  adminSummary: null,
  adminData: {},
  adminTab: "overview",
  faucetTokens: [],
  faucetClaims: [],
  cryptoTokens: [],
  cryptoDeposits: [],
  cryptoWithdrawals: [],
  conversionPreview: null,
  smartSpendPreview: null,
  priceData: buildLocalPriceData(),
};

const fmt = (n) => "NGN " + Number(n || 0).toLocaleString("en-NG", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const fmtAsset = (amount, symbol) => {
  const meta = ASSET_META[symbol] || { decimals: 6 };
  return `${Number(amount || 0).toLocaleString("en-NG", {
    minimumFractionDigits: meta.decimals,
    maximumFractionDigits: meta.decimals,
  })} ${symbol}`;
};

const timeAgo = (iso) => {
  const m = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  if (m < 1440) return Math.floor(m / 60) + "h ago";
  return Math.floor(m / 1440) + "d ago";
};

const formatDateTime = (iso) => {
  if (!iso) return "--";
  return new Date(iso).toLocaleString("en-NG", {
    dateStyle: "medium",
    timeStyle: "short",
  });
};

const escapeHtml = (value) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#039;");

const formatTxnAmount = (amount, asset) => asset === "NGN" ? fmt(amount) : fmtAsset(amount, asset || "NGN");

function shortHash(value, start = 8, end = 6) {
  const text = String(value || "");
  if (!text) return "";
  if (!/^0x[0-9a-fA-F]{16,}$/.test(text)) return text.length > 28 ? `${text.slice(0, 16)}...${text.slice(-8)}` : text;
  return text.length > start + end + 5 ? `${text.slice(0, start)}...${text.slice(-end)}` : text;
}

function txHashHtml(value) {
  if (!value) return "";
  return `<span class="short-hash" title="${escapeHtml(value)}">${escapeHtml(shortHash(value))}</span>`;
}

function friendlyError(error, fallback = "Request failed") {
  const message = error?.message || String(error || "");
  if (/abort|signal/i.test(message) || error?.name === "AbortError") {
    return "Preview timed out. Please try again.";
  }
  return message || fallback;
}

function getAssetPrice(asset) {
  return (State.priceData?.prices || []).find((price) => price.asset_symbol === asset) || null;
}

function buildBalanceRows(balanceRows, profile, priceData) {
  return DEFAULT_ASSETS.map((asset) => {
    const row = (balanceRows || []).find((b) => b.asset_code === asset);
    const available = Number(row?.available || 0);
    const price = (priceData?.prices || []).find((item) => item.asset_symbol === asset);
    const computedNgnValue = asset === "NGN"
      ? available
      : (price?.ngn_mid_price ? available * Number(price.ngn_mid_price) : null);
    return {
      asset_code: asset,
      available,
      locked: Number(row?.locked || 0),
      ngn_value: computedNgnValue === null ? null : Number(computedNgnValue || 0),
      price_per_token_ngn: price?.ngn_mid_price ? Number(price.ngn_mid_price) : (asset === "NGN" ? 1 : null),
      usd_price: price?.usd_price ? Number(price.usd_price) : null,
      price_source: price?.source || null,
      price_error: price?.error || null,
      updated_at: row?.updated_at || profile.created_at,
    };
  });
}

const greet = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};

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

async function loadPublicConfig() {
  if (PUBLIC_CONFIG.supabaseUrl && PUBLIC_CONFIG.supabaseAnonKey) return PUBLIC_CONFIG;

  if (window.NAIRAX_CONFIG?.supabaseUrl && window.NAIRAX_CONFIG?.supabaseAnonKey) {
    PUBLIC_CONFIG.supabaseUrl = window.NAIRAX_CONFIG.supabaseUrl;
    PUBLIC_CONFIG.supabaseAnonKey = window.NAIRAX_CONFIG.supabaseAnonKey;
    return PUBLIC_CONFIG;
  }

  const response = await fetch("/.netlify/functions/config", {
    headers: { "Accept": "application/json" },
  });
  if (!response.ok) throw new Error("Could not load public Supabase config.");
  const config = await response.json();
  PUBLIC_CONFIG.supabaseUrl = config.supabaseUrl || "";
  PUBLIC_CONFIG.supabaseAnonKey = config.supabaseAnonKey || "";
  return PUBLIC_CONFIG;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function requireSupabaseConfig(config) {
  if (!window.supabase) throw new Error("Supabase client script did not load.");
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new Error("Supabase URL and anon key are missing from backend config.");
  }
}

const Ledger = {
  client: null,

  async getClient() {
    const config = await loadPublicConfig();
    requireSupabaseConfig(config);
    if (!Ledger.client) {
      Ledger.client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    }
    return Ledger.client;
  },

  authEmail(phone) {
    return `${normalizePhone(phone)}@auth.nairax.local`;
  },

  authPassword(phone, pin) {
    return `NairaX:${normalizePhone(phone)}:${pin}`;
  },

  async signUp({ name, phone, pin }) {
    const cleanPhone = normalizePhone(phone);
    const response = await fetch("/.netlify/functions/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ name, phone: cleanPhone, pin }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || "Signup failed");
    }

    return Ledger.signIn({ phone: cleanPhone, pin });
  },

  async signIn({ phone, pin }) {
    const client = await Ledger.getClient();
    const { error } = await client.auth.signInWithPassword({
      email: Ledger.authEmail(phone),
      password: Ledger.authPassword(phone, pin),
    });
    if (error) throw error;
    return Ledger.loadCurrentUser();
  },

  async signOut() {
    const client = await Ledger.getClient();
    await client.auth.signOut();
    State.currentUser = null;
    State.currentProfile = null;
    State.currentBalances = [];
    State.currentTransactions = [];
    State.isAdmin = false;
    State.adminSummary = null;
  },

  async getAccessToken() {
    const client = await Ledger.getClient();
    let { data, error } = await client.auth.getSession();
    if (error) throw error;
    const expiresAt = Number(data.session?.expires_at || 0);
    if (!data.session?.access_token || (expiresAt && expiresAt * 1000 < Date.now() + 60000)) {
      const refreshed = await client.auth.refreshSession();
      if (refreshed.error) throw refreshed.error;
      data = refreshed.data;
    }
    const token = data.session?.access_token;
    if (!token) throw new Error("You need to sign in again.");
    return token;
  },

  async callNgnBanking(action, payload = {}) {
    const token = await Ledger.getAccessToken();
    const response = await fetch("/.netlify/functions/ngn-banking", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ action, ...payload }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "NGN banking operation failed.");
    return result;
  },

  async callAdmin(action, payload = {}) {
    const token = await Ledger.getAccessToken();
    const response = await fetchWithTimeout("/.netlify/functions/admin", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ action, ...payload }),
    }, action === "me" ? 9000 : (["treasury", "settle_crypto_fees"].includes(action) ? 30000 : (action === "sweep_custodial_wallets" ? 120000 : 14000)));
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Admin request failed.");
    return result;
  },

  async callFaucet(action, payload = {}) {
    const token = await Ledger.getAccessToken();
    const response = await fetch("/.netlify/functions/faucet", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ action, ...payload }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Faucet request failed.");
    return result;
  },

  async callCrypto(action, payload = {}) {
    const token = await Ledger.getAccessToken();
    const response = await fetch("/.netlify/functions/crypto", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ action, ...payload }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Crypto request failed.");
    return result;
  },

  async callConversions(action, payload = {}) {
    const token = await Ledger.getAccessToken();
    const response = await fetchWithTimeout("/.netlify/functions/conversions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ action, ...payload }),
    }, action === "prices" ? 2500 : (action === "convert" ? 60000 : 20000));
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Conversion request failed.");
    return result;
  },

  async callSmartSpend(action, payload = {}) {
    const token = await Ledger.getAccessToken();
    const response = await fetchWithTimeout("/.netlify/functions/smart-spend", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ action, ...payload }),
    }, 25000);
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "Smart Spend failed.");
    return result;
  },

  async loadCurrentUser() {
    const client = await Ledger.getClient();
    const { data: sessionData, error: sessionError } = await client.auth.getSession();
    if (sessionError) throw sessionError;
    const user = sessionData.session?.user;
    if (!user) return null;

    const profileResult = await client
      .from("profiles")
      .select("id, full_name, phone, account_number, wallet_address, created_at")
      .eq("id", user.id)
      .maybeSingle();
    if (profileResult.error) throw profileResult.error;
    if (!profileResult.data) throw new Error("Profile not found for the signed-in user.");

    const balancesResult = await client
      .from("balances")
      .select("asset_code, available, locked, ngn_value, updated_at")
      .eq("user_id", user.id)
      .order("asset_code", { ascending: true });
    if (balancesResult.error) throw balancesResult.error;

    const rawBalances = balancesResult.data || [];
    let priceData = State.priceData || buildLocalPriceData();
    const balances = buildBalanceRows(rawBalances, profileResult.data, priceData);

    const transactionsResult = await client
      .from("user_transactions")
      .select("id, ledger_transaction_id, direction, title, amount, note, counterparty_name, counterparty_account, created_at, updated_at, transaction_type, status, asset_code, fee_amount, gas_fee_amount, total_deducted, sender_name, sender_account, receiver_name, receiver_account, bank_name, recipient_name, recipient_account, narration, tx_hash, rate_used, from_asset, to_asset")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(100);
    if (transactionsResult.error) throw transactionsResult.error;

    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
      State.isAdmin = true;
    } else {
      try {
        const adminResult = await Ledger.callAdmin("me");
        State.isAdmin = Boolean(adminResult.isAdmin);
      } catch (_) {
        State.isAdmin = false;
      }
    }

    State.currentUser = profileResult.data.phone;
    State.currentProfile = profileResult.data;
    State.currentBalances = balances;
    State.currentTransactions = transactionsResult.data || [];

    Ledger.callConversions("prices")
      .then((freshPriceData) => {
        State.priceData = freshPriceData;
        State.currentBalances = buildBalanceRows(rawBalances, profileResult.data, freshPriceData);
        if (!document.getElementById("app-screen")?.classList.contains("hidden")) App.renderHome(DB.getUser());
      })
      .catch(() => {});

    return {
      id: user.id,
      name: profileResult.data.full_name,
      phone: profileResult.data.phone,
      accountNumber: profileResult.data.account_number,
      wallet: { address: profileResult.data.wallet_address },
      balances,
      nairaBalance: balances.find((b) => b.asset_code === "NGN")?.available || 0,
      priceData,
      cryptoAssets: balances.filter((b) => b.asset_code !== "NGN").map((b) => ({
        symbol: b.asset_code,
        amount: b.available,
        nairaValue: b.ngn_value,
        pricePerTokenNgn: b.price_per_token_ngn,
      })),
      transactions: State.currentTransactions,
    };
  },
};

const DB = {
  getCurrentUser: () => State.currentUser,
  clearCurrentUser: () => { State.currentUser = null; },
  getUser: () => {
    if (!State.currentProfile) return null;
    return {
      name: State.currentProfile.full_name,
      phone: State.currentProfile.phone,
      accountNumber: State.currentProfile.account_number,
      wallet: { address: State.currentProfile.wallet_address },
      nairaBalance: State.currentBalances.find((b) => b.asset_code === "NGN")?.available || 0,
      cryptoAssets: State.currentBalances.filter((b) => b.asset_code !== "NGN").map((b) => ({
        symbol: b.asset_code,
        amount: b.available,
        nairaValue: b.ngn_value,
        pricePerTokenNgn: b.price_per_token_ngn,
      })),
      balances: State.currentBalances,
      transactions: State.currentTransactions,
    };
  },
  getUsers: () => State.currentProfile ? { [State.currentProfile.phone]: DB.getUser() } : {},
};

const App = {
  async init() {
    setTimeout(async () => {
      document.getElementById("splash-screen").style.display = "none";
      try {
        App.showHomeLoading();
        const user = await Ledger.loadCurrentUser();
        if (user) {
          App.showApp();
        } else {
          document.getElementById("auth-screen").classList.remove("hidden");
        }
      } catch (error) {
        document.getElementById("auth-screen").classList.remove("hidden");
        App.showAuthError(error.message);
      }
    }, 450);
  },

  showSignup() {
    document.getElementById("signup-view").classList.remove("hidden");
    document.getElementById("login-view").classList.add("hidden");
    document.getElementById("auth-tab-signup")?.classList.add("active");
    document.getElementById("auth-tab-login")?.classList.remove("active");
  },

  showLogin() {
    document.getElementById("login-view").classList.remove("hidden");
    document.getElementById("signup-view").classList.add("hidden");
    document.getElementById("auth-tab-login")?.classList.add("active");
    document.getElementById("auth-tab-signup")?.classList.remove("active");
  },

  async signup() {
    const name = document.getElementById("signup-name").value.trim();
    const phone = normalizePhone(document.getElementById("signup-phone").value);
    const pin = document.getElementById("signup-pin").value.trim();

    if (name.length < 2) return App.toast("Enter your full name");
    if (phone.length < 10) return App.toast("Enter a valid phone number");
    if (!/^\d{4}$/.test(pin)) return App.toast("PIN must be exactly 4 digits");

    App.setAuthBusy("signup", true);
    try {
      const user = await Ledger.signUp({ name, phone, pin });
      App.toast("Account created");
      document.getElementById("auth-screen").classList.add("hidden");
      App.showApp(user);
    } catch (error) {
      App.toast(error.message || "Signup failed");
      App.showAuthError(error.message || "Signup failed");
    } finally {
      App.setAuthBusy("signup", false);
    }
  },

  async login() {
    const phone = normalizePhone(document.getElementById("login-phone").value);
    const pin = document.getElementById("login-pin").value.trim();

    if (phone.length < 10) return App.toast("Enter a valid phone number");
    if (!/^\d{4}$/.test(pin)) return App.toast("Enter your 4-digit PIN");

    App.setAuthBusy("login", true);
    try {
      const user = await Ledger.signIn({ phone, pin });
      App.toast("Welcome back, " + user.name.split(" ")[0]);
      document.getElementById("auth-screen").classList.add("hidden");
      App.showApp(user);
    } catch (error) {
      App.toast(error.message || "Login failed");
      App.showAuthError(error.message || "Login failed");
    } finally {
      App.setAuthBusy("login", false);
    }
  },

  async logout() {
    try {
      await Ledger.signOut();
    } catch (error) {
      App.toast(error.message || "Logout failed");
    }
    document.getElementById("app-screen").classList.add("hidden");
    document.getElementById("auth-screen").classList.remove("hidden");
    App.showLogin();
  },

  showApp(user) {
    document.getElementById("app-screen").classList.remove("hidden");
    document.getElementById("price-ticker")?.classList.add("hidden");
    App.renderHome(user);
    App.switchTab("home-tab");
  },

  showHomeLoading() {
    const total = document.getElementById("total-balance-display");
    const acct = document.getElementById("phone-account-display");
    const assets = document.getElementById("assets-list");
    if (total) total.textContent = "Loading...";
    if (acct) acct.textContent = "Acct: ---";
    if (assets) assets.innerHTML = '<div class="state-row">Loading balances...</div>';
  },

  async renderHome(user) {
    try {
      if (!user) {
        App.showHomeLoading();
        user = await Ledger.loadCurrentUser();
      }
      if (!user) return;

      const total = user.balances.reduce((sum, balance) => sum + (Number.isFinite(Number(balance.ngn_value)) ? Number(balance.ngn_value) : 0), 0);
      const firstName = user.name.split(" ")[0] || "User";

      document.querySelector(".user-greeting p").textContent = greet() + ",";
      document.getElementById("user-name-display").textContent = firstName;
      document.getElementById("total-balance-display").textContent = State.balanceVisible ? fmt(total) : "NGN ******";
      document.getElementById("phone-account-display").textContent = "Acct: " + user.accountNumber;
      document.getElementById("profile-avatar").textContent = user.name[0].toUpperCase();
      document.getElementById("profile-name-display").textContent = user.name;
      document.getElementById("profile-phone-display").textContent = user.phone;
      document.getElementById("wallet-address-display").textContent = user.wallet.address;
      document.getElementById("receive-wallet-display").textContent = user.wallet.address;
      document.getElementById("receive-phone-display").textContent = user.accountNumber;
      document.getElementById("admin-menu-item")?.classList.toggle("hidden", !State.isAdmin);

      App.renderAssets(user);
      App.renderTransactions("recent-txns");
    } catch (error) {
      App.showHomeError(error.message || "Could not load balances");
    }
  },

  renderAssets(user) {
    const el = document.getElementById("assets-list");
    if (!el) return;
    el.innerHTML = user.balances.map((balance) => {
      const meta = ASSET_META[balance.asset_code] || ASSET_META.NGN;
      const shownAmount = State.balanceVisible ? fmtAsset(balance.available, balance.asset_code) : "******";
      const hasPrice = balance.asset_code === "NGN" || Number.isFinite(Number(balance.price_per_token_ngn));
      const shownValue = State.balanceVisible
        ? (Number.isFinite(Number(balance.ngn_value)) ? fmt(balance.ngn_value) : "Price unavailable")
        : "******";
      const shownPrice = State.balanceVisible
        ? (hasPrice ? `${fmt(balance.price_per_token_ngn || 1)} / ${balance.asset_code}` : "Price unavailable")
        : "******";
      return `
        <div class="asset-item">
          <div class="asset-icon" style="background:${meta.color}22;color:${meta.color};font-size:14px;">${meta.icon}</div>
          <div class="asset-info">
            <div class="asset-name">${meta.name}</div>
            <div class="asset-detail">${balance.asset_code === "NGN" ? meta.detail : `Balance: ${shownAmount}`}</div>
            ${balance.asset_code === "NGN" ? "" : `<div class="asset-detail">Price: ${shownPrice}</div>`}
          </div>
          <div class="asset-value">
            <div class="asset-naira">${balance.asset_code === "NGN" ? shownValue : shownAmount}</div>
            ${balance.asset_code === "NGN" ? "" : `<div class="asset-pct">Value: ${shownValue}</div>`}
          </div>
        </div>`;
    }).join("");
  },

  renderTransactions(id = "recent-txns", limit = 5) {
    const el = document.getElementById(id);
    if (!el) return;
    const txns = (State.currentTransactions || []).slice(0, limit === "all" ? 100 : limit);
    if (!txns.length) {
      el.innerHTML = '<p class="state-row">No transactions yet</p>';
      return;
    }
    el.innerHTML = txns.map((t) => `
      <button class="txn-item txn-button" onclick="App.openTransactionDetail('${t.id}')">
        <div class="txn-icon ${t.direction}"><i class="fas fa-${t.direction === "in" ? "arrow-down" : "arrow-up"}"></i></div>
        <div class="txn-info">
          <div class="txn-title">${escapeHtml(t.title)}</div>
          <div class="txn-date">${timeAgo(t.created_at)}${t.note ? " · " + escapeHtml(t.note) : ""}</div>
        </div>
        <div class="txn-amount ${t.direction}">${t.direction === "in" ? "+" : "-"}${formatTxnAmount(t.amount, t.asset_code || "NGN")}</div>
      </button>`).join("");
  },

  openTransactionDetail(id) {
    const tx = (State.currentTransactions || []).find((item) => item.id === id);
    if (!tx) return App.toast("Transaction not found");
    const body = document.getElementById("transaction-detail-body");
    if (!body) return;

    const rows = [
      ["Transaction ID", tx.id],
      ["Type", tx.transaction_type || "transaction"],
      ["Status", tx.status || "posted"],
      ["Date", tx.created_at ? new Date(tx.created_at).toLocaleDateString("en-NG") : "--"],
      ["Time", tx.created_at ? new Date(tx.created_at).toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" }) : "--"],
      ["Sender name", tx.sender_name || (tx.direction === "out" ? State.currentProfile?.full_name : tx.counterparty_name)],
      ["Sender account number", tx.sender_account || (tx.direction === "out" ? State.currentProfile?.account_number : tx.counterparty_account)],
      ["Receiver name", tx.receiver_name || tx.recipient_name || (tx.direction === "in" ? State.currentProfile?.full_name : tx.counterparty_name)],
      ["Receiver account number", tx.receiver_account || tx.recipient_account || (tx.direction === "in" ? State.currentProfile?.account_number : tx.counterparty_account)],
      ["Asset", tx.asset_code || "NGN"],
      ["From asset", tx.from_asset],
      ["To asset", tx.to_asset],
      ["Rate used", tx.rate_used ? `${Number(tx.rate_used).toLocaleString("en-NG")} NGN` : null],
      ["Amount", formatTxnAmount(tx.amount, tx.asset_code || "NGN")],
      ["Fee", formatTxnAmount(tx.fee_amount || 0, tx.asset_code || "NGN")],
      ["Gas recovery", tx.gas_fee_amount ? formatTxnAmount(tx.gas_fee_amount, tx.asset_code || "NGN") : null],
      ["Total deducted", formatTxnAmount(tx.total_deducted || tx.amount, tx.asset_code || "NGN")],
      ["Bank name", tx.bank_name],
      ["Recipient name", tx.recipient_name],
      ["Recipient account", tx.recipient_account],
      ["Tx hash", tx.tx_hash],
      ["Narration", tx.narration || tx.note],
      ["Ledger transaction ID", tx.ledger_transaction_id],
      ["Created at", formatDateTime(tx.created_at)],
      ["Updated at", tx.updated_at ? formatDateTime(tx.updated_at) : "--"],
    ].filter(([, value]) => value !== undefined && value !== null && value !== "");

    body.innerHTML = rows.map(([label, value]) => `
      <div class="detail-row">
        <span>${escapeHtml(label)}</span>
        <strong>${/hash|transaction id/i.test(label) ? txHashHtml(value) : escapeHtml(value)}</strong>
      </div>
    `).join("");
    App.openModal("transaction-detail-modal");
  },

  showHomeError(message) {
    const assets = document.getElementById("assets-list");
    if (assets) assets.innerHTML = `<div class="state-row error-state">${message}</div>`;
    App.toast(message);
  },

  showAuthError(message) {
    let el = document.getElementById("auth-error");
    if (!el) {
      el = document.createElement("div");
      el.id = "auth-error";
      el.className = "auth-error";
      document.querySelector(".auth-container").appendChild(el);
    }
    el.textContent = message;
  },

  setAuthBusy(mode, busy) {
    State.authBusy = busy;
    const button = mode === "signup"
      ? document.querySelector("#signup-view .btn-primary")
      : document.querySelector("#login-view .btn-primary");
    if (!button) return;
    button.disabled = busy;
    button.textContent = busy ? "Please wait..." : (mode === "signup" ? "Create Account" : "Sign In");
  },

  switchTab(tab) {
    const map = { "home-tab": "tab-home", "crypto-tab": "tab-crypto", "history-tab": "tab-history", "profile-tab": "tab-profile" };
    const navMap = { "home-tab": "nav-home", "crypto-tab": "nav-crypto", "history-tab": "nav-history", "profile-tab": "nav-profile" };
    Object.values(map).forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.classList.remove("active");
        el.classList.add("hidden");
      }
    });
    Object.values(navMap).forEach((id) => document.getElementById(id)?.classList.remove("active"));
    document.getElementById(map[tab])?.classList.add("active");
    document.getElementById(map[tab])?.classList.remove("hidden");
    document.getElementById(navMap[tab])?.classList.add("active");
    if (tab === "home-tab") App.renderHome();
    if (tab === "history-tab") App.renderTransactions("full-txn-list", "all");
  },

  toggleBalanceVisibility() {
    State.balanceVisible = !State.balanceVisible;
    document.getElementById("eye-icon").className = "fas fa-" + (State.balanceVisible ? "eye" : "eye-slash");
    App.renderHome();
  },

  openModal(id) {
    document.getElementById(id)?.classList.remove("hidden");
    if (id === "send-modal") App._populateSendModal();
    if (id === "faucet-modal") App.loadFaucetConfig();
    if (id === "receive-modal") App.loadCryptoConfig();
    if (id === "convert-modal") App.populateConvertModal();
    if (["airtime-modal", "data-modal", "electricity-modal", "cable-modal"].includes(id)) App.populateBillModal(id.replace("-modal", ""));
  },

  closeModal(id) {
    document.getElementById(id)?.classList.add("hidden");
  },

  _populateSendModal() {
    const user = DB.getUser();
    const userSel = document.getElementById("user-send-asset");
    const userPaySel = document.getElementById("user-pay-asset");
    const bankPaySel = document.getElementById("bank-pay-asset");
    const cryptoSel = document.getElementById("crypto-send-asset");
    const cryptoPaySel = document.getElementById("crypto-pay-asset");
    if (!user || !userSel || !cryptoSel) return;

    const options = user.balances.map((balance) => {
      const label = balance.asset_code === "NGN" ? "Nigerian Naira" : `${balance.asset_code} ledger balance`;
      return `<option value="${balance.asset_code}">${label}</option>`;
    }).join("");
    userSel.innerHTML = options;
    if (userPaySel) userPaySel.innerHTML = options;
    if (bankPaySel) bankPaySel.innerHTML = options;
    if (bankPaySel) bankPaySel.value = "NGN";
    if (userPaySel) userPaySel.value = userSel.value || "NGN";
    cryptoSel.innerHTML = user.cryptoAssets.map((asset) => `<option value="${asset.symbol}">${asset.symbol}</option>`).join("");
    if (cryptoPaySel) {
      cryptoPaySel.innerHTML = options;
      cryptoPaySel.value = cryptoSel.value || "USDCX";
    }
    App.updateCryptoSendBalance();
    App.calcSendFee();
  },

  populateConvertModal() {
    const user = DB.getUser();
    const from = document.getElementById("convert-from-asset");
    const to = document.getElementById("convert-to-asset");
    if (!user || !from || !to) return;
    const options = user.balances.map((balance) => {
      const label = balance.asset_code === "NGN" ? "Nigerian Naira" : balance.asset_code;
      return `<option value="${balance.asset_code}">${label}</option>`;
    }).join("");
    from.innerHTML = options;
    to.innerHTML = options;
    from.value = "NGN";
    to.value = "USDCX";
    State.conversionPreview = null;
    App.updateConvertLabels();
  },

  updateConvertLabels() {
    const fromAsset = document.getElementById("convert-from-asset")?.value || "NGN";
    const label = document.getElementById("convert-amount-label");
    if (label) label.textContent = `Amount (${fromAsset})`;
    const preview = document.getElementById("convert-preview");
    if (preview) preview.style.display = "none";
    State.conversionPreview = null;
  },

  async previewConversion() {
    const fromAsset = document.getElementById("convert-from-asset")?.value || "NGN";
    const toAsset = document.getElementById("convert-to-asset")?.value || "USDCX";
    const amount = Number(document.getElementById("convert-amount")?.value || 0);
    if (!Number.isFinite(amount) || amount <= 0) return App.toast("Enter a valid amount");
    if (fromAsset === toAsset) return App.toast("Choose two different assets");

    App.setActionBusy("convert-preview-btn", true, "Checking...");
    try {
      const preview = await Ledger.callConversions("preview", {
        from_asset: fromAsset,
        to_asset: toAsset,
        amount,
      });
      State.conversionPreview = preview;
      document.getElementById("convert-preview").style.display = "block";
      document.getElementById("convert-rate").textContent = preview.direction === "crypto_crypto_conversion"
        ? `1 ${fromAsset} = ${Number(preview.rate_used || 0).toLocaleString("en-NG", { maximumFractionDigits: 8 })} ${toAsset}`
        : `1 ${fromAsset === "NGN" ? toAsset : fromAsset} = ${fmt(preview.rate_used)}`;
      document.getElementById("convert-fee-platform").textContent = formatTxnAmount(preview.platform_fee_amount, preview.fee_asset);
      document.getElementById("convert-fee-statutory").textContent = preview.direction === "crypto_ngn_conversion"
        ? `${fmt(preview.statutory_fee_amount)} (${formatTxnAmount(preview.statutory_fee_source_amount, preview.fee_asset)})`
        : fmt(preview.statutory_fee_amount);
      document.getElementById("convert-total").textContent = formatTxnAmount(preview.total_deducted, fromAsset);
      document.getElementById("convert-receives").textContent = formatTxnAmount(preview.receiver_gets, toAsset);
      document.getElementById("convert-rate-source").textContent = preview.direction === "crypto_crypto_conversion"
        ? `Rate source: ${preview.rate_source}; sell ${Number(preview.source_applied_ngn_usd_rate || 0).toLocaleString("en-NG")} / buy ${Number(preview.destination_applied_ngn_usd_rate || 0).toLocaleString("en-NG")} (spread ${Number(preview.spread_ngn || 0).toLocaleString("en-NG")})`
        : `Rate source: ${preview.rate_source}; NGN/USD ${Number(preview.applied_ngn_usd_rate || 0).toLocaleString("en-NG")} (${preview.direction === "ngn_crypto_conversion" ? "buy" : "sell"} spread ${Number(preview.spread_ngn || 0).toLocaleString("en-NG")})`;
    } catch (error) {
      App.toast(error.message || "Conversion preview failed");
    } finally {
      App.setActionBusy("convert-preview-btn", false, "Preview Conversion");
    }
  },

  async executeConversion() {
    const fromAsset = document.getElementById("convert-from-asset")?.value || "NGN";
    const toAsset = document.getElementById("convert-to-asset")?.value || "USDCX";
    const amount = Number(document.getElementById("convert-amount")?.value || 0);
    if (!State.conversionPreview) {
      await App.previewConversion();
      if (!State.conversionPreview) return;
    }

    App.setActionBusy("convert-confirm-btn", true, "Converting...");
    try {
      const result = await Ledger.callConversions("convert", {
        from_asset: fromAsset,
        to_asset: toAsset,
        amount,
      });
      App.closeModal("convert-modal");
      await Ledger.loadCurrentUser();
      await App.renderHome();
      const preview = result.preview || State.conversionPreview;
      const settlement = result.settlement || {};
      const txLine = settlement.treasury_tx_hash ? `\nTreasury tx: ${shortHash(settlement.treasury_tx_hash)}` : "";
      const feeLine = settlement.fee_tx_hash ? `\nFee tx: ${shortHash(settlement.fee_tx_hash)}` : "";
      const rateLine = preview.direction === "crypto_crypto_conversion"
        ? `Rate: 1 ${fromAsset} = ${Number(preview.rate_used || 0).toLocaleString("en-NG", { maximumFractionDigits: 8 })} ${toAsset}`
        : `Rate: ${fmt(preview.rate_used)} per ${fromAsset === "NGN" ? toAsset : fromAsset}`;
      App.showSuccess("Swap Complete", `${formatTxnAmount(preview.total_deducted || preview.from_amount, fromAsset)} swapped to ${formatTxnAmount(preview.receiver_gets, toAsset)}.\n${rateLine}${txLine}${feeLine}`);
    } catch (error) {
      App.toast(error.message || "Conversion failed");
    } finally {
      App.setActionBusy("convert-confirm-btn", false, "Confirm Conversion");
    }
  },

  setSendType(type) {
    State.sendType = type;
    ["bank", "user", "crypto"].forEach((t) => document.getElementById("stype-" + t)?.classList.toggle("active", t === type));
    document.getElementById("bank-send-form")?.classList.toggle("hidden", type !== "bank");
    document.getElementById("user-send-form")?.classList.toggle("hidden", type !== "user");
    document.getElementById("crypto-send-form")?.classList.toggle("hidden", type !== "crypto");
    const sendButton = document.getElementById("send-main-btn");
    if (sendButton) sendButton.textContent = { bank: "Send Money", user: "Send to User", crypto: "Send Crypto" }[type];
    App.calcSendFee();
  },

  lookupAccount() {
    const accNo = document.getElementById("send-account-no").value;
    const group = document.getElementById("account-name-group");
    const display = document.getElementById("account-name-display");
    if (accNo.length === 10) {
      display.textContent = "Simulated external bank transfer";
      group.style.display = "block";
    } else {
      group.style.display = "none";
    }
  },

  async lookupNairaXUser() {
    const recipient = document.getElementById("send-user-phone")?.value.trim() || "";
    const group = document.getElementById("user-name-group");
    const display = document.getElementById("send-user-name-display");
    if (!group || !display) return;

    if (recipient.replace(/\D/g, "").length < 10) {
      group.style.display = "none";
      return;
    }

    const seq = ++State.recipientLookupSeq;
    display.textContent = "Looking up user...";
    display.classList.remove("error-text");
    group.style.display = "block";
    try {
      const result = await Ledger.callNgnBanking("lookup_recipient", { recipient });
      if (seq !== State.recipientLookupSeq) return;
      if (!result.recipient) {
        display.textContent = "No NairaX user found";
        display.classList.add("error-text");
        return;
      }
      display.textContent = `${result.recipient.full_name} · ${result.recipient.account_number}`;
    } catch (error) {
      if (seq !== State.recipientLookupSeq) return;
      display.textContent = error.message || "Lookup failed";
      display.classList.add("error-text");
    }
  },

  async calcSendFee() {
    const amount = Number(document.getElementById("send-amount")?.value || 0);
    if (State.sendType === "bank" && amount > 0) {
      document.getElementById("fee-amount").textContent = fmt(amount);
      document.getElementById("fee-charge").textContent = "Checking...";
      document.getElementById("fee-total").textContent = fmt(amount);
      document.getElementById("fee-source").textContent = "Finding best balance...";
      document.getElementById("fee-breakdown").style.display = "block";
      const seq = ++State.feePreviewSeq;
      try {
        const preview = await Ledger.callSmartSpend("preview", {
          recipient_type: "external_bank",
          recipient_identifier: document.getElementById("send-account-no")?.value.trim() || "",
          bankName: document.getElementById("send-bank")?.value || "",
          accountName: document.getElementById("account-name-display")?.textContent.trim() || "",
          receive_asset: "NGN",
          receive_amount: amount,
          preferred_pay_asset: document.getElementById("bank-pay-asset")?.value || "NGN",
          narration: document.getElementById("send-narration")?.value.trim() || "",
        });
        if (seq !== State.feePreviewSeq) return;
        State.smartSpendPreview = preview;
        const selected = preview.selected;
        document.getElementById("fee-charge").textContent = `Platform ${formatTxnAmount(selected.platform_fee_amount || 0, selected.source_asset)}; Statutory ${fmt(selected.statutory_fee_amount || 0)}`;
        document.getElementById("fee-total").textContent = formatTxnAmount(selected.total_deducted, selected.source_asset);
        document.getElementById("fee-source").textContent = `You pay with ${selected.source_asset}; receiver gets ${fmt(preview.receive_amount)}`;
      } catch (error) {
        document.getElementById("fee-charge").textContent = friendlyError(error, "Fee preview failed");
      }
    }
    if (State.sendType === "user") {
      const asset = document.getElementById("user-send-asset")?.value || "NGN";
      const payAsset = document.getElementById("user-pay-asset")?.value || asset;
      const isNgn = asset === "NGN";
      const amount = Number((isNgn ? document.getElementById("send-user-amount") : document.getElementById("send-user-crypto-amount"))?.value || 0);
      document.getElementById("user-naira-amount-group")?.classList.toggle("hidden", !isNgn);
      document.getElementById("user-crypto-amount-group")?.classList.toggle("hidden", isNgn);
      const cryptoLabel = document.querySelector("#user-crypto-amount-group label");
      if (cryptoLabel) cryptoLabel.textContent = `Amount (${asset})`;
      if (amount <= 0) {
        document.getElementById("user-fee-breakdown").style.display = "none";
        return;
      }
      document.getElementById("user-fee-breakdown").style.display = "block";
      document.getElementById("user-fee-amount").textContent = formatTxnAmount(amount, asset);
      document.getElementById("user-fee-charge").textContent = "Checking...";
      document.getElementById("user-fee-total").textContent = formatTxnAmount(amount, asset);
      const seq = ++State.feePreviewSeq;
      try {
        const preview = await Ledger.callSmartSpend("preview", {
          recipient_type: "nairax_user",
          recipient_identifier: document.getElementById("send-user-phone")?.value.trim() || "",
          receive_asset: asset,
          receive_amount: amount,
          preferred_pay_asset: payAsset,
          narration: document.getElementById("send-user-narration")?.value.trim() || "",
        });
        if (seq !== State.feePreviewSeq) return;
        State.smartSpendPreview = preview;
        const selected = preview.selected;
        const feeText = Number(selected.platform_fee_amount || 0) || Number(selected.statutory_fee_amount || 0)
          ? `Platform ${formatTxnAmount(selected.platform_fee_amount || 0, selected.source_asset)}; Statutory ${fmt(selected.statutory_fee_amount || 0)}`
          : "Free direct internal transfer";
        document.getElementById("user-fee-charge").textContent = `${feeText}; pay with ${selected.source_asset}`;
        document.getElementById("user-fee-total").textContent = formatTxnAmount(selected.total_deducted, selected.source_asset);
        const sourceEl = document.getElementById("user-fee-source");
        if (sourceEl) sourceEl.textContent = selected.conversion_required
          ? `Auto-convert ${selected.source_asset} to ${selected.destination_asset}`
          : `Pay directly with ${selected.source_asset}`;
      } catch (error) {
        document.getElementById("user-fee-charge").textContent = friendlyError(error, "Fee preview failed");
      }
    }
  },

  updateCryptoSendBalance() {
    const user = DB.getUser();
    const sym = document.getElementById("crypto-send-asset")?.value;
    const payAsset = document.getElementById("crypto-pay-asset")?.value || sym;
    const asset = user?.balances.find((a) => a.asset_code === payAsset)
      || user?.cryptoAssets.find((a) => a.symbol === sym);
    const el = document.getElementById("crypto-send-balance");
    if (el) el.textContent = asset ? `Available to pay: ${fmtAsset(asset.available ?? asset.amount, payAsset)}` : "No balance";
  },

  validateCryptoAddress() {
    const addr = document.getElementById("crypto-send-address").value.trim();
    const status = document.getElementById("crypto-address-status");
    if (!status) return;
    if (!addr) {
      status.textContent = "";
    } else if (addr.startsWith("0x") && addr.length === 42) {
      status.textContent = "Valid address format";
      status.style.color = "var(--blue)";
    } else {
      status.textContent = "Invalid address";
      status.style.color = "var(--red)";
    }
  },

  calcCryptoSendFee() {
    App.previewExternalCryptoWithdrawal();
  },

  async previewExternalCryptoWithdrawal() {
    const amount = Number(document.getElementById("crypto-send-amount")?.value || 0);
    const sym = document.getElementById("crypto-send-asset")?.value || "ETHX";
    const payAsset = document.getElementById("crypto-pay-asset")?.value || sym;
    if (amount <= 0) {
      document.getElementById("crypto-fee-breakdown").style.display = "none";
      return;
    }
    document.getElementById("csend-amount").textContent = fmtAsset(amount, sym);
    document.getElementById("csend-fee").textContent = "Checking...";
    document.getElementById("csend-total").textContent = fmtAsset(amount, sym);
    document.getElementById("csend-naira").textContent = "Settled via NairaX Treasury Wallet";
    document.getElementById("crypto-fee-breakdown").style.display = "block";
    try {
      const preview = await Ledger.callCrypto("withdrawal_preview", {
        network: document.getElementById("crypto-send-network")?.value || "Arc Testnet",
        symbol: sym,
        pay_asset: payAsset,
        amount,
      });
      const conversionFee = preview.conversion_required
        ? ` + Convert ${fmtAsset(preview.conversion_fee_amount || 0, preview.pay_asset || payAsset)}`
        : "";
      document.getElementById("csend-fee").textContent = `External ${fmtAsset(preview.platform_fee, sym)} + Gas ${fmtAsset(preview.gas_fee_estimate, sym)}${conversionFee}`;
      document.getElementById("csend-total").textContent = fmtAsset(preview.total_deducted, preview.pay_asset || payAsset);
      document.getElementById("csend-naira").textContent = preview.conversion_required
        ? `Pay ${fmtAsset(preview.total_deducted, preview.pay_asset || payAsset)}; treasury sends ${fmtAsset(preview.amount, sym)}`
        : "Settled via NairaX Treasury Wallet";
    } catch (error) {
      document.getElementById("csend-fee").textContent = error.message || "Fee preview failed";
    }
  },

  executeSend() {
    if (State.sendType === "bank") return App._sendToBank();
    if (State.sendType === "user") return App._sendToNairaXUser();
    return App._sendExternalCrypto();
  },

  async _sendToBank() {
    const bankName = document.getElementById("send-bank").value;
    const accountNumber = document.getElementById("send-account-no").value.trim();
    const amount = Number(document.getElementById("send-amount").value || 0);
    const note = document.getElementById("send-narration").value.trim();
    const accountName = document.getElementById("account-name-display")?.textContent.trim() || "";

    if (accountNumber.length !== 10) return App.toast("Enter a valid 10-digit account number");
    if (!Number.isFinite(amount) || amount <= 0) return App.toast("Enter a valid amount");

    App.setActionBusy("send-main-btn", true, "Sending...");
    try {
      const result = await Ledger.callSmartSpend("execute", {
        recipient_type: "external_bank",
        recipient_identifier: accountNumber,
        bankName,
        accountName,
        receive_asset: "NGN",
        receive_amount: amount,
        preferred_pay_asset: document.getElementById("bank-pay-asset")?.value || "NGN",
        narration: note,
      });
      App.closeModal("send-modal");
      await App.renderHome();
      const selected = result.preview?.selected || {};
      App.showSuccess("Smart Spend Complete", `${fmt(amount)} simulated transfer to ${bankName} ${accountNumber}.\nPaid with ${formatTxnAmount(selected.total_deducted || amount, selected.source_asset || "NGN")}.\nNo real money moved.`);
    } catch (error) {
      App.toast(friendlyError(error, "Transfer failed"));
    } finally {
      App.setActionBusy("send-main-btn", false, "Send Money");
    }
  },

  async _sendToNairaXUser() {
    const recipient = document.getElementById("send-user-phone").value.trim();
    const asset = document.getElementById("user-send-asset")?.value || "NGN";
    const payAsset = document.getElementById("user-pay-asset")?.value || asset;
    const isNgn = asset === "NGN";
    const amount = Number((isNgn ? document.getElementById("send-user-amount") : document.getElementById("send-user-crypto-amount")).value || 0);
    const note = document.getElementById("send-user-narration").value.trim();

    if (!recipient) return App.toast("Enter recipient phone or account number");
    if (!Number.isFinite(amount) || amount <= 0) return App.toast("Enter a valid amount");

    App.setActionBusy("send-main-btn", true, "Sending...");
    try {
      const result = await Ledger.callSmartSpend("execute", {
        recipient_type: "nairax_user",
        recipient_identifier: recipient,
        receive_asset: asset,
        receive_amount: amount,
        preferred_pay_asset: payAsset,
        narration: note,
      });
      App.closeModal("send-modal");
      await App.renderHome();
      const selected = result.preview?.selected || {};
      App.showSuccess("Smart Spend Complete", `${formatTxnAmount(amount, asset)} sent to ${recipient}.\nPaid with ${formatTxnAmount(selected.total_deducted || amount, selected.source_asset || asset)}.`);
    } catch (error) {
      App.toast(friendlyError(error, "Transfer failed"));
    } finally {
      App.setActionBusy("send-main-btn", false, "Send to User");
    }
  },

  async _sendExternalCrypto() {
    const network = document.getElementById("crypto-send-network")?.value || "Arc Testnet";
    const symbol = document.getElementById("crypto-send-asset")?.value || "";
    const payAsset = document.getElementById("crypto-pay-asset")?.value || symbol;
    const recipient = document.getElementById("crypto-send-address")?.value.trim() || "";
    const amount = Number(document.getElementById("crypto-send-amount")?.value || 0);
    if (!symbol) return App.toast("Select a token");
    if (!recipient.startsWith("0x") || recipient.length !== 42) return App.toast("Enter a valid EVM address");
    if (!Number.isFinite(amount) || amount <= 0) return App.toast("Enter a valid amount");

    App.setActionBusy("send-main-btn", true, "Sending...");
    try {
      const result = await Ledger.callCrypto("external_withdrawal", { network, symbol, pay_asset: payAsset, recipient, amount });
      App.closeModal("send-modal");
      await Ledger.loadCurrentUser();
      await App.renderHome();
      App.showSuccess("External Crypto Sent", `${fmtAsset(result.amount, result.symbol)} sent to external wallet.\nPaid with ${fmtAsset(result.total_deducted, result.pay_asset || result.symbol)}.\nTx: ${shortHash(result.tx_hash)}`);
    } catch (error) {
      App.toast(error.message || "External crypto send failed");
    } finally {
      App.setActionBusy("send-main-btn", false, "Send Crypto");
    }
  },

  setReceiveTab(tab) {
    document.querySelectorAll(".rtab").forEach((b) => b.classList.remove("active"));
    const activeTarget = window.event?.target;
    if (activeTarget) activeTarget.classList.add("active");
    document.getElementById("receive-naira").classList.toggle("hidden", tab !== "naira");
    document.getElementById("receive-crypto").classList.toggle("hidden", tab !== "crypto");
  },

  copyPhone() {
    const user = DB.getUser();
    navigator.clipboard?.writeText(user?.accountNumber || "").catch(() => {});
    App.toast("Account number copied");
  },

  copyWalletAddress() {
    const user = DB.getUser();
    navigator.clipboard?.writeText(user?.wallet.address || "").catch(() => {});
    App.toast("Wallet address copied");
  },

  async loadCryptoConfig() {
    try {
      const config = await Ledger.callCrypto("config");
      State.cryptoTokens = config.tokens || [];
      State.cryptoDeposits = config.deposits || [];
      State.cryptoWithdrawals = config.withdrawals || [];
      if (config.wallet_address) {
        document.getElementById("receive-wallet-display").textContent = config.wallet_address;
      }
      App.populateReceiveCryptoControls();
    } catch (error) {
      App.toast(error.message || "Could not load crypto config");
    }
  },

  populateReceiveCryptoControls() {
    const networkSelect = document.getElementById("receive-crypto-network");
    const tokenSelect = document.getElementById("receive-crypto-token");
    const networks = [...new Set(State.cryptoTokens.map((token) => token.network))];
    if (networkSelect) {
      networkSelect.innerHTML = networks.map((network) => `<option value="${escapeHtml(network)}">${escapeHtml(network)}</option>`).join("");
    }
    if (tokenSelect) {
      App.renderReceiveCryptoTokens();
    }
  },

  renderReceiveCryptoTokens() {
    const network = document.getElementById("receive-crypto-network")?.value || "Arc Testnet";
    const tokenSelect = document.getElementById("receive-crypto-token");
    const tokens = State.cryptoTokens.filter((token) => token.network === network);
    if (tokenSelect) {
      tokenSelect.innerHTML = tokens.map((token) => `<option value="${escapeHtml(token.symbol)}">${escapeHtml(token.symbol)}</option>`).join("");
    }
  },

  async verifyCryptoDeposit() {
    const network = document.getElementById("receive-crypto-network")?.value || "Arc Testnet";
    const symbol = document.getElementById("receive-crypto-token")?.value || "";
    const txHash = document.getElementById("receive-crypto-txhash")?.value.trim() || "";
    if (!symbol) return App.toast("Select a token");
    if (!txHash) return App.toast("Paste the transaction hash");
    App.setActionBusy("verify-deposit-btn", true, "Verifying...");
    try {
      const result = await Ledger.callCrypto("verify_deposit", { network, symbol, txHash });
      await Ledger.loadCurrentUser();
      await App.renderHome();
      App.showSuccess("Deposit Verified", `${fmtAsset(result.amount, result.symbol)} credited.\nTx: ${shortHash(result.tx_hash)}`);
    } catch (error) {
      App.toast(error.message || "Deposit verification failed");
    } finally {
      App.setActionBusy("verify-deposit-btn", false, "Verify Deposit");
    }
  },

  refreshCryptoBalances() {
    App.toast("On-chain balance indexing is not implemented in Phase 1");
  },

  async loadFaucetConfig() {
    const networkSelect = document.getElementById("faucet-network");
    const tokenSelect = document.getElementById("faucet-token");
    const status = document.getElementById("faucet-status");
    if (status) status.textContent = "Loading faucet config...";
    try {
      const config = await Ledger.callFaucet("config");
      State.faucetTokens = config.tokens || [];
      State.faucetClaims = config.claims || [];
      const networks = [...new Set(State.faucetTokens.map((token) => token.network))];
      if (networkSelect) {
        networkSelect.innerHTML = networks.map((network) => `<option value="${escapeHtml(network)}">${escapeHtml(network)}</option>`).join("");
      }
      if (tokenSelect) tokenSelect.innerHTML = "";
      App.renderFaucetTokens();
      if (status) status.textContent = "Demo tokens run on testnets and have no real value.";
    } catch (error) {
      if (status) status.textContent = error.message || "Could not load faucet config";
    }
  },

  renderFaucetTokens() {
    const network = document.getElementById("faucet-network")?.value || "Arc Testnet";
    const tokenSelect = document.getElementById("faucet-token");
    const tokens = State.faucetTokens.filter((token) => token.network === network);
    if (!tokenSelect) return;
    tokenSelect.innerHTML = tokens.map((token) => (
      `<option value="${escapeHtml(token.symbol)}">${escapeHtml(token.symbol)} - ${token.faucet_amount}</option>`
    )).join("");
    App.updateFaucetPreview();
  },

  updateFaucetPreview() {
    const network = document.getElementById("faucet-network")?.value || "Arc Testnet";
    const symbol = document.getElementById("faucet-token")?.value || "";
    const token = State.faucetTokens.find((item) => item.network === network && item.symbol === symbol);
    const claim = State.faucetClaims.find((item) => item.network === network && item.token_symbol === symbol);
    const amount = document.getElementById("faucet-amount");
    const status = document.getElementById("faucet-status");
    const hash = document.getElementById("faucet-hash");
    const button = document.getElementById("faucet-claim-btn");

    if (amount) amount.textContent = token ? formatTxnAmount(token.faucet_amount, token.symbol) : "--";
    if (status) status.textContent = claim
      ? `Already claimed: ${claim.status}`
      : "Demo tokens run on testnets and have no real value.";
    if (hash) {
      hash.innerHTML = claim?.tx_hash
        ? `<a class="short-hash" title="${escapeHtml(claim.tx_hash)}" href="${escapeHtml(App.explorerTxUrl(token, claim.tx_hash) || "#")}" target="_blank" rel="noreferrer">${escapeHtml(shortHash(claim.tx_hash))}</a>`
        : "";
    }
    if (button) button.disabled = Boolean(claim && claim.status !== "failed") || !token;
  },

  explorerTxUrl(token, txHash) {
    if (!token?.explorer_base_url || !txHash) return "";
    return `${String(token.explorer_base_url).replace(/\/$/, "")}/tx/${txHash}`;
  },

  async requestFaucetToken() {
    const network = document.getElementById("faucet-network")?.value || "Arc Testnet";
    const symbol = document.getElementById("faucet-token")?.value || "";
    if (!symbol) return App.toast("Select a token");
    App.setActionBusy("faucet-claim-btn", true, "Requesting...");
    try {
      const result = await Ledger.callFaucet("claim_token", { network, symbol });
      await Ledger.loadCurrentUser();
      App.renderHome();
      await App.loadFaucetConfig();
      const explorerLine = result.explorer_url ? "\nExplorer link is available in faucet history." : "";
      App.showSuccess("Demo Token Funded", `${formatTxnAmount(result.amount, result.symbol)} sent on ${result.network}.\nTx: ${shortHash(result.tx_hash)}${explorerLine}`);
    } catch (error) {
      App.toast(error.message || "Faucet request failed");
    } finally {
      App.setActionBusy("faucet-claim-btn", false, "Request Test Token");
      App.updateFaucetPreview();
    }
  },

  async addTestNaira() {
    document.getElementById("simulate-deposit-btn")?.classList.add("is-busy");
    try {
      await Ledger.callNgnBanking("simulate_deposit", { amount: 100000 });
      App.closeModal("add-money-modal");
      await App.renderHome();
      App.showSuccess("Simulated Deposit Added", `${fmt(100000)} added to your NGN balance.\nNo real money moved.`);
    } catch (error) {
      App.toast(error.message || "Deposit failed");
    } finally {
      document.getElementById("simulate-deposit-btn")?.classList.remove("is-busy");
    }
  },

  selectNetwork(el, net) {
    el.closest(".network-grid").querySelectorAll(".net-item").forEach((i) => i.classList.remove("active-net"));
    el.classList.add("active-net");
    State.currentNetwork = net;
    const modal = el.closest(".modal-overlay");
    if (modal?.id === "airtime-modal") App.previewBillPayment("airtime");
    if (modal?.id === "data-modal") App.previewBillPayment("data");
  },

  populateBillModal(type) {
    const user = DB.getUser();
    const select = document.getElementById(`${type}-pay-asset`);
    if (!user || !select) return;
    const previous = select.value || "NGN";
    select.innerHTML = user.balances.map((balance) => {
      const label = balance.asset_code === "NGN" ? "Nigerian Naira" : `${balance.asset_code} ledger balance`;
      return `<option value="${balance.asset_code}">${label}</option>`;
    }).join("");
    select.value = user.balances.some((balance) => balance.asset_code === previous) ? previous : "NGN";
    App.previewBillPayment(type);
  },

  getBillPayload(type) {
    if (type === "airtime") {
      return {
        modalId: "airtime-modal",
        buttonId: "airtime-pay-btn",
        title: "Airtime Purchase",
        provider: State.currentNetwork || "MTN",
        identifier: document.getElementById("airtime-phone")?.value.trim() || "",
        amount: Number(document.getElementById("airtime-amount")?.value || 0),
        payAsset: document.getElementById("airtime-pay-asset")?.value || "NGN",
        narration: `Simulated airtime purchase for ${document.getElementById("airtime-phone")?.value.trim() || "phone"}`,
      };
    }
    if (type === "data") {
      const plan = document.getElementById("data-plan");
      return {
        modalId: "data-modal",
        buttonId: "data-pay-btn",
        title: "Data Purchase",
        provider: State.currentNetwork || "MTN",
        identifier: document.getElementById("data-phone")?.value.trim() || "",
        amount: Number(plan?.value || 0),
        payAsset: document.getElementById("data-pay-asset")?.value || "NGN",
        narration: `Simulated ${plan?.selectedOptions?.[0]?.textContent || "data"} purchase`,
      };
    }
    if (type === "electricity") {
      return {
        modalId: "electricity-modal",
        buttonId: "electricity-pay-btn",
        title: "Electricity Payment",
        provider: document.getElementById("disco-select")?.value || "Electricity",
        identifier: document.getElementById("meter-number")?.value.trim() || "",
        amount: Number(document.getElementById("electricity-amount")?.value || 0),
        payAsset: document.getElementById("electricity-pay-asset")?.value || "NGN",
        narration: `Simulated electricity payment for meter ${document.getElementById("meter-number")?.value.trim() || ""}`,
      };
    }
    const pack = document.getElementById("cable-package");
    return {
      modalId: "cable-modal",
      buttonId: "cable-pay-btn",
      title: "Cable TV Subscription",
      provider: document.getElementById("cable-provider")?.value || "Cable TV",
      identifier: document.getElementById("cable-card")?.value.trim() || "",
      amount: Number(pack?.value || 0),
      payAsset: document.getElementById("cable-pay-asset")?.value || "NGN",
      narration: `Simulated ${pack?.selectedOptions?.[0]?.textContent || "cable"} subscription`,
    };
  },

  async previewBillPayment(type) {
    const payload = App.getBillPayload(type);
    const previewBox = document.getElementById(`${type}-bill-preview`);
    if (!previewBox) return null;
    if (!Number.isFinite(payload.amount) || payload.amount <= 0) {
      previewBox.style.display = "none";
      return null;
    }
    previewBox.style.display = "block";
    document.getElementById(`${type}-bill-amount`).textContent = fmt(payload.amount);
    document.getElementById(`${type}-bill-fee`).textContent = "Checking...";
    document.getElementById(`${type}-bill-total`).textContent = formatTxnAmount(payload.amount, payload.payAsset);
    document.getElementById(`${type}-bill-source`).textContent = `Pay with ${payload.payAsset}`;
    const seq = ++State.billPreviewSeq;
    try {
      const preview = await Ledger.callSmartSpend("preview", {
        recipient_type: "bill_payment",
        recipient_identifier: payload.identifier || `${type}-${Date.now()}`,
        bankName: payload.provider,
        accountName: payload.title,
        receive_asset: "NGN",
        receive_amount: payload.amount,
        preferred_pay_asset: payload.payAsset,
        narration: payload.narration,
      });
      if (seq !== State.billPreviewSeq) return null;
      const selected = preview.selected || {};
      const feeText = Number(selected.platform_fee_amount || 0)
        ? `Platform ${formatTxnAmount(selected.platform_fee_amount, selected.source_asset)}`
        : "No fee";
      document.getElementById(`${type}-bill-fee`).textContent = feeText;
      document.getElementById(`${type}-bill-total`).textContent = formatTxnAmount(selected.total_deducted, selected.source_asset);
      document.getElementById(`${type}-bill-source`).textContent = selected.conversion_required
        ? `Pay with ${selected.source_asset}; spread ${Number(selected.spread_ngn || 0).toLocaleString("en-NG")}`
        : `Pay directly with ${selected.source_asset}`;
      return preview;
    } catch (error) {
      if (seq !== State.billPreviewSeq) return null;
      document.getElementById(`${type}-bill-fee`).textContent = friendlyError(error, "Preview failed");
      return null;
    }
  },

  async payBill(type) {
    const payload = App.getBillPayload(type);
    if (!payload.identifier) return App.toast("Enter the bill recipient details");
    if (!Number.isFinite(payload.amount) || payload.amount <= 0) return App.toast("Enter a valid amount");
    App.setActionBusy(payload.buttonId, true, "Paying...");
    try {
      const result = await Ledger.callSmartSpend("execute", {
        recipient_type: "bill_payment",
        recipient_identifier: payload.identifier,
        bankName: payload.provider,
        accountName: payload.title,
        receive_asset: "NGN",
        receive_amount: payload.amount,
        preferred_pay_asset: payload.payAsset,
        narration: payload.narration,
      });
      App.closeModal(payload.modalId);
      await App.renderHome();
      const selected = result.preview?.selected || {};
      App.showSuccess(payload.title, `${fmt(payload.amount)} paid to ${payload.provider}.\nDeducted ${formatTxnAmount(selected.total_deducted || payload.amount, selected.source_asset || payload.payAsset)}.\nSimulated bill payment only.`);
    } catch (error) {
      App.toast(friendlyError(error, "Bill payment failed"));
    } finally {
      const labels = { airtime: "Buy Airtime", data: "Buy Data", electricity: "Pay Now", cable: "Subscribe" };
      App.setActionBusy(payload.buttonId, false, labels[type] || "Pay");
    }
  },

  buyAirtime() { return App.payBill("airtime"); },
  buyData() { return App.payBill("data"); },
  payElectricity() { return App.payBill("electricity"); },
  payCable() { return App.payBill("cable"); },

  requirePin() {
    App.toast("PIN authorization is not needed in Phase 1");
  },

  pinInput(val) {
    if (val === "clr") State.pinBuffer = State.pinBuffer.slice(0, -1);
    else if (val === "ok") {
      State.pinBuffer = "";
      App.updatePinDots();
      App.closeModal("pin-modal");
      return;
    } else if (State.pinBuffer.length < 4) State.pinBuffer += val;
    App.updatePinDots();
  },

  updatePinDots() {
    document.querySelectorAll("#pin-dots span").forEach((d, i) => d.classList.toggle("filled", i < State.pinBuffer.length));
  },

  setActionBusy(id, busy, text) {
    const button = document.getElementById(id);
    if (!button) return;
    button.disabled = busy;
    if (text) button.textContent = text;
  },

  showSuccess(title, msg) {
    document.getElementById("success-title").textContent = title;
    document.getElementById("success-message").textContent = msg;
    document.getElementById("success-overlay").classList.remove("hidden");
  },

  closeSuccess() {
    document.getElementById("success-overlay").classList.add("hidden");
  },

  _toastTimer: null,
  toast(msg) {
    const t = document.getElementById("toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(App._toastTimer);
    App._toastTimer = setTimeout(() => t.classList.add("hidden"), 3000);
  },

  showNotifications() {
    App.toast("No new notifications");
  },

  openAdmin() {
    document.getElementById("app-screen")?.classList.add("hidden");
    document.getElementById("admin-screen")?.classList.remove("hidden");
    const panel = document.getElementById("admin-page-panel");
    if (panel) panel.innerHTML = '<p class="admin-empty">Loading admin data...</p>';
    App.switchAdminTab(State.adminTab || "overview", true);
  },

  closeAdmin() {
    document.getElementById("admin-screen")?.classList.add("hidden");
    document.getElementById("app-screen")?.classList.remove("hidden");
  },

  switchAdminTab(tab, force = false) {
    State.adminTab = tab;
    document.querySelectorAll("[data-admin-tab]").forEach((button) => {
      button.classList.toggle("active", button.dataset.adminTab === tab);
    });
    document.querySelector(`[data-admin-tab="${tab}"]`)?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    App.loadAdminTab(tab, force);
  },

  async loadAdminTab(tab, force = false) {
    const panel = document.getElementById("admin-page-panel");
    if (!panel) return;
    const cached = State.adminData[tab];
    if (cached && !force && Date.now() - cached.loadedAt < 45000) {
      App.renderAdminPanel();
      return;
    }

    panel.innerHTML = '<p class="admin-empty">Loading section...</p>';
    try {
      const data = await Ledger.callAdmin(tab);
      State.adminData[tab] = { ...data, loadedAt: Date.now() };
      if (tab === "overview") App.updateAdminTopCards(data);
      App.renderAdminPanel();
    } catch (error) {
      panel.innerHTML = `<p class="admin-empty error-state">${escapeHtml(friendlyError(error, "Admin section failed"))}</p>`;
      App.toast(friendlyError(error, "Admin section failed"));
    }
  },

  updateAdminTopCards(summary = {}) {
    const ngnLiability = summary.customer_liabilities?.NGN || 0;
    const estimatedVolume = Number(summary.volume_analytics?.estimated_ngn_volume || 0);
    const ngnPlatformFees = Number(summary.ledger_fee_revenue?.NGN ?? 0);
    const cryptoLiabilities = Object.entries(summary.customer_liabilities || {})
      .filter(([asset]) => asset !== "NGN")
      .map(([asset, value]) => `${fmtAsset(value, asset)}`)
      .join(" · ") || "0";

    document.getElementById("admin-pool-naira").textContent = fmt(ngnLiability);
    document.getElementById("admin-pool-eth").textContent = fmt(ngnPlatformFees);
    document.getElementById("admin-pool-eth-naira").textContent = "NGN platform fee revenue";
    document.getElementById("admin-pool-total").textContent = String(summary.transaction_count || 0);
    document.getElementById("admin-user-count").textContent = String(summary.user_count || 0);
    document.getElementById("admin-user-balances").textContent = `Est. volume: ${fmt(estimatedVolume)} · Crypto liabilities: ${cryptoLiabilities}`;
    document.getElementById("admin-eth-rate").textContent = `USD/NGN ${Number(summary.price_data?.base_ngn_usd_rate || 0).toLocaleString("en-NG")}`;
    document.getElementById("admin-eth-change").textContent = `Buy ${Number(summary.price_data?.ngn_buy_rate || 0).toLocaleString("en-NG")} / Sell ${Number(summary.price_data?.ngn_sell_rate || 0).toLocaleString("en-NG")}`;
    document.getElementById("admin-last-update").textContent = new Date().toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" });
    document.getElementById("admin-settlement-count").textContent = "Load Ledger tab";
  },

  async renderAdmin() {
    delete State.adminData[State.adminTab || "overview"];
    await App.loadAdminTab(State.adminTab || "overview", true);
    return;

    try {
      const panel = document.getElementById("admin-page-panel");
      if (panel) panel.innerHTML = '<p class="admin-empty">Refreshing admin data...</p>';
      const summary = await Ledger.callAdmin("summary");
      State.adminSummary = summary;
      const byType = summary.platform_balances_by_type || {};
      const ngnLiability = summary.customer_liabilities?.NGN || 0;
      const estimatedVolume = Number(summary.volume_analytics?.estimated_ngn_volume || 0);
      const ngnPlatformFees = Number(summary.ledger_fee_revenue?.NGN ?? summary.fees?.platform?.NGN ?? 0);
      const cryptoLiabilities = Object.entries(summary.customer_liabilities || {})
        .filter(([asset]) => asset !== "NGN")
        .map(([asset, value]) => `${fmtAsset(value, asset)}`)
        .join(" · ") || "0";

      document.getElementById("admin-pool-naira").textContent = fmt(ngnLiability);
      document.getElementById("admin-pool-eth").textContent = fmt(ngnPlatformFees);
      document.getElementById("admin-pool-eth-naira").textContent = "NGN platform fee revenue";
      document.getElementById("admin-pool-total").textContent = String(summary.transaction_count || 0);
      document.getElementById("admin-user-count").textContent = String(summary.user_count || 0);
      document.getElementById("admin-user-balances").textContent = `Est. volume: ${fmt(estimatedVolume)} · Crypto liabilities: ${cryptoLiabilities}`;
      document.getElementById("admin-eth-rate").textContent = `USD/NGN ${Number(summary.price_data?.base_ngn_usd_rate || 0).toLocaleString("en-NG")}`;
      document.getElementById("admin-eth-change").textContent = `Buy ${Number(summary.price_data?.ngn_buy_rate || 0).toLocaleString("en-NG")} / Sell ${Number(summary.price_data?.ngn_sell_rate || 0).toLocaleString("en-NG")}`;
      document.getElementById("admin-last-update").textContent = new Date().toLocaleTimeString("en-NG", { hour: "2-digit", minute: "2-digit" });
      document.getElementById("admin-settlement-count").textContent = String((summary.recent_ledger_entries || []).length);

      const log = document.getElementById("admin-settlement-log");
      if (log) {
        log.innerHTML = (summary.recent_ledger_entries || []).length
          ? summary.recent_ledger_entries.map((entry) => `
            <div class="settlement-item">
              <div class="si-title">${escapeHtml(entry.entry_role)} · ${escapeHtml(entry.direction)} ${formatTxnAmount(entry.amount, entry.asset_code)}</div>
              <div class="si-detail">${escapeHtml(entry.account_type)} · ${escapeHtml(entry.memo || "")}</div>
            </div>
          `).join("")
          : '<p class="admin-empty">No ledger entries yet</p>';
      }

      const users = document.getElementById("admin-users-list");
      if (users) {
        users.innerHTML = (summary.users || []).length
          ? summary.users.map((user) => `
            <div class="admin-user-item">
              <div class="aui-avatar">${escapeHtml((user.full_name || "U")[0].toUpperCase())}</div>
              <div class="aui-info">
                <div class="aui-name">${escapeHtml(user.full_name)}</div>
                <div class="aui-phone">${escapeHtml(user.phone)} · ${escapeHtml(user.account_number)}</div>
              </div>
              <div class="aui-bal">
                <div class="aui-naira">${new Date(user.created_at).toLocaleDateString("en-NG")}</div>
                <div class="aui-crypto">${user.external_ngn_transfer_count || 0} external NGN</div>
              </div>
            </div>
          `).join("")
          : '<p class="admin-empty">No users yet</p>';
      }
      App.renderAdminPanel();
    } catch (error) {
      const panel = document.getElementById("admin-page-panel");
      if (panel) panel.innerHTML = `<p class="admin-empty error-state">${escapeHtml(friendlyError(error, "Admin dashboard failed"))}</p>`;
      App.toast(friendlyError(error, "Admin dashboard failed"));
    }
  },

  renderAdminPanel() {
    const panel = document.getElementById("admin-page-panel");
    const summary = State.adminData[State.adminTab] || State.adminSummary;
    if (!panel || !summary) return;

    const moneyRows = (rows = []) => rows.map((row) => `
      <div class="settlement-item">
        <div class="si-title">${escapeHtml(row.account_type || row.label)} · ${escapeHtml(row.asset_code || row.asset || "")}</div>
        <div class="si-detail">${escapeHtml(row.account_name || "")} · ${formatTxnAmount(row.available ?? row.amount ?? 0, row.asset_code || row.asset || "NGN")}</div>
      </div>
    `).join("");

    if (State.adminTab === "overview") {
      const volumeRows = Object.entries(summary.volume_analytics?.by_asset || {}).map(([asset, amount]) => {
        const profit = summary.volume_analytics?.profitability_by_asset?.[asset] || {};
        return `
          <div class="settlement-item">
            <div class="si-title">${escapeHtml(asset)} volume moved</div>
            <div class="si-detail">${formatTxnAmount(amount, asset)} · fees ${formatTxnAmount(profit.platform_fee_revenue || 0, asset)} · take rate ${Number(profit.fee_take_rate_percent || 0).toFixed(3)}%</div>
          </div>
        `;
      }).join("");
      const typeRows = Object.entries(summary.volume_analytics?.by_transaction_type || {}).map(([type, assets]) => `
        <div class="settlement-item">
          <div class="si-title">${escapeHtml(type)}</div>
          <div class="si-detail">${Object.entries(assets).map(([asset, amount]) => formatTxnAmount(amount, asset)).join(" · ")}</div>
        </div>
      `).join("");
      panel.innerHTML = `
        <div class="settlement-item"><div class="si-title">Users</div><div class="si-detail">${summary.user_count || 0}</div></div>
        <div class="settlement-item"><div class="si-title">Transactions</div><div class="si-detail">${summary.transaction_count || 0}</div></div>
        <div class="settlement-item"><div class="si-title">Estimated NGN Volume</div><div class="si-detail">${fmt(summary.volume_analytics?.estimated_ngn_volume || 0)}</div></div>
        <div class="settlement-item"><div class="si-title">Failed/Pending/Reversed</div><div class="si-detail">${(summary.failed_transactions || []).length}</div></div>
        <div class="admin-section-title">Volume By Asset</div>
        ${volumeRows || '<p class="admin-empty">No volume yet</p>'}
        <div class="admin-section-title">Volume By Transaction Type</div>
        ${typeRows || '<p class="admin-empty">No transaction volume yet</p>'}
      `;
      return;
    }

    if (State.adminTab === "pools") {
      panel.innerHTML = moneyRows(summary.platform_balances || []) || '<p class="admin-empty">No platform balances</p>';
      return;
    }

    if (State.adminTab === "volume") {
      const volumeRows = Object.entries(summary.volume_analytics?.by_asset || {}).map(([asset, amount]) => {
        const profit = summary.volume_analytics?.profitability_by_asset?.[asset] || {};
        return `
          <div class="settlement-item">
            <div class="si-title">${escapeHtml(asset)} moved</div>
            <div class="si-detail">Volume ${formatTxnAmount(amount, asset)} · platform fees ${formatTxnAmount(profit.platform_fee_revenue || 0, asset)} · take rate ${Number(profit.fee_take_rate_percent || 0).toFixed(3)}%</div>
          </div>
        `;
      }).join("");
      const typeRows = Object.entries(summary.volume_analytics?.by_transaction_type || {}).map(([type, assets]) => `
        <div class="settlement-item">
          <div class="si-title">${escapeHtml(type)}</div>
          <div class="si-detail">${Object.entries(assets).map(([asset, amount]) => formatTxnAmount(amount, asset)).join(" · ")}</div>
        </div>
      `).join("");
      panel.innerHTML = `
        <div class="settlement-item">
          <div class="si-title">Estimated Total NGN Volume</div>
          <div class="si-detail">${fmt(summary.volume_analytics?.estimated_ngn_volume || 0)} using current mid prices for crypto.</div>
        </div>
        <div class="admin-section-title">Volume And Fee Take Rate</div>
        ${volumeRows || '<p class="admin-empty">No volume yet</p>'}
        <div class="admin-section-title">Volume By Transaction Type</div>
        ${typeRows || '<p class="admin-empty">No transaction volume yet</p>'}
      `;
      return;
    }

    if (State.adminTab === "fees") {
      const fees = Object.entries(summary.fees?.platform || {}).map(([asset, amount]) => ({ label: "Platform fee revenue", asset, amount }));
      const ledgerFees = Object.entries(summary.ledger_fee_revenue || {}).map(([asset, amount]) => ({ label: "Ledger fee revenue balance", asset, amount }));
      const settledCrypto = Object.entries(summary.settled_crypto_fee_revenue || {}).map(([asset, amount]) => ({ label: "Settled to Fee Wallet", asset, amount }));
      const statutory = Object.entries(summary.cbn_statutory_payable || {}).map(([asset, amount]) => ({ label: "CBN statutory payable", asset, amount }));
      const feeWalletRows = (summary.fee_wallet_token_balances || []).map((row) => ({
        label: row.balance === null ? "On-chain Fee Wallet unavailable" : "On-chain Fee Wallet",
        asset: row.symbol,
        amount: row.balance ?? 0,
        account_name: row.error || row.wallet_address || "",
      }));
      const unsettledRows = Object.entries(summary.unsettled_fee_amounts || {}).map(([asset, amount]) => ({
        label: "Unsettled on-chain fee",
        asset,
        amount,
      }));
      const settlementControls = Object.entries(summary.unsettled_fee_amounts || {})
        .filter(([asset, amount]) => asset !== "NGN" && Number(amount) > 0)
        .map(([asset, amount]) => `
          <div class="settlement-action">
            <div>
              <div class="si-title">${escapeHtml(asset)} unsettled fee revenue</div>
              <div class="si-detail">${formatTxnAmount(amount, asset)} can be moved from Treasury Wallet to Fee Wallet.</div>
            </div>
            <button class="admin-btn green compact" onclick="App.settleCryptoFees('${escapeHtml(asset)}')">Settle</button>
          </div>
        `).join("");
      const settlementHistory = (summary.crypto_fee_settlements || [])
        .slice(0, 20)
        .map((row) => `
          <div class="settlement-item">
            <div class="si-title">${escapeHtml(row.asset_symbol)} settlement - ${escapeHtml(row.status)}</div>
            <div class="si-detail">${formatTxnAmount(row.amount, row.asset_symbol)} - ${row.tx_hash ? txHashHtml(row.tx_hash) : escapeHtml(row.failure_reason || "pending")}</div>
          </div>
        `).join("");
      const feeSettlementRows = (summary.crypto_withdrawals || [])
        .filter((row) => row.fee_tx_hash || row.fee_settlement_error)
        .slice(0, 20)
        .map((row) => `
          <div class="settlement-item">
            <div class="si-title">${escapeHtml(row.token_symbol)} fee settlement - ${escapeHtml(row.fee_settlement_status || "unknown")}</div>
            <div class="si-detail">${formatTxnAmount(row.platform_fee || 0, row.token_symbol)} - ${row.fee_tx_hash ? txHashHtml(row.fee_tx_hash) : escapeHtml(row.fee_settlement_error || "")}</div>
          </div>
        `).join("");
      panel.innerHTML = [
        '<div class="admin-section-title">Settle Crypto Fees</div>',
        settlementControls || '<p class="admin-empty">No unsettled crypto fees to settle.</p>',
        ledgerFees.length ? '<div class="admin-section-title">Ledger Fee Revenue</div>' + moneyRows(ledgerFees) : '',
        settledCrypto.length ? '<div class="admin-section-title">Settled Crypto Fees</div>' + moneyRows(settledCrypto) : '',
        moneyRows(fees) || '<p class="admin-empty">No ledger fees collected yet</p>',
        statutory.length ? '<div class="admin-section-title">CBN Statutory Payable</div>' + moneyRows(statutory) : '',
        feeWalletRows.length ? '<div class="admin-section-title">On-chain Fee Wallet</div>' + moneyRows(feeWalletRows) : '',
        unsettledRows.length ? '<div class="admin-section-title">Unsettled Fees</div>' + moneyRows(unsettledRows) : '',
        settlementHistory ? '<div class="admin-section-title">Settlement Batches</div>' + settlementHistory : '',
        feeSettlementRows ? '<div class="admin-section-title">Fee Settlement Tx Hashes</div>' + feeSettlementRows : '',
      ].join("");
      return;
    }

    if (State.adminTab === "users") {
      panel.innerHTML = (summary.users || []).map((user) => `
        <div class="settlement-item">
          <div class="si-title">${escapeHtml(user.full_name)}</div>
          <div class="si-detail">${escapeHtml(user.phone)} · ${escapeHtml(user.account_number)}</div>
        </div>
      `).join("") || '<p class="admin-empty">No users yet</p>';
      return;
    }

    if (State.adminTab === "transactions") {
      const failed = summary.failed_transactions || [];
      panel.innerHTML = `
        ${(summary.recent_transactions || []).map((tx) => `
          <div class="settlement-item">
            <div class="si-title">${escapeHtml(tx.transaction_type)} · ${escapeHtml(tx.status)}</div>
            <div class="si-detail">${formatTxnAmount(tx.amount, tx.asset_code || "NGN")} · ${escapeHtml(tx.description || "")}</div>
          </div>
        `).join("") || '<p class="admin-empty">No transactions yet</p>'}
        ${failed.length ? `<div class="admin-section-title">Failed / Pending</div>${failed.map((tx) => `
          <div class="settlement-item">
            <div class="si-title">${escapeHtml(tx.transaction_type)} · ${escapeHtml(tx.status)}</div>
            <div class="si-detail">${formatTxnAmount(tx.amount, tx.asset_code || "NGN")}</div>
          </div>
        `).join("")}` : ""}
      `;
      return;
    }

    if (State.adminTab === "ledger") {
      panel.innerHTML = (summary.recent_ledger_entries || []).map((entry) => `
        <div class="settlement-item">
          <div class="si-title">${escapeHtml(entry.entry_role)} · ${escapeHtml(entry.direction)} ${formatTxnAmount(entry.amount, entry.asset_code)}</div>
          <div class="si-detail">${escapeHtml(entry.account_type)} · ${escapeHtml(entry.memo || "")}</div>
        </div>
      `).join("") || '<p class="admin-empty">No ledger entries yet</p>';
      return;
    }

    if (State.adminTab === "tokens") {
      panel.innerHTML = `
        <div class="admin-token-form">
          <input id="admin-token-symbol" placeholder="Symbol e.g. USDCX" />
          <input id="admin-token-name" placeholder="Name" />
          <input id="admin-token-network" placeholder="Network" value="Arc Testnet" />
          <input id="admin-token-chain" placeholder="Chain ID" type="number" value="5042002" />
          <input id="admin-token-decimals" placeholder="Decimals" type="number" />
          <input id="admin-token-amount" placeholder="Faucet amount" type="number" step="0.000001" />
          <input id="admin-token-address" placeholder="Contract address" />
          <input id="admin-token-explorer" placeholder="Explorer base URL optional" />
          <button class="admin-btn green" onclick="App.saveSupportedToken()">Save Token</button>
        </div>
        ${(summary.supported_tokens || []).map((token) => `
          <div class="settlement-item" onclick="App.fillSupportedToken('${escapeHtml(token.symbol)}','${escapeHtml(token.network)}')">
            <div class="si-title">${escapeHtml(token.symbol)} · ${escapeHtml(token.network)} · ${token.is_active ? "Active" : "Inactive"}</div>
            <div class="si-detail">${escapeHtml(token.contract_address)} · decimals ${token.decimals} · faucet ${token.faucet_amount}</div>
          </div>
        `).join("") || '<p class="admin-empty">No supported tokens</p>'}
      `;
      return;
    }

    if (State.adminTab === "wallets") {
      panel.innerHTML = (summary.platform_wallets || []).map((wallet) => `
        <div class="settlement-item">
          <div class="si-title">${escapeHtml(wallet.wallet_type)} · ${escapeHtml(wallet.network)} · ${wallet.is_active ? "Configured" : "Missing"}</div>
          <div class="si-detail">${escapeHtml(wallet.wallet_address)}</div>
        </div>
      `).join("") || '<p class="admin-empty">No platform wallets configured</p>';
      return;
    }

    if (State.adminTab === "faucet") {
      panel.innerHTML = (summary.faucet_claims || []).map((claim) => `
        <div class="settlement-item">
          <div class="si-title">${escapeHtml(claim.token_symbol)} · ${escapeHtml(claim.network)} · ${escapeHtml(claim.status)}</div>
          <div class="si-detail">${formatTxnAmount(claim.amount, claim.token_symbol)} · ${claim.tx_hash ? txHashHtml(claim.tx_hash) : "no tx hash yet"}</div>
        </div>
      `).join("") || '<p class="admin-empty">No faucet claims yet</p>';
      return;
    }

    if (State.adminTab === "treasury") {
      const tokenOptions = (State.adminData.tokens?.supported_tokens || State.adminSummary?.supported_tokens || summary.treasury_token_balances || [])
        .filter((row) => row.symbol && row.symbol !== "NGN")
        .map((row) => `<option value="${escapeHtml(row.symbol)}">${escapeHtml(row.symbol)}</option>`)
        .join("");
      const balances = (summary.treasury_token_balances || []).map((row) => `
        <div class="settlement-item">
          <div class="si-title">${escapeHtml(row.symbol)} - ${escapeHtml(row.network)}</div>
          <div class="si-detail">${row.balance === null ? escapeHtml(row.error || "Unavailable") : formatTxnAmount(row.balance, row.symbol)} - ${escapeHtml(row.wallet_address || "")}</div>
        </div>
      `).join("") || '<p class="admin-empty">No treasury balances available</p>';
      panel.innerHTML = `
        <div class="settlement-action">
          <div>
            <div class="si-title">Sweep Custodial Wallets</div>
            <div class="si-detail">Treasury tops up gas where needed, then sweeps selected ERC20 balances back to treasury.</div>
          </div>
        </div>
        <div class="admin-token-form">
          <input id="sweep-network" value="Arc Testnet" placeholder="Network" />
          <select id="sweep-symbol">${tokenOptions || '<option value="USDCX">USDCX</option><option value="EURCX">EURCX</option><option value="ETHX">ETHX</option><option value="cirBTCX">cirBTCX</option>'}</select>
          <input id="sweep-limit" type="number" min="1" max="10" value="5" placeholder="Wallet limit" />
          <input id="sweep-gas-topup" value="0.001" placeholder="Native gas top-up" />
          <button class="admin-btn green" id="sweep-wallets-btn" onclick="App.sweepCustodialWallets()">Sweep Wallets</button>
        </div>
        <div id="sweep-results"></div>
        <div class="admin-section-title">Treasury Balances</div>
        ${balances}
      `;
      return;
    }

    if (State.adminTab === "treasury-old") {
      panel.innerHTML = (summary.treasury_token_balances || []).map((row) => `
        <div class="settlement-item">
          <div class="si-title">${escapeHtml(row.symbol)} · ${escapeHtml(row.network)}</div>
          <div class="si-detail">${row.balance === null ? escapeHtml(row.error || "Unavailable") : formatTxnAmount(row.balance, row.symbol)} · ${escapeHtml(row.wallet_address || "")}</div>
        </div>
      `).join("") || '<p class="admin-empty">No treasury balances available</p>';
      return;
    }

    if (State.adminTab === "deposits") {
      panel.innerHTML = (summary.crypto_deposits || []).map((row) => `
        <div class="settlement-item">
          <div class="si-title">${escapeHtml(row.token_symbol)} · ${escapeHtml(row.network)} · ${escapeHtml(row.status)}</div>
          <div class="si-detail">${formatTxnAmount(row.amount, row.token_symbol)} · ${row.tx_hash ? txHashHtml(row.tx_hash) : ""}</div>
        </div>
      `).join("") || '<p class="admin-empty">No crypto deposits yet</p>';
      return;
    }

    if (State.adminTab === "withdrawals") {
      panel.innerHTML = (summary.crypto_withdrawals || []).map((row) => `
        <div class="settlement-item">
          <div class="si-title">${escapeHtml(row.token_symbol)} · ${escapeHtml(row.network)} · ${escapeHtml(row.status)}</div>
          <div class="si-detail">${formatTxnAmount(row.amount, row.token_symbol)} · fee ${formatTxnAmount(Number(row.platform_fee || 0) + Number(row.gas_fee_estimate || 0), row.token_symbol)} · ${row.tx_hash ? txHashHtml(row.tx_hash) : escapeHtml(row.failure_reason || "")}</div>
        </div>
      `).join("") || '<p class="admin-empty">No crypto withdrawals yet</p>';
      return;
    }

    if (State.adminTab === "conversions") {
      panel.innerHTML = (summary.conversions || []).map((row) => `
        <div class="settlement-item">
          <div class="si-title">${escapeHtml(row.from_asset)} to ${escapeHtml(row.to_asset)} - ${escapeHtml(row.status)}</div>
          <div class="si-detail">${formatTxnAmount(row.from_amount, row.from_asset)} -> ${formatTxnAmount(row.to_amount, row.to_asset)} - fee ${formatTxnAmount(row.total_fee_amount, row.from_asset)} - rate ${Number(row.rate_used || 0).toLocaleString("en-NG")}</div>
        </div>
      `).join("") || '<p class="admin-empty">No conversions yet</p>';
      return;
    }

    if (State.adminTab === "rates") {
      const priceRows = (summary.price_data?.prices || []).map((row) => `
        <div class="settlement-item">
          <div class="si-title">${escapeHtml(row.asset_symbol)} - ${row.ngn_mid_price ? fmt(row.ngn_mid_price) : "Price unavailable"}</div>
          <div class="si-detail">USD ${row.usd_price ?? "unavailable"} - Buy ${row.ngn_buy_price ? fmt(row.ngn_buy_price) : "--"} - Sell ${row.ngn_sell_price ? fmt(row.ngn_sell_price) : "--"} - ${escapeHtml(row.source || "")}${row.error ? " - " + escapeHtml(row.error) : ""}</div>
        </div>
      `).join("");
      panel.innerHTML = `
        <div class="settlement-item">
          <div class="si-title">NGN/USD base ${Number(summary.price_data?.base_ngn_usd_rate || 0).toLocaleString("en-NG")} - Spread ${Number(summary.price_data?.spread_ngn || 0).toLocaleString("en-NG")}</div>
          <div class="si-detail">Buy ${Number(summary.price_data?.ngn_buy_rate || 0).toLocaleString("en-NG")} - Sell ${Number(summary.price_data?.ngn_sell_rate || 0).toLocaleString("en-NG")} - ${formatDateTime(summary.price_data?.updated_at)}</div>
        </div>
        ${priceRows || '<p class="admin-empty">No latest prices available</p>'}
        <div class="admin-section-title">Exchange Rates Table</div>
        ${(summary.exchange_rates || []).map((row) => `
        <div class="settlement-item">
          <div class="si-title">${escapeHtml(row.base_asset)} / ${escapeHtml(row.quote_asset)} - ${escapeHtml(row.source)}</div>
          <div class="si-detail">${Number(row.rate || 0).toLocaleString("en-NG")} - ${formatDateTime(row.fetched_at)}</div>
        </div>
      `).join("") || '<p class="admin-empty">No exchange rates yet</p>'}
      `;
    }
  },

  fillSupportedToken(symbol, network) {
    const token = (State.adminData.tokens?.supported_tokens || State.adminSummary?.supported_tokens || []).find((item) => item.symbol === symbol && item.network === network);
    if (!token) return;
    document.getElementById("admin-token-symbol").value = token.symbol || "";
    document.getElementById("admin-token-name").value = token.name || "";
    document.getElementById("admin-token-network").value = token.network || "";
    document.getElementById("admin-token-chain").value = token.chain_id || "";
    document.getElementById("admin-token-decimals").value = token.decimals || "";
    document.getElementById("admin-token-amount").value = token.faucet_amount || "";
    document.getElementById("admin-token-address").value = token.contract_address || "";
    document.getElementById("admin-token-explorer").value = token.explorer_base_url || "";
  },

  async saveSupportedToken() {
    const token = {
      symbol: document.getElementById("admin-token-symbol")?.value.trim(),
      name: document.getElementById("admin-token-name")?.value.trim(),
      network: document.getElementById("admin-token-network")?.value.trim(),
      chain_id: Number(document.getElementById("admin-token-chain")?.value || 0),
      decimals: Number(document.getElementById("admin-token-decimals")?.value || 0),
      faucet_amount: Number(document.getElementById("admin-token-amount")?.value || 0),
      contract_address: document.getElementById("admin-token-address")?.value.trim(),
      explorer_base_url: document.getElementById("admin-token-explorer")?.value.trim() || null,
      is_active: true,
    };
    try {
      await Ledger.callAdmin("save_supported_token", { token });
      App.toast("Token saved");
      await App.renderAdmin();
      App.switchAdminTab("tokens");
    } catch (error) {
      App.toast(error.message || "Token save failed");
    }
  },

  async settleCryptoFees(asset) {
    const amount = Number(State.adminData.fees?.unsettled_fee_amounts?.[asset] || State.adminSummary?.unsettled_fee_amounts?.[asset] || 0);
    if (!amount) return App.toast(`No unsettled ${asset} fees`);
    if (!confirm(`Settle ${formatTxnAmount(amount, asset)} from Treasury Wallet to Fee Wallet?`)) return;

    try {
      App.toast(`Settling ${asset} fees...`);
      const result = await Ledger.callAdmin("settle_crypto_fees", {
        network: "Arc Testnet",
        asset_symbol: asset,
        amount,
      });
      const txHash = result.settlement?.tx_hash || "pending";
      App.toast(`Fee settlement submitted: ${shortHash(txHash)}`);
      await App.renderAdmin();
      App.switchAdminTab("fees");
    } catch (error) {
      App.toast(friendlyError(error, "Fee settlement failed"));
      await App.renderAdmin();
      App.switchAdminTab("fees");
    }
  },

  async sweepCustodialWallets() {
    const symbol = document.getElementById("sweep-symbol")?.value || "USDCX";
    const network = document.getElementById("sweep-network")?.value.trim() || "Arc Testnet";
    const limit = Number(document.getElementById("sweep-limit")?.value || 10);
    const gasTopUp = document.getElementById("sweep-gas-topup")?.value.trim() || "0.001";
    const resultsEl = document.getElementById("sweep-results");
    if (!confirm(`Sweep up to ${limit} custodial wallets for ${symbol} on ${network}?`)) return;
    App.setActionBusy("sweep-wallets-btn", true, "Sweeping...");
    if (resultsEl) resultsEl.innerHTML = '<p class="admin-empty">Sweeping wallets...</p>';
    try {
      const result = await Ledger.callAdmin("sweep_custodial_wallets", {
        network,
        symbol,
        limit,
        gas_top_up: gasTopUp,
      });
      const rows = result.sweep?.results || [];
      if (resultsEl) {
        resultsEl.innerHTML = rows.map((row) => `
          <div class="settlement-item">
            <div class="si-title">${escapeHtml(row.status)} - ${escapeHtml(row.symbol)} - ${formatTxnAmount(row.swept_amount || 0, row.symbol)}</div>
            <div class="si-detail">${txHashHtml(row.wallet_address || "")} - gas ${row.gas_top_up_tx_hash ? txHashHtml(row.gas_top_up_tx_hash) : "none"} - sweep ${row.sweep_tx_hash ? txHashHtml(row.sweep_tx_hash) : escapeHtml(row.reason || "none")}</div>
          </div>
        `).join("") || '<p class="admin-empty">No wallets swept</p>';
      }
      App.toast("Sweep completed");
    } catch (error) {
      const message = friendlyError(error, "Sweep failed");
      if (resultsEl) resultsEl.innerHTML = `<p class="admin-empty">${escapeHtml(message)}</p>`;
      App.toast(message);
    } finally {
      App.setActionBusy("sweep-wallets-btn", false, "Sweep Wallets");
    }
  },

  adminTopUpPool() {
    App.toast("Admin funding is not implemented in Phase 1");
  },

  adminResetAll() {
    App.toast("Admin reset is not implemented in Phase 1");
  },
};

document.addEventListener("DOMContentLoaded", () => {
  App.init();
  [
    ["airtime-amount", "airtime"],
    ["airtime-phone", "airtime"],
    ["data-phone", "data"],
    ["data-plan", "data"],
    ["electricity-amount", "electricity"],
    ["meter-number", "electricity"],
    ["disco-select", "electricity"],
    ["cable-package", "cable"],
    ["cable-provider", "cable"],
    ["cable-card", "cable"],
  ].forEach(([id, type]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", () => App.previewBillPayment(type));
    el.addEventListener("change", () => App.previewBillPayment(type));
  });
  document.querySelectorAll("[data-admin-tab]").forEach((button) => {
    button.onclick = null;
  });

  let adminTaps = 0;
  let adminTapTimer = null;
  document.addEventListener("click", (e) => {
    const adminTabButton = e.target.closest?.("[data-admin-tab]");
    if (adminTabButton) {
      e.preventDefault();
      App.switchAdminTab(adminTabButton.dataset.adminTab);
      return;
    }

    if (e.target.classList.contains("app-version") || e.target.id === "profile-avatar") {
      adminTaps++;
      clearTimeout(adminTapTimer);
      adminTapTimer = setTimeout(() => { adminTaps = 0; }, 2000);
      if (adminTaps >= 5) {
        adminTaps = 0;
        App.openAdmin();
      }
    }
  });
});
