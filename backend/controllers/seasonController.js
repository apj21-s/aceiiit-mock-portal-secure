const Season = require("../models/Season");
const { getActiveSeason, setActiveSeason, duplicateSeason } = require("../services/seasonService");
const { logAuditEvent } = require("../services/auditLogService");

async function listSeasons(req, res, next) {
  try {
    const seasons = await Season.find().sort({ year: -1, createdAt: -1 }).lean();
    res.json({ seasons });
  } catch (err) {
    next(err);
  }
}

async function getActiveSeasonEndpoint(req, res, next) {
  try {
    const active = await getActiveSeason();
    res.json({ season: active.toJSON() });
  } catch (err) {
    next(err);
  }
}

async function createSeason(req, res, next) {
  try {
    // Validated by the route (adminRoutes schemas.createSeason).
    const { name, examName, year, status, startDate, endDate, resourceCode } = req.body;

    const season = await Season.create({
      name,
      examName,
      year: Number(year),
      status,
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
      resourceCode: resourceCode || "",
      createdById: req.auth ? req.auth.userId : null,
    });

    await logAuditEvent({
      actorUserId: req.auth ? req.auth.userId : null,
      action: "SEASON_CREATED",
      entityType: "Season",
      entityId: season.id,
      seasonId: season.id,
      after: season.toJSON(),
    });

    res.status(201).json({ season: season.toJSON() });
  } catch (err) {
    next(err);
  }
}

async function setActiveSeasonEndpoint(req, res, next) {
  try {
    const season = await setActiveSeason(req.params.id, req.auth ? req.auth.userId : null);
    res.json({ season: season.toJSON() });
  } catch (err) {
    next(err);
  }
}

async function archiveSeason(req, res, next) {
  try {
    const season = await Season.findById(req.params.id);
    if (!season) return res.status(404).json({ error: "Season not found" });

    const before = season.toJSON();
    season.status = "archived";
    season.isDefaultActive = false;
    await season.save();

    await logAuditEvent({
      actorUserId: req.auth ? req.auth.userId : null,
      action: "SEASON_ARCHIVED",
      entityType: "Season",
      entityId: season.id,
      seasonId: season.id,
      before,
      after: season.toJSON(),
    });

    res.json({ season: season.toJSON() });
  } catch (err) {
    next(err);
  }
}

async function duplicateSeasonEndpoint(req, res, next) {
  try {
    const result = await duplicateSeason(
      req.params.id,
      req.body || {},
      req.auth ? req.auth.userId : null
    );
    res.status(201).json({ season: result.newSeason.toJSON(), copiedTestsCount: result.copiedTestsCount });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listSeasons,
  getActiveSeasonEndpoint,
  createSeason,
  setActiveSeasonEndpoint,
  archiveSeason,
  duplicateSeasonEndpoint,
};
