import pWaitFor from 'p-wait-for';
import { runs } from '@trigger.dev/sdk';
import { redirect } from 'react-router';

import { getAuthSession } from '@classmoji/auth/server';
import { ClassmojiService } from '@classmoji/services';

export const sleep = async (ms: number) => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

export const roundToTwo = (num: number) => Math.round((num + Number.EPSILON) * 100) / 100;

// Server functions
export const pollRunStatus = async (runId: string, interval = 1000) => {
  return pWaitFor(
    async () => {
      const { status } = await runs.retrieve(runId); // Retrieve the current task status
      return status === 'COMPLETED'; // Resolve when the status is 'completed'
    },
    {
      interval: interval,
    }
  );
};

export const removeUsers = (data: Array<{ login: string; [key: string]: unknown }>, num = 8) => {
  const testUsers = ['traorefly', 'papeturtle', 'jabbascript'];
  const list = data.filter(user => !testUsers.includes(user.login));
  return list.slice(0, num);
};

export const checkAuth = (
  method: (args: {
    request: Request;
    params: Record<string, string | undefined>;
    user: { userId: string; id: string; [key: string]: unknown };
  }) => unknown
) => {
  return async (args: { request: Request; params: Record<string, string | undefined> }) => {
    const authData = await getAuthSession(args.request);

    if (!authData) {
      throw redirect('/');
    }

    // Pass user data to the wrapped method with `id` alias for compatibility
    return method({ ...args, user: { ...authData, id: authData.userId } });
  };
};

const normalizeAuditResourceId = (resourceId: string | number | null | undefined) => {
  if (resourceId === null || resourceId === undefined) {
    return null;
  }

  if (typeof resourceId === 'string') {
    const trimmed = resourceId.trim();
    return trimmed.length ? trimmed : null;
  }

  try {
    return String(resourceId);
  } catch (error: unknown) {
    console.warn('[normalizeAuditResourceId] Failed to convert resource id to string', error);
    return null;
  }
};

interface AuditLogParams {
  request: Request;
  params: Record<string, string | undefined>;
  action: string;
  resourceType: string;
  resourceId?: string | number | null;
  metadata?: Record<string, unknown> | null;
}

export const addAuditLog = async ({
  request,
  params,
  action,
  resourceType,
  resourceId = null,
  metadata = null,
}: AuditLogParams) => {
  const authData = await getAuthSession(request);
  if (!authData) {
    console.error('Unable to add audit log: No auth session found');
    return;
  }
  const { userId } = authData;
  const classroom = await ClassmojiService.classroom.findBySlug(params.class!);
  const membership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
    classroom?.id ?? '',
    userId
  );

  const normalizedResourceId = normalizeAuditResourceId(resourceId);

  const auditData: {
    classroom_id: string | undefined;
    user_id: string;
    role: string | undefined;
    resource_id: string | null;
    resource_type: string;
    action: string;
    data?: Record<string, unknown>;
  } = {
    classroom_id: classroom?.id,
    user_id: userId,
    role: membership?.role,
    resource_id: normalizedResourceId,
    resource_type: resourceType,
    action,
  };

  const dataPayload = {
    ...(metadata || {}),
  };

  if (Object.keys(dataPayload).length > 0) {
    auditData.data = dataPayload;
  }

  ClassmojiService.audit.create(auditData as Parameters<typeof ClassmojiService.audit.create>[0]);
};

// Re-export from shared auth package for backward compatibility
export { assertClassroomAccess, requireStudentAccess } from '@classmoji/auth/server';

// NOTE: sanitizeClassroomForClient was removed - assertClassroomAccess now sanitizes automatically.
// For direct findBySlug calls, use ClassmojiService.classroom.getClassroomForUI()

export const waitForRunCompletion = async (runId: string) => {
  let finalRun;
  for await (const run of runs.subscribeToRun(runId)) {
    if (run.isCompleted) {
      finalRun = run;
      break;
    }
  }

  // Check for success statuses. Everything else is a failure.
  // COMPLETED_SUCCESSFULLY is normalized to COMPLETED internally by Trigger SDK,
  // but we check both just in case.
  const isSuccess =
    finalRun?.status === 'COMPLETED' || (finalRun?.status as string) === 'COMPLETED_SUCCESSFULLY';
  if (finalRun && !isSuccess) {
    const error = Object.assign(new Error(`Task failed with status: ${finalRun.status}`), {
      runId,
      status: finalRun.status,
    });
    throw error;
  }

  return finalRun;
};
