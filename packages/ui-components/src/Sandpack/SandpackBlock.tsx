/**
 * SandpackBlock - Block editor component for webapp
 *
 * Used in the webapp's block-based editor for course content.
 * Wraps SandpackEmbed with block-specific controls and state management.
 */

import { useCallback } from 'react';
import SandpackEmbed from './SandpackEmbed.tsx';
import {
  SANDPACK_TEMPLATES,
  SANDPACK_THEMES,
  SANDPACK_LAYOUTS,
  DEFAULT_FILES,
} from './constants.ts';
interface SandpackBlockData {
  template?: string;
  theme?: string;
  layout?: string;
  files?: Record<string, string>;
  options?: {
    showTabs?: boolean;
    showLineNumbers?: boolean;
    showConsole?: boolean;
    readOnly?: boolean;
    visibleFiles?: string[] | null;
  };
}

interface SandpackBlockItem {
  data?: SandpackBlockData;
}

interface SandpackBlockProps {
  block: SandpackBlockItem;
  onChange: (block: SandpackBlockItem) => void;
  isSelected?: boolean;
  slideTheme?: string;
}

/**
 * SandpackBlock component for block editors
 */
export default function SandpackBlock({ block, onChange, isSelected = false, slideTheme }: SandpackBlockProps) {
  const data = block.data || {};
  const template = data.template ?? 'vanilla';
  const theme = data.theme ?? 'auto';
  const layout = data.layout ?? 'preview-right';
  const files: Record<string, string> = data.files ?? DEFAULT_FILES[template] ?? DEFAULT_FILES['vanilla'];
  const options = data.options ?? {};

  // Handle file changes from Sandpack
  const handleFilesChange = useCallback(
    (newFiles: Record<string, string>) => {
      onChange({
        ...block,
        data: {
          ...block.data,
          files: newFiles,
        },
      });
    },
    [block, onChange]
  );

  // Handle configuration changes
  const handleConfigChange = useCallback(
    (key: string, value: unknown) => {
      const newData = {
        ...block.data,
        [key]: value,
      };

      // If template changes, reset files to defaults
      if (key === 'template' && value !== template) {
        newData.files = DEFAULT_FILES[value as string] ?? DEFAULT_FILES['vanilla'];
      }

      onChange({
        ...block,
        data: newData,
      });
    },
    [block, onChange, template]
  );

  return (
    <div
      className={`sandpack-block ${isSelected ? 'sandpack-block-selected' : ''}`}
      style={{
        border: isSelected ? '2px solid #3b82f6' : '1px solid #e5e7eb',
        borderRadius: '8px',
        overflow: 'hidden',
      }}
    >
      {/* Block toolbar - shown when selected */}
      {isSelected && (
        <div
          style={{
            display: 'flex',
            gap: '8px',
            padding: '8px',
            backgroundColor: '#f9fafb',
            borderBottom: '1px solid #e5e7eb',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          {/* Template selector */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}>
            Template:
            <select
              value={template}
              onChange={e => handleConfigChange('template', e.target.value)}
              style={{
                padding: '2px 4px',
                fontSize: '12px',
                borderRadius: '4px',
                border: '1px solid #d1d5db',
              }}
            >
              {Object.values(SANDPACK_TEMPLATES).map(t => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          {/* Theme selector */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}>
            Theme:
            <select
              value={theme}
              onChange={e => handleConfigChange('theme', e.target.value)}
              style={{
                padding: '2px 4px',
                fontSize: '12px',
                borderRadius: '4px',
                border: '1px solid #d1d5db',
              }}
            >
              {Object.values(SANDPACK_THEMES).map(t => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>

          {/* Layout selector */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}>
            Layout:
            <select
              value={layout}
              onChange={e => handleConfigChange('layout', e.target.value)}
              style={{
                padding: '2px 4px',
                fontSize: '12px',
                borderRadius: '4px',
                border: '1px solid #d1d5db',
              }}
            >
              {Object.values(SANDPACK_LAYOUTS).map(l => (
                <option key={l.id} value={l.id}>
                  {l.label}
                </option>
              ))}
            </select>
          </label>

          {/* Show console toggle */}
          <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}>
            <input
              type="checkbox"
              checked={options.showConsole || false}
              onChange={e =>
                handleConfigChange('options', { ...options, showConsole: e.target.checked })
              }
            />
            Console
          </label>
        </div>
      )}

      {/* Sandpack component */}
      <SandpackEmbed
        template={template}
        theme={theme}
        layout={layout}
        files={files}
        options={options}
        onFilesChange={handleFilesChange}
        slideTheme={slideTheme}
      />
    </div>
  );
}
