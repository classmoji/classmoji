import { useEffect } from 'react';
import { Avatar, Form, Input } from 'antd';
import { GithubOutlined, MailOutlined, UserOutlined } from '@ant-design/icons';

import useStore from '~/store';

const SettingsGeneral = () => {
  const { user } = useStore();
  const [form] = Form.useForm();

  // Update form values when user data becomes available (after Zustand hydrates)
  useEffect(() => {
    if (user) {
      form.setFieldsValue({
        name: user.name,
        email: user.email,
        github_username: user.login,
      });
    }
  }, [user, form]);

  return (
    <div className="w-2/3">
      <div className="panel">
        <div className="panel-head">
          <div className="flex items-start gap-6">
            <div className="relative">
              <Avatar
                src={user?.avatar_url}
                size={96}
                className="shadow-sm"
                style={{
                  border: '3px solid var(--line)',
                }}
              />
            </div>
            <div className="flex-1">
              <h3 className="display text-xl text-ink-0 mb-1">
                {user?.name || 'User Name'}
              </h3>
              <p className="text-ink-2 text-sm mb-2">{user?.email}</p>
              <div className="flex items-center gap-2 text-sm text-ink-3">
                <GithubOutlined />
                <span>@{user?.login}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="panel-body">
          <h4 className="text-ink-2 text-xs uppercase tracking-wide mb-4">
            Profile Information
          </h4>

          <Form
            form={form}
            layout="vertical"
            initialValues={{
              name: user?.name,
              email: user?.email,
              github_username: user?.login,
            }}
            className="w-full"
          >
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Form.Item
                label={
                  <span className="text-ink-2 text-xs uppercase tracking-wide">Full Name</span>
                }
                name="name"
                className="mb-4"
              >
                <Input
                  readOnly
                  prefix={<UserOutlined className="text-ink-3" />}
                  className="h-11 bg-paper border-line cursor-not-allowed rounded-md"
                />
              </Form.Item>

              <Form.Item
                label={
                  <span className="text-ink-2 text-xs uppercase tracking-wide">Email Address</span>
                }
                name="email"
                className="mb-4"
              >
                <Input
                  readOnly
                  prefix={<MailOutlined className="text-ink-3" />}
                  className="h-11 bg-paper border-line cursor-not-allowed rounded-md"
                />
              </Form.Item>

              <Form.Item
                label={
                  <span className="text-ink-2 text-xs uppercase tracking-wide">
                    GitHub Username
                  </span>
                }
                name="github_username"
                className="md:col-span-2 mb-4"
              >
                <Input
                  readOnly
                  prefix={<GithubOutlined className="text-ink-3" />}
                  className="h-11 bg-paper border-line cursor-not-allowed rounded-md max-w-md"
                />
              </Form.Item>
            </div>

            <div
              className="mt-6 p-4 rounded-lg border"
              style={{
                background: 'var(--amber-bg)',
                borderColor: 'var(--amber-bord)',
                color: 'var(--amber-ink)',
              }}
            >
              <p className="font-medium mb-1 text-sm">Read-only Information</p>
              <p className="text-sm leading-relaxed opacity-90">
                This information cannot be edited directly.
              </p>
            </div>
          </Form>
        </div>
      </div>
    </div>
  );
};

export default SettingsGeneral;
