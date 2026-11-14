import { eq, and, isNull, sql } from "drizzle-orm";
import { db } from "~/db";
import {
  enrollments,
  courses,
  modules,
  lessons,
  lessonProgress,
  quizzes,
  LessonProgressStatus,
} from "~/db/schema";
import { passedQuizzesInCourse } from "~/services/passedQuizService";

// ─── Enrollment Service ───
// Handles enrollment, unenrollment, duplicate prevention, and enrollment validation.
// Uses positional parameters (project convention).

export function getEnrollmentById(id: number) {
  return db.select().from(enrollments).where(eq(enrollments.id, id)).get();
}

export function getEnrollmentsByUser(userId: number) {
  return db
    .select()
    .from(enrollments)
    .where(eq(enrollments.userId, userId))
    .all();
}

export function getEnrollmentsByCourse(courseId: number) {
  return db
    .select()
    .from(enrollments)
    .where(eq(enrollments.courseId, courseId))
    .all();
}

export function getEnrollmentCountForCourse(courseId: number) {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(enrollments)
    .where(eq(enrollments.courseId, courseId))
    .get();

  return result?.count ?? 0;
}

export function findEnrollment(userId: number, courseId: number) {
  return db
    .select()
    .from(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .get();
}

export function isUserEnrolled(userId: number, courseId: number) {
  return !!findEnrollment(userId, courseId);
}

export function enrollUser(
  userId: number,
  courseId: number,
  sendEmail: boolean,
  skipValidation: boolean
) {
  if (!skipValidation) {
    // Check if already enrolled
    const existing = findEnrollment(userId, courseId);
    if (existing) {
      throw new Error("User is already enrolled in this course");
    }

    // Check that the course exists
    const course = db
      .select()
      .from(courses)
      .where(eq(courses.id, courseId))
      .get();
    if (!course) {
      throw new Error("Course not found");
    }
  }

  const enrollment = db
    .insert(enrollments)
    .values({ userId, courseId })
    .returning()
    .get();

  // sendEmail parameter accepted but not implemented (no email service — PRD out of scope)
  if (sendEmail) {
    // Would send welcome email here
  }

  return enrollment;
}

export function unenrollUser(userId: number, courseId: number) {
  const existing = findEnrollment(userId, courseId);
  if (!existing) {
    throw new Error("User is not enrolled in this course");
  }

  return db
    .delete(enrollments)
    .where(
      and(eq(enrollments.userId, userId), eq(enrollments.courseId, courseId))
    )
    .returning()
    .get();
}

// The completion rule (ADR 0001): a student has earned completion of a course
// once every lesson in it is completed and every quiz in it is Passed. Returns
// whether it is earned and, if so, the student's last qualifying activity: the
// later of their latest lesson completion in the course and the first passing
// attempt of the quiz they passed last (null when no such date is recorded).
function evaluateCompletion(
  userId: number,
  courseId: number
): { earned: false } | { earned: true; lastQualifyingActivity: string | null } {
  const lessonCounts = db
    .select({
      total: sql<number>`count(*)`,
      completed: sql<number>`count(${lessonProgress.id})`,
      latestCompletion: sql<string | null>`max(${lessonProgress.completedAt})`,
    })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .leftJoin(
      lessonProgress,
      and(
        eq(lessonProgress.lessonId, lessons.id),
        eq(lessonProgress.userId, userId),
        eq(lessonProgress.status, LessonProgressStatus.Completed)
      )
    )
    .where(eq(modules.courseId, courseId))
    .get();

  if (!lessonCounts || lessonCounts.total === 0) return { earned: false };
  if (lessonCounts.completed < lessonCounts.total) return { earned: false };

  // A quiz counts as Passed from its first passing attempt; a quiz with no
  // passing attempt has no date.
  const passed = passedQuizzesInCourse(courseId, userId);
  const firstPasses = db
    .select({ firstPassedAt: passed.firstPassedAt })
    .from(quizzes)
    .innerJoin(lessons, eq(quizzes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .leftJoin(passed, eq(passed.quizId, quizzes.id))
    .where(eq(modules.courseId, courseId))
    .all();

  if (firstPasses.some((quiz) => quiz.firstPassedAt === null)) {
    return { earned: false };
  }

  const dates = [
    lessonCounts.latestCompletion,
    ...firstPasses.map((quiz) => quiz.firstPassedAt),
  ].filter((date): date is string => date !== null);
  const lastQualifyingActivity = dates.length
    ? dates.reduce((latest, date) => (date > latest ? date : latest))
    : null;

  return { earned: true, lastQualifyingActivity };
}

// Records completion on an enrollment that has none yet. Completion is
// permanent, so an existing completion date is never changed.
function setCompletionIfAbsent(enrollmentId: number, completedAt: string) {
  return (
    db
      .update(enrollments)
      .set({ completedAt })
      .where(
        and(eq(enrollments.id, enrollmentId), isNull(enrollments.completedAt))
      )
      .run().changes > 0
  );
}

// Records that a student has Completed a course, if they have just earned it,
// dated now. An enrollment that is already Completed keeps its original date,
// and a user without an enrollment is unaffected.
export function recordCompletionIfEarned(userId: number, courseId: number) {
  const enrollment = findEnrollment(userId, courseId);
  if (!enrollment || enrollment.completedAt) return;

  if (!evaluateCompletion(userId, courseId).earned) return;

  setCompletionIfAbsent(enrollment.id, new Date().toISOString());
}

// One-off backfill for students who met the completion rule before completion
// was recorded. Every enrollment without a completion that meets the rule is
// marked Completed, dated to the student's last qualifying activity (falling
// back to the enrollment date if no activity date is recorded). Enrollments
// that already have a completion are never touched, so running it again
// changes nothing. Returns the number of enrollments it marked Completed.
export function backfillCompletions() {
  const pending = db
    .select()
    .from(enrollments)
    .where(isNull(enrollments.completedAt))
    .all();

  let completed = 0;
  for (const enrollment of pending) {
    const result = evaluateCompletion(enrollment.userId, enrollment.courseId);
    if (!result.earned) continue;

    const date = result.lastQualifyingActivity ?? enrollment.enrolledAt;
    if (setCompletionIfAbsent(enrollment.id, date)) completed++;
  }
  return completed;
}

// Evaluates completion for the course a lesson belongs to.
export function recordCompletionIfEarnedForLesson(
  userId: number,
  lessonId: number
) {
  const lessonCourse = db
    .select({ courseId: modules.courseId })
    .from(lessons)
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .where(eq(lessons.id, lessonId))
    .get();

  if (lessonCourse) recordCompletionIfEarned(userId, lessonCourse.courseId);
}

export function getUserEnrolledCourses(userId: number) {
  return db
    .select({
      enrollmentId: enrollments.id,
      courseId: enrollments.courseId,
      enrolledAt: enrollments.enrolledAt,
      completedAt: enrollments.completedAt,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      courseDescription: courses.description,
      coverImageUrl: courses.coverImageUrl,
    })
    .from(enrollments)
    .innerJoin(courses, eq(enrollments.courseId, courses.id))
    .where(eq(enrollments.userId, userId))
    .all();
}

export function getCourseEnrolledStudents(courseId: number) {
  return db
    .select({
      enrollmentId: enrollments.id,
      userId: enrollments.userId,
      enrolledAt: enrollments.enrolledAt,
      completedAt: enrollments.completedAt,
    })
    .from(enrollments)
    .where(eq(enrollments.courseId, courseId))
    .all();
}
