import { useEditor, EditorContent } from '@tiptap/react';
import { useState, useCallback } from 'react';
import StarterKit from '@tiptap/starter-kit';
import { Extension } from '@tiptap/core';
import { Markdown } from '@tiptap/markdown';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import codemark from 'prosemirror-codemark';
import 'prosemirror-codemark/dist/codemark.css';
import { createLowlight } from 'lowlight';
import { Button, Select } from 'antd';
import { CodeOutlined, SendOutlined } from '@ant-design/icons';
import { useDarkMode } from '~/hooks';
import './ChatEditor.css';

// Import common language syntaxes
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import cpp from 'highlight.js/lib/languages/cpp';
import c from 'highlight.js/lib/languages/c';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import sql from 'highlight.js/lib/languages/sql';
import bash from 'highlight.js/lib/languages/bash';
import markdown from 'highlight.js/lib/languages/markdown';

// Create lowlight instance and register languages
const lowlight = createLowlight();
lowlight.register('javascript', javascript);
lowlight.register('typescript', typescript);
lowlight.register('python', python);
lowlight.register('java', java);
lowlight.register('cpp', cpp);
lowlight.register('c', c);
lowlight.register('html', xml);
lowlight.register('css', css);
lowlight.register('json', json);
lowlight.register('sql', sql);
lowlight.register('bash', bash);
lowlight.register('markdown', markdown);

// Codemark extension for better inline code cursor handling
// Shows a visual indicator when cursor is at the edge of inline code
const CodemarkExtension = Extension.create({
  name: 'codemark',
  addProseMirrorPlugins() {
    const codeMarkType = this.editor.schema.marks.code;
    if (!codeMarkType) return [];
    return codemark({ markType: codeMarkType });
  },
});

const ChatEditor = ({ onSubmit, placeholder, loading, disabled }) => {
  const [selectedLanguage, setSelectedLanguage] = useState('javascript');
  const [hasContent, setHasContent] = useState(false);
  const { isDarkMode } = useDarkMode();

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Enable markdown shortcuts for common formatting
        heading: { levels: [1, 2, 3] },  // # ## ###
        blockquote: true,                 // > quote
        bulletList: true,                 // * or - item
        orderedList: true,                // 1. item
        listItem: true,
        horizontalRule: false,
        codeBlock: false, // Keep disabled - use CodeBlockLowlight with syntax highlighting instead
      }),
      CodeBlockLowlight.configure({
        lowlight,
        defaultLanguage: 'javascript',
      }),
      CodemarkExtension, // Better cursor handling for inline code
      Markdown,
    ],
    content: '',
    onUpdate: ({ editor }) => {
      // Cheap check — no markdown serialization, just isEmpty from ProseMirror
      setHasContent(!editor.isEmpty);
    },
    editorProps: {
      attributes: {
        class: 'prose max-w-none focus:outline-hidden min-h-[120px] p-3',
      },
      handleKeyDown: (view, event) => {
        // Handle Tab key in code blocks
        if (event.key === 'Tab') {
          const { state } = view;
          const { $from } = state.selection;

          // Check if we're in a code block
          const isInCodeBlock = $from.parent.type.name === 'codeBlock';

          if (isInCodeBlock) {
            event.preventDefault();
            // Insert 2 spaces (or use '\t' for a real tab)
            const { tr } = state;
            tr.insertText('\t');
            view.dispatch(tr);
            return true;
          }
        }

        // Remove Enter to submit functionality - Enter now works normally
        return false;
      },
      handlePaste: (view, event) => {
        // Prevent pasting to stop students from copying solutions
        event.preventDefault();
        return true;
      },
    },
    placeholder,
  });

  const handleSend = useCallback(() => {
    if (!editor || editor.isEmpty) return;
    const markdown = editor.getMarkdown?.() || editor.getText() || '';
    const trimmed = markdown.trim();
    if (!trimmed) return;
    onSubmit?.(trimmed);
    editor.commands.clearContent();
    setHasContent(false);
  }, [editor, onSubmit]);

  const insertCodeBlock = (language = 'javascript') => {
    if (editor) {
      editor.chain().focus().toggleCodeBlock({ language }).run();
    }
  };

  const languages = [
    { value: 'javascript', label: 'JavaScript' },
    { value: 'typescript', label: 'TypeScript' },
    { value: 'python', label: 'Python' },
    { value: 'java', label: 'Java' },
    { value: 'cpp', label: 'C++' },
    { value: 'c', label: 'C' },
    { value: 'html', label: 'HTML' },
    { value: 'css', label: 'CSS' },
    { value: 'json', label: 'JSON' },
    { value: 'sql', label: 'SQL' },
    { value: 'bash', label: 'Bash' },
    { value: 'markdown', label: 'Markdown' },
  ];

  return (
    <div className={`border rounded-lg overflow-hidden ${isDarkMode ? 'border-gray-700' : ''}`}>
      {/* Minimal toolbar */}
      <div
        className={`border-b px-2 py-1 flex gap-2 items-center ${isDarkMode ? 'bg-gray-800 border-gray-700' : 'bg-gray-50'}`}
      >
        <Select
          size="small"
          value={selectedLanguage}
          style={{ width: 120 }}
          options={languages}
          onChange={setSelectedLanguage}
        />
        <Button
          size="small"
          icon={<CodeOutlined />}
          onClick={() => insertCodeBlock(selectedLanguage)}
          style={{
            backgroundColor: editor?.isActive('codeBlock') ? '#ffc53d' : '#fadb14',
            borderColor: editor?.isActive('codeBlock') ? '#ffc53d' : '#fadb14',
            color: '#000',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.backgroundColor = '#ffc53d';
            e.currentTarget.style.borderColor = '#ffc53d';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.backgroundColor = editor?.isActive('codeBlock')
              ? '#ffc53d'
              : '#fadb14';
            e.currentTarget.style.borderColor = editor?.isActive('codeBlock')
              ? '#ffc53d'
              : '#fadb14';
          }}
        >
          Insert Code
        </Button>
        <span className={`text-xs ml-auto ${isDarkMode ? 'text-gray-400' : 'text-gray-500'}`}>
          Click Send to submit your message
        </span>
      </div>

      {/* Editor content */}
      <EditorContent editor={editor} className={isDarkMode ? 'dark-editor' : ''} />

      {/* Send button */}
      <div className={`border-t px-2 py-1 flex justify-end ${isDarkMode ? 'border-gray-700' : ''}`}>
        <Button
          icon={<SendOutlined />}
          onClick={handleSend}
          loading={loading}
          disabled={!hasContent || loading || disabled}
          style={{
            backgroundColor: '#fadb14',
            borderColor: '#fadb14',
            color: '#000',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.backgroundColor = '#ffc53d';
            e.currentTarget.style.borderColor = '#ffc53d';
          }}
          onMouseLeave={e => {
            e.currentTarget.style.backgroundColor = '#fadb14';
            e.currentTarget.style.borderColor = '#fadb14';
          }}
        >
          Send
        </Button>
      </div>
    </div>
  );
};

export default ChatEditor;
