function findSeasonById_(seasonId) {
  return findRecord_("Seasons", "season_id", seasonId);
}

function requireSeason_(seasonId) {
  seasonId = typeof seasonId === "string" ? seasonId.trim() : "";
  var season = seasonId ? findSeasonById_(seasonId) : null;
  if (!season) {
    throw dragonBoatRequestError_("SEASON_NOT_FOUND", "The requested season does not exist.");
  }
  return season;
}

function getDefaultSeasonId_() {
  var setting = findRecord_("SystemSettings", "setting_key", "default_season_id");
  return setting ? String(setting.setting_value || "") : "";
}

function getOpenDefaultSeasonId_() {
  var seasonId = getDefaultSeasonId_();
  if (!seasonId) return "";
  var season = findSeasonById_(seasonId);
  return season && seasonEffectiveStatus_(season) === "OPEN" ? seasonId : "";
}

function setDefaultSeasonId_(seasonId, actorId) {
  var now = new Date().toISOString();
  var setting = findRecord_("SystemSettings", "setting_key", "default_season_id");
  if (setting) {
    setting.setting_value = seasonId;
    setting.settings_version = Number(setting.settings_version || 0) + 1;
    setting.updated_by = actorId;
    setting.updated_at = now;
    return updateSheetRecord_("SystemSettings", setting);
  }
  return appendSheetRecord_("SystemSettings", {
    setting_key: "default_season_id",
    setting_value: seasonId,
    settings_version: 1,
    updated_by: actorId,
    updated_at: now
  });
}

function seasonEffectiveStatus_(season, now) {
  now = now || new Date();
  if (
    String(season.status) === "OPEN" &&
    Number.isFinite(Date.parse(String(season.season_ends_at))) &&
    Date.parse(String(season.season_ends_at)) <= now.getTime()
  ) {
    return "COMPLETED";
  }
  return String(season.status);
}

function ensureSeasonOpen_(season) {
  if (seasonEffectiveStatus_(season) !== "OPEN") {
    throw dragonBoatRequestError_("SEASON_NOT_OPEN", "The season is not open.");
  }
}

function seasonManagementProjection_(season) {
  return {
    season_id: String(season.season_id),
    name: String(season.name),
    start_date: String(season.start_date),
    end_date: String(season.end_date),
    timezone: String(season.timezone),
    season_ends_at: String(season.season_ends_at),
    status: seasonEffectiveStatus_(season),
    form_url: String(season.form_url || ""),
    runtime_spreadsheet_id: String(season.runtime_spreadsheet_id || ""),
    response_sheet_id: String(season.response_sheet_id || ""),
    response_sheet_name: String(season.response_sheet_name || ""),
    field_mapping: parseJsonObject_(season.field_mapping_json),
    binding_version: Number(season.binding_version || 0),
    season_version: Number(season.season_version || 0),
    roster_version: Number(season.roster_version || 0),
    initialization_status: String(season.initialization_status || "NOT_STARTED"),
    last_sync_at: String(season.last_sync_at || ""),
    activated_at: String(season.activated_at || "")
  };
}

function seasonPublicProjection_(season) {
  return {
    season_id: String(season.season_id),
    name: String(season.name),
    start_date: String(season.start_date),
    end_date: String(season.end_date),
    timezone: String(season.timezone),
    status: seasonEffectiveStatus_(season),
    join_form_url: String(season.form_url || ""),
    binding_version: Number(season.binding_version || 0),
    roster_version: Number(season.roster_version || 0)
  };
}

function parseJsonObject_(value) {
  if (!value) return {};
  try {
    var parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    return {};
  }
}

function getSeasonSpreadsheet_(season) {
  var cacheKey = "spreadsheet:" + season.runtime_spreadsheet_id;
  if (dragonBoatStoreHandles_ && dragonBoatStoreHandles_[cacheKey]) return dragonBoatStoreHandles_[cacheKey];
  if (!season.runtime_spreadsheet_id) {
    throw dragonBoatRequestError_("SEASON_NOT_INITIALIZED", "The season data store is not initialized.");
  }
  try {
    var spreadsheet = SpreadsheetApp.openById(String(season.runtime_spreadsheet_id));
    if (dragonBoatStoreHandles_) dragonBoatStoreHandles_[cacheKey] = spreadsheet;
    return spreadsheet;
  } catch (error) {
    throw dragonBoatRequestError_("CONFIGURATION_ERROR", "The season data store cannot be opened.");
  }
}

function ensureSeasonRuntimeSheets_(spreadsheet) {
  Object.keys(DRAGON_BOAT_RUNTIME_SHEET_HEADERS_).forEach(function (sheetName) {
    var sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) sheet = spreadsheet.insertSheet(sheetName);
    ensureSheetHeader_(sheet, DRAGON_BOAT_RUNTIME_SHEET_HEADERS_[sheetName]);
  });
}

function getSeasonSheet_(season, sheetName) {
  var cacheKey = "season_sheet:" + season.runtime_spreadsheet_id + ":" + sheetName;
  if (dragonBoatStoreHandles_ && dragonBoatStoreHandles_[cacheKey]) return dragonBoatStoreHandles_[cacheKey];
  var headers = DRAGON_BOAT_RUNTIME_SHEET_HEADERS_[sheetName];
  if (!headers) throw new Error("Unknown season sheet: " + sheetName);
  var spreadsheet = getSeasonSpreadsheet_(season);
  var sheet = spreadsheet.getSheetByName(sheetName);
  // P3 adds only new runtime tabs, so existing initialized seasons can upgrade
  // lazily without changing or rewriting any deployed P0-P2 header.
  if (!sheet && ["SeatPlanState", "SeatPlanRevisions", "PracticeFinalSnapshots"].indexOf(sheetName) >= 0) {
    sheet = spreadsheet.insertSheet(sheetName);
  }
  if (!sheet) {
    throw dragonBoatRequestError_("SEASON_NOT_INITIALIZED", "The season data store is not initialized.");
  }
  ensureSheetHeader_(sheet, headers);
  if (dragonBoatStoreHandles_) dragonBoatStoreHandles_[cacheKey] = sheet;
  return sheet;
}

function getSeasonSheetRecords_(season, sheetName) {
  var cacheKey = seasonRecordCacheKey_(season, sheetName);
  if (dragonBoatRecordCache_ && dragonBoatRecordCache_[cacheKey]) return cloneDragonBoatRecords_(dragonBoatRecordCache_[cacheKey]);
  var sheet = getSeasonSheet_(season, sheetName);
  var headers = DRAGON_BOAT_RUNTIME_SHEET_HEADERS_[sheetName];
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  var result = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues().map(function (row, index) {
    var record = { _rowNumber: index + 2 };
    headers.forEach(function (header, columnIndex) {
      record[header] = row[columnIndex];
    });
    return record;
  }).filter(function (record) {
    return !record.season_id || String(record.season_id) === String(season.season_id);
  });
  if (dragonBoatRecordCache_) dragonBoatRecordCache_[cacheKey] = cloneDragonBoatRecords_(result);
  return result;
}

function seasonRecordCacheKey_(season, sheetName) {
  return "season:" + season.runtime_spreadsheet_id + ":" + season.season_id + ":" + sheetName;
}

function appendSeasonSheetRecord_(season, sheetName, record) {
  var sheet = getSeasonSheet_(season, sheetName);
  var headers = DRAGON_BOAT_RUNTIME_SHEET_HEADERS_[sheetName];
  var rowNumber = sheet.getLastRow() + 1;
  writeSheetRow_(sheet, rowNumber, headers.map(function (header) {
    return record[header] === undefined || record[header] === null ? "" : String(record[header]);
  }));
  record._rowNumber = rowNumber;
  if (dragonBoatRecordCache_) delete dragonBoatRecordCache_[seasonRecordCacheKey_(season, sheetName)];
  return record;
}

function updateSeasonSheetRecord_(season, sheetName, record) {
  if (!record || !record._rowNumber || record._rowNumber < 2) {
    throw new Error("A persisted season record is required.");
  }
  var sheet = getSeasonSheet_(season, sheetName);
  var headers = DRAGON_BOAT_RUNTIME_SHEET_HEADERS_[sheetName];
  writeSheetRow_(sheet, record._rowNumber, headers.map(function (header) {
    return record[header] === undefined || record[header] === null ? "" : String(record[header]);
  }));
  if (dragonBoatRecordCache_) delete dragonBoatRecordCache_[seasonRecordCacheKey_(season, sheetName)];
  return record;
}

function findSeasonSheetRecord_(season, sheetName, fieldName, value) {
  var expected = String(value);
  var records = getSeasonSheetRecords_(season, sheetName);
  for (var index = 0; index < records.length; index += 1) {
    if (String(records[index][fieldName]) === expected) return records[index];
  }
  return null;
}

function appendSeasonAudit_(season, requestId, actorType, actorId, action, entityType, entityId, details) {
  return appendSeasonSheetRecord_(season, "AuditLog", {
    event_id: "evt_" + createDragonBoatRequestId_(),
    request_id: requestId || "system_event",
    server_time: new Date().toISOString(),
    season_id: season.season_id,
    entity_type: entityType || "SEASON",
    entity_id: entityId || season.season_id,
    actor_type: actorType,
    actor_id: actorId,
    action: action,
    status: "SUCCEEDED",
    details_json: JSON.stringify(details || {})
  });
}

function requireVersion_(actual, requested, label) {
  var expected = Number(requested);
  if (!Number.isFinite(expected) || expected !== Number(actual)) {
    throw dragonBoatRequestError_("VERSION_CONFLICT", "The " + label + " changed. Refresh and try again.");
  }
}

function extractGoogleFileId_(value, fieldName) {
  value = typeof value === "string" ? value.trim() : "";
  if (/^[A-Za-z0-9_-]{10,200}$/.test(value)) return value;
  var match = /\/d\/([A-Za-z0-9_-]{10,200})/.exec(value);
  if (!match) {
    throw dragonBoatRequestError_("INVALID_REQUEST", "A valid " + fieldName + " is required.");
  }
  return match[1];
}

function requireSafeUrl_(value, fieldName, allowBlank) {
  value = typeof value === "string" ? value.trim() : "";
  if (!value && allowBlank) return "";
  if (!/^https:\/\//i.test(value) || value.length > 2000) {
    throw dragonBoatRequestError_("INVALID_REQUEST", "A valid " + fieldName + " is required.");
  }
  return value;
}
