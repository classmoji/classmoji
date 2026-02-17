import { useState, useCallback, useEffect } from 'react';
import { Input, Switch, Button, message } from 'antd';
import { CloudUploadOutlined, CheckCircleOutlined } from '@ant-design/icons';
import PropertySection, { PropertyRow, PropertyLabel } from '../PropertySection';
import { useElementSelection } from '../ElementSelectionContext';

/**
 * VideoProperties - Property editor for video elements
 *
 * Allows configuring:
 * - URL (src attribute)
 * - Autoplay
 * - Loop
 * - Muted
 * - Show controls
 */

export default function VideoProperties({ element }) {
  const { onContentChange, onSaveContent } = useElementSelection();

  // State for all properties
  const [url, setUrl] = useState(() => element?.src || '');
  const [autoplay, setAutoplay] = useState(() => element?.hasAttribute('autoplay') || element?.hasAttribute('data-autoplay'));
  const [loop, setLoop] = useState(() => element?.hasAttribute('loop'));
  const [muted, setMuted] = useState(() => element?.hasAttribute('muted'));
  const [controls, setControls] = useState(() => element?.hasAttribute('controls'));
  const [uploading, setUploading] = useState(false);

  // Sync state when element changes
  useEffect(() => {
    if (element) {
      setUrl(element.src || '');
      setAutoplay(element.hasAttribute('autoplay') || element.hasAttribute('data-autoplay'));
      setLoop(element.hasAttribute('loop'));
      setMuted(element.hasAttribute('muted'));
      setControls(element.hasAttribute('controls'));
    }
  }, [element]);

  // Update URL
  const handleUrlChange = useCallback((e) => {
    if (!element) return;
    const newUrl = e.target.value;
    element.src = newUrl;
    setUrl(newUrl);
    onContentChange?.();
  }, [element, onContentChange]);

  // Update autoplay
  const handleAutoplayChange = useCallback((checked) => {
    if (!element) return;

    if (checked) {
      element.setAttribute('autoplay', '');
      element.setAttribute('data-autoplay', ''); // Reveal.js uses this
    } else {
      element.removeAttribute('autoplay');
      element.removeAttribute('data-autoplay');
    }
    setAutoplay(checked);
    onContentChange?.();
  }, [element, onContentChange]);

  // Update loop
  const handleLoopChange = useCallback((checked) => {
    if (!element) return;

    if (checked) {
      element.setAttribute('loop', '');
    } else {
      element.removeAttribute('loop');
    }
    setLoop(checked);
    onContentChange?.();
  }, [element, onContentChange]);

  // Update muted
  const handleMutedChange = useCallback((checked) => {
    if (!element) return;

    if (checked) {
      element.setAttribute('muted', '');
    } else {
      element.removeAttribute('muted');
    }
    element.muted = checked; // Also set the property for immediate effect
    setMuted(checked);
    onContentChange?.();
  }, [element, onContentChange]);

  // Update controls
  const handleControlsChange = useCallback((checked) => {
    if (!element) return;

    if (checked) {
      element.setAttribute('controls', '');
    } else {
      element.removeAttribute('controls');
    }
    setControls(checked);
    onContentChange?.();
  }, [element, onContentChange]);

  // Upload to Cloudinary for optimized CDN delivery
  const handleUploadToCloudinary = useCallback(async () => {
    if (!element?.src) return;

    // Get slide ID from the URL path
    const pathParts = window.location.pathname.split('/');
    const slideId = pathParts[1]; // URL format: /:slideId

    if (!slideId) {
      message.error('Could not determine slide ID');
      return;
    }

    setUploading(true);
    try {
      const response = await fetch('/api/video/upload-cloudinary', {
        method: 'POST',
        body: new URLSearchParams({
          videoUrl: element.src,
          slideId,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Upload failed');
      }

      if (data.cloudinaryUrl) {
        // Update the video element with the new Cloudinary URL
        element.src = data.cloudinaryUrl;
        setUrl(data.cloudinaryUrl);
        onContentChange?.();

        // Auto-save the content since we've deleted the original file
        // This ensures the new Cloudinary URL is persisted immediately
        if (data.deletedOriginal) {
          onSaveContent?.();
        }

        // Format file size for message
        const sizeMB = data.bytes ? (data.bytes / 1024 / 1024).toFixed(1) : null;
        const deletedMsg = data.deletedOriginal ? ' Saved.' : '';
        message.success(
          `Video uploaded to Cloudinary!${sizeMB ? ` (${sizeMB} MB)` : ''}${deletedMsg}`
        );
      }
    } catch (err) {
      console.error('Cloudinary upload error:', err);
      message.error(`Upload failed: ${err.message}`);
    } finally {
      setUploading(false);
    }
  }, [element, onContentChange]);

  // Check if video is already on Cloudinary
  const isCloudinaryUrl = url?.includes('cloudinary.com');

  if (!element) {
    return null;
  }

  // Check if URL looks like it might not work
  const isMovFile = url.toLowerCase().endsWith('.mov');

  return (
    <div className="space-y-4">
      <PropertySection title="Video">
        {/* URL */}
        <div>
          <PropertyLabel>URL</PropertyLabel>
          <Input
            value={url}
            onChange={handleUrlChange}
            placeholder="https://example.com/video.mp4"
            size="small"
          />
          {isMovFile && !isCloudinaryUrl && (
            <p className="text-xs text-amber-500 mt-1">
              ⚠️ .mov files may not play in all browsers
            </p>
          )}

          {/* Cloudinary status / upload button */}
          {isCloudinaryUrl ? (
            <div className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400 mt-2">
              <CheckCircleOutlined />
              <span>Hosted on Cloudinary CDN</span>
            </div>
          ) : url && (
            <Button
              icon={<CloudUploadOutlined />}
              onClick={handleUploadToCloudinary}
              loading={uploading}
              size="small"
              className="w-full mt-2"
            >
              {uploading ? 'Uploading...' : 'Upload to Cloudinary'}
            </Button>
          )}
          {!isCloudinaryUrl && url && (
            <p className="text-xs text-gray-400 mt-1">
              Optimize for web delivery & format compatibility
            </p>
          )}
        </div>

        {/* Autoplay */}
        <PropertyRow label="Autoplay">
          <Switch
            checked={autoplay}
            onChange={handleAutoplayChange}
            size="small"
          />
        </PropertyRow>
        {autoplay && !muted && (
          <p className="text-xs text-amber-500 -mt-2 ml-1">
            ⚠️ Browsers block autoplay unless video is muted
          </p>
        )}

        {/* Loop */}
        <PropertyRow label="Loop">
          <Switch
            checked={loop}
            onChange={handleLoopChange}
            size="small"
          />
        </PropertyRow>

        {/* Muted */}
        <PropertyRow label="Muted">
          <Switch
            checked={muted}
            onChange={handleMutedChange}
            size="small"
          />
        </PropertyRow>

        {/* Controls */}
        <PropertyRow label="Show Controls">
          <Switch
            checked={controls}
            onChange={handleControlsChange}
            size="small"
          />
        </PropertyRow>
      </PropertySection>

      <p className="text-xs text-gray-500 dark:text-gray-400 mt-3 px-1">
        Supported formats: MP4, WebM, Ogg. Upload to Cloudinary to auto-convert unsupported formats like .mov.
      </p>
    </div>
  );
}
