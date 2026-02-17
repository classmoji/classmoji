import { Popconfirm } from 'antd';
import { IconEye, IconPencil, IconTrash, IconRobot } from '@tabler/icons-react';

const TableActionButtons = ({
  onView,
  onEdit,
  onDelete,
  onAutograde,
  children,
  deleteConfirmTitle = 'Delete',
  deleteConfirmDescription = 'Are you sure you want to delete this?',
  hideViewText = false,
  hideDeleteText = false,
  skipDeleteConfirm = false,
}) => {
  const size = 17;

  return (
    <div className="flex gap-3 items-center">
      {onView && (
        <div
          onClick={onView}
          className="flex items-center gap-1 text-gray-600 hover:text-gray-800 cursor-pointer"
        >
          <IconEye size={size} />
          {!hideViewText && <span>View</span>}
        </div>
      )}

      {onEdit && (
        <div
          onClick={onEdit}
          className="flex items-center gap-1 text-gray-600 hover:text-gray-800 cursor-pointer"
        >
          <IconPencil size={size} />
          <span>Edit</span>
        </div>
      )}

      {onAutograde && (
        <div
          onClick={onAutograde}
          className="flex items-center gap-1 text-gray-600 hover:text-gray-800 cursor-pointer"
        >
          <IconRobot size={size} />
          <span>Autograde</span>
        </div>
      )}

      {children}

      {onDelete && (
        skipDeleteConfirm ? (
          <div
            onClick={onDelete}
            className="flex items-center gap-1 text-red-600 cursor-pointer hover:text-red-700 delete-react-intro"
          >
            <IconTrash size={size} />
            {!hideDeleteText && <span>Delete</span>}
          </div>
        ) : (
          <Popconfirm
            title={deleteConfirmTitle}
            description={deleteConfirmDescription}
            onConfirm={e => {
              e.stopPropagation();
              onDelete();
            }}
            onCancel={() => {}}
            okButtonProps={{ danger: true }}
            okText="Delete"
            cancelText="Cancel"
          >
            <div className="flex items-center gap-1 text-red-600 cursor-pointer hover:text-red-700 delete-react-intro">
              <IconTrash size={size} />
              {!hideDeleteText && <span>Delete</span>}
            </div>
          </Popconfirm>
        )
      )}
    </div>
  );
};

export default TableActionButtons;
