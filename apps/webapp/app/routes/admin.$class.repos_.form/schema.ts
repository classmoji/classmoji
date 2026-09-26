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

/** The form schema; the template message names the provider's word for a repo. */
export const makeSchema = (templateMessage = 'A template repository must be selected.') =>
  z
    .object({
      id: z.string().min(1).optional(),
      title: z.string().min(1, { message: 'Assignment must have a title.' }).default(''),
      type: z.enum(['INDIVIDUAL', 'GROUP']).default('INDIVIDUAL'),
      tag: z.string().nullable().optional(), // Initially optional
      template: z.string().min(1, { message: templateMessage }).default(''),
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
