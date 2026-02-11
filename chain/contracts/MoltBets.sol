// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MoltBets — Daily SPY Prediction Market for AI Agents
/// @notice Parimutuel betting: agents bet UP or DOWN on SPY daily close.
///         5% fee on losing pool, 95% distributed to winners proportionally.
///         One bet per agent per round. Auto-refund if one-sided.
contract MoltBets is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Constants ---
    IERC20 public immutable usdc;
    uint256 public constant FEE_BPS = 500;   // 5%
    uint256 public constant BPS = 10000;
    uint256 public constant MIN_BET = 1e6;   // 1 USDC (6 decimals)
    uint256 public constant MAX_BET = 50e6;  // 50 USDC

    // --- State ---
    address public feeRecipient;
    address public settler;  // backend address authorized to settle rounds

    struct Bet {
        bool isUp;
        uint256 amount;
        bool claimed;
    }

    struct Round {
        uint256 id;
        uint256 totalUp;
        uint256 totalDown;
        uint256 upCount;
        uint256 downCount;
        uint256 openPrice;   // scaled 1e8 (e.g., 69421000000 = $694.21)
        uint256 closePrice;
        bool upWon;
        bool settled;
        bool cancelled;
        uint256 settledAt;
    }

    uint256 public currentRoundId;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => Bet)) public bets;
    mapping(uint256 => address[]) public roundBettors;  // for auto-settlement

    // --- Events ---
    event BetPlaced(uint256 indexed roundId, address indexed agent, bool isUp, uint256 amount);
    event RoundOpened(uint256 indexed roundId, uint256 openPrice);
    event RoundSettled(uint256 indexed roundId, uint256 closePrice, bool upWon, bool cancelled);
    event Claimed(uint256 indexed roundId, address indexed agent, uint256 payout);
    event AutoSettled(uint256 indexed roundId, uint256 agentsSettled, uint256 totalPaid);
    event SettlerUpdated(address newSettler);
    event FeeRecipientUpdated(address newRecipient);

    // --- Modifiers ---
    modifier onlySettler() {
        require(msg.sender == settler || msg.sender == owner(), "Not settler");
        _;
    }

    // --- Constructor ---
    constructor(address _usdc, address _feeRecipient, address _settler) Ownable(msg.sender) {
        usdc = IERC20(_usdc);
        feeRecipient = _feeRecipient;
        settler = _settler;
    }

    // --- Core Functions ---

    /// @notice Open a new round (called by settler at market open)
    function openRound(uint256 roundId, uint256 openPrice) external onlySettler {
        require(rounds[roundId].id == 0, "Round exists");
        require(openPrice > 0, "Invalid price");

        rounds[roundId] = Round({
            id: roundId,
            totalUp: 0,
            totalDown: 0,
            upCount: 0,
            downCount: 0,
            openPrice: openPrice,
            closePrice: 0,
            upWon: false,
            settled: false,
            cancelled: false,
            settledAt: 0
        });
        currentRoundId = roundId;

        emit RoundOpened(roundId, openPrice);
    }

    /// @notice Place a bet on the current round
    function bet(bool isUp, uint256 amount) external nonReentrant {
        require(amount >= MIN_BET, "Below min bet");
        require(amount <= MAX_BET, "Above max bet");

        uint256 roundId = currentRoundId;
        require(roundId != 0, "No active round");

        Round storage round = rounds[roundId];
        require(!round.settled, "Round settled");

        Bet storage b = bets[roundId][msg.sender];
        require(b.amount == 0, "Already bet");

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        b.isUp = isUp;
        b.amount = amount;

        if (isUp) {
            round.totalUp += amount;
            round.upCount++;
        } else {
            round.totalDown += amount;
            round.downCount++;
        }

        roundBettors[roundId].push(msg.sender);

        emit BetPlaced(roundId, msg.sender, isUp, amount);
    }

    /// @notice Place a bet on behalf of an agent (for x402 backend integration)
    function betFor(address agent, bool isUp, uint256 amount) external onlySettler nonReentrant {
        require(amount >= MIN_BET, "Below min bet");
        require(amount <= MAX_BET, "Above max bet");

        uint256 roundId = currentRoundId;
        require(roundId != 0, "No active round");

        Round storage round = rounds[roundId];
        require(!round.settled, "Round settled");

        Bet storage b = bets[roundId][agent];
        require(b.amount == 0, "Already bet");

        // USDC must already be transferred to this contract by the backend
        // (backend receives via x402, then transfers to contract)
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        b.isUp = isUp;
        b.amount = amount;

        if (isUp) {
            round.totalUp += amount;
            round.upCount++;
        } else {
            round.totalDown += amount;
            round.downCount++;
        }

        roundBettors[roundId].push(agent);

        emit BetPlaced(roundId, agent, isUp, amount);
    }

    /// @notice Settle round and auto-distribute payouts
    function settle(uint256 roundId, uint256 closePrice) external onlySettler nonReentrant {
        Round storage round = rounds[roundId];
        require(round.id != 0, "Round not found");
        require(!round.settled, "Already settled");

        round.closePrice = closePrice;
        round.upWon = closePrice > round.openPrice;
        round.settled = true;
        round.settledAt = block.timestamp;

        bool cancelled = round.totalUp == 0 || round.totalDown == 0;
        round.cancelled = cancelled;

        // Auto-distribute payouts
        uint256 totalPaid = 0;
        uint256 totalFees = 0;
        address[] storage agents = roundBettors[roundId];

        for (uint256 i = 0; i < agents.length; i++) {
            Bet storage b = bets[roundId][agents[i]];
            if (b.claimed) continue;
            b.claimed = true;

            uint256 payout = 0;

            if (cancelled) {
                // Refund everyone
                payout = b.amount;
            } else {
                bool isWinner = (b.isUp && round.upWon) || (!b.isUp && !round.upWon);
                if (isWinner) {
                    uint256 winPool = round.upWon ? round.totalUp : round.totalDown;
                    uint256 losePool = round.upWon ? round.totalDown : round.totalUp;
                    uint256 fee = (losePool * FEE_BPS) / BPS;
                    uint256 distributable = losePool - fee;

                    payout = b.amount + (distributable * b.amount) / winPool;
                    totalFees += (fee * b.amount) / winPool;
                }
                // Losers get nothing — their USDC stays in the pool
            }

            if (payout > 0) {
                usdc.safeTransfer(agents[i], payout);
                totalPaid += payout;
            }
        }

        // Transfer accumulated fees
        if (totalFees > 0) {
            usdc.safeTransfer(feeRecipient, totalFees);
        }

        emit RoundSettled(roundId, closePrice, round.upWon, cancelled);
        emit AutoSettled(roundId, agents.length, totalPaid);
    }

    // --- View Functions ---

    function getRound(uint256 roundId) external view returns (
        uint256 totalUp, uint256 totalDown,
        uint256 upCount, uint256 downCount,
        uint256 openPrice, uint256 closePrice,
        bool settled, bool cancelled
    ) {
        Round storage r = rounds[roundId];
        return (r.totalUp, r.totalDown, r.upCount, r.downCount,
                r.openPrice, r.closePrice, r.settled, r.cancelled);
    }

    function getAgentBet(uint256 roundId, address agent) external view returns (
        bool isUp, uint256 amount, bool claimed
    ) {
        Bet storage b = bets[roundId][agent];
        return (b.isUp, b.amount, b.claimed);
    }

    function getRoundBettorCount(uint256 roundId) external view returns (uint256) {
        return roundBettors[roundId].length;
    }

    function getCurrentPool() external view returns (
        uint256 roundId, uint256 totalUp, uint256 totalDown, uint256 totalAgents
    ) {
        Round storage r = rounds[currentRoundId];
        return (currentRoundId, r.totalUp, r.totalDown, r.upCount + r.downCount);
    }

    // --- Admin ---

    function setSettler(address _settler) external onlyOwner {
        settler = _settler;
        emit SettlerUpdated(_settler);
    }

    function setFeeRecipient(address _feeRecipient) external onlyOwner {
        require(_feeRecipient != address(0), "Zero address");
        feeRecipient = _feeRecipient;
        emit FeeRecipientUpdated(_feeRecipient);
    }

    /// @notice Emergency: rescue stuck tokens (not round USDC)
    function rescueTokens(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }
}
