import { useState, useCallback, useEffect, useMemo } from 'react';
import { Modal, Checkbox, Button, ConfigProvider, theme } from 'antd';
import { CloudOutlined, CheckCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { formatFileSize, getTotalSelectedSize } from '~/utils/zipAnalyzer';

// Check if dark mode is active
const useIsDarkMode = () => {
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const checkDark = () => setIsDark(document.documentElement.classList.contains('dark'));
    checkDark();
    const observer = new MutationObserver(checkDark);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  return isDark;
};

/**
 * VideoSelectionModal - Choose which videos to upload to Cloudinary during import
 *
 * When importing a slides.com ZIP, this modal appears if videos are detected.
 * Users can choose which videos to upload to Cloudinary (optimized CDN + transcoding)
 * vs keeping in GitHub (larger storage, no transcoding).
 *
 * Pre-selects:
 * - Videos larger than 5MB (better for CDN delivery)
 * - .mov files (need transcoding to play in browsers)
 */
export default function VideoSelectionModal({
  open,
  onClose,
  onConfirm,
  videos = [],
}) {
  // Track which video paths are selected for Cloudinary upload
  const [selectedPaths, setSelectedPaths] = useState(new Set());

  // Initialize selection with suggested videos when modal opens
  useEffect(() => {
    if (open && videos.length > 0) {
      const suggested = new Set(
        videos.filter(v => v.suggestCloudinary).map(v => v.path)
      );
      setSelectedPaths(suggested);
    }
  }, [open, videos]);

  // Toggle a single video selection
  const toggleVideo = useCallback((path) => {
    setSelectedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // Select all videos
  const selectAll = useCallback(() => {
    setSelectedPaths(new Set(videos.map(v => v.path)));
  }, [videos]);

  // Deselect all videos
  const selectNone = useCallback(() => {
    setSelectedPaths(new Set());
  }, []);

  // Select only recommended videos (large or .mov)
  const selectRecommended = useCallback(() => {
    setSelectedPaths(new Set(
      videos.filter(v => v.suggestCloudinary).map(v => v.path)
    ));
  }, [videos]);

  // Calculate totals
  const stats = useMemo(() => {
    const selectedSize = getTotalSelectedSize(videos, selectedPaths);
    const totalSize = videos.reduce((sum, v) => sum + v.size, 0);
    const unselectedSize = totalSize - selectedSize;

    return {
      selectedCount: selectedPaths.size,
      totalCount: videos.length,
      selectedSize,
      unselectedSize,
      totalSize,
    };
  }, [videos, selectedPaths]);

  // Handle confirm
  const handleConfirm = useCallback(() => {
    onConfirm([...selectedPaths]);
  }, [onConfirm, selectedPaths]);

  // Count of recommended videos
  const recommendedCount = useMemo(
    () => videos.filter(v => v.suggestCloudinary).length,
    [videos]
  );

  // Detect dark mode for Ant Design theming
  const isDarkMode = useIsDarkMode();

  return (
    <ConfigProvider
      theme={{
        algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
      }}
    >
      <Modal
        title={
          <div className="flex items-center gap-2">
            <CloudOutlined className="text-blue-500" />
            <span>Videos Detected</span>
          </div>
        }
        open={open}
        onCancel={onClose}
        width={600}
        footer={[
        <Button key="cancel" onClick={onClose}>
          Cancel Import
        </Button>,
        <Button
          key="confirm"
          type="primary"
          onClick={handleConfirm}
        >
          Continue Import
        </Button>,
      ]}
    >
      <div className="space-y-4">
        {/* Description */}
        <p className="text-gray-600 dark:text-gray-400 text-sm">
          This ZIP contains {videos.length} video{videos.length !== 1 ? 's' : ''}.
          Choose which videos to upload to <strong>Cloudinary</strong> for optimized
          delivery and format conversion. Unselected videos will be stored in GitHub.
        </p>

        {/* Quick select buttons */}
        <div className="flex gap-2 flex-wrap">
          <Button size="small" onClick={selectAll}>
            Select All
          </Button>
          <Button size="small" onClick={selectNone}>
            Select None
          </Button>
          {recommendedCount > 0 && recommendedCount !== videos.length && (
            <Button
              size="small"
              type="primary"
              ghost
              onClick={selectRecommended}
            >
              Select Recommended ({recommendedCount})
            </Button>
          )}
        </div>

        {/* Video list */}
        <div className="border dark:border-gray-700 rounded-lg overflow-hidden max-h-64 overflow-y-auto">
          {videos.map((video) => {
            const isSelected = selectedPaths.has(video.path);
            const isMovFile = video.ext === 'mov';

            return (
              <div
                key={video.path}
                className={`
                  flex items-center gap-3 px-4 py-3 border-b dark:border-gray-700 last:border-b-0
                  cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800
                  ${isSelected ? 'bg-blue-50 dark:bg-blue-900/20' : ''}
                `}
                onClick={() => toggleVideo(video.path)}
              >
                <Checkbox
                  checked={isSelected}
                  onChange={() => toggleVideo(video.path)}
                  onClick={(e) => e.stopPropagation()}
                />

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                    {video.filename}
                  </p>
                  <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <span>{formatFileSize(video.size)}</span>
                    <span>•</span>
                    <span className="uppercase">{video.ext}</span>
                    {video.suggestCloudinary && (
                      <>
                        <span>•</span>
                        <span className="text-blue-500 flex items-center gap-0.5">
                          <CheckCircleOutlined className="text-xs" />
                          Recommended
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {isMovFile && (
                  <div className="flex items-center gap-1 text-amber-500 text-xs whitespace-nowrap">
                    <WarningOutlined />
                    <span>Needs conversion</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Summary */}
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 text-sm">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-gray-500 dark:text-gray-400 mb-1">Cloudinary (optimized)</p>
              <p className="font-medium text-gray-900 dark:text-white">
                {stats.selectedCount} video{stats.selectedCount !== 1 ? 's' : ''}
                <span className="text-gray-400 font-normal ml-1">
                  ({formatFileSize(stats.selectedSize)})
                </span>
              </p>
            </div>
            <div>
              <p className="text-gray-500 dark:text-gray-400 mb-1">GitHub (as-is)</p>
              <p className="font-medium text-gray-900 dark:text-white">
                {stats.totalCount - stats.selectedCount} video{(stats.totalCount - stats.selectedCount) !== 1 ? 's' : ''}
                <span className="text-gray-400 font-normal ml-1">
                  ({formatFileSize(stats.unselectedSize)})
                </span>
              </p>
            </div>
          </div>
        </div>

        {/* Info about Cloudinary benefits */}
        <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
          <p>
            <strong>Cloudinary benefits:</strong> CDN delivery, auto-transcoding (.mov → .mp4),
            adaptive quality, reduced load times.
          </p>
          <p>
            <strong>GitHub storage:</strong> No transcoding, larger file sizes in repository,
            direct file serving.
          </p>
        </div>
      </div>
      </Modal>
    </ConfigProvider>
  );
}
