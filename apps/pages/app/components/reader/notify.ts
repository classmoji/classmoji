import { toast } from 'react-toastify';

/**
 * How the reader tells someone something went wrong (a tick that did not
 * save, a comment that did not post).
 *
 * An adapter rather than a direct `toast` call: the pages app renders its
 * `ToastContainer` in the root layout, and a reader mounted elsewhere (the
 * class site's island, with no app root) brings its own container. The host
 * passes the adapter; the default is react-toastify's global `toast`, which
 * every in-app caller (the editor included) has always used.
 */
export interface ReaderNotify {
  error(message: string): void;
  success(message: string): void;
  info(message: string): void;
}

export const toastNotify: ReaderNotify = {
  error: message => {
    toast.error(message);
  },
  success: message => {
    toast.success(message);
  },
  info: message => {
    toast.info(message);
  },
};
