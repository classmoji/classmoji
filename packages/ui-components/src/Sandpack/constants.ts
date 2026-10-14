/**
 * Sandpack constants and default configurations
 */

interface TemplateEntry {
  id: string;
  label: string;
  description: string;
}

interface ThemeEntry {
  id: string;
  label: string;
}

interface LayoutEntry {
  id: string;
  label: string;
}

/**
 * Available Sandpack templates
 */
export const SANDPACK_TEMPLATES: Record<string, TemplateEntry> = {
  vanilla: {
    id: 'vanilla',
    label: 'Vanilla (HTML/CSS/JS)',
    description: 'Plain HTML, CSS, and JavaScript',
  },
  react: {
    id: 'react',
    label: 'React',
    description: 'React with JSX support',
  },
  'vanilla-ts': {
    id: 'vanilla-ts',
    label: 'Vanilla TypeScript',
    description: 'HTML/CSS with TypeScript',
  },
  'react-ts': {
    id: 'react-ts',
    label: 'React TypeScript',
    description: 'React with TypeScript',
  },
};

/**
 * Available Sandpack themes
 */
export const SANDPACK_THEMES: Record<string, ThemeEntry> = {
  auto: { id: 'auto', label: 'Auto (match slide)' },
  light: { id: 'light', label: 'Light' },
  dark: { id: 'dark', label: 'Dark' },
  githubLight: { id: 'githubLight', label: 'GitHub Light' },
  nightOwl: { id: 'nightOwl', label: 'Night Owl' },
  aquaBlue: { id: 'aquaBlue', label: 'Aqua Blue' },
  sandpackDark: { id: 'sandpackDark', label: 'Sandpack Dark' },
  atomDark: { id: 'atomDark', label: 'Atom Dark' },
  monokaiPro: { id: 'monokaiPro', label: 'Monokai Pro' },
};

/**
 * Layout options for Sandpack preview
 */
export const SANDPACK_LAYOUTS: Record<string, LayoutEntry> = {
  'preview-right': { id: 'preview-right', label: 'Preview on right' },
  'preview-bottom': { id: 'preview-bottom', label: 'Preview below' },
  'preview-only': { id: 'preview-only', label: 'Preview only' },
  'editor-only': { id: 'editor-only', label: 'Editor only' },
};

/**
 * Default file contents for each template
 */
export const DEFAULT_FILES: Record<string, Record<string, string>> = {
  vanilla: {
    '/index.html': `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <h1>Hello World</h1>
  <p>Edit the code to see changes!</p>
  <script src="index.js"></script>
</body>
</html>`,
    '/styles.css': `body {
  font-family: system-ui, sans-serif;
  padding: 20px;
  margin: 0;
}

h1 {
  color: #333;
}`,
    '/index.js': `// Your JavaScript code here
console.log('Hello from JavaScript!');

document.querySelector('h1').addEventListener('click', () => {
  alert('Clicked!');
});`,
  },
  react: {
    '/App.js': `export default function App() {
  return (
    <div className="App">
      <h1>Hello React</h1>
      <p>Edit this code to see changes!</p>
    </div>
  );
}`,
    '/styles.css': `.App {
  font-family: system-ui, sans-serif;
  padding: 20px;
}

h1 {
  color: #333;
}`,
  },
  'vanilla-ts': {
    '/index.html': `<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <h1>Hello TypeScript</h1>
  <p>Edit the code to see changes!</p>
  <script type="module" src="index.ts"></script>
</body>
</html>`,
    '/styles.css': `body {
  font-family: system-ui, sans-serif;
  padding: 20px;
  margin: 0;
}`,
    '/index.ts': `// TypeScript code
const greeting: string = 'Hello from TypeScript!';
console.log(greeting);

const heading = document.querySelector('h1');
if (heading) {
  heading.addEventListener('click', () => {
    alert('Clicked!');
  });
}`,
  },
  'react-ts': {
    '/App.tsx': `export default function App(): JSX.Element {
  return (
    <div className="App">
      <h1>Hello React + TypeScript</h1>
      <p>Edit this code to see changes!</p>
    </div>
  );
}`,
    '/styles.css': `.App {
  font-family: system-ui, sans-serif;
  padding: 20px;
}`,
  },
};

/** A file Sandpack gets but the editor never shows. */
export interface SandboxSupportFile {
  code: string;
  hidden: true;
}

/**
 * Files a quiz code sandbox adds to the student's files, by template. Hidden
 * in the editor and never part of a submission.
 *
 * vanilla: the template's own /package.json, plus a Babel pin. The bundler's
 * default Babel cannot parse `??`, `?.` or `for await` (verified 2026-09-23);
 * 7.24.0 can. It must keep `main`, or nothing runs.
 *
 * vanilla-ts, react, react-ts: none. Their own /package.json carries
 * `typescript`, the React dependencies and `main`, and supplying one replaces
 * it whole.
 */
export const SANDBOX_SUPPORT_FILES: Readonly<
  Record<string, Readonly<Record<string, SandboxSupportFile>>>
> = {
  vanilla: {
    '/package.json': {
      code: '{"main":"/index.js","devDependencies":{"@babel/core":"7.24.0"}}',
      hidden: true,
    },
  },
  'vanilla-ts': {},
  react: {},
  'react-ts': {},
};
