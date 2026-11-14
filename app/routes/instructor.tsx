import { Link } from "react-router";
import type { Route } from "./+types/instructor";
import { getCoursesByInstructor, getLessonCountForCourse } from "~/services/courseService";
import { getCourseSummariesForInstructor } from "~/services/instructorReportingService";
import { formatAmountPaid, formatCompleted } from "~/lib/reporting";
import { getCurrentUserId } from "~/lib/session";
import { getUserById } from "~/services/userService";
import { Card, CardContent, CardFooter, CardHeader } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Skeleton } from "~/components/ui/skeleton";
import { AlertTriangle, BookOpen, GraduationCap, Plus, Users } from "lucide-react";
import { CourseImage } from "~/components/course-image";
import { data, isRouteErrorResponse } from "react-router";
import { CourseStatus, UserRole } from "~/db/schema";

export function meta() {
  return [
    { title: "My Courses — Cadence" },
    { name: "description", content: "Manage your courses" },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data("Select a user from the DevUI panel to view your courses.", {
      status: 401,
    });
  }

  const user = getUserById(currentUserId);

  if (!user || user.role !== UserRole.Instructor) {
    throw data("Only instructors can access this page.", {
      status: 403,
    });
  }

  const instructorCourses = getCoursesByInstructor(currentUserId);

  const summaries = new Map(
    getCourseSummariesForInstructor(currentUserId).map((summary) => [
      summary.courseId,
      summary,
    ])
  );

  const coursesWithStats = instructorCourses.map((course) => {
    const lessonCount = getLessonCountForCourse(course.id);
    const summary = summaries.get(course.id);

    return {
      id: course.id,
      title: course.title,
      slug: course.slug,
      description: course.description,
      status: course.status,
      coverImageUrl: course.coverImageUrl,
      lessonCount,
      enrollmentCount: summary?.enrolledCount ?? 0,
      totalPaid: summary?.totalPaid ?? 0,
      completedCount: summary?.completedCount ?? 0,
      createdAt: course.createdAt,
      updatedAt: course.updatedAt,
    };
  });

  const totals = coursesWithStats.reduce(
    (acc, course) => ({
      enrollmentCount: acc.enrollmentCount + course.enrollmentCount,
      totalPaid: acc.totalPaid + course.totalPaid,
      completedCount: acc.completedCount + course.completedCount,
    }),
    { enrollmentCount: 0, totalPaid: 0, completedCount: 0 }
  );

  return { courses: coursesWithStats, totals };
}

function statusBadge(status: string) {
  switch (status) {
    case CourseStatus.Published:
      return (
        <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-400">
          Published
        </span>
      );
    case CourseStatus.Draft:
      return (
        <span className="inline-flex items-center rounded-full bg-yellow-100 px-2.5 py-0.5 text-xs font-medium text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400">
          Draft
        </span>
      );
    case CourseStatus.Archived:
      return (
        <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-800 dark:bg-gray-900/30 dark:text-gray-400">
          Archived
        </span>
      );
    default:
      return null;
  }
}

const headCell =
  "px-4 py-3 text-xs font-medium uppercase tracking-wider text-muted-foreground";

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <Skeleton className="h-9 w-40" />
          <Skeleton className="mt-2 h-5 w-72" />
        </div>
        <Skeleton className="h-10 w-32" />
      </div>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i} className="flex flex-col">
            <Skeleton className="aspect-video rounded-b-none rounded-t-lg" />
            <CardHeader>
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-4 w-full" />
            </CardHeader>
            <CardContent className="flex-1">
              <div className="flex items-center gap-4">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-4 w-20" />
              </div>
            </CardContent>
            <CardFooter>
              <Skeleton className="h-10 w-full" />
            </CardFooter>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function InstructorDashboard({
  loaderData,
}: Route.ComponentProps) {
  const { courses, totals } = loaderData;

  return (
    <div className="mx-auto max-w-7xl p-6 lg:p-8">
      {/* Breadcrumb */}
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">My Courses</span>
      </nav>

      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">My Courses</h1>
          <p className="mt-1 text-muted-foreground">
            Manage your courses and see how they are doing
          </p>
        </div>
        <Link to="/instructor/new">
          <Button>
            <Plus className="mr-2 size-4" />
            New Course
          </Button>
        </Link>
      </div>

      {courses.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <GraduationCap className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">No courses yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Create your first course to get started.
          </p>
          <Link to="/instructor/new" className="mt-4">
            <Button>
              <Plus className="mr-2 size-4" />
              Create Course
            </Button>
          </Link>
        </div>
      ) : (
        <>
        <div className="mb-8 overflow-x-auto rounded-lg border border-border">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className={`${headCell} text-left`}>Course</th>
                <th className={`${headCell} text-left`}>Status</th>
                <th className={`${headCell} text-right`}>Enrolled</th>
                <th className={`${headCell} text-right`}>Total Paid</th>
                <th className={`${headCell} text-right`}>Completed</th>
              </tr>
            </thead>
            <tbody>
              {courses.map((course) => (
                <tr key={course.id} className="border-b border-border">
                  <td className="px-4 py-3 text-sm font-medium">
                    <Link
                      to={`/instructor/${course.id}/students`}
                      className="hover:text-primary hover:underline"
                    >
                      {course.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3">{statusBadge(course.status)}</td>
                  <td className="px-4 py-3 text-right text-sm tabular-nums">
                    {course.enrollmentCount}
                  </td>
                  <td className="px-4 py-3 text-right text-sm tabular-nums">
                    {formatAmountPaid(course.totalPaid)}
                  </td>
                  <td className="px-4 py-3 text-right text-sm tabular-nums">
                    {formatCompleted(
                      course.completedCount,
                      course.enrollmentCount
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-muted/50 font-semibold">
                <td className="px-4 py-3 text-sm" colSpan={2}>
                  Total
                </td>
                <td className="px-4 py-3 text-right text-sm tabular-nums">
                  {totals.enrollmentCount}
                </td>
                <td className="px-4 py-3 text-right text-sm tabular-nums">
                  {formatAmountPaid(totals.totalPaid)}
                </td>
                <td className="px-4 py-3 text-right text-sm tabular-nums">
                  {formatCompleted(
                    totals.completedCount,
                    totals.enrollmentCount
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {courses.map((course) => (
            <Card key={course.id} className="flex flex-col overflow-hidden pt-0">
              <Link to={`/courses/${course.slug}`} className="aspect-video overflow-hidden">
                <CourseImage
                  src={course.coverImageUrl}
                  alt={course.title}
                  className="h-full w-full object-cover transition-transform hover:scale-105"
                />
              </Link>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <Link
                    to={`/courses/${course.slug}`}
                    className="text-lg font-semibold leading-tight hover:text-primary"
                  >
                    {course.title}
                  </Link>
                  {statusBadge(course.status)}
                </div>
                <p className="line-clamp-2 text-sm text-muted-foreground">
                  {course.description}
                </p>
              </CardHeader>
              <CardContent className="flex-1">
                <div className="flex items-center gap-4 text-sm text-muted-foreground">
                  <div className="flex items-center gap-1.5">
                    <BookOpen className="size-4" />
                    <span>
                      {course.lessonCount}{" "}
                      {course.lessonCount === 1 ? "lesson" : "lessons"}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Users className="size-4" />
                    <span>
                      {course.enrollmentCount}{" "}
                      {course.enrollmentCount === 1 ? "student" : "students"}
                    </span>
                  </div>
                </div>
              </CardContent>
              <CardFooter>
                <Link to={`/instructor/${course.id}`} className="w-full">
                  <Button className="w-full" variant="outline">
                    <BookOpen className="mr-2 size-4" />
                    Edit Course
                  </Button>
                </Link>
              </CardFooter>
            </Card>
          ))}
        </div>
        </>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading your courses.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message = typeof error.data === "string" ? error.data : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message = typeof error.data === "string" ? error.data : "You don't have permission to access this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <div className="flex items-center justify-center gap-3">
          <Link to="/courses">
            <Button variant="outline">Browse Courses</Button>
          </Link>
          <Link to="/">
            <Button>Go Home</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
