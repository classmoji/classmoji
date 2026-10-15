/**
 * The line of linked pages and decks under a coursework row (dashboard Up next,
 * Assignments page). Rendered on the server, outside the student shell, so a
 * page takes PageLink's new-tab branch; inside the shell PagePeekProvider makes
 * it the peek button (PageLink's own tests cover that).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import CourseworkMaterials, { type CourseworkMaterial } from '../CourseworkMaterials';

const PAGE: CourseworkMaterial = {
  kind: 'PAGE',
  id: 'p-1',
  title: 'Lab 2 spec',
  href: 'https://pages.test/intro-101/p-1',
};
const DECK: CourseworkMaterial = {
  kind: 'SLIDE',
  id: 's-1',
  title: 'Week 2 lecture',
  href: 'https://slides.test/s-1',
};

const render = (materials: CourseworkMaterial[]) =>
  renderToStaticMarkup(<CourseworkMaterials materials={materials} />);

describe('CourseworkMaterials', () => {
  it('links each page and deck by its title, in the order given, with an icon each', () => {
    const html = render([PAGE, DECK]);

    expect(html).toContain('>Lab 2 spec<');
    expect(html).toContain('>Week 2 lecture<');
    expect(html.indexOf('Lab 2 spec')).toBeLessThan(html.indexOf('Week 2 lecture'));
    expect(html.match(/<svg/g)).toHaveLength(2);
  });

  it('opens a page in the pages app and a deck in the slides app, both in a new tab', () => {
    const html = render([PAGE, DECK]);

    expect(html).toMatch(/<a href="https:\/\/pages\.test\/intro-101\/p-1" target="_blank"/);
    expect(html).toMatch(/<a href="https:\/\/slides\.test\/s-1" target="_blank" rel="noreferrer"/);
    // The whole title stays readable where the visible one is truncated.
    expect(html).toContain('title="Lab 2 spec"');
    expect(html).toContain('title="Week 2 lecture"');
  });

  it('draws nothing for no materials', () => {
    expect(render([])).toBe('');
  });
});
