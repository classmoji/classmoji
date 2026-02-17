/**
 * Wraps HTML body content in a complete HTML document with styling
 * Used when creating pages from markdown imports
 */
export const wrapHtmlContent = (bodyContent, width = 2) => {
  // Map width values to percentages
  const widthMap = {
    1: '65%',
    2: '85%',
    3: '100%',
  };
  const maxWidth = widthMap[width] || '80%';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 16px;
      line-height: 1.6;
      max-width: ${maxWidth};
      margin: 0 auto;
      padding: 2rem 1rem;
      color: #333;
    }
    img {
      max-width: 100%;
      height: auto;
      display: block;
      margin: 1rem 0;
    }
    pre {
      background: #f5f5f5;
      padding: 1rem;
      border-radius: 4px;
      overflow-x: auto;
    }
    code {
      font-family: 'Courier New', Courier, monospace;
      background: #f5f5f5;
      padding: 0.2rem 0.4rem;
      border-radius: 3px;
    }
    pre code {
      background: none;
      padding: 0;
    }
    a {
      color: #0066cc;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>
${bodyContent}
</body>
</html>`;
};
