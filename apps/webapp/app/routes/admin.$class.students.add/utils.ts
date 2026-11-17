// The one address check (registration uses it too). The regex this replaced
// passed `jane@gmail.co.`, which Resend refuses, and one such address sank a
// whole batch of invitations.
import { isValidEmail } from '@classmoji/utils/email';

export const parseStudentInput = (text: string) => {
  const lines = text
    .trim()
    .split('\n')
    .filter((line: string) => line.trim());

  return lines.map((line: string, index: number) => {
    // Support both tab and comma separation
    const parts = line.includes('\t')
      ? line.split('\t').map((p: string) => p.trim())
      : line.split(',').map((p: string) => p.trim());

    const [name, email] = parts;

    const parsed: { key: number; name: string; email: string; error?: string } = {
      key: index,
      name: name || '',
      email: (email || '').toLowerCase(),
    };

    // Validate
    if (!parsed.name || !parsed.email) {
      parsed.error = 'Missing fields';
    } else if (!isValidEmail(parsed.email)) {
      parsed.error = 'Invalid email';
    }

    return parsed;
  });
};
