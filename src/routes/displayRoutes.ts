import { Router } from "express"
import { displayController } from "../controllers/displayController"

const router = Router()

// Public monitor endpoints
router.get("/monitor/snapshot", displayController.monitorSnapshot)
router.get("/monitor/text", displayController.monitorText)

// Voice announcement (supports query param or path param ticketId)
router.get("/voice-announcement", displayController.voiceAnnouncement)
router.get("/voice-announcement/:ticketId", displayController.voiceAnnouncement)

// Department display (keep dynamic route last)
router.get("/:departmentId", displayController.departmentDisplay)

export default router
