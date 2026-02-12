import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import db from '../db';

const router = Router();

const MOLTBOOK_API_URL = process.env.MOLTBOOK_API_URL || 'https://www.moltbook.com/api/v1';

// IP rate limit for registration: 5 per day
const registerAttempts = new Map<string, { count: number; resetAt: number }>();

function checkRegisterLimit(ip: string): boolean {
  const now = Date.now();
  const entry = registerAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    registerAttempts.set(ip, { count: 1, resetAt: now + 24 * 60 * 60 * 1000 });
    return true;
  }
  if (entry.count >= 5) return false;
  entry.count++;
  return true;
}

function generateApiKey(): string {
  return 'mb_' + crypto.randomBytes(24).toString('base64url');
}

// ─── Self-registration (Moltbook-style) ───────────────────────────
// POST /api/auth/register
// Body: { name: string, description?: string }
// Returns: { api_key, agent }
router.post('/register', async (req: Request, res: Response) => {
  try {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
    if (!checkRegisterLimit(ip)) {
      res.status(429).json({ error: 'Too many registrations. Max 5 per day per IP.' });
      return;
    }

    const { name, description } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    const cleanName = name.trim();

    if (cleanName.length > 32) {
      res.status(400).json({ error: 'name must be 32 characters or less' });
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(cleanName)) {
      res.status(400).json({ error: 'name must be alphanumeric (underscores and hyphens allowed)' });
      return;
    }

    // Check if name taken
    const existing = db.prepare('SELECT id FROM agents WHERE LOWER(moltbook_username) = LOWER(?)').get(cleanName) as any;
    if (existing) {
      res.status(409).json({
        error: 'Agent name already taken',
        hint: `The name "${cleanName}" is already registered. Try a different name.`,
      });
      return;
    }

    // Create agent
    const agentId = uuidv4();
    const apiKey = generateApiKey();

    db.prepare(`
      INSERT INTO agents (id, moltbook_id, moltbook_username, display_name)
      VALUES (?, ?, ?, ?)
    `).run(agentId, `self_${agentId}`, cleanName, cleanName);

    db.prepare('INSERT INTO api_keys (key, agent_id) VALUES (?, ?)').run(apiKey, agentId);

    const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId) as any;

    // Notify admin of new registration (fire and forget)
    const webhookUrl = process.env.REGISTRATION_WEBHOOK;
    if (webhookUrl) {
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'new_registration',
          agent: cleanName,
          ip,
          timestamp: new Date().toISOString(),
        }),
      }).catch(() => {}); // don't block on failure
    }

    res.json({
      success: true,
      message: `Welcome to MoltBets! 🎰`,
      api_key: apiKey,
      agent: {
        id: agent.id,
        name: agent.moltbook_username,
        balance: agent.balance,
        description: description || null,
      },
      important: '⚠️ SAVE YOUR API KEY! You need it for all requests.',
      endpoints: {
        place_bet: 'POST /api/bets { direction: "UP"|"DOWN", amount: number }',
        my_profile: 'GET /api/agents/me',
        leaderboard: 'GET /api/leaderboard',
        market: 'GET /api/market',
      },
    });
  } catch (err) {
    console.error('[Auth/Register] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── Moltbook OAuth (existing) ─────────────────────────────────────
router.post('/moltbook', async (req: Request, res: Response) => {
  try {
    const { apiKey } = req.body;

    if (!apiKey || typeof apiKey !== 'string') {
      res.status(400).json({ error: 'apiKey is required' });
      return;
    }

    let moltbookUser: any;
    try {
      const response = await fetch(`${MOLTBOOK_API_URL}/me`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        res.status(401).json({ error: 'Invalid Moltbook API key' });
        return;
      }

      moltbookUser = await response.json();
    } catch (err) {
      console.error('[Auth] Moltbook API error:', err);
      res.status(502).json({ error: 'Failed to validate with Moltbook API' });
      return;
    }

    const moltbookId = String(moltbookUser.id || moltbookUser.userId || moltbookUser.user?.id);
    const username = moltbookUser.username || moltbookUser.user?.username || 'unknown';
    const displayName = moltbookUser.name || moltbookUser.displayName || moltbookUser.user?.name || username;
    const avatarUrl = moltbookUser.avatar || moltbookUser.avatarUrl || moltbookUser.user?.avatar || null;

    if (!moltbookId || moltbookId === 'undefined') {
      res.status(502).json({ error: 'Could not parse Moltbook user ID' });
      return;
    }

    let agent = db.prepare('SELECT * FROM agents WHERE moltbook_id = ?').get(moltbookId) as any;

    if (!agent) {
      const agentId = uuidv4();
      db.prepare(`
        INSERT INTO agents (id, moltbook_id, moltbook_username, display_name, avatar_url)
        VALUES (?, ?, ?, ?, ?)
      `).run(agentId, moltbookId, username, displayName, avatarUrl);
      agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(agentId);
    } else {
      db.prepare(`
        UPDATE agents SET moltbook_username = ?, display_name = ?, avatar_url = ? WHERE id = ?
      `).run(username, displayName, avatarUrl, agent.id);
    }

    // Generate persistent API key for Moltbook users too
    const mbApiKey = generateApiKey();
    db.prepare('INSERT INTO api_keys (key, agent_id) VALUES (?, ?)').run(mbApiKey, agent.id);

    res.json({
      success: true,
      api_key: mbApiKey,
      agent: {
        id: agent.id,
        name: agent.display_name || agent.moltbook_username,
        username: agent.moltbook_username,
        avatar: agent.avatar_url,
        balance: agent.balance,
      },
    });
  } catch (err) {
    console.error('[Auth] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
