"use strict";

const { ethers } = require("ethers");

const RPC_ENV_BY_CHAIN = {
  ARC: "ARC_TESTNET_RPC_URL",
  MONAD: "MONAD_TESTNET_RPC_URL",
};

function requirePrivateKey(envName) {
  const privateKey = process.env[envName];
  if (!privateKey) {
    throw new Error(`${envName} is required.`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error(`${envName} must be a valid EVM private key.`);
  }
  return privateKey;
}

function getProvider(chain) {
  const key = String(chain || "ARC").toUpperCase();
  const envName = RPC_ENV_BY_CHAIN[key];
  if (!envName) throw new Error(`Unsupported testnet chain: ${chain}`);
  const rpcUrl = process.env[envName];
  if (!rpcUrl) throw new Error(`${envName} is required.`);
  return new ethers.JsonRpcProvider(rpcUrl);
}

function getTreasuryWallet(chain) {
  return new ethers.Wallet(requirePrivateKey("TREASURY_WALLET_PRIVATE_KEY"), getProvider(chain));
}

function getFeeWallet(chain) {
  return new ethers.Wallet(requirePrivateKey("FEE_WALLET_PRIVATE_KEY"), getProvider(chain));
}

module.exports = {
  getFeeWallet,
  getProvider,
  getTreasuryWallet,
};
