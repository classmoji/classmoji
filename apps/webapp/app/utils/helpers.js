import _ from 'lodash';
import pWaitFor from 'p-wait-for';
import { runs } from '@trigger.dev/sdk';
import { redirect } from 'react-router';

import { getAuthSession } from '@classmoji/auth/server';
import { ClassmojiService } from '@classmoji/services';

export const sleep = async ms => {
  return new Promise(resolve => setTimeout(resolve, ms));
};

export const roundToTwo = num => Math.round((num + Number.EPSILON) * 100) / 100;

export const groupByYearAndTerm = memberships => {
  const seasonOrder = {
    Winter: 1,
    Spring: 2,
    Summer: 3,
    Fall: 4,
  };

  // Group memberships by a combination of year and term from the classroom object
  const grouped = _.groupBy(memberships, membership => {
    const { term, year } = membership.classroom;
    return `${year} ${term}`;
  });

  // Sort the keys based on year and season order
  const sortedKeys = _.orderBy(
    Object.keys(grouped),
    [
      key => parseInt(key.split(' ')[0]), // Sort by year first
      key => seasonOrder[key.split(' ')[1]], // Then by season order (Winter, Spring, etc.)
    ],
    ['asc', 'asc'] // Sort both year and term in ascending order
  );

  const sortedGrouped = {};
  sortedKeys.forEach(key => {
    sortedGrouped[key] = grouped[key];
  });

  return sortedGrouped;
};

// Server functions
export const pollRunStatus = async (runId, interval = 1000) => {
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

export const removeUsers = (data, num = 8) => {
  const testUsers = ['traorefly', 'papeturtle', 'jabbascript'];
  const list = data.filter(user => !testUsers.includes(user.login));
  return list.slice(0, num);
};

export const checkAuth = method => {
  return async args => {
    const authData = await getAuthSession(args.request);

    if (!authData) {
      throw redirect('/');
    }

    // Pass user data to the wrapped method with `id` alias for compatibility
    return method({ ...args, user: { ...authData, id: authData.userId } });
  };
};

const normalizeAuditResourceId = resourceId => {
  if (resourceId === null || resourceId === undefined) {
    return null;
  }

  if (typeof resourceId === 'string') {
    const trimmed = resourceId.trim();
    return trimmed.length ? trimmed : null;
  }

  try {
    return String(resourceId);
  } catch (error) {
    console.warn('[normalizeAuditResourceId] Failed to convert resource id to string', error);
    return null;
  }
};

export const addAuditLog = async ({
  request,
  params,
  action,
  resourceType,
  resourceId = null,
  metadata = null,
}) => {
  const authData = await getAuthSession(request);
  if (!authData) {
    console.error('Unable to add audit log: No auth session found');
    return;
  }
  const { userId } = authData;
  const classroom = await ClassmojiService.classroom.findBySlug(params.class);
  const membership = await ClassmojiService.classroomMembership.findByClassroomAndUser(
    classroom?.id,
    userId
  );

  const normalizedResourceId = normalizeAuditResourceId(resourceId);

  const auditData = {
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

  ClassmojiService.audit.create(auditData);
};

// Re-export from shared auth package for backward compatibility
export { assertClassroomAccess, requireStudentAccess } from '@classmoji/auth/server';

// NOTE: sanitizeClassroomForClient was removed - assertClassroomAccess now sanitizes automatically.
// For direct findBySlug calls, use ClassmojiService.classroom.getClassroomForUI()

export const waitForRunCompletion = async runId => {
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
  const isSuccess = finalRun?.status === 'COMPLETED' || finalRun?.status === 'COMPLETED_SUCCESSFULLY';
  if (finalRun && !isSuccess) {
    const error = new Error(`Task failed with status: ${finalRun.status}`);
    error.runId = runId;
    error.status = finalRun.status;
    throw error;
  }

  return finalRun;
};
