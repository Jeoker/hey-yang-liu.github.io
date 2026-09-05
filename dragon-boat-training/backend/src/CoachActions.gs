function coachLogin_(request) {
  var coachCode = requireRequestString_(request, "coach_code", 6, 128);

  return withDragonBoatScriptLock_(function () {
    var coach = findCoachByCode_(coachCode);
    if (!coach) {
      enforceCoachLoginRateLimit_(coachCode);
      throw dragonBoatRequestError_(
        "COACH_CODE_INVALID",
        "The Coach Code is not valid."
      );
    }

    var issuedAt = new Date();
    var expiresAt = new Date(issuedAt.getTime() + getSessionTtlSeconds_() * 1000);
    var plannedResult = {
      session_id: "session_" + createDragonBoatRequestId_(),
      coach_id: String(coach.coach_id),
      display_name: String(coach.display_name),
      credential_version: Number(coach.credential_version),
      issued_at: issuedAt.toISOString(),
      expires_at: expiresAt.toISOString()
    };
    var payloadDigest = digestRequestPayload_({
      coach_code_digest: credentialDigest_(String(coach.code_salt), coachCode)
    });
    var existing = findMatchingSystemRequest_(
      String(coach.coach_id),
      "coachLogin",
      request.request_id,
      payloadDigest
    );
    var transaction;
    if (existing) {
      transaction = { record: existing, replayed: true };
    } else {
      enforceCoachLoginRateLimit_(coachCode);
      transaction = beginSystemRequest_(
        String(coach.coach_id),
        "coachLogin",
        request.request_id,
        payloadDigest,
        plannedResult
      );
    }
    var persistedResult = readSystemRequestResult_(transaction.record);
    var session = ensureCoachSessionForLogin_(persistedResult);

    ensureSystemAuditEvent_(
      transaction.record,
      "COACH_LOGIN",
      "SUCCEEDED",
      { session_id: session.session_id, expires_at: session.expires_at }
    );
    completeSystemRequest_(transaction.record);

    return {
      session_token: createSessionToken_(session),
      session: {
        coach_id: String(persistedResult.coach_id),
        display_name: String(persistedResult.display_name),
        issued_at: String(persistedResult.issued_at),
        expires_at: String(persistedResult.expires_at)
      }
    };
  });
}

function ensureCoachSessionForLogin_(plannedResult) {
  var existing = findSessionById_(plannedResult.session_id);
  if (existing) {
    if (
      String(existing.coach_id) !== String(plannedResult.coach_id) ||
      Number(existing.credential_version) !== Number(plannedResult.credential_version)
    ) {
      throw dragonBoatRequestError_(
        "RECOVERY_REQUIRED",
        "The previous Coach session could not be recovered.",
        true
      );
    }
    return existing;
  }

  var unsignedSession = {
    session_id: String(plannedResult.session_id),
    coach_id: String(plannedResult.coach_id),
    credential_version: Number(plannedResult.credential_version),
    issued_at: String(plannedResult.issued_at),
    expires_at: String(plannedResult.expires_at)
  };
  var token = createSessionToken_(unsignedSession);
  return appendSheetRecord_("CoachSessions", {
    session_id: unsignedSession.session_id,
    token_digest: sessionTokenDigest_(token),
    coach_id: unsignedSession.coach_id,
    credential_version: unsignedSession.credential_version,
    issued_at: unsignedSession.issued_at,
    expires_at: unsignedSession.expires_at,
    revoked_at: ""
  });
}

function coachBootstrap_(request) {
  var sessionToken = requireRequestString_(request, "session_token", 32, 2048);
  var authenticated = validateCoachSession_(sessionToken);
  var seasons = getSheetRecords_("Seasons").map(seasonManagementProjection_).sort(function (left, right) {
    return right.start_date.localeCompare(left.start_date);
  });
  return {
    coach: {
      coach_id: String(authenticated.coach.coach_id),
      display_name: String(authenticated.coach.display_name)
    },
    session: {
      expires_at: String(authenticated.session.expires_at)
    },
    panels: [
      { id: "training", label: "训练与排座", available: true },
      { id: "members", label: "队员", available: true },
      { id: "season", label: "赛季与表单", available: true },
      { id: "audit", label: "操作记录", available: true }
    ],
    p0_connectivity_write_available: true,
    default_season_id: getDefaultSeasonId_(),
    settings_version: defaultSeasonSetting_().settings_version,
    seasons: seasons
  };
}

function coachConnectivityWrite_(request) {
  var sessionToken = requireRequestString_(request, "session_token", 32, 2048);

  return withDragonBoatScriptLock_(function () {
    var authenticated = validateCoachSession_(sessionToken);
    var actorId = String(authenticated.coach.coach_id);
    var payloadDigest = digestRequestPayload_({ purpose: "p0_connectivity" });
    var plannedResult = {
      write_id: "write_" + buildSystemRequestKey_(
        actorId,
        "coachConnectivityWrite",
        request.request_id
      ).slice(4, 36),
      status: "recorded"
    };
    var transaction = beginSystemRequest_(
      actorId,
      "coachConnectivityWrite",
      request.request_id,
      payloadDigest,
      plannedResult
    );
    var persistedResult = readSystemRequestResult_(transaction.record);

    ensureSystemAuditEvent_(
      transaction.record,
      "COACH_CONNECTIVITY_WRITE",
      "SUCCEEDED",
      {
        write_id: persistedResult.write_id,
        service_version: DRAGON_BOAT_SERVICE_VERSION_
      }
    );
    completeSystemRequest_(transaction.record);
    return persistedResult;
  });
}

function coachLogout_(request) {
  var sessionToken = requireRequestString_(request, "session_token", 32, 2048);

  return withDragonBoatScriptLock_(function () {
    var authenticated = validateCoachSession_(sessionToken, {
      allowRevoked: true,
      skipCredentialStatus: true
    });
    var actorId = String(authenticated.session.coach_id);
    var payloadDigest = digestRequestPayload_({ session_id: authenticated.session.session_id });
    var plannedResult = {
      session_id: String(authenticated.session.session_id),
      revoked: true
    };
    var transaction = beginSystemRequest_(
      actorId,
      "coachLogout",
      request.request_id,
      payloadDigest,
      plannedResult
    );
    var persistedResult = readSystemRequestResult_(transaction.record);

    if (!authenticated.session.revoked_at) {
      authenticated.session.revoked_at = new Date().toISOString();
      updateSheetRecord_("CoachSessions", authenticated.session);
    }
    ensureSystemAuditEvent_(
      transaction.record,
      "COACH_LOGOUT",
      "SUCCEEDED",
      { session_id: persistedResult.session_id }
    );
    completeSystemRequest_(transaction.record);
    return persistedResult;
  });
}

function validateCoachSession_(sessionToken, options) {
  options = options || {};
  var payload = decodeAndVerifySessionToken_(sessionToken);
  var session = findSessionById_(payload.sid);
  if (
    !session ||
    String(session.coach_id) !== String(payload.cid) ||
    Number(session.credential_version) !== Number(payload.cv) ||
    !constantTimeEqual_(String(session.token_digest), sessionTokenDigest_(sessionToken))
  ) {
    throw dragonBoatRequestError_("SESSION_INVALID", "The Coach session is invalid.");
  }

  var expiresAt = Date.parse(String(session.expires_at));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw dragonBoatRequestError_("SESSION_EXPIRED", "The Coach session has expired.");
  }
  if (session.revoked_at && !options.allowRevoked) {
    throw dragonBoatRequestError_("SESSION_REVOKED", "The Coach session has ended.");
  }

  var coach = findCoachById_(session.coach_id);
  if (!coach) {
    throw dragonBoatRequestError_("SESSION_INVALID", "The Coach session is invalid.");
  }
  if (
    !options.skipCredentialStatus &&
    (!isTrue_(coach.active) ||
      Number(coach.credential_version) !== Number(session.credential_version))
  ) {
    throw dragonBoatRequestError_(
      "SESSION_REVOKED",
      "The Coach credential is no longer active."
    );
  }

  return { payload: payload, session: session, coach: coach };
}
