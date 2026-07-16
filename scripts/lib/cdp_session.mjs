export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLoopbackHostname(hostname) {
  return hostname === "localhost"
    || hostname === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

export function validateLoopbackEndpoint(value, protocols = ["http:", "https:"]) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch (error) {
    throw Object.assign(new Error(`Invalid CDP endpoint: ${value}`), { code: "INVALID_CDP_ENDPOINT", cause: error });
  }
  if (!protocols.includes(endpoint.protocol) || !isLoopbackHostname(endpoint.hostname) || endpoint.username || endpoint.password) {
    throw Object.assign(new Error("CDP endpoint must use a loopback-only URL without credentials."), {
      code: "NON_LOOPBACK_CDP_ENDPOINT",
    });
  }
  return endpoint;
}

function cdpError(message, code, cause) {
  return Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
}

function isTimeoutError(error) {
  return error?.name === "AbortError"
    || error?.name === "TimeoutError"
    || error?.code === "ABORT_ERR";
}

function isXueqiuPage(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "xueqiu.com" || hostname.endsWith(".xueqiu.com");
  } catch {
    return false;
  }
}

export class CdpSession {
  constructor(base, {
    commandTimeoutMs = 15000,
    requireXueqiuTab = true,
    fetchImpl = globalThis.fetch,
    WebSocketImpl = globalThis.WebSocket,
  } = {}) {
    const endpoint = validateLoopbackEndpoint(base);
    this.base = endpoint.origin;
    this.commandTimeoutMs = commandTimeoutMs;
    this.requireXueqiuTab = requireXueqiuTab;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.nextId = 0;
    this.pending = new Map();
  }

  async fetchCdpEndpoint(url, label) {
    let response;
    try {
      response = await this.fetchImpl(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(this.commandTimeoutMs),
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw cdpError(`${label} timed out`, "CDP_TIMEOUT", error);
      }
      throw cdpError(`${label} request failed: ${error?.message || error}`, "CDP_REQUEST_FAILED", error);
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      throw cdpError(`${label} refused an HTTP redirect`, "CDP_REDIRECT");
    }
    return response;
  }

  async connect() {
    const response = await this.fetchCdpEndpoint(`${this.base}/json/list`, "CDP discovery");
    if (!response.ok) {
      throw cdpError(`CDP discovery failed with HTTP ${response.status}`, "CDP_DISCOVERY_FAILED");
    }
    let tabs;
    try {
      tabs = await response.json();
    } catch (error) {
      if (isTimeoutError(error)) {
        throw cdpError("CDP discovery timed out", "CDP_TIMEOUT", error);
      }
      throw cdpError("CDP discovery returned invalid JSON.", "CDP_DISCOVERY_FAILED", error);
    }
    if (!Array.isArray(tabs)) {
      throw cdpError("CDP discovery returned an unexpected payload.", "CDP_DISCOVERY_FAILED");
    }
    const xueqiuTab = tabs.find(
      (item) => isXueqiuPage(item.url) && ["page", "other"].includes(item.type || "page"),
    );
    const tab = xueqiuTab || (!this.requireXueqiuTab ? tabs.find((item) => item.webSocketDebuggerUrl) : null);
    if (!tab?.webSocketDebuggerUrl) {
      throw cdpError("No Xueqiu tab with a DevTools websocket is open.", "NO_XUEQIU_TAB");
    }

    this.targetId = tab.id;
    const websocketEndpoint = validateLoopbackEndpoint(tab.webSocketDebuggerUrl, ["ws:", "wss:"]);
    if (typeof this.WebSocketImpl !== "function") {
      throw cdpError("WebSocket is not available in this runtime.", "CDP_WEBSOCKET_ERROR");
    }
    this.ws = new this.WebSocketImpl(websocketEndpoint.href);
    try {
      const rejectProtocol = (message) => {
        this.rejectPending(message, "CDP_PROTOCOL_ERROR");
        try { this.ws.close(); } catch {}
      };
      this.ws.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (error) {
          rejectProtocol(`Invalid CDP websocket frame: ${error.message}`);
          return;
        }
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          rejectProtocol("Invalid CDP websocket frame shape");
          return;
        }
        if (Object.hasOwn(message, "id")
          && (!Number.isSafeInteger(message.id)
            || (!Object.hasOwn(message, "result") && !Object.hasOwn(message, "error")))) {
          rejectProtocol("Invalid CDP command response frame");
          return;
        }
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) {
          pending.reject(Object.assign(new Error(JSON.stringify(message.error)), { code: "CDP_COMMAND_ERROR" }));
        } else {
          pending.resolve(message.result);
        }
      };
      await new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        };
        timer = setTimeout(() => {
          fail(cdpError("CDP websocket open timeout", "CDP_TIMEOUT"));
        }, this.commandTimeoutMs);
        this.ws.onclose = () => {
          this.rejectPending("CDP websocket closed", "CDP_CLOSED");
          fail(cdpError("CDP websocket closed before opening", "CDP_CLOSED"));
        };
        this.ws.onopen = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        this.ws.onerror = (error) => {
          if (settled) {
            this.rejectPending("CDP websocket error", "CDP_WEBSOCKET_ERROR");
            return;
          }
          fail(cdpError(error?.message || "CDP websocket error", "CDP_WEBSOCKET_ERROR"));
        };
      });
      await this.send("Runtime.enable");
    } catch (error) {
      this.close();
      throw error;
    }
  }

  send(method, params = {}, timeoutMs = this.commandTimeoutMs) {
    const openState = this.WebSocketImpl?.OPEN ?? 1;
    if (!this.ws || this.ws.readyState !== openState) {
      return Promise.reject(Object.assign(new Error("CDP websocket is not open"), { code: "CDP_CLOSED" }));
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`CDP timeout: ${method}`), { code: "CDP_TIMEOUT" }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async enablePage() {
    await this.send("Page.enable");
  }

  async activate() {
    if (!this.targetId) return;
    const targetId = encodeURIComponent(this.targetId);
    const response = await this.fetchCdpEndpoint(`${this.base}/json/activate/${targetId}`, "CDP activation");
    if (!response.ok) {
      throw cdpError(`Unable to activate CDP target: HTTP ${response.status}`, "CDP_ACTIVATION_FAILED");
    }
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
    await this.activate();
    await sleep(1200);
  }

  rejectPending(message, code) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error(message), { code }));
    }
    this.pending.clear();
  }

  close() {
    this.rejectPending("CDP session closed", "CDP_CLOSED");
    const websocket = this.ws;
    this.ws = undefined;
    this.targetId = undefined;
    try {
      websocket?.close();
    } catch {
      // Closing is best effort; pending commands were already rejected above.
    }
  }
}
