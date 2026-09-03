import assert from "node:assert/strict";
import test from "node:test";
import { renderSignupList, signupResultText } from "../frontend/lib/signup-view.js";

function domFixture() {
  const document = { createElement: (tagName) => new Element(tagName) };
  class Element {
    constructor(tagName) {
      this.tagName = tagName;
      this.ownerDocument = document;
      this.children = [];
      this.textContent = "";
    }
    set innerHTML(_value) { throw new Error("Names must not be rendered as HTML"); }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
  }
  return new Element("div");
}

function textOf(node) {
  return [node.textContent, ...node.children.map(textOf)].filter(Boolean).join("\n");
}

test("shared signup list uses server states and renders names as literal text", () => {
  const container = domFixture();
  renderSignupList(container, [
    { member_id: "private-id", display_name: '<img src=x onerror="alert(1)">', status: "CONFIRMED", preference: "LEFT" },
    { display_name: "Flexible", status: "CONFIRMED", preference: "AMBIENT" },
    { display_name: "First waiting", status: "WAITLISTED", preference: "AMBIENT", waitlist_position: 1 },
    { display_name: "Second waiting", status: "WAITLISTED", preference: "LEFT", waitlist_position: 2 },
    { display_name: "Cancelled", status: "CANCELLED", preference: "RIGHT" }
  ]);
  const groups = container.children[0].children;
  assert.match(textOf(groups[0]), /Left · 左侧（1）/);
  assert.match(textOf(groups[0]), /<img src=x onerror="alert\(1\)">/);
  assert.match(textOf(groups[1]), /Ambient · 左右均可（1）/);
  assert.match(textOf(groups[2]), /Right · 右侧（0）/);
  assert.match(textOf(groups[3]), /候补（2）/);
  assert.ok(textOf(groups[3]).indexOf("First waiting") < textOf(groups[3]).indexOf("Second waiting"));
  assert.match(textOf(groups[4]), /已取消（1）/);
  assert.doesNotMatch(textOf(container), /private-id/);

  renderSignupList(container, []);
  assert.equal(container.children.length, 1);
  assert.equal(container.children[0].children.length, 4);
  assert.doesNotMatch(textOf(container), /Flexible|First waiting|Cancelled/);
});

test("signup result distinguishes waitlist, cancellation, and server promotions", () => {
  assert.match(signupResultText({ status: "WAITLISTED", preference: "RIGHT", waitlist_position: 2 }), /候补，第 2 位/);
  assert.match(signupResultText({ status: "CONFIRMED", preference: "AMBIENT" }), /待教练安排具体座位/);
  const cancelled = signupResultText({ signup: { status: "CANCELLED" }, promoted_member_ids: ["member-1"] });
  assert.match(cancelled, /新的排队时间/);
  assert.match(cancelled, /1 名候补已由系统自动递补/);
  assert.equal(signupResultText(null), "尚未报名本次训练。");
  assert.equal(signupResultText({ status: "UNRECOGNIZED" }), "正在核实报名状态。");
});
