import { Router } from "express"
import { displayController } from "../controllers/displayController"

const router = Router()

router.get("/:departmentId", displayController.departmentDisplay)

export default router
