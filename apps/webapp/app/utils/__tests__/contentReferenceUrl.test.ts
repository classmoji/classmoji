import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildContentReferenceUrl, normalizeAssistantText } from '../contentReferenceUrl';

describe('buildContentReferenceUrl', () => {
  const page = { referenceType: 'page', contentPath: 'abc-123', displayText: 'Course Schedule' };

  it('builds a page link from the pagesUrl the server handed the widget', () => {
    expect(buildContentReferenceUrl(page, 'cs52', null, 'https://pages.example')).toBe(
      'https://pages.example/cs52/abc-123'
    );
  });

  it('renders no link, and does not guess one, when pagesUrl is absent', () => {
    expect(buildContentReferenceUrl(page, 'cs52', 'https://slides.example')).toBeNull();
  });

  it('still builds slide links from slidesUrl', () => {
    expect(
      buildContentReferenceUrl({ referenceType: 'slides', contentPath: 'd1' }, 'cs52', 'https://slides.example')
    ).toBe('https://slides.example/d1');
  });

  it('never reads process.env — this module runs in the browser', () => {
    const source = readFileSync(new URL('../contentReferenceUrl.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/process\.env\./);
  });
});

describe('normalizeAssistantText', () => {
  it('collapses an invented <referenced_content> tag to its title', () => {
    expect(
      normalizeAssistantText(
        'The <referenced_content id="f4" type="page" title="Term Demos">Term Demos</referenced_content> page covers it.'
      )
    ).toBe('The Term Demos page covers it.');
  });

  it('collapses [page:Title] to the title', () => {
    expect(normalizeAssistantText('According to the [page:Course Schedule], Exam 2 is on Oct 22.')).toBe(
      'According to the Course Schedule, Exam 2 is on Oct 22.'
    );
  });

  it('leaves ordinary markdown alone', () => {
    const md = '**Bold** and `code` and a [link](https://example.com) and [not a tag].';
    expect(normalizeAssistantText(md)).toBe(md);
  });
});
