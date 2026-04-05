(function () {
  window.AceIIIT = window.AceIIIT || {};

  window.AceIIIT.seed = {
    meta: {
      name: "AceIIIT Mock Portal",
      version: 1,
      adminEmail: "aceiiit.official@gmail.com",
      adminPassword: "umnamotherboard",
      studentAccessCode: "ACEIIIT-ENROLLED"
    },
    tests: [
      {
        id: "mock-01",
        title: "AceIIIT UGEE Pattern Mock 01",
        subtitle: "Pattern-aligned SUPR + REAP simulation",
        durationMinutes: 180,
        sectionDurations: {
          SUPR: 60,
          REAP: 120
        },
        status: "live",
        questionIds: [
          "SUPR-001",
          "SUPR-002",
          "SUPR-003",
          "SUPR-004",
          "SUPR-005",
          "SUPR-006",
          "SUPR-007",
          "SUPR-008",
          "REAP-001",
          "REAP-002",
          "REAP-003",
          "REAP-004"
        ],
        instructions: [
          "This paper has two sections: SUPR and REAP.",
          "Every question carries +4 for a correct answer and -1 for a wrong answer.",
          "Use Mark for Review when you want to come back later.",
          "Answers are saved instantly when you select an option or move across questions.",
          "The timer continues even if you reload the page on the same device.",
          "Submit before the timer ends. If the timer reaches zero, the test auto-submits."
        ],
        benchmarkScores: [
          11, 15, 19, 20, 22, 22, 23, 24, 25, 25, 27, 27, 28, 28, 29, 30, 30,
          31, 31, 32, 33, 34, 35, 35, 36, 36, 37, 38, 39, 40, 41, 43
        ]
      }
    ],
    questions: [
      {
        id: "SUPR-001",
        section: "SUPR",
        topic: "patterns",
        difficulty: "easy",
        prompt: "In the sequence 3, 8, 15, 24, 35, ?, what should come next?",
        options: ["46", "48", "50", "52"],
        correctOption: 1,
        explanation: "The differences are 5, 7, 9, 11, so the next difference is 13. Hence 35 + 13 = 48.",
        marks: 4,
        negativeMarks: -1
      },
      {
        id: "SUPR-002",
        section: "SUPR",
        topic: "logic",
        difficulty: "medium",
        prompt: "Five students A, B, C, D, and E stand in a row. B is to the immediate right of D. A is not at an end. C is somewhere left of A. E is at the right end. Who stands in the middle?",
        options: ["A", "B", "C", "D"],
        correctOption: 0,
        explanation: "E must be fifth. D and B must appear as D-B. Since C is left of A and A is not at an end, the valid row is C D A B E.",
        marks: 4,
        negativeMarks: -1
      },
      {
        id: "SUPR-003",
        section: "SUPR",
        topic: "quant",
        difficulty: "easy",
        prompt: "A train crosses a platform in 36 seconds and a pole in 24 seconds. If the train speed is constant, the platform length is what fraction of the train length?",
        options: ["1/2", "2/3", "3/4", "1"],
        correctOption: 0,
        explanation: "In 24 seconds the train covers only its own length. In 36 seconds it covers train + platform. So train + platform = 36/24 = 1.5 times the train length. Hence platform length = 0.5 times the train length.",
        marks: 4,
        negativeMarks: -1
      },
      {
        id: "SUPR-004",
        section: "SUPR",
        topic: "coding",
        difficulty: "medium",
        prompt: "If MANGO is coded by adding alphabet positions, what is the code for PEAR?",
        options: ["34", "36", "38", "40"],
        correctOption: 3,
        explanation: "P = 16, E = 5, A = 1, R = 18. Total = 16 + 5 + 1 + 18 = 40.",
        marks: 4,
        negativeMarks: -1
      },
      {
        id: "SUPR-005",
        section: "SUPR",
        topic: "data",
        difficulty: "medium",
        prompt: "Runs scored by four players are P = 40, Q = 60, R = 30, and S = 70. What percent of the total runs were scored by Q and R together?",
        options: ["40%", "45%", "50%", "55%"],
        correctOption: 1,
        explanation: "Total = 40 + 60 + 30 + 70 = 200. Q + R = 90. So the share is 90/200 = 45%.",
        marks: 4,
        negativeMarks: -1
      },
      {
        id: "SUPR-006",
        section: "SUPR",
        topic: "reasoning",
        difficulty: "hard",
        prompt: "All roses are flowers. Some flowers fade quickly. No object that fades quickly can be preserved fresh for a week. Which conclusion is definitely true?",
        options: [
          "No rose can be preserved fresh for a week.",
          "Some flowers cannot be preserved fresh for a week.",
          "All flowers fade quickly.",
          "Some roses fade quickly."
        ],
        correctOption: 1,
        explanation: "Since some flowers fade quickly and nothing that fades quickly can stay fresh for a week, at least some flowers cannot be preserved fresh for a week.",
        marks: 4,
        negativeMarks: -1
      },
      {
        id: "SUPR-007",
        section: "SUPR",
        topic: "quant",
        difficulty: "hard",
        prompt: "A tank is filled by pipe A in 12 hours and emptied by pipe B in 18 hours. Both pipes are opened together for 3 hours, then B is closed. How long from the start will the tank be completely filled?",
        options: ["11 hours", "12 hours", "14 hours", "15 hours"],
        correctOption: 2,
        explanation: "Net rate with both open = 1/12 - 1/18 = 1/36. In 3 hours, filled = 3/36 = 1/12. Remaining = 11/12. Pipe A alone fills 1/12 per hour, so it takes 11 more hours. Total = 14 hours.",
        marks: 4,
        negativeMarks: -1
      },
      {
        id: "SUPR-008",
        section: "SUPR",
        topic: "reasoning",
        difficulty: "easy",
        prompt: "Find the odd one out.",
        options: ["Triangle", "Square", "Pentagon", "Circle"],
        correctOption: 3,
        explanation: "Triangle, square, and pentagon are polygons with straight sides. Circle has no sides and is the odd one out.",
        marks: 4,
        negativeMarks: -1
      },
      {
        id: "REAP-001",
        section: "REAP",
        topic: "comprehension",
        difficulty: "medium",
        passage: "A student group tests a low-cost water filter using sand, charcoal, and cotton. The filter reduces visible impurities but does not remove dissolved salts. In repeated trials, the filtered water looks clearer each time, yet conductivity readings remain almost unchanged.",
        prompt: "Which statement is best supported by the passage?",
        options: [
          "The filter removes both suspended particles and dissolved salts.",
          "Clarity alone is not enough to judge purification quality.",
          "Conductivity decreases only when charcoal is absent.",
          "The water is safe to drink because it looks clear."
        ],
        correctOption: 1,
        explanation: "The passage distinguishes visible clarity from conductivity, showing that appearance alone does not confirm complete purification.",
        marks: 4,
        negativeMarks: -1
      },
      {
        id: "REAP-002",
        section: "REAP",
        topic: "scientific reasoning",
        difficulty: "medium",
        passage: "A researcher grows identical plants under red, blue, and white light while keeping soil, water, and temperature constant. The plants under blue light develop shorter stems but darker leaves.",
        prompt: "Which is the most reasonable next step if the researcher wants to know whether light color caused the change in stem length?",
        options: [
          "Repeat the experiment with more plants in each group.",
          "Increase water only for the red-light group.",
          "Use different soil types in all groups.",
          "Measure only leaf width in the next trial."
        ],
        correctOption: 0,
        explanation: "Repeating with a larger sample helps test whether the observed difference is consistent while preserving the original controls.",
        marks: 4,
        negativeMarks: -1
      },
      {
        id: "REAP-003",
        section: "REAP",
        topic: "data",
        difficulty: "hard",
        passage: "Four sensor readings were recorded over one hour: 18, 18, 19, 47. The team suspects one reading is an outlier caused by a loose connection.",
        prompt: "Which action is the best first response?",
        options: [
          "Discard 47 immediately and report the average of the rest.",
          "Check the connection and repeat the measurement before concluding.",
          "Assume 47 is correct because larger values are more informative.",
          "Replace every reading with the median and stop further testing."
        ],
        correctOption: 1,
        explanation: "A suspected outlier should be investigated with a repeat measurement before being removed from analysis.",
        marks: 4,
        negativeMarks: -1
      },
      {
        id: "REAP-004",
        section: "REAP",
        topic: "analysis",
        difficulty: "hard",
        passage: "Two study methods are compared. Group X gets weekly quizzes. Group Y gets a single revision class at the end. Group X scores higher, but several students in Group Y missed the final class because of rain.",
        prompt: "Why is it difficult to conclude that weekly quizzes alone caused the higher score?",
        options: [
          "Because rain introduced an extra factor affecting Group Y.",
          "Because quizzes are always better than revision classes.",
          "Because the groups used the same teacher.",
          "Because final scores never reflect learning."
        ],
        correctOption: 0,
        explanation: "The missed final class creates a confounding factor, so the score gap cannot be attributed only to quizzes.",
        marks: 4,
        negativeMarks: -1
      }
    ]
  };
})();
