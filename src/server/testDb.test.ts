import { describe, expect, it } from "vitest";
import { assertDisposableDatabase, disposableDatabaseProblem } from "./testDb";

describe("disposable database guard", () => {
  it("accepts a local database named for tests", () => {
    expect(disposableDatabaseProblem("postgres://postgres@localhost:5432/strawvine_test", { env: {} })).toBeNull();
    expect(disposableDatabaseProblem("postgres://u:p@127.0.0.1/app_TEST_2", { env: {} })).toBeNull();
  });

  it("refuses other names, remote hosts outside CI, and garbage", () => {
    expect(() => assertDisposableDatabase("postgres://postgres@localhost:5432/strawvine", { env: {} })).toThrow(/"test" in its name/);
    expect(disposableDatabaseProblem("postgres://u@db.example.com/strawvine_test", { env: {} })).toMatch(/isn't local/);
    expect(disposableDatabaseProblem("postgres://u@db.example.com/strawvine_test", { env: { CI: "true" } })).toBeNull();
    expect(disposableDatabaseProblem("postgres://u@db.example.com/strawvine", { env: { CI: "true" } })).toMatch(/name/);
    expect(disposableDatabaseProblem("not a url", { env: {} })).toMatch(/valid/);
  });
});
