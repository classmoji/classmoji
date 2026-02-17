import { useState } from 'react';
import { IconMenu2 } from '@tabler/icons-react';

/**
 * PagesLayout - Main layout wrapper with sidebar and content area
 *
 * Provides a fixed sidebar that can collapse/expand with smooth transitions.
 * On mobile, sidebar becomes an overlay with backdrop.
 * Content area adjusts margin based on sidebar state.
 */
const PagesLayout = ({ children, sidebar, collapsed, onMobileMenuClick }) => {
  return (
    <div className="flex h-screen overflow-hidden bg-white dark:bg-[#191919]">
      {/* Sidebar */}
      {sidebar}

      {/* Main content area */}
      <div
        className={`flex-1 overflow-y-auto transition-all duration-200 ease-in-out ${
          collapsed ? 'md:ml-16' : 'md:ml-60'
        }`}
      >
        {/* Mobile menu button */}
        <button
          onClick={onMobileMenuClick}
          className="md:hidden fixed top-4 left-4 z-40 p-2 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700"
          aria-label="Open menu"
        >
          <IconMenu2 size={20} className="text-gray-700 dark:text-gray-300" />
        </button>

        {children}
      </div>
    </div>
  );
};

export default PagesLayout;
