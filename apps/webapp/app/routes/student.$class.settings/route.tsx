import { redirect } from 'react-router';

// Personal settings (appearance) moved to account settings: they apply in
// every classroom. Kept as a redirect so old links still land somewhere.
export const loader = () => redirect('/settings/appearance');
