function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function buildRecommendations({ accuracy, topicWise, weakSection, timePressure, fastButErrorProne, completionRate }) {
  const recommendations = [];

  if (accuracy < 55) {
    recommendations.push("Avoid guessing on low-confidence questions. Protect marks by eliminating options first and skipping sooner.");
  }
  if (weakSection && weakSection.total > 0) {
    recommendations.push(`Revise ${weakSection.key} with timed mixed sets. Your accuracy there is lagging behind the rest of the paper.`);
  }
  if (completionRate < 85) {
    recommendations.push("Your paper coverage can improve. Clear easy questions in the first pass and return only for marked problems.");
  }
  if (fastButErrorProne) {
    recommendations.push("You are moving fast but leaking marks. Slow down on calculation-heavy questions and recheck selected options before moving on.");
  } else if (timePressure) {
    recommendations.push("Your average pace is slightly slow. Use a strict first pass to reserve end-game time for flagged questions.");
  }

  // Use the highest-priority, reliably-sampled weak topic
  const weakTopic = (topicWise || []).find((t) => Number(t.total || 0) >= 2 && Number(t.attempted || 0) > 0);
  if (weakTopic) {
    const tag = weakTopic.tag || "";
    if (tag === "no correct answers") {
      recommendations.push(`You scored 0% on ${weakTopic.topic} (${weakTopic.section}) — zero correct answers from ${weakTopic.attempted} attempts. Revisit the fundamentals of this topic before attempting more questions.`);
    } else if (tag === "fully skipped") {
      recommendations.push(`${weakTopic.topic} (${weakTopic.section}) was completely skipped. Attempt at least the easiest questions here — unattempted questions guarantee zero marks.`);
    } else if (tag === "weak accuracy" || tag === "below par") {
      recommendations.push(`Revise ${weakTopic.topic} (${weakTopic.section}) next — ${weakTopic.accuracy}% accuracy with ${weakTopic.wrong} wrong answers. This is the highest-impact topic to fix.`);
    } else {
      recommendations.push(`Revise ${weakTopic.topic} (${weakTopic.section}) next. It is the weakest topic block in this attempt.`);
    }
  }

  return recommendations.slice(0, 4);
}

function buildInsightChips({ accuracy, fastButErrorProne, weakTopic, completionRate }) {
  const chips = [];
  if (accuracy < 55) chips.push("Accuracy risk");
  if (completionRate < 85) chips.push("Coverage gap");
  if (fastButErrorProne) chips.push("High speed, high error");
  if (weakTopic) chips.push(`Revise ${weakTopic.topic}`);
  return chips.slice(0, 4);
}

function buildAttemptAnalysis({ test, questions, evalResult, answers, timeTakenSeconds }) {
  const totalQuestions = Array.isArray(questions) ? questions.length : 0;
  const attemptedCount = Number(evalResult.correctCount || 0) + Number(evalResult.wrongCount || 0);
  const totalMarks = (questions || []).reduce((sum, question) => sum + Number(question.marks || 0), 0);
  const completionRate = totalQuestions ? (attemptedCount / totalQuestions) * 100 : 0;
  const accuracy = Number(evalResult.accuracy || 0);
  const scorePercentage = totalMarks ? (Number(evalResult.score || 0) / totalMarks) * 100 : 0;
  const totalDurationSeconds = Math.max(
    0,
    Number(timeTakenSeconds || evalResult.totalTrackedTimeSeconds || 0)
  );
  const avgSecondsPerQuestion = totalQuestions ? totalDurationSeconds / totalQuestions : 0;
  const avgSecondsPerAttempted = attemptedCount ? totalDurationSeconds / attemptedCount : 0;
  const targetSecondsPerQuestion = totalQuestions
    ? ((Number(test.durationMinutes || 0) * 60) || totalDurationSeconds || 0) / totalQuestions
    : 0;
  const sectionInsights = Object.values(evalResult.sectionWise || {});
  // Take top 10 topics; they're already sorted by priority (highest impact first)
  const topicInsights = (evalResult.topicWise || []).slice(0, 10);
  const strongSection = sectionInsights.slice().sort((a, b) => b.accuracy - a.accuracy)[0] || null;
  const weakSection = sectionInsights.slice().sort((a, b) => a.accuracy - b.accuracy)[0] || null;
  // Best weak topic: reliable sample (>=2 questions), at least 1 attempted, highest priority
  const weakTopic =
    topicInsights.find((t) => Number(t.total || 0) >= 2 && Number(t.attempted || 0) > 0) ||
    topicInsights.find((t) => Number(t.attempted || 0) > 0) ||
    topicInsights[0] ||
    null;
  const fastButErrorProne = avgSecondsPerAttempted > 0 && avgSecondsPerAttempted < targetSecondsPerQuestion * 0.85 && accuracy < 60;
  const timePressure = avgSecondsPerAttempted > targetSecondsPerQuestion * 1.15;

  const benchmarks = Array.isArray(test.benchmarkScores) ? test.benchmarkScores.slice().sort((a, b) => a - b) : [];
  const nextBenchmark = benchmarks.find((score) => Number(score) > Number(evalResult.score || 0)) || null;
  const answerCount = answers ? Object.keys(answers).length : 0;

  return {
    totalQuestions,
    attemptedCount,
    answeredCount: answerCount,
    completionRate: round(completionRate),
    scorePercentage: round(scorePercentage),
    avgSecondsPerQuestion: round(avgSecondsPerQuestion),
    avgSecondsPerAttempted: round(avgSecondsPerAttempted),
    targetSecondsPerQuestion: round(targetSecondsPerQuestion),
    paceLabel:
      avgSecondsPerAttempted && targetSecondsPerQuestion
        ? fastButErrorProne
          ? "Fast but error-prone"
          : avgSecondsPerAttempted <= targetSecondsPerQuestion
            ? "On pace"
            : avgSecondsPerAttempted <= targetSecondsPerQuestion * 1.2
              ? "Slightly slow"
              : "Needs faster first pass"
        : "Balanced",
    scoreLabel:
      scorePercentage >= 75 ? "Excellent" : scorePercentage >= 55 ? "Competitive" : scorePercentage >= 35 ? "Recoverable" : "Needs work",
    strongSection: strongSection
      ? { key: strongSection.key, accuracy: strongSection.accuracy, score: strongSection.score, timeSpent: strongSection.timeSpent }
      : null,
    weakSection: weakSection
      ? { key: weakSection.key, accuracy: weakSection.accuracy, score: weakSection.score, timeSpent: weakSection.timeSpent }
      : null,
    sectionInsights,
    topicInsights,
    timeAnalysis: {
      totalTimeSeconds: Math.round(totalDurationSeconds),
      trackedTimeSeconds: Math.round(Number(evalResult.totalTrackedTimeSeconds || 0)),
      avgSecondsPerQuestion: round(avgSecondsPerQuestion),
      avgSecondsPerAttempted: round(avgSecondsPerAttempted),
      targetSecondsPerQuestion: round(targetSecondsPerQuestion),
      timePressure,
      fastButErrorProne,
    },
    smartInsights: buildInsightChips({
      accuracy,
      fastButErrorProne,
      weakTopic,
      completionRate,
    }),
    nextBenchmark,
    benchmarkGap: nextBenchmark === null ? 0 : round(Number(nextBenchmark) - Number(evalResult.score || 0)),
    recommendations: buildRecommendations({
      accuracy,
      topicWise: topicInsights,
      weakSection,
      timePressure,
      fastButErrorProne,
      completionRate,
    }),
  };
}

module.exports = { buildAttemptAnalysis };
