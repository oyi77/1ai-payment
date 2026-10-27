/**
 * Amount allocator service — ports paygateme's unique amount allocation strategy.
 *
 * Used for single-merchant bank/QRIS mutation reconciliation by allocating
 * unique integer offset amounts (baseAmount + [1..maxOffset]) across active orders.
 */

export class AmountPoolExhaustedError extends Error {
	constructor(baseAmount: number, maxOffset: number) {
		super(
			`Amount pool exhausted for base amount ${baseAmount} with max offset ${maxOffset}`,
		);
		this.name = "AmountPoolExhaustedError";
	}
}

export type TakenAmounts = Set<number> | Map<number, unknown> | number[];

export class AmountAllocator {
	public readonly maxOffset: number;

	constructor(maxOffset = 50) {
		if (maxOffset <= 0 || !Number.isInteger(maxOffset)) {
			throw new Error("maxOffset must be a positive integer");
		}
		this.maxOffset = maxOffset;
	}

	/**
	 * Finds smallest offset in [1 .. maxOffset] such that (baseAmount + offset) is not in takenAmounts.
	 * Throws AmountPoolExhaustedError if all slots taken.
	 */
	public allocate(baseAmount: number, takenAmounts: TakenAmounts): number {
		const takenSet =
			takenAmounts instanceof Set
				? takenAmounts
				: Array.isArray(takenAmounts)
					? new Set(takenAmounts)
					: null;

		for (let offset = 1; offset <= this.maxOffset; offset++) {
			const candidate = baseAmount + offset;
			const isTaken = takenSet
				? takenSet.has(candidate)
				: takenAmounts instanceof Map
					? takenAmounts.has(candidate)
					: false;

			if (!isTaken) {
				return offset;
			}
		}

		throw new AmountPoolExhaustedError(baseAmount, this.maxOffset);
	}

	/**
	 * Returns baseAmount + this.allocate(baseAmount, takenAmounts).
	 */
	public allocateUniqueAmount(
		baseAmount: number,
		takenAmounts: TakenAmounts,
	): number {
		return baseAmount + this.allocate(baseAmount, takenAmounts);
	}
}
