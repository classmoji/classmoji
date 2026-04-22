import { useState } from 'react';
import { Table, Input, Alert } from 'antd';
import { useDropzone } from 'react-dropzone';
import {
  FileZipOutlined,
  LoadingOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import { extractZipContents, extractTitleFromMarkdown } from './utils';

interface ImportedPage {
  id: string;
  zipFileName: string;
  title: string;
  markdownContent: string;
  imageFiles: File[];
}

interface BatchImportTabProps {
  term: string;
  onPagesChange: (pages: ImportedPage[]) => void;
}

export default function BatchImportTab({ term, onPagesChange }: BatchImportTabProps) {
  const [pages, setPages] = useState<ImportedPage[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: {
      'application/zip': ['.zip'],
      'application/x-zip-compressed': ['.zip'],
    },
    onDrop: async droppedFiles => {
      const zipFiles = droppedFiles.filter(f => f.name.toLowerCase().endsWith('.zip'));

      if (zipFiles.length === 0) {
        setExtractError('Please drop ZIP files only');
        return;
      }

      setIsExtracting(true);
      setExtractError(null);

      const newPages: ImportedPage[] = [];

      for (const zipFile of zipFiles) {
        try {
          const { markdownContent, markdownFileName, imageFiles } =
            await extractZipContents(zipFile);

          const title =
            extractTitleFromMarkdown(markdownContent) || markdownFileName!.replace('.md', '');

          newPages.push({
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            zipFileName: zipFile.name,
            title,
            markdownContent,
            imageFiles,
          });
        } catch (err: unknown) {
          console.error(`Failed to extract ${zipFile.name}:`, err);
          setExtractError(
            `Failed to extract ${zipFile.name}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      setPages(prev => {
        const updated = [...prev, ...newPages];
        onPagesChange(updated);
        return updated;
      });
      setIsExtracting(false);
    },
  });

  const updatePage = (id: string, field: keyof ImportedPage, value: string) => {
    setPages(prev => {
      const updated = prev.map(p => {
        if (p.id !== id) return p;
        return { ...p, [field]: value };
      });
      onPagesChange(updated);
      return updated;
    });
  };

  const removePage = (id: string) => {
    setPages(prev => {
      const updated = prev.filter(p => p.id !== id);
      onPagesChange(updated);
      return updated;
    });
  };

  const columns = [
    {
      title: 'Title',
      dataIndex: 'title',
      key: 'title',
      render: (text: string, record: ImportedPage) => (
        <Input
          value={text}
          onChange={e => updatePage(record.id, 'title', e.target.value)}
          placeholder="Page title"
          size="small"
        />
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 50,
      render: (_: unknown, record: ImportedPage) => (
        <button
          onClick={() => removePage(record.id)}
          className="text-ink-3 hover:text-red-500 transition-colors"
          title="Remove"
        >
          <DeleteOutlined />
        </button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {/* Dropzone */}
      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
          isDragActive
            ? 'border-blue-500 bg-sky-bg'
            : pages.length > 0
              ? 'border-green-500 bg-mint-bg'
              : extractError
                ? 'border-red-500 bg-rose-bg'
                : 'border-line hover:border-gray-400'
        }`}
      >
        <input {...getInputProps()} />
        {isExtracting ? (
          <div className="flex flex-col items-center gap-2">
            <LoadingOutlined className="text-3xl text-sky-ink" />
            <p className="text-sky-ink font-medium">Extracting ZIP files...</p>
          </div>
        ) : pages.length > 0 ? (
          <div className="flex flex-col items-center gap-2">
            <CheckCircleOutlined className="text-3xl text-mint-ink" />
            <p className="text-mint-ink font-medium">
              {pages.length} page{pages.length !== 1 ? 's' : ''} ready to import
            </p>
            <p className="text-xs text-ink-2">Drop more ZIP files to add</p>
          </div>
        ) : (
          <div>
            <FileZipOutlined className="text-4xl text-ink-3 mb-3" />
            <p className="text-ink-2 font-medium">
              {isDragActive ? 'Drop ZIP files here' : 'Drop ZIP files here (multiple allowed)'}
            </p>
            <p className="text-sm text-ink-2 mt-1">
              Each ZIP should contain at least one markdown file; images are optional.
            </p>
          </div>
        )}
      </div>

      {extractError && (
        <Alert message={extractError} type="error" closable onClose={() => setExtractError(null)} />
      )}

      {/* Pages Table */}
      {pages.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium text-ink-1">Detected Pages ({pages.length})</h4>
          </div>
          <Table
            dataSource={pages}
            columns={columns}
            rowKey="id"
            pagination={false}
            size="small"
            className="border rounded-lg"
          />
        </div>
      )}

      {/* Hidden inputs for form data */}
      <input type="hidden" name="intent" value="batch-import" />
      <input type="hidden" name="term" value={term} />
    </div>
  );
}
