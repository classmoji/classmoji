import { describe, expect, it } from 'vitest';

import {
  DEV_COLLAB_INTERNAL_SECRET,
  resolveCollabEnv,
  resolveCollabInternalSecret,
  resolveCollabUrls,
} from '../env.ts';

describe('resolveCollabInternalSecret', () => {
  it('uses the env value', () => {
    expect(resolveCollabInternalSecret({ COLLAB_INTERNAL_SECRET: ' s3 ' })).toBe('s3');
    expect(
      resolveCollabInternalSecret({ NODE_ENV: 'production', COLLAB_INTERNAL_SECRET: 'real' })
    ).toBe('real');
  });

  it('falls back to the dev secret only in development and test', () => {
    expect(resolveCollabInternalSecret({ NODE_ENV: 'development' })).toBe(
      DEV_COLLAB_INTERNAL_SECRET
    );
    expect(resolveCollabInternalSecret({ NODE_ENV: 'test' })).toBe(DEV_COLLAB_INTERNAL_SECRET);
    expect(resolveCollabInternalSecret({})).toBeNull();
    expect(resolveCollabInternalSecret({ NODE_ENV: 'staging' })).toBeNull();
    expect(resolveCollabInternalSecret({ NODE_ENV: 'production' })).toBeNull();
  });

  it('refuses the dev value and an empty value in production', () => {
    expect(
      resolveCollabInternalSecret({
        NODE_ENV: 'production',
        COLLAB_INTERNAL_SECRET: DEV_COLLAB_INTERNAL_SECRET,
      })
    ).toBeNull();
    expect(
      resolveCollabInternalSecret({ NODE_ENV: 'production', COLLAB_INTERNAL_SECRET: '  ' })
    ).toBeNull();
  });
});

describe('resolveCollabUrls', () => {
  it('falls back to localhost on COLLAB_PORT outside production', () => {
    expect(resolveCollabUrls({ COLLAB_PORT: '7710' })).toEqual({
      httpUrl: 'http://localhost:7710',
      wsUrl: 'ws://localhost:7710',
    });
    expect(resolveCollabUrls({})).toEqual({
      httpUrl: 'http://localhost:7700',
      wsUrl: 'ws://localhost:7700',
    });
  });

  it('derives the ws URL from COLLAB_URL and trims trailing slashes', () => {
    expect(
      resolveCollabUrls({ NODE_ENV: 'production', COLLAB_URL: 'https://collab.example/' })
    ).toEqual({
      httpUrl: 'https://collab.example',
      wsUrl: 'wss://collab.example',
    });
    expect(
      resolveCollabUrls({
        COLLAB_URL: 'http://internal:7700',
        COLLAB_WS_URL: 'wss://public.example/',
      })
    ).toEqual({ httpUrl: 'http://internal:7700', wsUrl: 'wss://public.example' });
  });

  it('is null in production without COLLAB_URL', () => {
    expect(resolveCollabUrls({ NODE_ENV: 'production', COLLAB_WS_URL: 'wss://x' })).toBeNull();
  });
});

describe('resolveCollabEnv', () => {
  it('needs both urls and a secret', () => {
    expect(resolveCollabEnv({ NODE_ENV: 'production', COLLAB_URL: 'https://c' })).toBeNull();
    expect(
      resolveCollabEnv({
        NODE_ENV: 'production',
        COLLAB_URL: 'https://c',
        COLLAB_INTERNAL_SECRET: 'k',
      })
    ).toEqual({ httpUrl: 'https://c', wsUrl: 'wss://c', secret: 'k' });
  });
});
