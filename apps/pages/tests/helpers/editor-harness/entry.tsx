/**
 * Browser entry for the unit suite's editor harness (`editorHarness.ts`): the
 * real `PageEditor`, alone on a page, optionally bound to a local Yjs
 * document (live editing). `window.__rerender()` re-renders its parent, the
 * way any state change in the page route does.
 */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { pageContentToYDoc } from '@classmoji/page-schema/server';

import PageEditor from '~/components/editor/PageEditor.tsx';

const text = (t: string) => [{ type: 'text', text: t, styles: {} }];
const blocks = [
  {
    id: 'a',
    type: 'paragraph',
    props: {},
    content: text('Double click a word in this sentence.'),
    children: [],
  },
  {
    id: 'b',
    type: 'paragraph',
    props: {},
    content: text('Another paragraph with more text.'),
    children: [],
  },
];

const live = new URLSearchParams(location.search).get('collab') === '1';
const collab = live
  ? (() => {
      const doc = pageContentToYDoc({ blocks } as never) as Y.Doc;
      return {
        doc,
        provider: { awareness: new Awareness(doc) },
        user: { id: 'u1', name: 'Tester', color: '#1f883d' },
      };
    })()
  : null;

function Page() {
  const [renders, setRenders] = useState(0);
  (window as unknown as { __rerender: () => void }).__rerender = () => setRenders(n => n + 1);
  return (
    <div className="site-article" style={{ width: 700, padding: 40 }} data-renders={renders}>
      <PageEditor
        initialContent={live ? null : blocks}
        pageId="page-1"
        darkMode={false}
        collab={collab as never}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
(window as unknown as { __ready: boolean }).__ready = true;
