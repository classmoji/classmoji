import { useEffect, useMemo, useRef, useState } from 'react';

import { useFetcher, useRevalidator } from 'react-router';
import { useCallout } from '@classmoji/ui-components';
import { useForm, type Control, type FieldValues } from 'react-hook-form';
import { FormItem } from 'react-hook-form-antd';
import {
  Form,
  InputNumber,
  Select,
  Input,
  Button,
  Tooltip,
  Modal,
  Alert,
  Card,
  DatePicker,
} from 'antd';
import { zodResolver } from '@hookform/resolvers/zod';
import { PlusOutlined } from '@ant-design/icons';
import { useDisclosure } from '@mantine/hooks';

import AsyncAutocomplete from './AsyncAutocomplete';
import ProjectTemplateSelect from './ProjectTemplateSelect';
import { schema } from './schema';
import { useGlobalFetcher } from '~/hooks';

import { useRepositoryFormStore } from './store';
import { SectionHeader } from '~/components';
import AutogradingTestsTable from './AutogradingTestsTable';
import FormAutogradingTest, {
  emptyAutogradingTest,
  type AutogradingTestData,
} from './FormAutogradingTest';
import dayjs from 'dayjs';
import { ActionTypes } from '~/constants';

interface ActionResponse {
  error?: string;
  success?: string;
  action?: string;
}

interface PageRef {
  id: string;
  title?: string | null;
}

interface SlideRef {
  id: string;
  title?: string | null;
}

interface TagRef {
  id: string;
  name: string;
}

interface ModuleData {
  id?: string;
  title?: string;
  template?: string;
  type?: string;
  tag_id?: string | null;
  is_published?: boolean;
  description?: string;
  team_formation_mode?: string;
  team_formation_deadline?: string | null;
  max_team_size?: number | null;
  project_template_id?: string | null;
  project_template_title?: string | null;
  pages?: Array<{ page?: PageRef }>;
  slides?: Array<{ slide?: SlideRef }>;
}

interface FormModuleProps {
  isNew: boolean;
  repository: ModuleData | null;
  close: () => void;
  tags: TagRef[];
  classroom: { slug: string; settings: Record<string, unknown>; [key: string]: unknown };
  pages?: PageRef[];
  slides?: SlideRef[];
  hasReposWithProjects?: boolean;
}

const FormModule = ({
  isNew,
  repository,
  close,
  tags,
  classroom,
  pages = [],
  slides = [],
  hasReposWithProjects = false,
}: FormModuleProps) => {
  const { template, setTemplate } = useRepositoryFormStore();

  const { fetcher, notify } = useGlobalFetcher();
  const revalidator = useRevalidator();
  const callout = useCallout();
  const [isSubmitting, setIsSubmitting] = useState(false);

  // State for repository-level linked pages and slides
  const [linkedPageIds, setLinkedPageIds] = useState(() => {
    return (
      repository?.pages?.map((link: { page?: PageRef }) => link.page?.id).filter(Boolean) || []
    );
  });
  const [linkedSlideIds, setLinkedSlideIds] = useState(() => {
    return (
      repository?.slides?.map((link: { slide?: SlideRef }) => link.slide?.id).filter(Boolean) || []
    );
  });

  // Autograding tests (managed locally; persisted with the repository on save).
  const [autogradingTests, setAutogradingTests] = useState<AutogradingTestData[]>(() =>
    (
      (repository as unknown as { autograding_tests?: AutogradingTestData[] })?.autograding_tests ??
      []
    ).map(test => ({ ...test }))
  );
  // Inline team-tag creation, so a group assignment doesn't send the instructor
  // off to Settings → Team mid-form.
  const tagFetcher = useFetcher<{ tag?: TagRef; error?: string }>();
  const [isNewTagOpen, setIsNewTagOpen] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [createdTags, setCreatedTags] = useState<TagRef[]>([]);
  const isCreatingTag = tagFetcher.state !== 'idle';

  // Loader revalidation lands after the fetcher resolves, so render tags we just
  // created ourselves too — selecting an id the Select has no option for would
  // leave the field looking empty.
  const tagOptions = useMemo(() => {
    const merged = [...tags];
    createdTags.forEach(createdTag => {
      if (!merged.some(existing => existing.id === createdTag.id)) merged.push(createdTag);
    });
    return merged;
  }, [tags, createdTags]);

  const [agOpened, { open: openAgModal, close: closeAgModal }] = useDisclosure();
  const [editingTest, setEditingTest] = useState<AutogradingTestData>(emptyAutogradingTest());
  const [editingTestIndex, setEditingTestIndex] = useState<number | null>(null);

  const openNewTest = () => {
    setEditingTest(emptyAutogradingTest());
    setEditingTestIndex(null);
    openAgModal();
  };
  const openEditTest = (index: number) => {
    setEditingTest({ ...autogradingTests[index] });
    setEditingTestIndex(index);
    openAgModal();
  };
  const removeTest = (index: number) =>
    setAutogradingTests(prev => prev.filter((_, i) => i !== index));
  const saveTest = () => {
    if (!editingTest.name.trim()) {
      callout.show({ variant: 'error', title: 'Please name the test.' });
      return;
    }
    setAutogradingTests(prev =>
      editingTestIndex === null
        ? [...prev, editingTest]
        : prev.map((test, i) => (i === editingTestIndex ? editingTest : test))
    );
    closeAgModal();
  };

  const updateFormDefaultValues = {
    id: repository?.id,
    title: repository?.title,
    template: repository?.template,
    type: repository?.type,
    tag: repository?.tag_id,
    description: repository?.description || '',
    team_formation_mode: repository?.team_formation_mode || 'INSTRUCTOR',
    team_formation_deadline: repository?.team_formation_deadline
      ? dayjs(repository.team_formation_deadline)
      : null,
    max_team_size: repository?.max_team_size || null,
    project_template_id: repository?.project_template_id || null,
    project_template_title: repository?.project_template_title || null,
    organization: classroom?.slug,
  };

  const newFormUpdateValues = {
    organization: classroom?.slug,
    type: 'INDIVIDUAL',
    description: '',
    team_formation_mode: 'INSTRUCTOR',
    team_formation_deadline: null,
    max_team_size: null,
    project_template_id: null,
    project_template_title: null,
  };

  const {
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(schema),
    defaultValues: isNew ? newFormUpdateValues : updateFormDefaultValues,
  });

  const type = watch('type');
  const teamFormationMode = watch('team_formation_mode');

  const closeNewTag = () => {
    setIsNewTagOpen(false);
    setNewTagName('');
  };

  const createTag = () => {
    const name = newTagName.trim();
    if (!name) {
      callout.show({ variant: 'error', title: 'Please enter a tag name.' });
      return;
    }

    tagFetcher.submit(
      { name },
      { action: '?/createTag', method: 'POST', encType: 'application/json' }
    );
  };

  // Select the tag once it comes back. The action upserts, so re-entering an
  // existing name simply selects that tag.
  useEffect(() => {
    if (tagFetcher.state !== 'idle' || !tagFetcher.data) return;

    const { tag: createdTag, error } = tagFetcher.data;
    if (error) {
      callout.show({ variant: 'error', title: error });
      return;
    }
    if (!createdTag) return;

    setCreatedTags(prev =>
      prev.some(existing => existing.id === createdTag.id) ? prev : [...prev, createdTag]
    );
    // shouldValidate re-runs the resolver, clearing 'Tag is required for
    // instructor-assigned teams.' if it was already showing.
    setValue('tag', createdTag.id, { shouldValidate: true, shouldDirty: true });
    closeNewTag();
  }, [tagFetcher.state, tagFetcher.data]);

  // Don't leave a half-typed tag behind when the mode that shows the field changes.
  useEffect(() => {
    closeNewTag();
  }, [type, teamFormationMode]);

  // Keyed on the id, not the object: a loader revalidation hands back a new
  // `repository` for the same record, and re-running this would stomp an unsaved
  // template pick with the persisted one.
  useEffect(() => {
    if (repository) setValue('template', repository.template);
  }, [repository?.id]);

  // Close after the save round-trips. The fetcher can still read `idle` on the
  // render right after `submit()` (the router discovers the route first), so
  // waiting for the idle→busy→idle transition is what makes this safe; keying
  // on `isSubmitting` alone closed the form before the request left.
  const sawBusyRef = useRef(false);
  useEffect(() => {
    if (!isSubmitting) return;
    if (fetcher!.state !== 'idle') {
      sawBusyRef.current = true;
      return;
    }
    if (sawBusyRef.current) {
      sawBusyRef.current = false;
      setIsSubmitting(false);

      const fetcherData = fetcher!.data as ActionResponse | undefined;
      if (fetcherData?.error) {
        callout.show({
          variant: 'error',
          title: fetcherData.error || 'Failed to save repository.',
        });
        return;
      }

      revalidator.revalidate();
      close();
    }
  }, [fetcher!.state, isSubmitting, close, revalidator]);

  // Keep the form's template field in step with the picker.
  useEffect(() => {
    if (template || repository?.template) {
      setValue('template', template || repository?.template);
    }
  }, [template, repository?.template]);

  const serializeDates = (data: Record<string, unknown>) => {
    const serialized = { ...data } as Record<string, unknown>;

    if (dayjs.isDayjs(serialized.team_formation_deadline)) {
      serialized.team_formation_deadline = serialized.team_formation_deadline.toISOString();
    }

    return serialized;
  };

  const onSubmit = (data: Record<string, unknown>) => {
    const message = isNew ? 'Creating repository...' : 'Updating repository...';

    notify(ActionTypes.SAVE_ASSIGNMENT, message);
    setIsSubmitting(true);

    const serializedData = serializeDates(data);

    fetcher!.submit(
      JSON.stringify({
        ...serializedData,
        linkedPageIds: linkedPageIds.filter((id): id is string => id != null),
        linkedSlideIds: linkedSlideIds.filter((id): id is string => id != null),
        autogradingTests,
      }),
      {
        method: 'post',
        action: isNew ? '?/create' : '?/update',
        encType: 'application/json',
      }
    );
  };

  return (
    <div className="space-y-6">
      {Object.keys(errors).length > 0 && (
        <div>
          <Alert
            type="error"
            message="Please check the highlighted fields and correct any issues."
            showIcon
            className="mb-4"
          />

          <div className="space-y-2 text-red-500">
            {Object.entries(errors).map(([field, error]) => {
              if (Array.isArray(error)) {
                return (
                  <div key={field}>
                    <strong>{field}:</strong>
                    {error.map((item, index) => (
                      <div key={index} className="ml-4 mt-1">
                        <strong>
                          Item
                          {index + 1}:
                        </strong>
                        {Object.entries(item || {}).map(([subField, subError]) => (
                          <div key={subField} className="ml-4">
                            <strong>{subField}:</strong>{' '}
                            {(subError as { message?: string })?.message || 'Invalid value'}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                );
              }
              return (
                <div key={field}>
                  <strong>{field}:</strong> {(error?.message as string) || 'Invalid value'}{' '}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <Form onFinish={handleSubmit(onSubmit)} layout="vertical">
        <div className="flex flex-col gap-6">
          {/* Basic Information */}
          <Card className="shadow-xs mb-6">
            <SectionHeader
              title="Basic Information"
              subtitle="Set up the core details for this repository"
              size="md"
              className="mb-4"
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormItem
                {...{
                  control,
                  name: 'title',
                  label: 'Repository title',
                  placeholder: 'intro-to-data-structures',
                }}
              >
                <Input
                  data-tour="repos-form-title"
                  placeholder="React fundamentals"
                  onChange={e => {
                    const value = e.target.value.toLowerCase().replace(/\s/g, '-');
                    setValue('title', value);
                  }}
                />
              </FormItem>

              <FormItem control={control} name="type" label="Type">
                <Select data-tour="repos-form-type" className="w-full" placeholder="Select type">
                  <Select.Option value="INDIVIDUAL">Individual</Select.Option>
                  <Select.Option value="GROUP">Group</Select.Option>
                </Select>
              </FormItem>
            </div>
          </Card>

          {type === 'GROUP' && (
            <Card className="shadow-xs mb-6">
              <SectionHeader
                title="Team Settings"
                subtitle="Configure how teams are formed for this group assignment"
                size="md"
                className="mb-4"
              />

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <FormItem control={control} name="team_formation_mode" label="Team Formation">
                  <Select className="w-full" placeholder="Select formation mode">
                    <Select.Option value="INSTRUCTOR">Instructor Assigned</Select.Option>
                    <Select.Option value="SELF_FORMED">Student Self-Formed</Select.Option>
                  </Select>
                </FormItem>

                <FormItem control={control} name="max_team_size" label="Max Team Size">
                  <InputNumber min={2} style={{ width: '100%' }} placeholder="e.g., 4" />
                </FormItem>

                {teamFormationMode === 'INSTRUCTOR' && (
                  // The affordance rides in the item's `extra` slot so antd owns
                  // the spacing: it sizes the block below the control to fit both
                  // this and the validation message, in every combination.
                  <FormItem
                    control={control}
                    name="tag"
                    label="Team Tag"
                    extra={
                      isNewTagOpen ? (
                        <div className="mt-2 flex items-center gap-2">
                          <Input
                            size="small"
                            autoFocus
                            aria-label="New team tag name"
                            value={newTagName}
                            onChange={e => setNewTagName(e.target.value)}
                            onKeyDown={e => {
                              // Enter creates the tag rather than submitting the
                              // repository form; Escape backs out of the input.
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                e.stopPropagation();
                                createTag();
                              } else if (e.key === 'Escape') {
                                e.preventDefault();
                                e.stopPropagation();
                                closeNewTag();
                              }
                            }}
                            placeholder="New tag name"
                            disabled={isCreatingTag}
                          />
                          <Button
                            type="primary"
                            size="small"
                            onClick={createTag}
                            loading={isCreatingTag}
                          >
                            Create
                          </Button>
                          <Button
                            type="text"
                            size="small"
                            className="!text-ink-2 hover:enabled:!text-ink-1"
                            onClick={closeNewTag}
                            disabled={isCreatingTag}
                          >
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setIsNewTagOpen(true)}
                          className="mt-1 text-xs text-ink-3 hover:text-ink-1 transition-colors"
                        >
                          + New tag
                        </button>
                      )
                    }
                  >
                    <Select className="w-full" placeholder="Select a team tag">
                      {tagOptions.map((tag: TagRef) => (
                        <Select.Option key={tag.id} value={tag.id}>
                          #{tag.name}
                        </Select.Option>
                      ))}
                    </Select>
                  </FormItem>
                )}

                {teamFormationMode === 'SELF_FORMED' && (
                  <FormItem
                    control={control}
                    name="team_formation_deadline"
                    label="Formation Deadline"
                  >
                    <DatePicker
                      showTime
                      className="w-full"
                      placeholder="Select deadline"
                      format="MMM DD, YYYY HH:mm"
                    />
                  </FormItem>
                )}
              </div>

              {/* GitHub Project Template */}
              <div className="mt-4 pt-4 border-t border-gray-200 dark:border-neutral-700">
                <SectionHeader
                  title="GitHub Project"
                  subtitle="Optionally create a GitHub Project board for each team"
                  size="sm"
                  className="mb-3"
                />
                <FormItem control={control} name="project_template_id" label="Project Template">
                  <ProjectTemplateSelect
                    disabled={hasReposWithProjects}
                    onChange={(value, option) => {
                      setValue('project_template_id', value || null);
                      const opt = option as { title?: string } | undefined;
                      setValue('project_template_title', opt?.title || null);
                    }}
                  />
                </FormItem>
                {hasReposWithProjects && (
                  <p className="text-sm text-amber-600 mt-1">
                    Project template cannot be changed after repos have projects.
                  </p>
                )}
              </div>
            </Card>
          )}

          {/* Repository Description */}
          <Card className="shadow-xs mb-6">
            <SectionHeader
              title="Learning Objectives"
              subtitle="Add a description for the learning objective of this repository"
              size="md"
              className="mb-4"
            />
            <FormItem control={control} name="description">
              <Input.TextArea
                rows={4}
                placeholder="Enter learning objective..."
                value={repository?.description || ''}
              />
            </FormItem>
          </Card>

          {/* Template Repository */}
          <Card className="shadow-xs mb-6">
            <SectionHeader
              title="Template Repository"
              subtitle="Provide starter code for students"
              size="md"
              className="mb-4"
            />

            <AsyncAutocomplete
              control={control as unknown as Control<FieldValues>}
              template={repository?.template || ''}
              isPublished={repository?.is_published || false}
              setTemplate={setTemplate}
              classSlug={classroom.slug}
            />
          </Card>

          {/* Autograding tests */}
          <Card className="shadow-xs mb-6">
            <div className="flex justify-between items-start mb-4">
              <SectionHeader
                title="Autograding tests"
                subtitle="Run tests on every push using GitHub Actions"
                size="md"
              />
              <Tooltip title="Add autograding test">
                <Button type="primary" icon={<PlusOutlined />} onClick={openNewTest}>
                  Add test
                </Button>
              </Tooltip>
            </div>

            <AutogradingTestsTable
              tests={autogradingTests}
              onEdit={openEditTest}
              onRemove={removeTest}
            />
          </Card>

          {/* Linked Content */}
          <Card className="shadow-xs mb-6">
            <SectionHeader
              title="Linked Content"
              subtitle="Link pages and slides to this repository"
              size="md"
              className="mb-4"
            />

            <div className="mb-4">
              <p className="block text-sm font-medium text-gray-700 mb-2">Pages</p>
              <Select
                mode="multiple"
                placeholder={pages.length > 0 ? 'Select pages to link' : 'No pages available'}
                value={linkedPageIds}
                onChange={setLinkedPageIds}
                style={{ width: '100%' }}
                optionFilterProp="label"
                disabled={pages.length === 0}
                options={pages.map((page: PageRef) => ({
                  value: page.id,
                  label: page.title || 'Untitled',
                }))}
              />
            </div>

            <div>
              <p className="block text-sm font-medium text-gray-700 mb-2">Slides</p>
              <Select
                mode="multiple"
                placeholder={slides.length > 0 ? 'Select slides to link' : 'No slides available'}
                value={linkedSlideIds}
                onChange={setLinkedSlideIds}
                style={{ width: '100%' }}
                optionFilterProp="label"
                disabled={slides.length === 0}
                options={slides.map((slide: SlideRef) => ({
                  value: slide.id,
                  label: slide.title || 'Untitled',
                }))}
              />
            </div>
          </Card>
        </div>

        {/* Modal for adding/editing autograding tests */}
        <Modal
          open={agOpened}
          onCancel={closeAgModal}
          title={null}
          footer={null}
          width={600}
          centered
          closable={false}
          maskClosable={false}
          styles={{
            mask: { backgroundColor: 'rgba(15, 23, 42, 0.35)' },
            content: { padding: 0, borderRadius: 16, overflow: 'hidden', maxWidth: '90vw' },
          }}
        >
          <div className="flex items-center justify-between gap-3 px-5 py-3 bg-stone-50 dark:bg-neutral-800/60 border-b border-line">
            <span className="text-sm font-semibold text-ink-0">
              {editingTestIndex === null ? 'Add autograding test' : 'Edit autograding test'}
            </span>
            <button
              type="button"
              onClick={closeAgModal}
              aria-label="Close"
              className="p-1 rounded hover:bg-line text-ink-3 transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>

          <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
            <FormAutogradingTest value={editingTest} onChange={setEditingTest} />
          </div>

          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-line bg-stone-50/60 dark:bg-neutral-800/40">
            <Button type="text" onClick={closeAgModal}>
              Discard
            </Button>
            <Button
              type="primary"
              style={{ backgroundColor: '#1f883d', borderColor: '#1f883d' }}
              onClick={saveTest}
            >
              {editingTestIndex === null ? 'Add test' : 'Save changes'}
            </Button>
          </div>
        </Modal>

        {/* Form Actions */}
        <div className="flex justify-end gap-2 pt-5 mt-5 border-t border-line">
          <Button onClick={close} type="text">
            Discard
          </Button>
          <Button
            data-tour="repos-form-submit"
            type="primary"
            htmlType="submit"
            style={{ backgroundColor: '#1f883d', borderColor: '#1f883d' }}
          >
            {isNew ? 'Create repository' : 'Update repository'}
          </Button>
        </div>
      </Form>
    </div>
  );
};

export default FormModule;
