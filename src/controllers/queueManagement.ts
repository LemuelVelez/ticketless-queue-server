import type { Request, Response } from "express"
import type { AuthActor } from "../services/queueManagement"
import {
    callNextQueue,
    createTicket,
    getPublicDisplayState,
    getQueueSettings,
    getStaffQueueState,
    isHttpError,
    listDepartmentsByManager,
    listManagers,
    listWindowsByManager,
    outTicket,
    patchQueueSettings,
    serveTicket,
    holdTicket,
    toPublicError,
} from "../services/queueManagement"

type RequestWithUser = Request & { user?: AuthActor }

function ok(res: Response, data: unknown) {
    return res.status(200).json({ ok: true, data })
}

function created(res: Response, data: unknown) {
    return res.status(201).json({ ok: true, data })
}

function fail(res: Response, err: any) {
    const e = toPublicError(err)
    return res.status(e.status).json({ ok: false, error: { code: e.code, message: e.message, meta: e.meta } })
}

function requireStaff(req: RequestWithUser) {
    const role = req.user?.role
    if (role !== "ADMIN" && role !== "STAFF") {
        throw { status: 403, code: "FORBIDDEN", message: "Staff access required." }
    }
}

function requireAuthenticated(req: RequestWithUser) {
    if (!req.user) throw { status: 401, code: "UNAUTHORIZED", message: "Authentication required." }
}

export const QueueManagementController = {
    /**
     * SETTINGS
     */
    async getSettings(req: RequestWithUser, res: Response) {
        try {
            requireStaff(req)
            const settings = await getQueueSettings()
            return ok(res, settings)
        } catch (err) {
            return fail(res, err)
        }
    },

    async patchSettings(req: RequestWithUser, res: Response) {
        try {
            requireStaff(req)
            const patch = {
                maxHoldAttempts: req.body?.maxHoldAttempts,
                disallowDuplicateActiveTickets: req.body?.disallowDuplicateActiveTickets,
                upNextCount: req.body?.upNextCount,
            }
            const updated = await patchQueueSettings(req.user, patch)
            return ok(res, updated)
        } catch (err) {
            return fail(res, err)
        }
    },

    /**
     * PUBLIC DISPLAY HELPERS (Landing page manager filter)
     */
    async listManagers(req: Request, res: Response) {
        try {
            const managers = await listManagers()
            return ok(res, managers)
        } catch (err) {
            return fail(res, err)
        }
    },

    async listDepartmentsByManager(req: Request, res: Response) {
        try {
            const manager = String(req.query?.manager ?? "").trim()
            const deps = await listDepartmentsByManager(manager)
            return ok(res, deps)
        } catch (err) {
            return fail(res, err)
        }
    },

    async listWindowsByManager(req: Request, res: Response) {
        try {
            const manager = String(req.query?.manager ?? "").trim()
            const wins = await listWindowsByManager(manager)
            return ok(res, wins)
        } catch (err) {
            return fail(res, err)
        }
    },

    /**
     * PUBLIC DISPLAY STATE (poll every 2–3 seconds)
     * Query:
     *  - manager: string (required)
     *  - since: ISO timestamp (optional, for announcements)
     */
    async getPublicDisplayState(req: Request, res: Response) {
        try {
            const manager = String(req.query?.manager ?? "").trim()
            const since = req.query?.since ? String(req.query.since) : undefined
            const state = await getPublicDisplayState(manager, since)
            return ok(res, state)
        } catch (err) {
            return fail(res, err)
        }
    },

    /**
     * STAFF DASHBOARD STATE (poll every 2–3 seconds)
     * Query supports:
     *  - windowId OR departmentId OR manager
     *  - dateKey (optional)
     */
    async getStaffQueueState(req: RequestWithUser, res: Response) {
        try {
            requireStaff(req)
            const query = {
                dateKey: req.query?.dateKey ? String(req.query.dateKey) : undefined,
                manager: req.query?.manager ? String(req.query.manager) : undefined,
                departmentId: req.query?.departmentId ? String(req.query.departmentId) : undefined,
                windowId: req.query?.windowId ? String(req.query.windowId) : undefined,
            }
            const state = await getStaffQueueState(req.user, query)
            return ok(res, state)
        } catch (err) {
            return fail(res, err)
        }
    },

    /**
     * PARTICIPANT: Create ticket
     * Body:
     *  - departmentId (optional if participant profile already locked)
     *  - studentId (optional if logged in with tcNumber/studentId)
     *  - phone, participantType
     *  - transactionCategory, transactionKey, transactionLabel, purpose
     */
    async createTicket(req: RequestWithUser, res: Response) {
        try {
            // allow both logged-in participants and kiosks (if your system supports it)
            // if you want strict auth, uncomment:
            // requireAuthenticated(req)

            const ticket = await createTicket(req.user, {
                departmentId: req.body?.departmentId,
                studentId: req.body?.studentId,
                phone: req.body?.phone,
                participantType: req.body?.participantType,
                transactionCategory: req.body?.transactionCategory,
                transactionKey: req.body?.transactionKey,
                transactionLabel: req.body?.transactionLabel,
                purpose: req.body?.purpose,
            })
            return created(res, ticket)
        } catch (err) {
            return fail(res, err)
        }
    },

    /**
     * STAFF: Next Queue (centralized, race-safe)
     * Body: { windowId: string }
     */
    async callNext(req: RequestWithUser, res: Response) {
        try {
            requireStaff(req)
            const windowId = String(req.body?.windowId ?? "").trim()
            if (!windowId) return fail(res, { status: 400, code: "MISSING_WINDOW", message: "windowId is required." })

            const ticket = await callNextQueue(req.user, windowId)
            return ok(res, ticket) // ticket can be null if no WAITING
        } catch (err) {
            return fail(res, err)
        }
    },

    /**
     * STAFF: Hold ticket
     * Body: { ticketId: string }
     */
    async hold(req: RequestWithUser, res: Response) {
        try {
            requireStaff(req)
            const ticketId = String(req.body?.ticketId ?? "").trim()
            if (!ticketId) return fail(res, { status: 400, code: "MISSING_TICKET", message: "ticketId is required." })

            const ticket = await holdTicket(req.user, ticketId)
            return ok(res, ticket)
        } catch (err) {
            return fail(res, err)
        }
    },

    /**
     * STAFF: Serve ticket
     * Body: { ticketId: string }
     */
    async serve(req: RequestWithUser, res: Response) {
        try {
            requireStaff(req)
            const ticketId = String(req.body?.ticketId ?? "").trim()
            if (!ticketId) return fail(res, { status: 400, code: "MISSING_TICKET", message: "ticketId is required." })

            const ticket = await serveTicket(req.user, ticketId)
            return ok(res, ticket)
        } catch (err) {
            return fail(res, err)
        }
    },

    /**
     * STAFF: Out ticket
     * Body: { ticketId: string, reason?: string }
     */
    async out(req: RequestWithUser, res: Response) {
        try {
            requireStaff(req)
            const ticketId = String(req.body?.ticketId ?? "").trim()
            if (!ticketId) return fail(res, { status: 400, code: "MISSING_TICKET", message: "ticketId is required." })

            const ticket = await outTicket(req.user, ticketId, req.body?.reason)
            return ok(res, ticket)
        } catch (err) {
            return fail(res, err)
        }
    },
}