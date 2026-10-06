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
    session: {
      token: "",
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
    state.session = Object.assign(state.session, loadJson(SESSION_KEY, {}));
    state.session.token = String(state.session.token || "");
    state.session.user = state.session.user || null;
  }

  function saveState() {
    saveJson(LOCAL_DB_KEY, state.db);
    saveJson(SESSION_KEY, state.session);
  }

  function clearSession() {
    state.session = { token: "", user: null };
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

  async function api(path, options) {
    var headers = Object.assign({ "Content-Type": "application/json" }, (options && options.headers) || {});
    if (state.session.token) {
      headers.Authorization = "Bearer " + state.session.token;
    }
    var response = await fetch(path, Object.assign({}, options || {}, { headers: headers }));
    var text = await response.text();
    var data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_err) {
      data = null;
    }
    if (!response.ok) {
      if (response.status === 401) {
        // Session likely expired or JWT secret changed; force re-login.
        clearSession();
      }
      var message = (data && data.error) || ("Request failed (" + response.status + ")");
      var error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async function apiForm(path, method, formData) {
    var headers = {};
    if (state.session.token) {
      headers.Authorization = "Bearer " + state.session.token;
    }
    var response = await fetch(path, { method: method, headers: headers, body: formData });
    var text = await response.text();
    var data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_err) {
      data = null;
    }
    if (!response.ok) {
      if (response.status === 401) {
        clearSession();
      }
      var message = (data && data.error) || ("Request failed (" + response.status + ")");
      var error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function mapRemoteAttempt(remote, userId) {
    var result = {
      score: remote.score,
      accuracy: remote.accuracy,
      rank: remote.rank,
      percentile: remote.percentile,
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
    var userId = state.session.user && state.session.user.id;

    var inProgressOrPractice = (state.db.attempts || []).filter(function (a) {
      if (!a) return false;
      var isPractice = a.testId && String(a.testId).indexOf("practice_") === 0;
      return (a.status === "in_progress" || isPractice) && a.userId === userId;
    });

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

  async function refreshAdminData() {
    var snapshot = await api("/api/admin/snapshot", { method: "GET" });
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
    if (!state.session.token || !state.session.user) {
      return { changed: false };
    }
    try {
      var me = await api("/api/auth/me", { method: "GET" });
      if (me && me.user) {
        state.session.user = me.user;
        saveState();
      }
    } catch (_err) {}
    if (!state.session.token || !state.session.user) {
      return { changed: false };
    }
    return isAdmin(state.session.user) ? refreshAdminData() : refreshStudentData();
  }

  async function touchPresence() {
    if (!state.session.token || !state.session.user) {
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
    state.session.token = String(data.token || "");
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
    state.session.token = String(data.token || "");
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
    state.session.token = String(data.token || "");
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
    state.session.token = String(data.token || "");
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

  async function sendOtp(payload) {
    return requestActivation(payload);
  }

  async function verifyOtp(payload) {
    if (payload && payload.password) {
      return login(payload);
    }
    return requestActivation(payload);
  }

  async function getCalendarStatus() {
    var response = await fetch("/api/calendar/google/status", {
      headers: { "Authorization": "Bearer " + state.session.token }
    });
    if (!response.ok) return { status: "disconnected", autoAddEnabled: false };
    return await response.json();
  }

  async function getCalendarConnectUrl() {
    return api("/api/calendar/google/connect", { method: "GET" });
  }

  async function toggleCalendarAutoAdd(enabled) {
    var response = await fetch("/api/calendar/google/auto-add", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + state.session.token
      },
      body: JSON.stringify({ enabled: enabled })
    });
    if (!response.ok) throw new Error("Failed to toggle auto-add");
    return await response.json();
  }

  async function disconnectCalendar() {
    var response = await fetch("/api/calendar/google/disconnect", {
      method: "POST",
      headers: { "Authorization": "Bearer " + state.session.token }
    });
    if (!response.ok) throw new Error("Failed to disconnect calendar");
    return await response.json();
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

  function getInProgressAttempt(userId, testId) {
    var attempt = (state.db.attempts || []).find(function (a) {
      return a.userId === userId && a.testId === testId && a.status === "in_progress";
    }) || null;
    return attempt ? clone(attempt) : null;
  }

  function buildSectionTimers(test, startedAt) {
    return {
      SUPR: {
        startedAt: startedAt,
        durationMinutes: test.sectionDurations && test.sectionDurations.SUPR || 60,
        locked: false,
        completedAt: null,
      },
      REAP: {
        startedAt: null,
        durationMinutes: test.sectionDurations && test.sectionDurations.REAP || 120,
        locked: true,
        completedAt: null,
      },
    };
  }

  function createAttempt(userId, testId) {
    var test = (state.db.tests || []).find(function (t) { return t.id === testId; }) || null;
    var questions = test ? getQuestionsForTest(testId) : [];
    var firstQuestion = questions.find(function (q) { return q.section === "SUPR"; }) || questions[0] || null;
    if (!test || !firstQuestion) return null;

    var startedAt = nowIso();
    var attempt = {
      id: createId("attempt"),
      userId: userId,
      testId: testId,
      status: "in_progress",
      startedAt: startedAt,
      updatedAt: startedAt,
      submittedAt: null,
      activeSection: "SUPR",
      currentQuestionId: firstQuestion.id,
      currentSection: "SUPR",
      answers: {},
      visited: {},
      marked: {},
      timeSpent: {},
      lastActiveAt: startedAt,
      sectionTimers: buildSectionTimers(test, startedAt),
      result: null,
      resultSnapshot: null,
    };
    state.db.attempts = (state.db.attempts || []).concat([attempt]);
    saveState();
    return clone(attempt);
  }

  function getOrCreateAttempt(userId, testId) {
    return getInProgressAttempt(userId, testId) || createAttempt(userId, testId);
  }

  function discardAttempt(attemptId) {
    var targetId = String(attemptId || "");
    state.db.attempts = (state.db.attempts || []).filter(function (attempt) {
      return String(attempt && attempt.id || "") !== targetId;
    });
    saveState();
    return { ok: true };
  }

  function patchAttempt(attemptId, updater) {
    var attempts = state.db.attempts || [];
    var index = attempts.findIndex(function (a) { return a.id === attemptId; });
    if (index === -1) return null;
    var draft = clone(attempts[index]);
    updater(draft, state.db);
    draft.updatedAt = nowIso();
    draft.lastActiveAt = draft.updatedAt;
    attempts[index] = draft;
    state.db.attempts = attempts;
    saveState();
    return clone(draft);
  }

  async function submitAttempt(attemptId) {
    var attempts = state.db.attempts || [];
    var index = attempts.findIndex(function (a) { return a.id === attemptId; });
    if (index === -1) return null;
    var localAttempt = clone(attempts[index]);
    if (localAttempt.status === "submitted") return clone(localAttempt);

    var startedAtMs = new Date(localAttempt.startedAt).getTime();
    var timeTakenSeconds = startedAtMs ? Math.max(0, Math.round((Date.now() - startedAtMs) / 1000)) : 0;

    var test = getTestById(localAttempt.testId);
    if (test && test.isPractice) {
      var questions = getQuestionsForTest(test.id);
      var answers = localAttempt.answers || {};
      var correctCount = 0;
      var wrongCount = 0;
      var skippedCount = 0;
      var score = 0;
      
      questions.forEach(function(q) {
        var ans = answers[q.id];
        if (ans === undefined || ans === null || ans === "") {
          skippedCount++;
        } else {
          if (Number(ans) === Number(q.correctOption)) {
            correctCount++;
            score += Number(q.marks || 1);
          } else {
            wrongCount++;
            score -= Number(q.negativeMarks || 0);
          }
        }
      });

      var accuracy = (correctCount + wrongCount) > 0 ? Math.round((correctCount / (correctCount + wrongCount)) * 100) : 0;
      
      var localSubmittedAt = nowIso();
      var localResult = {
        score: score,
        accuracy: accuracy,
        rank: 1,
        percentile: 100,
        correctCount: correctCount,
        wrongCount: wrongCount,
        skippedCount: skippedCount,
        unattemptedCount: skippedCount,
        timeTakenSeconds: timeTakenSeconds,
        totalTime: timeTakenSeconds,
        sectionScores: null,
        analysis: null
      };
      
      localAttempt.status = "submitted";
      localAttempt.submittedAt = localSubmittedAt;
      localAttempt.updatedAt = localSubmittedAt;
      localAttempt.lastActiveAt = localSubmittedAt;
      localAttempt.result = localResult;
      localAttempt.resultSnapshot = {
        savedAt: localSubmittedAt,
        testTitle: test.title,
        testSubtitle: test.subtitle || "",
        startedAt: localAttempt.startedAt,
        submittedAt: localAttempt.submittedAt,
        result: localResult,
      };

      attempts.splice(index, 1, localAttempt);
      state.db.attempts = attempts;
      saveState();

      return clone(localAttempt);
    }

    var response = await api("/api/attempt", {
      method: "POST",
      body: JSON.stringify({
        testId: localAttempt.testId,
        answers: localAttempt.answers || {},
        timeSpent: localAttempt.timeSpent || {},
        timeTakenSeconds: timeTakenSeconds,
      }),
    });

    var remote = response.attempt;
    var submittedAt = remote.submittedAt || nowIso();
    var result = {
      score: remote.score,
      accuracy: remote.accuracy,
      rank: remote.rank,
      percentile: remote.percentile,
      correctCount: remote.correctCount,
      wrongCount: remote.wrongCount,
      skippedCount: remote.skippedCount,
      unattemptedCount: remote.unattemptedCount !== undefined ? remote.unattemptedCount : remote.skippedCount,
      timeTakenSeconds: remote.timeTakenSeconds,
      totalTime: remote.totalTime !== undefined ? remote.totalTime : remote.timeTakenSeconds,
      sectionScores: remote.sectionScores || null,
      analysis: remote.analysis || null,
    };

    localAttempt.id = remote.id;
    localAttempt.status = "submitted";
    localAttempt.submittedAt = submittedAt;
    localAttempt.updatedAt = nowIso();
    localAttempt.lastActiveAt = submittedAt;
    localAttempt.result = result;
    localAttempt.resultSnapshot = {
      savedAt: nowIso(),
      testTitle: (getTestById(localAttempt.testId) || {}).title || localAttempt.testId,
      testSubtitle: (getTestById(localAttempt.testId) || {}).subtitle || "",
      startedAt: localAttempt.startedAt,
      submittedAt: localAttempt.submittedAt,
      result: result,
    };

    attempts.splice(index, 1, localAttempt);
    state.db.attempts = attempts;
    saveState();

    return clone(localAttempt);
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
    if (res.lastQotdAttempt) {
      state.session.user.lastQotdAttempt = res.lastQotdAttempt;
      saveState();
    }
    return res;
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
    var attempt = (state.db.attempts || []).find(function (item) { return item.id === attemptId; });
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

  function exportData() {
    return JSON.stringify({ tests: state.db.tests || [], questions: state.db.questions || [] }, null, 2);
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

  async function syncPaidSheets() {
    var res = await api("/api/admin/sync-sheets", { method: "POST" });
    await refreshFromRemote();
    return res;
  }

  async function listPayments(params) {
    var q = new URLSearchParams(params || {}).toString();
    return api("/api/admin/payments" + (q ? "?" + q : ""), { method: "GET" });
  }

  async function syncPaymentsNew(seasonId) {
    var res = await api("/api/admin/payments/sync", { method: "POST", body: JSON.stringify({ seasonId: seasonId }) });
    await refreshFromRemote();
    return res;
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

  function generatePracticeTest(userId, subject, difficulty, count, timerMinutes) {
    var allQs = getQuestions();
    
    var filtered = allQs.filter(function(q) {
      var matchSub = subject === "all" || q.section === subject || (q.topic && q.topic.indexOf(subject) !== -1);
      var matchDiff = difficulty === "all" || q.difficulty === difficulty;
      return matchSub && matchDiff;
    });

    for (var i = filtered.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var temp = filtered[i];
      filtered[i] = filtered[j];
      filtered[j] = temp;
    }

    var selected = filtered.slice(0, count);

    var testId = "practice_" + Date.now();
    var duration = Number(timerMinutes) || 0;
    
    var practiceTest = {
      id: testId,
      title: "Practice: " + (subject === "all" ? "Mixed Subjects" : subject),
      subtitle: selected.length + " Questions • " + (duration > 0 ? duration + " Mins" : "Untimed"),
      isPractice: true,
      isFree: true,
      status: "live",
      createdBy: userId,
      questionIds: selected.map(function(q) { return q.id; }),
      questionCount: selected.length,
      sectionDurations: { SUPR: duration, REAP: duration },
      createdAt: nowIso()
    };

    if (!state.db.tests) state.db.tests = [];
    state.db.tests.push(practiceTest);
    saveState();
    return testId;
  }

  window.AceIIIT.__store = {
    init: async function () {
      if (state.session.token && state.session.user) {
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
    sendOtp: sendOtp,
    verifyOtp: verifyOtp,
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
    createAttempt: createAttempt,
    getOrCreateAttempt: getOrCreateAttempt,
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
    syncPaidSheets: syncPaidSheets,
    listPayments: listPayments,
    syncPaymentsNew: syncPaymentsNew,
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
    resendPaymentEmail: resendPaymentEmail,
    uploadQuestionImages: uploadQuestionImages,
    submitQotdAttempt: submitQotdAttempt,
    getAttemptAnalysis: getAttemptAnalysis,
    getAttemptQuestionReview: getAttemptQuestionReview,
    exportData: exportData,
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
