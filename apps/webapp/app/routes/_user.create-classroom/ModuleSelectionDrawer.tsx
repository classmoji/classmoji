import { Drawer, Button } from 'antd';
import ModuleImportTable from './ModuleImportTable';
import type { ClassroomModule, ModuleConfig } from './types';

interface ModuleSelectionDrawerProps {
  open: boolean;
  onClose: () => void;
  repositories: ClassroomModule[];
  selectedModules: Map<string, ModuleConfig>;
  onModuleToggle: (moduleId: string, checked: boolean) => void;
  onQuizToggle: (moduleId: string, checked: boolean) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
}

const ModuleSelectionDrawer = ({
  open,
  onClose,
  repositories,
  selectedModules,
  onModuleToggle,
  onQuizToggle,
  onSelectAll,
  onDeselectAll,
}: ModuleSelectionDrawerProps) => {
  return (
    <Drawer
      title="Select Repositories to Import"
      placement="right"
      width={720}
      open={open}
      onClose={onClose}
      extra={
        <div className="flex gap-2">
          <Button size="small" onClick={onSelectAll}>
            Select All
          </Button>
          <Button size="small" onClick={onDeselectAll}>
            Deselect All
          </Button>
        </div>
      }
    >
      <ModuleImportTable
        repositories={repositories}
        selectedModules={selectedModules}
        onModuleToggle={onModuleToggle}
        onQuizToggle={onQuizToggle}
      />
      <div className="mt-4 text-sm text-gray-500">
        {selectedModules.size > 0 ? (
          <span>
            {selectedModules.size} repository{selectedModules.size !== 1 ? 's' : ''} selected
          </span>
        ) : (
          <span>No repositories selected</span>
        )}
      </div>
    </Drawer>
  );
};

export default ModuleSelectionDrawer;
