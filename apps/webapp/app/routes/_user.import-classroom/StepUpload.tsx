import { Upload, Alert, Spin } from 'antd';
import { IconCloudUpload } from '@tabler/icons-react';

const EXPORT_UTILITY_URL = 'https://github.com/github-education-resources/classroom-export-utility';
const EXPORT_WALKTHROUGH_URL = 'https://classmoji.io/docs/instructors/import-github-classroom';

interface Props {
  onFile: (file: File) => void;
  parsing: boolean;
  parseError: string | null;
  fileName: string | null;
}

/**
 * Step 1 — upload the zipped GitHub Classroom export. Parsing happens in the
 * parent (route) the moment a file is chosen; this step just collects it and
 * surfaces progress / errors.
 */
export default function StepUpload({ onFile, parsing, parseError, fileName }: Props) {
  return (
    <div>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
        Use GitHub&apos;s official{' '}
        <a
          href={EXPORT_UTILITY_URL}
          target="_blank"
          rel="noreferrer"
          className="text-blue-600 dark:text-blue-400 underline underline-offset-2"
          style={{ textDecoration: 'underline' }}
        >
          Classroom export utility
        </a>{' '}
        to download your classrooms, assignments, and rosters as a folder, then zip that folder and
        upload it below. Open the link and follow its instructions.{' '}
        <a
          href={EXPORT_WALKTHROUGH_URL}
          target="_blank"
          rel="noreferrer"
          className="text-blue-600 dark:text-blue-400 underline underline-offset-2"
        >
          Watch the export walkthrough
        </a>
        .
      </p>

      <Upload.Dragger
        accept=".zip"
        multiple={false}
        showUploadList={false}
        beforeUpload={file => {
          onFile(file as unknown as File);
          return Upload.LIST_IGNORE;
        }}
        disabled={parsing}
      >
        <p className="flex justify-center text-gray-400 mb-2">
          {parsing ? <Spin /> : <IconCloudUpload size={36} stroke={1.5} />}
        </p>
        <p className="ant-upload-text">
          {parsing ? 'Reading export…' : 'Click or drag your export .zip here'}
        </p>
        <p className="ant-upload-hint">
          {fileName
            ? `Selected: ${fileName}`
            : 'A single .zip containing the classroom-export folder'}
        </p>
      </Upload.Dragger>

      <p className="mt-3 text-xs text-gray-400 dark:text-gray-500">
        Nothing is sent to GitHub. The export is read entirely in your browser.
      </p>

      {parseError && (
        <Alert
          className="mt-4"
          type="error"
          showIcon
          message="Could not read that file"
          description={parseError}
        />
      )}
    </div>
  );
}
