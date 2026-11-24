import { createReactBlockSpec, type ReactCustomBlockRenderProps } from '@blocknote/react';
import {
  COPY_BUTTON_CLASS,
  COPY_BUTTON_ICONS,
  COPY_LABEL,
  COPY_TOGGLE_CLASS,
  COPY_TOGGLE_ICONS,
  COPY_TOGGLE_LABEL,
  copyToggleTitle,
  flashCopied,
  guardControlEvents,
  isCopyable,
  terminalConfig,
  writeClipboardText,
} from '@classmoji/page-schema';
import { useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';
import { createHighlighterCore } from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import bash from '@shikijs/langs/bash';
import oneDarkPro from '@shikijs/themes/one-dark-pro';
import { terminalView } from './readOnlyGates.ts';
import { terminalCodeHtml } from './terminalHighlight.ts';

type TerminalRenderProps = ReactCustomBlockRenderProps<typeof terminalConfig>;

/**
 * A title-bar button that keeps the editor out of its events, exactly like the
 * code block's (`guardControlEvents`). Attached natively: React's synthetic
 * onMouseDown runs after ProseMirror's native listener has already moved the
 * selection.
 */
function TitleBarButton(props: ButtonHTMLAttributes<HTMLButtonElement> & { icons: string }) {
  const { icons, ...rest } = props;
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => (ref.current ? guardControlEvents(ref.current) : undefined), []);
  return <button ref={ref} type="button" {...rest} dangerouslySetInnerHTML={{ __html: icons }} />;
}

/**
 * The title bar's copy control (page-schema copyControl.ts): editors toggle
 * the block's `copyable`, readers get a Copy button when it is on.
 */
function TerminalCopyControl({ editor, block }: Pick<TerminalRenderProps, 'editor' | 'block'>) {
  const copyable = isCopyable(block.props);
  if (editor.isEditable) {
    return (
      <TitleBarButton
        className={COPY_TOGGLE_CLASS}
        aria-label={COPY_TOGGLE_LABEL}
        aria-pressed={copyable}
        title={copyToggleTitle(copyable)}
        onClick={() => editor.updateBlock(block, { props: { copyable: !copyable } })}
        icons={COPY_TOGGLE_ICONS}
      />
    );
  }
  if (!copyable) return null;
  return (
    <TitleBarButton
      className={COPY_BUTTON_CLASS}
      aria-label={COPY_LABEL}
      title={COPY_LABEL}
      onClick={event => {
        const button = event.currentTarget;
        void writeClipboardText(block.props.code).then(ok => {
          if (ok) flashCopied(button);
        });
      }}
      icons={COPY_BUTTON_ICONS}
    />
  );
}

export const Terminal = createReactBlockSpec(terminalConfig, {
  toExternalHTML: function TerminalExternalHTML(props: TerminalRenderProps) {
    const code = props.block.props.code || '';
    const title = props.block.props.title || '';
    return (
      <div className="terminal-block">
        {title && <div className="terminal-title">{title}</div>}
        <pre>
          <code className="language-bash">{code}</code>
        </pre>
      </div>
    );
  },
  render: function TerminalRenderer(props: TerminalRenderProps) {
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const codeRef = useRef<HTMLDivElement>(null);
    const [isFocused, setIsFocused] = useState(false);

    // Auto-resize textarea when content changes, on mount, or when focused
    useEffect(() => {
      if (textareaRef.current && isFocused) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
      }
    }, [props.block.props.code, isFocused]);

    // Apply syntax highlighting with Shiki
    useEffect(() => {
      if (codeRef.current && !isFocused && props.block.props.code) {
        createHighlighterCore({
          langs: [bash],
          themes: [oneDarkPro],
          engine: createJavaScriptRegexEngine(),
        }).then(highlighter => {
          // Shiki's escaped HTML, without the theme background on the <pre>
          // (terminalHighlight.ts); the code text is never edited.
          const html = terminalCodeHtml(highlighter, props.block.props.code);
          if (codeRef.current) {
            codeRef.current.innerHTML = html;
          }
        });
      }
    }, [props.block.props.code, isFocused]);

    // A reader gets the code and never an editing box; a reader of an empty
    // terminal gets nothing (readOnlyGates.ts).
    const view = terminalView(props.editor.isEditable, props.block.props.code);
    if (view === 'nothing') return null;
    const editing = view === 'edit';

    return (
      <div className="terminal-block" contentEditable={false}>
        {/* Header with dots and title */}
        <div className="terminal-header">
          <div className="terminal-dots">
            <span className="dot dot-red"></span>
            <span className="dot dot-yellow"></span>
            <span className="dot dot-green"></span>
          </div>
          <span className="terminal-title">{props.block.props.title || 'Terminal'}</span>
          <TerminalCopyControl editor={props.editor} block={props.block} />
        </div>

        {/* Content area */}
        <div className="terminal-content" style={{ position: 'relative' }}>
          {/* Highlighted code display (shown when not focused) */}
          {!isFocused && props.block.props.code && (
            <div
              ref={codeRef}
              onClick={
                editing
                  ? () => {
                      setIsFocused(true);
                      // Focus textarea after state updates
                      setTimeout(() => textareaRef.current?.focus(), 0);
                    }
                  : undefined
              }
              style={{
                margin: 0,
                background: 'transparent',
                fontFamily: 'inherit',
                fontSize: 'inherit',
                lineHeight: 'inherit',
                padding: 0,
                overflow: 'auto',
                cursor: editing ? 'text' : undefined,
              }}
            />
          )}

          {/* Editable textarea (shown when focused or empty), authors only */}
          {editing && (
            <textarea
              ref={textareaRef}
              value={props.block.props.code}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                props.editor.updateBlock(props.block, {
                  props: { code: e.target.value },
                })
              }
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder="$ Enter terminal commands..."
              rows={1}
              style={{
                width: '100%',
                background: 'transparent',
                color: '#d4d4d4',
                border: 'none',
                outline: 'none',
                resize: 'none',
                fontFamily: 'inherit',
                fontSize: 'inherit',
                lineHeight: 'inherit',
                padding: 0,
                overflow: 'hidden',
                display: isFocused || !props.block.props.code ? 'block' : 'none',
              }}
              onInput={(e: React.FormEvent<HTMLTextAreaElement>) => {
                const target = e.currentTarget;
                target.style.height = 'auto';
                target.style.height = target.scrollHeight + 'px';
              }}
            />
          )}
        </div>
      </div>
    );
  },
});
