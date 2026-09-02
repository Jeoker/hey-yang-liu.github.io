function setupDragonBoatP0() {
  return withDragonBoatScriptLock_(function () {
    ensureDragonBoatSecuritySecrets_();
    var spreadsheet = getOrCreateDragonBoatSystemSpreadsheet_();
    ensureSystemSheets_(spreadsheet);
    removeBlankDefaultSheet_(spreadsheet);

    var properties = getScriptProperties_();
    var coachId = properties.getProperty(DRAGON_BOAT_PROPERTY_KEYS_.INITIAL_COACH_ID) || "coach_1";
    var displayName = properties.getProperty(DRAGON_BOAT_PROPERTY_KEYS_.INITIAL_COACH_NAME);
    var coachCode = properties.getProperty(DRAGON_BOAT_PROPERTY_KEYS_.INITIAL_COACH_CODE);
    var coach = findCoachById_(coachId);
    if (coachCode) {
      coach = provisionDragonBoatCoach_(coachId, displayName, coachCode);
    } else if (!coach) {
      throw new Error("An initial Coach Code is required for the first setup.");
    }

    properties.deleteProperty(DRAGON_BOAT_PROPERTY_KEYS_.INITIAL_COACH_CODE);
    return {
      status: "ready",
      spreadsheet_id: spreadsheet.getId(),
      coach_id: coach.coach_id,
      credential_version: Number(coach.credential_version)
    };
  });
}

function setupDragonBoatP1() {
  var result = setupDragonBoatP0();
  result.schedule_trigger_id = ensureDragonBoatScheduleTrigger_();
  return result;
}

function ensureDragonBoatScheduleTrigger_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var index = 0; index < triggers.length; index += 1) {
    if (
      typeof triggers[index].getHandlerFunction === "function" &&
      triggers[index].getHandlerFunction() === "publishDueTrainingWeeks"
    ) {
      return String(triggers[index].getUniqueId());
    }
  }
  var trigger = ScriptApp.newTrigger("publishDueTrainingWeeks")
    .timeBased()
    .everyMinutes(5)
    .create();
  return String(trigger.getUniqueId());
}

function removeBlankDefaultSheet_(spreadsheet) {
  var defaultSheet = spreadsheet.getSheetByName("Sheet1");
  if (!defaultSheet || spreadsheet.getSheets().length <= 1) {
    return;
  }
  if (defaultSheet.getLastRow() === 0 && defaultSheet.getLastColumn() === 0) {
    spreadsheet.deleteSheet(defaultSheet);
  }
}

function getOrCreateDragonBoatSystemSpreadsheet_() {
  var properties = getScriptProperties_();
  var spreadsheetId = properties.getProperty(
    DRAGON_BOAT_PROPERTY_KEYS_.SYSTEM_SPREADSHEET_ID
  );
  if (spreadsheetId) {
    return getSystemSpreadsheet_();
  }

  var spreadsheetName = properties.getProperty(
    DRAGON_BOAT_PROPERTY_KEYS_.SYSTEM_SPREADSHEET_NAME
  ) || "Dragon Boat Training - P0 Test System";
  var spreadsheet = SpreadsheetApp.create(spreadsheetName);
  properties.setProperty(
    DRAGON_BOAT_PROPERTY_KEYS_.SYSTEM_SPREADSHEET_ID,
    spreadsheet.getId()
  );
  return spreadsheet;
}

function provisionDragonBoatCoachFromProperties() {
  return withDragonBoatScriptLock_(function () {
    ensureDragonBoatSecuritySecrets_();
    ensureSystemSheets_(getSystemSpreadsheet_());
    var properties = getScriptProperties_();
    var coach = provisionDragonBoatCoach_(
      properties.getProperty(DRAGON_BOAT_PROPERTY_KEYS_.PROVISION_COACH_ID),
      properties.getProperty(DRAGON_BOAT_PROPERTY_KEYS_.PROVISION_COACH_NAME),
      properties.getProperty(DRAGON_BOAT_PROPERTY_KEYS_.PROVISION_COACH_CODE)
    );
    properties.deleteProperty(DRAGON_BOAT_PROPERTY_KEYS_.PROVISION_COACH_CODE);
    return {
      status: "ready",
      coach_id: coach.coach_id,
      credential_version: Number(coach.credential_version)
    };
  });
}

function ensureDragonBoatSecuritySecrets_() {
  var properties = getScriptProperties_();
  if (!properties.getProperty(DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET)) {
    properties.setProperty(
      DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET,
      createDragonBoatSecret_()
    );
  }
  if (!properties.getProperty(DRAGON_BOAT_PROPERTY_KEYS_.SESSION_SECRET)) {
    properties.setProperty(
      DRAGON_BOAT_PROPERTY_KEYS_.SESSION_SECRET,
      createDragonBoatSecret_()
    );
  }
}

function createDragonBoatSecret_() {
  return [Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid()].join("_");
}

function provisionDragonBoatCoach_(coachId, displayName, coachCode) {
  coachId = typeof coachId === "string" ? coachId.trim() : "";
  displayName = typeof displayName === "string" ? displayName.trim() : "";
  coachCode = typeof coachCode === "string" ? coachCode.trim() : "";

  if (!/^[A-Za-z0-9_-]{3,64}$/.test(coachId)) {
    throw new Error("A 3 to 64 character coach ID is required.");
  }
  if (!displayName || displayName.length > 100) {
    throw new Error("A display name of 1 to 100 characters is required.");
  }
  if (coachCode.length < 6 || coachCode.length > 128) {
    throw new Error("A Coach Code of 6 to 128 characters is required.");
  }

  var now = new Date().toISOString();
  var salt = createDragonBoatRequestId_();
  var existing = findCoachById_(coachId);
  var coach;
  if (existing) {
    existing.display_name = displayName;
    existing.code_salt = salt;
    existing.code_digest = credentialDigest_(salt, coachCode);
    existing.credential_version = Number(existing.credential_version || 0) + 1;
    existing.active = "TRUE";
    existing.updated_at = now;
    coach = updateSheetRecord_("Coaches", existing);
  } else {
    coach = appendSheetRecord_("Coaches", {
      coach_id: coachId,
      display_name: displayName,
      code_salt: salt,
      code_digest: credentialDigest_(salt, coachCode),
      credential_version: 1,
      active: "TRUE",
      created_at: now,
      updated_at: now
    });
  }

  appendSheetRecord_("SystemAuditLog", {
    event_id: "evt_" + createDragonBoatRequestId_(),
    request_id: "manual_setup",
    server_time: now,
    actor_type: "SYSTEM",
    actor_id: coachId,
    action: "COACH_CREDENTIAL_PROVISIONED",
    status: "SUCCEEDED",
    details_json: JSON.stringify({ credential_version: Number(coach.credential_version) })
  });
  return coach;
}
