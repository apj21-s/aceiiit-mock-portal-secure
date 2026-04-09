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
    getSettings: bind("getSettings"),
    updateSettings: bind("updateSettings"),
    getTests: bind("getTests"),
    getQuestions: bind("getQuestions"),
    getTestById: bind("getTestById"),
    getQuestionsForTest: bind("getQuestionsForTest"),
    listUserAttempts: bind("listUserAttempts"),
    getAttemptById: bind("getAttemptById"),
    getInProgressAttempt: bind("getInProgressAttempt"),
    createAttempt: bind("createAttempt"),
    getOrCreateAttempt: bind("getOrCreateAttempt"),
    patchAttempt: bind("patchAttempt"),
    submitAttempt: bind("submitAttempt"),
    markAttemptSubmissionCooldown: bind("markAttemptSubmissionCooldown"),
    getDashboardSnapshot: bind("getDashboardSnapshot"),
    getAdminSnapshot: bind("getAdminSnapshot"),
    createQuestion: bind("createQuestion"),
    updateQuestion: bind("updateQuestion"),
    deleteQuestion: bind("deleteQuestion"),
    createTest: bind("createTest"),
    updateTest: bind("updateTest"),
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
    exportData: bind("exportData"),
    importData: bind("importData"),
    isAdmin: bind("isAdmin")
  };
})();
