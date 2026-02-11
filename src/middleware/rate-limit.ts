import rateLimit from 'express-rate-limit';

// 100 requests per minute per IP
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Limit: 100 per minute.' },
  keyGenerator: (req) => {
    // Use agent ID if authenticated, otherwise IP
    return (req as any).agent?.id || req.ip || 'unknown';
  },
});
