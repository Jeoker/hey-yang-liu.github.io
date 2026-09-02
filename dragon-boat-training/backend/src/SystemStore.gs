function getSystemSpreadsheet_() {
  var spreadsheetId = getRequiredScriptProperty_(
    DRAGON_BOAT_PROPERTY_KEYS_.SYSTEM_SPREADSHEET_ID
  );
  try {
    return SpreadsheetApp.openById(spreadsheetId);
  } catch (error) {
    throw dragonBoatRequestError_(
      "CONFIGURATION_ERROR",
      "The training service management store cannot be opened."
    );
  }
}

function ensureSystemSheets_(spreadsheet) {
  Object.keys(DRAGON_BOAT_SHEET_HEADERS_).forEach(function (sheetName) {
    var sheet = spreadsheet.getSheetByName(sheetName);
    if (!sheet) {
      sheet = spreadsheet.insertSheet(sheetName);
    }
    ensureSheetHeader_(sheet, DRAGON_BOAT_SHEET_HEADERS_[sheetName]);
  });
}

function ensureSheetHeader_(sheet, expectedHeaders) {
  if (sheet.getLastRow() === 0) {
    writeSheetRow_(sheet, 1, expectedHeaders);
    sheet.setFrozenRows(1);
    return;
  }

  var actualHeaders = sheet.getRange(1, 1, 1, expectedHeaders.length).getValues()[0];
  var matches = expectedHeaders.every(function (header, index) {
    return String(actualHeaders[index]) === header;
  });
  if (!matches || sheet.getLastColumn() !== expectedHeaders.length) {
    throw dragonBoatRequestError_(
      "CONFIGURATION_ERROR",
      "The " + sheet.getName() + " system sheet has an unexpected header."
    );
  }
}

function getSystemSheet_(sheetName) {
  var headers = DRAGON_BOAT_SHEET_HEADERS_[sheetName];
  if (!headers) {
    throw new Error("Unknown system sheet: " + sheetName);
  }
  var sheet = getSystemSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) {
    throw dragonBoatRequestError_(
      "CONFIGURATION_REQUIRED",
      "The training service management store is not initialized."
    );
  }
  ensureSheetHeader_(sheet, headers);
  return sheet;
}

function getSheetRecords_(sheetName) {
  var sheet = getSystemSheet_(sheetName);
  var headers = DRAGON_BOAT_SHEET_HEADERS_[sheetName];
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return [];
  }
  var rows = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return rows.map(function (row, rowIndex) {
    var record = { _rowNumber: rowIndex + 2 };
    headers.forEach(function (header, columnIndex) {
      record[header] = row[columnIndex];
    });
    return record;
  });
}

function appendSheetRecord_(sheetName, record) {
  var sheet = getSystemSheet_(sheetName);
  var headers = DRAGON_BOAT_SHEET_HEADERS_[sheetName];
  var rowNumber = sheet.getLastRow() + 1;
  writeSheetRow_(sheet, rowNumber, headers.map(function (header) {
    return record[header] === undefined || record[header] === null
      ? ""
      : String(record[header]);
  }));
  record._rowNumber = rowNumber;
  return record;
}

function updateSheetRecord_(sheetName, record) {
  if (!record || !record._rowNumber || record._rowNumber < 2) {
    throw new Error("A persisted record is required.");
  }
  var sheet = getSystemSheet_(sheetName);
  var headers = DRAGON_BOAT_SHEET_HEADERS_[sheetName];
  writeSheetRow_(sheet, record._rowNumber, headers.map(function (header) {
    return record[header] === undefined || record[header] === null
      ? ""
      : String(record[header]);
  }));
  return record;
}

function writeSheetRow_(sheet, rowNumber, values) {
  var range = sheet.getRange(rowNumber, 1, 1, values.length);
  range.setNumberFormat("@");
  range.setValues([values]);
}

function findRecord_(sheetName, fieldName, value) {
  var expected = String(value);
  var records = getSheetRecords_(sheetName);
  for (var index = 0; index < records.length; index += 1) {
    if (String(records[index][fieldName]) === expected) {
      return records[index];
    }
  }
  return null;
}

function findCoachByCode_(coachCode) {
  var coaches = getSheetRecords_("Coaches");
  for (var index = 0; index < coaches.length; index += 1) {
    var coach = coaches[index];
    if (
      isTrue_(coach.active) &&
      constantTimeEqual_(
        credentialDigest_(String(coach.code_salt), coachCode),
        String(coach.code_digest)
      )
    ) {
      return coach;
    }
  }
  return null;
}

function findCoachById_(coachId) {
  return findRecord_("Coaches", "coach_id", coachId);
}

function findSessionById_(sessionId) {
  return findRecord_("CoachSessions", "session_id", sessionId);
}

function isTrue_(value) {
  return value === true || String(value).toUpperCase() === "TRUE";
}

function buildSystemRequestKey_(actorId, action, requestId) {
  var secret = getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET);
  return "req_" + hmacDigest_(actorId + "\n" + action + "\n" + requestId, secret);
}

function digestRequestPayload_(payload) {
  var secret = getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET);
  return hmacDigest_(JSON.stringify(payload || {}), secret);
}

function beginSystemRequest_(actorId, action, requestId, payloadDigest, plannedResult) {
  var existing = findMatchingSystemRequest_(actorId, action, requestId, payloadDigest);
  if (existing) {
    return { record: existing, replayed: true };
  }

  var requestKey = buildSystemRequestKey_(actorId, action, requestId);
  var now = new Date().toISOString();
  var record = appendSheetRecord_("SystemRequests", {
    request_key: requestKey,
    actor_id: actorId,
    action: action,
    request_id: requestId,
    payload_digest: payloadDigest,
    status: "STARTED",
    result_json: JSON.stringify(plannedResult),
    created_at: now,
    completed_at: ""
  });
  return { record: record, replayed: false };
}

function findMatchingSystemRequest_(actorId, action, requestId, payloadDigest) {
  var requestKey = buildSystemRequestKey_(actorId, action, requestId);
  var existing = findRecord_("SystemRequests", "request_key", requestKey);
  if (
    existing &&
    !constantTimeEqual_(String(existing.payload_digest), payloadDigest)
  ) {
    throw dragonBoatRequestError_(
      "IDEMPOTENCY_CONFLICT",
      "This request identifier was already used with different input."
    );
  }
  return existing;
}

function completeSystemRequest_(record) {
  if (String(record.status) !== "COMPLETED") {
    record.status = "COMPLETED";
    record.completed_at = new Date().toISOString();
    updateSheetRecord_("SystemRequests", record);
  }
  return JSON.parse(String(record.result_json));
}

function readSystemRequestResult_(record) {
  try {
    return JSON.parse(String(record.result_json));
  } catch (error) {
    throw dragonBoatRequestError_(
      "RECOVERY_REQUIRED",
      "The previous request result could not be recovered.",
      true
    );
  }
}

function deterministicEventId_(requestRecord, suffix) {
  var secret = getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET);
  return "evt_" + hmacDigest_(requestRecord.request_key + "\n" + suffix, secret).slice(0, 40);
}

function ensureSystemAuditEvent_(requestRecord, action, status, details) {
  var eventId = deterministicEventId_(requestRecord, action);
  var existing = findRecord_("SystemAuditLog", "event_id", eventId);
  if (existing) {
    return existing;
  }
  return appendSheetRecord_("SystemAuditLog", {
    event_id: eventId,
    request_id: requestRecord.request_id,
    server_time: new Date().toISOString(),
    actor_type: "COACH",
    actor_id: requestRecord.actor_id,
    action: action,
    status: status,
    details_json: JSON.stringify(details || {})
  });
}
