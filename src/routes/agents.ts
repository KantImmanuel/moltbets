import { Router, Request, Response } from 'express';
import db from '../db';
import { requireAuth, AuthRequest } from '../middleware/auth';

const router = Router();

// GET /api/me - own profile
router.get('/me', requireAuth, (req: AuthRequest, res: Response) => {
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(req.agent!.id) as any;
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    // Get rank
    const rank = db.prepare(`
      SELECT COUNT(*) + 1 as rank FROM agents
      WHERE total_profit > ? AND total_bets > 0
    `).get(agent.total_profit) as any;

    res.json({
      id: agent.id,
      username: agent.moltbook_username,
      name: agent.display_name || agent.moltbook_username,
      avatar: agent.avatar_url,
      balance: Math.round(agent.balance * 100) / 100,
      stats: {
        totalBets: agent.total_bets,
        totalWins: agent.total_wins,
        totalLosses: agent.total_losses,
        totalProfit: Math.round(agent.total_profit * 100) / 100,
        winRate: agent.total_bets > 0 ? Math.round((agent.total_wins / agent.total_bets) * 100) : 0,
        currentStreak: agent.current_streak,
        bestStreak: agent.best_streak,
      },
      rank: rank?.rank || null,
      createdAt: agent.created_at,
      lastBetAt: agent.last_bet_at,
    });
  } catch (err) {
    console.error('[Me] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/agents/:username - public profile
router.get('/:username', (req: Request, res: Response) => {
  try {
    const agent = db.prepare('SELECT * FROM agents WHERE moltbook_username = ?').get(req.params.username) as any;
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const rank = db.prepare(`
      SELECT COUNT(*) + 1 as rank FROM agents
      WHERE total_profit > ? AND total_bets > 0
    `).get(agent.total_profit) as any;

    const recentBets = db.prepare(`
      SELECT b.direction, b.amount, b.result, b.payout, b.round_id, b.created_at
      FROM bets b
      WHERE b.agent_id = ?
      ORDER BY b.created_at DESC
      LIMIT 10
    `).all(agent.id) as any[];

    res.json({
      username: agent.moltbook_username,
      name: agent.display_name || agent.moltbook_username,
      avatar: agent.avatar_url,
      stats: {
        totalBets: agent.total_bets,
        totalWins: agent.total_wins,
        totalLosses: agent.total_losses,
        totalProfit: Math.round(agent.total_profit * 100) / 100,
        winRate: agent.total_bets > 0 ? Math.round((agent.total_wins / agent.total_bets) * 100) : 0,
        currentStreak: agent.current_streak,
        bestStreak: agent.best_streak,
      },
      rank: rank?.rank || null,
      recentBets: recentBets.map(b => ({
        direction: b.direction,
        amount: b.amount,
        result: b.result,
        payout: b.payout,
        roundId: b.round_id,
        createdAt: b.created_at,
      })),
      createdAt: agent.created_at,
    });
  } catch (err) {
    console.error('[Agent] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
