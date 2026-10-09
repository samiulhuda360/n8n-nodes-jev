/**
 * The Jev request builder and answer reader, with no n8n dependency.
 *
 * The n8n node and the evaluation script (eval/run.mjs) both use this file, so the questions the node sends in a
 * workflow are exactly the questions that were measured.
 */

export type QuestionType = 'choice' | 'score' | 'noul';

/** One question as the user describes it in the node. */
export interface QuestionSpec {
	/** The name the answer comes back under, e.g. "team". */
	key: string;
	type: QuestionType;
	instructions: string;
	/** Choice: option name -> description (null when the name says it all). */
	options?: Record<string, string | null>;
	/** Score: level descriptions, lowest first. */
	levels?: string[];
	/** Noul: optional descriptions of a yes and a no. */
	yes?: string;
	no?: string;
	/** Overrides the node's threshold for this question. */
	threshold?: number;
	/** false: the answer is returned but does not decide the route. */
	gate?: boolean;
}

export type JevState = string | Record<string, unknown> | unknown[];

export interface JevQuestion {
	type: QuestionType;
	instructions: string;
	criteria?: Record<string, string | null> | string[] | { true?: string; false?: string };
}

export interface JevRequest {
	model: string;
	state: JevState;
	questions: Record<string, JevQuestion>;
}

export interface JevRawAnswer {
	type?: string;
	choice?: string;
	score?: number;
	noul?: number;
	confidence?: number;
	probabilities?: Record<string, number>;
	legend?: Record<string, string>;
}

export interface JevResponse {
	model: string;
	answers: Record<string, JevRawAnswer>;
	usage?: { input_tokens?: number; output_tokens?: number };
}

/** A typed answer, ready to use in a workflow. */
export interface Decision {
	key: string;
	type: QuestionType;
	/** Choice: the option name. Score: the probability-weighted score. Noul: true when p >= 0.5. */
	answer: string | number | boolean;
	/** 0 to 1, on the same scale for every type (see confidence functions below). */
	confidence: number;
	/** The threshold this answer was compared with. */
	threshold: number;
	/** true when confidence >= threshold. */
	passed: boolean;
	/** Whether this answer takes part in routing. */
	gate: boolean;
	/** Noul: the probability that the answer is yes. */
	probability?: number;
	/** Choice and Score: the full distribution. */
	probabilities?: Record<string, number>;
	/** Score: the most likely level and its description. */
	level?: number;
	label?: string;
}

export interface Routing {
	route: 'confident' | 'review';
	/** The lowest confidence among the gating answers. */
	confidence: number;
	/** Keys of gating answers that fell below their threshold. */
	below: string[];
}

export const DEFAULT_MODEL = 'jev-latest';
export const DEFAULT_BASE_URL = 'https://api.typesafe.ai';
export const ENDPOINT = '/v1/systemone';
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

export class SpecError extends Error {}

/**
 * Reads "name: description" lines into Choice options. A line without a colon is an option with no description.
 */
export function parseOptionLines(text: string): Record<string, string | null> {
	const options: Record<string, string | null> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const colon = line.indexOf(':');
		const name = (colon >= 0 ? line.slice(0, colon) : line).trim();
		const description = colon >= 0 ? line.slice(colon + 1).trim() : '';
		if (!name) throw new SpecError(`Option line "${line}" has no name before the colon`);
		if (name in options) throw new SpecError(`Option "${name}" is listed twice`);
		options[name] = description || null;
	}
	return options;
}

/** Reads one Score level per line, lowest first. */
export function parseLevelLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
}

function checkThreshold(value: number | undefined, where: string): void {
	if (value === undefined) return;
	if (!Number.isFinite(value) || value < 0 || value > 1) {
		throw new SpecError(`${where}: the threshold must be between 0 and 1`);
	}
}

/** Checks a question and turns it into the JSON Jev expects. */
export function buildQuestion(spec: QuestionSpec): JevQuestion {
	if (!KEY_PATTERN.test(spec.key)) {
		throw new SpecError(
			`Question name "${spec.key}" must start with a letter or underscore and use only letters, digits, - and _`,
		);
	}
	const instructions = (spec.instructions ?? '').trim();
	if (!instructions) throw new SpecError(`Question "${spec.key}" needs instructions`);
	checkThreshold(spec.threshold, `Question "${spec.key}"`);

	if (spec.type === 'choice') {
		const options = spec.options ?? {};
		const count = Object.keys(options).length;
		if (count < 2) throw new SpecError(`Choice "${spec.key}" needs at least two options`);
		if (count > 255) throw new SpecError(`Choice "${spec.key}" can have at most 255 options`);
		return { type: 'choice', instructions, criteria: { ...options } };
	}
	if (spec.type === 'score') {
		const levels = spec.levels ?? [];
		if (levels.length < 2) throw new SpecError(`Score "${spec.key}" needs at least two levels`);
		if (levels.length > 10) throw new SpecError(`Score "${spec.key}" can have at most 10 levels`);
		return { type: 'score', instructions, criteria: [...levels] };
	}
	if (spec.type === 'noul') {
		const question: JevQuestion = { type: 'noul', instructions };
		const yes = spec.yes?.trim();
		const no = spec.no?.trim();
		if (yes || no) {
			const criteria: { true?: string; false?: string } = {};
			if (yes) criteria.true = yes;
			if (no) criteria.false = no;
			question.criteria = criteria;
		}
		return question;
	}
	throw new SpecError(`Question "${spec.key}" has an unknown type "${String(spec.type)}"`);
}

/** Builds the full request body: one state, every question, one call. */
export function buildRequest(state: JevState, specs: QuestionSpec[], model = DEFAULT_MODEL): JevRequest {
	if (!specs.length) throw new SpecError('Add at least one question');
	if (state === undefined || state === null || (typeof state === 'string' && !state.trim())) {
		throw new SpecError('The state is empty: point the node at a field or expression that holds the text');
	}
	const questions: Record<string, JevQuestion> = {};
	for (const spec of specs) {
		if (spec.key in questions) throw new SpecError(`Two questions are named "${spec.key}"`);
		questions[spec.key] = buildQuestion(spec);
	}
	return { model: model.trim() || DEFAULT_MODEL, state, questions };
}

/** Choice confidence: how far the top probability sits above an even split (0) towards certainty (1). */
export function choiceConfidence(probabilities: number[]): number {
	const n = probabilities.length;
	if (n < 2) return 1;
	const top = Math.max(...probabilities);
	return clamp01((top - 1 / n) / (1 - 1 / n));
}

/** Score confidence: 1 minus the probability-weighted distance from the most likely level, scaled by an even spread. */
export function scoreConfidence(probabilities: number[]): number {
	const n = probabilities.length;
	if (n < 2) return 1;
	const peak = probabilities.indexOf(Math.max(...probabilities));
	const spread = probabilities.reduce((sum, p, i) => sum + p * Math.abs(i - peak), 0);
	const even = probabilities.reduce((sum, _p, i) => sum + Math.abs(i - (n - 1) / 2), 0) / n;
	return clamp01(1 - spread / even);
}

/** Noul confidence: the distance of the probability from 0.5, scaled to 0..1 (0.5 -> 0, 0 or 1 -> 1). */
export function noulConfidence(p: number): number {
	return clamp01(Math.abs(2 * p - 1));
}

function clamp01(x: number): number {
	return Math.max(0, Math.min(1, x));
}

function round(x: number, digits = 4): number {
	const f = 10 ** digits;
	return Math.round(x * f) / f;
}

/** Turns one raw Jev answer into a typed Decision, compared with its threshold. */
export function readAnswer(spec: QuestionSpec, raw: JevRawAnswer | undefined, nodeThreshold: number): Decision {
	if (!raw) throw new Error(`The response has no answer for "${spec.key}"`);
	const threshold = spec.threshold ?? nodeThreshold;
	const gate = spec.gate !== false;
	const base = { key: spec.key, type: spec.type, threshold, gate };

	if (spec.type === 'noul') {
		const p = Number(raw.noul);
		if (!Number.isFinite(p)) throw new Error(`Answer "${spec.key}" has no noul value`);
		const confidence = round(noulConfidence(p));
		return { ...base, answer: p >= 0.5, probability: p, confidence, passed: confidence >= threshold };
	}

	const probabilities = raw.probabilities ?? {};
	const values = Object.values(probabilities);
	if (spec.type === 'choice') {
		const choice = raw.choice ?? Object.keys(probabilities).sort((a, b) => probabilities[b] - probabilities[a])[0];
		if (choice === undefined) throw new Error(`Answer "${spec.key}" has no choice`);
		const confidence = round(raw.confidence ?? choiceConfidence(values));
		return { ...base, answer: choice, probabilities, confidence, passed: confidence >= threshold };
	}

	const levels = Object.keys(probabilities).sort((a, b) => Number(a) - Number(b));
	const ordered = levels.map((k) => probabilities[k]);
	const peakIndex = ordered.length ? ordered.indexOf(Math.max(...ordered)) : 0;
	const level = levels.length ? Number(levels[peakIndex]) : Math.round(Number(raw.score ?? 0));
	const score = raw.score ?? ordered.reduce((sum, p, i) => sum + p * Number(levels[i]), 0);
	const confidence = round(raw.confidence ?? scoreConfidence(ordered));
	const label = raw.legend?.[String(level)] ?? spec.levels?.[level];
	return {
		...base,
		answer: round(score, 3),
		probabilities,
		level,
		label,
		confidence,
		passed: confidence >= threshold,
	};
}

/** Confident only when every gating answer meets its threshold. */
export function route(decisions: Decision[]): Routing {
	const gating = decisions.filter((d) => d.gate);
	const considered = gating.length ? gating : decisions;
	const below = considered.filter((d) => !d.passed).map((d) => d.key);
	const confidence = considered.length ? Math.min(...considered.map((d) => d.confidence)) : 0;
	return { route: below.length ? 'review' : 'confident', confidence: round(confidence), below };
}

/** One flat audit record per question, ready for a database row or a sheet line. */
export interface AuditRecord {
	timestamp: string;
	question: string;
	type: QuestionType;
	instructions: string;
	answer: string | number | boolean;
	confidence: number;
	threshold: number;
	passed: boolean;
	route: Routing['route'];
	model: string;
	workflowId?: string;
	executionId?: string;
}

export function auditRecords(
	specs: QuestionSpec[],
	decisions: Decision[],
	routing: Routing,
	model: string,
	timestamp: string,
	context: { workflowId?: string; executionId?: string } = {},
): AuditRecord[] {
	return decisions.map((d) => {
		const spec = specs.find((s) => s.key === d.key);
		return {
			timestamp,
			question: d.key,
			type: d.type,
			instructions: spec?.instructions ?? '',
			answer: d.answer,
			confidence: d.confidence,
			threshold: d.threshold,
			passed: d.passed,
			route: routing.route,
			model,
			...context,
		};
	});
}

/** Reads a dotted path such as "email.body" or "messages[0].text" from an item. */
export function getPath(obj: unknown, path: string): unknown {
	const parts = path
		.replace(/\[(\d+)\]/g, '.$1')
		.split('.')
		.map((p) => p.trim())
		.filter(Boolean);
	let current: unknown = obj;
	for (const part of parts) {
		if (current === null || typeof current !== 'object') return undefined;
		current = (current as Record<string, unknown>)[part];
	}
	return current;
}

/** Turns whatever the user pointed at into a state Jev accepts. */
export function toState(value: unknown): JevState {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value;
	if (value !== null && typeof value === 'object') return value as Record<string, unknown>;
	if (value === undefined || value === null) return '';
	return String(value);
}

const digits = (text: string): number => (text.match(/\d/g) ?? []).length;

const REDACTIONS: Array<[RegExp, (match: string) => string]> = [
	[/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, () => '[email]'],
	[/\b(?:\d[ -]?){13,19}\b/g, () => '[card]'],
	// Phone numbers need at least 9 digits, so dates, amounts and invoice numbers are left alone.
	[/\+?\(?\d[\d ().-]{7,}\d/g, (m) => (digits(m) >= 9 ? '[phone]' : m)],
];

/** Masks email addresses, card-like numbers and phone numbers before the state leaves n8n. */
export function redact<T>(value: T): T {
	if (typeof value === 'string') {
		let text: string = value;
		for (const [pattern, mask] of REDACTIONS) text = text.replace(pattern, mask);
		return text as T;
	}
	if (Array.isArray(value)) return value.map((v) => redact(v)) as T;
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redact(v);
		return out as T;
	}
	return value;
}

/** Shortens a text state to at most maxChars characters (0 keeps everything). */
export function truncate(state: JevState, maxChars: number): JevState {
	if (!maxChars || typeof state !== 'string' || state.length <= maxChars) return state;
	return state.slice(0, maxChars);
}
