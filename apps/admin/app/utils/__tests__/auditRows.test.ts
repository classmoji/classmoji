import { describe, expect, it } from 'vitest';
import { auditTool, classroomActivityText, personHistoryText } from '../auditRows.ts';

const row = (action: string, resource_type: string, tool?: string) => ({
  action,
  resource_type,
  data: tool ? { tool } : null,
});

describe('audit rows on the classroom and person pages', () => {
  it('prints a row under its retired name the same as one under the current name', () => {
    const pairs: Array<[string, string, string?]> = [
      ['ASSIGNMENTS', 'ASSIGNMENT'],
      ['MODULE', 'MODULES'],
      ['REGRADE_REQUESTS', 'REGRADE_REQUEST'],
      ['TEACHING_STAFF', 'STAFF'],
      ['TEACHING_STAFF_DETAILS', 'STAFF'],
      ['REPOSITORY_ASSIGNMENT', 'GIT_REPO_ASSIGNMENT'],
      ['TEAM', 'TEAMS'],
      ['SLIDE', 'SLIDES'],
      ['SLIDE_CONTENT', 'SLIDES'],
      ['collab_page', 'PAGES'],
      ['collab_deck', 'SLIDES'],
    ];
    for (const [retired, current] of pairs) {
      for (const action of ['CREATE', 'UPDATE', 'DELETE', 'ACCESS_DENIED']) {
        expect(classroomActivityText(row(action, retired))).toBe(
          classroomActivityText(row(action, current))
        );
        expect(personHistoryText(row(action, retired))).toBe(
          personHistoryText(row(action, current))
        );
      }
    }
    expect(classroomActivityText(row('UPDATE', 'ASSIGNMENTS'))).toBe('update assignment');
    expect(personHistoryText(row('DELETE', 'collab_page'))).toBe('Deleted pages');
    expect(classroomActivityText(row('ACCESS_DENIED', 'REPOSITORY_ASSIGNMENT'))).toBe(
      'access denied git repo assignment'
    );
  });

  it('prints a tag row written as TEAMS as a tag row, and team rows as teams', () => {
    expect(personHistoryText(row('CREATE', 'TEAMS', 'tag_create'))).toBe('Created tags');
    expect(personHistoryText(row('CREATE', 'TAGS', 'tag_create'))).toBe('Created tags');
    expect(classroomActivityText(row('DELETE', 'TEAMS', 'web:settings.team.delete_tag'))).toBe(
      classroomActivityText(row('DELETE', 'TAGS', 'web:settings.team.delete_tag'))
    );
    expect(personHistoryText(row('CREATE', 'TEAMS', 'team_create'))).toBe('Created teams');
  });

  it('prints any other name as it is stored', () => {
    expect(classroomActivityText(row('UPDATE', 'CLASS_GRADES_SCREEN'))).toBe(
      'update class grades screen'
    );
    expect(personHistoryText(row('UPDATE', 'SOMETHING_ELSE'))).toBe('Changed something else');
  });

  it('reads the tool from the row data', () => {
    expect(auditTool({ tool: 'web:grades.view' })).toBe('web:grades.view');
    expect(auditTool(null)).toBeNull();
    expect(auditTool({})).toBeNull();
  });
});
