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
    login: function (payload) {
      return getStore().login(payload);
    },
    requestActivation: function (payload) {
      return getStore().requestActivation(payload);
    },
    verifyActivationToken: function (token) {
      return getStore().verifyActivationToken(token);
    },
    completeActivation: function (payload) {
      return getStore().completeActivation(payload);
    },
    requestPasswordReset: function (payload) {
      return getStore().requestPasswordReset(payload);
    },
    verifyResetToken: function (token) {
      return getStore().verifyResetToken(token);
    },
    completePasswordReset: function (payload) {
      return getStore().completePasswordReset(payload);
    },
    updatePassword: function (payload) {
      return getStore().updatePassword(payload);
    },
    googleAuth: function (payload) {
      return getStore().googleAuth(payload);
    },
    appleAuth: function (payload) {
      return getStore().appleAuth(payload);
    },
    getAuthConfig: function () {
      return getStore().getAuthConfig();
    },
    sendOtp: function (payload) {
      return getStore().sendOtp ? getStore().sendOtp(payload) : getStore().requestActivation(payload);
    },
    verifyOtp: function (payload) {
      return getStore().verifyOtp ? getStore().verifyOtp(payload) : getStore().login(payload);
    },
    logout: function () {
      return getStore().logout();
    },
    isAdmin: function (user) {
      return getStore().isAdmin(user);
    },
  };
})();
