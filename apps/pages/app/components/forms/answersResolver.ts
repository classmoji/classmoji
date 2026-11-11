import type { FieldValues, Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';
import type { FormField } from '@classmoji/services/form-contract';
import { coerceAnswers, friendlyErrorMap } from './answerCoerce.ts';

/**
 * The form renderer's resolver: coerce, then hand to zodResolver. The order
 * matters: the contract's schemas describe stored shapes (a number is a
 * number), and every DOM input produces a string.
 *
 * `friendlyErrorMap` turns the contract's developer-facing messages into ones
 * a person filling in a waitlist can act on — applied at the point each issue
 * is raised rather than in a post-pass, so nested paths (a matrix row, a
 * repeat group's inner field) get it too. zodResolver passes these options to
 * the schema's `parseAsync`.
 */
export function answersResolver<Values extends FieldValues & { answers?: unknown }>(
  schema: z.ZodType<unknown, FieldValues>,
  fields: FormField[]
): Resolver<Values> {
  const zod = zodResolver(schema, { error: friendlyErrorMap }) as unknown as Resolver<Values>;
  return async (values, context, options) => {
    const coerced = {
      ...values,
      answers: coerceAnswers(fields, (values.answers ?? {}) as Record<string, unknown>),
    } as Values;
    return zod(coerced, context, options);
  };
}
