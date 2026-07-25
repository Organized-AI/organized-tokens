/**
 * Room — one Durable Object per workshop.
 *
 * Holds the open projector/attendee sockets and fans out the recomputed board
 * whenever someone pushes. Uses the hibernation API so an idle room between
 * sessions costs nothing while sockets stay connected.
 */

export class Room implements DurableObject {
  private state: DurableObjectState;
  private last: string | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/broadcast") {
      const payload = await req.text();
      this.last = payload;
      await this.state.storage.put("last", payload);
      for (const ws of this.state.getWebSockets()) {
        try { ws.send(payload); } catch { /* dropped socket; hibernation cleans up */ }
      }
      return new Response("ok");
    }

    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1]);

    // Send whatever we have immediately so a projector that connects mid-session
    // is not staring at an empty board until the next push.
    const cached = this.last ?? (await this.state.storage.get<string>("last"));
    if (cached) {
      try { pair[1].send(cached); } catch { /* client vanished */ }
    }

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    // Clients only ever ping. Nothing inbound is trusted or acted on.
    if (msg === "ping") ws.send(JSON.stringify({ pong: Date.now() }));
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try { ws.close(code, "closing"); } catch { /* already gone */ }
  }

  async webSocketError() {
    /* hibernation API removes the socket for us */
  }
}
