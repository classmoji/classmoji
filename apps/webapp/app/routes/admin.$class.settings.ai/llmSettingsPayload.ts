/**
 * The saveLLMSettings request the AI settings form sends.
 *
 * Without a classroom key the model and effort selects are disabled and show
 * the platform defaults, not what is stored, so their values are not sent: the
 * action leaves a field it is not sent alone, and the stored values survive for
 * when a key is added. Sending them would null every stored choice whenever a
 * keyless classroom saved a key.
 *
 * With a key, a cleared Select is undefined, which JSON.stringify drops, so the
 * server would never see the clear. It is sent as null, which puts the column
 * back to the platform default.
 */
export function buildLLMSettingsPayload(
  values: Record<string, unknown>,
  fields: readonly string[],
  hasAnthropicKey: boolean
): Record<string, string | null> {
  const payload: Record<string, string | null> = {
    _action: 'saveLLMSettings',
    anthropic_api_key: (values.anthropic_api_key as string) || '',
  };
  if (hasAnthropicKey) {
    for (const field of fields) {
      payload[field] = (values[field] as string) || null;
    }
  }
  return payload;
}
