import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DRAGON_BOAT_CONTRACT_VERSION,
  DragonBoatApiClient,
  DragonBoatApiError,
  normalizeApiUrl
} from "../frontend/lib/api-client.js";

function jsonResponse(body, options = {}) {
  return {
    ok: options.ok ?? true,
    async text() {
      return JSON.stringify(body);
    }
  };
}

function successEnvelope(requestId = "request_123") {
  return {
    ok: true,
    data: { status: "available", service_version: "0.1.0-p0" },
    meta: {
      contract_version: DRAGON_BOAT_CONTRACT_VERSION,
      server_time: "2026-08-31T12:00:00.000Z",
      request_id: requestId
    }
  };
}

test("frontend and published contract versions stay aligned", async () => {
  const contract = JSON.parse(await readFile(
    new URL("../contracts/api-v1.json", import.meta.url),
    "utf8"
  ));
  assert.equal(DRAGON_BOAT_CONTRACT_VERSION, contract.contract_version);
});

test("GET follows redirects, disables caching and protects reserved query fields", async () => {
  let captured;
  const client = new DragonBoatApiClient({
    baseUrl: "https://script.google.com/macros/s/example/exec",
    fetchImpl: async (url, init) => {
      captured = { url: String(url), init };
      return jsonResponse(successEnvelope("fixed_request"));
    }
  });

  const result = await client.get(
    "health",
    { season_id: "season_1", action: "override", request_id: "override" },
    { requestId: "fixed_request" }
  );

  const requestUrl = new URL(captured.url);
  assert.equal(requestUrl.searchParams.get("action"), "health");
  assert.equal(requestUrl.searchParams.get("request_id"), "fixed_request");
  assert.equal(requestUrl.searchParams.get("season_id"), "season_1");
  assert.equal(captured.init.redirect, "follow");
  assert.equal(captured.init.cache, "no-store");
  assert.equal(captured.init.credentials, "omit");
  assert.equal(result.data.status, "available");
});

test("default browser fetch keeps the required global receiver", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async function () {
    assert.equal(this, globalThis);
    return jsonResponse(successEnvelope("browser_receiver"));
  };

  try {
    const client = new DragonBoatApiClient({
      baseUrl: "https://script.google.com/macros/s/example/exec"
    });
    const result = await client.get("health", {}, { requestId: "browser_receiver" });
    assert.equal(result.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST uses a simple text content type and keeps the supplied request ID", async () => {
  let captured;
  const client = new DragonBoatApiClient({
    baseUrl: "https://script.google.com/macros/s/example/exec",
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return jsonResponse(successEnvelope("same_request"));
    }
  });

  await client.post(
    "coachBootstrap",
    { action: "override", value: 1, session_token: "private-session-token" },
    { requestId: "same_request" }
  );
  const body = JSON.parse(captured.init.body);
  assert.equal(captured.init.headers["Content-Type"], "text/plain;charset=UTF-8");
  assert.equal(body.action, "coachBootstrap");
  assert.equal(body.request_id, "same_request");
  assert.equal(body.value, 1);
  assert.equal(body.session_token, "private-session-token");
  assert.equal(String(captured.url).includes("private-session-token"), false);
});

test("client rejects a mismatched contract before using response data", async () => {
  const envelope = successEnvelope();
  envelope.meta.contract_version = "old-contract";
  const client = new DragonBoatApiClient({
    baseUrl: "https://example.test/exec",
    fetchImpl: async () => jsonResponse(envelope)
  });

  await assert.rejects(() => client.get("health"), (error) => {
    assert.ok(error instanceof DragonBoatApiError);
    assert.equal(error.code, "CONTRACT_MISMATCH");
    return true;
  });
});

test("client preserves a safe server error and retryability", async () => {
  const client = new DragonBoatApiClient({
    baseUrl: "https://example.test/exec",
    fetchImpl: async () => jsonResponse({
      ok: false,
      error: { code: "TEMPORARY_FAILURE", message: "Try again.", retryable: true },
      meta: {
        contract_version: DRAGON_BOAT_CONTRACT_VERSION,
        server_time: "2026-08-31T12:00:00.000Z",
        request_id: "request_123"
      }
    })
  });

  await assert.rejects(() => client.get("health"), (error) => {
    assert.equal(error.code, "TEMPORARY_FAILURE");
    assert.equal(error.retryable, true);
    assert.equal(error.requestId, "request_123");
    return true;
  });
});

test("API URL requires HTTPS except for local development", () => {
  assert.equal(normalizeApiUrl("http://localhost:3000/api"), "http://localhost:3000/api");
  assert.throws(() => normalizeApiUrl("http://example.com/api"), (error) => {
    assert.equal(error.code, "INVALID_API_URL");
    return true;
  });
  assert.throws(() => normalizeApiUrl(""), (error) => {
    assert.equal(error.code, "API_NOT_CONFIGURED");
    return true;
  });
});
