import assert from "node:assert/strict";
import test from "node:test";

import { CdpSession, validateLoopbackEndpoint } from "../../scripts/lib/cdp_session.mjs";

test("CDP endpoints are restricted to loopback", () => {
  assert.equal(validateLoopbackEndpoint("http://127.0.0.1:9222").origin, "http://127.0.0.1:9222");
  assert.equal(validateLoopbackEndpoint("http://localhost:9222").origin, "http://localhost:9222");
  assert.throws(() => new CdpSession("http://192.168.1.10:9222"), { code: "NON_LOOPBACK_CDP_ENDPOINT" });
  assert.throws(() => new CdpSession("http://127.evil.example:9222"), { code: "NON_LOOPBACK_CDP_ENDPOINT" });
});

test("host-side CDP timeout rejects a command that never answers", async () => {
  const session = new CdpSession("http://127.0.0.1:9222", { commandTimeoutMs: 5 });
  session.ws = {
    readyState: WebSocket.OPEN,
    send() {},
    close() {},
  };
  await assert.rejects(session.send("Runtime.evaluate"), { code: "CDP_TIMEOUT" });
  assert.equal(session.pending.size, 0);
});

test("closing a session rejects pending commands", async () => {
  const session = new CdpSession("http://127.0.0.1:9222", { commandTimeoutMs: 1000 });
  session.ws = {
    readyState: WebSocket.OPEN,
    send() {},
    close() {},
  };
  const command = session.send("Runtime.evaluate");
  session.close();
  await assert.rejects(command, { code: "CDP_CLOSED" });
  await assert.rejects(session.send("Runtime.evaluate"), { code: "CDP_CLOSED" });
  assert.equal(session.pending.size, 0);
});

test("CDP HTTP requests reject redirects and normalize timeouts", async () => {
  let options;
  const redirecting = new CdpSession("http://127.0.0.1:9222", {
    fetchImpl: async (_url, receivedOptions) => {
      options = receivedOptions;
      return { status: 302, ok: false, type: "basic" };
    },
  });
  await assert.rejects(redirecting.connect(), { code: "CDP_REDIRECT" });
  assert.equal(options.redirect, "manual");

  const timingOut = new CdpSession("http://127.0.0.1:9222", {
    fetchImpl: async () => {
      throw Object.assign(new Error("expired"), { name: "TimeoutError" });
    },
  });
  await assert.rejects(timingOut.connect(), { code: "CDP_TIMEOUT" });

  const bodyTimingOut = new CdpSession("http://127.0.0.1:9222", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      type: "basic",
      async json() {
        throw Object.assign(new Error("expired"), { name: "AbortError" });
      },
    }),
  });
  await assert.rejects(bodyTimingOut.connect(), { code: "CDP_TIMEOUT" });
});

test("connect closes the websocket when Runtime.enable fails", async () => {
  class FailingWebSocket {
    static OPEN = 1;
    static instances = [];

    constructor() {
      this.readyState = 0;
      this.closeCalls = 0;
      FailingWebSocket.instances.push(this);
      queueMicrotask(() => {
        this.readyState = FailingWebSocket.OPEN;
        this.onopen?.();
      });
    }

    send(payload) {
      const message = JSON.parse(payload);
      queueMicrotask(() => this.onmessage?.({
        data: JSON.stringify({ id: message.id, error: { message: "denied" } }),
      }));
    }

    close() {
      this.closeCalls += 1;
      this.readyState = 3;
    }
  }

  const session = new CdpSession("http://127.0.0.1:9222", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      type: "basic",
      async json() {
        return [{
          id: "target",
          type: "page",
          url: "https://xueqiu.com/7143769715",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/target",
        }];
      },
    }),
    WebSocketImpl: FailingWebSocket,
  });
  await assert.rejects(session.connect(), { code: "CDP_COMMAND_ERROR" });
  assert.equal(FailingWebSocket.instances[0].closeCalls, 1);
  assert.equal(session.pending.size, 0);
});

test("connect closes a websocket that never reaches OPEN", async () => {
  class NeverOpenWebSocket {
    static OPEN = 1;
    static instances = [];

    constructor() {
      this.readyState = 0;
      this.closeCalls = 0;
      NeverOpenWebSocket.instances.push(this);
    }

    close() {
      this.closeCalls += 1;
      this.readyState = 3;
    }
  }
  const session = new CdpSession("http://127.0.0.1:9222", {
    commandTimeoutMs: 5,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      type: "basic",
      async json() {
        return [{
          id: "target",
          type: "page",
          url: "https://xueqiu.com/7143769715",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/target",
        }];
      },
    }),
    WebSocketImpl: NeverOpenWebSocket,
  });
  await assert.rejects(session.connect(), { code: "CDP_TIMEOUT" });
  assert.equal(NeverOpenWebSocket.instances[0].closeCalls, 1);
});

test("malformed websocket frames reject pending commands without escaping the handler", async () => {
  class ControlledWebSocket {
    static OPEN = 1;

    constructor() {
      this.readyState = 0;
      this.closeCalls = 0;
      queueMicrotask(() => {
        this.readyState = ControlledWebSocket.OPEN;
        this.onopen?.();
      });
    }

    send(payload) {
      const message = JSON.parse(payload);
      if (message.method === "Runtime.enable") {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result: {} }) }));
      }
    }

    close() {
      this.closeCalls += 1;
      this.readyState = 3;
    }
  }

  const session = new CdpSession("http://127.0.0.1:9222", {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      type: "basic",
      async json() {
        return [{
          id: "target",
          type: "page",
          url: "https://xueqiu.com/7143769715",
          webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/target",
        }];
      },
    }),
    WebSocketImpl: ControlledWebSocket,
  });
  await session.connect();
  const command = session.send("Runtime.evaluate");
  assert.doesNotThrow(() => session.ws.onmessage({ data: "{" }));
  await assert.rejects(command, { code: "CDP_PROTOCOL_ERROR" });
  assert.equal(session.pending.size, 0);
  assert.equal(session.ws.closeCalls, 1);
  session.close();
});
