import test from "node:test";
import assert from "node:assert/strict";

import {
  isSanDiegoBased,
  SAN_DIEGO_WORKFORCE_UPDATES,
  sanDiegoWorkforceEmailLines
} from "../src/pierce-san-diego-updates.mjs";

test("recognizes San Diego County guest locations", () => {
  assert.equal(isSanDiegoBased("San Diego, California"), true);
  assert.equal(isSanDiegoBased("Carlsbad, CA"), true);
  assert.equal(isSanDiegoBased("Los Angeles, CA"), false);
  assert.equal(isSanDiegoBased(""), false);
});

test("adds the official optional signup link only for San Diego guests", () => {
  const lines = sanDiegoWorkforceEmailLines("San Diego");
  assert.ok(lines.includes(`Choose the updates you want: ${SAN_DIEGO_WORKFORCE_UPDATES.url}`));
  assert.ok(lines.some((line) => line.includes("will not subscribe you automatically")));
  assert.deepEqual(sanDiegoWorkforceEmailLines("Oakland"), []);
});
