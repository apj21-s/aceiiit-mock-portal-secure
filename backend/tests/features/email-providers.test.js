// Email delivery falls back Resend → Brevo → SMTP, and fails with a controlled 503 when
// every provider fails. No real network: Resend is mocked, Brevo is intercepted at fetch,
// SMTP uses a stub transport.
const mockResendSend = jest.fn();
jest.mock("resend", () => ({ Resend: jest.fn(() => ({ emails: { send: mockResendSend } })) }));
const mockSmtpSend = jest.fn();
jest.mock("nodemailer", () => ({ createTransport: jest.fn(() => ({ sendMail: mockSmtpSend })) }));

const { sendEmailThroughProviders } = require("../../utils/mailService");

const MAIL = { to: "student@test.local", subject: "Hello\r\nBcc: x@evil.test", html: "<p>Hi</p>" };
let fetchSpy;

beforeEach(() => {
  process.env.RESEND_API_KEY = "re_test";
  process.env.BREVO_API_KEY = "brevo_test";
  delete process.env.SMTP_HOST;
  mockResendSend.mockReset();
  mockSmtpSend.mockReset();
  fetchSpy = jest.spyOn(global, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
  delete process.env.RESEND_API_KEY;
  delete process.env.BREVO_API_KEY;
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
});

test("Resend success: no fallback calls", async () => {
  mockResendSend.mockResolvedValue({ error: null });
  expect(await sendEmailThroughProviders(MAIL)).toEqual({ provider: "resend" });
  expect(fetchSpy).not.toHaveBeenCalled();
  // Header injection via the subject is neutralised.
  expect(mockResendSend.mock.calls[0][0].subject).not.toMatch(/[\r\n]/);
});

test("Resend error → Brevo delivers", async () => {
  mockResendSend.mockResolvedValue({ error: { message: "rate limited" } });
  fetchSpy.mockResolvedValue(new Response("{}", { status: 201 }));
  expect(await sendEmailThroughProviders(MAIL)).toEqual({ provider: "brevo" });
  const [url, init] = fetchSpy.mock.calls[0];
  expect(url).toBe("https://api.brevo.com/v3/smtp/email");
  expect(init.headers["api-key"]).toBe("brevo_test");
  expect(JSON.parse(init.body).to).toEqual([{ email: "student@test.local" }]);
});

test("Resend throws and Brevo fails → SMTP delivers when configured", async () => {
  mockResendSend.mockRejectedValue(new Error("network down"));
  fetchSpy.mockResolvedValue(new Response("bad", { status: 500 }));
  Object.assign(process.env, { SMTP_HOST: "smtp.test.local", SMTP_USER: "u", SMTP_PASS: "p" });
  mockSmtpSend.mockResolvedValue({ messageId: "1" });
  expect(await sendEmailThroughProviders(MAIL)).toEqual({ provider: "smtp" });
  expect(mockSmtpSend).toHaveBeenCalledTimes(1);
});

test("every provider fails → controlled 503 listing each failure", async () => {
  mockResendSend.mockResolvedValue({ error: { message: "down" } });
  fetchSpy.mockResolvedValue(new Response("down", { status: 503 }));
  await expect(sendEmailThroughProviders(MAIL)).rejects.toMatchObject({
    status: 503,
    expose: true,
    details: [expect.stringMatching(/^resend:/), expect.stringMatching(/^brevo:/), expect.stringMatching(/^smtp: SMTP is not configured/)],
  });
});
