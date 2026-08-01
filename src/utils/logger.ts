/**
 * Logger — structured logging, no raw webhook payloads.
 *
 * SECURITY: Never log raw gateway payloads. Log only order_id, gateway, status.
 */

import { getConfig } from "../config/env";

const levels: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function shouldLog(level: string): boolean {
	const config = getConfig();
	return levels[level] >= levels[config.LOG_LEVEL];
}

// Keys whose values are redacted in logs — never leak secrets or signatures.
const REDACT_KEY_PATTERN =
	/(secret|token|key|signature|password|authorization)/i;
const MAX_STRING_LENGTH = 2000;

/**
 * JSON-stringify for logging with secret key redaction and length truncation.
 * Falls back to String() for circular/exception-throwing structures.
 */
export function safeStringify(data: unknown): string {
	try {
		return JSON.stringify(data, (_key, value) => {
			if (typeof value === "string") {
				if (REDACT_KEY_PATTERN.test(_key)) return "[REDACTED]";
				if (value.length > MAX_STRING_LENGTH)
					return `${value.slice(0, MAX_STRING_LENGTH)}...[truncated]`;
			}
			return value;
		});
	} catch {
		return String(data);
	}
}

function formatMessage(level: string, msg: string, data?: unknown): string {
	const ts = new Date().toISOString();
	const prefix = `[${ts}] [${level.toUpperCase()}]`;
	if (data !== undefined) {
		return `${prefix} ${msg} ${safeStringify(data)}`;
	}
	return `${prefix} ${msg}`;
}

export const logger = {
	debug(msg: string, data?: unknown) {
		if (shouldLog("debug")) console.debug(formatMessage("debug", msg, data));
	},
	info(msg: string, data?: unknown) {
		if (shouldLog("info")) console.info(formatMessage("info", msg, data));
	},
	warn(msg: string, data?: unknown) {
		if (shouldLog("warn")) console.warn(formatMessage("warn", msg, data));
	},
	error(msg: string, data?: unknown) {
		if (shouldLog("error")) console.error(formatMessage("error", msg, data));
	},
};
