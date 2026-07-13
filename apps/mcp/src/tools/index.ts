/**
 * Tool manifest. Phase 2: add each new ToolDefinition here — registration
 * order is listing order. Registration runs once at startup and validates
 * definitions (unique names; role-gated tools must take a `classroom` arg).
 */

import { registerToolDefinition } from '../mcp/registry.ts';
import { whoamiTool } from './whoami.ts';

export function registerAllTools(): void {
  registerToolDefinition(whoamiTool);
}
