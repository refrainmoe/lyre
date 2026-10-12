import { describe, expect, it } from "vitest";
import { parseLyreJson } from "../src/index.js";

describe("parseLyreJson", () => {
  it("returns ordinary parsed JSON and permits the same key in separate objects", () => {
    expect(parseLyreJson('{"id":"outer","nested":{"id":"inner"}}')).toEqual({
      id: "outer",
      nested: { id: "inner" },
    });
  });

  it("rejects duplicate object members at any nesting depth", () => {
    expect(() => parseLyreJson('{"nested":{"id":1,"id":2}}', "rig.json")).toThrow(
      /rig\.json contains duplicate JSON object member "id"/,
    );
  });

  it("compares decoded member names rather than their source spelling", () => {
    expect(() => parseLyreJson('{"id":1,"\\u0069d":2}')).toThrow(
      /duplicate JSON object member "id"/,
    );
  });
});
