const PaymentRecord = require("../models/PaymentRecord");
const User = require("../models/User");
const { z } = require("zod");
const { escapeRegex } = require("../utils/escapeRegex");

const {
  createManualPayment,
  verifyPaymentManually,
  revokePaymentManually,
  resendConfirmationEmail,
} = require("../services/paymentSyncService");

async function listPayments(req, res, next) {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)));
    const { status, search, seasonId } = req.query || {};

    const filter = {};
    if (status) filter.status = status;
    if (seasonId) filter.seasonId = seasonId;
    if (search) {
      const q = escapeRegex(String(search).trim().toLowerCase());
      filter.$or = [
        { email: { $regex: q, $options: "i" } },
        { normalizedEmail: { $regex: q, $options: "i" } },
        { name: { $regex: q, $options: "i" } },
      ];
    }

    const total = await PaymentRecord.countDocuments(filter);
    const payments = await PaymentRecord.find(filter)
      .populate("seasonId", "name year")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Map each payment record with user signup status
    const normEmails = payments.map((p) => p.normalizedEmail).filter(Boolean);
    const users = await User.find({ normalizedEmail: { $in: normEmails } })
      .select("_id name email normalizedEmail role status isActivated isPaid createdAt")
      .lean();

    const userMap = new Map();
    for (const u of users) {
      if (u.normalizedEmail) userMap.set(u.normalizedEmail, u);
    }

    const mappedPayments = payments.map((p) => {
      const linkedUser = userMap.get(p.normalizedEmail) || null;
      return {
        ...p,
        id: String(p._id),
        hasUserAccount: Boolean(linkedUser),
        user: linkedUser
          ? {
              id: String(linkedUser._id),
              name: linkedUser.name,
              email: linkedUser.email,
              status: linkedUser.status,
              isActivated: linkedUser.isActivated,
              isPaid: linkedUser.isPaid,
            }
          : null,
      };
    });

    res.json({
      payments: mappedPayments,
      pagination: {
        page,
        limit,
        total,
        pages: total ? Math.ceil(total / limit) : 1,
      },
    });
  } catch (err) {
    next(err);
  }
}

const createPaymentSchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().max(120).optional(),
  seasonId: z.string().regex(/^[a-f0-9]{24}$/i).optional(),
  note: z.string().trim().max(500).optional(),
});

async function createPaymentController(req, res, next) {
  try {
    const input = createPaymentSchema.parse(req.body || {});
    const payment = await createManualPayment({ ...input, actorUserId: req.auth.userId });
    res.status(201).json({ ok: true, payment });
  } catch (err) {
    next(err);
  }
}

async function verifyPaymentController(req, res, next) {
  try {
    const payment = await verifyPaymentManually({
      paymentId: req.params.id,
      actorUserId: req.auth ? req.auth.userId : null,
      sendEmail: req.body ? req.body.sendEmail !== false : true,
    });
    res.json({ ok: true, payment });
  } catch (err) {
    next(err);
  }
}

async function revokePaymentController(req, res, next) {
  try {
    const payment = await revokePaymentManually({
      paymentId: req.params.id,
      actorUserId: req.auth ? req.auth.userId : null,
    });
    res.json({ ok: true, payment });
  } catch (err) {
    next(err);
  }
}

async function resendPaymentEmailController(req, res, next) {
  try {
    const payment = await resendConfirmationEmail({
      paymentId: req.params.id,
      actorUserId: req.auth ? req.auth.userId : null,
    });
    res.json({ ok: true, payment });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listPayments,
  createPaymentController,
  verifyPaymentController,
  revokePaymentController,
  resendPaymentEmailController,
};
