import express, { Router } from "express"
import { authController } from "../controllers/authController"
import { requireAuth } from "../controllers/middlewares"

const router = Router()

router.post("/admin/login", authController.adminLogin)
router.post("/staff/login", authController.staffLogin)

router.get("/me", requireAuth, authController.me)

// ✅ Update current user (name/email/password/avatar)
router.patch("/me", requireAuth, authController.updateMe)

// ✅ Avatar upload via backend proxy (fixes S3 CORS issues)
router.put(
    "/me/avatar",
    requireAuth,
    express.raw({ type: ["image/*"], limit: "6mb" }),
    authController.uploadAvatar
)

// ✅ Avatar helpers (S3 presign upload + signed display url)
router.post("/me/avatar/presign", requireAuth, authController.presignAvatarUpload)
router.get("/me/avatar/url", requireAuth, authController.getMyAvatarUrl)

// ✅ Email existence check
router.post("/email-exists", authController.emailExists)

// ✅ Password reset
router.post("/password/forgot", authController.forgotPassword)
router.post("/password/reset", authController.resetPassword)

export default router
