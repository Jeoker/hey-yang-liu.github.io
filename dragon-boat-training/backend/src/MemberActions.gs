function allMemberActiveLinks_(season) {
  var practices = {};
  getSeasonSheetRecords_(season, "Practices").forEach(function (practice) {
    if (!practice.cancelled_at && Date.parse(String(practice.end_at)) > Date.now()) {
      practices[practice.practice_id] = practice;
    }
  });
  var links = {};
  function add(row, kind) {
    if (!row.member_id || !practices[row.practice_id]) return;
    if (!links[row.member_id]) links[row.member_id] = [];
    if (links[row.member_id].some(function (link) {
      return link.practice_id === String(row.practice_id) && link.kind === kind;
    })) return;
    links[row.member_id].push({ practice_id: String(row.practice_id), start_at: String(practices[row.practice_id].start_at), kind: kind });
  }
  getSeasonSheetRecords_(season, "SignupsCurrent").forEach(function (row) {
    if (row.status !== "CANCELLED") add(row, "SIGNUP");
  });
  getSeasonSheetRecords_(season, "SeatPlanCurrent").forEach(function (row) {
    add(row, "SEAT");
  });
  getSeasonSheetRecords_(season, "SeatPlanState").forEach(function (row) {
    if (row.coach_member_id) add({ practice_id: row.practice_id, member_id: row.coach_member_id }, "COACH");
    if (row.steerer_member_id) add({ practice_id: row.practice_id, member_id: row.steerer_member_id }, "STEERER");
    var published = getSeatPlanRevision_(season, row.practice_id, row.published_revision);
    if (published && published.coach_member_id) {
      add({ practice_id: row.practice_id, member_id: published.coach_member_id }, "COACH");
    }
    if (published && published.steerer_member_id) {
      add({ practice_id: row.practice_id, member_id: published.steerer_member_id }, "STEERER");
    }
  });
  return links;
}

function memberActiveLinks_(season, memberId) {
  return allMemberActiveLinks_(season)[memberId] || [];
}

function memberManagementProjection_(season, member, activeLinks) {
  return {
    member_id: String(member.member_id), source_display_name: String(member.source_display_name),
    display_name_override: String(member.display_name_override || ""),
    display_name: String(member.display_name_override || member.source_display_name),
    status: String(member.status), default_preference: String(member.default_preference || "AMBIENT"),
    member_version: Number(member.member_version), active_links: activeLinks || memberActiveLinks_(season, member.member_id)
  };
}

function listSeasonMembers_(request) {
  return withDragonBoatScriptLock_(function () {
    validateCoachSession_(requireRequestString_(request, "session_token", 32, 2048));
    var season = requireSeason_(request.season_id);
    var links = allMemberActiveLinks_(season);
    return { season_id: String(season.season_id), roster_version: Number(season.roster_version),
      members: getSeasonSheetRecords_(season, "Members").map(function (member) {
        return memberManagementProjection_(season, member, links[member.member_id] || []);
      }) };
  });
}

function mutateMember_(request) {
  return withDragonBoatScriptLock_(function () {
    var auth = validateCoachSession_(requireRequestString_(request, "session_token", 32, 2048));
    var season = requireSeason_(request.season_id);
    // Freeze due practices before a name correction can change the historical
    // name that belonged at the end of the 24-hour correction window.
    freezeDueSeatPlansForSeason_(season);
    var memberId = requireRequestString_(request, "member_id", 8, 128);
    var actorId = String(auth.coach.coach_id);
    var scope = "P2:" + season.season_id + ":COACH:" + actorId;
    var input = { season_id: String(season.season_id), member_id: memberId, member_version: request.member_version };
    if (request.action === "updateMember") {
      if (typeof request.display_name_override !== "string" || request.display_name_override.trim().length > 120) {
        throw dragonBoatRequestError_("INVALID_REQUEST", "The display name must be at most 120 characters.");
      }
      input.display_name_override = request.display_name_override.trim();
      // setValues interprets a leading '=' as a formula, even with a text format.
      if (/^=|[\r\n\t]/.test(input.display_name_override)) {
        throw dragonBoatRequestError_("INVALID_REQUEST", "Use a single-line display name without a leading equals sign.");
      }
      input.default_preference = requireSignupPreference_(request.default_preference);
    } else if (request.action === "setMemberStatus") {
      if (["ACTIVE", "INACTIVE"].indexOf(request.status) < 0) throw dragonBoatRequestError_("INVALID_REQUEST", "Choose an active or inactive status.");
      input.status = request.status;
    }
    var digest = digestRequestPayload_(input);
    var prior = findMatchingSystemRequest_(scope, request.action, request.request_id, digest);
    if (prior) return attachP21View_(request, applyP2Request_(prior), true);
    ensureSeasonOpen_(season);
    var member = requireSeasonMember_(season, memberId);
    requireVersion_(member.member_version, request.member_version, "member");
    if (input.status === "INACTIVE" && memberActiveLinks_(season, memberId).length) {
      throw dragonBoatRequestError_("MEMBER_HAS_ACTIVE_LINKS", "Cancel active signups and remove training assignments before deactivating this member.");
    }
    var before = memberManagementProjection_(season, member);
    var patch = { member_id: memberId, member_version: Number(member.member_version) + 1,
      updated_at: new Date().toISOString() };
    if (request.action === "updateMember") {
      patch.display_name_override = input.display_name_override;
      patch.default_preference = input.default_preference;
    } else if (request.action === "restoreMemberName") {
      patch.display_name_override = "";
    } else patch.status = input.status;
    Object.keys(patch).forEach(function (key) { member[key] = patch[key]; });
    var rosterVersion = Number(season.roster_version) + 1;
    var result = { season_id: String(season.season_id), roster_version: rosterVersion,
      member: memberManagementProjection_(season, member) };
    var committed = persistP2Request_(scope, request, digest, {
      season_id: String(season.season_id), actor_id: actorId, actor_type: "COACH", at: patch.updated_at,
      member: patch, roster_version: rosterVersion, before: before
    }, result);
    return attachP21View_(request, committed, true);
  });
}

function getMemberWorkspace_(request) {
  return withDragonBoatScriptLock_(function () {
    validateCoachSession_(requireRequestString_(request, "session_token", 32, 2048));
    var season = requireSeason_(request.season_id);
    if (["OPEN", "COMPLETED"].indexOf(seasonEffectiveStatus_(season)) < 0) {
      throw dragonBoatRequestError_("SEASON_NOT_OPEN", "The season management workspace is not available.");
    }
    var published = publicBootstrap_({ season_id: season.season_id });
    var practices = [];
    published.weeks.forEach(function (week) { practices = practices.concat(week.practices); });
    practices.sort(function (left, right) { return left.start_at.localeCompare(right.start_at); });
    var practiceId = request.practice_id || (practices[0] && practices[0].practice_id);
    var viewRequest = Object.assign({}, request, { include_current_view: true, view_practice_id: practiceId });
    var result = attachP21View_(viewRequest, {}, true);
    if (result.view_status !== "ready") throw dragonBoatRequestError_("VIEW_UNAVAILABLE", "The management view could not be read. Please refresh.", true);
    return Object.assign({}, result.current_view, { season: seasonManagementProjection_(season), practices: practices });
  });
}
