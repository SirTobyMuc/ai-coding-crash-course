// One-off backfill: marks every enrollment that already meets the completion
// rule, but has no recorded completion, as Completed (ADR 0001). Safe to run
// more than once. Runs against data.db in the current directory.
//
//   npm run db:backfill-completions
import { backfillCompletions } from "../app/services/enrollmentService";

const completed = backfillCompletions();
console.log(`Backfilled completion for ${completed} enrollment(s).`);
