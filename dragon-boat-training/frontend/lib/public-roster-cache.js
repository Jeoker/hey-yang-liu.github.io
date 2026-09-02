export const DRAGON_BOAT_ROSTER_CACHE_PREFIX = "dragon_boat_public_roster_v1";

export function rosterCacheKey(season) {
  return [
    DRAGON_BOAT_ROSTER_CACHE_PREFIX,
    season.season_id,
    Number(season.binding_version || 0),
    Number(season.roster_version || 0)
  ].join(":");
}

export function loadRosterSnapshot(season, storage = globalThis.localStorage, now = Date.now()) {
  if (!storage || !season?.season_id) return null;
  const key = rosterCacheKey(season);
  let snapshot;
  try {
    snapshot = JSON.parse(storage.getItem(key) || "null");
  } catch {
    storage.removeItem(key);
    return null;
  }
  if (
    !snapshot ||
    snapshot.season_id !== season.season_id ||
    Number(snapshot.binding_version) !== Number(season.binding_version) ||
    Number(snapshot.roster_version) !== Number(season.roster_version) ||
    !Number.isFinite(Date.parse(snapshot.expires_at)) ||
    Date.parse(snapshot.expires_at) <= now ||
    !Array.isArray(snapshot.members)
  ) {
    storage.removeItem(key);
    return null;
  }
  return snapshot;
}

export function saveRosterSnapshot(snapshot, storage = globalThis.localStorage) {
  if (!storage || !snapshot?.season_id || !Array.isArray(snapshot.members)) return;
  storage.setItem(rosterCacheKey(snapshot), JSON.stringify(snapshot));
}
