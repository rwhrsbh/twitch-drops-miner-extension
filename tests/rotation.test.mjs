// node --test tests/rotation.test.mjs — «нечего фармить» для ротации: кейс-эфир не фарм.
import test from "node:test";
import assert from "node:assert/strict";

globalThis.chrome = {
  storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} } },
};

const rotation = await import("../lib/rotation.js");

test("ротация: обычные фазы простоя", () => {
  for (const phase of ["all-claimed", "no-channel", "pick-game", "no-campaign", "not-linked"]) {
    assert.equal(rotation.isIdle({ phase }), true, phase);
  }
  assert.equal(rotation.isIdle({ phase: "watching", watching: { dropId: "r1" } }), false);
  assert.equal(rotation.isIdle({ phase: "watching", watching: { solo: true } }), false, "соло — это не простой");
});

test("ротация: эфир «на кейс» — простой, а не фарм", () => {
  assert.equal(rotation.isIdle({ phase: "watching", watching: { case: true } }), true);
  assert.equal(rotation.isIdle(null), false);
});
