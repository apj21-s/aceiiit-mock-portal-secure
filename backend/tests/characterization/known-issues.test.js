// M0 pinned today's known defects here as executable assertions. Each one was flipped into
// a regression test by the milestone that fixed it (see AGENT_HANDOFF §14):
//   mock_google_ login → tests/security/oauth.test.js        (M1)
//   backend source served → tests/security/static.test.js    (M1)
//   internal API default secret → tests/payments/entitlements.test.js (M3)
//   QOTD always 404 → tests/features/qotd.test.js           (M4)
// Pin any newly discovered defect here before fixing it.
describe("KNOWN DEFECT baseline", () => {
  test("no known defects remain pinned", () => {
    expect(true).toBe(true);
  });
});
