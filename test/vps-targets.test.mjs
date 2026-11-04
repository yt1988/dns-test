// server/watch/targets.json (what the VPS watcher probes) is generated from src/resolvers.mjs and must be current.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { targetsJSON, targetsFile } from "../scripts/vps-targets.mjs";

test("server/watch/targets.json matches src/resolvers.mjs (node scripts/vps-targets.mjs)", () => {
  assert.equal(readFileSync(targetsFile, "utf8"), targetsJSON());
});
