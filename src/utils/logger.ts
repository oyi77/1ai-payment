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

function formatMessage(level: string, msg: string, data?: unknown): string {
	const ts = new Date().toISOString();
	const prefix = `[${ts}] [${level.toUpperCase()}]`;
	if (data !== undefined) {
		return `${prefix} ${msg} ${JSON.stringify(data)}`;
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
