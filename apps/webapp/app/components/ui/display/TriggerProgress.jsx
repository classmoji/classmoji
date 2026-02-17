import { useState, useEffect, useRef, useMemo } from 'react';
import { TriggerAuthContext, useRealtimeRunsWithTag } from '@trigger.dev/react-hooks';

import { Modal, Collapse, ConfigProvider, Progress, Tag, Button } from 'antd';
import { CheckCircleFilled, WarningFilled, ArrowDownOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';

import { useGlobalFetcher, useDisclosure, useDarkMode } from '~/hooks';

import { BRAND, BRAND_LIGHT } from '~/config/theme';

// Theme colors matching the app's theme
const THEME = {
  primary: BRAND, // Brand accent
  primaryHover: BRAND_LIGHT,
  success: '#10b981',
  error: '#ef4444',
  warning: '#f59e0b',
};

// Status priority for sorting (lower = higher priority, shown first)
const STATUS_PRIORITY = {
  FAILED: 0,
  CRASHED: 0,
  'SYSTEM FAILURE': 0,
  'TIMED OUT': 0,
  EXECUTING: 1,
  WAITING: 1,
  QUEUED: 2,
  DEQUEUED: 2,
  DELAYED: 2,
  'PENDING VERSION': 2,
  COMPLETED: 3,
  CANCELED: 4,
  EXPIRED: 4,
  FROZEN: 4,
};

const TriggerProgress = ({ callback, validIdentifiers, operation }) => {
  const { fetcher } = useGlobalFetcher();
  const [logs, setLogs] = useState([]);
  const { close, show, visible } = useDisclosure();
  const completedRunsSet = useRef(new Set());
  const [completedCount, setCompletedCount] = useState(0);
  const isDarkMode = useDarkMode();

  const session = fetcher.data?.triggerSession;

  useEffect(() => {
    if (visible == false && fetcher.data?.triggerSession) {
      show();
    } else if (visible == true && !fetcher.data?.triggerSession) {
      close();
    }
  }, [fetcher.data?.triggerSession]);

  const totalNumRuns = session
    ? {
        PUBLISH_OR_SYNC_ASSIGNMENT:
          session.numReposToCreate + session.numReposToCreate / 2 + session.numIssuesToCreate,
        SYNC_ROSTER: session.numStudentsToSync,
        ADD_STUDENTS: session.numStudentsToSync,
        DELETE_REPOS: session.numReposToDelete,
        ASSIGN_TOKENS_TO_STUDENT: session.numStudentsToAssignTokens,
        ASSIGN_GRADERS_TO_ASSIGNMENTS: session.numAssignmentsToAddGradersTo,
        CALCULATE_REPO_CONTRIBUTIONS: session.numRepos,
        UPDATE_REPOS: session.numReposToUpdate,
        BATCH_IMPORT_PAGES: session.numPagesToImport,
      }
    : {};

  const shouldShow = session && totalNumRuns[operation] > 0;
  const totalCount = totalNumRuns[operation];
  const progressPercent = Math.floor((completedCount / totalCount) * 100);

  // Calculate status counts from logs
  const statusCounts = useMemo(() => {
    const counts = { running: 0, completed: 0, failed: 0, queued: 0 };
    logs.forEach(log => {
      if (['EXECUTING', 'WAITING'].includes(log.status)) {
        counts.running++;
      } else if (log.status === 'COMPLETED') {
        counts.completed++;
      } else if (['FAILED', 'CRASHED', 'SYSTEM FAILURE', 'TIMED OUT'].includes(log.status)) {
        counts.failed++;
      } else {
        counts.queued++;
      }
    });
    return counts;
  }, [logs]);

  const isComplete = progressPercent === 100;
  const hasFailed = statusCounts.failed > 0;

  if (!shouldShow) return null;

  const handleClose = () => {
    if (callback) {
      callback();
    }

    fetcher.reset();
    completedRunsSet.current.clear();
    setCompletedCount(0);
    close();
  };

  return (
    <Modal
      title={
        <div className="flex items-center gap-3">
          <div className="w-1 h-6 rounded-full" style={{ backgroundColor: THEME.primary }}></div>
          <div>
            <h3 className="text-lg font-semibold">Operation Progress</h3>
            <p className="text-sm opacity-60 font-normal">
              {operation.toLowerCase().replace(/_/g, ' ')} in progress...
            </p>
          </div>
        </div>
      }
      footer={
        <div className="flex justify-end">
          <Button type="primary" onClick={handleClose}>
            Close
          </Button>
        </div>
      }
      open={visible}
      size="large"
      width={Math.min(window.innerWidth * 0.6, 800)}
      onCancel={handleClose}
      style={{ top: 40 }}
      styles={{
        content: {
          maxHeight: '90vh',
        },
      }}
      className="trigger-progress-modal"
    >
      {session && (
        <div className="mb-4">
          {/* Completion Banner */}
          {isComplete && (
            <div
              className={`mb-4 p-3 rounded-lg flex items-center gap-3 border ${
                hasFailed
                  ? 'bg-red-500/10 border-red-500/30 dark:bg-red-900/30 dark:border-red-700'
                  : 'bg-green-500/10 border-green-500/30 dark:bg-green-900/30 dark:border-green-700'
              }`}
            >
              {hasFailed ? (
                <WarningFilled style={{ color: THEME.error, fontSize: 20 }} />
              ) : (
                <CheckCircleFilled style={{ color: THEME.success, fontSize: 20 }} />
              )}
              <span
                className={
                  hasFailed
                    ? 'text-red-600 dark:text-red-300'
                    : 'text-green-600 dark:text-green-300'
                }
              >
                {hasFailed
                  ? `Operation completed with ${statusCounts.failed} error${statusCounts.failed > 1 ? 's' : ''}`
                  : 'Operation completed successfully!'}
              </span>
            </div>
          )}

          {/* Progress Bar */}
          <div className="flex-1">
            <Progress
              percent={progressPercent}
              strokeColor={THEME.primary}
              strokeWidth={10}
              showInfo={false}
            />
          </div>

          {/* Status Summary Bar */}
          <div className="flex items-center gap-6 mt-3 py-2 px-3 bg-gray-900 rounded-lg border border-gray-700">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-gray-100">{progressPercent}%</span>
              <span className="text-sm text-gray-400">complete</span>
            </div>
            <div className="w-px h-4 bg-gray-700"></div>
            {statusCounts.running > 0 && (
              <div className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full animate-pulse"
                  style={{ backgroundColor: THEME.primary }}
                ></span>
                <span className="text-sm font-medium" style={{ color: THEME.primary }}>
                  {statusCounts.running} Running
                </span>
              </div>
            )}
            <div className="flex items-center gap-2">
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: THEME.success }}
              ></span>
              <span className="text-sm font-medium text-green-600 dark:text-green-400">
                {statusCounts.completed} Completed
              </span>
            </div>
            {statusCounts.failed > 0 && (
              <div className="flex items-center gap-2">
                <span
                  className="w-2 h-2 rounded-full"
                  style={{ backgroundColor: THEME.error }}
                ></span>
                <span className="text-sm font-medium text-red-600 dark:text-red-400">
                  {statusCounts.failed} Failed
                </span>
              </div>
            )}
            {statusCounts.queued > 0 && (
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-gray-400"></span>
                <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                  {statusCounts.queued} Queued
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4">
        <TriggerAuthContext.Provider value={{ accessToken: session.accessToken }}>
          <TagsLoader
            tag={`session_${session.id}`}
            setLogs={setLogs}
            completedRunsSet={completedRunsSet}
            validIdentifiers={validIdentifiers}
            setCompletedCount={setCompletedCount}
          />

          <AllTasksDisplay logs={logs} isDarkMode={isDarkMode} />
          <LogDisplay logs={logs} isDarkMode={isDarkMode} />
        </TriggerAuthContext.Provider>
      </div>
    </Modal>
  );
};

const TagsLoader = ({ tag, setLogs, completedRunsSet, validIdentifiers, setCompletedCount }) => {
  const { runs, error } = useRealtimeRunsWithTag(tag);
  const identifiers = new Set(validIdentifiers);

  useEffect(() => {
    if (runs.length === 0) return;
    if (runs.length > 0) {
      setLogs(runs);

      runs.forEach(({ id, taskIdentifier, status }) => {
        if (status !== 'COMPLETED') return;

        if (identifiers.has(taskIdentifier)) {
          completedRunsSet.current.add(id);
          setCompletedCount(completedRunsSet.current.size);
        }
      });
    }
  }, [runs]);

  if (error) {
    return (
      <div className="bg-red-500/10 dark:bg-red-900/30 border border-red-500/30 dark:border-red-700 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2">
          <WarningFilled style={{ color: THEME.error }} />
          <div className="text-red-600 dark:text-red-300 font-medium">Error loading progress:</div>
        </div>
        <div className="text-red-500 dark:text-red-400 text-sm">{error.message}</div>
      </div>
    );
  }

  return null;
};

const ERROR_STATUSES = ['FAILED', 'CRASHED', 'SYSTEM FAILURE', 'TIMED OUT'];

// Collapsible section showing all tasks sorted by status priority
const AllTasksDisplay = ({ logs, isDarkMode }) => {
  // Sort all logs by status priority (errors first, then executing, queued, completed)
  const sortedLogs = useMemo(() => {
    return [...logs].sort((a, b) => {
      const priorityA = STATUS_PRIORITY[a.status] ?? 5;
      const priorityB = STATUS_PRIORITY[b.status] ?? 5;
      if (priorityA !== priorityB) return priorityA - priorityB;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
  }, [logs]);

  if (logs.length === 0) {
    return null;
  }

  const panelItems = sortedLogs.map((log, index) => ({
    key: log.id || index,
    showArrow: false,
    label: <LogLabel data={log} isDarkMode={isDarkMode} />,
    children: <LogContent data={log} />,
  }));

  const collapseItems = [
    {
      key: 'task-details',
      label: (
        <div className="flex items-center gap-3">
          <div className="w-1 h-4 rounded-full" style={{ backgroundColor: THEME.primary }}></div>
          <span className="font-medium text-gray-100">Task Details</span>
          <Tag>
            {logs.length} task{logs.length !== 1 ? 's' : ''}
          </Tag>
        </div>
      ),
      children: (
        <div className="p-3 overflow-auto max-h-[45vh] font-mono text-sm">
          <ConfigProvider
            theme={{
              components: {
                Collapse: {
                  headerPadding: '0 0',
                  contentPadding: '0 0 0 0',
                },
              },
            }}
          >
            <Collapse items={panelItems} ghost className="bg-transparent" />
          </ConfigProvider>
        </div>
      ),
    },
  ];

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-700">
      <ConfigProvider
        theme={{
          components: {
            Collapse: {
              headerPadding: '12px 16px',
              contentPadding: '0',
            },
          },
        }}
      >
        <Collapse items={collapseItems} ghost className="bg-transparent" expandIconPosition="end" />
      </ConfigProvider>
    </div>
  );
};

const LogDisplay = ({ logs, isDarkMode }) => {
  const logRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Filter to only show errors, sorted by time (newest first)
  const errorLogs = useMemo(() => {
    return logs
      .filter(log => ERROR_STATUSES.includes(log.status))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }, [logs]);

  // Auto-scroll effect
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Handle scroll to detect manual scrolling
  const handleScroll = () => {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;

    if (!isAtBottom && autoScroll) {
      setAutoScroll(false);
      setShowScrollButton(true);
    } else if (isAtBottom && !autoScroll) {
      setAutoScroll(true);
      setShowScrollButton(false);
    }
  };

  const scrollToBottom = () => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
      setAutoScroll(true);
      setShowScrollButton(false);
    }
  };

  const items = errorLogs.map((log, index) => ({
    key: log.id || index,
    showArrow: false,
    label: <LogLabel data={log} isDarkMode={isDarkMode} />,
    children: <LogContent data={log} />,
  }));

  // Don't render anything if there are no errors
  if (errorLogs.length === 0) {
    return null;
  }

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-700 relative">
      <div className="flex items-center gap-3 p-3 border-b border-gray-700">
        <div className="w-1 h-4 rounded-full" style={{ backgroundColor: THEME.error }}></div>
        <h4 className="font-medium text-gray-100">Errors</h4>
        <Tag color="red">
          {errorLogs.length} error{errorLogs.length > 1 ? 's' : ''}
        </Tag>
      </div>

      <div
        ref={logRef}
        onScroll={handleScroll}
        className="p-3 overflow-auto max-h-[45vh] font-mono text-sm scroll-smooth"
      >
        <ConfigProvider
          theme={{
            components: {
              Collapse: {
                headerPadding: '0 0',
                contentPadding: '0 0 0 0',
              },
            },
          }}
        >
          <Collapse items={items} ghost className="bg-transparent" />
        </ConfigProvider>
      </div>

      {/* Jump to Latest Button */}
      {showScrollButton && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2">
          <Button
            size="small"
            icon={<ArrowDownOutlined />}
            onClick={scrollToBottom}
            style={{
              backgroundColor: THEME.primary,
              borderColor: THEME.primary,
              color: '#000',
              fontWeight: 500,
            }}
          >
            Jump to latest
          </Button>
        </div>
      )}
    </div>
  );
};

const LogLabel = ({ data, isDarkMode }) => {
  const { taskIdentifier, status, updatedAt } = data;

  const statusConfig = {
    // Initial states
    'PENDING VERSION': {
      color: '#a855f7',
      bg: isDarkMode ? 'rgba(168, 85, 247, 0.2)' : 'rgba(168, 85, 247, 0.1)',
    },
    DELAYED: {
      color: '#6366f1',
      bg: isDarkMode ? 'rgba(99, 102, 241, 0.2)' : 'rgba(99, 102, 241, 0.1)',
    },
    QUEUED: {
      color: '#f97316',
      bg: isDarkMode ? 'rgba(249, 115, 22, 0.2)' : 'rgba(249, 115, 22, 0.1)',
    },
    DEQUEUED: {
      color: '#06b6d4',
      bg: isDarkMode ? 'rgba(6, 182, 212, 0.2)' : 'rgba(6, 182, 212, 0.1)',
    },

    // Execution states
    EXECUTING: {
      color: THEME.primary,
      bg: isDarkMode ? 'rgba(16, 185, 129, 0.2)' : 'rgba(16, 185, 129, 0.15)',
    },
    WAITING: {
      color: '#3b82f6',
      bg: isDarkMode ? 'rgba(59, 130, 246, 0.2)' : 'rgba(59, 130, 246, 0.1)',
    },

    // Final states
    COMPLETED: {
      color: THEME.success,
      bg: isDarkMode ? 'rgba(16, 185, 129, 0.2)' : 'rgba(16, 185, 129, 0.1)',
    },
    CANCELED: {
      color: '#6b7280',
      bg: isDarkMode ? 'rgba(107, 114, 128, 0.2)' : 'rgba(107, 114, 128, 0.1)',
    },
    FAILED: {
      color: THEME.error,
      bg: isDarkMode ? 'rgba(239, 68, 68, 0.2)' : 'rgba(239, 68, 68, 0.1)',
    },
    'TIMED OUT': {
      color: '#dc2626',
      bg: isDarkMode ? 'rgba(220, 38, 38, 0.25)' : 'rgba(220, 38, 38, 0.1)',
    },
    CRASHED: {
      color: '#b91c1c',
      bg: isDarkMode ? 'rgba(185, 28, 28, 0.3)' : 'rgba(185, 28, 28, 0.1)',
    },
    'SYSTEM FAILURE': {
      color: '#991b1b',
      bg: isDarkMode ? 'rgba(153, 27, 27, 0.35)' : 'rgba(153, 27, 27, 0.1)',
    },
    EXPIRED: {
      color: '#c2410c',
      bg: isDarkMode ? 'rgba(194, 65, 12, 0.25)' : 'rgba(194, 65, 12, 0.1)',
    },

    // Legacy state
    FROZEN: {
      color: '#3b82f6',
      bg: isDarkMode ? 'rgba(59, 130, 246, 0.2)' : 'rgba(59, 130, 246, 0.1)',
    },
  };

  const config = statusConfig[status] || {
    color: THEME.error,
    bg: isDarkMode ? 'rgba(239, 68, 68, 0.2)' : 'rgba(239, 68, 68, 0.1)',
  };

  // Get left border color based on status category
  const getLeftBorderColor = () => {
    if (['FAILED', 'CRASHED', 'SYSTEM FAILURE', 'TIMED OUT'].includes(status)) {
      return THEME.error;
    }
    if (['EXECUTING', 'WAITING'].includes(status)) {
      return THEME.primary;
    }
    if (status === 'COMPLETED') {
      return THEME.success;
    }
    return '#9ca3af';
  };

  const getTaskDisplayName = task => {
    return task
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ')
      .toLowerCase();
  };

  const getTaskInfo = () => {
    const info = [];

    if (taskIdentifier === 'assign_tokens_to_student') {
      info.push(`${data.payload.student.name} → ${data.payload.amount} tokens`);
    }

    if (taskIdentifier === 'remove_user_from_organization') {
      info.push(data.payload.user.name);
    }

    if (taskIdentifier === 'send_email') {
      info.push(data.payload.payload.to);
    }

    if (taskIdentifier === 'import_page') {
      info.push(data.payload.pageData?.title || 'Page');
    }

    if (data.payload.repoName) {
      info.push(data.payload.repoName);
    }

    if (data.payload.issue) {
      info.push(`Issue: ${data.payload.issue.title}`);
    }

    if (data.payload.name && !info.length) {
      info.push(data.payload.name);
    }

    return info.join(' | ');
  };

  return (
    <div
      className="flex items-center gap-2 py-1.5 px-2 -mx-2 rounded hover:bg-gray-200/50 dark:hover:bg-gray-700/50 transition-colors"
      style={{ borderLeft: `3px solid ${getLeftBorderColor()}` }}
    >
      <span className="text-gray-500 dark:text-gray-400 text-xs font-mono min-w-[60px]">
        {dayjs(updatedAt).format('HH:mm:ss')}
      </span>

      <Tag
        style={{
          backgroundColor: config.bg,
          color: config.color,
          border: `1px solid ${config.color}40`,
          fontSize: '11px',
          fontWeight: 600,
          padding: '1px 8px',
          minWidth: '80px',
          textAlign: 'center',
        }}
      >
        {status}
      </Tag>

      <span style={{ color: THEME.primary }} className="font-medium text-sm">
        [{getTaskDisplayName(taskIdentifier)}]
      </span>

      {getTaskInfo() && (
        <span className="text-gray-300 text-sm truncate max-w-[250px]">{getTaskInfo()}</span>
      )}
    </div>
  );
};

const LogContent = ({ data }) => {
  const { payload } = data;

  let log = {};

  if (payload.assignment) log.assignment = payload.assignment.title;
  if (payload.repoName) log.repoName = payload.repoName;
  if (payload.student) log.student = payload.student.name;
  if (payload.issue) log.issue = payload.issue.title;
  if (payload.pageData) {
    log.page = payload.pageData.title;
    log.type = payload.pageData.type;
    if (payload.pageData.module) log.module = payload.pageData.module;
  }

  return (
    <div className="bg-black rounded-md p-3 mt-2 ml-4 border border-gray-700">
      <code className="text-green-400 text-xs">{JSON.stringify(log, null, 2)}</code>
    </div>
  );
};

export default TriggerProgress;
