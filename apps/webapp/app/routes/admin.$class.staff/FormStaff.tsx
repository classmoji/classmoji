import { Form, Input, Button, Space, Typography, Radio, Popconfirm } from 'antd';
import { useState } from 'react';

import { IconMail, IconUser, IconBrandGithubCopilot } from '@tabler/icons-react';

import { useGlobalFetcher } from '~/hooks';
import { useCallout } from '@classmoji/ui-components';
import { ActionTypes } from '~/constants';

const { Text } = Typography;

/**
 * The roles this form can grant, easiest first. Assistant is the default
 * because it is the common case; the order also runs least- to most-privileged,
 * so the dangerous option is never the one under the cursor.
 */
const ROLE_OPTIONS = [
  {
    value: 'ASSISTANT',
    label: 'Assistant',
    hint: 'Grades work assigned to them and helps run the class.',
  },
  {
    value: 'TEACHER',
    label: 'Teacher',
    hint: 'Teaches the class: content, quizzes and grading, but not class settings.',
  },
  {
    value: 'OWNER',
    label: 'Co-owner',
    hint: 'Full control of this classroom, including deleting it.',
  },
] as const;

type StaffRole = (typeof ROLE_OPTIONS)[number]['value'];

interface FormStaffProps {
  close: () => void;
  /**
   * Which role the form opens on. Assistant in the app — the common case — and
   * the whole point of the prop is that the co-owner branch (its warning and
   * its confirmation) can be rendered and asserted without driving the select.
   */
  initialRole?: StaffRole;
}

/**
 * Add a member of the teaching staff by git login, at any staff role.
 *
 * The GitHub profile is resolved SERVER-SIDE, inside ClassmojiService.staff
 * .addStaff. This form used to do its own `octokit.users.getByUsername` with the
 * requesting instructor's access token — which meant the loader had to ship that
 * token to the browser. The lookup was never authoritative (the service resolves
 * the profile again regardless, and only its answer is trusted), so it is gone
 * along with the token: an unknown login now comes back from the action as
 * `git_user_not_found`.
 *
 * The chosen role is a HINT to the server, not a decision: the action validates
 * it against the staff roles and the whole route is OWNER-gated, so only an
 * owner can grant one.
 */
const FormStaff = ({ close, initialRole = 'ASSISTANT' }: FormStaffProps) => {
  const { fetcher, notify } = useGlobalFetcher();
  const [form] = Form.useForm();
  const [role, setRole] = useState<StaffRole>(initialRole);
  const callout = useCallout();

  // Granting OWNER hands over the classroom, so it does not happen on one
  // click. Same convention as the row-level removals and the danger zone.
  const grantsOwnership = role === 'OWNER';

  const onFinish = (values: { name?: string; login: string; email?: string }) => {
    // Only the login, the role and the instructor's optional overrides.
    // Everything the membership is keyed to — the provider id above all — is
    // the server's to decide from the login it resolves.
    const login = values.login.replace('@', '').trim();

    // A touched-then-cleared field hands back '' rather than undefined, and an
    // empty string is not nullish — posting one would write an empty email onto
    // the new user record instead of falling back to the git profile.
    const optional = (value?: string) => value?.trim() || null;

    notify(ActionTypes.SAVE_USER, 'Adding new staff member...');

    fetcher!.submit(
      { login, role, name: optional(values.name), email: optional(values.email) },
      {
        method: 'post',
        action: '?/createStaff',
        encType: 'application/json',
      }
    );

    close();
  };

  const onFinishFailed = () => {
    callout.show({ variant: 'error', title: 'Enter the GitHub username of the person to add' });
  };

  const submitButton = (
    <Button
      type="primary"
      // A Popconfirm swallows the click to show its popup, so the co-owner
      // path submits from onConfirm instead of from the button itself.
      htmlType={grantsOwnership ? 'button' : 'submit'}
      danger={grantsOwnership}
      icon={<IconUser size={16} />}
    >
      {grantsOwnership ? 'Add co-owner' : 'Add staff member'}
    </Button>
  );

  return (
    <Form
      form={form}
      layout="vertical"
      onFinish={onFinish}
      onFinishFailed={onFinishFailed}
      initialValues={{ role: initialRole }}
    >
      <Form.Item
        label="Role"
        name="role"
        extra={
          <Text type="secondary" className="text-xs">
            {ROLE_OPTIONS.find(option => option.value === role)?.hint}
          </Text>
        }
      >
        {/* A Radio.Group rather than a Select: with three options, showing all
            of them beats hiding the consequential one behind a dropdown. Same
            control the grader flag uses on the list page. */}
        <Radio.Group
          data-testid="staff-role"
          optionType="button"
          buttonStyle="solid"
          onChange={e => setRole(e.target.value as StaffRole)}
        >
          {ROLE_OPTIONS.map(({ value, label }) => (
            <Radio.Button key={value} value={value}>
              {label}
            </Radio.Button>
          ))}
        </Radio.Group>
      </Form.Item>

      {grantsOwnership && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
          <p className="font-medium">A co-owner has full control of this classroom.</p>
          <p className="mt-1">
            That includes changing every setting, managing the whole teaching staff, and deleting
            the classroom and everything in it.
          </p>
          <p className="mt-1">
            Co-owner is a Classmoji role, not a GitHub organization admin. Anything that runs with
            the requester&rsquo;s own GitHub credentials — such as the GitHub cleanup offered when a
            classroom is deleted — will fail for a co-owner who is not an admin of the GitHub
            organization.
          </p>
        </div>
      )}

      {/* The username is the whole input: everything else about the person is
          resolved from their git profile, so the other two fields stay empty
          unless the instructor wants to override what GitHub says. */}
      <Form.Item
        label="GitHub Username"
        name="login"
        rules={[
          { required: true, message: 'Please enter GitHub username' },
          {
            pattern: /^[a-zA-Z0-9]([a-zA-Z0-9]|-)*[a-zA-Z0-9]$/,
            message: 'Invalid GitHub username format',
          },
        ]}
        extra={
          <Text type="secondary" className="text-xs">
            Enter the GitHub username (without @)
          </Text>
        }
      >
        <Input placeholder="github-username" prefix={<IconBrandGithubCopilot size={16} />} />
      </Form.Item>

      {/* OPTIONAL OVERRIDES. These were required back when the form filled them
          in itself from a client-side GitHub lookup; that lookup is gone (the
          service resolves the profile server-side and `addStaff` falls back to
          the git profile's name and email), so demanding them only stopped an
          instructor inviting someone whose real name they did not have to
          hand. */}
      <Form.Item label="Name (optional)" name="name">
        <Input placeholder="Defaults to their GitHub name" prefix={<IconUser size={16} />} />
      </Form.Item>

      <Form.Item
        label="Email (optional)"
        name="email"
        rules={[{ type: 'email', message: 'Please enter a valid email address' }]}
      >
        <Input placeholder="Defaults to their GitHub email" prefix={<IconMail size={16} />} />
      </Form.Item>

      <Form.Item className="mb-0 mt-6">
        <Space className="w-full justify-end">
          <Button onClick={close}>Cancel</Button>
          {grantsOwnership ? (
            <Popconfirm
              title="Make this person a co-owner?"
              description={
                <div className="max-w-xs text-xs">
                  <p>
                    A co-owner has full control of this classroom: every setting, the whole teaching
                    staff, and deleting the classroom and everything in it. There is no undo for
                    what they delete.
                  </p>
                  <p className="mt-2">
                    Co-owner is a Classmoji role, not a GitHub organization admin. Operations that
                    use the requester&rsquo;s own GitHub credentials — such as the GitHub cleanup
                    offered when a classroom is deleted — will fail for a co-owner who is not an
                    admin of the GitHub organization.
                  </p>
                </div>
              }
              onConfirm={() => form.submit()}
              okButtonProps={{ danger: true }}
              okText="Add co-owner"
              cancelText="Cancel"
              placement="topRight"
            >
              {submitButton}
            </Popconfirm>
          ) : (
            submitButton
          )}
        </Space>
      </Form.Item>
    </Form>
  );
};

export default FormStaff;
