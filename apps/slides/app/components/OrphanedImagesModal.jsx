import { useState, useEffect } from 'react';
import { Modal, Checkbox, Button, message, Spin } from 'antd';

/**
 * OrphanedImagesModal - Confirm deletion of unused images
 *
 * Shows thumbnails of images that are no longer referenced in the slide HTML.
 * User can uncheck any images they want to keep before confirming deletion.
 */
export default function OrphanedImagesModal({ open, images, onClose, onDelete, isDeleting }) {
  // Track which images are selected for deletion (all by default)
  const [selectedPaths, setSelectedPaths] = useState([]);

  // Reset selection when images change
  useEffect(() => {
    if (images?.length > 0) {
      setSelectedPaths(images.map((img) => img.path));
    } else {
      setSelectedPaths([]);
    }
  }, [images]);

  const handleToggle = (path) => {
    setSelectedPaths((prev) =>
      prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path]
    );
  };

  const handleSelectAll = () => {
    setSelectedPaths(images.map((img) => img.path));
  };

  const handleSelectNone = () => {
    setSelectedPaths([]);
  };

  const handleDelete = () => {
    if (selectedPaths.length === 0) {
      message.info('No images selected for deletion');
      return;
    }
    onDelete(selectedPaths);
  };

  const selectedCount = selectedPaths.length;
  const totalCount = images?.length || 0;

  return (
    <Modal
      title="Clean Up Unused Images"
      open={open}
      onCancel={onClose}
      width={600}
      footer={[
        <Button key="cancel" onClick={onClose} disabled={isDeleting}>
          Keep All
        </Button>,
        <Button
          key="delete"
          type="primary"
          danger
          onClick={handleDelete}
          disabled={selectedCount === 0 || isDeleting}
          loading={isDeleting}
        >
          {isDeleting
            ? 'Deleting...'
            : `Delete ${selectedCount} Image${selectedCount !== 1 ? 's' : ''}`}
        </Button>,
      ]}
    >
      <div className="space-y-4">
        <p className="text-gray-600 dark:text-gray-300">
          The following images are no longer used in this slide. Select which ones to delete:
        </p>

        {/* Select all / none buttons */}
        <div className="flex gap-2 text-sm">
          <button
            onClick={handleSelectAll}
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            Select all
          </button>
          <span className="text-gray-400">|</span>
          <button
            onClick={handleSelectNone}
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            Select none
          </button>
          <span className="ml-auto text-gray-500 dark:text-gray-400">
            {selectedCount} of {totalCount} selected
          </span>
        </div>

        {/* Image list */}
        <div className="max-h-80 overflow-y-auto space-y-2">
          {images?.map((image) => (
            <div
              key={image.path}
              className={`
                flex items-center gap-3 p-2 rounded-lg border transition-colors cursor-pointer
                ${selectedPaths.includes(image.path)
                  ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-900/20'
                  : 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800'
                }
              `}
              onClick={() => handleToggle(image.path)}
            >
              <Checkbox
                checked={selectedPaths.includes(image.path)}
                onChange={() => handleToggle(image.path)}
                onClick={(e) => e.stopPropagation()}
              />
              {/* Thumbnail */}
              <div className="w-16 h-16 shrink-0 bg-gray-200 dark:bg-gray-700 rounded-sm overflow-hidden">
                <img
                  src={image.url}
                  alt={image.name}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    e.target.style.display = 'none';
                  }}
                />
              </div>
              {/* File info */}
              <div className="flex-1 min-w-0">
                <p className="font-medium text-gray-900 dark:text-white truncate">
                  {image.name}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {image.path}
                </p>
              </div>
            </div>
          ))}
        </div>

        {/* Warning */}
        <p className="text-sm text-amber-600 dark:text-amber-400 flex items-center gap-2">
          <svg className="w-4 h-4 shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path
              fillRule="evenodd"
              d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
              clipRule="evenodd"
            />
          </svg>
          This action cannot be undone. Deleted images will be permanently removed from GitHub.
        </p>
      </div>
    </Modal>
  );
}
