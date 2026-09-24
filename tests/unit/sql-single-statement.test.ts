/**
 * Structural guard for the libsql multi-statement trap (Sweep79).
 *
 * `db.execute()` runs ONLY the first statement of a multi-statement SQL
 * string — later statements are silently skipped (this once dropped a
 * UNIQUE index and broke idempotency). Multi-statement SQL MUST use
 * `db.executeMultiple()`. This test scans every inline SQL literal passed
 * to `db.execute(` under src/ and fails if any contains a second statement.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const SRC = join(dirname(__dirname), "..", "src");

function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...tsFiles(full));
		} else if (entry.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

function inlineSqlLiterals(text: string): string[] {
	const found: string[] = [];
	// sql: `...` / sql: "..."  and  db.execute("..." / db.execute(`...`
	const patterns = [
		/sql:\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*")/g,
		/db\.execute\(\s*(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*")/g,
	];
	for (const re of patterns) {
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) {
			found.push(m[1].slice(1, -1));
		}
	}
	return found;
}

describe("db.execute() single-statement rule", () => {
	test("no inline SQL literal passed to db.execute contains a second statement", () => {
		const offenders: string[] = [];
		for (const file of tsFiles(SRC)) {
			const text = readFileSync(file, "utf8");
			for (const body of inlineSqlLiterals(text)) {
				let stripped = body.trim();
				if (stripped.endsWith(";")) stripped = stripped.slice(0, -1);
				if (stripped.includes(";")) {
					offenders.push(`${file}: ${stripped.slice(0, 80)}…`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("dynamic UPDATE builders use only hardcoded column fragments", () => {
		// The four ${updates.join} sites must not interpolate user input into
		// the SET clause — columns are literals, values are `?` args. This
		// pins the allowlist by asserting each builder's push sites.
		const allowedFiles = [
			"routes/admin.ts",
			"routes/merchants/accounts.routes.ts",
			"services/order.service.ts",
			"services/saved-methods.service.ts",
		];
		const builders: string[] = [];
		for (const file of tsFiles(SRC)) {
			const text = readFileSync(file, "utf8");
			if (text.includes("${updates.join")) {
				builders.push(file.slice(SRC.length + 1));
			}
		}
		expect(builders.sort()).toEqual(allowedFiles.sort());
	});
});
