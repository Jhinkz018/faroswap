// Auto-swap script with tx execution, retry + timeout, fallback RPC, and route decoding
import fetch from 'node-fetch';
import AbortController from 'abort-controller';
import { ethers } from 'ethers';
import ora from 'ora';
import { buildFallbackProvider, ERC20_ABI } from './auto_swap_utilities.js';
import dotenv from 'dotenv';
import inquirer from 'inquirer';
import fs from 'fs';
dotenv.config();

const TOKENS = {
  PHRS: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  WBTC: '0x8275c526d1bCEc59a31d673929d3cE8d108fF5c7',
  WETH: '0x4E28826d32F1C398DED160DC16Ac6873357d048f',
  USDC: '0x72df0bcd7276f2dFbAc900D1CE63c272C4BCcCED',
  USDT: '0xD4071393f8716661958F766DF660033b3d35fD29',
  WPHRS: '0x3019B247381c850ab53Dc0EE53bCe7A07Ea9155f'
};

const PHAROS_CHAIN_ID = 688688;
const PHAROS_RPC_URLS = [
  'https://testnet.dplabs-internal.com'
];

async function showAllBalances(address, provider) {
  console.log('\n💰 Token Balances:');
  try {
    const native = await provider.getBalance(address);
    console.log(` - PHRS (native): ${ethers.formatEther(native)} PHRS`);
  } catch (err) {
    console.log(` - PHRS (native): Error fetching`);
  }

  for (const [symbol, tokenAddr] of Object.entries(TOKENS)) {
    if (symbol === 'PHRS') continue;
    const contract = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    try {
      const [balance, decimals] = await Promise.all([
        contract.balanceOf(address),
        contract.decimals()
      ]);
      const formatted = ethers.formatUnits(balance, decimals);
      console.log(` - ${symbol}: ${formatted}`);
    } catch (e) {
      console.log(` - ${symbol}: Error fetching`);
    }
  }
}

async function fetchWithTimeout(url, timeout = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (err) {
    throw new Error('Timeout or network error');
  }
}

async function robustFetchDodoRoute(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetchWithTimeout(url);
      const data = await res.json();
      if (data.status !== -1) return data;
      console.warn(`Retry ${i + 1} DODO API status -1`);
    } catch (e) {
      console.warn(`Retry ${i + 1} failed:`, e.message);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('DODO API permanently failed');
}

async function fetchDodoRoute(fromAddr, toAddr, userAddr, amountWei) {
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const url = `https://api.dodoex.io/route-service/v2/widget/getdodoroute?chainId=${PHAROS_CHAIN_ID}&deadLine=${deadline}&apikey=a37546505892e1a952&slippage=3.225&source=dodoV2AndMixWasm&toTokenAddress=${toAddr}&fromTokenAddress=${fromAddr}&userAddr=${userAddr}&estimateGas=true&fromAmount=${amountWei}`;
  console.log('\n🌐 DODO API Request URL:', url);

  try {
    const result = await robustFetchDodoRoute(url);
    console.log('\n🧭 DODO Route Info fetched successfully');
    return result.data;
  } catch (err) {
    console.error('\n❌ DODO API fetch failed:', err.message);
    throw err;
  }
}

async function executeSwap(wallet, routeData) {
  try {
    const tx = await wallet.sendTransaction({
      to: routeData.to,
      data: routeData.data,
      value: BigInt(routeData.value),
      gasLimit: BigInt(routeData.gasLimit || 300000)
    });
    console.log(`\n🚀 Swap Transaction sent! TX Hash: ${tx.hash}`);
    await tx.wait();
    console.log('✅ Transaction confirmed!');
  } catch (e) {
    console.error('❌ Swap TX failed:', e.message);
  }
}

async function batchSwap(wallet, from, to, value, count) {
  for (let i = 0; i < count; i++) {
    console.log(`\n🔁 Swap #${i + 1} of ${count}`);
    try {
      const data = await fetchDodoRoute(from, to, wallet.address, value);
      await executeSwap(wallet, data);
    } catch (e) {
      console.error(`❌ Swap #${i + 1} failed:`, e.message);
    }
    await new Promise(r => setTimeout(r, 1000)); // wait 1s between swaps
  }
}

function loadRecipients(path = 'wallets.txt') {
  try {
    const data = fs.readFileSync(path, 'utf8');
    return data.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  } catch (e) {
    console.error(`❌ Failed to read ${path}:`, e.message);
    return [];
  }
}

async function batchSendNative(wallet, recipients, amountWei, count) {
  for (let i = 0; i < count; i++) {
    const to = recipients[i % recipients.length];
    console.log(`\n🚀 Sending ${ethers.formatEther(amountWei)} PHRS to ${to} (#${i + 1}/${count})`);
    try {
      const tx = await wallet.sendTransaction({ to, value: amountWei });
      console.log(`TX Hash: ${tx.hash}`);
      await tx.wait();
      console.log('✅ Transaction confirmed!');
    } catch (e) {
      console.error(`❌ Send #${i + 1} failed:`, e.message);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}


async function mainMenu(wallet) {
  while (true) {
    const { action } = await inquirer.prompt({
      type: 'list',
      name: 'action',
      message: 'Select an option',
      choices: [
        { name: 'Swap Tokens', value: 'swap' },
        { name: 'Swap Tokens to PHRS', value: 'swap-native' },
        { name: 'Swap PHRS/WPHRS', value: 'swap-pair' },
        { name: 'Send PHRS to Addresses', value: 'send' },
        { name: 'Show Balances', value: 'balance' },
        { name: 'Quit', value: 'quit' }
      ]
    });

    if (action === 'quit') {
      console.log('👋 Goodbye!');
      process.exit(0);
    } else if (action === 'balance') {
      await showAllBalances(wallet.address, wallet.provider);
    } else if (action === 'send') {
      const answers = await inquirer.prompt([
        { type: 'input', name: 'amount', message: '💸 Enter amount of PHRS to send:' },
        { type: 'input', name: 'count', message: '🔁 How many transactions to perform?' }
      ]);
      try {
        const value = ethers.parseEther(answers.amount);
        const count = parseInt(answers.count);
        if (isNaN(count) || count < 1) throw new Error('Invalid transaction count');
        const recips = loadRecipients();
        if (recips.length === 0) throw new Error('No addresses found in wallets.txt');
        await batchSendNative(wallet, recips, value, count);
      } catch (e) {
        console.error('❌ Error:', e.message);
      }
    } else if (action === 'swap-pair') {
      const answers = await inquirer.prompt([
        { type: 'input', name: 'amount', message: '💸 Enter amount of PHRS to swap to WPHRS:' },
        { type: 'input', name: 'count', message: '🔁 How many swaps to perform?' }
      ]);
      try {
        const value = ethers.parseEther(answers.amount);
        const count = parseInt(answers.count);
        if (isNaN(count) || count < 1) throw new Error('Invalid swap count');
        await batchSwap(wallet, TOKENS.PHRS, TOKENS.WPHRS, value, count);
      } catch (e) {
        console.error('❌ Error:', e.message);
      }
    } else if (action === 'swap-native') {
      const answers = await inquirer.prompt([
        { type: 'input', name: 'symbol', message: '💱 Enter token symbol to swap FROM (e.g., WBTC):' },
        { type: 'input', name: 'amount', message: '💸 Enter amount to swap:' },
        { type: 'input', name: 'count', message: '🔁 How many swaps to perform?' }
      ]);
      try {
        const fromAddr = TOKENS[answers.symbol.toUpperCase()];
        if (!fromAddr || answers.symbol.toUpperCase() === 'PHRS') throw new Error('Invalid symbol');
        const contract = new ethers.Contract(fromAddr, ERC20_ABI, wallet);
        let decimals = 18;
        try { decimals = await contract.decimals(); } catch {}
        const value = ethers.parseUnits(answers.amount, decimals);
        const count = parseInt(answers.count);
        if (isNaN(count) || count < 1) throw new Error('Invalid swap count');
        await batchSwap(wallet, fromAddr, TOKENS.PHRS, value, count);
      } catch (e) {
        console.error('❌ Error:', e.message);
      }
    } else {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'symbol',
          message: '💱 Enter token symbol to swap TO (e.g., WBTC):'
        },
        {
          type: 'input',
          name: 'amount',
          message: '💸 Enter amount of PHRS to swap:'
        },
        {
          type: 'input',
          name: 'count',
          message: '🔁 How many swaps to perform?'
        }
      ]);

      try {
        if (!answers.amount || isNaN(answers.amount)) throw new Error('Invalid amount');
        const from = TOKENS.PHRS;
        const to = TOKENS[answers.symbol.toUpperCase()];
        if (!to) throw new Error('Invalid symbol.');
        const value = ethers.parseEther(answers.amount);
        const count = parseInt(answers.count);
        if (isNaN(count) || count < 1) throw new Error('Invalid swap count');
        await batchSwap(wallet, from, to, value, count);
      } catch (e) {
        console.error('❌ Error:', e.message);
      }
    }
  }
}

(async () => {
  console.log('\n🚀 Starting AutoSwap Executor by 0xm3th');

  const provider = await buildFallbackProvider(PHAROS_RPC_URLS, PHAROS_CHAIN_ID, 'pharos');
  const pk = process.env.PRIVATE_KEY;

  if (!pk || !pk.startsWith('0x') || pk.length !== 66) {
    console.error('❌ Invalid or missing PRIVATE_KEY in .env');
    process.exit(1);
  }

  try {
    const wallet = new ethers.Wallet(pk, provider);
    await showAllBalances(wallet.address, provider);
    await mainMenu(wallet);
  } catch (err) {
    console.error('❌ Wallet setup failed:', err.message);
    process.exit(1);
  }
})();
