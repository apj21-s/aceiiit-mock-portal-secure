(function () {
  window.AceIIIT = window.AceIIIT || {};

  var LOCAL_DB_KEY = "ugee.portal.db.v1";
  var SESSION_KEY = "ugee.portal.session.v1";

  var state = {
    db: {
      settings: {
        brandName: "AceIIIT",
        seriesName: "UGEE 2026",
      },
      tests: [],
      questions: [],
      questionCache: {},
      attempts: [],
      adminSnapshot: null,
      reminders: [],
      appConfig: {
        ugeeExamDate: null,
        featuredTestId: "",
        noticeTitle: "",
        noticeBody: "",
      },
      bookmarks: {},
      studyMaterials: { folders: [], files: [] },
    },
    // Auth is an httpOnly cookie set by the server; the browser only caches the user profile.
    session: {
      user: null,
    },
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function createId(prefix) {
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
  }

  function loadJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null") || fallback;
    } catch (_err) {
      return fallback;
    }
  }

  function saveJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function loadState() {
    state.db = Object.assign(state.db, loadJson(LOCAL_DB_KEY, {}));
    state.db.settings = Object.assign(
      {
        brandName: "AceIIIT",
        seriesName: "UGEE 2026",
      },
      state.db.settings || {}
    );
    state.db.questionCache = state.db.questionCache || {};
    state.db.reminders = Array.isArray(state.db.reminders) ? state.db.reminders : [];
    state.db.appConfig = Object.assign({ ugeeExamDate: null, featuredTestId: "", noticeTitle: "", noticeBody: "" }, state.db.appConfig || {});
    state.db.bookmarks = state.db.bookmarks || {};
    state.db.studyMaterials = state.db.studyMaterials || { folders: [], files: [] };
    // Drop client-only practice papers and attempts from older builds (practice is server-built now).
    state.db.tests = (state.db.tests || []).filter(function (t) { return !(t && String(t.id || "").indexOf("practice_") === 0); });
    state.db.attempts = (state.db.attempts || []).filter(function (a) {
      if (!a) return false;
      if (String(a.testId || "").indexOf("practice_") === 0) return false;
      // In-progress attempts must mirror a server session.
      return a.status !== "in_progress" || !!a.sessionId;
    });
    var storedSession = loadJson(SESSION_KEY, {}) || {};
    // Drop any bearer token persisted by older builds; sessions are cookie-only now.
    state.session = { user: storedSession.user || null };
  }

  function saveState() {
    saveJson(LOCAL_DB_KEY, state.db);
    saveJson(SESSION_KEY, state.session);
  }

  function clearSession() {
    state.session = { user: null };
    saveState();
  }

  function isAdmin(user) {
    return !!user && user.role === "admin";
  }

  function toNumber(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function toBoolean(value, fallback) {
    if (value === true || value === false) return value;
    var normalized = String(value || "").trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "on" || normalized === "yes") return true;
    if (normalized === "false" || normalized === "0" || normalized === "off" || normalized === "no") return false;
    return fallback;
  }

  function normalizeNegativeMarks(value, fallback) {
    var parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    if (parsed === 0) return 0;
    return -Math.abs(parsed);
  }

  function getSectionDefaultMarking(section) {
    var normalized = String(section || "SUPR").toUpperCase() === "REAP" ? "REAP" : "SUPR";
    return normalized === "REAP"
      ? { marks: 2, negativeMarks: -0.5 }
      : { marks: 1, negativeMarks: -0.25 };
  }

  function mapAdminTestPayload(input, existing) {
    var source = input || {};
    var supr = source.sectionDurations && source.sectionDurations.SUPR !== undefined
      ? toNumber(source.sectionDurations.SUPR, existing && existing.sectionDurations ? existing.sectionDurations.SUPR : 60)
      : toNumber(source.suprDurationMinutes, existing && existing.sectionDurations ? existing.sectionDurations.SUPR : 60);
    var reap = source.sectionDurations && source.sectionDurations.REAP !== undefined
      ? toNumber(source.sectionDurations.REAP, existing && existing.sectionDurations ? existing.sectionDurations.REAP : 120)
      : toNumber(source.reapDurationMinutes, existing && existing.sectionDurations ? existing.sectionDurations.REAP : 120);

    var mapped = {};
    if (source.title !== undefined) mapped.title = String(source.title || "").trim();
    if (source.subtitle !== undefined) mapped.subtitle = String(source.subtitle || "").trim();
    if (source.series !== undefined) mapped.series = String(source.series || "UGEE 2026").trim();
    if (source.type !== undefined) mapped.type = source.type;
    if (source.status !== undefined) mapped.status = source.status;
    if (source.isFree !== undefined) mapped.isFree = toBoolean(source.isFree, false);
    if (source.displayOrder !== undefined) mapped.displayOrder = toNumber(source.displayOrder, existing && existing.displayOrder !== undefined ? existing.displayOrder : 100);

    if (source.suprDurationMinutes !== undefined || source.reapDurationMinutes !== undefined || source.sectionDurations) {
      mapped.sectionDurations = { SUPR: supr, REAP: reap };
    }
    if (Array.isArray(source.instructions)) mapped.instructions = source.instructions.slice();
    if (Array.isArray(source.benchmarkScores)) mapped.benchmarkScores = source.benchmarkScores.slice();
    if (source.shuffleQuestions !== undefined) mapped.shuffleQuestions = !!source.shuffleQuestions;
    if (source.shuffleOptions !== undefined) mapped.shuffleOptions = !!source.shuffleOptions;
    if (source.integrity && ["record", "warn", "strict"].indexOf(source.integrity.mode) !== -1) {
      mapped.integrity = {
        mode: source.integrity.mode,
        warnThreshold: Math.max(1, toNumber(source.integrity.warnThreshold, 1)),
        autoSubmitThreshold: Math.max(1, toNumber(source.integrity.autoSubmitThreshold, 5)),
      };
    }
    return mapped;
  }

  function mapAdminQuestionPayload(input) {
    var source = input || {};
    var section = String(source.section || "SUPR").toUpperCase() === "REAP" ? "REAP" : "SUPR";
    var defaults = getSectionDefaultMarking(section);
    return {
      section: section,
      topic: String(source.topic || "").trim(),
      difficulty: String(source.difficulty || "medium"),
      prompt: String(source.prompt || "").trim(),
      passage: String(source.passage || ""),
      imageUrls: Array.isArray(source.imageUrls) ? source.imageUrls.slice() : [],
      options: Array.isArray(source.options) ? source.options.map(function (o) { return String(o || ""); }) : [],
      correctOption: toNumber(source.correctOption, 0),
      explanation: String(source.explanation || ""),
      marks: toNumber(source.marks, defaults.marks),
      negativeMarks: normalizeNegativeMarks(source.negativeMarks, defaults.negativeMarks),
    };
  }

  var CSRF_COOKIE = "aceiiit_csrf";

  function readCookie(name) {
    var parts = String(document.cookie || "").split(";");
    for (var i = 0; i < parts.length; i += 1) {
      var pair = parts[i].trim();
      if (pair.indexOf(name + "=") === 0) {
        return decodeURIComponent(pair.slice(name.length + 1));
      }
    }
    return "";
  }

  async function ensureCsrfToken(forceRefresh) {
    var token = readCookie(CSRF_COOKIE);
    if (token && !forceRefresh) return token;
    var response = await fetch("/api/auth/csrf", { method: "GET", credentials: "same-origin", cache: "no-store" });
    var data = null;
    try {
      data = await response.json();
    } catch (_err) {
      data = null;
    }
    return readCookie(CSRF_COOKIE) || (data && data.csrfToken) || "";
  }

  function isMutating(method) {
    var normalized = String(method || "GET").toUpperCase();
    return normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS";
  }

  async function parseResponse(response) {
    var text = await response.text();
    try {
      return text ? JSON.parse(text) : null;
    } catch (_err) {
      return null;
    }
  }

  // Single request path for the whole app: cookie session + CSRF header on mutations.
  // A stale CSRF token is refreshed and the request retried once.
  async function request(path, init, retried) {
    var options = Object.assign({}, init || {});
    var headers = Object.assign({}, options.headers || {});
    if (isMutating(options.method)) {
      headers["X-CSRF-Token"] = await ensureCsrfToken(false);
    }
    options.headers = headers;
    options.credentials = "same-origin";
    var response = await fetch(path, options);
    var data = await parseResponse(response);
    if (!response.ok) {
      if (response.status === 403 && data && data.code === "CSRF_FAILED" && !retried) {
        await ensureCsrfToken(true);
        return request(path, init, true);
      }
      if (response.status === 401) {
        // Session expired or was revoked; force re-login.
        clearSession();
      }
      var message = (data && data.error) || ("Request failed (" + response.status + ")");
      var error = new Error(message);
      error.status = response.status;
      error.code = data && data.code;
      error.data = data || null;
      throw error;
    }
    return data;
  }

  async function api(path, options) {
    var init = Object.assign({}, options || {});
    init.headers = Object.assign({ "Content-Type": "application/json" }, init.headers || {});
    return request(path, init, false);
  }

  async function apiForm(path, method, formData) {
    return request(path, { method: method, body: formData }, false);
  }

  function mapRemoteAttempt(remote, userId) {
    var result = {
      score: remote.score,
      accuracy: remote.accuracy,
      rank: remote.rank,
      percentile: remote.percentile,
      rankTotal: remote.rankTotal || 0,
      maxScore: remote.maxScore !== undefined ? remote.maxScore : null,
      correctCount: remote.correctCount,
      wrongCount: remote.wrongCount,
      skippedCount: remote.skippedCount,
      unattemptedCount: remote.unattemptedCount !== undefined ? remote.unattemptedCount : remote.skippedCount,
      timeTakenSeconds: remote.timeTakenSeconds,
      totalTime: remote.totalTime !== undefined ? remote.totalTime : remote.timeTakenSeconds,
      sectionScores: remote.sectionScores || null,
      analysis: remote.analysis || null,
    };
    return {
      id: remote.id,
      userId: userId,
      testId: remote.testId,
      status: "submitted",
      startedAt: remote.submittedAt || nowIso(),
      updatedAt: remote.submittedAt || nowIso(),
      submittedAt: remote.submittedAt || nowIso(),
      activeSection: "REAP",
      currentSection: "REAP",
      currentQuestionId: "",
      answers: {},
      visited: {},
      marked: {},
      timeSpent: {},
      lastActiveAt: remote.submittedAt || nowIso(),
      sectionTimers: null,
      result: result,
      resultSnapshot: {
        savedAt: nowIso(),
        testTitle: "",
        testSubtitle: "",
        startedAt: remote.submittedAt || nowIso(),
        submittedAt: remote.submittedAt || nowIso(),
        result: result,
      },
      attemptNumber: remote.attemptNumber || 1,
      sessionId: remote.sessionId || null,
      isPractice: !!remote.isPractice,
      submittedReason: remote.submittedReason || "submitted",
    };
  }

  function getQuestionCacheEntry(testId) {
    var raw = state.db.questionCache && state.db.questionCache[String(testId)];
    if (!raw) return null;
    if (Array.isArray(raw)) {
      return {
        questions: raw.slice(),
        updatedAt: null,
      };
    }
    return {
      questions: Array.isArray(raw.questions) ? raw.questions.slice() : [],
      updatedAt: raw.updatedAt || null,
    };
  }

  function setQuestionCacheEntry(testId, questions, updatedAt) {
    state.db.questionCache = state.db.questionCache || {};
    state.db.questionCache[String(testId)] = {
      questions: clone(questions || []),
      updatedAt: updatedAt || null,
    };
  }

  function mergeTestData(existing, incoming) {
    if (!existing) return incoming;

    var merged = Object.assign({}, existing, incoming);
    var incomingQuestionIds = Array.isArray(incoming.questionIds) ? incoming.questionIds.slice() : [];
    var existingQuestionIds = Array.isArray(existing.questionIds) ? existing.questionIds.slice() : [];

    if (!incomingQuestionIds.length && existingQuestionIds.length) {
      merged.questionIds = existingQuestionIds;
    } else {
      merged.questionIds = incomingQuestionIds;
    }

    if ((!incoming.questionCount || incoming.questionCount < merged.questionIds.length) && merged.questionIds.length) {
      merged.questionCount = merged.questionIds.length;
    }

    return merged;
  }

  function mergeAttemptData(existing, incoming) {
    if (!existing) return incoming;
    var merged = Object.assign({}, incoming);
    var existingResult = existing.result || null;
    var incomingResult = incoming.result || null;

    if (existing.status === "in_progress" && incoming.status !== "submitted") {
      return Object.assign({}, existing, incoming);
    }

    merged.startedAt = existing.startedAt || incoming.startedAt;
    merged.answers = existing.answers || incoming.answers || {};
    merged.visited = existing.visited || incoming.visited || {};
    merged.marked = existing.marked || incoming.marked || {};
    merged.timeSpent = existing.timeSpent || incoming.timeSpent || {};
    merged.sectionTimers = existing.sectionTimers || incoming.sectionTimers || null;

    if (existingResult || incomingResult) {
      merged.result = Object.assign({}, existingResult || {}, incomingResult || {});
      if (existingResult && existingResult.analysis && (!incomingResult || !incomingResult.analysis)) {
        merged.result.analysis = existingResult.analysis;
      }
      if (existingResult && existingResult.sectionScores && (!incomingResult || !incomingResult.sectionScores)) {
        merged.result.sectionScores = existingResult.sectionScores;
      }
      if (existingResult && existingResult.totalTime !== undefined && (!incomingResult || incomingResult.totalTime === undefined)) {
        merged.result.totalTime = existingResult.totalTime;
      }
      if (existingResult && existingResult.unattemptedCount !== undefined && (!incomingResult || incomingResult.unattemptedCount === undefined)) {
        merged.result.unattemptedCount = existingResult.unattemptedCount;
      }
    }

    if (existing.resultSnapshot || incoming.resultSnapshot) {
      merged.resultSnapshot = Object.assign({}, existing.resultSnapshot || {}, incoming.resultSnapshot || {});
      if (merged.result) {
        merged.resultSnapshot.result = merged.result;
      }
    }

    return merged;
  }

  function getCurrentUser() {
    return state.session.user ? clone(state.session.user) : null;
  }

  function mapReminderData(reminder) {
    return {
      id: String(reminder && reminder.id || ""),
      title: String(reminder && reminder.title || ""),
      testId: String(reminder && reminder.testId || ""),
      plannedAt: reminder && reminder.plannedAt ? reminder.plannedAt : null,
      remindAt: reminder && reminder.remindAt ? reminder.remindAt : null,
      reminderMinutes: Number(reminder && reminder.reminderMinutes || 300),
      subjectFocus: Array.isArray(reminder && reminder.subjectFocus) ? reminder.subjectFocus.slice(0, 3) : [],
      notes: String(reminder && reminder.notes || ""),
      sentAt: reminder && reminder.sentAt ? reminder.sentAt : null,
      failureReason: String(reminder && reminder.failureReason || ""),
    };
  }

  async function refreshStudentData() {
    var testsPayload = await api("/api/tests", { method: "GET" });
    var attemptsPayload = await api("/api/attempts", { method: "GET" });
    var remindersPayload = await api("/api/reminders", { method: "GET" });
    var activePayload = await api("/api/attempt/sessions/active", { method: "GET" }).catch(function () { return { sessions: [] }; });
    var userId = state.session.user && state.session.user.id;
    var activeSessions = (activePayload && activePayload.sessions) || [];
    var activeById = activeSessions.reduce(function (acc, session) {
      acc[session.id] = session;
      return acc;
    }, {});
    if (activeSessions[0] && activeSessions[0].serverNow) syncServerClock(activeSessions[0].serverNow);

    // In-progress attempts mirror server sessions: keep only those still active on the
    // server (others were finalized there), refresh their deadlines, and add sessions
    // started on another device so they can be resumed (via takeover).
    var inProgress = (state.db.attempts || []).filter(function (a) {
      return a && a.status === "in_progress" && a.userId === userId && a.sessionId && activeById[a.sessionId];
    }).map(function (a) {
      return applySessionToAttempt(activeById[a.sessionId], a);
    });
    activeSessions.forEach(function (session) {
      var known = inProgress.some(function (a) { return a.sessionId === session.id; });
      if (!known) inProgress.push(applySessionToAttempt(session, null));
    });
    var inProgressOrPractice = inProgress;

    var existingTestsById = (state.db.tests || []).reduce(function (acc, test) {
      if (test && test.id) {
        acc[test.id] = test;
      }
      return acc;
    }, {});

    var localPracticeTests = (state.db.tests || []).filter(function (t) { return t && t.isPractice; });

    state.db.tests = (testsPayload.tests || []).map(function (test) {
      return mergeTestData(existingTestsById[test.id], test);
    }).concat(localPracticeTests);
    state.db.questions = Array.isArray(testsPayload.questions) ? clone(testsPayload.questions) : [];
    state.db.qotd = testsPayload.qotd || null;
    state.db.questionCache = state.db.questionCache || {};
    var questionMap = (state.db.questions || []).reduce(function (acc, question) {
      if (question && question.id) {
        acc[question.id] = question;
      }
      return acc;
    }, {});

    (state.db.tests || []).forEach(function (test) {
      if (!test || !test.id) return;
      var questionIds = Array.isArray(test.questionIds) ? test.questionIds : [];
      if (!questionIds.length) return;
      var resolvedQuestions = questionIds.map(function (id) { return questionMap[id]; }).filter(Boolean);
      if (!resolvedQuestions.length) return;

      var existingCacheEntry = getQuestionCacheEntry(test.id);
      var shouldRefreshCache =
        !existingCacheEntry ||
        !Array.isArray(existingCacheEntry.questions) ||
        existingCacheEntry.questions.length !== resolvedQuestions.length ||
        String(existingCacheEntry.updatedAt || "") !== String(test.updatedAt || "");

      if (shouldRefreshCache) {
        setQuestionCacheEntry(test.id, resolvedQuestions, test.updatedAt || null);
      }
    });
    var nextTestsById = (state.db.tests || []).reduce(function (acc, test) {
      if (test && test.id) {
        acc[test.id] = test;
      }
      return acc;
    }, {});

    Object.keys(state.db.questionCache).forEach(function (testId) {
      var test = nextTestsById[testId];
      var cacheEntry = getQuestionCacheEntry(testId);
      if (!test || !cacheEntry) {
        delete state.db.questionCache[testId];
        return;
      }
      if (test.updatedAt && cacheEntry.updatedAt && String(test.updatedAt) !== String(cacheEntry.updatedAt)) {
        delete state.db.questionCache[testId];
        return;
      }
      if (Number(test.questionCount || 0) && cacheEntry.questions.length !== Number(test.questionCount || 0)) {
        delete state.db.questionCache[testId];
      }
    });
    var existingSubmittedById = (state.db.attempts || []).reduce(function (acc, attempt) {
      if (attempt && attempt.id) {
        acc[attempt.id] = attempt;
      }
      return acc;
    }, {});

    state.db.attempts = inProgressOrPractice.concat((attemptsPayload.attempts || []).map(function (remote) {
      var mapped = mapRemoteAttempt(remote, userId);
      return mergeAttemptData(existingSubmittedById[mapped.id], mapped);
    }));
    state.db.reminders = (remindersPayload.reminders || []).map(mapReminderData);
    state.db.appConfig = Object.assign({}, state.db.appConfig || {}, testsPayload.appConfig || {});

    saveState();
    return { changed: true };
  }

  // Bumped on every admin refresh (every mutation ends in one), so the UI can tell when a
  // cached question-bank page is stale.
  var adminSnapshotVersion = 0;

  async function refreshAdminData() {
    var snapshot = await api("/api/admin/snapshot", { method: "GET" });
    adminSnapshotVersion += 1;
    snapshot.__version = adminSnapshotVersion;
    var remindersPayload = await api("/api/reminders", { method: "GET" });
    var localPracticeTests = (state.db.tests || []).filter(function (t) { return t && t.isPractice; });
    state.db.adminSnapshot = snapshot;
    state.db.tests = (snapshot.tests || []).concat(localPracticeTests);
    state.db.questions = snapshot.questions || [];
    state.db.questionCache = {};
    state.db.appConfig = Object.assign({}, state.db.appConfig || {}, snapshot.appConfig || {});
    state.db.reminders = (remindersPayload.reminders || []).map(mapReminderData);

    // Keep local in-progress attempts for admin too (rare but ok).
    var userId = state.session.user && state.session.user.id;
    var inProgress = (state.db.attempts || []).filter(function (a) {
      return a && a.status === "in_progress" && a.userId === userId;
    });
    state.db.attempts = inProgress.concat((snapshot.attempts || []).map(function (remote) {
      return mapRemoteAttempt(remote, String(remote.userId || userId || ""));
    }));

    saveState();
    return { changed: true };
  }

  async function refreshFromRemote() {
    if (!state.session.user) {
      return { changed: false };
    }
    try {
      var me = await api("/api/auth/me", { method: "GET" });
      if (me && me.user) {
        state.session.user = me.user;
        saveState();
      }
    } catch (_err) {}
    if (!state.session.user) {
      return { changed: false };
    }
    return isAdmin(state.session.user) ? refreshAdminData() : refreshStudentData();
  }

  async function touchPresence() {
    if (!state.session.user) {
      return { ok: false };
    }
    var me = await api("/api/auth/me", { method: "GET" });
    if (me && me.user) {
      state.session.user = me.user;
      saveState();
    }
    return { ok: true, user: me && me.user ? me.user : null };
  }

  async function login(payload) {
    var data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: normalizeEmail(payload && payload.email),
        password: String(payload && payload.password || ""),
      }),
    });
    state.session.user = data.user || null;
    saveState();
    await refreshFromRemote();
    return { ok: true, user: clone(state.session.user) };
  }

  async function requestActivation(payload) {
    var data = await api("/api/auth/activate/request", {
      method: "POST",
      body: JSON.stringify({ email: normalizeEmail(payload && payload.email) }),
    });
    return data;
  }

  async function verifyActivationToken(token) {
    var data = await api("/api/auth/activate/verify?token=" + encodeURIComponent(String(token || "").trim()), {
      method: "GET",
    });
    return data;
  }

  async function completeActivation(payload) {
    var data = await api("/api/auth/activate/complete", {
      method: "POST",
      body: JSON.stringify({
        token: String(payload && payload.token || "").trim(),
        password: String(payload && payload.password || ""),
        name: payload && payload.name ? String(payload.name).trim() : undefined,
      }),
    });
    state.session.user = data.user || null;
    saveState();
    await refreshFromRemote();
    return { ok: true, user: clone(state.session.user) };
  }

  async function requestPasswordReset(payload) {
    var data = await api("/api/auth/forgot-password/request", {
      method: "POST",
      body: JSON.stringify({ email: normalizeEmail(payload && payload.email) }),
    });
    return data;
  }

  async function verifyResetToken(token) {
    var data = await api("/api/auth/forgot-password/verify?token=" + encodeURIComponent(String(token || "").trim()), {
      method: "GET",
    });
    return data;
  }

  async function completePasswordReset(payload) {
    var data = await api("/api/auth/forgot-password/complete", {
      method: "POST",
      body: JSON.stringify({
        token: String(payload && payload.token || ""),
        password: String(payload && payload.password || ""),
        name: String(payload && payload.name || "")
      })
    });
    return data;
  }

  async function updatePassword(payload) {
    var data = await api("/api/auth/password", {
      method: "PUT",
      body: JSON.stringify(payload)
    });
    return data;
  }

  async function googleAuth(payload) {
    var body = {};
    if (payload && payload.credential) body.credential = String(payload.credential);
    if (payload && payload.email) body.email = normalizeEmail(payload.email);
    if (payload && payload.name) body.name = String(payload.name).trim();

    var data = await api("/api/auth/google", {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.session.user = data.user || null;
    saveState();
    await refreshFromRemote();
    return { ok: true, user: clone(state.session.user) };
  }

  async function appleAuth(payload) {
    var body = {};
    if (payload && payload.identityToken) body.identityToken = String(payload.identityToken);
    if (payload && payload.email) body.email = normalizeEmail(payload.email);
    if (payload && payload.name) body.name = String(payload.name).trim();

    var data = await api("/api/auth/apple", {
      method: "POST",
      body: JSON.stringify(body),
    });
    state.session.user = data.user || null;
    saveState();
    await refreshFromRemote();
    return { ok: true, user: clone(state.session.user) };
  }

  async function getAuthConfig() {
    try {
      return await api("/api/auth/config", { method: "GET" });
    } catch (_err) {
      return { googleClientId: "", appleClientId: "", appleRedirectUri: "" };
    }
  }

  async function getCalendarStatus() {
    try {
      return await api("/api/calendar/google/status", { method: "GET" });
    } catch (_err) {
      return { status: "disconnected", autoAddEnabled: false };
    }
  }

  async function getCalendarConnectUrl() {
    return api("/api/calendar/google/connect", { method: "GET" });
  }

  async function toggleCalendarAutoAdd(enabled) {
    return api("/api/calendar/google/auto-add", {
      method: "PUT",
      body: JSON.stringify({ enabled: enabled })
    });
  }

  async function disconnectCalendar() {
    return api("/api/calendar/google/disconnect", { method: "POST" });
  }

  function getSettings() {
    return clone(state.db.settings || {});
  }

  function updateSettings(input) {
    state.db.settings = Object.assign({}, state.db.settings || {}, input || {});
    saveState();
    return clone(state.db.settings);
  }

  function getTests() {
    return clone(state.db.tests || []);
  }

  function getQuestions() {
    return clone(state.db.questions || []);
  }

  function getQotd() {
    return state.db.qotd ? clone(state.db.qotd) : null;
  }

  function getTestById(testId) {
    return clone((state.db.tests || []).find(function (t) { return t.id === testId; }) || null);
  }

  function sortQuestionsSuprFirst(questions) {
    return (questions || []).slice().sort(function (a, b) {
      var aSec = String(a.section || "SUPR").toUpperCase();
      var bSec = String(b.section || "SUPR").toUpperCase();
      if (aSec === bSec) return 0;
      return aSec === "SUPR" ? -1 : 1;
    });
  }

  function getQuestionsForTest(testId) {
    var test = (state.db.tests || []).find(function (t) { return t.id === testId; }) || null;
    if (!test) return [];
    var questionIds = Array.isArray(test.questionIds) ? test.questionIds : [];
    var cacheEntry = getQuestionCacheEntry(testId);
    var cachedQuestions = cacheEntry && Array.isArray(cacheEntry.questions) ? cacheEntry.questions : [];
    var resolved = [];
    if (Array.isArray(cachedQuestions) && cachedQuestions.length) {
      if (!questionIds.length) {
        resolved = cachedQuestions.map(clone);
      } else {
        var cachedMap = cachedQuestions.reduce(function (acc, q) {
          acc[q.id] = q;
          return acc;
        }, {});
        resolved = questionIds.map(function (id) { return cachedMap[id]; }).filter(Boolean).map(clone);
      }
    } else {
      var questionMap = (state.db.questions || []).reduce(function (acc, q) {
        acc[q.id] = q;
        return acc;
      }, {});
      resolved = questionIds.map(function (id) { return questionMap[id]; }).filter(Boolean).map(clone);
    }
    return sortQuestionsSuprFirst(resolved);
  }

  function getAttemptById(attemptId) {
    var attempt = (state.db.attempts || []).find(function (a) { return a.id === attemptId; }) || null;
    return attempt ? clone(attempt) : null;
  }

  async function getAttemptResult(attemptId) {
    var payload = await api("/api/result/" + encodeURIComponent(String(attemptId || "")), { method: "GET" });
    var remote = payload && payload.attempt ? payload.attempt : null;
    if (!remote) return null;

    var userId = state.session.user && state.session.user.id ? state.session.user.id : "";
    var mapped = mapRemoteAttempt(remote, userId);
    var attempts = state.db.attempts || [];
    var existingIndex = attempts.findIndex(function (item) {
      return item.id === remote.id || (item.status === "submitted" && item.testId === remote.testId && item.attemptNumber === remote.attemptNumber);
    });

    var mergedAttempt = mapped;
    if (existingIndex >= 0) {
      var existing = attempts[existingIndex] || {};
      mergedAttempt = mergeAttemptData(existing, mapped);
      attempts.splice(existingIndex, 1, mergedAttempt);
    } else {
      attempts = attempts.concat([mapped]);
    }

    state.db.attempts = attempts;
    saveState();
    return clone(mergedAttempt);
  }

  async function getTestQuestionsFromRemote(testId) {
    var payload = await api("/api/tests/" + encodeURIComponent(String(testId || "")) + "/questions", { method: "GET" });
    var questions = payload && payload.questions ? payload.questions : [];
    var currentTest = getTestById(testId);
    setQuestionCacheEntry(testId, questions, currentTest && currentTest.updatedAt ? currentTest.updatedAt : null);
    state.db.tests = (state.db.tests || []).map(function (test) {
      if (!test || test.id !== String(testId)) {
        return test;
      }
      return mergeTestData(test, {
        questionIds: questions.map(function (question) { return question.id; }),
        questionCount: questions.length,
      });
    });
    saveState();
    return clone(questions);
  }

  async function ensureTestQuestionsLoaded(testId) {
    var test = getTestById(testId);
    var expectedCount = test ? Number(test.questionCount || 0) : 0;
    var existing = getQuestionsForTest(testId);
    if (existing.length && (!expectedCount || existing.length >= expectedCount)) {
      return existing;
    }
    return getTestQuestionsFromRemote(testId);
  }

  // ===========================================================================
  // Exam sessions (server-authoritative). The local attempt object is a mirror of the
  // server AttemptSession: the server owns deadlines, section locks, saved answers and
  // finalization. The browser timer only displays the server deadline.
  // ===========================================================================
  var EXAM_TOKEN_PREFIX = "aceiiit.exam.";
  var AUTOSAVE_DEBOUNCE_MS = 3000;
  var AUTOSAVE_RETRY_MS = [3000, 6000, 15000, 30000];
  var serverClock = { serverMs: 0, perfMs: 0 };
  var autosaveState = {};

  function monotonicNow() {
    return (window.performance && typeof window.performance.now === "function") ? window.performance.now() : Date.now();
  }

  function syncServerClock(serverNowIso) {
    var parsed = Date.parse(serverNowIso || "");
    if (!Number.isFinite(parsed)) return;
    serverClock = { serverMs: parsed, perfMs: monotonicNow() };
  }

  // Server time that keeps ticking even if the device clock is changed mid-exam.
  function serverNow() {
    if (!serverClock.serverMs) return Date.now();
    return serverClock.serverMs + (monotonicNow() - serverClock.perfMs);
  }

  function getExamToken(sessionId) {
    try {
      return window.sessionStorage.getItem(EXAM_TOKEN_PREFIX + sessionId) || "";
    } catch (_err) {
      return "";
    }
  }

  function setExamToken(sessionId, token) {
    try {
      if (token) window.sessionStorage.setItem(EXAM_TOKEN_PREFIX + sessionId, token);
      else window.sessionStorage.removeItem(EXAM_TOKEN_PREFIX + sessionId);
    } catch (_err) {}
  }

  function examHeaders(sessionId, extra) {
    return Object.assign({ "X-Exam-Token": getExamToken(sessionId) }, extra || {});
  }

  function listToMap(list) {
    return (Array.isArray(list) ? list : []).reduce(function (acc, id) {
      acc[id] = true;
      return acc;
    }, {});
  }

  function mapToList(map) {
    return Object.keys(map || {}).filter(function (key) { return !!map[key]; });
  }

  function parseMs(iso) {
    var value = Date.parse(iso || "");
    return Number.isFinite(value) ? value : null;
  }

  function applySessionToAttempt(session, existing) {
    var base = existing ? clone(existing) : {};
    var userId = state.session.user && state.session.user.id;
    var answers = Object.assign({}, session.answers || {});
    // Keep answers that were changed locally but not yet acknowledged by the server.
    var pending = autosaveState[session.id] && autosaveState[session.id].dirtyAnswers;
    if (pending && existing && existing.answers) {
      Object.keys(pending).forEach(function (questionId) {
        if (existing.answers[questionId] === undefined) delete answers[questionId];
        else answers[questionId] = existing.answers[questionId];
      });
    }
    var reapStarted = !!session.deadlines.reapStartedAt;
    var attempt = Object.assign(base, {
      id: session.id,
      sessionId: session.id,
      userId: userId,
      testId: session.testId,
      status: "in_progress",
      startedAt: session.startedAt,
      updatedAt: nowIso(),
      submittedAt: null,
      activeSection: session.activeSection,
      currentSection: session.activeSection,
      currentQuestionId: (existing && existing.currentQuestionId) || session.currentQuestionId || "",
      answers: answers,
      visited: Object.assign(listToMap(session.visited), (existing && existing.visited) || {}),
      marked: existing && existing.marked ? existing.marked : listToMap(session.marked),
      timeSpent: Object.assign({}, session.timeSpent || {}, (existing && existing.timeSpent) || {}),
      lastActiveAt: nowIso(),
      isPractice: !!session.isPractice,
      serverDeadlines: {
        SUPR: parseMs(session.deadlines.SUPR),
        reapStartedAt: parseMs(session.deadlines.reapStartedAt),
        REAP: parseMs(session.deadlines.REAP),
        final: parseMs(session.deadlines.final),
      },
      serverDurations: session.durations,
      graceMs: session.graceMs,
      suprLocked: !!session.suprLocked,
      integrity: session.integrity || (base.integrity || null),
      lastSeq: Math.max(Number(base.lastSeq || 0), Number(session.lastSeq || 0)),
      sectionTimers: {
        SUPR: {
          startedAt: session.startedAt,
          durationMinutes: Math.round(Number(session.durations.SUPR || 0) / 60000),
          locked: !!session.suprLocked,
          completedAt: session.suprLocked ? (session.deadlines.reapStartedAt || null) : null,
        },
        REAP: {
          startedAt: reapStarted ? session.deadlines.reapStartedAt : null,
          durationMinutes: Math.round(Number(session.durations.REAP || 0) / 60000),
          locked: !reapStarted,
          completedAt: null,
        },
      },
      result: null,
      resultSnapshot: null,
    });
    return attempt;
  }

  function upsertLocalAttempt(attempt) {
    var attempts = (state.db.attempts || []).filter(function (a) { return a.id !== attempt.id; });
    state.db.attempts = attempts.concat([attempt]);
    saveState();
    return clone(attempt);
  }

  function examError(error) {
    var wrapped = error instanceof Error ? error : new Error(String(error || "Exam request failed"));
    return wrapped;
  }

  async function examRequest(sessionId, path, init) {
    var options = Object.assign({}, init || {});
    options.headers = examHeaders(sessionId, options.headers);
    try {
      var data = await api(path, options);
      if (data && data.session && data.session.serverNow) syncServerClock(data.session.serverNow);
      return data;
    } catch (error) {
      throw examError(error);
    }
  }

  async function loadExamPaper(sessionId, testId) {
    var data = await examRequest(sessionId, "/api/attempt/session/" + encodeURIComponent(sessionId) + "/paper", { method: "GET" });
    var questions = (data && data.questions) || [];
    setQuestionCacheEntry(testId, questions, null);
    state.db.tests = (state.db.tests || []).map(function (test) {
      if (!test || test.id !== String(testId)) return test;
      return mergeTestData(test, {
        questionIds: questions.map(function (question) { return question.id; }),
        questionCount: questions.length,
      });
    });
    saveState();
    return questions;
  }

  async function adoptSession(sessionView, examToken) {
    if (examToken) setExamToken(sessionView.id, examToken);
    syncServerClock(sessionView.serverNow);
    var existing = (state.db.attempts || []).find(function (a) { return a.id === sessionView.id; }) || null;
    var attempt = upsertLocalAttempt(applySessionToAttempt(sessionView, existing));
    await loadExamPaper(sessionView.id, sessionView.testId);
    return attempt;
  }

  /**
   * Starts or resumes the exam for a test. Throws an error with code
   * "EXAM_ACTIVE_ELSEWHERE" (and .sessionId) when the exam is bound to another
   * tab/device; call takeoverExam(sessionId) after the student confirms.
   */
  async function startExam(testId) {
    var local = (state.db.attempts || []).find(function (a) {
      return a.testId === testId && a.status === "in_progress" && a.sessionId;
    }) || null;
    var headers = local ? { "X-Exam-Token": getExamToken(local.sessionId) } : {};
    var data;
    try {
      data = await api("/api/attempt/start", { method: "POST", headers: headers, body: JSON.stringify({ testId: testId }) });
    } catch (error) {
      if (error && error.code === "EXAM_ACTIVE_ELSEWHERE" && error.data && error.data.sessionId) {
        error.sessionId = error.data.sessionId;
      }
      throw error;
    }
    if (local && local.sessionId !== data.session.id) {
      // The previous session ended on the server; drop its stale local mirror.
      state.db.attempts = (state.db.attempts || []).filter(function (a) { return a.id !== local.id; });
    }
    return adoptSession(data.session, data.examToken);
  }

  async function takeoverExam(sessionId) {
    var data = await api("/api/attempt/session/" + encodeURIComponent(sessionId) + "/takeover", { method: "POST", body: "{}" });
    return adoptSession(data.session, data.examToken);
  }

  async function ensureExamPaper(attemptId) {
    var attempt = (state.db.attempts || []).find(function (a) { return a.id === attemptId; }) || null;
    if (!attempt || !attempt.sessionId) return [];
    return loadExamPaper(attempt.sessionId, attempt.testId);
  }

  function getInProgressAttempt(userId, testId) {
    var attempt = (state.db.attempts || []).find(function (a) {
      return a.userId === userId && a.testId === testId && a.status === "in_progress";
    }) || null;
    return attempt ? clone(attempt) : null;
  }

  // ---------------------------------------------------------------- autosave
  function getAutosave(sessionId) {
    if (!autosaveState[sessionId]) {
      autosaveState[sessionId] = { dirtyAnswers: {}, dirtyMeta: false, timer: null, inFlight: null, failures: 0, status: "saved", closedAttemptId: null, bindingLost: false };
    }
    return autosaveState[sessionId];
  }

  function getAutosaveStatus(attemptId) {
    var entry = autosaveState[attemptId];
    if (!entry) return { status: "saved", closedAttemptId: null, bindingLost: false };
    return { status: entry.status, closedAttemptId: entry.closedAttemptId, bindingLost: entry.bindingLost };
  }

  function scheduleAutosave(sessionId, delayMs) {
    var entry = getAutosave(sessionId);
    if (entry.timer) window.clearTimeout(entry.timer);
    entry.timer = window.setTimeout(function () {
      entry.timer = null;
      flushAutosave(sessionId).catch(function () {});
    }, typeof delayMs === "number" ? delayMs : AUTOSAVE_DEBOUNCE_MS);
  }

  function buildProgressPayload(attempt, entry) {
    var answers = {};
    Object.keys(entry.dirtyAnswers).forEach(function (questionId) {
      var value = attempt.answers ? attempt.answers[questionId] : undefined;
      answers[questionId] = value === undefined || value === null || value === "" ? null : Number(value);
    });
    var timeSpent = {};
    Object.keys(attempt.timeSpent || {}).forEach(function (questionId) {
      timeSpent[questionId] = Math.max(0, Math.round(Number(attempt.timeSpent[questionId] || 0)));
    });
    return {
      answers: answers,
      timeSpent: timeSpent,
      marked: mapToList(attempt.marked),
      visited: mapToList(attempt.visited),
      currentQuestionId: attempt.currentQuestionId || undefined,
    };
  }

  function handleSessionClosed(sessionId, error) {
    var entry = getAutosave(sessionId);
    var attemptId = error && error.data && error.data.attemptId;
    entry.status = "closed";
    entry.closedAttemptId = attemptId || entry.closedAttemptId || "pending";
  }

  async function flushAutosave(sessionId) {
    var entry = getAutosave(sessionId);
    if (entry.inFlight) {
      await entry.inFlight.catch(function () {});
    }
    var attempt = (state.db.attempts || []).find(function (a) { return a.id === sessionId; }) || null;
    if (!attempt || attempt.status !== "in_progress" || !attempt.sessionId) return null;
    if (!Object.keys(entry.dirtyAnswers).length && !entry.dirtyMeta) return null;

    var sentAnswers = Object.assign({}, entry.dirtyAnswers);
    var payload = buildProgressPayload(attempt, entry);
    var seq = Number(attempt.lastSeq || 0) + 1;
    payload.seq = seq;
    entry.status = "saving";
    entry.inFlight = (async function () {
      try {
        var data = await examRequest(sessionId, "/api/attempt/session/" + encodeURIComponent(sessionId) + "/answers", {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        Object.keys(sentAnswers).forEach(function (questionId) {
          delete entry.dirtyAnswers[questionId];
        });
        entry.dirtyMeta = Object.keys(entry.dirtyAnswers).length > 0 ? entry.dirtyMeta : false;
        entry.failures = 0;
        entry.status = "saved";
        entry.bindingLost = false;
        var current = (state.db.attempts || []).find(function (a) { return a.id === sessionId; }) || null;
        if (current) {
          current.lastSeq = Math.max(seq, Number(data && data.session && data.session.lastSeq || 0));
          if (data && data.session) {
            current.serverDeadlines = applySessionToAttempt(data.session, current).serverDeadlines;
          }
          saveState();
        }
        return data;
      } catch (error) {
        var code = error && error.code;
        if (code === "SECTION_LOCKED" || code === "SECTION_NOT_STARTED" || code === "INVALID_OPTION" || code === "INVALID_QUESTION") {
          // The server rejected these answers (e.g. SUPR locked at its deadline): resync to server truth.
          entry.dirtyAnswers = {};
          entry.status = "saved";
          await resyncSession(sessionId).catch(function () {});
          return null;
        }
        if (code === "EXAM_EXPIRED" || code === "SESSION_CLOSED") {
          handleSessionClosed(sessionId, error);
          return null;
        }
        if (code === "EXAM_ACTIVE_ELSEWHERE") {
          entry.bindingLost = true;
          entry.status = "elsewhere";
          return null;
        }
        if (error && error.status === 401) {
          entry.status = "offline";
          return null;
        }
        entry.failures += 1;
        entry.status = "offline";
        var delay = AUTOSAVE_RETRY_MS[Math.min(entry.failures - 1, AUTOSAVE_RETRY_MS.length - 1)];
        scheduleAutosave(sessionId, delay);
        throw error;
      } finally {
        entry.inFlight = null;
      }
    })();
    return entry.inFlight;
  }

  async function resyncSession(sessionId) {
    var attempt = (state.db.attempts || []).find(function (a) { return a.id === sessionId; }) || null;
    if (!attempt) return null;
    var data = await examRequest(sessionId, "/api/attempt/start", {
      method: "POST",
      body: JSON.stringify({ testId: attempt.testId }),
    });
    if (data && data.session && data.session.id === sessionId) {
      var serverAnswers = data.session.answers || {};
      var updated = applySessionToAttempt(data.session, attempt);
      updated.answers = Object.assign({}, serverAnswers);
      upsertLocalAttempt(updated);
    }
    return data;
  }

  /** Best-effort flush when the page is being hidden/closed (fetch keepalive allows headers). */
  function flushAutosaveOnExit(sessionId) {
    var entry = autosaveState[sessionId];
    var attempt = (state.db.attempts || []).find(function (a) { return a.id === sessionId; }) || null;
    if (!entry || !attempt || attempt.status !== "in_progress") return;
    if (!Object.keys(entry.dirtyAnswers).length && !entry.dirtyMeta) return;
    var payload = buildProgressPayload(attempt, entry);
    payload.seq = Number(attempt.lastSeq || 0) + 1;
    try {
      fetch("/api/attempt/session/" + encodeURIComponent(sessionId) + "/answers", {
        method: "PUT",
        keepalive: true,
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": readCookie(CSRF_COOKIE),
          "X-Exam-Token": getExamToken(sessionId),
        },
        body: JSON.stringify(payload),
      }).catch(function () {});
    } catch (_err) {}
  }

  function patchAttempt(attemptId, updater) {
    var attempts = state.db.attempts || [];
    var index = attempts.findIndex(function (a) { return a.id === attemptId; });
    if (index === -1) return null;
    var before = attempts[index];
    var draft = clone(before);
    updater(draft, state.db);
    draft.updatedAt = nowIso();
    draft.lastActiveAt = draft.updatedAt;
    attempts[index] = draft;
    state.db.attempts = attempts;
    saveState();

    if (draft.sessionId && draft.status === "in_progress") {
      var entry = getAutosave(draft.sessionId);
      var beforeAnswers = before.answers || {};
      var afterAnswers = draft.answers || {};
      Object.keys(Object.assign({}, beforeAnswers, afterAnswers)).forEach(function (questionId) {
        if (String(beforeAnswers[questionId]) !== String(afterAnswers[questionId])) {
          entry.dirtyAnswers[questionId] = true;
        }
      });
      if (JSON.stringify(before.timeSpent || {}) !== JSON.stringify(draft.timeSpent || {}) ||
          JSON.stringify(before.marked || {}) !== JSON.stringify(draft.marked || {}) ||
          JSON.stringify(before.visited || {}) !== JSON.stringify(draft.visited || {}) ||
          before.currentQuestionId !== draft.currentQuestionId) {
        entry.dirtyMeta = true;
      }
      if (Object.keys(entry.dirtyAnswers).length || entry.dirtyMeta) {
        if (entry.status === "saved") entry.status = "pending";
        scheduleAutosave(draft.sessionId);
      }
    }
    return clone(draft);
  }

  /** Locks SUPR on the server and starts REAP at server time. */
  async function advanceSection(attemptId) {
    await flushAutosave(attemptId).catch(function () {});
    var attempt = (state.db.attempts || []).find(function (a) { return a.id === attemptId; }) || null;
    if (!attempt || !attempt.sessionId) return null;
    var data = await examRequest(attempt.sessionId, "/api/attempt/session/" + encodeURIComponent(attempt.sessionId) + "/advance", {
      method: "POST",
      body: "{}",
    });
    var updated = applySessionToAttempt(data.session, attempt);
    return upsertLocalAttempt(updated);
  }

  function replaceLocalWithResult(localId, remote) {
    var userId = state.session.user && state.session.user.id;
    var mapped = mapRemoteAttempt(remote, userId);
    var test = getTestById(remote.testId);
    mapped.resultSnapshot = {
      savedAt: nowIso(),
      testTitle: (test || {}).title || remote.testId,
      testSubtitle: (test || {}).subtitle || "",
      startedAt: mapped.startedAt,
      submittedAt: mapped.submittedAt,
      result: mapped.result,
    };
    state.db.attempts = (state.db.attempts || []).filter(function (a) {
      return a.id !== localId && a.id !== mapped.id;
    }).concat([mapped]);
    if (localId) setExamToken(localId, "");
    delete autosaveState[localId];
    saveState();
    return clone(mapped);
  }

  function wait(ms) {
    return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
  }

  async function submitAttempt(attemptId) {
    var attempts = state.db.attempts || [];
    var localAttempt = attempts.find(function (a) { return a.id === attemptId; }) || null;
    if (!localAttempt) return null;
    if (localAttempt.status === "submitted") return clone(localAttempt);
    if (!localAttempt.sessionId) {
      throw new Error("This attempt was started by an older version of the portal. Please restart the test.");
    }
    var sessionId = localAttempt.sessionId;
    await flushAutosave(sessionId).catch(function () {});

    if (!localAttempt.submitKey) {
      localAttempt.submitKey = "submit-" + sessionId + "-" + Math.random().toString(36).slice(2, 10);
      saveState();
    }
    var latest = (state.db.attempts || []).find(function (a) { return a.id === attemptId; }) || localAttempt;
    var entry = getAutosave(sessionId);
    var finalPayload = buildProgressPayload(latest, entry);
    var body = JSON.stringify({ sessionId: sessionId, answers: finalPayload.answers, timeSpent: finalPayload.timeSpent });

    var lastError = null;
    for (var tryIndex = 0; tryIndex < 4; tryIndex += 1) {
      try {
        var response = await examRequest(sessionId, "/api/attempt", {
          method: "POST",
          headers: { "Idempotency-Key": localAttempt.submitKey },
          body: body,
        });
        return replaceLocalWithResult(attemptId, response.attempt);
      } catch (error) {
        lastError = error;
        var code = error && error.code;
        if ((code === "EXAM_EXPIRED" || code === "SESSION_CLOSED") && error.data && error.data.attemptId) {
          // Time ran out: the server finalized the saved answers. Show that result.
          var remote = await getAttemptResult(error.data.attemptId);
          if (remote) return replaceLocalWithResult(attemptId, Object.assign({}, remote, { id: error.data.attemptId }));
          throw error;
        }
        var retryable = !error.status || error.status >= 500 || code === "IDEMPOTENCY_IN_PROGRESS" || code === "FINALIZE_BUSY";
        if (!retryable) throw error;
        await wait(1000 * Math.pow(2, tryIndex));
      }
    }
    throw lastError;
  }

  /** Quit/restart: submits the saved answers (counts as an attempt) and clears the local mirror. */
  async function discardAttempt(attemptId) {
    var attempt = (state.db.attempts || []).find(function (a) { return a.id === attemptId; }) || null;
    if (!attempt) return { ok: true };
    if (!attempt.sessionId) {
      state.db.attempts = (state.db.attempts || []).filter(function (a) { return a.id !== attemptId; });
      saveState();
      return { ok: true };
    }
    await flushAutosave(attempt.sessionId).catch(function () {});
    var abandon = function () {
      return examRequest(attempt.sessionId, "/api/attempt/session/" + encodeURIComponent(attempt.sessionId) + "/abandon", { method: "POST", body: "{}" });
    };
    var response;
    try {
      response = await abandon();
    } catch (error) {
      if (error && error.code === "EXAM_ACTIVE_ELSEWHERE") {
        await takeoverExam(attempt.sessionId);
        response = await abandon();
      } else if (error && (error.code === "EXAM_EXPIRED" || error.code === "SESSION_CLOSED")) {
        response = null;
      } else {
        throw error;
      }
    }
    if (response && response.attempt) {
      replaceLocalWithResult(attemptId, response.attempt);
    } else {
      state.db.attempts = (state.db.attempts || []).filter(function (a) { return a.id !== attemptId; });
      saveState();
    }
    return { ok: true };
  }

  /** For an in-progress mirror whose server deadline passed: find the server-finalized attempt. */
  async function resolveExpiredAttempt(attemptId) {
    var attempt = (state.db.attempts || []).find(function (a) { return a.id === attemptId; }) || null;
    if (!attempt) return null;
    await api("/api/attempt/sessions/active", { method: "GET" }).catch(function () {});
    var payload = await api("/api/attempts", { method: "GET" });
    var match = ((payload && payload.attempts) || []).find(function (remote) {
      return remote.sessionId && remote.sessionId === attempt.sessionId;
    });
    if (!match) {
      state.db.attempts = (state.db.attempts || []).filter(function (a) { return a.id !== attemptId; });
      saveState();
      return null;
    }
    return replaceLocalWithResult(attemptId, match);
  }

  /** Sends integrity telemetry; the server owns the count and any strict-mode auto-submit. */
  async function sendIntegrityEvents(sessionId, events) {
    var data = await examRequest(sessionId, "/api/attempt/session/" + encodeURIComponent(sessionId) + "/events", {
      method: "POST",
      body: JSON.stringify({ events: events }),
    });
    if (data && data.autoSubmitted) {
      handleSessionClosed(sessionId, { data: { attemptId: data.attemptId } });
    }
    return data;
  }

  function isAttemptPastDeadline(attempt) {
    if (!attempt || attempt.status !== "in_progress" || !attempt.serverDeadlines) return false;
    var finalMs = attempt.serverDeadlines.REAP || attempt.serverDeadlines.final;
    return Number.isFinite(finalMs) && serverNow() > finalMs + Number(attempt.graceMs || 60000);
  }

  function listUserAttempts(userId) {
    return (state.db.attempts || [])
      .filter(function (a) { return a.userId === userId; })
      .slice()
      .sort(function (a, b) {
        var aTime = new Date(a.submittedAt || a.startedAt).getTime();
        var bTime = new Date(b.submittedAt || b.startedAt).getTime();
        return bTime - aTime;
      })
      .map(clone);
  }

  function getDashboardSnapshot(userId) {
    var tests = (state.db.tests || []).filter(function (t) { 
      if (t.status !== "live") return false;
      if (t.isPractice && t.createdBy !== userId) return false;
      return true;
    });
    var attempts = listUserAttempts(userId);
    var submitted = attempts.filter(function (a) { return a.status === "submitted" && a.result; });
    return {
      tests: clone(tests),
      attempts: clone(attempts),
      completedCount: submitted.length,
      bestScore: submitted.length ? Math.max.apply(null, submitted.map(function (a) { return a.result.score; })) : 0,
      bestPercentile: submitted.length ? Math.max.apply(null, submitted.map(function (a) { return a.result.percentile; })) : 0,
    };
  }

  function getAdminSnapshot() {
    return clone(state.db.adminSnapshot || { users: [], tests: [], questions: [], attempts: [] });
  }

  function getAppConfig() {
    return clone(state.db.appConfig || { ugeeExamDate: null, featuredTestId: "", noticeTitle: "", noticeBody: "" });
  }

  function listReminders() {
    return clone(state.db.reminders || []);
  }

  async function createTest(input) {
    var mapped = mapAdminTestPayload(input, null);
    var data = await api("/api/tests", { method: "POST", body: JSON.stringify(mapped) });
    await refreshFromRemote();
    return data.test || null;
  }

  function normalizeQuestionUploadFiles(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
      return value.filter(Boolean);
    }
    return [value].filter(Boolean);
  }

  function appendQuestionUploadFiles(form, value) {
    var files = normalizeQuestionUploadFiles(value);
    files.forEach(function (file) {
      form.append(files.length === 1 ? "image" : "images", file);
    });
  }

  async function uploadQuestionImages(value) {
    var files = normalizeQuestionUploadFiles(value);
    if (!files.length) {
      return [];
    }
    var form = new FormData();
    appendQuestionUploadFiles(form, files);
    var data = await apiForm("/api/upload-image", "POST", form);
    if (Array.isArray(data && data.urls)) {
      return data.urls.slice();
    }
    if (data && data.url) {
      return [String(data.url)];
    }
    return [];
  }

  async function updateTest(testId, input) {
    var existing = getTestById(testId);
    var mapped = mapAdminTestPayload(input, existing);
    var data = await api("/api/tests/" + encodeURIComponent(testId), { method: "PUT", body: JSON.stringify(mapped) });
    await refreshFromRemote();
    return data.test || null;
  }

  async function reorderTests(testIdsInOrder) {
    var orderedIds = (testIdsInOrder || [])
      .map(function (id) { return String(id || "").trim(); })
      .filter(Boolean);

    for (var index = 0; index < orderedIds.length; index += 1) {
      await api("/api/tests/" + encodeURIComponent(orderedIds[index]), {
        method: "PUT",
        body: JSON.stringify({ displayOrder: (index + 1) * 10 }),
      });
    }

    await refreshFromRemote();
    return getTests();
  }

  async function deleteTest(testId) {
    await api("/api/tests/" + encodeURIComponent(testId), { method: "DELETE" });
    await refreshFromRemote();
    return { ok: true };
  }

  async function createQuestion(input) {
    var testId = input && input.testId ? String(input.testId) : "";
    var files = arguments.length > 1 ? arguments[1] : null;
    var mapped = mapAdminQuestionPayload(input);
    var form = new FormData();
    Object.keys(mapped).forEach(function (key) {
      if (mapped[key] === undefined || mapped[key] === null) return;
      if (key === "options" || key === "imageUrls") {
        form.append(key, JSON.stringify(mapped[key]));
      } else {
        form.append(key, String(mapped[key]));
      }
    });
    appendQuestionUploadFiles(form, files);
    var data = await apiForm("/api/admin/questions", "POST", form);
    if (testId && data && data.question && data.question.id) {
      await api("/api/admin/attach", { method: "POST", body: JSON.stringify({ testId: testId, questionId: data.question.id }) });
    }
    await refreshFromRemote();
    return data.question || null;
  }

  async function updateQuestion(questionId, input) {
    var testId = input && input.testId ? String(input.testId) : "";
    var files = arguments.length > 2 ? arguments[2] : null;
    var hasFields = false;
    if (input && typeof input === "object") {
      ["section", "topic", "difficulty", "prompt", "passage", "imageUrls", "options", "correctOption", "explanation", "marks", "negativeMarks"].forEach(function (key) {
        if (Object.prototype.hasOwnProperty.call(input, key)) {
          hasFields = true;
        }
      });
    }
    var mapped = hasFields ? mapAdminQuestionPayload(input) : {};
    var form = new FormData();
    Object.keys(mapped).forEach(function (key) {
      if (mapped[key] === undefined || mapped[key] === null) return;
      if (key === "options" || key === "imageUrls") {
        form.append(key, JSON.stringify(mapped[key]));
      } else {
        form.append(key, String(mapped[key]));
      }
    });
    appendQuestionUploadFiles(form, files);
    var data = await apiForm("/api/admin/questions/" + encodeURIComponent(questionId), "PUT", form);
    if (testId) {
      await api("/api/admin/attach", { method: "POST", body: JSON.stringify({ testId: testId, questionId: questionId }) });
    }
    await refreshFromRemote();
    return data.question || null;
  }

  async function deleteQuestion(questionId) {
    await api("/api/admin/questions/" + encodeURIComponent(questionId), { method: "DELETE" });
    await refreshFromRemote();
    return { ok: true };
  }

  async function attachQuestionToTest(testId, questionId) {
    await api("/api/admin/attach", { method: "POST", body: JSON.stringify({ testId: testId, questionId: questionId }) });
    await refreshFromRemote();
    return { ok: true };
  }

  async function detachQuestionFromTest(testId, questionId) {
    await api("/api/admin/detach", { method: "POST", body: JSON.stringify({ testId: testId, questionId: questionId }) });
    await refreshFromRemote();
    return { ok: true };
  }

  async function attachQuestionsBulk(testId, questionIds) {
    await api("/api/admin/attach-bulk", { method: "POST", body: JSON.stringify({ testId: testId, questionIds: questionIds }) });
    await refreshFromRemote();
    return { ok: true };
  }

  async function detachQuestionsBulk(testId, questionIds) {
    await api("/api/admin/detach-bulk", { method: "POST", body: JSON.stringify({ testId: testId, questionIds: questionIds }) });
    await refreshFromRemote();
    return { ok: true };
  }

  async function reorderTestQuestions(testId, questionIds) {
    await api("/api/admin/reorder-questions", { method: "POST", body: JSON.stringify({ testId: testId, questionIds: questionIds }) });
    await refreshFromRemote();
    return { ok: true };
  }

  async function duplicateTest(testId) {
    var res = await api("/api/admin/test/" + encodeURIComponent(String(testId)) + "/duplicate", { method: "POST" });
    await refreshFromRemote();
    return res;
  }

  async function generateQuestionsRandom(params) {
    return api("/api/admin/generate-questions", { method: "POST", body: JSON.stringify(params || {}) });
  }

  async function attachRandomQuestionsToTest(testId, counts) {
    counts = counts || {};
    var suprNeeded = Number(counts.SUPR || 0);
    var reapNeeded = Number(counts.REAP || 0);
    var test = getTestById(testId);
    if (!test) throw new Error("Test not found.");

    var previousQuestionIds = (test.questions || []).slice();

    var allQuestions = getQuestions();
    var attachedQuestions = getQuestionsForTest(testId);
    var attachedIds = attachedQuestions.map(function (q) { return q.id; });

    var availableSupr = allQuestions.filter(function (q) {
      return String(q.section || "SUPR").toUpperCase() === "SUPR" && attachedIds.indexOf(q.id) === -1;
    });
    var availableReap = allQuestions.filter(function (q) {
      return String(q.section || "SUPR").toUpperCase() === "REAP" && attachedIds.indexOf(q.id) === -1;
    });

    function shuffle(arr) {
      var copy = arr.slice();
      for (var i = copy.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var temp = copy[i];
        copy[i] = copy[j];
        copy[j] = temp;
      }
      return copy;
    }

    var selectedSupr = shuffle(availableSupr).slice(0, suprNeeded).map(function (q) { return q.id; });
    var selectedReap = shuffle(availableReap).slice(0, reapNeeded).map(function (q) { return q.id; });

    var toAttach = selectedSupr.concat(selectedReap);
    if (!toAttach.length) {
      throw new Error("No additional available questions found in bank for SUPR or REAP sections.");
    }

    await attachQuestionsBulk(testId, toAttach);

    var updatedQuestions = getQuestionsForTest(testId);
    var sortedIds = sortQuestionsSuprFirst(updatedQuestions).map(function (q) { return q.id; });
    await reorderTestQuestions(testId, sortedIds);

    return {
      ok: true,
      attachedCount: toAttach.length,
      attachedIds: toAttach,
      previousQuestionIds: previousQuestionIds
    };
  }

  async function undoRandomQuestionsAttachment(testId, previousQuestionIds) {
    if (!Array.isArray(previousQuestionIds)) {
      throw new Error("No valid backup state to undo random generation.");
    }
    await reorderTestQuestions(testId, previousQuestionIds);
    return { ok: true, restoredCount: previousQuestionIds.length };
  }

  async function getAdminResults() {
    return api("/api/admin/results", { method: "GET" });
  }

  async function getAdminTrash() {
    return api("/api/admin/trash", { method: "GET" });
  }

  async function restoreTrash(kind, id) {
    await api(
      "/api/admin/trash/" + encodeURIComponent(String(kind)) + "/" + encodeURIComponent(String(id)) + "/restore",
      { method: "POST" }
    );
    await refreshFromRemote();
    return { ok: true };
  }

  async function purgeTrash(kind, id) {
    await api(
      "/api/admin/trash/" + encodeURIComponent(String(kind)) + "/" + encodeURIComponent(String(id)) + "/purge",
      { method: "DELETE" }
    );
    await refreshFromRemote();
    return { ok: true };
  }

  async function deleteUser(userId) {
    await api("/api/admin/users/" + encodeURIComponent(String(userId)), { method: "DELETE" });
    await refreshFromRemote();
    return { ok: true };
  }

  async function exportMyData() {
    return api("/api/account/export", { method: "GET" });
  }

  async function deleteMyAccount(payload) {
    var res = await api("/api/account", { method: "DELETE", body: JSON.stringify(payload || {}) });
    clearSession();
    return res;
  }

  async function logoutAllDevices() {
    try {
      await api("/api/auth/logout-all", { method: "POST", body: "{}" });
    } finally {
      clearSession();
    }
  }

  async function getInterpretation(attemptId) {
    var data = await api("/api/analysis/" + encodeURIComponent(String(attemptId)) + "/interpretation", { method: "GET" });
    return data && data.interpretation ? data.interpretation : null;
  }

  async function getAttemptIntegrity(attemptId) {
    return api("/api/admin/attempts/" + encodeURIComponent(attemptId) + "/integrity", { method: "GET" });
  }

  async function invalidateAttempt(attemptId, reason, restore) {
    return api("/api/admin/attempts/" + encodeURIComponent(attemptId) + "/invalidate", {
      method: "POST",
      body: JSON.stringify({ reason: String(reason || ""), restore: !!restore }),
    });
  }

  async function getAdminLeaderboard(testId) {
    return api("/api/admin/leaderboard?testId=" + encodeURIComponent(String(testId || "")), { method: "GET" });
  }

  async function getAdminTestAnalytics(testId) {
    return api("/api/admin/test/" + encodeURIComponent(String(testId || "")) + "/analytics", { method: "GET" });
  }

  async function updateAppConfig(input) {
    var payload = await api("/api/admin/config", { method: "PUT", body: JSON.stringify(input || {}) });
    state.db.appConfig = Object.assign({}, state.db.appConfig || {}, payload && payload.appConfig ? payload.appConfig : {});
    if (state.db.adminSnapshot) {
      state.db.adminSnapshot.appConfig = clone(state.db.appConfig);
    }
    saveState();
    return clone(state.db.appConfig);
  }

  async function submitQotdAttempt(payload) {
    if (!state.session.user) return null;
    var res = await api("/api/tests/qotd-attempt", { method: "POST", body: JSON.stringify(payload || {}) });
    var result = res && res.result ? res.result : null;
    if (result && state.db.qotd && state.db.qotd.id === result.questionId) {
      state.db.qotd.attempt = result;
      saveState();
    }
    return result;
  }

  async function createReminder(input) {
    var payload = await api("/api/reminders", { method: "POST", body: JSON.stringify(input || {}) });
    if (payload && payload.reminder) {
      state.db.reminders = (state.db.reminders || []).concat([mapReminderData(payload.reminder)]);
      saveState();
      return mapReminderData(payload.reminder);
    }
    return null;
  }

  async function updateReminder(reminderId, input) {
    var payload = await api("/api/reminders/" + encodeURIComponent(String(reminderId || "")), { method: "PUT", body: JSON.stringify(input || {}) });
    if (payload && payload.reminder) {
      state.db.reminders = (state.db.reminders || []).map(function (item) {
        return item.id === String(reminderId || "") ? mapReminderData(payload.reminder) : item;
      });
      saveState();
      return mapReminderData(payload.reminder);
    }
    return null;
  }

  async function deleteReminder(reminderId) {
    await api("/api/reminders/" + encodeURIComponent(String(reminderId || "")), { method: "DELETE" });
    state.db.reminders = (state.db.reminders || []).filter(function (item) {
      return item.id !== String(reminderId || "");
    });
    saveState();
    return { ok: true };
  }

  async function getAttemptAnalysis(attemptId) {
    var attempt = (state.db.attempts || []).find(function (item) { return item.id === attemptId; });
    var test = attempt ? getTestById(attempt.testId) : null;
    if (test && test.isPractice && attempt && attempt.result) {
        return {
           analysis: "Practice Test Mode",
           totalTime: attempt.result.timeTakenSeconds,
           unattemptedCount: attempt.result.unattemptedCount,
           sectionWise: {
              SUPR: { score: attempt.result.score, correct: attempt.result.correctCount, wrong: attempt.result.wrongCount, skipped: attempt.result.skippedCount },
              REAP: { score: 0, correct: 0, wrong: 0, skipped: 0 }
           }
        };
    }

    var payload = await api("/api/analysis/" + encodeURIComponent(String(attemptId || "")), { method: "GET" });
    var summary = payload && payload.summary ? payload.summary : null;
    if (!summary) return null;
    attempt = (state.db.attempts || []).find(function (item) { return item.id === attemptId; });
    if (attempt && attempt.result) {
      attempt.result.analysis = summary.analysis || attempt.result.analysis || null;
      attempt.result.totalTime = summary.totalTime;
      attempt.result.unattemptedCount = summary.unattemptedCount;
      if (summary.sectionWise) {
        attempt.result.sectionScores = {
          SUPR: {
            score: Number(summary.sectionWise.SUPR && summary.sectionWise.SUPR.score || 0),
            correct: Number(summary.sectionWise.SUPR && summary.sectionWise.SUPR.correct || 0),
            wrong: Number(summary.sectionWise.SUPR && summary.sectionWise.SUPR.wrong || 0),
            skipped: Number(summary.sectionWise.SUPR && summary.sectionWise.SUPR.skipped || 0),
          },
          REAP: {
            score: Number(summary.sectionWise.REAP && summary.sectionWise.REAP.score || 0),
            correct: Number(summary.sectionWise.REAP && summary.sectionWise.REAP.correct || 0),
            wrong: Number(summary.sectionWise.REAP && summary.sectionWise.REAP.wrong || 0),
            skipped: Number(summary.sectionWise.REAP && summary.sectionWise.REAP.skipped || 0),
          },
        };
      }
      if (attempt.resultSnapshot) {
        attempt.resultSnapshot.result = clone(attempt.result);
      }
      saveState();
    }
    return summary;
  }

  async function getAttemptQuestionReview(attemptId, page, limit) {
    var attempt = getAttemptById(attemptId);
    var test = attempt ? getTestById(attempt.testId) : null;
    if (test && test.isPractice) {
        var questions = getQuestionsForTest(test.id);
        page = Number(page || 1);
        limit = Number(limit || 20);
        var offset = (page - 1) * limit;
        var paginated = questions.slice(offset, offset + limit);
        
        var answers = attempt.answers || {};
        var timeSpent = attempt.timeSpent || {};
        
        var reviewQuestions = paginated.map(function(q) {
            var ans = answers[q.id];
            var isCorrect = ans !== undefined && ans !== null && ans !== "" && Number(ans) === Number(q.correctOption);
            var status = (ans === undefined || ans === null || ans === "") ? "skipped" : (isCorrect ? "correct" : "wrong");
            var marks = isCorrect ? (q.marks || 1) : 0;
            var negativeMarks = (!isCorrect && status !== "skipped") ? (q.negativeMarks || 0) : 0;
            
            return Object.assign({}, q, {
                status: status,
                selectedOption: ans !== undefined && ans !== null && ans !== "" ? Number(ans) : null,
                timeSpent: timeSpent[q.id] || 0,
                marks: marks,
                negativeMarks: negativeMarks
            });
        });
        
        return {
            questions: reviewQuestions,
            pagination: { page: page, limit: limit, total: questions.length, pages: Math.ceil(questions.length / limit), hasMore: offset + limit < questions.length }
        };
    }

    var query = "?page=" + encodeURIComponent(String(page || 1)) + "&limit=" + encodeURIComponent(String(limit || 20));
    try {
      var resultPayload = await api("/api/result/" + encodeURIComponent(String(attemptId || "")) + query + "&includeReview=1", { method: "GET" });
      return {
        questions: resultPayload && resultPayload.questions ? resultPayload.questions : [],
        pagination: resultPayload && resultPayload.pagination ? resultPayload.pagination : {
          page: Number(page || 1),
          limit: Number(limit || 20),
          total: 0,
          pages: 1,
          hasMore: false,
        },
      };
    } catch (error) {
      if (error && error.status !== 404) {
        throw error;
      }
      return api("/api/analysis/" + encodeURIComponent(String(attemptId || "")) + "/questions" + query, { method: "GET" });
    }
  }

  // Admin question bank, paginated on the server. Results are merged into the local cache so
  // a bank question can be opened in the editor like an attached one.
  async function listAdminQuestions(params) {
    var query = Object.keys(params || {}).filter(function (key) {
      return params[key] !== undefined && params[key] !== null && params[key] !== "" && params[key] !== "all";
    }).map(function (key) {
      return encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key]));
    }).join("&");
    var res = await api("/api/admin/questions" + (query ? "?" + query : ""), { method: "GET" });
    mergeQuestions(res.questions || []);
    return res;
  }

  function mergeQuestions(list) {
    var byId = {};
    (state.db.questions || []).forEach(function (q, index) { byId[q.id] = index; });
    (list || []).forEach(function (q) {
      if (byId[q.id] !== undefined) state.db.questions[byId[q.id]] = q;
      else {
        byId[q.id] = state.db.questions.length;
        state.db.questions.push(q);
      }
    });
  }

  /** Full backup: tests plus every question in the bank (fetched page by page). */
  async function exportData() {
    var all = [];
    for (var page = 1; page <= 1000; page += 1) {
      var res = await api("/api/admin/questions?limit=100&page=" + page, { method: "GET" });
      all = all.concat(res.questions || []);
      if (page >= (res.pages || 1)) break;
    }
    var tests = (state.db.tests || []).filter(function (t) { return t && !t.isPractice; });
    return JSON.stringify({ tests: tests, questions: all }, null, 2);
  }

  function importData() {
    throw new Error("Import is not supported in API mode.");
  }

  async function verifyUserPayment(userId) {
    var res = await api("/api/admin/users/" + encodeURIComponent(String(userId)) + "/verify-payment", { method: "POST" });
    await refreshFromRemote();
    return res;
  }

  async function revokeUserPayment(userId) {
    var res = await api("/api/admin/users/" + encodeURIComponent(String(userId)) + "/revoke-payment", { method: "POST" });
    await refreshFromRemote();
    return res;
  }

  async function listPayments(params) {
    var q = new URLSearchParams(params || {}).toString();
    return api("/api/admin/payments" + (q ? "?" + q : ""), { method: "GET" });
  }

  async function createPayment(input) {
    return api("/api/admin/payments", { method: "POST", body: JSON.stringify(input || {}) });
  }

  async function verifyPaymentNew(paymentId, sendEmail) {
    var res = await api("/api/admin/payments/" + encodeURIComponent(String(paymentId)) + "/verify", {
      method: "POST",
      body: JSON.stringify({ sendEmail: sendEmail !== false }),
    });
    await refreshFromRemote();
    return res;
  }

  async function revokePaymentNew(paymentId) {
    var res = await api("/api/admin/payments/" + encodeURIComponent(String(paymentId)) + "/revoke", { method: "POST" });
    await refreshFromRemote();
    return res;
  }

  async function resendPaymentEmail(paymentId) {
    return api("/api/admin/payments/" + encodeURIComponent(String(paymentId)) + "/resend-email", { method: "POST" });
  }

  async function resendReminderEmail(reminderId) {
    return api("/api/reminders/" + encodeURIComponent(String(reminderId)) + "/resend", { method: "POST" });
  }

  async function listUsersExtended(params) {
    var q = new URLSearchParams(params || {}).toString();
    return api("/api/admin/users-list" + (q ? "?" + q : ""), { method: "GET" });
  }

  async function getUserDetailsExtended(userId) {
    return api("/api/admin/users/" + encodeURIComponent(String(userId)) + "/details", { method: "GET" });
  }

  async function listSeasons() {
    return api("/api/admin/seasons", { method: "GET" });
  }

  async function createSeason(data) {
    return api("/api/admin/seasons", { method: "POST", body: JSON.stringify(data || {}) });
  }

  async function activateSeason(seasonId) {
    return api("/api/admin/seasons/" + encodeURIComponent(String(seasonId)) + "/activate", { method: "POST" });
  }

  async function archiveSeason(seasonId) {
    return api("/api/admin/seasons/" + encodeURIComponent(String(seasonId)) + "/archive", { method: "POST" });
  }

  async function duplicateSeason(seasonId, data) {
    return api("/api/admin/seasons/" + encodeURIComponent(String(seasonId)) + "/duplicate", { method: "POST", body: JSON.stringify(data || {}) });
  }

  async function publishTest(testId) {
    var res = await api("/api/admin/test/" + encodeURIComponent(String(testId)) + "/publish", { method: "POST" });
    await refreshFromRemote();
    return res;
  }

  async function getDashboardMetrics() {
    return api("/api/admin/dashboard", { method: "GET" });
  }

  async function getAuditLogs(params) {
    var q = new URLSearchParams(params || {}).toString();
    return api("/api/admin/audit-logs" + (q ? "?" + q : ""), { method: "GET" });
  }

  function getBookmarks(userId) {
    if (!userId) return [];
    return clone(state.db.bookmarks[userId] || []);
  }

  function addBookmark(userId, bookmarkData) {
    if (!userId) return false;
    state.db.bookmarks[userId] = state.db.bookmarks[userId] || [];
    var existingIdx = state.db.bookmarks[userId].findIndex(function(b) { return b.id === bookmarkData.id; });
    if (existingIdx !== -1) return true;
    
    state.db.bookmarks[userId].push(Object.assign({ createdAt: nowIso() }, bookmarkData));
    saveState();
    return true;
  }

  function removeBookmark(userId, questionId) {
    if (!userId) return false;
    if (!state.db.bookmarks[userId]) return false;
    state.db.bookmarks[userId] = state.db.bookmarks[userId].filter(function(b) { return b.id !== questionId; });
    saveState();
    return true;
  }

  function hasBookmark(userId, questionId) {
    if (!userId) return false;
    if (!state.db.bookmarks[userId]) return false;
    return state.db.bookmarks[userId].some(function(b) { return b.id === questionId; });
  }

  function getStudyMaterials() {
    return clone(state.db.studyMaterials);
  }

  function createFolder(name, color, icon) {
    var folder = {
      id: createId("fldr"),
      name: String(name || "New Folder").trim(),
      color: String(color || "var(--brand-accent)"),
      icon: String(icon || "📁"),
      createdAt: nowIso()
    };
    state.db.studyMaterials.folders.push(folder);
    saveState();
    return clone(folder);
  }

  function deleteFolder(folderId) {
    state.db.studyMaterials.folders = state.db.studyMaterials.folders.filter(function(f) { return f.id !== folderId; });
    state.db.studyMaterials.files = state.db.studyMaterials.files.filter(function(f) { return f.folderId !== folderId; });
    saveState();
  }

  function uploadMaterial(folderId, fileData) {
    var file = {
      id: createId("file"),
      folderId: String(folderId),
      name: String(fileData.name || "Untitled"),
      size: String(fileData.size || "Unknown"),
      url: String(fileData.url || ""),
      createdAt: nowIso()
    };
    state.db.studyMaterials.files.push(file);
    saveState();
    return clone(file);
  }

  function deleteMaterial(fileId) {
    state.db.studyMaterials.files = state.db.studyMaterials.files.filter(function(f) { return f.id !== fileId; });
    saveState();
  }

  function getPracticeAttemptsCount(userId) {
    return (state.db.attempts || []).filter(function(a) { 
      if (a.userId !== userId) return false;
      var test = getTestById(a.testId);
      return test && test.isPractice;
    }).length;
  }

  /** Server-built practice paper drawn from questions this student can access. */
  async function generatePracticeTest(userId, subject, difficulty, count, timerMinutes) {
    var data = await api("/api/tests/practice", {
      method: "POST",
      body: JSON.stringify({
        subject: subject || "all",
        difficulty: difficulty || "all",
        count: Number(count) || 10,
        timerMinutes: Number(timerMinutes) || 0,
      }),
    });
    var test = Object.assign({}, data.test, { createdBy: userId });
    state.db.tests = (state.db.tests || []).filter(function (t) { return t.id !== test.id; }).concat([test]);
    saveState();
    return test.id;
  }

  window.AceIIIT.__store = {
    init: async function () {
      if (state.session.user) {
        try {
          await refreshFromRemote();
        } catch (_err) {}
      }
      return true;
    },
    getCurrentUser: getCurrentUser,
    refreshFromRemote: refreshFromRemote,
    touchPresence: touchPresence,
    subscribeToRemoteChanges: function () {
      return function () {};
    },
    login: login,
    requestActivation: requestActivation,
    verifyActivationToken: verifyActivationToken,
    completeActivation: completeActivation,
    requestPasswordReset: requestPasswordReset,
    verifyResetToken: verifyResetToken,
    completePasswordReset: completePasswordReset,
    updatePassword: updatePassword,
    googleAuth: googleAuth,
    appleAuth: appleAuth,
    getAuthConfig: getAuthConfig,
    logout: async function () {
      try {
        await api("/api/auth/logout", { method: "POST" });
      } catch (_err) {}
      clearSession();
      return { ok: true };
    },
    getSettings: getSettings,
    updateSettings: updateSettings,
    getTests: getTests,
    getQuestions: getQuestions,
    getTestById: getTestById,
    getQuestionsForTest: getQuestionsForTest,
    getQotd: getQotd,
    getTestQuestionsFromRemote: getTestQuestionsFromRemote,
    ensureTestQuestionsLoaded: ensureTestQuestionsLoaded,
    listUserAttempts: listUserAttempts,
    getAttemptById: getAttemptById,
    getAttemptResult: getAttemptResult,
    getInProgressAttempt: getInProgressAttempt,
    startExam: startExam,
    takeoverExam: takeoverExam,
    ensureExamPaper: ensureExamPaper,
    advanceSection: advanceSection,
    flushAutosave: flushAutosave,
    flushAutosaveOnExit: flushAutosaveOnExit,
    getAutosaveStatus: getAutosaveStatus,
    resolveExpiredAttempt: resolveExpiredAttempt,
    sendIntegrityEvents: sendIntegrityEvents,
    getAttemptIntegrity: getAttemptIntegrity,
    getInterpretation: getInterpretation,
    exportMyData: exportMyData,
    deleteMyAccount: deleteMyAccount,
    logoutAllDevices: logoutAllDevices,
    invalidateAttempt: invalidateAttempt,
    isAttemptPastDeadline: isAttemptPastDeadline,
    serverNow: serverNow,
    discardAttempt: discardAttempt,
    patchAttempt: patchAttempt,
    submitAttempt: submitAttempt,
    markAttemptSubmissionCooldown: function () {
      return null;
    },
    getDashboardSnapshot: getDashboardSnapshot,
    getAdminSnapshot: getAdminSnapshot,
    getAppConfig: getAppConfig,
    listReminders: listReminders,
    createQuestion: createQuestion,
    updateQuestion: updateQuestion,
    deleteQuestion: deleteQuestion,
    createTest: createTest,
    updateTest: updateTest,
    reorderTests: reorderTests,
    deleteTest: deleteTest,
    attachQuestionToTest: attachQuestionToTest,
    detachQuestionFromTest: detachQuestionFromTest,
    attachQuestionsBulk: attachQuestionsBulk,
    detachQuestionsBulk: detachQuestionsBulk,
    reorderTestQuestions: reorderTestQuestions,
    duplicateTest: duplicateTest,
    generateQuestionsRandom: generateQuestionsRandom,
    attachRandomQuestionsToTest: attachRandomQuestionsToTest,
    undoRandomQuestionsAttachment: undoRandomQuestionsAttachment,
    getAdminResults: getAdminResults,
    getAdminTrash: getAdminTrash,
    restoreTrash: restoreTrash,
    purgeTrash: purgeTrash,
    deleteUser: deleteUser,
    verifyUserPayment: verifyUserPayment,
    revokeUserPayment: revokeUserPayment,
    listPayments: listPayments,
    createPayment: createPayment,
    verifyPaymentNew: verifyPaymentNew,
    revokePaymentNew: revokePaymentNew,
    resendPaymentEmail: resendPaymentEmail,
    listUsersExtended: listUsersExtended,
    getUserDetailsExtended: getUserDetailsExtended,
    listSeasons: listSeasons,
    createSeason: createSeason,
    activateSeason: activateSeason,
    archiveSeason: archiveSeason,
    duplicateSeason: duplicateSeason,
    publishTest: publishTest,
    getDashboardMetrics: getDashboardMetrics,
    getAuditLogs: getAuditLogs,
    getAdminLeaderboard: getAdminLeaderboard,
    getAdminTestAnalytics: getAdminTestAnalytics,
    updateAppConfig: updateAppConfig,
    createReminder: createReminder,
    updateReminder: updateReminder,
    deleteReminder: deleteReminder,
    resendReminderEmail: resendReminderEmail,
    uploadQuestionImages: uploadQuestionImages,
    submitQotdAttempt: submitQotdAttempt,
    getAttemptAnalysis: getAttemptAnalysis,
    getAttemptQuestionReview: getAttemptQuestionReview,
    exportData: exportData,
    listAdminQuestions: listAdminQuestions,
    importData: importData,
    isAdmin: isAdmin,
    getCalendarStatus: getCalendarStatus,
    getCalendarConnectUrl: getCalendarConnectUrl,
    toggleCalendarAutoAdd: toggleCalendarAutoAdd,
    disconnectCalendar: disconnectCalendar,
    getBookmarks: getBookmarks,
    addBookmark: addBookmark,
    removeBookmark: removeBookmark,
    hasBookmark: hasBookmark,
    getStudyMaterials: getStudyMaterials,
    createFolder: createFolder,
    deleteFolder: deleteFolder,
    uploadMaterial: uploadMaterial,
    deleteMaterial: deleteMaterial,
    generatePracticeTest: generatePracticeTest,
    getPracticeAttemptsCount: getPracticeAttemptsCount
  };

  // Synchronously hydrate state from localStorage so that app.js initial renderRoute() sees the authenticated user immediately
  loadState();
})();
