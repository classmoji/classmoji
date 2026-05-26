import { useState, useCallback, useEffect, useRef } from 'react';
import { IconRefresh } from '@tabler/icons-react';
import { Tooltip } from 'antd';
import { useSyllabusBot } from '~/hooks/useSyllabusBot';
import useStore from '~/store';
import SyllabusBotChat from './SyllabusBotChat';
import './styles.css';

interface SyllabusBotWidgetProps {
  classroomSlug: string;
  slidesUrl: string;
  userLogin: string | null;
  userRole: string;
  isOpen: boolean;
  onClose: () => void;
  courseName?: string;
  orgName?: string;
}

type PanelState = 'opening' | 'open' | 'closing' | 'closed';

function getGenieOffset(panelEl: HTMLElement | null) {
  const trigger = document.querySelector('[data-askmoji-trigger]');
  if (!trigger || !panelEl) {
    return { x: -300, y: 120 };
  }
  const tr = trigger.getBoundingClientRect();
  const pr = panelEl.getBoundingClientRect();
  return {
    x: tr.left + tr.width / 2 - (pr.left + pr.width / 2),
    y: tr.top + tr.height / 2 - (pr.top + pr.height / 2),
  };
}

const SyllabusBotWidget = ({
  classroomSlug,
  slidesUrl,
  userLogin,
  userRole,
  isOpen,
  onClose,
  courseName,
  orgName,
}: SyllabusBotWidgetProps) => {
  const [hasInitialized, setHasInitialized] = useState(false);
  const [panelState, setPanelState] = useState<PanelState>('closed');
  const [expanded, setExpanded] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const setAskMojiActive = useStore(s => s.setAskMojiActive);

  const {
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

  const applyGenieVars = useCallback(() => {
    const el = panelRef.current;
    if (!el) return;
    const { x, y } = getGenieOffset(el);
    el.style.setProperty('--genie-x', `${x}px`);
    el.style.setProperty('--genie-y', `${y}px`);
  }, []);

  useEffect(() => {
    if (isOpen && panelState === 'closed') {
      setPanelState('opening');
      setAskMojiActive(true);
    } else if (!isOpen && panelState === 'open') {
      setPanelState('closed');
      setAskMojiActive(false);
      setHasInitialized(false);
      endConversation();
    }
  }, [isOpen, panelState, setAskMojiActive, endConversation]);

  useEffect(() => {
    if (panelState === 'opening' || panelState === 'closing') {
      requestAnimationFrame(applyGenieVars);
    }
  }, [panelState, applyGenieVars]);

  const handleAnimationEnd = useCallback(() => {
    if (panelState === 'opening') {
      setPanelState('open');
    } else if (panelState === 'closing') {
      setPanelState('closed');
    }
  }, [panelState]);

  useEffect(() => {
    if (panelState !== 'opening') return;
    if (isActive || hasInitialized) return;

    let cancelled = false;
    (async () => {
      try {
        await initConversation();
        if (!cancelled) {
          setHasInitialized(true);
        }
      } catch (err: unknown) {
        console.error('[SyllabusBotWidget] Failed to initialize:', err);
      }
    })();

    return () => { cancelled = true; };
  }, [panelState, isActive, hasInitialized, initConversation, setAskMojiActive]);

  const handleClose = useCallback(async () => {
    onClose();
    setPanelState('closed');
    setAskMojiActive(false);
    setHasInitialized(false);
    await endConversation();
  }, [onClose, setAskMojiActive, endConversation]);

  const handleReset = useCallback(async () => {
    try {
      await reset();
    } catch (err: unknown) {
      console.error('[SyllabusBotWidget] Failed to reset:', err);
    }
  }, [reset]);

  if (panelState === 'closed') return null;

  const displayName = courseName || orgName || 'Course Assistant';

  return (
    <div
      ref={panelRef}
      className="askmoji-panel"
      data-state={panelState}
      {...(expanded ? { 'data-expanded': '' } : {})}
      onAnimationEnd={handleAnimationEnd}
    >
      {/* Header */}
      <div className="askmoji-header">
        <div className="askmoji-dots">
          <span className="askmoji-status-dot" />
          <div className="askmoji-dot-actions">
            <button
              type="button"
              className="askmoji-dot-btn askmoji-dot-btn--close"
              onClick={handleClose}
              aria-label="Close"
            >
              <svg width="8" height="8" viewBox="0 0 8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="1" y1="1" x2="7" y2="7" />
                <line x1="7" y1="1" x2="1" y2="7" />
              </svg>
            </button>
            <button
              type="button"
              className="askmoji-dot-btn"
              onClick={() => setExpanded(e => !e)}
              aria-label={expanded ? 'Restore size' : 'Expand'}
            >
              {expanded ? (
                <svg width="8" height="8" viewBox="0 0 8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3,1 3,3 1,3" />
                  <polyline points="5,7 5,5 7,5" />
                </svg>
              ) : (
                <svg width="8" height="8" viewBox="0 0 8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="1,3 1,1 3,1" />
                  <polyline points="7,5 7,7 5,7" />
                </svg>
              )}
            </button>
          </div>
        </div>
        <span className="askmoji-title">Ask Moji</span>
        <Tooltip title="New conversation">
          <button
            type="button"
            className="askmoji-refresh"
            onClick={handleReset}
            disabled={isStreaming || isInitializing}
            aria-label="New conversation"
          >
            <IconRefresh size={14} />
          </button>
        </Tooltip>
      </div>

      {/* Chat body */}
      <SyllabusBotChat
        messages={messages}
        isStreaming={isStreaming}
        isInitializing={isInitializing}
        suggestedQuestions={suggestedQuestions}
        error={error}
        onSendMessage={sendMessage}
        onAskSuggestedQuestion={askSuggestedQuestion}
        onReset={handleReset}
        classroomSlug={classroomSlug}
        slidesUrl={slidesUrl}
        userLogin={userLogin}
        courseName={displayName}
      />
    </div>
  );
};

export default SyllabusBotWidget;
