import { describe, expect, it } from 'vitest';
import { pickSettings } from '../pickSettings';

describe('pickSettings', () => {
  it('keeps only the listed fields', () => {
    expect(
      pickSettings(
        { slides_enabled: true, show_pages: false, anthropic_api_key: 'sk-x', _action: 'x' },
        ['slides_enabled', 'show_pages', 'show_modules']
      )
    ).toEqual({ slides_enabled: true, show_pages: false });
  });

  it('keeps falsy values that were sent', () => {
    expect(
      pickSettings({ default_tokens_per_hour: 0, recent_viewers_enabled: false }, [
        'default_tokens_per_hour',
        'recent_viewers_enabled',
      ])
    ).toEqual({ default_tokens_per_hour: 0, recent_viewers_enabled: false });
  });

  it('leaves out a listed field the body omits or sends as undefined', () => {
    expect(pickSettings({ show_modules: undefined }, ['show_modules', 'show_pages'])).toEqual({});
  });

  it('ignores inherited keys', () => {
    const body = Object.create({ slides_enabled: true }) as Record<string, unknown>;
    expect(pickSettings(body, ['slides_enabled'])).toEqual({});
  });

  it('returns nothing for a body that is not an object', () => {
    expect(pickSettings(null, ['slides_enabled'])).toEqual({});
    expect(pickSettings('slides_enabled', ['slides_enabled'])).toEqual({});
    expect(pickSettings(undefined, ['slides_enabled'])).toEqual({});
  });
});
