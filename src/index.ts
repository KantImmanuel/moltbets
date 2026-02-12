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
import adminRoutes from './routes/admin';
app.use('/api/admin', adminRoutes);
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
import { onchainEnabled, CONTRACT_ADDRESS, getOnchainPool, getWalletBalance } from './services/onchain';

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: Date.now(), onchain: onchainEnabled });
});

// Onchain info
app.get('/api/onchain', async (_req, res) => {
  const pool = await getOnchainPool();
  const ethBalance = await getWalletBalance();
  res.json({
    enabled: onchainEnabled,
    contract: CONTRACT_ADDRESS,
    network: 'base',
    basescan: `https://basescan.org/address/${CONTRACT_ADDRESS}`,
    pool,
    settlerEthBalance: ethBalance,
  });
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

// Recent registrations (for monitoring new signups)
app.get('/api/admin/recent-agents', (req, res) => {
  if (req.headers['x-admin-key'] !== ADMIN_KEY && req.query.key !== ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const hours = parseInt(req.query.hours as string) || 24;
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const agents = db.prepare(`
    SELECT a.id, a.moltbook_username as name, a.display_name, a.created_at, a.balance,
           a.total_bets, a.total_wins, a.total_profit
    FROM agents a 
    WHERE a.created_at >= ? 
    ORDER BY a.created_at DESC
  `).all(since);
  const seededCount = db.prepare("SELECT COUNT(*) as c FROM agents WHERE moltbook_id LIKE 'self_%'").get() as any;
  res.json({ 
    recent: agents, 
    count: agents.length,
    totalAgents: (db.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c,
    seededAgents: seededCount.c,
    since,
  });
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
// deploy 1770843461
