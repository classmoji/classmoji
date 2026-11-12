import { z } from 'zod';
import dayjs from 'dayjs';

// Custom schema for validating and transforming dates to dayjs instances
const dayjsSchema = z
  .union([z.string(), z.date(), z.any()])
  .nullable()
  .transform(value => {
    if (value === null || value === undefined) return null;
    if (dayjs.isDayjs(value)) return value;
    const parsed = dayjs(value);
    return parsed.isValid() ? parsed : null;
  })
  .refine(value => value === null || dayjs.isDayjs(value), {
    message: 'Invalid date format. Must be a valid date.',
  });

/**
 * Required text: a missing value is refused in the same words as an empty
 * one. Not `.default('')`, which zod 4 no longer checks against `.min(1)`.
 * The form leaves these fields unset (an empty string would hide the
 * template picker's placeholder).
 */
const requiredText = (message: string) =>
  z.preprocess(value => value ?? '', z.string().min(1, { message }));

/** What a new repository form starts with: title and template left unset. */
export const newRepositoryFormValues = (organization: string | undefined) => ({
  organization,
  type: 'INDIVIDUAL',
  description: '',
  team_formation_mode: 'INSTRUCTOR',
  team_formation_deadline: null,
  max_team_size: null,
  project_template_id: null,
  project_template_title: null,
});

/** The form schema; the template message names the provider's word for a repo. */
export const makeSchema = (templateMessage = 'A template repository must be selected.') =>
  z
    .object({
      id: z.string().min(1).optional(),
      title: requiredText('Assignment must have a title.'),
      type: z.enum(['INDIVIDUAL', 'GROUP']).default('INDIVIDUAL'),
      tag: z.string().nullable().optional(), // Initially optional
      template: requiredText(templateMessage),
      organization: z.string().min(1),
      description: z.string().nullable().optional(),
      team_formation_mode: z.enum(['INSTRUCTOR', 'SELF_FORMED']).nullable().optional(),
      team_formation_deadline: dayjsSchema,
      max_team_size: z.number().int().positive().nullable().optional(),
      project_template_id: z.string().nullable().optional(),
      project_template_title: z.string().nullable().optional(),
    })
    .superRefine((data, ctx) => {
      // Tag is required for INSTRUCTOR mode (existing behavior)
      if (data.type === 'GROUP' && data.team_formation_mode === 'INSTRUCTOR' && !data.tag) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tag'],
          message: 'Tag is required for instructor-assigned teams.',
        });
      }
    });

export const schema = makeSchema();
