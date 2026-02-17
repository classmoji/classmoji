import { useEffect, useRef } from 'react';
import { Button, Input, InputNumber, Form, DatePicker, Select, Popover, Card, Alert } from 'antd';
import { IconTemplate } from '@tabler/icons-react';
import dayjs from 'dayjs';

import { TextEditor, SectionHeader } from '~/components';
import { useAssignmentStore } from './store';

const generateId = () => {
  return crypto.randomUUID();
};

const FormAssignment = ({ templateAssignments, settings, pages = [], slides = [] }) => {
  const { setAssignmentValue, assignment } = useAssignmentStore();
  const editorRef = useRef(null);

  useEffect(() => {
    if (!assignment.id) setAssignmentValue('id', generateId());
    if (assignment.tokens_per_hour === 0) {
      setAssignmentValue('tokens_per_hour', settings.default_tokens_per_hour);
    }
  }, []);

  return (
    <Form layout="vertical">
      <div className="flex flex-col gap-6">
        {/* Assignment Header */}
        <div className="flex justify-between items-start">
          <div>
            <h4 className="text-base font-semibold text-gray-900 mb-1">
              {assignment?.title ? `Edit Assignment: ${assignment.title}` : 'Create New Assignment'}
            </h4>
            <p className="text-sm text-gray-600">
              Configure the assignment details and grading parameters
            </p>
          </div>

          {templateAssignments?.length > 0 && (
            <Popover
              title={
                <div className="flex items-center gap-2">
                  <IconTemplate size={16} />
                  <span>Select Template</span>
                </div>
              }
              content={
                <div className="w-80">
                  <p className="text-xs text-gray-600 mb-3">
                    Choose from existing template assignments
                  </p>
                  <Select
                    className="w-full"
                    placeholder="Select a template assignment"
                    options={templateAssignments.map(templateAssignment => ({
                      value: templateAssignment.body,
                      label: templateAssignment.title,
                    }))}
                    onChange={(_value, option) => {
                      setAssignmentValue('title', option.label);
                      setAssignmentValue('description', _value);
                    }}
                  />
                </div>
              }
              trigger="click"
            >
              <Button
                icon={<IconTemplate size={16} />}
                className="border-yellow-300 text-yellow-600 hover:border-yellow-400 hover:text-yellow-700"
              >
                Use template
              </Button>
            </Popover>
          )}
        </div>

        {/* Basic Information */}
        <Card size="small">
          <SectionHeader
            title="Basic Information"
            subtitle="Core assignment details and configuration"
            size="sm"
            className="mb-4"
          />

          <Form.Item label={<span className="font-medium">Assignment Title</span>} className="mb-4">
            <Input
              required
              placeholder="Enter descriptive assignment title"
              value={assignment.title}
              onChange={e => setAssignmentValue('title', e.currentTarget.value)}
            />
          </Form.Item>
        </Card>

        {/* Grading Configuration */}
        <Card size="small">
          <SectionHeader
            title="Grading Configuration"
            subtitle="Set weight and cost of 1 extension hour"
            size="sm"
            className="mb-4"
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Form.Item label={<span className="font-medium">Weight</span>}>
              <InputNumber
                placeholder="Enter weight"
                addonAfter="%"
                className="w-full"
                required
                value={assignment.weight}
                onChange={value => {
                  setAssignmentValue('weight', Number(value));
                }}
                min={0}
                max={100}
              />
            </Form.Item>

            <Form.Item label={<span className="font-medium">Tokens per Hour</span>}>
              <InputNumber
                placeholder="Default tokens"
                addonAfter="tokens"
                className="w-full"
                required
                value={assignment.tokens_per_hour}
                onChange={value => {
                  setAssignmentValue('tokens_per_hour', Number(value));
                }}
                min={0}
              />
            </Form.Item>
          </div>
        </Card>

        {/* Deadlines */}
        <Card size="small">
          <SectionHeader
            title="Schedule & Deadlines"
            subtitle="Set release date, submission and grading deadlines"
            size="sm"
            className="mb-4"
          />

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Form.Item label={<span className="font-medium">Release Date</span>}>
              <DatePicker
                className="w-full"
                placeholder="Select release date"
                value={assignment.release_at ? dayjs(assignment.release_at) : null}
                onChange={v => {
                  setAssignmentValue('release_at', v ? dayjs(v) : null);
                }}
                format="MMM DD, YYYY"
              />
            </Form.Item>

            <Form.Item label={<span className="font-medium">Student Deadline</span>}>
              <DatePicker
                showTime
                className="w-full"
                placeholder="Select student deadline"
                value={assignment.student_deadline ? dayjs(assignment.student_deadline) : null}
                onChange={v => setAssignmentValue('student_deadline', v ? dayjs(v) : null)}
                format="MMM DD, YYYY HH:mm"
              />
            </Form.Item>

            <Form.Item label={<span className="font-medium">Grader Deadline</span>}>
              <DatePicker
                showTime
                className="w-full"
                placeholder="Select grader deadline"
                value={assignment.grader_deadline ? dayjs(assignment.grader_deadline) : null}
                onChange={v => setAssignmentValue('grader_deadline', v ? dayjs(v) : null)}
                format="MMM DD, YYYY HH:mm"
              />
            </Form.Item>
          </div>

          <Alert
            message={`Assignment will be automatically released at 12:01 AM on ${assignment.release_at ? dayjs(assignment.release_at).format('MMM DD, YYYY') : 'TBD'}`}
            type="info"
            showIcon
            className=""
            size="small"
          />
        </Card>
        {/* Description */}
        <Card size="small">
          <SectionHeader
            title="Description"
            subtitle="Provide detailed instructions for this assignment"
            size="sm"
            className="mb-4"
          />
          <div className="relative -top-5">
            <TextEditor
              onUpdate={value => setAssignmentValue('description', value)}
              content={assignment.description}
              ref={editorRef}
            />
          </div>
        </Card>

        {/* Linked Content */}
        <Card size="small">
          <SectionHeader
            title="Linked Content"
            subtitle="Link pages and slides to this assignment"
            size="sm"
            className="mb-4"
          />

          <Form.Item label={<span className="font-medium">Pages</span>} className="mb-4">
            <Select
              mode="multiple"
              placeholder={pages.length > 0 ? 'Select pages to link' : 'No pages available'}
              value={assignment.linkedPageIds || []}
              onChange={value => setAssignmentValue('linkedPageIds', value)}
              style={{ width: '100%' }}
              optionFilterProp="label"
              filterOption={(input, option) =>
                (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
              }
              disabled={pages.length === 0}
              options={pages.map(page => ({
                value: page.id,
                label: page.title || 'Untitled',
              }))}
            />
          </Form.Item>

          <Form.Item label={<span className="font-medium">Slides</span>}>
            <Select
              mode="multiple"
              placeholder={slides.length > 0 ? 'Select slides to link' : 'No slides available'}
              value={assignment.linkedSlideIds || []}
              onChange={value => setAssignmentValue('linkedSlideIds', value)}
              style={{ width: '100%' }}
              optionFilterProp="label"
              filterOption={(input, option) =>
                (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
              }
              disabled={slides.length === 0}
              options={slides.map(slide => ({
                value: slide.id,
                label: slide.title || 'Untitled',
              }))}
            />
          </Form.Item>
        </Card>
      </div>
    </Form>
  );
};

FormAssignment.DataType = FormAssignment;

export default FormAssignment;
