import { Router } from "express"
import { Types } from "mongoose"
import { requireAuth, requireRole } from "../controllers/middlewares"
import { adminController } from "../controllers/adminController"
import { DepartmentModel } from "../models/Department"
import { ServiceWindowModel } from "../models/ServiceWindow"

const router = Router()

router.use(requireAuth, requireRole("ADMIN"))

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
