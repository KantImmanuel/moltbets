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
