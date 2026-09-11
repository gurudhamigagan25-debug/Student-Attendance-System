const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(cors());
app.use(express.json());

const DB_CONFIG = {
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "abc123",
    database: process.env.DB_NAME || "student_attendance",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

const SQLITE_DB_PATH = path.join(__dirname, "database", "student_attendance.db");
let db = null;
let dbType = "mysql";
let databaseReady = false;
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "admin@example.com").trim().toLowerCase();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || "admin123");
let adminEmail = ADMIN_EMAIL;
let adminPasswordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
const adminTokens = new Set();

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
                return;
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

    await sqliteRun(`
        CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            department TEXT NOT NULL,
            semester INTEGER NOT NULL,
            phone TEXT NOT NULL,
            password TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    `);
    await sqliteRun(`
        CREATE TABLE IF NOT EXISTS attendance (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            student_id INTEGER NOT NULL,
            attendance_date TEXT NOT NULL,
            attendance_time TEXT NOT NULL DEFAULT '00:00:00',
            period TEXT NOT NULL DEFAULT 'General',
            status TEXT NOT NULL CHECK(status IN ('Present', 'Absent')),
            notes TEXT,
            UNIQUE(student_id, attendance_date, attendance_time, period),
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

    const indexes = await sqliteAll("PRAGMA index_list(attendance)");
    let hasSlotIndex = false;
    let hasDateOnlyUniqueIndex = false;
    for (const index of indexes) {
        if (!index.unique) continue;
        const indexColumns = await sqliteAll(`PRAGMA index_info("${index.name.replace(/"/g, '""')}")`);
        const names = indexColumns.sort((a, b) => a.seqno - b.seqno).map((item) => item.name);
        if (names.join("|") === "student_id|attendance_date|attendance_time|period") hasSlotIndex = true;
        if (names.join("|") === "student_id|attendance_date") hasDateOnlyUniqueIndex = true;
    }
    if (!hasSlotIndex || hasDateOnlyUniqueIndex) {
        await sqliteRun("PRAGMA foreign_keys = OFF");
        await sqliteRun(`
            CREATE TABLE attendance_migrated (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                student_id INTEGER NOT NULL,
                attendance_date TEXT NOT NULL,
                attendance_time TEXT NOT NULL DEFAULT '00:00:00',
                period TEXT NOT NULL DEFAULT 'General',
                status TEXT NOT NULL CHECK(status IN ('Present', 'Absent')),
                notes TEXT,
                UNIQUE(student_id, attendance_date, attendance_time, period),
                FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE
            )
        `);
        await sqliteRun(`
            INSERT OR IGNORE INTO attendance_migrated
                (id, student_id, attendance_date, attendance_time, period, status, notes)
            SELECT id, student_id, attendance_date,
                COALESCE(attendance_time, '00:00:00'),
                COALESCE(period, 'General'), status, notes
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
        return;
    }
    adminEmail = settings.get("admin_email");
    adminPasswordHash = settings.get("admin_password_hash");
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
    try {
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
                CREATE TABLE IF NOT EXISTS students (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    student_id VARCHAR(50) NOT NULL UNIQUE,
                    name VARCHAR(100) NOT NULL,
                    email VARCHAR(150) NOT NULL UNIQUE,
                    department VARCHAR(50) NOT NULL,
                    semester INT NOT NULL,
                    phone VARCHAR(20) NOT NULL,
                    password VARCHAR(255) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);
            await adminConnection.query(`
                CREATE TABLE IF NOT EXISTS attendance (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    student_id INT NOT NULL,
                    attendance_date DATE NOT NULL,
                    attendance_time TIME NOT NULL DEFAULT '00:00:00',
                    period VARCHAR(50) NOT NULL DEFAULT 'General',
                    status ENUM('Present', 'Absent') NOT NULL,
                    notes TEXT NULL,
                    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
                    UNIQUE KEY attendance_student_slot (student_id, attendance_date, attendance_time, period)
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
        } finally {
            await adminConnection.end();
        }

        db = mysql.createPool(DB_CONFIG);
        dbType = "mysql";
        databaseReady = true;
        await executeQuery(
            "CREATE TABLE IF NOT EXISTS admin_settings (setting_key VARCHAR(50) PRIMARY KEY, setting_value TEXT NOT NULL)"
        );
        await loadAdminSettings();
        console.log("Connected to MySQL database.");
        return;
    } catch (error) {
        console.warn("MySQL not available; falling back to SQLite.", sqliteErrorMessage(error));
    }

    try {
        db = await createSqliteDatabase();
        dbType = "sqlite";
        databaseReady = true;
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
        return db.execute(queryString, params);
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

// Test route
app.get("/", (req, res) => {
    res.send("Student Attendance System Backend is Running!");
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

        if (
            !student_id ||
            !name ||
            !email ||
            !department ||
            !semester ||
            !phone ||
            !password
        ) {
            return res.status(400).json({
                message: "All fields are required"
            });
        }

        const trimmedStudentId = String(student_id).trim();
        const trimmedEmail = String(email).trim().toLowerCase();

        if (!/^\S+@\S+\.\S+$/.test(trimmedEmail)) {
            return res.status(400).json({
                message: "Please enter a valid email address"
            });
        }

        const existing = await selectRows(
            "SELECT id FROM students WHERE student_id = ? OR email = ?",
            [trimmedStudentId, trimmedEmail]
        );

        if (existing.length > 0) {
            return res.status(409).json({
                message: "Student ID or Email already exists"
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        await executeQuery(
            `INSERT INTO students
            (student_id, name, email, department, semester, phone, password)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                trimmedStudentId,
                name.trim(),
                trimmedEmail,
                department.trim(),
                Number(semester),
                phone.trim(),
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
app.post("/api/students/login", async (req, res) => {
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
            "SELECT * FROM students WHERE email = ?",
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
            student.password
        );

        if (!passwordMatch) {
            return res.status(401).json({
                message: "Invalid email or password"
            });
        }

        res.json({
            message: "Login successful",
            student: {
                id: student.id,
                student_id: student.student_id,
                name: student.name,
                email: student.email,
                department: student.department,
                semester: student.semester,
                phone: student.phone
            }
        });

    } catch (error) {
        console.error("Login Error:", error);

        res.status(500).json({
            message: "Server error"
        });
    }
});

function requireAdmin(req, res, next) {
    const authorization = String(req.headers.authorization || "");
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (!token || !adminTokens.has(token)) {
        return res.status(401).json({ message: "Admin authentication required" });
    }
    next();
}

function validDate(value) {
    const date = String(value || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const parsed = new Date(`${date}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function validTime(value) {
    return /^\d{2}:\d{2}(:\d{2})?$/.test(String(value || "")) &&
        Number(String(value).split(":")[0]) < 24 &&
        Number(String(value).split(":")[1]) < 60;
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

// Admin authentication uses the configured account (ADMIN_EMAIL/ADMIN_PASSWORD).
app.post("/api/admin/login", async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!email || !password) {
        return res.status(400).json({ message: "Email and password are required" });
    }
    if (email !== adminEmail || !(await bcrypt.compare(password, adminPasswordHash))) {
        return res.status(401).json({ message: "Invalid admin email or password" });
    }
    const token = crypto.randomBytes(32).toString("hex");
    adminTokens.add(token);
    res.json({
        message: "Admin login successful",
        token,
        admin: { email: adminEmail }
    });
});

app.post("/api/admin/logout", requireAdmin, (req, res) => {
    const token = String(req.headers.authorization || "").slice(7).trim();
    adminTokens.delete(token);
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
        if (newPassword.length < 6) {
            return res.status(400).json({ message: "New password must be at least 6 characters" });
        }
        if (!(await bcrypt.compare(currentPassword, adminPasswordHash))) {
            return res.status(401).json({ message: "Current password is incorrect" });
        }

        adminEmail = newEmail;
        adminPasswordHash = await bcrypt.hash(newPassword, 10);
        await saveAdminSettings();
        adminTokens.clear();
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
        const statusInput = String(req.body.status || "").trim().toLowerCase();
        const status = statusInput === "present" ? "Present" : statusInput === "absent" ? "Absent" : "";
        const notes = req.body.notes == null ? null : String(req.body.notes).trim();
        if (!validDate(attendanceDate) || !validTime(attendanceTime)) {
            return res.status(400).json({ message: "A valid date and time are required" });
        }
        if (!period || period.length > 50) return res.status(400).json({ message: "Period must be 1-50 characters" });
        if (!["Present", "Absent"].includes(status)) {
            return res.status(400).json({ message: "Status must be Present or Absent" });
        }

        if (dbType === "mysql") {
            await executeQuery(
                `INSERT INTO attendance
                    (student_id, attendance_date, attendance_time, period, status, notes)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE status = VALUES(status), notes = VALUES(notes)`,
                [student.id, attendanceDate, attendanceTime, period, status, notes]
            );
        } else {
            await executeQuery(
                `INSERT INTO attendance
                    (student_id, attendance_date, attendance_time, period, status, notes)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(student_id, attendance_date, attendance_time, period)
                 DO UPDATE SET status = excluded.status, notes = excluded.notes`,
                [student.id, attendanceDate, attendanceTime, period, status, notes]
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
app.get("/api/students/:studentId/attendance", async (req, res) => {
    try {
        if (!databaseReady) {
            return res.status(503).json({ message: "Database is not available." });
        }

        const student = await findStudent(req.params.studentId);
        if (!student) return res.status(404).json({ message: "Student not found" });

        const records = await selectRows(
            `SELECT id, attendance_date, attendance_time, period, status, notes
             FROM attendance
             WHERE student_id = ?
             ORDER BY attendance_date DESC`,
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
app.put("/api/students/:studentId/profile", async (req, res) => {
    try {
        if (!databaseReady) {
            return res.status(503).json({ message: "Database is not available." });
        }

        const studentId = Number(req.params.studentId);
        const { name, phone, department, semester } = req.body;
        if (!Number.isInteger(studentId) || studentId < 1 || !name || !phone || !department || !semester) {
            return res.status(400).json({ message: "All profile fields are required" });
        }

        await executeQuery(
            `UPDATE students
             SET name = ?, phone = ?, department = ?, semester = ?
             WHERE id = ?`,
            [String(name).trim(), String(phone).trim(), String(department).trim(), Number(semester), studentId]
        );
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
app.put("/api/students/:studentId/password", async (req, res) => {
    try {
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

        const rows = await selectRows("SELECT password FROM students WHERE id = ?", [studentId]);
        if (rows.length === 0) {
            return res.status(404).json({ message: "Student not found" });
        }
        if (!(await bcrypt.compare(String(currentPassword), rows[0].password))) {
            return res.status(401).json({ message: "Current password is incorrect" });
        }

        const hashedPassword = await bcrypt.hash(String(newPassword), 10);
        await executeQuery("UPDATE students SET password = ? WHERE id = ?", [hashedPassword, studentId]);
        res.json({ message: "Password changed successfully" });
    } catch (error) {
        console.error("Password Error:", error);
        res.status(500).json({ message: "Server error" });
    }
});

const PORT = process.env.PORT || 5000;

async function startServer() {
    await initializeDatabase();
    app.listen(PORT, "127.0.0.1", () => {
        console.log(`Server running on http://127.0.0.1:${PORT}`);
    });
}

if (require.main === module) {
    startServer();
}

module.exports = app;