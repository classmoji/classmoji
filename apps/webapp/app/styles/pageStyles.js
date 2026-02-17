export const pageStyles = `
  /* Smooth scrolling for TOC links */
  html {
    scroll-behavior: smooth;
  }
  /* Offset for fixed header when jumping to anchors */
  .page-content h1[id],
  .page-content h2[id],
  .page-content h3[id] {
    scroll-margin-top: 5rem;
  }
  .page-content {
    font-family: 'Noto Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif !important;
    font-size: 16px !important;
    line-height: 1.6;
    color: #333;
  }
  .dark .page-content {
    color: #e5e7eb;
  }
  .page-content *:not(code):not(pre):not(pre *):not(.token) {
    font-family: inherit !important;
  }
  .page-content code,
  .page-content pre,
  .page-content pre * {
    font-family: 'JetBrains Mono', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace !important;
  }
  /* Set 16px for ALL elements except headings and code */
  .page-content *:not(h1):not(h2):not(h3):not(h4):not(h5):not(h6):not(code):not(pre) {
    font-size: 16px !important;
  }
  /* Exclude code block internals from the 16px rule */
  .page-content pre *,
  .page-content pre code,
  .page-content pre code * {
    font-size: 1rem !important;
  }
  .page-content h1, .page-content h2, .page-content h3, .page-content h4, .page-content h5, .page-content h6 {
    font-weight: 600;
  }
  .page-content h1 { font-size: 2em !important; margin-top: 2rem; margin-bottom: 0; }
  .page-content h2 { font-size: 1.5em !important; margin-top: 1.5rem; margin-bottom: 0; }
  .page-content h3 { font-size: 1.25em !important; margin-top: 1rem; margin-bottom: 0; }
  /* When inside heading-block wrapper, remove margin from h tag (wrapper has it) */
  .page-content .heading-block { margin: 0; padding: 0; }
  .page-content .heading-block h1,
  .page-content .heading-block h2,
  .page-content .heading-block h3 { margin-top: 0; }
  .page-content .h1-block { margin-top: 2rem; }
  .page-content .h2-block { margin-top: 1.5rem; }
  .page-content .h3-block { margin-top: 1rem; }
  .page-content p { margin-bottom: 1em; }
  /* Elements with background colors need padding and rounded corners */
  .page-content p[data-bg-color],
  .page-content p[style*="background-color"] {
    padding: 0.25rem 0.75rem !important;
    margin-left: -0.75rem !important;
    margin-right: -0.75rem !important;
    border-radius: 0.25rem !important;
  }
  /* For heading blocks with background, apply styles to the wrapper div */
  .page-content .heading-block[data-bg-color] {
    padding: 0.25rem 0.75rem !important;
    margin-left: -0.75rem !important;
    margin-right: -0.75rem !important;
    border-radius: 0.25rem !important;
  }
  .page-content .heading-block[data-bg-color] h1,
  .page-content .heading-block[data-bg-color] h2,
  .page-content .heading-block[data-bg-color] h3 {
    padding: 0 !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
  }
  /* Headings with inline style background-color (legacy/direct) */
  .page-content h1[style*="background-color"],
  .page-content h2[style*="background-color"],
  .page-content h3[style*="background-color"] {
    padding: 0.25rem 0.75rem !important;
    margin-left: -0.75rem !important;
    margin-right: -0.75rem !important;
    border-radius: 0.25rem !important;
  }
  .page-content ul, .page-content ol {
    margin-bottom: 1em;
    padding-left: 1.5em;
    list-style-position: outside;
  }
  .page-content ul { list-style-type: disc; }
  .page-content ol { list-style-type: decimal; }
  .page-content li {
    margin-bottom: 0.25em;
    display: list-item;
  }
  .page-content ul ul, .page-content ol ul {
    list-style-type: circle;
    margin-bottom: 0.25em;
    margin-top: 0.25em;
  }
  .page-content ul ul ul, .page-content ol ul ul {
    list-style-type: square;
  }
  .page-content ol ol { list-style-type: lower-alpha; }
  .page-content ol ol ol { list-style-type: lower-roman; }
  .page-content code {
    background: #f1f1ef;
    color: #eb5757;
    padding: 0.125rem 0.375rem;
    border-radius: 0.25rem;
    font-family: 'JetBrains Mono', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace !important;
    font-size: 0.9em;
  }
  .dark .page-content code {
    background: #374151;
    color: #f87171;
  }
  .page-content pre {
    background: #1e1e1e !important;
    padding: 1em;
    border-radius: 8px;
    overflow-x: auto;
    margin-bottom: 1em;
  }
  .page-content pre code {
    background: none !important;
    color: #d4d4d4;
    padding: 0;
    font-size: 16px !important;
    line-height: 1.625;
  }
  /* Code block with header and line numbers */
  .page-content .code-block {
    background: #1e1e1e;
    border-radius: 8px;
    overflow: hidden;
    margin-bottom: 1em;
  }
  .page-content .code-block .code-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.5rem 1rem;
    background: #161616;
    border-bottom: 1px solid #333;
  }
  .page-content .code-block .code-lang {
    color: #9ca3af;
    font-size: 0.75rem;
    font-weight: 500;
  }
  .page-content .code-block .code-body {
    display: flex;
    padding: 1rem 0;
  }
  .page-content .code-block .line-numbers {
    display: flex;
    flex-direction: column;
    padding: 0 1rem 0 1rem;
    text-align: right;
    user-select: none;
    color: #6b7280;
    font-family: 'JetBrains Mono', 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace !important;
    font-size: 16px !important;
    line-height: 26px;
  }
  .page-content .code-block .line-numbers .line-number {
    display: block;
    height: 26px;
  }
  .page-content .code-block pre {
    flex: 1;
    background: transparent !important;
    margin: 0;
    padding: 0 1rem 0 0;
    overflow-x: auto;
    border-radius: 0;
  }
  .page-content .code-block pre code {
    display: block;
    color: #d4d4d4;
    font-size: 16px !important;
    line-height: 26px;
    white-space: pre;
  }
  /* Ensure text nodes in code blocks are 16px */
  .page-content pre,
  .page-content pre code,
  .page-content pre code .token {
    font-size: 16px !important;
  }
  /* VS Code Dark+ Prism theme */
  .page-content .token.comment,
  .page-content .token.prolog,
  .page-content .token.doctype,
  .page-content .token.cdata {
    color: #6a9955;
    font-style: italic;
  }
  .page-content .token.punctuation {
    color: #d4d4d4;
  }
  .page-content .token.property,
  .page-content .token.tag,
  .page-content .token.boolean,
  .page-content .token.number,
  .page-content .token.constant,
  .page-content .token.symbol,
  .page-content .token.deleted {
    color: #b5cea8;
  }
  .page-content .token.selector,
  .page-content .token.attr-name,
  .page-content .token.string,
  .page-content .token.char,
  .page-content .token.builtin,
  .page-content .token.inserted {
    color: #ce9178;
  }
  .page-content .token.operator,
  .page-content .token.entity,
  .page-content .token.url,
  .page-content .language-css .token.string,
  .page-content .style .token.string {
    color: #d4d4d4;
  }
  .page-content .token.atrule,
  .page-content .token.attr-value,
  .page-content .token.keyword {
    color: #569cd6;
  }
  .page-content .token.function,
  .page-content .token.class-name {
    color: #dcdcaa;
  }
  .page-content .token.regex,
  .page-content .token.important,
  .page-content .token.variable {
    color: #d16969;
  }
  .page-content .token.important,
  .page-content .token.bold {
    font-weight: bold;
  }
  .page-content .token.italic {
    font-style: italic;
  }
  .page-content .token.entity {
    cursor: help;
  }
  .page-content blockquote {
    border-left: 4px solid #ddd;
    margin: 1em 0;
    padding-left: 1em;
    color: #666;
  }
  .dark .page-content blockquote {
    border-left-color: #4b5563;
    color: #9ca3af;
  }
  .page-content table {
    border-collapse: collapse;
    width: 100%;
    margin-bottom: 1em;
  }
  .page-content th, .page-content td {
    border: 1px solid #ddd;
    padding: 0.75em;
    text-align: left;
  }
  .dark .page-content th, .dark .page-content td {
    border-color: #4b5563;
  }
  .page-content th {
    background: #f6f8fa;
    font-weight: 600;
  }
  .dark .page-content th {
    background: #374151;
  }
  .page-content a {
    color: #0969da;
    text-decoration: none;
  }
  .dark .page-content a {
    color: #60a5fa;
  }
  .page-content a:hover {
    text-decoration: underline;
  }
  .page-content a.page-link {
    text-decoration: underline;
  }
  .page-content img {
    max-width: 100%;
    height: auto;
    border-radius: 8px;
    margin: 0.5em 0;
  }
  .page-content .image-block {
    margin: 1em 0;
    padding: 0;
  }
  .page-content .image-block img {
    display: block;
    margin: 0;
    width: 100%;
  }
  .page-content .image-align-center {
    text-align: center;
  }
  .page-content .image-align-center img {
    margin-left: auto;
    margin-right: auto;
  }
  .page-content .image-align-right {
    text-align: right;
  }
  .page-content .image-align-right img {
    margin-left: auto;
  }
  .page-content .callout {
    background: #f7f6f3;
    padding: 1em;
    border-radius: 6px;
    display: flex;
    gap: 0.75em;
    margin-bottom: 1em;
  }
  .dark .page-content .callout {
    background: #374151;
  }
  .page-content .callout-emoji {
    font-size: 1.25em;
  }
  /* Toggle (collapsible) styling */
  .page-content details {
    margin-bottom: 1em;
    border-radius: 6px;
  }
  .page-content details summary {
    cursor: pointer;
    font-weight: 500;
    padding: 0.5em 0;
    list-style: none;
    display: flex;
    align-items: flex-start;
    gap: 0.5em;
  }
  .page-content details summary::-webkit-details-marker {
    display: none;
  }
  .page-content details summary::before {
    content: '▶';
    font-size: 0.75em;
    transition: transform 0.2s;
    margin-top: 0.25em;
    shrink: 0;
  }
  .page-content details[open] summary::before {
    transform: rotate(90deg);
  }
  .page-content details > div {
    padding-left: 1.25em;
    border-left: 2px solid #e5e7eb;
    margin-left: 0.25em;
  }
  .dark .page-content details > div {
    border-left-color: #4b5563;
    margin-top: 0.5em;
  }
  .page-content details > div > *:last-child {
    margin-bottom: 0;
  }
  .page-content .video-embed {
    position: relative;
    padding-bottom: 56.25%;
    height: 0;
    overflow: hidden;
    margin-bottom: 1em;
    border-radius: 6px;
  }
  .page-content .video-embed iframe {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
  }
  .page-content .file-download {
    background: #f6f8fa;
    border: 1px solid #e1e4e8;
    border-radius: 6px;
    padding: 1em;
    margin-bottom: 1em;
  }
  .dark .page-content .file-download {
    background: #374151;
    border-color: #4b5563;
  }
  .page-content .file-download a {
    display: inline-flex;
    align-items: center;
    gap: 0.5em;
    color: #0969da;
    font-weight: 500;
  }
  .dark .page-content .file-download a {
    color: #60a5fa;
  }
  .page-content .file-download a::before {
    content: '📎';
  }
  .page-content .page-link-block {
    display: block;
    width: 100%;
    padding: 0.5rem;
    margin: 0 -0.5rem 1em -0.5rem;
    border-radius: 0.25rem;
    transition: background-color 0.15s;
    cursor: pointer;
  }
  .page-content .page-link-block:hover {
    background-color: #f3f4f6;
  }
  .dark .page-content .page-link-block:hover {
    background-color: #374151;
  }
  .page-content .page-link-block a {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: #111827;
    font-weight: 600;
    text-decoration: underline;
  }
  .dark .page-content .page-link-block a {
    color: #e5e7eb;
  }
  .page-content .page-link-block a:hover {
    text-decoration: underline;
  }
  .page-content .page-link-block a::before {
    content: '📄';
    font-size: 1rem;
    shrink: 0;
  }
  .page-content .embed-container {
    position: relative;
    padding-bottom: 56.25%;
    height: 0;
    overflow: hidden;
    margin-bottom: 1em;
    border-radius: 6px;
    border: 1px solid #e1e4e8;
  }
  .dark .page-content .embed-container {
    border-color: #4b5563;
  }
  .page-content .embed-container iframe {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
  }
  .page-content .columns {
    display: grid;
    gap: 1.5rem;
    margin-bottom: 1em;
  }
  .page-content .columns[data-columns="2"] {
    grid-template-columns: repeat(2, 1fr);
  }
  .page-content .columns[data-columns="3"] {
    grid-template-columns: repeat(3, 1fr);
  }
  .page-content .columns[data-columns="4"] {
    grid-template-columns: repeat(4, 1fr);
  }
  .page-content .column {
    min-height: 50px;
  }
  /* Dark mode overrides for blocks with custom background colors */
  /* Gray background */
  .dark .page-content [data-bg-color="#EBECED"],
  .dark .page-content [style*="background-color: #EBECED"] {
    background-color: #373737 !important;
    color: #f3f4f6 !important;
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
  }
  /* Brown background */
  .dark .page-content [data-bg-color="#E9E5E3"],
  .dark .page-content [style*="background-color: #E9E5E3"] {
    background-color: #442F24 !important;
    color: #f3f4f6 !important;
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
  }
  /* Orange background */
  .dark .page-content [data-bg-color="#FAEBDD"],
  .dark .page-content [style*="background-color: #FAEBDD"] {
    background-color: #5C3D1E !important;
    color: #f3f4f6 !important;
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
  }
  /* Yellow background */
  .dark .page-content [data-bg-color="#FBF3DB"],
  .dark .page-content [style*="background-color: #FBF3DB"] {
    background-color: #4D4121 !important;
    color: #f3f4f6 !important;
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
  }
  /* Green background */
  .dark .page-content [data-bg-color="#DDEDEA"],
  .dark .page-content [style*="background-color: #DDEDEA"] {
    background-color: #1E3D36 !important;
    color: #f3f4f6 !important;
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
  }
  /* Blue background */
  .dark .page-content [data-bg-color="#DDEBF1"],
  .dark .page-content [style*="background-color: #DDEBF1"] {
    background-color: #1E3A4C !important;
    color: #f3f4f6 !important;
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
  }
  /* Purple background */
  .dark .page-content [data-bg-color="#EAE4F2"],
  .dark .page-content [style*="background-color: #EAE4F2"] {
    background-color: #352B48 !important;
    color: #f3f4f6 !important;
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
  }
  /* Pink background */
  .dark .page-content [data-bg-color="#F4DFEB"],
  .dark .page-content [style*="background-color: #F4DFEB"] {
    background-color: #4A2639 !important;
    color: #f3f4f6 !important;
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
  }
  /* Red background */
  .dark .page-content [data-bg-color="#FBE4E4"],
  .dark .page-content [style*="background-color: #FBE4E4"] {
    background-color: #4D2C2C !important;
    color: #f3f4f6 !important;
    padding: 0.125rem 0.5rem;
    border-radius: 0.25rem;
  }
  /* Dark mode text color overrides */
  .dark .page-content [data-text-color="#64473A"] { color: #D4B59E !important; }
  .dark .page-content [data-text-color="#D9730D"] { color: #FFA344 !important; }
  .dark .page-content [data-text-color="#DFAB01"] { color: #FFD93D !important; }
  .dark .page-content [data-text-color="#0F7B6C"] { color: #4DAB9A !important; }
  .dark .page-content [data-text-color="#0B6E99"] { color: #529CCA !important; }
  .dark .page-content [data-text-color="#6940A5"] { color: #9A6DD7 !important; }
  .dark .page-content [data-text-color="#AD1A72"] { color: #E255A3 !important; }
  .dark .page-content [data-text-color="#E03E3E"] { color: #FF6B6B !important; }
  @media (max-width: 768px) {
    .page-content .columns {
      grid-template-columns: 1fr !important;
    }
  }
  /* Terminal block styling */
  .page-content .terminal-block {
    background: #1e1e1e;
    border-radius: 10px;
    overflow: hidden;
    margin-bottom: 1em;
    box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
  }
  .page-content .terminal-block .terminal-header {
    background: linear-gradient(180deg, #3c3c3c 0%, #2d2d2d 100%);
    padding: 0.5rem 1rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    border-bottom: 1px solid #1a1a1a;
  }
  .page-content .terminal-block .terminal-dots {
    display: flex;
    gap: 8px;
  }
  .page-content .terminal-block .terminal-dots span {
    width: 12px;
    height: 12px;
    border-radius: 50%;
  }
  .page-content .terminal-block .terminal-dots span:nth-child(1) { background: #ff5f57; }
  .page-content .terminal-block .terminal-dots span:nth-child(2) { background: #febc2e; }
  .page-content .terminal-block .terminal-dots span:nth-child(3) { background: #28c840; }
  .page-content .terminal-block .terminal-title {
    flex: 1;
    text-align: center;
    color: #9ca3af;
    font-size: 0.8rem;
    font-weight: 500;
    margin-right: 60px;
  }
  .page-content .terminal-block pre {
    background: transparent !important;
    margin: 0;
    padding: 1.25rem 1.5rem !important;
    font-family: 'JetBrains Mono', 'SF Mono', 'Monaco', 'Menlo', 'Consolas', monospace;
    font-size: 16px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-wrap: break-word;
    border-radius: 0 !important;
  }
  .page-content .terminal-block pre code {
    background: transparent !important;
    color: #d1d5db;
    padding: 0;
    font-size: inherit;
    font-family: inherit;
  }
  /* Profile card styling */
  .page-content .profile-card {
    display: flex;
    flex-direction: column;
    border: 1px solid #e5e7eb;
    border-radius: 10px;
    margin-bottom: 1.5rem;
    background: #ffffff;
    width: 100%;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.05);
    transition: all 0.2s ease;
  }
  .page-content .profile-card:hover {
    box-shadow: 0 4px 12px 0 rgba(0, 0, 0, 0.08);
    transform: translateY(-1px);
    border-color: #d1d5db;
  }
  .dark .page-content .profile-card {
    background: #1f2937;
    border-color: #374151;
    box-shadow: 0 1px 2px 0 rgba(0, 0, 0, 0.3);
  }
  .dark .page-content .profile-card:hover {
    box-shadow: 0 4px 12px 0 rgba(0, 0, 0, 0.4);
    border-color: #4b5563;
  }
  .page-content .profile-card img {
    width: 100%;
    aspect-ratio: 4 / 3;
    object-fit: cover;
    background: #f9fafb;
    margin: 0;
    display: block;
    border-radius: 9px 9px 0 0;
  }
  .dark .page-content .profile-card img {
    background: #374151;
  }
  .page-content .profile-card > div {
    padding: 0.875rem 1rem;
  }
  .page-content .profile-card strong {
    display: block;
    font-size: 16px !important;
    font-weight: 600;
    color: #111827;
    margin-bottom: 0.5rem;
    line-height: 1.3;
  }
  .dark .page-content .profile-card strong {
    color: #f9fafb;
  }
  .page-content .profile-card em {
    display: block;
    font-size: 14px !important;
    font-weight: 400;
    font-style: normal;
    color: #6b7280;
    line-height: 1.3;
  }
  .dark .page-content .profile-card em {
    color: #9ca3af;
  }
  @media (max-width: 768px) {
    .page-content .profile-card {
      margin-bottom: 1rem;
    }
    .page-content .profile-card > div {
      padding: 0.75rem 0.875rem;
    }
  }
`;
