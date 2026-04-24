import { useState, useCallback, useEffect } from 'react';
import { Drawer, Button, Spin, Tooltip, Typography } from 'antd';
import { IconRefresh, IconX, IconApple } from '@tabler/icons-react';
import { useSyllabusBot } from '~/hooks/useSyllabusBot';
import SyllabusBotChat from './SyllabusBotChat';
import './styles.css';

const { Text } = Typography;

/**
 * SyllabusBotWidget - Drawer-only chat surface for the syllabus bot.
 *
 * The trigger lives in the sidebar ("Ask Moji" nav item); this component is a
 * controlled drawer driven by isOpen/onClose. It still owns conversation
 * lifecycle (init on first open, reset, etc).
 */
interface SyllabusBotWidgetProps {
  classroomSlug: string;
  slidesUrl: string;
  userLogin: string | null;
  userRole: string;
  isOpen: boolean;
  onClose: () => void;
  isDarkMode?: boolean;
}

const SyllabusBotWidget = ({
  classroomSlug,
  slidesUrl,
  userLogin,
  userRole,
  isOpen,
  onClose,
  isDarkMode = false,
}: SyllabusBotWidgetProps) => {
  const [hasInitialized, setHasInitialized] = useState(false);

  const {
    conversationId: _conversationId,
    messages,
    isStreaming,
    isInitializing,
    suggestedQuestions,
    error,
    isActive,
    initConversation,
    sendMessage,
    askSuggestedQuestion,
    endConversation: _endConversation,
    reset,
  } = useSyllabusBot({ classroomSlug, userRole });

  // Initialize conversation the first time the drawer opens
  useEffect(() => {
    if (!isOpen) return;
    if (isActive || hasInitialized) return;

    let cancelled = false;
    (async () => {
      try {
        await initConversation();
        if (!cancelled) setHasInitialized(true);
      } catch (err: unknown) {
        console.error('[SyllabusBotWidget] Failed to initialize:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, isActive, hasInitialized, initConversation]);

  const handleReset = useCallback(async () => {
    try {
      await reset();
    } catch (err: unknown) {
      console.error('[SyllabusBotWidget] Failed to reset:', err);
    }
  }, [reset]);

  return (
    <Drawer
      title={
        <div className="flex items-center gap-3">
          <div
            className="flex items-center justify-center w-9 h-9 rounded-full text-white shrink-0"
            style={{ backgroundColor: 'var(--accent)' }}
          >
            <IconApple size={20} strokeWidth={1.75} />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="font-semibold text-gray-900 dark:text-gray-100">Ask Moji</span>
            <span className="text-xs font-normal text-gray-500 dark:text-gray-400">
              Course Assistant
            </span>
          </div>
        </div>
      }
      placement="right"
      width={440}
      onClose={onClose}
      open={isOpen}
      destroyOnClose={false}
      closeIcon={null}
      extra={
        <div className="flex items-center gap-1">
          <Tooltip title="Start new conversation">
            <Button
              type="text"
              icon={<IconRefresh size={16} />}
              onClick={handleReset}
              disabled={isStreaming || isInitializing}
              size="small"
            />
          </Tooltip>
          <Tooltip title="Close">
            <Button type="text" icon={<IconX size={18} />} onClick={onClose} size="small" />
          </Tooltip>
        </div>
      }
      styles={{
        body: {
          padding: 0,
          height: 'calc(100vh - 110px)',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: isDarkMode ? '#111827' : '#fff',
        },
        header: {
          backgroundColor: isDarkMode ? '#1f2937' : '#fff',
          borderBottom: isDarkMode ? '1px solid #374151' : '1px solid #f0f0f0',
          padding: '14px 20px',
        },
      }}
    >
      {isInitializing && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: '16px',
          }}
        >
          <Spin size="large" />
          <Text
            style={{
              color: isDarkMode ? '#9ca3af' : '#666',
            }}
          >
            Connecting to course assistant...
          </Text>
        </div>
      )}

      {!isInitializing && (
        <SyllabusBotChat
          messages={messages}
          isStreaming={isStreaming}
          suggestedQuestions={suggestedQuestions}
          error={error}
          onSendMessage={sendMessage}
          onAskSuggestedQuestion={askSuggestedQuestion}
          classroomSlug={classroomSlug}
          slidesUrl={slidesUrl}
          userLogin={userLogin}
          isDarkMode={isDarkMode}
        />
      )}
    </Drawer>
  );
};

export default SyllabusBotWidget;
