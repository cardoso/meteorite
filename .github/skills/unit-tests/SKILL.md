---
name: unit-tests
description: 'Create unit tests from implementation code in this Vitest TypeScript repository. Use when asked to add tests, improve coverage, or validate behavior with focused .spec.ts files.'
argument-hint: 'Target module path, behavior, or symbol to test'
user-invocable: true
disable-model-invocation: false
---

# Unit Tests

Create or extend focused unit tests for this repository using Vitest.

## When to Use
- A user asks to add tests for new or existing behavior.
- A bug fix needs regression coverage.
- A module has weak edge-case coverage and needs hardening.

## Inputs
- Target implementation file or symbol.
- Expected behavior and edge cases.
- Any constraints (mock style, runtime assumptions, performance bounds).

## Procedure
1. Locate target code and existing tests.
2. Determine test location:
   - Always colocate tests with implementation.
   - If a neighboring `*.spec.ts` exists, extend it.
   - If none exists, create a new `*.spec.ts` beside the implementation file.
3. Build a behavior matrix:
   - Happy-path behavior.
   - Invalid input or error paths.
   - Boundary and special-case behavior.
4. Choose test style and dependencies:
   - Keep tests deterministic and isolated.
   - Mock external state (network, clock, randomness, storage) only when required.
   - Prefer direct assertions on observable outputs and side effects.
5. Implement tests with clear case names describing expected behavior.
6. Run focused tests first:
   - `pnpm test -- <path-to-spec-file>`
7. If focused tests pass, run broader validation:
   - `pnpm test`
8. If tests fail, branch by failure type:
   - Assertion mismatch: confirm expected behavior from implementation and requirements, then adjust test or implementation.
   - Flaky timing/randomness: stabilize with controlled clocks/seeds/mocks.
   - Environment dependency: isolate global state and reset between tests.
9. Final quality pass:
   - Allow small, safe implementation refactors when they improve testability without changing public behavior.
   - Remove duplicated setup.
   - Keep each test tied to one behavior.
   - Ensure regression cases cover recently fixed bugs.

## Completion Checks
- New/updated tests fail before the behavioral change when applicable and pass after.
- Focused and full test runs complete successfully (`pnpm test -- <file>` and `pnpm test`).
- Test names are behavior-oriented and readable.
- Edge and error cases are covered, not only happy paths.
- Coverage is judged by meaningful behavior coverage, not numeric thresholds.
- No unnecessary coupling to implementation internals.

## Output
- Added or updated `*.spec.ts` tests.
- Short summary of covered behaviors, any mocks used, and test execution results.
