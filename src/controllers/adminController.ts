import type { Request, Response } from "express"
import { Types } from "mongoose"

import { DepartmentModel } from "../models/Department"
import { ServiceWindowModel } from "../models/ServiceWindow"
import { SettingModel } from "../models/Setting"
import { UserModel, type UserRole } from "../models/User"
import { AuditLogModel } from "../models/AuditLog"
import { TicketModel, type TicketStatus } from "../models/Ticket"
import { hashPassword } from "./security"

function actor(req: Request) {
    const u = (req as any).user
    return { actor: u?.id, actorRole: u?.role }
}

function normalizeEmail(email: unknown) {
    return String(email ?? "").toLowerCase().trim()
}

function isRole(value: unknown): value is UserRole {
    return value === "ADMIN" || value === "STAFF"
}

/**
 * Turns "null"/"undefined"/"" into null, otherwise trims to string.
 */
function cleanId(v: unknown): string | null {
    if (v === null || v === undefined) return null
    const s = String(v).trim()
    if (!s || s === "null" || s === "undefined") return null
    return s
}

/**
 * Parse an incoming id (string/null/undefined) to ObjectId or undefined (meaning "unset").
 * Returns { error } when invalid.
 */
function parseObjectId(v: unknown, fieldName: string): { value?: Types.ObjectId; error?: string } {
    const s = cleanId(v)
    if (!s) return { value: undefined }
    if (!Types.ObjectId.isValid(s)) return { error: `${fieldName} must be a valid ObjectId` }
    return { value: new Types.ObjectId(s) }
}

/** =================
 * REPORTS HELPERS
 * ================= */

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/ // YYYY-MM-DD

function isDateKey(v: unknown): v is string {
    return typeof v === "string" && DATE_KEY_RE.test(v)
}

function todayDateKeyUTC(): string {
    // Using UTC keeps formatting stable regardless of server locale.
    return new Date().toISOString().slice(0, 10)
}

function normalizeDateRange(fromRaw: unknown, toRaw: unknown): { from: string; to: string } {
    const from = isDateKey(fromRaw) ? fromRaw : undefined
    const to = isDateKey(toRaw) ? toRaw : undefined

    if (from && to) {
        return from <= to ? { from, to } : { from: to, to: from }
    }

    if (from && !to) return { from, to: from }
    if (!from && to) return { from: to, to }
    const today = todayDateKeyUTC()
    return { from: today, to: today }
}

function parseDateBoundary(v: unknown, mode: "start" | "end"): Date | null {
    if (typeof v !== "string" || !v.trim()) return null
    const s = v.trim()

    // Accept YYYY-MM-DD as whole-day range in UTC
    if (isDateKey(s)) {
        if (mode === "start") return new Date(`${s}T00:00:00.000Z`)
        return new Date(`${s}T23:59:59.999Z`)
    }

    // Otherwise try Date parse (ISO etc)
    const d = new Date(s)
    if (Number.isNaN(d.getTime())) return null
    return d
}

function toInt(v: unknown, fallback: number) {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
}

export const adminController = {
    // SETTINGS
    getSettings: async (_req: Request, res: Response) => {
        const settings = await SettingModel.findOne({})
        return res.json({ settings })
    },

    updateSettings: async (req: Request, res: Response) => {
        const { maxHoldAttempts, disallowDuplicateActiveTickets, upNextCount } = req.body || {}

        const settings = await SettingModel.findOne({})
        if (!settings) return res.status(500).json({ message: "Settings not initialized" })

        if (maxHoldAttempts !== undefined) settings.maxHoldAttempts = Number(maxHoldAttempts)
        if (disallowDuplicateActiveTickets !== undefined)
            settings.disallowDuplicateActiveTickets = Boolean(disallowDuplicateActiveTickets)
        if (upNextCount !== undefined) settings.upNextCount = Number(upNextCount)

        await settings.save()

        await AuditLogModel.create({
            ...actor(req),
            action: "ADMIN_UPDATE_SETTINGS",
            entityType: "Setting",
            entityId: settings._id as any,
            meta: { maxHoldAttempts, disallowDuplicateActiveTickets, upNextCount },
        })

        return res.json({ settings })
    },

    // DEPARTMENTS
    listDepartments: async (_req: Request, res: Response) => {
        const departments = await DepartmentModel.find({}).sort({ name: 1 })
        return res.json({ departments })
    },

    createDepartment: async (req: Request, res: Response) => {
        const { name, code } = req.body || {}
        if (!name) return res.status(400).json({ message: "name is required" })

        const department = await DepartmentModel.create({
            name: String(name).trim(),
            code: code ? String(code).trim() : undefined,
        })

        await AuditLogModel.create({
            ...actor(req),
            action: "ADMIN_CREATE_DEPARTMENT",
            entityType: "Department",
            entityId: department._id as any,
        })

        return res.status(201).json({ department })
    },

    updateDepartment: async (req: Request, res: Response) => {
        const { id } = req.params
        const { name, code, enabled } = req.body || {}

        const department = await DepartmentModel.findById(id)
        if (!department) return res.status(404).json({ message: "Department not found" })

        if (name !== undefined) department.name = String(name).trim()
        if (code !== undefined) department.code = code ? String(code).trim() : undefined
        if (enabled !== undefined) department.enabled = Boolean(enabled)

        await department.save()

        await AuditLogModel.create({
            ...actor(req),
            action: "ADMIN_UPDATE_DEPARTMENT",
            entityType: "Department",
            entityId: department._id as any,
            meta: { name, code, enabled },
        })

        return res.json({ department })
    },

    // WINDOWS
    listWindows: async (req: Request, res: Response) => {
        const { departmentId } = req.query

        const filter: any = {}
        if (departmentId) {
            const parsed = parseObjectId(departmentId, "departmentId")
            if (parsed.error) return res.status(400).json({ message: parsed.error })
            if (parsed.value) filter.department = parsed.value
        }

        const windows = await ServiceWindowModel.find(filter).sort({ department: 1, number: 1 })
        return res.json({ windows })
    },

    createWindow: async (req: Request, res: Response) => {
        const { departmentId, name, number } = req.body || {}
        if (!departmentId || !name || number === undefined) {
            return res.status(400).json({ message: "departmentId, name, number are required" })
        }

        const deptParsed = parseObjectId(departmentId, "departmentId")
        if (deptParsed.error) return res.status(400).json({ message: deptParsed.error })
        if (!deptParsed.value) return res.status(400).json({ message: "departmentId is required" })

        const win = await ServiceWindowModel.create({
            department: deptParsed.value,
            name: String(name).trim(),
            number: Number(number),
        })

        await AuditLogModel.create({
            ...actor(req),
            action: "ADMIN_CREATE_WINDOW",
            entityType: "ServiceWindow",
            entityId: win._id as any,
        })

        return res.status(201).json({ window: win })
    },

    updateWindow: async (req: Request, res: Response) => {
        const { id } = req.params
        const { name, number, enabled } = req.body || {}

        const win = await ServiceWindowModel.findById(id)
        if (!win) return res.status(404).json({ message: "Window not found" })

        if (name !== undefined) win.name = String(name).trim()
        if (number !== undefined) win.number = Number(number)
        if (enabled !== undefined) win.enabled = Boolean(enabled)

        await win.save()

        await AuditLogModel.create({
            ...actor(req),
            action: "ADMIN_UPDATE_WINDOW",
            entityType: "ServiceWindow",
            entityId: win._id as any,
            meta: { name, number, enabled },
        })

        return res.json({ window: win })
    },

    // ACCOUNTS (kept names listStaff/createStaff/updateStaff for frontend compatibility)
    listStaff: async (_req: Request, res: Response) => {
        const staff = await UserModel.find({})
            .select("-passwordHash -passwordSalt -passwordIterations -passwordAlgo")
            .sort({ createdAt: -1 })

        return res.json({ staff })
    },

    createStaff: async (req: Request, res: Response) => {
        const { name, email, password } = req.body || {}
        const roleRaw = (req.body || {}).role
        const role: UserRole = isRole(roleRaw) ? roleRaw : "STAFF"

        const departmentIdRaw = (req.body || {}).departmentId
        const windowIdRaw = (req.body || {}).windowId

        if (!name || !email || !password) {
            return res.status(400).json({ message: "name, email, password are required" })
        }

        if (role === "STAFF") {
            if (!cleanId(departmentIdRaw) || !cleanId(windowIdRaw)) {
                return res.status(400).json({ message: "departmentId and windowId are required for STAFF" })
            }
        }

        const deptParsed = parseObjectId(departmentIdRaw, "departmentId")
        if (deptParsed.error) return res.status(400).json({ message: deptParsed.error })

        const winParsed = parseObjectId(windowIdRaw, "windowId")
        if (winParsed.error) return res.status(400).json({ message: winParsed.error })

        if (winParsed.value && !deptParsed.value) {
            return res.status(400).json({ message: "departmentId is required when windowId is provided" })
        }

        const normalizedEmail = normalizeEmail(email)
        const existing = await UserModel.findOne({ email: normalizedEmail })
        if (existing) return res.status(409).json({ message: "Email already exists" })

        const { salt, hash, algo, iterations } = await hashPassword(String(password))

        const user = await UserModel.create({
            name: String(name).trim(),
            email: normalizedEmail,
            role,
            active: true,

            passwordSalt: salt,
            passwordHash: hash,
            passwordAlgo: algo,
            passwordIterations: iterations,

            assignedDepartment: role === "STAFF" ? deptParsed.value : undefined,
            assignedWindow: role === "STAFF" ? winParsed.value : undefined,
        })

        await AuditLogModel.create({
            ...actor(req),
            action: "ADMIN_CREATE_USER",
            entityType: "User",
            entityId: user._id as any,
            meta: { role },
        })

        return res.status(201).json({
            staff: {
                id: String(user._id),
                name: user.name,
                email: user.email,
                role: user.role,
                active: user.active,
                assignedDepartment: user.assignedDepartment ? String(user.assignedDepartment) : null,
                assignedWindow: user.assignedWindow ? String(user.assignedWindow) : null,
            },
        })
    },

    updateStaff: async (req: Request, res: Response) => {
        const { id } = req.params
        const { name, active, password } = req.body || {}

        const roleRaw = (req.body || {}).role
        const nextRole: UserRole | undefined = isRole(roleRaw) ? roleRaw : undefined

        const departmentIdRaw = (req.body || {}).departmentId
        const windowIdRaw = (req.body || {}).windowId

        const user = await UserModel.findById(id)
        if (!user) return res.status(404).json({ message: "User not found" })

        if (name !== undefined) user.name = String(name).trim()
        if (active !== undefined) user.active = Boolean(active)

        if (nextRole) {
            user.role = nextRole
            if (nextRole === "ADMIN") {
                user.assignedDepartment = undefined
                user.assignedWindow = undefined
            }
        }

        if (user.role === "STAFF") {
            if (departmentIdRaw !== undefined) {
                const deptParsed = parseObjectId(departmentIdRaw, "departmentId")
                if (deptParsed.error) return res.status(400).json({ message: deptParsed.error })
                user.assignedDepartment = deptParsed.value
            }

            if (windowIdRaw !== undefined) {
                const winParsed = parseObjectId(windowIdRaw, "windowId")
                if (winParsed.error) return res.status(400).json({ message: winParsed.error })
                user.assignedWindow = winParsed.value
            }

            if (user.assignedWindow && !user.assignedDepartment) {
                return res.status(400).json({ message: "assignedDepartment is required when assignedWindow is set" })
            }
        } else {
            user.assignedDepartment = undefined
            user.assignedWindow = undefined
        }

        if (password) {
            const { salt, hash, algo, iterations } = await hashPassword(String(password))
            user.passwordSalt = salt
            user.passwordHash = hash
            user.passwordAlgo = algo
            user.passwordIterations = iterations
        }

        await user.save()

        await AuditLogModel.create({
            ...actor(req),
            action: "ADMIN_UPDATE_USER",
            entityType: "User",
            entityId: user._id as any,
            meta: {
                name,
                active,
                role: nextRole,
                departmentId: departmentIdRaw !== undefined ? cleanId(departmentIdRaw) : undefined,
                windowId: windowIdRaw !== undefined ? cleanId(windowIdRaw) : undefined,
                passwordChanged: Boolean(password),
            },
        })

        return res.json({
            staff: {
                id: String(user._id),
                name: user.name,
                email: user.email,
                role: user.role,
                active: user.active,
                assignedDepartment: user.assignedDepartment ? String(user.assignedDepartment) : null,
                assignedWindow: user.assignedWindow ? String(user.assignedWindow) : null,
            },
        })
    },

    deleteStaff: async (req: Request, res: Response) => {
        const { id } = req.params
        const u = (req as any).user
        const currentUserId = String(u?.id ?? "")

        if (!id) return res.status(400).json({ message: "id is required" })

        if (currentUserId && String(id) === currentUserId) {
            return res.status(400).json({ message: "You cannot delete your own account." })
        }

        const user = await UserModel.findById(id)
        if (!user) return res.status(404).json({ message: "User not found" })

        if (user.role === "ADMIN" && user.active) {
            const activeAdminCount = await UserModel.countDocuments({ role: "ADMIN", active: true })
            if (activeAdminCount <= 1) {
                return res.status(400).json({ message: "Cannot delete the last active admin account." })
            }
        }

        await UserModel.deleteOne({ _id: user._id })

        await AuditLogModel.create({
            ...actor(req),
            action: "ADMIN_DELETE_USER",
            entityType: "User",
            entityId: user._id as any,
            meta: { deletedRole: user.role, deletedEmail: user.email },
        })

        return res.json({ ok: true })
    },

    /** =================
     * REPORTS
     * ================= */

    reportsSummary: async (req: Request, res: Response) => {
        const { from, to } = normalizeDateRange(req.query.from, req.query.to)

        const match: any = {
            dateKey: { $gte: from, $lte: to },
        }

        if (req.query.departmentId) {
            const parsed = parseObjectId(req.query.departmentId, "departmentId")
            if (parsed.error) return res.status(400).json({ message: parsed.error })
            if (parsed.value) match.department = parsed.value
        }

        const waitMsExpr = {
            $cond: [
                {
                    $and: [
                        { $ne: ["$calledAt", null] },
                        { $ne: ["$waitingSince", null] },
                    ],
                },
                { $subtract: ["$calledAt", "$waitingSince"] },
                null,
            ],
        }

        const serviceMsExpr = {
            $cond: [
                {
                    $and: [
                        { $ne: ["$servedAt", null] },
                        { $ne: ["$calledAt", null] },
                    ],
                },
                { $subtract: ["$servedAt", "$calledAt"] },
                null,
            ],
        }

        const [agg] = await TicketModel.aggregate([
            { $match: match },
            {
                $facet: {
                    total: [{ $count: "count" }],
                    byStatus: [
                        { $group: { _id: "$status", count: { $sum: 1 } } },
                        { $sort: { _id: 1 } },
                    ],
                    timings: [
                        { $project: { waitMs: waitMsExpr, serviceMs: serviceMsExpr } },
                        {
                            $group: {
                                _id: null,
                                avgWaitMs: { $avg: "$waitMs" },
                                avgServiceMs: { $avg: "$serviceMs" },
                            },
                        },
                    ],
                    byDepartment: [
                        {
                            $group: {
                                _id: "$department",
                                total: { $sum: 1 },
                                waiting: { $sum: { $cond: [{ $eq: ["$status", "WAITING"] }, 1, 0] } },
                                called: { $sum: { $cond: [{ $eq: ["$status", "CALLED"] }, 1, 0] } },
                                hold: { $sum: { $cond: [{ $eq: ["$status", "HOLD"] }, 1, 0] } },
                                out: { $sum: { $cond: [{ $eq: ["$status", "OUT"] }, 1, 0] } },
                                served: { $sum: { $cond: [{ $eq: ["$status", "SERVED"] }, 1, 0] } },
                                avgWaitMs: { $avg: waitMsExpr },
                                avgServiceMs: { $avg: serviceMsExpr },
                            },
                        },
                        {
                            $lookup: {
                                from: "departments",
                                localField: "_id",
                                foreignField: "_id",
                                as: "department",
                            },
                        },
                        { $unwind: { path: "$department", preserveNullAndEmptyArrays: true } },
                        {
                            $project: {
                                _id: 1,
                                name: "$department.name",
                                code: "$department.code",
                                total: 1,
                                waiting: 1,
                                called: 1,
                                hold: 1,
                                out: 1,
                                served: 1,
                                avgWaitMs: 1,
                                avgServiceMs: 1,
                            },
                        },
                        { $sort: { name: 1 } },
                    ],
                },
            },
        ])

        const total = agg?.total?.[0]?.count ?? 0

        const byStatusArr: Array<{ _id: TicketStatus; count: number }> = agg?.byStatus ?? []
        const byStatus: Record<string, number> = {}
        for (const row of byStatusArr) byStatus[row._id] = row.count

        const timingRow = agg?.timings?.[0] ?? null
        const avgWaitMs = timingRow?.avgWaitMs ?? null
        const avgServiceMs = timingRow?.avgServiceMs ?? null

        const departmentsRaw = agg?.byDepartment ?? []
        const departments = departmentsRaw.map((d: any) => ({
            departmentId: d._id ? String(d._id) : "",
            name: d.name,
            code: d.code,
            total: d.total ?? 0,
            waiting: d.waiting ?? 0,
            called: d.called ?? 0,
            hold: d.hold ?? 0,
            out: d.out ?? 0,
            served: d.served ?? 0,
            avgWaitMs: d.avgWaitMs ?? null,
            avgServiceMs: d.avgServiceMs ?? null,
        }))

        return res.json({
            range: { from, to },
            totals: {
                total,
                byStatus,
                avgWaitMs,
                avgServiceMs,
            },
            departments,
        })
    },

    reportsTimeseries: async (req: Request, res: Response) => {
        const { from, to } = normalizeDateRange(req.query.from, req.query.to)

        const match: any = {
            dateKey: { $gte: from, $lte: to },
        }

        if (req.query.departmentId) {
            const parsed = parseObjectId(req.query.departmentId, "departmentId")
            if (parsed.error) return res.status(400).json({ message: parsed.error })
            if (parsed.value) match.department = parsed.value
        }

        const rows: Array<{ _id: { dateKey: string; status: TicketStatus }; count: number }> =
            await TicketModel.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: { dateKey: "$dateKey", status: "$status" },
                        count: { $sum: 1 },
                    },
                },
                { $sort: { "_id.dateKey": 1 } },
            ])

        const map = new Map<
            string,
            { dateKey: string; total: number; waiting: number; called: number; hold: number; out: number; served: number }
        >()

        const ensure = (dateKey: string) => {
            const existing = map.get(dateKey)
            if (existing) return existing
            const init = { dateKey, total: 0, waiting: 0, called: 0, hold: 0, out: 0, served: 0 }
            map.set(dateKey, init)
            return init
        }

        for (const r of rows) {
            const dateKey = r._id.dateKey
            const status = r._id.status
            const count = r.count ?? 0

            const point = ensure(dateKey)
            point.total += count

            if (status === "WAITING") point.waiting += count
            else if (status === "CALLED") point.called += count
            else if (status === "HOLD") point.hold += count
            else if (status === "OUT") point.out += count
            else if (status === "SERVED") point.served += count
        }

        const series = Array.from(map.values()).sort((a, b) => a.dateKey.localeCompare(b.dateKey))

        return res.json({
            range: { from, to },
            series,
        })
    },

    /** =================
     * AUDIT LOGS
     * ================= */

    listAuditLogs: async (req: Request, res: Response) => {
        const page = Math.max(1, toInt(req.query.page, 1))
        const limit = Math.min(200, Math.max(1, toInt(req.query.limit, 50)))
        const skip = (page - 1) * limit

        const filter: any = {}

        if (typeof req.query.action === "string" && req.query.action.trim()) {
            filter.action = req.query.action.trim()
        }

        if (typeof req.query.entityType === "string" && req.query.entityType.trim()) {
            filter.entityType = req.query.entityType.trim()
        }

        if (req.query.actorRole) {
            if (!isRole(req.query.actorRole)) {
                return res.status(400).json({ message: "actorRole must be ADMIN or STAFF" })
            }
            filter.actorRole = req.query.actorRole
        }

        const fromD = parseDateBoundary(req.query.from, "start")
        const toD = parseDateBoundary(req.query.to, "end")
        if (fromD || toD) {
            filter.createdAt = {}
            if (fromD) filter.createdAt.$gte = fromD
            if (toD) filter.createdAt.$lte = toD
        }

        const total = await AuditLogModel.countDocuments(filter)

        const logsRaw = await AuditLogModel.find(filter)
            .sort({ createdAt: -1, _id: -1 })
            .skip(skip)
            .limit(limit)
            .populate("actor", "name email role")
            .lean()

        const logs = logsRaw.map((l: any) => ({
            id: String(l._id),
            actorId: l.actor?._id ? String(l.actor._id) : (l.actor ? String(l.actor) : null),
            actorRole: l.actorRole ?? null,
            actorName: l.actor?.name ?? null,
            actorEmail: l.actor?.email ?? null,
            action: String(l.action),
            entityType: l.entityType ? String(l.entityType) : undefined,
            entityId: l.entityId ? String(l.entityId) : null,
            meta: l.meta ?? undefined,
            createdAt: l.createdAt ? new Date(l.createdAt).toISOString() : new Date().toISOString(),
        }))

        return res.json({ page, limit, total, logs })
    },
}
