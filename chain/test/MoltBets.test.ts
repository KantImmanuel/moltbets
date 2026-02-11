import { expect } from "chai";
import { ethers } from "hardhat";
import { MoltBets, MockUSDC } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("MoltBets", function () {
  let moltbets: MoltBets;
  let usdc: MockUSDC;
  let owner: SignerWithAddress;
  let settler: SignerWithAddress;
  let feeWallet: SignerWithAddress;
  let agent1: SignerWithAddress;
  let agent2: SignerWithAddress;
  let agent3: SignerWithAddress;

  const USDC = (n: number) => ethers.parseUnits(n.toString(), 6);
  const ROUND_1 = 20260211;
  const OPEN_PRICE = 69421000000n;  // $694.21 scaled 1e8
  const CLOSE_UP = 69800000000n;    // $698.00
  const CLOSE_DOWN = 69000000000n;  // $690.00

  beforeEach(async function () {
    [owner, settler, feeWallet, agent1, agent2, agent3] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();

    const MoltBets = await ethers.getContractFactory("MoltBets");
    moltbets = await MoltBets.deploy(await usdc.getAddress(), feeWallet.address, settler.address);

    // Mint USDC to agents
    for (const agent of [agent1, agent2, agent3]) {
      await usdc.mint(agent.address, USDC(1000));
      await usdc.connect(agent).approve(await moltbets.getAddress(), USDC(1000));
    }
    // Mint to settler for betFor
    await usdc.mint(settler.address, USDC(10000));
    await usdc.connect(settler).approve(await moltbets.getAddress(), USDC(10000));
  });

  describe("Round Management", function () {
    it("should open a round", async function () {
      await moltbets.connect(settler).openRound(ROUND_1, OPEN_PRICE);
      const pool = await moltbets.getCurrentPool();
      expect(pool.roundId).to.equal(ROUND_1);
    });

    it("should not open duplicate rounds", async function () {
      await moltbets.connect(settler).openRound(ROUND_1, OPEN_PRICE);
      await expect(moltbets.connect(settler).openRound(ROUND_1, OPEN_PRICE))
        .to.be.revertedWith("Round exists");
    });

    it("should reject non-settler opening rounds", async function () {
      await expect(moltbets.connect(agent1).openRound(ROUND_1, OPEN_PRICE))
        .to.be.revertedWith("Not settler");
    });
  });

  describe("Betting", function () {
    beforeEach(async function () {
      await moltbets.connect(settler).openRound(ROUND_1, OPEN_PRICE);
    });

    it("should place UP bet", async function () {
      await moltbets.connect(agent1).bet(true, USDC(10));
      const b = await moltbets.getAgentBet(ROUND_1, agent1.address);
      expect(b.isUp).to.be.true;
      expect(b.amount).to.equal(USDC(10));
    });

    it("should place DOWN bet", async function () {
      await moltbets.connect(agent1).bet(false, USDC(25));
      const b = await moltbets.getAgentBet(ROUND_1, agent1.address);
      expect(b.isUp).to.be.false;
      expect(b.amount).to.equal(USDC(25));
    });

    it("should reject below min bet", async function () {
      await expect(moltbets.connect(agent1).bet(true, USDC(0.5)))
        .to.be.revertedWith("Below min bet");
    });

    it("should reject above max bet", async function () {
      await expect(moltbets.connect(agent1).bet(true, USDC(51)))
        .to.be.revertedWith("Above max bet");
    });

    it("should reject double bet", async function () {
      await moltbets.connect(agent1).bet(true, USDC(10));
      await expect(moltbets.connect(agent1).bet(false, USDC(10)))
        .to.be.revertedWith("Already bet");
    });

    it("should track pool totals", async function () {
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(false, USDC(20));
      const pool = await moltbets.getCurrentPool();
      expect(pool.totalUp).to.equal(USDC(10));
      expect(pool.totalDown).to.equal(USDC(20));
      expect(pool.totalAgents).to.equal(2);
    });
  });

  describe("betFor (x402 integration)", function () {
    beforeEach(async function () {
      await moltbets.connect(settler).openRound(ROUND_1, OPEN_PRICE);
    });

    it("should allow settler to bet on behalf of agent", async function () {
      await moltbets.connect(settler).betFor(agent1.address, true, USDC(10));
      const b = await moltbets.getAgentBet(ROUND_1, agent1.address);
      expect(b.isUp).to.be.true;
      expect(b.amount).to.equal(USDC(10));
    });

    it("should reject non-settler betFor", async function () {
      await expect(moltbets.connect(agent1).betFor(agent2.address, true, USDC(10)))
        .to.be.revertedWith("Not settler");
    });
  });

  describe("Settlement", function () {
    beforeEach(async function () {
      await moltbets.connect(settler).openRound(ROUND_1, OPEN_PRICE);
    });

    it("should settle UP win and auto-distribute", async function () {
      await moltbets.connect(agent1).bet(true, USDC(10));   // winner
      await moltbets.connect(agent2).bet(false, USDC(10));   // loser

      const balBefore = await usdc.balanceOf(agent1.address);
      await moltbets.connect(settler).settle(ROUND_1, CLOSE_UP);
      const balAfter = await usdc.balanceOf(agent1.address);

      // Winner gets 10 + 9.5 (10 minus 5% fee) = 19.5 USDC
      expect(balAfter - balBefore).to.equal(USDC(19.5));
    });

    it("should settle DOWN win", async function () {
      await moltbets.connect(agent1).bet(true, USDC(10));    // loser
      await moltbets.connect(agent2).bet(false, USDC(10));   // winner

      const balBefore = await usdc.balanceOf(agent2.address);
      await moltbets.connect(settler).settle(ROUND_1, CLOSE_DOWN);
      const balAfter = await usdc.balanceOf(agent2.address);

      expect(balAfter - balBefore).to.equal(USDC(19.5));
    });

    it("should distribute fees to feeRecipient", async function () {
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(false, USDC(10));

      const feeBefore = await usdc.balanceOf(feeWallet.address);
      await moltbets.connect(settler).settle(ROUND_1, CLOSE_UP);
      const feeAfter = await usdc.balanceOf(feeWallet.address);

      // 5% of 10 USDC losing pool = 0.5 USDC
      expect(feeAfter - feeBefore).to.equal(USDC(0.5));
    });

    it("should handle proportional payouts with uneven pools", async function () {
      await moltbets.connect(agent1).bet(true, USDC(10));   // winner
      await moltbets.connect(agent2).bet(true, USDC(20));   // winner
      await moltbets.connect(agent3).bet(false, USDC(30));  // loser

      const bal1Before = await usdc.balanceOf(agent1.address);
      const bal2Before = await usdc.balanceOf(agent2.address);
      await moltbets.connect(settler).settle(ROUND_1, CLOSE_UP);
      const bal1After = await usdc.balanceOf(agent1.address);
      const bal2After = await usdc.balanceOf(agent2.address);

      // Losing pool: 30 USDC. Fee: 1.5 USDC. Distributable: 28.5 USDC.
      // Agent1 (10/30 of win pool): 10 + 28.5 * 10/30 = 10 + 9.5 = 19.5
      // Agent2 (20/30 of win pool): 20 + 28.5 * 20/30 = 20 + 19 = 39
      expect(bal1After - bal1Before).to.equal(USDC(19.5));
      expect(bal2After - bal2Before).to.equal(USDC(39));
    });

    it("should refund one-sided bets (cancelled)", async function () {
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(true, USDC(20));
      // No DOWN bets — should cancel

      const bal1Before = await usdc.balanceOf(agent1.address);
      const bal2Before = await usdc.balanceOf(agent2.address);
      await moltbets.connect(settler).settle(ROUND_1, CLOSE_UP);
      const bal1After = await usdc.balanceOf(agent1.address);
      const bal2After = await usdc.balanceOf(agent2.address);

      expect(bal1After - bal1Before).to.equal(USDC(10));
      expect(bal2After - bal2Before).to.equal(USDC(20));
    });

    it("should reject settling non-existent round", async function () {
      await expect(moltbets.connect(settler).settle(99999, CLOSE_UP))
        .to.be.revertedWith("Round not found");
    });

    it("should reject double settlement", async function () {
      await moltbets.connect(agent1).bet(true, USDC(10));
      await moltbets.connect(agent2).bet(false, USDC(10));
      await moltbets.connect(settler).settle(ROUND_1, CLOSE_UP);
      await expect(moltbets.connect(settler).settle(ROUND_1, CLOSE_UP))
        .to.be.revertedWith("Already settled");
    });
  });

  describe("Admin", function () {
    it("should update settler", async function () {
      await moltbets.connect(owner).setSettler(agent1.address);
      // agent1 can now settle
      await moltbets.connect(agent1).openRound(ROUND_1, OPEN_PRICE);
    });

    it("should update fee recipient", async function () {
      await moltbets.connect(owner).setFeeRecipient(agent1.address);
    });

    it("should reject zero address fee recipient", async function () {
      await expect(moltbets.connect(owner).setFeeRecipient(ethers.ZeroAddress))
        .to.be.revertedWith("Zero address");
    });
  });
});
