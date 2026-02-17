import { useState, useEffect, useCallback } from 'react';
import { Modal, Button, Tabs, Input, Slider, Spin, Empty } from 'antd';
import { useDropzone } from 'react-dropzone';
import { useFetcher } from 'react-router';
import {
  IconPhoto,
  IconUpload,
  IconLink,
  IconBrandUnsplash,
  IconSearch,
  IconTrash,
  IconCheck,
} from '@tabler/icons-react';

/**
 * HeaderImageModal - Pick header/banner image from Upload, Unsplash, or URL
 */
export default function HeaderImageModal({
  open,
  onCancel,
  onSave,
  currentImageUrl,
  currentPosition = 50,
  hasUnsplash = false,
  isUploading = false,
  onUploadImage,
}) {
  const [activeTab, setActiveTab] = useState('upload');
  const [imageUrl, setImageUrl] = useState(currentImageUrl || '');
  const [position, setPosition] = useState(currentPosition);
  const [linkUrl, setLinkUrl] = useState('');
  const [previewError, setPreviewError] = useState(false);

  // Unsplash search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedPhoto, setSelectedPhoto] = useState(null);

  const unsplashFetcher = useFetcher();

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setImageUrl(currentImageUrl || '');
      setPosition(currentPosition);
      setLinkUrl('');
      setPreviewError(false);
      setSearchQuery('');
      setSearchResults([]);
      setSelectedPhoto(null);
      setActiveTab(currentImageUrl ? 'upload' : 'upload');
    }
  }, [open, currentImageUrl, currentPosition]);

  // Handle Unsplash search results
  useEffect(() => {
    if (unsplashFetcher.data && !unsplashFetcher.data.error) {
      setSearchResults(unsplashFetcher.data.photos || []);
      setIsSearching(false);
    } else if (unsplashFetcher.data?.error) {
      setIsSearching(false);
    }
  }, [unsplashFetcher.data]);

  // Dropzone for file upload
  const onDrop = useCallback(
    async acceptedFiles => {
      const file = acceptedFiles[0];
      if (file && onUploadImage) {
        try {
          const url = await onUploadImage(file);
          if (url) {
            setImageUrl(url);
            setPreviewError(false);
          }
        } catch (err) {
          console.error('Header image upload failed:', err);
        }
      }
    },
    [onUploadImage]
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp'],
    },
    maxFiles: 1,
    disabled: isUploading,
  });

  // Unsplash search handler
  const handleUnsplashSearch = useCallback(() => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    unsplashFetcher.load(`/api/unsplash?q=${encodeURIComponent(searchQuery)}`);
  }, [searchQuery, unsplashFetcher]);

  // Handle selecting an Unsplash photo
  const handleSelectPhoto = useCallback(
    photo => {
      setSelectedPhoto(photo);
      setImageUrl(photo.url);
      setPreviewError(false);

      // Trigger download tracking (required by Unsplash API terms)
      const formData = new FormData();
      formData.append('downloadUrl', photo.downloadUrl);
      unsplashFetcher.submit(formData, {
        method: 'post',
        action: '/api/unsplash',
      });
    },
    [unsplashFetcher]
  );

  // Handle link URL input
  const handleLinkSubmit = useCallback(() => {
    if (linkUrl.trim()) {
      setImageUrl(linkUrl.trim());
      setPreviewError(false);
    }
  }, [linkUrl]);

  // Handle save
  const handleSave = useCallback(() => {
    onSave({
      url: imageUrl,
      position,
      photographer: selectedPhoto?.photographer || null,
    });
  }, [imageUrl, position, selectedPhoto, onSave]);

  // Handle remove
  const handleRemove = useCallback(() => {
    onSave({ url: null, position: 50 });
  }, [onSave]);

  const tabItems = [
    {
      key: 'upload',
      label: (
        <span className="flex items-center gap-1.5">
          <IconUpload size={16} />
          Upload
        </span>
      ),
      children: (
        <div className="space-y-4">
          <div
            {...getRootProps()}
            className={`
              border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors
              ${isDragActive ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400'}
              ${isUploading ? 'opacity-50 cursor-not-allowed' : ''}
            `}
          >
            <input {...getInputProps()} />
            {isUploading ? (
              <div className="flex flex-col items-center gap-2 text-gray-500">
                <Spin />
                <span>Uploading...</span>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 text-gray-500">
                <IconPhoto size={32} />
                <span>Drop an image here, or click to select</span>
                <span className="text-xs text-gray-400">PNG, JPG, GIF, WebP</span>
              </div>
            )}
          </div>
        </div>
      ),
    },
  ];

  // Only show Unsplash tab if API key is configured
  if (hasUnsplash) {
    tabItems.push({
      key: 'unsplash',
      label: (
        <span className="flex items-center gap-1.5">
          <IconBrandUnsplash size={16} />
          Unsplash
        </span>
      ),
      children: (
        <div className="space-y-4">
          {/* Search input */}
          <div className="flex gap-2">
            <Input
              placeholder="Search free photos..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onPressEnter={handleUnsplashSearch}
              prefix={<IconSearch size={16} className="text-gray-400" />}
            />
            <Button onClick={handleUnsplashSearch} loading={isSearching}>
              Search
            </Button>
          </div>

          {/* Results grid */}
          {isSearching ? (
            <div className="flex justify-center py-8">
              <Spin />
            </div>
          ) : searchResults.length > 0 ? (
            <div className="grid grid-cols-3 gap-2 max-h-64 overflow-y-auto">
              {searchResults.map(photo => (
                <div
                  key={photo.id}
                  className={`
                    relative aspect-video rounded-md overflow-hidden cursor-pointer
                    transition-all hover:ring-2 hover:ring-blue-400
                    ${selectedPhoto?.id === photo.id ? 'ring-2 ring-blue-500' : ''}
                  `}
                  onClick={() => handleSelectPhoto(photo)}
                >
                  <img
                    src={photo.thumb}
                    alt={photo.alt}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                  {selectedPhoto?.id === photo.id && (
                    <div className="absolute inset-0 bg-blue-500/20 flex items-center justify-center">
                      <IconCheck size={24} className="text-white" />
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : searchQuery && !isSearching ? (
            <Empty description="No photos found" />
          ) : (
            <div className="text-center py-8 text-gray-400">
              <IconBrandUnsplash size={32} className="mx-auto mb-2 opacity-50" />
              <p>Search for free photos from Unsplash</p>
            </div>
          )}

          {/* Attribution for selected photo */}
          {selectedPhoto && (
            <div className="text-xs text-gray-500 text-center">
              Photo by{' '}
              <a
                href={`${selectedPhoto.photographer.link}?utm_source=classmoji&utm_medium=referral`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 hover:underline"
              >
                {selectedPhoto.photographer.name}
              </a>{' '}
              on{' '}
              <a
                href="https://unsplash.com?utm_source=classmoji&utm_medium=referral"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 hover:underline"
              >
                Unsplash
              </a>
            </div>
          )}
        </div>
      ),
    });
  }

  // Link tab
  tabItems.push({
    key: 'link',
    label: (
      <span className="flex items-center gap-1.5">
        <IconLink size={16} />
        Link
      </span>
    ),
    children: (
      <div className="space-y-4">
        <div className="flex gap-2">
          <Input
            placeholder="Paste image URL..."
            value={linkUrl}
            onChange={e => setLinkUrl(e.target.value)}
            onPressEnter={handleLinkSubmit}
          />
          <Button onClick={handleLinkSubmit} disabled={!linkUrl.trim()}>
            Use
          </Button>
        </div>
        <p className="text-xs text-gray-400">
          Enter the URL of an image. Make sure you have permission to use the image.
        </p>
      </div>
    ),
  });

  return (
    <Modal
      title="Header Image"
      open={open}
      onCancel={onCancel}
      width={600}
      footer={
        <div className="flex justify-between">
          <div>
            {(currentImageUrl || imageUrl) && (
              <Button danger icon={<IconTrash size={16} />} onClick={handleRemove}>
                Remove
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button onClick={onCancel}>Cancel</Button>
            <Button type="primary" onClick={handleSave} disabled={!imageUrl}>
              Save
            </Button>
          </div>
        </div>
      }
    >
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} />

      {/* Preview section */}
      {imageUrl && !previewError && (
        <div className="mt-4 space-y-3">
          <div className="text-sm font-medium text-gray-700">Preview</div>
          <div
            className="w-full aspect-[4/1] rounded-lg overflow-hidden bg-gray-100"
            style={{
              backgroundImage: `url(${imageUrl})`,
              backgroundSize: 'cover',
              backgroundPosition: `center ${position}%`,
            }}
          >
            <img
              src={imageUrl}
              alt=""
              className="hidden"
              onError={() => setPreviewError(true)}
              onLoad={() => setPreviewError(false)}
            />
          </div>

          {/* Position slider */}
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500 w-24">Position</span>
            <Slider
              className="flex-1"
              min={0}
              max={100}
              value={position}
              onChange={setPosition}
              tooltip={{ formatter: val => `${val}%` }}
            />
          </div>
        </div>
      )}

      {previewError && imageUrl && (
        <div className="mt-4 p-4 bg-red-50 text-red-600 rounded-lg text-sm">
          Failed to load image. Please check the URL and try again.
        </div>
      )}
    </Modal>
  );
}
