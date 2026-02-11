const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("MoltBets v2", function () {
  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const ROUND_1 = 20260211;
  const ROUND_2 = 20260212;
  const OPEN_PRICE = 69421000000n;  // $694.21 scaled 1e8
  const CLOSE_UP = 69800000000n;    // $698.00
  const CLOSE_DOWN = 69000000000n;  // $690.00

  async function deployFixture() {
    const [owner, agent1, agent2, agent3] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();

    const MoltBets = await ethers.getContractFactory("MoltBets");
    const moltbets = await MoltBets.deploy(await usdc.getAddress());

    // Give agents USDC and approve
    for (const agent of [agent1, agent2, agent3]) {
      await usdc.mint(agent.address, USDC(1000));
      await usdc.connect(agent).approve(await moltbets.getAddress(), USDC(1000));
    }
    // Give owner USDC for betFor
    await usdc.mint(owner.address, USDC(1000));
    await usdc.connect(owner).approve(await moltbets.getAddress(), USDC(1000));

    return { moltbets, usdc, owner, agent1, agent2, agent3 };
  }

  async function openAndAdvance(moltbets: any, roundId: number, openPrice: bigint) {
    await moltbets.openRound(roundId, openPrice);
    await time.increase(7 * 3600);
  }

  describe("Round Management", function () {
    it("should open a round", async function () {
      const { moltbets } = await deployFixture();
      await moltbets.openRound(ROUND_1, OPEN_PRICE);
      const pool = await moltbets.getCurrentPool();
      expect(pool.roundId).to.equal(ROUND_1);
    });

    it("should reject round ID 0", async function () {
      const { moltbets } = await deployFixture();
      await expect(moltbets.openRound(0, OPEN_PRICE))
        .to.be.revertedWith("Invalid roundId");
    });

    it("should not open duplicate rounds", async function () {
      const { moltbets } = await deployFixture();
      await moltbets.openRound(ROUND_1, OPEN_PRICE);
      await expect(moltbets.openRound(ROUND_1, OPEN_PRICE))
        .to.be.revertedWith("Round exists");
    });

    it("should reject non-settler opening rounds", async function () {
      const { moltbets, agent1 } = await deployFixture();
      await expect(moltbets.connect(agent1).openRound(ROUND_1, OPEN_PRICE))
        .to.be.revertedWith("Not settler");
    });

    it("should enforce one live round at a time", async function () {
      const { moltbets } = await deployFixture();
      await moltbets.openRound(ROUND_1, OPEN_PRICE);
      await expect(moltbets.openRound(ROUND_2, OPEN_PRICE))
        .to.be.revertedWith("Previous round not settled");
    });

    it("should allow new round after previous is settled", async function () {
      const { moltbets, agent1, agent2 } = await deployFixture();
      await openAndAdvance(moltbets, ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(false, USDC(10));
      await moltbets.settle(ROUND_1, CLOSE_UP);
      // Now we can open round 2
      await moltbets.openRound(ROUND_2, OPEN_PRICE);
      const pool = await moltbets.getCurrentPool();
      expect(pool.roundId).to.equal(ROUND_2);
    });
  });

  describe("Betting", function () {
    it("should place UP bet", async function () {
      const { moltbets, agent1 } = await deployFixture();
      await moltbets.openRound(ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      const b = await moltbets.getAgentBet(ROUND_1, agent1.address);
      expect(b.isUp).to.be.true;
      expect(b.amount).to.equal(USDC(10));
    });

    it("should place DOWN bet", async function () {
      const { moltbets, agent1 } = await deployFixture();
      await moltbets.openRound(ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(false, USDC(25));
      const b = await moltbets.getAgentBet(ROUND_1, agent1.address);
      expect(b.isUp).to.be.false;
    });

    it("should reject below min bet", async function () {
      const { moltbets, agent1 } = await deployFixture();
      await moltbets.openRound(ROUND_1, OPEN_PRICE);
      await expect(moltbets.connect(agent1).bet(true, USDC(0.5)))
        .to.be.revertedWith("Below min bet");
    });

    it("should reject above max bet", async function () {
      const { moltbets, agent1 } = await deployFixture();
      await moltbets.openRound(ROUND_1, OPEN_PRICE);
      await expect(moltbets.connect(agent1).bet(true, USDC(51)))
        .to.be.revertedWith("Above max bet");
    });

    it("should reject double bet", async function () {
      const { moltbets, agent1 } = await deployFixture();
      await moltbets.openRound(ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await expect(moltbets.connect(agent1).bet(false, USDC(10)))
        .to.be.revertedWith("Already bet");
    });

    it("should track pool totals", async function () {
      const { moltbets, agent1, agent2 } = await deployFixture();
      await moltbets.openRound(ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(false, USDC(20));
      const pool = await moltbets.getCurrentPool();
      expect(pool.totalUp).to.equal(USDC(10));
      expect(pool.totalDown).to.equal(USDC(20));
      expect(pool.totalAgents).to.equal(2);
    });

    it("should reject bets when paused", async function () {
      const { moltbets, agent1 } = await deployFixture();
      await moltbets.openRound(ROUND_1, OPEN_PRICE);
      await moltbets.setPaused(true);
      await expect(moltbets.connect(agent1).bet(true, USDC(10)))
        .to.be.revertedWith("Contract paused");
    });

    it("should allow betFor by settler", async function () {
      const { moltbets, owner, agent1 } = await deployFixture();
      await moltbets.openRound(ROUND_1, OPEN_PRICE);
      // Owner (settler) places bet on behalf of agent1, pulling USDC from owner
      await moltbets.betFor(agent1.address, true, USDC(10));
      const b = await moltbets.getAgentBet(ROUND_1, agent1.address);
      expect(b.amount).to.equal(USDC(10));
    });
  });

  describe("Settlement (claim-based)", function () {
    it("should settle and allow winner to claim", async function () {
      const { moltbets, usdc, agent1, agent2 } = await deployFixture();
      await openAndAdvance(moltbets, ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(false, USDC(10));

      await moltbets.settle(ROUND_1, CLOSE_UP);

      // Agent1 claims winnings
      const balBefore = await usdc.balanceOf(agent1.address);
      await moltbets.claim(ROUND_1, agent1.address);
      const balAfter = await usdc.balanceOf(agent1.address);

      // Winner gets original 10 + 95% of losing 10 = 10 + 9.5 = 19.5
      expect(balAfter - balBefore).to.equal(USDC(19.5));
    });

    it("should give loser 0 on claim", async function () {
      const { moltbets, usdc, agent1, agent2 } = await deployFixture();
      await openAndAdvance(moltbets, ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(false, USDC(10));

      await moltbets.settle(ROUND_1, CLOSE_UP);

      const balBefore = await usdc.balanceOf(agent2.address);
      await moltbets.claim(ROUND_1, agent2.address);
      const balAfter = await usdc.balanceOf(agent2.address);

      expect(balAfter - balBefore).to.equal(0);
    });

    it("should settle DOWN win correctly", async function () {
      const { moltbets, usdc, agent1, agent2 } = await deployFixture();
      await openAndAdvance(moltbets, ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(false, USDC(10));

      await moltbets.settle(ROUND_1, CLOSE_DOWN);

      const balBefore = await usdc.balanceOf(agent2.address);
      await moltbets.claim(ROUND_1, agent2.address);
      const balAfter = await usdc.balanceOf(agent2.address);
      expect(balAfter - balBefore).to.equal(USDC(19.5));
    });

    it("should collect fees via claimFee", async function () {
      const { moltbets, usdc, owner, agent1, agent2 } = await deployFixture();
      await openAndAdvance(moltbets, ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(false, USDC(10));

      await moltbets.settle(ROUND_1, CLOSE_UP);

      const feeBefore = await usdc.balanceOf(owner.address);
      await moltbets.claimFee(ROUND_1);
      const feeAfter = await usdc.balanceOf(owner.address);
      expect(feeAfter - feeBefore).to.equal(USDC(0.5));
    });

    it("should handle proportional payouts", async function () {
      const { moltbets, usdc, agent1, agent2, agent3 } = await deployFixture();
      await openAndAdvance(moltbets, ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(true, USDC(20));
      await moltbets.connect(agent3).bet(false, USDC(30));

      await moltbets.settle(ROUND_1, CLOSE_UP);

      // Agent1: 10 + (28.5 * 10/30) = 10 + 9.5 = 19.5
      const bal1Before = await usdc.balanceOf(agent1.address);
      await moltbets.claim(ROUND_1, agent1.address);
      expect(await usdc.balanceOf(agent1.address) - bal1Before).to.equal(USDC(19.5));

      // Agent2: 20 + (28.5 * 20/30) = 20 + 19 = 39
      const bal2Before = await usdc.balanceOf(agent2.address);
      await moltbets.claim(ROUND_1, agent2.address);
      expect(await usdc.balanceOf(agent2.address) - bal2Before).to.equal(USDC(39));
    });

    it("should refund one-sided bets (cancelled)", async function () {
      const { moltbets, usdc, agent1, agent2 } = await deployFixture();
      await openAndAdvance(moltbets, ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(true, USDC(20));

      await moltbets.settle(ROUND_1, CLOSE_UP);

      const bal1Before = await usdc.balanceOf(agent1.address);
      await moltbets.claim(ROUND_1, agent1.address);
      expect(await usdc.balanceOf(agent1.address) - bal1Before).to.equal(USDC(10));
    });

    it("should refund on tie (close == open)", async function () {
      const { moltbets, usdc, agent1, agent2 } = await deployFixture();
      await openAndAdvance(moltbets, ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(false, USDC(10));

      await moltbets.settle(ROUND_1, OPEN_PRICE); // close == open

      // Both get refunded
      const bal1Before = await usdc.balanceOf(agent1.address);
      await moltbets.claim(ROUND_1, agent1.address);
      expect(await usdc.balanceOf(agent1.address) - bal1Before).to.equal(USDC(10));

      const bal2Before = await usdc.balanceOf(agent2.address);
      await moltbets.claim(ROUND_1, agent2.address);
      expect(await usdc.balanceOf(agent2.address) - bal2Before).to.equal(USDC(10));
    });

    it("should reject double claim", async function () {
      const { moltbets, agent1, agent2 } = await deployFixture();
      await openAndAdvance(moltbets, ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(false, USDC(10));
      await moltbets.settle(ROUND_1, CLOSE_UP);
      await moltbets.claim(ROUND_1, agent1.address);
      await expect(moltbets.claim(ROUND_1, agent1.address))
        .to.be.revertedWith("Already claimed");
    });

    it("should reject double settlement", async function () {
      const { moltbets, agent1, agent2 } = await deployFixture();
      await openAndAdvance(moltbets, ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(false, USDC(10));
      await moltbets.settle(ROUND_1, CLOSE_UP);
      await expect(moltbets.settle(ROUND_1, CLOSE_UP))
        .to.be.revertedWith("Already settled");
    });

    it("should reject double fee claim", async function () {
      const { moltbets, agent1, agent2 } = await deployFixture();
      await openAndAdvance(moltbets, ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(false, USDC(10));
      await moltbets.settle(ROUND_1, CLOSE_UP);
      await moltbets.claimFee(ROUND_1);
      await expect(moltbets.claimFee(ROUND_1))
        .to.be.revertedWith("Fee already claimed");
    });

    it("should reject fee claim on refund rounds", async function () {
      const { moltbets, agent1, agent2 } = await deployFixture();
      await openAndAdvance(moltbets, ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(true, USDC(10));
      await moltbets.settle(ROUND_1, CLOSE_UP); // one-sided = cancelled
      await expect(moltbets.claimFee(ROUND_1))
        .to.be.revertedWith("No fee on refund");
    });

    it("should support batch claim", async function () {
      const { moltbets, usdc, agent1, agent2, agent3 } = await deployFixture();
      await openAndAdvance(moltbets, ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(false, USDC(10));
      await moltbets.connect(agent3).bet(true, USDC(10));
      await moltbets.settle(ROUND_1, CLOSE_UP);

      // Batch claim all three
      await moltbets.claimBatch(ROUND_1, [agent1.address, agent2.address, agent3.address]);

      // Verify all claimed
      const b1 = await moltbets.getAgentBet(ROUND_1, agent1.address);
      const b2 = await moltbets.getAgentBet(ROUND_1, agent2.address);
      expect(b1.claimed).to.be.true;
      expect(b2.claimed).to.be.true;
    });

    it("payoutOf should return expected payout before claim", async function () {
      const { moltbets, agent1, agent2 } = await deployFixture();
      await openAndAdvance(moltbets, ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(false, USDC(10));
      await moltbets.settle(ROUND_1, CLOSE_UP);

      const payout = await moltbets.payoutOf(ROUND_1, agent1.address);
      expect(payout).to.equal(USDC(19.5));

      const loserPayout = await moltbets.payoutOf(ROUND_1, agent2.address);
      expect(loserPayout).to.equal(0);
    });
  });

  describe("Safety Guardrails", function () {
    it("should reject price outside bounds (>10%)", async function () {
      const { moltbets, agent1, agent2 } = await deployFixture();
      await openAndAdvance(moltbets, ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(false, USDC(10));
      const crazyPrice = OPEN_PRICE * 120n / 100n;
      await expect(moltbets.settle(ROUND_1, crazyPrice))
        .to.be.revertedWith("Price outside bounds");
    });

    it("should reject price way below bounds", async function () {
      const { moltbets, agent1, agent2 } = await deployFixture();
      await openAndAdvance(moltbets, ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(false, USDC(10));
      const crashPrice = OPEN_PRICE * 85n / 100n;
      await expect(moltbets.settle(ROUND_1, crashPrice))
        .to.be.revertedWith("Price outside bounds");
    });

    it("should reject settlement too early (< 6 hours)", async function () {
      const { moltbets, agent1, agent2 } = await deployFixture();
      await moltbets.openRound(ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(false, USDC(10));
      await expect(moltbets.settle(ROUND_1, CLOSE_UP))
        .to.be.revertedWith("Too early to settle");
    });
  });

  describe("Emergency", function () {
    it("should emergency refund and allow claims", async function () {
      const { moltbets, usdc, agent1, agent2 } = await deployFixture();
      await moltbets.openRound(ROUND_1, OPEN_PRICE);
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(false, USDC(20));

      await moltbets.emergencyRefund(ROUND_1);

      // Both claim full refunds
      const bal1Before = await usdc.balanceOf(agent1.address);
      await moltbets.claim(ROUND_1, agent1.address);
      expect(await usdc.balanceOf(agent1.address) - bal1Before).to.equal(USDC(10));

      const bal2Before = await usdc.balanceOf(agent2.address);
      await moltbets.claim(ROUND_1, agent2.address);
      expect(await usdc.balanceOf(agent2.address) - bal2Before).to.equal(USDC(20));
    });

    it("should not allow non-owner emergency refund", async function () {
      const { moltbets, agent1 } = await deployFixture();
      await moltbets.openRound(ROUND_1, OPEN_PRICE);
      await expect(moltbets.connect(agent1).emergencyRefund(ROUND_1))
        .to.be.reverted;
    });
  });

  describe("Admin", function () {
    it("should update settler", async function () {
      const { moltbets, agent1 } = await deployFixture();
      await moltbets.setSettler(agent1.address);
      await moltbets.connect(agent1).openRound(ROUND_1, OPEN_PRICE);
    });

    it("should reject zero address fee recipient", async function () {
      const { moltbets } = await deployFixture();
      await expect(moltbets.setFeeRecipient(ethers.ZeroAddress))
        .to.be.revertedWith("Zero address");
    });

    it("should block rescuing USDC", async function () {
      const { moltbets, usdc } = await deployFixture();
      await expect(moltbets.rescueTokens(await usdc.getAddress(), 1))
        .to.be.revertedWith("Cannot rescue USDC");
    });
  });
});
