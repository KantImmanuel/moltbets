import { Router, Request, Response } from 'express';
import { getSpyQuote } from '../services/spy';
import { getMarketState, getTodayRoundId } from '../services/market-state';
import db from '../db';

const router = Router();

router.get('/', async (_req: Request, res: Response) => {
  try {
    const marketState = getMarketState();
    const roundId = getTodayRoundId();
    const round = db.prepare('SELECT * FROM rounds WHERE id = ?').get(roundId) as any;

    // Calculate live parimutuel odds
    const HOUSE_FEE = 0.05;
    let odds = null;
    if (round) {
      const totalPool = round.total_up_bets + round.total_down_bets;
      if (totalPool > 0 && round.total_up_bets > 0 && round.total_down_bets > 0) {
        const payoutPool = totalPool * (1 - HOUSE_FEE);
        odds = {
          upPayout: Math.round((payoutPool / round.total_up_bets) * 100) / 100,
          downPayout: Math.round((payoutPool / round.total_down_bets) * 100) / 100,
          houseFee: `${HOUSE_FEE * 100}%`,
        };
      }
    }

    let spy = null;
    try {
      spy = await getSpyQuote();
    } catch (err) {
      // Fallback to pushed price from admin
      try {
        const kv = db.prepare("SELECT value FROM kv WHERE key = 'spy_price'").get() as any;
        if (kv) spy = JSON.parse(kv.value);
      } catch {}
      if (!spy) console.error('[Market] SPY fetch error:', err);
    }

    res.json({
      state: marketState.state,
      nextEvent: marketState.nextEvent,
      nextEventTime: marketState.nextEventTime,
      spy,
      round: round ? {
        id: round.id,
        status: round.status,
        openPrice: round.open_price,
        closePrice: round.close_price,
        result: round.result,
        pool: {
          totalUpBets: round.total_up_bets,
          totalDownBets: round.total_down_bets,
          upAgentCount: round.up_agent_count,
          downAgentCount: round.down_agent_count,
          totalAgents: round.up_agent_count + round.down_agent_count,
          totalPool: round.total_up_bets + round.total_down_bets,
        },
      } : null,
      odds,
    });
  } catch (err) {
    console.error('[Market] Error:', err);
    res.status(500).json({ error: 'Failed to fetch market data' });
  }
});

// GET /api/market/signals — what are the top agents betting today?
router.get('/signals', (_req: Request, res: Response) => {
  try {
    const roundId = getTodayRoundId();

    // Top agents by profit who bet today
    const topBettors = db.prepare(`
      SELECT a.moltbook_username as name, a.total_profit as profit,
             a.current_streak as streak, a.total_wins as wins, a.total_bets as totalBets,
             b.direction, b.amount
      FROM bets b
      JOIN agents a ON b.agent_id = a.id
      WHERE b.round_id = ?
      ORDER BY a.total_profit DESC
      LIMIT 20
    `).all(roundId) as any[];

    // Streak leaders who bet today
    const streakBettors = db.prepare(`
      SELECT a.moltbook_username as name, a.current_streak as streak,
             a.total_profit as profit, b.direction, b.amount
      FROM bets b
      JOIN agents a ON b.agent_id = a.id
      WHERE b.round_id = ? AND a.current_streak >= 2
      ORDER BY a.current_streak DESC
      LIMIT 10
    `).all(roundId) as any[];

    // Consensus from top 20 most profitable agents (whether they bet today or not)
    const topAgentIds = db.prepare(`
      SELECT id FROM agents WHERE total_bets >= 3 ORDER BY total_profit DESC LIMIT 20
    `).all() as any[];
    
    const ids = topAgentIds.map((a: any) => a.id);
    let smartMoney = { up: 0, down: 0, notBet: 0 };
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const smartBets = db.prepare(`
        SELECT direction, COUNT(*) as c FROM bets 
        WHERE round_id = ? AND agent_id IN (${placeholders})
        GROUP BY direction
      `).all(roundId, ...ids) as any[];
      
      for (const b of smartBets) {
        if (b.direction === 'UP') smartMoney.up = b.c;
        else smartMoney.down = b.c;
      }
      smartMoney.notBet = ids.length - smartMoney.up - smartMoney.down;
    }

    // Recent round results (last 5 days)
    const recentRounds = db.prepare(`
      SELECT id, result, open_price, close_price 
      FROM rounds WHERE status = 'settled' 
      ORDER BY id DESC LIMIT 5
    `).all() as any[];

    res.json({
      roundId,
      topBettorsToday: topBettors.map(b => ({
        name: b.name,
        direction: b.direction,
        amount: b.amount,
        profit: Math.round(b.profit),
        streak: b.streak,
        winRate: b.totalBets > 0 ? Math.round((b.wins / b.totalBets) * 100) : 0,
      })),
      streakLeaders: streakBettors.map(b => ({
        name: b.name,
        direction: b.direction,
        streak: b.streak,
        profit: Math.round(b.profit),
      })),
      smartMoney: {
        top20ProfitableAgents: {
          bettingUp: smartMoney.up,
          bettingDown: smartMoney.down,
          notYetBet: smartMoney.notBet,
        },
      },
      recentResults: recentRounds.map(r => ({
        date: r.id,
        result: r.result,
        open: r.open_price,
        close: r.close_price,
      })),
    });
  } catch (err) {
    console.error('[Market/Signals] Error:', err);
    res.status(500).json({ error: 'Failed to fetch signals' });
  }
});

export default router;
