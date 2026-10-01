const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { after, before, test } = require("node:test");
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();

let app;
let server;
let baseUrl;
let temporaryDirectory;

async function seedLegacyDatabase(databasePath) {
    const connection = await new Promise((resolve, reject) => {
        const database = new sqlite3.Database(databasePath, (error) => error ? reject(error) : resolve(database));
    });
    const run = (sql, params = []) => new Promise((resolve, reject) => {
        connection.run(sql, params, (error) => error ? reject(error) : resolve());
    });
    try {
        await run(`CREATE TABLE students (
            id INTEGER PRIMARY KEY AUTOINCREMENT, student_id TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, department TEXT NOT NULL,
            semester INTEGER NOT NULL, phone TEXT NOT NULL, password TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        await run(`CREATE TABLE classes (
            id INTEGER PRIMARY KEY AUTOINCREMENT, class_name TEXT NOT NULL, subject TEXT NOT NULL,
            department TEXT NOT NULL, semester INTEGER NOT NULL, teacher_name TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        await run(`CREATE TABLE attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT, student_id INTEGER NOT NULL,
            attendance_date TEXT NOT NULL, attendance_time TEXT NOT NULL DEFAULT '00:00:00',
            period TEXT NOT NULL DEFAULT 'General', status TEXT NOT NULL CHECK(status IN ('Present', 'Absent')),
            notes TEXT, class_id INTEGER,
            UNIQUE(student_id, attendance_date, attendance_time, period),
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        )`);
        await run("CREATE TABLE admin_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL)");
        await run(
            "INSERT INTO students (student_id, name, email, department, semester, phone, password) VALUES (?, ?, ?, ?, ?, ?, ?)",
            ["STU-OLD", "Legacy Student", "legacy@test.example", "Science", 1, "555-0199", await bcrypt.hash("legacy-password", 10)]
        );
        await run("INSERT INTO classes (class_name, subject, department, semester, teacher_name) VALUES (?, ?, ?, ?, ?)", ["Legacy Biology", "Biology", "Science", 1, "Teacher"]);
        await run(
            "INSERT INTO attendance (student_id, class_id, attendance_date, attendance_time, period, status) VALUES (1, 1, ?, ?, ?, ?)",
            ["2026-09-30", "09:00:00", "Morning", "Present"]
        );
    } finally {
        await new Promise((resolve, reject) => connection.close((error) => error ? reject(error) : resolve()));
    }
}

before(async () => {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "attendance-api-test-"));
    process.env.DATABASE_DRIVER = "sqlite";
    process.env.SQLITE_DB_PATH = path.join(temporaryDirectory, "test.db");
    process.env.JWT_SECRET = "test-only-secret-with-enough-random-looking-characters";
    process.env.ADMIN_EMAIL = "admin@test.example";
    process.env.ADMIN_PASSWORD = "test-admin-password";
    await seedLegacyDatabase(process.env.SQLITE_DB_PATH);

    app = require("../server");
    await app.locals.initializeDatabase();
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (app) await app.locals.closeDatabase();
    if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

async function request(url, { token, ...options } = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${baseUrl}${url}`, { ...options, headers });
    return { status: response.status, body: await response.json(), cookies: response.headers.getSetCookie?.() || [] };
}

test("registration, role authorization, and attendance flows", async () => {
    const migratedLogin = await request("/students/login", {
        method: "POST",
        body: JSON.stringify({ email: "legacy@test.example", password: "legacy-password" })
    });
    assert.equal(migratedLogin.status, 200);
    const migratedAttendance = await request(`/students/${migratedLogin.body.student.id}/attendance`, {
        token: migratedLogin.body.token
    });
    assert.equal(migratedAttendance.body.summary.present, 1);

    const invalidRegistration = await request("/students/register", {
        method: "POST",
        body: JSON.stringify({ email: "bad-email", password: "short" })
    });
    assert.equal(invalidRegistration.status, 400);

    const registration = await request("/students/register", {
        method: "POST",
        body: JSON.stringify({
            student_id: "STU-100",
            name: "Sam Student",
            email: "sam.student@test.example",
            department: "Science",
            semester: 2,
            phone: "555-0100",
            password: "student-password"
        })
    });
    assert.equal(registration.status, 201);

    const duplicate = await request("/students/register", {
        method: "POST",
        body: JSON.stringify({
            student_id: "STU-100",
            name: "Sam Student",
            email: "sam.student@test.example",
            department: "Science",
            semester: 2,
            phone: "555-0100",
            password: "student-password"
        })
    });
    assert.equal(duplicate.status, 409);

    const badLogin = await request("/students/login", {
        method: "POST",
        body: JSON.stringify({ email: "sam.student@test.example", password: "incorrect" })
    });
    assert.equal(badLogin.status, 401);

    const studentLogin = await request("/students/login", {
        method: "POST",
        body: JSON.stringify({ email: "sam.student@test.example", password: "student-password" })
    });
    assert.equal(studentLogin.status, 200);
    assert.equal(studentLogin.body.student.role, "student");
    assert.equal("password" in studentLogin.body.student, false);
    const oldStudentToken = studentLogin.body.token;
    const accessCookie = studentLogin.cookies.find((cookie) => cookie.startsWith("access_token="));
    const refreshCookie = studentLogin.cookies.find((cookie) => cookie.startsWith("refresh_token="));
    const csrfCookie = studentLogin.cookies.find((cookie) => cookie.startsWith("csrf_token="));
    assert.match(accessCookie, /HttpOnly/);
    assert.match(refreshCookie, /HttpOnly/);
    assert.doesNotMatch(csrfCookie, /HttpOnly/);
    const cookieHeader = [accessCookie, refreshCookie, csrfCookie].map((cookie) => cookie.split(";")[0]).join("; ");
    const csrfValue = csrfCookie.split(";")[0].split("=")[1];
    const csrfRejected = await request("/auth/refresh", {
        method: "POST",
        headers: { Cookie: cookieHeader }
    });
    assert.equal(csrfRejected.status, 403);
    const refreshed = await request("/auth/refresh", {
        method: "POST",
        headers: { Cookie: cookieHeader, "X-CSRF-Token": csrfValue }
    });
    assert.equal(refreshed.status, 200);
    const studentToken = refreshed.body.token;
    assert.equal((await request(`/students/${studentLogin.body.student.id}/attendance`, { token: oldStudentToken })).status, 401);
    const studentId = studentLogin.body.student.id;

    const noToken = await request("/classes");
    assert.equal(noToken.status, 401);
    const studentAdminRoute = await request("/admin/students", { token: studentToken });
    assert.equal(studentAdminRoute.status, 403);
    assert.equal((await request("/classes", { token: studentToken })).status, 403);

    const adminLogin = await request("/admin/login", {
        method: "POST",
        body: JSON.stringify({ email: "admin@test.example", password: "test-admin-password" })
    });
    assert.equal(adminLogin.status, 200);
    const adminToken = adminLogin.body.token;

    const createTeacher = await request("/teachers", {
        method: "POST",
        token: adminToken,
        body: JSON.stringify({ name: "Taylor Teacher", email: "taylor@test.example", password: "teacher-password" })
    });
    assert.equal(createTeacher.status, 201);

    const teacherLogin = await request("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "taylor@test.example", password: "teacher-password" })
    });
    assert.equal(teacherLogin.status, 200);
    assert.equal(teacherLogin.body.user.role, "teacher");
    const teacherToken = teacherLogin.body.token;
    const secondTeacherLogin = await request("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "taylor@test.example", password: "teacher-password" })
    });
    assert.equal(secondTeacherLogin.status, 200);

    const createClass = await request("/classes", {
        method: "POST",
        token: adminToken,
        body: JSON.stringify({
            class_name: "Biology 2",
            subject: "Biology",
            department: "Science",
            semester: 2,
            teacher_name: "Taylor Teacher",
            teacher_user_id: createTeacher.body.teacher.id
        })
    });
    assert.equal(createClass.status, 201);
    const classId = createClass.body.class.id;

    const notEnrolled = await request("/attendance", {
        method: "POST",
        token: teacherToken,
        body: JSON.stringify({ student_id: "STU-100", class_id: classId, date: "2026-10-01", status: "Present" })
    });
    assert.equal(notEnrolled.status, 409);

    const enrollment = await request(`/classes/${classId}/enrollments`, {
        method: "POST",
        token: adminToken,
        body: JSON.stringify({ student_id: studentId })
    });
    assert.equal(enrollment.status, 201);
    const duplicateEnrollment = await request(`/classes/${classId}/enrollments`, {
        method: "POST",
        token: adminToken,
        body: JSON.stringify({ student_id: studentId })
    });
    assert.equal(duplicateEnrollment.status, 409);

    const teacherClasses = await request("/classes", { token: teacherToken });
    assert.equal(teacherClasses.status, 200);
    assert.equal(teacherClasses.body.classes.length, 1);
    assert.equal(teacherClasses.body.classes[0].id, classId);
    const roster = await request(`/classes/${classId}/enrollments`, { token: teacherToken });
    assert.equal(roster.status, 200);
    assert.equal(roster.body.students.length, 1);

    const passwordUpdate = await request("/auth/password", {
        method: "PUT",
        token: teacherToken,
        body: JSON.stringify({ currentPassword: "teacher-password", newPassword: "teacher-password-updated" })
    });
    assert.equal(passwordUpdate.status, 200);
    assert.equal((await request("/classes", { token: secondTeacherLogin.body.token })).status, 401);

    const invalidAttendance = await request("/attendance", {
        method: "POST",
        token: teacherToken,
        body: JSON.stringify({ student_id: "STU-100", class_id: classId, date: "2026-10-01", status: "Late" })
    });
    assert.equal(invalidAttendance.status, 400);

    const markAttendance = await request("/attendance", {
        method: "POST",
        token: teacherToken,
        body: JSON.stringify({
            student_id: "STU-100", class_id: classId, date: "2026-10-01",
            time: "09:30", period: "First period", status: "Present", notes: "On time"
        })
    });
    assert.equal(markAttendance.status, 201);

    const duplicateAttendance = await request("/attendance", {
        method: "POST",
        token: teacherToken,
        body: JSON.stringify({ student_id: "STU-100", class_id: classId, date: "2026-10-01", status: "Absent" })
    });
    assert.equal(duplicateAttendance.status, 409);

    const studentAttendance = await request(`/students/${studentId}/attendance`, { token: studentToken });
    assert.equal(studentAttendance.status, 200);
    assert.equal(studentAttendance.body.summary.present, 1);

    const teacherAttendance = await request("/attendance", { token: teacherToken });
    assert.equal(teacherAttendance.status, 200);
    assert.equal(teacherAttendance.body.records.length, 1);
    assert.equal(teacherAttendance.body.records[0].attendance_time, "09:30:00");
    assert.equal(teacherAttendance.body.records[0].period, "First period");
    assert.equal(teacherAttendance.body.records[0].notes, "On time");

    const unassignedClass = await request("/classes", {
        method: "POST",
        token: adminToken,
        body: JSON.stringify({
            class_name: "Physics 1",
            subject: "Physics",
            department: "Science",
            semester: 1,
            teacher_name: "Unassigned"
        })
    });
    const forbiddenClassAttendance = await request("/attendance", {
        method: "POST",
        token: teacherToken,
        body: JSON.stringify({ student_id: "STU-100", class_id: unassignedClass.body.class.id, date: "2026-10-02", status: "Present" })
    });
    assert.equal(forbiddenClassAttendance.status, 403);

    const logout = await request("/auth/logout", { method: "POST", token: studentToken });
    assert.equal(logout.status, 200);
    const revokedSession = await request(`/students/${studentId}/attendance`, { token: studentToken });
    assert.equal(revokedSession.status, 401);
});
