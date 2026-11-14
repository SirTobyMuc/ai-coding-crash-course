import { formatPrice } from "~/lib/utils";

/**
 * Completed students as a count out of the enrolled students with a rate,
 * e.g. "1 of 4 (25%)". With zero enrolled students there is no rate to show.
 */
export function formatCompleted(
  completedCount: number,
  enrolledCount: number
): string {
  const count = `${completedCount} of ${enrolledCount}`;
  if (enrolledCount === 0) return count;
  return `${count} (${Math.round((completedCount / enrolledCount) * 100)}%)`;
}

/**
 * An amount of money paid, in US cents, as US dollars. Unlike a price, an
 * amount of zero is "$0.00" and not "Free".
 */
export function formatAmountPaid(cents: number): string {
  return cents === 0 ? "$0.00" : formatPrice(cents);
}
