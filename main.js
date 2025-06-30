// Auto-swap script with tx execution, retry + timeout, fallback RPC, and route decoding
import fetch from 'node-fetch';
import AbortController from 'abort-controller';
import { ethers } from 'ethers';
import { buildFallbackProvider, ERC20_ABI } from './auto_swap_utilities.js';
import dotenv from 'dotenv';
import blessed from 'blessed';
import chalk from 'chalk';
import figlet from 'figlet';
dotenv.config();

const TOKENS = {
  PHRS: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  WBTC: '0x8275c526d1bCEc59a31d673929d3cE8d108fF5c7',
  WETH: '0x4E28826d32F1C398DED160DC16Ac6873357d048f',
  USDC: '0x72df0bcd7276f2dFbAc900D1CE63c272C4BCcCED',
  USDT: '0xD4071393f8716661958F766DF660033b3d35fD29'
};

const PHAROS_CHAIN_ID = 688688;
const PHAROS_RPC_URLS = [
  'https://testnet.dplabs-internal.com'
];

let screen;
let menuBox;
let logBox;
let promptBox;
let headerBox;

function initUI() {
  screen = blessed.screen({ smartCSR: true, title: 'Faros AutoSwap' });

  headerBox = blessed.box({
    top: 0,
    left: 'center',
    width: '100%',
    height: 5,
    align: 'center',
    tags: true
  });

  menuBox = blessed.list({
    top: 6,
    left: 0,
    width: '30%',
    height: '100%-6',
    keys: true,
    mouse: true,
    style: {
      selected: { bg: 'blue', fg: 'white' },
      border: { fg: 'cyan' }
    },
    border: { type: 'line' },
    items: ['Swap Tokens', 'Show Balances', 'Quit']
  });

  logBox = blessed.log({
    top: 6,
    left: '30%',
    width: '70%',
    height: '100%-6',
    border: { type: 'line' },
    tags: true,
    scrollbar: { ch: ' ', style: { bg: 'cyan' } }
  });

  promptBox = blessed.prompt({
    parent: screen,
    keys: true,
    left: 'center',
    top: 'center',
    width: '50%',
    height: 'shrink',
    border: 'line',
    tags: true,
    hidden: true
  });

  screen.append(headerBox);
  screen.append(menuBox);
  screen.append(logBox);

  figlet('AutoSwap', (err, data) => {
    headerBox.setContent(chalk.cyan(data));
    screen.render();
  });

  screen.key(['escape', 'q', 'C-c'], () => process.exit(0));
  menuBox.focus();
  screen.render();
}

function log(message) {
  if (logBox) logBox.log(message);
  else console.log(message);
}

async function showAllBalances(address, provider) {
  log('\n💰 Token Balances:');
  try {
    const native = await provider.getBalance(address);
    log(` - PHRS (native): ${ethers.formatEther(native)} PHRS`);
  } catch (err) {
    log(` - PHRS (native): Error fetching`);
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
      log(` - ${symbol}: ${formatted}`);
    } catch (e) {
      log(` - ${symbol}: Error fetching`);
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
      log(`Retry ${i + 1} DODO API status -1`);
    } catch (e) {
      log(`Retry ${i + 1} failed: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('DODO API permanently failed');
}

async function fetchDodoRoute(fromAddr, toAddr, userAddr, amountWei) {
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const url = `https://api.dodoex.io/route-service/v2/widget/getdodoroute?chainId=${PHAROS_CHAIN_ID}&deadLine=${deadline}&apikey=a37546505892e1a952&slippage=3.225&source=dodoV2AndMixWasm&toTokenAddress=${toAddr}&fromTokenAddress=${fromAddr}&userAddr=${userAddr}&estimateGas=true&fromAmount=${amountWei}`;
  log(`\n🌐 DODO API Request URL: ${url}`);

  try {
    const result = await robustFetchDodoRoute(url);
    log('\n🧭 DODO Route Info fetched successfully');
    return result.data;
  } catch (err) {
    log(`\n❌ DODO API fetch failed: ${err.message}`);
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
    log(`\n🚀 Swap Transaction sent! TX Hash: ${tx.hash}`);
    await tx.wait();
    log('✅ Transaction confirmed!');
  } catch (e) {
    log(`❌ Swap TX failed: ${e.message}`);
  }
}

async function batchSwap(wallet, from, to, value, count) {
  for (let i = 0; i < count; i++) {
    log(`\n🔁 Swap #${i + 1} of ${count}`);
    try {
      const data = await fetchDodoRoute(from, to, wallet.address, value);
      await executeSwap(wallet, data);
    } catch (e) {
      log(`❌ Swap #${i + 1} failed: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 1000)); // wait 1s between swaps
  }
}

function ask(question) {
  return new Promise((resolve) => {
    promptBox.input(question, '', (err, value) => {
      resolve((value || '').trim());
    });
  });
}

async function handleSwap(wallet) {
  const symbol = (await ask('💱 Enter token symbol to swap TO (e.g., WBTC):')).toUpperCase();
  const amount = await ask('💸 Enter amount of PHRS to swap:');
  const countStr = await ask('🔁 How many swaps to perform?');

  try {
    if (!amount || isNaN(amount)) throw new Error('Invalid amount');
    const from = TOKENS.PHRS;
    const to = TOKENS[symbol];
    if (!to) throw new Error('Invalid symbol.');
    const value = ethers.parseEther(amount);
    const count = parseInt(countStr);
    if (isNaN(count) || count < 1) throw new Error('Invalid swap count');
    await batchSwap(wallet, from, to, value, count);
  } catch (e) {
    log(`❌ Error: ${e.message}`);
  }
}

function mainMenu(wallet) {
  menuBox.on('select', async (item) => {
    const action = item.getText();
    if (action === 'Quit') {
      process.exit(0);
    } else if (action === 'Show Balances') {
      await showAllBalances(wallet.address, wallet.provider);
    } else if (action === 'Swap Tokens') {
      await handleSwap(wallet);
    }
    menuBox.select(0);
    screen.render();
  });
}

(async () => {
  initUI();
  log('🚀 Starting AutoSwap Executor by 0xm3th');

  const provider = await buildFallbackProvider(PHAROS_RPC_URLS, PHAROS_CHAIN_ID, 'pharos');
  const pk = process.env.PRIVATE_KEY;

  if (!pk || !pk.startsWith('0x') || pk.length !== 66) {
    log('❌ Invalid or missing PRIVATE_KEY in .env');
    process.exit(1);
  }

  try {
    const wallet = new ethers.Wallet(pk, provider);
    await showAllBalances(wallet.address, provider);
    mainMenu(wallet);
    screen.render();
  } catch (err) {
    log(`❌ Wallet setup failed: ${err.message}`);
    process.exit(1);
  }
  screen.render();
})();
