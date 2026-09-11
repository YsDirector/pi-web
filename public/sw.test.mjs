import assert from "node:assert/strict";
import test from "node:test";

const listeners = new Map();
globalThis.self = {
  location: {
    href: "https://pi.test/sw.js?v=test",
    origin: "https://pi.test",
  },
  addEventListener: (type, listener) => listeners.set(type, listener),
  clients: null,
};

await import("./sw.js");

function dispatchNotificationClick(data) {
  let pending;
  let closed = false;
  listeners.get("notificationclick")({
    notification: {
      data,
      close: () => { closed = true; },
    },
    waitUntil: (promise) => { pending = promise; },
  });
  return { pending, wasClosed: () => closed };
}

function dispatchPush(payload, clients) {
  let pending;
  const shown = [];
  self.clients = {
    matchAll: async () => clients,
    openWindow: async () => assert.fail("push must not open windows"),
  };
  self.registration = {
    showNotification: async (title, options) => { shown.push({ title, options }); },
  };
  listeners.get("push")({
    data: { json: () => payload },
    waitUntil: (promise) => { pending = promise; },
  });
  return { pending, shown };
}

test("push always shows a notification, even when a window is visible", async () => {
  const event = dispatchPush(
    {
      title: "Session complete",
      body: "Task finished.",
      url: "/?session=session-1",
      tag: "pi-session-complete:session-1",
    },
    [
      { url: "https://pi.test/?session=other", visibilityState: "hidden" },
      { url: "https://pi.test/?session=session-1", visibilityState: "visible" },
    ],
  );
  await event.pending;

  // iOS revokes the push subscription when a push is handled without a
  // notification, so the notification must never be suppressed.
  assert.deepEqual(event.shown, [{
    title: "Session complete",
    options: {
      body: "Task finished.",
      data: { url: "/?session=session-1" },
      tag: "pi-session-complete:session-1",
      renotify: true,
    },
  }]);
});

test("push ignores malformed payloads", async () => {
  const event = dispatchPush(
    { title: "", body: 42 },
    [],
  );
  await event.pending;

  assert.deepEqual(event.shown, []);
});

test("notification click focuses an existing client at the session URL", async () => {
  const calls = [];
  const focusedClient = {
    url: "https://pi.test/?session=session-1",
    focus: async () => { calls.push("focus"); },
    navigate: async () => assert.fail("exact client should not navigate"),
  };
  self.clients = {
    matchAll: async () => [focusedClient],
    openWindow: async () => assert.fail("existing client should be reused"),
  };

  const event = dispatchNotificationClick({ url: "/?session=session-1" });
  await event.pending;

  assert.equal(event.wasClosed(), true);
  assert.deepEqual(calls, ["focus"]);
});

test("notification click navigates an existing client to the session", async () => {
  const calls = [];
  const navigatedClient = {
    focus: async () => { calls.push("focus"); },
  };
  const existingClient = {
    url: "https://pi.test/?session=other-session",
    navigate: async (url) => {
      calls.push(["navigate", url]);
      return navigatedClient;
    },
    focus: async () => assert.fail("the navigated client should be focused"),
  };
  self.clients = {
    matchAll: async () => [existingClient],
    openWindow: async () => assert.fail("existing client should be reused"),
  };

  const event = dispatchNotificationClick({ url: "/?session=session-1" });
  await event.pending;

  assert.deepEqual(calls, [
    ["navigate", "https://pi.test/?session=session-1"],
    "focus",
  ]);
});

test("notification click opens a window and rejects cross-origin targets", async () => {
  const opened = [];
  self.clients = {
    matchAll: async () => [],
    openWindow: async (url) => { opened.push(url); },
  };

  const event = dispatchNotificationClick({ url: "https://example.com/redirect" });
  await event.pending;

  assert.deepEqual(opened, ["https://pi.test/"]);
});

// ---------------------------------------------------------------------------
// Offline shell and session data
// ---------------------------------------------------------------------------

// Minimal Cache API stub: enough to exercise the fetch strategies.
function installCacheStub({ failNetwork = false, redirects = {} } = {}) {
  const stores = new Map();
  const fetches = [];

  const openStore = (name) => {
    if (!stores.has(name)) {
      const entries = new Map();
      stores.set(name, {
        entries,
        put: async (request, response) => { entries.set(request.url, response); },
        match: async (request, options) => {
          const key = typeof request === "string" ? request : request.url;
          if (options?.ignoreSearch) {
            const bare = key.split("?")[0];
            for (const [url, response] of entries) {
              if (url.split("?")[0] === bare) return response;
            }
            return undefined;
          }
          return entries.get(key);
        },
        keys: async () => [...entries.keys()].map((url) => ({ url })),
        delete: async (key) => entries.delete(typeof key === "string" ? key : key.url),
      });
    }
    return stores.get(name);
  };

  globalThis.caches = {
    open: async (name) => openStore(name),
    match: async (request) => {
      for (const store of stores.values()) {
        const found = await store.match(request);
        if (found) return found;
      }
      return undefined;
    },
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    _stores: stores,
  };

  globalThis.fetch = async (request, init) => {
    const url = typeof request === "string" ? request : request.url;
    fetches.push(url);
    if (failNetwork || init?.signal?.aborted) throw new TypeError("network failure");
    // A real fetch sets Response.url to the final URL after redirects. Tests
    // override this to simulate a redirect to the login page.
    const response = redirects[url]
      ? new Response("<html>login</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
      : new Response(JSON.stringify({ sessions: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    Object.defineProperty(response, "url", { value: redirects[url] ?? url });
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  };

  return { stores, fetches, openStore };
}

function dispatchFetch(url, { mode = "cors", method = "GET" } = {}) {
  let pending;
  const request = new Request(url, { method });
  Object.defineProperty(request, "mode", { value: mode });
  listeners.get("fetch")({
    request,
    respondWith: (promise) => { pending = promise; },
  });
  return pending;
}

test("navigation serves the cached shell when the network is unreachable", async () => {
  installCacheStub();
  const shellCache = globalThis.caches._stores;
  void shellCache;

  // First load: online, caches the shell document.
  globalThis.fetch = async (request) => {
    const response = new Response("<!doctype html><title>Pi Web</title>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
    Object.defineProperty(response, "url", {
      value: typeof request === "string" ? request : request.url,
    });
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  };
  const online = await dispatchFetch("https://pi.test/", { mode: "navigate" });
  assert.match(await online.text(), /<title>Pi Web<\/title>/);

  // Give the fire-and-forget put a tick to land.
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Second load: offline. The cached shell must be replayed, not offline.html.
  globalThis.fetch = async () => { throw new TypeError("offline"); };
  const offline = await dispatchFetch("https://pi.test/", { mode: "navigate" });
  const offlineBody = await offline.text();
  assert.match(offlineBody, /<title>Pi Web<\/title>/, "the cached shell must be replayed");
  assert.doesNotMatch(offlineBody, /is offline/, "the offline placeholder must not be used");
});

test("session list is served from cache when offline", async () => {
  installCacheStub();
  globalThis.fetch = async (request) => {
    const response = new Response('{"sessions":[{"id":"s1"}]}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    Object.defineProperty(response, "url", {
      value: typeof request === "string" ? request : request.url,
    });
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  };
  const online = await dispatchFetch("https://pi.test/api/sessions");
  assert.match(await online.text(), /s1/);
  await new Promise((resolve) => setTimeout(resolve, 0));

  globalThis.fetch = async () => { throw new TypeError("offline"); };
  const offline = await dispatchFetch("https://pi.test/api/sessions");
  assert.match(await offline.text(), /s1/);
});

test("agent streams are never cached", async () => {
  const { fetches } = installCacheStub();
  const pending = dispatchFetch("https://pi.test/api/agent/abc/events");
  // No respondWith: the service worker must leave live traffic untouched.
  assert.equal(pending, undefined);
  assert.deepEqual(fetches, [], "the worker must not intercept the SSE stream");
});

test("a redirect response is not stored under the requested URL", async () => {
  const { openStore } = installCacheStub();
  // Simulate a web-auth redirect: fetch follows it and yields the login page.
  globalThis.fetch = async () => {
    const response = new Response("<html>login</html>", {
      status: 200,
      headers: { "Content-Type": "text/html" },
    });
    Object.defineProperty(response, "url", { value: "https://pi.test/login" });
    return response;
  };
  await dispatchFetch("https://pi.test/api/sessions");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const data = await openStore("pi-web-data-test");
  assert.equal(data.entries.size, 0, "login HTML must not be cached as session data");
});
