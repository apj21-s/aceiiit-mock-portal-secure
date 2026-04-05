(function () {
  window.AceIIIT = window.AceIIIT || {};

  var DB_KEY = "aceiiit.secure.portal.db.v1";
  var SESSION_KEY = "aceiiit.secure.portal.session.v1";
  var seed = window.AceIIIT.seed;
  var analytics = window.AceIIIT.analytics;
  var firebaseBridge = window.AceIIIT.firebase;
  var remoteSyncListeners = [];
  var remoteSyncUnsubscribe = null;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function fireAndForget(promise) {
    if (promise && typeof promise.catch === "function") {
      promise.catch(function () {});
    }
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function createId(prefix) {
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function toNumber(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function normalizeNegativeMarks(value, fallback) {
    var parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }

    if (parsed === 0) {
      return 0;
    }

    return -Math.abs(parsed);
  }

  function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
  }

  function normalizeAllowedEmails(list) {
    return (Array.isArray(list) ? list : [])
      .map(normalizeEmail)
      .filter(Boolean)
      .filter(function (email, index, items) {
        return items.indexOf(email) === index;
      });
  }

  function isAllowedEmail(settings, email) {
    if (!settings || !settings.allowlistEnabled) {
      return true;
    }

    return normalizeAllowedEmails(settings.allowedEmails).indexOf(normalizeEmail(email)) !== -1;
  }

  function hashPassword(password) {
    var hash = 2166136261;
    var text = String(password || "");

    for (var index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }

    return ("00000000" + (hash >>> 0).toString(16)).slice(-8);
  }

  function createAdminUser() {
    return {
      id: "admin-seed",
      name: "AceIIIT Admin",
      email: seed.meta.adminEmail,
      phone: "",
      role: "admin",
      passwordHash: hashPassword(seed.meta.adminPassword),
      createdAt: nowIso()
    };
  }

  function normalizeTestStatus(value) {
    return value === "live" ? "live" : "draft";
  }

  function normalizeTest(test) {
    var normalized = clone(test);
    var sectionDurations = normalized.sectionDurations || {};

    normalized.sectionDurations = {
      SUPR: toNumber(sectionDurations.SUPR, 60),
      REAP: toNumber(sectionDurations.REAP, 120)
    };
    normalized.durationMinutes = toNumber(
      normalized.durationMinutes,
      normalized.sectionDurations.SUPR + normalized.sectionDurations.REAP
    );
    normalized.questionIds = Array.isArray(normalized.questionIds) ? normalized.questionIds : [];
    normalized.instructions = Array.isArray(normalized.instructions) ? normalized.instructions : [];
    normalized.benchmarkScores = Array.isArray(normalized.benchmarkScores) ? normalized.benchmarkScores : [];
    normalized.status = normalizeTestStatus(normalized.status);
    normalized.createdAt = normalized.createdAt || nowIso();
    normalized.updatedAt = normalized.updatedAt || normalized.createdAt;

    return normalized;
  }

  function normalizeQuestion(question) {
    var normalized = clone(question);
    normalized.passage = normalized.passage || "";
    normalized.imageUrls = Array.isArray(normalized.imageUrls)
      ? normalized.imageUrls.map(function (item) { return String(item || "").trim(); }).filter(Boolean)
      : (normalized.imageUrl ? [String(normalized.imageUrl).trim()] : []);
    normalized.imageUrl = normalized.imageUrls[0] || "";
    normalized.options = Array.isArray(normalized.options) ? normalized.options : [];
    normalized.marks = toNumber(normalized.marks, 4);
    normalized.negativeMarks = normalizeNegativeMarks(normalized.negativeMarks, -1);
    return normalized;
  }

  function buildSectionTimers(test, startedAt) {
    return {
      SUPR: {
        startedAt: startedAt,
        durationMinutes: test.sectionDurations.SUPR,
        locked: false,
        completedAt: null
      },
      REAP: {
        startedAt: null,
        durationMinutes: test.sectionDurations.REAP,
        locked: true,
        completedAt: null
      }
    };
  }

  function normalizeAttempt(attempt, test, questions) {
    var normalized = clone(attempt);
    var suprQuestions = questions.filter(function (question) {
      return question.section === "SUPR";
    });
    var reapQuestions = questions.filter(function (question) {
      return question.section === "REAP";
    });
    var firstSuprQuestion = suprQuestions[0] || questions[0] || null;
    var firstReapQuestion = reapQuestions[0] || questions[0] || null;

    normalized.answers = normalized.answers || {};
    normalized.visited = normalized.visited || {};
    normalized.marked = normalized.marked || {};
    normalized.timeSpent = normalized.timeSpent || {};
    normalized.activeSection = normalized.activeSection || normalized.currentSection || "SUPR";
    normalized.sectionTimers = normalized.sectionTimers || buildSectionTimers(test, normalized.startedAt || nowIso());
    normalized.sectionTimers.SUPR.durationMinutes = toNumber(normalized.sectionTimers.SUPR.durationMinutes, test.sectionDurations.SUPR);
    normalized.sectionTimers.REAP.durationMinutes = toNumber(normalized.sectionTimers.REAP.durationMinutes, test.sectionDurations.REAP);
    normalized.currentQuestionId = normalized.currentQuestionId ||
      (normalized.activeSection === "REAP" ? (firstReapQuestion && firstReapQuestion.id) : (firstSuprQuestion && firstSuprQuestion.id));

    if (normalized.activeSection === "REAP") {
      normalized.sectionTimers.SUPR.locked = true;
      normalized.sectionTimers.REAP.locked = false;
      normalized.sectionTimers.REAP.startedAt = normalized.sectionTimers.REAP.startedAt || normalized.updatedAt || nowIso();
      normalized.currentQuestionId = normalized.currentQuestionId || (firstReapQuestion && firstReapQuestion.id);
    }

    return normalized;
  }

  function buildInitialDb() {
    return {
      meta: {
        version: seed.meta.version,
        createdAt: nowIso(),
        updatedAt: nowIso()
      },
      settings: {
        studentAccessCode: seed.meta.studentAccessCode,
        firebaseConfig: null,
        allowlistEnabled: false,
        allowedEmails: [],
        allowlistSheetUrl: ""
      },
      users: [createAdminUser()],
      tests: seed.tests.map(normalizeTest),
      questions: seed.questions.map(normalizeQuestion),
      attempts: [],
      loginEvents: [],
      deletedQuestions: [],
      deletedTests: [],
      deletedUsers: []
    };
  }

  function migrateDb(db) {
    var migrated = clone(db);

    migrated.meta = migrated.meta || {};
    migrated.meta.version = seed.meta.version;
    migrated.meta.createdAt = migrated.meta.createdAt || nowIso();
    migrated.meta.updatedAt = migrated.meta.updatedAt || nowIso();
    migrated.settings = migrated.settings || {};
    migrated.settings.studentAccessCode = migrated.settings.studentAccessCode || seed.meta.studentAccessCode;
    migrated.settings.firebaseConfig = migrated.settings.firebaseConfig || null;
    migrated.settings.allowlistEnabled = !!migrated.settings.allowlistEnabled;
    migrated.settings.allowedEmails = normalizeAllowedEmails(migrated.settings.allowedEmails || []);
    migrated.settings.allowlistSheetUrl = String(migrated.settings.allowlistSheetUrl || "").trim();
    migrated.users = Array.isArray(migrated.users) ? migrated.users : [];
    migrated.tests = (Array.isArray(migrated.tests) ? migrated.tests : []).map(normalizeTest);
    migrated.questions = (Array.isArray(migrated.questions) ? migrated.questions : []).map(normalizeQuestion);
    migrated.attempts = Array.isArray(migrated.attempts) ? migrated.attempts : [];
    migrated.loginEvents = Array.isArray(migrated.loginEvents) ? migrated.loginEvents : [];
    migrated.deletedQuestions = (Array.isArray(migrated.deletedQuestions) ? migrated.deletedQuestions : []).map(normalizeQuestion);
    migrated.deletedTests = (Array.isArray(migrated.deletedTests) ? migrated.deletedTests : []).map(normalizeTest);
    migrated.deletedUsers = Array.isArray(migrated.deletedUsers) ? migrated.deletedUsers : [];

    if (!migrated.users.some(function (user) { return user.email === seed.meta.adminEmail; })) {
      migrated.users.push(createAdminUser());
    }

    migrated.attempts = migrated.attempts.map(function (attempt) {
      var test = migrated.tests.find(function (item) {
        return item.id === attempt.testId;
      });
      var questions = test
        ? test.questionIds.map(function (questionId) {
            return migrated.questions.find(function (question) {
              return question.id === questionId;
            });
          }).filter(Boolean)
        : [];
      return test ? normalizeAttempt(attempt, test, questions) : attempt;
    });

    return migrated;
  }

  function loadDb() {
    var raw = localStorage.getItem(DB_KEY);
    if (!raw) {
      var initial = buildInitialDb();
      saveDb(initial);
      return initial;
    }

    try {
      var parsed = migrateDb(JSON.parse(raw));
      saveDb(parsed);
      return parsed;
    } catch (error) {
      var reset = buildInitialDb();
      saveDb(reset);
      return reset;
    }
  }

  function saveDb(db) {
    db.meta.updatedAt = nowIso();
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  }

  function getLastRemoteMarker(db) {
    return db && db.meta ? String(db.meta.lastRemoteMarker || "") : "";
  }

  function setLastRemoteMarker(db, marker) {
    db.meta = db.meta || {};
    db.meta.lastRemoteMarker = String(marker || "");
  }

  function notifyRemoteSync(payload) {
    remoteSyncListeners.slice().forEach(function (listener) {
      try {
        listener(payload || {});
      } catch (error) {}
    });
  }

  function getRemoteDb() {
    return firebaseBridge && firebaseBridge.getFirestore ? firebaseBridge.getFirestore() : null;
  }

  function syncDoc(collectionName, docId, data) {
    var remoteDb = getRemoteDb();
    if (!remoteDb) {
      return Promise.resolve();
    }

    return remoteDb.collection(collectionName).doc(docId).set(clone(data), { merge: true });
  }

  function deleteRemoteDoc(collectionName, docId) {
    var remoteDb = getRemoteDb();
    if (!remoteDb) {
      return Promise.resolve();
    }

    return remoteDb.collection(collectionName).doc(docId).delete();
  }

  function syncSettings(settings) {
    return syncDoc("portal_meta", "settings", settings);
  }

  function syncBackupMetaFromDb(db) {
    return syncDoc("portal_meta", "backupMeta", {
      updatedAt: nowIso(),
      collections: {
        users: (db.users || []).length,
        tests: (db.tests || []).length,
        questions: (db.questions || []).length,
        attempts: (db.attempts || []).length,
        loginEvents: (db.loginEvents || []).length,
        deletedQuestions: (db.deletedQuestions || []).length,
        deletedTests: (db.deletedTests || []).length,
        deletedUsers: (db.deletedUsers || []).length
      }
    });
  }

  function syncAllToRemote(db) {
    var remoteDb = getRemoteDb();
    if (!remoteDb) {
      return Promise.resolve(false);
    }

    var jobs = [];
    jobs.push(syncSettings(db.settings || {}));
    jobs.push(syncBackupMetaFromDb(db));

    (db.users || []).forEach(function (user) {
      jobs.push(syncDoc("users", user.id, user));
    });
    (db.tests || []).forEach(function (test) {
      jobs.push(syncDoc("tests", test.id, test));
    });
    (db.questions || []).forEach(function (question) {
      jobs.push(syncDoc("questions", question.id, question));
    });
    (db.attempts || []).forEach(function (attempt) {
      jobs.push(syncDoc("attempts", attempt.id, attempt));
    });
    (db.loginEvents || []).forEach(function (event) {
      jobs.push(syncDoc("loginEvents", event.id, event));
    });
    (db.deletedQuestions || []).forEach(function (question) {
      jobs.push(syncDoc("deletedQuestions", question.id, question));
    });
    (db.deletedTests || []).forEach(function (test) {
      jobs.push(syncDoc("deletedTests", test.id, test));
    });
    (db.deletedUsers || []).forEach(function (user) {
      jobs.push(syncDoc("deletedUsers", user.id, user));
    });

    return Promise.all(jobs).then(function () {
      return true;
    }).catch(function () {
      return false;
    });
  }

  function syncFromRemote() {
    var remoteDb = getRemoteDb();
    if (!remoteDb) {
      return Promise.resolve({ ok: false, hasRemoteData: false });
    }

    var db = loadDb();
    return remoteDb.collection("portal_meta").doc("backupMeta").get().then(function (backupMetaDoc) {
      var marker = backupMetaDoc.exists ? String((backupMetaDoc.data() || {}).updatedAt || "") : "";
      if (marker && marker === getLastRemoteMarker(db)) {
        return { ok: true, hasRemoteData: true, changed: false };
      }

      return Promise.all([
      backupMetaDoc,
      remoteDb.collection("portal_meta").doc("settings").get(),
      remoteDb.collection("users").get(),
      remoteDb.collection("tests").get(),
      remoteDb.collection("questions").get(),
      remoteDb.collection("attempts").get(),
      remoteDb.collection("loginEvents").get(),
      remoteDb.collection("deletedQuestions").get(),
      remoteDb.collection("deletedTests").get(),
      remoteDb.collection("deletedUsers").get()
    ]).then(function (results) {
      var backupMetaSnap = results[0];
      var settingsDoc = results[1];
      var usersSnap = results[2];
      var testsSnap = results[3];
      var questionsSnap = results[4];
      var attemptsSnap = results[5];
      var loginSnap = results[6];
      var deletedQuestionsSnap = results[7];
      var deletedTestsSnap = results[8];
      var deletedUsersSnap = results[9];
      var db = loadDb();
      var hasRemoteData = settingsDoc.exists ||
        !usersSnap.empty ||
        !testsSnap.empty ||
        !questionsSnap.empty ||
        !attemptsSnap.empty ||
        !loginSnap.empty ||
        !deletedQuestionsSnap.empty ||
        !deletedTestsSnap.empty ||
        !deletedUsersSnap.empty;

      if (settingsDoc.exists) {
        db.settings = Object.assign({}, db.settings, settingsDoc.data() || {});
      }

      function mergeCollection(currentItems, snapshot, normalizer) {
        var map = {};
        currentItems.forEach(function (item) {
          map[item.id] = item;
        });
        snapshot.forEach(function (doc) {
          var data = doc.data() || {};
          data.id = data.id || doc.id;
          map[data.id] = normalizer ? normalizer(data) : data;
        });
        return Object.keys(map).map(function (key) {
          return map[key];
        });
      }

      db.users = mergeCollection(db.users, usersSnap);
      db.tests = mergeCollection(db.tests, testsSnap, normalizeTest);
      db.questions = mergeCollection(db.questions, questionsSnap, normalizeQuestion);
      db.attempts = mergeCollection(db.attempts, attemptsSnap);
      db.loginEvents = mergeCollection(db.loginEvents || [], loginSnap);
      db.deletedQuestions = mergeCollection(db.deletedQuestions || [], deletedQuestionsSnap, normalizeQuestion);
      db.deletedTests = mergeCollection(db.deletedTests || [], deletedTestsSnap, normalizeTest);
      db.deletedUsers = mergeCollection(db.deletedUsers || [], deletedUsersSnap);
      var deletedQuestionIds = (db.deletedQuestions || []).map(function (item) { return item.id; });
      var deletedTestIds = (db.deletedTests || []).map(function (item) { return item.id; });
      var deletedUserIds = (db.deletedUsers || []).map(function (item) { return item.id; });
      db.questions = (db.questions || []).filter(function (item) {
        return deletedQuestionIds.indexOf(item.id) === -1;
      });
      db.tests = (db.tests || []).filter(function (item) {
        return deletedTestIds.indexOf(item.id) === -1;
      });
      db.users = (db.users || []).filter(function (item) {
        return deletedUserIds.indexOf(item.id) === -1;
      });
      db.attempts = (db.attempts || []).filter(function (attempt) {
        return deletedTestIds.indexOf(attempt.testId) === -1 && deletedUserIds.indexOf(attempt.userId) === -1;
      });
      setLastRemoteMarker(db, backupMetaSnap.exists ? String((backupMetaSnap.data() || {}).updatedAt || "") : marker);
      saveDb(db);
      return { ok: true, hasRemoteData: hasRemoteData, changed: true };
    }).catch(function () {
      return { ok: false, hasRemoteData: false };
    });
    }).catch(function () {
      return { ok: false, hasRemoteData: false };
    });
  }

  function subscribeToRemoteChanges(listener) {
    if (typeof listener === "function") {
      remoteSyncListeners.push(listener);
    }

    if (!remoteSyncUnsubscribe) {
      var remoteDb = getRemoteDb();
      if (remoteDb) {
        remoteSyncUnsubscribe = remoteDb.collection("portal_meta").doc("backupMeta").onSnapshot(function (doc) {
          var marker = doc && doc.exists ? String((doc.data() || {}).updatedAt || "") : "";
          var db = loadDb();
          if (!marker || marker === getLastRemoteMarker(db)) {
            return;
          }

          syncFromRemote().then(function (result) {
            if (result && result.ok) {
              notifyRemoteSync({ type: "remote-update", changed: !!result.changed });
            }
          });
        }, function () {});
      }
    }

    return function () {
      remoteSyncListeners = remoteSyncListeners.filter(function (item) {
        return item !== listener;
      });
    };
  }

  function loadSession() {
    var raw = localStorage.getItem(SESSION_KEY);
    if (!raw) {
      return null;
    }

    try {
      return JSON.parse(raw);
    } catch (error) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
  }

  function saveSession(session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function getUserById(db, userId) {
    return db.users.find(function (item) {
      return item.id === userId;
    }) || null;
  }

  function getCurrentUser() {
    var db = loadDb();
    var session = loadSession();
    if (!session || !session.userId) {
      return null;
    }

    var user = getUserById(db, session.userId);
    return user ? clone(user) : null;
  }

  function buildSession(user) {
    return {
      userId: user.id,
      email: user.email,
      loggedInAt: nowIso()
    };
  }

  function createLoginEvent(db, user) {
    var event = {
      id: createId("login"),
      userId: user.id,
      email: user.email,
      role: user.role,
      loggedInAt: nowIso()
    };
    db.loginEvents.push(event);
    fireAndForget(syncDoc("loginEvents", event.id, event));
    return event;
  }

  function getUserByEmail(db, email) {
    var normalizedEmail = normalizeEmail(email);
    return db.users.find(function (item) {
      return item.email === normalizedEmail;
    }) || null;
  }

  function tryLocalCredentialLogin(db, email, password) {
    var localUser = getUserByEmail(db, email);
    if (!localUser || localUser.passwordHash !== hashPassword(password)) {
      return null;
    }

    saveSession(buildSession(localUser));
    createLoginEvent(db, localUser);
    saveDb(db);
    fireAndForget(syncBackupMetaFromDb(db));
    return { ok: true, user: clone(localUser), fallback: true };
  }

  function ensureUserProfile(db, authUser, payload) {
    var normalizedEmail = normalizeEmail(authUser && authUser.email);
    var existingUser = getUserByEmail(db, normalizedEmail);
    if (existingUser) {
      var previousId = existingUser.id;
      if (existingUser.id !== authUser.uid) {
        existingUser.id = authUser.uid;
        (db.attempts || []).forEach(function (attempt) {
          if (attempt.userId === previousId) {
            attempt.userId = authUser.uid;
          }
        });
        (db.loginEvents || []).forEach(function (event) {
          if (event.userId === previousId) {
            event.userId = authUser.uid;
          }
        });
        (db.deletedUsers || []).forEach(function (user) {
          if (user.id === previousId) {
            user.id = authUser.uid;
          }
        });
        fireAndForget(deleteRemoteDoc("users", previousId));
      }
      existingUser.firebaseUid = existingUser.firebaseUid || authUser.uid;
      existingUser.email = normalizedEmail;
      existingUser.passwordHash = existingUser.passwordHash || null;
      existingUser.updatedAt = nowIso();
      return existingUser;
    }

    var nextUser = {
      id: authUser.uid,
      firebaseUid: authUser.uid,
      name: String((payload && payload.name) || authUser.displayName || "").trim() || normalizedEmail.split("@")[0] || "Student",
      email: normalizedEmail,
      phone: String((payload && payload.phone) || "").trim(),
      role: (payload && payload.role) || "student",
      passwordHash: null,
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    db.users.push(nextUser);
    return nextUser;
  }

  async function ensureFirebaseAdminAccount(db, email, password) {
    if (!firebaseBridge || !firebaseBridge.createUser || !firebaseBridge.signIn) {
      return null;
    }

    if (normalizeEmail(email) !== normalizeEmail(seed.meta.adminEmail) || String(password || "") !== String(seed.meta.adminPassword)) {
      return null;
    }

    try {
      return await firebaseBridge.signIn(email, password);
    } catch (signInError) {
      try {
        return await firebaseBridge.createUser(email, password);
      } catch (createError) {
        if (createError && /already|exists/i.test(String(createError.message || ""))) {
          return firebaseBridge.signIn(email, password);
        }
        throw createError;
      }
    }
  }

  async function signUp(payload) {
    var db = loadDb();
    var normalizedEmail = normalizeEmail(payload.email);
    var existingUser = getUserByEmail(db, normalizedEmail);

    if (existingUser) {
      return { ok: false, error: "An account with this email already exists." };
    }

    if (String(payload.accessCode || "").trim() !== String(db.settings.studentAccessCode || "").trim()) {
      return { ok: false, error: "Invalid student access code." };
    }

    if (!isAllowedEmail(db.settings, normalizedEmail)) {
      return { ok: false, error: "This email is not in the verified access list." };
    }

    if (!firebaseBridge || !firebaseBridge.createUser || !firebaseBridge.isConfigured || !firebaseBridge.isConfigured()) {
      return { ok: false, error: "Secure copy needs Firebase config saved first." };
    }

    try {
      var authUser = await firebaseBridge.createUser(normalizedEmail, String(payload.password || ""));
      var user = ensureUserProfile(db, authUser, {
        name: payload.name,
        phone: payload.phone,
        role: "student"
      });
      saveSession(buildSession(user));
      createLoginEvent(db, user);
      saveDb(db);
      fireAndForget(syncDoc("users", user.id, user));
      fireAndForget(syncBackupMetaFromDb(db));
      return { ok: true, user: clone(user) };
    } catch (error) {
      return {
        ok: false,
        error: error && error.message ? error.message : "Sign up failed."
      };
    }
  }

  async function login(payload) {
    var db = loadDb();
    var normalizedEmail = normalizeEmail(payload.email);

    if (!isAllowedEmail(db.settings, normalizedEmail)) {
      return { ok: false, error: "This email is not in the verified access list." };
    }

    if (!firebaseBridge || !firebaseBridge.signIn || !firebaseBridge.isConfigured || !firebaseBridge.isConfigured()) {
      var localFallback = tryLocalCredentialLogin(db, normalizedEmail, payload.password);
      if (!localFallback) {
        return { ok: false, error: "Secure login needs Firebase config saved first." };
      }
      return localFallback;
    }

    try {
      var authUser = await firebaseBridge.signIn(normalizedEmail, String(payload.password || ""));
      var user = ensureUserProfile(db, authUser, {});
      saveSession(buildSession(user));
      createLoginEvent(db, user);
      saveDb(db);
      fireAndForget(syncDoc("users", user.id, user));
      fireAndForget(syncBackupMetaFromDb(db));
      return { ok: true, user: clone(user) };
    } catch (signInError) {
      try {
        var adminAuthUser = await ensureFirebaseAdminAccount(db, normalizedEmail, payload.password);
        if (!adminAuthUser) {
          throw signInError;
        }
        var adminUser = ensureUserProfile(db, adminAuthUser, {
          name: "AceIIIT Admin",
          role: "admin"
        });
        adminUser.role = "admin";
        saveSession(buildSession(adminUser));
        createLoginEvent(db, adminUser);
        saveDb(db);
        fireAndForget(syncDoc("users", adminUser.id, adminUser));
        fireAndForget(syncBackupMetaFromDb(db));
        return { ok: true, user: clone(adminUser) };
      } catch (fallbackError) {
        if (fallbackError && /api-key-not-valid|auth\/invalid-api-key|config|invalid-credential|user-not-found|wrong-password|invalid-login-credentials/i.test(String(fallbackError.message || ""))) {
          var localResult = tryLocalCredentialLogin(db, normalizedEmail, payload.password);
          if (localResult) {
            return localResult;
          }
        }
        return {
          ok: false,
          error: fallbackError && fallbackError.message ? fallbackError.message : "Invalid email or password."
        };
      }
    }
  }

  async function logout() {
    localStorage.removeItem(SESSION_KEY);
    if (firebaseBridge && firebaseBridge.signOut && firebaseBridge.isConfigured && firebaseBridge.isConfigured()) {
      try {
        await firebaseBridge.signOut();
      } catch (error) {}
    }
  }

  function syncSessionFromAuthUser(authUser) {
    var db = loadDb();
    if (!authUser || !authUser.uid || !authUser.email) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }

    var user = ensureUserProfile(db, authUser, {});
    saveDb(db);
    fireAndForget(syncDoc("users", user.id, user));
    fireAndForget(syncBackupMetaFromDb(db));
    saveSession(buildSession(user));
    return clone(user);
  }

  function getTests() {
    return clone(loadDb().tests).sort(function (a, b) {
      if ((a.status || "draft") !== (b.status || "draft")) {
        return (a.status || "draft") === "live" ? -1 : 1;
      }
      return new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt);
    });
  }

  function getQuestions() {
    return clone(loadDb().questions);
  }

  function getSettings() {
    return clone(loadDb().settings);
  }

  function updateSettings(input) {
    var db = loadDb();
    if (input.studentAccessCode !== undefined) {
      db.settings.studentAccessCode = String(input.studentAccessCode).trim();
    }
    if (input.firebaseConfig !== undefined) {
      db.settings.firebaseConfig = input.firebaseConfig || null;
    }
    if (input.allowlistEnabled !== undefined) {
      db.settings.allowlistEnabled = !!input.allowlistEnabled;
    }
    if (input.allowedEmails !== undefined) {
      db.settings.allowedEmails = normalizeAllowedEmails(input.allowedEmails);
    }
    if (input.allowlistSheetUrl !== undefined) {
      db.settings.allowlistSheetUrl = String(input.allowlistSheetUrl || "").trim();
    }
    saveDb(db);
    if (input.firebaseConfig !== undefined && firebaseBridge && firebaseBridge.setConfig) {
      firebaseBridge.setConfig(db.settings.firebaseConfig);
    }
    fireAndForget(syncSettings(db.settings));
    fireAndForget(syncBackupMetaFromDb(db));
    if (input.firebaseConfig !== undefined && db.settings.firebaseConfig) {
      fireAndForget(syncAllToRemote(db));
    }
    return clone(db.settings);
  }

  function getTestById(testId) {
    var test = loadDb().tests.find(function (item) {
      return item.id === testId;
    });
    return test ? clone(test) : null;
  }

  function getQuestionsForTest(testId) {
    var db = loadDb();
    var test = db.tests.find(function (item) {
      return item.id === testId;
    });

    if (!test) {
      return [];
    }

    return test.questionIds.map(function (questionId) {
      return db.questions.find(function (question) {
        return question.id === questionId;
      });
    }).filter(Boolean).map(clone);
  }

  function listUserAttempts(userId) {
    return clone(
      loadDb().attempts
        .filter(function (item) {
          return item.userId === userId;
        })
        .sort(function (a, b) {
          return new Date(b.updatedAt) - new Date(a.updatedAt);
        })
    );
  }

  function getSubmittedScores(testId, excludeAttemptId) {
    var db = loadDb();
    var test = db.tests.find(function (item) {
      return item.id === testId;
    });
    var benchmark = test ? test.benchmarkScores.slice() : [];
    var firstAttemptsByUser = {};

    db.attempts
      .filter(function (attempt) {
        return attempt.testId === testId && attempt.status === "submitted" && attempt.id !== excludeAttemptId;
      })
      .sort(function (a, b) {
        return new Date(a.submittedAt || a.startedAt) - new Date(b.submittedAt || b.startedAt);
      })
      .forEach(function (attempt) {
        if (!firstAttemptsByUser[attempt.userId]) {
          firstAttemptsByUser[attempt.userId] = attempt;
        }
      });

    var liveScores = Object.keys(firstAttemptsByUser).map(function (userId) {
      var attempt = firstAttemptsByUser[userId];
      return attempt.result ? attempt.result.score : 0;
    });

    return benchmark.concat(liveScores);
  }

  function getFirstSubmittedAttemptForUser(testId, userId, excludeAttemptId) {
    var db = loadDb();
    return clone(
      db.attempts
        .filter(function (attempt) {
          return attempt.testId === testId && attempt.userId === userId && attempt.status === "submitted" && attempt.id !== excludeAttemptId;
        })
        .sort(function (a, b) {
          return new Date(a.submittedAt || a.startedAt) - new Date(b.submittedAt || b.startedAt);
        })[0] || null
    );
  }

  function getFirstAttemptLeaderboard(testId) {
    var db = loadDb();
    var usersById = {};
    db.users.forEach(function (user) {
      usersById[user.id] = user;
    });

    var firstAttemptsByUser = {};
    db.attempts
      .filter(function (attempt) {
        return attempt.testId === testId && attempt.status === "submitted" && attempt.result;
      })
      .sort(function (a, b) {
        return new Date(a.submittedAt || a.startedAt) - new Date(b.submittedAt || b.startedAt);
      })
      .forEach(function (attempt) {
        if (!firstAttemptsByUser[attempt.userId]) {
          firstAttemptsByUser[attempt.userId] = attempt;
        }
      });

    return Object.keys(firstAttemptsByUser)
      .map(function (userId) {
        var attempt = firstAttemptsByUser[userId];
        var user = usersById[userId] || null;
        return {
          attemptId: attempt.id,
          userId: userId,
          userName: user ? user.name : userId,
          email: user ? user.email : "",
          score: attempt.result.score,
          percentile: attempt.result.percentile,
          startedAt: attempt.startedAt,
          submittedAt: attempt.submittedAt
        };
      })
      .sort(function (a, b) {
        if (b.score !== a.score) {
          return b.score - a.score;
        }
        return new Date(a.submittedAt || a.startedAt) - new Date(b.submittedAt || b.startedAt);
      })
      .map(function (item, index) {
        item.rank = index + 1;
        return item;
      });
  }

  function getAttemptById(attemptId) {
    var db = loadDb();
    var attempt = db.attempts.find(function (item) {
      return item.id === attemptId;
    }) || null;
    return attempt ? clone(attempt) : null;
  }

  function getInProgressAttempt(userId, testId) {
    var attempt = loadDb().attempts.find(function (item) {
      return item.userId === userId && item.testId === testId && item.status === "in_progress";
    });
    return attempt ? clone(attempt) : null;
  }

  function createAttempt(userId, testId) {
    var db = loadDb();
    var test = db.tests.find(function (item) {
      return item.id === testId;
    });
    var questions = test ? getQuestionsForTest(testId) : [];
    var firstQuestion = questions.find(function (question) {
      return question.section === "SUPR";
    }) || questions[0] || null;

    if (!test || !firstQuestion) {
      return null;
    }

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
      sectionTimers: buildSectionTimers(test, startedAt),
      result: null,
      resultSnapshot: null
    };

    db.attempts.push(attempt);
    saveDb(db);
    fireAndForget(syncDoc("attempts", attempt.id, attempt));
    fireAndForget(syncBackupMetaFromDb(db));
    return clone(attempt);
  }

  function getOrCreateAttempt(userId, testId) {
    var existing = getInProgressAttempt(userId, testId);
    return existing || createAttempt(userId, testId);
  }

  function patchAttempt(attemptId, updater) {
    var db = loadDb();
    var index = db.attempts.findIndex(function (item) {
      return item.id === attemptId;
    });

    if (index === -1) {
      return null;
    }

    var draft = clone(db.attempts[index]);
    updater(draft, db);
    draft.updatedAt = nowIso();
    db.attempts[index] = draft;
    saveDb(db);
    fireAndForget(syncDoc("attempts", draft.id, draft));
    fireAndForget(syncBackupMetaFromDb(db));
    return clone(draft);
  }

  function submitAttempt(attemptId) {
    var db = loadDb();
    var index = db.attempts.findIndex(function (item) {
      return item.id === attemptId;
    });

    if (index === -1) {
      return null;
    }

    var draft = clone(db.attempts[index]);
    var test = db.tests.find(function (item) {
      return item.id === draft.testId;
    });
    var questions = test.questionIds.map(function (questionId) {
      return db.questions.find(function (question) {
        return question.id === questionId;
      });
    }).filter(Boolean);
    var peerScores = getSubmittedScores(draft.testId, draft.id);
    var existingFirstAttempt = getFirstSubmittedAttemptForUser(draft.testId, draft.userId, draft.id);
    var result = analytics.evaluateAttempt({
      test: test,
      questions: questions,
      attempt: draft,
      peerScores: peerScores,
      includeCurrentScore: !existingFirstAttempt
    });

    draft.status = "submitted";
    draft.submittedAt = nowIso();
    draft.result = result;
    draft.resultSnapshot = {
      attemptId: draft.id,
      testId: draft.testId,
      testTitle: test ? test.title : "AceIIIT Mock Test",
      testSubtitle: test ? test.subtitle : "",
      startedAt: draft.startedAt,
      submittedAt: draft.submittedAt,
      result: clone(result)
    };
    draft.updatedAt = nowIso();
    db.attempts[index] = draft;
    saveDb(db);
    fireAndForget(syncDoc("attempts", draft.id, draft));
    fireAndForget(syncBackupMetaFromDb(db));
    return clone(draft);
  }

  function getDashboardSnapshot(userId) {
    var tests = getTests().filter(function (test) {
      return test.status === "live";
    });
    var attempts = listUserAttempts(userId);
    var submitted = attempts.filter(function (attempt) {
      return attempt.status === "submitted" && attempt.result;
    });

    return {
      tests: tests,
      attempts: attempts,
      completedCount: submitted.length,
      bestScore: submitted.length ? Math.max.apply(null, submitted.map(function (attempt) { return attempt.result.score; })) : 0,
      bestPercentile: submitted.length ? Math.max.apply(null, submitted.map(function (attempt) { return attempt.result.percentile; })) : 0
    };
  }

  function createQuestion(input) {
    var db = loadDb();
    var imageUrls = Array.isArray(input.imageUrls)
      ? input.imageUrls.map(function (item) { return String(item || "").trim(); }).filter(Boolean)
      : (input.imageUrl ? [String(input.imageUrl).trim()] : []);
    var question = normalizeQuestion({
      id: input.id || createId(input.section || "Q"),
      section: input.section,
      topic: input.topic,
      difficulty: input.difficulty,
      prompt: input.prompt,
      passage: input.passage || "",
      imageUrls: imageUrls,
      imageUrl: imageUrls[0] || "",
      options: input.options.slice(),
      correctOption: Number(input.correctOption),
      explanation: input.explanation,
      marks: toNumber(input.marks, 4),
      negativeMarks: normalizeNegativeMarks(input.negativeMarks, -1)
    });
    question.createdAt = nowIso();
    question.updatedAt = question.createdAt;

    db.questions.push(question);

    if (input.testId) {
      var targetTest = db.tests.find(function (item) {
        return item.id === input.testId;
      });
      if (targetTest && targetTest.questionIds.indexOf(question.id) === -1) {
        targetTest.questionIds.push(question.id);
        targetTest.updatedAt = nowIso();
      }
    }

    saveDb(db);
    fireAndForget(syncDoc("questions", question.id, question));
    fireAndForget(syncBackupMetaFromDb(db));
    return clone(question);
  }

  function createTest(input) {
    var db = loadDb();
    var sectionDurations = {
      SUPR: toNumber(input.suprDurationMinutes, 60),
      REAP: toNumber(input.reapDurationMinutes, 120)
    };
    var test = normalizeTest({
      id: input.id || createId("mock"),
      title: input.title,
      subtitle: input.subtitle,
      durationMinutes: sectionDurations.SUPR + sectionDurations.REAP,
      sectionDurations: sectionDurations,
      questionIds: [],
      status: "draft",
      instructions: input.instructions.slice(),
      benchmarkScores: input.benchmarkScores.slice(),
      createdAt: nowIso(),
      updatedAt: nowIso()
    });

    db.tests.push(test);
    saveDb(db);
    fireAndForget(syncDoc("tests", test.id, test));
    fireAndForget(syncBackupMetaFromDb(db));
    return clone(test);
  }

  function updateQuestion(questionId, input) {
    var db = loadDb();
    var index = db.questions.findIndex(function (question) {
      return question.id === questionId;
    });

    if (index === -1) {
      return null;
    }

    var existing = db.questions[index];
    var updated = normalizeQuestion({
      id: existing.id,
      section: input.section !== undefined ? input.section : existing.section,
      topic: input.topic !== undefined ? input.topic : existing.topic,
      difficulty: input.difficulty !== undefined ? input.difficulty : existing.difficulty,
      prompt: input.prompt !== undefined ? input.prompt : existing.prompt,
      passage: input.passage !== undefined ? input.passage : existing.passage,
      imageUrls: input.imageUrls !== undefined ? input.imageUrls : existing.imageUrls,
      imageUrl: input.imageUrl !== undefined ? input.imageUrl : existing.imageUrl,
      options: input.options !== undefined ? input.options : existing.options,
      correctOption: input.correctOption !== undefined ? Number(input.correctOption) : existing.correctOption,
      explanation: input.explanation !== undefined ? input.explanation : existing.explanation,
      marks: input.marks !== undefined ? input.marks : existing.marks,
      negativeMarks: input.negativeMarks !== undefined ? input.negativeMarks : existing.negativeMarks
    });
    updated.createdAt = existing.createdAt || nowIso();
    updated.updatedAt = nowIso();
    db.questions[index] = updated;
    saveDb(db);
    fireAndForget(syncDoc("questions", updated.id, updated));
    fireAndForget(syncBackupMetaFromDb(db));
    return clone(updated);
  }

  function deleteQuestion(questionId) {
    var db = loadDb();
    var deleted = db.questions.find(function (question) {
      return question.id === questionId;
    });
    db.questions = db.questions.filter(function (question) {
      return question.id !== questionId;
    });
    if (deleted) {
      deleted.deletedAt = nowIso();
      db.deletedQuestions.push(deleted);
    }
    db.tests.forEach(function (test) {
      var before = test.questionIds.length;
      test.questionIds = test.questionIds.filter(function (id) {
        return id !== questionId;
      });
      if (test.questionIds.length !== before) {
        test.updatedAt = nowIso();
      }
    });
    saveDb(db);
    fireAndForget(deleteRemoteDoc("questions", questionId));
    if (deleted) {
      fireAndForget(syncDoc("deletedQuestions", deleted.id, deleted));
    }
    fireAndForget(syncBackupMetaFromDb(db));
    return true;
  }

  function getDeletedQuestions() {
    return clone(loadDb().deletedQuestions || []).sort(function (a, b) {
      return new Date(b.deletedAt || b.updatedAt || b.createdAt) - new Date(a.deletedAt || a.updatedAt || a.createdAt);
    });
  }

  function restoreDeletedQuestion(questionId) {
    var db = loadDb();
    var question = (db.deletedQuestions || []).find(function (item) {
      return item.id === questionId;
    });
    if (!question) {
      return null;
    }
    db.deletedQuestions = db.deletedQuestions.filter(function (item) {
      return item.id !== questionId;
    });
    delete question.deletedAt;
    db.questions.push(question);
    saveDb(db);
    fireAndForget(syncDoc("questions", question.id, question));
    fireAndForget(deleteRemoteDoc("deletedQuestions", question.id));
    fireAndForget(syncBackupMetaFromDb(db));
    return clone(question);
  }

  function permanentlyDeleteQuestion(questionId) {
    var db = loadDb();
    db.deletedQuestions = (db.deletedQuestions || []).filter(function (item) {
      return item.id !== questionId;
    });
    saveDb(db);
    fireAndForget(deleteRemoteDoc("questions", questionId));
    fireAndForget(deleteRemoteDoc("deletedQuestions", questionId));
    fireAndForget(syncBackupMetaFromDb(db));
    return true;
  }

  function updateTest(testId, input) {
    var db = loadDb();
    var index = db.tests.findIndex(function (test) {
      return test.id === testId;
    });

    if (index === -1) {
      return null;
    }

    var existing = db.tests[index];
    var sectionDurations = {
      SUPR: toNumber(input.suprDurationMinutes !== undefined ? input.suprDurationMinutes : existing.sectionDurations.SUPR, existing.sectionDurations.SUPR),
      REAP: toNumber(input.reapDurationMinutes !== undefined ? input.reapDurationMinutes : existing.sectionDurations.REAP, existing.sectionDurations.REAP)
    };
    var updated = normalizeTest({
      id: existing.id,
      title: input.title !== undefined ? input.title : existing.title,
      subtitle: input.subtitle !== undefined ? input.subtitle : existing.subtitle,
      durationMinutes: sectionDurations.SUPR + sectionDurations.REAP,
      sectionDurations: sectionDurations,
      questionIds: existing.questionIds.slice(),
      status: input.status !== undefined ? input.status : existing.status,
      instructions: input.instructions !== undefined ? input.instructions : existing.instructions,
      benchmarkScores: input.benchmarkScores !== undefined ? input.benchmarkScores : existing.benchmarkScores,
      createdAt: existing.createdAt,
      updatedAt: nowIso()
    });
    db.tests[index] = updated;
    saveDb(db);
    fireAndForget(syncDoc("tests", updated.id, updated));
    fireAndForget(syncBackupMetaFromDb(db));
    return clone(updated);
  }

  function deleteTest(testId) {
    var db = loadDb();
    var deletedTest = db.tests.find(function (test) {
      return test.id === testId;
    }) || null;
    db.tests = db.tests.filter(function (test) {
      return test.id !== testId;
    });
    db.attempts = db.attempts.filter(function (attempt) {
      return attempt.testId !== testId;
    });
    if (deletedTest) {
      deletedTest.deletedAt = nowIso();
      db.deletedTests.push(deletedTest);
    }
    saveDb(db);
    fireAndForget(deleteRemoteDoc("tests", testId));
    if (deletedTest) {
      fireAndForget(syncDoc("deletedTests", deletedTest.id, deletedTest));
    }
    fireAndForget(syncBackupMetaFromDb(db));
    return true;
  }

  function getDeletedTests() {
    return clone(loadDb().deletedTests || []).sort(function (a, b) {
      return new Date(b.deletedAt || b.updatedAt || b.createdAt) - new Date(a.deletedAt || a.updatedAt || a.createdAt);
    });
  }

  function restoreDeletedTest(testId) {
    var db = loadDb();
    var test = (db.deletedTests || []).find(function (item) {
      return item.id === testId;
    });
    if (!test) {
      return null;
    }
    db.deletedTests = db.deletedTests.filter(function (item) {
      return item.id !== testId;
    });
    delete test.deletedAt;
    test.updatedAt = nowIso();
    db.tests.push(normalizeTest(test));
    saveDb(db);
    fireAndForget(syncDoc("tests", test.id, test));
    fireAndForget(deleteRemoteDoc("deletedTests", test.id));
    fireAndForget(syncBackupMetaFromDb(db));
    return clone(test);
  }

  function permanentlyDeleteTest(testId) {
    var db = loadDb();
    db.deletedTests = (db.deletedTests || []).filter(function (item) {
      return item.id !== testId;
    });
    saveDb(db);
    fireAndForget(deleteRemoteDoc("deletedTests", testId));
    fireAndForget(syncBackupMetaFromDb(db));
    return true;
  }

  function attachQuestionToTest(testId, questionId) {
    var db = loadDb();
    var test = db.tests.find(function (item) {
      return item.id === testId;
    });
    if (!test) {
      return null;
    }
    if (test.questionIds.indexOf(questionId) === -1) {
      test.questionIds.push(questionId);
      test.updatedAt = nowIso();
      saveDb(db);
      fireAndForget(syncDoc("tests", test.id, test));
      fireAndForget(syncBackupMetaFromDb(db));
    }
    return clone(test);
  }

  function detachQuestionFromTest(testId, questionId) {
    var db = loadDb();
    var test = db.tests.find(function (item) {
      return item.id === testId;
    });
    if (!test) {
      return null;
    }
    test.questionIds = test.questionIds.filter(function (id) {
      return id !== questionId;
    });
    test.updatedAt = nowIso();
    saveDb(db);
    fireAndForget(syncDoc("tests", test.id, test));
    fireAndForget(syncBackupMetaFromDb(db));
    return clone(test);
  }

  function deleteUser(userId) {
    var db = loadDb();
    var user = db.users.find(function (item) {
      return item.id === userId;
    });
    if (!user || user.role === "admin") {
      return false;
    }

    db.users = db.users.filter(function (item) {
      return item.id !== userId;
    });
    user.deletedAt = nowIso();
    db.deletedUsers.push(user);
    saveDb(db);
    fireAndForget(deleteRemoteDoc("users", userId));
    fireAndForget(syncDoc("deletedUsers", user.id, user));
    fireAndForget(syncBackupMetaFromDb(db));
    return true;
  }

  function getDeletedUsers() {
    return clone(loadDb().deletedUsers || []).sort(function (a, b) {
      return new Date(b.deletedAt || b.createdAt) - new Date(a.deletedAt || a.createdAt);
    });
  }

  function restoreDeletedUser(userId) {
    var db = loadDb();
    var user = (db.deletedUsers || []).find(function (item) {
      return item.id === userId;
    });
    if (!user) {
      return null;
    }

    db.deletedUsers = db.deletedUsers.filter(function (item) {
      return item.id !== userId;
    });
    delete user.deletedAt;
    db.users.push(user);
    saveDb(db);
    fireAndForget(syncDoc("users", user.id, user));
    fireAndForget(deleteRemoteDoc("deletedUsers", user.id));
    fireAndForget(syncBackupMetaFromDb(db));
    return clone(user);
  }

  function permanentlyDeleteUser(userId) {
    var db = loadDb();
    db.deletedUsers = (db.deletedUsers || []).filter(function (item) {
      return item.id !== userId;
    });
    saveDb(db);
    fireAndForget(deleteRemoteDoc("deletedUsers", userId));
    fireAndForget(syncBackupMetaFromDb(db));
    return true;
  }

  function getAdminSnapshot() {
    var db = loadDb();
    return {
      users: clone(db.users).sort(function (a, b) {
        return new Date(b.createdAt) - new Date(a.createdAt);
      }),
      deletedUsers: clone(db.deletedUsers || []).sort(function (a, b) {
        return new Date(b.deletedAt || b.createdAt) - new Date(a.deletedAt || a.createdAt);
      }),
      attempts: clone(db.attempts).sort(function (a, b) {
        return new Date(b.updatedAt || b.startedAt) - new Date(a.updatedAt || a.startedAt);
      }),
      loginEvents: clone(db.loginEvents).sort(function (a, b) {
        return new Date(b.loggedInAt) - new Date(a.loggedInAt);
      })
    };
  }

  function exportData() {
    return JSON.stringify(loadDb(), null, 2);
  }

  function importData(raw) {
    var parsed = migrateDb(JSON.parse(raw));
    saveDb(parsed);
    fireAndForget(syncAllToRemote(parsed));
    return clone(parsed);
  }

  function isAdmin(user) {
    return !!user && user.role === "admin";
  }

  window.AceIIIT.store = {
    init: function () {
      loadDb();
      if (firebaseBridge && firebaseBridge.onAuthStateChanged && firebaseBridge.isConfigured && firebaseBridge.isConfigured()) {
        firebaseBridge.onAuthStateChanged(function (authUser) {
          syncSessionFromAuthUser(authUser);
        });
      }
      return syncFromRemote().then(function (result) {
        if (!result || !result.ok || !result.hasRemoteData) {
          return syncAllToRemote(loadDb());
        }
        return true;
      }).catch(function () {
        return false;
      });
    },
    getCurrentUser: getCurrentUser,
    refreshFromRemote: syncFromRemote,
    subscribeToRemoteChanges: subscribeToRemoteChanges,
    signUp: signUp,
    login: login,
    logout: logout,
    getSettings: getSettings,
    updateSettings: updateSettings,
    getTests: getTests,
    getQuestions: getQuestions,
    getTestById: getTestById,
    getQuestionsForTest: getQuestionsForTest,
    listUserAttempts: listUserAttempts,
    getAttemptById: getAttemptById,
    getInProgressAttempt: getInProgressAttempt,
    createAttempt: createAttempt,
    getOrCreateAttempt: getOrCreateAttempt,
    patchAttempt: patchAttempt,
    submitAttempt: submitAttempt,
    getDashboardSnapshot: getDashboardSnapshot,
    getAdminSnapshot: getAdminSnapshot,
    createQuestion: createQuestion,
    updateQuestion: updateQuestion,
    deleteQuestion: deleteQuestion,
    createTest: createTest,
    updateTest: updateTest,
    deleteTest: deleteTest,
    attachQuestionToTest: attachQuestionToTest,
    detachQuestionFromTest: detachQuestionFromTest,
    getDeletedQuestions: getDeletedQuestions,
    restoreDeletedQuestion: restoreDeletedQuestion,
    permanentlyDeleteQuestion: permanentlyDeleteQuestion,
    getDeletedTests: getDeletedTests,
    restoreDeletedTest: restoreDeletedTest,
    permanentlyDeleteTest: permanentlyDeleteTest,
    deleteUser: deleteUser,
    getDeletedUsers: getDeletedUsers,
    restoreDeletedUser: restoreDeletedUser,
    permanentlyDeleteUser: permanentlyDeleteUser,
    getFirstAttemptLeaderboard: getFirstAttemptLeaderboard,
    exportData: exportData,
    importData: importData,
    isAdmin: isAdmin
  };
})();
