import { Router } from "express"
import { authController } from "../controllers/authController"
import { requireAuth } from "../controllers/middlewares"

const router = Router()

router.post("/admin/login", authController.adminLogin)
router.post("/staff/login", authController.staffLogin)
router.get("/me", requireAuth, authController.me)

// ✅ Email existence check (for forgot password UX)
router.post("/email-exists", authController.emailExists)

// ✅ Password reset
router.post("/password/forgot", authController.forgotPassword)
router.post("/password/reset", authController.resetPassword)

export default router
