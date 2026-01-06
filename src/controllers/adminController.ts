import type { Request, Response } from "express"
import { DepartmentModel } from "../models/Department"
import { ServiceWindowModel } from "../models/ServiceWindow"
import { SettingModel } from "../models/Setting"
import { UserModel } from "../models/User"
import { AuditLogModel } from "../models/AuditLog"
import { hashPassword } from "./security"

function actor(req: Request) {
    const u = (req as any).user
    return { actor: u?.id, actorRole: u?.role }
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

        const department = await DepartmentModel.create({ name: String(name).trim(), code: code ? String(code).trim() : undefined })

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
        if (departmentId) filter.department = departmentId

        const windows = await ServiceWindowModel.find(filter).sort({ department: 1, number: 1 })
        return res.json({ windows })
    },

    createWindow: async (req: Request, res: Response) => {
        const { departmentId, name, number } = req.body || {}
        if (!departmentId || !name || number === undefined) {
            return res.status(400).json({ message: "departmentId, name, number are required" })
        }

        const win = await ServiceWindowModel.create({
            department: departmentId,
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

    // STAFF ACCOUNTS
    listStaff: async (_req: Request, res: Response) => {
        const staff = await UserModel.find({ role: "STAFF" })
            .select("-passwordHash -passwordSalt -passwordIterations -passwordAlgo")
            .sort({ createdAt: -1 })
        return res.json({ staff })
    },

    createStaff: async (req: Request, res: Response) => {
        const { name, email, password, departmentId, windowId } = req.body || {}
        if (!name || !email || !password || !departmentId || !windowId) {
            return res.status(400).json({ message: "name, email, password, departmentId, windowId are required" })
        }

        const normalizedEmail = String(email).toLowerCase().trim()
        const existing = await UserModel.findOne({ email: normalizedEmail })
        if (existing) return res.status(409).json({ message: "Email already exists" })

        const { salt, hash, algo, iterations } = await hashPassword(String(password))

        const user = await UserModel.create({
            name: String(name).trim(),
            email: normalizedEmail,
            role: "STAFF",
            active: true,
            passwordSalt: salt,
            passwordHash: hash,
            passwordAlgo: algo,
            passwordIterations: iterations,
            assignedDepartment: departmentId,
            assignedWindow: windowId,
        })

        await AuditLogModel.create({
            ...actor(req),
            action: "ADMIN_CREATE_STAFF",
            entityType: "User",
            entityId: user._id as any,
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
        const { name, active, departmentId, windowId, password } = req.body || {}

        const user = await UserModel.findById(id)
        if (!user || user.role !== "STAFF") return res.status(404).json({ message: "Staff not found" })

        if (name !== undefined) user.name = String(name).trim()
        if (active !== undefined) user.active = Boolean(active)
        if (departmentId !== undefined) user.assignedDepartment = departmentId
        if (windowId !== undefined) user.assignedWindow = windowId

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
            action: "ADMIN_UPDATE_STAFF",
            entityType: "User",
            entityId: user._id as any,
            meta: { name, active, departmentId, windowId, passwordChanged: Boolean(password) },
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
}
