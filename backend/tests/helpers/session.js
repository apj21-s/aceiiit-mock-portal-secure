const request = require("supertest");

const { DEFAULT_PASSWORD } = require("./fixtures");

/**
 * A cookie-carrying browser-like client: holds the session + CSRF cookies and sends the
 * X-CSRF-Token header on mutations, exactly like backend/public/js/storage.js.
 */
async function newClient(app) {
  const agent = request.agent(app);
  const res = await agent.get("/api/auth/csrf");
  const csrf = res.body.csrfToken;
  const withCsrf = (req) => req.set("X-CSRF-Token", csrf);
  return {
    agent,
    csrf,
    get: (url) => agent.get(url),
    post: (url, body) => withCsrf(agent.post(url)).send(body || {}),
    put: (url, body) => withCsrf(agent.put(url)).send(body || {}),
    patch: (url, body) => withCsrf(agent.patch(url)).send(body || {}),
    del: (url) => withCsrf(agent.delete(url)),
  };
}

async function loginClient(app, email, password = DEFAULT_PASSWORD) {
  const client = await newClient(app);
  const res = await client.post("/api/auth/login", { email, password });
  if (res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  client.user = res.body.user;
  return client;
}

module.exports = { newClient, loginClient };
