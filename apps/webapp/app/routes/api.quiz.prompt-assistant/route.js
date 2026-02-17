/**
 * API endpoint for Quiz Prompt Assistant
 * Helps instructors create quiz prompts via conversational AI
 *
 * POST actions:
 * - initSession: Initialize a new prompt assistant session
 * - sendMessage: Send a message to the assistant
 * - endSession: End and cleanup the session
 *
 * SECURITY: Uses signed WebSocket connection via aiAgentConnection.server.js
 * All payloads are HMAC-signed before being sent to ai-agent service.
 */

import { assertClassroomAccess } from '~/utils/helpers';
import { isAIAgentConfigured } from '~/utils/aiFeatures.server';
import { sendRequest } from '~/services/aiAgentConnection.server';
import agentStreamManager from '~/utils/agentStreamManager';
import { v4 as uuidv4 } from 'uuid';
import { getInstallationToken } from '~/routes/student.$class.quizzes/helpers.server';

// Helper to create JSON responses
const jsonResponse = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export async function action({ request }) {
  const formData = await request.formData();
  const _action = formData.get('_action');

  if (!isAIAgentConfigured()) {
    return jsonResponse({ error: 'AI features are not configured' }, 503);
  }

  switch (_action) {
    case 'initSession':
      return handleInitSession(request, formData);
    case 'sendMessage':
      return handleSendMessage(request, formData);
    case 'endSession':
      return handleEndSession(request, formData);
    default:
      return jsonResponse({ error: `Unknown action: ${_action}` }, 400);
  }
}

/**
 * Initialize a prompt assistant session
 *
 * NOTE: Unlike the old pattern, we don't generate sessionId here.
 * ai-agent creates an AIConversation record and returns the database-generated ID.
 * This matches the syllabus bot pattern for consistency and security.
 */
async function handleInitSession(request, formData) {
  const classroomSlug = formData.get('classroomSlug');
  const formContextJson = formData.get('formContext');
  const exampleRepoUrl = formData.get('exampleRepoUrl');

  // Verify instructor has access to the classroom
  const { userId, classroom } = await assertClassroomAccess({
    request,
    classroomSlug,
    allowedRoles: ['OWNER', 'ASSISTANT'],
    resourceType: 'PROMPT_ASSISTANT',
    attemptedAction: 'init_session',
  });

  // Get classroom settings for LLM config
  const { ClassmojiService } = await import('@classmoji/services');
  const settings = await ClassmojiService.classroom.getClassroomSettingsForServer(classroom.id);

  // Parse form context
  let formContext = {};
  try {
    formContext = JSON.parse(formContextJson || '{}');
  } catch (error) {
    console.warn('[prompt-assistant] Failed to parse formContext:', error.message);
  }

  // Build payload for ai-agent (no sessionId - ai-agent generates it)
  const payload = {
    userId: userId.toString(),
    classroomId: classroom.id.toString(),
    formContext,
    anthropicApiKey: settings?.anthropic_api_key,
    model: settings?.llm_model,
  };

  // If example repo URL provided, parse and add clone info
  if (exampleRepoUrl) {
    try {
      const repoInfo = parseGitHubRepoUrl(exampleRepoUrl);
      if (repoInfo) {
        // Get installation token for the classroom's git org
        const accessToken = await getInstallationToken(classroom.git_organization);

        payload.orgLogin = repoInfo.owner;
        payload.repoName = repoInfo.repo;
        payload.accessToken = accessToken;
      }
    } catch (error) {
      console.warn('[prompt-assistant] Failed to parse example repo URL:', error.message);
    }
  }

  try {
    // Initialize session via signed ai-agent connection
    // ai-agent creates the conversation and generates the sessionId
    const result = await sendRequest('PROMPT_ASSISTANT_INIT', payload, {
      timeout: 60000, // Longer timeout for potential repo cloning
      responseTypes: ['PROMPT_ASSISTANT_READY'],
    });

    // Get the ai-agent-generated sessionId from response
    const sessionId = result.payload.sessionId;

    // NOW register for SSE stream (after we have the real sessionId)
    agentStreamManager.registerSession(sessionId, classroomSlug, userId);

    return jsonResponse({
      success: true,
      sessionId, // Use ai-agent's ID
      message: result.payload.message,
      hasCodeExploration: result.payload.hasCodeExploration || false,
    });
  } catch (error) {
    console.error('[prompt-assistant] Init failed:', error);
    return jsonResponse({ error: error.message }, 500);
  }
}

/**
 * Send message to prompt assistant
 */
async function handleSendMessage(request, formData) {
  const classroomSlug = formData.get('classroomSlug');
  const sessionId = formData.get('sessionId');
  const content = formData.get('content');

  // Verify instructor has access
  await assertClassroomAccess({
    request,
    classroomSlug,
    allowedRoles: ['OWNER', 'ASSISTANT'],
    resourceType: 'PROMPT_ASSISTANT',
    attemptedAction: 'send_message',
  });

  if (!sessionId || !content) {
    return jsonResponse({ error: 'Missing sessionId or content' }, 400);
  }

  try {
    const messageId = uuidv4();

    // Stream handler for exploration steps during message processing
    const onStreamData = step => {
      agentStreamManager.publishStep(sessionId, step);
    };

    // Send message via signed connection and wait for response
    const result = await sendRequest('PROMPT_ASSISTANT_MESSAGE', {
      sessionId,
      content,
      messageId,
    }, {
      timeout: 300000, // 5 min timeout for LLM response
      responseTypes: ['PROMPT_ASSISTANT_RESPONSE'],
      onStreamData,
    });

    // Publish the response to stream manager for SSE delivery
    agentStreamManager.publishMessageReady(sessionId, {
      content: result.payload.content,
      suggestions: result.payload.suggestions,
      explorationSteps: result.payload.explorationSteps || [],
    });

    return jsonResponse({ success: true, messageId });
  } catch (error) {
    console.error('[prompt-assistant] Send message failed:', error);
    agentStreamManager.publishError(sessionId, error);
    return jsonResponse({ error: error.message }, 500);
  }
}

/**
 * End prompt assistant session
 */
async function handleEndSession(request, formData) {
  const classroomSlug = formData.get('classroomSlug');
  const sessionId = formData.get('sessionId');

  // Verify instructor has access
  await assertClassroomAccess({
    request,
    classroomSlug,
    allowedRoles: ['OWNER', 'ASSISTANT'],
    resourceType: 'PROMPT_ASSISTANT',
    attemptedAction: 'end_session',
  });

  if (!sessionId) {
    return jsonResponse({ error: 'Missing sessionId' }, 400);
  }

  try {
    // Send end message via signed connection (no response expected)
    await sendRequest('PROMPT_ASSISTANT_END', { sessionId }, {
      timeout: 5000,
      responseTypes: [], // Don't wait for response
    });

    // Cleanup stream manager
    agentStreamManager.publishDone(sessionId);

    return jsonResponse({ success: true });
  } catch (error) {
    // Cleanup is best-effort, still return success
    console.error('[prompt-assistant] End session error (non-fatal):', error);
    return jsonResponse({ success: true });
  }
}

/**
 * Parse GitHub repo URL to extract owner and repo name
 * Supports: https://github.com/owner/repo, git@github.com:owner/repo.git
 */
function parseGitHubRepoUrl(url) {
  if (!url) return null;

  // HTTPS format: https://github.com/owner/repo
  const httpsMatch = url.match(/github\.com\/([^/]+)\/([^/\s.]+)/);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2].replace(/\.git$/, '') };
  }

  // SSH format: git@github.com:owner/repo.git
  const sshMatch = url.match(/git@github\.com:([^/]+)\/([^/\s.]+)/);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2].replace(/\.git$/, '') };
  }

  return null;
}
