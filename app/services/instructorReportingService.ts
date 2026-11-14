import { and, count, eq, isNotNull, sum } from "drizzle-orm";
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
  quizzes,
  users,
} from "~/db/schema";
import { passedQuizzesInCourse } from "~/services/passedQuizService";
import {
  getTotalLessonCount,
  progressPercent,
} from "~/services/progressService";
import { getBestAttempt } from "~/services/quizService";

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

/** Team seats bought by team purchases, and how many of them are redeemed. */
export type TeamSeatCounts = { seatsBought: number; seatsRedeemed: number };

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
  /** For a team seat student, who paid for the seat, unless it was themselves. */
  teamBuyer: { userId: number; name: string } | null;
  /** For a student who is also a team buyer, the seats their team purchases bought. */
  teamPurchase: TeamSeatCounts | null;
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
  teamPurchase: TeamSeatCounts | null;
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
  const studentRows = getEnrolledStudents(courseId);

  // Purchases whose buyer is not among the enrolled students: team buyers
  // who never redeemed a seat, and students who unenrolled.
  const enrolledUserIds = new Set(studentRows.map((r) => r.userId));
  const purchasesWithoutEnrollment = getCoursePurchases(courseId).filter(
    (p) => !enrolledUserIds.has(p.buyer.userId)
  );

  return {
    students: toDrillDownStudents(courseId, studentRows),
    purchasesWithoutEnrollment,
  };
}

type EnrolledStudentRow = ReturnType<typeof getEnrolledStudents>[number];

function toDrillDownStudents(
  courseId: number,
  studentRows: EnrolledStudentRow[]
): DrillDownStudent[] {
  const paidByUser = getAmountPaidByUser(courseId);
  const teamBuyerByRedeemer = getTeamBuyerByRedeemer(courseId);
  const seatsByBuyer = countTeamSeats(courseId, purchases.userId);
  const lessonCount = getTotalLessonCount(courseId);
  const completedLessonsByUser = getCompletedLessonCountByUser(courseId);
  const quizCount = getQuizCount(courseId);
  const passedQuizzesByUser = getPassedQuizCountByUser(courseId);

  return studentRows.map((row) => {
    const seatBuyer = teamBuyerByRedeemer.get(row.userId);
    return {
      ...row,
      progress: progressPercent(
        completedLessonsByUser.get(row.userId) ?? 0,
        lessonCount
      ),
      quizzesNotPassed: quizCount - (passedQuizzesByUser.get(row.userId) ?? 0),
      amountPaid: paidByUser.get(row.userId) ?? 0,
      // Someone else paid; a buyer on their own seat is shown by teamPurchase.
      teamBuyer:
        seatBuyer && seatBuyer.userId !== row.userId ? seatBuyer : null,
      teamPurchase: seatsByBuyer.get(row.userId) ?? null,
    };
  });
}

function getEnrolledStudents(courseId: number) {
  return db
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
}

// The sum of each buyer's own purchases for the course, in US cents.
function getAmountPaidByUser(courseId: number): Map<number, number> {
  const rows = db
    .select({
      userId: purchases.userId,
      amountPaid: sum(purchases.amountPaid).mapWith(Number),
    })
    .from(purchases)
    .where(eq(purchases.courseId, courseId))
    .groupBy(purchases.userId)
    .all();
  return new Map(rows.map((r) => [r.userId, r.amountPaid]));
}

// A team seat student is connected to the money only through the team seat
// they redeemed and the team purchase it came from.
function getTeamBuyerByRedeemer(
  courseId: number
): Map<number | null, { userId: number; name: string }> {
  const rows = db
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
  return new Map(
    rows.map((r) => [r.redeemerId, { userId: r.buyerId, name: r.buyerName }])
  );
}

// The course's team seats, grouped by the team purchase that bought them or by
// its buyer. Seats bought = team seats created; seats redeemed = those with a
// redeemer.
function countTeamSeats(
  courseId: number,
  groupBy: typeof purchases.id | typeof purchases.userId
): Map<number, TeamSeatCounts> {
  const rows = db
    .select({
      key: groupBy,
      seatsBought: count(coupons.id),
      seatsRedeemed: count(coupons.redeemedByUserId),
    })
    .from(coupons)
    .innerJoin(purchases, eq(purchases.id, coupons.purchaseId))
    .where(eq(coupons.courseId, courseId))
    .groupBy(groupBy)
    .all();
  return new Map(
    rows.map((r) => [
      r.key,
      { seatsBought: r.seatsBought, seatsRedeemed: r.seatsRedeemed },
    ])
  );
}

// How many of the course's lessons each student has completed.
function getCompletedLessonCountByUser(courseId: number): Map<number, number> {
  const rows = db
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
  return new Map(rows.map((r) => [r.userId, r.completed]));
}

function getQuizCount(courseId: number): number {
  return (
    db
      .select({ n: count(quizzes.id) })
      .from(quizzes)
      .innerJoin(lessons, eq(lessons.id, quizzes.lessonId))
      .innerJoin(modules, eq(modules.id, lessons.moduleId))
      .where(eq(modules.courseId, courseId))
      .get()?.n ?? 0
  );
}

// How many of the course's quizzes each student has Passed.
function getPassedQuizCountByUser(courseId: number): Map<number, number> {
  const passed = passedQuizzesInCourse(courseId);
  const rows = db
    .select({ userId: passed.userId, passed: count() })
    .from(passed)
    .groupBy(passed.userId)
    .all();
  return new Map(rows.map((r) => [r.userId, r.passed]));
}

// Every purchase for the course, oldest first, with the team seats it bought.
function getCoursePurchases(courseId: number): PurchaseWithoutEnrollment[] {
  const seatsByPurchase = countTeamSeats(courseId, purchases.id);
  return db
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
    .all()
    .map((r) => ({
      purchaseId: r.purchaseId,
      buyer: { userId: r.userId, name: r.name, email: r.email },
      amountPaid: r.amountPaid,
      purchasedAt: r.purchasedAt,
      teamPurchase: seatsByPurchase.get(r.purchaseId) ?? null,
    }));
}

/** A quiz in the course, as a column of the student roster. */
export type RosterQuiz = {
  quizId: number;
  quizTitle: string;
  lessonTitle: string;
};

export type QuizScore = RosterQuiz & {
  /** The student's best attempt score as a fraction; null if unattempted. */
  bestScore: number | null;
  /** Whether that best attempt passed; null if unattempted. */
  passed: boolean | null;
};

/**
 * The course's quizzes in lesson order, taking the first quiz of each lesson.
 */
export function getRosterQuizzes(courseId: number): RosterQuiz[] {
  const rows = db
    .select({
      lessonId: lessons.id,
      lessonTitle: lessons.title,
      quizId: quizzes.id,
      quizTitle: quizzes.title,
    })
    .from(quizzes)
    .innerJoin(lessons, eq(lessons.id, quizzes.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(eq(modules.courseId, courseId))
    .orderBy(modules.id, lessons.id, quizzes.id)
    .all();

  const lessonsSeen = new Set<number>();
  const rosterQuizzes: RosterQuiz[] = [];
  for (const row of rows) {
    if (lessonsSeen.has(row.lessonId)) continue;
    lessonsSeen.add(row.lessonId);
    rosterQuizzes.push({
      quizId: row.quizId,
      quizTitle: row.quizTitle,
      lessonTitle: row.lessonTitle,
    });
  }
  return rosterQuizzes;
}

/** One student's best attempt at each of the given quizzes. */
export function getBestQuizScores(
  userId: number,
  rosterQuizzes: RosterQuiz[]
): QuizScore[] {
  return rosterQuizzes.map((quiz) => {
    const bestAttempt = getBestAttempt(userId, quiz.quizId);
    return {
      ...quiz,
      bestScore: bestAttempt?.score ?? null,
      passed: bestAttempt?.passed ?? null,
    };
  });
}
