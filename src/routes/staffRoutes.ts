import { Router } from "express"
import { requireAuth, requireRole } from "../controllers/middlewares"
import { staffController } from "../controllers/staffController"

const router = Router()

router.use(requireAuth, requireRole("STAFF"))

// Assignment
router.get("/me/assignment", staffController.myAssignment)

// ✅ Staff display snapshot (backend-integrated source for presenter/monitor UI)
router.get("/display/snapshot", staffController.displaySnapshot)

// Queue lists
router.get("/queue/waiting", staffController.listWaiting)
router.get("/queue/hold", staffController.listHold)
router.get("/queue/out", staffController.listOut)
router.get("/queue/history", staffController.listHistory)

// Queue operations
router.post("/queue/call-next", staffController.callNext)
router.get("/queue/current-called", staffController.currentCalledForWindow)
router.post("/tickets/:id/served", staffController.markServed)
router.post("/tickets/:id/hold", staffController.holdNoShow)
router.post("/tickets/:id/return", staffController.returnFromHold)

// ✅ Staff reports (scoped to assigned department)
router.get("/reports/summary", staffController.reportsSummary)
router.get("/reports/timeseries", staffController.reportsTimeseries)

export default router
