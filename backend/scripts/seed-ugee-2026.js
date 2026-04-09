const path = require("path");
const dotenv = require("dotenv");
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const { connectDb } = require("../config/db");
const Question = require("../models/Question");
const Test = require("../models/Test");

async function main() {
  await connectDb(process.env.MONGODB_URI);

  await Promise.all([Question.deleteMany({}), Test.deleteMany({})]);

  const questions = await Question.insertMany([
    {
      section: "SUPR",
      topic: "patterns",
      difficulty: "easy",
      prompt: "In the sequence 3, 8, 15, 24, 35, ?, what should come next?",
      options: ["46", "48", "50", "52"],
      correctOption: 1,
      explanation: "Differences are 5,7,9,11 so next is 13.",
      marks: 4,
      negativeMarks: -1,
    },
    {
      section: "REAP",
      topic: "comprehension",
      difficulty: "medium",
      passage:
        "A student group tests a low-cost water filter. The filter reduces visible impurities but does not remove dissolved salts.",
      prompt: "Which statement is best supported?",
      options: [
        "The filter removes salts.",
        "Clarity alone is not enough to judge purification quality.",
        "Conductivity drops only without charcoal.",
        "Clear water is always safe.",
      ],
      correctOption: 1,
      explanation: "Appearance does not confirm dissolved impurities are removed.",
      marks: 4,
      negativeMarks: -1,
    },
  ]);

  const test1 = await Test.create({
    title: "UGEE 2026 Mock Test 1 (Free)",
    subtitle: "Pattern-aligned SUPR + REAP simulation",
    series: "UGEE 2026",
    type: "practice",
    isFree: true,
    status: "live",
    sectionDurations: { SUPR: 60, REAP: 120 },
    durationMinutes: 180,
    instructions: [
      "This paper has two sections: SUPR and REAP.",
      "Negative marking applies per question.",
      "SUPR locks after its timer ends, then REAP starts automatically.",
      "Submit before time ends (auto-submit on timeout).",
    ],
    questionIds: questions.map((q) => q._id),
  });

  await Test.create([
    { title: "UGEE 2026 Mock Test 2 (Free)", subtitle: "Free mock", series: "UGEE 2026", type: "practice", isFree: true, status: "live" },
    { title: "UGEE 2026 Mock Test 3 (Paid)", subtitle: "Paid mock", series: "UGEE 2026", type: "practice", isFree: false, status: "live" },
    { title: "UGEE 2026 Mock Test 4 (Paid)", subtitle: "Paid mock", series: "UGEE 2026", type: "practice", isFree: false, status: "live" },
    { title: "UGEE 2026 Mock Test 5 (Paid)", subtitle: "Paid mock", series: "UGEE 2026", type: "practice", isFree: false, status: "live" },
    { title: "UGEE 2026 Mock Test 6 (Paid)", subtitle: "Paid mock", series: "UGEE 2026", type: "practice", isFree: false, status: "live" },
  ]);

  // eslint-disable-next-line no-console
  console.log("Seeded UGEE 2026 series. Example test:", test1.id);
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
