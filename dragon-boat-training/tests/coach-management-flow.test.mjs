import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import ts from "typescript";
import { DragonBoatApiError } from "../frontend/lib/api-client.js";
import { validPracticeView, olderPracticeView } from "../frontend/lib/current-view.js";
import { renderSeatPlan } from "../frontend/lib/seat-plan-view.js";
import { renderSignupList, signupResultText } from "../frontend/lib/signup-view.js";

const source = await fs.readFile(new URL("../frontend/components/CoachModeApp.astro", import.meta.url), "utf8");
const script = source.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*;$/gm, "");
const compiled = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;

function makeHarness({ mutate, readWorkspace, readManagement, login, bootstrap, seating = false, weekStatus = "OPENED" } = {}) {
  const elements = new Map();
  const timers = new Map();
  let timerCounter = 0;
  const document = { querySelector: (selector) => elements.get(selector), createElement: (tag) => new Element(tag) };
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.ownerDocument = document;
      this.children = [];
      this.listeners = new Map();
      this.fields = new Map();
      this.elements = { namedItem: (name) => this.fields.get(name) };
      this.dataset = {};
      this.attributes = new Map();
      this.value = "";
      this.defaultValue = "";
      this.textContent = "";
      this.hidden = false;
      this.disabled = false;
      this.checked = false;
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    querySelector(selector) { return elements.get(selector); }
    querySelectorAll() { return []; }
    getAttribute(key) { return key === "data-api-url" ? "http://localhost:4322/api" : this.attributes.get(key) || ""; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    addEventListener(event, handler) { this.listeners.set(event, handler); }
    emit(event, values = {}) { return this.listeners.get(event)?.({ preventDefault() {}, ...values }); }
    reset() { for (const field of this.fields.values()) field.value = field.defaultValue; }
    get selectedOptions() { return this.children.filter((child) => child.value === this.value); }
    get options() { return this.children; }
  }
  for (const match of source.matchAll(/<(\w+)[^>]*\s(data-[\w-]+)(?:\s|>|=)/g)) {
    elements.set(`[${match[2]}]`, new Element(match[1]));
  }
  elements.set("[data-coach-mode-app]", new Element("div"));
  for (const form of source.matchAll(/<form[^>]*\s(data-[\w-]+)[^>]*>([\s\S]*?)<\/form>/g)) {
    const element = elements.get(`[${form[1]}]`);
    for (const field of form[2].matchAll(/<(input|select)[^>]*\sname="([^"]+)"[^>]*>/g)) {
      const input = new Element(field[1]);
      input.value = field[0].match(/\svalue="([^"]*)"/)?.[1] || "";
      input.defaultValue = input.value;
      element.fields.set(field[2], input);
    }
  }
  const season = { season_id: "season_test", name: "Test season", status: "OPEN", start_date: "2099-01-01", end_date: "2099-12-31", timezone: "America/New_York", roster_version: 1, season_version: 1, binding_version: 1 };
  const practice = { practice_id: "practice_test", practice_version: 1, timezone: "America/New_York", start_at: "2099-09-09T22:00:00Z", end_at: "2099-09-10T00:00:00Z", schedule_published_at: "2099-09-01T00:00:00Z", location: "Test Dock" };
  const baseMembers = [
    { member_id: "member_alice", display_name: "Alice", source_display_name: "Alice Source", display_name_override: "Alice", status: "ACTIVE", default_preference: "AMBIENT", member_version: 1, active_links: [] },
    { member_id: "member_bob", display_name: "Bob", source_display_name: "Bob Source", display_name_override: "Bob", status: "ACTIVE", default_preference: "LEFT", member_version: 1, active_links: [] },
    { member_id: "member_alpha", display_name: "Alpha", source_display_name: "Alpha Source", display_name_override: "Alpha", status: "ACTIVE", default_preference: "AMBIENT", member_version: 1, active_links: [] }
  ];
  const state = {
    calls: [], requestCounter: 0, practiceReads: 0, failNextPracticeRead: false,
    signupVersion: 1, signups: [], season, practice,
    members: seating ? baseMembers : baseMembers.slice(0, 1),
    seatVersion: 0, publishedRevision: 0,
    seatDraft: { coach_member_id: "", steerer_member_id: "", seats: [] },
    seatPublished: null
  };
  if (seating) state.signups = state.members.slice(0, 2).map((member, index) => ({
    member_id: member.member_id, display_name: member.display_name,
    preference: index ? "LEFT" : "AMBIENT", status: "CONFIRMED",
    queue_at: `2099-09-01T12:0${index}:00Z`, queue_sequence: index + 1
  }));
  state.seatingWorkspace = () => ({
    season_id: season.season_id, practice_id: practice.practice_id, practice,
    mode: "UPCOMING", editable: true, archive_due_at: "2099-09-11T00:00:00Z",
    signup_version: state.signupVersion, seat_plan_version: state.seatVersion,
    published_revision: state.publishedRevision, draft: structuredClone(state.seatDraft),
    published: structuredClone(state.seatPublished), members: state.members, signups: state.signups,
    unseated_member_ids: state.signups.filter((signup) => !state.seatDraft.seats.some((seat) => seat.member_id === signup.member_id)).map((signup) => signup.member_id),
    preference_mismatches: []
  });
  const envelope = (data) => ({ data: structuredClone(data) });
  class Client {
    async get(action) {
      assert.equal(action, "practice");
      state.practiceReads++;
      if (state.failNextPracticeRead) {
        state.failNextPracticeRead = false;
        throw new DragonBoatApiError("NETWORK_ERROR", "read failed", { retryable: true });
      }
      return envelope({ season_id: season.season_id, practice, roster_version: season.roster_version, binding_version: 1,
        signup_version: state.signupVersion, signup_open: true, management_signup_open: true, closed_reason: "",
        counts: { confirmed: state.signups.length, waitlisted: 0, left: 0, ambient: state.signups.length, right: 0, total_capacity: 20, left_capacity: 10, right_capacity: 10 }, signups: state.signups });
    }
    async post(action, payload, options) {
      state.calls.push(structuredClone({ action, payload, options }));
      if (action === "coachBootstrap") {
        if (bootstrap) await bootstrap(state);
        return envelope({ panels: [], coach: { display_name: "Test Coach" }, session: { expires_at: "2099-12-31T00:00:00Z" }, default_season_id: season.season_id, seasons: [season] });
      }
      if (action === "getSeasonManagement") {
        if (readManagement) await readManagement(state);
        return envelope({ season, is_default: true, settings_version: 4, members: state.members, templates: [], weeks: [{ week: { week_id: "week_test", status: weekStatus, week_start_date: "2099-09-07", week_version: 1 }, practices: [practice] }] });
      }
      if (action === "listSeasonMembers") return envelope({ season_id: season.season_id, roster_version: season.roster_version, members: state.members });
      if (action === "getMemberWorkspace") {
        if (readWorkspace) await readWorkspace(state);
        return envelope({ season_id: season.season_id, season, practices: [practice],
        season_status: "OPEN", roster_version: season.roster_version, binding_version: 1,
        members: state.members, member_links: {}, practice: (await this.get("practice")).data,
        ...(seating ? { seating: state.seatingWorkspace() } : {}) });
      }
      if (action === "getSeatingWorkspace") return envelope(state.seatingWorkspace());
      if (action === "coachLogin") {
        if (login) {
          const response = await login(state, payload, options);
          if (response) return response;
        }
        return envelope({ session_token: "session_new", session: { expires_at: "2099-12-31T00:00:00Z" } });
      }
      if (action === "coachLogout") return envelope({});
      if (mutate) return mutate(state, action, payload, options, envelope);
      throw new Error(`Unexpected POST ${action}`);
    }
  }
  class FormDataMock {
    constructor(form) { this.form = form; }
    entries() { return [...this.form.fields.entries()].map(([key, value]) => [key, value.value]); }
  }
  const context = vm.createContext({ document, Date, Intl, Error, console, structuredClone, TextEncoder, crypto: webcrypto, FormData: FormDataMock,
    window: {
      setTimeout(callback) { const id = ++timerCounter; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
      confirm: () => true
    },
    DragonBoatApiClient: Client, DragonBoatApiError,
    createRequestId: () => `request_${++state.requestCounter}`,
    loadCoachSession: () => ({ token: "session_old" }),
    saveCoachSession(token) { state.savedSession = token; }, clearCoachSession() { state.savedSession = null; },
    isCoachSessionError: (error) => ["SESSION_INVALID", "SESSION_EXPIRED", "SESSION_REVOKED"].includes(error?.code),
    renderSignupList, signupResultText, renderSeatPlan, validPracticeView, olderPracticeView });
  vm.runInContext(compiled, context);
  const element = (name) => {
    const found = elements.get(`[data-${name}]`);
    assert.ok(found, `Missing control ${name}`);
    return found;
  };
  return {
    state,
    element,
    async flushTimers() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((callback) => callback());
      await new Promise((resolve) => setImmediate(resolve));
    },
    mutationCalls: () => state.calls.filter((call) => /signupByCoach|SignupByCoach|Member|createSeason/.test(call.action) && !["listSeasonMembers", "getMemberWorkspace"].includes(call.action)),
    seatCalls: () => state.calls.filter((call) => ["saveSeatPlanDraft", "publishSeatPlan"].includes(call.action))
  };
}

async function settled(predicate) {
  for (let step = 0; step < 40; step++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(predicate(), "Coach UI did not reach expected state");
}

async function ready(harness) {
  await settled(() => harness.element("season-picker").value === "season_test");
  if (!harness.element("member-console-status").textContent.includes("名册与报名已更新")) await harness.element("open-members").emit("click");
  await settled(() => harness.element("member-console-status").textContent.includes("名册与报名已更新"));
}

async function readySeating(harness) {
  await ready(harness);
  await settled(() => !harness.element("seat-console").hidden && harness.element("seat-draft-grid").children.length === 10);
}

function poolButton(harness, memberId) {
  const button = harness.element("seat-pool").children.find((child) => child.dataset.memberId === memberId);
  assert.ok(button, `Missing pool member ${memberId}`);
  return button;
}

function seatTarget(harness, rowIndex, side) {
  const row = harness.element("seat-draft-grid").children[rowIndex - 1];
  assert.ok(row, `Missing seat row ${rowIndex}`);
  return row.children[side === "LEFT" ? 0 : 2];
}

function seatOccupantName(harness, rowIndex, side) {
  return seatTarget(harness, rowIndex, side).children[0]?.textContent || "";
}

function placeFromPool(harness, memberId, rowIndex, side) {
  poolButton(harness, memberId).emit("click");
  seatTarget(harness, rowIndex, side).emit("click");
}

function acceptSeatSave(state, payload, envelope) {
  state.seatVersion++;
  state.seatDraft = {
    coach_member_id: payload.coach_member_id,
    steerer_member_id: payload.steerer_member_id,
    seats: structuredClone(payload.seats)
  };
  return envelope(state.seatingWorkspace());
}

async function submitSignup(harness) {
  await ready(harness);
  harness.element("managed-signup-member").value = "member_alice";
  harness.element("managed-signup-member").emit("change");
  harness.element("managed-signup-form").emit("submit");
}

function acceptSignup(state, payload, envelope) {
  const signup = { member_id: payload.member_id, display_name: "Alice", preference: payload.preference, status: "CONFIRMED", queue_at: "2099-09-01T12:00:00Z", queue_sequence: 1 };
  state.signupVersion++;
  state.signups = [signup];
  return envelope({ season_id: "season_test", practice_id: "practice_test", signup_version: state.signupVersion, signup, promoted_member_ids: [] });
}

test("Coach login loads only metadata until the selected workspace is opened", async () => {
  const h = makeHarness();
  await settled(() => h.element("season-picker").value === "season_test");
  assert.deepEqual(h.state.calls.map(call => call.action), ["coachBootstrap"]);
  assert.equal(h.state.practiceReads, 0);
  await ready(h);
  assert.deepEqual(h.state.calls.map(call => call.action), ["coachBootstrap", "getMemberWorkspace"]);
});

test("uncertain Coach login retries the same request without retaining the Code in the input", async () => {
  let attempts = 0;
  const h = makeHarness({ login: () => {
    if (++attempts < 3) throw new DragonBoatApiError("REQUEST_TIMEOUT", "unknown", { retryable: true });
  } });
  await ready(h);
  await h.element("logout-button").emit("click");
  for (let attempt = 0; attempt < 3; attempt++) {
    h.element("coach-code").value = "test_code";
    const submission = h.element("login-form").emit("submit");
    assert.equal(h.element("coach-code").value, "");
    await h.element("login-form").emit("submit"); // repeated submission while hashing/sending is ignored
    await submission;
    if (attempt < 2) assert.match(h.element("login-status").textContent, /重新输入相同 Coach Code.*原请求/);
  }
  const logins = h.state.calls.filter(call => call.action === "coachLogin");
  assert.equal(logins.length, 3);
  assert.equal(new Set(logins.map(call => call.options.requestId)).size, 1);
  assert.equal(h.state.savedSession, "session_new");
  assert.equal(h.element("login-panel").hidden, true);
  await h.element("logout-button").emit("click");
  h.element("coach-code").value = "test_code";
  await h.element("login-form").emit("submit");
  assert.notEqual(h.state.calls.filter(call => call.action === "coachLogin").at(-1).options.requestId, logins[0].options.requestId);
});

test("a changed Code or a definitive rejection starts a new login request", async () => {
  let attempts = 0;
  const h = makeHarness({ login: () => {
    if (++attempts === 1) throw new DragonBoatApiError("INVALID_RESPONSE", "unknown", { retryable: true });
    if (attempts === 2) throw new DragonBoatApiError("COACH_CODE_INVALID", "invalid");
  } });
  await ready(h);
  await h.element("logout-button").emit("click");
  for (const code of ["first_code", "second_code", "second_code"]) {
    h.element("coach-code").value = code;
    await h.element("login-form").emit("submit");
  }
  const logins = h.state.calls.filter(call => call.action === "coachLogin");
  assert.equal(new Set(logins.map(call => call.options.requestId)).size, 3);
  assert.equal(h.state.savedSession, "session_new");
});

test("an incomplete successful login envelope stays unknown and reuses its original request", async () => {
  let attempts = 0;
  const h = makeHarness({ login: () => ++attempts === 1 ? { data: { status: "available" } } : undefined });
  await ready(h);
  await h.element("logout-button").emit("click");
  h.element("coach-code").value = "test_code";
  await h.element("login-form").emit("submit");
  assert.equal(h.state.savedSession, null);
  assert.equal(h.element("workspace").hidden, true);
  assert.match(h.element("login-status").textContent, /登录响应不完整.*原请求/);
  h.element("coach-code").value = "test_code";
  await h.element("login-form").emit("submit");
  const logins = h.state.calls.filter(call => call.action === "coachLogin");
  assert.equal(logins[0].options.requestId, logins[1].options.requestId);
  assert.equal(h.state.savedSession, "session_new");
});

test("a bootstrap read failure after login retains the session and retries only the read", async () => {
  let reads = 0;
  const h = makeHarness({ bootstrap: () => {
    if (++reads === 2) throw new DragonBoatApiError("REQUEST_TIMEOUT", "read timeout", { retryable: true });
  } });
  await ready(h);
  await h.element("logout-button").emit("click");
  h.element("coach-code").value = "test_code";
  await h.element("login-form").emit("submit");
  assert.equal(h.state.savedSession, "session_new");
  assert.equal(h.element("login-panel").hidden, true);
  assert.equal(h.element("workspace").hidden, false);
  assert.match(h.element("management-status").textContent, /登录已成功.*无需重新登录/);
  await h.element("refresh-button").emit("click");
  await settled(() => h.element("season-picker").children.some(option => option.value === "season_test"));
  assert.equal(h.state.calls.filter(call => call.action === "coachLogin").length, 1);
  assert.equal(reads, 3);
});

test("Coach commit view updates signup and links without another read", async () => {
  const h = makeHarness({ mutate: (state, _action, payload, _options, envelope) => {
    const result = acceptSignup(state, payload, envelope).data;
    return envelope({ ...result, view_status: "ready", current_view: { season_id: state.season.season_id,
      roster_version: 1, member_links: { member_alice: [{ practice_id: state.practice.practice_id }] },
      practice: { season_id: state.season.season_id, practice: state.practice, roster_version: 1, binding_version: 1,
        signup_version: state.signupVersion, signup_open: true, management_signup_open: true,
        counts: { confirmed: 1, total_capacity: 20, left: 0, right: 0, ambient: 1, waitlisted: 0 }, signups: state.signups }
    } });
  } });
  await submitSignup(h);
  await settled(() => h.element("managed-signup-status").textContent.includes("操作已保存"));
  assert.equal(h.state.practiceReads, 1);
  assert.equal(h.state.calls.length, 3);
  assert.equal(h.element("member-status-confirm").disabled, true, "new active link prevents deactivation");
});

test("slow Coach refresh preserves edits and a response after logout cannot restore private DOM", async () => {
  let release, reads = 0;
  const h = makeHarness({ readWorkspace: () => ++reads > 1 ? new Promise(resolve => { release = resolve; }) : undefined });
  await ready(h);
  const form = h.element("member-edit-form");
  h.element("member-refresh").emit("click");
  assert.equal(h.element("member-picker").disabled, false);
  form.elements.namedItem("display_name_override").value = "Unsaved change";
  release();
  await settled(() => !h.element("member-refresh").disabled);
  assert.equal(form.elements.namedItem("display_name_override").value, "Unsaved change");
  h.element("member-refresh").emit("click");
  await h.element("logout-button").emit("click");
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.element("member-picker").children.length, 0);
  assert.equal(h.element("member-source").textContent, "");
});

test("uncertain Coach signup freezes the original payload and request ID until retry", async () => {
  let writes = 0;
  const harness = makeHarness({ mutate: (state, _action, payload, _options, envelope) => {
    if (++writes === 1) throw new DragonBoatApiError("REQUEST_TIMEOUT", "unknown", { retryable: true });
    return acceptSignup(state, payload, envelope);
  } });
  await submitSignup(harness);
  await settled(() => harness.element("managed-signup-status").textContent.includes("原内容和请求编号已锁定"));
  assert.equal(harness.element("managed-signup-fields").disabled, true);
  assert.equal(harness.element("member-picker").disabled, true);
  harness.element("managed-signup-form").elements.namedItem("preference").value = "RIGHT";
  harness.element("managed-signup-retry").emit("click");
  await settled(() => harness.element("managed-signup-status").textContent.includes("清单已按服务器当前视图更新"));
  assert.equal(writes, 2);
  assert.deepEqual(harness.mutationCalls()[0], harness.mutationCalls()[1]);
  assert.equal(harness.element("managed-signup-fields").disabled, false);
});

test("accepted Coach write with failed readback stays locked and retry only rereads", async () => {
  let writes = 0;
  const harness = makeHarness({ mutate: (state, _action, payload, _options, envelope) => {
    writes++;
    state.failNextPracticeRead = true;
    return acceptSignup(state, payload, envelope);
  } });
  await submitSignup(harness);
  await settled(() => harness.element("managed-signup-status").textContent.includes("服务器已确认保存成功"));
  assert.equal(harness.element("managed-signup-fields").disabled, true);
  assert.equal(harness.element("managed-signup-retry").textContent, "重新读取已保存结果");
  harness.element("managed-signup-retry").emit("click");
  await settled(() => harness.element("managed-signup-status").textContent.includes("清单已按服务器当前视图更新"));
  assert.equal(writes, 1);
  assert.equal(harness.state.practiceReads, 3);
  assert.equal(harness.element("managed-signup-retry").hidden, true);
});

test("Coach result uses the reread signup state when a later change superseded the POST result", async () => {
  const harness = makeHarness({ mutate: (state, _action, payload, _options, envelope) => {
    const accepted = acceptSignup(state, payload, envelope);
    state.signups[0].status = "CANCELLED";
    state.signupVersion++;
    return accepted;
  } });
  await submitSignup(harness);
  await settled(() => harness.element("managed-signup-status").textContent.includes("清单已按服务器当前视图更新"));
  assert.match(harness.element("managed-signup-status").textContent, /当前状态：报名已取消/);
  assert.doesNotMatch(harness.element("managed-signup-status").textContent, /已确认 Ambient/);
});

test("expired Coach session clears private DOM and resumes the same request with a new token", async () => {
  let writes = 0;
  const harness = makeHarness({ mutate: (state, _action, payload, _options, envelope) => {
    if (++writes === 1) throw new DragonBoatApiError("SESSION_EXPIRED", "expired");
    return acceptSignup(state, payload, envelope);
  } });
  await submitSignup(harness);
  await settled(() => harness.element("login-status").textContent.includes("会话已过期"));
  assert.equal(harness.element("member-source").textContent, "");
  assert.equal(harness.element("managed-signup-list").children.length, 0);
  assert.equal(harness.element("member-edit-form").elements.namedItem("display_name_override").value, "");
  harness.element("coach-code").value = "test_code";
  harness.element("login-form").emit("submit");
  await settled(() => harness.element("managed-signup-status").textContent.includes("会话已恢复"));
  assert.equal(harness.element("managed-signup-fields").disabled, true);
  harness.element("managed-signup-retry").emit("click");
  await settled(() => harness.element("managed-signup-status").textContent.includes("清单已按服务器当前视图更新"));
  const [first, second] = harness.mutationCalls();
  assert.equal(first.payload.session_token, "session_old");
  assert.equal(second.payload.session_token, "session_new");
  assert.equal(first.options.requestId, second.options.requestId);
  assert.deepEqual({ ...first.payload, session_token: "" }, { ...second.payload, session_token: "" });
  await harness.element("logout-button").emit("click");
  assert.equal(harness.element("member-source").textContent, "");
  assert.equal(harness.element("member-picker").children.length, 0);
  assert.equal(harness.element("managed-signup-list").children.length, 0);
});

test("Coach member version conflict preserves edits but requires a fresh explicit save", async () => {
  let writes = 0;
  const harness = makeHarness({ mutate: (state, _action, payload, _options, envelope) => {
    const member = state.members[0];
    if (++writes === 1) {
      member.member_version = 2;
      member.display_name_override = member.display_name = "Alice elsewhere";
      throw new DragonBoatApiError("VERSION_CONFLICT", "changed");
    }
    member.member_version++;
    member.display_name_override = member.display_name = payload.display_name_override;
    member.default_preference = payload.default_preference;
    return envelope({ season_id: "season_test", roster_version: 2, member });
  } });
  await ready(harness);
  const form = harness.element("member-edit-form");
  form.elements.namedItem("display_name_override").value = "Alice fixed";
  form.emit("submit");
  await settled(() => harness.element("member-edit-status").textContent.includes("已刷新服务器状态并保留输入"));
  assert.equal(writes, 1);
  assert.equal(form.elements.namedItem("display_name_override").value, "Alice fixed");
  assert.equal(harness.element("member-current-name").textContent, "Alice elsewhere");
  form.emit("submit");
  await settled(() => harness.element("member-edit-status").textContent.includes("队员资料已保存"));
  const [first, second] = harness.mutationCalls();
  assert.equal(first.payload.member_version, 1);
  assert.equal(second.payload.member_version, 2);
  assert.notEqual(first.options.requestId, second.options.requestId);
});

test("P1 pending writes reject changed inputs and replay the original payload", async () => {
  let writes = 0;
  const harness = makeHarness({ mutate: (_state, action, _payload, _options, envelope) => {
    assert.equal(action, "createSeason");
    if (++writes === 1) throw new DragonBoatApiError("REQUEST_TIMEOUT", "unknown", { retryable: true });
    return envelope({ season: { season_id: "season_test" } });
  } });
  await ready(harness);
  const form = harness.element("create-season-form");
  form.elements.namedItem("name").value = "Original season";
  form.emit("submit");
  await settled(() => harness.element("management-status").textContent.includes("请求超时"));
  form.elements.namedItem("name").value = "Edited season";
  form.emit("submit");
  await settled(() => harness.element("management-status").textContent.includes("当前修改尚未发送"));
  assert.equal(writes, 1);
  harness.element("management-retry").emit("click");
  await settled(() => harness.element("management-status").textContent.includes("原操作已由服务器确认成功"));
  assert.equal(writes, 2);
  assert.deepEqual(harness.mutationCalls()[0], harness.mutationCalls()[1]);
});

test("Coach seat autosave keeps later local edits and rebases the next save", async () => {
  let releaseFirst;
  let writes = 0;
  const harness = makeHarness({ seating: true, mutate: (state, action, payload, _options, envelope) => {
    assert.equal(action, "saveSeatPlanDraft");
    if (++writes === 1) return new Promise((resolve) => {
      releaseFirst = () => resolve(acceptSeatSave(state, payload, envelope));
    });
    return acceptSeatSave(state, payload, envelope);
  } });
  await readySeating(harness);
  placeFromPool(harness, "member_alice", 1, "LEFT");
  await harness.flushTimers();
  await settled(() => harness.seatCalls().length === 1);

  placeFromPool(harness, "member_bob", 1, "RIGHT");
  assert.equal(seatOccupantName(harness, 1, "RIGHT"), "Bob", "editing stays available during the slow Google write");
  releaseFirst();
  await settled(() => harness.element("seat-status").textContent.includes("刚才继续做出的调整"));
  await harness.flushTimers();
  await settled(() => harness.seatCalls().length === 2 && harness.element("seat-status").textContent.includes("服务器保存"));

  const [first, second] = harness.seatCalls();
  assert.equal(first.payload.seat_plan_version, 0);
  assert.equal(first.payload.seats.length, 1);
  assert.equal(second.payload.seat_plan_version, 1);
  assert.equal(second.payload.seats.length, 2);
  assert.notEqual(first.options.requestId, second.options.requestId);
});

test("successful seat autosave unlocks newly rendered pool and seat buttons", async () => {
  const harness = makeHarness({ seating: true, mutate: (state, action, payload, _options, envelope) => {
    assert.equal(action, "saveSeatPlanDraft");
    return acceptSeatSave(state, payload, envelope);
  } });
  await readySeating(harness);
  placeFromPool(harness, "member_alice", 1, "LEFT");
  await harness.flushTimers();
  await settled(() => harness.element("seat-status").textContent.includes("服务器保存"));

  assert.equal(poolButton(harness, "member_bob").disabled, false,
    "a pool button rendered from the accepted response must be usable immediately");
  assert.equal(seatTarget(harness, 2, "RIGHT").disabled, false,
    "all dynamic seat targets must be usable immediately after save");
});

test("reset to published restores both protected role IDs and published seats", async () => {
  const harness = makeHarness({ seating: true });
  harness.state.seatVersion = 2;
  harness.state.publishedRevision = 1;
  harness.state.seatDraft = {
    coach_member_id: "",
    steerer_member_id: "",
    seats: [{ row_number: 1, side: "RIGHT", member_id: "member_bob" }]
  };
  harness.state.seatPublished = {
    status: "PUBLISHED",
    mode: "UPCOMING",
    seat_plan_version: 1,
    published_revision: 1,
    published_at: "2099-09-02T12:00:00Z",
    source: "MANUAL",
    coach: { member_id: "member_alpha", display_name: "Alpha" },
    steerer: { member_id: "member_alpha", display_name: "Alpha" },
    seats: [{ row_number: 1, side: "LEFT", member_id: "member_bob", display_name: "Bob" }],
    rows: [{ row_number: 1, left: { display_name: "Bob" }, right: null }]
  };
  await readySeating(harness);
  assert.equal(seatOccupantName(harness, 1, "RIGHT"), "Bob");
  assert.equal(harness.element("seat-coach").value, "");
  assert.equal(harness.element("seat-steerer").value, "");

  harness.element("seat-reset").emit("click");

  assert.equal(seatOccupantName(harness, 1, "LEFT"), "Bob");
  assert.equal(seatOccupantName(harness, 1, "RIGHT"), "空位");
  assert.equal(harness.element("seat-coach").value, "member_alpha");
  assert.equal(harness.element("seat-steerer").value, "member_alpha");
});

test("uncertain seat save retries the frozen request before saving newer edits", async () => {
  let rejectFirst;
  let writes = 0;
  const harness = makeHarness({ seating: true, mutate: (state, action, payload, _options, envelope) => {
    assert.equal(action, "saveSeatPlanDraft");
    writes++;
    if (writes === 1) return new Promise((_resolve, reject) => {
      rejectFirst = () => reject(new DragonBoatApiError("REQUEST_TIMEOUT", "unknown", { retryable: true }));
    });
    return acceptSeatSave(state, payload, envelope);
  } });
  await readySeating(harness);
  placeFromPool(harness, "member_alice", 1, "LEFT");
  await harness.flushTimers();
  await settled(() => harness.seatCalls().length === 1);
  placeFromPool(harness, "member_bob", 1, "RIGHT");
  rejectFirst();
  await settled(() => !harness.element("seat-retry").hidden);
  assert.equal(seatOccupantName(harness, 1, "RIGHT"), "Bob");

  await harness.element("seat-retry").emit("click");
  await settled(() => harness.element("seat-status").textContent.includes("刚才继续做出的调整"));
  await harness.flushTimers();
  await settled(() => harness.seatCalls().length === 3 && harness.element("seat-status").textContent.includes("服务器保存"));

  const [first, retry, newer] = harness.seatCalls();
  assert.deepEqual(first, retry, "unknown result must reuse the exact request ID and payload");
  assert.equal(newer.payload.seat_plan_version, 1);
  assert.equal(newer.payload.seats.length, 2, "retrying the old snapshot must not erase the later local seat");
  assert.notEqual(newer.options.requestId, retry.options.requestId);
});

test("seat version conflict preserves local draft until a fresh server draft is adopted", async () => {
  const harness = makeHarness({ seating: true, mutate: (state, action, _payload, _options, _envelope) => {
    assert.equal(action, "saveSeatPlanDraft");
    state.seatVersion = 1;
    state.seatDraft = { coach_member_id: "", steerer_member_id: "", seats: [
      { row_number: 1, side: "LEFT", member_id: "member_bob" }
    ] };
    throw new DragonBoatApiError("VERSION_CONFLICT", "changed");
  } });
  await readySeating(harness);
  placeFromPool(harness, "member_alice", 1, "LEFT");
  await harness.flushTimers();
  await settled(() => harness.element("seat-status").textContent.includes("本地草稿仍保留"));

  assert.equal(seatOccupantName(harness, 1, "LEFT"), "Alice");
  assert.equal(harness.element("seat-reset").disabled, true);
  assert.equal(harness.element("seat-reset").textContent, "请先刷新服务器草稿");
  await harness.element("seat-refresh").emit("click");
  await settled(() => harness.element("seat-reset").textContent === "采用服务器草稿");
  assert.equal(seatOccupantName(harness, 1, "LEFT"), "Alice", "refresh must not overwrite the conflicted local draft");
  assert.equal(harness.element("seat-reset").disabled, false);

  harness.element("seat-reset").emit("click");
  assert.equal(seatOccupantName(harness, 1, "LEFT"), "Bob");
  assert.match(harness.element("seat-status").textContent, /本地冲突版本没有提交/);
});

test("late seat save response after logout cannot restore private seating UI", async () => {
  let releaseWrite;
  const harness = makeHarness({ seating: true, mutate: (state, action, payload, _options, envelope) => {
    assert.equal(action, "saveSeatPlanDraft");
    return new Promise((resolve) => {
      releaseWrite = () => resolve(acceptSeatSave(state, payload, envelope));
    });
  } });
  await readySeating(harness);
  placeFromPool(harness, "member_alice", 1, "LEFT");
  await harness.flushTimers();
  await settled(() => harness.seatCalls().length === 1);
  await harness.element("logout-button").emit("click");
  releaseWrite();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.element("seat-console").hidden, true);
  assert.equal(harness.element("seat-pool").children.length, 0);
  assert.equal(harness.element("seat-draft-grid").children.length, 0);
  assert.equal(harness.element("seat-status").textContent, "");
});

test("seat editor CSS keeps touch targets and a single-column mobile workflow", async () => {
  const css = await fs.readFile(new URL("../frontend/styles/seat-plan-admin.css", import.meta.url), "utf8");
  assert.match(css, /min-height:\s*2\.75rem/);
  assert.match(css, /@media \(pointer:\s*coarse\)[\s\S]*min-height:\s*3rem/);
  assert.match(css, /@media \(max-width:\s*42rem\)[\s\S]*grid-template-columns:\s*1fr/);
  assert.match(css, /touch-action:\s*manipulation/);
});

function descendant(element, text) {
  if (element.textContent === text) return element;
  for (const child of element.children) { const found = descendant(child, text); if (found) return found; }
}
async function readySchedule(h) {
  await settled(() => h.element("season-picker").value === "season_test");
  await h.element("open-season").emit("click");
  const edit = descendant(h.element("admin-week-list"), "修改或取消这次训练");
  assert.ok(edit); edit.emit("click");
}
function previewEnvelope(state, payload, envelope) {
  return envelope({ before: { ...state.practice, signup_cutoff_at: "2099-09-09T20:00:00Z" },
    after: { ...state.practice, location: payload.location, signup_cutoff_at: "2099-09-09T20:00:00Z" },
    confirmed_count: 1, waitlisted_count: 2, week_version: 1, practice_version: 1,
    signup_version: 3, preview_token: "reviewed_payload" });
}

test("P1 season changes require in-page review, invalidate changed inputs and preserve another default label", async () => {
  const h = makeHarness({ mutate: async (state, action, payload, _options, envelope) => {
    assert.ok(["updateSeasonSchedule", "setDefaultSeason"].includes(action));
    if (action === "updateSeasonSchedule") {
      state.season.end_date = payload.end_date;
      state.season.season_version++;
    }
    return envelope({ view_status: "ready", current_view: { season: state.season,
      default_season_id: action === "setDefaultSeason" ? "season_test" : "season_other", settings_version: 5 } });
  } });
  await readySchedule(h);
  const picker = h.element("season-picker");
  const other = picker.ownerDocument.createElement("option");
  other.value = "season_other"; other.textContent = "Other season · OPEN · 首页默认";
  picker.append(other);
  const form = h.element("season-schedule-form");
  form.elements.namedItem("end_date").value = "2099-12-30";
  form.emit("submit");
  assert.equal(h.state.calls.filter(c => c.action === "updateSeasonSchedule").length, 0);
  assert.equal(h.element("season-change-save").disabled, true);
  h.element("season-change-confirm").checked = true;
  h.element("season-change-confirm").emit("change");
  assert.equal(h.element("season-change-save").disabled, false);
  form.elements.namedItem("end_date").value = "2099-12-29";
  form.emit("input");
  assert.equal(h.element("season-change-save").disabled, true);
  assert.equal(h.element("season-change-block").hidden, true);
  form.emit("submit");
  h.element("season-change-confirm").checked = true;
  await h.element("season-change-save").emit("click");
  const dates = h.state.calls.filter(c => c.action === "updateSeasonSchedule");
  assert.equal(dates.length, 1);
  assert.equal(dates[0].payload.end_date, "2099-12-29");
  assert.equal(dates[0].payload.season_version, 1);
  assert.equal(other.textContent, "Other season · OPEN · 首页默认");
  assert.equal(h.element("set-default-season").hidden, false);
  h.element("set-default-season").emit("click");
  h.element("season-change-cancel").emit("click");
  assert.equal(h.state.calls.filter(c => c.action === "setDefaultSeason").length, 0);
  h.element("set-default-season").emit("click");
  h.element("season-change-confirm").checked = true;
  await h.element("season-change-save").emit("click");
  const change = h.state.calls.find(c => c.action === "setDefaultSeason");
  assert.equal(change.payload.settings_version, 5);
  assert.equal(other.textContent, "Other season · OPEN");
  assert.equal(picker.options.find(o => o.value === "season_test").textContent, "Test season · OPEN · 首页默认");
});

test("P1 logout clears an unsubmitted season confirmation", async () => {
  const h = makeHarness();
  await readySchedule(h);
  h.element("season-schedule-form").emit("submit");
  assert.equal(h.element("season-change-block").hidden, false);
  await h.element("logout-button").emit("click");
  assert.equal(h.element("season-change-block").hidden, true);
  assert.equal(h.element("season-change-description").textContent, "");
  h.element("season-change-confirm").checked = true;
  await h.element("season-change-save").emit("click");
  assert.equal(h.state.calls.filter(c => c.action === "updateSeasonSchedule").length, 0);
});
test("P1 schedule preview is invalidated by edits and a late preview cannot restore it", async () => {
  let release;
  const h = makeHarness({ mutate: async (state, action, payload, _options, envelope) => {
    assert.equal(action, "previewPracticeChange");
    await new Promise(resolve => { release = resolve; });
    return previewEnvelope(state, payload, envelope);
  } });
  await readySchedule(h);
  h.element("practice-edit-form").emit("submit");
  await settled(() => release);
  h.element("practice-edit-form").elements.namedItem("location").value = "Later input";
  h.element("practice-edit-form").emit("input");
  release();
  await new Promise(resolve => setImmediate(resolve));
  h.element("practice-change-confirm").checked = true;
  h.element("practice-change-confirm").emit("change");
  assert.equal(h.element("practice-change-save").disabled, true);
  assert.match(h.element("practice-change-status").textContent, /重新预览/);
});

test("P1 uncertain schedule change retries the original preview and payload without another write intent", async () => {
  let attempts = 0;
  const h = makeHarness({ mutate: async (state, action, payload, _options, envelope) => {
    if (action === "previewPracticeChange") return previewEnvelope(state, payload, envelope);
    assert.equal(action, "updatePractice");
    if (++attempts === 1) throw new DragonBoatApiError("REQUEST_TIMEOUT", "timeout", { retryable: true });
    state.practice.location = payload.location;
    return envelope({ week: { week_id: "week_test", week_start_date: "2099-09-07", status: "OPENED", week_version: 2 }, practices: [state.practice] });
  } });
  await readySchedule(h);
  h.element("practice-edit-form").elements.namedItem("location").value = "Original edit";
  h.element("practice-edit-form").emit("submit");
  await settled(() => h.element("practice-change-status").textContent.includes("候补 2 人"));
  h.element("practice-change-confirm").checked = true; h.element("practice-change-confirm").emit("change");
  await h.element("practice-change-save").emit("click");
  h.element("practice-edit-form").elements.namedItem("location").value = "Unsent edit";
  const reads = h.state.calls.filter(c => c.action === "getSeasonManagement").length;
  await h.element("management-retry").emit("click");
  const writes = h.state.calls.filter(c => c.action === "updatePractice");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1], writes[0]);
  assert.equal(h.state.practice.location, "Original edit");
  assert.equal(h.state.calls.filter(c => c.action === "getSeasonManagement").length, reads);
  assert.equal(h.element("practice-edit-block").hidden, true);
});

test("P1 confirmed schedule write with failed view requires only a read and clears the old editor", async () => {
  const h = makeHarness({ mutate: async (state, action, payload, _options, envelope) => {
    if (action === "previewPracticeChange") return previewEnvelope(state, payload, envelope);
    return envelope({ view_status: "reload_required" });
  } });
  await readySchedule(h);
  h.element("practice-edit-form").emit("submit");
  await settled(() => h.element("practice-change-status").textContent.includes("候补 2 人"));
  h.element("practice-change-confirm").checked = true; h.element("practice-change-confirm").emit("change");
  await h.element("practice-change-save").emit("click");
  assert.match(h.element("management-status").textContent, /保存已成功/);
  assert.equal(h.element("practice-edit-block").hidden, true);
  assert.equal(h.element("management-retry").hidden, true);
  await h.element("open-season").emit("click");
  assert.equal(h.state.calls.filter(c => c.action === "updatePractice").length, 1);
});

test("P1 logout invalidates a pending preview and clears private schedule input", async () => {
  let release;
  const h = makeHarness({ mutate: async (state, _action, payload, _options, envelope) => {
    await new Promise(resolve => { release = resolve; }); return previewEnvelope(state, payload, envelope);
  } });
  await readySchedule(h);
  h.element("practice-edit-form").emit("submit");
  await settled(() => release);
  await h.element("logout-button").emit("click"); release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.element("practice-edit-block").hidden, true);
  assert.equal(h.element("practice-change-status").textContent, "");
  assert.equal(h.element("practice-edit-form").elements.namedItem("location").value, "");
});

test("P1 schedule session expiry preserves its original write for explicit retry after login", async () => {
  let attempts = 0;
  const h = makeHarness({ mutate: async (state, action, payload, _options, envelope) => {
    if (action === "previewPracticeChange") return previewEnvelope(state, payload, envelope);
    if (++attempts === 1) throw new DragonBoatApiError("SESSION_EXPIRED", "expired");
    return envelope({ week: { week_id: "week_test", week_start_date: "2099-09-07", status: "OPENED", week_version: 2 }, practices: [state.practice] });
  } });
  await readySchedule(h);
  h.element("practice-edit-form").emit("submit");
  await settled(() => h.element("practice-change-status").textContent.includes("候补 2 人"));
  h.element("practice-change-confirm").checked = true;
  await h.element("practice-change-save").emit("click");
  h.element("coach-code").value = "code-for-test";
  await h.element("login-form").emit("submit");
  await h.element("management-retry").emit("click");
  const writes = h.state.calls.filter(c => c.action === "updatePractice");
  assert.equal(writes.length, 2);
  assert.equal(writes[1].options.requestId, writes[0].options.requestId);
  assert.deepEqual({ ...writes[1].payload, session_token: "" }, { ...writes[0].payload, session_token: "" });
  assert.equal(writes[1].payload.session_token, "session_new");
});

test("P1 opening form sends the selected date in the season timezone without browser conversion", async () => {
  const h = makeHarness({ weekStatus: "DRAFT", mutate: async (state, action, _payload, _options, envelope) => {
    assert.equal(action, "confirmTrainingWeek");
    return envelope({ week: { week_id: "week_test", week_start_date: "2099-09-07", status: "SCHEDULED", week_version: 2,
      scheduled_open_at: "2099-09-08T13:00:00Z" }, practices: [state.practice] });
  } });
  await readySchedule(h);
  const heading = h.element("admin-week-list").children[0].children[0];
  const form = heading.children.find(child => child.tagName === "form");
  assert.ok(form);
  form.children[0].children[0].value = "2099-09-08";
  form.children[1].children[0].value = "09:00";
  form.emit("submit");
  await settled(() => h.state.calls.some(call => call.action === "confirmTrainingWeek"));
  const call = h.state.calls.find(call => call.action === "confirmTrainingWeek");
  assert.equal(call.payload.open_date, "2099-09-08");
  assert.equal(call.payload.open_time, "09:00");
  assert.equal(call.payload.open_at, undefined);
});
