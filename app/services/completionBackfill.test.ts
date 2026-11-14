import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

// Import after mock so the modules pick up our test db
import {
  backfillCompletions,
  enrollUser,
  findEnrollment,
} from "./enrollmentService";

// Students who met the completion rule before completion was recorded are
// backfilled as Completed, dated to their last qualifying activity (ADR 0001).
// Their progress is inserted directly, as it was written before recording
// existed, so live recording does not run.

function addLessons(courseId: number, count: number) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: "Module", position: 1 })
    .returning()
    .get();

  const created = [];
  for (let i = 0; i < count; i++) {
    created.push(
      testDb
        .insert(schema.lessons)
        .values({ moduleId: mod.id, title: `Lesson ${i + 1}`, position: i + 1 })
        .returning()
        .get()
    );
  }
  return created;
}

function addQuiz(lessonId: number) {
  return testDb
    .insert(schema.quizzes)
    .values({ lessonId, title: "Quiz", passingScore: 0.7 })
    .returning()
    .get();
}

function lessonCompletedOn(userId: number, lessonId: number, date: string) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
      completedAt: date,
    })
    .run();
}

function attemptOn(
  userId: number,
  quizId: number,
  passed: boolean,
  date: string
) {
  testDb
    .insert(schema.quizAttempts)
    .values({
      userId,
      quizId,
      score: passed ? 0.9 : 0.3,
      passed,
      attemptedAt: date,
    })
    .run();
}

function completedAt(userId: number, courseId: number) {
  return findEnrollment(userId, courseId)?.completedAt;
}

describe("completion backfill", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  it("dates a qualifying enrollment to its latest lesson completion when that came last", () => {
    const [first, second] = addLessons(base.course.id, 2);
    const quiz = addQuiz(first.id);
    enrollUser(base.user.id, base.course.id, false, false);
    lessonCompletedOn(base.user.id, first.id, "2026-01-01T10:00:00.000Z");
    attemptOn(base.user.id, quiz.id, true, "2026-01-02T10:00:00.000Z");
    lessonCompletedOn(base.user.id, second.id, "2026-01-05T10:00:00.000Z");

    backfillCompletions();

    expect(completedAt(base.user.id, base.course.id)).toBe(
      "2026-01-05T10:00:00.000Z"
    );
  });

  it("dates a qualifying enrollment to the first passing attempt of the quiz passed last when that came last", () => {
    const [first, second] = addLessons(base.course.id, 2);
    const early = addQuiz(first.id);
    const late = addQuiz(second.id);
    enrollUser(base.user.id, base.course.id, false, false);
    lessonCompletedOn(base.user.id, first.id, "2026-01-01T10:00:00.000Z");
    lessonCompletedOn(base.user.id, second.id, "2026-01-02T10:00:00.000Z");
    attemptOn(base.user.id, early.id, true, "2026-01-03T10:00:00.000Z");
    attemptOn(base.user.id, late.id, false, "2026-01-04T10:00:00.000Z");
    attemptOn(base.user.id, late.id, true, "2026-01-06T10:00:00.000Z");
    attemptOn(base.user.id, late.id, true, "2026-01-09T10:00:00.000Z");
    attemptOn(base.user.id, early.id, true, "2026-01-12T10:00:00.000Z");

    backfillCompletions();

    expect(completedAt(base.user.id, base.course.id)).toBe(
      "2026-01-06T10:00:00.000Z"
    );
  });

  it("leaves an enrollment with a lesson not completed untouched", () => {
    const [first] = addLessons(base.course.id, 2);
    enrollUser(base.user.id, base.course.id, false, false);
    lessonCompletedOn(base.user.id, first.id, "2026-01-01T10:00:00.000Z");

    expect(backfillCompletions()).toBe(0);
    expect(completedAt(base.user.id, base.course.id)).toBeNull();
  });

  it("leaves an enrollment with a quiz not Passed untouched", () => {
    const [lesson] = addLessons(base.course.id, 1);
    const quiz = addQuiz(lesson.id);
    enrollUser(base.user.id, base.course.id, false, false);
    lessonCompletedOn(base.user.id, lesson.id, "2026-01-01T10:00:00.000Z");
    attemptOn(base.user.id, quiz.id, false, "2026-01-02T10:00:00.000Z");

    expect(backfillCompletions()).toBe(0);
    expect(completedAt(base.user.id, base.course.id)).toBeNull();
  });

  it("keeps the original date of an enrollment that already has a completion", () => {
    const [lesson] = addLessons(base.course.id, 1);
    enrollUser(base.user.id, base.course.id, false, false);
    lessonCompletedOn(base.user.id, lesson.id, "2026-01-05T10:00:00.000Z");
    testDb
      .update(schema.enrollments)
      .set({ completedAt: "2026-02-01T10:00:00.000Z" })
      .run();

    expect(backfillCompletions()).toBe(0);
    expect(completedAt(base.user.id, base.course.id)).toBe(
      "2026-02-01T10:00:00.000Z"
    );
  });

  it("changes nothing when run a second time", () => {
    const [lesson] = addLessons(base.course.id, 1);
    enrollUser(base.user.id, base.course.id, false, false);
    lessonCompletedOn(base.user.id, lesson.id, "2026-01-05T10:00:00.000Z");

    expect(backfillCompletions()).toBe(1);
    expect(backfillCompletions()).toBe(0);
    expect(completedAt(base.user.id, base.course.id)).toBe(
      "2026-01-05T10:00:00.000Z"
    );
  });
});
