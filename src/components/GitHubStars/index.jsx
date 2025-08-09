import React, { useState, useEffect } from 'react';

const StarIcon = () => (
  <svg width='16' height='16' viewBox='0 0 16 16' fill='currentColor'>
    <path d='M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25z' />
  </svg>
);

export default function GitHubStars() {
  const [stars, setStars] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchStars = async () => {
      try {
        const response = await fetch(
          'https://api.github.com/repos/classmoji/classmoji'
        );
        const data = await response.json();
        setStars(data.stargazers_count);
      } catch (error) {
        console.error('Error fetching GitHub stars:', error);
        setStars(0);
      } finally {
        setLoading(false);
      }
    };

    fetchStars();
  }, []);

  const formatStarCount = count => {
    if (count >= 1000) {
      return (count / 1000).toFixed(1).replace('.0', '') + 'k';
    }
    return count?.toLocaleString() || '0';
  };

  return (
    <a
      href='https://github.com/classmoji/classmoji'
      target='_blank'
      rel='noopener noreferrer'
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        textDecoration: 'none',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif',
        fontSize: '14px',
        fontWeight: '500',
        color: '#656d76',
        border: '1px solid #d1d9e0',
        borderRadius: '6px',
        overflow: 'hidden',
        transition: 'all 0.15s ease',
        backgroundColor: '#f6f8fa',
        cursor: 'pointer',
      }}
      onMouseOver={e => {
        e.currentTarget.style.backgroundColor = '#f3f4f6';
        e.currentTarget.style.borderColor = '#c9d1d9';
      }}
      onMouseOut={e => {
        e.currentTarget.style.backgroundColor = '#f6f8fa';
        e.currentTarget.style.borderColor = '#d1d9e0';
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '5px 8px',
          gap: '4px',
          borderRight: '1px solid #d1d9e0',
          backgroundColor: 'transparent',
        }}
      >
        <StarIcon />
        <span>Stars</span>
      </div>
      <div
        style={{
          padding: '5px 8px',
          backgroundColor: 'transparent',
          fontWeight: '600',
          color: '#24292f',
        }}
      >
        {loading ? '...' : formatStarCount(stars)}
      </div>
    </a>
  );
}
