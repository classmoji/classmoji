import type { Request, Response, NextFunction } from 'express';

/**
 * In-memory token-bucket rate limiter, keyed per `(userId, toolName)`.
 *
 * Defaults: 300/min sustained, 600 burst (capacity). Per-tool overrides
 * tighten expensive endpoints (search, github_feedback, content reads).
 *
 * Single-VM only. When we go horizontal, move to Redis (Plan §Open Decisions).
 */

interface BucketCfg {
  capacity: number;
  refillPerSec: number;
}

const DEFAULT_CFG: BucketCfg = {
  capacity: 600,
  refillPerSec: 5, // 300/min
};

const TOOL_CFG: Record<string, BucketCfg> = {
  search_content: { capacity: 120, refillPerSec: 1 }, // 60/min
  github_feedback: { capacity: 60, refillPerSec: 0.5 }, // 30/min
  page_content_read: { capacity: 120, refillPerSec: 1 }, // 60/min
  slide_content_read: { capacity: 120, refillPerSec: 1 }, // 60/min
};

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

const buckets = new Map<string, BucketState>();

function consume(key: string, cfg: BucketCfg): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: cfg.capacity, lastRefillMs: now };
  const elapsedSec = (now - bucket.lastRefillMs) / 1000;
  bucket.tokens = Math.min(cfg.capacity, bucket.tokens + elapsedSec * cfg.refillPerSec);
  bucket.lastRefillMs = now;

  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    const retryAfterSec = Math.ceil((1 - bucket.tokens) / cfg.refillPerSec);
    return { allowed: false, retryAfterSec };
  }

  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return { allowed: true };
}

export function checkRateLimit(userId: string, toolName: string): { allowed: boolean; retryAfterSec?: number } {
  const cfg = TOOL_CFG[toolName] ?? DEFAULT_CFG;
  return consume(`${userId}:${toolName}`, cfg);
}

/**
 * Express-level rate limit on the /mcp endpoint itself (per-user, all tools).
 * Tool-specific limits are applied inside individual handlers via checkRateLimit.
 */
export function rateLimitMcpEndpoint(req: Request, res: Response, next: NextFunction): void {
  const userId = req.auth?.extra?.userId ?? req.ip ?? 'anonymous';
  const result = consume(`endpoint:${userId}`, DEFAULT_CFG);
  if (!result.allowed) {
    res.set('Retry-After', String(result.retryAfterSec ?? 60));
    res.status(429).json({ error: 'rate_limit_exceeded', retry_after: result.retryAfterSec });
    return;
  }
  next();
}
