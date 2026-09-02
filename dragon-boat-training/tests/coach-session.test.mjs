import assert from "node:assert/strict";
import test from "node:test";

import {
  COACH_SESSION_STORAGE_KEY,
  clearCoachSession,
  isCoachSessionError,
  loadCoachSession,
  saveCoachSession
} from "../frontend/lib/coach-session.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    values
  };
}

test("Coach sessions use session storage and expire locally", () => {
  const storage = memoryStorage();
  saveCoachSession("signed-token", { expires_at: "2026-08-31T12:00:00.000Z" }, storage);
  assert.equal(storage.values.has(COACH_SESSION_STORAGE_KEY), true);
  assert.deepEqual(
    loadCoachSession(storage, Date.parse("2026-08-31T11:00:00.000Z")),
    { token: "signed-token", expires_at: "2026-08-31T12:00:00.000Z" }
  );
  assert.equal(loadCoachSession(storage, Date.parse("2026-08-31T12:00:00.000Z")), null);
  assert.equal(storage.values.has(COACH_SESSION_STORAGE_KEY), false);
});

test("malformed sessions are removed and logout clears protected state", () => {
  const storage = memoryStorage();
  storage.setItem(COACH_SESSION_STORAGE_KEY, "{");
  assert.equal(loadCoachSession(storage), null);
  saveCoachSession("signed-token", { expires_at: "2099-01-01T00:00:00.000Z" }, storage);
  clearCoachSession(storage);
  assert.equal(storage.values.size, 0);
});

test("session error classification excludes ordinary request failures", () => {
  assert.equal(isCoachSessionError({ code: "SESSION_EXPIRED" }), true);
  assert.equal(isCoachSessionError({ code: "SESSION_REVOKED" }), true);
  assert.equal(isCoachSessionError({ code: "NETWORK_ERROR" }), false);
});
