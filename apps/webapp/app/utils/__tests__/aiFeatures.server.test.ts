import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { isAIAgentConfigured } from '../aiFeatures.server';

/**
 * isAIAgentConfigured() is the single source of truth for AI gating: root.tsx
 * passes its result as `aiAgentAvailable`, and CommonLayout hides the AI nav
 * items (`/quizzes`) when that flag is false. Asserting the util's contract
 * deterministically covers the hidden-nav path that the live (always-configured)
 * server cannot exercise.
 */

const ORIGINAL_URL = process.env.AI_AGENT_URL;
const ORIGINAL_SECRET = process.env.AI_AGENT_SHARED_SECRET;

describe('isAIAgentConfigured', () => {
  beforeEach(() => {
    delete process.env.AI_AGENT_URL;
    delete process.env.AI_AGENT_SHARED_SECRET;
  });

  afterEach(() => {
    if (ORIGINAL_URL === undefined) delete process.env.AI_AGENT_URL;
    else process.env.AI_AGENT_URL = ORIGINAL_URL;
    if (ORIGINAL_SECRET === undefined) delete process.env.AI_AGENT_SHARED_SECRET;
    else process.env.AI_AGENT_SHARED_SECRET = ORIGINAL_SECRET;
  });

  it('is false when neither env var is set (AI nav hidden)', () => {
    expect(isAIAgentConfigured()).toBe(false);
  });

  it('is false when only the URL is set', () => {
    process.env.AI_AGENT_URL = 'http://localhost:5000';
    expect(isAIAgentConfigured()).toBe(false);
  });

  it('is false when only the shared secret is set', () => {
    process.env.AI_AGENT_SHARED_SECRET = 'secret';
    expect(isAIAgentConfigured()).toBe(false);
  });

  it('is true only when both env vars are set (AI nav shown)', () => {
    process.env.AI_AGENT_URL = 'http://localhost:5000';
    process.env.AI_AGENT_SHARED_SECRET = 'secret';
    expect(isAIAgentConfigured()).toBe(true);
  });
});
