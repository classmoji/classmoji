import { useState, useCallback, useRef, useEffect } from 'react';
import { Modal, Slider, Button, message, Spin } from 'antd';
import { useDropzone } from 'react-dropzone';
import ReactCrop from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';
import { useImageProcessor } from '~/hooks/useImageProcessor';

/**
 * ImageUploadModal - Upload images with crop and resize options
 *
 * Features:
 * - Drag-and-drop or click to select
 * - Crop with aspect ratio presets
 * - Quality slider for JPEG/WebP compression
 * - Auto-resize to max dimensions
 * - Format-aware processing (GIFs pass through)
 * - Real-time size preview
 */
export default function ImageUploadModal({ open, onClose, onUpload }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [crop, setCrop] = useState(null);
  const [completedCrop, setCompletedCrop] = useState(null);
  const [quality, setQuality] = useState(85);
  const [maxWidth, setMaxWidth] = useState(1920);
  const [processing, setProcessing] = useState(false);
  const [processedInfo, setProcessedInfo] = useState(null);
  const imgRef = useRef(null);

  const { processImage, formatFileSize, getImageDimensions } = useImageProcessor();

  // Reset state when modal closes
  useEffect(() => {
    if (!open) {
      setFile(null);
      setPreview(null);
      setCrop(null);
      setCompletedCrop(null);
      setProcessedInfo(null);
    }
  }, [open]);

  // Create preview URL when file changes
  useEffect(() => {
    if (file) {
      const url = URL.createObjectURL(file);
      setPreview(url);
      return () => URL.revokeObjectURL(url);
    }
  }, [file]);

  // Handle file drop
  const onDrop = useCallback(async (acceptedFiles) => {
    const selectedFile = acceptedFiles[0];
    if (!selectedFile) return;

    // Validate file type
    if (!selectedFile.type.startsWith('image/')) {
      message.error('Please select an image file');
      return;
    }

    // Check file size (max 100MB for Git Blobs API)
    const MAX_SIZE = 100 * 1024 * 1024;
    if (selectedFile.size > MAX_SIZE) {
      message.error('File too large. Maximum size is 100MB');
      return;
    }

    setFile(selectedFile);
    setCrop(null);
    setCompletedCrop(null);

    // Get and display dimensions
    try {
      const dims = await getImageDimensions(selectedFile);
      setProcessedInfo({
        originalSize: selectedFile.size,
        dimensions: dims,
        isGif: selectedFile.type === 'image/gif',
      });
    } catch (err) {
      console.error('Failed to get image dimensions:', err);
    }
  }, [getImageDimensions]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp'],
    },
    maxFiles: 1,
  });

  // Process and upload
  const handleUpload = useCallback(async () => {
    if (!file) return;

    setProcessing(true);
    try {
      // Get displayed image dimensions for proper crop scaling
      // The crop coordinates are relative to the displayed size, not natural size
      const displayedWidth = imgRef.current?.width || undefined;
      const displayedHeight = imgRef.current?.height || undefined;

      // Process the image (resize, crop, compress)
      const result = await processImage(file, {
        crop: completedCrop,
        displayedWidth,
        displayedHeight,
        maxWidth,
        maxHeight: Math.round(maxWidth * 0.75), // Maintain roughly 4:3 aspect
        quality: quality / 100,
      });

      // Update processed info
      setProcessedInfo((prev) => ({
        ...prev,
        newSize: result.newSize,
        wasProcessed: result.wasProcessed,
      }));

      // Create a File object from the blob
      const processedFile = new File(
        [result.blob],
        file.name.replace(/\.[^.]+$/, `.${result.format}`),
        { type: `image/${result.format}` }
      );

      // Call parent upload handler
      await onUpload(processedFile);
      message.success('Image uploaded successfully');
      onClose();
    } catch (err) {
      console.error('Upload failed:', err);
      message.error(`Upload failed: ${err.message}`);
    } finally {
      setProcessing(false);
    }
  }, [file, completedCrop, maxWidth, quality, processImage, onUpload, onClose]);

  // Aspect ratio presets
  const aspectPresets = [
    { label: 'Free', value: undefined },
    { label: '16:9', value: 16 / 9 },
    { label: '4:3', value: 4 / 3 },
    { label: '1:1', value: 1 },
    { label: '3:2', value: 3 / 2 },
  ];

  const [selectedAspect, setSelectedAspect] = useState(undefined);

  const isGif = file?.type === 'image/gif';

  return (
    <Modal
      title="Upload Image"
      open={open}
      onCancel={onClose}
      width={800}
      footer={[
        <Button key="cancel" onClick={onClose}>
          Cancel
        </Button>,
        <Button
          key="upload"
          type="primary"
          onClick={handleUpload}
          disabled={!file || processing}
          loading={processing}
        >
          {processing ? 'Processing...' : 'Upload'}
        </Button>,
      ]}
    >
      <div className="space-y-4">
        {/* Dropzone - show when no file selected */}
        {!file && (
          <div
            {...getRootProps()}
            className={`
              border-2 border-dashed rounded-lg p-8 text-center cursor-pointer
              transition-colors
              ${isDragActive
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
              }
            `}
          >
            <input {...getInputProps()} />
            <div className="space-y-2">
              <svg
                className="mx-auto h-12 w-12 text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
              <p className="text-gray-600 dark:text-gray-300">
                {isDragActive
                  ? 'Drop the image here...'
                  : 'Drag & drop an image, or click to select'}
              </p>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                PNG, JPG, GIF, WebP (max 100MB)
              </p>
            </div>
          </div>
        )}

        {/* Image preview with crop */}
        {file && preview && (
          <div className="space-y-4">
            {/* File info */}
            <div className="flex items-center justify-between text-sm">
              <span className="font-medium text-gray-700 dark:text-gray-300">
                {file.name}
              </span>
              <div className="flex items-center gap-4 text-gray-500 dark:text-gray-400">
                {processedInfo?.dimensions && (
                  <span>
                    {processedInfo.dimensions.width} × {processedInfo.dimensions.height}
                  </span>
                )}
                <span>{formatFileSize(file.size)}</span>
                {isGif && (
                  <span className="px-2 py-0.5 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 rounded-sm text-xs">
                    Animated GIF
                  </span>
                )}
              </div>
            </div>

            {/* Crop area */}
            <div className="max-h-96 overflow-auto bg-gray-100 dark:bg-gray-800 rounded-lg p-2">
              {isGif ? (
                // GIFs: Just show preview, no crop (would lose animation)
                <div className="text-center">
                  <img
                    src={preview}
                    alt="Preview"
                    className="max-w-full max-h-80 mx-auto"
                  />
                  <p className="mt-2 text-sm text-amber-600 dark:text-amber-400">
                    GIFs cannot be cropped or resized (would lose animation)
                  </p>
                </div>
              ) : (
                <ReactCrop
                  crop={crop}
                  onChange={(c) => setCrop(c)}
                  onComplete={(c) => setCompletedCrop(c)}
                  aspect={selectedAspect}
                >
                  <img
                    ref={imgRef}
                    src={preview}
                    alt="Crop preview"
                    className="max-w-full max-h-80"
                  />
                </ReactCrop>
              )}
            </div>

            {/* Crop aspect ratio presets (not for GIFs) */}
            {!isGif && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600 dark:text-gray-400">Crop:</span>
                {aspectPresets.map((preset) => (
                  <button
                    key={preset.label}
                    onClick={() => {
                      setSelectedAspect(preset.value);
                      setCrop(null);
                    }}
                    className={`
                      px-2 py-1 text-xs rounded
                      ${selectedAspect === preset.value
                        ? 'bg-blue-500 text-white'
                        : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-600'
                      }
                    `}
                  >
                    {preset.label}
                  </button>
                ))}
                {crop && (
                  <button
                    onClick={() => {
                      setCrop(null);
                      setCompletedCrop(null);
                    }}
                    className="px-2 py-1 text-xs bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded-sm hover:bg-red-200 dark:hover:bg-red-900/50"
                  >
                    Clear
                  </button>
                )}
              </div>
            )}

            {/* Quality and size controls (not for GIFs) */}
            {!isGif && (
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
                    Quality: {quality}%
                  </label>
                  <Slider
                    min={10}
                    max={100}
                    value={quality}
                    onChange={setQuality}
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
                    Max Width: {maxWidth}px
                  </label>
                  <Slider
                    min={320}
                    max={3840}
                    step={160}
                    value={maxWidth}
                    onChange={setMaxWidth}
                  />
                </div>
              </div>
            )}

            {/* Change image button */}
            <div className="flex justify-center">
              <button
                {...getRootProps()}
                className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
              >
                <input {...getInputProps()} />
                Choose a different image
              </button>
            </div>
          </div>
        )}

        {/* Processing indicator */}
        {processing && (
          <div className="flex items-center justify-center gap-2 text-gray-600 dark:text-gray-400">
            <Spin size="small" />
            <span>Processing image...</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
