import { useEffect, useState } from 'react';
import { GitlabLogo } from '~/components/ui/display/GitlabLogo';
import { useNavigate, useSearchParams } from 'react-router';
import { Alert, Button, Card, Form, Input, Select } from 'antd';

import { useGlobalFetcher } from '~/hooks';
import { ActionTypes } from '~/constants';
import { browserTimeZone } from '~/utils/browserTimeZone';
import { slugify } from './utils';
import type { GitLabOptions } from './gitlabOptions.server';

const CONNECT_URL = `/connect/gitlab?returnTo=${encodeURIComponent('/create-classroom?provider=gitlab')}`;

/** `?gitlab=` outcomes from the connect callback, in plain words. */
const CONNECT_OUTCOMES: Record<string, { type: 'success' | 'error' | 'warning'; text: string }> = {
  connected: { type: 'success', text: 'Gitlab connected.' },
  denied: { type: 'warning', text: 'Gitlab connection cancelled.' },
  missing_scope: {
    type: 'error',
    text: 'Gitlab did not grant API access. Try again and approve all requested permissions.',
  },
  invalid_state: { type: 'error', text: 'That Gitlab connection attempt expired. Try again.' },
  error: { type: 'error', text: 'Could not connect Gitlab. Try again.' },
};

/**
 * Create a classroom on GitLab. Mirrors the Github side: "Connect GitLab" is
 * the counterpart of installing the Github App, and the group picker is the
 * counterpart of the org picker. The classroom gets its own subgroup.
 */
const GitLabClassroomForm = ({
  gitlab,
  providerSwitch,
}: {
  gitlab: GitLabOptions;
  providerSwitch: React.ReactNode;
}) => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { fetcher, notify } = useGlobalFetcher();
  const [groupId, setGroupId] = useState<number | null>(gitlab.groups[0]?.id ?? null);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);

  const outcome = CONNECT_OUTCOMES[searchParams.get('gitlab') ?? ''];
  const data = fetcher!.data as { classroomSlug?: string; error?: string } | undefined;
  const submitting = fetcher!.state !== 'idle';
  const group = gitlab.groups.find(g => g.id === groupId);
  const slug = slugify(name);

  useEffect(() => {
    if (data?.classroomSlug) navigate(`/admin/${data.classroomSlug}/dashboard`);
  }, [data, navigate]);

  const submit = () => {
    notify(ActionTypes.CREATE_CLASSROOM, 'Creating classroom...');
    fetcher!.submit(
      { intent: 'create-gitlab', group_id: groupId, name, timezone: browserTimeZone() },
      { method: 'post', action: '/create-classroom', encType: 'application/json' }
    );
  };

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-xl font-semibold mb-6 dark:text-gray-100">Create New Classroom</h1>
      {providerSwitch}

      {outcome && (
        <Alert type={outcome.type} showIcon message={outcome.text} style={{ marginBottom: 16 }} />
      )}

      {!gitlab.connection ? (
        <Card>
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm font-semibold text-ink-0">Connect Gitlab</p>
            <p className="text-sm text-ink-3">
              Classmoji needs access to your Gitlab groups to create a subgroup for each class and
              its student projects. You approve this once on Gitlab; it works like installing the
              Github App.
            </p>
            <Button type="primary" href={CONNECT_URL} icon={<GitlabLogo size={16} />}>
              Connect Gitlab
            </Button>
          </div>
        </Card>
      ) : (
        <Card>
          <div className="flex items-center justify-between mb-5 text-sm text-ink-3">
            <span className="flex items-center gap-2">
              <GitlabLogo size={14} />
              Connected as @{gitlab.connection.username}
            </span>
            <a href={CONNECT_URL} className="text-xs font-medium text-accent hover:underline">
              Reconnect
            </a>
          </div>

          {gitlab.error ? (
            <Alert
              type="error"
              showIcon
              message="Gitlab refused the connection"
              description={`${gitlab.error} Reconnect Gitlab to continue.`}
            />
          ) : gitlab.groups.length === 0 ? (
            <Alert
              type="warning"
              showIcon
              message="No Gitlab groups available"
              description="You need to be an Owner or Maintainer of a Gitlab group. Create one on Gitlab, then reload this page."
            />
          ) : (
            <Form layout="vertical" component="div">
              <Form.Item label="Gitlab group" required>
                <Select
                  className="w-full"
                  placeholder="Pick a group"
                  value={groupId ?? undefined}
                  onChange={setGroupId}
                  options={gitlab.groups.map(g => ({ value: g.id, label: g.full_path }))}
                />
              </Form.Item>

              <Form.Item
                label="Classroom name"
                htmlFor="gitlab-class-name"
                required
                validateStatus={nameTouched && !slug ? 'error' : undefined}
                help={
                  nameTouched && !slug
                    ? 'Enter a classroom name with at least one letter or number'
                    : group &&
                      slug && (
                        <span>
                          Student projects will live in{' '}
                          <span className="font-mono">
                            {group.full_path}/{slug}
                          </span>
                        </span>
                      )
                }
              >
                <Input
                  id="gitlab-class-name"
                  placeholder="CS 10, Fall 2026"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  onBlur={() => setNameTouched(true)}
                />
              </Form.Item>

              {data?.error && (
                <Alert type="error" showIcon message={data.error} style={{ marginBottom: 16 }} />
              )}

              <div className="flex justify-end gap-3">
                <Button onClick={() => navigate('/select-organization')}>Cancel</Button>
                <Button
                  type="primary"
                  onClick={submit}
                  loading={submitting}
                  disabled={!groupId || !slug}
                >
                  Create classroom
                </Button>
              </div>
            </Form>
          )}
        </Card>
      )}
    </div>
  );
};

export default GitLabClassroomForm;
