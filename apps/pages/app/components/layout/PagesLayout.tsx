import React from 'react';

/**
 * PagesLayout - Main layout wrapper: top bar, sidebar and content area
 *
 * The top bar runs across the full width; below it a fixed sidebar that can
 * collapse/expand with smooth transitions. On mobile, the sidebar becomes an
 * overlay with backdrop (opened from the top bar's menu button). The content
 * area scrolls on its own and adjusts its margin to the sidebar state.
 */
interface PagesLayoutProps {
  children: React.ReactNode;
  topBar: React.ReactNode;
  sidebar: React.ReactNode;
  collapsed: boolean;
}

const PagesLayout = ({ children, topBar, sidebar, collapsed }: PagesLayoutProps) => {
  return (
    <div className="flex flex-col h-screen overflow-hidden bg-white dark:bg-[#191919]">
      {topBar}

      <div className="flex flex-1 min-h-0">
        {/* Sidebar (fixed, below the top bar) */}
        {sidebar}

        {/* Main content area */}
        <div
          className={`flex-1 overflow-y-auto transition-all duration-200 ease-in-out ${
            collapsed ? 'md:ml-16' : 'md:ml-60'
          }`}
        >
          {children}
        </div>
      </div>
    </div>
  );
};

export default PagesLayout;
