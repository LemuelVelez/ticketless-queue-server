import { Router } from "express"
import { publicController } from "../controllers/publicController"
import { homeController } from "../controllers/HomeController"
import { requireParticipantAuth } from "../controllers/middlewares"

const router = Router()

// Departments
router.get("/departments", publicController.listDepartments)

// Home overview charts
router.get("/home/overview", homeController.overview)

// Participant auth/session
router.post("/auth/signup/student", publicController.signupStudent)
router.post("/auth/signup/alumni-visitor", publicController.signupAlumniVisitor)
router.post("/auth/signup/guest", publicController.signupAlumniVisitor) // alias

router.post("/auth/login/student", publicController.loginStudent)
router.post("/auth/login/alumni-visitor", publicController.loginAlumniVisitor)
router.post("/auth/login/guest", publicController.loginAlumniVisitor) // alias

router.get("/auth/session", publicController.participantSession)
router.post("/auth/session", publicController.participantSession)

// ✅ IMPORTANT: allow profile updates via the existing /auth/session route
// This fixes cases where /auth/me or /auth/profile are not mounted in some environments.
router.options("/auth/session", (_req, res) => res.sendStatus(204))
router.patch("/auth/session", publicController.updateParticipantProfile)
router.put("/auth/session", publicController.updateParticipantProfile)

/**
 * ✅ Participant "me/profile" endpoints
 * Some frontends call:
 * - /api/public/auth/me
 * - /api/public/auth/profile
 *
 * Depending on how this router is mounted (/, /api, /api/public),
 * we register safe aliases for GET + PATCH (and PUT/POST fallback),
 * and also respond to OPTIONS for CORS preflight.
 */
const participantProfilePaths = [
    // If router is mounted at /api/public
    "/auth/me",
    "/auth/profile",

    // If router is mounted at /api
    "/public/auth/me",
    "/public/auth/profile",

    // If router is mounted at /
    "/api/public/auth/me",
    "/api/public/auth/profile",
] as const

for (const p of participantProfilePaths) {
    // CORS preflight friendliness (especially for PATCH)
    router.options(p, (_req, res) => res.sendStatus(204))

    // Many apps use GET /auth/me to fetch session/profile
    router.get(p, publicController.participantSession)

    // Profile update
    router.patch(p, publicController.updateParticipantProfile)

    // Fallbacks (some proxies/environments strip/avoid PATCH)
    router.put(p, publicController.updateParticipantProfile)
    router.post(p, publicController.updateParticipantProfile)
}

router.post("/auth/logout", publicController.logoutParticipant)

// Queue
// join/find/getTicket are intentionally open for legacy public kiosk flow;
// controller still supports session-token flow when Authorization/sessionToken is provided.
router.post("/tickets/join", publicController.joinQueue)
router.get("/tickets", publicController.findActiveByStudent)
router.get("/tickets/:id", publicController.getTicket)

// Display-monitor actions remain participant-protected.
router.post("/tickets/present", requireParticipantAuth, publicController.presentToDisplayMonitor)
router.post("/tickets/present-to-display-monitor", requireParticipantAuth, publicController.presentToDisplayMonitor)

export default router