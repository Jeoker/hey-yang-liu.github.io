// P1 management changes use the same write-ahead journal and script lock as
// signup/seating. A retry replays the accepted plan, including after a deadline.
function applyScheduleRequest_(record) {
  var saved = readSystemRequestResult_(record);
  if (saved.kind !== "P1_MANAGEMENT" || !saved.plan || !saved.result) {
    throw dragonBoatRequestError_("RECOVERY_REQUIRED", "The schedule change needs recovery.", true);
  }
  if (String(record.status) === "COMPLETED") return saved.result;
  var plan = saved.plan;
  (plan.rows || []).forEach(function (change) {
    var season = change.runtime ? requireSeason_(plan.season_id) : null;
    var previous = change.runtime
      ? findSeasonSheetRecord_(season, change.sheet, change.key, change.row[change.key])
      : findRecord_(change.sheet, change.key, change.row[change.key]);
    var row = Object.assign({}, previous || {}, change.row);
    if (change.runtime) {
      if (previous) updateSeasonSheetRecord_(season, change.sheet, row);
      else appendSeasonSheetRecord_(season, change.sheet, row);
    } else if (previous) updateSheetRecord_(change.sheet, row);
    else appendSheetRecord_(change.sheet, row);
  });
  if (plan.runtime_audit) {
    var season = requireSeason_(plan.season_id);
    var eventId = deterministicEventId_(record, "SCHEDULE_COMMITTED");
    if (!findSeasonSheetRecord_(season, "AuditLog", "event_id", eventId)) {
      appendSeasonSheetRecord_(season, "AuditLog", {
        event_id: eventId, request_id: record.request_id, server_time: plan.at,
        season_id: plan.season_id, entity_type: plan.entity_type, entity_id: plan.entity_id,
        actor_type: plan.actor_type, actor_id: plan.actor_id, action: record.action,
        status: "SUCCEEDED", details_json: JSON.stringify(plan.details || {})
      });
    }
  }
  ensureSystemAuditEvent_(record, record.action, "SUCCEEDED", {
    season_id: plan.season_id, entity_id: plan.entity_id, actor_type: plan.actor_type,
    actor_id: plan.actor_id, details: plan.details || {}
  }, plan.actor_type);
  SpreadsheetApp.flush();
  completeSystemRequest_(record);
  SpreadsheetApp.flush();
  return saved.result;
}

function persistSchedulePlan_(scope, request, digest, plan, result) {
  var saved = { kind: "P1_MANAGEMENT", plan: plan, result: result };
  if (JSON.stringify(saved).length > 45000) {
    throw dragonBoatRequestError_("REQUEST_TOO_LARGE", "This schedule change is too large to save safely.");
  }
  var transaction = beginSystemRequest_(scope, request.action, request.request_id, digest, saved);
  SpreadsheetApp.flush();
  return applyScheduleRequest_(transaction.record);
}

function schedulePlanRow_(plan, sheet, key, row, runtime) {
  var clean = Object.assign({}, row);
  delete clean._rowNumber;
  plan.rows.push({ sheet: sheet, key: key, row: clean, runtime: runtime !== false });
}

function defaultSeasonSetting_() {
  var setting = findRecord_("SystemSettings", "setting_key", "default_season_id");
  return { default_season_id: setting ? String(setting.setting_value || "") : "",
    settings_version: setting ? Number(setting.settings_version || 0) : 0 };
}

function scheduleWeekChanged_(week, now) {
  week.week_version = Number(week.week_version) + 1;
  week.updated_at = now;
  if (String(week.status) !== "OPENED") {
    week.status = "DRAFT";
    week.scheduled_open_at = "";
    week.confirmed_version = "";
    week.confirmed_by = "";
    week.confirmed_at = "";
  }
}

function schedulePracticeValues_(request, season, week, rescheduling) {
  var date = requireIsoDate_(request.practice_date, "practice_date");
  var timezone = requireTimeZone_(request.timezone || season.timezone);
  var start = localDateTimeToIso_(date, requireLocalTime_(request.start_time, "start_time"), timezone);
  var end = localDateTimeToIso_(date, requireLocalTime_(request.end_time, "end_time"), timezone);
  if (end <= start) throw dragonBoatRequestError_("INVALID_TIME_RANGE", "A training must end after it starts.");
  var inSeasonZone = zonedDateTimeParts_(start, season.timezone);
  var seasonDate = inSeasonZone.year + "-" + inSeasonZone.month + "-" + inSeasonZone.day;
  if (!rescheduling && (seasonDate < String(week.week_start_date) || seasonDate > addCalendarDays_(String(week.week_start_date), 6))) {
    throw dragonBoatRequestError_("PRACTICE_OUTSIDE_WEEK", "Keep the training within its selected week.");
  }
  if (start < localDateTimeToIso_(String(season.start_date), "00:00", season.timezone) || end > season.season_ends_at) {
    throw dragonBoatRequestError_("PRACTICE_OUTSIDE_SEASON", "Both training times must be inside the season.");
  }
  if (Date.parse(start) <= Date.now()) throw dragonBoatRequestError_("PRACTICE_ALREADY_STARTED", "Choose a future training time.");
  return { start_at: start, end_at: end, timezone: timezone,
    signup_cutoff_at: new Date(Date.parse(start) - 7200000).toISOString(),
    location: requireRequestString_(request, "location", 1, 120),
    address: requireRequestString_(request, "address", 1, 240),
    map_url: requireSafeUrl_(request.map_url || "", "map_url", true) };
}

function practiceChangePreview_(request, season, practice, week) {
  ensureSeasonOpen_(season);
  if (practice.cancelled_at) throw dragonBoatRequestError_("PRACTICE_CANCELLED", "This training is already cancelled.");
  if (Date.parse(String(practice.start_at)) <= Date.now()) {
    throw dragonBoatRequestError_("PRACTICE_ALREADY_STARTED", "Started training schedules are read-only.");
  }
  var cancel = request.change === "CANCEL";
  if (!cancel && request.change !== "UPDATE") throw dragonBoatRequestError_("INVALID_REQUEST", "Specify UPDATE or CANCEL.");
  // Rescheduling preserves the original publication batch and all signup links,
  // even when the actual date moves into a different calendar week.
  var values = cancel ? {} : schedulePracticeValues_(request, season, week, true);
  var next = Object.assign({}, practice, values);
  var state = getSignupState_(season, practice.practice_id);
  var counts = signupCounts_(getPracticeSignups_(season, practice.practice_id), practice);
  var fingerprint = { season_id: season.season_id, season_version: Number(season.season_version),
    practice_id: practice.practice_id, practice_version: Number(practice.practice_version),
    week_version: Number(week.week_version), signup_version: state.version, change: request.change, values: values };
  return { season_id: String(season.season_id), practice_id: String(practice.practice_id),
    week_id: String(week.week_id), practice_version: Number(practice.practice_version),
    week_version: Number(week.week_version), signup_version: state.version,
    preview_token: digestRequestPayload_(fingerprint), change: request.change,
    before: practiceProjection_(practice), after: Object.assign(practiceProjection_(next), { cancelled: cancel }),
    confirmed_count: counts.confirmed, waitlisted_count: counts.waitlisted,
    cutoff_effect: cancel ? "CLOSE" : next.signup_cutoff_at === practice.signup_cutoff_at ? "UNCHANGED" : "RECALCULATED",
    invalidates_week_confirmation: String(week.status) === "SCHEDULED", values: values };
}

function previewPracticeChange_(request) {
  return withDragonBoatScriptLock_(function () {
    validateCoachSession_(requireRequestString_(request, "session_token", 32, 2048));
    var season = requireSeason_(request.season_id);
    var practice = requirePractice_(season, request.practice_id);
    return practiceChangePreview_(request, season, practice, requireTrainingWeek_(season, practice.week_id));
  });
}

function manageSchedule_(request) {
  return withDragonBoatScriptLock_(function () {
    var authenticated = validateCoachSession_(requireRequestString_(request, "session_token", 32, 2048));
    var actorId = String(authenticated.coach.coach_id);
    var scope = "P1M:" + actorId;
    var payload = {};
    Object.keys(request).sort().forEach(function (key) {
      if (["session_token", "request_id", "action"].indexOf(key) < 0) payload[key] = request[key];
    });
    var digest = digestRequestPayload_(payload);
    var previous = findMatchingSystemRequest_(scope, request.action, request.request_id, digest);
    if (previous) return attachScheduleView_(request, applyScheduleRequest_(previous));
    var season = requireSeason_(request.season_id);
    var legacy = legacyScheduleReplay_(actorId, request, season);
    if (legacy) return attachScheduleView_(request, legacy);
    var now = new Date().toISOString();
    var plan = { season_id: String(season.season_id), at: now, actor_type: "COACH", actor_id: actorId,
      entity_type: "SEASON", entity_id: String(season.season_id), rows: [], details: {}, runtime_audit: false };
    var result;
    if (request.action === "setDefaultSeason") {
      ensureSeasonOpen_(season);
      requireVersion_(season.season_version, request.season_version, "season");
      var setting = defaultSeasonSetting_();
      requireVersion_(setting.settings_version, request.settings_version, "default season");
      var nextSetting = { setting_key: "default_season_id", setting_value: season.season_id,
        settings_version: setting.settings_version + 1, updated_by: actorId, updated_at: now };
      schedulePlanRow_(plan, "SystemSettings", "setting_key", nextSetting, false);
      plan.details = { previous_season_id: setting.default_season_id, next_season_id: season.season_id };
      result = { default_season_id: String(season.season_id), settings_version: nextSetting.settings_version };
    } else if (request.action === "updateSeasonSchedule") {
      if (["DRAFT", "OPEN"].indexOf(seasonEffectiveStatus_(season)) < 0) {
        throw dragonBoatRequestError_("SEASON_NOT_OPEN", "A completed season cannot be reopened.");
      }
      requireVersion_(season.season_version, request.season_version, "season");
      var startDate = requireIsoDate_(request.start_date, "start_date");
      var endDate = requireIsoDate_(request.end_date, "end_date");
      var endAt = seasonEndsAt_(endDate, season.timezone);
      if (startDate > endDate || Date.parse(endAt) <= Date.now()) {
        throw dragonBoatRequestError_("INVALID_TIME_RANGE", "Choose a valid season range ending in the future.");
      }
      var startAt = localDateTimeToIso_(startDate, "00:00", season.timezone);
      var practices = season.runtime_spreadsheet_id ? getSeasonSheetRecords_(season, "Practices") : [];
      if (practices.some(function (practice) {
        return (!practice.cancelled_at || practice.schedule_published_at) &&
          (String(practice.start_at) < startAt || String(practice.end_at) > endAt);
      })) throw dragonBoatRequestError_("SEASON_SCHEDULE_CONFLICT", "Existing training or public history falls outside these dates. Resolve it before saving.");
      var patch = { season_id: season.season_id, start_date: startDate, end_date: endDate, season_ends_at: endAt,
        season_version: Number(season.season_version) + 1, updated_at: now };
      schedulePlanRow_(plan, "Seasons", "season_id", patch, false);
      plan.details = { before: { start_date: season.start_date, end_date: season.end_date }, after: patch };
      result = { season: seasonManagementProjection_(Object.assign({}, season, patch)) };
    } else if (request.action === "updateScheduleTemplates") {
      ensureSeasonOpen_(season);
      requireVersion_(season.season_version, request.season_version, "season");
      var templates = sanitizeScheduleTemplates_(season, request.templates);
      getSeasonSheetRecords_(season, "ScheduleTemplates").filter(function (row) { return isTrue_(row.active); }).forEach(function (row) {
        schedulePlanRow_(plan, "ScheduleTemplates", "template_id", { template_id: row.template_id, active: "FALSE",
          template_version: Number(row.template_version) + 1, updated_at: now });
      });
      var created = templates.map(function (template, index) {
        var row = Object.assign({}, template, { season_id: season.season_id,
          template_id: "template_" + hmacDigest_(buildSystemRequestKey_(scope, request.action, request.request_id) + "_" + index,
            getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET)).slice(0, 20),
          active: "TRUE", template_version: 1, created_at: now, updated_at: now });
        schedulePlanRow_(plan, "ScheduleTemplates", "template_id", row);
        return scheduleTemplateProjection_(row);
      });
      var seasonPatch = { season_id: season.season_id, season_version: Number(season.season_version) + 1, updated_at: now };
      schedulePlanRow_(plan, "Seasons", "season_id", seasonPatch, false);
      plan.runtime_audit = true;
      plan.details = { template_count: created.length };
      result = { season: seasonManagementProjection_(Object.assign({}, season, seasonPatch)), templates: created };
    } else {
      ensureSeasonOpen_(season);
      result = buildScheduleMutation_(request, season, plan);
    }
    return attachScheduleView_(request, persistSchedulePlan_(scope, request, digest, plan, result));
  });
}

function attachScheduleView_(request, result) {
  var response = Object.assign({}, result, { view_status: "reload_required" });
  try {
    var season = requireSeason_(request.season_id);
    var setting = defaultSeasonSetting_();
    var view = { season: seasonManagementProjection_(season), default_season_id: setting.default_season_id,
      settings_version: setting.settings_version };
    if (request.week_id) Object.assign(view, trainingWeekManagementProjection_(season, requireTrainingWeek_(season, request.week_id)));
    if (request.action === "updateScheduleTemplates") view.templates = getSeasonSheetRecords_(season, "ScheduleTemplates")
      .filter(function (row) { return isTrue_(row.active); }).map(scheduleTemplateProjection_);
    response.current_view = view;
    response.view_status = "ready";
  } catch (error) {
    // Committed work remains successful; the client retries only its read.
  }
  return response;
}

function buildScheduleMutation_(request, season, plan) {
  var now = plan.at;
  var actorId = plan.actor_id;
  plan.runtime_audit = true;
  var week = requireTrainingWeek_(season, request.week_id);
  requireVersion_(week.week_version, request.week_version, "training week");
  var practices = getSeasonSheetRecords_(season, "Practices").filter(function (row) { return String(row.week_id) === String(week.week_id); });
  var practice = null;
  plan.entity_type = "WEEK";
  plan.entity_id = String(week.week_id);
  if (request.action === "createPractice") {
    var values = schedulePracticeValues_(request, season, week);
    var practiceId = "practice_" + buildSystemRequestKey_(actorId, request.action, request.request_id).slice(4, 24);
    practice = Object.assign({ season_id: season.season_id, practice_id: practiceId, week_id: week.week_id,
      template_id: "", generation_key: "", left_capacity: 10, right_capacity: 10, practice_version: 1,
      cancelled_at: "", cancelled_by: "", schedule_published_at: "", schedule_published_by: "",
      created_at: now, updated_at: now }, values);
    practices.push(practice);
    scheduleWeekChanged_(week, now);
  } else if (request.action === "updatePractice" || request.action === "cancelPractice") {
    practice = requirePractice_(season, request.practice_id);
    if (String(practice.week_id) !== String(week.week_id)) throw dragonBoatRequestError_("PRACTICE_OUTSIDE_WEEK", "The training belongs to another week.");
    requireVersion_(practice.practice_version, request.practice_version, "training");
    requireVersion_(getSignupState_(season, practice.practice_id).version, request.signup_version, "signup list");
    var previewRequest = Object.assign({}, request, { change: request.action === "cancelPractice" ? "CANCEL" : "UPDATE" });
    var preview = practiceChangePreview_(previewRequest, season, practice, week);
    if (request.preview_token !== preview.preview_token) throw dragonBoatRequestError_("PREVIEW_STALE", "Preview the latest changes and confirm again.");
    plan.details = { before: preview.before, after: preview.after, signup_version: preview.signup_version };
    Object.assign(practice, preview.values);
    if (request.action === "cancelPractice") { practice.cancelled_at = now; practice.cancelled_by = actorId; }
    practice.practice_version = Number(practice.practice_version) + 1;
    practice.updated_at = now;
    scheduleWeekChanged_(week, now);
  } else if (request.action === "publishAdditionalPractice") {
    practice = requirePractice_(season, request.practice_id);
    requireVersion_(practice.practice_version, request.practice_version, "training");
    if (String(week.status) !== "OPENED" || String(practice.week_id) !== String(week.week_id)) {
      throw dragonBoatRequestError_("WEEK_NOT_OPEN", "Select an additional training in an open week.");
    }
    if (practice.cancelled_at || practice.schedule_published_at || Date.parse(practice.start_at) <= Date.now()) {
      throw dragonBoatRequestError_("PRACTICE_NOT_PUBLISHABLE", "Only a future, uncancelled draft can be published.");
    }
    practice.schedule_published_at = now; practice.schedule_published_by = actorId;
    practice.practice_version = Number(practice.practice_version) + 1; practice.updated_at = now;
    scheduleWeekChanged_(week, now);
  } else if (request.action === "confirmTrainingWeek" || request.action === "publishTrainingWeek") {
    if (["DRAFT", "SCHEDULED"].indexOf(String(week.status)) < 0) throw dragonBoatRequestError_("WEEK_ALREADY_OPEN", "This week is already public.");
    if (request.open_at && !Number.isFinite(Date.parse(String(request.open_at)))) {
      throw dragonBoatRequestError_("INVALID_REQUEST", "A valid opening time is required.");
    }
    if (request.open_at && request.open_date) throw dragonBoatRequestError_("INVALID_REQUEST", "Use one opening-time format.");
    var openAt = request.open_date
      ? localDateTimeToIso_(requireIsoDate_(request.open_date, "open_date"), requireLocalTime_(request.open_time, "open_time"), season.timezone)
      : request.open_at ? new Date(request.open_at).toISOString() : now;
    if (request.action === "publishTrainingWeek") {
      if (String(week.status) !== "SCHEDULED" || !week.scheduled_open_at || Date.parse(week.scheduled_open_at) > Date.now() || Number(week.confirmed_version) !== Number(week.week_version)) {
        throw dragonBoatRequestError_("WEEK_NOT_DUE", "This confirmed week is not due to open.");
      }
      openAt = now;
    }
    var active = practices.filter(function (row) { return !row.cancelled_at; });
    if (!active.length) throw dragonBoatRequestError_("WEEK_EMPTY", "Add at least one training before confirming the week.");
    if (request.action !== "publishTrainingWeek" && active.some(function (row) { return Date.parse(row.start_at) <= Math.max(Date.now(), Date.parse(openAt)); })) {
      throw dragonBoatRequestError_("OPEN_TIME_TOO_LATE", "Open the week before its first training starts.");
    }
    week.week_version = Number(week.week_version) + 1;
    week.confirmed_version = week.week_version; week.confirmed_at = now; week.confirmed_by = actorId;
    week.scheduled_open_at = openAt;
    week.status = Date.parse(openAt) <= Date.now() ? "OPENED" : "SCHEDULED";
    week.updated_at = now;
    if (week.status === "OPENED") {
      week.published_at = now;
      active.forEach(function (row) {
        row.schedule_published_at = now; row.schedule_published_by = actorId;
        row.practice_version = Number(row.practice_version) + 1; row.updated_at = now;
        schedulePlanRow_(plan, "Practices", "practice_id", row);
      });
    }
  } else throw dragonBoatRequestError_("UNSUPPORTED_ACTION", "Unsupported schedule change.");
  if (practice) {
    schedulePlanRow_(plan, "Practices", "practice_id", practice);
    practices = practices.map(function (row) { return row.practice_id === practice.practice_id ? practice : row; });
  }
  schedulePlanRow_(plan, "TrainingWeeks", "week_id", week);
  var result = trainingWeekManagementProjection_(season, week, practices);
  if (practice) result.practice = practiceProjection_(practice);
  return result;
}

// Preserve idempotency for clients retrying a P1 request accepted by Version 11.
// An incomplete legacy write without a durable plan cannot be guessed here.
function legacyScheduleReplay_(actorId, request, season) {
  var record = findRecord_("SystemRequests", "request_key", buildSystemRequestKey_(actorId, request.action, request.request_id));
  if (!record) return null;
  var oldPayload;
  if (request.action === "updateScheduleTemplates") {
    oldPayload = { season_id: season.season_id, season_version: Number(request.season_version), templates: sanitizeScheduleTemplates_(season, request.templates) };
  } else if (request.action === "confirmTrainingWeek" || request.action === "publishTrainingWeek") {
    if (request.open_date || request.open_time) throw dragonBoatRequestError_("IDEMPOTENCY_CONFLICT", "This request used different opening parameters.");
    oldPayload = { season_id: season.season_id, week_id: request.week_id, week_version: Number(request.week_version) };
    if (request.action === "confirmTrainingWeek") oldPayload.open_at = request.open_at ? new Date(request.open_at).toISOString() : "IMMEDIATE";
  } else if (request.action === "createPractice") {
    if (request.timezone && request.timezone !== season.timezone) throw dragonBoatRequestError_("IDEMPOTENCY_CONFLICT", "This request used a different timezone.");
    oldPayload = { season_id: season.season_id, week_id: request.week_id, week_version: Number(request.week_version),
      practice_date: request.practice_date, start_time: request.start_time, end_time: request.end_time,
      location: request.location, address: request.address, map_url: request.map_url || "" };
  } else if (request.action === "publishAdditionalPractice") {
    oldPayload = { season_id: season.season_id, week_id: request.week_id, practice_id: request.practice_id,
      week_version: Number(request.week_version), practice_version: Number(request.practice_version) };
  } else return null;
  findMatchingSystemRequest_(actorId, request.action, request.request_id, digestRequestPayload_(oldPayload));
  if (String(record.status) !== "COMPLETED") throw dragonBoatRequestError_("RECOVERY_REQUIRED", "An older schedule operation needs manual recovery before retry.", true);
  return readSystemRequestResult_(record);
}

function completeDueSeasons_() {
  getSheetRecords_("Seasons").forEach(function (season) {
    if (String(season.status) !== "OPEN" || seasonEffectiveStatus_(season) !== "COMPLETED") return;
    var request = { action: "completeSeason", request_id: "season_end_" + season.season_id };
    var plan = { season_id: String(season.season_id), at: String(season.season_ends_at), actor_type: "SYSTEM",
      actor_id: "season_clock", entity_id: String(season.season_id), rows: [], details: {}, runtime_audit: false };
    schedulePlanRow_(plan, "Seasons", "season_id", { season_id: season.season_id, status: "COMPLETED",
      completed_at: season.season_ends_at, updated_at: new Date().toISOString(), season_version: Number(season.season_version) + 1 }, false);
    var setting = defaultSeasonSetting_();
    if (setting.default_season_id === String(season.season_id)) {
      schedulePlanRow_(plan, "SystemSettings", "setting_key", { setting_key: "default_season_id", setting_value: "",
        settings_version: setting.settings_version + 1, updated_by: "season_clock", updated_at: plan.at }, false);
    }
    persistSchedulePlan_("P1M:SYSTEM", request, digestRequestPayload_({ season_id: season.season_id }), plan,
      { season_id: String(season.season_id), status: "COMPLETED" });
  });
}
