/**
 * present_question's model-facing JSON schemas, converted the way the AI SDK
 * converts a tool's input before every model call (`asSchema(inputSchema)
 * .jsonSchema`, in `ai`'s tool preparation). The task passes
 * `QuizQuestionSchema` and `CodeAwareQuizQuestionSchema` to the model as they
 * are, so their snapshots must never change: a changed tool schema invalidates
 * the prompt cache of every attempt in the fleet and changes what the model is
 * told. The sandbox variants are snapshotted beside them, so a change to the
 * sandbox field shows up as a diff of its own. The snapshots are JSON kept
 * as `.snap`, so a formatter never rewrites their bytes.
 */
import { asSchema, type FlexibleSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  CodeAwareQuizQuestionSchema,
  CodeAwareSandboxQuizQuestionSchema,
  QuizQuestionSchema,
  SandboxQuizQuestionSchema,
  SandboxSpecSchema,
} from '../index.ts';

const jsonSchemaOf = async (schema: unknown) =>
  JSON.stringify(await asSchema(schema as FlexibleSchema<unknown>).jsonSchema, null, 2) + '\n';

describe("present_question's JSON schema", () => {
  it.each([
    ['QuizQuestionSchema', QuizQuestionSchema],
    ['CodeAwareQuizQuestionSchema', CodeAwareQuizQuestionSchema],
    ['SandboxQuizQuestionSchema', SandboxQuizQuestionSchema],
    ['CodeAwareSandboxQuizQuestionSchema', CodeAwareSandboxQuizQuestionSchema],
  ])('%s matches its snapshot byte for byte', async (name, schema) => {
    await expect(await jsonSchemaOf(schema)).toMatchFileSnapshot(
      `./__fixtures__/${name}.schema.snap`
    );
  });

  it('adds only the sandbox key to each existing schema', async () => {
    const props = async (schema: unknown) =>
      Object.keys(
        (
          (await asSchema(schema as FlexibleSchema<unknown>).jsonSchema) as {
            properties: Record<string, unknown>;
          }
        ).properties
      );
    expect(await props(SandboxQuizQuestionSchema)).toEqual([
      ...(await props(QuizQuestionSchema)),
      'sandbox',
    ]);
    expect(await props(CodeAwareSandboxQuizQuestionSchema)).toEqual([
      ...(await props(CodeAwareQuizQuestionSchema)),
      'sandbox',
    ]);
  });

  it('gives the sandbox files plain string keys: no key pattern for the model to meet', async () => {
    const schema = (await asSchema(SandboxSpecSchema as FlexibleSchema<unknown>).jsonSchema) as {
      properties: { files: Record<string, unknown> };
    };
    const { description: _description, ...files } = schema.properties.files;
    expect(files).toEqual({ type: 'object', additionalProperties: { type: 'string' } });
    expect(JSON.stringify(schema)).not.toMatch(/propertyNames|"pattern"/);
  });
});
