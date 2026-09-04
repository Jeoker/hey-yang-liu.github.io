import assert from "node:assert/strict";
import test from "node:test";
import {
  isPublicSeatPlan,
  normalizeSeatPlanRows,
  renderSeatPlan,
  seatPlanSourceLabel
} from "../frontend/lib/seat-plan-view.js";

function domFixture() {
  const document = { createElement: (tagName) => new Element(tagName) };
  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.ownerDocument = document;
      this.children = [];
      this.dataset = {};
      this.textContent = "";
      this.className = "";
    }
    set innerHTML(_value) { throw new Error("Seat names must not be rendered as HTML"); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
  }
  return new Element("div");
}

function textOf(node) {
  return [node.textContent, ...node.children.map(textOf)].filter(Boolean).join("\n");
}

function descendants(node, tagName) {
  return [node, ...node.children.flatMap((child) => descendants(child, tagName))]
    .filter((candidate) => candidate.tagName === tagName);
}

const publishedPlan = (overrides = {}) => ({
  status: "PUBLISHED",
  mode: "UPCOMING",
  seat_plan_version: 4,
  published_revision: 2,
  source: "COACH_PUBLISH",
  published_at: "2026-09-03T22:00:00Z",
  correction_due_at: "2026-09-05T00:00:00Z",
  coach: { display_name: "Coach Liu" },
  steerer: { display_name: "Steerer Wang" },
  rows: [
    { row_number: 1, left: { member_id: "private-left", display_name: '<img src=x onerror="alert(1)">', preference: "LEFT" }, right: null },
    { row_number: 10, left: "Flexible Paddler", right: { display_name: "Right Paddler", preference: "AMBIENT" } }
  ],
  ...overrides
});

test("shared seat plan renders one physical ten-row boat from the formal revision", () => {
  const container = domFixture();
  const result = renderSeatPlan(container, publishedPlan(), { timeZone: "America/New_York" });
  const text = textOf(container);
  assert.equal(result.published, true);
  assert.equal(container.dataset.state, "published");
  assert.match(text, /最新正式版/);
  assert.match(text, /Revision 2 · Coach 发布/);
  assert.match(text, /Coach Liu/);
  assert.match(text, /Steerer Wang/);
  assert.match(text, /船头/);
  assert.match(text, /船尾/);
  assert.match(text, /<img src=x onerror="alert\(1\)">/);
  assert.match(text, /Left 偏好/);
  assert.match(text, /Ambient 偏好/);
  assert.doesNotMatch(text, /private-left/);
  const bodies = descendants(container, "tbody");
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].children.length, 10);
  assert.deepEqual(bodies[0].children.map((row) => row.children[1].textContent), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
});

test("unpublished plans never render rows, roles, or accidental draft data", () => {
  const container = domFixture();
  const result = renderSeatPlan(container, {
    ...publishedPlan(),
    status: "UNPUBLISHED",
    published_revision: 0,
    coach: { display_name: "Private Coach Draft" },
    rows: [{ row_number: 1, left: { display_name: "Private Seat Draft" } }],
    draft: { rows: [{ row_number: 2, right: { display_name: "Nested Secret" } }] }
  });
  assert.equal(result.published, false);
  assert.equal(container.dataset.state, "unpublished");
  assert.match(textOf(container), /尚未发布/);
  assert.doesNotMatch(textOf(container), /Private|Nested Secret/);
  assert.equal(descendants(container, "table").length, 0);
});

test("row normalization ignores invalid and duplicate row numbers without exposing extra seats", () => {
  const rows = normalizeSeatPlanRows({ rows: [
    { row_number: 1, left: "First" },
    { row_number: 1, left: "Duplicate" },
    { row_number: 0, left: "Before bow" },
    { row_number: 11, right: "After stern" }
  ] });
  assert.equal(rows.length, 10);
  assert.equal(rows[0].left.display_name, "First");
  assert.equal(rows[0].right, null);
  assert.ok(rows.slice(1).every((row) => row.left === null && row.right === null));
  assert.equal(isPublicSeatPlan(publishedPlan()), true);
  assert.equal(isPublicSeatPlan({ ...publishedPlan(), published_revision: 0 }), false);
  assert.equal(seatPlanSourceLabel("SYSTEM_PREFERENCE"), "修改偏好后系统更新");
  assert.equal(seatPlanSourceLabel("SYSTEM_CANCELSIGNUPBYCOACH"), "取消报名后系统更新");
  assert.equal(seatPlanSourceLabel("private_internal_value"), "座位表更新");
});

test("frozen plans remain readable and explain the server correction boundary", () => {
  const container = domFixture();
  renderSeatPlan(container, publishedPlan({ status: "FROZEN", mode: "FROZEN",
    correction_due_at: "", archive_due_at: "2026-09-05T00:00:00Z" }), { timeZone: "America/New_York" });
  assert.equal(container.dataset.state, "frozen");
  assert.match(textOf(container), /已冻结正式版/);
  assert.match(textOf(container), /冻结/);
});
