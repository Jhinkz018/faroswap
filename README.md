# 🖁 Faros AutoSwap CLI

A command-line tool for batch token swaps on the Pharos testnet using the DODO route API and Ethers.js. Developed for automation, retry handling, fallback RPCs, and interactive inputs.

---

## ⚙️ Features

* ✅ Interactive CLI for swapping PHRS to other tokens (e.g. WETH, WBTC, USDC, USDT)
* ↔ Swap PHRS directly to WPHRS
* 🔁 Supports batch swaps with user-defined repeat count
* 🔄 Retries failed swaps automatically
* ⏱ Timeout protection using `AbortController`
* 🌐 Fetches real-time DODO routes with slippage control
* 🔐 Uses `.env` file to load your private key securely
* 🚪 Interactive menu with a quit option
* 💧 Auto-add liquidity for the WPHRS/USDC pair

---

## 📆 Installation

```bash
git clone https://github.com/Jhinkz018/faroswap.git
cd faroswap
npm install
```

---

## 📁 Required Files

* `main.js` — main CLI logic
* `auto_swap_utilities.js` — utility for ERC20 ABI & fallback RPC
* `.env` — contains your private key (not committed)

Create your `.env` like this:

```
PRIVATE_KEY=0xyourprivatekeyhere
```

---

## 🔪 Supported Tokens

On Pharos testnet:

| Symbol | Token Address |
| ------ | ------------- |
| PHRS   | Native token  |
| WETH   | `0x4E28...`   |
| WBTC   | `0x8275...`   |
| USDC   | `0x72df...`   |
| USDT   | `0xD407...`   |
| WPHRS  | `0x3019...`   |

---

## 🚀 Usage

```bash
npm start
```

Use the interactive menu to select **Swap Tokens** and provide the token symbol, amount, and number of repeats when prompted.
The menu also includes **Swap PHRS/WPHRS** and **Auto-add Liquidity WPHRS/USDC** to deposit 5-10% of your USDC balance.

---

## 📌 Example Output

```
🚀 Starting AutoSwap Executor by 0xm3th

💰 Token Balances:
 - PHRS (native): 4826.35 PHRS
 - WETH: 0.0436
...

? Select an option (Use arrow keys)
❯ Swap Tokens
  Show Balances
  Quit

🔁 Swap #1 of 3
🌐 DODO API Request URL: ...
🧝 DODO Route Info fetched successfully
🚀 Swap Transaction sent! TX Hash: 0xabc...
✅ Transaction confirmed!
```

---

## 📄 License

MIT © [0xm3th](https://github.com/Jhinkz018)
