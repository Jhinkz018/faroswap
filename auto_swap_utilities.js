import { ethers } from 'ethers';

// Minimal ERC20 ABI for balance and decimals
export const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

// Fallback provider builder
export async function buildFallbackProvider(rpcUrls, chainId, name) {
  // For simplicity, just use the first RPC URL
  return new ethers.JsonRpcProvider(rpcUrls[0], { chainId, name });
}
