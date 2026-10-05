// `ws` is hoisted from the root (crossws uses it) without @types/ws; the tests
// only subclass it to send Cookie/Origin headers.
declare module 'ws' {
  export default class WebSocket {
    constructor(url: string, options?: { headers?: Record<string, string> });
  }
}
