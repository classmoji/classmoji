import { useState, useEffect } from 'react';
import { Modal, Button, Alert } from 'antd';
import { useDropzone } from 'react-dropzone';
import {
  FileTextOutlined,
  UploadOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  LoadingOutlined,
  FileZipOutlined,
} from '@ant-design/icons';
import JSZip from 'jszip';

/**
 * Extract image references from markdown (client-side)
 */
function extractImageReferencesClient(markdown) {
  const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
  const images = [];
  let match;

  while ((match = imageRegex.exec(markdown)) !== null) {
    images.push({
      alt: match[1],
      path: decodeURIComponent(match[2]),
      filename: decodeURIComponent(match[2]).split('/').pop().toLowerCase(),
    });
  }

  return images;
}

/**
 * Extract contents from a ZIP file (handles nested ZIPs)
 */
async function extractZipContents(file) {
  console.log('[extractZipContents] Loading ZIP...');
  let zip = await JSZip.loadAsync(file);
  let files = Object.values(zip.files);
  console.log('[extractZipContents] ZIP loaded, files:', files.map(f => f.name));

  // Check for nested ZIP files and extract them
  const nestedZips = files.filter(f => !f.dir && f.name.toLowerCase().endsWith('.zip'));
  if (nestedZips.length > 0) {
    console.log('[extractZipContents] Found nested ZIP, extracting:', nestedZips[0].name);
    const nestedZipBlob = await nestedZips[0].async('blob');
    zip = await JSZip.loadAsync(nestedZipBlob);
    files = Object.values(zip.files);
    console.log('[extractZipContents] Nested ZIP loaded, files:', files.map(f => f.name));
  }

  // Find markdown file (first .md or .txt, prefer .md)
  const mdFiles = files.filter(
    f => !f.dir && (f.name.endsWith('.md') || f.name.endsWith('.txt'))
  );
  console.log('[extractZipContents] Markdown files found:', mdFiles.map(f => f.name));

  // Sort to prefer .md over .txt
  mdFiles.sort((a, b) => {
    if (a.name.endsWith('.md') && !b.name.endsWith('.md')) return -1;
    if (!a.name.endsWith('.md') && b.name.endsWith('.md')) return 1;
    return a.name.localeCompare(b.name);
  });
  const markdownEntry = mdFiles[0];

  // Find all image files (recursively, handles subfolders)
  const imageEntries = files.filter(
    f => !f.dir && /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(f.name)
  );
  console.log('[extractZipContents] Image files found:', imageEntries.map(f => f.name));

  if (!markdownEntry) {
    throw new Error('No markdown file (.md or .txt) found in ZIP');
  }

  // Extract markdown content
  console.log('[extractZipContents] Extracting markdown:', markdownEntry.name);
  const markdownContent = await markdownEntry.async('string');
  const markdownFileName = markdownEntry.name.split('/').pop();
  console.log('[extractZipContents] Markdown extracted, length:', markdownContent.length);

  // Extract images as File objects
  console.log('[extractZipContents] Extracting images...');
  const imageFiles = await Promise.all(
    imageEntries.map(async entry => {
      const blob = await entry.async('blob');
      const fileName = entry.name.split('/').pop(); // Use basename only
      return new File([blob], fileName, { type: blob.type || 'image/png' });
    })
  );
  console.log('[extractZipContents] Images extracted:', imageFiles.length);

  return {
    markdownContent,
    markdownFileName,
    imageFiles,
  };
}

export default function ImportMarkdownModal({ open, onCancel, onImport, isImporting }) {
  const [markdownFile, setMarkdownFile] = useState(null);
  const [markdownContent, setMarkdownContent] = useState('');
  const [imageFiles, setImageFiles] = useState([]);
  const [imageReferences, setImageReferences] = useState([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [extractError, setExtractError] = useState(null);
  const [sourceType, setSourceType] = useState(null); // 'zip' or 'markdown'

  // Helper to check file type by extension
  const isValidFile = file => {
    const name = file.name.toLowerCase();
    return (
      name.endsWith('.zip') ||
      name.endsWith('.md') ||
      name.endsWith('.txt') ||
      /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(name)
    );
  };

  // Single unified dropzone - accepts ZIP, markdown, and images
  // We validate by extension in onDrop since MIME types can be unreliable
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: async droppedFiles => {
      // Filter to valid files by extension
      const acceptedFiles = droppedFiles.filter(isValidFile);
      const rejectedFiles = droppedFiles.filter(f => !isValidFile(f));

      console.log('Accepted files:', acceptedFiles.map(f => ({ name: f.name, type: f.type })));
      if (rejectedFiles.length > 0) {
        console.log('Rejected files:', rejectedFiles.map(f => f.name));
      }

      if (acceptedFiles.length === 0) {
        if (droppedFiles.length > 0) {
          setExtractError('Please drop a .zip, .md, .txt, or image file (.png, .jpg, .gif, .svg, .webp)');
        }
        return;
      }

      setExtractError(null);

      // Separate files by type
      const zipFile = acceptedFiles.find(f => f.name.toLowerCase().endsWith('.zip'));
      const mdFile = acceptedFiles.find(
        f => f.name.toLowerCase().endsWith('.md') || f.name.toLowerCase().endsWith('.txt')
      );
      const droppedImages = acceptedFiles.filter(f =>
        /\.(png|jpg|jpeg|gif|svg|webp)$/i.test(f.name)
      );

      console.log('Detected:', { zipFile: zipFile?.name, mdFile: mdFile?.name, imageCount: droppedImages.length });

      if (zipFile) {
        // Handle ZIP file (ignore other files if ZIP is present)
        console.log('Processing ZIP file:', zipFile.name);
        setIsExtracting(true);
        setSourceType('zip');
        try {
          const { markdownContent: content, markdownFileName, imageFiles: extractedImages } =
            await extractZipContents(zipFile);

          console.log('ZIP extracted:', { markdownFileName, imageCount: extractedImages.length });

          // Create a File object for the markdown content
          const mdBlob = new Blob([content], { type: 'text/markdown' });
          const newMdFile = new File([mdBlob], markdownFileName, { type: 'text/markdown' });

          setMarkdownFile(newMdFile);
          setMarkdownContent(content);
          setImageReferences(extractImageReferencesClient(content));
          setImageFiles(extractedImages);
          console.log('State updated successfully');
        } catch (err) {
          console.error('ZIP extraction failed:', err);
          setExtractError(err.message);
          setMarkdownFile(null);
          setMarkdownContent('');
          setImageFiles([]);
        } finally {
          setIsExtracting(false);
        }
      } else if (mdFile) {
        // Handle markdown file (with optional images)
        setSourceType('markdown');
        setMarkdownFile(mdFile);
        const text = await mdFile.text();
        setMarkdownContent(text);
        setImageReferences(extractImageReferencesClient(text));
        // Set images from this drop (replaces previous)
        setImageFiles(droppedImages);
      } else if (droppedImages.length > 0 && markdownFile) {
        // Only images dropped and we already have a markdown file - add them
        setImageFiles(prev => {
          // Avoid duplicates by filename
          const existingNames = new Set(prev.map(f => f.name.toLowerCase()));
          const newImages = droppedImages.filter(
            f => !existingNames.has(f.name.toLowerCase())
          );
          return [...prev, ...newImages];
        });
      } else if (droppedImages.length > 0) {
        // Only images dropped without a markdown file
        setExtractError('Please drop a markdown file (.md or .txt) first, or drop it together with images');
      }
    },
  });

  // Reset state when modal closes
  useEffect(() => {
    if (!open) {
      setMarkdownFile(null);
      setMarkdownContent('');
      setImageFiles([]);
      setImageReferences([]);
      setIsExtracting(false);
      setExtractError(null);
      setSourceType(null);
    }
  }, [open]);

  // Match uploaded images to references
  const matchedImages = imageFiles.filter(file =>
    imageReferences.some(ref => ref.filename === file.name.toLowerCase())
  );

  const unmatchedImages = imageFiles.filter(
    file => !imageReferences.some(ref => ref.filename === file.name.toLowerCase())
  );

  const missingImages = imageReferences.filter(
    ref => !imageFiles.some(file => file.name.toLowerCase() === ref.filename)
  );

  const handleImport = () => {
    if (!markdownFile) return;
    onImport({ markdownFile, imageFiles });
  };

  const removeImage = index => {
    setImageFiles(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <Modal
      title="Import Markdown"
      open={open}
      onCancel={onCancel}
      width={700}
      footer={[
        <Button key="cancel" onClick={onCancel} disabled={isImporting || isExtracting}>
          Cancel
        </Button>,
        <Button
          key="import"
          type="primary"
          onClick={handleImport}
          disabled={!markdownFile || isImporting || isExtracting}
          loading={isImporting}
          icon={<UploadOutlined />}
        >
          {isImporting ? 'Importing...' : 'Import'}
        </Button>,
      ]}
    >
      <div className="space-y-4">
        {/* Unified Dropzone */}
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
                <p className="text-xs text-gray-400 mt-2">.zip, .md, .txt, .png, .jpg, .gif, .svg, .webp</p>
              </div>
            )}
          </div>
        </div>

        {/* Display extracted/uploaded images with status */}
        {imageFiles.length > 0 && (
          <div className="space-y-2">
            <label className="block text-sm font-medium">
              Images ({imageFiles.length})
            </label>

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

        {/* Info message */}
        {markdownFile && !isImporting && (
          <Alert
            message="This will replace the current page content"
            type="info"
            showIcon
          />
        )}

        {/* Import progress */}
        {isImporting && (
          <Alert
            message={
              <div className="flex items-center gap-3">
                <LoadingOutlined className="text-blue-600" />
                <div>
                  <div className="font-medium">Importing markdown...</div>
                  <div className="text-sm text-gray-600 mt-1">
                    Converting markdown, uploading images to GitHub, and updating page
                  </div>
                </div>
              </div>
            }
            type="info"
          />
        )}
      </div>
    </Modal>
  );
}
