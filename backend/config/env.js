const { z } = require("zod");

// Boot-time environment validation. Production fails fast on any missing or weak
// security-critical setting; development and test stay lenient so local work is easy.

const MIN_SECRET_LENGTH = 32;

function isTruthy(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

const httpsUrl = z
  .string()
  .url("must be a valid URL")
  .refine((value) => value.startsWith("https://"), "must use https:// in production");

const productionSchema = z
  .object({
    JWT_SECRET: z.string().min(MIN_SECRET_LENGTH, `must be at least ${MIN_SECRET_LENGTH} characters`),
    MONGODB_URI: z.string().min(1, "is required"),
    GOOGLE_CLIENT_ID: z.string().min(1, "is required"),
    APPLE_CLIENT_ID: z.string().optional(),
    INTERNAL_API_SECRET: z.string().min(MIN_SECRET_LENGTH, `must be at least ${MIN_SECRET_LENGTH} characters`),
    PORTAL_BASE_URL: httpsUrl,
    CALENDAR_TOKEN_KEY: z.string().min(MIN_SECRET_LENGTH, `must be at least ${MIN_SECRET_LENGTH} characters`),
    RESEND_API_KEY: z.string().optional(),
    BREVO_API_KEY: z.string().optional(),
    ALLOW_INSECURE_DEV_AUTH: z.string().optional(),
  })
  .passthrough()
  .superRefine((env, ctx) => {
    if (isTruthy(env.ALLOW_INSECURE_DEV_AUTH)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ALLOW_INSECURE_DEV_AUTH"],
        message: "must not be enabled in production",
      });
    }
    if (!String(env.RESEND_API_KEY || "").trim() && !String(env.BREVO_API_KEY || "").trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RESEND_API_KEY"],
        message: "an email provider key (RESEND_API_KEY or BREVO_API_KEY) is required",
      });
    }
  });

function formatIssues(error) {
  return error.issues.map((issue) => `${issue.path.join(".") || "env"} ${issue.message}`).join("; ");
}

/**
 * Validates the environment. Throws in production when the configuration is unsafe.
 * In non-production environments it only enforces the minimum needed to run.
 */
function validateEnv(env = process.env) {
  const nodeEnv = String(env.NODE_ENV || "development").trim();
  if (nodeEnv === "production") {
    const result = productionSchema.safeParse(env);
    if (!result.success) {
      throw new Error(`Invalid production environment: ${formatIssues(result.error)}`);
    }
    return { nodeEnv, insecureDevAuth: false };
  }

  if (!String(env.JWT_SECRET || "").trim()) {
    throw new Error("JWT_SECRET is required (set it in backend/.env)");
  }
  return { nodeEnv, insecureDevAuth: isTruthy(env.ALLOW_INSECURE_DEV_AUTH) };
}

/** Dev-only mock OAuth is allowed only when explicitly enabled outside production. */
function isInsecureDevAuthAllowed(env = process.env) {
  return isTruthy(env.ALLOW_INSECURE_DEV_AUTH) && String(env.NODE_ENV || "").trim() !== "production";
}

function isProduction(env = process.env) {
  return String(env.NODE_ENV || "").trim() === "production";
}

module.exports = { validateEnv, isInsecureDevAuthAllowed, isProduction, MIN_SECRET_LENGTH };
