require("dotenv").config();
require("express-async-errors");
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();

const isProduction = process.env.NODE_ENV === "production";
const allowedOrigin = process.env.CORS_ORIGIN || false;
const JWT_SECRET = process.env.JWT_SECRET || "development-only-change-this-secret";
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "15m";
const REFRESH_TOKEN_EXPIRES_IN = "7d";
if (isProduction && (JWT_SECRET === "development-only-change-this-secret" || JWT_SECRET.length < 32)) {
    throw new Error("Production requires JWT_SECRET to contain at least 32 random characters");
}
if (isProduction && /change|replace|example|secret|placeholder/i.test(JWT_SECRET)) {
    throw new Error("Production JWT_SECRET cannot contain a placeholder value");
}
if (isProduction && (!process.env.ADMIN_EMAIL || process.env.ADMIN_EMAIL.toLowerCase() === "admin@example.com" ||
    !process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 12 ||
    /change|replace|example|password|admin123/i.test(process.env.ADMIN_PASSWORD))) {
    throw new Error("Production requires ADMIN_EMAIL and an ADMIN_PASSWORD of at least 12 characters");
}
if (isProduction && process.env.DATABASE_DRIVER === "sqlite") {
    throw new Error("SQLite cannot be selected in production; configure MySQL instead");
}

app.set("trust proxy", isProduction ? 1 : false);
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
            scriptSrc: ["'self'"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"]
        }
    }
}));
app.use(cors({ origin: allowedOrigin, credentials: Boolean(allowedOrigin) }));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use((req, res, next) => {
    if (isProduction && !req.secure) return res.status(400).json({ message: "HTTPS is required" });
    next();
});
app.use("/api", csrfProtection);
app.use(express.static(path.join(__dirname, "..", "frontend")));

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: { message: "Too many authentication attempts. Try again later." }
});

const DB_CONFIG = {
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "student_attendance",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const SQLITE_DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, "database", "student_attendance.db");
let db = null;
let dbType = "mysql";
let databaseReady = false;
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "admin@example.com").trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "admin123");
let adminEmail = ADMIN_EMAIL;
let adminPasswordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
function csrfProtection(req, res, next) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const usesCookieSession = req.cookies && (req.cookies.access_token || req.cookies.refresh_token);
    if (!usesCookieSession || req.headers.authorization) return next();
    if (!req.cookies.csrf_token || req.get("X-CSRF-Token") !== req.cookies.csrf_token) {
        return res.status(403).json({ message: "CSRF validation failed" });
    }
    next();
}

function setSessionCookies(res, accessToken, refreshToken) {
    const base = { secure: isProduction, sameSite: "strict", path: "/" };
    res.cookie("access_token", accessToken, { ...base, httpOnly: true, maxAge: 15 * 60 * 1000 });
    res.cookie("refresh_token", refreshToken, { ...base, httpOnly: true, path: "/api/auth", maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.cookie("csrf_token", crypto.randomBytes(24).toString("hex"), { ...base, httpOnly: false, maxAge: 7 * 24 * 60 * 60 * 1000 });
}

function clearSessionCookies(res) {
    const base = { secure: isProduction, sameSite: "strict" };
    res.clearCookie("access_token", { ...base, path: "/" });
    res.clearCookie("refresh_token", { ...base, path: "/api/auth" });
    res.clearCookie("csrf_token", { ...base, path: "/" });
}

function databaseDateTime(value) {
    if (value instanceof Date) return value.getTime();
    return Date.parse(`${String(value).replace(" ", "T")}Z`);
}

async function issueSession(subjectId, userId, role, email) {
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
    await executeQuery("DELETE FROM auth_sessions WHERE expires_at < CURRENT_TIMESTAMP");
    await executeQuery("INSERT INTO auth_sessions (session_id, user_id, expires_at) VALUES (?, ?, ?)", [sessionId, userId, expiresAt]);
    const claims = { id: subjectId, userId, role, email, sid: sessionId };
    return {
        accessToken: jwt.sign(claims, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN }),
        refreshToken: jwt.sign({ ...claims, typ: "refresh" }, JWT_SECRET, { expiresIn: REFRESH_TOKEN_EXPIRES_IN })
    };
}

function nonEmptyText(value, maxLength) {
    const text = String(value == null ? "" : value).trim();
    return text && text.length <= maxLength ? text : "";
}

function validSemester(value) {
    const semester = Number(value);
    return Number.isInteger(semester) && semester >= 1 && semester <= 8;
}

function sqliteErrorMessage(error) {
    return error && error.message ? error.message : String(error);
}

function sqliteRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (error) {
            if (error) {
                reject(error);
                return;
            }
            resolve({ insertId: this.lastID, changes: this.changes });
        });
    });
}

function sqliteAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => {
            if (error) {
                reject(error);
            }
            resolve(rows);
        });
    });
}

async function createSqliteDatabase() {
    const sqliteDb = await new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(SQLITE_DB_PATH, (error) => {
            if (error) reject(error);
            else resolve(connection);
        });
    });
    db = sqliteDb;
    await sqliteRun("PRAGMA foreign_keys = ON");

    await sqliteRun(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin', 'teacher', 'student')),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await sqliteRun(`
        CREATE TABLE IF NOT EXISTS auth_sessions (
            session_id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await sqliteRun(`
        CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            student_id TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            department TEXT NOT NULL,
            semester INTEGER NOT NULL CHECK(semester BETWEEN 1 AND 8),
            phone TEXT NOT NULL,
            password TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await sqliteRun(`
        CREATE TABLE IF NOT EXISTS classes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            class_name TEXT NOT NULL,
            subject TEXT NOT NULL,
            department TEXT NOT NULL,
            semester INTEGER NOT NULL CHECK(semester BETWEEN 1 AND 8),
            teacher_name TEXT NOT NULL,
            teacher_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await sqliteRun(`
        CREATE TABLE IF NOT EXISTS enrollments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
            class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
            enrolled_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(student_id, class_id)
        )
    `);
    await sqliteRun(`
        CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL,
            attendance_date TEXT NOT NULL,
            attendance_time TEXT NOT NULL DEFAULT '00:00:00',
            period TEXT NOT NULL DEFAULT 'General',
            status TEXT NOT NULL CHECK(status IN ('Present', 'Absent')),
            notes TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(student_id, attendance_date, attendance_time, period),
            UNIQUE(student_id, class_id, attendance_date),
            FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
        )
    `);
    await sqliteRun(`
        CREATE TABLE IF NOT EXISTS admin_settings (
            setting_key TEXT PRIMARY KEY,
            setting_value TEXT NOT NULL
        )
    `);

    // Migrate databases created by the original two-column attendance schema.
    const columns = await sqliteAll("PRAGMA table_info(attendance)");
    const columnNames = new Set(columns.map((column) => column.name));
    if (!columnNames.has("attendance_time")) {
        await sqliteRun("ALTER TABLE attendance ADD COLUMN attendance_time TEXT NOT NULL DEFAULT '00:00:00'");
    }
    if (!columnNames.has("period")) {
        await sqliteRun("ALTER TABLE attendance ADD COLUMN period TEXT NOT NULL DEFAULT 'General'");
    }
    if (!columnNames.has("notes")) {
        await sqliteRun("ALTER TABLE attendance ADD COLUMN notes TEXT");
    }
    if (!columnNames.has("class_id")) {
        await sqliteRun("ALTER TABLE attendance ADD COLUMN class_id INTEGER");
    }
    const attendanceCreatedAt = columnNames.has("created_at") ? "COALESCE(created_at, CURRENT_TIMESTAMP)" : "CURRENT_TIMESTAMP";
    const studentColumns = await sqliteAll("PRAGMA table_info(students)");
    if (!studentColumns.some((column) => column.name === "user_id")) {
        await sqliteRun("ALTER TABLE students ADD COLUMN user_id INTEGER");
    }
    const classColumns = await sqliteAll("PRAGMA table_info(classes)");
    if (!classColumns.some((column) => column.name === "teacher_user_id")) {
        await sqliteRun("ALTER TABLE classes ADD COLUMN teacher_user_id INTEGER");
    }
    await sqliteRun("CREATE UNIQUE INDEX IF NOT EXISTS students_user_id_unique ON students(user_id)");
    await sqliteRun("UPDATE attendance SET class_id = NULL WHERE class_id IS NOT NULL AND class_id NOT IN (SELECT id FROM classes)");

    const indexes = await sqliteAll("PRAGMA index_list(attendance)");
    let hasSlotIndex = false;
    let hasDateOnlyUniqueIndex = false;
    let hasClassDateUniqueIndex = false;
    for (const index of indexes) {
        if (!index.unique) continue;
        const indexColumns = await sqliteAll(`PRAGMA index_info("${index.name.replace(/"/g, '""')}")`);
        const names = indexColumns.sort((a, b) => a.seqno - b.seqno).map((item) => item.name);
        if (names.join("|") === "student_id|attendance_date|attendance_time|period") hasSlotIndex = true;
        if (names.join("|") === "student_id|attendance_date") hasDateOnlyUniqueIndex = true;
        if (names.join("|") === "student_id|class_id|attendance_date") hasClassDateUniqueIndex = true;
    }
    const attendanceForeignKeys = await sqliteAll("PRAGMA foreign_key_list(attendance)");
    const hasClassForeignKey = attendanceForeignKeys.some((foreignKey) => foreignKey.from === "class_id");
    const classDateDuplicates = await sqliteAll(
        `SELECT student_id, class_id, attendance_date FROM attendance
         WHERE class_id IS NOT NULL GROUP BY student_id, class_id, attendance_date
         HAVING COUNT(*) > 1 LIMIT 1`
    );
    const enforceClassDateUnique = classDateDuplicates.length === 0;
    if (!hasSlotIndex || hasDateOnlyUniqueIndex || !hasClassDateUniqueIndex || !hasClassForeignKey) {
        if (!enforceClassDateUnique) {
            console.warn("Legacy duplicate class attendance found; preserving records and enforcing duplicate checks in the API.");
        }
        await sqliteRun("PRAGMA foreign_keys = OFF");
        await sqliteRun(`
            CREATE TABLE attendance_migrated (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id INTEGER NOT NULL,
                class_id INTEGER,
                attendance_date TEXT NOT NULL,
                attendance_time TEXT NOT NULL DEFAULT '00:00:00',
                period TEXT NOT NULL DEFAULT 'General',
                status TEXT NOT NULL CHECK(status IN ('Present', 'Absent')),
                notes TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(student_id, attendance_date, attendance_time, period),
                ${enforceClassDateUnique ? "UNIQUE(student_id, class_id, attendance_date)," : ""}
                FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
                FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE SET NULL
            )
        `);
        await sqliteRun(`
            INSERT OR IGNORE INTO attendance_migrated
                (id, student_id, class_id, attendance_date, attendance_time, period, status, notes, created_at)
            SELECT id, student_id, class_id, attendance_date,
                COALESCE(attendance_time, '00:00:00'),
                COALESCE(period, 'General'), status, notes, ${attendanceCreatedAt}
            FROM attendance
        `);
        await sqliteRun("DROP TABLE attendance");
        await sqliteRun("ALTER TABLE attendance_migrated RENAME TO attendance");
        await sqliteRun("PRAGMA foreign_keys = ON");
    }
    return sqliteDb;
}

async function loadAdminSettings() {
    const rows = await selectRows(
        "SELECT setting_key, setting_value FROM admin_settings WHERE setting_key IN (?, ?)",
        ["admin_email", "admin_password_hash"]
    );
    const settings = new Map(rows.map((row) => [row.setting_key, row.setting_value]));
    if (!settings.has("admin_email") || !settings.has("admin_password_hash")) {
        adminEmail = ADMIN_EMAIL;
        adminPasswordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
        await saveAdminSettings();
    } else {
        adminEmail = settings.get("admin_email");
        adminPasswordHash = settings.get("admin_password_hash");
    }
    await upsertRoleUser("Administrator", adminEmail, adminPasswordHash, "admin");
}

async function upsertRoleUser(name, email, passwordHash, role) {
    const existing = await selectRows("SELECT id, role FROM users WHERE email = ?", [email]);
    if (existing.length) {
        if (existing[0].role !== role) throw new Error(`Email ${email} is already assigned to another role`);
        await executeQuery("UPDATE users SET name = ?, password_hash = ? WHERE id = ?", [name, passwordHash, existing[0].id]);
        return existing[0].id;
    }
    const result = await executeQuery(
        "INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)",
        [name, email, passwordHash, role]
    );
    return result.insertId;
}

async function migrateStudentsToUsers() {
    const students = await selectRows("SELECT id, user_id, name, email, password FROM students ORDER BY id");
    for (const student of students) {
        if (student.user_id) continue;
        const userId = await upsertRoleUser(student.name, student.email, student.password, "student");
        await executeQuery("UPDATE students SET user_id = ? WHERE id = ?", [userId, student.id]);
    }
}

async function saveAdminSettings() {
    if (dbType === "mysql") {
        await executeQuery(
            `INSERT INTO admin_settings (setting_key, setting_value)
             VALUES (?, ?), (?, ?)
             ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`,
            ["admin_email", adminEmail, "admin_password_hash", adminPasswordHash]
        );
    } else {
        await executeQuery(
            `INSERT INTO admin_settings (setting_key, setting_value)
             VALUES (?, ?), (?, ?)
             ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`,
            ["admin_email", adminEmail, "admin_password_hash", adminPasswordHash]
        );
    }
}

async function initializeDatabase() {
    if (process.env.DATABASE_DRIVER !== "sqlite") try {
        const adminConnection = await mysql.createConnection({
            host: DB_CONFIG.host,
            user: DB_CONFIG.user,
            password: DB_CONFIG.password
        });

        try {
            const databaseName = DB_CONFIG.database.replace(/`/g, "``");
            await adminConnection.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\``);
            await adminConnection.query(`USE \`${databaseName}\``);
            await adminConnection.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    name VARCHAR(100) NOT NULL,
                    email VARCHAR(150) NOT NULL UNIQUE,
                    password_hash VARCHAR(255) NOT NULL,
                    role ENUM('admin', 'teacher', 'student') NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            await adminConnection.query(`
                CREATE TABLE IF NOT EXISTS auth_sessions (
                    session_id CHAR(36) PRIMARY KEY,
                    user_id INT NOT NULL,
                    expires_at DATETIME NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    CONSTRAINT auth_sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);
            await adminConnection.query(`
                CREATE TABLE IF NOT EXISTS students (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    user_id INT NULL UNIQUE,
                    student_id VARCHAR(50) NOT NULL UNIQUE,
                    name VARCHAR(100) NOT NULL,
                    email VARCHAR(150) NOT NULL UNIQUE,
                    department VARCHAR(50) NOT NULL,
                    semester INT NOT NULL CHECK (semester BETWEEN 1 AND 8),
                    phone VARCHAR(20) NOT NULL,
                    password VARCHAR(255) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    CONSTRAINT students_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
                )
            `);
            const [studentColumns] = await adminConnection.query("SHOW COLUMNS FROM students");
            if (!studentColumns.some((column) => column.Field === "user_id")) {
                await adminConnection.query("ALTER TABLE students ADD COLUMN user_id INT NULL UNIQUE");
                await adminConnection.query("ALTER TABLE students ADD CONSTRAINT students_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE");
            }
            await adminConnection.query(`
                CREATE TABLE IF NOT EXISTS classes (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    class_name VARCHAR(100) NOT NULL,
                    subject VARCHAR(100) NOT NULL,
                    department VARCHAR(50) NOT NULL,
                    semester INT NOT NULL CHECK (semester BETWEEN 1 AND 8),
                    teacher_name VARCHAR(100) NOT NULL,
                    teacher_user_id INT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    CONSTRAINT classes_teacher_fk FOREIGN KEY (teacher_user_id) REFERENCES users(id) ON DELETE SET NULL
                )
            `);
            const [classColumns] = await adminConnection.query("SHOW COLUMNS FROM classes");
            if (!classColumns.some((column) => column.Field === "teacher_user_id")) {
                await adminConnection.query("ALTER TABLE classes ADD COLUMN teacher_user_id INT NULL");
                await adminConnection.query("ALTER TABLE classes ADD CONSTRAINT classes_teacher_fk FOREIGN KEY (teacher_user_id) REFERENCES users(id) ON DELETE SET NULL");
            }
            await adminConnection.query(`
                CREATE TABLE IF NOT EXISTS enrollments (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    student_id INT NOT NULL,
                    class_id INT NOT NULL,
                    enrolled_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    CONSTRAINT enrollments_student_fk FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
                    CONSTRAINT enrollments_class_fk FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE CASCADE,
                    UNIQUE KEY enrollment_student_class (student_id, class_id)
                )
            `);
            await adminConnection.query(`
                CREATE TABLE IF NOT EXISTS attendance (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    student_id INT NOT NULL,
                    class_id INT NULL,
                    attendance_date DATE NOT NULL,
                    attendance_time TIME NOT NULL DEFAULT '00:00:00',
                    period VARCHAR(50) NOT NULL DEFAULT 'General',
                    status ENUM('Present', 'Absent') NOT NULL,
                    notes TEXT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
                    FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE SET NULL,
                    UNIQUE KEY attendance_student_slot (student_id, attendance_date, attendance_time, period),
                    UNIQUE KEY attendance_student_class_date (student_id, class_id, attendance_date)
                )
            `);
            const [attendanceColumns] = await adminConnection.query("SHOW COLUMNS FROM attendance");
            const columnNames = new Set(attendanceColumns.map((column) => column.Field));
            if (!columnNames.has("attendance_time")) {
                await adminConnection.query("ALTER TABLE attendance ADD COLUMN attendance_time TIME NOT NULL DEFAULT '00:00:00'");
            }
            if (!columnNames.has("period")) {
                await adminConnection.query("ALTER TABLE attendance ADD COLUMN period VARCHAR(50) NOT NULL DEFAULT 'General'");
            }
            if (!columnNames.has("notes")) {
                await adminConnection.query("ALTER TABLE attendance ADD COLUMN notes TEXT NULL");
            }
            if (!columnNames.has("created_at")) {
                await adminConnection.query("ALTER TABLE attendance ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP");
            }
            if (!columnNames.has("class_id")) {
                await adminConnection.query("ALTER TABLE attendance ADD COLUMN class_id INT NULL");
            }
            await adminConnection.query(
                "UPDATE attendance SET class_id = NULL WHERE class_id IS NOT NULL AND class_id NOT IN (SELECT id FROM classes)"
            );
            const [attendanceForeignKeys] = await adminConnection.query(
                `SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'attendance'
                   AND COLUMN_NAME = 'class_id' AND REFERENCED_TABLE_NAME = 'classes'`,
                [DB_CONFIG.database]
            );
            if (!attendanceForeignKeys.length) {
                await adminConnection.query("ALTER TABLE attendance ADD CONSTRAINT attendance_class_fk FOREIGN KEY (class_id) REFERENCES classes(id) ON DELETE SET NULL");
            }

            const [indexes] = await adminConnection.query("SHOW INDEX FROM attendance");
            const allIndexNames = new Set(indexes.map((index) => index.Key_name));
            const uniqueIndexes = new Map();
            indexes.filter((index) => index.Non_unique === 0 && index.Key_name !== "PRIMARY")
                .forEach((index) => {
                    if (!uniqueIndexes.has(index.Key_name)) uniqueIndexes.set(index.Key_name, []);
                    uniqueIndexes.get(index.Key_name).push(index.Column_name);
                });
            for (const [indexName, indexColumns] of uniqueIndexes) {
                if (indexColumns.sort().join("|") === "attendance_date|student_id") {
                    if (!allIndexNames.has("attendance_student_fk")) {
                        await adminConnection.query("ALTER TABLE attendance ADD INDEX attendance_student_fk (student_id)");
                    }
                    await adminConnection.query(`ALTER TABLE attendance DROP INDEX \`${indexName.replace(/`/g, "``")}\``);
                }
            }
            const hasSlotIndex = Array.from(uniqueIndexes.values())
                .some((columns) => columns.sort().join("|") === "attendance_date|attendance_time|period|student_id");
            if (!hasSlotIndex) {
                await adminConnection.query(
                    "ALTER TABLE attendance ADD UNIQUE KEY attendance_student_slot (student_id, attendance_date, attendance_time, period)"
                );
            }
            if (!allIndexNames.has("attendance_student_class_date")) {
                const [duplicates] = await adminConnection.query(
                    `SELECT student_id, class_id, attendance_date FROM attendance
                     WHERE class_id IS NOT NULL GROUP BY student_id, class_id, attendance_date
                     HAVING COUNT(*) > 1 LIMIT 1`
                );
                if (!duplicates.length) {
                    await adminConnection.query(
                        "ALTER TABLE attendance ADD UNIQUE KEY attendance_student_class_date (student_id, class_id, attendance_date)"
                    );
                } else {
                    console.warn("Legacy duplicate class attendance found; preserving records and enforcing duplicate checks in the API.");
                }
            }
        } finally {
            await adminConnection.end();
        }

        db = mysql.createPool(DB_CONFIG);
        dbType = "mysql";
        databaseReady = true;
        await migrateStudentsToUsers();
        await executeQuery(
            "CREATE TABLE IF NOT EXISTS admin_settings (setting_key VARCHAR(50) PRIMARY KEY, setting_value TEXT NOT NULL)"
        );
        await loadAdminSettings();
        console.log("Connected to MySQL database.");
        return;
    } catch (error) {
        if (isProduction) {
            databaseReady = false;
            throw error;
        }
        console.warn("MySQL not available; falling back to SQLite.", sqliteErrorMessage(error));
    }

    try {
        dbType = "sqlite";
        db = await createSqliteDatabase();
        databaseReady = true;
        await migrateStudentsToUsers();
        await loadAdminSettings();
        console.log("Connected to SQLite database.");
    } catch (error) {
        databaseReady = false;
        console.error("Database initialization failed:", sqliteErrorMessage(error));
    }

}

async function selectRows(queryString, params = []) {
    if (dbType === "mysql") {
        const [rows] = await db.execute(queryString, params);
        return rows;
    }

    return new Promise((resolve, reject) => {
        db.all(queryString, params, (error, rows) => {
            if (error) {
                reject(error);
                return;
            }
            resolve(rows);
        });
    });
}

async function executeQuery(queryString, params = []) {
    if (dbType === "mysql") {
        const [result] = await db.execute(queryString, params);
        return { insertId: result.insertId, affectedRows: result.affectedRows, changes: result.affectedRows };
    }

    return new Promise((resolve, reject) => {
        db.run(queryString, params, function (error) {
            if (error) {
                reject(error);
                return;
            }
            resolve({ insertId: this.lastID, changes: this.changes });
        });
    });
}

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "..", "frontend", "index.html"));
});

// Student Registration
app.post("/api/students/register", async (req, res) => {
    try {
        const {
            student_id,
            name,
            email,
            department,
            semester,
            phone,
            password
        } = req.body;

        if (!databaseReady) {
            return res.status(503).json({
                message: "Database is not available. Please configure MySQL or check the database server."
            });
        }

        const trimmedStudentId = nonEmptyText(student_id, 50);
        const trimmedName = nonEmptyText(name, 100);
        const trimmedDepartment = nonEmptyText(department, 50);
        const trimmedPhone = nonEmptyText(phone, 20);
        const trimmedPassword = String(password || "");
        if (!trimmedStudentId || !trimmedName || !trimmedDepartment || !trimmedPhone ||
            !validSemester(semester) || trimmedPassword.length < 6) {
            return res.status(400).json({
                message: "Please provide valid profile fields and a password of at least 6 characters"
            });
        }

        const trimmedEmail = String(email || "").trim().toLowerCase();

        if (!/^\S+@\S+\.\S+$/.test(trimmedEmail)) {
            return res.status(400).json({
                message: "Please enter a valid email address"
            });
        }

        const existing = await selectRows(
            "SELECT id FROM students WHERE student_id = ? UNION SELECT id FROM students WHERE email = ?",
            [trimmedStudentId, trimmedEmail]
        );
        const existingUser = await selectRows("SELECT id FROM users WHERE email = ?", [trimmedEmail]);

        if (existing.length > 0 || existingUser.length > 0) {
            return res.status(409).json({
                message: "Student ID or Email already exists"
            });
        }

        const hashedPassword = await bcrypt.hash(trimmedPassword, 10);
        const userId = await upsertRoleUser(trimmedName, trimmedEmail, hashedPassword, "student");

        await executeQuery(
            `INSERT INTO students
            (user_id, student_id, name, email, department, semester, phone, password)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                userId,
                trimmedStudentId,
                trimmedName,
                trimmedEmail,
                trimmedDepartment,
                Number(semester),
                trimmedPhone,
                hashedPassword
            ]
        );

        res.status(201).json({
            message: "Student registered successfully!"
        });

    } catch (error) {
        console.error("Registration Error:", error);

        res.status(500).json({
            message: "Server error"
        });
    }
});

// Student Login
app.post("/api/students/login", authLimiter, async (req, res) => {
    try {
        if (!databaseReady) {
            return res.status(503).json({
                message: "Database is not available. Please configure MySQL or check the database server."
            });
        }

        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                message: "Email and password are required"
            });
        }

        const trimmedEmail = String(email).trim().toLowerCase();
        const rows = await selectRows(
            `SELECT s.*, u.password_hash FROM students s
             JOIN users u ON u.id = s.user_id AND u.role = 'student'
             WHERE s.email = ?`,
            [trimmedEmail]
        );

        if (rows.length === 0) {
            return res.status(401).json({
                message: "Invalid email or password"
            });
        }

        const student = rows[0];

        const passwordMatch = await bcrypt.compare(
            String(password),
            student.password_hash
        );

        if (!passwordMatch) {
            return res.status(401).json({
                message: "Invalid email or password"
            });
        }

        const session = await issueSession(student.id, student.user_id, "student", student.email);
        setSessionCookies(res, session.accessToken, session.refreshToken);

        res.json({
            message: "Login successful",
            token: session.accessToken,
            student: publicStudent({
                id: student.id, student_id: student.student_id, name: student.name,
                email: student.email, department: student.department,
                semester: student.semester, phone: student.phone, role: "student"
            })
        });

    } catch (error) {
        console.error("Login Error:", error);

        res.status(500).json({
            message: "Server error"
        });
    }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
    try {
        if (!databaseReady) return res.status(503).json({ message: "Database is not available." });
        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");
        if (!/^\S+@\S+\.\S+$/.test(email) || !password) {
            return res.status(400).json({ message: "A valid email and password are required" });
        }
        const users = await selectRows("SELECT id, name, email, password_hash, role FROM users WHERE email = ?", [email]);
        if (!users.length || !(await bcrypt.compare(password, users[0].password_hash))) {
            return res.status(401).json({ message: "Invalid email or password" });
        }
        const user = users[0];
        let profile = { id: user.id, name: user.name, email: user.email, role: user.role };
        let subjectId = user.id;
        if (user.role === "student") {
            const students = await selectRows("SELECT id, user_id, student_id, name, email, department, semester, phone FROM students WHERE user_id = ?", [user.id]);
            if (!students.length) return res.status(401).json({ message: "Student profile is unavailable" });
            profile = publicStudent({ ...students[0], role: "student" });
            subjectId = students[0].id;
        }
        const session = await issueSession(subjectId, user.id, user.role, user.email);
        setSessionCookies(res, session.accessToken, session.refreshToken);
        res.json({
            message: "Login successful",
            token: session.accessToken,
            user: profile
        });
    } catch (error) {
        console.error("Role login error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

app.post("/api/auth/refresh", async (req, res) => {
    try {
        const refresh = jwt.verify(String(req.cookies.refresh_token || ""), JWT_SECRET);
        if (refresh.typ !== "refresh" || !refresh.sid) return res.status(401).json({ message: "Invalid refresh session" });
        const sessions = await selectRows("SELECT user_id, expires_at FROM auth_sessions WHERE session_id = ?", [refresh.sid]);
        const expiry = sessions.length ? databaseDateTime(sessions[0].expires_at) : 0;
        if (!sessions.length || Number(sessions[0].user_id) !== Number(refresh.userId) || expiry <= Date.now()) {
            clearSessionCookies(res);
            return res.status(401).json({ message: "Session expired or revoked" });
        }
        await executeQuery("DELETE FROM auth_sessions WHERE session_id = ?", [refresh.sid]);
        const session = await issueSession(refresh.id, refresh.userId, refresh.role, refresh.email);
        setSessionCookies(res, session.accessToken, session.refreshToken);
        res.json({ message: "Session refreshed", token: session.accessToken });
    } catch (error) {
        clearSessionCookies(res);
        res.status(401).json({ message: "Invalid or expired refresh session" });
    }
});

app.post("/api/auth/logout", async (req, res) => {
    const authorization = String(req.headers.authorization || "");
    const bearerToken = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const token = String(req.cookies.refresh_token || req.cookies.access_token || bearerToken);
    try {
        const claims = jwt.verify(token, JWT_SECRET);
        if (claims.sid) await executeQuery("DELETE FROM auth_sessions WHERE session_id = ?", [claims.sid]);
    } catch (error) {
        // Clearing cookies is still useful when the session has already expired.
    }
    clearSessionCookies(res);
    res.json({ message: "Logged out successfully" });
});

app.put("/api/auth/password", ...requireRoles("teacher"), async (req, res) => {
    const currentPassword = String(req.body.currentPassword || "");
    const newPassword = String(req.body.newPassword || "");
    if (!currentPassword || newPassword.length < 12) {
        return res.status(400).json({ message: "Current password and a new password of at least 12 characters are required" });
    }
    const users = await selectRows("SELECT password_hash FROM users WHERE id = ? AND role = 'teacher'", [req.user.userId]);
    if (!users.length) return res.status(404).json({ message: "Teacher account not found" });
    if (!(await bcrypt.compare(currentPassword, users[0].password_hash))) {
        return res.status(401).json({ message: "Current password is incorrect" });
    }
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await executeQuery("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, req.user.userId]);
    if (req.user.sid) {
        await executeQuery("DELETE FROM auth_sessions WHERE user_id = ? AND session_id <> ?", [req.user.userId, req.user.sid]);
    } else {
        await executeQuery("DELETE FROM auth_sessions WHERE user_id = ?", [req.user.userId]);
    }
    res.json({ message: "Password updated. Other sessions have been signed out." });
});

function validDate(value) {
    const date = String(value || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const parsed = new Date(`${date}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function validTime(value) {
    const parts = String(value || "").split(":");
    return /^\d{2}:\d{2}(:\d{2})?$/.test(String(value || "")) &&
        Number(parts[0]) < 24 && Number(parts[1]) < 60 &&
        (parts.length < 3 || Number(parts[2]) < 60);
}

async function findStudent(identifier) {
    const value = String(identifier || "").trim();
    if (/^\d+$/.test(value)) {
        const byId = await selectRows(
            "SELECT id, student_id, name, email, department, semester, phone, created_at FROM students WHERE id = ?",
            [Number(value)]
        );
        if (byId.length) return byId[0];
    }
    const byStudentId = await selectRows(
        "SELECT id, student_id, name, email, department, semester, phone, created_at FROM students WHERE student_id = ?",
        [value]
    );
    return byStudentId[0] || null;
}

function authenticateToken(req, res, next) {
    const authorization = String(req.headers.authorization || "");
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : String(req.cookies.access_token || "");
    if (!token) return res.status(401).json({ message: "Authentication token required" });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        if (!req.user.sid) return next();
        if (!databaseReady) return res.status(503).json({ message: "Database is not available." });
        selectRows("SELECT expires_at FROM auth_sessions WHERE session_id = ? AND user_id = ?", [req.user.sid, req.user.userId])
            .then((sessions) => {
                const expiry = sessions.length ? databaseDateTime(sessions[0].expires_at) : 0;
                if (!sessions.length || expiry <= Date.now()) {
                    return res.status(401).json({ message: "Session expired or revoked" });
                }
                next();
            })
            .catch((error) => {
                console.error("Session validation error:", error);
                res.status(500).json({ message: "Unable to validate session" });
            });
    } catch (error) {
        return res.status(401).json({ message: "Invalid or expired authentication token" });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ message: "You are not authorized to access this page" });
        }
        next();
    };
}

function requireRoles(...roles) {
    return [authenticateToken, requireRole(...roles)];
}

const requireAdmin = [authenticateToken, requireRole("admin")];

async function canManageClass(user, classId) {
    if (user.role === "admin") return true;
    const rows = await selectRows("SELECT id FROM classes WHERE id = ? AND teacher_user_id = ?", [classId, user.id]);
    return rows.length > 0;
}

function publicStudent(student) {
    const { password, ...safeStudent } = student;
    return safeStudent;
}

function classFields(body) {
    const className = nonEmptyText(body.class_name, 100);
    const subject = nonEmptyText(body.subject, 100);
    const department = nonEmptyText(body.department, 50);
    const teacherName = nonEmptyText(body.teacher_name, 100);
    const semester = Number(body.semester);
    const teacherUserId = body.teacher_user_id == null || body.teacher_user_id === "" ? null : Number(body.teacher_user_id);
    return className && subject && department && teacherName && validSemester(semester) &&
        (teacherUserId === null || (Number.isInteger(teacherUserId) && teacherUserId > 0))
        ? [className, subject, department, semester, teacherName, teacherUserId] : null;
}

app.get("/api/classes", ...requireRoles("admin", "teacher"), async (req, res) => {
    try {
        const classes = await selectRows(
            `SELECT id, class_name, subject, department, semester, teacher_name, teacher_user_id, created_at
             FROM classes ${req.user.role === "teacher" ? "WHERE teacher_user_id = ?" : ""}
             ORDER BY class_name`,
            req.user.role === "teacher" ? [req.user.id] : []
        );
        res.json({ classes });
    } catch (error) {
        console.error("Class list error:", error);
        res.status(500).json({ message: "Unable to load classes" });
    }
});

app.get("/api/classes/:classId/enrollments", ...requireRoles("admin", "teacher"), async (req, res) => {
    const classId = Number(req.params.classId);
    if (!Number.isInteger(classId) || classId < 1) return res.status(400).json({ message: "Invalid class ID" });
    if (!(await canManageClass(req.user, classId))) return res.status(403).json({ message: "You are not assigned to this class" });
    try {
        const classes = await selectRows("SELECT id FROM classes WHERE id = ?", [classId]);
        if (!classes.length) return res.status(404).json({ message: "Class not found" });
        const students = await selectRows(
            `SELECT s.id, s.student_id, s.name, s.email, s.department, s.semester
             FROM enrollments e JOIN students s ON s.id = e.student_id
             WHERE e.class_id = ? ORDER BY s.name`,
            [classId]
        );
        res.json({ students, total: students.length });
    } catch (error) {
        console.error("Class enrollment list error:", error);
        res.status(500).json({ message: "Unable to load class roster" });
    }
});

app.post("/api/classes/:classId/enrollments", requireAdmin, async (req, res) => {
    const classId = Number(req.params.classId);
    const student = await findStudent(req.body.student_id);
    if (!Number.isInteger(classId) || classId < 1 || !student) return res.status(400).json({ message: "Select a valid class and student" });
    try {
        const classes = await selectRows("SELECT id FROM classes WHERE id = ?", [classId]);
        if (!classes.length) return res.status(404).json({ message: "Class not found" });
        const duplicate = await selectRows("SELECT id FROM enrollments WHERE class_id = ? AND student_id = ?", [classId, student.id]);
        if (duplicate.length) return res.status(409).json({ message: "Student is already enrolled in this class" });
        await executeQuery("INSERT INTO enrollments (class_id, student_id) VALUES (?, ?)", [classId, student.id]);
        res.status(201).json({ message: "Student enrolled successfully", enrollment: { class_id: classId, student_id: student.id } });
    } catch (error) {
        console.error("Student enrollment error:", error);
        res.status(500).json({ message: "Unable to enroll student" });
    }
});

app.delete("/api/classes/:classId/enrollments/:studentId", requireAdmin, async (req, res) => {
    const classId = Number(req.params.classId);
    const student = await findStudent(req.params.studentId);
    if (!Number.isInteger(classId) || classId < 1 || !student) return res.status(400).json({ message: "Select a valid class and student" });
    try {
        const result = await executeQuery("DELETE FROM enrollments WHERE class_id = ? AND student_id = ?", [classId, student.id]);
        if (!result.affectedRows && !result.changes) return res.status(404).json({ message: "Enrollment not found" });
        res.json({ message: "Student removed from class" });
    } catch (error) {
        console.error("Student unenrollment error:", error);
        res.status(500).json({ message: "Unable to remove student from class" });
    }
});

app.get("/api/teachers", requireAdmin, async (req, res) => {
    try {
        const teachers = await selectRows("SELECT id, name, email, created_at FROM users WHERE role = 'teacher' ORDER BY name");
        res.json({ teachers, total: teachers.length });
    } catch (error) {
        console.error("Teacher list error:", error);
        res.status(500).json({ message: "Unable to load teachers" });
    }
});

app.post("/api/teachers", requireAdmin, async (req, res) => {
    try {
        const name = nonEmptyText(req.body.name, 100);
        const email = String(req.body.email || "").trim().toLowerCase();
        const password = String(req.body.password || "");
        if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 12) {
            return res.status(400).json({ message: "Name, valid email, and a password of at least 12 characters are required" });
        }
        const existing = await selectRows("SELECT id FROM users WHERE email = ?", [email]);
        if (existing.length) return res.status(409).json({ message: "An account with this email already exists" });
        const passwordHash = await bcrypt.hash(password, 10);
        const id = await upsertRoleUser(name, email, passwordHash, "teacher");
        res.status(201).json({ message: "Teacher account created", teacher: { id, name, email, role: "teacher" } });
    } catch (error) {
        console.error("Teacher create error:", error);
        res.status(500).json({ message: "Unable to create teacher" });
    }
});

app.post("/api/classes", requireAdmin, async (req, res) => {
    try {
        const fields = classFields(req.body);
        if (!fields) return res.status(400).json({ message: "Please provide valid class fields" });
        if (fields[5]) {
            const teachers = await selectRows("SELECT id, name FROM users WHERE id = ? AND role = 'teacher'", [fields[5]]);
            if (!teachers.length) return res.status(400).json({ message: "Please select a valid teacher" });
            fields[4] = teachers[0].name;
        }
        const result = await executeQuery("INSERT INTO classes (class_name, subject, department, semester, teacher_name, teacher_user_id) VALUES (?, ?, ?, ?, ?, ?)", fields);
        const rows = await selectRows("SELECT id, class_name, subject, department, semester, teacher_name, teacher_user_id, created_at FROM classes WHERE id = ?", [result.insertId]);
        res.status(201).json({ message: "Class created successfully", class: rows[0] });
    } catch (error) {
        console.error("Class create error:", error);
        res.status(500).json({ message: "Unable to create class" });
    }
});

app.put("/api/classes/:id", requireAdmin, async (req, res) => {
    try {
        const fields = classFields(req.body);
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id < 1 || !fields) return res.status(400).json({ message: "Please provide valid class fields" });
        if (fields[5]) {
            const teachers = await selectRows("SELECT id, name FROM users WHERE id = ? AND role = 'teacher'", [fields[5]]);
            if (!teachers.length) return res.status(400).json({ message: "Please select a valid teacher" });
            fields[4] = teachers[0].name;
        }
        const result = await executeQuery("UPDATE classes SET class_name = ?, subject = ?, department = ?, semester = ?, teacher_name = ?, teacher_user_id = ? WHERE id = ?", [...fields, id]);
        if (!result.affectedRows && !result.changes) return res.status(404).json({ message: "Class not found" });
        res.json({ message: "Class updated successfully" });
    } catch (error) {
        console.error("Class update error:", error);
        res.status(500).json({ message: "Unable to update class" });
    }
});

app.delete("/api/classes/:id", requireAdmin, async (req, res) => {
    try {
        const result = await executeQuery("DELETE FROM classes WHERE id = ?", [Number(req.params.id)]);
        if (!result.affectedRows && !result.changes) return res.status(404).json({ message: "Class not found" });
        res.json({ message: "Class deleted successfully" });
    } catch (error) {
        console.error("Class delete error:", error);
        res.status(500).json({ message: "Unable to delete class" });
    }
});

app.get("/api/students", requireAdmin, async (req, res) => {
    try {
        const rows = await selectRows("SELECT id, student_id, name, email, department, semester, phone, created_at FROM students ORDER BY name");
        res.json({ students: rows, total: rows.length });
    } catch (error) {
        console.error("Student list error:", error);
        res.status(500).json({ message: "Unable to load students" });
    }
});

app.get("/api/students/:id", requireAdmin, async (req, res) => {
    const student = await findStudent(req.params.id);
    if (!student) return res.status(404).json({ message: "Student not found" });
    res.json({ student });
});

app.put("/api/students/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const name = nonEmptyText(req.body.name, 100);
    const phone = nonEmptyText(req.body.phone, 20);
    const department = nonEmptyText(req.body.department, 50);
    const semester = Number(req.body.semester);
    if (!Number.isInteger(id) || !name || !phone || !department || !validSemester(semester)) {
        return res.status(400).json({ message: "Please provide valid profile fields" });
    }
    const existing = await selectRows("SELECT id FROM students WHERE id = ?", [id]);
    if (!existing.length) return res.status(404).json({ message: "Student not found" });
    const result = await executeQuery("UPDATE students SET name = ?, phone = ?, department = ?, semester = ? WHERE id = ?", [name, phone, department, semester, id]);
    await executeQuery("UPDATE users SET name = ? WHERE id = (SELECT user_id FROM students WHERE id = ?)", [name, id]);
    res.json({ message: "Student updated successfully" });
});

app.delete("/api/students/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ message: "Invalid student ID" });
    const rows = await selectRows("SELECT user_id FROM students WHERE id = ?", [id]);
    if (!rows.length) return res.status(404).json({ message: "Student not found" });
    if (rows[0].user_id) await executeQuery("DELETE FROM users WHERE id = ?", [rows[0].user_id]);
    await executeQuery("DELETE FROM students WHERE id = ?", [id]);
    res.json({ message: "Student deleted successfully" });
});

app.get("/api/attendance", ...requireRoles("admin", "teacher"), async (req, res) => {
    const date = String(req.query.date || "").trim();
    if (date && !validDate(date)) return res.status(400).json({ message: "Invalid date" });
    const filters = [];
    const params = [];
    if (date) { filters.push("a.attendance_date = ?"); params.push(date); }
    if (req.query.class_id) {
        const classId = Number(req.query.class_id);
        if (!Number.isInteger(classId) || classId < 1) return res.status(400).json({ message: "Invalid class ID" });
        if (!(await canManageClass(req.user, classId))) return res.status(403).json({ message: "You are not assigned to this class" });
        filters.push("a.class_id = ?");
        params.push(classId);
    }
    if (req.user.role === "teacher") { filters.push("c.teacher_user_id = ?"); params.push(req.user.id); }
    const records = await selectRows(`SELECT a.id, a.student_id, a.class_id, a.attendance_date, a.attendance_time, a.period, a.notes, a.status, s.name, s.student_id AS registration_id
        FROM attendance a JOIN students s ON s.id = a.student_id
        LEFT JOIN classes c ON c.id = a.class_id
        ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
        ORDER BY a.attendance_date DESC, a.id DESC`, params);
    res.json({ records, total: records.length });
});

app.get("/api/attendance/student/:studentId", authenticateToken, requireRole("student", "admin"), async (req, res) => {
    if (req.user.role === "student" && Number(req.params.studentId) !== Number(req.user.id)) return res.status(403).json({ message: "You are not authorized to view this attendance" });
    const student = await findStudent(req.params.studentId);
    if (!student) return res.status(404).json({ message: "Student not found" });
    const records = await selectRows("SELECT id, student_id, class_id, attendance_date, status FROM attendance WHERE student_id = ? ORDER BY attendance_date DESC", [student.id]);
    const present = records.filter((record) => record.status === "Present").length;
    res.json({ summary: { present, absent: records.length - present, total: records.length, percentage: records.length ? Math.round(present * 100 / records.length) : 0 }, records });
});

app.get("/api/attendance/report", requireAdmin, async (req, res) => {
    const rows = await selectRows("SELECT s.student_id, s.name, COUNT(a.id) AS total_classes, SUM(CASE WHEN a.status = 'Present' THEN 1 ELSE 0 END) AS present_classes FROM students s LEFT JOIN attendance a ON a.student_id = s.id GROUP BY s.id, s.student_id, s.name ORDER BY s.name");
    res.json({ report: rows.map((row) => ({ ...row, percentage: row.total_classes ? Math.round(row.present_classes * 100 / row.total_classes) : 0 })) });
});

app.post("/api/attendance", ...requireRoles("admin", "teacher"), async (req, res) => {
    const student = await findStudent(req.body.student_id);
    const classId = Number(req.body.class_id);
    const date = String(req.body.attendance_date || req.body.date || "");
    const status = String(req.body.status || "");
    const rawTime = String(req.body.time || req.body.attendance_time || "00:00").trim();
    const time = rawTime.length === 5 ? `${rawTime}:00` : rawTime;
    const period = nonEmptyText(req.body.period || "General", 50);
    const notes = req.body.notes == null ? null : String(req.body.notes).trim();
    if (!student || !Number.isInteger(classId) || classId < 1 || !validDate(date) || !validTime(time) ||
        !period || notes && notes.length > 500 || !["Present", "Absent"].includes(status)) {
        return res.status(400).json({ message: "Invalid attendance data" });
    }
    if (!(await canManageClass(req.user, classId))) return res.status(403).json({ message: "You are not assigned to this class" });
    const classes = await selectRows("SELECT id FROM classes WHERE id = ?", [classId]);
    if (!classes.length) return res.status(404).json({ message: "Class not found" });
    const enrollment = await selectRows("SELECT id FROM enrollments WHERE student_id = ? AND class_id = ?", [student.id, classId]);
    if (!enrollment.length) return res.status(409).json({ message: "Student is not enrolled in this class" });
    const duplicate = await selectRows("SELECT id FROM attendance WHERE student_id = ? AND class_id = ? AND attendance_date = ?", [student.id, classId, date]);
    if (duplicate.length) return res.status(409).json({ message: "Attendance already exists for this student, class, and date" });
    const result = await executeQuery(
        "INSERT INTO attendance (student_id, class_id, attendance_date, attendance_time, period, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [student.id, classId, date, time, period, status, notes]
    );
    res.status(201).json({ message: "Attendance saved successfully", id: result.insertId });
});

app.post("/api/admin/login", authLimiter, async (req, res) => {
    if (!databaseReady) return res.status(503).json({ message: "Database is not available." });
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!email || !password) return res.status(400).json({ message: "Email and password are required" });
    const users = email === adminEmail
        ? await selectRows("SELECT id, password_hash FROM users WHERE email = ? AND role = 'admin'", [email])
        : [];
    if (!users.length || !(await bcrypt.compare(password, users[0].password_hash))) {
        return res.status(401).json({ message: "Invalid admin email or password" });
    }
    const session = await issueSession(users[0].id, users[0].id, "admin", adminEmail);
    setSessionCookies(res, session.accessToken, session.refreshToken);
    res.json({ message: "Admin login successful", token: session.accessToken, admin: { email: adminEmail, role: "admin" } });
});

app.post("/api/admin/logout", requireAdmin, async (req, res) => {
    if (req.user.sid) await executeQuery("DELETE FROM auth_sessions WHERE session_id = ?", [req.user.sid]);
    clearSessionCookies(res);
    res.json({ message: "Logged out successfully" });
});

app.put("/api/admin/account", requireAdmin, async (req, res) => {
    try {
        const currentPassword = String(req.body.currentPassword || "");
        const newEmail = String(req.body.email || "").trim().toLowerCase();
        const newPassword = String(req.body.newPassword || "");
        if (!currentPassword || !newEmail || !newPassword) {
            return res.status(400).json({ message: "Current password, email, and new password are required" });
        }
        if (!/^\S+@\S+\.\S+$/.test(newEmail)) {
            return res.status(400).json({ message: "Please enter a valid email address" });
        }
        if (newPassword.length < 12) {
            return res.status(400).json({ message: "New password must be at least 12 characters" });
        }
        if (!(await bcrypt.compare(currentPassword, adminPasswordHash))) {
            return res.status(401).json({ message: "Current password is incorrect" });
        }
        const conflictingUsers = await selectRows("SELECT id FROM users WHERE email = ? AND role <> 'admin'", [newEmail]);
        if (conflictingUsers.length) return res.status(409).json({ message: "That email is already assigned to another account" });

        adminEmail = newEmail;
        adminPasswordHash = await bcrypt.hash(newPassword, 10);
        await saveAdminSettings();
        const adminUserId = await upsertRoleUser("Administrator", adminEmail, adminPasswordHash, "admin");
        await executeQuery("DELETE FROM auth_sessions WHERE user_id = ?", [adminUserId]);
        res.json({ message: "Admin email and password changed successfully. Please log in again." });
    } catch (error) {
        console.error("Admin account update error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// Admin student directory, with an optional search over ID, name, email, or department.
app.get("/api/admin/students", requireAdmin, async (req, res) => {
    try {
        if (!databaseReady) return res.status(503).json({ message: "Database is not available." });
        const search = String(req.query.search || "").trim();
        const like = `%${search}%`;
        const rows = await selectRows(
            `SELECT id, student_id, name, email, department, semester, phone, created_at
             FROM students
             WHERE ? = '' OR student_id LIKE ? OR name LIKE ? OR email LIKE ? OR department LIKE ?
             ORDER BY name ASC`,
            [search, like, like, like, like]
        );
        res.json({ students: rows, total: rows.length });
    } catch (error) {
        console.error("Admin students error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

app.get("/api/admin/students/:studentId", requireAdmin, async (req, res) => {
    try {
        if (!databaseReady) return res.status(503).json({ message: "Database is not available." });
        const student = await findStudent(req.params.studentId);
        if (!student) return res.status(404).json({ message: "Student not found" });
        const attendance = await selectRows(
            `SELECT id, attendance_date, attendance_time, period, status, notes
             FROM attendance WHERE student_id = ?
             ORDER BY attendance_date DESC, attendance_time DESC, id DESC`,
            [student.id]
        );
        const present = attendance.filter((record) => record.status === "Present").length;
        res.json({
            student,
            summary: {
                present,
                absent: attendance.length - present,
                total: attendance.length,
                percentage: attendance.length ? Math.round((present / attendance.length) * 100) : 0
            },
            records: attendance
        });
    } catch (error) {
        console.error("Admin student details error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

app.get("/api/admin/attendance", requireAdmin, async (req, res) => {
    try {
        if (!databaseReady) return res.status(503).json({ message: "Database is not available." });
        const filters = [];
        const params = [];
        if (req.query.studentId) {
            const student = await findStudent(req.query.studentId);
            if (!student) return res.status(404).json({ message: "Student not found" });
            filters.push("a.student_id = ?");
            params.push(student.id);
        }
        if (req.query.date) {
            if (!validDate(req.query.date)) return res.status(400).json({ message: "Invalid date" });
            filters.push("a.attendance_date = ?");
            params.push(req.query.date);
        }
        if (req.query.status && ["Present", "Absent"].includes(req.query.status)) {
            filters.push("a.status = ?");
            params.push(req.query.status);
        }
        const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
        params.push(limit);
        const records = await selectRows(
            `SELECT a.id, a.student_id AS id_reference, s.student_id, s.name, a.attendance_date,
                    a.attendance_time, a.period, a.status, a.notes
             FROM attendance a JOIN students s ON s.id = a.student_id
             ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
             ORDER BY a.attendance_date DESC, a.attendance_time DESC, a.id DESC LIMIT ?`,
            params
        );
        res.json({ records, total: records.length });
    } catch (error) {
        console.error("Admin attendance list error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

app.get("/api/admin/students/:studentId/attendance", requireAdmin, async (req, res) => {
    try {
        if (!databaseReady) return res.status(503).json({ message: "Database is not available." });
        const student = await findStudent(req.params.studentId);
        if (!student) return res.status(404).json({ message: "Student not found" });
        const records = await selectRows(
            `SELECT id, attendance_date, attendance_time, period, status, notes
             FROM attendance WHERE student_id = ?
             ORDER BY attendance_date DESC, attendance_time DESC, id DESC`,
            [student.id]
        );
        const present = records.filter((record) => record.status === "Present").length;
        res.json({
            summary: {
                present,
                absent: records.length - present,
                total: records.length,
                percentage: records.length ? Math.round((present / records.length) * 100) : 0
            },
            records
        });
    } catch (error) {
        console.error("Admin attendance error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

app.post("/api/admin/students/:studentId/attendance", requireAdmin, async (req, res) => {
    try {
        if (!databaseReady) return res.status(503).json({ message: "Database is not available." });
        const student = await findStudent(req.params.studentId);
        if (!student) return res.status(404).json({ message: "Student not found" });

        const attendanceDate = String(
            req.body.date || req.body.attendance_date || req.body.attendanceDate || ""
        ).trim();
        const rawTime = String(
            req.body.time || req.body.attendance_time || req.body.attendanceTime || ""
        ).trim();
        const attendanceTime = rawTime.length === 5 ? `${rawTime}:00` : rawTime;
        const period = String(req.body.period || "General").trim();
        const classId = req.body.class_id ? Number(req.body.class_id) : null;
        const statusInput = String(req.body.status || "").trim().toLowerCase();
        const status = statusInput === "present" ? "Present" : statusInput === "absent" ? "Absent" : "";
        const notes = req.body.notes == null ? null : String(req.body.notes).trim();
        if (!validDate(attendanceDate) || !validTime(attendanceTime)) {
            return res.status(400).json({ message: "A valid date and time are required" });
        }
        if (!period || period.length > 50) return res.status(400).json({ message: "Period must be 1-50 characters" });
        if (req.body.class_id && (!Number.isInteger(classId) || classId < 1)) return res.status(400).json({ message: "Please select a valid class" });
        if (notes && notes.length > 500) return res.status(400).json({ message: "Notes must be 500 characters or fewer" });
        if (!["Present", "Absent"].includes(status)) {
            return res.status(400).json({ message: "Status must be Present or Absent" });
        }
        if (classId) {
            const classes = await selectRows("SELECT id FROM classes WHERE id = ?", [classId]);
            if (!classes.length) return res.status(404).json({ message: "Class not found" });
            const enrollment = await selectRows("SELECT id FROM enrollments WHERE student_id = ? AND class_id = ?", [student.id, classId]);
            if (!enrollment.length) return res.status(409).json({ message: "Student is not enrolled in this class" });
            const duplicate = await selectRows("SELECT id FROM attendance WHERE student_id = ? AND class_id = ? AND attendance_date = ?", [student.id, classId, attendanceDate]);
            if (duplicate.length) return res.status(409).json({ message: "Attendance already exists for this student, class, and date" });
        }

        if (dbType === "mysql") {
            await executeQuery(
                `INSERT INTO attendance
                          (student_id, class_id, attendance_date, attendance_time, period, status, notes)
                      VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE status = VALUES(status), notes = VALUES(notes)`,
                [student.id, classId, attendanceDate, attendanceTime, period, status, notes]
            );
        } else {
            await executeQuery(
                `INSERT INTO attendance
                     (student_id, class_id, attendance_date, attendance_time, period, status, notes)
                     VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(student_id, attendance_date, attendance_time, period)
                 DO UPDATE SET status = excluded.status, notes = excluded.notes`,
                [student.id, classId, attendanceDate, attendanceTime, period, status, notes]
            );
        }
        const records = await selectRows(
            `SELECT id, attendance_date, attendance_time, period, status, notes
             FROM attendance
             WHERE student_id = ? AND attendance_date = ? AND attendance_time = ? AND period = ?`,
            [student.id, attendanceDate, attendanceTime, period]
        );
        res.status(201).json({ message: "Attendance saved successfully", record: records[0] });
    } catch (error) {
        console.error("Admin mark attendance error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// Student attendance summary and recent records
app.get("/api/students/:studentId/attendance", authenticateToken, requireRole("student", "admin"), async (req, res) => {
    try {
        if (req.user.role === "student" && Number(req.params.studentId) !== Number(req.user.id)) {
            return res.status(403).json({ message: "You are not authorized to access this student's records" });
        }
        if (!databaseReady) {
            return res.status(503).json({ message: "Database is not available." });
        }

        const student = await findStudent(req.params.studentId);
        if (!student) return res.status(404).json({ message: "Student not found" });

        const records = await selectRows(
            `SELECT id, attendance_date, attendance_time, period, status, notes
             FROM attendance
             WHERE student_id = ?
             ORDER BY attendance_date DESC, attendance_time DESC, id DESC`,
            [student.id]
        );
        const present = records.filter((record) => record.status === "Present").length;
        const total = records.length;

        res.json({
            summary: {
                present,
                absent: total - present,
                total,
                percentage: total === 0 ? 0 : Math.round((present / total) * 100)
            },
            records
        });
    } catch (error) {
        console.error("Attendance Error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// Student profile update
app.put("/api/students/:studentId/profile", authenticateToken, requireRole("student", "admin"), async (req, res) => {
    try {
        if (req.user.role === "student" && Number(req.params.studentId) !== Number(req.user.id)) {
            return res.status(403).json({ message: "You are not authorized to update this profile" });
        }
        if (!databaseReady) {
            return res.status(503).json({ message: "Database is not available." });
        }

        const studentId = Number(req.params.studentId);
        const name = nonEmptyText(req.body.name, 100);
        const phone = nonEmptyText(req.body.phone, 20);
        const department = nonEmptyText(req.body.department, 50);
        const semester = Number(req.body.semester);
        if (!Number.isInteger(studentId) || studentId < 1 || !name || !phone ||
            !department || !validSemester(semester)) {
            return res.status(400).json({ message: "Please provide valid profile fields" });
        }

        await executeQuery(
            `UPDATE students
             SET name = ?, phone = ?, department = ?, semester = ?
             WHERE id = ?`,
            [name, phone, department, semester, studentId]
        );
        await executeQuery("UPDATE users SET name = ? WHERE id = (SELECT user_id FROM students WHERE id = ?)", [name, studentId]);
        const rows = await selectRows(
            "SELECT id, student_id, name, email, department, semester, phone FROM students WHERE id = ?",
            [studentId]
        );
        if (rows.length === 0) {
            return res.status(404).json({ message: "Student not found" });
        }
        res.json({ message: "Profile updated successfully", student: rows[0] });
    } catch (error) {
        console.error("Profile Error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

// Student password change
app.put("/api/students/:studentId/password", authenticateToken, requireRole("student", "admin"), async (req, res) => {
    try {
        if (req.user.role === "student" && Number(req.params.studentId) !== Number(req.user.id)) {
            return res.status(403).json({ message: "You are not authorized to update this password" });
        }
        if (!databaseReady) {
            return res.status(503).json({ message: "Database is not available." });
        }

        const studentId = Number(req.params.studentId);
        const { currentPassword, newPassword } = req.body;
        if (!Number.isInteger(studentId) || studentId < 1 || !currentPassword || !newPassword) {
            return res.status(400).json({ message: "Current and new passwords are required" });
        }
        if (String(newPassword).length < 6) {
            return res.status(400).json({ message: "New password must be at least 6 characters" });
        }

        const rows = await selectRows("SELECT password, user_id FROM students WHERE id = ?", [studentId]);
        if (rows.length === 0) {
            return res.status(404).json({ message: "Student not found" });
        }
        if (!(await bcrypt.compare(String(currentPassword), rows[0].password))) {
            return res.status(401).json({ message: "Current password is incorrect" });
        }

        const hashedPassword = await bcrypt.hash(String(newPassword), 10);
        await executeQuery("UPDATE students SET password = ? WHERE id = ?", [hashedPassword, studentId]);
        await executeQuery("UPDATE users SET password_hash = ? WHERE id = ?", [hashedPassword, rows[0].user_id]);
        if (req.user.sid) {
            await executeQuery("DELETE FROM auth_sessions WHERE user_id = ? AND session_id <> ?", [rows[0].user_id, req.user.sid]);
        } else {
            await executeQuery("DELETE FROM auth_sessions WHERE user_id = ?", [rows[0].user_id]);
        }
        res.json({ message: "Password changed successfully" });
    } catch (error) {
        console.error("Password Error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

const PORT = process.env.PORT || 5000;

app.locals.initializeDatabase = initializeDatabase;
app.locals.closeDatabase = async () => {
    if (!db) return;
    if (dbType === "mysql") await db.end();
    else await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
    db = null;
    databaseReady = false;
};

app.get("/api/health", (req, res) => {
    res.status(databaseReady ? 200 : 503).json({ status: databaseReady ? "ok" : "database_unavailable" });
});

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
        return res.status(400).json({ message: "Request body must contain valid JSON" });
    }
    if (error.status >= 400 && error.status < 500) {
        return res.status(error.status).json({ message: error.type === "entity.too.large" ? "Request body is too large" : error.message });
    }
    console.error("Unhandled request error:", error);
    res.status(500).json({ message: "Server error" });
});

async function startServer() {
    await initializeDatabase();
    app.listen(PORT, process.env.HOST || (isProduction ? "0.0.0.0" : "127.0.0.1"), () => {
        console.log(`Server running on http://127.0.0.1:${PORT}`);
    });
}

if (require.main === module) {
    startServer();
}

module.exports = app;