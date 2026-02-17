import { createReactBlockSpec } from '@blocknote/react';
import { useEffect, useRef, useState } from 'react';
import { createHighlighterCore } from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import bash from '@shikijs/langs/bash';
import oneDarkPro from '@shikijs/themes/one-dark-pro';

export const Terminal = createReactBlockSpec(
  {
    type: 'terminal',
    propSchema: {
      code: { default: '' },
      title: { default: '' },
    },
    content: 'none',
    toExternalHTML: (block) => {
      const code = block.props.code || '';
      const title = block.props.title || '';
      const content = [
        {
          type: 'pre',
          content: [
            {
              type: 'code',
              attrs: { class: 'language-bash' },
              content: [{ type: 'text', text: code }],
            },
          ],
        },
      ];

      if (title) {
        content.unshift({
          type: 'div',
          attrs: { class: 'terminal-title' },
          content: [{ type: 'text', text: title }],
        });
      }

      return {
        type: 'div',
        attrs: { class: 'terminal-block' },
        content,
      };
    },
  },
  {
    render: (props) => {
      const textareaRef = useRef(null);
      const codeRef = useRef(null);
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
          }).then((highlighter) => {
            let html = highlighter.codeToHtml(props.block.props.code, {
              lang: 'bash',
              theme: 'one-dark-pro',
            });
            // Remove background-color from the pre element to use terminal's background
            html = html.replace(/background-color:[^;]+;?/g, '');
            if (codeRef.current) {
              codeRef.current.innerHTML = html;
            }
          });
        }
      }, [props.block.props.code, isFocused]);

      return (
        <div className="terminal-block" contentEditable={false}>
          {/* Header with dots and title */}
          <div className="terminal-header">
            <div className="terminal-dots">
              <span className="dot dot-red"></span>
              <span className="dot dot-yellow"></span>
              <span className="dot dot-green"></span>
            </div>
            <span className="terminal-title">Terminal</span>
          </div>

          {/* Content area */}
          <div className="terminal-content" style={{ position: 'relative' }}>
            {/* Highlighted code display (shown when not focused) */}
            {!isFocused && props.block.props.code && (
              <div
                ref={codeRef}
                onClick={() => {
                  setIsFocused(true);
                  // Focus textarea after state updates
                  setTimeout(() => textareaRef.current?.focus(), 0);
                }}
                style={{
                  margin: 0,
                  background: 'transparent',
                  fontFamily: 'inherit',
                  fontSize: 'inherit',
                  lineHeight: 'inherit',
                  padding: 0,
                  overflow: 'auto',
                  cursor: 'text',
                }}
              />
            )}

            {/* Editable textarea (shown when focused or empty) */}
            <textarea
              ref={textareaRef}
              value={props.block.props.code}
              onChange={(e) =>
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
              onInput={(e) => {
                e.target.style.height = 'auto';
                e.target.style.height = e.target.scrollHeight + 'px';
              }}
            />
          </div>
        </div>
      );
    },
  }
);
