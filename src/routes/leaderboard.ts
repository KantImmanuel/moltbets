import { Router, Request, Response } from 'express';
import db from '../db';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  try {
    const period = (req.query.period as string) || 'alltime';
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const mode = (req.query.mode as string) || 'all'; // 'all', 'play', 'real'
    const validMode = ['play', 'real'].includes(mode) ? mode : null;

    // For real-money leaderboard, use dedicated agent columns
    if (validMode === 'real' && period === 'alltime') {
      const agents = db.prepare(`
        SELECT id, moltbook_username as username, display_name as name, avatar_url as avatar,
               real_total_profit as profit, real_total_wins as wins, real_total_bets as total_bets,
               real_total_losses as losses, current_streak, best_streak, wallet_address
        FROM agents
        WHERE real_total_bets > 0
        ORDER BY real_total_profit DESC
        LIMIT ?
      `).all(limit) as any[];

      return res.json({
        period, mode: 'real',
        leaderboard: agents.map((a, i) => ({
          rank: i + 1, username: a.username, name: a.name || a.username, avatar: a.avatar,
          profit: Math.round((a.profit || 0) * 100) / 100,
          winRate: a.total_bets > 0 ? Math.round((a.wins / a.total_bets) * 100) : 0,
          currentStreak: a.current_streak || 0, bestStreak: a.best_streak || 0,
          totalBets: a.total_bets || 0, wallet: a.wallet_address,
        })),
      });
    }

    let query: string;
    let params: any[];

    if (period === 'daily') {
      const today = new Date().toISOString().split('T')[0];
      query = `
        SELECT a.id, a.moltbook_username as username, a.display_name as name, a.avatar_url as avatar,
               a.current_streak, a.best_streak, a.total_bets,
               COALESCE(SUM(CASE WHEN b.result = 'win' THEN b.payout - b.amount
                                  WHEN b.result = 'loss' THEN -b.amount
                                  ELSE 0 END), 0) as profit,
               COUNT(CASE WHEN b.result = 'win' THEN 1 END) as wins,
               COUNT(b.id) as period_bets
        FROM agents a
        LEFT JOIN bets b ON b.agent_id = a.id AND b.round_id = ?
        GROUP BY a.id
        HAVING period_bets > 0
        ORDER BY profit DESC
        LIMIT ?
      `;
      params = [today, limit];
    } else if (period === 'weekly') {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
      query = `
        SELECT a.id, a.moltbook_username as username, a.display_name as name, a.avatar_url as avatar,
               a.current_streak, a.best_streak, a.total_bets,
               COALESCE(SUM(CASE WHEN b.result = 'win' THEN b.payout - b.amount
                                  WHEN b.result = 'loss' THEN -b.amount
                                  ELSE 0 END), 0) as profit,
               COUNT(CASE WHEN b.result = 'win' THEN 1 END) as wins,
               COUNT(b.id) as period_bets
        FROM agents a
        LEFT JOIN bets b ON b.agent_id = a.id AND b.round_id >= ?
        GROUP BY a.id
        HAVING period_bets > 0
        ORDER BY profit DESC
        LIMIT ?
      `;
      params = [weekAgo, limit];
    } else {
      query = `
        SELECT id, moltbook_username as username, display_name as name, avatar_url as avatar,
               total_profit as profit, total_wins as wins, total_bets, total_losses as losses,
               current_streak, best_streak
        FROM agents
        WHERE total_bets > 0
        ORDER BY total_profit DESC
        LIMIT ?
      `;
      params = [limit];
    }

    const agents = db.prepare(query).all(...params) as any[];

    res.json({
      period,
      leaderboard: agents.map((a, i) => ({
        rank: i + 1,
        username: a.username,
        name: a.name || a.username,
        avatar: a.avatar,
        profit: Math.round((a.profit || 0) * 100) / 100,
        winRate: a.total_bets > 0 || a.period_bets > 0
          ? Math.round(((a.wins || 0) / (a.total_bets || a.period_bets || 1)) * 100)
          : 0,
        currentStreak: a.current_streak || 0,
        bestStreak: a.best_streak || 0,
        totalBets: a.total_bets || a.period_bets || 0,
      })),
    });
  } catch (err) {
    console.error('[Leaderboard] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/streaks', (_req: Request, res: Response) => {
  try {
    const agents = db.prepare(`
      SELECT moltbook_username as username, display_name as name, avatar_url as avatar,
             current_streak, best_streak, total_profit as profit, total_bets, total_wins as wins
      FROM agents
      WHERE current_streak > 0
      ORDER BY current_streak DESC, total_profit DESC
      LIMIT 50
    `).all() as any[];

    res.json({
      streaks: agents.map((a, i) => ({
        rank: i + 1,
        username: a.username,
        name: a.name || a.username,
        avatar: a.avatar,
        currentStreak: a.current_streak,
        bestStreak: a.best_streak,
        profit: Math.round(a.profit * 100) / 100,
        totalBets: a.total_bets,
        winRate: a.total_bets > 0 ? Math.round((a.wins / a.total_bets) * 100) : 0,
      })),
    });
  } catch (err) {
    console.error('[Streaks] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
