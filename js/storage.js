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
    return {
      section: String(source.section || "SUPR").toUpperCase() === "REAP" ? "REAP" : "SUPR",
      topic: String(source.topic || "").trim(),
      difficulty: String(source.difficulty || "medium"),
      prompt: String(source.prompt || "").trim(),
      passage: String(source.passage || ""),
      imageUrls: Array.isArray(source.imageUrls) ? source.imageUrls.slice() : [],
      options: Array.isArray(source.options) ? source.options.map(function (o) { return String(o || ""); }) : [],
      correctOption: toNumber(source.correctOption, 0),
      explanation: String(source.explanation || ""),
      marks: toNumber(source.marks, 4),
      negativeMarks: normalizeNegativeMarks(source.negativeMarks, -1),
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

  async function refreshStudentData() {
    var testsPayload = await api("/api/tests", { method: "GET" });
    var attemptsPayload = await api("/api/attempts", { method: "GET" });
    var userId = state.session.user && state.session.user.id;

    var inProgress = (state.db.attempts || []).filter(function (a) {
      return a && a.status === "in_progress" && a.userId === userId;
    });

    var existingTestsById = (state.db.tests || []).reduce(function (acc, test) {
      if (test && test.id) {
        acc[test.id] = test;
      }
      return acc;
    }, {});

    state.db.tests = (testsPayload.tests || []).map(function (test) {
      return mergeTestData(existingTestsById[test.id], test);
    });
    state.db.questions = Array.isArray(testsPayload.questions) ? clone(testsPayload.questions) : [];
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

    state.db.attempts = inProgress.concat((attemptsPayload.attempts || []).map(function (remote) {
      var mapped = mapRemoteAttempt(remote, userId);
      return mergeAttemptData(existingSubmittedById[mapped.id], mapped);
    }));

    saveState();
    return { changed: true };
  }

  async function refreshAdminData() {
    var snapshot = await api("/api/admin/snapshot", { method: "GET" });
    state.db.adminSnapshot = snapshot;
    state.db.tests = snapshot.tests || [];
    state.db.questions = snapshot.questions || [];
    state.db.questionCache = {};

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

  async function sendOtp(payload) {
    await api("/api/auth/send-otp", {
      method: "POST",
      body: JSON.stringify({ email: normalizeEmail(payload && payload.email) }),
    });
    return { ok: true };
  }

  async function verifyOtp(payload) {
    var data = await api("/api/auth/verify-otp", {
      method: "POST",
      body: JSON.stringify({
        email: normalizeEmail(payload && payload.email),
        otp: String(payload && payload.otp || "").trim(),
        name: payload && payload.name ? String(payload.name) : undefined,
      }),
    });
    state.session.token = String(data.token || "");
    state.session.user = data.user || null;
    saveState();
    await refreshFromRemote();
    return { ok: true, user: clone(state.session.user) };
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

  function getTestById(testId) {
    return clone((state.db.tests || []).find(function (t) { return t.id === testId; }) || null);
  }

  function getQuestionsForTest(testId) {
    var test = (state.db.tests || []).find(function (t) { return t.id === testId; }) || null;
    if (!test) return [];
    var questionIds = Array.isArray(test.questionIds) ? test.questionIds : [];
    var cacheEntry = getQuestionCacheEntry(testId);
    var cachedQuestions = cacheEntry && Array.isArray(cacheEntry.questions) ? cacheEntry.questions : [];
    if (Array.isArray(cachedQuestions) && cachedQuestions.length) {
      if (!questionIds.length) {
        return cachedQuestions.map(clone);
      }
      var cachedMap = cachedQuestions.reduce(function (acc, q) {
        acc[q.id] = q;
        return acc;
      }, {});
      return questionIds.map(function (id) { return cachedMap[id]; }).filter(Boolean).map(clone);
    }
    var questionMap = (state.db.questions || []).reduce(function (acc, q) {
      acc[q.id] = q;
      return acc;
    }, {});
    return questionIds.map(function (id) { return questionMap[id]; }).filter(Boolean).map(clone);
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
    var tests = (state.db.tests || []).filter(function (t) { return t.status === "live"; });
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

  async function createTest(input) {
    var mapped = mapAdminTestPayload(input, null);
    var data = await api("/api/tests", { method: "POST", body: JSON.stringify(mapped) });
    await refreshFromRemote();
    return data.test || null;
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
    var file = arguments.length > 1 ? arguments[1] : null;
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
    if (file) {
      form.append("image", file);
    }
    var data = await apiForm("/api/admin/questions", "POST", form);
    if (testId && data && data.question && data.question.id) {
      await api("/api/admin/attach", { method: "POST", body: JSON.stringify({ testId: testId, questionId: data.question.id }) });
    }
    await refreshFromRemote();
    return data.question || null;
  }

  async function updateQuestion(questionId, input) {
    var testId = input && input.testId ? String(input.testId) : "";
    var file = arguments.length > 2 ? arguments[2] : null;
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
    if (file) {
      form.append("image", file);
    }
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

  async function getAttemptAnalysis(attemptId) {
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

  window.AceIIIT.__store = {
    init: async function () {
      loadState();
      if (state.session.token && state.session.user) {
        try {
          await refreshFromRemote();
        } catch (_err) {}
      }
      return true;
    },
    getCurrentUser: getCurrentUser,
    refreshFromRemote: refreshFromRemote,
    subscribeToRemoteChanges: function () {
      return function () {};
    },
    sendOtp: sendOtp,
    verifyOtp: verifyOtp,
    logout: function () {
      clearSession();
      return { ok: true };
    },
    getSettings: getSettings,
    updateSettings: updateSettings,
    getTests: getTests,
    getQuestions: getQuestions,
    getTestById: getTestById,
    getQuestionsForTest: getQuestionsForTest,
    getTestQuestionsFromRemote: getTestQuestionsFromRemote,
    ensureTestQuestionsLoaded: ensureTestQuestionsLoaded,
    listUserAttempts: listUserAttempts,
    getAttemptById: getAttemptById,
    getAttemptResult: getAttemptResult,
    getInProgressAttempt: getInProgressAttempt,
    createAttempt: createAttempt,
    getOrCreateAttempt: getOrCreateAttempt,
    patchAttempt: patchAttempt,
    submitAttempt: submitAttempt,
    markAttemptSubmissionCooldown: function () {
      return null;
    },
    getDashboardSnapshot: getDashboardSnapshot,
    getAdminSnapshot: getAdminSnapshot,
    createQuestion: createQuestion,
    updateQuestion: updateQuestion,
    deleteQuestion: deleteQuestion,
    createTest: createTest,
    updateTest: updateTest,
    reorderTests: reorderTests,
    deleteTest: deleteTest,
    attachQuestionToTest: attachQuestionToTest,
    detachQuestionFromTest: detachQuestionFromTest,
    getAdminResults: getAdminResults,
    getAdminTrash: getAdminTrash,
    restoreTrash: restoreTrash,
    purgeTrash: purgeTrash,
    deleteUser: deleteUser,
    getAdminLeaderboard: getAdminLeaderboard,
    getAdminTestAnalytics: getAdminTestAnalytics,
    getAttemptAnalysis: getAttemptAnalysis,
    getAttemptQuestionReview: getAttemptQuestionReview,
    exportData: exportData,
    importData: importData,
    isAdmin: isAdmin,
  };
})();
