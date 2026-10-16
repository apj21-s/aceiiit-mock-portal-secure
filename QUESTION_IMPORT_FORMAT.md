# Question import format (Excel / CSV)

This is the exact format Studio → **Import from Excel/CSV** accepts (Questions Studio or Question Bank tab). Give this whole file to any AI agent together with your question-paper PDF. It is enough for the agent to produce a file that imports cleanly.

The import never guesses. Each cell becomes the question exactly as written. Every row is checked before anything is saved: required cells, options, the answer letter, image links, and every formula, rendered with KaTeX, the engine students see. Problems are shown per row number. Rows with errors are skipped. Nothing is saved until you press **Import N questions**.

---

## 1. File

| Rule | Value |
|---|---|
| File type | `.xlsx` (first sheet, or a sheet named `Questions`) **or** `.csv` |
| CSV encoding | UTF-8 (a BOM is fine). Comma-separated. Standard quoting (see §5) |
| Header row | Exactly one, in the first non-empty row. Column order doesn't matter |
| Rows | One question per row, at most **500** rows per file |
| Size | At most 5 MB |
| Blank rows | Ignored |
| Extra columns | Ignored. Use them for notes (see §7) |

The safest start is the template: Studio → Import from Excel/CSV → **Template (.xlsx)** or **Template (.csv)**. In the `.xlsx` template every cell is plain text, so Excel won't turn `1/2` into a date or `=…` into a formula. It also has dropdowns for section, difficulty and answer.

---

## 2. Columns

Header names are case-insensitive. Spaces and dashes count as `_` (so `Option A`, `option-a` and `option_a` are all accepted).

| Column | Required | What to put | Accepted values |
|---|---|---|---|
| `section` | **yes** | UGEE section | `SUPR` or `REAP` (any case) |
| `topic` | **yes** | Short topic name; groups questions for practice and analysis | Text, max 80 characters, e.g. `Kinematics`, `Probability`, `Reading comprehension` |
| `difficulty` | no | | `easy`, `medium`, `hard`. Blank means `medium` |
| `question` | **yes** | The question text, without its number (`Q12.`, `12)`) | Text, maths allowed (§4), line breaks allowed |
| `option_a` | **yes** | Option A text, without the `(A)` / `A.` label | Text, maths allowed |
| `option_b` | **yes** | Option B text | Text, maths allowed |
| `option_c` … `option_f` | no | More options | Filled in order: no gaps (C can't be empty if D is filled) |
| `answer` | **yes** | The correct option | One letter `A`–`F`, or `1`–`6`. Must be one of the filled options |
| `marks` | no | Marks for a correct answer | Number. Blank means the section default: **SUPR 1, REAP 2** |
| `negative_marks` | no | Marks for a wrong answer | Negative number, e.g. `-0.25`. Blank means the default: **SUPR −0.25, REAP −0.5** |
| `explanation` | no | Solution shown in the review after the test | Text, maths allowed |
| `passage` | no | Shared passage or data for a group of questions (REAP comprehension, a data table) | Text, maths allowed. Repeat the **same passage on every question** of that group |
| `image_urls` | no | Images for the question | `https://` links, several separated by `\|`. Leave blank if you have none: images can be added later in Studio |

Also accepted as header names: `subject`/`sec` → section; `prompt`/`question_text`/`q` → question; `correct`/`correct_answer`/`correct_option`/`key`/`ans` → answer; `level` → difficulty; `solution` → explanation; `negative`/`neg_marks`/`minus` → negative_marks; `mark`/`positive_marks` → marks; `opt_a`/`choice_a`/`a` → option_a; `image`/`images`/`image_url` → image_urls.

**SUPR vs REAP (UGEE):** SUPR is *Subject Proficiency*: mathematics, physics, chemistry. REAP is *Research Aptitude*: reasoning, comprehension, puzzles, general aptitude. A full paper has **40 SUPR + 50 REAP** questions. The preview warns if a test would go over that.

**Only single-correct multiple choice is supported** (2–6 options, exactly one correct). Numeric-answer or multi-correct questions can't be imported this way (§7).

---

## 3. Errors and warnings in the preview

**Errors** (the row is skipped):
- empty `section` / `topic` / `question` / `answer`;
- section isn't SUPR/REAP; difficulty isn't easy/medium/hard;
- fewer than 2 options; an option filled after an empty one;
- the answer isn't one of the filled options;
- marks that aren't numbers;
- an image link not starting with `https://`;
- a formula KaTeX can't render; a `$` without its closing `$`.

**Warnings** (the row is still imported):
- the same question is already in the question bank;
- the same question appears twice in the file;
- the target test would exceed 40 SUPR / 50 REAP.

---

## 4. Maths (LaTeX)

| Where | Write | Shows as |
|---|---|---|
| Inside a sentence | `$\frac{1}{2}mv^2$` | inline formula |
| On its own line | `$$\int_0^1 x^2\,dx$$` or `\[ \int_0^1 x^2\,dx \]` | display formula |
| Also accepted | `\( … \)`, `\begin{align} … \end{align}` (and `equation`, `gather`) | |
| A real dollar sign | `\$5` | $5 |

Rules:
- Every `$` must have its partner. `Cost is $5` is an **error**; write `Cost is \$5`.
- Use KaTeX-supported commands (nearly all of standard LaTeX maths): `\frac`, `\sqrt`, `\int`, `\sum`, `\lim`, `\vec`, `\hat`, `\overline`, `\begin{pmatrix}…\end{pmatrix}`, `\begin{cases}…\end{cases}`, `\mathrm`, `\text{…}`, Greek letters, `\le`, `\ge`, `\ne`, `\pm`, `\times`, `\cdot`, `\infty`, `\rightarrow` …
- No custom macros (`\newcommand`) and no packages. Write `\mathrm{d}x` rather than a custom `\dd`.
- Chemistry: write formulas with subscripts in maths, e.g. `$\mathrm{H_2SO_4}$`, `$\mathrm{CO_2}$`. Reactions: `$\mathrm{2H_2 + O_2 \rightarrow 2H_2O}$`.
- Units: `$9.8\ \mathrm{m/s^2}$` or plain text `9.8 m/s²`. Both are fine.
- Plain Unicode (², √, π, ≤) is allowed outside `$…$`, but LaTeX looks better and is checked.
- Write only what the paper says: don't add maths that isn't in the original.

---

## 5. CSV quoting (only for .csv)

- A cell containing a comma, a double quote or a line break must be wrapped in double quotes: `"Find x, if x > 0"`.
- A double quote inside a quoted cell is doubled: `"He said ""stop"""`.
- Line breaks inside a quoted cell are kept (useful for passages and multi-line explanations).
- Backslashes need **no** escaping in CSV: write `$\frac{1}{2}$` as is.

---

## 6. Example

As a table (Excel):

| section | topic | difficulty | question | option_a | option_b | option_c | option_d | answer | marks | negative_marks | explanation | passage |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SUPR | Kinematics | medium | A ball of mass $m$ moves with speed $v$. Its kinetic energy is | $mv$ | $\frac{1}{2}mv^2$ | $mv^2$ | $2mv^2$ | B | | | Kinetic energy is $\frac{1}{2}mv^2$. | |
| SUPR | Calculus | hard | Evaluate $\displaystyle\int_0^{1} x e^{x}\,dx$ | $0$ | $1$ | $e-1$ | $e$ | B | | | Integrate by parts: $[xe^x - e^x]_0^1 = 1$. | |
| REAP | Logical reasoning | easy | Which number comes next: 2, 6, 12, 20, ? | 28 | 30 | 32 | 36 | B | | | The differences grow by 2: +4, +6, +8, +10. | |
| REAP | Reading comprehension | medium | According to the passage, why did the trial stop early? | Cost | Safety | Weather | Funding | B | | | | The trial began in 2019… (full passage) |

The same rows as CSV:

```csv
section,topic,difficulty,question,option_a,option_b,option_c,option_d,answer,marks,negative_marks,explanation,passage
SUPR,Kinematics,medium,A ball of mass $m$ moves with speed $v$. Its kinetic energy is,$mv$,$\frac{1}{2}mv^2$,$mv^2$,$2mv^2$,B,,,Kinetic energy is $\frac{1}{2}mv^2$.,
SUPR,Calculus,hard,"Evaluate $\displaystyle\int_0^{1} x e^{x}\,dx$",$0$,$1$,$e-1$,$e$,B,,,"Integrate by parts: $[xe^x - e^x]_0^1 = 1$.",
REAP,Logical reasoning,easy,"Which number comes next: 2, 6, 12, 20, ?",28,30,32,36,B,,,"The differences grow by 2: +4, +6, +8, +10.",
REAP,Reading comprehension,medium,"According to the passage, why did the trial stop early?",Cost,Safety,Weather,Funding,B,,,,"The trial began in 2019…"
```

---

## 7. Instructions for an AI agent converting a PDF

Paste this section, with the rest of this file, into the agent along with the PDF.

> Convert every multiple-choice question in the attached PDF into one row of a CSV (UTF-8) or .xlsx file that follows the format above exactly. Header row:
> `section,topic,difficulty,question,option_a,option_b,option_c,option_d,option_e,option_f,answer,marks,negative_marks,explanation,passage,image_urls,notes`
>
> 1. **Copy text exactly.** Don't reword, shorten, correct or translate. Remove only the question number (`Q12.`, `12)`) and option labels (`(A)`, `a.`, `1)`).
> 2. **Maths:** write every formula in LaTeX inside `$…$` (or `$$…$$` for a formula on its own line), using only KaTeX-supported commands. Every `$` must be paired; a literal dollar is `\$`. Check that each formula would compile.
> 3. **section:** `SUPR` for mathematics, physics or chemistry; `REAP` for reasoning, comprehension, puzzles and aptitude. If the PDF names the section, use that.
> 4. **topic:** a short standard name (e.g. `Kinematics`, `Probability`, `Organic chemistry`, `Blood relations`, `Reading comprehension`). Use the same spelling for the same topic every time.
> 5. **answer:** take it **only** from the answer key or solution in the PDF. **Never guess or solve to fill it.** If the PDF gives no answer, leave `answer` blank and write `no answer key` in `notes` (the row will show an error so the admin can fill it).
> 6. **difficulty:** only if the PDF states it; otherwise leave blank (it becomes `medium`).
> 7. **marks / negative_marks:** only if the PDF states marking for that question that differs from SUPR +1/−0.25, REAP +2/−0.5; otherwise blank.
> 8. **explanation:** the PDF's solution if it has one, maths in LaTeX; otherwise blank.
> 9. **passage:** for a group of questions sharing a passage, table or data set, put the full shared text in `passage` on **each** question of the group. Keep paragraph breaks as line breaks.
> 10. **Figures and diagrams:** you can't embed images. Leave `image_urls` blank and write `needs figure: page N` in `notes`. If the question can't be understood without the figure, still include it. If an option is itself a figure, write `(figure)` as the option text and note it.
> 11. **Not importable:** numeric-answer (integer type), multi-correct or match-the-column questions without a single-letter answer. Don't put these in the file; list them at the end of your reply with their page numbers.
> 12. **notes** is ignored by the import. Use it for anything the admin should check (unclear scan, doubtful symbol, figure needed). Leave it blank when all is fine.
> 13. Keep the PDF's order. At most 500 rows per file; split larger papers into several files.
> 14. For CSV, quote any cell that contains a comma, a double quote or a line break, and double any `"` inside it. Don't escape backslashes.
> 15. At the end, report: total rows, rows per section, and every row number that has a note.

---

## 8. After the agent's file arrives

1. Studio → **Questions Studio** (to add the questions to the selected test) or **Question Bank** (bank only) → **Import from Excel/CSV**.
2. Choose the file → **Check sheet**. Review the preview. Every formula is drawn exactly as students will see it, with the correct option marked.
3. Fix any error rows in the sheet and check it again, or import the ready rows now.
4. **Import N questions** saves all ready rows at once, in sheet order, and attaches them to the test if you chose one.
5. Add any figures (rows noted `needs figure`) in Studio → edit question → images.
