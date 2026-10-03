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
      approved_at: new Date('2026-01-01'),
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
      approved_at: new Date('2026-01-01'),
    };
    findUniqueMock.mockResolvedValue(row);
    await expect(svc.oauthClient('i1')).rejects.toMatchObject({ code: 'disabled' });
    await expect(svc.oauthClient('i1', { allowDisabled: true })).resolves.toMatchObject({
      instanceId: 'i1',
    });
  });

  it('refuses a pending instance, even for a refresh', async () => {
    findUniqueMock.mockResolvedValue({
      id: 'i1',
      host: 'https://gitlab.school.edu',
      client_id: 'c',
      client_secret: svc.encryptSecret('s'),
      disabled_at: null,
      approved_at: null,
    });
    await expect(svc.oauthClient('i1')).rejects.toMatchObject({ code: 'pending' });
    await expect(svc.oauthClient('i1', { allowDisabled: true })).rejects.toMatchObject({
      code: 'pending',
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

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '192.168.0.1',
    '100.64.0.1',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::7f00:1',
    '64:ff9b::7f00:1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::1',
    '2002:7f00:1::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
  ])('refuses %s', address => {
    expect(svc.isPrivateAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808'])(
    'allows %s',
    address => {
      expect(svc.isPrivateAddress(address)).toBe(false);
    }
  );
});

describe('webhookSecret', () => {
  it('differs per instance and is stable', () => {
    process.env.GITLAB_WEBHOOK_SECRET = 'shared';
    const a = svc.webhookSecret('11111111-1111-1111-1111-111111111111');
    const b = svc.webhookSecret('22222222-2222-2222-2222-222222222222');
    const d = svc.webhookSecret(null);
    expect(a).not.toBe(b);
    expect(a).not.toBe(d);
    expect(a).not.toBe('shared');
    expect(svc.webhookSecret('11111111-1111-1111-1111-111111111111')).toBe(a);
    delete process.env.GITLAB_WEBHOOK_SECRET;
    expect(svc.webhookSecret(null)).toBeNull();
  });
});
