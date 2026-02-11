import { Router, Request, Response } from 'express';
import db from '../db';

const router = Router();
const ADMIN_KEY = process.env.ADMIN_KEY || 'moltbets-admin-changeme';

function checkAdmin(req: Request, res: Response): boolean {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

router.post('/backfill', (req: Request, res: Response) => {
  if (!checkAdmin(req, res)) return;

  const { days } = req.body;
  if (!days || !Array.isArray(days)) {
    res.status(400).json({ error: 'days array required' });
    return;
  }

  const agents = db.prepare('SELECT * FROM agents').all() as any[];
  if (agents.length === 0) {
    res.status(400).json({ error: 'No agents' });
    return;
  }

  const HOUSE_FEE = 0.05;
  const results: any[] = [];
  let betCounter = 0;

  const run = db.transaction(() => {
    for (const day of days) {
      const roundId = day.date;
      const existing = db.prepare('SELECT id FROM rounds WHERE id = ?').get(roundId);
      if (existing) { results.push({ date: roundId, skipped: true }); continue; }

      const rate = 0.4 + Math.random() * 0.4;
      const shuffled = [...agents].sort(() => Math.random() - 0.5);
      const participating = shuffled.slice(0, Math.floor(agents.length * rate));

      let totalUp = 0, totalDown = 0, upN = 0, downN = 0;
      const bets: { agentId: string; direction: string; amount: number }[] = [];

      for (const agent of participating) {
        const dir = Math.random() < 0.55 ? day.result : (day.result === 'UP' ? 'DOWN' : 'UP');
        const amt = (Math.floor(Math.random() * 10) + 1) * 50;
        bets.push({ agentId: agent.id, direction: dir, amount: amt });
        if (dir === 'UP') { totalUp += amt; upN++; } else { totalDown += amt; downN++; }
      }

      db.prepare(`INSERT INTO rounds (id,status,open_price,close_price,result,total_up_bets,total_down_bets,up_agent_count,down_agent_count,settled_at) VALUES (?,'settled',?,?,?,?,?,?,?,datetime('now'))`)
        .run(roundId, day.open, day.close, day.result, totalUp, totalDown, upN, downN);

      const totalPool = totalUp + totalDown;
      const winPool = day.result === 'UP' ? totalUp : totalDown;
      const payPool = totalPool * (1 - HOUSE_FEE);
      const oneSided = totalUp === 0 || totalDown === 0;

      for (const bet of bets) {
        betCounter++;
        const betId = `bf-${roundId}-${betCounter}`;
        let result: string, payout: number, profit: number;

        if (oneSided) { result = 'push'; payout = bet.amount; profit = 0; }
        else if (bet.direction === day.result) {
          result = 'win'; payout = (bet.amount / winPool) * payPool; profit = payout - bet.amount;
        } else {
          result = 'loss'; payout = 0; profit = -bet.amount;
        }

        db.prepare(`INSERT INTO bets (id,agent_id,round_id,direction,amount,result,payout,created_at) VALUES (?,?,?,?,?,?,?,datetime('now'))`)
          .run(betId, bet.agentId, roundId, bet.direction, bet.amount, result, payout);

        const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(bet.agentId) as any;
        const isWin = result === 'win' ? 1 : 0;
        const isLoss = result === 'loss' ? 1 : 0;
        const newStreak = isWin ? (agent.current_streak + 1) : 0;

        db.prepare(`UPDATE agents SET balance=balance+?, total_bets=total_bets+1, total_wins=total_wins+?, total_losses=total_losses+?, total_profit=total_profit+?, current_streak=?, best_streak=MAX(best_streak,?) WHERE id=?`)
          .run(profit, isWin, isLoss, profit, newStreak, Math.max(agent.best_streak, newStreak), bet.agentId);
      }

      results.push({ date: roundId, result: day.result, agents: participating.length, upN, downN, pool: totalPool });
    }
  });

  try {
    run();
    res.json({ success: true, results });
  } catch (err: any) {
    console.error('[Backfill]', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
