import { useState } from 'react';
import { Form, Input, Alert } from 'antd';
import { useDropzone } from 'react-dropzone';
import {
  FileTextOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  LoadingOutlined,
  FileZipOutlined,
} from '@ant-design/icons';
import type { FormInstance } from 'antd';
import {
  extractZipContents,
  extractImageReferencesClient,
  extractTitleFromMarkdown,
} from './utils';
import type { ImageReference } from './utils';

interface ImportTabProps {
  form: FormInstance;
  onFilesChange: (files: { markdown: File | null; images: File[] }) => void;
}

export default function ImportTab({ form, onFilesChange }: ImportTabProps) {
  const [markdownFile, setMarkdownFile] = useState<File | null>(null);
  const [imageFiles, setImageFiles] = useState<File[]>([]);
  const [imageReferences, setImageReferences] = useState<ImageReference[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [sourceType, setSourceType] = useState<'zip' | 'markdown' | null>(null);

  const isValidFile = (file: File) => {
    const name = file.name.toLowerCase();
    return (
      name.endsWith('.zip') || name.endsWith('.md') || /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(name)
    );
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: async droppedFiles => {
      const acceptedFiles = droppedFiles.filter(isValidFile);

      if (acceptedFiles.length === 0) {
        if (droppedFiles.length > 0) {
          setExtractError('Please drop a .zip, .md, or image file (.png, .jpg, .gif, .svg, .webp)');
        }
        return;
      }

      setExtractError(null);

      const zipFile = acceptedFiles.find(f => f.name.toLowerCase().endsWith('.zip'));
      const mdFile = acceptedFiles.find(f => f.name.toLowerCase().endsWith('.md'));
      const droppedImages = acceptedFiles.filter(f =>
        /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(f.name)
      );

      if (zipFile) {
        setIsExtracting(true);
        setSourceType('zip');
        try {
          const {
            markdownContent: content,
            markdownFileName,
            imageFiles: extractedImages,
          } = await extractZipContents(zipFile);

          const mdBlob = new Blob([content], { type: 'text/markdown' });
          const newMdFile = new File([mdBlob], markdownFileName ?? 'content.md', {
            type: 'text/markdown',
          });

          setMarkdownFile(newMdFile);
          setImageReferences(extractImageReferencesClient(content));
          setImageFiles(extractedImages);

          // Notify parent of file changes
          onFilesChange({ markdown: newMdFile, images: extractedImages });

          // Auto-fill title from H1
          const extractedTitle = extractTitleFromMarkdown(content);
          if (extractedTitle) {
            form.setFieldsValue({ title: extractedTitle });
          }
        } catch (err: unknown) {
          setExtractError(err instanceof Error ? err.message : String(err));
          setMarkdownFile(null);
          setImageFiles([]);
        } finally {
          setIsExtracting(false);
        }
      } else if (mdFile) {
        setSourceType('markdown');
        setMarkdownFile(mdFile);
        const text = await mdFile.text();
        setImageReferences(extractImageReferencesClient(text));
        setImageFiles(droppedImages);

        // Notify parent of file changes
        onFilesChange({ markdown: mdFile, images: droppedImages });

        // Auto-fill title from H1
        const extractedTitle = extractTitleFromMarkdown(text);
        if (extractedTitle) {
          form.setFieldsValue({ title: extractedTitle });
        }
      } else if (droppedImages.length > 0 && markdownFile) {
        setImageFiles(prev => {
          const existingNames = new Set(prev.map(f => f.name.toLowerCase()));
          const newImages = droppedImages.filter(f => !existingNames.has(f.name.toLowerCase()));
          const updatedImages = [...prev, ...newImages];

          // Notify parent of updated images
          onFilesChange({ markdown: markdownFile, images: updatedImages });

          return updatedImages;
        });
      } else if (droppedImages.length > 0) {
        setExtractError('Please drop a markdown file (.md) first, or drop it together with images');
      }
    },
  });

  const matchedImages = imageFiles.filter(file =>
    imageReferences.some(ref => ref.filename === file.name.toLowerCase())
  );

  const unmatchedImages = imageFiles.filter(
    file => !imageReferences.some(ref => ref.filename === file.name.toLowerCase())
  );

  const missingImages = imageReferences.filter(
    ref => !imageFiles.some(file => file.name.toLowerCase() === ref.filename)
  );

  const removeImage = (index: number) => {
    setImageFiles(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <div className="space-y-4">
      {/* File Upload Area */}
      <div>
        <div
          {...getRootProps()}
          className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
            isDragActive
              ? 'border-blue-500 bg-sky-bg'
              : markdownFile
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
              <p className="text-sky-ink font-medium">Extracting ZIP file...</p>
            </div>
          ) : markdownFile ? (
            <div className="flex flex-col items-center gap-2">
              {sourceType === 'zip' ? (
                <FileZipOutlined className="text-3xl text-mint-ink" />
              ) : (
                <FileTextOutlined className="text-3xl text-mint-ink" />
              )}
              <div className="flex items-center gap-2">
                <span className="text-mint-ink font-medium">{markdownFile.name}</span>
                <CheckCircleOutlined className="text-mint-ink" />
              </div>
              {imageFiles.length > 0 && (
                <p className="text-sm text-mint-ink">
                  + {imageFiles.length} image{imageFiles.length !== 1 ? 's' : ''}
                </p>
              )}
              <p className="text-xs text-ink-2 mt-2">
                Drop images to add, or another file to replace
              </p>
            </div>
          ) : extractError ? (
            <div className="flex flex-col items-center gap-2">
              <WarningOutlined className="text-3xl text-rose-ink" />
              <p className="text-rose-ink font-medium">{extractError}</p>
              <p className="text-sm text-ink-2">Try again with a valid file</p>
            </div>
          ) : (
            <div>
              <div className="flex justify-center gap-4 mb-3">
                <FileZipOutlined className="text-3xl text-ink-3" />
                <FileTextOutlined className="text-3xl text-ink-3" />
              </div>
              <p className="text-ink-2 font-medium">
                {isDragActive ? 'Drop files here' : 'Drop a ZIP, markdown, or markdown + images'}
              </p>
              <p className="text-sm text-ink-2 mt-1">
                ZIP files will auto-extract markdown and images
              </p>
              <p className="text-xs text-ink-3 mt-2">.zip, .md, .png, .jpg, .gif, .svg, .webp</p>
            </div>
          )}
        </div>
      </div>

      {/* Display images */}
      {imageFiles.length > 0 && (
        <div className="space-y-2">
          <label className="block text-sm font-medium">Images ({imageFiles.length})</label>

          {matchedImages.length > 0 && (
            <div>
              <p className="text-xs font-medium text-mint-ink mb-1">
                Matched ({matchedImages.length})
              </p>
              {matchedImages.map((file, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between px-3 py-2 bg-mint-bg rounded-sm text-sm mb-1"
                >
                  <div className="flex items-center gap-2">
                    <CheckCircleOutlined className="text-mint-ink" />
                    <span className="text-mint-ink">{file.name}</span>
                  </div>
                  <button
                    onClick={() => removeImage(imageFiles.indexOf(file))}
                    className="text-ink-2 hover:text-rose-ink"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {unmatchedImages.length > 0 && (
            <div>
              <p className="text-xs font-medium text-amber-ink mb-1">
                Not referenced ({unmatchedImages.length})
              </p>
              {unmatchedImages.map((file, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between px-3 py-2 bg-amber-bg rounded-sm text-sm mb-1"
                >
                  <div className="flex items-center gap-2">
                    <WarningOutlined className="text-amber-ink" />
                    <span className="text-amber-ink">{file.name}</span>
                    <span className="text-xs text-amber-ink">(will still upload)</span>
                  </div>
                  <button
                    onClick={() => removeImage(imageFiles.indexOf(file))}
                    className="text-ink-2 hover:text-rose-ink"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Missing images warning */}
      {missingImages.length > 0 && markdownFile && (
        <Alert
          message="Missing Images"
          description={
            <div>
              <p className="mb-1">The following images are referenced but not found:</p>
              <ul className="list-disc pl-5">
                {missingImages.map((img, idx) => (
                  <li key={idx} className="text-sm">
                    {img.filename}
                  </li>
                ))}
              </ul>
            </div>
          }
          type="warning"
          showIcon
        />
      )}

      {/* Form fields */}
      <Form.Item
        label="Title"
        name="title"
        rules={[{ required: true, message: 'Please enter a title' }]}
      >
        <Input placeholder="Course Overview" />
      </Form.Item>

      {/* Hidden inputs for file data */}
      <input type="hidden" name="intent" value="import" />
    </div>
  );
}
