// Evidence-based behaviour patterns derived from deterministic analytics. Each pattern
// carries the exact numbers that justify it and only fires above a minimum sample size.
// No psychological claims: patterns describe what happened, not why the student feels.

const MIN_ATTEMPTED = 3;
const MIN_TOPIC_ATTEMPTED = 2;

function detectPatterns(analytics, profile = null) {
  const patterns = [];
  const { overall, timing, topics, difficulty, sections } = analytics;

  if (timing.slowAttempted >= MIN_ATTEMPTED && timing.slowWrong / timing.slowAttempted >= 0.5) {
    patterns.push({
      code: "high_time_low_accuracy",
      severity: "high",
      evidence: { slowQuestions: timing.slowAttempted, slowWrong: timing.slowWrong, medianTimeSec: timing.medianTimeSec },
    });
  }
  if (timing.fastAttempted >= MIN_ATTEMPTED && timing.fastWrong / timing.fastAttempted >= 0.5) {
    patterns.push({
      code: "fast_low_accuracy",
      severity: "high",
      evidence: { fastQuestions: timing.fastAttempted, fastWrong: timing.fastWrong, medianTimeSec: timing.medianTimeSec },
    });
  }
  const strongSlow = topics.filter((t) => t.attempted >= MIN_TOPIC_ATTEMPTED && t.accuracyPct >= 75 && timing.medianTimeSec && t.avgTimeSec > timing.medianTimeSec * 1.5);
  if (strongSlow.length) {
    patterns.push({
      code: "accurate_but_slow",
      severity: "medium",
      evidence: { topics: strongSlow.slice(0, 3).map((t) => ({ topic: t.topic, accuracyPct: t.accuracyPct, avgTimeSec: t.avgTimeSec })) },
    });
  }
  const failing = topics.filter((t) => t.attempted >= MIN_TOPIC_ATTEMPTED && t.accuracyPct < 40);
  if (failing.length) {
    patterns.push({
      code: "weak_topics",
      severity: "high",
      evidence: { topics: failing.slice(0, 4).map((t) => ({ topic: t.topic, section: t.section, accuracyPct: t.accuracyPct, attempted: t.attempted, marksLost: t.marksLost })) },
    });
  }
  const easy = difficulty.find((d) => d.level === "easy");
  const hard = difficulty.find((d) => d.level === "hard");
  if (easy && hard && easy.attempted >= MIN_ATTEMPTED && hard.attempted >= MIN_ATTEMPTED && easy.accuracyPct - hard.accuracyPct >= 30) {
    patterns.push({
      code: "difficulty_sensitivity",
      severity: "medium",
      evidence: { easyAccuracyPct: easy.accuracyPct, hardAccuracyPct: hard.accuracyPct },
    });
  }
  if (easy && easy.attempted >= MIN_ATTEMPTED && easy.accuracyPct < 60) {
    patterns.push({ code: "easy_question_slips", severity: "high", evidence: { easyAccuracyPct: easy.accuracyPct, easyWrong: easy.wrong } });
  }
  if (overall.total >= 5 && overall.attemptRatePct < 60) {
    patterns.push({ code: "low_coverage", severity: "medium", evidence: { attemptRatePct: overall.attemptRatePct, skipped: overall.skipped } });
  }
  if (overall.attempted >= MIN_ATTEMPTED && overall.marksLost > 0 && timing.timeOnWrongPct >= 35) {
    patterns.push({
      code: "time_sunk_into_wrong_answers",
      severity: "medium",
      evidence: { timeOnWrongPct: timing.timeOnWrongPct, marksLost: overall.marksLost },
    });
  }
  const weakSection = sections.filter((s) => s.attempted >= MIN_ATTEMPTED).sort((a, b) => a.accuracyPct - b.accuracyPct)[0];
  const strongSection = sections.filter((s) => s.attempted >= MIN_ATTEMPTED).sort((a, b) => b.accuracyPct - a.accuracyPct)[0];
  if (weakSection && strongSection && weakSection.key !== strongSection.key && strongSection.accuracyPct - weakSection.accuracyPct >= 20) {
    patterns.push({
      code: "section_gap",
      severity: "medium",
      evidence: { weakSection: weakSection.key, weakAccuracyPct: weakSection.accuracyPct, strongSection: strongSection.key, strongAccuracyPct: strongSection.accuracyPct },
    });
  }
  if (profile && profile.previous) {
    const delta = profile.previous.accuracyPctDelta;
    if (delta >= 5) patterns.push({ code: "improving", severity: "positive", evidence: { accuracyPctDelta: delta } });
    if (delta <= -5) patterns.push({ code: "regressing", severity: "medium", evidence: { accuracyPctDelta: delta } });
  }
  return patterns;
}

module.exports = { detectPatterns, MIN_ATTEMPTED, MIN_TOPIC_ATTEMPTED };
