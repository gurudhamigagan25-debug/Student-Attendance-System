# REST API

Base URL: `http://localhost:5000/api`. JSON endpoints accept and return `application/json`. Send protected requests with `Authorization: Bearer <JWT>`. Admin lookup routes accept an internal numeric ID or institution `student_id`; student-owner routes require the numeric profile ID from the student's login response.

## Authentication and Accounts

| Method and URL | Auth | Request body | Success response | Other status codes |
|---|---|---|---|---|
| `POST /students/register` | Public | `student_id`, `name`, `email`, `department`, `semester` (1-8), `phone`, `password` (6+ characters) | 201: `{message}` | 400 invalid fields/email; 409 duplicate email or student ID; 503 database unavailable; 500 server error |
| `POST /students/login` | Public | `{email, password}` | 200: `{message, token, student}` plus HttpOnly session cookies | 400 missing credentials; 401 invalid credentials; 429 too many attempts; 503 unavailable; 500 server error |
| `POST /auth/login` | Public | `{email, password}` | 200: `{message, token, user}` for any role plus HttpOnly session cookies | 400 invalid/missing fields; 401 invalid credentials; 429 too many attempts; 503 unavailable; 500 server error |
| `POST /admin/login` | Public | `{email, password}` | 200: `{message, token, admin}` plus HttpOnly session cookies | 400 missing credentials; 401 invalid admin credentials; 429 too many attempts |
| `POST /auth/refresh` | Refresh cookie | No body; sends `csrf_token` in `X-CSRF-Token` | 200: `{message, token}` and rotated cookies | 401 expired/revoked refresh token; 403 CSRF failure |
| `POST /auth/logout` | Public; revokes a valid current session when supplied | No body; cookie clients send `X-CSRF-Token` | 200: `{message}`; clears cookies | 403 CSRF failure |
| `PUT /auth/password` | Teacher | `{currentPassword, newPassword}` (12+ characters) | 200: `{message}`; signs out other sessions | 400 invalid/short password; 401 wrong current password; 401/403 |
| `POST /admin/logout` | Admin | No body | 200: `{message}`; revokes current server-side session | 401 missing/invalid/expired token; 403 non-admin/CSRF failure |
| `PUT /admin/account` | Admin | `{currentPassword, email, newPassword}` (12+ characters) | 200: `{message}`; revokes prior Admin sessions | 400 invalid email/short password; 401 incorrect current password; 409 email belongs to another account; 500 server error |
| `GET /teachers` | Admin | None | 200: `{teachers, total}` | 401/403/500 |
| `POST /teachers` | Admin | `{name, email, password}` (password 12+ characters) | 201: `{message, teacher}` | 400 invalid fields; 409 email already used; 401/403/500 |

Student registration creates the public student role only. Admins create teacher accounts; users cannot choose a privileged role in public registration.

## Students and Classes

| Method and URL | Auth | Request body / query | Success response | Other status codes |
|---|---|---|---|---|
| `GET /students` | Admin | None | 200: `{students, total}` | 401/403/500 |
| `GET /students/:id` | Admin | `id` is internal ID or `student_id` | 200: `{student}` | 401/403/404 |
| `PUT /students/:id` | Admin | `{name, phone, department, semester}` | 200: `{message}` | 400 invalid fields; 404 missing student; 401/403 |
| `DELETE /students/:id` | Admin | None | 200: `{message}` | 404 missing student; 401/403 |
| `PUT /students/:studentId/profile` | Student owner or Admin | `{name, phone, department, semester}` | 200: `{message, student}` | 400 invalid fields; 401/403/404/503/500 |
| `PUT /students/:studentId/password` | Student owner or Admin | `{currentPassword, newPassword}` (6+ characters) | 200: `{message}` | 400 missing/short password; 401 incorrect current password; 403/404/503/500 |
| `GET /classes` | Admin or Teacher | None | 200: `{classes}`; teacher sees assigned classes | 401/403/500 |
| `GET /classes/:classId/enrollments` | Admin or assigned Teacher | None | 200: `{students, total}` | 400 invalid ID; 401/403/404/500 |
| `POST /classes/:classId/enrollments` | Admin | `{student_id}` (internal ID or institution ID) | 201: `{message, enrollment}` | 400 invalid input; 401/403/404 class missing; 409 already enrolled; 500 |
| `DELETE /classes/:classId/enrollments/:studentId` | Admin | None | 200: `{message}` | 400 invalid input; 401/403/404 enrollment missing; 500 |
| `POST /classes` | Admin | `{class_name, subject, department, semester, teacher_name, teacher_user_id?}` | 201: `{message, class}` | 400 invalid class/teacher; 401/403/500 |
| `PUT /classes/:id` | Admin | Same fields as create | 200: `{message}` | 400 invalid fields; 404 missing class; 401/403/500 |
| `DELETE /classes/:id` | Admin | None | 200: `{message}` | 404 missing class; 401/403/500 |

## Attendance

| Method and URL | Auth | Request body / query | Success response | Other status codes |
|---|---|---|---|---|
| `POST /attendance` | Admin or assigned Teacher | `{student_id, class_id, date, status, time?, period?, notes?}`; student must be enrolled | 201: `{message, id}` | 400 invalid input; 401/403; 404 class missing; 409 unenrolled or duplicate student/class/day; 500 server error |
| `GET /attendance` | Admin or Teacher | Optional `?date=YYYY-MM-DD&class_id=1` | 200: `{records, total}`; teacher sees only assigned classes | 400 invalid date/class; 401/403/500 |
| `GET /students/:studentId/attendance` | Student owner or Admin | None | 200: `{summary, records}` including time, period, notes | 401/403/404/503/500 |
| `GET /attendance/student/:studentId` | Student owner or Admin | None | 200: `{summary, records}` | 403 other student's data; 404 missing student; 401/500 |
| `GET /attendance/report` | Admin | None | 200: `{report}` with present/total/percentage per student | 401/403/500 |
| `GET /admin/students` | Admin | Optional `?search=text` | 200: `{students, total}` | 401/403/503/500 |
| `GET /admin/students/:studentId` | Admin | None | 200: `{student, summary, records}` | 404 missing student; 401/403/503/500 |
| `GET /admin/students/:studentId/attendance` | Admin | None | 200: `{summary, records}` | 404 missing student; 401/403/503/500 |
| `POST /admin/students/:studentId/attendance` | Admin | `{date, time, period?, class_id?, status, notes?}` | 201: `{message, record}` | 400 invalid fields; 404 missing student/class; 401/403/409/503/500 |
| `GET /admin/attendance` | Admin | Optional `studentId`, `date`, `status`, `limit` query parameters | 200: `{records, total}` | 400 invalid date; 404 missing student; 401/403/503/500 |
| `GET /health` | Public | None | 200: `{status:"ok"}` | 503 database unavailable |

The admin-specific attendance endpoint accepts time/period/notes for the existing admin screen. The shared `/attendance` endpoint is the compact teacher API. Attendance results have summaries computed from stored records.

## Example Requests

Login:

```json
{"email":"student@example.com","password":"secret123"}
```

Student login response:

```json
{"message":"Login successful","token":"<jwt>","student":{"id":1,"student_id":"STU001","role":"student"}}
```

Teacher marking a class:

```json
{"student_id":"STU001","class_id":3,"date":"2026-10-01","time":"09:30","period":"First period","status":"Present","notes":"On time"}
```

All error responses use `{ "message": "..." }`. Common statuses are 400 invalid input, 401 missing/invalid/expired token or credentials, 403 insufficient role, ownership, or CSRF validation, 404 missing record, 409 duplicate/enrollment conflict, 429 rate limited, 503 database unavailable, and 500 unexpected server error. Cookie-authenticated state-changing requests must send the readable `csrf_token` cookie value as `X-CSRF-Token`. Passwords and hashes are excluded from API responses.
