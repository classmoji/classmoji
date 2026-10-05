import { createReactBlockSpec } from '@blocknote/react';
import { dividerConfig } from '@classmoji/page-schema';

export const Divider = createReactBlockSpec(dividerConfig, {
  render: () => {
    return (
      <div className="divider-block" contentEditable={false}>
        <hr />
      </div>
    );
  },
});
