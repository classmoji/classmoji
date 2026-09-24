import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useRevalidator } from 'react-router';
import { Modal, Tag } from 'antd';
import { TriggerAuthContext, useRealtimeRunsWithTag } from '@trigger.dev/react-hooks';

import { FetcherContext, type ActiveOperation } from '~/contexts';
import { useCallout } from '@classmoji/ui-components';

/**
 * Progress for background work, reported in the callout instead of a modal.
 *
 * An action that queues Trigger.dev work hands back a `triggerSession`; the
 * global fetcher picks it up and this component, mounted once at the app root,
 * watches the batch and keeps one callout current. Nothing blocks, and because
 * it lives above the router the counts keep ticking while the instructor moves
 * around the app.
 *
 * Counts come from the runs themselves rather than from an estimate the server
 * sends: Trigger reports every run carrying the session tag, queued ones
 * included, so "18 of 30 repositories" is a fact about the work rather than a
 * percentage that has to be clamped.
 */

/** One unit of work, and the task that runs exactly once per unit. */
interface UnitSpec {
  tasks: string[];
  running: string;
  done: string;
  noun: string;
}

interface OperationSpec {
  /**
   * Ordered: the first shape with runs in it decides what a unit is here.
   * Publishing creates repositories, unless they already exist and it is only
   * opening the assignment inside them.
   */
  units: UnitSpec[];
  /** The placeholder callout the caller opened, which this one replaces. */
  notifyKey?: string;
}

const OPERATIONS: Record<string, OperationSpec> = {
  PUBLISH: {
    units: [
      {
        tasks: ['gh-create_git_repo'],
        running: 'Creating student repositories',
        done: 'Student repositories created',
        noun: 'repositories',
      },
      {
        tasks: ['gh-create_git_repo_assignment'],
        running: 'Opening the assignment for students',
        done: 'Assignment opened for students',
        noun: 'repositories',
      },
    ],
  },
  UPDATE_REPOS: {
    units: [
      {
        tasks: ['update_git_repo'],
        running: 'Updating student repositories',
        done: 'Student repositories updated',
        noun: 'repositories',
      },
    ],
  },
  CONTRIBUTIONS: {
    notifyKey: 'CALCULATE_REPO_CONTRIBUTIONS',
    units: [
      {
        tasks: ['calculate_repo_contributions'],
        running: 'Calculating contributions',
        done: 'Contributions calculated',
        noun: 'repositories',
      },
    ],
  },
  GRADERS: {
    units: [
      {
        tasks: ['add_grader_to_git_repo_assignment'],
        running: 'Assigning graders',
        done: 'Graders assigned',
        noun: 'assignments',
      },
    ],
  },
  TOKENS: {
    units: [
      {
        tasks: ['assign_tokens_to_student'],
        running: 'Assigning tokens',
        done: 'Tokens assigned',
        noun: 'students',
      },
    ],
  },
  AUTOGRADE: {
    notifyKey: 'AUTOGRADE_GIT_REPO_ASSIGNMENT',
    units: [
      {
        tasks: ['gh-commit_autograde_workflow'],
        running: 'Setting up autograding',
        done: 'Autograding set up',
        noun: 'repositories',
      },
    ],
  },
};

/** Which operation a task identifier belongs to. */
const OPERATION_BY_TASK: Record<string, string> = {
  'gh-create_git_repo': 'PUBLISH',
  'cf-create_git_repo': 'PUBLISH',
  'gh-create_git_repo_assignment': 'PUBLISH',
  'cf-create_git_repo_assignment': 'PUBLISH',
  'gh-add_collaborator_to_repo': 'PUBLISH',
  update_git_repo: 'UPDATE_REPOS',
  calculate_repo_contributions: 'CONTRIBUTIONS',
  add_grader_to_git_repo_assignment: 'GRADERS',
  assign_tokens_to_student: 'TOKENS',
  dispatch_autograde_workflow: 'AUTOGRADE',
  'gh-commit_autograde_workflow': 'AUTOGRADE',
};

const FAILED = ['FAILED', 'CRASHED', 'SYSTEM FAILURE', 'TIMED OUT', 'EXPIRED', 'CANCELED'];

/** How long to wait for the first run before giving up on a silent batch. */
const FIRST_RUN_TIMEOUT_MS = 30_000;

export interface OperationRun {
  id: string;
  taskIdentifier: string;
  status: string;
}

const outcome = (status: string) =>
  status === 'COMPLETED' ? 'done' : FAILED.includes(status) ? 'failed' : 'pending';

/**
 * Mounted once, at the app root. Holds the failure list itself so the details
 * survive the operation ending, which is what releases the slot for the next
 * one.
 */
export const OperationProgress = () => {
  const { operation } = useContext(FetcherContext);
  const [failures, setFailures] = useState<OperationRun[] | null>(null);

  return (
    <>
      {operation ? (
        // Keyed by session, so a second operation starts a clean subscription.
        <OperationWatcher
          key={operation.session.id}
          operation={operation}
          onFailures={setFailures}
        />
      ) : null}

      <Modal
        open={failures !== null}
        title="What did not finish"
        onCancel={() => setFailures(null)}
        onOk={() => setFailures(null)}
        okText="Close"
        cancelButtonProps={{ style: { display: 'none' } }}
        width={520}
      >
        <p className="text-ink-2 mb-3">
          These runs did not complete. Running the operation again retries only what is still
          missing.
        </p>
        <ul className="flex flex-col gap-2 max-h-80 overflow-y-auto">
          {(failures ?? []).map(run => (
            <li key={run.id} className="flex items-center justify-between gap-3">
              <span className="font-mono text-xs text-ink-2 truncate">{run.taskIdentifier}</span>
              <Tag color="red" className="m-0 shrink-0 font-medium">
                {run.status}
              </Tag>
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
};

const OperationWatcher = ({
  operation,
  onFailures,
}: {
  operation: ActiveOperation;
  onFailures: (runs: OperationRun[]) => void;
}) => (
  <TriggerAuthContext.Provider value={{ accessToken: operation.session.accessToken }}>
    <OperationRuns operation={operation} onFailures={onFailures} />
  </TriggerAuthContext.Provider>
);

const OperationRuns = ({
  operation,
  onFailures,
}: {
  operation: ActiveOperation;
  onFailures: (runs: OperationRun[]) => void;
}) => {
  const { runs, error } = useRealtimeRunsWithTag(`session_${operation.session.id}`);
  const { endOperation, dismissNotify } = useContext(FetcherContext);
  const callout = useCallout();
  const { revalidate } = useRevalidator();
  const settled = useRef(false);

  const finish = (payload: Parameters<typeof callout.update>[1]) => {
    settled.current = true;
    callout.update(operation.calloutId, payload);
    endOperation();
  };

  const progress = useMemo(() => {
    const all = (runs ?? []) as unknown as OperationRun[];
    if (all.length === 0) return null;

    const key = all.map(r => OPERATION_BY_TASK[r.taskIdentifier]).find(Boolean);
    const spec = key ? OPERATIONS[key] : undefined;
    if (!spec) return null;

    // The first unit shape with runs in it is the one being done here.
    const unit = spec.units.find(u => all.some(r => u.tasks.includes(r.taskIdentifier)));
    if (!unit) return null;

    const unitRuns = all.filter(r => unit.tasks.includes(r.taskIdentifier));
    let done = 0;
    const failed: OperationRun[] = [];
    for (const run of unitRuns) {
      const result = outcome(run.status);
      if (result === 'done') done += 1;
      else if (result === 'failed') failed.push(run);
    }
    // Every run in the batch has to settle, not only the ones that count as a
    // unit: a repository is not ready until its collaborator invite lands too.
    const complete = all.every(r => outcome(r.status) !== 'pending');
    return { spec, unit, total: unitRuns.length, done, failed, complete };
  }, [runs]);

  // A batch that never reports anything would otherwise spin forever.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (settled.current || (runs ?? []).length > 0) return;
      settled.current = true;
      callout.dismiss(operation.calloutId);
      endOperation();
    }, FIRST_RUN_TIMEOUT_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (settled.current) return;

    if (error) {
      finish({
        variant: 'error',
        title: 'Lost track of this operation',
        message: 'It may still be running. Reload to check.',
        persistent: true,
        progress: undefined,
      });
      return;
    }
    if (!progress) return;

    const { spec, unit, total, done, failed, complete } = progress;

    // Whatever the caller put up before the work started is redundant now.
    if (spec.notifyKey) dismissNotify(spec.notifyKey);

    if (!complete) {
      callout.update(operation.calloutId, {
        variant: 'progress',
        title: unit.running,
        message: `${done} of ${total} ${unit.noun}`,
        progress: total > 0 ? done / total : 0,
        persistent: true,
      });
      return;
    }

    // The work changed what the page is showing: repositories, graders, tokens.
    revalidate();

    if (failed.length > 0) {
      finish({
        variant: 'error',
        title: `${done} of ${total} ${unit.noun} finished`,
        message: `${failed.length} could not be completed`,
        persistent: true,
        progress: undefined,
        action: { label: 'Details', onClick: () => onFailures(failed) },
      });
    } else {
      finish({
        variant: 'success',
        title: unit.done,
        message: `${total} ${unit.noun}`,
        persistent: false,
        progress: undefined,
        autoDismissMs: 4000,
      });
    }
    // `callout` is stable per provider; the rest are refs and setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, error]);

  return null;
};

export default OperationProgress;
