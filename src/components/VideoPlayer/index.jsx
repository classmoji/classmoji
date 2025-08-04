import React from 'react';
import ReactPlayer from 'react-player';

const VideoPlayer = ({ url, width = '100%', height = '400px' }) => {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: '12px',
        overflow: 'hidden',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)',
        background: '#000',
        position: 'relative',
      }}
    >
      <ReactPlayer
        src={url}
        width='100%'
        height='100%'
        controls={true}
        style={{
          borderRadius: '12px',
        }}
      />
    </div>
  );
};

export default VideoPlayer;
