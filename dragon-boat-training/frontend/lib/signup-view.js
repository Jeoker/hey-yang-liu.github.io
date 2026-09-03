export const signupPreferenceLabels = {
  LEFT: "Left · 左侧",
  AMBIENT: "Ambient · 左右均可",
  RIGHT: "Right · 右侧"
};

/** Render server-confirmed state only; this view does not allocate places. */
export function renderSignupList(container, signups = []) {
  if (!container) return;
  const doc = container.ownerDocument;
  container.replaceChildren();
  const records = Array.isArray(signups) ? signups : [];
  const groups = [
    ...Object.entries(signupPreferenceLabels).map(([preference, label]) => ({
      label, records: records.filter((row) => row.status === "CONFIRMED" && row.preference === preference)
    })),
    { label: "候补", records: records.filter((row) => row.status === "WAITLISTED") }
  ];
  const cancelled = records.filter((row) => row.status === "CANCELLED");
  if (cancelled.length) groups.push({ label: "已取消", records: cancelled });
  const grid = doc.createElement("div");
  grid.className = "dragon-boat-signup-groups";
  groups.forEach((group) => {
    const section = doc.createElement("section");
    section.className = "dragon-boat-signup-group";
    const heading = doc.createElement("h4");
    heading.textContent = `${group.label}（${group.records.length}）`;
    section.append(heading);
    if (!group.records.length) {
      const empty = doc.createElement("p");
      empty.className = "dragon-boat-signup-empty";
      empty.textContent = "暂无队员";
      section.append(empty);
    } else {
      const list = doc.createElement("ul");
      group.records.forEach((row) => {
        const item = doc.createElement("li");
        const name = doc.createElement("strong");
        name.textContent = String(row.display_name || "未命名队员");
        const state = doc.createElement("span");
        state.textContent = row.status === "CONFIRMED"
          ? "已确认，待排座"
          : row.status === "CANCELLED" ? "已取消"
          : `${signupPreferenceLabels[row.preference] || ""} · 候补${row.waitlist_position ? `第 ${row.waitlist_position} 位` : "中"}`;
        item.append(name, state);
        list.append(item);
      });
      section.append(list);
    }
    grid.append(section);
  });
  container.append(grid);
}

/** Accept either a signup row or a write result containing its signup. */
export function signupResultText(result) {
  const signup = result?.signup || result;
  if (!signup) return "尚未报名本次训练。";
  const preference = signupPreferenceLabels[signup.preference] || "所选侧向";
  let text = signup.status === "CANCELLED" ? "报名已取消；重新报名将使用新的排队时间。"
    : signup.status === "WAITLISTED"
    ? `已加入 ${preference} 候补${signup.waitlist_position ? `，第 ${signup.waitlist_position} 位` : ""}。`
    : signup.status === "CONFIRMED" ? `已确认 ${preference} 报名，待教练安排具体座位。`
    : "正在核实报名状态。";
  if (Array.isArray(result?.promoted_member_ids) && result.promoted_member_ids.length) {
    text += ` 本次操作后，${result.promoted_member_ids.length} 名候补已由系统自动递补。`;
  }
  return text;
}
