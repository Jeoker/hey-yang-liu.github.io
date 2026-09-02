function requireRequestString_(request, fieldName, minLength, maxLength) {
  var value = typeof request[fieldName] === "string" ? request[fieldName].trim() : "";
  if (value.length < minLength || value.length > maxLength) {
    throw dragonBoatRequestError_(
      "INVALID_REQUEST",
      "A valid " + fieldName + " is required."
    );
  }
  return value;
}

function getScriptProperties_() {
  return PropertiesService.getScriptProperties();
}

function getRequiredScriptProperty_(key) {
  var value = getScriptProperties_().getProperty(key);
  if (!value) {
    throw dragonBoatRequestError_(
      "CONFIGURATION_REQUIRED",
      "The training service management store is not configured."
    );
  }
  return value;
}

function hmacDigest_(value, secret) {
  var bytes = Utilities.computeHmacSha256Signature(
    value,
    secret,
    Utilities.Charset.UTF_8
  );
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/g, "");
}

function credentialDigest_(salt, coachCode) {
  var secret = getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET);
  return hmacDigest_(salt + "\n" + coachCode, secret);
}

function sessionTokenDigest_(token) {
  var secret = getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.SESSION_SECRET);
  return hmacDigest_("token\n" + token, secret);
}

function createSessionToken_(session) {
  var payload = JSON.stringify({
    sid: session.session_id,
    cid: session.coach_id,
    cv: Number(session.credential_version),
    iat: session.issued_at,
    exp: session.expires_at
  });
  var payloadSegment = Utilities
    .base64EncodeWebSafe(payload, Utilities.Charset.UTF_8)
    .replace(/=+$/g, "");
  var secret = getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.SESSION_SECRET);
  var signature = hmacDigest_(payloadSegment, secret);
  return payloadSegment + "." + signature;
}

function decodeAndVerifySessionToken_(token) {
  if (typeof token !== "string" || token.length < 32 || token.length > 2048) {
    throw dragonBoatRequestError_("SESSION_INVALID", "The Coach session is invalid.");
  }

  var parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw dragonBoatRequestError_("SESSION_INVALID", "The Coach session is invalid.");
  }

  var secret = getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.SESSION_SECRET);
  var expectedSignature = hmacDigest_(parts[0], secret);
  if (!constantTimeEqual_(expectedSignature, parts[1])) {
    throw dragonBoatRequestError_("SESSION_INVALID", "The Coach session is invalid.");
  }

  var payload;
  try {
    var bytes = Utilities.base64DecodeWebSafe(parts[0]);
    payload = JSON.parse(Utilities.newBlob(bytes).getDataAsString("UTF-8"));
  } catch (error) {
    throw dragonBoatRequestError_("SESSION_INVALID", "The Coach session is invalid.");
  }

  if (
    !payload ||
    typeof payload.sid !== "string" ||
    typeof payload.cid !== "string" ||
    !Number.isFinite(Number(payload.cv)) ||
    typeof payload.iat !== "string" ||
    typeof payload.exp !== "string"
  ) {
    throw dragonBoatRequestError_("SESSION_INVALID", "The Coach session is invalid.");
  }

  return payload;
}

function constantTimeEqual_(left, right) {
  if (typeof left !== "string" || typeof right !== "string") {
    return false;
  }
  var mismatch = left.length ^ right.length;
  var length = Math.max(left.length, right.length);
  for (var index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index % left.length) || 0) ^
      (right.charCodeAt(index % right.length) || 0);
  }
  return mismatch === 0;
}

function getSessionTtlSeconds_() {
  var raw = getScriptProperties_().getProperty(
    DRAGON_BOAT_PROPERTY_KEYS_.SESSION_TTL_SECONDS
  );
  var seconds = raw ? Number(raw) : DRAGON_BOAT_SESSION_TTL_DEFAULT_SECONDS_;
  if (
    !Number.isFinite(seconds) ||
    seconds < DRAGON_BOAT_SESSION_TTL_MIN_SECONDS_ ||
    seconds > DRAGON_BOAT_SESSION_TTL_MAX_SECONDS_
  ) {
    throw dragonBoatRequestError_(
      "CONFIGURATION_ERROR",
      "The Coach session duration is invalid."
    );
  }
  return Math.floor(seconds);
}

function withDragonBoatScriptLock_(callback) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(DRAGON_BOAT_SCRIPT_LOCK_TIMEOUT_MS_);
  } catch (error) {
    throw dragonBoatRequestError_(
      "SERVICE_BUSY",
      "The training service is busy. Please retry the same request.",
      true
    );
  }

  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function enforceCoachLoginRateLimit_(coachCode) {
  var cache = CacheService.getScriptCache();
  var minuteBucket = Math.floor(Date.now() / 60000);
  var globalKey = "coach_login_global_" + minuteBucket;
  var codeKey = "coach_login_code_" + hmacDigest_(
    coachCode,
    getRequiredScriptProperty_(DRAGON_BOAT_PROPERTY_KEYS_.CODE_SECRET)
  );
  var globalCount = Number(cache.get(globalKey) || 0);
  var codeCount = Number(cache.get(codeKey) || 0);

  if (globalCount >= 30 || codeCount >= 5) {
    throw dragonBoatRequestError_(
      "LOGIN_RATE_LIMITED",
      "Too many Coach Code attempts. Please wait before trying again.",
      true
    );
  }

  cache.put(globalKey, String(globalCount + 1), 70);
  cache.put(codeKey, String(codeCount + 1), 600);
}
