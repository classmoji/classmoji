import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  HighlightStyle,
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { html } from '@codemirror/lang-html';
import { tags as t } from '@lezer/highlight';

/**
 * CodeSourceEditor — a CodeMirror 6 editor for a block's source (html, or an
 * svg read as markup). Uncontrolled: `initialValue` is read once on mount;
 * every edit is reported through `onChange`. The theme follows `dark`
 * without rebuilding the editor.
 */

const lightTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#ffffff', color: '#1f2937', height: '100%' },
    '.cm-content': { caretColor: '#111827' },
    '.cm-gutters': {
      backgroundColor: '#f9fafb',
      color: '#9ca3af',
      borderRight: '1px solid #e5e7eb',
    },
    '.cm-activeLine': { backgroundColor: '#f3f4f6' },
    '.cm-activeLineGutter': { backgroundColor: '#f3f4f6', color: '#4b5563' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: '#dbeafe',
    },
    '.cm-tooltip': { backgroundColor: '#ffffff', border: '1px solid #e5e7eb' },
  },
  { dark: false }
);

const darkTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#111827', color: '#e5e7eb', height: '100%' },
    '.cm-content': { caretColor: '#f9fafb' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#f9fafb' },
    '.cm-gutters': {
      backgroundColor: '#0b1220',
      color: '#6b7280',
      borderRight: '1px solid #1f2937',
    },
    '.cm-activeLine': { backgroundColor: '#1f2937' },
    '.cm-activeLineGutter': { backgroundColor: '#1f2937', color: '#d1d5db' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: '#1e3a8a',
    },
    '.cm-matchingBracket': { backgroundColor: '#374151', outline: '1px solid #4b5563' },
    '.cm-tooltip': { backgroundColor: '#1f2937', border: '1px solid #374151', color: '#e5e7eb' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: '#1e3a8a',
      color: '#f9fafb',
    },
  },
  { dark: true }
);

const darkHighlight = HighlightStyle.define([
  { tag: [t.tagName, t.angleBracket], color: '#f472b6' },
  { tag: t.attributeName, color: '#fbbf24' },
  { tag: [t.attributeValue, t.string, t.special(t.string)], color: '#86efac' },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.modifier], color: '#c4b5fd' },
  { tag: [t.number, t.bool, t.null, t.atom], color: '#fdba74' },
  { tag: [t.comment, t.blockComment, t.lineComment], color: '#6b7280', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#93c5fd' },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: '#7dd3fc' },
  { tag: [t.className, t.typeName], color: '#fcd34d' },
  { tag: [t.variableName, t.definition(t.variableName)], color: '#e5e7eb' },
  { tag: [t.punctuation, t.separator, t.bracket], color: '#9ca3af' },
  { tag: t.invalid, color: '#f87171' },
]);

const themeFor = (dark: boolean) =>
  dark
    ? [darkTheme, syntaxHighlighting(darkHighlight)]
    : [lightTheme, syntaxHighlighting(defaultHighlightStyle)];

interface CodeSourceEditorProps {
  initialValue: string;
  onChange: (value: string) => void;
  dark: boolean;
  ariaLabel: string;
}

export default function CodeSourceEditor({
  initialValue,
  onChange,
  dark,
  ariaLabel,
}: CodeSourceEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeRef = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const darkRef = useRef(dark);
  darkRef.current = dark;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: initialValue,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          highlightActiveLine(),
          html(),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          themeRef.current.of(themeFor(darkRef.current)),
          EditorView.updateListener.of(update => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Mounted once per opened source: later initialValue changes are ignored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeRef.current.reconfigure(themeFor(dark)) });
  }, [dark]);

  return (
    <div
      ref={hostRef}
      className="h-full overflow-hidden rounded-md border border-gray-200 text-[13px] dark:border-gray-700 [&_.cm-editor]:h-full [&_.cm-editor.cm-focused]:outline-none [&_.cm-scroller]:font-mono"
    />
  );
}
