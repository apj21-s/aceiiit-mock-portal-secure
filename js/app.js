(function () {
  var app = document.getElementById("app");
  var store = window.AceIIIT.store;
  var firebaseBridge = window.AceIIIT.firebase;
  var runtime = {
    attemptId: null,
    questionId: null,
    startedAt: 0,
    timerId: null,
    calculatorVisible: false,
    calculatorExpression: "",
    instructionsPopupTestId: null,
    adminSelectedTestId: null,
    adminEditingTestId: null,
    adminEditingQuestionId: null,
    pendingSectionTransition: null,
    adminBankQuery: "",
    adminBankSectionFilter: "all",
    adminActivityTestId: null,
    imageLightboxUrl: ""
  };
  var ADMIN_TEST_DRAFT_KEY = "aceiiit.secure.admin.testDraft.v1";
  var ADMIN_QUESTION_DRAFT_KEY = "aceiiit.secure.admin.questionDraft.v1";
  var ADMIN_SETTINGS_DRAFT_KEY = "aceiiit.secure.admin.settingsDraft.v1";
  var ADMIN_FIREBASE_DRAFT_KEY = "aceiiit.secure.admin.firebaseDraft.v1";
  var remoteChangeUnsubscribe = null;
  var overlayLoaderVisible = false;
  var syncPollId = null;

  function initials(name) {
    return String(name || "A")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(function (part) { return part[0].toUpperCase(); })
      .join("");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderLoadingScreen(label) {
    app.innerHTML =
      '<section class="portal-loader">' +
        '<div class="portal-loader-card">' +
          '<div class="portal-loader-brand">' +
            '<span class="brand-dot"></span>' +
            '<span>ACEIIIT</span>' +
          '</div>' +
          '<div class="portal-loader-line"><span></span></div>' +
          '<p class="section-label">Preparing portal</p>' +
          '<h1>Syncing latest data.</h1>' +
          '<p>' + escapeHtml(label || "Pulling your current portal state from the backend.") + '</p>' +
        '</div>' +
      '</section>';
  }

  function showOverlayLoader(label) {
    if (!document.body) {
      return;
    }

    hideOverlayLoader();
    document.body.classList.add("is-syncing");

    var overlay = document.createElement("div");
    overlay.className = "sync-overlay";
    overlay.setAttribute("data-sync-overlay", "true");
    overlay.innerHTML =
      '<div class="sync-overlay-card">' +
        '<div class="sync-ring-loader"><span></span><span></span></div>' +
        '<p class="sync-overlay-text" aria-label="Syncing">' +
          '<span>S</span><span>Y</span><span>N</span><span>C</span><span>I</span><span>N</span><span>G</span>' +
        '</p>' +
      '</div>';
    document.body.appendChild(overlay);
    overlayLoaderVisible = true;
  }

  function hideOverlayLoader() {
    overlayLoaderVisible = false;
    document.body.classList.remove("is-syncing");
    var existing = document.querySelector("[data-sync-overlay='true']");
    if (existing) {
      existing.remove();
    }
  }

  function loadLocalDraft(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch (error) {
      return null;
    }
  }

  function saveLocalDraft(key, value) {
    localStorage.setItem(key, JSON.stringify(value || null));
  }

  function clearLocalDraft(key) {
    localStorage.removeItem(key);
  }

  function extractFormDraft(form) {
    var payload = {};
    if (!form) {
      return payload;
    }

    Array.prototype.slice.call(form.elements || []).forEach(function (field) {
      if (!field.name || field.disabled || field.type === "file") {
        return;
      }
      if ((field.type === "checkbox" || field.type === "radio") && !field.checked) {
        return;
      }
      payload[field.name] = field.value;
    });
    return payload;
  }

  function applyFormDraft(form, draft) {
    if (!form || !draft) {
      return;
    }

    Array.prototype.slice.call(form.elements || []).forEach(function (field) {
      if (!field.name || !(field.name in draft) || field.type === "file") {
        return;
      }
      if (field.type === "checkbox" || field.type === "radio") {
        field.checked = String(field.value) === String(draft[field.name]);
        return;
      }
      field.value = draft[field.name];
    });
  }

  function bindDraftAutosave(form, key, contextBuilder) {
    if (!form) {
      return;
    }

    function persistDraft() {
      saveLocalDraft(key, {
        context: contextBuilder ? contextBuilder() : null,
        values: extractFormDraft(form),
        savedAt: Date.now()
      });
    }

    form.addEventListener("input", persistDraft);
    form.addEventListener("change", persistDraft);
  }

  function restoreDraft(form, key, contextValue) {
    var draft = loadLocalDraft(key);
    if (!draft) {
      return;
    }
    if (draft.context && contextValue && draft.context !== contextValue) {
      return;
    }
    applyFormDraft(form, draft.values || {});
  }

  function safeImageUrl(value) {
    var normalized = String(value || "").trim().replace(/\\/g, "/");
    if (/^[A-Za-z]:\//.test(normalized)) {
      return "file:///" + encodeURI(normalized);
    }
    return encodeURI(normalized);
  }

  function formatTime(totalSeconds) {
    var safe = Math.max(0, Math.floor(totalSeconds || 0));
    var hours = Math.floor(safe / 3600);
    var minutes = Math.floor((safe % 3600) / 60);
    var seconds = safe % 60;

    if (hours > 0) {
      return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
    }

    return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
  }

  function getTotalDuration(test) {
    if (!test) {
      return 0;
    }

    if (test.sectionDurations) {
      return Number(test.sectionDurations.SUPR || 0) + Number(test.sectionDurations.REAP || 0);
    }

    return Number(test.durationMinutes || 0);
  }

  function getSectionQuestions(questions, sectionKey) {
    return questions.filter(function (question) {
      return question.section === sectionKey;
    });
  }

  function getQuestionImageUrls(question) {
    if (!question) {
      return [];
    }

    if (Array.isArray(question.imageUrls) && question.imageUrls.length) {
      return question.imageUrls.filter(Boolean);
    }

    if (question.imageUrl) {
      return [question.imageUrl];
    }

    return [];
  }

  function renderQuestionFigures(question) {
    var imageUrls = getQuestionImageUrls(question);

    if (!imageUrls.length) {
      return "";
    }

    return (
      '<div class="question-figure-stack">' +
        imageUrls.map(function (imageUrl, index) {
          return '<button type="button" class="question-figure-button" data-open-image="' + escapeAttribute(imageUrl) + '" aria-label="Open question image ' + (index + 1) + '"><img class="question-figure" src="' + safeImageUrl(imageUrl) + '" alt="Question reference ' + (index + 1) + '"></button>';
        }).join("") +
      '</div>'
    );
  }

  function getImageLightboxMarkup() {
    if (!runtime.imageLightboxUrl) {
      return "";
    }

    return (
      '<div class="image-lightbox" data-close-image-lightbox>' +
        '<div class="image-lightbox-card">' +
          '<button type="button" class="calculator-close image-lightbox-close" data-close-image-lightbox>Close</button>' +
          '<img class="image-lightbox-image" src="' + safeImageUrl(runtime.imageLightboxUrl) + '" alt="Zoomed question reference">' +
        '</div>' +
      '</div>'
    );
  }

  function bindImageLightbox(renderCallback) {
    app.querySelectorAll("[data-open-image]").forEach(function (button) {
      button.addEventListener("click", function () {
        runtime.imageLightboxUrl = button.dataset.openImage || "";
        renderCallback();
      });
    });

    app.querySelectorAll("[data-close-image-lightbox]").forEach(function (element) {
      element.addEventListener("click", function (event) {
        if (event.target !== element && !event.target.hasAttribute("data-close-image-lightbox")) {
          return;
        }
        runtime.imageLightboxUrl = "";
        renderCallback();
      });
    });
  }

  function formatDateTime(value) {
    if (!value) {
      return "-";
    }
    return new Date(value).toLocaleString();
  }

  function rerenderAdminPreserveScroll(user, selectedTestId) {
    var scrollY = window.scrollY || window.pageYOffset || 0;
    var active = document.activeElement;
    var activeId = active && active.id ? active.id : null;
    var selectionStart = active && typeof active.selectionStart === "number" ? active.selectionStart : null;
    var selectionEnd = active && typeof active.selectionEnd === "number" ? active.selectionEnd : null;
    renderAdmin(user, selectedTestId);
    window.requestAnimationFrame(function () {
      window.scrollTo(0, scrollY);
      if (activeId) {
        var nextActive = document.getElementById(activeId);
        if (nextActive) {
          nextActive.focus({ preventScroll: true });
          if (selectionStart !== null && selectionEnd !== null && typeof nextActive.setSelectionRange === "function") {
            nextActive.setSelectionRange(selectionStart, selectionEnd);
          }
        }
      }
      window.scrollTo(0, scrollY);
    });
  }

  function highlightMatch(text, query) {
    var source = String(text || "");
    var needle = String(query || "").trim();

    if (!needle) {
      return escapeHtml(source);
    }

    var lowerSource = source.toLowerCase();
    var lowerNeedle = needle.toLowerCase();
    var index = lowerSource.indexOf(lowerNeedle);

    if (index === -1) {
      return escapeHtml(source);
    }

    var before = source.slice(0, index);
    var match = source.slice(index, index + needle.length);
    var after = source.slice(index + needle.length);

    return escapeHtml(before) + '<mark class="search-highlight">' + escapeHtml(match) + '</mark>' + escapeHtml(after);
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/"/g, "&quot;");
  }

  function parseAllowlistText(raw) {
    return String(raw || "")
      .split(/[\n,\r;\t ]+/)
      .map(function (item) { return String(item || "").trim().toLowerCase(); })
      .filter(function (item, index, items) {
        return item && items.indexOf(item) === index;
      });
  }

  function extractEmailsFromCsv(raw) {
    var matches = String(raw || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    return matches
      .map(function (item) { return item.trim().toLowerCase(); })
      .filter(function (item, index, items) {
        return items.indexOf(item) === index;
      });
  }

  function collectAllowlistSettings() {
    var enabled = document.getElementById("allowlist-enabled");
    var listInput = document.getElementById("allowed-emails");
    var sheetInput = document.getElementById("allowlist-sheet-url");

    return {
      allowlistEnabled: enabled ? enabled.value === "on" : false,
      allowedEmails: parseAllowlistText(listInput ? listInput.value : ""),
      allowlistSheetUrl: sheetInput ? sheetInput.value : ""
    };
  }

  function updateCalculatorDisplay() {
    var display = app.querySelector("[data-calculator-display]");
    if (display) {
      display.textContent = runtime.calculatorExpression || "0";
    }
  }

  function readFilesAsUrls(fileList, testId, questionId) {
    return firebaseBridge.uploadFiles(fileList, testId, questionId);
  }

  function getSectionDistribution(questions) {
    var summary = {
      SUPR: 0,
      REAP: 0,
      topics: {}
    };

    questions.forEach(function (question) {
      summary[question.section] += 1;
      summary.topics[question.topic] = (summary.topics[question.topic] || 0) + 1;
    });

    return summary;
  }

  function getSectionTransitionMarkup() {
    if (!runtime.pendingSectionTransition) {
      return "";
    }

    var canReview = !!runtime.pendingSectionTransition.canReview;
    return (
      '<div class="transition-modal">' +
        '<div class="transition-card">' +
          '<p class="section-label">Section Complete</p>' +
          '<h3>' + escapeHtml(runtime.pendingSectionTransition.title) + '</h3>' +
          '<p>' + escapeHtml(runtime.pendingSectionTransition.message) + '</p>' +
          '<div class="button-row">' +
            (canReview ? '<button class="button button-secondary" type="button" data-transition-action="cancel">No, stay here</button>' : "") +
            '<button class="button button-primary" type="button" data-transition-action="confirm">Yes, continue</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function getInstructionsModalMarkup(user, test, questions) {
    if (!runtime.instructionsPopupTestId || !test || runtime.instructionsPopupTestId !== test.id) {
      return "";
    }

    var grouped = questions.reduce(function (accumulator, question) {
      accumulator[question.section] = accumulator[question.section] || [];
      accumulator[question.section].push(question);
      return accumulator;
    }, {});
    var suprMaxMarks = (grouped.SUPR || []).reduce(function (sum, question) {
      return sum + Number(question.marks || 0);
    }, 0);
    var reapMaxMarks = (grouped.REAP || []).reduce(function (sum, question) {
      return sum + Number(question.marks || 0);
    }, 0);

    return (
      '<div class="transition-modal instructions-modal-overlay">' +
        '<div class="transition-card instructions-popup-card">' +
          '<div class="calculator-header">' +
            '<strong>Instructions</strong>' +
            '<button type="button" class="calculator-close" data-close-instructions>Close</button>' +
          '</div>' +
          '<div class="instructions-popup-grid">' +
            '<div>' +
              '<p><strong>Section 1:</strong> SUPR | ' + test.sectionDurations.SUPR + ' minutes | ' + suprMaxMarks + ' marks</p>' +
              '<p><strong>Section 2:</strong> REAP | ' + test.sectionDurations.REAP + ' minutes | ' + reapMaxMarks + ' marks</p>' +
              '<p>SUPR locks only after you submit the section or when its time ends.</p>' +
              '<p>REAP opens after SUPR is submitted and auto-submits when its own timer ends.</p>' +
              '<p>The built-in calculator can be opened from the question screen whenever needed.</p>' +
            '</div>' +
            '<aside class="instructions-sideinfo">' +
              '<p><strong>Candidate:</strong> ' + escapeHtml(user.name) + '</p>' +
              '<p><strong>Test:</strong> ' + escapeHtml(test.title) + '</p>' +
              '<p><strong>Total Questions:</strong> ' + questions.length + '</p>' +
            '</aside>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function areAllQuestionsAnswered(attempt, questions) {
    return questions.length > 0 && questions.every(function (question) {
      return attempt.answers[question.id] !== undefined && attempt.answers[question.id] !== null && attempt.answers[question.id] !== "";
    });
  }

  function getSectionTimeLeft(attempt, sectionKey) {
    if (!attempt || !attempt.sectionTimers || !attempt.sectionTimers[sectionKey]) {
      return 0;
    }

    var timer = attempt.sectionTimers[sectionKey];
    if (!timer.startedAt) {
      return timer.durationMinutes * 60;
    }

    var elapsed = Math.floor((Date.now() - new Date(timer.startedAt).getTime()) / 1000);
    return timer.durationMinutes * 60 - elapsed;
  }

  function routeParts() {
    var hash = window.location.hash.replace(/^#\/?/, "");
    return hash ? hash.split("/") : [];
  }

  function navigate(path) {
    window.location.hash = "#/" + path;
  }

  function stopRuntime(flush) {
    if (flush) {
      flushQuestionTime();
    }

    if (runtime.timerId) {
      clearInterval(runtime.timerId);
      runtime.timerId = null;
    }

    runtime.attemptId = null;
    runtime.questionId = null;
    runtime.startedAt = 0;
  }

  function flushQuestionTime() {
    if (!runtime.attemptId || !runtime.questionId || !runtime.startedAt) {
      return;
    }

    var elapsed = Math.max(0, Math.floor((Date.now() - runtime.startedAt) / 1000));
    if (!elapsed) {
      return;
    }

    store.patchAttempt(runtime.attemptId, function (draft) {
      draft.timeSpent[runtime.questionId] = Number(draft.timeSpent[runtime.questionId] || 0) + elapsed;
    });

    runtime.startedAt = Date.now();
  }

  function getQuestionStatus(attempt, questionId) {
    var marked = !!attempt.marked[questionId];
    var answered = attempt.answers[questionId] !== undefined && attempt.answers[questionId] !== null && attempt.answers[questionId] !== "";
    var visited = !!attempt.visited[questionId];

    if (marked && answered) {
      return "answered-marked";
    }

    if (marked) {
      return "marked";
    }

    if (answered) {
      return "answered";
    }

    if (visited) {
      return "not-answered";
    }

    return "not-visited";
  }

  function buildShell(content) {
    return (
      '<main class="page-shell">' +
        content +
        '<div class="app-footer">AceIIIT MockTest Portal</div>' +
      "</main>"
    );
  }

  function getCalculatorMarkup() {
    if (!runtime.calculatorVisible) {
      return "";
    }

    var keys = [
      "7", "8", "9", "/",
      "4", "5", "6", "*",
      "1", "2", "3", "-",
      "0", ".", "(", ")",
      "C", "DEL", "%", "+",
      "="
    ];

    return (
      '<div class="calculator-popout">' +
        '<div class="calculator-modal calculator-modal-inline">' +
          '<div class="calculator-header">' +
            '<strong>Calculator</strong>' +
            '<button type="button" class="calculator-close" data-calc-action="close">Close</button>' +
          '</div>' +
          '<div class="calculator-display" data-calculator-display>' + escapeHtml(runtime.calculatorExpression || "0") + '</div>' +
          '<div class="calculator-grid">' +
            keys.map(function (key) {
              var wide = key === "=" ? " calculator-key-wide" : "";
              return '<button type="button" class="calculator-key' + wide + '" data-calc-key="' + escapeHtml(key) + '">' + escapeHtml(key) + '</button>';
            }).join("") +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  function evaluateCalculatorExpression(expression) {
    var safeExpression = String(expression || "").trim();
    if (!safeExpression) {
      return "";
    }

    if (!/^[0-9+\-*/().% ]+$/.test(safeExpression)) {
      return "Error";
    }

    try {
      var result = Function("return (" + safeExpression + ");")();
      if (!Number.isFinite(result)) {
        return "Error";
      }
      return String(Math.round(result * 1000000) / 1000000);
    } catch (error) {
      return "Error";
    }
  }

  function bindCalculatorHandlers(renderCallback) {
    app.querySelectorAll("[data-calc-toggle]").forEach(function (button) {
      button.addEventListener("click", function () {
        runtime.calculatorVisible = !runtime.calculatorVisible;
        renderCallback();
      });
    });

    app.querySelectorAll("[data-calc-action='close']").forEach(function (button) {
      button.addEventListener("click", function () {
        runtime.calculatorVisible = false;
        renderCallback();
      });
    });

    app.querySelectorAll("[data-calc-key]").forEach(function (button) {
      button.addEventListener("click", function () {
        var key = button.dataset.calcKey;

        if (key === "C") {
          runtime.calculatorExpression = "";
        } else if (key === "DEL") {
          runtime.calculatorExpression = runtime.calculatorExpression.slice(0, -1);
        } else if (key === "=") {
          runtime.calculatorExpression = evaluateCalculatorExpression(runtime.calculatorExpression);
        } else {
          if (runtime.calculatorExpression === "Error") {
            runtime.calculatorExpression = "";
          }
          runtime.calculatorExpression += key;
        }
        updateCalculatorDisplay();
      });
    });
  }

  function renderLogin() {
    var loginSettings = store.getSettings();
    var allowlistNote = loginSettings.allowlistEnabled
      ? '<p class="helper-text">Access is limited to verified emails approved by AceIIIT.</p>'
      : '<p class="helper-text">Use the student access code issued by AceIIIT to register a new account.</p>';
    app.innerHTML = buildShell(
      '<section class="editorial-shell">' +
        '<div class="hero-panel">' +
          '<div class="brand-row">' +
            '<div class="brand-mark"><span class="brand-dot"></span> AceIIIT</div>' +
            '<div class="status-note">UGEE Pattern Portal</div>' +
          '</div>' +
          '<div class="headline-block">' +
            '<p class="section-label">AceIIIT Test System</p>' +
            '<h1>Practice under the right <span class="strike">pressure</span>.</h1>' +
            '<p>Timed sectional workflow, locked paper flow, detailed analytics in one platform.</p>' +
          '</div>' +
          '<div class="hero-grid">' +
            '<div class="stat-card"><strong>SUPR</strong><span>1 hour section </span></div>' +
            '<div class="stat-card"><strong>REAP</strong><span>2 hour section </span></div>' +
            '<div class="stat-card"><strong>Analytics</strong><span>Rank, percentile, timing, and review</span></div>' +
          '</div>' +
        '</div>' +
        '<aside class="auth-panel">' +
          '<div class="button-row" style="margin-bottom: 4px;">' +
            '<button class="tab-button is-active" type="button" data-auth-mode="login">Login</button>' +
            '<button class="tab-button" type="button" data-auth-mode="signup">Sign Up</button>' +
          '</div>' +
          '<div>' +
            '<p class="section-label">Access Portal</p>' +
            '<h2>Student And Admin Login</h2>' +
            '<p class="auth-copy">Use your enrolled account password to access tests. New students can register with the issued access key.</p>' +
          '</div>' +
          '<form id="login-form" class="grid-two">' +
            '<div class="field" style="grid-column: 1 / -1;"><label for="login-email">Email</label><input id="login-email" name="email" type="email" placeholder="student@aceiiit.in" required></div>' +
            '<div class="field" style="grid-column: 1 / -1;"><label for="login-password">Password</label><input id="login-password" name="password" type="password" placeholder="Enter password" required></div>' +
            '<div class="button-row" style="grid-column: 1 / -1;"><button class="button button-primary" type="submit">Login</button></div>' +
          '</form>' +
          '<form id="signup-form" class="grid-two" style="display:none;">' +
            '<div class="field"><label for="signup-name">Full name</label><input id="signup-name" name="name" placeholder="AceIIIT Student" required></div>' +
            '<div class="field"><label for="signup-phone">Phone</label><input id="signup-phone" name="phone" placeholder="+91 98765 43210"></div>' +
            '<div class="field" style="grid-column: 1 / -1;"><label for="signup-email">Email</label><input id="signup-email" name="email" type="email" placeholder="student@aceiiit.in" required></div>' +
            '<div class="field" style="grid-column: 1 / -1;"><label for="signup-access">Student access code</label><input id="signup-access" name="accessCode" placeholder="Issued by AceIIIT" required></div>' +
            '<div class="field"><label for="signup-password">Password</label><input id="signup-password" name="password" type="password" placeholder="Create password" required></div>' +
            '<div class="field"><label for="signup-confirm">Confirm password</label><input id="signup-confirm" name="confirmPassword" type="password" placeholder="Repeat password" required></div>' +
            '<div class="button-row" style="grid-column: 1 / -1;"><button class="button button-primary" type="submit">Create account</button></div>' +
          '</form>' +
          '<div id="auth-feedback" class="banner" style="display:none;"></div>' +
          allowlistNote +
        '</aside>' +
      '</section>'
    );

    var loginForm = document.getElementById("login-form");
    var signupForm = document.getElementById("signup-form");
    var feedback = document.getElementById("auth-feedback");

    function showFeedback(message, isError) {
      feedback.style.display = "block";
      feedback.textContent = message;
      feedback.style.background = isError ? "rgba(183, 58, 40, 0.18)" : "rgba(197, 160, 40, 0.16)";
      feedback.style.color = isError ? "#fff1ee" : "#f7f0e4";
    }

    app.querySelectorAll("[data-auth-mode]").forEach(function (button) {
      button.addEventListener("click", function () {
        var mode = button.dataset.authMode;
        app.querySelectorAll("[data-auth-mode]").forEach(function (tab) {
          tab.classList.toggle("is-active", tab === button);
        });
        loginForm.style.display = mode === "login" ? "grid" : "none";
        signupForm.style.display = mode === "signup" ? "grid" : "none";
        feedback.style.display = "none";
      });
    });

    loginForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      var form = new FormData(event.currentTarget);
      var result = await store.login({
        email: form.get("email"),
        password: form.get("password")
      });

      if (result.ok) {
        navigate("dashboard");
      } else {
        showFeedback(result.error, true);
      }
    });

    signupForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      var form = new FormData(event.currentTarget);

      if (String(form.get("password")) !== String(form.get("confirmPassword"))) {
        showFeedback("Passwords do not match.", true);
        return;
      }

      var signupResult = await store.signUp({
        name: form.get("name"),
        phone: form.get("phone"),
        email: form.get("email"),
        accessCode: form.get("accessCode"),
        password: form.get("password")
      });

      if (!signupResult.ok) {
        showFeedback(signupResult.error, true);
        return;
      }

      navigate("dashboard");
    });
  }

  function renderDashboard(user) {
    var snapshot = store.getDashboardSnapshot(user.id);
    var attemptsByTest = {};

    snapshot.attempts.forEach(function (attempt) {
      if (!attemptsByTest[attempt.testId]) {
        attemptsByTest[attempt.testId] = [];
      }
      attemptsByTest[attempt.testId].push(attempt);
    });

    var cards = snapshot.tests.map(function (test) {
      var attempts = attemptsByTest[test.id] || [];
      var inProgress = attempts.find(function (attempt) {
        return attempt.status === "in_progress";
      });
      var submitted = attempts.filter(function (attempt) {
        return attempt.status === "submitted";
      });
      var latestSubmitted = submitted[0] || null;
      var actionHtml = inProgress
        ? '<button class="button button-primary js-resume-test" data-id="' + test.id + '">Resume Test</button>'
        : '<button class="button button-primary js-open-instructions" data-id="' + test.id + '">Start Test</button>';
      var reportHtml = latestSubmitted
        ? '<button class="button button-secondary js-open-result" data-id="' + latestSubmitted.id + '">Last Report</button>'
        : "";

      return (
        '<article class="dashboard-card">' +
          '<p class="section-label">Live mock</p>' +
          '<h3>' + escapeHtml(test.title) + '</h3>' +
          '<p>' + escapeHtml(test.subtitle) + '</p>' +
          '<div class="meta-row">' +
            '<span class="meta-chip">' + getTotalDuration(test) + ' mins total</span>' +
            '<span class="meta-chip">SUPR ' + test.sectionDurations.SUPR + 'm | REAP ' + test.sectionDurations.REAP + 'm</span>' +
            '<span class="meta-chip">' + test.questionIds.length + ' questions</span>' +
            '<span class="meta-chip">Locked sectional flow</span>' +
          '</div>' +
          '<div class="divider"></div>' +
          '<div class="button-row">' + actionHtml + reportHtml + '</div>' +
        '</article>'
      );
    }).join("");

    var recentAttempts = snapshot.attempts.length
      ? '<div class="attempt-list">' + snapshot.attempts.slice(0, 5).map(function (attempt) {
          var test = store.getTestById(attempt.testId);
          var stateLabel = attempt.status === "submitted"
            ? "Score " + attempt.result.score + " | Percentile " + attempt.result.percentile
            : "In progress";

          return (
            '<div class="attempt-item">' +
              '<strong>' + escapeHtml(test ? test.title : attempt.testId) + '</strong>' +
              '<div class="meta-row">' +
                '<span class="meta-chip">' + escapeHtml(stateLabel) + '</span>' +
                '<span class="meta-chip">' + new Date(attempt.updatedAt).toLocaleString() + '</span>' +
              '</div>' +
            '</div>'
          );
        }).join("") + '</div>'
      : '<div class="empty-state">No attempts yet. Start the first mock and the report will appear here.</div>';
    var reportsHtml = snapshot.attempts.filter(function (attempt) {
      return attempt.status === "submitted" && attempt.resultSnapshot;
    }).length
      ? '<div class="attempt-list">' + snapshot.attempts.filter(function (attempt) {
          return attempt.status === "submitted" && attempt.resultSnapshot;
        }).slice(0, 12).map(function (attempt) {
          var report = attempt.resultSnapshot || {};
          var savedResult = report.result || attempt.result || {};
          return (
            '<div class="attempt-item">' +
              '<strong>' + escapeHtml(report.testTitle || (store.getTestById(attempt.testId) || {}).title || attempt.testId) + '</strong>' +
              '<div class="meta-row">' +
                '<span class="meta-chip">Score ' + escapeHtml(savedResult.score) + '</span>' +
                '<span class="meta-chip">Percentile ' + escapeHtml(savedResult.percentile) + '</span>' +
                '<span class="meta-chip">' + escapeHtml(formatDateTime(report.submittedAt || attempt.submittedAt)) + '</span>' +
              '</div>' +
              '<div class="button-row" style="margin-top:10px;"><button class="button button-secondary js-open-result" data-id="' + attempt.id + '">Open Report</button></div>' +
            '</div>'
          );
        }).join("") + '</div>'
      : '<div class="empty-state">Submitted reports will stay here for later review.</div>';

    app.innerHTML = buildShell(
      '<section class="dashboard-hero">' +
        '<div class="dashboard-bar">' +
          '<div class="brand-mark"><span class="brand-dot"></span> AceIIIT</div>' +
          '<div class="button-row">' +
            (store.isAdmin(user) ? '<button class="button button-secondary" id="admin-link">Builder Mode</button>' : "") +
            '<button class="button button-secondary" id="logout-button">Logout</button>' +
          '</div>' +
        '</div>' +
        '<p class="section-label" style="margin-top: 18px;">Dashboard</p>' +
        '<h1>Ready for your next mock.</h1>' +
        '<p>Choose a paper, enter the instructions screen, and start the timed SUPR to REAP flow.</p>' +
      '</section>' +
      '<section class="dashboard-grid">' +
        '<div class="panel">' +
          '<p class="section-label">Available Tests</p>' +
          '<div class="dashboard-list">' + cards + '</div>' +
        '</div>' +
        '<aside class="panel">' +
          '<p class="section-label">Your Snapshot</p>' +
          '<div class="dashboard-stats">' +
            '<div class="summary-card"><strong>' + snapshot.completedCount + '</strong><span>Completed mocks</span></div>' +
            '<div class="summary-card"><strong>' + snapshot.bestScore + '</strong><span>Best score</span></div>' +
            '<div class="summary-card"><strong>' + snapshot.bestPercentile + '</strong><span>Best percentile</span></div>' +
          '</div>' +
          '<div class="divider"></div>' +
          '<p class="section-label">Recent Activity</p>' +
          recentAttempts +
          '<div class="divider"></div>' +
          '<p class="section-label">My Reports</p>' +
          reportsHtml +
        '</aside>' +
      '</section>'
    );

    document.getElementById("logout-button").addEventListener("click", function () {
      store.logout();
      stopRuntime(true);
      navigate("login");
    });

    var adminLink = document.getElementById("admin-link");
    if (adminLink) {
      adminLink.addEventListener("click", function () {
        navigate("admin");
      });
    }

    app.querySelectorAll(".js-open-instructions").forEach(function (button) {
      button.addEventListener("click", function () {
        navigate("instructions/" + button.dataset.id);
      });
    });

    app.querySelectorAll(".js-resume-test").forEach(function (button) {
      button.addEventListener("click", function () {
        var attempt = store.getOrCreateAttempt(user.id, button.dataset.id);
        navigate("test/" + attempt.id);
      });
    });

    app.querySelectorAll(".js-open-result").forEach(function (button) {
      button.addEventListener("click", function () {
        navigate("results/" + button.dataset.id);
      });
    });
  }

  function syncAndRenderCurrentRoute() {
    showOverlayLoader("Syncing the newest backend changes into this screen.");
    Promise.resolve(store.refreshFromRemote ? store.refreshFromRemote() : true).then(function () {
      renderRoute();
    }).catch(function () {
      renderRoute();
    }).finally(function () {
      window.requestAnimationFrame(function () {
        window.setTimeout(hideOverlayLoader, 180);
      });
    });
  }

  function startSyncPolling() {
    if (syncPollId) {
      window.clearInterval(syncPollId);
    }
    syncPollId = window.setInterval(function () {
      var parts = routeParts();
      var view = parts[0] || "";
      if (document.hidden) {
        return;
      }
      if (view === "dashboard" || view === "admin" || view === "admin-activity" || view === "results" || view === "") {
        Promise.resolve(store.refreshFromRemote ? store.refreshFromRemote() : true).then(function (result) {
          if (result && result.changed) {
            syncAndRenderCurrentRoute();
          }
        });
      }
    }, 4000);
  }

  function renderInstructions(user, testId) {
    var test = store.getTestById(testId);
    var questions = store.getQuestionsForTest(testId);
    var grouped = questions.reduce(function (accumulator, question) {
      accumulator[question.section] = accumulator[question.section] || [];
      accumulator[question.section].push(question);
      return accumulator;
    }, {});

    if (!test) {
      navigate("dashboard");
      return;
    }

    var suprMaxMarks = (grouped.SUPR || []).reduce(function (sum, question) {
      return sum + Number(question.marks || 0);
    }, 0);
    var reapMaxMarks = (grouped.REAP || []).reduce(function (sum, question) {
      return sum + Number(question.marks || 0);
    }, 0);
    var sectionSummary = [
      "SECTION 1: SUPR | Duration: " + test.sectionDurations.SUPR + " minutes | Maximum marks: " + suprMaxMarks,
      "SECTION 2: REAP | Duration: " + test.sectionDurations.REAP + " minutes | Maximum marks: " + reapMaxMarks,
      "Negative marking applies according to the penalty configured for each question."
    ];

    app.innerHTML = buildShell(
      '<section class="instructions-layout utility-layout">' +
        '<div class="instructions-bar">' +
          '<div class="brand-mark"><span class="brand-dot"></span> AceIIIT</div>' +
          '<div class="instructions-tabs">' +
            '<button class="tab-button is-active" type="button">Instructions</button>' +
            '<button class="tab-button" type="button" disabled>Question Paper</button>' +
          '</div>' +
        '</div>' +
        '<div class="utility-titlebar">Other Important Instructions</div>' +
        '<div class="instructions-utility-shell">' +
          '<div class="instructions-mainpane">' +
            '<div class="instructions-scrollpane">' +
              '<div class="instructions-copy">' +
                '<p class="instructions-centerhead">General instructions:</p>' +
                '<p>The motive for enabling this mock sample test is to familiarize candidates with the Computer Based Test environment of the UGEE-style examination conducted by AceIIIT.</p>' +
                '<p>The types of questions and marking scheme are only illustrative and are not intended to be an exact representation of the final live paper.</p>' +
                '<p><strong>Section wise instructions</strong></p>' +
                sectionSummary.map(function (item) {
                  return '<p>' + escapeHtml(item) + '</p>';
                }).join("") +
                '<p>No clarification will be provided during the exam. A built-in on-screen calculator is available from the question screen whenever the paper requires it. Answers are auto-saved on this device whenever you move between questions.</p>' +
                '<p>This test contains ' + questions.length + ' questions and the total duration is ' + getTotalDuration(test) + ' minutes.</p>' +
              '</div>' +
            '</div>' +
            '<label class="checkbox-row checkbox-row-utility">' +
              '<input type="checkbox" id="ready-check">' +
              '<span>I have read and understood the instructions. I agree to follow the test rules and I am ready to begin.</span>' +
            '</label>' +
            '<div class="utility-bottom-actions">' +
              '<button class="button button-secondary" id="back-dashboard">Previous</button>' +
              '<button class="button button-primary" id="begin-test" disabled>I am ready to begin</button>' +
            '</div>' +
          '</div>' +
          '<aside class="instructions-sidepane">' +
            '<div class="instructions-profilecard">' +
              '<div class="avatar avatar-large">' + escapeHtml(initials(user.name)) + '</div>' +
              '<strong>' + escapeHtml(user.name) + '</strong>' +
            '</div>' +
            '<div class="instructions-sideinfo">' +
              '<p><strong>Test:</strong> ' + escapeHtml(test.title) + '</p>' +
              '<p><strong>SUPR:</strong> ' + test.sectionDurations.SUPR + ' minutes</p>' +
              '<p><strong>REAP:</strong> ' + test.sectionDurations.REAP + ' minutes</p>' +
              '<p><strong>Questions:</strong> ' + questions.length + '</p>' +
            '</div>' +
          '</aside>' +
        '</div>' +
      '</section>'
    );

    var readyCheck = document.getElementById("ready-check");
    var beginButton = document.getElementById("begin-test");

    readyCheck.addEventListener("change", function () {
      beginButton.disabled = !readyCheck.checked;
    });

    document.getElementById("back-dashboard").addEventListener("click", function () {
      navigate("dashboard");
    });

    beginButton.addEventListener("click", function () {
      var attempt = store.getOrCreateAttempt(user.id, testId);
      navigate("test/" + attempt.id);
    });
  }

  function renderTest(user, attemptId) {
    var attempt = store.getAttemptById(attemptId);
    if (!attempt) {
      navigate("dashboard");
      return;
    }

    var test = store.getTestById(attempt.testId);
    var questions = store.getQuestionsForTest(attempt.testId);
    var suprQuestions = getSectionQuestions(questions, "SUPR");
    var reapQuestions = getSectionQuestions(questions, "REAP");

    function activateReap() {
      var firstReapQuestion = reapQuestions[0];
      if (!firstReapQuestion) {
        var autoSubmitted = store.submitAttempt(attempt.id);
        stopRuntime(false);
        navigate("results/" + autoSubmitted.id);
        return null;
      }

      flushQuestionTime();
      store.patchAttempt(attempt.id, function (draft) {
        draft.activeSection = "REAP";
        draft.currentSection = "REAP";
        draft.currentQuestionId = firstReapQuestion.id;
        draft.visited[firstReapQuestion.id] = true;
        draft.sectionTimers.SUPR.locked = true;
        draft.sectionTimers.SUPR.completedAt = draft.sectionTimers.SUPR.completedAt || new Date().toISOString();
        draft.sectionTimers.REAP.locked = false;
        draft.sectionTimers.REAP.startedAt = draft.sectionTimers.REAP.startedAt || new Date().toISOString();
      });
      runtime.questionId = null;
      runtime.pendingSectionTransition = null;
      return store.getAttemptById(attempt.id);
    }

    if (attempt.activeSection !== "REAP") {
      var suprTimeLeft = getSectionTimeLeft(attempt, "SUPR");
      if (suprTimeLeft <= 0 && !runtime.pendingSectionTransition) {
        runtime.pendingSectionTransition = {
          title: "SUPR time is over",
          message: "The SUPR timer has ended. Proceed to REAP now.",
          canReview: false
        };
      }
    }

    var activeSection = attempt.activeSection || "SUPR";
    var activeQuestions = activeSection === "REAP" ? reapQuestions : suprQuestions;
    var currentQuestion = activeQuestions.find(function (question) {
      return question.id === attempt.currentQuestionId;
    }) || activeQuestions[0];

    if (!currentQuestion) {
      var fallbackSubmitted = store.submitAttempt(attempt.id);
      stopRuntime(false);
      navigate("results/" + fallbackSubmitted.id);
      return;
    }

    var remainingSeconds = getSectionTimeLeft(attempt, activeSection);
    if (activeSection === "REAP" && remainingSeconds <= 0) {
      flushQuestionTime();
      var expiredAttempt = store.submitAttempt(attempt.id);
      stopRuntime(false);
      navigate("results/" + expiredAttempt.id);
      return;
    }

    store.patchAttempt(attempt.id, function (draft) {
      draft.currentQuestionId = currentQuestion.id;
      draft.currentSection = activeSection;
      draft.activeSection = activeSection;
      draft.visited[currentQuestion.id] = true;
    });
    attempt = store.getAttemptById(attempt.id);

    if (runtime.attemptId !== attempt.id) {
      stopRuntime(false);
      runtime.attemptId = attempt.id;
      runtime.questionId = currentQuestion.id;
      runtime.startedAt = Date.now();
    } else if (runtime.questionId !== currentQuestion.id) {
      runtime.questionId = currentQuestion.id;
      runtime.startedAt = Date.now();
    }

    var sectionQuestionNumber = activeQuestions.findIndex(function (question) {
      return question.id === currentQuestion.id;
    }) + 1;
    var answeredCount = questions.filter(function (question) {
      return attempt.answers[question.id] !== undefined && attempt.answers[question.id] !== null && attempt.answers[question.id] !== "";
    }).length;
    var statusCounts = {
      answered: 0,
      "not-answered": 0,
      "not-visited": 0,
      marked: 0,
      "answered-marked": 0
    };

    activeQuestions.forEach(function (question) {
      statusCounts[getQuestionStatus(attempt, question.id)] += 1;
    });

    app.innerHTML = buildShell(
      '<section class="exam-layout utility-layout">' +
        '<div class="exam-topbar">' +
          '<div class="brand-mark"><span class="brand-dot"></span> AceIIIT</div>' +
          '<div class="instructions-tabs">' +
            '<button class="tab-button js-open-instructions" data-test="' + test.id + '">Instructions</button>' +
            '<button class="tab-button is-active" type="button">Question Paper</button>' +
          '</div>' +
        '</div>' +
        '<div class="exam-paperbar">' +
          '<div class="exam-paper-tabs">' +
            '<button class="paper-tab is-active" type="button">' + escapeHtml(test.title) + '</button>' +
          '</div>' +
          '<div class="exam-timerline">' + activeSection + ' Time Left : <strong id="timer-display">' + formatTime(remainingSeconds) + '</strong></div>' +
        '</div>' +
        '<div class="exam-sectionheader">Sections</div>' +
        '<div class="exam-sectionbar">' +
          '<div class="exam-tabs">' +
            '<button class="tab-button ' + (activeSection === "SUPR" ? "is-active" : "") + '" data-section="SUPR" ' + (activeSection === "REAP" ? "disabled" : "") + '>SUPR</button>' +
            '<button class="tab-button ' + (activeSection === "REAP" ? "is-active" : "") + '" data-section="REAP" ' + (activeSection === "SUPR" ? "disabled" : "") + '>REAP</button>' +
          '</div>' +
          '<div class="exam-submeta">Question No. ' + sectionQuestionNumber + '</div>' +
        '</div>' +
        '<div class="exam-grid">' +
          '<div class="question-panel exam-mainpanel">' +
            '<article class="question-card exam-questioncard">' +
              '<div class="question-titlebar">Question No. ' + sectionQuestionNumber + '</div>' +
              '<div class="exam-questionbody">' +
                '<p class="exam-questiontext">' + escapeHtml(currentQuestion.prompt) + '</p>' +
                (currentQuestion.passage ? '<div class="passage exam-passage">' + escapeHtml(currentQuestion.passage) + '</div>' : "") +
                renderQuestionFigures(currentQuestion) +
                getCalculatorMarkup() +
                '<div class="options exam-options">' +
                  currentQuestion.options.map(function (option, index) {
                    var checked = String(attempt.answers[currentQuestion.id]) === String(index);
                    return (
                      '<label class="option-card exam-option ' + (checked ? "is-selected" : "") + '">' +
                        '<input type="radio" name="answer" value="' + index + '" ' + (checked ? "checked" : "") + '>' +
                        '<span>' + escapeHtml(option) + '</span>' +
                      '</label>'
                    );
                  }).join("") +
                '</div>' +
              '</div>' +
            '</article>' +
            '<div class="action-row exam-actionbar">' +
              '<button class="button button-secondary" id="prev-question">Previous</button>' +
              '<button class="button button-ghost" id="mark-next">Mark for Review & Next</button>' +
              '<button class="button button-secondary" id="clear-response">Clear Response</button>' +
              '<button class="button button-secondary" data-calc-toggle>' + (runtime.calculatorVisible ? "Hide Calculator" : "Show Calculator") + '</button>' +
              '<button class="button button-primary" id="save-next">Save & Next</button>' +
            '</div>' +
          '</div>' +
          '<aside class="question-sidebar exam-sidebar">' +
            '<div class="exam-candidatecard">' +
              '<div class="avatar avatar-large">' + escapeHtml(initials(user.name)) + '</div>' +
              '<strong>' + escapeHtml(user.name) + '</strong>' +
            '</div>' +
            '<div class="status-grid">' +
              '<div class="status-item"><span class="status-count answered">' + statusCounts.answered + '</span><span>Answered</span></div>' +
              '<div class="status-item"><span class="status-count not-answered">' + statusCounts["not-answered"] + '</span><span>Not Answered</span></div>' +
              '<div class="status-item"><span class="status-count not-visited">' + statusCounts["not-visited"] + '</span><span>Not Visited</span></div>' +
              '<div class="status-item"><span class="status-count marked">' + statusCounts.marked + '</span><span>Marked for Review</span></div>' +
              '<div class="status-item"><span class="status-count answered-marked">' + statusCounts["answered-marked"] + '</span><span>Answered & Marked</span></div>' +
            '</div>' +
            '<div class="exam-palettecard">' +
              '<div class="palette-head">' + activeSection + '</div>' +
              '<p class="palette-caption">Choose a Question</p>' +
              '<div class="palette-grid">' +
                activeQuestions.map(function (question, sectionIndex) {
                  var status = getQuestionStatus(attempt, question.id);
                  var currentClass = question.id === currentQuestion.id ? "is-current" : "";
                  return (
                    '<button class="palette-button status-' + status + ' ' + currentClass + '" data-question="' + question.id + '">' +
                      (sectionIndex + 1) +
                    '</button>'
                  );
                }).join("") +
              '</div>' +
            '</div>' +
            '<div class="legend-card submit-card exam-submitcard">' +
              '<div class="progress-line"><span style="width:' + (questions.length ? ((answeredCount / questions.length) * 100) : 0) + '%;"></span></div>' +
              '<p class="list-note">' + answeredCount + ' of ' + questions.length + ' answered across the paper.</p>' +
              '<button class="button button-danger" id="submit-test">Submit</button>' +
            '</div>' +
          '</aside>' +
        '</div>' +
        getSectionTransitionMarkup() +
        getInstructionsModalMarkup(user, test, questions) +
        getImageLightboxMarkup() +
        '<div class="exam-footerbar">Version: 17.07.00</div>' +
      '</section>'
    );

    app.querySelectorAll(".js-open-instructions").forEach(function (button) {
      button.addEventListener("click", function () {
        flushQuestionTime();
        runtime.instructionsPopupTestId = button.dataset.test;
        renderTest(user, attempt.id);
      });
    });

    app.querySelectorAll(".tab-button[data-section]").forEach(function (button) {
      button.addEventListener("click", function () {
        if (button.disabled) {
          return;
        }
        var targetSection = button.dataset.section;
        var targetQuestions = targetSection === "REAP" ? reapQuestions : suprQuestions;
        var firstQuestion = targetQuestions[0];
        if (!firstQuestion) {
          return;
        }
        flushQuestionTime();
        store.patchAttempt(attempt.id, function (draft) {
          draft.activeSection = targetSection;
          draft.currentSection = targetSection;
          draft.currentQuestionId = firstQuestion.id;
          draft.visited[firstQuestion.id] = true;
        });
        renderTest(user, attempt.id);
      });
    });

    app.querySelectorAll('input[name="answer"]').forEach(function (input) {
      input.addEventListener("change", function () {
        store.patchAttempt(attempt.id, function (draft) {
          draft.answers[currentQuestion.id] = Number(input.value);
        });
        renderTest(user, attempt.id);
      });
    });

    app.querySelectorAll(".palette-button[data-question]").forEach(function (button) {
      button.addEventListener("click", function () {
        flushQuestionTime();
        store.patchAttempt(attempt.id, function (draft) {
          draft.currentQuestionId = button.dataset.question;
          draft.currentSection = activeSection;
          draft.activeSection = activeSection;
          draft.visited[button.dataset.question] = true;
        });
        renderTest(user, attempt.id);
      });
    });

    function moveToQuestion(offset) {
      var currentIndex = activeQuestions.findIndex(function (question) {
        return question.id === currentQuestion.id;
      });
      var nextIndex = currentIndex + offset;
      if (nextIndex < 0 || nextIndex >= activeQuestions.length) {
        return;
      }

      var nextQuestion = activeQuestions[nextIndex];
      flushQuestionTime();
      store.patchAttempt(attempt.id, function (draft) {
        draft.currentQuestionId = nextQuestion.id;
        draft.currentSection = activeSection;
        draft.activeSection = activeSection;
        draft.visited[nextQuestion.id] = true;
      });
      renderTest(user, attempt.id);
    }

    document.getElementById("prev-question").addEventListener("click", function () {
      moveToQuestion(-1);
    });

    document.getElementById("save-next").addEventListener("click", function () {
      moveToQuestion(1);
    });

    document.getElementById("mark-next").addEventListener("click", function () {
      store.patchAttempt(attempt.id, function (draft) {
        draft.marked[currentQuestion.id] = true;
      });
      moveToQuestion(1);
    });

    document.getElementById("clear-response").addEventListener("click", function () {
      store.patchAttempt(attempt.id, function (draft) {
        delete draft.answers[currentQuestion.id];
      });
      renderTest(user, attempt.id);
    });

    document.getElementById("submit-test").addEventListener("click", function () {
      if (activeSection === "SUPR") {
        runtime.pendingSectionTransition = {
          title: "Submit SUPR",
          message: "Submit this section and move to REAP? After this, SUPR cannot be revisited.",
          canReview: true,
          mode: "section-submit"
        };
      } else {
        runtime.pendingSectionTransition = {
          title: "Submit test",
          message: "Submit the full paper now and generate the report?",
          canReview: true,
          mode: "submit"
        };
      }
      renderTest(user, attempt.id);
    });

    app.querySelectorAll("[data-close-instructions]").forEach(function (button) {
      button.addEventListener("click", function () {
        runtime.instructionsPopupTestId = null;
        renderTest(user, attempt.id);
      });
    });

    app.querySelectorAll("[data-transition-action]").forEach(function (button) {
      button.addEventListener("click", function () {
        var action = button.dataset.transitionAction;
        if (action === "cancel") {
          runtime.pendingSectionTransition = null;
          renderTest(user, attempt.id);
          return;
        }

        if (runtime.pendingSectionTransition && runtime.pendingSectionTransition.mode === "submit") {
          flushQuestionTime();
          var submittedAttempt = store.submitAttempt(attempt.id);
          stopRuntime(false);
          runtime.pendingSectionTransition = null;
          navigate("results/" + submittedAttempt.id);
          return;
        }

        attempt = activateReap();
        if (!attempt) {
          return;
        }
        renderTest(user, attempt.id);
      });
    });

    bindCalculatorHandlers(function () {
      renderTest(user, attempt.id);
    });
    bindImageLightbox(function () {
      renderTest(user, attempt.id);
    });

    if (runtime.timerId) {
      clearInterval(runtime.timerId);
    }

    runtime.timerId = window.setInterval(function () {
      var liveAttempt = store.getAttemptById(attempt.id);
      if (!liveAttempt || liveAttempt.status === "submitted") {
        stopRuntime(false);
        return;
      }

      if (liveAttempt.activeSection !== "REAP") {
        var suprLiveTimeLeft = getSectionTimeLeft(liveAttempt, "SUPR");
        if (suprLiveTimeLeft <= 0) {
          if (!runtime.pendingSectionTransition) {
            runtime.pendingSectionTransition = {
              title: "SUPR time is over",
              message: "The SUPR timer has ended. Proceed to REAP now.",
              canReview: false
            };
            renderTest(user, attempt.id);
          }
          return;
        }
      }

      var timerDisplay = document.getElementById("timer-display");
      var secondsLeft = getSectionTimeLeft(liveAttempt, liveAttempt.activeSection || activeSection);
      if (!timerDisplay) {
        return;
      }

      timerDisplay.textContent = formatTime(secondsLeft);
      timerDisplay.classList.toggle("is-warning", secondsLeft <= 600 && secondsLeft > 300);
      timerDisplay.classList.toggle("is-danger", secondsLeft <= 300);

      if (liveAttempt.activeSection === "REAP" && secondsLeft <= 0) {
        flushQuestionTime();
        var finished = store.submitAttempt(attempt.id);
        stopRuntime(false);
        navigate("results/" + finished.id);
      }
    }, 1000);
  }

  function renderResults(user, attemptId) {
    var attempt = store.getAttemptById(attemptId);
    if (!attempt || attempt.status !== "submitted" || !attempt.result) {
      navigate("dashboard");
      return;
    }

    var test = store.getTestById(attempt.testId);
    var savedSnapshot = attempt.resultSnapshot || null;
    var result = savedSnapshot && savedSnapshot.result ? savedSnapshot.result : attempt.result;
    var reportTitle = savedSnapshot && savedSnapshot.testTitle
      ? savedSnapshot.testTitle
      : (test ? test.title : "AceIIIT Mock Test");
    var topicBars = result.topicStats.length
      ? result.topicStats.map(function (topic) {
          return (
            '<div class="bar-item">' +
              '<div class="bar-head"><span>' + escapeHtml(topic.label) + '</span><span>' + topic.accuracy + '%</span></div>' +
              '<div class="bar-track"><span style="width:' + topic.accuracy + '%;"></span></div>' +
            '</div>'
          );
        }).join("")
      : '<div class="empty-state">No topic data available yet.</div>';

    var sectionBars = result.sectionStats.map(function (section) {
      return (
        '<div class="bar-item">' +
          '<div class="bar-head"><span>' + escapeHtml(section.label) + '</span><span>' + section.accuracy + '%</span></div>' +
          '<div class="bar-track"><span style="width:' + section.accuracy + '%;"></span></div>' +
        '</div>'
      );
    }).join("");

    var solutions = result.review.map(function (item, index) {
      var chipClass = item.chosenOption === null ? "neutral" : item.isCorrect ? "correct" : "incorrect";
      var chipText = item.chosenOption === null ? "Not attempted" : item.isCorrect ? "Correct" : "Incorrect";

      return (
        '<article class="solution-card">' +
          '<p class="section-label">Question ' + (index + 1) + '</p>' +
          '<h3>' + escapeHtml(item.prompt) + '</h3>' +
          (item.passage ? '<p class="question-copy">' + escapeHtml(item.passage) + '</p>' : "") +
          renderQuestionFigures(item) +
          '<div class="solution-meta">' +
            '<span class="answer-chip ' + chipClass + '">' + chipText + '</span>' +
            '<span class="meta-chip">' + escapeHtml(item.section) + '</span>' +
            '<span class="meta-chip">' + escapeHtml(item.topic.toUpperCase()) + '</span>' +
            '<span class="meta-chip">' + item.timeSpent + ' sec</span>' +
          '</div>' +
          '<p><strong>Your answer:</strong> ' + escapeHtml(item.chosenLabel) + '</p>' +
          '<p><strong>Correct answer:</strong> ' + escapeHtml(item.correctLabel) + '</p>' +
          '<p><strong>Reasoning:</strong> ' + escapeHtml(item.explanation) + '</p>' +
        '</article>'
      );
    }).join("");

    app.innerHTML = buildShell(
      '<section class="report-layout">' +
        '<div class="report-bar">' +
          '<div class="brand-mark"><span class="brand-dot"></span> AceIIIT</div>' +
          '<div class="button-row">' +
            '<button class="button button-secondary" id="back-dashboard">Dashboard</button>' +
            '<button class="button button-primary" id="retake-test">Retake</button>' +
          '</div>' +
        '</div>' +
        '<div class="report-body">' +
          '<div class="report-heading">' +
            '<p class="section-label">Report</p>' +
            '<h1>' + escapeHtml(reportTitle) + '</h1>' +
            '<p>' + escapeHtml(user.name) + ', here is the full performance summary with benchmark percentile, timing patterns, and solutions.</p>' +
          '</div>' +
          '<div class="report-grid">' +
            '<div class="report-card">' +
              '<p class="section-label">Performance summary</p>' +
              '<div class="summary-grid">' +
                '<div class="summary-card"><strong>' + result.score + '/' + result.maxScore + '</strong><span>Score</span></div>' +
                '<div class="summary-card"><strong>' + result.accuracy + '%</strong><span>Accuracy</span></div>' +
                '<div class="summary-card"><strong>' + result.rank + '</strong><span>Rank in benchmark cohort</span></div>' +
                '<div class="summary-card"><strong>' + result.percentile + '</strong><span>Percentile</span></div>' +
                '<div class="summary-card"><strong>' + result.correctCount + '</strong><span>Correct</span></div>' +
                '<div class="summary-card"><strong>' + result.unattemptedCount + '</strong><span>Unattempted</span></div>' +
              '</div>' +
              '<div class="divider"></div>' +
              '<p class="section-label">Topic performance</p>' +
              '<div class="bar-list">' + topicBars + '</div>' +
              '<div class="divider"></div>' +
              '<p class="section-label">Section performance</p>' +
              '<div class="bar-list">' + sectionBars + '</div>' +
            '</div>' +
            '<aside class="report-card">' +
              '<p class="section-label">Insights</p>' +
              '<div class="metric-grid">' +
                '<div class="metric-card"><strong>' + formatTime(result.averageTimeCorrect) + '</strong><span>Avg time on correct answers</span></div>' +
                '<div class="metric-card"><strong>' + formatTime(result.averageTimeWrong) + '</strong><span>Avg time on wrong answers</span></div>' +
              '</div>' +
              '<div class="divider"></div>' +
              '<ul>' + result.insights.map(function (item) {
                return '<li>' + escapeHtml(item) + '</li>';
              }).join("") + '</ul>' +
            '</aside>' +
          '</div>' +
          '<div class="report-card" style="margin-top: 20px;">' +
            '<p class="section-label">Solutions</p>' +
            '<div class="solution-list">' + solutions + '</div>' +
          '</div>' +
        '</div>' +
        getImageLightboxMarkup() +
      '</section>'
    );

    document.getElementById("back-dashboard").addEventListener("click", function () {
      navigate("dashboard");
    });

    document.getElementById("retake-test").addEventListener("click", function () {
      navigate("instructions/" + attempt.testId);
    });
    bindImageLightbox(function () {
      renderResults(user, attemptId);
    });
  }

  function renderAdmin(user, preferredTestId) {
    if (!store.isAdmin(user)) {
      navigate("dashboard");
      return;
    }

    var settings = store.getSettings();
    var questions = store.getQuestions();
    var tests = store.getTests();
    var adminSnapshot = store.getAdminSnapshot();
    var editingTest = runtime.adminEditingTestId ? store.getTestById(runtime.adminEditingTestId) : null;
    var editingQuestion = runtime.adminEditingQuestionId
      ? questions.find(function (question) { return question.id === runtime.adminEditingQuestionId; }) || null
      : null;
    runtime.adminSelectedTestId = preferredTestId || runtime.adminSelectedTestId;
    var selectedTestId = tests.some(function (test) {
      return test.id === runtime.adminSelectedTestId;
    })
      ? runtime.adminSelectedTestId
      : (tests[0] ? tests[0].id : "");
    var selectedTest = tests.find(function (test) {
      return test.id === selectedTestId;
    }) || null;
    var selectedTestQuestions = selectedTest
      ? questions.filter(function (question) {
          return selectedTest.questionIds.indexOf(question.id) !== -1;
        })
      : [];
    var selectedSuprCount = selectedTestQuestions.filter(function (question) {
      return question.section === "SUPR";
    }).length;
    var selectedReapCount = selectedTestQuestions.filter(function (question) {
      return question.section === "REAP";
    }).length;
    var questionUsage = {};
    var deletedQuestions = store.getDeletedQuestions();
    var deletedTests = store.getDeletedTests();
    var availableBankQuestions = questions.filter(function (question) {
      return !selectedTest || selectedTest.questionIds.indexOf(question.id) === -1;
    });
    var filteredBankQuestions = availableBankQuestions.filter(function (question) {
      var matchesQuery = !runtime.adminBankQuery || (question.id + " " + question.prompt + " " + question.topic).toLowerCase().indexOf(runtime.adminBankQuery.toLowerCase()) !== -1;
      var matchesSection = runtime.adminBankSectionFilter === "all" || question.section === runtime.adminBankSectionFilter;
      return matchesQuery && matchesSection;
    });

    tests.forEach(function (test) {
      test.questionIds.forEach(function (questionId) {
        questionUsage[questionId] = questionUsage[questionId] || [];
        questionUsage[questionId].push(test.title);
      });
    });

    app.innerHTML = buildShell(
      '<section class="admin-layout">' +
        '<div class="admin-bar">' +
          '<div class="brand-mark"><span class="brand-dot"></span> AceIIIT</div>' +
          '<div class="button-row">' +
            '<button class="button button-secondary" id="back-dashboard">Dashboard</button>' +
            '<button class="button button-danger" id="download-data">Export data</button>' +
          '</div>' +
        '</div>' +
        '<div class="admin-body">' +
          '<div class="admin-heading">' +
            '<p class="section-label">Builder mode</p>' +
            '<h1>Configure tests and questions.</h1>' +
            '<p>Create the test first, then attach questions directly to that paper.</p>' +
            '<div class="button-row" style="margin-top: 14px;"><button class="button button-secondary" id="open-activity">Open Student Activity</button></div>' +
          '</div>' +
          '<div class="admin-grid">' +
            '<div class="admin-card">' +
              '<p class="section-label">Create test</p>' +
              '<form id="test-form">' +
                '<div class="grid-two">' +
                  '<div class="field"><label for="test-title">Title</label><input id="test-title" name="title" value="' + escapeAttribute(editingTest ? editingTest.title : "") + '" required></div>' +
                  '<div class="field"><label for="test-subtitle">Subtitle</label><input id="test-subtitle" name="subtitle" value="' + escapeAttribute(editingTest ? editingTest.subtitle : "") + '" required></div>' +
                  '<div class="field"><label for="test-id">Test ID</label><input id="test-id" name="id" placeholder="Optional custom id" value="' + escapeAttribute(editingTest ? editingTest.id : "") + '" ' + (editingTest ? 'disabled' : '') + '></div>' +
                  '<div class="field"><label for="test-benchmark">Benchmark scores</label><input id="test-benchmark" name="benchmarkScores" placeholder="18,22,26,31" value="' + escapeAttribute(editingTest ? editingTest.benchmarkScores.join(",") : "") + '"></div>' +
                  '<div class="field"><label for="supr-duration">SUPR duration (minutes)</label><input id="supr-duration" name="suprDurationMinutes" type="number" value="' + (editingTest ? editingTest.sectionDurations.SUPR : 60) + '" required></div>' +
                  '<div class="field"><label for="reap-duration">REAP duration (minutes)</label><input id="reap-duration" name="reapDurationMinutes" type="number" value="' + (editingTest ? editingTest.sectionDurations.REAP : 120) + '" required></div>' +
                '</div>' +
                '<div class="field" style="margin-top: 16px;"><label for="test-instructions">Instructions (one line each)</label><textarea id="test-instructions" name="instructions" rows="4">' + escapeHtml(editingTest ? editingTest.instructions.join("\n") : 'Read all instructions carefully.\nSUPR locks after its timer or after every SUPR question is answered.\nREAP opens automatically and the test submits when the REAP timer ends.') + '</textarea></div>' +
                '<div class="button-row" style="margin-top: 18px;">' +
                  '<button class="button button-primary" type="submit">' + (editingTest ? 'Update test' : 'Create test') + '</button>' +
                  (editingTest ? '<button class="button button-secondary" type="button" id="cancel-test-edit">Cancel Edit</button>' : '') +
                '</div>' +
              '</form>' +
            '</div>' +
            '<aside class="admin-card">' +
              '<p class="section-label">Access control</p>' +
              '<form id="settings-form">' +
                '<div class="field"><label for="student-access-code">Student access code</label><input id="student-access-code" name="studentAccessCode" value="' + escapeHtml(settings.studentAccessCode) + '" required></div>' +
                '<div class="field"><label for="allowlist-enabled">Verified email gate</label><select id="allowlist-enabled" name="allowlistEnabled"><option value="off"' + (!settings.allowlistEnabled ? ' selected' : '') + '>Off</option><option value="on"' + (settings.allowlistEnabled ? ' selected' : '') + '>On</option></select></div>' +
                '<div class="field" style="grid-column: 1 / -1;"><label for="allowlist-sheet-url">Google Sheet CSV URL</label><input id="allowlist-sheet-url" name="allowlistSheetUrl" value="' + escapeAttribute(settings.allowlistSheetUrl || "") + '" placeholder="Published CSV link from Google Sheets"></div>' +
                '<div class="field" style="grid-column: 1 / -1;"><label for="allowed-emails">Verified emails</label><textarea id="allowed-emails" name="allowedEmails" rows="6" placeholder="student1@example.com&#10;student2@example.com">' + escapeHtml((settings.allowedEmails || []).join("\n")) + '</textarea><div class="helper-text">Paste verified emails here, one per line, or import them from a published Google Sheet CSV.</div></div>' +
                '<div class="button-row" style="margin-top: 14px;"><button class="button button-secondary" type="submit">Save Access Settings</button><button class="button button-primary" type="button" id="save-allowlist-settings">Save Verified List</button></div>' +
                '<div class="button-row"><button class="button button-secondary button-compact" type="button" id="import-sheet-allowlist">Import Sheet Emails</button><button class="button button-secondary button-compact" type="button" id="dedupe-allowlist">Clean Email List</button></div>' +
              '</form>' +
              '<div class="divider"></div>' +
              '<div class="metric-grid">' +
                '<div class="metric-card"><strong>' + tests.length + '</strong><span>Tests</span></div>' +
                '<div class="metric-card"><strong>' + questions.length + '</strong><span>Questions</span></div>' +
                '<div class="metric-card"><strong>' + tests.reduce(function (sum, test) { return sum + test.questionIds.length; }, 0) + '</strong><span>Attached questions</span></div>' +
                '<div class="metric-card"><strong>' + settings.studentAccessCode.length + '</strong><span>Access code characters</span></div>' +
              '</div>' +
              '<div class="divider"></div>' +
              '<p class="section-label">Firebase storage</p>' +
              '<form id="firebase-form" class="grid-two">' +
                '<div class="field"><label for="fb-api-key">API key</label><input id="fb-api-key" name="apiKey" value="' + escapeAttribute(settings.firebaseConfig && settings.firebaseConfig.apiKey || "") + '"></div>' +
                '<div class="field"><label for="fb-app-id">App ID</label><input id="fb-app-id" name="appId" value="' + escapeAttribute(settings.firebaseConfig && settings.firebaseConfig.appId || "") + '"></div>' +
                '<div class="field"><label for="fb-project-id">Project ID</label><input id="fb-project-id" name="projectId" value="' + escapeAttribute(settings.firebaseConfig && settings.firebaseConfig.projectId || "") + '"></div>' +
                '<div class="field"><label for="fb-storage-bucket">Storage bucket</label><input id="fb-storage-bucket" name="storageBucket" value="' + escapeAttribute(settings.firebaseConfig && settings.firebaseConfig.storageBucket || "") + '"></div>' +
                '<div class="button-row" style="grid-column: 1 / -1;"><button class="button button-secondary" type="submit">Save Firebase Config</button></div>' +
              '</form>' +
              (selectedTest ? (
                '<div class="divider"></div>' +
                '<p class="section-label">Active paper</p>' +
                '<div class="meta-row">' +
                  '<span class="meta-chip">' + escapeHtml(selectedTest.title) + '</span>' +
                  '<span class="meta-chip">SUPR ' + selectedSuprCount + '</span>' +
                  '<span class="meta-chip">REAP ' + selectedReapCount + '</span>' +
                  '<span class="meta-chip">' + selectedTest.sectionDurations.SUPR + 'm / ' + selectedTest.sectionDurations.REAP + 'm</span>' +
                  '<span class="meta-chip ' + (selectedTest.status === "live" ? 'is-live' : 'is-draft') + '">' + escapeHtml(selectedTest.status || "draft") + '</span>' +
                '</div>'
              ) : "") +
            '</aside>' +
          '</div>' +
          '<div class="admin-grid" style="margin-top: 20px;">' +
            '<div class="admin-card">' +
              '<p class="section-label">Add question</p>' +
              (tests.length ? (
                '<form id="question-form" class="grid-two">' +
                  '<div class="field"><label for="question-test">Attach to test</label><select id="question-test" name="testId" required>' +
                    tests.map(function (test) {
                      return '<option value="' + escapeHtml(test.id) + '" ' + (test.id === selectedTestId ? "selected" : "") + '>' + escapeHtml(test.title) + '</option>';
                    }).join("") +
                  '</select></div>' +
                  '<div class="field"><label for="question-section">Section</label><select id="question-section" name="section"><option ' + (editingQuestion && editingQuestion.section === "SUPR" ? 'selected' : '') + '>SUPR</option><option ' + (editingQuestion && editingQuestion.section === "REAP" ? 'selected' : '') + '>REAP</option></select></div>' +
                  '<div class="field"><label for="question-topic">Topic</label><input id="question-topic" name="topic" placeholder="logic / DI / comprehension" value="' + escapeAttribute(editingQuestion ? editingQuestion.topic : "") + '" required></div>' +
                  '<div class="field"><label for="question-difficulty">Difficulty</label><select id="question-difficulty" name="difficulty"><option ' + (editingQuestion && editingQuestion.difficulty === "easy" ? 'selected' : '') + '>easy</option><option ' + (editingQuestion && editingQuestion.difficulty === "medium" ? 'selected' : '') + '>medium</option><option ' + (editingQuestion && editingQuestion.difficulty === "hard" ? 'selected' : '') + '>hard</option></select></div>' +
                  '<div class="field"><label for="question-id">Question ID</label><input id="question-id" name="id" placeholder="Optional custom id" value="' + escapeAttribute(editingQuestion ? editingQuestion.id : "") + '" ' + (editingQuestion ? 'disabled' : '') + '></div>' +
                  (editingQuestion && getQuestionImageUrls(editingQuestion).length ? '<div class="field" style="grid-column: 1 / -1;"><label>Existing uploaded images</label><div class="helper-text">' + escapeHtml(getQuestionImageUrls(editingQuestion).length + " image(s) already attached") + '</div></div>' : '') +
                  '<div class="field" style="grid-column: 1 / -1;"><label for="question-files">Upload local images</label><input id="question-files" name="questionFiles" type="file" multiple accept="image/*"><div class="helper-text">Images are saved for cross-device use. If Firebase Storage is unavailable, the portal uses a compressed backend fallback.</div></div>' +
                  '<div class="field" style="grid-column: 1 / -1;"><label for="question-prompt">Question prompt</label><textarea id="question-prompt" name="prompt" rows="4" required>' + escapeHtml(editingQuestion ? editingQuestion.prompt : "") + '</textarea></div>' +
                  '<div class="field" style="grid-column: 1 / -1;"><label for="question-passage">Passage or context</label><textarea id="question-passage" name="passage" rows="4" placeholder="Optional">' + escapeHtml(editingQuestion ? editingQuestion.passage || "" : "") + '</textarea></div>' +
                  '<div class="field"><label for="option-0">Option A</label><input id="option-0" name="option0" value="' + escapeAttribute(editingQuestion ? editingQuestion.options[0] : "") + '" required></div>' +
                  '<div class="field"><label for="option-1">Option B</label><input id="option-1" name="option1" value="' + escapeAttribute(editingQuestion ? editingQuestion.options[1] : "") + '" required></div>' +
                  '<div class="field"><label for="option-2">Option C</label><input id="option-2" name="option2" value="' + escapeAttribute(editingQuestion ? editingQuestion.options[2] : "") + '" required></div>' +
                  '<div class="field"><label for="option-3">Option D</label><input id="option-3" name="option3" value="' + escapeAttribute(editingQuestion ? editingQuestion.options[3] : "") + '" required></div>' +
                  '<div class="field"><label for="correct-option">Correct option</label><select id="correct-option" name="correctOption"><option value="0" ' + (editingQuestion && Number(editingQuestion.correctOption) === 0 ? 'selected' : '') + '>A</option><option value="1" ' + (editingQuestion && Number(editingQuestion.correctOption) === 1 ? 'selected' : '') + '>B</option><option value="2" ' + (editingQuestion && Number(editingQuestion.correctOption) === 2 ? 'selected' : '') + '>C</option><option value="3" ' + (editingQuestion && Number(editingQuestion.correctOption) === 3 ? 'selected' : '') + '>D</option></select></div>' +
                  '<div class="field"><label for="question-marks">Marks</label><input id="question-marks" name="marks" type="number" step="any" value="' + (editingQuestion ? editingQuestion.marks : 4) + '"></div>' +
                  '<div class="field"><label for="question-negative">Negative marks</label><input id="question-negative" name="negativeMarks" type="number" step="any" value="' + (editingQuestion ? Math.abs(editingQuestion.negativeMarks) : 1) + '"></div>' +
                  '<div class="field" style="grid-column: 1 / -1;"><label for="question-explanation">Solution</label><textarea id="question-explanation" name="explanation" rows="4" required>' + escapeHtml(editingQuestion ? editingQuestion.explanation : "") + '</textarea></div>' +
                  '<div class="button-row" style="grid-column: 1 / -1;"><button class="button button-primary" type="submit">' + (editingQuestion ? 'Update question' : 'Add question') + '</button>' + (editingQuestion ? '<button class="button button-secondary" type="button" id="cancel-question-edit">Cancel Edit</button>' : '') + '</div>' +
                '</form>'
              ) : '<div class="empty-state">Create a test first. As soon as a paper exists, you can add questions directly into it here.</div>') +
              (selectedTest ? (
                '<div class="divider"></div>' +
                '<p class="section-label">Questions In Selected Test</p>' +
                (selectedTestQuestions.length ? (
                  '<div class="question-bank compact-bank">' +
                    selectedTestQuestions.map(function (question, index) {
                      return '<div class="bank-item"><strong>Q' + (index + 1) + ' | ' + escapeHtml(question.id) + ' | ' + escapeHtml(question.section) + '</strong><span>' + escapeHtml(question.prompt) + '</span><span class="helper-text">' + escapeHtml(question.topic) + ' | ' + escapeHtml(question.difficulty) + '</span><div class="button-row"><button class="button button-secondary button-compact js-edit-question-inline" data-id="' + escapeAttribute(question.id) + '">Edit Question</button><button class="button button-secondary button-compact js-detach-question" data-id="' + escapeAttribute(question.id) + '">Remove From Test</button></div></div>';
                    }).join("") +
                  '</div>'
                ) : '<div class="empty-state">No questions attached to this test yet.</div>')
              ) : '') +
              (selectedTest ? (
                '<div class="divider"></div>' +
                '<p class="section-label">Add existing question to selected test</p>' +
                '<div class="admin-bank-toolbar">' +
                  '<div class="field"><label for="bank-search">Search question</label><input id="bank-search" value="' + escapeAttribute(runtime.adminBankQuery) + '" placeholder="Search by id, topic, prompt"></div>' +
                  '<div class="field"><label for="bank-filter">Filter section</label><select id="bank-filter"><option value="all"' + (runtime.adminBankSectionFilter === "all" ? ' selected' : '') + '>All</option><option value="SUPR"' + (runtime.adminBankSectionFilter === "SUPR" ? ' selected' : '') + '>SUPR</option><option value="REAP"' + (runtime.adminBankSectionFilter === "REAP" ? ' selected' : '') + '>REAP</option></select></div>' +
                '</div>' +
                (filteredBankQuestions.length ? '<div class="question-bank compact-bank">' +
                  filteredBankQuestions.map(function (question) {
                    return '<div class="bank-item"><strong>' + highlightMatch(question.id, runtime.adminBankQuery) + ' | ' + escapeHtml(question.section) + '</strong><span>' + highlightMatch(question.prompt, runtime.adminBankQuery) + '</span><div class="button-row"><button class="button button-secondary js-attach-question" data-question="' + escapeAttribute(question.id) + '">Add to test</button></div></div>';
                  }).join("") +
                '</div>' : '<div class="empty-state">No matching question found for this selected test.</div>')
              ) : '') +
            '</div>' +
            '<aside class="admin-card">' +
              '<p class="section-label">Existing tests</p>' +
              (tests.length ? (
                '<div class="table-like tests-table">' +
                  '<div class="table-row header"><span>Test</span><span>Questions</span><span>SUPR / REAP</span><span>ID</span><span>Action</span></div>' +
                  tests.map(function (test) {
                    return '<div class="table-row"><span class="' + (test.status === "live" ? 'test-title-live' : '') + '">' + escapeHtml(test.title) + '<br><small>' + escapeHtml(test.status || "draft") + '</small></span><span>' + test.questionIds.length + '</span><span>' + test.sectionDurations.SUPR + ' / ' + test.sectionDurations.REAP + ' min</span><span>' + escapeHtml(test.id) + '</span><span><div class="button-row"><button class="button button-secondary js-pick-test" data-id="' + escapeHtml(test.id) + '">' + (test.id === selectedTestId ? 'Using' : 'Use') + '</button><button class="button button-secondary js-edit-test" data-id="' + escapeHtml(test.id) + '">Edit</button><button class="button button-secondary js-toggle-live" data-id="' + escapeHtml(test.id) + '">' + (test.status === "live" ? 'Unlive' : 'Make Live') + '</button><button class="button button-secondary js-export-pdf" data-id="' + escapeHtml(test.id) + '">PDF</button><button class="button button-danger js-delete-test" data-id="' + escapeHtml(test.id) + '">Delete</button></div></span></div>';
                  }).join("") +
                '</div>'
              ) : '<div class="empty-state">No tests created yet.</div>') +
              '<div class="divider"></div>' +
              '<p class="section-label">Deleted tests</p>' +
              (deletedTests.length ? (
                '<div class="question-bank compact-bank">' +
                  deletedTests.map(function (test) {
                    return '<div class="bank-item"><strong>' + escapeHtml(test.title) + '</strong><span>' + escapeHtml(test.id) + '</span><span class="helper-text">Deleted: ' + escapeHtml(formatDateTime(test.deletedAt)) + '</span><div class="button-row"><button class="button button-secondary js-restore-test" data-id="' + escapeAttribute(test.id) + '">Restore</button><button class="button button-danger js-delete-test-forever" data-id="' + escapeAttribute(test.id) + '">Delete Forever</button></div></div>';
                  }).join("") +
                '</div>'
              ) : '<div class="empty-state">No deleted tests.</div>') +
              '<div class="divider"></div>' +
              '<p class="section-label">Question bank</p>' +
              (questions.length ? (
                '<div class="question-bank">' +
                  questions.map(function (question) {
                    var attachedTo = questionUsage[question.id] || [];
                    return (
                      '<div class="bank-item">' +
                        '<strong>' + escapeHtml(question.id) + ' | ' + escapeHtml(question.section) + ' | ' + escapeHtml(question.topic) + '</strong>' +
                        '<span>' + escapeHtml(question.prompt) + '</span>' +
                        '<span class="helper-text">' + (attachedTo.length ? 'Attached to: ' + escapeHtml(attachedTo.join(", ")) : 'Not attached') + '</span>' +
                        '<div class="button-row"><button class="button button-secondary button-compact js-edit-question" data-id="' + escapeAttribute(question.id) + '">Edit</button><button class="button button-secondary button-compact js-detach-question" data-id="' + escapeAttribute(question.id) + '">Remove From Selected</button><button class="button button-danger button-compact js-delete-question" data-id="' + escapeAttribute(question.id) + '">Delete</button></div>' +
                      '</div>'
                    );
                  }).join("") +
                '</div>'
              ) : '<div class="empty-state">No questions created yet.</div>') +
              '<div class="divider"></div>' +
              '<p class="section-label">Recycle bin</p>' +
              (deletedQuestions.length ? (
                '<div class="question-bank compact-bank">' +
                  deletedQuestions.map(function (question) {
                    return '<div class="bank-item"><strong>' + escapeHtml(question.id) + ' | ' + escapeHtml(question.section) + ' | ' + escapeHtml(question.topic) + '</strong><span>' + escapeHtml(question.prompt) + '</span><span class="helper-text">Deleted: ' + escapeHtml(formatDateTime(question.deletedAt)) + '</span><div class="button-row"><button class="button button-secondary js-restore-question" data-id="' + escapeAttribute(question.id) + '">Restore</button><button class="button button-danger js-delete-forever" data-id="' + escapeAttribute(question.id) + '">Delete Forever</button></div></div>';
                  }).join("") +
                '</div>'
              ) : '<div class="empty-state">Recycle bin is empty.</div>') +
            '</aside>' +
          '</div>' +
        '</div>' +
      '</section>'
    );

    document.getElementById("open-activity").addEventListener("click", function () {
      navigate("admin-activity");
    });

    var testForm = document.getElementById("test-form");
    var settingsForm = document.getElementById("settings-form");
    var firebaseForm = document.getElementById("firebase-form");
    var questionForm = document.getElementById("question-form");
    var testDraftContext = runtime.adminEditingTestId ? ("edit:" + runtime.adminEditingTestId) : "create";
    var questionDraftContext = (runtime.adminEditingQuestionId ? ("edit:" + runtime.adminEditingQuestionId) : "create") + "|test:" + (selectedTestId || "");

    restoreDraft(testForm, ADMIN_TEST_DRAFT_KEY, testDraftContext);
    restoreDraft(settingsForm, ADMIN_SETTINGS_DRAFT_KEY, "global");
    restoreDraft(firebaseForm, ADMIN_FIREBASE_DRAFT_KEY, "global");
    restoreDraft(questionForm, ADMIN_QUESTION_DRAFT_KEY, questionDraftContext);

    bindDraftAutosave(testForm, ADMIN_TEST_DRAFT_KEY, function () { return testDraftContext; });
    bindDraftAutosave(settingsForm, ADMIN_SETTINGS_DRAFT_KEY, function () { return "global"; });
    bindDraftAutosave(firebaseForm, ADMIN_FIREBASE_DRAFT_KEY, function () { return "global"; });
    bindDraftAutosave(questionForm, ADMIN_QUESTION_DRAFT_KEY, function () { return questionDraftContext; });

    document.getElementById("back-dashboard").addEventListener("click", function () {
      navigate("dashboard");
    });

    document.getElementById("settings-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var form = new FormData(event.currentTarget);
      var allowlistSettings = collectAllowlistSettings();
      store.updateSettings({
        studentAccessCode: form.get("studentAccessCode"),
        allowlistEnabled: allowlistSettings.allowlistEnabled,
        allowedEmails: allowlistSettings.allowedEmails,
        allowlistSheetUrl: allowlistSettings.allowlistSheetUrl
      });
      clearLocalDraft(ADMIN_SETTINGS_DRAFT_KEY);
      rerenderAdminPreserveScroll(user, selectedTestId);
    });

    var saveAllowlistButton = document.getElementById("save-allowlist-settings");
    if (saveAllowlistButton) {
      saveAllowlistButton.addEventListener("click", function () {
        var allowlistSettings = collectAllowlistSettings();
        store.updateSettings({
          allowlistEnabled: allowlistSettings.allowlistEnabled,
          allowedEmails: allowlistSettings.allowedEmails,
          allowlistSheetUrl: allowlistSettings.allowlistSheetUrl
        });
        clearLocalDraft(ADMIN_SETTINGS_DRAFT_KEY);
        rerenderAdminPreserveScroll(user, selectedTestId);
      });
    }

    var importAllowlistButton = document.getElementById("import-sheet-allowlist");
    if (importAllowlistButton) {
      importAllowlistButton.addEventListener("click", function () {
        var sheetInput = document.getElementById("allowlist-sheet-url");
        var listInput = document.getElementById("allowed-emails");
        var sheetUrl = String(sheetInput ? sheetInput.value : "").trim();
        if (!sheetUrl) {
          window.alert("Paste the published Google Sheet CSV URL first.");
          return;
        }
        importAllowlistButton.disabled = true;
        importAllowlistButton.textContent = "Importing...";
        fetch(sheetUrl).then(function (response) {
          if (!response.ok) {
            throw new Error("Could not fetch the Google Sheet CSV.");
          }
          return response.text();
        }).then(function (csvText) {
          var imported = extractEmailsFromCsv(csvText);
          if (!imported.length) {
            throw new Error("No emails were found in the sheet.");
          }
          var existing = parseAllowlistText(listInput ? listInput.value : "");
          var merged = existing.concat(imported).filter(function (item, index, items) {
            return items.indexOf(item) === index;
          });
          if (listInput) {
            listInput.value = merged.join("\n");
          }
          store.updateSettings({
            allowlistEnabled: document.getElementById("allowlist-enabled") ? document.getElementById("allowlist-enabled").value === "on" : false,
            allowlistSheetUrl: sheetUrl,
            allowedEmails: merged
          });
          rerenderAdminPreserveScroll(user, selectedTestId);
        }).catch(function (error) {
          window.alert(error && error.message ? error.message : "Could not import the sheet emails.");
        }).finally(function () {
          importAllowlistButton.disabled = false;
          importAllowlistButton.textContent = "Import Sheet Emails";
        });
      });
    }

    var cleanAllowlistButton = document.getElementById("dedupe-allowlist");
    if (cleanAllowlistButton) {
      cleanAllowlistButton.addEventListener("click", function () {
        var listInput = document.getElementById("allowed-emails");
        var cleaned = parseAllowlistText(listInput ? listInput.value : "");
        if (listInput) {
          listInput.value = cleaned.join("\n");
        }
      });
    }

    document.getElementById("firebase-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var form = new FormData(event.currentTarget);
      var firebaseConfig = {
        apiKey: String(form.get("apiKey") || "").trim(),
        appId: String(form.get("appId") || "").trim(),
        projectId: String(form.get("projectId") || "").trim(),
        storageBucket: String(form.get("storageBucket") || "").trim()
      };
      store.updateSettings({
        firebaseConfig: firebaseConfig.apiKey ? firebaseConfig : null
      });
      if (firebaseBridge) {
        firebaseBridge.setConfig(firebaseConfig.apiKey ? firebaseConfig : null);
      }
      clearLocalDraft(ADMIN_FIREBASE_DRAFT_KEY);
      rerenderAdminPreserveScroll(user, selectedTestId);
    });

    document.getElementById("test-form").addEventListener("submit", function (event) {
      event.preventDefault();
      var form = new FormData(event.currentTarget);
      var payload = {
        id: form.get("id"),
        title: form.get("title"),
        subtitle: form.get("subtitle"),
        suprDurationMinutes: form.get("suprDurationMinutes"),
        reapDurationMinutes: form.get("reapDurationMinutes"),
        instructions: String(form.get("instructions"))
          .split(/\r?\n/)
          .map(function (item) { return item.trim(); })
          .filter(Boolean),
        benchmarkScores: String(form.get("benchmarkScores") || "")
          .split(",")
          .map(function (item) { return Number(item.trim()); })
          .filter(function (item) { return Number.isFinite(item); })
      };
      var savedTest = runtime.adminEditingTestId
        ? store.updateTest(runtime.adminEditingTestId, payload)
        : store.createTest(payload);
      runtime.adminEditingTestId = null;
      runtime.adminSelectedTestId = savedTest.id;
      clearLocalDraft(ADMIN_TEST_DRAFT_KEY);
      rerenderAdminPreserveScroll(user, savedTest.id);
    });

    var cancelTestEdit = document.getElementById("cancel-test-edit");
    if (cancelTestEdit) {
      cancelTestEdit.addEventListener("click", function () {
        runtime.adminEditingTestId = null;
        clearLocalDraft(ADMIN_TEST_DRAFT_KEY);
        rerenderAdminPreserveScroll(user, selectedTestId);
      });
    }

    if (questionForm) {
      questionForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        var submitButton = event.currentTarget.querySelector('button[type="submit"]');
        var originalLabel = submitButton ? submitButton.textContent : "";
        if (submitButton) {
          submitButton.disabled = true;
          submitButton.textContent = "Saving...";
        }
        try {
          var form = new FormData(event.currentTarget);
          var activeTestId = String(form.get("testId") || "");
          var selectedFiles = event.currentTarget.querySelector("#question-files").files;
          runtime.adminSelectedTestId = activeTestId;
          var uploadedImages = await readFilesAsUrls(
            selectedFiles,
            activeTestId,
            runtime.adminEditingQuestionId || form.get("id")
          );
          var payload = {
            testId: activeTestId,
            id: form.get("id"),
            section: form.get("section"),
            topic: form.get("topic"),
            difficulty: form.get("difficulty"),
            prompt: form.get("prompt"),
            passage: form.get("passage"),
            imageUrls: (editingQuestion ? getQuestionImageUrls(editingQuestion) : []).concat(uploadedImages),
            options: [form.get("option0"), form.get("option1"), form.get("option2"), form.get("option3")],
            correctOption: form.get("correctOption"),
            explanation: form.get("explanation"),
            marks: form.get("marks"),
            negativeMarks: form.get("negativeMarks")
          };
          if (runtime.adminEditingQuestionId) {
            store.updateQuestion(runtime.adminEditingQuestionId, payload);
            if (activeTestId) {
              store.attachQuestionToTest(activeTestId, runtime.adminEditingQuestionId);
            }
          } else {
            store.createQuestion(payload);
          }
          runtime.adminEditingQuestionId = null;
          clearLocalDraft(ADMIN_QUESTION_DRAFT_KEY);
          rerenderAdminPreserveScroll(user, activeTestId);
        } catch (error) {
          window.alert("Question could not be saved with this image. Please try a smaller image or JPG/PNG file. " + (error && error.message ? error.message : ""));
        } finally {
          if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = originalLabel || "Add question";
          }
        }
      });
    }

    var cancelQuestionEdit = document.getElementById("cancel-question-edit");
    if (cancelQuestionEdit) {
      cancelQuestionEdit.addEventListener("click", function () {
        runtime.adminEditingQuestionId = null;
        clearLocalDraft(ADMIN_QUESTION_DRAFT_KEY);
        rerenderAdminPreserveScroll(user, selectedTestId);
      });
    }

    document.getElementById("download-data").addEventListener("click", function () {
      var blob = new Blob([store.exportData()], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = "aceiiit-portal-backup.json";
      link.click();
      URL.revokeObjectURL(url);
    });

    app.querySelectorAll(".js-pick-test").forEach(function (button) {
      button.addEventListener("click", function () {
        runtime.adminSelectedTestId = button.dataset.id;
        rerenderAdminPreserveScroll(user, button.dataset.id);
      });
    });

    app.querySelectorAll(".js-edit-test").forEach(function (button) {
      button.addEventListener("click", function () {
        runtime.adminEditingTestId = button.dataset.id;
        rerenderAdminPreserveScroll(user, button.dataset.id);
      });
    });

    app.querySelectorAll(".js-toggle-live").forEach(function (button) {
      button.addEventListener("click", function () {
        var test = store.getTestById(button.dataset.id);
        store.updateTest(button.dataset.id, {
          status: test.status === "live" ? "draft" : "live"
        });
        rerenderAdminPreserveScroll(user, selectedTestId);
      });
    });

    app.querySelectorAll(".js-delete-test").forEach(function (button) {
      button.addEventListener("click", function () {
        store.deleteTest(button.dataset.id);
        if (runtime.adminSelectedTestId === button.dataset.id) {
          runtime.adminSelectedTestId = null;
        }
        if (runtime.adminEditingTestId === button.dataset.id) {
          runtime.adminEditingTestId = null;
        }
        rerenderAdminPreserveScroll(user);
      });
    });

    app.querySelectorAll(".js-restore-test").forEach(function (button) {
      button.addEventListener("click", function () {
        var restored = store.restoreDeletedTest(button.dataset.id);
        runtime.adminSelectedTestId = restored ? restored.id : runtime.adminSelectedTestId;
        rerenderAdminPreserveScroll(user, runtime.adminSelectedTestId);
      });
    });

    app.querySelectorAll(".js-delete-test-forever").forEach(function (button) {
      button.addEventListener("click", function () {
        store.permanentlyDeleteTest(button.dataset.id);
        rerenderAdminPreserveScroll(user, selectedTestId);
      });
    });

    app.querySelectorAll(".js-edit-question").forEach(function (button) {
      button.addEventListener("click", function () {
        runtime.adminEditingQuestionId = button.dataset.id;
        rerenderAdminPreserveScroll(user, selectedTestId);
      });
    });

    app.querySelectorAll(".js-edit-question-inline").forEach(function (button) {
      button.addEventListener("click", function () {
        runtime.adminEditingQuestionId = button.dataset.id;
        rerenderAdminPreserveScroll(user, selectedTestId);
      });
    });

    app.querySelectorAll(".js-delete-question").forEach(function (button) {
      button.addEventListener("click", function () {
        store.deleteQuestion(button.dataset.id);
        if (runtime.adminEditingQuestionId === button.dataset.id) {
          runtime.adminEditingQuestionId = null;
        }
        rerenderAdminPreserveScroll(user, selectedTestId);
      });
    });

    app.querySelectorAll(".js-attach-question").forEach(function (button) {
      button.addEventListener("click", function () {
        store.attachQuestionToTest(selectedTestId, button.dataset.question);
        rerenderAdminPreserveScroll(user, selectedTestId);
      });
    });

    app.querySelectorAll(".js-detach-question").forEach(function (button) {
      button.addEventListener("click", function () {
        if (!selectedTestId) {
          return;
        }
        store.detachQuestionFromTest(selectedTestId, button.dataset.id);
        rerenderAdminPreserveScroll(user, selectedTestId);
      });
    });

    var bankSearch = document.getElementById("bank-search");
    if (bankSearch) {
      bankSearch.addEventListener("input", function () {
        runtime.adminBankQuery = bankSearch.value;
        rerenderAdminPreserveScroll(user, selectedTestId);
      });
    }

    var bankFilter = document.getElementById("bank-filter");
    if (bankFilter) {
      bankFilter.addEventListener("change", function () {
        runtime.adminBankSectionFilter = bankFilter.value;
        rerenderAdminPreserveScroll(user, selectedTestId);
      });
    }

    app.querySelectorAll(".js-restore-question").forEach(function (button) {
      button.addEventListener("click", function () {
        store.restoreDeletedQuestion(button.dataset.id);
        rerenderAdminPreserveScroll(user, selectedTestId);
      });
    });

    app.querySelectorAll(".js-delete-forever").forEach(function (button) {
      button.addEventListener("click", function () {
        store.permanentlyDeleteQuestion(button.dataset.id);
        rerenderAdminPreserveScroll(user, selectedTestId);
      });
    });

    app.querySelectorAll(".js-export-pdf").forEach(function (button) {
      button.addEventListener("click", function () {
        var exportTest = store.getTestById(button.dataset.id);
        var exportQuestions = store.getQuestionsForTest(button.dataset.id);
        var exportWindow = window.open("", "_blank");
        if (!exportWindow) {
          return;
        }
        exportWindow.document.write(
          '<html><head><title>' + escapeHtml(exportTest.title) + '</title></head><body style="font-family: Arial, sans-serif; padding: 32px;">' +
          '<h1>' + escapeHtml(exportTest.title) + '</h1>' +
          exportQuestions.map(function (question, index) {
            return '<div style="margin-bottom: 28px;"><h3>Q' + (index + 1) + '. ' + escapeHtml(question.prompt) + '</h3>' +
              (question.passage ? '<p>' + escapeHtml(question.passage) + '</p>' : '') +
              getQuestionImageUrls(question).map(function (image) {
                return '<img src="' + safeImageUrl(image) + '" style="max-width: 480px; display:block; margin: 10px 0;">';
              }).join('') +
              '<ol type="A">' + question.options.map(function (option) { return '<li>' + escapeHtml(option) + '</li>'; }).join('') + '</ol>' +
              '<p><strong>Answer:</strong> ' + escapeHtml(question.options[question.correctOption]) + '</p>' +
              '<p><strong>Solution:</strong> ' + escapeHtml(question.explanation) + '</p></div>';
          }).join("") +
          '</body></html>'
        );
        exportWindow.document.close();
        exportWindow.focus();
        exportWindow.print();
      });
    });
  }

  function renderAdminActivity(user) {
    if (!store.isAdmin(user)) {
      navigate("dashboard");
      return;
    }
    var snapshot = store.getAdminSnapshot();
    var tests = store.getTests();
    var selectedLeaderboardTestId = runtime.adminActivityTestId || (tests[0] ? tests[0].id : "");
    var leaderboard = selectedLeaderboardTestId ? store.getFirstAttemptLeaderboard(selectedLeaderboardTestId) : [];
    app.innerHTML = buildShell(
      '<section class="report-layout">' +
        '<div class="report-bar">' +
          '<div class="brand-mark"><span class="brand-dot"></span> AceIIIT</div>' +
          '<div class="button-row"><button class="button button-secondary" id="back-admin">Builder Mode</button></div>' +
        '</div>' +
        '<div class="report-body">' +
          '<div class="report-heading"><p class="section-label">Student Activity</p><h1>Users, attempts, logins and leaderboard</h1></div>' +
          '<div class="report-grid">' +
            '<div class="report-card"><p class="section-label">Users</p><div class="table-like"><div class="table-row header"><span>Name</span><span>Email</span><span>Phone</span><span>Created</span></div>' +
              snapshot.users.map(function (item) {
                return '<div class="table-row"><span>' + escapeHtml(item.name) + (item.role === "admin" ? '<br><small>admin</small>' : '') + '</span><span>' + escapeHtml(item.email) + '</span><span>' + escapeHtml(item.phone || "-") + '</span><span>' + escapeHtml(formatDateTime(item.createdAt)) + (item.role !== "admin" ? '<br><button class="button button-danger button-compact js-delete-user" data-id="' + escapeAttribute(item.id) + '">Delete User</button>' : '') + '</span></div>';
              }).join("") +
            '</div>' +
            '<div class="divider"></div>' +
            '<p class="section-label">Deleted users</p>' +
            (snapshot.deletedUsers && snapshot.deletedUsers.length ? (
              '<div class="question-bank compact-bank">' +
                snapshot.deletedUsers.map(function (item) {
                  return '<div class="bank-item"><strong>' + escapeHtml(item.name) + '</strong><span>' + escapeHtml(item.email) + '</span><span class="helper-text">Deleted: ' + escapeHtml(formatDateTime(item.deletedAt)) + '</span><div class="button-row"><button class="button button-secondary button-compact js-restore-user" data-id="' + escapeAttribute(item.id) + '">Restore</button><button class="button button-danger button-compact js-delete-user-forever" data-id="' + escapeAttribute(item.id) + '">Delete Forever</button></div></div>';
                }).join("") +
              '</div>'
            ) : '<div class="empty-state">No deleted users.</div>') +
            '</div>' +
            '<aside class="report-card"><p class="section-label">Attempts and logins</p><div class="question-bank compact-bank">' +
              snapshot.attempts.map(function (attempt) {
                var attemptUser = snapshot.users.find(function (item) { return item.id === attempt.userId; });
                var attemptTest = tests.find(function (item) { return item.id === attempt.testId; });
                return '<div class="bank-item"><strong>' + escapeHtml(attemptUser ? attemptUser.name : attempt.userId) + '</strong><span>' + escapeHtml(attemptTest ? attemptTest.title : attempt.testId) + '</span><span class="helper-text">Started: ' + escapeHtml(formatDateTime(attempt.startedAt)) + '</span><span class="helper-text">' + escapeHtml(attempt.status === "submitted" && attempt.result ? ("Score: " + attempt.result.score + " | Percentile: " + attempt.result.percentile + " | Submitted: " + formatDateTime(attempt.submittedAt)) : "In progress") + '</span></div>';
              }).join("") +
              snapshot.loginEvents.map(function (event) {
                return '<div class="bank-item"><strong>' + escapeHtml(event.email) + '</strong><span>Logged in as ' + escapeHtml(event.role) + '</span><span class="helper-text">' + escapeHtml(formatDateTime(event.loggedInAt)) + '</span></div>';
              }).join("") +
            '</div></aside>' +
          '</div>' +
          '<div class="report-card" style="margin-top: 20px;">' +
            '<div class="button-row" style="justify-content: space-between; align-items: end; margin-bottom: 16px;">' +
              '<div><p class="section-label">Leaderboard</p><h2 style="margin-top: 4px;">First Attempt Only</h2></div>' +
              '<div class="button-row" style="align-items: end;">' +
                '<div class="field" style="min-width: 280px; margin: 0;"><label for="leaderboard-test">Select test</label><select id="leaderboard-test">' +
                  (tests.length ? tests.map(function (test) {
                    return '<option value="' + escapeAttribute(test.id) + '" ' + (test.id === selectedLeaderboardTestId ? 'selected' : '') + '>' + escapeHtml(test.title) + '</option>';
                  }).join("") : '<option value="">No tests available</option>') +
                '</select></div>' +
                '<button class="button button-secondary" type="button" id="export-leaderboard-pdf" ' + (!selectedLeaderboardTestId ? 'disabled' : '') + '>Leaderboard PDF</button>' +
              '</div>' +
            '</div>' +
            (selectedLeaderboardTestId ? (
              leaderboard.length ? (
                '<div class="table-like leaderboard-table">' +
                  '<div class="table-row header"><span>Rank</span><span>Name</span><span>Score</span><span>Percentile</span><span>Started</span><span>Submitted</span></div>' +
                  leaderboard.map(function (entry) {
                    return '<div class="table-row"><span>#' + entry.rank + '</span><span>' + escapeHtml(entry.userName) + '<br><small>' + escapeHtml(entry.email) + '</small></span><span>' + escapeHtml(String(entry.score)) + '</span><span>' + escapeHtml(String(entry.percentile)) + '</span><span>' + escapeHtml(formatDateTime(entry.startedAt)) + '</span><span>' + escapeHtml(formatDateTime(entry.submittedAt)) + '</span></div>';
                  }).join("") +
                '</div>'
              ) : '<div class="empty-state">No submitted first attempts yet for this test.</div>'
            ) : '<div class="empty-state">Create a test first to view its leaderboard.</div>') +
          '</div>' +
        '</div>' +
      '</section>'
    );
    document.getElementById("back-admin").addEventListener("click", function () {
      navigate("admin");
    });
    app.querySelectorAll(".js-delete-user").forEach(function (button) {
      button.addEventListener("click", function () {
        store.deleteUser(button.dataset.id);
        renderAdminActivity(user);
      });
    });
    app.querySelectorAll(".js-restore-user").forEach(function (button) {
      button.addEventListener("click", function () {
        store.restoreDeletedUser(button.dataset.id);
        renderAdminActivity(user);
      });
    });
    app.querySelectorAll(".js-delete-user-forever").forEach(function (button) {
      button.addEventListener("click", function () {
        store.permanentlyDeleteUser(button.dataset.id);
        renderAdminActivity(user);
      });
    });
    var leaderboardSelect = document.getElementById("leaderboard-test");
    if (leaderboardSelect) {
      leaderboardSelect.addEventListener("change", function () {
        runtime.adminActivityTestId = leaderboardSelect.value;
        renderAdminActivity(user);
      });
    }
    var leaderboardPdf = document.getElementById("export-leaderboard-pdf");
    if (leaderboardPdf) {
      leaderboardPdf.addEventListener("click", function () {
        if (!selectedLeaderboardTestId) {
          return;
        }
        var selectedTest = tests.find(function (item) {
          return item.id === selectedLeaderboardTestId;
        });
        var exportWindow = window.open("", "_blank");
        if (!exportWindow) {
          return;
        }
        exportWindow.document.write(
          '<html><head><title>Leaderboard - ' + escapeHtml(selectedTest ? selectedTest.title : selectedLeaderboardTestId) + '</title></head><body style="font-family: Arial, sans-serif; padding: 32px; color: #15110f;">' +
          '<h1 style="margin-bottom: 8px;">' + escapeHtml(selectedTest ? selectedTest.title : selectedLeaderboardTestId) + '</h1>' +
          '<p style="margin-top: 0; color: #5d554d;">AceIIIT first-attempt leaderboard export</p>' +
          (leaderboard.length ? (
            '<table style="width: 100%; border-collapse: collapse; margin-top: 20px;">' +
              '<thead><tr>' +
                '<th style="text-align:left; border-bottom:1px solid #ccc; padding: 10px 8px;">Rank</th>' +
                '<th style="text-align:left; border-bottom:1px solid #ccc; padding: 10px 8px;">Name</th>' +
                '<th style="text-align:left; border-bottom:1px solid #ccc; padding: 10px 8px;">Email</th>' +
                '<th style="text-align:left; border-bottom:1px solid #ccc; padding: 10px 8px;">Score</th>' +
                '<th style="text-align:left; border-bottom:1px solid #ccc; padding: 10px 8px;">Percentile</th>' +
                '<th style="text-align:left; border-bottom:1px solid #ccc; padding: 10px 8px;">Started</th>' +
                '<th style="text-align:left; border-bottom:1px solid #ccc; padding: 10px 8px;">Submitted</th>' +
              '</tr></thead>' +
              '<tbody>' +
                leaderboard.map(function (entry) {
                  return '<tr>' +
                    '<td style="border-bottom:1px solid #eee; padding: 10px 8px;">#' + entry.rank + '</td>' +
                    '<td style="border-bottom:1px solid #eee; padding: 10px 8px;">' + escapeHtml(entry.userName) + '</td>' +
                    '<td style="border-bottom:1px solid #eee; padding: 10px 8px;">' + escapeHtml(entry.email) + '</td>' +
                    '<td style="border-bottom:1px solid #eee; padding: 10px 8px;">' + escapeHtml(String(entry.score)) + '</td>' +
                    '<td style="border-bottom:1px solid #eee; padding: 10px 8px;">' + escapeHtml(String(entry.percentile)) + '</td>' +
                    '<td style="border-bottom:1px solid #eee; padding: 10px 8px;">' + escapeHtml(formatDateTime(entry.startedAt)) + '</td>' +
                    '<td style="border-bottom:1px solid #eee; padding: 10px 8px;">' + escapeHtml(formatDateTime(entry.submittedAt)) + '</td>' +
                  '</tr>';
                }).join("") +
              '</tbody>' +
            '</table>'
          ) : '<p>No submitted first attempts yet for this test.</p>') +
          '</body></html>'
        );
        exportWindow.document.close();
        exportWindow.focus();
        exportWindow.print();
      });
    }
  }

  function renderRoute() {
    var parts = routeParts();
    var user = store.getCurrentUser();
    var view = parts[0] || (user ? "dashboard" : "login");

    if (view !== "test") {
      stopRuntime(true);
    }

    if (!user && view !== "login") {
      navigate("login");
      return;
    }

    if (view === "login") {
      renderLogin();
      return;
    }

    if (view === "dashboard") {
      renderDashboard(user);
      return;
    }

    if (view === "instructions" && parts[1]) {
      renderInstructions(user, parts[1]);
      return;
    }

    if (view === "test" && parts[1]) {
      renderTest(user, parts[1]);
      return;
    }

    if (view === "results" && parts[1]) {
      renderResults(user, parts[1]);
      return;
    }

    if (view === "admin") {
      renderAdmin(user);
      return;
    }

    if (view === "admin-activity") {
      renderAdminActivity(user);
      return;
    }

    navigate(user ? "dashboard" : "login");
  }

  window.addEventListener("hashchange", function () {
    syncAndRenderCurrentRoute();
  });
  window.addEventListener("focus", function () {
    var parts = routeParts();
    var view = parts[0] || "";
    if (view === "dashboard" || view === "admin" || view === "admin-activity" || view === "results" || view === "") {
      syncAndRenderCurrentRoute();
    }
  });
  window.addEventListener("visibilitychange", function () {
    if (!document.hidden) {
      syncAndRenderCurrentRoute();
    }
  });
  window.addEventListener("beforeunload", function () {
    flushQuestionTime();
  });

  if (firebaseBridge) {
    firebaseBridge.setConfig(store.getSettings().firebaseConfig || null);
  }
  if (!window.location.hash) {
    navigate("login");
  } else {
    renderRoute();
  }
  showOverlayLoader("Syncing the newest backend changes into this screen.");
  Promise.resolve(store.init()).finally(function () {
    if (firebaseBridge) {
      firebaseBridge.setConfig(store.getSettings().firebaseConfig || null);
    }
    if (store.subscribeToRemoteChanges && !remoteChangeUnsubscribe) {
      remoteChangeUnsubscribe = store.subscribeToRemoteChanges(function () {
        syncAndRenderCurrentRoute();
      });
    }
    startSyncPolling();
    syncAndRenderCurrentRoute();
  });
})();
