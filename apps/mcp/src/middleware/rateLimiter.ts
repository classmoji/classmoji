import type { Request, Response, NextFunction } from 'express';
import { ErrorCode, mcpError } from '../utils/errors.ts';
import type { AuthContext } from '../auth/context.ts';

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
 * Tool-specific limits are applied inside individual handlers via wrapToolHandler.
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

/**
 * Per-(userId, toolName) bucket check around a tool handler. The endpoint
 * limiter only sees "POST /mcp" since the tool name lives in the JSON-RPC
 * body, so this is what makes TOOL_CFG overrides actually fire.
 * On exhaustion, throws McpError with `retry_after` in `data`.
 */
export function wrapToolHandler<TArgs, TResult>(
  toolName: string,
  ctx: AuthContext,
  handler: (args: TArgs) => Promise<TResult>
): (args: TArgs) => Promise<TResult> {
  return async (args: TArgs) => {
    const r = checkRateLimit(ctx.userId, toolName);
    if (!r.allowed) {
      throw mcpError(
        `Rate limit exceeded for ${toolName}. Retry after ${r.retryAfterSec ?? 60}s.`,
        ErrorCode.InvalidRequest,
        { retry_after: r.retryAfterSec ?? 60, tool: toolName }
      );
    }
    return handler(args);
  };
}
