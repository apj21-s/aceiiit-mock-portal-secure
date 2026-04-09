(function () {
  window.AceIIIT = window.AceIIIT || {};

  function getStore() {
    return window.AceIIIT.__store || window.AceIIIT.store;
  }

  window.AceIIIT.auth = {
    getCurrentUser: function () {
      var store = getStore();
      return store ? store.getCurrentUser() : null;
    },
    sendOtp: function (payload) {
      return getStore().sendOtp(payload);
    },
    verifyOtp: function (payload) {
      return getStore().verifyOtp(payload);
    },
    logout: function () {
      return getStore().logout();
    },
    isAdmin: function (user) {
      return getStore().isAdmin(user);
    }
  };
})();
