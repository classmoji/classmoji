import { useState, useEffect } from 'react';
import { IconBrandGithub, IconMaximize, IconMinimize, IconDots } from '@tabler/icons-react';
import PageOptionsMenu from '~/components/editor/PageOptionsMenu.jsx';

/**
 * Page header bar with classroom name, navigation, save controls, and action buttons.
 */
const Header = ({
  classroom,
  page,
  saveStatus = 'saved',
  hasUnsavedChanges = false,
  canEdit = false,
  onSave,
}) => {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  // Track fullscreen state
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  };

  // Build GitHub URL
  const githubUrl = classroom.git_organization && page?.content_path
    ? `https://github.com/${classroom.git_organization.login}/${classroom.git_organization.repo}/blob/main/${page.content_path}/content.json`
    : null;

  return (
    <header className="sticky top-0 z-40 bg-white dark:bg-[#191919] w-full">
      <div className="px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-12">
          {/* Left: page title */}
          <div className="flex items-center gap-3 text-sm">
            {page && (
              <span className="text-gray-900 dark:text-white font-medium">
                {page.title || 'Untitled'}
              </span>
            )}
          </div>

          {/* Right: save controls + action buttons */}
          <div className="flex items-center gap-2">
            {page && (
              <>
                {/* Save controls (instructors only) */}
                {canEdit && (
                  <div className="flex items-center gap-2 text-sm">
                    {saveStatus === 'saving' && (
                      <span className="flex items-center gap-1 text-gray-600 dark:text-gray-400">
                        <span className="animate-spin">⟳</span> Saving...
                      </span>
                    )}
                    {saveStatus === 'saved' && !hasUnsavedChanges && (
                      <span className="flex items-center gap-1 text-green-600 dark:text-green-400">
                        ✓ Saved
                      </span>
                    )}
                    {saveStatus === 'error' && (
                      <span className="flex items-center gap-1 text-red-600 dark:text-red-400">
                        ✕ Failed to save
                      </span>
                    )}
                    {hasUnsavedChanges && saveStatus !== 'saving' && onSave && (
                      <button
                        type="button"
                        onClick={onSave}
                        className="px-2.5 py-1 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 dark:bg-blue-500 dark:hover:bg-blue-600 rounded transition-colors"
                      >
                        Save
                      </button>
                    )}
                  </div>
                )}

                {/* GitHub button (instructors only) */}
                {canEdit && githubUrl && (
                  <a
                    href={githubUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
                    title="View on GitHub"
                  >
                    <IconBrandGithub size={18} />
                  </a>
                )}

                {/* Fullscreen button (always visible) */}
                <button
                  onClick={toggleFullscreen}
                  className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
                  title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                >
                  {isFullscreen ? (
                    <IconMinimize size={18} />
                  ) : (
                    <IconMaximize size={18} />
                  )}
                </button>

                {/* Options menu (instructors only) */}
                {canEdit && (
                  <div className="relative">
                    <button
                      onClick={() => setIsMenuOpen(!isMenuOpen)}
                      className="p-1.5 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
                      title="More options"
                    >
                      <IconDots size={18} />
                    </button>

                    <PageOptionsMenu
                      page={page}
                      classroom={classroom}
                      isOpen={isMenuOpen}
                      onClose={() => setIsMenuOpen(false)}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};

export default Header;
