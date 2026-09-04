// Shared response checks. Versions belong to a specific season and practice;
// server-generated snapshots may arrive in a different order than requests.
export function validPracticeView(view, seasonId, practiceId) {
  return Boolean(view && view.season_id === seasonId && view.practice?.practice_id === practiceId
    && [view.signup_version, view.practice.practice_version, view.roster_version, view.binding_version]
      .every(value => Number.isInteger(value) && value >= 0)
    && Array.isArray(view.signups) && view.counts && typeof view.signup_open === "boolean"
    && validSeatPlanView(view.seat_plan));
}

export function olderPracticeView(next, current) {
  if (!current || current.season_id !== next.season_id || current.practice?.practice_id !== next.practice?.practice_id) return false;
  if (next.signup_version < current.signup_version || next.practice.practice_version < current.practice.practice_version
      || next.roster_version < current.roster_version || next.binding_version < current.binding_version) return true;
  if (current.seat_plan && !next.seat_plan) return true;
  if (current.seat_plan && next.seat_plan
      && (next.seat_plan.seat_plan_version < current.seat_plan.seat_plan_version
        || next.seat_plan.published_revision < current.seat_plan.published_revision)) return true;
  const nextTime = Date.parse(next.generated_at), currentTime = Date.parse(current.generated_at);
  return Number.isFinite(nextTime) && Number.isFinite(currentTime) && nextTime < currentTime;
}

export function validSeatPlanView(seatPlan) {
  if (seatPlan === undefined || seatPlan === null) return true;
  return Boolean(typeof seatPlan === "object" && typeof seatPlan.status === "string"
    && Number.isInteger(seatPlan.seat_plan_version) && seatPlan.seat_plan_version >= 0
    && Number.isInteger(seatPlan.published_revision) && seatPlan.published_revision >= 0
    && Array.isArray(seatPlan.rows));
}

export function usableRoster(snapshot, season, now = Date.now()) {
  return Boolean(snapshot && snapshot.season_id === season.season_id
    && snapshot.roster_version === season.roster_version && snapshot.binding_version === season.binding_version
    && Array.isArray(snapshot.members) && Date.parse(snapshot.expires_at) > now);
}
