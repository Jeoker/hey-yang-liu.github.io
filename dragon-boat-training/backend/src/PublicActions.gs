function publicBootstrap_(request) {
  var seasonId = typeof request.season_id === "string" ? request.season_id.trim() : "";
  if (!seasonId) seasonId = getOpenDefaultSeasonId_();
  if (!seasonId) {
    return { state: "NO_ACTIVE_SEASON", season: null, weeks: [] };
  }
  var season = requireSeason_(seasonId);
  var effectiveStatus = seasonEffectiveStatus_(season);
  if (effectiveStatus === "DRAFT") {
    throw dragonBoatRequestError_("SEASON_NOT_PUBLIC", "The requested season is not public.");
  }
  var published = [];
  var weekRecords = season.runtime_spreadsheet_id ? getSeasonSheetRecords_(season, "TrainingWeeks") : [];
  var publicWeeks = {};
  weekRecords.forEach(function (week) {
    if (week.status === "OPENED" && week.published_at && Date.parse(String(week.published_at)) <= Date.now()) publicWeeks[week.week_id] = true;
  });
  if (season.runtime_spreadsheet_id) {
    published = getSeasonSheetRecords_(season, "Practices").filter(function (practice) {
      return publicWeeks[practice.week_id] && Boolean(practice.schedule_published_at) &&
        Date.parse(String(practice.schedule_published_at)) <= Date.now();
    }).map(practiceProjection_).sort(function (left, right) {
      return left.start_at.localeCompare(right.start_at);
    });
  }
  var byWeek = {};
  published.forEach(function (practice) {
    if (!byWeek[practice.week_id]) byWeek[practice.week_id] = [];
    byWeek[practice.week_id].push(practice);
  });
  var weeks = Object.keys(byWeek).map(function (weekId) {
    var week = null;
    weekRecords.some(function (candidate) {
      if (String(candidate.week_id) === String(weekId)) {
        week = candidate;
        return true;
      }
      return false;
    });
    return {
      week_id: weekId,
      week_start_date: week ? String(week.week_start_date) : "",
      practices: byWeek[weekId]
    };
  }).sort(function (left, right) {
    return left.week_start_date.localeCompare(right.week_start_date);
  });
  var upcomingCount = published.filter(function (practice) {
    return !practice.cancelled && Date.parse(practice.end_at) > Date.now();
  }).length;
  return {
    state: effectiveStatus === "OPEN" ? (upcomingCount ? "ACTIVE" : "REST") : effectiveStatus,
    season: seasonPublicProjection_(season),
    weeks: weeks
  };
}

function publicMembers_(request) {
  return withDragonBoatScriptLock_(function () {
    var season = requireSeason_(requireRequestString_(request, "season_id", 8, 128));
    ensureSeasonOpen_(season);
    return getPublicRosterSnapshot_(season, false);
  });
}

// Caller holds the script lock. One snapshot also supplies names for inactive
// members on an ended practice without exposing them in the selectable roster.
function getPublicRosterSnapshot_(season, includeInactive) {
  var cacheKey = [
    "public_members_p2",
    season.season_id,
    Number(season.binding_version || 0),
    Number(season.roster_version || 0)
  ].join("_");
  var cache = CacheService.getScriptCache();
  var cached = cache.get(cacheKey);
  var result = null;
  if (cached) {
    try {
      var parsed = JSON.parse(cached);
      if (Date.parse(parsed.expires_at) > Date.now()) result = parsed;
    } catch (error) {}
  }
  if (!result) {
    var generatedAt = new Date();
    var members = getSeasonSheetRecords_(season, "Members").map(function (member) {
      return {
        member_id: String(member.member_id),
        display_name: String(member.display_name_override || member.source_display_name),
        default_preference: String(member.default_preference || "AMBIENT"),
        active: member.status === "ACTIVE"
      };
    }).sort(function (left, right) {
      return left.display_name.localeCompare(right.display_name);
    });
    result = {
      season_id: String(season.season_id),
      binding_version: Number(season.binding_version || 0),
      roster_version: Number(season.roster_version || 0),
      generated_at: generatedAt.toISOString(),
      expires_at: new Date(generatedAt.getTime() + DRAGON_BOAT_PUBLIC_ROSTER_CACHE_SECONDS_ * 1000).toISOString(),
      members: members
    };
    // Oversized snapshots remain correct without caching; never truncate names.
    if (JSON.stringify(result).length < 25000) {
      try { cache.put(cacheKey, JSON.stringify(result), DRAGON_BOAT_PUBLIC_ROSTER_CACHE_SECONDS_); } catch (error) {}
    }
  }
  return Object.assign({}, result, { members: result.members.filter(function (member) {
    return includeInactive || member.active;
  }).map(function (member) {
    return { member_id: member.member_id, display_name: member.display_name, default_preference: member.default_preference };
  }) });
}

function getSeasonManagement_(request) {
  var sessionToken = requireRequestString_(request, "session_token", 32, 2048);
  validateCoachSession_(sessionToken);
  var season = requireSeason_(request.season_id);
  var templates = [];
  var weeks = [];
  var members = [];
  if (season.runtime_spreadsheet_id) {
    templates = getSeasonSheetRecords_(season, "ScheduleTemplates").filter(function (template) {
      return isTrue_(template.active);
    }).map(scheduleTemplateProjection_);
    weeks = getSeasonSheetRecords_(season, "TrainingWeeks").map(function (week) {
      return trainingWeekManagementProjection_(season, week);
    }).sort(function (left, right) {
      return left.week.week_start_date.localeCompare(right.week.week_start_date);
    });
    members = getSeasonSheetRecords_(season, "Members").map(function (member) {
      return {
        member_id: String(member.member_id),
        display_name: String(member.display_name_override || member.source_display_name),
        status: String(member.status),
        default_preference: String(member.default_preference || "AMBIENT"),
        member_version: Number(member.member_version || 0)
      };
    });
  }
  return {
    season: seasonManagementProjection_(season),
    is_default: getDefaultSeasonId_() === String(season.season_id),
    templates: templates,
    weeks: weeks,
    members: members
  };
}
