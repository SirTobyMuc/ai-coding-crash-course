import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  enrollUser,
  findEnrollment,
  recordCompletionIfEarned,
  unenrollUser,
} from "./enrollmentService";
import { redeemCoupon } from "./couponService";
import { markLessonComplete, resetLessonProgress } from "./progressService";
import {
  createQuiz,
  createQuestion,
  createOption,
  recordAttempt,
} from "./quizService";
import { computeResult } from "./quizScoringService";

// A student becomes Completed on a course through the existing operations for
// completing a lesson and recording a quiz attempt (ADR 0001).

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

function addCourse(slug: string) {
  return testDb
    .insert(schema.courses)
    .values({
      title: slug,
      slug,
      description: "Another course",
      salesCopy: "Sales copy",
      instructorId: base.instructor.id,
      categoryId: base.category.id,
      status: schema.CourseStatus.Published,
    })
    .returning()
    .get();
}

function completedAt(userId: number, courseId: number) {
  return findEnrollment(userId, courseId)?.completedAt;
}

describe("course completion", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("completing a lesson", () => {
    it("marks the enrollment as Completed on the last outstanding lesson of a course without quizzes", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
      const [first, last] = addLessons(base.course.id, 2);
      enrollUser(base.user.id, base.course.id, false, false);

      markLessonComplete(base.user.id, first.id);
      expect(completedAt(base.user.id, base.course.id)).toBeNull();

      markLessonComplete(base.user.id, last.id);
      expect(completedAt(base.user.id, base.course.id)).toBe(
        "2026-03-01T10:00:00.000Z"
      );
    });

    it("does not mark the enrollment as Completed while a quiz is still not Passed", () => {
      const [first, last] = addLessons(base.course.id, 2);
      createQuiz(first.id, "Quiz", 0.7);
      enrollUser(base.user.id, base.course.id, false, false);

      markLessonComplete(base.user.id, first.id);
      markLessonComplete(base.user.id, last.id);

      expect(completedAt(base.user.id, base.course.id)).toBeNull();
    });
  });

  describe("recording a quiz attempt", () => {
    it("marks the enrollment as Completed on passing the last outstanding quiz when all lessons are completed", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
      const [lesson] = addLessons(base.course.id, 1);
      const quiz = createQuiz(lesson.id, "Quiz", 0.7);
      enrollUser(base.user.id, base.course.id, false, false);
      markLessonComplete(base.user.id, lesson.id);

      vi.setSystemTime(new Date("2026-03-02T10:00:00.000Z"));
      recordAttempt(base.user.id, quiz.id, 0.9, true);

      expect(completedAt(base.user.id, base.course.id)).toBe(
        "2026-03-02T10:00:00.000Z"
      );
    });

    it("does not mark the enrollment as Completed on a failed attempt", () => {
      const [lesson] = addLessons(base.course.id, 1);
      const quiz = createQuiz(lesson.id, "Quiz", 0.7);
      enrollUser(base.user.id, base.course.id, false, false);
      markLessonComplete(base.user.id, lesson.id);

      recordAttempt(base.user.id, quiz.id, 0.4, false);

      expect(completedAt(base.user.id, base.course.id)).toBeNull();
    });

    it("does not count another student's pass", () => {
      const [lesson] = addLessons(base.course.id, 1);
      const quiz = createQuiz(lesson.id, "Quiz", 0.7);
      enrollUser(base.user.id, base.course.id, false, false);
      markLessonComplete(base.user.id, lesson.id);

      recordAttempt(base.instructor.id, quiz.id, 0.9, true);
      recordAttempt(base.user.id, quiz.id, 0.4, false);

      expect(completedAt(base.user.id, base.course.id)).toBeNull();
    });

    it("keeps a quiz Passed when a failed attempt follows a pass", () => {
      const [first, last] = addLessons(base.course.id, 2);
      const quiz = createQuiz(first.id, "Quiz", 0.7);
      enrollUser(base.user.id, base.course.id, false, false);
      markLessonComplete(base.user.id, first.id);

      recordAttempt(base.user.id, quiz.id, 0.9, true);
      recordAttempt(base.user.id, quiz.id, 0.4, false);
      expect(completedAt(base.user.id, base.course.id)).toBeNull();

      markLessonComplete(base.user.id, last.id);
      expect(completedAt(base.user.id, base.course.id)).not.toBeNull();
    });

    it("does not mark the enrollment as Completed on a pass while a lesson is still outstanding", () => {
      const [first] = addLessons(base.course.id, 2);
      const quiz = createQuiz(first.id, "Quiz", 0.7);
      enrollUser(base.user.id, base.course.id, false, false);
      markLessonComplete(base.user.id, first.id);

      recordAttempt(base.user.id, quiz.id, 0.9, true);

      expect(completedAt(base.user.id, base.course.id)).toBeNull();
    });

    it("leaves a Completed student Completed when a failed attempt follows completion", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
      const [lesson] = addLessons(base.course.id, 1);
      const quiz = createQuiz(lesson.id, "Quiz", 0.7);
      enrollUser(base.user.id, base.course.id, false, false);
      markLessonComplete(base.user.id, lesson.id);
      recordAttempt(base.user.id, quiz.id, 0.9, true);

      vi.setSystemTime(new Date("2026-04-01T10:00:00.000Z"));
      recordAttempt(base.user.id, quiz.id, 0.4, false);

      expect(completedAt(base.user.id, base.course.id)).toBe(
        "2026-03-01T10:00:00.000Z"
      );
    });

    it("marks the enrollment as Completed when a submitted quiz is scored as passed", () => {
      const [lesson] = addLessons(base.course.id, 1);
      const quiz = createQuiz(lesson.id, "Quiz", 0.7);
      const question = createQuestion(
        quiz.id,
        "Is this the last quiz?",
        schema.QuestionType.TrueFalse,
        null
      );
      const right = createOption(question.id, "True", true);
      createOption(question.id, "False", false);
      enrollUser(base.user.id, base.course.id, false, false);
      markLessonComplete(base.user.id, lesson.id);

      const result = computeResult(base.user.id, quiz.id, {
        [question.id]: right.id,
      });

      expect(result.passed).toBe(true);
      expect(completedAt(base.user.id, base.course.id)).not.toBeNull();
    });
  });

  describe("permanence", () => {
    function completeSingleLessonCourse() {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
      const [lesson] = addLessons(base.course.id, 1);
      enrollUser(base.user.id, base.course.id, false, false);
      markLessonComplete(base.user.id, lesson.id);
      vi.setSystemTime(new Date("2026-04-01T10:00:00.000Z"));
      return lesson;
    }

    it("leaves the student Completed with the original date when a lesson is added later", () => {
      completeSingleLessonCourse();

      const [added] = addLessons(base.course.id, 1);
      expect(completedAt(base.user.id, base.course.id)).toBe(
        "2026-03-01T10:00:00.000Z"
      );

      markLessonComplete(base.user.id, added.id);
      expect(completedAt(base.user.id, base.course.id)).toBe(
        "2026-03-01T10:00:00.000Z"
      );
    });

    it("leaves the student Completed with the original date when a quiz is added later", () => {
      const lesson = completeSingleLessonCourse();

      const quiz = createQuiz(lesson.id, "Added quiz", 0.7);
      recordAttempt(base.user.id, quiz.id, 0.2, false);
      recordAttempt(base.user.id, quiz.id, 0.9, true);

      expect(completedAt(base.user.id, base.course.id)).toBe(
        "2026-03-01T10:00:00.000Z"
      );
    });

    it("leaves the student Completed with the original date when a lesson's status changes afterwards", () => {
      const lesson = completeSingleLessonCourse();

      resetLessonProgress(base.user.id, lesson.id);
      expect(completedAt(base.user.id, base.course.id)).toBe(
        "2026-03-01T10:00:00.000Z"
      );

      markLessonComplete(base.user.id, lesson.id);
      expect(completedAt(base.user.id, base.course.id)).toBe(
        "2026-03-01T10:00:00.000Z"
      );
    });
  });

  describe("enrolling", () => {
    // A student who already meets the rule when an enrollment is created, e.g.
    // after unenrolling and enrolling again (#10), is Completed straight away,
    // dated to their last qualifying activity as the backfill would date it.

    it("marks a re-enrollment as Completed, dated to the last qualifying activity", () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"));
      const [lesson] = addLessons(base.course.id, 1);
      const quiz = createQuiz(lesson.id, "Quiz", 0.7);
      enrollUser(base.user.id, base.course.id, false, false);
      markLessonComplete(base.user.id, lesson.id);
      vi.setSystemTime(new Date("2026-03-02T10:00:00.000Z"));
      recordAttempt(base.user.id, quiz.id, 0.9, true);

      unenrollUser(base.user.id, base.course.id);
      vi.setSystemTime(new Date("2026-04-01T10:00:00.000Z"));
      const enrollment = enrollUser(base.user.id, base.course.id, false, false);

      expect(enrollment.completedAt).toBe("2026-03-02T10:00:00.000Z");
      expect(completedAt(base.user.id, base.course.id)).toBe(
        "2026-03-02T10:00:00.000Z"
      );
    });

    it("does not mark a re-enrollment as Completed when the course has gained a lesson since", () => {
      const [lesson] = addLessons(base.course.id, 1);
      enrollUser(base.user.id, base.course.id, false, false);
      markLessonComplete(base.user.id, lesson.id);
      unenrollUser(base.user.id, base.course.id);

      addLessons(base.course.id, 1);
      enrollUser(base.user.id, base.course.id, false, false);

      expect(completedAt(base.user.id, base.course.id)).toBeNull();
    });

    it("does not mark a first enrollment without activity as Completed", () => {
      addLessons(base.course.id, 1);

      const enrollment = enrollUser(base.user.id, base.course.id, false, false);

      expect(enrollment.completedAt).toBeNull();
    });

    it("marks an enrollment from a redeemed team seat as Completed when the student already qualifies", () => {
      const [lesson] = addLessons(base.course.id, 1);
      enrollUser(base.user.id, base.course.id, false, false);
      markLessonComplete(base.user.id, lesson.id);
      unenrollUser(base.user.id, base.course.id);

      const team = testDb.insert(schema.teams).values({}).returning().get();
      const purchase = testDb
        .insert(schema.purchases)
        .values({
          userId: base.instructor.id,
          courseId: base.course.id,
          amountPaid: 10000,
        })
        .returning()
        .get();
      testDb
        .insert(schema.coupons)
        .values({
          teamId: team.id,
          courseId: base.course.id,
          code: "seat-1",
          purchaseId: purchase.id,
        })
        .run();

      const result = redeemCoupon("seat-1", base.user.id, "US");

      expect(result.ok).toBe(true);
      expect(completedAt(base.user.id, base.course.id)).not.toBeNull();
    });
  });

  describe("courses and users that cannot complete", () => {
    it("never marks a course with no lessons as Completed", () => {
      const empty = addCourse("empty-course");
      const [lesson] = addLessons(base.course.id, 1);
      const quiz = createQuiz(lesson.id, "Quiz", 0.7);
      enrollUser(base.user.id, empty.id, false, false);

      // Activity elsewhere never reaches the empty course...
      markLessonComplete(base.user.id, lesson.id);
      recordAttempt(base.user.id, quiz.id, 0.9, true);
      expect(completedAt(base.user.id, empty.id)).toBeNull();

      // ...and evaluating the rule for it directly finds nothing to complete.
      recordCompletionIfEarned(base.user.id, empty.id);
      expect(completedAt(base.user.id, empty.id)).toBeNull();
    });

    it("leaves a user without an enrollment on the course unaffected", () => {
      const [lesson] = addLessons(base.course.id, 1);
      const quiz = createQuiz(lesson.id, "Quiz", 0.7);

      markLessonComplete(base.instructor.id, lesson.id);
      recordAttempt(base.instructor.id, quiz.id, 0.9, true);

      expect(
        findEnrollment(base.instructor.id, base.course.id)
      ).toBeUndefined();
    });

    it("completes only the course the lesson belongs to", () => {
      const [lesson] = addLessons(base.course.id, 1);
      const other = addCourse("other-course");
      addLessons(other.id, 1);
      enrollUser(base.user.id, base.course.id, false, false);
      enrollUser(base.user.id, other.id, false, false);

      markLessonComplete(base.user.id, lesson.id);

      expect(completedAt(base.user.id, base.course.id)).not.toBeNull();
      expect(completedAt(base.user.id, other.id)).toBeNull();
    });
  });
});
