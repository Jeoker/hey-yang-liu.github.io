import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createBackend, payload, post, sheetRecords } from "./backend-test-runtime.mjs";

const contractPath = new URL("../contracts/api-v1.json", import.meta.url);

test("GET health returns the versioned success envelope", async () => {
  const { context } = await createBackend();
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const response = payload(context.doGet({
    parameter: { action: "health", request_id: "request_123" }
  }));

  assert.equal(response.ok, true);
  assert.equal(response.data.service, contract.service);
  assert.equal(response.meta.contract_version, contract.contract_version);
  assert.equal(response.meta.request_id, "request_123");
  assert.ok(!Number.isNaN(Date.parse(response.meta.server_time)));
});

test("GET without an action defaults to health and management GET is rejected", async () => {
  const { context } = await createBackend();
  const health = payload(context.doGet({ parameter: {} }));
  assert.equal(health.ok, true);

  const management = payload(context.doGet({
    parameter: { action: "coachBootstrap", request_id: "request_456" }
  }));
  assert.equal(management.ok, false);
  assert.equal(management.error.code, "METHOD_NOT_ALLOWED");
});

test("malformed JSON and unknown actions return safe structured errors", async () => {
  const { context } = await createBackend();
  const malformed = payload(context.doPost({ postData: { contents: "{" } }));
  assert.deepEqual(
    { ok: malformed.ok, code: malformed.error.code, retryable: malformed.error.retryable },
    { ok: false, code: "INVALID_JSON", retryable: false }
  );
  assert.equal("stack" in malformed.error, false);

  const unsupported = post(context, { action: "signup", request_id: "request_789" });
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.error.code, "UNSUPPORTED_ACTION");
});

test("setup stores only Coach Code digests and removes the temporary plain code", async () => {
  const { spreadsheet, properties } = await createBackend({ coachCode: "private-coach-code" });
  const coaches = sheetRecords(spreadsheet, "Coaches");
  assert.equal(coaches.length, 1);
  assert.equal(coaches[0].display_name, "Coach Alpha");
  assert.notEqual(coaches[0].code_digest, "private-coach-code");
  assert.equal(JSON.stringify(coaches).includes("private-coach-code"), false);
  assert.equal(properties.getProperty("DRAGON_BOAT_INITIAL_COACH_CODE"), null);
});

test("setup creates a private system spreadsheet when no ID is configured", async () => {
  const { spreadsheet, spreadsheets, properties } = await createBackend({
    withoutSystemSpreadsheetId: true,
    properties: { DRAGON_BOAT_SYSTEM_SPREADSHEET_NAME: "P0 Isolated System Store" }
  });
  assert.equal(spreadsheets.size, 2);
  assert.equal(spreadsheet.title, "P0 Isolated System Store");
  assert.equal(properties.getProperty("DRAGON_BOAT_SYSTEM_SPREADSHEET_ID"), spreadsheet.getId());
  assert.deepEqual([...spreadsheet.sheets.keys()], [
    "Coaches",
    "CoachSessions",
    "SystemRequests",
    "SystemAuditLog"
  ]);
});

test("setup preserves a populated default sheet", async () => {
  const { context, spreadsheet } = await createBackend({ setup: false });
  const defaultSheet = spreadsheet.insertSheet("Sheet1");
  defaultSheet.getRange(1, 1, 1, 1).setValues([["keep me"]]);

  context.setupDragonBoatP0();

  assert.equal(spreadsheet.getSheetByName("Sheet1").getRange(1, 1, 1, 1).getValues()[0][0], "keep me");
});

test("setup can be rerun without rotating an existing Coach credential", async () => {
  const { context, spreadsheet } = await createBackend();
  const firstCoach = sheetRecords(spreadsheet, "Coaches")[0];

  context.setupDragonBoatP0();

  const coaches = sheetRecords(spreadsheet, "Coaches");
  const credentialEvents = sheetRecords(spreadsheet, "SystemAuditLog")
    .filter((event) => event.action === "COACH_CREDENTIAL_PROVISIONED");
  assert.equal(coaches.length, 1);
  assert.equal(coaches[0].credential_version, firstCoach.credential_version);
  assert.equal(coaches[0].code_digest, firstCoach.code_digest);
  assert.equal(credentialEvents.length, 1);
});

test("Coach login, protected read, idempotent write and logout use one session", async () => {
  const { context, spreadsheet } = await createBackend({ coachCode: "private-coach-code" });
  const login = post(context, {
    action: "coachLogin",
    request_id: "login_request_1",
    coach_code: "private-coach-code"
  });
  assert.equal(login.ok, true);
  assert.equal(typeof login.data.session_token, "string");
  const repeatedLogin = post(context, {
    action: "coachLogin",
    request_id: "login_request_1",
    coach_code: "private-coach-code"
  });
  assert.equal(repeatedLogin.data.session_token, login.data.session_token);
  assert.equal(sheetRecords(spreadsheet, "CoachSessions").length, 1);

  const bootstrap = post(context, {
    action: "coachBootstrap",
    request_id: "bootstrap_request_1",
    session_token: login.data.session_token
  });
  assert.equal(bootstrap.ok, true);
  assert.equal(bootstrap.data.panels.length, 4);

  const writeBody = {
    action: "coachConnectivityWrite",
    request_id: "write_request_1",
    session_token: login.data.session_token
  };
  const firstWrite = post(context, writeBody);
  const requestSheet = spreadsheet.getSheetByName("SystemRequests");
  const requestHeaders = requestSheet.rows[0];
  const actionColumn = requestHeaders.indexOf("action");
  const statusColumn = requestHeaders.indexOf("status");
  const completedColumn = requestHeaders.indexOf("completed_at");
  const writeRequestRow = requestSheet.rows.find((row) => row[actionColumn] === "coachConnectivityWrite");
  writeRequestRow[statusColumn] = "STARTED";
  writeRequestRow[completedColumn] = "";

  const auditSheet = spreadsheet.getSheetByName("SystemAuditLog");
  const auditActionColumn = auditSheet.rows[0].indexOf("action");
  auditSheet.rows = auditSheet.rows.filter(
    (row, index) => index === 0 || row[auditActionColumn] !== "COACH_CONNECTIVITY_WRITE"
  );
  const repeatedWrite = post(context, writeBody);
  assert.equal(firstWrite.ok, true);
  assert.equal(repeatedWrite.data.write_id, firstWrite.data.write_id);
  const writeEvents = sheetRecords(spreadsheet, "SystemAuditLog")
    .filter((record) => record.action === "COACH_CONNECTIVITY_WRITE");
  assert.equal(writeEvents.length, 1);
  const recoveredRequest = sheetRecords(spreadsheet, "SystemRequests")
    .find((record) => record.action === "coachConnectivityWrite");
  assert.equal(recoveredRequest.status, "COMPLETED");
  assert.ok(recoveredRequest.completed_at);
  assert.equal(JSON.stringify(sheetRecords(spreadsheet, "CoachSessions")).includes(login.data.session_token), false);
  assert.equal(JSON.stringify(sheetRecords(spreadsheet, "SystemAuditLog")).includes("private-coach-code"), false);

  const logout = post(context, {
    action: "coachLogout",
    request_id: "logout_request_1",
    session_token: login.data.session_token
  });
  assert.equal(logout.ok, true);
  const afterLogout = post(context, {
    action: "coachBootstrap",
    request_id: "bootstrap_request_2",
    session_token: login.data.session_token
  });
  assert.equal(afterLogout.ok, false);
  assert.equal(afterLogout.error.code, "SESSION_REVOKED");
});

test("credential replacement immediately invalidates existing sessions", async () => {
  const { context, properties } = await createBackend({ coachCode: "old-coach-code" });
  const login = post(context, {
    action: "coachLogin",
    request_id: "login_request_old",
    coach_code: "old-coach-code"
  });
  assert.equal(login.ok, true);

  properties.setProperty("DRAGON_BOAT_PROVISION_COACH_ID", "coach_alpha");
  properties.setProperty("DRAGON_BOAT_PROVISION_COACH_NAME", "Coach Alpha");
  properties.setProperty("DRAGON_BOAT_PROVISION_COACH_CODE", "new-coach-code");
  context.provisionDragonBoatCoachFromProperties();

  const oldSession = post(context, {
    action: "coachBootstrap",
    request_id: "bootstrap_old_1",
    session_token: login.data.session_token
  });
  assert.equal(oldSession.ok, false);
  assert.equal(oldSession.error.code, "SESSION_REVOKED");

  const newLogin = post(context, {
    action: "coachLogin",
    request_id: "login_request_new",
    coach_code: "new-coach-code"
  });
  assert.equal(newLogin.ok, true);
  assert.equal(properties.getProperty("DRAGON_BOAT_PROVISION_COACH_CODE"), null);
});

test("expired sessions and repeated invalid login attempts are rejected", async () => {
  const { context, spreadsheet } = await createBackend({ coachCode: "private-coach-code" });
  const login = post(context, {
    action: "coachLogin",
    request_id: "login_expiry_1",
    coach_code: "private-coach-code"
  });
  const sessions = spreadsheet.getSheetByName("CoachSessions").rows;
  const expiresColumn = sessions[0].indexOf("expires_at");
  sessions[1][expiresColumn] = "2000-01-01T00:00:00.000Z";
  const expired = post(context, {
    action: "coachBootstrap",
    request_id: "bootstrap_expired_1",
    session_token: login.data.session_token
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, "SESSION_EXPIRED");

  let finalAttempt;
  for (let index = 0; index < 6; index += 1) {
    finalAttempt = post(context, {
      action: "coachLogin",
      request_id: `bad_login_${index}`,
      coach_code: "wrong-code"
    });
  }
  assert.equal(finalAttempt.error.code, "LOGIN_RATE_LIMITED");
  assert.equal(sheetRecords(spreadsheet, "CoachSessions").length, 1);
});

test("invalid caller request IDs are not reflected", async () => {
  const { context } = await createBackend();
  const response = payload(context.doGet({
    parameter: { action: "health", request_id: "bad id!" }
  }));
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "INVALID_REQUEST_ID");
  assert.notEqual(response.meta.request_id, "bad id!");
});
