const ExcelJS = require("exceljs");
const katex = require("katex");

// Bulk question import (Studio → Import from Excel/CSV). A sheet has one question per row;
// nothing is guessed: each cell becomes the question exactly as typed. Every row is checked
// (required cells, options, answer, image links, and every formula is rendered with KaTeX, the
// same engine students see) and problems are reported by row number before anything is saved.

const MAX_ROWS = 500;
const OPTION_LETTERS = ["A", "B", "C", "D", "E", "F"];
const SECTION_LIMITS = { SUPR: 40, REAP: 50 };

const COLUMNS = [
  { key: "section", header: "section", width: 10, help: "SUPR or REAP." },
  { key: "topic", header: "topic", width: 22, help: "Topic name, e.g. Kinematics. Topics group questions for practice and analysis." },
  { key: "difficulty", header: "difficulty", width: 12, help: "easy, medium or hard (blank = medium)." },
  { key: "question", header: "question", width: 60, help: "The question. Maths in $...$ (inline) or $$...$$ / \\[...\\] (display), e.g. $\\frac{1}{2}mv^2$." },
  ...OPTION_LETTERS.map((l, i) => ({ key: `option_${l.toLowerCase()}`, header: `option_${l.toLowerCase()}`, width: 24, help: i < 2 ? `Option ${l} (required).` : `Option ${l} (optional).` })),
  { key: "answer", header: "answer", width: 9, help: "The correct option letter: A, B, C, D, E or F." },
  { key: "marks", header: "marks", width: 8, help: "Marks for a correct answer (blank = section default: SUPR 1, REAP 2)." },
  { key: "negative_marks", header: "negative_marks", width: 15, help: "Marks for a wrong answer, e.g. -0.25 (blank = section default: SUPR -0.25, REAP -0.5)." },
  { key: "explanation", header: "explanation", width: 40, help: "Shown in the review after the test (optional). Maths allowed." },
  { key: "passage", header: "passage", width: 40, help: "A shared passage for REAP comprehension questions (optional)." },
  { key: "image_urls", header: "image_urls", width: 30, help: "Optional https image links, separated by |. You can also add images later in Studio." },
];

const EXAMPLES = [
  {
    section: "SUPR", topic: "Kinematics", difficulty: "medium",
    question: "A ball of mass $m$ moves with speed $v$. Its kinetic energy is",
    option_a: "$mv$", option_b: "$\\frac{1}{2}mv^2$", option_c: "$mv^2$", option_d: "$2mv^2$",
    answer: "B", marks: "", negative_marks: "", explanation: "Kinetic energy is $\\frac{1}{2}mv^2$.",
  },
  {
    section: "REAP", topic: "Logical reasoning", difficulty: "easy",
    question: "Which number comes next: 2, 6, 12, 20, ?",
    option_a: "28", option_b: "30", option_c: "32", option_d: "36",
    answer: "B", explanation: "The differences grow by 2: +4, +6, +8, +10.",
  },
];

const HEADER_ALIASES = {
  subject: "section", sec: "section",
  question_text: "question", prompt: "question", q: "question",
  correct: "answer", correct_answer: "answer", correct_option: "answer", key: "answer", ans: "answer",
  level: "difficulty",
  negative: "negative_marks", negative_mark: "negative_marks", neg_marks: "negative_marks", minus: "negative_marks",
  mark: "marks", positive_marks: "marks",
  solution: "explanation",
  images: "image_urls", image: "image_urls", image_url: "image_urls",
};

function normalizeHeader(value) {
  const key = String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const option = /^(?:option|opt|choice)_?([a-f])$/.exec(key) || /^([a-f])$/.exec(key);
  if (option) return `option_${option[1]}`;
  return HEADER_ALIASES[key] || key;
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------
async function buildTemplate(format) {
  if (format === "csv") {
    const lines = [COLUMNS.map((c) => c.header).join(",")].concat(EXAMPLES.map((ex) => COLUMNS.map((c) => csvCell(ex[c.key] || "")).join(",")));
    return { buffer: Buffer.from("\ufeff" + lines.join("\r\n") + "\r\n", "utf8"), type: "text/csv; charset=utf-8", name: "aceiiit-questions-template.csv" };
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = "AceIIIT Mock Portal";
  const ws = wb.addWorksheet("Questions", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width, style: { numFmt: "@" } }));
  ws.getRow(1).font = { bold: true };
  EXAMPLES.forEach((ex) => ws.addRow(ex));
  // Plain text everywhere (so Excel never turns "=..." into a formula or "1/2" into a date)
  // and dropdowns where only a few values are allowed.
  const lists = { section: '"SUPR,REAP"', difficulty: '"easy,medium,hard"', answer: '"A,B,C,D,E,F"' };
  COLUMNS.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.numFmt = "@";
    if (lists[c.key]) {
      for (let r = 2; r <= MAX_ROWS + 1; r += 1) {
        ws.getCell(r, i + 1).dataValidation = { type: "list", allowBlank: true, formulae: [lists[c.key]] };
      }
    }
  });
  const help = wb.addWorksheet("How to fill");
  help.columns = [{ header: "column", key: "column", width: 18 }, { header: "what to put", key: "help", width: 110 }];
  help.getRow(1).font = { bold: true };
  COLUMNS.forEach((c) => help.addRow({ column: c.header, help: c.help }));
  help.addRow({});
  help.addRow({ column: "Maths", help: "Use $...$ inside text, $$...$$ or \\[...\\] for a display line. Everything KaTeX supports works (\\frac, \\sqrt, \\int, matrices...)." });
  help.addRow({ column: "Limits", help: `Up to ${MAX_ROWS} questions per file. A full UGEE paper has ${SECTION_LIMITS.SUPR} SUPR and ${SECTION_LIMITS.REAP} REAP questions.` });
  help.addRow({ column: "Save as", help: "Upload this .xlsx as it is, or save as \"CSV UTF-8\". From Google Sheets: File → Download → .xlsx or .csv." });
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name: "aceiiit-questions-template.xlsx" };
}

function csvCell(value) {
  const text = String(value === null || value === undefined ? "" : value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
/** RFC 4180 CSV: quoted cells, doubled quotes, commas and newlines inside quotes, BOM. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const src = String(text || "").replace(/^\ufeff/, "");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("");
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    if (value instanceof Date) return value.toISOString();
    return "";
  }
  return String(value);
}

async function readTable(buffer, filename) {
  const name = String(filename || "").toLowerCase();
  if (name.endsWith(".csv")) return parseCsv(buffer.toString("utf8"));
  if (!name.endsWith(".xlsx")) throw inputError("Upload an .xlsx or .csv file (use the template).");
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer);
  } catch (_err) {
    throw inputError("That file couldn't be read as an Excel workbook. Save it as .xlsx or CSV UTF-8 and try again.");
  }
  const ws = wb.getWorksheet("Questions") || wb.worksheets[0];
  if (!ws) throw inputError("The workbook has no sheets.");
  const rows = [];
  const width = ws.columnCount;
  ws.eachRow({ includeEmpty: true }, (row, number) => {
    const cells = [];
    for (let c = 1; c <= width; c += 1) cells.push(cellText(row.getCell(c).value));
    rows[number - 1] = cells;
  });
  return Array.from(rows, (r) => r || []);
}

function inputError(message) {
  return Object.assign(new Error(message), { status: 400, expose: true, code: "IMPORT_INVALID" });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(\\begin\{(equation|align|alignat|gather|CD)\*?\}[\s\S]+?\\end\{\5\*?\})|(?<!\\)\$([^$]+?)(?<!\\)\$/g;

/** KaTeX-checks every formula in a text; returns error messages (empty when all render). */
function mathErrors(text) {
  const errors = [];
  const src = String(text || "");
  let rest = src;
  let m;
  MATH_RE.lastIndex = 0;
  while ((m = MATH_RE.exec(src))) {
    const display = m[1] !== undefined || m[2] !== undefined || m[4] !== undefined;
    const expr = m[1] || m[2] || m[3] || m[4] || m[6] || "";
    try {
      katex.renderToString(expr, { throwOnError: true, displayMode: display, strict: "ignore" });
    } catch (err) {
      errors.push(`formula "${trim(m[0], 40)}": ${String(err.message || err).replace(/^KaTeX parse error:\s*/, "")}`);
    }
    rest = rest.replace(m[0], "");
  }
  const stray = (rest.replace(/\\\$/g, "").match(/\$/g) || []).length;
  if (stray) errors.push("a $ without its closing $ (maths must be wrapped in a pair, e.g. $x^2$)");
  return errors;
}

function trim(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function numberOrBlank(value, label, errors) {
  const text = String(value || "").trim();
  if (!text) return undefined;
  const n = Number(text);
  if (!Number.isFinite(n) || Math.abs(n) > 100) {
    errors.push(`${label} must be a number (got "${trim(text, 12)}")`);
    return undefined;
  }
  return n;
}

/**
 * One sheet row (or a previewed question sent back for import) → { question, errors }.
 * `cells` is keyed by column key.
 */
function validateCells(cells) {
  const errors = [];
  const get = (k) => String(cells[k] === undefined || cells[k] === null ? "" : cells[k]).trim();
  const section = get("section").toUpperCase();
  if (section !== "SUPR" && section !== "REAP") errors.push(section ? `section must be SUPR or REAP (got "${trim(section, 12)}")` : "section is empty");
  const topic = get("topic");
  if (!topic) errors.push("topic is empty");
  else if (topic.length > 80) errors.push("topic is longer than 80 characters");
  const difficultyRaw = get("difficulty").toLowerCase();
  const difficulty = difficultyRaw || "medium";
  if (!["easy", "medium", "hard"].includes(difficulty)) errors.push(`difficulty must be easy, medium or hard (got "${trim(difficultyRaw, 12)}")`);
  const prompt = get("question");
  if (!prompt) errors.push("question is empty");
  const letters = [];
  const options = [];
  OPTION_LETTERS.forEach((letter) => {
    const value = get(`option_${letter.toLowerCase()}`);
    if (value) {
      if (letters.length !== OPTION_LETTERS.indexOf(letter)) errors.push(`option ${letter} is filled but an earlier option is empty`);
      letters.push(letter);
      options.push(value);
    }
  });
  if (options.length < 2) errors.push("needs at least 2 options (option_a and option_b)");
  const answerRaw = get("answer").toUpperCase().replace(/^OPTION\s*/, "");
  let correctOption = -1;
  if (/^[A-F]$/.test(answerRaw)) correctOption = OPTION_LETTERS.indexOf(answerRaw);
  else if (/^[1-6]$/.test(answerRaw)) correctOption = Number(answerRaw) - 1;
  if (!answerRaw) errors.push("answer is empty");
  else if (correctOption < 0 || correctOption >= options.length) errors.push(`answer "${trim(answerRaw, 8)}" isn't one of the filled options (${letters.join(", ") || "none"})`);
  const marks = numberOrBlank(get("marks"), "marks", errors);
  const negativeMarks = numberOrBlank(get("negative_marks"), "negative_marks", errors);
  const explanation = get("explanation");
  const passage = get("passage");
  const imageUrls = get("image_urls") ? get("image_urls").split("|").map((u) => u.trim()).filter(Boolean) : [];
  imageUrls.forEach((url) => {
    if (!/^https:\/\/[^\s]+$/i.test(url)) errors.push(`image link "${trim(url, 30)}" must start with https://`);
  });
  [["question", prompt], ["explanation", explanation], ["passage", passage]].concat(options.map((o, i) => [`option ${letters[i]}`, o])).forEach(([label, text]) => {
    mathErrors(text).forEach((e) => errors.push(`${label}: ${e}`));
  });
  const question = {
    section, topic, difficulty, prompt, options, correctOption, explanation, passage, imageUrls,
    ...(marks !== undefined ? { marks } : {}),
    ...(negativeMarks !== undefined ? { negativeMarks } : {}),
  };
  return { question, errors };
}

/** A question object (from a preview) back into the cell shape, to re-validate on import. */
function questionToCells(q) {
  const cells = {
    section: q.section, topic: q.topic, difficulty: q.difficulty, question: q.prompt,
    answer: Number.isInteger(q.correctOption) ? OPTION_LETTERS[q.correctOption] || "" : "",
    marks: q.marks === undefined ? "" : String(q.marks),
    negative_marks: q.negativeMarks === undefined ? "" : String(q.negativeMarks),
    explanation: q.explanation || "", passage: q.passage || "",
    image_urls: Array.isArray(q.imageUrls) ? q.imageUrls.join("|") : "",
  };
  (Array.isArray(q.options) ? q.options : []).slice(0, OPTION_LETTERS.length).forEach((o, i) => { cells[`option_${OPTION_LETTERS[i].toLowerCase()}`] = o; });
  return cells;
}

function dedupeKey(q) {
  return [q.section, String(q.prompt || "").replace(/\s+/g, " ").trim().toLowerCase(), (q.options || []).map((o) => String(o).trim().toLowerCase()).join("|")].join("::");
}

/** Reads a sheet into validated rows. Saves nothing. */
async function previewRows(buffer, filename) {
  const table = await readTable(buffer, filename);
  const headerIndex = table.findIndex((r) => r.some((c) => String(c || "").trim()));
  if (headerIndex === -1) throw inputError("The file is empty.");
  const headers = table[headerIndex].map(normalizeHeader);
  const missing = ["section", "topic", "question", "option_a", "option_b", "answer"].filter((h) => !headers.includes(h));
  if (missing.length) throw inputError(`Missing column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. Download the template to see the expected columns.`);
  const rows = [];
  for (let i = headerIndex + 1; i < table.length; i += 1) {
    const raw = table[i] || [];
    if (!raw.some((c) => String(c || "").trim())) continue;
    const cells = {};
    headers.forEach((h, c) => { if (h) cells[h] = raw[c]; });
    const { question, errors } = validateCells(cells);
    rows.push({ row: i + 1, question, errors, warnings: [] });
    if (rows.length > MAX_ROWS) throw inputError(`Up to ${MAX_ROWS} questions per file. Split the sheet and import it in parts.`);
  }
  if (!rows.length) throw inputError("No questions found below the header row.");
  const seen = new Map();
  rows.forEach((r) => {
    if (r.errors.length) return;
    const key = dedupeKey(r.question);
    if (seen.has(key)) r.warnings.push(`same question as row ${seen.get(key)}`);
    else seen.set(key, r.row);
  });
  return rows;
}

module.exports = {
  MAX_ROWS,
  SECTION_LIMITS,
  COLUMNS,
  buildTemplate,
  previewRows,
  validateCells,
  questionToCells,
  dedupeKey,
  mathErrors,
  parseCsv,
};
