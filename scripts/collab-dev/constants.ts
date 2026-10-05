/**
 * Shared names for the live-editing dev fixtures: the seed creates them, the
 * acceptance spec (tests/collab) and the README refer to them. Change a value
 * here and both follow.
 *
 * Plain data only — no imports — so Playwright and `node
 * --experimental-strip-types` can both load it.
 */

/** The dev classroom Tim created through the UI on org classmoji-development. */
export const CLASSROOM_ID = 'e8fa398c-d42e-46fe-b240-fddd1a72b1dc';
export const CLASSROOM_SLUG = 'musashibot-testing';
/** MCP tools take a classroom as `org/slug`. */
export const CLASSROOM_REF = `classmoji-development/${CLASSROOM_SLUG}`;

/** The classroom owner (signed in through real GitHub OAuth). */
export const OWNER_LOGIN = 'timofei7';

export interface CollabTestUser {
  login: string;
  /** Fake, stable Github id — these accounts never sign in through GitHub. */
  githubId: string;
  name: string;
  email: string;
  role: 'TEACHER' | 'ASSISTANT';
}

/**
 * Seeded test users. Names are chosen so the avatar initials differ
 * ("C1", "C2", "CA") and the lock badge's holder name is unambiguous.
 */
export const COLLAB_USERS: CollabTestUser[] = [
  {
    login: 'collab-teacher-1',
    githubId: '90000101',
    name: 'Collab Teacher 1',
    email: 'collab-teacher-1@dev.local',
    role: 'TEACHER',
  },
  {
    login: 'collab-teacher-2',
    githubId: '90000102',
    name: 'Collab Teacher 2',
    email: 'collab-teacher-2@dev.local',
    role: 'TEACHER',
  },
  {
    login: 'collab-assistant',
    githubId: '90000103',
    name: 'Collab Assistant',
    email: 'collab-assistant@dev.local',
    role: 'ASSISTANT',
  },
];

export const KITCHEN_SINK_PAGE_TITLE = 'Kitchen sink page';
export const KITCHEN_SINK_DECK_TITLE = 'Kitchen sink deck';
export const PLAIN_PAGE_TITLE = 'Plain collab page';
export const PLAIN_DECK_TITLE = 'Plain collab deck';

/** The paragraph both browsers type into on the kitchen-sink page. */
export const PAGE_TARGET_TEXT = 'Shared paragraph: two people type here.';

/**
 * Kitchen-sink deck slides 2 and 3 (Reveal hashes #/1 and #/2) are plain text
 * slides so the acceptance spec can lock one and edit the other.
 */
export const DECK_SLIDE_A_TEXT = 'Editable slide A: the first editor takes this one.';
export const DECK_SLIDE_B_TEXT = 'Editable slide B: the second editor works here.';
