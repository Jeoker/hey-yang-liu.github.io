import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { DragonBoatApiError } from "../frontend/lib/api-client.js";
import { validPracticeView, olderPracticeView, usableRoster } from "../frontend/lib/current-view.js";
import { renderSignupList, signupPreferenceLabels, signupResultText } from "../frontend/lib/signup-view.js";
import { isPublicSeatPlan, renderSeatPlan, seatPlanSourceLabel } from "../frontend/lib/seat-plan-view.js";

const astroSource = await fs.readFile(new URL("../frontend/components/DragonBoatApp.astro", import.meta.url), "utf8");
const script = astroSource.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*;$/gm, "");
const compiledScript = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;

function makeHarness({ post, readPractice, publishedPractices = [], seatPlan } = {}) {
  const elements = new Map();
  const documentListeners = new Map();
  const document = {
    visibilityState: "visible",
    createElement: (tag) => new Element(tag),
    querySelector: (selector) => elements.get(selector),
    addEventListener: (event, handler) => documentListeners.set(event, handler)
  };
  class Element {
    constructor(tag) {
      this.tagName = tag;
      this.ownerDocument = document;
      this.children = [];
      this.listeners = new Map();
      this.dataset = {};
      this.value = "";
      this.textContent = "";
      this.hidden = false;
      this.disabled = false;
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    querySelector(selector) { return elements.get(selector); }
    querySelectorAll() { return []; }
    getAttribute(key) { return key === "data-api-url" ? "http://localhost:4322/api" : ""; }
    addEventListener(event, handler) { this.listeners.set(event, handler); }
    emit(event) { return this.listeners.get(event)?.({ preventDefault() {} }); }
    focus() {}
    scrollIntoView() {}
  }
  for (const match of astroSource.matchAll(/<(\w+)[^>]*\s(data-[\w-]+)(?:\s|>|=)/g)) {
    elements.set(`[${match[2]}]`, new Element(match[1]));
  }
  // The component root has two data attributes; selector lookup needs only its first.
  elements.set("[data-dragon-boat-app]", new Element("div"));
  const season = { season_id: "season_test", name: "Test season", status: "OPEN", start_date: "2099-01-01", end_date: "2099-12-31", timezone: "America/New_York", roster_version: 1, binding_version: 1, join_form_url: "https://example.com/join" };
  const practice = { practice_id: "practice_test", practice_version: 1, timezone: "America/New_York", start_at: "2099-09-09T22:00:00.000Z", end_at: "2099-09-10T00:00:00.000Z", signup_cutoff_at: "2099-09-09T20:00:00.000Z", location: "Test Dock", address: "Test Road" };
  const state = {
    practiceReads: 0,
    posts: [],
    signupVersion: 1,
    signups: [],
    failNextRead: false,
    season,
    practice,
    seatPlan
  };
  const envelope = (data) => ({ data, meta: { server_time: new Date().toISOString(), contract_version: "test" } });
  class Client {
    async get(action) {
      if (action === "bootstrap") return envelope({ season, state: "ACTIVE", weeks: publishedPractices.length ? [{ week_start_date: "2099-09-07", practices: publishedPractices.map((overrides) => ({ ...practice, ...overrides })) }] : [] });
      if (action === "members") return envelope({ season_id: season.season_id, roster_version: 1, binding_version: 1, members: [{ member_id: "member_alice", display_name: "Alice", default_preference: "AMBIENT" }, { member_id: "member_bob", display_name: "Bob", default_preference: "LEFT" }], expires_at: "2099-09-09T20:00:00.000Z" });
      if (action === "practice") {
        state.practiceReads++;
        if (readPractice) await readPractice(state);
        if (state.failNextRead) { state.failNextRead = false; throw new DragonBoatApiError("NETWORK_ERROR", "read failed", { retryable: true }); }
        return envelope({ season_id: season.season_id, practice, roster_version: 1, binding_version: 1, signup_version: state.signupVersion, signup_open: true, closed_reason: "", counts: { confirmed: state.signups.length, waitlisted: 0, left: 0, ambient: state.signups.length, right: 0, total_capacity: 20, left_capacity: 10, right_capacity: 10 }, signups: state.signups, ...(state.seatPlan ? { seat_plan: state.seatPlan } : {}) });
      }
      throw new Error(`Unexpected GET ${action}`);
    }
    async post(action, payload, options) {
      state.posts.push(structuredClone({ action, payload, options }));
      if (post) return post(state, action, payload, options, envelope);
      throw new Error("Unexpected POST");
    }
  }
  const context = vm.createContext({
    document,
    window: { location: { href: "http://localhost:4321/dragon-boat-training/?season_id=season_test&practice_id=practice_test" }, history: { replaceState() {} }, addEventListener() {}, setInterval() {} },
    URL, Intl, Date, console,
    DragonBoatApiClient: Client, DragonBoatApiError,
    createRequestId: () => `request_${state.posts.length + 1}`,
    loadRosterSnapshot: () => null, saveRosterSnapshot() {},
    renderSignupList, signupPreferenceLabels, signupResultText, isPublicSeatPlan, renderSeatPlan, seatPlanSourceLabel,
    validPracticeView, olderPracticeView, usableRoster
  });
  vm.runInContext(compiledScript, context);
  const element = (name) => {
    const found = elements.get(`[data-${name}]`);
    assert.ok(found, `Missing UI control ${name}`);
    return found;
  };
  return { state, element, context };
}

async function settled(predicate) {
  for (let step = 0; step < 30; step++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(predicate(), "UI did not reach the expected state");
}

function textOf(node) {
  return [node.textContent, ...node.children.map(textOf)].filter(Boolean).join("\n");
}

async function selectAndConfirm(harness) {
  await settled(() => harness.element("signup-status").textContent.includes("已读取最新报名情况"));
  harness.element("member-select").value = "member_alice";
  harness.element("member-select").emit("change");
  assert.equal(harness.element("signup-preference").value, "AMBIENT");
  harness.element("signup-form").emit("submit");
  assert.equal(harness.element("signup-confirm").hidden, false);
  assert.match(harness.element("confirm-text").textContent, /Alice/);
  harness.element("confirm-action").emit("click");
}

test("uncertain public signup freezes inputs and replays the same request and payload", async () => {
  const harness = makeHarness({ post: async (state, _action, payload, _options, envelope) => {
    if (state.posts.length === 1) throw new DragonBoatApiError("REQUEST_TIMEOUT", "unknown outcome", { retryable: true });
    state.signupVersion++;
    state.signups = [{ member_id: payload.member_id, display_name: "Alice", preference: payload.preference, status: "CONFIRMED" }];
    return envelope({ signup: state.signups[0], promoted_member_ids: [] });
  } });
  await selectAndConfirm(harness);
  await settled(() => harness.element("signup-status").textContent.includes("暂时无法确认"));
  assert.equal(harness.element("member-select").disabled, true);
  assert.equal(harness.element("signup-preference").disabled, true);
  assert.equal(harness.element("refresh-practice").disabled, true);
  assert.equal(harness.element("retry-signup").hidden, false);
  harness.element("retry-signup").emit("click");
  await settled(() => harness.element("signup-status").textContent.includes("已确认 Ambient"));
  assert.equal(harness.state.posts.length, 2);
  assert.deepEqual(harness.state.posts[0], harness.state.posts[1]);
  assert.equal(harness.element("retry-signup").hidden, true);
  assert.equal(harness.element("member-select").disabled, false);
});

test("public signup renders the committed current view without another practice read", async () => {
  const harness = makeHarness({ post: (state, _action, payload, _options, envelope) => {
    assert.equal(payload.include_current_view, true);
    state.signupVersion++;
    state.signups = [{ member_id: payload.member_id, display_name: "Alice", preference: "LEFT", status: "CONFIRMED" }];
    return envelope({ signup: state.signups[0], view_status: "ready", current_view: {
      season_id: state.season.season_id, season_status: "OPEN", roster_version: 1, binding_version: 1,
      generated_at: new Date().toISOString(), practice: { season_id: state.season.season_id, practice: state.practice,
        roster_version: 1, binding_version: 1, signup_version: state.signupVersion, signup_open: true,
        counts: { confirmed: 1, total_capacity: 20, waitlisted: 0, left: 1, right: 0, ambient: 0 }, signups: state.signups }
    } });
  } });
  await selectAndConfirm(harness);
  await settled(() => harness.element("signup-status").textContent.includes("已确认 Left"));
  assert.equal(harness.state.posts.length, 1);
  assert.equal(harness.state.practiceReads, 1);
  assert.equal(harness.element("signup-preference").disabled, false);
});

test("public practice renders only the formal seat plan and accepts a newer mutation revision", async () => {
  const originalPlan = { status: "PUBLISHED", mode: "UPCOMING", seat_plan_version: 1,
    published_revision: 1, source: "COACH_PUBLISH", published_at: "2099-09-01T00:00:00Z",
    correction_due_at: "2099-09-11T00:00:00Z", coach: { display_name: "Coach Liu" },
    steerer: null, rows: [{ row_number: 1, left: { display_name: "Alice", preference: "LEFT" }, right: null }] };
  const harness = makeHarness({ seatPlan: originalPlan, post: (state, _action, payload, _options, envelope) => {
    state.signupVersion++;
    state.signups = [{ member_id: payload.member_id, display_name: "Alice", preference: "AMBIENT", status: "CONFIRMED" }];
    state.seatPlan = { ...originalPlan, seat_plan_version: 2, published_revision: 2,
      source: "SYSTEM_PREFERENCE", rows: [{ row_number: 1, left: null, right: { display_name: "Bob", preference: "AMBIENT" } }] };
    return envelope({ signup: state.signups[0], promoted_member_ids: ["member_bob"], view_status: "ready", current_view: {
      season_id: state.season.season_id, season_status: "OPEN", roster_version: 1, binding_version: 1,
      generated_at: new Date().toISOString(), practice: { season_id: state.season.season_id, practice: state.practice,
        roster_version: 1, binding_version: 1, signup_version: state.signupVersion, signup_open: true,
        counts: { confirmed: 1, total_capacity: 20, waitlisted: 0, left: 0, right: 0, ambient: 1 },
        signups: state.signups, seat_plan: state.seatPlan }
    } });
  } });
  await settled(() => textOf(harness.element("seat-plan-view")).includes("Revision 1"));
  assert.match(textOf(harness.element("seat-plan-view")), /Alice/);
  assert.match(textOf(harness.element("seat-plan-view")), /Coach Liu/);
  await selectAndConfirm(harness);
  await settled(() => textOf(harness.element("seat-plan-view")).includes("Revision 2"));
  assert.match(textOf(harness.element("seat-plan-view")), /Bob/);
  assert.doesNotMatch(textOf(harness.element("seat-plan-view")), /Alice/);
  assert.equal(harness.state.practiceReads, 1);
});

test("a slow public refresh keeps fields editable and preserves a new side choice", async () => {
  let release;
  const harness = makeHarness({ readPractice: state => state.practiceReads > 1 ? new Promise(resolve => { release = resolve; }) : undefined });
  await settled(() => harness.element("signup-status").textContent.includes("已读取最新报名情况"));
  harness.element("member-select").value = "member_alice";
  harness.element("member-select").emit("change");
  harness.element("refresh-practice").emit("click");
  assert.equal(harness.element("member-select").disabled, false);
  assert.equal(harness.element("signup-preference").disabled, false);
  harness.element("signup-preference").value = "RIGHT";
  harness.element("signup-preference").emit("change");
  release();
  await settled(() => harness.element("refresh-practice").disabled === false);
  assert.equal(harness.element("signup-preference").value, "RIGHT");
  assert.equal(harness.state.posts.length, 0);
});

test("accepted public signup with failed readback retries GET without another POST", async () => {
  const harness = makeHarness({ post: async (state, _action, payload, _options, envelope) => {
    state.signups = [{ member_id: payload.member_id, display_name: "Alice", preference: payload.preference, status: "CONFIRMED" }];
    state.failNextRead = true;
    return envelope({ signup: state.signups[0], promoted_member_ids: [] });
  } });
  await selectAndConfirm(harness);
  await settled(() => harness.element("signup-status").textContent.includes("服务器已接受操作"));
  assert.equal(harness.element("retry-signup").textContent, "重新读取最终报名结果");
  assert.equal(harness.element("member-select").disabled, true);
  harness.element("retry-signup").emit("click");
  await settled(() => harness.element("signup-status").textContent.includes("已确认 Ambient"));
  assert.equal(harness.state.posts.length, 1);
  assert.equal(harness.state.practiceReads, 3);
});

test("version conflict refreshes state and requires another explicit confirmation", async () => {
  const harness = makeHarness({ post: async (state) => {
    state.signupVersion = 2;
    state.signups = [{ member_id: "member_alice", display_name: "Alice", preference: "RIGHT", status: "CONFIRMED" }];
    throw new DragonBoatApiError("VERSION_CONFLICT", "another update won");
  } });
  await selectAndConfirm(harness);
  await settled(() => harness.element("signup-status").textContent.includes("重新选择并确认"));
  assert.equal(harness.state.practiceReads, 2);
  assert.equal(harness.state.posts.length, 1);
  assert.equal(harness.element("signup-preference").value, "RIGHT");
  assert.equal(harness.element("retry-signup").hidden, true);
  assert.equal(harness.element("signup-confirm").hidden, true);
  assert.equal(harness.element("member-select").disabled, false);
});

test("published cards distinguish cancelled and ended training before opening details", async () => {
  const harness = makeHarness({ publishedPractices: [
    { practice_id: "practice_cancelled", cancelled: true, location: "Cancelled Dock" },
    { practice_id: "practice_ended", end_at: "2000-09-10T00:00:00.000Z", location: "Ended Dock" },
    { practice_id: "practice_upcoming", location: "Upcoming Dock" }
  ] });
  await settled(() => harness.element("signup-status").textContent.includes("已读取最新报名情况"));
  const cards = harness.element("week-cards").children[0].children[1].children;
  assert.equal(cards[0].children[1].textContent, "已取消 · 报名只读");
  assert.equal(cards[1].children[1].textContent, "已结束 · 报名只读");
  assert.equal(cards[2].children[1].textContent, "已发布 · 查看最新报名状态");
  assert.ok(cards.every((card) => card.children.at(-1).textContent === "查看报名、候补与座位"));
});
