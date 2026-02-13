import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveStatus } from "./status.js";

describe("deriveStatus", () => {
  const STUCK_MS = 15 * 60 * 1000;
  const young = new Date(Date.now() - 60_000).toISOString(); // 1 min old
  const old = new Date(Date.now() - STUCK_MS - 60_000).toISOString(); // 16 min old

  it("BUILDING → starting", () => {
    assert.equal(deriveStatus({ deployStatus: "BUILDING", createdAt: young }), "starting");
  });

  it("DEPLOYING → starting", () => {
    assert.equal(deriveStatus({ deployStatus: "DEPLOYING", createdAt: young }), "starting");
  });

  it("QUEUED → starting", () => {
    assert.equal(deriveStatus({ deployStatus: "QUEUED", createdAt: young }), "starting");
  });

  it("WAITING → starting", () => {
    assert.equal(deriveStatus({ deployStatus: "WAITING", createdAt: young }), "starting");
  });

  it("FAILED → dead", () => {
    assert.equal(deriveStatus({ deployStatus: "FAILED", createdAt: young }), "dead");
  });

  it("CRASHED → dead", () => {
    assert.equal(deriveStatus({ deployStatus: "CRASHED", createdAt: young }), "dead");
  });

  it("REMOVED → dead", () => {
    assert.equal(deriveStatus({ deployStatus: "REMOVED", createdAt: young }), "dead");
  });

  it("SKIPPED → dead", () => {
    assert.equal(deriveStatus({ deployStatus: "SKIPPED", createdAt: young }), "dead");
  });

  it("SLEEPING → sleeping", () => {
    assert.equal(deriveStatus({ deployStatus: "SLEEPING", createdAt: young }), "sleeping");
  });

  it("SUCCESS + healthy + no conversation → idle", () => {
    assert.equal(deriveStatus({ deployStatus: "SUCCESS", healthCheck: { ready: true, conversation: null } }), "idle");
  });

  it("SUCCESS + healthy + has conversation → claimed", () => {
    assert.equal(deriveStatus({ deployStatus: "SUCCESS", healthCheck: { ready: true, conversation: "conv-123" } }), "claimed");
  });

  it("SUCCESS + unreachable + young → starting", () => {
    assert.equal(deriveStatus({ deployStatus: "SUCCESS", healthCheck: null, createdAt: young }), "starting");
  });

  it("SUCCESS + unreachable + old → dead", () => {
    assert.equal(deriveStatus({ deployStatus: "SUCCESS", healthCheck: null, createdAt: old }), "dead");
  });

  it("null deploy status + young → starting", () => {
    assert.equal(deriveStatus({ deployStatus: null, createdAt: young }), "starting");
  });
});
