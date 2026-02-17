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
import {
  extractZipContents,
  extractImageReferencesClient,
  extractTitleFromMarkdown,
} from './utils';

export default function ImportTab({ form, onFilesChange }) {
  const [markdownFile, setMarkdownFile] = useState(null);
  const [imageFiles, setImageFiles] = useState([]);
  const [imageReferences, setImageReferences] = useState([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractError, setExtractError] = useState(null);
  const [sourceType, setSourceType] = useState(null);

  const isValidFile = file => {
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
          const newMdFile = new File([mdBlob], markdownFileName, { type: 'text/markdown' });

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
        } catch (err) {
          setExtractError(err.message);
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

  const removeImage = index => {
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
              ? 'border-blue-500 bg-blue-50'
              : markdownFile
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
              <p className="text-blue-700 font-medium">Extracting ZIP file...</p>
            </div>
          ) : markdownFile ? (
            <div className="flex flex-col items-center gap-2">
              {sourceType === 'zip' ? (
                <FileZipOutlined className="text-3xl text-green-600" />
              ) : (
                <FileTextOutlined className="text-3xl text-green-600" />
              )}
              <div className="flex items-center gap-2">
                <span className="text-green-700 font-medium">{markdownFile.name}</span>
                <CheckCircleOutlined className="text-green-600" />
              </div>
              {imageFiles.length > 0 && (
                <p className="text-sm text-green-600">
                  + {imageFiles.length} image{imageFiles.length !== 1 ? 's' : ''}
                </p>
              )}
              <p className="text-xs text-gray-500 mt-2">
                Drop images to add, or another file to replace
              </p>
            </div>
          ) : extractError ? (
            <div className="flex flex-col items-center gap-2">
              <WarningOutlined className="text-3xl text-red-600" />
              <p className="text-red-700 font-medium">{extractError}</p>
              <p className="text-sm text-gray-500">Try again with a valid file</p>
            </div>
          ) : (
            <div>
              <div className="flex justify-center gap-4 mb-3">
                <FileZipOutlined className="text-3xl text-gray-400" />
                <FileTextOutlined className="text-3xl text-gray-400" />
              </div>
              <p className="text-gray-600 font-medium">
                {isDragActive ? 'Drop files here' : 'Drop a ZIP, markdown, or markdown + images'}
              </p>
              <p className="text-sm text-gray-500 mt-1">
                ZIP files will auto-extract markdown and images
              </p>
              <p className="text-xs text-gray-400 mt-2">.zip, .md, .png, .jpg, .gif, .svg, .webp</p>
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
              <p className="text-xs font-medium text-green-700 mb-1">
                Matched ({matchedImages.length})
              </p>
              {matchedImages.map((file, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between px-3 py-2 bg-green-50 rounded-sm text-sm mb-1"
                >
                  <div className="flex items-center gap-2">
                    <CheckCircleOutlined className="text-green-600" />
                    <span className="text-green-700">{file.name}</span>
                  </div>
                  <button
                    onClick={() => removeImage(imageFiles.indexOf(file))}
                    className="text-gray-500 hover:text-red-600"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          {unmatchedImages.length > 0 && (
            <div>
              <p className="text-xs font-medium text-yellow-700 mb-1">
                Not referenced ({unmatchedImages.length})
              </p>
              {unmatchedImages.map((file, idx) => (
                <div
                  key={idx}
                  className="flex items-center justify-between px-3 py-2 bg-yellow-50 rounded-sm text-sm mb-1"
                >
                  <div className="flex items-center gap-2">
                    <WarningOutlined className="text-yellow-600" />
                    <span className="text-yellow-700">{file.name}</span>
                    <span className="text-xs text-yellow-600">(will still upload)</span>
                  </div>
                  <button
                    onClick={() => removeImage(imageFiles.indexOf(file))}
                    className="text-gray-500 hover:text-red-600"
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
