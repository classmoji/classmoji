import { task, logger, metadata } from '@trigger.dev/sdk/v3';
import Anthropic from '@anthropic-ai/sdk';

console.log('[explore-repo] Module loaded (v2 with metadata streaming)');

/**
 * GitHub API helpers
 * These use the GitHub REST API to read repo contents without cloning.
 */

const GITHUB_API = 'https://api.github.com';

/**
 * Fetch with retry and exponential backoff for GitHub API rate limits.
 * Handles both primary (403) and secondary (429) rate limits.
 *
 * @param {string} url - Full GitHub API URL
 * @param {Object} headers - Request headers
 * @param {string} label - Human-readable label for logging
 * @param {number} maxRetries - Max retry attempts (default 3)
 * @returns {Promise<Response>} Successful fetch response
 */
async function githubFetch(url, headers, label, maxRetries = 3) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, { headers });

    if (res.ok) return res;

    // Retry on rate limit (429) or abuse detection (403 with rate limit headers)
    const isRateLimit = res.status === 429;
    const isAbuse = res.status === 403 && res.headers.get('retry-after');

    if ((isRateLimit || isAbuse) && attempt < maxRetries) {
      // Use Retry-After header if present, otherwise exponential backoff
      const retryAfter = res.headers.get('retry-after');
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 30000);
      console.log(`[explore-repo] ${label}: ${res.status} rate limited, retrying in ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${maxRetries})`);
      logger.warn(`${label}: rate limited (${res.status}), waiting ${Math.round(waitMs)}ms before retry ${attempt + 1}`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      continue;
    }

    // Non-retryable error or out of retries
    const body = await res.text();
    throw new Error(`${label} failed (${res.status}): ${body}`);
  }
}

const GITHUB_HEADERS = (token) => ({
  Authorization: `token ${token}`,
  Accept: 'application/vnd.github.v3+json',
  'User-Agent': 'classmoji-explore',
});

/**
 * Fetch the full repository file tree via the Git Trees API.
 * Returns a flat list of all files with paths, sizes, and types.
 *
 * @param {string} owner - GitHub org/user
 * @param {string} repo - Repository name
 * @param {string} token - GitHub installation access token
 * @returns {Promise<Array<{path: string, size: number, type: string}>>}
 */
async function fetchRepoTree(owner, repo, token) {
  const url = `${GITHUB_API}/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`;
  const res = await githubFetch(url, GITHUB_HEADERS(token), `GitHub tree API (${owner}/${repo})`);

  const data = await res.json();
  // Filter to blobs (files) only, exclude tree entries (directories)
  return (data.tree || [])
    .filter(entry => entry.type === 'blob')
    .map(entry => ({
      path: entry.path,
      size: entry.size || 0,
      type: entry.type,
    }));
}

/**
 * Fetch a single file's content via the GitHub Contents API.
 * Returns decoded UTF-8 text content.
 *
 * @param {string} owner - GitHub org/user
 * @param {string} repo - Repository name
 * @param {string} path - File path within the repo
 * @param {string} token - GitHub installation access token
 * @returns {Promise<string>} File content as text
 */
async function fetchFileContent(owner, repo, path, token) {
  const encodedPath = path.split('/').map(segment => encodeURIComponent(segment)).join('/');
  const url = `${GITHUB_API}/repos/${owner}/${repo}/contents/${encodedPath}`;
  const res = await githubFetch(url, GITHUB_HEADERS(token), `GitHub contents (${path})`);

  const data = await res.json();

  if (data.encoding === 'base64' && data.content) {
    return Buffer.from(data.content, 'base64').toString('utf-8');
  }

  // Fallback: if content is provided directly (rare)
  return data.content || '';
}

/**
 * Fetch multiple files with a concurrency limit.
 * Uses concurrency of 3 (not 5) to stay under GitHub's abuse detection threshold.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string[]} paths - Array of file paths
 * @param {string} token
 * @param {number} concurrency - Max parallel requests (default 3)
 * @returns {Promise<Array<{path: string, content: string, error?: string}>>}
 */
async function fetchMultipleFiles(owner, repo, paths, token, concurrency = 3) {
  const results = [];
  // Process in batches for concurrency control
  for (let i = 0; i < paths.length; i += concurrency) {
    const batch = paths.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(
      batch.map(async (path) => {
        const content = await fetchFileContent(owner, repo, path, token);
        return { path, content };
      })
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        const failedPath = batch[batchResults.indexOf(result)];
        results.push({ path: failedPath, content: '', error: result.reason?.message });
      }
    }
  }
  return results;
}

/**
 * Build a compact tree listing for Claude to analyze.
 * Filters out common noise (node_modules, .git, etc.) and formats
 * as a simple path listing with file sizes.
 *
 * @param {Array} tree - Raw tree from fetchRepoTree
 * @returns {string} Formatted tree listing
 */
function formatTreeForLLM(tree) {
  // Filter out noise
  const ignorePatterns = [
    /^node_modules\//,
    /^\.git\//,
    /^\.next\//,
    /^dist\//,
    /^build\//,
    /^coverage\//,
    /^\.cache\//,
    /^vendor\//,
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
    /\.min\.(js|css)$/,
    /\.(png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|mp4|webm)$/i,
  ];

  const filtered = tree.filter(entry =>
    !ignorePatterns.some(pattern => pattern.test(entry.path))
  );

  // Cap at 500 files to keep context manageable
  const capped = filtered.slice(0, 500);

  const lines = capped.map(entry => {
    const sizeKB = (entry.size / 1024).toFixed(1);
    return `${entry.path} (${sizeKB}KB)`;
  });

  let result = lines.join('\n');
  if (filtered.length > 500) {
    result += `\n... and ${filtered.length - 500} more files`;
  }

  return result;
}

/**
 * Use Claude Haiku to pick the most relevant files to read.
 *
 * @param {Anthropic} client - Anthropic SDK client
 * @param {string} model - Model ID
 * @param {string} treeListing - Formatted tree listing
 * @param {string} focusArea - What to explore
 * @param {string} depth - shallow/focused/deep
 * @param {string[]} previousFindings - Topics already covered
 * @param {string|null} specificQuestion - Specific student question
 * @returns {Promise<string[]>} Array of file paths to read
 */
async function pickRelevantFiles(client, model, treeListing, focusArea, depth, previousFindings, specificQuestion, previouslyReadFiles = []) {
  const maxFiles = depth === 'shallow' ? 2 : depth === 'focused' ? 4 : 6;

  const previousContext = previousFindings.length > 0
    ? `\nPreviously explored topics (avoid these): ${previousFindings.join(', ')}`
    : '';

  const questionContext = specificQuestion
    ? `\nStudent asked: "${specificQuestion}"`
    : '';

  const previousFilesContext = previouslyReadFiles.length > 0
    ? `\nFor context, these files were already read in earlier explorations: ${previouslyReadFiles.join(', ')}`
    : '';

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are a code exploration assistant. Given a repository file tree and a focus area, pick the ${maxFiles} most relevant files to read.

FOCUS AREA: ${focusArea === 'initial' ? 'Get an overview of the project: framework, structure, main components, key patterns' : focusArea}
${previousContext}${previousFilesContext}${questionContext}

FILE TREE:
${treeListing}

RULES:
- Pick at most ${maxFiles} files
- Prioritize source code over config files (unless focus is on config)
- For "initial" focus: pick the main entry point + 3-5 key source files
- For specific topics: pick files most related to that topic
- Prefer smaller files that are more focused
- Skip test files unless the focus is testing
- Skip lock files, build artifacts, and binary files

Respond with ONLY a JSON array of file paths, nothing else. Example:
["src/App.jsx", "src/utils.js", "src/hooks/useAuth.js"]`,
    }],
  });

  const text = response.content[0]?.text || '[]';
  try {
    // Extract JSON array from response (may include markdown)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch {
    logger.warn('Failed to parse file picker response, falling back to defaults');
    return ['package.json'];
  }
}

/**
 * Use Claude Haiku to synthesize exploration findings.
 *
 * @param {Anthropic} client - Anthropic SDK client
 * @param {string} model - Model ID
 * @param {Array<{path: string, content: string}>} files - Files with content
 * @param {string} focusArea - What was explored
 * @param {string[]} previousFindings - Topics already covered
 * @param {string|null} specificQuestion - Specific student question
 * @param {string} treeListing - Formatted tree listing (for context)
 * @returns {Promise<string>} Markdown analysis
 */
async function synthesizeFindings(client, model, files, focusArea, previousFindings, specificQuestion, treeListing) {
  const previousContext = previousFindings.length > 0
    ? `\nPreviously explored topics (summarize NEW findings only): ${previousFindings.join(', ')}`
    : '';

  const questionContext = specificQuestion
    ? `\nStudent's specific question: "${specificQuestion}"`
    : '';

  // Build file contents section, truncating large files
  const fileContents = files.map(f => {
    const content = f.error
      ? `(Error reading file: ${f.error})`
      : f.content.length > 8000
        ? f.content.slice(0, 8000) + '\n... (truncated)'
        : f.content;
    return `### ${f.path}\n\`\`\`\n${content}\n\`\`\``;
  }).join('\n\n');

  const isInitial = focusArea === 'initial';

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    messages: [{
      role: 'user',
      content: `You are a code exploration assistant analyzing a student's repository. Provide a structured summary of what you found.

FOCUS AREA: ${isInitial ? 'Initial project overview' : focusArea}
${previousContext}${questionContext}

PROJECT TREE (first 100 entries):
${treeListing.split('\n').slice(0, 100).join('\n')}

FILES READ:
${fileContents}

Respond with a JSON object in this exact format:
{
  "focus_area": "${focusArea}",
  ${isInitial ? `"project_structure": {
    "entry_points": ["src/index.js"],
    "key_directories": ["src/components"],
    "config_files": ["package.json"]
  },` : ''}
  "relevant_files": [
    {
      "path": "src/Example.jsx",
      "summary": "Brief description",
      "code_snippet": "// Most relevant 10-20 lines",
      "concepts": ["react", "hooks"]
    }
  ],
  "key_patterns": [
    {
      "pattern": "Pattern name",
      "evidence": "Brief evidence"
    }
  ],
  "suggested_topics": ["Topic 1", "Topic 2"]
}

RULES:
- relevant_files: Max 5, ordered by relevance. code_snippet should be the ACTUAL code (10-20 lines max).
- key_patterns: Max 3 patterns observed in the code
- suggested_topics: Max 5 quiz-worthy topics based on what you see
- All summaries: 1-2 sentences
- Focus on what's interesting/quiz-worthy about their implementation choices
- If there's a specific question, make sure the analysis addresses it

Respond with ONLY the JSON object, no other text.`,
    }],
  });

  return response.content[0]?.text || '{}';
}

/**
 * Trigger.dev task: Explore a GitHub repository using the REST API + Claude Haiku.
 *
 * This is the core of the "trigger" exploration mode. Instead of cloning repos into
 * VMs (slow, expensive), it reads files directly via GitHub's API and uses Haiku
 * for fast, cheap analysis.
 *
 * Typical execution: ~10-20s.
 * Cost: ~$0.003 per exploration (Haiku calls + Trigger.dev compute).
 */
export const exploreRepoTask = task({
  id: 'explore-repo',
  machine: 'small-2x',
  maxDuration: 120,
  queue: { concurrencyLimit: 50 },

  run: async (payload) => {
    const {
      owner,
      repo,
      accessToken,
      focusArea = 'initial',
      depth = 'focused',
      previousFindings = [],
      previouslyReadFiles = [],
      specificQuestion = null,
      explorationModel,
    } = payload;

    const model = explorationModel || 'claude-haiku-4-5-20251001';
    console.log(`[explore-repo] Starting: ${owner}/${repo} — focus: ${focusArea}, depth: ${depth}, model: ${model}`);
    logger.info(`Exploring ${owner}/${repo} — focus: ${focusArea}, depth: ${depth}, model: ${model}`);

    // Initialize Anthropic client using env var (set in Trigger.dev config, NOT passed in payload)
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicApiKey) {
      throw new Error('ANTHROPIC_API_KEY env var not set in Trigger.dev environment');
    }
    const client = new Anthropic({ apiKey: anthropicApiKey });

    // Step 1: Fetch repository tree (~200ms)
    console.log(`[explore-repo] Step 1: Fetching repo tree...`);
    logger.info('Fetching repository structure...');
    metadata.set('currentStep', 'Fetching repository structure');
    metadata.set('steps', [{ action: 'Fetching repository structure', toolName: 'github_tree', timestamp: Date.now() }]);
    await metadata.flush();

    const tree = await fetchRepoTree(owner, repo, accessToken);
    console.log(`[explore-repo] Step 1 done: ${tree.length} files in tree`);
    logger.info(`Repository has ${tree.length} files`);

    const treeListing = formatTreeForLLM(tree);

    // Step 2: Claude picks relevant files (~2s)
    console.log(`[explore-repo] Step 2: Asking Haiku to pick relevant files...`);
    logger.info('Analyzing repository structure...');
    metadata.set('currentStep', 'Analyzing repository structure');
    metadata.append('steps', { action: `Analyzing ${tree.length} files`, toolName: 'analyze_structure', timestamp: Date.now() });
    await metadata.flush();

    const filePaths = await pickRelevantFiles(
      client, model, treeListing, focusArea, depth, previousFindings, specificQuestion, previouslyReadFiles
    );
    console.log(`[explore-repo] Step 2 done: picked ${filePaths.length} files: ${filePaths.join(', ')}`);
    logger.info(`Selected ${filePaths.length} files to read: ${filePaths.join(', ')}`);

    // Step 3: Fetch file contents in parallel (~100ms each)
    // Emit a step for each file being read
    console.log(`[explore-repo] Step 3: Fetching file contents...`);
    logger.info('Reading selected files...');
    for (const filePath of filePaths) {
      metadata.append('steps', { action: `Reading: ./${filePath}`, toolName: 'github_read', toolInput: { path: filePath }, timestamp: Date.now() });
    }
    metadata.set('currentStep', `Reading ${filePaths.length} files`);
    await metadata.flush();

    const files = await fetchMultipleFiles(owner, repo, filePaths, accessToken);

    const successCount = files.filter(f => !f.error).length;
    console.log(`[explore-repo] Step 3 done: read ${successCount}/${filePaths.length} files`);
    logger.info(`Successfully read ${successCount}/${filePaths.length} files`);

    // Step 4: Claude synthesizes findings (~5s)
    console.log(`[explore-repo] Step 4: Synthesizing findings with Haiku...`);
    logger.info('Synthesizing exploration findings...');
    metadata.set('currentStep', 'Analyzing code patterns');
    metadata.append('steps', { action: 'Analyzing code patterns', toolName: 'synthesize', toolInput: { focus_area: focusArea }, timestamp: Date.now() });
    await metadata.flush();

    const findingsJson = await synthesizeFindings(
      client, model, files, focusArea, previousFindings, specificQuestion, treeListing
    );

    console.log(`[explore-repo] Done! Findings length: ${findingsJson?.length} chars`);
    logger.info('Exploration complete');
    metadata.set('currentStep', 'complete');

    // Return structured findings + metadata
    return {
      findings: findingsJson,
      filesRead: filePaths,
      focusArea,
      fileCount: tree.length,
    };
  },
});
