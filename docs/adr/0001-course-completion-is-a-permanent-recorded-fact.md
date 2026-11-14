# Course completion is a permanent recorded fact

A student has completed a course once they have completed every lesson in it and passed every quiz in it. We record that moment on the enrollment and never undo it, instead of deriving completion live from lesson progress and quiz attempts. Instructors see completion counts per course, and those counts must not fall because the instructor improved the course by adding a lesson or a quiz.

## Considered Options

- **Derive completion live** from current lessons and quizzes. Rejected: a student who completed 20 lessons becomes "not completed" when lessons 21 and 22 are added, and every count needs a progress calculation per student.
- **Record it once, permanently** (chosen). Completion is one stored fact that the student dashboard, the instructor roster and the per-course counts all read.

## Consequences

- A completed student can have less than 100% progress on the current version of the course. That is intended, not a data error.
- Completion must be recorded at both triggers: completing the last outstanding lesson and passing the last outstanding quiz. Lesson completion itself stays independent of the lesson's quiz.
- Enrollments that met the rule before recording existed need a one-off backfill, dated to the student's last qualifying activity.
- Changing the completion rule later applies only to students who have not yet completed; it does not re-evaluate those who have.
