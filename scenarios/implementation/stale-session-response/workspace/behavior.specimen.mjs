import assert from "node:assert/strict";
import test from "node:test";
import { createController } from "./controller.mjs";

test("loads private data during the active session", async () => {
  const controller = createController({ loadPrivateData: async () => ({ invoices: 2 }) });
  await controller.load();
  assert.deepEqual(controller.state.data, { invoices: 2 });
});

test("ignores a response that resolves after logout", async () => {
  let resolveRequest;
  const response = new Promise((resolve) => { resolveRequest = resolve; });
  const controller = createController({ loadPrivateData: () => response });
  const pending = controller.load();
  controller.logout();
  resolveRequest({ invoices: 2 });
  await pending;
  assert.equal(controller.state.data, null);
});
