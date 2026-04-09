const { Resend } = require("resend");

let cachedResend = null;
let cachedKey = null;

function getResend() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is required (SMTP is removed).");
  }
  if (cachedResend && cachedKey === apiKey) {
    return cachedResend;
  }
  cachedKey = apiKey;
  cachedResend = new Resend(apiKey);
  return cachedResend;
}

async function sendOtpEmail(email, otp) {
  const resend = getResend();

  const { error } = await resend.emails.send({
    from: "ACE IIIT <otp@aceiiit.in>",
    to: [String(email || "").trim().toLowerCase()],
    subject: "ACE IIIT OTP Verification",
    html: `
      <div style="font-family: Arial;">
        <h2>ACE IIIT Mock Portal</h2>
        <p>Your OTP is:</p>
        <h1>${String(otp || "").trim()}</h1>
        <p>This OTP is valid for 5 minutes.</p>
      </div>
    `,
  });

  if (error) {
    // Keep the error server-side; caller may choose to not block the response.
    // eslint-disable-next-line no-console
    console.error(error);
    throw new Error("Failed to send OTP");
  }
}

module.exports = { sendOtpEmail };
