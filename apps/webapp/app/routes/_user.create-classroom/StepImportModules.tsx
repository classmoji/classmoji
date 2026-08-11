import { useState } from 'react';
import { Select, Switch, Avatar, Empty, Button, Tag, Checkbox } from 'antd';
import {
  EditOutlined,
  BookOutlined,
  FileTextOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import ModuleSelectionDrawer from './ModuleSelectionDrawer';
import type { ClassroomModule, ImportSelections, OwnedClassroom } from './types';

interface ModuleConfig {
  includeQuizzes: boolean;
}

interface StepImportModulesProps {
  ownedClassrooms: OwnedClassroom[];
  importEnabled: boolean;
  setImportEnabled: (enabled: boolean) => void;
  sourceClassroomId: string | null;
  setSourceClassroomId: (id: string | null) => void;
  selectedModules: Map<string, ModuleConfig>;
  setSelectedModules: (repositories: Map<string, ModuleConfig>) => void;
  importSelections: ImportSelections;
  setImportSelections: (selections: ImportSelections) => void;
}

/** One "Also copy" toggle row: key, label, sublabel, and an item count that
 * disables the row at zero (null count = settings groups, always available). */
interface CopyGroupRow {
  key: keyof ImportSelections;
  label: string;
  sublabel?: string;
  count?: number | null;
}

const StepImportModules = ({
  ownedClassrooms,
  importEnabled,
  setImportEnabled,
  sourceClassroomId,
  setSourceClassroomId,
  selectedModules,
  setSelectedModules,
  importSelections,
  setImportSelections,
}: StepImportModulesProps) => {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const sourceClassroom = ownedClassrooms.find(c => c.id === sourceClassroomId);
  const repositories = sourceClassroom?.repositories || [];

  const handleModuleToggle = (moduleId: string, checked: boolean) => {
    const newSelected = new Map(selectedModules);
    if (checked) {
      newSelected.set(moduleId, { includeQuizzes: false });
    } else {
      newSelected.delete(moduleId);
    }
    setSelectedModules(newSelected);
  };

  const handleQuizToggle = (moduleId: string, checked: boolean) => {
    const newSelected = new Map(selectedModules);
    const current = newSelected.get(moduleId) || {};
    newSelected.set(moduleId, { ...current, includeQuizzes: checked });
    setSelectedModules(newSelected);
  };

  const handleSourceChange = (classroomId: string) => {
    setSourceClassroomId(classroomId);
    setSelectedModules(new Map());
  };

  const handleSelectAll = () => {
    const newSelected = new Map();
    repositories.forEach(m => {
      newSelected.set(m.id, { includeQuizzes: false });
    });
    setSelectedModules(newSelected);
  };

  const handleDeselectAll = () => {
    setSelectedModules(new Map());
  };

  // Calculate totals for summary
  let totalAssignments = 0;
  let totalQuizzes = 0;
  if (sourceClassroom && selectedModules.size > 0) {
    sourceClassroom.repositories?.forEach((m: ClassroomModule) => {
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
    <div className="space-y-6">
      <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-neutral-800 rounded-lg">
        <div>
          <div className="font-medium">Import from existing classroom</div>
          <div className="text-sm text-gray-500">
            Copy repositories and assignments from another classroom you own
          </div>
        </div>
        <Switch checked={importEnabled} onChange={setImportEnabled} />
      </div>

      {importEnabled && (
        <>
          {ownedClassrooms.length === 0 ? (
            <Empty
              description="You don't have any other classrooms to import from"
              className="py-8"
            />
          ) : (
            <>
              <div>
                <p className="block text-sm font-medium mb-2">Select source classroom</p>
                <Select
                  placeholder="Choose a classroom to import from"
                  value={sourceClassroomId}
                  onChange={handleSourceChange}
                  className="w-full"
                  showSearch
                  optionFilterProp="children"
                  filterOption={(input, option) =>
                    (option as unknown as { children: string })!.children
                      .toLowerCase()
                      .includes(input.toLowerCase())
                  }
                >
                  {ownedClassrooms.map(classroom => (
                    <Select.Option key={classroom.id} value={classroom.id}>
                      <div className="flex items-center gap-2">
                        {(classroom.git_organization as { avatar_url?: string } | null)
                          ?.avatar_url && (
                          <Avatar
                            src={(classroom.git_organization as { avatar_url: string }).avatar_url}
                            size={16}
                          />
                        )}
                        <span>{classroom.name}</span>
                        <span className="text-gray-400 ml-auto">
                          {classroom.repositories?.length || 0} repositories
                        </span>
                      </div>
                    </Select.Option>
                  ))}
                </Select>
              </div>

              {sourceClassroomId && (
                <div className="p-4 border border-gray-200 dark:border-neutral-700 rounded-lg">
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-medium">Repositories to Import</span>
                    <Button
                      type="link"
                      icon={<EditOutlined />}
                      onClick={() => setDrawerOpen(true)}
                      className="p-0"
                    >
                      Select Repositories
                    </Button>
                  </div>

                  {selectedModules.size > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      <Tag
                        icon={<BookOutlined />}
                        color="blue"
                        style={{ minWidth: 100, textAlign: 'center' }}
                      >
                        {selectedModules.size} repository{selectedModules.size !== 1 ? 's' : ''}
                      </Tag>
                      <Tag
                        icon={<FileTextOutlined />}
                        color="green"
                        style={{ minWidth: 100, textAlign: 'center' }}
                      >
                        {totalAssignments} assignment{totalAssignments !== 1 ? 's' : ''}
                      </Tag>
                      {totalQuizzes > 0 && (
                        <Tag
                          icon={<QuestionCircleOutlined />}
                          color="purple"
                          style={{ minWidth: 100, textAlign: 'center' }}
                        >
                          {totalQuizzes} quiz{totalQuizzes !== 1 ? 'zes' : ''}
                        </Tag>
                      )}
                    </div>
                  ) : (
                    <div className="text-gray-500 text-sm">
                      No repositories selected.{' '}
                      <button
                        type="button"
                        onClick={() => setDrawerOpen(true)}
                        className="text-blue-500 hover:underline"
                      >
                        Select repositories
                      </button>
                    </div>
                  )}

                  {selectedModules.size > 0 && (
                    <div className="mt-3 text-xs text-gray-500">
                      Deadlines will be removed. Repositories and quizzes will start unpublished.
                    </div>
                  )}
                </div>
              )}

              {sourceClassroomId && (
                <div className="p-4 border border-gray-200 dark:border-neutral-700 rounded-lg">
                  <div className="font-medium mb-1">Also copy</div>
                  <div className="text-sm text-gray-500 mb-3">
                    Settings and content to bring over from{' '}
                    {sourceClassroom?.name ?? 'the source classroom'}. Pages, slide decks, and
                    modules arrive as drafts.
                  </div>
                  <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
                    {(
                      [
                        {
                          key: 'grading',
                          label: 'Grading & late penalty',
                          sublabel: 'late penalty rate, grade visibility',
                        },
                        {
                          key: 'gradeScales',
                          label: 'Grade scales',
                          count:
                            (sourceClassroom?._count?.emoji_mappings ?? 0) +
                            (sourceClassroom?._count?.letter_grade_mappings ?? 0),
                          sublabel: 'emoji + letter-grade mappings',
                        },
                        {
                          key: 'tokens',
                          label: 'Tokens & extensions',
                          sublabel: 'default token rate',
                        },
                        {
                          key: 'features',
                          label: 'Features & appearance',
                          sublabel: 'feature toggles, navigation, theme',
                        },
                        {
                          key: 'aiConfig',
                          label: 'AI & quiz config',
                          sublabel: 'models, temperature, syllabus bot',
                        },
                        {
                          key: 'apiKeys',
                          label: 'AI API keys',
                          sublabel: 'secrets — copy only if you mean to',
                        },
                        {
                          key: 'pages',
                          label: 'Pages',
                          count: sourceClassroom?._count?.pages ?? 0,
                          sublabel: 'imported as drafts',
                        },
                        {
                          key: 'slides',
                          label: 'Slide decks',
                          count: sourceClassroom?._count?.slides ?? 0,
                          sublabel: 'imported as drafts',
                        },
                        {
                          key: 'modules',
                          label: 'Modules',
                          count: sourceClassroom?._count?.modules ?? 0,
                          sublabel: 'items link only to content you import',
                        },
                        {
                          key: 'calendar',
                          label: 'Calendar events',
                          count: sourceClassroom?._count?.calendar_events ?? 0,
                          sublabel: 'dates copied as-is — edit after import',
                        },
                      ] as CopyGroupRow[]
                    ).map(row => {
                      const disabled = row.count !== undefined && (row.count ?? 0) === 0;
                      return (
                        <Checkbox
                          key={row.key}
                          checked={!disabled && importSelections[row.key]}
                          disabled={disabled}
                          onChange={e =>
                            setImportSelections({
                              ...importSelections,
                              [row.key]: e.target.checked,
                            })
                          }
                        >
                          <span className="text-sm">
                            {row.label}
                            {row.count !== undefined && (
                              <span className="text-gray-400"> ({row.count})</span>
                            )}
                          </span>
                          {row.sublabel && (
                            <div className="text-xs text-gray-500">{row.sublabel}</div>
                          )}
                        </Checkbox>
                      );
                    })}
                  </div>
                </div>
              )}

              <ModuleSelectionDrawer
                open={drawerOpen}
                onClose={() => setDrawerOpen(false)}
                repositories={repositories}
                selectedModules={selectedModules}
                onModuleToggle={handleModuleToggle}
                onQuizToggle={handleQuizToggle}
                onSelectAll={handleSelectAll}
                onDeselectAll={handleDeselectAll}
              />
            </>
          )}
        </>
      )}
    </div>
  );
};

export default StepImportModules;
