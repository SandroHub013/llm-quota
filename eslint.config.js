import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * A deliberately narrow lint config. The point is not style — the project already
 * reads consistently — it is the class of bug a reviewer cannot see: a promise
 * nobody waits for. `no-floating-promises` needs type information, which is why
 * `projectService` is on.
 *
 * That type information is also what pins TypeScript. typescript-eslint refuses to
 * load under TS 7.0 ("typescript-eslint does not support TS 7.0"), so bumping the
 * compiler ahead of it trades every type-aware rule here for a linter that will not
 * start. Support is tracked at typescript-eslint/typescript-eslint#10940; until it
 * lands, a TypeScript major has to be verified against `bun run lint`, not just
 * against `tsc --noEmit`, which passes fine on its own.
 *
 * The rules here are errors on purpose. If one of them starts complaining, fix the
 * cause; suppressing it with a disable comment puts back exactly the silence this
 * config exists to remove.
 */
export default tseslint.config(
  {
    ignores: ["node_modules/**", "docs/**", "public/bklit-ui/**"],
  },

  // Type-aware rules, TypeScript sources only.
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.base],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The reason this config exists. A promise nobody awaits fails in silence:
      // the rejection lands in an unhandled-rejection handler nobody installed,
      // and the caller carries on as if the work had succeeded — the same class of
      // bug as an empty catch, one layer up.
      "@typescript-eslint/no-floating-promises": "error",
      // Its counterpart: an async function passed where a sync one is expected has
      // its rejection dropped by the caller that never looks at the returned promise.
      "@typescript-eslint/no-misused-promises": "error",
      // `await` on a plain value is almost always a promise that was forgotten
      // somewhere upstream.
      "@typescript-eslint/await-thenable": "error",
      // Reject `catch {}` and `catch { /* nothing */ }`: an error that is genuinely
      // ignorable still has to say so out loud. This is the audit's rule.
      "no-empty": ["error", { allowEmptyCatch: false }],

      // Off for TypeScript only: tsc already reports every undefined identifier, and
      // it is the one that knows about the Bun and Node ambient types. Leaving this
      // on would report `Response`, `URL` and `Bun` as undefined in correct code —
      // noise that trains people to ignore the linter.
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],

      // Deliberately not the full recommendedTypeChecked preset. This codebase
      // parses JSON written by seven other tools, so `any` at the parse boundary is
      // intentional and pervasive; making it an error would buy nothing but a field
      // of eslint-disable comments, which is the trade this config refuses to make.
      // It stays a visible warning instead.
      "@typescript-eslint/no-explicit-any": "warn",
      // Stripping ANSI colour from a child process's stderr means matching ESC by
      // definition, so this rule has nothing to offer here beyond noise. It stays a
      // warning rather than an inline disable, so a genuinely accidental control
      // character somewhere else still shows up.
      "no-control-regex": "warn",
    },
  },

  // The browser bundle is plain JavaScript with no tsconfig behind it, so it gets
  // the untyped rules only.
  {
    files: ["public/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: false }],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
);
