import type { OpenAPIObjectConfigV31 } from "@asteasolutions/zod-to-openapi/dist/v3.1/openapi-generator";
import type { OpenAPIObject } from "openapi3-ts/oas31";
import type { Config } from "../config/env";
import { GATEWAY_NAMES } from "../schemas";

type Operation = Record<string, unknown>;

type PathItem = Record<string, unknown>;

export type OpenApiDocument = {
	openapi: string;
	info: Record<string, unknown>;
	paths: Record<string, PathItem>;
	tags?: Array<{ name: string; description: string }>;
	servers?: Array<{ url: string; description: string }>;
	[key: string]: unknown;
};

type OperationEntry = { method: string; path: string };

const HTTP_METHODS = [
	"get",
	"post",
	"put",
	"patch",
	"delete",
	"head",
	"options",
	"trace",
] as const;

const NON_OPERATION_KEYS = new Set<string>([
	"parameters",
	"servers",
	"summary",
	"description",
	"$ref",
]);

const TAG_DESCRIPTIONS: Record<string, string> = {
	Payments:
		"Create a payment and read order state. Creation calls the selected gateway and returns a payment_url.",
	Gateways:
		"Discover which gateways and payment methods the authenticated merchant can use right now.",
	Transactions:
		"Read-only ledger of orders scoped to the authenticated merchant.",
	Refunds:
		"Create and list refunds. Refund support depends on the originating gateway.",
	"Saved Methods":
		"Vaulted payment-method tokens scoped to the merchant. Stored gateway tokens are never returned by read endpoints.",
	Webhooks:
		"Gateway callbacks received by this service, plus the merchant-facing delivery log and replay console.",
	Merchants:
		"Merchant account management: profile, plan, per-gateway credentials and credential rotation.",
	Registration:
		"Public merchant self-registration. No API key required; the merchant API key is returned exactly once.",
	Admin:
		"Operator endpoints. Requires the X-Admin-Key header and is never exposed to merchants.",
	Health:
		"Liveness probe. Reports database connectivity and gateway configuration counts.",
	Mutations:
		"Inbound bank-mutation aggregators (Mutasiku, Moota). These gateways have no outbound checkout; credit mutations are forwarded as payment.success.",
};

const TAG_ORDER = [
	"Payments",
	"Gateways",
	"Transactions",
	"Refunds",
	"Saved Methods",
	"Webhooks",
	"Merchants",
	"Registration",
	"Admin",
	"Health",
	"Mutations",
];

const IGNORED_SEGMENTS = new Set(["api"]);

const STATIC_ALIASES: Record<string, string> = {
	webhook: "Callback",
	webhooks: "Callback",
	health: "Health",
	register: "Registration",
	admin: "Admin",
	"api-key": "ApiKey",
	"webhook-secret": "WebhookSecret",
	"webhook-deliveries": "WebhookDelivery",
	mutasiku: "Mutasiku",
	moota: "Moota",
};

const VERBS: Record<string, string> = {
	get: "Get",
	post: "Create",
	put: "Set",
	patch: "Update",
	delete: "Delete",
	head: "Head",
	options: "Options",
	trace: "Trace",
};

const CANONICAL_WEBHOOK_PREFIX = "webhook";

function isPlaceholder(segment: string): boolean {
	return segment.startsWith("{") && segment.endsWith("}");
}

function pascal(text: string): string {
	return text
		.split(/[^a-zA-Z0-9]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

function segmentsOf(path: string): string[] {
	return path.replace(/^\/+/, "").split("/").filter(Boolean);
}

function literalSegment(segment: string): string {
	const key = segment.toLowerCase();
	const alias = STATIC_ALIASES[key];
	if (alias) return alias;
	return pascal(key);
}

export function deriveOperationId(method: string, path: string): string {
	const normalized = method.toLowerCase();
	const verb = VERBS[normalized] ?? pascal(normalized);
	const segments = segmentsOf(path);
	const literals = segments.filter((segment) => !isPlaceholder(segment));
	const placeholderCount = segments.length - literals.length;
	const meaningful = literals.filter(
		(segment) => !IGNORED_SEGMENTS.has(segment.toLowerCase()),
	);
	const head = meaningful.map(literalSegment);

	if (head.length === 0) return `Root${verb}`;

	const lastIsPlaceholder =
		segments.length > 0 && isPlaceholder(segments[segments.length - 1]);

	if (placeholderCount > 0 && lastIsPlaceholder) {
		const distinct = head.filter((segment) => segment !== head[0]);
		const subject =
			distinct.length > 0 ? distinct[distinct.length - 1] : head[0];
		const prefix = head.filter((segment) => segment !== subject);
		return [...prefix, subject, verb].join("");
	}

	if (placeholderCount > 0) {
		const last = head[head.length - 1];
		const prefix = head.slice(0, -1);
		return [...prefix, last, verb].join("");
	}

	if (normalized === "get") {
		return [...head, "List"].join("");
	}

	return [...head, verb].join("");
}

function isOperation(value: unknown): value is Operation {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function operationsOf(item: PathItem): Array<[string, Operation]> {
	const entries: Array<[string, Operation]> = [];
	for (const [key, value] of Object.entries(item)) {
		if (NON_OPERATION_KEYS.has(key)) continue;
		if (!isOperation(value)) continue;
		entries.push([key, value]);
	}
	return entries;
}

function methodOrder(method: string): number {
	const index = (HTTP_METHODS as readonly string[]).indexOf(method);
	return index === -1 ? HTTP_METHODS.length : index;
}

export function webhookPathAliases(): Map<string, string> {
	const aliases = new Map<string, string>();
	for (const gateway of GATEWAY_NAMES) {
		aliases.set(`${CANONICAL_WEBHOOK_PREFIX}/${gateway}`, gateway);
	}
	return aliases;
}

export function operationEntries(document: OpenApiDocument): OperationEntry[] {
	return Object.entries(document.paths).flatMap(([path, item]) =>
		operationsOf(item).map(([method]) => ({ method, path })),
	);
}

export function resolveOperationIds(
	entries: OperationEntry[],
): Map<string, string> {
	const assigned = new Map<string, string>();
	const claimed = new Set<string>();

	const ordered = [...entries].sort((a, b) => {
		const aCanonical =
			a.path === `/${CANONICAL_WEBHOOK_PREFIX}/${segmentsOf(a.path).pop()}`;
		const bCanonical =
			b.path === `/${CANONICAL_WEBHOOK_PREFIX}/${segmentsOf(b.path).pop()}`;
		if (aCanonical !== bCanonical) return aCanonical ? -1 : 1;
		if (a.path.length !== b.path.length) return a.path.length - b.path.length;
		return a.path.localeCompare(b.path);
	});

	for (const entry of ordered) {
		const base = deriveOperationId(entry.method, entry.path);
		let candidate = base;
		if (claimed.has(candidate)) {
			const segments = segmentsOf(entry.path);
			const tail = segments[segments.length - 1] ?? "Root";
			const discriminator = pascal(tail);
			candidate = `${base}On${discriminator}`;
			let counter = 2;
			while (claimed.has(candidate)) {
				candidate = `${base}On${discriminator}${counter}`;
				counter += 1;
			}
		}
		claimed.add(candidate);
		assigned.set(`${entry.method} ${entry.path}`, candidate);
	}

	return assigned;
}

function buildTags(document: OpenApiDocument): Array<{
	name: string;
	description: string;
}> {
	const used = new Set<string>();
	for (const [, operation] of Object.entries(document.paths).flatMap(
		([, item]) => operationsOf(item),
	)) {
		const tags = operation.tags;
		if (!Array.isArray(tags)) continue;
		for (const tag of tags) {
			if (typeof tag === "string" && tag.length > 0) used.add(tag);
		}
	}
	const ordered = [
		...TAG_ORDER.filter((tag) => used.has(tag)),
		...[...used].filter((tag) => !TAG_ORDER.includes(tag)).sort(),
	];
	return ordered.map((name) => ({
		name,
		description:
			TAG_DESCRIPTIONS[name] ?? `1ai-payment endpoints grouped under ${name}.`,
	}));
}

function isCanonicalWebhookPath(path: string): boolean {
	const segments = segmentsOf(path);
	return (
		segments.length === 2 &&
		segments[0].toLowerCase() === CANONICAL_WEBHOOK_PREFIX
	);
}

export function serversFor(config: Config): Array<{
	url: string;
	description: string;
}> {
	const servers = [
		{ url: config.PUBLIC_BASE_URL, description: "Public production endpoint" },
	];
	if (config.NODE_ENV !== "production") {
		servers.push({
			url: `http://127.0.0.1:${config.PORT}`,
			description: "Local development endpoint",
		});
	}
	return servers;
}

export function decorateOpenApiDocument(
	raw: OpenApiDocument,
	servers: Array<{ url: string; description: string }>,
): OpenApiDocument {
	const ids = resolveOperationIds(operationEntries(raw));

	const paths = Object.keys(raw.paths).sort((a, b) => {
		const aCanonical = isCanonicalWebhookPath(a);
		const bCanonical = isCanonicalWebhookPath(b);
		if (aCanonical !== bCanonical) return aCanonical ? -1 : 1;
		if (a.length !== b.length) return a.length - b.length;
		return a.localeCompare(b);
	});

	const nextPaths: Record<string, PathItem> = {};
	for (const path of paths) {
		const item = raw.paths[path];
		const sortedItem: PathItem = {};
		for (const [method, operation] of operationsOf(item).sort(
			(a, b) => methodOrder(a[0]) - methodOrder(b[0]),
		)) {
			const operationId = ids.get(`${method} ${path}`);
			sortedItem[method] = operationId
				? { ...operation, operationId }
				: { ...operation };
		}
		for (const [key, value] of Object.entries(item)) {
			if (!(key in sortedItem)) sortedItem[key] = value;
		}
		nextPaths[path] = sortedItem;
	}

	return {
		...raw,
		paths: nextPaths,
		tags: buildTags(raw),
		servers,
	};
}

export function buildOpenApiDocument(
	raw: OpenApiDocument,
	servers: Array<{ url: string; description: string }>,
): OpenAPIObjectConfigV31 {
	const { paths, ...rest } = decorateOpenApiDocument(raw, servers);
	const decorated = { ...rest, paths };
	return {
		openapi: decorated.openapi,
		info: decorated.info as unknown as OpenAPIObject["info"],
		servers: decorated.servers,
		tags: decorated.tags,
	} as OpenAPIObjectConfigV31;
}
