(function () {
  window.AceIIIT = window.AceIIIT || {};

  function round(value, digits) {
    var factor = Math.pow(10, digits || 0);
    return Math.round(value * factor) / factor;
  }

  function labelForDifficulty(value) {
    var map = {
      easy: "Easy",
      medium: "Medium",
      hard: "Hard"
    };

    return map[value] || value;
  }

  function createBucket() {
    return {
      attempted: 0,
      correct: 0,
      wrong: 0,
      score: 0
    };
  }

  function getRankInfo(score, peerScores, includeCurrentScore) {
    var scoreboard = peerScores.slice();
    if (includeCurrentScore !== false) {
      scoreboard.push(score);
    }
    scoreboard.sort(function (a, b) {
      return b - a;
    });

    var greaterCount = scoreboard.filter(function (item) {
      return item > score;
    }).length;
    var lowerCount = scoreboard.filter(function (item) {
      return item < score;
    }).length;

    return {
      rank: greaterCount + 1,
      percentile: scoreboard.length ? Math.round((lowerCount / scoreboard.length) * 100) : 0,
      cohortSize: scoreboard.length
    };
  }

  function buildInsights(context) {
    var insights = [];
    var weakTopics = context.topicStats.filter(function (topic) {
      return topic.attempted > 0 && topic.accuracy < 60;
    });
    var strongTopics = context.topicStats.filter(function (topic) {
      return topic.attempted > 0 && topic.accuracy >= 75;
    });

    if (weakTopics.length) {
      insights.push("Your weakest area right now is " + weakTopics[0].label + ". Build 2 to 3 timed sets around that topic before the next full mock.");
    }

    if (strongTopics.length) {
      insights.push("Your strongest zone was " + strongTopics[0].label + ". Keep that section sharp and avoid slowing down there.");
    }

    if (context.averageTimeWrong > context.averageTimeCorrect + 20) {
      insights.push("You are spending more time on wrong answers than on correct ones. That usually means overthinking medium and hard questions.");
    }

    if (context.unattemptedCount >= 3) {
      insights.push("You left " + context.unattemptedCount + " question(s) unattempted. Improve question selection so easy marks do not remain untouched.");
    }

    if (context.easyWrongCount >= 2) {
      insights.push("Easy questions are leaking marks. Do a quick first pass before going deep into traps.");
    }

    if (!insights.length) {
      insights.push("Your performance is balanced. Keep the same approach and increase difficulty on sectional practice.");
    }

    return insights.slice(0, 4);
  }

  function evaluateAttempt(payload) {
    var test = payload.test;
    var questions = payload.questions;
    var attempt = payload.attempt;
    var peerScores = payload.peerScores || [];
    var answers = attempt.answers || {};
    var timeSpent = attempt.timeSpent || {};
    var maxScore = 0;
    var score = 0;
    var correctCount = 0;
    var wrongCount = 0;
    var attemptedCount = 0;
    var easyWrongCount = 0;
    var correctTimes = [];
    var wrongTimes = [];
    var topicBuckets = {};
    var sectionBuckets = {
      SUPR: createBucket(),
      REAP: createBucket()
    };
    var review = [];

    questions.forEach(function (question) {
      var marks = Number.isFinite(Number(question.marks)) ? Number(question.marks) : 4;
      var negativeMarks = Number.isFinite(Number(question.negativeMarks)) ? Number(question.negativeMarks) : -1;
      var chosen = answers[question.id];
      var isAttempted = chosen !== undefined && chosen !== null && chosen !== "";
      var topicBucket = topicBuckets[question.topic] || createBucket();
      var sectionBucket = sectionBuckets[question.section] || createBucket();
      var spent = Number(timeSpent[question.id] || 0);

      maxScore += marks;

      if (isAttempted) {
        attemptedCount += 1;
        topicBucket.attempted += 1;
        sectionBucket.attempted += 1;

        if (String(chosen) === String(question.correctOption)) {
          score += marks;
          correctCount += 1;
          topicBucket.correct += 1;
          sectionBucket.correct += 1;
          topicBucket.score += marks;
          sectionBucket.score += marks;
          correctTimes.push(spent);
        } else {
          score += negativeMarks;
          wrongCount += 1;
          topicBucket.wrong += 1;
          sectionBucket.wrong += 1;
          topicBucket.score += negativeMarks;
          sectionBucket.score += negativeMarks;
          wrongTimes.push(spent);

          if (question.difficulty === "easy") {
            easyWrongCount += 1;
          }
        }
      }

      topicBuckets[question.topic] = topicBucket;
      sectionBuckets[question.section] = sectionBucket;

      review.push({
        id: question.id,
        section: question.section,
        topic: question.topic,
        difficulty: question.difficulty,
        difficultyLabel: labelForDifficulty(question.difficulty),
        prompt: question.prompt,
        passage: question.passage || "",
        imageUrls: Array.isArray(question.imageUrls)
          ? question.imageUrls.slice()
          : (question.imageUrl ? [question.imageUrl] : []),
        imageUrl: question.imageUrl || "",
        options: question.options.slice(),
        chosenOption: isAttempted ? Number(chosen) : null,
        chosenLabel: isAttempted ? question.options[Number(chosen)] : "Not attempted",
        correctOption: question.correctOption,
        correctLabel: question.options[question.correctOption],
        isCorrect: isAttempted && Number(chosen) === Number(question.correctOption),
        timeSpent: spent,
        explanation: question.explanation
      });
    });

    var unattemptedCount = questions.length - attemptedCount;
    var accuracy = attemptedCount ? round((correctCount / attemptedCount) * 100, 1) : 0;
    var topicStats = Object.keys(topicBuckets).map(function (topic) {
      var bucket = topicBuckets[topic];
      return {
        key: topic,
        label: topic.toUpperCase(),
        attempted: bucket.attempted,
        correct: bucket.correct,
        wrong: bucket.wrong,
        score: round(bucket.score, 2),
        accuracy: bucket.attempted ? round((bucket.correct / bucket.attempted) * 100, 1) : 0
      };
    });
    var sectionStats = Object.keys(sectionBuckets).map(function (sectionKey) {
      var bucket = sectionBuckets[sectionKey];
      return {
        key: sectionKey,
        label: sectionKey,
        attempted: bucket.attempted,
        correct: bucket.correct,
        wrong: bucket.wrong,
        score: round(bucket.score, 2),
        accuracy: bucket.attempted ? round((bucket.correct / bucket.attempted) * 100, 1) : 0
      };
    });
    var averageTimeCorrect = correctTimes.length
      ? round(correctTimes.reduce(function (sum, value) { return sum + value; }, 0) / correctTimes.length, 1)
      : 0;
    var averageTimeWrong = wrongTimes.length
      ? round(wrongTimes.reduce(function (sum, value) { return sum + value; }, 0) / wrongTimes.length, 1)
      : 0;
    var rankInfo = getRankInfo(score, peerScores, payload.includeCurrentScore);
    var insights = buildInsights({
      topicStats: topicStats,
      averageTimeCorrect: averageTimeCorrect,
      averageTimeWrong: averageTimeWrong,
      unattemptedCount: unattemptedCount,
      easyWrongCount: easyWrongCount
    });

    return {
      testId: test.id,
      score: round(score, 2),
      maxScore: round(maxScore, 2),
      correctCount: correctCount,
      wrongCount: wrongCount,
      attemptedCount: attemptedCount,
      unattemptedCount: unattemptedCount,
      accuracy: accuracy,
      rank: rankInfo.rank,
      percentile: rankInfo.percentile,
      cohortSize: rankInfo.cohortSize,
      averageTimeCorrect: averageTimeCorrect,
      averageTimeWrong: averageTimeWrong,
      topicStats: topicStats,
      sectionStats: sectionStats,
      insights: insights,
      review: review
    };
  }

  window.AceIIIT.analytics = {
    evaluateAttempt: evaluateAttempt,
    round: round
  };
})();
