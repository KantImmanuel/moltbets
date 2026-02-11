import { Request, Response, NextFunction } from 'express';
import db from '../db';

export function trackAnalytics(req: Request, _res: Response, next: NextFunction): void {
  try {
    const path = req.path;
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
    const ua = req.headers['user-agent'] || 'unknown';

    let event = 'api_call';
    if (path === '/') event = 'page_view';
    else if (path === '/leaderboard.html') event = 'page_view';
    else if (path.startsWith('/api/auth/register')) event = 'registration_attempt';
    else if (path.startsWith('/api/bet')) event = 'bet_attempt';
    else if (path.startsWith('/api/admin')) { next(); return; } // don't track admin

    db.prepare('INSERT INTO analytics (event, path, ip, user_agent) VALUES (?, ?, ?, ?)')
      .run(event, path, ip, ua.substring(0, 500));
  } catch (err) {
    // Don't let analytics break the app
  }
  next();
}
