function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function ensureSectionBucket(buckets, key) {
  if (!buckets[key]) {
    buckets[key] = {
      key,
      score: 0,
      correct: 0,
      wrong: 0,
      skipped: 0,
      attempted: 0,
      total: 0,
      accuracy: 0,
      completion: 0,
      timeSpent: 0,
      avgTimePerAttempted: 0,
    };
  }
  return buckets[key];
}

function ensureTopicBucket(buckets, section, topic) {
  const topicKey = String(topic || "General").trim() || "General";
  const compoundKey = `${section}:${topicKey}`;
  if (!buckets[compoundKey]) {
    buckets[compoundKey] = {
      key: compoundKey,
      topic: topicKey,
      section,
      score: 0,
      correct: 0,
      wrong: 0,
      skipped: 0,
      attempted: 0,
      total: 0,
      accuracy: 0,
      completion: 0,
      timeSpent: 0,
      avgTimePerAttempted: 0,
    };
  }
  return buckets[compoundKey];
}

function finalizeBucket(bucket) {
  bucket.attempted = Number(bucket.correct || 0) + Number(bucket.wrong || 0);
  bucket.total = bucket.attempted + Number(bucket.skipped || 0);
  bucket.accuracy = bucket.attempted ? round((Number(bucket.correct || 0) / bucket.attempted) * 100) : 0;
  bucket.completion = bucket.total ? round((bucket.attempted / bucket.total) * 100) : 0;
  bucket.avgTimePerAttempted = bucket.attempted ? round(Number(bucket.timeSpent || 0) / bucket.attempted) : 0;
  return bucket;
}

function mapQuestionReview(question, section, topic, selectedOption, isCorrect, status, timeSpent, marks, negativeMarks) {
  return {
    questionId: String(question.id),
    section,
    topic,
    prompt: question.prompt || "",
    passage: question.passage || "",
    imageUrls: Array.isArray(question.imageUrls) ? question.imageUrls : [],
    options: Array.isArray(question.options) ? question.options : [],
    explanation: question.explanation || "",
    marks,
    negativeMarks,
    selectedOption,
    correctOption: Number(question.correctOption),
    isCorrect,
    status,
    timeSpent,
  };
}

function evaluateAttempt({ test, questions, answers, timeSpent }) {
  const answerMap = answers || {};
  const timeSpentMap = timeSpent || {};

  const sectionScores = {
    SUPR: { score: 0, correct: 0, wrong: 0, skipped: 0 },
    REAP: { score: 0, correct: 0, wrong: 0, skipped: 0 },
  };

  const sectionWise = {
    SUPR: ensureSectionBucket({}, "SUPR"),
    REAP: ensureSectionBucket({}, "REAP"),
  };
  const topicBuckets = {};
  const questionReview = [];
  const answerDetails = [];

  let score = 0;
  let correctCount = 0;
  let wrongCount = 0;
  let skippedCount = 0;
  let trackedTimeSpent = 0;

  for (const question of questions) {
    const questionId = String(question.id);
    const section = question.section === "REAP" ? "REAP" : "SUPR";
    const topic = String(question.topic || "General").trim() || "General";
    const marks = Number.isFinite(Number(question.marks)) ? Number(question.marks) : 4;
    const negativeMarks = Number.isFinite(Number(question.negativeMarks))
      ? Number(question.negativeMarks)
      : Number.isFinite(Number(test.negativeMarks))
        ? Number(test.negativeMarks)
        : -1;
    const selected = answerMap[questionId];
    const hasSelection = !(selected === undefined || selected === null || selected === "");
    const timeSpentSeconds = Math.max(0, Number(timeSpentMap[questionId] || 0));

    trackedTimeSpent += timeSpentSeconds;
    sectionWise[section].timeSpent += timeSpentSeconds;

    const topicBucket = ensureTopicBucket(topicBuckets, section, topic);
    topicBucket.timeSpent += timeSpentSeconds;

    let status = "skipped";
    let isCorrect = false;

    if (!hasSelection) {
      skippedCount += 1;
      sectionScores[section].skipped += 1;
      sectionWise[section].skipped += 1;
      topicBucket.skipped += 1;
    } else if (Number(selected) === Number(question.correctOption)) {
      status = "correct";
      isCorrect = true;
      score += marks;
      correctCount += 1;
      sectionScores[section].correct += 1;
      sectionScores[section].score += marks;
      sectionWise[section].correct += 1;
      sectionWise[section].score += marks;
      topicBucket.correct += 1;
      topicBucket.score += marks;
    } else {
      status = "wrong";
      score += negativeMarks;
      wrongCount += 1;
      sectionScores[section].wrong += 1;
      sectionScores[section].score += negativeMarks;
      sectionWise[section].wrong += 1;
      sectionWise[section].score += negativeMarks;
      topicBucket.wrong += 1;
      topicBucket.score += negativeMarks;
    }

    questionReview.push(
      mapQuestionReview(
        question,
        section,
        topic,
        hasSelection ? Number(selected) : null,
        isCorrect,
        status,
        timeSpentSeconds,
        marks,
        negativeMarks
      )
    );

    answerDetails.push({
      questionId,
      selectedOption: hasSelection ? Number(selected) : null,
      isCorrect,
      timeSpent: timeSpentSeconds,
    });
  }

  const attempted = correctCount + wrongCount;
  const accuracy = attempted ? (correctCount / attempted) * 100 : 0;

  Object.keys(sectionWise).forEach((key) => finalizeBucket(sectionWise[key]));
  // Weighted priority: topics that hurt your score the most, scaled by sample size.
  // Priority = marksLost + (timeSpentOnWrong / 30) - (0.5 × marksGained)
  // This surfaces topics where you attempted, spent time, but still got wrong answers.
  // Single-question topics are demoted because accuracy is unreliable with n=1.
  function computeTopicPriority(bucket) {
    const marksLost = Math.max(0, -Number(bucket.score || 0)); // positive when score is negative
    const marksGained = Math.max(0, Number(bucket.score || 0));
    const timeOnWrong = Number(bucket.wrong || 0) > 0
      ? (Number(bucket.timeSpent || 0) / Math.max(1, Number(bucket.wrong || 0)))
      : 0;
    // Reliability penalty: n=1 topics get half weight
    const reliabilityFactor = Number(bucket.total || 0) <= 1 ? 0.5 : 1;
    return reliabilityFactor * (
      marksLost * 2          // penalise mark loss heavily
      + (timeOnWrong / 30)   // time wasted per wrong answer (normalised)
      - marksGained * 0.5    // reward marks already captured (reduce priority for strong topics)
    );
  }

  // Annotate each finalized topic with priority + tag before sorting
  const topicWise = Object.values(topicBuckets)
    .map((bucket) => {
      finalizeBucket(bucket);
      bucket.priority = round(computeTopicPriority(bucket), 3);
      // Derive a tag that explains WHY this topic is prioritised
      if (Number(bucket.total || 0) <= 1) {
        bucket.tag = "1 question";
      } else if (Number(bucket.attempted || 0) === 0) {
        bucket.tag = "fully skipped";
      } else if (Number(bucket.accuracy || 0) === 0) {
        bucket.tag = "no correct answers";
      } else if (Number(bucket.accuracy || 0) < 40) {
        bucket.tag = "weak accuracy";
      } else if (Number(bucket.accuracy || 0) < 60) {
        bucket.tag = "below par";
      } else if (Number(bucket.accuracy || 0) >= 80) {
        bucket.tag = "strong";
      } else {
        bucket.tag = "needs work";
      }
      return bucket;
    })
    .sort((a, b) => {
      // Primary: highest priority (most impactful to fix) first
      if (Number(b.priority || 0) !== Number(a.priority || 0)) {
        return Number(b.priority || 0) - Number(a.priority || 0);
      }
      // Secondary: lower accuracy first
      if (Number(a.accuracy || 0) !== Number(b.accuracy || 0)) {
        return Number(a.accuracy || 0) - Number(b.accuracy || 0);
      }
      return String(a.topic || "").localeCompare(String(b.topic || ""));
    });

  return {
    score,
    accuracy,
    correctCount,
    wrongCount,
    skippedCount,
    unattemptedCount: skippedCount,
    sectionScores,
    sectionWise,
    topicWise,
    questionReview,
    answerDetails,
    totalTrackedTimeSeconds: Math.round(trackedTimeSpent),
  };
}

module.exports = { evaluateAttempt };
