import { useEffect } from 'react';
import { Avatar, Form, Input, Card } from 'antd';
import { GithubOutlined, MailOutlined, UserOutlined } from '@ant-design/icons';

import useStore from '~/store';

const SettingsGeneral = () => {
  const { user } = useStore(state => state);
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
      <Card className="">
        {/* Profile Header */}
        <div className="flex items-start gap-6 mb-8">
          <div className="relative">
            <Avatar
              src={user?.avatar_url}
              size={120}
              className="shadow-sm"
              style={{
                border: '4px solid #f3f4f6',
              }}
            />
          </div>
          <div className="flex-1">
            <h3 className="text-xl font-bold text-gray-800 mb-2">{user?.name || 'User Name'}</h3>
            <p className="text-gray-600 text-base mb-3">{user?.email}</p>
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <GithubOutlined className="text-gray-400" />
              <span>@{user?.login}</span>
            </div>
          </div>
        </div>

        <div className="border-t border-gray-200 my-8"></div>

        {/* Form Section */}
        <div>
          <h4 className="text-lg font-semibold text-gray-800 mb-6">Profile Information</h4>

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
                label={<span className="text-gray-700 font-medium text-sm">Full Name</span>}
                name="name"
                className="mb-6"
              >
                <Input
                  readOnly
                  prefix={<UserOutlined className="text-gray-400" />}
                  className="h-12 bg-gray-50 border-gray-200 cursor-not-allowed rounded-md focus:border-gray-200 focus:shadow-none hover:border-gray-200"
                />
              </Form.Item>

              <Form.Item
                label={<span className="text-gray-700 font-medium text-sm">Email Address</span>}
                name="email"
                className="mb-6"
              >
                <Input
                  readOnly
                  prefix={<MailOutlined className="text-gray-400" />}
                  className="h-12 bg-gray-50 border-gray-200 cursor-not-allowed rounded-md focus:border-gray-200 focus:shadow-none hover:border-gray-200"
                />
              </Form.Item>

              <Form.Item
                label={<span className="text-gray-700 font-medium text-sm">GitHub Username</span>}
                name="github_username"
                className="md:col-span-2 mb-6"
              >
                <Input
                  readOnly
                  prefix={<GithubOutlined className="text-gray-400" />}
                  className="h-12 bg-gray-50 border-gray-200 cursor-not-allowed rounded-md focus:border-gray-200 focus:shadow-none hover:border-gray-200 max-w-md"
                />
              </Form.Item>
            </div>

            <div className="mt-8 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
              <div className="flex items-start gap-3">
                <div>
                  <p className="text-yellow-800 font-medium mb-1 text-sm">Read-only Information</p>
                  <p className="text-yellow-700 text-sm leading-relaxed">
                    This information cannot be edited directly.
                  </p>
                </div>
              </div>
            </div>
          </Form>
        </div>
      </Card>
    </div>
  );
};

export default SettingsGeneral;
