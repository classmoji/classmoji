import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const findUniqueMock = vi.fn();
vi.mock('@classmoji/database', () => ({
  default: () => ({ gitLabInstance: { findUnique: (...a: unknown[]) => findUniqueMock(...a) } }),
}));

const svc = await import('../gitlabInstance.service.ts');

const ENV_KEYS = [
  'GITLAB_URL',
  'GITLAB_ISSUER',
  'GITLAB_CLIENT_ID',
  'GITLAB_CLIENT_SECRET',
  'GITLAB_WEBHOOK_URL',
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

beforeEach(() => {
  findUniqueMock.mockReset();
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('client secret encryption', () => {
  it('round-trips and never stores the plain secret', () => {
    const stored = svc.encryptSecret('gloas-secret');
    expect(stored).not.toContain('gloas-secret');
    expect(svc.decryptSecret(stored)).toBe('gloas-secret');
  });

  it('refuses a tampered value', () => {
    const stored = svc.encryptSecret('gloas-secret');
    const parts = stored.split('.');
    parts[3] = Buffer.from('other').toString('base64url');
    expect(() => svc.decryptSecret(parts.join('.'))).toThrow();
  });
});

describe('oauthClient', () => {
  it('uses env for the default instance', async () => {
    process.env.GITLAB_CLIENT_ID = 'cid';
    process.env.GITLAB_CLIENT_SECRET = 'cs';
    await expect(svc.oauthClient(null)).resolves.toEqual({
      instanceId: null,
      host: 'https://gitlab.com',
      clientId: 'cid',
      clientSecret: 'cs',
    });
  });

  it('uses the row (decrypted) for a self-managed instance', async () => {
    findUniqueMock.mockResolvedValueOnce({
      id: 'i1',
      host: 'https://gitlab.school.edu',
      client_id: 'school-cid',
      client_secret: svc.encryptSecret('school-cs'),
      disabled_at: null,
    });
    await expect(svc.oauthClient('i1')).resolves.toEqual({
      instanceId: 'i1',
      host: 'https://gitlab.school.edu',
      clientId: 'school-cid',
      clientSecret: 'school-cs',
    });
  });

  it('refuses a disabled instance unless a refresh asks', async () => {
    const row = {
      id: 'i1',
      host: 'https://gitlab.school.edu',
      client_id: 'c',
      client_secret: svc.encryptSecret('s'),
      disabled_at: new Date(),
    };
    findUniqueMock.mockResolvedValue(row);
    await expect(svc.oauthClient('i1')).rejects.toMatchObject({ code: 'disabled' });
    await expect(svc.oauthClient('i1', { allowDisabled: true })).resolves.toMatchObject({
      instanceId: 'i1',
    });
  });

  it('reports an unconfigured default instance', async () => {
    await expect(svc.oauthClient(null)).rejects.toMatchObject({ code: 'not_configured' });
  });
});

describe('webhookUrl', () => {
  it('is the same URL for every instance (hook-station reads the host from the payload)', () => {
    process.env.GITLAB_WEBHOOK_URL = 'https://hooks.example.com/webhooks/callback/gitlab/';
    expect(svc.webhookUrl(null)).toBe('https://hooks.example.com/webhooks/callback/gitlab');
    expect(svc.webhookUrl('i1')).toBe('https://hooks.example.com/webhooks/callback/gitlab');
  });

  it('is null when webhooks are not configured', () => {
    expect(svc.webhookUrl('i1')).toBeNull();
  });
});

describe('defaultHost', () => {
  it('reads GITLAB_ISSUER / GITLAB_URL, else gitlab.com', () => {
    expect(svc.defaultHost()).toBe('https://gitlab.com');
    process.env.GITLAB_URL = 'https://gitlab.internal.example.com/';
    expect(svc.defaultHost()).toBe('https://gitlab.internal.example.com');
  });
});
