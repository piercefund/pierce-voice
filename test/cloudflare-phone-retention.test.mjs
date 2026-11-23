import assert from "node:assert/strict";
import test from "node:test";

import { PiercePhoneCall } from "../src/cloudflare-phone.mjs";

class MockDurableStorage {
  values = new Map();
  alarm = null;

  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
  async deleteAll() { this.values.clear(); this.alarm = null; }
  async getAlarm() { return this.alarm; }
  async setAlarm(value) { this.alarm = value; }
}

test("each call gets an isolated retention deadline no later than 24 hours", async () => {
  const firstStorage = new MockDurableStorage();
  const secondStorage = new MockDurableStorage();
  const first = new PiercePhoneCall({ storage: firstStorage }, {});
  const second = new PiercePhoneCall({ storage: secondStorage }, {});
  const before = Date.now();

  const firstDeadline = await first.ensureRetentionDeadline();
  const secondDeadline = await second.ensureRetentionDeadline();

  assert.ok(firstDeadline >= before);
  assert.ok(firstDeadline <= before + 24 * 60 * 60 * 1000 + 1000);
  assert.equal(firstStorage.alarm, firstDeadline);
  assert.equal(secondStorage.alarm, secondDeadline);
  assert.notEqual(firstStorage.values, secondStorage.values);

  const repeatedDeadline = await first.ensureRetentionDeadline();
  assert.equal(repeatedDeadline, firstDeadline, "retries must not extend the retention window");
});

test("hangup alarms preserve the 24-hour cleanup alarm", async () => {
  const storage = new MockDurableStorage();
  const call = new PiercePhoneCall({ storage }, {});
  const expiresAt = await call.ensureRetentionDeadline();
  const hangupAt = Date.now() - 1;

  await call.scheduleHangup(hangupAt);
  assert.equal(storage.alarm, hangupAt);
  await call.alarm();

  assert.equal(await storage.get("hangup_at"), undefined);
  assert.equal(storage.alarm, expiresAt);
});

test("the retention alarm deletes all temporary call state", async () => {
  const storage = new MockDurableStorage();
  const call = new PiercePhoneCall({ storage }, {});
  await storage.put("expires_at", Date.now() - 1);
  await storage.put("call_id", "call-private-state");
  await storage.put("pending_career_summary", { private: "temporary" });
  await storage.setAlarm(Date.now() - 1);

  await call.alarm();

  assert.equal(storage.values.size, 0);
  assert.equal(storage.alarm, null);
});
