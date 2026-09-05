// Business plans are persisted before the first write. The historical function
// name remains because deployed signup request scopes intentionally stay P2.
function recoverP2Requests_() {
  var id = getScriptProperties_().getProperty(DRAGON_BOAT_PROPERTY_KEYS_.SYSTEM_SPREADSHEET_ID);
  if (!id) return;
  var spreadsheet = getSystemSpreadsheet_();
  if (!spreadsheet.getSheetByName("SystemRequests")) return;
  getSheetRecords_("SystemRequests").filter(function (record) {
    var actor = String(record.actor_id);
    return String(record.status) === "STARTED" &&
      (actor.indexOf("P2:") === 0 || actor.indexOf("P3:") === 0 || actor.indexOf("P3_FREEZE:") === 0 || actor.indexOf("P1M:") === 0);
  }).forEach(function (record) {
    var saved = readSystemRequestResult_(record);
    if (saved.kind === "P1_MANAGEMENT") applyScheduleRequest_(record);
    else if (saved.kind === "P2") applyP2Request_(record);
    else if (saved.kind === "P3") applyP3Request_(record);
    else throw dragonBoatRequestError_("RECOVERY_REQUIRED", "A pending business change needs recovery.", true);
  });
}

function persistP2Request_(actorId, request, digest, plan, result) {
  var saved = { kind: "P2", season_id: plan.season_id, plan: plan, result: result };
  // A Sheets cell has a finite size. Never begin a plan that cannot be journaled.
  if (JSON.stringify(saved).length > 45000) {
    throw dragonBoatRequestError_("REQUEST_TOO_LARGE", "This change is too large to save safely.");
  }
  var transaction = beginSystemRequest_(actorId, request.action, request.request_id, digest, saved);
  SpreadsheetApp.flush();
  return applyP2Request_(transaction.record);
}

function applyP2Request_(record) {
  var saved = readSystemRequestResult_(record);
  if (saved.kind !== "P2" || !saved.plan || !saved.result) {
    throw dragonBoatRequestError_("RECOVERY_REQUIRED", "The previous change needs recovery.", true);
  }
  if (String(record.status) === "COMPLETED") return saved.result;
  var plan = saved.plan;
  var season = requireSeason_(saved.season_id);
  (plan.signups || []).forEach(function (row) {
    var previous = getPracticeSignups_(season, row.practice_id).filter(function (candidate) {
      return String(candidate.member_id) === String(row.member_id);
    })[0];
    var update = Object.assign({}, row);
    if (previous) {
      update._rowNumber = previous._rowNumber;
      updateSeasonSheetRecord_(season, "SignupsCurrent", update);
    } else {
      appendSeasonSheetRecord_(season, "SignupsCurrent", update);
    }
  });
  if (plan.signup_state) {
    var setting = findSeasonSheetRecord_(season, "Settings", "setting_key", "signup:" + plan.practice_id);
    var stateRow = {
      setting_key: "signup:" + plan.practice_id,
      setting_value: JSON.stringify(plan.signup_state), updated_at: plan.at
    };
    if (setting) {
      stateRow._rowNumber = setting._rowNumber;
      updateSeasonSheetRecord_(season, "Settings", stateRow);
    } else appendSeasonSheetRecord_(season, "Settings", stateRow);
  }
  if (plan.member) {
    var member = requireSeasonMember_(season, plan.member.member_id);
    Object.keys(plan.member).forEach(function (key) { member[key] = plan.member[key]; });
    updateSeasonSheetRecord_(season, "Members", member);
    // Re-read and patch only our fields; do not restore an old season/config row.
    season = requireSeason_(saved.season_id);
    season.roster_version = Math.max(Number(season.roster_version || 0), plan.roster_version);
    season.updated_at = plan.at;
    updateSheetRecord_("Seasons", season);
  }
  applyP3SeatingPlanParts_(record, season, plan.seating);
  var eventId = deterministicEventId_(record, "P2_COMMITTED");
  if (!findSeasonSheetRecord_(season, "AuditLog", "event_id", eventId)) {
    appendSeasonSheetRecord_(season, "AuditLog", {
      event_id: eventId, request_id: record.request_id, server_time: plan.at,
      season_id: season.season_id, entity_type: plan.member ? "MEMBER" : "PRACTICE",
      entity_id: plan.member ? plan.member.member_id : plan.practice_id,
      actor_type: plan.actor_type, actor_id: plan.actor_id,
      action: record.action, status: "SUCCEEDED",
      details_json: JSON.stringify({ before: plan.before, after: plan.member || plan.signups,
        signup_state: plan.signup_state, promoted_member_ids: saved.result.promoted_member_ids || [],
        seating_revision: plan.seating && plan.seating.revision ? plan.seating.revision.revision_number : null })
    });
  }
  SpreadsheetApp.flush();
  completeSystemRequest_(record);
  SpreadsheetApp.flush();
  return saved.result;
}

function requireSeasonMember_(season, memberId) {
  var member = findSeasonSheetRecord_(season, "Members", "member_id", memberId);
  if (!member || String(member.season_id) !== String(season.season_id)) {
    throw dragonBoatRequestError_("MEMBER_NOT_FOUND", "The member does not belong to this season.");
  }
  return member;
}

function requirePublicPractice_(season, practiceId) {
  if (seasonEffectiveStatus_(season) === "DRAFT") {
    throw dragonBoatRequestError_("SEASON_NOT_PUBLIC", "The requested season is not public.");
  }
  var practice = findSeasonSheetRecord_(season, "Practices", "practice_id", practiceId);
  var week = practice && findSeasonSheetRecord_(season, "TrainingWeeks", "week_id", practice.week_id);
  if (!practice || String(practice.season_id) !== String(season.season_id) || !week ||
      String(week.season_id) !== String(season.season_id) || String(week.status) !== "OPENED" ||
      !week.published_at || !practice.schedule_published_at ||
      Date.parse(String(week.published_at)) > Date.now() ||
      Date.parse(String(practice.schedule_published_at)) > Date.now()) {
    throw dragonBoatRequestError_("PRACTICE_NOT_PUBLIC", "The training is not published in this season.");
  }
  return practice;
}

function signupClosedReason_(season, practice, management) {
  if (seasonEffectiveStatus_(season) !== "OPEN") return "SEASON_NOT_OPEN";
  if (practice.cancelled_at) return "PRACTICE_CANCELLED";
  if (Date.now() >= Date.parse(String(practice.end_at))) return "PRACTICE_ENDED";
  if (!management && Date.now() >= Date.parse(String(practice.signup_cutoff_at))) return "SIGNUP_CLOSED";
  return "";
}

function getPracticeSignups_(season, practiceId) {
  return getSeasonSheetRecords_(season, "SignupsCurrent").filter(function (row) {
    return String(row.season_id) === String(season.season_id) && String(row.practice_id) === String(practiceId);
  });
}

function getSignupState_(season, practiceId) {
  var row = findSeasonSheetRecord_(season, "Settings", "setting_key", "signup:" + practiceId);
  if (!row) return { version: 0, sequence: 0 };
  var parsed = parseJsonObject_(row.setting_value);
  if (!Number.isInteger(parsed.version) || !Number.isInteger(parsed.sequence)) {
    throw dragonBoatRequestError_("RECOVERY_REQUIRED", "The training signup state is invalid.", true);
  }
  return parsed;
}

function compareSignupQueue_(left, right) {
  return String(left.queue_at).localeCompare(String(right.queue_at)) || Number(left.queue_sequence) - Number(right.queue_sequence);
}

function signupProjection_(row) {
  return {
    member_id: String(row.member_id), preference: String(row.preference), status: String(row.status),
    queue_at: String(row.queue_at), queue_sequence: Number(row.queue_sequence)
  };
}

function signupCounts_(rows, practice) {
  var result = { confirmed: 0, waitlisted: 0, left: 0, ambient: 0, right: 0,
    left_capacity: Number(practice.left_capacity), right_capacity: Number(practice.right_capacity),
    total_capacity: Number(practice.left_capacity) + Number(practice.right_capacity) };
  rows.forEach(function (row) {
    if (row.status === "CONFIRMED") {
      result.confirmed += 1;
      result[String(row.preference).toLowerCase()] += 1;
    } else if (row.status === "WAITLISTED") result.waitlisted += 1;
  });
  return result;
}

function canConfirmSignup_(preference, counts, seatAvailability) {
  return counts.confirmed < counts.total_capacity &&
    (preference !== "LEFT" || counts.left < counts.left_capacity) &&
    (preference !== "RIGHT" || counts.right < counts.right_capacity) &&
    (!seatAvailability || seatAvailability.some(function (slot) {
      return !slot.claimed && seatMatchesSignupPreference_(slot.side, preference);
    }));
}

function publicPractice_(request) {
  return withDragonBoatScriptLock_(function () {
    var season = requireSeason_(request.season_id);
    var practice = requirePublicPractice_(season, request.practice_id);
    var state = getSignupState_(season, practice.practice_id);
    var rows = getPracticeSignups_(season, practice.practice_id).filter(function (row) {
      return row.status !== "CANCELLED";
    }).sort(compareSignupQueue_);
    var names = {};
    // Share the same roster snapshot. Never scan Form responses for practice reads.
    var roster = getPublicRosterSnapshot_(season, true);
    roster.members.forEach(function (member) { names[member.member_id] = member.display_name; });
    var waitlistPosition = 0;
    var seatPlan = publicSeatPlanProjection_(season, practice);
    return {
      season_id: String(season.season_id), generated_at: new Date().toISOString(), practice: practiceProjection_(practice),
      signup_version: state.version, roster_version: Number(season.roster_version),
      binding_version: Number(season.binding_version),
      season_status: seasonEffectiveStatus_(season), default_season_id: getOpenDefaultSeasonId_(),
      signup_open: !signupClosedReason_(season, practice, false),
      management_signup_open: !signupClosedReason_(season, practice, true),
      closed_reason: signupClosedReason_(season, practice, false),
      counts: signupCounts_(rows, practice),
      seat_plan: seatPlan,
      signups: rows.map(function (row) {
        var projected = signupProjection_(row);
        projected.display_name = names[row.member_id] || "已停用队员";
        projected.waitlist_position = row.status === "WAITLISTED" ? ++waitlistPosition : null;
        return projected;
      })
    };
  });
}

function requireSignupPreference_(value) {
  if (["LEFT", "AMBIENT", "RIGHT"].indexOf(value) < 0) {
    throw dragonBoatRequestError_("INVALID_PREFERENCE", "Choose Left, Ambient or Right.");
  }
  return value;
}

function enforcePublicSignupRateLimit_(seasonId, memberId) {
  var cache = CacheService.getScriptCache();
  var key = "signup_rate:" + seasonId + ":" + memberId + ":" + Math.floor(Date.now() / 60000);
  var count = Number(cache.get(key) || 0);
  if (count >= 12) throw dragonBoatRequestError_("SIGNUP_RATE_LIMITED", "Too many changes. Wait briefly and retry.", true);
  cache.put(key, String(count + 1), 70);
}

function mutateSignup_(request) {
  return withDragonBoatScriptLock_(function () {
    var management = /ByCoach$/.test(request.action);
    var authenticated = management ? validateCoachSession_(requireRequestString_(request, "session_token", 32, 2048)) : null;
    var season = requireSeason_(request.season_id);
    var memberId = requireRequestString_(request, "member_id", 8, 128);
    var practiceId = requireRequestString_(request, "practice_id", 8, 128);
    var cancel = /^cancel/.test(request.action);
    var create = request.action === "signup" || request.action === "signupByCoach";
    var preference = cancel ? "" : requireSignupPreference_(request.preference);
    var actorId = management ? String(authenticated.coach.coach_id) : memberId;
    var scope = "P2:" + season.season_id + ":" + (management ? "COACH:" : "PUBLIC:") + actorId;
    var digest = digestRequestPayload_({ season_id: season.season_id, practice_id: practiceId,
      member_id: memberId, preference: preference, practice_version: request.practice_version,
      signup_version: request.signup_version });
    var previous = findMatchingSystemRequest_(scope, request.action, request.request_id, digest);
    if (previous) return attachP21View_(request, applyP2Request_(previous), management);
    var practice = requirePublicPractice_(season, practiceId);
    var reason = signupClosedReason_(season, practice, management);
    if (reason) throw dragonBoatRequestError_(reason, "Signups cannot be changed at this time.");
    var member = requireSeasonMember_(season, memberId);
    if (member.status !== "ACTIVE" && !cancel) throw dragonBoatRequestError_("MEMBER_INACTIVE", "This member is inactive.");
    var state = getSignupState_(season, practiceId);
    requireVersion_(practice.practice_version, request.practice_version, "training");
    requireVersion_(state.version, request.signup_version, "signup list");
    var roleMembers = seatPlanRoleMemberIds_(season, practice);
    if (!cancel && roleMembers[memberId]) {
      throw dragonBoatRequestError_("ROLE_SIGNUP_CONFLICT", "A Coach or Steerer cannot also hold a training signup.");
    }
    if (!management) enforcePublicSignupRateLimit_(season.season_id, memberId);
    var rows = getPracticeSignups_(season, practiceId);
    var before = JSON.parse(JSON.stringify(rows));
    var target = rows.filter(function (row) { return String(row.member_id) === memberId; })[0];
    var active = target && target.status !== "CANCELLED";
    if (create && active) throw dragonBoatRequestError_("SIGNUP_EXISTS", "This member is already signed up. Modify the existing signup.");
    if (!create && !active) throw dragonBoatRequestError_("SIGNUP_NOT_ACTIVE", "This member has no active signup to change.");
    var now = new Date().toISOString();
    var noChange = !create && !cancel && target.preference === preference;
    if (!noChange) {
      if (create) {
        if (!target) {
          target = { season_id: String(season.season_id), practice_id: practiceId, member_id: memberId };
          rows.push(target);
        }
        state.sequence += 1;
        target.queue_at = now;
        target.queue_sequence = state.sequence;
      }
      target.status = cancel ? "CANCELLED" : "WAITLISTED";
      if (!cancel) target.preference = preference;
      target.updated_at = now;
      target.last_request_id = request.request_id;
      var eligible = {};
      getSeasonSheetRecords_(season, "Members").forEach(function (row) {
        eligible[row.member_id] = row.status === "ACTIVE" && !roleMembers[row.member_id];
      });
      var counts = signupCounts_(rows, practice);
      var seatAvailability = signupSeatAvailability_(season, practice, rows, memberId);
      rows.filter(function (row) { return row.status === "WAITLISTED"; }).sort(compareSignupQueue_).forEach(function (row) {
        if (eligible[row.member_id] && canConfirmSignup_(row.preference, counts, seatAvailability) &&
            claimSignupSeat_(seatAvailability, row.preference)) {
          row.status = "CONFIRMED";
          row.updated_at = now;
          row.last_request_id = request.request_id;
          counts.confirmed += 1;
          counts[String(row.preference).toLowerCase()] += 1;
        }
      });
      state.version += 1;
    }
    var beforeByMember = {};
    before.forEach(function (row) { beforeByMember[row.member_id] = row; });
    var changed = rows.filter(function (row) {
      return JSON.stringify(row) !== JSON.stringify(beforeByMember[row.member_id]);
    });
    var promoted = changed.filter(function (row) {
      return row.member_id !== memberId && row.status === "CONFIRMED" &&
        beforeByMember[row.member_id] && beforeByMember[row.member_id].status === "WAITLISTED";
    }).map(function (row) { return String(row.member_id); });
    var result = { season_id: String(season.season_id), practice_id: practiceId,
      signup_version: state.version, signup: signupProjection_(target), promoted_member_ids: promoted };
    var seating = noChange ? null : buildSignupSeatingTransition_(season, practice, request, scope,
      beforeByMember[memberId] || null, target, promoted, actorId, now);
    if (seating) {
      result.seat_plan_version = Number(seating.state.seat_plan_version || 0);
      result.published_revision = Number(seating.state.published_revision || 0);
    }
    var committed = persistP2Request_(scope, request, digest, {
      season_id: String(season.season_id), practice_id: practiceId, at: now,
      actor_type: management ? "COACH" : "ANONYMOUS", actor_id: actorId,
      signups: changed, signup_state: noChange ? null : state, seating: seating,
      before: changed.map(function (row) { return beforeByMember[row.member_id] || null; })
    }, result);
    return attachP21View_(request, committed, management);
  });
}

// Response-only extension: immutable journal results never contain a stale view.
// All callers hold the outer lock and have authenticated management requests.
function attachP21View_(request, result, management) {
  if (request.include_current_view !== true) return result;
  var response = Object.assign({}, result, { view_status: "refresh_required", current_view: null });
  try {
    var season = requireSeason_(request.season_id);
    var view = { season_id: String(season.season_id), season_status: seasonEffectiveStatus_(season),
      roster_version: Number(season.roster_version), binding_version: Number(season.binding_version) };
    var practiceId = result.practice_id || request.view_practice_id;
    if (practiceId) view.practice = publicPractice_({ season_id: season.season_id, practice_id: practiceId });
    if (management) {
      var links = allMemberActiveLinks_(season);
      view.member_links = links;
      if (practiceId) {
        var managedPractice = requirePublicPractice_(season, practiceId);
        view.seating = seatingWorkspaceInternal_(season, managedPractice);
      }
      if (request.known_roster_version !== Number(season.roster_version)) {
        view.members = getSeasonSheetRecords_(season, "Members").map(function (member) {
          return memberManagementProjection_(season, member, links[member.member_id] || []);
        });
      }
    } else if (view.season_status === "OPEN" &&
        (request.known_roster_version !== Number(season.roster_version) ||
         !(Date.parse(request.roster_expires_at) > Date.now()))) {
      view.roster = getPublicRosterSnapshot_(season, false);
    }
    view.generated_at = new Date().toISOString();
    response.current_view = view;
    response.view_status = "ready";
  } catch (error) {
    // The write has already committed. Read/projection failure must not turn it
    // into another business mutation or expose internal configuration errors.
    response.view_status = "refresh_required";
  }
  return response;
}
