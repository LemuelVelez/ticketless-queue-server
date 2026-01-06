import { Router } from "express"
import { authController } from "../controllers/authController"
import { requireAuth } from "../controllers/middlewares"

const router = Router()

router.post("/admin/login", authController.adminLogin)
router.post("/staff/login", authController.staffLogin)
router.get("/me", requireAuth, authController.me)

export default router
