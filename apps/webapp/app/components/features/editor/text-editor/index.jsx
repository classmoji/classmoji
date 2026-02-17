import { useEditor, EditorContent } from '@tiptap/react';
import { forwardRef, useImperativeHandle, useEffect, useRef } from 'react';
import StarterKit from '@tiptap/starter-kit';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableCell } from '@tiptap/extension-table-cell';
import { TextAlign } from '@tiptap/extension-text-align';
import { Link } from '@tiptap/extension-link';
import { Underline } from '@tiptap/extension-underline';
import { Color } from '@tiptap/extension-color';
import { Highlight } from '@tiptap/extension-highlight';
import './style.css';

const TextEditor = forwardRef(({ content, onUpdate, showTable }, ref) => {
  const isInitialLoad = useRef(true); // Add this line

  const editor = useEditor({
    extensions: [
      StarterKit,
      Table.configure({
        resizable: true,
      }),
      TableRow,
      TableHeader,
      TableCell,
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
      Link.configure({
        openOnClick: false,
      }),
      Underline,
      Color,
      Highlight,
    ],
    content: content || '',
    onUpdate: ({ editor }) => {
      onUpdate(editor.getHTML());
    },
  });

  // Update editor content when content prop changes
  useEffect(() => {
    if (editor && content !== undefined && content !== editor.getHTML()) {
      editor.commands.setContent(content || '');

      // Only position cursor at end on initial load, not on navigation back
      if (isInitialLoad.current && content) {
        setTimeout(() => {
          if (editor) {
            editor
              .chain()
              .focus()
              .command(({ tr, commands }) => {
                const docSize = tr.doc.content.size;
                return commands.setTextSelection(docSize);
              })
              .run();
          }
        }, 0);
      }

      // Mark that initial load is complete
      isInitialLoad.current = false;
    }
  }, [editor, content]);

  const handleTemplateInsert = template => {
    if (editor) {
      const isEmpty = editor.getText().trim() === '';
      const cleanTemplate = isEmpty ? template.trim() : template;

      if (isEmpty) {
        editor.chain().focus().clearContent().insertContent(cleanTemplate).run();
      } else {
        editor.chain().focus().insertContent(cleanTemplate).run();
      }
    }
  };

  // Expose the handleTemplateInsert function to parent components
  useImperativeHandle(ref, () => ({
    insertTemplate: handleTemplateInsert,
  }));

  const addLink = () => {
    const url = window.prompt('Enter URL:');
    if (url) {
      editor.chain().focus().setLink({ href: url }).run();
    }
  };

  if (!editor) {
    return null;
  }

  return (
    <div className="space-y-4">
      {/* Table Controls */}
      <div className="flex gap-2 mb-2 flex-wrap">
        {showTable && (
          <button
            type="button"
            onClick={() =>
              editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
            }
            className="px-3 py-2 bg-green-100 text-green-700 dark:bg-green-800 dark:text-green-300 rounded-md text-sm hover:bg-green-200 dark:hover:bg-green-700 transition-colors font-medium"
          >
            📊 Insert Table
          </button>
        )}

        {editor.isActive('table') && (
          <>
            <button
              onClick={() => editor.chain().focus().addColumnBefore().run()}
              className="px-2 py-1 bg-blue-100 text-blue-700 dark:bg-blue-800 dark:text-blue-300 rounded-sm text-xs hover:bg-blue-200 dark:hover:bg-blue-700"
            >
              + Col Before
            </button>
            <button
              onClick={() => editor.chain().focus().addColumnAfter().run()}
              className="px-2 py-1 bg-blue-100 text-blue-700 dark:bg-blue-800 dark:text-blue-300 rounded-sm text-xs hover:bg-blue-200 dark:hover:bg-blue-700"
            >
              + Col After
            </button>
            <button
              onClick={() => editor.chain().focus().addRowBefore().run()}
              className="px-2 py-1 bg-blue-100 text-blue-700 dark:bg-blue-800 dark:text-blue-300 rounded-sm text-xs hover:bg-blue-200 dark:hover:bg-blue-700"
            >
              + Row Above
            </button>
            <button
              onClick={() => editor.chain().focus().addRowAfter().run()}
              className="px-2 py-1 bg-blue-100 text-blue-700 dark:bg-blue-800 dark:text-blue-300 rounded-sm text-xs hover:bg-blue-200 dark:hover:bg-blue-700"
            >
              + Row Below
            </button>
            <button
              onClick={() => editor.chain().focus().deleteColumn().run()}
              className="px-2 py-1 bg-red-100 text-red-700 dark:bg-red-800 dark:text-red-300 rounded-sm text-xs hover:bg-red-200 dark:hover:bg-red-700"
            >
              Delete Column
            </button>
            <button
              onClick={() => editor.chain().focus().deleteRow().run()}
              className="px-2 py-1 bg-red-100 text-red-700 dark:bg-red-800 dark:text-red-300 rounded-sm text-xs hover:bg-red-200 dark:hover:bg-red-700"
            >
              Delete Row
            </button>
            <button
              onClick={() => editor.chain().focus().deleteTable().run()}
              className="px-2 py-1 bg-red-100 text-red-700 dark:bg-red-800 dark:text-red-300 rounded-sm text-xs hover:bg-red-200 dark:hover:bg-red-700"
            >
              Delete Table
            </button>
          </>
        )}
      </div>

      {/* Editor Container */}
      <div
        className="border rounded-lg overflow-scroll max-h-[65vh] dark:border-gray-600"
        onClick={() => editor?.commands.focus()}
      >
        {/* Toolbar */}
        <div className="border-b p-3 flex gap-1 flex-wrap bg-gray-50 dark:bg-gray-800 dark:border-gray-700">
          {/* Headings */}
          <div className="flex gap-1 border-r border-gray-300 dark:border-gray-600 pr-2 mr-2">
            <button
              onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
              className={`px-2 py-1 rounded text-sm font-semibold ${
                editor.isActive('heading', { level: 1 })
                  ? 'bg-blue-200 dark:bg-blue-700 dark:text-blue-100'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-300'
              }`}
            >
              H1
            </button>
            <button
              onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
              className={`px-2 py-1 rounded text-sm font-semibold ${
                editor.isActive('heading', { level: 2 })
                  ? 'bg-blue-200 dark:bg-blue-700 dark:text-blue-100'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-300'
              }`}
            >
              H2
            </button>
            <button
              onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
              className={`px-2 py-1 rounded text-sm font-semibold ${
                editor.isActive('heading', { level: 3 })
                  ? 'bg-blue-200 dark:bg-blue-700 dark:text-blue-100'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-300'
              }`}
            >
              H3
            </button>
          </div>

          {/* Text Formatting */}
          <div className="flex gap-1 border-r border-gray-300 dark:border-gray-600 pr-2 mr-2">
            <button
              onClick={() => editor.chain().focus().toggleBold().run()}
              className={`px-2 py-1 rounded text-sm ${
                editor.isActive('bold')
                  ? 'bg-gray-200 dark:bg-gray-600 dark:text-gray-100'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-300'
              }`}
            >
              <strong>B</strong>
            </button>
            <button
              onClick={() => editor.chain().focus().toggleItalic().run()}
              className={`px-2 py-1 rounded text-sm ${
                editor.isActive('italic')
                  ? 'bg-gray-200 dark:bg-gray-600 dark:text-gray-100'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-300'
              }`}
            >
              <em>I</em>
            </button>
            <button
              onClick={() => editor.chain().focus().toggleUnderline().run()}
              className={`px-2 py-1 rounded text-sm ${
                editor.isActive('underline')
                  ? 'bg-gray-200 dark:bg-gray-600 dark:text-gray-100'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-300'
              }`}
            >
              <u>U</u>
            </button>
            <button
              onClick={() => editor.chain().focus().toggleStrike().run()}
              className={`px-2 py-1 rounded text-sm ${
                editor.isActive('strike')
                  ? 'bg-gray-200 dark:bg-gray-600 dark:text-gray-100'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-300'
              }`}
            >
              <s>S</s>
            </button>
          </div>

          {/* Lists */}
          <div className="flex gap-1 border-r border-gray-300 dark:border-gray-600 pr-2 mr-2">
            <button
              onClick={() => editor.chain().focus().toggleBulletList().run()}
              className={`px-2 py-1 rounded text-sm ${
                editor.isActive('bulletList')
                  ? 'bg-gray-200 dark:bg-gray-600 dark:text-gray-100'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-300'
              }`}
            >
              • List
            </button>
            <button
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
              className={`px-2 py-1 rounded text-sm ${
                editor.isActive('orderedList')
                  ? 'bg-gray-200 dark:bg-gray-600 dark:text-gray-100'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-300'
              }`}
            >
              1. List
            </button>
          </div>

          {/* Alignment */}
          <div className="flex gap-1 border-r border-gray-300 dark:border-gray-600 pr-2 mr-2">
            <button
              onClick={() => editor.chain().focus().setTextAlign('left').run()}
              className={`px-2 py-1 rounded text-sm ${
                editor.isActive({ textAlign: 'left' })
                  ? 'bg-gray-200 dark:bg-gray-600 dark:text-gray-100'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-300'
              }`}
            >
              ⬅
            </button>
            <button
              onClick={() => editor.chain().focus().setTextAlign('center').run()}
              className={`px-2 py-1 rounded text-sm ${
                editor.isActive({ textAlign: 'center' })
                  ? 'bg-gray-200 dark:bg-gray-600 dark:text-gray-100'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-300'
              }`}
            >
              ↔
            </button>
            <button
              onClick={() => editor.chain().focus().setTextAlign('right').run()}
              className={`px-2 py-1 rounded text-sm ${
                editor.isActive({ textAlign: 'right' })
                  ? 'bg-gray-200 dark:bg-gray-600 dark:text-gray-100'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-300'
              }`}
            >
              ➡
            </button>
          </div>

          {/* Other */}
          <div className="flex gap-1">
            <button
              onClick={() => editor.chain().focus().toggleBlockquote().run()}
              className={`px-2 py-1 rounded text-sm ${
                editor.isActive('blockquote')
                  ? 'bg-gray-200 dark:bg-gray-600 dark:text-gray-100'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-300'
              }`}
            >
              Quote
            </button>
            <button
              onClick={addLink}
              className={`px-2 py-1 rounded text-sm ${
                editor.isActive('link')
                  ? 'bg-gray-200 dark:bg-gray-600 dark:text-gray-100'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-300'
              }`}
            >
              🔗 Link
            </button>
            <button
              onClick={() => editor.chain().focus().toggleHighlight().run()}
              className={`px-2 py-1 rounded text-sm ${
                editor.isActive('highlight')
                  ? 'bg-yellow-200 dark:bg-yellow-700 dark:text-yellow-100'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-700 dark:text-gray-300'
              }`}
            >
              🖍 Highlight
            </button>
          </div>
        </div>

        {/* Editor Content */}
        <div
          className="p-4 min-h-[250px] cursor-text dark:bg-gray-900"
          onClick={e => {
            // Only handle clicks on the wrapper div, not on content
            if (e.target === e.currentTarget) {
              editor
                ?.chain()
                .focus()
                .command(({ tr, commands }) => {
                  // Position cursor at the end of document
                  const docSize = tr.doc.content.size;
                  return commands.setTextSelection(docSize);
                })
                .run();
            }
          }}
        >
          <EditorContent editor={editor} className="prose max-w-none" />
        </div>
      </div>
    </div>
  );
});

TextEditor.displayName = 'TextEditor';

export default TextEditor;
