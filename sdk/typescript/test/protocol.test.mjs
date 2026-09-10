import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  PROTOCOL_VERSION,
  SDK_VERSION,
  WEBSOCKET_SUBPROTOCOL,
  validateClientEnvelope,
  validateServerEnvelope,
} from "../dist/cormier-realtime.js";

const fixturePath = resolve(import.meta.dirname, "../../../protocol/fixtures/v1/envelopes.json");
const fixtures = JSON.parse(await readFile(fixturePath, "utf8"));
const fixtureNow = new Date("2026-08-30T17:00:30.000Z");

test("language-neutral fixtures match the exported protocol identity", () => {
  assert.equal(fixtures.protocolVersion, PROTOCOL_VERSION);
  assert.equal(fixtures.subprotocol, WEBSOCKET_SUBPROTOCOL);
  assert.equal(SDK_VERSION, "0.1.0");
});

test("all golden client and server envelopes validate", () => {
  for (const envelope of fixtures.validClientEnvelopes) {
    assert.deepEqual(validateClientEnvelope(envelope, fixtureNow), { valid: true, value: envelope });
  }
  for (const envelope of fixtures.validServerEnvelopes) {
    assert.deepEqual(validateServerEnvelope(envelope), { valid: true, value: envelope });
  }
});

test("invalid fixture expectations remain stable", () => {
  for (const fixture of fixtures.invalidEnvelopes) {
    const result = validateClientEnvelope(fixture.value, fixtureNow);
    assert.equal(result.valid, false, fixture.name);
    assert.equal(result.errorCode, fixture.errorCode, fixture.name);
  }
});

test("unknown optional server fields are accepted", () => {
  const envelope = {
    ...fixtures.validServerEnvelopes[0],
    futureOptionalField: { enabled: true },
  };
  assert.equal(validateServerEnvelope(envelope).valid, true);
});

test("malformed reconnect advice is rejected", () => {
  const base = fixtures.validServerEnvelopes.find((envelope) => envelope.type === "service.restart");
  for (const reconnect of [
    { initialDelayMilliseconds: -1, maximumDelayMilliseconds: 10, jitterRatio: 0, reauthenticate: true },
    { initialDelayMilliseconds: 20, maximumDelayMilliseconds: 10, jitterRatio: 0, reauthenticate: true },
    { initialDelayMilliseconds: 1, maximumDelayMilliseconds: 10, jitterRatio: 2, reauthenticate: true },
    { initialDelayMilliseconds: 1, maximumDelayMilliseconds: 2_147_483_648, jitterRatio: 0, reauthenticate: true },
    { initialDelayMilliseconds: 1, maximumDelayMilliseconds: 10, jitterRatio: 0, reauthenticate: "yes" },
  ]) {
    const result = validateServerEnvelope({ ...base, reconnect });
    assert.equal(result.valid, false);
    assert.equal(result.errorCode, "invalid_envelope");
  }
});
