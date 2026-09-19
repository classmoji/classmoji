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

export const schema = z
  .object({
    id: z.string().min(1).optional(),
    title: z.string().min(1, { message: 'Assignment must have a title.' }).default(''),
    type: z.enum(['INDIVIDUAL', 'GROUP']).default('INDIVIDUAL'),
    tag: z.string().nullable().optional(), // Initially optional
    template: z.string().min(1, { message: 'A template repository must be selected.' }).default(''),
    organization: z.string().min(1),
    // Every repository lives in exactly one module.
    module_id: z.string().min(1, { message: 'Choose a module for this repository.' }),
    description: z.string().nullable().optional(),
    team_formation_mode: z.enum(['INSTRUCTOR', 'SELF_FORMED']).nullable().optional(),
    team_formation_deadline: dayjsSchema,
    max_team_size: z.number().int().positive().nullable().optional(),
    project_template_id: z.string().nullable().optional(),
    project_template_title: z.string().nullable().optional(),
    assignments: z
      .array(
        z.object({
          id: z.union([z.string(), z.number()]).optional(),
          title: z.string().min(1, { message: 'Assignment title must not be empty.' }),
          weight: z.number().min(0, { message: 'Assignment weight cannot be negative.' }),
          is_extra_credit: z.boolean().default(false),
          tokens_per_hour: z.number(),
          description: z.string().nullable(),
          student_deadline: dayjsSchema,
          grader_deadline: dayjsSchema,
          release_at: dayjsSchema,
          linkedPageIds: z.array(z.string()).optional().default([]),
          linkedSlideIds: z.array(z.string()).optional().default([]),
        })
      )
      .default([]),
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
