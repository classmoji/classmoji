/**
 * A tool's input schema as the MCP server registers it.
 *
 * The SDK takes any Standard Schema that also publishes a JSON Schema. A
 * tool's arguments are the zod object `z.object(shape)`; `toolInputSchema`
 * puts a Standard Schema of our own in front of it that
 *
 * - validates with zod and reports a bounded set of issues
 *   (`boundedValidate`, boundedIssues.ts), and
 * - publishes zod's JSON Schema built once per tool and target, not once per
 *   tools/list (the SDK converts on every listing, and a server is built per
 *   request), with zod's own pattern for a string format left out
 *   (`withoutZodFormatPatterns`). The result is frozen and shared by every
 *   request.
 *
 * The pattern rule: zod writes the regular expression it checks a format
 * with next to the format (`format: "uuid"` and a 76-character pattern, and
 * longer ones for emails and dates). The format already says it, so the
 * pattern is dropped, but only when it is exactly zod's own for that format.
 * A pattern a schema sets itself (`.regex()`: submission ids, block ids, a
 * file's rev, team-set rule ids) is always kept.
 */

import type { StandardSchemaV1, StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { boundedValidate } from './boundedIssues.ts';

type JsonSchemaOptions = { readonly target: string; readonly libraryOptions?: unknown };
type JsonObject = Record<string, unknown>;

const JSON_SCHEMA_TARGET = 'draft-2020-12';

function emittedPattern(schema: z.ZodType): string | undefined {
  const json = z.toJSONSchema(schema, { target: JSON_SCHEMA_TARGET, io: 'input' });
  return typeof json.pattern === 'string' ? json.pattern : undefined;
}

/** zod's date-time formats: local or not, with an offset or not, any precision. */
function dateTimeReferences(): z.ZodType[] {
  const precisions = [undefined, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  return [false, true].flatMap(local =>
    [false, true].flatMap(offset =>
      precisions.map(precision => z.iso.datetime({ local, offset, precision }))
    )
  );
}

let formatPatterns: ReadonlyMap<string, ReadonlySet<string>> | undefined;

/**
 * Every pattern the installed zod writes next to a string format, by format:
 * read from zod itself, so a zod update that changes one is followed.
 */
export function zodFormatPatterns(): ReadonlyMap<string, ReadonlySet<string>> {
  if (!formatPatterns) {
    const references: Record<string, z.ZodType[]> = {
      uuid: [z.guid(), z.uuid(), z.uuidv4(), z.uuidv6(), z.uuidv7()],
      email: [z.email()],
      date: [z.iso.date()],
      'date-time': dateTimeReferences(),
    };
    formatPatterns = new Map(
      Object.entries(references).map(([format, schemas]) => [
        format,
        new Set(schemas.map(emittedPattern).filter((p): p is string => p !== undefined)),
      ])
    );
  }
  return formatPatterns;
}

/**
 * `json` without zod's own pattern beside any string format (in place).
 * Every other keyword, and every pattern zod did not write for the format,
 * stays.
 */
export function withoutZodFormatPatterns<T>(json: T): T {
  const patterns = zodFormatPatterns();
  const stack: unknown[] = [json];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    const object = node as JsonObject;
    if (
      typeof object.format === 'string' &&
      typeof object.pattern === 'string' &&
      patterns.get(object.format)?.has(object.pattern)
    ) {
      delete object.pattern;
    }
    stack.push(...Object.values(object));
  }
  return json;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** A JSON Schema converter that builds each (io, target) once. */
function cachedConverter(
  convert: StandardSchemaWithJSON['~standard']['jsonSchema']
): StandardSchemaWithJSON['~standard']['jsonSchema'] {
  const built = new Map<string, JsonObject>();
  const once = (io: 'input' | 'output') => (options: JsonSchemaOptions) => {
    const key = `${io} ${options.target} ${JSON.stringify(options.libraryOptions ?? null)}`;
    let json = built.get(key);
    if (!json) {
      json = deepFreeze(withoutZodFormatPatterns(convert[io](options as never)));
      built.set(key, json);
    }
    return json;
  };
  return { input: once('input'), output: once('output') };
}

export type ToolInputSchema = StandardSchemaWithJSON<Record<string, unknown>>;

/** The schema a tool with these arguments is registered with (see above). */
export function toolInputSchema(shape: Record<string, z.ZodType>): ToolInputSchema {
  const object = z.object(shape);
  const standard = object['~standard'];
  return {
    '~standard': {
      version: 1,
      vendor: 'classmoji',
      validate: boundedValidate(
        standard.validate as StandardSchemaV1.Props<unknown, Record<string, unknown>>['validate']
      ),
      jsonSchema: cachedConverter(standard.jsonSchema),
    },
  };
}
