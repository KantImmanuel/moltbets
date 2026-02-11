import db from '../db';
import { getSpyPrice, getSpyOpen } from './spy';
import { getTodayRoundId } from './market-state';
import { openRoundOnchain, settleRoundOnchain, onchainEnabled } from './onchain';

export async function createDailyRound(): Promise<void> {
  const roundId = getTodayRoundId();
  const existing = db.prepare('SELECT id FROM rounds WHERE id = ?').get(roundId);
  if (existing) {
    console.log(`[Round] Round ${roundId} already exists`);
    return;
  }

  try {
    const openPrice = await getSpyOpen();
    db.prepare('INSERT INTO rounds (id, status, open_price) VALUES (?, ?, ?)').run(roundId, 'open', openPrice);
    console.log(`[Round] Created round ${roundId} with open price $${openPrice}`);
    
    // Also open round onchain
    if (onchainEnabled) {
      const txHash = await openRoundOnchain(roundId, openPrice);
      if (txHash) {
        db.prepare("UPDATE rounds SET open_tx = ? WHERE id = ?").run(txHash, roundId);
      }
    }
  } catch (err) {
    console.error('[Round] Failed to create round:', err);
  }
}

export async function settleRound(roundId?: string): Promise<{
  roundId: string;
  openPrice: number;
  closePrice: number;
  result: string;
  winnersCount: number;
  losersCount: number;
}> {
  const id = roundId || getTodayRoundId();
  const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(id) as any;

  if (!round) throw new Error(`Round ${id} not found`);
  if (round.status === 'settled') throw new Error(`Round ${id} already settled`);

  let closePrice: number;
  try {
    closePrice = await getSpyPrice();
  } catch {
    // Fallback: check if price was pushed via admin endpoint
    const kv = db.prepare("SELECT value FROM kv WHERE key = 'spy_price'").get() as any;
    if (kv) {
      const pushed = JSON.parse(kv.value);
      closePrice = pushed.price;
    } else {
      throw new Error('Cannot fetch SPY price and no pushed price available');
    }
  }
  
  // Use round's stored close_price if set by admin
  if (round.close_price) closePrice = round.close_price;
  
  const openPrice = round.open_price;
  if (!openPrice) throw new Error(`Round ${id} has no open price`);

  let result: string;
  if (closePrice > openPrice) result = 'UP';
  else if (closePrice < openPrice) result = 'DOWN';
  else result = 'PUSH';

  console.log(`[Settlement] Round ${id}: open=$${openPrice} close=$${closePrice} result=${result}`);

  // Update round
  db.prepare(`
    UPDATE rounds SET status = 'settled', close_price = ?, result = ?, settled_at = datetime('now')
    WHERE id = ?
  `).run(closePrice, result, id);

  // Get all bets for this round
  const bets = db.prepare('SELECT * FROM bets WHERE round_id = ?').all(id) as any[];

  // Parimutuel pool calculation
  const HOUSE_FEE = 0.05;
  const totalPool = round.total_up_bets + round.total_down_bets;
  const winningPool = result === 'UP' ? round.total_up_bets : round.total_down_bets;
  const losingPool = result === 'UP' ? round.total_down_bets : round.total_up_bets;
  const oneSided = winningPool === 0 || losingPool === 0;
  const payoutPool = totalPool * (1 - HOUSE_FEE);

  let winnersCount = 0;
  let losersCount = 0;

  const updateBet = db.prepare('UPDATE bets SET result = ?, payout = ? WHERE id = ?');
  const updateAgent = db.prepare(`
    UPDATE agents SET
      balance = balance + ?,
      total_wins = total_wins + ?,
      total_losses = total_losses + ?,
      total_profit = total_profit + ?,
      current_streak = ?,
      best_streak = MAX(best_streak, ?)
    WHERE id = ?
  `);

  const settle = db.transaction(() => {
    for (const bet of bets) {
      const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(bet.agent_id) as any;
      if (!agent) continue;

      if (result === 'PUSH') {
        // Refund
        updateBet.run('push', bet.amount, bet.id);
        updateAgent.run(bet.amount, 0, 0, 0, agent.current_streak, agent.best_streak, agent.id);
      } else if (oneSided) {
        // Everyone bet the same side — full refund (no counterparty)
        updateBet.run('push', bet.amount, bet.id);
        updateAgent.run(bet.amount, 0, 0, 0, agent.current_streak, agent.best_streak, agent.id);
      } else if (bet.direction === result) {
        // Winner: parimutuel payout proportional to bet size
        const payout = (bet.amount / winningPool) * payoutPool;
        const profit = payout - bet.amount;
        const newStreak = agent.current_streak + 1;
        updateBet.run('win', payout, bet.id);
        updateAgent.run(payout, 1, 0, profit, newStreak, Math.max(agent.best_streak, newStreak), agent.id);
        winnersCount++;
      } else {
        // Loser
        const newStreak = 0;
        updateBet.run('loss', 0, bet.id);
        updateAgent.run(0, 0, 1, -bet.amount, newStreak, agent.best_streak, agent.id);
        losersCount++;
      }
    }

    // Auto-reset bankrupt agents to 1000 credits
    db.prepare('UPDATE agents SET balance = 1000 WHERE balance <= 0').run();
  });

  settle();

  console.log(`[Settlement] Round ${id} settled: ${winnersCount} winners, ${losersCount} losers`);

  // Also settle onchain
  if (onchainEnabled) {
    const txHash = await settleRoundOnchain(id, closePrice);
    if (txHash) {
      db.prepare("UPDATE rounds SET settle_tx = ? WHERE id = ?").run(txHash, id);
      console.log(`[Settlement] Onchain settle tx: ${txHash}`);
    }
  }

  return { roundId: id, openPrice, closePrice, result, winnersCount, losersCount };
}
