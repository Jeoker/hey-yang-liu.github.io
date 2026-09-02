const COACH_SESSION_STORAGE_KEY = "dragon_boat_coach_session_v1";

export function saveCoachSession(sessionToken, session, storage = globalThis.sessionStorage) {
  if (!storage || typeof sessionToken !== "string" || !sessionToken) {
    throw new TypeError("A session token and browser session storage are required.");
  }
  const value = {
    token: sessionToken,
    expires_at: session?.expires_at || ""
  };
  storage.setItem(COACH_SESSION_STORAGE_KEY, JSON.stringify(value));
}

export function loadCoachSession(storage = globalThis.sessionStorage, now = Date.now()) {
  if (!storage) return null;
  const raw = storage.getItem(COACH_SESSION_STORAGE_KEY);
  if (!raw) return null;

  try {
    const value = JSON.parse(raw);
    const expiresAt = Date.parse(value?.expires_at);
    if (typeof value?.token !== "string" || !value.token || !Number.isFinite(expiresAt) || expiresAt <= now) {
      storage.removeItem(COACH_SESSION_STORAGE_KEY);
      return null;
    }
    return { token: value.token, expires_at: value.expires_at };
  } catch {
    storage.removeItem(COACH_SESSION_STORAGE_KEY);
    return null;
  }
}

export function clearCoachSession(storage = globalThis.sessionStorage) {
  storage?.removeItem(COACH_SESSION_STORAGE_KEY);
}

export function isCoachSessionError(error) {
  return ["SESSION_INVALID", "SESSION_EXPIRED", "SESSION_REVOKED"].includes(error?.code);
}

export { COACH_SESSION_STORAGE_KEY };
