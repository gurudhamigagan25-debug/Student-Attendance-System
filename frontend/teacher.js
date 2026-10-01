const API_URL = "/api";

function readCookie(name) {
    const value = document.cookie.split("; ").find((entry) => entry.startsWith(`${name}=`));
    return value ? decodeURIComponent(value.slice(name.length + 1)) : "";
}

async function parseResponse(response) {
    const data = await response.json().catch(() => ({ message: "The server returned an invalid response" }));
    if (!response.ok) throw new Error(data.message || "Request failed");
    return data;
}

async function teacherFetch(url, options = {}, allowRefresh = true) {
    const headers = { ...(options.headers || {}) };
    if (!["GET", "HEAD", "OPTIONS"].includes(String(options.method || "GET").toUpperCase())) {
        const csrfToken = readCookie("csrf_token");
        if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
    }
    const response = await fetch(`${API_URL}${url}`, {
        ...options,
        credentials: "same-origin",
        headers
    });
    if (response.status === 401 && allowRefresh && readCookie("csrf_token")) {
        const csrfToken = readCookie("csrf_token");
        const refreshed = await fetch(`${API_URL}/auth/refresh`, {
            method: "POST",
            credentials: "same-origin",
            headers: csrfToken ? { "X-CSRF-Token": csrfToken } : {}
        });
        if (refreshed.ok) return teacherFetch(url, options, false);
    }
    return parseResponse(response);
}

function localDateString(date = new Date()) {
    const offset = date.getTimezoneOffset() * 60000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

const teacherLoginForm = document.getElementById("teacherLoginForm");
if (teacherLoginForm) {
    teacherLoginForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = document.getElementById("teacherLoginMessage");
        message.textContent = "";
        message.className = "form-message";
        try {
            const result = await teacherFetch("/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email: document.getElementById("teacherEmail").value.trim(),
                    password: document.getElementById("teacherPassword").value
                })
            }, false);
            if (result.user.role !== "teacher") {
                await teacherFetch("/auth/logout", { method: "POST" }, false);
                throw new Error("This account is not a teacher account");
            }
            localStorage.removeItem("student");
            localStorage.removeItem("studentToken");
            localStorage.removeItem("adminToken");
            localStorage.removeItem("adminEmail");
            localStorage.setItem("teacher", JSON.stringify(result.user));
            window.location.href = "teacher.html";
        } catch (error) {
            message.textContent = error.message;
            message.className = "form-message error-message";
        }
    });
}

const teacherDashboard = document.querySelector(".teacher-shell");
if (teacherDashboard) {
    let teacher;
    try {
        teacher = JSON.parse(localStorage.getItem("teacher") || "null");
    } catch (error) {
        localStorage.removeItem("teacher");
    }
    if (!teacher || teacher.role !== "teacher") {
        window.location.href = "teacher-login.html";
    } else {
        const classPicker = document.getElementById("teacherClassSelect");
        const datePicker = document.getElementById("teacherDate");
        const rosterTable = document.getElementById("teacherRosterTable");
        const studentPicker = document.getElementById("teacherStudentSelect");
        const historyTable = document.getElementById("teacherHistoryTable");
        const errorMessage = document.getElementById("teacherError");
        const statusMessage = document.getElementById("teacherMessage");
        let roster = [];

        document.getElementById("teacherWelcome").textContent = `Welcome, ${teacher.name}`;
        document.getElementById("teacherAvatar").textContent = String(teacher.name || "T").charAt(0).toUpperCase();
        datePicker.value = localDateString();
        const now = new Date();
        document.getElementById("teacherTime").value = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

        async function loadClassData() {
            const classId = classPicker.value;
            if (!classId) {
                roster = [];
                document.getElementById("teacherRosterCount").textContent = "0";
                document.getElementById("teacherMarkedCount").textContent = "0";
                rosterTable.innerHTML = '<tr><td colspan="5" class="empty-state">Choose a class to load its roster.</td></tr>';
                historyTable.innerHTML = '<tr><td colspan="3" class="empty-state">Choose a class to load records.</td></tr>';
                studentPicker.innerHTML = '<option value="">Choose an enrolled student</option>';
                return;
            }
            errorMessage.textContent = "";
            const date = encodeURIComponent(datePicker.value);
            try {
                const [rosterData, attendanceData] = await Promise.all([
                    teacherFetch(`/classes/${encodeURIComponent(classId)}/enrollments`),
                    teacherFetch(`/attendance?class_id=${encodeURIComponent(classId)}&date=${date}`)
                ]);
                roster = rosterData.students;
                document.getElementById("teacherRosterCount").textContent = roster.length;
                document.getElementById("teacherRosterBadge").textContent = `${roster.length} student${roster.length === 1 ? "" : "s"}`;
                document.getElementById("teacherMarkedCount").textContent = attendanceData.total;
                const recordsByStudent = new Map(attendanceData.records.map((record) => [Number(record.student_id), record]));
                rosterTable.innerHTML = roster.length
                    ? roster.map((student) => {
                        const record = recordsByStudent.get(Number(student.id));
                        const state = record ? `<span class="status ${record.status.toLowerCase()}">${record.status}</span>` : "Not marked";
                        return `<tr><td>${escapeHtml(student.student_id)}</td><td>${escapeHtml(student.name)}</td><td>${escapeHtml(student.department)}</td><td>${escapeHtml(student.semester)}</td><td>${state}</td></tr>`;
                    }).join("")
                    : '<tr><td colspan="5" class="empty-state">No students are enrolled in this class.</td></tr>';
                studentPicker.innerHTML = '<option value="">Choose an enrolled student</option>' + roster.map((student) =>
                    `<option value="${escapeHtml(student.id)}">${escapeHtml(student.student_id)} - ${escapeHtml(student.name)}</option>`
                ).join("");
                historyTable.innerHTML = attendanceData.records.length
                    ? attendanceData.records.map((record) => `<tr><td>${escapeHtml(record.name)}</td><td>${escapeHtml(String(record.attendance_time || "").slice(0, 5) || "--:--")}</td><td><span class="status ${record.status.toLowerCase()}">${escapeHtml(record.status)}</span></td></tr>`).join("")
                    : '<tr><td colspan="3" class="empty-state">No attendance recorded for this date.</td></tr>';
            } catch (error) {
                errorMessage.textContent = error.message;
                if (error.message.includes("Session")) {
                    localStorage.removeItem("teacher");
                    window.location.href = "teacher-login.html";
                }
            }
        }

        function escapeHtml(value) {
            return String(value == null ? "" : value)
                .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
        }

        document.getElementById("teacherClassCount").textContent = "0";
        classPicker.addEventListener("change", () => {
            statusMessage.textContent = "";
            loadClassData();
        });
        datePicker.addEventListener("change", () => {
            statusMessage.textContent = "";
            loadClassData();
        });
        document.getElementById("teacherAttendanceForm").addEventListener("submit", async (event) => {
            event.preventDefault();
            if (!classPicker.value || !studentPicker.value) {
                statusMessage.textContent = "Choose a class and an enrolled student.";
                statusMessage.className = "form-message error-message";
                return;
            }
            try {
                const result = await teacherFetch("/attendance", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        student_id: studentPicker.value,
                        class_id: classPicker.value,
                        date: datePicker.value,
                        status: document.getElementById("teacherStatus").value,
                        time: document.getElementById("teacherTime").value,
                        period: document.getElementById("teacherPeriod").value.trim(),
                        notes: document.getElementById("teacherNotes").value.trim()
                    })
                });
                statusMessage.textContent = result.message;
                statusMessage.className = "form-message success-message";
                document.getElementById("teacherNotes").value = "";
                await loadClassData();
            } catch (error) {
                statusMessage.textContent = error.message;
                statusMessage.className = "form-message error-message";
            }
        });
        document.getElementById("teacherLogoutButton").addEventListener("click", async () => {
            try {
                await teacherFetch("/auth/logout", { method: "POST" });
            } catch (error) {
                errorMessage.textContent = error.message;
            }
            localStorage.removeItem("teacher");
            window.location.href = "teacher-login.html";
        });
        document.getElementById("teacherPasswordForm").addEventListener("submit", async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const message = document.getElementById("teacherPasswordMessage");
            const newPassword = document.getElementById("teacherNewPassword").value;
            if (newPassword !== document.getElementById("teacherConfirmPassword").value) {
                message.textContent = "New passwords do not match.";
                message.className = "form-message error-message";
                return;
            }
            try {
                const result = await teacherFetch("/auth/password", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ currentPassword: document.getElementById("teacherCurrentPassword").value, newPassword })
                });
                message.textContent = result.message;
                message.className = "form-message success-message";
                form.reset();
            } catch (error) {
                message.textContent = error.message;
                message.className = "form-message error-message";
            }
        });

        teacherFetch("/classes").then((result) => {
            classPicker.innerHTML = '<option value="">Choose an assigned class</option>' + result.classes.map((item) =>
                `<option value="${escapeHtml(item.id)}">${escapeHtml(item.class_name)} - ${escapeHtml(item.subject)}</option>`
            ).join("");
            document.getElementById("teacherClassCount").textContent = result.classes.length;
            if (result.classes.length) {
                classPicker.value = String(result.classes[0].id);
                loadClassData();
            }
        }).catch((error) => {
            errorMessage.textContent = error.message;
            if (error.message.includes("Authentication") || error.message.includes("Session")) {
                localStorage.removeItem("teacher");
                window.location.href = "teacher-login.html";
            }
        });
    }
}
