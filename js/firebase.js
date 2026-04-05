(function () {
  window.AceIIIT = window.AceIIIT || {};

  var STORAGE_KEY = "aceiiit.secure.firebase.config.v1";
  var FORCE_FIRESTORE_IMAGE_FALLBACK = true;
  var DEFAULT_CONFIG = {
    apiKey: "AIzaSyDCnUiFt8dtmdmZ2ajsD9klewsXnsuX-pg",
    appId: "1:1067955185454:web:dbd194565dd91eed64bcbf",
    projectId: "aceiiit-mocktests",
    storageBucket: "aceiiit-mocktests.firebasestorage.app"
  };

  function getConfig() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved) {
        return Object.assign({}, DEFAULT_CONFIG);
      }
      return Object.assign({}, DEFAULT_CONFIG, saved);
    } catch (error) {
      return Object.assign({}, DEFAULT_CONFIG);
    }
  }

  function setConfig(config) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.assign({}, DEFAULT_CONFIG, config || {})));
  }

  function getRuntimeConfig() {
    var config = getConfig();
    if (!config) {
      return null;
    }

    var runtime = Object.assign({}, config);
    if (!runtime.authDomain && runtime.projectId) {
      runtime.authDomain = runtime.projectId + ".firebaseapp.com";
    }
    return runtime;
  }

  function isConfigured() {
    var config = getRuntimeConfig();
    return !!(config && config.apiKey && config.projectId && config.appId && config.storageBucket);
  }

  function ensureApp() {
    var config = getRuntimeConfig();
    var hasFirebase = typeof window.firebase !== "undefined" && window.firebase.apps;
    if (!hasFirebase || !isConfigured()) {
      return null;
    }

    if (!window.firebase.apps.length) {
      window.firebase.initializeApp(config);
    }

    return window.firebase.app();
  }

  function getFirestore() {
    try {
      var app = ensureApp();
      return app ? window.firebase.firestore() : null;
    } catch (error) {
      return null;
    }
  }

  function getAuth() {
    try {
      var app = ensureApp();
      if (!app || !window.firebase || typeof window.firebase.auth !== "function") {
        return null;
      }
      return window.firebase.auth();
    } catch (error) {
      return null;
    }
  }

  function getStorage() {
    try {
      var app = ensureApp();
      if (!app || !window.firebase || typeof window.firebase.storage !== "function") {
        return null;
      }
      return window.firebase.storage();
    } catch (error) {
      return null;
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

  function withTimeout(promise, timeoutMs, message) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (!settled) {
          settled = true;
          reject(new Error(message || "Operation timed out"));
        }
      }, timeoutMs);

      promise.then(function (value) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      }).catch(function (error) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  async function compressFileToDataUrl(file) {
    var original = await readFileAsDataUrl(file);
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

    var quality = 0.8;
    var result = canvas.toDataURL("image/jpeg", quality);
    while (result.length > 260000 && quality > 0.36) {
      quality -= 0.06;
      result = canvas.toDataURL("image/jpeg", quality);
    }

    while (result.length > 260000 && canvas.width > 520 && canvas.height > 520) {
      canvas.width = Math.max(520, Math.round(canvas.width * 0.86));
      canvas.height = Math.max(520, Math.round(canvas.height * 0.86));
      context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      result = canvas.toDataURL("image/jpeg", quality);
    }

    return result;
  }

  async function uploadFiles(files, testId, questionId) {
    var safeFiles = Array.prototype.slice.call(files || []);
    var storage = FORCE_FIRESTORE_IMAGE_FALLBACK ? null : getStorage();

    if (!safeFiles.length) {
      return [];
    }

    if (storage) {
      try {
        var uploads = safeFiles.map(async function (file, index) {
          var ext = file.name && file.name.indexOf(".") !== -1 ? file.name.slice(file.name.lastIndexOf(".")) : "";
          var path = "questions/" + (testId || "unassigned") + "/" + (questionId || ("draft-" + Date.now())) + "/" + Date.now() + "-" + index + ext;
          var ref = storage.ref().child(path);
          await withTimeout(ref.put(file), 15000, "Firebase image upload timed out");
          return ref.getDownloadURL();
        });
        return withTimeout(Promise.all(uploads), 18000, "Firebase image upload timed out");
      } catch (error) {
        return withTimeout(Promise.all(safeFiles.map(compressFileToDataUrl)), 18000, "Image processing timed out");
      }
    }

    return withTimeout(Promise.all(safeFiles.map(compressFileToDataUrl)), 18000, "Image processing timed out");
  }

  function createUser(email, password) {
    var auth = getAuth();
    if (!auth) {
      return Promise.reject(new Error("Firebase Auth is not configured yet."));
    }
    return auth.createUserWithEmailAndPassword(email, password).then(function (credential) {
      return credential && credential.user ? credential.user : null;
    });
  }

  function signIn(email, password) {
    var auth = getAuth();
    if (!auth) {
      return Promise.reject(new Error("Firebase Auth is not configured yet."));
    }
    return auth.signInWithEmailAndPassword(email, password).then(function (credential) {
      return credential && credential.user ? credential.user : null;
    });
  }

  function signOut() {
    var auth = getAuth();
    if (!auth) {
      return Promise.resolve();
    }
    return auth.signOut();
  }

  function getCurrentAuthUser() {
    var auth = getAuth();
    return auth ? auth.currentUser : null;
  }

  function onAuthStateChanged(callback) {
    var auth = getAuth();
    if (!auth) {
      return function () {};
    }
    return auth.onAuthStateChanged(callback);
  }

  window.AceIIIT.firebase = {
    getConfig: getConfig,
    setConfig: setConfig,
    isConfigured: isConfigured,
    getFirestore: getFirestore,
    getAuth: getAuth,
    getStorage: getStorage,
    uploadFiles: uploadFiles,
    createUser: createUser,
    signIn: signIn,
    signOut: signOut,
    getCurrentAuthUser: getCurrentAuthUser,
    onAuthStateChanged: onAuthStateChanged
  };
})();
