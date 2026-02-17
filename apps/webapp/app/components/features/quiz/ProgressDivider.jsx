import { Typography } from 'antd';
import { getEmojiSymbol } from '@classmoji/utils';

const { Text } = Typography;

/**
 * ProgressDivider - Shows emoji feedback between quiz questions
 *
 * Displayed after each [QUESTION_COMPLETE] marker to give students
 * visual feedback on their performance before the next question.
 *
 * Format:
 * completed question 4: 🚀
 * Perfect understanding of controlled components!
 */
function ProgressDivider({ emoji, briefFeedback, questionNum, isDarkMode }) {
  const emojiSymbol = getEmojiSymbol(emoji) || emoji;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Text style={{ color: isDarkMode ? '#d1d5db' : '#374151' }}>
        completed question {questionNum}: {emojiSymbol}
      </Text>
      {briefFeedback && (
        <Text style={{ color: isDarkMode ? '#9ca3af' : '#666' }}>
          {briefFeedback}
        </Text>
      )}
    </div>
  );
}

export default ProgressDivider;
