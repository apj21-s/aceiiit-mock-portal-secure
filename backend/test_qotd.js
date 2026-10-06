require('dotenv').config();
const mongoose = require('mongoose');
const { getQuestionOfTheDay } = require('./services/testDataService');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to DB");
  const q = await getQuestionOfTheDay();
  console.log("QOTD:", q);
  process.exit(0);
}
run().catch(console.error);
