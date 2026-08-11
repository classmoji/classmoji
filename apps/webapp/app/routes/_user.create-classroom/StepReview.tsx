import { Card, Tag, Avatar } from 'antd';
import {
  CheckCircleOutlined,
  BookOutlined,
  FileTextOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import type {
  CreateClassroomFormValues,
  GitOrganizationOption,
  ImportSelections,
  ModuleConfig,
  OwnedClassroom,
} from './types';

interface StepReviewProps {
  formValues: CreateClassroomFormValues;
  gitOrgs: GitOrganizationOption[];
  slugPreview: string;
  contentRepoName?: string | null;
  importEnabled: boolean;
  sourceClassroom?: OwnedClassroom;
  selectedModules: Map<string, ModuleConfig>;
  importSelections?: ImportSelections;
}

/** Human labels for the enabled "Also copy" groups, with counts where known. */
const copySummaryParts = (
  selections: ImportSelections,
  counts?: OwnedClassroom['_count']
): string[] => {
  const parts: string[] = [];
  if (selections.grading) parts.push('grading & late penalty');
  const scaleCount = (counts?.emoji_mappings ?? 0) + (counts?.letter_grade_mappings ?? 0);
  if (selections.gradeScales && scaleCount > 0) parts.push(`grade scales (${scaleCount})`);
  if (selections.tokens) parts.push('tokens');
  if (selections.features) parts.push('features & appearance');
  if (selections.aiConfig) parts.push('AI config');
  if (selections.apiKeys) parts.push('API keys');
  if (selections.pages && (counts?.pages ?? 0) > 0) parts.push(`pages (${counts?.pages})`);
  if (selections.slides && (counts?.slides ?? 0) > 0)
    parts.push(`slide decks (${counts?.slides})`);
  if (selections.modules && (counts?.modules ?? 0) > 0)
    parts.push(`modules (${counts?.modules})`);
  if (selections.calendar && (counts?.calendar_events ?? 0) > 0)
    parts.push(`calendar events (${counts?.calendar_events})`);
  return parts;
};

const StepReview = ({
  formValues,
  gitOrgs,
  slugPreview,
  contentRepoName,
  importEnabled,
  sourceClassroom,
  selectedModules,
  importSelections,
}: StepReviewProps) => {
  const { git_org_id, name } = formValues;
  const selectedOrg = gitOrgs.find(o => o.id === git_org_id);

  // Calculate totals
  let totalAssignments = 0;
  let totalQuizzes = 0;

  if (importEnabled && sourceClassroom && selectedModules.size > 0) {
    sourceClassroom.repositories?.forEach(m => {
      if (selectedModules.has(m.id)) {
        totalAssignments += m._count?.assignments || 0;
        const config = selectedModules.get(m.id);
        if (config?.includeQuizzes) {
          totalQuizzes += m._count?.quizzes || 0;
        }
      }
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <Card
        title={
          <div className="flex items-center gap-2">
            <CheckCircleOutlined className="text-green-500" />
            <span>Classroom Details</span>
          </div>
        }
        size="small"
      >
        <div className="space-y-3">
          <div className="flex justify-between">
            <span className="text-gray-500">Organization</span>
            <div className="flex items-center gap-2">
              {selectedOrg?.avatar_url && <Avatar src={selectedOrg.avatar_url} size={20} />}
              <span>{selectedOrg?.login}</span>
            </div>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Name</span>
            <span className="font-medium">{name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Slug</span>
            <code className="bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-200 px-2 py-0.5 rounded text-sm">
              {slugPreview}
            </code>
          </div>
          {contentRepoName && (
            <div className="flex justify-between">
              <span className="text-gray-500">Content repo</span>
              <code className="bg-stone-100 dark:bg-neutral-800 text-gray-700 dark:text-gray-300 px-2 py-0.5 rounded text-sm">
                {contentRepoName}
              </code>
            </div>
          )}
        </div>
      </Card>

      {importEnabled && sourceClassroom && importSelections && (
        <Card
          title={
            <div className="flex items-center gap-2">
              <CheckCircleOutlined className="text-blue-500" />
              <span>Settings &amp; Content Copy</span>
            </div>
          }
          size="small"
        >
          {(() => {
            const parts = copySummaryParts(importSelections, sourceClassroom._count);
            return parts.length > 0 ? (
              <div className="text-sm text-gray-700 dark:text-gray-300">
                Copying from {sourceClassroom.name}: {parts.join(', ')}.
                <div className="mt-1 text-xs text-gray-500">
                  Pages, slide decks, and modules arrive as drafts.
                </div>
              </div>
            ) : (
              <div className="text-gray-500">No settings or content selected.</div>
            );
          })()}
        </Card>
      )}

      {importEnabled && selectedModules.size > 0 ? (
        <Card
          title={
            <div className="flex items-center gap-2">
              <BookOutlined className="text-blue-500" />
              <span>Import Summary</span>
            </div>
          }
          size="small"
        >
          <div className="space-y-3">
            <div className="flex justify-between">
              <span className="text-gray-500">Source</span>
              <div className="flex items-center gap-2">
                {sourceClassroom?.git_organization?.avatar_url && (
                  <Avatar src={sourceClassroom.git_organization.avatar_url} size={16} />
                )}
                <span>{sourceClassroom?.name}</span>
              </div>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-500">Repositories</span>
              <Tag color="blue" icon={<BookOutlined />}>
                {selectedModules.size}
              </Tag>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-500">Assignments</span>
              <Tag color="green" icon={<FileTextOutlined />}>
                {totalAssignments}
              </Tag>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-500">Quizzes</span>
              <Tag color="purple" icon={<QuestionCircleOutlined />}>
                {totalQuizzes}
              </Tag>
            </div>
            <div className="pt-2 border-t border-gray-200 dark:border-neutral-700 text-sm text-gray-500">
              All deadlines will be cleared. Repositories and quizzes will start unpublished.
            </div>
          </div>
        </Card>
      ) : (
        <Card
          title={
            <div className="flex items-center gap-2">
              <BookOutlined className="text-gray-400" />
              <span>Import</span>
            </div>
          }
          size="small"
        >
          <div className="text-gray-500">
            No repositories will be imported. You can add repositories later.
          </div>
        </Card>
      )}
    </div>
  );
};

export default StepReview;
