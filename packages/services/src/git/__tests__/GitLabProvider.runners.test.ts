import { describe, it, expect, vi } from 'vitest';
import { GitLabProvider } from '../GitLabProvider.ts';

/** A provider whose REST answers come from the given map (path prefix → response). */
function providerWith(runners: unknown, groupSetting = 'enabled', runnersOk = true) {
  const provider = new GitLabProvider('1', 'g', 'tok');
  vi.spyOn(provider, 'request').mockImplementation(async (path: string) =>
    path.includes('/runners')
      ? { ok: runnersOk, status: runnersOk ? 200 : 403, body: runners }
      : { ok: true, status: 200, body: { shared_runners_setting: groupSetting } }
  );
  return provider;
}

describe('GitLabProvider.ciRunnerAvailability', () => {
  it('is available with an online shared runner', async () => {
    const p = providerWith([{ runner_type: 'instance_type', active: true, status: 'online' }]);
    expect(await p.ciRunnerAvailability('cs/c1')).toBe('available');
  });

  it('ignores shared runners the group turned off', async () => {
    const p = providerWith(
      [{ runner_type: 'instance_type', active: true, status: 'online' }],
      'disabled_and_unoverridable'
    );
    expect(await p.ciRunnerAvailability('cs/c1')).toBe('none');
  });

  it('counts a group runner even with shared runners off, and reports it offline', async () => {
    const p = providerWith(
      [{ runner_type: 'group_type', active: true, status: 'offline' }],
      'disabled_and_overridable'
    );
    expect(await p.ciRunnerAvailability('cs/c1')).toBe('offline');
  });

  it('skips paused runners and says none when nothing is left', async () => {
    const p = providerWith([{ runner_type: 'group_type', paused: true, status: 'online' }]);
    expect(await p.ciRunnerAvailability('cs/c1')).toBe('none');
  });

  it('is unknown when Gitlab will not list runners', async () => {
    const p = providerWith(null, 'enabled', false);
    expect(await p.ciRunnerAvailability('cs/c1')).toBe('unknown');
  });
});
