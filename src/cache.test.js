import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getAll, getByStatus, getCounts, set, remove, isBeingClaimed, startClaim, endClaim } from "./cache.js";

describe("cache", () => {
  beforeEach(() => {
    // Clear cache between tests
    for (const inst of getAll()) {
      remove(inst.serviceId);
    }
  });

  it("set and getAll", () => {
    set("svc-1", { serviceId: "svc-1", status: "idle", name: "convos-agent-abc", url: "https://abc.up.railway.app" });
    set("svc-2", { serviceId: "svc-2", status: "claimed", name: "convos-agent-trip", url: "https://trip.up.railway.app" });
    assert.equal(getAll().length, 2);
  });

  it("getByStatus filters correctly", () => {
    set("svc-1", { serviceId: "svc-1", status: "idle" });
    set("svc-2", { serviceId: "svc-2", status: "claimed" });
    set("svc-3", { serviceId: "svc-3", status: "starting" });
    assert.equal(getByStatus("idle").length, 1);
    assert.equal(getByStatus("claimed").length, 1);
  });

  it("getCounts returns all statuses", () => {
    set("svc-1", { serviceId: "svc-1", status: "idle" });
    set("svc-2", { serviceId: "svc-2", status: "idle" });
    set("svc-3", { serviceId: "svc-3", status: "claimed" });
    const counts = getCounts();
    assert.equal(counts.idle, 2);
    assert.equal(counts.claimed, 1);
    assert.equal(counts.starting, 0);
  });

  it("remove deletes entry", () => {
    set("svc-1", { serviceId: "svc-1", status: "idle" });
    remove("svc-1");
    assert.equal(getAll().length, 0);
  });

  it("claiming set prevents double-claim", () => {
    assert.equal(isBeingClaimed("svc-1"), false);
    startClaim("svc-1");
    assert.equal(isBeingClaimed("svc-1"), true);
    endClaim("svc-1");
    assert.equal(isBeingClaimed("svc-1"), false);
  });
});
