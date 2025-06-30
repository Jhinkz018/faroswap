// Auto-swap script with tx execution, retry + timeout, fallback RPC, and route decoding
import fetch from 'node-fetch';
import AbortController from 'abort-controller';
import { ethers } from 'ethers';
import ora from 'ora';
import { buildFallbackProvider, ERC20_ABI } from './auto_swap_utilities.js';
import dotenv from 'dotenv';
import inquirer from 'inquirer';
dotenv.config();

const TOKENS = {
  PHRS: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
  WBTC: '0x8275c526d1bCEc59a31d673929d3cE8d108fF5c7',
  WETH: '0x4E28826d32F1C398DED160DC16Ac6873357d048f',
  USDC: '0x72df0bcd7276f2dFbAc900D1CE63c272C4BCcCED',
  USDT: '0xD4071393f8716661958F766DF660033b3d35fD29',
  WPHRS: '0x3019B247381c850ab53Dc0EE53bCe7A07Ea9155f'
};

const POOL_ADDRESS = '0x596be65cf84c2ad87b8a17a3d4f10fc1359544ec';

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

async function showWbtcBalance(address, provider) {
  const tokenAddr = TOKENS.WBTC;
  const contract = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
  try {
    const [balance, decimals] = await Promise.all([
      contract.balanceOf(address),
      contract.decimals()
    ]);
    const formatted = Number(ethers.formatUnits(balance, decimals)).toFixed(2);
    console.log(`\n💰 WBTC Balance: ${formatted}`);
  } catch (e) {
    console.log('\n❌ Error fetching WBTC balance');
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

async function autoAddLiquidity(wallet) {
  if (!TOKENS.WPHRS) {
    console.error('❌ WPHRS address not configured');
    return;
  }

  const usdc = new ethers.Contract(TOKENS.USDC, ERC20_ABI, wallet);
  const wphrs = new ethers.Contract(TOKENS.WPHRS, ERC20_ABI, wallet);
  const poolAbi = ["function addLiquidity(uint256 amountUSDC, uint256 amountWPHRS) external"];
  const pool = new ethers.Contract(POOL_ADDRESS, poolAbi, wallet);

  const balance = await usdc.balanceOf(wallet.address);
  const decimals = await usdc.decimals();

  const minAmount = balance * BigInt(5) / BigInt(100);
  const maxAmount = balance * BigInt(10) / BigInt(100);
  const amountToUse = (minAmount + maxAmount) / BigInt(2);

  console.log(`USDC to deposit: ${ethers.formatUnits(amountToUse, decimals)}`);

  await usdc.approve(POOL_ADDRESS, amountToUse);
  await wphrs.approve(POOL_ADDRESS, amountToUse);

  const tx = await pool.addLiquidity(amountToUse, amountToUse);
  await tx.wait();

  console.log('✅ Liquidity added.');
}

async function batchAddLiquidity(wallet, count) {
  for (let i = 0; i < count; i++) {
    console.log(`\n💧 Add Liquidity #${i + 1} of ${count}`);
    try {
      await autoAddLiquidity(wallet);
    } catch (e) {
      console.error(`❌ Add liquidity #${i + 1} failed:`, e.message);
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
        { name: 'Auto-add Liquidity WPHRS/USDC', value: 'liquidity' },
        { name: 'Show Balances', value: 'balance' },
        { name: 'Show WBTC Balance', value: 'wbtc' },
        { name: 'Quit', value: 'quit' }
      ]
    });

    if (action === 'quit') {
      console.log('👋 Goodbye!');
      process.exit(0);
    } else if (action === 'balance') {
      await showAllBalances(wallet.address, wallet.provider);
    } else if (action === 'wbtc') {
      await showWbtcBalance(wallet.address, wallet.provider);
    } else if (action === 'liquidity') {
      const { count } = await inquirer.prompt({
        type: 'input',
        name: 'count',
        message: '🔁 How many liquidity adds to perform?'
      });
      const num = parseInt(count);
      if (isNaN(num) || num < 1) {
        console.error('❌ Invalid count');
      } else {
        await batchAddLiquidity(wallet, num);
      }
    } else {
      const answers = await inquirer.prompt([
        {
          type: 'list',
          name: 'symbol',
          message: '💱 Select token to swap TO:',
          choices: Object.keys(TOKENS).filter(sym => sym !== 'PHRS')
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
