import { useState } from 'react';
import { Select, Switch, Avatar, Empty, Button, Tag } from 'antd';
import { EditOutlined, BookOutlined, FileTextOutlined, QuestionCircleOutlined } from '@ant-design/icons';
import ModuleSelectionDrawer from './ModuleSelectionDrawer';

const StepImportModules = ({
  ownedClassrooms,
  importEnabled,
  setImportEnabled,
  sourceClassroomId,
  setSourceClassroomId,
  selectedModules,
  setSelectedModules,
}) => {
  const [drawerOpen, setDrawerOpen] = useState(false);

  const sourceClassroom = ownedClassrooms.find(c => c.id === sourceClassroomId);
  const modules = sourceClassroom?.modules || [];

  const handleModuleToggle = (moduleId, checked) => {
    const newSelected = new Map(selectedModules);
    if (checked) {
      newSelected.set(moduleId, { includeQuizzes: false });
    } else {
      newSelected.delete(moduleId);
    }
    setSelectedModules(newSelected);
  };

  const handleQuizToggle = (moduleId, checked) => {
    const newSelected = new Map(selectedModules);
    const current = newSelected.get(moduleId) || {};
    newSelected.set(moduleId, { ...current, includeQuizzes: checked });
    setSelectedModules(newSelected);
  };

  const handleSourceChange = classroomId => {
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
    sourceClassroom.modules.forEach(m => {
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
      <div className="flex items-center justify-between p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
        <div>
          <div className="font-medium">Import from existing classroom</div>
          <div className="text-sm text-gray-500">
            Copy modules and assignments from another classroom you own
          </div>
        </div>
        <Switch
          checked={importEnabled}
          onChange={setImportEnabled}
        />
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
                <label className="block text-sm font-medium mb-2">
                  Select source classroom
                </label>
                <Select
                  placeholder="Choose a classroom to import from"
                  value={sourceClassroomId}
                  onChange={handleSourceChange}
                  className="w-full"
                  showSearch
                  optionFilterProp="children"
                  filterOption={(input, option) =>
                    option.children.toLowerCase().includes(input.toLowerCase())
                  }
                >
                  {ownedClassrooms.map(classroom => (
                    <Select.Option key={classroom.id} value={classroom.id}>
                      <div className="flex items-center gap-2">
                        {classroom.git_organization?.avatar_url && (
                          <Avatar src={classroom.git_organization.avatar_url} size={16} />
                        )}
                        <span>{classroom.name}</span>
                        <span className="text-gray-400">
                          ({classroom.term} {classroom.year})
                        </span>
                        <span className="text-gray-400 ml-auto">
                          {classroom.modules?.length || 0} modules
                        </span>
                      </div>
                    </Select.Option>
                  ))}
                </Select>
              </div>

              {sourceClassroomId && (
                <div className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg">
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
                      <Tag icon={<BookOutlined />} color="blue" style={{ minWidth: 100, textAlign: 'center' }}>
                        {selectedModules.size} module{selectedModules.size !== 1 ? 's' : ''}
                      </Tag>
                      <Tag icon={<FileTextOutlined />} color="green" style={{ minWidth: 100, textAlign: 'center' }}>
                        {totalAssignments} assignment{totalAssignments !== 1 ? 's' : ''}
                      </Tag>
                      {totalQuizzes > 0 && (
                        <Tag icon={<QuestionCircleOutlined />} color="purple" style={{ minWidth: 100, textAlign: 'center' }}>
                          {totalQuizzes} quiz{totalQuizzes !== 1 ? 'zes' : ''}
                        </Tag>
                      )}
                    </div>
                  ) : (
                    <div className="text-gray-500 text-sm">
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
                    <div className="mt-3 text-xs text-gray-500">
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
