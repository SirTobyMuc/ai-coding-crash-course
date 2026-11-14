import { count, eq, sum } from "drizzle-orm";
import { db } from "~/db";
import { courses, enrollments, purchases } from "~/db/schema";

// ─── Instructor Reporting Service ───
// Read-side numbers for instructors: how their courses are doing.
// Vocabulary follows GLOSSARY.md (Student, Enrollment, Purchase, Total Paid,
// Completed). All numbers are all-time; amounts are integer US cents.

export type CourseSummary = {
  courseId: number;
  /** Number of enrollments on the course, however obtained. */
  enrolledCount: number;
  /** Sum of all purchases for the course, in US cents. */
  totalPaid: number;
  /** Number of enrollments with a recorded completion. */
  completedCount: number;
};

/**
 * One summary per course the instructor owns, in any status.
 */
export function getCourseSummariesForInstructor(
  instructorId: number
): CourseSummary[] {
  // Enrollments and purchases are separate records with no link between
  // them, so each is aggregated per course on its own and merged here.
  const enrollmentRows = db
    .select({
      courseId: courses.id,
      enrolledCount: count(enrollments.id),
      completedCount: count(enrollments.completedAt),
    })
    .from(courses)
    .leftJoin(enrollments, eq(enrollments.courseId, courses.id))
    .where(eq(courses.instructorId, instructorId))
    .groupBy(courses.id)
    .orderBy(courses.id)
    .all();

  const purchaseRows = db
    .select({
      courseId: purchases.courseId,
      totalPaid: sum(purchases.amountPaid).mapWith(Number),
    })
    .from(purchases)
    .innerJoin(courses, eq(courses.id, purchases.courseId))
    .where(eq(courses.instructorId, instructorId))
    .groupBy(purchases.courseId)
    .all();

  const totalPaidByCourse = new Map(
    purchaseRows.map((row) => [row.courseId, row.totalPaid])
  );

  return enrollmentRows.map((row) => ({
    courseId: row.courseId,
    enrolledCount: row.enrolledCount,
    totalPaid: totalPaidByCourse.get(row.courseId) ?? 0,
    completedCount: row.completedCount,
  }));
}
