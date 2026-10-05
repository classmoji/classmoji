/**
 * Remote carets in the live page editor.
 *
 * BlockNote's own caret (same DOM and classes), with one addition: an agent's
 * caret is marked `data-agent`, and the editor's stylesheet keeps its name
 * tag showing for as long as the agent is present. A person's tag shows only
 * while they move or type (`showCursorLabels: 'activity'`), but an agent moves
 * once per edit and renews its presence without moving, so with the same rule
 * its tag would vanish two seconds after each edit.
 */

import { splitAgentName, textOnColor } from '@classmoji/collab';

/** The awareness `user` a caret is drawn for. */
export interface CursorUser {
  name: string;
  color: string;
  agent?: unknown;
  [key: string]: unknown;
}

/** An agent editing through the collab server: flagged, or named "<name> (agent…)". */
export function isAgentCursorUser(user: Pick<CursorUser, 'name' | 'agent'>): boolean {
  return user.agent === true || splitAgentName(user.name ?? '').tag !== null;
}

/** BlockNote's caret markup, with `data-agent` on an agent's. */
export function renderLiveCursor(user: CursorUser, doc: Document = document): HTMLElement {
  const color = typeof user.color === 'string' && user.color ? user.color : '#6b7280';
  const style = `background-color: ${color}; color: ${textOnColor(color)}`;

  const base = doc.createElement('span');
  base.classList.add('bn-collaboration-cursor__base');
  if (isAgentCursorUser(user)) base.setAttribute('data-agent', '');

  const caret = doc.createElement('span');
  // BlockNote's own attribute, spelling included, so the caret behaves as theirs does.
  caret.setAttribute('contentedEditable', 'false');
  caret.classList.add('bn-collaboration-cursor__caret');
  caret.setAttribute('style', style);

  const label = doc.createElement('span');
  label.classList.add('bn-collaboration-cursor__label');
  label.setAttribute('style', style);
  label.append(doc.createTextNode(String(user.name ?? '')));

  caret.append(label);
  // Word joiners either side, as BlockNote does, so the caret never breaks a line.
  base.append(doc.createTextNode('⁠'), caret, doc.createTextNode('⁠'));
  return base;
}

/**
 * An agent's name tag, shown like BlockNote's active tag
 * (`[data-active] .bn-collaboration-cursor__label`) for as long as it is there.
 */
export const AGENT_CURSOR_LABEL_CSS = `
  .page-editor .bn-collaboration-cursor__base[data-agent] .bn-collaboration-cursor__label {
    border-radius: 3px 3px 3px 0;
    max-width: 20rem;
    max-height: 1.1rem;
    padding: 0.1rem 0.3rem;
    top: -17px;
    left: 0;
  }
`;
