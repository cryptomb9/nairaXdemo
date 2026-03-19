/**
 * NairaX – app.js
 * Demo fintech wallet: Crypto + Naira, OPay-style
 * Uses localStorage for persistent cross-device simulation
 */

"use strict";

// ────────────────────────────────────────
// CONSTANTS & CONFIG
// ────────────────────────────────────────

const CONFIG = {
  TESTNET_ETH_RATE: 3800000,     // 1 ETH = ₦3,800,000 (simulated)
  FEE_RATE: 0.0075,              // 0.75% fee on crypto-to-bank sends
  BONUS_NAIRA: 100000,           // ₦100,000 test bonus
  SIMULATE_ETH_DEPOSIT: 0.026,   // ~₦100k of ETH
  POOL_NAIRA: 50000000,          // ₦50M pool (test)
  POOL_ETH: 10,                  // 10 ETH pool (test)
};

// ────────────────────────────────────────
// DATABASE (localStorage)
// ────────────────────────────────────────

const DB = {
  getUsers: () => JSON.parse(localStorage.getItem('nx_users') || '{}'),
  saveUsers: (u) => localStorage.setItem('nx_users', JSON.stringify(u)),
  getPool: () => JSON.parse(localStorage.getItem('nx_pool') || JSON.stringify({ naira: CONFIG.POOL_NAIRA, eth: CONFIG.POOL_ETH })),
  savePool: (p) => localStorage.setItem('nx_pool', JSON.stringify(p)),
  getCurrentUser: () => localStorage.getItem('nx_current'),
  setCurrentUser: (phone) => localStorage.setItem('nx_current', phone),
  clearCurrentUser: () => localStorage.removeItem('nx_current'),

  getUser: (phone) => {
    const users = DB.getUsers();
    return users[phone] || null;
  },

  saveUser: (phone, data) => {
    const users = DB.getUsers();
    users[phone] = data;
    DB.saveUsers(users);
  },

  addTransaction: (phone, txn) => {
    const user = DB.getUser(phone);
    if (!user) return;
    user.transactions = [txn, ...(user.transactions || [])].slice(0, 100);
    DB.saveUser(phone, user);
  }
};

// ────────────────────────────────────────
// EVM WALLET GENERATOR (deterministic demo)
// ────────────────────────────────────────

function generateWalletFromPhone(phone) {
  // Deterministic fake EVM address from phone
  let hash = 0;
  for (let i = 0; i < phone.length; i++) {
    hash = ((hash << 5) - hash) + phone.charCodeAt(i);
    hash |= 0;
  }
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  const addr = '0x' + hex.repeat(5).substring(0, 40);
  // Private key: NOT real, just for demo display
  const pk = '0x' + (Math.abs(hash * 7) + 999).toString(16).padStart(8, '0').repeat(8).substring(0, 64);
  return { address: addr, privateKey: pk };
}

// ────────────────────────────────────────
// APP STATE
// ────────────────────────────────────────

const State = {
  currentUser: null,
  balanceVisible: true,
  sendType: 'bank',
  receiveTab: 'naira',
  pinBuffer: '',
  pinCallback: null,
  currentNetwork: 'MTN',
};

// ────────────────────────────────────────
// UTILITY HELPERS
// ────────────────────────────────────────

function fmt(amount) {
  return '₦' + Number(amount).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtCrypto(amount, symbol) {
  return parseFloat(amount).toFixed(6) + ' ' + symbol;
}

function timeAgo(isoStr) {
  const diff = Date.now() - new Date(isoStr).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

function greet() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

// ────────────────────────────────────────
// MAIN APP OBJECT
// ────────────────────────────────────────

const App = {

  // ── INIT ────────────────────────────────
  init() {
    setTimeout(() => {
      document.getElementById('splash-screen').style.display = 'none';
      const phone = DB.getCurrentUser();
      if (phone && DB.getUser(phone)) {
        State.currentUser = phone;
        App.showApp();
      } else {
        document.getElementById('auth-screen').classList.remove('hidden');
      }
    }, 2200);
  },

  // ── AUTH ─────────────────────────────────
  showSignup() {
    document.getElementById('signup-view').classList.remove('hidden');
    document.getElementById('login-view').classList.add('hidden');
  },

  showLogin() {
    document.getElementById('login-view').classList.remove('hidden');
    document.getElementById('signup-view').classList.add('hidden');
  },

  signup() {
    const name = document.getElementById('signup-name').value.trim();
    const phone = document.getElementById('signup-phone').value.trim();
    const pin = document.getElementById('signup-pin').value.trim();

    if (!name || name.length < 2) return App.toast('Please enter your full name');
    if (phone.length < 10) return App.toast('Enter a valid phone number');
    if (pin.length !== 4) return App.toast('PIN must be 4 digits');

    const users = DB.getUsers();
    if (users[phone]) return App.toast('Phone number already registered');

    const wallet = generateWalletFromPhone(phone);

    const userData = {
      name,
      phone,
      pin,
      wallet,
      nairaBalance: CONFIG.BONUS_NAIRA,
      cryptoAssets: [],          // [{symbol, amount, nairaValue}]
      transactions: [
        {
          id: Date.now(),
          type: 'in',
          title: 'Welcome Bonus 🎉',
          amount: CONFIG.BONUS_NAIRA,
          balance_after: CONFIG.BONUS_NAIRA,
          date: new Date().toISOString(),
          note: 'Test Naira from NairaX'
        }
      ],
      createdAt: new Date().toISOString(),
    };

    DB.saveUser(phone, userData);
    DB.setCurrentUser(phone);
    State.currentUser = phone;

    App.toast('Account created! Welcome, ' + name.split(' ')[0] + ' 🎉');
    setTimeout(() => {
      document.getElementById('auth-screen').classList.add('hidden');
      App.showApp();
    }, 800);
  },

  login() {
    const phone = document.getElementById('login-phone').value.trim();
    const pin = document.getElementById('login-pin').value.trim();

    const user = DB.getUser(phone);
    if (!user) return App.toast('Phone number not found');
    if (user.pin !== pin) return App.toast('Incorrect PIN');

    DB.setCurrentUser(phone);
    State.currentUser = phone;

    App.toast('Welcome back, ' + user.name.split(' ')[0] + '!');
    setTimeout(() => {
      document.getElementById('auth-screen').classList.add('hidden');
      App.showApp();
    }, 600);
  },

  logout() {
    DB.clearCurrentUser();
    State.currentUser = null;
    document.getElementById('app-screen').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
    App.showLogin();
    App.toast('Logged out');
  },

  // ── SHOW APP ──────────────────────────────
  showApp() {
    document.getElementById('app-screen').classList.remove('hidden');
    App.renderHome();
    App.switchTab('home-tab');
  },

  // ── RENDER HOME ───────────────────────────
  renderHome() {
    const user = DB.getUser(State.currentUser);
    if (!user) return;

    // Greeting
    document.querySelector('.user-greeting p').textContent = greet() + ',';
    document.getElementById('user-name-display').textContent = user.name.split(' ')[0];

    // Total balance
    const cryptoTotal = user.cryptoAssets.reduce((s, a) => s + a.nairaValue, 0);
    const total = user.nairaBalance + cryptoTotal;
    document.getElementById('total-balance-display').textContent = State.balanceVisible ? fmt(total) : '₦ ••••••';
    document.getElementById('phone-account-display').textContent = 'Acct: ' + user.phone;

    // Profile
    document.getElementById('profile-avatar').textContent = user.name[0].toUpperCase();
    document.getElementById('profile-name-display').textContent = user.name;
    document.getElementById('profile-phone-display').textContent = user.phone;

    // Wallet
    document.getElementById('wallet-address-display').textContent = user.wallet.address;
    document.getElementById('receive-wallet-display').textContent = user.wallet.address;
    document.getElementById('receive-phone-display').textContent = user.phone;

    App.renderAssets(user);
    App.renderTransactions(user);
  },

  renderAssets(user) {
    const container = document.getElementById('assets-list');
    let html = '';

    // Naira asset
    html += `
      <div class="asset-item">
        <div class="asset-icon" style="background:#e8f8f0;color:var(--green);font-size:20px;">₦</div>
        <div class="asset-info">
          <div class="asset-name">Nigerian Naira</div>
          <div class="asset-detail">Fiat Balance</div>
        </div>
        <div class="asset-value">
          <div class="asset-naira">${State.balanceVisible ? fmt(user.nairaBalance) : '••••'}</div>
        </div>
      </div>`;

    // Crypto assets
    for (const a of user.cryptoAssets) {
      const icons = { ETH: '⟠', BTC: '₿', USDT: '₮' };
      const colors = { ETH: '#627eea', BTC: '#f7931a', USDT: '#26a17b' };
      html += `
        <div class="asset-item">
          <div class="asset-icon" style="background:${colors[a.symbol] || '#888'}22;color:${colors[a.symbol] || '#888'};font-size:18px;">${icons[a.symbol] || '◈'}</div>
          <div class="asset-info">
            <div class="asset-name">${a.symbol === 'ETH' ? 'Sepolia ETH' : a.symbol}</div>
            <div class="asset-detail">${fmtCrypto(a.amount, a.symbol)}</div>
          </div>
          <div class="asset-value">
            <div class="asset-naira">${State.balanceVisible ? fmt(a.nairaValue) : '••••'}</div>
            <div class="asset-pct">Testnet</div>
          </div>
        </div>`;
    }

    container.innerHTML = html;
  },

  renderTransactions(user, container = 'recent-txns', limit = 5) {
    const el = document.getElementById(container);
    const txns = (user.transactions || []).slice(0, limit === 'all' ? 999 : limit);

    if (!txns.length) {
      el.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:24px;font-size:14px;">No transactions yet</p>';
      return;
    }

    el.innerHTML = txns.map(t => `
      <div class="txn-item">
        <div class="txn-icon ${t.type}">
          <i class="fas fa-${t.type === 'in' ? 'arrow-down' : 'arrow-up'}"></i>
        </div>
        <div class="txn-info">
          <div class="txn-title">${t.title}</div>
          <div class="txn-date">${timeAgo(t.date)} ${t.note ? '· ' + t.note : ''}</div>
        </div>
        <div class="txn-amount ${t.type}">${t.type === 'in' ? '+' : '-'}${fmt(t.amount)}</div>
      </div>`).join('');
  },

  // ── TAB SWITCHING ─────────────────────────
  switchTab(tab) {
    const tabs = { 'home-tab': 'tab-home', 'crypto-tab': 'tab-crypto', 'history-tab': 'tab-history', 'profile-tab': 'tab-profile' };
    const navs = { 'home-tab': 'nav-home', 'crypto-tab': 'nav-crypto', 'history-tab': 'nav-history', 'profile-tab': 'nav-profile' };

    Object.values(tabs).forEach(id => {
      document.getElementById(id)?.classList.remove('active');
      document.getElementById(id)?.classList.add('hidden');
    });
    Object.values(navs).forEach(id => document.getElementById(id)?.classList.remove('active'));

    const tabEl = document.getElementById(tabs[tab]);
    if (tabEl) { tabEl.classList.add('active'); tabEl.classList.remove('hidden'); }
    if (navs[tab]) document.getElementById(navs[tab])?.classList.add('active');

    // Refresh content on tab switch
    const user = DB.getUser(State.currentUser);
    if (tab === 'history-tab' && user) App.renderTransactions(user, 'full-txn-list', 'all');
    if (tab === 'home-tab') App.renderHome();
  },

  // ── BALANCE TOGGLE ────────────────────────
  toggleBalanceVisibility() {
    State.balanceVisible = !State.balanceVisible;
    document.getElementById('eye-icon').className = 'fas fa-' + (State.balanceVisible ? 'eye' : 'eye-slash');
    App.renderHome();
  },

  // ── MODALS ────────────────────────────────
  openModal(id) {
    document.getElementById(id).classList.remove('hidden');
  },

  closeModal(id) {
    document.getElementById(id).classList.add('hidden');
  },

  // ── SEND MONEY ────────────────────────────
  setSendType(type) {
    State.sendType = type;
    document.getElementById('stype-bank').classList.toggle('active', type === 'bank');
    document.getElementById('stype-user').classList.toggle('active', type === 'user');
    document.getElementById('bank-send-form').classList.toggle('hidden', type !== 'bank');
    document.getElementById('user-send-form').classList.toggle('hidden', type !== 'user');
    document.getElementById('account-name-group').style.display = 'none';
    document.getElementById('user-name-group').style.display = 'none';
    document.getElementById('fee-breakdown').style.display = 'none';
  },

  _lookupTimer: null,
  lookupAccount() {
    clearTimeout(App._lookupTimer);
    const accNo = document.getElementById('send-account-no').value;
    if (accNo.length === 10) {
      App._lookupTimer = setTimeout(() => {
        // Simulate account name lookup
        const fakeNames = ['CHIOMA ADAEZE OKONKWO', 'EMEKA DANIEL CHUKWU', 'BLESSING FAVOUR NWOSU', 'TUNDE ABIODUN ADEYEMI', 'AMAKA PEACE OKAFOR'];
        const name = fakeNames[parseInt(accNo.slice(-1)) % fakeNames.length];
        document.getElementById('account-name-display').textContent = name;
        document.getElementById('account-name-group').style.display = 'block';
      }, 700);
    } else {
      document.getElementById('account-name-group').style.display = 'none';
    }
  },

  lookupNairaXUser() {
    const phone = document.getElementById('send-user-phone').value;
    if (phone.length >= 10) {
      const targetUser = DB.getUser(phone);
      if (targetUser) {
        document.getElementById('send-user-name-display').textContent = targetUser.name.toUpperCase();
        document.getElementById('user-name-group').style.display = 'block';
      } else {
        document.getElementById('user-name-group').style.display = 'none';
        if (phone.length === 11) App.toast('User not found on NairaX');
      }
    } else {
      document.getElementById('user-name-group').style.display = 'none';
    }
  },

  calcSendFee() {
    const amount = parseFloat(document.getElementById('send-amount').value) || 0;
    if (amount <= 0) { document.getElementById('fee-breakdown').style.display = 'none'; return; }

    const user = DB.getUser(State.currentUser);
    const cryptoTotal = user.cryptoAssets.reduce((s, a) => s + a.nairaValue, 0);

    // Determine source: naira first, then crypto
    let source = 'Naira Balance';
    let fee = 0;
    if (amount <= user.nairaBalance || State.sendType === 'user') {
      source = 'Naira Balance';
      fee = 0; // no fee for naira-to-naira
    } else if (cryptoTotal >= amount) {
      source = 'Crypto (ETH → Naira)';
      fee = amount * CONFIG.FEE_RATE;
    }

    document.getElementById('fee-amount').textContent = fmt(amount);
    document.getElementById('fee-charge').textContent = fmt(fee);
    document.getElementById('fee-total').textContent = fmt(amount + fee);
    document.getElementById('fee-source').textContent = source;
    document.getElementById('fee-breakdown').style.display = 'block';
  },

  executeSend() {
    const amount = parseFloat(document.getElementById('send-amount').value) || 0;
    if (amount <= 0) return App.toast('Enter a valid amount');

    const user = DB.getUser(State.currentUser);
    const narration = document.getElementById('send-narration').value || 'Money Transfer';

    if (State.sendType === 'user') {
      // NairaX to NairaX transfer
      const toPhone = document.getElementById('send-user-phone').value;
      const toUser = DB.getUser(toPhone);
      if (!toUser) return App.toast('NairaX user not found');
      if (toPhone === State.currentUser) return App.toast("You can't send to yourself");
      if (user.nairaBalance < amount) return App.toast('Insufficient Naira balance');

      App.requirePin(() => {
        user.nairaBalance -= amount;
        toUser.nairaBalance += amount;
        DB.saveUser(toPhone, toUser);
        DB.addTransaction(toPhone, {
          id: Date.now(), type: 'in',
          title: 'Received from ' + user.name.split(' ')[0],
          amount, date: new Date().toISOString(), note: narration
        });
        App._finalizeSend(user, amount, 0, 'Sent to ' + toUser.name, narration);
      });
      return;
    }

    // Bank transfer
    const acctNo = document.getElementById('send-account-no').value;
    if (acctNo.length !== 10) return App.toast('Enter a valid 10-digit account number');

    let fee = 0;
    let sourceLabel = '';
    let cryptoDeducted = 0;

    if (user.nairaBalance >= amount) {
      // Use naira directly
      sourceLabel = 'Naira';
    } else {
      // Use crypto
      const cryptoTotal = user.cryptoAssets.reduce((s, a) => s + a.nairaValue, 0);
      fee = amount * CONFIG.FEE_RATE;
      const totalNeeded = amount + fee;
      if (cryptoTotal + user.nairaBalance < totalNeeded) return App.toast('Insufficient balance');
      sourceLabel = 'Crypto';
      cryptoDeducted = fee;
    }

    App.requirePin(() => {
      App._finalizeSend(user, amount, fee, 'Bank Transfer · ' + acctNo, narration);
    });
  },

  _finalizeSend(user, amount, fee, title, narration) {
    const total = amount + fee;

    if (user.nairaBalance >= total) {
      user.nairaBalance -= total;
    } else {
      // Deduct from crypto
      let remaining = total - user.nairaBalance;
      user.nairaBalance = 0;
      for (const asset of user.cryptoAssets) {
        if (remaining <= 0) break;
        const deductNaira = Math.min(asset.nairaValue, remaining);
        const rate = asset.nairaValue / asset.amount;
        asset.amount -= deductNaira / rate;
        asset.nairaValue -= deductNaira;
        remaining -= deductNaira;

        // Add to pool
        const pool = DB.getPool();
        pool.eth += deductNaira / CONFIG.TESTNET_ETH_RATE;
        pool.naira -= amount; // pool paid the recipient
        DB.savePool(pool);
      }
      // Clean zero assets
      user.cryptoAssets = user.cryptoAssets.filter(a => a.amount > 0.000001);
    }

    DB.addTransaction(State.currentUser, {
      id: Date.now(), type: 'out',
      title, amount: total, date: new Date().toISOString(), note: narration
    });

    DB.saveUser(State.currentUser, user);

    App.closeModal('send-modal');
    App.closeModal('pin-modal');
    App.renderHome();

    App.showSuccess(
      'Transfer Successful! 🎉',
      `${fmt(amount)} sent successfully.\nFee: ${fmt(fee)}\nTotal deducted: ${fmt(total)}`
    );
  },

  // ── RECEIVE ───────────────────────────────
  setReceiveTab(tab) {
    State.receiveTab = tab;
    document.querySelectorAll('.rtab').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
    document.getElementById('receive-naira').classList.toggle('hidden', tab !== 'naira');
    document.getElementById('receive-crypto').classList.toggle('hidden', tab !== 'crypto');
  },

  copyPhone() {
    const user = DB.getUser(State.currentUser);
    navigator.clipboard?.writeText(user.phone).catch(() => {});
    App.toast('Account number copied! ✅');
  },

  copyWalletAddress() {
    const user = DB.getUser(State.currentUser);
    navigator.clipboard?.writeText(user.wallet.address).catch(() => {});
    App.toast('Wallet address copied! ✅');
  },

  // ── CRYPTO DEPOSIT SIMULATION ─────────────
  simulateCryptoDeposit() {
    const user = DB.getUser(State.currentUser);
    const ethAmount = CONFIG.SIMULATE_ETH_DEPOSIT;
    const nairaValue = ethAmount * CONFIG.TESTNET_ETH_RATE;

    // Add to existing ETH or create new
    let ethAsset = user.cryptoAssets.find(a => a.symbol === 'ETH');
    if (ethAsset) {
      ethAsset.amount += ethAmount;
      ethAsset.nairaValue += nairaValue;
    } else {
      user.cryptoAssets.push({ symbol: 'ETH', amount: ethAmount, nairaValue });
    }

    DB.addTransaction(State.currentUser, {
      id: Date.now(), type: 'in',
      title: 'Crypto Deposit – Sepolia ETH',
      amount: nairaValue,
      date: new Date().toISOString(),
      note: `${fmtCrypto(ethAmount, 'ETH')} received`
    });

    DB.saveUser(State.currentUser, user);
    App.renderHome();
    App.toast(`Received ${fmtCrypto(ethAmount, 'ETH')} (${fmt(nairaValue)}) ✅`);

    App.showSuccess(
      'Crypto Received! ⟠',
      `${fmtCrypto(ethAmount, 'sETH')} deposited.\nNaira value: ${fmt(nairaValue)}\nShowing in your balance.`
    );
  },

  // ── ADD MONEY ─────────────────────────────
  addTestNaira() {
    const user = DB.getUser(State.currentUser);
    const amount = CONFIG.BONUS_NAIRA;
    user.nairaBalance += amount;

    DB.addTransaction(State.currentUser, {
      id: Date.now(), type: 'in',
      title: 'Test Naira Received',
      amount, date: new Date().toISOString(), note: 'From NairaX Test Pool'
    });

    DB.saveUser(State.currentUser, user);
    App.closeModal('add-money-modal');
    App.renderHome();
    App.showSuccess('Money Added! 💰', `${fmt(amount)} test Naira added to your wallet.`);
  },

  // ── BILLS ─────────────────────────────────
  selectNetwork(el, network) {
    el.closest('.network-grid').querySelectorAll('.net-item').forEach(i => i.classList.remove('active-net'));
    el.classList.add('active-net');
    State.currentNetwork = network;
  },

  buyAirtime() {
    const phone = document.getElementById('airtime-phone').value;
    const amount = parseFloat(document.getElementById('airtime-amount').value) || 0;
    if (!phone || phone.length < 10) return App.toast('Enter phone number');
    if (amount < 50) return App.toast('Minimum airtime is ₦50');
    App.deductAndComplete('airtime-modal', amount, `${State.currentNetwork} Airtime – ${phone}`, 'Airtime Purchase');
  },

  buyData() {
    const phone = document.getElementById('data-phone').value;
    const amount = parseFloat(document.getElementById('data-plan').value) || 0;
    if (!phone || phone.length < 10) return App.toast('Enter phone number');
    App.deductAndComplete('data-modal', amount, `${State.currentNetwork} Data – ${phone}`, 'Data Purchase');
  },

  payElectricity() {
    const meter = document.getElementById('meter-number').value;
    const amount = parseFloat(document.getElementById('electricity-amount').value) || 0;
    if (!meter) return App.toast('Enter meter number');
    if (amount < 1000) return App.toast('Minimum is ₦1,000');
    App.deductAndComplete('electricity-modal', amount, document.getElementById('disco-select').value, 'Electricity Token');
  },

  payCable() {
    const card = document.getElementById('cable-card').value;
    const amount = parseFloat(document.getElementById('cable-package').value) || 0;
    if (!card) return App.toast('Enter card number');
    App.deductAndComplete('cable-modal', amount, document.getElementById('cable-provider').value + ' Subscription', 'Cable TV');
  },

  deductAndComplete(modalId, amount, title, note) {
    const user = DB.getUser(State.currentUser);
    const total = user.nairaBalance + user.cryptoAssets.reduce((s, a) => s + a.nairaValue, 0);
    if (total < amount) return App.toast('Insufficient balance');

    App.requirePin(() => {
      App._finalizeSend(user, amount, 0, title, note);
      App.closeModal(modalId);
    });
  },

  // ── PIN SYSTEM ────────────────────────────
  requirePin(callback) {
    State.pinBuffer = '';
    State.pinCallback = callback;
    App.updatePinDots();
    App.openModal('pin-modal');
  },

  pinInput(val) {
    if (val === 'clr') {
      State.pinBuffer = State.pinBuffer.slice(0, -1);
    } else if (val === 'ok') {
      const user = DB.getUser(State.currentUser);
      if (State.pinBuffer === user.pin) {
        App.closeModal('pin-modal');
        State.pinBuffer = '';
        App.updatePinDots();
        if (State.pinCallback) State.pinCallback();
      } else {
        State.pinBuffer = '';
        App.updatePinDots();
        App.toast('Incorrect PIN ❌');
      }
      return;
    } else if (State.pinBuffer.length < 4) {
      State.pinBuffer += val;
    }
    App.updatePinDots();
  },

  updatePinDots() {
    const dots = document.querySelectorAll('#pin-dots span');
    dots.forEach((d, i) => d.classList.toggle('filled', i < State.pinBuffer.length));
  },

  // ── SUCCESS ───────────────────────────────
  showSuccess(title, msg) {
    document.getElementById('success-title').textContent = title;
    document.getElementById('success-message').textContent = msg;
    document.getElementById('success-overlay').classList.remove('hidden');
  },

  closeSuccess() {
    document.getElementById('success-overlay').classList.add('hidden');
  },

  // ── TOAST ─────────────────────────────────
  toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    clearTimeout(App._toastTimer);
    App._toastTimer = setTimeout(() => t.classList.add('hidden'), 3000);
  },

  // ── NOTIFICATIONS (demo) ──────────────────
  showNotifications() {
    App.toast('No new notifications');
  },
};

// ── BOOT ──────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => App.init());