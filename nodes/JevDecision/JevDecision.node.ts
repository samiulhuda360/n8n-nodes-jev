import {
	NodeApiError,
	NodeConnectionTypes,
	NodeOperationError,
	sleep,
	type IDataObject,
	type IExecuteFunctions,
	type IHttpRequestOptions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type JsonObject,
} from 'n8n-workflow';

import {
	DEFAULT_BASE_URL,
	DEFAULT_MODEL,
	ENDPOINT,
	auditRecords,
	buildRequest,
	getPath,
	parseLevelLines,
	parseOptionLines,
	readAnswer,
	redact,
	route,
	toState,
	truncate,
	type JevResponse,
	type JevState,
	type QuestionSpec,
	type QuestionType,
} from './core';

const RETRY_STATUSES = [429, 529, 502, 503];

interface NodeOptions {
	model?: string;
	outputField?: string;
	includeAudit?: boolean;
	redactPersonalData?: boolean;
	maxStateChars?: number;
	timeout?: number;
	concurrency?: number;
}

export class JevDecision implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Jev Decision',
		name: 'jevDecision',
		icon: 'file:jev.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{ {"askChoice": "Choice", "askScore": "Score", "askNoul": "Yes/No", "askSeveral": "Several questions"}[$parameter["operation"]] + " · threshold " + $parameter["threshold"] }}',
		description: 'Ask Jev typed questions about each item and route it by confidence',
		defaults: {
			name: 'Jev Decision',
		},
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main, NodeConnectionTypes.Main],
		outputNames: ['Confident', 'Needs review'],
		credentials: [
			{
				name: 'typeSafeApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Ask Choice',
						value: 'askChoice',
						description: 'Pick one option from a list',
						action: 'Ask a choice question',
					},
					{
						name: 'Ask Score',
						value: 'askScore',
						description: 'Rate the item on levels you describe',
						action: 'Ask a score question',
					},
					{
						name: 'Ask Yes/No (Noul)',
						value: 'askNoul',
						description: 'Get the probability that a statement is true',
						action: 'Ask a yes no question',
					},
					{
						name: 'Ask Several',
						value: 'askSeveral',
						description: 'Ask several named questions in one call',
						action: 'Ask several questions',
					},
				],
				default: 'askChoice',
			},
			{
				displayName: 'State From',
				name: 'stateSource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Field',
						value: 'field',
						description: 'Read one field of the incoming item, such as "body" or "email.text"',
					},
					{
						name: 'Expression',
						value: 'expression',
						description: 'Write the text yourself, mixing fields with expressions',
					},
					{
						name: 'Whole Item',
						value: 'item',
						description: 'Send the entire item as structured data',
					},
				],
				default: 'field',
				description: 'Where the text that Jev reads comes from',
			},
			{
				displayName: 'Field Name',
				name: 'stateField',
				type: 'string',
				default: 'text',
				placeholder: 'e.g. body or email.text',
				description: 'The field that holds the text. Use dots for nested fields.',
				displayOptions: { show: { stateSource: ['field'] } },
			},
			{
				displayName: 'State',
				name: 'state',
				type: 'string',
				typeOptions: { rows: 4 },
				default: '',
				placeholder: 'e.g. Subject: {{ $json.subject }}\n\n{{ $json.body }}',
				description: 'The text Jev reads for this item',
				displayOptions: { show: { stateSource: ['expression'] } },
			},
			{
				displayName: 'Answer Name',
				name: 'questionKey',
				type: 'string',
				default: 'answer',
				description: 'The name the answer is stored under in the output',
				displayOptions: { show: { operation: ['askChoice', 'askScore', 'askNoul'] } },
			},
			{
				displayName: 'Question',
				name: 'instructions',
				type: 'string',
				typeOptions: { rows: 2 },
				default: '',
				required: true,
				placeholder: 'e.g. Which team should handle this email?',
				description: 'What Jev should decide. Be specific: Jev answers the question as written.',
				displayOptions: { show: { operation: ['askChoice', 'askScore', 'askNoul'] } },
			},
			{
				displayName: 'Options',
				name: 'choiceOptions',
				placeholder: 'Add Option',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true, sortable: true },
				default: {},
				description: 'The options Jev picks from, each with a short description',
				displayOptions: { show: { operation: ['askChoice'] } },
				options: [
					{
						name: 'option',
						displayName: 'Option',
						values: [
							{
								displayName: 'Name',
								name: 'name',
								type: 'string',
								default: '',
								placeholder: 'e.g. billing',
								description: 'The value returned when this option is picked',
							},
							{
								displayName: 'Description',
								name: 'description',
								type: 'string',
								default: '',
								placeholder: 'e.g. Charges, invoices, refunds and plan changes',
								description: 'What this option covers. Boundary cases help most.',
							},
						],
					},
				],
			},
			{
				displayName: 'Levels',
				name: 'scoreLevels',
				placeholder: 'Add Level',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true, sortable: true },
				default: {},
				description: 'Between 2 and 10 levels, lowest first. The first level is 0.',
				displayOptions: { show: { operation: ['askScore'] } },
				options: [
					{
						name: 'level',
						displayName: 'Level',
						values: [
							{
								displayName: 'Description',
								name: 'description',
								type: 'string',
								default: '',
								placeholder: 'e.g. Poor fit: no budget and no matching need',
							},
						],
					},
				],
			},
			{
				displayName: 'Yes Means',
				name: 'yesMeans',
				type: 'string',
				default: '',
				placeholder: 'e.g. Explicitly time-sensitive',
				description: 'Optional: what a yes looks like',
				displayOptions: { show: { operation: ['askNoul'] } },
			},
			{
				displayName: 'No Means',
				name: 'noMeans',
				type: 'string',
				default: '',
				placeholder: 'e.g. No deadline or impact mentioned',
				description: 'Optional: what a no looks like',
				displayOptions: { show: { operation: ['askNoul'] } },
			},
			{
				displayName: 'Questions',
				name: 'questions',
				placeholder: 'Add Question',
				type: 'fixedCollection',
				typeOptions: { multipleValues: true, sortable: true },
				default: {},
				description: 'All questions go to Jev in one call, about the same state',
				displayOptions: { show: { operation: ['askSeveral'] } },
				options: [
					{
						name: 'question',
						displayName: 'Question',
						// Kept in the order people fill them in, not alphabetical.
						// eslint-disable-next-line n8n-nodes-base/node-param-fixed-collection-type-unsorted-items
						values: [
							{
								displayName: 'Answer Name',
								name: 'key',
								type: 'string',
								default: '',
								placeholder: 'e.g. team',
								description: 'The name the answer is stored under',
							},
							{
								displayName: 'Type',
								name: 'type',
								type: 'options',
								options: [
									{ name: 'Choice', value: 'choice' },
									{ name: 'Score', value: 'score' },
									{ name: 'Yes/No (Noul)', value: 'noul' },
								],
								default: 'choice',
							},
							{
								displayName: 'Question',
								name: 'instructions',
								type: 'string',
								typeOptions: { rows: 2 },
								default: '',
								placeholder: 'e.g. Which team should handle this email?',
							},
							{
								displayName: 'Options or Levels',
								name: 'criteria',
								type: 'string',
								typeOptions: { rows: 4 },
								default: '',
								placeholder: 'billing: Charges, invoices, refunds\ntechnical: Bugs, errors, outages',
								description:
									'Choice: one option per line as "name: description". Score: one level per line, lowest first. Yes/No: optional "yes: ..." and "no: ..." lines.',
							},
							{
								displayName: 'Own Threshold',
								name: 'threshold',
								type: 'number',
								typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
								default: 0,
								description: 'Overrides the node threshold for this question. 0 uses the node threshold.',
							},
							{
								displayName: 'Decides the Route',
								name: 'gate',
								type: 'boolean',
								default: true,
								description:
									'Whether this answer must meet its threshold for the item to count as confident. Turn off for extra information you only want to record.',
							},
						],
					},
				],
			},
			{
				displayName: 'Confidence Threshold',
				name: 'threshold',
				type: 'number',
				typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
				default: 0.8,
				description:
					'Items whose confidence reaches this go to Confident; the rest go to Needs review. For Yes/No the confidence is the distance from 0.5 scaled to 0–1, so 0.8 means a probability of at least 0.9 or at most 0.1.',
			},
			{
				displayName: 'Options',
				name: 'additionalOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Add Audit Record',
						name: 'includeAudit',
						type: 'boolean',
						default: false,
						description:
							'Whether to add one record per question with the question, answer, confidence, threshold, model version and a timestamp, ready to log to a database or sheet',
					},
					{
						displayName: 'Concurrent Requests',
						name: 'concurrency',
						type: 'number',
						typeOptions: { minValue: 1, maxValue: 20 },
						default: 5,
						description: 'How many items are sent to Jev at the same time',
					},
					{
						displayName: 'Max State Length',
						name: 'maxStateChars',
						type: 'number',
						typeOptions: { minValue: 0 },
						default: 0,
						description: 'Cut text states to this many characters before sending. 0 sends the full text.',
					},
					{
						displayName: 'Model',
						name: 'model',
						type: 'string',
						default: DEFAULT_MODEL,
						description: 'The Jev model alias or version, for example jev-latest or jev-preview',
					},
					{
						displayName: 'Output Field',
						name: 'outputField',
						type: 'string',
						default: 'jev',
						description: 'The field the answers are written to on each item',
					},
					{
						displayName: 'Redact Personal Data',
						name: 'redactPersonalData',
						type: 'boolean',
						default: false,
						description:
							'Whether to mask email addresses, phone numbers and card-like numbers in the state before it is sent',
					},
					{
						displayName: 'Timeout (Ms)',
						name: 'timeout',
						type: 'number',
						typeOptions: { minValue: 1000 },
						default: 30000,
						description: 'How long to wait for Jev before the item fails',
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const confident: INodeExecutionData[] = [];
		const review: INodeExecutionData[] = [];
		const credentials = await this.getCredentials('typeSafeApi');
		const baseUrl = String(credentials.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
		const firstOptions = this.getNodeParameter('additionalOptions', 0, {}) as NodeOptions;
		const concurrency = Math.max(1, Math.min(20, Number(firstOptions.concurrency) || 5));

		const results: Array<{ item: INodeExecutionData; confident: boolean }> = new Array(items.length);

		const runOne = async (i: number): Promise<void> => {
			const options = this.getNodeParameter('additionalOptions', i, {}) as NodeOptions;
			const outputField = (options.outputField || 'jev').trim() || 'jev';
			try {
				const specs = readSpecs(this, i);
				const threshold = this.getNodeParameter('threshold', i, 0.8) as number;
				let state = readState(this, i, items[i].json);
				if (options.redactPersonalData) state = redact(state);
				state = truncate(state, Number(options.maxStateChars) || 0);
				const body = buildRequest(state, specs, options.model || DEFAULT_MODEL);

				const started = Date.now();
				const response = await callJev(this, i, baseUrl, body, Number(options.timeout) || 30000);
				const latencyMs = Date.now() - started;

				const decisions = specs.map((spec) => readAnswer(spec, response.answers?.[spec.key], threshold));
				const routing = route(decisions);
				const answers: IDataObject = {};
				for (const d of decisions) answers[d.key] = { ...d } as unknown as IDataObject;

				const result: IDataObject = {
					route: routing.route,
					confidence: routing.confidence,
					threshold,
					below: routing.below,
					answers,
					model: response.model,
					usage: (response.usage ?? {}) as IDataObject,
					latencyMs,
				};
				const operation = this.getNodeParameter('operation', i) as string;
				if (operation !== 'askSeveral') result.answer = decisions[0].answer;
				if (options.includeAudit) {
					const workflow = this.getWorkflow();
					result.audit = auditRecords(specs, decisions, routing, response.model, new Date().toISOString(), {
						workflowId: workflow.id ? String(workflow.id) : undefined,
						executionId: this.getExecutionId(),
					}) as unknown as IDataObject[];
				}
				results[i] = {
					item: { json: { ...items[i].json, [outputField]: result }, pairedItem: { item: i } },
					confident: routing.route === 'confident',
				};
			} catch (error) {
				if (!this.continueOnFail()) {
					if (error instanceof NodeApiError || error instanceof NodeOperationError) throw error;
					throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
				}
				const message = error instanceof Error ? error.message : String(error);
				results[i] = {
					item: {
						json: { ...items[i].json, [outputField]: { route: 'review', error: message } },
						pairedItem: { item: i },
					},
					confident: false,
				};
			}
		};

		for (let start = 0; start < items.length; start += concurrency) {
			const batch: Array<Promise<void>> = [];
			for (let i = start; i < Math.min(items.length, start + concurrency); i++) batch.push(runOne(i));
			await Promise.all(batch);
		}
		for (const r of results) (r.confident ? confident : review).push(r.item);
		return [confident, review];
	}
}

function readState(ctx: IExecuteFunctions, i: number, json: IDataObject): JevState {
	const source = ctx.getNodeParameter('stateSource', i) as string;
	if (source === 'item') return toState(json);
	if (source === 'expression') return toState(ctx.getNodeParameter('state', i, ''));
	const field = (ctx.getNodeParameter('stateField', i, 'text') as string).trim();
	const value = getPath(json, field);
	if (value === undefined) {
		throw new NodeOperationError(ctx.getNode(), `The item has no field "${field}"`, { itemIndex: i });
	}
	return toState(value);
}

function readSpecs(ctx: IExecuteFunctions, i: number): QuestionSpec[] {
	const operation = ctx.getNodeParameter('operation', i) as string;
	if (operation === 'askSeveral') {
		const collection = ctx.getNodeParameter('questions', i, {}) as {
			question?: Array<{
				key: string;
				type: QuestionType;
				instructions: string;
				criteria?: string;
				threshold?: number;
				gate?: boolean;
			}>;
		};
		return (collection.question ?? []).map((q) => {
			const spec: QuestionSpec = {
				key: (q.key ?? '').trim(),
				type: q.type,
				instructions: q.instructions,
				threshold: q.threshold ? q.threshold : undefined,
				gate: q.gate !== false,
			};
			if (q.type === 'choice') spec.options = parseOptionLines(q.criteria ?? '');
			if (q.type === 'score') spec.levels = parseLevelLines(q.criteria ?? '');
			if (q.type === 'noul' && (q.criteria ?? '').trim()) {
				const meanings = parseOptionLines(q.criteria ?? '');
				spec.yes = meanings.yes ?? meanings.true ?? undefined;
				spec.no = meanings.no ?? meanings.false ?? undefined;
			}
			return spec;
		});
	}

	const key = ((ctx.getNodeParameter('questionKey', i, 'answer') as string) || 'answer').trim();
	const instructions = ctx.getNodeParameter('instructions', i, '') as string;
	if (operation === 'askChoice') {
		const list = (ctx.getNodeParameter('choiceOptions', i, {}) as {
			option?: Array<{ name: string; description?: string }>;
		}).option ?? [];
		const options: Record<string, string | null> = {};
		for (const o of list) {
			const name = (o.name ?? '').trim();
			if (!name) continue;
			if (name in options) {
				throw new NodeOperationError(ctx.getNode(), `Option "${name}" is listed twice`, { itemIndex: i });
			}
			options[name] = (o.description ?? '').trim() || null;
		}
		return [{ key, type: 'choice', instructions, options }];
	}
	if (operation === 'askScore') {
		const list = (ctx.getNodeParameter('scoreLevels', i, {}) as { level?: Array<{ description: string }> }).level ?? [];
		return [{ key, type: 'score', instructions, levels: list.map((l) => (l.description ?? '').trim()).filter(Boolean) }];
	}
	return [
		{
			key,
			type: 'noul',
			instructions,
			yes: ctx.getNodeParameter('yesMeans', i, '') as string,
			no: ctx.getNodeParameter('noMeans', i, '') as string,
		},
	];
}

async function callJev(
	ctx: IExecuteFunctions,
	i: number,
	baseUrl: string,
	body: object,
	timeout: number,
): Promise<JevResponse> {
	const request: IHttpRequestOptions = {
		method: 'POST',
		url: `${baseUrl}${ENDPOINT}`,
		body: body as IDataObject,
		json: true,
		timeout,
	};
	for (let attempt = 0; ; attempt++) {
		try {
			return (await ctx.helpers.httpRequestWithAuthentication.call(ctx, 'typeSafeApi', request)) as JevResponse;
		} catch (error) {
			const status = Number(
				(error as { httpCode?: string; response?: { status?: number } }).httpCode ??
					(error as { response?: { status?: number } }).response?.status,
			);
			if (attempt < 2 && RETRY_STATUSES.includes(status)) {
				await sleep(500 * 2 ** attempt);
				continue;
			}
			throw new NodeApiError(ctx.getNode(), error as JsonObject, { itemIndex: i });
		}
	}
}
