// HD wallet (BIP44) address generator for USDT BEP20 top-ups.
//
// The server only ever holds the XPUB (watch-only). It can generate unlimited
// deposit addresses but can NEVER spend funds. Spending requires the seed
// phrase, which stays with the site owner offline.
//
// How the owner gets the xpub (do this OFFLINE, once):
//  1. Open https://iancoleman.io/bip39/ on an offline/air-gapped device.
//  2. Generate 12 words, write them on paper, never share them.
//  3. Set Coin to "ETH - Ethereum" (coin 60, same address format as BSC).
//  4. Copy the "Account Extended Public Key" (starts with xpub...).
//  5. Paste it in Admin -> Settings -> USDT XPUB.
//
// Derivation path: m/44'/60'/0'/0/<index>  (BSC/EVM addresses)
const { ethers } = require('ethers');

function isValidXpub(xpub) {
  return typeof xpub === 'string' && /^(xpub)[1-9A-HJ-NP-Za-km-z]{100,112}$/.test(xpub.trim());
}

// index -> 0x address
function deriveAddress(xpub, index) {
  if (!isValidXpub(xpub)) throw new Error('Invalid XPUB — paste the Account Extended Public Key (starts with xpub)');
  if (!Number.isInteger(index) || index < 0 || index > 2147483647) throw new Error('Bad address index');
  const account = ethers.HDNodeWallet.fromExtendedKey(xpub.trim());
  // account is at m/44'/60'/0' ; derive /0/<index>
  const child = account.deriveChild(0).deriveChild(index);
  return child.address; // EIP-55 checksummed 0x address (works on BSC)
}

module.exports = { isValidXpub, deriveAddress };
