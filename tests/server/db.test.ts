import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../src/server/db.js";

describe("database migrations", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("records the schema version and preserves data when reopened", () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-panel-db-"));
    const filename = path.join(directory, "nexus.db");

    const first = new Store(filename);
    first.createGroup({ name: "Core", slug: "core" });
    first.db.close();

    const reopened = new Store(filename);
    expect(reopened.db.pragma("user_version", { simple: true })).toBe(1);
    expect(reopened.listGroups().map((group) => group.slug)).toEqual(["core"]);
    reopened.db.close();
  });
});
