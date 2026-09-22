import type { FormField } from '@classmoji/services/form-contract';
import { makeField, makeOption, newId } from './fieldTypes.ts';

/**
 * Template presets for the New Form drawer.
 *
 * These are the three live forms this feature replaces, plus a blank. They are
 * plain field-set builders — no template machinery, no stored template records:
 * a preset produces a field list, `form.service.create` validates and
 * normalizes it through the same contract a hand-built form goes through, and
 * from that moment the form is an ordinary draft with no memory of where it
 * came from.
 *
 * Each preset is a FUNCTION, not a constant, because every call must mint fresh
 * ids — two forms created from the same template must not share field ids.
 *
 * `access` on a preset is the mode the drawer preselects. Team Review REQUIRES
 * Classroom: `repeat_group` and `roster_select` are `classroomOnly` in the
 * registry and the server rejects them on a PUBLIC form, so offering the choice
 * would only produce a save error.
 */

export type FormAccessMode = 'PUBLIC' | 'CLASSROOM';

export interface FormPreset {
  key: string;
  label: string;
  blurb: string;
  /** Preselected access mode. */
  access: FormAccessMode;
  /** True when the preset's fields cannot exist on a PUBLIC form. */
  requiresClassroom: boolean;
  /** Suggested title — the drawer prefills it, the instructor overwrites it. */
  suggestedTitle: string;
  fields: () => FormField[];
}

/** `makeField` then patch: keeps every starter shape valid by construction. */
const field = (type: Parameters<typeof makeField>[0], patch: Record<string, unknown>): FormField =>
  ({ ...makeField(type), ...patch }) as FormField;

const BLANK: FormPreset = {
  key: 'blank',
  label: 'Blank',
  blurb: 'Start with nothing and add fields yourself.',
  access: 'PUBLIC',
  requiresClassroom: false,
  suggestedTitle: '',
  fields: () => [],
};

const WAITLIST: FormPreset = {
  key: 'waitlist',
  label: 'Waitlist',
  blurb: 'Name, email, background, and an explanatory FIFO banner. Public link.',
  access: 'PUBLIC',
  requiresClassroom: false,
  suggestedTitle: 'Course Waitlist',
  fields: () => [
    field('banner', {
      text:
        'This waitlist is FIFO and balanced across class years. Getting on the waitlist does not ' +
        'guarantee a spot. If you have already filled this out, you do not need to do it again.',
      tone: 'info',
    }),
    field('short_text', { label: 'Full name', required: true }),
    field('email', {
      label: 'School email',
      required: true,
      help: 'We will send your confirmation link here.',
    }),
    field('opinion_scale', {
      label: 'How familiar are you with the material?',
      required: true,
      scale: { min: 1, max: 10, minLabel: 'Never tried it', maxLabel: 'I could teach it' },
    }),
    field('long_text', { label: 'What are you hoping to get out of the class?' }),
  ],
};

const PLANNING_SURVEY: FormPreset = {
  key: 'planning',
  label: 'Planning Survey',
  blurb: 'Start-of-term background check: tools used, experience, and an acknowledgment.',
  access: 'CLASSROOM',
  requiresClassroom: false,
  suggestedTitle: 'Term Planning Survey',
  fields: () => [
    field('heading', { text: 'Before the term starts' }),
    field('multiselect', {
      label: 'Which of these have you used before?',
      options: [
        makeOption('JavaScript'),
        makeOption('TypeScript'),
        makeOption('React'),
        makeOption('Node'),
        makeOption('Git / GitHub'),
        makeOption('SQL'),
        makeOption('None of these'),
      ],
    }),
    field('opinion_scale', {
      label: 'How comfortable are you building a full application?',
      required: true,
      scale: { min: 1, max: 5, minLabel: 'Not at all', maxLabel: 'Very' },
    }),
    field('long_text', { label: 'Anything you want the teaching team to know?' }),
    field('switch', {
      label: 'I understand course announcements go to Slack, not email.',
      required: true,
      help: 'A required switch is an acknowledgment — answering "no" does not satisfy it.',
    }),
  ],
};

const TEAM_REVIEW: FormPreset = {
  key: 'team-review',
  label: 'Team Review',
  blurb: 'A rubric matrix and comments, repeated once per teammate. Classroom only.',
  access: 'CLASSROOM',
  requiresClassroom: true,
  suggestedTitle: 'Team Peer Review',
  fields: () => {
    const contribution = makeOption('Contribution');
    const communication = makeOption('Communication');
    const reliability = makeOption('Reliability');
    const never = makeOption('Rarely', 'Missed most of what the team needed from them.');
    const sometimes = makeOption('Sometimes', 'Delivered, with reminders.');
    const always = makeOption('Consistently', 'Present for every meeting and every deadline.');

    return [
      field('paragraph', {
        text:
          'Your answers are visible only to the teaching team. Review each of your teammates — ' +
          'you will not review yourself.',
      }),
      field('long_text', {
        label: 'How would you describe your own contribution this term?',
      }),
      {
        ...makeField('repeat_group'),
        label: 'Review each teammate',
        // Scope starts at `classroom` — the only scope the contract accepts
        // without an id — and the builder's scope picker retargets it to the
        // tag or repository that actually defines the teams.
        fields: [
          {
            id: newId(),
            type: 'matrix',
            label: 'Rate this teammate',
            required: true,
            matrix: {
              rows: [contribution, communication, reliability],
              columns: [never, sometimes, always],
              required_rows: 'all',
            },
          },
          {
            id: newId(),
            type: 'long_text',
            label: 'Anything else about working with them?',
            required: false,
          },
        ],
      } as unknown as FormField,
    ];
  },
};

/**
 * Feeds the org project gallery: the New Form action turns the gallery on for
 * forms made from it. "Project title", not "Project name" — a short_text
 * labelled "name" is read as the respondent's name by `identityPlan`.
 */
const PROJECT_SHOWCASE: FormPreset = {
  key: 'showcase',
  label: 'Project Showcase',
  blurb: 'Title, summary, team and links. Approved entries appear in the org project gallery.',
  access: 'CLASSROOM',
  requiresClassroom: true,
  suggestedTitle: 'Project Showcase',
  fields: () => [
    field('short_text', { label: 'Project title', required: true, gallery_role: 'title' }),
    field('short_text', { label: 'Icon', help: 'One emoji.', gallery_role: 'icon' }),
    field('short_text', { label: 'Tagline', help: 'One sentence.', gallery_role: 'tagline' }),
    field('long_text', { label: 'Summary', required: true, gallery_role: 'summary' }),
    field('short_text', {
      label: 'Cover image URL',
      help: 'An https:// link to an image.',
      gallery_role: 'cover',
    }),
    field('roster_select', {
      label: 'Team members',
      required: true,
      multiple: true,
      gallery_role: 'team',
    }),
    field('short_text', { label: 'Tags', help: 'Comma separated.', gallery_role: 'tags' }),
    field('short_text', { label: 'Deployed URL', gallery_role: 'link' }),
    field('short_text', { label: 'Demo video', gallery_role: 'link' }),
    field('short_text', { label: 'GitHub frontend', gallery_role: 'link' }),
    field('short_text', { label: 'GitHub backend', gallery_role: 'link' }),
    field('short_text', { label: 'Figma', gallery_role: 'link' }),
    field('short_text', {
      label: 'Demo credentials',
      help: 'Shown publicly on the project page. Use a throwaway demo account.',
    }),
    field('long_text', { label: 'What is the problem?', gallery_role: 'detail' }),
    field('long_text', { label: 'Our solution', gallery_role: 'detail' }),
  ],
};

export const FORM_PRESETS: FormPreset[] = [
  BLANK,
  WAITLIST,
  PLANNING_SURVEY,
  TEAM_REVIEW,
  PROJECT_SHOWCASE,
];

export const presetByKey = (key: string): FormPreset =>
  FORM_PRESETS.find(preset => preset.key === key) ?? BLANK;
