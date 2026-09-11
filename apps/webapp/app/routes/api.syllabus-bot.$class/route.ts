/**
 * API endpoint for Syllabus Bot
 * Course assistant for students and instructors
 *
 * POST actions:
 * - initConversation: Initialize a new syllabus bot conversation
 * - sendMessage: Send a message to the bot
 * - endConversation: End and cleanup the conversation
 *
 * GET loader:
 * - Returns org config for the syllabus bot (enabled status, etc.)
 *
 * SECURITY: Uses signed WebSocket connection via aiAgentConnection.server.js
 * All payloads are HMAC-signed before being sent to ai-agent service.
 */

import { assertClassroomAccess } from '~/utils/helpers';
import { assertClassroomMutationAllowed } from '~/utils/routeAuth.server';
import { isAIAgentConfigured } from '~/utils/aiFeatures.server';
import { getContentRepoName } from '@classmoji/utils';
import { sendRequest } from '~/services/aiAgentConnection.server';
import agentStreamManager from '~/utils/agentStreamManager';
import { v4 as uuidv4 } from 'uuid';
import { ClassmojiService } from '@classmoji/services';
import { mintMcpAccessToken } from '@classmoji/auth/mcp-token';
import getPrisma from '@classmoji/database';
import type { Route } from './+types/route';

// Helper to create JSON responses
const jsonResponse = (data: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * The roles that may use the bot at all. One list, so the send/end/init gates
 * and the conversation lookup below cannot drift apart.
 */
const BOT_ROLES = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'] as const;

/**
 * The one thing a failed turn says to the browser. Deliberately says nothing
 * about WHY: see the catch in handleSendMessage. Matches the wording the init
 * path already uses for its mint failure, so a user sees one voice from the
 * feature rather than two.
 */
const SEND_MESSAGE_FAILED = 'Could not send your message. Please try again.';

/**
 * Mint the MCP bearer this turn will carry (plan P1-3).
 *
 * EVERY turn, not just init. ai-agent builds its agent config once at init and
 * reuses it for the life of the conversation, so a token embedded only at init
 * would die an hour in and take a long conversation's tool access with it; the
 * ai-agent side overwrites the stored header from this field on each turn. Every
 * turn is a fresh, already-authenticated webapp request, so re-minting is free
 * and `mintMcpAccessToken` reuses a live row rather than writing one per message.
 *
 * A mint failure FAILS THE TURN. There is deliberately no fallback to a previous
 * turn's token: a stale header is exactly the thing the per-turn mint exists to
 * prevent.
 *
 * NEVER LOG THE RESULT. `accessToken` is a bearer for the caller's whole MCP read
 * surface; it travels only inside the HMAC-signed webapp -> ai-agent payload and
 * never reaches the browser.
 *
 * `expiresAt` is sent as an ISO string rather than a `Date`: socket.io's JSON
 * parser would flatten it to one anyway, and the HMAC both sides compute is taken
 * over `JSON.stringify`, so sending the string is what actually crosses the wire
 * in either case — spelling it out keeps the receiving end from having to guess.
 */
async function mintTurnMcpToken(userId: string): Promise<{
  accessToken: string;
  expiresAt: string;
}> {
  const { accessToken, expiresAt } = await mintMcpAccessToken(userId);
  return { accessToken, expiresAt: expiresAt.toISOString() };
}

/**
 * Resolve a client-supplied `conversationId` to a conversation that THIS caller
 * owns, in THIS classroom (review finding 3).
 *
 * Authorizing the URL's classroom and then forwarding whatever conversation id
 * the form carried is not enough: ai-agent looks the id up and mutates that
 * conversation on the strength of the webapp's HMAC alone, which authenticates
 * the webapp and says nothing about the end user's right to that particular
 * conversation. Without this, any member who learns another member's
 * conversation id can inject messages into it, replace the credential stored
 * against it, or end it.
 *
 * All four predicates go into ONE query on purpose. A caller who names someone
 * else's conversation, a conversation in a classroom they also belong to, or a
 * quiz conversation gets exactly the same answer as a caller who names an id
 * that does not exist — the response never distinguishes "no such conversation"
 * from "not yours", so the id space cannot be probed.
 */
async function findOwnedConversation({
  conversationId,
  userId,
  classroomId,
}: {
  conversationId: string;
  userId: string;
  classroomId: string;
}) {
  return getPrisma().aIConversation.findFirst({
    where: {
      id: conversationId,
      user_id: userId,
      classroom_id: classroomId,
      type: 'SYLLABUS_BOT',
    },
    select: { id: true },
  });
}

/** The one scoped not-found every conversation-binding failure returns. */
const conversationNotFound = () => jsonResponse({ error: 'Conversation not found' }, 404);

/**
 * The client's "view as" role, validated against the Role enum.
 *
 * PRESENTATION ONLY. This value reaches the system prompt (tone, and which
 * suggested questions ai-agent offers) and must never reach a permission
 * decision: the gates above resolve the caller's real membership, and every MCP
 * tool re-resolves the caller's real role for the classroom it names. Validating
 * it here keeps an arbitrary client string out of the prompt; it is NOT a
 * security control, because there is nothing security-shaped downstream of it.
 */
function presentationRole(raw: FormDataEntryValue | null, actualRole: string): string {
  return typeof raw === 'string' && (BOT_ROLES as readonly string[]).includes(raw)
    ? raw
    : actualRole;
}

/**
 * Does this classroom have a content repo at all?
 *
 * Drives whether the widget offers content questions. This is a NAME lookup — no
 * GitHub call, no credential — and it is the only thing left of what used to be
 * the clone handoff.
 *
 * THE PRECEDENCE IS LOAD-BEARING, in this exact order:
 *
 *   1. `settings.content_repo_name` — the legacy per-classroom override. A
 *      classroom configured ONLY through it has a null `content_repo` and, quite
 *      possibly, an org whose conventional repo does not exist. Dropping this
 *      term (which the consolidation into one helper briefly did) tells those
 *      classrooms they have no content: the widget stops offering content
 *      questions even though the MCP would have answered them.
 *   2. `classroom.content_repo` — the stored, user-editable repo name, and the
 *      normal answer for anything configured since.
 *   3. the org-level convention, for legacy classrooms that predate both.
 *
 * This is the same chain the old init path used when it decided whether to hand
 * ai-agent a clone target, so the widget's answer does not change for any
 * classroom that worked before the GitHub handoff was removed.
 */
function hasContentRepoFor(
  classroom: {
    content_repo?: string | null;
    git_organization?: { login?: string | null } | null;
  },
  settings: { content_repo_name?: string | null } | null | undefined
): boolean {
  const gitOrgLogin = classroom.git_organization?.login;
  return Boolean(
    settings?.content_repo_name ||
    classroom.content_repo ||
    (gitOrgLogin ? getContentRepoName({ login: gitOrgLogin }) : '')
  );
}

/**
 * GET loader - return org config for syllabus bot
 * Used to check if syllabus bot is enabled and get suggested questions
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  const classSlug = params.class!;

  // Verify user has access to the org (any role can use syllabus bot)
  const { classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: [...BOT_ROLES],
    resourceType: 'SYLLABUS_BOT',
    attemptedAction: 'check_config',
  });

  // If AI agent is not configured, report as disabled
  if (!isAIAgentConfigured()) {
    return jsonResponse({
      enabled: false,
      hasContentRepo: false,
      userRole: membership!.role,
      isInstructor: ['OWNER', 'TEACHER'].includes(membership!.role),
      orgName: classroom.name,
    });
  }

  // Pro-gated, same as quizzes. Entitlement is checked on every request rather
  // than baked into settings, so a lapsed plan stops serving the bot without
  // anyone rewriting syllabus_bot_enabled.
  const entitlement = await ClassmojiService.entitlement.canUseSyllabusBot(classroom.id);
  if (!entitlement.allowed) {
    const staff = ['OWNER', 'TEACHER'].includes(membership!.role);
    return jsonResponse({
      enabled: false,
      hasContentRepo: false,
      userRole: membership!.role,
      isInstructor: staff,
      orgName: classroom.name,
      // Staff get a reason so the UI can explain/upsell; students just see it off.
      ...(staff ? { reason: entitlement.reason } : {}),
    });
  }

  const settings = await ClassmojiService.classroom.getClassroomSettingsForServer(classroom.id);
  const isInstructor = ['OWNER', 'TEACHER'].includes(membership!.role);

  return jsonResponse({
    enabled: settings?.syllabus_bot_enabled ?? false,
    hasContentRepo: hasContentRepoFor(classroom, settings),
    userRole: membership!.role,
    isInstructor,
    orgName: classroom.name,
    courseName: (settings as { course_name?: string })?.course_name,
    slidesUrl: process.env.SLIDES_URL || 'http://localhost:6500',
    // The widget builds page links from this; it must come from the server
    // because client code has no process.env.
    pagesUrl: process.env.PAGES_URL || 'http://localhost:7100',
  });
}

export async function action({ params, request }: Route.ActionArgs) {
  const classSlug = params.class!;
  const formData = await request.formData();
  const _action = formData.get('_action');

  if (!isAIAgentConfigured()) {
    return jsonResponse({ error: 'AI features are not configured' }, 503);
  }

  switch (_action) {
    case 'initConversation':
      return handleInitConversation(request, classSlug, formData);
    case 'sendMessage':
      return handleSendMessage(request, classSlug, formData);
    case 'endConversation':
      return handleEndConversation(request, classSlug, formData);
    default:
      return jsonResponse({ error: `Unknown action: ${_action}` }, 400);
  }
}

/**
 * Initialize a syllabus bot conversation
 *
 * NOTE: Unlike quiz sessions, the conversationId is generated by ai-agent (from AIConversation.id).
 * Webapp receives this ID in the SYLLABUS_BOT_READY response and registers SSE stream afterward.
 */
async function handleInitConversation(request: Request, classSlug: string, formData: FormData) {
  // Verify user has access (any role can use syllabus bot)
  const { userId, classroom, membership } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: [...BOT_ROLES],
    resourceType: 'SYLLABUS_BOT',
    attemptedAction: 'init_conversation',
  });
  assertClassroomMutationAllowed({ status: classroom.status, role: membership!.role });

  // After the access check, so this never reveals a classroom's plan to a non-member.
  const entitlement = await ClassmojiService.entitlement.canUseSyllabusBot(classroom.id);
  if (!entitlement.allowed) {
    return jsonResponse({ error: 'The syllabus assistant requires a Pro subscription' }, 403);
  }

  const settings = await ClassmojiService.classroom.getClassroomSettingsForServer(classroom.id);

  // Check if syllabus bot is enabled
  if (!settings?.syllabus_bot_enabled) {
    return jsonResponse({ error: 'Syllabus bot is not enabled for this course' }, 403);
  }

  // Use URL-based role context if provided, otherwise fall back to membership role
  // This allows owners visiting /student/... to be treated as students.
  // Presentation only — see presentationRole(); it shapes the prompt, never a gate.
  const contextRole = presentationRole(formData.get('userRole'), membership!.role);

  // Build org context for the bot
  const orgConfig = {
    orgId: classroom.id.toString(),
    classroomSlug: classSlug,
    gitOrgLogin: classroom.git_organization?.login, // GitHub org for content repo cloning
    orgName: classroom.name,
    courseName: (settings as { course_name?: string })?.course_name || classroom.name,
    userRole: contextRole,
  };

  // The MCP bearer this turn carries. Minted before anything is sent, so a mint
  // failure fails the turn instead of opening a conversation that cannot read.
  let mcpToken: { accessToken: string; expiresAt: string };
  try {
    mcpToken = await mintTurnMcpToken(userId.toString());
  } catch (error: unknown) {
    // Deliberately logs the failure, never the token.
    console.error('[syllabus-bot] Failed to mint MCP token for init:', error);
    return jsonResponse({ error: 'Could not start the assistant. Please try again.' }, 500);
  }

  // Build payload for ai-agent (no conversationId - ai-agent generates it)
  const payload = {
    userId: userId.toString(),
    orgConfig,
    llmConfig: {
      anthropicApiKey: settings?.anthropic_api_key,
      model: settings?.syllabus_bot_model || settings?.llm_model,
    },
    mcpToken,
  };

  // NO GITHUB CREDENTIAL LEAVES THIS ROUTE (plan P3-3).
  //
  // This used to mint the classroom's whole GitHub App installation token and
  // hand it to ai-agent so the bot could clone the content repo. That single
  // handoff carried four problems: a live GitHub credential on another
  // service's filesystem, a clone that grew without bound, a draft leak (the
  // repo answers every role identically), and a second content-query layer
  // that drifted from the webapp's own rules at each migration. ai-agent now
  // reads course content through the Classmoji MCP server using `mcpToken`
  // above — the CALLER's own bearer, re-authorized per tool call — so there is
  // nothing for this route to hand over.

  try {
    // Initialize conversation via signed ai-agent connection
    // ai-agent creates the conversation and generates the conversationId
    const result = await sendRequest('SYLLABUS_BOT_INIT', payload, {
      timeout: 300000, // 5 min — ai-agent's MCP handshake plus first-turn latency
      responseTypes: ['SYLLABUS_BOT_READY'],
    });

    // Get the ai-agent-generated conversationId from response
    const resultPayload = (
      result as unknown as {
        payload: {
          conversationId: string;
          welcomeMessage: string;
          suggestedQuestions?: string[];
        };
      }
    ).payload;
    const conversationId = resultPayload.conversationId;

    // NOW register for SSE stream (after we have the real conversationId)
    agentStreamManager.registerSession(conversationId, classSlug, userId);

    return jsonResponse({
      success: true,
      conversationId, // Use ai-agent's ID
      welcomeMessage: resultPayload.welcomeMessage,
      // Computed HERE, not echoed back from ai-agent. ai-agent no longer
      // clones anything, so it has no idea whether a course has content; the
      // loader above answers the same question from the same fields.
      hasContentRepo: hasContentRepoFor(classroom, settings),
      suggestedQuestions: resultPayload.suggestedQuestions,
    });
  } catch (error: unknown) {
    console.error('[syllabus-bot] Init failed:', error);
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}

/**
 * Send message to syllabus bot
 *
 * This uses sendRequest with SYLLABUS_BOT_MESSAGE type.
 * The response comes via WebSocket and is published to stream manager.
 */
async function handleSendMessage(request: Request, classSlug: string, formData: FormData) {
  const conversationId = formData.get('conversationId') as string | null;
  const content = formData.get('content') as string | null;

  // Verify user has access
  const {
    userId,
    classroom: smClassroom,
    membership: smMembership,
  } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: [...BOT_ROLES],
    resourceType: 'SYLLABUS_BOT',
    attemptedAction: 'send_message',
  });
  assertClassroomMutationAllowed({ status: smClassroom.status, role: smMembership!.role });

  // Gate the expensive path too — a session created before the plan lapsed must
  // not keep buying inference. endConversation is deliberately NOT gated, so an
  // already-open session can still be cleaned up.
  const smEntitlement = await ClassmojiService.entitlement.canUseSyllabusBot(smClassroom.id);
  if (!smEntitlement.allowed) {
    return jsonResponse({ error: 'The syllabus assistant requires a Pro subscription' }, 403);
  }

  if (!conversationId || !content) {
    return jsonResponse({ error: 'Missing conversationId or content' }, 400);
  }

  // The conversation must belong to THIS user in THIS classroom before ai-agent
  // is asked to touch it. Runs before any ai-agent call, so a rejected id buys
  // no inference and leaves no transcript.
  const conversation = await findOwnedConversation({
    conversationId,
    userId: userId.toString(),
    classroomId: smClassroom.id,
  });
  if (!conversation) {
    return conversationNotFound();
  }

  try {
    const messageId = uuidv4();

    // Stream handler for exploration steps during message processing
    const onStreamData = (step: Record<string, unknown>) => {
      console.log('[syllabus-bot] Publishing exploration step:', step?.action);
      agentStreamManager.publishStep(conversationId, step);
    };

    // A FRESH token every turn — ai-agent overwrites its stored header from this
    // field, so a conversation that outlives the one-hour TTL keeps working.
    const mcpToken = await mintTurnMcpToken(userId.toString());

    // Send message via signed connection and wait for response
    const result = await sendRequest(
      'SYLLABUS_BOT_MESSAGE',
      { conversationId, content, messageId, mcpToken },
      {
        timeout: 300000, // 5 min timeout for LLM response + exploration
        responseTypes: ['SYLLABUS_BOT_RESPONSE'],
        onStreamData,
      }
    );

    // Publish the response to stream manager for SSE delivery
    // Use publishAssistantResponse (type: 'assistant_response') which the frontend hook expects
    const resultPayload = (
      result as unknown as {
        payload: { content: string; references?: unknown[]; explorationSteps?: unknown[] };
      }
    ).payload;
    agentStreamManager.publishAssistantResponse(conversationId, {
      content: resultPayload.content,
      references: resultPayload.references,
      explorationSteps: resultPayload.explorationSteps,
    });

    return jsonResponse({ success: true, messageId });
  } catch (error: unknown) {
    // The DETAIL stays server-side. It used to be echoed to the browser
    // verbatim, through both the JSON body and the SSE error event, which was
    // already loose and became a real leak once this path started minting an MCP
    // token: everything that can fail here — `mintMcpAccessToken`, Prisma, the
    // ai-agent socket — throws messages written for an operator, carrying
    // connection strings, internal hostnames, constraint and column names, and
    // stack-shaped detail. A chat member is not the audience for any of it, and
    // "what went wrong" is not something they can act on differently.
    //
    // Both exits get the same generic line, because the SSE channel reaches the
    // same browser as the response body — fixing one and not the other would
    // leave the leak open through the other door.
    console.error('[syllabus-bot] Send message failed:', error);
    agentStreamManager.publishError(conversationId, SEND_MESSAGE_FAILED);
    return jsonResponse({ error: SEND_MESSAGE_FAILED }, 500);
  }
}

/**
 * End syllabus bot conversation
 *
 * Sends SYLLABUS_BOT_END to cleanup resources on ai-agent side.
 * Similar to QUIZ_END, we don't wait for a response.
 */
async function handleEndConversation(request: Request, classSlug: string, formData: FormData) {
  const conversationId = formData.get('conversationId') as string | null;

  // Verify user has access
  const { userId, classroom } = await assertClassroomAccess({
    request,
    classroomSlug: classSlug,
    allowedRoles: [...BOT_ROLES],
    resourceType: 'SYLLABUS_BOT',
    attemptedAction: 'end_conversation',
  });

  if (!conversationId) {
    return jsonResponse({ error: 'Missing conversationId' }, 400);
  }

  // Same binding as sendMessage: terminating someone else's conversation is a
  // mutation too, and this path is deliberately NOT Pro-gated, so it would
  // otherwise be the cheapest way to reach another member's session.
  const conversation = await findOwnedConversation({
    conversationId,
    userId: userId.toString(),
    classroomId: classroom.id,
  });
  if (!conversation) {
    return conversationNotFound();
  }

  try {
    // Send end message via signed connection (no response expected)
    await sendRequest(
      'SYLLABUS_BOT_END',
      { conversationId },
      {
        timeout: 5000,
        responseTypes: [], // Don't wait for response
      }
    );

    // Cleanup stream manager
    agentStreamManager.publishDone(conversationId);

    return jsonResponse({ success: true });
  } catch (error: unknown) {
    console.error('[syllabus-bot] End conversation failed:', error);
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
}
