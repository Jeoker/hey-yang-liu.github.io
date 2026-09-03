import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { DragonBoatApiError } from "../frontend/lib/api-client.js";
import { validPracticeView, olderPracticeView } from "../frontend/lib/current-view.js";
import { renderSignupList, signupResultText } from "../frontend/lib/signup-view.js";

const source = await fs.readFile(new URL("../frontend/components/CoachModeApp.astro", import.meta.url), "utf8");
const script = source.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*;$/gm, "");
const compiled = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;

function makeHarness({ mutate, readWorkspace } = {}) {
  const elements = new Map();
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
    getAttribute(key) { return key === "data-api-url" ? "http://localhost:4322/api" : ""; }
    addEventListener(event, handler) { this.listeners.set(event, handler); }
    emit(event) { return this.listeners.get(event)?.({ preventDefault() {} }); }
    reset() { for (const field of this.fields.values()) field.value = field.defaultValue; }
    get selectedOptions() { return this.children.filter((child) => child.value === this.value); }
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
  const state = {
    calls: [], requestCounter: 0, practiceReads: 0, failNextPracticeRead: false,
    signupVersion: 1, signups: [], season, practice,
    members: [{ member_id: "member_alice", display_name: "Alice", source_display_name: "Alice Source", display_name_override: "Alice", status: "ACTIVE", default_preference: "AMBIENT", member_version: 1, active_links: [] }]
  };
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
      if (action === "coachBootstrap") return envelope({ panels: [], coach: { display_name: "Test Coach" }, session: { expires_at: "2099-12-31T00:00:00Z" }, default_season_id: season.season_id, seasons: [season] });
      if (action === "getSeasonManagement") return envelope({ season, is_default: true, members: state.members, templates: [], weeks: [{ week: { week_id: "week_test", status: "OPENED", week_start_date: "2099-09-07", week_version: 1 }, practices: [practice] }] });
      if (action === "listSeasonMembers") return envelope({ season_id: season.season_id, roster_version: season.roster_version, members: state.members });
      if (action === "getMemberWorkspace") {
        if (readWorkspace) await readWorkspace(state);
        return envelope({ season_id: season.season_id, season, practices: [practice],
        season_status: "OPEN", roster_version: season.roster_version, binding_version: 1,
        members: state.members, member_links: {}, practice: (await this.get("practice")).data });
      }
      if (action === "coachLogin") return envelope({ session_token: "session_new", session: { expires_at: "2099-12-31T00:00:00Z" } });
      if (action === "coachLogout") return envelope({});
      if (mutate) return mutate(state, action, payload, options, envelope);
      throw new Error(`Unexpected POST ${action}`);
    }
  }
  class FormDataMock {
    constructor(form) { this.form = form; }
    entries() { return [...this.form.fields.entries()].map(([key, value]) => [key, value.value]); }
  }
  const context = vm.createContext({ document, Date, Intl, Error, console, structuredClone, FormData: FormDataMock,
    DragonBoatApiClient: Client, DragonBoatApiError,
    createRequestId: () => `request_${++state.requestCounter}`,
    loadCoachSession: () => ({ token: "session_old" }), saveCoachSession() {}, clearCoachSession() {},
    isCoachSessionError: (error) => ["SESSION_INVALID", "SESSION_EXPIRED", "SESSION_REVOKED"].includes(error?.code),
    renderSignupList, signupResultText, validPracticeView, olderPracticeView });
  vm.runInContext(compiled, context);
  const element = (name) => {
    const found = elements.get(`[data-${name}]`);
    assert.ok(found, `Missing control ${name}`);
    return found;
  };
  return { state, element, mutationCalls: () => state.calls.filter((call) => /signupByCoach|SignupByCoach|Member|createSeason/.test(call.action) && !["listSeasonMembers", "getMemberWorkspace"].includes(call.action)) };
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
