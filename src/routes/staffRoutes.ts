import { Router } from "express"
import { requireAuth, requireRole } from "../controllers/middlewares"
import { staffController } from "../controllers/staffController"

const router = Router()

router.use(requireAuth, requireRole("STAFF"))

// Assignment
router.get("/me/assignment", staffController.myAssignment)

// Queue operations
router.post("/queue/call-next", staffController.callNext)
router.get("/queue/current-called", staffController.currentCalledForWindow)
router.post("/tickets/:id/served", staffController.markServed)
router.post("/tickets/:id/hold", staffController.holdNoShow)
router.post("/tickets/:id/return", staffController.returnFromHold)

export default router
