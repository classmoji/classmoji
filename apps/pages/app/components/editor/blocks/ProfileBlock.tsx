import {
  createReactBlockSpec,
  type ReactCustomBlockRenderProps,
} from '@blocknote/react';
import { useState, useRef } from 'react';
import { IconCamera } from '@tabler/icons-react';

const profilePropSchema = {
  name: { default: '' },
  title: { default: '' },
  imageUrl: { default: '' },
  links: { default: '' },
};

type ProfileRenderProps = ReactCustomBlockRenderProps<'profile', typeof profilePropSchema, 'none'>;

export const Profile = createReactBlockSpec(
  {
    type: 'profile',
    propSchema: profilePropSchema,
    content: 'none',
  },
  {
    render: (props: ProfileRenderProps) => {
      const { name, title, imageUrl } = props.block.props;
      const isEditable = props.editor.isEditable;
      const [isUploading, setIsUploading] = useState(false);
      const fileInputRef = useRef<HTMLInputElement>(null);

      const handleAvatarClick = () => {
        if (!isEditable || isUploading) return;
        fileInputRef.current?.click();
      };

      const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        setIsUploading(true);
        try {
          const url = await props.editor.uploadFile?.(file);
          if (typeof url === 'string') {
            props.editor.updateBlock(props.block, {
              props: { imageUrl: url },
            });
          }
        } catch (err) {
          console.error('Profile image upload failed:', err);
        } finally {
          setIsUploading(false);
          // Reset so the same file can be re-selected
          if (fileInputRef.current) fileInputRef.current.value = '';
        }
      };

      return (
        <div className="profile-block" contentEditable={false}>
          {/* Hidden file input */}
          {isEditable && (
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
          )}

          {/* Avatar */}
          <div
            className={`profile-avatar-wrapper ${isEditable ? 'profile-avatar-editable' : ''}`}
            onClick={handleAvatarClick}
          >
            {imageUrl ? (
              <img
                src={typeof imageUrl === 'string' ? imageUrl : ''}
                alt={typeof name === 'string' ? name : 'Profile image'}
                className="profile-avatar-image"
              />
            ) : (
              <div className="profile-avatar-placeholder">
                {isUploading ? (
                  <span className="profile-avatar-spinner">⟳</span>
                ) : (
                  '👤'
                )}
              </div>
            )}

            {/* Upload overlay (edit mode only) */}
            {isEditable && !isUploading && (
              <div className="profile-avatar-overlay">
                <IconCamera size={20} />
              </div>
            )}

            {/* Uploading overlay */}
            {isUploading && imageUrl && (
              <div className="profile-avatar-uploading">
                <span className="profile-avatar-spinner">⟳</span>
              </div>
            )}
          </div>

          {/* Text fields */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {isEditable ? (
              <>
                <input
                  value={name}
                  onChange={(e) =>
                    props.editor.updateBlock(props.block, {
                      props: { name: e.target.value },
                    })
                  }
                  placeholder="Name"
                  className="profile-input profile-input-name"
                />
                <input
                  value={title}
                  onChange={(e) =>
                    props.editor.updateBlock(props.block, {
                      props: { title: e.target.value },
                    })
                  }
                  placeholder="Title / Role"
                  className="profile-input profile-input-title"
                />
              </>
            ) : (
              <>
                {name && <div className="profile-display-name">{name}</div>}
                {title && <div className="profile-display-title">{title}</div>}
              </>
            )}

          </div>
        </div>
      );
    },
  }
);
