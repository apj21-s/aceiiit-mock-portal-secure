const mongoose = require("mongoose");

let connectionPromise = null;
let lastConnectionError = null;

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

function getDbStatus() {
  return {
    ready: isDbReady(),
    readyState: mongoose.connection.readyState,
    lastError: lastConnectionError ? lastConnectionError.message : null,
  };
}

async function connectDb(uri) {
  if (!uri) {
    throw new Error("MONGODB_URI is required");
  }
  if (isDbReady()) {
    return mongoose.connection;
  }
  if (connectionPromise) {
    return connectionPromise;
  }
  mongoose.set("strictQuery", true);
  const allowAutoIndex = String(process.env.MONGO_AUTO_INDEX || "").trim().toLowerCase() === "true";
  connectionPromise = mongoose.connect(uri, {
    autoIndex: allowAutoIndex || process.env.NODE_ENV !== "production",
    maxPoolSize: Number(process.env.MONGO_MAX_POOL_SIZE || 25),
    minPoolSize: Number(process.env.MONGO_MIN_POOL_SIZE || 3),
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 5000),
    socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 15000),
    connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 5000),
  })
    .then((connection) => {
      lastConnectionError = null;
      return connection;
    })
    .catch((err) => {
      lastConnectionError = err;
      connectionPromise = null;
      throw err;
    });

  return connectionPromise;
}

module.exports = { connectDb, isDbReady, getDbStatus };
