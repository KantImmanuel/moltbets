import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';
import { isBettingOpen, getTodayRoundId } from '../services/market-state';

const router = Router();

const MIN_BET = 10;
const MAX_BET = 1000;

router.post('/', requireAuth, (req: AuthRequest, res: Response) => {
  try {
    const agent = req.agent!;
    const { direction, amount } = req.body;

    // Validate direction
    if (!direction || !['UP', 'DOWN'].includes(direction)) {
      res.status(400).json({ error: 'direction must be "UP" or "DOWN"' });
      return;
    }

    // Validate amount
    if (typeof amount !== 'number' || isNaN(amount)) {
      res.status(400).json({ error: 'amount must be a number' });
      return;
    }
    if (amount < MIN_BET) {
      res.status(400).json({ error: `Minimum bet is ${MIN_BET} credits` });
      return;
    }
    if (amount > MAX_BET) {
      res.status(400).json({ error: `Maximum bet is ${MAX_BET} credits` });
      return;
    }

    // Check market is open
    if (!isBettingOpen()) {
      res.status(400).json({ error: 'Betting is only open during market hours (9:30 AM - 4:00 PM ET, weekdays)' });
      return;
    }

    // Get current round
    const roundId = getTodayRoundId();
    let round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(roundId) as any;

    if (!round) {
      // Create round on-the-fly if cron hasn't fired yet
      db.prepare('INSERT OR IGNORE INTO rounds (id, status) VALUES (?, ?)').run(roundId, 'open');
      round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(roundId);
    }

    if (round.status !== 'open') {
      res.status(400).json({ error: 'This round is no longer accepting bets' });
      return;
    }

    // Check balance
    const freshAgent = db.prepare('SELECT balance FROM agents WHERE id = ?').get(agent.id) as any;
    if (freshAgent.balance < amount) {
      res.status(400).json({ error: `Insufficient balance. You have ${freshAgent.balance} credits.` });
      return;
    }

    // Check one bet per day
    const existingBet = db.prepare('SELECT * FROM bets WHERE agent_id = ? AND round_id = ?').get(agent.id, roundId);
    if (existingBet) {
      res.status(400).json({ error: 'You already placed a bet today. One bet per day per agent.' });
      return;
    }

    // Place bet (transaction)
    const betId = uuidv4();
    const placeBet = db.transaction(() => {
      db.prepare('INSERT INTO bets (id, agent_id, round_id, direction, amount) VALUES (?, ?, ?, ?, ?)')
        .run(betId, agent.id, roundId, direction, amount);

      db.prepare('UPDATE agents SET balance = balance - ?, total_bets = total_bets + 1, last_bet_at = datetime(\'now\') WHERE id = ?')
        .run(amount, agent.id);

      const upDown = direction === 'UP' ? 'total_up_bets' : 'total_down_bets';
      const upDownCount = direction === 'UP' ? 'up_agent_count' : 'down_agent_count';
      db.prepare(`UPDATE rounds SET ${upDown} = ${upDown} + ?, ${upDownCount} = ${upDownCount} + 1 WHERE id = ?`)
        .run(amount, roundId);
    });

    placeBet();

    const updatedAgent = db.prepare('SELECT balance FROM agents WHERE id = ?').get(agent.id) as any;

    res.json({
      bet: {
        id: betId,
        direction,
        amount,
        roundId,
      },
      remainingBalance: updatedAgent.balance,
    });
  } catch (err: any) {
    if (err.message?.includes('UNIQUE constraint')) {
      res.status(400).json({ error: 'You already placed a bet today.' });
      return;
    }
    console.error('[Bet] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/today', requireAuth, (req: AuthRequest, res: Response) => {
  try {
    const roundId = getTodayRoundId();
    const bet = db.prepare('SELECT * FROM bets WHERE agent_id = ? AND round_id = ?').get(req.agent!.id, roundId) as any;

    if (!bet) {
      res.json({ bet: null });
      return;
    }

    res.json({
      bet: {
        id: bet.id,
        direction: bet.direction,
        amount: bet.amount,
        result: bet.result,
        payout: bet.payout,
        createdAt: bet.created_at,
      },
    });
  } catch (err) {
    console.error('[Bet/Today] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/history', requireAuth, (req: AuthRequest, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const bets = db.prepare(`
      SELECT b.*, r.open_price, r.close_price, r.result as round_result
      FROM bets b
      JOIN rounds r ON r.id = b.round_id
      WHERE b.agent_id = ?
      ORDER BY b.created_at DESC
      LIMIT ? OFFSET ?
    `).all(req.agent!.id, limit, offset) as any[];

    res.json({
      bets: bets.map(b => ({
        id: b.id,
        roundId: b.round_id,
        direction: b.direction,
        amount: b.amount,
        result: b.result,
        payout: b.payout,
        roundResult: b.round_result,
        openPrice: b.open_price,
        closePrice: b.close_price,
        createdAt: b.created_at,
      })),
      count: bets.length,
      offset,
    });
  } catch (err) {
    console.error('[Bet/History] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
