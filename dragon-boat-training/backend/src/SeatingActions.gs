var DRAGON_BOAT_SEAT_PLAN_CHANGE_KINDS_ = ["EDIT", "UNDO", "RESET_TO_PUBLISHED"];
var DRAGON_BOAT_SEAT_PLAN_DAY_MS_ = 24 * 60 * 60 * 1000;

function seatPlanArchiveDueAt_(practice) {
  var end = Date.parse(String(practice.end_at));
  if (!Number.isFinite(end)) {
    throw dragonBoatRequestError_("CONFIGURATION_ERROR", "The training end time is invalid.");
  }
  return new Date(end + DRAGON_BOAT_SEAT_PLAN_DAY_MS_).toISOString();
}

function seatingMode_(practice, now) {
  if (practice.cancelled_at) return "CANCELLED";
  var at = now instanceof Date ? now.getTime() : (now === undefined ? Date.now() : Number(now));
  var end = Date.parse(String(practice.end_at));
  var due = Date.parse(seatPlanArchiveDueAt_(practice));
  if (at >= due) return "FROZEN";
  if (at >= end) return "FINAL_CORRECTION";
  return "UPCOMING";
}

function emptySeatPlanState_(season, practice) {
  return {
    season_id: String(season.season_id),
    practice_id: String(practice.practice_id),
    seat_plan_version: 0,
    coach_member_id: "",
    steerer_member_id: "",
    published_revision: 0,
    frozen_revision: "",
    frozen_at: "",
    updated_by: "",
    updated_at: ""
  };
}

function getSeatPlanState_(season, practice) {
  var state = findSeasonSheetRecord_(season, "SeatPlanState", "practice_id", practice.practice_id);
  if (!state) return emptySeatPlanState_(season, practice);
  state.seat_plan_version = Number(state.seat_plan_version || 0);
  state.published_revision = Number(state.published_revision || 0);
  state.frozen_revision = state.frozen_revision === "" ? "" : Number(state.frozen_revision);
  return state;
}

function seatSlotKey_(side, rowNumber) {
  return String(side) + ":" + String(rowNumber);
}

function normalizeSeatPlanSeats_(practice, input) {
  if (!Array.isArray(input)) {
    throw dragonBoatRequestError_("INVALID_SEAT_PLAN", "A complete seating snapshot is required.");
  }
  var capacities = { LEFT: Number(practice.left_capacity), RIGHT: Number(practice.right_capacity) };
  if (!Number.isInteger(capacities.LEFT) || capacities.LEFT < 0 ||
      !Number.isInteger(capacities.RIGHT) || capacities.RIGHT < 0) {
    throw dragonBoatRequestError_("CONFIGURATION_ERROR", "The training capacity is invalid.");
  }
  var supplied = {};
  input.forEach(function (seat) {
    if (!seat || typeof seat !== "object" || ["LEFT", "RIGHT"].indexOf(seat.side) < 0) {
      throw dragonBoatRequestError_("INVALID_SEAT_PLAN", "Every seat needs a valid side and row number.");
    }
    var rowNumber = Number(seat.row_number);
    if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > capacities[seat.side]) {
      throw dragonBoatRequestError_("INVALID_SEAT_PLAN", "A seat is outside the training capacity.");
    }
    var key = seatSlotKey_(seat.side, rowNumber);
    if (Object.prototype.hasOwnProperty.call(supplied, key)) {
      throw dragonBoatRequestError_("INVALID_SEAT_PLAN", "The same seat was included more than once.");
    }
    var memberId = seat.member_id === undefined || seat.member_id === null ? "" : String(seat.member_id).trim();
    if (memberId && (memberId.length < 8 || memberId.length > 128)) {
      throw dragonBoatRequestError_("INVALID_SEAT_PLAN", "A seat contains an invalid member identifier.");
    }
    supplied[key] = memberId;
  });
  var result = [];
  ["LEFT", "RIGHT"].forEach(function (side) {
    for (var rowNumber = 1; rowNumber <= capacities[side]; rowNumber += 1) {
      var key = seatSlotKey_(side, rowNumber);
      result.push({ row_number: rowNumber, side: side, member_id: supplied[key] || "" });
    }
  });
  return result;
}

function getDraftSeatPlanSeats_(season, practice) {
  var rows = getSeasonSheetRecords_(season, "SeatPlanCurrent").filter(function (row) {
    return String(row.practice_id) === String(practice.practice_id);
  }).map(function (row) {
    return { row_number: Number(row.row_number), side: String(row.side), member_id: String(row.member_id || "") };
  });
  return normalizeSeatPlanSeats_(practice, rows);
}

function parseSeatPlanArray_(value) {
  try {
    var parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function getSeatPlanRevision_(season, practiceId, revisionNumber) {
  if (!Number(revisionNumber)) return null;
  return getSeasonSheetRecords_(season, "SeatPlanRevisions").filter(function (row) {
    return String(row.practice_id) === String(practiceId) &&
      Number(row.revision_number) === Number(revisionNumber);
  })[0] || null;
}

function seatPlanRoleMemberIds_(season, practice) {
  var state = getSeatPlanState_(season, practice);
  var revision = getSeatPlanRevision_(season, practice.practice_id, state.published_revision);
  var result = {};
  [state.coach_member_id, state.steerer_member_id,
    revision && revision.coach_member_id, revision && revision.steerer_member_id].forEach(function (memberId) {
    if (memberId) result[String(memberId)] = true;
  });
  return result;
}

function getPracticeFinalSnapshot_(season, practiceId) {
  return findSeasonSheetRecord_(season, "PracticeFinalSnapshots", "practice_id", practiceId);
}

function seasonMemberNameMap_(season) {
  var names = {};
  getSeasonSheetRecords_(season, "Members").forEach(function (member) {
    names[String(member.member_id)] = String(member.display_name_override || member.source_display_name);
  });
  return names;
}

function seatPlanNamesSnapshot_(season, coachMemberId, steererMemberId, seats) {
  var currentNames = seasonMemberNameMap_(season);
  var names = {};
  [coachMemberId, steererMemberId].concat((seats || []).map(function (seat) {
    return seat.member_id;
  })).forEach(function (memberId) {
    if (memberId && currentNames[memberId]) names[memberId] = currentNames[memberId];
  });
  return names;
}

function seatPlanRoleProjection_(memberId, names, management) {
  if (!memberId) return null;
  var result = { display_name: String(names[memberId] || "已停用队员") };
  if (management) result.member_id = String(memberId);
  return result;
}

function occupiedSeatPlanSeats_(seats) {
  return (seats || []).filter(function (seat) { return Boolean(seat.member_id); });
}

function publicSeatPlanRows_(practice, seats, names) {
  var bySlot = {};
  occupiedSeatPlanSeats_(seats).forEach(function (seat) {
    bySlot[seatSlotKey_(seat.side, seat.row_number)] = {
      member_id: String(seat.member_id),
      display_name: String(names[seat.member_id] || "已停用队员")
    };
  });
  var count = Math.max(Number(practice.left_capacity), Number(practice.right_capacity));
  var rows = [];
  for (var rowNumber = 1; rowNumber <= count; rowNumber += 1) {
    rows.push({ row_number: rowNumber,
      left: bySlot[seatSlotKey_("LEFT", rowNumber)] || null,
      right: bySlot[seatSlotKey_("RIGHT", rowNumber)] || null });
  }
  return rows;
}

function seatPlanProjection_(season, practice, management) {
  var mode = seatingMode_(practice);
  if (mode === "FROZEN") ensurePracticeSeatPlanFrozen_(season, practice);
  var state = getSeatPlanState_(season, practice);
  var finalSnapshot = mode === "FROZEN" || state.frozen_at
    ? getPracticeFinalSnapshot_(season, practice.practice_id) : null;
  var revisionNumber = finalSnapshot ? Number(finalSnapshot.revision_number || 0) : Number(state.published_revision || 0);
  var revision = getSeatPlanRevision_(season, practice.practice_id, revisionNumber);
  var seats = finalSnapshot ? parseSeatPlanArray_(finalSnapshot.seats_json) :
    (revision ? parseSeatPlanArray_(revision.seats_json) : []);
  var names = finalSnapshot ? parseJsonObject_(finalSnapshot.names_json) : seasonMemberNameMap_(season);
  var frozenRoles = finalSnapshot ? parseJsonObject_(finalSnapshot.roles_json) : {};
  var coachMemberId = finalSnapshot ? String(frozenRoles.coach_member_id || "") :
    (revision ? String(revision.coach_member_id || "") : "");
  var steererMemberId = finalSnapshot ? String(frozenRoles.steerer_member_id || "") :
    (revision ? String(revision.steerer_member_id || "") : "");
  var projectedSeats = occupiedSeatPlanSeats_(seats).map(function (seat) {
    return {
      row_number: Number(seat.row_number), side: String(seat.side),
      member_id: String(seat.member_id),
      display_name: String(names[seat.member_id] || "已停用队员")
    };
  });
  return {
    status: finalSnapshot ? "FROZEN" : (revision ? "PUBLISHED" : "UNPUBLISHED"),
    mode: mode,
    seat_plan_version: revision ? Number(revision.seat_plan_version || 0) : 0,
    published_revision: revisionNumber,
    archive_due_at: seatPlanArchiveDueAt_(practice),
    published_at: revision ? String(revision.published_at || "") : "",
    source: revision ? String(revision.source || "") : "",
    coach: seatPlanRoleProjection_(coachMemberId, names, management === true),
    steerer: seatPlanRoleProjection_(steererMemberId, names, management === true),
    seats: projectedSeats,
    rows: publicSeatPlanRows_(practice, seats, names)
  };
}

function publicSeatPlanProjection_(season, practice) {
  return seatPlanProjection_(season, practice, false);
}

function managementSeatPlanProjection_(season, practice) {
  return seatPlanProjection_(season, practice, true);
}

function seatingPreferenceMismatches_(season, practice, seats) {
  var preferences = {};
  getSeasonSheetRecords_(season, "SignupsCurrent").forEach(function (row) {
    if (String(row.practice_id) === String(practice.practice_id) && row.status === "CONFIRMED") {
      preferences[String(row.member_id)] = String(row.preference);
    }
  });
  return seats.filter(function (seat) {
    return seat.member_id && preferences[seat.member_id] && preferences[seat.member_id] !== "AMBIENT" &&
      preferences[seat.member_id] !== seat.side;
  }).map(function (seat) {
    return { member_id: String(seat.member_id), preference: preferences[seat.member_id], side: String(seat.side) };
  });
}

function validateSeatPlanSnapshot_(season, practice, snapshot, mode, publishing) {
  var members = {};
  getSeasonSheetRecords_(season, "Members").forEach(function (member) { members[String(member.member_id)] = member; });
  var activeSignups = {};
  var confirmed = {};
  getPracticeSignups_(season, practice.practice_id).forEach(function (row) {
    if (row.status !== "CANCELLED") activeSignups[String(row.member_id)] = row;
    if (row.status === "CONFIRMED") confirmed[String(row.member_id)] = row;
  });
  [snapshot.coach_member_id, snapshot.steerer_member_id].forEach(function (memberId) {
    if (!memberId) return;
    if (!members[memberId] || (mode === "UPCOMING" && members[memberId].status !== "ACTIVE")) {
      throw dragonBoatRequestError_("INVALID_SEAT_PLAN", "A training role contains an unavailable member.");
    }
    if (mode === "UPCOMING" && activeSignups[memberId]) {
      throw dragonBoatRequestError_("ROLE_SIGNUP_CONFLICT", "Remove this member's signup before assigning a training role.");
    }
  });
  var seated = {};
  snapshot.seats.forEach(function (seat) {
    if (!seat.member_id) return;
    var member = members[seat.member_id];
    if (!member || (mode === "UPCOMING" && member.status !== "ACTIVE")) {
      throw dragonBoatRequestError_("INVALID_SEAT_PLAN", "A seat contains an unavailable member.");
    }
    if (seated[seat.member_id]) {
      throw dragonBoatRequestError_("INVALID_SEAT_PLAN", "A member cannot occupy more than one seat.");
    }
    if (seat.member_id === snapshot.coach_member_id || seat.member_id === snapshot.steerer_member_id) {
      throw dragonBoatRequestError_("INVALID_SEAT_PLAN", "A Coach or Steerer cannot also occupy a paddling seat.");
    }
    if (mode === "UPCOMING" && !confirmed[seat.member_id]) {
      throw dragonBoatRequestError_("SEAT_MEMBER_NOT_CONFIRMED", "Only confirmed signups can be seated before training ends.");
    }
    seated[seat.member_id] = true;
  });
  if (publishing && mode === "UPCOMING") {
    var missing = Object.keys(confirmed).filter(function (memberId) { return !seated[memberId]; });
    if (missing.length) {
      throw dragonBoatRequestError_("SEAT_PLAN_INCOMPLETE", "Seat every confirmed signup before publishing.");
    }
  }
  return seatingPreferenceMismatches_(season, practice, snapshot.seats);
}

function seatMatchesSignupPreference_(side, preference) {
  return preference === "AMBIENT" || String(side) === String(preference);
}

function signupSeatAvailability_(season, practice, signupRows, targetMemberId) {
  var state = getSeatPlanState_(season, practice);
  var revision = getSeatPlanRevision_(season, practice.practice_id, state.published_revision);
  var hasDraft = Number(state.seat_plan_version || 0) > 0 || getSeasonSheetRecords_(season, "SeatPlanCurrent").some(function (row) {
    return String(row.practice_id) === String(practice.practice_id);
  });
  if (!revision && !hasDraft) return null;
  var seats = revision ? normalizeSeatPlanSeats_(practice, parseSeatPlanArray_(revision.seats_json)) :
    getDraftSeatPlanSeats_(season, practice);
  var signupByMember = {};
  signupRows.forEach(function (row) { signupByMember[String(row.member_id)] = row; });
  var occupied = {};
  var slots = [];
  seats.forEach(function (seat) {
    var memberId = String(seat.member_id || "");
    var signup = memberId && signupByMember[memberId];
    var released = memberId === String(targetMemberId || "") &&
      (!signup || signup.status !== "CONFIRMED" || !seatMatchesSignupPreference_(seat.side, signup.preference));
    if (memberId && !released) occupied[memberId] = true;
    else slots.push({ key: seatSlotKey_(seat.side, seat.row_number), side: String(seat.side), claimed: false,
      released_by_target: released });
  });
  slots.sort(function (left, right) {
    return Number(right.released_by_target) - Number(left.released_by_target) ||
      Number(left.key.split(":")[1]) - Number(right.key.split(":")[1]) || left.side.localeCompare(right.side);
  });
  // Existing confirmed-but-unseated people already consume the logical room
  // represented by empty draft/public slots.
  signupRows.filter(function (row) {
    return row.status === "CONFIRMED" && !occupied[row.member_id];
  }).sort(compareSignupQueue_).forEach(function (row) {
    claimSignupSeat_(slots, row.preference);
  });
  return slots;
}

function claimSignupSeat_(slots, preference) {
  if (!slots) return true;
  for (var index = 0; index < slots.length; index += 1) {
    if (!slots[index].claimed && seatMatchesSignupPreference_(slots[index].side, preference)) {
      slots[index].claimed = true;
      return true;
    }
  }
  return false;
}

function seatPlanSeatsEqual_(left, right) {
  return JSON.stringify((left || []).map(function (seat) {
    return [Number(seat.row_number), String(seat.side), String(seat.member_id || "")];
  })) === JSON.stringify((right || []).map(function (seat) {
    return [Number(seat.row_number), String(seat.side), String(seat.member_id || "")];
  }));
}

function seatPlanRowsForWrite_(season, practice, seats, version, actorId, at) {
  return seats.map(function (seat) {
    return { season_id: String(season.season_id), practice_id: String(practice.practice_id),
      row_number: Number(seat.row_number), side: String(seat.side), member_id: String(seat.member_id || ""),
      seat_plan_version: Number(version), updated_by: actorId, updated_at: at };
  });
}

// Called only after the shared signup allocator has selected final statuses.
// It removes invalidated seats and, where the Coach draft still matches the
// published slot, applies the same deterministic promotion without exposing
// unrelated draft work in the public revision.
function buildSignupSeatingTransition_(season, practice, request, scope, targetBefore, targetAfter, promotedMemberIds, actorId, at) {
  var state = getSeatPlanState_(season, practice);
  var publishedRevision = getSeatPlanRevision_(season, practice.practice_id, state.published_revision);
  var hasDraft = Number(state.seat_plan_version || 0) > 0 || getSeasonSheetRecords_(season, "SeatPlanCurrent").some(function (row) {
    return String(row.practice_id) === String(practice.practice_id);
  });
  if (!hasDraft && !publishedRevision) return null;

  var targetId = String(targetAfter.member_id);
  var shouldRemove = targetAfter.status !== "CONFIRMED";
  var preference = String(targetAfter.preference || "AMBIENT");
  var promotedIds = (promotedMemberIds || []).map(String);
  var promotedId = "";
  var publishedBefore = publishedRevision
    ? normalizeSeatPlanSeats_(practice, parseSeatPlanArray_(publishedRevision.seats_json))
    : null;
  var publishedAfter = publishedBefore ? JSON.parse(JSON.stringify(publishedBefore)) : null;
  var releasedPublishedSlots = [];
  if (publishedAfter) {
    publishedAfter.forEach(function (seat) {
      if (seat.member_id === targetId && (shouldRemove || !seatMatchesSignupPreference_(seat.side, preference))) {
        releasedPublishedSlots.push(seatSlotKey_(seat.side, seat.row_number));
        seat.member_id = "";
      }
    });
    if (releasedPublishedSlots.length) {
      var releasedSide = releasedPublishedSlots[0].split(":")[0];
      var signupByMember = {};
      getPracticeSignups_(season, practice.practice_id).forEach(function (row) {
        signupByMember[String(row.member_id)] = row;
      });
      promotedIds.some(function (memberId) {
        var signup = signupByMember[memberId];
        if (signup && seatMatchesSignupPreference_(releasedSide, signup.preference)) {
          promotedId = memberId;
          return true;
        }
        return false;
      });
    }
    if (promotedId && releasedPublishedSlots.length) {
      publishedAfter.some(function (seat) {
        if (seatSlotKey_(seat.side, seat.row_number) === releasedPublishedSlots[0] && !seat.member_id) {
          seat.member_id = promotedId;
          return true;
        }
        return false;
      });
    }
  }

  var draftBefore = hasDraft ? getDraftSeatPlanSeats_(season, practice) : null;
  var draftAfter = draftBefore ? JSON.parse(JSON.stringify(draftBefore)) : null;
  if (!publishedBefore && promotedIds.length) promotedId = promotedIds[0];
  if (draftAfter) {
    draftAfter.forEach(function (seat) {
      if (seat.member_id === targetId && (shouldRemove || !seatMatchesSignupPreference_(seat.side, preference))) {
        seat.member_id = "";
      }
    });
    if (promotedId) {
      var replacementKey = "";
      if (publishedBefore && releasedPublishedSlots.length) {
        // Synchronize only when the draft still contained the released public
        // occupant at that exact slot before this signup change.
        draftBefore.some(function (seat) {
          if (seatSlotKey_(seat.side, seat.row_number) === releasedPublishedSlots[0] && seat.member_id === targetId) {
            replacementKey = releasedPublishedSlots[0];
            return true;
          }
          return false;
        });
      } else if (!publishedBefore) {
        draftBefore.some(function (seat) {
          if (seat.member_id === targetId && (shouldRemove || !seatMatchesSignupPreference_(seat.side, preference))) {
            replacementKey = seatSlotKey_(seat.side, seat.row_number);
            return true;
          }
          return false;
        });
      }
      if (replacementKey) {
        draftAfter.some(function (seat) {
          if (seatSlotKey_(seat.side, seat.row_number) === replacementKey && !seat.member_id) {
            seat.member_id = promotedId;
            return true;
          }
          return false;
        });
      }
    }
  }

  var draftChanged = draftBefore && !seatPlanSeatsEqual_(draftBefore, draftAfter);
  var publishedChanged = publishedBefore && !seatPlanSeatsEqual_(publishedBefore, publishedAfter);
  if (!draftChanged && !publishedChanged) return null;
  var nextVersion = Number(state.seat_plan_version || 0) + (draftChanged ? 1 : 0);
  var nextRevision = Number(state.published_revision || 0) + (publishedChanged ? 1 : 0);
  var nextState = Object.assign({}, state, {
    seat_plan_version: nextVersion,
    published_revision: nextRevision,
    updated_by: actorId,
    updated_at: at
  });
  delete nextState._rowNumber;
  var transition = {
    practice_id: String(practice.practice_id), at: at, actor_id: actorId,
    actor_type: /ByCoach$/.test(request.action) ? "COACH" : "ANONYMOUS",
    audit_action: "SEAT_PLAN_SYSTEM_REVISED",
    audit_details: { source_action: request.action, member_id: targetId,
      promoted_member_ids: promotedMemberIds || [], seat_plan_version: nextVersion,
      published_revision: nextRevision },
    state: nextState
  };
  if (draftChanged) transition.seats = seatPlanRowsForWrite_(season, practice, draftAfter, nextVersion, actorId, at);
  if (publishedChanged) {
    var requestKey = buildSystemRequestKey_(scope, request.action, request.request_id);
    var publishedCoachId = String(publishedRevision.coach_member_id || "");
    var publishedSteererId = String(publishedRevision.steerer_member_id || "");
    transition.revision = {
      season_id: String(season.season_id), practice_id: String(practice.practice_id),
      revision_number: nextRevision,
      revision_id: "seat_revision_" + hmacDigest_(requestKey + "\nsystem", getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET)).slice(0, 32),
      source: "SYSTEM_" + String(request.action).toUpperCase(), seat_plan_version: nextVersion,
      coach_member_id: publishedCoachId, steerer_member_id: publishedSteererId,
      seats_json: JSON.stringify(publishedAfter),
      names_json: JSON.stringify(seatPlanNamesSnapshot_(season, publishedCoachId, publishedSteererId, publishedAfter)),
      published_by: actorId, published_at: at, request_id: request.request_id
    };
  }
  return transition;
}

function seatingWorkspaceInternal_(season, practice) {
  var state = getSeatPlanState_(season, practice);
  var mode = seatingMode_(practice);
  var seats = getDraftSeatPlanSeats_(season, practice);
  var signups = getPracticeSignups_(season, practice.practice_id).filter(function (row) {
    return row.status !== "CANCELLED";
  }).sort(compareSignupQueue_);
  var names = seasonMemberNameMap_(season);
  var seated = {};
  seats.forEach(function (seat) { if (seat.member_id) seated[seat.member_id] = true; });
  var members = getSeasonSheetRecords_(season, "Members").map(function (member) {
    return {
      member_id: String(member.member_id),
      display_name: String(member.display_name_override || member.source_display_name),
      status: String(member.status),
      default_preference: String(member.default_preference || "AMBIENT")
    };
  });
  var projectedSignups = signups.map(function (row) {
    var result = signupProjection_(row);
    result.display_name = String(names[row.member_id] || "已停用队员");
    return result;
  });
  return {
    season_id: String(season.season_id),
    practice_id: String(practice.practice_id),
    practice: practiceProjection_(practice),
    mode: mode,
    editable: mode === "UPCOMING" || mode === "FINAL_CORRECTION",
    archive_due_at: seatPlanArchiveDueAt_(practice),
    generated_at: new Date().toISOString(),
    signup_version: Number(getSignupState_(season, practice.practice_id).version),
    seat_plan_version: Number(state.seat_plan_version || 0),
    published_revision: Number(state.published_revision || 0),
    draft: {
      coach_member_id: String(state.coach_member_id || ""),
      steerer_member_id: String(state.steerer_member_id || ""),
      seats: occupiedSeatPlanSeats_(seats)
    },
    published: Number(state.published_revision || 0) || getPracticeFinalSnapshot_(season, practice.practice_id)
      ? managementSeatPlanProjection_(season, practice) : null,
    members: members,
    signups: projectedSignups,
    unseated_member_ids: projectedSignups.filter(function (row) {
      return row.status === "CONFIRMED" && !seated[row.member_id];
    }).map(function (row) { return row.member_id; }),
    preference_mismatches: seatingPreferenceMismatches_(season, practice, seats)
  };
}

function getSeatingWorkspace_(request) {
  return withDragonBoatScriptLock_(function () {
    validateCoachSession_(requireRequestString_(request, "session_token", 32, 2048));
    var season = requireSeason_(request.season_id);
    var practice = requirePublicPractice_(season, requireRequestString_(request, "practice_id", 8, 128));
    return seatingWorkspaceInternal_(season, practice);
  });
}

function normalizedSeatPlanRequest_(request, season, practice, state) {
  var kind = typeof request.change_kind === "string" ? request.change_kind.trim() : "";
  if (DRAGON_BOAT_SEAT_PLAN_CHANGE_KINDS_.indexOf(kind) < 0) {
    throw dragonBoatRequestError_("INVALID_REQUEST", "Choose a valid seating change kind.");
  }
  var coachMemberId = request.coach_member_id === undefined || request.coach_member_id === null
    ? "" : String(request.coach_member_id).trim();
  var steererMemberId = request.steerer_member_id === undefined || request.steerer_member_id === null
    ? "" : String(request.steerer_member_id).trim();
  var seats = normalizeSeatPlanSeats_(practice, request.seats);
  if (kind === "RESET_TO_PUBLISHED") {
    var revision = getSeatPlanRevision_(season, practice.practice_id, state.published_revision);
    coachMemberId = revision ? String(revision.coach_member_id || "") : "";
    steererMemberId = revision ? String(revision.steerer_member_id || "") : "";
    seats = revision ? normalizeSeatPlanSeats_(practice, parseSeatPlanArray_(revision.seats_json)) : normalizeSeatPlanSeats_(practice, []);
  }
  return { change_kind: kind, coach_member_id: coachMemberId, steerer_member_id: steererMemberId, seats: seats };
}

function seatPlanRequestDigestSeats_(input) {
  if (!Array.isArray(input)) {
    throw dragonBoatRequestError_("INVALID_SEAT_PLAN", "A complete seating snapshot is required.");
  }
  return input.map(function (seat) {
    return {
      row_number: seat && Number(seat.row_number),
      side: seat && String(seat.side || ""),
      member_id: seat && seat.member_id !== undefined && seat.member_id !== null ? String(seat.member_id).trim() : ""
    };
  }).sort(function (left, right) {
    return left.side.localeCompare(right.side) || Number(left.row_number) - Number(right.row_number) ||
      left.member_id.localeCompare(right.member_id);
  });
}

function persistP3Request_(actorId, request, digest, plan, result) {
  var saved = { kind: "P3", season_id: plan.season_id, plan: plan, result: result };
  if (JSON.stringify(saved).length > 45000) {
    throw dragonBoatRequestError_("REQUEST_TOO_LARGE", "This change is too large to save safely.");
  }
  var transaction = beginSystemRequest_(actorId, request.action, request.request_id, digest, saved);
  SpreadsheetApp.flush();
  return applyP3Request_(transaction.record);
}

function applyP3SeatingPlanParts_(record, season, plan) {
  if (!plan) return;
  if (plan.seats) writeSeatPlanSnapshot_(season, plan.seats);
  if (plan.revision && !findSeasonSheetRecord_(season, "SeatPlanRevisions", "revision_id", plan.revision.revision_id)) {
    appendSeasonSheetRecord_(season, "SeatPlanRevisions", plan.revision);
  }
  if (plan.final_snapshot && !findSeasonSheetRecord_(season, "PracticeFinalSnapshots", "snapshot_id", plan.final_snapshot.snapshot_id)) {
    appendSeasonSheetRecord_(season, "PracticeFinalSnapshots", plan.final_snapshot);
  }
  if (plan.state) {
    var state = findSeasonSheetRecord_(season, "SeatPlanState", "practice_id", plan.state.practice_id);
    var update = Object.assign({}, plan.state);
    if (state) {
      update._rowNumber = state._rowNumber;
      updateSeasonSheetRecord_(season, "SeatPlanState", update);
    } else appendSeasonSheetRecord_(season, "SeatPlanState", update);
  }
  var eventId = deterministicEventId_(record, plan.audit_action || "P3_SEATING_COMMITTED");
  if (!findSeasonSheetRecord_(season, "AuditLog", "event_id", eventId)) {
    appendSeasonSheetRecord_(season, "AuditLog", {
      event_id: eventId, request_id: record.request_id, server_time: plan.at,
      season_id: season.season_id, entity_type: "SEAT_PLAN", entity_id: plan.practice_id,
      actor_type: plan.actor_type || "COACH", actor_id: plan.actor_id,
      action: plan.audit_action || record.action, status: "SUCCEEDED",
      details_json: JSON.stringify(plan.audit_details || {})
    });
  }
}

function applyP3Request_(record) {
  var saved = readSystemRequestResult_(record);
  if (saved.kind !== "P3" || !saved.plan || !saved.result) {
    throw dragonBoatRequestError_("RECOVERY_REQUIRED", "The previous seating change needs recovery.", true);
  }
  if (String(record.status) === "COMPLETED") return saved.result;
  var season = requireSeason_(saved.season_id);
  applyP3SeatingPlanParts_(record, season, saved.plan.seating);
  SpreadsheetApp.flush();
  completeSystemRequest_(record);
  SpreadsheetApp.flush();
  return saved.result;
}

function writeSeatPlanSnapshot_(season, rows) {
  var existing = getSeasonSheetRecords_(season, "SeatPlanCurrent").filter(function (row) {
    return String(row.practice_id) === String(rows[0] && rows[0].practice_id);
  }).sort(function (left, right) { return Number(left._rowNumber) - Number(right._rowNumber); });
  var headers = DRAGON_BOAT_RUNTIME_SHEET_HEADERS_.SeatPlanCurrent;
  var values = rows.map(function (row) {
    return headers.map(function (header) { return row[header] === undefined || row[header] === null ? "" : String(row[header]); });
  });
  var sheet = getSeasonSheet_(season, "SeatPlanCurrent");
  var contiguous = existing.length === rows.length && existing.every(function (row, index) {
    return Number(row._rowNumber) === Number(existing[0]._rowNumber) + index;
  });
  if (!existing.length || contiguous) {
    var start = existing.length ? Number(existing[0]._rowNumber) : sheet.getLastRow() + 1;
    sheet.getRange(start, 1, values.length, headers.length).setNumberFormat("@").setValues(values);
    if (dragonBoatRecordCache_) delete dragonBoatRecordCache_[seasonRecordCacheKey_(season, "SeatPlanCurrent")];
    return;
  }
  rows.forEach(function (row) {
    var match = existing.filter(function (candidate) {
      return Number(candidate.row_number) === Number(row.row_number) && String(candidate.side) === String(row.side);
    })[0];
    var update = Object.assign({}, row);
    if (match) {
      update._rowNumber = match._rowNumber;
      updateSeasonSheetRecord_(season, "SeatPlanCurrent", update);
    } else appendSeasonSheetRecord_(season, "SeatPlanCurrent", update);
  });
}

function saveSeatPlanDraft_(request) {
  return withDragonBoatScriptLock_(function () {
    var auth = validateCoachSession_(requireRequestString_(request, "session_token", 32, 2048));
    var season = requireSeason_(request.season_id);
    var practice = requirePublicPractice_(season, requireRequestString_(request, "practice_id", 8, 128));
    var state = getSeatPlanState_(season, practice);
    var actorId = String(auth.coach.coach_id);
    var requestKind = typeof request.change_kind === "string" ? request.change_kind.trim() : "";
    if (DRAGON_BOAT_SEAT_PLAN_CHANGE_KINDS_.indexOf(requestKind) < 0) {
      throw dragonBoatRequestError_("INVALID_REQUEST", "Choose a valid seating change kind.");
    }
    var requestCoachId = request.coach_member_id === undefined || request.coach_member_id === null
      ? "" : String(request.coach_member_id).trim();
    var requestSteererId = request.steerer_member_id === undefined || request.steerer_member_id === null
      ? "" : String(request.steerer_member_id).trim();
    var requestSeats = seatPlanRequestDigestSeats_(request.seats);
    var digest = digestRequestPayload_({ season_id: season.season_id, practice_id: practice.practice_id,
      practice_version: request.practice_version, signup_version: request.signup_version,
      seat_plan_version: request.seat_plan_version, change_kind: requestKind,
      coach_member_id: requestCoachId, steerer_member_id: requestSteererId, seats: requestSeats });
    var scope = "P3:" + season.season_id + ":COACH:" + actorId;
    var prior = findMatchingSystemRequest_(scope, request.action, request.request_id, digest);
    if (prior) {
      applyP3Request_(prior);
      return seatingWorkspaceInternal_(requireSeason_(season.season_id), requirePractice_(season, practice.practice_id));
    }
    if (practice.cancelled_at) throw dragonBoatRequestError_("PRACTICE_CANCELLED", "The training has been cancelled.");
    var signupState = getSignupState_(season, practice.practice_id);
    requireVersion_(practice.practice_version, request.practice_version, "training");
    requireVersion_(state.seat_plan_version, request.seat_plan_version, "seating plan");
    requireVersion_(signupState.version, request.signup_version, "signup list");
    var mode = seatingMode_(practice);
    if (mode === "FROZEN") throw dragonBoatRequestError_("SEAT_PLAN_FROZEN", "The final correction window has closed.");
    var input = normalizedSeatPlanRequest_(request, season, practice, state);
    var snapshot = { coach_member_id: input.coach_member_id, steerer_member_id: input.steerer_member_id, seats: input.seats };
    validateSeatPlanSnapshot_(season, practice, snapshot, mode, false);
    var now = new Date().toISOString();
    var version = Number(state.seat_plan_version) + 1;
    var rows = input.seats.map(function (seat) {
      return { season_id: String(season.season_id), practice_id: String(practice.practice_id),
        row_number: seat.row_number, side: seat.side, member_id: seat.member_id,
        seat_plan_version: version, updated_by: actorId, updated_at: now };
    });
    var nextState = Object.assign({}, state, { seat_plan_version: version,
      coach_member_id: input.coach_member_id, steerer_member_id: input.steerer_member_id,
      updated_by: actorId, updated_at: now });
    delete nextState._rowNumber;
    persistP3Request_(scope, request, digest, {
      season_id: String(season.season_id),
      seating: { practice_id: String(practice.practice_id), at: now, actor_id: actorId,
        audit_action: "SEAT_PLAN_DRAFT_SAVED", audit_details: { change_kind: input.change_kind, seat_plan_version: version },
        state: nextState, seats: rows }
    }, { season_id: String(season.season_id), practice_id: String(practice.practice_id), seat_plan_version: version });
    return seatingWorkspaceInternal_(requireSeason_(season.season_id), requirePractice_(season, practice.practice_id));
  });
}

function publishSeatPlan_(request) {
  return withDragonBoatScriptLock_(function () {
    var auth = validateCoachSession_(requireRequestString_(request, "session_token", 32, 2048));
    var season = requireSeason_(request.season_id);
    var practice = requirePublicPractice_(season, requireRequestString_(request, "practice_id", 8, 128));
    var state = getSeatPlanState_(season, practice);
    var actorId = String(auth.coach.coach_id);
    var digest = digestRequestPayload_({ season_id: season.season_id, practice_id: practice.practice_id,
      practice_version: request.practice_version, signup_version: request.signup_version,
      seat_plan_version: request.seat_plan_version, published_revision: request.published_revision,
      acknowledge_preference_mismatch: request.acknowledge_preference_mismatch === true });
    var scope = "P3:" + season.season_id + ":COACH:" + actorId;
    var prior = findMatchingSystemRequest_(scope, request.action, request.request_id, digest);
    if (prior) {
      applyP3Request_(prior);
      return seatingWorkspaceInternal_(requireSeason_(season.season_id), requirePractice_(season, practice.practice_id));
    }
    if (practice.cancelled_at) throw dragonBoatRequestError_("PRACTICE_CANCELLED", "The training has been cancelled.");
    var signupState = getSignupState_(season, practice.practice_id);
    requireVersion_(practice.practice_version, request.practice_version, "training");
    requireVersion_(state.seat_plan_version, request.seat_plan_version, "seating plan");
    requireVersion_(state.published_revision, request.published_revision, "published seating plan");
    requireVersion_(signupState.version, request.signup_version, "signup list");
    var mode = seatingMode_(practice);
    if (mode === "FROZEN") throw dragonBoatRequestError_("SEAT_PLAN_FROZEN", "The final correction window has closed.");
    var seats = getDraftSeatPlanSeats_(season, practice);
    var snapshot = { coach_member_id: String(state.coach_member_id || ""),
      steerer_member_id: String(state.steerer_member_id || ""), seats: seats };
    var mismatches = validateSeatPlanSnapshot_(season, practice, snapshot, mode, true);
    if (mode === "UPCOMING" && mismatches.length && request.acknowledge_preference_mismatch !== true) {
      throw dragonBoatRequestError_("PREFERENCE_ACK_REQUIRED", "Confirm the side-preference differences before publishing.");
    }
    var now = new Date().toISOString();
    var revisionNumber = Number(state.published_revision || 0) + 1;
    var requestKey = buildSystemRequestKey_(scope, request.action, request.request_id);
    var revision = {
      season_id: String(season.season_id), practice_id: String(practice.practice_id),
      revision_number: revisionNumber,
      revision_id: "seat_revision_" + hmacDigest_(requestKey + "\nmanual", getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET)).slice(0, 32),
      source: "MANUAL", seat_plan_version: Number(state.seat_plan_version),
      coach_member_id: snapshot.coach_member_id, steerer_member_id: snapshot.steerer_member_id,
      seats_json: JSON.stringify(seats), names_json: JSON.stringify(seatPlanNamesSnapshot_(season,
        snapshot.coach_member_id, snapshot.steerer_member_id, seats)),
      published_by: actorId, published_at: now, request_id: request.request_id
    };
    var nextState = Object.assign({}, state, { published_revision: revisionNumber, updated_by: actorId, updated_at: now });
    delete nextState._rowNumber;
    persistP3Request_(scope, request, digest, {
      season_id: String(season.season_id),
      seating: { practice_id: String(practice.practice_id), at: now, actor_id: actorId,
        audit_action: mode === "FINAL_CORRECTION" ? "FINAL_SEAT_PLAN_PUBLISHED" : "SEAT_PLAN_PUBLISHED",
        audit_details: { revision_number: revisionNumber, seat_plan_version: Number(state.seat_plan_version),
          preference_mismatches: mismatches }, state: nextState, revision: revision }
    }, { season_id: String(season.season_id), practice_id: String(practice.practice_id),
      seat_plan_version: Number(state.seat_plan_version), published_revision: revisionNumber });
    return seatingWorkspaceInternal_(requireSeason_(season.season_id), requirePractice_(season, practice.practice_id));
  });
}

function ensurePracticeSeatPlanFrozen_(season, practice) {
  if (seatingMode_(practice) !== "FROZEN") return null;
  var existing = getPracticeFinalSnapshot_(season, practice.practice_id);
  if (existing) return existing;
  var state = getSeatPlanState_(season, practice);
  var revision = getSeatPlanRevision_(season, practice.practice_id, state.published_revision);
  var seats = revision ? normalizeSeatPlanSeats_(practice, parseSeatPlanArray_(revision.seats_json)) : [];
  var roles = { coach_member_id: revision ? String(revision.coach_member_id || "") : "",
    steerer_member_id: revision ? String(revision.steerer_member_id || "") : "" };
  var dueAt = seatPlanArchiveDueAt_(practice);
  var requestId = "freeze_" + hmacDigest_(String(season.season_id) + "\n" + String(practice.practice_id) + "\n" + dueAt,
    getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET)).slice(0, 32);
  var actorId = "P3_FREEZE:" + String(season.season_id);
  var digest = digestRequestPayload_({ season_id: season.season_id, practice_id: practice.practice_id, archive_due_at: dueAt });
  var prior = findMatchingSystemRequest_(actorId, "freezeSeatPlan", requestId, digest);
  if (prior) {
    applyP3Request_(prior);
    return getPracticeFinalSnapshot_(season, practice.practice_id);
  }
  var now = new Date().toISOString();
  var snapshotId = "seat_final_" + hmacDigest_(requestId + "\nfinal",
    getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET)).slice(0, 32);
  var finalSnapshot = {
    season_id: String(season.season_id), practice_id: String(practice.practice_id), snapshot_id: snapshotId,
    revision_number: Number(state.published_revision || 0), roles_json: JSON.stringify(roles),
    seats_json: JSON.stringify(seats),
    names_json: JSON.stringify(seatPlanNamesSnapshot_(season, roles.coach_member_id, roles.steerer_member_id, seats)),
    archive_due_at: dueAt, frozen_at: now, status: revision ? "PUBLISHED" : "UNPUBLISHED"
  };
  var nextState = Object.assign({}, state, { frozen_revision: Number(state.published_revision || 0),
    frozen_at: now, updated_by: "system_freezer", updated_at: now });
  delete nextState._rowNumber;
  persistP3Request_(actorId, { action: "freezeSeatPlan", request_id: requestId }, digest, {
    season_id: String(season.season_id),
    seating: { practice_id: String(practice.practice_id), at: now, actor_id: "system_freezer", actor_type: "SYSTEM",
      audit_action: "SEAT_PLAN_FROZEN", audit_details: { revision_number: Number(state.published_revision || 0), archive_due_at: dueAt },
      state: nextState, final_snapshot: finalSnapshot }
  }, { season_id: String(season.season_id), practice_id: String(practice.practice_id), snapshot_id: snapshotId });
  return getPracticeFinalSnapshot_(season, practice.practice_id);
}

function freezeDueSeatPlansForSeason_(season) {
  var frozenCount = 0;
  if (!season.runtime_spreadsheet_id || ["DRAFT", "ARCHIVED"].indexOf(seasonEffectiveStatus_(season)) >= 0) return 0;
  getSeasonSheetRecords_(season, "Practices").forEach(function (practice) {
    if (!practice.cancelled_at && seatingMode_(practice) === "FROZEN" &&
        !getPracticeFinalSnapshot_(season, practice.practice_id)) {
      ensurePracticeSeatPlanFrozen_(season, practice);
      frozenCount += 1;
    }
  });
  return frozenCount;
}

function freezeDueSeatPlans_() {
  var frozenCount = 0;
  getSheetRecords_("Seasons").forEach(function (season) {
    frozenCount += freezeDueSeatPlansForSeason_(season);
  });
  return frozenCount;
}
