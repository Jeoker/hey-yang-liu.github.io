function createSeason_(request) {
  var sessionToken = requireRequestString_(request, "session_token", 32, 2048);
  var name = requireRequestString_(request, "name", 1, 120);
  var startDate = requireIsoDate_(request.start_date, "start_date");
  var endDate = requireIsoDate_(request.end_date, "end_date");
  var timeZone = requireTimeZone_(request.timezone);
  if (startDate > endDate) {
    throw dragonBoatRequestError_("INVALID_DATE_RANGE", "The season end date must not be before its start date.");
  }
  var endsAt = seasonEndsAt_(endDate, timeZone);

  return withDragonBoatScriptLock_(function () {
    var authenticated = validateCoachSession_(sessionToken);
    var actorId = String(authenticated.coach.coach_id);
    var payloadDigest = digestRequestPayload_({
      name: name, start_date: startDate, end_date: endDate, timezone: timeZone
    });
    var seasonId = "season_" + buildSystemRequestKey_(actorId, "createSeason", request.request_id).slice(4, 28);
    var transaction = beginSystemRequest_(actorId, "createSeason", request.request_id, payloadDigest, {
      season_id: seasonId
    });
    var planned = readSystemRequestResult_(transaction.record);
    var season = findSeasonById_(planned.season_id);
    if (!season) {
      var now = new Date().toISOString();
      season = appendSheetRecord_("Seasons", {
        season_id: planned.season_id,
        name: name,
        start_date: startDate,
        end_date: endDate,
        timezone: timeZone,
        season_ends_at: endsAt,
        status: "DRAFT",
        form_id: "",
        form_url: "",
        runtime_spreadsheet_id: "",
        response_sheet_id: "",
        response_sheet_name: "",
        field_mapping_json: "",
        schema_fingerprint: "",
        binding_version: 0,
        season_version: 1,
        roster_version: 0,
        initialization_status: "NOT_STARTED",
        trigger_id: "",
        last_sync_at: "",
        activated_at: "",
        completed_at: "",
        archived_at: "",
        created_by: actorId,
        created_at: now,
        updated_at: now
      });
    }
    var result = { season: seasonManagementProjection_(season) };
    setSystemRequestResult_(transaction.record, result);
    ensureSystemAuditEvent_(transaction.record, "SEASON_CREATED", "SUCCEEDED", {
      season_id: season.season_id
    });
    completeSystemRequest_(transaction.record);
    return result;
  });
}

function validateSeasonBindingAction_(request) {
  var sessionToken = requireRequestString_(request, "session_token", 32, 2048);
  validateCoachSession_(sessionToken);
  var season = requireSeason_(request.season_id);
  if (String(season.status) !== "DRAFT") {
    throw dragonBoatRequestError_("BINDING_LOCKED", "The active season binding cannot be replaced.");
  }
  return inspectSeasonBinding_(season, request);
}

function inspectSeasonBinding_(season, request) {
  var formId = extractGoogleFileId_(request.form, "form");
  var spreadsheetId = extractGoogleFileId_(request.spreadsheet, "spreadsheet");
  var responseSheetSelector = requireRequestString_(request, "response_sheet", 1, 200);
  var displayNameHeader = requireRequestString_(request, "display_name_header", 1, 200);
  var form;
  var spreadsheet;
  try {
    form = FormApp.openById(formId);
  } catch (error) {
    throw dragonBoatRequestError_("BINDING_FORM_UNAVAILABLE", "The Google Form cannot be opened by the deployment account.");
  }
  try {
    spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  } catch (error) {
    throw dragonBoatRequestError_("BINDING_SHEET_UNAVAILABLE", "The response Spreadsheet cannot be opened by the deployment account.");
  }

  if (String(form.getDestinationId() || "") !== spreadsheetId) {
    throw dragonBoatRequestError_("BINDING_DESTINATION_MISMATCH", "The Google Form is not connected to this response Spreadsheet.");
  }

  var responseSheet = spreadsheet.getSheetByName(responseSheetSelector);
  if (!responseSheet && /^\d+$/.test(responseSheetSelector)) {
    var responseSheetId = Number(responseSheetSelector);
    spreadsheet.getSheets().some(function (candidate) {
      if (Number(candidate.getSheetId()) === responseSheetId) {
        responseSheet = candidate;
        return true;
      }
      return false;
    });
  }
  if (!responseSheet) {
    throw dragonBoatRequestError_("BINDING_RESPONSE_TAB_MISSING", "The response tab does not exist.");
  }

  var linkedFormUrl = typeof responseSheet.getFormUrl === "function" ? responseSheet.getFormUrl() : "";
  if (!linkedFormUrl || extractGoogleFileId_(linkedFormUrl, "response tab form") !== formId) {
    throw dragonBoatRequestError_("BINDING_RESPONSE_TAB_MISMATCH", "The selected tab does not belong to this Google Form.");
  }

  var lastColumn = responseSheet.getLastColumn();
  if (responseSheet.getLastRow() < 1 || lastColumn < 1) {
    throw dragonBoatRequestError_("BINDING_HEADERS_MISSING", "The response tab does not contain a header row.");
  }
  var headers = responseSheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function (value) {
    return String(value).trim();
  });
  var matchingColumns = [];
  headers.forEach(function (header, index) {
    if (header === displayNameHeader) matchingColumns.push(index);
  });
  if (matchingColumns.length !== 1) {
    throw dragonBoatRequestError_(
      matchingColumns.length ? "BINDING_FIELD_AMBIGUOUS" : "BINDING_FIELD_MISSING",
      "The selected display-name column must exist exactly once."
    );
  }

  var responseSheetIdValue = String(responseSheet.getSheetId());
  getSheetRecords_("Seasons").forEach(function (other) {
    if (
      String(other.season_id) !== String(season.season_id) &&
      String(other.runtime_spreadsheet_id) === spreadsheetId &&
      String(other.response_sheet_id) === responseSheetIdValue
    ) {
      throw dragonBoatRequestError_("BINDING_ALREADY_USED", "This response tab is already bound to another season.");
    }
  });

  var preview = [];
  var lastRow = responseSheet.getLastRow();
  if (lastRow > 1) {
    var previewRows = Math.min(lastRow - 1, 5);
    preview = responseSheet.getRange(2, matchingColumns[0] + 1, previewRows, 1).getValues().map(function (row) {
      return String(row[0] || "").trim();
    }).filter(Boolean);
  }
  var publishedUrl = requireSafeUrl_(String(form.getPublishedUrl() || ""), "published form URL", false);
  var schemaFingerprint = digestRequestPayload_({
    spreadsheet_id: spreadsheetId,
    response_sheet_id: responseSheetIdValue,
    headers: headers
  });
  return {
    form_id: formId,
    form_url: publishedUrl,
    runtime_spreadsheet_id: spreadsheetId,
    response_sheet_id: responseSheetIdValue,
    response_sheet_name: responseSheet.getName(),
    display_name_header: displayNameHeader,
    display_name_column: matchingColumns[0] + 1,
    schema_fingerprint: schemaFingerprint,
    response_count: Math.max(0, lastRow - 1),
    preview_names: preview
  };
}

function initializeSeason_(request) {
  var sessionToken = requireRequestString_(request, "session_token", 32, 2048);
  return withDragonBoatScriptLock_(function () {
    var authenticated = validateCoachSession_(sessionToken);
    var actorId = String(authenticated.coach.coach_id);
    var season = requireSeason_(request.season_id);
    var requestedFormId = extractGoogleFileId_(request.form, "form");
    var requestedSpreadsheetId = extractGoogleFileId_(request.spreadsheet, "spreadsheet");
    var requestedResponseSheet = requireRequestString_(request, "response_sheet", 1, 200);
    var requestedNameHeader = requireRequestString_(request, "display_name_header", 1, 200);
    var payloadDigest = digestRequestPayload_({
      season_id: season.season_id,
      season_version: Number(request.season_version),
      form_id: requestedFormId,
      runtime_spreadsheet_id: requestedSpreadsheetId,
      response_sheet: requestedResponseSheet,
      display_name_header: requestedNameHeader
    });
    var transaction = beginSystemRequest_(actorId, "initializeSeason", request.request_id, payloadDigest, {
      season_id: season.season_id
    });
    if (String(transaction.record.status) === "COMPLETED") {
      return readSystemRequestResult_(transaction.record);
    }
    if (
      String(season.status) === "OPEN" &&
      String(season.form_id) === requestedFormId &&
      String(season.runtime_spreadsheet_id) === requestedSpreadsheetId &&
      String(season.response_sheet_name) === requestedResponseSheet
    ) {
      var recovered = {
        season: seasonManagementProjection_(season),
        sync: {
          imported_count: 0,
          failed_count: 0,
          total_member_count: getSeasonSheetRecords_(season, "Members").length,
          roster_version: Number(season.roster_version),
          last_sync_at: String(season.last_sync_at)
        },
        default_season_id: getDefaultSeasonId_()
      };
      setSystemRequestResult_(transaction.record, recovered);
      ensureSystemAuditEvent_(transaction.record, "SEASON_INITIALIZED", "SUCCEEDED", {
        season_id: season.season_id,
        recovered: true,
        binding_version: Number(season.binding_version)
      });
      completeSystemRequest_(transaction.record);
      return recovered;
    }
    if (String(season.status) !== "DRAFT") {
      throw dragonBoatRequestError_("BINDING_LOCKED", "The active season binding cannot be replaced.");
    }
    requireVersion_(season.season_version, request.season_version, "season");
    if (Date.parse(String(season.season_ends_at)) <= Date.now()) {
      throw dragonBoatRequestError_("SEASON_END_PASSED", "The season end boundary has already passed.");
    }
    var binding = inspectSeasonBinding_(season, request);
    if (season.form_id && (
      String(season.form_id) !== binding.form_id ||
      String(season.runtime_spreadsheet_id) !== binding.runtime_spreadsheet_id ||
      String(season.response_sheet_id) !== binding.response_sheet_id
    )) {
      throw dragonBoatRequestError_("BINDING_LOCKED", "Initialization already started with another binding.");
    }
    var now = new Date().toISOString();
    season.form_id = binding.form_id;
    season.form_url = binding.form_url;
    season.runtime_spreadsheet_id = binding.runtime_spreadsheet_id;
    season.response_sheet_id = binding.response_sheet_id;
    season.response_sheet_name = binding.response_sheet_name;
    season.field_mapping_json = JSON.stringify({ display_name_header: binding.display_name_header });
    season.schema_fingerprint = binding.schema_fingerprint;
    season.initialization_status = "INITIALIZING";
    season.updated_at = now;
    updateSheetRecord_("Seasons", season);

    var runtimeSpreadsheet = getSeasonSpreadsheet_(season);
    ensureSeasonRuntimeSheets_(runtimeSpreadsheet);
    var syncResult = syncSeasonMembersInternal_(season, "INITIAL_IMPORT", actorId, request.request_id);
    season = requireSeason_(season.season_id);
    season.trigger_id = ensureSeasonFormSubmitTrigger_(season);
    season.binding_version = Number(season.binding_version || 0) + 1;
    season.season_version = Number(season.season_version || 0) + 1;
    season.status = "OPEN";
    season.initialization_status = "READY";
    season.activated_at = season.activated_at || now;
    season.updated_at = new Date().toISOString();
    updateSheetRecord_("Seasons", season);
    if (!getOpenDefaultSeasonId_()) setDefaultSeasonId_(season.season_id, actorId);

    var result = {
      season: seasonManagementProjection_(season),
      sync: syncResult,
      default_season_id: getDefaultSeasonId_()
    };
    setSystemRequestResult_(transaction.record, result);
    ensureSystemAuditEvent_(transaction.record, "SEASON_INITIALIZED", "SUCCEEDED", {
      season_id: season.season_id,
      imported_count: syncResult.imported_count,
      binding_version: Number(season.binding_version)
    });
    completeSystemRequest_(transaction.record);
    return result;
  });
}

function retrySeasonSync_(request) {
  var sessionToken = requireRequestString_(request, "session_token", 32, 2048);
  return withDragonBoatScriptLock_(function () {
    var authenticated = validateCoachSession_(sessionToken);
    var actorId = String(authenticated.coach.coach_id);
    var season = requireSeason_(request.season_id);
    ensureSeasonOpen_(season);
    var payloadDigest = digestRequestPayload_({
      season_id: season.season_id,
      binding_version: Number(season.binding_version)
    });
    var transaction = beginSystemRequest_(actorId, "retrySeasonSync", request.request_id, payloadDigest, {
      season_id: season.season_id
    });
    if (String(transaction.record.status) === "COMPLETED") return readSystemRequestResult_(transaction.record);
    var sync = syncSeasonMembersInternal_(season, "MANUAL_SYNC", actorId, request.request_id);
    var result = { season: seasonManagementProjection_(requireSeason_(season.season_id)), sync: sync };
    setSystemRequestResult_(transaction.record, result);
    ensureSystemAuditEvent_(transaction.record, "SEASON_SYNCED", "SUCCEEDED", {
      season_id: season.season_id,
      imported_count: sync.imported_count
    });
    completeSystemRequest_(transaction.record);
    return result;
  });
}

function syncSeasonMembersInternal_(season, source, actorId, requestId) {
  var spreadsheet = getSeasonSpreadsheet_(season);
  var responseSheet = null;
  spreadsheet.getSheets().some(function (candidate) {
    if (String(candidate.getSheetId()) === String(season.response_sheet_id)) {
      responseSheet = candidate;
      return true;
    }
    return false;
  });
  if (!responseSheet) {
    throw dragonBoatRequestError_("BINDING_RESPONSE_TAB_MISSING", "The bound response tab no longer exists.");
  }
  var headers = responseSheet.getRange(1, 1, 1, responseSheet.getLastColumn()).getValues()[0].map(function (value) {
    return String(value).trim();
  });
  var fingerprint = digestRequestPayload_({
    spreadsheet_id: String(season.runtime_spreadsheet_id),
    response_sheet_id: String(season.response_sheet_id),
    headers: headers
  });
  if (fingerprint !== String(season.schema_fingerprint)) {
    throw dragonBoatRequestError_("BINDING_SCHEMA_CHANGED", "The response tab columns changed after binding.");
  }
  var mapping = parseJsonObject_(season.field_mapping_json);
  var nameColumn = headers.indexOf(String(mapping.display_name_header));
  if (nameColumn < 0) {
    throw dragonBoatRequestError_("BINDING_FIELD_MISSING", "The display-name column no longer exists.");
  }
  var members = getSeasonSheetRecords_(season, "Members");
  var sourceKeys = {};
  members.forEach(function (member) { sourceKeys[String(member.source_key)] = true; });
  var lastRow = responseSheet.getLastRow();
  var imported = 0;
  var failed = 0;
  var now = new Date().toISOString();
  if (lastRow > 1) {
    var rows = responseSheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    rows.forEach(function (row, index) {
      var rowNumber = index + 2;
      var sourceKey = String(season.response_sheet_id) + ":" + rowNumber;
      if (sourceKeys[sourceKey]) return;
      var displayName = String(row[nameColumn] || "").trim();
      if (!displayName || displayName.length > 120) {
        failed += 1;
        return;
      }
      var memberId = "member_" + hmacDigest_(
        String(season.season_id) + "\n" + sourceKey,
        getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET)
      ).slice(0, 24);
      appendSeasonSheetRecord_(season, "Members", {
        season_id: season.season_id,
        member_id: memberId,
        source_key: sourceKey,
        source_row_number: rowNumber,
        source_display_name: displayName,
        display_name_override: "",
        status: "ACTIVE",
        default_preference: "AMBIENT",
        member_version: 1,
        created_at: now,
        updated_at: now
      });
      sourceKeys[sourceKey] = true;
      imported += 1;
    });
  }
  var importState = findSeasonSheetRecord_(season, "ImportState", "season_id", season.season_id);
  var stateValues = {
    season_id: season.season_id,
    response_sheet_id: season.response_sheet_id,
    schema_fingerprint: fingerprint,
    last_scanned_row: lastRow,
    imported_count: members.length + imported,
    failed_count: failed,
    last_error: failed ? "Some rows do not contain a valid display name." : "",
    updated_at: now
  };
  if (importState) {
    Object.keys(stateValues).forEach(function (key) { importState[key] = stateValues[key]; });
    updateSeasonSheetRecord_(season, "ImportState", importState);
  } else {
    appendSeasonSheetRecord_(season, "ImportState", stateValues);
  }
  if (imported > 0) season.roster_version = Number(season.roster_version || 0) + 1;
  season.last_sync_at = now;
  season.updated_at = now;
  updateSheetRecord_("Seasons", season);
  appendSeasonAudit_(season, requestId, source === "FORM_SUBMIT" ? "SYSTEM" : "COACH", actorId, "MEMBERS_SYNCED", "SEASON", season.season_id, {
    source: source, imported_count: imported, failed_count: failed, roster_version: Number(season.roster_version)
  });
  return {
    imported_count: imported,
    failed_count: failed,
    total_member_count: members.length + imported,
    roster_version: Number(season.roster_version),
    last_sync_at: now
  };
}

function ensureSeasonFormSubmitTrigger_(season) {
  var existingId = String(season.trigger_id || "");
  var triggers = ScriptApp.getProjectTriggers();
  for (var index = 0; index < triggers.length; index += 1) {
    if (existingId && String(triggers[index].getUniqueId()) === existingId) return existingId;
  }
  var trigger = ScriptApp.newTrigger("handleDragonBoatFormSubmit")
    .forSpreadsheet(String(season.runtime_spreadsheet_id))
    .onFormSubmit()
    .create();
  return String(trigger.getUniqueId());
}

function handleDragonBoatFormSubmit(event) {
  if (!event || !event.source || !event.range) return;
  return withDragonBoatScriptLock_(function () {
    var spreadsheetId = String(event.source.getId());
    var responseSheetId = String(event.range.getSheet().getSheetId());
    var seasons = getSheetRecords_("Seasons");
    var season = null;
    seasons.some(function (candidate) {
      if (
        String(candidate.runtime_spreadsheet_id) === spreadsheetId &&
        String(candidate.response_sheet_id) === responseSheetId
      ) {
        season = candidate;
        return true;
      }
      return false;
    });
    if (!season || seasonEffectiveStatus_(season) !== "OPEN") return;
    return syncSeasonMembersInternal_(season, "FORM_SUBMIT", "form_submit_trigger", "form_submit");
  });
}
