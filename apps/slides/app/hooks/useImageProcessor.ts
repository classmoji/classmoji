import { useCallback } from 'react';

/**
 * useImageProcessor - Format-aware image processing hook
 *
 * Handles different image formats appropriately:
 * - GIF: Pass through (canvas would lose animation)
 * - PNG: Resize only (quality param doesn't affect PNG)
 * - JPEG/WebP: Resize + compress with quality setting
 *
 * Returns processed blob ready for upload
 */
export function useImageProcessor() {
  /**
   * Check if a PNG has transparency by sampling pixels
   */
  const hasTransparency = useCallback(async (file: File): Promise<boolean> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(img.width, 100); // Sample small area
        canvas.height = Math.min(img.height, 100);
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

        try {
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const data = imageData.data;
          // Check alpha channel (every 4th value)
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] < 255) {
              URL.revokeObjectURL(img.src);
              resolve(true);
              return;
            }
          }
        } catch {
          // Canvas tainted or other error, assume no transparency
        }
        URL.revokeObjectURL(img.src);
        resolve(false);
      };
      img.onerror = () => resolve(false);
      img.src = URL.createObjectURL(file);
    });
  }, []);

  /**
   * Resize an image using canvas
   */
  const resizeImage = useCallback(async (file: File, options: { maxWidth?: number; maxHeight?: number; quality?: number; format?: string | null } = {}): Promise<Blob> => {
    const {
      maxWidth = 1920,
      maxHeight = 1080,
      quality = 0.85,
      format = null,
    } = options;

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;

        // Calculate new dimensions maintaining aspect ratio
        if (width > maxWidth || height > maxHeight) {
          const ratio = Math.min(maxWidth / width, maxHeight / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;

        // High-quality smoothing
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, width, height);

        // Determine output format
        const outputFormat = format || file.type || 'image/jpeg';

        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(img.src);
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error('Failed to create image blob'));
            }
          },
          outputFormat,
          outputFormat === 'image/png' ? undefined : quality
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(img.src);
        reject(new Error('Failed to load image'));
      };
      img.src = URL.createObjectURL(file);
    });
  }, []);

  /**
   * Apply crop to an image
   */
  const cropImage = useCallback(async (file: File, crop: any, options: { quality?: number; format?: string | null; displayedWidth?: number; displayedHeight?: number } = {}): Promise<Blob> => {
    const {
      quality = 0.85,
      format = null,
      displayedWidth,
      displayedHeight,
    } = options;

    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        // Scale from displayed dimensions to natural dimensions
        // crop coordinates are relative to the displayed image size
        const scaleX = displayedWidth ? img.naturalWidth / displayedWidth : 1;
        const scaleY = displayedHeight ? img.naturalHeight / displayedHeight : 1;

        // Calculate the actual crop region in natural image coordinates
        const naturalCropX = Math.round(crop.x * scaleX);
        const naturalCropY = Math.round(crop.y * scaleY);
        const naturalCropWidth = Math.round(crop.width * scaleX);
        const naturalCropHeight = Math.round(crop.height * scaleY);

        const canvas = document.createElement('canvas');
        // Output at natural crop dimensions for full quality
        canvas.width = naturalCropWidth;
        canvas.height = naturalCropHeight;
        const ctx = canvas.getContext('2d')!;

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';

        ctx.drawImage(
          img,
          naturalCropX,
          naturalCropY,
          naturalCropWidth,
          naturalCropHeight,
          0,
          0,
          naturalCropWidth,
          naturalCropHeight
        );

        const outputFormat = format || file.type || 'image/jpeg';

        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(img.src);
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error('Failed to create cropped image blob'));
            }
          },
          outputFormat,
          outputFormat === 'image/png' ? undefined : quality
        );
      };
      img.onerror = () => {
        URL.revokeObjectURL(img.src);
        reject(new Error('Failed to load image for cropping'));
      };
      img.src = URL.createObjectURL(file);
    });
  }, []);

  /**
   * Process an image with format-aware handling
   */
  const processImage = useCallback(async (file: File, options: any = {}): Promise<{ blob: Blob; wasProcessed: boolean; originalSize: number; newSize: number; format: string }> => {
    const { crop, displayedWidth, displayedHeight, maxWidth = 1920, maxHeight = 1080, quality = 0.85 } = options;
    const isGif = file.type === 'image/gif';
    const isPng = file.type === 'image/png';
    const originalSize = file.size;

    // GIFs: No processing (would lose animation)
    if (isGif) {
      return {
        blob: file,
        wasProcessed: false,
        originalSize,
        newSize: file.size,
        format: 'gif',
      };
    }

    // Determine output format
    let outputFormat = file.type;
    if (isPng) {
      // Check if PNG has transparency
      const transparent = await hasTransparency(file);
      if (!transparent) {
        // No transparency - can convert to JPEG for better compression
        outputFormat = 'image/jpeg';
      }
    }

    let processedBlob: Blob;

    if (crop && crop.width && crop.height) {
      // Apply crop first (with displayed dimensions for proper scaling), then resize if needed
      processedBlob = await cropImage(file, crop, {
        quality,
        format: outputFormat,
        displayedWidth,
        displayedHeight,
      });
      // If cropped image is still too large, resize it
      if (processedBlob.size > 0) {
        const tempFile = new File([processedBlob], file.name, { type: outputFormat });
        processedBlob = await resizeImage(tempFile, { maxWidth, maxHeight, quality, format: outputFormat });
      }
    } else {
      // Just resize
      processedBlob = await resizeImage(file, { maxWidth, maxHeight, quality, format: outputFormat });
    }

    return {
      blob: processedBlob,
      wasProcessed: true,
      originalSize,
      newSize: processedBlob.size,
      format: outputFormat.replace('image/', ''),
    };
  }, [hasTransparency, cropImage, resizeImage]);

  /**
   * Get image dimensions
   */
  const getImageDimensions = useCallback(async (file: File): Promise<{ width: number; height: number }> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(img.src);
        resolve({ width: img.width, height: img.height });
      };
      img.onerror = () => {
        URL.revokeObjectURL(img.src);
        reject(new Error('Failed to load image'));
      };
      img.src = URL.createObjectURL(file);
    });
  }, []);

  /**
   * Format file size for display
   */
  const formatFileSize = useCallback((bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }, []);

  return {
    processImage,
    resizeImage,
    cropImage,
    hasTransparency,
    getImageDimensions,
    formatFileSize,
  };
}
