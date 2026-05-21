import { useState } from 'react';
import { useFormContext, Controller } from 'react-hook-form';
import { Input, Select, Avatar, Button, Divider, Spin } from 'antd';
import { PlusOutlined, LoadingOutlined, EditOutlined } from '@ant-design/icons';
import { useGitHubAppInstallPopup } from '~/hooks';
import type { GitOrganizationOption } from './types';
import { slugify } from './utils';

interface AvailabilityResponse {
  slug_available: boolean;
  slug_suggestion?: string;
}

interface StepBasicInfoProps {
  gitOrgs: GitOrganizationOption[];
  slugPreview: string;
  githubAppName?: string | null;
  availability?: AvailabilityResponse;
  availabilityLoading?: boolean;
}

const StepBasicInfo = ({
  gitOrgs,
  slugPreview,
  githubAppName,
  availability,
  availabilityLoading,
}: StepBasicInfoProps) => {
  const {
    control,
    setValue,
    watch,
    formState: { errors },
  } = useFormContext();
  const { openInstallPopup, isRefreshing } = useGitHubAppInstallPopup(githubAppName ?? undefined);

  const slugOverride = watch('slug') as string | undefined;
  const effectiveSlug = slugOverride && slugOverride.length > 0 ? slugOverride : slugPreview;

  const [editingSlug, setEditingSlug] = useState(false);

  const showResult = !!effectiveSlug && !availabilityLoading && !!availability;
  const slugTaken = showResult && availability!.slug_available === false;
  const slugAvailable = showResult && availability!.slug_available === true;

  const applySuggestion = () => {
    if (availability?.slug_suggestion) {
      setValue('slug', availability.slug_suggestion, {
        shouldDirty: true,
        shouldValidate: true,
      });
      setEditingSlug(false);
    }
  };

  // Custom dropdown footer with "Install on another organization" button
  const dropdownRender = (menu: React.ReactNode) => (
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
          <p className="block text-sm font-medium mb-1">
            <span className="text-red-500">*</span> GitHub Organization
          </p>
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
                          ({org.classrooms.length} classroom{org.classrooms.length !== 1 ? 's' : ''}
                          )
                        </span>
                      )}
                    </div>
                  </Select.Option>
                ))}
              </Select>
            )}
          />
          {errors.git_org_id && (
            <span className="text-red-500 text-sm">{errors.git_org_id.message as string}</span>
          )}
        </div>

        <div>
          <p className="block text-sm font-medium mb-1">
            <span className="text-red-500">*</span> Classroom Name
          </p>
          <Controller
            name="name"
            control={control}
            rules={{ required: 'Please enter a classroom name' }}
            render={({ field }) => (
              <Input
                {...field}
                placeholder="e.g., CS 101, Introduction to Programming"
                status={errors.name ? 'error' : ''}
                onChange={e => {
                  field.onChange(e);
                  // Reset any manual slug override so the slug re-derives from name,
                  // unless the user is actively editing the slug field.
                  if (!editingSlug) {
                    setValue('slug', '', { shouldDirty: false });
                  }
                }}
              />
            )}
          />
          {errors.name && (
            <span className="text-red-500 text-sm">{errors.name.message as string}</span>
          )}
        </div>

        {(slugPreview || slugOverride) && (
          <div>
            <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
              <span>Slug:</span>
              {editingSlug ? (
                <Controller
                  name="slug"
                  control={control}
                  render={({ field }) => (
                    <Input
                      {...field}
                      size="small"
                      style={{ width: 240 }}
                      onChange={e => field.onChange(slugify(e.target.value))}
                      onBlur={() => {
                        field.onBlur();
                        setEditingSlug(false);
                      }}
                      autoFocus
                    />
                  )}
                />
              ) : (
                <>
                  <code
                    className={
                      slugTaken
                        ? 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-200 px-2 py-1 rounded'
                        : 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-200 px-2 py-1 rounded'
                    }
                  >
                    {effectiveSlug}
                  </code>
                  <button
                    type="button"
                    onClick={() => setEditingSlug(true)}
                    className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                    aria-label="Edit slug"
                  >
                    <EditOutlined /> edit
                  </button>
                </>
              )}
            </div>

            {/* Availability feedback */}
            <div className="mt-1 text-sm min-h-[1.25rem]">
              {availabilityLoading && (
                <span className="text-gray-400 dark:text-gray-500">Checking availability…</span>
              )}
              {!availabilityLoading && slugAvailable && (
                <span className="text-emerald-600 dark:text-emerald-400">✓ available</span>
              )}
              {!availabilityLoading && slugTaken && (
                <span className="text-red-600 dark:text-red-400 inline-flex items-center gap-2 flex-wrap">
                  <span>
                    &lsquo;{effectiveSlug}&rsquo; is taken
                    {availability?.slug_suggestion ? (
                      <>
                        {' '}
                        — try &lsquo;
                        <span className="font-mono">{availability.slug_suggestion}</span>&rsquo;
                      </>
                    ) : null}
                  </span>
                  {availability?.slug_suggestion && (
                    <button
                      type="button"
                      onClick={applySuggestion}
                      className="px-2 py-0.5 rounded border border-red-300 dark:border-red-700 text-red-700 dark:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/40 text-xs"
                    >
                      Use suggestion
                    </button>
                  )}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
    </Spin>
  );
};

export default StepBasicInfo;
