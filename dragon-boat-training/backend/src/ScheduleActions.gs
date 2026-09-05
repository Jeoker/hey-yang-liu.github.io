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
        var request = { action: "publishTrainingWeek", request_id: "due_" + week.week_id + "_" + week.week_version,
          week_id: week.week_id, week_version: Number(week.week_version) };
        var plan = { season_id: String(season.season_id), at: now.toISOString(), actor_type: "SYSTEM",
          actor_id: String(week.confirmed_by || "scheduled_publisher"), rows: [], details: {}, runtime_audit: true };
        var result = buildScheduleMutation_(request, season, plan);
        persistSchedulePlan_("P1M:SCHEDULER", request, digestRequestPayload_({ week_id: week.week_id, week_version: request.week_version }), plan, result);
        publishedCount += 1;
      });
    });
    var archive = runDueArchivesUnlocked_();
    return { published_count: publishedCount, frozen_seat_plan_count: archive.frozen_count,
      practice_archived_count: archive.practice_archived_count,
      season_archived_count: archive.season_archived_count, checked_at: now.toISOString() };
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
    updated_at: String(practice.updated_at || ""),
    schedule_changed_at: String(practice.schedule_published_at || "") && String(practice.updated_at || "") > String(practice.schedule_published_at) ? String(practice.updated_at) : "",
    archive_due_at: seatPlanArchiveDueAt_(practice)
  };
}

function trainingWeekManagementProjection_(season, week, plannedPractices) {
  var practices = (plannedPractices || getSeasonSheetRecords_(season, "Practices")).filter(function (practice) {
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
