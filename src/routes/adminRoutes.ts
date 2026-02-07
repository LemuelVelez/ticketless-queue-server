import { Router } from "express"
import { requireAuth, requireRole } from "../controllers/middlewares"
import { adminController } from "../controllers/adminController"

const router = Router()

router.use(requireAuth, requireRole("ADMIN"))

// Settings
router.get("/settings", adminController.getSettings)
router.put("/settings", adminController.updateSettings)

// Departments
router.get("/departments", adminController.listDepartments)
router.post("/departments", adminController.createDepartment)
router.put("/departments/:id", adminController.updateDepartment)

// Transaction purposes (department-aware, manager/category-aware)
router.get("/transaction-purposes", adminController.listTransactionPurposes)
router.post("/transaction-purposes", adminController.createTransactionPurpose)
router.put("/transaction-purposes/:id", adminController.updateTransactionPurpose)
router.delete("/transaction-purposes/:id", adminController.deleteTransactionPurpose)

// Windows
router.get("/windows", adminController.listWindows)
router.post("/windows", adminController.createWindow)
router.put("/windows/:id", adminController.updateWindow)

// Staff / Accounts
router.get("/staff", adminController.listStaff)
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
