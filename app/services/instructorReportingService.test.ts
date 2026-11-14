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
import { getCourseSummariesForInstructor } from "./instructorReportingService";
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
});
