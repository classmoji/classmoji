import { useFormContext, Controller } from 'react-hook-form';
import { Input, Select, Avatar, Button, Divider, Spin } from 'antd';
import { PlusOutlined, LoadingOutlined } from '@ant-design/icons';
import { useGitHubAppInstallPopup } from '~/hooks';

const StepBasicInfo = ({ gitOrgs, slugPreview, years, githubAppName }) => {
  const { control, formState: { errors } } = useFormContext();
  const { openInstallPopup, isRefreshing } = useGitHubAppInstallPopup(githubAppName);

  // Custom dropdown footer with "Install on another organization" button
  const dropdownRender = menu => (
    <>
      {menu}
      <Divider style={{ margin: '8px 0' }} />
      <div style={{ padding: '4px 8px' }}>
        <Button
          type="text"
          icon={isRefreshing ? <LoadingOutlined /> : <PlusOutlined />}
          onClick={e => {
            e.stopPropagation();
            openInstallPopup();
          }}
          disabled={isRefreshing}
          className="w-full text-left"
        >
          {isRefreshing ? 'Refreshing organizations...' : 'Install on another organization'}
        </Button>
      </div>
    </>
  );

  return (
    <Spin spinning={isRefreshing} tip="Refreshing organizations...">
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">
          <span className="text-red-500">*</span> GitHub Organization
        </label>
        <Controller
          name="git_org_id"
          control={control}
          rules={{ required: 'Please select a GitHub organization' }}
          render={({ field }) => (
            <Select
              {...field}
              placeholder="Select GitHub Organization"
              className="w-full"
              status={errors.git_org_id ? 'error' : ''}
              dropdownRender={dropdownRender}
            >
              {gitOrgs.map(org => (
                <Select.Option key={org.id} value={org.id}>
                  <div className="flex items-center gap-2">
                    <Avatar src={org.avatar_url} size={20} />
                    <span>{org.login}</span>
                    {org.classrooms.length > 0 && (
                      <span className="text-gray-400">
                        ({org.classrooms.length} classroom{org.classrooms.length !== 1 ? 's' : ''})
                      </span>
                    )}
                  </div>
                </Select.Option>
              ))}
            </Select>
          )}
        />
        {errors.git_org_id && (
          <span className="text-red-500 text-sm">{errors.git_org_id.message}</span>
        )}
      </div>

      <div>
        <label className="block text-sm font-medium mb-1">
          <span className="text-red-500">*</span> Classroom Name
        </label>
        <Controller
          name="name"
          control={control}
          rules={{ required: 'Please enter a classroom name' }}
          render={({ field }) => (
            <Input
              {...field}
              placeholder="e.g., CS 101, Introduction to Programming"
              status={errors.name ? 'error' : ''}
            />
          )}
        />
        {errors.name && (
          <span className="text-red-500 text-sm">{errors.name.message}</span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium mb-1">
            <span className="text-red-500">*</span> Term
          </label>
          <Controller
            name="term"
            control={control}
            rules={{ required: 'Please select a term' }}
            render={({ field }) => (
              <Select
                {...field}
                placeholder="Select Term"
                className="w-full"
                status={errors.term ? 'error' : ''}
              >
                <Select.Option value="FALL">Fall</Select.Option>
                <Select.Option value="SPRING">Spring</Select.Option>
                <Select.Option value="SUMMER">Summer</Select.Option>
                <Select.Option value="WINTER">Winter</Select.Option>
              </Select>
            )}
          />
          {errors.term && (
            <span className="text-red-500 text-sm">{errors.term.message}</span>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">
            <span className="text-red-500">*</span> Year
          </label>
          <Controller
            name="year"
            control={control}
            rules={{ required: 'Please select a year' }}
            render={({ field }) => (
              <Select
                {...field}
                placeholder="Select Year"
                className="w-full"
                status={errors.year ? 'error' : ''}
              >
                {years.map(year => (
                  <Select.Option key={year} value={year}>
                    {year}
                  </Select.Option>
                ))}
              </Select>
            )}
          />
          {errors.year && (
            <span className="text-red-500 text-sm">{errors.year.message}</span>
          )}
        </div>
      </div>

      {slugPreview && (
        <div className="text-sm text-gray-600 dark:text-gray-300">
          Slug:{' '}
          <code className="bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-200 px-2 py-1 rounded">
            {slugPreview}
          </code>
        </div>
      )}
    </div>
    </Spin>
  );
};

export default StepBasicInfo;
