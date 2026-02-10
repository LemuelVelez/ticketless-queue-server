import { Router } from "express"
import { Types } from "mongoose"
import { requireAuth, requireRole } from "../controllers/middlewares"
import { adminController } from "../controllers/adminController"
import { DepartmentModel } from "../models/Department"
import { ServiceWindowModel } from "../models/ServiceWindow"
import { UserModel } from "../models/User"
import { ParticipantModel } from "../services/participantAuth.service"

const router = Router()

router.use(requireAuth, requireRole("ADMIN"))

function cleanText(value: unknown) {
  return String(value ?? "").trim()
}

function normalizeParticipantRole(value: unknown): "STUDENT" | "ALUMNI_VISITOR" | "GUEST" {
  const r = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s/-]+/g, "_")

  if (r === "STUDENT") return "STUDENT"
  if (r === "ALUMNI_VISITOR" || r === "ALUMNI" || r === "VISITOR") return "ALUMNI_VISITOR"
  return "GUEST"
}

function buildParticipantName(p: any) {
  const full = [cleanText(p?.firstName), cleanText(p?.middleName), cleanText(p?.lastName)]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()

  return full || cleanText(p?.name) || "—"
}

function mapUserForAdminAccounts(u: any) {
  const assignedDepartments = Array.isArray(u?.assignedDepartments)
    ? (u.assignedDepartments as any[]).map((d) => String(d)).filter(Boolean)
    : []

  const assignedDepartment = u?.assignedDepartment ? String(u.assignedDepartment) : assignedDepartments[0] ?? null
  if (assignedDepartment && !assignedDepartments.includes(assignedDepartment)) {
    assignedDepartments.unshift(assignedDepartment)
  }

  return {
    id: String(u._id),
    _id: String(u._id),
    name: typeof u?.name === "string" ? u.name : "—",
    email: typeof u?.email === "string" ? u.email : "",
    role: u?.role,
    active: Boolean(u?.active),
    assignedTransactionManager: typeof u?.assignedTransactionManager === "string" ? u.assignedTransactionManager : null,
    assignedDepartment,
    assignedDepartments,
    assignedWindow: u?.assignedWindow ? String(u.assignedWindow) : null,
  }
}

function mapParticipantForAdminAccounts(p: any) {
  const mobile = cleanText(p?.mobileNumber)

  return {
    id: String(p._id),
    _id: String(p._id),
    name: buildParticipantName(p),
    email: mobile ? `Mobile: ${mobile}` : "—",
    role: normalizeParticipantRole(p?.type ?? p?.role),
    active: Boolean(p?.active),
    assignedTransactionManager: null,
    assignedDepartment: p?.department ? String(p.department) : null,
    assignedDepartments: p?.department ? [String(p.department)] : [],
    assignedWindow: null,
    // participant records are now editable from Admin Accounts
    readOnly: false,
  }
}

// Settings
router.get("/settings", adminController.getSettings)
router.put("/settings", adminController.updateSettings)

// Departments (CRUD)
router.get("/departments", adminController.listDepartments)
router.get("/departments/:id", async (req, res) => {
  const { id } = req.params
  if (!Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "id must be a valid ObjectId" })
  }

  const department = await DepartmentModel.findById(id)
  if (!department) {
    return res.status(404).json({ message: "Department not found" })
  }

  return res.json({ department })
})
router.post("/departments", adminController.createDepartment)
router.put("/departments/:id", adminController.updateDepartment)
router.delete("/departments/:id", adminController.deleteDepartment)

// Transaction purposes (department-aware, manager/category-aware)
router.get("/transaction-purposes", adminController.listTransactionPurposes)
router.post("/transaction-purposes", adminController.createTransactionPurpose)
router.put("/transaction-purposes/:id", adminController.updateTransactionPurpose)
router.delete("/transaction-purposes/:id", adminController.deleteTransactionPurpose)

// Windows (CRUD)
router.get("/windows", adminController.listWindows)
router.get("/windows/:id", async (req, res) => {
  const { id } = req.params
  if (!Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "id must be a valid ObjectId" })
  }

  const window = await ServiceWindowModel.findById(id)
  if (!window) {
    return res.status(404).json({ message: "Window not found" })
  }

  return res.json({ window })
})
router.post("/windows", adminController.createWindow)
router.put("/windows/:id", adminController.updateWindow)
router.delete("/windows/:id", adminController.deleteWindow)

// Staff / Accounts
router.get("/staff", async (_req, res) => {
  const [users, participants] = await Promise.all([
    UserModel.find({}).select("-passwordHash -passwordSalt -passwordIterations -passwordAlgo").lean(),
    ParticipantModel.find({}).select("-pinHash -pinSalt -pinIterations -pinAlgo").lean(),
  ])

  const fromUsers = (users as any[]).map((u) => mapUserForAdminAccounts(u))
  const fromParticipants = (participants as any[]).map((p) => mapParticipantForAdminAccounts(p))

  const staff = [...fromUsers, ...fromParticipants].sort((a, b) => {
    if (a.active === b.active) return String(a.name).localeCompare(String(b.name))
    return a.active ? -1 : 1
  })

  return res.json({ staff })
})

router.post("/staff", adminController.createStaff)
router.put("/staff/:id", adminController.updateStaff)

// ✅ delete account (used by accounts.tsx)
router.delete("/staff/:id", adminController.deleteStaff)

// ✅ Reports
router.get("/reports/summary", adminController.reportsSummary)
router.get("/reports/timeseries", adminController.reportsTimeseries)

// ✅ Audit logs
router.get("/audit-logs", adminController.listAuditLogs)

export default router
