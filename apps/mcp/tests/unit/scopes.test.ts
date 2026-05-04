import { describe, expect, it } from 'vitest';
import { expandScopes, hasAnyScope, ALL_RESOURCE_SCOPES } from '../../src/auth/scopes.ts';

describe('expandScopes', () => {
  it('expands mcp:full into all resource scopes', () => {
    const scopes = expandScopes('mcp:full');
    for (const s of ALL_RESOURCE_SCOPES) {
      expect(scopes.has(s)).toBe(true);
    }
  });

  it('expands mcp:readonly into only :read resource scopes', () => {
    const scopes = expandScopes('mcp:readonly');
    expect(scopes.has('assignments:read')).toBe(true);
    expect(scopes.has('assignments:write')).toBe(false);
    expect(scopes.has('grades:read')).toBe(true);
    expect(scopes.has('grades:write')).toBe(false);
  });

  it('passes identity scopes through unchanged', () => {
    const scopes = expandScopes('openid profile email offline_access');
    expect(scopes.has('openid')).toBe(true);
    expect(scopes.has('profile')).toBe(true);
    expect(scopes.has('email')).toBe(true);
    expect(scopes.has('offline_access')).toBe(true);
  });

  it('handles empty input gracefully', () => {
    expect(expandScopes('').size).toBe(0);
    expect(expandScopes('   ').size).toBe(0);
  });

  it('mixes composites with literal scopes', () => {
    const scopes = expandScopes('openid mcp:readonly calendar:write');
    expect(scopes.has('openid')).toBe(true);
    expect(scopes.has('calendar:read')).toBe(true);
    expect(scopes.has('calendar:write')).toBe(true);
    expect(scopes.has('grades:write')).toBe(false);
  });

  it('accepts an already-tokenized array (matches string form)', () => {
    const fromArray = expandScopes(['openid', 'mcp:readonly']);
    const fromString = expandScopes('openid mcp:readonly');
    expect([...fromArray].sort()).toEqual([...fromString].sort());
  });
});

describe('hasAnyScope', () => {
  it('returns true if any needed scope is present', () => {
    const scopes = new Set(['calendar:read', 'openid']);
    expect(hasAnyScope(scopes, ['calendar:read'])).toBe(true);
    expect(hasAnyScope(scopes, ['grades:read', 'openid'])).toBe(true);
  });

  it('returns false if none match', () => {
    const scopes = new Set(['calendar:read']);
    expect(hasAnyScope(scopes, ['grades:write'])).toBe(false);
    expect(hasAnyScope(scopes, [])).toBe(false);
  });
});
