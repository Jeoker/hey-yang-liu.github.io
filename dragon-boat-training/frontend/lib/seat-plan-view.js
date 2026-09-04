const PUBLIC_SEAT_PLAN_STATES = new Set(["PUBLISHED", "FROZEN"]);

const preferenceLabels = {
  LEFT: "Left 偏好",
  AMBIENT: "Ambient 偏好",
  RIGHT: "Right 偏好"
};

const sourceLabels = {
  MANUAL: "Coach 发布",
  MANUAL_PUBLISH: "Coach 发布",
  COACH_PUBLISH: "Coach 发布",
  SYSTEM_CANCEL: "取消报名后系统更新",
  SIGNUP_CANCELLED: "取消报名后系统更新",
  SYSTEM_PREFERENCE: "修改偏好后系统更新",
  PREFERENCE_CHANGE: "修改偏好后系统更新",
  SYSTEM_PROMOTION: "候补递补后系统更新",
  WAITLIST_PROMOTION: "候补递补后系统更新",
  FINAL_CORRECTION: "最终座位更正",
  CORRECTION: "最终座位更正",
  SYSTEM: "系统更新"
};

export function isPublicSeatPlan(seatPlan) {
  return Boolean(seatPlan && PUBLIC_SEAT_PLAN_STATES.has(String(seatPlan.status))
    && Number.isInteger(seatPlan.published_revision) && seatPlan.published_revision > 0);
}

export function seatPlanSourceLabel(source) {
  const normalized = String(source || "").toUpperCase();
  if (sourceLabels[normalized]) return sourceLabels[normalized];
  if (normalized.startsWith("SYSTEM_") && normalized.includes("CANCEL")) return "取消报名后系统更新";
  if (normalized.startsWith("SYSTEM_") && normalized.includes("UPDATE")) return "修改偏好后系统更新";
  if (normalized.startsWith("SYSTEM_") && normalized.includes("PROMOT")) return "候补递补后系统更新";
  if (normalized.startsWith("SYSTEM_") && normalized.includes("SIGNUP")) return "报名变化后系统更新";
  return "座位表更新";
}

export function normalizeSeatPlanRows(seatPlan, rowCount = 10) {
  const byNumber = new Map();
  if (Array.isArray(seatPlan?.rows)) {
    seatPlan.rows.forEach((row) => {
      const rowNumber = Number(row?.row_number);
      if (Number.isInteger(rowNumber) && rowNumber >= 1 && rowNumber <= rowCount && !byNumber.has(rowNumber)) {
        byNumber.set(rowNumber, {
          row_number: rowNumber,
          left: normalizePerson(row.left),
          right: normalizePerson(row.right)
        });
      }
    });
  }
  return Array.from({ length: rowCount }, (_, index) => byNumber.get(index + 1) || {
    row_number: index + 1,
    left: null,
    right: null
  });
}

/**
 * Render one server-confirmed public seat plan. This function never reads a
 * draft or decides who should occupy a seat. Coach Mode can reuse the table
 * structure and add its own event handling around it.
 */
export function renderSeatPlan(container, seatPlan, { timeZone } = {}) {
  if (!container) return { published: false };
  const doc = container.ownerDocument;
  container.replaceChildren();
  const published = isPublicSeatPlan(seatPlan);
  container.dataset.state = published ? String(seatPlan.status).toLowerCase() : "unpublished";

  if (!published) {
    const empty = doc.createElement("p");
    empty.className = "dragon-boat-seat-plan-empty";
    empty.textContent = String(seatPlan?.status) === "FROZEN"
      ? "本次训练没有已发布的正式座位表。"
      : "座位表尚未发布。已确认报名仍以报名清单为准，具体船位由 Coach 安排。";
    container.append(empty);
    return { published: false };
  }

  const meta = doc.createElement("div");
  meta.className = "dragon-boat-seat-plan-meta";
  const badge = doc.createElement("strong");
  badge.className = "dragon-boat-seat-plan-badge";
  badge.textContent = seatPlan.status === "FROZEN" ? "已冻结正式版" : "最新正式版";
  const revision = doc.createElement("span");
  revision.textContent = `Revision ${seatPlan.published_revision} · ${seatPlanSourceLabel(seatPlan.source)}`;
  meta.append(badge, revision);
  if (seatPlan.published_at) {
    const publishedAt = doc.createElement("span");
    publishedAt.textContent = `发布于 ${formatDateTime(seatPlan.published_at, timeZone)}`;
    meta.append(publishedAt);
  }

  const roles = doc.createElement("dl");
  roles.className = "dragon-boat-seat-plan-roles";
  appendRole(roles, "Coach", seatPlan.coach);
  appendRole(roles, "Steerer", seatPlan.steerer);

  const boat = doc.createElement("div");
  boat.className = "dragon-boat-seat-plan-boat";
  const bow = doc.createElement("p");
  bow.className = "dragon-boat-seat-plan-direction";
  bow.textContent = "船头";

  const table = doc.createElement("table");
  table.className = "dragon-boat-seat-plan-table";
  const caption = doc.createElement("caption");
  caption.className = "dragon-boat-visually-hidden";
  caption.textContent = "正式龙舟座位表，共十排，左侧与右侧各一个船位";
  const head = doc.createElement("thead");
  const headRow = doc.createElement("tr");
  const leftHeading = doc.createElement("th");
  leftHeading.scope = "col";
  leftHeading.textContent = "Left · 左侧";
  const rowHeading = doc.createElement("th");
  rowHeading.scope = "col";
  rowHeading.className = "dragon-boat-seat-plan-row-heading";
  rowHeading.textContent = "排";
  const rightHeading = doc.createElement("th");
  rightHeading.scope = "col";
  rightHeading.textContent = "Right · 右侧";
  headRow.append(leftHeading, rowHeading, rightHeading);
  head.append(headRow);

  const body = doc.createElement("tbody");
  normalizeSeatPlanRows(seatPlan).forEach((row) => {
    const tableRow = doc.createElement("tr");
    const left = renderSeat(doc, row.left);
    const number = doc.createElement("th");
    number.scope = "row";
    number.textContent = String(row.row_number);
    const right = renderSeat(doc, row.right);
    tableRow.append(left, number, right);
    body.append(tableRow);
  });
  table.append(caption, head, body);

  const stern = doc.createElement("p");
  stern.className = "dragon-boat-seat-plan-direction";
  stern.textContent = "船尾";
  boat.append(bow, table, stern);

  const timing = correctionText(doc, seatPlan, timeZone);
  container.append(meta, roles, boat);
  if (timing) container.append(timing);
  return { published: true, rows: body.children };
}

function normalizePerson(value) {
  if (typeof value === "string") {
    const displayName = value.trim();
    return displayName ? { display_name: displayName, preference: "" } : null;
  }
  if (!value || typeof value !== "object") return null;
  const displayName = String(value.display_name || value.name || "").trim();
  if (!displayName) return null;
  const preference = Object.hasOwn(preferenceLabels, value.preference) ? value.preference : "";
  return { display_name: displayName, preference };
}

function appendRole(container, label, person) {
  const doc = container.ownerDocument;
  const group = doc.createElement("div");
  const term = doc.createElement("dt");
  term.textContent = label;
  const description = doc.createElement("dd");
  description.textContent = normalizePerson(person)?.display_name || "尚未公布";
  group.append(term, description);
  container.append(group);
}

function renderSeat(doc, person) {
  const cell = doc.createElement("td");
  if (!person) {
    const empty = doc.createElement("span");
    empty.className = "dragon-boat-seat-plan-open-seat";
    empty.textContent = "空位";
    cell.append(empty);
    return cell;
  }
  const name = doc.createElement("strong");
  name.textContent = person.display_name;
  cell.append(name);
  if (person.preference) {
    const preference = doc.createElement("span");
    preference.className = "dragon-boat-seat-plan-preference";
    preference.textContent = preferenceLabels[person.preference];
    cell.append(preference);
  }
  return cell;
}

function correctionText(doc, seatPlan, timeZone) {
  const correctionDueAt = seatPlan.correction_due_at || seatPlan.archive_due_at;
  if (!correctionDueAt) return null;
  const paragraph = doc.createElement("p");
  paragraph.className = "dragon-boat-seat-plan-correction";
  paragraph.textContent = seatPlan.status === "FROZEN" || seatPlan.mode === "FROZEN"
    ? `本座位表已在 ${formatDateTime(correctionDueAt, timeZone)} 后冻结。`
    : seatPlan.mode === "FINAL_CORRECTION"
      ? `当前处于最终更正期，截止 ${formatDateTime(correctionDueAt, timeZone)}。`
      : `最终更正截止 ${formatDateTime(correctionDueAt, timeZone)}。`;
  return paragraph;
}

function formatDateTime(value, timeZone) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间待确认";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      ...(timeZone ? { timeZone } : {}),
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }).format(date);
  } catch {
    return date.toLocaleString("zh-CN");
  }
}
