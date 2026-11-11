// Minimal NextResponse stand-in (the real one extends Response). A class so route handlers can `new NextResponse(body, init)`.
export class NextResponse extends Response {
  static json(body: unknown, init?: ResponseInit) {
    return Response.json(body, init);
  }
}
