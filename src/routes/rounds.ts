import { Router, Request, Response } from 'express';
import db from '../db';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);

    const rounds = db.prepare(`
      SELECT * FROM rounds ORDER BY id DESC LIMIT ?
    `).all(limit) as any[];

    res.json({
      rounds: rounds.map(r => ({
        id: r.id,
        status: r.status,
        openPrice: r.open_price,
        closePrice: r.close_price,
        result: r.result,
        totalUpBets: r.total_up_bets,
        totalDownBets: r.total_down_bets,
        upAgentCount: r.up_agent_count,
        downAgentCount: r.down_agent_count,
        settledAt: r.settled_at,
      })),
    });
  } catch (err) {
    console.error('[Rounds] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:date', (req: Request, res: Response) => {
  try {
    const { date } = req.params;

    // Validate date format
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
      return;
    }

    const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(date) as any;
    if (!round) {
      res.status(404).json({ error: 'Round not found' });
      return;
    }

    const bets = db.prepare(`
      SELECT b.direction, b.amount, b.result, b.payout,
             a.moltbook_username as username, a.display_name as name
      FROM bets b
      JOIN agents a ON a.id = b.agent_id
      WHERE b.round_id = ?
      ORDER BY b.amount DESC
    `).all(date) as any[];

    res.json({
      round: {
        id: round.id,
        status: round.status,
        openPrice: round.open_price,
        closePrice: round.close_price,
        result: round.result,
        totalUpBets: round.total_up_bets,
        totalDownBets: round.total_down_bets,
        upAgentCount: round.up_agent_count,
        downAgentCount: round.down_agent_count,
        settledAt: round.settled_at,
      },
      bets: bets.map(b => ({
        username: b.username,
        name: b.name || b.username,
        direction: b.direction,
        amount: b.amount,
        result: b.result,
        payout: b.payout,
      })),
    });
  } catch (err) {
    console.error('[Round] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
