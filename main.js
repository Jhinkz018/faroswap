// Auto-swap script with tx execution, retry + timeout, fallback RPC, and route decoding
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ethers } from 'ethers';
import { buildFallbackProvider, ERC20_ABI } from './auto_swap_utilities.js';
import dotenv from 'dotenv';
import inquirer from 'inquirer';
import chalk from 'chalk';
import figlet from 'figlet';
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

const TOKEN_CHOICES = Object.keys(TOKENS).filter(sym => sym !== "PHRS");
const PHAROS_CHAIN_ID = 688688;
const PHAROS_RPC_URLS = [
  'https://testnet.dplabs-internal.com'
];

let axiosInstance = axios.create();

// Amount ranges for randomized swaps and sends
const [MIN_SWAP_AMOUNT, MAX_SWAP_AMOUNT] = (process.env.AMOUNT_SWAP || '0.1,0.9')
  .split(',')
  .map(v => parseFloat(v.trim()));
const [MIN_SEND_AMOUNT, MAX_SEND_AMOUNT] = (process.env.AMOUNT_SEND || '0.1,0.9')
  .split(',')
  .map(v => parseFloat(v.trim()));

function randomAmount(min, max) {
  return Math.random() * (max - min) + min;
}

// Delay between consecutive transactions in milliseconds
const MIN_TX_DELAY_MS = 40 * 1000; // 40 seconds
const MAX_TX_DELAY_MS = 120 * 1000; // 120 seconds

function randomTxDelay() {
  return Math.floor(Math.random() * (MAX_TX_DELAY_MS - MIN_TX_DELAY_MS + 1)) + MIN_TX_DELAY_MS;
}

function readProxiesFromFile(filename) {
  try {
    const content = fs.readFileSync(filename, 'utf8');
    return content.split('\n').map(l => l.trim()).filter(Boolean);
  } catch (err) {
    console.log(`Failed to read ${filename}: ${err.message}`);
    return [];
  }
}

function loadPrivateKeys() {
  return Object.keys(process.env)
    .filter(k => k.toUpperCase().startsWith('PRIVATE_KEY'))
    .map(k => process.env[k])
    .filter(pk => pk && pk.startsWith('0x') && pk.length === 66);
}

async function selectWallet(provider) {
  const keys = loadPrivateKeys();
  if (keys.length === 0) {
    console.error('❌ No PRIVATE_KEY entries found in .env');
    process.exit(1);
  }
  const wallets = keys.map(pk => new ethers.Wallet(pk, provider));
  if (wallets.length === 1) return wallets[0];
  const { idx } = await inquirer.prompt({
    type: 'list',
    name: 'idx',
    message: 'Select wallet to use',
    choices: wallets.map((w, i) => ({ name: w.address, value: i }))
  });
  return wallets[idx];
}

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

async function robustFetchDodoRoute(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const res = await axiosInstance.get(url, { timeout: 10000 });
      if (res.data.status !== -1) return res.data;
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

async function batchSwap(wallet, from, to, value, count, decimals = 18) {
  for (let i = 0; i < count; i++) {
    const amountWei = process.env.AMOUNT_SWAP
      ? ethers.parseUnits(randomAmount(MIN_SWAP_AMOUNT, MAX_SWAP_AMOUNT).toFixed(4), decimals)
      : value;
    console.log(`\n🔁 Swap #${i + 1} of ${count}`);
    try {
      const data = await fetchDodoRoute(from, to, wallet.address, amountWei);
      await executeSwap(wallet, data);
    } catch (e) {
      console.error(`❌ Swap #${i + 1} failed:`, e.message);
    }
    await new Promise(r => setTimeout(r, randomTxDelay()));
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
    const sendValue = process.env.AMOUNT_SEND
      ? ethers.parseEther(randomAmount(MIN_SEND_AMOUNT, MAX_SEND_AMOUNT).toFixed(4))
      : amountWei;
    console.log(`\n🚀 Sending ${ethers.formatEther(sendValue)} PHRS to ${to} (#${i + 1}/${count})`);
    try {
      const tx = await wallet.sendTransaction({ to, value: sendValue });
      console.log(`TX Hash: ${tx.hash}`);
      await tx.wait();
      console.log('✅ Transaction confirmed!');
    } catch (e) {
      console.error(`❌ Send #${i + 1} failed:`, e.message);
    }
    await new Promise(r => setTimeout(r, randomTxDelay()));
  }
}


async function autoMenu(wallet) {
  const { mode } = await inquirer.prompt({
    type: "list",
    name: "mode",
    message: "Select auto action",
    choices: [
      { name: "Swap PHRS -> Token", value: "phrs-to-token" },
      { name: "Swap Token -> PHRS", value: "token-to-phrs" },
      { name: "Send PHRS", value: "send" }
    ]
  });

  if (mode === "send") {
    const { count } = await inquirer.prompt({ type: "input", name: "count", message: "🔁 How many transactions to perform?" });
    const recipients = loadRecipients();
    if (recipients.length === 0) throw new Error("No addresses found in wallets.txt");
    await batchSendNative(wallet, recipients, 0n, parseInt(count));
    return;
  }

  const { symbol, count } = await inquirer.prompt([{ type: "list", name: "symbol", message: mode === "phrs-to-token" ? "Select token to swap TO:" : "Select token to swap FROM:", choices: TOKEN_CHOICES }, { type: "input", name: "count", message: "🔁 How many swaps to perform?" }]);
  const repeat = parseInt(count);
  if (isNaN(repeat) || repeat < 1) throw new Error("Invalid swap count");

  if (mode === "phrs-to-token") {
    const toAddr = TOKENS[symbol];
    await batchSwap(wallet, TOKENS.PHRS, toAddr, 0n, repeat, 18);
  } else {
    const fromAddr = TOKENS[symbol];
    const contract = new ethers.Contract(fromAddr, ERC20_ABI, wallet);
    let decimals = 18;
    try { decimals = await contract.decimals(); } catch {}
    await batchSwap(wallet, fromAddr, TOKENS.PHRS, 0n, repeat, decimals);
  }
}
async function mainMenu(provider, wallet) {

  let currentWallet = wallet;
  while (true) {
    const { action } = await inquirer.prompt({
      type: 'list',
      name: 'action',
      message: 'Select an option',
      choices: [
        { name: 'Swap Tokens', value: 'swap' },
        { name: 'Swap Tokens to PHRS', value: 'swap-native' },
        { name: 'Swap PHRS/WPHRS', value: 'swap-pair' },
        { name: 'AutoSwap (random amounts)', value: 'auto' },
        { name: 'Send PHRS to Addresses', value: 'send' },
        { name: 'Show Balances', value: 'balance' },
        { name: 'Change Wallet', value: 'change-wallet' },
        { name: 'Quit', value: 'quit' }
      ]
    });

    if (action === 'quit') {
      console.log('👋 Goodbye!');
      process.exit(0);
    } else if (action === 'balance') {
      await showAllBalances(currentWallet.address, currentWallet.provider);
    } else if (action === 'change-wallet') {
      currentWallet = await selectWallet(provider);
    } else if (action === 'auto') {
      try {
        await autoMenu(currentWallet);
      } catch (e) {
        console.error('❌ Error:', e.message);
      }
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
        await batchSendNative(currentWallet, recips, value, count);
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
        await batchSwap(currentWallet, TOKENS.PHRS, TOKENS.WPHRS, value, count, 18);
      } catch (e) {
        console.error('❌ Error:', e.message);
      }
    } else if (action === 'swap-native') {
        const answers = await inquirer.prompt([
          { type: "list", name: "symbol", message: "Select token to swap FROM:", choices: TOKEN_CHOICES },
          { type: "input", name: "amount", message: "💸 Enter amount to swap:" },
          { type: "input", name: "count", message: "🔁 How many swaps to perform?" }
        ]);
      try {
        const fromAddr = TOKENS[answers.symbol.toUpperCase()];
        if (!fromAddr || answers.symbol.toUpperCase() === 'PHRS') throw new Error('Invalid symbol');
        const contract = new ethers.Contract(fromAddr, ERC20_ABI, currentWallet);
        let decimals = 18;
        try { decimals = await contract.decimals(); } catch {}
        const value = ethers.parseUnits(answers.amount, decimals);
        const count = parseInt(answers.count);
        if (isNaN(count) || count < 1) throw new Error('Invalid swap count');
        await batchSwap(currentWallet, fromAddr, TOKENS.PHRS, value, count, decimals);
      } catch (e) {
        console.error('❌ Error:', e.message);
      }
    } else {
      const answers = await inquirer.prompt([
        {
          type: "list",
          name: "symbol",
          message: "Select token to swap TO:",
          choices: TOKEN_CHOICES
        },
        {
          type: "input",
          name: "amount",
          message: "💸 Enter amount of PHRS to swap:"
        },
        {
          type: "input",
          name: "count",
          message: "🔁 How many swaps to perform?"
        }
      ]);
        }
      );

      try {
        if (!answers.amount || isNaN(answers.amount)) throw new Error('Invalid amount');
        const from = TOKENS.PHRS;
        const to = TOKENS[answers.symbol.toUpperCase()];
        if (!to) throw new Error('Invalid symbol.');
        const value = ethers.parseEther(answers.amount);
        const count = parseInt(answers.count);
        if (isNaN(count) || count < 1) throw new Error('Invalid swap count');
        await batchSwap(currentWallet, from, to, value, count, 18);
      } catch (e) {
        console.error('❌ Error:', e.message);
      }
    }
  }
}

(async () => {
  const banner = figlet.textSync('0xm3th');
  const centered = banner
    .split('\n')
    .map(line => {
      const pad = Math.floor((process.stdout.columns - line.length) / 2);
      return ' '.repeat(Math.max(0, pad)) + line;
    })
    .join('\n');
  console.log(chalk.bold(centered));
  console.log('\n🚀 Starting AutoSwap Executor');

  const { useProxy } = await inquirer.prompt({
    type: 'confirm',
    name: 'useProxy',
    message: 'Do you want to use a proxy?',
    default: false
  });

  let proxyList = [];
  let proxyMode = null;

  if (useProxy) {
    const { proxyType } = await inquirer.prompt({
      type: 'list',
      name: 'proxyType',
      message: 'Select proxy type:',
      choices: ['Rotating', 'Static']
    });
    proxyMode = proxyType;
    proxyList = readProxiesFromFile('proxy.txt');
    if (proxyList.length > 0) {
      console.log(`${proxyList.length} proxies loaded.`);
    } else {
      console.log('proxy.txt is empty or missing, not using a proxy.');
    }
  }

  if (useProxy && proxyList.length > 0) {
    let selectedProxy;
    if (proxyMode === 'Rotating') {
      selectedProxy = proxyList[0];
    } else {
      selectedProxy = proxyList.shift();
      if (!selectedProxy) {
        console.log('No proxy left for static mode.');
        process.exit(1);
      }
    }
    console.log(`Using proxy: ${selectedProxy}`);
    const agent = new HttpsProxyAgent(selectedProxy);
    axiosInstance = axios.create({ httpAgent: agent, httpsAgent: agent });
    try {
      const ipRes = await axiosInstance.get('https://api.ipify.org?format=json', { timeout: 5000 });
      if (ipRes?.data?.ip) {
        console.log(`Connected to the IP: ${ipRes.data.ip}`);
      }
    } catch (err) {
      console.warn(`Could not determine proxy IP: ${err.message}`);
    }
  } else {
    axiosInstance = axios.create();
  }

  const provider = await buildFallbackProvider(PHAROS_RPC_URLS, PHAROS_CHAIN_ID, 'pharos');
  try {
    const wallet = await selectWallet(provider);
    await showAllBalances(wallet.address, provider);
    await mainMenu(provider, wallet);
  } catch (err) {
    console.error('❌ Wallet setup failed:', err.message);
    process.exit(1);
  }
})();
