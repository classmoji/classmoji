/**
 * TypingIndicator - A 3-dot bounce animation for AI thinking states
 * Used consistently across Quiz, Prompt Assistant, and Syllabus Bot
 */
const TypingIndicator = ({ color = '#1890ff' }) => {
  return (
    <>
      <style>
        {`
          @keyframes typing-bounce {
            0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
            30% { transform: translateY(-4px); opacity: 1; }
          }
        `}
      </style>
      <div
        style={{
          display: 'flex',
          gap: '4px',
          padding: '8px 14px',
          borderRadius: '16px',
          width: 'fit-content',
        }}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: '6px',
              height: '6px',
              backgroundColor: color,
              borderRadius: '50%',
              animation: 'typing-bounce 1.2s infinite ease-in-out',
              animationDelay: `${i * 0.2}s`,
            }}
          />
        ))}
      </div>
    </>
  );
};

export default TypingIndicator;
