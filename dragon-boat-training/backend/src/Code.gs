function doGet(event) {
  return handleDragonBoatRequest_("GET", event || {});
}

function doPost(event) {
  return handleDragonBoatRequest_("POST", event || {});
}

function handleDragonBoatRequest_(method, event) {
  var requestId = createDragonBoatRequestId_();

  try {
    var request = parseDragonBoatRequest_(method, event);
    requestId = request.request_id;

    if (method === "GET" && ["health", "bootstrap", "members", "practice"].indexOf(request.action) < 0) {
      throw dragonBoatRequestError_(
        "METHOD_NOT_ALLOWED",
        "This action must be sent as a POST request."
      );
    }

    switch (request.action) {
      case "health":
        return dragonBoatSuccess_(dragonBoatHealth_(), requestId);
      case "bootstrap":
        return dragonBoatSuccess_(withDragonBoatScriptLock_(function () { return publicBootstrap_(request); }), requestId);
      case "members":
        return dragonBoatSuccess_(publicMembers_(request), requestId);
      case "practice":
        return dragonBoatSuccess_(publicPractice_(request), requestId);
      case "signup":
      case "signupByCoach":
      case "updateSignup":
      case "updateSignupByCoach":
      case "cancelSignup":
      case "cancelSignupByCoach":
        return dragonBoatSuccess_(mutateSignup_(request), requestId);
      case "listSeasonMembers":
        return dragonBoatSuccess_(listSeasonMembers_(request), requestId);
      case "getMemberWorkspace":
        return dragonBoatSuccess_(getMemberWorkspace_(request), requestId);
      case "getSeatingWorkspace":
        return dragonBoatSuccess_(getSeatingWorkspace_(request), requestId);
      case "saveSeatPlanDraft":
        return dragonBoatSuccess_(saveSeatPlanDraft_(request), requestId);
      case "publishSeatPlan":
        return dragonBoatSuccess_(publishSeatPlan_(request), requestId);
      case "updateMember":
      case "restoreMemberName":
      case "setMemberStatus":
        return dragonBoatSuccess_(mutateMember_(request), requestId);
      case "coachLogin":
        return dragonBoatSuccess_(coachLogin_(request), requestId);
      case "coachLogout":
        return dragonBoatSuccess_(coachLogout_(request), requestId);
      case "coachBootstrap":
        return dragonBoatSuccess_(coachBootstrap_(request), requestId);
      case "coachConnectivityWrite":
        return dragonBoatSuccess_(coachConnectivityWrite_(request), requestId);
      case "getSeasonManagement":
        return dragonBoatSuccess_(withDragonBoatScriptLock_(function () { return getSeasonManagement_(request); }), requestId);
      case "createSeason":
        return dragonBoatSuccess_(createSeason_(request), requestId);
      case "validateSeasonBinding":
        return dragonBoatSuccess_(validateSeasonBindingAction_(request), requestId);
      case "initializeSeason":
        return dragonBoatSuccess_(initializeSeason_(request), requestId);
      case "retrySeasonSync":
        return dragonBoatSuccess_(retrySeasonSync_(request), requestId);
      case "updateScheduleTemplates":
        return dragonBoatSuccess_(updateScheduleTemplates_(request), requestId);
      case "updateTrainingWeek":
        return dragonBoatSuccess_(updateTrainingWeek_(request), requestId);
      case "confirmTrainingWeek":
        return dragonBoatSuccess_(confirmTrainingWeek_(request), requestId);
      case "publishTrainingWeek":
        return dragonBoatSuccess_(publishTrainingWeek_(request), requestId);
      case "createPractice":
        return dragonBoatSuccess_(createPractice_(request), requestId);
      case "publishAdditionalPractice":
        return dragonBoatSuccess_(publishAdditionalPractice_(request), requestId);
      default:
        throw dragonBoatRequestError_(
          "UNSUPPORTED_ACTION",
          "The requested action is not available."
        );
    }
  } catch (error) {
    if (error && error.isDragonBoatRequestError) {
      return dragonBoatError_(
        error.code,
        error.message,
        error.retryable === true,
        requestId
      );
    }

    return dragonBoatError_(
      "INTERNAL_ERROR",
      "The service could not complete the request.",
      true,
      requestId
    );
  }
}

function dragonBoatHealth_() {
  return {
    service: DRAGON_BOAT_SERVICE_NAME_,
    service_version: DRAGON_BOAT_SERVICE_VERSION_,
    status: "available"
  };
}

function parseDragonBoatRequest_(method, event) {
  var input;

  if (method === "GET") {
    input = event.parameter || {};
  } else {
    var body = event.postData && event.postData.contents;
    if (!body) {
      throw dragonBoatRequestError_("INVALID_REQUEST", "A JSON request body is required.");
    }

    try {
      input = JSON.parse(body);
    } catch (error) {
      throw dragonBoatRequestError_("INVALID_JSON", "The request body is not valid JSON.");
    }
  }

  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw dragonBoatRequestError_("INVALID_REQUEST", "The request must be a JSON object.");
  }

  var action = typeof input.action === "string" ? input.action.trim() : "";
  if (!action && method === "GET") {
    action = "health";
  }
  if (!action) {
    throw dragonBoatRequestError_("INVALID_REQUEST", "An action is required.");
  }

  var requestId = typeof input.request_id === "string" ? input.request_id.trim() : "";
  if (!requestId) {
    requestId = createDragonBoatRequestId_();
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(requestId)) {
    throw dragonBoatRequestError_("INVALID_REQUEST_ID", "The request identifier is invalid.");
  }

  var request = {};
  Object.keys(input).forEach(function (key) {
    request[key] = input[key];
  });
  request.action = action;
  request.request_id = requestId;
  return request;
}

function dragonBoatSuccess_(data, requestId) {
  return dragonBoatJson_({
    ok: true,
    data: data,
    meta: dragonBoatMeta_(requestId)
  });
}

function dragonBoatRequestError_(code, message, retryable) {
  var error = new Error(message);
  error.code = code;
  error.retryable = retryable === true;
  error.isDragonBoatRequestError = true;
  return error;
}

function dragonBoatError_(code, message, retryable, requestId) {
  return dragonBoatJson_({
    ok: false,
    error: {
      code: code,
      message: message,
      retryable: retryable
    },
    meta: dragonBoatMeta_(requestId)
  });
}

function dragonBoatMeta_(requestId) {
  return {
    contract_version: DRAGON_BOAT_CONTRACT_VERSION_,
    server_time: new Date().toISOString(),
    request_id: requestId
  };
}

function createDragonBoatRequestId_() {
  return Utilities.getUuid().replace(/-/g, "_");
}

function dragonBoatJson_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
