# Relational Schema

The application uses MySQL when configured and falls back to SQLite for local development. `backend/database/database.sql` defines the MySQL schema; server startup creates or migrates both supported database variants.

## `users`

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `id` | INT, auto-increment | PK | Internal account ID |
| `name` | VARCHAR(100) | NOT NULL | Display name |
| `email` | VARCHAR(150) | UNIQUE, NOT NULL | Login name |
| `password_hash` | VARCHAR(255) | NOT NULL | bcrypt hash; never returned by the API |
| `role` | ENUM / TEXT | `admin`, `teacher`, or `student` | Authorization role |
| `created_at` | TIMESTAMP | Default current time | Account creation time |

## `auth_sessions`

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `session_id` | CHAR(36) / TEXT | PK | Random server-side session ID stored in signed tokens |
| `user_id` | INT | FK to `users.id`, NOT NULL | Session owner |
| `expires_at` | DATETIME / TEXT | NOT NULL | Refresh-session expiry |
| `created_at` | TIMESTAMP / TEXT | Default current time | Session creation time |

Sessions are deleted on logout and refresh rotation; deleting a user cascades to their sessions.

## `students`

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `id` | INT, auto-increment | PK | Student profile ID used by existing routes |
| `user_id` | INT | UNIQUE, FK to `users.id`, nullable during migration | Student's login account |
| `student_id` | VARCHAR(50) | UNIQUE, NOT NULL | Institution-issued ID |
| `name` | VARCHAR(100) | NOT NULL | Profile name |
| `email` | VARCHAR(150) | UNIQUE, NOT NULL | Kept for existing UI and lookup compatibility |
| `department` | VARCHAR(50) | NOT NULL | Department |
| `semester` | INT | 1-8 | Current semester |
| `phone` | VARCHAR(20) | NOT NULL | Contact number |
| `password` | VARCHAR(255) | NOT NULL | Legacy bcrypt hash retained for backward-compatible migration |
| `created_at` | TIMESTAMP | Default current time | Profile creation time |

`users.password_hash` is the canonical credential after migration. The legacy `students.password` hash is not returned and is maintained for compatibility with existing student records.

## `classes`

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `id` | INT, auto-increment | PK | Class ID |
| `class_name` | VARCHAR(100) | NOT NULL | Display name |
| `subject` | VARCHAR(100) | NOT NULL | Subject |
| `department` | VARCHAR(50) | NOT NULL | Department |
| `semester` | INT | 1-8 | Semester |
| `teacher_name` | VARCHAR(100) | NOT NULL | Legacy display value, synchronized when assigning a teacher |
| `teacher_user_id` | INT | FK to `users.id`, nullable | Assigned teacher account |
| `created_at` | TIMESTAMP | Default current time | Creation time |

The teacher FK is valid only for a `users` row with role `teacher`; the API checks this role before assigning a class.

## `enrollments`

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `id` | INT, auto-increment | PK | Enrollment row |
| `student_id` | INT | FK to `students.id`, NOT NULL | Enrolled student |
| `class_id` | INT | FK to `classes.id`, NOT NULL | Enrolled class |
| `enrolled_at` | TIMESTAMP / TEXT | Default current time | Enrollment time |

Unique `(student_id, class_id)` prevents duplicate enrollment. Both foreign keys cascade on deletion. Teachers can read rosters only for their assigned classes; only Admin can change enrollment.

## `attendance`

| Column | Type | Constraint | Meaning |
|---|---|---|---|
| `id` | INT, auto-increment | PK | Attendance record ID |
| `student_id` | INT | FK to `students.id`, NOT NULL | Student marked |
| `class_id` | INT | FK to `classes.id`, nullable | Class; nullable for historic/general records |
| `attendance_date` | DATE | NOT NULL | Day of attendance |
| `attendance_time` | TIME | Default `00:00:00` | Time/slot |
| `period` | VARCHAR(50) | Default `General` | Period label |
| `status` | ENUM / TEXT | `Present` or `Absent` | Attendance result |
| `notes` | TEXT | Nullable | Optional teacher note |
| `created_at` | TIMESTAMP / TEXT | Default current time | Insert time |

Keys and relationship behavior:

- `students.user_id` is unique; deleting a user deletes its student profile.
- `classes.teacher_user_id` references a user and uses `ON DELETE SET NULL`.
- `enrollments` is the many-to-many relation between students and classes.
- `attendance.student_id` references a student and uses `ON DELETE CASCADE`.
- `attendance.class_id` references a class and uses `ON DELETE SET NULL`.
- Unique `(student_id, class_id, attendance_date)` prevents more than one daily class result; unique `(student_id, attendance_date, attendance_time, period)` prevents duplicate slots. Nullable `class_id` allows legacy records without a class.
- Semester is constrained to 1-8 in fresh schemas and validated by the API for updates and inserts.

See [ER diagram](ER-DIAGRAM.md) for the cardinalities and [database.sql](../backend/database/database.sql) for executable MySQL DDL.
