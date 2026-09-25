import { Button, Form, Select } from 'antd';
import { useEffect, useState } from 'react';

import { useGlobalFetcher } from '~/hooks';
import { SettingSection } from '~/components';
import { matchOfferedZone, timeZoneOptions } from './timeZoneOptions';

interface TimeZoneSectionProps {
  /** The classroom's stored zone, or null when none is set. */
  current: string | null;
  /** Every zone the server accepts, canonical spellings, UTC first. */
  zones: string[];
}

/**
 * The course time zone: the one zone every server-rendered date uses — the
 * public schedule, Ask Moji and the MCP server's `_local` fields. Member-facing
 * pages still show dates in each reader's own browser zone.
 */
const TimeZoneSection = ({ current, zones }: TimeZoneSectionProps) => {
  const [zone, setZone] = useState<string | null>(current);
  // Read after mount, never during render: the server has no browser zone, so
  // reading it in render would be a hydration mismatch.
  const [browserZone, setBrowserZone] = useState<string | null>(null);
  const { fetcher } = useGlobalFetcher();

  useEffect(() => {
    try {
      setBrowserZone(Intl.DateTimeFormat().resolvedOptions().timeZone || null);
    } catch {
      setBrowserZone(null);
    }
  }, []);

  useEffect(() => setZone(current), [current]);

  const save = () => {
    fetcher!.submit(
      { timezone: zone },
      { action: '?/saveTimeZone', method: 'POST', encType: 'application/json' }
    );
  };

  // The offered option for the browser's zone, in the SERVER's spelling (a
  // browser on Asia/Kolkata matches an Asia/Calcutta option).
  const browserOption = matchOfferedZone(zones, browserZone);
  const browserIsOffered = browserOption !== null && browserOption !== zone;

  return (
    <SettingSection
      title="Time zone"
      description="The course's time zone. Deadlines on the public schedule and in Ask Moji are given in this zone."
    >
      <Form layout="vertical">
        <Form.Item label="Course time zone">
          <Select
            value={zone ?? undefined}
            onChange={value => setZone(value ?? null)}
            options={timeZoneOptions(zones, current)}
            placeholder="Not set"
            showSearch
            allowClear
            optionFilterProp="label"
            aria-label="Course time zone"
            style={{ width: '100%' }}
          />
        </Form.Item>

        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {current
            ? 'Students still see dates in their own browser zone on course pages.'
            : 'Not set: Ask Moji uses each student’s browser time zone, and the public schedule uses UTC.'}
          {browserIsOffered && (
            <button
              type="button"
              className="block mt-2 text-blue-600 hover:underline dark:text-blue-400"
              onClick={() => setZone(browserOption)}
            >
              Use my time zone ({browserOption!.replace(/_/g, ' ')})
            </button>
          )}
        </p>

        <Button type="primary" onClick={save} disabled={zone === current}>
          Save
        </Button>
      </Form>
    </SettingSection>
  );
};

export default TimeZoneSection;
