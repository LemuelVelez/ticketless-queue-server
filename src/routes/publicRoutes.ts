import { Router } from "express"
import { publicController } from "../controllers/publicController"

const router = Router()

router.get("/departments", publicController.listDepartments)
router.post("/tickets/join", publicController.joinQueue)
router.get("/tickets/:id", publicController.getTicket)

// optional helper
router.get("/tickets", publicController.findActiveByStudent)

export default router
