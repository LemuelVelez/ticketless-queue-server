import { Router } from "express"
import { publicController } from "../controllers/publicController"
import { homeController } from "../controllers/HomeController"
import { requireParticipantAuth } from "../controllers/middlewares"

const router = Router()

/**
 * ✅ Route aliasing helper
 * Your frontend calls URLs like:
 *   /api/public/auth/session
 *   /api/public/auth/me
 *   /api/public/auth/profile
 *
 * But depending on how this router is mounted, the real Express path can vary:
 * - mounted at "/api/public"  => router paths should be "/auth/*"
 * - mounted at "/api"         => router paths should be "/public/auth/*"
 * - mounted at "/"            => router paths should be "/api/public/auth/*"
 *
 * To prevent 404s across environments, we register aliases for all three.
 */
const BASE_PREFIXES = ["", "/public", "/api/public"] as const

function normalizeSlashes(path: string) {
    return path.replace(/\/{2,}/g, "/")
}

function aliasPaths(path: string): string[] {
    const clean = path.startsWith("/") ? path : `/${path}`
    const set = new Set<string>()
    for (const base of BASE_PREFIXES) {
        set.add(normalizeSlashes(`${base}${clean}`))
    }
    return Array.from(set)
}

function on(method: "get" | "post" | "put" | "patch" | "options", path: string, ...handlers: any[]) {
    for (const p of aliasPaths(path)) {
        ;(router as any)[method](p, ...handlers)
    }
}

/**
 * ✅ OPTIONS handler to stop CORS preflight failures on public endpoints.
 * Especially important for:
 * - POST /tickets/join (application/json triggers preflight)
 * - Any request sending Authorization or X-Session-Token
 */
const okOptions = (_req: any, res: any) => res.sendStatus(204)

/**
 * 🔒 Department is locked to the participant record.
 * We explicitly strip any attempted override for the "session read" endpoints.
 * (Profile updates still accept departmentId only for first-time save; controller enforces locking after that.)
 */
function stripDepartmentOverride(req: any, _res: any, next: any) {
    try {
        if (req?.query && typeof req.query === "object") {
            delete req.query.departmentId
            delete req.query.department
        }
        if (req?.body && typeof req.body === "object") {
            // session read (POST) sometimes includes departmentId—ignore it
            delete req.body.departmentId
            delete req.body.department
        }
    } catch {
        // ignore
    }
    next()
}

// --------------------
// Departments
// --------------------
on("options", "/departments", okOptions)
on("get", "/departments", publicController.listDepartments)

// --------------------
// Home overview charts
// --------------------
on("options", "/home/overview", okOptions)
on("get", "/home/overview", homeController.overview)

// --------------------
// Participant auth/session
// --------------------
on("post", "/auth/signup/student", publicController.signupStudent)
on("post", "/auth/signup/alumni-visitor", publicController.signupAlumniVisitor)

// ✅ Guest now has a dedicated controller method (forces type/role = GUEST when supported)
on("post", "/auth/signup/guest", publicController.signupGuest)

on("post", "/auth/login/student", publicController.loginStudent)
on("post", "/auth/login/alumni-visitor", publicController.loginAlumniVisitor)

// ✅ Guest login route
on("post", "/auth/login/guest", publicController.loginGuest)

// ✅ Session endpoint (GET/POST + PATCH/PUT for profile updates)
on("options", "/auth/session", okOptions)
on("get", "/auth/session", stripDepartmentOverride, publicController.participantSession)
on("post", "/auth/session", stripDepartmentOverride, publicController.participantSession)
on("patch", "/auth/session", publicController.updateParticipantProfile)
on("put", "/auth/session", publicController.updateParticipantProfile)

// ✅ "me/profile" aliases (some frontends call these)
for (const p of ["/auth/me", "/auth/profile"] as const) {
    on("options", p, okOptions)
    on("get", p, stripDepartmentOverride, publicController.participantSession)
    on("patch", p, publicController.updateParticipantProfile)
    on("put", p, publicController.updateParticipantProfile)
    // fallback: some proxies/environments strip/avoid PATCH
    on("post", p, publicController.updateParticipantProfile)
}

on("options", "/auth/logout", okOptions)
on("post", "/auth/logout", publicController.logoutParticipant)

// --------------------
// Queue (public kiosk + participant-session supported by controller)
// --------------------
on("options", "/tickets/join", okOptions)
on("post", "/tickets/join", publicController.joinQueue)

on("options", "/tickets", okOptions)
on("get", "/tickets", publicController.findActiveByStudent)

on("options", "/tickets/:id", okOptions)
on("get", "/tickets/:id", publicController.getTicket)

// ✅ Dedicated details alias (same handler, but clearer intent for frontend)
on("options", "/tickets/:id/details", okOptions)
on("get", "/tickets/:id/details", publicController.getTicket)

// --------------------
// Display-monitor actions remain participant-protected
// --------------------
on("options", "/tickets/present", okOptions)
on("post", "/tickets/present", requireParticipantAuth, publicController.presentToDisplayMonitor)

on("options", "/tickets/present-to-display-monitor", okOptions)
on("post", "/tickets/present-to-display-monitor", requireParticipantAuth, publicController.presentToDisplayMonitor)

export default router