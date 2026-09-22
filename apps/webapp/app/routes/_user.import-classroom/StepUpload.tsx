import { Upload, Alert, Spin } from 'antd';
import { IconCloudUpload } from '@tabler/icons-react';

const IMPORT_DOCS_URL = 'https://classmoji.io/docs/instructors/import-github-classroom';

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
        If you exported your GitHub Classroom data while the Classroom export utility was still
        available, zip that export folder and upload it here. GitHub has since retired the export
        tooling, so this only works with an export you already have.{' '}
        <a
          href={IMPORT_DOCS_URL}
          target="_blank"
          rel="noreferrer"
          className="text-blue-600 dark:text-blue-400 underline underline-offset-2"
        >
          What the export should contain
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
