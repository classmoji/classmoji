import { useState, useCallback } from 'react';
import { FloatButton, Drawer, Button, Space, Typography, Spin, Tooltip } from 'antd';
import { IconMessageChatbot, IconRefresh, IconArrowLeft } from '@tabler/icons-react';
import { useSyllabusBot } from '~/hooks/useSyllabusBot';
import SyllabusBotChat from './SyllabusBotChat';
import './styles.css';

const { Text, Title } = Typography;

/**
 * SyllabusBotWidget - Floating widget for the syllabus bot
 *
 * Renders a floating button that opens a drawer with the chat interface.
 * Only shows when syllabus bot is enabled for the classroom.
 */
const SyllabusBotWidget = ({
  classroomSlug,
  slidesUrl,
  userLogin,
  userRole,
  enabled = false,
  isDarkMode = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [hasInitialized, setHasInitialized] = useState(false);

  const {
    conversationId,
    messages,
    isStreaming,
    isInitializing,
    suggestedQuestions,
    error,
    isActive,
    initConversation,
    sendMessage,
    askSuggestedQuestion,
    endConversation,
    reset,
  } = useSyllabusBot({ classroomSlug, userRole });

  // Handle opening the widget
  const handleOpen = useCallback(async () => {
    setIsOpen(true);

    // Initialize conversation if not already active
    if (!isActive && !hasInitialized) {
      try {
        await initConversation();
        setHasInitialized(true);
      } catch (err) {
        console.error('[SyllabusBotWidget] Failed to initialize:', err);
      }
    }
  }, [isActive, hasInitialized, initConversation]);

  // Handle closing the widget
  const handleClose = useCallback(() => {
    setIsOpen(false);
    // Don't end conversation - keep it active for quick reopen
  }, []);

  // Handle reset/restart
  const handleReset = useCallback(async () => {
    try {
      await reset();
    } catch (err) {
      console.error('[SyllabusBotWidget] Failed to reset:', err);
    }
  }, [reset]);

  // Don't render if not enabled
  if (!enabled) {
    return null;
  }

  return (
    <>
      {/* Floating Button */}
      <FloatButton
        icon={<IconMessageChatbot size={26} className="relative right-[3.25px]" />}
        type="primary"
        tooltip={<span style={{ fontSize: '13px' }}>Course Assistant</span>}
        onClick={handleOpen}
        className="syllabus-bot-float-button"
        style={{
          right: 24,
          bottom: 24,
          width: 56,
          height: 56,
        }}
        badge={
          messages.length > 1
            ? {
                count: messages.length - 1,
                overflowCount: 9,
                color: 'red',
              }
            : undefined
        }
      />

      {/* Drawer */}
      <Drawer
        title={
          <Space align="center">
            <span style={{ fontSize: '20px' }}>📚</span>
            <span>Syllabusmoji</span>
          </Space>
        }
        placement="right"
        width={'35%'}
        onClose={handleClose}
        open={isOpen}
        destroyOnClose={false}
        extra={
          <Space>
            <Tooltip title="Start new conversation">
              <Button
                icon={<IconRefresh size={16} />}
                onClick={handleReset}
                disabled={isStreaming || isInitializing}
                size="small"
              />
            </Tooltip>
            <Button icon={<IconArrowLeft size={16} />} onClick={handleClose} size="small" />
          </Space>
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
          },
        }}
      >
        {/* Loading State */}
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

        {/* Chat Interface */}
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
    </>
  );
};

export default SyllabusBotWidget;
