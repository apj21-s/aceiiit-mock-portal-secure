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
    adminBankPage: 1,
    adminBankResult: null,
    adminBankLoadingKey: "",
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
    keepAliveLastPingAt: 0,
    lastRandomBatch: null,
    googleCalendarState: { status: "syncing", autoAddEnabled: false, fetched: false }
  };
  try {
    var savedRandomBatch = localStorage.getItem("aceiiit_last_random_batch");
    if (savedRandomBatch) {
      runtime.lastRandomBatch = JSON.parse(savedRandomBatch);
    }
  } catch (e) { }
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
  var overlayLoaderTimer = 0;
  var syncPollId = null;
  var syncInFlight = false;
  var syncQueued = false;
  var KEEP_ALIVE_INTERVAL_MS = 60 * 1000;

  // -------------------------------------------------------------------------
  // OFFICIAL GOOGLE IDENTITY SERVICES (GIS) ID-TOKEN ARCHITECTURE (SINGLETON)
  // -------------------------------------------------------------------------
  var googleInitPromise = null;
  var googleInitialized = false;

  function waitForGoogleSDK() {
    if (window.google && window.google.accounts && window.google.accounts.id) {
      console.log("[Google Auth] SDK loaded");
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      var checkInterval = setInterval(function () {
        if (window.google && window.google.accounts && window.google.accounts.id) {
          clearInterval(checkInterval);
          console.log("[Google Auth] SDK loaded");
          resolve();
        }
      }, 50);
      setTimeout(function () {
        clearInterval(checkInterval);
        resolve();
      }, 10000);
    });
  }

  function initializeGoogleAuth() {
    if (googleInitialized) {
      return Promise.resolve(window.ACEIIIT_GOOGLE_CLIENT_ID);
    }
    if (googleInitPromise) {
      return googleInitPromise;
    }

    googleInitPromise = Promise.all([
      fetch("/api/auth/config", { credentials: "include" }).then(function (r) {
        if (!r.ok) throw new Error("Failed to load authentication configuration.");
        return r.json();
      }),
      waitForGoogleSDK(),
    ])
      .then(function (results) {
        var config = results[0];
        var clientId = config ? config.googleClientId : "";

        if (!clientId) {
          throw new Error("Google OAuth client ID is missing from server configuration.");
        }

        var gisLoaded = !!(window.google && window.google.accounts && window.google.accounts.id);
        if (!gisLoaded) {
          throw new Error("Google Identity Services SDK has not loaded.");
        }

        console.log("[Google Auth] initializing GIS");
        window.ACEIIIT_GOOGLE_CLIENT_ID = clientId;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: handleGoogleCredential,
          ux_mode: "popup",
          use_fedcm_for_prompt: false,
        });

        googleInitialized = true;
        console.log("[Google Auth] GIS initialized");
        return clientId;
      })
      .catch(function (err) {
        googleInitPromise = null;
        throw err;
      });

    return googleInitPromise;
  }

  function safeShowFeedback(message, isError) {
    var feedback = document.getElementById("auth-feedback");
    if (!feedback) return;
    feedback.removeAttribute("aria-live");
    if (isError) {
      feedback.setAttribute("role", "alert");
    } else {
      feedback.setAttribute("role", "status");
    }
    feedback.classList.remove("u-hidden"); // starts hidden via the !important utility
    feedback.style.display = "block";
    feedback.textContent = message;
    feedback.style.background = isError ? "rgba(239, 68, 68, 0.18)" : "rgba(16, 185, 129, 0.16)";
    feedback.style.color = isError ? "#fca5a5" : "#6ee7b7";
  }

  function safeFriendlyFetchFailure(message) {
    var base = message || "Could not reach the backend.";
    if (String(message || "").toLowerCase().indexOf("failed to fetch") !== -1) {
      if (window.location && window.location.protocol === "file:") {
        return "Backend is not reachable because the portal is opened as a file. Start the backend and open http://localhost:4000 instead.";
      }
      return "Could not connect to backend server. Make sure node server.js is running.";
    }
    return base;
  }

  function renderOrbLoadingScreen() {
    app.innerHTML = "";
    showOverlayLoader("Authenticating", { immediate: true });
  }

  async function handleGoogleCredential(response) {
    console.log("[Google Auth] GIS credential received");
    console.log("[Google Auth] Sending credential to /api/auth/google");
    if (response && response.credential) {
      renderOrbLoadingScreen();
      try {
        console.log("[Google Auth] POST /api/auth/google started");
        var resData = await auth.googleAuth({ credential: response.credential });
        console.log("[Google Auth] POST /api/auth/google completed");
        if (resData && (resData.ok || resData.user)) {
          if (store && typeof store.setCurrentUser === "function") {
            store.setCurrentUser(resData.user);
          }
          console.log("[Google Auth] navigate dashboard");
          navigate("dashboard");
        } else {
          renderRoute();
          setTimeout(function () {
            safeShowFeedback("Google authentication failed. Please try again.", true);
          }, 0);
        }
      } catch (err) {
        renderRoute();
        setTimeout(function () {
          safeShowFeedback(safeFriendlyFetchFailure(err && err.message ? err.message : "Google authentication failed. Please try again."), true);
        }, 0);
      }
    } else {
      safeShowFeedback("Google sign-in was cancelled or returned no credentials.", true);
    }
  }

  async function setupGoogleButton() {
    var container = document.getElementById("google-signin-container");
    var googleBtn = document.getElementById("social-google-btn");

    if (googleBtn && !googleBtn.dataset.boundClick) {
      googleBtn.dataset.boundClick = "true";
      googleBtn.addEventListener("click", function () {
        if (window.google && window.google.accounts && window.google.accounts.id) {
          try {
            window.google.accounts.id.prompt();
          } catch (_e) { }
        }
      });
    }

    if (!container) return;

    try {
      var clientId = await initializeGoogleAuth();
      container.innerHTML = "";
      if (window.google && window.google.accounts && window.google.accounts.id) {
        console.log("[Google Auth] rendering button overlay");
        window.google.accounts.id.renderButton(container, {
          theme: "outline",
          size: "large",
          type: "standard",
          shape: "rectangular",
          text: "continue_with",
          width: 300,
        });
        console.log("[Google Auth] GIS button rendered");
      }
    } catch (err) {
      console.warn("[Google Auth] setup error:", err.message);
    }
  }

  // ---- Virtual keyboard: keep the focused form field visible -----------------------------
  // When the on-screen keyboard shrinks the visual viewport and covers the focused field,
  // nudge it into view once (debounced; native scrolling is left alone otherwise).
  (function keepFocusedFieldVisible() {
    var viewport = window.visualViewport;
    if (!viewport) return;
    var timer = 0;
    viewport.addEventListener("resize", function () {
      var el = document.activeElement;
      if (!el || !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.type === "radio" || el.type === "checkbox") return;
      window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        var rect = el.getBoundingClientRect();
        if (rect.bottom > viewport.height || rect.top < 0) {
          try { el.scrollIntoView({ block: "nearest" }); } catch (_e) { }
        }
      }, 150);
    });
  })();

  // ---- Tables become labelled cards on phones -------------------------------------------
  // Copies each header cell's text onto the matching row cell as data-label (CSS shows it at
  // ≤640px). Defensive: never throws; skips rows whose cell count differs from the header,
  // empty/loading rows and nested tables; idempotent across re-renders and pagination.
  function labelTableCells(root) {
    if (!root || !root.querySelectorAll) return;
    var devHost = /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
    root.querySelectorAll(".table-like").forEach(function (table) {
      try {
        if (table.parentElement && table.parentElement.closest(".table-like")) return;
        var rows = Array.prototype.filter.call(table.children, function (child) {
          return child.classList && child.classList.contains("table-row");
        });
        var header = rows.filter(function (row) { return row.classList.contains("header"); })[0];
        if (!header) return;
        var labels = Array.prototype.map.call(header.children, function (cell) {
          return String(cell.textContent || "").replace(/\s+/g, " ").trim();
        });
        if (!labels.length) return;
        table.classList.add("has-cell-labels");
        rows.forEach(function (row) {
          if (row === header) return;
          var cells = row.children;
          if (!cells.length) return;
          if (cells.length !== labels.length) {
            if (devHost && window.console) console.debug("labelTableCells: row skipped (" + cells.length + " cells, " + labels.length + " headers)", row);
            return;
          }
          Array.prototype.forEach.call(cells, function (cell, index) {
            if (labels[index]) {
              if (cell.getAttribute("data-label") !== labels[index]) cell.setAttribute("data-label", labels[index]);
            } else {
              cell.removeAttribute("data-label");
            }
          });
        });
      } catch (error) {
        if (devHost && window.console) console.debug("labelTableCells: table skipped", error);
      }
    });
    // Real <table>s (Progress): the same contract, labels from the <thead> cells.
    root.querySelectorAll("table.comparison-table").forEach(function (table) {
      try {
        var headRow = table.tHead && table.tHead.rows[0];
        if (!headRow) return;
        var labels = Array.prototype.map.call(headRow.cells, function (cell) {
          return String(cell.textContent || "").replace(/\s+/g, " ").trim();
        });
        if (!labels.length) return;
        table.classList.add("has-cell-labels");
        Array.prototype.forEach.call(table.tBodies, function (body) {
          Array.prototype.forEach.call(body.rows, function (row) {
            if (row.cells.length !== labels.length) return; // e.g. a colspan empty-state row
            Array.prototype.forEach.call(row.cells, function (cell, index) {
              if (labels[index] && cell.getAttribute("data-label") !== labels[index]) cell.setAttribute("data-label", labels[index]);
            });
          });
        });
      } catch (error) {
        if (devHost && window.console) console.debug("labelTableCells: table skipped", error);
      }
    });
  }

  // One observer covers every renderer (and pagination re-renders): label new tables once
  // per animation frame.
  (function observeTables() {
    if (typeof MutationObserver !== "function" || !app) return;
    var scheduled = false;
    new MutationObserver(function () {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(function () {
        scheduled = false;
        labelTableCells(app);
      });
    }).observe(app, { childList: true, subtree: true });
  })();

  // ---- Overlay history: Back closes the topmost overlay instead of leaving the screen ------
  // One authoritative stack. Each open overlay owns exactly one same-URL history entry
  // (re-opening or re-rendering never adds another). Back (popstate) closes the top overlay;
  // closing through the UI consumes its entry. Route changes clear the stack without
  // touching history. Stale entries (after a reload, or reached via Forward) are neutralized.
  var overlayHistory = (function () {
    var stack = [];
    var pendingBacks = 0;
    var closingFromHistory = false;
    // Overlay entries share the page URL. While they exist (or are being consumed), the
    // browser must not restore the scroll it recorded for them; e.g. the drawer's scroll lock
    // means its entry was recorded at scrollY 0. Route navigation keeps the browser default.
    var savedScrollRestoration = null;

    function holdScrollRestoration() {
      if (savedScrollRestoration !== null || !("scrollRestoration" in history)) return;
      savedScrollRestoration = history.scrollRestoration;
      try { history.scrollRestoration = "manual"; } catch (_e) { savedScrollRestoration = null; }
    }

    function releaseScrollRestoration() {
      window.setTimeout(function () {
        if (savedScrollRestoration === null || stack.length || pendingBacks > 0) return;
        try { history.scrollRestoration = savedScrollRestoration; } catch (_e) { }
        savedScrollRestoration = null;
      }, 50);
    }

    function indexOf(id) {
      for (var i = 0; i < stack.length; i += 1) if (stack[i].id === id) return i;
      return -1;
    }

    function push(id, close) {
      var existing = indexOf(id);
      if (existing !== -1) {
        stack[existing].close = close;
        return;
      }
      stack.push({ id: id, close: close });
      holdScrollRestoration();
      try { history.pushState({ aceOverlay: id, depth: stack.length }, "", window.location.href); } catch (_e) { }
    }

    /** The overlay was closed through the UI: drop it and consume its history entry. */
    function dismiss(id) {
      var index = indexOf(id);
      if (index === -1) return;
      stack.splice(index, 1);
      if (closingFromHistory) return; // Back already consumed the entry.
      pendingBacks += 1;
      holdScrollRestoration();
      try { history.back(); } catch (_e) { pendingBacks -= 1; }
    }

    /** Route change: overlays are gone with the old view; leave history alone. */
    function clear() {
      stack = [];
      releaseScrollRestoration();
    }

    /** Navigate away from an open overlay, replacing its entry (no dead Back press left). */
    function leaveTo(id, hash) {
      var index = indexOf(id);
      if (index === stack.length - 1 && index !== -1) {
        stack.pop();
        window.location.replace(window.location.pathname + window.location.search + hash);
        return true;
      }
      return false;
    }

    window.addEventListener("popstate", function (event) {
      if (pendingBacks > 0) {
        pendingBacks -= 1;
      } else if (stack.length) {
        var top = stack.pop();
        closingFromHistory = true;
        try { top.close(); } catch (_e) { } finally { closingFromHistory = false; }
      } else if (event.state && event.state.aceOverlay) {
        try { history.replaceState(null, "", window.location.href); } catch (_e) { }
      }
      releaseScrollRestoration();
    });

    // A reload drops overlays; don't let the restored entry pretend one is open.
    if (history.state && history.state.aceOverlay) {
      try { history.replaceState(null, "", window.location.href); } catch (_e) { }
    }

    return {
      push: push,
      dismiss: dismiss,
      clear: clear,
      leaveTo: leaveTo,
      has: function (id) { return indexOf(id) !== -1; },
      size: function () { return stack.length; }
    };
  })();
  window.overlayHistory = overlayHistory;

  // ---- Mobile navigation drawer (modal dialog) ----------------------------------------
  // Open: focus trap (activateModalFocus), inert + aria-hidden background, a backdrop that
  // blocks background pointers, and a body scroll lock that restores the scroll position.
  var navDrawer = { open: false, releaseFocus: null, scrollY: 0, returnFocus: null, isolated: [] };

  function isolateBackground(keepEl) {
    var isolated = [];
    var node = keepEl;
    while (node && node.parentElement && node !== document.body) {
      Array.prototype.forEach.call(node.parentElement.children, function (sibling) {
        if (sibling === node || sibling.classList.contains("mobile-drawer-backdrop")) return;
        if (sibling.tagName === "SCRIPT" || sibling.hasAttribute("inert")) return;
        sibling.setAttribute("inert", "");
        if (!sibling.hasAttribute("aria-hidden")) {
          sibling.setAttribute("aria-hidden", "true");
          sibling.setAttribute("data-drawer-aria-hidden", "true");
        }
        isolated.push(sibling);
      });
      node = node.parentElement;
    }
    return isolated;
  }

  function restoreBackground(isolated) {
    (isolated || []).forEach(function (el) {
      el.removeAttribute("inert");
      if (el.getAttribute("data-drawer-aria-hidden") === "true") {
        el.removeAttribute("aria-hidden");
        el.removeAttribute("data-drawer-aria-hidden");
      }
    });
  }

  function setDrawerToggles(expanded) {
    document.querySelectorAll(".mobile-drawer-toggle").forEach(function (button) {
      button.setAttribute("aria-expanded", expanded ? "true" : "false");
    });
  }

  function lockBodyScroll() {
    navDrawer.scrollY = window.scrollY || window.pageYOffset || 0;
    document.body.style.top = "-" + navDrawer.scrollY + "px";
    document.body.classList.add("is-scroll-locked");
  }

  function unlockBodyScroll(restoreScroll) {
    if (!document.body.classList.contains("is-scroll-locked")) return;
    document.body.classList.remove("is-scroll-locked");
    document.body.style.top = "";
    if (restoreScroll) window.scrollTo(0, navDrawer.scrollY);
  }

  function openNavDrawer(trigger) {
    var drawer = document.getElementById("mobile-nav-drawer");
    if (!drawer || navDrawer.open) return;
    navDrawer.open = true;
    navDrawer.returnFocus = trigger || document.activeElement;
    lockBodyScroll();
    var backdrop = document.createElement("div");
    backdrop.className = "mobile-drawer-backdrop";
    backdrop.addEventListener("click", function () { closeNavDrawer(); });
    drawer.parentElement.insertBefore(backdrop, drawer);
    drawer.removeAttribute("inert");
    drawer.removeAttribute("aria-hidden");
    drawer.classList.add("is-open");
    setDrawerToggles(true);
    navDrawer.isolated = isolateBackground(drawer);
    navDrawer.releaseFocus = activateModalFocus(drawer, {
      titleId: "mobile-drawer-title",
      onEscape: function () { closeNavDrawer(); },
      initialFocusEl: drawer.querySelector(".mobile-drawer-close")
    });
    if (window.overlayHistory) window.overlayHistory.push("nav-drawer", function () { closeNavDrawer({ fromHistory: true }); });
  }

  /**
   * options.restoreFocus / restoreScroll default to true; route changes pass false (the
   * page is being replaced). options.fromHistory: closing because Back was pressed.
   */
  function closeNavDrawer(options) {
    options = options || {};
    if (!navDrawer.open) return;
    navDrawer.open = false;
    var drawer = document.getElementById("mobile-nav-drawer");
    if (drawer) {
      drawer.classList.remove("is-open");
      drawer.setAttribute("aria-hidden", "true");
      drawer.setAttribute("inert", "");
    }
    document.querySelectorAll(".mobile-drawer-backdrop").forEach(function (el) { el.remove(); });
    restoreBackground(navDrawer.isolated);
    navDrawer.isolated = [];
    setDrawerToggles(false);
    if (navDrawer.releaseFocus) {
      navDrawer.releaseFocus();
      navDrawer.releaseFocus = null;
    }
    unlockBodyScroll(options.restoreScroll !== false);
    if (options.restoreFocus !== false) {
      var target = navDrawer.returnFocus && document.body.contains(navDrawer.returnFocus)
        ? navDrawer.returnFocus
        : document.querySelector(".dashboard-header .mobile-drawer-toggle");
      if (target && typeof target.focus === "function") {
        // The sticky header may be auto-hidden; don't let focus scroll the page to it.
        try { target.focus({ preventScroll: true }); } catch (_e) { }
      }
    }
    navDrawer.returnFocus = null;
    if (!options.fromHistory && !options.fromRoute && window.overlayHistory) window.overlayHistory.dismiss("nav-drawer");
  }

  /** The view is about to be re-rendered: release locks and listeners tied to the old DOM. */
  function resetNavDrawerState() {
    if (!navDrawer.open) return;
    closeNavDrawer({ restoreFocus: false, restoreScroll: false, fromRoute: true });
  }

  document.addEventListener("click", async function (e) {
    var drawerToggle = e.target && e.target.closest ? e.target.closest(".js-toggle-mobile-drawer") : null;
    if (drawerToggle) {
      e.preventDefault();
      if (navDrawer.open) closeNavDrawer();
      else openNavDrawer(drawerToggle);
      return;
    }
    var drawerNavLink = navDrawer.open && e.target && e.target.closest ? e.target.closest(".mobile-nav-drawer a[href^='#']") : null;
    if (drawerNavLink) {
      // Navigate from the drawer, replacing the drawer's history entry with the destination.
      e.preventDefault();
      closeNavDrawer({ restoreFocus: false, restoreScroll: false, fromRoute: true });
      if (!overlayHistory.leaveTo("nav-drawer", drawerNavLink.getAttribute("href"))) {
        window.location.hash = drawerNavLink.getAttribute("href");
      }
      return;
    }
    if (navDrawer.open && e.target && e.target.closest && e.target.closest(".mobile-nav-drawer .js-logout-btn")) {
      closeNavDrawer({ restoreFocus: false, restoreScroll: false });
    }
    var logoutBtn = e.target ? e.target.closest("#logout-button, .js-logout-btn") : null;
    if (logoutBtn) {
      e.preventDefault();
      if (logoutBtn.dataset.loggingOut) return;
      
      var modalHtml = '<div id="logout-confirm-modal" style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:9999; padding:24px; animation: fadeIn 0.2s ease;">' +
        '<div style="background:var(--surface); border-radius:16px; border:1px solid rgba(150,150,150,0.2); box-shadow:0 10px 15px -3px rgba(0,0,0,0.1); width:100%; max-width:384px; overflow:hidden; display:flex; flex-direction:column; color:var(--ink);">' +
          '<div style="display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; padding:32px;">' +
            '<div style="margin:0 auto; display:flex; width:48px; height:48px; align-items:center; justify-content:center; border-radius:50%; background:rgba(139, 92, 246, 0.1); color:#8b5cf6;">' +
              '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2-1 4-3 6-4 2 1 4 3 6 4a1 1 0 0 1 1 1v7z"/><path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>' +
            '</div>' +
            '<h2 style="text-align:center; font-weight:600; font-size:1rem; margin:0; margin-top:8px;">Are you sure?</h2>' +
            '<p style="text-align:center; font-weight:500; font-size:0.875rem; color:var(--ink-soft); margin:0;">You can always log in later to your account.</p>' +
          '</div>' +
          '<div style="display:grid; grid-template-columns:1fr 1fr; border-top:1px solid rgba(150,150,150,0.2);">' +
            '<button class="logout-modal-btn" id="logout-cancel-btn" style="border-right:1px solid rgba(150,150,150,0.2);">No</button>' +
            '<button class="logout-modal-btn" id="logout-confirm-btn">Yes, Logout</button>' +
          '</div>' +
        '</div>' +
      '</div>';
      
      document.body.insertAdjacentHTML('beforeend', modalHtml);
      
      document.getElementById("logout-cancel-btn").addEventListener("click", function() {
        var m = document.getElementById("logout-confirm-modal");
        if(m) m.remove();
      });
      
      document.getElementById("logout-confirm-btn").addEventListener("click", async function() {
        var m = document.getElementById("logout-confirm-modal");
        if(m) m.remove();
        
        logoutBtn.dataset.loggingOut = "true";
        logoutBtn.style.pointerEvents = "none";
        logoutBtn.style.opacity = "0.7";
        if (logoutBtn.textContent === "Logout") {
          logoutBtn.textContent = "Logging out...";
        }
        try {
          if (auth && typeof auth.logout === "function") {
            await auth.logout();
          }
        } catch (_err) { }
        stopRuntime(true);
        navigate("login");
      });
      return;
    }

    var gcalControlBtn = e.target ? e.target.closest(".js-gcal-control") : null;
    if (gcalControlBtn) {
      e.preventDefault();
      var state = runtime.googleCalendarState || {};
      if (state.status === "syncing") {
        return; // do nothing
      } else if (state.status === "connected") {
        var popover = gcalControlBtn.nextElementSibling;
        if (popover && popover.classList.contains("gcal-popover")) {
          popover.style.display = popover.style.display === "none" ? "block" : "none";
        }
      } else {
        // Assume connect flow
        runtime.googleCalendarState = { status: "syncing", autoAddEnabled: false };
        renderRoute();
        store.getCalendarConnectUrl()
          .then(function (data) {
            if (data && data.url) window.location.href = data.url;
          })
          .catch(function (err) {
            console.error(err);
            runtime.googleCalendarState = { status: "error", autoAddEnabled: false };
            renderRoute();
          });
      }
      return;
    }

    var gcalDisconnectBtn = e.target ? e.target.closest(".js-gcal-disconnect") : null;
    if (gcalDisconnectBtn) {
      e.preventDefault();
      if (window.confirm("Are you sure you want to disconnect your Google Calendar?")) {
        runtime.googleCalendarState = { status: "syncing", autoAddEnabled: false };
        renderRoute();
        store.disconnectCalendar().then(function () {
          runtime.googleCalendarState = { status: "disconnected", autoAddEnabled: false };
          renderRoute();
        }).catch(function () {
          runtime.googleCalendarState = { status: "error", autoAddEnabled: false };
          renderRoute();
        });
      }
      return;
    }

    var activePopover = document.querySelector(".gcal-popover");
    if (activePopover && activePopover.style.display === "block" && !e.target.closest(".gcal-control-container")) {
      activePopover.style.display = "none";
    }

    var plannerSyncGcalBtn = e.target ? e.target.closest(".js-planner-sync-gcal") : null;
    if (plannerSyncGcalBtn) {
      e.preventDefault();
      state = runtime.googleCalendarState || {};
      if (state.status === "connected") {
        if (!state.autoAddEnabled) {
          store.toggleCalendarAutoAdd(true).then(function () {
            runtime.googleCalendarState.autoAddEnabled = true;
            renderRoute();
            window.alert("Automatic Google Calendar sync is now enabled.");
          }).catch(function (err) {
            console.error(err);
          });
        } else {
          window.alert("Your Google Calendar is already connected and syncing automatically.");
        }
      } else {
        runtime.googleCalendarState = { status: "syncing", autoAddEnabled: false };
        renderRoute();
        store.getCalendarConnectUrl()
          .then(function (data) {
            if (data && data.url) window.location.href = data.url;
          })
          .catch(function (err) {
            console.error(err);
            runtime.googleCalendarState = { status: "error", autoAddEnabled: false };
            renderRoute();
          });
      }
      return;
    }
  });

  document.addEventListener("change", function (e) {
    var gcalAutoAdd = e.target ? e.target.closest(".js-gcal-autoadd") : null;
    if (gcalAutoAdd) {
      var enabled = gcalAutoAdd.checked;
      runtime.googleCalendarState = { status: "syncing", autoAddEnabled: runtime.googleCalendarState.autoAddEnabled };
      renderRoute();
      store.toggleCalendarAutoAdd(enabled).then(function (res) {
        runtime.googleCalendarState = { status: "connected", autoAddEnabled: res.autoAddEnabled };
        renderRoute();
      }).catch(function () {
        runtime.googleCalendarState = { status: "error", autoAddEnabled: false };
        renderRoute();
      });
    }
  });

  document.addEventListener("submit", async function (e) {
    if (e.target && e.target.id === "account-pwd-form") {
      e.preventDefault();
      var currentInput = e.target.querySelector("#pwd-current");
      var currentPwd = currentInput ? currentInput.value : "";
      var newPwd = e.target.querySelector("#pwd-new").value;

      var btn = e.target.querySelector("#pwd-submit-btn");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "Updating...";
      }

      try {
        await auth.updatePassword({ currentPassword: currentPwd, newPassword: newPwd });
        window.alert("Password updated successfully! You can now use it to log in.");
        e.target.reset();
      } catch (err) {
        var msg = (err.response && err.response.error) || err.message || "Failed to update password";
        window.alert(msg);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "Update Password";
        }
      }
    }
  });


  var KEEP_ALIVE_TIMEOUT_MS = 8000;
  var USER_ONLINE_WINDOW_MS = 3 * 60 * 1000;
  var THEME_SETTING_KEY = "theme";
  var SUPPORT_WHATSAPP_NUMBER = "919242033507";

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

  var TIME_AWARE_GREETINGS = {
    earlyMorning: "Rise & Revise.",
    morning: "Stay Sharp.",
    afternoon: "Keep The Momentum.",
    evening: "Lock In.",
    night: "Finish Strong.",
    lateNight: "One More Push."
  };

  function getDashboardGreeting() {
    var hour = new Date().getHours();
    if (hour >= 5 && hour < 9) return TIME_AWARE_GREETINGS.earlyMorning;
    if (hour >= 9 && hour < 12) return TIME_AWARE_GREETINGS.morning;
    if (hour >= 12 && hour < 17) return TIME_AWARE_GREETINGS.afternoon;
    if (hour >= 17 && hour < 20) return TIME_AWARE_GREETINGS.evening;
    if (hour >= 20) return TIME_AWARE_GREETINGS.night;
    return TIME_AWARE_GREETINGS.lateNight;
  }

  var greetingTimerId = null;
  function initSubtitleGlider() {
    var container = document.getElementById("t-think-container");
    if (!container) return;
    var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;

    var statesStr = container.getAttribute("data-states");
    if (!statesStr) return;
    var states = statesStr.split(",");

    var storedIndex = window.sessionStorage.getItem("dashboard_think_index");
    var currentIndex = storedIndex ? parseInt(storedIndex, 10) : 0;
    if (isNaN(currentIndex) || currentIndex >= states.length) {
      currentIndex = 0;
    }

    var holdMs = 2000;
    var gapMs = 50;

    if (runtime.gliderTimerId) {
      clearInterval(runtime.gliderTimerId);
    }

    var activeSpan = document.getElementById("t-think-active");
    if (activeSpan) {
      activeSpan.textContent = states[currentIndex];
      activeSpan.setAttribute("data-text", states[currentIndex]);
    }

    runtime.gliderTimerId = setInterval(function () {
      currentIndex = (currentIndex + 1) % states.length;
      window.sessionStorage.setItem("dashboard_think_index", currentIndex.toString());

      var oldSpan = document.getElementById("t-think-active");
      if (oldSpan) {
        oldSpan.removeAttribute("id");
        oldSpan.classList.add("is-exit");
        setTimeout(function () {
          if (oldSpan && oldSpan.parentNode) {
            oldSpan.parentNode.removeChild(oldSpan);
          }
        }, 300);
      }

      var newSpan = document.createElement("span");
      newSpan.className = "t-think-text is-enter-start";
      newSpan.id = "t-think-active";
      newSpan.textContent = states[currentIndex];
      newSpan.setAttribute("data-text", states[currentIndex]);
      container.appendChild(newSpan);

      void newSpan.offsetWidth;

      setTimeout(function () {
        newSpan.classList.remove("is-enter-start");
      }, gapMs);

    }, holdMs);
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
      var targetEl = root || document.body;
      if (!targetEl) return;

      if (!window.renderMathInElement) {
        if (attempt === 3) {
          // Try fallback CDN if primary load is delayed or failed
          var script = document.createElement("script");
          script.src = "https://cdn.jsdelivr.net/npm/katex@0.19.0/dist/katex.min.js";
          script.onload = function () {
            var autoScript = document.createElement("script");
            autoScript.src = "https://cdn.jsdelivr.net/npm/katex@0.19.0/dist/contrib/auto-render.min.js";
            autoScript.onload = function () {
              renderLatexInElement(targetEl, attempt + 1);
            };
            document.head.appendChild(autoScript);
          };
          document.head.appendChild(script);
        } else if (attempt < 20) {
          window.setTimeout(function () {
            renderLatexInElement(targetEl, attempt + 1);
          }, 100);
        }
        return;
      }

      window.renderMathInElement(targetEl, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "\\(", right: "\\)", display: false },
          { left: "$", right: "$", display: false },
          { left: "\\begin{equation}", right: "\\end{equation}", display: true },
          { left: "\\begin{align}", right: "\\end{align}", display: true },
          { left: "\\begin{alignat}", right: "\\end{alignat}", display: true },
          { left: "\\begin{gather}", right: "\\end{gather}", display: true },
          { left: "\\begin{CD}", right: "\\end{CD}", display: true },
          { left: "\\begin{matrix}", right: "\\end{matrix}", display: true },
          { left: "\\begin{pmatrix}", right: "\\end{pmatrix}", display: true },
          { left: "\\begin{bmatrix}", right: "\\end{bmatrix}", display: true },
          { left: "\\begin{cases}", right: "\\end{cases}", display: true }
        ],
        throwOnError: false,
        ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
      });
    } catch (_err) { }
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

  // Results/review images: a standalone lightbox (the exam's lightbox is render-driven).
  function openImageLightbox(url) {
    var safe = safeImageUrl(url);
    if (!safe) return;
    var existing = document.querySelector("[data-standalone-lightbox]");
    if (existing) existing.remove();
    var overlay = document.createElement("div");
    overlay.className = "image-lightbox";
    overlay.setAttribute("data-standalone-lightbox", "true");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Image preview");
    overlay.innerHTML =
      '<div class="image-lightbox-card">' +
      '<button type="button" class="calculator-close image-lightbox-close" aria-label="Close zoomed image">Close</button>' +
      '<img class="image-lightbox-image" src="' + safe + '" alt="Zoomed question image">' +
      '</div>';
    var returnFocus = document.activeElement;
    function close() {
      overlay.remove();
      document.removeEventListener("keydown", onKey);
      try { if (returnFocus) returnFocus.focus(); } catch (_e) { }
    }
    function onKey(event) {
      if (event.key === "Escape") close();
    }
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay || event.target.classList.contains("image-lightbox-close")) close();
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(overlay);
    overlay.querySelector(".image-lightbox-close").focus();
  }

  // Admin Studio header chip ("Saved ✓"): briefly shows the outcome of an action.
  function showSaveChip(message, stateName) {
    var chip = document.querySelector(".studio-save-chip");
    if (!chip) return;
    chip.textContent = message;
    chip.className = "studio-save-chip is-" + (stateName || "saved");
    window.clearTimeout(runtime.saveChipTimer);
    runtime.saveChipTimer = window.setTimeout(function () {
      var current = document.querySelector(".studio-save-chip");
      if (current) {
        current.textContent = "Saved ✓";
        current.className = "studio-save-chip is-saved";
      }
    }, 2600);
  }

  // The loader SVG animates with SMIL, which CSS can't pause, so reduced-motion users get
  // the static mark. The timestamp restarts the animation on every show.
  function loaderSrc(ts) {
    var reduce = false;
    try {
      reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch (_err) { }
    return reduce ? "assets/favicon-round.svg" : "assets/aceiiit_reference_exact_solid_loader.svg?t=" + ts;
  }

  function renderLoadingScreen(label) {
    var ts = Date.now();
    app.innerHTML =
      '<div class="app-loading-screen" aria-hidden="true">' +
      '<div class="app-loading-screen__content">' +
      '<img class="app-loading-screen__animation" src="' + loaderSrc(ts) + '" alt="" aria-hidden="true" />' +
      (label ? '<span class="app-loading-screen__text t-shimmer" data-text="' + escapeAttribute(label) + '" aria-live="polite">' + escapeHtml(label) + '</span>' : '') +
      '</div></div>';
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
    // Never leave a loading overlay over an error screen.
    hideOverlayLoader();
    app.innerHTML = buildShell(
      '<section class="report-layout">' +
      '<div class="report-bar">' +
      '<div class="brand-mark"><img src="assets/favicon-round.svg" alt="AceIIIT Logo" class="brand-logo" /> AceIIIT</div>' +
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
        syncAndRenderCurrentRoute({ showOverlay: true });
      });
    }
  }

  var activeRenderModalCleanup = null;

  function clearActiveRenderModal() {
    if (activeRenderModalCleanup) {
      activeRenderModalCleanup();
      activeRenderModalCleanup = null;
    }
  }

  var currentAdminModalCleanup = null;

  function activateModalFocus(modalCard, options) {
    options = options || {};
    // Where focus returns on close: an explicit opener (touch taps don't always focus the
    // button that was tapped), else whatever was focused when the dialog opened.
    var triggerEl = options.returnFocusEl || document.activeElement;

    if (!modalCard) {
      return function () { };
    }

    if (!modalCard.getAttribute("role")) {
      modalCard.setAttribute("role", "dialog");
    }
    modalCard.setAttribute("aria-modal", "true");

    if (options.titleId) {
      modalCard.setAttribute("aria-labelledby", options.titleId);
    }
    if (options.descriptionId) {
      modalCard.setAttribute("aria-describedby", options.descriptionId);
    }

    function getFocusables() {
      return Array.prototype.slice.call(
        modalCard.querySelectorAll(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter(function (el) {
        return el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement;
      });
    }

    var focusables = getFocusables();
    var initialFocus = options.initialFocusEl || (focusables.length > 0 ? focusables[0] : modalCard);
    if (initialFocus && typeof initialFocus.focus === "function") {
      try { initialFocus.focus(); } catch (_e) { }
    }

    function onKeydown(event) {
      if (event.key === "Escape" && options.onEscape) {
        event.preventDefault();
        event.stopPropagation();
        options.onEscape();
        return;
      }

      if (event.key === "Tab") {
        var current = getFocusables();
        if (current.length === 0) {
          event.preventDefault();
          return;
        }
        var first = current[0];
        var last = current[current.length - 1];

        if (event.shiftKey) {
          if (document.activeElement === first || !modalCard.contains(document.activeElement)) {
            event.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last || !modalCard.contains(document.activeElement)) {
            event.preventDefault();
            first.focus();
          }
        }
      }
    }

    window.addEventListener("keydown", onKeydown, true);

    return function deactivate() {
      window.removeEventListener("keydown", onKeydown, true);
      if (triggerEl && typeof triggerEl.focus === "function" && document.body.contains(triggerEl)) {
        try { triggerEl.focus(); } catch (_e) { }
      }
    };
  }

  function showOverlayLoader(label, options) {
    if (!document.body) {
      return;
    }

    var settings = options || {};
    var delayMs = settings.immediate ? 0 : Math.max(0, Number(settings.delayMs || 260));
    var textToShow = label || "Syncing";
    var ts = Date.now();

    var existing = document.querySelector("[data-sync-overlay='true']");
    if (existing) {
      if (existing.dataset.fadeTimer) {
        window.clearTimeout(parseInt(existing.dataset.fadeTimer));
        existing.removeAttribute("data-fade-timer");
      }
      existing.style.opacity = "1";
      document.body.classList.add("is-syncing");
      overlayLoaderVisible = true;
      if (existing) {
        var srText = existing.querySelector(".app-loading-screen__text");
        if (srText) {
          srText.textContent = textToShow;
          srText.setAttribute("data-text", textToShow);
        }
      }
      var img = existing.querySelector(".app-loading-screen__animation");
      if (img) {
        img.src = loaderSrc(ts);
      }
      return;
    }

    hideOverlayLoader();

    function mountOverlay() {
      if (!document.body) {
        return;
      }
      document.body.classList.add("is-syncing");

      var overlay = document.createElement("div");
      overlay.className = "sync-overlay";
      overlay.setAttribute("data-sync-overlay", "true");
      overlay.setAttribute("role", "status");
      overlay.setAttribute("aria-busy", "true");
      var mountTs = Date.now();
      overlay.innerHTML =
        '<div class="app-loading-screen__content">' +
        '<img class="app-loading-screen__animation" src="' + loaderSrc(mountTs) + '" alt="" aria-hidden="true" />' +
        '<span class="app-loading-screen__text t-shimmer" data-text="' + escapeAttribute(textToShow) + '">' + escapeHtml(textToShow) + '</span>' +
        '</div>';

      document.body.appendChild(overlay);
      overlayLoaderVisible = true;
    }

    if (delayMs === 0) {
      mountOverlay();
      return;
    }
    overlayLoaderTimer = window.setTimeout(function () {
      overlayLoaderTimer = 0;
      mountOverlay();
    }, delayMs);
  }

  function hideOverlayLoader() {
    if (overlayLoaderTimer) {
      window.clearTimeout(overlayLoaderTimer);
      overlayLoaderTimer = 0;
    }
    overlayLoaderVisible = false;
    document.body.classList.remove("is-syncing");
    var existing = document.querySelector("[data-sync-overlay='true']");
    if (existing) {
      existing.style.transition = "opacity 0.8s ease";
      existing.style.opacity = "0";
      existing.dataset.fadeTimer = window.setTimeout(function () {
        existing.remove();
      }, 800).toString();
    }
  }

  function hideAdminModal() {
    if (currentAdminModalCleanup) {
      currentAdminModalCleanup();
      currentAdminModalCleanup = null;
    }
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

    var titleId = "admin-modal-title-" + Math.random().toString(36).substring(2, 9);
    var overlay = document.createElement("div");
    overlay.className = "admin-modal-overlay";
    overlay.setAttribute("data-admin-modal", "true");
    overlay.innerHTML =
      '<div class="admin-modal-card' + (isLarge ? ' is-large' : '') + '" role="dialog" aria-modal="true" aria-labelledby="' + titleId + '">' +
      '<div class="admin-modal-head">' +
      '<h3 id="' + titleId + '">' + escapeHtml(title || "Details") + '</h3>' +
      '<div class="button-row">' +
      '<button class="button button-secondary button-compact" type="button" data-admin-modal-close="true" aria-label="Close dialog">Close</button>' +
      '</div>' +
      '</div>' +
      '<div class="admin-modal-body">' + String(bodyHtml || "") + '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    var card = overlay.querySelector(".admin-modal-card");
    currentAdminModalCleanup = activateModalFocus(card, {
      onEscape: hideAdminModal
    });

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

  // Callers concatenate the result straight into src="..." attributes, so characters that
  // could end the attribute or open a tag are percent-encoded (still a valid URL).
  function safeImageUrl(value) {
    return normalizeImageUrl(value).replace(/["'<>`]/g, function (ch) {
      return "%" + ch.charCodeAt(0).toString(16).toUpperCase();
    });
  }

  function normalizeImageUrl(value) {
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
      } catch (error) { }
    }
    normalized = normalized.replace(/\s+/g, "");
    if (/^\/\//.test(normalized)) {
      normalized = "https:" + normalized;
    }
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
    if (attempt && attempt.serverDeadlines && store.isAttemptPastDeadline) {
      return store.isAttemptPastDeadline(attempt);
    }
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
        return '<button type="button" class="question-figure-button" data-open-image="' + escapeAttribute(imageUrl) + '" aria-label="Open question image ' + (index + 1) + '"><img class="question-figure" loading="lazy" decoding="async" src="' + safeImageUrl(imageUrl) + '" alt="Figure ' + (index + 1) + '"></button>';
      }).join("") +
      '</div>'
    );
  }

  function getImageLightboxMarkup() {
    if (!runtime.imageLightboxUrl) {
      return "";
    }

    return (
      '<div class="image-lightbox" data-close-image-lightbox role="dialog" aria-modal="true" aria-label="Image Preview">' +
      '<div class="image-lightbox-card">' +
      '<button type="button" class="calculator-close image-lightbox-close" data-close-image-lightbox aria-label="Close zoomed image">Close</button>' +
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
        } catch (_err) { }
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
        cancelledAt: reminder.cancelledAt,
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
    if (!("Notification" in window) || Notification.permission !== "granted" || localStorage.getItem("planner_alerts_enabled") !== "true") {
      events = []; // Clear existing timers if disabled
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
        } catch (_err) { }
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
    var quickAction = (options.showQuickStart && event.status !== "completed")
      ? '<button class="button button-secondary button-compact js-start-planned-mock" data-test="' + escapeAttribute(event.mockId) + '" data-event="' + escapeAttribute(event.id) + '">Start Test</button>'
      : "";
    var planDate = new Date(event.plannedAt || 0);
    var endDate = new Date(planDate.getTime() + (event.duration || 180) * 60 * 1000);
    var formatGCalDate = function (d) { return d.toISOString().replace(/-|:|\.\d\d\d/g, ""); };
    var origin = window.location.origin || "http://localhost:10000";
    var testLink = event.mockId ? origin + "/#instructions/" + event.mockId : origin + "/#dashboard";
    var detailsText = "Subject Focus: " + (event.subjectFocus && event.subjectFocus.length ? event.subjectFocus.join(", ") : "") + "\n\nNotes: " + (event.notes || "") + "\n\nLink: " + testLink;
    var gCalUrl = "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + encodeURIComponent(title) + "&dates=" + formatGCalDate(planDate) + "/" + formatGCalDate(endDate) + "&details=" + encodeURIComponent(detailsText) + "&location=" + encodeURIComponent(testLink);

    var todayDateValue = toDateInputValue(new Date());
    var emailStatusHtml = '';
    if (event.cancelledAt) {
      emailStatusHtml = '<span style="color: var(--error); font-size: 0.8rem; margin-left: 8px;">Cancelled</span>';
    } else if (event.failureReason) {
      emailStatusHtml = '<span style="color: var(--error); font-size: 0.8rem; margin-left: 8px;">Invitation Failed</span>';
    } else if (event.sentAt) {
      emailStatusHtml = '<span style="color: var(--success); font-size: 0.8rem; margin-left: 8px;">Invitation Sent</span>';
    } else {
      emailStatusHtml = '<span style="color: var(--ink-soft); font-size: 0.8rem; margin-left: 8px;">Pending Invitation...</span>';
    }

    var actionsHtml = "";
    if (event.status !== "completed") {
      actionsHtml = (event.date >= todayDateValue && !event.cancelledAt)
        ? '<button class="button button-secondary button-compact js-edit-reminder" data-id="' + escapeAttribute(event.id) + '">Edit</button>' +
        '<button class="button button-secondary button-compact js-delete-reminder" data-id="' + escapeAttribute(event.id) + '">Delete</button>'
        : '';
    }

    var extraActions = options.showManageActions ? actionsHtml : "";
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
        ? '<div class="planner-event-list planner-list-scroll">' + events.map(function (event) {
          return renderPlannerEventCard(event, { showQuickStart: true });
        }).join("") + '</div>'
        : '<div class="empty-state planner-empty">' + escapeHtml(emptyText) + '</div>') +
      '</div>'
    );
  }

  function rerenderAdminPreserveScroll(user, selectedTestId) {
    var scrollY = window.scrollY || window.pageYOffset || 0;
    var containerScrolls = [];
    document.querySelectorAll(".list-scroll-card, .studio-nav-grid, .question-bank, .admin-modal-body, .question-editor-body").forEach(function (el) {
      if (el.scrollTop > 0) {
        containerScrolls.push({ element: el, scrollTop: el.scrollTop, className: el.className });
      }
    });
    var active = document.activeElement;
    var activeId = active && active.id ? active.id : null;
    var selectionStart = active && typeof active.selectionStart === "number" ? active.selectionStart : null;
    var selectionEnd = active && typeof active.selectionEnd === "number" ? active.selectionEnd : null;

    renderAdmin(user, selectedTestId);

    window.requestAnimationFrame(function () {
      window.scrollTo(0, scrollY);
      containerScrolls.forEach(function (item) {
        if (item.className) {
          var targetClass = String(item.className).split(" ")[0];
          var newEl = document.querySelector("." + targetClass);
          if (newEl) newEl.scrollTop = item.scrollTop;
        }
      });
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
      try { URL.revokeObjectURL(url); } catch (_err) { }
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
          return '<div class="upload-img-chip-wrap" style="position:relative; display:inline-block; margin:6px;">' +
            '<img class="question-figure" src="' + escapeAttribute(url) + '" alt="Selected image ' + (index + 1) + '" style="max-height:80px; border-radius:6px; display:block;">' +
            '<button type="button" class="js-remove-pending-file-btn" data-index="' + index + '" title="Remove selected image" style="position:absolute; top:-6px; right:-6px; background:#e11d48; color:#fff; border:none; border-radius:50%; width:22px; height:22px; font-size:12px; font-weight:bold; cursor:pointer; display:flex; align-items:center; justify-content:center; box-shadow:0 2px 6px rgba(0,0,0,0.3); z-index:5;">✕</button>' +
            '</div>';
        }).join("")
        : "";
    }
    var uploadedStatus = document.getElementById("question-uploaded-status");
    if (uploadedStatus) {
      uploadedStatus.textContent = runtime.pendingUploadedQuestionImageUrls.length
        ? (runtime.pendingUploadedQuestionImageUrls.length + " image(s) attached to question")
        : "Uploaded images will appear here after Cloudinary upload";
    }
    var uploadedPreview = document.getElementById("question-uploaded-preview");
    if (uploadedPreview) {
      uploadedPreview.innerHTML = runtime.pendingUploadedQuestionImageUrls.length
        ? runtime.pendingUploadedQuestionImageUrls.map(function (url, index) {
          return '<div class="upload-img-chip-wrap" style="position:relative; display:inline-block; margin:6px; vertical-align:top; text-align:center;">' +
            '<button type="button" class="question-figure-button" data-open-image="' + escapeAttribute(url) + '" style="padding:0; border:none; background:none; cursor:pointer; display:block;">' +
            '<img class="question-figure" src="' + escapeAttribute(url) + '" alt="Uploaded image ' + (index + 1) + '" style="max-height:90px; border-radius:6px; display:block; border:1px solid rgba(0,0,0,0.15);">' +
            '</button>' +
            '<button type="button" class="js-remove-uploaded-url-btn" data-url="' + escapeAttribute(url) + '" title="Delete this image from question" style="position:absolute; top:-6px; right:-6px; background:#e11d48; color:#fff; border:none; border-radius:50%; width:22px; height:22px; font-size:12px; font-weight:bold; cursor:pointer; display:flex; align-items:center; justify-content:center; box-shadow:0 2px 6px rgba(0,0,0,0.3); z-index:5;">✕</button>' +
            '<button type="button" class="button button-compact button-secondary js-remove-uploaded-url-btn" data-url="' + escapeAttribute(url) + '" style="display:block; margin-top:4px; font-size:0.75rem; padding:3px 8px; color:#e11d48; border-color:#fca5a5; background:#fff2f2; width:100%;">🗑 Delete</button>' +
            '</div>';
        }).join("")
        : "";
    }
    var uploadButton = document.getElementById("upload-question-images");
    if (uploadButton) {
      uploadButton.disabled = !runtime.pendingQuestionFiles.length;
    }

    var imageUrlsTextarea = document.getElementById("question-image-urls");
    if (imageUrlsTextarea && runtime.pendingUploadedQuestionImageUrls.length) {
      imageUrlsTextarea.value = runtime.pendingUploadedQuestionImageUrls.join("\n");
    }

    document.querySelectorAll(".js-remove-pending-file-btn").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var idx = parseInt(btn.getAttribute("data-index"), 10);
        if (!isNaN(idx) && idx >= 0) {
          runtime.pendingQuestionFiles.splice(idx, 1);
          if (runtime.pendingQuestionFileNames) runtime.pendingQuestionFileNames.splice(idx, 1);
          if (runtime.pendingQuestionFilePreviews && runtime.pendingQuestionFilePreviews[idx]) {
            try { URL.revokeObjectURL(runtime.pendingQuestionFilePreviews[idx]); } catch (_e) { }
            runtime.pendingQuestionFilePreviews.splice(idx, 1);
          }
          renderQuestionUploadUi();
        }
      });
    });

    document.querySelectorAll(".js-remove-uploaded-url-btn").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var targetUrl = btn.getAttribute("data-url");
        if (targetUrl) {
          runtime.pendingUploadedQuestionImageUrls = (runtime.pendingUploadedQuestionImageUrls || []).filter(function (u) {
            return u !== targetUrl;
          });
          if (imageUrlsTextarea) {
            imageUrlsTextarea.value = runtime.pendingUploadedQuestionImageUrls.join("\n");
          }
          renderQuestionUploadUi();
        }
      });
    });
  }

  function resetPendingQuestionUploads() {
    runtime.pendingQuestionFileNames = [];
    runtime.pendingQuestionFiles = [];
    runtime.pendingUploadedQuestionImageUrls = [];
    runtime.questionUploadContext = "";
    runtime.pendingQuestionFilePreviews.forEach(function (url) {
      try { URL.revokeObjectURL(url); } catch (_err) { }
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

  function getSectionTransitionMarkup() {
    if (!runtime.pendingSectionTransition) {
      return "";
    }

    var canReview = !!runtime.pendingSectionTransition.canReview;
    var transitionTitleId = "transition-title-" + Math.random().toString(36).substring(2, 9);
    return (
      '<div class="transition-modal" role="dialog" aria-modal="true" aria-labelledby="' + transitionTitleId + '">' +
      '<div class="transition-card">' +
      '<p class="section-label">Section Complete</p>' +
      '<h3 id="' + transitionTitleId + '">' + escapeHtml(runtime.pendingSectionTransition.title) + '</h3>' +
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

    var instrTitleId = "instructions-title-" + Math.random().toString(36).substring(2, 9);
    return (
      '<div class="transition-modal instructions-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="' + instrTitleId + '">' +
      '<div class="transition-card instructions-popup-card">' +
      '<div class="calculator-header">' +
      '<strong id="' + instrTitleId + '">Instructions</strong>' +
      '<button type="button" class="calculator-close" data-close-instructions aria-label="Close instructions">Close</button>' +
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

  // Remaining seconds come from the server deadlines, measured on a monotonic server clock
  // (store.serverNow), so changing the device clock doesn't change the timer.
  function getSectionTimeLeft(attempt, sectionKey) {
    if (!attempt) {
      return 0;
    }
    var deadlines = attempt.serverDeadlines;
    if (deadlines) {
      var nowMs = store.serverNow ? store.serverNow() : Date.now();
      if (sectionKey === "REAP") {
        if (!deadlines.REAP) {
          return Math.round(Number((attempt.serverDurations && attempt.serverDurations.REAP) || 0) / 1000);
        }
        return Math.floor((deadlines.REAP - nowMs) / 1000);
      }
      return Math.floor((deadlines.SUPR - nowMs) / 1000);
    }
    if (!attempt.sectionTimers || !attempt.sectionTimers[sectionKey]) {
      return 0;
    }
    var timer = attempt.sectionTimers[sectionKey];
    if (!timer.startedAt) {
      return timer.durationMinutes * 60;
    }
    var elapsed = Math.floor((Date.now() - new Date(timer.startedAt).getTime()) / 1000);
    return timer.durationMinutes * 60 - elapsed;
  }

  // Access is decided by the server (entitlement per season) and shipped as `accessible`.
  // Tests without the flag (admin views, practice papers) are treated as accessible.
  function isTestLocked(test, user) {
    if (!test) return false;
    if (auth.isAdmin(user) || test.isFree || test.isPractice) return false;
    return test.accessible === false;
  }

  function describeQotdResult(result) {
    if (!result) return "";
    return result.correct
      ? "Correct! Well done."
      : "Incorrect. The right answer was Option " + String.fromCharCode(65 + Number(result.correctOption)) + ".";
  }

  function describeAutosave(saveState) {
    var status = saveState && saveState.status ? saveState.status : "saved";
    if (status === "saving" || status === "pending") return "Saving…";
    if (status === "offline") return "Offline: answers kept on this device, retrying";
    if (status === "retrying") return "Save failed: retrying";
    if (status === "signed-out") return "Signed out: log in again to keep saving";
    if (status === "elsewhere") return "Open in another window";
    if (status === "closed") return "Time over";
    return "Saved to server ✓";
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
        } catch (_err) { }
      }
    }, KEEP_ALIVE_TIMEOUT_MS);

    Promise.resolve(store.touchPresence ? store.touchPresence() : fetch("/api/auth/me", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      signal: controller ? controller.signal : undefined,
    }))
      .catch(function () { })
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

  // Starts or resumes the server exam session for a test. An exam open in another
  // tab/device is moved here only after explicit confirmation (takeover); an attempt
  // whose server deadline already passed shows its server-finalized result instead.
  async function launchExam(user, testId) {
    var local = store.getInProgressAttempt(user.id, testId);
    if (local && isAttemptExpired(local, store.getTestById(testId))) {
      window.alert("Time is over for this attempt. Your saved answers were submitted automatically.");
      var finalized = await store.resolveExpiredAttempt(local.id).catch(function () { return null; });
      navigate(finalized ? "results/" + finalized.id : "dashboard");
      return null;
    }
    showOverlayLoader("Preparing your exam.");
    try {
      var attempt;
      try {
        attempt = await store.startExam(testId);
      } catch (error) {
        if (!(error && error.code === "EXAM_ACTIVE_ELSEWHERE" && error.sessionId)) {
          throw error;
        }
        hideOverlayLoader();
        var proceed = window.confirm("This exam is already open in another tab or device.\n\nContinue here? The other window will stop saving answers. Your timer and saved answers carry over.");
        if (!proceed) {
          return null;
        }
        showOverlayLoader("Moving your exam to this window.");
        attempt = await store.takeoverExam(error.sessionId);
      }
      navigate("test/" + attempt.id);
      return attempt;
    } catch (error) {
      window.alert(error && error.message ? error.message : "Could not start this exam. Please try again.");
      return null;
    } finally {
      hideOverlayLoader();
    }
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
    runtime.lastWarnedViolations = 0;
    if (runtime.examKeyHandler) {
      document.removeEventListener("keydown", runtime.examKeyHandler);
      runtime.examKeyHandler = null;
    }
    if (window.AceIIIT.examIntegrity) {
      window.AceIIIT.examIntegrity.stop();
    }
    var leftoverNotice = document.getElementById("integrity-notice");
    if (leftoverNotice && leftoverNotice.parentNode) {
      leftoverNotice.parentNode.removeChild(leftoverNotice);
    }
  }

  function integrityModeOf(source) {
    return source && source.integrity && source.integrity.mode ? source.integrity.mode : "warn";
  }

  // Non-blocking notice when the server records an integrity signal. The count comes from
  // the server; strict-mode auto-submit is decided there too.
  function showIntegrityNotice(integrity) {
    if (!integrity || integrity.mode === "record") return;
    var violations = Number(integrity.violations || 0);
    if (violations < Number(integrity.warnThreshold || 1) || violations <= Number(runtime.lastWarnedViolations || 0)) return;
    runtime.lastWarnedViolations = violations;
    var limitText = integrity.mode === "strict"
      ? "Recorded " + violations + " of " + integrity.autoSubmitThreshold + " allowed. Going over the limit submits your paper automatically."
      : "Recorded " + violations + (violations === 1 ? " time" : " times") + ". These records are shown to the exam administrator.";
    var existing = document.getElementById("integrity-notice");
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    var notice = document.createElement("div");
    notice.id = "integrity-notice";
    notice.className = "integrity-notice";
    notice.setAttribute("role", "alert");
    notice.setAttribute("data-integrity-exempt", "true");
    notice.innerHTML =
      '<strong>Exam integrity notice</strong>' +
      '<p>Leaving the exam window, copying, pasting or using blocked shortcuts is recorded. ' + escapeHtml(limitText) + '</p>' +
      '<button type="button" class="button button-primary button-compact" id="integrity-notice-ok">OK, continue</button>';
    document.body.appendChild(notice);
    var ok = document.getElementById("integrity-notice-ok");
    if (ok) {
      ok.addEventListener("click", function () {
        if (notice.parentNode) notice.parentNode.removeChild(notice);
      });
      try { ok.focus(); } catch (_e) { }
    }
  }

  function startIntegrityMonitor(user, attempt) {
    if (!window.AceIIIT.examIntegrity || !attempt || !attempt.sessionId) return;
    var mode = integrityModeOf(attempt);
    window.AceIIIT.examIntegrity.start({
      sessionId: attempt.sessionId,
      fullscreen: mode !== "record",
      watermark: String(user.email || user.name || "") + " · " + String(attempt.sessionId).slice(-6) + " · " +
        new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" }),
      send: function (events) {
        return store.sendIntegrityEvents(attempt.sessionId, events);
      },
      onUpdate: function (response) {
        if (response && response.integrity) showIntegrityNotice(response.integrity);
      },
      onSecondTab: function () {
        showIntegrityNotice({ mode: mode === "record" ? "warn" : mode, violations: Number(runtime.lastWarnedViolations || 0) + 1, warnThreshold: 1, autoSubmitThreshold: (attempt.integrity && attempt.integrity.autoSubmitThreshold) || 5 });
      },
    });
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
    var footerText = options.footerText || "AceIIIT MockTest Portal";
    var footerClass = options.footerClass || "app-footer";
    var footerHtml = options.hideFooter
      ? ""
      : ('<div class="' + footerClass + '">' + escapeHtml(footerText) +
        ' · <a href="/privacy.html" target="_blank" rel="noopener">Privacy</a>' +
        ' · <a href="/terms.html" target="_blank" rel="noopener">Terms</a>' +
        ' · <a href="mailto:support@aceiiit.com">Support</a></div>');
    var supportChatHref = "https://wa.me/" + encodeURIComponent(SUPPORT_WHATSAPP_NUMBER) + "?text=" + encodeURIComponent("Hi AceIIIT, I need help with the portal.");
    var currentUser = auth.getCurrentUser ? auth.getCurrentUser() : (store.getCurrentUser ? store.getCurrentUser() : null);
    var supportChatHtml = options.hideSupportChat || !currentUser
      ? ""
      : (
        '<a class="support-chat-button" href="' + escapeAttribute(supportChatHref) + '" target="_blank" rel="noreferrer" aria-label="Chat on WhatsApp for support" title="WhatsApp support">' +
        '<span class="support-chat-icon" aria-hidden="true"><img src="assets/favicon-current.jpeg" alt=""></span>' +
        '<span class="support-chat-copy"><strong>Need help?</strong><small>Chat on WhatsApp</small></span>' +
        '</a>'
      );
    if (options.fluid) {
      shellClass += " is-fluid";
    }
    return (
      '<main class="' + shellClass + '">' +
      content +
      footerHtml +
      supportChatHtml +
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

    var calcTitleId = "calculator-title-" + Math.random().toString(36).substring(2, 9);
    return (
      '<div class="calculator-popout">' +
      '<div class="calculator-modal calculator-modal-inline" role="dialog" aria-modal="true" aria-labelledby="' + calcTitleId + '">' +
      '<div class="calculator-header">' +
      '<strong id="' + calcTitleId + '">Calculator</strong>' +
      '<button type="button" class="calculator-close" data-calc-action="close" aria-label="Close calculator">Close</button>' +
      '</div>' +
      '<div class="calculator-display" data-calculator-display aria-label="Calculator display">' + escapeHtml(runtime.calculatorExpression || "0") + '</div>' +
      '<div class="calculator-grid">' +
      keys.map(function (key) {
        var wide = key === "=" ? " calculator-key-wide" : "";
        return '<button type="button" class="calculator-key' + wide + '" data-calc-key="' + escapeHtml(key) + '" aria-label="Key ' + escapeAttribute(key) + '">' + escapeHtml(key) + '</button>';
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

  var typewriterTimerId = null;

  function renderLogin(activeMode, routeParams) {
    if (typewriterTimerId) {
      clearTimeout(typewriterTimerId);
      typewriterTimerId = null;
    }

    activeMode = activeMode || "login";
    routeParams = routeParams || {};

    if (routeParams.token) {
      if (activeMode === "activate") activeMode = "complete-activation";
      if (activeMode === "reset-password") activeMode = "complete-reset";
    }

    app.innerHTML = buildShell(
      '<div class="aceiiit-login-viewport">' +

      '<!-- Left Side: Authentication Form -->' +
      '<div class="aceiiit-form-side">' +
      '<div class="aceiiit-form-container">' +
      '<div class="aceiiit-brand-header">' +
      '<img src="assets/favicon-round.svg" alt="AceIIIT Logo" class="brand-logo" />' +
      '<span>ACEIIIT</span>' +
      '</div>' +

      '<!-- Mode Headers -->' +
      '<div id="auth-header-login" class="auth-header-group">' +
      '<h1 class="aceiiit-form-title">Log in</h1>' +
      '<p class="aceiiit-form-subtitle">Access your ACEIIIT mock portal, tests, and analytics.</p>' +
      '</div>' +
      '<div id="auth-header-activate" class="auth-header-group u-hidden">' +
      '<h1 class="aceiiit-form-title">Create your account</h1>' +
      '<p class="aceiiit-form-subtitle">Create an ACEIIIT account to access mock tests, practice papers, and performance analytics.</p>' +
      '</div>' +
      '<div id="auth-header-forgot" class="auth-header-group u-hidden">' +
      '<h1 class="aceiiit-form-title">Reset Password</h1>' +
      '<p class="aceiiit-form-subtitle">Enter your registered email address to receive password reset instructions.</p>' +
      '</div>' +
      '<div id="auth-header-complete-activation" class="auth-header-group u-hidden">' +
      '<h1 class="aceiiit-form-title">Set Password</h1>' +
      '<p class="aceiiit-form-subtitle">Set up a strong password to complete your account activation.</p>' +
      '</div>' +
      '<div id="auth-header-complete-reset" class="auth-header-group u-hidden">' +
      '<h1 class="aceiiit-form-title">New Password</h1>' +
      '<p class="aceiiit-form-subtitle">Enter a new password for your account.</p>' +
      '</div>' +

      '<!-- 1. Normal Login Form (Email + Password) -->' +
      '<form id="login-form" class="auth-form-body-v2">' +
      '<div class="field-v2">' +
      '<label for="login-email" class="aceiiit-field-label">Email Address</label>' +
      '<input id="login-email" name="email" type="email" class="aceiiit-input-field" placeholder="Enter your email address" required autocomplete="email">' +
      '</div>' +
      '<div class="field-v2 u-mt-md">' +
      '<label for="login-password" class="aceiiit-field-label">Password</label>' +
      '<div class="aceiiit-password-wrap">' +
      '<input id="login-password" name="password" type="password" class="aceiiit-input-field" placeholder="Enter your password" required autocomplete="current-password">' +
      '<button type="button" class="aceiiit-password-toggle" data-for="login-password" aria-label="Toggle password visibility">Show</button>' +
      '</div>' +
      '</div>' +

      '<div class="aceiiit-form-row u-mt-md">' +
      '<label class="aceiiit-checkbox-label">' +
      '<input type="checkbox" id="remember-me-login" checked>' +
      '<span>Remember me</span>' +
      '</label>' +
      '<button type="button" class="aceiiit-link" data-auth-switch="forgot-password">Forgot password?</button>' +
      '</div>' +

      '<div class="auth-actions-v2 u-mt-md">' +
      '<button class="aceiiit-btn-primary" type="submit" id="login-submit-btn">LOG IN</button>' +
      '</div>' +
      '</form>' +

      '<!-- 2. Account Registration Request Form -->' +
      '<form id="activate-request-form" class="auth-form-body-v2 u-hidden">' +
      '<div class="field-v2">' +
      '<label for="activate-email" class="aceiiit-field-label">Email Address</label>' +
      '<input id="activate-email" name="email" type="email" class="aceiiit-input-field" placeholder="Enter your email address" required autocomplete="email">' +
      '</div>' +

      '<div class="auth-actions-v2 u-mt-lg">' +
      '<button class="aceiiit-btn-primary" type="submit" id="activate-send-btn">CREATE ACCOUNT</button>' +
      '</div>' +
      '</form>' +

      '<!-- 3. Forgot Password Request Form -->' +
      '<form id="forgot-password-form" class="auth-form-body-v2 u-hidden">' +
      '<div class="field-v2">' +
      '<label for="forgot-email" class="aceiiit-field-label">Account Email Address</label>' +
      '<input id="forgot-email" name="email" type="email" class="aceiiit-input-field" placeholder="Enter your registered email" required autocomplete="email">' +
      '</div>' +

      '<div class="auth-actions-v2 u-mt-lg">' +
      '<button class="aceiiit-btn-primary" type="submit" id="forgot-send-btn">Send Reset Link</button>' +
      '</div>' +
      '</form>' +

      '<!-- 4. Complete Activation Form -->' +
      '<form id="complete-activation-form" class="auth-form-body-v2 u-hidden">' +
      '<input type="hidden" id="complete-activation-token" name="token">' +
      '<div class="field-v2">' +
      '<label for="complete-activation-name" class="aceiiit-field-label">Full Name <small class="u-text-muted">(optional)</small></label>' +
      '<input id="complete-activation-name" name="name" type="text" class="aceiiit-input-field" placeholder="Enter your full name">' +
      '</div>' +
      '<div class="field-v2 u-mt-md">' +
      '<label for="complete-activation-pass" class="aceiiit-field-label">New Password (min 8 chars)</label>' +
      '<div class="aceiiit-password-wrap">' +
      '<input id="complete-activation-pass" name="password" type="password" class="aceiiit-input-field" placeholder="Create a strong password" minlength="8" required autocomplete="new-password">' +
      '<button type="button" class="aceiiit-password-toggle" data-for="complete-activation-pass" aria-label="Toggle password visibility">Show</button>' +
      '</div>' +
      '</div>' +
      '<div class="field-v2 u-mt-md">' +
      '<label for="complete-activation-confirm" class="aceiiit-field-label">Confirm Password</label>' +
      '<div class="aceiiit-password-wrap">' +
      '<input id="complete-activation-confirm" name="confirmPassword" type="password" class="aceiiit-input-field" placeholder="Re-enter password" minlength="8" required autocomplete="new-password">' +
      '<button type="button" class="aceiiit-password-toggle" data-for="complete-activation-confirm" aria-label="Toggle password visibility">Show</button>' +
      '</div>' +
      '</div>' +

      '<div class="auth-actions-v2 u-mt-lg">' +
      '<button class="aceiiit-btn-primary" type="submit" id="complete-activation-btn">Activate Account & Log In</button>' +
      '</div>' +
      '</form>' +

      '<!-- 5. Complete Password Reset Form -->' +
      '<form id="complete-reset-form" class="auth-form-body-v2 u-hidden">' +
      '<input type="hidden" id="complete-reset-token" name="token">' +
      '<div class="field-v2">' +
      '<label for="complete-reset-pass" class="aceiiit-field-label">New Password (min 8 chars)</label>' +
      '<div class="aceiiit-password-wrap">' +
      '<input id="complete-reset-pass" name="password" type="password" class="aceiiit-input-field" placeholder="Enter new password" minlength="8" required autocomplete="new-password">' +
      '<button type="button" class="aceiiit-password-toggle" data-for="complete-reset-pass" aria-label="Toggle password visibility">Show</button>' +
      '</div>' +
      '</div>' +
      '<div class="field-v2 u-mt-md">' +
      '<label for="complete-reset-confirm" class="aceiiit-field-label">Confirm New Password</label>' +
      '<div class="aceiiit-password-wrap">' +
      '<input id="complete-reset-confirm" name="confirmPassword" type="password" class="aceiiit-input-field" placeholder="Re-enter new password" minlength="8" required autocomplete="new-password">' +
      '<button type="button" class="aceiiit-password-toggle" data-for="complete-reset-confirm" aria-label="Toggle password visibility">Show</button>' +
      '</div>' +
      '</div>' +

      '<div class="auth-actions-v2 u-mt-lg">' +
      '<button class="aceiiit-btn-primary" type="submit" id="complete-reset-btn">Save New Password & Log In</button>' +
      '</div>' +
      '</form>' +

      '<div id="auth-feedback" class="portal-feedback-banner is-error u-hidden u-mt-md" role="alert"></div>' +

      '<div class="auth-divider-v2" style="margin:20px 0 14px 0;">' +
      '<span>or continue with</span>' +
      '</div>' +

      '<!-- Social Buttons -->' +
      '<div class="auth-social-row-v2 u-flex-center u-gap-md">' +
      '<button type="button" class="auth-social-card-btn u-flex-1" id="social-google-btn" style="position: relative; overflow: hidden; display: inline-flex; align-items: center; justify-content: center;">' +
      '<svg class="social-icon" width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"/></svg>' +
      '<span>Google</span>' +
      '<div id="google-signin-container" style="position: absolute; inset: 0; opacity: 0.001; pointer-events: auto; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; overflow: hidden; cursor: pointer;"></div>' +
      '</button>' +
      '<button type="button" class="auth-social-card-btn u-flex-1" id="social-apple-btn">' +
      '<svg class="social-icon" width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.35c.66-.8 1.11-1.92.99-3.04-.96.04-2.13.64-2.82 1.44-.61.71-1.15 1.86-.99 2.96 1.08.08 2.17-.55 2.82-1.36z"/></svg>' +
      '<span>Apple</span>' +
      '</button>' +
      '</div>' +

      '<div class="auth-footer-v2 u-mt-md">' +
      '<p id="auth-toggle-prompt"></p>' +
      '</div>' +
      '</div>' +
      '</div>' +

      '<!-- Right Side: Editorial Poster -->' +
      '<div class="aceiiit-editorial-side">' +
      '<div class="aceiiit-editorial-inner">' +
      '<div>' +
      '<div class="aceiiit-editorial-top">' +
      '<div style="display:flex; align-items:center; gap:8px;">' +
      '<img src="assets/favicon-round.svg" alt="AceIIIT Logo" class="brand-logo" />' +
      '<strong>ACEIIIT</strong>' +
      '</div>' +
      '<div style="display:flex; align-items:center; gap:12px;">' +
      '<span>UGEE Pattern Portal</span>' +
      getThemeToggleMarkup() +
      '</div>' +
      '</div>' +

      '<div class="aceiiit-typewriter-container">' +
      '<div class="aceiiit-eyebrow">ACEIIIT TEST SYSTEM</div>' +
      '<h2 class="aceiiit-headline-editorial" id="typewriter-headline"></h2>' +
      '<p class="aceiiit-editorial-subtext">Timed sectional workflow, locked paper flow, detailed analytics in one platform.</p>' +
      '</div>' +
      '</div>' +

      '<div class="aceiiit-bottom-logo-showcase">' +
      '<div class="aceiiit-logo-bg-aura" aria-hidden="true">' +
      '<div class="aura-glow-orb"></div>' +
      '<div class="aura-ring-pulse ring-a"></div>' +
      '<div class="aura-ring-pulse ring-b"></div>' +
      '</div>' +
      '<div class="aceiiit-logo-hero-content">' +
      '<div class="aceiiit-logo-hero-img-wrap">' +
      '<img src="assets/favicon-round.svg" alt="ACEIIIT Emblem" class="aceiiit-logo-hero-img" onerror="this.onerror=null; this.src=\'assets/favicon-current.jpeg\';">' +
      '</div>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '</div>' +

      '</div>',
      { hideFooter: true, fluid: true }
    );

    var currentMode = activeMode;
    var loginForm = document.getElementById("login-form");
    var activateReqForm = document.getElementById("activate-request-form");
    var forgotForm = document.getElementById("forgot-password-form");
    var completeActivationForm = document.getElementById("complete-activation-form");
    var completeResetForm = document.getElementById("complete-reset-form");
    var feedback = document.getElementById("auth-feedback");
    var togglePrompt = document.getElementById("auth-toggle-prompt");

    // The inactive headers/forms start with .u-hidden (display:none !important), so an inline
    // display alone can never reveal them: toggle the class as well.
    function setShown(el, display) {
      if (!el) return;
      el.classList.toggle("u-hidden", !display);
      el.style.display = display || "none";
    }

    function showMode(mode) {
      currentMode = mode;
      feedback.style.display = "none";

      document.querySelectorAll(".auth-header-group").forEach(function (h) { setShown(h, ""); });

      setShown(loginForm, "");
      setShown(activateReqForm, "");
      setShown(forgotForm, "");
      setShown(completeActivationForm, "");
      setShown(completeResetForm, "");

      if (mode === "activate") {
        setShown(document.getElementById("auth-header-activate"), "block");
        setShown(activateReqForm, "flex");
        togglePrompt.innerHTML = 'Already have an account? <button type="button" class="aceiiit-link" data-auth-switch="login">Sign in</button>';
      } else if (mode === "forgot-password") {
        setShown(document.getElementById("auth-header-forgot"), "block");
        setShown(forgotForm, "flex");
        togglePrompt.innerHTML = 'Remembered your password? <button type="button" class="aceiiit-link" data-auth-switch="login">Sign in</button>';
      } else if (mode === "complete-activation") {
        setShown(document.getElementById("auth-header-complete-activation"), "block");
        setShown(completeActivationForm, "flex");
        togglePrompt.innerHTML = 'Want to log in with an existing password? <button type="button" class="aceiiit-link" data-auth-switch="login">Sign in</button>';
      } else if (mode === "complete-reset") {
        setShown(document.getElementById("auth-header-complete-reset"), "block");
        setShown(completeResetForm, "flex");
        togglePrompt.innerHTML = 'Want to log in? <button type="button" class="aceiiit-link" data-auth-switch="login">Sign in</button>';
      } else {
        setShown(document.getElementById("auth-header-login"), "block");
        setShown(loginForm, "flex");
        togglePrompt.innerHTML = 'First time here? <button type="button" class="aceiiit-link" data-auth-switch="activate">Create account</button>';
      }

      app.querySelectorAll("[data-auth-switch]").forEach(function (btn) {
        btn.onclick = function () {
          showMode(btn.dataset.authSwitch);
        };
      });
    }

    showMode(currentMode);

    // Verify token on load if provided in route parameters
    if (routeParams.token) {
      var rawToken = routeParams.token;
      if (currentMode === "complete-activation") {
        document.getElementById("complete-activation-token").value = rawToken;
        auth.verifyActivationToken(rawToken).then(function (res) {
          if (res.email) {
            showFeedback("Activating account for " + res.email + ". Set your password below.", false);
          }
        }).catch(function (err) {
          showFeedback(err && err.message ? err.message : "Activation link is invalid or expired.", true);
        });
      } else if (currentMode === "complete-reset") {
        document.getElementById("complete-reset-token").value = rawToken;
        auth.verifyResetToken(rawToken).then(function (res) {
          if (res.email) {
            showFeedback("Resetting password for " + res.email + ". Enter your new password below.", false);
          }
        }).catch(function (err) {
          showFeedback(err && err.message ? err.message : "Reset link is invalid or expired.", true);
        });
      }
    }

    // TYPEWRITER ANIMATION ENGINE
    function startEditorialTypewriter() {
      var headlineEl = document.getElementById("typewriter-headline");
      if (!headlineEl) return;

      var prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      var phrases = [
        {
          lines: ["PRACTICE", "UNDER THE", "RIGHT", "PRESSURE."],
          hasStrike: true,
          strikeWord: "PRESSURE."
        },
        {
          lines: ["BUILD SPEED.", "BUILD ACCURACY."],
          hasStrike: false
        },
        {
          lines: ["KNOW CONCEPT.", "BEAT THE CLOCK."],
          hasStrike: false
        },
        {
          lines: ["PREPARE BEFORE", "REAL TEST."],
          hasStrike: false
        }
      ];

      var phraseIdx = 0;

      if (prefersReducedMotion) {
        headlineEl.innerHTML =
          '<span class="aceiiit-line-row">PRACTICE</span>' +
          '<span class="aceiiit-line-row">UNDER THE</span>' +
          '<span class="aceiiit-line-row">RIGHT</span>' +
          '<span class="aceiiit-line-row"><span class="aceiiit-split-word-container active"><span class="aceiiit-split-text">PRESSURE.</span><span class="aceiiit-cut-half top-slice">PRESSURE.</span><span class="aceiiit-cut-half bottom-slice">PRESSURE.</span><span class="aceiiit-strike-line"></span></span></span>';
        return;
      }

      function renderPhrase(pObj, charIndex, callback) {
        if (!document.getElementById("typewriter-headline")) return;

        var fullString = pObj.lines.join("\n");
        var currentText = fullString.substring(0, charIndex);
        var currentLines = currentText.split("\n");

        var html = "";
        for (var i = 0; i < currentLines.length; i++) {
          var lineText = currentLines[i];
          var isLastLineInProgress = (i === currentLines.length - 1);
          var isFullPhraseTyped = (charIndex >= fullString.length);

          if (pObj.hasStrike && lineText.indexOf("PRESSURE") !== -1) {
            var parts = lineText.split("PRESSURE.");
            var pre = parts[0] || "";
            var strikePart = lineText.substring(pre.length);
            var isStrikeActive = isFullPhraseTyped ? " active" : "";

            html += '<span class="aceiiit-line-row">' +
              pre +
              '<span class="aceiiit-split-word-container' + isStrikeActive + '">' +
              '<span class="aceiiit-split-text">' + strikePart + '</span>' +
              '<span class="aceiiit-cut-half top-slice">' + strikePart + '</span>' +
              '<span class="aceiiit-cut-half bottom-slice">' + strikePart + '</span>' +
              '<span class="aceiiit-strike-line"></span>' +
              '</span>' +
              (isLastLineInProgress ? '<span class="aceiiit-cursor" aria-hidden="true"></span>' : '') +
              '</span>';
          } else {
            html += '<span class="aceiiit-line-row">' +
              lineText +
              (isLastLineInProgress ? '<span class="aceiiit-cursor" aria-hidden="true"></span>' : '') +
              '</span>';
          }
        }

        headlineEl.innerHTML = html;

        if (charIndex < fullString.length) {
          var lastTypedChar = fullString.charAt(charIndex - 1);
          var keyDelay = 75;
          if (lastTypedChar === ' ' || lastTypedChar === '.' || lastTypedChar === ',') {
            keyDelay = 160 + Math.floor(Math.random() * 90);
          } else {
            keyDelay = 75 + Math.floor(Math.random() * 50);
          }
          typewriterTimerId = setTimeout(function () {
            renderPhrase(pObj, charIndex + 1, callback);
          }, keyDelay);
        } else {
          typewriterTimerId = setTimeout(callback, 3000);
        }
      }

      function erasePhrase(pObj, charIndex, callback) {
        if (!document.getElementById("typewriter-headline")) return;

        var fullString = pObj.lines.join("\n");
        var currentText = fullString.substring(0, charIndex);
        var currentLines = currentText.split("\n");

        var html = "";
        for (var i = 0; i < currentLines.length; i++) {
          var lineText = currentLines[i];
          var isLastLine = (i === currentLines.length - 1);
          html += '<span class="aceiiit-line-row">' +
            lineText +
            (isLastLine ? '<span class="aceiiit-cursor" aria-hidden="true"></span>' : '') +
            '</span>';
        }

        headlineEl.innerHTML = html;

        if (charIndex > 0) {
          typewriterTimerId = setTimeout(function () {
            erasePhrase(pObj, charIndex - 1, callback);
          }, 28);
        } else {
          typewriterTimerId = setTimeout(callback, 300);
        }
      }

      function loop() {
        var pObj = phrases[phraseIdx];
        renderPhrase(pObj, 1, function () {
          erasePhrase(pObj, pObj.lines.join("\n").length, function () {
            phraseIdx = (phraseIdx + 1) % phrases.length;
            loop();
          });
        });
      }

      loop();
    }

    setTimeout(startEditorialTypewriter, 60);

    function showFeedback(message, isError) {
      feedback.classList.remove("u-hidden"); // starts hidden via the !important utility
      feedback.style.display = "block";
      feedback.textContent = message;
      feedback.style.background = isError ? "rgba(239, 68, 68, 0.18)" : "rgba(16, 185, 129, 0.16)";
      feedback.style.color = isError ? "#fca5a5" : "#6ee7b7";
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

    // 1. LOGIN FORM SUBMIT
    loginForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      feedback.style.display = "none";
      var btn = document.getElementById("login-submit-btn");
      btn.disabled = true;
      btn.textContent = "Logging in...";
      try {
        var formData = new FormData(event.currentTarget);
        var res = await auth.login({
          email: formData.get("email"),
          password: formData.get("password")
        });
        if (res.ok) {
          navigate("dashboard");
        }
      } catch (error) {
        if (error && error.requiresActivation) {
          showFeedback("Your account is not activated yet. Switch to 'Activate Account' to set your password.", true);
        } else {
          showFeedback(friendlyFetchFailure(error && error.message ? error.message : "Login failed. Please check your email and password."), true);
        }
      } finally {
        btn.disabled = false;
        btn.textContent = "LOG IN";
      }
    });

    // 2. ACTIVATION REQUEST FORM SUBMIT
    activateReqForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      feedback.style.display = "none";
      var btn = document.getElementById("activate-send-btn");
      btn.disabled = true;
      btn.textContent = "Sending link...";
      try {
        var formData = new FormData(event.currentTarget);
        var res = await auth.requestActivation({ email: formData.get("email") });
        if (res.alreadyActivated) {
          showFeedback(res.message, false);
          setTimeout(function () { showMode("login"); }, 2500);
        } else {
          showFeedback(res.message || "Activation link sent! Check your email inbox.", false);
        }
      } catch (error) {
        showFeedback(friendlyFetchFailure(error && error.message ? error.message : "Could not request activation link."), true);
      } finally {
        btn.disabled = false;
        btn.textContent = "Send Activation Link";
      }
    });

    // 3. FORGOT PASSWORD REQUEST FORM SUBMIT
    forgotForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      feedback.style.display = "none";
      var btn = document.getElementById("forgot-send-btn");
      btn.disabled = true;
      btn.textContent = "Sending link...";
      try {
        var formData = new FormData(event.currentTarget);
        var res = await auth.requestPasswordReset({ email: formData.get("email") });
        showFeedback(res.message || "If an account exists, password reset instructions have been sent.", false);
      } catch (error) {
        showFeedback(friendlyFetchFailure(error && error.message ? error.message : "Could not request password reset."), true);
      } finally {
        btn.disabled = false;
        btn.textContent = "Send Reset Link";
      }
    });

    // 4. COMPLETE ACTIVATION FORM SUBMIT
    completeActivationForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      feedback.style.display = "none";
      var formData = new FormData(event.currentTarget);
      var pass = formData.get("password");
      var confirm = formData.get("confirmPassword");
      if (pass !== confirm) {
        showFeedback("Passwords do not match. Please re-enter.", true);
        return;
      }
      var btn = document.getElementById("complete-activation-btn");
      btn.disabled = true;
      btn.textContent = "Activating...";
      try {
        var res = await auth.completeActivation({
          token: formData.get("token") || routeParams.token,
          password: pass,
          name: formData.get("name")
        });
        if (res.ok) {
          navigate("dashboard");
        }
      } catch (error) {
        showFeedback(friendlyFetchFailure(error && error.message ? error.message : "Activation failed."), true);
      } finally {
        btn.disabled = false;
        btn.textContent = "Activate Account & Log In";
      }
    });

    // 5. COMPLETE PASSWORD RESET FORM SUBMIT
    completeResetForm.addEventListener("submit", async function (event) {
      event.preventDefault();
      feedback.style.display = "none";
      var formData = new FormData(event.currentTarget);
      var pass = formData.get("password");
      var confirm = formData.get("confirmPassword");
      if (pass !== confirm) {
        showFeedback("Passwords do not match. Please re-enter.", true);
        return;
      }
      var btn = document.getElementById("complete-reset-btn");
      btn.disabled = true;
      btn.textContent = "Updating password...";
      try {
        var res = await auth.completePasswordReset({
          token: formData.get("token") || routeParams.token,
          password: pass
        });
        if (res.ok) {
          showFeedback("Password updated successfully! Redirecting to login...", false);
          setTimeout(function () { showMode("login"); }, 1800);
        }
      } catch (error) {
        showFeedback(friendlyFetchFailure(error && error.message ? error.message : "Password reset failed."), true);
      } finally {
        btn.disabled = false;
        btn.textContent = "Save New Password & Log In";
      }
    });

    // PASSWORD VISIBILITY TOGGLES
    app.querySelectorAll(".aceiiit-password-toggle").forEach(function (toggle) {
      toggle.addEventListener("click", function () {
        var targetId = toggle.getAttribute("data-for");
        var input = document.getElementById(targetId);
        if (input) {
          if (input.type === "password") {
            input.type = "text";
            toggle.textContent = "Hide";
          } else {
            input.type = "password";
            toggle.textContent = "Show";
          }
        }
      });
    });

    setupGoogleButton();

    // REAL SIGN IN WITH APPLE INTEGRATION
    var appleBtn = document.getElementById("social-apple-btn");
    if (appleBtn) {
      appleBtn.addEventListener("click", async function () {
        showFeedback("Launching Sign in with Apple...", false);
        try {
          var config = await auth.getAuthConfig();
          var clientId = (config && config.appleClientId) || window.ACEIIIT_APPLE_CLIENT_ID;
          var redirectUri = (config && config.appleRedirectUri) || window.ACEIIIT_APPLE_REDIRECT_URI || (window.location.origin + "/api/auth/apple/callback");

          if (!clientId) {
            showFeedback("Sign in with Apple is not configured on this server. Please set APPLE_CLIENT_ID in backend/.env.", true);
            return;
          }

          if (window.AppleID && window.AppleID.auth) {
            window.AppleID.auth.init({
              clientId: clientId,
              scope: "name email",
              redirectURI: redirectUri,
              usePopup: true
            });

            try {
              var data = await window.AppleID.auth.signIn();
              if (data && data.authorization && data.authorization.id_token) {
                showFeedback("Authenticating with Apple...", false);
                await auth.appleAuth({
                  identityToken: data.authorization.id_token,
                  user: data.user || null
                });
                showFeedback("Login successful! Redirecting to dashboard...", false);
                navigate("dashboard");
              } else {
                showFeedback("Apple sign-in was cancelled.", true);
              }
            } catch (authErr) {
              if (authErr && authErr.error === "popup_closed_by_user") {
                showFeedback("Apple sign-in window was closed.", true);
              } else {
                showFeedback(friendlyFetchFailure(authErr && authErr.message ? authErr.message : "Sign in with Apple failed."), true);
              }
            }
          } else {
            showFeedback("Apple Sign-In JS SDK failed to load. Please check your internet connection.", true);
          }
        } catch (err) {
          showFeedback(friendlyFetchFailure(err && err.message ? err.message : "Apple Sign-In initiation failed."), true);
        }
      });
    }
  }

  function renderPrimaryNav(activeView, user) {
    user = user || (auth.getCurrentUser ? auth.getCurrentUser() : null);
    var name = user ? firstName(user.name) : "Student";
    var views = [
      { id: "dashboard", label: "DASHBOARD", hash: "#dashboard" },
      { id: "exams", label: "EXAMS", hash: "#exams" },
      { id: "progress", label: "PROGRESS", hash: "#progress" },
      { id: "resources", label: "RESOURCES", hash: "#resources" },
      { id: "updates", label: "UPDATES", hash: "#updates" },
      { id: "account", label: "ACCOUNT", hash: "#account" }
    ];

    var navLinksHtml = views.map(function (v) {
      var isActive = activeView === v.id;
      return '<a href="' + v.hash + '" class="nav-tab-link' + (isActive ? ' is-active' : '') + '">' + v.label + '</a>';
    }).join("");

    var drawerLinksHtml = views.map(function (v) {
      var isActive = activeView === v.id;
      return '<a href="' + v.hash + '" class="mobile-drawer-link' + (isActive ? ' is-active" aria-current="page' : '') + '">' + v.label + '</a>';
    }).join("");

    // A re-render replaces the drawer's DOM; drop any open-drawer state that pointed at it.
    resetNavDrawerState();

    return (
      '<header class="dashboard-header">' +
      '<div class="dashboard-header-inner">' +
      '<div class="brand-group">' +
      '<a href="#dashboard" class="brand-mark"><img src="assets/favicon-round.svg" alt="AceIIIT Logo" class="brand-logo" /> ACEIIIT</a>' +
      '</div>' +
      '<nav class="primary-nav-links" aria-label="Main Navigation">' +
      navLinksHtml +
      '</nav>' +
      '<div class="button-row" style="align-items: center;">' +
      (user ? '<span class="meta-chip user-chip header-account-control" style="margin-right: 4px;">' + escapeHtml(name) + '</span>' : '') +
      (user && auth.isAdmin(user) ? '<button class="button button-secondary button-compact header-account-control" id="admin-link">Builder Mode</button>' : '') +
      '<span class="header-account-control">' + getThemeToggleMarkup() + '</span>' +
      (user ? '<button class="button button-secondary button-compact header-account-control" id="logout-button">Logout</button>' : '') +
      '<button class="mobile-drawer-toggle js-toggle-mobile-drawer" type="button" aria-label="Open navigation menu" aria-controls="mobile-nav-drawer" aria-expanded="false">☰</button>' +
      '</div>' +
      '</div>' +
      '</header>' +
      '<div class="mobile-nav-drawer" id="mobile-nav-drawer" role="dialog" aria-modal="true" aria-labelledby="mobile-drawer-title" aria-hidden="true" inert>' +
      '<div class="mobile-drawer-head">' +
      '<span class="brand-mark" id="mobile-drawer-title"><img src="assets/favicon-round.svg" alt="" class="brand-logo" /> ACEIIIT</span>' +
      '<button class="button button-secondary button-compact mobile-drawer-close js-toggle-mobile-drawer" type="button" aria-label="Close navigation menu">✕</button>' +
      '</div>' +
      '<nav class="mobile-drawer-nav" aria-label="Main navigation">' +
      drawerLinksHtml +
      '</nav>' +
      (user
        ? '<div class="mobile-drawer-footer">' +
          '<span class="meta-chip user-chip">' + escapeHtml(name) + '</span>' +
          getThemeToggleMarkup() +
          (auth.isAdmin(user) ? '<a class="button button-secondary button-compact" href="#admin">Builder Mode</a>' : '') +
          '<button class="button button-secondary button-compact js-logout-btn" type="button">Logout</button>' +
          '</div>'
        : '') +
      '</div>'
    );
  }

  function buildEditorialCalendarHtml(plannerEvents, activeDate, currentMonthKey, appConfig) {
    var reminderMonthCells = buildCalendarCells(currentMonthKey);
    var selectedDateEvents = getEventsForDate(plannerEvents, activeDate);

    var monthCellsHtml = reminderMonthCells.map(function (cell) {
      var classes = ["editorial-cal-cell"];
      if (!cell.inMonth) classes.push("is-muted");
      if (cell.iso === activeDate) classes.push("is-selected");
      if (cell.iso === toDateInputValue(new Date())) classes.push("is-today");

      var cellEvents = getEventsForDate(plannerEvents, cell.iso);
      var dotsHtml = cellEvents.slice(0, 3).map(function (ev) {
        var dotColor = ev.status === "completed" ? "dot-completed" : (ev.status === "ongoing" ? "dot-live" : "dot-planned");
        return '<span class="cal-dot ' + dotColor + '"></span>';
      }).join("");

      return (
        '<button type="button" class="' + classes.join(" ") + '" data-calendar-date="' + escapeAttribute(cell.iso) + '">' +
        '<span class="cal-day-num">' + cell.label + '</span>' +
        '<span class="cal-dots-wrap">' + dotsHtml + '</span>' +
        '</button>'
      );
    }).join("");

    var selectedDateEventsHtml = selectedDateEvents.length
      ? selectedDateEvents.map(function (ev) {
        return (
          '<div class="editorial-cal-event-row">' +
          '<div class="event-row-info">' +
          '<strong>' + escapeHtml(ev.title) + '</strong>' +
          '<span>' + escapeHtml(ev.startTime) + ' &bull; ' + (ev.testId ? 'Mock Paper' : 'Study Plan') + '</span>' +
          '</div>' +
          (ev.testId ? '<button class="button button-secondary button-compact js-open-instructions" data-id="' + escapeAttribute(ev.testId) + '">View</button>' : '') +
          '</div>'
        );
      }).join("")
      : '<div class="empty-state planner-empty" style="padding:12px 0;">No events scheduled for this date.</div>';

    return (
      '<div class="editorial-calendar-block">' +
      '<div class="editorial-cal-header">' +
      '<strong class="editorial-cal-month">' + escapeHtml(formatMonthLabel(currentMonthKey).toUpperCase()) + '</strong>' +
      '<div class="button-row">' +
      '<button class="button button-secondary button-compact planner-arrow-button" type="button" id="calendar-prev-month" aria-label="Previous month">&larr;</button>' +
      '<button class="button button-secondary button-compact planner-arrow-button" type="button" id="calendar-next-month" aria-label="Next month">&rarr;</button>' +
      '</div>' +
      '</div>' +
      '<div class="editorial-cal-weekdays">' +
      '<span>MON</span><span>TUE</span><span>WED</span><span>THU</span><span>FRI</span><span>SAT</span><span>SUN</span>' +
      '</div>' +
      '<div class="editorial-cal-grid" id="planner-calendar-grid">' +
      monthCellsHtml +
      '</div>' +
      '<div class="editorial-cal-selected-panel">' +
      '<div class="selected-panel-head">' +
      '<span class="section-label">SELECTED DATE</span>' +
      '<strong>' + escapeHtml(formatDateOnly(activeDate).toUpperCase()) + '</strong>' +
      '</div>' +
      selectedDateEventsHtml +
      '</div>' +
      '</div>'
    );
  }

  function renderExams(user, subTab) {
    subTab = subTab || "mock-tests";
    var snapshot = store.getDashboardSnapshot(user.id);

    var realTests = snapshot.tests.filter(function (t) { return !t.isPractice; });
    var practiceTests = snapshot.tests.filter(function (t) { return t.isPractice; });

    var mockTestsListHtml = realTests.map(function (t, idx) {
      var numTag = (idx + 1 < 10 ? '0' + (idx + 1) : (idx + 1));
      var isLocked = isTestLocked(t, user);
      var cta = isLocked
        ? '<button class="button button-primary is-pseudo-disabled js-buy-series" data-id="' + t.id + '" aria-label="Test locked. Purchase or upgrade account to unlock ' + escapeAttribute(t.title) + '">Locked 🔒</button>'
        : '<button class="button button-primary js-open-instructions" data-id="' + t.id + '" aria-label="Start test ' + escapeAttribute(t.title) + '">Start Test →</button>';

      return (
        '<div class="dashboard-test-row" style="padding:16px 0; border-bottom:1px solid rgba(20,17,15,0.08); display:flex; align-items:center; justify-content:space-between;">' +
        '<div style="display:flex; align-items:center; gap:16px;">' +
        '<span class="editorial-num-tag">' + numTag + '</span>' +
        '<div>' +
        '<h3 style="margin:0 0 4px; font-size:1.1rem; font-weight:700;">' + escapeHtml(t.title) + '</h3>' +
        '<span class="meta-chip">' + escapeHtml(t.isFree ? "FREE MOCK" : "PAID MOCK") + '</span> &bull; ' +
        '<span style="font-size:0.82rem; color:var(--ink-soft);">' + getTotalDuration(t) + ' MINS &bull; ' + (Number(t.questionCount || 0) || t.questionIds.length) + ' QUESTIONS</span>' +
        '</div>' +
        '</div>' +
        '<div>' + cta + '</div>' +
        '</div>'
      );
    }).join("");

    var practiceHighlightsHtml = (function() {
      var attemptsByTest = {};
      snapshot.attempts.forEach(function (a) {
        if (!attemptsByTest[a.testId]) attemptsByTest[a.testId] = [];
        attemptsByTest[a.testId].push(a);
      });
      
      return practiceTests.length
        ? '<div class="attempt-list list-scroll-card" style="max-height: calc(100vh - 150px); overflow-y: auto;">' + practiceTests.slice().reverse().map(function (t) {
            var attempts = attemptsByTest[t.id] || [];
            var inProgress = attempts.find(function (a) { return a.status === "in_progress"; });
            var submitted = attempts.find(function (a) { return a.status === "submitted"; });
            
            var statusHtml = inProgress ? '<span class="status-indicator is-live" style="font-size:0.6rem; padding: 2px 6px;">IN PROGRESS</span>' : (submitted ? '<span class="status-indicator is-completed" style="font-size:0.6rem; padding: 2px 6px;">COMPLETED</span>' : '<span class="status-indicator is-available" style="font-size:0.6rem; padding: 2px 6px;">AVAILABLE</span>');
            var actionHtml = inProgress 
              ? '<button class="button button-primary button-compact js-resume-test" data-id="' + t.id + '" data-attempt="' + inProgress.id + '">Resume</button>'
              : (submitted ? '<button class="button button-secondary button-compact js-open-result" data-id="' + submitted.id + '">Report</button>' : '<button class="button button-primary button-compact js-open-instructions" data-id="' + t.id + '">Start</button>');
  
            return '<div class="attempt-item">' +
                   '<div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom: 8px;">' +
                   '<strong>' + escapeHtml(t.title) + '</strong>' +
                   statusHtml + 
                   '</div>' +
                   '<div class="meta-row" style="margin-bottom:8px;">' +
                   '<span class="meta-chip">' + escapeHtml(t.subtitle) + '</span>' +
                   '</div>' +
                   '<div class="button-row">' + actionHtml + '</div>' +
                   '</div>';
          }).join("") + '</div>'
        : '<p style="font-size:0.9rem; color:var(--ink-soft); line-height:1.5;">Practice mode allows targeted topic drill without affecting your official UGEE benchmark ranks. Your generated practice sessions will appear here.</p>';
    })();

    var practiceHtml = (
      '<div class="generator-card" style="max-width: 100%;">' +
      '<span class="section-label">CUSTOM PRACTICE SESSION</span>' +
      '<h3 style="margin:4px 0 16px;">Configure Questions & Subject Focus</h3>' +
      '<form id="practice-gen-form" class="generator-form-grid">' +
      '<div class="field"><label>Subject Area</label><select id="prac-subject"><option value="all">ALL SUBJECTS</option><option value="SUPR">SUPR (Physics/Maths)</option><option value="REAP">REAP (Logical & Reading)</option><option value="Maths">Mathematics</option><option value="Physics">Physics</option><option value="Logical">Logical Reasoning</option></select></div>' +
      '<div class="field"><label>Difficulty Level</label><select id="prac-difficulty"><option value="all">ALL LEVELS</option><option value="easy">Easy</option><option value="medium" selected>Medium</option><option value="hard">Hard</option></select></div>' +
      '<div class="field"><label>Questions Count</label><input type="number" inputmode="numeric" id="prac-count" value="15" min="5" max="30"></div>' +
      '<div class="field"><label>Timer Limit</label><select id="prac-timer"><option value="0">Untimed Mode</option><option value="15">15 Minutes</option><option value="30" selected>30 Minutes</option><option value="45">45 Minutes</option></select></div>' +
      '<div class="button-row" style="grid-column:1 / -1; margin-top:12px;">' +
      '<button type="button" class="button button-primary" id="start-practice-btn">Start Practice Session →</button>' +
      '</div>' +
      '</form>' +
      '</div>'
    );

    var liveTestsHtml = (function() {
      var liveTestId = realTests[0] ? realTests[0].id : '';
      var isLiveTestLocked = !!realTests[0] && isTestLocked(realTests[0], user);
      var liveTestBtn = isLiveTestLocked
        ? '<button class="button button-primary is-pseudo-disabled js-buy-series" data-id="' + liveTestId + '">Locked 🔒</button>'
        : '<button class="button button-primary js-open-instructions" data-id="' + liveTestId + '">Join Live Exam →</button>';

      return '<div style="display:flex; flex-direction:column; gap:16px;">' +
      '<div style="background:var(--surface); border:1px solid rgba(200,150,62,0.4); border-left:4px solid var(--gold-strong); padding:24px; border-radius:8px;">' +
      '<div style="display:flex; align-items:center; justify-content:space-between;">' +
      '<div>' +
      '<span class="meta-chip text-success">LIVE NOW</span>' +
      '<h3 style="margin:8px 0 4px; font-size:1.2rem;">ACEIIIT ALL-INDIA UGEE LIVE MOCK 01</h3>' +
      '<p style="margin:0; font-size:0.85rem; color:var(--ink-soft);">Official scheduled exam window. Server time sync active.</p>' +
      '</div>' +
      '<div>' +
      liveTestBtn +
      '</div>' +
      '</div>' +
      '</div>' +
      '</div>';
    })();

    var activeContentHtml = subTab === "practice" ? practiceHtml : (subTab === "live-tests" ? liveTestsHtml : mockTestsListHtml);

    var shellHtml = '<div class="page-section-shell' + (subTab === "practice" ? ' exams-grid-wrapper' : '') + '">';
    shellHtml += '<div>';
    shellHtml += '<header class="section-page-header">' +
      '<span class="section-label">EXAMINATIONS</span>' +
      '<h1>EXAMINATION PLATFORM</h1>' +
      '<div class="section-sub-tabs">' +
      '<a href="#exams/practice" class="sub-tab-btn' + (subTab === "practice" ? ' is-active' : '') + '">PRACTICE</a>' +
      '<a href="#exams/mock-tests" class="sub-tab-btn' + (subTab === "mock-tests" ? ' is-active' : '') + '">MOCK TESTS</a>' +
      '<a href="#exams/live-tests" class="sub-tab-btn' + (subTab === "live-tests" ? ' is-active' : '') + '">LIVE TESTS</a>' +
      '</div>' +
      '</header>';
    shellHtml += '<main>' + activeContentHtml + '</main>';
    shellHtml += '</div>';

    if (subTab === "practice") {
      shellHtml += '<aside class="dashboard-sidebar" style="position: sticky; top: 100px;">' +
        '<span class="section-label">PRACTICE HIGHLIGHTS</span>' +
        practiceHighlightsHtml +
        '</aside>';
    }
    
    shellHtml += '</div>';

    app.innerHTML = buildShell(
      renderPrimaryNav("exams", user) + shellHtml,
      { fluid: true }
    );

    var pracBtn = document.getElementById("start-practice-btn");
    if (pracBtn) {
      pracBtn.addEventListener("click", function () {
        var subject = document.getElementById("prac-subject") ? document.getElementById("prac-subject").value : "all";
        var difficulty = document.getElementById("prac-difficulty") ? document.getElementById("prac-difficulty").value : "all";
        var countEl = document.getElementById("prac-count");
        var count = countEl ? parseInt(countEl.value, 10) : 15;
        var timerEl = document.getElementById("prac-timer");
        var timerMinutes = timerEl ? parseInt(timerEl.value, 10) : 30;
        
        var isPaid = !!user.isPaid;
        if (!isPaid) {
          if (practiceTests.length >= 1) {
            if (window.confirm("You have used your 1 free custom practice session.\n\nWould you like to upgrade to the Premium Test Series to unlock unlimited Custom Practice Sessions?")) {
              openBuySeries();
            }
            return;
          }
        }
        
        if (store.generatePracticeTest) {
          showOverlayLoader("Building your practice paper.");
          Promise.resolve(store.generatePracticeTest(user.id, subject, difficulty, count, timerMinutes))
            .then(function (practiceTestId) {
              hideOverlayLoader();
              navigate("instructions/" + practiceTestId);
            })
            .catch(function (error) {
              hideOverlayLoader();
              if (error && error.code === "PRACTICE_LIMIT") {
                if (window.confirm(error.message + "\n\nOpen the test series page now?")) {
                  openBuySeries();
                }
                return;
              }
              window.alert(error && error.message ? error.message : "Could not build a practice paper.");
            });
        } else {
          if (snapshot.tests[0]) renderInstructions(user, snapshot.tests[0].id);
        }
      });
    }

    app.querySelectorAll(".js-buy-series").forEach(function (button) {
      button.addEventListener("click", function () {
        openBuySeries();
      });
    });

    app.querySelectorAll(".js-open-instructions").forEach(function (button) {
      button.addEventListener("click", function () {
        navigate("instructions/" + button.dataset.id);
      });
    });

    app.querySelectorAll(".js-open-result").forEach(function (button) {
      button.addEventListener("click", function () {
        navigate("results/" + button.dataset.id);
      });
    });

    app.querySelectorAll(".js-resume-test").forEach(function (button) {
      button.addEventListener("click", function () {
        launchExam(user, button.dataset.id);
      });
    });
  }

  function renderProgress(user, subTab) {
    subTab = subTab || "performance";
    var snapshot = store.getDashboardSnapshot(user.id);
    var submittedAttempts = snapshot.attempts.filter(function (a) { return a.status === "submitted" && a.result; });

    var submittedRows = submittedAttempts.length
      ? submittedAttempts.map(function (a, idx) {
        return (
          '<tr>' +
          '<td><strong>#' + (idx + 1) + '</strong></td>' +
          '<td>' + formatDateOnly(a.submittedAt) + '</td>' +
          '<td><strong>' + (a.result ? a.result.score : 0) + '</strong></td>' +
          '<td>' + (a.result ? a.result.percentile + '%ile' : '—') + '</td>' +
          '<td>' + (a.result ? a.result.accuracy + '%' : '—') + '</td>' +
          '<td><button class="button button-secondary button-compact js-open-result" data-id="' + a.id + '">View Analysis</button></td>' +
          '</tr>'
        );
      }).join("")
      : '<tr><td colspan="6" class="empty-state">No submitted test reports yet. Complete a mock paper to view report metrics.</td></tr>';

    var activeContentHtml = (
      '<div>' +
      '<span class="section-label">PERFORMANCE BENCHMARK COMPARISON</span>' +
      '<h3 style="margin:4px 0 16px;">YOU vs AVERAGE vs TOP PERFORMERS</h3>' +
      '<div class="comparison-table-wrap">' +
      '<table class="comparison-table">' +
      '<thead>' +
      '<tr><th>METRIC</th><th>YOUR PERFORMANCE</th><th>AVERAGE BATCH</th><th>TOP 10% PERFORMERS</th></tr>' +
      '</thead>' +
      '<tbody>' +
      '<tr class="highlight-you"><td>Average Score</td><td><strong>' + (snapshot.bestScore ? Math.round(snapshot.bestScore * 0.85) : '78') + ' / 100</strong></td><td>64 / 100</td><td>89 / 100</td></tr>' +
      '<tr class="highlight-you"><td>Accuracy Rate</td><td><strong>82%</strong></td><td>71%</td><td>94%</td></tr>' +
      '<tr class="highlight-you"><td>Time / Question</td><td><strong>1.4 mins</strong></td><td>1.7 mins</td><td>1.2 mins</td></tr>' +
      '</tbody>' +
      '</table>' +
      '</div>' +
      '<div style="margin-top:36px;">' +
      '<span class="section-label">TOPIC WISE ACCURACY</span>' +
      '<h3 style="margin:4px 0 16px;">Strengths & Weaknesses</h3>' +
      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:20px;">' +
      '<div><span>Algebra & Calculus</span><div class="topic-progress-bar-wrap"><div class="topic-progress-bar" style="width:86%;"></div></div></div>' +
      '<div><span>Logical Reasoning</span><div class="topic-progress-bar-wrap"><div class="topic-progress-bar" style="width:74%;"></div></div></div>' +
      '<div><span>Reading Comprehension</span><div class="topic-progress-bar-wrap"><div class="topic-progress-bar" style="width:91%;"></div></div></div>' +
      '<div><span>Data Interpretation</span><div class="topic-progress-bar-wrap"><div class="topic-progress-bar" style="width:68%;"></div></div></div>' +
      '</div>' +
      '</div>' +
      '<div style="margin-top:36px;">' +
      '<span class="section-label">SUBMITTED TEST TIMELINE</span>' +
      '<div class="comparison-table-wrap">' +
      '<table class="comparison-table">' +
      '<thead><tr><th>#</th><th>DATE</th><th>SCORE</th><th>PERCENTILE</th><th>ACCURACY</th><th>ACTION</th></tr></thead>' +
      '<tbody>' + submittedRows + '</tbody>' +
      '</table>' +
      '</div>' +
      '</div>' +
      '</div>'
    );

    app.innerHTML = buildShell(
      renderPrimaryNav("progress", user) +
      '<div class="page-section-shell">' +
      '<header class="section-page-header">' +
      '<span class="section-label">ANALYTICS & REPORTS</span>' +
      '<h1>PREPARATION PROGRESS</h1>' +
      '<div class="section-sub-tabs">' +
      '<a href="#progress/performance" class="sub-tab-btn' + (subTab === "performance" ? ' is-active' : '') + '">PERFORMANCE</a>' +
      '<a href="#progress/reports" class="sub-tab-btn' + (subTab === "reports" ? ' is-active' : '') + '">REPORTS</a>' +
      '</div>' +
      '</header>' +
      '<main>' + activeContentHtml + '</main>' +
      '</div>',
      { fluid: true }
    );

    app.querySelectorAll(".js-open-result").forEach(function (button) {
      button.addEventListener("click", function () {
        navigate("results/" + button.dataset.id);
      });
    });
  }

  function renderResources(user, subTab) {
    subTab = subTab || "bookmarks";
    var bookmarks = store.getBookmarks ? store.getBookmarks(user.id) : [];

    var bookmarksHtml = bookmarks.length
      ? '<div class="study-materials-grid">' + bookmarks.map(function (b, idx) {
        return (
          '<div class="study-material-card" style="display:block;">' +
          '<div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">' +
          '<span class="meta-chip">BOOKMARK #' + (idx + 1) + '</span>' +
          '<span style="font-size:0.75rem; color:var(--ink-soft);">' + escapeHtml(b.topic || "General") + '</span>' +
          '</div>' +
          '<div class="rich-text" style="font-weight:600; margin:0 0 12px; font-size:0.95rem;">' + formatRichText(b.prompt || "Question prompt") + '</div>' +
          '<div class="rich-text" style="font-size:0.85rem; color:var(--ink-soft); border-top:1px solid rgba(255,255,255,0.1); padding-top:8px;"><strong>Explanation:</strong> ' + formatRichText(b.explanation || "No explanation provided.") + '</div>' +
          '</div>'
        );
      }).join("") + '</div>'
      : '<div class="empty-state">No saved bookmarks yet. Click the bookmark icon during mock paper review to store questions here.</div>';

    var studyData = store.getStudyMaterials ? store.getStudyMaterials() : { folders: [], files: [] };
    var materialsHtml = "";
    if (studyData.folders.length === 0 && studyData.files.length === 0) {
      materialsHtml = '<div class="empty-state">No study materials available yet. Instructors can add them from the Admin panel.</div>';
    } else {
      materialsHtml += '<div style="display:flex; flex-direction:column; gap:32px;">';
      studyData.folders.forEach(function(folder) {
        var folderFiles = studyData.files.filter(function(f) { return f.folderId === folder.id; });
        materialsHtml += '<div>' +
          '<h3 style="display:flex; align-items:center; gap:8px; margin-bottom:16px; color:' + escapeAttribute(folder.color) + ';">' +
          '<span>' + escapeHtml(folder.icon) + '</span> ' + escapeHtml(folder.name) +
          '</h3>' +
          '<div class="study-materials-grid">';
        if (folderFiles.length === 0) {
          materialsHtml += '<div class="empty-state" style="grid-column:1/-1; padding:16px;">This folder is empty.</div>';
        } else {
          folderFiles.forEach(function(file) {
            materialsHtml += 
              '<div class="study-material-card">' +
              '<div style="display:flex; align-items:center; justify-content:space-between;">' +
              '<div>' +
              '<span class="meta-chip" style="background:' + escapeAttribute(folder.color) + '20; color:' + escapeAttribute(folder.color) + ';">' + escapeHtml(file.name.split('.').pop().toUpperCase() || 'FILE') + '</span>' +
              '<h4 style="margin:6px 0 4px; font-size:1.05rem;">' + escapeHtml(file.name) + '</h4>' +
              '<span style="font-size:0.78rem; color:var(--ink-soft);">' + escapeHtml(file.size) + ' &bull; Added ' + escapeHtml(formatDateOnly(file.createdAt)) + '</span>' +
              '</div>' +
              '<button class="button button-secondary button-compact js-download-material" data-url="' + escapeAttribute(file.url) + '" data-name="' + escapeAttribute(file.name) + '">Download</button>' +
              '</div>' +
              '</div>';
          });
        }
        materialsHtml += '</div></div>';
      });
      materialsHtml += '</div>';
    }

    var activeContentHtml = subTab === "materials" ? materialsHtml : bookmarksHtml;

    app.innerHTML = buildShell(
      renderPrimaryNav("resources", user) +
      '<div class="page-section-shell">' +
      '<header class="section-page-header">' +
      '<span class="section-label">STUDY LIBRARY</span>' +
      '<h1>PREPARATION RESOURCES</h1>' +
      '<div class="section-sub-tabs">' +
      '<a href="#resources/bookmarks" class="sub-tab-btn' + (subTab === "bookmarks" ? ' is-active' : '') + '">BOOKMARKS</a>' +
      '<a href="#resources/materials" class="sub-tab-btn' + (subTab === "materials" ? ' is-active' : '') + '">STUDY MATERIAL</a>' +
      '</div>' +
      '</header>' +
      '<main>' + activeContentHtml + '</main>' +
      '</div>',
      { fluid: true }
    );
    
    app.querySelectorAll(".js-download-material").forEach(function(btn) {
      btn.addEventListener("click", function() {
        var a = document.createElement("a");
        a.href = btn.dataset.url;
        a.download = btn.dataset.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      });
    });
  }

  function renderUpdates(user, subTab) {
    subTab = subTab || "notices";
    var appConfig = store.getAppConfig ? store.getAppConfig() : { noticeTitle: "", noticeBody: "" };
    var plannerEvents = store.getPlannerEvents ? store.getPlannerEvents(user.id) : [];

    var noticesHtml = (
      '<div style="display:flex; flex-direction:column; gap:16px;">' +
      '<div style="background:var(--surface); border:1px solid rgba(200,150,62,0.35); border-left:4px solid var(--gold-strong); border-radius:8px; padding:24px;">' +
      '<span class="meta-chip" style="margin-bottom:8px;">IMPORTANT NOTICE</span>' +
      '<h3 style="margin:4px 0 8px; font-size:1.15rem;">' + escapeHtml(appConfig.noticeTitle || "UGEE 2026 Examination Portal Update") + '</h3>' +
      '<p style="margin:0; font-size:0.9rem; color:var(--ink-soft); line-height:1.5; white-space:pre-wrap; word-break:break-word;">' + escapeHtml(appConfig.noticeBody || "Official mock test series registrations are live. Complete all practice papers before final UGEE dates.") + '</p>' +
      '</div>' +
      '</div>'
    );

    var calendarViewHtml = buildEditorialCalendarHtml(plannerEvents, runtime.dashboardReminderDate, runtime.dashboardCalendarMonth, appConfig);

    var activeContentHtml = subTab === "events" ? calendarViewHtml : noticesHtml;

    app.innerHTML = buildShell(
      renderPrimaryNav("updates", user) +
      '<div class="page-section-shell">' +
      '<header class="section-page-header">' +
      '<span class="section-label">ANNOUNCEMENTS & CALENDAR</span>' +
      '<h1>OFFICIAL UPDATES</h1>' +
      '<div class="section-sub-tabs">' +
      '<a href="#updates/notices" class="sub-tab-btn' + (subTab === "notices" ? ' is-active' : '') + '">NOTICE BOARD</a>' +
      '<a href="#updates/events" class="sub-tab-btn' + (subTab === "events" ? ' is-active' : '') + '">EXAM CALENDAR</a>' +
      '</div>' +
      '</header>' +
      '<main>' + activeContentHtml + '</main>' +
      '</div>',
      { fluid: true }
    );
    bindAccountDataActions(user);
  }

  function bindAccountDataActions(user) {
    var exportBtn = document.getElementById("account-export-btn");
    if (exportBtn) {
      exportBtn.addEventListener("click", async function () {
        try {
          var data = await store.exportMyData();
          var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
          var link = document.createElement("a");
          link.href = URL.createObjectURL(blob);
          link.download = "aceiiit-my-data-" + new Date().toISOString().slice(0, 10) + ".json";
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
        } catch (error) {
          window.alert(error && error.message ? error.message : "Could not export your data.");
        }
      });
    }
    var logoutAllBtn = document.getElementById("account-logout-all-btn");
    if (logoutAllBtn) {
      logoutAllBtn.addEventListener("click", async function () {
        if (!window.confirm("Sign out of every device, including this one?")) return;
        try {
          await store.logoutAllDevices();
        } finally {
          navigate("login");
        }
      });
    }
    var deleteBtn = document.getElementById("account-delete-btn");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", async function () {
        var typed = window.prompt('This permanently deletes your account. Your exam history is anonymized and you will be signed out.\n\nType DELETE MY ACCOUNT to confirm.');
        if (typed !== "DELETE MY ACCOUNT") return;
        var password = user.hasPassword ? window.prompt("Enter your password to confirm:") : undefined;
        if (user.hasPassword && !password) return;
        try {
          await store.deleteMyAccount({ confirm: typed, password: password });
          window.alert("Your account has been deleted.");
          navigate("login");
        } catch (error) {
          window.alert(error && error.message ? error.message : "Could not delete your account.");
        }
      });
    }
  }

  function renderAccount(user, subTab) {
    subTab = subTab || "profile";

    var profileHtml = (
      '<div style="background:var(--surface); border:1px solid rgba(20,17,15,0.08); border-radius:8px; padding:28px;">' +
      '<span class="section-label">STUDENT IDENTITY</span>' +
      '<h3 style="margin:4px 0 20px;">' + escapeHtml(user.name) + '</h3>' +
      '<div class="account-identity-grid">' +
      '<div><strong style="display:block; color:var(--ink-soft);">Email Address</strong><span>' + escapeHtml(user.email) + '</span></div>' +
      '<div><strong style="display:block; color:var(--ink-soft);">Role</strong><span>' + escapeHtml(user.role.toUpperCase()) + '</span></div>' +
      '<div><strong style="display:block; color:var(--ink-soft);">Target Exam</strong><span>UGEE 2026</span></div>' +
      '<div><strong style="display:block; color:var(--ink-soft);">Account Status</strong><span class="meta-chip text-success">' + escapeHtml(user.status || "ACTIVE") + '</span></div>' +
      '</div>' +
      '</div>'
    );

    var packageHtml = (
      '<div style="background:var(--surface); border:1px solid rgba(20,17,15,0.08); border-radius:8px; padding:28px;">' +
      '<span class="section-label">ACTIVE ENROLLMENT</span>' +
      '<h3 style="margin:4px 0 16px;">' + (user.isPaid ? 'ACEIIIT PRO TEST SERIES' : 'ACEIIIT FREE TIER') + '</h3>' +
      '<p style="font-size:0.9rem; color:var(--ink-soft);">' + (user.isPaid ? 'Full access unlocked to all UGEE SUPR and REAP full-length mock papers and detailed rank analytical breakdown.' : 'Access limited to free practice mocks. Upgrade to Pro for full test series access.') + '</p>' +
      (!user.isPaid ? '<a href="' + escapeAttribute(BUY_SERIES_URL) + '" target="_blank" class="button button-primary" style="margin-top:16px; display:inline-block; text-decoration:none;">Upgrade to Pro Series →</a>' : '') +
      '</div>'
    );

    var securityHtml = (
      '<div style="background:var(--surface); border:1px solid rgba(20,17,15,0.08); border-radius:8px; padding:28px; max-width:480px;">' +
      '<span class="section-label">SECURITY & PASSWORD</span>' +
      '<h3 style="margin:4px 0 16px;">Change Password</h3>' +
      '<form id="account-pwd-form" style="display:flex; flex-direction:column; gap:16px;">' +
      (user.hasPassword ? '<div class="field"><label>Current Password</label><input type="password" id="pwd-current" required autocomplete="current-password"></div>' : '') +
      '<div class="field"><label>New Password</label><input type="password" id="pwd-new" required minlength="8" autocomplete="new-password"></div>' +
      '<div class="button-row"><button type="submit" class="button button-primary" id="pwd-submit-btn">Update Password</button></div>' +
      '</form>' +
      '</div>' +
      '<div style="background:var(--surface); border:1px solid rgba(20,17,15,0.08); border-radius:8px; padding:28px; max-width:480px; margin-top:20px;">' +
      '<span class="section-label">YOUR DATA & PRIVACY</span>' +
      '<h3 style="margin:4px 0 8px;">Download or delete your data</h3>' +
      '<p style="font-size:0.88rem; color:var(--ink-soft);">Download a copy of your profile, attempts, reminders, payments and exam records. See the <a href="/privacy.html" target="_blank" rel="noopener">privacy policy</a> and <a href="/terms.html" target="_blank" rel="noopener">terms</a>.</p>' +
      '<div class="button-row" style="flex-wrap:wrap; gap:10px;">' +
      '<button type="button" class="button button-secondary" id="account-export-btn">Download my data</button>' +
      '<button type="button" class="button button-secondary" id="account-logout-all-btn">Sign out of all devices</button>' +
      '<button type="button" class="button button-danger" id="account-delete-btn">Delete my account</button>' +
      '</div>' +
      '</div>'
    );

    var activeContentHtml = subTab === "package" ? packageHtml : (subTab === "security" ? securityHtml : profileHtml);

    app.innerHTML = buildShell(
      renderPrimaryNav("account", user) +
      '<div class="page-section-shell">' +
      '<header class="section-page-header">' +
      '<span class="section-label">STUDENT PORTAL</span>' +
      '<h1>ACCOUNT SETTINGS</h1>' +
      '<div class="section-sub-tabs">' +
      '<a href="#account/profile" class="sub-tab-btn' + (subTab === "profile" ? ' is-active' : '') + '">PROFILE</a>' +
      '<a href="#account/package" class="sub-tab-btn' + (subTab === "package" ? ' is-active' : '') + '">PACKAGE</a>' +
      '<a href="#account/security" class="sub-tab-btn' + (subTab === "security" ? ' is-active' : '') + '">SECURITY</a>' +
      '</div>' +
      '</header>' +
      '<main>' + activeContentHtml + '</main>' +
      '</div>',
      { fluid: true }
    );
  }

  function renderGoogleCalendarControl() {
    var state = runtime.googleCalendarState || { status: "syncing", autoAddEnabled: false };
    var icon = "";
    var title = "Google Calendar";
    var extraClass = "";
    var popover = "";

    if (state.status === "syncing") {
      icon = "···";
      title = "Syncing Google Calendar...";
      extraClass = "is-syncing";
    } else if (state.status === "error") {
      icon = "!";
      title = "Google Calendar Sync Error";
      extraClass = "is-error";
    } else if (state.status === "connected") {
      icon = state.autoAddEnabled ? "✓" : "○";
      title = state.autoAddEnabled ? "Google Calendar Connected (Auto-Add ON)" : "Google Calendar Connected (Auto-Add OFF)";
      extraClass = "is-connected";
      popover = '<div class="gcal-popover" style="display: none; position: absolute; right: 0; top: 100%; margin-top: 4px; background: var(--surface, #fff); color: var(--ink, #000); border: 1px solid var(--surface-soft, #eaeaea); border-radius: 8px; padding: 12px; z-index: 100; box-shadow: var(--shadow, 0 4px 12px rgba(0,0,0,0.1)); width: max-content; text-align: left;">' +
        '<label style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 13px; cursor: pointer; color: var(--ink, #000);">' +
        '<input type="checkbox" class="js-gcal-autoadd" ' + (state.autoAddEnabled ? 'checked' : '') + ' style="margin: 0;"> Auto-add new mocks' +
        '</label>' +
        '<button type="button" class="button button-secondary button-compact js-gcal-disconnect" style="width: 100%; color: var(--red, #ef2d3a);">Disconnect</button>' +
        '</div>';
    } else {
      var buttonText = "Connect GCal";
      if (state.status === "syncing") {
        buttonText = "Syncing...";
      } else if (state.status === "error") {
        buttonText = "GCal Error";
      } else if (state.status === "connected") {
        buttonText = state.autoAddEnabled ? "GCal Sync: ON" : "GCal Sync: OFF";
      }
    }

    var btnTextToRender = buttonText || "Connect Calendar";
    if (state.status === "syncing") btnTextToRender = "Syncing...";
    else if (state.status === "error") btnTextToRender = "Calendar Error";
    else if (state.status === "connected") btnTextToRender = state.autoAddEnabled ? "Auto-Sync: ON" : "Auto-Sync: OFF";

    var gcalIcon = '<img src="/assets/google-calendar.svg" alt="" style="width: 14px; height: 14px; object-fit: contain; flex-shrink: 0;">';

    return '<div class="gcal-control-container" style="position: relative; margin-left: auto;">' +
      '<button type="button" class="button button-secondary button-compact js-gcal-control ' + extraClass + '" style="padding: 4px 12px; font-size: 11px; font-weight: 600; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;" title="' + title + '" aria-label="' + title + '">' + gcalIcon + '<span style="white-space: nowrap;">' + escapeHtml(btnTextToRender) + '</span></button>' +
      popover +
      '</div>';
  }

  function renderDashboard(user) {
    if (!runtime.googleCalendarState.fetched && user) {
      runtime.googleCalendarState.fetched = true;
      store.getCalendarStatus().then(function (res) {
        runtime.googleCalendarState = { status: res.status, autoAddEnabled: res.autoAddEnabled, fetched: true };
        renderRoute();
      }).catch(function () {
        runtime.googleCalendarState = { status: "error", autoAddEnabled: false, fetched: true };
        renderRoute();
      });
    }

    try { localStorage.setItem("aceiiit_last_view", "dashboard"); } catch (_e) { }
    var snapshot = store.getDashboardSnapshot(user.id);
    var appConfig = store.getAppConfig ? store.getAppConfig() : { ugeeExamDate: null, featuredTestId: "", noticeTitle: "", noticeBody: "" };

    var qotdHtml = '';
    var qotd = store.getQotd ? store.getQotd() : null;

    if (qotd) {
      // The answer is never in the page until the server records this student's attempt.
      var qotdAttempt = qotd.attempt || null;
      var hasAttempted = !!qotdAttempt;

      var optionsHtml = qotd.options.map(function (opt, idx) {
        var classNames = "qotd-option js-qotd-option";
        if (hasAttempted && idx === Number(qotdAttempt.correctOption)) classNames += " is-correct";
        if (hasAttempted && idx === Number(qotdAttempt.selectedOption) && !qotdAttempt.correct) classNames += " is-wrong";
        return '<button class="' + classNames + '" data-idx="' + idx + '" ' + (hasAttempted ? 'disabled' : '') + '>' +
          '<span class="qotd-option-label">' + String.fromCharCode(65 + idx) + '.</span>' +
          '<span class="rich-text">' + formatRichText(opt) + '</span>' +
          '</button>';
      }).join('');

      var prefilledResultHtml = '<div class="qotd-result-message js-qotd-result' +
        (hasAttempted ? (qotdAttempt.correct ? ' show-correct' : ' show-wrong') : '') + '" role="status" aria-live="polite">' +
        (hasAttempted ? escapeHtml(describeQotdResult(qotdAttempt)) : '') + '</div>' +
        (hasAttempted && qotdAttempt.explanation ? '<div class="qotd-explanation rich-text">' + formatRichText(qotdAttempt.explanation) + '</div>' : '');

      qotdHtml = '<div class="rail-block qotd-block" style="border-top: 1px solid var(--border-color); padding-top: 24px; margin-top: auto;">' +
        '<div class="rail-header">' +
        '<span class="editorial-num-tag"><svg class="editorial-traced-icon" xmlns="http://www.w3.org/2000/svg" width="72" height="90" viewBox="0 0 72 90"><g shape-rendering="geometricPrecision"><path fill="#ffed92" fill-rule="evenodd" d="M 26 48 26 51 27 52 27 54 31 58 31 75 48 75 49 74 49 69 50 68 50 61 51 60 51 55 52 54 52 52 53 51 52 50 52 48 Z M 34 52 45 52 47 54 47 63 42 68 33 68 32 67 32 66 31 65 31 55 Z"/><path fill="#000000" fill-rule="evenodd" d="M 41 62 41 66 42 65 41 64 Z M 46 56 46 61 45 62 46 61 Z M 45 54 34 54 33 55 33 65 33 55 34 54 Z M 22 43 22 45 24 47 25 46 53 46 54 47 54 49 54 47 55 46 23 46 22 45 Z M 48 33 48 35 49 35 48 34 Z M 50 28 49 29 49 31 49 29 Z M 29 28 30 28 31 29 31 30 31 29 30 28 Z M 43 27 43 35 43 32 45 30 44 31 43 30 Z M 21 25 21 26 22 27 21 26 Z M 29 20 29 22 28 23 29 23 30 24 30 25 30 24 29 23 Z M 36 21 38 19 41 19 43 21 41 19 38 19 Z"/><path fill="#b3d8fb" fill-rule="evenodd" d="M 44 55 35 55 35 65 39 65 39 62 41 60 44 60 Z M 38 21 37 22 37 29 38 30 38 34 41 34 41 29 42 28 42 22 41 21 Z"/><path fill="#8795da" fill-rule="evenodd" d="M 16 66 16 75 28 75 28 66 Z M 38 37 38 40 41 40 41 37 Z"/><path fill="#50423a" fill-rule="evenodd" d="M 14 59 15 60 15 63 16 64 28 64 16 64 15 63 15 60 Z M 45 25 46 26 46 27 46 26 Z M 37 16 38 17 38 18 38 17 Z"/><path fill="#ff85ae" fill-rule="evenodd" d="M 16 59 16 63 28 63 28 60 27 59 27 58 26 57 18 57 Z M 28 21 27 20 27 19 26 19 25 20 22 20 21 21 21 22 22 23 24 23 25 22 27 22 Z"/><path fill="#d69d69" fill-rule="evenodd" d="M 24 43 24 45 54 45 55 44 55 43 Z"/><path fill="#616b68" fill-rule="evenodd" d="M 45 55 45 60 44 61 41 61 44 61 45 60 Z"/><path fill="#8cb07a" fill-rule="evenodd" d="M 57 20 55 20 54 19 53 19 53 20 54 20 56 22 55 23 52 23 54 25 53 26 52 26 51 27 53 27 54 28 54 29 53 30 50 30 52 32 51 33 50 33 49 34 51 34 52 35 52 36 51 37 49 37 50 38 50 39 49 40 48 40 52 40 52 39 53 38 53 35 54 34 54 31 55 30 55 27 56 26 56 24 57 23 Z"/><path fill="#0f100e" fill-rule="evenodd" d="M 44 62 44 63 43 64 44 63 Z"/><path fill="#21221f" fill-rule="evenodd" d="M 15 59 14 60 14 64 15 64 14 63 14 60 Z M 43 23 43 24 44 24 Z"/><path fill="#151616" fill-rule="evenodd" d="M 38 16 37 17 37 18 37 17 Z"/><path fill="#3a2f31" fill-rule="evenodd" d="M 19 56 25 56 26 55 25 56 24 55 20 55 Z M 36 37 36 40 37 40 37 37 Z M 30 27 31 28 31 27 Z M 42 17 41 17 41 18 Z"/><path fill="#f0db7c" fill-rule="evenodd" d="M 24 31 25 32 25 34 26 35 26 38 27 39 27 40 28 40 27 39 27 36 26 35 26 32 25 31 Z M 28 30 29 31 29 33 30 34 30 37 31 38 31 40 32 40 32 39 31 38 31 35 30 34 30 31 29 30 Z"/><path fill="#f1efde" fill-rule="evenodd" d="M 28 26 27 25 26 25 25 26 23 26 24 27 24 28 25 27 28 27 Z"/><path fill="#070706" fill-rule="evenodd" d="M 22 29 23 30 23 31 23 30 Z"/></g></svg></span>' +
        '<p class="section-label">DAILY MICRO-QUIZ</p>' +
        '</div>' +
        '<div class="qotd-card">' +
        '<span class="qotd-topic">' + escapeHtml(qotd.section + ' \u2022 ' + (qotd.topic || 'General')) + '</span>' +
        '<p class="qotd-prompt rich-text">' + (qotd.prompt ? formatRichText(qotd.prompt) : '') + '</p>' +
        '<div class="qotd-options">' + optionsHtml + '</div>' +
        prefilledResultHtml +
        '</div>' +
        '</div>';
    }

    if (!qotdHtml) {
      // Fallback empty state if no valid questions exist in the DB
      qotdHtml = '<div class="rail-block qotd-block" style="border-top: 1px solid var(--border-color); padding-top: 24px; margin-top: auto;">' +
        '<div class="rail-header">' +
        '<span class="editorial-num-tag"><svg class="editorial-traced-icon" xmlns="http://www.w3.org/2000/svg" width="72" height="90" viewBox="0 0 72 90"><g shape-rendering="geometricPrecision"><path fill="#ffed92" fill-rule="evenodd" d="M 26 48 26 51 27 52 27 54 31 58 31 75 48 75 49 74 49 69 50 68 50 61 51 60 51 55 52 54 52 52 53 51 52 50 52 48 Z M 34 52 45 52 47 54 47 63 42 68 33 68 32 67 32 66 31 65 31 55 Z"/><path fill="#000000" fill-rule="evenodd" d="M 41 62 41 66 42 65 41 64 Z M 46 56 46 61 45 62 46 61 Z M 45 54 34 54 33 55 33 65 33 55 34 54 Z M 22 43 22 45 24 47 25 46 53 46 54 47 54 49 54 47 55 46 23 46 22 45 Z M 48 33 48 35 49 35 48 34 Z M 50 28 49 29 49 31 49 29 Z M 29 28 30 28 31 29 31 30 31 29 30 28 Z M 43 27 43 35 43 32 45 30 44 31 43 30 Z M 21 25 21 26 22 27 21 26 Z M 29 20 29 22 28 23 29 23 30 24 30 25 30 24 29 23 Z M 36 21 38 19 41 19 43 21 41 19 38 19 Z"/><path fill="#b3d8fb" fill-rule="evenodd" d="M 44 55 35 55 35 65 39 65 39 62 41 60 44 60 Z M 38 21 37 22 37 29 38 30 38 34 41 34 41 29 42 28 42 22 41 21 Z"/><path fill="#8795da" fill-rule="evenodd" d="M 16 66 16 75 28 75 28 66 Z M 38 37 38 40 41 40 41 37 Z"/><path fill="#50423a" fill-rule="evenodd" d="M 14 59 15 60 15 63 16 64 28 64 16 64 15 63 15 60 Z M 45 25 46 26 46 27 46 26 Z M 37 16 38 17 38 18 38 17 Z"/><path fill="#ff85ae" fill-rule="evenodd" d="M 16 59 16 63 28 63 28 60 27 59 27 58 26 57 18 57 Z M 28 21 27 20 27 19 26 19 25 20 22 20 21 21 21 22 22 23 24 23 25 22 27 22 Z"/><path fill="#d69d69" fill-rule="evenodd" d="M 24 43 24 45 54 45 55 44 55 43 Z"/><path fill="#616b68" fill-rule="evenodd" d="M 45 55 45 60 44 61 41 61 44 61 45 60 Z"/><path fill="#8cb07a" fill-rule="evenodd" d="M 57 20 55 20 54 19 53 19 53 20 54 20 56 22 55 23 52 23 54 25 53 26 52 26 51 27 53 27 54 28 54 29 53 30 50 30 52 32 51 33 50 33 49 34 51 34 52 35 52 36 51 37 49 37 50 38 50 39 49 40 48 40 52 40 52 39 53 38 53 35 54 34 54 31 55 30 55 27 56 26 56 24 57 23 Z"/><path fill="#0f100e" fill-rule="evenodd" d="M 44 62 44 63 43 64 44 63 Z"/><path fill="#21221f" fill-rule="evenodd" d="M 15 59 14 60 14 64 15 64 14 63 14 60 Z M 43 23 43 24 44 24 Z"/><path fill="#151616" fill-rule="evenodd" d="M 38 16 37 17 37 18 37 17 Z"/><path fill="#3a2f31" fill-rule="evenodd" d="M 19 56 25 56 26 55 25 56 24 55 20 55 Z M 36 37 36 40 37 40 37 37 Z M 30 27 31 28 31 27 Z M 42 17 41 17 41 18 Z"/><path fill="#f0db7c" fill-rule="evenodd" d="M 24 31 25 32 25 34 26 35 26 38 27 39 27 40 28 40 27 39 27 36 26 35 26 32 25 31 Z M 28 30 29 31 29 33 30 34 30 37 31 38 31 40 32 40 32 39 31 38 31 35 30 34 30 31 29 30 Z"/><path fill="#f1efde" fill-rule="evenodd" d="M 28 26 27 25 26 25 25 26 23 26 24 27 24 28 25 27 28 27 Z"/><path fill="#070706" fill-rule="evenodd" d="M 22 29 23 30 23 31 23 30 Z"/></g></svg></span>' +
        '<p class="section-label">DAILY MICRO-QUIZ</p>' +
        '</div>' +
        '<div class="portal-empty-card" style="padding: 24px; text-align: center;">' +
        '<h4 class="portal-empty-title">Check Back Later</h4>' +
        '<p class="portal-empty-text">A new micro-quiz is being prepared.</p>' +
        '</div>' +
        '</div>';
    }

    var attemptsByTest = {};
    snapshot.attempts.forEach(function (attempt) {
      if (!attemptsByTest[attempt.testId]) {
        attemptsByTest[attempt.testId] = [];
      }
      attemptsByTest[attempt.testId].push(attempt);
    });

    var submittedAttempts = snapshot.attempts.filter(function (a) { return a.status === "submitted" && a.result; });
    var attemptedCount = snapshot.attempts.length;
    var completedCount = snapshot.completedCount || submittedAttempts.length;
    var bestScore = snapshot.bestScore || 0;
    var bestPercentile = snapshot.bestPercentile || 0;
    var averageScore = submittedAttempts.length
      ? Math.round(submittedAttempts.reduce(function (acc, a) { return acc + (a.result ? (Number(a.result.score) || 0) : 0); }, 0) / submittedAttempts.length)
      : 0;

    // Determine "NEXT UP" Test
    var dashboardTests = snapshot.tests.filter(function (t) { return !t.isPractice; });
    var nextUpTest = null;
    var inProgressAttempt = snapshot.attempts.find(function (a) { return a.status === "in_progress"; });
    if (inProgressAttempt) {
      nextUpTest = snapshot.tests.find(function (t) { return t.id === inProgressAttempt.testId; }) || null;
    }
    if (!nextUpTest && appConfig && appConfig.featuredTestId) {
      nextUpTest = snapshot.tests.find(function (t) { return t.id === appConfig.featuredTestId; }) || null;
    }
    if (!nextUpTest && dashboardTests && dashboardTests.length) {
      nextUpTest = dashboardTests.find(function (t) { return t.status === "live"; }) || dashboardTests[0];
    }

    var nextUpHtml = "";
    if (nextUpTest) {
      var nextUpAttempts = attemptsByTest[nextUpTest.id] || [];
      var nextUpInProgress = nextUpAttempts.find(function (a) { return a.status === "in_progress"; });
      var isNextUpExpired = isAttemptExpired(nextUpInProgress, nextUpTest);
      var nextUpSubmitted = nextUpAttempts.filter(function (a) { return a.status === "submitted"; })[0] || null;
      var isNextUpLocked = isTestLocked(nextUpTest, user);

      var nextUpCta = nextUpInProgress
        ? (isNextUpExpired
          ? '<button class="button button-primary js-restart-attempt" data-id="' + nextUpTest.id + '" data-attempt="' + nextUpInProgress.id + '">Restart Test</button>'
          : '<button class="button button-primary js-resume-test" data-id="' + nextUpTest.id + '" data-attempt="' + nextUpInProgress.id + '">Resume Test</button>')
        : (isNextUpLocked
          ? '<button class="button button-primary is-pseudo-disabled js-buy-series" data-id="' + nextUpTest.id + '">Locked 🔒</button>'
          : '<button class="button button-primary js-open-instructions" data-id="' + nextUpTest.id + '">Start Test</button>');

      var nextUpSecCta = isNextUpLocked
        ? '<button class="button button-secondary js-buy-series" data-id="' + nextUpTest.id + '">Buy Test Series</button>'
        : (nextUpSubmitted
          ? '<button class="button button-secondary js-open-result" data-id="' + nextUpSubmitted.id + '">Last Report</button>'
          : '<button class="button button-secondary js-open-instructions" data-id="' + nextUpTest.id + '">View Details</button>');

      nextUpHtml =
        '<div class="dashboard-next-up-hero animate-fade-in-up" style="animation-delay: 60ms;">' +
        '<div class="next-up-meta-bar">' +
        '<div class="next-up-eyebrow-group">' +
        '<span class="editorial-num-tag"><svg class="editorial-traced-icon" xmlns="http://www.w3.org/2000/svg" width="72" height="90" viewBox="0 0 72 90"><g shape-rendering="geometricPrecision"><path fill="#f3e7d7" fill-rule="evenodd" d="M 13 28 13 46 14 47 14 48 17 51 54 51 54 28 Z M 43 46 44 45 51 45 52 46 52 47 51 48 44 48 43 47 Z M 23 46 24 45 31 45 32 46 32 47 31 48 24 48 23 47 Z M 36 43 37 42 40 42 41 43 41 46 40 47 37 47 36 46 Z M 16 43 17 42 20 42 21 43 21 46 20 47 17 47 16 46 Z M 43 42 44 41 51 41 52 42 52 43 51 44 44 44 43 43 Z M 23 42 24 41 31 41 32 42 32 43 31 44 24 44 23 43 Z M 43 36 44 35 51 35 52 36 52 37 51 38 44 38 43 37 Z M 23 36 24 35 31 35 32 36 32 37 31 38 24 38 23 37 Z M 36 33 37 32 40 32 41 33 41 36 40 37 37 37 36 36 Z M 16 33 17 32 20 32 21 33 21 36 20 37 17 37 16 36 Z M 43 32 44 31 51 31 52 32 52 33 51 34 44 34 43 33 Z M 23 32 24 31 31 31 32 32 32 33 31 34 24 34 23 33 Z"/><path fill="#929292" fill-rule="evenodd" d="M 62 21 60 21 59 20 55 20 55 23 59 23 60 24 60 55 59 56 25 56 26 57 27 57 28 58 29 58 30 59 31 59 32 60 32 59 33 58 34 58 35 59 35 61 38 61 39 62 47 62 48 63 60 63 61 62 62 62 62 61 63 60 63 24 62 23 Z M 12 20 8 20 7 21 5 21 5 28 6 29 6 32 7 33 7 34 7 24 8 23 12 23 Z"/><path fill="#68c06b" fill-rule="evenodd" d="M 38 18 37 17 36 18 36 19 38 19 Z M 13 12 13 14 14 15 14 17 15 18 15 19 16 20 16 21 18 23 18 15 19 14 24 14 25 25 16 24 17 21 17 21 18 24 18 25 19 25 20 24 21 21 21 21 22 24 22 25 23 25 24 24 25 21 25 22 25 23 26 25 26 26 27 54 27 54 12 Z M 42 14 43 14 45 16 45 17 46 17 46 16 48 14 49 14 50 15 50 24 49 25 48 25 47 24 47 23 46 24 45 24 44 23 44 24 43 25 42 25 41 24 41 15 Z M 35 14 39 14 41 16 41 24 40 25 39 25 38 24 38 22 36 22 36 24 35 25 34 25 33 24 33 16 Z M 26 14 28 14 29 15 29 16 29 15 30 14 32 14 33 15 33 16 32 17 32 18 31 19 31 20 32 21 32 22 33 23 33 24 32 25 30 25 29 24 29 23 29 24 28 25 26 25 25 24 25 23 26 22 26 21 27 20 27 19 26 18 26 17 25 16 25 15 Z"/><path fill="#94eafc" fill-rule="evenodd" d="M 59 25 58 24 55 24 55 51 54 52 19 52 21 54 22 54 23 55 58 55 59 54 Z M 9 24 8 25 8 38 9 39 9 40 11 42 11 43 12 44 12 24 Z"/><path fill="#686868" fill-rule="evenodd" d="M 4 28 4 60 7 63 39 63 36 63 35 62 33 62 32 61 30 61 29 60 28 60 27 59 26 59 24 57 23 57 22 56 8 56 7 55 7 38 6 37 6 35 5 34 5 32 4 31 Z"/><path fill="#606060" fill-rule="evenodd" d="M 44 46 44 47 51 47 51 46 Z M 24 46 24 47 31 47 31 46 Z M 44 42 44 43 51 43 51 42 Z M 24 42 24 43 31 43 31 42 Z M 44 36 44 37 51 37 51 36 Z M 24 36 24 37 31 37 31 36 Z M 44 32 44 33 51 33 51 32 Z M 24 32 24 33 31 33 31 32 Z"/><path fill="#494949" fill-rule="evenodd" d="M 23 71 44 71 39 66 39 65 38 64 29 64 29 65 Z"/><path fill="#5ed2f2" fill-rule="evenodd" d="M 8 40 8 54 9 55 21 55 20 55 17 52 13 52 12 51 12 46 10 44 10 43 8 41 Z"/><path fill="#fe8d3c" fill-rule="evenodd" d="M 37 43 37 46 40 46 40 43 Z M 17 43 17 46 20 46 20 43 Z M 37 33 37 36 40 36 40 33 Z M 17 33 17 36 20 36 20 33 Z"/><path fill="#57b15e" fill-rule="evenodd" d="M 13 15 13 27 25 27 23 27 22 26 21 26 20 25 19 25 15 21 15 20 14 19 14 18 13 17 Z"/><path fill="#ced9c4" fill-rule="evenodd" d="M 13 47 13 51 16 51 13 48 Z"/><path fill="#2e2e2e" fill-rule="evenodd" d="M 33 59 33 60 34 60 34 59 Z"/></g></svg></span>' +
        '<span class="next-up-eyebrow">NEXT UP</span>' +
        '</div>' +
        '<span class="next-up-type">' + escapeHtml(nextUpTest.isFree ? "FREE MOCK" : "PAID MOCK") + '</span>' +
        '</div>' +
        '<div class="next-up-body">' +
        '<div class="next-up-info">' +
        '<h2 class="next-up-title">' + escapeHtml(nextUpTest.title) + '</h2>' +
        '<p class="next-up-subtitle">' + escapeHtml(nextUpTest.subtitle || "Full timed SUPR → REAP examination paper.") + '</p>' +
        '<div class="next-up-pills">' +
        '<span class="meta-chip">SUPR ' + nextUpTest.sectionDurations.SUPR + 'm &bull; REAP ' + nextUpTest.sectionDurations.REAP + 'm</span>' +
        '<span class="meta-chip">TOTAL ' + getTotalDuration(nextUpTest) + ' MINS</span>' +
        '<span class="meta-chip">' + (Number(nextUpTest.questionCount || 0) || nextUpTest.questionIds.length) + ' QUESTIONS</span>' +
        '</div>' +
        '</div>' +
        '<div class="next-up-cta-stack">' +
        nextUpCta +
        nextUpSecCta +
        '</div>' +
        '</div>' +
        '</div>';
    }


    var reminderEligibleTests = dashboardTests.filter(function (test) {
      if (!test || test.status !== "live") return false;
      if (isTestLocked(test, user)) return false;
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

    var cards = dashboardTests.map(function (test, index) {
      var attempts = attemptsByTest[test.id] || [];
      var inProgress = attempts.find(function (attempt) { return attempt.status === "in_progress"; });
      var isExpiredInProgress = isAttemptExpired(inProgress, test);
      var plannedEventsForTest = plannerEvents.filter(function (event) {
        return event.mockId === test.id && (event.status === "planned" || event.status === "ongoing");
      });
      var nextPlannedEvent = plannedEventsForTest[0] || null;
      var submitted = attempts.filter(function (attempt) { return attempt.status === "submitted"; });
      var latestSubmitted = submitted[0] || null;
      var locked = isTestLocked(test, user);
      var sectionLabel = test.isFree ? "FREE MOCK" : "PAID MOCK";
      var itemNumStr = index + 1 < 10 ? "0" + (index + 1) : String(index + 1);

      var actionHtml = inProgress
        ? (isExpiredInProgress
          ? '<button class="button button-primary js-restart-attempt" data-id="' + test.id + '" data-attempt="' + inProgress.id + '">Restart Test &rarr;</button>'
          : '<button class="button button-primary js-resume-test" data-id="' + test.id + '" data-attempt="' + inProgress.id + '">Resume Test &rarr;</button>')
        : '<button class="button button-primary js-open-instructions" data-id="' + test.id + '">Start Test &rarr;</button>';

      var reportHtml = latestSubmitted
        ? '<button class="button button-secondary js-open-result" data-id="' + latestSubmitted.id + '">Last Report</button>'
        : '<button class="button button-secondary js-open-instructions" data-id="' + test.id + '">View Details</button>';

      if (locked) {
        actionHtml = '<button class="button button-primary is-pseudo-disabled js-buy-series" type="button" data-id="' + test.id + '">Locked 🔒</button>';
        reportHtml = '<button class="button button-secondary js-buy-series" type="button" data-id="' + test.id + '">Buy Series</button>';
      }

      var filterCategory = test.isFree ? "free" : "paid";
      var isCompletedStr = latestSubmitted ? "true" : "false";

      return (
        '<article class="dashboard-test-row animate-fade-in-up" data-filter-type="' + filterCategory + '" data-completed="' + isCompletedStr + '" style="animation-delay: ' + (180 + index * 40) + 'ms;">' +
        '<div class="test-row-num">' + itemNumStr + '</div>' +
        '<div class="test-row-main">' +
        '<div class="test-row-header">' +
        '<span class="test-type-tag">' + escapeHtml(sectionLabel) + '</span>' +
        (locked ? '<span class="status-indicator is-locked">LOCKED</span>' : (inProgress ? '<span class="status-indicator is-live">IN PROGRESS</span>' : (latestSubmitted ? '<span class="status-indicator is-completed">COMPLETED</span>' : '<span class="status-indicator is-available">AVAILABLE</span>'))) +
        '</div>' +
        '<h3 class="test-row-title">' + escapeHtml(test.title) + '</h3>' +
        '<p class="test-row-subtitle">' + escapeHtml(test.subtitle || "Full timed practice paper.") + '</p>' +
        '<div class="test-row-meta">' +
        '<span>' + getTotalDuration(test) + ' MINS</span>' +
        '<span>&bull;</span>' +
        '<span>' + (Number(test.questionCount || 0) || test.questionIds.length) + ' Qs</span>' +
        '<span>&bull;</span>' +
        '<span>SUPR / REAP</span>' +
        (latestSubmitted ? ('<span>&bull;</span><span class="best-score-tag">BEST: ' + escapeHtml(String(latestSubmitted.result ? latestSubmitted.result.score : 0)) + ' (' + escapeHtml(String(latestSubmitted.result ? latestSubmitted.result.percentile : 0)) + '%ile)</span>') : '') +
        '</div>' +
        '</div>' +
        '<div class="test-row-actions">' +
        actionHtml + reportHtml + (locked ? '' : '<button class="button button-secondary button-compact js-plan-test" data-id="' + test.id + '">' + (nextPlannedEvent ? 'Edit Plan' : 'Plan Mock') + '</button>') +
        '</div>' +
        '</article>'
      );
    }).join("");

    var recentAttempts = snapshot.attempts.length
      ? '<div class="attempt-list compact-timeline">' + snapshot.attempts.slice(0, 5).map(function (attempt) {
        var test = store.getTestById(attempt.testId);
        var isSubmitted = attempt.status === "submitted";
        var stateLabel = isSubmitted
          ? "Score: " + attempt.result.score + " (" + attempt.result.percentile + "%ile)"
          : "In progress";

        return (
          '<div class="timeline-item">' +
          '<div class="timeline-bullet ' + (isSubmitted ? 'is-completed' : 'is-active') + '"></div>' +
          '<div class="timeline-body">' +
          '<strong>' + escapeHtml(test ? test.title : attempt.testId) + '</strong>' +
          '<span class="timeline-meta">' + escapeHtml(stateLabel) + ' &bull; ' + formatDateOnly(attempt.updatedAt) + '</span>' +
          '</div>' +
          '</div>'
        );
      }).join("") + '</div>'
      : '<div class="portal-empty-card"><div class="portal-empty-icon" aria-hidden="true">⏱</div><h4 class="portal-empty-title">No Attempts Yet</h4><p class="portal-empty-text">Complete your first mock test to track performance metrics and score history here.</p></div>';

    var noticeBoardHtml = appConfig && (appConfig.noticeTitle || appConfig.noticeBody)
      ? (
        '<div class="dashboard-notice-card">' +
        '<p class="section-label">Notice Board</p>' +
        (appConfig.noticeTitle ? '<h3>' + escapeHtml(appConfig.noticeTitle) + '</h3>' : "") +
        (appConfig.noticeBody ? '<p>' + escapeHtml(appConfig.noticeBody).replace(/\n/g, "<br>") + '</p>' : "") +
        '</div>'
      )
      : '<div class="dashboard-notice-card"><p class="section-label">Notice Board</p><div class="portal-empty-card"><div class="portal-empty-icon" aria-hidden="true">📌</div><h4 class="portal-empty-title">No Announcements</h4><p class="portal-empty-text">Check back later for portal updates, exam schedules, and news.</p></div></div>';

    var reportsHtml = snapshot.attempts.filter(function (attempt) {
      return attempt.status === "submitted" && attempt.resultSnapshot;
    }).length
      ? '<div class="attempt-list list-scroll-card">' + snapshot.attempts.filter(function (attempt) {
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
          '<div class="button-row u-mt-sm"><button class="button button-secondary js-open-result" data-id="' + attempt.id + '">Open Report</button></div>' +
          '</div>'
        );
      }).join("") + '</div>'
      : '<div class="portal-empty-card"><div class="portal-empty-icon" aria-hidden="true">📊</div><h4 class="portal-empty-title">No Reports Available</h4><p class="portal-empty-text">Submitted exam reports will appear here for post-exam review and detailed analysis.</p></div>';

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
    var alertsEnabled = localStorage.getItem("planner_alerts_enabled") === "true";
    var notificationPromptHtml = ("Notification" in window)
      ? '<label style="display:flex; align-items:center; gap:8px; cursor:pointer;" title="Toggle browser push notifications"><input type="checkbox" id="planner-alert-toggle" ' + (alertsEnabled && Notification.permission === "granted" ? 'checked' : '') + ' style="margin:0;"><span class="meta-chip" style="margin:0;">Browser alerts</span></label>'
      : '';
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
    var calendarHtml = buildEditorialCalendarHtml(plannerEvents, runtime.dashboardReminderDate, runtime.dashboardCalendarMonth, appConfig);

    var plannerModalHtml = (runtime.dashboardPlannerModalDate || runtime.dashboardScheduleModalTestId)
      ? (
        '<div class="transition-modal planner-modal-overlay" id="planner-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="planner-modal-title">' +
        '<div class="planner-modal-card">' +
        '<div class="planner-modal-head"><div><p class="section-label" style="margin:0;">Planner</p><h3 id="planner-modal-title">' + escapeHtml(runtime.dashboardPlannerModalDate ? ('Plans for ' + formatDateOnly(runtime.dashboardPlannerModalDate)) : 'Schedule mock') + '</h3></div><button class="button button-secondary button-compact" type="button" id="planner-modal-close" aria-label="Close planner dialog">Close</button></div>' +
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
      renderPrimaryNav("dashboard", user) +
      '<div class="dashboard-layout-shell">' +
      '<section class="dashboard-greeting-hero animate-fade-in-up" style="animation-delay: 0ms;">' +
      '<div class="dashboard-greeting-hero-content">' +
      '<div class="hero-eyebrow-row">' +
      '<span class="section-label">DASHBOARD</span>' +
      '<span class="aceiiit-signature-dot">&bull;</span>' +
      '<span class="editorial-meta-date">' + escapeHtml(formatDateOnly(new Date()).toUpperCase()) + ' &bull; UGEE 2027 PREPARATION</span>' +
      '</div>' +
      '<h1 class="hero-title">' + escapeHtml(getDashboardGreeting()) + '<br>' + escapeHtml(firstName(user.name)) + '</h1>' +
      '<p class="hero-subtitle">Your preparation, ' +
      '<span class="t-think" role="status" id="t-think-container" data-states="assessed.,evaluated.,tested.,sharpened.,refined.,validated.,challenged.,calibrated.,benchmarked.,quantified.,verified.,perfected.">' +
      '<span class="t-think-sizer" aria-hidden="true">benchmarked.</span>' +
      '<span class="t-think-text" data-text="assessed." id="t-think-active">assessed.</span>' +
      '</span></p>' +
      '</div>' +
      '<div class="dashboard-greeting-mascot">' +
      '<img src="assets/mascot-wave.svg" width="1295" height="1214" alt="ACE IIIT Mascot Waving" fetchpriority="high" decoding="async">' +
      '</div>' +
      '</section>' +
      nextUpHtml +
      '<section class="dashboard-grid-asymmetric">' +
      '<div class="dashboard-main-col">' +
      '<div class="available-tests-header">' +
      '<div class="header-title-group">' +
      '<span class="editorial-num-tag"><svg class="editorial-traced-icon" xmlns="http://www.w3.org/2000/svg" width="93" height="115" viewBox="0 0 93 115"><g shape-rendering="geometricPrecision"><path fill="#3f99e1" fill-rule="evenodd" d="M 27 86 27 91 28 92 28 93 29 93 30 94 32 94 33 95 69 95 69 92 30 92 29 91 29 87 31 85 69 85 69 82 33 82 32 83 30 83 29 84 28 84 28 85 Z M 50 50 50 53 66 53 67 52 68 52 68 51 67 51 66 50 Z M 31 49 34 52 37 52 38 53 43 53 43 50 35 50 33 48 33 43 35 41 67 41 68 40 68 39 67 38 38 38 37 39 34 39 31 42 Z"/><path fill="#d7d6d9" fill-rule="evenodd" d="M 65 87 64 88 32 88 31 89 31 90 32 91 65 91 64 90 64 88 Z M 67 73 66 74 34 74 33 75 33 76 34 76 35 77 67 77 66 76 66 74 Z M 62 59 61 60 30 60 29 61 29 62 30 62 31 63 62 63 61 62 61 60 Z M 50 47 50 49 65 49 63 47 Z M 35 48 36 48 37 49 43 49 43 47 39 47 38 46 38 45 39 44 63 44 37 44 36 45 35 45 Z"/><path fill="#ff5128" fill-rule="evenodd" d="M 29 72 29 77 30 78 30 79 31 79 32 80 34 80 35 81 71 81 71 78 33 78 31 76 31 73 33 71 71 71 71 68 35 68 34 69 32 69 31 70 30 70 30 71 Z M 44 47 44 54 44 53 46 51 47 51 49 53 49 54 49 47 Z"/><path fill="#ff9718" fill-rule="evenodd" d="M 25 58 25 63 28 66 30 66 31 67 67 67 67 64 28 64 27 63 27 58 28 57 67 57 67 54 50 54 49 55 48 54 45 54 44 55 43 54 31 54 30 55 28 55 Z"/><path fill="#c5c4c9" fill-rule="evenodd" d="M 31 87 64 87 65 86 32 86 Z M 32 74 33 73 66 73 67 72 34 72 Z M 28 60 29 59 61 59 62 58 30 58 Z M 40 45 40 46 62 46 62 45 Z M 34 45 36 43 63 43 64 42 37 42 36 43 35 43 35 44 Z"/><path fill="#55a3e2" fill-rule="evenodd" d="M 68 38 69 39 69 40 68 41 69 40 69 39 Z"/></g></svg></span>' +
      '<div>' +
      '<p class="section-label" style="margin: 0 0 2px;">EXAMINATION CATALOGUE</p>' +
      '<h2 class="editorial-section-heading">AVAILABLE TESTS</h2>' +
      '</div>' +
      '</div>' +
      '<div class="test-filter-tabs" role="tablist">' +
      '<button type="button" class="filter-tab-btn is-active js-filter-test" data-filter="all">ALL</button>' +
      '<button type="button" class="filter-tab-btn js-filter-test" data-filter="free">FREE</button>' +
      '<button type="button" class="filter-tab-btn js-filter-test" data-filter="paid">PAID</button>' +
      '<button type="button" class="filter-tab-btn js-filter-test" data-filter="completed">COMPLETED</button>' +
      '</div>' +
      '</div>' +
      '<div class="dashboard-editorial-list" id="available-tests-list" style="margin-bottom: 48px;">' + cards + '</div>' +

      '<div class="rail-block" style="border-top: 1px solid var(--border-color); padding-top: 24px; margin-top: auto;">' +
      '<div class="rail-header">' +
      '<span class="editorial-num-tag"><svg class="editorial-traced-icon" xmlns="http://www.w3.org/2000/svg" width="72" height="90" viewBox="0 0 72 90"><g shape-rendering="geometricPrecision"><path fill="#000000" fill-rule="evenodd" d="M 10 75 10 76 19 76 11 76 Z M 62 71 63 71 64 72 64 74 64 72 63 71 Z M 9 63 9 64 8 65 9 64 Z M 22 36 21 37 21 38 20 39 18 39 19 40 19 42 20 43 21 42 20 43 19 42 19 41 22 38 23 38 23 37 Z M 42 30 41 29 40 29 39 28 34 28 33 27 31 27 30 26 30 25 30 26 31 27 29 29 28 29 27 28 26 28 26 29 25 30 26 31 25 32 23 32 21 34 24 34 25 35 26 35 25 34 25 33 26 32 27 32 28 33 29 33 30 34 29 35 30 36 30 40 32 38 32 37 33 36 38 36 39 35 41 35 41 34 42 33 Z M 37 33 38 34 36 36 35 36 34 35 36 33 Z M 38 30 39 29 40 30 39 31 Z M 26 31 28 29 29 29 30 30 30 31 29 32 27 32 Z M 33 30 33 29 34 28 38 28 39 29 37 31 36 31 35 30 34 31 Z M 29 29 30 28 31 29 30 30 Z"/><path fill="#125fa4" fill-rule="evenodd" d="M 25 65 26 65 27 66 32 66 31 66 30 65 28 65 27 66 26 65 Z M 19 47 14 52 14 53 13 54 14 54 15 53 16 53 17 54 16 55 16 57 15 58 15 59 14 60 14 61 12 63 11 62 11 60 12 59 11 59 11 64 10 65 10 71 11 72 11 74 25 74 25 73 23 73 22 72 21 72 18 69 18 68 16 66 17 65 18 65 19 64 20 65 19 64 19 63 18 62 18 61 19 60 23 64 23 62 21 60 21 59 20 58 20 57 19 58 18 57 18 50 19 49 Z M 13 65 14 66 14 67 13 68 14 69 14 70 12 72 11 71 11 70 10 69 10 68 Z"/><path fill="#b4783e" fill-rule="evenodd" d="M 38 74 55 74 56 73 63 73 47 73 46 74 Z M 64 69 55 69 54 70 36 70 36 71 41 71 42 70 64 70 Z M 6 59 5 60 5 67 6 68 6 72 7 73 7 75 8 75 8 73 7 72 7 66 6 65 Z M 40 58 40 59 41 60 40 59 Z M 49 31 49 32 51 34 52 34 51 34 49 32 Z M 60 19 64 23 64 30 59 35 54 35 59 35 60 34 61 34 62 33 62 32 64 30 64 23 Z M 58 18 54 18 53 19 52 19 49 22 49 24 48 25 48 29 48 25 49 24 49 22 51 20 52 20 54 18 Z"/><path fill="#0082c9" fill-rule="evenodd" d="M 18 66 19 67 19 68 22 71 23 71 24 72 25 72 26 73 26 74 28 74 28 73 29 72 29 70 28 69 26 69 25 68 24 68 23 67 22 67 21 66 Z M 20 49 19 50 20 51 19 52 19 55 20 55 22 57 22 59 24 61 25 61 27 63 29 63 30 64 32 64 33 65 33 66 32 67 34 67 35 66 36 66 37 65 37 62 34 62 33 61 30 61 29 60 26 60 25 59 24 59 21 56 21 55 20 54 21 53 22 53 25 56 26 56 27 57 28 57 28 56 26 54 25 54 Z"/><path fill="#d3a274" fill-rule="evenodd" d="M 43 64 41 64 40 63 40 66 39 67 41 67 43 65 Z M 41 38 40 37 39 37 38 38 34 38 33 39 33 40 31 42 24 42 23 41 23 43 22 44 22 45 21 46 22 47 22 48 23 48 22 47 22 44 23 43 24 43 25 44 25 46 28 49 31 49 30 48 30 47 31 46 31 45 32 44 33 45 33 46 34 47 34 48 35 48 36 47 37 47 38 46 39 46 40 47 41 47 39 45 39 43 40 42 40 41 41 40 Z M 37 39 39 41 39 43 38 44 36 44 35 43 35 41 Z"/><path fill="#65523f" fill-rule="evenodd" d="M 38 76 39 75 44 75 39 75 Z M 51 68 52 68 53 69 52 68 Z M 62 64 61 65 61 66 61 65 Z M 5 59 4 60 4 62 3 63 4 62 4 60 Z M 39 56 39 57 40 57 40 56 Z M 27 40 26 41 25 41 26 41 Z M 59 33 59 34 60 35 59 34 Z M 48 24 49 25 50 24 49 25 Z M 57 22 57 24 56 25 56 26 56 25 57 24 Z M 50 20 51 21 50 22 51 22 51 21 Z M 61 19 63 21 64 20 63 19 62 20 Z M 62 20 63 19 64 20 63 21 Z"/><path fill="#513928" fill-rule="evenodd" d="M 9 75 7 77 8 77 8 76 Z M 61 74 60 74 59 75 60 75 Z M 36 72 37 72 38 73 40 73 39 73 38 72 Z M 65 69 65 70 66 71 65 70 Z M 53 68 52 69 43 69 52 69 Z M 39 68 38 67 38 68 37 69 36 69 35 70 34 69 35 70 36 69 38 69 Z M 7 62 7 63 8 63 Z M 41 59 40 60 41 61 40 60 Z M 29 39 28 40 29 40 Z M 57 16 56 17 55 17 57 17 Z"/><path fill="#242726" fill-rule="evenodd" d="M 38 60 38 61 39 61 Z M 27 26 28 27 28 28 29 27 28 27 Z"/><path fill="#1e1915" fill-rule="evenodd" d="M 56 71 55 71 54 72 51 72 55 72 Z M 40 61 41 62 42 62 41 62 Z M 22 39 21 40 22 40 Z M 51 32 52 33 53 33 52 33 Z M 25 29 22 32 21 32 22 32 Z M 23 27 22 26 21 27 22 26 Z"/><path fill="#d6d6d1" fill-rule="evenodd" d="M 51 29 51 30 52 31 54 31 53 30 53 29 Z M 61 23 59 21 58 21 57 20 56 20 55 21 54 21 53 22 52 22 51 23 51 27 51 25 55 21 56 21 57 20 58 21 58 22 60 24 61 24 Z"/><path fill="#b5b5b4" fill-rule="evenodd" d="M 66 72 65 73 65 74 65 73 Z M 58 25 58 26 59 25 60 25 61 26 60 27 61 26 60 25 Z"/><path fill="#080808" fill-rule="evenodd" d="M 47 31 48 32 48 33 48 32 Z M 20 28 20 29 19 30 19 31 20 31 19 30 20 29 Z"/><path fill="#0e1518" fill-rule="evenodd" d="M 22 65 23 66 23 65 Z M 29 57 28 58 29 59 Z M 14 55 13 56 14 57 13 58 14 57 13 56 Z M 28 53 28 54 29 54 Z M 35 27 36 27 37 26 36 27 35 26 Z"/><path fill="#164568" fill-rule="evenodd" d="M 24 63 24 65 25 64 26 64 27 65 26 66 27 65 26 64 26 63 Z M 19 61 19 62 20 62 22 64 Z M 15 54 15 55 13 57 14 58 12 60 13 61 13 60 14 59 14 58 15 57 14 56 15 55 Z M 13 57 14 56 15 57 14 58 Z"/><path fill="#868684" fill-rule="evenodd" d="M 31 69 33 69 34 70 33 69 Z M 52 66 51 67 52 67 Z M 59 27 59 28 57 30 59 28 Z"/><path fill="#010101" fill-rule="evenodd" d="M 21 33 20 33 20 34 Z M 23 28 22 29 22 30 23 29 Z"/><path fill="#846d56" fill-rule="evenodd" d="M 50 67 49 68 48 68 50 68 Z M 44 67 44 68 46 68 45 68 Z"/><path fill="#cf9f72" fill-rule="evenodd" d="M 23 49 24 50 25 50 26 51 24 49 Z M 22 43 23 44 23 47 23 45 24 44 23 44 Z M 26 36 28 38 27 39 28 38 28 37 27 37 Z"/><path fill="#0b5f9e" fill-rule="evenodd" d="M 11 69 12 69 13 70 12 71 13 70 12 69 Z M 22 54 24 56 23 57 24 56 Z"/><path fill="#0772b6" fill-rule="evenodd" d="M 19 57 20 56 21 57 21 58 21 57 22 56 21 57 20 56 19 56 Z"/></g></svg></span>' +
      '<p class="section-label">NOTICE BOARD</p>' +
      '</div>' +
      noticeBoardHtml +
      '</div>' +

      '</div>' + // end dashboard-main-col
      '<aside class="dashboard-sidebar-rail">' +
      '<div class="rail-block">' +
      '<div class="rail-header">' +
      '<span class="editorial-num-tag"><svg class="editorial-traced-icon" xmlns="http://www.w3.org/2000/svg" width="72" height="90" viewBox="0 0 72 90"><g shape-rendering="geometricPrecision"><path fill="#000000" fill-rule="evenodd" d="M 25 67 25 68 25 67 26 66 39 66 40 67 40 68 40 67 39 66 39 63 39 65 38 66 27 66 26 65 26 63 26 66 Z M 42 61 42 63 43 63 44 64 46 62 46 61 Z M 19 61 19 62 21 64 22 63 23 63 23 61 Z M 8 40 8 42 9 42 10 43 10 68 10 59 11 58 54 58 55 59 55 68 55 43 56 42 57 42 57 40 Z M 49 35 48 34 48 32 47 31 47 29 46 28 46 26 45 25 45 24 44 23 44 21 44 28 45 29 45 30 46 31 45 32 43 32 42 31 41 31 40 30 38 30 37 31 35 31 34 30 32 30 31 29 26 29 20 35 20 36 21 37 30 37 31 36 30 35 24 35 23 34 26 31 27 32 28 32 27 31 28 30 29 30 33 34 33 35 34 36 34 37 39 37 39 33 40 32 41 33 42 33 43 34 44 34 45 35 46 35 47 36 49 36 Z M 34 17 33 18 32 18 31 19 31 21 30 22 30 23 31 24 31 25 33 27 34 27 35 28 38 28 41 25 41 24 42 23 42 21 41 20 41 19 39 17 Z M 31 24 32 23 37 23 39 25 39 26 38 27 37 27 36 26 32 26 31 25 Z M 23 12 24 13 26 13 25 12 Z M 30 10 31 11 31 12 31 11 Z"/><path fill="#cecece" fill-rule="evenodd" d="M 12 59 24 59 25 60 26 59 39 59 40 60 41 59 53 59 Z"/><path fill="#737373" fill-rule="evenodd" d="M 43 12 42 13 43 13 Z"/><path fill="#5a5a5a" fill-rule="evenodd" d="M 38 60 38 61 39 61 Z M 27 60 26 61 27 61 Z M 46 16 48 18 48 19 48 18 Z"/></g></svg></span>' +
      '<p class="section-label">RECENT ACTIVITY</p>' +
      '</div>' +
      recentAttempts +
      '</div>' +
      '<div class="rail-divider"></div>' +
      '<div class="rail-block">' +
      '<div class="rail-header" style="display: flex; align-items: center;">' +
      '<span class="editorial-num-tag"><svg class="editorial-traced-icon" xmlns="http://www.w3.org/2000/svg" width="93" height="115" viewBox="0 0 93 115"><g shape-rendering="geometricPrecision"><path fill="#c76d39" fill-rule="evenodd" d="M 27 57 27 60 76 60 76 57 Z"/><path fill="#000000" fill-rule="evenodd" d="M 73 76 55 76 54 75 54 62 54 64 53 65 30 65 53 65 54 66 54 75 55 76 Z M 62 44 72 44 73 45 73 47 73 45 72 44 Z M 78 55 71 55 70 54 70 52 70 54 69 55 60 55 59 54 59 42 59 54 58 55 45 55 44 54 43 55 25 55 Z"/><path fill="#2f1c10" fill-rule="evenodd" d="M 74 62 74 68 73 69 74 70 74 75 Z M 65 48 74 48 75 49 75 50 74 51 65 51 74 51 75 50 75 49 74 48 Z M 41 32 42 33 42 34 43 34 Z"/><path fill="#a75225" fill-rule="evenodd" d="M 75 63 75 84 76 84 76 63 Z M 27 63 27 84 28 84 28 63 Z"/><path fill="#858585" fill-rule="evenodd" d="M 75 47 76 48 76 51 75 52 72 52 75 52 76 51 76 48 Z M 26 34 25 35 26 36 27 35 Z M 25 35 26 34 27 35 26 36 Z"/><path fill="#3a444b" fill-rule="evenodd" d="M 73 68 72 69 55 69 72 69 Z M 29 53 29 54 35 54 35 53 Z M 52 44 52 46 50 48 51 49 51 54 52 53 Z M 52 41 53 42 54 42 55 41 58 41 Z M 73 33 72 34 72 36 75 36 75 34 74 33 Z"/><path fill="#120e0b" fill-rule="evenodd" d="M 26 62 27 61 28 61 29 62 30 61 76 61 77 62 76 61 27 61 Z M 50 42 51 43 52 42 51 43 Z M 71 34 71 36 73 38 71 36 Z"/><path fill="#f6cd91" fill-rule="evenodd" d="M 56 70 56 74 72 74 72 70 Z M 61 72 62 71 65 71 66 72 66 73 65 74 62 74 61 73 Z"/><path fill="#cdb587" fill-rule="evenodd" d="M 55 70 55 74 56 75 72 75 56 75 55 74 Z"/><path fill="#eaeaea" fill-rule="evenodd" d="M 53 76 54 77 72 77 54 77 Z M 71 53 72 54 78 54 72 54 Z"/><path fill="#ffdfb2" fill-rule="evenodd" d="M 56 63 56 67 72 67 72 63 Z M 61 65 63 63 65 63 67 65 66 66 62 66 Z"/><path fill="#85b393" fill-rule="evenodd" d="M 63 45 63 46 72 46 71 45 Z M 53 43 53 53 54 53 54 43 Z"/><path fill="#76736c" fill-rule="evenodd" d="M 73 63 73 67 72 68 56 68 72 68 73 67 Z"/><path fill="#ef2d3a" fill-rule="evenodd" d="M 60 53 60 54 69 54 69 53 Z M 50 43 49 43 48 44 48 46 47 47 47 49 46 50 46 52 45 53 46 53 47 52 47 50 48 49 48 47 49 46 49 44 Z"/><path fill="#202534" fill-rule="evenodd" d="M 75 33 76 34 76 35 77 34 76 34 Z"/><path fill="#ffd300" fill-rule="evenodd" d="M 41 34 40 34 39 33 37 33 35 35 35 36 36 37 36 38 37 39 40 36 40 35 Z"/><path fill="#da9542" fill-rule="evenodd" d="M 66 49 66 50 74 50 74 49 Z M 34 31 32 33 33 34 34 33 Z"/></g></svg></span>' +
      '<p class="section-label" style="margin-left: 8px;">EXAM CALENDAR</p>' +
      renderGoogleCalendarControl() +
      '</div>' +
      calendarHtml +
      '</div>' +
      '<div class="rail-divider"></div>' +
      '<div class="rail-block">' +
      '<div class="rail-header">' +
      '<span class="editorial-num-tag"><svg class="editorial-traced-icon" xmlns="http://www.w3.org/2000/svg" width="72" height="90" viewBox="0 0 72 90"><g shape-rendering="geometricPrecision"><path fill="#000000" fill-rule="evenodd" d="M 43 57 43 76 46 76 46 57 Z M 64 51 63 51 62 52 60 52 59 53 57 53 56 54 54 54 53 55 52 55 51 56 50 56 50 75 52 75 53 74 54 74 55 73 57 73 58 72 60 72 61 71 63 71 64 70 Z M 26 51 26 70 27 71 29 71 30 72 31 72 32 73 34 73 35 74 37 74 38 75 40 75 40 56 39 56 38 55 36 55 35 54 33 54 32 53 30 53 29 52 28 52 27 51 Z M 7 64 22 64 22 47 23 46 24 47 26 47 27 48 29 48 30 49 32 49 33 50 35 50 36 51 37 51 38 52 40 52 41 53 48 53 49 52 48 51 48 49 46 47 46 46 45 45 44 45 42 43 41 43 40 42 38 42 37 41 36 41 35 42 33 42 32 43 24 43 23 42 22 42 21 41 19 41 18 42 16 42 15 43 14 43 8 49 8 52 7 53 Z M 53 39 53 41 59 41 59 39 Z M 54 22 53 23 52 23 50 25 50 26 49 27 49 30 50 31 50 32 51 33 51 34 52 35 52 36 53 36 53 32 52 32 49 29 49 28 50 27 50 26 52 24 53 24 56 27 56 28 56 26 58 24 59 24 60 25 61 25 62 26 62 30 61 31 60 31 59 32 59 36 60 35 60 34 61 33 61 32 62 31 62 26 61 25 61 24 60 23 59 23 58 22 Z M 29 17 28 17 27 18 24 18 23 19 22 19 19 22 19 23 18 24 18 25 17 26 17 31 18 32 18 34 22 38 23 38 24 39 25 39 26 40 30 40 31 39 33 39 38 34 38 33 39 32 39 25 38 24 38 23 34 19 33 19 32 18 30 18 Z"/><path fill="#5f5f5f" fill-rule="evenodd" d="M 54 45 55 44 57 44 54 44 Z"/><path fill="#c3c3c3" fill-rule="evenodd" d="M 27 41 28 42 29 41 28 42 Z"/><path fill="#525252" fill-rule="evenodd" d="M 50 55 49 56 49 76 49 56 Z"/><path fill="#303030" fill-rule="evenodd" d="M 47 57 47 76 46 77 43 77 46 77 47 76 Z"/><path fill="#b6b6b6" fill-rule="evenodd" d="M 55 32 55 36 56 37 55 36 Z"/><path fill="#e7e7e7" fill-rule="evenodd" d="M 53 38 59 38 55 38 54 37 Z"/></g></svg></span>' +
      '<p class="section-label">YOUR PROGRESS</p>' +
      '</div>' +
      '<div class="progress-rail-grid">' +
      '<div class="progress-rail-col">' +
      '<strong class="metric-val">' + (completedCount < 10 ? '0' + completedCount : completedCount) + '</strong>' +
      '<span class="metric-label">Completed</span>' +
      '</div>' +
      '<div class="progress-rail-col">' +
      '<strong class="metric-val">' + (attemptedCount < 10 ? '0' + attemptedCount : attemptedCount) + '</strong>' +
      '<span class="metric-label">Attempted</span>' +
      '</div>' +
      '<div class="progress-rail-col">' +
      '<strong class="metric-val">' + (averageScore > 0 ? (averageScore + '%') : '—') + '</strong>' +
      '<span class="metric-label">Average</span>' +
      '</div>' +
      '<div class="progress-rail-col">' +
      '<strong class="metric-val">' + (bestScore > 0 ? bestScore : '—') + '</strong>' +
      '<span class="metric-label">Best (' + (bestPercentile > 0 ? (bestPercentile + '%ile') : '—') + ')</span>' +
      '</div>' +
      '</div>' +
      '</div>' +
      qotdHtml +
      '</aside>' +
      '</section>' +
      '</div>' +
      plannerModalHtml,
      { fluid: true }
    );

    // Attach filter tab listeners
    var filterBtns = document.querySelectorAll(".js-filter-test");
    filterBtns.forEach(function (btn) {
      btn.addEventListener("click", function () {
        filterBtns.forEach(function (b) { b.classList.remove("is-active"); });
        btn.classList.add("is-active");
        var filter = btn.getAttribute("data-filter");
        var rows = document.querySelectorAll(".dashboard-test-row");
        rows.forEach(function (row) {
          var type = row.getAttribute("data-filter-type");
          var isCompleted = row.getAttribute("data-completed") === "true";
          if (filter === "all") {
            row.style.display = "";
          } else if (filter === "free") {
            row.style.display = type === "free" ? "" : "none";
          } else if (filter === "paid") {
            row.style.display = type === "paid" ? "" : "none";
          } else if (filter === "completed") {
            row.style.display = isCompleted ? "" : "none";
          }
        });
      });
    });



    var adminLink = document.getElementById("admin-link");
    if (adminLink) {
      adminLink.addEventListener("click", function () {
        navigate("admin");
      });
    }

    var qotdOptions = app.querySelectorAll(".js-qotd-option");
    qotdOptions.forEach(function (button) {
      button.addEventListener("click", async function () {
        if (button.hasAttribute("disabled") || !qotd) return;
        qotdOptions.forEach(function (b) { b.disabled = true; });
        var resultMsg = app.querySelector(".js-qotd-result");
        try {
          var result = await store.submitQotdAttempt({ questionId: qotd.id, selectedOption: Number(button.dataset.idx) });
          applyQotdResult(result);
        } catch (error) {
          if (error && error.code === "QOTD_ALREADY_ATTEMPTED" && error.data && error.data.result) {
            applyQotdResult(error.data.result);
            return;
          }
          qotdOptions.forEach(function (b) { b.disabled = false; });
          if (resultMsg) resultMsg.textContent = error && error.message ? error.message : "Could not submit your answer. Please try again.";
        }

        function applyQotdResult(result) {
          if (!result) return;
          qotdOptions.forEach(function (b) {
            var idx = Number(b.dataset.idx);
            if (idx === Number(result.correctOption)) b.classList.add("is-correct");
            if (idx === Number(result.selectedOption) && !result.correct) b.classList.add("is-wrong");
          });
          if (resultMsg) {
            resultMsg.textContent = describeQotdResult(result);
            resultMsg.classList.add(result.correct ? "show-correct" : "show-wrong");
            if (result.explanation) {
              var explanation = document.createElement("div");
              explanation.className = "qotd-explanation rich-text";
              explanation.innerHTML = formatRichText(result.explanation);
              resultMsg.parentNode.insertBefore(explanation, resultMsg.nextSibling);
              renderLatexInElement(explanation);
            }
          }
        }
      });
    });

    // Render LaTeX for Question of the Day
    var qotdCard = app.querySelector(".qotd-card");
    if (qotdCard && window.renderMathInElement) {
      try {
        window.renderMathInElement(qotdCard, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "$", right: "$", display: false },
            { left: "\\(", right: "\\)", display: false },
            { left: "\\[", right: "\\]", display: true }
          ],
          throwOnError: false
        });
      } catch (e) {
        console.error("KaTeX error in QOTD", e);
      }
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
        launchExam(user, button.dataset.id);
      });
    });

    app.querySelectorAll(".js-quit-attempt").forEach(function (button) {
      button.addEventListener("click", function () {
        var attemptId = button.dataset.attempt;
        if (!attemptId) {
          return;
        }
        var shouldQuit = window.confirm("Quit this unfinished test?\n\nIt will be submitted with the answers saved so far and counted as an attempt.");
        if (!shouldQuit) {
          return;
        }
        if (runtime.attemptId === attemptId) {
          stopRuntime(true);
        }
        Promise.resolve(store.discardAttempt(attemptId))
          .catch(function (error) {
            window.alert(error && error.message ? error.message : "Could not quit this test. Please try again.");
          })
          .finally(function () {
            renderDashboard(user);
          });
      });
    });

    app.querySelectorAll(".js-restart-attempt").forEach(function (button) {
      button.addEventListener("click", function () {
        var attemptId = button.dataset.attempt;
        var testId = button.dataset.id;
        var shouldRestart = window.confirm("Restart this test?\n\nThe unfinished attempt will be submitted with the answers saved so far, and a fresh attempt will begin.");
        if (!shouldRestart) {
          return;
        }
        if (attemptId && runtime.attemptId === attemptId) {
          stopRuntime(true);
        }
        Promise.resolve(attemptId ? store.discardAttempt(attemptId) : null)
          .then(function () {
            navigate("instructions/" + testId);
          })
          .catch(function (error) {
            window.alert(error && error.message ? error.message : "Could not restart this test. Please try again.");
          });
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
      if (existingAttempt) {
        launchExam(user, testId);
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
    var alertToggle = document.getElementById("planner-alert-toggle");
    if (alertToggle) {
      alertToggle.addEventListener("change", function (e) {
        if (e.target.checked) {
          requestPlannerNotificationPermission().then(function (perm) {
            if (perm === "granted") {
              localStorage.setItem("planner_alerts_enabled", "true");
              schedulePlannerNotifications(buildPlannerEvents(store.getDashboardSnapshot(user.id), store.listReminders ? store.listReminders() : []));
            } else {
              e.target.checked = false;
              localStorage.setItem("planner_alerts_enabled", "false");
            }
            renderDashboard(user);
          });
        } else {
          localStorage.setItem("planner_alerts_enabled", "false");
          schedulePlannerNotifications([]); // Clear current timers
          renderDashboard(user);
        }
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
      var plannerCard = plannerModalOverlay.querySelector(".planner-modal-card");
      if (plannerCard) {
        clearActiveRenderModal();
        activeRenderModalCleanup = activateModalFocus(plannerCard, {
          titleId: "planner-modal-title",
          onEscape: closePlannerModal
        });
      }
      plannerModalOverlay.addEventListener("click", function (event) {
        if (event.target === plannerModalOverlay) {
          closePlannerModal();
        }
      });
    } else {
      clearActiveRenderModal();
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

          if (!runtime.googleCalendarState || runtime.googleCalendarState.status !== "connected" || !runtime.googleCalendarState.autoAddEnabled) {
            function toGCalUTC(dateStr) {
              return new Date(dateStr).toISOString().replace(/-|:|\.\d\d\d/g, "");
            }
            var gCalPlanDate = payload.remindAt;
            var gCalEndDate = new Date(new Date(gCalPlanDate).getTime() + 3 * 60 * 60 * 1000).toISOString();
            var gCalTitle = encodeURIComponent(payload.title || "ACE IIIT Mock Plan");
            var gCalOrigin = window.location.origin || "https://portal.aceiiit.in";
            var gCalLink = payload.testId ? gCalOrigin + "/#instructions/" + payload.testId : gCalOrigin + "/#dashboard";
            var gCalDesc = "Subject Focus: " + (payload.subjectFocus || []).join(", ") + "\n\nLink: " + gCalLink;
            if (payload.notes) gCalDesc += "\n\nNotes: " + payload.notes;
            gCalDesc = encodeURIComponent(gCalDesc);

            var gCalUrl = "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + gCalTitle +
              "&dates=" + toGCalUTC(gCalPlanDate) + "/" + toGCalUTC(gCalEndDate) +
              "&details=" + gCalDesc;
            window.open(gCalUrl, "_blank");
          }

          runtime.dashboardReminderDate = String(form.get("date") || runtime.dashboardReminderDate);
          runtime.dashboardPlannerModalDate = runtime.dashboardReminderDate;
          runtime.dashboardScheduleModalTestId = "";
          runtime.dashboardNotificationMessage = "Planner updated for " + String(form.get("title") || "your mock") + ".";
          await store.refreshFromRemote();
          schedulePlannerNotifications(buildPlannerEvents(store.getDashboardSnapshot(user.id), store.listReminders ? store.listReminders() : []));
          renderDashboard(user);
        } catch (err) {
          console.error("Failed to save plan:", err);
          var msg = err.error || err.message || "Failed to save plan. Please check your inputs.";
          if (err.response && err.response.error) msg = err.response.error;
          window.alert(msg);
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
    initSubtitleGlider();
  }

  function syncAndRenderCurrentRoute(options) {
    var currentView = routeParts()[0] || "";
    var settings = options || {};
    var shouldShowOverlay = settings.showOverlay !== undefined ? !!settings.showOverlay : !settings.silent;
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
    if (shouldShowOverlay) {
      showOverlayLoader("Syncing...", { delayMs: 420 });
    }
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
      if (shouldShowOverlay) {
        window.requestAnimationFrame(function () {
          window.setTimeout(hideOverlayLoader, 180);
        });
      }
      if (syncQueued) {
        syncQueued = false;
        window.setTimeout(function () {
          syncAndRenderCurrentRoute(settings);
        }, 0);
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
            syncAndRenderCurrentRoute({ silent: true });
          }
        });
      }
    }, 15000);
  }

  function renderInstructions(user, testId, prefetchedQuestions) {
    // Students never receive questions before the exam session starts: counts and marks come
    // from the catalog's server-computed `sectionSummary`. Admins may still preview questions.
    var initialQuestions = Array.isArray(prefetchedQuestions) ? prefetchedQuestions.slice() : store.getQuestionsForTest(testId);
    var test = store.getTestById(testId);
    var questions = initialQuestions.length ? initialQuestions : store.getQuestionsForTest(testId);
    // Practice papers (and, later, paid papers) only reveal questions once the exam session starts.
    var sectionSummaryData = test && test.sectionSummary ? test.sectionSummary : null;
    var totalQuestionCount = questions.length || Number(test && test.questionCount || 0);
    var canLaunchTest = totalQuestionCount > 0;
    var grouped = questions.reduce(function (accumulator, question) {
      accumulator[question.section] = accumulator[question.section] || [];
      accumulator[question.section].push(question);
      return accumulator;
    }, {});

    if (!test) {
      navigate("dashboard");
      return;
    }

    if (isTestLocked(test, user)) {
      app.innerHTML = buildShell(
        '<section class="report-layout">' +
        '<div class="report-bar">' +
        '<div class="brand-mark"><img src="assets/favicon-round.svg" alt="AceIIIT Logo" class="brand-logo" /> AceIIIT</div>' +
        '<div class="button-row">' +
        '<button class="button button-secondary" id="back-dashboard">Dashboard</button>' +
        '</div>' +
        '</div>' +
        '<div class="report-body">' +
        '<div class="report-card">' +
        '<p class="section-label">Paid test</p>' +
        '<h1>Buy Test Series to unlock 🔒</h1>' +
        '<p>This mock is part of the paid test series. Access unlocks automatically once your payment is verified. Use the same email address for checkout and for this portal.</p>' +
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

    var suprMaxMarks = sectionSummaryData ? Number(sectionSummaryData.SUPR.marks || 0) : (grouped.SUPR || []).reduce(function (sum, question) {
      return sum + Number(question.marks || 0);
    }, 0);
    var reapMaxMarks = sectionSummaryData ? Number(sectionSummaryData.REAP.marks || 0) : (grouped.REAP || []).reduce(function (sum, question) {
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
      '<div class="brand-mark"><img src="assets/favicon-round.svg" alt="AceIIIT Logo" class="brand-logo" /> AceIIIT</div>' +
      '<div class="button-row">' +
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
      '<p>No clarification will be provided during the exam. A built-in on-screen calculator is available from the question screen whenever the paper requires it. Your answers are saved to the server automatically as you work, so you can safely recover from a refresh or a dropped connection. The timer is controlled by the server and keeps running even if you close this window.</p>' +
      buildIntegrityDisclosure(test) +
      '<p>This test contains ' + totalQuestionCount + ' questions and the total duration is ' + getTotalDuration(test) + ' minutes.</p>' +
      '</div>' +
      '</div>' +
      '<label class="checkbox-row checkbox-row-utility">' +
      '<input type="checkbox" id="ready-check">' +
      '<span>I have read and understood the instructions, including what is recorded during the exam. I agree to follow the test rules and I am ready to begin.</span>' +
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
      '<p><strong>Questions:</strong> ' + totalQuestionCount + '</p>' +
      '</div>' +
      '</aside>' +
      '</div>' +
      '</section>',
      // Full-height CBT layout like the exam: no chat button (it covered the consent box and
      // Begin button on phones) and no footer (it caused a second, page-level scroll).
      { hideSupportChat: true, hideFooter: true }
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
      beginButton.disabled = true;
      if (window.AceIIIT.examIntegrity && integrityModeOf(test) !== "record") {
        // Must run synchronously inside the click; browsers refuse fullscreen otherwise.
        window.AceIIIT.examIntegrity.requestFullscreen();
      }
      try {
        await launchExam(user, testId);
      } finally {
        beginButton.disabled = false;
      }
    });
  }

  function buildIntegrityDisclosure(test) {
    var mode = integrityModeOf(test);
    var autoSubmit = test && test.integrity ? Number(test.integrity.autoSubmitThreshold || 5) : 5;
    var items = [
      "The timer is controlled by the server and keeps running if you close or refresh this window.",
      "The exam can be open in only one tab or device at a time.",
      mode === "record"
        ? "Basic activity (like switching tabs) is logged for your own review."
        : "The exam opens in full screen. Leaving full screen, switching tabs or windows, copying, pasting, printing and blocked keyboard shortcuts are recorded and shown to the exam administrator.",
    ];
    if (mode === "strict") {
      items.push("Strict mode: after " + autoSubmit + " recorded events, your paper is submitted automatically with the answers saved so far.");
    }
    items.push("Records are reviewed by a person; nothing is decided automatically about your result.");
    return '<p><strong>Exam integrity</strong></p><ul class="integrity-disclosure">' +
      items.map(function (item) { return '<li>' + escapeHtml(item) + '</li>'; }).join("") +
      '</ul>';
  }

  function renderTest(user, attemptId) {
    var attempt = store.getAttemptById(attemptId);
    if (!attempt) {
      stopRuntime(false);
      navigate("dashboard");
      return;
    }
    if (attempt.status === "in_progress" && !attempt.sessionId) {
      // Attempts from older builds weren't bound to a server session.
      window.alert("This unfinished attempt was started on an older version of the portal. Please start the test again.");
      stopRuntime(false);
      store.discardAttempt(attempt.id);
      navigate("dashboard");
      return;
    }

    var test = store.getTestById(attempt.testId);
    if (isAttemptExpired(attempt, test)) {
      stopRuntime(false);
      window.alert("Time is over for this attempt. Your saved answers were submitted automatically.");
      Promise.resolve(store.resolveExpiredAttempt(attempt.id)).then(function (finalized) {
        navigate(finalized ? "results/" + finalized.id : "dashboard");
      }).catch(function () {
        navigate("dashboard");
      });
      return;
    }

    var initialQuestions = store.getQuestionsForTest(attempt.testId);
    var expectedQuestionCount = test ? Number(test.questionCount || 0) : 0;
    if (!initialQuestions.length || (expectedQuestionCount && initialQuestions.length < expectedQuestionCount)) {
      renderLoadingScreen("Loading your question paper.");
      Promise.resolve(store.ensureExamPaper(attempt.id))
        .then(function (paper) {
          if (!paper || !paper.length) {
            throw new Error("Could not load this question paper.");
          }
          renderTest(user, attemptId);
        })
        .catch(function (error) {
          if (error && error.code === "EXAM_ACTIVE_ELSEWHERE") {
            launchExam(user, attempt.testId);
            return;
          }
          window.alert(error && error.message ? error.message : "Could not load this test.");
          navigate("dashboard");
        });
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
        var submittedAttempt;
        try {
          submittedAttempt = await store.submitAttempt(attempt.id);
        } catch (bindingError) {
          if (!(bindingError && bindingError.code === "EXAM_ACTIVE_ELSEWHERE")) {
            throw bindingError;
          }
          hideOverlayLoader();
          if (!window.confirm("This exam was opened in another tab or device. Submit it from this window instead?")) {
            return;
          }
          showOverlayLoader("Submitting your paper.");
          await store.takeoverExam(attempt.sessionId);
          submittedAttempt = await store.submitAttempt(attempt.id);
        }
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
        window.alert((submitError && submitError.message ? submitError.message + "\n\n" : "") + "Your answers are saved on the server. Please check your connection and press Submit again.");
      } finally {
        runtime.submittingAttemptId = null;
        hideOverlayLoader();
      }
    }

    // Locks SUPR on the server; REAP's timer starts at server time.
    async function activateReap() {
      var firstReapQuestion = reapQuestions[0];
      if (!firstReapQuestion) {
        await submitAndNavigate();
        return null;
      }

      flushQuestionTime();
      showOverlayLoader("Starting REAP.");
      try {
        await store.advanceSection(attempt.id);
      } catch (advanceError) {
        hideOverlayLoader();
        window.alert(advanceError && advanceError.message ? advanceError.message : "Could not start REAP. Please try again.");
        return null;
      }
      hideOverlayLoader();
      store.patchAttempt(attempt.id, function (draft) {
        draft.currentQuestionId = firstReapQuestion.id;
        draft.visited[firstReapQuestion.id] = true;
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

    var paletteGridHtml = activeQuestions.map(function (question, sectionIndex) {
      var status = getQuestionStatus(attempt, question.id);
      var currentClass = question.id === currentQuestion.id ? "is-current" : "";
      var statusLabels = {
        "answered": "Answered",
        "not-answered": "Not Answered",
        "marked": "Marked for Review",
        "answered-marked": "Answered & Marked for Review",
        "not-visited": "Not Visited"
      };
      var statusText = statusLabels[status] || status;
      var ariaLabel = "Question " + (sectionIndex + 1) + ", " + statusText + (question.id === currentQuestion.id ? ", Current question" : "");
      return (
        '<button class="palette-button status-' + status + ' ' + currentClass + '" data-question="' + question.id + '" aria-label="' + escapeAttribute(ariaLabel) + '"' + (question.id === currentQuestion.id ? ' aria-current="true"' : '') + '>' +
        (sectionIndex + 1) +
        '</button>'
      );
    }).join("");

    var statusGridHtml =
      '<div class="status-grid">' +
      '<div class="status-item"><span class="status-count answered">' + statusCounts.answered + '</span><span>Answered</span></div>' +
      '<div class="status-item"><span class="status-count not-answered">' + statusCounts["not-answered"] + '</span><span>Not Answered</span></div>' +
      '<div class="status-item"><span class="status-count not-visited">' + statusCounts["not-visited"] + '</span><span>Not Visited</span></div>' +
      '<div class="status-item"><span class="status-count marked">' + statusCounts.marked + '</span><span>Marked for Review</span></div>' +
      '<div class="status-item"><span class="status-count answered-marked">' + statusCounts["answered-marked"] + '</span><span>Answered & Marked</span></div>' +
      '</div>';

    app.innerHTML = buildShell(
      '<section class="exam-layout utility-layout">' +
      '<div class="exam-topbar">' +
      '<div class="brand-mark"><img src="assets/favicon-round.svg" alt="AceIIIT Logo" class="brand-logo" /> AceIIIT</div>' +
      '<div class="instructions-tabs">' +
      '<button class="tab-button js-open-instructions" data-test="' + test.id + '">Instructions</button>' +
      '<button class="tab-button is-active" type="button">Question Paper</button>' +
      '</div>' +
      '</div>' +

      // Phone / landscape-phone exam bar: section · question · timer · save state · info · palette.
      '<div class="mobile-exam-topbar" id="mobile-exam-topbar">' +
      '<span class="mobile-section-badge">' + activeSection + '</span>' +
      '<span class="mobile-q-indicator">Q' + sectionQuestionNumber + '<small>/' + activeQuestions.length + '</small></span>' +
      (function () {
        var save = store.getAutosaveStatus ? store.getAutosaveStatus(attempt.id) : null;
        var label = describeAutosave(save);
        return '<span class="mobile-timer-pill">' +
          '<span class="mobile-save-state" id="autosave-chip-mobile" role="status" aria-live="polite" data-state="' + escapeAttribute(save ? save.status : "saved") + '" title="' + escapeAttribute(label) + '"><i aria-hidden="true"></i><span class="sr-only">' + escapeHtml(label) + '</span></span>' +
          '<strong id="timer-display-mobile" role="timer" aria-label="Time left in ' + activeSection + '">' + formatTime(remainingSeconds) + '</strong>' +
          '</span>';
      })() +
      '<button class="mobile-icon-btn js-open-instructions" type="button" data-test="' + escapeAttribute(test.id) + '" aria-label="Exam instructions">i</button>' +
      '<button class="mobile-palette-trigger" id="open-mobile-palette-top" type="button" aria-label="Open question palette, question ' + sectionQuestionNumber + ' of ' + activeQuestions.length + '">' +
      '<span aria-hidden="true">☰</span><span class="mobile-palette-label"> Palette</span>' +
      '</button>' +
      '</div>' +

      '<div class="exam-paperbar">' +
      '<div class="exam-paper-tabs">' +
      '<button class="paper-tab is-active" type="button">' + escapeHtml(test.title) + '</button>' +
      '</div>' +
      '<div class="exam-timerline">' + activeSection + ' Time Left : <strong id="timer-display">' + formatTime(remainingSeconds) + '</strong>' +
      ' <span class="autosave-chip" id="autosave-chip" role="status" aria-live="polite">' + escapeHtml(describeAutosave(store.getAutosaveStatus ? store.getAutosaveStatus(attempt.id) : null)) + '</span></div>' +
      '</div>' +
      '<div class="exam-sectionheader">Sections</div>' +
      '<div class="exam-sectionbar">' +
      '<div class="exam-tabs">' +
      '<button class="tab-button ' + (activeSection === "SUPR" ? "is-active" : "") + '" data-section="SUPR" ' + (activeSection === "REAP" ? "disabled" : "") + '>SUPR</button>' +
      '<button class="tab-button ' + (activeSection === "REAP" ? "is-active" : "") + '" data-section="REAP" ' + (activeSection === "SUPR" ? "disabled" : "") + '>REAP</button>' +
      '</div>' +
      '<div class="exam-submeta-group">' +
      '<div class="exam-submeta">Question No. ' + sectionQuestionNumber + '</div>' +
      '<button class="mobile-palette-trigger" id="open-mobile-palette" type="button" aria-label="Open question palette, question ' + sectionQuestionNumber + ' of ' + activeQuestions.length + '">' +
      '<span aria-hidden="true">☰</span> Palette (' + sectionQuestionNumber + '/' + activeQuestions.length + ')' +
      '</button>' +
      '</div>' +
      '</div>' +
      '<div class="exam-grid">' +
      '<div class="question-panel exam-mainpanel">' +
      '<article class="question-card exam-questioncard">' +
      '<div class="question-titlebar">Question No. ' + sectionQuestionNumber + '</div>' +
      '<div class="exam-questionbody' + (currentQuestion.passage ? ' has-passage' : '') + '">' +
      (currentQuestion.passage ? '<div class="passage exam-passage rich-text">' + formatRichText(currentQuestion.passage) + '</div>' : "") +
      '<div class="exam-questionmain">' +
      '<p class="exam-questiontext rich-text">' + formatRichText(currentQuestion.prompt) + '</p>' +
      renderQuestionFigures(currentQuestion) +
      getCalculatorMarkup() +
      '<div class="options exam-options">' +
      currentQuestion.options.map(function (option, index) {
        var checked = String(attempt.answers[currentQuestion.id]) === String(index);
        var letter = String.fromCharCode(65 + index);
        return (
          '<label class="option-card exam-option ' + (checked ? "is-selected" : "") + '">' +
          '<input type="radio" name="answer" value="' + index + '" ' + (checked ? "checked" : "") + ' aria-label="Option ' + letter + '">' +
          '<span class="option-letter" aria-hidden="true">' + letter + '</span>' +
          '<span class="rich-text">' + formatRichText(option) + '</span>' +
          '</label>'
        );
      }).join("") +
      '</div>' +
      '</div>' +
      '</div>' +
      '</article>' +
      '<div class="action-row exam-actionbar">' +
      '<button class="button button-secondary action-btn-prev" id="prev-question">Previous</button>' +
      '<button class="button button-ghost action-btn-mark" id="mark-next">Mark & Next</button>' +
      '<button class="button button-secondary action-btn-clear" id="clear-response">Clear</button>' +
      '<button class="button button-secondary action-btn-calc" data-calc-toggle>' + (runtime.calculatorVisible ? "Hide Calc" : "Calc") + '</button>' +
      '<button class="button button-primary action-btn-save" id="save-next">Save & Next</button>' +
      '<button class="button button-danger action-btn-submit" id="actionbar-submit" type="button">Submit</button>' +
      '</div>' +
      '</div>' +
      '<aside class="question-sidebar exam-sidebar">' +
      '<div class="exam-candidatecard">' +
      '<div class="avatar avatar-large">' + escapeHtml(initials(user.name)) + '</div>' +
      '<strong>' + escapeHtml(user.name) + '</strong>' +
      '</div>' +
      statusGridHtml +
      '<div class="exam-palettecard">' +
      '<div class="palette-head">' + activeSection + '</div>' +
      '<p class="palette-caption">Choose a Question</p>' +
      '<div class="palette-grid">' +
      paletteGridHtml +
      '</div>' +
      '</div>' +
      '<div class="legend-card submit-card exam-submitcard">' +
      '<div class="progress-line"><span style="width:' + (questions.length ? ((answeredCount / questions.length) * 100) : 0) + '%;"></span></div>' +
      '<p class="list-note">' + answeredCount + ' of ' + questions.length + ' answered</p>' +
      '<button class="button button-danger" id="submit-test">Submit</button>' +
      '</div>' +
      '</aside>' +
      '</div>' +
      '<div class="mobile-palette-overlay" id="mobile-palette-overlay" aria-hidden="true" style="display: none;">' +
      '<div class="mobile-palette-backdrop" id="mobile-palette-backdrop"></div>' +
      '<div class="mobile-palette-sheet" id="mobile-palette-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-palette-title">' +
      '<div class="mobile-palette-header">' +
      '<div>' +
      '<h3 class="mobile-palette-title" id="mobile-palette-title">QUESTION PALETTE</h3>' +
      '<span class="mobile-palette-subtitle">' + activeSection + ' Section (' + sectionQuestionNumber + ' of ' + activeQuestions.length + ')</span>' +
      '</div>' +
      '<button class="mobile-palette-close" id="mobile-palette-close" type="button" aria-label="Close question palette">✕</button>' +
      '</div>' +
      '<div class="mobile-palette-body">' +
      '<div class="mobile-status-strip">' +
      '<span class="status-pill answered">Answered ' + statusCounts.answered + '</span>' +
      '<span class="status-pill marked">Marked ' + (statusCounts.marked + statusCounts["answered-marked"]) + '</span>' +
      '<span class="status-pill not-visited">Unanswered ' + (statusCounts["not-visited"] + statusCounts["not-answered"]) + '</span>' +
      '</div>' +
      '<div class="palette-grid mobile-palette-grid">' +
      paletteGridHtml +
      '</div>' +
      '<div class="mobile-palette-actions">' +
      '<button class="button button-secondary" id="mobile-close-palette-btn" type="button">Close Palette</button>' +
      '<button class="button button-danger" id="mobile-submit-test" type="button">Submit Exam</button>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '</div>' +
      getSectionTransitionMarkup() +
      getInstructionsModalMarkup(user, test, questions) +
      getImageLightboxMarkup() +
      '<div class="exam-footerbar">Version: 17.07.00</div>',
      { hideFooter: true, hideSupportChat: true }
    );

    var openMobilePaletteBtn = document.getElementById("open-mobile-palette");
    var mobilePaletteOverlay = document.getElementById("mobile-palette-overlay");
    var mobilePaletteSheet = document.getElementById("mobile-palette-sheet");
    var closeMobilePaletteBtn = document.getElementById("mobile-palette-close");
    var mobilePaletteBackdrop = document.getElementById("mobile-palette-backdrop");
    var mobileSubmitBtn = document.getElementById("mobile-submit-test");

    var mobilePaletteCleanup = null;

    function closeMobilePalette() {
      overlayHistory.dismiss("exam-palette");
      if (mobilePaletteCleanup) {
        mobilePaletteCleanup();
        mobilePaletteCleanup = null;
      }
      if (mobilePaletteOverlay) {
        mobilePaletteOverlay.style.display = "none";
        mobilePaletteOverlay.setAttribute("aria-hidden", "true");
      }
    }

    function openMobilePalette(event) {
      if (!mobilePaletteOverlay || !mobilePaletteSheet) return;
      var paletteOpener = event && event.currentTarget ? event.currentTarget : openMobilePaletteTopBtn;
      mobilePaletteOverlay.style.display = "block";
      mobilePaletteOverlay.removeAttribute("aria-hidden");
      mobilePaletteCleanup = activateModalFocus(mobilePaletteSheet, {
        titleId: "mobile-palette-title",
        onEscape: closeMobilePalette,
        returnFocusEl: paletteOpener
      });
      overlayHistory.push("exam-palette", closeMobilePalette);
    }

    var openMobilePaletteTopBtn = document.getElementById("open-mobile-palette-top");

    if (openMobilePaletteBtn) {
      openMobilePaletteBtn.addEventListener("click", openMobilePalette);
    }
    if (openMobilePaletteTopBtn) {
      openMobilePaletteTopBtn.addEventListener("click", openMobilePalette);
    }
    var mobileCloseBtn = document.getElementById("mobile-close-palette-btn");

    if (closeMobilePaletteBtn) {
      closeMobilePaletteBtn.addEventListener("click", closeMobilePalette);
    }
    if (mobileCloseBtn) {
      mobileCloseBtn.addEventListener("click", closeMobilePalette);
    }
    if (mobilePaletteBackdrop) {
      mobilePaletteBackdrop.addEventListener("click", closeMobilePalette);
    }
    // Phone action bar Submit: same flow as the sidebar button (section transition / final
    // confirmation; submitAndNavigate guards against repeated submits).
    var actionbarSubmitBtn = document.getElementById("actionbar-submit");
    if (actionbarSubmitBtn) {
      actionbarSubmitBtn.addEventListener("click", function () {
        var mainSubmit = document.getElementById("submit-test");
        if (mainSubmit) mainSubmit.click();
      });
    }

    if (mobileSubmitBtn) {
      mobileSubmitBtn.addEventListener("click", function () {
        closeMobilePalette();
        var mainSubmit = document.getElementById("submit-test");
        if (mainSubmit) mainSubmit.click();
      });
    }

    renderLatexInElement(document.body);
    bindFigureLoadDiagnostics();
    restoreExamPaletteScroll();
    syncExamOverlays();

    // Back closes these overlays (see overlayHistory). The palette's DOM never survives a
    // re-render, so its entry is dismissed here; the others follow runtime state.
    function syncExamOverlays() {
      if (overlayHistory.has("exam-palette")) overlayHistory.dismiss("exam-palette");
      syncOverlay("exam-calculator", runtime.calculatorVisible, function () {
        runtime.calculatorVisible = false;
        renderTest(user, attempt.id);
      });
      syncOverlay("exam-instructions", !!runtime.instructionsPopupTestId, function () {
        runtime.instructionsPopupTestId = null;
        renderTest(user, attempt.id);
      });
      var transition = runtime.pendingSectionTransition;
      syncOverlay("exam-transition", !!(transition && transition.canReview), function () {
        var cancel = document.querySelector('[data-transition-action="cancel"]');
        if (cancel) cancel.click();
      });
    }

    function syncOverlay(id, isOpen, close) {
      if (isOpen) overlayHistory.push(id, close);
      else if (overlayHistory.has(id)) overlayHistory.dismiss(id);
    }

    function rememberExamPaletteScroll() {
      var palette = app.querySelector(".exam-palettecard");
      runtime.examPaletteScrollTop = palette ? palette.scrollTop : 0;
    }

    function restoreExamPaletteScroll() {
      var palette = app.querySelector(".exam-palettecard");
      if (!palette || runtime.examPaletteScrollTop === undefined) {
        return;
      }
      palette.scrollTop = Number(runtime.examPaletteScrollTop || 0);
    }

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

    // Keys 1-9 select the matching option (A, B, C...) when focus isn't in a text field.
    if (runtime.examKeyHandler) {
      document.removeEventListener("keydown", runtime.examKeyHandler);
    }
    runtime.examKeyHandler = function (event) {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      var tag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : "";
      if (tag === "textarea" || (tag === "input" && event.target.type !== "radio")) return;
      if (document.querySelector(".transition-modal, .calculator-modal, .image-lightbox")) return;
      var number = Number(event.key);
      if (!Number.isInteger(number) || number < 1) return;
      var radio = app.querySelector('input[name="answer"][value="' + (number - 1) + '"]');
      if (!radio) return;
      event.preventDefault();
      radio.checked = true;
      radio.dispatchEvent(new Event("change", { bubbles: true }));
    };
    document.addEventListener("keydown", runtime.examKeyHandler);

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
        closeMobilePalette();
        rememberExamPaletteScroll();
        flushQuestionTime();
        store.patchAttempt(attempt.id, function (draft) {
          draft.currentQuestionId = button.dataset.question;
          draft.currentSection = activeSection;
          draft.activeSection = activeSection;
          draft.visited[button.dataset.question] = true;
        });
        renderTest(user, attempt.id);
        var qCard = app.querySelector(".question-card");
        if (qCard) {
          try { qCard.scrollIntoView({ block: "start", behavior: "auto" }); } catch (_e) { }
        }
      });
    });

    function moveToQuestion(offset) {
      rememberExamPaletteScroll();
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
      // Once the final submission is under way, extra taps (double-tap on a phone) do nothing.
      if (runtime.submittingAttemptId === attempt.id) return;
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
        if (runtime.submittingAttemptId === attempt.id) return;
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

        var advanced = await activateReap();
        if (!advanced) {
          return;
        }
        attempt = advanced;
        renderTest(user, attempt.id);
      });
    });

    bindCalculatorHandlers(function () {
      renderTest(user, attempt.id);
    });
    bindImageLightbox(function () {
      renderTest(user, attempt.id);
    });

    clearActiveRenderModal();

    var activeTransitionModal = app.querySelector(".transition-modal:not(.instructions-modal-overlay):not(.planner-modal-overlay)");
    if (activeTransitionModal) {
      var card = activeTransitionModal.querySelector(".transition-card") || activeTransitionModal;
      activeRenderModalCleanup = activateModalFocus(card, {
        onEscape: function () {
          if (runtime.pendingSectionTransition && runtime.pendingSectionTransition.canReview) {
            runtime.pendingSectionTransition = null;
            renderTest(user, attempt.id);
          }
        }
      });
    } else {
      var activeInstructionsModal = app.querySelector(".instructions-modal-overlay");
      if (activeInstructionsModal) {
        card = activeInstructionsModal.querySelector(".instructions-popup-card") || activeInstructionsModal;
        activeRenderModalCleanup = activateModalFocus(card, {
          onEscape: function () {
            runtime.instructionsPopupTestId = null;
            renderTest(user, attempt.id);
          }
        });
      } else {
        var activeCalcModal = app.querySelector(".calculator-modal");
        if (activeCalcModal) {
          activeRenderModalCleanup = activateModalFocus(activeCalcModal, {
            onEscape: function () {
              runtime.calculatorVisible = false;
              renderTest(user, attempt.id);
            }
          });
        } else {
          var activeLightboxModal = app.querySelector(".image-lightbox");
          if (activeLightboxModal) {
            card = activeLightboxModal.querySelector(".image-lightbox-card") || activeLightboxModal;
            activeRenderModalCleanup = activateModalFocus(card, {
              onEscape: function () {
                runtime.imageLightboxUrl = "";
                renderTest(user, attempt.id);
              }
            });
          }
        }
      }
    }

    if (runtime.timerId) {
      clearInterval(runtime.timerId);
    }

    runtime.timerId = window.setInterval(function () {
      var liveAttempt = store.getAttemptById(attempt.id);
      if (!liveAttempt || liveAttempt.status === "submitted") {
        stopRuntime(false);
        return;
      }

      var saveState = store.getAutosaveStatus ? store.getAutosaveStatus(liveAttempt.id) : null;
      var autosaveChip = document.getElementById("autosave-chip");
      if (autosaveChip) {
        autosaveChip.textContent = describeAutosave(saveState);
        autosaveChip.dataset.state = saveState ? saveState.status : "saved";
      }
      var autosaveChipMobile = document.getElementById("autosave-chip-mobile");
      if (autosaveChipMobile) {
        var saveLabel = describeAutosave(saveState);
        autosaveChipMobile.dataset.state = saveState ? saveState.status : "saved";
        autosaveChipMobile.title = saveLabel;
        var saveText = autosaveChipMobile.querySelector(".sr-only");
        if (saveText && saveText.textContent !== saveLabel) saveText.textContent = saveLabel;
      }
      if (saveState && saveState.closedAttemptId) {
        // The server closed this session (deadline reached); show the finalized result.
        stopRuntime(false);
        window.alert("Time is over. Your saved answers were submitted automatically.");
        if (saveState.closedAttemptId !== "pending") {
          Promise.resolve(store.getAttemptResult(saveState.closedAttemptId)).finally(function () {
            store.resolveExpiredAttempt(liveAttempt.id).catch(function () {});
            navigate("results/" + saveState.closedAttemptId);
          });
        } else {
          Promise.resolve(store.resolveExpiredAttempt(liveAttempt.id)).then(function (finalized) {
            navigate(finalized ? "results/" + finalized.id : "dashboard");
          });
        }
        return;
      }
      if (saveState && saveState.bindingLost && !runtime.bindingPromptShown) {
        runtime.bindingPromptShown = true;
        stopRuntime(true);
        if (window.confirm("This exam was opened in another tab or device, so this window stopped saving.\n\nContinue in this window instead?")) {
          runtime.bindingPromptShown = false;
          launchExam(user, liveAttempt.testId);
        } else {
          navigate("dashboard");
        }
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
      var timerDisplayMobile = document.getElementById("timer-display-mobile");
      var secondsLeft = getSectionTimeLeft(liveAttempt, liveAttempt.activeSection || activeSection);
      if (!runtime.lastPresencePingAt || (Date.now() - runtime.lastPresencePingAt) >= 15000) {
        store.patchAttempt(liveAttempt.id, function () { });
        runtime.lastPresencePingAt = Date.now();
      }
      if (timerDisplay) {
        timerDisplay.textContent = formatTime(secondsLeft);
        timerDisplay.classList.toggle("is-warning", secondsLeft <= 600 && secondsLeft > 300);
        timerDisplay.classList.toggle("is-danger", secondsLeft <= 300);
      }
      if (timerDisplayMobile) {
        timerDisplayMobile.textContent = formatTime(secondsLeft);
        timerDisplayMobile.classList.toggle("is-warning", secondsLeft <= 600 && secondsLeft > 300);
        timerDisplayMobile.classList.toggle("is-danger", secondsLeft <= 300);
      }

      if (liveAttempt.activeSection === "REAP" && secondsLeft <= 0) {
        flushQuestionTime();
        submitAndNavigate();
      }
    }, 1000);

    startIntegrityMonitor(user, attempt);
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
    var result = attempt.result;
    // Full marks come from the server (the attempt's own question snapshot); students no
    // longer receive the question list, so summing it client-side gave 0.
    var maxScore = Number(result.maxScore) > 0
      ? Number(result.maxScore)
      : questions.reduce(function (sum, q) { return sum + Number(q.marks || 0); }, 0);
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

    function clampPct(value) {
      return Math.max(0, Math.min(100, Number(value || 0)));
    }

    function roundTo(value, digits) {
      var factor = Math.pow(10, digits || 0);
      return Math.round(Number(value || 0) * factor) / factor;
    }

    function accuracyTone(accuracy) {
      var a = Number(accuracy || 0);
      if (a >= 70) return "is-strong";
      if (a >= 45) return "is-good";
      if (a >= 25) return "is-watch";
      return "is-focus";
    }

    function highlightPlanText(text) {
      var keywords = ["Accuracy", "Slow down", "Focus", "timed drills", "weakest section", "low-confidence guesses", "REAP", "SUPR", "consistency", "marks away", "benchmark range", "configured benchmark range"];
      var html = escapeHtml(String(text));
      keywords.forEach(function (kw) {
        var regex = new RegExp("(" + escapeHtml(kw) + ")", "gi");
        html = html.replace(regex, '<span class="plan-highlight">$1</span>');
      });
      return html;
    }

    // Correct / wrong / skipped as one proportional bar.
    function outcomeBar(correct, wrong, skipped, extraClass) {
      var total = Math.max(1, Number(correct || 0) + Number(wrong || 0) + Number(skipped || 0));
      return (
        '<div class="rs-stackbar' + (extraClass ? ' ' + extraClass : '') + '" role="img" aria-label="' +
        escapeAttribute(correct + ' correct, ' + wrong + ' wrong, ' + skipped + ' skipped') + '">' +
        '<span class="is-correct" data-width="' + roundTo((correct / total) * 100, 2) + '%"></span>' +
        '<span class="is-wrong" data-width="' + roundTo((wrong / total) * 100, 2) + '%"></span>' +
        '<span class="is-skipped" data-width="' + roundTo((skipped / total) * 100, 2) + '%"></span>' +
        '</div>'
      );
    }

    function sectionRowsFor(summary) {
      if (summary && Array.isArray(summary.sectionInsights) && summary.sectionInsights.length) {
        return summary.sectionInsights;
      }
      return ["SUPR", "REAP"].map(function (key) {
        var s = (sectionScores && sectionScores[key]) || {};
        var correct = Number(s.correct || 0);
        var wrong = Number(s.wrong || 0);
        var attempted = correct + wrong;
        return { key: key, score: Number(s.score || 0), correct: correct, wrong: wrong, skipped: Number(s.skipped || 0), accuracy: attempted ? roundTo((correct / attempted) * 100, 2) : 0 };
      });
    }

    function buildSectionsCard(summary) {
      var rows = sectionRowsFor(summary);
      return (
        '<section class="rs-card rs-sections analysis-stage"' + stageStyle(1) + '>' +
        '<div class="rs-card-head"><p class="section-label">Section breakdown</p></div>' +
        '<div class="rs-section-list">' +
        rows.map(function (section) {
          var hasTime = Number(section.timeSpent || 0) > 0;
          return (
            '<div class="rs-section">' +
            '<div class="rs-section-top">' +
            '<strong class="rs-section-name">' + escapeHtml(String(section.key)) + '</strong>' +
            '<span class="rs-section-score">Score <b>' + escapeHtml(String(roundTo(section.score, 2))) + '</b></span>' +
            '<span class="rs-pill ' + accuracyTone(section.accuracy) + '">' + escapeHtml(String(roundTo(section.accuracy, 1))) + '% accuracy</span>' +
            '</div>' +
            outcomeBar(Number(section.correct || 0), Number(section.wrong || 0), Number(section.skipped || 0)) +
            '<div class="rs-meta">' +
            '<span><i class="rs-dot is-correct"></i>' + escapeHtml(String(section.correct || 0)) + ' correct</span>' +
            '<span><i class="rs-dot is-wrong"></i>' + escapeHtml(String(section.wrong || 0)) + ' wrong</span>' +
            '<span><i class="rs-dot is-skipped"></i>' + escapeHtml(String(section.skipped || 0)) + ' skipped</span>' +
            (hasTime ? '<span>Time ' + escapeHtml(formatTime(Number(section.timeSpent || 0))) + '</span>' : '') +
            (Number(section.avgTimePerAttempted || 0) > 0 ? '<span>' + escapeHtml(String(section.avgTimePerAttempted)) + 's per attempted</span>' : '') +
            '</div>' +
            '</div>'
          );
        }).join("") +
        '</div>' +
        '</section>'
      );
    }

    function buildVerdictCard(summary) {
      if (!summary) {
        return (
          '<aside class="rs-card rs-verdict analysis-stage"' + stageStyle(2) + '>' +
          '<p class="section-label">Verdict &amp; next steps</p>' +
          '<div class="empty-state">' + (analysisHydrating
            ? 'Loading the stored analysis for this attempt…'
            : 'Detailed analysis is available for attempts submitted after the analysis upgrade.') + '</div>' +
          '</aside>'
        );
      }
      var steps = [];
      if (summary.nextBenchmark !== null && summary.nextBenchmark !== undefined) {
        steps.push('You are ' + String(summary.benchmarkGap || 0) + ' marks away from the next benchmark (' + String(summary.nextBenchmark) + ').');
      } else {
        steps.push('You are already at or above the configured benchmark range for this paper.');
      }
      (summary.recommendations || []).forEach(function (item) { steps.push(item); });
      if (steps.length === 1) steps.push('Keep practising with timed mixed sets to improve consistency.');
      return (
        '<aside class="rs-card rs-verdict analysis-stage"' + stageStyle(2) + '>' +
        '<p class="section-label">Verdict &amp; next steps</p>' +
        '<div class="rs-verdict-tags">' +
        '<div class="rs-tag ' + analysisToneClass(summary.scoreLabel) + '"><span>Score band</span><strong>' + escapeHtml(String(summary.scoreLabel || "Balanced")) + '</strong><small>' + escapeHtml(String(summary.scorePercentage || 0)) + '% of total marks</small></div>' +
        '<div class="rs-tag ' + analysisToneClass(summary.paceLabel) + '"><span>Pace</span><strong>' + escapeHtml(String(summary.paceLabel || "Balanced")) + '</strong><small>' + escapeHtml(String(summary.avgSecondsPerAttempted || 0)) + 's per attempted question</small></div>' +
        '</div>' +
        ((summary.strongSection || summary.weakSection)
          ? '<p class="rs-verdict-line">' +
            (summary.strongSection ? 'Strongest <b>' + escapeHtml(String(summary.strongSection.key)) + '</b> (' + escapeHtml(String(roundTo(summary.strongSection.accuracy, 1))) + '%)' : '') +
            (summary.strongSection && summary.weakSection && summary.weakSection.key !== summary.strongSection.key
              ? ' · Focus <b>' + escapeHtml(String(summary.weakSection.key)) + '</b> (' + escapeHtml(String(roundTo(summary.weakSection.accuracy, 1))) + '%)'
              : '') +
            '</p>'
          : '') +
        '<ol class="rs-steps">' + steps.map(function (step) { return '<li>' + highlightPlanText(step) + '</li>'; }).join("") + '</ol>' +
        '</aside>'
      );
    }

    var TOPICS_VISIBLE = 6;

    function buildTopicCard(summary) {
      var topics = summary && Array.isArray(summary.topicInsights) ? summary.topicInsights : [];
      return (
        '<section class="rs-card rs-topics analysis-stage"' + stageStyle(3) + '>' +
        '<div class="rs-card-head"><p class="section-label">Topic analysis</p>' +
        (topics.length ? '<span class="rs-head-note">Highest priority first</span>' : '') + '</div>' +
        (topics.length
          ? '<div class="rs-topic-table" role="table" aria-label="Topic analysis">' +
            '<div class="rs-topic-row is-head" role="row">' +
            '<span role="columnheader">Topic</span><span role="columnheader">Attempted</span><span role="columnheader">Correct / wrong</span><span role="columnheader">Accuracy</span><span role="columnheader">Net marks</span>' +
            '</div>' +
            topics.map(function (topic, index) {
              var acc = roundTo(topic.accuracy, 1);
              var net = roundTo(topic.score, 2);
              var attempted = Number(topic.attempted || 0);
              return (
                '<div class="rs-topic-row' + (index >= TOPICS_VISIBLE ? ' is-extra' : '') + '" role="row">' +
                '<span class="rs-topic-name" role="cell"><strong>' + escapeHtml(String(topic.topic || "General")) + '</strong>' +
                '<em>' + escapeHtml(String(topic.section || "")) + '</em>' +
                (index === 0 && attempted ? '<b class="rs-flag">Top priority</b>' : '') + '</span>' +
                '<span role="cell" data-label="Attempted">' + attempted + '/' + escapeHtml(String(topic.total || 0)) + '</span>' +
                '<span role="cell" data-label="Correct / wrong">' + escapeHtml(String(topic.correct || 0)) + ' / ' + escapeHtml(String(topic.wrong || 0)) + '</span>' +
                '<span class="rs-acc" role="cell" data-label="Accuracy">' + (attempted
                  ? '<i class="' + accuracyTone(acc) + '"><b data-width="' + Math.max(3, clampPct(acc)) + '%"></b></i>' + escapeHtml(String(acc)) + '%'
                  : '<span class="rs-muted">Not attempted</span>') + '</span>' +
                '<span class="rs-net ' + (net < 0 ? 'is-neg' : (net > 0 ? 'is-pos' : '')) + '" role="cell" data-label="Net marks">' + (net > 0 ? '+' : '') + escapeHtml(String(net)) + '</span>' +
                '</div>'
              );
            }).join("") +
            '</div>' +
            (topics.length > TOPICS_VISIBLE
              ? '<button type="button" class="button button-secondary button-compact rs-topic-toggle js-topic-toggle" aria-expanded="false">Show all ' + topics.length + ' topics</button>'
              : '')
          : '<div class="empty-state">Topic insights appear for attempts submitted on the current analysis pipeline.</div>') +
        '</section>'
      );
    }

    function buildTimeCard(summary) {
      var t = summary && summary.timeAnalysis ? summary.timeAnalysis : null;
      if (!t) return "";
      var stat = function (label, value) {
        return '<div class="rs-stat"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong></div>';
      };
      return (
        '<section class="rs-card rs-time analysis-stage"' + stageStyle(4) + '>' +
        '<p class="section-label">Time &amp; pace</p>' +
        '<div class="rs-stat-grid">' +
        stat("Total time", formatTime(Number(t.totalTimeSeconds || 0))) +
        stat("Per question", String(t.avgSecondsPerQuestion || 0) + "s") +
        stat("Per attempted", String(t.avgSecondsPerAttempted || 0) + "s") +
        stat("Target pace", String(t.targetSecondsPerQuestion || 0) + "s") +
        '</div>' +
        '<ul class="rs-notes">' +
        '<li class="' + (t.timePressure ? 'is-warn' : 'is-ok') + '">' + escapeHtml(t.timePressure ? "You were under time pressure." : "Time usage stayed under control.") + '</li>' +
        '<li class="' + (t.fastButErrorProne ? 'is-warn' : 'is-ok') + '">' + escapeHtml(t.fastButErrorProne ? "High speed is costing accuracy." : "Speed and accuracy stayed balanced.") + '</li>' +
        '</ul>' +
        '</section>'
      );
    }

    function buildHistoryCard() {
      var recent = attemptHistory.slice(0, 6);
      var trend = recent.slice().reverse();
      var maxHistoryScore = trend.reduce(function (max, item) {
        return Math.max(max, Number(item && item.result && item.result.score || 0));
      }, Math.max(1, Number(maxScore || 0)));
      return (
        '<section class="rs-card rs-history analysis-stage"' + stageStyle(5) + '>' +
        '<div class="rs-card-head"><p class="section-label">Attempt history</p>' +
        (attemptHistory.length ? '<span class="meta-chip">' + attemptHistory.length + ' total</span>' : '') + '</div>' +
        (trend.length > 1
          ? '<div class="rs-trend" role="img" aria-label="Scores of your recent attempts, oldest to latest">' + trend.map(function (item) {
            var score = Number(item && item.result && item.result.score || 0);
            var height = Math.max(8, Math.min(100, Math.round((Math.max(0, score) / maxHistoryScore) * 100)));
            return '<span class="' + (item.id === attempt.id ? 'is-current' : '') + '" title="Attempt ' + escapeAttribute(String(item.attemptNumber || "")) + ': ' + escapeAttribute(String(score)) + '"><b style="height:' + height + '%"></b></span>';
          }).join("") + '</div>'
          : '') +
        (recent.length
          ? '<ul class="rs-history-list">' + recent.map(function (a) {
            var isCurrent = a.id === attempt.id;
            return (
              '<li class="' + (isCurrent ? 'is-current' : '') + '">' +
              '<span class="rs-history-label">Attempt ' + escapeHtml(String(a.attemptNumber || "")) + '</span>' +
              '<strong>' + escapeHtml(String(a.result.score)) + (maxScore ? '<small>/' + escapeHtml(String(maxScore)) + '</small>' : '') + '</strong>' +
              '<span class="rs-muted">' + escapeHtml(formatDateOnly(a.submittedAt)) + '</span>' +
              (isCurrent
                ? '<span class="meta-chip">Viewing</span>'
                : '<button class="button button-secondary button-compact js-open-result" data-id="' + escapeAttribute(a.id) + '">Open</button>') +
              '</li>'
            );
          }).join("") + '</ul>'
          : '<div class="empty-state">No previous attempts.</div>') +
        '</section>'
      );
    }

    function buildQuestionReviewShell() {
      return (
        '<section class="report-card analysis-stage" style="padding: 24px; flex: 1 1 100%; min-width: 0;"' + stageStyle(6) + '>' +
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

    // Left: sections + time (balances the taller verdict card on the right).
    function buildTopRow(summary) {
      return '<div class="rs-side-stack">' + buildSectionsCard(summary) + buildTimeCard(summary) + '</div>' + buildVerdictCard(summary);
    }

    function buildDetailRow(summary) {
      return (summary ? buildTopicCard(summary) : "") + '<div class="rs-side-stack">' + buildHistoryCard() + '</div>';
    }

    function buildOptionRow(text, optionIndex, review) {
      var classes = ["analysis-option"];
      var isCorrectOption = Number(review.correctOption) === optionIndex;
      var isSelectedOption = review.selectedOption !== null && review.selectedOption !== undefined && Number(review.selectedOption) === optionIndex;

      var badgeHtml = "";
      if (isCorrectOption && isSelectedOption) {
        classes.push("is-selected-correct");
        badgeHtml = '<span class="option-badge is-correct-choice" aria-label="Your answer, correct"><span aria-hidden="true">✓</span> Your Answer (Correct)</span>';
      } else if (isCorrectOption) {
        classes.push("is-correct");
        badgeHtml = '<span class="option-badge is-correct-answer" aria-label="Correct answer"><span aria-hidden="true">✓</span> Correct Answer</span>';
      } else if (isSelectedOption) {
        classes.push("is-selected-wrong");
        badgeHtml = '<span class="option-badge is-wrong-choice" aria-label="Your answer, incorrect"><span aria-hidden="true">✕</span> Your Answer (Incorrect)</span>';
      }

      var letter = String.fromCharCode(65 + optionIndex);

      return (
        '<li class="' + classes.join(" ") + '">' +
        '<span class="analysis-option-index">' + letter + '</span>' +
        '<div class="analysis-option-content">' +
        '<div class="rich-text">' + formatRichText(text || "") + '</div>' +
        (badgeHtml ? '<div class="analysis-option-badge-wrap">' + badgeHtml + '</div>' : "") +
        '</div>' +
        '</li>'
      );
    }

    function buildQuestionReviewItems(items, offset) {
      offset = Number(offset || 0);
      return (items || []).map(function (review, index) {
        var isCorrect = review.status === "correct";
        var isWrong = review.status === "wrong";

        var statusLabel = isCorrect
          ? '<span class="answer-chip correct" aria-label="Status: Correct answer"><span aria-hidden="true">✓</span> Correct (+' + escapeHtml(String(review.marks || 0)) + ')</span>'
          : isWrong
            ? '<span class="answer-chip incorrect" aria-label="Status: Incorrect answer"><span aria-hidden="true">✕</span> Incorrect (-' + escapeHtml(String(review.negativeMarks || 0)) + ')</span>'
            : '<span class="answer-chip neutral" aria-label="Status: Unanswered"><span aria-hidden="true">—</span> Unanswered (0)</span>';

        var selectedLetter = (review.selectedOption !== null && review.selectedOption !== undefined && review.selectedOption !== "")
          ? "Option " + String.fromCharCode(65 + Number(review.selectedOption))
          : "Unanswered";
        var correctLetter = "Option " + String.fromCharCode(65 + Number(review.correctOption || 0));

        var responseSummaryHtml = "";
        if (isCorrect) {
          responseSummaryHtml =
            '<div class="response-summary-banner is-correct">' +
            '<div><strong>Your Answer:</strong> ' + selectedLetter + ' <span class="summary-tag correct" aria-hidden="true">✓ Correct</span></div>' +
            '<div><strong>Marks Awarded:</strong> +' + escapeHtml(String(review.marks || 0)) + '</div>' +
            '</div>';
        } else if (isWrong) {
          responseSummaryHtml =
            '<div class="response-summary-banner is-wrong">' +
            '<div><strong>Your Answer:</strong> ' + selectedLetter + ' <span class="summary-tag wrong" aria-hidden="true">✕ Incorrect</span></div>' +
            '<div><strong>Correct Answer:</strong> ' + correctLetter + '</div>' +
            '<div><strong>Penalty:</strong> -' + escapeHtml(String(review.negativeMarks || 0)) + '</div>' +
            '</div>';
        } else {
          responseSummaryHtml =
            '<div class="response-summary-banner is-neutral">' +
            '<div><strong>Your Answer:</strong> Unanswered</div>' +
            '<div><strong>Correct Answer:</strong> ' + correctLetter + '</div>' +
            '</div>';
        }

        var passageHtml = review.passage
          ? '<div class="analysis-review-passage"><strong>Passage:</strong><div class="rich-text">' + formatRichText(review.passage) + '</div></div>'
          : '';

        var explanationHtml = review.explanation
          ? '<div class="analysis-explanation-card">' +
          '<div class="analysis-explanation-head">' +
          '<h5 class="analysis-explanation-title"><span aria-hidden="true">💡</span> Solution & Explanation</h5>' +
          '</div>' +
          '<div class="rich-text analysis-explanation-body">' + formatRichText(review.explanation) + '</div>' +
          '</div>'
          : '';

        var isBookmarked = store.hasBookmark && store.hasBookmark(user.id, review.id);
        var bookmarkIconFilled = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:text-bottom;"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
        var bookmarkIconEmpty = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:text-bottom;"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
        var bookmarkBtnClass = isBookmarked ? "button button-secondary is-bookmarked js-bookmark-toggle" : "button button-secondary js-bookmark-toggle";
        var bookmarkBtnContent = isBookmarked ? bookmarkIconFilled + " Saved" : bookmarkIconEmpty + " Save";
        var bookmarkDataPayload = {
           id: review.id,
           topic: review.topic,
           prompt: review.prompt,
           explanation: review.explanation
        };

        return (
          '<article class="analysis-review-card">' +
          '<div class="analysis-review-meta">' +
          '<div>' +
          '<p class="section-label">Question ' + escapeHtml(String(offset + index + 1)) + ' · ' + escapeHtml(String(review.section || "")) + '</p>' +
          '<h4>' + escapeHtml(String(review.topic || "General Topic")) + '</h4>' +
          '</div>' +
          '<div class="analysis-review-badges" style="display:flex; align-items:center; gap:8px;">' +
          statusLabel +
          '<span class="analysis-pill" aria-label="Time spent: ' + formatTime(Number(review.timeSpent || 0)) + '">⏱ ' + escapeHtml(formatTime(Number(review.timeSpent || 0))) + '</span>' +
          '<button class="' + bookmarkBtnClass + '" data-qid="' + escapeAttribute(review.id) + '" data-qpayload="' + encodeURIComponent(JSON.stringify(bookmarkDataPayload)) + '" aria-label="Bookmark this question" style="padding:4px 10px; font-size:0.9rem; color:var(--brand-accent); border-color:rgba(200,150,62,0.3);">' + bookmarkBtnContent + '</button>' +
          '</div>' +
          '</div>' +
          passageHtml +
          '<div class="analysis-review-block rich-text">' + formatRichText(review.prompt || "") + '</div>' +
          ((review.imageUrls || []).length
            ? '<div class="analysis-review-images">' + review.imageUrls.map(function (url) {
              return '<button class="analysis-inline-image js-open-image-lightbox" type="button" data-url="' + escapeAttribute(url) + '" aria-label="View question image"><img src="' + escapeAttribute(url) + '" alt="Question diagram"></button>';
            }).join("") + '</div>'
            : '') +
          '<ol class="analysis-option-list">' +
          ((review.options || []).map(function (option, optionIndex) {
            return buildOptionRow(option, optionIndex, review);
          }).join("")) +
          '</ol>' +
          responseSummaryHtml +
          explanationHtml +
          '</article>'
        );
      }).join("");
    }

    var attemptHistory = store.listUserAttempts(user.id).filter(function (a) {
      return a.testId === attempt.testId && a.status === "submitted" && a.result;
    });
      var wittyLines = [
        "The server has crunched your answers, judged your life choices, and compiled your results.",
        "Evaluation complete. The algorithms have pondered over your responses.",
        "Your fate has been sealed by the server gods. Let's see the damage.",
        "We fed your answers to the evaluation matrix. Here is the raw, unfiltered truth.",
        "No client-side peeking allowed. Just pure, unadulterated performance data."
      ];
      var witticism = wittyLines[(attempt ? attempt.id.charCodeAt(attempt.id.length - 1) : 0) % wittyLines.length] || wittyLines[0];

      var correctCount = Number(result.correctCount || 0);
      var wrongCount = Number(result.wrongCount || 0);
      var skippedCount = Number(result.unattemptedCount !== undefined ? result.unattemptedCount : result.skippedCount || 0);
      var attemptedCount = correctCount + wrongCount;
      var totalQuestions = attemptedCount + skippedCount || Number(analysis && analysis.totalQuestions || 0);
      var timeTaken = Number(result.totalTime !== undefined ? result.totalTime : result.timeTakenSeconds || 0);
      var paperSeconds = test && test.durationMinutes ? Number(test.durationMinutes) * 60 : 0;
      var rankValue = Number(result.rank || 0);
      var rankTotal = Number(result.rankTotal || 0);
      var cohortLabel = Number(attempt.attemptNumber || 1) > 1 ? 'among attempt ' + attempt.attemptNumber + ' takers' : 'among first attempts';

      function kpi(label, valueHtml, sub, extraClass) {
        return (
          '<div class="rs-kpi' + (extraClass ? ' ' + extraClass : '') + '">' +
          '<span class="rs-kpi-label">' + escapeHtml(label) + '</span>' +
          '<strong class="rs-kpi-value">' + valueHtml + '</strong>' +
          (sub ? '<span class="rs-kpi-sub">' + escapeHtml(sub) + '</span>' : '') +
          '</div>'
        );
      }

      var kpisHtml =
        '<div class="rs-kpis analysis-stage"' + stageStyle(0) + '>' +
        kpi("Score",
          '<span data-animate-number="' + escapeAttribute(String(result.score || 0)) + '"></span>' + (maxScore ? '<small>/ ' + escapeHtml(String(maxScore)) + '</small>' : ''),
          maxScore ? roundTo((Number(result.score || 0) / maxScore) * 100, 1) + '% of total marks' : '', "is-primary") +
        kpi("Rank",
          rankValue ? '<span data-animate-number="' + rankValue + '"></span>' + (rankTotal ? '<small>of ' + rankTotal + '</small>' : '') : '—',
          rankValue ? cohortLabel : (result.invalidated ? 'Removed from ranking' : 'Not ranked')) +
        kpi("Percentile",
          rankValue ? '<span data-animate-number="' + escapeAttribute(String(result.percentile || 0)) + '" data-suffix="%" data-decimals="2"></span>' : '—',
          rankValue ? 'Relative standing' : '') +
        kpi("Accuracy",
          '<span data-animate-number="' + escapeAttribute(String(result.accuracy || 0)) + '" data-suffix="%" data-decimals="2"></span>',
          correctCount + ' of ' + attemptedCount + ' attempted correct') +
        kpi("Attempted",
          escapeHtml(String(attemptedCount)) + (totalQuestions ? '<small>/ ' + totalQuestions + '</small>' : ''),
          skippedCount + ' skipped') +
        kpi("Time taken",
          escapeHtml(formatTime(timeTaken)),
          paperSeconds ? 'of ' + formatTime(paperSeconds) + ' allowed' : '') +
        '</div>' +
        '<div class="rs-outcome analysis-stage"' + stageStyle(0) + '>' +
        outcomeBar(correctCount, wrongCount, skippedCount, "is-large") +
        '<div class="rs-legend">' +
        '<span><i class="rs-dot is-correct"></i>Correct <b>' + correctCount + '</b></span>' +
        '<span><i class="rs-dot is-wrong"></i>Wrong <b>' + wrongCount + '</b></span>' +
        '<span><i class="rs-dot is-skipped"></i>Skipped <b>' + skippedCount + '</b></span>' +
        '</div>' +
        '</div>';

      app.innerHTML = buildShell(
        renderPrimaryNav("progress", user) +
        '<section class="rs-page">' +
        '<header class="rs-hero">' +
        '<div class="rs-hero-text">' +
        '<p class="section-label">Result · Attempt ' + escapeHtml(String(attempt.attemptNumber || 1)) + ' · ' + escapeHtml(formatDateOnly(attempt.submittedAt)) + '</p>' +
        '<h1>' + escapeHtml(test && test.title ? test.title : "UGEE Mock Test") + '</h1>' +
        '<p class="rs-hero-sub"><strong>' + escapeHtml(firstName(user.name)) + '</strong>, ' + witticism + '</p>' +
        '</div>' +
        '<div class="rs-hero-actions">' +
        '<button class="button button-primary" id="retake-test">Retake test</button>' +
        '</div>' +
        '</header>' +
        kpisHtml +
        '<div class="rs-row rs-top" id="analysis-summary-root">' + buildTopRow(analysis) + '</div>' +
        '<div class="report-card pi-card" id="performance-intelligence-root" aria-live="polite">' +
        '<p class="section-label">Performance Intelligence</p><p class="pi-muted">Analyzing your attempt…</p>' +
        '</div>' +
        '<div class="rs-row rs-detail' + (analysis ? '' : ' is-solo') + '" id="analysis-detail-root">' + buildDetailRow(analysis) + '</div>' +
        '<div id="analysis-review-root">' + buildQuestionReviewShell() + '</div>' +
        '</section>'
      );
    mountPerformanceIntelligence(attempt.id);

    // The results view has no dashboard button; guard so the bindings below still run.
    var resultsBackButton = document.getElementById("back-dashboard");
    if (resultsBackButton) {
      resultsBackButton.addEventListener("click", function () {
        navigate("dashboard");
      });
    }

    var retakeButton = document.getElementById("retake-test");
    if (retakeButton) {
      retakeButton.addEventListener("click", function () {
        navigate("instructions/" + attempt.testId);
      });
    }

    function bindDetailInteractions(root) {
      root.querySelectorAll(".js-open-result").forEach(function (button) {
        button.addEventListener("click", function () {
          navigate("results/" + button.dataset.id);
        });
      });
      root.querySelectorAll(".js-topic-toggle").forEach(function (button) {
        button.addEventListener("click", function () {
          var card = button.closest(".rs-topics");
          var expanded = card.classList.toggle("is-expanded");
          button.setAttribute("aria-expanded", expanded ? "true" : "false");
          button.textContent = expanded ? "Show fewer topics" : "Show all " + card.querySelectorAll(".rs-topic-row:not(.is-head)").length + " topics";
        });
      });
    }
    bindDetailInteractions(app);

    function bindReviewButtons() {
      app.querySelectorAll(".js-open-image-lightbox").forEach(function (button) {
        button.addEventListener("click", function () {
          openImageLightbox(button.getAttribute("data-url") || "");
        });
      });
      app.querySelectorAll(".js-bookmark-toggle:not(.bound)").forEach(function(button) {
        button.classList.add("bound");
        button.addEventListener("click", function () {
          var qid = button.dataset.qid;
          var isBookmarked = store.hasBookmark && store.hasBookmark(user.id, qid);
          var bookmarkIconFilled = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:text-bottom;"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
          var bookmarkIconEmpty = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:text-bottom;"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
          if (isBookmarked) {
            if (store.removeBookmark) store.removeBookmark(user.id, qid);
            button.classList.remove("is-bookmarked");
            button.innerHTML = bookmarkIconEmpty + " Save";
            if (typeof window.showSaveChip === 'function') window.showSaveChip("Bookmark removed.");
          } else {
            var payloadStr = button.dataset.qpayload;
            if (payloadStr && store.addBookmark) {
              try {
                var qObj = JSON.parse(decodeURIComponent(payloadStr));
                store.addBookmark(user.id, {
                  id: qObj.id,
                  testId: attempt.testId,
                  topic: qObj.topic,
                  prompt: qObj.prompt,
                  explanation: qObj.explanation
                });
                button.classList.add("is-bookmarked");
                button.innerHTML = bookmarkIconFilled + " Saved";
                if (typeof window.showSaveChip === 'function') window.showSaveChip("Question bookmarked.");
              } catch(e) {}
            }
          }
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
        var summaryRoot = document.getElementById("analysis-summary-root");
        var detailRoot = document.getElementById("analysis-detail-root");
        var reviewRoot = document.getElementById("analysis-review-root");
        if (summaryRoot) {
          summaryRoot.innerHTML = buildTopRow(analysis);
          activateAnalysisAnimations(summaryRoot);
        }
        if (detailRoot) {
          detailRoot.className = "rs-row rs-detail" + (analysis ? "" : " is-solo");
          detailRoot.innerHTML = buildDetailRow(analysis);
          activateAnalysisAnimations(detailRoot);
          bindDetailInteractions(detailRoot);
        }
        if (reviewRoot) {
          reviewRoot.innerHTML = buildQuestionReviewShell();
          mountQuestionReviewLoader();
        }
      }).catch(function () { });
    }

    renderLatexInElement(document.body);
  }

  // Performance Intelligence: verified metrics come from the attempt (shown above); this
  // card shows the interpretation (AI when ready, deterministic otherwise), clearly labelled.
  function renderPerformanceIntelligence(root, data) {
    var result = data.result || {};
    var isAi = data.source === "ai";
    var profile = data.profile || {};
    var list = function (items) {
      return (items && items.length)
        ? '<ul class="pi-list">' + items.map(function (item) { return '<li>' + escapeHtml(item) + '</li>'; }).join("") + '</ul>'
        : '<p class="pi-muted">Nothing stood out here this time.</p>';
    };
    var changed = profile.previous
      ? '<p>Accuracy ' + (profile.previous.accuracyPctDelta >= 0 ? "up " : "down ") + escapeHtml(String(Math.abs(profile.previous.accuracyPctDelta))) + '% since your previous attempt' +
        (profile.previous.sameTest && profile.previous.scoreDelta !== null ? '; score ' + (profile.previous.scoreDelta >= 0 ? "+" : "") + escapeHtml(String(profile.previous.scoreDelta)) + ' on this test' : '') + '.</p>'
      : '<p class="pi-muted">This is your first attempt, so there is nothing to compare yet.</p>';
    var trajectory = (profile.trajectory || []).length > 1
      ? '<div class="pi-trajectory">' + profile.trajectory.map(function (value) {
        var height = Math.max(6, Math.min(100, Number(value) || 0));
        return '<span class="pi-bar" style="height:' + height + '%;" title="' + escapeAttribute(String(value)) + '% accuracy"></span>';
      }).join("") + '</div><p class="pi-muted">Accuracy across your recent attempts (oldest → latest).</p>'
      : '<p class="pi-muted">Take a few more mocks to see your trajectory.</p>';
    root.innerHTML =
      '<div class="pi-header">' +
      '<p class="section-label">Performance Intelligence</p>' +
      '<span class="pi-badge ' + (isAi ? 'is-ai' : 'is-deterministic') + '">' + (isAi ? 'AI interpretation' : 'Rule-based interpretation') + '</span>' +
      (data.pending ? '<span class="pi-muted"> · AI analysis in progress…</span>' : '') +
      '</div>' +
      '<p class="pi-verified-note">Score, accuracy, rank and percentile above are verified metrics calculated by the portal. The interpretation below explains them; it never changes them.</p>' +
      '<h3 class="pi-headline">' + escapeHtml(result.headline || "") + '</h3>' +
      '<div class="pi-grid">' +
      '<section><h4>What Changed?</h4>' + changed + '</section>' +
      '<section><h4>The Pattern</h4><p>' + escapeHtml(result.summary || "") + '</p></section>' +
      '<section><h4>Your Edge</h4>' + list(result.strengths) + '</section>' +
      '<section><h4>Where Marks Leak</h4>' + ((result.priorityAreas && result.priorityAreas.length)
        ? '<ul class="pi-list">' + result.priorityAreas.map(function (area) {
          return '<li><strong>' + escapeHtml(area.topic) + '</strong>: ' + escapeHtml(area.reason) + ' <em>' + escapeHtml(area.action) + '</em></li>';
        }).join("") + '</ul>'
        : '<p class="pi-muted">No clear weak spot this time.</p>') + '</section>' +
      '<section><h4>Your Error Fingerprint</h4>' + list(result.behaviorPatterns) + '</section>' +
      '<section><h4>Your Next Move</h4>' + list(result.nextTestStrategy) + '</section>' +
      '<section><h4>Your Trajectory</h4>' + trajectory + '</section>' +
      '</div>' +
      '<p class="pi-disclosure">' + escapeHtml(data.disclosure || "") + '</p>';
  }

  function mountPerformanceIntelligence(attemptId) {
    if (!store.getInterpretation) return;
    var polls = 0;
    var load = function () {
      var root = document.getElementById("performance-intelligence-root");
      if (!root) return;
      Promise.resolve(store.getInterpretation(attemptId)).then(function (data) {
        var liveRoot = document.getElementById("performance-intelligence-root");
        if (!liveRoot || !data) return;
        renderPerformanceIntelligence(liveRoot, data);
        polls += 1;
        if (data.pending && polls < 30) {
          window.setTimeout(load, 4000);
        }
      }).catch(function () {
        var liveRoot = document.getElementById("performance-intelligence-root");
        if (liveRoot) liveRoot.innerHTML = '<p class="section-label">Performance Intelligence</p><p class="pi-muted">Interpretation is unavailable right now. Your verified results above are complete.</p>';
      });
    };
    load();
  }

  function validateTestForPublish(test, questions) {
    var errors = [];
    var warnings = [];
    if (!test) return { errors: [{ msg: "No test selected." }], warnings: [] };
    if (!test.title || !test.title.trim()) errors.push({ type: "title", msg: "Test title is required." });
    var qIds = Array.isArray(test.questionIds) ? test.questionIds : [];
    var testQuestions = questions.filter(function (q) { return qIds.indexOf(q.id) !== -1; });
    if (testQuestions.length === 0) {
      errors.push({ type: "questions", msg: "Test currently has 0 attached questions." });
    }
    testQuestions.forEach(function (q, idx) {
      var num = idx + 1;
      if (!q.prompt || !q.prompt.trim()) errors.push({ type: "question", questionId: q.id, msg: "Question #" + num + " (ID: " + q.id + ") has empty prompt text." });
      if (!Array.isArray(q.options) || q.options.length < 2) errors.push({ type: "question", questionId: q.id, msg: "Question #" + num + " has fewer than 2 options." });
      if (q.correctOption === undefined || q.correctOption === null || Number(q.correctOption) < 0) errors.push({ type: "question", questionId: q.id, msg: "Question #" + num + " is missing correct answer." });
      if (!q.explanation || !q.explanation.trim()) warnings.push({ type: "question", questionId: q.id, msg: "Question #" + num + " is missing solution / explanation." });
      if (!q.topic || !q.topic.trim()) warnings.push({ type: "question", questionId: q.id, msg: "Question #" + num + " is missing topic tag." });
    });
    return { errors: errors, warnings: warnings };
  }

  function renderAdmin(user, preferredTestId) {
    if (!auth.isAdmin(user)) {
      navigate("dashboard");
      return;
    }

    try {
      localStorage.setItem("aceiiit_last_view", "admin");
    } catch (_e) { }

    try {
      var settings = store.getSettings();
      var questions = store.getQuestions();
      var tests = store.getTests();
      var adminSnapshot = store.getAdminSnapshot();
      var appConfig = (adminSnapshot && adminSnapshot.appConfig) || (store.getAppConfig ? store.getAppConfig() : { ugeeExamDate: null, featuredTestId: "", noticeTitle: "", noticeBody: "" });
      var editingTest = runtime.adminEditingTestId ? store.getTestById(runtime.adminEditingTestId) : null;
      var editingQuestion = runtime.adminEditingQuestionId
        ? questions.find(function (question) { return question.id === runtime.adminEditingQuestionId; }) || null
        : null;
      var questionEditorOpen = !!runtime.adminQuestionEditorOpen || !!editingQuestion;
      var questionMarkDefaults = getSectionDefaultMarking(editingQuestion ? editingQuestion.section : "SUPR");
      var pendingUploadedImageUrls = dedupeUrls(runtime.pendingUploadedQuestionImageUrls || []);
      var savedAdminTestId = (function () { try { return localStorage.getItem("aceiiit_last_admin_testid"); } catch (_e) { return ""; } })();
      runtime.adminSelectedTestId = preferredTestId || runtime.adminSelectedTestId || savedAdminTestId;
      var selectedTestId = tests.some(function (test) {
        return test.id === runtime.adminSelectedTestId;
      })
        ? runtime.adminSelectedTestId
        : (tests[0] ? tests[0].id : "");

      if (selectedTestId) {
        try { localStorage.setItem("aceiiit_last_admin_testid", selectedTestId); } catch (_e) { }
      }
      var selectedTest = tests.find(function (test) {
        return test.id === selectedTestId;
      }) || null;
      var selectedQuestionIds = selectedTest && Array.isArray(selectedTest.questionIds) ? selectedTest.questionIds : [];
      var selectedTestQuestions = selectedTest
        ? sortQuestionsForSelectedTest(selectedTest, questions.filter(function (question) {
          return selectedQuestionIds.indexOf(question.id) !== -1;
        }))
        : [];
      var selectedSuprCount = selectedTestQuestions.filter(function (question) {
        return question.section === "SUPR";
      }).length;
      var selectedReapCount = selectedTestQuestions.filter(function (question) {
        return question.section === "REAP";
      }).length;
      var totalAttachedCount = selectedTestQuestions.length;
      var progressPercent = Math.min(100, Math.round((totalAttachedCount / 90) * 100));

      runtime.adminStudioTab = runtime.adminStudioTab || "questions";
      runtime.adminCheckedBankQuestionIds = runtime.adminCheckedBankQuestionIds || [];
      runtime.adminCheckedTestQuestionIds = runtime.adminCheckedTestQuestionIds || [];

      var validation = validateTestForPublish(selectedTest, questions);

      var activePaperSummaryHtml = selectedTest
        ? (
          '<div class="active-paper-panel">' +
          '<p class="section-label">Active paper</p>' +
          '<div class="active-paper-title-row">' +
          '<strong>' + escapeHtml(selectedTest.title) + '</strong>' +
          '<span class="meta-chip ' + (selectedTest.status === "live" ? 'is-live' : 'is-draft') + '">' + escapeHtml(selectedTest.status || "draft") + '</span>' +
          '</div>' +
          '<div class="meta-row active-paper-chips">' +
          '<span class="meta-chip">SUPR ' + selectedSuprCount + ' / 40</span>' +
          '<span class="meta-chip">REAP ' + selectedReapCount + ' / 50</span>' +
          '<span class="meta-chip">' + (selectedTest.sectionDurations ? selectedTest.sectionDurations.SUPR : 60) + 'm / ' + (selectedTest.sectionDurations ? selectedTest.sectionDurations.REAP : 120) + 'm</span>' +
          '</div>' +
          '</div>'
        )
        : "";

      var questionUsage = {};
      // Question bank (Bank tab and the "Select from bank" drawer): one server page at a time.
      // The drawer excludes questions already in the selected test.
      var bankParams = {
        page: runtime.adminBankPage || 1,
        limit: 50,
        search: String(runtime.adminBankQuery || "").trim().slice(0, 64),
        section: runtime.adminBankSectionFilter,
        excludeTestId: runtime.adminBankModalOpen && selectedTest ? selectedTest.id : ""
      };
      var bankKey = JSON.stringify(bankParams) + "#" + ((adminSnapshot && adminSnapshot.__version) || 0);
      var bankState = runtime.adminBankResult && runtime.adminBankResult.key === bankKey ? runtime.adminBankResult : null;
      var bankNeeded = runtime.adminBankModalOpen || runtime.adminStudioTab === "bank";
      if (bankNeeded && !bankState && runtime.adminBankLoadingKey !== bankKey) {
        runtime.adminBankLoadingKey = bankKey;
        store.listAdminQuestions(bankParams).then(function (res) {
          runtime.adminBankResult = { key: bankKey, questions: res.questions || [], total: res.total || 0, page: res.page || 1, pages: res.pages || 1 };
        }).catch(function (error) {
          runtime.adminBankResult = { key: bankKey, questions: [], total: 0, page: 1, pages: 1, error: (error && error.message) || "Could not load the question bank." };
        }).then(function () {
          if (runtime.adminBankLoadingKey === bankKey) runtime.adminBankLoadingKey = "";
          if ((routeParts()[0] || "") === "admin") rerenderAdminPreserveScroll(user, selectedTestId);
        });
      }
      // While a new page loads, keep showing the previous one rather than flashing empty.
      var bankShown = bankState || (runtime.adminBankResult && !runtime.adminBankResult.error ? runtime.adminBankResult : null);
      var filteredBankQuestions = bankShown ? bankShown.questions : [];
      var bankEmptyHtml = !bankShown
        ? '<div class="empty-state">Loading questions…</div>'
        : (bankShown.error ? '<div class="empty-state">' + escapeHtml(bankShown.error) + '</div>' : '<div class="empty-state">No matching questions found.</div>');
      var bankPagerHtml = bankShown && !bankShown.error && bankShown.total
        ? '<div class="button-row admin-bank-pager" style="justify-content: space-between; align-items: center; margin-top: 12px;">' +
          '<span class="helper-text">Showing ' + ((bankShown.page - 1) * bankParams.limit + 1) + '–' + Math.min(bankShown.total, bankShown.page * bankParams.limit) + ' of ' + bankShown.total + (bankState ? '' : ' · updating…') + '</span>' +
          '<span class="button-row">' +
          '<button type="button" class="button button-secondary button-compact js-bank-page" data-page="' + (bankShown.page - 1) + '"' + (bankShown.page <= 1 ? ' disabled' : '') + '>← Prev</button>' +
          '<span class="helper-text">Page ' + bankShown.page + ' / ' + bankShown.pages + '</span>' +
          '<button type="button" class="button button-secondary button-compact js-bank-page" data-page="' + (bankShown.page + 1) + '"' + (bankShown.page >= bankShown.pages ? ' disabled' : '') + '>Next →</button>' +
          '</span></div>'
        : '';

      tests.forEach(function (test) {
        var tQIds = Array.isArray(test.questionIds) ? test.questionIds : [];
        tQIds.forEach(function (questionId) {
          questionUsage[questionId] = questionUsage[questionId] || [];
          questionUsage[questionId].push(test.title);
        });
      });

      var questionFormHtml = tests.length ? (
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
            return '<button type="button" class="question-figure-button" data-open-image="' + escapeAttribute(safeImageUrl(url)) + '"><img class="question-figure" src="' + safeImageUrl(url) + '" alt="Existing image ' + (index + 1) + '"></button>';
          }).join("") +
          '</div>' +
          '</div>'
        ) : '') +
        '<div class="field" style="grid-column: 1 / -1;">' +
        '<label for="question-files">Upload local images</label>' +
        '<input id="question-files" name="questionFiles" type="file" multiple accept="image/*">' +
        '<div class="helper-text" id="question-files-status">' + escapeHtml(runtime.pendingQuestionFileNames.length ? runtime.pendingQuestionFileNames.join(", ") : "No image selected") + '</div>' +
        '<div class="button-row" style="margin-top: 12px;">' +
        '<button class="button button-secondary" type="button" id="upload-question-images" ' + (runtime.pendingQuestionFiles.length ? "" : "disabled") + '>Upload selected images</button>' +
        '</div>' +
        '</div>' +
        '<div class="field" style="grid-column: 1 / -1;"><label for="question-drive-links">Google Drive image links</label><textarea id="question-drive-links" name="driveImageLinks" rows="2" placeholder="Paste public Google Drive image share links, one per line">' + escapeHtml(editingQuestion ? getQuestionDriveLinks(editingQuestion).join("\n") : "") + '</textarea></div>' +
        '<div class="field" style="grid-column: 1 / -1;"><label for="question-prompt">Question prompt</label><textarea id="question-prompt" name="prompt" rows="3" required>' + escapeHtml(editingQuestion ? editingQuestion.prompt : "") + '</textarea><div class="helper-text">Supports LaTeX: $...$ (inline), $$...$$ (display math).</div></div>' +
        '<div class="field" style="grid-column: 1 / -1;"><label for="question-passage">Passage or context</label><textarea id="question-passage" name="passage" rows="2" placeholder="Optional">' + escapeHtml(editingQuestion ? editingQuestion.passage || "" : "") + '</textarea></div>' +
        '<div class="field"><label for="option-0">Option A</label><input id="option-0" name="option0" value="' + escapeAttribute(editingQuestion ? editingQuestion.options[0] : "") + '" required></div>' +
        '<div class="field"><label for="option-1">Option B</label><input id="option-1" name="option1" value="' + escapeAttribute(editingQuestion ? editingQuestion.options[1] : "") + '" required></div>' +
        '<div class="field"><label for="option-2">Option C</label><input id="option-2" name="option2" value="' + escapeAttribute(editingQuestion ? editingQuestion.options[2] : "") + '" required></div>' +
        '<div class="field"><label for="option-3">Option D</label><input id="option-3" name="option3" value="' + escapeAttribute(editingQuestion ? editingQuestion.options[3] : "") + '" required></div>' +
        '<div class="field"><label for="correct-option">Correct option</label><select id="correct-option" name="correctOption"><option value="0" ' + (editingQuestion && Number(editingQuestion.correctOption) === 0 ? 'selected' : '') + '>A</option><option value="1" ' + (editingQuestion && Number(editingQuestion.correctOption) === 1 ? 'selected' : '') + '>B</option><option value="2" ' + (editingQuestion && Number(editingQuestion.correctOption) === 2 ? 'selected' : '') + '>C</option><option value="3" ' + (editingQuestion && Number(editingQuestion.correctOption) === 3 ? 'selected' : '') + '>D</option></select></div>' +
        '<div class="field"><label for="question-marks">Marks</label><input id="question-marks" name="marks" type="number" step="any" inputmode="decimal" value="' + (editingQuestion ? editingQuestion.marks : questionMarkDefaults.marks) + '"></div>' +
        '<div class="field"><label for="question-negative">Negative marks</label><input id="question-negative" name="negativeMarks" type="number" step="any" value="' + (editingQuestion ? Math.abs(editingQuestion.negativeMarks) : questionMarkDefaults.negativeMarks) + '"></div>' +
        '<div class="field" style="grid-column: 1 / -1;"><label for="question-explanation">Solution / Explanation</label><textarea id="question-explanation" name="explanation" rows="3" required>' + escapeHtml(editingQuestion ? editingQuestion.explanation : "") + '</textarea></div>' +
        '<div class="field" style="grid-column: 1 / -1;">' +
        '<div class="latex-preview-toolbar">' +
        '<div><p class="section-label" style="margin:0;">Live LaTeX preview</p></div>' +
        '<div class="button-row">' +
        '<button type="button" class="button button-secondary button-compact" id="latex-preview-toggle">' + (runtime.adminLatexPreviewVisible ? "Hide preview" : "Show preview") + '</button>' +
        '<button type="button" class="button button-secondary button-compact" id="latex-preview-full">Full screen</button>' +
        '</div>' +
        '</div>' +
        '<div id="latex-preview-inline" class="latex-preview" style="display:' + (runtime.adminLatexPreviewVisible ? "block" : "none") + ';"></div>' +
        '</div>' +
        '<div class="question-editor-actions-bar" style="grid-column: 1 / -1; margin-top: 20px; padding-bottom: 36px; position: relative; z-index: 100;">' +
        '<div class="button-row" style="justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap;">' +
        '<div class="button-row" style="gap: 12px;">' +
        '<button class="button button-primary" type="submit" id="question-save-btn">' + (editingQuestion ? 'Update Question' : 'Save Question') + '</button>' +
        '<button class="button button-secondary" type="button" id="question-save-next" style="background:var(--gold); color:#fff; border-color:var(--gold-strong); font-weight: 700;">⚡ Save & Add Next (Ctrl+Enter)</button>' +
        '</div>' +
        '<div class="button-row" style="gap: 12px;">' +
        (editingQuestion ? '<button class="button button-secondary js-duplicate-question" type="button" data-id="' + escapeAttribute(editingQuestion.id) + '">📋 Duplicate</button>' : '') +
        '<button class="button button-secondary" type="button" id="cancel-question-edit">' + (editingQuestion ? 'Cancel Edit' : 'Clear Form') + '</button>' +
        '</div>' +
        '</div>' +
        '</div>' +
        '</form>'
      ) : '<div class="empty-state">Create a test first. As soon as a paper exists, you can add questions directly into it here.</div>';

      var inlineAuthoringHtml = questionEditorOpen
        ? '<div class="empty-state">Focused Question Studio is active in the modal overlay. Complete your edits there, or click Close to return to inline authoring.</div>'
        : questionFormHtml;

      var questionEditorModalHtml = questionEditorOpen
        ? (
          '<div class="transition-modal admin-modal-overlay" id="question-editor-overlay">' +
          '<div class="admin-modal-card question-editor-modal is-large">' +
          '<div class="admin-modal-head">' +
          '<div><p class="section-label" style="margin:0;">Focused question studio</p><h3>' + escapeHtml(editingQuestion ? "Edit question" : "Add question") + '</h3></div>' +
          '<button class="button button-secondary button-compact" type="button" id="question-editor-close">Close</button>' +
          '</div>' +
          '<div class="admin-modal-body question-editor-body">' +
          activePaperSummaryHtml +
          questionFormHtml +
          '</div>' +
          '</div>' +
          '</div>'
        )
        : "";

      var bankDrawerHtml = runtime.adminBankModalOpen
        ? (
          '<div class="transition-modal admin-modal-overlay" id="bank-drawer-overlay">' +
          '<div class="admin-modal-card is-large" style="max-width: 1000px;">' +
          '<div class="admin-modal-head">' +
          '<div><p class="section-label" style="margin:0;">Question bank workspace</p><h3>Select Questions to Attach</h3></div>' +
          '<button class="button button-secondary button-compact" type="button" id="close-bank-drawer">Close</button>' +
          '</div>' +
          '<div class="admin-modal-body">' +
          '<div class="admin-bank-toolbar">' +
          '<div class="field"><label for="bank-drawer-search">Search</label><input id="bank-drawer-search" value="' + escapeAttribute(runtime.adminBankQuery || "") + '" placeholder="Search by ID, prompt, topic"></div>' +
          '<div class="field"><label for="bank-drawer-section">Section</label><select id="bank-drawer-section"><option value="all"' + (runtime.adminBankSectionFilter === "all" ? ' selected' : '') + '>All</option><option value="SUPR"' + (runtime.adminBankSectionFilter === "SUPR" ? ' selected' : '') + '>SUPR</option><option value="REAP"' + (runtime.adminBankSectionFilter === "REAP" ? ' selected' : '') + '>REAP</option></select></div>' +
          '</div>' +
          '<div class="button-row" style="margin: 12px 0; justify-content: space-between;">' +
          '<span class="helper-text">Selected: <strong>' + runtime.adminCheckedBankQuestionIds.length + '</strong> questions</span>' +
          '</div>' +
          (filteredBankQuestions.length ? (
            '<div class="question-bank compact-bank list-scroll-card" style="max-height: 420px;">' +
            filteredBankQuestions.map(function (q) {
              var checked = runtime.adminCheckedBankQuestionIds.indexOf(q.id) !== -1 ? ' checked' : '';
              return '<div class="bank-item" style="display:flex; align-items:center; gap:12px;">' +
                '<input type="checkbox" class="js-bank-multi-checkbox" data-id="' + escapeAttribute(q.id) + '"' + checked + '>' +
                '<div style="flex:1;"><strong>' + escapeHtml(q.id) + ' | ' + escapeHtml(q.section) + ' | ' + escapeHtml(q.topic) + '</strong><span>' + formatRichText(q.prompt) + '</span></div>' +
                '</div>';
            }).join("") +
            '</div>'
          ) : bankEmptyHtml) +
          bankPagerHtml +
          '<div class="button-row" style="margin-top:18px; justify-content: flex-end;">' +
          '<button class="button button-primary" type="button" id="attach-bank-selected-bulk" ' + (runtime.adminCheckedBankQuestionIds.length ? "" : "disabled") + '>Add ' + runtime.adminCheckedBankQuestionIds.length + ' Questions to Test</button>' +
          '</div>' +
          '</div>' +
          '</div>' +
          '</div>'
        )
        : "";

      var randomModalHtml = runtime.adminRandomModalOpen
        ? (
          '<div class="transition-modal admin-modal-overlay" id="random-modal-overlay">' +
          '<div class="admin-modal-card">' +
          '<div class="admin-modal-head">' +
          '<div><p class="section-label" style="margin:0;">Random Question Generator</p><h3>Batch Attach Random Questions</h3></div>' +
          '<button class="button button-secondary button-compact" type="button" id="close-random-modal">Close</button>' +
          '</div>' +
          '<div class="admin-modal-body">' +
          '<div class="field"><label for="random-supr-count">SUPR Questions to Add</label><input id="random-supr-count" type="number" inputmode="numeric" value="40" min="0" max="40"></div>' +
          '<div class="field"><label for="random-reap-count">REAP Questions to Add</label><input id="random-reap-count" type="number" inputmode="numeric" value="50" min="0" max="50"></div>' +
          '<div class="button-row" style="margin-top: 18px; justify-content: space-between; align-items: center;">' +
          (runtime.lastRandomBatch && selectedTest && runtime.lastRandomBatch.testId === selectedTest.id ? '<button class="button button-secondary button-compact js-undo-random-batch" type="button" style="background:#fff2f2; border-color:#fca5a5; color:#991b1b;">↩ Undo Last Batch (' + runtime.lastRandomBatch.attachedCount + ' qns)</button>' : '<span></span>') +
          '<button class="button button-primary" type="button" id="confirm-random-generate">Generate & Attach Questions</button>' +
          '</div>' +
          '</div>' +
          '</div>' +
          '</div>'
        )
        : "";

      var studentPreviewHtml = runtime.adminStudentPreviewOpen && selectedTest
        ? (
          '<div class="transition-modal admin-modal-overlay" id="student-preview-overlay">' +
          '<div class="admin-modal-card is-large" style="max-width: 1100px; height: 85vh; display: flex; flex-direction: column;">' +
          '<div class="admin-modal-head">' +
          '<div><p class="section-label" style="margin:0;">Student Exam UI Preview</p><h3>' + escapeHtml(selectedTest.title) + ' (Read-Only Preview)</h3></div>' +
          '<button class="button button-secondary button-compact" type="button" id="close-student-preview">Close Preview</button>' +
          '</div>' +
          '<div class="admin-modal-body" style="flex:1; overflow-y:auto; padding:20px; background:var(--paper);">' +
          '<div class="active-paper-panel" style="margin-bottom:20px;">' +
          '<div class="active-paper-title-row"><strong>' + escapeHtml(selectedTest.title) + '</strong><span class="meta-chip">PREVIEW MODE</span></div>' +
          '<p>' + escapeHtml(selectedTest.subtitle || "") + '</p>' +
          '</div>' +
          (selectedTestQuestions.length ? selectedTestQuestions.map(function (q, idx) {
            return '<div class="question-card" style="margin-bottom:16px; padding:16px; border-radius:12px; background:var(--surface); border:1px solid rgba(20,17,15,0.08);">' +
              '<strong>Q' + (idx + 1) + ' [' + escapeHtml(q.section) + '] (' + escapeHtml(q.topic) + ')</strong>' +
              '<div style="margin:10px 0;">' + formatRichText(q.prompt) + '</div>' +
              '<div style="display:grid; grid-template-columns:1fr 1fr; gap:8px;">' +
              q.options.map(function (opt, oIdx) {
                var letter = String.fromCharCode(65 + oIdx);
                var isCorrect = Number(q.correctOption) === oIdx;
                return '<div style="padding:8px 12px; border-radius:6px; border:1px solid ' + (isCorrect ? 'var(--green)' : 'rgba(20,17,15,0.1)') + '; background:' + (isCorrect ? 'rgba(21,115,71,0.08)' : 'transparent') + ';"><strong>' + letter + '.</strong> ' + escapeHtml(opt) + '</div>';
              }).join("") +
              '</div>' +
              '</div>';
          }).join("") : '<div class="empty-state">No questions attached to this test yet.</div>') +
          '</div>' +
          '</div>' +
          '</div>'
        )
        : "";

      var activeTab = runtime.adminStudioTab;
      var activeTabContent = "";

      if (activeTab === "setup") {
        activeTabContent =
          '<div class="admin-grid">' +
          '<div class="admin-card">' +
          '<p class="section-label">1. Test Basic Information & Instructions</p>' +
          '<div class="button-row" style="margin-bottom: 14px; gap: 8px;">' +
          '<span class="helper-text" style="align-self: center;">Preset Templates:</span>' +
          '<button type="button" class="button button-secondary button-compact js-apply-template" data-preset="ugee-full">UGEE Full Mock (60m/120m)</button>' +
          '<button type="button" class="button button-secondary button-compact js-apply-template" data-preset="supr-only">SUPR Sectional (60m)</button>' +
          '<button type="button" class="button button-secondary button-compact js-apply-template" data-preset="reap-only">REAP Sectional (120m)</button>' +
          '</div>' +
          '<form id="test-form">' +
          '<div class="grid-two">' +
          '<div class="field"><label for="test-title">Title</label><input id="test-title" name="title" value="' + escapeAttribute(editingTest ? editingTest.title : (selectedTest ? selectedTest.title : "")) + '" required></div>' +
          '<div class="field"><label for="test-subtitle">Subtitle</label><input id="test-subtitle" name="subtitle" value="' + escapeAttribute(editingTest ? editingTest.subtitle : (selectedTest ? selectedTest.subtitle : "")) + '" required></div>' +
          '<div class="field"><label for="test-series">Series</label><input id="test-series" name="series" value="' + escapeAttribute(editingTest ? (editingTest.series || "UGEE 2026") : (selectedTest ? (selectedTest.series || "UGEE 2026") : "UGEE 2026")) + '" required></div>' +
          '<div class="field"><label for="test-access">Access Control</label><select id="test-access" name="isFree"><option value="true"' + ((editingTest ? editingTest.isFree : (selectedTest ? selectedTest.isFree : true)) ? ' selected' : '') + '>Free</option><option value="false"' + (!(editingTest ? editingTest.isFree : (selectedTest ? selectedTest.isFree : true)) ? ' selected' : '') + '>Paid</option></select></div>' +
          '<div class="field"><label for="supr-duration">SUPR Duration (mins)</label><input id="supr-duration" name="suprDurationMinutes" type="number" inputmode="numeric" value="' + (editingTest && editingTest.sectionDurations ? editingTest.sectionDurations.SUPR : (selectedTest && selectedTest.sectionDurations ? selectedTest.sectionDurations.SUPR : 60)) + '" required></div>' +
          '<div class="field"><label for="reap-duration">REAP Duration (mins)</label><input id="reap-duration" name="reapDurationMinutes" type="number" inputmode="numeric" value="' + (editingTest && editingTest.sectionDurations ? editingTest.sectionDurations.REAP : (selectedTest && selectedTest.sectionDurations ? selectedTest.sectionDurations.REAP : 120)) + '" required></div>' +
          (function () {
            var policySource = editingTest || selectedTest || {};
            var policy = policySource.integrity || { mode: "warn", autoSubmitThreshold: 5 };
            return '<div class="field"><label for="test-integrity-mode">Exam integrity</label><select id="test-integrity-mode" name="integrityMode">' +
              [["record", "Record only (no warnings)"], ["warn", "Warn (default)"], ["strict", "Strict (auto-submit over limit)"]].map(function (opt) {
                return '<option value="' + opt[0] + '"' + (policy.mode === opt[0] ? ' selected' : '') + '>' + opt[1] + '</option>';
              }).join("") +
              '</select></div>' +
              '<div class="field"><label for="test-integrity-limit">Strict auto-submit after (recorded events)</label><input id="test-integrity-limit" name="integrityAutoSubmitThreshold" type="number" inputmode="numeric" min="1" max="100" value="' + Number(policy.autoSubmitThreshold || 5) + '"></div>' +
              '<div class="field"><label><input type="checkbox" name="shuffleQuestions"' + (policySource.shuffleQuestions ? ' checked' : '') + '> Shuffle question order per student</label></div>' +
              '<div class="field"><label><input type="checkbox" name="shuffleOptions"' + (policySource.shuffleOptions ? ' checked' : '') + '> Shuffle answer options per student</label></div>';
          })() +
          '<div class="field"><label for="test-benchmark">Benchmark Scores</label><input id="test-benchmark" name="benchmarkScores" placeholder="18,22,26,31" value="' + escapeAttribute(editingTest && Array.isArray(editingTest.benchmarkScores) ? editingTest.benchmarkScores.join(",") : (selectedTest && Array.isArray(selectedTest.benchmarkScores) ? selectedTest.benchmarkScores.join(",") : "")) + '"></div>' +
          '</div>' +
          '<div class="field" style="margin-top: 16px;"><label for="test-instructions">Instructions (one line each)</label><textarea id="test-instructions" name="instructions" rows="4">' + escapeHtml(editingTest ? editingTest.instructions.join("\n") : (selectedTest ? selectedTest.instructions.join("\n") : 'Read all instructions carefully.\nSUPR locks after its timer or after every SUPR question is answered.\nREAP opens automatically and the test submits when the REAP timer ends.')) + '</textarea></div>' +
          '<div class="button-row" style="margin-top: 18px;">' +
          '<button class="button button-primary" type="submit">' + (editingTest ? 'Update test' : (selectedTest ? 'Update Selected Test' : 'Create test')) + '</button>' +
          (editingTest ? '<button class="button button-secondary" type="button" id="cancel-test-edit">Cancel Edit</button>' : '') +
          '</div>' +
          '</form>' +
          '</div>' +
          '<aside class="admin-card">' +
          activePaperSummaryHtml +
          '<div class="divider"></div>' +
          '<p class="section-label">Quick Actions</p>' +
          '<div class="button-row" style="flex-direction:column; align-items:stretch;">' +
          '<button class="button button-secondary js-studio-tab" data-tab="questions">Proceed to Questions Studio →</button>' +
          '</div>' +
          '</aside>' +
          '</div>';
      } else if (activeTab === "questions") {
        activeTabContent =
          '<div class="studio-shell">' +
          '<div class="studio-question-progress">' +
          '<div class="button-row" style="justify-content:space-between; align-items:center;">' +
          '<div>' +
          '<strong>' + totalAttachedCount + ' / 90 Questions Attached</strong>' +
          '<span class="helper-text" style="margin-left:12px;">(' + progressPercent + '% Complete)</span>' +
          '</div>' +
          '<div class="button-row">' +
          (runtime.lastRandomBatch && runtime.lastRandomBatch.testId === selectedTest.id ? '<button class="button button-secondary button-compact js-undo-random-batch" type="button" style="background:#fff2f2; border-color:#fca5a5; color:#991b1b; font-weight:700;">↩ Undo Random Gen (' + runtime.lastRandomBatch.attachedCount + ' qns)</button>' : '') +
          '<button class="button button-secondary button-compact" id="open-bank-drawer">📦 Select from Question Bank</button>' +
          '<button class="button button-secondary button-compact" id="open-random-modal">🎲 Random Generator</button>' +
          '<button class="button button-secondary button-compact" id="open-question-editor">+ Create Question</button>' +
          '</div>' +
          '</div>' +
          '<div class="studio-progress-bar-track"><div class="studio-progress-bar-fill" style="width:' + progressPercent + '%;"></div></div>' +
          '<div class="meta-row active-paper-chips">' +
          '<span class="meta-chip">SUPR: ' + selectedSuprCount + ' / 40 ' + (selectedSuprCount === 40 ? '✓' : '') + '</span>' +
          '<span class="meta-chip">REAP: ' + selectedReapCount + ' / 50 ' + (selectedReapCount === 50 ? '✓' : '') + '</span>' +
          '</div>' +
          '</div>' +

          '<div class="admin-grid" style="grid-template-columns: minmax(0, 1.2fr) minmax(360px, 0.8fr);">' +
          '<div class="admin-card">' +
          '<div class="button-row" style="justify-content: space-between; align-items: center; margin-bottom: 12px;">' +
          '<p class="section-label" style="margin:0;">Compact Question List & Navigator</p>' +
          '<button class="button button-secondary button-compact" type="button" id="open-question-editor">Open Broad Editor</button>' +
          '</div>' +
          '<div class="studio-nav-grid" style="margin-bottom:16px;">' +
          (selectedTestQuestions.length ? selectedTestQuestions.map(function (q, idx) {
            var num = idx + 1;
            var isComp = q.prompt && q.options && q.options.length >= 2 && q.correctOption !== undefined;
            var isEditing = editingQuestion && editingQuestion.id === q.id;
            return '<button type="button" class="studio-q-box js-edit-question-inline ' + (isEditing ? 'is-selected ' : '') + (isComp ? 'is-complete' : 'is-incomplete') + '" data-id="' + escapeAttribute(q.id) + '">' + num + '</button>';
          }).join("") : '<div class="helper-text">No questions attached yet. Click "+ Create Question" or "Select from Question Bank".</div>') +
          '</div>' +
          (selectedTestQuestions.length ? (
            '<div class="question-bank compact-bank list-scroll-card bank-flow-list" style="--bank-max: 520px;">' +
            selectedTestQuestions.map(function (question, index) {
              var isEditing = editingQuestion && editingQuestion.id === question.id;
              var isChecked = runtime.adminCheckedTestQuestionIds.indexOf(question.id) !== -1 ? ' checked' : '';
              return '<div class="studio-compact-row ' + (isEditing ? 'is-active' : '') + '">' +
                '<input type="checkbox" class="js-test-q-checkbox" data-id="' + escapeAttribute(question.id) + '"' + isChecked + '>' +
                '<strong>' + String(index + 1).padStart(2, '0') + '</strong>' +
                '<div style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + formatRichText(question.prompt) + '</div>' +
                '<span class="meta-chip">' + escapeHtml(question.section) + '</span>' +
                '<span class="helper-text">' + escapeHtml(question.topic || "-") + '</span>' +
                '<span class="helper-text">Diff: ' + escapeHtml(question.difficulty || "medium") + '</span>' +
                '<div class="button-row">' +
                '<button class="button button-secondary button-compact js-edit-question-inline" data-id="' + escapeAttribute(question.id) + '">Edit</button>' +
                '<button class="button button-secondary button-compact js-duplicate-question" data-id="' + escapeAttribute(question.id) + '">Copy</button>' +
                '<button class="button button-secondary button-compact js-detach-question" data-id="' + escapeAttribute(question.id) + '">Del</button>' +
                '</div>' +
                '</div>';
            }).join("") +
            '</div>'
          ) : '<div class="empty-state">No questions in paper. Click "+ Create Question" or "Select from Question Bank".</div>') +
          '</div>' +

          '<aside class="admin-card">' +
          '<p class="section-label">' + (editingQuestion ? 'Edit Question #' + (selectedTestQuestions.findIndex(function (q) { return q.id === editingQuestion.id; }) + 1) : 'Rapid Question Authoring') + '</p>' +
          inlineAuthoringHtml +
          '</aside>' +
          '</div>' +
          (runtime.adminCheckedTestQuestionIds.length ? (
            '<div class="studio-bulk-floatbar">' +
            '<strong>' + runtime.adminCheckedTestQuestionIds.length + ' Questions Selected</strong>' +
            '<div class="button-row" style="gap: 8px;">' +
            '<button class="button button-danger button-compact" id="detach-selected-bulk">Remove Selected</button>' +
            '<button class="button button-secondary button-compact" id="clear-selected-bulk">Cancel Selection</button>' +
            '</div>' +
            '</div>'
          ) : "") +
          '</div>';
      } else if (activeTab === "bank") {
        activeTabContent =
          '<div class="admin-card">' +
          '<div class="button-row" style="justify-content: space-between; align-items: center; margin-bottom: 12px;">' +
          '<p class="section-label" style="margin:0;">Question Bank Workspace</p>' +
          '<button class="button button-secondary button-compact" type="button" id="open-bank-modal">Full Screen Modal</button>' +
          '</div>' +
          '<div class="admin-bank-toolbar">' +
          '<div class="field"><label for="bank-search">Search Question</label><input id="bank-search" value="' + escapeAttribute(runtime.adminBankQuery || "") + '" placeholder="Search by ID, topic, prompt"></div>' +
          '<div class="field"><label for="bank-filter">Filter Section</label><select id="bank-filter"><option value="all"' + (runtime.adminBankSectionFilter === "all" ? ' selected' : '') + '>All</option><option value="SUPR"' + (runtime.adminBankSectionFilter === "SUPR" ? ' selected' : '') + '>SUPR</option><option value="REAP"' + (runtime.adminBankSectionFilter === "REAP" ? ' selected' : '') + '>REAP</option></select></div>' +
          '</div>' +
          (filteredBankQuestions.length ? (
            '<div class="question-bank list-scroll-card bank-flow-list">' +
            filteredBankQuestions.map(function (question) {
              var attachedTo = questionUsage[question.id] || [];
              return (
                '<div class="bank-item">' +
                '<strong>' + escapeHtml(question.id) + ' | ' + escapeHtml(question.section) + ' | ' + escapeHtml(question.topic) + '</strong>' +
                '<span>' + formatRichText(question.prompt) + '</span>' +
                '<span class="helper-text">' + (attachedTo.length ? 'Attached to: ' + escapeHtml(attachedTo.join(", ")) : 'Not attached') + '</span>' +
                '<div class="button-row"><button class="button button-secondary button-compact js-attach-question" data-question="' + escapeAttribute(question.id) + '">Attach to Paper</button><button class="button button-secondary button-compact js-edit-question" data-id="' + escapeAttribute(question.id) + '">Edit</button><button class="button button-danger button-compact js-delete-question" data-id="' + escapeAttribute(question.id) + '">Delete</button></div>' +
                '</div>'
              );
            }).join("") +
            '</div>'
          ) : bankEmptyHtml) +
          bankPagerHtml +
          '</div>';
      } else if (activeTab === "review") {
        activeTabContent =
          '<div class="admin-card">' +
          '<p class="section-label">4. Pre-Publish Review & Validation Engine</p>' +
          '<div class="active-paper-panel" style="margin-bottom: 20px;">' +
          '<div class="active-paper-title-row"><strong>' + escapeHtml(selectedTest ? selectedTest.title : "No test selected") + '</strong></div>' +
          '<p>' + totalAttachedCount + ' / 90 questions attached. (' + selectedSuprCount + ' SUPR / ' + selectedReapCount + ' REAP)</p>' +
          '</div>' +

          '<h3>Validation Checks</h3>' +
          (validation.errors.length ? (
            '<div><h4 style="color:var(--red);">Errors (Blocking Publish)</h4>' +
            validation.errors.map(function (err) {
              return '<div class="validation-card is-error"><strong>❌ ' + escapeHtml(err.msg) + '</strong></div>';
            }).join("") +
            '</div>'
          ) : '<div class="validation-card is-success"><strong>✓ No blocking errors found! Test meets minimum criteria.</strong></div>') +

          (validation.warnings.length ? (
            '<div style="margin-top: 20px;"><h4 style="color:var(--gold-strong);">Warnings & Recommended Fixes</h4>' +
            validation.warnings.map(function (warn) {
              return '<div class="validation-card is-warning"><strong>⚠️ ' + escapeHtml(warn.msg) + '</strong></div>';
            }).join("") +
            '</div>'
          ) : '') +

          '<div class="button-row" style="margin-top: 24px; justify-content: flex-end;">' +
          '<button class="button button-secondary js-studio-tab" data-tab="questions">← Back to Questions Studio</button>' +
          '<button class="button button-primary" id="publish-test-btn" ' + (validation.errors.length ? "disabled" : "") + '>Publish Test Now</button>' +
          '</div>' +
          '</div>';
      } else if (activeTab === "tests") {
        activeTabContent =
          '<div class="admin-card">' +
          '<div class="button-row" style="justify-content: space-between; align-items: center; margin-bottom: 12px;">' +
          '<p class="section-label" style="margin:0;">Existing Tests Management</p>' +
          '<button class="button button-secondary button-compact js-studio-tab" data-tab="setup">+ Create New Test</button>' +
          '</div>' +
          (tests.length ? (
            '<div class="table-like tests-table table-scroll-card">' +
            '<div class="table-row header"><span>Test Title</span><span>Status</span><span>Questions</span><span>Durations</span><span>Actions</span></div>' +
            tests.map(function (test, index) {
              return '<div class="table-row">' +
                '<span class="' + (test.status === "live" ? 'test-title-live' : '') + '"><strong>' + escapeHtml(test.title) + '</strong><br><small>' + escapeHtml(test.series || "UGEE") + '</small></span>' +
                '<span><span class="meta-chip ' + (test.status === "live" ? 'is-live' : 'is-draft') + '">' + escapeHtml(test.status || "draft") + '</span></span>' +
                '<span>' + (Array.isArray(test.questionIds) ? test.questionIds.length : 0) + ' / 90</span>' +
                '<span>' + (test.sectionDurations ? test.sectionDurations.SUPR : 60) + 'm / ' + (test.sectionDurations ? test.sectionDurations.REAP : 120) + 'm</span>' +
                '<span><div class="button-row">' +
                '<button class="button button-secondary button-compact js-pick-test" data-id="' + escapeHtml(test.id) + '">' + (test.id === selectedTestId ? 'Active' : 'Select') + '</button>' +
                '<button class="button button-secondary button-compact js-duplicate-test" data-id="' + escapeHtml(test.id) + '">Duplicate</button>' +
                '<button class="button button-secondary button-compact js-toggle-live" data-id="' + escapeHtml(test.id) + '">' + (test.status === "live" ? 'Draft' : 'Publish') + '</button>' +
                '<button class="button button-secondary button-compact js-export-pdf" data-id="' + escapeHtml(test.id) + '">PDF</button>' +
                '<button class="button button-danger button-compact js-delete-test" data-id="' + escapeHtml(test.id) + '">Del</button>' +
                '</div></span>' +
                '</div>';
            }).join("") +
            '</div>'
          ) : '<div class="empty-state">No tests created yet.</div>') +
          '</div>';
      } else if (activeTab === "payments") {
        var allUsers = (adminSnapshot && Array.isArray(adminSnapshot.users)) ? adminSnapshot.users : [];
        var searchQuery = (runtime.adminUserSearchQuery || "").toLowerCase().trim();
        var filterTab = runtime.adminUserFilterTab || "paid";
        var paidCount = allUsers.filter(function (u) { return u.isPaid; }).length;

        var filteredUsers = allUsers.filter(function (u) {
          if (filterTab === "paid" && !u.isPaid) {
            return false;
          }
          if (!searchQuery) return true;
          return (u.name || "").toLowerCase().indexOf(searchQuery) !== -1 || (u.email || "").toLowerCase().indexOf(searchQuery) !== -1;
        });

        activeTabContent =
          '<div class="admin-card">' +
          '<div class="button-row" style="justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 12px;">' +
          '<div>' +
          '<p class="section-label" style="margin:0;">Payments & Entitlements</p>' +
          '<h3 style="margin: 4px 0 0 0;">User Payment & Access Control</h3>' +
          '<p style="margin: 6px 0 0; font-size: 0.85rem; color: var(--ink-soft);">Purchases from the AceIIIT checkout are provisioned automatically. Use "Add payment" for offline/manual cases; access is granted once the payment is verified.</p>' +
          '</div>' +
          '</div>' +

          '<form id="admin-add-payment-form" class="grid-three" style="margin-bottom: 20px; align-items: end;">' +
          '<div class="field"><label for="add-payment-email">Student email</label><input id="add-payment-email" name="email" type="email" required autocomplete="off" inputmode="email" placeholder="student@example.com"></div>' +
          '<div class="field"><label for="add-payment-name">Name (optional)</label><input id="add-payment-name" name="name" maxlength="120"></div>' +
          '<div class="field"><label for="add-payment-note">Note (optional)</label><input id="add-payment-note" name="note" maxlength="500" placeholder="e.g. UPI ref / offline receipt"></div>' +
          '<div class="field"><label><input type="checkbox" name="verifyNow" checked> Verify now and grant access to the active season</label></div>' +
          '<div class="field"><button class="button button-primary" type="submit">Add payment</button></div>' +
          '</form>' +

          '<div class="grid-three" style="margin-bottom: 20px;">' +
          '<div class="metric-card" style="border-left: 4px solid var(--green);"><span class="metric-value" style="color:var(--green);">' + paidCount + '</span><span class="metric-label">Total Paid Verified Users</span></div>' +
          '<div class="metric-card"><span class="metric-value">' + allUsers.length + '</span><span class="metric-label">Total Registered Users</span></div>' +
          '</div>' +

          '<div class="button-row" style="gap: 8px; margin-bottom: 14px; flex-wrap: wrap;">' +
          '<button class="button button-compact ' + (filterTab === "paid" ? "button-primary" : "button-secondary") + ' js-admin-user-filter" data-filter="paid">🎓 Paid / Enrolled (' + paidCount + ')</button>' +
          '<button class="button button-compact ' + (filterTab === "all" ? "button-primary" : "button-secondary") + ' js-admin-user-filter" data-filter="all">👥 All Registered Users (' + allUsers.length + ')</button>' +
          '</div>' +

          '<div class="field" style="margin-bottom: 16px;">' +
          '<input type="text" id="admin-user-search" value="' + escapeAttribute(runtime.adminUserSearchQuery || "") + '" placeholder="🔍 Search users by name or email address...">' +
          '</div>' +

          (filteredUsers.length ? (
            '<div class="table-like users-table table-scroll-card">' +
            '<div class="table-row header"><span>User</span><span>Email</span><span>Role</span><span>Payment Access</span><span>Actions</span></div>' +
            filteredUsers.map(function (u) {
              var isPaid = !!u.isPaid;
              return '<div class="table-row">' +
                '<span><strong>' + escapeHtml(u.name || "Student") + '</strong></span>' +
                '<span>' + escapeHtml(u.email) + '</span>' +
                '<span><span class="meta-chip">' + escapeHtml(u.role || "student") + '</span></span>' +
                '<span>' +
                (isPaid
                  ? '<span class="meta-chip is-live" style="background:rgba(21,115,71,0.12); color:#157347; font-weight:700;">✓ PAID VERIFIED</span>'
                  : '<span class="meta-chip is-draft" style="background:rgba(20,17,15,0.06); color:#666;">FREE TIER</span>') +
                '</span>' +
                '<span><div class="button-row" style="gap: 6px;">' +
                '<button class="button button-secondary button-compact js-view-user-details" data-id="' + escapeAttribute(u.id) + '">👤 Details</button>' +
                (!isPaid
                  ? '<button class="button button-primary button-compact js-verify-user-payment" data-id="' + escapeAttribute(u.id) + '" data-email="' + escapeAttribute(u.email) + '">Verify & Grant Access</button>'
                  : '<button class="button button-secondary button-compact js-revoke-user-payment" data-id="' + escapeAttribute(u.id) + '" style="color:#991b1b;">Revoke Access</button>') +
                '</div></span>' +
                '</div>';
            }).join("") +
            '</div>'
          ) : '<div class="empty-state">No matching paid users found. Try "All Registered Users" or add a payment above.</div>') +
          '</div>';
      } else if (activeTab === "seasons") {
        var seasonsList = (runtime.adminSeasonsList || []);
        activeTabContent =
          '<div class="admin-card">' +
          '<div class="button-row" style="justify-content: space-between; align-items: center; margin-bottom: 16px;">' +
          '<div>' +
          '<p class="section-label" style="margin:0;">Exam Cycles & Season Management</p>' +
          '<h3 style="margin: 4px 0 0 0;">Exam Seasons System</h3>' +
          '</div>' +
          '<button class="button button-primary button-compact" id="create-season-btn">+ Create New Season</button>' +
          '</div>' +
          (seasonsList.length ? (
            '<div class="table-like seasons-table table-scroll-card">' +
            '<div class="table-row header"><span>Season Name</span><span>Exam</span><span>Year</span><span>Status</span><span>Active Default</span><span>Actions</span></div>' +
            seasonsList.map(function (s) {
              return '<div class="table-row">' +
                '<span><strong>' + escapeHtml(s.name) + '</strong></span>' +
                '<span>' + escapeHtml(s.examName || "UGEE") + '</span>' +
                '<span>' + escapeHtml(String(s.year)) + '</span>' +
                '<span><span class="meta-chip ' + (s.status === "active" ? 'is-live' : 'is-draft') + '">' + escapeHtml(s.status) + '</span></span>' +
                '<span>' + (s.isDefaultActive ? '⭐ Active Default' : '—') + '</span>' +
                '<span><div class="button-row" style="gap:6px;">' +
                (!s.isDefaultActive ? '<button class="button button-primary button-compact js-activate-season" data-id="' + escapeAttribute(s.id) + '">Activate</button>' : '') +
                '<button class="button button-secondary button-compact js-duplicate-season" data-id="' + escapeAttribute(s.id) + '">Clone Tests</button>' +
                (s.status !== "archived" ? '<button class="button button-secondary button-compact js-archive-season" data-id="' + escapeAttribute(s.id) + '">Archive</button>' : '') +
                '</div></span>' +
                '</div>';
            }).join("") +
            '</div>'
          ) : '<div class="empty-state">No seasons configured yet. Click "+ Create New Season" to set up UGEE 2026.</div>') +
          '</div>';
      } else if (activeTab === "audit") {
        var logsList = (runtime.adminAuditLogsList || []);
        activeTabContent =
          '<div class="admin-card">' +
          '<div class="button-row" style="justify-content: space-between; align-items: center; margin-bottom: 16px;">' +
          '<div>' +
          '<p class="section-label" style="margin:0;">System Audit Trail</p>' +
          '<h3 style="margin: 4px 0 0 0;">Admin Activity & Security Logs</h3>' +
          '</div>' +
          '<button class="button button-secondary button-compact" id="refresh-audit-logs">🔄 Refresh Logs</button>' +
          '</div>' +
          (logsList.length ? (
            '<div class="table-like audit-table table-scroll-card">' +
            '<div class="table-row header"><span>Action</span><span>Entity</span><span>Actor</span><span>Timestamp</span></div>' +
            logsList.map(function (l) {
              return '<div class="table-row">' +
                '<span><strong style="color:var(--gold-strong);">' + escapeHtml(l.action) + '</strong></span>' +
                '<span>' + escapeHtml(l.entityType) + ' (' + escapeHtml(String(l.entityId || "N/A")) + ')</span>' +
                '<span>' + escapeHtml(l.actorUserId ? (l.actorUserId.name || l.actorUserId.email) : "System") + '</span>' +
                '<span>' + escapeHtml(new Date(l.createdAt).toLocaleString()) + '</span>' +
                '</div>';
            }).join("") +
            '</div>'
          ) : '<div class="empty-state">No audit logs recorded yet.</div>') +
          '</div>';
      } else if (activeTab === "materials") {
        var studyData = store.getStudyMaterials ? store.getStudyMaterials() : { folders: [], files: [] };
        
        var folderListHtml = studyData.folders.length === 0 
          ? '<div class="empty-state">No folders created yet. Use the form to create one.</div>' 
          : studyData.folders.map(function(f) {
              var files = studyData.files.filter(function(file) { return file.folderId === f.id; });
              return (
                '<div class="admin-card" style="margin-bottom:16px;">' +
                  '<div class="button-row" style="justify-content:space-between; margin-bottom:12px;">' +
                    '<h4 style="color:' + escapeAttribute(f.color) + '; margin:0;"><span style="margin-right:6px;">' + escapeHtml(f.icon) + '</span>' + escapeHtml(f.name) + '</h4>' +
                    '<button class="button button-danger button-compact js-admin-delete-folder" data-id="' + escapeAttribute(f.id) + '">Delete Folder</button>' +
                  '</div>' +
                  (files.length > 0 ? (
                    '<div class="table-like">' +
                    '<div class="table-row header"><span>Filename</span><span>Size</span><span>Date</span><span>Actions</span></div>' +
                    files.map(function(file) {
                      return '<div class="table-row">' +
                        '<span>' + escapeHtml(file.name) + '</span>' +
                        '<span>' + escapeHtml(file.size) + '</span>' +
                        '<span>' + escapeHtml(formatDateOnly(file.createdAt)) + '</span>' +
                        '<span><button class="button button-danger button-compact js-admin-delete-file" data-id="' + escapeAttribute(file.id) + '">Delete</button></span>' +
                      '</div>';
                    }).join("") +
                    '</div>'
                  ) : '<div class="empty-state" style="padding:12px;">No files in this folder.</div>') +
                  '<div style="margin-top:12px;">' +
                    '<label class="button button-secondary button-compact" style="cursor:pointer;">' +
                      'Upload File' +
                      '<input type="file" class="js-admin-upload-file" data-folder="' + escapeAttribute(f.id) + '" style="display:none;" />' +
                    '</label>' +
                  '</div>' +
                '</div>'
              );
            }).join("");

        activeTabContent = 
          '<div class="admin-grid">' +
            '<div>' +
              '<h3 style="margin-bottom:16px;">Study Materials Folders</h3>' +
              folderListHtml +
            '</div>' +
            '<aside>' +
              '<div class="admin-card">' +
                '<h4 style="margin-top:0;">Create New Folder</h4>' +
                '<form id="admin-create-folder-form">' +
                  '<div class="field"><label>Folder Name</label><input name="name" required placeholder="e.g. Physics Notes" /></div>' +
                  '<div class="field"><label>Folder Icon (Emoji)</label><input name="icon" value="📁" required /></div>' +
                  '<div class="field"><label>Color</label>' +
                    '<select name="color">' +
                      '<option value="var(--brand-accent)">Brand Gold</option>' +
                      '<option value="#3b82f6">Blue</option>' +
                      '<option value="#10b981">Green</option>' +
                      '<option value="#ef4444">Red</option>' +
                      '<option value="#8b5cf6">Purple</option>' +
                    '</select>' +
                  '</div>' +
                  '<button type="submit" class="button button-primary">Create Folder</button>' +
                '</form>' +
              '</div>' +
            '</aside>' +
          '</div>';
      }

      app.innerHTML = buildShell(
        '<header class="studio-topbar-banner">' +
        '<div class="studio-topbar-inner">' +
        '<div class="studio-title-group">' +
        '<div class="brand-mark"><img src="assets/favicon-round.svg" alt="AceIIIT Logo" class="brand-logo" /> ACEIIIT STUDIO 2.0</div>' +
        '<div class="studio-save-chip is-saved">Saved ✓</div>' +
        '</div>' +
        '<div class="studio-actions-wrapper">' +
        '<div class="studio-action-group">' +
        '<button class="button button-secondary button-compact" id="open-student-preview">👁 Preview</button>' +
        '</div>' +
        '<div class="studio-action-divider"></div>' +
        '<div class="studio-action-group">' +
        '<button class="button button-secondary button-compact" id="open-analytics">Analytics</button>' +
        '<button class="button button-secondary button-compact" id="open-leaderboard">Leaderboard</button>' +
        '<button class="button button-secondary button-compact" id="open-trash">Recycle Bin</button>' +
        '</div>' +
        '<div class="studio-action-divider"></div>' +
        '<div class="studio-action-group">' +
        getThemeToggleMarkup() +
        '<button class="button button-secondary button-compact" id="back-dashboard">Dashboard ↵</button>' +
        '</div>' +
        '</div>' +
        '</div>' +
        '</header>' +

        '<section class="studio-layout-shell">' +
        '<div class="studio-stepper">' +
        '<button type="button" class="studio-step-btn js-studio-tab ' + (activeTab === "setup" ? 'is-active' : '') + '" data-tab="setup"><span class="studio-step-num">1</span> Setup & Basic Info</button>' +
        '<button type="button" class="studio-step-btn js-studio-tab ' + (activeTab === "questions" ? 'is-active' : '') + '" data-tab="questions"><span class="studio-step-num">2</span> Questions Studio (' + totalAttachedCount + '/90)</button>' +
        '<button type="button" class="studio-step-btn js-studio-tab ' + (activeTab === "bank" ? 'is-active' : '') + '" data-tab="bank"><span class="studio-step-num">3</span> Question Bank</button>' +
        '<button type="button" class="studio-step-btn js-studio-tab ' + (activeTab === "review" ? 'is-active' : '') + '" data-tab="review"><span class="studio-step-num">4</span> Review & Validate (' + validation.errors.length + ' errors)</button>' +
        '<button type="button" class="studio-step-btn js-studio-tab ' + (activeTab === "tests" ? 'is-active' : '') + '" data-tab="tests"><span class="studio-step-num">5</span> Existing Tests (' + tests.length + ')</button>' +
        '<button type="button" class="studio-step-btn js-studio-tab ' + (activeTab === "payments" ? 'is-active' : '') + '" data-tab="payments"><span class="studio-step-num">6</span> User Payments</button>' +
        '<button type="button" class="studio-step-btn js-studio-tab ' + (activeTab === "seasons" ? 'is-active' : '') + '" data-tab="seasons"><span class="studio-step-num">7</span> Seasons</button>' +
        '<button type="button" class="studio-step-btn js-studio-tab ' + (activeTab === "audit" ? 'is-active' : '') + '" data-tab="audit"><span class="studio-step-num">8</span> Audit Logs</button>' +
        '<button type="button" class="studio-step-btn js-studio-tab ' + (activeTab === "materials" ? 'is-active' : '') + '" data-tab="materials"><span class="studio-step-num">9</span> Study Materials</button>' +
        '</div>' +

        '<div class="studio-body">' +
        activeTabContent +
        '</div>' +

        questionEditorModalHtml +
        bankDrawerHtml +
        randomModalHtml +
        studentPreviewHtml +
        '</section>',
        {
          fluid: true,
          hideSupportChat: true,
          footerText: "ACEIIIT Mock Test Portal Studio 2.0",
          footerClass: "app-footer app-footer-inline"
        }
      );
      renderLatexInElement(document.body);
      // Phone: the step bar scrolls horizontally; keep the active step visible.
      var activeStep = app.querySelector(".studio-step-btn.is-active");
      var stepBar = activeStep ? activeStep.parentElement : null;
      if (stepBar && stepBar.scrollWidth > stepBar.clientWidth) {
        stepBar.scrollLeft += activeStep.getBoundingClientRect().left - stepBar.getBoundingClientRect().left - 16;
      }

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
                  '<div class="table-like table-scroll-card">' +
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
                  '<div class="table-like table-scroll-card">' +
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
                '<div class="table-like table-scroll-card">' +
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
            var qLen = Array.isArray(test.questionIds) ? test.questionIds.length : 0;
            var suprD = test.sectionDurations ? test.sectionDurations.SUPR : 60;
            var reapD = test.sectionDurations ? test.sectionDurations.REAP : 120;
            return (
              '<div class="table-row">' +
              '<span><strong>' + escapeHtml(test.title) + '</strong><br><small>' + escapeHtml(access + " • " + label) + '</small></span>' +
              '<span>' + escapeHtml(String(qLen)) + '</span>' +
              '<span>' + escapeHtml(String(suprD)) + ' / ' + escapeHtml(String(reapD)) + ' min</span>' +
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

          var modalRequest = 0;
          // Server-side search (first 100 matches); the full bank is no longer held client-side.
          async function renderList(query) {
            var needle = String(query || "").trim().toLowerCase().slice(0, 64);
            var requestId = ++modalRequest;
            var list = [];
            var failed = "";
            try {
              list = (await store.listAdminQuestions({ search: needle, limit: 100 })).questions || [];
            } catch (error) {
              failed = (error && error.message) || "Could not load the question bank.";
            }
            if (requestId !== modalRequest) return;

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
              container.innerHTML = items || ('<div class="empty-state">' + escapeHtml(failed || "No matching question.") + '</div>');
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
          var modalSearchTimer = 0;
          if (input) {
            input.addEventListener("input", function () {
              window.clearTimeout(modalSearchTimer);
              modalSearchTimer = window.setTimeout(function () { renderList(input.value); }, 300);
            });
          }
        });
      }

      testForm = document.getElementById("test-form");
      if (testForm) {
        testForm.addEventListener("submit", async function (event) {
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
              .filter(function (item) { return Number.isFinite(item); }),
            shuffleQuestions: form.get("shuffleQuestions") === "on",
            shuffleOptions: form.get("shuffleOptions") === "on",
            integrity: {
              mode: String(form.get("integrityMode") || "warn"),
              warnThreshold: 1,
              autoSubmitThreshold: Math.max(1, Math.min(100, Number(form.get("integrityAutoSubmitThreshold") || 5))),
            }
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
      }

      var cancelTestEdit = document.getElementById("cancel-test-edit");
      if (cancelTestEdit) {
        cancelTestEdit.addEventListener("click", function () {
          runtime.adminEditingTestId = null;
          clearLocalDraft(ADMIN_TEST_DRAFT_KEY);
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      }

      if (questionForm) {
        var previewInline = questionForm.querySelector("#latex-preview-inline") || document.getElementById("latex-preview-inline");
        var previewToggle = questionForm.querySelector("#latex-preview-toggle") || document.getElementById("latex-preview-toggle");
        var previewFull = questionForm.querySelector("#latex-preview-full") || document.getElementById("latex-preview-full");
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
        var uploadQuestionImagesButton = questionForm.querySelector("#upload-question-images") || document.getElementById("upload-question-images");
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
              showOverlayLoader("Uploading image to Cloudinary.", { delayMs: 320 });
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

        async function handleSaveQuestion(isSaveAndAddNext) {
          if (!questionForm) return;
          if (!questionForm.checkValidity()) {
            questionForm.reportValidity();
            return;
          }
          var saveBtn = questionForm.querySelector("#question-save-btn");
          var saveNextBtn = questionForm.querySelector("#question-save-next");
          var originalSaveText = saveBtn ? saveBtn.textContent : "";
          var originalNextText = saveNextBtn ? saveNextBtn.textContent : "";

          if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving..."; }
          if (saveNextBtn) { saveNextBtn.disabled = true; saveNextBtn.textContent = "Saving..."; }

          try {
            var form = new FormData(questionForm);
            var activeTestId = String(form.get("testId") || "");
            var fileInputEl = questionForm.querySelector("#question-files");
            var rawSelectedFiles = runtime.pendingQuestionFiles.length
              ? runtime.pendingQuestionFiles
              : Array.prototype.slice.call((fileInputEl && fileInputEl.files) || []);
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

            showOverlayLoader(runtime.adminEditingQuestionId ? "Updating question..." : "Creating question...", { delayMs: 250 });
            var savedQuestion = runtime.adminEditingQuestionId
              ? await store.updateQuestion(runtime.adminEditingQuestionId, payload, selectedFiles)
              : await store.createQuestion(payload, selectedFiles);

            runtime.adminEditingQuestionId = null;
            resetPendingQuestionUploads();
            clearLocalDraft(ADMIN_QUESTION_DRAFT_KEY);
            hideOverlayLoader();

            var wasModalOpen = !!runtime.adminQuestionEditorOpen;
            if (isSaveAndAddNext) {
              runtime.adminQuestionEditorOpen = wasModalOpen;
              rerenderAdminPreserveScroll(user, activeTestId);
              setTimeout(function () {
                var promptEl = document.querySelector("#question-prompt");
                if (promptEl) {
                  promptEl.focus();
                  promptEl.scrollIntoView({ behavior: "smooth", block: "center" });
                }
              }, 120);
            } else {
              runtime.adminQuestionEditorOpen = false;
              rerenderAdminPreserveScroll(user, activeTestId);
            }
          } catch (error) {
            hideOverlayLoader();
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
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = originalSaveText || "Save Question"; }
            if (saveNextBtn) { saveNextBtn.disabled = false; saveNextBtn.textContent = originalNextText || "⚡ Save & Add Next (Ctrl+Enter)"; }
            hideOverlayLoader();
          }
        }

        questionForm.addEventListener("submit", function (event) {
          event.preventDefault();
          handleSaveQuestion(false);
        });

        var saveNextBtn = questionForm.querySelector("#question-save-next") || document.getElementById("question-save-next");
        if (saveNextBtn) {
          saveNextBtn.addEventListener("click", function (event) {
            event.preventDefault();
            handleSaveQuestion(true);
          });
        }

        questionForm.addEventListener("keydown", function (event) {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            handleSaveQuestion(true);
          }
        });
      }

      var cancelQuestionEdit = document.querySelectorAll("#cancel-question-edit");
      cancelQuestionEdit.forEach(function (btn) {
        btn.addEventListener("click", function () {
          runtime.adminEditingQuestionId = null;
          runtime.adminQuestionEditorOpen = false;
          resetPendingQuestionUploads();
          clearLocalDraft(ADMIN_QUESTION_DRAFT_KEY);
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      });


      var openQuestionEditor = document.getElementById("open-question-editor");
      if (openQuestionEditor) {
        openQuestionEditor.addEventListener("click", function () {
          runtime.adminQuestionEditorOpen = true;
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      }

      var questionEditorClose = document.getElementById("question-editor-close");
      if (questionEditorClose) {
        questionEditorClose.addEventListener("click", function () {
          runtime.adminQuestionEditorOpen = false;
          runtime.adminEditingQuestionId = null;
          resetPendingQuestionUploads();
          clearLocalDraft(ADMIN_QUESTION_DRAFT_KEY);
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      }

      var questionEditorOverlay = document.getElementById("question-editor-overlay");
      if (questionEditorOverlay) {
        questionEditorOverlay.addEventListener("click", function (event) {
          if (event.target === questionEditorOverlay) {
            runtime.adminQuestionEditorOpen = false;
            runtime.adminEditingQuestionId = null;
            resetPendingQuestionUploads();
            clearLocalDraft(ADMIN_QUESTION_DRAFT_KEY);
            rerenderAdminPreserveScroll(user, selectedTestId);
          }
        });
      }

      var downloadDataBtn = document.getElementById("download-data");
      if (downloadDataBtn) {
        downloadDataBtn.addEventListener("click", async function () {
          showOverlayLoader("Preparing backup.", { delayMs: 200 });
          try {
            var blob = new Blob([await store.exportData()], { type: "application/json" });
            var url = URL.createObjectURL(blob);
            var link = document.createElement("a");
            link.href = url;
            link.download = "aceiiit-portal-backup.json";
            link.click();
            window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
          } catch (error) {
            window.alert(error && error.message ? error.message : "Could not prepare the backup.");
          } finally {
            hideOverlayLoader();
          }
        });
      }

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

        showOverlayLoader("Updating dashboard order.", { delayMs: 320 });
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

      app.querySelectorAll("#publish-test-btn").forEach(function (button) {
        button.addEventListener("click", async function () {
          if (!selectedTestId) return;
          var valRes = validateTestForPublish(selectedTest, questions);
          if (valRes.errors.length) {
            window.alert("Cannot publish: Please fix all blocking errors first in Step 4 Review & Validate.");
            runtime.adminStudioTab = "review";
            rerenderAdminPreserveScroll(user, selectedTestId);
            return;
          }
          showOverlayLoader("Publishing test...", { delayMs: 200 });
          try {
            await store.updateTest(selectedTestId, { status: "live" });
            window.alert("🎉 Test '" + selectedTest.title + "' is now LIVE!");
            rerenderAdminPreserveScroll(user, selectedTestId);
          } catch (error) {
            window.alert(error && error.message ? error.message : "Failed to publish test.");
          } finally {
            hideOverlayLoader();
          }
        });
      });

      app.querySelectorAll(".js-toggle-live").forEach(function (button) {
        button.addEventListener("click", async function () {
          var test = store.getTestById(button.dataset.id);
          showOverlayLoader("Updating test.", { delayMs: 320 });
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
          showOverlayLoader("Deleting test.", { delayMs: 320 });
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
          runtime.adminQuestionEditorOpen = true;
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      });

      app.querySelectorAll(".js-edit-question-inline").forEach(function (button) {
        button.addEventListener("click", function () {
          runtime.adminEditingQuestionId = button.dataset.id;
          runtime.adminQuestionEditorOpen = false;
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      });

      app.querySelectorAll(".js-delete-question").forEach(function (button) {
        button.addEventListener("click", async function () {
          showOverlayLoader("Deleting question.", { delayMs: 420 });
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
          showOverlayLoader("Attaching question.", { delayMs: 420 });
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
          showOverlayLoader("Removing question.", { delayMs: 420 });
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

      // Bank filters query the server, so typing is debounced; any filter change resets to page 1.
      ["bank-search", "bank-drawer-search"].forEach(function (inputId) {
        var input = document.getElementById(inputId);
        if (!input) return;
        input.addEventListener("input", function () {
          window.clearTimeout(runtime.adminBankSearchTimer);
          runtime.adminBankSearchTimer = window.setTimeout(function () {
            runtime.adminBankQuery = input.value;
            runtime.adminBankPage = 1;
            rerenderAdminPreserveScroll(user, selectedTestId);
          }, 300);
        });
      });

      ["bank-filter", "bank-drawer-section"].forEach(function (selectId) {
        var select = document.getElementById(selectId);
        if (!select) return;
        select.addEventListener("change", function () {
          runtime.adminBankSectionFilter = select.value;
          runtime.adminBankPage = 1;
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      });

      app.querySelectorAll(".js-bank-page").forEach(function (button) {
        button.addEventListener("click", function () {
          var target = parseInt(button.dataset.page, 10);
          if (!target || target < 1) return;
          runtime.adminBankPage = target;
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
          // Same rich-text rendering as the exam (escaped text + KaTeX), then print.
          exportWindow.document.write(
            '<html><head><title>' + escapeHtml(exportTest.title) + '</title>' +
            '<link rel="stylesheet" href="/vendor/katex/katex.min.css">' +
            '<style>body{font-family:Arial,sans-serif;padding:32px;} .rich-text{white-space:pre-wrap;} .katex-display{overflow-x:auto;}</style>' +
            '</head><body>' +
            '<h1>' + escapeHtml(exportTest.title) + '</h1>' +
            exportQuestions.map(function (question, index) {
              return '<div style="margin-bottom: 28px;"><h3 class="rich-text">Q' + (index + 1) + '. ' + formatRichText(question.prompt) + '</h3>' +
                (question.passage ? '<p class="rich-text">' + formatRichText(question.passage) + '</p>' : '') +
                getQuestionImageUrls(question).map(function (image, imageIndex) {
                  return '<img src="' + safeImageUrl(image) + '" alt="Figure ' + (imageIndex + 1) + '" style="max-width: 480px; display:block; margin: 10px 0;">';
                }).join('') +
                '<ol type="A">' + question.options.map(function (option) { return '<li class="rich-text">' + formatRichText(option) + '</li>'; }).join('') + '</ol>' +
                '<p><strong>Answer:</strong> <span class="rich-text">' + formatRichText(question.options[question.correctOption]) + '</span></p>' +
                '<p><strong>Solution:</strong> <span class="rich-text">' + formatRichText(question.explanation) + '</span></p></div>';
            }).join("") +
            '<script src="/vendor/katex/katex.min.js"></scr' + 'ipt>' +
            '<script src="/vendor/katex/contrib/auto-render.min.js"></scr' + 'ipt>' +
            '<script>window.addEventListener("load",function(){try{renderMathInElement(document.body,{delimiters:[{left:"$$",right:"$$",display:true},{left:"\\\\[",right:"\\\\]",display:true},{left:"\\\\(",right:"\\\\)",display:false},{left:"$",right:"$",display:false}],throwOnError:false});}catch(e){}setTimeout(function(){window.focus();window.print();},300);});</scr' + 'ipt>' +
            '</body></html>'
          );
          exportWindow.document.close();
        });
      });

      // ===================================================
      // ADMIN STUDIO 2.0 EVENT HANDLERS
      // ===================================================

      // 1. Stepper Tabs Switching
      app.querySelectorAll(".js-studio-tab").forEach(function (button) {
        button.addEventListener("click", function () {
          var targetTab = button.getAttribute("data-tab");
          if (targetTab) {
            runtime.adminStudioTab = targetTab;
            rerenderAdminPreserveScroll(user, selectedTestId);
          }
        });
      });

      // 2. Test Duplication
      app.querySelectorAll(".js-duplicate-test").forEach(function (button) {
        button.addEventListener("click", async function () {
          var testId = button.getAttribute("data-id");
          if (!testId) return;
          showOverlayLoader("Duplicating test...", { delayMs: 200 });
          try {
            var newTest = await store.duplicateTest(testId);
            runtime.adminSelectedTestId = newTest.id;
            runtime.adminStudioTab = "questions";
            rerenderAdminPreserveScroll(user, newTest.id);
          } catch (error) {
            window.alert(error && error.message ? error.message : "Failed to duplicate test.");
          } finally {
            hideOverlayLoader();
          }
        });
      });

      // 3. Modals Controls
      var openStudentPreviewBtn = document.getElementById("open-student-preview");
      if (openStudentPreviewBtn) {
        openStudentPreviewBtn.addEventListener("click", function () {
          runtime.adminStudentPreviewOpen = true;
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      }
      var closeStudentPreviewBtn = document.getElementById("close-student-preview");
      if (closeStudentPreviewBtn) {
        closeStudentPreviewBtn.addEventListener("click", function () {
          runtime.adminStudentPreviewOpen = false;
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      }
      var openBankDrawerBtn = document.getElementById("open-bank-drawer");
      if (openBankDrawerBtn) {
        openBankDrawerBtn.addEventListener("click", function () {
          runtime.adminBankModalOpen = true;
          runtime.adminBankPage = 1;
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      }
      var closeBankDrawerBtn = document.getElementById("close-bank-drawer");
      if (closeBankDrawerBtn) {
        closeBankDrawerBtn.addEventListener("click", function () {
          runtime.adminBankModalOpen = false;
          runtime.adminBankPage = 1;
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      }
      var openRandomModalBtn = document.getElementById("open-random-modal");
      if (openRandomModalBtn) {
        openRandomModalBtn.addEventListener("click", function () {
          runtime.adminRandomModalOpen = true;
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      }
      var closeRandomModalBtn = document.getElementById("close-random-modal");
      if (closeRandomModalBtn) {
        closeRandomModalBtn.addEventListener("click", function () {
          runtime.adminRandomModalOpen = false;
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      }

      // 4. Random Question Generator Execution & Undo Handler
      var confirmRandomGenBtn = document.getElementById("confirm-random-generate");
      if (confirmRandomGenBtn) {
        confirmRandomGenBtn.addEventListener("click", async function () {
          if (!selectedTestId) {
            window.alert("Please select or create a test first.");
            return;
          }
          var suprCount = parseInt(document.getElementById("random-supr-count").value, 10) || 0;
          var reapCount = parseInt(document.getElementById("random-reap-count").value, 10) || 0;
          showOverlayLoader("Generating & attaching random questions...", { delayMs: 200 });
          try {
            var genRes = await store.attachRandomQuestionsToTest(selectedTestId, { SUPR: suprCount, REAP: reapCount });
            if (genRes && genRes.ok) {
              runtime.lastRandomBatch = {
                testId: selectedTestId,
                attachedCount: genRes.attachedCount,
                attachedIds: genRes.attachedIds,
                previousQuestionIds: genRes.previousQuestionIds,
                timestamp: Date.now()
              };
              try {
                localStorage.setItem("aceiiit_last_random_batch", JSON.stringify(runtime.lastRandomBatch));
              } catch (e) { }
            }
            runtime.adminRandomModalOpen = false;
            rerenderAdminPreserveScroll(user, selectedTestId);
            showSaveChip("Attached " + (genRes ? genRes.attachedCount : 0) + " questions randomly ✓", "saved");
          } catch (error) {
            window.alert(error && error.message ? error.message : "Failed to generate random questions.");
          } finally {
            hideOverlayLoader();
          }
        });
      }

      app.querySelectorAll(".js-undo-random-batch").forEach(function (undoBtn) {
        undoBtn.addEventListener("click", async function () {
          if (!runtime.lastRandomBatch || !selectedTestId) return;
          if (!window.confirm("Are you sure you want to undo the last random question generation? This will restore your test to its exact state before the generation.")) {
            return;
          }
          showOverlayLoader("Undoing random question generation...", { delayMs: 200 });
          try {
            await store.undoRandomQuestionsAttachment(selectedTestId, runtime.lastRandomBatch.previousQuestionIds);
            runtime.lastRandomBatch = null;
            try {
              localStorage.removeItem("aceiiit_last_random_batch");
            } catch (e) { }
            runtime.adminRandomModalOpen = false;
            rerenderAdminPreserveScroll(user, selectedTestId);
            showSaveChip("Undid random generation ✓", "saved");
          } catch (err) {
            window.alert(err && err.message ? err.message : "Failed to undo random generation.");
          } finally {
            hideOverlayLoader();
          }
        });
      });

      // 5. Bulk Question Selection & Operations
      app.querySelectorAll(".js-bank-multi-checkbox").forEach(function (checkbox) {
        checkbox.addEventListener("change", function () {
          var id = checkbox.getAttribute("data-id");
          if (checkbox.checked) {
            if (runtime.adminCheckedBankQuestionIds.indexOf(id) === -1) runtime.adminCheckedBankQuestionIds.push(id);
          } else {
            runtime.adminCheckedBankQuestionIds = runtime.adminCheckedBankQuestionIds.filter(function (qId) { return qId !== id; });
          }
          var attachBtn = document.getElementById("attach-bank-selected-bulk");
          if (attachBtn) {
            attachBtn.disabled = !runtime.adminCheckedBankQuestionIds.length;
            attachBtn.textContent = "Add " + runtime.adminCheckedBankQuestionIds.length + " Questions to Test";
          }
        });
      });

      var attachBankSelectedBulkBtn = document.getElementById("attach-bank-selected-bulk");
      if (attachBankSelectedBulkBtn) {
        attachBankSelectedBulkBtn.addEventListener("click", async function () {
          if (!selectedTestId || !runtime.adminCheckedBankQuestionIds.length) return;
          showOverlayLoader("Attaching selected questions...", { delayMs: 200 });
          try {
            if (typeof store.attachQuestionsBulk === "function") {
              await store.attachQuestionsBulk(selectedTestId, runtime.adminCheckedBankQuestionIds);
            } else {
              for (var bIdx = 0; bIdx < runtime.adminCheckedBankQuestionIds.length; bIdx++) {
                await store.attachQuestionToTest(selectedTestId, runtime.adminCheckedBankQuestionIds[bIdx]);
              }
            }
            runtime.adminCheckedBankQuestionIds = [];
            runtime.adminBankModalOpen = false;
            rerenderAdminPreserveScroll(user, selectedTestId);
          } catch (error) {
            window.alert(error && error.message ? error.message : "Failed to bulk attach questions.");
          } finally {
            hideOverlayLoader();
          }
        });
      }

      app.querySelectorAll(".js-test-q-checkbox").forEach(function (checkbox) {
        checkbox.addEventListener("change", function () {
          var id = checkbox.getAttribute("data-id");
          if (checkbox.checked) {
            if (runtime.adminCheckedTestQuestionIds.indexOf(id) === -1) runtime.adminCheckedTestQuestionIds.push(id);
          } else {
            runtime.adminCheckedTestQuestionIds = runtime.adminCheckedTestQuestionIds.filter(function (qId) { return qId !== id; });
          }
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      });

      // Right-Click & Drag-Selection on Question Navigator Tiles
      var navGrid = app.querySelector(".studio-nav-grid");
      if (navGrid) {
        var isNavDragging = false;

        navGrid.addEventListener("contextmenu", function (e) {
          if (e.target.closest(".studio-q-box")) {
            e.preventDefault(); // Prevent native right-click menu over navigator tiles
          }
        });

        navGrid.addEventListener("mousedown", function (e) {
          var tile = e.target.closest(".studio-q-box");
          if (tile && tile.dataset.id) {
            if (e.button === 2) { // Right click drag/toggle
              e.preventDefault();
              isNavDragging = true;
              var qId = tile.dataset.id;
              if (runtime.adminCheckedTestQuestionIds.indexOf(qId) === -1) {
                runtime.adminCheckedTestQuestionIds.push(qId);
              } else {
                runtime.adminCheckedTestQuestionIds = runtime.adminCheckedTestQuestionIds.filter(function (id) { return id !== qId; });
              }
              rerenderAdminPreserveScroll(user, selectedTestId);
            }
          }
        });

        navGrid.addEventListener("mouseover", function (e) {
          if (isNavDragging) {
            var tile = e.target.closest(".studio-q-box");
            if (tile && tile.dataset.id) {
              var qId = tile.dataset.id;
              if (runtime.adminCheckedTestQuestionIds.indexOf(qId) === -1) {
                runtime.adminCheckedTestQuestionIds.push(qId);
                tile.classList.add("is-selected");
              }
            }
          }
        });

        window.addEventListener("mouseup", function () {
          if (isNavDragging) {
            isNavDragging = false;
            rerenderAdminPreserveScroll(user, selectedTestId);
          }
        });
      }

      var clearSelectedBulkBtn = document.getElementById("clear-selected-bulk");
      if (clearSelectedBulkBtn) {
        clearSelectedBulkBtn.addEventListener("click", function () {
          runtime.adminCheckedTestQuestionIds = [];
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      }

      var detachSelectedBulkBtn = document.getElementById("detach-selected-bulk");
      if (detachSelectedBulkBtn) {
        detachSelectedBulkBtn.addEventListener("click", async function () {
          if (!selectedTestId || !runtime.adminCheckedTestQuestionIds.length) return;
          if (!window.confirm("Remove " + runtime.adminCheckedTestQuestionIds.length + " questions from this test?")) return;
          showOverlayLoader("Removing selected questions...", { delayMs: 200 });
          try {
            if (typeof store.detachQuestionsBulk === "function") {
              await store.detachQuestionsBulk(selectedTestId, runtime.adminCheckedTestQuestionIds);
            } else {
              for (var i = 0; i < runtime.adminCheckedTestQuestionIds.length; i++) {
                await store.detachQuestionFromTest(selectedTestId, runtime.adminCheckedTestQuestionIds[i]);
              }
            }
            runtime.adminCheckedTestQuestionIds = [];
            rerenderAdminPreserveScroll(user, selectedTestId);
          } catch (error) {
            window.alert(error && error.message ? error.message : "Failed to bulk remove questions.");
          } finally {
            hideOverlayLoader();
          }
        });
      }

      // 6. Save & Add Next Handler (Button & Ctrl+Enter Keyboard Shortcut)
      var saveAndNextBtn = document.getElementById("question-save-next");
      if (saveAndNextBtn && questionForm) {
        saveAndNextBtn.addEventListener("click", function () {
          questionForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
        });
      }

      // Keyboard Shortcut: Ctrl + Enter / Cmd + Enter in Question Form triggers submit
      // 7. Preset Templates Handler
      app.querySelectorAll(".js-apply-template").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var preset = btn.getAttribute("data-preset");
          var titleEl = document.getElementById("test-title");
          var subtitleEl = document.getElementById("test-subtitle");
          var suprEl = document.getElementById("supr-duration");
          var reapEl = document.getElementById("reap-duration");
          var benchEl = document.getElementById("test-benchmark");
          if (!titleEl) return;
          if (preset === "ugee-full") {
            titleEl.value = "UGEE 2026 Full Mock Test";
            if (subtitleEl) subtitleEl.value = "Complete 40 SUPR + 50 REAP Mock Examination";
            if (suprEl) suprEl.value = "60";
            if (reapEl) reapEl.value = "120";
            if (benchEl) benchEl.value = "18,22,26,31";
          } else if (preset === "supr-only") {
            titleEl.value = "SUPR Sectional Mock";
            if (subtitleEl) subtitleEl.value = "40 SUPR Section Questions (60 Mins)";
            if (suprEl) suprEl.value = "60";
            if (reapEl) reapEl.value = "0";
            if (benchEl) benchEl.value = "15,20,25";
          } else if (preset === "reap-only") {
            titleEl.value = "REAP Sectional Mock";
            if (subtitleEl) subtitleEl.value = "50 REAP Section Questions (120 Mins)";
            if (suprEl) suprEl.value = "0";
            if (reapEl) reapEl.value = "120";
            if (benchEl) benchEl.value = "20,25,30";
          }
        });
      });

      // 8. Payment Management Event Listeners
      app.querySelectorAll(".js-admin-user-filter").forEach(function (btn) {
        btn.addEventListener("click", function () {
          runtime.adminUserFilterTab = btn.dataset.filter || "paid";
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      });

      var addPaymentForm = document.getElementById("admin-add-payment-form");
      if (addPaymentForm) {
        addPaymentForm.addEventListener("submit", async function (event) {
          event.preventDefault();
          var form = new FormData(addPaymentForm);
          showOverlayLoader("Recording payment...", { delayMs: 200 });
          try {
            var created = await store.createPayment({
              email: String(form.get("email") || "").trim(),
              name: String(form.get("name") || "").trim() || undefined,
              note: String(form.get("note") || "").trim() || undefined,
            });
            if (form.get("verifyNow") === "on" && created && created.payment) {
              await store.verifyPaymentNew(created.payment.id, true);
              window.alert("Payment recorded and verified. Access is granted.");
            } else {
              window.alert("Payment recorded as pending. Verify it from the payments list to grant access.");
            }
            await store.refreshFromRemote();
            rerenderAdminPreserveScroll(user, selectedTestId);
          } catch (err) {
            window.alert(err && err.message ? err.message : "Could not record the payment.");
          } finally {
            hideOverlayLoader();
          }
        });
      }

      app.querySelectorAll(".js-view-user-details").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var uId = btn.dataset.id;
          showOverlayLoader("Fetching user profile...", { delayMs: 200 });
          try {
            var details = await store.getUserDetailsExtended(uId);
            runtime.adminSelectedUser = details.user;
            runtime.adminUserDetailsOpen = true;
            rerenderAdminPreserveScroll(user, selectedTestId);
          } catch (err) {
            window.alert("Failed to load user details: " + (err.message || String(err)));
          } finally {
            hideOverlayLoader();
          }
        });
      });

      app.querySelectorAll(".js-verify-user-payment").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var userId = btn.dataset.id;
          var email = btn.dataset.email;
          if (!window.confirm("Verify payment and activate Paid Access for " + email + "?\nA confirmation email will be sent automatically.")) return;
          showOverlayLoader("Verifying payment...", { delayMs: 200 });
          try {
            await store.verifyUserPayment(userId);
            window.alert("Payment verified! Paid Access activated and confirmation email dispatched to " + email);
            rerenderAdminPreserveScroll(user, selectedTestId);
          } catch (err) {
            window.alert("Failed to verify user payment: " + (err.message || String(err)));
          } finally {
            hideOverlayLoader();
          }
        });
      });

      app.querySelectorAll(".js-revoke-user-payment").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var userId = btn.dataset.id;
          if (!window.confirm("Revoke Paid Access for this user? They will revert to Free tier.")) return;
          showOverlayLoader("Revoking access...", { delayMs: 200 });
          try {
            await store.revokeUserPayment(userId);
            rerenderAdminPreserveScroll(user, selectedTestId);
          } catch (err) {
            window.alert("Failed to revoke access: " + (err.message || String(err)));
          } finally {
            hideOverlayLoader();
          }
        });
      });

      var publishTestBtn = document.getElementById("publish-test-btn");
      if (publishTestBtn && selectedTestId) {
        publishTestBtn.addEventListener("click", async function () {
          if (!window.confirm("Publish test now? It will become visible and live to students.")) return;
          showOverlayLoader("Publishing test...", { delayMs: 200 });
          try {
            if (typeof store.publishTest === "function") {
              await store.publishTest(selectedTestId);
            } else {
              await store.updateTest(selectedTestId, { status: "live" });
            }
            window.alert("Test published successfully!");
            rerenderAdminPreserveScroll(user, selectedTestId);
          } catch (err) {
            window.alert("Publish failed: " + (err.message || String(err)));
          } finally {
            hideOverlayLoader();
          }
        });
      }

      app.querySelectorAll(".js-activate-season").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var sId = btn.dataset.id;
          if (!window.confirm("Activate this season as default?")) return;
          showOverlayLoader("Activating season...", { delayMs: 200 });
          try {
            await store.activateSeason(sId);
            var sRes = await store.listSeasons();
            runtime.adminSeasonsList = sRes.seasons || [];
            rerenderAdminPreserveScroll(user, selectedTestId);
          } catch (err) {
            window.alert("Failed to activate season: " + (err.message || String(err)));
          } finally {
            hideOverlayLoader();
          }
        });
      });

      app.querySelectorAll(".js-archive-season").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var sId = btn.dataset.id;
          if (!window.confirm("Archive this season?")) return;
          showOverlayLoader("Archiving season...", { delayMs: 200 });
          try {
            await store.archiveSeason(sId);
            var sRes = await store.listSeasons();
            runtime.adminSeasonsList = sRes.seasons || [];
            rerenderAdminPreserveScroll(user, selectedTestId);
          } catch (err) {
            window.alert("Failed to archive season: " + (err.message || String(err)));
          } finally {
            hideOverlayLoader();
          }
        });
      });

      app.querySelectorAll(".js-duplicate-season").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var sId = btn.dataset.id;
          var newName = window.prompt("Enter name for duplicated season:", "UGEE 2027");
          if (!newName) return;
          showOverlayLoader("Duplicating season & tests...", { delayMs: 200 });
          try {
            await store.duplicateSeason(sId, { name: newName, year: new Date().getFullYear() + 1 });
            var sRes = await store.listSeasons();
            runtime.adminSeasonsList = sRes.seasons || [];
            rerenderAdminPreserveScroll(user, selectedTestId);
          } catch (err) {
            window.alert("Failed to duplicate season: " + (err.message || String(err)));
          } finally {
            hideOverlayLoader();
          }
        });
      });

      var createSeasonBtn = document.getElementById("create-season-btn");
      if (createSeasonBtn) {
        createSeasonBtn.addEventListener("click", async function () {
          var name = window.prompt("Enter Season Name (e.g. UGEE 2026 Phase 2):");
          if (!name) return;
          var yearStr = window.prompt("Enter Year:", String(new Date().getFullYear()));
          if (!yearStr) return;
          showOverlayLoader("Creating season...", { delayMs: 200 });
          try {
            await store.createSeason({ name: name, year: Number(yearStr), examName: "UGEE" });
            var sRes = await store.listSeasons();
            runtime.adminSeasonsList = sRes.seasons || [];
            rerenderAdminPreserveScroll(user, selectedTestId);
          } catch (err) {
            window.alert("Failed to create season: " + (err.message || String(err)));
          } finally {
            hideOverlayLoader();
          }
        });
      }

      var refreshAuditBtn = document.getElementById("refresh-audit-logs");
      if (refreshAuditBtn) {
        refreshAuditBtn.addEventListener("click", async function () {
          showOverlayLoader("Loading audit logs...", { delayMs: 200 });
          try {
            var aRes = await store.getAuditLogs();
            runtime.adminAuditLogsList = aRes.logs || [];
            rerenderAdminPreserveScroll(user, selectedTestId);
          } catch (err) {
            window.alert("Failed to load audit logs: " + (err.message || String(err)));
          } finally {
            hideOverlayLoader();
          }
        });
      }

      var createFolderForm = document.getElementById("admin-create-folder-form");
      if (createFolderForm) {
        createFolderForm.addEventListener("submit", function (e) {
          e.preventDefault();
          var fd = new FormData(createFolderForm);
          if (store.createFolder) {
            store.createFolder(fd.get("name"), fd.get("color"), fd.get("icon"));
            rerenderAdminPreserveScroll(user, selectedTestId);
          }
        });
      }

      app.querySelectorAll(".js-admin-delete-folder").forEach(function (btn) {
        btn.addEventListener("click", function () {
          if (!window.confirm("Delete this folder and ALL files inside it?")) return;
          if (store.deleteFolder) {
            store.deleteFolder(btn.dataset.id);
            rerenderAdminPreserveScroll(user, selectedTestId);
          }
        });
      });

      app.querySelectorAll(".js-admin-delete-file").forEach(function (btn) {
        btn.addEventListener("click", function () {
          if (!window.confirm("Delete this file?")) return;
          if (store.deleteMaterial) {
            store.deleteMaterial(btn.dataset.id);
            rerenderAdminPreserveScroll(user, selectedTestId);
          }
        });
      });

      app.querySelectorAll(".js-admin-upload-file").forEach(function (input) {
        input.addEventListener("change", function () {
          var file = input.files[0];
          if (!file) return;
          var folderId = input.dataset.folder;
          showOverlayLoader("Uploading file...", { delayMs: 200 });
          var reader = new FileReader();
          reader.onload = function(e) {
            var dataUrl = e.target.result;
            var sizeKb = Math.round(file.size / 1024);
            var sizeStr = sizeKb > 1024 ? (sizeKb / 1024).toFixed(1) + " MB" : sizeKb + " KB";
            if (store.uploadMaterial) {
              store.uploadMaterial(folderId, {
                name: file.name,
                size: sizeStr,
                url: dataUrl
              });
              hideOverlayLoader();
              rerenderAdminPreserveScroll(user, selectedTestId);
            }
          };
          reader.readAsDataURL(file);
        });
      });

      var userSearchInput = document.getElementById("admin-user-search");
      if (userSearchInput) {
        userSearchInput.addEventListener("input", function () {
          runtime.adminUserSearchQuery = userSearchInput.value;
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      }

      setTimeout(function () {
        if (window.renderMathInElement) {
          try {
            window.renderMathInElement(document.body, {
              delimiters: [
                { left: "$$", right: "$$", display: true },
                { left: "$", right: "$", display: false },
                { left: "\\(", right: "\\)", display: false },
                { left: "\\[", right: "\\]", display: true }
              ],
              throwOnError: false
            });
          } catch (_kErr) { }
        }
      }, 50);

      // 9. Global Studio Keyboard Shortcuts (Ctrl+S, Esc, /)
      var handleStudioKeydown = function (e) {
        if (!document.querySelector(".studio-shell")) return;

        // Esc: close any open modal overlays
        if (e.key === "Escape") {
          if (runtime.adminStudentPreviewOpen || runtime.adminBankModalOpen || runtime.adminRandomModalOpen || runtime.adminQuestionEditorOpen) {
            runtime.adminStudentPreviewOpen = false;
            runtime.adminBankModalOpen = false;
            runtime.adminRandomModalOpen = false;
            runtime.adminQuestionEditorOpen = false;
            rerenderAdminPreserveScroll(user, selectedTestId);
            return;
          }
        }

        // Ctrl+S / Cmd+S: Trigger test form submit or autosave
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
          e.preventDefault();
          var tForm = document.getElementById("test-form");
          if (tForm) {
            tForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
          }
          return;
        }

        // /: Focus search input in bank / questions studio if not already typing in an input/textarea
        if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) {
          var searchInput = document.getElementById("bank-search") || document.getElementById("bank-drawer-search");
          if (searchInput) {
            e.preventDefault();
            searchInput.focus();
          }
        }
      };

      document.removeEventListener("keydown", runtime._studioKeydownHandler);
      runtime._studioKeydownHandler = handleStudioKeydown;
      document.addEventListener("keydown", handleStudioKeydown);
    } catch (adminErr) {
      console.error("ADMIN RENDER ERROR:", adminErr);
      app.innerHTML = '<div style="padding:40px; color:#900; background:#fff; margin:40px; border-radius:12px; font-family:monospace; border:2px solid red;"><h2>Admin Studio Render Exception</h2><pre style="white-space:pre-wrap; word-break:break-all;">' + escapeHtml(adminErr.stack || adminErr.message || String(adminErr)) + '</pre></div>';
    }
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
      '<div class="brand-mark"><img src="assets/favicon-round.svg" alt="AceIIIT Logo" class="brand-logo" /> AceIIIT</div>' +
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
      '<div id="results-table" class="table-like table-scroll-card" style="margin-top: 14px;"><div class="empty-state">Loading…</div></div>' +
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
      '<div id="leaderboard-table" class="table-like table-scroll-card" style="margin-top: 14px;"><div class="empty-state">Loading…</div></div>' +
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
      , { fluid: true, hideSupportChat: true });
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
          '<span><small>' + escapeHtml(formatDateTime(item.submittedAt)) + '</small>' + integrityBadge(item) + '</span>' +
          '</div>'
        );
      }).join("");
      var container = document.getElementById("results-table");
      if (container) {
        container.innerHTML =
          '<div class="table-row header"><span>Test / Student</span><span>Score</span><span>Percentile</span><span>Submitted / Integrity</span></div>' +
          (rows || '<div class="empty-state">No submissions yet.</div>');
        container.querySelectorAll(".js-review-integrity").forEach(function (button) {
          button.addEventListener("click", function () {
            reviewAttemptIntegrity(button.dataset.attempt);
          });
        });
      }
    }

    function integrityBadge(item) {
      var integrity = item.integrity || {};
      var violations = Number(integrity.violations || 0);
      var parts = [];
      if (item.invalidated) parts.push('<span class="meta-chip integrity-chip is-invalid">Invalidated</span>');
      if (item.submittedReason === "integrity_threshold") parts.push('<span class="meta-chip integrity-chip is-flagged">Auto-submitted (integrity)</span>');
      if (violations > 0) parts.push('<span class="meta-chip integrity-chip is-flagged">' + violations + ' integrity event' + (violations === 1 ? '' : 's') + '</span>');
      if (Number(integrity.takeovers || 0) > 0) parts.push('<span class="meta-chip integrity-chip">' + Number(integrity.takeovers) + ' device switch' + (Number(integrity.takeovers) === 1 ? '' : 'es') + '</span>');
      return '<br>' + parts.join(" ") + ' <button type="button" class="button button-ghost button-compact js-review-integrity" data-attempt="' + escapeAttribute(item.id) + '">Review</button>';
    }

    // Integrity evidence is reviewed by a person; invalidation is an explicit, audited action.
    async function reviewAttemptIntegrity(attemptId) {
      if (!attemptId || !store.getAttemptIntegrity) return;
      try {
        var data = await store.getAttemptIntegrity(attemptId);
        var info = data.attempt || {};
        var lines = (data.events || []).map(function (event) {
          return "• " + formatDateTime(event.receivedAt) + "  " + event.type + (event.counted ? " (counted)" : "") + (event.durationMs ? " · " + Math.round(event.durationMs / 1000) + "s" : "") + (event.detail ? " · " + event.detail : "");
        });
        var summary = ((info.user && info.user.email) || "Student") + "\n" +
          "Recorded events: " + Number((info.integrity && info.integrity.violations) || 0) +
          " · Submitted: " + (info.submittedReason || "submitted") +
          (info.invalidated ? "\nINVALIDATED: " + (info.invalidatedReason || "") : "") + "\n\n" +
          (lines.length ? lines.slice(0, 40).join("\n") : "No integrity events recorded.");
        if (info.invalidated) {
          if (window.confirm(summary + "\n\nRestore this attempt to the rankings?")) {
            var why = window.prompt("Reason for restoring (recorded in the audit log):", "Reviewed: false positive");
            if (why) await store.invalidateAttempt(attemptId, why, true);
          }
        } else if (window.confirm(summary + "\n\nInvalidate this attempt? It will be removed from rankings (reversible, audited).")) {
          var reason = window.prompt("Reason for invalidating (recorded in the audit log):", "");
          if (reason && reason.trim().length >= 3) {
            await store.invalidateAttempt(attemptId, reason.trim(), false);
            window.alert("Attempt invalidated.");
          }
        }
      } catch (error) {
        window.alert(error && error.message ? error.message : "Could not load integrity details.");
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
  }

  function parseHashRoute() {
    var hash = window.location.hash.replace(/^#\/?/, "");
    var search = window.location.search ? window.location.search.replace(/^\?/, "") : "";
    var hashPath = hash.split("?")[0] || "";
    var queryString = hash.indexOf("?") !== -1 ? hash.substring(hash.indexOf("?") + 1) : search;
    var params = {};
    if (queryString) {
      queryString.split("&").forEach(function (pair) {
        var parts = pair.split("=");
        if (parts[0]) {
          params[decodeURIComponent(parts[0])] = decodeURIComponent(parts[1] || "");
        }
      });
    }
    var parts = hashPath ? hashPath.split("/") : [];
    var view = parts[0] || "";

    if (!view) {
      if (params.testId || params.view === "admin" || params.topic || params.section) {
        view = "admin";
      } else {
        try {
          var lastView = localStorage.getItem("aceiiit_last_view");
          if (lastView && lastView === "admin") {
            view = "admin";
          }
        } catch (_e) { }
      }
    }

    return { view: view, id: parts[1] || params.testId || "", params: params };
  }

  function renderRoute() {
    runtime.lastRouteView = routeParts()[0] || "";
    runtime.lastRouteHash = window.location.hash;
    clearActiveRenderModal();
    var route = parseHashRoute();
    var parts = routeParts();
    var user = auth.getCurrentUser ? auth.getCurrentUser() : null;
    var savedLastView = (function () { try { return localStorage.getItem("aceiiit_last_view"); } catch (_e) { return ""; } })();
    var view = route.view || (user ? (savedLastView || "dashboard") : "login");
    applyTheme();

    if (view !== "test") {
      stopRuntime(true);
    }

    if (view === "activate" || view === "reset-password" || view === "forgot-password") {
      renderLogin(view, route.params);
      return;
    }

    if (!user && view !== "login") {
      navigate("login");
      return;
    }

    if (user && (view === "login" || view === "activate" || view === "reset-password" || view === "forgot-password")) {
      var targetView = savedLastView === "admin" ? "admin" : "dashboard";
      navigate(targetView);
      return;
    }

    if (view === "login") {
      renderLogin("login", route.params);
      return;
    }

    if (view === "dashboard") {
      renderDashboard(user);
      return;
    }

    if (view === "exams") {
      renderExams(user, parts[1]);
      return;
    }

    if (view === "progress") {
      renderProgress(user, parts[1]);
      return;
    }

    if (view === "resources") {
      renderResources(user, parts[1]);
      return;
    }

    if (view === "updates") {
      renderUpdates(user, parts[1]);
      return;
    }

    if (view === "account") {
      renderAccount(user, parts[1]);
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
    var nextView = routeParts()[0] || "";
    // Leaving an active exam (Back, or any hash change) needs confirmation. Leaving never
    // abandons it: the server session, deadline and saved answers stay authoritative.
    var activeAttempt = runtime.attemptId && store.getAttemptById ? store.getAttemptById(runtime.attemptId) : null;
    if (activeAttempt && activeAttempt.status === "in_progress" && runtime.lastRouteView === "test" && nextView !== "test") {
      if (!window.confirm("Leave the exam?\n\nYour answers are saved and the timer keeps running. You can resume from the dashboard.")) {
        window.location.hash = runtime.lastRouteHash;
        return;
      }
    }
    resetNavDrawerState();
    overlayHistory.clear();
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
    if (view === "dashboard" || view === "results" || view === "") {
      syncAndRenderCurrentRoute({ silent: true });
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
      if (view === "dashboard" || view === "results" || view === "") {
        syncAndRenderCurrentRoute({ silent: true });
      }
    }
  });

  var lastScrollY = 0;
  var isHeaderHovered = false;

  window.addEventListener("scroll", function (e) {
    var header = document.querySelector(".dashboard-header");
    var autohideBars = document.querySelectorAll(".autohide-bar");
    
    var currentScrollY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop;
    if (e.target && e.target.scrollTop !== undefined && e.target !== document && e.target !== document.body && e.target !== document.documentElement) {
       currentScrollY = e.target.scrollTop;
    }

    if (currentScrollY > 10) {
      if (header) header.classList.add("is-pinned");
    } else {
      if (header) header.classList.remove("is-pinned");
    }
    
    if (currentScrollY > lastScrollY && currentScrollY > 50) {
      if (!isHeaderHovered) {
        if (header) header.classList.add("is-hidden");
        autohideBars.forEach(function(bar) { bar.classList.add("is-hidden"); });
      }
    } else if (currentScrollY < lastScrollY) {
      if (header) header.classList.remove("is-hidden");
      autohideBars.forEach(function(bar) { bar.classList.remove("is-hidden"); });
    }
    
    lastScrollY = currentScrollY;
  }, { passive: true, capture: true });

  window.addEventListener("mousemove", function(e) {
    var header = document.querySelector(".dashboard-header");
    var autohideBars = document.querySelectorAll(".autohide-bar");

    var currentScrollY = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop;
    
    // If mouse is at the very top of the viewport (trigger zone)
    if (e.clientY < 50) {
      isHeaderHovered = true;
      if (header) header.classList.remove("is-hidden");
      autohideBars.forEach(function(bar) { bar.classList.remove("is-hidden"); });
    } 
    // If mouse moves away from the header area
    else if (e.clientY > 85) {
      if (isHeaderHovered) {
        isHeaderHovered = false;
        // Re-hide if we are scrolled down
        if (currentScrollY > 50) {
          if (header) header.classList.add("is-hidden");
          autohideBars.forEach(function(bar) { bar.classList.add("is-hidden"); });
        }
      }
    } else {
      // Mouse is over the header area (between 50 and 85)
      isHeaderHovered = true;
    }
  }, { passive: true });

  // Restored from the back/forward cache: the page may be minutes old; re-sync from the server
  // (the deadline is always derived from server state).
  window.addEventListener("pageshow", function (event) {
    if (event.persisted && (routeParts()[0] || "") === "test") {
      syncAndRenderCurrentRoute({ silent: true });
    }
  });

  window.addEventListener("beforeunload", function () {
    clearKeepAliveTimer();
    var exitingAttemptId = runtime.attemptId;
    flushQuestionTime();
    if (exitingAttemptId && store.flushAutosaveOnExit) {
      store.flushAutosaveOnExit(exitingAttemptId);
    }
  });
  document.addEventListener("visibilitychange", function () {
    // Push pending answers to the server as soon as the exam tab is hidden.
    if (document.hidden && runtime.attemptId && store.flushAutosave) {
      flushQuestionTime();
      store.flushAutosave(runtime.attemptId).catch(function () {});
    }
  });
  document.addEventListener("click", function (event) {
    var toggle = event.target && event.target.closest ? event.target.closest("[data-theme-toggle='true']") : null;
    if (!toggle) return;
    toggleThemePreference();
  });

  if (!window.location.hash) {
    var initialRoute = parseHashRoute();
    if (initialRoute.view) {
      window.location.hash = "#/" + initialRoute.view;
    } else {
      var savedLastView = (function () { try { return localStorage.getItem("aceiiit_last_view"); } catch (_e) { return ""; } })();
      if (savedLastView === "admin") {
        window.location.hash = "#/admin";
      } else {
        navigate("login");
      }
    }
  }
  renderRoute();
  Promise.resolve(store.init()).finally(function () {
    if (store.subscribeToRemoteChanges && !remoteChangeUnsubscribe) {
      remoteChangeUnsubscribe = store.subscribeToRemoteChanges(function () {
        var currentView = routeParts()[0] || "";
        if (isExamLikeRoute(currentView)) {
          return;
        }
        syncAndRenderCurrentRoute({ silent: true });
      });
    }
    startSyncPolling();
    updateKeepAliveState();
    syncAndRenderCurrentRoute();
  });
})();
