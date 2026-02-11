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

export default router;
