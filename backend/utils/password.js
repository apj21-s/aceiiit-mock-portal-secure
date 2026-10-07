const crypto = require("crypto");

// Password hashing. Native bcrypt runs on the libuv threadpool, off the event loop, and is
// several times faster under concurrent logins; bcryptjs is the pure-JS fallback if the
// native module can't load on a host. Their hashes are interchangeable ($2a/$2b).
let impl;
let isNative = false;
try {
  impl = require("bcrypt");
  isNative = true;
} catch (_err) {
  impl = require("bcryptjs");
}

const ROUNDS = 12;
let dummyHashPromise = null;

function hashPassword(password) {
  return impl.hash(password, ROUNDS);
}

/**
 * Constant-work check: with no stored hash (unknown, disabled or OAuth-only account) it still
 * runs a full compare against a dummy hash, so response time doesn't reveal whether an
 * account exists.
 */
async function verifyPassword(password, passwordHash) {
  if (!passwordHash) {
    dummyHashPromise = dummyHashPromise || impl.hash(crypto.randomBytes(16).toString("hex"), ROUNDS);
    await impl.compare(String(password || ""), await dummyHashPromise);
    return false;
  }
  return impl.compare(String(password || ""), passwordHash);
}

module.exports = { hashPassword, verifyPassword, isNative, ROUNDS };
