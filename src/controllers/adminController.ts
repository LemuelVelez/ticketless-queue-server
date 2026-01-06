import type { Request, Response } from "express"
import { Types } from "mongoose"

import { DepartmentModel } from "../models/Department"
import { ServiceWindowModel } from "../models/ServiceWindow"
import { SettingModel } from "../models/Setting"
import { UserModel, type UserRole } from "../models/User"
import { AuditLogModel } from "../models/AuditLog"
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
function parseObjectId(
    v: unknown,
    fieldName: string,
): { value?: Types.ObjectId; error?: string } {
    const s = cleanId(v)
    if (!s) return { value: undefined }
    if (!Types.ObjectId.isValid(s)) return { error: `${fieldName} must be a valid ObjectId` }
    return { value: new Types.ObjectId(s) }
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
}
