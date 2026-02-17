import { createReactBlockSpec } from '@blocknote/react';

export const Divider = createReactBlockSpec(
  {
    type: 'divider',
    propSchema: {},
    content: 'none',
  },
  {
    render: () => {
      return (
        <div className="divider-block" contentEditable={false}>
          <hr />
        </div>
      );
    },
  }
);
