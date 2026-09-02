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
  if (season.runtime_spreadsheet_id) {
    published = getSeasonSheetRecords_(season, "Practices").filter(function (practice) {
      return Boolean(practice.schedule_published_at) && !practice.cancelled_at;
    }).map(practiceProjection_).sort(function (left, right) {
      return left.start_at.localeCompare(right.start_at);
    });
  }
  var byWeek = {};
  published.forEach(function (practice) {
    if (!byWeek[practice.week_id]) byWeek[practice.week_id] = [];
    byWeek[practice.week_id].push(practice);
  });
  var weekRecords = season.runtime_spreadsheet_id ? getSeasonSheetRecords_(season, "TrainingWeeks") : [];
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
    return Date.parse(practice.end_at) > Date.now();
  }).length;
  return {
    state: effectiveStatus === "OPEN" ? (upcomingCount ? "ACTIVE" : "REST") : effectiveStatus,
    season: seasonPublicProjection_(season),
    weeks: weeks
  };
}

function publicMembers_(request) {
  var seasonId = requireRequestString_(request, "season_id", 8, 128);
  var season = requireSeason_(seasonId);
  ensureSeasonOpen_(season);
  var cacheKey = [
    "public_members",
    season.season_id,
    Number(season.binding_version || 0),
    Number(season.roster_version || 0)
  ].join("_");
  var cache = CacheService.getScriptCache();
  var cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (error) {}
  }
  return withDragonBoatScriptLock_(function () {
    var secondRead = cache.get(cacheKey);
    if (secondRead) {
      try { return JSON.parse(secondRead); } catch (error) {}
    }
    season = requireSeason_(seasonId);
    ensureSeasonOpen_(season);
    var generatedAt = new Date();
    var members = getSeasonSheetRecords_(season, "Members").filter(function (member) {
      return String(member.status) === "ACTIVE";
    }).map(function (member) {
      return {
        member_id: String(member.member_id),
        display_name: String(member.display_name_override || member.source_display_name),
        default_preference: String(member.default_preference || "AMBIENT")
      };
    }).sort(function (left, right) {
      return left.display_name.localeCompare(right.display_name);
    });
    var result = {
      season_id: String(season.season_id),
      binding_version: Number(season.binding_version || 0),
      roster_version: Number(season.roster_version || 0),
      generated_at: generatedAt.toISOString(),
      expires_at: new Date(generatedAt.getTime() + DRAGON_BOAT_PUBLIC_ROSTER_CACHE_SECONDS_ * 1000).toISOString(),
      members: members
    };
    cache.put(cacheKey, JSON.stringify(result), DRAGON_BOAT_PUBLIC_ROSTER_CACHE_SECONDS_);
    return result;
  });
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
