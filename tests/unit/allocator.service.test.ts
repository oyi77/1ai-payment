import { describe, expect, test } from "bun:test";

import { AmountAllocator, AmountPoolExhaustedError } from "../../src/services/allocator.service";

describe("AmountAllocator constructor", () => {
	test("rejects zero maxOffset", () => {
		expect(() => new AmountAllocator(0)).toThrow();
	});
	test("rejects negative maxOffset", () => {
		expect(() => new AmountAllocator(-1)).toThrow();
	});
	test("rejects non-integer maxOffset", () => {
		expect(() => new AmountAllocator(1.5)).toThrow();
	});
});

describe("AmountAllocator.allocate", () => {
	test("allocates offset 1 when pool empty", () => {
		const allocator = new AmountAllocator(50);
		expect(allocator.allocate(1000, new Set())).toBe(1);
	});

	test("sequential allocation fills earlier offsets", () => {
		const allocator = new AmountAllocator(50);
		const taken = new Set<number>();
		const o1 = allocator.allocate(1000, taken);
		taken.add(1000 + o1);
		const o2 = allocator.allocate(1000, taken);
		taken.add(1000 + o2);
		const o3 = allocator.allocate(1000, taken);
		expect([o1, o2, o3]).toEqual([1, 2, 3]);
	});

	test("multi-base collision prevention", () => {
		const allocator = new AmountAllocator(50);
		// base 1000 offset 2 -> 1002 taken
		const taken = new Set([1002]);
		// base 1001 offset 1 -> 1002 would collide, should get offset 2 -> 1003
		expect(allocator.allocate(1001, taken)).toBe(2);
	});

	test("throws AmountPoolExhaustedError when all slots filled", () => {
		const allocator = new AmountAllocator(3);
		const taken = new Set([1001, 1002, 1003]);
		expect(() => allocator.allocate(1000, taken)).toThrow(
			AmountPoolExhaustedError,
		);
	});

	test("supports Map and array taken sets", () => {
		const allocator = new AmountAllocator(50);
		expect(allocator.allocate(1000, new Map([[1001, "x"]]))).toBe(2);
		expect(allocator.allocate(1000, [1001])).toBe(2);
	});
});

describe("AmountAllocator.allocateUniqueAmount", () => {
	test("returns base + offset", () => {
		const allocator = new AmountAllocator(50);
		expect(allocator.allocateUniqueAmount(1000, new Set())).toBe(1001);
	});
});
