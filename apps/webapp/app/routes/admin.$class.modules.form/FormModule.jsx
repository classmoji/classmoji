import _ from 'lodash';
import { useEffect, useState } from 'react';
import { Octokit } from '@octokit/rest';
import { toast } from 'react-toastify';

import { useRevalidator } from 'react-router';
import { useForm } from 'react-hook-form';
import { FormItem } from 'react-hook-form-antd';
import {
  Form,
  InputNumber,
  Select,
  Input,
  Button,
  Tooltip,
  Drawer,
  Alert,
  Checkbox,
  Card,
  DatePicker,
} from 'antd';
import { zodResolver } from '@hookform/resolvers/zod';
import { DevTool } from '@hookform/devtools';
import { PlusOutlined } from '@ant-design/icons';
import { useDisclosure } from '@mantine/hooks';
import { useWindowSize } from '@uidotdev/usehooks';

import AsyncAutocomplete from './AsyncAutocomplete';
import ProjectTemplateSelect from './ProjectTemplateSelect';
import { schema } from './schema';
import FormAssignment from './FormAssignment';
import { useGlobalFetcher } from '~/hooks';

import { useAssignmentStore } from './store';
import { SectionHeader } from '~/components';
import AssignmentsTable from './AssignmentsTable';
import dayjs from 'dayjs';
import { ActionTypes } from '~/constants';

const FormModule = ({ token, isNew, module, close, tags, classroom, pages = [], slides = [], hasReposWithProjects = false }) => {
  const {
    template,
    setTemplate,
    setTemplateAssignments,
    templateAssignments,
    assignment,
    resetAssignment,
    assignmentsToRemove,
    resetAssignmentsToRemove,
  } = useAssignmentStore();

  const { fetcher, notify } = useGlobalFetcher();
  const revalidator = useRevalidator();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [opened, { open: openIssueModal, close: closeIssueModal }] = useDisclosure();
  const { width } = useWindowSize();

  // State for module-level linked pages and slides
  const [linkedPageIds, setLinkedPageIds] = useState(() => {
    return module?.pages?.map(link => link.page?.id).filter(Boolean) || [];
  });
  const [linkedSlideIds, setLinkedSlideIds] = useState(() => {
    return module?.slides?.map(link => link.slide?.id).filter(Boolean) || [];
  });

  const updateFormDefaultValues = {
    id: module?.id,
    title: module?.title,
    template: module?.template,
    type: module?.type,
    tag: module?.tag_id,
    is_extra_credit: module?.is_extra_credit,
    drop_lowest_count: module?.drop_lowest_count ?? 0,
    description: module?.description || '',
    team_formation_mode: module?.team_formation_mode || 'INSTRUCTOR',
    team_formation_deadline: module?.team_formation_deadline
      ? dayjs(module.team_formation_deadline)
      : null,
    max_team_size: module?.max_team_size || null,
    project_template_id: module?.project_template_id || null,
    project_template_title: module?.project_template_title || null,
    assignments: module?.assignments.map(assignment => {
      return {
        ...assignment,
        student_deadline: assignment.student_deadline ? dayjs(assignment.student_deadline) : null,
        grader_deadline: assignment.grader_deadline ? dayjs(assignment.grader_deadline) : null,
        release_at: assignment.release_at ? dayjs(assignment.release_at) : null,
        linkedPageIds: assignment.pages?.map(link => link.page?.id).filter(Boolean) || [],
        linkedSlideIds: assignment.slides?.map(link => link.slide?.id).filter(Boolean) || [],
      };
    }),
    organization: classroom?.slug,
    weight: module?.weight,
  };

  const newFormUpdateValues = {
    organization: classroom?.slug,
    type: 'INDIVIDUAL',
    assignments: [],
    weight: 0,
    drop_lowest_count: 0,
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

  const assignments = watch('assignments');
  const type = watch('type');
  const isExtraCredit = watch('is_extra_credit');

  useEffect(() => {
    if (module) setValue('template', module.template);
    return () => {
      resetAssignmentsToRemove();
    };
  }, [module]);

  // Close drawer after successful submission and revalidate parent route
  useEffect(() => {
    if (isSubmitting && fetcher.state === 'idle') {
      setIsSubmitting(false);

      if (fetcher.data?.error) {
        toast.error(fetcher.data.error || 'Failed to save module.');
        return;
      }

      revalidator.revalidate();
      close();
    }
  }, [fetcher.state, isSubmitting, close, revalidator]);

  useEffect(() => {
    const fetchTemplateRepoIssues = async () => {
      const ocktokit = new Octokit({ auth: token });
      if (!template) return;
      const [owner, repo] = template.split('/');

      const { data } = await ocktokit.issues.listForRepo({
        owner,
        repo,
      });

      const promises = data.map(async ({ title, body }) => {
        const data = await fetch('/api/parser', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ markdown: body }),
        });
        const res = await data.json();
        return { title: title, body: res.html };
      });

      Promise.all(promises).then(assignments => setTemplateAssignments(assignments));
    };

    if (template || module?.template) {
      fetchTemplateRepoIssues();
      setValue('template', template || module?.template);
    }
  }, [template, module?.template]);

  const serializeDates = (data) => {
    const serialized = { ...data };

    if (dayjs.isDayjs(serialized.team_formation_deadline)) {
      serialized.team_formation_deadline = serialized.team_formation_deadline.toISOString();
    }

    if (serialized.assignments?.length) {
      serialized.assignments = serialized.assignments.map(assignment => ({
        ...assignment,
        student_deadline: dayjs.isDayjs(assignment.student_deadline)
          ? assignment.student_deadline.toISOString()
          : assignment.student_deadline,
        grader_deadline: dayjs.isDayjs(assignment.grader_deadline)
          ? assignment.grader_deadline.toISOString()
          : assignment.grader_deadline,
        release_at: dayjs.isDayjs(assignment.release_at)
          ? assignment.release_at.toISOString()
          : assignment.release_at,
      }));
    }

    return serialized;
  };

  const onSubmit = data => {
    const message = isNew ? 'Creating module...' : 'Updating module...';

    notify(ActionTypes.SAVE_ASSIGNMENT, message);
    setIsSubmitting(true);

    const serializedData = serializeDates(data);

    fetcher.submit(
      {
        ...serializedData,
        assignmentsToRemove,
        linkedPageIds,
        linkedSlideIds,
      },
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
                            <strong>{subField}:</strong> {subError?.message || 'Invalid value'}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                );
              }
              return (
                <div key={field}>
                  <strong>{field}:</strong> {error?.message || 'Invalid value'}
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
              subtitle="Set up the core details for your assignment"
              size="md"
              className="mb-4"
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormItem
                control={control}
                name="title"
                label="Title"
                placeholder="intro-to-data-structures"
              >
                <Input
                  placeholder="React fundamentals"
                  onChange={e => {
                    const value = e.target.value.toLowerCase().replace(/\s/g, '-');
                    setValue('title', value);
                  }}
                />
              </FormItem>

              <FormItem control={control} name="type" label="Type">
                <Select className="w-full" placeholder="Select type">
                  <Select.Option value="INDIVIDUAL">Individual</Select.Option>
                  <Select.Option value="GROUP">Group</Select.Option>
                </Select>
              </FormItem>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FormItem control={control} name="weight" label="Weight">
                <InputNumber
                  addonAfter="%"
                  max={100}
                  min={0}
                  className="w-full"
                  placeholder="Enter weight percentage"
                />
              </FormItem>

              <FormItem
                control={control}
                name="drop_lowest_count"
                label={
                  <Tooltip title="Number of lowest-scoring assignments to drop from this module's grade calculation">
                    <span>Drop Lowest Assignments</span>
                  </Tooltip>
                }
              >
                <InputNumber
                  min={0}
                  className="w-full"
                  placeholder="Number of assignments to drop"
                  style={{ width: '100%' }}
                />
              </FormItem>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 -mt-4">
              <FormItem control={control} name="is_extra_credit">
                <Checkbox checked={isExtraCredit}>
                  <span className="text-sm">
                    This is an{' '}
                    <span className="font-semibold text-green-600 text-sm">extra credit</span>{' '}
                    module
                  </span>
                </Checkbox>
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

                {watch('team_formation_mode') === 'INSTRUCTOR' && (
                  <FormItem control={control} name="tag" label="Team Tag">
                    <Select className="w-full" placeholder="Select a team tag">
                      {tags.map(tag => (
                        <Select.Option key={tag.id} value={tag.id}>
                          #{tag.name}
                        </Select.Option>
                      ))}
                    </Select>
                  </FormItem>
                )}

                {watch('team_formation_mode') === 'SELF_FORMED' && (
                  <FormItem control={control} name="team_formation_deadline" label="Formation Deadline">
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
              <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                <SectionHeader
                  title="GitHub Project"
                  subtitle="Optionally create a GitHub Project board for each team"
                  size="sm"
                  className="mb-3"
                />
                <FormItem
                  control={control}
                  name="project_template_id"
                  label="Project Template"
                >
                  <ProjectTemplateSelect
                    disabled={hasReposWithProjects}
                    onChange={(value, option) => {
                      setValue('project_template_id', value || null);
                      setValue('project_template_title', option?.title || null);
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

          {/* Module Description */}
          <Card className="shadow-xs mb-6">
            <SectionHeader
              title="Learning Objectives"
              subtitle="Add a description for the learning objective of this module"
              size="md"
              className="mb-4"
            />
            <FormItem control={control} name="description">
              <Input.TextArea
                rows={4}
                placeholder="Enter learning objective..."
                value={module?.description || ''}
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
              control={control}
              template={module?.template || ''}
              isPublished={module?.is_published || false}
              setTemplate={setTemplate}
              token={token}
            />
          </Card>

          {/* Grading Issues */}
          <Card className="shadow-xs mb-6">
            <div className="flex justify-between items-start mb-4">
              <SectionHeader
                title="Assignments"
                subtitle="Define the assignments that will be used for grading"
                size="md"
              />

              <Tooltip title="Add new assignment">
                <Button type="primary" icon={<PlusOutlined />} onClick={openIssueModal}>
                  Add assignment
                </Button>
              </Tooltip>
            </div>

            <FormItem control={control} name="assignments"></FormItem>

            <AssignmentsTable
              assignments={assignments}
              setValue={setValue}
              openAssignmentModal={openIssueModal}
            />
          </Card>

          {/* Linked Content */}
          <Card className="shadow-xs mb-6">
            <SectionHeader
              title="Linked Content"
              subtitle="Link pages and slides to this module"
              size="md"
              className="mb-4"
            />

            <div className="mb-4">
              <label className="block text-sm font-medium text-gray-700 mb-2">Pages</label>
              <Select
                mode="multiple"
                placeholder={pages.length > 0 ? 'Select pages to link' : 'No pages available'}
                value={linkedPageIds}
                onChange={setLinkedPageIds}
                style={{ width: '100%' }}
                optionFilterProp="label"
                disabled={pages.length === 0}
                options={pages.map(page => ({
                  value: page.id,
                  label: page.title || 'Untitled',
                }))}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">Slides</label>
              <Select
                mode="multiple"
                placeholder={slides.length > 0 ? 'Select slides to link' : 'No slides available'}
                value={linkedSlideIds}
                onChange={setLinkedSlideIds}
                style={{ width: '100%' }}
                optionFilterProp="label"
                disabled={slides.length === 0}
                options={slides.map(slide => ({
                  value: slide.id,
                  label: slide.title || 'Untitled',
                }))}
              />
            </div>
          </Card>
        </div>

        {/* Drawer for adding/editing issues */}
        <Drawer
          open={opened}
          width={Math.min(width * 0.6, 800)}
          placement="right"
          onClose={() => {
            closeIssueModal();
            resetAssignment();
          }}
          title={
            <div className="flex items-center gap-3">
              <div className="w-1 h-5 bg-primary-400 rounded-full"></div>
              <span>Add or Update Assignment</span>
            </div>
          }
          destroyOnClose={true}
          footer={
            <div className="flex justify-end gap-3">
              <Button
                onClick={() => {
                  closeIssueModal();
                  resetAssignment();
                }}
              >
                Cancel
              </Button>
              <Button
                type="primary"
                onClick={() => {
                  if (!assignment.title.length)
                    return toast.error('Please fill in the assignment title.');

                  const doesAssignmentExist = assignments.find(a => a.id === assignment.id);
                  let currAssignments = [...assignments];

                  if (doesAssignmentExist)
                    currAssignments = currAssignments.filter(a => a.id !== assignment.id);

                  const newList = _.uniq([...currAssignments, assignment]);
                  setValue('assignments', newList, {
                    shouldValidate: true,
                  });

                  closeIssueModal();
                  resetAssignment();
                }}
              >
                Save Assignment
              </Button>
            </div>
          }
        >
          <FormAssignment
            templateAssignments={templateAssignments}
            settings={classroom.settings}
            pages={pages}
            slides={slides}
          />
        </Drawer>

        {/* Form Actions */}
        <div className="flex justify-end gap-3 pt-6 border-t border-gray-200">
          <Button onClick={close}>Cancel</Button>

          <Button type="primary" htmlType="submit">
            {isNew ? 'Create module' : 'Update module'}
          </Button>
        </div>

        <DevTool control={control} />
      </Form>
    </div>
  );
};

export default FormModule;
