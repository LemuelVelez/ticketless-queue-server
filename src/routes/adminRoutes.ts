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

// Windows
router.get("/windows", adminController.listWindows)
router.post("/windows", adminController.createWindow)
router.put("/windows/:id", adminController.updateWindow)

// Staff
router.get("/staff", adminController.listStaff)
router.post("/staff", adminController.createStaff)
router.put("/staff/:id", adminController.updateStaff)

export default router
