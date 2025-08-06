import React from 'react';
import ReactPlayer from 'react-player';

const VideoPlayer = ({
  src,
  thumbnail = 'https://example.com/thumbnail.png',
  aspectRatio = '16 / 9', // Default 16:9
}) => {
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        aspectRatio: aspectRatio,
        borderRadius: '12px',
        overflow: 'hidden',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.2)',
        background: '#000',
      }}
    >
      <ReactPlayer
        src={src}
        width='100%'
        height='100%'
        controls={true}
        light={
          <img src={thumbnail} alt='Thumbnail' style={{ width: '100%' }} />
        }
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
        }}
      />
    </div>
  );
};

export default VideoPlayer;
