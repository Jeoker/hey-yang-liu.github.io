export function groupHistorySeasons(seasons) {
  const groups = new Map();
  for (const season of Array.isArray(seasons) ? seasons : []) {
    if (!season || !season.season_id) continue;
    const year = /^\d{4}$/.test(String(season.archive_year || ""))
      ? String(season.archive_year)
      : String(season.end_date || "").slice(0, 4) || "其他年份";
    if (!groups.has(year)) groups.set(year, []);
    groups.get(year).push(season);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([year, entries]) => ({
      year,
      seasons: entries.sort((left, right) =>
        String(right.latest_practice_at || right.end_date || "").localeCompare(
          String(left.latest_practice_at || left.end_date || "")
        )
      )
    }));
}

export function visibleHistoryPractices(practices) {
  return (Array.isArray(practices) ? practices : [])
    .filter((practice) => practice && practice.practice_id && !practice.cancelled && !practice.cancelled_at)
    .sort((left, right) => String(right.start_at || "").localeCompare(String(left.start_at || "")));
}

export function historyHref(basePath, seasonId, practiceId = "") {
  const url = new URL(basePath, "https://history.invalid");
  if (seasonId) url.searchParams.set("season_id", String(seasonId));
  if (practiceId) url.searchParams.set("practice_id", String(practiceId));
  return `${url.pathname}${url.search}`;
}
