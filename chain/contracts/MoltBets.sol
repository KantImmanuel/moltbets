// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title MoltBets v2 — Daily SPY Prediction Market for AI Agents
/// @notice Claim-based parimutuel betting. Agents bet UP or DOWN on SPY daily close.
///         5% fee on losing pool, 95% distributed to winners proportionally.
///         One bet per agent per round. Refund on ties or one-sided rounds.
///         Agents call claim() after settlement — no O(n) gas risk.
contract MoltBets is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // --- Constants ---
    IERC20 public immutable usdc;
    uint256 public constant FEE_BPS = 500;   // 5%
    uint256 public constant BPS = 10000;
    uint256 public constant MIN_BET = 1e6;   // 1 USDC (6 decimals)
    uint256 public constant MAX_BET = 50e6;  // 50 USDC

    // --- Safety bounds ---
    uint256 public maxPriceDeviationBps = 1000;  // 10% max move from open
    bool public paused;

    // --- State ---
    address public feeRecipient;
    address public settler;

    struct Bet {
        bool isUp;
        uint256 amount;
        bool claimed;
    }

    enum Outcome { PENDING, UP_WON, DOWN_WON, TIE, CANCELLED }

    struct Round {
        uint256 id;
        uint256 totalUp;
        uint256 totalDown;
        uint256 upCount;
        uint256 downCount;
        uint256 openPrice;   // scaled 1e8
        uint256 closePrice;
        Outcome outcome;
        bool settled;
        uint256 openedAt;
        uint256 settledAt;
        uint256 feeCollected;
    }

    uint256 public currentRoundId;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => Bet)) public bets;

    // --- Events ---
    event BetPlaced(uint256 indexed roundId, address indexed agent, bool isUp, uint256 amount);
    event RoundOpened(uint256 indexed roundId, uint256 openPrice);
    event RoundSettled(uint256 indexed roundId, uint256 closePrice, Outcome outcome);
    event Claimed(uint256 indexed roundId, address indexed agent, uint256 payout);
    event FeeClaimed(uint256 indexed roundId, uint256 amount);
    event SettlerUpdated(address newSettler);
    event FeeRecipientUpdated(address newRecipient);
    event Paused(bool isPaused);
    event EmergencyRefund(uint256 indexed roundId);

    // --- Modifiers ---
    modifier onlySettler() {
        require(msg.sender == settler || msg.sender == owner(), "Not settler");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "Contract paused");
        _;
    }

    // --- Constructor ---
    constructor(address _usdc) Ownable(msg.sender) {
        require(_usdc != address(0), "Zero USDC address");
        usdc = IERC20(_usdc);
        feeRecipient = msg.sender;
        settler = msg.sender;
    }

    // --- Core Functions ---

    /// @notice Open a new round. Previous round must be settled/cancelled first.
    function openRound(uint256 roundId, uint256 openPrice) external onlySettler whenNotPaused {
        require(roundId != 0, "Invalid roundId");
        require(rounds[roundId].id == 0, "Round exists");
        require(openPrice > 0, "Invalid price");
        
        // Enforce one live round at a time
        if (currentRoundId != 0) {
            require(rounds[currentRoundId].settled, "Previous round not settled");
        }

        rounds[roundId] = Round({
            id: roundId,
            totalUp: 0,
            totalDown: 0,
            upCount: 0,
            downCount: 0,
            openPrice: openPrice,
            closePrice: 0,
            outcome: Outcome.PENDING,
            settled: false,
            openedAt: block.timestamp,
            settledAt: 0,
            feeCollected: 0
        });
        currentRoundId = roundId;

        emit RoundOpened(roundId, openPrice);
    }

    /// @notice Place a bet on the current round (agent calls directly with USDC approval)
    function bet(bool isUp, uint256 amount) external nonReentrant whenNotPaused {
        _placeBet(msg.sender, isUp, amount, true);
    }

    /// @notice Place a bet on behalf of an agent (settler/backend calls, pulls USDC from settler)
    function betFor(address agent, bool isUp, uint256 amount) external onlySettler nonReentrant whenNotPaused {
        _placeBet(agent, isUp, amount, false);
    }

    function _placeBet(address agent, bool isUp, uint256 amount, bool pullFromAgent) internal {
        require(amount >= MIN_BET, "Below min bet");
        require(amount <= MAX_BET, "Above max bet");

        uint256 roundId = currentRoundId;
        require(roundId != 0, "No active round");

        Round storage round = rounds[roundId];
        require(!round.settled, "Round settled");

        Bet storage b = bets[roundId][agent];
        require(b.amount == 0, "Already bet");

        // Pull USDC from the appropriate source
        if (pullFromAgent) {
            usdc.safeTransferFrom(agent, address(this), amount);
        } else {
            usdc.safeTransferFrom(msg.sender, address(this), amount);
        }

        b.isUp = isUp;
        b.amount = amount;

        if (isUp) {
            round.totalUp += amount;
            round.upCount++;
        } else {
            round.totalDown += amount;
            round.downCount++;
        }

        emit BetPlaced(roundId, agent, isUp, amount);
    }

    /// @notice Settle a round with close price. Does NOT distribute — agents claim themselves.
    function settle(uint256 roundId, uint256 closePrice) external onlySettler nonReentrant {
        Round storage round = rounds[roundId];
        require(round.id != 0, "Round not found");
        require(!round.settled, "Already settled");

        // Safety: price can't deviate more than maxPriceDeviationBps from open
        uint256 maxMove = (round.openPrice * maxPriceDeviationBps) / BPS;
        require(
            closePrice >= round.openPrice - maxMove && 
            closePrice <= round.openPrice + maxMove,
            "Price outside bounds"
        );

        // Safety: must settle at least 6 hours after round opened
        require(
            block.timestamp >= round.openedAt + 6 hours,
            "Too early to settle"
        );

        round.closePrice = closePrice;
        round.settled = true;
        round.settledAt = block.timestamp;

        // Determine outcome
        bool oneSided = round.totalUp == 0 || round.totalDown == 0;
        if (oneSided || closePrice == round.openPrice) {
            // Tie or one-sided: everyone gets refunded via claim()
            round.outcome = (closePrice == round.openPrice) ? Outcome.TIE : Outcome.CANCELLED;
        } else if (closePrice > round.openPrice) {
            round.outcome = Outcome.UP_WON;
        } else {
            round.outcome = Outcome.DOWN_WON;
        }

        emit RoundSettled(roundId, closePrice, round.outcome);
    }

    /// @notice Claim payout for a settled round. Called by each agent (or anyone on their behalf).
    function claim(uint256 roundId, address agent) external nonReentrant {
        Round storage round = rounds[roundId];
        require(round.settled, "Round not settled");

        Bet storage b = bets[roundId][agent];
        require(b.amount > 0, "No bet found");
        require(!b.claimed, "Already claimed");

        b.claimed = true;

        uint256 payout = _calculatePayout(round, b);

        if (payout > 0) {
            usdc.safeTransfer(agent, payout);
        }

        emit Claimed(roundId, agent, payout);
    }

    /// @notice Batch claim for multiple agents in a round (backend convenience)
    function claimBatch(uint256 roundId, address[] calldata agents) external nonReentrant {
        Round storage round = rounds[roundId];
        require(round.settled, "Round not settled");

        for (uint256 i = 0; i < agents.length; i++) {
            Bet storage b = bets[roundId][agents[i]];
            if (b.amount == 0 || b.claimed) continue;
            
            b.claimed = true;
            uint256 payout = _calculatePayout(round, b);
            
            if (payout > 0) {
                usdc.safeTransfer(agents[i], payout);
            }

            emit Claimed(roundId, agents[i], payout);
        }
    }

    /// @notice Collect accumulated fee for a settled round
    function claimFee(uint256 roundId) external nonReentrant {
        Round storage round = rounds[roundId];
        require(round.settled, "Round not settled");
        require(round.outcome == Outcome.UP_WON || round.outcome == Outcome.DOWN_WON, "No fee on refund");
        require(round.feeCollected == 0, "Fee already claimed");

        uint256 losePool = (round.outcome == Outcome.UP_WON) ? round.totalDown : round.totalUp;
        uint256 fee = (losePool * FEE_BPS) / BPS;
        
        // Add rounding dust to fee (any USDC left after all winners claim)
        // This is cleaner than tracking dust separately
        round.feeCollected = fee;

        if (fee > 0) {
            usdc.safeTransfer(feeRecipient, fee);
        }

        emit FeeClaimed(roundId, fee);
    }

    function _calculatePayout(Round storage round, Bet storage b) internal view returns (uint256) {
        // Tie or cancelled: full refund
        if (round.outcome == Outcome.TIE || round.outcome == Outcome.CANCELLED) {
            return b.amount;
        }

        bool isWinner = (b.isUp && round.outcome == Outcome.UP_WON) || 
                        (!b.isUp && round.outcome == Outcome.DOWN_WON);

        if (!isWinner) {
            return 0; // Losers get nothing
        }

        // Winner payout: original bet + share of losing pool (minus fee)
        uint256 winPool = (round.outcome == Outcome.UP_WON) ? round.totalUp : round.totalDown;
        uint256 losePool = (round.outcome == Outcome.UP_WON) ? round.totalDown : round.totalUp;
        uint256 fee = (losePool * FEE_BPS) / BPS;
        uint256 distributable = losePool - fee;

        return b.amount + (distributable * b.amount) / winPool;
    }

    // --- View Functions ---

    /// @notice Calculate expected payout for an agent (before or after settlement)
    function payoutOf(uint256 roundId, address agent) external view returns (uint256) {
        Round storage round = rounds[roundId];
        if (!round.settled) return 0;

        Bet storage b = bets[roundId][agent];
        if (b.amount == 0 || b.claimed) return 0;

        return _calculatePayout(round, b);
    }

    function getRound(uint256 roundId) external view returns (
        uint256 totalUp, uint256 totalDown,
        uint256 upCount, uint256 downCount,
        uint256 openPrice, uint256 closePrice,
        bool settled, Outcome outcome
    ) {
        Round storage r = rounds[roundId];
        return (r.totalUp, r.totalDown, r.upCount, r.downCount,
                r.openPrice, r.closePrice, r.settled, r.outcome);
    }

    function getAgentBet(uint256 roundId, address agent) external view returns (
        bool isUp, uint256 amount, bool claimed
    ) {
        Bet storage b = bets[roundId][agent];
        return (b.isUp, b.amount, b.claimed);
    }

    function getCurrentPool() external view returns (
        uint256 roundId, uint256 totalUp, uint256 totalDown, uint256 totalAgents
    ) {
        Round storage r = rounds[currentRoundId];
        return (currentRoundId, r.totalUp, r.totalDown, r.upCount + r.downCount);
    }

    // --- Emergency Functions ---

    /// @notice Emergency refund all bets — marks round cancelled, agents claim() to get money back
    function emergencyRefund(uint256 roundId) external onlyOwner {
        Round storage round = rounds[roundId];
        require(round.id != 0, "Round not found");
        require(!round.settled, "Already settled");

        round.settled = true;
        round.outcome = Outcome.CANCELLED;
        round.settledAt = block.timestamp;

        emit EmergencyRefund(roundId);
    }

    /// @notice Pause/unpause betting
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit Paused(_paused);
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

    function setMaxPriceDeviation(uint256 _bps) external onlyOwner {
        require(_bps >= 100 && _bps <= 5000, "1-50% range");
        maxPriceDeviationBps = _bps;
    }

    /// @notice Rescue stuck tokens — CANNOT rescue USDC (pool protection)
    function rescueTokens(address token, uint256 amount) external onlyOwner {
        require(token != address(usdc), "Cannot rescue USDC");
        IERC20(token).safeTransfer(owner(), amount);
    }
}
