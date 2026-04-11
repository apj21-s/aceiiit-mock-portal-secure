(function () {
  window.AceIIIT = window.AceIIIT || {};

  function getStore() {
    return window.AceIIIT.__store || window.AceIIIT.store;
  }

  function bind(method) {
    return function () {
      var store = getStore();
      return store[method].apply(store, arguments);
    };
  }

  window.AceIIIT.db = {
    init: bind("init"),
    refreshFromRemote: bind("refreshFromRemote"),
    subscribeToRemoteChanges: bind("subscribeToRemoteChanges"),
    getCurrentUser: bind("getCurrentUser"),
    getSettings: bind("getSettings"),
    updateSettings: bind("updateSettings"),
    getTests: bind("getTests"),
    getQuestions: bind("getQuestions"),
    getTestById: bind("getTestById"),
    getQuestionsForTest: bind("getQuestionsForTest"),
    getTestQuestionsFromRemote: bind("getTestQuestionsFromRemote"),
    ensureTestQuestionsLoaded: bind("ensureTestQuestionsLoaded"),
    listUserAttempts: bind("listUserAttempts"),
    getAttemptById: bind("getAttemptById"),
    getAttemptResult: bind("getAttemptResult"),
    getInProgressAttempt: bind("getInProgressAttempt"),
    createAttempt: bind("createAttempt"),
    getOrCreateAttempt: bind("getOrCreateAttempt"),
    patchAttempt: bind("patchAttempt"),
    submitAttempt: bind("submitAttempt"),
    markAttemptSubmissionCooldown: bind("markAttemptSubmissionCooldown"),
    getDashboardSnapshot: bind("getDashboardSnapshot"),
    getAdminSnapshot: bind("getAdminSnapshot"),
    uploadQuestionImages: bind("uploadQuestionImages"),
    createQuestion: bind("createQuestion"),
    updateQuestion: bind("updateQuestion"),
    deleteQuestion: bind("deleteQuestion"),
    createTest: bind("createTest"),
    updateTest: bind("updateTest"),
    reorderTests: bind("reorderTests"),
    deleteTest: bind("deleteTest"),
    attachQuestionToTest: bind("attachQuestionToTest"),
    detachQuestionFromTest: bind("detachQuestionFromTest"),
    getAdminResults: bind("getAdminResults"),
    getAdminTrash: bind("getAdminTrash"),
    restoreTrash: bind("restoreTrash"),
    purgeTrash: bind("purgeTrash"),
    deleteUser: bind("deleteUser"),
    getAdminLeaderboard: bind("getAdminLeaderboard"),
    getAdminTestAnalytics: bind("getAdminTestAnalytics"),
    getAttemptAnalysis: bind("getAttemptAnalysis"),
    getAttemptQuestionReview: bind("getAttemptQuestionReview"),
    exportData: bind("exportData"),
    importData: bind("importData"),
    isAdmin: bind("isAdmin")
  };
})();
