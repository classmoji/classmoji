import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';

export interface LogFields {
  ts: string;
  level: 'info' | 'warn' | 'error';
  request_id?: string;
  session_id?: string;
  user_id?: string;
  access_token_id?: string;
  oauth_client_id?: string | null;
  classroom_slug?: string;
  method?: string;
  tool_name?: string;
  tool_method?: string;
  duration_ms?: number;
  status?: 'ok' | 'error';
  error?: string;
  msg?: string;
}

export function emitLog(fields: Omit<LogFields, 'ts' | 'level'> & { level?: LogFields['level']; msg?: string }): void {
  const line: LogFields = {
    ts: new Date().toISOString(),
    level: fields.level ?? 'info',
    ...fields,
  };
  if (process.env.NODE_ENV === 'production') {
    process.stdout.write(JSON.stringify(line) + '\n');
  } else {
    // Pretty in dev for human reading
    const { ts, level, ...rest } = line;
    process.stdout.write(`[${level}] ${ts} ${JSON.stringify(rest)}\n`);
  }
}

export function requestLogger(req: Request, _res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  (req as Request & { requestId?: string }).requestId = requestId;
  next();
}
