import { useState, useEffect, useMemo, useRef } from 'react';
import { useFetcher, useNavigate } from 'react-router';
import { namedAction } from 'remix-utils/named-action';
import { Button, Input, Modal, Form, Radio, Select } from 'antd';
import type { ButtonProps } from 'antd';

import { useGlobalFetcher, useDisclosure } from '~/hooks';
import { ClassmojiService, TeamServiceError } from '@classmoji/services';
import { ActionTypes } from '~/constants';
import { requireClassroomAdmin, assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TEAMS',
    action: 'view_new_team_form',
  });

  const tags = await ClassmojiService.organizationTag.findByClassroomId(classroom.id);

  return { tags };
};

const AdminNewTeam = ({ loaderData }: Route.ComponentProps) => {
  const { tags } = loaderData;

  const { fetcher, notify } = useGlobalFetcher();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [tagsList, setTagsList] = useState<string[]>([]);
  const [tagsError, setTagsError] = useState(false);

  // Tag creation has its own fetcher so it never collides with the create submit.
  const tagFetcher = useFetcher<{ tag?: { id: string; name: string }; error?: string }>();
  const [newTagName, setNewTagName] = useState('');
  const [createdTags, setCreatedTags] = useState<{ id: string; name: string }[]>([]);
  const creatingTag = tagFetcher.state !== 'idle';
  const tagCreateError = tagFetcher.state === 'idle' ? tagFetcher.data?.error : undefined;

  // Tags the classroom already had, plus any made here without leaving the form.
  const allTags = useMemo(
    () => [...tags, ...createdTags.filter(c => !tags.some(t => t.id === c.id))],
    [tags, createdTags]
  );

  const createTag = () => {
    const tagName = newTagName.trim();
    if (!tagName) return;
    tagFetcher.submit(
      { name: tagName },
      { method: 'post', encType: 'application/json', action: '?/createTag' }
    );
  };

  // A tag made here is selected straight away: every team needs one, so a
  // classroom without tags would otherwise be a dead end.
  useEffect(() => {
    if (tagFetcher.state !== 'idle') return;
    const created = tagFetcher.data?.tag;
    if (!created) return;
    setCreatedTags(prev => (prev.some(t => t.id === created.id) ? prev : [...prev, created]));
    setTagsList(prev => (prev.includes(created.id) ? prev : [...prev, created.id]));
    setTagsError(false);
    setNewTagName('');
  }, [tagFetcher.state, tagFetcher.data]);

  // 'closed' (Visible) is the default: the choice used to be ignored and every
  // team ended up visible, so this keeps the effective default unchanged now
  // that the radio actually reaches the database.
  const [visibility, setVisibility] = useState('closed');
  const [nameError, setNameError] = useState(false);

  const { show, close, visible } = useDisclosure();

  useEffect(() => {
    show();
  }, []);

  const createTeam = () => {
    const nameMissing = !name;
    const tagsMissing = tagsList.length === 0;
    setNameError(nameMissing);
    setTagsError(tagsMissing);
    if (nameMissing || tagsMissing) return;

    notify(ActionTypes.SAVE_TEAM, 'Creating team...');

    setSubmitting(true);
    fetcher!.submit(
      { name, tags: tagsList, visibility },
      { method: 'post', encType: 'application/json', action: '?/createTeam' }
    );
  };

  // Leave only once the create has round-tripped. Navigating away on the
  // same tick as submit() unmounted this route and cancelled the request, so
  // the team was never created (a fresh tab made it obvious: "back" was the
  // new-tab page). The fetcher can still read idle on the render right after
  // submit(), hence waiting for the idle→busy→idle transition.
  const [submitting, setSubmitting] = useState(false);
  const sawBusyRef = useRef(false);
  useEffect(() => {
    if (!submitting) return;
    if (fetcher!.state !== 'idle') {
      sawBusyRef.current = true;
      return;
    }
    if (!sawBusyRef.current) return;
    sawBusyRef.current = false;
    setSubmitting(false);
    const data = fetcher!.data as { error?: string } | undefined;
    if (data?.error) return; // the global fetcher surfaces it; keep the form open
    close();
    navigate(-1);
  }, [submitting, fetcher!.state, fetcher!.data, close, navigate]);

  return (
    <>
      <Modal
        open={visible}
        title="Create new team"
        okText="Create"
        okButtonProps={{ 'data-tour': 'teams-new-submit' } as unknown as ButtonProps}
        onOk={createTeam}
        onCancel={() => {
          close();
          navigate(-1);
        }}
      >
        <Form layout="vertical">
          <Form.Item
            label="Team name"
            required
            validateStatus={nameError ? 'error' : undefined}
            help={nameError ? 'Team name is required' : undefined}
          >
            <Input
              data-tour="teams-new-name"
              placeholder="Enter team name"
              onChange={e => setName(e.currentTarget.value)}
            />
          </Form.Item>

          <Form.Item
            label="Tags"
            required
            validateStatus={tagsError || tagCreateError ? 'error' : undefined}
            help={tagCreateError ?? (tagsError ? 'At least one tag is required' : undefined)}
          >
            <Select
              data-tour="teams-new-tags"
              mode="multiple"
              optionFilterProp="label"
              placeholder="Choose team tags…"
              value={tagsList}
              options={allTags.map(tag => ({ label: tag.name, value: tag.id }))}
              onChange={(next: string[]) => {
                setTagsList(next);
                if (next.length > 0) setTagsError(false);
              }}
              allowClear
              notFoundContent={
                <span className="text-sm text-ink-3">No team tags yet — type one below.</span>
              }
              popupRender={menu => (
                <>
                  {menu}
                  <div className="flex items-center gap-2 border-t border-line px-2 py-2">
                    <Input
                      size="small"
                      value={newTagName}
                      placeholder="New tag name"
                      aria-label="New team tag name"
                      disabled={creatingTag}
                      onChange={e => setNewTagName(e.target.value)}
                      onKeyDown={e => {
                        // No key reaches the Select: in multiple mode its own
                        // handler takes Backspace on an empty search as
                        // "remove the last chosen tag". Enter makes the tag
                        // rather than submitting the team.
                        e.stopPropagation();
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          createTag();
                        }
                      }}
                    />
                    <Button
                      size="small"
                      type="primary"
                      loading={creatingTag}
                      disabled={!newTagName.trim()}
                      onClick={createTag}
                    >
                      Add
                    </Button>
                  </div>
                </>
              )}
            />
          </Form.Item>

          <div>
            <p className="font-medium pb-2">Team visibility</p>

            <Radio.Group
              data-tour="teams-new-visibility"
              value={visibility}
              onChange={e => setVisibility(e.target.value)}
              className="flex flex-col gap-2"
            >
              <Radio value="secret">Secret - can only be seen by its members.</Radio>
              <Radio value="closed">
                Visible - can be seen by every member of this organization.
              </Radio>
            </Radio.Group>
          </div>
        </Form>
      </Modal>
    </>
  );
};

export const action = async ({ request, params }: Route.ActionArgs) => {
  const classSlug = params.class!;

  const { classroom, membership } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'TEAMS',
    action: 'create_team',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  const data = await request.json();
  const { name, visibility, tags } = data as {
    name: string;
    visibility?: string;
    tags?: string[];
  };

  return namedAction(request, {
    // Every team needs a tag, so tags are made where the team is. Upsert, so
    // re-entering a name that exists simply hands back that tag.
    async createTag() {
      const tagName = typeof name === 'string' ? name.trim() : '';
      if (!tagName) return { error: 'A tag name is required.' };
      try {
        const tag = await ClassmojiService.organizationTag.upsert(classroom.id, tagName);
        return { tag: { id: tag.id, name: tag.name } };
      } catch (error: unknown) {
        console.error('Tag create error:', error);
        return { error: 'Could not create the tag.' };
      }
    },

    async createTeam() {
      try {
        const { tagsFailed } = await ClassmojiService.teamAdmin.createTeam({
          classroomId: classroom.id,
          name,
          // The form's choice is now carried through to Team.is_visible instead
          // of being dropped — only "closed" (Visible) stores the team visible.
          // The flag is recorded and echoed back, but no read path gates on it
          // today, so the choice does not yet change who sees the team.
          isVisible: visibility === 'closed',
          tagIds: tags ?? [],
        });

        return {
          success:
            tagsFailed.length === 0
              ? 'Team created successfully'
              : `Team created, but ${tagsFailed.length} tag(s) could not be attached.`,
          action: ActionTypes.SAVE_TEAM,
        };
      } catch (error: unknown) {
        if (error instanceof TeamServiceError) {
          return { error: createErrorMessage(error, name), action: ActionTypes.SAVE_TEAM };
        }
        // A chosen tag deleted after the service checked it fails the tag write
        // (a foreign-key violation); the service has removed the provider team
        // again. The team was not created for want of a tag.
        if (isForeignKeyViolation(error)) {
          return { error: TAG_REQUIRED_MESSAGE, action: ActionTypes.SAVE_TEAM };
        }
        throw error;
      }
    },
  });
};

const TAG_REQUIRED_MESSAGE = 'A team needs at least one tag from this classroom.';

/** A Prisma foreign-key violation (P2003). */
const isForeignKeyViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2003';

const createErrorMessage = (error: TeamServiceError, name: string) => {
  switch (error.code) {
    case 'invalid_name':
      return 'Team name is required';
    case 'reserved_name':
      return `Team name "${name}" is reserved for classroom teams. Please choose a different name.`;
    case 'name_collision':
      return `A team named "${name}" already exists in this GitHub organization. Please choose a different name.`;
    case 'no_org_configured':
      return 'Git organization not configured';
    case 'tag_required':
      return TAG_REQUIRED_MESSAGE;
    default:
      return 'Could not create this team.';
  }
};

export default AdminNewTeam;
