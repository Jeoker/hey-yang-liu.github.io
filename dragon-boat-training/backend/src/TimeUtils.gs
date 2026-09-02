function requireIsoDate_(value, fieldName) {
  value = typeof value === "string" ? value.trim() : "";
  var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw dragonBoatRequestError_("INVALID_REQUEST", "A valid " + fieldName + " is required.");
  }
  var date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw dragonBoatRequestError_("INVALID_REQUEST", "A valid " + fieldName + " is required.");
  }
  return value;
}

function requireLocalTime_(value, fieldName) {
  value = typeof value === "string" ? value.trim() : "";
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw dragonBoatRequestError_("INVALID_REQUEST", "A valid " + fieldName + " is required.");
  }
  return value;
}

function requireTimeZone_(value) {
  value = typeof value === "string" ? value.trim() : "";
  if (!value || value.length > 100) {
    throw dragonBoatRequestError_("INVALID_REQUEST", "A valid timezone is required.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
  } catch (error) {
    throw dragonBoatRequestError_("INVALID_REQUEST", "A valid timezone is required.");
  }
  return value;
}

function addCalendarDays_(dateValue, days) {
  var parts = dateValue.split("-").map(Number);
  var date = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + days));
  return [
    String(date.getUTCFullYear()).padStart(4, "0"),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

function zonedDateTimeParts_(instant, timeZone) {
  var parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(new Date(instant));
  var result = {};
  parts.forEach(function (part) {
    if (part.type !== "literal") result[part.type] = part.value;
  });
  if (result.hour === "24") result.hour = "00";
  return result;
}

function localDateTimeToIso_(dateValue, timeValue, timeZone) {
  requireIsoDate_(dateValue, "date");
  requireLocalTime_(timeValue, "time");
  requireTimeZone_(timeZone);
  var dateParts = dateValue.split("-").map(Number);
  var timeParts = timeValue.split(":").map(Number);
  var desiredUtc = Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2], timeParts[0], timeParts[1]);
  var candidate = desiredUtc;

  for (var pass = 0; pass < 3; pass += 1) {
    var shown = zonedDateTimeParts_(candidate, timeZone);
    var shownUtc = Date.UTC(
      Number(shown.year), Number(shown.month) - 1, Number(shown.day),
      Number(shown.hour), Number(shown.minute)
    );
    candidate += desiredUtc - shownUtc;
  }

  function matches(instant) {
    var shown = zonedDateTimeParts_(instant, timeZone);
    return shown.year === String(dateParts[0]).padStart(4, "0") &&
      shown.month === String(dateParts[1]).padStart(2, "0") &&
      shown.day === String(dateParts[2]).padStart(2, "0") &&
      shown.hour === String(timeParts[0]).padStart(2, "0") &&
      shown.minute === String(timeParts[1]).padStart(2, "0");
  }

  if (!matches(candidate)) {
    throw dragonBoatRequestError_("INVALID_LOCAL_TIME", "The local date and time does not exist in this timezone.");
  }
  for (var offset = -180; offset <= 180; offset += 15) {
    var alternate = candidate + offset * 60000;
    if (offset !== 0 && matches(alternate)) {
      throw dragonBoatRequestError_("AMBIGUOUS_LOCAL_TIME", "The local date and time is ambiguous in this timezone.");
    }
  }
  return new Date(candidate).toISOString();
}

function seasonEndsAt_(endDate, timeZone) {
  return localDateTimeToIso_(addCalendarDays_(endDate, 1), "00:00", timeZone);
}
