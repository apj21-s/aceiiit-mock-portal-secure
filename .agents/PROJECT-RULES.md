# AceIIIT Mock Portal — Agent Engineering Rules

## Mandatory Skill Usage

Before making ANY UI, UX, accessibility, animation, responsive,
visual, component, or frontend architecture change:

1. Inspect the relevant skill(s) under `.agents/skills/`.
2. Read the applicable `SKILL.md`.
3. Apply the skill's rules during planning AND implementation.
4. Do not invent alternative patterns when the installed skill already
   provides guidance for the problem.
5. At the end of the task, explicitly report which skills were used
   and which rules/principles were applied.

## Skill Selection

### General UI / UX
Use:
- `.agents/skills/improve-ui/SKILL.md`
- `.agents/skills/emil-design-eng/SKILL.md`

### Accessibility
Use:
- `.agents/skills/fixing-accessibility/SKILL.md`

### Animation
Use:
- `.agents/skills/animate/SKILL.md`
- `.agents/skills/animation-vocabulary/SKILL.md`
- `.agents/skills/find-animation-opportunities/SKILL.md`

### Existing Animation Review
Use:
- `.agents/skills/review-animations/SKILL.md`
- `.agents/skills/improve-animations/SKILL.md`

### Motion Performance
Use:
- `.agents/skills/fixing-motion-performance/SKILL.md`

### Responsive / Visual Baseline
Use:
- `.agents/skills/baseline-ui/SKILL.md`

### Accessibility / Metadata
Use:
- `.agents/skills/fixing-accessibility/SKILL.md`
- `.agents/skills/fixing-metadata/SKILL.md`

### UI Library Decisions
Use:
- `.agents/skills/pick-ui-library/SKILL.md`

## Existing Product Constraints

The following must not be changed unless explicitly requested:

- Exam scoring logic
- Timer logic
- Answer persistence
- Attempt persistence
- Submission logic
- SUPR / REAP behavior
- Existing authentication behavior
- Existing backend contracts
- KaTeX rendering behavior

UI improvements must preserve existing product functionality.

## Required Workflow

For every task:

### Phase 1 — Inspect
Understand the existing implementation before editing.

### Phase 2 — Skill Review
Identify and read every relevant skill.

### Phase 3 — Plan
Explain:
- current problem
- relevant skill principles
- proposed solution
- files/functions affected
- regression risks

### Phase 4 — Implement
Make the smallest safe change necessary.

### Phase 5 — Verify
Check:
- desktop
- tablet
- mobile
- keyboard
- accessibility
- dark mode
- reduced motion where applicable
- console/runtime errors
- existing functionality

### Phase 6 — Skill Compliance Report

Finish with:

Skills used:
- ...
- ...

Principles applied:
- ...
- ...

Verification:
- ...

Regression status:
- ...

Do not claim a skill was used unless its contents were actually inspected.