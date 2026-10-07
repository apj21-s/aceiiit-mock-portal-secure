(function () {
  // Exam-integrity telemetry. Browser signals are imperfect: they can be missing, spoofed
  // or triggered innocently, so they are reported to the server as evidence for review.
  // The server owns the violation count, enforcement (deadlines, section locks, session
  // binding) and any strict-mode auto-submit. Nothing here disqualifies a student.
  window.AceIIIT = window.AceIIIT || {};

  var BLUR_DEBOUNCE_MS = 1500;
  var FLUSH_INTERVAL_MS = 3000;
  var FULLSCREEN_GRACE_MS = 10000;
  var VIEWPORT_SHRINK_RATIO = 0.6;
  var CHANNEL_NAME = "aceiiit-exam";

  var active = null;

  function nowIso() {
    return new Date().toISOString();
  }

  function isExempt(target) {
    // In-app tools (calculator, palette, modals, inputs) are part of the exam UI.
    if (!target || !target.closest) return false;
    return !!target.closest(".calculator-modal, .mobile-palette-overlay, .transition-modal, input, textarea, [data-integrity-exempt]");
  }

  function queue(type, extra) {
    if (!active) return;
    var event = Object.assign({ type: type, at: nowIso() }, extra || {});
    active.pending.push(event);
    if (active.countedTypes[type]) {
      flush();
    }
  }

  function flush() {
    if (!active || !active.pending.length || active.flushing) return;
    var batch = active.pending.splice(0, 25);
    var session = active;
    session.flushing = true;
    Promise.resolve(session.send(batch))
      .then(function (response) {
        if (!response || session !== active) return;
        if (typeof session.onUpdate === "function") session.onUpdate(response);
      })
      .catch(function () {
        // Keep the batch for the next attempt (offline / transient errors).
        if (session === active) session.pending = batch.concat(session.pending).slice(-100);
      })
      .finally(function () {
        session.flushing = false;
      });
  }

  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function requestFullscreen() {
    var el = document.documentElement;
    var request = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!request) return Promise.resolve(false);
    try {
      return Promise.resolve(request.call(el)).then(function () { return true; }).catch(function () { return false; });
    } catch (_err) {
      return Promise.resolve(false);
    }
  }

  function showFullscreenPrompt() {
    if (!active || document.getElementById("integrity-fullscreen-prompt")) return;
    var overlay = document.createElement("div");
    overlay.id = "integrity-fullscreen-prompt";
    overlay.className = "integrity-fullscreen-prompt";
    overlay.setAttribute("role", "alertdialog");
    overlay.setAttribute("aria-live", "assertive");
    overlay.setAttribute("data-integrity-exempt", "true");
    overlay.innerHTML =
      '<div class="integrity-fullscreen-card">' +
      "<strong>Return to full screen</strong>" +
      "<p>This exam runs in full screen. Leaving full screen is recorded.</p>" +
      '<button type="button" class="button button-primary" id="integrity-fullscreen-return">Return to full screen</button>' +
      "</div>";
    document.body.appendChild(overlay);
    var button = document.getElementById("integrity-fullscreen-return");
    if (button) {
      button.addEventListener("click", function () {
        requestFullscreen();
      });
    }
  }

  function hideFullscreenPrompt() {
    var overlay = document.getElementById("integrity-fullscreen-prompt");
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  }

  function renderWatermark(label) {
    var existing = document.getElementById("integrity-watermark");
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    var mark = document.createElement("div");
    mark.id = "integrity-watermark";
    mark.className = "integrity-watermark";
    mark.setAttribute("aria-hidden", "true");
    var text = String(label || "");
    var rows = [];
    for (var i = 0; i < 14; i += 1) {
      var row = document.createElement("span");
      row.textContent = (text + "    ").repeat(4);
      rows.push(row);
    }
    rows.forEach(function (row) { mark.appendChild(row); });
    document.body.appendChild(mark);
  }

  function blockedShortcut(event) {
    var key = String(event.key || "").toLowerCase();
    var mod = event.ctrlKey || event.metaKey;
    if (key === "f12") return "F12";
    if (mod && event.shiftKey && (key === "i" || key === "j" || key === "c")) return "devtools";
    if (mod && ["c", "x", "v", "p", "s", "u", "a"].indexOf(key) !== -1) return "ctrl+" + key;
    if (key === "printscreen") return "printscreen";
    return "";
  }

  function bind(session) {
    var handlers = {};
    var blurTimer = null;
    var fullscreenTimer = null;
    var fullscreenLeftAt = 0;
    var offlineAt = 0;
    var resizeTimer = null;

    handlers.visibility = function () {
      if (document.hidden) {
        queue("tab_hidden");
      }
    };
    handlers.blur = function () {
      if (blurTimer) window.clearTimeout(blurTimer);
      blurTimer = window.setTimeout(function () {
        if (!document.hidden && !document.hasFocus()) queue("window_blur");
      }, BLUR_DEBOUNCE_MS);
    };
    handlers.focus = function () {
      if (blurTimer) window.clearTimeout(blurTimer);
      blurTimer = null;
    };
    handlers.fullscreen = function () {
      if (!session.fullscreenWanted) return;
      if (isFullscreen()) {
        if (fullscreenTimer) window.clearTimeout(fullscreenTimer);
        fullscreenTimer = null;
        if (fullscreenLeftAt) {
          queue("fullscreen_return", { durationMs: Date.now() - fullscreenLeftAt });
          fullscreenLeftAt = 0;
        }
        hideFullscreenPrompt();
        return;
      }
      fullscreenLeftAt = Date.now();
      showFullscreenPrompt();
      fullscreenTimer = window.setTimeout(function () {
        if (!isFullscreen()) queue("fullscreen_exit", { durationMs: FULLSCREEN_GRACE_MS });
      }, FULLSCREEN_GRACE_MS);
    };
    handlers.clipboard = function (event) {
      if (isExempt(event.target)) return;
      event.preventDefault();
      queue(event.type + "_attempt");
    };
    handlers.contextmenu = function (event) {
      if (isExempt(event.target)) return;
      event.preventDefault();
      queue("context_menu");
    };
    handlers.keydown = function (event) {
      var combo = blockedShortcut(event);
      if (!combo) return;
      if (isExempt(event.target) && /ctrl\+(c|x|v|a)/.test(combo)) return;
      event.preventDefault();
      queue("blocked_shortcut", { detail: combo });
    };
    handlers.keyup = function (event) {
      if (String(event.key || "").toLowerCase() === "printscreen") queue("blocked_shortcut", { detail: "printscreen" });
    };
    handlers.beforeprint = function () {
      queue("print_attempt");
    };
    handlers.dragstart = function (event) {
      if (!isExempt(event.target)) event.preventDefault();
    };
    handlers.offline = function () {
      offlineAt = Date.now();
    };
    handlers.online = function () {
      if (offlineAt) queue("offline", { durationMs: Date.now() - offlineAt });
      offlineAt = 0;
    };
    handlers.resize = function () {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(function () {
        var available = (window.screen && window.screen.availWidth) || window.innerWidth;
        if (available && window.innerWidth < available * VIEWPORT_SHRINK_RATIO) queue("viewport_shrink", { detail: window.innerWidth + "/" + available });
      }, 800);
    };

    document.addEventListener("visibilitychange", handlers.visibility);
    window.addEventListener("blur", handlers.blur);
    window.addEventListener("focus", handlers.focus);
    document.addEventListener("fullscreenchange", handlers.fullscreen);
    document.addEventListener("webkitfullscreenchange", handlers.fullscreen);
    document.addEventListener("copy", handlers.clipboard, true);
    document.addEventListener("cut", handlers.clipboard, true);
    document.addEventListener("paste", handlers.clipboard, true);
    document.addEventListener("contextmenu", handlers.contextmenu, true);
    document.addEventListener("keydown", handlers.keydown, true);
    document.addEventListener("keyup", handlers.keyup, true);
    document.addEventListener("dragstart", handlers.dragstart, true);
    window.addEventListener("beforeprint", handlers.beforeprint);
    window.addEventListener("offline", handlers.offline);
    window.addEventListener("online", handlers.online);
    window.addEventListener("resize", handlers.resize);

    // Single-tab lock: a second tab of the same exam announces itself.
    if (typeof window.BroadcastChannel === "function") {
      try {
        session.channel = new window.BroadcastChannel(CHANNEL_NAME);
        session.channel.onmessage = function (message) {
          var data = message && message.data;
          if (!data || data.sessionId !== session.sessionId || data.tabId === session.tabId) return;
          if (data.kind === "hello") {
            session.channel.postMessage({ kind: "present", sessionId: session.sessionId, tabId: session.tabId });
          }
          queue("second_tab");
          if (typeof session.onSecondTab === "function") session.onSecondTab();
        };
        session.channel.postMessage({ kind: "hello", sessionId: session.sessionId, tabId: session.tabId });
      } catch (_err) {
        session.channel = null;
      }
    }

    session.unbind = function () {
      document.removeEventListener("visibilitychange", handlers.visibility);
      window.removeEventListener("blur", handlers.blur);
      window.removeEventListener("focus", handlers.focus);
      document.removeEventListener("fullscreenchange", handlers.fullscreen);
      document.removeEventListener("webkitfullscreenchange", handlers.fullscreen);
      document.removeEventListener("copy", handlers.clipboard, true);
      document.removeEventListener("cut", handlers.clipboard, true);
      document.removeEventListener("paste", handlers.clipboard, true);
      document.removeEventListener("contextmenu", handlers.contextmenu, true);
      document.removeEventListener("keydown", handlers.keydown, true);
      document.removeEventListener("keyup", handlers.keyup, true);
      document.removeEventListener("dragstart", handlers.dragstart, true);
      window.removeEventListener("beforeprint", handlers.beforeprint);
      window.removeEventListener("offline", handlers.offline);
      window.removeEventListener("online", handlers.online);
      window.removeEventListener("resize", handlers.resize);
      if (blurTimer) window.clearTimeout(blurTimer);
      if (fullscreenTimer) window.clearTimeout(fullscreenTimer);
      if (resizeTimer) window.clearTimeout(resizeTimer);
      if (session.channel) {
        try { session.channel.close(); } catch (_err) {}
      }
    };
  }

  window.AceIIIT.examIntegrity = {
    /**
     * opts: { sessionId, watermark, fullscreen, send(events) => Promise<response>,
     *         onUpdate(response), onSecondTab() }
     */
    start: function (opts) {
      if (active && active.sessionId === opts.sessionId) {
        active.send = opts.send;
        active.onUpdate = opts.onUpdate;
        active.onSecondTab = opts.onSecondTab;
        return;
      }
      this.stop();
      active = {
        sessionId: opts.sessionId,
        tabId: Math.random().toString(36).slice(2),
        send: opts.send,
        onUpdate: opts.onUpdate,
        onSecondTab: opts.onSecondTab,
        pending: [],
        flushing: false,
        fullscreenWanted: opts.fullscreen !== false,
        countedTypes: {
          tab_hidden: true,
          fullscreen_exit: true,
          copy_attempt: true,
          cut_attempt: true,
          paste_attempt: true,
          blocked_shortcut: true,
          print_attempt: true,
          second_tab: true,
        },
      };
      document.body.classList.add("exam-integrity-active");
      renderWatermark(opts.watermark);
      bind(active);
      active.timer = window.setInterval(flush, FLUSH_INTERVAL_MS);
      if (active.fullscreenWanted && !isFullscreen()) {
        // Outside a user gesture this may be refused; the prompt offers a one-click return.
        requestFullscreen().then(function (ok) {
          if (!ok && active) showFullscreenPrompt();
        });
      }
    },

    stop: function () {
      if (!active) return;
      flush();
      if (active.timer) window.clearInterval(active.timer);
      if (active.unbind) active.unbind();
      active = null;
      document.body.classList.remove("exam-integrity-active");
      hideFullscreenPrompt();
      var mark = document.getElementById("integrity-watermark");
      if (mark && mark.parentNode) mark.parentNode.removeChild(mark);
      if (isFullscreen() && document.exitFullscreen) {
        document.exitFullscreen().catch(function () {});
      }
    },

    /** Call synchronously inside the click that starts the exam (browsers require a gesture). */
    requestFullscreen: requestFullscreen,
    isActiveFor: function (sessionId) {
      return !!active && active.sessionId === sessionId;
    },
  };
})();
