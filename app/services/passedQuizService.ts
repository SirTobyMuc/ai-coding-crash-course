import { and, eq, min } from "drizzle-orm";
import { db } from "~/db";
import { lessons, modules, quizAttempts, quizzes } from "~/db/schema";

// ─── Passed Quiz Service ───
// The one definition of a quiz being Passed (GLOSSARY.md): a student has
// passed a quiz once any one of their attempts passed, whatever came after it.
// Completion recording and instructor reporting both build on it.

/**
 * One row per (student, quiz) in the course that the student has Passed, with
 * the date of their first passing attempt — the moment it became Passed.
 * Narrowed to one student when `userId` is given. Use it as a subquery.
 */
export function passedQuizzesInCourse(courseId: number, userId?: number) {
  return db
    .select({
      userId: quizAttempts.userId,
      quizId: quizAttempts.quizId,
      firstPassedAt: min(quizAttempts.attemptedAt).as("first_passed_at"),
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizzes.id, quizAttempts.quizId))
    .innerJoin(lessons, eq(lessons.id, quizzes.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(
      and(
        eq(modules.courseId, courseId),
        eq(quizAttempts.passed, true),
        userId === undefined ? undefined : eq(quizAttempts.userId, userId)
      )
    )
    .groupBy(quizAttempts.userId, quizAttempts.quizId)
    .as("passed_quizzes");
}
