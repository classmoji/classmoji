import { useState } from 'react';
import { Select, Switch, Avatar, Empty, Button, Tag } from 'antd';
import {
  EditOutlined,
  BookOutlined,
  FileTextOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import ModuleSelectionDrawer from './ModuleSelectionDrawer';
import type { ClassroomModule, OwnedClassroom } from './types';

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
  setSelectedModules: (modules: Map<string, ModuleConfig>) => void;
}

const StepImportModules = ({
  ownedClassrooms,
  importEnabled,
  setImportEnabled,
  sourceClassroomId,
  setSourceClassroomId,
  selectedModules,
  setSelectedModules,
}: StepImportModulesProps) => {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const sourceClassroom = ownedClassrooms.find(c => c.id === sourceClassroomId);
  const modules = sourceClassroom?.modules || [];

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
    modules.forEach(m => {
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
    sourceClassroom.modules?.forEach((m: ClassroomModule) => {
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
      <div className="flex items-center justify-between p-4 bg-paper  rounded-lg">
        <div>
          <div className="font-medium">Import from existing classroom</div>
          <div className="text-sm text-ink-2">
            Copy modules and assignments from another classroom you own
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
                        <span className="text-ink-3">
                          ({classroom.term} {classroom.year})
                        </span>
                        <span className="text-ink-3 ml-auto">
                          {classroom.modules?.length || 0} modules
                        </span>
                      </div>
                    </Select.Option>
                  ))}
                </Select>
              </div>

              {sourceClassroomId && (
                <div className="p-4 border border-line dark:border-line rounded-lg">
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-medium">Modules to Import</span>
                    <Button
                      type="link"
                      icon={<EditOutlined />}
                      onClick={() => setDrawerOpen(true)}
                      className="p-0"
                    >
                      Select Modules
                    </Button>
                  </div>

                  {selectedModules.size > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      <Tag
                        icon={<BookOutlined />}
                        color="blue"
                        style={{ minWidth: 100, textAlign: 'center' }}
                      >
                        {selectedModules.size} module{selectedModules.size !== 1 ? 's' : ''}
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
                    <div className="text-ink-2 text-sm">
                      No modules selected.{' '}
                      <button
                        type="button"
                        onClick={() => setDrawerOpen(true)}
                        className="text-blue-500 hover:underline"
                      >
                        Select modules
                      </button>
                    </div>
                  )}

                  {selectedModules.size > 0 && (
                    <div className="mt-3 text-xs text-ink-2">
                      Deadlines will be removed. Modules and quizzes will start unpublished.
                    </div>
                  )}
                </div>
              )}

              <ModuleSelectionDrawer
                open={drawerOpen}
                onClose={() => setDrawerOpen(false)}
                modules={modules}
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
