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
  ModuleConfig,
  OwnedClassroom,
} from './types';

interface StepReviewProps {
  formValues: CreateClassroomFormValues;
  gitOrgs: GitOrganizationOption[];
  slugPreview: string;
  importEnabled: boolean;
  sourceClassroom?: OwnedClassroom;
  selectedModules: Map<string, ModuleConfig>;
}

const StepReview = ({
  formValues,
  gitOrgs,
  slugPreview,
  importEnabled,
  sourceClassroom,
  selectedModules,
}: StepReviewProps) => {
  const { git_org_id, name, term, year } = formValues;
  const selectedOrg = gitOrgs.find(o => o.id === git_org_id);

  // Calculate totals
  let totalAssignments = 0;
  let totalQuizzes = 0;

  if (importEnabled && sourceClassroom && selectedModules.size > 0) {
    sourceClassroom.modules?.forEach(m => {
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
            <span className="text-ink-2">Organization</span>
            <div className="flex items-center gap-2">
              {selectedOrg?.avatar_url && <Avatar src={selectedOrg.avatar_url} size={20} />}
              <span>{selectedOrg?.login}</span>
            </div>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-2">Name</span>
            <span className="font-medium">{name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-2">Term</span>
            <span>
              {term} {year}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-2">Slug</span>
            <code className="bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-200 px-2 py-0.5 rounded text-sm">
              {slugPreview}
            </code>
          </div>
        </div>
      </Card>

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
              <span className="text-ink-2">Source</span>
              <div className="flex items-center gap-2">
                {sourceClassroom?.git_organization?.avatar_url && (
                  <Avatar src={sourceClassroom.git_organization.avatar_url} size={16} />
                )}
                <span>{sourceClassroom?.name}</span>
                <span className="text-ink-3">
                  ({sourceClassroom?.term} {sourceClassroom?.year})
                </span>
              </div>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-ink-2">Modules</span>
              <Tag color="blue" icon={<BookOutlined />}>
                {selectedModules.size}
              </Tag>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-ink-2">Assignments</span>
              <Tag color="green" icon={<FileTextOutlined />}>
                {totalAssignments}
              </Tag>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-ink-2">Quizzes</span>
              <Tag color="purple" icon={<QuestionCircleOutlined />}>
                {totalQuizzes}
              </Tag>
            </div>
            <div className="pt-2 border-t border-line dark:border-line text-sm text-ink-2">
              All deadlines will be cleared. Modules and quizzes will start unpublished.
            </div>
          </div>
        </Card>
      ) : (
        <Card
          title={
            <div className="flex items-center gap-2">
              <BookOutlined className="text-ink-3" />
              <span>Import</span>
            </div>
          }
          size="small"
        >
          <div className="text-ink-2">
            No modules will be imported. You can add modules later.
          </div>
        </Card>
      )}
    </div>
  );
};

export default StepReview;
