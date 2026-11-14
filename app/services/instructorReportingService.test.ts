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

// Import after mock so the module picks up our test db
import {
  getBestQuizScores,
  getCourseDrillDown,
  getCourseSummariesForInstructor,
  getRosterQuizzes,
} from "./instructorReportingService";
import { unenrollUser } from "./enrollmentService";

let userCounter = 0;

function addUser(name: string, role = schema.UserRole.Student) {
  userCounter += 1;
  return testDb
    .insert(schema.users)
    .values({ name, email: `user-${userCounter}@example.com`, role })
    .returning()
    .get();
}

function addCourse(
  instructorId: number,
  slug: string,
  status = schema.CourseStatus.Published
) {
  return testDb
    .insert(schema.courses)
    .values({
      title: slug,
      slug,
      description: "A course",
      salesCopy: "Sales copy",
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

function enroll(userId: number, courseId: number, completedAt?: string) {
  return testDb
    .insert(schema.enrollments)
    .values({ userId, courseId, completedAt })
    .returning()
    .get();
}

function purchase(userId: number, courseId: number, amountPaid: number) {
  return testDb
    .insert(schema.purchases)
    .values({ userId, courseId, amountPaid })
    .returning()
    .get();
}

/** A team purchase: one purchase plus `seats` team seats, some redeemed. */
function teamPurchase(
  buyerId: number,
  courseId: number,
  amountPaid: number,
  seats: number,
  redeemerIds: number[]
) {
  const team = testDb.insert(schema.teams).values({}).returning().get();
  const bought = purchase(buyerId, courseId, amountPaid);
  for (let i = 0; i < seats; i++) {
    const redeemerId = redeemerIds[i];
    testDb
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId,
        code: `seat-${bought.id}-${i}`,
        purchaseId: bought.id,
        redeemedByUserId: redeemerId ?? null,
        redeemedAt: redeemerId ? new Date().toISOString() : null,
      })
      .run();
    if (redeemerId) enroll(redeemerId, courseId);
  }
  return bought;
}

function addLesson(courseId: number, position: number) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: `Module ${position}`, position })
    .returning()
    .get();
  return testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: `Lesson ${position}`, position })
    .returning()
    .get();
}

function completeLesson(userId: number, lessonId: number) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId,
      lessonId,
      status: schema.LessonProgressStatus.Completed,
      completedAt: new Date().toISOString(),
    })
    .run();
}

function addQuiz(lessonId: number) {
  return testDb
    .insert(schema.quizzes)
    .values({ lessonId, title: "Quiz", passingScore: 0.7 })
    .returning()
    .get();
}

function attemptQuiz(userId: number, quizId: number, passed: boolean) {
  testDb
    .insert(schema.quizAttempts)
    .values({ userId, quizId, score: passed ? 0.9 : 0.4, passed })
    .run();
}

describe("instructorReportingService", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  describe("getCourseSummariesForInstructor", () => {
    it("reports zeros for a course with no activity", () => {
      expect(getCourseSummariesForInstructor(base.instructor.id)).toEqual([
        {
          courseId: base.course.id,
          enrolledCount: 0,
          totalPaid: 0,
          completedCount: 0,
        },
      ]);
    });

    it("counts enrollments as enrolled and recorded completions as completed", () => {
      enroll(base.user.id, base.course.id, "2026-01-05T10:00:00.000Z");
      enroll(addUser("Second").id, base.course.id);
      enroll(addUser("Third").id, base.course.id);
      enroll(addUser("Fourth").id, base.course.id);

      expect(getCourseSummariesForInstructor(base.instructor.id)).toEqual([
        {
          courseId: base.course.id,
          enrolledCount: 4,
          totalPaid: 0,
          completedCount: 1,
        },
      ]);
    });

    it("sums a student's own purchases into Total Paid", () => {
      const second = addUser("Second");
      enroll(base.user.id, base.course.id);
      enroll(second.id, base.course.id);
      purchase(base.user.id, base.course.id, 5999);
      purchase(second.id, base.course.id, 5999);

      expect(getCourseSummariesForInstructor(base.instructor.id)).toEqual([
        {
          courseId: base.course.id,
          enrolledCount: 2,
          totalPaid: 11998,
          completedCount: 0,
        },
      ]);
    });

    it("counts a PPP-reduced purchase at the amount actually paid", () => {
      const second = addUser("Second");
      enroll(base.user.id, base.course.id);
      enroll(second.id, base.course.id);
      purchase(base.user.id, base.course.id, 5999);
      purchase(second.id, base.course.id, 2400);

      expect(getCourseSummariesForInstructor(base.instructor.id)).toEqual([
        {
          courseId: base.course.id,
          enrolledCount: 2,
          totalPaid: 8399,
          completedCount: 0,
        },
      ]);
    });

    it("counts a team purchase in full and only its redeemed team seats as enrolled", () => {
      const buyer = addUser("Team Buyer");
      const seatOne = addUser("Seat One");
      const seatTwo = addUser("Seat Two");
      enroll(base.user.id, base.course.id);
      purchase(base.user.id, base.course.id, 5999);
      // 5 seats bought, 2 redeemed; the buyer has no enrollment.
      teamPurchase(buyer.id, base.course.id, 29995, 5, [
        seatOne.id,
        seatTwo.id,
      ]);

      expect(getCourseSummariesForInstructor(base.instructor.id)).toEqual([
        {
          courseId: base.course.id,
          enrolledCount: 3,
          totalPaid: 35994,
          completedCount: 0,
        },
      ]);
    });

    it("keeps a purchase in Total Paid after its student unenrolled", () => {
      const leaver = addUser("Leaver");
      enroll(base.user.id, base.course.id);
      purchase(base.user.id, base.course.id, 5999);
      enroll(leaver.id, base.course.id);
      purchase(leaver.id, base.course.id, 4999);
      unenrollUser(leaver.id, base.course.id);

      expect(getCourseSummariesForInstructor(base.instructor.id)).toEqual([
        {
          courseId: base.course.id,
          enrolledCount: 1,
          totalPaid: 10998,
          completedCount: 0,
        },
      ]);
    });

    it("includes draft and archived courses, each with its own numbers", () => {
      const draft = addCourse(
        base.instructor.id,
        "draft-course",
        schema.CourseStatus.Draft
      );
      const archived = addCourse(
        base.instructor.id,
        "archived-course",
        schema.CourseStatus.Archived
      );
      enroll(base.user.id, archived.id, "2026-02-01T09:00:00.000Z");
      purchase(base.user.id, archived.id, 1900);

      expect(getCourseSummariesForInstructor(base.instructor.id)).toEqual([
        {
          courseId: base.course.id,
          enrolledCount: 0,
          totalPaid: 0,
          completedCount: 0,
        },
        {
          courseId: draft.id,
          enrolledCount: 0,
          totalPaid: 0,
          completedCount: 0,
        },
        {
          courseId: archived.id,
          enrolledCount: 1,
          totalPaid: 1900,
          completedCount: 1,
        },
      ]);
    });

    it("never includes another instructor's courses or their numbers", () => {
      const other = addUser("Other Instructor", schema.UserRole.Instructor);
      const otherCourse = addCourse(other.id, "other-course");
      enroll(base.user.id, otherCourse.id, "2026-03-01T09:00:00.000Z");
      purchase(base.user.id, otherCourse.id, 7900);

      expect(getCourseSummariesForInstructor(base.instructor.id)).toEqual([
        {
          courseId: base.course.id,
          enrolledCount: 0,
          totalPaid: 0,
          completedCount: 0,
        },
      ]);
      expect(getCourseSummariesForInstructor(other.id)).toEqual([
        {
          courseId: otherCourse.id,
          enrolledCount: 1,
          totalPaid: 7900,
          completedCount: 1,
        },
      ]);
    });

    it("returns nothing for an instructor without courses", () => {
      const other = addUser("Other Instructor", schema.UserRole.Instructor);

      expect(getCourseSummariesForInstructor(other.id)).toEqual([]);
    });
  });

  describe("getCourseDrillDown", () => {
    it("shows a student who bought the course themselves with the sum of their purchases", () => {
      const enrollment = enroll(base.user.id, base.course.id);
      purchase(base.user.id, base.course.id, 5999);
      purchase(base.user.id, base.course.id, 1000);

      expect(getCourseDrillDown(base.course.id).students).toEqual([
        {
          userId: base.user.id,
          name: base.user.name,
          email: base.user.email,
          enrolledAt: enrollment.enrolledAt,
          completedAt: null,
          progress: 0,
          amountPaid: 6999,
          teamBuyer: null,
          teamPurchase: null,
          quizzesNotPassed: 0,
        },
      ]);
    });

    it("shows a PPP-reduced purchase at the amount actually paid", () => {
      enroll(base.user.id, base.course.id);
      purchase(base.user.id, base.course.id, 2400);

      const [row] = getCourseDrillDown(base.course.id).students;
      expect(row.amountPaid).toBe(2400);
    });

    it("shows a team seat student as paying nothing, with who paid for the seat", () => {
      const buyer = addUser("Bossy McBossface");
      const seat = addUser("Seat Holder");
      teamPurchase(buyer.id, base.course.id, 29995, 5, [seat.id]);

      expect(getCourseDrillDown(base.course.id).students).toMatchObject([
        {
          userId: seat.id,
          amountPaid: 0,
          teamBuyer: { userId: buyer.id, name: "Bossy McBossface" },
          teamPurchase: null,
        },
      ]);
    });

    it("shows a team buyer who redeemed their own seat with the full team amount and the seats", () => {
      const buyer = addUser("Bossy McBossface");
      const colleague = addUser("Colleague");
      teamPurchase(buyer.id, base.course.id, 29995, 5, [buyer.id, colleague.id]);

      const students = getCourseDrillDown(base.course.id).students;
      expect(students.find((s) => s.userId === buyer.id)).toMatchObject({
        amountPaid: 29995,
        teamPurchase: { seatsBought: 5, seatsRedeemed: 2 },
      });
      expect(students.find((s) => s.userId === colleague.id)).toMatchObject({
        amountPaid: 0,
        teamBuyer: { userId: buyer.id, name: "Bossy McBossface" },
        teamPurchase: null,
      });
    });

    it("shows a student at 100% progress how many quizzes they have not passed", () => {
      const first = addLesson(base.course.id, 1);
      const second = addLesson(base.course.id, 2);
      const third = addLesson(base.course.id, 3);
      const passedQuiz = addQuiz(first.id);
      const failedQuiz = addQuiz(second.id);
      addQuiz(third.id); // never attempted
      enroll(base.user.id, base.course.id);
      for (const lesson of [first, second, third]) {
        completeLesson(base.user.id, lesson.id);
      }
      // Passed once, then failed a retry: still Passed.
      attemptQuiz(base.user.id, passedQuiz.id, true);
      attemptQuiz(base.user.id, passedQuiz.id, false);
      attemptQuiz(base.user.id, failedQuiz.id, false);

      expect(getCourseDrillDown(base.course.id).students).toMatchObject([
        { progress: 100, completedAt: null, quizzesNotPassed: 2 },
      ]);
    });

    it("keeps a student Completed when lessons were added after they completed", () => {
      const first = addLesson(base.course.id, 1);
      enroll(base.user.id, base.course.id, "2026-01-05T10:00:00.000Z");
      completeLesson(base.user.id, first.id);
      addLesson(base.course.id, 2);

      expect(getCourseDrillDown(base.course.id).students).toMatchObject([
        { progress: 50, completedAt: "2026-01-05T10:00:00.000Z" },
      ]);
    });

    it("has one student row per enrolled student counted on the overview", () => {
      const buyer = addUser("Team Buyer");
      const seat = addUser("Seat Holder");
      const leaver = addUser("Leaver");
      enroll(base.user.id, base.course.id);
      purchase(base.user.id, base.course.id, 5999);
      enroll(addUser("Staff Without Purchase").id, base.course.id);
      teamPurchase(buyer.id, base.course.id, 29995, 5, [seat.id]);
      enroll(leaver.id, base.course.id);
      purchase(leaver.id, base.course.id, 5999);
      unenrollUser(leaver.id, base.course.id);

      const [summary] = getCourseSummariesForInstructor(base.instructor.id);
      const students = getCourseDrillDown(base.course.id).students;
      expect(summary.enrolledCount).toBe(3);
      expect(students).toHaveLength(3);
      expect(students.map((s) => s.userId)).not.toContain(buyer.id);
    });

    describe("purchases without enrollment", () => {
      it("lists a team buyer who is not enrolled with the full amount and the seats", () => {
        const buyer = addUser("Bossy McBossface");
        const seatOne = addUser("Seat One");
        const seatTwo = addUser("Seat Two");
        const bought = teamPurchase(buyer.id, base.course.id, 29995, 5, [
          seatOne.id,
          seatTwo.id,
        ]);

        const drillDown = getCourseDrillDown(base.course.id);
        expect(drillDown.purchasesWithoutEnrollment).toEqual([
          {
            purchaseId: bought.id,
            buyer: {
              userId: buyer.id,
              name: "Bossy McBossface",
              email: buyer.email,
            },
            amountPaid: 29995,
            purchasedAt: bought.createdAt,
            teamPurchase: { seatsBought: 5, seatsRedeemed: 2 },
          },
        ]);
        expect(drillDown.students.map((s) => s.userId)).not.toContain(
          buyer.id
        );
      });

      it("lists the purchase of a student who unenrolled", () => {
        const leaver = addUser("Leaver");
        enroll(leaver.id, base.course.id);
        const bought = purchase(leaver.id, base.course.id, 4999);
        unenrollUser(leaver.id, base.course.id);

        expect(
          getCourseDrillDown(base.course.id).purchasesWithoutEnrollment
        ).toMatchObject([
          {
            purchaseId: bought.id,
            buyer: { userId: leaver.id, name: "Leaver" },
            amountPaid: 4999,
            teamPurchase: null,
          },
        ]);
      });

      it("lists nothing when every purchase belongs to an enrolled student", () => {
        const buyer = addUser("Bossy McBossface");
        enroll(base.user.id, base.course.id);
        purchase(base.user.id, base.course.id, 5999);
        teamPurchase(buyer.id, base.course.id, 29995, 3, [buyer.id]);

        expect(
          getCourseDrillDown(base.course.id).purchasesWithoutEnrollment
        ).toEqual([]);
      });

      it("adds up with the student rows to the course's Total Paid", () => {
        const buyer = addUser("Team Buyer");
        const seat = addUser("Seat Holder");
        const leaver = addUser("Leaver");
        enroll(base.user.id, base.course.id);
        purchase(base.user.id, base.course.id, 5999);
        purchase(base.user.id, base.course.id, 1000);
        enroll(addUser("Staff Without Purchase").id, base.course.id);
        teamPurchase(buyer.id, base.course.id, 29995, 5, [seat.id]);
        enroll(leaver.id, base.course.id);
        purchase(leaver.id, base.course.id, 2400);
        unenrollUser(leaver.id, base.course.id);

        const [summary] = getCourseSummariesForInstructor(base.instructor.id);
        const drillDown = getCourseDrillDown(base.course.id);
        const pageTotal =
          drillDown.students.reduce((n, s) => n + s.amountPaid, 0) +
          drillDown.purchasesWithoutEnrollment.reduce(
            (n, p) => n + p.amountPaid,
            0
          );
        expect(summary.totalPaid).toBe(39394);
        expect(pageTotal).toBe(39394);
      });
    });
  });

  describe("getRosterQuizzes", () => {
    it("lists the course's quizzes in lesson order, skipping lessons without one", () => {
      const first = addLesson(base.course.id, 1);
      addLesson(base.course.id, 2); // no quiz
      const third = addLesson(base.course.id, 3);
      const thirdQuiz = addQuiz(third.id);
      const firstQuiz = addQuiz(first.id);
      const other = addCourse(base.instructor.id, "other-course");
      addQuiz(addLesson(other.id, 1).id);

      expect(getRosterQuizzes(base.course.id)).toEqual([
        { quizId: firstQuiz.id, quizTitle: "Quiz", lessonTitle: "Lesson 1" },
        { quizId: thirdQuiz.id, quizTitle: "Quiz", lessonTitle: "Lesson 3" },
      ]);
    });

    it("lists every quiz of a lesson that has more than one", () => {
      const lesson = addLesson(base.course.id, 1);
      const firstQuiz = addQuiz(lesson.id);
      const secondQuiz = addQuiz(lesson.id);

      expect(getRosterQuizzes(base.course.id)).toEqual([
        { quizId: firstQuiz.id, quizTitle: "Quiz", lessonTitle: "Lesson 1" },
        { quizId: secondQuiz.id, quizTitle: "Quiz", lessonTitle: "Lesson 1" },
      ]);
    });

    it("covers the same quizzes that 'quizzes not passed' counts", () => {
      const lesson = addLesson(base.course.id, 1);
      addQuiz(lesson.id);
      addQuiz(lesson.id);
      enroll(base.user.id, base.course.id);

      const [student] = getCourseDrillDown(base.course.id).students;
      expect(getRosterQuizzes(base.course.id)).toHaveLength(2);
      expect(student.quizzesNotPassed).toBe(2);
    });

    it("returns no quizzes for a course without any", () => {
      addLesson(base.course.id, 1);
      expect(getRosterQuizzes(base.course.id)).toEqual([]);
    });
  });

  describe("getBestQuizScores", () => {
    it("gives a student's best attempt per quiz, and nulls for an unattempted one", () => {
      const attempted = addQuiz(addLesson(base.course.id, 1).id);
      addQuiz(addLesson(base.course.id, 2).id);
      attemptQuiz(base.user.id, attempted.id, false);
      attemptQuiz(base.user.id, attempted.id, true);

      const quizzes = getRosterQuizzes(base.course.id);
      expect(getBestQuizScores(base.user.id, quizzes)).toEqual([
        { ...quizzes[0], bestScore: 0.9, passed: true },
        { ...quizzes[1], bestScore: null, passed: null },
      ]);
    });
  });
});
