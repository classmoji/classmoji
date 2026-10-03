/**
 * The generated classroom.yml's report step. Issue #391: the step used to end
 * in `|| true`, so a report that could not reach Classmoji left the run green
 * and nobody knew. It now fails the step (visibly) while the check-run stays
 * green for the student.
 */
import { describe, expect, it } from 'vitest';
import { generateClassroomWorkflow } from '../generateClassroomWorkflow';

const tests = [{ name: 'Builds', method: 'COMMAND' as const, run_command: 'npm test' }];
const options = {
  triggerUrl: 'https://api.trigger.dev/api/v1/tasks/ingest_autograde_result/trigger',
  triggerToken: 'tr_pat_x',
  classroomSlug: 'cs101',
  hmacToken: 'hmac',
};

describe('generateClassroomWorkflow report step', () => {
  it('reports to the public trigger URL and fails loudly when it cannot', () => {
    const yaml = generateClassroomWorkflow(tests, options);
    expect(yaml).toContain('- name: Report results to Classmoji');
    expect(yaml).toContain(options.triggerUrl);
    expect(yaml).toContain('--fail-with-body');
    expect(yaml).toContain('::error::Could not report autograding results');
    expect(yaml).not.toContain('|| true');
  });

  it('keeps the student check green: the report step may fail on its own', () => {
    const yaml = generateClassroomWorkflow(tests, options);
    const step = yaml.slice(yaml.indexOf('Report results to Classmoji'));
    expect(step).toContain('continue-on-error: true');
  });

  it('omits the report step when there is nothing to report to', () => {
    const yaml = generateClassroomWorkflow(tests, {});
    expect(yaml).not.toContain('Report results to Classmoji');
  });
});

describe('generateClassroomWorkflow without a Trigger token', () => {
  it('reports to the given URL with no Authorization header', () => {
    const yaml = generateClassroomWorkflow(
      [{ name: 'passes', method: 'COMMAND', run_command: 'true' }],
      {
        triggerUrl: 'https://hooks.example.test/webhooks/callback/autograde',
        triggerToken: null,
        classroomSlug: 'c1',
        hmacToken: 'abc',
      }
    );
    expect(yaml).toContain('Report results to Classmoji');
    expect(yaml).toContain('https://hooks.example.test/webhooks/callback/autograde');
    expect(yaml).not.toContain('Authorization');
  });
});
