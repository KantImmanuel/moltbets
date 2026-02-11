import { ethers } from 'ethers';

// Contract ABI (only the functions we need)
const MOLTBETS_ABI = [
  "function openRound(uint256 roundId, uint256 openPrice) external",
  "function settle(uint256 roundId, uint256 closePrice) external",
  "function claim(uint256 roundId, address agent) external",
  "function claimBatch(uint256 roundId, address[] calldata agents) external",
  "function claimFee(uint256 roundId) external",
  "function betFor(address agent, bool isUp, uint256 amount) external",
  "function getCurrentPool() external view returns (uint256 roundId, uint256 totalUp, uint256 totalDown, uint256 totalAgents)",
  "function getRound(uint256 roundId) external view returns (uint256 totalUp, uint256 totalDown, uint256 upCount, uint256 downCount, uint256 openPrice, uint256 closePrice, bool settled, uint8 outcome)",
  "function getAgentBet(uint256 roundId, address agent) external view returns (bool isUp, uint256 amount, bool claimed)",
  "function payoutOf(uint256 roundId, address agent) external view returns (uint256)",
  "function paused() external view returns (bool)",
  "event BetPlaced(uint256 indexed roundId, address indexed agent, bool isUp, uint256 amount)",
  "event RoundOpened(uint256 indexed roundId, uint256 openPrice)",
  "event RoundSettled(uint256 indexed roundId, uint256 closePrice, uint8 outcome)",
  "event Claimed(uint256 indexed roundId, address indexed agent, uint256 payout)",
];

const CONTRACT_ADDRESS = process.env.MOLTBETS_CONTRACT || '0x589c83B6177B307657Ee268007Bab91Bc0B85a15';
const BASE_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const DEPLOYER_KEY = process.env.DEPLOYER_KEY || '';

let provider: ethers.JsonRpcProvider;
let wallet: ethers.Wallet;
let contract: ethers.Contract;

function init() {
  if (!DEPLOYER_KEY) {
    console.warn('[Onchain] No DEPLOYER_KEY set — onchain features disabled');
    return false;
  }
  provider = new ethers.JsonRpcProvider(BASE_RPC);
  wallet = new ethers.Wallet(DEPLOYER_KEY, provider);
  contract = new ethers.Contract(CONTRACT_ADDRESS, MOLTBETS_ABI, wallet);
  console.log(`[Onchain] Connected to Base. Contract: ${CONTRACT_ADDRESS}`);
  console.log(`[Onchain] Settler wallet: ${wallet.address}`);
  return true;
}

// Convert SPY price (e.g., 694.21) to 1e8 scaled integer
function priceToOnchain(price: number): bigint {
  return BigInt(Math.round(price * 1e8));
}

// Get round ID from date string (YYYY-MM-DD -> YYYYMMDD)
function dateToRoundId(dateStr: string): number {
  return parseInt(dateStr.replace(/-/g, ''));
}

export async function openRoundOnchain(dateStr: string, openPrice: number): Promise<string | null> {
  if (!contract) return null;
  
  const roundId = dateToRoundId(dateStr);
  const price = priceToOnchain(openPrice);
  
  console.log(`[Onchain] Opening round ${roundId} with price $${openPrice} (${price})`);
  
  try {
    const tx = await contract.openRound(roundId, price);
    console.log(`[Onchain] openRound tx: ${tx.hash}`);
    await tx.wait();
    console.log(`[Onchain] Round ${roundId} opened onchain`);
    return tx.hash;
  } catch (err: any) {
    console.error(`[Onchain] openRound failed:`, err.message);
    return null;
  }
}

export async function settleRoundOnchain(dateStr: string, closePrice: number): Promise<string | null> {
  if (!contract) return null;
  
  const roundId = dateToRoundId(dateStr);
  const price = priceToOnchain(closePrice);
  
  console.log(`[Onchain] Settling round ${roundId} with close $${closePrice} (${price})`);
  
  try {
    const tx = await contract.settle(roundId, price);
    console.log(`[Onchain] settle tx: ${tx.hash}`);
    await tx.wait();
    console.log(`[Onchain] Round ${roundId} settled onchain`);
    return tx.hash;
  } catch (err: any) {
    console.error(`[Onchain] settle failed:`, err.message);
    return null;
  }
}

export async function getOnchainPool(): Promise<{ roundId: number; totalUp: string; totalDown: string; totalAgents: number } | null> {
  if (!contract) return null;
  
  try {
    const [roundId, totalUp, totalDown, totalAgents] = await contract.getCurrentPool();
    return {
      roundId: Number(roundId),
      totalUp: ethers.formatUnits(totalUp, 6),
      totalDown: ethers.formatUnits(totalDown, 6),
      totalAgents: Number(totalAgents),
    };
  } catch (err: any) {
    console.error('[Onchain] getPool failed:', err.message);
    return null;
  }
}

export async function getWalletBalance(): Promise<string | null> {
  if (!wallet) return null;
  try {
    const balance = await provider.getBalance(wallet.address);
    return ethers.formatEther(balance);
  } catch { return null; }
}

export const onchainEnabled = init();
export { CONTRACT_ADDRESS };
