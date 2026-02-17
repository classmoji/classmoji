import { useEffect, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';

/**
 * QRCodeOverlay - Full-screen overlay displaying a QR code
 *
 * Used for sharing presentation links with audience:
 * - Follow QR: Students scan to follow along
 * - Control QR: Presenter scans with phone to control from phone
 *
 * Dismisses on ESC key or click anywhere.
 */
export default function QRCodeOverlay({ url, title, onClose }) {
  // Handle keyboard events
  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div
      className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 cursor-pointer"
      onClick={onClose}
    >
      <div className="text-center" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-white text-3xl font-semibold mb-8">{title}</h2>

        <div className="bg-white p-8 rounded-2xl inline-block shadow-2xl">
          <QRCodeSVG
            value={url}
            size={320}
            level="M"
            includeMargin={false}
          />
        </div>

        <p className="text-white/70 mt-6 text-lg">
          Scan to join
        </p>

        <p className="text-white/40 mt-2 text-sm font-mono break-all max-w-md mx-auto">
          {url}
        </p>

        <p className="text-white/30 mt-8 text-sm">
          Press ESC or click outside to close
        </p>
      </div>
    </div>
  );
}
