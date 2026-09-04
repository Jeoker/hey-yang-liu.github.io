function sanitizeScheduleTemplates_(season, templates) {
  if (!Array.isArray(templates) || templates.length < 1 || templates.length > 14) {
    throw dragonBoatRequestError_("INVALID_REQUEST", "One to fourteen training templates are required.");
  }
  return templates.map(function (template) {
    var dayOfWeek = Number(template.day_of_week);
    if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) {
      throw dragonBoatRequestError_("INVALID_REQUEST", "Each template requires a weekday from 1 to 7.");
    }
    var startTime = requireLocalTime_(template.start_time, "start_time");
    var endTime = requireLocalTime_(template.end_time, "end_time");
    if (endTime <= startTime) {
      throw dragonBoatRequestError_("INVALID_TIME_RANGE", "A training must end after it starts.");
    }
    return {
      day_of_week: dayOfWeek,
      start_time: startTime,
      end_time: endTime,
      timezone: season.timezone,
      location: requireRequestString_(template, "location", 1, 120),
      address: requireRequestString_(template, "address", 1, 240),
      map_url: requireSafeUrl_(template.map_url || "", "map_url", true)
    };
  });
}

function updateScheduleTemplates_(request) {
  var sessionToken = requireRequestString_(request, "session_token", 32, 2048);
  return withDragonBoatScriptLock_(function () {
    var authenticated = validateCoachSession_(sessionToken);
    var actorId = String(authenticated.coach.coach_id);
    var season = requireSeason_(request.season_id);
    ensureSeasonOpen_(season);
    var templates = sanitizeScheduleTemplates_(season, request.templates);
    var payloadDigest = digestRequestPayload_({
      season_id: season.season_id,
      season_version: Number(request.season_version),
      templates: templates
    });
    var transaction = beginSystemRequest_(actorId, "updateScheduleTemplates", request.request_id, payloadDigest, {
      season_id: season.season_id
    });
    if (String(transaction.record.status) === "COMPLETED") return readSystemRequestResult_(transaction.record);
    requireVersion_(season.season_version, request.season_version, "season");

    var existing = getSeasonSheetRecords_(season, "ScheduleTemplates");
    var now = new Date().toISOString();
    existing.forEach(function (template) {
      if (isTrue_(template.active)) {
        template.active = "FALSE";
        template.template_version = Number(template.template_version || 0) + 1;
        template.updated_at = now;
        updateSeasonSheetRecord_(season, "ScheduleTemplates", template);
      }
    });
    var created = [];
    templates.forEach(function (template, index) {
      var templateId = "template_" + hmacDigest_(
        transaction.record.request_key + "\n" + index,
        getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET)
      ).slice(0, 20);
      var record = findSeasonSheetRecord_(season, "ScheduleTemplates", "template_id", templateId);
      if (!record) {
        record = appendSeasonSheetRecord_(season, "ScheduleTemplates", {
          season_id: season.season_id,
          template_id: templateId,
          day_of_week: template.day_of_week,
          start_time: template.start_time,
          end_time: template.end_time,
          timezone: template.timezone,
          location: template.location,
          address: template.address,
          map_url: template.map_url,
          active: "TRUE",
          template_version: 1,
          created_at: now,
          updated_at: now
        });
      }
      created.push(scheduleTemplateProjection_(record));
    });
    season.season_version = Number(season.season_version || 0) + 1;
    season.updated_at = now;
    updateSheetRecord_("Seasons", season);
    appendSeasonAudit_(season, request.request_id, "COACH", actorId, "SCHEDULE_TEMPLATES_UPDATED", "SEASON", season.season_id, {
      template_count: created.length, season_version: Number(season.season_version)
    });
    var result = { season: seasonManagementProjection_(season), templates: created };
    setSystemRequestResult_(transaction.record, result);
    ensureSystemAuditEvent_(transaction.record, "SCHEDULE_TEMPLATES_UPDATED", "SUCCEEDED", {
      season_id: season.season_id, template_count: created.length
    });
    completeSystemRequest_(transaction.record);
    return result;
  });
}

function scheduleTemplateProjection_(template) {
  return {
    template_id: String(template.template_id),
    day_of_week: Number(template.day_of_week),
    start_time: String(template.start_time),
    end_time: String(template.end_time),
    timezone: String(template.timezone),
    location: String(template.location),
    address: String(template.address),
    map_url: String(template.map_url || ""),
    template_version: Number(template.template_version || 0)
  };
}

function updateTrainingWeek_(request) {
  var sessionToken = requireRequestString_(request, "session_token", 32, 2048);
  var weekStartDate = requireIsoDate_(request.week_start_date, "week_start_date");
  var weekStartParts = weekStartDate.split("-").map(Number);
  if (new Date(Date.UTC(weekStartParts[0], weekStartParts[1] - 1, weekStartParts[2])).getUTCDay() !== 1) {
    throw dragonBoatRequestError_("WEEK_START_NOT_MONDAY", "The training week must start on a Monday.");
  }
  return withDragonBoatScriptLock_(function () {
    var authenticated = validateCoachSession_(sessionToken);
    var actorId = String(authenticated.coach.coach_id);
    var season = requireSeason_(request.season_id);
    ensureSeasonOpen_(season);
    var payloadDigest = digestRequestPayload_({
      season_id: season.season_id,
      season_version: Number(request.season_version),
      week_start_date: weekStartDate
    });
    var weekId = "week_" + hmacDigest_(season.season_id + "\n" + weekStartDate, getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET)).slice(0, 20);
    var transaction = beginSystemRequest_(actorId, "updateTrainingWeek", request.request_id, payloadDigest, {
      kind: "TRAINING_WEEK_PLAN_V1", week_id: weekId, plan: null, result: null
    });
    var saved = readSystemRequestResult_(transaction.record);
    if (String(transaction.record.status) === "COMPLETED") {
      return saved.kind === "TRAINING_WEEK_PLAN_V1" ? saved.result : saved;
    }
    // A saved result is separate from the immutable plan, including before the completion write.
    var result = saved.kind === "TRAINING_WEEK_PLAN_V1" ? saved.result : (saved.week && Array.isArray(saved.practices) ? saved : null);
    if (!result) {
      var week = findSeasonSheetRecord_(season, "TrainingWeeks", "week_id", weekId);
      if (!saved.plan) {
        if (transaction.replayed && week) {
          throw dragonBoatRequestError_("RECOVERY_REQUIRED", "The unfinished training week has no saved generation plan. Review it before continuing.", true);
        }
        requireVersion_(season.season_version, request.season_version, "season");
        if (weekStartDate > season.end_date || addCalendarDays_(weekStartDate, 6) < season.start_date) {
          throw dragonBoatRequestError_("WEEK_OUTSIDE_SEASON", "The training week is outside the season.");
        }
        saved = {
          kind: "TRAINING_WEEK_PLAN_V1", week_id: weekId,
          plan: week ? { existing_week: true } : buildTrainingWeekGenerationPlan_(season, weekId, weekStartDate),
          result: null
        };
        // Persist every template instance before the first business row can be written.
        setSystemRequestResult_(transaction.record, saved);
        SpreadsheetApp.flush();
      }
      if (!saved.plan.existing_week) {
        week = applyTrainingWeekGenerationPlan_(season, saved.plan);
      } else if (!week) {
        throw dragonBoatRequestError_("RECOVERY_REQUIRED", "The existing training week could not be recovered.", true);
      }
      result = trainingWeekManagementProjection_(season, week);
      saved.result = result;
      setSystemRequestResult_(transaction.record, saved);
    }
    ensureTrainingWeekPreparedAudit_(season, transaction.record, actorId, result.week);
    completeSystemRequest_(transaction.record);
    return result;
  });
}

function buildTrainingWeekGenerationPlan_(season, weekId, weekStartDate) {
  var templates = getSeasonSheetRecords_(season, "ScheduleTemplates").filter(function (template) {
    return isTrue_(template.active);
  });
  if (!templates.length) {
    throw dragonBoatRequestError_("SCHEDULE_TEMPLATES_REQUIRED", "Configure at least one training template first.");
  }
  var now = new Date().toISOString();
  var plan = {
    week: {
      season_id: season.season_id, week_id: weekId, week_start_date: weekStartDate,
      scheduled_open_at: "", status: "DRAFT", week_version: 1,
      confirmed_version: "", confirmed_by: "", confirmed_at: "", published_at: "",
      created_at: now, updated_at: now
    },
    practices: []
  };
  templates.forEach(function (template) {
    var practiceDate = addCalendarDays_(weekStartDate, Number(template.day_of_week) - 1);
    if (practiceDate < season.start_date || practiceDate > season.end_date) return;
    plan.practices.push({
      practice_id: "practice_" + hmacDigest_(weekId + "\n" + template.template_id, getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET)).slice(0, 20),
      template_id: template.template_id,
      generation_key: season.season_id + ":" + weekId + ":" + template.template_id,
      start_at: localDateTimeToIso_(practiceDate, String(template.start_time), season.timezone),
      end_at: localDateTimeToIso_(practiceDate, String(template.end_time), season.timezone),
      location: template.location, address: template.address, map_url: template.map_url, now: now
    });
  });
  return plan;
}

function applyTrainingWeekGenerationPlan_(season, plan) {
  var week = findSeasonSheetRecord_(season, "TrainingWeeks", "week_id", plan.week.week_id);
  if (!week) week = appendSeasonSheetRecord_(season, "TrainingWeeks", plan.week);
  plan.practices.forEach(function (values) {
    var existing = findSeasonSheetRecord_(season, "Practices", "practice_id", values.practice_id);
    // Adjusted instances and cancellation tombstones remain authoritative.
    if (existing) return;
    if (String(week.status) !== "DRAFT") {
      throw dragonBoatRequestError_("RECOVERY_REQUIRED", "The unfinished training week changed before recovery. Review it before continuing.", true);
    }
    createPracticeRecord_(season, week, values);
  });
  return week;
}

function ensureTrainingWeekPreparedAudit_(season, requestRecord, actorId, week) {
  var eventId = deterministicEventId_(requestRecord, "TRAINING_WEEK_PREPARED");
  var existing = getSeasonSheetRecords_(season, "AuditLog").some(function (event) {
    return String(event.event_id) === eventId || (
      String(event.request_id) === String(requestRecord.request_id) &&
      String(event.actor_id) === actorId && String(event.action) === "TRAINING_WEEK_PREPARED" &&
      String(event.entity_id) === String(week.week_id)
    );
  });
  if (existing) return;
  appendSeasonSheetRecord_(season, "AuditLog", {
    event_id: eventId, request_id: requestRecord.request_id, server_time: new Date().toISOString(),
    season_id: season.season_id, entity_type: "WEEK", entity_id: week.week_id,
    actor_type: "COACH", actor_id: actorId, action: "TRAINING_WEEK_PREPARED", status: "SUCCEEDED",
    details_json: JSON.stringify({ week_version: Number(week.week_version) })
  });
}

function createPracticeRecord_(season, week, values) {
  var existing = findSeasonSheetRecord_(season, "Practices", "practice_id", values.practice_id);
  if (existing) return existing;
  if (Date.parse(values.end_at) <= Date.parse(values.start_at)) {
    throw dragonBoatRequestError_("INVALID_TIME_RANGE", "A training must end after it starts.");
  }
  if (values.start_at < localDateTimeToIso_(season.start_date, "00:00", season.timezone) || values.start_at >= season.season_ends_at) {
    throw dragonBoatRequestError_("PRACTICE_OUTSIDE_SEASON", "The training is outside the season.");
  }
  return appendSeasonSheetRecord_(season, "Practices", {
    season_id: season.season_id,
    practice_id: values.practice_id,
    week_id: week.week_id,
    template_id: values.template_id || "",
    generation_key: values.generation_key || "",
    start_at: values.start_at,
    end_at: values.end_at,
    timezone: season.timezone,
    location: values.location,
    address: values.address,
    map_url: values.map_url || "",
    left_capacity: 10,
    right_capacity: 10,
    signup_cutoff_at: new Date(Date.parse(values.start_at) - 2 * 60 * 60 * 1000).toISOString(),
    practice_version: 1,
    cancelled_at: "",
    cancelled_by: "",
    schedule_published_at: "",
    schedule_published_by: "",
    created_at: values.now,
    updated_at: values.now
  });
}

function confirmTrainingWeek_(request) {
  var sessionToken = requireRequestString_(request, "session_token", 32, 2048);
  return withDragonBoatScriptLock_(function () {
    var authenticated = validateCoachSession_(sessionToken);
    var actorId = String(authenticated.coach.coach_id);
    var season = requireSeason_(request.season_id);
    ensureSeasonOpen_(season);
    var week = requireTrainingWeek_(season, request.week_id);
    var requestedOpenAt = "IMMEDIATE";
    var openAt = new Date().toISOString();
    if (request.open_at) {
      var parsedOpenAt = Date.parse(String(request.open_at));
      if (!Number.isFinite(parsedOpenAt)) {
        throw dragonBoatRequestError_("INVALID_REQUEST", "A valid open_at time is required.");
      }
      openAt = new Date(parsedOpenAt).toISOString();
      requestedOpenAt = openAt;
    }
    var payloadDigest = digestRequestPayload_({
      season_id: season.season_id,
      week_id: week.week_id,
      week_version: Number(request.week_version),
      open_at: requestedOpenAt
    });
    var transaction = beginSystemRequest_(actorId, "confirmTrainingWeek", request.request_id, payloadDigest, {
      week_id: week.week_id
    });
    if (String(transaction.record.status) === "COMPLETED") return readSystemRequestResult_(transaction.record);
    if (String(week.status) === "OPENED" && transaction.replayed) {
      var recovered = trainingWeekManagementProjection_(season, week);
      setSystemRequestResult_(transaction.record, recovered);
      completeSystemRequest_(transaction.record);
      return recovered;
    }
    requireVersion_(week.week_version, request.week_version, "training week");
    if (String(week.status) !== "DRAFT" && String(week.status) !== "SCHEDULED") {
      throw dragonBoatRequestError_("WEEK_ALREADY_OPEN", "This training week is already open.");
    }
    var now = new Date().toISOString();
    week.scheduled_open_at = openAt;
    week.confirmed_version = Number(week.week_version);
    week.confirmed_by = actorId;
    week.confirmed_at = now;
    week.status = Date.parse(openAt) <= Date.now() ? "OPENED" : "SCHEDULED";
    week.updated_at = now;
    if (week.status === "OPENED") publishInitialWeekRecords_(season, week, actorId, now);
    updateSeasonSheetRecord_(season, "TrainingWeeks", week);
    var result = trainingWeekManagementProjection_(season, week);
    setSystemRequestResult_(transaction.record, result);
    appendSeasonAudit_(season, request.request_id, "COACH", actorId, "TRAINING_WEEK_CONFIRMED", "WEEK", week.week_id, {
      status: week.status, scheduled_open_at: openAt, week_version: Number(week.week_version)
    });
    completeSystemRequest_(transaction.record);
    return result;
  });
}

function publishInitialWeekRecords_(season, week, actorId, now) {
  if (Number(week.confirmed_version) !== Number(week.week_version)) {
    throw dragonBoatRequestError_("WEEK_CONFIRMATION_STALE", "The training week changed after confirmation.");
  }
  getSeasonSheetRecords_(season, "Practices").filter(function (practice) {
    return String(practice.week_id) === String(week.week_id) && !practice.schedule_published_at && !practice.cancelled_at;
  }).forEach(function (practice) {
    practice.schedule_published_at = now;
    practice.schedule_published_by = actorId;
    practice.practice_version = Number(practice.practice_version || 0) + 1;
    practice.updated_at = now;
    updateSeasonSheetRecord_(season, "Practices", practice);
  });
  week.published_at = week.published_at || now;
}

function publishTrainingWeek_(request) {
  var sessionToken = requireRequestString_(request, "session_token", 32, 2048);
  return withDragonBoatScriptLock_(function () {
    var authenticated = validateCoachSession_(sessionToken);
    var season = requireSeason_(request.season_id);
    ensureSeasonOpen_(season);
    var week = requireTrainingWeek_(season, request.week_id);
    var actorId = String(authenticated.coach.coach_id);
    var payloadDigest = digestRequestPayload_({
      season_id: season.season_id,
      week_id: week.week_id,
      week_version: Number(request.week_version)
    });
    var transaction = beginSystemRequest_(actorId, "publishTrainingWeek", request.request_id, payloadDigest, {
      week_id: week.week_id
    });
    if (String(transaction.record.status) === "COMPLETED") return readSystemRequestResult_(transaction.record);
    if (String(week.status) === "OPENED" && transaction.replayed) {
      var recovered = trainingWeekManagementProjection_(season, week);
      setSystemRequestResult_(transaction.record, recovered);
      completeSystemRequest_(transaction.record);
      return recovered;
    }
    if (String(week.status) !== "SCHEDULED" || Date.parse(String(week.scheduled_open_at)) > Date.now()) {
      throw dragonBoatRequestError_("WEEK_NOT_DUE", "This training week is not due to open.");
    }
    requireVersion_(week.week_version, request.week_version, "training week");
    var now = new Date().toISOString();
    publishInitialWeekRecords_(season, week, actorId, now);
    week.status = "OPENED";
    week.updated_at = now;
    updateSeasonSheetRecord_(season, "TrainingWeeks", week);
    var result = trainingWeekManagementProjection_(season, week);
    setSystemRequestResult_(transaction.record, result);
    appendSeasonAudit_(season, request.request_id, "COACH", actorId, "TRAINING_WEEK_PUBLISHED", "WEEK", week.week_id, {
      week_version: Number(week.week_version)
    });
    completeSystemRequest_(transaction.record);
    return result;
  });
}

function publishDueTrainingWeeks() {
  return withDragonBoatScriptLock_(function () {
    var now = new Date();
    var publishedCount = 0;
    getSheetRecords_("Seasons").forEach(function (season) {
      if (seasonEffectiveStatus_(season, now) !== "OPEN" || !season.runtime_spreadsheet_id) return;
      getSeasonSheetRecords_(season, "TrainingWeeks").forEach(function (week) {
        if (
          String(week.status) !== "SCHEDULED" ||
          Date.parse(String(week.scheduled_open_at)) > now.getTime() ||
          Number(week.confirmed_version) !== Number(week.week_version)
        ) return;
        var publishedAt = now.toISOString();
        var actorId = String(week.confirmed_by || "scheduled_publisher");
        publishInitialWeekRecords_(season, week, actorId, publishedAt);
        week.status = "OPENED";
        week.updated_at = publishedAt;
        updateSeasonSheetRecord_(season, "TrainingWeeks", week);
        appendSeasonAudit_(season, "scheduled_publish", "SYSTEM", actorId, "TRAINING_WEEK_PUBLISHED", "WEEK", week.week_id, {
          source: "SCHEDULED_TRIGGER", week_version: Number(week.week_version)
        });
        publishedCount += 1;
      });
    });
    var frozenCount = freezeDueSeatPlans_();
    return { published_count: publishedCount, frozen_seat_plan_count: frozenCount, checked_at: now.toISOString() };
  });
}

function createPractice_(request) {
  var sessionToken = requireRequestString_(request, "session_token", 32, 2048);
  var practiceDate = requireIsoDate_(request.practice_date, "practice_date");
  var startTime = requireLocalTime_(request.start_time, "start_time");
  var endTime = requireLocalTime_(request.end_time, "end_time");
  if (endTime <= startTime) throw dragonBoatRequestError_("INVALID_TIME_RANGE", "A training must end after it starts.");
  var location = requireRequestString_(request, "location", 1, 120);
  var address = requireRequestString_(request, "address", 1, 240);
  var mapUrl = requireSafeUrl_(request.map_url || "", "map_url", true);
  return withDragonBoatScriptLock_(function () {
    var authenticated = validateCoachSession_(sessionToken);
    var actorId = String(authenticated.coach.coach_id);
    var season = requireSeason_(request.season_id);
    ensureSeasonOpen_(season);
    var week = requireTrainingWeek_(season, request.week_id);
    if (String(week.status) !== "OPENED") {
      throw dragonBoatRequestError_("WEEK_NOT_OPEN", "Additional training can be added only after the week is open.");
    }
    var payloadDigest = digestRequestPayload_({
      season_id: season.season_id, week_id: week.week_id, week_version: Number(request.week_version),
      practice_date: practiceDate, start_time: startTime, end_time: endTime,
      location: location, address: address, map_url: mapUrl
    });
    var practiceId = "practice_" + buildSystemRequestKey_(actorId, "createPractice", request.request_id).slice(4, 24);
    var transaction = beginSystemRequest_(actorId, "createPractice", request.request_id, payloadDigest, { practice_id: practiceId });
    if (String(transaction.record.status) === "COMPLETED") return readSystemRequestResult_(transaction.record);
    requireVersion_(week.week_version, request.week_version, "training week");
    var now = new Date().toISOString();
    var practice = createPracticeRecord_(season, week, {
      practice_id: practiceId,
      template_id: "",
      generation_key: "",
      start_at: localDateTimeToIso_(practiceDate, startTime, season.timezone),
      end_at: localDateTimeToIso_(practiceDate, endTime, season.timezone),
      location: location,
      address: address,
      map_url: mapUrl,
      now: now
    });
    week.week_version = Number(week.week_version || 0) + 1;
    week.confirmed_version = "";
    week.updated_at = now;
    updateSeasonSheetRecord_(season, "TrainingWeeks", week);
    var weekProjection = trainingWeekManagementProjection_(season, week);
    var result = { week: weekProjection.week, practices: weekProjection.practices, practice: practiceProjection_(practice) };
    setSystemRequestResult_(transaction.record, result);
    appendSeasonAudit_(season, request.request_id, "COACH", actorId, "ADDITIONAL_PRACTICE_CREATED", "PRACTICE", practice.practice_id, {
      week_id: week.week_id, week_version: Number(week.week_version)
    });
    completeSystemRequest_(transaction.record);
    return result;
  });
}

function publishAdditionalPractice_(request) {
  var sessionToken = requireRequestString_(request, "session_token", 32, 2048);
  return withDragonBoatScriptLock_(function () {
    var authenticated = validateCoachSession_(sessionToken);
    var actorId = String(authenticated.coach.coach_id);
    var season = requireSeason_(request.season_id);
    ensureSeasonOpen_(season);
    var week = requireTrainingWeek_(season, request.week_id);
    var practice = requirePractice_(season, request.practice_id);
    if (String(practice.week_id) !== String(week.week_id)) {
      throw dragonBoatRequestError_("PRACTICE_SEASON_MISMATCH", "The training does not belong to this week.");
    }
    var payloadDigest = digestRequestPayload_({
      season_id: season.season_id, week_id: week.week_id, practice_id: practice.practice_id,
      week_version: Number(request.week_version), practice_version: Number(request.practice_version)
    });
    var transaction = beginSystemRequest_(actorId, "publishAdditionalPractice", request.request_id, payloadDigest, {
      practice_id: practice.practice_id
    });
    if (String(transaction.record.status) === "COMPLETED") return readSystemRequestResult_(transaction.record);
    requireVersion_(week.week_version, request.week_version, "training week");
    requireVersion_(practice.practice_version, request.practice_version, "training");
    if (String(week.status) !== "OPENED") throw dragonBoatRequestError_("WEEK_NOT_OPEN", "The training week is not open.");
    if (practice.schedule_published_at) throw dragonBoatRequestError_("PRACTICE_ALREADY_PUBLISHED", "This training is already public.");
    var now = new Date().toISOString();
    practice.schedule_published_at = now;
    practice.schedule_published_by = actorId;
    practice.practice_version = Number(practice.practice_version || 0) + 1;
    practice.updated_at = now;
    updateSeasonSheetRecord_(season, "Practices", practice);
    week.week_version = Number(week.week_version || 0) + 1;
    week.updated_at = now;
    updateSeasonSheetRecord_(season, "TrainingWeeks", week);
    var weekProjection = trainingWeekManagementProjection_(season, week);
    var result = { week: weekProjection.week, practices: weekProjection.practices, practice: practiceProjection_(practice) };
    setSystemRequestResult_(transaction.record, result);
    appendSeasonAudit_(season, request.request_id, "COACH", actorId, "ADDITIONAL_PRACTICE_PUBLISHED", "PRACTICE", practice.practice_id, {
      week_id: week.week_id, week_version: Number(week.week_version)
    });
    completeSystemRequest_(transaction.record);
    return result;
  });
}

function requireTrainingWeek_(season, weekId) {
  var week = findSeasonSheetRecord_(season, "TrainingWeeks", "week_id", weekId);
  if (!week) throw dragonBoatRequestError_("WEEK_NOT_FOUND", "The training week does not exist.");
  return week;
}

function requirePractice_(season, practiceId) {
  var practice = findSeasonSheetRecord_(season, "Practices", "practice_id", practiceId);
  if (!practice) throw dragonBoatRequestError_("PRACTICE_NOT_FOUND", "The training does not exist.");
  return practice;
}

function practiceProjection_(practice) {
  return {
    practice_id: String(practice.practice_id),
    week_id: String(practice.week_id),
    start_at: String(practice.start_at),
    end_at: String(practice.end_at),
    timezone: String(practice.timezone),
    location: String(practice.location),
    address: String(practice.address),
    map_url: String(practice.map_url || ""),
    signup_cutoff_at: String(practice.signup_cutoff_at),
    left_capacity: Number(practice.left_capacity),
    right_capacity: Number(practice.right_capacity),
    practice_version: Number(practice.practice_version || 0),
    schedule_published_at: String(practice.schedule_published_at || ""),
    cancelled: Boolean(practice.cancelled_at),
    archive_due_at: seatPlanArchiveDueAt_(practice)
  };
}

function trainingWeekManagementProjection_(season, week) {
  var practices = getSeasonSheetRecords_(season, "Practices").filter(function (practice) {
    return String(practice.week_id) === String(week.week_id);
  }).map(practiceProjection_).sort(function (left, right) {
    return left.start_at.localeCompare(right.start_at);
  });
  return {
    week: {
      week_id: String(week.week_id),
      week_start_date: String(week.week_start_date),
      scheduled_open_at: String(week.scheduled_open_at || ""),
      status: String(week.status),
      week_version: Number(week.week_version || 0),
      confirmed_version: week.confirmed_version === "" ? null : Number(week.confirmed_version),
      confirmed_at: String(week.confirmed_at || ""),
      published_at: String(week.published_at || "")
    },
    practices: practices
  };
}
