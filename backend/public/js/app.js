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
  // Buy buttons open the AceIIIT course picker with the Paid Mock Series ticked (the site skips
  // its intro for section links); the mentor's programme link opens it with nothing ticked.
  var BUY_SERIES_URL = "https://aceiiit.in/?course=mock#packages";
  var PROGRAMME_URL = "https://aceiiit.in/#packages";
  var remoteChangeUnsubscribe = null;
  var overlayLoaderVisible = false;
  var overlayLoaderTimer = 0;
  var syncPollId = null;
  var syncInFlight = false;
  var syncQueued = false;
  var syncQueuedSettings = null;
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
      var authTimeout = window.setTimeout(function () {
        hideOverlayLoader();
        renderRoute();
        safeShowFeedback("Sign-in is taking longer than expected. Please check your connection and try again.", true);
      }, 15000);
      try {
        console.log("[Google Auth] POST /api/auth/google started");
        var resData = await auth.googleAuth({ credential: response.credential });
        console.log("[Google Auth] POST /api/auth/google completed");
        if (resData && (resData.ok || resData.user)) {
          if (store && typeof store.setCurrentUser === "function") {
            store.setCurrentUser(resData.user);
          }
          console.log("[Google Auth] navigate dashboard");
          hideOverlayLoader();
          navigate("dashboard");
        } else {
          hideOverlayLoader();
          renderRoute();
          setTimeout(function () {
            safeShowFeedback("Google authentication failed. Please try again.", true);
          }, 0);
        }
      } catch (err) {
        hideOverlayLoader();
        renderRoute();
        setTimeout(function () {
          safeShowFeedback(safeFriendlyFetchFailure(err && err.message ? err.message : "Google authentication failed. Please try again."), true);
        }, 0);
      } finally {
        window.clearTimeout(authTimeout);
        hideOverlayLoader();
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

  // The first name as shown to the student: first letter capitalised, the rest as typed
  // ("marco" → "Marco", "McKenzie" stays). The "there" fallback reads as "Hey there".
  function firstName(name) {
    var first = String(name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean)[0];
    return first ? first.charAt(0).toUpperCase() + first.slice(1) : "there";
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

  // Theme switch curtain: a full-screen panel in the next theme's colour drops from the top, the
  // theme changes while the page is covered, then it pulls back up. Reduced motion: a short fade.
  var THEME_CURTAIN_MS = 600;
  var THEME_CURTAIN_REDUCED_MS = 200;
  var themeCurtainBusy = false;

  // Lives on <body>, outside #app, so renderRoute() never replaces it mid-animation.
  function ensureThemeCurtain() {
    var curtain = document.getElementById("theme-curtain");
    if (!curtain && document.body) {
      curtain = document.createElement("div");
      curtain.id = "theme-curtain";
      curtain.className = "theme-curtain";
      curtain.setAttribute("aria-hidden", "true");
      document.body.appendChild(curtain);
    }
    return curtain;
  }

  function switchThemeWithCurtain(trigger) {
    if (themeCurtainBusy || isThemeForcedLight()) return;
    var curtain = ensureThemeCurtain();
    if (!curtain) {
      toggleThemePreference();
      return;
    }
    var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var duration = reduceMotion ? THEME_CURTAIN_REDUCED_MS : THEME_CURTAIN_MS;
    var restoreFocus = !!trigger && document.activeElement === trigger;
    themeCurtainBusy = true;
    curtain.setAttribute("data-to", getStoredThemePreference() === "dark" ? "light" : "dark");
    curtain.style.transitionDuration = duration + "ms";
    curtain.classList.add("is-active", "is-covering");
    // Timers rather than transitionend, so the switch still completes when transitions are off.
    window.setTimeout(function () {
      toggleThemePreference();
      if (restoreFocus) {
        var toggles = document.querySelectorAll("[data-theme-toggle='true']");
        for (var i = 0; i < toggles.length; i++) {
          if (toggles[i].offsetParent !== null) {
            toggles[i].focus();
            break;
          }
        }
      }
      window.requestAnimationFrame(function () {
        curtain.classList.remove("is-covering");
        window.setTimeout(function () {
          curtain.classList.remove("is-active");
          themeCurtainBusy = false;
        }, duration + 60);
      });
    }, duration);
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

  // A line break is kept when the previous line ends a sentence/clause or a TeX row (\\), when
  // the next line starts a list item, step or math continuation, or when either line is
  // column-aligned (tabs or runs of spaces).
  var REFLOW_KEEP_AFTER = /(?:[.?!:;]|\\\\)\s*$/;
  var REFLOW_KEEP_BEFORE = /^\s*(?:\(\s*(?:[a-z]|[ivx]{1,4}|\d{1,2})\s*\)|(?:[a-z]|[ivx]{1,4}|\d{1,2})[.)](?:\s|$)|[•\-*–—=⇒→∴]|(?:statement|assertion|reason|column|list|step|case|note)\b)/i;
  var REFLOW_ALIGNED = /\t| {3,}\S/;
  var REFLOW_BLOCK = "\uE000"; // private-use marker standing in for a protected math block

  // Question text pasted from PDFs carries hard line breaks mid-sentence ("…net charge, is\nzero.").
  // Display-only reflow: a single mid-sentence break becomes a space; paragraph breaks, list items
  // and display-math blocks ($$…$$, \[…\], \begin…\end) are kept exactly as typed.
  function reflowHardBreaks(value) {
    var text = String(value || "").replace(/\r\n?/g, "\n");
    if (text.indexOf("\n") === -1) return text;
    var blocks = [];
    var masked = text.replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\begin\{([a-zA-Z*]+)\}[\s\S]*?\\end\{\1\}/g, function (match) {
      blocks.push(match);
      return REFLOW_BLOCK + (blocks.length - 1) + REFLOW_BLOCK;
    });
    var lines = masked.split("\n");
    var out = lines[0];
    for (var i = 1; i < lines.length; i++) {
      var prev = lines[i - 1];
      var line = lines[i];
      var keep = !prev.trim() || !line.trim() ||
        REFLOW_KEEP_AFTER.test(prev) || REFLOW_KEEP_BEFORE.test(line) ||
        REFLOW_ALIGNED.test(prev) || REFLOW_ALIGNED.test(line) ||
        /\uE000\s*$/.test(prev) || /^\s*\uE000/.test(line);
      out = keep ? out + "\n" + line : out.replace(/[ \t]+$/, "") + " " + line.replace(/^\s+/, "");
    }
    return out.replace(/\uE000(\d+)\uE000/g, function (_match, index) { return blocks[Number(index)]; });
  }

  // Long reading passages (REAP comprehension) keep the exam's side-by-side split so the options
  // stay in view; short ones are lead-in instructions and stack above the question text.
  function isLongPassage(passage) {
    var text = String(passage || "").trim();
    return text.length > 600 || (text.match(/\n\s*\n/g) || []).length >= 2;
  }

  function formatRichText(value) {
    // Keep raw newlines so KaTeX auto-render can match delimiters like:
    // \[ ... \] even when the user types it on multiple lines.
    // Rendering uses CSS `white-space: pre-wrap` on `.rich-text`.
    return escapeHtml(reflowHardBreaks(value));
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

  /** Counts a number up with an ease-out (about 0.7 s); instant on revisits and with reduced motion. */
  function animateNumber(el, end, options) {
    if (!el) return;
    var target = Number(end || 0);
    var prefix = el.getAttribute("data-prefix") || "";
    var suffix = el.getAttribute("data-suffix") || "";
    var decimals = Number(el.getAttribute("data-decimals") || 0);
    var show = function (value) { el.textContent = prefix + Number(value).toFixed(decimals) + suffix; };
    if (!Number.isFinite(target) || target === 0 || (options && options.instant) || prefersReducedMotion()) {
      show(Number.isFinite(target) ? target : 0);
      return;
    }
    var duration = 700;
    var startedAt = null;
    function frame(now) {
      if (startedAt === null) startedAt = now;
      var t = Math.min(1, (now - startedAt) / duration);
      var eased = 1 - Math.pow(1 - t, 3);
      show(t === 1 ? target : target * eased);
      if (t < 1 && el.isConnected) window.requestAnimationFrame(frame);
    }
    show(0);
    window.requestAnimationFrame(frame);
  }

  // Results the student has already opened: the score reveal and celebration play once.
  function hasSeenResultReveal(attemptId) {
    try { return (JSON.parse(localStorage.getItem("aceiiit_seen_results") || "[]") || []).indexOf(String(attemptId)) !== -1; } catch (_e) { return false; }
  }

  function markResultRevealSeen(attemptId) {
    try {
      var seen = JSON.parse(localStorage.getItem("aceiiit_seen_results") || "[]") || [];
      if (seen.indexOf(String(attemptId)) === -1) seen.push(String(attemptId));
      localStorage.setItem("aceiiit_seen_results", JSON.stringify(seen.slice(-200)));
    } catch (_e) { }
  }

  // The exam students are preparing for. The admin-set UGEE date applies through the end of
  // that exam day; after it, the target is the next yearly anniversary of that date (exam on
  // 26 Apr 2026, today 13 Oct 2026 → UGEE 2027). Null when no date is set.
  function targetExamDate(now) {
    var config = store.getAppConfig ? store.getAppConfig() : null;
    var date = config && config.ugeeExamDate ? new Date(config.ugeeExamDate) : null;
    if (!date || isNaN(date.getTime())) return null;
    var today = new Date(now || Date.now());
    today.setHours(0, 0, 0, 0);
    var target = new Date(date.getTime());
    target.setHours(0, 0, 0, 0);
    while (target < today) target.setFullYear(target.getFullYear() + 1);
    return target;
  }

  function examLabelForDate(date) {
    return date && !isNaN(date.getTime()) ? "UGEE " + date.getFullYear() : "UGEE";
  }

  // One source for the student-facing exam label (eyebrow, account, notices).
  function targetExamLabel() {
    return examLabelForDate(targetExamDate());
  }

  // Custom practice papers are short and unranked, so they never count as mocks in progress
  // stats, reports or tips (they keep their own list under Exams → Practice).
  function isPracticeAttempt(attempt) {
    if (!attempt) return false;
    if (attempt.isPractice) return true;
    var test = store.getTestById ? store.getTestById(attempt.testId) : null;
    return !!(test && test.isPractice);
  }

  function mockAttemptsOnly(attempts) {
    return (attempts || []).filter(function (attempt) { return !isPracticeAttempt(attempt); });
  }

  // KPIs over a student's submitted attempts, shared by Dashboard and Progress so both always agree.
  // Scores are marks (not percentages); accuracy and percentile are percentages.
  function summarizeAttempts(attempts) {
    var submitted = (attempts || []).filter(function (a) { return a && a.status === "submitted" && a.result; })
      .sort(function (a, b) { return new Date(a.submittedAt) - new Date(b.submittedAt); });
    var count = submitted.length;
    var round1 = function (value) { return Math.round(value * 10) / 10; };
    var total = function (pick) {
      return submitted.reduce(function (sum, a) { return sum + (Number(pick(a.result)) || 0); }, 0);
    };
    var unanswered = function (r) {
      return r.unattemptedCount !== undefined && r.unattemptedCount !== null ? r.unattemptedCount : r.skippedCount;
    };
    var questionsSeen = total(function (r) { return Number(r.correctCount || 0) + Number(r.wrongCount || 0) + Number(unanswered(r) || 0); });
    var secondsSpent = total(function (r) { return r.timeTakenSeconds; });
    var best = submitted.reduce(function (top, a) {
      return !top || Number(a.result.score) > Number(top.result.score) ? a : top;
    }, null);
    var sectionMap = {};
    submitted.forEach(function (a) {
      var scores = a.result.sectionScores || {};
      Object.keys(scores).forEach(function (key) {
        var row = sectionMap[key] || (sectionMap[key] = { key: key, correct: 0, wrong: 0, skipped: 0 });
        row.correct += Number(scores[key].correct || 0);
        row.wrong += Number(scores[key].wrong || 0);
        row.skipped += Number(scores[key].skipped || 0);
      });
    });
    var sections = Object.keys(sectionMap).sort(function (a, b) {
      var order = ["SUPR", "REAP"];
      return (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99);
    }).map(function (key) {
      var row = sectionMap[key];
      var attempted = row.correct + row.wrong;
      row.accuracy = attempted ? round1((row.correct / attempted) * 100) : 0;
      return row;
    });
    return {
      count: count,
      submitted: submitted,
      averageScore: count ? round1(total(function (r) { return r.score; }) / count) : null,
      bestScore: best ? Number(best.result.score) : null,
      bestScorePercentile: best && Number(best.result.percentile) > 0 ? Number(best.result.percentile) : null,
      averageAccuracy: count ? round1(total(function (r) { return r.accuracy; }) / count) : null,
      bestPercentile: count ? Math.max.apply(null, submitted.map(function (a) { return Number(a.result.percentile) || 0; })) : null,
      secondsPerQuestion: questionsSeen && secondsSpent ? Math.round(secondsSpent / questionsSeen) : null,
      sections: sections
    };
  }

  // Correct / wrong / skipped as one proportional bar; widths animate in via activateAnalysisAnimations.
  function buildOutcomeBar(correct, wrong, skipped, extraClass) {
    correct = Number(correct || 0);
    wrong = Number(wrong || 0);
    skipped = Number(skipped || 0);
    var total = Math.max(1, correct + wrong + skipped);
    var pct = function (value) { return Math.round((value / total) * 10000) / 100 + "%"; };
    return (
      '<div class="rs-stackbar' + (extraClass ? ' ' + extraClass : '') + '" role="img" aria-label="' +
      escapeAttribute(correct + ' correct, ' + wrong + ' wrong, ' + skipped + ' skipped') + '">' +
      '<span class="is-correct" data-width="' + pct(correct) + '"></span>' +
      '<span class="is-wrong" data-width="' + pct(wrong) + '"></span>' +
      '<span class="is-skipped" data-width="' + pct(skipped) + '"></span>' +
      '</div>'
    );
  }

  // Small labelled column chart for a short series (accuracy or score per attempt, oldest → latest).
  // Every bar carries its value; zero is a hairline on the axis, never a stub that reads as data.
  // Optional: options.xLabels names each bar under the axis; options.highlightIndex picks the
  // gold bar (default: the latest).
  function buildBarTrend(values, options) {
    options = options || {};
    var series = (values || []).map(function (value) { return Number(value) || 0; });
    var max = Number(options.max) > 0 ? Number(options.max) : Math.max.apply(null, series.concat([1]));
    var format = options.format || function (value) { return Math.round(value * 10) / 10 + "%"; };
    var labels = series.map(format);
    var xLabels = Array.isArray(options.xLabels) ? options.xLabels : null;
    var highlight = options.highlightIndex !== undefined && options.highlightIndex !== null ? Number(options.highlightIndex) : series.length - 1;
    var described = labels.map(function (label, index) { return xLabels ? xLabels[index] + " " + label : label; });
    return (
      '<div class="bar-trend' + (xLabels ? ' has-x-labels' : '') + '" role="img" aria-label="' + escapeAttribute((options.label || "Trend, oldest to latest") + ": " + described.join(", ")) + '">' +
      series.map(function (value, index) {
        var ratio = Math.max(0, Math.min(1, value / max));
        return (
          '<span class="bar-trend-col' + (index === highlight ? ' is-latest' : '') + '" aria-hidden="true">' +
          '<b class="bar-trend-value">' + escapeHtml(labels[index]) + '</b>' +
          '<i class="bar-trend-bar" style="height:max(2px, calc((100% - 18px) * ' + ratio.toFixed(3) + '))"></i>' +
          (xLabels ? '<small class="bar-trend-x">' + escapeHtml(String(xLabels[index])) + '</small>' : '') +
          '</span>'
        );
      }).join("") +
      '</div>'
    );
  }

  // Report formatting: marks keep up to two decimals (2.25, never rounded to 2); percentages keep
  // one; durations read as 24s / 4m 10s / 2h 05m.
  function formatMarks(value) {
    return String(Math.round(Number(value || 0) * 100) / 100);
  }

  function formatSignedMarks(value) {
    var number = Math.round(Number(value || 0) * 100) / 100;
    return number > 0 ? "+" + number : number < 0 ? "\u2212" + Math.abs(number) : "0";
  }

  function formatPct(value) {
    return String(Math.round(Number(value || 0) * 10) / 10) + "%";
  }

  function decimalsFor(value, maxDigits) {
    var number = Number(value || 0);
    for (var digits = 0; digits < maxDigits; digits++) {
      var factor = Math.pow(10, digits);
      if (Math.abs(Math.round(number * factor) - number * factor) < 1e-9) return digits;
    }
    return maxDigits;
  }

  function formatDurationShort(totalSeconds) {
    var safe = Math.max(0, Math.round(Number(totalSeconds || 0)));
    if (safe < 60) return safe + "s";
    var hours = Math.floor(safe / 3600);
    var minutes = Math.floor((safe % 3600) / 60);
    var seconds = safe % 60;
    if (hours) return hours + "h" + (minutes ? " " + String(minutes).padStart(2, "0") + "m" : "");
    return minutes + "m" + (seconds ? " " + seconds + "s" : "");
  }

  function ordinal(value) {
    var n = Math.round(Number(value || 0));
    var mod100 = n % 100;
    var suffix = mod100 >= 11 && mod100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
    return n + suffix;
  }

  // Display-only title case for topic tags typed in admin ("basic physics" → "Basic Physics",
  // "3d geo" → "3D Geo"); words already in capitals are left alone.
  var TOPIC_MINOR_WORDS = { and: 1, of: 1, the: 1, in: 1, on: 1, for: 1, to: 1, with: 1 };
  function formatTopicName(name) {
    return String(name || "General").trim().split(/\s+/).map(function (word, index) {
      if (/^\d+[a-z]$/i.test(word)) return word.toUpperCase();
      if (index > 0 && TOPIC_MINOR_WORDS[word]) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    }).join(" ");
  }

  // Dashboard mascot: short advice for the signed-in student, most relevant first. Each tip is
  // grounded in their own attempts, the next mock or the exam date. Returns HTML strings.
  function buildMascotTips(ctx) {
    var name = firstName(ctx.user && ctx.user.name);
    var hello = '<strong>Hey ' + escapeHtml(name) + '!</strong> ';
    var tests = ctx.tests || [];
    var titleOf = function (testId) {
      var test = tests.filter(function (t) { return t.id === testId; })[0];
      return test && test.title ? test.title : "your mock";
    };
    var next = ctx.nextUpTest || null;
    var submitted = (ctx.attempts || []).filter(function (a) { return a && a.status === "submitted" && a.result; })
      .sort(function (a, b) { return new Date(b.submittedAt) - new Date(a.submittedAt); });
    var tips = [];

    if (ctx.inProgressAttempt) {
      tips.push("Your " + titleOf(ctx.inProgressAttempt.testId) + " attempt is still open and your answers are saved. Resume it from Next Up.");
    }

    if (!submitted.length) {
      if (next) {
        var minutes = Number(next.durationMinutes || 0);
        tips.push("Start with " + next.title + "." + (minutes ? " It runs " + formatDurationShort(minutes * 60) + ", so block the time like the real exam." : ""));
      }
    } else {
      var last = submitted[0];
      var r = last.result;
      var correct = Number(r.correctCount || 0);
      var wrong = Number(r.wrongCount || 0);
      var blank = Number(r.unattemptedCount !== undefined && r.unattemptedCount !== null ? r.unattemptedCount : r.skippedCount || 0);
      var attempted = correct + wrong;
      var total = attempted + blank;
      var accuracy = attempted ? (correct / attempted) * 100 : 0;
      if (total && attempted / total < 0.1) {
        tips.push("Your last mock ended after " + attempted + " answer" + (attempted === 1 ? "" : "s") + ". Sit a full paper next for a report you can rely on.");
      } else if (total && attempted / total < 0.6) {
        var target = Math.min(total, Math.max(Math.ceil(total * 0.5), Math.ceil(attempted * 1.25), attempted + 1));
        tips.push("You left " + blank + " of " + total + " questions blank last time. Aim for at least " + target + " attempts in your next mock.");
      } else if (attempted >= 10 && accuracy < 55) {
        tips.push("Accuracy was " + formatPct(accuracy) + " in your last mock. Rule out two options before you commit to an answer.");
      } else if (total && accuracy >= 75 && attempted / total >= 0.8) {
        tips.push(formatPct(accuracy) + " accuracy last time. Keep it going" + (next ? " with " + next.title : "") + ".");
      }
    }

    var examDate = ctx.examDate ? new Date(ctx.examDate) : null;
    if (examDate && !isNaN(examDate.getTime())) {
      var today = new Date();
      today.setHours(0, 0, 0, 0);
      var examDay = new Date(examDate.getTime());
      examDay.setHours(0, 0, 0, 0);
      var days = Math.round((examDay - today) / (24 * 60 * 60 * 1000));
      var exam = examLabelForDate(examDate);
      if (days > 1) tips.push(days + " days to " + exam + ". One full timed mock a week keeps you exam-ready.");
      else if (days === 1) tips.push(exam + " is tomorrow. Rest well and trust your preparation.");
      else if (days === 0) tips.push(exam + " is today. All the best!");
      else if (days > -120) tips.push(exam + " is behind you. All the best for your results!");
    }

    if (submitted.length) {
      var latest = submitted[0];
      var previous = submitted.filter(function (a) { return a.testId === latest.testId && a.id !== latest.id; })[0];
      if (previous && Number(latest.result.score) > Number(previous.result.score)) {
        tips.push("Your score on " + titleOf(latest.testId) + " went from " + formatMarks(previous.result.score) + " to " + formatMarks(latest.result.score) + ". Keep going!");
      }
      tips.push("Open your latest report for a 3-step plan for your next mock.");
    }

    if (!tips.length) {
      tips.push(next ? "Ready when you are. " + next.title + " is up next." : "Ready when you are. Pick a mock from Available tests.");
    }
    return tips.map(function (tip) { return hello + escapeHtml(tip); });
  }

  function activateAnalysisAnimations(root, options) {
    if (!root) return;
    root.querySelectorAll("[data-width]").forEach(function (el) {
      window.requestAnimationFrame(function () {
        el.style.width = String(el.getAttribute("data-width") || "0%");
      });
    });
    root.querySelectorAll("[data-animate-number]").forEach(function (el) {
      animateNumber(el, Number(el.getAttribute("data-animate-number") || 0), options);
    });
  }

  function getInputValue(formEl, selector) {
    var el = formEl ? formEl.querySelector(selector) : null;
    return el && typeof el.value === "string" ? el.value : "";
  }

  // The editor's working-copy images at their exam sizes, for the question previews.
  function buildPreviewFiguresBlock() {
    var draft = runtime.questionImageDraft;
    var items = draft ? draft.items.filter(function (item) { return item.url; }) : [];
    if (!items.length) return "";
    return '<div class="latex-preview-block">' +
      '<p class="section-label" style="margin-bottom: 10px;">Images (as students see them)</p>' +
      renderQuestionFigures({ imageUrls: items.map(function (i) { return i.url; }), imageWidths: items.map(function (i) { return i.width; }) }) +
      '</div>';
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
      buildPreviewFiguresBlock() +
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

  // Mobile browsers size fixed elements to the layout viewport. When the page is zoomed in or an
  // in-app browser shows only part of it, "centred" lands off to one side, so the loader is
  // pinned to the centre of what the user actually sees (the visual viewport), at normal size.
  var overlayViewportSync = null;

  function fitOverlayToViewport(overlay) {
    var vv = window.visualViewport;
    var content = overlay && overlay.querySelector(".app-loading-screen__content");
    if (!vv || !content) return;
    var scale = vv.scale || 1;
    content.style.position = "fixed";
    content.style.left = (vv.offsetLeft + vv.width / 2).toFixed(1) + "px";
    content.style.top = (vv.offsetTop + vv.height / 2).toFixed(1) + "px";
    content.style.transform = "translate(-50%, -50%) scale(" + (1 / scale).toFixed(4) + ")";
  }

  function watchOverlayViewport(overlay) {
    var vv = window.visualViewport;
    fitOverlayToViewport(overlay);
    if (!vv || overlayViewportSync) return;
    var queued = false;
    overlayViewportSync = function () {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(function () {
        queued = false;
        fitOverlayToViewport(document.querySelector("[data-sync-overlay='true']"));
      });
    };
    vv.addEventListener("resize", overlayViewportSync);
    vv.addEventListener("scroll", overlayViewportSync);
  }

  function unwatchOverlayViewport() {
    if (!overlayViewportSync || !window.visualViewport) return;
    window.visualViewport.removeEventListener("resize", overlayViewportSync);
    window.visualViewport.removeEventListener("scroll", overlayViewportSync);
    overlayViewportSync = null;
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
      existing.style.pointerEvents = "";
      existing.style.opacity = "1";
      watchOverlayViewport(existing);
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
      watchOverlayViewport(overlay);
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
    unwatchOverlayViewport();
    document.body.classList.remove("is-syncing");
    var existing = document.querySelector("[data-sync-overlay='true']");
    if (existing) {
      // Fading out: it must not swallow the next click while it disappears.
      existing.style.pointerEvents = "none";
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

  /** A live mock's result before its results time: submitted, with a countdown to the release. */
  function renderPendingResults(user, attempt) {
    var test = store.getTestById(attempt.testId);
    var when = new Date(attempt.resultsAt || 0);
    app.innerHTML = buildShell(
      renderPrimaryNav("progress", user) +
      '<section class="rs-page rs-pending">' +
      '<div class="rs-pending-card" role="status">' +
      '<span class="rs-pending-check" aria-hidden="true">✓</span>' +
      '<p class="section-label">Live mock · submitted</p>' +
      '<h1>' + escapeHtml(test && test.title ? test.title : "Live mock") + '</h1>' +
      '<p>Your answers are in. Scores and ranks come out for everyone at the same time:</p>' +
      '<p class="rs-pending-when"><strong>' + escapeHtml(formatOpensAt(when)) + '</strong>' +
      '<span class="test-opens" data-opens-at="' + escapeAttribute(when.toISOString()) + '"> · <span data-countdown>' + escapeHtml(formatCountdown(when.getTime() - serverNowMs())) + '</span></span></p>' +
      '<p class="helper-text">This page shows your result by itself when the time comes.</p>' +
      '<div class="button-row"><a class="button button-secondary" href="#dashboard">Back to dashboard</a></div>' +
      '</div>' +
      '</section>'
    );
  }

  /**
   * "Where your time went": a strip with one bar per question (height = seconds, colour = how
   * it went), section tiles and the slowest questions. From the attempt's own timing data.
   */
  function mountTimeInsights(root, insights) {
    if (!root || !insights || !Array.isArray(insights.strip) || !insights.strip.length) return;
    var max = Math.max.apply(null, insights.strip.map(function (s) { return s[0]; }).concat([1]));
    var statusWord = { c: "correct", w: "wrong", s: "skipped" };
    var bars = insights.strip.map(function (s, i) {
      var pct = Math.max(2, Math.round((s[0] / max) * 100));
      var prev = insights.strip[i - 1];
      return '<span class="ti-bar is-' + statusWord[s[1]] + (prev && prev[2] !== s[2] ? ' is-section-start' : '') + '" style="--h:' + pct + '%" data-donut-tip="' +
        escapeAttribute("Q" + (i + 1) + " · " + formatTime(s[0]) + " · " + statusWord[s[1]]) + '"></span>';
    }).join("");
    var tiles = ["SUPR", "REAP"].filter(function (k) { return insights.sections && insights.sections[k]; }).map(function (k) {
      var sec = insights.sections[k];
      return '<div class="ti-tile"><p class="section-label">' + k + '</p>' +
        '<p class="ti-big">' + escapeHtml(formatDurationShort(sec.totalSeconds)) + '</p>' +
        '<p class="ti-sub">' + (sec.avgCorrectSeconds !== null ? 'right answers ' + escapeHtml(formatTime(sec.avgCorrectSeconds)) + ' each' : 'no right answers') +
        (sec.avgWrongSeconds !== null ? ' · wrong ' + escapeHtml(formatTime(sec.avgWrongSeconds)) + ' each' : '') + '</p>' +
        '<p class="ti-sub">' + sec.wrongTimePct + '% of the time went on wrong answers</p></div>';
    }).join("");
    var slowest = (insights.slowest || []).map(function (q) {
      return '<li><button type="button" class="ti-jump" data-ti-question="' + q.number + '"><span class="ti-q">Q' + q.number + '</span>' +
        '<span class="ti-topic">' + escapeHtml(q.topic || q.section) + '</span>' +
        '<span class="ti-time">' + escapeHtml(formatTime(q.seconds)) + '</span>' +
        '<span class="ti-status is-' + q.status + '">' + escapeHtml(q.status) + '</span></button></li>';
    }).join("");
    root.innerHTML =
      '<section class="rs-card ti-card" aria-labelledby="ti-title">' +
      '<div class="ti-head"><p class="section-label" id="ti-title">Where your time went</p>' +
      '<p class="ti-headline"><strong>' + insights.wrongTimePct + '%</strong> of your time went on answers that turned out wrong.</p></div>' +
      '<div class="ti-strip" role="img" aria-label="' + escapeAttribute("Time per question, in paper order. Longest: Q" + ((insights.slowest[0] || {}).number || "") + ".") + '">' + bars + '</div>' +
      '<ul class="ti-legend" aria-hidden="true"><li><i class="is-correct"></i>Correct</li><li><i class="is-wrong"></i>Wrong</li><li><i class="is-skipped"></i>Skipped</li><li class="ti-legend-note">Bar height = time spent</li></ul>' +
      '<div class="ti-grid">' + tiles +
      (slowest ? '<div class="ti-slowest"><p class="section-label">Slowest questions</p><ol>' + slowest + '</ol></div>' : '') +
      '</div>' +
      '</section>';
    root.querySelectorAll("[data-ti-question]").forEach(function (button) {
      button.addEventListener("click", function () { jumpToReviewQuestion(Number(button.getAttribute("data-ti-question"))); });
    });
  }

  /** Scrolls the answer review to question n (loading the review pages if needed). */
  function jumpToReviewQuestion(n) {
    var tries = 0;
    function find() {
      var cards = document.querySelectorAll(".analysis-review-card");
      var card = cards[n - 1];
      if (card) {
        card.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
        card.classList.add("is-flash");
        window.setTimeout(function () { card.classList.remove("is-flash"); }, 1400);
        return;
      }
      var load = document.getElementById("load-question-review");
      var more = document.getElementById("load-more-review");
      if (tries > 8) return;
      tries += 1;
      if (load && !load.hidden && !cards.length) load.click();
      else if (more && !more.hidden) more.click();
      window.setTimeout(find, 500);
    }
    find();
  }

  /** "Report a problem" on a reviewed question: reason chips, an optional note, then thanks. */
  function openReportQuestionDialog(attemptId, questionId, number, trigger) {
    var reasons = [["wrong_answer", "The answer key looks wrong"], ["typo", "Typo or unclear wording"], ["maths", "Maths doesn't display"], ["image", "Image missing or broken"], ["other", "Something else"]];
    var body =
      '<form class="report-form" data-report-form novalidate>' +
      '<fieldset><legend>What\'s wrong with question ' + number + '?</legend>' +
      reasons.map(function (r, i) {
        return '<label class="report-reason"><input type="radio" name="report-reason" value="' + r[0] + '"' + (i === 0 ? ' checked' : '') + '> <span>' + escapeHtml(r[1]) + '</span></label>';
      }).join("") +
      '</fieldset>' +
      '<div class="field"><label for="report-note">Details (optional)</label><textarea id="report-note" rows="3" maxlength="500" placeholder="e.g. Option B is correct because…"></textarea></div>' +
      '<p class="import-message is-error" role="alert" data-report-error></p>' +
      '<div class="button-row"><button type="submit" class="button button-primary">Send report</button></div>' +
      '</form>';
    var overlay = showAdminModal("Report a problem", body, false);
    if (!overlay) return;
    var form = overlay.querySelector("[data-report-form]");
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var reason = (form.querySelector("input[name='report-reason']:checked") || {}).value || "other";
      var note = form.querySelector("#report-note").value.trim();
      var submit = form.querySelector("button[type=submit]");
      submit.disabled = true;
      submit.textContent = "Sending…";
      Promise.resolve(store.reportQuestion(questionId, attemptId, reason, note)).then(function () {
        form.innerHTML = '<p class="report-thanks" role="status" tabindex="-1"><span aria-hidden="true">✓</span> Thanks. The AceIIIT team will check question ' + number + '.</p>';
        form.querySelector(".report-thanks").focus();
        if (trigger) {
          trigger.textContent = "Reported ✓";
          trigger.disabled = true;
        }
      }).catch(function (error) {
        submit.disabled = false;
        submit.textContent = "Send report";
        form.querySelector("[data-report-error]").textContent = (error && error.message) || "Couldn't send the report. Try again.";
      });
    });
  }

  /** Builds a practice paper of the student's own mistakes and opens its instructions. */
  function startMistakePractice(user, count, section) {
    if (!store.generateMistakePractice) return;
    showOverlayLoader("Building your mistakes paper.");
    Promise.resolve(store.generateMistakePractice(user.id, count, section || "all", 0))
      .then(function (testId) {
        hideOverlayLoader();
        navigate("instructions/" + testId);
      })
      .catch(function (error) {
        hideOverlayLoader();
        if (error && error.code === "PRACTICE_LIMIT") {
          if (window.confirm(error.message + "\n\nOpen the test series page now?")) openBuySeries();
          return;
        }
        window.alert(error && error.message ? error.message : "Could not build a practice paper.");
      });
  }

  // ---- "What's new" pop-up --------------------------------------------------------------------
  // The newest published note (last 14 days, the server decides) pops up after every sign-in,
  // and when the portal is opened in a new tab; not again on reloads or page changes in the same
  // tab. Never over an exam, the instructions page, another dialog or the mentor.
  var whatsNewCheckedFor = "";
  var whatsNewCleanup = null;
  var WN_SESSION_KEY = "aceiiit_wn_shown";

  function whatsNewShownThisSession(noteId) {
    try { return (sessionStorage.getItem(WN_SESSION_KEY) || "") === String(noteId); } catch (_e) { return false; }
  }

  function rememberWhatsNewShown(noteId) {
    try { sessionStorage.setItem(WN_SESSION_KEY, String(noteId)); } catch (_e) { }
  }

  /** Signing out (or reaching the sign-in screen) means the next sign-in shows it again. */
  function resetWhatsNewSession() {
    whatsNewCheckedFor = "";
    try { sessionStorage.removeItem(WN_SESSION_KEY); } catch (_e) { }
  }

  function scheduleWhatsNew(view, user) {
    if (!user || view === "login") { resetWhatsNewSession(); return; }
    if (!store.getWhatsNew) return;
    if (whatsNewCheckedFor === user.id) return;
    if (isExamLikeRoute(view) || view === "instructions") return;
    whatsNewCheckedFor = user.id;
    window.setTimeout(function () {
      Promise.resolve(store.getWhatsNew(false)).then(function (note) {
        if (!note || whatsNewShownThisSession(note.id)) return;
        var current = routeParts()[0] || "";
        var busy = document.querySelector("[data-admin-modal='true'], [data-whats-new], [data-quick-search], .sync-overlay, .question-editor-modal") ||
          (document.getElementById("mentor-panel") && !document.getElementById("mentor-panel").hidden);
        if (busy || isExamLikeRoute(current) || current === "instructions" || document.hidden) {
          whatsNewCheckedFor = ""; // try again on the next page
          return;
        }
        rememberWhatsNewShown(note.id);
        showWhatsNew(note, { preview: false });
      }).catch(function () { /* optional; never blocks the page */ });
    }, 700);
  }

  function formatNoteDate(iso) {
    var d = iso ? new Date(iso) : null;
    if (!d || Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
  }

  /**
   * The What's New card deck (pop-up and Studio preview): story-style segments, the note's
   * title, then one card per feature stacked like a deck, ending with an "all caught up" recap.
   */
  function buildWhatsNewCardHtml(note, titleId) {
    var cta = note.cta || (note.ctaLabel && note.ctaHref ? { label: note.ctaLabel, href: note.ctaHref } : null);
    var date = formatNoteDate(note.publishedAt);
    var items = (note.items || []).filter(function (item) { return item && item.title; });
    var total = items.length;
    var link = function (href, label, cls, attr) {
      var external = /^https:\/\//i.test(href);
      return '<a class="' + cls + '" href="' + escapeAttribute(href) + '"' + (external ? ' target="_blank" rel="noopener noreferrer"' : '') + ' ' + attr + '>' + label + '</a>';
    };
    var slides = items.map(function (item, i) {
      return '<article class="wn-slide" data-wn-slide="' + i + '" role="group" aria-roledescription="slide" aria-label="Feature ' + (i + 1) + ' of ' + total + '">' +
        '<span class="wn-slide-icon" aria-hidden="true">' + escapeHtml(item.icon || "✦") + '</span>' +
        '<h3 class="wn-slide-title">' + escapeHtml(item.title) + '</h3>' +
        (item.body ? '<p class="wn-slide-body">' + escapeHtml(item.body) + '</p>' : '') +
        (item.href && (/^#/.test(item.href) || /^https:\/\//i.test(item.href)) ? link(item.href, "Try it <span aria-hidden=\"true\">→</span>", "wn-try", "data-wn-link") : '') +
        '</article>';
    }).join("") +
      '<article class="wn-slide is-final" data-wn-slide="' + total + '" role="group" aria-roledescription="slide" aria-label="Summary">' +
      '<span class="wn-slide-icon is-check" aria-hidden="true">✓</span>' +
      '<h3 class="wn-slide-title">You\'re all caught up</h3>' +
      '<ul class="wn-recap">' + items.map(function (item, i) {
        return '<li style="--i:' + i + '"><span aria-hidden="true">✓</span> ' + escapeHtml(item.title) + '</li>';
      }).join("") + '</ul>' +
      (cta ? link(cta.href, escapeHtml(cta.label), "button button-secondary wn-final-cta", "data-wn-link") : '') +
      '</article>';
    return '<div class="wn-head">' +
      '<div class="wn-segments" aria-hidden="true">' + Array.from({ length: total + 1 }, function (_v, i) { return '<span class="wn-seg" data-wn-seg="' + i + '"><i></i></span>'; }).join("") + '</div>' +
      '<p class="wn-eyebrow"><span class="wn-spark" aria-hidden="true"></span>What\'s new' + (date ? '<span class="wn-date"> · ' + escapeHtml(date) + '</span>' : '') + '</p>' +
      '<h2 class="wn-title" id="' + titleId + '">' + escapeHtml(note.title || "Untitled") + '</h2>' +
      (note.summary ? '<p class="wn-summary">' + escapeHtml(note.summary) + '</p>' : '') +
      '</div>' +
      (note.imageUrl && /^https:\/\//i.test(note.imageUrl) ? '<img class="wn-image" src="' + escapeAttribute(note.imageUrl) + '" alt="" loading="lazy" decoding="async">' : '') +
      '<div class="wn-deck" role="region" aria-roledescription="carousel" aria-label="New features" data-wn-deck>' + slides + '</div>' +
      '<p class="sr-only" aria-live="polite" data-wn-live></p>' +
      '<div class="wn-nav">' +
      '<button type="button" class="wn-nav-btn" data-wn-prev aria-label="Previous feature"><span aria-hidden="true">‹</span> Back</button>' +
      '<span class="wn-count" data-wn-count aria-hidden="true">1 of ' + total + '</span>' +
      '<button type="button" class="button button-primary wn-next" data-wn-next>Next <span aria-hidden="true">›</span></button>' +
      '</div>';
  }

  /**
   * Makes a deck interactive: Next/Back, ← and → keys, and dragging or swiping the top card
   * (it follows the finger; past ~30% of its width or a quick flick it flies off, otherwise it
   * springs back). options: { onDone, onLink, start, onIndex }.
   */
  function bindWhatsNewDeck(card, options) {
    options = options || {};
    var deck = card.querySelector("[data-wn-deck]");
    if (!deck) return null;
    var slides = Array.prototype.slice.call(deck.querySelectorAll("[data-wn-slide]"));
    var last = slides.length - 1;
    var prev = card.querySelector("[data-wn-prev]");
    var next = card.querySelector("[data-wn-next]");
    var count = card.querySelector("[data-wn-count]");
    var live = card.querySelector("[data-wn-live]");
    var index = Math.max(0, Math.min(last, Number(options.start) || 0));

    function layout(announce) {
      slides.forEach(function (slide, i) {
        var d = i - index;
        slide.style.transform = "";
        slide.setAttribute("data-pos", d < 0 ? "gone" : d === 0 ? "top" : d === 1 ? "1" : d === 2 ? "2" : "back");
        slide.classList.toggle("is-top", d === 0);
        slide.setAttribute("aria-hidden", d === 0 ? "false" : "true");
        slide.inert = d !== 0;
      });
      card.querySelectorAll("[data-wn-seg]").forEach(function (seg, i) { seg.classList.toggle("is-done", i <= index); });
      prev.disabled = index === 0;
      var onFinal = index === last;
      next.innerHTML = onFinal ? "Got it" : 'Next <span aria-hidden="true">›</span>';
      next.classList.toggle("is-final", onFinal);
      count.textContent = onFinal ? "All done" : (index + 1) + " of " + last;
      if (announce && live) {
        var title = slides[index].querySelector(".wn-slide-title");
        live.textContent = (onFinal ? "Summary. " : "Feature " + (index + 1) + " of " + last + ": ") + (title ? title.textContent : "");
      }
      if (options.onIndex) options.onIndex(index);
    }
    function go(to) {
      if (to < 0 || to > last || to === index) return;
      index = to;
      layout(true);
    }
    prev.addEventListener("click", function () { go(index - 1); });
    next.addEventListener("click", function () {
      if (index === last) { if (options.onDone) options.onDone(); }
      else go(index + 1);
    });
    // Arrow keys: inside the card, or anywhere while the pop-up is open (a mouse drag can
    // leave focus on the page).
    var keyTarget = options.globalKeys ? document : card;
    function onKey(event) {
      if (!card.isConnected) { keyTarget.removeEventListener("keydown", onKey); return; }
      if (event.target && /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
      if (event.key === "ArrowRight") { event.preventDefault(); go(index + 1); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); go(index - 1); }
    }
    keyTarget.addEventListener("keydown", onKey);
    card.querySelectorAll("[data-wn-link]").forEach(function (a) {
      a.addEventListener("click", function (event) { if (options.onLink) options.onLink(a, event); });
    });

    // Drag / swipe the top card.
    var drag = null;
    deck.addEventListener("pointerdown", function (event) {
      var slide = event.target.closest && event.target.closest(".wn-slide.is-top");
      if (!slide || event.target.closest("a, button") || (event.pointerType === "mouse" && event.button !== 0)) return;
      drag = { slide: slide, x: event.clientX, y: event.clientY, t: performance.now(), dx: 0, moved: false, id: event.pointerId };
    });
    deck.addEventListener("pointermove", function (event) {
      if (!drag || event.pointerId !== drag.id) return;
      var dx = event.clientX - drag.x;
      var dy = event.clientY - drag.y;
      if (!drag.moved) {
        if (Math.abs(dx) < 6 || Math.abs(dy) > Math.abs(dx)) return; // let vertical scrolls through
        drag.moved = true;
        drag.slide.classList.add("is-dragging");
        try { drag.slide.setPointerCapture(event.pointerId); } catch (_e) { }
      }
      // Resist at the ends: no card before the first, nothing after the summary.
      var edge = (dx > 0 && index === 0) || (dx < 0 && index === last);
      drag.dx = edge ? dx * 0.25 : dx;
      drag.slide.style.transform = "translateX(" + drag.dx.toFixed(1) + "px) rotate(" + (prefersReducedMotion() ? 0 : drag.dx / 28).toFixed(2) + "deg)";
    });
    function endDrag(event) {
      if (!drag || (event && event.pointerId !== drag.id)) return;
      var d = drag;
      drag = null;
      d.slide.classList.remove("is-dragging");
      if (!d.moved) return;
      var width = d.slide.offsetWidth || 300;
      var speed = Math.abs(d.dx) / Math.max(1, performance.now() - d.t);
      var commit = Math.abs(d.dx) > width * 0.3 || speed > 0.6;
      if (commit && d.dx < 0 && index < last) go(index + 1);
      else if (commit && d.dx > 0 && index > 0) go(index - 1);
      else d.slide.style.transform = ""; // springs back through the CSS transition
      if (!card.contains(document.activeElement)) next.focus({ preventScroll: true });
    }
    deck.addEventListener("pointerup", endDrag);
    deck.addEventListener("pointercancel", endDrag);
    layout(false);
    return { go: go, index: function () { return index; } };
  }

  function showWhatsNew(note, options) {
    options = options || {};
    if (document.querySelector("[data-whats-new]")) return;
    var titleId = "wn-title-" + Math.random().toString(36).slice(2, 8);
    var overlay = document.createElement("div");
    overlay.className = "wn-overlay";
    overlay.setAttribute("data-whats-new", "true");
    overlay.setAttribute("data-state", "closed");
    overlay.innerHTML = '<section class="wn-card" role="dialog" aria-modal="true" aria-labelledby="' + titleId + '">' + buildWhatsNewCardHtml(note, titleId) + '</section>';
    document.body.appendChild(overlay);
    var card = overlay.querySelector(".wn-card");
    var closed = false;

    function close() {
      if (closed) return;
      closed = true;
      if (!options.preview && store.markWhatsNewSeen) Promise.resolve(store.markWhatsNewSeen()).catch(function () { });
      overlay.setAttribute("data-state", "closing");
      if (whatsNewCleanup) { whatsNewCleanup(); whatsNewCleanup = null; }
      var done = function () { overlay.remove(); };
      if (prefersReducedMotion()) done();
      else window.setTimeout(done, 200);
    }

    // Open on the next frame so the entry transition runs from the closed state.
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () { overlay.setAttribute("data-state", "open"); });
    });
    bindWhatsNewDeck(card, {
      globalKeys: true,
      onDone: close,
      onLink: function (a, event) {
        var href = a.getAttribute("href") || "";
        close();
        if (href.charAt(0) === "#") {
          event.preventDefault();
          window.location.hash = href;
        }
      },
    });
    whatsNewCleanup = activateModalFocus(card, { onEscape: close, titleId: titleId, initialFocusEl: overlay.querySelector("[data-wn-next]") });
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) close();
    });
  }

  // ---- Studio → Reports: what students flagged, grouped by question ---------------------------
  var REPORT_REASON_LABELS = { wrong_answer: "Answer key", typo: "Typo / wording", maths: "Maths display", image: "Image", other: "Other" };
  var reportsAdmin = { status: "open", data: null, message: "" };

  function buildAdminReportsHtml() {
    return '<div class="reports-studio" id="reports-admin-root"><div class="admin-card"><p class="helper-text" aria-busy="true">Loading reports…</p></div></div>';
  }

  function mountAdminReports(onFix) {
    var root = document.getElementById("reports-admin-root");
    if (!root || !store.listQuestionReports) return;
    Promise.resolve(store.listQuestionReports(reportsAdmin.status)).then(function (data) {
      reportsAdmin.data = data || { items: [], openTotal: 0 };
      var current = document.getElementById("reports-admin-root");
      if (current) renderAdminReports(current, onFix);
    }).catch(function (error) {
      var current = document.getElementById("reports-admin-root");
      if (current) current.innerHTML = '<div class="admin-card"><p class="helper-text">Couldn\'t load reports: ' + escapeHtml((error && error.message) || "network error") + '</p></div>';
    });
  }

  function renderAdminReports(root, onFix) {
    var data = reportsAdmin.data || { items: [], openTotal: 0 };
    var open = reportsAdmin.status === "open";
    var cards = data.items.map(function (item) {
      var q = item.question;
      var reasons = Object.keys(item.reasons).map(function (r) {
        return '<span class="meta-chip report-reason-chip is-' + r + '">' + escapeHtml(REPORT_REASON_LABELS[r] || r) + ' × ' + item.reasons[r] + '</span>';
      }).join("");
      var notes = item.reports.map(function (r) {
        return '<li><span class="report-who">' + escapeHtml(r.student) + '</span> · ' + escapeHtml(REPORT_REASON_LABELS[r.reason] || r.reason) + ' · <time>' + escapeHtml(formatDateOnly(r.createdAt)) + '</time>' +
          (r.note ? '<p>“' + escapeHtml(r.note) + '”</p>' : '') +
          (!open && r.resolutionNote ? '<p class="report-resolution">Resolved: ' + escapeHtml(r.resolutionNote) + '</p>' : '') + '</li>';
      }).join("");
      var options = q ? (q.options || []).map(function (o, i) {
        return '<li class="' + (i === q.correctOption ? 'is-correct' : '') + '"><span class="rich-text">' + formatRichText(o) + '</span>' + (i === q.correctOption ? ' <span class="import-correct">answer key</span>' : '') + '</li>';
      }).join("") : "";
      return '<article class="admin-card report-card" data-report-question="' + escapeAttribute(item.questionId) + '">' +
        '<div class="report-head">' +
        '<div><p class="section-label">' + (q ? escapeHtml(q.section + " · " + (q.topic || "")) : "Deleted question") + '</p>' +
        '<div class="report-tests">' + (q && q.tests.length ? q.tests.map(function (t) { return '<span class="meta-chip">' + escapeHtml(t.title) + '</span>'; }).join("") : '<span class="helper-text">Not in any test</span>') + '</div></div>' +
        '<p class="report-count"><strong>' + item.count + '</strong> ' + (item.count === 1 ? "report" : "reports") + '</p>' +
        '</div>' +
        '<div class="report-reasons">' + reasons + '</div>' +
        (q ? '<div class="rich-text report-prompt">' + formatRichText(q.prompt || "") + '</div><ol class="import-options" type="A">' + options + '</ol>' : '') +
        '<ul class="report-notes">' + notes + '</ul>' +
        (open
          ? '<div class="report-actions">' +
            (q && !q.deleted && q.tests.length ? '<button type="button" class="button button-secondary button-compact" data-report-fix="' + escapeAttribute(item.questionId) + '" data-test="' + escapeAttribute(q.tests[0].id) + '">Fix question</button>' : '') +
            '<label class="sr-only" for="resolve-note-' + escapeAttribute(item.questionId) + '">Resolution note</label>' +
            '<input id="resolve-note-' + escapeAttribute(item.questionId) + '" class="report-resolve-note" maxlength="300" placeholder="What did you do? (optional)">' +
            '<button type="button" class="button button-primary button-compact" data-report-resolve="' + escapeAttribute(item.questionId) + '">Resolve</button>' +
            '</div>'
          : '') +
        '</article>';
    }).join("");
    root.innerHTML =
      '<div class="admin-card reports-head">' +
      '<div><p class="section-label" style="margin:0;">12. Student reports</p>' +
      '<p class="helper-text" style="margin:4px 0 0;">Problems students flagged from their answer review, grouped by question. Fix the question, then resolve.</p></div>' +
      '<div class="reports-toggle" role="group" aria-label="Show">' +
      '<button type="button" class="button button-compact ' + (open ? 'button-primary' : 'button-secondary') + '" data-reports-status="open" aria-pressed="' + open + '">Open (' + data.openTotal + ')</button>' +
      '<button type="button" class="button button-compact ' + (!open ? 'button-primary' : 'button-secondary') + '" data-reports-status="resolved" aria-pressed="' + !open + '">Resolved</button>' +
      '</div></div>' +
      '<p class="import-message is-success" role="status" tabindex="-1" data-reports-message>' + escapeHtml(reportsAdmin.message) + '</p>' +
      (cards || '<div class="admin-card"><p class="helper-text">' + (open ? "No open reports. Students can report a problem from any question in their answer review." : "Nothing resolved yet.") + '</p></div>');
    renderLatexInElement(root);
    reportsAdmin.message = "";
    root.querySelectorAll("[data-reports-status]").forEach(function (button) {
      button.addEventListener("click", function () {
        reportsAdmin.status = button.getAttribute("data-reports-status");
        mountAdminReports(onFix);
      });
    });
    root.querySelectorAll("[data-report-fix]").forEach(function (button) {
      button.addEventListener("click", function () { onFix(button.getAttribute("data-report-fix"), button.getAttribute("data-test")); });
    });
    root.querySelectorAll("[data-report-resolve]").forEach(function (button) {
      button.addEventListener("click", function () {
        var id = button.getAttribute("data-report-resolve");
        var note = (root.querySelector("#resolve-note-" + id) || {}).value || "";
        button.disabled = true;
        Promise.resolve(store.resolveQuestionReports(id, note)).then(function (res) {
          reportsAdmin.message = (res && res.resolved) + " report" + (res && res.resolved === 1 ? "" : "s") + " resolved.";
          runtime.reportCountsAt = 0; // refresh the counts behind the tab label and Paper Health
          mountAdminReports(onFix);
          window.setTimeout(function () { var m = document.querySelector("[data-reports-message]"); if (m) m.focus(); }, 300);
        }).catch(function (error) {
          button.disabled = false;
          window.alert((error && error.message) || "Couldn't resolve.");
        });
      });
    });
  }

  // ---- Studio → What's New: write, preview live, publish ------------------------------------
  var wnAdmin = { notes: [], editingId: "", draft: null, message: "", error: "" };

  function blankReleaseNote() {
    return { title: "", summary: "", items: [{ icon: "✨", title: "", body: "", href: "" }], imageUrl: "", ctaLabel: "", ctaHref: "", audience: "all" };
  }

  function buildAdminWhatsNewHtml() {
    return '<div class="wn-studio" id="wn-admin-root"><div class="admin-card"><p class="helper-text" aria-busy="true">Loading notes…</p></div></div>';
  }

  function mountAdminWhatsNew() {
    var root = document.getElementById("wn-admin-root");
    if (!root || !store.listReleaseNotes) return;
    Promise.resolve(store.listReleaseNotes()).then(function (notes) {
      wnAdmin.notes = notes || [];
      if (!wnAdmin.draft) {
        wnAdmin.editingId = "";
        wnAdmin.draft = blankReleaseNote();
      }
      var current = document.getElementById("wn-admin-root");
      if (current) renderAdminWhatsNew(current);
    }).catch(function (error) {
      var current = document.getElementById("wn-admin-root");
      if (current) current.innerHTML = '<div class="admin-card"><p class="helper-text">Couldn\'t load the notes: ' + escapeHtml((error && error.message) || "network error") + '</p></div>';
    });
  }

  function wnItemsEditorHtml(items) {
    return items.map(function (item, i) {
      var n = i + 1;
      return '<div class="wn-item-editor" data-wn-item="' + i + '">' +
        '<div class="field"><label for="wn-icon-' + i + '">Icon</label><input id="wn-icon-' + i + '" data-wn-field="icon" maxlength="16" value="' + escapeAttribute(item.icon || "") + '" placeholder="✨"></div>' +
        '<div class="field"><label for="wn-item-title-' + i + '">Item ' + n + ' title</label><input id="wn-item-title-' + i + '" data-wn-field="title" maxlength="60" value="' + escapeAttribute(item.title || "") + '"></div>' +
        '<div class="wn-item-tools">' +
        '<button type="button" class="button button-secondary button-compact" data-wn-move="-1" aria-label="Move item ' + n + ' up"' + (i === 0 ? ' disabled' : '') + '>↑</button>' +
        '<button type="button" class="button button-secondary button-compact" data-wn-move="1" aria-label="Move item ' + n + ' down"' + (i === items.length - 1 ? ' disabled' : '') + '>↓</button>' +
        '<button type="button" class="button button-secondary button-compact" data-wn-remove aria-label="Remove item ' + n + '"' + (items.length === 1 ? ' disabled' : '') + '>✕</button>' +
        '</div>' +
        '<div class="field wn-item-body"><label for="wn-item-body-' + i + '">Item ' + n + ' text (optional)</label><textarea id="wn-item-body-' + i + '" data-wn-field="body" rows="2" maxlength="240">' + escapeHtml(item.body || "") + '</textarea></div>' +
        '<div class="field wn-item-body"><label for="wn-item-href-' + i + '">Try it link (optional)</label><input id="wn-item-href-' + i + '" data-wn-field="href" maxlength="300" value="' + escapeAttribute(item.href || "") + '" placeholder="#exams/practice or https://…"></div>' +
        '</div>';
    }).join("");
  }

  function renderAdminWhatsNew(root) {
    var d = wnAdmin.draft;
    var editingNote = wnAdmin.notes.filter(function (n) { return n.id === wnAdmin.editingId; })[0] || null;
    var audienceLabel = { all: "All students", free: "Free students", paid: "Enrolled students" };
    var notesHtml = wnAdmin.notes.length
      ? '<ul class="wn-notes">' + wnAdmin.notes.map(function (n) {
          var published = n.status === "published";
          return '<li class="wn-note-row' + (n.id === wnAdmin.editingId ? ' is-editing' : '') + '">' +
            '<div><strong>' + escapeHtml(n.title) + '</strong><span class="wn-note-meta">' +
            '<span class="meta-chip ' + (published ? 'is-live' : 'is-draft') + '">' + (published ? 'Published ' + escapeHtml(formatNoteDate(n.publishedAt)) : 'Draft') + '</span> · ' + escapeHtml(audienceLabel[n.audience] || "All students") + '</span></div>' +
            '<div class="wn-note-actions">' +
            '<button type="button" class="button button-secondary button-compact" data-wn-edit="' + escapeAttribute(n.id) + '">Edit</button>' +
            '<button type="button" class="button button-secondary button-compact" data-wn-publish="' + escapeAttribute(n.id) + '" data-wn-to="' + (published ? "0" : "1") + '">' + (published ? "Unpublish" : "Publish") + '</button>' +
            '<button type="button" class="button button-danger button-compact" data-wn-delete="' + escapeAttribute(n.id) + '" aria-label="Delete ' + escapeAttribute(n.title) + '">Delete</button>' +
            '</div></li>';
        }).join("") + '</ul>'
      : '<p class="helper-text">No notes yet. Write the first one below: after you publish it, it pops up at every sign-in for 14 days.</p>';

    root.innerHTML =
      '<section class="admin-card" aria-labelledby="wn-admin-title">' +
      '<div class="button-row" style="justify-content:space-between;align-items:center;">' +
      '<p class="section-label" id="wn-admin-title" style="margin:0;">11. What\'s New</p>' +
      '<button type="button" class="button button-secondary button-compact" data-wn-new>+ New note</button>' +
      '</div>' +
      '<p class="helper-text">Published notes pop up each time someone signs in, for 14 days after publishing, and stay under “What\'s new” in the footer.</p>' +
      notesHtml +
      '<form class="wn-form" data-wn-form novalidate>' +
      '<h3 class="wn-form-title">' + (editingNote ? "Edit “" + escapeHtml(editingNote.title) + "”" : "New note") + '</h3>' +
      '<div class="field"><label for="wn-title">Title</label><input id="wn-title" data-wn-top="title" maxlength="80" required value="' + escapeAttribute(d.title) + '" placeholder="e.g. Practice papers are here"></div>' +
      '<div class="field"><label for="wn-summary">Summary (optional)</label><textarea id="wn-summary" data-wn-top="summary" rows="2" maxlength="280">' + escapeHtml(d.summary) + '</textarea></div>' +
      '<div class="grid-two">' +
      '<div class="field"><label for="wn-audience">Show to</label><select id="wn-audience" data-wn-top="audience">' +
      ["all", "free", "paid"].map(function (a) { return '<option value="' + a + '"' + (d.audience === a ? ' selected' : '') + '>' + audienceLabel[a] + '</option>'; }).join("") +
      '</select></div>' +
      '<div class="field"><label for="wn-image">Image link (optional, https)</label><input id="wn-image" data-wn-top="imageUrl" inputmode="url" value="' + escapeAttribute(d.imageUrl) + '" placeholder="https://…"></div>' +
      '<div class="field"><label for="wn-cta-label">Button text (optional)</label><input id="wn-cta-label" data-wn-top="ctaLabel" maxlength="30" value="' + escapeAttribute(d.ctaLabel) + '" placeholder="Try it"></div>' +
      '<div class="field"><label for="wn-cta-href">Button link</label><input id="wn-cta-href" data-wn-top="ctaHref" value="' + escapeAttribute(d.ctaHref) + '" placeholder="#exams/practice or https://…"></div>' +
      '</div>' +
      '<p class="section-label" style="margin:14px 0 8px;">Items (' + d.items.length + ' of 6)</p>' +
      '<div class="wn-items-editor" data-wn-items>' + wnItemsEditorHtml(d.items) + '</div>' +
      '<div class="button-row" style="margin-top:10px;"><button type="button" class="button button-secondary button-compact" data-wn-add' + (d.items.length >= 6 ? ' disabled' : '') + '>+ Add item</button></div>' +
      '<p class="import-message is-error" role="alert" data-wn-error>' + escapeHtml(wnAdmin.error) + '</p>' +
      '<p class="import-message is-success" role="status" data-wn-message>' + escapeHtml(wnAdmin.message) + '</p>' +
      '<div class="button-row" style="margin-top:12px;">' +
      '<button type="submit" class="button button-secondary" data-wn-save="draft">' + (editingNote ? "Save changes" : "Save draft") + '</button>' +
      (editingNote && editingNote.status === "published" ? '' : '<button type="button" class="button button-primary" data-wn-save="publish">Save &amp; publish</button>') +
      '<button type="button" class="button button-secondary" data-wn-try>Show me the pop-up</button>' +
      '</div>' +
      '</form>' +
      '</section>' +
      '<section class="admin-card" aria-labelledby="wn-preview-title">' +
      '<p class="section-label" id="wn-preview-title">Live preview</p>' +
      '<div class="wn-preview-frame"><section class="wn-card" data-wn-preview aria-label="Pop-up preview">' + buildWhatsNewCardHtml(wnPreviewNote(), "wn-preview-heading") + '</section></div>' +
      '</section>';
    bindAdminWhatsNew(root);
  }

  function wnPreviewNote() {
    var d = wnAdmin.draft;
    return {
      title: d.title || "Your title",
      summary: d.summary,
      items: d.items.map(function (i) { return { icon: i.icon, title: i.title || "Item title", body: i.body, href: i.href }; }),
      imageUrl: d.imageUrl,
      cta: d.ctaLabel && d.ctaHref ? { label: d.ctaLabel, href: d.ctaHref } : null,
      publishedAt: new Date().toISOString(),
    };
  }

  function bindAdminWhatsNew(root) {
    var form = root.querySelector("[data-wn-form]");
    var preview = root.querySelector("[data-wn-preview]");
    var refreshPreview = function () {
      if (preview) {
        preview.innerHTML = buildWhatsNewCardHtml(wnPreviewNote(), "wn-preview-heading");
        // A working copy of the deck: Next/Back and swiping work, links stay put.
        bindWhatsNewDeck(preview, {
          start: wnAdmin.previewIndex || 0,
          onIndex: function (i) { wnAdmin.previewIndex = i; },
          onDone: function () { wnAdmin.previewIndex = 0; refreshPreview(); },
          onLink: function (_a, event) { event.preventDefault(); },
        });
      }
    };
    refreshPreview();
    var rerender = function (focusSelector) {
      renderAdminWhatsNew(root);
      if (focusSelector) {
        var el = root.querySelector(focusSelector);
        if (el) el.focus();
      }
    };
    form.addEventListener("input", function (event) {
      var t = event.target;
      if (t.hasAttribute("data-wn-top")) wnAdmin.draft[t.getAttribute("data-wn-top")] = t.value;
      var itemEl = t.closest("[data-wn-item]");
      if (itemEl && t.hasAttribute("data-wn-field")) wnAdmin.draft.items[Number(itemEl.getAttribute("data-wn-item"))][t.getAttribute("data-wn-field")] = t.value;
      refreshPreview();
    });
    form.addEventListener("change", function (event) {
      if (event.target.id === "wn-audience") wnAdmin.draft.audience = event.target.value;
    });
    root.querySelector("[data-wn-new]").addEventListener("click", function () {
      wnAdmin.editingId = "";
      wnAdmin.draft = blankReleaseNote();
      wnAdmin.message = "";
      wnAdmin.error = "";
      rerender("#wn-title");
    });
    root.querySelector("[data-wn-add]").addEventListener("click", function () {
      if (wnAdmin.draft.items.length >= 6) return;
      wnAdmin.draft.items.push({ icon: "", title: "", body: "", href: "" });
      rerender("#wn-item-title-" + (wnAdmin.draft.items.length - 1));
    });
    Array.prototype.forEach.call(root.querySelectorAll("[data-wn-move], [data-wn-remove]"), function (button) {
      button.addEventListener("click", function () {
        var i = Number(button.closest("[data-wn-item]").getAttribute("data-wn-item"));
        var items = wnAdmin.draft.items;
        if (button.hasAttribute("data-wn-remove")) {
          items.splice(i, 1);
          rerender("#wn-item-title-" + Math.max(0, i - 1));
          return;
        }
        var j = i + Number(button.getAttribute("data-wn-move"));
        if (j < 0 || j >= items.length) return;
        var moved = items.splice(i, 1)[0];
        items.splice(j, 0, moved);
        rerender('[data-wn-item="' + j + '"] [data-wn-move="' + button.getAttribute("data-wn-move") + '"]:not([disabled]), #wn-item-title-' + j);
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll("[data-wn-edit]"), function (button) {
      button.addEventListener("click", function () {
        var note = wnAdmin.notes.filter(function (n) { return n.id === button.getAttribute("data-wn-edit"); })[0];
        if (!note) return;
        wnAdmin.editingId = note.id;
        wnAdmin.draft = { title: note.title, summary: note.summary, items: note.items.map(function (i) { return { icon: i.icon, title: i.title, body: i.body, href: i.href || "" }; }), imageUrl: note.imageUrl, ctaLabel: note.ctaLabel, ctaHref: note.ctaHref, audience: note.audience };
        wnAdmin.message = "";
        wnAdmin.error = "";
        rerender("#wn-title");
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll("[data-wn-publish]"), function (button) {
      button.addEventListener("click", async function () {
        button.disabled = true;
        try {
          var to = button.getAttribute("data-wn-to") === "1";
          await store.setReleaseNotePublished(button.getAttribute("data-wn-publish"), to);
          wnAdmin.message = to ? "Published. It pops up at every sign-in for 14 days." : "Unpublished.";
          wnAdmin.error = "";
          mountAdminWhatsNew();
        } catch (error) {
          wnAdmin.error = (error && error.message) || "That didn't work.";
          rerender();
        }
      });
    });
    Array.prototype.forEach.call(root.querySelectorAll("[data-wn-delete]"), function (button) {
      button.addEventListener("click", async function () {
        if (!window.confirm("Delete this note? It can't be undone.")) return;
        try {
          var id = button.getAttribute("data-wn-delete");
          await store.deleteReleaseNote(id);
          if (wnAdmin.editingId === id) { wnAdmin.editingId = ""; wnAdmin.draft = blankReleaseNote(); }
          wnAdmin.message = "Deleted.";
          wnAdmin.error = "";
          mountAdminWhatsNew();
        } catch (error) {
          wnAdmin.error = (error && error.message) || "Couldn't delete it.";
          rerender();
        }
      });
    });
    root.querySelector("[data-wn-try]").addEventListener("click", function () {
      showWhatsNew(wnPreviewNote(), { preview: true });
    });
    async function save(publish) {
      var d = wnAdmin.draft;
      var body = {
        title: d.title.trim(), summary: d.summary.trim(), audience: d.audience,
        imageUrl: d.imageUrl.trim(), ctaLabel: d.ctaLabel.trim(), ctaHref: d.ctaHref.trim(),
        items: d.items.map(function (i) { return { icon: (i.icon || "").trim(), title: (i.title || "").trim(), body: (i.body || "").trim(), href: (i.href || "").trim() }; }),
      };
      try {
        var saved = await store.saveReleaseNote(wnAdmin.editingId, body);
        if (publish) saved = await store.setReleaseNotePublished(saved.id, true);
        wnAdmin.editingId = saved.id;
        wnAdmin.error = "";
        wnAdmin.message = publish ? "Published. It pops up at every sign-in for 14 days." : "Saved.";
        mountAdminWhatsNew();
      } catch (error) {
        wnAdmin.message = "";
        wnAdmin.error = (error && error.message) || "Couldn't save the note.";
        var field = String((error && error.data && error.data.field) || "");
        rerender(field === "title" ? "#wn-title" : field === "imageUrl" ? "#wn-image" : field === "ctaHref" ? "#wn-cta-href" : field.indexOf("items") === 0 ? "#wn-item-title-0" : null);
      }
    }
    form.addEventListener("submit", function (event) { event.preventDefault(); save(false); });
    var publishBtn = root.querySelector('[data-wn-save="publish"]');
    if (publishBtn) publishBtn.addEventListener("click", function () { save(true); });
  }

  document.addEventListener("click", function (event) {
    var toggle = event.target && event.target.closest ? event.target.closest(".js-passage-toggle") : null;
    if (!toggle) return;
    var passage = document.getElementById(toggle.getAttribute("aria-controls"));
    if (!passage) return;
    var open = passage.classList.toggle("is-folded") === false;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "Show less" : "Show the full passage";
  });

  // Footer → "What's new": reopens the latest note at any time.
  document.addEventListener("click", function (event) {
    var link = event.target && event.target.closest ? event.target.closest(".js-whats-new") : null;
    if (!link || !store.getWhatsNew) return;
    Promise.resolve(store.getWhatsNew(true)).then(function (note) {
      if (note) showWhatsNew(note, { preview: false });
      else showWhatsNew({ title: "You're all caught up", summary: "New features and changes will show up here.", items: [{ icon: "✓", title: "Nothing new right now" }] }, { preview: true });
    }).catch(function () { });
  });

  // Studio → Import from Excel/CSV. Step 1: template + file (+ which test to add to). Step 2: a
  // preview of every row rendered as students will see it, with the problems per row; nothing is
  // saved until "Import N questions", which saves all the ready rows at once.
  function openQuestionImportDialog(target, onDone) {
    var testId = target && target.id ? String(target.id) : "";
    var hasTest = Boolean(testId) && target.status !== "practice";
    var body =
      '<div class="import-dialog" data-import-dialog>' +
      '<section class="import-step" aria-labelledby="import-step-1">' +
      '<h4 id="import-step-1">1. Fill the template</h4>' +
      '<p class="helper-text">One question per row. Maths works as in the editor: <code>$\\frac{1}{2}mv^2$</code> inline, <code>$$…$$</code> or <code>\\[…\\]</code> on its own line. Leave marks blank to use the section defaults.</p>' +
      '<div class="button-row">' +
      '<a class="button button-secondary button-compact" href="/api/admin/questions/import-template?format=xlsx" download data-import-template="xlsx">Template (.xlsx)</a>' +
      '<a class="button button-secondary button-compact" href="/api/admin/questions/import-template?format=csv" download data-import-template="csv">Template (.csv)</a>' +
      '</div>' +
      '</section>' +
      '<section class="import-step" aria-labelledby="import-step-2">' +
      '<h4 id="import-step-2">2. Check your sheet</h4>' +
      '<div class="field"><label for="import-file">Filled sheet (.xlsx or .csv, up to 500 questions)</label>' +
      '<input type="file" id="import-file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"></div>' +
      (hasTest
        ? '<fieldset class="import-target"><legend>Add the questions to</legend>' +
          '<label><input type="radio" name="import-target" value="test" checked> ' + escapeHtml(target.title || "This test") + ' (and the question bank)</label>' +
          '<label><input type="radio" name="import-target" value="bank"> The question bank only</label>' +
          '</fieldset>'
        : '<p class="helper-text">The questions go to the question bank. Attach them to a test from Questions Studio.</p>') +
      '<div class="button-row"><button class="button button-primary" type="button" data-import-check>Check sheet</button></div>' +
      '<p class="import-message is-error" role="alert" data-import-error hidden></p>' +
      '</section>' +
      '<div data-import-result></div>' +
      '</div>';
    var overlay = showAdminModal("Import questions from Excel/CSV", body, true);
    if (!overlay) return null;

    var fileInput = overlay.querySelector("#import-file");
    var checkBtn = overlay.querySelector("[data-import-check]");
    var errorEl = overlay.querySelector("[data-import-error]");
    var resultEl = overlay.querySelector("[data-import-result]");
    var preview = null;

    function chosenTestId() {
      if (!hasTest) return "";
      var picked = overlay.querySelector("input[name='import-target']:checked");
      return picked && picked.value === "test" ? testId : "";
    }

    function showError(message) {
      errorEl.textContent = message || "";
      errorEl.hidden = !message;
    }

    function optionsHtml(question) {
      return '<ol class="import-options" type="A">' + (question.options || []).map(function (option, index) {
        var correct = index === question.correctOption;
        return '<li class="' + (correct ? "is-correct" : "") + '"><span class="rich-text">' + formatRichText(option) + '</span>' +
          (correct ? ' <span class="import-correct">correct</span>' : "") + '</li>';
      }).join("") + '</ol>';
    }

    function rowHtml(row) {
      var q = row.question || {};
      var status = row.errors.length
        ? '<ul class="import-problems is-error">' + row.errors.map(function (e) { return '<li>' + escapeHtml(e) + '</li>'; }).join("") + '</ul>'
        : '<span class="import-ok">Ready</span>' + (row.warnings.length
          ? '<ul class="import-problems is-warning">' + row.warnings.map(function (w) { return '<li>' + escapeHtml(w) + '</li>'; }).join("") + '</ul>'
          : "");
      return '<tr class="' + (row.errors.length ? "has-errors" : row.warnings.length ? "has-warnings" : "") + '" data-import-row="' + row.row + '">' +
        '<th scope="row">' + row.row + '</th>' +
        '<td>' + escapeHtml(q.section || "—") + '</td>' +
        '<td>' + escapeHtml(q.topic || "—") + '</td>' +
        '<td class="import-question">' +
        (q.passage ? '<div class="rich-text import-passage">' + formatRichText(q.passage) + '</div>' : "") +
        '<div class="rich-text">' + formatRichText(q.prompt || "") + '</div>' + optionsHtml(q) + '</td>' +
        '<td class="import-status">' + status + '</td>' +
        '</tr>';
    }

    function sectionLine(counts) {
      return ["SUPR", "REAP"].filter(function (s) { return counts && counts[s]; }).map(function (s) { return s + " " + counts[s]; }).join(", ");
    }

    function renderPreview(data) {
      var s = data.summary;
      var parts = [s.ready + " ready"];
      if (s.withErrors) parts.push(s.withErrors + " with errors (skipped)");
      if (s.withWarnings) parts.push(s.withWarnings + " with warnings");
      var importLabel = s.ready === 1 ? "Import 1 question" : "Import " + s.ready + " questions";
      resultEl.innerHTML =
        '<section class="import-step" aria-labelledby="import-step-3">' +
        '<h4 id="import-step-3">3. Review and import</h4>' +
        '<p class="import-summary" tabindex="-1" data-import-summary>' + escapeHtml(parts.join(" · ")) + '</p>' +
        (s.withErrors ? '<p class="helper-text">Rows with errors won\'t be imported. Fix them in the sheet and check it again, or import the ready rows now.</p>' : "") +
        (data.notes && data.notes.length ? '<ul class="import-notes">' + data.notes.map(function (n) { return '<li>' + escapeHtml(n) + '</li>'; }).join("") + '</ul>' : "") +
        '<div class="import-table-wrap"><table class="import-table">' +
        '<thead><tr><th scope="col">Row</th><th scope="col">Section</th><th scope="col">Topic</th><th scope="col">Question and options</th><th scope="col">Status</th></tr></thead>' +
        '<tbody>' + data.rows.map(rowHtml).join("") + '</tbody></table></div>' +
        '<div class="button-row import-actions">' +
        (s.ready ? '<button class="button button-primary" type="button" data-import-commit>' + escapeHtml(importLabel) + '</button>' : "") +
        '</div>' +
        '<p class="import-message" role="status" tabindex="-1" data-import-status></p>' +
        '</section>';
      renderLatexInElement(resultEl);
      var summary = resultEl.querySelector("[data-import-summary]");
      if (summary) summary.focus();
      var commitBtn = resultEl.querySelector("[data-import-commit]");
      if (commitBtn) commitBtn.addEventListener("click", commit);
    }

    async function check() {
      showError("");
      var file = fileInput.files && fileInput.files[0];
      if (!file) {
        showError("Choose the filled .xlsx or .csv file first.");
        fileInput.focus();
        return;
      }
      checkBtn.disabled = true;
      checkBtn.textContent = "Checking…";
      resultEl.innerHTML = "";
      try {
        preview = await store.previewQuestionImport(file, chosenTestId());
        renderPreview(preview);
      } catch (error) {
        preview = null;
        showError((error && error.message) || "Could not read that file.");
      } finally {
        checkBtn.disabled = false;
        checkBtn.textContent = "Check sheet";
      }
    }

    async function commit() {
      if (!preview) return;
      var commitBtn = resultEl.querySelector("[data-import-commit]");
      var statusEl = resultEl.querySelector("[data-import-status]");
      var ready = preview.rows.filter(function (r) { return !r.errors.length; }).map(function (r) { return r.question; });
      var destination = chosenTestId();
      commitBtn.disabled = true;
      commitBtn.textContent = "Importing…";
      statusEl.classList.remove("is-error");
      statusEl.textContent = "";
      try {
        var done = await store.commitQuestionImport(ready, destination);
        var where = destination ? " to " + (target.title || "the test") : " to the question bank";
        statusEl.textContent = done.imported + (done.imported === 1 ? " question added" : " questions added") + where + " (" + sectionLine(done.bySection) + ").";
        statusEl.classList.add("is-success");
        commitBtn.remove();
        checkBtn.disabled = true;
        fileInput.disabled = true;
        preview = null;
        if (typeof onDone === "function") onDone(done);
        statusEl.focus();
      } catch (error) {
        var problems = error && error.data && error.data.problems;
        statusEl.classList.add("is-error");
        statusEl.textContent = problems && problems.length
          ? "Nothing was imported: row " + preview.rows.filter(function (r) { return !r.errors.length; })[problems[0].index].row + " — " + problems[0].errors[0] + "."
          : (error && error.message) || "Import failed; nothing was saved.";
        commitBtn.disabled = false;
        commitBtn.textContent = ready.length === 1 ? "Import 1 question" : "Import " + ready.length + " questions";
      }
    }

    checkBtn.addEventListener("click", check);
    fileInput.addEventListener("change", function () {
      showError("");
      resultEl.innerHTML = "";
      preview = null;
    });
    Array.prototype.forEach.call(overlay.querySelectorAll("input[name='import-target']"), function (radio) {
      radio.addEventListener("change", function () {
        if (preview) check(); // the section-limit notes depend on the destination
      });
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

  // A question's images with their exam display width (0 = Auto), paired by index so a dropped
  // invalid URL never shifts another image's width.
  function getQuestionFigures(question) {
    if (!question) return [];
    var urls = Array.isArray(question.imageUrls) && question.imageUrls.length
      ? question.imageUrls
      : (question.imageUrl ? [question.imageUrl] : []);
    var widths = Array.isArray(question.imageWidths) ? question.imageWidths : [];
    return urls.map(function (url, index) {
      return { url: safeImageUrl(url), width: Number(widths[index]) || 0 };
    }).filter(function (figure) { return figure.url; });
  }

  // Sized figures take that share of the column (phones: at least 70%, in the CSS).
  function figureSizeAttrs(width) {
    return width ? ' style="--fig-w: ' + Math.max(20, Math.min(100, Number(width))) + '%;"' : '';
  }

  // One renderer for the exam, every admin preview and the answer review, so what an admin
  // previews is exactly what students see.
  function renderQuestionFigures(question) {
    var figures = getQuestionFigures(question);
    if (!figures.length) {
      return "";
    }
    return (
      '<div class="question-figure-stack">' +
      figures.map(function (figure, index) {
        return '<button type="button" class="question-figure-button' + (figure.width ? ' figure-sized' : '') + '"' + figureSizeAttrs(figure.width) + ' data-open-image="' + escapeAttribute(figure.url) + '" aria-label="Open question image ' + (index + 1) + '"><img class="question-figure" loading="lazy" decoding="async" src="' + figure.url + '" alt="Figure ' + (index + 1) + '"></button>';
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
    var plannedTest = event.mockId && store.getTestById ? store.getTestById(event.mockId) : null;
    var quickAction = (options.showQuickStart && event.status !== "completed" && !(plannedTest && isTestNotOpenYet(plannedTest)))
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

  // ---- Studio question editor: images (add, replace, remove, reorder, size) ---------------
  // A working copy of the question's images lives in runtime.questionImageDraft. Files upload
  // as soon as they're picked (each thumbnail shows its own progress); nothing changes on the
  // server until the question is saved, and Save sends exactly this list.
  var QIMG_PRESETS = [[0, "Auto"], [35, "Small"], [55, "Medium"], [75, "Large"], [100, "Full width"]];

  function questionImageContext() {
    return runtime.adminEditingQuestionId ? "edit:" + runtime.adminEditingQuestionId : "new";
  }

  function ensureQuestionImageDraft(editingQuestion) {
    var context = questionImageContext();
    var draft = runtime.questionImageDraft;
    if (draft && draft.context === context) return draft;
    var urls = editingQuestion && Array.isArray(editingQuestion.imageUrls) ? editingQuestion.imageUrls : [];
    var widths = editingQuestion && Array.isArray(editingQuestion.imageWidths) ? editingQuestion.imageWidths : [];
    var nextKey = 1;
    runtime.questionImageDraft = {
      context: context,
      items: urls.map(function (url, index) {
        return { key: nextKey++, url: String(url || "").trim(), width: Number(widths[index]) || 0, busy: false, error: "" };
      }).filter(function (item) { return item.url; }),
      nextKey: nextKey,
      undo: null,
      notice: "",
      dirty: false,
      previewMode: "desktop"
    };
    return runtime.questionImageDraft;
  }

  // Save and cancel clear the image working copy; a switch of editing context keeps it (the copy
  // is keyed to the question being edited and rebuilds itself for another one).
  function resetPendingQuestionUploads(options) {
    runtime.pendingQuestionFileNames = [];
    runtime.pendingQuestionFiles = [];
    runtime.pendingUploadedQuestionImageUrls = [];
    runtime.questionUploadContext = "";
    if (!(options && options.keepImages)) runtime.questionImageDraft = null;
  }

  function qimgPresetFor(width) {
    var match = QIMG_PRESETS.find(function (preset) { return preset[0] === Number(width || 0); });
    return match ? String(match[0]) : "custom";
  }

  function buildQuestionImageManagerHtml() {
    var draft = runtime.questionImageDraft || { items: [], previewMode: "desktop" };
    var items = draft.items;
    var itemsHtml = items.map(function (item, index) {
      var n = index + 1;
      var thumb = item.busy && !item.url
        ? '<span class="qimg-busy" role="status">Uploading…</span>'
        : '<button type="button" class="qimg-thumb-btn" data-open-image="' + escapeAttribute(safeImageUrl(item.url)) + '" aria-label="Preview image ' + n + '">' +
          '<img src="' + safeImageUrl(item.url) + '" alt="Image ' + n + '">' +
          (item.busy ? '<span class="qimg-busy is-overlay" role="status">Replacing…</span>' : '') +
          '</button>';
      var preset = qimgPresetFor(item.width);
      var sizeHtml =
        '<div class="qimg-size">' +
        '<label for="qimg-size-' + item.key + '">Size in exam</label>' +
        '<select id="qimg-size-' + item.key + '" class="js-qimg-preset" data-key="' + item.key + '"' + (item.url ? '' : ' disabled') + '>' +
        QIMG_PRESETS.map(function (p) {
          return '<option value="' + p[0] + '"' + (preset === String(p[0]) ? ' selected' : '') + '>' + escapeHtml(p[1]) + (p[0] ? ' (' + p[0] + '%)' : '') + '</option>';
        }).join("") +
        '<option value="custom"' + (preset === "custom" ? ' selected' : '') + '>Custom</option>' +
        '</select>' +
        '<div class="qimg-range-row">' +
        '<input type="range" min="20" max="100" step="5" class="js-qimg-range" data-key="' + item.key + '" value="' + (item.width || 100) + '"' + (item.width ? '' : ' disabled') + ' aria-label="Image ' + n + ' width, percent of the question column">' +
        '<output class="qimg-range-value" id="qimg-range-value-' + item.key + '">' + (item.width ? item.width + '%' : 'Auto') + '</output>' +
        '</div>' +
        '</div>';
      return '<li class="qimg-item' + (item.busy ? ' is-busy' : '') + '">' +
        '<div class="qimg-thumb">' + thumb + '</div>' +
        '<div class="qimg-body">' +
        '<p class="qimg-name">Image ' + n + (item.url && isGoogleDriveImageLink(item.url) ? ' · Google Drive link' : '') + '</p>' +
        sizeHtml +
        '<div class="qimg-actions">' +
        '<button type="button" class="button button-secondary button-compact js-qimg-move" data-key="' + item.key + '" data-dir="-1"' + (index === 0 || item.busy ? ' disabled' : '') + ' aria-label="Move image ' + n + ' earlier">←</button>' +
        '<button type="button" class="button button-secondary button-compact js-qimg-move" data-key="' + item.key + '" data-dir="1"' + (index === items.length - 1 || item.busy ? ' disabled' : '') + ' aria-label="Move image ' + n + ' later">→</button>' +
        '<label class="button button-secondary button-compact qimg-file-btn' + (item.busy ? ' is-disabled' : '') + '">Replace' +
        '<input type="file" accept="image/*" class="js-qimg-replace" data-key="' + item.key + '"' + (item.busy ? ' disabled' : '') + ' aria-label="Replace image ' + n + '"></label>' +
        '<button type="button" class="button button-danger button-compact js-qimg-remove" data-key="' + item.key + '"' + (item.busy ? ' disabled' : '') + ' aria-label="Remove image ' + n + '">Remove</button>' +
        '</div>' +
        (item.error ? '<p class="qimg-error" role="alert">' + escapeHtml(item.error) + '</p>' : '') +
        '</div>' +
        '</li>';
    }).join("");
    var previewItems = items.filter(function (item) { return item.url; });
    return (
      '<div class="qimg-head">' +
      '<span class="qimg-label" id="qimg-label">Question images</span>' +
      '<span class="helper-text">Shown under the prompt, in this order. Changes apply when you save the question.</span>' +
      '</div>' +
      (items.length ? '<ul class="qimg-list" aria-labelledby="qimg-label">' + itemsHtml + '</ul>' : '<p class="helper-text qimg-empty">No images yet.</p>') +
      '<div class="qimg-add">' +
      '<label class="button button-secondary button-compact qimg-file-btn">Add images' +
      '<input type="file" accept="image/*" multiple class="js-qimg-add" aria-label="Add images to this question"></label>' +
      '<div class="qimg-link">' +
      '<label class="sr-only" for="qimg-link-input">Google Drive image link</label>' +
      '<input id="qimg-link-input" type="url" placeholder="Or paste a public Google Drive image link">' +
      '<button type="button" class="button button-secondary button-compact js-qimg-add-link">Add link</button>' +
      '</div>' +
      '</div>' +
      (draft.notice ? '<p class="qimg-notice" role="alert">' + escapeHtml(draft.notice) + '</p>' : '') +
      (draft.undo ? '<p class="qimg-undo">Image removed. <button type="button" class="link-button js-qimg-undo">Undo</button></p>' : '') +
      (previewItems.length
        ? '<div class="qimg-preview">' +
          '<div class="qimg-preview-head"><span>As students see it</span>' +
          '<div class="qimg-preview-modes" role="group" aria-label="Preview width">' +
          ['desktop', 'phone'].map(function (mode) {
            return '<button type="button" class="qimg-mode js-qimg-mode' + (draft.previewMode === mode ? ' is-active' : '') + '" data-mode="' + mode + '" aria-pressed="' + (draft.previewMode === mode ? 'true' : 'false') + '">' + (mode === 'desktop' ? 'Desktop' : 'Phone') + '</button>';
          }).join("") +
          '</div></div>' +
          '<div class="qimg-preview-frame is-' + draft.previewMode + '">' +
          '<div class="qimg-preview-prompt rich-text" id="qimg-preview-prompt"></div>' +
          renderQuestionFigures({ imageUrls: previewItems.map(function (i) { return i.url; }), imageWidths: previewItems.map(function (i) { return i.width; }) }) +
          '</div>' +
          '<p class="helper-text">On phones, a sized image is never narrower than 70% of the screen so it stays readable.</p>' +
          '</div>'
        : '') +
      '<p class="sr-only" id="qimg-live" aria-live="polite"></p>'
    );
  }

  function refreshQimgPreviewPrompt() {
    var target = document.getElementById("qimg-preview-prompt");
    var prompt = document.getElementById("question-prompt");
    if (!target) return;
    target.innerHTML = formatRichText(prompt ? prompt.value : "");
    renderLatexInElement(target);
  }

  function mountQuestionImageManager() {
    var root = document.getElementById("qimg-root");
    if (!root) return;
    var draft = runtime.questionImageDraft;
    var find = function (key) {
      return draft.items.find(function (item) { return item.key === Number(key); });
    };
    var announce = function (text) {
      var live = document.getElementById("qimg-live");
      if (live) live.textContent = text;
    };
    var redraw = function () {
      if (runtime.questionImageDraft !== draft || !document.body.contains(root)) return;
      var focusKey = document.activeElement && root.contains(document.activeElement)
        ? (document.activeElement.className.split(" ").filter(function (c) { return c.indexOf("js-qimg-") === 0; })[0] || "") + "|" + (document.activeElement.getAttribute("data-key") || document.activeElement.getAttribute("data-mode") || "")
        : "";
      root.innerHTML = buildQuestionImageManagerHtml();
      refreshQimgPreviewPrompt();
      if (focusKey) {
        var parts = focusKey.split("|");
        var again = parts[0] && root.querySelector("." + parts[0] + (parts[1] ? '[data-key="' + parts[1] + '"], .' + parts[0] + '[data-mode="' + parts[1] + '"]' : ""));
        if (again && !again.disabled) again.focus();
      }
    };
    var changed = function () {
      draft.dirty = true;
      draft.notice = "";
    };
    var upload = function (file) {
      return Promise.resolve(prepareQuestionUploadFiles([file])).then(function (prepared) {
        return store.uploadQuestionImages(prepared);
      }).then(function (urls) {
        if (!urls || !urls[0]) throw new Error("The upload returned no image.");
        return urls[0];
      });
    };

    root.addEventListener("click", function (event) {
      var target = event.target.closest ? event.target.closest("button") : null;
      if (!target || !root.contains(target)) return;
      if (target.hasAttribute("data-open-image")) {
        openImageLightbox(target.getAttribute("data-open-image"));
        return;
      }
      var key = target.getAttribute("data-key");
      if (target.classList.contains("js-qimg-move")) {
        var index = draft.items.indexOf(find(key));
        var to = index + Number(target.getAttribute("data-dir"));
        if (index < 0 || to < 0 || to >= draft.items.length) return;
        var moved = draft.items.splice(index, 1)[0];
        draft.items.splice(to, 0, moved);
        changed();
        draft.undo = null;
        announce("Image moved to position " + (to + 1) + ".");
        redraw();
      } else if (target.classList.contains("js-qimg-remove")) {
        var item = find(key);
        var at = draft.items.indexOf(item);
        if (at < 0) return;
        draft.items.splice(at, 1);
        changed();
        draft.undo = { item: item, index: at };
        announce("Image " + (at + 1) + " removed.");
        redraw();
        var undoButton = root.querySelector(".js-qimg-undo");
        if (undoButton) undoButton.focus();
      } else if (target.classList.contains("js-qimg-undo")) {
        if (!draft.undo) return;
        draft.items.splice(Math.min(draft.undo.index, draft.items.length), 0, draft.undo.item);
        draft.undo = null;
        changed();
        announce("Image restored.");
        redraw();
      } else if (target.classList.contains("js-qimg-add-link")) {
        var input = document.getElementById("qimg-link-input");
        var url = input ? String(input.value || "").trim() : "";
        if (!/^https?:\/\//i.test(url)) {
          draft.notice = "Paste a full link that starts with https://";
          redraw();
          return;
        }
        draft.items.push({ key: draft.nextKey++, url: url, width: 0, busy: false, error: "" });
        changed();
        draft.undo = null;
        announce("Image link added.");
        redraw();
      } else if (target.classList.contains("js-qimg-mode")) {
        draft.previewMode = target.getAttribute("data-mode") === "phone" ? "phone" : "desktop";
        redraw();
      }
    });

    root.addEventListener("change", function (event) {
      var target = event.target;
      if (target.classList.contains("js-qimg-preset")) {
        var item = find(target.getAttribute("data-key"));
        if (!item) return;
        item.width = target.value === "custom" ? (item.width || 55) : Number(target.value) || 0;
        changed();
        redraw();
      } else if (target.classList.contains("js-qimg-add")) {
        var files = Array.prototype.slice.call(target.files || []).filter(function (f) { return /^image\//.test(f.type); });
        target.value = "";
        files.forEach(function (file) {
          var item = { key: draft.nextKey++, url: "", width: 0, busy: true, error: "" };
          draft.items.push(item);
          changed();
          upload(file).then(function (url) {
            item.url = url;
            item.busy = false;
            announce(file.name + " added.");
          }).catch(function (error) {
            draft.items.splice(draft.items.indexOf(item), 1);
            draft.notice = "Couldn't upload " + file.name + ": " + (error && error.message ? error.message : "please try again") + ".";
          }).then(redraw);
        });
        draft.undo = null;
        redraw();
      } else if (target.classList.contains("js-qimg-replace")) {
        var replacing = find(target.getAttribute("data-key"));
        var file = target.files && target.files[0];
        target.value = "";
        if (!replacing || !file) return;
        replacing.busy = true;
        replacing.error = "";
        draft.undo = null;
        redraw();
        upload(file).then(function (url) {
          replacing.url = url;
          changed();
          announce("Image " + (draft.items.indexOf(replacing) + 1) + " replaced.");
        }).catch(function (error) {
          replacing.error = "Couldn't replace this image (" + (error && error.message ? error.message : "upload failed") + "). The current image is kept.";
        }).then(function () {
          replacing.busy = false;
          redraw();
        });
      }
    });

    // The slider updates the label at once and the preview after a short pause.
    var rangeTimer = null;
    root.addEventListener("input", function (event) {
      var target = event.target;
      if (!target.classList.contains("js-qimg-range")) return;
      var item = find(target.getAttribute("data-key"));
      if (!item) return;
      item.width = Number(target.value) || 100;
      changed();
      var out = document.getElementById("qimg-range-value-" + item.key);
      if (out) out.textContent = item.width + "%";
      window.clearTimeout(rangeTimer);
      rangeTimer = window.setTimeout(redraw, 150);
    });

    var promptInput = document.getElementById("question-prompt");
    if (promptInput) {
      var promptTimer = null;
      promptInput.addEventListener("input", function () {
        window.clearTimeout(promptTimer);
        promptTimer = window.setTimeout(refreshQimgPreviewPrompt, 250);
      });
    }
    refreshQimgPreviewPrompt();
  }

  function dedupeUrls(values) {
    return (values || []).map(function (value) {
      return String(value || "").trim();
    }).filter(Boolean).filter(function (value, index, items) {
      return items.indexOf(value) === index;
    });
  }

  // Unsaved or uploading question images: background refreshes must not redraw the editor.
  function hasPendingQuestionUploadState() {
    var draft = runtime.questionImageDraft;
    return !!(draft && (draft.dirty || draft.items.some(function (item) { return item.busy; })));
  }

  function isGoogleDriveImageLink(value) {
    return /drive\.google\.com|docs\.google\.com/i.test(String(value || ""));
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
  // ---- Scheduled tests: "Opens Sat 18 Oct, 10:00 IST" with a live countdown --------------
  function testOpensAt(test) {
    if (!test || test.status !== "scheduled") return null;
    var when = new Date(test.opensAt || test.publishAt || 0);
    return Number.isNaN(when.getTime()) ? null : when;
  }

  function isTestNotOpenYet(test) {
    var when = testOpensAt(test);
    return Boolean(when && when.getTime() > serverNowMs());
  }

  function serverNowMs() {
    try { return store.serverNow ? Number(store.serverNow()) || Date.now() : Date.now(); } catch (_e) { return Date.now(); }
  }

  function formatOpensAt(when) {
    try {
      return when.toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }) + " IST";
    } catch (_e) {
      return when.toISOString();
    }
  }

  function formatCountdown(ms) {
    var total = Math.max(0, Math.floor(ms / 1000));
    var d = Math.floor(total / 86400), h = Math.floor((total % 86400) / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
    if (d) return "in " + d + " d " + h + " h";
    if (h) return "in " + h + " h " + m + " m";
    return "in " + m + ":" + (sec < 10 ? "0" : "") + sec;
  }

  /** The note and button a scheduled test shows instead of "Start Test". */
  function scheduledCtaHtml(test, locked) {
    var when = testOpensAt(test);
    var noteId = "opens-" + String(test.id).replace(/[^\w-]/g, "");
    return (locked
      ? '<button class="button button-primary is-pseudo-disabled js-buy-series" data-id="' + escapeAttribute(test.id) + '" aria-describedby="' + noteId + '">Locked 🔒</button>'
      : '<button class="button button-primary" type="button" disabled aria-describedby="' + noteId + '">Opens soon</button>') +
      '<span class="test-opens" id="' + noteId + '" data-opens-at="' + escapeAttribute(when.toISOString()) + '">Opens ' + escapeHtml(formatOpensAt(when)) + ' · <span data-countdown>' + escapeHtml(formatCountdown(when.getTime() - serverNowMs())) + '</span></span>' +
      eventNoteHtml(test);
  }

  /** For a scheduled live event: the join window and results time under the countdown. */
  function eventNoteHtml(test) {
    var ev = test && test.event;
    if (!ev) return "";
    return '<span class="test-event-note"><span class="test-event-badge">Live event</span> join within ' + escapeHtml(String(ev.joinMinutes)) + ' min' +
      (ev.resultsAt ? ' · results ' + escapeHtml(formatOpensAt(new Date(ev.resultsAt))) : '') + '</span>';
  }

  /**
   * A live event that has opened: "Join" while the window is open, then "Joining closed" (or
   * your submitted status) until results are out. Null when the test isn't in that phase.
   */
  function eventCtaHtml(test, locked) {
    var ev = test && test.event;
    if (!ev || test.status !== "live" || !ev.joinClosesAt) return null;
    var now = serverNowMs();
    var closes = new Date(ev.joinClosesAt).getTime();
    var results = ev.resultsAt ? new Date(ev.resultsAt).getTime() : 0;
    if (results && results <= now) return null;
    var noteId = "event-" + String(test.id).replace(/[^\w-]/g, "");
    if (now < closes) {
      if (locked) return null;
      return '<button class="button button-primary js-open-instructions" data-id="' + escapeAttribute(test.id) + '" aria-describedby="' + noteId + '">Join live mock →</button>' +
        '<span class="test-opens is-live-event" id="' + noteId + '" data-opens-at="' + escapeAttribute(new Date(closes).toISOString()) + '"><span class="test-event-badge">Live now</span> joining closes in <span data-countdown>' + escapeHtml(formatCountdown(closes - now)) + '</span></span>';
    }
    var user = auth.getCurrentUser ? auth.getCurrentUser() : null;
    var mine = user ? store.listUserAttempts(user.id).filter(function (a) { return a.testId === test.id && a.status === "submitted"; })[0] : null;
    var resultsNote = '<span class="test-opens" id="' + noteId + '"' + (results ? ' data-opens-at="' + escapeAttribute(new Date(results).toISOString()) + '"' : '') + '>Results ' + (results ? escapeHtml(formatOpensAt(new Date(results))) + ' · <span data-countdown>' + escapeHtml(formatCountdown(results - now)) + '</span>' : 'soon') + '</span>';
    return mine
      ? '<button class="button button-secondary js-open-result" data-id="' + escapeAttribute(mine.id) + '" aria-describedby="' + noteId + '">Submitted ✓</button>' + resultsNote
      : '<button class="button button-primary" type="button" disabled aria-describedby="' + noteId + '">Joining closed</button>' + resultsNote;
  }

  // One shared ticker, running only while a countdown is on screen. At zero the page refreshes
  // so the Start button appears.
  var opensTicker = 0;
  function armOpensCountdown() {
    if (opensTicker) return;
    if (!document.querySelector("[data-opens-at]")) return;
    opensTicker = window.setInterval(function () {
      var nodes = document.querySelectorAll("[data-opens-at]");
      if (!nodes.length) {
        window.clearInterval(opensTicker);
        opensTicker = 0;
        return;
      }
      if (document.hidden) return;
      var due = false;
      nodes.forEach(function (node) {
        var left = new Date(node.getAttribute("data-opens-at")).getTime() - serverNowMs();
        var label = node.querySelector("[data-countdown]");
        if (left <= 0) due = true;
        else if (label) label.textContent = formatCountdown(left);
      });
      if (due) {
        window.clearInterval(opensTicker);
        opensTicker = 0;
        syncAndRenderCurrentRoute({ navigation: true });
      }
    }, 1000);
  }

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
    var target = "#/" + path;
    if (window.location.hash === target) {
      syncAndRenderCurrentRoute({ navigation: true });
    } else {
      window.location.hash = target;
    }
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
    var shellUser = auth.getCurrentUser ? auth.getCurrentUser() : (store.getCurrentUser ? store.getCurrentUser() : null);
    var footerHtml = options.hideFooter
      ? ""
      : ('<div class="' + footerClass + '">' + escapeHtml(footerText) +
        '<span class="app-footer-sep"> · </span><span class="app-footer-links">' +
        '<a href="/privacy.html" target="_blank" rel="noopener">Privacy</a>' +
        ' · <a href="/terms.html" target="_blank" rel="noopener">Terms</a>' +
        ' · <a href="mailto:support@aceiiit.com">Support</a>' +
        (shellUser ? ' · <button type="button" class="app-footer-link js-whats-new">What\'s new</button>' : '') +
        '</span></div>');
    // The one floating help button: it opens ACEIIIT Mentor (WhatsApp support is linked inside).
    var currentUser = shellUser;
    var mentorOpen = Boolean(mentorState && mentorState.open);
    var supportChatHtml = options.hideSupportChat || !currentUser
      ? ""
      : (
        '<button type="button" class="support-chat-button js-mentor-toggle' + (mentorOpen ? ' is-morphed" inert="' : '') + '" aria-haspopup="dialog" aria-expanded="' + (mentorOpen ? "true" : "false") + '"' +
        (mentorState && mentorState.el ? ' aria-controls="mentor-panel"' : '') + ' aria-label="ACEIIIT Mentor: ask about your performance">' +
        '<span class="support-chat-icon" aria-hidden="true"><img src="assets/favicon-current.jpeg" alt=""></span>' +
        '<span class="support-chat-copy" aria-hidden="true"><strong>ACEIIIT Mentor</strong><small>Ask about your performance</small></span>' +
        '</button>'
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

  // The AceIIIT wordmark, as on the main AceIIIT site's navbar: "Ace" in ink, "IIIT" in gold, a
  // slow shine across both and the small red arrow. The round logo stays as it is.
  var ACEIIIT_ARROW_SVG = '<svg class="logo-arrow" aria-hidden="true" focusable="false" viewBox="840 260 115 145" fill="none"> <path class="arrow-part-1" d="M 951.77 263.19 C951.28,264.65 949.61,265.28 948.69,264.35 C947.38,263.05 948.01,262.00 950.08,262.00 C951.25,262.00 951.99,262.52 951.77,263.19 ZM 894.36 291.50 C894.05,292.33 893.16,293.00 892.39,293.00 C891.63,293.00 891.00,292.33 891.00,291.50 C891.00,290.67 891.89,290.00 892.97,290.00 C894.31,290.00 894.75,290.48 894.36,291.50 ZM 940.78 401.15 C940.54,401.89 939.53,402.66 938.55,402.85 C937.41,403.07 936.93,402.71 937.22,401.85 C937.46,401.11 938.47,400.34 939.45,400.15 C940.59,399.93 941.07,400.29 940.78,401.15 ZM 936.00 395.50 C936.00,396.33 935.33,397.00 934.50,397.00 C933.67,397.00 933.00,396.33 933.00,395.50 C933.00,394.67 933.67,394.00 934.50,394.00 C935.33,394.00 936.00,394.67 936.00,395.50 Z" fill="rgb(167,167,167)" /> <path class="arrow-part-2" d="M 901.00 382.26 C901.00,384.25 900.57,386.15 900.04,386.47 C898.81,387.24 895.76,381.39 895.36,377.50 C894.12,365.49 892.65,361.39 888.87,359.43 C886.82,358.37 886.07,357.37 886.44,356.19 C887.24,353.67 883.61,348.41 879.12,345.57 C876.94,344.20 874.85,342.12 874.48,340.95 C873.96,339.31 873.31,338.98 871.65,339.50 C870.47,339.88 868.26,340.42 866.74,340.71 C863.02,341.41 862.63,342.38 864.53,346.06 C866.41,349.69 866.23,350.02 862.37,350.30 C859.51,350.50 859.50,350.49 859.74,345.00 C859.88,341.98 860.03,338.38 860.08,337.02 C860.14,335.63 859.37,333.99 858.34,333.31 C852.41,329.37 852.29,329.17 854.69,327.14 C855.90,326.11 858.82,324.97 861.19,324.59 C863.56,324.22 867.24,322.71 869.36,321.24 C872.78,318.88 874.06,318.60 880.46,318.79 C886.52,318.97 888.46,318.60 892.40,316.50 C897.81,313.63 901.83,313.35 906.09,315.55 C910.02,317.58 910.69,319.64 911.45,332.07 C911.80,337.81 912.58,344.19 913.20,346.25 C914.20,349.60 914.04,350.52 911.66,354.88 C910.20,357.57 909.00,360.62 909.00,361.65 C909.00,364.74 905.21,374.15 903.03,376.47 C901.76,377.82 901.00,379.99 901.00,382.26 Z" fill="rgb(168,36,40)" /> <path class="arrow-part-3" d="M 925.91 395.61 C923.87,398.06 922.00,397.05 922.00,393.50 C922.00,392.31 921.70,391.03 921.33,390.66 C920.96,390.29 920.61,388.92 920.55,387.62 C920.46,385.65 920.72,385.44 922.12,386.31 C924.87,388.02 927.29,393.95 925.91,395.61 ZM 940.87 305.34 C941.71,306.36 941.44,307.14 939.74,308.64 C937.12,310.93 932.51,310.71 933.42,308.34 C933.74,307.51 934.00,306.20 934.00,305.42 C934.00,303.58 939.36,303.52 940.87,305.34 ZM 859.93 310.35 C859.70,310.56 856.35,311.02 852.50,311.38 C844.73,312.10 845.13,310.89 853.32,308.92 C856.85,308.08 858.46,308.06 859.26,308.86 C859.87,309.47 860.17,310.14 859.93,310.35 ZM 924.00 301.12 C924.00,302.28 921.89,302.22 920.00,301.00 C919.17,300.47 917.49,300.02 916.25,300.02 C913.26,299.99 913.37,298.20 916.41,297.43 C918.82,296.83 924.00,299.34 924.00,301.12 ZM 868.32 299.75 C868.55,300.16 868.47,301.26 868.12,302.18 C867.65,303.46 867.08,303.63 865.75,302.88 C863.40,301.56 863.52,299.00 865.94,299.00 C867.01,299.00 868.08,299.34 868.32,299.75 ZM 883.00 302.00 C882.17,302.53 880.38,302.97 879.00,302.97 C877.02,302.97 876.81,302.77 878.00,302.00 C878.83,301.47 880.62,301.03 882.00,301.03 C883.98,301.03 884.19,301.23 883.00,302.00 Z" fill="rgb(194,84,83)" /> </svg>';

  // The arrow assembles once per page load, not on every route change (the header re-renders).
  var wordmarkSettled = false;

  function aceiiitWordmarkHtml() {
    window.setTimeout(function () { wordmarkSettled = true; }, 1500);
    return '<span class="aceiiit-logo"><span class="logo-ace">Ace</span><span class="logo-iiit">IIIT' + ACEIIIT_ARROW_SVG + '</span></span>';
  }

  var THEME_ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  var THEME_ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><circle cx="12" cy="12" r="4"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>';

  function getThemeToggleMarkup() {
    var effectiveTheme = getEffectiveTheme();
    var nextThemeLabel = effectiveTheme === "dark" ? "Switch to light mode" : "Switch to dark mode";
    var icon = effectiveTheme === "dark" ? THEME_ICON_SUN : THEME_ICON_MOON;
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
      '<header class="dashboard-header' + (wordmarkSettled ? ' wordmark-settled' : '') + '">' +
      '<div class="dashboard-header-inner">' +
      '<div class="brand-group">' +
      '<a href="#dashboard" class="brand-mark has-wordmark" aria-label="AceIIIT dashboard"><img src="assets/favicon-round.svg" alt="" class="brand-logo" /> ' + aceiiitWordmarkHtml() + '</a>' +
      '</div>' +
      '<nav class="primary-nav-links" aria-label="Main Navigation">' +
      navLinksHtml +
      '</nav>' +
      '<div class="button-row" style="align-items: center;">' +
      (user ? '<span class="meta-chip user-chip header-account-control" style="margin-right: 4px;">' + escapeHtml(name) + '</span>' : '') +
      (user && auth.isAdmin(user) ? '<button class="button button-secondary button-compact header-account-control" id="admin-link">Builder Mode</button>' : '') +
      (user ? '<button type="button" class="header-search js-quick-search" aria-label="Search the portal" aria-keyshortcuts="Control+K Meta+K">' + QUICK_SEARCH_ICON + '<span class="header-search-label">Search</span><kbd class="header-search-kbd">' + (isMacLike() ? '⌘' : 'Ctrl') + ' K</kbd></button>' : '') +
      '<span class="header-account-control">' + getThemeToggleMarkup() + '</span>' +
      (user ? '<button class="button button-secondary button-compact header-account-control" id="logout-button">Logout</button>' : '') +
      '<button class="mobile-drawer-toggle js-toggle-mobile-drawer" type="button" aria-label="Open navigation menu" aria-controls="mobile-nav-drawer" aria-expanded="false">☰</button>' +
      '</div>' +
      '</div>' +
      '</header>' +
      '<div class="mobile-nav-drawer" id="mobile-nav-drawer" role="dialog" aria-modal="true" aria-labelledby="mobile-drawer-title" aria-hidden="true" inert>' +
      '<div class="mobile-drawer-head">' +
      '<span class="brand-mark has-wordmark" id="mobile-drawer-title" aria-label="AceIIIT menu"><img src="assets/favicon-round.svg" alt="" class="brand-logo" /> ' + aceiiitWordmarkHtml() + '</span>' +
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
      '</div>' +
      (user ? buildBottomTabbar(activeView) : '')
    );
  }

  // Phones: the four main sections at thumb reach, plus More (the full menu). The active marker
  // slides from the previous tab to the new one.
  var lastTabbarIndex = -1;
  function buildBottomTabbar(activeView) {
    var tabs = [
      { id: "dashboard", label: "Home", hash: "#dashboard", icon: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/>' },
      { id: "exams", label: "Exams", hash: "#exams", icon: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>' },
      { id: "progress", label: "Progress", hash: "#progress", icon: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>' },
      { id: "resources", label: "Resources", hash: "#resources", icon: '<path d="M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5"/>' }
    ];
    var index = tabs.map(function (t) { return t.id; }).indexOf(activeView);
    var from = lastTabbarIndex >= 0 && index >= 0 ? lastTabbarIndex : index;
    lastTabbarIndex = index;
    window.requestAnimationFrame(function () {
      document.body.classList.toggle("has-tabbar", Boolean(document.querySelector(".bottom-tabbar")));
      var marker = document.querySelector(".bottom-tabbar .tabbar-marker");
      if (marker && index >= 0) window.requestAnimationFrame(function () { marker.style.setProperty("--i", String(index)); });
    });
    return '<nav class="bottom-tabbar" aria-label="Sections">' +
      '<span class="tabbar-marker" aria-hidden="true" style="--i:' + Math.max(0, from) + ';' + (index < 0 ? 'opacity:0;' : '') + '"></span>' +
      tabs.map(function (t) {
        var active = t.id === activeView;
        return '<a class="tabbar-item' + (active ? ' is-active' : '') + '" href="' + t.hash + '"' + (active ? ' aria-current="page"' : '') + '>' +
          '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + t.icon + '</svg>' +
          '<span>' + t.label + '</span></a>';
      }).join("") +
      '<button type="button" class="tabbar-item js-toggle-mobile-drawer" aria-label="More: open the full menu" aria-controls="mobile-nav-drawer" aria-expanded="false">' +
      '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M4 7h16M4 12h16M4 17h16"/></svg><span>More</span></button>' +
      '</nav>';
  }

  // ---- Quick search (Ctrl/⌘ K) ------------------------------------------------------------------
  // Jumps to any page, test, result, study area or (for admins) Studio tab. Opened by keyboard
  // hundreds of times a day, so it appears instantly: no open or close animation.
  var QUICK_SEARCH_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

  function isMacLike() {
    return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");
  }

  function quickSearchItems(user) {
    var items = [];
    var page = function (label, hint, hash, keywords) { items.push({ group: "Pages", label: label, hint: hint, keywords: keywords || "", run: function () { navigate(hash.replace(/^#/, "")); } }); };
    page("Dashboard", "Home", "#dashboard", "home next up");
    page("Mock tests", "Exams", "#exams/mock-tests", "mocks catalogue start");
    page("Practice", "Exams", "#exams/practice", "custom practice mistakes builder");
    page("Live tests", "Exams", "#exams/live-tests", "scheduled live event");
    page("Performance", "Progress", "#progress/performance", "stats accuracy donut score trend");
    page("Reports", "Progress", "#progress/reports", "results history compare");
    page("Bookmarks", "Resources", "#resources/bookmarks", "saved questions revise");
    page("Study material", "Resources", "#resources/materials", "notes pdf drive formula");
    page("Notices", "Updates", "#updates/notices", "announcements");
    page("Events and planner", "Updates", "#updates/events", "calendar reminders plan");
    page("Profile", "Account", "#account/profile", "name phone");
    page("Package", "Account", "#account/package", "plan payment buy series");
    page("Security", "Account", "#account/security", "password sessions delete");
    (store.getTests ? store.getTests() : []).filter(function (t) {
      return t && !t.isPractice && (t.status === "live" || t.status === "scheduled" || auth.isAdmin(user));
    }).forEach(function (t) {
      items.push({ group: "Tests", label: t.title, hint: t.status === "scheduled" ? "Opens " + formatOpensAt(new Date(t.publishAt || t.opensAt || 0)) : (t.isFree ? "Free mock" : "Paid mock"), keywords: t.subtitle || "", run: function () { navigate("instructions/" + t.id); } });
    });
    (store.listUserAttempts && user ? store.listUserAttempts(user.id) : []).filter(function (a) { return a.status === "submitted"; }).slice(0, 12).forEach(function (a) {
      var test = store.getTestById(a.testId);
      items.push({ group: "Your results", label: (test && test.title) || "Mock test", hint: (a.resultsPending ? "results pending" : a.result ? "score " + formatMarks(Number(a.result.score || 0)) : "") + " · " + formatDateOnly(a.submittedAt), keywords: "result report attempt", run: function () { navigate("results/" + a.id); } });
    });
    if (user && auth.isAdmin(user)) {
      [["setup", "Setup & basic info"], ["questions", "Questions Studio"], ["bank", "Question bank"], ["review", "Review & validate"], ["tests", "Existing tests"], ["payments", "User payments"], ["seasons", "Seasons"], ["audit", "Audit logs"], ["materials", "Study materials"], ["mentor", "ACEIIIT Mentor"], ["whatsnew", "What's new"], ["reports", "Student reports"]].forEach(function (tab) {
        items.push({ group: "Studio", label: tab[1], hint: "Studio", keywords: "admin " + tab[0], run: function () { runtime.adminStudioTab = tab[0]; navigate("admin"); if ((routeParts()[0] || "") === "admin") renderRoute(); } });
      });
    }
    return items;
  }

  /** Scores an item for the query (0 = no match): word starts beat substrings beat letters in order. */
  function quickSearchScore(item, query) {
    var q = query.trim().toLowerCase();
    if (!q) return 1;
    var label = item.label.toLowerCase();
    var hay = label + " " + String(item.hint || "").toLowerCase() + " " + String(item.keywords || "").toLowerCase();
    var words = q.split(/\s+/);
    if (words.every(function (w) { return hay.indexOf(w) !== -1; })) {
      if (label.indexOf(q) === 0) return 100;
      if (new RegExp("(^|\\s)" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(label)) return 80;
      return label.indexOf(words[0]) !== -1 ? 60 : 40;
    }
    var i = 0;
    for (var c = 0; c < label.length && i < q.length; c += 1) if (label[c] === q[i]) i += 1;
    return i === q.length ? 10 : 0;
  }

  var quickSearchCleanup = null;
  function openQuickSearch(trigger) {
    var user = auth.getCurrentUser ? auth.getCurrentUser() : null;
    if (!user || document.querySelector("[data-quick-search]")) return;
    if (isExamLikeRoute(routeParts()[0] || "")) return;
    var all = quickSearchItems(user);
    var overlay = document.createElement("div");
    overlay.className = "qs-overlay";
    overlay.setAttribute("data-quick-search", "true");
    overlay.innerHTML =
      '<div class="qs-panel" role="dialog" aria-modal="true" aria-label="Quick search">' +
      '<div class="qs-input-row">' + QUICK_SEARCH_ICON +
      '<input class="qs-input" type="text" role="combobox" aria-expanded="true" aria-controls="qs-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" placeholder="Search pages, tests, results…" aria-label="Search">' +
      '<kbd class="qs-esc">Esc</kbd></div>' +
      '<ul class="qs-list" id="qs-list" role="listbox" aria-label="Results"></ul>' +
      '<p class="qs-foot" aria-hidden="true"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close</p>' +
      '</div>';
    document.body.appendChild(overlay);
    var panel = overlay.querySelector(".qs-panel");
    var input = overlay.querySelector(".qs-input");
    var list = overlay.querySelector(".qs-list");
    var shown = [];
    var active = 0;

    function close() {
      if (quickSearchCleanup) { quickSearchCleanup(); quickSearchCleanup = null; }
      overlay.remove();
    }
    function choose(item) {
      close();
      if (item) item.run();
    }
    function paint() {
      var q = input.value;
      shown = all.map(function (item) { return { item: item, score: quickSearchScore(item, q) }; })
        .filter(function (x) { return x.score > 0; })
        .sort(function (a, b) { return b.score - a.score; })
        .slice(0, q.trim() ? 12 : 40)
        .map(function (x) { return x.item; });
      if (!q.trim()) shown.sort(function (a, b) { return ["Pages", "Tests", "Your results", "Studio"].indexOf(a.group) - ["Pages", "Tests", "Your results", "Studio"].indexOf(b.group); });
      active = Math.min(active, Math.max(0, shown.length - 1));
      var lastGroup = "";
      list.innerHTML = shown.length ? shown.map(function (item, i) {
        var header = item.group !== lastGroup ? '<li class="qs-group" role="presentation">' + escapeHtml(item.group) + '</li>' : '';
        lastGroup = item.group;
        return header + '<li class="qs-option' + (i === active ? ' is-active' : '') + '" role="option" id="qs-opt-' + i + '" data-qs-index="' + i + '" aria-selected="' + (i === active) + '">' +
          '<span class="qs-label">' + escapeHtml(item.label) + '</span><span class="qs-hint">' + escapeHtml(item.hint || "") + '</span></li>';
      }).join("") : '<li class="qs-empty" role="presentation">No matches. Try a test name, “practice” or “reports”.</li>';
      input.setAttribute("aria-activedescendant", shown.length ? "qs-opt-" + active : "");
      var current = list.querySelector(".qs-option.is-active");
      if (current) current.scrollIntoView({ block: "nearest" });
    }
    input.addEventListener("input", function () { active = 0; paint(); });
    input.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown") { event.preventDefault(); active = Math.min(shown.length - 1, active + 1); paint(); }
      else if (event.key === "ArrowUp") { event.preventDefault(); active = Math.max(0, active - 1); paint(); }
      else if (event.key === "Enter") { event.preventDefault(); choose(shown[active]); }
    });
    list.addEventListener("mousemove", function (event) {
      var option = event.target.closest && event.target.closest("[data-qs-index]");
      if (option && Number(option.getAttribute("data-qs-index")) !== active) { active = Number(option.getAttribute("data-qs-index")); paint(); }
    });
    list.addEventListener("click", function (event) {
      var option = event.target.closest && event.target.closest("[data-qs-index]");
      if (option) choose(shown[Number(option.getAttribute("data-qs-index"))]);
    });
    overlay.addEventListener("mousedown", function (event) { if (event.target === overlay) close(); });
    quickSearchCleanup = activateModalFocus(panel, { onEscape: close, initialFocusEl: input, returnFocusEl: trigger || document.activeElement });
    paint();
  }

  document.addEventListener("keydown", function (event) {
    if ((event.key === "k" || event.key === "K") && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
      if (isExamLikeRoute(routeParts()[0] || "")) return;
      event.preventDefault();
      if (!document.querySelector("[data-quick-search]")) openQuickSearch();
    }
  });
  document.addEventListener("click", function (event) {
    var trigger = event.target && event.target.closest ? event.target.closest(".js-quick-search") : null;
    if (trigger) openQuickSearch(trigger);
  });

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

    function renderCatalogRow(t, idx) {
      var numTag = (idx + 1 < 10 ? '0' + (idx + 1) : (idx + 1));
      var isLocked = isTestLocked(t, user);
      var cta = eventCtaHtml(t, isLocked) || (isTestNotOpenYet(t)
        ? scheduledCtaHtml(t, isLocked)
        : isLocked
        ? '<button class="button button-primary is-pseudo-disabled js-buy-series" data-id="' + t.id + '" aria-label="Test locked. Purchase or upgrade account to unlock ' + escapeAttribute(t.title) + '">Locked 🔒</button>'
        : '<button class="button button-primary js-open-instructions" data-id="' + t.id + '" aria-label="Start test ' + escapeAttribute(t.title) + '">Start Test →</button>');

      return (
        '<div class="dashboard-test-row exam-catalog-row">' +
        '<div class="exam-catalog-main">' +
        '<span class="editorial-num-tag">' + numTag + '</span>' +
        '<div class="exam-catalog-text">' +
        '<h3 class="exam-catalog-title">' + escapeHtml(t.title) + '</h3>' +
        '<div class="exam-catalog-meta-row">' +
        '<span class="meta-chip">' + escapeHtml(t.isFree ? "FREE MOCK" : "PAID MOCK") + '</span>' +
        '<span class="exam-catalog-meta">' + getTotalDuration(t) + ' MINS &bull; ' + (Number(t.questionCount || 0) || t.questionIds.length) + ' QUESTIONS</span>' +
        '</div>' +
        '</div>' +
        '</div>' +
        '<div class="exam-catalog-cta">' + cta + '</div>' +
        '</div>'
      );
    }

    var mockTestsListHtml = realTests.length
      ? realTests.map(renderCatalogRow).join("")
      : '<div class="portal-empty-card"><h4 class="portal-empty-title">No mock tests published yet</h4><p class="portal-empty-text">New papers appear here as soon as they go live.</p><a href="#exams/practice" class="button button-primary">Start a practice session</a></div>';

    var practiceHighlightsHtml = (function() {
      var attemptsByTest = {};
      snapshot.attempts.forEach(function (a) {
        if (!attemptsByTest[a.testId]) attemptsByTest[a.testId] = [];
        attemptsByTest[a.testId].push(a);
      });
      
      return practiceTests.length
        ? '<div class="attempt-list list-scroll-card practice-session-list">' + practiceTests.slice().reverse().map(function (t) {
            var attempts = attemptsByTest[t.id] || [];
            var inProgress = attempts.find(function (a) { return a.status === "in_progress"; });
            var submitted = attempts.find(function (a) { return a.status === "submitted"; });
            
            var statusHtml = inProgress ? '<span class="status-indicator is-live">IN PROGRESS</span>' : (submitted ? '<span class="status-indicator is-completed">COMPLETED</span>' : '<span class="status-indicator is-available">AVAILABLE</span>');
            var actionHtml = inProgress 
              ? '<button class="button button-primary button-compact js-resume-test" data-id="' + t.id + '" data-attempt="' + inProgress.id + '">Resume</button>'
              : (submitted ? '<button class="button button-secondary button-compact js-open-result" data-id="' + submitted.id + '">Report</button>' : '<button class="button button-primary button-compact js-open-instructions" data-id="' + t.id + '">Start</button>');
  
            return '<div class="attempt-item practice-session-row">' +
                   '<div class="practice-session-head">' +
                   '<strong>' + escapeHtml(t.title) + '</strong>' +
                   statusHtml +
                   '</div>' +
                   '<div class="meta-row practice-session-meta">' +
                   '<span class="meta-chip">' + escapeHtml(t.subtitle) + '</span>' +
                   '</div>' +
                   '<div class="button-row practice-session-actions">' + actionHtml + '</div>' +
                   '</div>';
          }).join("") + '</div>'
        : '<p class="pi-muted">Practice mode allows targeted topic drill without affecting your official UGEE benchmark ranks. Your generated practice sessions will appear here.</p>';
    })();

    // Generator and session list side by side under the full-width header, equal height.
    var practiceHtml = (
      '<section class="generator-card mistakes-card" data-mistakes-card aria-labelledby="mistakes-title">' +
      '<div class="mistakes-copy"><span class="section-label">PRACTISE YOUR MISTAKES</span>' +
      '<h3 id="mistakes-title">Questions you got wrong or skipped</h3>' +
      '<p class="helper-text" data-mistakes-status aria-live="polite">Checking your mocks…</p></div>' +
      '<div class="mistakes-controls" data-mistakes-controls hidden>' +
      '<div class="field"><label for="mistakes-section">Section</label><select id="mistakes-section"><option value="all">Both sections</option><option value="SUPR">SUPR only</option><option value="REAP">REAP only</option></select></div>' +
      '<div class="field"><label for="mistakes-count">Questions</label><select id="mistakes-count"></select></div>' +
      '<button type="button" class="button button-primary" id="start-mistakes-btn">Practise mistakes →</button>' +
      '</div>' +
      '</section>' +
      '<div class="practice-layout">' +
      '<div class="generator-card">' +
      '<span class="section-label">CUSTOM PRACTICE SESSION</span>' +
      '<h3 style="margin:4px 0 16px;">Configure Questions & Subject Focus</h3>' +
      '<form id="practice-gen-form" class="generator-form-grid">' +
      // Subjects are filled from the questions this student can actually practise (see below).
      '<div class="field"><label for="prac-subject">Subject Area</label><select id="prac-subject"><option value="all">All subjects</option><option value="SUPR">SUPR – all topics</option><option value="REAP">REAP – all topics</option></select></div>' +
      '<div class="field"><label for="prac-difficulty">Difficulty Level</label><select id="prac-difficulty"><option value="all">All levels</option><option value="easy">Easy</option><option value="medium" selected>Medium</option><option value="hard">Hard</option></select></div>' +
      '<div class="field"><label for="prac-count">Questions Count</label><select id="prac-count" aria-describedby="practice-availability">' + [5, 10, 15, 20, 25, 30].map(function (n) { return '<option value="' + n + '"' + (n === 15 ? ' selected' : '') + '>' + n + ' questions</option>'; }).join("") + '</select></div>' +
      '<div class="field"><label for="prac-timer">Timer Limit</label><select id="prac-timer"><option value="0">Untimed</option><option value="15">15 Minutes</option><option value="30" selected>30 Minutes</option><option value="45">45 Minutes</option></select></div>' +
      '<p class="helper-text practice-availability" id="practice-availability" role="status" aria-live="polite"></p>' +
      '<div class="button-row" style="grid-column:1 / -1; margin-top:12px;">' +
      '<button type="button" class="button button-primary" id="start-practice-btn">Start Practice Session →</button>' +
      '</div>' +
      '</form>' +
      '</div>' +
      '<aside class="generator-card practice-sessions-card">' +
      '<span class="section-label">YOUR PRACTICE SESSIONS</span>' +
      practiceHighlightsHtml +
      '</aside>' +
      '</div>'
    );

    // Live tests are the admin-scheduled papers (test.type "scheduled"), not a placeholder card.
    var scheduledTests = realTests.filter(function (t) { return t.type === "scheduled"; });
    var liveTestsHtml = scheduledTests.length
      ? scheduledTests.map(renderCatalogRow).join("")
      : '<div class="portal-empty-card"><h4 class="portal-empty-title">No live exams scheduled right now</h4><p class="portal-empty-text">Scheduled all-India mocks appear here when they are announced. Meanwhile, every published mock is open to attempt.</p><a href="#exams/mock-tests" class="button button-primary">Browse mock tests</a></div>';

    var activeContentHtml = subTab === "practice" ? practiceHtml : (subTab === "live-tests" ? liveTestsHtml : mockTestsListHtml);

    var shellHtml = '<div class="page-section-shell">';
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
    shellHtml += '</div>';

    app.innerHTML = buildShell(
      renderPrimaryNav("exams", user) + shellHtml,
      { fluid: true }
    );

    // A results-page "Practise SUPR/REAP" action preselects that section once.
    var practiceSubject = document.getElementById("prac-subject");
    if (practiceSubject && runtime.practicePreset) {
      var presetSubject = String(runtime.practicePreset.subject || "");
      if (practiceSubject.querySelector('option[value="' + presetSubject.replace(/"/g, "") + '"]')) practiceSubject.value = presetSubject;
      runtime.practicePreset = null;
    }

    // Practice builder: subjects come from the questions this student can practise. Students
    // never see how many questions exist: each subject only says the largest paper it can fill,
    // and sizes it can't fill are greyed out. Admins also see the counts. The server re-checks.
    (function bindPracticeOptions() {
      var subjectEl = document.getElementById("prac-subject");
      var difficultyEl = document.getElementById("prac-difficulty");
      var countEl = document.getElementById("prac-count");
      var availabilityEl = document.getElementById("practice-availability");
      var startEl = document.getElementById("start-practice-btn");
      if (!subjectEl || !difficultyEl || !countEl || !availabilityEl || !startEl || !store.getPracticeOptions) return;
      var options = null;

      function chosenSubject() {
        if (!options || !options.subjects) return null;
        return options.subjects.filter(function (s) { return s.value === subjectEl.value; })[0] || null;
      }

      function updateAvailability() {
        if (!options) return;
        var subject = chosenSubject();
        var maxSize = subject ? subject.maxSize : 0;
        if (!maxSize) {
          availabilityEl.textContent = options.subjects && options.subjects.length
            ? "This choice isn't available for practice yet. Try another subject."
            : "No practice questions for this difficulty yet. Try another level.";
          startEl.disabled = true;
          return;
        }
        var anyDisabled = false;
        Array.prototype.forEach.call(countEl.options, function (option) {
          var tooBig = Number(option.value) > maxSize;
          option.disabled = tooBig;
          if (tooBig) anyDisabled = true;
        });
        if (Number(countEl.value) > maxSize) countEl.value = String(maxSize);
        availabilityEl.textContent = anyDisabled ? "Larger sets aren't available for this choice yet." : "";
        startEl.disabled = false;
      }

      function renderSubjects() {
        var current = subjectEl.value;
        var subjects = options.subjects || [];
        var label = function (s) {
          var text = s.kind === "topic" ? formatTopicName(s.label) : s.label;
          return escapeHtml(text + (typeof s.count === "number" ? " (" + s.count + ")" : ""));
        };
        var html = subjects.filter(function (s) { return s.kind !== "topic"; }).map(function (s) {
          return '<option value="' + escapeAttribute(s.value) + '">' + label(s) + '</option>';
        }).join("");
        ["SUPR", "REAP"].forEach(function (section) {
          var topics = subjects.filter(function (s) { return s.kind === "topic" && s.section === section; });
          if (!topics.length) return;
          html += '<optgroup label="' + section + ' topics">' + topics.map(function (s) {
            return '<option value="' + escapeAttribute(s.value) + '">' + label(s) + '</option>';
          }).join("") + '</optgroup>';
        });
        subjectEl.innerHTML = html || '<option value="all">All subjects</option>';
        var keep = Array.prototype.some.call(subjectEl.options, function (option) { return option.value === current; });
        subjectEl.value = keep ? current : (subjectEl.options[0] ? subjectEl.options[0].value : "all");
        updateAvailability();
      }

      function load() {
        var difficulty = difficultyEl.value;
        Promise.resolve(store.getPracticeOptions(difficulty)).then(function (data) {
          if (!data || difficultyEl.value !== difficulty || !document.body.contains(subjectEl)) return;
          options = data;
          renderSubjects();
        }).catch(function () { });
      }

      subjectEl.addEventListener("change", updateAvailability);
      difficultyEl.addEventListener("change", load);
      load();
    })();

    // Mistake practice: the count of due questions, then a paper of them.
    (function () {
      var card = app.querySelector("[data-mistakes-card]");
      if (!card || !store.getMistakeOptions) return;
      var status = card.querySelector("[data-mistakes-status]");
      var controls = card.querySelector("[data-mistakes-controls]");
      var sectionEl = card.querySelector("#mistakes-section");
      var countEl = card.querySelector("#mistakes-count");
      var info = null;
      function fillSizes() {
        var due = !info ? 0 : sectionEl.value === "all" ? info.available : (info.bySection[sectionEl.value] || 0);
        var sizes = [5, 10, 15, 20, 25, 30].filter(function (n) { return n < due; }).concat(due <= 30 ? [due] : [30]);
        sizes = sizes.filter(function (n, i) { return n > 0 && sizes.indexOf(n) === i; });
        countEl.innerHTML = sizes.map(function (n) { return '<option value="' + n + '"' + (n === Math.min(10, due) ? ' selected' : '') + '>' + n + (n === due ? " (all)" : "") + '</option>'; }).join("");
        card.querySelector("#start-mistakes-btn").disabled = !due;
      }
      Promise.resolve(store.getMistakeOptions()).then(function (data) {
        info = data || { available: 0, bySection: {} };
        if (!card.isConnected) return;
        if (!info.available) {
          status.textContent = "Nothing to practise: every question you got wrong or skipped has since been answered correctly. Take a mock and come back.";
          card.classList.add("is-clear");
          return;
        }
        status.textContent = info.available + (info.available === 1 ? " question is" : " questions are") + " waiting (SUPR " + (info.bySection.SUPR || 0) + ", REAP " + (info.bySection.REAP || 0) + "). Get one right and it leaves the list.";
        controls.hidden = false;
        fillSizes();
      }).catch(function () { status.textContent = "Couldn't check your mistakes right now."; });
      sectionEl.addEventListener("change", fillSizes);
      card.querySelector("#start-mistakes-btn").addEventListener("click", function () {
        startMistakePractice(user, Number(countEl.value) || 10, sectionEl.value);
      });
    })();

    var pracBtn = document.getElementById("start-practice-btn");
    if (pracBtn) {
      pracBtn.addEventListener("click", function () {
        var subject = document.getElementById("prac-subject") ? document.getElementById("prac-subject").value : "all";
        var difficulty = document.getElementById("prac-difficulty") ? document.getElementById("prac-difficulty").value : "all";
        var countEl = document.getElementById("prac-count");
        var count = countEl ? parseInt(countEl.value, 10) || 15 : 15;
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
    subTab = subTab === "reports" ? "reports" : "performance";
    var snapshot = store.getDashboardSnapshot(user.id);
    var stats = summarizeAttempts(mockAttemptsOnly(snapshot.attempts));
    var newestFirst = stats.submitted.slice().reverse();
    var testTitle = function (attempt) {
      var test = store.getTestById ? store.getTestById(attempt.testId) : null;
      return (test && test.title) || "Practice session";
    };
    var emptyHtml =
      '<div class="portal-empty-card">' +
      '<h4 class="portal-empty-title">No reports yet</h4>' +
      '<p class="portal-empty-text">Submit a mock test and your scores, accuracy and section trends appear here.</p>' +
      '<a href="#exams/mock-tests" class="button button-primary">Browse mock tests</a>' +
      '</div>';
    var kpi = function (label, value) {
      return '<div class="progress-kpi"><strong class="metric-val">' + escapeHtml(value) + '</strong><span class="metric-label">' + escapeHtml(label) + '</span></div>';
    };

    var performanceHtml = !stats.count ? emptyHtml : (
      '<div class="progress-kpis">' +
      kpi("Mocks completed", String(stats.count)) +
      kpi("Average score", String(stats.averageScore)) +
      kpi("Best score", String(stats.bestScore)) +
      kpi("Average accuracy", stats.averageAccuracy + "%") +
      kpi("Best percentile", stats.bestPercentile ? stats.bestPercentile + "%ile" : "—") +
      kpi("Time per question", stats.secondsPerQuestion ? stats.secondsPerQuestion + "s" : "—") +
      '</div>' +
      '<div class="progress-row">' +
      '<section class="progress-card">' +
      '<p class="section-label">SCORE TREND</p>' +
      (stats.count > 1
        ? buildBarTrend(stats.submitted.slice(-10).map(function (a) { return Number(a.result.score) || 0; }), {
            max: Math.max(1, stats.bestScore),
            format: function (value) { return String(Math.round(value * 10) / 10); },
            label: "Score in your recent attempts, oldest to latest"
          }) + '<p class="pi-muted">Score per attempt, oldest → latest (last ' + Math.min(10, stats.count) + ').</p>'
        : '<p class="pi-muted">Your trend appears after your second submitted mock.</p>') +
      '</section>' +
      '<section class="progress-card">' +
      '<p class="section-label">SECTION ACCURACY</p>' +
      (stats.sections.length
        ? '<div class="progress-donuts">' + stats.sections.map(function (row) {
            var attempted = row.correct + row.wrong;
            var total = attempted + row.skipped;
            // Accuracy = correct / attempted; the ring shows every question, so skipping is visible too.
            return '<figure class="progress-donut">' +
              '<figcaption><strong>' + escapeHtml(row.key) + '</strong></figcaption>' +
              buildDonut([
                { label: "correct", value: row.correct, tone: "correct" },
                { label: "wrong", value: row.wrong, tone: "wrong" },
                { label: "skipped", value: row.skipped, tone: "skipped" }
              ], {
                className: "progress-donut-ring",
                // No answers yet means no accuracy, not 0%.
                centerValue: attempted ? row.accuracy + "%" : "—",
                centerLabel: attempted ? "accuracy" : "none answered",
                tipPrefix: row.key,
                ariaLabel: row.key + ": " + (attempted ? row.accuracy + "% accuracy. " : "no questions answered yet. ") + row.correct + " correct, " + row.wrong + " wrong, " + row.skipped + " skipped."
              }) +
              '<ul class="progress-donut-legend">' +
              '<li><i class="rs-dot is-correct" aria-hidden="true"></i><span>Correct</span><b>' + row.correct + '</b></li>' +
              '<li><i class="rs-dot is-wrong" aria-hidden="true"></i><span>Wrong</span><b>' + row.wrong + '</b></li>' +
              '<li><i class="rs-dot is-skipped" aria-hidden="true"></i><span>Skipped</span><b>' + row.skipped + '</b></li>' +
              '</ul>' +
              '<p class="progress-donut-note">' + attempted + ' of ' + total + ' attempted</p>' +
              '</figure>';
          }).join("") + '</div>'
        : '<p class="pi-muted">Section breakdowns appear for attempts submitted on the current scoring pipeline.</p>') +
      '</section>' +
      '</div>' +
      '<section class="progress-card progress-topic-note">' +
      '<div><p class="section-label">TOPIC ANALYSIS</p><p class="pi-muted">Topic-wise accuracy, net marks and priorities are worked out per paper in each report.</p></div>' +
      '<button type="button" class="button button-secondary js-open-result" data-id="' + escapeAttribute(newestFirst[0].id) + '">Open latest report →</button>' +
      '</section>'
    );

    var reportsHtml = !stats.count ? emptyHtml : (
      '<div class="comparison-table-wrap">' +
      '<table class="comparison-table reports-table">' +
      '<thead><tr><th>#</th><th>TEST</th><th>DATE</th><th>SCORE</th><th>ACCURACY</th><th>PERCENTILE</th><th><span class="sr-only">Action</span></th></tr></thead>' +
      '<tbody>' + newestFirst.map(function (a, idx) {
        return '<tr>' +
          '<td><strong>' + (stats.count - idx) + '</strong></td>' +
          '<td>' + escapeHtml(testTitle(a)) + '</td>' +
          '<td>' + escapeHtml(formatDateOnly(a.submittedAt)) + '</td>' +
          '<td><strong>' + escapeHtml(String(a.result.score)) + '</strong></td>' +
          '<td>' + escapeHtml(String(a.result.accuracy)) + '%</td>' +
          '<td>' + (Number(a.result.percentile) > 0 ? escapeHtml(String(a.result.percentile)) + '%ile' : '—') + '</td>' +
          '<td><button class="button button-secondary button-compact js-open-result" data-id="' + escapeAttribute(a.id) + '">View analysis</button></td>' +
          '</tr>';
      }).join("") + '</tbody>' +
      '</table>' +
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
      '<main>' + (subTab === "reports" ? reportsHtml : performanceHtml) + '</main>' +
      '</div>',
      { fluid: true }
    );

    app.querySelectorAll(".js-open-result").forEach(function (button) {
      button.addEventListener("click", function () {
        navigate("results/" + button.dataset.id);
      });
    });
    activateAnalysisAnimations(app);
  }

  function renderResources(user, subTab) {
    subTab = subTab || "bookmarks";
    var bookmarks = store.getBookmarks ? store.getBookmarks(user.id) : [];
    // Newest first: the question saved last is the one being revised now.
    bookmarks = bookmarks.slice().reverse();
    var bookmarkSections = bookmarks.reduce(function (list, b) {
      var key = String(b.section || "").toUpperCase();
      if (key && list.indexOf(key) === -1) list.push(key);
      return list;
    }, []);
    var bookmarkFilter = runtime.bookmarkSectionFilter && bookmarkSections.indexOf(runtime.bookmarkSectionFilter) !== -1
      ? runtime.bookmarkSectionFilter
      : "all";
    var visibleBookmarks = bookmarks.filter(function (b) {
      return bookmarkFilter === "all" || String(b.section || "").toUpperCase() === bookmarkFilter;
    });

    function renderBookmarkCard(b) {
      var options = Array.isArray(b.options) ? b.options : [];
      var hasAnswer = options.length && b.correctOption !== undefined && b.correctOption !== null && b.correctOption !== "";
      var correctIndex = Number(b.correctOption);
      var sourceBits = [];
      if (b.testTitle) sourceBits.push(escapeHtml(b.testTitle));
      if (b.questionNumber) sourceBits.push("Q" + escapeHtml(String(b.questionNumber)));
      var savedOn = b.createdAt ? "Saved " + escapeHtml(formatDateOnly(b.createdAt)) : "";
      var optionsHtml = options.length
        ? '<ol class="bookmark-options">' + options.map(function (option, index) {
          return '<li class="bookmark-option" data-correct="' + (hasAnswer && index === correctIndex ? "1" : "0") + '">' +
            '<span class="bookmark-option-letter" aria-hidden="true">' + String.fromCharCode(65 + index) + '</span>' +
            '<span class="rich-text">' + formatRichText(option) + '</span>' +
            '</li>';
        }).join("") + '</ol>'
        : "";
      var imagesHtml = (b.imageUrls || []).length
        ? '<div class="bookmark-images">' + b.imageUrls.map(function (url) {
          return '<button class="bookmark-image js-open-image-lightbox" type="button" data-url="' + escapeAttribute(url) + '" aria-label="View question image"><img src="' + escapeAttribute(url) + '" alt="Question diagram" loading="lazy"></button>';
        }).join("") + '</div>'
        : "";
      var answerHtml = (hasAnswer || b.explanation)
        ? '<details class="bookmark-solution">' +
          '<summary>Show answer &amp; solution</summary>' +
          (hasAnswer ? '<p class="bookmark-answer"><strong>Answer:</strong> Option ' + String.fromCharCode(65 + correctIndex) + '</p>' : '') +
          (b.explanation ? '<div class="rich-text bookmark-explanation">' + formatRichText(b.explanation) + '</div>' : '<p class="bookmark-muted">No solution was provided for this question.</p>') +
          '</details>'
        : "";
      return (
        '<article class="bookmark-card">' +
        '<header class="bookmark-meta">' +
        '<span class="meta-chip">' + escapeHtml([String(b.section || "").toUpperCase(), b.topic || "General"].filter(Boolean).join(" · ")) + '</span>' +
        (sourceBits.length ? '<span class="bookmark-source">' + sourceBits.join(" · ") + '</span>' : '') +
        (savedOn ? '<span class="bookmark-saved">' + savedOn + '</span>' : '') +
        '</header>' +
        // Long reading passages start folded so one bookmark doesn't fill the screen.
        (b.passage
          ? (String(b.passage).length > 360
            ? '<div class="rich-text bookmark-passage is-folded" id="bm-passage-' + escapeAttribute(String(b.id || "")) + '">' + formatRichText(b.passage) + '</div>' +
              '<button type="button" class="bookmark-passage-toggle js-passage-toggle" aria-expanded="false" aria-controls="bm-passage-' + escapeAttribute(String(b.id || "")) + '">Show the full passage</button>'
            : '<div class="rich-text bookmark-passage">' + formatRichText(b.passage) + '</div>')
          : '') +
        '<div class="rich-text bookmark-prompt">' + formatRichText(b.prompt || "Question prompt") + '</div>' +
        imagesHtml +
        optionsHtml +
        answerHtml +
        '<footer class="bookmark-actions">' +
        (b.attemptId ? '<button type="button" class="button button-secondary button-compact js-open-result" data-id="' + escapeAttribute(b.attemptId) + '">Open report</button>' : '') +
        '<button type="button" class="button button-ghost button-compact js-remove-bookmark" data-qid="' + escapeAttribute(b.id || "") + '">Remove</button>' +
        '</footer>' +
        '</article>'
      );
    }

    var latestReport = (store.getDashboardSnapshot ? store.getDashboardSnapshot(user.id).attempts : []).filter(function (a) {
      return a.status === "submitted" && a.result;
    }).sort(function (a, b) { return new Date(b.submittedAt) - new Date(a.submittedAt); })[0];
    var bookmarksEmptyHtml =
      '<div class="portal-empty-card">' +
      '<h4 class="portal-empty-title">No bookmarks yet</h4>' +
      '<p class="portal-empty-text">Open a submitted report, load the question review and tap Save on any question to revise it here.</p>' +
      (latestReport
        ? '<button type="button" class="button button-primary js-open-result" data-id="' + escapeAttribute(latestReport.id) + '">Open latest report</button>'
        : '<a href="#exams/mock-tests" class="button button-primary">Browse mock tests</a>') +
      '</div>';

    var bookmarksHtml = bookmarks.length
      ? '<div class="bookmark-toolbar">' +
        '<p class="bookmark-count">' + visibleBookmarks.length + (visibleBookmarks.length === 1 ? ' saved question' : ' saved questions') + '</p>' +
        (bookmarkSections.length > 1
          ? '<div class="test-filter-tabs" role="group" aria-label="Filter bookmarks by section">' +
            ["all"].concat(bookmarkSections).map(function (key) {
              return '<button type="button" class="filter-tab-btn js-bookmark-filter' + (bookmarkFilter === key ? ' is-active' : '') + '" data-filter="' + escapeAttribute(key) + '" aria-pressed="' + (bookmarkFilter === key) + '">' + escapeHtml(key === "all" ? "ALL" : key) + '</button>';
            }).join("") +
            '</div>'
          : '') +
        '</div>' +
        '<div class="bookmark-grid">' + visibleBookmarks.map(renderBookmarkCard).join("") + '</div>'
      : bookmarksEmptyHtml;

    // Study material (Google Drive, free for every signed-in student) mounts into its own root
    // after the page renders; the open folder is in the route: #resources/materials/<folderId>.
    var materialsHtml = '<div class="materials-browser" id="materials-browser"></div>';

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
    
    if (subTab === "materials") {
      mountMaterialsBrowser(document.getElementById("materials-browser"), {
        admin: false,
        folderId: routeParts()[2] ? decodeURIComponent(routeParts()[2]) : "",
        onOpenFolder: function (folderId) {
          navigate("resources/materials" + (folderId ? "/" + encodeURIComponent(folderId) : ""));
        }
      });
    }

    app.querySelectorAll(".js-bookmark-filter").forEach(function (btn) {
      btn.addEventListener("click", function () {
        runtime.bookmarkSectionFilter = btn.dataset.filter === "all" ? "" : btn.dataset.filter;
        renderResources(user, subTab);
      });
    });

    app.querySelectorAll(".js-remove-bookmark").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (store.removeBookmark) store.removeBookmark(user.id, btn.dataset.qid);
        if (typeof window.showSaveChip === "function") window.showSaveChip("Bookmark removed.");
        renderResources(user, subTab);
      });
    });

    app.querySelectorAll(".js-open-result").forEach(function (btn) {
      btn.addEventListener("click", function () {
        navigate("results/" + btn.dataset.id);
      });
    });

    app.querySelectorAll(".js-open-image-lightbox").forEach(function (btn) {
      btn.addEventListener("click", function () {
        openImageLightbox(btn.dataset.url);
      });
    });

    renderLatexInElement(app.querySelector(".page-section-shell main"));
  }

  function renderUpdates(user, subTab) {
    subTab = subTab || "notices";
    var appConfig = store.getAppConfig ? store.getAppConfig() : { noticeTitle: "", noticeBody: "" };
    var plannerEvents = store.getPlannerEvents ? store.getPlannerEvents(user.id) : [];

    var noticesHtml = (
      '<div class="updates-notice-list">' +
      '<div class="updates-notice-card">' +
      '<span class="meta-chip">IMPORTANT NOTICE</span>' +
      '<h3>' + escapeHtml(appConfig.noticeTitle || (targetExamLabel() + " Examination Portal Update")) + '</h3>' +
      '<p>' + escapeHtml(appConfig.noticeBody || "Official mock test series registrations are live. Complete all practice papers before final UGEE dates.") + '</p>' +
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
        var typed = window.prompt('This closes your account and signs you out everywhere. It is permanently deleted after 30 days, and your exam history is kept only in anonymized form.\n\nType DELETE MY ACCOUNT to confirm.');
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
    var examLabel = targetExamLabel();

    var profileHtml = (
      '<div class="account-panel">' +
      '<span class="section-label">STUDENT IDENTITY</span>' +
      '<h3 class="account-panel-title">' + escapeHtml(user.name) + '</h3>' +
      '<div class="account-identity-grid">' +
      '<div><strong>Email Address</strong><span>' + escapeHtml(user.email) + '</span></div>' +
      '<div><strong>Role</strong><span>' + escapeHtml(String(user.role || "student").toUpperCase()) + '</span></div>' +
      '<div><strong>Target Exam</strong><span>' + escapeHtml(examLabel) + '</span></div>' +
      '<div><strong>Account Status</strong><span class="meta-chip text-success">' + escapeHtml(user.status || "ACTIVE") + '</span></div>' +
      '</div>' +
      '</div>'
    );

    var included = user.isPaid
      ? ["Every full-length " + examLabel + " SUPR and REAP mock", "Unlimited custom practice sessions", "Rank, percentile and topic-wise analysis", "Question review with solutions and bookmarks"]
      : ["Free practice mocks", "One custom practice session", "Score, accuracy and question review on free mocks"];
    var packageHtml = (
      '<div class="account-panel-grid">' +
      '<div class="account-panel">' +
      '<span class="section-label">ACTIVE ENROLLMENT</span>' +
      '<h3 class="account-panel-title">' + (user.isPaid ? 'ACEIIIT PRO TEST SERIES' : 'ACEIIIT FREE TIER') + '</h3>' +
      '<p class="account-panel-text">' + (user.isPaid ? 'Full access is unlocked for all ' + escapeHtml(examLabel) + ' SUPR and REAP full-length mock papers and the detailed rank breakdown.' : 'Access is limited to free practice mocks. Upgrade to Pro for the full test series.') + '</p>' +
      (!user.isPaid ? '<a href="' + escapeAttribute(BUY_SERIES_URL) + '" target="_blank" rel="noopener" class="button button-primary account-panel-cta">Upgrade to Pro Series →</a>' : '') +
      '</div>' +
      '<div class="account-panel">' +
      '<span class="section-label">' + (user.isPaid ? 'INCLUDED IN YOUR PLAN' : 'INCLUDED FREE') + '</span>' +
      '<ul class="account-feature-list">' + included.map(function (item) { return '<li>' + escapeHtml(item) + '</li>'; }).join("") + '</ul>' +
      '</div>' +
      '</div>'
    );

    var securityHtml = (
      '<div class="account-panel-grid">' +
      '<div class="account-panel">' +
      '<span class="section-label">SECURITY & PASSWORD</span>' +
      '<h3 class="account-panel-title">' + (user.hasPassword ? 'Change Password' : 'Set a Password') + '</h3>' +
      '<form id="account-pwd-form" class="account-pwd-form">' +
      (user.hasPassword ? '<div class="field"><label for="pwd-current">Current Password</label><input type="password" id="pwd-current" required autocomplete="current-password"></div>' : '') +
      '<div class="field"><label for="pwd-new">New Password</label><input type="password" id="pwd-new" required minlength="8" autocomplete="new-password" aria-describedby="pwd-new-hint"><span class="helper-text" id="pwd-new-hint">At least 8 characters.</span></div>' +
      '<div class="button-row"><button type="submit" class="button button-primary" id="pwd-submit-btn">Update Password</button></div>' +
      '</form>' +
      '</div>' +
      '<div class="account-panel">' +
      '<span class="section-label">YOUR DATA & PRIVACY</span>' +
      '<h3 class="account-panel-title">Download or delete your data</h3>' +
      '<p class="account-panel-text">Download a copy of your profile, attempts, reminders, payments and exam records. See the <a href="/privacy.html" target="_blank" rel="noopener">privacy policy</a> and <a href="/terms.html" target="_blank" rel="noopener">terms</a>.</p>' +
      '<div class="button-row account-actions">' +
      '<button type="button" class="button button-secondary" id="account-export-btn">Download my data</button>' +
      '<button type="button" class="button button-secondary" id="account-logout-all-btn">Sign out of all devices</button>' +
      '</div>' +
      '<div class="account-danger-row">' +
      '<p class="account-panel-text"><strong>Delete account.</strong> Closes your account now and permanently deletes it after 30 days. Exam history is kept only in anonymized form.</p>' +
      '<button type="button" class="button button-danger" id="account-delete-btn">Delete my account</button>' +
      '</div>' +
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
    // The export / sign-out-everywhere / delete buttons live on this page; bind them here.
    bindAccountDataActions(user);
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

      qotdHtml = '<div class="rail-block qotd-block">' +
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
      qotdHtml = '<div class="rail-block qotd-block">' +
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

    var attemptStats = summarizeAttempts(mockAttemptsOnly(snapshot.attempts));

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
        : (eventCtaHtml(nextUpTest, isNextUpLocked) || isTestNotOpenYet(nextUpTest)
          ? (eventCtaHtml(nextUpTest, isNextUpLocked) || scheduledCtaHtml(nextUpTest, isNextUpLocked))
          : isNextUpLocked
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
        '<span class="editorial-num-tag"><svg class="editorial-traced-icon" xmlns="http://www.w3.org/2000/svg" width="72" height="90" viewBox="0 0 72 90"><g shape-rendering="geometricPrecision"><path fill="#f3e7d7" fill-rule="evenodd" d="M 13 28 13 46 14 47 14 48 17 51 54 51 54 28 Z M 43 46 44 45 51 45 52 46 52 47 51 48 44 48 43 47 Z M 23 46 24 45 31 45 32 46 32 47 31 48 24 48 23 47 Z M 36 43 37 42 40 42 41 43 41 46 40 47 37 47 36 46 Z M 16 43 17 42 20 42 21 43 21 46 20 47 17 47 16 46 Z M 43 42 44 41 51 41 52 42 52 43 51 44 44 44 43 43 Z M 23 42 24 41 31 41 32 42 32 43 31 44 24 44 23 43 Z M 43 36 44 35 51 35 52 36 52 37 51 38 44 38 43 37 Z M 23 36 24 35 31 35 32 36 32 37 31 38 24 38 23 37 Z M 36 33 37 32 40 32 41 33 41 36 40 37 37 37 36 36 Z M 16 33 17 32 20 32 21 33 21 36 20 37 17 37 16 36 Z M 43 32 44 31 51 31 52 32 52 33 51 34 44 34 43 33 Z M 23 32 24 31 31 31 32 32 32 33 31 34 24 34 23 33 Z"/><path fill="#929292" fill-rule="evenodd" d="M 62 21 60 21 59 20 55 20 55 23 59 23 60 24 60 55 59 56 25 56 26 57 27 57 28 58 29 58 30 59 31 59 32 60 32 59 33 58 34 58 35 59 35 61 38 61 39 62 47 62 48 63 60 63 61 62 62 62 62 61 63 60 63 24 62 23 Z M 12 20 8 20 7 21 5 21 5 28 6 29 6 32 7 33 7 34 7 24 8 23 12 23 Z"/><path fill="#68c06b" fill-rule="evenodd" d="M 38 18 37 17 36 18 36 19 38 19 Z M 13 12 13 14 14 15 14 17 15 18 15 19 16 20 16 21 18 23 18 15 19 14 24 14 25 16 24 17 21 17 21 18 24 18 25 19 25 20 24 21 21 21 21 22 24 22 25 23 25 24 24 25 21 25 22 25 23 26 25 26 26 27 54 27 54 12 Z M 42 14 43 14 45 16 45 17 46 17 46 16 48 14 49 14 50 15 50 24 49 25 48 25 47 24 47 23 46 24 45 24 44 23 44 24 43 25 42 25 41 24 41 15 Z M 35 14 39 14 41 16 41 24 40 25 39 25 38 24 38 22 36 22 36 24 35 25 34 25 33 24 33 16 Z M 26 14 28 14 29 15 29 16 29 15 30 14 32 14 33 15 33 16 32 17 32 18 31 19 31 20 32 21 32 22 33 23 33 24 32 25 30 25 29 24 29 23 29 24 28 25 26 25 25 24 25 23 26 22 26 21 27 20 27 19 26 18 26 17 25 16 25 15 Z"/><path fill="#94eafc" fill-rule="evenodd" d="M 59 25 58 24 55 24 55 51 54 52 19 52 21 54 22 54 23 55 58 55 59 54 Z M 9 24 8 25 8 38 9 39 9 40 11 42 11 43 12 44 12 24 Z"/><path fill="#686868" fill-rule="evenodd" d="M 4 28 4 60 7 63 39 63 36 63 35 62 33 62 32 61 30 61 29 60 28 60 27 59 26 59 24 57 23 57 22 56 8 56 7 55 7 38 6 37 6 35 5 34 5 32 4 31 Z"/><path fill="#606060" fill-rule="evenodd" d="M 44 46 44 47 51 47 51 46 Z M 24 46 24 47 31 47 31 46 Z M 44 42 44 43 51 43 51 42 Z M 24 42 24 43 31 43 31 42 Z M 44 36 44 37 51 37 51 36 Z M 24 36 24 37 31 37 31 36 Z M 44 32 44 33 51 33 51 32 Z M 24 32 24 33 31 33 31 32 Z"/><path fill="#494949" fill-rule="evenodd" d="M 23 71 44 71 39 66 39 65 38 64 29 64 29 65 Z"/><path fill="#5ed2f2" fill-rule="evenodd" d="M 8 40 8 54 9 55 21 55 20 55 17 52 13 52 12 51 12 46 10 44 10 43 8 41 Z"/><path fill="#fe8d3c" fill-rule="evenodd" d="M 37 43 37 46 40 46 40 43 Z M 17 43 17 46 20 46 20 43 Z M 37 33 37 36 40 36 40 33 Z M 17 33 17 36 20 36 20 33 Z"/><path fill="#57b15e" fill-rule="evenodd" d="M 13 15 13 27 25 27 23 27 22 26 21 26 20 25 19 25 15 21 15 20 14 19 14 18 13 17 Z"/><path fill="#ced9c4" fill-rule="evenodd" d="M 13 47 13 51 16 51 13 48 Z"/><path fill="#2e2e2e" fill-rule="evenodd" d="M 33 59 33 60 34 60 34 59 Z"/></g></svg></span>' +
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
      if (!test || (test.status !== "live" && test.status !== "scheduled")) return false;
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
        : eventCtaHtml(test, locked) || (isTestNotOpenYet(test)
        ? scheduledCtaHtml(test, locked)
        : '<button class="button button-primary js-open-instructions" data-id="' + test.id + '">Start Test &rarr;</button>');

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
        var stateLabel = !isSubmitted
          ? "In progress"
          : !attempt.result
            ? (attempt.resultsPending && attempt.resultsAt ? "Submitted · results " + formatOpensAt(new Date(attempt.resultsAt)) : "Submitted")
            : (isPracticeAttempt(attempt)
              ? "Practice · Score " + attempt.result.score
              : "Score: " + attempt.result.score + " (" + attempt.result.percentile + "%ile)");

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

    // The rail header already names the block, so the card carries only the notice itself.
    var noticeBoardHtml = appConfig && (appConfig.noticeTitle || appConfig.noticeBody)
      ? (
        '<div class="dashboard-notice-card">' +
        (appConfig.noticeTitle ? '<h3>' + escapeHtml(appConfig.noticeTitle) + '</h3>' : "") +
        (appConfig.noticeBody ? '<p>' + escapeHtml(appConfig.noticeBody).replace(/\n/g, "<br>") + '</p>' : "") +
        '</div>'
      )
      : '<div class="portal-empty-card"><div class="portal-empty-icon" aria-hidden="true">📌</div><h4 class="portal-empty-title">No announcements</h4><p class="portal-empty-text">Portal updates, exam schedules and news will appear here.</p><a href="#updates/events" class="button button-secondary button-compact">Open exam calendar</a></div>';

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
            '<p class="section-label" style="margin:0;">' + escapeHtml(targetExamLabel()) + '</p>' +
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

    // Your progress, at the top so it is visible as soon as the dashboard opens.
    var heroStat = function (label, value, sub) {
      return '<div class="hero-stat"><dt>' + escapeHtml(label) + '</dt><dd><strong>' + escapeHtml(value) + '</strong>' +
        (sub ? '<small>' + escapeHtml(sub) + '</small>' : '') + '</dd></div>';
    };
    var heroProgressHtml = attemptStats.count
      ? '<section class="hero-progress" aria-labelledby="hero-progress-title">' +
        '<div class="hero-progress-head"><h2 class="section-label" id="hero-progress-title">Your progress</h2>' +
        '<a class="hero-progress-link" href="#progress/performance">View progress</a></div>' +
        '<dl class="hero-progress-grid">' +
        heroStat("Mocks completed", String(attemptStats.count)) +
        heroStat("Avg score", formatMarks(attemptStats.averageScore)) +
        heroStat("Best score", formatMarks(attemptStats.bestScore), attemptStats.bestScorePercentile ? ordinal(attemptStats.bestScorePercentile) + " percentile" : "") +
        heroStat("Avg accuracy", formatPct(attemptStats.averageAccuracy)) +
        '</dl>' +
        '</section>'
      : '<section class="hero-progress is-empty" aria-labelledby="hero-progress-title">' +
        '<h2 class="section-label" id="hero-progress-title">Your progress</h2>' +
        '<p>Your progress shows up here after your first mock.</p>' +
        '</section>';

    // Notice Board: in the right rail on desktop. When the columns stack (≤992px) a notice
    // moves up to sit right after Next Up, so it is seen as soon as the page opens; the rail
    // copy is then hidden (display: none), so it is never read twice.
    var noticeHeaderHtml = function (labelId) {
      return '<div class="rail-header">' +
        '<span class="editorial-num-tag"><svg class="editorial-traced-icon" xmlns="http://www.w3.org/2000/svg" width="72" height="90" viewBox="0 0 72 90"><g shape-rendering="geometricPrecision"><path fill="#000000" fill-rule="evenodd" d="M 10 75 10 76 19 76 11 76 Z M 62 71 63 71 64 72 64 74 64 72 63 71 Z M 9 63 9 64 8 65 9 64 Z M 22 36 21 37 21 38 20 39 18 39 19 40 19 42 20 43 21 42 20 43 19 42 19 41 22 38 23 38 23 37 Z M 42 30 41 29 40 29 39 28 34 28 33 27 31 27 30 26 30 25 30 26 31 27 29 29 28 29 27 28 26 28 26 29 25 30 26 31 25 32 23 32 21 34 24 34 25 35 26 35 25 34 25 33 26 32 27 32 28 33 29 33 30 34 29 35 30 36 30 40 32 38 32 37 33 36 38 36 39 35 41 35 41 34 42 33 Z M 37 33 38 34 36 36 35 36 34 35 36 33 Z M 38 30 39 29 40 30 39 31 Z M 26 31 28 29 29 29 30 30 30 31 29 32 27 32 Z M 33 30 33 29 34 28 38 28 39 29 37 31 36 31 35 30 34 31 Z M 29 29 30 28 31 29 30 30 Z"/><path fill="#125fa4" fill-rule="evenodd" d="M 25 65 26 65 27 66 32 66 31 66 30 65 28 65 27 66 26 65 Z M 19 47 14 52 14 53 13 54 14 54 15 53 16 53 17 54 16 55 16 57 15 58 15 59 14 60 14 61 12 63 11 62 11 60 12 59 11 59 11 64 10 65 10 71 11 72 11 74 25 74 25 73 23 73 22 72 21 72 18 69 18 68 16 66 17 65 18 65 19 64 20 65 19 64 19 63 18 62 18 61 19 60 23 64 23 62 21 60 21 59 20 58 20 57 19 58 18 57 18 50 19 49 Z M 13 65 14 66 14 67 13 68 14 69 14 70 12 72 11 71 11 70 10 69 10 68 Z"/><path fill="#b4783e" fill-rule="evenodd" d="M 38 74 55 74 56 73 63 73 47 73 46 74 Z M 64 69 55 69 54 70 36 70 36 71 41 71 42 70 64 70 Z M 6 59 5 60 5 67 6 68 6 72 7 73 7 75 8 75 8 73 7 72 7 66 6 65 Z M 40 58 40 59 41 60 40 59 Z M 49 31 49 32 51 34 52 34 51 34 49 32 Z M 60 19 64 23 64 30 59 35 54 35 59 35 60 34 61 34 62 33 62 32 64 30 64 23 Z M 58 18 54 18 53 19 52 19 49 22 49 24 48 25 48 29 48 25 49 24 49 22 51 20 52 20 54 18 Z"/><path fill="#0082c9" fill-rule="evenodd" d="M 18 66 19 67 19 68 22 71 23 71 24 72 25 72 26 73 26 74 28 74 28 73 29 72 29 70 28 69 26 69 25 68 24 68 23 67 22 67 21 66 Z M 20 49 19 50 20 51 19 52 19 55 20 55 22 57 22 59 24 61 25 61 27 63 29 63 30 64 32 64 33 65 33 66 32 67 34 67 35 66 36 66 37 65 37 62 34 62 33 61 30 61 29 60 26 60 25 59 24 59 21 56 21 55 20 54 21 53 22 53 25 56 26 56 27 57 28 57 28 56 26 54 25 54 Z"/><path fill="#d3a274" fill-rule="evenodd" d="M 43 64 41 64 40 63 40 66 39 67 41 67 43 65 Z M 41 38 40 37 39 37 38 38 34 38 33 39 33 40 31 42 24 42 23 41 23 43 22 44 22 45 21 46 22 47 22 48 23 48 22 47 22 44 23 43 24 43 25 44 25 46 28 49 31 49 30 48 30 47 31 46 31 45 32 44 33 45 33 46 34 47 34 48 35 48 36 47 37 47 38 46 39 46 40 47 41 47 39 45 39 43 40 42 40 41 41 40 Z M 37 39 39 41 39 43 38 44 36 44 35 43 35 41 Z"/><path fill="#65523f" fill-rule="evenodd" d="M 38 76 39 75 44 75 39 75 Z M 51 68 52 68 53 69 52 68 Z M 62 64 61 65 61 66 61 65 Z M 5 59 4 60 4 62 3 63 4 62 4 60 Z M 39 56 39 57 40 57 40 56 Z M 27 40 26 41 25 41 26 41 Z M 59 33 59 34 60 35 59 34 Z M 48 24 49 25 50 24 49 25 Z M 57 22 57 24 56 25 56 26 56 25 57 24 Z M 50 20 51 21 50 22 51 22 51 21 Z M 61 19 63 21 64 20 63 19 62 20 Z M 62 20 63 19 64 20 63 21 Z"/><path fill="#513928" fill-rule="evenodd" d="M 9 75 7 77 8 77 8 76 Z M 61 74 60 74 59 75 60 75 Z M 36 72 37 72 38 73 40 73 39 73 38 72 Z M 65 69 65 70 66 71 65 70 Z M 53 68 52 69 43 69 52 69 Z M 39 68 38 67 38 68 37 69 36 69 35 70 34 69 35 70 36 69 38 69 Z M 7 62 7 63 8 63 Z M 41 59 40 60 41 61 40 60 Z M 29 39 28 40 29 40 Z M 57 16 56 17 55 17 57 17 Z"/><path fill="#242726" fill-rule="evenodd" d="M 38 60 38 61 39 61 Z M 27 26 28 27 28 28 29 27 28 27 Z"/><path fill="#1e1915" fill-rule="evenodd" d="M 56 71 55 71 54 72 51 72 55 72 Z M 40 61 41 62 42 62 41 62 Z M 22 39 21 40 22 40 Z M 51 32 52 33 53 33 52 33 Z M 25 29 22 32 21 32 22 32 Z M 23 27 22 26 21 27 22 26 Z"/><path fill="#d6d6d1" fill-rule="evenodd" d="M 51 29 51 30 52 31 54 31 53 30 53 29 Z M 61 23 59 21 58 21 57 20 56 20 55 21 54 21 53 22 52 22 51 23 51 27 51 25 55 21 56 21 57 20 58 21 58 22 60 24 61 24 Z"/><path fill="#b5b5b4" fill-rule="evenodd" d="M 66 72 65 73 65 74 65 73 Z M 58 25 58 26 59 25 60 25 61 26 60 27 61 26 60 25 Z"/><path fill="#080808" fill-rule="evenodd" d="M 47 31 48 32 48 33 48 32 Z M 20 28 20 29 19 30 19 31 20 31 19 30 20 29 Z"/><path fill="#0e1518" fill-rule="evenodd" d="M 22 65 23 66 23 65 Z M 29 57 28 58 29 59 Z M 14 55 13 56 14 57 13 58 14 57 13 56 Z M 28 53 28 54 29 54 Z M 35 27 36 27 37 26 36 27 35 26 Z"/><path fill="#164568" fill-rule="evenodd" d="M 24 63 24 65 25 64 26 64 27 65 26 66 27 65 26 64 26 63 Z M 19 61 19 62 20 62 22 64 Z M 15 54 15 55 13 57 14 58 12 60 13 61 13 60 14 59 14 58 15 57 14 56 15 55 Z M 13 57 14 56 15 57 14 58 Z"/><path fill="#868684" fill-rule="evenodd" d="M 31 69 33 69 34 70 33 69 Z M 52 66 51 67 52 67 Z M 59 27 59 28 57 30 59 28 Z"/><path fill="#010101" fill-rule="evenodd" d="M 21 33 20 33 20 34 Z M 23 28 22 29 22 30 23 29 Z"/><path fill="#846d56" fill-rule="evenodd" d="M 50 67 49 68 48 68 50 68 Z M 44 67 44 68 46 68 45 68 Z"/><path fill="#cf9f72" fill-rule="evenodd" d="M 23 49 24 50 25 50 26 51 24 49 Z M 22 43 23 44 23 47 23 45 24 44 23 44 Z M 26 36 28 38 27 39 28 38 28 37 27 37 Z"/><path fill="#0b5f9e" fill-rule="evenodd" d="M 11 69 12 69 13 70 12 71 13 70 12 69 Z M 22 54 24 56 23 57 24 56 Z"/><path fill="#0772b6" fill-rule="evenodd" d="M 19 57 20 56 21 57 21 58 21 57 22 56 21 57 20 56 19 56 Z"/></g></svg></span>' +
        '<p class="section-label"' + (labelId ? ' id="' + labelId + '"' : '') + '>NOTICE BOARD</p>' +
        '</div>';
    };
    var hasNotice = !!(appConfig && (appConfig.noticeTitle || appConfig.noticeBody));
    var noticeRailBlockHtml = '<div class="rail-block rail-notice-block">' + noticeHeaderHtml("") + noticeBoardHtml + '</div>';
    var noticeStackedHtml = hasNotice
      ? '<section class="rail-block dashboard-notice-stacked" aria-labelledby="notice-board-stacked-title">' + noticeHeaderHtml("notice-board-stacked-title") + noticeBoardHtml + '</section>'
      : '';

    app.innerHTML = buildShell(
      renderPrimaryNav("dashboard", user) +
      '<div class="dashboard-layout-shell">' +
      '<section class="dashboard-greeting-hero animate-fade-in-up" style="animation-delay: 0ms;">' +
      '<div class="dashboard-greeting-hero-content">' +
      '<div class="hero-eyebrow-row">' +
      '<span class="section-label">DASHBOARD</span>' +
      '<span class="aceiiit-signature-dot">&bull;</span>' +
      '<span class="editorial-meta-date">' + escapeHtml(formatDateOnly(new Date()).toUpperCase()) + ' &bull; ' + escapeHtml(targetExamLabel()) + ' PREPARATION</span>' +
      '</div>' +
      '<h1 class="hero-title">' + escapeHtml(getDashboardGreeting()) + '<br>' + escapeHtml(firstName(user.name)) + '</h1>' +
      '<p class="hero-subtitle">Your preparation, ' +
      '<span class="t-think" role="status" id="t-think-container" data-states="assessed.,evaluated.,tested.,sharpened.,refined.,validated.,challenged.,calibrated.,benchmarked.,quantified.,verified.,perfected.">' +
      '<span class="t-think-sizer" aria-hidden="true">benchmarked.</span>' +
      '<span class="t-think-text" data-text="assessed." id="t-think-active">assessed.</span>' +
      '</span></p>' +
      '</div>' +
      heroProgressHtml +
      '<div class="dashboard-greeting-mascot">' +
      '<button type="button" class="mascot-button js-mascot" aria-label="Get a study tip from the AceIIIT mascot" aria-expanded="false" aria-controls="mascot-bubble">' +
      '<img src="assets/mascot-wave.svg" width="1295" height="1214" alt="" fetchpriority="high" decoding="async">' +
      '</button>' +
      '<div class="mascot-bubble" id="mascot-bubble" role="status" aria-live="polite"></div>' +
      '</div>' +
      '</section>' +
      nextUpHtml +
      noticeStackedHtml +
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
      '<div class="dashboard-editorial-list dashboard-tests-list" id="available-tests-list">' + cards + '</div>' +

      qotdHtml +
      '</div>' + // end dashboard-main-col
      '<aside class="dashboard-sidebar-rail">' +
      noticeRailBlockHtml +
      '<div class="rail-divider"></div>' +
      '<div class="rail-block">' +
      '<div class="rail-header">' +
      '<span class="editorial-num-tag"><svg class="editorial-traced-icon" xmlns="http://www.w3.org/2000/svg" width="72" height="90" viewBox="0 0 72 90"><g shape-rendering="geometricPrecision"><path fill="#000000" fill-rule="evenodd" d="M 25 67 25 68 25 67 26 66 39 66 40 67 40 68 40 67 39 66 39 63 39 65 38 66 27 66 26 65 26 63 26 66 Z M 42 61 42 63 43 63 44 64 46 62 46 61 Z M 19 61 19 62 21 64 22 63 23 63 23 61 Z M 8 40 8 42 9 42 10 43 10 68 10 59 11 58 54 58 55 59 55 68 55 43 56 42 57 42 57 40 Z M 49 35 48 34 48 32 47 31 47 29 46 28 46 26 45 25 45 24 44 23 44 21 44 28 45 29 45 30 46 31 45 32 43 32 42 31 41 31 40 30 38 30 37 31 35 31 34 30 32 30 31 29 26 29 20 35 20 36 21 37 30 37 31 36 30 35 24 35 23 34 26 31 27 32 28 32 27 31 28 30 29 30 33 34 33 35 34 36 34 37 39 37 39 33 40 32 41 33 42 33 43 34 44 34 45 35 46 35 47 36 49 36 Z M 34 17 33 18 32 18 31 19 31 21 30 22 30 23 31 24 31 25 33 27 34 27 35 28 38 28 41 25 41 24 42 23 42 21 41 20 41 19 39 17 Z M 31 24 32 23 37 23 39 25 39 26 38 27 37 27 36 26 32 26 31 25 Z M 23 12 24 13 26 13 25 12 Z M 30 10 31 11 31 12 31 11 Z"/><path fill="#cecece" fill-rule="evenodd" d="M 12 59 24 59 25 60 26 59 39 59 40 60 41 59 53 59 Z"/><path fill="#737373" fill-rule="evenodd" d="M 43 12 42 13 43 13 Z"/><path fill="#5a5a5a" fill-rule="evenodd" d="M 38 60 38 61 39 61 Z M 27 60 26 61 27 61 Z M 46 16 48 18 48 19 48 18 Z"/></g></svg></span>' +
      '<p class="section-label">RECENT ACTIVITY</p>' +
      '</div>' +
      recentAttempts +
      '</div>' +
      '<div class="rail-divider"></div>' +
      '<div class="rail-block">' +
      '<div class="rail-header rail-header-calendar">' +
      '<span class="editorial-num-tag"><svg class="editorial-traced-icon" xmlns="http://www.w3.org/2000/svg" width="93" height="115" viewBox="0 0 93 115"><g shape-rendering="geometricPrecision"><path fill="#c76d39" fill-rule="evenodd" d="M 27 57 27 60 76 60 76 57 Z"/><path fill="#000000" fill-rule="evenodd" d="M 73 76 55 76 54 75 54 62 54 64 53 65 30 65 53 65 54 66 54 75 55 76 Z M 62 44 72 44 73 45 73 47 73 45 72 44 Z M 78 55 71 55 70 54 70 52 70 54 69 55 60 55 59 54 59 42 59 54 58 55 45 55 44 54 43 55 25 55 Z"/><path fill="#2f1c10" fill-rule="evenodd" d="M 74 62 74 68 73 69 74 70 74 75 Z M 65 48 74 48 75 49 75 50 74 51 65 51 74 51 75 50 75 49 74 48 Z M 41 32 42 33 42 34 43 34 Z"/><path fill="#a75225" fill-rule="evenodd" d="M 75 63 75 84 76 84 76 63 Z M 27 63 27 84 28 84 28 63 Z"/><path fill="#858585" fill-rule="evenodd" d="M 75 47 76 48 76 51 75 52 72 52 75 52 76 51 76 48 Z M 26 34 25 35 26 36 27 35 Z M 25 35 26 34 27 35 26 36 Z"/><path fill="#3a444b" fill-rule="evenodd" d="M 73 68 72 69 55 69 72 69 Z M 29 53 29 54 35 54 35 53 Z M 52 44 52 46 50 48 51 49 51 54 52 53 Z M 52 41 53 42 54 42 55 41 58 41 Z M 73 33 72 34 72 36 75 36 75 34 74 33 Z"/><path fill="#120e0b" fill-rule="evenodd" d="M 26 62 27 61 28 61 29 62 30 61 76 61 77 62 76 61 27 61 Z M 50 42 51 43 52 42 51 43 Z M 71 34 71 36 73 38 71 36 Z"/><path fill="#f6cd91" fill-rule="evenodd" d="M 56 70 56 74 72 74 72 70 Z M 61 72 62 71 65 71 66 72 66 73 65 74 62 74 61 73 Z"/><path fill="#cdb587" fill-rule="evenodd" d="M 55 70 55 74 56 75 72 75 56 75 55 74 Z"/><path fill="#eaeaea" fill-rule="evenodd" d="M 53 76 54 77 72 77 54 77 Z M 71 53 72 54 78 54 72 54 Z"/><path fill="#ffdfb2" fill-rule="evenodd" d="M 56 63 56 67 72 67 72 63 Z M 61 65 63 63 65 63 67 65 66 66 62 66 Z"/><path fill="#85b393" fill-rule="evenodd" d="M 63 45 63 46 72 46 71 45 Z M 53 43 53 53 54 53 54 43 Z"/><path fill="#76736c" fill-rule="evenodd" d="M 73 63 73 67 72 68 56 68 72 68 73 67 Z"/><path fill="#ef2d3a" fill-rule="evenodd" d="M 60 53 60 54 69 54 69 53 Z M 50 43 49 43 48 44 48 46 47 47 47 49 46 50 46 52 45 53 46 53 47 52 47 50 48 49 48 47 49 46 49 44 Z"/><path fill="#202534" fill-rule="evenodd" d="M 75 33 76 34 76 35 77 34 76 34 Z"/><path fill="#ffd300" fill-rule="evenodd" d="M 41 34 40 34 39 33 37 33 35 35 35 36 36 37 36 38 37 39 40 36 40 35 Z"/><path fill="#da9542" fill-rule="evenodd" d="M 66 49 66 50 74 50 74 49 Z M 34 31 32 33 33 34 34 33 Z"/></g></svg></span>' +
      '<p class="section-label">EXAM CALENDAR</p>' +
      renderGoogleCalendarControl() +
      '</div>' +
      calendarHtml +
      '</div>' +
      '</aside>' +
      '</section>' +
      '</div>' +
      plannerModalHtml,
      { fluid: true }
    );

    // Mascot advisor: hover (mouse), keyboard focus or a tap shows a tip addressed to the
    // student; each new showing moves on to the next relevant tip.
    (function bindMascot() {
      var mascot = app.querySelector(".js-mascot");
      var bubble = document.getElementById("mascot-bubble");
      if (!mascot || !bubble) return;
      var tips = buildMascotTips({
        user: user,
        attempts: mockAttemptsOnly(snapshot.attempts),
        tests: snapshot.tests,
        nextUpTest: nextUpTest,
        inProgressAttempt: inProgressAttempt,
        examDate: appConfig && appConfig.ugeeExamDate
      });
      var visible = false;
      function showTip() {
        var index = Number(runtime.mascotTipIndex || 0) % tips.length;
        runtime.mascotTipIndex = index + 1;
        visible = true;
        mascot.setAttribute("aria-expanded", "true");
        bubble.classList.add("is-visible");
        // Filled after it is shown so the live region announces the tip.
        window.requestAnimationFrame(function () { bubble.innerHTML = tips[index]; });
      }
      function hideTip() {
        if (!visible) return;
        visible = false;
        mascot.setAttribute("aria-expanded", "false");
        bubble.classList.remove("is-visible");
      }
      mascot.addEventListener("pointerenter", function (event) { if (event.pointerType === "mouse") showTip(); });
      mascot.addEventListener("pointerleave", function (event) { if (event.pointerType === "mouse") hideTip(); });
      mascot.addEventListener("focus", function () { if (mascot.matches(":focus-visible")) showTip(); });
      mascot.addEventListener("blur", hideTip);
      // Click / tap / Enter: show the next tip.
      mascot.addEventListener("click", showTip);
      mascot.addEventListener("keydown", function (event) {
        if (event.key === "Escape") hideTip();
      });
    })();

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

  // Thin top progress bar for background refreshes after a page change: appears only if the
  // refresh takes over 200 ms, grows with transform (compositor only), then completes and fades.
  var routeProgress = { timer: 0, el: null };

  function startRouteProgress() {
    window.clearTimeout(routeProgress.timer);
    routeProgress.timer = window.setTimeout(function () {
      var el = routeProgress.el;
      if (!el || !document.body.contains(el)) {
        el = document.createElement("div");
        el.id = "route-progress";
        el.className = "route-progress";
        el.setAttribute("role", "progressbar");
        el.setAttribute("aria-label", "Loading the latest data");
        document.body.appendChild(el);
        routeProgress.el = el;
      }
      el.classList.remove("is-done");
      void el.offsetWidth;
      el.classList.add("is-active");
    }, 200);
  }

  function finishRouteProgress() {
    window.clearTimeout(routeProgress.timer);
    var el = routeProgress.el;
    if (!el || !el.classList.contains("is-active")) return;
    el.classList.add("is-done");
    window.setTimeout(function () {
      el.classList.remove("is-active", "is-done");
    }, 400);
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

    // Page changes keep the current page on screen (no full-screen "Syncing…" blur) with a thin
    // top progress bar while the new page's data loads, then draw it once with fresh data.
    var navigation = !!settings.navigation;
    if (navigation) shouldShowOverlay = false;

    if (syncInFlight) {
      syncQueued = true;
      syncQueuedSettings = Object.assign({}, syncQueuedSettings || {}, settings);
      return;
    }
    syncInFlight = true;
    if (shouldShowOverlay) {
      showOverlayLoader("Syncing...", { delayMs: 420 });
    }
    if (navigation) startRouteProgress();
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
      if (navigation) finishRouteProgress();
      if (shouldShowOverlay || navigation) {
        window.requestAnimationFrame(function () {
          window.setTimeout(hideOverlayLoader, 180);
        });
      }
      if (syncQueued) {
        syncQueued = false;
        var nextSettings = syncQueuedSettings || settings;
        syncQueuedSettings = null;
        window.setTimeout(function () {
          syncAndRenderCurrentRoute(nextSettings);
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
    // Practice papers may hold one section only (its time is 0) and can be untimed; marks are
    // shown only when known.
    var untimedPaper = !!test.untimed;
    var presentSections = ["SUPR", "REAP"].filter(function (key) {
      return !test.isPractice || Number((test.sectionDurations && test.sectionDurations[key]) || 0) > 0;
    });
    var sectionTimeText = function (key) {
      return untimedPaper ? "untimed" : test.sectionDurations[key] + " minutes";
    };
    var sectionSummary = presentSections.map(function (key, index) {
      var marks = key === "SUPR" ? suprMaxMarks : reapMaxMarks;
      return "SECTION " + (index + 1) + ": " + key + " | Duration: " + sectionTimeText(key) + (marks ? " | Maximum marks: " + marks : "");
    }).concat(["Negative marking applies according to the penalty configured for each question."]);

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
      (untimedPaper
        ? '<p>This practice paper contains ' + totalQuestionCount + ' questions and has no time limit.</p>'
        : '<p>This test contains ' + totalQuestionCount + ' questions and the total duration is ' + getTotalDuration(test) + ' minutes.</p>') +
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
      presentSections.map(function (key) {
        return '<p><strong>' + key + ':</strong> ' + (untimedPaper ? 'Untimed' : test.sectionDurations[key] + ' minutes') + '</p>';
      }).join("") +
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
    // Custom practice papers can hold one section only; the absent one is skipped.
    var hasSupr = suprQuestions.length > 0;
    var hasReap = reapQuestions.length > 0;
    var untimedPaper = !!(test && test.untimed);

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
      if (suprTimeLeft <= 0 && !hasReap) {
        // SUPR-only paper: its time is the paper's time.
        flushQuestionTime();
        submitAndNavigate();
        return;
      }
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
      if (activeSection === "SUPR" && hasReap) {
        // Nothing to answer in SUPR (a REAP-only paper from before the server skipped it).
        activateReap().then(function (advanced) {
          if (advanced) renderTest(user, attempt.id);
        });
        return;
      }
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
          (untimedPaper
            ? '<strong id="timer-display-mobile" class="is-untimed">Untimed</strong>'
            : '<strong id="timer-display-mobile" role="timer" aria-label="Time left in ' + activeSection + '">' + formatTime(remainingSeconds) + '</strong>') +
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
      '<div class="exam-timerline">' + (untimedPaper
        ? 'Untimed practice'
        : activeSection + ' Time Left : <strong id="timer-display">' + formatTime(remainingSeconds) + '</strong>') +
      ' <span class="autosave-chip" id="autosave-chip" role="status" aria-live="polite">' + escapeHtml(describeAutosave(store.getAutosaveStatus ? store.getAutosaveStatus(attempt.id) : null)) + '</span></div>' +
      '</div>' +
      '<div class="exam-sectionheader">Sections</div>' +
      '<div class="exam-sectionbar">' +
      '<div class="exam-tabs">' +
      (hasSupr ? '<button class="tab-button ' + (activeSection === "SUPR" ? "is-active" : "") + '" data-section="SUPR" ' + (activeSection === "REAP" ? "disabled" : "") + '>SUPR</button>' : '') +
      (hasReap ? '<button class="tab-button ' + (activeSection === "REAP" ? "is-active" : "") + '" data-section="REAP" ' + (activeSection === "SUPR" ? "disabled" : "") + '>REAP</button>' : '') +
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
      '<div class="exam-questionbody' + (isLongPassage(currentQuestion.passage) ? ' has-passage' : '') + '">' +
      (currentQuestion.passage ? '<div class="passage exam-passage rich-text' + (isLongPassage(currentQuestion.passage) ? '' : ' is-lead-in') + '">' + formatRichText(currentQuestion.passage) + '</div>' : "") +
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
      if (activeSection === "SUPR" && hasReap) {
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
        if (suprLiveTimeLeft <= 0 && !hasReap) {
          flushQuestionTime();
          submitAndNavigate();
          return;
        }
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
      if (timerDisplay && !untimedPaper) {
        timerDisplay.textContent = formatTime(secondsLeft);
        timerDisplay.classList.toggle("is-warning", secondsLeft <= 600 && secondsLeft > 300);
        timerDisplay.classList.toggle("is-danger", secondsLeft <= 300);
      }
      if (timerDisplayMobile && !untimedPaper) {
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
      Promise.all([
        Promise.resolve(store.getAttemptResult(attemptId)),
        Promise.resolve(store.refreshFromRemote ? store.refreshFromRemote() : null).catch(function () {}),
      ])
        .then(function (results) {
          renderResults(user, attemptId, true, results[0] || null, null);
        })
        .catch(function () {
          renderResults(user, attemptId, true);
        });
      return;
    }
    var attempt = prefetchedAttempt || store.getAttemptById(attemptId);
    if (attempt && attempt.resultsPending) {
      renderPendingResults(user, attempt);
      return;
    }
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
            '<span class="rs-section-score">Score <b>' + escapeHtml(formatMarks(section.score)) + '</b></span>' +
            '<span class="rs-pill ' + accuracyTone(section.accuracy) + '">' + escapeHtml(formatPct(section.accuracy)) + ' accuracy</span>' +
            '</div>' +
            buildOutcomeBar(Number(section.correct || 0), Number(section.wrong || 0), Number(section.skipped || 0)) +
            '<div class="rs-meta">' +
            '<span><i class="rs-dot is-correct"></i>' + escapeHtml(String(section.correct || 0)) + ' correct</span>' +
            '<span><i class="rs-dot is-wrong"></i>' + escapeHtml(String(section.wrong || 0)) + ' wrong</span>' +
            '<span><i class="rs-dot is-skipped"></i>' + escapeHtml(String(section.skipped || 0)) + ' left blank</span>' +
            (hasTime ? '<span>' + escapeHtml(formatDurationShort(section.timeSpent)) + ' spent</span>' : '') +
            (Number(section.avgTimePerAttempted || 0) > 0 ? '<span>' + escapeHtml(String(Math.round(Number(section.avgTimePerAttempted)))) + 's per answer</span>' : '') +
            '</div>' +
            '</div>'
          );
        }).join("") +
        '</div>' +
        '</section>'
      );
    }

    // ---- Plan for the next mock --------------------------------------------------------
    // Up to three steps, each grounded in this attempt's own numbers. Every rule is guarded so the
    // advice never contradicts the data (no "skip more" to someone who left the paper blank, no
    // pace verdict from a handful of answers).
    function buildActionPlan(summary) {
      var steps = [];
      var total = totalQuestions;
      var attempted = attemptedCount;
      var accuracyPct = attempted ? (correctCount / attempted) * 100 : 0;
      var sections = sectionRowsFor(summary);
      var topics = summary && Array.isArray(summary.topicInsights) ? summary.topicInsights : [];
      var time = summary && summary.timeAnalysis ? summary.timeAnalysis : null;

      if (total && attempted / total < 0.6) {
        var target = Math.min(total, Math.max(Math.ceil(total * 0.5), Math.ceil(attempted * 1.25), attempted + 1));
        steps.push({
          key: "coverage",
          lead: "Your biggest gain is attempting more of the paper.",
          title: "Attempt more of the paper",
          why: endedEarly
            ? "You answered " + attempted + " of " + total + " questions. Sit the full paper and aim for at least " + target + " attempts."
            : "You left " + skippedCount + " of " + total + " questions blank, and unanswered questions can't score. Aim for at least " + target + " attempts next time."
        });
      }

      var weakTopic = topics.filter(function (t) {
        return Number(t.attempted || 0) > 0 && (Number(t.wrong || 0) > 0 || Number(t.score || 0) < 0);
      })[0];
      if (weakTopic) {
        var topicName = formatTopicName(weakTopic.topic);
        steps.push({
          key: "topic",
          section: weakTopic.section,
          lead: "Your biggest gain is " + topicName + ".",
          title: "Revise " + topicName,
          why: String(weakTopic.correct || 0) + " of " + String(weakTopic.attempted || 0) + " correct in " + weakTopic.section +
            ", " + formatSignedMarks(weakTopic.score) + " marks. It's the first topic to fix from this paper.",
          actions: weakTopic.section ? [{ label: "Practise " + weakTopic.section, practice: weakTopic.section }] : []
        });
      }

      if (!endedEarly && attempted >= 10 && accuracyPct < 55) {
        steps.push({
          key: "accuracy",
          lead: "Your biggest gain is cutting wrong answers.",
          title: "Cut negative marks",
          why: wrongCount + " of " + attempted + " answers were wrong. Answer only after ruling out at least two options, and leave the rest for a second pass."
        });
      }

      var measured = sections.filter(function (row) { return Number(row.correct || 0) + Number(row.wrong || 0) >= 5; })
        .sort(function (a, b) { return Number(a.accuracy || 0) - Number(b.accuracy || 0); });
      if (measured.length >= 2) {
        var weakSection = measured[0];
        var strongSection = measured[measured.length - 1];
        if (Number(strongSection.accuracy || 0) - Number(weakSection.accuracy || 0) >= 15) {
          var practisedAlready = steps.some(function (step) { return step.section === weakSection.key; });
          steps.push({
            key: "section",
            section: weakSection.key,
            lead: "Your biggest gain is " + weakSection.key + ".",
            title: "Strengthen " + weakSection.key,
            why: weakSection.key + " accuracy was " + formatPct(weakSection.accuracy) + " against " + formatPct(strongSection.accuracy) + " in " + strongSection.key + ".",
            actions: practisedAlready ? [] : [{ label: "Practise " + weakSection.key, practice: weakSection.key }]
          });
        }
      }

      if (!endedEarly && attempted >= 20 && time) {
        var perAnswer = Math.round(Number(time.avgSecondsPerAttempted || 0));
        var suggested = Math.round(Number(time.targetSecondsPerQuestion || 0));
        if (time.fastButErrorProne) {
          steps.push({
            key: "pace",
            lead: "Your biggest gain is slowing down to check answers.",
            title: "Slow down and check",
            why: "You spent " + perAnswer + "s per answer against a suggested " + suggested + "s, and " + formatPct(accuracyPct) + " were correct. Use the spare time to re-check each choice."
          });
        } else if (time.timePressure) {
          steps.push({
            key: "pace",
            lead: "Your biggest gain is a faster first pass.",
            title: "Speed up your first pass",
            why: "You spent " + perAnswer + "s per answer against a suggested " + suggested + "s. Mark long questions and return to them once the quick ones are done."
          });
        }
      }

      if (summary && summary.nextBenchmark !== null && summary.nextBenchmark !== undefined) {
        steps.push({
          key: "benchmark",
          lead: "You are " + formatMarks(summary.benchmarkGap) + " marks from the next benchmark.",
          title: "Reach " + formatMarks(summary.nextBenchmark) + " marks",
          why: "You are " + formatMarks(summary.benchmarkGap) + " marks short of the next benchmark for this paper."
        });
      }

      if (!steps.length) {
        steps.push({
          key: "steady",
          lead: "Keep this approach going.",
          title: "Keep this approach",
          why: "Nothing in this attempt is holding your score back. Take another timed mock to confirm it.",
          actions: [{ label: "Browse mock tests", href: "#exams/mock-tests" }]
        });
      }

      steps = steps.slice(0, 3);
      // Wrong answers are worth reading: the accuracy or topic step links to them.
      if (wrongCount > 0 && analysis) {
        var reviewHost = steps.filter(function (step) { return step.key === "accuracy"; })[0] ||
          steps.filter(function (step) { return step.key === "topic"; })[0];
        if (reviewHost) {
          reviewHost.actions = (reviewHost.actions || []).concat([{ label: "Review " + wrongCount + " wrong answer" + (wrongCount === 1 ? "" : "s"), review: true }]);
        }
      }
      return steps;
    }

    function planActionHtml(action) {
      if (action.href) return '<a class="button button-secondary button-compact" href="' + escapeAttribute(action.href) + '">' + escapeHtml(action.label) + '</a>';
      var cls = action.review ? "js-jump-review" : "js-plan-practice";
      return '<button type="button" class="button button-secondary button-compact ' + cls + '"' +
        (action.practice ? ' data-section="' + escapeAttribute(action.practice) + '"' : '') + '>' + escapeHtml(action.label) + '</button>';
    }

    function buildWorkingLine(summary) {
      var topics = summary && Array.isArray(summary.topicInsights) ? summary.topicInsights : [];
      var strong = topics.filter(function (t) { return Number(t.attempted || 0) >= 2 && Number(t.accuracy || 0) >= 75; }).slice(0, 3);
      var items = strong.map(function (t) {
        return '<b>' + escapeHtml(formatTopicName(t.topic)) + '</b> (' + escapeHtml(String(t.correct || 0)) + ' of ' + escapeHtml(String(t.attempted || 0)) + ')';
      });
      if (!items.length) {
        var bestSection = sectionRowsFor(summary).filter(function (row) {
          return Number(row.correct || 0) + Number(row.wrong || 0) >= 5 && Number(row.accuracy || 0) >= 70;
        }).sort(function (a, b) { return Number(b.accuracy || 0) - Number(a.accuracy || 0); })[0];
        if (bestSection) items.push('<b>' + escapeHtml(bestSection.key) + '</b> at ' + escapeHtml(formatPct(bestSection.accuracy)) + ' accuracy');
      }
      return items.length ? '<p class="rs-working"><span>What\'s working:</span> ' + items.join(", ") + '</p>' : '';
    }

    function buildPlanBody(summary) {
      var steps = buildActionPlan(summary);
      return (
        '<ol class="rs-plan-steps">' +
        steps.map(function (step, index) {
          return (
            '<li class="rs-plan-step">' +
            '<span class="rs-plan-num" aria-hidden="true">' + (index + 1) + '</span>' +
            '<h4>' + escapeHtml(step.title) + '</h4>' +
            '<p>' + escapeHtml(step.why) + '</p>' +
            (step.actions && step.actions.length ? '<div class="rs-plan-actions">' + step.actions.map(planActionHtml).join("") + '</div>' : '') +
            '</li>'
          );
        }).join("") +
        '</ol>' +
        buildWorkingLine(summary)
      );
    }

    function buildHeroSentence(summary) {
      var steps = buildActionPlan(summary);
      return '<strong>' + escapeHtml(firstName(user.name)) + '</strong>, you scored ' + escapeHtml(formatMarks(result.score)) +
        (maxScore ? ' of ' + escapeHtml(formatMarks(maxScore)) : '') +
        (rankValue ? ' and ranked ' + rankValue + (rankTotal ? ' of ' + rankTotal : '') : '') + '. ' +
        escapeHtml(steps[0] ? steps[0].lead : "");
    }

    function buildPlanSection(summary) {
      return (
        '<section class="rs-card rs-plan analysis-stage"' + stageStyle(1) + ' aria-labelledby="rs-plan-title" data-attempt="' + escapeAttribute(String(attempt.id)) + '">' +
        '<div class="rs-card-head"><h2 class="section-label" id="rs-plan-title">Your plan for the next mock</h2></div>' +
        '<div id="rs-plan-body">' + buildPlanBody(summary) + '</div>' +
        '</section>'
      );
    }

    function buildEndedEarlyNotice() {
      if (!endedEarly) return "";
      return (
        '<section class="rs-card rs-notice analysis-stage"' + stageStyle(1) + '>' +
        '<div class="rs-notice-text">' +
        '<h2>This attempt ended early</h2>' +
        '<p>' + attemptedCount + ' of ' + totalQuestions + ' questions answered in ' + escapeHtml(formatDurationShort(timeTaken)) +
        '. With so few answers, the analysis below is only a rough guide. Sit the full paper under timed conditions for a reliable report.</p>' +
        '</div>' +
        '<button type="button" class="button button-secondary js-retake-test">Retake test</button>' +
        '</section>'
      );
    }

    var TOPICS_VISIBLE = 6;

    function buildTopicCard(summary) {
      var topics = summary && Array.isArray(summary.topicInsights) ? summary.topicInsights : [];
      var attemptedTopics = topics.filter(function (t) { return Number(t.attempted || 0) > 0; });
      var untouched = topics.filter(function (t) { return !Number(t.attempted || 0); });
      // Same tag in both sections: name the section so the two entries can be told apart.
      var nameCounts = topics.reduce(function (counts, t) {
        var key = formatTopicName(t.topic).toLowerCase();
        counts[key] = (counts[key] || 0) + 1;
        return counts;
      }, {});
      var UNTOUCHED_SHOWN = 8;
      var untouchedHtml = untouched.length
        ? '<p class="rs-untouched"><span>Not attempted:</span> ' + untouched.slice(0, UNTOUCHED_SHOWN).map(function (t) {
            var label = formatTopicName(t.topic);
            return escapeHtml(nameCounts[label.toLowerCase()] > 1 ? label + " (" + t.section + ")" : label);
          }).join(", ") +
          (untouched.length > UNTOUCHED_SHOWN ? ' and ' + (untouched.length - UNTOUCHED_SHOWN) + ' more' : '') + '</p>'
        : '';
      var body;
      if (!topics.length) {
        body = '<div class="empty-state">Topic breakdown isn\'t available for this older attempt.</div>';
      } else if (!attemptedTopics.length) {
        body = '<p class="rs-muted">' + (wrongCount === 0
          ? 'No marks lost in any topic you answered.'
          : 'Topic detail isn\'t available for the questions you answered.') + '</p>' + untouchedHtml;
      } else {
        body =
          '<div class="rs-topic-table" role="table" aria-label="Topics you answered">' +
          '<div class="rs-topic-row is-head" role="row">' +
          '<span role="columnheader">Topic</span><span role="columnheader">Answered</span><span role="columnheader">Correct / wrong</span><span role="columnheader">Accuracy</span><span role="columnheader">Net marks</span>' +
          '</div>' +
          attemptedTopics.map(function (topic, index) {
            var acc = roundTo(topic.accuracy, 1);
            var net = roundTo(topic.score, 2);
            var leaking = Number(topic.wrong || 0) > 0 || net < 0;
            return (
              '<div class="rs-topic-row' + (index >= TOPICS_VISIBLE ? ' is-extra' : '') + '" role="row">' +
              '<span class="rs-topic-name" role="cell"><strong>' + escapeHtml(formatTopicName(topic.topic)) + '</strong>' +
              '<em>' + escapeHtml(String(topic.section || "")) + '</em>' +
              (index === 0 && leaking ? '<b class="rs-flag">Top priority</b>' : '') + '</span>' +
              '<span role="cell" data-label="Answered">' + escapeHtml(String(topic.attempted || 0)) + ' of ' + escapeHtml(String(topic.total || 0)) + '</span>' +
              '<span role="cell" data-label="Correct / wrong">' + escapeHtml(String(topic.correct || 0)) + ' / ' + escapeHtml(String(topic.wrong || 0)) + '</span>' +
              '<span class="rs-acc" role="cell" data-label="Accuracy"><i class="' + accuracyTone(acc) + '"><b data-width="' + Math.max(3, clampPct(acc)) + '%"></b></i>' + escapeHtml(formatPct(acc)) + '</span>' +
              '<span class="rs-net ' + (net < 0 ? 'is-neg' : (net > 0 ? 'is-pos' : '')) + '" role="cell" data-label="Net marks">' + escapeHtml(formatSignedMarks(net)) + '</span>' +
              '</div>'
            );
          }).join("") +
          '</div>' +
          (attemptedTopics.length > TOPICS_VISIBLE
            ? '<button type="button" class="button button-secondary button-compact rs-topic-toggle js-topic-toggle" aria-expanded="false">Show all ' + attemptedTopics.length + ' topics</button>'
            : '') +
          untouchedHtml;
      }
      return (
        '<section class="rs-card rs-topics analysis-stage"' + stageStyle(3) + '>' +
        '<div class="rs-card-head"><p class="section-label">Topics</p>' +
        (attemptedTopics.length > 1 ? '<span class="rs-head-note">Biggest impact first</span>' : '') + '</div>' +
        body +
        '</section>'
      );
    }

    function buildTimeCard(summary) {
      var t = summary && summary.timeAnalysis ? summary.timeAnalysis : null;
      if (!t) return "";
      var stat = function (label, value, sub) {
        return '<div class="rs-stat"><span>' + escapeHtml(label) + '</span><strong>' + escapeHtml(value) + '</strong>' +
          (sub ? '<small>' + escapeHtml(sub) + '</small>' : '') + '</div>';
      };
      var note = "";
      if (!endedEarly && attemptedCount >= 20) {
        if (t.fastButErrorProne) note = "You moved faster than the suggested pace, and accuracy paid for it.";
        else if (t.timePressure) note = "You were slower than the suggested pace, which left less time for the rest of the paper.";
      }
      return (
        '<section class="rs-card rs-time analysis-stage"' + stageStyle(2) + '>' +
        '<p class="section-label">Time &amp; pace</p>' +
        '<div class="rs-stat-grid">' +
        stat("Time used", formatDurationShort(t.totalTimeSeconds), paperSeconds ? "of " + formatDurationShort(paperSeconds) : "") +
        stat("Per answer", Math.round(Number(t.avgSecondsPerAttempted || 0)) + "s", "") +
        stat("Suggested pace", Math.round(Number(t.targetSecondsPerQuestion || 0)) + "s", "per question") +
        '</div>' +
        (note ? '<p class="rs-time-note">' + escapeHtml(note) + '</p>' : '') +
        '</section>'
      );
    }

    // Scores on this paper only, oldest to newest, each bar named by its attempt.
    function buildProgressCard() {
      var ordered = attemptHistory.slice().sort(function (a, b) {
        return Number(a.attemptNumber || 0) - Number(b.attemptNumber || 0) || new Date(a.submittedAt) - new Date(b.submittedAt);
      });
      var currentIndex = ordered.findIndex(function (a) { return a.id === attempt.id; });
      var chartHtml = "";
      var compareHtml = "";
      if (ordered.length > 1) {
        var shown = ordered.slice(-6);
        var scores = shown.map(function (a) { return Number(a.result && a.result.score || 0); });
        var shortLabels = shown.length > 4;
        chartHtml = buildBarTrend(scores, {
          max: Math.max.apply(null, scores.concat([1])),
          format: formatMarks,
          xLabels: shown.map(function (a) { return (shortLabels ? "#" : "Attempt ") + (a.attemptNumber || ""); }),
          highlightIndex: shown.findIndex(function (a) { return a.id === attempt.id; }),
          label: "Score per attempt on this paper"
        });
        if (currentIndex > 0) {
          var prev = ordered[currentIndex - 1];
          var scoreDelta = Number(result.score || 0) - Number(prev.result.score || 0);
          var prevAccuracy = Number(prev.result.accuracy || 0);
          var accuracyNow = Number(result.accuracy || 0);
          compareHtml =
            '<p class="rs-compare">vs Attempt ' + escapeHtml(String(prev.attemptNumber || "")) + ': score <b class="' + (scoreDelta >= 0 ? 'is-up' : 'is-down') + '">' + escapeHtml(formatSignedMarks(scoreDelta)) + '</b>' +
            ' (' + escapeHtml(formatMarks(prev.result.score)) + ' → ' + escapeHtml(formatMarks(result.score)) + ')' +
            ' · accuracy ' + escapeHtml(formatPct(prevAccuracy)) + ' → ' + escapeHtml(formatPct(accuracyNow)) + '</p>';
        }
      }
      var listed = ordered.slice().reverse().slice(0, 6);
      return (
        '<section class="rs-card rs-history' + (ordered.length > 1 ? '' : ' is-first') + ' analysis-stage"' + stageStyle(4) + '>' +
        '<div class="rs-card-head"><p class="section-label">Progress on this paper</p>' +
        (ordered.length > 1 ? '<span class="meta-chip">' + ordered.length + ' attempts</span>' : '') + '</div>' +
        (ordered.length > 1
          ? chartHtml + compareHtml +
            '<ul class="rs-history-list">' + listed.map(function (a) {
              var isCurrent = a.id === attempt.id;
              return (
                '<li class="' + (isCurrent ? 'is-current' : '') + '">' +
                '<span class="rs-history-label">Attempt ' + escapeHtml(String(a.attemptNumber || "")) + '</span>' +
                '<strong>' + escapeHtml(formatMarks(a.result.score)) + (maxScore ? '<small>/' + escapeHtml(formatMarks(maxScore)) + '</small>' : '') + '</strong>' +
                '<span class="rs-muted">' + escapeHtml(formatDateOnly(a.submittedAt)) + '</span>' +
                (isCurrent
                  ? '<span class="meta-chip">Viewing</span>'
                  : '<button class="button button-secondary button-compact js-open-result" data-id="' + escapeAttribute(a.id) + '">Open</button>') +
                '</li>'
              );
            }).join("") + '</ul>'
          : '<div class="rs-first-attempt"><p>First attempt at this paper. Retake it to track your progress.</p>' +
            '<button type="button" class="button button-secondary button-compact js-retake-test">Retake test</button></div>') +
        '</section>'
      );
    }

    function buildQuestionReviewShell() {
      return (
        '<section class="report-card analysis-stage rs-review-section" id="question-review-section"' + stageStyle(5) + '>' +
        '<div class="analysis-review-head">' +
        '<div>' +
        '<p class="section-label">Question review</p>' +
        '<h3>Review your answers</h3>' +
        '<p class="rs-review-sub">' + (analysis
          ? 'Each question with your answer, the correct option and the full solution.'
          : 'Question review isn\'t available for this older attempt.') + '</p>' +
        '</div>' +
        '<div class="button-row">' +
        '<button class="button button-secondary" id="load-question-review"' + (analysis ? '' : ' disabled') + '>Review answers</button>' +
        '</div>' +
        '</div>' +
        '<div id="question-review-status" class="helper-text" aria-live="polite"></div>' +
        '<div id="question-review-list" class="analysis-review-list"></div>' +
        '<div class="button-row" id="question-review-more-row" style="display:none; margin-top: 14px;">' +
        '<button class="button button-secondary" id="load-more-review">Load more questions</button>' +
        '</div>' +
        '</section>'
      );
    }

    function buildTopRow(summary) {
      return buildSectionsCard(summary) + buildTimeCard(summary);
    }

    function hasAttemptTrend() {
      return attemptHistory.length > 1;
    }

    function buildDetailRow(summary) {
      return (summary ? buildTopicCard(summary) : "") + buildProgressCard();
    }

    function detailRowClass(summary) {
      return "rs-row rs-detail" + (summary && hasAttemptTrend() ? "" : " is-solo");
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

        var passageHtml = !review.passage
          ? ''
          : isLongPassage(review.passage)
            ? '<div class="analysis-review-passage"><strong>Passage:</strong><div class="rich-text">' + formatRichText(review.passage) + '</div></div>'
            : '<div class="analysis-review-lead rich-text">' + formatRichText(review.passage) + '</div>';

        var explanationHtml = review.explanation
          ? '<div class="analysis-explanation-card">' +
          '<div class="analysis-explanation-head">' +
          '<h5 class="analysis-explanation-title"><span aria-hidden="true">💡</span> Solution & Explanation</h5>' +
          '</div>' +
          '<div class="rich-text analysis-explanation-body">' + formatRichText(review.explanation) + '</div>' +
          '</div>'
          : '';

        // The result API sends questionId; locally scored practice attempts carry the question's id.
        var reviewQuestionId = String(review.questionId || review.id || "");
        var isBookmarked = store.hasBookmark && store.hasBookmark(user.id, reviewQuestionId);
        var bookmarkIconFilled = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" style="vertical-align:text-bottom;"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
        var bookmarkIconEmpty = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:text-bottom;"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
        var bookmarkBtnClass = isBookmarked ? "button button-secondary is-bookmarked js-bookmark-toggle" : "button button-secondary js-bookmark-toggle";
        var bookmarkBtnContent = isBookmarked ? bookmarkIconFilled + " Saved" : bookmarkIconEmpty + " Save";
        // Everything the Resources → Bookmarks card needs to stand on its own for revision.
        var bookmarkDataPayload = {
          id: reviewQuestionId,
          section: review.section || "",
          topic: review.topic,
          prompt: review.prompt,
          passage: review.passage || "",
          options: review.options || [],
          correctOption: review.correctOption,
          imageUrls: review.imageUrls || [],
          imageWidths: review.imageWidths || [],
          explanation: review.explanation,
          questionNumber: offset + index + 1,
          testTitle: (test && test.title) || "",
          attemptId: attempt.id
        };

        return (
          '<article class="analysis-review-card">' +
          '<div class="analysis-review-meta">' +
          '<div>' +
          '<p class="section-label">Question ' + escapeHtml(String(offset + index + 1)) + ' · ' + escapeHtml(String(review.section || "")) + '</p>' +
          '<h4>' + escapeHtml(String(review.topic || "General Topic")) + '</h4>' +
          '</div>' +
          '<div class="analysis-review-badges">' +
          statusLabel +
          '<span class="analysis-pill" aria-label="Time spent: ' + formatTime(Number(review.timeSpent || 0)) + '">⏱ ' + escapeHtml(formatTime(Number(review.timeSpent || 0))) + '</span>' +
          '<button class="' + bookmarkBtnClass + ' review-save" data-qid="' + escapeAttribute(reviewQuestionId) + '" data-qpayload="' + encodeURIComponent(JSON.stringify(bookmarkDataPayload)) + '" aria-label="Bookmark this question">' + bookmarkBtnContent + '</button>' +
          '</div>' +
          '</div>' +
          passageHtml +
          '<div class="analysis-review-block rich-text">' + formatRichText(review.prompt || "") + '</div>' +
          ((review.imageUrls || []).length
            ? '<div class="analysis-review-images">' + review.imageUrls.map(function (url, imageIndex) {
              var width = Number((review.imageWidths || [])[imageIndex]) || 0;
              return '<button class="analysis-inline-image js-open-image-lightbox' + (width ? ' figure-sized' : '') + '"' + figureSizeAttrs(width) + ' type="button" data-url="' + escapeAttribute(url) + '" aria-label="View question image"><img src="' + escapeAttribute(url) + '" alt="Question diagram"></button>';
            }).join("") + '</div>'
            : '') +
          '<ol class="analysis-option-list">' +
          ((review.options || []).map(function (option, optionIndex) {
            return buildOptionRow(option, optionIndex, review);
          }).join("")) +
          '</ol>' +
          responseSummaryHtml +
          explanationHtml +
          (reviewQuestionId && !String(attempt.id).match(/^local-/)
            ? '<div class="analysis-review-actions">' +
              '<button type="button" class="button button-secondary button-compact js-ask-mentor-question" data-qid="' + escapeAttribute(reviewQuestionId) + '" data-label="' + escapeAttribute("Q" + (offset + index + 1) + (review.topic ? " · " + review.topic : "")) + '">Ask Mentor about this</button>' +
              '<button type="button" class="analysis-report-link js-report-question" data-qid="' + escapeAttribute(reviewQuestionId) + '" data-number="' + (offset + index + 1) + '">Report a problem</button>' +
              '</div>'
            : '') +
          '</article>'
        );
      }).join("");
    }

    var attemptHistory = store.listUserAttempts(user.id).filter(function (a) {
      return a.testId === attempt.testId && a.status === "submitted" && a.result;
    });
      var correctCount = Number(result.correctCount || 0);
      var wrongCount = Number(result.wrongCount || 0);
      var skippedCount = Number(result.unattemptedCount !== undefined ? result.unattemptedCount : result.skippedCount || 0);
      var attemptedCount = correctCount + wrongCount;
      var totalQuestions = attemptedCount + skippedCount || Number(analysis && analysis.totalQuestions || 0);
      var timeTaken = Number(result.totalTime !== undefined ? result.totalTime : result.timeTakenSeconds || 0);
      var paperSeconds = test && test.durationMinutes ? Number(test.durationMinutes) * 60 : 0;
      var rankValue = Number(result.rank || 0);
      var rankTotal = Number(result.rankTotal || 0);
      // Submitted after a handful of answers: pace and accuracy-habit advice can't be judged.
      var endedEarly = totalQuestions > 0 && (attemptedCount / totalQuestions < 0.1 ||
        (paperSeconds > 0 && timeTaken < paperSeconds * 0.1 && attemptedCount / totalQuestions < 0.5));
      var attemptNumber = Number(attempt.attemptNumber || 1);
      var cohortLabel = attemptNumber > 1 ? 'vs other ' + ordinal(attemptNumber) + ' attempts' : 'vs other first attempts';
      var scoreValue = Number(result.score || 0);
      var accuracyValue = Math.round(Number(result.accuracy || 0) * 10) / 10;
      // Practice papers are unranked (rank and percentile would be meaningless) and may be untimed.
      var practiceAttempt = isPracticeAttempt(attempt);
      var untimedAttempt = !!(test && test.untimed);
      var showCoach = !practiceAttempt && !endedEarly;

      function kpi(label, valueHtml, sub, extraClass) {
        return (
          '<div class="rs-kpi' + (extraClass ? ' ' + extraClass : '') + '">' +
          '<span class="rs-kpi-label">' + escapeHtml(label) + '</span>' +
          '<strong class="rs-kpi-value">' + valueHtml + '</strong>' +
          (sub ? '<span class="rs-kpi-sub">' + escapeHtml(sub) + '</span>' : '') +
          '</div>'
        );
      }

      // A new best score across mocks (practice papers don't count); the reveal plays once.
      var personalBest = (function () {
        if (practiceAttempt) return null;
        var earlier = store.listUserAttempts(user.id).filter(function (a) {
          return a.id !== attempt.id && a.status === "submitted" && a.result && !a.isPractice && !a.resultsPending &&
            new Date(a.submittedAt || 0).getTime() < new Date(attempt.submittedAt || 0).getTime();
        });
        if (!earlier.length) return null;
        var best = Math.max.apply(null, earlier.map(function (a) { return Number(a.result.score || 0); }));
        return Number(scoreValue) > best ? { previous: best } : null;
      })();
      var revealSeen = hasSeenResultReveal(attempt.id);
      var kpisHtml =
        '<div class="rs-kpis analysis-stage' + (practiceAttempt ? ' is-four' : '') + '"' + stageStyle(0) + '>' +
        kpi("Score",
          '<span data-animate-number="' + escapeAttribute(String(scoreValue)) + '" data-decimals="' + decimalsFor(scoreValue, 2) + '"></span>' + (maxScore ? '<small>/ ' + escapeHtml(formatMarks(maxScore)) + '</small>' : ''),
          maxScore ? formatPct((scoreValue / maxScore) * 100) + ' of total marks' : '', "is-primary") +
        (practiceAttempt ? '' : (
          kpi("Rank",
            rankValue ? '<span data-animate-number="' + rankValue + '"></span>' + (rankTotal ? '<small>of ' + rankTotal + '</small>' : '') : '—',
            rankValue ? cohortLabel : (result.invalidated ? 'Removed from ranking' : 'Not ranked')) +
          kpi("Percentile",
            rankValue ? escapeHtml(ordinal(result.percentile)) : '—',
            rankValue ? (rankTotal > 1 ? 'ahead of ' + (rankTotal - rankValue) + ' of ' + (rankTotal - 1) + ' others' : 'only taker so far') : ''))) +
        kpi("Accuracy",
          '<span data-animate-number="' + escapeAttribute(String(accuracyValue)) + '" data-suffix="%" data-decimals="' + decimalsFor(accuracyValue, 1) + '"></span>',
          correctCount + ' of ' + attemptedCount + ' answers correct') +
        kpi("Attempted",
          escapeHtml(String(attemptedCount)) + (totalQuestions ? '<small>/ ' + totalQuestions + '</small>' : ''),
          skippedCount + ' left blank') +
        kpi("Time taken",
          escapeHtml(formatDurationShort(timeTaken)),
          untimedAttempt ? 'untimed practice' : (paperSeconds ? 'of ' + formatDurationShort(paperSeconds) + ' allowed' : '')) +
        '</div>' +
        '<div class="rs-outcome analysis-stage"' + stageStyle(0) + '>' +
        buildOutcomeBar(correctCount, wrongCount, skippedCount, "is-large") +
        '<div class="rs-legend">' +
        '<span><i class="rs-dot is-correct"></i>Correct <b>' + correctCount + '</b></span>' +
        '<span><i class="rs-dot is-wrong"></i>Wrong <b>' + wrongCount + '</b></span>' +
        '<span><i class="rs-dot is-skipped"></i>Left blank <b>' + skippedCount + '</b></span>' +
        '</div>' +
        '</div>';

      app.innerHTML = buildShell(
        renderPrimaryNav("progress", user) +
        '<section class="rs-page">' +
        '<header class="rs-hero">' +
        '<div class="rs-hero-text">' +
        '<p class="section-label">' + (practiceAttempt ? 'Practice session' : 'Result · Attempt ' + escapeHtml(String(attemptNumber))) + ' · ' + escapeHtml(formatDateOnly(attempt.submittedAt)) + '</p>' +
        '<h1>' + escapeHtml(test && test.title ? test.title : "UGEE Mock Test") + '</h1>' +
        '<p class="rs-hero-sub" id="rs-hero-sub">' + buildHeroSentence(analysis) + '</p>' +
        (personalBest ? '<p class="rs-pb' + (revealSeen ? '' : ' is-fresh') + '" role="status"><span class="rs-pb-star" aria-hidden="true">★</span> New personal best' + (personalBest.previous !== null ? ' <span class="rs-pb-prev">(was ' + escapeHtml(formatMarks(personalBest.previous)) + ')</span>' : '') + '</p>' : '') +
        '</div>' +
        '<div class="rs-hero-actions">' +
        (analysis ? '<button type="button" class="button button-secondary js-jump-review">Review answers</button>' : '') +
        (wrongCount + skippedCount > 0 && store.generateMistakePractice ? '<button type="button" class="button button-secondary js-practise-mistakes">Practise mistakes</button>' : '') +
        '<button type="button" class="button button-primary" id="retake-test">Retake test</button>' +
        '</div>' +
        '</header>' +
        kpisHtml +
        // AI coach: full mocks only, and not for an attempt that ended after a few answers.
        (showCoach ? '<div id="rs-coach-root" data-attempt="' + escapeAttribute(String(attempt.id)) + '" aria-live="polite"></div>' : '') +
        buildEndedEarlyNotice() +
        buildPlanSection(analysis) +
        '<div class="rs-row rs-top' + (analysis && analysis.timeAnalysis ? '' : ' is-solo') + '" id="analysis-summary-root">' + buildTopRow(analysis) + '</div>' +
        '<div class="' + detailRowClass(analysis) + '" id="analysis-detail-root">' + buildDetailRow(analysis) + '</div>' +
        '<div id="rs-time-insights-root"></div>' +
        '<div id="analysis-review-root">' + buildQuestionReviewShell() + '</div>' +
        '</section>'
      );
    if (showCoach) mountCoachCard(attempt.id);

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

    function jumpToReview() {
      var section = document.getElementById("question-review-section");
      if (section) {
        var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        section.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      }
      var loadButton = document.getElementById("load-question-review");
      if (loadButton && !loadButton.disabled && loadButton.style.display !== "none") loadButton.click();
    }

    function bindPlanActions(root) {
      root.querySelectorAll(".js-jump-review").forEach(function (button) {
        button.addEventListener("click", jumpToReview);
      });
      root.querySelectorAll(".js-plan-practice").forEach(function (button) {
        button.addEventListener("click", function () {
          runtime.practicePreset = { subject: button.dataset.section || "all" };
          navigate("exams/practice");
        });
      });
      root.querySelectorAll(".js-retake-test").forEach(function (button) {
        button.addEventListener("click", function () {
          navigate("instructions/" + attempt.testId);
        });
      });
    }

    function bindDetailInteractions(root) {
      bindPlanActions(root);
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
    // Covers the hero, notice, plan and detail cards on first render.
    bindDetailInteractions(app);

    function bindReviewButtons() {
      app.querySelectorAll(".js-ask-mentor-question:not(.bound)").forEach(function (button) {
        button.classList.add("bound");
        button.addEventListener("click", function () {
          askMentorAboutQuestion(attempt.id, button.dataset.qid, button.dataset.label, button);
        });
      });
      app.querySelectorAll(".js-report-question:not(.bound)").forEach(function (button) {
        button.classList.add("bound");
        button.addEventListener("click", function () {
          openReportQuestionDialog(attempt.id, button.dataset.qid, Number(button.dataset.number), button);
        });
      });
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
                store.addBookmark(user.id, Object.assign({}, qObj, { testId: attempt.testId }));
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
        statusEl.textContent = "Loading questions…";
        if (reset) {
          page = 1;
          listEl.innerHTML = "";
        }
        store.getAttemptQuestionReview(attempt.id, page, limit)
          .then(function (payload) {
            var items = payload && payload.questions ? payload.questions : [];
            var pagination = payload && payload.pagination ? payload.pagination : { hasMore: false };
            if (!items.length && page === 1) {
              listEl.innerHTML = '<div class="empty-state">Question review isn\'t ready for this attempt yet. Check back in a minute.</div>';
            } else {
              listEl.insertAdjacentHTML("beforeend", buildQuestionReviewItems(items, (page - 1) * limit));
            }
            loadedOnce = true;
            statusEl.textContent = "";
            updateButtons(Boolean(pagination.hasMore));
            bindReviewButtons();
            renderLatexInElement(listEl);
            activateAnalysisAnimations(listEl);
            page += 1;
          })
          .catch(function (error) {
            statusEl.textContent = error && error.message ? error.message : "Couldn't load the questions. Try again.";
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

    activateAnalysisAnimations(app, { instant: revealSeen });
    markResultRevealSeen(attempt.id);
    mountQuestionReviewLoader();
    app.querySelectorAll(".js-practise-mistakes").forEach(function (button) {
      button.addEventListener("click", function () { startMistakePractice(user, 10, "all"); });
    });

    if (store.getAttemptAnalysis) {
      var needsAnalysis = !analysis && !prefetchedSummary;
      store.getAttemptAnalysis(attempt.id).then(function (summary) {
        if (!summary) return;
        mountTimeInsights(document.getElementById("rs-time-insights-root"), summary.timeInsights);
        if (!needsAnalysis) return;
        if (summary.analysis) {
          analysis = summary.analysis;
        }
        var derivedSectionScores = buildSectionScoresFromSummary(summary);
        if (derivedSectionScores) {
          sectionScores = derivedSectionScores;
        }
        result.analysis = analysis || result.analysis || null;
        if (derivedSectionScores) {
          result.sectionScores = derivedSectionScores;
        }
        var summaryRoot = document.getElementById("analysis-summary-root");
        var detailRoot = document.getElementById("analysis-detail-root");
        var reviewRoot = document.getElementById("analysis-review-root");
        var heroSub = document.getElementById("rs-hero-sub");
        var planBody = document.getElementById("rs-plan-body");
        if (heroSub) heroSub.innerHTML = buildHeroSentence(analysis);
        if (planBody) {
          planBody.innerHTML = buildPlanBody(analysis);
          bindPlanActions(planBody);
        }
        if (summaryRoot) {
          summaryRoot.className = "rs-row rs-top" + (analysis && analysis.timeAnalysis ? "" : " is-solo");
          summaryRoot.innerHTML = buildTopRow(analysis);
          activateAnalysisAnimations(summaryRoot);
        }
        if (detailRoot) {
          detailRoot.className = detailRowClass(analysis);
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

  // AI coach (Results): the AI's read of a full mock, shown only once an AI interpretation is
  // ready. While it is being written one quiet line says so; otherwise nothing is shown and
  // the rule-based plan stands on its own. Numbers in AI text were checked on the server.
  function renderCoachCard(attemptId, data) {
    var root = document.getElementById("rs-coach-root");
    if (!root || root.getAttribute("data-attempt") !== String(attemptId)) return;
    var result = (data && data.result) || {};
    if (data && data.pending) {
      if (!root.querySelector(".rs-coach-pending")) {
        root.innerHTML = '<p class="rs-coach-pending">Your AI coach is reviewing this attempt…</p>';
      }
      return;
    }
    if (!data || data.source !== "ai" || !(result.headline || result.summary)) {
      root.innerHTML = "";
      return;
    }
    var pick = function (items, max) {
      return (Array.isArray(items) ? items : []).filter(Boolean).slice(0, max);
    };
    var item = function (text) { return '<li>' + escapeHtml(text) + '</li>'; };
    var strengths = pick(result.strengths, 3);
    var focus = pick(result.priorityAreas, 3).filter(function (area) { return area && area.topic; });
    var habits = pick(result.behaviorPatterns, 2);
    var strategy = pick(result.nextTestStrategy, 3);
    var focusHtml = (focus.length || habits.length)
      ? '<div class="rs-coach-col"><h4>Focus next</h4>' +
        (focus.length ? '<ul class="rs-coach-focus">' + focus.map(function (area) {
          return '<li><strong>' + escapeHtml(formatTopicName(area.topic)) + '</strong>' +
            (area.reason ? '<span>' + escapeHtml(area.reason) + '</span>' : '') +
            (area.action ? '<span class="rs-coach-action">Next: ' + escapeHtml(area.action) + '</span>' : '') +
            '</li>';
        }).join("") + '</ul>' : '') +
        (habits.length ? '<p class="rs-coach-sublabel">Habits to watch</p><ul class="rs-coach-list">' + habits.map(item).join("") + '</ul>' : '') +
        '</div>'
      : '';
    var strengthsHtml = strengths.length
      ? '<div class="rs-coach-col"><h4>What&rsquo;s working</h4><ul class="rs-coach-list">' + strengths.map(item).join("") + '</ul></div>'
      : '';
    root.innerHTML =
      '<section class="rs-card rs-coach" aria-labelledby="rs-coach-title">' +
      '<div class="rs-card-head"><h2 class="section-label" id="rs-coach-title">AI coach</h2><span class="rs-ai-chip">AI-assisted</span></div>' +
      (result.headline ? '<h3 class="rs-coach-headline">' + escapeHtml(result.headline) + '</h3>' : '') +
      (result.summary ? '<p class="rs-coach-summary">' + escapeHtml(result.summary) + '</p>' : '') +
      (strengthsHtml || focusHtml ? '<div class="rs-coach-grid">' + strengthsHtml + focusHtml + '</div>' : '') +
      (strategy.length ? '<div class="rs-coach-strategy"><h4>Strategy for your next mock</h4><ol>' + strategy.map(item).join("") + '</ol></div>' : '') +
      '<p class="rs-coach-disclosure">Written with help from an AI service. Your score, rank and percentile are always calculated by AceIIIT.</p>' +
      '</section>';
  }

  function mountCoachCard(attemptId) {
    if (!store.getInterpretation) return;
    var polls = 0;
    var load = function () {
      var root = document.getElementById("rs-coach-root");
      if (!root || root.getAttribute("data-attempt") !== String(attemptId)) return;
      Promise.resolve(store.getInterpretation(attemptId)).then(function (data) {
        polls += 1;
        if (data && data.pending && polls >= 30) data = null; // gave up waiting: show nothing
        renderCoachCard(attemptId, data);
        if (data && data.pending) window.setTimeout(load, 4000);
      }).catch(function () {
        renderCoachCard(attemptId, null); // the plan stands on its own
      });
    };
    load();
  }

  // ---- ACEIIIT Mentor orb ------------------------------------------------------------------
  // A port of the MorphOrb "thinking orb": a dotted sphere drawn on a small canvas. Dots appear
  // top-first (assemble), light up in turn while the mentor works (one light pattern per stage
  // label), sweep to the brand gold when the reply is ready (resolve), then spiral in (condense)
  // as the reply takes their place. It draws only while it's on screen; reduced motion gets a
  // still frame and no movement.
  var MentorOrb = (function () {
    var TAU = Math.PI * 2;
    var clamp01 = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };

    function cubicBezier(x1, y1, x2, y2) {
      var cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
      var cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
      var sx = function (t) { return ((ax * t + bx) * t + cx) * t; };
      var sy = function (t) { return ((ay * t + by) * t + cy) * t; };
      var dx = function (t) { return (3 * ax * t + 2 * bx) * t + cx; };
      return function (x) {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        var t = x;
        for (var i = 0; i < 8; i += 1) {
          var e = sx(t) - x;
          if (Math.abs(e) < 1e-6) return sy(t);
          var d = dx(t);
          if (Math.abs(d) < 1e-6) break;
          t -= e / d;
        }
        var lo = 0, hi = 1;
        t = x;
        for (var j = 0; j < 40; j += 1) {
          var v = sx(t);
          if (Math.abs(v - x) < 1e-6) break;
          if (x > v) lo = t; else hi = t;
          t = (hi - lo) / 2 + lo;
        }
        return sy(t);
      };
    }

    // The MorphOrb curves (also used as CSS strings for WAAPI below).
    var CURVES = {
      out: [0.22, 1, 0.36, 1],
      io: [0.65, 0, 0.35, 1],
      fly: [0.5, 0, 0.1, 1],
      vortex: [0.6, 0, 0.2, 1],
      card: [0.65, 0, 0.2, 1]
    };
    var EASE = {};
    var CSS = {};
    Object.keys(CURVES).forEach(function (name) {
      var c = CURVES[name];
      EASE[name] = cubicBezier(c[0], c[1], c[2], c[3]);
      CSS[name] = "cubic-bezier(" + c.join(", ") + ")";
    });

    var DOTS = (function () {
      var a = 7;
      var rand = function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        var t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      var RINGS = 14;
      var out = [];
      for (var k = 0; k < RINGS; k += 1) {
        var y = 1 - ((k + 0.5) / RINGS) * 2;
        var r = Math.sqrt(1 - y * y);
        var m = Math.max(4, Math.round(24 * r));
        for (var j = 0; j < m; j += 1) {
          var ang = (j / m) * TAU + k * 0.35;
          out.push({ x: Math.cos(ang) * r, y: y, z: Math.sin(ang) * r, u: (1 - y) / 2, seed: rand() * TAU });
        }
      }
      return out;
    })();
    var N = DOTS.length;

    var G_STEPS = 16, A_STEPS = 32;
    var palettes = {};
    function palette(dark) {
      var key = dark ? "dark" : "light";
      if (palettes[key]) return palettes[key];
      var base = dark ? [236, 230, 219] : [38, 32, 27];
      var gold = dark ? [215, 179, 74] : [168, 132, 17];
      var out = [];
      for (var gi = 0; gi <= G_STEPS; gi += 1) {
        var g = gi / G_STEPS;
        var rgb = [0, 1, 2].map(function (i) { return Math.round(base[i] + (gold[i] - base[i]) * g); });
        for (var ai = 0; ai <= A_STEPS; ai += 1) out.push("rgba(" + rgb.join(",") + "," + (ai / A_STEPS).toFixed(3) + ")");
      }
      palettes[key] = out;
      return out;
    }

    function reduced() {
      return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    }

    function isDark() {
      return document.body.getAttribute("data-theme") === "dark";
    }

    function create(options) {
      options = options || {};
      var SIZE = 64;
      var R = 22;
      var el = document.createElement("div");
      el.className = "mentor-orb";
      el.innerHTML =
        '<span class="mentor-orb-stage" aria-hidden="true">' +
        '<canvas class="mentor-orb-canvas"></canvas>' +
        '<span class="mentor-orb-done"></span>' +
        '<span class="mentor-orb-pulse"></span>' +
        '</span>' +
        '<span class="mentor-orb-label"></span>';
      var canvas = el.querySelector("canvas");
      var labelEl = el.querySelector(".mentor-orb-label");
      var ctx = canvas.getContext ? canvas.getContext("2d") : null;
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(SIZE * dpr);
      canvas.height = Math.round(SIZE * dpr);
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      var P = { k: 0, alpha: 0, spin: 0, rot: 0, sweep: 0, pop: 1, vortex: 0, gain: 1, floor: 0, rad: 0, prog: 0 };
      var lit = new Float32Array(N);
      var SX = new Float32Array(N), SY = new Float32Array(N), SR = new Float32Array(N), SD = new Float32Array(N);
      var SC = new Int16Array(N);
      var pw = [1, 0, 0];
      var time = 0, raf = 0, last = 0, dead = false, looping = false;
      var labelTimer = 0;
      var CP = Math.cos(0.35), SP = Math.sin(0.35), C0 = SIZE / 2, S = 0.6;

      function draw(dt) {
        if (!ctx) return;
        ctx.clearRect(0, 0, SIZE, SIZE);
        time += dt;
        P.rot += P.spin * dt;
        var yaw = P.rot + P.vortex, cyw = Math.cos(yaw), syw = Math.sin(yaw);
        var stepW = dt / 0.35;
        for (var q = 0; q < 3; q += 1) {
          var dw = (q === P.prog ? 1 : 0) - pw[q];
          pw[q] += Math.abs(dw) <= stepW ? dw : dw > 0 ? stepW : -stepW;
        }
        var decay = Math.exp(-dt / 0.5);
        var h0 = (time * 220) % N;
        var a1 = time * 0.8, b1 = Math.sin(time * 0.5) * 0.9;
        var f1x = Math.cos(b1) * Math.cos(a1), f1y = Math.sin(b1), f1z = Math.cos(b1) * Math.sin(a1);
        var a2 = time * 0.55 + 2.1, b2 = Math.cos(time * 0.42) * 0.9;
        var f2x = Math.cos(b2) * Math.cos(a2), f2y = Math.sin(b2), f2z = Math.cos(b2) * Math.sin(a2);
        var lat = Math.sin(time * 2.2);
        var swirlK = P.vortex * 1.5;
        var colors = palette(isDark());

        for (var n = 0; n < N; n += 1) {
          var d = DOTS[n];
          var pulse = 0;
          if (pw[0] > 0.001) {
            var dd = Math.abs(n - h0);
            if (dd > N - dd) dd = N - dd;
            var v0 = Math.max(0, 1 - dd / 14);
            pulse = Math.max(pulse, v0 * v0 * pw[0]);
          }
          if (pw[1] > 0.001) {
            var v1 = Math.max(0, (d.x * f1x + d.y * f1y + d.z * f1z - 0.72) / 0.28);
            var v2 = Math.max(0, (d.x * f2x + d.y * f2y + d.z * f2z - 0.72) / 0.28);
            var vv = Math.max(v1, v2);
            pulse = Math.max(pulse, vv * vv * pw[1]);
          }
          if (pw[2] > 0.001) {
            var e = d.y - lat;
            var v3 = Math.max(0, 1 - (e * e) / 0.02);
            pulse = Math.max(pulse, v3 * v3 * pw[2]);
          }
          var l = Math.max(lit[n] * decay, pulse * P.gain);
          lit[n] = l;

          var ki = clamp01(P.k * (1 + S) - S * d.u);
          if (ki <= 0.001) { SC[n] = -1; continue; }
          var eo = EASE.out(ki), kk = eo * P.pop;
          var x1 = d.x * cyw + d.z * syw, z1 = -d.x * syw + d.z * cyw;
          var y2 = d.y * CP - z1 * SP, z2 = d.y * SP + z1 * CP;
          var f = 2.8 / (2.8 - z2), depth = (z2 + 1) / 2;
          var ox = x1 * R * kk * f, oy = -y2 * R * kk * f;
          if (swirlK > 0.001) {
            var sw = (1 - ki) * swirlK, cc = Math.cos(sw), ss = Math.sin(sw);
            var tx = ox * cc - oy * ss;
            oy = ox * ss + oy * cc;
            ox = tx;
          }
          var g = clamp01((P.sweep * 1.4 - d.u) / 0.4);
          var a = 0.12 + 0.04 * Math.sin(d.seed + time * 1.6) * (1 - g) + 0.34 * depth * depth + 0.7 * l * (1 - g) + g * (0.55 + 0.4 * depth) + 2 * g * (1 - g);
          a = Math.max(a, P.floor * (0.7 + 0.3 * depth));
          if (a > 1) a = 1;
          a *= eo * P.alpha;
          SX[n] = C0 + ox;
          SY[n] = C0 + oy;
          SD[n] = depth;
          SR[n] = (0.62 * (0.45 + 0.75 * depth) * f + 0.55 * l + g * 0.18) * (1 + P.rad) * (0.4 + 0.6 * eo);
          var ai = Math.round(a * A_STEPS), gi = Math.round(g * G_STEPS);
          SC[n] = ai <= 0 ? -1 : gi * (A_STEPS + 1) + ai;
        }
        // Back half first, then the front half over it.
        for (var pass = 0; pass < 2; pass += 1) {
          for (var m = 0; m < N; m += 1) {
            var c = SC[m];
            if (c < 0 || (SD[m] >= 0.5) !== (pass === 1)) continue;
            ctx.fillStyle = colors[c];
            ctx.beginPath();
            ctx.arc(SX[m], SY[m], SR[m], 0, TAU);
            ctx.fill();
          }
        }
      }

      function frame(now) {
        raf = 0;
        if (dead) return;
        var dt = reduced() ? 0 : Math.max(0, Math.min(0.05, (now - last) / 1000));
        last = now;
        // Off screen (panel closed, element detached, tab hidden): stop drawing.
        if (!el.isConnected || el.offsetParent === null) return;
        draw(dt);
        if ((looping || tweening > 0) && P.alpha > 0.002 && !reduced()) raf = window.requestAnimationFrame(frame);
      }

      function ensure() {
        if (raf || dead) return;
        last = performance.now();
        raf = window.requestAnimationFrame(frame);
      }

      var tweening = 0;
      /** tracks: [key, from, to, t0, t1, ease]; resolves when the last track ends. */
      function play(tracks) {
        if (dead) return Promise.resolve();
        if (reduced()) {
          tracks.forEach(function (t) { P[t[0]] = t[2]; });
          ensure();
          return Promise.resolve();
        }
        tweening += 1;
        var end = tracks.reduce(function (mx, t) { return Math.max(mx, t[4]); }, 0);
        var start = performance.now();
        ensure();
        return new Promise(function (resolve) {
          function step(now) {
            if (dead) { tweening -= 1; resolve(); return; }
            var t = now - start;
            tracks.forEach(function (tr) {
              if (t < tr[3]) return;
              var p = Math.min(1, (t - tr[3]) / Math.max(1, tr[4] - tr[3]));
              P[tr[0]] = tr[1] + (tr[2] - tr[1]) * (tr[5] || EASE.io)(p);
            });
            ensure();
            if (t >= end || document.hidden) {
              tracks.forEach(function (tr) { P[tr[0]] = tr[2]; });
              tweening -= 1;
              resolve();
            } else {
              window.requestAnimationFrame(step);
            }
          }
          window.requestAnimationFrame(step);
        });
      }

      function setLabel(text) {
        if (!labelEl) return;
        var previous = labelEl.querySelector(".mentor-orb-word:not(.is-out)");
        if (previous && previous.getAttribute("data-text") === text) return;
        var next = document.createElement("span");
        next.className = "mentor-orb-word" + (text === "Done" ? " is-done" : "");
        next.setAttribute("data-text", text);
        next.innerHTML = escapeHtml(text) + (text === "Done" ? "" : '<span class="mentor-orb-ellipsis" aria-hidden="true"><i></i><i></i><i></i></span>');
        if (previous) {
          previous.classList.add("is-out");
          window.setTimeout(function () { if (previous.parentNode) previous.parentNode.removeChild(previous); }, 220);
        }
        labelEl.appendChild(next);
      }

      function stopLabels() {
        window.clearInterval(labelTimer);
        labelTimer = 0;
      }

      var api = {
        el: el,
        /** The empty-chat greeting: assembled, slowly turning, one soft light pattern. */
        idle: function () {
          el.classList.add("is-idle");
          looping = true;
          P.prog = 0;
          P.gain = 0.6;
          if (P.alpha < 1) {
            return play([["k", P.k, 1, 0, 800, EASE.out], ["alpha", P.alpha, 1, 0, 600, EASE.out], ["spin", P.spin, 0.35, 0, 800, EASE.out]]);
          }
          P.spin = 0.35;
          ensure();
          return Promise.resolve();
        },
        pause: function () {
          looping = false;
        },
        assemble: function () {
          el.classList.remove("is-idle");
          return play([
            ["k", P.k, 1, 0, 700, EASE.out],
            ["alpha", P.alpha, 1, 0, 500, EASE.out],
            ["spin", P.spin, 0.9, 0, 700, EASE.out],
            ["gain", P.gain, 1, 0, 300, EASE.out],
            ["pop", 1, 1.05, 0, 360, EASE.out],
            ["pop", 1.05, 1, 360, 700, EASE.io]
          ]);
        },
        /** Works through the stage labels (relevant to the question) until stopped. */
        think: function (stages) {
          el.classList.remove("is-idle");
          looping = true;
          P.spin = Math.max(P.spin, 0.9);
          P.gain = 1;
          var i = 0;
          setLabel(stages[0]);
          stopLabels();
          labelTimer = window.setInterval(function () {
            // 0, 1, 2, then 1, 2, 1, 2… so a long wait never claims to be "finishing".
            i = i < 2 ? i + 1 : 1;
            if (i >= stages.length) i = stages.length - 1;
            P.prog = i % 3;
            setLabel(stages[i]);
          }, 1150);
          ensure();
        },
        /** The reply is ready: dots sweep to gold, then spiral in to a single point. */
        finish: function () {
          stopLabels();
          setLabel("Done");
          if (reduced()) {
            el.classList.add("is-condensed");
            return Promise.resolve();
          }
          return play([
            ["sweep", 0, 1, 0, 520, EASE.io],
            ["spin", P.spin, 0.3, 0, 520, EASE.out],
            ["gain", 1, 0, 0, 520, EASE.out],
            ["floor", 0, 0.95, 260, 620, EASE.out],
            ["rad", 0, 0.15, 260, 620, EASE.out]
          ]).then(function () {
            el.classList.add("is-condensed");
            return play([
              ["pop", 1, 1.06, 0, 110, EASE.out],
              ["k", 1, 0, 110, 520, EASE.vortex],
              ["vortex", 0, 1.6, 110, 520, EASE.vortex],
              ["alpha", 1, 0, 380, 560, EASE.out]
            ]);
          });
        },
        fade: function () {
          stopLabels();
          looping = false;
          return play([["alpha", P.alpha, 0, 0, 200, EASE.out]]);
        },
        destroy: function () {
          stopLabels();
          dead = true;
          if (raf) window.cancelAnimationFrame(raf);
          raf = 0;
          if (el.parentNode) el.parentNode.removeChild(el);
        },
        resume: ensure
      };
      return api;
    }

    return { create: create, reduced: reduced, CSS: CSS };
  })();

  /** Stage labels that match what the student asked (shown while the mentor works). */
  function mentorStages(text, aboutAttempt) {
    var t = String(text || "").toLowerCase();
    if (/mistake|wrong|incorrect|losing marks|lose marks|negative/.test(t)) return ["Opening your attempt", "Finding where marks went", "Checking the right method"];
    if (/compare|trend|improv|progress|better|worse/.test(t)) return ["Reading your recent mocks", "Lining them up", "Spotting the trend"];
    if (/plan|revision|revise|schedule|timetable|routine/.test(t)) return ["Reading your results", "Finding weak topics", "Building your plan"];
    if (/weak|strong|topic|section|supr|reap/.test(t)) return ["Reading your results", "Ranking your topics", "Looking for patterns"];
    if (aboutAttempt || /\b(my|me|i|i'm|mock|test|attempt|score|marks|rank|percentile|accuracy|time|timing|pace|result)\b/.test(t)) {
      return ["Reading your results", "Checking accuracy and time", "Looking for patterns"];
    }
    return ["Thinking", "Working it out", "Checking each step"];
  }

  /**
   * Ink-in: the reply's words surface one after another (a quick blur-and-fade, about 0.7 s in
   * all), so a reply that arrives whole still reads like it's being written. Long replies unfold
   * by paragraph instead. The text is in the DOM from the start (screen readers get it at once),
   * and any click or key finishes the reveal immediately.
   */
  function revealMentorReply(bubble) {
    if (!bubble || typeof bubble.animate !== "function" || MentorOrb.reduced()) return;
    bubble.setAttribute("data-revealing", "true");
    bubble.animate([{ opacity: 0, transform: "scale(0.98)" }, { opacity: 1, transform: "none" }], { duration: 220, easing: MentorOrb.CSS.out });
    var words = wrapMentorWords(bubble);
    var total = 0;
    if (words.length && words.length <= 220) {
      var step = Math.min(24, 680 / words.length);
      words.forEach(function (word, i) {
        word.animate(
          [{ opacity: 0, transform: "translateY(3px)", filter: "blur(3px)" }, { opacity: 1, transform: "none", filter: "blur(0px)" }],
          { duration: 260, delay: 40 + i * step, easing: MentorOrb.CSS.out, fill: "backwards" }
        );
      });
      total = 40 + words.length * step + 260;
    } else {
      var blocks = [];
      Array.prototype.forEach.call(bubble.children, function (child) {
        if (child.tagName === "UL" || child.tagName === "OL") Array.prototype.forEach.call(child.children, function (li) { blocks.push(li); });
        else blocks.push(child);
      });
      blocks = blocks.slice(0, 16);
      var stagger = blocks.length > 1 ? Math.min(45, 360 / (blocks.length - 1)) : 0;
      blocks.forEach(function (block, i) {
        block.animate(
          [{ opacity: 0, transform: "translateY(4px)", filter: "blur(4px)" }, { opacity: 1, transform: "none", filter: "blur(0px)" }],
          { duration: 320, delay: 60 + i * stagger, easing: MentorOrb.CSS.out, fill: "backwards" }
        );
      });
      total = 60 + blocks.length * stagger + 320;
    }
    window.setTimeout(function () { bubble.removeAttribute("data-revealing"); }, total + 50);
  }

  /** Wraps each word of a reply in a span (maths, code and very long tokens stay as they are). */
  function wrapMentorWords(root) {
    var spans = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var parent = node.parentNode;
        if (parent && parent.closest && parent.closest(".katex, code, pre")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (node) {
      var parts = node.nodeValue.split(/(\s+)/);
      var frag = document.createDocumentFragment();
      parts.forEach(function (part) {
        if (!part) return;
        if (/^\s+$/.test(part) || part.length > 32) {
          frag.appendChild(document.createTextNode(part));
          return;
        }
        var span = document.createElement("span");
        span.className = "mentor-word";
        span.textContent = part;
        frag.appendChild(span);
        spans.push(span);
      });
      node.parentNode.replaceChild(frag, node);
    });
    return spans;
  }

  function finishMentorReveal() {
    var s = mentorState;
    if (!s || !s.el) return;
    Array.prototype.forEach.call(s.el.querySelectorAll("[data-revealing]"), function (bubble) {
      if (typeof bubble.getAnimations === "function") {
        bubble.getAnimations({ subtree: true }).forEach(function (anim) { try { anim.finish(); } catch (_e) { } });
      }
      bubble.removeAttribute("data-revealing");
    });
  }

  /** The sent message travels from where it was written (the chip or the box) into the chat. */
  function landMentorMessage(fromRect) {
    if (MentorOrb.reduced() || !fromRect || !fromRect.width) return;
    var bubbles = mentorState.el ? mentorState.el.querySelectorAll(".mentor-msg.is-user .mentor-bubble") : [];
    var bubble = bubbles[bubbles.length - 1];
    if (!bubble || typeof bubble.animate !== "function") return;
    var to = bubble.getBoundingClientRect();
    var dx = fromRect.left - to.left;
    var dy = fromRect.top - to.top;
    if (Math.abs(dy) > 700) return;
    bubble.animate(
      [{ transform: "translate(" + dx.toFixed(1) + "px," + dy.toFixed(1) + "px) scale(0.96)", opacity: 0.7 }, { transform: "none", opacity: 1 }],
      { duration: 300, easing: "cubic-bezier(0.32, 0.72, 0, 1)" }
    );
  }

  /** Send: the arrow flies up and out while a fresh one rises into place. */
  function launchMentorSendArrow(button) {
    var icon = button && button.querySelector("svg");
    if (!icon || typeof icon.animate !== "function") return;
    icon.animate(
      [
        { transform: "none", opacity: 1 },
        { transform: "translateY(-130%)", opacity: 0, offset: 0.45 },
        { transform: "translateY(130%)", opacity: 0, offset: 0.46 },
        { transform: "none", opacity: 1 }
      ],
      { duration: 380, easing: MentorOrb.CSS.out }
    );
  }

  /** "12 of 100 replies remaining": a small ring plus a number that rolls when a reply is used. */
  function renderMentorUsage(el, usage) {
    var text = mentorUsageLine(usage);
    if (!usage || !text) {
      el.textContent = "";
      el.removeAttribute("data-remaining");
      return;
    }
    var remaining = Math.max(0, Number(usage.remaining) || 0);
    var limit = Math.max(1, Number(usage.limit) || 1);
    var before = el.hasAttribute("data-remaining") ? Number(el.getAttribute("data-remaining")) : remaining;
    if (el.getAttribute("data-text") === text) return;
    var rest = text.slice(String(remaining).length);
    el.innerHTML = '<span class="mentor-meter" aria-hidden="true" style="--mentor-p:' + (remaining / limit).toFixed(3) + '"></span>' +
      '<span class="mentor-roll"><span>' + remaining + '</span></span>' + escapeHtml(rest);
    el.setAttribute("data-text", text);
    el.setAttribute("data-remaining", String(remaining));
    if (remaining < before && !MentorOrb.reduced()) {
      var digits = el.querySelector(".mentor-roll span");
      if (digits && typeof digits.animate === "function") {
        digits.animate([{ transform: "translateY(90%)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 280, easing: MentorOrb.CSS.out });
      }
    }
  }

  function showMentorNewPill(on) {
    var pill = mentorPart("[data-mentor-newpill]");
    if (!pill) return;
    if (on) {
      var panel = mentorPart(".mentor-panel");
      var body = mentorPart("[data-mentor-body]");
      if (panel && body) pill.style.bottom = Math.max(8, panel.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom + 10) + "px";
      pill.hidden = false;
      window.requestAnimationFrame(function () { pill.setAttribute("data-state", "open"); });
    } else {
      pill.removeAttribute("data-state");
      pill.hidden = true;
    }
  }

  function mentorMessageFor(button) {
    var bubble = button.closest(".mentor-msg") && button.closest(".mentor-msg").querySelector("[data-mentor-msg-id]");
    var id = bubble ? bubble.getAttribute("data-mentor-msg-id") : "";
    return mentorState.messages.filter(function (m) { return String(m.id) === id; })[0] || null;
  }

  function copyMentorReply(button) {
    var message = mentorMessageFor(button);
    if (!message) return;
    var done = function () {
      button.classList.add("is-done");
      button.innerHTML = MENTOR_ICONS.check + "<span>Copied</span>";
      mentorAnnounce("Reply copied.");
      window.setTimeout(function () {
        if (!button.isConnected) return;
        button.classList.remove("is-done");
        button.innerHTML = MENTOR_ICONS.copy + "<span>Copy</span>";
      }, 1600);
    };
    var text = String(message.content || "");
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { mentorAnnounce("Couldn't copy. Select the text instead."); });
    } else {
      mentorAnnounce("Couldn't copy. Select the text instead.");
    }
  }

  function quoteMentorReply(button) {
    var message = mentorMessageFor(button);
    var input = mentorPart("#mentor-input");
    if (!message || !input || input.closest("[hidden]")) return;
    var plain = String(message.content || "").replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "").replace(/[*_#>`]/g, "").replace(/\s+/g, " ").trim();
    var snippet = plain.length > 90 ? plain.slice(0, 89).replace(/\s+\S*$/, "") + "…" : plain;
    input.value = "About “" + snippet + "”: ";
    mentorState.draft = input.value;
    sizeMentorInput(input);
    updateMentorCount();
    var composer = mentorPart("[data-mentor-composer]");
    if (composer) composer.classList.add("has-text");
    input.focus();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (_e) { }
  }

  /** MorphOrb's launch: a small spark flies from the send button into the waiting orb. */
  function flyMentorSpark(fromEl, toEl) {
    if (!fromEl || !toEl || MentorOrb.reduced() || typeof document.body.animate !== "function") return;
    var a = fromEl.getBoundingClientRect();
    var b = toEl.getBoundingClientRect();
    if (!a.width || !b.width) return;
    var x0 = a.left + a.width / 2, y0 = a.top + a.height / 2;
    var x1 = b.left + b.width / 2, y1 = b.top + b.height / 2;
    var cx = x0 + (x1 - x0) * 0.2 - 40, cy = Math.min(y0, y1) - 30;
    var spark = document.createElement("span");
    spark.className = "mentor-spark";
    spark.setAttribute("aria-hidden", "true");
    document.body.appendChild(spark);
    var frames = [];
    for (var i = 0; i <= 12; i += 1) {
      var t = i / 12, u = 1 - t;
      var x = u * u * x0 + 2 * u * t * cx + t * t * x1;
      var y = u * u * y0 + 2 * u * t * cy + t * t * y1;
      var scale = 1 + Math.sin(t * Math.PI) * 0.6;
      frames.push({ transform: "translate3d(" + x.toFixed(1) + "px," + y.toFixed(1) + "px,0) translate(-50%,-50%) scale(" + scale.toFixed(2) + ")", opacity: t > 0.85 ? (1 - t) / 0.15 : 1 });
    }
    var anim = spark.animate(frames, { duration: 520, easing: MentorOrb.CSS.fly });
    anim.onfinish = anim.oncancel = function () { if (spark.parentNode) spark.parentNode.removeChild(spark); };
  }

  /**
   * The morphing popover: the floating button grows into the panel (a clip-path from the
   * button's exact shape), its pill crossfading into the panel; closing shrinks it back.
   */
  function morphMentorPanel(opening, done) {
    var s = mentorState;
    var panel = s.el && s.el.querySelector(".mentor-panel");
    var toggle = document.querySelector(".js-mentor-toggle");
    (s.morphAnims || []).forEach(function (anim) { try { anim.cancel(); } catch (_e) { } });
    s.morphAnims = [];
    var finish = function () { if (typeof done === "function") done(); };
    if (!panel || typeof panel.animate !== "function") { finish(); return; }
    var parts = Array.prototype.slice.call(panel.querySelectorAll(":scope > .mentor-head, :scope > .mentor-body, :scope > .mentor-foot"));
    var tr = toggle ? toggle.getBoundingClientRect() : null;
    if (MentorOrb.reduced() || !tr || !tr.width) {
      var fade = panel.animate(opening ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: "ease", fill: opening ? "none" : "forwards" });
      s.morphAnims.push(fade);
      fade.onfinish = finish;
      return;
    }
    var pr = panel.getBoundingClientRect();
    var from = "inset(" + [tr.top - pr.top, pr.right - tr.right, pr.bottom - tr.bottom, tr.left - pr.left].map(function (v) { return Math.round(v) + "px"; }).join(" ") + " round " + Math.round(tr.height / 2) + "px)";
    var to = "inset(-48px -48px -48px -48px round 66px)";
    var skin = panel.querySelector(".mentor-skin");
    if (!skin) {
      skin = document.createElement("div");
      skin.className = "support-chat-button mentor-skin";
      skin.setAttribute("aria-hidden", "true");
      panel.appendChild(skin);
    }
    skin.innerHTML = toggle.innerHTML;
    skin.style.left = Math.round(tr.left - pr.left) + "px";
    skin.style.top = Math.round(tr.top - pr.top) + "px";
    skin.style.width = Math.round(tr.width) + "px";
    skin.style.height = Math.round(tr.height) + "px";
    var duration = opening ? 440 : 300;
    var easing = opening ? "cubic-bezier(0.32, 0.72, 0, 1)" : MentorOrb.CSS.card;
    var clip = panel.animate(
      opening ? [{ clipPath: from }, { clipPath: to }] : [{ clipPath: to }, { clipPath: from }],
      { duration: duration, easing: easing, fill: opening ? "none" : "forwards" }
    );
    var skinAnim = skin.animate(
      opening ? [{ opacity: 1 }, { opacity: 0, offset: 0.45 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }],
      { duration: duration, easing: "linear", fill: "forwards" }
    );
    s.morphAnims.push(clip, skinAnim);
    parts.forEach(function (part) {
      s.morphAnims.push(part.animate(
        opening ? [{ opacity: 0 }, { opacity: 0, offset: 0.28 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0, offset: 0.45 }, { opacity: 0 }],
        { duration: duration, easing: "linear", fill: opening ? "none" : "forwards" }
      ));
    });
    clip.onfinish = finish;
  }

  // ---- ACEIIIT Mentor --------------------------------------------------------------------
  // The floating help button opens the mentor: a chat panel on document.body, so route
  // re-renders leave it (and a reply being written) alone. Desktop: a non-modal panel above the
  // button. Phones: a near-full-screen modal sheet (focus trap, inert background, Back closes).
  // The server decides the tier and how many replies are left; this only shows them.
  var MENTOR_SUGGESTIONS = [
    "Analyse my latest mock test.",
    "Why am I losing marks?",
    "Identify my weakest topics.",
    "Compare my recent mock tests.",
    "How can I improve my accuracy?",
    "Create a personalised revision plan."
  ];
  var MENTOR_SHEET_QUERY = "(max-width: 780px)";
  var MENTOR_RETRYABLE = { MENTOR_PROVIDER_ERROR: true, MENTOR_BUSY: true, MENTOR_RATE_LIMITED: true, MENTOR_IN_PROGRESS: true, OFFLINE: true };
  var MENTOR_ICONS = {
    history: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"/></svg>',
    minimise: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
    copy: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m5 12 5 5 9-10"/></svg>',
    quote: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 12h12M4 6h16M4 18h8"/></svg>'
  };
  // For a conversation about one question (Ask Mentor on a review card).
  var MENTOR_QUESTION_SUGGESTIONS = [
    "Why is my answer wrong?",
    "Explain the solution step by step.",
    "Give me a similar question to try.",
    "What concept does this question test?"
  ];
  // Shown under the newest reply: the obvious next questions, one tap away.
  var MENTOR_FOLLOWUPS = [
    "Explain that more simply.",
    "Turn this into a 7-day plan.",
    "Give me 3 practice questions on this."
  ];

  function createMentorState(userId) {
    return {
      userId: userId || null,
      el: null,
      open: false,
      sheet: false,
      view: "chat",
      usage: null,
      usageError: false,
      conversations: null,
      conversationsError: "",
      conversationId: null,
      conversation: null,
      messages: [],
      loadingConversation: false,
      loadError: "",
      linkAttemptId: null,
      routeAttemptId: null,
      routeKey: "",
      autoLinkedAttemptId: null,
      sending: null,
      sendError: null,
      notice: "",
      draft: "",
      upgradeDismissed: "",
      focusComposerOnLoad: false,
      orb: null,
      introOrb: null,
      revealId: null,
      morphAnims: [],
      releaseFocus: null,
      isolated: [],
      returnFocus: null,
      hideTimer: null
    };
  }
  var mentorState = createMentorState(null);

  function mentorUser() {
    return auth.getCurrentUser ? auth.getCurrentUser() : (store.getCurrentUser ? store.getCurrentUser() : null);
  }

  function mentorUserKey(user) {
    return user ? String(user.id || user._id || user.email || "") : "";
  }

  function mentorRememberKey() {
    return "aceiiit_mentor_conversation:" + mentorState.userId;
  }

  function mentorRemember() {
    try {
      if (mentorState.conversationId) sessionStorage.setItem(mentorRememberKey(), mentorState.conversationId);
      else sessionStorage.removeItem(mentorRememberKey());
    } catch (_e) { }
  }

  function mentorRecall() {
    try { return sessionStorage.getItem(mentorRememberKey()) || ""; } catch (_e) { return ""; }
  }

  function mentorNewMessageId() {
    var rand = "";
    try {
      var bytes = new Uint8Array(12);
      window.crypto.getRandomValues(bytes);
      rand = Array.prototype.map.call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    } catch (_e) {
      rand = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    }
    return "m" + Date.now().toString(36) + "-" + rand.slice(0, 24);
  }

  function mentorResetDate(usage) {
    if (!usage || !usage.resetsAt) return "";
    try {
      return new Date(usage.resetsAt).toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" });
    } catch (_e) {
      return "";
    }
  }

  function mentorShortDate(value) {
    if (!value) return "";
    try {
      return new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
    } catch (_e) {
      return "";
    }
  }

  function mentorAttemptLabel(attemptId) {
    try {
      var attempt = store.getAttemptById ? store.getAttemptById(attemptId) : null;
      var test = attempt && store.getTestById ? store.getTestById(attempt.testId) : null;
      if (test && test.title) return test.title;
    } catch (_e) { }
    return "the result on screen";
  }

  function mentorSafeUrl(url) {
    return /^https:\/\//i.test(String(url || "")) ? String(url) : PROGRAMME_URL;
  }

  // Mentor replies: a small, safe Markdown subset. Everything is escaped first; only paragraphs,
  // line breaks, **bold**, `code`, ``` blocks, headings and lists become markup. Links stay
  // plain text. Maths is left as text for KaTeX (renderLatexInElement).
  function mentorInline(text) {
    return escapeHtml(text)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  }

  function mentorTextBlocks(chunk) {
    var out = [];
    var para = [];
    var list = null;
    var flushPara = function () {
      if (para.length) out.push("<p>" + para.map(mentorInline).join("<br>") + "</p>");
      para = [];
    };
    var flushList = function () {
      if (!list) return;
      out.push("<" + list.type + (list.type === "ol" && list.start > 1 ? ' start="' + list.start + '"' : "") + ">" +
        list.items.map(function (item) { return "<li>" + mentorInline(item) + "</li>"; }).join("") +
        "</" + list.type + ">");
      list = null;
    };
    chunk.split("\n").forEach(function (raw) {
      var line = raw.replace(/\s+$/, "");
      if (!line.trim()) {
        flushPara();
        flushList();
        return;
      }
      var heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
      if (heading) {
        flushPara();
        flushList();
        out.push('<p class="mentor-md-heading"><strong>' + mentorInline(heading[1].replace(/\*\*/g, "")) + "</strong></p>");
        return;
      }
      var bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
      var numbered = /^\s*(\d{1,2})[.)]\s+(.*)$/.exec(line);
      if (bullet || numbered) {
        flushPara();
        var type = bullet ? "ul" : "ol";
        if (!list || list.type !== type) {
          flushList();
          list = { type: type, items: [], start: numbered ? Number(numbered[1]) : 1 };
        }
        list.items.push(bullet ? bullet[1] : numbered[2]);
        return;
      }
      if (list && /^\s{2,}\S/.test(raw)) {
        list.items[list.items.length - 1] += " " + line.trim();
        return;
      }
      flushList();
      para.push(line);
    });
    flushPara();
    flushList();
    return out.join("");
  }

  function renderMentorMarkdown(text) {
    return String(text || "").replace(/\r\n?/g, "\n").split("```").map(function (part, index) {
      if (index % 2 === 1) return '<pre class="mentor-code"><code>' + escapeHtml(part.replace(/^[a-z0-9+#-]*\n/i, "")) + "</code></pre>";
      return mentorTextBlocks(part);
    }).join("");
  }

  function mentorUsageLine(usage) {
    if (!usage) return "";
    var remaining = Math.max(0, Number(usage.remaining) || 0);
    var limit = Math.max(0, Number(usage.limit) || 0);
    return remaining + " of " + limit + (usage.tier === "enrolled" ? " replies" : " free replies") + " remaining this month.";
  }

  function mentorOutOfReplies(usage) {
    return Boolean(usage && usage.available !== false && Number(usage.remaining) <= 0);
  }

  function mentorUnavailableText(usage) {
    var reason = usage && usage.reason;
    if (reason === "disabled") return "ACEIIIT Mentor is switched off right now. Your conversations are still here to read.";
    if (reason === "daily_limit") return "ACEIIIT Mentor has reached today's limit for everyone. Please try again tomorrow. Nothing was taken from your allowance.";
    if (reason === "not_configured") return "ACEIIIT Mentor isn't set up yet. Please check back soon.";
    return "ACEIIIT Mentor can't reply right now. Please try again later. Nothing is taken from your allowance while it's paused.";
  }

  function buildMentorShellHtml() {
    var supportHref = "https://wa.me/" + encodeURIComponent(SUPPORT_WHATSAPP_NUMBER) + "?text=" + encodeURIComponent("Hi AceIIIT, I need help with the portal.");
    return (
      '<div class="mentor-backdrop" data-mentor-backdrop hidden></div>' +
      '<section class="mentor-panel" id="mentor-panel" role="dialog" aria-labelledby="mentor-title" aria-describedby="mentor-subtitle" hidden data-state="closed">' +
      '<header class="mentor-head">' +
      '<span class="mentor-avatar" aria-hidden="true"><img src="assets/favicon-current.jpeg" alt=""></span>' +
      '<div class="mentor-head-copy"><h2 class="mentor-title" id="mentor-title">ACEIIIT Mentor</h2>' +
      '<p class="mentor-subtitle" id="mentor-subtitle">AI guidance on your results</p></div>' +
      '<div class="mentor-head-actions">' +
      '<button type="button" class="mentor-icon-button" data-mentor-action="history" aria-pressed="false" aria-label="Your conversations" title="Your conversations">' + MENTOR_ICONS.history + '</button>' +
      '<button type="button" class="mentor-icon-button" data-mentor-action="new" aria-label="New conversation" title="New conversation">' + MENTOR_ICONS.plus + '</button>' +
      '<button type="button" class="mentor-icon-button" data-mentor-action="close" aria-label="Minimise ACEIIIT Mentor" title="Minimise (your conversation is kept)">' + MENTOR_ICONS.minimise + '</button>' +
      '</div>' +
      '</header>' +
      '<div class="mentor-body" data-mentor-body></div>' +
      '<button type="button" class="mentor-new-pill" data-mentor-newpill hidden>↓ New reply</button>' +
      '<footer class="mentor-foot">' +
      '<div class="mentor-status" data-mentor-status></div>' +
      '<form class="mentor-composer" data-mentor-composer novalidate>' +
      '<label class="sr-only" for="mentor-input">Message ACEIIIT Mentor</label>' +
      '<textarea id="mentor-input" class="mentor-input" rows="1" placeholder="Ask about your mocks or a doubt" aria-describedby="mentor-usage"></textarea>' +
      '<button type="submit" class="mentor-send" data-mentor-send aria-label="Send message">' + MENTOR_ICONS.send + '</button>' +
      '</form>' +
      '<p class="mentor-usage" id="mentor-usage"><span data-mentor-usage></span><span class="mentor-count" data-mentor-count></span></p>' +
      '<p class="mentor-fineprint">AI replies can be wrong, so check important advice. Account or payment question? <a href="' + escapeAttribute(supportHref) + '" target="_blank" rel="noreferrer">Chat with us on WhatsApp</a>.</p>' +
      '</footer>' +
      '<p class="sr-only" role="status" data-mentor-announce></p>' +
      '</section>'
    );
  }

  function ensureMentorPanel() {
    var s = mentorState;
    if (s.el && document.body.contains(s.el)) return s.el;
    var root = document.createElement("div");
    root.className = "mentor-root";
    root.innerHTML = buildMentorShellHtml();
    document.body.appendChild(root);
    s.el = root;
    bindMentorPanel(root);
    return root;
  }

  function mentorPart(selector) {
    return mentorState.el ? mentorState.el.querySelector(selector) : null;
  }

  function mentorAnnounce(text) {
    var region = mentorPart("[data-mentor-announce]");
    if (!region) return;
    region.textContent = "";
    window.setTimeout(function () { region.textContent = text; }, 60);
  }

  /** While the panel is open the floating button has become the panel, so it's hidden. */
  function setMentorToggleMorphed(on) {
    document.querySelectorAll(".js-mentor-toggle").forEach(function (button) {
      button.classList.toggle("is-morphed", on);
      if (on) button.setAttribute("inert", "");
    });
  }

  /** Closing: the button takes focus and clicks again straight away (it reappears after the morph). */
  function releaseMentorToggle() {
    document.querySelectorAll(".js-mentor-toggle").forEach(function (button) { button.removeAttribute("inert"); });
  }

  function setMentorToggles(expanded) {
    document.querySelectorAll(".js-mentor-toggle").forEach(function (button) {
      button.setAttribute("aria-expanded", expanded ? "true" : "false");
      if (mentorState.el) button.setAttribute("aria-controls", "mentor-panel");
    });
  }

  function mentorCanType() {
    var usage = mentorState.usage;
    return !usage || (usage.canReply !== false);
  }

  function focusMentorComposer() {
    var input = mentorPart("#mentor-input");
    var composer = mentorPart("[data-mentor-composer]");
    if (input && composer && !composer.hidden && !mentorState.sheet) {
      try { input.focus({ preventScroll: true }); } catch (_e) { }
      return;
    }
    var close = mentorPart('[data-mentor-action="close"]');
    if (close) {
      try { close.focus({ preventScroll: true }); } catch (_e) { }
    }
  }

  function openMentor(trigger) {
    var user = mentorUser();
    if (!user) return;
    if (mentorState.userId !== mentorUserKey(user)) resetMentor(mentorUserKey(user));
    var s = mentorState;
    var root = ensureMentorPanel();
    var panel = root.querySelector(".mentor-panel");
    var backdrop = root.querySelector("[data-mentor-backdrop]");
    if (s.open) {
      focusMentorComposer();
      return;
    }
    window.clearTimeout(s.hideTimer);
    s.open = true;
    s.returnFocus = trigger || document.activeElement;
    s.sheet = Boolean(window.matchMedia && window.matchMedia(MENTOR_SHEET_QUERY).matches);
    panel.classList.toggle("is-sheet", s.sheet);
    panel.setAttribute("aria-modal", s.sheet ? "true" : "false");
    panel.hidden = false;
    backdrop.hidden = !s.sheet;
    if (s.sheet) {
      lockBodyScroll();
      s.isolated = isolateBackground(root);
      s.releaseFocus = activateModalFocus(panel, {
        titleId: "mentor-title",
        returnFocusEl: s.returnFocus,
        onEscape: function () { closeMentor(); },
        initialFocusEl: panel.querySelector('[data-mentor-action="close"]')
      });
      if (window.overlayHistory) window.overlayHistory.push("mentor", function () { closeMentor({ fromHistory: true }); });
    }
    panel.style.pointerEvents = "";
    backdrop.style.pointerEvents = "";
    panel.setAttribute("data-state", "open");
    backdrop.setAttribute("data-state", "open");
    morphMentorPanel(true);
    setMentorToggles(true);
    setMentorToggleMorphed(true);
    if (!s.conversationId && !s.linkAttemptId) s.conversationId = mentorRecall() || null;
    var linking = mentorAutoLink(false);
    renderMentorPanel({ scroll: true });
    s.focusComposerOnLoad = !s.sheet;
    loadMentorUsage();
    if (!linking && s.conversationId && !s.conversation && !s.loadingConversation) loadMentorConversation(s.conversationId);
    if (!s.sheet) focusMentorComposer();
  }

  /**
   * options.restoreFocus defaults to true; route changes pass false (the page is replaced).
   * options.fromHistory: Back closed it. options.fromRoute: the view changed under it.
   */
  function closeMentor(options) {
    options = options || {};
    var s = mentorState;
    if (!s.open || !s.el) return;
    s.open = false;
    var panel = s.el.querySelector(".mentor-panel");
    var backdrop = s.el.querySelector("[data-mentor-backdrop]");
    var wasSheet = s.sheet;
    panel.setAttribute("data-state", "closed");
    backdrop.setAttribute("data-state", "closed");
    setMentorToggles(false);
    if (s.introOrb) s.introOrb.pause();
    releaseMentorToggle();
    // While it shrinks back, clicks fall through to the button underneath.
    panel.style.pointerEvents = "none";
    backdrop.style.pointerEvents = "none";
    var hidePanel = function () {
      window.clearTimeout(s.hideTimer);
      if (mentorState !== s || s.open) return;
      panel.hidden = true;
      backdrop.hidden = true;
      setMentorToggleMorphed(false);
      releaseMentorToggle();
    };
    if (options.fromRoute) hidePanel();
    else morphMentorPanel(false, hidePanel);
    if (wasSheet) {
      restoreBackground(s.isolated);
      s.isolated = [];
      if (s.releaseFocus) {
        s.releaseFocus();
        s.releaseFocus = null;
      }
      unlockBodyScroll(options.restoreScroll !== false);
      if (!options.fromHistory && !options.fromRoute && window.overlayHistory) window.overlayHistory.dismiss("mentor");
    } else if (options.restoreFocus !== false && panel.contains(document.activeElement)) {
      var target = s.returnFocus && document.body.contains(s.returnFocus) ? s.returnFocus : document.querySelector(".js-mentor-toggle");
      if (target && typeof target.focus === "function") {
        try { target.focus({ preventScroll: true }); } catch (_e) { }
      }
    }
    s.returnFocus = null;
    s.sheet = false;
    s.hideTimer = window.setTimeout(hidePanel, 700); // in case the animation never reports back
  }

  function toggleMentor(trigger) {
    if (mentorState.open) closeMentor();
    else openMentor(trigger);
  }

  /** Signed out or a different student: drop everything the previous student could see. */
  function resetMentor(userId) {
    var old = mentorState;
    if (old.open) closeMentor({ restoreFocus: false, restoreScroll: false, fromRoute: true });
    window.clearTimeout(old.hideTimer);
    if (old.orb) old.orb.destroy();
    if (old.introOrb) old.introOrb.destroy();
    if (old.el && old.el.parentNode) old.el.parentNode.removeChild(old.el);
    setMentorToggleMorphed(false);
    releaseMentorToggle();
    mentorState = createMentorState(userId || null);
    mentorState.routeAttemptId = old.routeAttemptId;
    mentorState.routeKey = old.routeKey;
  }

  /** Called on every route render: hide on exam/admin screens, reset on sign-out. */
  function syncMentorWithRoute(view, parts, user) {
    if (!user) {
      if (mentorState.userId || mentorState.el) resetMentor(null);
      return;
    }
    if (mentorState.userId && mentorState.userId !== mentorUserKey(user)) resetMentor(mentorUserKey(user));
    var s = mentorState;
    var routeKey = view + "/" + (parts[1] || "");
    var changed = routeKey !== s.routeKey;
    s.routeKey = routeKey;
    s.routeAttemptId = view === "results" && parts[1] ? String(parts[1]) : null;
    var hiddenHere = view === "instructions" || view === "test" || view === "admin" || view === "admin-activity" || view === "login";
    if (!s.open) return;
    if (hiddenHere || (s.sheet && changed)) {
      closeMentor({ restoreFocus: false, restoreScroll: false, fromRoute: true });
      return;
    }
    if (changed) renderMentorPanel();
  }

  /** Opened from a results page: continue the conversation about that attempt, or start one. */
  function mentorAutoLink(force) {
    var s = mentorState;
    var attemptId = s.routeAttemptId;
    if (!attemptId || (!force && s.autoLinkedAttemptId === attemptId)) return false;
    s.autoLinkedAttemptId = attemptId;
    if (s.conversation && s.conversation.attempt && s.conversation.attempt.id === attemptId) return false;
    if (!s.conversationId && s.linkAttemptId === attemptId) return false;
    s.view = "chat";
    s.conversationId = null;
    s.conversation = null;
    s.messages = [];
    s.loadingConversation = true;
    s.loadError = "";
    loadMentorConversations().then(function (list) {
      if (mentorState !== s || s.conversationId || s.linkAttemptId === attemptId) return;
      var match = (list || []).filter(function (c) { return c.attempt && c.attempt.id === attemptId; })[0];
      if (match) loadMentorConversation(match.id);
      else startMentorConversation(attemptId);
    }).catch(function () {
      if (mentorState === s && !s.conversationId) startMentorConversation(attemptId);
    });
    return true;
  }

  /** Results → "Ask Mentor": a new conversation about one question of this attempt. */
  function askMentorAboutQuestion(attemptId, questionId, label, trigger) {
    var user = mentorUser();
    if (!user) return;
    if (mentorState.userId !== mentorUserKey(user)) resetMentor(mentorUserKey(user));
    mentorState.autoLinkedAttemptId = attemptId; // don't let the result-page link replace it
    openMentor(trigger);
    startMentorConversation(attemptId, { id: questionId, label: label });
    focusMentorComposer();
  }

  function startMentorConversation(attemptId, question) {
    var s = mentorState;
    s.linkQuestion = attemptId && question ? question : null;
    s.view = "chat";
    s.conversationId = null;
    s.conversation = null;
    s.messages = [];
    s.loadingConversation = false;
    s.loadError = "";
    s.sendError = null;
    s.notice = "";
    s.linkAttemptId = attemptId || null;
    mentorRemember();
    renderMentorPanel({ scroll: true });
  }

  function loadMentorUsage() {
    var s = mentorState;
    if (!store.getMentorUsage) return Promise.resolve(null);
    return Promise.resolve(store.getMentorUsage()).then(function (usage) {
      if (mentorState !== s) return null;
      s.usage = usage;
      s.usageError = false;
      renderMentorFoot();
      // Just opened on a desktop: the message box may only now be shown; move focus to it
      // unless the student already moved on.
      if (s.focusComposerOnLoad && s.open) {
        var active = document.activeElement;
        if (!active || active === document.body || active === mentorPart('[data-mentor-action="close"]')) focusMentorComposer();
      }
      s.focusComposerOnLoad = false;
      return usage;
    }).catch(function () {
      if (mentorState !== s) return null;
      s.usageError = true;
      renderMentorFoot();
      return null;
    });
  }

  function loadMentorConversations() {
    var s = mentorState;
    s.conversationsError = "";
    return Promise.resolve(store.listMentorConversations()).then(function (list) {
      if (mentorState !== s) return list;
      // Unchanged: keep the rendered list, so a tap in progress isn't lost to a re-render.
      var same = JSON.stringify(list) === JSON.stringify(s.conversations);
      s.conversations = list;
      if (s.view === "history" && !same) renderMentorPanel();
      return list;
    }).catch(function (error) {
      if (mentorState === s) {
        s.conversationsError = (error && error.message) || "Couldn't load your conversations.";
        if (s.view === "history") renderMentorPanel();
      }
      throw error;
    });
  }

  function loadMentorConversation(conversationId) {
    var s = mentorState;
    s.view = "chat";
    s.conversationId = conversationId;
    s.conversation = null;
    s.messages = [];
    s.linkAttemptId = null;
    s.loadingConversation = true;
    s.loadError = "";
    s.sendError = null;
    s.notice = "";
    mentorRemember();
    renderMentorPanel();
    return Promise.resolve(store.getMentorConversation(conversationId)).then(function (data) {
      if (mentorState !== s || s.conversationId !== conversationId) return;
      s.conversation = (data && data.conversation) || null;
      s.messages = (data && Array.isArray(data.messages)) ? data.messages : [];
      s.loadingConversation = false;
      renderMentorPanel({ scroll: true });
    }).catch(function (error) {
      if (mentorState !== s || s.conversationId !== conversationId) return;
      s.loadingConversation = false;
      if (error && (error.status === 404 || error.status === 400)) {
        startMentorConversation(null);
        return;
      }
      s.loadError = "Couldn't load this conversation.";
      renderMentorPanel();
    });
  }

  function mentorReplaceMessage(localId, message) {
    var list = mentorState.messages;
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].id === localId || (message && list[i].id === message.id)) {
        list[i] = message;
        return;
      }
    }
    if (message) list.push(message);
  }

  function mentorFindByClientId(clientMessageId) {
    return mentorState.messages.filter(function (m) { return m.role === "user" && m.clientMessageId === clientMessageId; })[0] || null;
  }

  async function sendMentorMessage(content, retryOf, sourceEl) {
    var s = mentorState;
    if (s.sending) return;
    var text = String(content || "").trim();
    if (!text) return;
    var max = (s.usage && s.usage.maxInputChars) || 2000;
    if (text.length > max) {
      s.notice = "Messages can be up to " + max + " characters. Shorten it a little and send again.";
      renderMentorFoot();
      return;
    }
    if (navigator.onLine === false) {
      s.notice = "You're offline. Reconnect to send your message.";
      renderMentorFoot();
      return;
    }
    var clientMessageId = retryOf ? retryOf.clientMessageId : mentorNewMessageId();
    var localId = "local-" + clientMessageId;
    s.notice = "";
    s.sendError = null;
    s.sending = { content: text, clientMessageId: clientMessageId };
    var existing = mentorFindByClientId(clientMessageId);
    if (existing) {
      existing.status = "pending";
      localId = existing.id;
    } else {
      s.messages.push({ id: localId, role: "user", content: text, status: "pending", clientMessageId: clientMessageId, local: true });
    }
    if (!retryOf) {
      s.draft = "";
      var input = mentorPart("#mentor-input");
      if (input) {
        input.value = "";
        sizeMentorInput(input);
      }
    }
    // The orb: the greeting orb flies down into the conversation; otherwise a new one
    // assembles where the reply will appear and a spark flies to it from Send.
    var introOrb = s.introOrb;
    var introRect = introOrb && introOrb.el.isConnected ? introOrb.el.querySelector(".mentor-orb-stage").getBoundingClientRect() : null;
    if (s.orb) s.orb.destroy();
    s.orb = introRect ? introOrb : MentorOrb.create();
    if (introRect) s.introOrb = null;
    var sendButton = mentorPart("[data-mentor-send]");
    // Where the message comes from: the tapped chip, else the text box.
    var fromEl = sourceEl && sourceEl.isConnected ? sourceEl : mentorPart("#mentor-input");
    var fromRect = !retryOf && fromEl ? fromEl.getBoundingClientRect() : null;
    if (!retryOf && !MentorOrb.reduced()) {
      launchMentorSendArrow(sendButton);
      if (navigator.vibrate && window.matchMedia && window.matchMedia("(pointer: coarse)").matches) {
        try { navigator.vibrate(8); } catch (_e) { }
      }
    }
    s.readingUp = false;
    renderMentorPanel({ scroll: true });
    if (fromRect) landMentorMessage(fromRect);
    var orb = s.orb;
    var stages = mentorStages(text, Boolean((s.conversation && s.conversation.attempt) || s.linkAttemptId));
    if (introRect && !MentorOrb.reduced() && typeof orb.el.animate === "function") {
      // Only the orb travels; its stage label fades in once it has landed.
      var stage = orb.el.querySelector(".mentor-orb-stage");
      var toRect = stage.getBoundingClientRect();
      stage.animate(
        [{ transform: "translate(" + (introRect.left - toRect.left).toFixed(1) + "px," + (introRect.top - toRect.top).toFixed(1) + "px)" }, { transform: "none" }],
        { duration: 480, easing: MentorOrb.CSS.fly }
      );
      orb.el.querySelector(".mentor-orb-label").animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 380, easing: "ease-out", fill: "backwards" });
      orb.think(stages);
    } else {
      flyMentorSpark(sendButton, orb.el.querySelector(".mentor-orb-stage"));
      window.setTimeout(function () { orb.assemble(); }, MentorOrb.reduced() ? 0 : 260);
      orb.think(stages);
    }
    var assembled = new Promise(function (resolve) { window.setTimeout(resolve, MentorOrb.reduced() ? 0 : 900); });
    mentorAnnounce("ACEIIIT Mentor is thinking.");
    var conversationId = s.conversationId;
    try {
      if (!conversationId) {
        var created = await store.createMentorConversation(s.linkAttemptId, s.linkQuestion && s.linkQuestion.id);
        s.linkQuestion = null;
        if (mentorState !== s) return;
        conversationId = created.id;
        s.conversationId = created.id;
        s.conversation = created;
        s.linkAttemptId = null;
        mentorRemember();
      }
      var result = await store.sendMentorMessage(conversationId, text, clientMessageId);
      if (mentorState !== s) return;
      // Let the orb finish assembling, then resolve and condense into the reply.
      if (s.open && !document.hidden && orb === s.orb) {
        await assembled;
        await orb.finish();
      }
      if (mentorState !== s) return;
      if (result && result.assistantMessage) {
        s.revealId = result.assistantMessage.id;
        s.followupsFresh = true;
      }
      if (result && result.usage) s.usage = result.usage;
      if (s.conversationId === conversationId) {
        mentorReplaceMessage(localId, result.userMessage);
        if (result.assistantMessage) mentorReplaceMessage(null, result.assistantMessage);
        if (s.conversation && s.conversation.title === "New conversation") s.conversation.title = text.slice(0, 60);
      }
      s.conversations = null; // titles and order changed; reload when the list is opened
      mentorAnnounce("ACEIIIT Mentor replied.");
    } catch (error) {
      if (mentorState !== s) return;
      var data = (error && error.data) || {};
      var code = (error && error.code) || (error && error.status ? "" : "OFFLINE");
      if (data.usage) s.usage = data.usage;
      var message = mentorFindByClientId(clientMessageId);
      if (code === "MENTOR_EMPTY" || code === "MENTOR_TOO_LONG" || code === "MENTOR_NOT_FOUND" || code === "MENTOR_DUPLICATE") {
        // Not stored: give the text back so nothing typed is lost.
        s.messages = s.messages.filter(function (m) { return m !== message; });
        s.draft = text;
        var box = mentorPart("#mentor-input");
        if (box) {
          box.value = text;
          sizeMentorInput(box);
        }
        if (code === "MENTOR_NOT_FOUND") {
          s.conversationId = null;
          s.conversation = null;
          mentorRemember();
          s.notice = "That conversation was deleted. Your message is back in the box; send it to start a new one.";
        } else {
          s.notice = (error && error.message) || "That message couldn't be sent.";
        }
      } else {
        if (message) message.status = "failed";
        s.sendError = {
          clientMessageId: clientMessageId,
          code: code,
          retryable: Boolean(data.retryable || MENTOR_RETRYABLE[code]),
          message: code === "OFFLINE"
            ? "Couldn't reach AceIIIT. Check your connection and try again. It wasn't counted."
            : code === "MENTOR_LIMIT"
              ? "Not sent: you've used this month's replies. It wasn't counted."
              : ((error && error.message) || "Something went wrong. It wasn't counted.")
        };
        if (code === "MENTOR_IN_PROGRESS" && conversationId) {
          window.setTimeout(function () {
            if (mentorState === s && s.conversationId === conversationId && !s.sending) loadMentorConversation(conversationId);
          }, 4000);
        }
        mentorAnnounce("No reply. " + s.sendError.message);
      }
      if (orb === s.orb && s.open) await orb.fade();
    } finally {
      if (mentorState === s) {
        if (orb === s.orb) {
          orb.destroy();
          s.orb = null;
        }
        s.sending = null;
        // Reading earlier messages while waiting? Don't pull them down: offer the pill instead.
        var stayPut = Boolean(s.readingUp && s.revealId);
        renderMentorPanel({ scroll: !stayPut, keep: stayPut });
        if (stayPut) showMentorNewPill(true);
        if (s.open && !s.sheet) focusMentorComposer();
      }
    }
  }

  function buildMentorMessageHtml(message) {
    var s = mentorState;
    if (message.role === "assistant") {
      return '<li class="mentor-msg is-assistant"><div class="mentor-bubble rich-mentor" data-mentor-msg-id="' + escapeAttribute(String(message.id || "")) + '">' + renderMentorMarkdown(message.content) + '</div>' +
        '<div class="mentor-msg-actions">' +
        '<button type="button" class="mentor-msg-action" data-mentor-copy aria-label="Copy this reply">' + MENTOR_ICONS.copy + '<span>Copy</span></button>' +
        '<button type="button" class="mentor-msg-action" data-mentor-quote aria-label="Ask about this reply">' + MENTOR_ICONS.quote + '<span>Ask about this</span></button>' +
        '</div></li>';
    }
    var failed = message.status === "failed";
    var fresh = failed && s.sendError && s.sendError.clientMessageId === message.clientMessageId ? s.sendError : null;
    var canRetry = failed && message.clientMessageId && (fresh ? fresh.retryable : true) && !s.sending;
    var errorHtml = failed
      ? '<p class="mentor-msg-error">' + escapeHtml(fresh ? fresh.message : "This message didn't get a reply. It wasn't counted.") +
        (canRetry ? ' <button type="button" class="mentor-link-button" data-mentor-retry="' + escapeAttribute(message.clientMessageId) + '">Try again</button>' : '') +
        '</p>'
      : '';
    return '<li class="mentor-msg is-user' + (failed ? ' is-failed' : '') + '"><div class="mentor-bubble">' + escapeHtml(message.content) + '</div>' + errorHtml + '</li>';
  }

  function buildMentorContextHtml() {
    var s = mentorState;
    var linked = s.conversation && s.conversation.attempt;
    var chip = "";
    var question = (s.conversation && s.conversation.question) || (!s.conversationId && s.linkQuestion) || null;
    if (question) {
      chip = '<p class="mentor-context is-question"><span class="mentor-context-label">About</span> ' + escapeHtml(question.label || "this question") +
        (linked && linked.test ? ' <span class="mentor-context-test">· ' + escapeHtml(linked.test) + '</span>' : '') + '</p>';
    } else if (linked) {
      chip = '<p class="mentor-context"><span class="mentor-context-label">About</span> ' + escapeHtml(linked.test || "this attempt") +
        (linked.attemptNumber > 1 ? ' · attempt ' + escapeHtml(String(linked.attemptNumber)) : '') + '</p>';
    } else if (!s.conversationId && s.linkAttemptId) {
      chip = '<p class="mentor-context"><span class="mentor-context-label">About</span> ' + escapeHtml(mentorAttemptLabel(s.linkAttemptId)) + '</p>';
    }
    var onScreen = s.routeAttemptId;
    var linkedId = linked ? linked.id : (!s.conversationId ? s.linkAttemptId : null);
    var offer = onScreen && linkedId !== onScreen && !s.sending
      ? '<button type="button" class="mentor-context-offer" data-mentor-action="link-result">Ask about the result on screen</button>'
      : '';
    return chip + offer;
  }

  function buildMentorChatHtml() {
    var s = mentorState;
    var user = mentorUser();
    var html = buildMentorContextHtml();
    if (s.loadingConversation) {
      return html + '<div class="mentor-skeleton" aria-busy="true" aria-label="Loading conversation"><span></span><span></span><span></span></div>';
    }
    if (s.loadError) {
      return html + '<p class="mentor-notice is-error">' + escapeHtml(s.loadError) +
        ' <button type="button" class="mentor-link-button" data-mentor-action="reload">Try again</button></p>';
    }
    if (!s.messages.length && !s.sending) {
      return html +
        '<div class="mentor-intro">' +
        '<div class="mentor-intro-orb" data-mentor-orb-slot="intro"></div>' +
        '<h3>Hi ' + escapeHtml(firstName(user && user.name)) + ', what should we look at?</h3>' +
        '<p>I read your AceIIIT mock results to explain where marks go and what to practise next. I can help with doubts too.</p>' +
        '<ul class="mentor-suggestions" aria-label="Suggested questions">' +
        ((s.linkQuestion && !s.conversationId) || (s.conversation && s.conversation.question) ? MENTOR_QUESTION_SUGGESTIONS : MENTOR_SUGGESTIONS).map(function (text, i) {
          return '<li style="--i:' + i + '"><button type="button" class="mentor-suggestion" data-mentor-suggest="' + escapeAttribute(text) + '">' + escapeHtml(text) + '</button></li>';
        }).join("") +
        '</ul>' +
        '<p class="mentor-intro-note">Each answer uses one reply from your monthly allowance, however long it is. Replies that fail aren\'t counted.</p>' +
        '</div>';
    }
    return html +
      '<ol class="mentor-log" aria-label="Conversation">' +
      s.messages.map(buildMentorMessageHtml).join("") +
      (s.sending ? '<li class="mentor-msg is-assistant is-thinking" data-mentor-orb-slot="thinking"></li>' : '') +
      '</ol>' +
      buildMentorFollowupsHtml();
  }

  function buildMentorFollowupsHtml() {
    var s = mentorState;
    var last = s.messages[s.messages.length - 1];
    if (s.sending || !last || last.role !== "assistant" || !mentorCanType()) return "";
    var fresh = s.followupsFresh;
    s.followupsFresh = false;
    return '<ul class="mentor-followups' + (fresh ? ' is-fresh' : '') + '" aria-label="Follow-up questions">' +
      MENTOR_FOLLOWUPS.map(function (text, i) {
        return '<li style="--i:' + i + '"><button type="button" class="mentor-followup" data-mentor-suggest="' + escapeAttribute(text) + '">' + escapeHtml(text) + '</button></li>';
      }).join("") +
      '</ul>';
  }

  function buildMentorHistoryHtml() {
    var s = mentorState;
    var head = '<div class="mentor-history-head"><h3>Your conversations</h3>' +
      '<button type="button" class="mentor-text-button" data-mentor-action="new">New conversation</button></div>';
    if (s.conversationsError && !Array.isArray(s.conversations)) {
      return head + '<p class="mentor-notice is-error">' + escapeHtml(s.conversationsError) +
        ' <button type="button" class="mentor-link-button" data-mentor-action="history-reload">Try again</button></p>';
    }
    if (!Array.isArray(s.conversations)) {
      return head + '<div class="mentor-skeleton" aria-busy="true" aria-label="Loading conversations"><span></span><span></span><span></span></div>';
    }
    if (!s.conversations.length) {
      return head + '<div class="mentor-empty"><p>No conversations yet.</p>' +
        '<button type="button" class="mentor-text-button" data-mentor-action="new">Start a conversation</button></div>';
    }
    return head + '<ul class="mentor-history-list">' + s.conversations.map(function (c) {
      var meta = [c.attempt ? "About " + c.attempt.test : "", mentorShortDate(c.lastMessageAt || c.createdAt)].filter(Boolean).join(" · ");
      return '<li class="mentor-history-item' + (c.id === s.conversationId ? ' is-current' : '') + '">' +
        '<button type="button" class="mentor-history-open" data-mentor-open="' + escapeAttribute(c.id) + '"' + (c.id === s.conversationId ? ' aria-current="true"' : '') + '>' +
        '<span class="mentor-history-title">' + escapeHtml(c.title || "Conversation") + '</span>' +
        (meta ? '<span class="mentor-history-meta">' + escapeHtml(meta) + '</span>' : '') +
        '</button>' +
        '<button type="button" class="mentor-icon-button is-small" data-mentor-delete="' + escapeAttribute(c.id) + '" aria-label="' + escapeAttribute("Delete conversation: " + (c.title || "Conversation")) + '" title="Delete">' + MENTOR_ICONS.trash + '</button>' +
        '</li>';
    }).join("") + '</ul>';
  }

  function buildMentorStatusHtml() {
    var s = mentorState;
    var usage = s.usage;
    var parts = [];
    if (navigator.onLine === false) parts.push('<p class="mentor-notice">You\'re offline. Your conversation is still here; reconnect to send messages.</p>');
    if (s.notice) parts.push('<p class="mentor-notice is-error" role="alert">' + escapeHtml(s.notice) + '</p>');
    if (s.usageError && !usage) {
      parts.push('<p class="mentor-notice">Couldn\'t check your mentor allowance. <button type="button" class="mentor-link-button" data-mentor-action="usage-reload">Try again</button></p>');
    }
    if (usage && usage.available === false) {
      parts.push('<p class="mentor-notice">' + escapeHtml(mentorUnavailableText(usage)) + '</p>');
    } else if (mentorOutOfReplies(usage)) {
      var resetOn = mentorResetDate(usage);
      if (usage.tier === "enrolled") {
        parts.push('<p class="mentor-notice">You\'ve used this month\'s ' + escapeHtml(String(usage.limit)) + ' mentor replies.' + (resetOn ? ' They reset on ' + escapeHtml(resetOn) + '.' : '') + ' Your conversations are still here to read.</p>');
      } else if (s.upgradeDismissed === usage.period) {
        parts.push('<p class="mentor-notice">You\'ve used all ' + escapeHtml(String(usage.limit)) + ' free replies this month.' + (resetOn ? ' They reset on ' + escapeHtml(resetOn) + '.' : '') +
          ' <a class="mentor-link-button" href="' + escapeAttribute(mentorSafeUrl(usage.ctaUrl)) + '" target="_blank" rel="noopener">See the programme</a></p>');
      } else {
        parts.push(
          '<section class="mentor-upgrade" aria-labelledby="mentor-upgrade-title">' +
          '<h3 id="mentor-upgrade-title">Ready to take your preparation further?</h3>' +
          '<p>You\'ve used your free AI Mentor messages for this month. Enrol in the ACEIIIT UGEE preparation programme to continue getting personalized guidance on your performance, mistakes, weak topics, and study strategy.</p>' +
          (resetOn ? '<p class="mentor-upgrade-reset">Your free replies reset on ' + escapeHtml(resetOn) + '.</p>' : '') +
          '<div class="mentor-upgrade-actions">' +
          '<a class="mentor-upgrade-cta" href="' + escapeAttribute(mentorSafeUrl(usage.ctaUrl)) + '" target="_blank" rel="noopener">Explore the Preparation Programme</a>' +
          '<button type="button" class="mentor-upgrade-later" data-mentor-action="later">Maybe Later</button>' +
          '</div>' +
          '</section>'
        );
      }
    }
    return parts.join("");
  }

  function renderMentorFoot() {
    var s = mentorState;
    if (!s.el) return;
    var status = mentorPart("[data-mentor-status]");
    var composer = mentorPart("[data-mentor-composer]");
    var send = mentorPart("[data-mentor-send]");
    var usageText = mentorPart("[data-mentor-usage]");
    var input = mentorPart("#mentor-input");
    var hadFocus = composer && composer.contains(document.activeElement);
    if (status) status.innerHTML = buildMentorStatusHtml();
    var canType = mentorCanType() && s.view === "chat";
    if (composer) composer.hidden = !canType;
    if (send) {
      var blocked = Boolean(s.sending) || navigator.onLine === false || s.loadingConversation;
      send.disabled = blocked;
      send.setAttribute("aria-label", s.sending ? "Sending… wait for the reply" : "Send message");
    }
    if (usageText) renderMentorUsage(usageText, s.usage);
    var panelEl = mentorPart(".mentor-panel");
    if (panelEl) panelEl.classList.toggle("is-thinking", Boolean(s.sending));
    if (composer && input) composer.classList.toggle("has-text", Boolean(input.value.trim()));
    if (input && input.value !== s.draft && document.activeElement !== input) input.value = s.draft;
    updateMentorCount();
    if (hadFocus && composer && composer.hidden) {
      var close = mentorPart('[data-mentor-action="close"]');
      if (close) close.focus({ preventScroll: true });
    }
  }

  function updateMentorCount() {
    var count = mentorPart("[data-mentor-count]");
    var input = mentorPart("#mentor-input");
    if (!count || !input) return;
    var max = (mentorState.usage && mentorState.usage.maxInputChars) || 2000;
    var length = input.value.trim().length;
    count.textContent = length > max * 0.8 ? length + " / " + max : "";
    count.classList.toggle("is-over", length > max);
  }

  function sizeMentorInput(input) {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight + 2, 140) + "px";
  }

  function renderMentorPanel(options) {
    var s = mentorState;
    if (!s.el) return;
    options = options || {};
    var body = mentorPart("[data-mentor-body]");
    var historyButton = mentorPart('[data-mentor-action="history"]');
    if (historyButton) historyButton.setAttribute("aria-pressed", s.view === "history" ? "true" : "false");
    if (body) {
      var nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
      var keepTop = body.scrollTop;
      body.innerHTML = s.view === "history" ? buildMentorHistoryHtml() : buildMentorChatHtml();
      if (s.view === "chat") {
        mountMentorOrbs(body);
        renderLatexInElement(body);
        if (s.revealId) {
          var fresh = body.querySelector('[data-mentor-msg-id="' + String(s.revealId).replace(/[^A-Za-z0-9_-]/g, "") + '"]');
          s.revealId = null;
          if (s.open) revealMentorReply(fresh);
        }
        if (!s.messages.length && !s.sending) {
          body.scrollTop = 0; // the greeting reads from the top
        } else if (options.keep) {
          body.scrollTop = keepTop;
        } else if (options.scroll || nearBottom) {
          body.scrollTop = body.scrollHeight;
          window.requestAnimationFrame(function () { body.scrollTop = body.scrollHeight; });
        }
      } else {
        body.scrollTop = 0;
      }
    }
    renderMentorFoot();
  }

  /** The orbs live outside the re-rendered HTML; put them back into their slots. */
  function mountMentorOrbs(body) {
    var s = mentorState;
    var intro = body.querySelector('[data-mentor-orb-slot="intro"]');
    if (intro) {
      if (!s.introOrb) s.introOrb = MentorOrb.create();
      intro.appendChild(s.introOrb.el);
      if (s.open) s.introOrb.idle();
    } else if (s.introOrb) {
      s.introOrb.pause();
    }
    var slot = body.querySelector('[data-mentor-orb-slot="thinking"]');
    if (slot && s.orb) {
      slot.appendChild(s.orb.el);
      s.orb.resume();
    }
  }

  function showMentorHistory() {
    var s = mentorState;
    s.view = s.view === "history" ? "chat" : "history";
    renderMentorPanel({ scroll: s.view === "chat" });
    if (s.view === "history") {
      loadMentorConversations().catch(function () { });
      var heading = mentorPart(".mentor-history-head h3");
      if (heading) {
        heading.setAttribute("tabindex", "-1");
        try { heading.focus({ preventScroll: true }); } catch (_e) { }
      }
    } else {
      focusMentorComposer();
    }
  }

  function deleteMentorConversationById(conversationId) {
    var s = mentorState;
    var item = (s.conversations || []).filter(function (c) { return c.id === conversationId; })[0];
    if (!window.confirm("Delete “" + ((item && item.title) || "this conversation") + "”? This can't be undone.")) return;
    Promise.resolve(store.deleteMentorConversation(conversationId)).then(function () {
      if (mentorState !== s) return;
      s.conversations = (s.conversations || []).filter(function (c) { return c.id !== conversationId; });
      if (s.conversationId === conversationId) {
        s.conversationId = null;
        s.conversation = null;
        s.messages = [];
        mentorRemember();
      }
      renderMentorPanel();
      var heading = mentorPart(".mentor-history-head h3");
      if (heading) {
        heading.setAttribute("tabindex", "-1");
        try { heading.focus({ preventScroll: true }); } catch (_e) { }
      }
      mentorAnnounce("Conversation deleted.");
    }).catch(function (error) {
      if (mentorState !== s) return;
      s.conversationsError = (error && error.message) || "Couldn't delete it.";
      window.alert("Couldn't delete the conversation. " + s.conversationsError);
    });
  }

  function bindMentorPanel(root) {
    var panel = root.querySelector(".mentor-panel");
    var input = root.querySelector("#mentor-input");
    var composer = root.querySelector("[data-mentor-composer]");
    root.querySelector("[data-mentor-backdrop]").addEventListener("click", function () { closeMentor(); });
    panel.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && !mentorState.sheet) {
        event.preventDefault();
        closeMentor();
      }
    });
    var body = root.querySelector("[data-mentor-body]");
    body.addEventListener("scroll", function () {
      var near = body.scrollHeight - body.scrollTop - body.clientHeight < 48;
      mentorState.readingUp = !near;
      if (near) showMentorNewPill(false);
    }, { passive: true });
    // A click or key finishes the word-by-word reveal at once.
    ["pointerdown", "keydown"].forEach(function (type) {
      panel.addEventListener(type, finishMentorReveal, true);
    });
    composer.addEventListener("submit", function (event) {
      event.preventDefault();
      if (!input.value.trim()) {
        // MorphOrb's nudge: an empty send shakes the box instead of doing nothing.
        if (typeof composer.animate === "function" && !MentorOrb.reduced()) {
          composer.animate(
            [{ transform: "none" }, { transform: "translateX(-6px)" }, { transform: "translateX(5px)" }, { transform: "translateX(-3px)" }, { transform: "none" }],
            { duration: 260, easing: "ease-out" }
          );
        }
        input.focus();
        return;
      }
      sendMentorMessage(input.value);
    });
    input.addEventListener("input", function () {
      mentorState.draft = input.value;
      if (mentorState.notice) {
        mentorState.notice = "";
        renderMentorFoot();
      }
      sizeMentorInput(input);
      updateMentorCount();
      composer.classList.toggle("has-text", Boolean(input.value.trim()));
    });
    input.addEventListener("keydown", function (event) {
      // Enter sends on keyboards with a pointer; on touch screens Enter adds a line and the
      // Send button sends.
      var coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !coarse) {
        event.preventDefault();
        if (mentorState.sending) return;
        if (typeof composer.requestSubmit === "function") composer.requestSubmit();
        else sendMentorMessage(input.value);
      }
    });
    panel.addEventListener("click", function (event) {
      var target = event.target && event.target.closest ? event.target : null;
      if (!target) return;
      var action = target.closest("[data-mentor-action]");
      var suggest = target.closest("[data-mentor-suggest]");
      var retry = target.closest("[data-mentor-retry]");
      var openId = target.closest("[data-mentor-open]");
      var deleteId = target.closest("[data-mentor-delete]");
      var s = mentorState;
      if (suggest) {
        sendMentorMessage(suggest.getAttribute("data-mentor-suggest"), null, suggest);
        return;
      }
      var copy = target.closest("[data-mentor-copy]");
      if (copy) {
        copyMentorReply(copy);
        return;
      }
      var quote = target.closest("[data-mentor-quote]");
      if (quote) {
        quoteMentorReply(quote);
        return;
      }
      if (target.closest("[data-mentor-newpill]")) {
        var newest = mentorPart(".mentor-log .mentor-msg.is-assistant:last-of-type");
        if (newest) newest.scrollIntoView({ block: "start", behavior: MentorOrb.reduced() ? "auto" : "smooth" });
        showMentorNewPill(false);
        return;
      }
      if (retry) {
        var failed = mentorFindByClientId(retry.getAttribute("data-mentor-retry"));
        if (failed) sendMentorMessage(failed.content, failed);
        return;
      }
      if (openId) {
        loadMentorConversation(openId.getAttribute("data-mentor-open")).then(focusMentorComposer);
        return;
      }
      if (deleteId) {
        deleteMentorConversationById(deleteId.getAttribute("data-mentor-delete"));
        return;
      }
      if (!action) return;
      var name = action.getAttribute("data-mentor-action");
      if (name === "close") closeMentor();
      else if (name === "history") showMentorHistory();
      else if (name === "new") {
        startMentorConversation(null);
        focusMentorComposer();
      } else if (name === "link-result") {
        s.autoLinkedAttemptId = null;
        mentorAutoLink(true);
        renderMentorPanel();
      } else if (name === "later") {
        s.upgradeDismissed = s.usage ? s.usage.period : "";
        renderMentorFoot();
        var close = mentorPart('[data-mentor-action="close"]');
        if (close) close.focus({ preventScroll: true });
      } else if (name === "reload" && s.conversationId) loadMentorConversation(s.conversationId);
      else if (name === "history-reload") {
        s.conversations = null;
        renderMentorPanel();
        loadMentorConversations().catch(function () { });
      } else if (name === "usage-reload") loadMentorUsage();
    });
  }

  window.addEventListener("online", function () { if (mentorState.el) renderMentorFoot(); });
  window.addEventListener("offline", function () { if (mentorState.el) renderMentorFoot(); });

  // ---- Admin Studio → ACEIIIT Mentor (allowances, programme codes, status and usage) --------
  function buildAdminMentorHtml() {
    return '<div class="admin-grid mentor-admin" id="mentor-admin-root"><div class="admin-card"><p class="helper-text" aria-busy="true">Loading ACEIIIT Mentor settings…</p></div></div>';
  }

  function adminMentorStatusText(status) {
    if (!status) return "";
    if (status.available) return "Replying normally" + (status.model ? " (" + status.model + ")" : "") + ".";
    if (status.reason === "disabled") return "Switched off. Students can read past conversations but can't send.";
    if (status.reason === "not_configured") return "No Gemini API key on the server (GEMINI_API_KEY). Students see that the mentor isn't set up.";
    if (status.reason === "daily_limit") return "Today's global reply cap is reached. Replies resume tomorrow (IST).";
    return "Paused after a provider error (key, project access, quota or model). Replies resume automatically" + (status.until ? " after " + formatDateTime(status.until) : "") + ". Check the server log.";
  }

  function renderAdminMentor(root, data, message) {
    var settings = data.settings || {};
    var status = data.status || {};
    var stats = data.stats || {};
    var days = (stats.lastDays || []).map(function (d) {
      return '<tr><td>' + escapeHtml(d.day) + '</td><td class="num">' + escapeHtml(String(d.replies || 0)) + '</td><td class="num">' + escapeHtml(String(d.failures || 0)) + '</td></tr>';
    }).join("");
    root.innerHTML =
      '<div class="admin-card">' +
      '<p class="section-label">ACEIIIT Mentor</p>' +
      '<p class="helper-text">Students get the free allowance each calendar month (resets 00:00 IST on the 1st). The enrolled allowance applies only to a verified, active purchase of one of the programme codes below; nobody is enrolled while the list is empty.</p>' +
      '<form id="mentor-admin-form" class="mentor-admin-form" novalidate>' +
      '<div class="field"><label><input type="checkbox" name="enabled"' + (settings.enabled ? ' checked' : '') + '> Mentor switched on</label></div>' +
      '<div class="grid-two">' +
      '<div class="field"><label for="mentor-free">Free replies per month</label><input id="mentor-free" name="freeMonthlyReplies" type="number" inputmode="numeric" min="0" max="1000" value="' + escapeAttribute(String(settings.freeMonthlyReplies)) + '" required></div>' +
      '<div class="field"><label for="mentor-enrolled">Enrolled replies per month</label><input id="mentor-enrolled" name="enrolledMonthlyReplies" type="number" inputmode="numeric" min="0" max="10000" value="' + escapeAttribute(String(settings.enrolledMonthlyReplies)) + '" required></div>' +
      '<div class="field"><label for="mentor-daily">Global replies per day (cost cap)</label><input id="mentor-daily" name="dailyGlobalReplies" type="number" inputmode="numeric" min="0" max="1000000" value="' + escapeAttribute(String(settings.dailyGlobalReplies)) + '" required></div>' +
      '<div class="field"><label for="mentor-output">Longest reply (output tokens)</label><input id="mentor-output" name="maxOutputTokens" type="number" inputmode="numeric" min="200" max="4000" value="' + escapeAttribute(String(settings.maxOutputTokens)) + '" required></div>' +
      '<div class="field"><label for="mentor-input-max">Longest student message (characters)</label><input id="mentor-input-max" name="maxInputChars" type="number" inputmode="numeric" min="200" max="8000" value="' + escapeAttribute(String(settings.maxInputChars)) + '" required></div>' +
      '</div>' +
      '<div class="field"><label for="mentor-codes">Programme resource codes</label><input id="mentor-codes" name="programCodes" value="' + escapeAttribute((settings.programCodes || []).join(", ")) + '" placeholder="e.g. CLASS_NOTES" aria-describedby="mentor-codes-help">' +
      '<p class="helper-text" id="mentor-codes-help">Comma-separated. Matches the resource code of an ACTIVE entitlement on the AceIIIT site, or a verified commerce payment recorded here.</p></div>' +
      '<div class="field"><label for="mentor-url">Programme page (https)</label><input id="mentor-url" name="programUrl" type="url" value="' + escapeAttribute(settings.programUrl || "") + '" placeholder="' + escapeAttribute(PROGRAMME_URL) + '" aria-describedby="mentor-url-help">' +
      '<p class="helper-text" id="mentor-url-help">Where "Explore the Preparation Programme" leads. Empty uses ' + escapeHtml(PROGRAMME_URL) + '.</p></div>' +
      '<p class="mentor-admin-message" role="status" id="mentor-admin-message">' + escapeHtml(message || "") + '</p>' +
      '<div class="button-row"><button class="button button-primary" type="submit">Save mentor settings</button></div>' +
      '</form>' +
      '</div>' +
      '<aside class="admin-card admin-sticky-side">' +
      '<p class="section-label">Status</p>' +
      '<p class="mentor-admin-status' + (status.available ? ' is-ok' : ' is-off') + '">' + escapeHtml(adminMentorStatusText(status)) + '</p>' +
      '<p class="helper-text">API key on the server: ' + (status.keyConfigured ? 'set' : 'missing') + '. The key is never shown here or sent to browsers.</p>' +
      '<div class="divider"></div>' +
      '<p class="section-label">Usage (' + escapeHtml(stats.period || "") + ', IST)</p>' +
      '<dl class="mentor-admin-stats">' +
      '<div><dt>Replies this month</dt><dd>' + escapeHtml(String(stats.monthReplies || 0)) + '</dd></div>' +
      '<div><dt>Students this month</dt><dd>' + escapeHtml(String(stats.monthStudents || 0)) + '</dd></div>' +
      '<div><dt>Replies today</dt><dd>' + escapeHtml(String((stats.today && stats.today.replies) || 0)) + '</dd></div>' +
      '<div><dt>Failed today</dt><dd>' + escapeHtml(String((stats.today && stats.today.failures) || 0)) + '</dd></div>' +
      '</dl>' +
      (days ? '<table class="mentor-admin-days"><caption class="sr-only">Mentor replies by day</caption><thead><tr><th scope="col">Day</th><th scope="col" class="num">Replies</th><th scope="col" class="num">Failed</th></tr></thead><tbody>' + days + '</tbody></table>' : '<p class="helper-text">No mentor replies yet.</p>') +
      '</aside>';
    var form = root.querySelector("#mentor-admin-form");
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var fd = new FormData(form);
      var number = function (name) { return Number(String(fd.get(name) || "").trim()); };
      var patch = {
        enabled: fd.get("enabled") === "on",
        freeMonthlyReplies: number("freeMonthlyReplies"),
        enrolledMonthlyReplies: number("enrolledMonthlyReplies"),
        dailyGlobalReplies: number("dailyGlobalReplies"),
        maxOutputTokens: number("maxOutputTokens"),
        maxInputChars: number("maxInputChars"),
        programCodes: String(fd.get("programCodes") || "").split(",").map(function (c) { return c.trim(); }).filter(Boolean),
        programUrl: String(fd.get("programUrl") || "").trim()
      };
      var button = form.querySelector('button[type="submit"]');
      var note = root.querySelector("#mentor-admin-message");
      button.disabled = true;
      note.textContent = "Saving…";
      Promise.resolve(store.updateAdminMentor(patch)).then(function () {
        return mountAdminMentor("Saved.");
      }).catch(function (error) {
        button.disabled = false;
        note.textContent = "Not saved: " + ((error && error.message) || "please check the values.");
      });
    });
  }

  function mountAdminMentor(message) {
    var root = document.getElementById("mentor-admin-root");
    if (!root || !store.getAdminMentor) return Promise.resolve();
    return Promise.resolve(store.getAdminMentor()).then(function (data) {
      var current = document.getElementById("mentor-admin-root");
      if (current) renderAdminMentor(current, data || {}, message);
    }).catch(function (error) {
      var current = document.getElementById("mentor-admin-root");
      if (current) {
        current.innerHTML = '<div class="admin-card"><p class="helper-text">Couldn\'t load ACEIIIT Mentor settings: ' + escapeHtml((error && error.message) || "network error") +
          '</p><button type="button" class="button button-secondary button-compact" id="mentor-admin-retry">Try again</button></div>';
        var retry = document.getElementById("mentor-admin-retry");
        if (retry) retry.addEventListener("click", function () { mountAdminMentor(); });
      }
    });
  }

  // ---- Study materials: types, sizes, and Drive-style background uploads ------------------
  var MATERIAL_KINDS = {
    pdf: { kind: "pdf", label: "PDF" },
    png: { kind: "image", label: "IMG" }, jpg: { kind: "image", label: "IMG" }, jpeg: { kind: "image", label: "IMG" }, webp: { kind: "image", label: "IMG" },
    doc: { kind: "doc", label: "DOC" }, docx: { kind: "doc", label: "DOC" },
    ppt: { kind: "slides", label: "PPT" }, pptx: { kind: "slides", label: "PPT" },
    xls: { kind: "sheet", label: "XLS" }, xlsx: { kind: "sheet", label: "XLS" }, csv: { kind: "sheet", label: "CSV" },
    txt: { kind: "text", label: "TXT" }
  };

  function materialKind(name) {
    var match = /\.([a-z0-9]{1,5})$/i.exec(String(name || ""));
    return MATERIAL_KINDS[match ? match[1].toLowerCase() : ""] || { kind: "file", label: "FILE" };
  }

  function formatBytes(bytes) {
    var value = Number(bytes || 0);
    if (value < 1024) return value + " B";
    if (value < 1024 * 1024) return Math.round(value / 1024) + " KB";
    return (value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0) + " MB";
  }

  function materialTypeBadge(name) {
    var kind = materialKind(name);
    return '<span class="materials-type-badge is-' + kind.kind + '" aria-hidden="true">' + kind.label + '</span>';
  }

  // Uploads go straight from the browser into Google Drive (the server opens a resumable
  // session in the target folder), with real progress, three at a time, while the admin keeps working. The panel lives on document.body,
  // so Studio re-renders and route changes leave it alone; only a full reload would stop an
  // upload, so the page asks before unloading while any are running.
  var MATERIAL_UPLOAD_CONCURRENCY = 3;
  var materialUploads = { items: [], nextId: 1, collapsed: false, onChange: null, renderQueued: false, refreshTimer: null };

  function isUploadActive(item) {
    return item.status === "signing" || item.status === "uploading" || item.status === "finishing";
  }

  function activeMaterialUploads() {
    return materialUploads.items.filter(isUploadActive);
  }

  window.addEventListener("beforeunload", function (event) {
    if (!activeMaterialUploads().length) return;
    event.preventDefault();
    event.returnValue = "";
  });

  function queueMaterialUploads(folder, files, batch) {
    Array.prototype.forEach.call(files || [], function (file) {
      materialUploads.items.push({
        id: materialUploads.nextId++,
        file: file,
        folderId: folder.id,
        folderName: folder.name,
        status: "waiting",
        loaded: 0,
        total: file.size || 0,
        error: "",
        xhr: null,
        batch: batch || null
      });
      if (batch) batch.pending += 1;
    });
    materialUploads.collapsed = false;
    renderMaterialUploadPanel();
    pumpMaterialUploads();
  }

  function pumpMaterialUploads() {
    var free = MATERIAL_UPLOAD_CONCURRENCY - activeMaterialUploads().length;
    materialUploads.items.filter(function (item) { return item.status === "waiting"; }).slice(0, Math.max(0, free)).forEach(startMaterialUpload);
  }

  function sendToDrive(item, session) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      item.xhr = xhr;
      xhr.open("PUT", session.uploadUrl);
      if (item.file.type) xhr.setRequestHeader("Content-Type", item.file.type);
      xhr.upload.onprogress = function (event) {
        if (event.lengthComputable) {
          item.loaded = event.loaded;
          item.total = event.total;
        }
        scheduleMaterialUploadRender();
      };
      xhr.onload = function () {
        item.xhr = null;
        if (xhr.status >= 200 && xhr.status < 300) {
          var file = null;
          try { file = JSON.parse(xhr.responseText); } catch (_err) { }
          if (file && file.id) {
            resolve(file);
            return;
          }
          reject(new Error("Google Drive didn't confirm the upload."));
          return;
        }
        var message = "";
        try { message = JSON.parse(xhr.responseText).error.message; } catch (_err) { }
        reject(new Error(message || ("Upload failed (" + xhr.status + ").")));
      };
      xhr.onerror = function () {
        item.xhr = null;
        reject(new Error("Network error. Check your connection and retry."));
      };
      xhr.onabort = function () {
        item.xhr = null;
        reject(Object.assign(new Error("Cancelled"), { cancelled: true }));
      };
      xhr.send(item.file);
    });
  }

  function startMaterialUpload(item) {
    item.status = "signing";
    item.error = "";
    item.loaded = 0;
    scheduleMaterialUploadRender();
    Promise.resolve(store.startDriveUpload({ parentId: item.folderId || null, name: item.file.name, mimeType: item.file.type || "", size: item.file.size || 0 }))
      .then(function (session) {
        if (item.status === "cancelled") return null;
        item.status = "uploading";
        scheduleMaterialUploadRender();
        return sendToDrive(item, session);
      })
      .then(function (uploaded) {
        if (!uploaded || item.status === "cancelled") return null;
        item.status = "finishing";
        item.loaded = item.total;
        scheduleMaterialUploadRender();
        return store.completeDriveUpload(uploaded.id);
      })
      .then(function (file) {
        if (!file) return;
        item.status = "done";
        item.savedName = file.name;
        item.file = null; // nothing left to retry; let the bytes go
        announceMaterialUpload(item.savedName + " uploaded to " + item.folderName + ".");
        refreshMaterialsSoon();
        if (item.batch) item.batch.done += 1;
      })
      .catch(function (error) {
        if (item.status === "cancelled" || (error && error.cancelled)) {
          item.status = "cancelled";
          return;
        }
        item.status = "failed";
        item.error = error && error.message ? error.message : "Upload failed.";
        announceMaterialUpload(item.file.name + " couldn't be uploaded.");
      })
      .then(function () {
        if (item.batch && item.status !== "waiting") settleMaterialBatch(item.batch);
        renderMaterialUploadPanel();
        pumpMaterialUploads();
      });
  }

  function settleMaterialBatch(batch) {
    var items = materialUploads.items.filter(function (item) { return item.batch === batch; });
    if (items.some(function (item) { return item.status !== "done"; })) return;
    if (typeof batch.onAllDone === "function" && !batch.finished) {
      batch.finished = true;
      batch.onAllDone();
    }
  }

  function cancelMaterialUpload(id) {
    var item = materialUploads.items.find(function (entry) { return entry.id === id; });
    if (!item || item.status === "finishing" || item.status === "done") return;
    var xhr = item.xhr;
    item.status = "cancelled";
    if (xhr) xhr.abort();
    renderMaterialUploadPanel();
    pumpMaterialUploads();
  }

  function retryMaterialUpload(id) {
    var item = materialUploads.items.find(function (entry) { return entry.id === id; });
    if (!item || !item.file || (item.status !== "failed" && item.status !== "cancelled")) return;
    item.status = "waiting";
    item.error = "";
    renderMaterialUploadPanel();
    pumpMaterialUploads();
  }

  function refreshMaterialsSoon() {
    window.clearTimeout(materialUploads.refreshTimer);
    materialUploads.refreshTimer = window.setTimeout(function () {
      invalidateDriveCache();
      if (typeof materialUploads.onChange === "function") materialUploads.onChange();
    }, 400);
  }

  function announceMaterialUpload(text) {
    var live = document.getElementById("upload-panel-live");
    if (live) live.textContent = text;
  }

  function scheduleMaterialUploadRender() {
    if (materialUploads.renderQueued) return;
    materialUploads.renderQueued = true;
    window.requestAnimationFrame(function () {
      materialUploads.renderQueued = false;
      renderMaterialUploadPanel();
    });
  }

  function uploadStatusText(item) {
    if (item.status === "waiting") return "Waiting…";
    if (item.status === "signing") return "Starting…";
    if (item.status === "uploading") {
      var pct = item.total ? Math.min(100, Math.floor((item.loaded / item.total) * 100)) : 0;
      return pct + "% · " + formatBytes(item.loaded) + " of " + formatBytes(item.total);
    }
    if (item.status === "finishing") return "Finishing…";
    if (item.status === "done") return "Uploaded to " + item.folderName;
    if (item.status === "cancelled") return "Cancelled";
    return item.error || "Upload failed";
  }

  function uploadProgress(item) {
    if (item.status === "done" || item.status === "finishing") return 1;
    if (item.status === "uploading" && item.total) return Math.min(1, item.loaded / item.total);
    return 0;
  }

  function renderMaterialUploadPanel() {
    var items = materialUploads.items;
    var panel = document.getElementById("material-upload-panel");
    if (!items.length) {
      if (panel) panel.remove();
      return;
    }
    if (!panel) {
      panel = document.createElement("section");
      panel.id = "material-upload-panel";
      panel.className = "upload-panel";
      panel.setAttribute("role", "region");
      panel.setAttribute("aria-label", "Uploads");
      document.body.appendChild(panel);
      panel.addEventListener("click", onMaterialUploadPanelClick);
    }
    var focused = document.activeElement && panel.contains(document.activeElement) ? document.activeElement.getAttribute("data-upload-focus") : null;
    var liveText = (document.getElementById("upload-panel-live") || {}).textContent || "";
    var active = activeMaterialUploads().length;
    var waiting = items.filter(function (item) { return item.status === "waiting"; }).length;
    var done = items.filter(function (item) { return item.status === "done"; }).length;
    var failed = items.filter(function (item) { return item.status === "failed"; }).length;
    var inFlight = active + waiting;
    var title = inFlight
      ? "Uploading " + inFlight + (inFlight === 1 ? " item" : " items") + (done ? " · " + done + " complete" : "")
      : (failed ? failed + (failed === 1 ? " upload" : " uploads") + " failed" + (done ? " · " + done + " complete" : "") : done + (done === 1 ? " upload" : " uploads") + " complete");
    panel.innerHTML =
      '<header class="upload-panel-head">' +
      '<strong class="upload-panel-title">' + escapeHtml(title) + '</strong>' +
      '<div class="upload-panel-tools">' +
      '<button type="button" class="upload-panel-icon" data-upload-action="collapse" data-upload-focus="collapse" aria-expanded="' + (materialUploads.collapsed ? "false" : "true") + '" aria-label="' + (materialUploads.collapsed ? "Show uploads" : "Hide uploads") + '">' + (materialUploads.collapsed ? "▴" : "▾") + '</button>' +
      '<button type="button" class="upload-panel-icon" data-upload-action="close" data-upload-focus="close" aria-label="Close uploads">✕</button>' +
      '</div>' +
      '</header>' +
      '<ul class="upload-panel-list"' + (materialUploads.collapsed ? " hidden" : "") + '>' +
      items.slice().reverse().map(function (item) {
        var name = item.savedName || (item.file && item.file.name) || "File";
        var action = "";
        if (item.status === "waiting" || item.status === "signing" || item.status === "uploading") {
          action = '<button type="button" class="upload-row-action" data-upload-action="cancel" data-id="' + item.id + '" data-upload-focus="cancel-' + item.id + '" aria-label="Cancel upload of ' + escapeAttribute(name) + '">Cancel</button>';
        } else if ((item.status === "failed" || item.status === "cancelled") && item.file) {
          action = '<button type="button" class="upload-row-action" data-upload-action="retry" data-id="' + item.id + '" data-upload-focus="retry-' + item.id + '" aria-label="Retry upload of ' + escapeAttribute(name) + '">Retry</button>';
        } else if (item.status === "done") {
          action = '<button type="button" class="upload-row-action" data-upload-action="show" data-id="' + item.id + '" data-upload-focus="show-' + item.id + '" aria-label="Show ' + escapeAttribute(name) + ' in its folder">Show</button>';
        }
        return '<li class="upload-row is-' + item.status + '">' +
          materialTypeBadge(name) +
          '<div class="upload-row-main">' +
          '<span class="upload-row-name">' + escapeHtml(name) + '</span>' +
          '<span class="upload-row-status">' + escapeHtml(uploadStatusText(item)) + '</span>' +
          (item.status === "uploading" || item.status === "signing" || item.status === "finishing"
            ? '<span class="upload-row-bar" aria-hidden="true"><span style="transform: scaleX(' + uploadProgress(item).toFixed(3) + ');"></span></span>'
            : '') +
          '</div>' +
          action +
          '</li>';
      }).join("") +
      '</ul>' +
      '<p class="sr-only" id="upload-panel-live" aria-live="polite">' + escapeHtml(liveText) + '</p>';
    if (focused) {
      var again = panel.querySelector('[data-upload-focus="' + focused + '"]');
      if (again) again.focus();
    }
  }

  function onMaterialUploadPanelClick(event) {
    var button = event.target && event.target.closest ? event.target.closest("[data-upload-action]") : null;
    if (!button) return;
    var action = button.getAttribute("data-upload-action");
    var id = Number(button.getAttribute("data-id"));
    if (action === "collapse") {
      materialUploads.collapsed = !materialUploads.collapsed;
      renderMaterialUploadPanel();
    } else if (action === "close") {
      var running = materialUploads.items.filter(function (item) { return item.status === "waiting" || isUploadActive(item); });
      if (running.length && !window.confirm("Cancel " + running.length + (running.length === 1 ? " upload" : " uploads") + " in progress?")) return;
      running.forEach(function (item) { cancelMaterialUpload(item.id); });
      materialUploads.items = materialUploads.items.filter(function (item) { return item.status === "finishing"; });
      renderMaterialUploadPanel();
    } else if (action === "cancel") {
      cancelMaterialUpload(id);
    } else if (action === "retry") {
      retryMaterialUpload(id);
    } else if (action === "show") {
      var item = materialUploads.items.find(function (entry) { return entry.id === id; });
      if (!item) return;
      runtime.adminStudioTab = "materials";
      driveUi.adminFolderId = item.folderId || "";
      if ((window.location.hash || "").indexOf("admin") === -1) {
        navigate("admin");
      } else if (typeof materialUploads.onChange === "function") {
        materialUploads.onChange();
      }
    }
  }

  // ---- Study materials browser (Google Drive) -----------------------------------------------
  // One Drive-style browser for students (Resources → Study material) and admins (Studio →
  // Study Materials): breadcrumbs, folders at any depth, a dense list or a thumbnail grid,
  // search, and for admins new folder / upload / rename / move / colour / delete. Drive is the
  // source of truth; listings are cached here briefly (the server also caches for a minute).
  var DRIVE_COLORS = [
    ["", "Default"], ["#4285f4", "Blue"], ["#0f9d58", "Green"], ["#db4437", "Red"],
    ["#f4b400", "Yellow"], ["#ab47bc", "Purple"], ["#ff7537", "Orange"], ["#8f8f8f", "Grey"]
  ];
  var DRIVE_ICON_FOLDER = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false"><path fill="currentColor" d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg>';
  var DRIVE_ICON_LIST = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>';
  var DRIVE_ICON_GRID = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>';
  var DRIVE_ICON_DOWNLOAD = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>';
  var DRIVE_ICON_MORE = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><circle cx="12" cy="5" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="19" r="1.8" fill="currentColor"/></svg>';
  var DRIVE_LIST_TTL_MS = 60 * 1000;

  var driveUi = {
    cache: {},
    loading: {},
    errors: {},
    view: (function () { try { return localStorage.getItem("aceiiit_materials_view") === "grid" ? "grid" : "list"; } catch (_e) { return "list"; } })(),
    query: "",
    results: null,
    searchError: "",
    searchTimer: 0,
    searchSeq: 0,
    adminFolderId: "",
    status: null,
    statusError: "",
    mounted: null,
    menu: null,
    notice: "",
    dragDepth: 0
  };

  function driveKey(id) {
    return id || "root";
  }

  function invalidateDriveCache() {
    driveUi.cache = {};
    driveUi.errors = {};
  }

  function driveFileUrl(id, download) {
    return "/api/materials/files/" + encodeURIComponent(id) + "/content" + (download ? "?download=1" : "");
  }

  function driveWebUrl(item) {
    return item.kind === "folder" ? "https://drive.google.com/drive/folders/" + encodeURIComponent(item.id) : "https://drive.google.com/file/d/" + encodeURIComponent(item.id) + "/view";
  }

  function driveKindOf(item) {
    if (item.googleType === "document") return { kind: "doc", label: "DOC" };
    if (item.googleType === "spreadsheet") return { kind: "sheet", label: "SHEET" };
    if (item.googleType === "presentation") return { kind: "slides", label: "SLIDES" };
    var mime = String(item.mimeType || "");
    if (/^video\//.test(mime)) return { kind: "video", label: "VIDEO" };
    if (/^audio\//.test(mime)) return { kind: "audio", label: "AUDIO" };
    if (/zip|compressed|x-rar|x-7z/.test(mime)) return { kind: "file", label: "ZIP" };
    var kind = materialKind(item.name);
    if (kind.kind === "file" && /^image\//.test(mime)) return { kind: "image", label: "IMG" };
    if (kind.kind === "file" && mime === "application/pdf") return { kind: "pdf", label: "PDF" };
    return kind;
  }

  function driveBadge(item) {
    var kind = driveKindOf(item);
    return '<span class="materials-type-badge is-' + kind.kind + '" aria-hidden="true">' + kind.label + '</span>';
  }

  function driveDate(value) {
    if (!value) return "";
    try {
      return new Date(value).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
    } catch (_e) {
      return "";
    }
  }

  function currentDriveFolderId() {
    var m = driveUi.mounted;
    return m ? (m.options.folderId || "") : "";
  }

  function currentDriveListing() {
    var entry = driveUi.cache[driveKey(currentDriveFolderId())];
    return entry ? entry.data : null;
  }

  /** Mounts (or re-mounts) the browser into `root`. options: { admin, folderId, onOpenFolder } */
  function mountMaterialsBrowser(root, options) {
    if (!root) return;
    var previous = driveUi.mounted;
    driveUi.mounted = { root: root, options: options || {} };
    if (!previous || previous.options.folderId !== (options || {}).folderId) {
      driveUi.query = "";
      driveUi.results = null;
    }
    if (!root.__driveBound) {
      root.__driveBound = true;
      bindMaterialsBrowser(root);
    }
    if (options.admin && !driveUi.status) loadDriveStatus();
    renderMaterialsBrowser();
    loadDriveFolder(options.folderId || "", false);
  }

  function loadDriveStatus() {
    driveUi.statusError = "";
    return Promise.resolve(store.getDriveStatus()).then(function (status) {
      driveUi.status = status;
      renderMaterialsBrowser();
    }).catch(function (error) {
      driveUi.statusError = (error && error.message) || "Couldn't check Google Drive.";
      renderMaterialsBrowser();
    });
  }

  function loadDriveFolder(folderId, force) {
    var key = driveKey(folderId);
    var entry = driveUi.cache[key];
    if (!force && entry && Date.now() - entry.at < DRIVE_LIST_TTL_MS) return Promise.resolve(entry.data);
    if (driveUi.loading[key]) return driveUi.loading[key];
    driveUi.errors[key] = "";
    var request = Promise.resolve(store.listMaterials(folderId)).then(function (data) {
      driveUi.cache[key] = { data: data, at: Date.now() };
      return data;
    }).catch(function (error) {
      driveUi.errors[key] = { message: (error && error.message) || "Couldn't load this folder.", code: error && error.code, status: error && error.status };
      return null;
    }).then(function (data) {
      delete driveUi.loading[key];
      if (driveKey(currentDriveFolderId()) === key) renderMaterialsBrowser();
      return data;
    });
    driveUi.loading[key] = request;
    if (driveKey(currentDriveFolderId()) === key && !entry) renderMaterialsBrowser();
    return request;
  }

  function openDriveFolder(folderId) {
    var m = driveUi.mounted;
    if (!m) return;
    closeDriveMenu(false);
    if (typeof m.options.onOpenFolder === "function") m.options.onOpenFolder(folderId || "");
  }

  function buildDriveConnectionHtml() {
    var st = driveUi.status;
    var notice = driveUi.notice ? '<p class="drive-notice' + (/^Google Drive is connected/.test(driveUi.notice) ? '' : ' is-error') + '" role="status">' + escapeHtml(driveUi.notice) + '</p>' : '';
    return notice + buildDriveConnectionCard(st);
  }

  function buildDriveConnectionCard(st) {
    if (driveUi.statusError && !st) {
      return '<div class="drive-connect is-error"><p>' + escapeHtml(driveUi.statusError) + '</p><button type="button" class="button button-secondary button-compact" data-drive-action="status-retry">Try again</button></div>';
    }
    if (!st) return '<div class="drive-connect"><p aria-busy="true">Checking Google Drive…</p></div>';
    if (!st.connected) {
      return '<div class="drive-connect is-cta">' +
        '<div class="drive-connect-copy"><h3>Connect Google Drive</h3>' +
        '<p>Study material is stored in your Google Drive, in a folder called “AceIIIT Study Materials”. Anything you put there, here or straight in Google Drive, shows up for students. Uploads don\'t use Cloudinary.</p></div>' +
        '<button type="button" class="button button-primary" data-drive-action="connect">Connect Google Drive</button>' +
        '</div>';
    }
    if (st.needsReconnect) {
      return '<div class="drive-connect is-warn"><p><strong>Google Drive needs to be connected again.</strong> Access was revoked or expired, so students can\'t open materials until you reconnect.</p>' +
        '<button type="button" class="button button-primary button-compact" data-drive-action="connect">Reconnect</button></div>';
    }
    return '<div class="drive-connect is-connected">' +
      '<p><span class="drive-connect-dot" aria-hidden="true"></span>Google Drive · <strong>' + escapeHtml(st.accountEmail || "connected") + '</strong> · folder <a href="' + escapeAttribute(st.root.url) + '" target="_blank" rel="noopener">' + escapeHtml(st.root.name || "Study materials") + '</a></p>' +
      '<div class="drive-connect-actions">' +
      '<button type="button" class="button button-secondary button-compact" data-drive-action="change-root">Use another folder</button>' +
      '<button type="button" class="button button-secondary button-compact" data-drive-action="disconnect">Disconnect</button>' +
      '</div></div>';
  }

  function buildDriveCrumbsHtml(listing, admin) {
    var crumbs = (listing && listing.breadcrumbs) || [{ id: "", name: "Study material" }];
    return '<nav class="drive-crumbs" aria-label="Folder path"><ol>' + crumbs.map(function (crumb, index) {
      var last = index === crumbs.length - 1;
      var id = index === 0 ? "" : crumb.id;
      var label = escapeHtml(crumb.name);
      if (last) return '<li><span aria-current="page">' + label + '</span></li>';
      return '<li>' + (admin
        ? '<button type="button" class="drive-crumb" data-drive-open="' + escapeAttribute(id) + '">' + label + '</button>'
        : '<a class="drive-crumb" href="#resources/materials' + (id ? "/" + encodeURIComponent(id) : "") + '">' + label + '</a>') + '</li>';
    }).join("") + '</ol></nav>';
  }

  function buildDriveToolbarHtml(listing, admin) {
    return '<div class="drive-toolbar">' +
      buildDriveCrumbsHtml(listing, admin) +
      '<div class="drive-tools">' +
      '<div class="drive-search" role="search">' +
      '<label class="sr-only" for="drive-search-input">Search study material</label>' +
      '<input id="drive-search-input" type="search" placeholder="Search files" autocomplete="off" value="' + escapeAttribute(driveUi.query) + '" data-drive-search>' +
      '</div>' +
      '<div class="drive-view" role="group" aria-label="Layout">' +
      '<button type="button" class="drive-view-btn" data-drive-view="list" aria-pressed="' + (driveUi.view === "list") + '" aria-label="List view" title="List">' + DRIVE_ICON_LIST + '</button>' +
      '<button type="button" class="drive-view-btn" data-drive-view="grid" aria-pressed="' + (driveUi.view === "grid") + '" aria-label="Grid view" title="Grid">' + DRIVE_ICON_GRID + '</button>' +
      '</div>' +
      (admin
        ? '<button type="button" class="button button-secondary button-compact" data-drive-action="new-folder">New folder</button>' +
          '<button type="button" class="button button-primary button-compact" data-drive-action="upload">Upload</button>' +
          '<input type="file" multiple hidden data-drive-file>' +
          '<button type="button" class="button button-secondary button-compact" data-drive-action="refresh" title="Show changes made in Google Drive">Refresh</button>'
        : '') +
      '</div>' +
      '</div>';
  }

  function buildDriveFolderTile(folder, admin) {
    var count = folder.itemCount === null || folder.itemCount === undefined ? "" : folder.itemCount + (folder.itemCount === 1 ? " item" : " items");
    var inner = '<span class="drive-folder-icon"' + (folder.color ? ' style="color:' + escapeAttribute(folder.color) + ';"' : '') + '>' + DRIVE_ICON_FOLDER + '</span>' +
      '<span class="drive-folder-text"><span class="drive-folder-name">' + escapeHtml(folder.name) + '</span>' +
      (count ? '<span class="drive-folder-meta">' + escapeHtml(count) + '</span>' : '') + '</span>';
    return '<li class="drive-folder" data-drop-folder="' + escapeAttribute(folder.id) + '" data-drop-name="' + escapeAttribute(folder.name) + '">' +
      (admin
        ? '<button type="button" class="drive-folder-link" data-drive-open="' + escapeAttribute(folder.id) + '">' + inner + '</button>'
        : '<a class="drive-folder-link" href="#resources/materials/' + encodeURIComponent(folder.id) + '">' + inner + '</a>') +
      (admin ? buildDriveMoreButton(folder) : '') +
      '</li>';
  }

  function buildDriveMoreButton(item) {
    return '<button type="button" class="drive-more" data-drive-menu="' + escapeAttribute(item.id) + '" aria-haspopup="menu" aria-expanded="false" aria-label="' + escapeAttribute("More actions for " + item.name) + '">' + DRIVE_ICON_MORE + '</button>';
  }

  function buildDriveFileRow(file, admin, path) {
    var size = file.size ? formatBytes(file.size) : (file.googleType ? "Google " + file.googleType : "");
    var thumb = driveUi.view === "grid"
      ? '<span class="drive-thumb">' + (file.hasThumbnail ? '<img src="/api/materials/files/' + encodeURIComponent(file.id) + '/thumbnail" alt="" loading="lazy" onerror="this.remove()">' : '') + driveBadge(file) + '</span>'
      : driveBadge(file);
    return '<li class="drive-file">' +
      thumb +
      '<a class="drive-file-name" href="' + driveFileUrl(file.id, false) + '" target="_blank" rel="noopener">' +
      '<span class="drive-file-title">' + escapeHtml(file.name) + '</span>' +
      (path ? '<span class="drive-file-path">' + escapeHtml(path.join(" › ")) + '</span>' : '') +
      '</a>' +
      '<span class="drive-file-size">' + escapeHtml(size) + '</span>' +
      '<span class="drive-file-date">' + escapeHtml(driveDate(file.modifiedTime)) + '</span>' +
      '<a class="drive-icon-btn" href="' + driveFileUrl(file.id, true) + '" aria-label="' + escapeAttribute("Download " + file.name) + '" title="Download">' + DRIVE_ICON_DOWNLOAD + '</a>' +
      (admin ? buildDriveMoreButton(file) : '') +
      '</li>';
  }

  function buildDriveBodyHtml() {
    var m = driveUi.mounted;
    var admin = Boolean(m.options.admin);
    var key = driveKey(m.options.folderId);
    var listing = currentDriveListing();
    var error = driveUi.errors[key];
    if (driveUi.query.trim().length >= 2) {
      if (driveUi.searchError) return '<p class="drive-notice is-error" role="alert">' + escapeHtml(driveUi.searchError) + '</p>';
      if (!driveUi.results) return '<div class="drive-skeleton" aria-busy="true" aria-label="Searching"><span></span><span></span><span></span></div>';
      var found = driveUi.results;
      var folders = found.filter(function (i) { return i.kind === "folder"; });
      var files = found.filter(function (i) { return i.kind !== "folder"; });
      return '<p class="drive-result-count" role="status">' + found.length + (found.length === 1 ? " result" : " results") + ' for “' + escapeHtml(driveUi.query.trim()) + '”</p>' +
        (folders.length ? '<ul class="drive-folders">' + folders.map(function (f) { return buildDriveFolderTile(f, admin); }).join("") + '</ul>' : '') +
        (files.length ? '<ul class="drive-files">' + files.map(function (f) { return buildDriveFileRow(f, admin, f.path); }).join("") + '</ul>' : '') +
        (!found.length ? '<p class="drive-empty">No files match that name. Try a shorter word.</p>' : '');
    }
    if (error && !listing) {
      if (error.code === "DRIVE_NOT_FOUND" && m.options.folderId) {
        return '<div class="drive-empty"><p>This folder isn\'t available any more.</p><button type="button" class="button button-secondary button-compact" data-drive-open="">Back to Study material</button></div>';
      }
      return '<div class="drive-notice is-error" role="alert"><p>' + escapeHtml(error.message) + '</p><button type="button" class="button button-secondary button-compact" data-drive-action="retry">Try again</button></div>';
    }
    if (!listing) return '<div class="drive-skeleton" aria-busy="true" aria-label="Loading folder"><span></span><span></span><span></span><span></span></div>';
    if (listing.connected === false) {
      return admin ? '' : '<div class="portal-empty-card"><h4 class="portal-empty-title">Study material isn\'t available yet</h4><p class="portal-empty-text">Notes and formula sheets appear here as soon as your instructors publish them.</p><a href="#resources/bookmarks" class="button button-secondary">Revise your bookmarks</a></div>';
    }
    var html = '';
    if (listing.folders.length) {
      html += '<section aria-label="Folders"><h3 class="drive-section-label">Folders</h3><ul class="drive-folders">' + listing.folders.map(function (f) { return buildDriveFolderTile(f, admin); }).join("") + '</ul></section>';
    }
    if (listing.files.length) {
      html += '<section aria-label="Files"><h3 class="drive-section-label">Files <span class="drive-section-count">' + listing.files.length + '</span></h3>' +
        (driveUi.view === "list" ? '<div class="drive-list-head" aria-hidden="true"><span>Name</span><span>Size</span><span>Modified</span></div>' : '') +
        '<ul class="drive-files">' + listing.files.map(function (f) { return buildDriveFileRow(f, admin); }).join("") + '</ul></section>';
    }
    if (!html) {
      html = admin
        ? '<div class="drive-empty is-drop"><p>This folder is empty.</p><p class="drive-empty-hint">Drop files here, or</p><button type="button" class="button button-primary button-compact" data-drive-action="upload">Upload files</button></div>'
        : '<div class="drive-empty"><p>Nothing here yet.</p></div>';
    }
    return html;
  }

  function renderMaterialsBrowser() {
    var m = driveUi.mounted;
    if (!m || !document.body.contains(m.root)) return;
    var admin = Boolean(m.options.admin);
    var listing = currentDriveListing();
    var root = m.root;
    var focusedSearch = document.activeElement && document.activeElement.hasAttribute && document.activeElement.hasAttribute("data-drive-search");
    var caret = focusedSearch ? document.activeElement.selectionStart : null;
    var showBrowser = !admin || (driveUi.status && driveUi.status.connected);
    root.innerHTML =
      '<div class="drive' + (admin ? ' is-admin' : '') + '" data-view="' + driveUi.view + '">' +
      (admin ? buildDriveConnectionHtml() : '') +
      (showBrowser && !(listing && listing.connected === false && !admin)
        ? buildDriveToolbarHtml(listing, admin) + '<div class="drive-body" data-drive-body>' + buildDriveBodyHtml() + '</div>'
        : (!admin ? '<div class="drive-body" data-drive-body>' + buildDriveBodyHtml() + '</div>' : '')) +
      '<p class="sr-only" role="status" data-drive-live></p>' +
      '</div>';
    if (focusedSearch) {
      var input = root.querySelector("[data-drive-search]");
      if (input) {
        input.focus();
        try { input.setSelectionRange(caret, caret); } catch (_e) { }
      }
    }
  }

  function renderDriveBody() {
    var m = driveUi.mounted;
    var body = m && m.root.querySelector("[data-drive-body]");
    if (body) body.innerHTML = buildDriveBodyHtml();
    else renderMaterialsBrowser();
  }

  function announceDrive(text) {
    var live = driveUi.mounted && driveUi.mounted.root.querySelector("[data-drive-live]");
    if (!live) return;
    live.textContent = "";
    window.setTimeout(function () { live.textContent = text; }, 40);
  }

  function runDriveSearch() {
    var q = driveUi.query.trim();
    var seq = ++driveUi.searchSeq;
    driveUi.searchError = "";
    if (q.length < 2) {
      driveUi.results = null;
      renderDriveBody();
      return;
    }
    driveUi.results = null;
    renderDriveBody();
    Promise.resolve(store.searchMaterials(q)).then(function (data) {
      if (seq !== driveUi.searchSeq) return;
      driveUi.results = (data && data.items) || [];
      renderDriveBody();
    }).catch(function (error) {
      if (seq !== driveUi.searchSeq) return;
      driveUi.searchError = (error && error.message) || "Search failed.";
      renderDriveBody();
    });
  }

  function findDriveItem(id) {
    var listing = currentDriveListing();
    var pool = [].concat(listing ? listing.folders.concat(listing.files) : [], driveUi.results || []);
    return pool.filter(function (item) { return item.id === id; })[0] || null;
  }

  function afterDriveChange(message) {
    invalidateDriveCache();
    if (message) announceDrive(message);
    if (driveUi.query.trim().length >= 2) runDriveSearch();
    loadDriveFolder(currentDriveFolderId(), true);
  }

  function driveFail(error) {
    window.alert((error && error.message) || "That didn't work. Try again.");
  }

  // ---- the "More actions" menu (admins) ----
  function closeDriveMenu(restoreFocus) {
    var menu = driveUi.menu;
    if (!menu) return;
    driveUi.menu = null;
    if (menu.el && menu.el.parentNode) menu.el.parentNode.removeChild(menu.el);
    document.removeEventListener("mousedown", menu.outside, true);
    document.removeEventListener("keydown", menu.keys, true);
    if (menu.button && document.body.contains(menu.button)) {
      menu.button.setAttribute("aria-expanded", "false");
      if (restoreFocus !== false) menu.button.focus();
    }
  }

  function openDriveMenu(button) {
    var id = button.getAttribute("data-drive-menu");
    var item = findDriveItem(id);
    if (!item) return;
    if (driveUi.menu && driveUi.menu.button === button) {
      closeDriveMenu();
      return;
    }
    closeDriveMenu(false);
    var el = document.createElement("div");
    el.className = "drive-menu";
    el.setAttribute("role", "menu");
    el.id = "drive-menu-" + id;
    el.setAttribute("aria-label", "Actions for " + item.name);
    el.innerHTML =
      (item.kind === "file" ? '<a role="menuitem" href="' + driveFileUrl(item.id, false) + '" target="_blank" rel="noopener">Open</a>' : '') +
      '<button type="button" role="menuitem" data-drive-do="rename">Rename</button>' +
      '<button type="button" role="menuitem" data-drive-do="move">Move to…</button>' +
      (item.kind === "folder"
        ? '<div class="drive-menu-colors" role="group" aria-label="Folder colour">' + DRIVE_COLORS.map(function (c) {
            return '<button type="button" role="menuitemradio" aria-checked="' + ((item.color || "") === c[0]) + '" class="drive-swatch" data-drive-color="' + escapeAttribute(c[0]) + '" aria-label="' + escapeAttribute(c[1]) + '" title="' + escapeAttribute(c[1]) + '"' + (c[0] ? ' style="background:' + escapeAttribute(c[0]) + ';"' : '') + '></button>';
          }).join("") + '</div>'
        : '') +
      '<a role="menuitem" href="' + escapeAttribute(driveWebUrl(item)) + '" target="_blank" rel="noopener">Open in Google Drive</a>' +
      '<button type="button" role="menuitem" class="is-danger" data-drive-do="delete">Delete</button>';
    document.body.appendChild(el);
    var rect = button.getBoundingClientRect();
    var top = rect.bottom + 4;
    var left = Math.max(8, Math.min(window.innerWidth - el.offsetWidth - 8, rect.right - el.offsetWidth));
    if (top + el.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - el.offsetHeight - 4);
    el.style.top = top + "px";
    el.style.left = left + "px";
    button.setAttribute("aria-expanded", "true");
    button.setAttribute("aria-controls", el.id);
    var menu = {
      el: el,
      button: button,
      item: item,
      outside: function (event) {
        if (!el.contains(event.target) && event.target !== button && !button.contains(event.target)) closeDriveMenu(false);
      },
      keys: function (event) {
        var items = Array.prototype.slice.call(el.querySelectorAll('[role^="menuitem"]'));
        var index = items.indexOf(document.activeElement);
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          closeDriveMenu();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          var next = event.key === "ArrowDown" ? index + 1 : index - 1;
          items[(next + items.length) % items.length].focus();
        } else if (event.key === "Tab") {
          closeDriveMenu(false);
        }
      }
    };
    driveUi.menu = menu;
    document.addEventListener("mousedown", menu.outside, true);
    document.addEventListener("keydown", menu.keys, true);
    el.addEventListener("click", function (event) {
      var target = event.target.closest ? event.target : null;
      if (!target) return;
      var color = target.closest("[data-drive-color]");
      var action = target.closest("[data-drive-do]");
      if (target.closest("a[role=menuitem]")) {
        closeDriveMenu(false);
        return;
      }
      if (color) {
        var value = color.getAttribute("data-drive-color");
        closeDriveMenu();
        Promise.resolve(store.updateMaterialItem(item.id, { color: value })).then(function () { afterDriveChange("Colour changed."); }).catch(driveFail);
      } else if (action) {
        var what = action.getAttribute("data-drive-do");
        closeDriveMenu();
        runDriveItemAction(what, item);
      }
    });
    var first = el.querySelector('[role^="menuitem"]');
    if (first) first.focus();
  }

  function runDriveItemAction(what, item) {
    if (what === "rename") {
      var name = window.prompt("Rename “" + item.name + "”", item.name);
      if (name === null || !name.trim() || name.trim() === item.name) return;
      Promise.resolve(store.updateMaterialItem(item.id, { name: name.trim() })).then(function () { afterDriveChange("Renamed to " + name.trim() + "."); }).catch(driveFail);
    } else if (what === "delete") {
      var noun = item.kind === "folder" ? "the folder “" + item.name + "” and everything in it" : "“" + item.name + "”";
      if (!window.confirm("Delete " + noun + "?\n\nIt moves to Google Drive's trash (restorable there for 30 days) and students won't see it.")) return;
      Promise.resolve(store.deleteMaterialItem(item.id)).then(function () { afterDriveChange(item.name + " deleted."); }).catch(driveFail);
    } else if (what === "move") {
      openDriveMovePicker(item);
    }
  }

  /** "Move to…": browse folders (from the root) and move the item into the chosen one. */
  function openDriveMovePicker(item) {
    var picker = { folderId: "", listing: null, error: "" };
    var renderPicker = function () {
      var body = document.querySelector("[data-drive-picker]");
      if (!body) return;
      if (picker.error) {
        body.innerHTML = '<p class="drive-notice is-error">' + escapeHtml(picker.error) + '</p>';
        return;
      }
      if (!picker.listing) {
        body.innerHTML = '<div class="drive-skeleton" aria-busy="true"><span></span><span></span></div>';
        return;
      }
      var crumbs = picker.listing.breadcrumbs || [];
      var folders = (picker.listing.folders || []).filter(function (f) { return f.id !== item.id; });
      body.innerHTML =
        '<nav class="drive-crumbs" aria-label="Destination path"><ol>' + crumbs.map(function (c, i) {
          return '<li>' + (i === crumbs.length - 1 ? '<span aria-current="page">' + escapeHtml(c.name) + '</span>' : '<button type="button" class="drive-crumb" data-pick-open="' + escapeAttribute(i === 0 ? "" : c.id) + '">' + escapeHtml(c.name) + '</button>') + '</li>';
        }).join("") + '</ol></nav>' +
        (folders.length
          ? '<ul class="drive-pick-list">' + folders.map(function (f) {
              return '<li><button type="button" class="drive-pick" data-pick-open="' + escapeAttribute(f.id) + '"><span class="drive-folder-icon"' + (f.color ? ' style="color:' + escapeAttribute(f.color) + ';"' : '') + '>' + DRIVE_ICON_FOLDER + '</span>' + escapeHtml(f.name) + '</button></li>';
            }).join("") + '</ul>'
          : '<p class="drive-empty-hint">No folders inside this one.</p>') +
        '<div class="button-row"><button type="button" class="button button-primary" data-pick-move>Move here</button></div>';
    };
    var load = function (id) {
      picker.folderId = id;
      picker.listing = null;
      picker.error = "";
      renderPicker();
      Promise.resolve(store.listMaterials(id)).then(function (data) {
        picker.listing = data;
        renderPicker();
      }).catch(function (error) {
        picker.error = (error && error.message) || "Couldn't load folders.";
        renderPicker();
      });
    };
    showAdminModal("Move “" + item.name + "”", '<div class="drive-picker" data-drive-picker></div>');
    var host = document.querySelector("[data-drive-picker]");
    if (host) {
      host.addEventListener("click", function (event) {
        var open = event.target.closest && event.target.closest("[data-pick-open]");
        var move = event.target.closest && event.target.closest("[data-pick-move]");
        if (open) load(open.getAttribute("data-pick-open"));
        if (move && picker.listing) {
          var target = picker.listing.folder || {};
          move.disabled = true;
          Promise.resolve(store.updateMaterialItem(item.id, { parentId: target.id })).then(function () {
            hideAdminModal();
            afterDriveChange(item.name + " moved to " + (target.name || "Study material") + ".");
          }).catch(function (error) {
            move.disabled = false;
            picker.error = (error && error.message) || "Couldn't move it.";
            renderPicker();
          });
        }
      });
    }
    load("");
  }

  function startDriveUploads(files, folderId, folderName) {
    if (!files || !files.length) return;
    var listing = currentDriveListing();
    var targetId = folderId || (listing && listing.folder && !listing.folder.isRoot ? listing.folder.id : "") || "";
    var targetName = folderName || (listing && listing.folder ? listing.folder.name : "Study material");
    var max = listing && listing.maxBytes ? listing.maxBytes : 0;
    var accepted = [];
    var tooBig = [];
    Array.prototype.forEach.call(files, function (file) {
      if (max && file.size > max) tooBig.push(file.name);
      else accepted.push(file);
    });
    if (tooBig.length) window.alert("Too large to upload (max " + formatBytes(max) + "):\n" + tooBig.join("\n"));
    if (accepted.length) queueMaterialUploads({ id: targetId, name: targetName }, accepted);
  }

  function bindMaterialsBrowser(root) {
    root.addEventListener("click", function (event) {
      var target = event.target && event.target.closest ? event.target : null;
      if (!target) return;
      var open = target.closest("[data-drive-open]");
      var view = target.closest("[data-drive-view]");
      var more = target.closest("[data-drive-menu]");
      var action = target.closest("[data-drive-action]");
      if (open) {
        openDriveFolder(open.getAttribute("data-drive-open"));
      } else if (view) {
        driveUi.view = view.getAttribute("data-drive-view") === "grid" ? "grid" : "list";
        try { localStorage.setItem("aceiiit_materials_view", driveUi.view); } catch (_e) { }
        renderMaterialsBrowser();
        var again = root.querySelector('[data-drive-view="' + driveUi.view + '"]');
        if (again) again.focus();
      } else if (more) {
        event.preventDefault();
        openDriveMenu(more);
      } else if (action) {
        var name = action.getAttribute("data-drive-action");
        if (name === "connect") {
          action.disabled = true;
          Promise.resolve(store.connectDrive()).then(function (data) { window.location.href = data.url; }).catch(function (error) {
            action.disabled = false;
            driveFail(error);
          });
        } else if (name === "disconnect") {
          if (!window.confirm("Disconnect Google Drive?\n\nStudents won't see study material until you connect again. Nothing is deleted from your Drive.")) return;
          Promise.resolve(store.disconnectDrive()).then(function () {
            driveUi.status = null;
            invalidateDriveCache();
            loadDriveStatus();
            loadDriveFolder(currentDriveFolderId(), true);
          }).catch(driveFail);
        } else if (name === "change-root") {
          var link = window.prompt("Paste the link of the Google Drive folder to use for study material:");
          if (!link || !link.trim()) return;
          Promise.resolve(store.setDriveRoot(link.trim())).then(function () {
            driveUi.status = null;
            loadDriveStatus();
            openDriveFolder("");
            afterDriveChange("Study material now uses the new folder.");
          }).catch(driveFail);
        } else if (name === "status-retry") {
          loadDriveStatus();
        } else if (name === "retry") {
          loadDriveFolder(currentDriveFolderId(), true);
        } else if (name === "refresh") {
          action.disabled = true;
          Promise.resolve(store.refreshMaterialsCache()).catch(function () { }).then(function () {
            afterDriveChange("Refreshed from Google Drive.");
          });
        } else if (name === "new-folder") {
          var folderName = window.prompt("New folder name");
          if (!folderName || !folderName.trim()) return;
          var listing = currentDriveListing();
          var parentId = listing && listing.folder && !listing.folder.isRoot ? listing.folder.id : null;
          Promise.resolve(store.createMaterialFolder(parentId, folderName.trim())).then(function () { afterDriveChange("Folder " + folderName.trim() + " created."); }).catch(driveFail);
        } else if (name === "upload") {
          var picker = root.querySelector("[data-drive-file]");
          if (picker) picker.click();
        }
      }
    });
    root.addEventListener("input", function (event) {
      if (!event.target.hasAttribute || !event.target.hasAttribute("data-drive-search")) return;
      driveUi.query = event.target.value;
      window.clearTimeout(driveUi.searchTimer);
      driveUi.searchTimer = window.setTimeout(runDriveSearch, 300);
    });
    root.addEventListener("change", function (event) {
      if (!event.target.hasAttribute || !event.target.hasAttribute("data-drive-file")) return;
      startDriveUploads(event.target.files);
      event.target.value = "";
    });
    // Drag files from the desktop onto the list (current folder) or onto a folder tile.
    root.addEventListener("dragenter", function (event) {
      if (!driveUi.mounted || !driveUi.mounted.options.admin || !event.dataTransfer || Array.prototype.indexOf.call(event.dataTransfer.types || [], "Files") === -1) return;
      event.preventDefault();
      driveUi.dragDepth += 1;
      root.classList.add("is-dropping");
    });
    root.addEventListener("dragover", function (event) {
      if (!root.classList.contains("is-dropping")) return;
      event.preventDefault();
      var tile = event.target.closest && event.target.closest("[data-drop-folder]");
      root.querySelectorAll(".drive-folder.is-drop-target").forEach(function (el) { if (el !== tile) el.classList.remove("is-drop-target"); });
      if (tile) tile.classList.add("is-drop-target");
    });
    root.addEventListener("dragleave", function () {
      driveUi.dragDepth = Math.max(0, driveUi.dragDepth - 1);
      if (!driveUi.dragDepth) {
        root.classList.remove("is-dropping");
        root.querySelectorAll(".drive-folder.is-drop-target").forEach(function (el) { el.classList.remove("is-drop-target"); });
      }
    });
    root.addEventListener("drop", function (event) {
      if (!root.classList.contains("is-dropping")) return;
      event.preventDefault();
      driveUi.dragDepth = 0;
      root.classList.remove("is-dropping");
      var tile = event.target.closest && event.target.closest("[data-drop-folder]");
      root.querySelectorAll(".drive-folder.is-drop-target").forEach(function (el) { el.classList.remove("is-drop-target"); });
      startDriveUploads(event.dataTransfer.files, tile ? tile.getAttribute("data-drop-folder") : "", tile ? tile.getAttribute("data-drop-name") : "");
    });
  }

  // ---- Admin Studio → Study Materials ----
  function buildAdminMaterialsHtml() {
    return '<div class="materials-studio" id="materials-studio"></div>';
  }

  function bindAdminMaterials() {
    var root = document.getElementById("materials-studio");
    if (!root) {
      materialUploads.onChange = null;
      return;
    }
    materialUploads.onChange = function () {
      invalidateDriveCache();
      loadDriveFolder(currentDriveFolderId(), true);
    };
    // Studio has no route per folder, so the open folder is kept in driveUi.adminFolderId.
    var openFolder = function (folderId) {
      driveUi.adminFolderId = folderId || "";
      mountMaterialsBrowser(root, { admin: true, folderId: driveUi.adminFolderId, onOpenFolder: openFolder });
      var here = root.querySelector(".drive-crumbs [aria-current]");
      if (here) {
        here.setAttribute("tabindex", "-1");
        here.focus({ preventScroll: true });
      }
    };
    mountMaterialsBrowser(root, { admin: true, folderId: driveUi.adminFolderId, onOpenFolder: openFolder });
  }

  // ---- Studio → User Payments: all users (server-paginated) and the user details window ---
  var ADMIN_USERS_PAGE_SIZE = 50;

  function loadAdminUsers(onDone) {
    var filter = runtime.adminUserFilterTab || "paid";
    var search = String(runtime.adminUserSearchQuery || "").trim();
    var page = Math.max(1, Number(runtime.adminUsersPage || 1));
    var key = filter + "|" + search + "|" + page;
    var previous = runtime.adminUsersList || {};
    if (previous.key === key && (previous.loading || previous.users || previous.error)) return;
    // Keep the previous page on screen while the next one loads.
    runtime.adminUsersList = { key: key, loading: true, users: previous.users || null, counts: previous.counts || null, pagination: previous.pagination || null };
    var params = { page: String(page), limit: String(ADMIN_USERS_PAGE_SIZE) };
    if (search) params.search = search;
    if (filter === "paid") params.isEnrolledOnly = "true";
    Promise.resolve(store.listUsersExtended(params)).then(function (data) {
      if (!runtime.adminUsersList || runtime.adminUsersList.key !== key) return;
      runtime.adminUsersList = {
        key: key,
        loading: false,
        users: Array.isArray(data && data.users) ? data.users : [],
        counts: (data && data.counts) || null,
        pagination: (data && data.pagination) || { page: page, pages: 1, total: 0, limit: ADMIN_USERS_PAGE_SIZE }
      };
    }).catch(function (error) {
      if (!runtime.adminUsersList || runtime.adminUsersList.key !== key) return;
      runtime.adminUsersList = { key: key, loading: false, users: null, counts: previous.counts || null, error: error && error.message ? error.message : "Network error" };
    }).then(function () {
      if (typeof onDone === "function") onDone();
    });
  }

  var RESOURCE_LABELS = { PAID_MOCK_SERIES: "Paid mock test series" };

  function resourceLabel(code) {
    var key = String(code || "").trim();
    if (!key) return "";
    if (RESOURCE_LABELS[key]) return RESOURCE_LABELS[key];
    var words = key.toLowerCase().split("_").filter(Boolean).join(" ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  function detailDate(value) {
    if (!value) return "—";
    var date = new Date(value);
    return isNaN(date.getTime()) ? "—" : formatDateOnly(date) + " " + date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  }

  function statusChip(text, tone) {
    return '<span class="user-detail-chip is-' + tone + '">' + escapeHtml(text) + '</span>';
  }

  var SITE_METHOD_LABELS = { MANUAL_UPI: "UPI (manual)", RAZORPAY: "Razorpay" };

  function siteTone(status) {
    var s = String(status || "").toUpperCase();
    if (s === "VERIFIED" || s === "PAID" || s === "ACTIVE") return "good";
    if (s.indexOf("PENDING") === 0) return "warn";
    if (s === "REJECTED" || s === "CANCELLED" || s === "REVOKED" || s === "EXPIRED") return "bad";
    return "muted";
  }

  function siteStatusLabel(status) {
    var words = String(status || "").toLowerCase().split("_").join(" ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  function rupees(value) {
    var n = Number(value);
    return Number.isFinite(n) ? "₹" + n.toLocaleString("en-IN") : "—";
  }

  // Orders, payments and screenshots from the AceIIIT site (read-only, through the portal).
  function buildSiteOrdersHtml(userId, site) {
    var body;
    if (!site || site.error) {
      body = '<p class="user-detail-muted">Couldn&rsquo;t reach the AceIIIT site' + (site && site.error ? ' (' + escapeHtml(site.error) + ')' : '') + '. Open Details again in a moment.</p>';
    } else if (site.configured === false) {
      body = '<p class="user-detail-muted">The AceIIIT site isn&rsquo;t connected yet.</p>';
    } else if (!site.found) {
      body = '<p class="user-detail-muted">No AceIIIT site account uses this email.</p>';
    } else if (!(site.orders || []).length) {
      body = '<p class="user-detail-muted">No orders on the AceIIIT site yet.</p>';
    } else {
      body = '<div class="site-orders">' + site.orders.map(function (order) {
        var items = order.items || [];
        var payments = order.payments || [];
        return '<article class="site-order">' +
          '<header class="site-order-head"><strong>Order ' + escapeHtml(order.orderNumber || "") + '</strong> ' + statusChip(siteStatusLabel(order.status), siteTone(order.status)) +
          '<span class="user-detail-meta">' + escapeHtml(detailDate(order.createdAt)) + ' · ' + escapeHtml(rupees(order.total)) + '</span></header>' +
          (items.length ? '<ul class="site-order-items">' + items.map(function (item) {
            return '<li>' + escapeHtml(item.productName || "Item") + (Number(item.quantity) > 1 ? ' × ' + escapeHtml(String(item.quantity)) : '') + ' <span class="user-detail-meta">' + escapeHtml(rupees(item.lineTotal)) + '</span></li>';
          }).join("") + '</ul>' : '') +
          payments.map(function (payment) {
            var receiptUrl = "/api/admin/users/" + encodeURIComponent(userId) + "/site-receipts/" + encodeURIComponent(payment.id);
            var receiptHtml = "";
            if (payment.hasReceipt) {
              receiptHtml = payment.receiptType === "pdf"
                ? '<a class="button button-secondary button-compact" href="' + receiptUrl + '" target="_blank" rel="noopener">Open payment screenshot (PDF)</a>'
                : '<a class="site-receipt" href="' + receiptUrl + '" target="_blank" rel="noopener" aria-label="Open the payment screenshot for order ' + escapeAttribute(order.orderNumber || "") + '">' +
                  '<img src="' + receiptUrl + '" alt="Payment screenshot for order ' + escapeAttribute(order.orderNumber || "") + '" loading="lazy"></a>';
            }
            return '<div class="site-payment">' +
              '<p class="site-payment-line"><strong>' + escapeHtml(SITE_METHOD_LABELS[payment.method] || siteStatusLabel(payment.method)) + '</strong> ' + statusChip(siteStatusLabel(payment.status), siteTone(payment.status)) +
              ' <span class="user-detail-meta">' + escapeHtml(rupees(payment.amount)) +
              (payment.utr ? ' · UTR ' + escapeHtml(payment.utr) : '') +
              (payment.verifiedAt ? ' · verified ' + escapeHtml(detailDate(payment.verifiedAt)) : ' · submitted ' + escapeHtml(detailDate(payment.createdAt))) + '</span></p>' +
              (payment.rejectionReason ? '<p class="user-detail-meta">Rejected: ' + escapeHtml(payment.rejectionReason) + '</p>' : '') +
              receiptHtml +
              '</div>';
          }).join("") +
          '</article>';
      }).join("") + '</div>';
      var ents = site.entitlements || [];
      if (ents.length) {
        body += '<p class="user-detail-meta">Site access: ' + ents.map(function (e) {
          return escapeHtml(String(e.resourceCode || "")) + ' (' + escapeHtml(siteStatusLabel(e.status)) + ')';
        }).join(", ") + '</p>';
      }
    }
    return '<section class="user-detail-section"><h4>On the AceIIIT site</h4>' + body + '</section>';
  }

  function buildAdminUserDetailsHtml(details, site) {
    var u = (details && details.user) || {};
    var entitlements = (details && details.entitlements) || [];
    var payments = (details && details.payments) || [];
    var attempts = (details && details.attempts) || [];
    var activeEntitlements = entitlements.filter(function (e) { return e.status === "active"; });
    var paid = !!u.isPaid || activeEntitlements.length > 0;
    var signIn = (u.signInMethods || []).map(function (m) { return m === "google" ? "Google" : m === "apple" ? "Apple" : m; });

    var row = function (label, value) {
      return '<div><dt>' + escapeHtml(label) + '</dt><dd>' + value + '</dd></div>';
    };

    var accessHtml =
      '<section class="user-detail-section">' +
      '<h4>Access</h4>' +
      '<p class="user-detail-lead">' + (paid ? statusChip("Paid", "good") + ' Full test series unlocked' : statusChip("Free tier", "muted") + ' Free mocks and one custom practice session') + '</p>' +
      (entitlements.length
        ? '<ul class="user-detail-list">' + entitlements.map(function (e) {
          var season = e.seasonId && e.seasonId.name ? e.seasonId.name : "Season";
          return '<li><strong>' + escapeHtml(season) + '</strong> · ' + escapeHtml(String(e.tier || "paid")) + ' ' +
            statusChip(String(e.status || ""), e.status === "active" ? "good" : "muted") +
            '<span class="user-detail-meta">Granted ' + escapeHtml(detailDate(e.grantedAt || e.createdAt)) + (e.source ? ' · via ' + escapeHtml(e.source === "commerce" ? "AceIIIT checkout" : e.source) : '') + '</span></li>';
        }).join("") + '</ul>'
        : '') +
      '</section>';

    var paymentsHtml =
      '<section class="user-detail-section">' +
      '<h4>Payments</h4>' +
      (payments.length
        ? '<ul class="user-detail-list">' + payments.map(function (p) {
          var raw = p.rawPayload || {};
          var what = raw.resourceCode ? resourceLabel(raw.resourceCode) : "Test series access";
          var tone = p.status === "verified" ? "good" : (p.status === "pending" ? "warn" : "bad");
          var season = p.seasonId && p.seasonId.name ? p.seasonId.name : "";
          return '<li><strong>' + escapeHtml(what) + '</strong>' + (season ? ' · ' + escapeHtml(season) : '') + ' ' + statusChip(String(p.status || ""), tone) +
            '<span class="user-detail-meta">' + escapeHtml(p.source === "commerce" ? "Paid on the AceIIIT site" : "Added by an admin") +
            ' · recorded ' + escapeHtml(detailDate(p.createdAt)) +
            (p.verifiedAt ? ' · verified ' + escapeHtml(detailDate(p.verifiedAt)) : '') + '</span>' +
            (raw.note ? '<span class="user-detail-meta">Note: ' + escapeHtml(String(raw.note)) + '</span>' : '') +
            '</li>';
        }).join("") + '</ul>'
        : '<p class="user-detail-muted">No payments recorded.</p>') +
      '</section>';

    var profileHtml =
      '<section class="user-detail-section">' +
      '<h4>Profile</h4>' +
      '<dl class="user-detail-grid">' +
      row("Email", escapeHtml(u.email || "—")) +
      row("Role", escapeHtml(u.role || "student")) +
      row("Account", escapeHtml(u.status || "—") + (u.lockedUntil ? ' · locked until ' + escapeHtml(detailDate(u.lockedUntil)) : '')) +
      row("Email verified", u.emailVerified ? "Yes" : "No") +
      row("Sign-in", escapeHtml(signIn.length ? signIn.join(", ") : "Email and password")) +
      row("Joined", escapeHtml(detailDate(u.createdAt))) +
      row("Last seen", escapeHtml(detailDate(u.lastSeenAt))) +
      '</dl>' +
      '</section>';

    var mocks = attempts.filter(function (a) { return !a.isPractice; });
    var practice = attempts.length - mocks.length;
    var attemptsHtml =
      '<section class="user-detail-section">' +
      '<h4>Activity</h4>' +
      '<p class="user-detail-lead">' + mocks.length + (mocks.length === 1 ? ' mock' : ' mocks') + ' submitted' + (practice ? ' · ' + practice + ' practice' + (practice === 1 ? ' session' : ' sessions') : '') + '</p>' +
      (mocks.length
        ? '<div class="table-like user-detail-attempts">' +
          '<div class="table-row header"><span>Test</span><span>Date</span><span>Score</span><span>Rank</span></div>' +
          mocks.slice(0, 10).map(function (a) {
            var test = store.getTestById ? store.getTestById(String(a.testId)) : null;
            return '<div class="table-row">' +
              '<span>' + escapeHtml(test && test.title ? test.title : "Mock test") + (a.attemptNumber > 1 ? ' · attempt ' + a.attemptNumber : '') + '</span>' +
              '<span>' + escapeHtml(formatDateOnly(a.submittedAt)) + '</span>' +
              '<span>' + escapeHtml(formatMarks(a.score)) + '</span>' +
              '<span>' + (a.invalidatedAt ? 'Removed' : (a.rank ? '#' + escapeHtml(String(a.rank)) : '—')) + '</span>' +
              '</div>';
          }).join("") +
          '</div>'
        : '') +
      '</section>';

    return '<div class="user-detail">' +
      '<p class="user-detail-email">' + escapeHtml(u.email || "") + '</p>' +
      accessHtml + paymentsHtml + buildSiteOrdersHtml(u.id, site) + profileHtml + attemptsHtml +
      '</div>';
  }

  // ---- Paper Health Check (Studio → Review & Validate) ----------------------------------------
  var PAPER_LETTERS = ["A", "B", "C", "D", "E", "F"];
  var PAPER_TARGET = { SUPR: 40, REAP: 50 };
  // Same delimiters the import checks: $$…$$, \[…\], \(…\), environments, $…$.
  // (An escaped \$ is swapped for a placeholder first: no regex lookbehind, for older Safari.)
  var PAPER_MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(\\begin\{(equation|align|alignat|gather|CD)\*?\}[\s\S]+?\\end\{\5\*?\})|\$([^$]+?)\$/g;

  /** KaTeX-checks every formula in a text; null when KaTeX hasn't loaded yet. */
  function formulaProblems(text) {
    if (!window.katex || typeof window.katex.renderToString !== "function") return null;
    var src = String(text || "").replace(/\\\$/g, "\uE001");
    var rest = src;
    var problems = [];
    var m;
    PAPER_MATH_RE.lastIndex = 0;
    while ((m = PAPER_MATH_RE.exec(src))) {
      var display = m[1] !== undefined || m[2] !== undefined || m[4] !== undefined;
      try {
        window.katex.renderToString((m[1] || m[2] || m[3] || m[4] || m[6] || "").replace(/\uE001/g, "\\$"), { throwOnError: true, displayMode: display, strict: "ignore" });
      } catch (err) {
        problems.push("“" + truncateText(m[0], 36) + "”: " + String((err && err.message) || err).replace(/^KaTeX parse error:\s*/, ""));
      }
      rest = rest.replace(m[0], "");
    }
    if ((rest.match(/\$/g) || []).length) problems.push("a $ without its closing $");
    return problems;
  }

  function prefersReducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function truncateText(text, max) {
    var s = String(text || "").replace(/\s+/g, " ").trim();
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  function paperQuestionKey(q) {
    return [q.section, String(q.prompt || "").replace(/\s+/g, " ").trim().toLowerCase(), (q.options || []).map(function (o) { return String(o).trim().toLowerCase(); }).join("|")].join("::");
  }

  /**
   * Everything the Review tab shows about a paper: blocking errors, warnings, what passed, a
   * 0–100 health score and the paper's blueprint. `imageFailures` is the set of image links that
   * failed to load (checked in the background).
   */
  function reviewPaper(test, allQuestions, allTests, attempts, imageFailures, reportCounts) {
    var errors = [];
    var warnings = [];
    var passed = [];
    var empty = { score: 0, errors: [{ id: "no-test", title: "No test selected.", questionIds: [] }], warnings: [], passed: [], blueprint: null, order: [], numbers: {} };
    if (!test) return empty;
    var byId = {};
    (allQuestions || []).forEach(function (q) { byId[q.id] = q; });
    var ids = Array.isArray(test.questionIds) ? test.questionIds.map(String) : [];
    var missingIds = ids.filter(function (id) { return !byId[id]; });
    var order = sortQuestionsForSelectedTest(test, ids.filter(function (id) { return byId[id]; }).map(function (id) { return byId[id]; }));
    var numbers = {};
    order.forEach(function (q, i) { numbers[q.id] = i + 1; });
    var mathReady = Boolean(window.katex && window.katex.renderToString);

    function add(list, id, title, detail, qs, weight) {
      list.push({ id: id, title: title, detail: detail || "", questionIds: (qs || []).map(function (q) { return q.id || q; }), weight: weight || 0 });
    }
    function check(id, passedTitle, failing, list, title, detail, weight) {
      if (failing.length) add(list, id, title.replace("{n}", failing.length), detail, failing, weight);
      else passed.push({ id: id, title: passedTitle });
    }

    // Blocking
    if (!String(test.title || "").trim()) add(errors, "title", "The test has no title.", "Add one in Setup.");
    else passed.push({ id: "title", title: "Title set" });
    if (!order.length) add(errors, "empty", "No questions attached yet.", "Add questions in Questions Studio or import a sheet.");
    if (missingIds.length) add(errors, "missing", missingIds.length + " attached question" + (missingIds.length === 1 ? " no longer exists" : "s no longer exist"), "They were deleted from the bank. Remove them from the paper in Questions Studio.");
    check("prompt", "Every question has text", order.filter(function (q) { return !String(q.prompt || "").trim(); }), errors, "{n} question(s) have no text");
    check("options", "Every question has at least 2 filled options", order.filter(function (q) {
      var opts = Array.isArray(q.options) ? q.options : [];
      return opts.length < 2 || opts.some(function (o) { return !String(o || "").trim(); });
    }), errors, "{n} question(s) have fewer than 2 options or an empty option");
    check("answer", "Every answer key points at a real option", order.filter(function (q) {
      var c = Number(q.correctOption);
      return q.correctOption === null || q.correctOption === undefined || !Number.isInteger(c) || c < 0 || c >= (q.options || []).length;
    }), errors, "{n} question(s) have a missing or invalid answer key");
    check("same-options", "No question repeats an option", order.filter(function (q) {
      var seen = {};
      return (q.options || []).some(function (o) { var k = String(o || "").trim().toLowerCase(); if (!k) return false; if (seen[k]) return true; seen[k] = true; return false; });
    }), errors, "{n} question(s) have two identical options");
    if (mathReady) {
      var broken = [];
      var brokenDetail = "";
      order.forEach(function (q) {
        var parts = [q.prompt, q.passage, q.explanation].concat(q.options || []);
        for (var i = 0; i < parts.length; i += 1) {
          var p = formulaProblems(parts[i]);
          if (p && p.length) { broken.push(q); if (!brokenDetail) brokenDetail = "Q" + numbers[q.id] + ": " + p[0]; return; }
        }
      });
      check("latex", "Every formula renders", broken, errors, "{n} question(s) have a formula that won't render", brokenDetail);
    } else {
      passed.push({ id: "latex", title: "Formula check waits for the maths engine to load" });
    }
    var counts = { SUPR: 0, REAP: 0 };
    order.forEach(function (q) { counts[q.section === "REAP" ? "REAP" : "SUPR"] += 1; });
    var durations = test.sectionDurations || {};
    var zeroTime = ["SUPR", "REAP"].filter(function (s) { return counts[s] && !Number(durations[s]); });
    if (zeroTime.length) add(errors, "time", zeroTime.join(" and ") + " has questions but 0 minutes", "Set the section time in Setup.");
    else passed.push({ id: "time", title: "Each section with questions has time" });
    if (test.status === "scheduled" && test.publishAt && new Date(test.publishAt).getTime() <= Date.now()) {
      add(errors, "schedule", "The scheduled time has already passed", "Publish now or pick a new time.");
    }

    // Warnings
    if (order.length && (counts.SUPR !== PAPER_TARGET.SUPR || counts.REAP !== PAPER_TARGET.REAP)) {
      add(warnings, "full", "Not a full UGEE paper (" + counts.SUPR + "/40 SUPR, " + counts.REAP + "/50 REAP)", "Fine for a sectional test; a full mock has 40 + 50.", [], 10);
    } else if (order.length) passed.push({ id: "full", title: "Full UGEE paper: 40 SUPR + 50 REAP" });
    var noExplanation = order.filter(function (q) { return !String(q.explanation || "").trim(); });
    check("explanation", "Every question has a solution", noExplanation, warnings, "{n} question(s) have no solution", "Students see solutions in the review after the test.", Math.min(12, 2 + Math.round((noExplanation.length / Math.max(1, order.length)) * 10)));
    check("topic", "Every question has a topic", order.filter(function (q) { return !String(q.topic || "").trim(); }), warnings, "{n} question(s) have no topic", "Topics drive practice papers and the topic analysis.", 8);
    var seenKeys = {};
    var dupes = [];
    order.forEach(function (q) { var k = paperQuestionKey(q); if (seenKeys[k]) dupes.push(q); else seenKeys[k] = true; });
    check("duplicates", "No question appears twice", dupes, warnings, "{n} question(s) appear twice in this paper", "", 8);
    var attemptedTests = {};
    (attempts || []).forEach(function (a) { if (a && a.testId && !a.invalidated) attemptedTests[String(a.testId)] = (attemptedTests[String(a.testId)] || 0) + 1; });
    var otherLive = {};
    var otherSeen = {};
    (allTests || []).forEach(function (t) {
      if (!t || t.id === test.id || t.isPractice) return;
      (t.questionIds || []).forEach(function (id) {
        if (t.status === "live" || t.status === "scheduled") otherLive[String(id)] = t.title;
        if (attemptedTests[t.id]) otherSeen[String(id)] = t.title;
      });
    });
    var reused = order.filter(function (q) { return otherLive[q.id]; });
    check("reused", "No question is in another live test", reused, warnings, "{n} question(s) are also in another live test", reused.length ? "e.g. Q" + numbers[reused[0].id] + " is in “" + otherLive[reused[0].id] + "”." : "", 6);
    var seen = order.filter(function (q) { return otherSeen[q.id]; });
    check("seen", "No question has been seen by students in another test", seen, warnings, "{n} question(s) students have already seen", seen.length ? "They were in “" + otherSeen[seen[0].id] + "”, and its solutions are open in review." : "", 8);
    check("marks", "Marks follow the section defaults", order.filter(function (q) {
      var d = getSectionDefaultMarking(q.section);
      return (q.marks !== undefined && q.marks !== null && Number(q.marks) !== d.marks) || (q.negativeMarks !== undefined && q.negativeMarks !== null && Number(q.negativeMarks) !== d.negativeMarks);
    }), warnings, "{n} question(s) use non-default marks", "SUPR is +1/−0.25 and REAP +2/−0.5 unless you changed it on purpose.", 4);

    // Answer key: skew and long runs of the same letter, per section.
    var answerKey = { SUPR: [0, 0, 0, 0, 0, 0], REAP: [0, 0, 0, 0, 0, 0] };
    var longestRun = { SUPR: { len: 0, letter: "" }, REAP: { len: 0, letter: "" } };
    ["SUPR", "REAP"].forEach(function (s) {
      var run = 0;
      var prev = -1;
      order.filter(function (q) { return (q.section === "REAP" ? "REAP" : "SUPR") === s; }).forEach(function (q) {
        var c = Number(q.correctOption);
        if (!Number.isInteger(c) || c < 0 || c > 5) { prev = -1; run = 0; return; }
        answerKey[s][c] += 1;
        run = c === prev ? run + 1 : 1;
        prev = c;
        if (run > longestRun[s].len) longestRun[s] = { len: run, letter: PAPER_LETTERS[c] };
      });
    });
    var skewNotes = [];
    ["SUPR", "REAP"].forEach(function (s) {
      var total = answerKey[s].reduce(function (a, b) { return a + b; }, 0);
      var top = Math.max.apply(null, answerKey[s]);
      if (total >= 10 && top / total > 0.4) skewNotes.push(s + ": " + PAPER_LETTERS[answerKey[s].indexOf(top)] + " is the answer " + Math.round((top / total) * 100) + "% of the time");
      if (longestRun[s].len >= 5) skewNotes.push(s + ": " + longestRun[s].len + " " + longestRun[s].letter + "s in a row");
    });
    if (skewNotes.length) add(warnings, "answer-key", "The answer key has a pattern students can guess", skewNotes.join(" · ") + ".", [], 6);
    else if (order.length) passed.push({ id: "answer-key", title: "Answers are spread out" });
    if (reportCounts) {
      var reported = order.filter(function (q) { return reportCounts[q.id]; });
      check("reports", "No open student reports", reported, warnings, "{n} question(s) have open student reports", reported.length ? "See Studio → Reports for what students said." : "", 10);
    }
    check("http-images", "Every image link is https", order.filter(function (q) { return (q.imageUrls || []).some(function (u) { return /^http:\/\//i.test(String(u)); }); }), warnings, "{n} question(s) use an http:// image", "Browsers may block it on the https site.", 4);
    var failedImages = imageFailures || {};
    var brokenImages = order.filter(function (q) { return (q.imageUrls || []).some(function (u) { return failedImages[u]; }); });
    var hasImages = order.some(function (q) { return (q.imageUrls || []).length; });
    if (hasImages) check("images", "Every image loads", brokenImages, warnings, "{n} question(s) have an image that doesn't load", "", 8);

    // Score: 100 minus warning weights; any blocking error caps it at 49.
    var score = 100 - warnings.reduce(function (sum, w) { return sum + (w.weight || 0); }, 0);
    if (errors.length) score = Math.min(49, score - errors.length * 12);
    score = Math.max(0, Math.min(100, Math.round(score)));

    // Blueprint
    var difficulty = { SUPR: { easy: 0, medium: 0, hard: 0 }, REAP: { easy: 0, medium: 0, hard: 0 } };
    var topics = {};
    var maxMarks = { SUPR: 0, REAP: 0 };
    order.forEach(function (q) {
      var s = q.section === "REAP" ? "REAP" : "SUPR";
      var d = ["easy", "medium", "hard"].indexOf(q.difficulty) !== -1 ? q.difficulty : "medium";
      difficulty[s][d] += 1;
      var name = String(q.topic || "").trim() || "(no topic)";
      topics[name] = topics[name] || { SUPR: 0, REAP: 0 };
      topics[name][s] += 1;
      var marks = q.marks !== undefined && q.marks !== null ? Number(q.marks) : getSectionDefaultMarking(s).marks;
      maxMarks[s] += Number.isFinite(marks) ? marks : 0;
    });
    return {
      score: score,
      errors: errors,
      warnings: warnings,
      passed: passed,
      order: order,
      numbers: numbers,
      blueprint: {
        counts: counts,
        difficulty: difficulty,
        answerKey: answerKey,
        longestRun: longestRun,
        maxMarks: maxMarks,
        durations: { SUPR: Number(durations.SUPR || 0), REAP: Number(durations.REAP || 0) },
        topics: Object.keys(topics).map(function (name) { return { name: name, SUPR: topics[name].SUPR, REAP: topics[name].REAP, total: topics[name].SUPR + topics[name].REAP }; })
          .sort(function (a, b) { return b.total - a.total || a.name.localeCompare(b.name); }),
      },
    };
  }

  /**
   * A donut chart (SVG). segments: [{label, value, tone}] (tone = CSS class suffix). Every
   * non-zero slice keeps a visible minimum; slices are separated by a 2px surface gap. The
   * legend next to it carries the numbers, so the chart itself is aria-hidden behind a label.
   */
  function buildDonut(segments, options) {
    options = options || {};
    var thickness = options.thickness || 12;
    var r = 50 - thickness / 2;
    var c = 2 * Math.PI * r;
    var total = segments.reduce(function (sum, s) { return sum + Math.max(0, Number(s.value) || 0); }, 0);
    var live = segments.filter(function (s) { return Number(s.value) > 0; });
    var minLen = c * 0.025;
    var raw = live.map(function (s) { return total ? (Number(s.value) / total) * c : 0; });
    var boosted = raw.map(function (len) { return Math.max(len, minLen); });
    var extra = boosted.reduce(function (a, b) { return a + b; }, 0) - c;
    if (extra > 0) {
      var bigTotal = boosted.reduce(function (sum, len) { return sum + (len > minLen ? len : 0); }, 0) || 1;
      boosted = boosted.map(function (len) { return len > minLen ? len - (len / bigTotal) * extra : len; });
    }
    var gap = live.length > 1 ? 2 : 0;
    var offset = 0;
    var arcs = live.map(function (s, i) {
      var len = Math.max(0.5, boosted[i] - gap);
      var pct = total ? Math.round((Number(s.value) / total) * 1000) / 10 : 0;
      var arc = '<circle class="donut-seg is-' + escapeAttribute(s.tone) + '" cx="50" cy="50" r="' + r + '" stroke-width="' + thickness + '"' +
        ' stroke-dasharray="' + len.toFixed(2) + ' ' + (c - len).toFixed(2) + '" stroke-dashoffset="' + (-offset).toFixed(2) + '"' +
        ' style="--len:' + len.toFixed(2) + ';--rest:' + (c - len).toFixed(2) + ';--i:' + i + '"' +
        ' data-donut-tip="' + escapeAttribute((options.tipPrefix ? options.tipPrefix + " · " : "") + s.value + " " + s.label + " (" + pct + "%)") + '"></circle>';
      offset += boosted[i];
      return arc;
    }).join("");
    return '<div class="donut' + (options.className ? " " + options.className : "") + '" role="img" aria-label="' + escapeAttribute(options.ariaLabel || "") + '">' +
      '<svg viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
      '<circle class="donut-track" cx="50" cy="50" r="' + r + '" stroke-width="' + thickness + '"></circle>' +
      '<g transform="rotate(-90 50 50)">' + arcs + '</g></svg>' +
      (options.centerValue !== undefined ? '<div class="donut-center" aria-hidden="true"><strong>' + escapeHtml(String(options.centerValue)) + '</strong>' + (options.centerLabel ? '<span>' + escapeHtml(options.centerLabel) + '</span>' : '') + '</div>' : '') +
      '</div>';
  }

  // One floating tooltip for every donut slice (hover on fine pointers).
  (function bindDonutTips() {
    var tip = null;
    function hide() { if (tip) tip.hidden = true; }
    document.addEventListener("pointerover", function (event) {
      var seg = event.target && event.target.closest ? event.target.closest("[data-donut-tip]") : null;
      if (!seg || event.pointerType === "touch") return hide();
      if (!tip) {
        tip = document.createElement("div");
        tip.className = "donut-tooltip";
        tip.setAttribute("aria-hidden", "true");
        document.body.appendChild(tip);
      }
      tip.textContent = seg.getAttribute("data-donut-tip");
      tip.hidden = false;
    });
    document.addEventListener("pointermove", function (event) {
      if (!tip || tip.hidden) return;
      tip.style.transform = "translate(" + Math.round(event.clientX + 12) + "px, " + Math.round(event.clientY - 32) + "px)";
    });
    document.addEventListener("pointerout", function (event) {
      if (event.target && event.target.closest && event.target.closest("[data-donut-tip]")) hide();
    });
    window.addEventListener("scroll", hide, { passive: true });
  })();

  function downloadTextFile(name, text, type) {
    var blob = new Blob(["﻿" + text], { type: type || "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.setAttribute("data-download-name", name);
    document.body.appendChild(link);
    link.click();
    window.setTimeout(function () { URL.revokeObjectURL(url); link.remove(); }, 1000);
  }

  function csvRow(cells) {
    return cells.map(function (v) {
      var t = String(v === null || v === undefined ? "" : v);
      return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    }).join(",");
  }

  function paperFileName(test, suffix) {
    return (String(test && test.title || "paper").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "paper") + "-" + suffix + ".csv";
  }

  function answerKeyCsv(review) {
    return [csvRow(["question", "section", "topic", "answer", "marks", "negative_marks"])].concat(review.order.map(function (q) {
      var d = getSectionDefaultMarking(q.section);
      return csvRow([review.numbers[q.id], q.section, q.topic, PAPER_LETTERS[Number(q.correctOption)] || "", q.marks !== undefined && q.marks !== null ? q.marks : d.marks, q.negativeMarks !== undefined && q.negativeMarks !== null ? q.negativeMarks : d.negativeMarks]);
    })).join("\r\n") + "\r\n";
  }

  function buildPaperReviewHtml(test, review) {
    if (!test) {
      return '<div class="admin-card"><p class="section-label">4. Review &amp; Validate</p><p class="helper-text">Pick or create a test first.</p></div>';
    }
    var bp = review.blueprint;
    var errorCount = review.errors.length;
    var warnCount = review.warnings.length;
    var tone = errorCount ? "bad" : (review.score >= 80 ? "good" : "warn");
    var verdict = errorCount
      ? "Fix " + errorCount + (errorCount === 1 ? " blocking issue" : " blocking issues") + " first"
      : (warnCount ? "Ready, with " + warnCount + (warnCount === 1 ? " warning" : " warnings") : "Ready to publish");
    var totalQuestions = bp.counts.SUPR + bp.counts.REAP;
    var totalMarks = bp.maxMarks.SUPR + bp.maxMarks.REAP;
    var fmt = function (n) { return String(Math.round(n * 100) / 100); };
    var statusLabel = test.status === "scheduled" && testOpensAt(test) ? "Scheduled · " + formatOpensAt(testOpensAt(test)) : (test.status === "live" ? "Live" : "Draft");

    var qChips = function (item) {
      if (!item.questionIds.length) return "";
      var shown = item.questionIds.slice(0, 14);
      return '<div class="pr-qs">' + shown.map(function (id) {
        var n = review.numbers[id];
        return n ? '<button type="button" class="pr-q js-pr-fix" data-id="' + escapeAttribute(id) + '" aria-label="Open question ' + n + ' in the editor">Q' + n + '</button>' : "";
      }).join("") + (item.questionIds.length > shown.length ? '<span class="pr-more">+' + (item.questionIds.length - shown.length) + ' more</span>' : '') + '</div>';
    };
    var itemHtml = function (item, kind) {
      var firstId = item.questionIds.filter(function (id) { return review.numbers[id]; })[0];
      return '<li class="pr-item is-' + kind + '">' +
        '<span class="pr-icon" aria-hidden="true">' + (kind === "error" ? "✕" : kind === "warning" ? "!" : "✓") + '</span>' +
        '<div class="pr-item-body"><strong>' + escapeHtml(item.title) + '</strong>' +
        (item.detail ? '<p>' + escapeHtml(item.detail) + '</p>' : '') + (kind === "passed" ? "" : qChips(item)) + '</div>' +
        (firstId ? '<button type="button" class="button button-secondary button-compact js-pr-fix" data-id="' + escapeAttribute(firstId) + '">Fix Q' + review.numbers[firstId] + '</button>' : '') +
        '</li>';
    };

    var sectionCard = ["SUPR", "REAP"].map(function (s) {
      var n = bp.counts[s];
      var pct = Math.min(100, Math.round((n / PAPER_TARGET[s]) * 100));
      return '<div class="pr-section">' +
        '<div class="pr-section-top"><strong>' + s + '</strong><span class="pr-num">' + n + ' / ' + PAPER_TARGET[s] + '</span></div>' +
        '<div class="pr-meter" role="img" aria-label="' + s + ': ' + n + ' of ' + PAPER_TARGET[s] + ' questions"><span style="transform:scaleX(' + (pct / 100) + ')"' + (n === PAPER_TARGET[s] ? ' class="is-full"' : '') + '></span></div>' +
        '<p class="pr-sub">' + fmt(bp.maxMarks[s]) + ' marks · ' + bp.durations[s] + ' min</p>' +
        '</div>';
    }).join("");

    var difficultyCard = ["SUPR", "REAP"].map(function (s) {
      var d = bp.difficulty[s];
      var total = d.easy + d.medium + d.hard;
      var seg = function (key) {
        var share = total ? (d[key] / total) * 100 : 0;
        return share ? '<span class="pr-diff-seg is-' + key + '" style="flex-grow:' + share.toFixed(2) + '" title="' + d[key] + ' ' + key + '"></span>' : "";
      };
      return '<div class="pr-diff-row">' +
        '<div class="pr-section-top"><strong>' + s + '</strong><span class="pr-num">' + d.easy + ' · ' + d.medium + ' · ' + d.hard + '</span></div>' +
        (total ? '<div class="pr-diff" role="img" aria-label="' + s + ': ' + d.easy + ' easy, ' + d.medium + ' medium, ' + d.hard + ' hard">' + seg("easy") + seg("medium") + seg("hard") + '</div>' : '<p class="pr-sub">No questions yet.</p>') +
        '</div>';
    }).join("") +
      '<ul class="pr-legend" aria-hidden="true"><li><i class="is-easy"></i>Easy</li><li><i class="is-medium"></i>Medium</li><li><i class="is-hard"></i>Hard</li></ul>';

    var answerCard = ["SUPR", "REAP"].map(function (s) {
      var counts = bp.answerKey[s];
      var letters = counts[4] || counts[5] ? 6 : 4;
      var max = Math.max.apply(null, counts.slice(0, letters).concat([1]));
      var run = bp.longestRun[s];
      return '<div class="pr-key">' +
        '<div class="pr-section-top"><strong>' + s + '</strong><span class="pr-sub">' + (run.len > 1 ? "longest run: " + run.len + " × " + run.letter : "no repeats") + '</span></div>' +
        '<div class="pr-key-bars" role="img" aria-label="' + escapeAttribute(s + " answers: " + PAPER_LETTERS.slice(0, letters).map(function (l, i) { return l + " " + counts[i]; }).join(", ")) + '">' +
        PAPER_LETTERS.slice(0, letters).map(function (l, i) {
          return '<div class="pr-key-col"><span class="pr-key-n">' + counts[i] + '</span><span class="pr-key-bar"><i style="transform:scaleY(' + (counts[i] / max).toFixed(3) + ')"></i></span><span class="pr-key-l">' + l + '</span></div>';
        }).join("") +
        '</div></div>';
    }).join("");

    // The few issues worth fixing first, right under the score (blocking before warnings).
    var nextItems = review.errors.map(function (i) { return { item: i, kind: "error" }; })
      .concat(review.warnings.slice().sort(function (a, b) { return (b.weight || 0) - (a.weight || 0); }).map(function (i) { return { item: i, kind: "warning" }; }))
      .slice(0, 3);
    var nextFixesHtml = nextItems.length
      ? '<div class="pr-next"><p class="pr-next-title">Fix next</p><ol class="pr-next-list">' + nextItems.map(function (n) {
          var firstId = n.item.questionIds.filter(function (id) { return review.numbers[id]; })[0];
          return '<li class="is-' + n.kind + '"><span class="pr-next-dot" aria-hidden="true"></span><span class="pr-next-text"><span class="sr-only">' + (n.kind === "error" ? "Blocking: " : "Warning: ") + '</span>' + escapeHtml(n.item.title) + '</span>' +
            (firstId ? '<button type="button" class="pr-link js-pr-fix" data-id="' + escapeAttribute(firstId) + '">Open Q' + review.numbers[firstId] + '</button>' : '') + '</li>';
        }).join("") + '</ol></div>'
      : '<div class="pr-next is-clear"><p class="pr-next-title">All ' + review.passed.length + ' checks passed</p><p class="pr-sub">Nothing to fix. Preview it as a student, then publish or schedule.</p></div>';

    var topicsHtml = bp.topics.length
      ? '<div class="pr-topics-wrap"><table class="pr-topics"><thead><tr><th scope="col">Topic</th><th scope="col">SUPR</th><th scope="col">REAP</th></tr></thead><tbody>' +
        bp.topics.map(function (t) {
          return '<tr><th scope="row">' + escapeHtml(t.name) + '</th><td>' + (t.SUPR || "–") + '</td><td>' + (t.REAP || "–") + '</td></tr>';
        }).join("") + '</tbody></table></div>'
      : '<p class="helper-text">Topics appear once questions are attached.</p>';

    return '<div class="paper-review" data-paper-review>' +
      '<div class="pr-top">' +
      '<section class="admin-card pr-health is-' + tone + '" aria-labelledby="pr-health-title">' +
      '<p class="section-label" id="pr-health-title">4. Paper health</p>' +
      '<div class="pr-health-body">' +
      buildDonut([{ label: "health", value: review.score, tone: "score" }, { label: "to go", value: 100 - review.score, tone: "rest" }], {
        className: "pr-ring", thickness: 10, centerValue: review.score, centerLabel: "of 100",
        ariaLabel: "Health score " + review.score + " of 100. " + verdict + ".",
      }) +
      '<div class="pr-verdict">' +
      '<h3>' + escapeHtml(verdict) + '</h3>' +
      '<p class="pr-title">' + escapeHtml(test.title || "Untitled test") + '</p>' +
      '<ul class="pr-counts">' +
      '<li class="is-error"><span aria-hidden="true">✕</span> ' + errorCount + ' blocking</li>' +
      '<li class="is-warning"><span aria-hidden="true">!</span> ' + warnCount + (warnCount === 1 ? ' warning' : ' warnings') + '</li>' +
      '<li class="is-passed"><span aria-hidden="true">✓</span> ' + review.passed.length + ' passed</li>' +
      '</ul></div></div>' +
      nextFixesHtml +
      '</section>' +
      '<section class="admin-card pr-publish" aria-labelledby="pr-publish-title">' +
      '<p class="section-label" id="pr-publish-title">Publish</p>' +
      '<dl class="pr-facts">' +
      '<div><dt>Questions</dt><dd>' + totalQuestions + '</dd></div>' +
      '<div><dt>Max marks</dt><dd>' + fmt(totalMarks) + '</dd></div>' +
      '<div><dt>Time</dt><dd>' + (bp.durations.SUPR + bp.durations.REAP) + ' min</dd></div>' +
      '<div><dt>Access</dt><dd>' + (test.isFree ? "Free" : "Paid") + '</dd></div>' +
      '</dl>' +
      '<p class="pr-state"><span class="meta-chip ' + (test.status === "live" ? "is-live" : test.status === "scheduled" ? "is-scheduled" : "is-draft") + '">' + escapeHtml(statusLabel) + '</span>' +
      (test.status === "live" ? '<span class="pr-sub">Students can start it now.</span>' : '') + '</p>' +
      '<div class="pr-actions">' +
      (test.status === "live" ? '' :
        '<button class="button button-primary" type="button" id="publish-test-btn"' + (errorCount ? ' disabled aria-describedby="pr-publish-why"' : '') + '>Publish now</button>' +
        '<button class="button button-secondary" type="button" data-pr-schedule-toggle aria-expanded="false" aria-controls="pr-schedule"' + (errorCount ? ' disabled aria-describedby="pr-publish-why"' : '') + '>' + (test.status === "scheduled" ? "Change time…" : "Schedule…") + '</button>') +
      '<button class="button button-secondary js-pr-preview" type="button">Preview as student</button>' +
      '</div>' +
      '<form class="pr-schedule" id="pr-schedule" hidden>' +
      '<div class="field"><label for="pr-publish-at">Goes live at (your local time)</label><input id="pr-publish-at" type="datetime-local" required></div>' +
      '<button class="button button-primary button-compact" type="submit">Save schedule</button>' +
      '</form>' +
      (errorCount ? '<p class="pr-why" id="pr-publish-why">Publishing unlocks when the blocking issues are fixed.</p>' : '') +
      '<p class="import-message" role="status" tabindex="-1" data-pr-status></p>' +
      '<div class="pr-downloads"><span>Download</span>' +
      '<button type="button" class="pr-link" data-pr-download="key">Answer key (.csv)</button>' +
      '<button type="button" class="pr-link" data-pr-download="paper">Whole paper (.csv)</button>' +
      '</div>' +
      '</section>' +
      '</div>' +
      '<div class="pr-grid">' +
      '<section class="admin-card pr-card" aria-labelledby="pr-sec-title"><p class="section-label" id="pr-sec-title">Sections</p>' + sectionCard + '</section>' +
      '<section class="admin-card pr-card" aria-labelledby="pr-diff-title"><p class="section-label" id="pr-diff-title">Difficulty mix</p>' + difficultyCard + '</section>' +
      '<section class="admin-card pr-card" aria-labelledby="pr-key-title"><p class="section-label" id="pr-key-title">Answer key</p>' + answerCard + '</section>' +
      '</div>' +
      '<div class="pr-split">' +
      '<section class="admin-card pr-checks" aria-labelledby="pr-checks-title">' +
      '<div class="pr-checks-head"><p class="section-label" id="pr-checks-title">Checks</p><button type="button" class="pr-link" data-pr-rerun>Re-run checks</button></div>' +
      (errorCount ? '<h4 class="pr-group is-error">Blocking (' + errorCount + ')</h4><ul class="pr-list">' + review.errors.map(function (i) { return itemHtml(i, "error"); }).join("") + '</ul>' : '') +
      (warnCount ? '<h4 class="pr-group is-warning">Warnings (' + warnCount + ')</h4><ul class="pr-list">' + review.warnings.map(function (i) { return itemHtml(i, "warning"); }).join("") + '</ul>' : '') +
      (!errorCount && !warnCount ? '<p class="pr-clear">Every check passed. This paper is ready.</p>' : '') +
      '<details class="pr-passed"><summary>Passed (' + review.passed.length + ')</summary><ul class="pr-list">' + review.passed.map(function (i) { return itemHtml({ title: i.title, detail: "", questionIds: [] }, "passed"); }).join("") + '</ul></details>' +
      '</section>' +
      '<section class="admin-card pr-card" aria-labelledby="pr-topics-title"><p class="section-label" id="pr-topics-title">Topic coverage (' + bp.topics.length + ')</p>' + topicsHtml + '</section>' +
      '</div>' +
      '</div>';
  }

  // Image links are checked in the background; failures show up as a warning on the next render.
  function checkPaperImages(review, onFailure) {
    runtime.paperImageStatus = runtime.paperImageStatus || {};
    runtime.paperImageFailures = runtime.paperImageFailures || {};
    (review.order || []).forEach(function (q) {
      (q.imageUrls || []).forEach(function (url) {
        if (!url || runtime.paperImageStatus[url]) return;
        runtime.paperImageStatus[url] = "pending";
        var img = new Image();
        img.onload = function () { runtime.paperImageStatus[url] = "ok"; };
        img.onerror = function () {
          runtime.paperImageStatus[url] = "fail";
          runtime.paperImageFailures[url] = true;
          onFailure();
        };
        img.src = url;
      });
    });
  }

  // The import format (Import from Excel/CSV), so an exported paper can be edited and imported.
  function paperExportCsv(review) {
    var header = ["section", "topic", "difficulty", "question", "option_a", "option_b", "option_c", "option_d", "option_e", "option_f", "answer", "marks", "negative_marks", "explanation", "passage", "image_urls"];
    return [csvRow(header)].concat(review.order.map(function (q) {
      var opts = (q.options || []).slice(0, 6);
      while (opts.length < 6) opts.push("");
      return csvRow([q.section, q.topic, q.difficulty || "medium", q.prompt].concat(opts).concat([
        PAPER_LETTERS[Number(q.correctOption)] || "",
        q.marks !== undefined && q.marks !== null ? q.marks : "",
        q.negativeMarks !== undefined && q.negativeMarks !== null ? q.negativeMarks : "",
        q.explanation || "", q.passage || "", (q.imageUrls || []).join("|"),
      ]));
    })).join("\r\n") + "\r\n";
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

      var paperReview = reviewPaper(selectedTest, questions, tests, (adminSnapshot && adminSnapshot.attempts) || [], runtime.paperImageFailures, runtime.reportCounts);
      var validation = { errors: paperReview.errors, warnings: paperReview.warnings };

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
        '<div class="field" style="grid-column: 1 / -1;"><label for="question-prompt">Question prompt</label><textarea id="question-prompt" name="prompt" rows="3" required>' + escapeHtml(editingQuestion ? editingQuestion.prompt : "") + '</textarea><div class="helper-text">Supports LaTeX: $...$ (inline), $$...$$ (display math).</div></div>' +
        '<div class="field" style="grid-column: 1 / -1;"><label for="question-passage">Passage or context</label><textarea id="question-passage" name="passage" rows="2" placeholder="Optional">' + escapeHtml(editingQuestion ? editingQuestion.passage || "" : "") + '</textarea></div>' +
        // Images: one working copy (add, replace, remove, reorder, size), saved with the question.
        (ensureQuestionImageDraft(editingQuestion), '') +
        '<div class="field qimg-field" id="qimg-root" style="grid-column: 1 / -1;">' + buildQuestionImageManagerHtml() + '</div>' +
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
              (q.passage ? '<div class="student-preview-passage rich-text">' + formatRichText(q.passage) + '</div>' : '') +
              '<div style="margin:10px 0;">' + formatRichText(q.prompt) + '</div>' +
              renderQuestionFigures(q) +
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
        // The form either edits a test (the one picked under "Existing Tests", else the selected
        // one) or, after "+ New test", creates a blank one. It used to show the selected test
        // labelled "Update Selected Test" while actually creating a copy, so a fresh test was
        // impossible to make.
        var formTest = runtime.adminCreatingTest ? null : (editingTest || selectedTest || null);
        var field = function (key, fallback) {
          return formTest && formTest[key] !== undefined && formTest[key] !== null ? formTest[key] : fallback;
        };
        var formDurations = (formTest && formTest.sectionDurations) || { SUPR: 60, REAP: 120 };
        activeTabContent =
          '<div class="admin-grid">' +
          '<div class="admin-card">' +
          '<p class="section-label">1. Test Basic Information & Instructions</p>' +
          '<div class="setup-mode" role="status">' +
          (formTest
            ? '<span>Editing <strong>' + escapeHtml(formTest.title || "this test") + '</strong></span><button type="button" class="button button-secondary button-compact" id="new-test-btn">+ New test</button>'
            : '<span><strong>New test</strong>: fill in the details and create it.</span>' + (tests.length ? '<button type="button" class="button button-secondary button-compact" id="cancel-new-test">Cancel</button>' : '')) +
          '</div>' +
          '<div class="button-row" style="margin-bottom: 14px; gap: 8px;">' +
          '<span class="helper-text" style="align-self: center;">Preset Templates:</span>' +
          '<button type="button" class="button button-secondary button-compact js-apply-template" data-preset="ugee-full">UGEE Full Mock (60m/120m)</button>' +
          '<button type="button" class="button button-secondary button-compact js-apply-template" data-preset="supr-only">SUPR Sectional (60m)</button>' +
          '<button type="button" class="button button-secondary button-compact js-apply-template" data-preset="reap-only">REAP Sectional (120m)</button>' +
          '</div>' +
          '<form id="test-form">' +
          '<div class="grid-two">' +
          '<div class="field"><label for="test-title">Title</label><input id="test-title" name="title" value="' + escapeAttribute(field("title", "")) + '" required></div>' +
          '<div class="field"><label for="test-subtitle">Subtitle</label><input id="test-subtitle" name="subtitle" value="' + escapeAttribute(field("subtitle", "")) + '" required></div>' +
          '<div class="field"><label for="test-series">Series</label><input id="test-series" name="series" value="' + escapeAttribute(field("series", "") || "UGEE 2026") + '" required></div>' +
          '<div class="field"><label for="test-access">Access Control</label><select id="test-access" name="isFree"><option value="true"' + (field("isFree", true) ? ' selected' : '') + '>Free</option><option value="false"' + (!field("isFree", true) ? ' selected' : '') + '>Paid</option></select></div>' +
          (function () {
            var status = runtime.adminCreatingTest || !formTest ? "draft" : (formTest.status || "draft");
            var when = formTest && formTest.publishAt ? new Date(formTest.publishAt) : null;
            var localValue = when && !Number.isNaN(when.getTime())
              ? new Date(when.getTime() - when.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
              : "";
            return '<div class="field"><label for="test-publishing">Publishing</label><select id="test-publishing" name="publishing">' +
              [["draft", "Draft (hidden from students)"], ["live", "Live now"], ["scheduled", "Scheduled: goes live at…"]].map(function (opt) {
                return '<option value="' + opt[0] + '"' + (status === opt[0] ? ' selected' : '') + '>' + opt[1] + '</option>';
              }).join("") + '</select></div>' +
              '<div class="field test-publish-at"' + (status === "scheduled" ? '' : ' hidden') + '><label for="test-publish-at">Goes live at (your local time)</label>' +
              '<input id="test-publish-at" name="publishAt" type="datetime-local" value="' + escapeAttribute(localValue) + '" aria-describedby="test-publish-help">' +
              '<p class="helper-text" id="test-publish-help">Students see it with a countdown and can start it from this time.</p></div>' +
              (function () {
                // Live event: everyone joins within a window; results come out together.
                var ev = (formTest && formTest.event && formTest.event.enabled) ? formTest.event : null;
                var toLocal = function (iso) {
                  var d = iso ? new Date(iso) : null;
                  return d && !Number.isNaN(d.getTime()) ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "";
                };
                var showBox = status === "scheduled" || status === "live" || Boolean(ev);
                return '<fieldset class="field test-event"' + (showBox ? '' : ' hidden') + '>' +
                  '<legend>Live event</legend>' +
                  '<label class="test-event-toggle"><input type="checkbox" id="test-event-enabled" name="eventEnabled"' + (ev ? ' checked' : '') + '> Everyone takes it together</label>' +
                  '<div class="test-event-fields"' + (ev ? '' : ' hidden') + '>' +
                  '<div class="field"><label for="test-event-join">Students can join for (minutes after it opens)</label><input id="test-event-join" name="eventJoinMinutes" type="number" inputmode="numeric" min="5" max="180" value="' + escapeAttribute(String(ev ? ev.joinMinutes : 15)) + '"></div>' +
                  '<div class="field"><label for="test-event-results">Results and ranks come out at (your local time)</label><input id="test-event-results" name="eventResultsAt" type="datetime-local" value="' + escapeAttribute(toLocal(ev && ev.resultsAt)) + '" aria-describedby="test-event-help"></div>' +
                  '<p class="helper-text" id="test-event-help">Each student still gets the full time from their own start. Results must come out after the join window plus the paper\'s length.</p>' +
                  '</div></fieldset>';
              })();
          })() +
          '<div class="field"><label for="supr-duration">SUPR Duration (mins)</label><input id="supr-duration" name="suprDurationMinutes" type="number" inputmode="numeric" value="' + (formDurations.SUPR !== undefined ? formDurations.SUPR : 60) + '" required></div>' +
          '<div class="field"><label for="reap-duration">REAP Duration (mins)</label><input id="reap-duration" name="reapDurationMinutes" type="number" inputmode="numeric" value="' + (formDurations.REAP !== undefined ? formDurations.REAP : 120) + '" required></div>' +
          (function () {
            var policySource = formTest || {};
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
          '<div class="field"><label for="test-benchmark">Benchmark Scores</label><input id="test-benchmark" name="benchmarkScores" placeholder="18,22,26,31" value="' + escapeAttribute(Array.isArray(field("benchmarkScores", null)) ? field("benchmarkScores", []).join(",") : "") + '"></div>' +
          '</div>' +
          '<div class="field" style="margin-top: 16px;"><label for="test-instructions">Instructions (one line each)</label><textarea id="test-instructions" name="instructions" rows="4">' + escapeHtml(Array.isArray(field("instructions", null)) && field("instructions", []).length ? field("instructions", []).join("\n") : 'Read all instructions carefully.\nSUPR locks after its timer or after every SUPR question is answered.\nREAP opens automatically and the test submits when the REAP timer ends.') + '</textarea></div>' +
          '<div class="button-row" style="margin-top: 18px;">' +
          '<button class="button button-primary" type="submit">' + (formTest ? 'Save changes' : 'Create test') + '</button>' +
          (editingTest ? '<button class="button button-secondary" type="button" id="cancel-test-edit">Cancel Edit</button>' : '') +
          '</div>' +
          '</form>' +
          '</div>' +
          '<aside class="admin-card admin-sticky-side">' +
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
          '<button class="button button-secondary button-compact js-open-question-import" type="button">⇪ Import from Excel/CSV</button>' +
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
          '<div class="admin-card admin-fill-side">' +
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
          '<div class="button-row">' +
          '<button class="button button-secondary button-compact js-open-question-import" type="button">⇪ Import from Excel/CSV</button>' +
          '<button class="button button-secondary button-compact" type="button" id="open-bank-modal">Full Screen Modal</button>' +
          '</div>' +
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
        activeTabContent = buildPaperReviewHtml(selectedTest, paperReview);
      } else if (activeTab === "tests") {
        activeTabContent =
          '<div class="admin-card">' +
          '<div class="button-row" style="justify-content: space-between; align-items: center; margin-bottom: 12px;">' +
          '<p class="section-label" style="margin:0;">Existing Tests Management</p>' +
          '<button class="button button-secondary button-compact js-studio-tab" data-tab="setup">+ Create New Test</button>' +
          '</div>' +
          (tests.length ? (
            '<p class="helper-text tests-order-help">Students see live tests in this order. Drag a row by its handle, or use the arrows. Drafts keep their place but students don\'t see them.</p>' +
            '<p class="tests-order-status" role="status" data-tests-order-status></p>' +
            '<div class="table-like tests-table table-scroll-card" data-tests-order>' +
            '<div class="table-row header"><span>Order</span><span>Test Title</span><span>Status</span><span>Questions</span><span>Durations</span><span>Actions</span></div>' +
            tests.map(function (test, index) {
              return '<div class="table-row" data-test-row="' + escapeAttribute(test.id) + '">' +
                '<span class="tests-order-cell">' +
                '<span class="tests-order-handle" draggable="true" data-drag-test="' + escapeAttribute(test.id) + '" title="Drag to reorder" aria-hidden="true">⠿</span>' +
                '<span class="tests-order-pos">' + (index + 1) + '</span>' +
                '<button type="button" class="tests-order-btn js-move-test-up" data-id="' + escapeAttribute(test.id) + '" aria-label="' + escapeAttribute("Move " + test.title + " up") + '"' + (index === 0 ? ' disabled' : '') + '>↑</button>' +
                '<button type="button" class="tests-order-btn js-move-test-down" data-id="' + escapeAttribute(test.id) + '" aria-label="' + escapeAttribute("Move " + test.title + " down") + '"' + (index === tests.length - 1 ? ' disabled' : '') + '>↓</button>' +
                '</span>' +
                '<span class="' + (test.status === "live" ? 'test-title-live' : '') + '"><strong>' + escapeHtml(test.title) + '</strong><br><small>' + escapeHtml(test.series || "UGEE") + '</small></span>' +
                '<span><span class="meta-chip ' + (test.status === "live" ? 'is-live' : (test.status === "scheduled" ? 'is-scheduled' : 'is-draft')) + '">' + escapeHtml(test.status === "scheduled" && testOpensAt(test) ? "scheduled · " + formatOpensAt(testOpensAt(test)) : (test.status || "draft")) + '</span></span>' +
                '<span>' + (Array.isArray(test.questionIds) ? test.questionIds.length : 0) + ' / 90</span>' +
                '<span>' + (test.sectionDurations ? test.sectionDurations.SUPR : 60) + 'm / ' + (test.sectionDurations ? test.sectionDurations.REAP : 120) + 'm</span>' +
                '<span><div class="button-row">' +
                '<button class="button button-secondary button-compact js-pick-test" data-id="' + escapeHtml(test.id) + '">' + (test.id === selectedTestId ? 'Active' : 'Select') + '</button>' +
                '<button class="button button-secondary button-compact js-duplicate-test" data-id="' + escapeHtml(test.id) + '">Duplicate</button>' +
                '<button class="button button-secondary button-compact js-toggle-live" data-id="' + escapeHtml(test.id) + '">' + (test.status === "live" ? 'Draft' : (test.status === "scheduled" ? 'Publish now' : 'Publish')) + '</button>' +
                '<button class="button button-secondary button-compact js-export-pdf" data-id="' + escapeHtml(test.id) + '">PDF</button>' +
                '<button class="button button-danger button-compact js-delete-test" data-id="' + escapeHtml(test.id) + '">Del</button>' +
                '</div></span>' +
                '</div>';
            }).join("") +
            '</div>'
          ) : '<div class="empty-state">No tests created yet.</div>') +
          '</div>';
      } else if (activeTab === "payments") {
        // Every registered user, from the server, 50 a page (the snapshot only carries 500).
        var filterTab = runtime.adminUserFilterTab || "paid";
        var usersState = runtime.adminUsersList || {};
        var listUsers = usersState.users || [];
        var userCounts = usersState.counts || null;
        var userPages = usersState.pagination || { page: 1, pages: 1, total: 0, limit: 50 };
        var countText = function (value) { return userCounts ? Number(value || 0).toLocaleString("en-IN") : "…"; };
        var firstShown = userPages.total ? (userPages.page - 1) * userPages.limit + 1 : 0;
        var lastShown = Math.min(userPages.total, userPages.page * userPages.limit);

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
          '<div class="metric-card" style="border-left: 4px solid var(--green);"><span class="metric-value" style="color:var(--green);">' + countText(userCounts && userCounts.paid) + '</span><span class="metric-label">Total Paid Verified Users</span></div>' +
          '<div class="metric-card"><span class="metric-value">' + countText(userCounts && userCounts.all) + '</span><span class="metric-label">Total Registered Users</span></div>' +
          '</div>' +

          '<div class="button-row" style="gap: 8px; margin-bottom: 14px; flex-wrap: wrap;">' +
          '<button class="button button-compact ' + (filterTab === "paid" ? "button-primary" : "button-secondary") + ' js-admin-user-filter" data-filter="paid" aria-pressed="' + (filterTab === "paid") + '">🎓 Paid / Enrolled (' + countText(userCounts && userCounts.paid) + ')</button>' +
          '<button class="button button-compact ' + (filterTab === "all" ? "button-primary" : "button-secondary") + ' js-admin-user-filter" data-filter="all" aria-pressed="' + (filterTab === "all") + '">👥 All Registered Users (' + countText(userCounts && userCounts.all) + ')</button>' +
          '</div>' +

          '<div class="field" style="margin-bottom: 16px;">' +
          '<input type="search" id="admin-user-search" value="' + escapeAttribute(runtime.adminUserSearchQuery || "") + '" placeholder="🔍 Search users by name or email address..." aria-label="Search users by name or email">' +
          '</div>' +

          (usersState.error
            ? '<div class="empty-state" role="alert">Couldn&rsquo;t load users: ' + escapeHtml(usersState.error) + ' <button type="button" class="button button-secondary button-compact js-admin-users-reload">Try again</button></div>'
            : '') +
          (!usersState.users && !usersState.error ? '<div class="empty-state" role="status">Loading users…</div>' : '') +
          (listUsers.length ? (
            '<div class="table-like users-table table-scroll-card">' +
            '<div class="table-row header"><span>User</span><span>Email</span><span>Role</span><span>Payment Access</span><span>Actions</span></div>' +
            listUsers.map(function (u) {
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
            '</div>' +
            '<div class="admin-users-pager">' +
            '<span class="admin-users-range" role="status">' + (usersState.loading ? 'Loading…' : 'Showing ' + firstShown.toLocaleString("en-IN") + '–' + lastShown.toLocaleString("en-IN") + ' of ' + Number(userPages.total).toLocaleString("en-IN")) + '</span>' +
            '<div class="button-row" style="gap:6px;">' +
            '<button type="button" class="button button-secondary button-compact js-admin-users-page" data-page="' + (userPages.page - 1) + '"' + (userPages.page <= 1 || usersState.loading ? ' disabled' : '') + '>← Previous</button>' +
            '<span class="admin-users-pageno">Page ' + userPages.page + ' of ' + userPages.pages + '</span>' +
            '<button type="button" class="button button-secondary button-compact js-admin-users-page" data-page="' + (userPages.page + 1) + '"' + (userPages.page >= userPages.pages || usersState.loading ? ' disabled' : '') + '>Next →</button>' +
            '</div>' +
            '</div>'
          ) : (usersState.users ? '<div class="empty-state">' + (runtime.adminUserSearchQuery ? 'No users match this search.' : (filterTab === "paid" ? 'No paid users yet. Switch to "All Registered Users" or add a payment above.' : 'No registered users yet.')) + '</div>' : '')) +
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
          ) : '<div class="empty-state">' + (runtime.adminSeasonsError
            ? 'Could not load seasons: ' + escapeHtml(runtime.adminSeasonsError)
            : Array.isArray(runtime.adminSeasonsList) ? 'No seasons configured yet. Click "+ Create New Season" to set up UGEE 2026.' : 'Loading seasons…') + '</div>') +
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
          ) : '<div class="empty-state">' + (runtime.adminAuditLogsError
            ? 'Could not load audit logs: ' + escapeHtml(runtime.adminAuditLogsError)
            : Array.isArray(runtime.adminAuditLogsList) ? 'No audit logs recorded yet.' : 'Loading audit logs…') + '</div>') +
          '</div>';
      } else if (activeTab === "materials") {
        activeTabContent = buildAdminMaterialsHtml();
      } else if (activeTab === "mentor") {
        activeTabContent = buildAdminMentorHtml();
      } else if (activeTab === "whatsnew") {
        activeTabContent = buildAdminWhatsNewHtml();
      } else if (activeTab === "reports") {
        activeTabContent = buildAdminReportsHtml();
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
        '<button type="button" class="studio-step-btn js-studio-tab ' + (activeTab === "review" ? 'is-active' : '') + '" data-tab="review"><span class="studio-step-num">4</span> Review & Validate (' + (validation.errors.length ? validation.errors.length + (validation.errors.length === 1 ? ' error' : ' errors') : 'health ' + paperReview.score) + ')</button>' +
        '<button type="button" class="studio-step-btn js-studio-tab ' + (activeTab === "tests" ? 'is-active' : '') + '" data-tab="tests"><span class="studio-step-num">5</span> Existing Tests (' + tests.length + ')</button>' +
        '<button type="button" class="studio-step-btn js-studio-tab ' + (activeTab === "payments" ? 'is-active' : '') + '" data-tab="payments"><span class="studio-step-num">6</span> User Payments</button>' +
        '<button type="button" class="studio-step-btn js-studio-tab ' + (activeTab === "seasons" ? 'is-active' : '') + '" data-tab="seasons"><span class="studio-step-num">7</span> Seasons</button>' +
        '<button type="button" class="studio-step-btn js-studio-tab ' + (activeTab === "audit" ? 'is-active' : '') + '" data-tab="audit"><span class="studio-step-num">8</span> Audit Logs</button>' +
        '<button type="button" class="studio-step-btn js-studio-tab ' + (activeTab === "materials" ? 'is-active' : '') + '" data-tab="materials"><span class="studio-step-num">9</span> Study Materials</button>' +
        '<button type="button" class="studio-step-btn js-studio-tab ' + (activeTab === "mentor" ? 'is-active' : '') + '" data-tab="mentor"><span class="studio-step-num">10</span> ACEIIIT Mentor</button>' +
        '<button type="button" class="studio-step-btn js-studio-tab ' + (activeTab === "whatsnew" ? 'is-active' : '') + '" data-tab="whatsnew"><span class="studio-step-num">11</span> What\'s New</button>' +
        '<button type="button" class="studio-step-btn js-studio-tab ' + (activeTab === "reports" ? 'is-active' : '') + '" data-tab="reports"><span class="studio-step-num">12</span> Reports' + (runtime.reportOpenTotal ? ' <span class="studio-step-badge" aria-label="' + runtime.reportOpenTotal + ' open">' + runtime.reportOpenTotal + '</span>' : '') + '</button>' +
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
      var testDraftContext = runtime.adminCreatingTest || (!runtime.adminEditingTestId && !selectedTestId)
        ? "create"
        : ("edit:" + (runtime.adminEditingTestId || selectedTestId));
      var questionDraftContext = (runtime.adminEditingQuestionId ? ("edit:" + runtime.adminEditingQuestionId) : "create") + "|test:" + (selectedTestId || "");

      if (runtime.questionUploadContext && runtime.questionUploadContext !== questionDraftContext) {
        resetPendingQuestionUploads({ keepImages: true });
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
            var label = test.status === "live" || test.status === "scheduled" ? test.status : "draft";
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
          var publishing = String(form.get("publishing") || "draft");
          payload.status = publishing;
          if (publishing === "scheduled") {
            var localWhen = String(form.get("publishAt") || "");
            var whenDate = localWhen ? new Date(localWhen) : null;
            if (!whenDate || Number.isNaN(whenDate.getTime())) {
              window.alert("Pick the date and time the test should go live.");
              return;
            }
            payload.publishAt = whenDate.toISOString();
          }
          var eventOn = form.get("eventEnabled") === "on";
          var hadEvent = Boolean(formTest && formTest.event && formTest.event.enabled);
          if (eventOn) {
            var resultsLocal = String(form.get("eventResultsAt") || "");
            var resultsDate = resultsLocal ? new Date(resultsLocal) : null;
            if (!resultsDate || Number.isNaN(resultsDate.getTime())) {
              window.alert("Pick when the live event's results come out.");
              return;
            }
            payload.event = { enabled: true, joinMinutes: Math.max(5, Math.min(180, Number(form.get("eventJoinMinutes") || 15))), resultsAt: resultsDate.toISOString() };
          } else if (hadEvent) {
            payload.event = { enabled: false };
          }
          var editTargetId = runtime.adminCreatingTest ? null : (runtime.adminEditingTestId || selectedTestId || null);
          if (!editTargetId) {
            payload.displayOrder = Math.min(9999, nextDefaultDisplayOrder);
          }
          showOverlayLoader(editTargetId ? "Saving test." : "Creating test.");
          try {
            var savedTest = editTargetId
              ? await store.updateTest(editTargetId, payload)
              : await store.createTest(payload);
            runtime.adminEditingTestId = null;
            runtime.adminCreatingTest = false;
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

      if (runtime.focusNewTestTitle && runtime.adminCreatingTest) {
        runtime.focusNewTestTitle = false;
        var newTitle = document.getElementById("test-title");
        if (newTitle) newTitle.focus({ preventScroll: true });
      }
      var publishingSelect = document.getElementById("test-publishing");
      if (publishingSelect) {
        publishingSelect.addEventListener("change", function () {
          var box = document.querySelector(".test-publish-at");
          if (box) box.hidden = publishingSelect.value !== "scheduled";
          if (publishingSelect.value === "scheduled") {
            var input = document.getElementById("test-publish-at");
            if (input) input.focus();
          }
          var eventBox = document.querySelector(".test-event");
          if (eventBox) eventBox.hidden = publishingSelect.value !== "scheduled" && publishingSelect.value !== "live" && !(document.getElementById("test-event-enabled") || {}).checked;
        });
      }
      var eventToggle = document.getElementById("test-event-enabled");
      if (eventToggle) {
        eventToggle.addEventListener("change", function () {
          var fields = document.querySelector(".test-event-fields");
          if (fields) fields.hidden = !eventToggle.checked;
          if (eventToggle.checked) {
            var results = document.getElementById("test-event-results");
            if (results) results.focus();
          }
        });
      }

      var newTestBtn = document.getElementById("new-test-btn");
      if (newTestBtn) {
        newTestBtn.addEventListener("click", function () {
          runtime.adminCreatingTest = true;
          runtime.adminEditingTestId = null;
          runtime.focusNewTestTitle = true;
          clearLocalDraft(ADMIN_TEST_DRAFT_KEY);
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      }
      var cancelNewTest = document.getElementById("cancel-new-test");
      if (cancelNewTest) {
        cancelNewTest.addEventListener("click", function () {
          runtime.adminCreatingTest = false;
          clearLocalDraft(ADMIN_TEST_DRAFT_KEY);
          rerenderAdminPreserveScroll(user, selectedTestId);
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
            var overlay = showAdminModal("Question preview", body, true);
            if (overlay) {
              var root = overlay.querySelector(".latex-preview-modal");
              renderLatexInElement(root);
              root.querySelectorAll("[data-open-image]").forEach(function (button) {
                button.addEventListener("click", function () { openImageLightbox(button.getAttribute("data-open-image")); });
              });
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

        mountQuestionImageManager();

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

          // Images were uploaded when they were added; the working copy is saved as it stands.
          var imageDraft = runtime.questionImageDraft;
          if (imageDraft && imageDraft.items.some(function (item) { return item.busy; })) {
            window.alert("An image is still uploading. Save again once it has finished.");
            if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = originalSaveText; }
            if (saveNextBtn) { saveNextBtn.disabled = false; saveNextBtn.textContent = originalNextText; }
            return;
          }
          var savedImages = imageDraft ? imageDraft.items.filter(function (item) { return item.url; }) : [];

          try {
            var form = new FormData(questionForm);
            var activeTestId = String(form.get("testId") || "");
            var selectedFiles = [];
            runtime.adminSelectedTestId = activeTestId;
            var payload = {
              testId: activeTestId,
              section: form.get("section"),
              topic: form.get("topic"),
              difficulty: form.get("difficulty"),
              prompt: form.get("prompt"),
              passage: form.get("passage"),
              imageUrls: savedImages.map(function (item) { return item.url; }),
              imageWidths: savedImages.map(function (item) { return Number(item.width) || 0; }),
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

      // Studio → Existing Tests: the order students see. Up/down buttons (keyboard) and drag by
      // the handle; the whole order is saved in one request.
      async function saveTestOrder(orderedIds, movedId, focusSelector) {
        var status = app.querySelector("[data-tests-order-status]");
        if (status) status.textContent = "";
        showOverlayLoader("Updating dashboard order.", { delayMs: 320 });
        try {
          await store.reorderTests(orderedIds);
          var moved = tests.filter(function (test) { return test.id === movedId; })[0];
          rerenderAdminPreserveScroll(user, runtime.adminSelectedTestId || selectedTestId);
          var position = orderedIds.indexOf(movedId) + 1;
          var liveStatus = document.querySelector("[data-tests-order-status]");
          if (liveStatus && moved) liveStatus.textContent = "Moved " + moved.title + " to position " + position + " of " + orderedIds.length + ".";
          var again = focusSelector ? document.querySelector(focusSelector) : null;
          if (again && !again.disabled) again.focus();
          else if (again) {
            var row = again.closest("[data-test-row]");
            var other = row && row.querySelector(".tests-order-btn:not([disabled])");
            if (other) other.focus();
          }
        } catch (error) {
          rerenderAdminPreserveScroll(user, runtime.adminSelectedTestId || selectedTestId);
          var errStatus = document.querySelector("[data-tests-order-status]");
          if (errStatus) {
            errStatus.textContent = "Couldn't save the new order: " + ((error && error.message) || "try again") + ".";
            errStatus.classList.add("is-error");
          }
        } finally {
          hideOverlayLoader();
        }
      }

      async function moveTestOrder(testId, direction) {
        var orderedIds = tests.map(function (test) { return test.id; });
        var currentIndex = orderedIds.indexOf(String(testId || ""));
        if (currentIndex === -1) return;
        var targetIndex = direction === "up" ? currentIndex - 1 : currentIndex + 1;
        if (targetIndex < 0 || targetIndex >= orderedIds.length) return;
        var swapped = orderedIds.slice();
        swapped[currentIndex] = swapped[targetIndex];
        swapped[targetIndex] = String(testId);
        await saveTestOrder(swapped, String(testId), '.js-move-test-' + direction + '[data-id="' + String(testId).replace(/"/g, "") + '"]');
      }

      // Drag a row by its handle and drop it on another row: it takes that row's place.
      var orderTable = app.querySelector("[data-tests-order]");
      if (orderTable) {
        var draggingId = "";
        var clearDropMarks = function () {
          orderTable.querySelectorAll(".is-drop-before, .is-drop-after, .is-dragging").forEach(function (el) {
            el.classList.remove("is-drop-before", "is-drop-after", "is-dragging");
          });
        };
        orderTable.addEventListener("dragstart", function (event) {
          var handle = event.target.closest && event.target.closest("[data-drag-test]");
          if (!handle) return;
          draggingId = handle.getAttribute("data-drag-test");
          var row = handle.closest("[data-test-row]");
          if (row) row.classList.add("is-dragging");
          try {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", draggingId);
            if (row) event.dataTransfer.setDragImage(row, 20, 20);
          } catch (_e) { }
        });
        orderTable.addEventListener("dragover", function (event) {
          if (!draggingId) return;
          var row = event.target.closest && event.target.closest("[data-test-row]");
          if (!row) return;
          event.preventDefault();
          var rect = row.getBoundingClientRect();
          var after = event.clientY > rect.top + rect.height / 2;
          orderTable.querySelectorAll(".is-drop-before, .is-drop-after").forEach(function (el) { el.classList.remove("is-drop-before", "is-drop-after"); });
          if (row.getAttribute("data-test-row") !== draggingId) row.classList.add(after ? "is-drop-after" : "is-drop-before");
        });
        orderTable.addEventListener("dragend", function () {
          draggingId = "";
          clearDropMarks();
        });
        orderTable.addEventListener("drop", function (event) {
          if (!draggingId) return;
          event.preventDefault();
          var row = event.target.closest && event.target.closest("[data-test-row]");
          var targetId = row ? row.getAttribute("data-test-row") : "";
          var after = row ? row.classList.contains("is-drop-after") : false;
          var movedId = draggingId;
          draggingId = "";
          clearDropMarks();
          if (!targetId || targetId === movedId) return;
          var orderedIds = tests.map(function (test) { return test.id; }).filter(function (id) { return id !== movedId; });
          var at = orderedIds.indexOf(targetId) + (after ? 1 : 0);
          orderedIds.splice(at, 0, movedId);
          saveTestOrder(orderedIds, movedId, '.js-move-test-up[data-id="' + movedId.replace(/"/g, "") + '"]');
        });
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
          runtime.adminCreatingTest = false;
          rerenderAdminPreserveScroll(user, button.dataset.id);
        });
      });

      // Review & Validate (Paper Health Check)
      var prStatus = app.querySelector("[data-pr-status]");
      var prSay = function (text, isError) {
        if (!prStatus) return;
        prStatus.textContent = text;
        prStatus.classList.toggle("is-error", Boolean(isError));
        prStatus.classList.toggle("is-success", !isError);
        prStatus.focus();
      };
      if (activeTab === "review" && selectedTest) {
        checkPaperImages(paperReview, function () {
          window.clearTimeout(runtime.paperImageRerender);
          runtime.paperImageRerender = window.setTimeout(function () {
            if (runtime.adminStudioTab === "review" && location.hash.indexOf("admin") !== -1) rerenderAdminPreserveScroll(user, selectedTestId);
          }, 400);
        });
      }
      app.querySelectorAll(".js-pr-fix").forEach(function (button) {
        button.addEventListener("click", function () {
          runtime.adminStudioTab = "questions";
          runtime.adminEditingQuestionId = button.dataset.id;
          runtime.adminQuestionEditorOpen = false;
          rerenderAdminPreserveScroll(user, selectedTestId);
          window.requestAnimationFrame(function () {
            var form = document.getElementById("question-form");
            if (form) {
              form.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
              var first = form.querySelector("textarea, input");
              if (first) first.focus({ preventScroll: true });
            }
          });
        });
      });
      app.querySelectorAll(".js-pr-preview").forEach(function (button) {
        button.addEventListener("click", function () {
          runtime.adminStudentPreviewOpen = true;
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      });
      app.querySelectorAll("[data-pr-rerun]").forEach(function (button) {
        button.addEventListener("click", function () {
          runtime.paperImageStatus = {};
          runtime.paperImageFailures = {};
          rerenderAdminPreserveScroll(user, selectedTestId);
          var again = document.querySelector("[data-pr-status]");
          if (again) again.textContent = "Checks re-run.";
        });
      });
      app.querySelectorAll("[data-pr-download]").forEach(function (button) {
        button.addEventListener("click", function () {
          if (!selectedTest) return;
          var kind = button.getAttribute("data-pr-download");
          if (kind === "key") downloadTextFile(paperFileName(selectedTest, "answer-key"), answerKeyCsv(paperReview));
          else downloadTextFile(paperFileName(selectedTest, "paper"), paperExportCsv(paperReview));
        });
      });
      var prScheduleToggle = app.querySelector("[data-pr-schedule-toggle]");
      var prScheduleForm = app.querySelector("#pr-schedule");
      if (prScheduleToggle && prScheduleForm) {
        prScheduleToggle.addEventListener("click", function () {
          var open = prScheduleForm.hidden;
          prScheduleForm.hidden = !open;
          prScheduleToggle.setAttribute("aria-expanded", String(open));
          if (open) {
            var input = prScheduleForm.querySelector("#pr-publish-at");
            var when = testOpensAt(selectedTest) || new Date(Date.now() + 24 * 60 * 60 * 1000);
            var pad = function (n) { return String(n).padStart(2, "0"); };
            if (input && !input.value) input.value = when.getFullYear() + "-" + pad(when.getMonth() + 1) + "-" + pad(when.getDate()) + "T" + pad(when.getHours()) + ":" + pad(when.getMinutes());
            if (input) input.focus();
          }
        });
        prScheduleForm.addEventListener("submit", async function (event) {
          event.preventDefault();
          var input = prScheduleForm.querySelector("#pr-publish-at");
          var when = input && input.value ? new Date(input.value) : null;
          if (!when || Number.isNaN(when.getTime()) || when.getTime() < Date.now() + 60 * 1000) {
            prSay("Pick a time at least a minute from now.", true);
            if (input) input.focus();
            return;
          }
          var submit = prScheduleForm.querySelector("button[type=submit]");
          if (submit) submit.disabled = true;
          try {
            await store.updateTest(selectedTestId, { status: "scheduled", publishAt: when.toISOString() });
            rerenderAdminPreserveScroll(user, selectedTestId);
            var after = document.querySelector("[data-pr-status]");
            if (after) {
              after.textContent = "Scheduled: opens " + formatOpensAt(when) + ".";
              after.classList.add("is-success");
              after.focus();
            }
          } catch (error) {
            prSay((error && error.message) || "Could not schedule the test.", true);
            if (submit) submit.disabled = false;
          }
        });
      }

      app.querySelectorAll("#publish-test-btn").forEach(function (button) {
        button.addEventListener("click", async function () {
          if (!selectedTestId || selectedTest.status === "live") return;
          if (paperReview.errors.length) {
            prSay("Fix the blocking issues first.", true);
            return;
          }
          if (!window.confirm("Publish “" + selectedTest.title + "” now? Students can start it straight away.")) return;
          button.disabled = true;
          button.textContent = "Publishing…";
          try {
            await store.updateTest(selectedTestId, { status: "live" });
            rerenderAdminPreserveScroll(user, selectedTestId);
            var after = document.querySelector("[data-pr-status]");
            if (after) {
              after.textContent = "“" + selectedTest.title + "” is live. Students can start it now.";
              after.classList.add("is-success");
              after.focus();
            }
          } catch (error) {
            button.disabled = false;
            button.textContent = "Publish now";
            prSay((error && error.message) || "Failed to publish the test.", true);
          }
        });
      });

      app.querySelectorAll(".js-toggle-live").forEach(function (button) {
        button.addEventListener("click", async function () {
          var test = store.getTestById(button.dataset.id);
          if (!test) return;
          var publishing = test.status !== "live";
          // Publishing runs the same health check as Review & Validate; blocking issues open it.
          if (publishing) {
            var check = reviewPaper(test, questions, tests, (adminSnapshot && adminSnapshot.attempts) || [], runtime.paperImageFailures, runtime.reportCounts);
            if (check.errors.length) {
              runtime.adminSelectedTestId = test.id;
              runtime.adminStudioTab = "review";
              rerenderAdminPreserveScroll(user, test.id);
              var notice = document.querySelector("[data-pr-status]");
              if (notice) {
                notice.textContent = "“" + test.title + "” can't go live yet: " + check.errors.length + (check.errors.length === 1 ? " blocking issue" : " blocking issues") + " below.";
                notice.classList.add("is-error");
                notice.focus();
              }
              return;
            }
          }
          showOverlayLoader("Updating test.", { delayMs: 320 });
          try {
            await store.updateTest(button.dataset.id, {
              status: publishing ? "live" : "draft"
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
            // Reopening a tab retries a failed first load of its list.
            runtime.adminSeasonsError = "";
            runtime.adminAuditLogsError = "";
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
      // Student preview: question images open in the lightbox, as in the exam.
      document.querySelectorAll("#student-preview-overlay [data-open-image]").forEach(function (button) {
        button.addEventListener("click", function () { openImageLightbox(button.getAttribute("data-open-image")); });
      });
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
      Array.prototype.forEach.call(document.querySelectorAll(".js-open-question-import"), function (button) {
        button.addEventListener("click", function () {
          // The dialog stays open with the result while the Studio behind it shows the new questions.
          openQuestionImportDialog(activeTab === "questions" ? selectedTest : null, function () {
            rerenderAdminPreserveScroll(user, selectedTestId);
          });
        });
      });
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
      // User Payments: the list comes from the server (all users, paginated, searched there).
      if (runtime.adminStudioTab === "payments") {
        loadAdminUsers(function () {
          if (runtime.adminStudioTab === "payments") rerenderAdminPreserveScroll(user, selectedTestId);
        });
      }
      app.querySelectorAll(".js-admin-user-filter").forEach(function (btn) {
        btn.addEventListener("click", function () {
          runtime.adminUserFilterTab = btn.dataset.filter || "paid";
          runtime.adminUsersPage = 1;
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      });
      app.querySelectorAll(".js-admin-users-page").forEach(function (btn) {
        btn.addEventListener("click", function () {
          runtime.adminUsersPage = Math.max(1, Number(btn.dataset.page) || 1);
          rerenderAdminPreserveScroll(user, selectedTestId);
        });
      });
      app.querySelectorAll(".js-admin-users-reload").forEach(function (btn) {
        btn.addEventListener("click", function () {
          runtime.adminUsersList = null;
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
            var loaded = await Promise.all([
              store.getUserDetailsExtended(uId),
              // The site lookup is an extra: if it fails, the rest of the window still opens.
              Promise.resolve(store.getUserSiteOrders ? store.getUserSiteOrders(uId) : null).catch(function (siteError) {
                return { error: siteError && siteError.message ? siteError.message : "network error" };
              })
            ]);
            var details = loaded[0];
            hideOverlayLoader();
            showAdminModal(details.user.name || details.user.email || "Student", buildAdminUserDetailsHtml(details, loaded[1]), true);
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
            runtime.adminUsersList = null;
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
            runtime.adminUsersList = null;
            rerenderAdminPreserveScroll(user, selectedTestId);
          } catch (err) {
            window.alert("Failed to revoke access: " + (err.message || String(err)));
          } finally {
            hideOverlayLoader();
          }
        });
      });

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

      // Seasons and audit logs load the first time their tab opens; before, they stayed empty
      // until an action on the tab (or Refresh) happened to fetch them.
      [
        { tab: "seasons", listKey: "adminSeasonsList", errorKey: "adminSeasonsError", load: function () { return store.listSeasons(); }, pick: function (res) { return res.seasons; } },
        { tab: "audit", listKey: "adminAuditLogsList", errorKey: "adminAuditLogsError", load: function () { return store.getAuditLogs(); }, pick: function (res) { return res.logs; } }
      ].forEach(function (source) {
        if (runtime.adminStudioTab !== source.tab || Array.isArray(runtime[source.listKey]) || runtime[source.errorKey] || runtime[source.listKey + "Loading"]) return;
        runtime[source.listKey + "Loading"] = true;
        source.load()
          .then(function (res) { runtime[source.listKey] = (res && source.pick(res)) || []; })
          .catch(function (err) { runtime[source.errorKey] = (err && err.message) || String(err); })
          .finally(function () {
            runtime[source.listKey + "Loading"] = false;
            if (runtime.adminStudioTab === source.tab && (routeParts()[0] || "") === "admin") rerenderAdminPreserveScroll(user, selectedTestId);
          });
      });

      var refreshAuditBtn = document.getElementById("refresh-audit-logs");
      if (refreshAuditBtn) {
        refreshAuditBtn.addEventListener("click", async function () {
          showOverlayLoader("Loading audit logs...", { delayMs: 200 });
          try {
            var aRes = await store.getAuditLogs();
            runtime.adminAuditLogsList = aRes.logs || [];
            runtime.adminAuditLogsError = "";
            rerenderAdminPreserveScroll(user, selectedTestId);
          } catch (err) {
            window.alert("Failed to load audit logs: " + (err.message || String(err)));
          } finally {
            hideOverlayLoader();
          }
        });
      }

      bindAdminMaterials(user, selectedTestId);
      if (runtime.adminStudioTab === "mentor") mountAdminMentor();
      if (runtime.adminStudioTab === "whatsnew") mountAdminWhatsNew();
      if (runtime.adminStudioTab === "reports") {
        mountAdminReports(function (questionId, testId) {
          runtime.adminSelectedTestId = testId;
          runtime.adminStudioTab = "questions";
          runtime.adminEditingQuestionId = questionId;
          runtime.adminQuestionEditorOpen = false;
          rerenderAdminPreserveScroll(user, testId);
          window.requestAnimationFrame(function () {
            var form = document.getElementById("question-form");
            if (form) form.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
          });
        });
      }
      // Open report counts feed the Reports tab badge and Paper Health (refreshed each minute).
      if (store.getQuestionReportCounts && (!runtime.reportCountsAt || Date.now() - runtime.reportCountsAt > 60000)) {
        runtime.reportCountsAt = Date.now();
        Promise.resolve(store.getQuestionReportCounts()).then(function (counts) {
          var before = JSON.stringify(runtime.reportCounts || null);
          runtime.reportCounts = counts || {};
          runtime.reportOpenTotal = Object.keys(runtime.reportCounts).reduce(function (sum, k) { return sum + runtime.reportCounts[k]; }, 0);
          var changed = before === "null" ? runtime.reportOpenTotal > 0 : before !== JSON.stringify(runtime.reportCounts);
          if (changed && location.hash.indexOf("admin") !== -1 && !document.querySelector("[data-admin-modal='true']")) {
            rerenderAdminPreserveScroll(user, selectedTestId);
          }
        }).catch(function () { });
      }

      var userSearchInput = document.getElementById("admin-user-search");
      if (userSearchInput) {
        userSearchInput.addEventListener("input", function () {
          runtime.adminUserSearchQuery = userSearchInput.value;
          runtime.adminUsersPage = 1;
          window.clearTimeout(runtime.adminUserSearchTimer);
          runtime.adminUserSearchTimer = window.setTimeout(function () {
            rerenderAdminPreserveScroll(user, selectedTestId);
          }, 300);
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
    var paidCount = snapshot.paidUserCount !== undefined ? snapshot.paidUserCount : users.filter(function (u) { return u && u.isPaid; }).length;
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
    window.requestAnimationFrame(armOpensCountdown);
    runtime.lastRouteView = routeParts()[0] || "";
    runtime.lastRouteHash = window.location.hash;
    clearActiveRenderModal();
    var route = parseHashRoute();
    var parts = routeParts();
    var user = auth.getCurrentUser ? auth.getCurrentUser() : null;
    var savedLastView = (function () { try { return localStorage.getItem("aceiiit_last_view"); } catch (_e) { return ""; } })();
    var view = route.view || (user ? (savedLastView || "dashboard") : "login");
    applyTheme();
    syncMentorWithRoute(view, parts, user);
    scheduleWhatsNew(view, user);
    // Pages with the main nav put the phone tab bar back (renderPrimaryNav); others have none.
    document.body.classList.remove("has-tabbar");

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
    syncAndRenderCurrentRoute({ navigation: true });
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
    
    // Scrolling inside the mentor, a dialog or a scroll box isn't the page moving: leave the header.
    if (e.target && e.target.closest && e.target.closest(".mentor-root, [data-admin-modal], [data-whats-new], .admin-modal-overlay, .import-table-wrap, .pr-topics-wrap")) return;
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
    switchThemeWithCurtain(toggle);
  });
  document.addEventListener("click", function (event) {
    var toggle = event.target && event.target.closest ? event.target.closest(".js-mentor-toggle") : null;
    if (!toggle) return;
    event.preventDefault();
    toggleMentor(toggle);
  });
  ensureThemeCurtain();

  // Back from Google's consent screen (Studio → Study Materials → Connect Google Drive).
  (function handleDriveReturn() {
    var result = "";
    try { result = new URLSearchParams(window.location.search).get("drive") || ""; } catch (_e) { return; }
    if (!result) return;
    runtime.adminStudioTab = "materials";
    driveUi.notice = {
      connected: "Google Drive is connected. Add folders and files below, or straight in Google Drive.",
      denied: "Google Drive wasn't connected: access wasn't granted.",
      no_refresh_token: "Google didn't grant offline access. Remove AceIIIT from your Google Account's third-party access, then connect again.",
      failed: "Connecting Google Drive failed. Try again."
    }[result] || "";
    try { history.replaceState(null, "", window.location.pathname + window.location.hash); } catch (_e) { }
  })();

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
