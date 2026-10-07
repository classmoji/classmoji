/**
 * Render tests for the background-work panel. apps/webapp has no
 * @testing-library, so the panel is rendered with react-dom/server and the
 * assertions run against the markup, as the other render tests here do.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OperationPanel, type PanelState } from '../OperationPanel';

const render = (state: PanelState, retry = false) =>
  renderToStaticMarkup(
    createElement(OperationPanel, {
      state,
      onClose: () => undefined,
      onRetry: retry ? () => undefined : undefined,
    })
  );

const base: PanelState = {
  title: 'Creating student repositories',
  status: 'running',
  done: 18,
  total: 42,
  current: 'Copying the template',
  noun: 'repositories',
  failures: [],
};

describe('OperationPanel', () => {
  it('shows progress while running', () => {
    const html = render(base);
    expect(html).toContain('Creating student repositories');
    expect(html).toContain('18 of 42 repositories');
    expect(html).toContain('Copying the template');
    expect(html).not.toContain('did not finish');
  });

  it('is one line when everything finished', () => {
    const html = render({
      ...base,
      title: 'Student repositories created',
      status: 'done',
      done: 42,
      current: undefined,
    });
    expect(html).toContain('42 of 42 repositories');
    expect(html).not.toContain('did not finish');
    expect(html).not.toContain('Retry');
  });

  it('groups failures by reason, with the count, the fix and Retry', () => {
    const html = render(
      {
        ...base,
        title: 'Student repositories created',
        status: 'done',
        done: 39,
        current: undefined,
        failures: [
          {
            key: 'permission_denied',
            title: 'Github refused access',
            fix: 'An org owner must let the Classmoji app add collaborators.',
            names: ['ada', 'alan'],
          },
          { key: 'github_unreachable', title: 'Github unreachable', names: ['grace'] },
        ],
      },
      true
    );
    expect(html).toContain('3 did not finish');
    expect(html).toContain('Github refused access · 2');
    expect(html).toContain('An org owner must let the Classmoji app add collaborators.');
    expect(html.match(/data-testid="operation-failure-group"/g)).toHaveLength(2);
    expect(html).toContain('Retry');
    // Names stay behind Show until asked for.
    expect(html).not.toContain('>ada<');
  });

  it('offers no Retry when the operation has none', () => {
    const html = render({
      ...base,
      status: 'done',
      failures: [{ key: 'unknown', title: 'Something went wrong', names: ['ada'] }],
    });
    expect(html).not.toContain('Retry');
    expect(html).toContain('Show');
  });

  it('says when it lost track', () => {
    expect(render({ ...base, status: 'lost' })).toContain('Lost track. Reload to check.');
  });
});
