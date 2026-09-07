/**
 * Tests for the __piBatchAsk__ envelope parser (lib/batch-ask.ts).
 * Uses jiti to load TypeScript directly, mirroring other lib tests.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const jiti = require("jiti")(import.meta.url);
const { parseBatchAskEnvelope, isAnswered } = jiti("./batch-ask.ts");

function makeRequest(overrides = {}) {
	return {
		type: "extension_ui_request",
		id: "test-id",
		method: "input",
		title: "title",
		...overrides,
	};
}

test("parses a valid __piBatchAsk__ envelope", () => {
	const envelope = {
		// 实际 wire key 是单下划线 "__piBatchAsk"（扩展 L343 用常量构造）
		__piBatchAsk: 1,
		review: true,
		questions: [{ id: "q1", type: "select", question: "Pick one", options: [{ label: "A", value: "a" }] }],
	};
	const req = makeRequest({ title: JSON.stringify(envelope) });
	const parsed = parseBatchAskEnvelope(req);
	assert.ok(parsed);
	assert.equal(parsed.review, true);
	assert.equal(parsed.questions.length, 1);
	assert.equal(parsed.questions[0].id, "q1");
});

test("returns null for non-input requests, invalid JSON, or missing questions", () => {
	assert.equal(parseBatchAskEnvelope(makeRequest({ method: "select" })), null);
	assert.equal(parseBatchAskEnvelope(makeRequest({ title: "not json" })), null);
	assert.equal(
		parseBatchAskEnvelope(makeRequest({ title: JSON.stringify({ __piBatchAsk: 1, questions: [] }) })),
		null,
	);
	assert.equal(
		parseBatchAskEnvelope(makeRequest({ title: JSON.stringify({ other: 1, questions: [{}] }) })),
		null,
	);
});

test("review flag defaults to false when absent", () => {
	const parsed = parseBatchAskEnvelope(
		makeRequest({ title: JSON.stringify({ __piBatchAsk: 1, questions: [{ id: "q1", type: "input", question: "?" }] }) }),
	);
	assert.ok(parsed);
	assert.equal(parsed.review, false);
});

test("isAnswered rejects null, undefined, and blank values", () => {
	assert.equal(isAnswered(null), false);
	assert.equal(isAnswered({ id: "q", type: "input", value: null }), false);
	assert.equal(isAnswered({ id: "q", type: "input", value: "   " }), false);
	assert.equal(isAnswered({ id: "q", type: "confirm", value: false }), true);
	assert.equal(isAnswered({ id: "q", type: "input", value: "ok" }), true);
});
