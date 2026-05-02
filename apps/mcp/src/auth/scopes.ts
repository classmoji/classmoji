/**
 * Scope vocabulary for Classmoji's OAuth surface.
 *
 * Defined as `<resource>:<action>` pairs plus standard OIDC identity scopes
 * and convenience composites. See plan dreamy-shimmying-rossum.md Phase 0.6
 * for the full design.
 */

export const ALL_RESOURCE_SCOPES = [
  'assignments:read',
  'assignments:write',
  'modules:read',
  'modules:write',
  'grades:read',
  'grades:write',
  'calendar:read',
  'calendar:write',
  'roster:read',
  'roster:write',
  'content:read',
  'content:write',
  'quizzes:read',
  'quizzes:write',
  'tokens:read',
  'tokens:write',
  'teams:read',
  'teams:write',
  'regrade:read',
  'regrade:write',
  'settings:read',
  'settings:write',
  'feedback:read',
] as const;

export type ResourceScope = (typeof ALL_RESOURCE_SCOPES)[number];

const COMPOSITES: Record<string, readonly string[]> = {
  'mcp:full': ALL_RESOURCE_SCOPES,
  'mcp:readonly': ALL_RESOURCE_SCOPES.filter(s => s.endsWith(':read')),
};

/**
 * Expands a space-separated scope string into a Set of effective scopes.
 *
 * Composite scopes (`mcp:full`, `mcp:readonly`) expand to their member
 * resource scopes. Identity scopes (`openid`, `profile`, `email`,
 * `offline_access`) pass through unchanged.
 */
export function expandScopes(scopeString: string): Set<string> {
  const out = new Set<string>();
  for (const s of scopeString.split(/\s+/).filter(Boolean)) {
    const composite = COMPOSITES[s];
    if (composite) {
      for (const x of composite) out.add(x);
    } else {
      out.add(s);
    }
  }
  return out;
}

export function hasAnyScope(scopes: Set<string>, needed: readonly string[]): boolean {
  for (const s of needed) {
    if (scopes.has(s)) return true;
  }
  return false;
}
