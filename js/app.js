(function () {
  var app = document.getElementById("app");
  var store = window.AceIIIT.__store || window.AceIIIT.db || window.AceIIIT.store;
  var auth = window.AceIIIT.auth || window.AceIIIT.__store || window.AceIIIT.store;
  var ui = window.AceIIIT.ui || {};
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
    dashboardCalendarMonth: "",
    dashboardReminderDate: "",
    dashboardPlannerModalDate: "",
    dashboardScheduleModalTestId: "",
    dashboardNotificationMessage: "",
    dashboardTouchStartX: 0,
    dashboardTouchStartY: 0,
    imageLightboxUrl: "",
    lastPresencePingAt: 0,
    pendingQuestionFileNames: [],
    pendingQuestionFilePreviews: [],
    pendingQuestionFiles: [],
    pendingUploadedQuestionImageUrls: [],
    questionUploadContext: "",
    submittingAttemptId: null,
    adminLatexPreviewVisible: false,
    keepAliveTimerId: null,
    keepAliveInFlight: false,
    keepAliveLastPingAt: 0
  };
  var ADMIN_TEST_DRAFT_KEY = "aceiiit.secure.admin.testDraft.v1";
  var ADMIN_QUESTION_DRAFT_KEY = "aceiiit.secure.admin.questionDraft.v1";
  var ADMIN_SETTINGS_DRAFT_KEY = "aceiiit.secure.admin.settingsDraft.v1";
  var AUTH_LOGIN_DRAFT_KEY = "aceiiit.secure.auth.loginDraft.v1";
  var AUTH_SIGNUP_DRAFT_KEY = "aceiiit.secure.auth.signupDraft.v1";
  var AUTH_UI_STATE_KEY = "aceiiit.secure.auth.uiState.v1";
  // Replace with your sales/checkout page URL (Render, Instamojo, Gumroad, etc.).
  var BUY_SERIES_URL = "https://ketc8up.github.io/AceIIIT/registrations.html";
  var remoteChangeUnsubscribe = null;
  var overlayLoaderVisible = false;
  var syncPollId = null;
  var syncInFlight = false;
  var syncQueued = false;
  var KEEP_ALIVE_INTERVAL_MS = 60 * 1000;
  var KEEP_ALIVE_TIMEOUT_MS = 8000;
  var USER_ONLINE_WINDOW_MS = 3 * 60 * 1000;
  var THEME_SETTING_KEY = "theme";

  function initials(name) {
    return String(name || "A")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(function (part) { return part[0].toUpperCase(); })
      .join("");
  }

  function firstName(name) {
    return String(name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)[0] || "there";
  }

  function timeGreeting() {
    var hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 17) return "Good afternoon";
    return "Good evening";
  }

  function getSectionDefaultMarking(section) {
    var normalized = String(section || "SUPR").toUpperCase() === "REAP" ? "REAP" : "SUPR";
    return normalized === "REAP"
      ? { marks: 2, negativeMarks: 0.5 }
      : { marks: 1, negativeMarks: 0.25 };
  }

  function sortQuestionsForSelectedTest(test, questions) {
    if (!test || !Array.isArray(test.questionIds)) {
      return (questions || []).slice();
    }
    var order = {};
    test.questionIds.forEach(function (questionId, index) {
      order[String(questionId)] = index;
    });
    return (questions || []).slice().sort(function (a, b) {
      var aWeight = String(a && a.section || "SUPR") === "REAP" ? 1 : 0;
      var bWeight = String(b && b.section || "SUPR") === "REAP" ? 1 : 0;
      if (aWeight !== bWeight) {
        return aWeight - bWeight;
      }
      return Number(order[String(a && a.id || "")] || 0) - Number(order[String(b && b.id || "")] || 0);
    });
  }

  function isUserOnline(user) {
    if (!user || !user.lastSeenAt) return false;
    var seenAt = new Date(user.lastSeenAt).getTime();
    if (!seenAt) return false;
    return Date.now() - seenAt <= USER_ONLINE_WINDOW_MS;
  }

  function toDateInputValue(value) {
    if (!value) return "";
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    var year = date.getFullYear();
    var month = String(date.getMonth() + 1).padStart(2, "0");
    var day = String(date.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
  }

  function toMonthKey(value) {
    if (!value) return "";
    var date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
  }

  function formatMonthLabel(monthKey) {
    var parts = String(monthKey || "").split("-");
    if (parts.length !== 2) return "";
    var date = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    return date.toLocaleString("en-IN", { month: "long", year: "numeric" });
  }

  function shiftMonthKey(monthKey, delta) {
    var parts = String(monthKey || "").split("-");
    var date = parts.length === 2
      ? new Date(Number(parts[0]), Number(parts[1]) - 1, 1)
      : new Date();
    date.setMonth(date.getMonth() + Number(delta || 0));
    return date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0");
  }

  function buildCalendarCells(monthKey) {
    var parts = String(monthKey || "").split("-");
    var date = parts.length === 2
      ? new Date(Number(parts[0]), Number(parts[1]) - 1, 1)
      : new Date();
    var year = date.getFullYear();
    var month = date.getMonth();
    var firstDay = new Date(year, month, 1);
    var startOffset = (firstDay.getDay() + 6) % 7;
    var totalDays = new Date(year, month + 1, 0).getDate();
    var cells = [];
    for (var index = 0; index < 42; index += 1) {
      var dayNumber = index - startOffset + 1;
      var cellDate = new Date(year, month, dayNumber);
      cells.push({
        iso: toDateInputValue(cellDate),
        label: cellDate.getDate(),
        inMonth: dayNumber >= 1 && dayNumber <= totalDays,
      });
    }
    return cells;
  }

  function getStoredThemePreference() {
    var settings = store.getSettings ? store.getSettings() : {};
    var theme = settings && settings[THEME_SETTING_KEY] ? String(settings[THEME_SETTING_KEY]) : "light";
    return theme === "dark" ? "dark" : "light";
  }

  function isThemeForcedLight() {
    var parts = routeParts();
    return (parts[0] || "") === "test";
  }

  function getEffectiveTheme() {
    return isThemeForcedLight() ? "light" : getStoredThemePreference();
  }

  function applyTheme() {
    if (!document.body) return;
    var effectiveTheme = getEffectiveTheme();
    document.body.setAttribute("data-theme", effectiveTheme);
    document.body.classList.toggle("theme-dark", effectiveTheme === "dark");
    document.body.classList.toggle("theme-light", effectiveTheme !== "dark");
  }

  function toggleThemePreference() {
    if (isThemeForcedLight()) return;
    var nextTheme = getStoredThemePreference() === "dark" ? "light" : "dark";
    store.updateSettings((function () {
      var patch = {};
      patch[THEME_SETTING_KEY] = nextTheme;
      return patch;
    })());
    applyTheme();
    renderRoute();
  }

  function escapeHtml(value) {
    if (ui.escapeHtml) {
      return ui.escapeHtml(value);
    }
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatRichText(value) {
    // Keep raw newlines so KaTeX auto-render can match delimiters like:
    // \[ ... \] even when the user types it on multiple lines.
    // Rendering uses CSS `white-space: pre-wrap` on `.rich-text`.
    return escapeHtml(String(value || ""));
  }

  function renderLatexInElement(root, attempt) {
    try {
      attempt = Number(attempt || 0);
      if (!root) return;
      if (!window.renderMathInElement) {
        if (attempt < 20) {
          window.setTimeout(function () {
            renderLatexInElement(root, attempt + 1);
          }, 100);
        }
        return;
      }
      window.renderMathInElement(root, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "\\(", right: "\\)", display: false },
          { left: "$", right: "$", display: false },
        ],
        throwOnError: false,
        ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
      });
    } catch (_err) {}
  }

  function animateNumber(el, end) {
    if (!el) return;
    var target = Number(end || 0);
    var prefix = el.getAttribute("data-prefix") || "";
    var suffix = el.getAttribute("data-suffix") || "";
    var decimals = Number(el.getAttribute("data-decimals") || 0);
    var start = 0;
    var step = target / 50;
    if (!Number.isFinite(step) || step === 0) {
      el.textContent = prefix + target.toFixed(decimals) + suffix;
      return;
    }
    var interval = window.setInterval(function () {
      start += step;
      if ((step >= 0 && start >= target) || (step < 0 && start <= target)) {
        start = target;
        window.clearInterval(interval);
      }
      el.textContent = prefix + Number(start).toFixed(decimals) + suffix;
    }, 16);
  }

  function activateAnalysisAnimations(root) {
    if (!root) return;
    root.querySelectorAll("[data-width]").forEach(function (el) {
      window.requestAnimationFrame(function () {
        el.style.width = String(el.getAttribute("data-width") || "0%");
      });
    });
    root.querySelectorAll("[data-animate-number]").forEach(function (el) {
      animateNumber(el, Number(el.getAttribute("data-animate-number") || 0));
    });
  }

  function getInputValue(formEl, selector) {
    var el = formEl ? formEl.querySelector(selector) : null;
    return el && typeof el.value === "string" ? el.value : "";
  }

  function buildLatexPreviewHtml(formEl) {
    var prompt = getInputValue(formEl, "#question-prompt");
    var passage = getInputValue(formEl, "#question-passage");
    var optionA = getInputValue(formEl, "#option-0");
    var optionB = getInputValue(formEl, "#option-1");
    var optionC = getInputValue(formEl, "#option-2");
    var optionD = getInputValue(formEl, "#option-3");
    var solution = getInputValue(formEl, "#question-explanation");

    function block(title, content) {
      return (
        '<div class="latex-preview-block">' +
          '<p class="section-label" style="margin-bottom: 10px;">' + escapeHtml(title) + '</p>' +
          '<div class="latex-preview-content rich-text">' + formatRichText(content || "") + '</div>' +
        '</div>'
      );
    }

    return (
      '<div class="latex-preview-stack">' +
        block("Question prompt", prompt) +
        (passage ? block("Passage / context (optional)", passage) : "") +
        '<div class="latex-preview-block">' +
          '<p class="section-label" style="margin-bottom: 10px;">Options</p>' +
          '<ol class="latex-preview-options">' +
            '<li class="rich-text">' + formatRichText(optionA || "") + '</li>' +
            '<li class="rich-text">' + formatRichText(optionB || "") + '</li>' +
            '<li class="rich-text">' + formatRichText(optionC || "") + '</li>' +
            '<li class="rich-text">' + formatRichText(optionD || "") + '</li>' +
          '</ol>' +
        '</div>' +
        block("Solution", solution) +
      '</div>'
    );
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

  function openBuySeries() {
    if (!BUY_SERIES_URL || BUY_SERIES_URL.indexOf("example.com") !== -1) {
      window.alert("Set your course purchase URL in js/app.js (BUY_SERIES_URL) to enable redirection.");
      return;
    }
    try {
      window.open(BUY_SERIES_URL, "_blank", "noopener,noreferrer");
    } catch (_err) {
      window.location.href = BUY_SERIES_URL;
    }
  }

  function renderAppErrorState(message) {
    app.innerHTML = buildShell(
      '<section class="report-layout">' +
        '<div class="report-bar">' +
          '<div class="brand-mark"><span class="brand-dot"></span> AceIIIT</div>' +
          '<div class="button-row">' +
            getThemeToggleMarkup() +
          '</div>' +
        '</div>' +
        '<div class="report-body">' +
          '<div class="report-card">' +
            '<p class="section-label">Something went wrong</p>' +
            '<h1>We could not render this screen.</h1>' +
            '<p>' + escapeHtml(message || "Please refresh the portal and try again.") + '</p>' +
            '<div class="button-row">' +
              '<button class="button button-primary" id="retry-render">Retry</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</section>'
    );
    var retryButton = document.getElementById("retry-render");
    if (retryButton) {
      retryButton.addEventListener("click", function () {
        syncAndRenderCurrentRoute();
      });
    }
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

  function hideAdminModal() {
    var existing = document.querySelector("[data-admin-modal='true']");
    if (existing) {
      existing.remove();
    }
  }

  function showAdminModal(title, bodyHtml, isLarge) {
    if (!document.body) {
      return null;
    }

    hideAdminModal();

    var overlay = document.createElement("div");
    overlay.className = "admin-modal-overlay";
    overlay.setAttribute("data-admin-modal", "true");
    overlay.innerHTML =
      '<div class="admin-modal-card' + (isLarge ? ' is-large' : '') + '" role="dialog" aria-modal="true">' +
        '<div class="admin-modal-head">' +
          '<h3>' + escapeHtml(title || "Details") + '</h3>' +
          '<div class="button-row">' +
            '<button class="button button-secondary button-compact" type="button" data-admin-modal-close="true">Close</button>' +
          '</div>' +
        '</div>' +
        '<div class="admin-modal-body">' + String(bodyHtml || "") + '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) {
        hideAdminModal();
      }
    });

    var closeButton = overlay.querySelector("[data-admin-modal-close='true']");
    if (closeButton) {
      closeButton.addEventListener("click", function () {
        hideAdminModal();
      });
    }

    window.addEventListener("keydown", function onKeyDown(event) {
      if (event.key === "Escape") {
        hideAdminModal();
        window.removeEventListener("keydown", onKeyDown);
      }
    });

    return overlay;
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
    if (value && typeof value === "object") {
      value = value.url || value.src || value.imageUrl || value.downloadURL || value.dataUrl || value.value || "";
    }
    var normalized = String(value || "").trim();
    if (!normalized) {
      return "";
    }
    if (/^data%3a/i.test(normalized)) {
      try {
        normalized = decodeURIComponent(normalized);
      } catch (error) {}
    }
    normalized = normalized.replace(/\s+/g, "");
    if (/^(data:|blob:|https?:\/\/|file:\/\/\/)/i.test(normalized)) {
      return normalized;
    }
    if (/^image\/[a-z0-9.+-]+;base64,/i.test(normalized)) {
      return "data:" + normalized;
    }
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) && normalized.length > 100) {
      var mimeType = /^\/9j\//.test(normalized)
        ? "image/jpeg"
        : (/^iVBOR/.test(normalized) ? "image/png" : "image/jpeg");
      return "data:" + mimeType + ";base64," + normalized;
    }
    normalized = normalized.replace(/\\/g, "/");
    if (/^[A-Za-z]:\//.test(normalized)) {
      return "file:///" + encodeURI(normalized);
    }
    return encodeURI(normalized);
  }

  function formatTime(totalSeconds) {
    if (ui.formatTime) {
      return ui.formatTime(totalSeconds);
    }
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

  function getAttemptElapsedMs(attempt) {
    if (!attempt || !attempt.startedAt) {
      return 0;
    }
    var startedAtMs = new Date(attempt.startedAt).getTime();
    if (!Number.isFinite(startedAtMs)) {
      return 0;
    }
    return Math.max(0, Date.now() - startedAtMs);
  }

  function isAttemptExpired(attempt, test) {
    if (!attempt || attempt.status !== "in_progress" || !test) {
      return false;
    }
    var totalDurationMs = getTotalDuration(test) * 60 * 1000;
    if (!totalDurationMs) {
      return false;
    }
    return getAttemptElapsedMs(attempt) > (totalDurationMs + (10 * 60 * 1000));
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
      return question.imageUrls.map(safeImageUrl).filter(Boolean);
    }

    if (question.imageUrl) {
      return [safeImageUrl(question.imageUrl)].filter(Boolean);
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

  function bindFigureLoadDiagnostics() {
    app.querySelectorAll("img.question-figure, img.image-lightbox-image").forEach(function (img) {
      img.addEventListener("error", function () {
        try {
          img.style.outline = "2px solid rgba(183, 58, 40, 0.5)";
          img.style.background = "rgba(183, 58, 40, 0.06)";
        } catch (_err) {}
        console.warn("AceIIIT image failed to load:", img.getAttribute("src"));
      }, { once: true });
    });
  }

  function formatDateTime(value) {
    if (ui.formatDateTime) {
      return ui.formatDateTime(value);
    }
    if (!value) {
      return "-";
    }
    return new Date(value).toLocaleString();
  }

  function formatDateOnly(value) {
    if (!value) {
      return "-";
    }
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return String(value);
    }
    return [
      String(date.getDate()).padStart(2, "0"),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getFullYear())
    ].join("/");
  }

  function formatTimeOnly(value) {
    if (!value) {
      return "--:--";
    }
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "--:--";
    }
    return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
  }

  function formatReminderLabel(minutes) {
    var value = Number(minutes || 300);
    if (value >= 24 * 60 && value % (24 * 60) === 0) {
      return (value / (24 * 60)) + " day before";
    }
    if (value >= 60 && value % 60 === 0) {
      return (value / 60) + " hour before";
    }
    return value + " min before";
  }

  function sameDay(left, right) {
    if (!left || !right) return false;
    return toDateInputValue(left) === toDateInputValue(right);
  }

  function normalizeSubjectFocus(value) {
    var items = Array.isArray(value) ? value : (value ? [value] : []);
    return items
      .map(function (item) { return String(item || "").trim(); })
      .filter(function (item, index, arr) {
        return item && ["Physics", "Maths", "Logical"].indexOf(item) >= 0 && arr.indexOf(item) === index;
      })
      .slice(0, 3);
  }

  function getReminderStatus(reminder, attempts) {
    var plannedAtMs = reminder && reminder.plannedAt ? new Date(reminder.plannedAt).getTime() : 0;
    var nowMs = Date.now();
    var submittedAttempts = (attempts || []).filter(function (attempt) {
      return attempt && attempt.status === "submitted";
    });
    var completedAttempt = submittedAttempts.find(function (attempt) {
      var submittedAtMs = attempt && attempt.submittedAt ? new Date(attempt.submittedAt).getTime() : 0;
      return submittedAtMs && plannedAtMs && submittedAtMs >= (plannedAtMs - (12 * 60 * 60 * 1000));
    }) || null;
    if (completedAttempt) {
      return { key: "completed", completedAttempt: completedAttempt };
    }

    var liveAttempt = (attempts || []).find(function (attempt) {
      return attempt && attempt.status === "in_progress";
    }) || null;
    if (liveAttempt) {
      return { key: "ongoing", completedAttempt: null };
    }

    if (plannedAtMs && plannedAtMs < nowMs) {
      return { key: "missed", completedAttempt: null };
    }

    return { key: "planned", completedAttempt: null };
  }

  function buildPlannerEvents(snapshot, reminders) {
    var attemptsByTest = {};
    (snapshot && snapshot.attempts || []).forEach(function (attempt) {
      if (!attemptsByTest[attempt.testId]) {
        attemptsByTest[attempt.testId] = [];
      }
      attemptsByTest[attempt.testId].push(attempt);
    });

    return (reminders || []).map(function (reminder) {
      var test = (snapshot && snapshot.tests || []).find(function (item) {
        return item.id === reminder.testId;
      }) || store.getTestById(reminder.testId) || null;
      var statusInfo = getReminderStatus(reminder, attemptsByTest[reminder.testId] || []);
      return {
        id: reminder.id,
        mockId: reminder.testId,
        title: reminder.title || (test && test.title) || "Planned mock",
        date: toDateInputValue(reminder.plannedAt),
        startTime: formatTimeOnly(reminder.plannedAt),
        endTime: formatTimeOnly(new Date(new Date(reminder.plannedAt).getTime() + ((getTotalDuration(test) || 0) * 60 * 1000))),
        status: statusInfo.key,
        reminder: Number(reminder.reminderMinutes || 300),
        completed: statusInfo.key === "completed",
        score: statusInfo.completedAttempt && statusInfo.completedAttempt.result ? Number(statusInfo.completedAttempt.result.score || 0) : null,
        accuracy: statusInfo.completedAttempt && statusInfo.completedAttempt.result ? Number(statusInfo.completedAttempt.result.accuracy || 0) : null,
        subjectFocus: normalizeSubjectFocus(reminder.subjectFocus),
        notes: reminder.notes || "",
        plannedAt: reminder.plannedAt,
        remindAt: reminder.remindAt,
        sentAt: reminder.sentAt,
        failureReason: reminder.failureReason || "",
        test: test,
        duration: getTotalDuration(test),
        completedAttempt: statusInfo.completedAttempt || null,
      };
    }).sort(function (left, right) {
      return new Date(left.plannedAt || 0).getTime() - new Date(right.plannedAt || 0).getTime();
    });
  }

  function getPlannerStatusMeta(status) {
    if (status === "completed") {
      return { label: "Completed", tone: "completed", dot: "is-completed" };
    }
    if (status === "missed") {
      return { label: "Missed", tone: "missed", dot: "is-missed" };
    }
    if (status === "ongoing") {
      return { label: "Ongoing", tone: "live", dot: "is-live" };
    }
    return { label: "Planned", tone: "planned", dot: "is-planned" };
  }

  function getEventsForDate(events, isoDate) {
    return (events || []).filter(function (event) {
      return event.date === isoDate;
    });
  }

  function getPlannerDayBuckets(events) {
    var today = toDateInputValue(new Date());
    var tomorrow = toDateInputValue(new Date(Date.now() + 24 * 60 * 60 * 1000));
    return {
      today: (events || []).filter(function (event) { return event.date === today; }),
      tomorrow: (events || []).filter(function (event) { return event.date === tomorrow; }),
      upcoming: (events || []).filter(function (event) { return event.date !== today && event.date !== tomorrow && event.status !== "completed"; }),
    };
  }

  function getWeekRange(dateLike) {
    var date = new Date(dateLike || Date.now());
    date.setHours(0, 0, 0, 0);
    var day = date.getDay() || 7;
    var start = new Date(date);
    start.setDate(date.getDate() - (day - 1));
    var end = new Date(start);
    end.setDate(start.getDate() + 7);
    return { start: start, end: end };
  }

  function buildPlannerStats(events) {
    var totalPlanned = (events || []).length;
    var completed = (events || []).filter(function (event) { return event.status === "completed"; });
    var missed = (events || []).filter(function (event) { return event.status === "missed"; });
    var weekRange = getWeekRange(new Date());
    var weeklyCompleted = completed.filter(function (event) {
      var time = new Date(event.plannedAt || 0).getTime();
      return time >= weekRange.start.getTime() && time < weekRange.end.getTime();
    }).length;
    var weeklyGoal = 5;
    var completionRate = totalPlanned ? Math.round((completed.length / totalPlanned) * 100) : 0;
    var completedDays = completed.map(function (event) { return event.date; }).filter(Boolean);
    var uniqueCompletedDays = completedDays.filter(function (day, index, arr) { return arr.indexOf(day) === index; }).sort();
    var currentStreak = 0;
    var cursor = new Date();
    cursor.setHours(0, 0, 0, 0);
    while (uniqueCompletedDays.indexOf(toDateInputValue(cursor)) >= 0) {
      currentStreak += 1;
      cursor.setDate(cursor.getDate() - 1);
    }
    var monthlyActivity = completed.filter(function (event) {
      return sameDay(new Date(event.plannedAt || 0), new Date(event.plannedAt || 0)) &&
        new Date(event.plannedAt || 0).getMonth() === new Date().getMonth() &&
        new Date(event.plannedAt || 0).getFullYear() === new Date().getFullYear();
    }).length;
    return {
      totalPlanned: totalPlanned,
      completed: completed.length,
      missed: missed.length,
      completionRate: completionRate,
      weeklyGoal: weeklyGoal,
      weeklyCompleted: weeklyCompleted,
      currentStreak: currentStreak,
      monthlyActivity: monthlyActivity,
      weeklyConsistency: Math.min(100, Math.round((weeklyCompleted / weeklyGoal) * 100)),
    };
  }

  function buildPlannerRecommendations(events, snapshot) {
    var completed = (events || []).filter(function (event) {
      return event.status === "completed" && event.completedAttempt && event.completedAttempt.result;
    });
    var byHour = {};
    completed.forEach(function (event) {
      var hour = new Date(event.plannedAt || 0).getHours();
      byHour[hour] = byHour[hour] || { total: 0, count: 0 };
      byHour[hour].total += Number(event.score || 0);
      byHour[hour].count += 1;
    });
    var bestHour = Object.keys(byHour).sort(function (left, right) {
      var leftAvg = byHour[left].total / byHour[left].count;
      var rightAvg = byHour[right].total / byHour[right].count;
      return rightAvg - leftAvg;
    })[0];
    var lastCompletedTestId = completed.length ? completed[completed.length - 1].mockId : "";
    var nextMock = (snapshot && snapshot.tests || []).find(function (test) {
      return test.id !== lastCompletedTestId;
    }) || ((snapshot && snapshot.tests || [])[0] || null);
    var weakSection = completed.reduce(function (acc, event) {
      var sectionScores = event.completedAttempt && event.completedAttempt.result && event.completedAttempt.result.sectionScores;
      if (!sectionScores) return acc;
      ["SUPR", "REAP"].forEach(function (sectionKey) {
        acc[sectionKey] = acc[sectionKey] || { score: 0, count: 0 };
        acc[sectionKey].score += Number(sectionScores[sectionKey] && sectionScores[sectionKey].score || 0);
        acc[sectionKey].count += 1;
      });
      return acc;
    }, {});
    var weakSectionKey = Object.keys(weakSection).sort(function (left, right) {
      return (weakSection[left].score / Math.max(1, weakSection[left].count)) - (weakSection[right].score / Math.max(1, weakSection[right].count));
    })[0] || "SUPR";
    return {
      nextMock: nextMock,
      weakSection: weakSectionKey,
      bestHour: bestHour !== undefined ? String(bestHour).padStart(2, "0") + ":00" : "19:00",
      consistencyTip: completed.length < 3 ? "Schedule 3 mocks this week to build rhythm." : "Keep your streak alive with one more planned mock tomorrow.",
    };
  }

  function suggestRescheduleSlot(events, fromDate) {
    var base = new Date(fromDate || Date.now());
    base.setHours(19, 0, 0, 0);
    if (base.getTime() <= Date.now()) {
      base.setDate(base.getDate() + 1);
    }
    for (var dayOffset = 0; dayOffset < 14; dayOffset += 1) {
      var candidate = new Date(base);
      candidate.setDate(base.getDate() + dayOffset);
      var isoDate = toDateInputValue(candidate);
      var sameDayEvents = getEventsForDate(events, isoDate);
      if (sameDayEvents.length < 2) {
        return candidate;
      }
    }
    return new Date(Date.now() + (24 * 60 * 60 * 1000));
  }

  function requestPlannerNotificationPermission() {
    if (!("Notification" in window) || Notification.permission !== "default") {
      return Promise.resolve(("Notification" in window) ? Notification.permission : "unsupported");
    }
    return Notification.requestPermission();
  }

  function schedulePlannerNotifications(events) {
    if (!("Notification" in window) || Notification.permission !== "granted") {
      return;
    }
    runtime.plannerNotificationTimers = runtime.plannerNotificationTimers || [];
    runtime.plannerNotificationTimers.forEach(function (timerId) {
      window.clearTimeout(timerId);
    });
    runtime.plannerNotificationTimers = [];
    (events || []).forEach(function (event) {
      var remindAtMs = event && event.remindAt ? new Date(event.remindAt).getTime() : 0;
      if (!remindAtMs || remindAtMs < Date.now() || (remindAtMs - Date.now()) > (24 * 60 * 60 * 1000)) {
        return;
      }
      var delay = Math.max(0, remindAtMs - Date.now());
      var timerId = window.setTimeout(function () {
        try {
          var notification = new Notification("AceIIIT Mock Planner", {
            body: event.title + " starts at " + formatTimeOnly(event.plannedAt) + " on " + formatDateOnly(event.plannedAt),
          });
          notification.onclick = function () {
            window.focus();
            runtime.dashboardPlannerModalDate = event.date;
            renderRoute();
          };
        } catch (_err) {}
        runtime.dashboardNotificationMessage = event.title + " reminder: starts at " + formatTimeOnly(event.plannedAt) + ".";
        renderRoute();
      }, delay);
      runtime.plannerNotificationTimers.push(timerId);
    });
  }

  function renderPlannerEventCard(event, options) {
    options = options || {};
    var meta = getPlannerStatusMeta(event.status);
    var title = event.title || "Planned mock";
    var reminderLabel = formatReminderLabel(event.reminder);
    var quickAction = options.showQuickStart
      ? '<button class="button button-secondary button-compact js-start-planned-mock" data-test="' + escapeAttribute(event.mockId) + '" data-event="' + escapeAttribute(event.id) + '">Start Test</button>'
      : "";
    var extraActions = options.showManageActions
      ? '<button class="button button-secondary button-compact js-edit-reminder" data-id="' + escapeAttribute(event.id) + '">Edit</button>' +
        '<button class="button button-secondary button-compact js-reschedule-reminder" data-id="' + escapeAttribute(event.id) + '">Reschedule</button>' +
        (event.status === "missed" ? '<button class="button button-secondary button-compact js-quick-reschedule" data-id="' + escapeAttribute(event.id) + '">Quick Reschedule</button>' : '') +
        '<button class="button button-secondary button-compact js-delete-reminder" data-id="' + escapeAttribute(event.id) + '">Delete</button>'
      : "";
    return (
      '<article class="planner-event-card status-' + escapeAttribute(meta.tone) + '">' +
        '<div class="planner-event-head">' +
          '<div>' +
            '<strong>' + escapeHtml(title) + '</strong>' +
            '<div class="helper-text">' + escapeHtml(event.test && event.test.title ? event.test.title : title) + '</div>' +
          '</div>' +
          '<span class="planner-status-chip ' + escapeAttribute(meta.tone) + '">' + escapeHtml(meta.label) + '</span>' +
        '</div>' +
        '<div class="planner-event-meta">' +
          '<span class="meta-chip">' + escapeHtml(formatDateOnly(event.plannedAt)) + '</span>' +
          '<span class="meta-chip">' + escapeHtml(event.startTime) + ' - ' + escapeHtml(event.endTime) + '</span>' +
          '<span class="meta-chip">' + escapeHtml(String(event.duration || 0)) + ' min</span>' +
        '</div>' +
        '<div class="planner-event-meta">' +
          '<span class="meta-chip">Reminder ' + escapeHtml(reminderLabel) + '</span>' +
          (event.subjectFocus && event.subjectFocus.length ? '<span class="meta-chip">' + escapeHtml(event.subjectFocus.join(", ")) + '</span>' : '') +
          (event.score !== null && event.score !== undefined ? '<span class="meta-chip">Score ' + escapeHtml(String(event.score)) + '</span>' : '') +
        '</div>' +
        (event.notes ? '<div class="helper-text">' + escapeHtml(event.notes) + '</div>' : '') +
        '<div class="button-row">' + quickAction + extraActions + (event.completedAttempt ? '<button class="button button-secondary button-compact js-open-result" data-id="' + escapeAttribute(event.completedAttempt.id) + '">Quick Review</button>' : '') + '</div>' +
      '</article>'
    );
  }

  function renderPlannerBucket(title, events, emptyText) {
    return (
      '<div class="planner-bucket">' +
        '<div class="planner-bucket-head"><p class="section-label">' + escapeHtml(title) + '</p><span>' + escapeHtml(String((events || []).length)) + '</span></div>' +
        ((events || []).length
          ? '<div class="planner-event-list">' + events.map(function (event) {
              return renderPlannerEventCard(event, { showQuickStart: true });
            }).join("") + '</div>'
          : '<div class="empty-state planner-empty">' + escapeHtml(emptyText) + '</div>') +
      '</div>'
    );
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

  function summarizeSelectedFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) {
      return "No image selected";
    }
    if (files.length === 1) {
      return files[0].name;
    }
    return files.length + " files selected: " + files.map(function (file) {
      return file.name;
    }).join(", ");
  }

  function updateQuestionFileStatus(fileList) {
    runtime.pendingQuestionFileNames = Array.prototype.slice.call(fileList || []).map(function (file) {
      return file.name;
    });
    runtime.pendingQuestionFiles = Array.prototype.slice.call(fileList || []);
    // Build preview thumbnails for admin only (local object URLs).
    runtime.pendingQuestionFilePreviews.forEach(function (url) {
      try { URL.revokeObjectURL(url); } catch (_err) {}
    });
    runtime.pendingQuestionFilePreviews = Array.prototype.slice.call(fileList || []).slice(0, 6).map(function (file) {
      try {
        return URL.createObjectURL(file);
      } catch (_err) {
        return "";
      }
    }).filter(Boolean);
    renderQuestionUploadUi();
  }

  function renderQuestionUploadUi() {
    var status = document.getElementById("question-files-status");
    if (status) {
      status.textContent = runtime.pendingQuestionFiles.length
        ? summarizeSelectedFiles(runtime.pendingQuestionFiles)
        : "No image selected";
    }
    var preview = document.getElementById("question-files-preview");
    if (preview) {
      preview.innerHTML = runtime.pendingQuestionFilePreviews.length
        ? runtime.pendingQuestionFilePreviews.map(function (url, index) {
            return '<img class="question-figure" src="' + escapeAttribute(url) + '" alt="Selected image ' + (index + 1) + '">';
          }).join("")
        : "";
    }
    var uploadedStatus = document.getElementById("question-uploaded-status");
    if (uploadedStatus) {
      uploadedStatus.textContent = runtime.pendingUploadedQuestionImageUrls.length
        ? (runtime.pendingUploadedQuestionImageUrls.length + " image(s) uploaded to Cloudinary and ready to save")
        : "Uploaded images will appear here after Cloudinary upload";
    }
    var uploadedPreview = document.getElementById("question-uploaded-preview");
    if (uploadedPreview) {
      uploadedPreview.innerHTML = runtime.pendingUploadedQuestionImageUrls.length
        ? runtime.pendingUploadedQuestionImageUrls.map(function (url, index) {
            return '<button type="button" class="question-figure-button" data-open-image="' + escapeAttribute(url) + '"><img class="question-figure" src="' + escapeAttribute(url) + '" alt="Uploaded image ' + (index + 1) + '"></button>';
          }).join("")
        : "";
    }
    var uploadButton = document.getElementById("upload-question-images");
    if (uploadButton) {
      uploadButton.disabled = !runtime.pendingQuestionFiles.length;
    }
  }

  function resetPendingQuestionUploads() {
    runtime.pendingQuestionFileNames = [];
    runtime.pendingQuestionFiles = [];
    runtime.pendingUploadedQuestionImageUrls = [];
    runtime.questionUploadContext = "";
    runtime.pendingQuestionFilePreviews.forEach(function (url) {
      try { URL.revokeObjectURL(url); } catch (_err) {}
    });
    runtime.pendingQuestionFilePreviews = [];
  }

  function dedupeUrls(values) {
    return (values || []).map(function (value) {
      return String(value || "").trim();
    }).filter(Boolean).filter(function (value, index, items) {
      return items.indexOf(value) === index;
    });
  }

  function hasPendingQuestionUploadState() {
    return !!(
      (runtime.pendingQuestionFiles && runtime.pendingQuestionFiles.length) ||
      (runtime.pendingUploadedQuestionImageUrls && runtime.pendingUploadedQuestionImageUrls.length)
    );
  }

  function isGoogleDriveImageLink(value) {
    return /drive\.google\.com|docs\.google\.com/i.test(String(value || ""));
  }

  function parseQuestionImageLinksText(raw) {
    return String(raw || "")
      .split(/\r?\n/)
      .map(function (item) { return String(item || "").trim(); })
      .filter(Boolean)
      .filter(function (item, index, items) {
        return items.indexOf(item) === index;
      });
  }

  function getQuestionDriveLinks(question) {
    return getQuestionImageUrls(question).filter(function (url) {
      return isGoogleDriveImageLink(url);
    });
  }

  function updateCalculatorDisplay() {
    var display = app.querySelector("[data-calculator-display]");
    if (display) {
      display.textContent = runtime.calculatorExpression || "0";
    }
  }

  function readFileAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result || ""));
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function isVectorOrDirectSafeFile(file) {
    var type = String(file && file.type || "").toLowerCase();
    var name = String(file && file.name || "").toLowerCase();
    return type === "image/svg+xml" || /\.svg$/i.test(name) || type === "image/gif" || /\.gif$/i.test(name);
  }

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) {
          settled = true;
          reject(new Error("Image load timed out"));
        }
      }, 12000);
      image.onload = function () {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(image);
        }
      };
      image.onerror = function () {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error("Image could not be read"));
        }
      };
      image.src = src;
    });
  }

  async function compressFileToDataUrl(file) {
    var original = await readFileAsDataUrl(file);
    if (!original) {
      throw new Error("Image file could not be read.");
    }
    if (isVectorOrDirectSafeFile(file)) {
      return original;
    }
    // Keep small images as-is.
    if (original.length <= 260000) {
      return original;
    }

    var image = await loadImage(original);
    var maxDimension = 1280;
    var ratio = Math.min(1, maxDimension / Math.max(image.width, image.height, 1));
    var canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * ratio));
    canvas.height = Math.max(1, Math.round(image.height * ratio));
    var context = canvas.getContext("2d");

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    var quality = 0.82;
    var result = canvas.toDataURL("image/jpeg", quality);
    while (result.length > 260000 && quality > 0.38) {
      quality -= 0.08;
      result = canvas.toDataURL("image/jpeg", quality);
    }
    if (result.length > 900000) {
      throw new Error("Image is too large. Please use a smaller image or JPG/PNG.");
    }
    return result;
  }

  function dataUrlToFile(dataUrl, originalFile) {
    var parts = String(dataUrl || "").split(",");
    if (parts.length < 2) {
      throw new Error("Compressed image data is invalid.");
    }
    var meta = parts[0];
    var mimeMatch = meta.match(/data:([^;]+);base64/i);
    var mime = mimeMatch ? mimeMatch[1] : String(originalFile && originalFile.type || "image/jpeg");
    var binary = atob(parts[1]);
    var length = binary.length;
    var bytes = new Uint8Array(length);
    for (var i = 0; i < length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    var baseName = String(originalFile && originalFile.name || "question-image").replace(/\.[^.]+$/, "");
    var extension = mime === "image/png" ? ".png" : mime === "image/webp" ? ".webp" : mime === "image/gif" ? ".gif" : ".jpg";
    return new File([bytes], baseName + extension, { type: mime });
  }

  async function prepareQuestionUploadFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) {
      return [];
    }
    var prepared = [];
    for (var i = 0; i < files.length; i += 1) {
      var file = files[i];
      try {
        var dataUrl = await compressFileToDataUrl(file);
        prepared.push(dataUrlToFile(dataUrl, file));
      } catch (_err) {
        prepared.push(file);
      }
    }
    return prepared;
  }

  function readFilesAsUrls(fileList, testId, questionId) {
    var list = Array.prototype.slice.call(fileList || []);
    if (!list.length) {
      return Promise.resolve([]);
    }
    return Promise.all(list.map(function (file) {
      return compressFileToDataUrl(file);
    }));
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

  function isExamLikeRoute(view) {
    return view === "instructions" || view === "test" || view === "results";
  }

  function clearKeepAliveTimer() {
    if (runtime.keepAliveTimerId) {
      window.clearTimeout(runtime.keepAliveTimerId);
      runtime.keepAliveTimerId = null;
    }
  }

  function shouldRunKeepAlive() {
    if (document.hidden) {
      return false;
    }
    var user = auth.getCurrentUser ? auth.getCurrentUser() : (store.getCurrentUser ? store.getCurrentUser() : null);
    return !!(user && user.id);
  }

  function scheduleKeepAlive(delayMs) {
    clearKeepAliveTimer();
    if (!shouldRunKeepAlive()) {
      return;
    }
    runtime.keepAliveTimerId = window.setTimeout(function () {
      runKeepAlive();
    }, Math.max(30 * 1000, Number(delayMs) || KEEP_ALIVE_INTERVAL_MS));
  }

  function runKeepAlive() {
    if (runtime.keepAliveInFlight || !shouldRunKeepAlive()) {
      scheduleKeepAlive(KEEP_ALIVE_INTERVAL_MS);
      return;
    }

    runtime.keepAliveInFlight = true;
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timeoutId = window.setTimeout(function () {
      if (controller) {
        try {
          controller.abort();
        } catch (_err) {}
      }
    }, KEEP_ALIVE_TIMEOUT_MS);

    Promise.resolve(store.touchPresence ? store.touchPresence() : fetch("/api/auth/me", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      signal: controller ? controller.signal : undefined,
    }))
      .catch(function () {})
      .finally(function () {
        runtime.keepAliveInFlight = false;
        runtime.keepAliveLastPingAt = Date.now();
        window.clearTimeout(timeoutId);
        scheduleKeepAlive(KEEP_ALIVE_INTERVAL_MS);
      });
  }

  function updateKeepAliveState() {
    if (!shouldRunKeepAlive()) {
      clearKeepAliveTimer();
      return;
    }
    if (!runtime.keepAliveTimerId && !runtime.keepAliveInFlight) {
      scheduleKeepAlive(KEEP_ALIVE_INTERVAL_MS);
    }
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
    runtime.lastPresencePingAt = 0;
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

  function buildShell(content, options) {
    options = options || {};
    var shellClass = "page-shell";
    var footerHtml = '<div class="app-footer">AceIIIT MockTest Portal</div>';
    if (options.fluid) {
      shellClass += " is-fluid";
    }
    if (options.hideFooter) {
      footerHtml = "";
    }
    return (
      '<main class="' + shellClass + '">' +
        content +
        footerHtml +
      "</main>"
    );
  }

  function getThemeToggleMarkup() {
    var effectiveTheme = getEffectiveTheme();
    var nextThemeLabel = effectiveTheme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    var icon = effectiveTheme === "dark" ? "☀" : "☾";
    return (
      '<button class="theme-nav-button" type="button" data-theme-toggle="true" aria-label="' + escapeAttribute(nextThemeLabel) + '" title="' + escapeAttribute(nextThemeLabel) + '">' +
        '<span class="theme-nav-icon" aria-hidden="true">' + icon + '</span>' +
      '</button>'
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
    if (!safeExpression) return "";

    // NOTE: We intentionally do NOT use eval/new Function because CSP blocks unsafe-eval in production.
    // This is a small expression evaluator supporting: + - * / % ( ) and decimals.
    function tokenize(expr) {
      var tokens = [];
      var i = 0;
      while (i < expr.length) {
        var ch = expr[i];
        if (ch === " ") {
          i += 1;
          continue;
        }
        if (ch === "(" || ch === ")") {
          tokens.push({ type: "paren", value: ch });
          i += 1;
          continue;
        }
        if (ch === "+" || ch === "-" || ch === "*" || ch === "/" || ch === "%") {
          tokens.push({ type: "op", value: ch });
          i += 1;
          continue;
        }
        // number
        if ((ch >= "0" && ch <= "9") || ch === ".") {
          var start = i;
          var dotCount = 0;
          while (i < expr.length) {
            var c = expr[i];
            if (c === ".") {
              dotCount += 1;
              if (dotCount > 1) break;
              i += 1;
              continue;
            }
            if (c >= "0" && c <= "9") {
              i += 1;
              continue;
            }
            break;
          }
          var raw = expr.slice(start, i);
          if (raw === "." || raw === "+." || raw === "-.") return null;
          var num = Number(raw);
          if (!Number.isFinite(num)) return null;
          tokens.push({ type: "number", value: num });
          continue;
        }
        return null;
      }
      return tokens;
    }

    function toRpn(tokens) {
      var output = [];
      var ops = [];
      var prevType = "start";

      function precedence(op) {
        if (op === "u-") return 3;
        if (op === "*" || op === "/" || op === "%") return 2;
        return 1;
      }

      function isLeftAssoc(op) {
        return op !== "u-";
      }

      for (var i = 0; i < tokens.length; i += 1) {
        var t = tokens[i];
        if (t.type === "number") {
          output.push(t);
          prevType = "number";
          continue;
        }

        if (t.type === "paren") {
          if (t.value === "(") {
            ops.push(t);
            prevType = "lparen";
            continue;
          }
          // ')'
          var found = false;
          while (ops.length) {
            var top = ops.pop();
            if (top.type === "paren" && top.value === "(") {
              found = true;
              break;
            }
            output.push(top);
          }
          if (!found) return null;
          prevType = "rparen";
          continue;
        }

        if (t.type === "op") {
          var op = t.value;
          // unary minus (and unary plus as no-op)
          var unary = (prevType === "start" || prevType === "op" || prevType === "lparen");
          if (unary && op === "+") {
            // ignore unary plus
            prevType = "op";
            continue;
          }
          if (unary && op === "-") {
            op = "u-";
          } else if (unary) {
            return null;
          }
          var o1 = { type: "op", value: op };
          while (ops.length) {
            var peek = ops[ops.length - 1];
            if (peek.type !== "op") break;
            var p1 = precedence(o1.value);
            var p2 = precedence(peek.value);
            if ((isLeftAssoc(o1.value) && p1 <= p2) || (!isLeftAssoc(o1.value) && p1 < p2)) {
              output.push(ops.pop());
              continue;
            }
            break;
          }
          ops.push(o1);
          prevType = "op";
          continue;
        }
        return null;
      }

      while (ops.length) {
        var last = ops.pop();
        if (last.type === "paren") return null;
        output.push(last);
      }
      return output;
    }

    function evalRpn(rpn) {
      var stack = [];
      for (var i = 0; i < rpn.length; i += 1) {
        var t = rpn[i];
        if (t.type === "number") {
          stack.push(t.value);
          continue;
        }
        if (t.type === "op" && t.value === "u-") {
          if (stack.length < 1) return null;
          stack.push(-stack.pop());
          continue;
        }
        if (t.type === "op") {
          if (stack.length < 2) return null;
          var b = stack.pop();
          var a = stack.pop();
          var res = null;
          if (t.value === "+") res = a + b;
          else if (t.value === "-") res = a - b;
          else if (t.value === "*") res = a * b;
          else if (t.value === "/") res = b === 0 ? NaN : a / b;
          else if (t.value === "%") res = b === 0 ? NaN : a % b;
          else return null;
          if (!Number.isFinite(res)) return null;
          stack.push(res);
          continue;
        }
        return null;
      }
      if (stack.length !== 1) return null;
      return stack[0];
    }

    // Quick char validation (reject anything unexpected early).
    if (!/^[0-9+\-*/().% ]+$/.test(safeExpression)) return "Error";

    var tokens = tokenize(safeExpression);
    if (!tokens || !tokens.length) return "Error";
    var rpn = toRpn(tokens);
    if (!rpn) return "Error";
    var result = evalRpn(rpn);
    if (!Number.isFinite(result)) return "Error";
    return String(Math.round(result * 1000000) / 1000000);
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
    app.innerHTML = buildShell(
      '<section class="editorial-shell">' +
        '<div class="hero-panel">' +
          '<div class="brand-row">' +
            '<div class="brand-mark"><span class="brand-dot"></span> AceIIIT</div>' +
            '<div class="button-row">' +
              '<div class="status-note">UGEE Pattern Portal</div>' +
              getThemeToggleMarkup() +
            '</div>' +
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
            '<h2>Email OTP Login</h2>' +
            '<p class="auth-copy">Enter your email to receive a one-time password. OTP expires in 5 minutes.</p>' +
          '</div>' +
          '<form id="otp-login-form" class="grid-two">' +
            '<div class="field" style="grid-column: 1 / -1;"><label for="otp-login-email">Email</label><input id="otp-login-email" name="email" type="email" placeholder="student@example.com" required></div>' +
            '<div class="field" style="grid-column: 1 / -1;"><label for="otp-login-name">Full name (first time only)</label><input id="otp-login-name" name="name" placeholder="Your name"></div>' +
            '<div class="button-row" style="grid-column: 1 / -1;">' +
              '<button class="button button-secondary" type="button" data-otp-send="login">Send OTP</button>' +
            '</div>' +
            '<div class="field" style="grid-column: 1 / -1; display:none;" data-otp-code-field="login"><label for="otp-login-code">OTP</label><input id="otp-login-code" name="otp" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit OTP"></div>' +
            '<div class="button-row" style="grid-column: 1 / -1; display:none;" data-otp-verify-row="login">' +
              '<button class="button button-primary" type="submit" data-otp-verify="login">Verify & Login</button>' +
            '</div>' +
          '</form>' +
          '<form id="otp-signup-form" class="grid-two" style="display:none;">' +
            '<div class="field" style="grid-column: 1 / -1;"><label for="otp-signup-name">Full name</label><input id="otp-signup-name" name="name" placeholder="Your name" required></div>' +
            '<div class="field" style="grid-column: 1 / -1;"><label for="otp-signup-email">Email</label><input id="otp-signup-email" name="email" type="email" placeholder="student@example.com" required></div>' +
            '<div class="button-row" style="grid-column: 1 / -1;">' +
              '<button class="button button-secondary" type="button" data-otp-send="signup">Send OTP</button>' +
            '</div>' +
            '<div class="field" style="grid-column: 1 / -1; display:none;" data-otp-code-field="signup"><label for="otp-signup-code">OTP</label><input id="otp-signup-code" name="otp" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit OTP"></div>' +
            '<div class="button-row" style="grid-column: 1 / -1; display:none;" data-otp-verify-row="signup">' +
              '<button class="button button-primary" type="submit" data-otp-verify="signup">Verify & Create Account</button>' +
            '</div>' +
          '</form>' +
          '<div id="auth-feedback" class="banner" style="display:none;"></div>' +
          '<p class="helper-text">' + escapeHtml(loginSettings.seriesName || "UGEE 2026") + ' test series • Free + paid access</p>' +
        '</aside>' +
      '</section>'
    );

    var loginForm = document.getElementById("otp-login-form");
    var signupForm = document.getElementById("otp-signup-form");
    var feedback = document.getElementById("auth-feedback");
    var uiState = loadLocalDraft(AUTH_UI_STATE_KEY) || { mode: "login", otpShown: { login: false, signup: false } };

    function persistAuthUiState(next) {
      uiState = Object.assign({}, uiState, next || {});
      uiState.mode = uiState.mode === "signup" ? "signup" : "login";
      uiState.otpShown = Object.assign({ login: false, signup: false }, uiState.otpShown || {});
      saveLocalDraft(AUTH_UI_STATE_KEY, uiState);
    }

    function showOtpFields(mode) {
      var codeField = app.querySelector("[data-otp-code-field='" + mode + "']");
      var verifyRow = app.querySelector("[data-otp-verify-row='" + mode + "']");
      if (codeField) {
        codeField.style.display = "block";
      }
      if (verifyRow) {
        verifyRow.style.display = "flex";
      }
      var sendBtn = app.querySelector("[data-otp-send='" + mode + "']");
      if (sendBtn && String(sendBtn.textContent || "").trim() === "Send OTP") {
        sendBtn.textContent = "Resend OTP";
      }
    }

    function applyAuthUiState() {
      var mode = uiState.mode === "signup" ? "signup" : "login";
      app.querySelectorAll("[data-auth-mode]").forEach(function (tab) {
        tab.classList.toggle("is-active", tab.dataset.authMode === mode);
      });
      if (loginForm) loginForm.style.display = mode === "login" ? "grid" : "none";
      if (signupForm) signupForm.style.display = mode === "signup" ? "grid" : "none";
      if (uiState.otpShown && uiState.otpShown.login) showOtpFields("login");
      if (uiState.otpShown && uiState.otpShown.signup) showOtpFields("signup");
    }

    // Preserve auth form state across refresh / tab switches.
    restoreDraft(loginForm, AUTH_LOGIN_DRAFT_KEY, "login");
    restoreDraft(signupForm, AUTH_SIGNUP_DRAFT_KEY, "signup");
    bindDraftAutosave(loginForm, AUTH_LOGIN_DRAFT_KEY, function () { return "login"; });
    bindDraftAutosave(signupForm, AUTH_SIGNUP_DRAFT_KEY, function () { return "signup"; });
    applyAuthUiState();

    function showFeedback(message, isError) {
      feedback.style.display = "block";
      feedback.textContent = message;
      feedback.style.background = isError ? "rgba(183, 58, 40, 0.18)" : "rgba(197, 160, 40, 0.16)";
      feedback.style.color = isError ? "#fff1ee" : "#f7f0e4";
    }

    function friendlyFetchFailure(message) {
      var base = message || "Could not reach the backend.";
      if (String(message || "").toLowerCase().indexOf("failed to fetch") !== -1) {
        if (window.location && window.location.protocol === "file:") {
          return "Backend is not reachable because the portal is opened as a file. Start the backend and open http://localhost:4000 instead.";
        }
        return "Backend is not reachable. Start the backend (backend/server.js) and refresh.";
      }
      return base;
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
        persistAuthUiState({ mode: mode });
      });
    });

    async function handleSendOtp(mode) {
      feedback.style.display = "none";
      var form = mode === "signup" ? signupForm : loginForm;
      var button = app.querySelector("[data-otp-send='" + mode + "']");
      if (!form || !button) {
        return;
      }

      button.disabled = true;
      var oldText = button.textContent;
      button.textContent = "Sending...";
      try {
        var data = new FormData(form);
        await auth.sendOtp({ email: data.get("email") });
        showFeedback("OTP sent. Check your email.", false);
        persistAuthUiState({ mode: mode, otpShown: Object.assign({}, uiState.otpShown, (function () { var s = {}; s[mode] = true; return s; })()) });
        showOtpFields(mode);
        var codeInput = document.getElementById(mode === "signup" ? "otp-signup-code" : "otp-login-code");
        if (codeInput) {
          codeInput.focus();
        }
      } catch (error) {
        showFeedback(friendlyFetchFailure(error && error.message ? error.message : ""), true);
      } finally {
        button.disabled = false;
        button.textContent = oldText === "Send OTP" ? "Resend OTP" : oldText;
      }
    }

    app.querySelectorAll("[data-otp-send]").forEach(function (button) {
      button.addEventListener("click", function () {
        handleSendOtp(button.dataset.otpSend);
      });
    });

    function bindVerify(form, mode) {
      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        feedback.style.display = "none";
        var verifyButton = app.querySelector("[data-otp-verify='" + mode + "']");
        if (verifyButton) {
          verifyButton.disabled = true;
          verifyButton.textContent = "Verifying...";
        }
        try {
          var data = new FormData(event.currentTarget);
          await auth.verifyOtp({
            email: data.get("email"),
            otp: data.get("otp"),
            name: data.get("name")
          });
          clearLocalDraft(mode === "signup" ? AUTH_SIGNUP_DRAFT_KEY : AUTH_LOGIN_DRAFT_KEY);
          clearLocalDraft(AUTH_UI_STATE_KEY);
          navigate("dashboard");
        } catch (error) {
          showFeedback(friendlyFetchFailure(error && error.message ? error.message : "OTP verification failed."), true);
        } finally {
          if (verifyButton) {
            verifyButton.disabled = false;
            verifyButton.textContent = mode === "signup" ? "Verify & Create Account" : "Verify & Login";
          }
        }
      });
    }

    bindVerify(loginForm, "login");
    bindVerify(signupForm, "signup");
  }

  function renderDashboard(user) {
    var snapshot = store.getDashboardSnapshot(user.id);
    var appConfig = store.getAppConfig ? store.getAppConfig() : { ugeeExamDate: null, featuredTestId: "", noticeTitle: "", noticeBody: "" };
    var featuredTest = appConfig && appConfig.featuredTestId
      ? snapshot.tests.find(function (test) { return test.id === appConfig.featuredTestId; }) || null
      : null;
    var featuredBannerHtml = featuredTest
      ? (
        '<div class="dashboard-highlight-banner">' +
          '<p class="section-label" style="margin:0;">Up Soon</p>' +
          '<strong>' + escapeHtml(featuredTest.title) + '</strong>' +
          '<span>' + escapeHtml(featuredTest.subtitle || "This mock is being prepared and will appear on your dashboard soon.") + '</span>' +
        '</div>'
      )
      : "";
    var noticeBoardHtml = appConfig && (appConfig.noticeTitle || appConfig.noticeBody)
      ? (
        '<div class="dashboard-notice-card">' +
          '<div class="notice-board-frame">' +
            '<span class="notice-pin notice-pin-left" aria-hidden="true"></span>' +
            '<span class="notice-pin notice-pin-right" aria-hidden="true"></span>' +
            '<div class="notice-board-paper">' +
              '<p class="section-label">Notice board</p>' +
              (appConfig.noticeTitle ? '<h3>' + escapeHtml(appConfig.noticeTitle) + '</h3>' : "") +
              (appConfig.noticeBody ? '<p>' + escapeHtml(appConfig.noticeBody).replace(/\n/g, "<br>") + '</p>' : "") +
            '</div>' +
          '</div>' +
        '</div>'
      )
      : '<div class="dashboard-notice-card"><div class="notice-board-frame"><span class="notice-pin notice-pin-left" aria-hidden="true"></span><span class="notice-pin notice-pin-right" aria-hidden="true"></span><div class="notice-board-paper"><p class="section-label">Notice board</p><div class="empty-state">No notice from admin right now.</div></div></div></div>';
    var reminderEligibleTests = snapshot.tests.filter(function (test) {
      if (!test || test.status !== "live") {
        return false;
      }
      if (!test.isFree && !user.isPaid && !auth.isAdmin(user)) {
        return false;
      }
      return true;
    });
    var reminders = store.listReminders ? store.listReminders().sort(function (left, right) {
      return new Date(left.plannedAt || left.remindAt || 0).getTime() - new Date(right.plannedAt || right.remindAt || 0).getTime();
    }) : [];
    var plannerEvents = buildPlannerEvents(snapshot, reminders);
    var editingReminder = runtime.dashboardEditingReminderId
      ? reminders.find(function (item) { return item.id === runtime.dashboardEditingReminderId; }) || null
      : null;
    var plannerStats = buildPlannerStats(plannerEvents);
    var plannerRecommendations = buildPlannerRecommendations(plannerEvents, snapshot);
    var plannerDayBuckets = getPlannerDayBuckets(plannerEvents);
    runtime.dashboardPlannerView = ["planner", "history", "reports"].indexOf(runtime.dashboardPlannerView) >= 0
      ? runtime.dashboardPlannerView
      : "planner";
    var examDateValue = toDateInputValue(appConfig && appConfig.ugeeExamDate);
    runtime.dashboardReminderDate = editingReminder && editingReminder.plannedAt
      ? toDateInputValue(editingReminder.plannedAt)
      : (runtime.dashboardReminderDate || toDateInputValue(new Date(Date.now() + (24 * 60 * 60 * 1000))));
    runtime.dashboardCalendarMonth = editingReminder && editingReminder.plannedAt
      ? toMonthKey(editingReminder.plannedAt)
      : (runtime.dashboardCalendarMonth || toMonthKey(runtime.dashboardReminderDate || examDateValue || new Date()));
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
      var isExpiredInProgress = isAttemptExpired(inProgress, test);
      var plannedEventsForTest = plannerEvents.filter(function (event) {
        return event.mockId === test.id && (event.status === "planned" || event.status === "ongoing");
      });
      var nextPlannedEvent = plannedEventsForTest[0] || null;
      var submitted = attempts.filter(function (attempt) {
        return attempt.status === "submitted";
      });
      var latestSubmitted = submitted[0] || null;
      var locked = !test.isFree && !user.isPaid && !auth.isAdmin(user);
      var sectionLabel = test.isFree ? "Free mock" : "Paid mock";
      var actionHtml = inProgress
        ? (isExpiredInProgress
            ? '<button class="button button-primary js-restart-attempt" data-id="' + test.id + '" data-attempt="' + inProgress.id + '">Restart Test</button><button class="button button-secondary js-quit-attempt" data-id="' + test.id + '" data-attempt="' + inProgress.id + '">Quit Test</button>'
            : '<button class="button button-primary js-resume-test" data-id="' + test.id + '" data-attempt="' + inProgress.id + '">Resume Test</button><button class="button button-secondary js-quit-attempt" data-id="' + test.id + '" data-attempt="' + inProgress.id + '">Quit Test</button>')
        : '<button class="button button-primary js-open-instructions" data-id="' + test.id + '">Start Test</button>';
      var reportHtml = latestSubmitted
        ? '<button class="button button-secondary js-open-result" data-id="' + latestSubmitted.id + '">Last Report</button>'
        : "";

      if (locked) {
        actionHtml =
          '<button class="button button-primary" type="button" disabled>Locked 🔒</button>' +
          '<button class="button button-secondary js-buy-series" type="button" data-id="' + test.id + '">Buy Test Series</button>';
        reportHtml = latestSubmitted
          ? '<button class="button button-secondary js-open-result" data-id="' + latestSubmitted.id + '">Last Report</button>'
          : "";
      }

      return (
        '<article class="dashboard-card">' +
          '<p class="section-label">' + escapeHtml(sectionLabel) + '</p>' +
          '<h3>' + escapeHtml(test.title) + '</h3>' +
          (nextPlannedEvent ? '<div class="planner-inline-row"><span class="meta-chip is-live">Planned</span><span class="helper-text">Next: ' + escapeHtml(formatDateOnly(nextPlannedEvent.plannedAt)) + ' • ' + escapeHtml(formatTimeOnly(nextPlannedEvent.plannedAt)) + '</span></div>' : '') +
          '<p>' + escapeHtml(test.subtitle) + '</p>' +
          '<div class="meta-row">' +
            '<span class="meta-chip">' + getTotalDuration(test) + ' mins total</span>' +
            '<span class="meta-chip">SUPR ' + test.sectionDurations.SUPR + 'm | REAP ' + test.sectionDurations.REAP + 'm</span>' +
            '<span class="meta-chip">' + (Number(test.questionCount || 0) || test.questionIds.length) + ' questions</span>' +
            '<span class="meta-chip">Locked sectional flow</span>' +
            (locked ? '<span class="meta-chip" style="background: rgba(217, 170, 55, 0.18); border-color: rgba(217, 170, 55, 0.25);">Locked</span>' : '') +
            (inProgress && !locked ? '<span class="meta-chip ' + (isExpiredInProgress ? 'is-draft' : '') + '">' + escapeHtml(isExpiredInProgress ? 'Old unfinished attempt' : 'Attempt in progress') + '</span>' : '') +
          '</div>' +
          (inProgress && !locked ? '<div class="helper-text" style="margin-top: 10px;">' + escapeHtml(isExpiredInProgress ? 'Your older unfinished attempt can no longer be resumed safely. Quit it and restart from a fresh attempt.' : 'You can resume this unfinished attempt, or quit it from here and start over.') + '</div>' : '') +
          '<div class="divider"></div>' +
          '<div class="button-row">' + actionHtml + reportHtml + (locked ? '' : '<button class="button button-secondary js-plan-test" data-id="' + test.id + '">' + (nextPlannedEvent ? 'Edit Plan' : 'Plan Mock') + '</button>') + '</div>' +
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
    var reminderMonthCells = buildCalendarCells(runtime.dashboardCalendarMonth);
    var selectedDateEvents = getEventsForDate(plannerEvents, runtime.dashboardReminderDate);
    var plannerHistoryEvents = plannerEvents.filter(function (event) { return event.status === "completed"; }).slice(0, 6);
    var countdownDays = examDateValue ? Math.max(0, Math.ceil((new Date(appConfig.ugeeExamDate).getTime() - Date.now()) / (24 * 60 * 60 * 1000))) : null;
    var suggestedMocksRemaining = Math.max(0, plannerStats.weeklyGoal - plannerStats.weeklyCompleted);
    var reminderOptionValues = [10, 30, 60, 1440];
    var modalDate = runtime.dashboardPlannerModalDate || "";
    var modalDateEvents = modalDate ? getEventsForDate(plannerEvents, modalDate) : [];
    var modalFormReminder = editingReminder || null;
    var modalDefaultTestId = runtime.dashboardScheduleModalTestId || (modalFormReminder ? modalFormReminder.testId : ((reminderEligibleTests[0] && reminderEligibleTests[0].id) || ""));
    var modalDefaultDate = modalDate || runtime.dashboardReminderDate;
    var modalDefaultTime = modalFormReminder && modalFormReminder.plannedAt
      ? formatTimeOnly(modalFormReminder.plannedAt)
      : "19:00";
    var modalDefaultReminderMinutes = modalFormReminder ? Number(modalFormReminder.reminderMinutes || 300) : 60;
    var modalDefaultNotes = modalFormReminder ? (modalFormReminder.notes || "") : "";
    var modalDefaultSubjectFocus = normalizeSubjectFocus(modalFormReminder ? modalFormReminder.subjectFocus : []);
    var notificationPromptHtml = ("Notification" in window) && Notification.permission !== "granted"
      ? '<button class="button button-secondary button-compact" type="button" id="planner-enable-notifications">Enable alerts</button>'
      : '<span class="meta-chip">Browser alerts ready</span>';
    var plannerBucketSections = [];
    if (plannerDayBuckets.today.length) {
      plannerBucketSections.push(renderPlannerBucket("Today", plannerDayBuckets.today, "No mocks scheduled for today."));
    }
    if (plannerDayBuckets.tomorrow.length) {
      plannerBucketSections.push(renderPlannerBucket("Tomorrow", plannerDayBuckets.tomorrow, "Nothing lined up for tomorrow yet."));
    }
    if (plannerDayBuckets.upcoming.length) {
      plannerBucketSections.push(renderPlannerBucket("Upcoming", plannerDayBuckets.upcoming.slice(0, 6), "Your future plans will appear here."));
    }
    var plannerUpcomingHtml = plannerBucketSections.length
      ? '<div class="planner-sidebar-stack">' + plannerBucketSections.join("") + '</div>'
      : '<div class="planner-bucket"><div class="planner-bucket-head"><p class="section-label">Upcoming</p><span>0</span></div><div class="empty-state planner-empty">Your future plans will appear here once you schedule a mock.</div></div>';
    var plannerTabsHtml =
      '<div class="planner-top-tabs" role="tablist" aria-label="Dashboard planner sections">' +
        '<button class="planner-tab-button js-planner-view' + (runtime.dashboardPlannerView === "planner" ? ' is-active' : '') + '" type="button" data-view="planner" role="tab" aria-selected="' + (runtime.dashboardPlannerView === "planner" ? 'true' : 'false') + '"><span aria-hidden="true">&#128197;</span> Planner</button>' +
        '<button class="planner-tab-button js-planner-view' + (runtime.dashboardPlannerView === "history" ? ' is-active' : '') + '" type="button" data-view="history" role="tab" aria-selected="' + (runtime.dashboardPlannerView === "history" ? 'true' : 'false') + '"><span aria-hidden="true">&#128340;</span> History</button>' +
        '<button class="planner-tab-button js-planner-view' + (runtime.dashboardPlannerView === "reports" ? ' is-active' : '') + '" type="button" data-view="reports" role="tab" aria-selected="' + (runtime.dashboardPlannerView === "reports" ? 'true' : 'false') + '"><span aria-hidden="true">&#128196;</span> Reports</button>' +
      '</div>';
    var plannerViewHtml =
      runtime.dashboardPlannerView === "history"
        ? (
          '<div class="planner-tab-panel planner-history-panel">' +
            '<div class="planner-panel-head"><div><p class="section-label" style="margin:0;">Completed History</p><h3>Mock timeline</h3></div><span class="meta-chip">' + escapeHtml(String(plannerHistoryEvents.length)) + ' recent</span></div>' +
            (plannerHistoryEvents.length
              ? '<div class="planner-history-list planner-history-list-large">' + plannerHistoryEvents.map(function (event) {
                  return '<div class="planner-history-item"><strong>' + escapeHtml(event.title) + '</strong><span>' + escapeHtml(formatDateOnly(event.plannedAt)) + ' &bull; ' + escapeHtml(event.startTime) + '</span><span>Score ' + escapeHtml(String(event.score || 0)) + ' &bull; Accuracy ' + escapeHtml(String(event.accuracy || 0)) + '%</span><div class="button-row"><button class="button button-secondary button-compact js-open-result" data-id="' + escapeAttribute(event.completedAttempt && event.completedAttempt.id || "") + '">Quick Review</button></div></div>';
                }).join("") + '</div>'
              : '<div class="empty-state planner-empty">Complete a planned mock to unlock your history timeline.</div>') +
          '</div>'
        )
        : runtime.dashboardPlannerView === "reports"
          ? (
            '<div class="planner-tab-panel planner-reports-panel">' +
              '<div class="planner-panel-head"><div><p class="section-label" style="margin:0;">My Reports</p><h3>Saved result reports</h3></div><span class="meta-chip">' + escapeHtml(String(snapshot.attempts.filter(function (attempt) { return attempt.status === "submitted" && attempt.resultSnapshot; }).length)) + '</span></div>' +
              reportsHtml +
            '</div>'
          )
          : (
            '<div class="planner-tab-panel planner-main-panel">' +
              '<div class="planner-summary-strip">' +
                '<div class="planner-countdown-card">' +
                  '<p class="section-label" style="margin:0;">UGEE 2026</p>' +
                  '<strong>' + escapeHtml(countdownDays === null ? "Date pending" : (String(countdownDays) + " Days Left")) + '</strong>' +
                  '<span>' + escapeHtml(countdownDays === null ? "Admin will set the final date soon." : (String(suggestedMocksRemaining) + " mocks left this week at your current pace.")) + '</span>' +
                '</div>' +
                '<div class="planner-goal-card">' +
                  '<div class="planner-goal-head"><p class="section-label" style="margin:0;">Weekly goal</p><span>' + escapeHtml(String(plannerStats.weeklyCompleted)) + '/' + escapeHtml(String(plannerStats.weeklyGoal)) + '</span></div>' +
                  '<div class="planner-progress"><span style="width:' + escapeAttribute(String(Math.min(100, Math.round((plannerStats.weeklyCompleted / Math.max(1, plannerStats.weeklyGoal)) * 100)))) + '%;"></span></div>' +
                  '<div class="helper-text">Consistency: ' + escapeHtml(String(plannerStats.weeklyConsistency)) + '% &bull; Streak: ' + escapeHtml(String(plannerStats.currentStreak)) + ' day(s)</div>' +
                '</div>' +
              '</div>' +
              '<div class="calendar-head">' +
                '<div><p class="section-label" style="margin:0;">Mock planner</p><h3>' + escapeHtml(formatMonthLabel(runtime.dashboardCalendarMonth)) + '</h3></div>' +
                '<div class="button-row">' +
                  notificationPromptHtml +
                  '<button class="button button-secondary button-compact planner-arrow-button" type="button" id="calendar-prev-month" aria-label="Previous month">&larr;</button>' +
                  '<button class="button button-secondary button-compact planner-arrow-button" type="button" id="calendar-next-month" aria-label="Next month">&rarr;</button>' +
                '</div>' +
              '</div>' +
              (runtime.dashboardNotificationMessage ? '<div class="planner-inline-alert">' + escapeHtml(runtime.dashboardNotificationMessage) + '</div>' : '') +
              '<div class="calendar-weekdays">' + ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(function (label) {
                return '<span>' + label + '</span>';
              }).join("") + '</div>' +
              '<div class="calendar-grid" id="planner-calendar-grid">' + reminderMonthCells.map(function (cell) {
                var classes = ["calendar-cell"];
                if (!cell.inMonth) classes.push("is-muted");
                if (cell.iso === runtime.dashboardReminderDate) classes.push("is-selected");
                if (examDateValue && cell.iso === examDateValue) classes.push("is-exam-day");
                if (cell.iso === toDateInputValue(new Date())) classes.push("is-today");
                var cellEvents = getEventsForDate(plannerEvents, cell.iso);
                if (cellEvents.some(function (event) { return event.status === "ongoing"; })) classes.push("has-live");
                var tooltipText = cellEvents.length ? (cellEvents.length + " planned mock" + (cellEvents.length > 1 ? "s" : "")) : "No planned mocks";
                var dotsHtml = cellEvents.slice(0, 3).map(function (event) {
                  var meta = getPlannerStatusMeta(event.status);
                  var dotClass = (cell.iso === toDateInputValue(new Date()) && event.status === "planned") ? "is-live" : meta.dot;
                  return '<span class="calendar-dot ' + escapeAttribute(dotClass) + '"></span>';
                }).join("");
                return '<button type="button" class="' + classes.join(" ") + '" data-calendar-date="' + escapeAttribute(cell.iso) + '" title="' + escapeAttribute(tooltipText) + '"><span class="calendar-date-number">' + escapeHtml(String(cell.label)) + '</span><span class="calendar-dot-stack">' + dotsHtml + (cellEvents.length > 3 ? '<span class="calendar-dot-more">+' + escapeHtml(String(cellEvents.length - 3)) + '</span>' : '') + '</span><span class="calendar-tooltip">' + escapeHtml(tooltipText) + '</span></button>';
              }).join("") + '</div>' +
              '<div class="calendar-helper">' + (examDateValue ? ('UGEE exam day: ' + escapeHtml(formatDateOnly(appConfig.ugeeExamDate))) : 'Admin has not set the UGEE exam date yet.') + '</div>' +
              '<div class="planner-analytics-grid planner-analytics-grid-compact">' +
                '<div class="planner-analytics-card"><strong>' + escapeHtml(String(plannerStats.totalPlanned)) + '</strong><span>Total planned mocks</span></div>' +
                '<div class="planner-analytics-card"><strong>' + escapeHtml(String(plannerStats.completed)) + '</strong><span>Completed mocks</span></div>' +
                '<div class="planner-analytics-card"><strong>' + escapeHtml(String(plannerStats.missed)) + '</strong><span>Missed mocks</span></div>' +
                '<div class="planner-analytics-card"><strong>' + escapeHtml(String(plannerStats.completionRate)) + '%</strong><span>Completion rate</span></div>' +
                '<div class="planner-analytics-card"><strong>' + escapeHtml(String(plannerStats.weeklyConsistency)) + '%</strong><span>Weekly consistency</span></div>' +
                '<div class="planner-analytics-card"><strong>' + escapeHtml(String(plannerStats.monthlyActivity)) + '</strong><span>Monthly activity</span></div>' +
              '</div>' +
              '<div class="planner-main-grid">' +
                '<div class="planner-selected-date-card">' +
                  '<div class="planner-bucket-head"><p class="section-label">Selected date</p><span>' + escapeHtml(formatDateOnly(runtime.dashboardReminderDate)) + '</span></div>' +
                  (selectedDateEvents.length
                    ? '<div class="planner-event-list compact-scroll">' + selectedDateEvents.map(function (event) {
                        return renderPlannerEventCard(event, { showQuickStart: true, showManageActions: true });
                      }).join("") + '</div>'
                    : '<div class="empty-state planner-empty">No planned mocks on this date yet. Click any mock card to schedule one.</div>') +
                '</div>' +
                '<div class="planner-right-rail">' +
                  plannerUpcomingHtml +
                  '<div class="planner-insight-card planner-recommendation-card"><p class="section-label">Recommendations</p><strong>' + escapeHtml(plannerRecommendations.nextMock ? plannerRecommendations.nextMock.title : "Schedule your next mock") + '</strong><span>Best timing: ' + escapeHtml(plannerRecommendations.bestHour) + '</span><span>Weak zone: ' + escapeHtml(plannerRecommendations.weakSection) + '</span><span>' + escapeHtml(plannerRecommendations.consistencyTip) + '</span></div>' +
                '</div>' +
              '</div>' +
            '</div>'
          );
    var calendarHtml =
      '<div class="dashboard-calendar-card planner-section-shell">' +
        plannerTabsHtml +
        plannerViewHtml +
      '</div>';
    var plannerModalHtml = (runtime.dashboardPlannerModalDate || runtime.dashboardScheduleModalTestId)
      ? (
        '<div class="transition-modal planner-modal-overlay" id="planner-modal-overlay">' +
          '<div class="planner-modal-card">' +
            '<div class="planner-modal-head"><div><p class="section-label" style="margin:0;">Planner</p><h3>' + escapeHtml(runtime.dashboardPlannerModalDate ? ('Plans for ' + formatDateOnly(runtime.dashboardPlannerModalDate)) : 'Schedule mock') + '</h3></div><button class="button button-secondary button-compact" type="button" id="planner-modal-close">Close</button></div>' +
            '<div class="planner-modal-body">' +
              '<div class="planner-modal-column">' +
                '<p class="section-label">Planned mocks on this date</p>' +
                (modalDateEvents.length
                  ? '<div class="planner-event-list modal-scroll">' + modalDateEvents.map(function (event) {
                      return renderPlannerEventCard(event, { showQuickStart: true, showManageActions: true });
                    }).join("") + '</div>'
                  : '<div class="empty-state planner-empty">No mocks are planned on this date yet.</div>') +
              '</div>' +
              '<div class="planner-modal-column">' +
                '<p class="section-label">' + escapeHtml(editingReminder ? 'Edit scheduled mock' : 'Schedule a mock') + '</p>' +
                '<form id="reminder-form" class="grid-two planner-form">' +
                  '<div class="field" style="grid-column: 1 / -1;"><label for="reminder-title">Plan title</label><input id="reminder-title" name="title" value="' + escapeAttribute(editingReminder ? editingReminder.title : "Attempt mock test") + '" required></div>' +
                  '<div class="field"><label for="reminder-test">Live mock</label><select id="reminder-test" name="testId" required>' +
                    reminderEligibleTests.map(function (test) { return '<option value="' + escapeAttribute(test.id) + '"' + (modalDefaultTestId === test.id ? ' selected' : '') + '>' + escapeHtml(test.title) + '</option>'; }).join("") +
                  '</select></div>' +
                  '<div class="field"><label for="reminder-date">Date</label><input id="reminder-date" name="date" type="date" value="' + escapeAttribute(modalDefaultDate) + '" required></div>' +
                  '<div class="field"><label for="reminder-time">Time</label><input id="reminder-time" name="time" type="time" value="' + escapeAttribute(modalDefaultTime) + '" required></div>' +
                  '<div class="field"><label for="reminder-window">Reminder</label><select id="reminder-window" name="reminderMinutes">' + reminderOptionValues.map(function (minutes) {
                    return '<option value="' + escapeAttribute(String(minutes)) + '"' + (Number(modalDefaultReminderMinutes) === minutes ? ' selected' : '') + '>' + escapeHtml(formatReminderLabel(minutes)) + '</option>';
                  }).join("") + '</select></div>' +
                  '<div class="field" style="grid-column: 1 / -1;"><label>Subject focus</label><div class="planner-tag-grid">' + ["Physics", "Maths", "Logical"].map(function (subject) {
                    return '<label class="planner-tag-option"><input type="checkbox" name="subjectFocus" value="' + escapeAttribute(subject) + '"' + (modalDefaultSubjectFocus.indexOf(subject) >= 0 ? ' checked' : '') + '><span>' + escapeHtml(subject) + '</span></label>';
                  }).join("") + '</div></div>' +
                  '<div class="field" style="grid-column: 1 / -1;"><label for="reminder-notes">Notes</label><textarea id="reminder-notes" name="notes" rows="3" placeholder="Focus points or plan notes">' + escapeHtml(modalDefaultNotes) + '</textarea></div>' +
                  '<div class="field" style="grid-column: 1 / -1;"><div class="helper-text">Reminder email and optional browser alert will use your logged-in email ' + escapeHtml(user.email || "") + '.</div></div>' +
                  '<div class="button-row" style="grid-column: 1 / -1;"><button class="button button-primary" type="submit"' + (reminderEligibleTests.length ? '' : ' disabled') + '>' + (editingReminder ? 'Update plan' : 'Save plan') + '</button>' + (editingReminder ? '<button class="button button-secondary" type="button" id="cancel-reminder-edit">Cancel</button>' : '') + '</div>' +
                '</form>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</div>'
      )
      : "";

    app.innerHTML = buildShell(
      '<section class="dashboard-hero">' +
        '<div class="dashboard-bar">' +
          '<div class="brand-mark"><span class="brand-dot"></span> AceIIIT</div>' +
          '<div class="button-row">' +
            getThemeToggleMarkup() +
            (auth.isAdmin(user) ? '<span class="meta-chip" style="align-self:center; margin-right: 10px;">Admin</span>' : "") +
            (auth.isAdmin(user) ? '<button class="button button-secondary" id="admin-link">Builder Mode</button>' : "") +
            '<button class="button button-secondary" id="logout-button">Logout</button>' +
          '</div>' +
        '</div>' +
        '<p class="section-label" style="margin-top: 18px;">Dashboard</p>' +
        '<h1>' + escapeHtml(timeGreeting()) + ', ' + escapeHtml(firstName(user.name)) + '.</h1>' +
        '<p>Choose a paper, read the instructions, and start the timed SUPR → REAP flow.</p>' +
        '<div class="dashboard-top-notes">' + featuredBannerHtml + noticeBoardHtml + '</div>' +
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
          calendarHtml +
        '</aside>' +
      '</section>' +
      plannerModalHtml
    );

    document.getElementById("logout-button").addEventListener("click", function () {
      auth.logout();
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

    app.querySelectorAll(".js-buy-series").forEach(function (button) {
      button.addEventListener("click", function () {
        openBuySeries();
      });
    });

    app.querySelectorAll(".js-planner-view").forEach(function (button) {
      button.addEventListener("click", function () {
        runtime.dashboardPlannerView = button.dataset.view || "planner";
        renderDashboard(user);
      });
    });

    app.querySelectorAll(".js-resume-test").forEach(function (button) {
      button.addEventListener("click", function () {
        var existingAttempt = button.dataset.attempt ? store.getAttemptById(button.dataset.attempt) : store.getInProgressAttempt(user.id, button.dataset.id);
        var attemptTest = store.getTestById(button.dataset.id);
        if (existingAttempt && isAttemptExpired(existingAttempt, attemptTest)) {
          var shouldRestart = window.confirm("This unfinished attempt is too old to resume safely. Restart it from the beginning?");
          if (!shouldRestart) {
            return;
          }
          store.discardAttempt(existingAttempt.id);
          navigate("instructions/" + button.dataset.id);
          return;
        }
        var attempt = existingAttempt || store.getOrCreateAttempt(user.id, button.dataset.id);
        navigate("test/" + attempt.id);
      });
    });

    app.querySelectorAll(".js-quit-attempt").forEach(function (button) {
      button.addEventListener("click", function () {
        var attemptId = button.dataset.attempt;
        if (!attemptId) {
          return;
        }
        var shouldQuit = window.confirm("Quit this unfinished test? Your saved in-progress answers for this attempt will be removed.");
        if (!shouldQuit) {
          return;
        }
        store.discardAttempt(attemptId);
        if (runtime.attemptId === attemptId) {
          stopRuntime(true);
        }
        renderDashboard(user);
      });
    });

    app.querySelectorAll(".js-restart-attempt").forEach(function (button) {
      button.addEventListener("click", function () {
        var attemptId = button.dataset.attempt;
        var testId = button.dataset.id;
        var shouldRestart = window.confirm("Restart this test from the beginning? The old unfinished attempt will be removed.");
        if (!shouldRestart) {
          return;
        }
        if (attemptId) {
          store.discardAttempt(attemptId);
          if (runtime.attemptId === attemptId) {
            stopRuntime(true);
          }
        }
        navigate("instructions/" + testId);
      });
    });

    app.querySelectorAll(".js-open-result").forEach(function (button) {
      button.addEventListener("click", function () {
        navigate("results/" + button.dataset.id);
      });
    });

    function openPlannerModal(dateIso, testId) {
      runtime.dashboardPlannerModalDate = dateIso || runtime.dashboardReminderDate;
      runtime.dashboardReminderDate = runtime.dashboardPlannerModalDate;
      runtime.dashboardScheduleModalTestId = testId || "";
      renderDashboard(user);
    }

    function closePlannerModal() {
      runtime.dashboardPlannerModalDate = "";
      runtime.dashboardScheduleModalTestId = "";
      runtime.dashboardEditingReminderId = null;
      renderDashboard(user);
    }

    function startMockFromPlanner(testId) {
      if (!testId) return;
      var existingAttempt = store.getInProgressAttempt(user.id, testId);
      var attemptTest = store.getTestById(testId);
      if (existingAttempt && isAttemptExpired(existingAttempt, attemptTest)) {
        store.discardAttempt(existingAttempt.id);
        existingAttempt = null;
      }
      if (existingAttempt) {
        navigate("test/" + existingAttempt.id);
        return;
      }
      navigate("instructions/" + testId);
    }

    app.querySelectorAll(".js-plan-test").forEach(function (button) {
      button.addEventListener("click", function () {
        openPlannerModal(runtime.dashboardReminderDate || toDateInputValue(new Date()), button.dataset.id);
      });
    });

    app.querySelectorAll(".js-start-planned-mock").forEach(function (button) {
      button.addEventListener("click", function () {
        startMockFromPlanner(button.dataset.test);
      });
    });

    app.querySelectorAll("[data-calendar-date]").forEach(function (button) {
      button.addEventListener("click", function () {
        runtime.dashboardReminderDate = button.getAttribute("data-calendar-date") || runtime.dashboardReminderDate;
        runtime.dashboardPlannerModalDate = runtime.dashboardReminderDate;
        runtime.dashboardScheduleModalTestId = "";
        renderDashboard(user);
      });
    });
    var calendarPrevMonth = document.getElementById("calendar-prev-month");
    if (calendarPrevMonth) {
      calendarPrevMonth.addEventListener("click", function () {
        runtime.dashboardCalendarMonth = shiftMonthKey(runtime.dashboardCalendarMonth, -1);
        renderDashboard(user);
      });
    }
    var calendarNextMonth = document.getElementById("calendar-next-month");
    if (calendarNextMonth) {
      calendarNextMonth.addEventListener("click", function () {
        runtime.dashboardCalendarMonth = shiftMonthKey(runtime.dashboardCalendarMonth, 1);
        renderDashboard(user);
      });
    }
    var plannerCalendarGrid = document.getElementById("planner-calendar-grid");
    if (plannerCalendarGrid) {
      plannerCalendarGrid.addEventListener("touchstart", function (event) {
        var touch = event.touches && event.touches[0];
        if (!touch) return;
        runtime.dashboardTouchStartX = touch.clientX;
        runtime.dashboardTouchStartY = touch.clientY;
      }, { passive: true });
      plannerCalendarGrid.addEventListener("touchend", function (event) {
        var touch = event.changedTouches && event.changedTouches[0];
        if (!touch) return;
        var deltaX = touch.clientX - Number(runtime.dashboardTouchStartX || 0);
        var deltaY = touch.clientY - Number(runtime.dashboardTouchStartY || 0);
        if (Math.abs(deltaX) > 40 && Math.abs(deltaY) < 30) {
          runtime.dashboardCalendarMonth = shiftMonthKey(runtime.dashboardCalendarMonth, deltaX < 0 ? 1 : -1);
          renderDashboard(user);
        }
      }, { passive: true });
    }
    var enableNotifications = document.getElementById("planner-enable-notifications");
    if (enableNotifications) {
      enableNotifications.addEventListener("click", function () {
        requestPlannerNotificationPermission().finally(function () {
          renderDashboard(user);
        });
      });
    }
    var plannerModalClose = document.getElementById("planner-modal-close");
    if (plannerModalClose) {
      plannerModalClose.addEventListener("click", function () {
        closePlannerModal();
      });
    }
    var plannerModalOverlay = document.getElementById("planner-modal-overlay");
    if (plannerModalOverlay) {
      plannerModalOverlay.addEventListener("click", function (event) {
        if (event.target === plannerModalOverlay) {
          closePlannerModal();
        }
      });
    }
    var reminderForm = document.getElementById("reminder-form");
    if (reminderForm) {
      reminderForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        var form = new FormData(reminderForm);
        var remindAt = String(form.get("date") || "") + "T" + String(form.get("time") || "00:00") + ":00";
        var selectedTestId = String(form.get("testId") || "").trim();
        var reminderMinutes = Number(form.get("reminderMinutes") || 60);
        var subjectFocus = normalizeSubjectFocus(form.getAll("subjectFocus"));
        var notes = String(form.get("notes") || "").trim();
        var duplicatePlan = plannerEvents.find(function (plannerEvent) {
          return plannerEvent.mockId === selectedTestId &&
            plannerEvent.plannedAt === new Date(remindAt).toISOString() &&
            plannerEvent.id !== (editingReminder && editingReminder.id);
        });
        if (duplicatePlan) {
          var allowDuplicate = window.confirm("This mock is already planned at the same time. Do you still want to save another plan?");
          if (!allowDuplicate) {
            return;
          }
        }
        showOverlayLoader(editingReminder ? "Updating plan." : "Saving plan.");
        try {
          var payload = {
            title: form.get("title"),
            testId: selectedTestId,
            remindAt: new Date(remindAt).toISOString(),
            reminderMinutes: reminderMinutes,
            subjectFocus: subjectFocus,
            notes: notes,
          };
          if (editingReminder) {
            await store.updateReminder(editingReminder.id, payload);
            runtime.dashboardEditingReminderId = null;
          } else {
            await store.createReminder(payload);
          }
          runtime.dashboardReminderDate = String(form.get("date") || runtime.dashboardReminderDate);
          runtime.dashboardPlannerModalDate = runtime.dashboardReminderDate;
          runtime.dashboardScheduleModalTestId = "";
          runtime.dashboardNotificationMessage = "Planner updated for " + String(form.get("title") || "your mock") + ".";
          await store.refreshFromRemote();
          schedulePlannerNotifications(buildPlannerEvents(store.getDashboardSnapshot(user.id), store.listReminders ? store.listReminders() : []));
          renderDashboard(user);
        } finally {
          hideOverlayLoader();
        }
      });
    }
    var cancelReminderEdit = document.getElementById("cancel-reminder-edit");
    if (cancelReminderEdit) {
      cancelReminderEdit.addEventListener("click", function () {
        runtime.dashboardEditingReminderId = null;
        runtime.dashboardScheduleModalTestId = "";
        renderDashboard(user);
      });
    }
    app.querySelectorAll(".js-edit-reminder").forEach(function (button) {
      button.addEventListener("click", function () {
        runtime.dashboardEditingReminderId = button.dataset.id;
        var currentEvent = plannerEvents.find(function (event) { return event.id === button.dataset.id; });
        runtime.dashboardPlannerModalDate = currentEvent ? currentEvent.date : runtime.dashboardReminderDate;
        renderDashboard(user);
      });
    });
    app.querySelectorAll(".js-reschedule-reminder").forEach(function (button) {
      button.addEventListener("click", function () {
        runtime.dashboardEditingReminderId = button.dataset.id;
        var currentEvent = plannerEvents.find(function (event) { return event.id === button.dataset.id; });
        runtime.dashboardPlannerModalDate = currentEvent ? currentEvent.date : runtime.dashboardReminderDate;
        renderDashboard(user);
      });
    });
    app.querySelectorAll(".js-quick-reschedule").forEach(function (button) {
      button.addEventListener("click", async function () {
        var currentEvent = plannerEvents.find(function (event) { return event.id === button.dataset.id; });
        if (!currentEvent) return;
        var suggestedDate = suggestRescheduleSlot(plannerEvents, new Date());
        showOverlayLoader("Rescheduling mock.");
        try {
          await store.updateReminder(currentEvent.id, {
            title: currentEvent.title,
            testId: currentEvent.mockId,
            remindAt: suggestedDate.toISOString(),
            reminderMinutes: currentEvent.reminder,
            subjectFocus: currentEvent.subjectFocus,
            notes: currentEvent.notes,
          });
          runtime.dashboardPlannerModalDate = toDateInputValue(suggestedDate);
          await store.refreshFromRemote();
          renderDashboard(user);
        } finally {
          hideOverlayLoader();
        }
      });
    });
    app.querySelectorAll(".js-delete-reminder").forEach(function (button) {
      button.addEventListener("click", async function () {
        var confirmed = window.confirm("Delete this scheduled mock plan?");
        if (!confirmed) {
          return;
        }
        await store.deleteReminder(button.dataset.id);
        if (runtime.dashboardEditingReminderId === button.dataset.id) {
          runtime.dashboardEditingReminderId = null;
        }
        runtime.dashboardNotificationMessage = "Planned mock removed.";
        renderDashboard(user);
      });
    });
    schedulePlannerNotifications(plannerEvents);
  }

  function syncAndRenderCurrentRoute() {
    var currentView = routeParts()[0] || "";
    if (isExamLikeRoute(currentView)) {
      try {
        renderRoute();
      } catch (renderError) {
        console.error("AceIIIT render error:", renderError);
        renderAppErrorState("We could not open this exam screen cleanly.");
      }
      return;
    }

    if (syncInFlight) {
      syncQueued = true;
      return;
    }
    syncInFlight = true;
    showOverlayLoader("Syncing the newest backend changes into this screen.");
    Promise.resolve(store.refreshFromRemote ? store.refreshFromRemote() : true).then(function () {
      try {
        renderRoute();
      } catch (renderError) {
        console.error("AceIIIT render error:", renderError);
        renderAppErrorState("The latest data arrived, but this page failed to render cleanly.");
      }
    }).catch(function (error) {
      console.error("AceIIIT sync error:", error);
      try {
        renderRoute();
      } catch (renderError) {
        console.error("AceIIIT fallback render error:", renderError);
        renderAppErrorState("Sync failed and the fallback render also failed.");
      }
    }).finally(function () {
      syncInFlight = false;
      window.requestAnimationFrame(function () {
        window.setTimeout(hideOverlayLoader, 180);
      });
      if (syncQueued) {
        syncQueued = false;
        window.setTimeout(syncAndRenderCurrentRoute, 0);
      }
    });
  }

  function startSyncPolling() {
    if (syncPollId) {
      window.clearInterval(syncPollId);
    }
    syncPollId = window.setInterval(function () {
      if (remoteChangeUnsubscribe) {
        return;
      }
      var parts = routeParts();
      var view = parts[0] || "";
      if (document.hidden) {
        return;
      }
      if (view === "admin" && hasPendingQuestionUploadState()) {
        return;
      }
      if (view === "dashboard" || view === "admin" || view === "admin-activity" || view === "results" || view === "") {
        Promise.resolve(store.refreshFromRemote ? store.refreshFromRemote() : true).then(function (result) {
          if (result && result.changed) {
            syncAndRenderCurrentRoute();
          }
        });
      }
    }, 15000);
  }

  function renderInstructions(user, testId, prefetchedQuestions) {
    var instructionTest = store.getTestById(testId);
    var initialQuestions = Array.isArray(prefetchedQuestions) ? prefetchedQuestions.slice() : store.getQuestionsForTest(testId);
    var expectedQuestionCount = instructionTest ? Number(instructionTest.questionCount || 0) : 0;
    if (!auth.isAdmin(user) && !Array.isArray(prefetchedQuestions) && store.getTestQuestionsFromRemote) {
      renderLoadingScreen("Loading test paper.");
      Promise.resolve(store.getTestQuestionsFromRemote(testId))
        .then(function (freshQuestions) {
          renderInstructions(user, testId, Array.isArray(freshQuestions) ? freshQuestions : []);
        })
        .catch(function (error) {
          window.alert(error && error.message ? error.message : "Could not load this test.");
          navigate("dashboard");
        });
      return;
    }
    if (!auth.isAdmin(user) && store.ensureTestQuestionsLoaded && (!initialQuestions.length || (expectedQuestionCount && initialQuestions.length < expectedQuestionCount))) {
      renderLoadingScreen("Loading test paper.");
      Promise.resolve(store.ensureTestQuestionsLoaded(testId))
        .then(function (freshQuestions) {
          renderInstructions(user, testId, Array.isArray(freshQuestions) ? freshQuestions : store.getQuestionsForTest(testId));
        })
        .catch(function (error) {
          window.alert(error && error.message ? error.message : "Could not load this test.");
          navigate("dashboard");
        });
      return;
    }
    var test = store.getTestById(testId);
    var questions = initialQuestions.length ? initialQuestions : store.getQuestionsForTest(testId);
    var canLaunchTest = questions.length > 0;
    var grouped = questions.reduce(function (accumulator, question) {
      accumulator[question.section] = accumulator[question.section] || [];
      accumulator[question.section].push(question);
      return accumulator;
    }, {});

    if (!test) {
      navigate("dashboard");
      return;
    }

    if (!test.isFree && !user.isPaid && !auth.isAdmin(user)) {
      app.innerHTML = buildShell(
        '<section class="report-layout">' +
          '<div class="report-bar">' +
            '<div class="brand-mark"><span class="brand-dot"></span> AceIIIT</div>' +
            '<div class="button-row">' +
              getThemeToggleMarkup() +
              '<button class="button button-secondary" id="back-dashboard">Dashboard</button>' +
            '</div>' +
          '</div>' +
          '<div class="report-body">' +
            '<div class="report-card">' +
              '<p class="section-label">Paid test</p>' +
              '<h1>Buy Test Series to unlock 🔒</h1>' +
              '<p>This mock is part of the paid UGEE 2026 series. Complete payment and ensure your email is verified. Then log out and log in again to sync access.</p>' +
              '<div class="button-row">' +
                '<button class="button button-secondary" id="buy-series">Buy Test Series</button>' +
              '</div>' +
            '</div>' +
          '</div>' +
        '</section>'
      );
      document.getElementById("back-dashboard").addEventListener("click", function () {
        navigate("dashboard");
      });
      document.getElementById("buy-series").addEventListener("click", function () {
        openBuySeries();
      });
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
          '<div class="button-row">' +
            getThemeToggleMarkup() +
          '</div>' +
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
            (!canLaunchTest ? '<div class="exam-warning-banner" style="margin: 12px 0 0;">This paper has no questions yet. Ask the admin to attach questions before starting it.</div>' : '') +
            '<div class="utility-bottom-actions">' +
              '<button class="button button-secondary" id="back-dashboard">Previous</button>' +
              '<button class="button button-primary" id="begin-test" disabled ' + (!canLaunchTest ? 'title="No questions attached"' : '') + '>I am ready to begin</button>' +
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
      beginButton.disabled = !readyCheck.checked || !canLaunchTest;
    });

    document.getElementById("back-dashboard").addEventListener("click", function () {
      navigate("dashboard");
    });

    beginButton.addEventListener("click", async function () {
      if (!canLaunchTest) {
        window.alert("This test has no questions yet. It cannot be launched right now.");
        return;
      }
      var attempt = store.getOrCreateAttempt(user.id, testId);
      if (!attempt && !auth.isAdmin(user) && store.getTestQuestionsFromRemote) {
        try {
          await store.getTestQuestionsFromRemote(testId);
          attempt = store.getOrCreateAttempt(user.id, testId);
        } catch (_err) {}
      }
      if (!attempt) {
        window.alert("This test cannot start because no valid questions are attached.");
        return;
      }
      navigate("test/" + attempt.id);
    });
  }

  function renderTest(user, attemptId) {
    var attempt = store.getAttemptById(attemptId);
    if (!attempt) {
      navigate("dashboard");
      return;
    }

    var initialQuestions = store.getQuestionsForTest(attempt.testId);
    var attemptTest = store.getTestById(attempt.testId);
    var expectedQuestionCount = attemptTest ? Number(attemptTest.questionCount || 0) : 0;
    if (!auth.isAdmin(user) && store.ensureTestQuestionsLoaded && (!initialQuestions.length || (expectedQuestionCount && initialQuestions.length < expectedQuestionCount))) {
      renderLoadingScreen("Loading your question paper.");
      Promise.resolve(store.ensureTestQuestionsLoaded(attempt.testId))
        .then(function () {
          renderTest(user, attemptId);
        })
        .catch(function (error) {
          window.alert(error && error.message ? error.message : "Could not load this test.");
          navigate("dashboard");
        });
      return;
    }

    var test = store.getTestById(attempt.testId);
    if (isAttemptExpired(attempt, test)) {
      window.alert("This unfinished attempt is too old to resume safely. Please restart it from the dashboard.");
      navigate("dashboard");
      return;
    }
    var questions = initialQuestions.length ? initialQuestions : store.getQuestionsForTest(attempt.testId);
    var suprQuestions = getSectionQuestions(questions, "SUPR");
    var reapQuestions = getSectionQuestions(questions, "REAP");

    async function submitAndNavigate() {
      if (runtime.submittingAttemptId === attempt.id) {
        return;
      }

      runtime.submittingAttemptId = attempt.id;
      showOverlayLoader("Submitting your paper.");
      try {
        var submittedAttempt = await store.submitAttempt(attempt.id);
        stopRuntime(false);
        runtime.pendingSectionTransition = null;
        runtime.imageLightboxUrl = "";
        if (submittedAttempt && submittedAttempt.id) {
          navigate("results/" + submittedAttempt.id);
          return;
        }
        navigate("dashboard");
      } catch (submitError) {
        console.error("AceIIIT submit error:", submitError);
        window.alert("We could not submit this attempt cleanly. Please try again.");
      } finally {
        runtime.submittingAttemptId = null;
        hideOverlayLoader();
      }
    }

    function activateReap() {
      var firstReapQuestion = reapQuestions[0];
      if (!firstReapQuestion) {
        submitAndNavigate();
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
      submitAndNavigate();
      return;
    }

    var remainingSeconds = getSectionTimeLeft(attempt, activeSection);
    if (activeSection === "REAP" && remainingSeconds <= 0) {
      flushQuestionTime();
      submitAndNavigate();
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
                '<p class="exam-questiontext rich-text">' + formatRichText(currentQuestion.prompt) + '</p>' +
                (currentQuestion.passage ? '<div class="passage exam-passage rich-text">' + formatRichText(currentQuestion.passage) + '</div>' : "") +
                renderQuestionFigures(currentQuestion) +
                getCalculatorMarkup() +
                '<div class="options exam-options">' +
                  currentQuestion.options.map(function (option, index) {
                    var checked = String(attempt.answers[currentQuestion.id]) === String(index);
                    return (
                      '<label class="option-card exam-option ' + (checked ? "is-selected" : "") + '">' +
                        '<input type="radio" name="answer" value="' + index + '" ' + (checked ? "checked" : "") + '>' +
                        '<span class="rich-text">' + formatRichText(option) + '</span>' +
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
      '</section>',
      { hideThemeToggle: true }
    );
    renderLatexInElement(document.body);
    bindFigureLoadDiagnostics();

    function refreshExamSidebar(nextAttempt) {
      var nextActiveSection = nextAttempt.activeSection || activeSection;
      var nextActiveQuestions = nextActiveSection === "REAP" ? reapQuestions : suprQuestions;
      var nextAnsweredCount = questions.filter(function (question) {
        return nextAttempt.answers[question.id] !== undefined && nextAttempt.answers[question.id] !== null && nextAttempt.answers[question.id] !== "";
      }).length;
      var nextStatusCounts = {
        answered: 0,
        "not-answered": 0,
        "not-visited": 0,
        marked: 0,
        "answered-marked": 0
      };

      nextActiveQuestions.forEach(function (question) {
        nextStatusCounts[getQuestionStatus(nextAttempt, question.id)] += 1;
      });

      [
        ["answered", nextStatusCounts.answered],
        ["not-answered", nextStatusCounts["not-answered"]],
        ["not-visited", nextStatusCounts["not-visited"]],
        ["marked", nextStatusCounts.marked],
        ["answered-marked", nextStatusCounts["answered-marked"]]
      ].forEach(function (entry) {
        var counter = app.querySelector(".status-count." + entry[0]);
        if (counter) {
          counter.textContent = String(entry[1]);
        }
      });

      app.querySelectorAll(".palette-button[data-question]").forEach(function (button) {
        var questionId = button.dataset.question;
        var status = getQuestionStatus(nextAttempt, questionId);
        button.className = "palette-button status-" + status + (questionId === currentQuestion.id ? " is-current" : "");
      });

      var progressLine = app.querySelector(".progress-line span");
      if (progressLine) {
        progressLine.style.width = (questions.length ? ((nextAnsweredCount / questions.length) * 100) : 0) + "%";
      }

      var progressNote = app.querySelector(".list-note");
      if (progressNote) {
        progressNote.textContent = nextAnsweredCount + " of " + questions.length + " answered across the paper.";
      }
    }

    function refreshCurrentQuestionSelection(nextAttempt) {
      var selectedValue = nextAttempt.answers[currentQuestion.id];
      app.querySelectorAll('input[name="answer"]').forEach(function (input) {
        var checked = String(selectedValue) === String(input.value);
        input.checked = checked;
        var optionCard = input.closest(".option-card");
        if (optionCard) {
          optionCard.classList.toggle("is-selected", checked);
        }
      });
    }

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
        attempt = store.getAttemptById(attempt.id);
        refreshCurrentQuestionSelection(attempt);
        refreshExamSidebar(attempt);
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
      attempt = store.getAttemptById(attempt.id);
      refreshCurrentQuestionSelection(attempt);
      refreshExamSidebar(attempt);
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
      button.addEventListener("click", async function () {
        var action = button.dataset.transitionAction;
        if (action === "cancel") {
          runtime.pendingSectionTransition = null;
          renderTest(user, attempt.id);
          return;
        }

        if (runtime.pendingSectionTransition && runtime.pendingSectionTransition.mode === "submit") {
          flushQuestionTime();
          await submitAndNavigate();
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
      if (!runtime.lastPresencePingAt || (Date.now() - runtime.lastPresencePingAt) >= 15000) {
        store.patchAttempt(liveAttempt.id, function () {});
        runtime.lastPresencePingAt = Date.now();
      }
      if (!timerDisplay) {
        return;
      }

      timerDisplay.textContent = formatTime(secondsLeft);
      timerDisplay.classList.toggle("is-warning", secondsLeft <= 600 && secondsLeft > 300);
      timerDisplay.classList.toggle("is-danger", secondsLeft <= 300);

      if (liveAttempt.activeSection === "REAP" && secondsLeft <= 0) {
        flushQuestionTime();
        submitAndNavigate();
      }
    }, 1000);
  }

  function renderResults(user, attemptId, skipRefresh, prefetchedAttempt, prefetchedSummary) {
    if (!skipRefresh && store.getAttemptResult) {
      renderLoadingScreen("Loading your latest evaluated result.");
      Promise.resolve(store.getAttemptResult(attemptId))
        .then(function (freshAttempt) {
          renderResults(user, attemptId, true, freshAttempt || null, null);
        })
        .catch(function () {
          renderResults(user, attemptId, true);
        });
      return;
    }
    var attempt = prefetchedAttempt || store.getAttemptById(attemptId);
    if (!attempt || attempt.status !== "submitted" || !attempt.result) {
      navigate("dashboard");
      return;
    }

    var test = store.getTestById(attempt.testId);
    var questions = store.getQuestionsForTest(attempt.testId);
    var maxScore = questions.reduce(function (sum, q) { return sum + Number(q.marks || 0); }, 0);
    var result = attempt.result;
    var analysis = (prefetchedSummary && prefetchedSummary.analysis) || result.analysis || null;
    var sectionScores = result.sectionScores || {};
    var analysisHydrating = !analysis && !!store.getAttemptAnalysis && !prefetchedSummary;

    function buildSectionScoresFromSummary(summary) {
      var source = summary && summary.sectionWise ? summary.sectionWise : null;
      if (!source) return null;
      return {
        SUPR: {
          score: Number(source.SUPR && source.SUPR.score || 0),
          correct: Number(source.SUPR && source.SUPR.correct || 0),
          wrong: Number(source.SUPR && source.SUPR.wrong || 0),
          skipped: Number(source.SUPR && source.SUPR.skipped || 0),
        },
        REAP: {
          score: Number(source.REAP && source.REAP.score || 0),
          correct: Number(source.REAP && source.REAP.correct || 0),
          wrong: Number(source.REAP && source.REAP.wrong || 0),
          skipped: Number(source.REAP && source.REAP.skipped || 0),
        },
      };
    }

    if ((!sectionScores || !Object.keys(sectionScores).length) && prefetchedSummary && prefetchedSummary.sectionWise) {
      sectionScores = buildSectionScoresFromSummary(prefetchedSummary);
    } else if ((!sectionScores || !Object.keys(sectionScores).length) && analysis && Array.isArray(analysis.sectionInsights)) {
      sectionScores = analysis.sectionInsights.reduce(function (acc, section) {
        acc[section.key] = {
          score: Number(section.score || 0),
          correct: Number(section.correct || 0),
          wrong: Number(section.wrong || 0),
          skipped: Number(section.skipped || 0),
        };
        return acc;
      }, {});
    }

    function stageStyle(index) {
      return ' style="animation-delay:' + String(index * 100) + 'ms"';
    }

    function analysisToneClass(label) {
      var normalized = String(label || "").toLowerCase();
      if (normalized.indexOf("excellent") !== -1 || normalized.indexOf("on pace") !== -1) return "is-strong";
      if (normalized.indexOf("competitive") !== -1 || normalized.indexOf("balanced") !== -1) return "is-good";
      if (normalized.indexOf("recoverable") !== -1 || normalized.indexOf("slightly slow") !== -1) return "is-watch";
      return "is-focus";
    }

    function buildAnalysisCards(summary) {
      if (!summary) return "";
      return (
        '<div class="analysis-showcase">' +
          '<div class="analysis-spotlight analysis-stage ' + analysisToneClass(summary.scoreLabel) + '"' + stageStyle(0) + '>' +
            '<span class="analysis-kicker">Score band</span>' +
            '<strong>' + escapeHtml(String(summary.scoreLabel || "Balanced")) + '</strong>' +
            '<span>' + escapeHtml(String(summary.scorePercentage || 0)) + '% of total marks captured</span>' +
          '</div>' +
          '<div class="analysis-spotlight analysis-stage ' + analysisToneClass(summary.paceLabel) + '"' + stageStyle(1) + '>' +
            '<span class="analysis-kicker">Pace signal</span>' +
            '<strong>' + escapeHtml(String(summary.paceLabel || "Balanced")) + '</strong>' +
            '<span>Avg ' + escapeHtml(String(summary.avgSecondsPerAttempted || 0)) + 's per attempted question</span>' +
          '</div>' +
        '</div>' +
        '<div class="analysis-mini-grid">' +
          '<div class="analysis-mini-card analysis-stage"' + stageStyle(2) + '><span class="analysis-kicker">Completion</span><strong>' + escapeHtml(String(summary.completionRate || 0)) + '%</strong><small>Paper coverage</small></div>' +
          '<div class="analysis-mini-card analysis-stage"' + stageStyle(3) + '><span class="analysis-kicker">Attempted</span><strong>' + escapeHtml(String(summary.attemptedCount || 0)) + '/' + escapeHtml(String(summary.totalQuestions || 0)) + '</strong><small>Questions taken</small></div>' +
          '<div class="analysis-mini-card analysis-stage"' + stageStyle(4) + '><span class="analysis-kicker">Best section</span><strong>' + escapeHtml(String(summary.strongSection ? summary.strongSection.key : "-")) + '</strong><small>' + escapeHtml(String(summary.strongSection ? summary.strongSection.accuracy : 0)) + '% accuracy</small></div>' +
          '<div class="analysis-mini-card analysis-stage"' + stageStyle(5) + '><span class="analysis-kicker">Focus section</span><strong>' + escapeHtml(String(summary.weakSection ? summary.weakSection.key : "-")) + '</strong><small>' + escapeHtml(String(summary.weakSection ? summary.weakSection.accuracy : 0)) + '% accuracy</small></div>' +
        '</div>'
      );
    }

    function buildSectionPanel(summary) {
      if (!summary) return "";
      var sectionRows = Array.isArray(summary.sectionInsights) ? summary.sectionInsights : [];
      return (
        '<section class="analysis-stage"' + stageStyle(3) + '>' +
          '<div class="divider"></div>' +
          '<p class="section-label">Attempt analysis</p>' +
          buildAnalysisCards(summary) +
          '<div class="report-grid analysis-grid" style="margin-top: 18px;">' +
            '<div class="report-card analysis-panel">' +
              '<p class="section-label">Section-wise performance</p>' +
              (sectionRows.length
                ? '<div class="analysis-section-list">' + sectionRows.map(function (section) {
                    var meterWidth = Math.max(6, Math.min(100, Number(section.accuracy || 0)));
                    return (
                      '<div class="analysis-section-row">' +
                        '<div class="analysis-section-head">' +
                          '<strong>' + escapeHtml(section.key) + '</strong>' +
                          '<span class="analysis-pill">' + escapeHtml(String(section.accuracy)) + '% accuracy</span>' +
                        '</div>' +
                        '<div class="analysis-meter"><span data-width="' + meterWidth + '%"></span></div>' +
                        '<div class="analysis-section-meta">' +
                          '<span>Completion ' + escapeHtml(String(section.completion)) + '%</span>' +
                          '<span>Score ' + escapeHtml(String(section.score || 0)) + '</span>' +
                          '<span>Time ' + formatTime(Number(section.timeSpent || 0)) + '</span>' +
                          '<span>Avg/question ' + escapeHtml(String(section.avgTimePerAttempted || 0)) + 's</span>' +
                        '</div>' +
                      '</div>'
                    );
                  }).join("") + '</div>'
                : '<div class="empty-state">Section insights unavailable.</div>') +
            '</div>' +
            '<aside class="report-card analysis-panel">' +
              '<p class="section-label">Next-step plan</p>' +
              '<div class="analysis-plan-list">' +
                (summary.nextBenchmark !== null && summary.nextBenchmark !== undefined
                  ? '<div class="analysis-plan-row is-benchmark"><strong>Benchmark target</strong><span class="helper-text">You are ' + escapeHtml(String(summary.benchmarkGap || 0)) + ' marks away from the next benchmark (' + escapeHtml(String(summary.nextBenchmark)) + ').</span></div>'
                  : '<div class="analysis-plan-row is-benchmark"><strong>Benchmark target</strong><span class="helper-text">You are already at or above the configured benchmark range for this paper.</span></div>') +
                ((summary.recommendations || []).map(function (item, index) {
                  return '<div class="analysis-plan-row"><strong>Focus ' + escapeHtml(String(index + 1)) + '</strong><span class="helper-text">' + escapeHtml(item) + '</span></div>';
                }).join("") || '<div class="analysis-plan-row"><strong>Focus</strong><span class="helper-text">Keep practising with timed mixed sets to improve consistency.</span></div>') +
              '</div>' +
            '</aside>' +
          '</div>' +
        '</section>'
      );
    }

    function buildTopicPanel(summary) {
      var topics = summary && Array.isArray(summary.topicInsights) ? summary.topicInsights : [];
      if (!summary) return "";
      return (
        '<section class="report-card analysis-stage"' + stageStyle(4) + '>' +
          '<p class="section-label">Topic-wise analysis</p>' +
          (topics.length
            ? '<div class="analysis-topic-list">' + topics.map(function (topic, index) {
                var width = Math.max(4, Math.min(100, Number(topic.accuracy || 0)));
                return (
                  '<div class="analysis-topic-row">' +
                    '<div class="analysis-topic-head">' +
                      '<div><strong>' + escapeHtml(String(topic.topic || "General")) + '</strong><span>' + escapeHtml(String(topic.section || "")) + '</span></div>' +
                      '<span class="analysis-pill">' + escapeHtml(String(topic.accuracy || 0)) + '%</span>' +
                    '</div>' +
                    '<div class="analysis-meter analysis-meter-soft"><span data-width="' + width + '%"></span></div>' +
                    '<div class="analysis-section-meta">' +
                      '<span>Score ' + escapeHtml(String(topic.score || 0)) + '</span>' +
                      '<span>Attempted ' + escapeHtml(String(topic.attempted || 0)) + '/' + escapeHtml(String(topic.total || 0)) + '</span>' +
                      '<span>Time ' + formatTime(Number(topic.timeSpent || 0)) + '</span>' +
                      '<span>Ranked #' + escapeHtml(String(index + 1)) + ' focus</span>' +
                    '</div>' +
                  '</div>'
                );
              }).join("") + '</div>'
            : '<div class="empty-state">Topic insights will appear here once this paper is submitted on the latest analysis pipeline.</div>') +
        '</section>'
      );
    }

    function buildTimePanel(summary) {
      var timeInfo = summary && summary.timeAnalysis ? summary.timeAnalysis : null;
      if (!summary || !timeInfo) return "";
      var trackedWidth = timeInfo.totalTimeSeconds
        ? Math.max(6, Math.min(100, Math.round((Number(timeInfo.trackedTimeSeconds || 0) / Number(timeInfo.totalTimeSeconds || 1)) * 100)))
        : 0;
      return (
        '<section class="report-card analysis-stage"' + stageStyle(5) + '>' +
          '<p class="section-label">Time analysis</p>' +
          '<div class="analysis-time-grid">' +
            '<div class="analysis-time-card"><span class="analysis-kicker">Total time</span><strong>' + escapeHtml(formatTime(Number(timeInfo.totalTimeSeconds || 0))) + '</strong><small>Recorded for this attempt</small></div>' +
            '<div class="analysis-time-card"><span class="analysis-kicker">Avg per question</span><strong>' + escapeHtml(String(timeInfo.avgSecondsPerQuestion || 0)) + 's</strong><small>Across full paper</small></div>' +
            '<div class="analysis-time-card"><span class="analysis-kicker">Avg per attempted</span><strong>' + escapeHtml(String(timeInfo.avgSecondsPerAttempted || 0)) + 's</strong><small>Answered questions only</small></div>' +
            '<div class="analysis-time-card"><span class="analysis-kicker">Target pace</span><strong>' + escapeHtml(String(timeInfo.targetSecondsPerQuestion || 0)) + 's</strong><small>Ideal per-question speed</small></div>' +
          '</div>' +
          '<div class="analysis-time-meter">' +
            '<div class="analysis-meter"><span data-width="' + trackedWidth + '%"></span></div>' +
            '<div class="analysis-section-meta">' +
              '<span>Tracked time ' + escapeHtml(formatTime(Number(timeInfo.trackedTimeSeconds || 0))) + '</span>' +
              '<span>' + escapeHtml(timeInfo.timePressure ? "You were under time pressure." : "Time usage stayed under control.") + '</span>' +
              '<span>' + escapeHtml(timeInfo.fastButErrorProne ? "High speed is hurting accuracy." : "Speed and accuracy stayed balanced.") + '</span>' +
            '</div>' +
          '</div>' +
        '</section>'
      );
    }

    function buildDonutChartSvg(segments, total, centerLabel, centerValue) {
      var radius = 54;
      var circumference = 2 * Math.PI * radius;
      var offset = 0;
      var safeTotal = Number(total || 0);
      if (safeTotal <= 0) {
        safeTotal = (segments || []).reduce(function (sum, segment) {
          return sum + Number(segment.value || 0);
        }, 0);
      }
      var rings = (segments || []).map(function (segment) {
        var value = Math.max(0, Number(segment.value || 0));
        var fraction = safeTotal > 0 ? value / safeTotal : 0;
        var dash = Math.max(0, fraction * circumference);
        var ring = '<circle class="analysis-donut-segment" cx="70" cy="70" r="' + radius + '" stroke="' + escapeAttribute(segment.color) + '" stroke-dasharray="' + dash + ' ' + (circumference - dash) + '" stroke-dashoffset="' + (-offset) + '"></circle>';
        offset += dash;
        return ring;
      }).join("");
      return (
        '<div class="analysis-donut">' +
          '<svg viewBox="0 0 140 140" aria-hidden="true">' +
            '<circle class="analysis-donut-base" cx="70" cy="70" r="' + radius + '"></circle>' +
            rings +
          '</svg>' +
          '<div class="analysis-donut-center">' +
            '<span>' + escapeHtml(String(centerLabel || "")) + '</span>' +
            '<strong>' + escapeHtml(String(centerValue || "")) + '</strong>' +
          '</div>' +
        '</div>'
      );
    }

    function buildVisualAnalysisPanel(summary) {
      var sectionValues = ["SUPR", "REAP"].map(function (key) {
        return Number(sectionScores && sectionScores[key] && sectionScores[key].score || 0);
      });
      var sectionTotal = Math.max(1, sectionValues[0] + sectionValues[1]);
      var latestAttempts = attemptHistory.slice(0, 6).reverse();
      var maxHistoryScore = latestAttempts.reduce(function (max, item) {
        return Math.max(max, Number(item && item.result && item.result.score || 0));
      }, Math.max(1, Number(maxScore || 0)));
      var scorePercent = maxScore ? Math.round((Number(result.score || 0) / Number(maxScore || 1)) * 100) : 0;
      return (
        '<section class="report-card analysis-stage"' + stageStyle(2) + '>' +
          '<p class="section-label">Visual analysis</p>' +
          '<div class="analysis-visual-grid">' +
            '<div class="analysis-visual-card">' +
              '<div class="analysis-review-head">' +
                '<div><h3>Outcome split</h3><p class="helper-text">Correct vs wrong vs skipped</p></div>' +
              '</div>' +
              buildDonutChartSvg([
                { value: Number(result.correctCount || 0), color: "#239442" },
                { value: Number(result.wrongCount || 0), color: "#b73a28" },
                { value: Number(result.unattemptedCount !== undefined ? result.unattemptedCount : result.skippedCount || 0), color: "#c9b99f" }
              ], Number(questions.length || 0), "Coverage", scorePercent + "%") +
              '<div class="analysis-legend-row">' +
                '<span><i style="background:#239442"></i>Correct</span>' +
                '<span><i style="background:#b73a28"></i>Wrong</span>' +
                '<span><i style="background:#c9b99f"></i>Skipped</span>' +
              '</div>' +
            '</div>' +
            '<div class="analysis-visual-card">' +
              '<div class="analysis-review-head">' +
                '<div><h3>Section share</h3><p class="helper-text">Marks captured from each section</p></div>' +
              '</div>' +
              buildDonutChartSvg([
                { value: sectionValues[0], color: "#d8b13d" },
                { value: sectionValues[1], color: "#8f2d1f" }
              ], sectionTotal, "Score", String(result.score || 0)) +
              '<div class="analysis-legend-row">' +
                '<span><i style="background:#d8b13d"></i>SUPR</span>' +
                '<span><i style="background:#8f2d1f"></i>REAP</span>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="divider"></div>' +
          '<div class="analysis-visual-card">' +
            '<div class="analysis-review-head">' +
              '<div><h3>Attempt trend</h3><p class="helper-text">Latest scores for this same test</p></div>' +
            '</div>' +
            (latestAttempts.length
              ? '<div class="analysis-history-bars">' + latestAttempts.map(function (item, index) {
                  var score = Number(item && item.result && item.result.score || 0);
                  var height = Math.max(10, Math.min(100, Math.round((score / Math.max(1, maxHistoryScore)) * 100)));
                  var isCurrent = item.id === attempt.id;
                  return '<div class="analysis-history-bar' + (isCurrent ? ' is-current' : '') + '"><span style="height:' + height + '%;"></span><strong>' + escapeHtml(String(score)) + '</strong><small>A' + escapeHtml(String(item.attemptNumber || (index + 1))) + '</small></div>';
                }).join("") + '</div>'
              : '<div class="empty-state">Your next attempts will appear here as a score trend.</div>') +
          '</div>' +
        '</section>'
      );
    }

    function buildQuestionReviewShell() {
      return (
        '<section class="report-card analysis-stage"' + stageStyle(6) + '>' +
          '<div class="analysis-review-head">' +
            '<div>' +
              '<p class="section-label">Question review</p>' +
              '<h3>Load detailed review only when you need it</h3>' +
            '</div>' +
            '<div class="button-row">' +
              '<button class="button button-secondary" id="load-question-review"' + (analysis ? '' : ' disabled') + '>Load question review</button>' +
            '</div>' +
          '</div>' +
          '<div id="question-review-status" class="helper-text">' + (analysis ? 'Summary loads first. Detailed review stays lazy to keep this page fast.' : 'Question review is available for attempts submitted after the analysis upgrade.') + '</div>' +
          '<div id="question-review-list" class="analysis-review-list"></div>' +
          '<div class="button-row" id="question-review-more-row" style="display:none; margin-top: 14px;">' +
            '<button class="button button-secondary" id="load-more-review">Load more questions</button>' +
          '</div>' +
        '</section>'
      );
    }

    function buildSummaryPanels(summary) {
      var chips = summary && Array.isArray(summary.smartInsights) ? summary.smartInsights : [];
      var html = "";
      if (summary) {
        html += buildSectionPanel(summary);
      } else if (analysisHydrating) {
        html += (
          '<section class="report-card analysis-stage"' + stageStyle(2) + '>' +
            '<p class="section-label">Attempt analysis</p>' +
            '<div class="empty-state">Loading the latest stored analysis for this attempt.</div>' +
          '</section>'
        );
      } else {
        html += (
          '<section class="report-card analysis-stage"' + stageStyle(2) + '>' +
            '<p class="section-label">Attempt analysis</p>' +
            '<div class="empty-state">This attempt was submitted before the upgraded analysis system was enabled. Submit a new attempt to see section, topic, time, and question-level insights here.</div>' +
          '</section>'
        );
      }
      if (summary) {
        html += buildVisualAnalysisPanel(summary);
        html += buildTopicPanel(summary);
        html += buildTimePanel(summary);
      } else {
        html += buildVisualAnalysisPanel(null);
      }
      html += (
        '<section class="report-card analysis-stage"' + stageStyle(2) + '>' +
          '<div class="analysis-review-head">' +
            '<div>' +
              '<p class="section-label">Smart insights</p>' +
              '<h3>What this attempt is telling you</h3>' +
            '</div>' +
          '</div>' +
          (chips.length
            ? '<div class="analysis-chip-row">' + chips.map(function (chip) {
                return '<span class="analysis-chip">' + escapeHtml(String(chip)) + '</span>';
              }).join("") + '</div>'
            : '<div class="empty-state">' + (summary ? 'No smart insights were generated for this attempt.' : (analysisHydrating ? 'Loading the latest stored insights for this attempt.' : 'Detailed insights are available for newly submitted attempts after the analysis upgrade.')) + '</div>') +
        '</section>'
      );
      html += buildQuestionReviewShell();
      return html;
    }

    function buildOptionRow(text, optionIndex, review) {
      var classes = ["analysis-option"];
      if (Number(review.correctOption) === optionIndex) classes.push("is-correct");
      if (review.selectedOption === optionIndex && !review.isCorrect) classes.push("is-selected-wrong");
      if (review.selectedOption === optionIndex && review.isCorrect) classes.push("is-selected-correct");
      return (
        '<li class="' + classes.join(" ") + '">' +
          '<span class="analysis-option-index">' + escapeHtml(String(optionIndex + 1)) + '</span>' +
          '<div class="rich-text">' + formatRichText(text || "") + '</div>' +
        '</li>'
      );
    }

    function buildQuestionReviewItems(items, offset) {
      offset = Number(offset || 0);
      return (items || []).map(function (review, index) {
        var statusClass = review.status === "correct" ? "correct" : review.status === "wrong" ? "incorrect" : "neutral";
        return (
          '<article class="analysis-review-card">' +
            '<div class="analysis-review-meta">' +
              '<div>' +
                '<p class="section-label">Question ' + escapeHtml(String(offset + index + 1)) + '</p>' +
                '<h4>' + escapeHtml(String(review.topic || "General")) + ' · ' + escapeHtml(String(review.section || "")) + '</h4>' +
              '</div>' +
              '<div class="analysis-review-badges">' +
                '<span class="answer-chip ' + statusClass + '">' + escapeHtml(String(review.status || "skipped")) + '</span>' +
                '<span class="analysis-pill">' + escapeHtml(formatTime(Number(review.timeSpent || 0))) + '</span>' +
              '</div>' +
            '</div>' +
            (review.passage ? '<div class="analysis-review-block rich-text">' + formatRichText(review.passage) + '</div>' : '') +
            '<div class="analysis-review-block rich-text">' + formatRichText(review.prompt || "") + '</div>' +
            ((review.imageUrls || []).length
              ? '<div class="analysis-review-images">' + review.imageUrls.map(function (url) {
                  return '<button class="analysis-inline-image js-open-image-lightbox" data-url="' + escapeAttribute(url) + '"><img src="' + escapeAttribute(url) + '" alt="Question image"></button>';
                }).join("") + '</div>'
              : '') +
            '<ol class="analysis-option-list">' +
              ((review.options || []).map(function (option, optionIndex) {
                return buildOptionRow(option, optionIndex, review);
              }).join("")) +
            '</ol>' +
            '<div class="analysis-section-meta">' +
              '<span>Selected: ' + escapeHtml(review.selectedOption === null || review.selectedOption === undefined ? "Skipped" : String(Number(review.selectedOption) + 1)) + '</span>' +
              '<span>Correct: ' + escapeHtml(String(Number(review.correctOption || 0) + 1)) + '</span>' +
              '<span>Marks: +' + escapeHtml(String(review.marks || 0)) + ' / ' + escapeHtml(String(review.negativeMarks || 0)) + '</span>' +
            '</div>' +
            (review.explanation
              ? '<div class="analysis-explanation"><strong>Explanation</strong><div class="rich-text">' + formatRichText(review.explanation) + '</div></div>'
              : '') +
          '</article>'
        );
      }).join("");
    }

    function sectionBar(sectionKey) {
      var section = sectionScores[sectionKey] || { correct: 0, wrong: 0, skipped: 0, score: 0 };
      var attempted = Number(section.correct || 0) + Number(section.wrong || 0);
      var accuracy = attempted ? Math.round((Number(section.correct || 0) / attempted) * 100) : 0;
      return (
        '<div class="bar-item">' +
          '<div class="bar-head"><span>' + escapeHtml(sectionKey) + '</span><span>' + accuracy + '%</span></div>' +
          '<div class="bar-track"><span data-width="' + accuracy + '%"></span></div>' +
          '<div class="helper-text" style="margin-top: 8px;">Score: ' + escapeHtml(String(section.score || 0)) + ' | Correct: ' + escapeHtml(String(section.correct || 0)) + ' | Wrong: ' + escapeHtml(String(section.wrong || 0)) + ' | Skipped: ' + escapeHtml(String(section.skipped || 0)) + '</div>' +
        '</div>'
      );
    }

    var attemptHistory = store.listUserAttempts(user.id).filter(function (a) {
      return a.testId === attempt.testId && a.status === "submitted" && a.result;
    });

    app.innerHTML = buildShell(
      '<section class="report-layout">' +
        '<div class="report-bar">' +
          '<div class="brand-mark"><span class="brand-dot"></span> AceIIIT</div>' +
          '<div class="button-row">' +
            getThemeToggleMarkup() +
            '<button class="button button-secondary" id="back-dashboard">Dashboard</button>' +
            '<button class="button button-primary" id="retake-test">Retake</button>' +
          '</div>' +
        '</div>' +
        '<div class="report-body">' +
          '<div class="report-heading">' +
            '<p class="section-label">Result</p>' +
            '<h1>' + escapeHtml(test ? test.title : "UGEE Mock Test") + '</h1>' +
            '<p>' + escapeHtml(user.name) + ', your paper was evaluated on the server. Correct answers are not exposed on the client.</p>' +
          '</div>' +
          '<div class="report-grid">' +
            '<div class="report-card">' +
              '<p class="section-label">Performance summary</p>' +
              '<div class="summary-grid">' +
                '<div class="summary-card analysis-stage"' + stageStyle(0) + '><strong><span data-animate-number="' + escapeAttribute(String(result.score || 0)) + '"></span>/' + escapeHtml(String(maxScore)) + '</strong><span>Score</span></div>' +
                '<div class="summary-card analysis-stage"' + stageStyle(1) + '><strong data-animate-number="' + escapeAttribute(String(result.accuracy || 0)) + '" data-suffix="%" data-decimals="2"></strong><span>Accuracy</span></div>' +
                '<div class="summary-card analysis-stage"' + stageStyle(2) + '><strong data-animate-number="' + escapeAttribute(String(result.rank || 0)) + '"></strong><span>Rank</span></div>' +
                '<div class="summary-card analysis-stage"' + stageStyle(3) + '><strong data-animate-number="' + escapeAttribute(String(result.percentile || 0)) + '" data-suffix="%" data-decimals="2"></strong><span>Percentile</span></div>' +
                '<div class="summary-card analysis-stage"' + stageStyle(4) + '><strong data-animate-number="' + escapeAttribute(String(result.correctCount || 0)) + '"></strong><span>Correct</span></div>' +
                '<div class="summary-card analysis-stage"' + stageStyle(5) + '><strong data-animate-number="' + escapeAttribute(String(result.wrongCount || 0)) + '"></strong><span>Wrong</span></div>' +
                '<div class="summary-card analysis-stage"' + stageStyle(6) + '><strong data-animate-number="' + escapeAttribute(String(result.unattemptedCount !== undefined ? result.unattemptedCount : result.skippedCount || 0)) + '"></strong><span>Skipped</span></div>' +
                '<div class="summary-card analysis-stage"' + stageStyle(7) + '><strong>' + formatTime(Number(result.totalTime !== undefined ? result.totalTime : result.timeTakenSeconds || 0)) + '</strong><span>Time taken</span></div>' +
              '</div>' +
              '<div class="divider"></div>' +
              '<p class="section-label">Section performance</p>' +
              '<div class="bar-list" id="section-performance-root">' + sectionBar("SUPR") + sectionBar("REAP") + '</div>' +
              '<div id="analysis-summary-root">' + buildSummaryPanels(analysis) + '</div>' +
            '</div>' +
            '<aside class="report-card">' +
              '<p class="section-label">Attempt history</p>' +
              (attemptHistory.length ? (
                '<div class="attempt-list">' +
                  attemptHistory.slice(0, 10).map(function (a) {
                    return (
                      '<div class="attempt-row">' +
                        '<strong>Attempt ' + escapeHtml(String(a.attemptNumber || "")) + '</strong>' +
                        '<span class="helper-text">Score ' + escapeHtml(String(a.result.score)) + ' | Percentile ' + escapeHtml(String(a.result.percentile || "-")) + ' | ' + escapeHtml(formatDateTime(a.submittedAt)) + '</span>' +
                        '<div class="button-row" style="margin-top: 10px;">' +
                          '<button class="button button-secondary button-compact js-open-result" data-id="' + escapeAttribute(a.id) + '">Open</button>' +
                        '</div>' +
                      '</div>'
                    );
                  }).join("") +
                '</div>'
              ) : '<div class="empty-state">No previous attempts.</div>') +
            '</aside>' +
          '</div>' +
        '</div>' +
      '</section>'
    );

    document.getElementById("back-dashboard").addEventListener("click", function () {
      navigate("dashboard");
    });

    document.getElementById("retake-test").addEventListener("click", function () {
      navigate("instructions/" + attempt.testId);
    });

    app.querySelectorAll(".js-open-result").forEach(function (button) {
      button.addEventListener("click", function () {
        navigate("results/" + button.dataset.id);
      });
    });

    function bindReviewButtons() {
      app.querySelectorAll(".js-open-image-lightbox").forEach(function (button) {
        button.addEventListener("click", function () {
          openImageLightbox(button.getAttribute("data-url") || "");
        });
      });
    }

    function mountQuestionReviewLoader() {
      var loadButton = document.getElementById("load-question-review");
      var moreButton = document.getElementById("load-more-review");
      var listEl = document.getElementById("question-review-list");
      var statusEl = document.getElementById("question-review-status");
      var moreRow = document.getElementById("question-review-more-row");
      if (!loadButton || !listEl || !statusEl || !moreRow) return;
      if (!analysis) {
        listEl.innerHTML = '<div class="empty-state">Full question review is available for attempts submitted after the upgraded analysis system was enabled.</div>';
        moreRow.style.display = "none";
        return;
      }

      var page = 1;
      var limit = 12;
      var loading = false;
      var loadedOnce = false;

      function updateButtons(hasMore) {
        moreRow.style.display = hasMore ? "flex" : "none";
        loadButton.style.display = loadedOnce ? "none" : "inline-flex";
      }

      function loadPage(reset) {
        if (loading) return;
        loading = true;
        statusEl.textContent = "Loading question review…";
        if (reset) {
          page = 1;
          listEl.innerHTML = "";
        }
        store.getAttemptQuestionReview(attempt.id, page, limit)
          .then(function (payload) {
            var items = payload && payload.questions ? payload.questions : [];
            var pagination = payload && payload.pagination ? payload.pagination : { hasMore: false };
            if (!items.length && page === 1) {
              listEl.innerHTML = '<div class="empty-state">Detailed question review is not available for this attempt yet.</div>';
            } else {
              listEl.insertAdjacentHTML("beforeend", buildQuestionReviewItems(items, (page - 1) * limit));
            }
            loadedOnce = true;
            statusEl.textContent = items.length ? "Question review loaded." : "No more question cards.";
            updateButtons(Boolean(pagination.hasMore));
            bindReviewButtons();
            renderLatexInElement(listEl);
            activateAnalysisAnimations(listEl);
            page += 1;
          })
          .catch(function (error) {
            statusEl.textContent = error && error.message ? error.message : "Could not load question review.";
          })
          .finally(function () {
            loading = false;
          });
      }

      loadButton.addEventListener("click", function () {
        loadPage(true);
      });

      if (moreButton) {
        moreButton.addEventListener("click", function () {
          loadPage(false);
        });
      }
    }

    activateAnalysisAnimations(app);
    mountQuestionReviewLoader();

    if (!analysis && !prefetchedSummary && store.getAttemptAnalysis) {
      store.getAttemptAnalysis(attempt.id).then(function (summary) {
        if (!summary) return;
        if (summary.analysis) {
          analysis = summary.analysis;
        }
        var derivedSectionScores = buildSectionScoresFromSummary(summary);
        if (derivedSectionScores) {
          sectionScores = derivedSectionScores;
        }
        analysisHydrating = false;
        result.analysis = analysis || result.analysis || null;
        if (derivedSectionScores) {
          result.sectionScores = derivedSectionScores;
        }
        var sectionRoot = document.getElementById("section-performance-root");
        var summaryRoot = document.getElementById("analysis-summary-root");
        if (sectionRoot) {
          sectionRoot.innerHTML = sectionBar("SUPR") + sectionBar("REAP");
          activateAnalysisAnimations(sectionRoot);
        }
        if (!summaryRoot) return;
        summaryRoot.innerHTML = buildSummaryPanels(analysis);
        activateAnalysisAnimations(summaryRoot);
        mountQuestionReviewLoader();
      }).catch(function () {});
    }

    renderLatexInElement(document.body);
  }

  function renderAdmin(user, preferredTestId) {
    if (!auth.isAdmin(user)) {
      navigate("dashboard");
      return;
    }

    var settings = store.getSettings();
    var questions = store.getQuestions();
    var tests = store.getTests();
    var adminSnapshot = store.getAdminSnapshot();
    var appConfig = (adminSnapshot && adminSnapshot.appConfig) || (store.getAppConfig ? store.getAppConfig() : { ugeeExamDate: null, featuredTestId: "", noticeTitle: "", noticeBody: "" });
    var editingTest = runtime.adminEditingTestId ? store.getTestById(runtime.adminEditingTestId) : null;
    var editingQuestion = runtime.adminEditingQuestionId
      ? questions.find(function (question) { return question.id === runtime.adminEditingQuestionId; }) || null
      : null;
    var questionMarkDefaults = getSectionDefaultMarking(editingQuestion ? editingQuestion.section : "SUPR");
    var pendingUploadedImageUrls = dedupeUrls(runtime.pendingUploadedQuestionImageUrls || []);
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
      ? sortQuestionsForSelectedTest(selectedTest, questions.filter(function (question) {
          return selectedTest.questionIds.indexOf(question.id) !== -1;
        }))
      : [];
    var selectedSuprCount = selectedTestQuestions.filter(function (question) {
      return question.section === "SUPR";
    }).length;
    var selectedReapCount = selectedTestQuestions.filter(function (question) {
      return question.section === "REAP";
    }).length;
    var questionUsage = {};
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
            getThemeToggleMarkup() +
            '<button class="button button-secondary" id="back-dashboard">Dashboard</button>' +
            '<button class="button button-secondary" id="open-users">Users</button>' +
            '<button class="button button-secondary" id="open-results">Results</button>' +
            '<button class="button button-secondary" id="open-leaderboard">Leaderboard</button>' +
            '<button class="button button-secondary" id="open-analytics">Analytics</button>' +
            '<button class="button button-secondary" id="open-trash">Recycle Bin</button>' +
            '<button class="button button-danger" id="download-data">Export data</button>' +
          '</div>' +
        '</div>' +
        '<div class="admin-body">' +
          '<div class="admin-heading">' +
            '<p class="section-label">Builder mode</p>' +
            '<h1>Configure tests and questions.</h1>' +
            '<p>Create the test first, then attach questions directly to that paper.</p>' +
          '</div>' +
          '<div class="admin-grid">' +
            '<div class="admin-card">' +
              '<p class="section-label">Create test</p>' +
              '<form id="test-form">' +
                '<div class="grid-two">' +
                  '<div class="field"><label for="test-title">Title</label><input id="test-title" name="title" value="' + escapeAttribute(editingTest ? editingTest.title : "") + '" required></div>' +
                  '<div class="field"><label for="test-subtitle">Subtitle</label><input id="test-subtitle" name="subtitle" value="' + escapeAttribute(editingTest ? editingTest.subtitle : "") + '" required></div>' +
                  '<div class="field"><label for="test-series">Series</label><input id="test-series" name="series" value="' + escapeAttribute(editingTest ? (editingTest.series || "UGEE 2026") : "UGEE 2026") + '" required></div>' +
                  '<div class="field"><label for="test-access">Access</label><select id="test-access" name="isFree"><option value="true"' + (editingTest && editingTest.isFree ? ' selected' : (!editingTest ? ' selected' : '')) + '>Free</option><option value="false"' + (editingTest && !editingTest.isFree ? ' selected' : '') + '>Paid</option></select></div>' +
                  '<div class="field"><label>Dashboard order</label><div class="helper-text">Use the Up / Down controls in the Existing tests list to decide dashboard order. New tests are added at the bottom by default.</div></div>' +
                  '<div class="field"><label for="test-benchmark">Benchmark scores</label><input id="test-benchmark" name="benchmarkScores" placeholder="18,22,26,31" value="' + escapeAttribute(editingTest && Array.isArray(editingTest.benchmarkScores) ? editingTest.benchmarkScores.join(",") : "") + '"></div>' +
                  '<div class="field"><label for="supr-duration">SUPR duration (minutes)</label><input id="supr-duration" name="suprDurationMinutes" type="number" value="' + (editingTest && editingTest.sectionDurations ? editingTest.sectionDurations.SUPR : 60) + '" required></div>' +
                  '<div class="field"><label for="reap-duration">REAP duration (minutes)</label><input id="reap-duration" name="reapDurationMinutes" type="number" value="' + (editingTest && editingTest.sectionDurations ? editingTest.sectionDurations.REAP : 120) + '" required></div>' +
                '</div>' +
                '<div class="field" style="margin-top: 16px;"><label for="test-instructions">Instructions (one line each)</label><textarea id="test-instructions" name="instructions" rows="4">' + escapeHtml(editingTest ? editingTest.instructions.join("\n") : 'Read all instructions carefully.\nSUPR locks after its timer or after every SUPR question is answered.\nREAP opens automatically and the test submits when the REAP timer ends.') + '</textarea></div>' +
                '<div class="button-row" style="margin-top: 18px;">' +
                  '<button class="button button-primary" type="submit">' + (editingTest ? 'Update test' : 'Create test') + '</button>' +
                  (editingTest ? '<button class="button button-secondary" type="button" id="cancel-test-edit">Cancel Edit</button>' : '') +
                '</div>' +
              '</form>' +
            '</div>' +
            '<aside class="admin-card">' +
              '<p class="section-label">Platform</p>' +
              '<div class="helper-text">Admin access is configured in the backend via <strong>ADMIN_EMAILS</strong>. Paid access is verified server-side via Google Sheets (verified emails list).</div>' +
              '<div class="divider"></div>' +
              '<form id="app-config-form">' +
                '<div class="field"><label for="ugee-exam-date">UGEE exam date</label><input id="ugee-exam-date" name="ugeeExamDate" type="date" value="' + escapeAttribute(toDateInputValue(appConfig && appConfig.ugeeExamDate)) + '"></div>' +
                '<div class="field"><label for="featured-test-id">Coming soon test</label><select id="featured-test-id" name="featuredTestId"><option value="">None</option>' +
                  tests.map(function (test) {
                    return '<option value="' + escapeAttribute(test.id) + '"' + (appConfig && appConfig.featuredTestId === test.id ? ' selected' : '') + '>' + escapeHtml(test.title) + '</option>';
                  }).join("") +
                '</select></div>' +
                '<div class="field"><label for="notice-title">Notice title</label><input id="notice-title" name="noticeTitle" value="' + escapeAttribute((appConfig && appConfig.noticeTitle) || "") + '" placeholder="Important update"></div>' +
                '<div class="field" style="grid-column: 1 / -1;"><label for="notice-body">Notice board message</label><textarea id="notice-body" name="noticeBody" rows="5" placeholder="Add any dashboard notice here. Everyone will see it.">' + escapeHtml((appConfig && appConfig.noticeBody) || "") + '</textarea></div>' +
                '<div class="button-row" style="margin-top: 12px;"><button class="button button-secondary" type="submit">Save platform notices</button></div>' +
              '</form>' +
              '<div class="divider"></div>' +
              '<div class="metric-grid">' +
                '<div class="metric-card"><strong>' + tests.length + '</strong><span>Tests</span></div>' +
                '<div class="metric-card"><strong>' + questions.length + '</strong><span>Questions</span></div>' +
                '<div class="metric-card"><strong>' + tests.reduce(function (sum, test) { return sum + test.questionIds.length; }, 0) + '</strong><span>Attached questions</span></div>' +
                '<div class="metric-card"><strong>' + (adminSnapshot ? Number(adminSnapshot.userCount || (adminSnapshot.users ? adminSnapshot.users.length : 0)) : 0) + '</strong><span>Users</span></div>' +
              '</div>' +
              (selectedTest ? (
                '<div class="divider"></div>' +
                '<p class="section-label">Active paper</p>' +
                '<div class="meta-row">' +
                  '<span class="meta-chip">' + escapeHtml(selectedTest.title) + '</span>' +
                  '<span class="meta-chip">SUPR ' + selectedSuprCount + '</span>' +
                  '<span class="meta-chip">REAP ' + selectedReapCount + '</span>' +
                  '<span class="meta-chip">' + (selectedTest.sectionDurations ? selectedTest.sectionDurations.SUPR : 60) + 'm / ' + (selectedTest.sectionDurations ? selectedTest.sectionDurations.REAP : 120) + 'm</span>' +
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
                  (editingQuestion && getQuestionImageUrls(editingQuestion).length ? (
                    '<div class="field" style="grid-column: 1 / -1;">' +
                      '<label>Existing images</label>' +
                      '<div class="helper-text">' + escapeHtml(getQuestionImageUrls(editingQuestion).length + " image(s) already attached") + '</div>' +
                      '<div class="question-figure-stack">' +
                        getQuestionImageUrls(editingQuestion).slice(0, 4).map(function (url, index) {
                          return '<button type="button" class="question-figure-button" data-open-image="' + escapeAttribute(url) + '"><img class="question-figure" src="' + escapeAttribute(url) + '" alt="Existing image ' + (index + 1) + '"></button>';
                        }).join("") +
                      '</div>' +
                      (getQuestionImageUrls(editingQuestion).length > 4 ? '<div class="helper-text">Showing 4 of ' + escapeHtml(String(getQuestionImageUrls(editingQuestion).length)) + '. Open the image to zoom.</div>' : '') +
                    '</div>'
                  ) : '') +
                  '<div class="field" style="grid-column: 1 / -1;">' +
                    '<label for="question-files">Upload local images</label>' +
                    '<input id="question-files" name="questionFiles" type="file" multiple accept="image/*">' +
                    '<div class="helper-text" id="question-files-status">' + escapeHtml(runtime.pendingQuestionFileNames.length ? runtime.pendingQuestionFileNames.join(", ") : "No image selected") + '</div>' +
                    '<div class="button-row" style="margin-top: 12px;">' +
                      '<button class="button button-secondary" type="button" id="upload-question-images" ' + (runtime.pendingQuestionFiles.length ? "" : "disabled") + '>Upload selected images</button>' +
                    '</div>' +
                    '<div class="helper-text" id="question-uploaded-status" style="margin-top: 10px;">' + escapeHtml(pendingUploadedImageUrls.length ? (pendingUploadedImageUrls.length + " image(s) uploaded to Cloudinary and ready to save") : "Uploaded images will appear here after Cloudinary upload") + '</div>' +
                    '<div id="question-files-preview" class="question-figure-stack" style="margin-top: 12px;">' +
                      (runtime.pendingQuestionFilePreviews.length ? runtime.pendingQuestionFilePreviews.map(function (url, index) {
                        return '<img class="question-figure" src="' + escapeAttribute(url) + '" alt="Selected image ' + (index + 1) + '">';
                      }).join("") : "") +
                    '</div>' +
                    '<div id="question-uploaded-preview" class="question-figure-stack" style="margin-top: 12px;">' +
                      (pendingUploadedImageUrls.length ? pendingUploadedImageUrls.map(function (url, index) {
                        return '<button type="button" class="question-figure-button" data-open-image="' + escapeAttribute(url) + '"><img class="question-figure" src="' + escapeAttribute(url) + '" alt="Uploaded image ' + (index + 1) + '"></button>';
                      }).join("") : "") +
                    '</div>' +
                    '<div class="helper-text">Images upload to Cloudinary and are stored as URLs. Keep them under ~2MB each.</div>' +
                  '</div>' +
                  '<div class="field" style="grid-column: 1 / -1;"><label for="question-drive-links">Google Drive image links</label><textarea id="question-drive-links" name="driveImageLinks" rows="3" placeholder="Paste public Google Drive image share links, one per line">' + escapeHtml(editingQuestion ? getQuestionDriveLinks(editingQuestion).join("\n") : "") + '</textarea><div class="helper-text">Paste public share links from Google Drive and the portal will convert them automatically for display.</div></div>' +
                  '<div class="field" style="grid-column: 1 / -1;"><label for="question-prompt">Question prompt</label><textarea id="question-prompt" name="prompt" rows="4" required>' + escapeHtml(editingQuestion ? editingQuestion.prompt : "") + '</textarea><div class="helper-text">Supports LaTeX: use $...$ for inline, $$...$$ for display math.</div></div>' +
                  '<div class="field" style="grid-column: 1 / -1;"><label for="question-passage">Passage or context</label><textarea id="question-passage" name="passage" rows="4" placeholder="Optional">' + escapeHtml(editingQuestion ? editingQuestion.passage || "" : "") + '</textarea></div>' +
                  '<div class="field"><label for="option-0">Option A</label><input id="option-0" name="option0" value="' + escapeAttribute(editingQuestion ? editingQuestion.options[0] : "") + '" required></div>' +
                  '<div class="field"><label for="option-1">Option B</label><input id="option-1" name="option1" value="' + escapeAttribute(editingQuestion ? editingQuestion.options[1] : "") + '" required></div>' +
                  '<div class="field"><label for="option-2">Option C</label><input id="option-2" name="option2" value="' + escapeAttribute(editingQuestion ? editingQuestion.options[2] : "") + '" required></div>' +
                  '<div class="field"><label for="option-3">Option D</label><input id="option-3" name="option3" value="' + escapeAttribute(editingQuestion ? editingQuestion.options[3] : "") + '" required></div>' +
                  '<div class="field"><label for="correct-option">Correct option</label><select id="correct-option" name="correctOption"><option value="0" ' + (editingQuestion && Number(editingQuestion.correctOption) === 0 ? 'selected' : '') + '>A</option><option value="1" ' + (editingQuestion && Number(editingQuestion.correctOption) === 1 ? 'selected' : '') + '>B</option><option value="2" ' + (editingQuestion && Number(editingQuestion.correctOption) === 2 ? 'selected' : '') + '>C</option><option value="3" ' + (editingQuestion && Number(editingQuestion.correctOption) === 3 ? 'selected' : '') + '>D</option></select></div>' +
                  '<div class="field"><label for="question-marks">Marks</label><input id="question-marks" name="marks" type="number" step="any" value="' + (editingQuestion ? editingQuestion.marks : questionMarkDefaults.marks) + '"></div>' +
                  '<div class="field"><label for="question-negative">Negative marks</label><input id="question-negative" name="negativeMarks" type="number" step="any" value="' + (editingQuestion ? Math.abs(editingQuestion.negativeMarks) : questionMarkDefaults.negativeMarks) + '"></div>' +
                  '<div class="field" style="grid-column: 1 / -1;"><label for="question-explanation">Solution</label><textarea id="question-explanation" name="explanation" rows="4" required>' + escapeHtml(editingQuestion ? editingQuestion.explanation : "") + '</textarea><div class="helper-text">Supports LaTeX: use $...$ for inline, $$...$$ for display math.</div></div>' +
                  '<div class="field" style="grid-column: 1 / -1;">' +
                    '<div class="latex-preview-toolbar">' +
                      '<div>' +
                        '<p class="section-label" style="margin:0;">Live LaTeX preview</p>' +
                        '<div class="helper-text">Renders $...$ (inline) and $$...$$ (display) after you type.</div>' +
                      '</div>' +
                      '<div class="button-row">' +
                        '<button type="button" class="button button-secondary button-compact" id="latex-preview-toggle">' + (runtime.adminLatexPreviewVisible ? "Hide preview" : "Show preview") + '</button>' +
                        '<button type="button" class="button button-secondary button-compact" id="latex-preview-full">Full screen</button>' +
                      '</div>' +
                    '</div>' +
                    '<div id="latex-preview-inline" class="latex-preview" style="display:' + (runtime.adminLatexPreviewVisible ? "block" : "none") + ';"></div>' +
                  '</div>' +
                  '<div class="button-row" style="grid-column: 1 / -1;"><button class="button button-primary" type="submit">' + (editingQuestion ? 'Update question' : 'Add question') + '</button>' + (editingQuestion ? '<button class="button button-secondary" type="button" id="cancel-question-edit">Cancel Edit</button>' : '') + '</div>' +
                '</form>'
              ) : '<div class="empty-state">Create a test first. As soon as a paper exists, you can add questions directly into it here.</div>') +
              (selectedTest ? (
                '<div class="divider"></div>' +
                '<p class="section-label">Questions In Selected Test</p>' +
                (selectedTestQuestions.length ? (
                  '<div class="question-bank compact-bank">' +
                    selectedTestQuestions.map(function (question, index) {
                      return '<div class="bank-item"><strong>Q' + (index + 1) + ' | ' + escapeHtml(question.id) + ' | ' + escapeHtml(question.section) + '</strong><span>' + formatRichText(question.prompt) + '</span><span class="helper-text">' + escapeHtml(question.topic) + ' | ' + escapeHtml(question.difficulty) + '</span><div class="button-row"><button class="button button-secondary button-compact js-edit-question-inline" data-id="' + escapeAttribute(question.id) + '">Edit Question</button><button class="button button-secondary button-compact js-detach-question" data-id="' + escapeAttribute(question.id) + '">Remove From Test</button></div></div>';
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
              '<div class="button-row" style="justify-content: space-between; align-items: center; margin-bottom: 10px;">' +
                '<p class="section-label" style="margin:0;">Existing tests</p>' +
                '<button class="button button-secondary button-compact" type="button" id="open-tests-modal">Full screen</button>' +
              '</div>' +
              (tests.length ? (
                '<div class="table-like tests-table">' +
                  '<div class="table-row header"><span>Test</span><span>Dashboard</span><span>Questions</span><span>SUPR / REAP</span><span>ID</span><span>Action</span></div>' +
                  tests.map(function (test, index) {
                    var moveUpDisabled = index === 0 ? ' disabled' : '';
                    var moveDownDisabled = index === tests.length - 1 ? ' disabled' : '';
                    return '<div class="table-row"><span class="' + (test.status === "live" ? 'test-title-live' : '') + '">' + escapeHtml(test.title) + '<br><small>' + escapeHtml(test.status || "draft") + '</small></span><span><div class="button-row"><button class="button button-secondary button-compact js-move-test-up" data-id="' + escapeHtml(test.id) + '"' + moveUpDisabled + '>Up</button><button class="button button-secondary button-compact js-move-test-down" data-id="' + escapeHtml(test.id) + '"' + moveDownDisabled + '>Down</button></div></span><span>' + test.questionIds.length + '</span><span>' + test.sectionDurations.SUPR + ' / ' + test.sectionDurations.REAP + ' min</span><span>' + escapeHtml(test.id) + '</span><span><div class="button-row"><button class="button button-secondary js-pick-test" data-id="' + escapeHtml(test.id) + '">' + (test.id === selectedTestId ? 'Using' : 'Use') + '</button><button class="button button-secondary js-edit-test" data-id="' + escapeHtml(test.id) + '">Edit</button><button class="button button-secondary js-toggle-live" data-id="' + escapeHtml(test.id) + '">' + (test.status === "live" ? 'Unlive' : 'Make Live') + '</button><button class="button button-secondary js-export-pdf" data-id="' + escapeHtml(test.id) + '">PDF</button><button class="button button-danger js-delete-test" data-id="' + escapeHtml(test.id) + '">Delete</button></div></span></div>';
                  }).join("") +
                '</div>'
              ) : '<div class="empty-state">No tests created yet.</div>') +
              '<div class="divider"></div>' +
              '<div class="button-row" style="justify-content: space-between; align-items: center; margin-bottom: 10px;">' +
                '<p class="section-label" style="margin:0;">Question bank</p>' +
                '<button class="button button-secondary button-compact" type="button" id="open-bank-modal">Full screen</button>' +
              '</div>' +
              (questions.length ? (
                '<div class="question-bank">' +
                  questions.slice(0, 14).map(function (question) {
                    var attachedTo = questionUsage[question.id] || [];
                    return (
                      '<div class="bank-item">' +
                        '<strong>' + escapeHtml(question.id) + ' | ' + escapeHtml(question.section) + ' | ' + escapeHtml(question.topic) + '</strong>' +
                        '<span>' + formatRichText(question.prompt) + '</span>' +
                        '<span class="helper-text">' + (attachedTo.length ? 'Attached to: ' + escapeHtml(attachedTo.join(", ")) : 'Not attached') + '</span>' +
                        '<div class="button-row"><button class="button button-secondary button-compact js-edit-question" data-id="' + escapeAttribute(question.id) + '">Edit</button><button class="button button-secondary button-compact js-detach-question" data-id="' + escapeAttribute(question.id) + '">Remove From Selected</button><button class="button button-danger button-compact js-delete-question" data-id="' + escapeAttribute(question.id) + '">Delete</button></div>' +
                      '</div>'
                    );
                  }).join("") +
                '</div>' +
                (questions.length > 14 ? '<div class="helper-text" style="margin-top: 10px;">Showing 14 of ' + questions.length + '. Open full screen to view everything.</div>' : '')
              ) : '<div class="empty-state">No questions created yet.</div>') +
            '</aside>' +
          '</div>' +
        '</div>' +
        '<div class="app-footer app-footer-inline">AceIIIT MockTest Portal</div>' +
      '</section>'
    , { fluid: true, hideFooter: true });
    renderLatexInElement(document.body);

    var testForm = document.getElementById("test-form");
    var questionForm = document.getElementById("question-form");
    var testDraftContext = runtime.adminEditingTestId ? ("edit:" + runtime.adminEditingTestId) : "create";
    var questionDraftContext = (runtime.adminEditingQuestionId ? ("edit:" + runtime.adminEditingQuestionId) : "create") + "|test:" + (selectedTestId || "");

    if (runtime.questionUploadContext && runtime.questionUploadContext !== questionDraftContext) {
      resetPendingQuestionUploads();
    }
    if (!runtime.questionUploadContext) {
      runtime.questionUploadContext = questionDraftContext;
    }

    restoreDraft(testForm, ADMIN_TEST_DRAFT_KEY, testDraftContext);
    restoreDraft(questionForm, ADMIN_QUESTION_DRAFT_KEY, questionDraftContext);

    bindDraftAutosave(testForm, ADMIN_TEST_DRAFT_KEY, function () { return testDraftContext; });
    bindDraftAutosave(questionForm, ADMIN_QUESTION_DRAFT_KEY, function () { return questionDraftContext; });

    document.getElementById("back-dashboard").addEventListener("click", function () {
      navigate("dashboard");
    });
    var appConfigForm = document.getElementById("app-config-form");
    if (appConfigForm) {
      appConfigForm.addEventListener("submit", async function (event) {
        event.preventDefault();
        var form = new FormData(appConfigForm);
        var rawDate = String(form.get("ugeeExamDate") || "").trim();
        var featuredTestId = String(form.get("featuredTestId") || "").trim();
        var noticeTitle = String(form.get("noticeTitle") || "").trim();
        var noticeBody = String(form.get("noticeBody") || "").trim();
        showOverlayLoader("Saving platform notice.");
        try {
          await store.updateAppConfig({
            ugeeExamDate: rawDate ? new Date(rawDate + "T00:00:00").toISOString() : null,
            featuredTestId: featuredTestId || null,
            noticeTitle: noticeTitle,
            noticeBody: noticeBody,
          });
          await store.refreshFromRemote();
          rerenderAdminPreserveScroll(user, selectedTestId);
        } finally {
          hideOverlayLoader();
        }
      });
    }

    var openUsersButton = document.getElementById("open-users");
    if (openUsersButton) {
      openUsersButton.addEventListener("click", function () {
        var users = (adminSnapshot && adminSnapshot.users) ? adminSnapshot.users.slice() : [];
        var rows = users.map(function (item) {
          var canDelete = item.role !== "admin";
          return (
            '<div class="table-row">' +
              '<span><strong>' + escapeHtml(item.name || "Student") + '</strong><br><small>' + escapeHtml(item.email || "") + '</small></span>' +
              '<span>' + escapeHtml(item.role || "student") + '</span>' +
              '<span>' + (item.isPaid ? "Paid" : "Free") + '</span>' +
              '<span><small>' + escapeHtml(formatDateTime(item.createdAt)) + '</small>' +
                (canDelete ? '<br><button class="button button-danger button-compact" type="button" data-delete-user="' + escapeAttribute(item.id) + '">Delete</button>' : '') +
              '</span>' +
            '</div>'
          );
        }).join("");

        var html =
          '<div class="table-like">' +
            '<div class="table-row header"><span>User</span><span>Role</span><span>Access</span><span>Created</span></div>' +
            (rows || '<div class="empty-state">No users yet.</div>') +
          '</div>';

        var overlay = showAdminModal("Users", html, true);
        if (overlay) {
          overlay.querySelectorAll("[data-delete-user]").forEach(function (button) {
            button.addEventListener("click", async function () {
              var id = button.getAttribute("data-delete-user");
              if (!id) return;
              if (!window.confirm("Move this user to recycle bin? They will not be able to log in.")) return;
              showOverlayLoader("Deleting user.");
              try {
                await store.deleteUser(id);
                hideAdminModal();
                rerenderAdminPreserveScroll(user, selectedTestId);
              } catch (error) {
                window.alert(error && error.message ? error.message : "Could not delete user.");
              } finally {
                hideOverlayLoader();
              }
            });
          });
        }
      });
    }

    var openResultsButton = document.getElementById("open-results");
    if (openResultsButton) {
      openResultsButton.addEventListener("click", async function () {
        showOverlayLoader("Loading results.");
        try {
          var payload = await store.getAdminResults();
          var results = payload && payload.results ? payload.results : [];
          var rows = results.map(function (item) {
            return (
              '<div class="table-row">' +
                '<span><strong>' + escapeHtml((item.test && item.test.title) || "") + '</strong><br><small>' + escapeHtml((item.user && item.user.email) || "") + '</small></span>' +
                '<span>' + escapeHtml(String(item.score)) + '</span>' +
                '<span>' + escapeHtml(String(item.percentile)) + '</span>' +
                '<span>' + escapeHtml(String(item.attemptNumber || 1)) + '</span>' +
                '<span><small>' + escapeHtml(formatDateTime(item.submittedAt)) + '</small></span>' +
                '<span><button class="button button-secondary button-compact" type="button" data-open-report="' + escapeAttribute(item.id) + '">Open</button></span>' +
              '</div>'
            );
          }).join("");

          var html =
            '<div class="table-like">' +
              '<div class="table-row header"><span>Test / Student</span><span>Score</span><span>Percentile</span><span>Attempt</span><span>Submitted</span><span></span></div>' +
              (rows || '<div class="empty-state">No submissions yet.</div>') +
            '</div>';

          var overlay = showAdminModal("Results", html, true);
          if (overlay) {
            overlay.querySelectorAll("[data-open-report]").forEach(function (button) {
              button.addEventListener("click", function () {
                var id = button.getAttribute("data-open-report");
                hideAdminModal();
                navigate("results/" + id);
              });
            });
          }
        } catch (error) {
          window.alert(error && error.message ? error.message : "Could not load results.");
        } finally {
          hideOverlayLoader();
        }
      });
    }

    var openLeaderboardButton = document.getElementById("open-leaderboard");
    if (openLeaderboardButton) {
      openLeaderboardButton.addEventListener("click", function () {
        var defaultTestId = runtime.adminLeaderboardTestId || selectedTestId || (tests[0] ? tests[0].id : "");
        runtime.adminLeaderboardTestId = defaultTestId;

        var options = tests.map(function (t) {
          return '<option value="' + escapeAttribute(t.id) + '"' + (t.id === defaultTestId ? " selected" : "") + '>' + escapeHtml(t.title) + '</option>';
        }).join("");

        var html =
          '<div class="grid-two">' +
            '<div class="field" style="grid-column: 1 / -1;"><label for="leaderboard-test">Select test</label><select id="leaderboard-test">' + options + '</select></div>' +
            '<div class="button-row" style="grid-column: 1 / -1; justify-content: space-between; align-items:center;">' +
              '<span class="helper-text">Shows first-attempt (Attempt 1) leaderboard.</span>' +
              '<button class="button button-secondary button-compact" type="button" id="export-leaderboard-pdf">Export PDF</button>' +
            '</div>' +
          '</div>' +
          '<div class="divider"></div>' +
          '<div id="leaderboard-container"><div class="empty-state">Loading leaderboard…</div></div>';

        var overlay = showAdminModal("Leaderboard", html, true);
        if (!overlay) return;

        function renderTable(entries) {
          var rows = (entries || []).map(function (entry) {
            var user = entry.user || {};
            return (
              '<div class="table-row">' +
                '<span>#' + escapeHtml(String(entry.rank || "")) + '</span>' +
                '<span><strong>' + escapeHtml(user.name || "-") + '</strong><br><small>' + escapeHtml(user.email || "") + '</small></span>' +
                '<span>' + escapeHtml(String(entry.score)) + '</span>' +
                '<span>' + escapeHtml(String(Math.round((entry.timeTakenSeconds || 0) / 60))) + ' min</span>' +
                '<span><small>' + escapeHtml(formatDateTime(entry.submittedAt)) + '</small></span>' +
              '</div>'
            );
          }).join("");

          return (
            '<div class="table-like">' +
              '<div class="table-row header"><span>Rank</span><span>Student</span><span>Score</span><span>Time</span><span>Submitted</span></div>' +
              (rows || '<div class="empty-state">No submissions yet.</div>') +
            '</div>'
          );
        }

        async function loadLeaderboard(testId) {
          var container = overlay.querySelector("#leaderboard-container");
          if (container) {
            container.innerHTML = '<div class="empty-state">Loading leaderboard…</div>';
          }
          try {
            var payload = await store.getAdminLeaderboard(testId);
            var entries = payload && payload.leaderboard ? payload.leaderboard : [];
            if (container) {
              container.innerHTML = renderTable(entries);
            }
            overlay.__leaderboardEntries = entries;
          } catch (error) {
            if (container) {
              container.innerHTML = '<div class="empty-state">Could not load leaderboard.</div>';
            }
          }
        }

        var select = overlay.querySelector("#leaderboard-test");
        if (select) {
          select.addEventListener("change", function () {
            runtime.adminLeaderboardTestId = select.value;
            loadLeaderboard(select.value);
          });
        }

        var exportBtn = overlay.querySelector("#export-leaderboard-pdf");
        if (exportBtn) {
          exportBtn.addEventListener("click", function () {
            var testId = (select && select.value) || defaultTestId;
            var test = tests.find(function (t) { return t.id === testId; }) || null;
            var entries = overlay.__leaderboardEntries || [];
            var exportWindow = window.open("", "_blank");
            if (!exportWindow) return;

            exportWindow.document.write(
              '<html><head><title>Leaderboard - ' + escapeHtml(test ? test.title : testId) + '</title></head><body style="font-family: Arial, sans-serif; padding: 32px; color: #15110f;">' +
                '<h1 style="margin-bottom: 8px;">' + escapeHtml(test ? test.title : testId) + '</h1>' +
                '<p style="margin-top: 0; color: #5d554d;">AceIIIT first-attempt leaderboard export</p>' +
                (entries.length ? (
                  '<table style="width: 100%; border-collapse: collapse; margin-top: 20px;">' +
                    '<thead><tr>' +
                      '<th style="text-align:left; border-bottom:1px solid #ccc; padding: 10px 8px;">Rank</th>' +
                      '<th style="text-align:left; border-bottom:1px solid #ccc; padding: 10px 8px;">Name</th>' +
                      '<th style="text-align:left; border-bottom:1px solid #ccc; padding: 10px 8px;">Email</th>' +
                      '<th style="text-align:left; border-bottom:1px solid #ccc; padding: 10px 8px;">Score</th>' +
                      '<th style="text-align:left; border-bottom:1px solid #ccc; padding: 10px 8px;">Time (min)</th>' +
                      '<th style="text-align:left; border-bottom:1px solid #ccc; padding: 10px 8px;">Submitted</th>' +
                    '</tr></thead>' +
                    '<tbody>' +
                      entries.map(function (entry) {
                        var u = entry.user || {};
                        return '<tr>' +
                          '<td style="border-bottom:1px solid #eee; padding: 10px 8px;">#' + escapeHtml(String(entry.rank || "")) + '</td>' +
                          '<td style="border-bottom:1px solid #eee; padding: 10px 8px;">' + escapeHtml(u.name || "-") + '</td>' +
                          '<td style="border-bottom:1px solid #eee; padding: 10px 8px;">' + escapeHtml(u.email || "-") + '</td>' +
                          '<td style="border-bottom:1px solid #eee; padding: 10px 8px;">' + escapeHtml(String(entry.score)) + '</td>' +
                          '<td style="border-bottom:1px solid #eee; padding: 10px 8px;">' + escapeHtml(String(Math.round((entry.timeTakenSeconds || 0) / 60))) + '</td>' +
                          '<td style="border-bottom:1px solid #eee; padding: 10px 8px;">' + escapeHtml(formatDateTime(entry.submittedAt)) + '</td>' +
                        '</tr>';
                      }).join("") +
                    '</tbody>' +
                  '</table>'
                ) : '<p>No submissions yet for this test.</p>') +
              '</body></html>'
            );
            exportWindow.document.close();
            exportWindow.focus();
            exportWindow.print();
          });
        }

        if (defaultTestId) {
          loadLeaderboard(defaultTestId);
        }
      });
    }

    var openAnalyticsButton = document.getElementById("open-analytics");
    if (openAnalyticsButton) {
      openAnalyticsButton.addEventListener("click", function () {
        var defaultTestId = runtime.adminAnalyticsTestId || selectedTestId || (tests[0] ? tests[0].id : "");
        runtime.adminAnalyticsTestId = defaultTestId;

        var options = tests.map(function (t) {
          return '<option value="' + escapeAttribute(t.id) + '"' + (t.id === defaultTestId ? " selected" : "") + '>' + escapeHtml(t.title) + '</option>';
        }).join("");

        var html =
          '<div class="grid-two">' +
            '<div class="field" style="grid-column: 1 / -1;"><label for="analytics-test">Select test</label><select id="analytics-test">' + options + '</select></div>' +
          '</div>' +
          '<div class="divider"></div>' +
          '<div id="analytics-container"><div class="empty-state">Loading analytics…</div></div>';

        var overlay = showAdminModal("Analytics", html, true);
        if (!overlay) return;

        function renderAnalyticsCard(analytics) {
          var a = analytics || { count: 0, avgScore: 0, avgAccuracy: 0, maxScore: 0 };
          var avgScore = Number.isFinite(Number(a.avgScore)) ? Number(a.avgScore).toFixed(2) : "0.00";
          var avgAcc = Number.isFinite(Number(a.avgAccuracy)) ? Number(a.avgAccuracy).toFixed(1) : "0.0";
          var maxScore = Number.isFinite(Number(a.maxScore)) ? Number(a.maxScore) : 0;
          var count = Number.isFinite(Number(a.count)) ? Number(a.count) : 0;
          return (
            '<div class="metric-grid" style="margin-top: 6px;">' +
              '<div class="metric-card"><strong>' + escapeHtml(String(count)) + '</strong><span>Attempts</span></div>' +
              '<div class="metric-card"><strong>' + escapeHtml(String(maxScore)) + '</strong><span>Top score</span></div>' +
              '<div class="metric-card"><strong>' + escapeHtml(String(avgScore)) + '</strong><span>Avg score</span></div>' +
              '<div class="metric-card"><strong>' + escapeHtml(String(avgAcc)) + '%</strong><span>Avg accuracy</span></div>' +
            '</div>'
          );
        }

        async function loadAnalytics(testId) {
          var container = overlay.querySelector("#analytics-container");
          if (container) {
            container.innerHTML = '<div class="empty-state">Loading analytics…</div>';
          }
          try {
            var payload = await store.getAdminTestAnalytics(testId);
            var analytics = (payload && payload.analytics) ? payload.analytics : { count: 0, avgScore: 0, avgAccuracy: 0, maxScore: 0 };
            if (container) {
              container.innerHTML =
                '<p class="helper-text">This is an aggregate across all attempts for this test.</p>' +
                renderAnalyticsCard(analytics);
            }
          } catch (error) {
            if (container) {
              container.innerHTML = '<div class="empty-state">Could not load analytics.</div>';
            }
          }
        }

        var select = overlay.querySelector("#analytics-test");
        if (select) {
          select.addEventListener("change", function () {
            runtime.adminAnalyticsTestId = select.value;
            loadAnalytics(select.value);
          });
        }

        if (defaultTestId) {
          loadAnalytics(defaultTestId);
        }
      });
    }

    var openTrashButton = document.getElementById("open-trash");
    if (openTrashButton) {
      openTrashButton.addEventListener("click", async function () {
        showOverlayLoader("Loading recycle bin.");
        try {
          var payload = await store.getAdminTrash();
          var trashedTests = (payload && payload.tests) ? payload.tests : [];
          var trashedQuestions = (payload && payload.questions) ? payload.questions : [];
          var trashedUsers = (payload && payload.users) ? payload.users : [];

          function renderTrashList(kind, items, query) {
            var needle = String(query || "").trim().toLowerCase();
            var list = (needle ? items.filter(function (item) {
              var hay = JSON.stringify(item || {}).toLowerCase();
              return hay.indexOf(needle) !== -1;
            }) : items).slice(0, 300);

            if (!list.length) {
              return '<div class="empty-state">No matching items.</div>';
            }

            if (kind === "tests") {
              return (
                '<div class="table-like">' +
                  '<div class="table-row header"><span>Test</span><span>Access</span><span>Deleted</span><span></span></div>' +
                  list.map(function (t) {
                    return (
                      '<div class="table-row">' +
                        '<span><strong>' + highlightMatch(t.title, needle) + '</strong><br><small>' + escapeHtml(t.series || "") + '</small></span>' +
                        '<span>' + (t.isFree ? "Free" : "Paid") + '</span>' +
                        '<span><small>' + escapeHtml(formatDateTime(t.deletedAt)) + '</small></span>' +
                        '<span class="button-row">' +
                          '<button class="button button-secondary button-compact" type="button" data-trash-restore="tests:' + escapeAttribute(t.id) + '">Restore</button>' +
                          '<button class="button button-danger button-compact" type="button" data-trash-purge="tests:' + escapeAttribute(t.id) + '">Delete Now</button>' +
                        '</span>' +
                      '</div>'
                    );
                  }).join("") +
                '</div>'
              );
            }

            if (kind === "questions") {
              return (
                '<div class="table-like">' +
                  '<div class="table-row header"><span>Question</span><span>Section</span><span>Deleted</span><span></span></div>' +
                  list.map(function (q) {
                    return (
                      '<div class="table-row">' +
                        '<span><strong>' + highlightMatch(q.topic || "Question", needle) + '</strong><br><small>' + highlightMatch(q.prompt || "", needle) + '</small></span>' +
                        '<span>' + escapeHtml(q.section || "") + '</span>' +
                        '<span><small>' + escapeHtml(formatDateTime(q.deletedAt)) + '</small></span>' +
                        '<span class="button-row">' +
                          '<button class="button button-secondary button-compact" type="button" data-trash-restore="questions:' + escapeAttribute(q.id) + '">Restore</button>' +
                          '<button class="button button-danger button-compact" type="button" data-trash-purge="questions:' + escapeAttribute(q.id) + '">Delete Now</button>' +
                        '</span>' +
                      '</div>'
                    );
                  }).join("") +
                '</div>'
              );
            }

            return (
              '<div class="table-like">' +
                '<div class="table-row header"><span>User</span><span>Access</span><span>Deleted</span><span></span></div>' +
                list.map(function (u) {
                  return (
                    '<div class="table-row">' +
                      '<span><strong>' + highlightMatch(u.name || "Student", needle) + '</strong><br><small>' + highlightMatch(u.email || "", needle) + '</small></span>' +
                      '<span>' + (u.isPaid ? "Paid" : "Free") + '</span>' +
                      '<span><small>' + escapeHtml(formatDateTime(u.deletedAt)) + '</small></span>' +
                      '<span class="button-row">' +
                        '<button class="button button-secondary button-compact" type="button" data-trash-restore="users:' + escapeAttribute(u.id) + '">Restore</button>' +
                        '<button class="button button-danger button-compact" type="button" data-trash-purge="users:' + escapeAttribute(u.id) + '">Delete Now</button>' +
                      '</span>' +
                    '</div>'
                  );
                }).join("") +
              '</div>'
            );
          }

          var html =
            '<div class="grid-two">' +
              '<div class="field" style="grid-column: 1 / -1;"><label for="trash-search">Search</label><input id="trash-search" placeholder="Search in recycle bin"></div>' +
              '<div class="field"><label for="trash-kind">Type</label>' +
                '<select id="trash-kind">' +
                  '<option value="tests">Tests (' + trashedTests.length + ')</option>' +
                  '<option value="questions">Questions (' + trashedQuestions.length + ')</option>' +
                  '<option value="users">Users (' + trashedUsers.length + ')</option>' +
                '</select>' +
              '</div>' +
              '<div class="field" style="align-self:end;"><div class="helper-text">Items auto-delete after 30 days.</div></div>' +
            '</div>' +
            '<div class="divider"></div>' +
            '<div id="trash-list"></div>';

          var overlay = showAdminModal("Recycle bin", html, true);
          if (!overlay) return;

          function rerenderTrash() {
            var kind = overlay.querySelector("#trash-kind").value;
            var query = overlay.querySelector("#trash-search").value;
            var items = kind === "tests" ? trashedTests : kind === "questions" ? trashedQuestions : trashedUsers;
            var list = overlay.querySelector("#trash-list");
            if (list) {
              list.innerHTML = renderTrashList(kind, items, query);
              list.querySelectorAll("[data-trash-restore]").forEach(function (btn) {
                btn.addEventListener("click", async function () {
                  var parts = String(btn.getAttribute("data-trash-restore") || "").split(":");
                  if (parts.length !== 2) return;
                  showOverlayLoader("Restoring item.");
                  try {
                    await store.restoreTrash(parts[0], parts[1]);
                    hideAdminModal();
                    rerenderAdminPreserveScroll(user, selectedTestId);
                  } catch (error) {
                    window.alert(error && error.message ? error.message : "Could not restore.");
                  } finally {
                    hideOverlayLoader();
                  }
                });
              });
              list.querySelectorAll("[data-trash-purge]").forEach(function (btn) {
                btn.addEventListener("click", async function () {
                  var parts = String(btn.getAttribute("data-trash-purge") || "").split(":");
                  if (parts.length !== 2) return;
                  if (!window.confirm("Permanently delete this item now?")) return;
                  showOverlayLoader("Deleting item.");
                  try {
                    await store.purgeTrash(parts[0], parts[1]);
                    hideAdminModal();
                    rerenderAdminPreserveScroll(user, selectedTestId);
                  } catch (error) {
                    window.alert(error && error.message ? error.message : "Could not delete.");
                  } finally {
                    hideOverlayLoader();
                  }
                });
              });
            }
          }

          overlay.querySelector("#trash-kind").addEventListener("change", rerenderTrash);
          overlay.querySelector("#trash-search").addEventListener("input", rerenderTrash);
          rerenderTrash();
        } catch (error) {
          window.alert(error && error.message ? error.message : "Could not load recycle bin.");
        } finally {
          hideOverlayLoader();
        }
      });
    }

    var openTestsModal = document.getElementById("open-tests-modal");
    if (openTestsModal) {
      openTestsModal.addEventListener("click", function () {
        var rows = tests.map(function (test) {
          var label = test.status === "live" ? "live" : "draft";
          var access = test.isFree ? "Free" : "Paid";
          return (
            '<div class="table-row">' +
              '<span><strong>' + escapeHtml(test.title) + '</strong><br><small>' + escapeHtml(access + " • " + label) + '</small></span>' +
              '<span>' + escapeHtml(String(test.questionIds.length)) + '</span>' +
              '<span>' + escapeHtml(String(test.sectionDurations.SUPR)) + ' / ' + escapeHtml(String(test.sectionDurations.REAP)) + ' min</span>' +
              '<span><code style="font-size: 12px;">' + escapeHtml(test.id) + '</code></span>' +
              '<span><button class="button button-secondary button-compact" type="button" data-use-test="' + escapeAttribute(test.id) + '">Use</button></span>' +
            '</div>'
          );
        }).join("");

        var html =
          '<div class="table-like">' +
            '<div class="table-row header"><span>Test</span><span>Questions</span><span>SUPR / REAP</span><span>ID</span><span></span></div>' +
            (rows || '<div class="empty-state">No tests yet.</div>') +
          '</div>';

        var overlay = showAdminModal("All tests", html, true);
        if (overlay) {
          overlay.querySelectorAll("[data-use-test]").forEach(function (button) {
            button.addEventListener("click", function () {
              var id = button.getAttribute("data-use-test");
              hideAdminModal();
              runtime.adminSelectedTestId = id;
              rerenderAdminPreserveScroll(user, id);
            });
          });
        }
      });
    }

    var openBankModal = document.getElementById("open-bank-modal");
    if (openBankModal) {
      openBankModal.addEventListener("click", function () {
        var html =
          '<div class="field" style="margin-bottom: 14px;"><label for="bank-modal-search">Search</label><input id="bank-modal-search" placeholder="Search by id, topic, prompt"></div>' +
          '<div id="bank-modal-list" class="question-bank"></div>';

        var overlay = showAdminModal("Question bank", html, true);
        if (!overlay) return;

        function renderList(query) {
          var needle = String(query || "").trim().toLowerCase();
          var list = (needle ? questions.filter(function (q) {
            var hay = (q.id + " " + q.topic + " " + q.prompt).toLowerCase();
            return hay.indexOf(needle) !== -1;
          }) : questions).slice(0, 300);

          var items = list.map(function (q) {
            return (
              '<div class="bank-item">' +
                '<strong>' + highlightMatch(q.id, needle) + ' | ' + escapeHtml(q.section) + ' | ' + highlightMatch(q.topic, needle) + '</strong>' +
                '<span>' + highlightMatch(q.prompt, needle) + '</span>' +
                '<div class="button-row">' +
                  '<button class="button button-secondary button-compact" type="button" data-edit-q="' + escapeAttribute(q.id) + '">Edit</button>' +
                '</div>' +
              '</div>'
            );
          }).join("");

          var container = overlay.querySelector("#bank-modal-list");
          if (container) {
            container.innerHTML = items || '<div class="empty-state">No matching question.</div>';
            container.querySelectorAll("[data-edit-q]").forEach(function (button) {
              button.addEventListener("click", function () {
                var id = button.getAttribute("data-edit-q");
                hideAdminModal();
                runtime.adminEditingQuestionId = id;
                rerenderAdminPreserveScroll(user, selectedTestId);
              });
            });
          }
        }

        renderList("");
        var input = overlay.querySelector("#bank-modal-search");
        if (input) {
          input.addEventListener("input", function () {
            renderList(input.value);
          });
        }
      });
    }

    document.getElementById("test-form").addEventListener("submit", async function (event) {
      event.preventDefault();
      var form = new FormData(event.currentTarget);
      var nextDefaultDisplayOrder = tests.length
        ? tests.reduce(function (max, test) {
            return Math.max(max, Number(test.displayOrder || 0));
          }, 0) + 10
        : 10;
      var payload = {
        title: form.get("title"),
        subtitle: form.get("subtitle"),
        series: form.get("series"),
        isFree: form.get("isFree"),
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
      if (!runtime.adminEditingTestId) {
        payload.displayOrder = nextDefaultDisplayOrder;
      }
      showOverlayLoader("Saving test.");
      try {
        var savedTest = runtime.adminEditingTestId
          ? await store.updateTest(runtime.adminEditingTestId, payload)
          : await store.createTest(payload);
        runtime.adminEditingTestId = null;
        runtime.adminSelectedTestId = savedTest ? savedTest.id : runtime.adminSelectedTestId;
        clearLocalDraft(ADMIN_TEST_DRAFT_KEY);
        rerenderAdminPreserveScroll(user, savedTest ? savedTest.id : selectedTestId);
      } catch (error) {
        window.alert(error && error.message ? error.message : "Test could not be saved.");
      } finally {
        hideOverlayLoader();
      }
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
      var previewInline = document.getElementById("latex-preview-inline");
      var previewToggle = document.getElementById("latex-preview-toggle");
      var previewFull = document.getElementById("latex-preview-full");
      var previewTimer = 0;

      function paintInlinePreview() {
        if (!previewInline) return;
        previewInline.innerHTML = buildLatexPreviewHtml(questionForm);
        renderLatexInElement(previewInline);
      }

      function schedulePreviewPaint() {
        if (!runtime.adminLatexPreviewVisible) return;
        if (!previewInline) return;
        if (previewTimer) {
          window.clearTimeout(previewTimer);
        }
        previewTimer = window.setTimeout(function () {
          paintInlinePreview();
        }, 120);
      }

      if (previewToggle && previewInline) {
        if (runtime.adminLatexPreviewVisible) {
          paintInlinePreview();
        }
        previewToggle.addEventListener("click", function () {
          runtime.adminLatexPreviewVisible = !runtime.adminLatexPreviewVisible;
          previewInline.style.display = runtime.adminLatexPreviewVisible ? "block" : "none";
          previewToggle.textContent = runtime.adminLatexPreviewVisible ? "Hide preview" : "Show preview";
          if (runtime.adminLatexPreviewVisible) {
            paintInlinePreview();
          }
        });
      }

      if (previewFull) {
        previewFull.addEventListener("click", function () {
          var body = '<div class="latex-preview latex-preview-modal">' + buildLatexPreviewHtml(questionForm) + '</div>';
          var overlay = showAdminModal("LaTeX Preview", body, true);
          if (overlay) {
            var root = overlay.querySelector(".latex-preview-modal");
            renderLatexInElement(root);
          }
        });
      }

      // Update preview as the admin types (throttled).
      ["#question-prompt", "#question-passage", "#option-0", "#option-1", "#option-2", "#option-3", "#question-explanation"]
        .forEach(function (selector) {
          var el = questionForm.querySelector(selector);
          if (el) {
            el.addEventListener("input", schedulePreviewPaint);
            el.addEventListener("change", schedulePreviewPaint);
          }
        });

      var questionSectionSelect = questionForm.querySelector("#question-section");
      var questionMarksInput = questionForm.querySelector("#question-marks");
      var questionNegativeInput = questionForm.querySelector("#question-negative");
      function applySectionMarkDefaults() {
        if (!questionSectionSelect || !questionMarksInput || !questionNegativeInput) return;
        var defaults = getSectionDefaultMarking(questionSectionSelect.value);
        questionMarksInput.value = String(defaults.marks);
        questionNegativeInput.value = String(defaults.negativeMarks);
      }
      if (questionSectionSelect) {
        questionSectionSelect.addEventListener("change", applySectionMarkDefaults);
      }

      var questionFilesInput = questionForm.querySelector("#question-files");
      if (questionFilesInput) {
        questionFilesInput.addEventListener("change", function () {
          updateQuestionFileStatus(questionFilesInput.files);
        });
      }
      renderQuestionUploadUi();
      var uploadQuestionImagesButton = document.getElementById("upload-question-images");
      if (uploadQuestionImagesButton) {
        uploadQuestionImagesButton.addEventListener("click", async function () {
          if (!runtime.pendingQuestionFiles.length) {
            window.alert("Choose at least one image first.");
            return;
          }
          var originalLabel = uploadQuestionImagesButton.textContent;
          uploadQuestionImagesButton.disabled = true;
          uploadQuestionImagesButton.textContent = "Uploading...";
          try {
            var preparedFiles = await prepareQuestionUploadFiles(runtime.pendingQuestionFiles);
            showOverlayLoader("Uploading image to Cloudinary.");
            var uploadedUrls = await store.uploadQuestionImages(preparedFiles);
            runtime.pendingUploadedQuestionImageUrls = dedupeUrls((runtime.pendingUploadedQuestionImageUrls || []).concat(uploadedUrls || []));
            if (questionFilesInput) {
              questionFilesInput.value = "";
            }
            updateQuestionFileStatus([]);
            hideOverlayLoader();
            rerenderAdminPreserveScroll(user, selectedTestId);
          } catch (error) {
            hideOverlayLoader();
            window.alert(error && error.message ? error.message : "Image upload failed.");
          } finally {
            uploadQuestionImagesButton.disabled = !runtime.pendingQuestionFiles.length;
            uploadQuestionImagesButton.textContent = originalLabel || "Upload selected images";
          }
        });
      }
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
          var rawSelectedFiles = runtime.pendingQuestionFiles.length
            ? runtime.pendingQuestionFiles
            : Array.prototype.slice.call(event.currentTarget.querySelector("#question-files").files || []);
          var selectedFiles = await prepareQuestionUploadFiles(rawSelectedFiles);
          var driveImages = parseQuestionImageLinksText(form.get("driveImageLinks"));
          var existingNonDriveImages = editingQuestion ? getQuestionImageUrls(editingQuestion).filter(function (url) {
            return !isGoogleDriveImageLink(url);
          }) : [];
          var uploadedCloudinaryImages = dedupeUrls(runtime.pendingUploadedQuestionImageUrls || []);
          runtime.adminSelectedTestId = activeTestId;
          var payload = {
            testId: activeTestId,
            section: form.get("section"),
            topic: form.get("topic"),
            difficulty: form.get("difficulty"),
            prompt: form.get("prompt"),
            passage: form.get("passage"),
            imageUrls: dedupeUrls(existingNonDriveImages.concat(uploadedCloudinaryImages, driveImages)),
            options: [form.get("option0"), form.get("option1"), form.get("option2"), form.get("option3")],
            correctOption: form.get("correctOption"),
            explanation: form.get("explanation"),
            marks: form.get("marks"),
            negativeMarks: form.get("negativeMarks")
          };

          showOverlayLoader(runtime.adminEditingQuestionId ? "Updating question." : "Creating question.");
          var savedQuestion = runtime.adminEditingQuestionId
            ? await store.updateQuestion(runtime.adminEditingQuestionId, payload, selectedFiles)
            : await store.createQuestion(payload, selectedFiles);
          runtime.adminEditingQuestionId = null;
          resetPendingQuestionUploads();
          clearLocalDraft(ADMIN_QUESTION_DRAFT_KEY);
          hideOverlayLoader();
          rerenderAdminPreserveScroll(user, activeTestId);
        } catch (error) {
          var rawMessage = (error && error.message ? String(error.message) : "");
          var friendly =
            rawMessage.indexOf("Invalid Signature") !== -1
              ? "Cloudinary rejected the upload (Invalid Signature). Re-check your Cloudinary API secret / CLOUDINARY_URL and restart the backend."
              : rawMessage.indexOf("Cloudinary is not configured") !== -1
                ? "Cloudinary is not configured on the backend. Set CLOUDINARY_URL (or the 3 Cloudinary vars) in backend/.env and restart."
                : rawMessage.indexOf("LIMIT_FILE_SIZE") !== -1
                  ? "Image is too large. Max allowed size is 4MB."
                  : "Question could not be saved with this image.";
          window.alert(friendly + (rawMessage ? " " + rawMessage : ""));
        } finally {
          if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = originalLabel || "Add question";
          }
          hideOverlayLoader();
        }
      });
    }

    var cancelQuestionEdit = document.getElementById("cancel-question-edit");
    if (cancelQuestionEdit) {
      cancelQuestionEdit.addEventListener("click", function () {
        runtime.adminEditingQuestionId = null;
        resetPendingQuestionUploads();
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

    async function moveTestOrder(testId, direction) {
      var orderedIds = tests.map(function (test) { return test.id; });
      var currentIndex = orderedIds.indexOf(String(testId || ""));
      if (currentIndex === -1) return;
      var targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
      if (targetIndex < 0 || targetIndex >= orderedIds.length) return;

      var swapped = orderedIds.slice();
      var currentId = swapped[currentIndex];
      swapped[currentIndex] = swapped[targetIndex];
      swapped[targetIndex] = currentId;

      showOverlayLoader("Updating dashboard order.");
      try {
        if (store.reorderTests) {
          await store.reorderTests(swapped);
        } else {
          for (var index = 0; index < swapped.length; index += 1) {
            await store.updateTest(swapped[index], { displayOrder: (index + 1) * 10 });
          }
        }
        rerenderAdminPreserveScroll(user, runtime.adminSelectedTestId || selectedTestId);
      } catch (error) {
        window.alert(error && error.message ? error.message : "Could not update dashboard order.");
      } finally {
        hideOverlayLoader();
      }
    }

    app.querySelectorAll(".js-move-test-up").forEach(function (button) {
      button.addEventListener("click", function () {
        moveTestOrder(button.dataset.id, "up");
      });
    });

    app.querySelectorAll(".js-move-test-down").forEach(function (button) {
      button.addEventListener("click", function () {
        moveTestOrder(button.dataset.id, "down");
      });
    });

    app.querySelectorAll(".js-edit-test").forEach(function (button) {
      button.addEventListener("click", function () {
        runtime.adminEditingTestId = button.dataset.id;
        rerenderAdminPreserveScroll(user, button.dataset.id);
      });
    });

    app.querySelectorAll(".js-toggle-live").forEach(function (button) {
      button.addEventListener("click", async function () {
        var test = store.getTestById(button.dataset.id);
        showOverlayLoader("Updating test.");
        try {
          await store.updateTest(button.dataset.id, {
            status: test.status === "live" ? "draft" : "live"
          });
          rerenderAdminPreserveScroll(user, selectedTestId);
        } catch (error) {
          window.alert(error && error.message ? error.message : "Could not update the test.");
        } finally {
          hideOverlayLoader();
        }
      });
    });

    app.querySelectorAll(".js-delete-test").forEach(function (button) {
      button.addEventListener("click", async function () {
        showOverlayLoader("Deleting test.");
        try {
          await store.deleteTest(button.dataset.id);
          if (runtime.adminSelectedTestId === button.dataset.id) {
            runtime.adminSelectedTestId = null;
          }
          if (runtime.adminEditingTestId === button.dataset.id) {
            runtime.adminEditingTestId = null;
          }
          rerenderAdminPreserveScroll(user);
        } catch (error) {
          window.alert(error && error.message ? error.message : "Could not delete the test.");
        } finally {
          hideOverlayLoader();
        }
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
      button.addEventListener("click", async function () {
        showOverlayLoader("Deleting question.");
        try {
          await store.deleteQuestion(button.dataset.id);
          if (runtime.adminEditingQuestionId === button.dataset.id) {
            runtime.adminEditingQuestionId = null;
          }
          rerenderAdminPreserveScroll(user, selectedTestId);
        } catch (error) {
          window.alert(error && error.message ? error.message : "Could not delete the question.");
        } finally {
          hideOverlayLoader();
        }
      });
    });

    app.querySelectorAll(".js-attach-question").forEach(function (button) {
      button.addEventListener("click", async function () {
        showOverlayLoader("Attaching question.");
        try {
          await store.attachQuestionToTest(selectedTestId, button.dataset.question);
          rerenderAdminPreserveScroll(user, selectedTestId);
        } catch (error) {
          window.alert(error && error.message ? error.message : "Could not attach the question.");
        } finally {
          hideOverlayLoader();
        }
      });
    });

    app.querySelectorAll(".js-detach-question").forEach(function (button) {
      button.addEventListener("click", async function () {
        if (!selectedTestId) {
          return;
        }
        showOverlayLoader("Removing question.");
        try {
          await store.detachQuestionFromTest(selectedTestId, button.dataset.id);
          rerenderAdminPreserveScroll(user, selectedTestId);
        } catch (error) {
          window.alert(error && error.message ? error.message : "Could not remove the question.");
        } finally {
          hideOverlayLoader();
        }
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
    if (!auth.isAdmin(user)) {
      navigate("dashboard");
      return;
    }
    // New API-backed insights view (admin-only).
    var snapshot = store.getAdminSnapshot() || {};
    var tests = store.getTests();
    var users = Array.isArray(snapshot.users) ? snapshot.users : [];
    var paidCount = users.filter(function (u) { return u && u.isPaid; }).length;
    var attemptsCount = Array.isArray(snapshot.attempts) ? snapshot.attempts.length : 0;
    var liveCount = tests.filter(function (t) { return t && t.status === "live"; }).length;

    var defaultTestId = runtime.adminActivityTestId || (tests[0] ? tests[0].id : "");
    runtime.adminActivityTestId = defaultTestId;

    app.innerHTML = buildShell(
      '<section class="report-layout">' +
        '<div class="report-bar">' +
          '<div class="brand-mark"><span class="brand-dot"></span> AceIIIT</div>' +
          '<div class="button-row">' +
            getThemeToggleMarkup() +
            '<button class="button button-secondary" id="back-admin">Builder Mode</button>' +
            '<button class="button button-secondary" id="back-dashboard">Dashboard</button>' +
          '</div>' +
        '</div>' +
        '<div class="report-body">' +
          '<div class="report-heading">' +
            '<p class="section-label">Admin insights</p>' +
            '<h1>Users, results, leaderboard, analytics</h1>' +
          '</div>' +
          '<div class="metric-grid" style="margin-bottom: 18px;">' +
            '<div class="metric-card"><strong>' + escapeHtml(String(snapshot && snapshot.userCount !== undefined ? snapshot.userCount : users.length)) + '</strong><span>Users</span></div>' +
            '<div class="metric-card"><strong>' + escapeHtml(String(paidCount)) + '</strong><span>Paid</span></div>' +
            '<div class="metric-card"><strong>' + escapeHtml(String(liveCount)) + '</strong><span>Live tests</span></div>' +
            '<div class="metric-card"><strong>' + escapeHtml(String(attemptsCount)) + '</strong><span>Recent attempts</span></div>' +
          '</div>' +
          '<div class="report-grid">' +
            '<div class="report-card">' +
              '<p class="section-label">Users</p>' +
              '<div class="field" style="margin-top: 12px;"><label for="user-search">Search</label><input id="user-search" placeholder="Search by name or email"></div>' +
              '<div id="users-table" class="table-like" style="margin-top: 14px;"></div>' +
            '</div>' +
            '<aside class="report-card">' +
              '<p class="section-label">Recent results</p>' +
              '<div id="results-table" class="table-like" style="margin-top: 14px;"><div class="empty-state">Loading…</div></div>' +
            '</aside>' +
            '<div class="report-card">' +
              '<div class="button-row" style="justify-content: space-between; align-items:center;">' +
                '<p class="section-label" style="margin:0;">Leaderboard (Attempt 1)</p>' +
                '<button class="button button-secondary button-compact" type="button" id="export-leaderboard-pdf">Export PDF</button>' +
              '</div>' +
              '<div class="field" style="margin-top: 12px;"><label for="leaderboard-test">Test</label>' +
                '<select id="leaderboard-test">' +
                  (tests.length ? tests.map(function (t) { return '<option value="' + escapeAttribute(t.id) + '"' + (t.id === defaultTestId ? " selected" : "") + '>' + escapeHtml(t.title) + '</option>'; }).join("") : '<option value="">No tests</option>') +
                '</select>' +
              '</div>' +
              '<div id="leaderboard-table" class="table-like" style="margin-top: 14px;"><div class="empty-state">Loading…</div></div>' +
            '</div>' +
            '<aside class="report-card">' +
              '<p class="section-label">Analytics</p>' +
              '<div class="field" style="margin-top: 12px;"><label for="analytics-test">Test</label>' +
                '<select id="analytics-test">' +
                  (tests.length ? tests.map(function (t) { return '<option value="' + escapeAttribute(t.id) + '"' + (t.id === defaultTestId ? " selected" : "") + '>' + escapeHtml(t.title) + '</option>'; }).join("") : '<option value="">No tests</option>') +
                '</select>' +
              '</div>' +
              '<div id="analytics-cards" style="margin-top: 14px;"><div class="empty-state">Loading…</div></div>' +
            '</aside>' +
          '</div>' +
        '</div>' +
      '</section>'
    , { fluid: true });
    renderLatexInElement(document.body);

    document.getElementById("back-admin").addEventListener("click", function () {
      navigate("admin");
    });
    document.getElementById("back-dashboard").addEventListener("click", function () {
      navigate("dashboard");
    });

    function renderUsersTable(query) {
      var needle = String(query || "").trim().toLowerCase();
      var list = (needle ? users.filter(function (u) {
        var hay = (String(u.name || "") + " " + String(u.email || "")).toLowerCase();
        return hay.indexOf(needle) !== -1;
      }) : users).slice(0, 60);

      var rows = list.map(function (u) {
        var online = isUserOnline(u);
        return (
          '<div class="table-row">' +
            '<span><strong><span class="presence-dot ' + (online ? 'is-online' : 'is-offline') + '"></span>' + highlightMatch(u.name || "Student", needle) + '</strong><br><small>' + highlightMatch(u.email || "", needle) + '</small></span>' +
            '<span>' + escapeHtml(u.role || "student") + '</span>' +
            '<span>' + (u.isPaid ? "Paid" : "Free") + '</span>' +
            '<span><small>' + escapeHtml(formatDateTime(u.createdAt)) + '</small><br><small class="helper-text">' + (online ? 'Live now' : ('Last seen ' + escapeHtml(formatDateTime(u.lastSeenAt || "")))) + '</small></span>' +
          '</div>'
        );
      }).join("");

      var container = document.getElementById("users-table");
      if (container) {
        container.innerHTML =
          '<div class="table-row header"><span>User</span><span>Role</span><span>Access</span><span>Created</span></div>' +
          (rows || '<div class="empty-state">No matching users.</div>');
      }
    }

    function renderResultsRows(results) {
      var rows = (results || []).slice(0, 30).map(function (item) {
        return (
          '<div class="table-row">' +
            '<span><strong>' + escapeHtml((item.test && item.test.title) || "") + '</strong><br><small>' + escapeHtml((item.user && item.user.email) || "") + '</small></span>' +
            '<span>' + escapeHtml(String(item.score)) + '</span>' +
            '<span>' + escapeHtml(String(item.percentile)) + '</span>' +
            '<span><small>' + escapeHtml(formatDateTime(item.submittedAt)) + '</small></span>' +
          '</div>'
        );
      }).join("");
      var container = document.getElementById("results-table");
      if (container) {
        container.innerHTML =
          '<div class="table-row header"><span>Test / Student</span><span>Score</span><span>Percentile</span><span>Submitted</span></div>' +
          (rows || '<div class="empty-state">No submissions yet.</div>');
      }
    }

    function renderLeaderboardRows(entries) {
      var rows = (entries || []).map(function (entry) {
        var u = entry.user || {};
        return (
          '<div class="table-row">' +
            '<span>#' + escapeHtml(String(entry.rank || "")) + '</span>' +
            '<span><strong>' + escapeHtml(u.name || "-") + '</strong><br><small>' + escapeHtml(u.email || "-") + '</small></span>' +
            '<span>' + escapeHtml(String(entry.score)) + '</span>' +
            '<span>' + escapeHtml(String(Math.round((entry.timeTakenSeconds || 0) / 60))) + ' min</span>' +
            '<span><small>' + escapeHtml(formatDateTime(entry.submittedAt)) + '</small></span>' +
          '</div>'
        );
      }).join("");
      var container = document.getElementById("leaderboard-table");
      if (container) {
        container.innerHTML =
          '<div class="table-row header"><span>Rank</span><span>Student</span><span>Score</span><span>Time</span><span>Submitted</span></div>' +
          (rows || '<div class="empty-state">No submissions yet.</div>');
      }
    }

    function buildMiniBarRow(label, value, maxValue, suffix) {
      var safeValue = Number.isFinite(Number(value)) ? Number(value) : 0;
      var safeMax = Number.isFinite(Number(maxValue)) && Number(maxValue) > 0 ? Number(maxValue) : 1;
      var width = Math.max(6, Math.min(100, Math.round((safeValue / safeMax) * 100)));
      return '<div class="analysis-bar-row"><span>' + escapeHtml(label) + '</span><div class="analysis-bar-track"><div class="analysis-bar-fill" style="width:' + width + '%;"></div></div><strong>' + escapeHtml(String(safeValue)) + escapeHtml(String(suffix || "")) + '</strong></div>';
    }

    function renderAnalyticsCards(analytics) {
      var a = analytics || { count: 0, avgScore: 0, avgAccuracy: 0, maxScore: 0 };
      var avgScore = Number.isFinite(Number(a.avgScore)) ? Number(a.avgScore).toFixed(2) : "0.00";
      var avgAcc = Number.isFinite(Number(a.avgAccuracy)) ? Number(a.avgAccuracy).toFixed(1) : "0.0";
      var maxScore = Number.isFinite(Number(a.maxScore)) ? Number(a.maxScore) : 0;
      var count = Number.isFinite(Number(a.count)) ? Number(a.count) : 0;
      var selectedTestId = (analyticsSelect && analyticsSelect.value) || defaultTestId;
      var selectedTest = tests.find(function (t) { return t.id === selectedTestId; }) || null;
      var recentResults = (window.__aceAdminResults || []).filter(function (item) {
        return item && item.test && item.test.id === selectedTestId;
      });
      var maxMarks = selectedTest ? Number((selectedTest.questionIds || []).length ? store.getQuestionsForTest(selectedTest.id).reduce(function (sum, q) { return sum + Number(q.marks || 0); }, 0) : 0) : 0;
      var scoreBands = { "0-25%": 0, "26-50%": 0, "51-75%": 0, "76-100%": 0 };
      var timeBands = { "<30m": 0, "30-60m": 0, "60-120m": 0, "120m+": 0 };
      var latestTrend = recentResults.slice(0, 8).reverse();
      recentResults.forEach(function (item) {
        var ratio = maxMarks > 0 ? (Number(item.score || 0) / maxMarks) * 100 : 0;
        if (ratio <= 25) scoreBands["0-25%"] += 1;
        else if (ratio <= 50) scoreBands["26-50%"] += 1;
        else if (ratio <= 75) scoreBands["51-75%"] += 1;
        else scoreBands["76-100%"] += 1;

        var minutes = Number(item.timeTakenSeconds || 0) / 60;
        if (minutes < 30) timeBands["<30m"] += 1;
        else if (minutes < 60) timeBands["30-60m"] += 1;
        else if (minutes < 120) timeBands["60-120m"] += 1;
        else timeBands["120m+"] += 1;
      });
      var scoreBandMax = Math.max(1, scoreBands["0-25%"], scoreBands["26-50%"], scoreBands["51-75%"], scoreBands["76-100%"]);
      var timeBandMax = Math.max(1, timeBands["<30m"], timeBands["30-60m"], timeBands["60-120m"], timeBands["120m+"]);
      var container = document.getElementById("analytics-cards");
      if (container) {
        container.innerHTML =
          '<p class="helper-text">Aggregate across all attempts for this test.</p>' +
          '<div class="metric-grid" style="margin-top: 10px;">' +
            '<div class="metric-card"><strong>' + escapeHtml(String(count)) + '</strong><span>Attempts</span></div>' +
            '<div class="metric-card"><strong>' + escapeHtml(String(maxScore)) + '</strong><span>Top score</span></div>' +
            '<div class="metric-card"><strong>' + escapeHtml(String(avgScore)) + '</strong><span>Avg score</span></div>' +
            '<div class="metric-card"><strong>' + escapeHtml(String(avgAcc)) + '%</strong><span>Avg accuracy</span></div>' +
          '</div>' +
          '<div class="divider"></div>' +
          '<p class="section-label">Score spread</p>' +
          '<div class="analysis-bar-stack">' +
            buildMiniBarRow("0-25%", scoreBands["0-25%"], scoreBandMax, "") +
            buildMiniBarRow("26-50%", scoreBands["26-50%"], scoreBandMax, "") +
            buildMiniBarRow("51-75%", scoreBands["51-75%"], scoreBandMax, "") +
            buildMiniBarRow("76-100%", scoreBands["76-100%"], scoreBandMax, "") +
          '</div>' +
          '<div class="divider"></div>' +
          '<p class="section-label">Time spread</p>' +
          '<div class="analysis-bar-stack">' +
            buildMiniBarRow("<30m", timeBands["<30m"], timeBandMax, "") +
            buildMiniBarRow("30-60m", timeBands["30-60m"], timeBandMax, "") +
            buildMiniBarRow("60-120m", timeBands["60-120m"], timeBandMax, "") +
            buildMiniBarRow("120m+", timeBands["120m+"], timeBandMax, "") +
          '</div>' +
          '<div class="divider"></div>' +
          '<p class="section-label">Recent trend</p>' +
          (latestTrend.length
            ? '<div class="trend-sparkline">' + latestTrend.map(function (item) {
                var height = maxMarks > 0 ? Math.max(12, Math.min(100, Math.round((Number(item.score || 0) / maxMarks) * 100))) : 12;
                return '<div class="trend-bar"><span style="height:' + height + '%;"></span><small>' + escapeHtml(String(Number(item.score || 0))) + '</small></div>';
              }).join("") + '</div>'
            : '<div class="empty-state">More submissions will unlock trend visuals here.</div>');
      }
    }

    renderUsersTable("");
    var userSearch = document.getElementById("user-search");
    if (userSearch) {
      userSearch.addEventListener("input", function () {
        renderUsersTable(userSearch.value);
      });
    }

    Promise.resolve().then(async function () {
      try {
        var payload = await store.getAdminResults();
        window.__aceAdminResults = payload && payload.results ? payload.results : [];
        renderResultsRows(window.__aceAdminResults);
        if (defaultTestId || (analyticsSelect && analyticsSelect.value)) {
          loadAnalytics((analyticsSelect && analyticsSelect.value) || defaultTestId);
        }
      } catch (_err) {
        window.__aceAdminResults = [];
        renderResultsRows([]);
      }
    });

    async function loadLeaderboard(testId) {
      try {
        var payload = await store.getAdminLeaderboard(testId);
        window.__aceLeaderEntries = payload && payload.leaderboard ? payload.leaderboard : [];
        renderLeaderboardRows(window.__aceLeaderEntries);
      } catch (_err) {
        window.__aceLeaderEntries = [];
        renderLeaderboardRows([]);
      }
    }

    async function loadAnalytics(testId) {
      try {
        var payload = await store.getAdminTestAnalytics(testId);
        renderAnalyticsCards(payload && payload.analytics ? payload.analytics : null);
      } catch (_err) {
        renderAnalyticsCards(null);
      }
    }

    var leaderboardSelect = document.getElementById("leaderboard-test");
    if (leaderboardSelect) {
      leaderboardSelect.addEventListener("change", function () {
        runtime.adminActivityTestId = leaderboardSelect.value;
        loadLeaderboard(leaderboardSelect.value);
      });
    }

    var analyticsSelect = document.getElementById("analytics-test");
    if (analyticsSelect) {
      analyticsSelect.addEventListener("change", function () {
        runtime.adminActivityTestId = analyticsSelect.value;
        loadAnalytics(analyticsSelect.value);
      });
    }

    var exportBtn = document.getElementById("export-leaderboard-pdf");
    if (exportBtn) {
      exportBtn.addEventListener("click", function () {
        var testId = (leaderboardSelect && leaderboardSelect.value) || defaultTestId;
        if (!testId) return;
        var test = tests.find(function (t) { return t.id === testId; }) || null;
        var entries = window.__aceLeaderEntries || [];
        var exportWindow = window.open("", "_blank");
        if (!exportWindow) return;

        exportWindow.document.write(
          '<html><head><title>Leaderboard - ' + escapeHtml(test ? test.title : testId) + '</title></head><body style="font-family: Arial, sans-serif; padding: 32px; color: #15110f;">' +
            '<h1 style="margin-bottom: 8px;">' + escapeHtml(test ? test.title : testId) + '</h1>' +
            '<p style="margin-top: 0; color: #5d554d;">AceIIIT first-attempt leaderboard export</p>' +
            (entries.length ? (
              '<table style="width: 100%; border-collapse: collapse; margin-top: 20px;">' +
                '<thead><tr>' +
                  '<th style="text-align:left; border-bottom:1px solid #ccc; padding: 10px 8px;">Rank</th>' +
                  '<th style="text-align:left; border-bottom:1px solid #ccc; padding: 10px 8px;">Name</th>' +
                  '<th style="text-align:left; border-bottom:1px solid #ccc; padding: 10px 8px;">Email</th>' +
                  '<th style="text-align:left; border-bottom:1px solid #ccc; padding: 10px 8px;">Score</th>' +
                  '<th style="text-align:left; border-bottom:1px solid #ccc; padding: 10px 8px;">Time (min)</th>' +
                  '<th style="text-align:left; border-bottom:1px solid #ccc; padding: 10px 8px;">Submitted</th>' +
                '</tr></thead>' +
                '<tbody>' +
                  entries.map(function (entry) {
                    var u = entry.user || {};
                    return '<tr>' +
                      '<td style="border-bottom:1px solid #eee; padding: 10px 8px;">#' + escapeHtml(String(entry.rank || "")) + '</td>' +
                      '<td style="border-bottom:1px solid #eee; padding: 10px 8px;">' + escapeHtml(u.name || "-") + '</td>' +
                      '<td style="border-bottom:1px solid #eee; padding: 10px 8px;">' + escapeHtml(u.email || "-") + '</td>' +
                      '<td style="border-bottom:1px solid #eee; padding: 10px 8px;">' + escapeHtml(String(entry.score)) + '</td>' +
                      '<td style="border-bottom:1px solid #eee; padding: 10px 8px;">' + escapeHtml(String(Math.round((entry.timeTakenSeconds || 0) / 60))) + '</td>' +
                      '<td style="border-bottom:1px solid #eee; padding: 10px 8px;">' + escapeHtml(formatDateTime(entry.submittedAt)) + '</td>' +
                    '</tr>';
                  }).join("") +
                '</tbody>' +
              '</table>'
            ) : '<p>No submissions yet for this test.</p>') +
          '</body></html>'
        );
        exportWindow.document.close();
        exportWindow.focus();
        exportWindow.print();
      });
    }

    if (defaultTestId) {
      loadLeaderboard(defaultTestId);
      loadAnalytics(defaultTestId);
    } else {
      renderLeaderboardRows([]);
      renderAnalyticsCards(null);
    }

    return;

    var snapshot = store.getAdminSnapshot();
    var tests = store.getTests();
    var selectedLeaderboardTestId = runtime.adminActivityTestId || (tests[0] ? tests[0].id : "");
    var leaderboard = selectedLeaderboardTestId ? store.getFirstAttemptLeaderboard(selectedLeaderboardTestId) : [];
    app.innerHTML = buildShell(
      '<section class="report-layout">' +
        '<div class="report-bar">' +
          '<div class="brand-mark"><span class="brand-dot"></span> AceIIIT</div>' +
          '<div class="button-row">' +
            getThemeToggleMarkup() +
            '<button class="button button-secondary" id="back-admin">Builder Mode</button>' +
          '</div>' +
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
        '<div class="app-footer app-footer-inline">AceIIIT MockTest Portal</div>' +
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
    var user = auth.getCurrentUser();
    var view = parts[0] || (user ? "dashboard" : "login");
    applyTheme();

    if (view !== "test") {
      stopRuntime(true);
    }

    if (!user && view !== "login") {
      navigate("login");
      return;
    }

    if (user && view === "login") {
      navigate("dashboard");
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
    var currentView = routeParts()[0] || "";
    if (isExamLikeRoute(currentView)) {
      try {
        renderRoute();
      } catch (error) {
        console.error("AceIIIT route render error:", error);
        renderAppErrorState("This route could not be opened cleanly.");
      }
      return;
    }
    syncAndRenderCurrentRoute();
  });
  window.addEventListener("focus", function () {
    updateKeepAliveState();
    var parts = routeParts();
    var view = parts[0] || "";
    if (view === "admin" && hasPendingQuestionUploadState()) {
      return;
    }
    if (view === "dashboard" || view === "admin" || view === "admin-activity" || view === "results" || view === "") {
      syncAndRenderCurrentRoute();
    }
  });
  window.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      clearKeepAliveTimer();
      return;
    }
    updateKeepAliveState();
    if (!document.hidden) {
      var parts = routeParts();
      var view = parts[0] || "";
      var user = auth.getCurrentUser ? auth.getCurrentUser() : (store.getCurrentUser ? store.getCurrentUser() : null);
      if (!user) {
        return;
      }
      if (isExamLikeRoute(view)) {
        return;
      }
      if (view === "admin" && hasPendingQuestionUploadState()) {
        return;
      }
      if (view === "dashboard" || view === "admin" || view === "admin-activity" || view === "results" || view === "") {
        syncAndRenderCurrentRoute();
      }
    }
  });
  window.addEventListener("beforeunload", function () {
    clearKeepAliveTimer();
    flushQuestionTime();
  });
  document.addEventListener("click", function (event) {
    var toggle = event.target && event.target.closest ? event.target.closest("[data-theme-toggle='true']") : null;
    if (!toggle) return;
    toggleThemePreference();
  });

  if (!window.location.hash) {
    navigate("login");
  } else {
    renderRoute();
  }
  showOverlayLoader("Syncing the newest backend changes into this screen.");
  Promise.resolve(store.init()).finally(function () {
    if (store.subscribeToRemoteChanges && !remoteChangeUnsubscribe) {
      remoteChangeUnsubscribe = store.subscribeToRemoteChanges(function () {
        var currentView = routeParts()[0] || "";
        if (isExamLikeRoute(currentView)) {
          return;
        }
        syncAndRenderCurrentRoute();
      });
    }
    startSyncPolling();
    updateKeepAliveState();
    syncAndRenderCurrentRoute();
  });
})();
