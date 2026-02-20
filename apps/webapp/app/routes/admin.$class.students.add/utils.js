const isValidEmail = email => {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
};

export const parseStudentInput = text => {
  const lines = text
    .trim()
    .split('\n')
    .filter(line => line.trim());

  return lines.map((line, index) => {
    // Support both tab and comma separation
    const parts = line.includes('\t')
      ? line.split('\t').map(p => p.trim())
      : line.split(',').map(p => p.trim());

    const [name, email] = parts;

    const parsed = {
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
