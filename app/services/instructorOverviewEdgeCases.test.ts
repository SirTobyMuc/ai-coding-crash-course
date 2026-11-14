// Edge cases for the instructor course overview (issues #2–#7): course
// completion as a permanent recorded fact (ADR 0001), the backfill, and the
// reporting numbers on "My Courses" and the per-course drill-down.
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

import {
  enrollUser,
  findEnrollment,
  unenrollUser,
  backfillCompletions,
} from "./enrollmentService";
import {
  markLessonComplete,
  markLessonInProgress,
  resetLessonProgress,
} from "./progressService";
import {
  createQuiz,
  createQuestion,
  createOption,
  recordAttempt,
} from "./quizService";
import {
  getCourseDrillDown,
  getCourseSummariesForInstructor,
} from "./instructorReportingService";

let n = 0;
const addUser = (name: string) =>
  testDb
    .insert(schema.users)
    .values({ name, email: `edge-${++n}@x.com`, role: schema.UserRole.Student })
    .returning()
    .get();

function addCourse(slug: string, instructorId = base.instructor.id) {
  return testDb
    .insert(schema.courses)
    .values({
      title: slug,
      slug,
      description: "d",
      salesCopy: "s",
      instructorId,
      categoryId: base.category.id,
      status: schema.CourseStatus.Draft,
    })
    .returning()
    .get();
}

function addLessons(courseId: number, count: number) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: "M", position: 1 })
    .returning()
    .get();
  return Array.from({ length: count }, (_, i) =>
    testDb
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title: `L${i + 1}`, position: i + 1 })
      .returning()
      .get()
  );
}

const completedAt = (u: number, c: number) => findEnrollment(u, c)?.completedAt;

function purchase(userId: number, courseId: number, amountPaid: number) {
  return testDb
    .insert(schema.purchases)
    .values({ userId, courseId, amountPaid })
    .returning()
    .get();
}

function teamSeats(
  buyerId: number,
  courseId: number,
  amount: number,
  redeemers: (number | null)[]
) {
  const team = testDb.insert(schema.teams).values({}).returning().get();
  const p = purchase(buyerId, courseId, amount);
  redeemers.forEach((r, i) => {
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId,
        code: `c-${p.id}-${i}`,
        purchaseId: p.id,
        redeemedByUserId: r,
        redeemedAt: r ? new Date().toISOString() : null,
      })
      .run();
    if (r && !findEnrollment(r, courseId)) enrollUser(r, courseId, false, true);
  });
  return p;
}

/** A one-question quiz; returns ids needed to answer right/wrong. */
function oneQuestionQuiz(lessonId: number, passingScore: number) {
  const quiz = createQuiz(lessonId, "Q", passingScore);
  const q = createQuestion(quiz.id, "?", schema.QuestionType.MultipleChoice, 1);
  const right = createOption(q.id, "right", true);
  const wrong = createOption(q.id, "wrong", false);
  return { quiz, q, right, wrong };
}

beforeEach(() => {
  testDb = createTestDb();
  base = seedBaseData(testDb);
});
afterEach(() => vi.useRealTimers());

describe("completion edge cases", () => {
  it("E1 a later failed attempt does not undo a Passed quiz", () => {
    const [l] = addLessons(base.course.id, 1);
    const { quiz } = oneQuestionQuiz(l.id, 0.7);
    enrollUser(base.user.id, base.course.id, false, false);
    recordAttempt(base.user.id, quiz.id, 1, true);
    recordAttempt(base.user.id, quiz.id, 0, false);
    markLessonComplete(base.user.id, l.id);
    expect(completedAt(base.user.id, base.course.id)).not.toBeNull();
  });

  it("E2 resetting or re-opening a lesson after completion keeps the completion date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const [l] = addLessons(base.course.id, 1);
    enrollUser(base.user.id, base.course.id, false, false);
    markLessonComplete(base.user.id, l.id);
    markLessonInProgress(base.user.id, l.id);
    resetLessonProgress(base.user.id, l.id);
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
    markLessonComplete(base.user.id, l.id);
    expect(completedAt(base.user.id, base.course.id)).toBe(
      "2026-01-01T00:00:00.000Z"
    );
  });

  it("E3 a lesson added after completion leaves the student Completed (permanent fact)", () => {
    const [l] = addLessons(base.course.id, 1);
    enrollUser(base.user.id, base.course.id, false, false);
    markLessonComplete(base.user.id, l.id);
    addLessons(base.course.id, 1);
    const s = getCourseDrillDown(base.course.id).students[0];
    expect(s.completedAt).not.toBeNull();
    expect(s.progress).toBe(50); // Completed but 50% — shown as-is
  });

  it("E4 activity in another course does not complete this one", () => {
    const other = addCourse("other");
    const [mine] = addLessons(base.course.id, 2);
    const [theirs] = addLessons(other.id, 1);
    enrollUser(base.user.id, base.course.id, false, false);
    enrollUser(base.user.id, other.id, false, false);
    markLessonComplete(base.user.id, mine.id);
    markLessonComplete(base.user.id, theirs.id);
    expect(completedAt(base.user.id, base.course.id)).toBeNull();
    expect(completedAt(base.user.id, other.id)).not.toBeNull();
  });

  it("E5 a non-enrolled user completing every lesson creates no enrollment", () => {
    const [l] = addLessons(base.course.id, 1);
    markLessonComplete(base.user.id, l.id);
    expect(findEnrollment(base.user.id, base.course.id)).toBeUndefined();
  });

  it("E6 a course with modules but no lessons is never Completed, even by backfill", () => {
    testDb
      .insert(schema.modules)
      .values({ courseId: base.course.id, title: "M", position: 1 })
      .run();
    enrollUser(base.user.id, base.course.id, false, false);
    expect(backfillCompletions()).toBe(0);
    expect(completedAt(base.user.id, base.course.id)).toBeNull();
  });

  it("E7 backfill falls back to enrolledAt when lesson progress has no date, and is idempotent", () => {
    const [l] = addLessons(base.course.id, 1);
    const e = enrollUser(base.user.id, base.course.id, false, false);
    testDb
      .insert(schema.lessonProgress)
      .values({
        userId: base.user.id,
        lessonId: l.id,
        status: schema.LessonProgressStatus.Completed,
        completedAt: null,
      })
      .run();
    expect(backfillCompletions()).toBe(1);
    expect(completedAt(base.user.id, base.course.id)).toBe(e.enrolledAt);
    expect(backfillCompletions()).toBe(0);
  });
});

describe("reporting edge cases", () => {
  it("R1 a student holding seats from two team purchases is attributed to one of the buyers", () => {
    const a = addUser("Buyer A");
    const b = addUser("Buyer B");
    const s = addUser("Student");
    teamSeats(a.id, base.course.id, 10000, [s.id]);
    teamSeats(b.id, base.course.id, 20000, [s.id]);
    const row = getCourseDrillDown(base.course.id).students.find(
      (x) => x.userId === s.id
    )!;
    // teamBuyer can name only one buyer, so the other is not shown.
    expect([a.id, b.id]).toContain(row.teamBuyer?.userId);
  });

  it("R2 Total Paid invariant holds across a messy mix", () => {
    const solo = addUser("Solo");
    const dbl = addUser("Bought twice then left");
    const teamBuyer = addUser("Team buyer, enrolled");
    const ghostBuyer = addUser("Team buyer, never enrolled");
    const seat1 = addUser("Seat 1");
    const free = addUser("Free (0 cents)");

    enrollUser(solo.id, base.course.id, false, false);
    purchase(solo.id, base.course.id, 4999);
    enrollUser(dbl.id, base.course.id, false, false);
    purchase(dbl.id, base.course.id, 1000);
    purchase(dbl.id, base.course.id, 2000);
    unenrollUser(dbl.id, base.course.id);
    teamSeats(teamBuyer.id, base.course.id, 30000, [
      teamBuyer.id,
      seat1.id,
      null,
    ]);
    teamSeats(ghostBuyer.id, base.course.id, 15000, [null, null]);
    enrollUser(free.id, base.course.id, false, false);
    purchase(free.id, base.course.id, 0);
    // seat1 also bought it themselves (double pay)
    purchase(seat1.id, base.course.id, 4999);

    const total = getCourseSummariesForInstructor(base.instructor.id).find(
      (c) => c.courseId === base.course.id
    )!.totalPaid;
    const d = getCourseDrillDown(base.course.id);
    const sum =
      d.students.reduce((t, s) => t + s.amountPaid, 0) +
      d.purchasesWithoutEnrollment.reduce((t, p) => t + p.amountPaid, 0);
    expect(total).toBe(4999 + 3000 + 30000 + 15000 + 0 + 4999);
    expect(sum).toBe(total);
    expect(d.purchasesWithoutEnrollment.length).toBe(3); // dbl x2 + ghost
    const tb = d.students.find((s) => s.userId === teamBuyer.id)!;
    expect(tb.teamBuyer).toBeNull();
    expect(tb.teamPurchase).toEqual({ seatsBought: 3, seatsRedeemed: 2 });
    const s1 = d.students.find((s) => s.userId === seat1.id)!;
    expect(s1.teamBuyer?.userId).toBe(teamBuyer.id);
    expect(s1.amountPaid).toBe(4999);
  });

  it("R3 summaries: empty draft courses included, other instructors excluded", () => {
    const empty = addCourse("empty-draft");
    const otherInstr = testDb
      .insert(schema.users)
      .values({
        name: "Other",
        email: "o@x.com",
        role: schema.UserRole.Instructor,
      })
      .returning()
      .get();
    addCourse("not-mine", otherInstr.id);
    const rows = getCourseSummariesForInstructor(base.instructor.id);
    expect(rows.map((r) => r.courseId).sort()).toEqual(
      [base.course.id, empty.id].sort()
    );
    expect(rows.find((r) => r.courseId === empty.id)).toEqual({
      courseId: empty.id,
      enrolledCount: 0,
      totalPaid: 0,
      completedCount: 0,
    });
  });

  it("R4 in-progress lessons do not count toward progress", () => {
    const [a, b] = addLessons(base.course.id, 2);
    enrollUser(base.user.id, base.course.id, false, false);
    markLessonComplete(base.user.id, a.id);
    markLessonInProgress(base.user.id, b.id);
    expect(getCourseDrillDown(base.course.id).students[0].progress).toBe(50);
  });

  it("R5 progress rounds (1 of 3 lessons = 33%)", () => {
    const [a] = addLessons(base.course.id, 3);
    enrollUser(base.user.id, base.course.id, false, false);
    markLessonComplete(base.user.id, a.id);
    expect(getCourseDrillDown(base.course.id).students[0].progress).toBe(33);
  });
});
