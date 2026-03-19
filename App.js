/**
 * NairaX – app.js  (v3)
 * Real pool mechanics, cross-asset settlements, live price ticker
 */
"use strict";

// ═══════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════
const CONFIG = {
  ETH_RATE_INIT:      3800000,   // ₦ per 1 ETH at startup
  FEE_RATE_BANK:      0.0075,    // 0.75% on crypto→bank sends
  FEE_CRYPTO_NETWORK: 0.00005,   // simulated gas (ETH)
  BONUS_NAIRA:        100000,    // ₦100k signup bonus
  SIMULATE_ETH:       0.026,     // demo deposit amount
  POOL_NAIRA_INIT:    50000000,  // ₦50M starting pool
  POOL_ETH_INIT:      10,        // 10 ETH starting pool
  PRICE_TICK_MS:      30000,     // price update every 30s
  PRICE_VOLATILITY:   0.012,     // ±1.2% max move per tick
  ADMIN_CODE:         '0000',    // secret PIN to open admin
};

// ═══════════════════════════════════════════════════
// DATABASE  (localStorage – persists across sessions)
// ═══════════════════════════════════════════════════
const DB = {
  getUsers:         ()  => JSON.parse(localStorage.getItem('nx_users')       || '{}'),
  saveUsers:        (u) => localStorage.setItem('nx_users', JSON.stringify(u)),
  getCurrentUser:   ()  => localStorage.getItem('nx_current'),
  setCurrentUser:   (p) => localStorage.setItem('nx_current', p),
  clearCurrentUser: ()  => localStorage.removeItem('nx_current'),

  getPool: () => JSON.parse(localStorage.getItem('nx_pool') || JSON.stringify({
    naira:       CONFIG.POOL_NAIRA_INIT,
    eth:         CONFIG.POOL_ETH_INIT,
    settlements: [],
    totalFees:   0,
  })),
  savePool: (p) => localStorage.setItem('nx_pool', JSON.stringify(p)),

  getPrice: () => JSON.parse(localStorage.getItem('nx_price') || JSON.stringify({
    ethRate:    CONFIG.ETH_RATE_INIT,
    openRate:   CONFIG.ETH_RATE_INIT,
    change24h:  0,
    updatedAt:  new Date().toISOString(),
  })),
  savePrice: (p) => localStorage.setItem('nx_price', JSON.stringify(p)),

  getUser:  (phone) => { const u = DB.getUsers(); return u[phone] || null; },
  saveUser: (phone, data) => {
    const u = DB.getUsers(); u[phone] = data; DB.saveUsers(u);
  },
  addTransaction: (phone, txn) => {
    const user = DB.getUser(phone);
    if (!user) return;
    user.transactions = [txn, ...(user.transactions || [])].slice(0, 100);
    DB.saveUser(phone, user);
  },

  // Record a cross-asset settlement into the pool log
  addSettlement: (entry) => {
    const pool = DB.getPool();
    pool.settlements = [entry, ...(pool.settlements || [])].slice(0, 200);
    DB.savePool(pool);
  },
};

// ═══════════════════════════════════════════════════
// WALLET GENERATOR  (deterministic – demo only)
// ═══════════════════════════════════════════════════
function generateWalletFromPhone(phone) {
  let hash = 0;
  for (let i = 0; i < phone.length; i++) {
    hash = ((hash << 5) - hash) + phone.charCodeAt(i);
    hash |= 0;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  return {
    address:    '0x' + hex.repeat(5).substring(0, 40),
    privateKey: '0x' + (Math.abs(hash * 7) + 999).toString(16).padStart(64, '0'),
  };
}

// ═══════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════
const fmt       = (n)      => '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtCrypto = (n, sym) => parseFloat(n).toFixed(6) + ' ' + sym;
const fmtShort  = (n)      => n >= 1e9 ? (n/1e9).toFixed(2)+'B' : n >= 1e6 ? (n/1e6).toFixed(2)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'k' : String(Math.round(n));
const timeAgo   = (iso)    => {
  const m = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return m + 'm ago';
  if (m < 1440) return Math.floor(m/60) + 'h ago'; return Math.floor(m/1440) + 'd ago';
};
const greet = () => { const h = new Date().getHours(); return h<12?'Good morning':h<17?'Good afternoon':'Good evening'; };
const currentRate = () => DB.getPrice().ethRate;

// ═══════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════
const State = {
  currentUser:    null,
  balanceVisible: true,
  sendType:       'bank',
  pinBuffer:      '',
  pinCallback:    null,
  currentNetwork: 'MTN',
  adminMode:      false,
  priceInterval:  null,
};

// ═══════════════════════════════════════════════════
// PRICE ENGINE
// ═══════════════════════════════════════════════════
const PriceEngine = {
  start() {
    PriceEngine.tick(); // immediate tick
    State.priceInterval = setInterval(PriceEngine.tick, CONFIG.PRICE_TICK_MS);
  },

  tick() {
    const p = DB.getPrice();
    // Random walk within volatility band
    const move   = (Math.random() * 2 - 1) * CONFIG.PRICE_VOLATILITY;
    const newRate = Math.round(p.ethRate * (1 + move));
    // Keep rate in realistic range: ₦1.5M – ₦8M
    p.ethRate   = Math.max(1500000, Math.min(8000000, newRate));
    p.change24h = ((p.ethRate - p.openRate) / p.openRate * 100);
    p.updatedAt = new Date().toISOString();
    DB.savePrice(p);

    // Revalue all users' crypto holdings at new rate
    PriceEngine.revalueAllUsers(p.ethRate);
    PriceEngine.updateTicker(p);
    if (State.currentUser) App.renderHome();
  },

  revalueAllUsers(rate) {
    const users = DB.getUsers();
    for (const phone in users) {
      const user = users[phone];
      for (const asset of (user.cryptoAssets || [])) {
        if (asset.symbol === 'ETH') {
          asset.nairaValue = asset.amount * rate;
        }
      }
    }
    DB.saveUsers(users);
  },

  updateTicker(p) {
    const ticker = document.getElementById('price-ticker');
    if (ticker) ticker.classList.remove('hidden');

    const chgEl = document.getElementById('tick-eth-chg');
    const chg   = p.change24h;
    if (chgEl) {
      chgEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
      chgEl.className   = 'tick-chg ' + (chg > 0 ? 'up' : chg < 0 ? 'down' : 'neutral');
    }

    const ethEl = document.getElementById('tick-eth');
    if (ethEl) ethEl.firstChild.textContent = '⟠ sETH  ₦' + fmtShort(p.ethRate) + ' ';

    const pool  = DB.getPool();
    const piEl  = document.getElementById('tick-pool-info');
    if (piEl) piEl.textContent = 'Pool: ₦' + fmtShort(pool.naira) + ' / ' + pool.eth.toFixed(2) + ' ETH';

    const users = DB.getUsers();
    const uEl   = document.getElementById('tick-users');
    if (uEl) uEl.textContent = Object.keys(users).length + ' users';
  },
};

// ═══════════════════════════════════════════════════
// POOL ENGINE  –  all cross-asset settlements
// ═══════════════════════════════════════════════════
const Pool = {
  /**
   * User sends NAIRA → recipient receives ETH
   * Pool gives ETH to recipient, absorbs naira from sender
   */
  nairaToEth(senderPhone, recipientPhone, nairaAmount) {
    const rate    = currentRate();
    const ethAmt  = nairaAmount / rate;
    const pool    = DB.getPool();

    if (pool.eth < ethAmt) throw new Error('Pool ETH reserve too low');

    pool.naira += nairaAmount;   // pool receives naira
    pool.eth   -= ethAmt;        // pool releases ETH

    const entry = {
      id:        Date.now(),
      type:      'naira-to-eth',
      sender:    senderPhone,
      recipient: recipientPhone,
      naira:     nairaAmount,
      eth:       ethAmt,
      rate,
      date:      new Date().toISOString(),
    };
    pool.settlements = [entry, ...(pool.settlements||[])].slice(0,200);
    DB.savePool(pool);
    return { ethAmt, rate };
  },

  /**
   * User sends ETH → recipient receives NAIRA
   * Pool gives naira to recipient, absorbs ETH from sender
   */
  ethToNaira(senderPhone, recipientPhone, ethAmount) {
    const rate       = currentRate();
    const nairaAmt   = ethAmount * rate;
    const pool       = DB.getPool();

    if (pool.naira < nairaAmt) throw new Error('Pool Naira reserve too low');

    pool.eth   += ethAmount;   // pool receives ETH
    pool.naira -= nairaAmt;    // pool pays naira to recipient

    const entry = {
      id:        Date.now(),
      type:      'eth-to-naira',
      sender:    senderPhone,
      recipient: recipientPhone,
      eth:       ethAmount,
      naira:     nairaAmt,
      rate,
      date:      new Date().toISOString(),
    };
    pool.settlements = [entry, ...(pool.settlements||[])].slice(0,200);
    DB.savePool(pool);
    return { nairaAmt, rate };
  },

  /**
   * User sends crypto to bank account (ETH → naira payout)
   * Pool pays naira to bank, absorbs ETH + fee
   */
  cryptoToBankPayout(senderPhone, ethAmount, bankAcct) {
    const rate      = currentRate();
    const nairaAmt  = ethAmount * rate;
    const fee       = nairaAmt * CONFIG.FEE_RATE_BANK;
    const pool      = DB.getPool();

    if (pool.naira < nairaAmt) throw new Error('Pool Naira reserve too low');

    pool.eth   += ethAmount;     // pool absorbs user's ETH
    pool.naira -= nairaAmt;      // pool pays recipient's bank
    pool.naira += fee;           // pool earns the fee back
    pool.totalFees = (pool.totalFees || 0) + fee;

    const entry = {
      id:        Date.now(),
      type:      'eth-to-naira',
      sender:    senderPhone,
      recipient: bankAcct,
      eth:       ethAmount,
      naira:     nairaAmt,
      fee,
      rate,
      date:      new Date().toISOString(),
    };
    pool.settlements = [entry, ...(pool.settlements||[])].slice(0,200);
    DB.savePool(pool);
    return { nairaAmt, fee, rate };
  },
};

// ═══════════════════════════════════════════════════
// APP
// ═══════════════════════════════════════════════════
const App = {

  // ── INIT ──────────────────────────────────────
  init() {
    setTimeout(() => {
      document.getElementById('splash-screen').style.display = 'none';
      PriceEngine.start();
      const phone = DB.getCurrentUser();
      if (phone && DB.getUser(phone)) {
        State.currentUser = phone;
        App.showApp();
      } else {
        document.getElementById('auth-screen').classList.remove('hidden');
      }
    }, 2200);
  },

  // ── AUTH ──────────────────────────────────────
  showSignup() {
    document.getElementById('signup-view').classList.remove('hidden');
    document.getElementById('login-view').classList.add('hidden');
  },
  showLogin() {
    document.getElementById('login-view').classList.remove('hidden');
    document.getElementById('signup-view').classList.add('hidden');
  },

  signup() {
    const name  = document.getElementById('signup-name').value.trim();
    const phone = document.getElementById('signup-phone').value.trim();
    const pin   = document.getElementById('signup-pin').value.trim();

    if (name.length < 2)   return App.toast('Enter your full name');
    if (phone.length < 10) return App.toast('Enter a valid phone number');
    if (pin.length !== 4)  return App.toast('PIN must be exactly 4 digits');
    if (DB.getUser(phone)) return App.toast('Phone already registered');

    const wallet = generateWalletFromPhone(phone);
    DB.saveUser(phone, {
      name, phone, pin, wallet,
      nairaBalance: CONFIG.BONUS_NAIRA,
      cryptoAssets: [],
      transactions: [{
        id: Date.now(), type: 'in',
        title: 'Welcome Bonus 🎉',
        amount: CONFIG.BONUS_NAIRA,
        date: new Date().toISOString(),
        note: 'Test Naira from NairaX'
      }],
      createdAt: new Date().toISOString(),
    });
    DB.setCurrentUser(phone);
    State.currentUser = phone;
    App.toast('Welcome ' + name.split(' ')[0] + '! 🎉');
    setTimeout(() => { document.getElementById('auth-screen').classList.add('hidden'); App.showApp(); }, 800);
  },

  login() {
    const phone = document.getElementById('login-phone').value.trim();
    const pin   = document.getElementById('login-pin').value.trim();
    const user  = DB.getUser(phone);
    if (!user)            return App.toast('Phone number not found');
    if (user.pin !== pin) return App.toast('Incorrect PIN');
    DB.setCurrentUser(phone);
    State.currentUser = phone;
    App.toast('Welcome back, ' + user.name.split(' ')[0] + '!');
    setTimeout(() => { document.getElementById('auth-screen').classList.add('hidden'); App.showApp(); }, 600);
  },

  logout() {
    DB.clearCurrentUser(); State.currentUser = null;
    document.getElementById('app-screen').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
    App.showLogin(); App.toast('Logged out');
  },

  // ── SHOW APP ──────────────────────────────────
  showApp() {
    document.getElementById('app-screen').classList.remove('hidden');
    document.getElementById('price-ticker').classList.remove('hidden');
    App.renderHome();
    App.switchTab('home-tab');
  },

  // ── RENDER HOME ───────────────────────────────
  renderHome() {
    const user = DB.getUser(State.currentUser);
    if (!user) return;
    const rate        = currentRate();
    const cryptoTotal = user.cryptoAssets.reduce((s, a) => s + (a.symbol === 'ETH' ? a.amount * rate : a.nairaValue), 0);
    const total       = user.nairaBalance + cryptoTotal;

    document.querySelector('.user-greeting p').textContent      = greet() + ',';
    document.getElementById('user-name-display').textContent    = user.name.split(' ')[0];
    document.getElementById('total-balance-display').textContent= State.balanceVisible ? fmt(total) : '₦ ••••••';
    document.getElementById('phone-account-display').textContent= 'Acct: ' + user.phone;
    document.getElementById('profile-avatar').textContent       = user.name[0].toUpperCase();
    document.getElementById('profile-name-display').textContent = user.name;
    document.getElementById('profile-phone-display').textContent= user.phone;
    document.getElementById('wallet-address-display').textContent = user.wallet.address;
    document.getElementById('receive-wallet-display').textContent = user.wallet.address;
    document.getElementById('receive-phone-display').textContent  = user.phone;

    App.renderAssets(user, rate);
    App.renderTransactions(user, 'recent-txns', 5);
  },

  renderAssets(user, rate) {
    rate = rate || currentRate();
    const el     = document.getElementById('assets-list');
    const icons  = { ETH:'⟠', BTC:'₿', USDT:'₮' };
    const colors = { ETH:'#627eea', BTC:'#f7931a', USDT:'#26a17b' };
    const p      = DB.getPrice();
    const chg    = p.change24h;
    const chgTxt = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
    const chgCol = chg > 0 ? 'var(--green)' : chg < 0 ? 'var(--red)' : 'var(--text-muted)';

    let html = `
      <div class="asset-item">
        <div class="asset-icon" style="background:#e8f8f0;color:var(--green);font-size:20px;">₦</div>
        <div class="asset-info"><div class="asset-name">Nigerian Naira</div><div class="asset-detail">Fiat Balance</div></div>
        <div class="asset-value"><div class="asset-naira">${State.balanceVisible ? fmt(user.nairaBalance) : '••••'}</div></div>
      </div>`;

    for (const a of user.cryptoAssets) {
      const val = a.symbol === 'ETH' ? a.amount * rate : a.nairaValue;
      html += `
        <div class="asset-item">
          <div class="asset-icon" style="background:${colors[a.symbol]||'#888'}22;color:${colors[a.symbol]||'#888'};font-size:18px;">${icons[a.symbol]||'◈'}</div>
          <div class="asset-info">
            <div class="asset-name">${a.symbol === 'ETH' ? 'Sepolia ETH' : a.symbol}</div>
            <div class="asset-detail">${fmtCrypto(a.amount, a.symbol)} · <span style="color:${chgCol};font-weight:700;">${chgTxt}</span></div>
          </div>
          <div class="asset-value">
            <div class="asset-naira">${State.balanceVisible ? fmt(val) : '••••'}</div>
            <div class="asset-pct" style="color:${chgCol}">${chgTxt}</div>
          </div>
        </div>`;
    }
    el.innerHTML = html;
  },

  renderTransactions(user, id = 'recent-txns', limit = 5) {
    const el = document.getElementById(id);
    if (!el) return;
    // Always re-fetch from DB to get latest transactions (avoids stale snapshot bugs)
    const fresh = DB.getUser(State.currentUser);
    const src   = (fresh && fresh.transactions) ? fresh.transactions : (user ? user.transactions || [] : []);
    const txns  = src.slice(0, limit === 'all' ? 999 : limit);
    if (!txns.length) {
      el.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:24px;font-size:14px;">No transactions yet</p>';
      return;
    }
    el.innerHTML = txns.map(t => `
      <div class="txn-item">
        <div class="txn-icon ${t.type}"><i class="fas fa-${t.type==='in'?'arrow-down':'arrow-up'}"></i></div>
        <div class="txn-info">
          <div class="txn-title">${t.title}</div>
          <div class="txn-date">${timeAgo(t.date)}${t.note ? ' · ' + t.note : ''}</div>
        </div>
        <div class="txn-amount ${t.type}">${t.type==='in'?'+':'-'}${fmt(t.amount)}</div>
      </div>`).join('');
  },

  // ── TAB SWITCHING ─────────────────────────────
  switchTab(tab) {
    const map    = { 'home-tab':'tab-home','crypto-tab':'tab-crypto','history-tab':'tab-history','profile-tab':'tab-profile' };
    const navMap = { 'home-tab':'nav-home','crypto-tab':'nav-crypto','history-tab':'nav-history','profile-tab':'nav-profile' };
    Object.values(map).forEach(id => { const el=document.getElementById(id); if(el){el.classList.remove('active');el.classList.add('hidden');} });
    Object.values(navMap).forEach(id => document.getElementById(id)?.classList.remove('active'));
    const tabEl = document.getElementById(map[tab]);
    if (tabEl) { tabEl.classList.add('active'); tabEl.classList.remove('hidden'); }
    document.getElementById(navMap[tab])?.classList.add('active');
    const user = DB.getUser(State.currentUser);
    if (tab === 'history-tab') {
      // Always re-fetch fresh user for history tab
      const freshUser = DB.getUser(State.currentUser);
      if (freshUser) App.renderTransactions(freshUser, 'full-txn-list', 'all');
    }
    if (tab === 'home-tab') App.renderHome();
  },

  toggleBalanceVisibility() {
    State.balanceVisible = !State.balanceVisible;
    document.getElementById('eye-icon').className = 'fas fa-'+(State.balanceVisible?'eye':'eye-slash');
    App.renderHome();
  },

  // ── MODALS ────────────────────────────────────
  openModal(id) {
    document.getElementById(id).classList.remove('hidden');
    if (id === 'send-modal') App._populateSendModal();
  },
  closeModal(id) { document.getElementById(id).classList.add('hidden'); },

  _populateSendModal() {
    const user = DB.getUser(State.currentUser);
    const userSel = document.getElementById('user-send-asset');
    userSel.innerHTML = '<option value="naira">Nigerian Naira (₦)</option>';
    for (const a of user.cryptoAssets) {
      userSel.innerHTML += `<option value="${a.symbol}">${a.symbol==='ETH'?'Sepolia ETH':a.symbol} (${fmtCrypto(a.amount,a.symbol)})</option>`;
    }
    const cryptoSel = document.getElementById('crypto-send-asset');
    cryptoSel.innerHTML = !user.cryptoAssets.length
      ? '<option value="">No crypto – deposit first</option>'
      : user.cryptoAssets.map(a => `<option value="${a.symbol}">${a.symbol==='ETH'?'Sepolia ETH':a.symbol}</option>`).join('');
    App.updateCryptoSendBalance();
  },

  // ── SEND TYPE SWITCH ──────────────────────────
  setSendType(type) {
    State.sendType = type;
    ['bank','user','crypto'].forEach(t => document.getElementById('stype-'+t)?.classList.toggle('active', t===type));
    document.getElementById('bank-send-form').classList.toggle('hidden', type!=='bank');
    document.getElementById('user-send-form').classList.toggle('hidden', type!=='user');
    document.getElementById('crypto-send-form').classList.toggle('hidden', type!=='crypto');
    document.getElementById('send-main-btn').textContent = { bank:'Send Money', user:'Send to User', crypto:'Send Crypto' }[type];
    ['account-name-group','user-name-group'].forEach(id => { const el=document.getElementById(id); if(el) el.style.display='none'; });
    ['fee-breakdown','user-fee-breakdown','crypto-fee-breakdown'].forEach(id => { const el=document.getElementById(id); if(el) el.style.display='none'; });
  },

  // ── LOOKUPS ───────────────────────────────────
  _lookupTimer: null,
  lookupAccount() {
    clearTimeout(App._lookupTimer);
    const accNo = document.getElementById('send-account-no').value;
    if (accNo.length === 10) {
      App._lookupTimer = setTimeout(() => {
        const names = ['CHIOMA ADAEZE OKONKWO','EMEKA DANIEL CHUKWU','BLESSING FAVOUR NWOSU','TUNDE ABIODUN ADEYEMI','AMAKA PEACE OKAFOR'];
        document.getElementById('account-name-display').textContent = names[parseInt(accNo.slice(-1)) % names.length];
        document.getElementById('account-name-group').style.display = 'block';
      }, 700);
    } else { document.getElementById('account-name-group').style.display = 'none'; }
    App.calcSendFee();
  },

  lookupNairaXUser() {
    const phone  = document.getElementById('send-user-phone').value;
    const target = DB.getUser(phone);
    if (phone.length >= 10 && target) {
      document.getElementById('send-user-name-display').textContent = target.name.toUpperCase();
      document.getElementById('user-name-group').style.display = 'block';
    } else {
      document.getElementById('user-name-group').style.display = 'none';
      if (phone.length === 11) App.toast('User not found on NairaX');
    }
    App.calcSendFee();
  },

  // ── FEE CALC ──────────────────────────────────
  calcSendFee() {
    const rate = currentRate();
    if (State.sendType === 'bank') {
      const amount = parseFloat(document.getElementById('send-amount').value) || 0;
      if (amount <= 0) { document.getElementById('fee-breakdown').style.display='none'; return; }
      const user = DB.getUser(State.currentUser);
      const fee  = amount > user.nairaBalance ? amount * CONFIG.FEE_RATE_BANK : 0;
      document.getElementById('fee-amount').textContent  = fmt(amount);
      document.getElementById('fee-charge').textContent  = fee > 0 ? fmt(fee) : 'Free ✅';
      document.getElementById('fee-total').textContent   = fmt(amount+fee);
      document.getElementById('fee-source').textContent  = fee > 0 ? 'Crypto → Naira (Pool)' : 'Naira Balance';
      document.getElementById('fee-breakdown').style.display = 'block';
    }
    if (State.sendType === 'user') {
      const asset   = document.getElementById('user-send-asset').value;
      const isNaira = asset === 'naira';
      document.getElementById('user-naira-amount-group').classList.toggle('hidden', !isNaira);
      document.getElementById('user-crypto-amount-group').classList.toggle('hidden', isNaira);
      let disp = '₦0';
      if (isNaira) {
        const amt = parseFloat(document.getElementById('send-user-amount').value) || 0;
        document.getElementById('user-fee-amount').textContent = fmt(amt); disp = fmt(amt);
      } else {
        const eth = parseFloat(document.getElementById('send-user-crypto-amount').value) || 0;
        document.getElementById('crypto-naira-equiv').textContent = eth>0 ? '≈ '+fmt(eth*rate) : '';
        document.getElementById('user-fee-amount').textContent = fmtCrypto(eth, asset); disp = fmtCrypto(eth, asset);
      }
      document.getElementById('user-fee-charge').textContent = 'Free ✅';
      document.getElementById('user-fee-total').textContent  = disp;
      document.getElementById('user-fee-breakdown').style.display = 'block';
    }
  },

  // ── CRYPTO SEND HELPERS ───────────────────────
  updateCryptoSendBalance() {
    const user  = DB.getUser(State.currentUser);
    const sym   = document.getElementById('crypto-send-asset')?.value;
    const asset = user?.cryptoAssets.find(a => a.symbol===sym);
    const el    = document.getElementById('crypto-send-balance');
    const rate  = currentRate();
    if (el) el.textContent = asset ? `Available: ${fmtCrypto(asset.amount,sym)} ≈ ${fmt(asset.amount*rate)}` : 'No balance';
  },

  validateCryptoAddress() {
    const addr   = document.getElementById('crypto-send-address').value.trim();
    const status = document.getElementById('crypto-address-status');
    if (!addr) { status.textContent=''; return; }
    const users = DB.getUsers();
    const match = Object.values(users).find(u => u.wallet.address.toLowerCase()===addr.toLowerCase());
    if (match) { status.textContent='✅ NairaX User: '+match.name; status.style.color='var(--green)'; }
    else if (addr.startsWith('0x') && addr.length===42) { status.textContent='✅ Valid EVM address'; status.style.color='var(--blue)'; }
    else { status.textContent='❌ Invalid address'; status.style.color='var(--red)'; }
    App.calcCryptoSendFee();
  },

  calcCryptoSendFee() {
    const ethAmt = parseFloat(document.getElementById('crypto-send-amount').value)||0;
    const sym    = document.getElementById('crypto-send-asset')?.value||'ETH';
    if (ethAmt<=0) { document.getElementById('crypto-fee-breakdown').style.display='none'; return; }
    const nairaVal = ethAmt * currentRate();
    document.getElementById('crypto-send-naira-val').textContent = '≈ '+fmt(nairaVal);
    document.getElementById('csend-amount').textContent = fmtCrypto(ethAmt,sym);
    document.getElementById('csend-fee').textContent    = fmtCrypto(CONFIG.FEE_CRYPTO_NETWORK,sym)+' (gas)';
    document.getElementById('csend-total').textContent  = fmtCrypto(ethAmt+CONFIG.FEE_CRYPTO_NETWORK,sym);
    document.getElementById('csend-naira').textContent  = fmt(nairaVal);
    document.getElementById('crypto-fee-breakdown').style.display = 'block';
  },

  // ── EXECUTE SEND ─────────────────────────────
  executeSend() {
    if (State.sendType==='bank')   return App._sendToBank();
    if (State.sendType==='user')   return App._sendToNairaXUser();
    if (State.sendType==='crypto') return App._sendCryptoToWallet();
  },

  // ── SEND → BANK ACCOUNT ───────────────────────
  // Naira: direct deduct. Crypto: pool settles (ETH absorbed, naira paid out)
  _sendToBank() {
    const amount = parseFloat(document.getElementById('send-amount').value)||0;
    const acctNo = document.getElementById('send-account-no').value;
    const narr   = document.getElementById('send-narration').value || 'Bank Transfer';
    if (amount<=0)          return App.toast('Enter a valid amount');
    if (acctNo.length!==10) return App.toast('Enter a valid 10-digit account number');

    const user        = DB.getUser(State.currentUser);
    const rate        = currentRate();
    const cryptoNaira = user.cryptoAssets.reduce((s,a) => s+(a.symbol==='ETH'?a.amount*rate:a.nairaValue), 0);
    if (user.nairaBalance + cryptoNaira < amount) return App.toast('Insufficient balance');

    App.requirePin(() => {
      let fee = 0;
      if (user.nairaBalance >= amount) {
        // Pure naira send – no fee, no pool involved
        user.nairaBalance -= amount;
      } else {
        // Need crypto → naira conversion via pool
        const nairaShortfall = amount - user.nairaBalance;
        const ethNeeded      = nairaShortfall / rate;
        const myEth          = user.cryptoAssets.find(a=>a.symbol==='ETH');
        if (!myEth || myEth.amount < ethNeeded) return App.toast('Insufficient ETH balance');

        fee = amount * CONFIG.FEE_RATE_BANK;
        try {
          Pool.cryptoToBankPayout(State.currentUser, ethNeeded, acctNo);
        } catch(e) { return App.toast('Pool error: '+e.message); }

        // Deduct ETH from user
        myEth.amount     -= ethNeeded;
        myEth.nairaValue  = myEth.amount * rate;
        if (myEth.amount < 0.000001) user.cryptoAssets = user.cryptoAssets.filter(a=>a.symbol!=='ETH');
        user.nairaBalance = 0; // any leftover naira was already used
      }

      // Save balance changes first, then add transaction on top
      DB.saveUser(State.currentUser, user);
      DB.addTransaction(State.currentUser, {
        id: Date.now(), type: 'out',
        title: 'Bank Transfer · '+acctNo,
        amount: amount+fee,
        date: new Date().toISOString(),
        note: narr + (fee>0 ? ` (fee: ${fmt(fee)}, settled via pool)` : '')
      });
      App.closeModal('send-modal'); App.renderHome();
      App.showSuccess('Transfer Successful! 🏦',
        `${fmt(amount)} sent to account ${acctNo}\nFee: ${fmt(fee)}\nTotal: ${fmt(amount+fee)}`);
    });
  },

  // ── SEND → NAIRAX USER (naira or crypto, same or cross-asset) ──
  _sendToNairaXUser() {
    const toPhone = document.getElementById('send-user-phone').value.trim();
    const asset   = document.getElementById('user-send-asset').value;
    const narr    = document.getElementById('send-user-narration').value || 'Transfer';
    const toUser  = DB.getUser(toPhone);
    if (!toUser)                       return App.toast('NairaX user not found');
    if (toPhone===State.currentUser)   return App.toast("Can't send to yourself");
    const user = DB.getUser(State.currentUser);
    const rate = currentRate();

    if (asset === 'naira') {
      // ── Naira → Naira (no pool) ─────────────────
      const amount = parseFloat(document.getElementById('send-user-amount').value)||0;
      if (amount<=0)                 return App.toast('Enter a valid amount');
      if (user.nairaBalance<amount)  return App.toast('Insufficient Naira balance');

      App.requirePin(() => {
        toUser.nairaBalance += amount;
        DB.saveUser(toPhone, toUser);
        DB.addTransaction(toPhone, { id:Date.now(), type:'in', title:'Received from '+user.name.split(' ')[0], amount, date:new Date().toISOString(), note:narr });
        user.nairaBalance -= amount;
        DB.saveUser(State.currentUser, user);
        DB.addTransaction(State.currentUser, { id:Date.now()+1, type:'out', title:'Sent to '+toUser.name, amount, date:new Date().toISOString(), note:narr });
        App.closeModal('send-modal'); App.renderHome();
        App.showSuccess('Sent! 💸', `${fmt(amount)} sent to ${toUser.name}\nFree ✅`);
      });

    } else {
      // ── Crypto → Crypto (direct, no pool) ──────
      const ethAmt  = parseFloat(document.getElementById('send-user-crypto-amount').value)||0;
      if (ethAmt<=0) return App.toast('Enter a valid amount');
      const myAsset = user.cryptoAssets.find(a=>a.symbol===asset);
      if (!myAsset||myAsset.amount<ethAmt) return App.toast('Insufficient '+asset);
      const nairaVal = ethAmt * rate;

      App.requirePin(() => {
        myAsset.amount     -= ethAmt;
        myAsset.nairaValue  = myAsset.amount * rate;
        if (myAsset.amount<0.000001) user.cryptoAssets=user.cryptoAssets.filter(a=>a.symbol!==asset);

        let toA = toUser.cryptoAssets.find(a=>a.symbol===asset);
        if (toA) { toA.amount+=ethAmt; toA.nairaValue=toA.amount*rate; }
        else toUser.cryptoAssets.push({ symbol:asset, amount:ethAmt, nairaValue:nairaVal });

        DB.saveUser(toPhone, toUser);
        DB.addTransaction(toPhone, { id:Date.now(), type:'in', title:`${asset} from `+user.name.split(' ')[0], amount:nairaVal, date:new Date().toISOString(), note:fmtCrypto(ethAmt,asset)+' · '+narr });
        DB.saveUser(State.currentUser, user);
        DB.addTransaction(State.currentUser, { id:Date.now()+1, type:'out', title:`${asset} to `+toUser.name, amount:nairaVal, date:new Date().toISOString(), note:fmtCrypto(ethAmt,asset)+' · '+narr });
        App.closeModal('send-modal'); App.renderHome();
        App.showSuccess(`${asset} Sent! ⟠`, `${fmtCrypto(ethAmt,asset)} → ${toUser.name}\n≈${fmt(nairaVal)}\nFree ✅`);
      });
    }
  },

  // ── SEND CRYPTO → EXTERNAL EVM WALLET ────────
  _sendCryptoToWallet() {
    const sym    = document.getElementById('crypto-send-asset').value;
    const addr   = document.getElementById('crypto-send-address').value.trim();
    const ethAmt = parseFloat(document.getElementById('crypto-send-amount').value)||0;
    const narr   = document.getElementById('crypto-send-narration').value || 'Crypto Send';
    if (!sym)                                          return App.toast('No crypto to send');
    if (ethAmt<=0)                                     return App.toast('Enter a valid amount');
    if (!addr.startsWith('0x')||addr.length!==42)      return App.toast('Enter a valid 0x address');

    const user        = DB.getUser(State.currentUser);
    const rate        = currentRate();
    const myAsset     = user.cryptoAssets.find(a=>a.symbol===sym);
    const totalNeeded = ethAmt + CONFIG.FEE_CRYPTO_NETWORK;
    if (!myAsset||myAsset.amount<totalNeeded) return App.toast(`Need ${fmtCrypto(totalNeeded,sym)}`);

    const nairaVal = ethAmt * rate;
    App.requirePin(() => {
      myAsset.amount     -= totalNeeded;
      myAsset.nairaValue  = myAsset.amount * rate;
      if (myAsset.amount<0.000001) user.cryptoAssets=user.cryptoAssets.filter(a=>a.symbol!==sym);

      // Pool absorbs the gas fee ETH
      const pool = DB.getPool();
      pool.eth += CONFIG.FEE_CRYPTO_NETWORK;
      DB.savePool(pool);

      // If recipient is another NairaX user, credit them
      const users  = DB.getUsers();
      const toUser = Object.values(users).find(u=>u.wallet.address.toLowerCase()===addr.toLowerCase()&&u.phone!==State.currentUser);
      if (toUser) {
        let toA = toUser.cryptoAssets.find(a=>a.symbol===sym);
        if (toA) { toA.amount+=ethAmt; toA.nairaValue=toA.amount*rate; }
        else toUser.cryptoAssets.push({ symbol:sym, amount:ethAmt, nairaValue:nairaVal });
        DB.saveUser(toUser.phone, toUser);
        DB.addTransaction(toUser.phone, { id:Date.now(), type:'in', title:`${sym} received (wallet)`, amount:nairaVal, date:new Date().toISOString(), note:fmtCrypto(ethAmt,sym) });
      }

      DB.saveUser(State.currentUser, user);
      DB.addTransaction(State.currentUser, { id:Date.now()+1, type:'out', title:`${sym} → Wallet`, amount:nairaVal, date:new Date().toISOString(), note:fmtCrypto(ethAmt,sym)+' → '+addr.slice(0,10)+'...' });
      App.closeModal('send-modal'); App.renderHome();
      App.showSuccess(`${sym} Sent! ⟠`, `${fmtCrypto(ethAmt,sym)}\n→ ${addr.slice(0,18)}...\n≈${fmt(nairaVal)}`);
    });
  },

  // ── DEDUCT NAIRA+CRYPTO (naira first) ─────────
  _deductBalance(user, totalNeeded) {
    const rate = currentRate();
    if (user.nairaBalance >= totalNeeded) { user.nairaBalance -= totalNeeded; return; }
    let remaining   = totalNeeded - user.nairaBalance;
    user.nairaBalance = 0;
    for (const asset of user.cryptoAssets) {
      if (remaining<=0) break;
      const deductNaira = Math.min(asset.symbol==='ETH'?asset.amount*rate:asset.nairaValue, remaining);
      const ethDed      = deductNaira / rate;
      asset.amount     -= ethDed;
      asset.nairaValue  = asset.amount * rate;
      remaining        -= deductNaira;
      const pool = DB.getPool(); pool.eth+=ethDed; DB.savePool(pool);
    }
    user.cryptoAssets = user.cryptoAssets.filter(a=>a.amount>0.000001);
  },

  // ── RECEIVE ───────────────────────────────────
  setReceiveTab(tab) {
    document.querySelectorAll('.rtab').forEach(b=>b.classList.remove('active'));
    event.target.classList.add('active');
    document.getElementById('receive-naira').classList.toggle('hidden', tab!=='naira');
    document.getElementById('receive-crypto').classList.toggle('hidden', tab!=='crypto');
  },
  copyPhone() { const u=DB.getUser(State.currentUser); navigator.clipboard?.writeText(u.phone).catch(()=>{}); App.toast('Account number copied! ✅'); },
  copyWalletAddress() { const u=DB.getUser(State.currentUser); navigator.clipboard?.writeText(u.wallet.address).catch(()=>{}); App.toast('Wallet address copied! ✅'); },

  // ── CRYPTO DEPOSIT SIMULATION ─────────────────
  simulateCryptoDeposit() {
    const user     = DB.getUser(State.currentUser);
    const rate     = currentRate();
    const ethAmt   = CONFIG.SIMULATE_ETH;
    const nairaVal = ethAmt * rate;

    // Pool releases naira equivalent, absorbs nothing here (this is a real inbound deposit)
    let ethAsset = user.cryptoAssets.find(a=>a.symbol==='ETH');
    if (ethAsset) { ethAsset.amount+=ethAmt; ethAsset.nairaValue=ethAsset.amount*rate; }
    else user.cryptoAssets.push({ symbol:'ETH', amount:ethAmt, nairaValue:nairaVal });

    DB.saveUser(State.currentUser, user);
    DB.addTransaction(State.currentUser, { id:Date.now(), type:'in', title:'Crypto Deposit – Sepolia ETH', amount:nairaVal, date:new Date().toISOString(), note:fmtCrypto(ethAmt,'ETH') });
    App.renderHome();
    App.showSuccess('Crypto Received! ⟠', `${fmtCrypto(ethAmt,'sETH')} deposited\nNaira value: ${fmt(nairaVal)}\nRate: ₦${fmtShort(rate)}/ETH`);
  },

  // ── ADD MONEY ─────────────────────────────────
  addTestNaira() {
    const user = DB.getUser(State.currentUser);
    user.nairaBalance += CONFIG.BONUS_NAIRA;
    DB.saveUser(State.currentUser, user);
    DB.addTransaction(State.currentUser, { id:Date.now(), type:'in', title:'Test Naira Added', amount:CONFIG.BONUS_NAIRA, date:new Date().toISOString(), note:'From NairaX Test Pool' });
    DB.saveUser(State.currentUser, user);
    App.closeModal('add-money-modal'); App.renderHome();
    App.showSuccess('Money Added! 💰', `${fmt(CONFIG.BONUS_NAIRA)} test Naira added.`);
  },

  // ── BILLS ─────────────────────────────────────
  selectNetwork(el, net) { el.closest('.network-grid').querySelectorAll('.net-item').forEach(i=>i.classList.remove('active-net')); el.classList.add('active-net'); State.currentNetwork=net; },
  buyAirtime() {
    const phone=document.getElementById('airtime-phone').value, amt=parseFloat(document.getElementById('airtime-amount').value)||0;
    if(!phone||phone.length<10) return App.toast('Enter phone number'); if(amt<50) return App.toast('Min ₦50');
    App._billPayment('airtime-modal', amt, `${State.currentNetwork} Airtime – ${phone}`, 'Airtime');
  },
  buyData() {
    const phone=document.getElementById('data-phone').value, amt=parseFloat(document.getElementById('data-plan').value)||0;
    if(!phone||phone.length<10) return App.toast('Enter phone number');
    App._billPayment('data-modal', amt, `${State.currentNetwork} Data – ${phone}`, 'Data Bundle');
  },
  payElectricity() {
    const meter=document.getElementById('meter-number').value, amt=parseFloat(document.getElementById('electricity-amount').value)||0;
    if(!meter) return App.toast('Enter meter number'); if(amt<1000) return App.toast('Min ₦1,000');
    App._billPayment('electricity-modal', amt, document.getElementById('disco-select').value, 'Electricity');
  },
  payCable() {
    const card=document.getElementById('cable-card').value, amt=parseFloat(document.getElementById('cable-package').value)||0;
    if(!card) return App.toast('Enter card number');
    App._billPayment('cable-modal', amt, document.getElementById('cable-provider').value+' Subscription', 'Cable TV');
  },
  _billPayment(modalId, amount, title, note) {
    const user  = DB.getUser(State.currentUser);
    const rate  = currentRate();
    const total = user.nairaBalance + user.cryptoAssets.reduce((s,a)=>s+(a.symbol==='ETH'?a.amount*rate:a.nairaValue),0);
    if (total<amount) return App.toast('Insufficient balance');
    App.requirePin(() => {
      App._deductBalance(user, amount);
      DB.saveUser(State.currentUser, user);
      DB.addTransaction(State.currentUser, { id:Date.now(), type:'out', title, amount, date:new Date().toISOString(), note });
      App.closeModal(modalId); App.renderHome();
      App.showSuccess('Payment Successful! ✅', `${fmt(amount)} paid for ${note}.`);
    });
  },

  // ── PIN ───────────────────────────────────────
  requirePin(callback) { State.pinBuffer=''; State.pinCallback=callback; App.updatePinDots(); App.openModal('pin-modal'); },
  pinInput(val) {
    if (val==='clr') { State.pinBuffer=State.pinBuffer.slice(0,-1); }
    else if (val==='ok') {
      const user = DB.getUser(State.currentUser);
      if (State.pinBuffer===user.pin) {
        App.closeModal('pin-modal'); State.pinBuffer=''; App.updatePinDots();
        if (State.pinCallback) State.pinCallback();
      } else { State.pinBuffer=''; App.updatePinDots(); App.toast('Incorrect PIN ❌'); }
      return;
    } else if (State.pinBuffer.length<4) { State.pinBuffer+=val; }
    App.updatePinDots();
    if (State.pinBuffer.length===4) setTimeout(()=>App.pinInput('ok'),200);
  },
  updatePinDots() { document.querySelectorAll('#pin-dots span').forEach((d,i)=>d.classList.toggle('filled',i<State.pinBuffer.length)); },

  // ── SUCCESS / TOAST ───────────────────────────
  showSuccess(title,msg) { document.getElementById('success-title').textContent=title; document.getElementById('success-message').textContent=msg; document.getElementById('success-overlay').classList.remove('hidden'); },
  closeSuccess() { document.getElementById('success-overlay').classList.add('hidden'); },
  _toastTimer: null,
  toast(msg) { const t=document.getElementById('toast'); t.textContent=msg; t.classList.remove('hidden'); clearTimeout(App._toastTimer); App._toastTimer=setTimeout(()=>t.classList.add('hidden'),3000); },
  showNotifications() { App.toast('No new notifications'); },

  // ═══════════════════════════════════════════════
  // ADMIN PANEL
  // ═══════════════════════════════════════════════
  openAdmin() {
    // Require admin PIN
    State.pinBuffer='';
    State.pinCallback = () => {
      // check against admin code
      App.renderAdmin();
      document.getElementById('admin-screen').classList.remove('hidden');
      document.getElementById('app-screen').classList.add('hidden');
      document.getElementById('price-ticker').classList.add('hidden');
    };
    // Temporarily change user pin check to admin code
    State._adminPinOverride = true;
    App.updatePinDots();
    App.openModal('pin-modal');
  },

  // Override pinInput for admin access
  _adminPinOverride: false,

  closeAdmin() {
    document.getElementById('admin-screen').classList.add('hidden');
    document.getElementById('app-screen').classList.remove('hidden');
    document.getElementById('price-ticker').classList.remove('hidden');
  },

  renderAdmin() {
    const pool  = DB.getPool();
    const price = DB.getPrice();
    const users = DB.getUsers();
    const rate  = price.ethRate;

    // Stats
    const poolEthNaira = pool.eth * rate;
    const poolTotal    = pool.naira + poolEthNaira;
    document.getElementById('admin-pool-naira').textContent    = fmt(pool.naira);
    document.getElementById('admin-pool-eth').textContent      = pool.eth.toFixed(4) + ' ETH';
    document.getElementById('admin-pool-eth-naira').textContent= '≈ ' + fmt(poolEthNaira);
    document.getElementById('admin-pool-total').textContent    = fmt(poolTotal);

    const userList   = Object.values(users);
    const totalFunds = userList.reduce((s,u) => {
      const cr = u.cryptoAssets.reduce((a,b)=>a+(b.symbol==='ETH'?b.amount*rate:b.nairaValue),0);
      return s + u.nairaBalance + cr;
    }, 0);
    document.getElementById('admin-user-count').textContent    = userList.length;
    document.getElementById('admin-user-balances').textContent = 'Total user funds: '+fmt(totalFunds);

    // Price
    const chg = price.change24h;
    document.getElementById('admin-eth-rate').textContent   = fmt(rate);
    const chgEl = document.getElementById('admin-eth-change');
    chgEl.textContent = (chg>=0?'+':'')+chg.toFixed(2)+'%';
    chgEl.style.color = chg>0?'#00e676':chg<0?'#ff5252':'white';
    document.getElementById('admin-last-update').textContent = timeAgo(price.updatedAt);
    document.getElementById('admin-settlement-count').textContent = (pool.settlements||[]).length;

    // Settlements log
    const logEl = document.getElementById('admin-settlement-log');
    if (!pool.settlements||!pool.settlements.length) {
      logEl.innerHTML = '<p class="admin-empty">No settlements yet</p>';
    } else {
      logEl.innerHTML = pool.settlements.map(s => {
        const typeLabel = s.type==='naira-to-eth' ? 'NAIRA→ETH' : 'ETH→NAIRA';
        const badgeCls  = s.type==='naira-to-eth' ? 'naira-to-eth' : 'eth-to-naira';
        const detail    = s.type==='eth-to-naira'
          ? `${fmtCrypto(s.eth,'ETH')} in → ${fmt(s.naira)} out${s.fee?` (fee: ${fmt(s.fee)})`:''}  @₦${fmtShort(s.rate)}`
          : `${fmt(s.naira)} in → ${fmtCrypto(s.eth,'ETH')} out  @₦${fmtShort(s.rate)}`;
        return `
          <div class="settlement-item">
            <div class="si-title">${s.sender||'?'} → ${s.recipient||'?'} <span class="si-badge ${badgeCls}">${typeLabel}</span></div>
            <div class="si-detail">${detail} · ${timeAgo(s.date)}</div>
          </div>`;
      }).join('');
    }

    // Users list
    const usersEl = document.getElementById('admin-users-list');
    if (!userList.length) { usersEl.innerHTML='<p class="admin-empty">No users yet</p>'; }
    else {
      usersEl.innerHTML = userList.map(u => {
        const cr = u.cryptoAssets.reduce((a,b)=>a+(b.symbol==='ETH'?b.amount*rate:b.nairaValue),0);
        const total = u.nairaBalance + cr;
        const cryptoStr = u.cryptoAssets.map(a=>fmtCrypto(a.amount,a.symbol)).join(', ') || 'No crypto';
        return `
          <div class="admin-user-item">
            <div class="aui-avatar">${u.name[0].toUpperCase()}</div>
            <div class="aui-info"><div class="aui-name">${u.name}</div><div class="aui-phone">${u.phone}</div></div>
            <div class="aui-bal"><div class="aui-naira">${fmt(total)}</div><div class="aui-crypto">${cryptoStr}</div></div>
          </div>`;
      }).join('');
    }
  },

  adminTopUpPool(type) {
    const pool = DB.getPool();
    if (type==='naira') { pool.naira+=10000000; App.toast('Added ₦10M to pool ✅'); }
    else { pool.eth+=5; App.toast('Added 5 ETH to pool ✅'); }
    DB.savePool(pool);
    App.renderAdmin();
  },

  adminResetAll() {
    if (!confirm('⚠ This will delete ALL users and pool data. Are you sure?')) return;
    localStorage.clear();
    App.toast('All data reset. Reloading...');
    setTimeout(()=>location.reload(), 1200);
  },
};

// ═══════════════════════════════════════════════════
// Admin PIN override: tap profile pic 5× to open admin
// ═══════════════════════════════════════════════════
let _adminTaps = 0, _adminTapTimer = null;
document.addEventListener('DOMContentLoaded', () => {
  App.init();

  // Secret: tap version text 5× to open admin
  document.addEventListener('click', e => {
    if (e.target.classList.contains('app-version') || e.target.id==='profile-avatar') {
      _adminTaps++;
      clearTimeout(_adminTapTimer);
      _adminTapTimer = setTimeout(()=>{ _adminTaps=0; }, 2000);
      if (_adminTaps>=5) { _adminTaps=0; App.openAdmin(); }
    }
  });
});

// Patch pinInput to handle admin override
const _origPinInput = App.pinInput.bind(App);
App.pinInput = function(val) {
  if (State._adminPinOverride) {
    if (val==='clr') { State.pinBuffer=State.pinBuffer.slice(0,-1); }
    else if (val==='ok') {
      if (State.pinBuffer===CONFIG.ADMIN_CODE) {
        State._adminPinOverride=false;
        App.closeModal('pin-modal');
        State.pinBuffer=''; App.updatePinDots();
        if (State.pinCallback) State.pinCallback();
      } else {
        State.pinBuffer=''; App.updatePinDots(); App.toast('Wrong admin code');
        State._adminPinOverride=false;
      }
      return;
    } else if (State.pinBuffer.length<4) { State.pinBuffer+=val; }
    App.updatePinDots();
    if (State.pinBuffer.length===4) setTimeout(()=>App.pinInput('ok'),200);
    return;
  }
  _origPinInput(val);
};