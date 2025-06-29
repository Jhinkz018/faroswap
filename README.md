# 🖁 Faros AutoSwap CLI

A command-line tool for batch token swaps on the Pharos testnet using the DODO route API and Ethers.js. Developed for automation, retry handling, fallback RPCs, and interactive inputs.

---

## ⚙️ Features

* ✅ Interactive CLI for swapping PHRS to other tokens (e.g. WETH, WBTC, USDC, USDT)
* 🔁 Supports batch swaps with user-defined repeat count
* 🔄 Retries failed swaps automatically
* ⏱ Timeout protection using `AbortController`
* 🌐 Fetches real-time DODO routes with slippage control
* 🔐 Uses `.env` file to load your private key securely
* 🚪 Includes graceful quit option (`q` or `quit`)

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

---

## 🚀 Usage

```bash
npm start
```

Then follow the prompts:

```
🔱 Enter token symbol to swap TO (e.g., WBTC): WETH
💸 Enter amount of PHRS to swap (in ETH): 1
🔁 How many swaps to perform?: 3
```

To exit at any time, type `q` or `quit`.

---

## 📌 Example Output

```
🚀 Starting AutoSwap Executor by 0xm3th

💰 Token Balances:
 - PHRS (native): 4826.35 PHRS
 - WETH: 0.0436
...

🔁 Swap #1 of 3
🌐 DODO API Request URL: ...
🧝 DODO Route Info fetched successfully
🚀 Swap Transaction sent! TX Hash: 0xabc...
✅ Transaction confirmed!
```

---

## 📄 License

MIT © [0xm3th](https://github.com/Jhinkz018)
