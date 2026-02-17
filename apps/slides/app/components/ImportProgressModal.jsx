/**
 * ImportProgressModal - Real-time progress display for slide imports
 *
 * Shows a step-by-step progress view during imports with:
 * - Current step indicator with animation
 * - Progress bar for file-level operations (e.g., "Processing image 5/20")
 * - Error display with retry option
 * - Automatic navigation on completion
 */

import { useState, useEffect } from 'react';
import { Modal, Progress, Button, ConfigProvider, theme } from 'antd';
import {
  LoadingOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  FileZipOutlined,
  FileImageOutlined,
  VideoCameraOutlined,
  CloudUploadOutlined,
  GithubOutlined,
  FileTextOutlined,
} from '@ant-design/icons';

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

// Step definitions with labels and icons
const STEP_CONFIG = {
  extracting_zip: {
    label: 'Extracting ZIP archive',
    icon: FileZipOutlined,
  },
  parsing_html: {
    label: 'Parsing slide structure',
    icon: FileTextOutlined,
  },
  creating_repo: {
    label: 'Setting up repository',
    icon: GithubOutlined,
  },
  processing_images: {
    label: 'Processing images',
    icon: FileImageOutlined,
  },
  processing_videos: {
    label: 'Processing videos',
    icon: VideoCameraOutlined,
  },
  uploading_cloudinary: {
    label: 'Uploading to Cloudinary',
    icon: CloudUploadOutlined,
  },
  saving_theme: {
    label: 'Saving shared theme',
    icon: CloudUploadOutlined,
  },
  generating_html: {
    label: 'Generating HTML',
    icon: FileTextOutlined,
  },
  uploading_github: {
    label: 'Uploading to GitHub',
    icon: GithubOutlined,
  },
};

// Ordered list of steps for display
const STEP_ORDER = [
  'extracting_zip',
  'parsing_html',
  'processing_images',
  'processing_videos',
  'uploading_cloudinary',
  'saving_theme',
  'generating_html',
  'uploading_github',
];

/**
 * Get the status of a step relative to current progress
 */
function getStepStatus(stepKey, currentStep, isDone, hasError) {
  if (hasError) {
    // Find if error occurred at or after this step
    const errorIndex = STEP_ORDER.indexOf(currentStep);
    const thisIndex = STEP_ORDER.indexOf(stepKey);
    if (thisIndex < errorIndex) return 'completed';
    if (thisIndex === errorIndex) return 'error';
    return 'pending';
  }

  if (isDone) return 'completed';

  const currentIndex = STEP_ORDER.indexOf(currentStep);
  const thisIndex = STEP_ORDER.indexOf(stepKey);

  if (thisIndex < currentIndex) return 'completed';
  if (thisIndex === currentIndex) return 'active';
  return 'pending';
}

/**
 * Single step item in the progress list
 */
function StepItem({ stepKey, status, progress }) {
  const config = STEP_CONFIG[stepKey];
  if (!config) return null;

  const Icon = config.icon;
  const isActive = status === 'active';
  const isCompleted = status === 'completed';
  const isError = status === 'error';
  const isPending = status === 'pending';

  // Show progress for file-level operations
  const showProgress = isActive && progress?.total > 1;
  const hasFilename = isActive && progress?.filename;

  return (
    <div
      className={`
        flex items-start gap-3 py-2
        ${isPending ? 'opacity-40' : ''}
      `}
    >
      {/* Status icon */}
      <div className={`
        flex-shrink-0 w-6 h-6 flex items-center justify-center
        ${isCompleted ? 'text-green-500' : ''}
        ${isActive ? 'text-blue-500' : ''}
        ${isError ? 'text-red-500' : ''}
        ${isPending ? 'text-gray-400' : ''}
      `}>
        {isCompleted && <CheckCircleOutlined />}
        {isActive && <LoadingOutlined spin />}
        {isError && <CloseCircleOutlined />}
        {isPending && <Icon className="text-sm" />}
      </div>

      {/* Step content */}
      <div className="flex-1 min-w-0">
        <div className={`
          text-sm font-medium
          ${isCompleted ? 'text-gray-500 dark:text-gray-400' : ''}
          ${isActive ? 'text-gray-900 dark:text-white' : ''}
          ${isError ? 'text-red-600 dark:text-red-400' : ''}
          ${isPending ? 'text-gray-400 dark:text-gray-500' : ''}
        `}>
          {config.label}
          {showProgress && (
            <span className="ml-2 font-normal text-gray-500 dark:text-gray-400">
              ({progress.current}/{progress.total})
            </span>
          )}
        </div>

        {/* Filename for current file */}
        {hasFilename && (
          <div className="text-xs text-gray-400 dark:text-gray-500 truncate mt-0.5">
            {progress.filename}
          </div>
        )}

        {/* Progress bar for file operations */}
        {showProgress && (
          <Progress
            percent={Math.round((progress.current / progress.total) * 100)}
            size="small"
            showInfo={false}
            className="mt-1"
            strokeColor="#3b82f6"
          />
        )}
      </div>
    </div>
  );
}

export default function ImportProgressModal({
  open,
  progress,
  error,
  isDone,
  isConnected,
  onCancel,
  onRetry,
}) {
  const currentStep = progress?.step;

  // Detect dark mode for Ant Design theming
  const isDarkMode = useIsDarkMode();

  // Filter steps to only show relevant ones
  // (e.g., skip video steps if no videos)
  const visibleSteps = STEP_ORDER.filter((stepKey) => {
    // Always show if it's the current step or completed
    const status = getStepStatus(stepKey, currentStep, isDone, !!error);
    if (status !== 'pending') return true;

    // Skip video/cloudinary/theme steps if we're past images and never saw them
    if (stepKey === 'processing_videos' || stepKey === 'uploading_cloudinary' || stepKey === 'saving_theme') {
      const imageIndex = STEP_ORDER.indexOf('processing_images');
      const currentIndex = STEP_ORDER.indexOf(currentStep);
      // If we're past images and this step was never active, skip it
      if (currentIndex > imageIndex && status === 'pending') {
        return false;
      }
    }

    return true;
  });

  return (
    <ConfigProvider
      theme={{
        algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm,
      }}
    >
      <Modal
        title={
          <div className="flex items-center gap-2">
            {isDone ? (
              <CheckCircleOutlined className="text-green-500" />
            ) : error ? (
              <CloseCircleOutlined className="text-red-500" />
            ) : (
              <LoadingOutlined spin className="text-blue-500" />
            )}
            <span>
              {isDone
                ? 'Import Complete'
                : error
                  ? 'Import Failed'
                  : 'Importing Slides...'}
            </span>
          </div>
        }
        open={open}
        closable={false}
        maskClosable={false}
        width={480}
        footer={
        error
          ? [
              <Button key="cancel" onClick={onCancel}>
                Cancel
              </Button>,
              <Button key="retry" type="primary" onClick={onRetry}>
                Try Again
              </Button>,
            ]
          : isDone
            ? null // No footer when done - will auto-navigate
            : [
                <Button key="cancel" onClick={onCancel} disabled={isConnected}>
                  Cancel
                </Button>,
              ]
      }
    >
      <div className="space-y-1">
        {/* Connection status */}
        {!isConnected && !isDone && !error && (
          <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-2 mb-4">
            <LoadingOutlined spin />
            Connecting to import stream...
          </div>
        )}

        {/* Step list */}
        {visibleSteps.map((stepKey) => (
          <StepItem
            key={stepKey}
            stepKey={stepKey}
            status={getStepStatus(stepKey, currentStep, isDone, !!error)}
            progress={currentStep === stepKey ? progress : null}
          />
        ))}

        {/* Error message */}
        {error && (
          <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-md">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        {/* Success message */}
        {isDone && (
          <div className="mt-4 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-md">
            <p className="text-sm text-green-600 dark:text-green-400">
              Slides imported successfully! Redirecting to editor...
            </p>
          </div>
        )}
      </div>
    </Modal>
    </ConfigProvider>
  );
}
