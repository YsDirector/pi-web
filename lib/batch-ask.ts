/**
 * __piBatchAsk__ envelope protocol — multi-question questionnaire (tabbed batch UI).
 *
 * Fork-only module. The ask_question extension sends the envelope as the
 * `title` of an `input` extension_ui_request; a client that recognizes it
 * renders a tabbed batch questionnaire (components/BatchAskDialog.tsx) and
 * replies with a JSON string { answers: BatchAskAnswer[] }.
 *
 * Kept in a standalone file so upstream merges never touch it (zero-conflict
 * with agegr/pi-web).
 */
import type { ExtensionUiRequest } from "./types";

export interface BatchAskOption {
	label: string;
	value: string;
	description?: string;
}

export interface BatchAskQuestion {
	id: string;
	type: "select" | "confirm" | "input" | "editor";
	question: string;
	options?: BatchAskOption[];
	allowOther?: boolean;
	placeholder?: string;
	prefill?: string;
}

export interface BatchAskEnvelope {
	/** Envelope marker; the wire key is "__piBatchAsk" (single trailing underscore). */
	__piBatchAsk: number;
	review: boolean;
	questions: BatchAskQuestion[];
}

export interface BatchAskAnswer {
	id: string;
	type: string;
	value: string | boolean | null;
	label?: string;
	wasCustom?: boolean;
}

/** Same shape as ChatWindow's local ExtensionDialogRequest. */
export type BatchAskDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

const BATCH_ASK_ENVELOPE_KEY = "__piBatchAsk";

export function parseBatchAskEnvelope(request: BatchAskDialogRequest): BatchAskEnvelope | null {
	if (request.method !== "input") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(request.title);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const p = parsed as Record<string, unknown>;
	if (p[BATCH_ASK_ENVELOPE_KEY] !== 1) return null;
	const questions = Array.isArray(p.questions) ? (p.questions as BatchAskQuestion[]) : [];
	if (questions.length === 0) return null;
	return { __piBatchAsk: 1, review: p.review === true, questions };
}

export function isAnswered(a: BatchAskAnswer | null): boolean {
	return Boolean(a && a.value !== null && a.value !== undefined && String(a.value).trim() !== "");
}
