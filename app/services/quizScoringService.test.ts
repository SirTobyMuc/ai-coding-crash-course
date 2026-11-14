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

import { computeResult, getScore } from "./quizScoringService";
import { createOption, createQuestion, createQuiz } from "./quizService";
import { enrollUser, findEnrollment } from "./enrollmentService";
import { markLessonComplete } from "./progressService";

function addLesson() {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "M", position: 1 })
    .returning()
    .get();
  return testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: "L", position: 1 })
    .returning()
    .get();
}

/**
 * A quiz with `questionCount` questions; answering `correct` of them right.
 * Returns the quiz and the answers in both shapes the scoring functions take.
 */
function quizAnswered(
  lessonId: number,
  passingScore: number,
  questionCount: number,
  correct: number
) {
  const quiz = createQuiz(lessonId, "Q", passingScore);
  const selected: Record<number, number> = {};
  const answers: { questionId: number; selectedOptionId: number }[] = [];
  for (let i = 0; i < questionCount; i++) {
    const q = createQuestion(
      quiz.id,
      `Q${i}`,
      schema.QuestionType.MultipleChoice,
      i + 1
    );
    const right = createOption(q.id, "right", true);
    const wrong = createOption(q.id, "wrong", false);
    const pick = i < correct ? right.id : wrong.id;
    selected[q.id] = pick;
    answers.push({ questionId: q.id, selectedOptionId: pick });
  }
  return { quiz, selected, answers };
}

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});

describe("quiz pass/fail uses the quiz's passing score", () => {
  const cases = [
    { passingScore: 0.9, questions: 5, correct: 4, passed: false },
    { passingScore: 0.5, questions: 5, correct: 3, passed: true },
    { passingScore: 0.6, questions: 20, correct: 13, passed: true },
    { passingScore: 0.7, questions: 10, correct: 7, passed: true },
    { passingScore: 0.7, questions: 10, correct: 6, passed: false },
    { passingScore: 0.6, questions: 5, correct: 3, passed: true },
  ];

  for (const c of cases) {
    const label = `${c.correct}/${c.questions} at a ${c.passingScore * 100}% passing score is ${c.passed ? "Passed" : "not Passed"}`;

    it(`computeResult: ${label}`, () => {
      const { quiz, selected } = quizAnswered(
        addLesson().id,
        c.passingScore,
        c.questions,
        c.correct
      );
      const result = computeResult(base.user.id, quiz.id, selected);
      expect(result.passed).toBe(c.passed);
      const stored = testDb
        .select()
        .from(schema.quizAttempts)
        .all()
        .find((a) => a.id === result.attemptId)!;
      expect(stored.passed).toBe(c.passed);
    });

    it(`getScore: ${label}`, () => {
      const { quiz, answers } = quizAnswered(
        addLesson().id,
        c.passingScore,
        c.questions,
        c.correct
      );
      expect(getScore(quiz.id, answers).passed).toBe(c.passed);
    });
  }

  it("does not record completion for a score below a high passing score", () => {
    const lesson = addLesson();
    enrollUser(base.user.id, base.course.id, false, false);
    const { quiz, selected } = quizAnswered(lesson.id, 0.9, 5, 4);
    markLessonComplete(base.user.id, lesson.id);
    expect(findEnrollment(base.user.id, base.course.id)?.completedAt).toBeNull();
    computeResult(base.user.id, quiz.id, selected);
    expect(findEnrollment(base.user.id, base.course.id)?.completedAt).toBeNull();
  });

  it("records completion for a score at a low passing score", () => {
    const lesson = addLesson();
    enrollUser(base.user.id, base.course.id, false, false);
    const { quiz, selected } = quizAnswered(lesson.id, 0.5, 5, 3);
    markLessonComplete(base.user.id, lesson.id);
    expect(findEnrollment(base.user.id, base.course.id)?.completedAt).toBeNull();
    computeResult(base.user.id, quiz.id, selected);
    expect(
      findEnrollment(base.user.id, base.course.id)?.completedAt
    ).not.toBeNull();
  });
});
