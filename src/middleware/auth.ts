import { Request, Response, NextFunction } from 'express';
import db from '../db';

export interface AuthRequest extends Request {
  agent?: {
    id: string;
    moltbook_id: string;
    moltbook_username: string;
    display_name: string;
    avatar_url: string;
    balance: number;
  };
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header. Use: Bearer <token>' });
    return;
  }

  const token = header.slice(7);

  // Try API key first (persistent, no expiry)
  const apiKeyRow = db.prepare(`
    SELECT a.*
    FROM api_keys k
    JOIN agents a ON a.id = k.agent_id
    WHERE k.key = ?
  `).get(token) as any;

  if (apiKeyRow) {
    req.agent = {
      id: apiKeyRow.id,
      moltbook_id: apiKeyRow.moltbook_id,
      moltbook_username: apiKeyRow.moltbook_username,
      display_name: apiKeyRow.display_name,
      avatar_url: apiKeyRow.avatar_url,
      balance: apiKeyRow.balance,
    };
    return next();
  }

  // Fall back to session tokens (legacy/Moltbook flow)
  const session = db.prepare(`
    SELECT s.agent_id, s.expires_at, a.*
    FROM sessions s
    JOIN agents a ON a.id = s.agent_id
    WHERE s.token = ?
  `).get(token) as any;

  if (!session) {
    res.status(401).json({ error: 'Invalid token. Register at POST /api/auth/register' });
    return;
  }

  if (new Date(session.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    res.status(401).json({ error: 'Token expired. Please re-authenticate.' });
    return;
  }

  req.agent = {
    id: session.id,
    moltbook_id: session.moltbook_id,
    moltbook_username: session.moltbook_username,
    display_name: session.display_name,
    avatar_url: session.avatar_url,
    balance: session.balance,
  };

  next();
}
