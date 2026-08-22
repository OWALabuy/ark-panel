import test from "node:test";
import assert from "node:assert/strict";
import { compatibleGenerationRequestFingerprintMatcherVersion, currentGenerationRequestFingerprintMatcherVersion,
  generationRequestFingerprint, generationRequestFingerprintMatches, generationRequestFingerprintMatchesVersion,
  type GenerationRequestIdentity } from "../src/domain/generation-request.js";

test("generation request fingerprint 保持既有 durable golden vectors", () => {
  assert.equal(generationRequestFingerprint({ recordId: "panel_fixture", message: "hello" }),
    "33849afc1675c631d17f2cebee94781e24a4f8a128bdb200d6db26ca5f317147");
  assert.equal(generationRequestFingerprint({
    recordId: "panel_虚构",
    message: "生成虚构报告\n第二行",
    expectedRevision: "42:1712345678.5",
    attachmentIds: ["att_11111111-1111-4111-8111-111111111111", "att_22222222-2222-4222-8222-222222222222"],
    requestOutputs: true
  }), "f45fabd2f4962f00704c05621fbb2f97a8bef235c93ac8b4581eec6e04750555");
});

test("generation request fingerprint 规范化字段顺序与可选默认值", () => {
  const ordinary = generationRequestFingerprint({ recordId: "record", message: "fixture" });
  const explicit = generationRequestFingerprint({ requestOutputs: false, attachmentIds: [], expectedRevision: undefined,
    message: "fixture", recordId: "record" });
  const reordered = { message: "fixture", attachmentIds: undefined, recordId: "record",
    requestOutputs: undefined, expectedRevision: undefined } satisfies GenerationRequestIdentity;
  assert.equal(ordinary, explicit); assert.equal(explicit, generationRequestFingerprint(reordered));
});

test("generation request fingerprint 区分全部请求身份字段", () => {
  const base: GenerationRequestIdentity = { recordId: "record", message: "fixture", expectedRevision: "10:20",
    attachmentIds: ["att_a", "att_b"], requestOutputs: true };
  const fingerprints = [base,
    { ...base, recordId: "other-record" },
    { ...base, message: "other fixture" },
    { ...base, expectedRevision: "10:21" },
    { ...base, attachmentIds: ["att_a", "att_c"] },
    { ...base, attachmentIds: ["att_b", "att_a"] },
    { ...base, requestOutputs: false }
  ].map(generationRequestFingerprint);
  assert.equal(new Set(fingerprints).size, fingerprints.length);
});

test("generation request fingerprint 拒绝非布尔产出意图", () => {
  assert.throws(() => generationRequestFingerprint({ recordId: "record", message: "fixture",
    requestOutputs: "true" } as unknown as GenerationRequestIdentity), /REQUEST_OUTPUTS_INVALID/);
});

test("generation request fingerprint 仅为无附件无产出请求兼容早期 durable hash", () => {
  const legacy = "7719d1290bca44758cb9b4800f5067cac0072c346b968bfb7b95554cd1d4ae0e";
  const request = { recordId: "panel_fixture", message: "hello" } satisfies GenerationRequestIdentity;
  assert.equal(generationRequestFingerprintMatches(request, legacy), true);
  assert.equal(generationRequestFingerprintMatches({ ...request, attachmentIds: ["att_fixture"] }, legacy), false);
  assert.equal(generationRequestFingerprintMatches({ ...request, requestOutputs: true }, legacy), false);
  assert.equal(generationRequestFingerprintMatches({ ...request, expectedRevision: "different" }, legacy), false);
});

test("versioned fingerprint matcher 严格区分 current 与 legacy 兼容语义", () => {
  const request = { recordId: "panel_fixture", message: "hello" } satisfies GenerationRequestIdentity;
  const current = generationRequestFingerprint(request);
  const legacy = "7719d1290bca44758cb9b4800f5067cac0072c346b968bfb7b95554cd1d4ae0e";
  assert.equal(generationRequestFingerprintMatchesVersion(request, current,
    currentGenerationRequestFingerprintMatcherVersion), true);
  assert.equal(generationRequestFingerprintMatchesVersion(request, legacy,
    currentGenerationRequestFingerprintMatcherVersion), false);
  assert.equal(generationRequestFingerprintMatchesVersion(request, current,
    compatibleGenerationRequestFingerprintMatcherVersion), true);
  assert.equal(generationRequestFingerprintMatchesVersion(request, legacy,
    compatibleGenerationRequestFingerprintMatcherVersion), true);
  assert.equal(generationRequestFingerprintMatchesVersion(request, current, "future-v2"), false);
});
