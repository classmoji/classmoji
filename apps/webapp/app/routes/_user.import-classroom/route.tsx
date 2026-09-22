import { redirect, useNavigate } from 'react-router';
import { useState, useEffect } from 'react';
import { Card, Steps, Button, Alert } from 'antd';

import { getAuthSession } from '@classmoji/auth/server';
import { useGlobalFetcher } from '~/hooks';
import { ActionTypes } from '~/constants';

import StepUpload from './StepUpload';
import StepSelectClassrooms from './StepSelectClassrooms';
import StepReview from './StepReview';
import { parseExportBundle, slugify, type ParsedBundle } from './utils';
import type { Route } from './+types/route';

const STEPS = [{ title: 'Upload' }, { title: 'Select' }, { title: 'Review' }];

export const loader = async ({ request }: Route.LoaderArgs) => {
  const authData = await getAuthSession(request);
  if (!authData) return redirect('/');
  return null;
};

interface ImportActionData {
  error?: string;
  success?: string;
  classroomSlug?: string;
  results?: { classroomSlug: string }[];
  errors?: { classroomName: string; message: string }[];
}

const ImportClassroom = () => {
  const navigate = useNavigate();
  const { fetcher, notify } = useGlobalFetcher();

  const [currentStep, setCurrentStep] = useState(0);
  const [bundle, setBundle] = useState<ParsedBundle | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [slugByClassroom, setSlugByClassroom] = useState<Map<number, string>>(new Map());

  const data = fetcher!.data as ImportActionData | undefined;
  const submitting = fetcher!.state === 'submitting';

  const handleFile = async (file: File) => {
    setParsing(true);
    setParseError(null);
    setFileName(file.name);
    try {
      const parsed = await parseExportBundle(file);
      if (!parsed.classrooms.length) {
        setParseError('No classrooms were found in that export.');
        return;
      }
      setBundle(parsed);
      setSelectedIds(new Set(parsed.classrooms.map(c => c.githubId)));
      setSlugByClassroom(new Map(parsed.classrooms.map(c => [c.githubId, slugify(c.name)])));
      setCurrentStep(1);
    } catch (e) {
      setParseError(e instanceof Error ? e.message : 'Failed to read the export.');
    } finally {
      setParsing(false);
    }
  };

  const selectedClassrooms = (bundle?.classrooms ?? []).filter(c => selectedIds.has(c.githubId));

  const handleImport = () => {
    const payload = selectedClassrooms.map(c => ({
      classroom: c,
      slug: slugByClassroom.get(c.githubId) || slugify(c.name),
    }));
    notify(ActionTypes.IMPORT_CLASSROOM, 'Importing classrooms…');
    // Cast for the JSON submit: our deeply-nested typed payload isn't structurally
    // a React Router `JsonValue` (no index signature), but it serializes cleanly.
    const submitTarget = { classrooms: payload } as unknown as Parameters<
      NonNullable<typeof fetcher>['submit']
    >[0];
    fetcher!.submit(submitTarget, {
      method: 'post',
      action: '/import-classroom',
      encType: 'application/json',
    });
  };

  // Navigate on success: single import → its dashboard, multiple → landing.
  useEffect(() => {
    if (!data) return;
    if (data.classroomSlug) {
      navigate(`/admin/${data.classroomSlug}/dashboard`);
    } else if (data.results && data.results.length > 0) {
      navigate('/');
    }
  }, [data, navigate]);

  return (
    <div className="max-w-4xl mx-auto">
      <h1 className="text-xl font-semibold mb-6 dark:text-gray-100">
        Import from GitHub Classroom
      </h1>

      <Card>
        <Steps current={currentStep} items={STEPS} size="small" style={{ marginBottom: 24 }} />

        {currentStep === 0 && (
          <StepUpload
            onFile={handleFile}
            parsing={parsing}
            parseError={parseError}
            fileName={fileName}
          />
        )}

        {currentStep === 1 && bundle && (
          <StepSelectClassrooms
            classrooms={bundle.classrooms}
            selectedIds={selectedIds}
            onSelectionChange={setSelectedIds}
          />
        )}

        {currentStep === 2 && (
          <StepReview
            classrooms={selectedClassrooms}
            slugByClassroom={slugByClassroom}
            onSlugChange={(id, slug) => setSlugByClassroom(prev => new Map(prev).set(id, slug))}
            bundleWarnings={bundle?.warnings ?? []}
          />
        )}

        {data?.error && <Alert className="mt-4" type="error" showIcon message={data.error} />}

        <div className="flex justify-between mt-8">
          <div>
            {currentStep > 0 && (
              <Button onClick={() => setCurrentStep(s => s - 1)} disabled={submitting}>
                Previous
              </Button>
            )}
          </div>
          <div className="flex gap-3">
            <Button onClick={() => navigate('/')} disabled={submitting}>
              Cancel
            </Button>
            {currentStep === 0 && (
              <Button type="primary" disabled={!bundle} onClick={() => setCurrentStep(1)}>
                Next
              </Button>
            )}
            {currentStep === 1 && (
              <Button
                type="primary"
                disabled={selectedIds.size === 0}
                onClick={() => setCurrentStep(2)}
              >
                Next
              </Button>
            )}
            {currentStep === 2 && (
              <Button
                type="primary"
                loading={submitting}
                disabled={selectedClassrooms.length === 0}
                onClick={handleImport}
              >
                Import {selectedClassrooms.length} classroom
                {selectedClassrooms.length === 1 ? '' : 's'}
              </Button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
};

export { action } from './action';

export default ImportClassroom;
