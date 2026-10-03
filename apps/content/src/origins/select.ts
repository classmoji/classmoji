import { GitHubOrigin } from './github.ts';
import { GitLabOrigin } from './gitlab.ts';
import type { OriginAdapter, OriginRef } from './types.ts';

const github = new GitHubOrigin();
const gitlab = new GitLabOrigin();

/** The origin a classroom's token says its content lives on. */
export function originFor(ref: Pick<OriginRef, 'provider'>): OriginAdapter {
  return ref.provider === 'GITLAB' ? gitlab : github;
}
