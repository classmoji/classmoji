/**
 * Fetch available models from Anthropic
 * This module provides functions to get the latest model lists from Anthropic's API
 */

/**
 * Get Anthropic models
 * Fetches available models from Anthropic's API
 * @param {string} apiKey - Anthropic API key (optional, uses env var if not provided)
 * @returns {Promise<Array>} List of model objects with value and label
 */
export async function getAnthropicModels(apiKey = null) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;

  if (!key) {
    console.warn('[modelsList] No Anthropic API key available, returning fallback list');
    return getFallbackAnthropicModels();
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const data = await response.json();


    // Filter and sort Claude models
    const claudeModels = data.data
      .filter(model => model.id.startsWith('claude-'))
      .map(model => {
        // Use display_name from API if available, otherwise format the ID
        const label = model.display_name || formatClaudeModelName(model.id);


        return {
          value: model.id,
          label: label,
          created: model.created_at,
        };
      })
      .sort((a, b) => {
        // Sort by version (3.5 > 3) and then by date
        const aVersion = parseClaudeVersion(a.value);
        const bVersion = parseClaudeVersion(b.value);

        if (aVersion !== bVersion) {
          return bVersion - aVersion; // Higher version first
        }

        return b.created - a.created; // Newer first
      });

    return claudeModels;
  } catch (error) {
    console.error('[modelsList] Error fetching Anthropic models:', error);
    // Return fallback list
    return getFallbackAnthropicModels();
  }
}

/**
 * Parse Claude model version for sorting
 */
function parseClaudeVersion(modelId) {
  const match = modelId.match(/claude-(\d+(?:\.\d+)?)/);
  return match ? parseFloat(match[1]) : 0;
}

/**
 * Format Claude model ID into a readable label
 */
function formatClaudeModelName(modelId) {
  // Manual mapping for known models with marketing names
  // Add new models here as they're released
  const knownModels = {
    // Claude 3.5 generation
    'claude-3-5-sonnet-20241022': 'Claude 3.5 Sonnet (Oct 2024)',
    'claude-3-5-sonnet-20240620': 'Claude 3.5 Sonnet (June 2024)',
    'claude-3-5-haiku-20241022': 'Claude 3.5 Haiku (Oct 2024)',

    // Claude 3 generation
    'claude-3-opus-20240229': 'Claude 3 Opus',
    'claude-3-sonnet-20240229': 'Claude 3 Sonnet',
    'claude-3-haiku-20240307': 'Claude 3 Haiku',

    // Legacy
    'claude-2.1': 'Claude 2.1',
    'claude-2.0': 'Claude 2.0',
  };

  // Check if we have a known model
  if (knownModels[modelId]) {
    return knownModels[modelId];
  }

  // Parse unknown models dynamically
  if (modelId.startsWith('claude-')) {
    const parts = modelId.split('-');
    let version = '';
    let variant = '';
    let dateStr = '';


    // Try to extract date first
    const dateMatch = modelId.match(/(\d{4})(\d{2})(\d{2})$/);
    if (dateMatch) {
      const year = dateMatch[1];
      const month = dateMatch[2];
      const monthNames = [
        'Jan',
        'Feb',
        'Mar',
        'Apr',
        'May',
        'Jun',
        'Jul',
        'Aug',
        'Sep',
        'Oct',
        'Nov',
        'Dec',
      ];
      dateStr = ` (${monthNames[parseInt(month) - 1]} ${year})`;
    }

    // Parse version and variant
    let i = 1; // Start after 'claude'
    const versionParts = [];

    // Collect numeric parts for version (e.g., '3', '5' from 'claude-3-5-sonnet')
    while (i < parts.length && !isNaN(parseInt(parts[i])) && parts[i].length <= 2) {
      versionParts.push(parts[i]);
      i++;
    }

    // Format version (e.g., '3.5')
    if (versionParts.length > 0) {
      version = ' ' + versionParts.join('.');
    }

    // Get variant (opus, sonnet, haiku, etc.)
    if (i < parts.length) {
      const variantWord = parts[i];
      // Check if it's a text variant (not a date)
      if (variantWord && variantWord.length > 0 && !/^\d+$/.test(variantWord)) {
        variant = ' ' + variantWord.charAt(0).toUpperCase() + variantWord.slice(1);
      }
    }

    const result = `Claude${version}${variant}${dateStr}`;

    return result;
  }

  return modelId;
}

/**
 * Fallback Anthropic models list (used if API call fails)
 */
function getFallbackAnthropicModels() {
  return [
    { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (Oct 2024)' },
    { value: 'claude-3-5-haiku-20241022', label: 'Claude 3.5 Haiku (Oct 2024)' },
    { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus' },
    { value: 'claude-3-sonnet-20240229', label: 'Claude 3 Sonnet' },
    { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku' },
  ];
}

/**
 * Get all available models (Anthropic only)
 * @param {Object} options - Options with optional API key
 * @returns {Promise<Object>} Object with anthropic model list
 */
export async function getAllModels(options = {}) {
  const anthropicModels = await getAnthropicModels(options.anthropicApiKey);

  return {
    anthropic: anthropicModels,
  };
}
