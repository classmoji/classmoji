/**
 * Check if the AI agent service is configured.
 * Returns false when running without the private ai-agent submodule (OSS scenario).
 */
export function isAIAgentConfigured() {
  return Boolean(process.env.AI_AGENT_URL && process.env.AI_AGENT_SHARED_SECRET);
}
