import { and, count, countDistinct, eq, isNotNull, sum } from "drizzle-orm";
import { db } from "~/db";
import {
  coupons,
  courses,
  enrollments,
  LessonProgressStatus,
  lessonProgress,
  lessons,
  modules,
  purchases,
  quizAttempts,
  quizzes,
  users,
} from "~/db/schema";

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

export type DrillDownStudent = {
  userId: number;
  name: string;
  email: string;
  enrolledAt: string;
  completedAt: string | null;
  /** Lessons completed as a percent of the course's lessons, as elsewhere. */
  progress: number;
  /** Sum of this student's own purchases for the course, in US cents. */
  amountPaid: number;
  /** How the enrollment was obtained; "none" when neither applies. */
  enrolledVia: "purchase" | "teamSeat" | "none";
  /** For a team seat student, who paid for the seat, unless it was themselves. */
  teamBuyer: { userId: number; name: string } | null;
  /** For a student who is also a team buyer, the seats their team purchases bought. */
  teamPurchase: { seatsBought: number; seatsRedeemed: number } | null;
  /** Quizzes in the course with no passing attempt by this student. */
  quizzesNotPassed: number;
};

export type PurchaseWithoutEnrollment = {
  purchaseId: number;
  buyer: { userId: number; name: string; email: string };
  /** The full amount of the purchase, in US cents. */
  amountPaid: number;
  purchasedAt: string;
  /** For a team purchase, the team seats it bought and how many are redeemed. */
  teamPurchase: { seatsBought: number; seatsRedeemed: number } | null;
};

export type CourseDrillDown = {
  /** One row per enrollment on the course. */
  students: DrillDownStudent[];
  /**
   * Every purchase for the course whose buyer has no enrollment on it, so
   * that student amounts plus these amounts add up to Total Paid.
   */
  purchasesWithoutEnrollment: PurchaseWithoutEnrollment[];
};

/**
 * The drill-down for one course: every student enrolled on it with what they
 * paid and where they stand.
 */
export function getCourseDrillDown(courseId: number): CourseDrillDown {
  const studentRows = db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      enrolledAt: enrollments.enrolledAt,
      completedAt: enrollments.completedAt,
    })
    .from(enrollments)
    .innerJoin(users, eq(users.id, enrollments.userId))
    .where(eq(enrollments.courseId, courseId))
    .orderBy(enrollments.enrolledAt, enrollments.id)
    .all();

  const paidRows = db
    .select({
      userId: purchases.userId,
      amountPaid: sum(purchases.amountPaid).mapWith(Number),
    })
    .from(purchases)
    .where(eq(purchases.courseId, courseId))
    .groupBy(purchases.userId)
    .all();
  const paidByUser = new Map(paidRows.map((r) => [r.userId, r.amountPaid]));

  // A team seat student is connected to the money only through the team seat
  // they redeemed and the team purchase it came from.
  const redeemedSeatRows = db
    .select({
      redeemerId: coupons.redeemedByUserId,
      buyerId: users.id,
      buyerName: users.name,
    })
    .from(coupons)
    .innerJoin(purchases, eq(purchases.id, coupons.purchaseId))
    .innerJoin(users, eq(users.id, purchases.userId))
    .where(
      and(eq(coupons.courseId, courseId), isNotNull(coupons.redeemedByUserId))
    )
    .all();
  const teamBuyerByRedeemer = new Map(
    redeemedSeatRows.map((r) => [
      r.redeemerId,
      { userId: r.buyerId, name: r.buyerName },
    ])
  );

  // Seats bought = team seats created from a buyer's team purchases;
  // seats redeemed = those with a redeemer.
  const seatRows = db
    .select({
      buyerId: purchases.userId,
      seatsBought: count(coupons.id),
      seatsRedeemed: count(coupons.redeemedByUserId),
    })
    .from(coupons)
    .innerJoin(purchases, eq(purchases.id, coupons.purchaseId))
    .where(eq(coupons.courseId, courseId))
    .groupBy(purchases.userId)
    .all();
  const seatsByBuyer = new Map(
    seatRows.map((r) => [
      r.buyerId,
      { seatsBought: r.seatsBought, seatsRedeemed: r.seatsRedeemed },
    ])
  );

  // Progress counts completed lessons only, the same as calculateProgress.
  const lessonCount =
    db
      .select({ n: count(lessons.id) })
      .from(lessons)
      .innerJoin(modules, eq(modules.id, lessons.moduleId))
      .where(eq(modules.courseId, courseId))
      .get()?.n ?? 0;

  const completedLessonRows = db
    .select({
      userId: lessonProgress.userId,
      completed: count(lessonProgress.id),
    })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessons.id, lessonProgress.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(
      and(
        eq(modules.courseId, courseId),
        eq(lessonProgress.status, LessonProgressStatus.Completed)
      )
    )
    .groupBy(lessonProgress.userId)
    .all();
  const completedLessonsByUser = new Map(
    completedLessonRows.map((r) => [r.userId, r.completed])
  );

  // A quiz is Passed once any one attempt passed, whatever came after it —
  // the same definition completion recording uses.
  const quizCount =
    db
      .select({ n: count(quizzes.id) })
      .from(quizzes)
      .innerJoin(lessons, eq(lessons.id, quizzes.lessonId))
      .innerJoin(modules, eq(modules.id, lessons.moduleId))
      .where(eq(modules.courseId, courseId))
      .get()?.n ?? 0;

  const passedQuizRows = db
    .select({
      userId: quizAttempts.userId,
      passed: countDistinct(quizAttempts.quizId),
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizzes.id, quizAttempts.quizId))
    .innerJoin(lessons, eq(lessons.id, quizzes.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(and(eq(modules.courseId, courseId), eq(quizAttempts.passed, true)))
    .groupBy(quizAttempts.userId)
    .all();
  const passedQuizzesByUser = new Map(
    passedQuizRows.map((r) => [r.userId, r.passed])
  );

  // Purchases whose buyer is not among the enrolled students: team buyers
  // who never redeemed a seat, and students who unenrolled.
  const enrolledUserIds = new Set(studentRows.map((r) => r.userId));
  const purchaseRows = db
    .select({
      purchaseId: purchases.id,
      userId: users.id,
      name: users.name,
      email: users.email,
      amountPaid: purchases.amountPaid,
      purchasedAt: purchases.createdAt,
    })
    .from(purchases)
    .innerJoin(users, eq(users.id, purchases.userId))
    .where(eq(purchases.courseId, courseId))
    .orderBy(purchases.createdAt, purchases.id)
    .all();
  const seatPurchaseRows = db
    .select({
      purchaseId: coupons.purchaseId,
      seatsBought: count(coupons.id),
      seatsRedeemed: count(coupons.redeemedByUserId),
    })
    .from(coupons)
    .where(and(eq(coupons.courseId, courseId), isNotNull(coupons.purchaseId)))
    .groupBy(coupons.purchaseId)
    .all();
  const seatsByPurchase = new Map(
    seatPurchaseRows.map((r) => [
      r.purchaseId,
      { seatsBought: r.seatsBought, seatsRedeemed: r.seatsRedeemed },
    ])
  );

  return {
    purchasesWithoutEnrollment: purchaseRows
      .filter((r) => !enrolledUserIds.has(r.userId))
      .map((r) => ({
        purchaseId: r.purchaseId,
        buyer: { userId: r.userId, name: r.name, email: r.email },
        amountPaid: r.amountPaid,
        purchasedAt: r.purchasedAt,
        teamPurchase: seatsByPurchase.get(r.purchaseId) ?? null,
      })),
    students: studentRows.map((row) => {
      const amountPaid = paidByUser.get(row.userId);
      const seatBuyer = teamBuyerByRedeemer.get(row.userId);
      const completedLessons = completedLessonsByUser.get(row.userId) ?? 0;
      return {
        ...row,
        progress:
          lessonCount === 0
            ? 0
            : Math.round((completedLessons / lessonCount) * 100),
        quizzesNotPassed:
          quizCount - (passedQuizzesByUser.get(row.userId) ?? 0),
        amountPaid: amountPaid ?? 0,
        enrolledVia: seatBuyer
          ? "teamSeat"
          : amountPaid !== undefined
            ? "purchase"
            : "none",
        // Someone else paid; a buyer on their own seat is shown by teamPurchase.
        teamBuyer:
          seatBuyer && seatBuyer.userId !== row.userId ? seatBuyer : null,
        teamPurchase: seatsByBuyer.get(row.userId) ?? null,
      };
    }),
  };
}
