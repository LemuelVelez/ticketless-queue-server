import { Router } from "express"
import authRoutes from "./authRoutes"
import adminRoutes from "./adminRoutes"
import staffRoutes from "./staffRoutes"
import publicRoutes from "./publicRoutes"
import displayRoutes from "./displayRoutes"

const router = Router()

router.use("/auth", authRoutes)
router.use("/admin", adminRoutes)
router.use("/staff", staffRoutes)
router.use("/public", publicRoutes)
router.use("/display", displayRoutes)

export default router
