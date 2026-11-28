/* eslint-disable @typescript-eslint/no-explicit-any */
// Minimal NextResponse stand-in (the real one extends Response). A class so route handlers can `new NextResponse(body, init)`.
export class NextResponse extends Response {
  static json(body: unknown, init?: ResponseInit) {
    return Response.json(body, init);
  }
  // Redirect + response cookies, enough for route handlers: cookies are recorded on `.setCookies` and as Set-Cookie headers.
  static redirect(url: string | URL, status = 307) {
    return new NextResponse(null, { status, headers: { location: String(url) } });
  }
  setCookies: { name: string; value: string; options: any }[] = [];
  get cookies() {
    return { set: (name: string, value: string, options: any = {}) => { this.setCookies.push({ name, value, options }); } };
  }
}

// next/server `after()` stand-in: callbacks are queued, never run implicitly. Tests call `await drainAfter()` to play the part of the
// platform running them after the response (and simply do not, to simulate a worker that died before delivering).
export function after(callback: () => unknown) {
  ((globalThis as any).__TEST_AFTER__ ??= []).push(callback);
}
