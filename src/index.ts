import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

import './db'; // Initialize database
import { apiLimiter } from './middleware/rate-limit';
import authRoutes from './routes/auth';
import marketRoutes from './routes/market';
import bettingRoutes from './routes/betting';
import leaderboardRoutes from './routes/leaderboard';
import agentRoutes from './routes/agents';
import roundRoutes from './routes/rounds';
import { startCronJobs } from './cron';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(apiLimiter);

// Analytics
import { trackAnalytics } from './middleware/analytics';
app.use(trackAnalytics);

// Request logging
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// SSR homepage
import pageRoutes from './routes/pages';
app.use(pageRoutes);

// Serve static frontend (leaderboard, etc)
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/bet', bettingRoutes);
app.use('/api/leaderboard', leaderboardRoutes);
app.use('/api/agents', agentRoutes);
app.use('/api/me', (req, res, next) => {
  // Forward /api/me to agents router's /me handler
  req.url = '/me';
  agentRoutes(req, res, next);
});
app.use('/api/rounds', roundRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: Date.now() });
});

// Admin endpoint for external settlement (called by Mac mini cron)
import { settleRound, createDailyRound } from './services/settlement';
import { getTodayRoundId } from './services/market-state';
import db from './db';

const ADMIN_KEY = process.env.ADMIN_KEY || 'moltbets-admin-changeme';

app.post('/api/admin/settle', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const { openPrice, closePrice } = req.body;
  const roundId = getTodayRoundId();
  
  // Update round with provided prices
  if (openPrice) {
    db.prepare('UPDATE rounds SET open_price = ? WHERE id = ?').run(openPrice, roundId);
  }
  if (closePrice) {
    db.prepare('UPDATE rounds SET close_price = ? WHERE id = ? AND status != ?').run(closePrice, roundId, 'settled');
  }
  
  try {
    const result = await settleRound(roundId);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/create-round', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const { openPrice } = req.body;
  const roundId = getTodayRoundId();
  
  const existing = db.prepare('SELECT id FROM rounds WHERE id = ?').get(roundId);
  if (existing) {
    if (openPrice) {
      db.prepare('UPDATE rounds SET open_price = ? WHERE id = ?').run(openPrice, roundId);
    }
    res.json({ success: true, roundId, message: 'Round already exists, updated open price' });
    return;
  }
  
  db.prepare('INSERT INTO rounds (id, status, open_price) VALUES (?, ?, ?)').run(roundId, 'open', openPrice || null);
  res.json({ success: true, roundId });
});

app.post('/api/admin/reset-db', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  db.prepare('DELETE FROM bets').run();
  db.prepare('DELETE FROM sessions').run();
  db.prepare('DELETE FROM api_keys').run();
  db.prepare('DELETE FROM rounds').run();
  db.prepare('DELETE FROM agents').run();
  res.json({ success: true, message: 'All data wiped' });
});

app.get('/api/admin/analytics', (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const today = new Date().toISOString().split('T')[0];
  const stats = {
    today: {
      pageViews: (db.prepare("SELECT COUNT(*) as c FROM analytics WHERE event='page_view' AND created_at >= ?").get(today) as any).c,
      uniqueIPs: (db.prepare("SELECT COUNT(DISTINCT ip) as c FROM analytics WHERE event='page_view' AND created_at >= ?").get(today) as any).c,
      apiCalls: (db.prepare("SELECT COUNT(*) as c FROM analytics WHERE event='api_call' AND created_at >= ?").get(today) as any).c,
      registrations: (db.prepare("SELECT COUNT(*) as c FROM analytics WHERE event='registration_attempt' AND created_at >= ?").get(today) as any).c,
      bets: (db.prepare("SELECT COUNT(*) as c FROM analytics WHERE event='bet_attempt' AND created_at >= ?").get(today) as any).c,
    },
    allTime: {
      pageViews: (db.prepare("SELECT COUNT(*) as c FROM analytics WHERE event='page_view'").get() as any).c,
      uniqueIPs: (db.prepare("SELECT COUNT(DISTINCT ip) as c FROM analytics WHERE event='page_view'").get() as any).c,
      registrations: (db.prepare("SELECT COUNT(*) as c FROM analytics WHERE event='registration_attempt'").get() as any).c,
    },
    recentVisitors: db.prepare("SELECT ip, user_agent, path, created_at FROM analytics WHERE event='page_view' ORDER BY created_at DESC LIMIT 20").all(),
    totalAgents: (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c,
  };
  res.json(stats);
});

// Backfill historical rounds with realistic agent activity
app.post('/api/admin/backfill', (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { days } = req.body; // Array of {date, open, close, result}
  if (!days || !Array.isArray(days)) {
    res.status(400).json({ error: 'days array required' });
    return;
  }

  const agents = db.prepare('SELECT * FROM agents').all() as any[];
  if (agents.length === 0) {
    res.status(400).json({ error: 'No agents to backfill' });
    return;
  }

  const HOUSE_FEE = 0.05;
  const results: any[] = [];

  const backfill = db.transaction(() => {
    for (const day of days) {
      const roundId = day.date;
      
      // Skip if round already exists
      const existing = db.prepare('SELECT id FROM rounds WHERE id = ?').get(roundId);
      if (existing) {
        results.push({ date: roundId, skipped: true });
        continue;
      }

      // Pick random subset of agents (40-80% participate each day)
      const participationRate = 0.4 + Math.random() * 0.4;
      const shuffled = [...agents].sort(() => Math.random() - 0.5);
      const participating = shuffled.slice(0, Math.floor(agents.length * participationRate));

      let totalUpBets = 0, totalDownBets = 0;
      let upCount = 0, downCount = 0;
      const bets: any[] = [];

      for (const agent of participating) {
        // Bias direction slightly toward the actual result (60/40)
        const biasToResult = Math.random() < 0.55;
        const direction = biasToResult ? day.result : (day.result === 'UP' ? 'DOWN' : 'UP');
        const amount = (Math.floor(Math.random() * 10) + 1) * 50; // 50-500

        bets.push({ agentId: agent.id, direction, amount });
        if (direction === 'UP') { totalUpBets += amount; upCount++; }
        else { totalDownBets += amount; downCount++; }
      }

      // Create round
      db.prepare(`INSERT INTO rounds (id, status, open_price, close_price, result, 
        total_up_bets, total_down_bets, up_agent_count, down_agent_count, settled_at) 
        VALUES (?, 'settled', ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
        roundId, day.open, day.close, day.result,
        totalUpBets, totalDownBets, upCount, downCount
      );

      // Calculate payouts
      const totalPool = totalUpBets + totalDownBets;
      const winningPool = day.result === 'UP' ? totalUpBets : totalDownBets;
      const payoutPool = totalPool * (1 - HOUSE_FEE);
      const oneSided = totalUpBets === 0 || totalDownBets === 0;

      // Insert bets and update agents
      for (const bet of bets) {
        const betId = `bf-${roundId}-${bet.agentId.slice(0,8)}`;
        let betResult: string, payout: number, profit: number;

        if (oneSided) {
          betResult = 'push';
          payout = bet.amount;
          profit = 0;
        } else if (bet.direction === day.result) {
          betResult = 'win';
          payout = (bet.amount / winningPool) * payoutPool;
          profit = payout - bet.amount;
        } else {
          betResult = 'loss';
          payout = 0;
          profit = -bet.amount;
        }

        db.prepare(`INSERT INTO bets (id, agent_id, round_id, direction, amount, result, payout, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
          betId, bet.agentId, roundId, bet.direction, bet.amount, betResult, payout
        );

        // Update agent stats
        const isWin = betResult === 'win' ? 1 : 0;
        const isLoss = betResult === 'loss' ? 1 : 0;
        const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(bet.agentId) as any;
        const newStreak = isWin ? (agent.current_streak + 1) : 0;

        db.prepare(`UPDATE agents SET 
          balance = balance + ?,
          total_bets = total_bets + 1,
          total_wins = total_wins + ?,
          total_losses = total_losses + ?,
          total_profit = total_profit + ?,
          current_streak = ?,
          best_streak = MAX(best_streak, ?)
          WHERE id = ?`).run(
          profit, isWin, isLoss, profit, newStreak, Math.max(agent.best_streak, newStreak), bet.agentId
        );
      }

      results.push({
        date: roundId, result: day.result,
        agents: participating.length, upCount, downCount,
        pool: totalPool
      });
    }
  });

  try {
    backfill();
    res.json({ success: true, results });
  } catch (err: any) {
    console.error('[Backfill] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/push-price', async (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  // Store latest SPY price in a simple key-value
  const { price, open, marketState } = req.body;
  db.prepare(`INSERT OR REPLACE INTO kv (key, value) VALUES ('spy_price', ?)`).run(JSON.stringify({ price, open, marketState, updatedAt: Date.now() }));
  res.json({ success: true });
});

// Global error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
app.listen(PORT, () => {
  console.log(`[MoltBets] Server running on port ${PORT}`);
  startCronJobs();
});

export default app;
// cache bust 1770838702
