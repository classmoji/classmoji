/**
 * CollapsibleConsole - A collapsible wrapper for SandpackConsole
 *
 * Shows a compact header with message counts when collapsed.
 * Expands to show the full console when clicked.
 */

import { useState, useCallback } from 'react';
import { SandpackConsole } from '@codesandbox/sandpack-react';

type ConsoleMethod =
  | 'log'
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'table'
  | 'clear'
  | 'time'
  | 'timeEnd'
  | 'count'
  | 'assert';

interface ConsoleLogEntry {
  id: string;
  method: ConsoleMethod;
  data?: Array<string | Record<string, string>>;
}

type ConsoleData = ConsoleLogEntry[];

interface CollapsibleConsoleProps {
  defaultExpanded?: boolean;
  maxHeight?: number;
}

/**
 * CollapsibleConsole component
 */
export default function CollapsibleConsole({
  defaultExpanded = false,
  maxHeight = 150,
}: CollapsibleConsoleProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [logs, setLogs] = useState<ConsoleData>([]);

  // Track log changes to show counts in header
  const handleLogsChange = useCallback((newLogs: ConsoleData) => {
    setLogs(newLogs || []);
  }, []);

  // Count logs by type
  const errorCount = logs.filter(log => log.method === 'error').length;
  const warnCount = logs.filter(log => log.method === 'warn').length;
  const logCount = logs.filter(log => log.method === 'log' || log.method === 'info').length;
  const totalCount = logs.length;

  return (
    <div className="collapsible-console">
      {/* Header bar - always visible */}
      <button
        type="button"
        className="collapsible-console-header"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
      >
        <span className="collapsible-console-title">
          <svg
            className={`collapsible-console-chevron ${isExpanded ? 'expanded' : ''}`}
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="currentColor"
          >
            <path d="M4.5 2L8.5 6L4.5 10" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
          Console
        </span>

        <span className="collapsible-console-badges">
          {errorCount > 0 && (
            <span className="console-badge console-badge-error">{errorCount}</span>
          )}
          {warnCount > 0 && <span className="console-badge console-badge-warn">{warnCount}</span>}
          {logCount > 0 && <span className="console-badge console-badge-log">{logCount}</span>}
          {totalCount === 0 && <span className="console-badge console-badge-empty">No output</span>}
        </span>
      </button>

      {/* Console content - always mounted, visibility controlled by CSS */}
      <div
        className="collapsible-console-content"
        style={{
          height: isExpanded ? maxHeight : 0,
          overflow: 'hidden',
          transition: 'height 0.2s ease',
        }}
      >
        <SandpackConsole
          showHeader={false}
          onLogsChange={handleLogsChange}
          resetOnPreviewRestart
          style={{ height: maxHeight }}
        />
      </div>
    </div>
  );
}
