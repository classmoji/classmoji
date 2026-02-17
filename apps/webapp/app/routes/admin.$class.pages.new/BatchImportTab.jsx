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

export default function BatchImportTab({ term, onPagesChange }) {
  const [pages, setPages] = useState([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractError, setExtractError] = useState(null);

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

      const newPages = [];

      for (const zipFile of zipFiles) {
        try {
          const { markdownContent, markdownFileName, imageFiles } =
            await extractZipContents(zipFile);

          const title =
            extractTitleFromMarkdown(markdownContent) || markdownFileName.replace('.md', '');

          newPages.push({
            id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            zipFileName: zipFile.name,
            title,
            markdownContent,
            imageFiles,
          });
        } catch (err) {
          console.error(`Failed to extract ${zipFile.name}:`, err);
          setExtractError(`Failed to extract ${zipFile.name}: ${err.message}`);
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

  const updatePage = (id, field, value) => {
    setPages(prev => {
      const updated = prev.map(p => {
        if (p.id !== id) return p;
        return { ...p, [field]: value };
      });
      onPagesChange(updated);
      return updated;
    });
  };

  const removePage = id => {
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
      render: (text, record) => (
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
      render: (_, record) => (
        <button
          onClick={() => removePage(record.id)}
          className="text-gray-400 hover:text-red-500 transition-colors"
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
            ? 'border-blue-500 bg-blue-50'
            : pages.length > 0
              ? 'border-green-500 bg-green-50'
              : extractError
                ? 'border-red-500 bg-red-50'
                : 'border-gray-300 hover:border-gray-400'
        }`}
      >
        <input {...getInputProps()} />
        {isExtracting ? (
          <div className="flex flex-col items-center gap-2">
            <LoadingOutlined className="text-3xl text-blue-600" />
            <p className="text-blue-700 font-medium">Extracting ZIP files...</p>
          </div>
        ) : pages.length > 0 ? (
          <div className="flex flex-col items-center gap-2">
            <CheckCircleOutlined className="text-3xl text-green-600" />
            <p className="text-green-700 font-medium">
              {pages.length} page{pages.length !== 1 ? 's' : ''} ready to import
            </p>
            <p className="text-xs text-gray-500">Drop more ZIP files to add</p>
          </div>
        ) : (
          <div>
            <FileZipOutlined className="text-4xl text-gray-400 mb-3" />
            <p className="text-gray-600 font-medium">
              {isDragActive ? 'Drop ZIP files here' : 'Drop ZIP files here (multiple allowed)'}
            </p>
            <p className="text-sm text-gray-500 mt-1">
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
            <h4 className="text-sm font-medium text-gray-700">Detected Pages ({pages.length})</h4>
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
