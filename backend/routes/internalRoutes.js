const express = require('express');
const router = express.Router();
const User = require('../models/User');
const Entitlement = require('../models/Entitlement');
const Season = require('../models/Season');

router.post('/access/provision', async (req, res) => {
  const secret = req.headers['x-internal-api-secret'];
  const expectedSecret = process.env.INTERNAL_API_SECRET || 'secret';
  if (secret !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized internal access' });
  }

  const { commerceUserId, mockUserId, email, resourceCode, entitlementId, idempotencyKey } = req.body;

  try {
    // Determine season based on resource code. We'll default to the active season or create a placeholder.
    let season = await Season.findOne({ status: 'active' });
    if (!season) {
      season = await Season.create({ name: 'Default Season', status: 'active', year: new Date().getFullYear() });
    }

    // Upsert User
    const normalizedEmail = email.toLowerCase().trim();
    let user = await User.findOne({ normalizedEmail });
    if (!user) {
      user = await User.create({
        name: email.split('@')[0],
        email: email,
        normalizedEmail,
        isPaid: true,
        status: 'active'
      });
    } else {
      user.isPaid = true;
      user.status = 'active';
      await user.save();
    }

    // Use entitlementId as Idempotency Key mapping via PaymentId or storing it directly.
    // The Entitlement schema has a compound unique index on { seasonId: 1, normalizedEmail: 1 }.
    // This makes the operation naturally idempotent per season per email!
    
    let entitlement = await Entitlement.findOne({ seasonId: season._id, normalizedEmail });
    if (!entitlement) {
      entitlement = await Entitlement.create({
        userId: user._id,
        email: user.email,
        normalizedEmail,
        seasonId: season._id,
        tier: 'paid',
        status: 'active',
        source: 'admin' // from commerce backend
      });
    } else {
      entitlement.tier = 'paid';
      entitlement.status = 'active';
      await entitlement.save();
    }

    res.json({ success: true, entitlement });
  } catch (error) {
    console.error('Provisioning error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;
