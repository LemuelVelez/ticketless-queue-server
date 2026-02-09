import type { Request, Response } from "express"
import { Types } from "mongoose"

import { DepartmentModel } from "../models/Department"
import { ServiceWindowModel } from "../models/ServiceWindow"
import { SettingModel } from "../models/Setting"
import { UserModel, type UserRole } from "../models/User"
import { AuditLogModel } from "../models/AuditLog"
import { TicketModel, type TicketStatus } from "../models/Ticket"
import { hashPassword } from "./security"
import {
    createTransactionDefinition,
    deleteTransactionDefinition,
    getTransactionDefinitionById,
    listTransactionDefinitions,
    updateTransactionDefinition,
} from "../services/registrarTransactions.service"

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

function normalizeManagerKey(value: unknown, fallback = "REGISTRAR") {
    const v = String(value ?? "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "_")
    return v || fallback
}

function cleanManager(value: unknown): string | null {
    if (value === undefined || value === null) return null
    const s = String(value).trim()
    if (!s || s === "null" || s === "undefined") return null
    return normalizeManagerKey(s, "")
}

function requireManagerKey(
    value: unknown,
    fieldName = "transactionManager",
): { value?: string; error?: string } {
    const manager = cleanManager(value)
    if (!manager) return { error: `${fieldName} is required` }
    return { value: manager }
}

function normalizeScopes(input: unknown): string[] | undefined {
    if (input === undefined) return undefined
    if (!Array.isArray(input)) return []

    const allowed = new Set(["INTERNAL", "EXTERNAL"])
    const seen = new Set<string>()
    const out: string[] = []

    for (const raw of input) {
        const s = String(raw ?? "").trim().toUpperCase()
        if (!s || !allowed.has(s) || seen.has(s)) continue
        seen.add(s)
        out.push(s)
    }

    return out
}

function toBoolean(value: unknown, fallback = false) {
    if (value === undefined || value === null) return fallback
    if (typeof value === "boolean") return value
    const s = String(value).trim().toLowerCase()
    if (s === "true" || s === "1" || s === "yes") return true
    if (s === "false" || s === "0" || s === "no") return false
    return fallback
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

function parseDepartmentIdArray(value: unknown, fieldName: string): { value: string[]; error?: string } {
    if (value === undefined || value === null) return { value: [] }
    if (!Array.isArray(value)) return { value: [], error: `${fieldName} must be an array of ObjectId strings` }

    const seen = new Set<string>()
    const out: string[] = []

    for (const raw of value) {
        const id = String(raw ?? "").trim()
        if (!id) continue
        if (!Types.ObjectId.isValid(id)) return { value: [], error: `${fieldName} contains invalid ObjectId: ${id}` }
        if (seen.has(id)) continue
        seen.add(id)
        out.push(id)
    }

    return { value: out }
}

function uniqueStringIds(values: Array<string | null | undefined>) {
    const seen = new Set<string>()
    const out: string[] = []

    for (const raw of values) {
        const s = String(raw ?? "").trim()
        if (!s) continue
        if (seen.has(s)) continue
        seen.add(s)
        out.push(s)
    }

    return out
}

function extractUserDepartmentIds(user: any): string[] {
    const arr = Array.isArray(user?.assignedDepartments)
        ? (user.assignedDepartments as any[]).map((v) => String(v))
        : []
    const single = user?.assignedDepartment ? [String(user.assignedDepartment)] : []
    return uniqueStringIds([...arr, ...single])
}

function extractWindowDepartmentIds(windowDoc: any): string[] {
    if (!windowDoc) return []
    const arr = Array.isArray(windowDoc.departmentIds)
        ? (windowDoc.departmentIds as any[]).map((v) => String(v))
        : []
    const single = windowDoc.department ? [String(windowDoc.department)] : []
    return uniqueStringIds([...arr, ...single])
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
        const departments = await DepartmentModel.find({}).sort({ transactionManager: 1, name: 1 })
        return res.json({ departments })
    },

    createDepartment: async (req: Request, res: Response) => {
        const { name, code, transactionManager } = req.body || {}
        if (!name) return res.status(400).json({ message: "name is required" })

        const managerParsed = requireManagerKey(transactionManager, "transactionManager")
        if (managerParsed.error) return res.status(400).json({ message: managerParsed.error })

        const department = await DepartmentModel.create({
            name: String(name).trim(),
            code: code ? String(code).trim() : undefined,
            transactionManager: managerParsed.value!,
        })

        await AuditLogModel.create({
            ...actor(req),
            action: "ADMIN_CREATE_DEPARTMENT",
            entityType: "Department",
            entityId: department._id as any,
            meta: { transactionManager: department.transactionManager },
        })

        return res.status(201).json({ department })
    },

    updateDepartment: async (req: Request, res: Response) => {
        const { id } = req.params
        const { name, code, enabled, transactionManager } = req.body || {}

        const department = await DepartmentModel.findById(id)
        if (!department) return res.status(404).json({ message: "Department not found" })

        if (name !== undefined) department.name = String(name).trim()
        if (code !== undefined) department.code = code ? String(code).trim() : undefined
        if (enabled !== undefined) department.enabled = Boolean(enabled)
        if (transactionManager !== undefined) {
            const managerParsed = requireManagerKey(transactionManager, "transactionManager")
            if (managerParsed.error) return res.status(400).json({ message: managerParsed.error })
            department.transactionManager = managerParsed.value!
        }

        await department.save()

        await AuditLogModel.create({
            ...actor(req),
            action: "ADMIN_UPDATE_DEPARTMENT",
            entityType: "Department",
            entityId: department._id as any,
            meta: { name, code, enabled, transactionManager },
        })

        return res.json({ department })
    },

    deleteDepartment: async (req: Request, res: Response) => {
        const { id } = req.params
        const parsed = parseObjectId(id, "id")
        if (parsed.error || !parsed.value) return res.status(400).json({ message: parsed.error || "Invalid id" })

        const department = await DepartmentModel.findById(parsed.value)
        if (!department) return res.status(404).json({ message: "Department not found" })

        const [windowCount, staffCount, purposeRows] = await Promise.all([
            ServiceWindowModel.countDocuments({
                $or: [{ department: parsed.value }, { departmentIds: parsed.value }],
            } as any),
            UserModel.countDocuments({
                role: "STAFF",
                $or: [{ assignedDepartment: parsed.value }, { assignedDepartments: parsed.value }],
            } as any),
            listTransactionDefinitions({
                includeDisabled: true,
                departmentId: String(parsed.value),
                matchDepartmentOrGlobal: true,
            }),
        ])

        const purposeCount = (purposeRows || []).filter((p: any) =>
            Array.isArray(p?.departmentIds) ? p.departmentIds.includes(String(parsed.value)) : false,
        ).length

        if (windowCount > 0 || staffCount > 0 || purposeCount > 0) {
            return res.status(409).json({
                message:
                    "Department cannot be deleted while it is referenced by windows, staff assignments, or transaction purposes.",
                references: {
                    windows: windowCount,
                    staff: staffCount,
                    purposes: purposeCount,
                },
            })
        }

        await DepartmentModel.deleteOne({ _id: parsed.value })

        await AuditLogModel.create({
            ...actor(req),
            action: "ADMIN_DELETE_DEPARTMENT",
            entityType: "Department",
            entityId: parsed.value as any,
            meta: { name: department.name, code: department.code, transactionManager: department.transactionManager },
        })

        return res.json({ ok: true })
    },

    /* ---------------------------------------------------------------------- */
    /* TRANSACTION PURPOSES (CRUD)                                            */
    /* ---------------------------------------------------------------------- */

    listTransactionPurposes: async (req: Request, res: Response) => {
        const filter = {
            category: typeof req.query.category === "string" ? req.query.category : undefined,
            key: typeof req.query.key === "string" ? req.query.key : undefined,
            scope: typeof req.query.scope === "string" ? req.query.scope : undefined,
            departmentId: typeof req.query.departmentId === "string" ? req.query.departmentId : undefined,
            enabledOnly: toBoolean(req.query.enabledOnly, false),
            includeDisabled: toBoolean(req.query.includeDisabled, false),
            matchDepartmentOrGlobal: toBoolean(req.query.matchDepartmentOrGlobal, true),
        }

        const transactions = await listTransactionDefinitions(filter)
        return res.json({ transactions })
    },

    createTransactionPurpose: async (req: Request, res: Response) => {
        const body = req.body || {}

        const key = String(body.key || "").trim()
        const label = String(body.label || "").trim()
        if (!key || !label) {
            return res.status(400).json({ message: "key and label are required" })
        }

        const departmentIdRaw = cleanId(body.departmentId)
        const applyToAllDepartments = Boolean(body.applyToAllDepartments)

        const depArrayParsed = parseDepartmentIdArray(body.departmentIds, "departmentIds")
        if (depArrayParsed.error) return res.status(400).json({ message: depArrayParsed.error })

        let category = cleanManager(body.category)
        if (!category && departmentIdRaw) {
            const dept = await DepartmentModel.findById(departmentIdRaw).select("_id transactionManager enabled").lean()
            if (!dept || (dept as any).enabled === false) {
                return res.status(400).json({ message: "departmentId is invalid or disabled" })
            }
            category = cleanManager((dept as any).transactionManager)
        }

        if (!category) {
            return res.status(400).json({ message: "category is required (transaction manager key)" })
        }

        let departmentIds: string[] = []
        if (applyToAllDepartments) {
            departmentIds = []
        } else if (depArrayParsed.value.length) {
            departmentIds = depArrayParsed.value
        } else if (departmentIdRaw) {
            if (!Types.ObjectId.isValid(departmentIdRaw)) {
                return res.status(400).json({ message: "departmentId must be a valid ObjectId" })
            }
            departmentIds = [departmentIdRaw]
        }

        if (departmentIds.length > 0) {
            const depDocs = await DepartmentModel.find({ _id: { $in: departmentIds } })
                .select("_id transactionManager enabled")
                .lean()

            const depById = new Map<string, any>()
            for (const d of depDocs as any[]) depById.set(String(d._id), d)

            if (depById.size !== departmentIds.length) {
                return res.status(400).json({ message: "One or more departmentIds are invalid" })
            }

            for (const depId of departmentIds) {
                const dep = depById.get(depId)
                if (!dep) return res.status(400).json({ message: `Invalid departmentId: ${depId}` })
                if (dep.enabled === false) {
                    return res.status(400).json({ message: `Department is disabled: ${depId}` })
                }

                const depManager = cleanManager(dep.transactionManager)
                if (!depManager) {
                    return res.status(400).json({ message: `Department has no transactionManager: ${depId}` })
                }

                if (depManager !== category) {
                    return res.status(400).json({
                        message: `Department ${depId} belongs to manager ${depManager}, but category is ${category}`,
                    })
                }
            }
        }

        const scopes = normalizeScopes(body.scopes) ?? ["INTERNAL", "EXTERNAL"]

        const created = await createTransactionDefinition({
            category,
            key,
            label,
            scopes,
            departmentIds,
            enabled: body.enabled !== undefined ? Boolean(body.enabled) : true,
            sortOrder: body.sortOrder !== undefined ? Number(body.sortOrder) : undefined,
            meta: body.meta,
        })

        await AuditLogModel.create({
            ...actor(req),
            action: "ADMIN_CREATE_TRANSACTION_PURPOSE",
            entityType: "TransactionCatalog",
            entityId: created.id as any,
            meta: {
                category: created.category,
                key: created.key,
                departmentIds: created.departmentIds,
            },
        })

        return res.status(201).json({ transaction: created })
    },

    updateTransactionPurpose: async (req: Request, res: Response) => {
        const { id } = req.params
        if (!id) return res.status(400).json({ message: "id is required" })

        const existing = await getTransactionDefinitionById(id)
        if (!existing) return res.status(404).json({ message: "Transaction purpose not found" })

        const body = req.body || {}
        const patch: any = {}

        if (body.category !== undefined) {
            const category = cleanManager(body.category)
            if (!category) return res.status(400).json({ message: "category cannot be empty" })
            patch.category = category
        }
        if (body.key !== undefined) patch.key = String(body.key).trim()
        if (body.label !== undefined) patch.label = String(body.label).trim()
        if (body.scopes !== undefined) patch.scopes = normalizeScopes(body.scopes) ?? []
        if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled)
        if (body.sortOrder !== undefined) patch.sortOrder = Number(body.sortOrder)
        if (body.meta !== undefined) patch.meta = body.meta

        const departmentIdRaw = cleanId(body.departmentId)
        const applyToAllDepartments = body.applyToAllDepartments === true

        if (applyToAllDepartments) {
            patch.departmentIds = []
        } else if (body.departmentIds !== undefined) {
            const depArrayParsed = parseDepartmentIdArray(body.departmentIds, "departmentIds")
            if (depArrayParsed.error) return res.status(400).json({ message: depArrayParsed.error })
            patch.departmentIds = depArrayParsed.value
        } else if (departmentIdRaw !== null) {
            if (!Types.ObjectId.isValid(departmentIdRaw)) {
                return res.status(400).json({ message: "departmentId must be a valid ObjectId" })
            }
            patch.departmentIds = [departmentIdRaw]
        }

        const nextCategory = cleanManager(patch.category ?? existing.category)
        if (!nextCategory) {
            return res.status(400).json({ message: "category is required (transaction manager key)" })
        }
        patch.category = nextCategory

        const nextDepartmentIds: string[] = Array.isArray(patch.departmentIds)
            ? patch.departmentIds
            : [...(existing.departmentIds || [])]

        if (nextDepartmentIds.length > 0) {
            const depDocs = await DepartmentModel.find({ _id: { $in: nextDepartmentIds } })
                .select("_id transactionManager enabled")
                .lean()

            const depById = new Map<string, any>()
            for (const d of depDocs as any[]) depById.set(String(d._id), d)

            if (depById.size !== nextDepartmentIds.length) {
                return res.status(400).json({ message: "One or more departmentIds are invalid" })
            }

            for (const depId of nextDepartmentIds) {
                const dep = depById.get(depId)
                if (!dep) return res.status(400).json({ message: `Invalid departmentId: ${depId}` })
                if (dep.enabled === false) {
                    return res.status(400).json({ message: `Department is disabled: ${depId}` })
                }

                const depManager = cleanManager(dep.transactionManager)
                if (!depManager) {
                    return res.status(400).json({ message: `Department has no transactionManager: ${depId}` })
                }

                if (depManager !== nextCategory) {
                    return res.status(400).json({
                        message: `Department ${depId} belongs to manager ${depManager}, but category is ${nextCategory}`,
                    })
                }
            }
        }

        const updated = await updateTransactionDefinition(id, patch)

        await AuditLogModel.create({
            ...actor(req),
            action: "ADMIN_UPDATE_TRANSACTION_PURPOSE",
            entityType: "TransactionCatalog",
            entityId: updated.id as any,
            meta: {
                key: updated.key,
                category: updated.category,
                departmentIds: updated.departmentIds,
                enabled: updated.enabled,
            },
        })

        return res.json({ transaction: updated })
    },

    deleteTransactionPurpose: async (req: Request, res: Response) => {
        const { id } = req.params
        if (!id) return res.status(400).json({ message: "id is required" })

        const existing = await getTransactionDefinitionById(id)
        if (!existing) return res.status(404).json({ message: "Transaction purpose not found" })

        const deleted = await deleteTransactionDefinition(id)
        if (!deleted) return res.status(404).json({ message: "Transaction purpose not found" })

        await AuditLogModel.create({
            ...actor(req),
            action: "ADMIN_DELETE_TRANSACTION_PURPOSE",
            entityType: "TransactionCatalog",
            entityId: id as any,
            meta: {
                key: existing.key,
                category: existing.category,
            },
        })

        return res.json({ ok: true })
    },

    // WINDOWS
    listWindows: async (req: Request, res: Response) => {
        const { departmentId } = req.query

        const filter: any = {}
        if (departmentId) {
            const parsed = parseObjectId(departmentId, "departmentId")
            if (parsed.error) return res.status(400).json({ message: parsed.error })
            if (parsed.value) {
                filter.$or = [{ department: parsed.value }, { departmentIds: parsed.value }]
            }
        }

        const windows = await ServiceWindowModel.find(filter).sort({ enabled: -1, number: 1, name: 1 })
        return res.json({ windows })
    },

    createWindow: async (req: Request, res: Response) => {
        const { departmentId, departmentIds, name, number, enabled } = req.body || {}

        const nameTrimmed = String(name ?? "").trim()
        if (!nameTrimmed) {
            return res.status(400).json({ message: "name is required" })
        }

        const numberParsed = Number(number)
        if (!Number.isFinite(numberParsed) || numberParsed <= 0) {
            return res.status(400).json({ message: "number must be a positive number" })
        }

        const deptParsed = parseObjectId(departmentId, "departmentId")
        if (deptParsed.error) return res.status(400).json({ message: deptParsed.error })

        const depArrayParsed = parseDepartmentIdArray(departmentIds, "departmentIds")
        if (depArrayParsed.error) return res.status(400).json({ message: depArrayParsed.error })

        const selectedDepartmentIds = uniqueStringIds([
            ...depArrayParsed.value,
            deptParsed.value ? String(deptParsed.value) : "",
        ])

        if (selectedDepartmentIds.length === 0) {
            return res.status(400).json({ message: "departmentId or departmentIds is required" })
        }

        const depDocs = await DepartmentModel.find({ _id: { $in: selectedDepartmentIds } })
            .select("_id transactionManager enabled")
            .lean()

        const depById = new Map<string, any>()
        for (const d of depDocs as any[]) depById.set(String(d._id), d)

        if (depById.size !== selectedDepartmentIds.length) {
            return res.status(400).json({ message: "One or more departmentIds are invalid" })
        }

        const managers = new Set<string>()
        for (const depId of selectedDepartmentIds) {
            const dep = depById.get(depId)
            if (!dep) return res.status(400).json({ message: `Invalid departmentId: ${depId}` })
            if (dep.enabled === false) return res.status(400).json({ message: `Department is disabled: ${depId}` })

            const manager = cleanManager(dep.transactionManager)
            if (!manager) return res.status(400).json({ message: `Department has no transactionManager: ${depId}` })
            managers.add(manager)
        }

        if (managers.size > 1) {
            return res.status(400).json({
                message: "All departments in one window must belong to the same transaction manager",
            })
        }

        const selectedDepartmentObjectIds = selectedDepartmentIds.map((id) => new Types.ObjectId(id))

        const win = await ServiceWindowModel.create({
            department: selectedDepartmentObjectIds[0],
            departmentIds: selectedDepartmentObjectIds,
            name: nameTrimmed,
            number: numberParsed,
            enabled: enabled !== undefined ? Boolean(enabled) : true,
        })

        await AuditLogModel.create({
            ...actor(req),
            action: "ADMIN_CREATE_WINDOW",
            entityType: "ServiceWindow",
            entityId: win._id as any,
            meta: {
                name: win.name,
                number: win.number,
                departmentIds: selectedDepartmentIds,
                enabled: win.enabled,
            },
        })

        return res.status(201).json({ window: win })
    },

    updateWindow: async (req: Request, res: Response) => {
        const { id } = req.params
        const { name, number, enabled, departmentId, departmentIds } = req.body || {}

        const hasDepartmentIdPatch = Object.prototype.hasOwnProperty.call(req.body || {}, "departmentId")
        const hasDepartmentIdsPatch = Object.prototype.hasOwnProperty.call(req.body || {}, "departmentIds")

        const win = await ServiceWindowModel.findById(id)
        if (!win) return res.status(404).json({ message: "Window not found" })

        if (hasDepartmentIdPatch || hasDepartmentIdsPatch) {
            let nextDepartmentIds = extractWindowDepartmentIds(win)

            if (hasDepartmentIdsPatch) {
                const depArrayParsed = parseDepartmentIdArray(departmentIds, "departmentIds")
                if (depArrayParsed.error) return res.status(400).json({ message: depArrayParsed.error })
                nextDepartmentIds = depArrayParsed.value
            }

            if (hasDepartmentIdPatch) {
                const deptParsed = parseObjectId(departmentId, "departmentId")
                if (deptParsed.error) return res.status(400).json({ message: deptParsed.error })

                if (deptParsed.value) {
                    if (hasDepartmentIdsPatch) {
                        nextDepartmentIds = uniqueStringIds([...nextDepartmentIds, String(deptParsed.value)])
                    } else {
                        nextDepartmentIds = [String(deptParsed.value)]
                    }
                } else if (!hasDepartmentIdsPatch) {
                    nextDepartmentIds = []
                }
            }

            if (nextDepartmentIds.length === 0) {
                return res.status(400).json({ message: "A window must have at least one department" })
            }

            const depDocs = await DepartmentModel.find({ _id: { $in: nextDepartmentIds } })
                .select("_id transactionManager enabled")
                .lean()

            const depById = new Map<string, any>()
            for (const d of depDocs as any[]) depById.set(String(d._id), d)

            if (depById.size !== nextDepartmentIds.length) {
                return res.status(400).json({ message: "One or more departmentIds are invalid" })
            }

            const managers = new Set<string>()
            for (const depId of nextDepartmentIds) {
                const dep = depById.get(depId)
                if (!dep) return res.status(400).json({ message: `Invalid departmentId: ${depId}` })
                if (dep.enabled === false) return res.status(400).json({ message: `Department is disabled: ${depId}` })

                const manager = cleanManager(dep.transactionManager)
                if (!manager) return res.status(400).json({ message: `Department has no transactionManager: ${depId}` })
                managers.add(manager)
            }

            if (managers.size > 1) {
                return res.status(400).json({
                    message: "All departments in one window must belong to the same transaction manager",
                })
            }

            const nextDepartmentObjectIds = nextDepartmentIds.map((d) => new Types.ObjectId(d))
            ;(win as any).departmentIds = nextDepartmentObjectIds
            win.department = nextDepartmentObjectIds[0]
        }

        if (name !== undefined) {
            const nameTrimmed = String(name).trim()
            if (!nameTrimmed) return res.status(400).json({ message: "name cannot be empty" })
            win.name = nameTrimmed
        }

        if (number !== undefined) {
            const numberParsed = Number(number)
            if (!Number.isFinite(numberParsed) || numberParsed <= 0) {
                return res.status(400).json({ message: "number must be a positive number" })
            }
            win.number = numberParsed
        }

        if (enabled !== undefined) win.enabled = Boolean(enabled)

        await win.save()

        await AuditLogModel.create({
            ...actor(req),
            action: "ADMIN_UPDATE_WINDOW",
            entityType: "ServiceWindow",
            entityId: win._id as any,
            meta: {
                name,
                number,
                enabled,
                departmentId: hasDepartmentIdPatch ? cleanId(departmentId) : undefined,
                departmentIds: hasDepartmentIdsPatch
                    ? parseDepartmentIdArray(departmentIds, "departmentIds").value
                    : undefined,
            },
        })

        return res.json({ window: win })
    },

    deleteWindow: async (req: Request, res: Response) => {
        const { id } = req.params
        const parsed = parseObjectId(id, "id")
        if (parsed.error || !parsed.value) return res.status(400).json({ message: parsed.error || "Invalid id" })

        const win = await ServiceWindowModel.findById(parsed.value)
        if (!win) return res.status(404).json({ message: "Window not found" })

        const staffCount = await UserModel.countDocuments({
            role: "STAFF",
            assignedWindow: win._id,
        } as any)

        if (staffCount > 0) {
            return res.status(409).json({
                message: "Window cannot be deleted while staff is assigned to it.",
                references: {
                    staff: staffCount,
                },
            })
        }

        await ServiceWindowModel.deleteOne({ _id: win._id })

        await AuditLogModel.create({
            ...actor(req),
            action: "ADMIN_DELETE_WINDOW",
            entityType: "ServiceWindow",
            entityId: win._id as any,
            meta: {
                name: win.name,
                number: win.number,
                department: String(win.department),
                departmentIds: extractWindowDepartmentIds(win),
            },
        })

        return res.json({ ok: true })
    },

    // ACCOUNTS (kept names listStaff/createStaff/updateStaff for frontend compatibility)
    listStaff: async (_req: Request, res: Response) => {
        const users = await UserModel.find({
            role: { $in: ["ADMIN", "STAFF"] as UserRole[] },
        })
            .select("-passwordHash -passwordSalt -passwordIterations -passwordAlgo")
            .sort({ createdAt: -1 })
            .lean()

        const departmentIds = Array.from(
            new Set(
                users
                    .flatMap((u: any) => {
                        const ids: string[] = []

                        if (Array.isArray(u.assignedDepartments)) {
                            for (const did of u.assignedDepartments) {
                                const s = String(did || "").trim()
                                if (s) ids.push(s)
                            }
                        }

                        if (u.assignedDepartment) {
                            const s = String(u.assignedDepartment).trim()
                            if (s) ids.push(s)
                        }

                        return ids
                    })
                    .filter(Boolean),
            ),
        )

        const deptManagerById = new Map<string, string>()
        if (departmentIds.length > 0) {
            const depts = await DepartmentModel.find({ _id: { $in: departmentIds } })
                .select("_id transactionManager")
                .lean()

            for (const d of depts as any[]) {
                const manager = cleanManager(d.transactionManager)
                if (manager) deptManagerById.set(String(d._id), manager)
            }
        }

        const staff = users.map((u: any) => {
            const assignedDepartments = uniqueStringIds([
                ...(Array.isArray(u.assignedDepartments) ? u.assignedDepartments.map((x: any) => String(x)) : []),
                u.assignedDepartment ? String(u.assignedDepartment) : "",
            ])

            const assignedDepartment =
                u.assignedDepartment ? String(u.assignedDepartment) : assignedDepartments[0] ?? null

            const assignedWindow = u.assignedWindow ? String(u.assignedWindow) : null

            const managerFromUser = cleanManager(u.assignedTransactionManager)
            const managerFromDepartment = assignedDepartment
                ? deptManagerById.get(assignedDepartment) || null
                : assignedDepartments.length > 0
                    ? deptManagerById.get(assignedDepartments[0]) || null
                    : null

            const assignedTransactionManager = managerFromUser || managerFromDepartment || null

            return {
                id: String(u._id),
                _id: String(u._id),
                name: u.name,
                email: u.email,
                role: u.role,
                active: Boolean(u.active),
                assignedDepartment,
                assignedDepartments,
                assignedWindow,
                assignedTransactionManager,
            }
        })

        return res.json({ staff })
    },

    createStaff: async (req: Request, res: Response) => {
        const { name, email, password } = req.body || {}
        const roleRaw = (req.body || {}).role
        const role: UserRole = isRole(roleRaw) ? roleRaw : "STAFF"

        const departmentIdRaw = (req.body || {}).departmentId
        const departmentIdsRaw = (req.body || {}).departmentIds
        const windowIdRaw = (req.body || {}).windowId
        const transactionManagerRaw = (req.body || {}).transactionManager

        if (!name || !email || !password) {
            return res.status(400).json({ message: "name, email, password are required" })
        }

        const deptParsed = parseObjectId(departmentIdRaw, "departmentId")
        if (deptParsed.error) return res.status(400).json({ message: deptParsed.error })

        const deptArrayParsed = parseDepartmentIdArray(departmentIdsRaw, "departmentIds")
        if (deptArrayParsed.error) return res.status(400).json({ message: deptArrayParsed.error })

        const winParsed = parseObjectId(windowIdRaw, "windowId")
        if (winParsed.error) return res.status(400).json({ message: winParsed.error })

        let selectedDepartmentIds = uniqueStringIds([
            ...deptArrayParsed.value,
            deptParsed.value ? String(deptParsed.value) : "",
        ])

        let winDoc: any = null
        let winDepartmentIds: string[] = []
        if (winParsed.value) {
            winDoc = await ServiceWindowModel.findById(winParsed.value)
                .select("_id department departmentIds enabled")
                .lean()

            if (!winDoc) return res.status(400).json({ message: "windowId is invalid" })
            if (winDoc.enabled === false) return res.status(400).json({ message: "windowId is disabled" })

            winDepartmentIds = extractWindowDepartmentIds(winDoc)
            if (winDepartmentIds.length === 0) {
                return res.status(400).json({ message: "windowId has no department bindings" })
            }

            // ensure selected departments include all window departments
            selectedDepartmentIds = uniqueStringIds([...selectedDepartmentIds, ...winDepartmentIds])
        }

        if (role === "STAFF") {
            if (!winParsed.value) {
                return res.status(400).json({ message: "windowId is required for STAFF" })
            }
            if (selectedDepartmentIds.length === 0) {
                return res.status(400).json({ message: "departmentId or departmentIds is required for STAFF" })
            }

            // one staff per window
            const existingAtWindow = await UserModel.findOne({
                role: "STAFF",
                assignedWindow: winParsed.value,
            })
                .select("_id name email")
                .lean()

            if (existingAtWindow) {
                return res.status(409).json({
                    message: "Selected window already has an assigned staff.",
                    assignedTo: {
                        id: String((existingAtWindow as any)._id),
                        name: (existingAtWindow as any).name ?? null,
                        email: (existingAtWindow as any).email ?? null,
                    },
                })
            }
        }

        let departmentManager: string | null = null
        if (selectedDepartmentIds.length > 0) {
            const depDocs = await DepartmentModel.find({ _id: { $in: selectedDepartmentIds } })
                .select("_id transactionManager enabled")
                .lean()

            const depById = new Map<string, any>()
            for (const d of depDocs as any[]) depById.set(String(d._id), d)

            if (depById.size !== selectedDepartmentIds.length) {
                return res.status(400).json({ message: "One or more departmentIds are invalid" })
            }

            const managers = new Set<string>()

            for (const depId of selectedDepartmentIds) {
                const dep = depById.get(depId)
                if (!dep) return res.status(400).json({ message: `Invalid departmentId: ${depId}` })
                if (dep.enabled === false) return res.status(400).json({ message: `Department is disabled: ${depId}` })

                const m = cleanManager(dep.transactionManager)
                if (!m) return res.status(400).json({ message: `Department has no transactionManager: ${depId}` })
                managers.add(m)
            }

            if (managers.size > 1) {
                return res.status(400).json({
                    message: "All assigned departments must belong to the same transaction manager",
                })
            }

            departmentManager = Array.from(managers)[0] ?? null
        }

        const managerFromBody = cleanManager(transactionManagerRaw)
        const effectiveManager = managerFromBody || departmentManager || null

        if (role === "STAFF" && !effectiveManager) {
            return res.status(400).json({ message: "transactionManager is required for STAFF" })
        }

        if (role === "STAFF" && departmentManager && effectiveManager && departmentManager !== effectiveManager) {
            return res.status(400).json({
                message: `Selected departments belong to manager ${departmentManager}, but received ${effectiveManager}`,
            })
        }

        const normalizedEmail = normalizeEmail(email)
        const existing = await UserModel.findOne({ email: normalizedEmail })
        if (existing) return res.status(409).json({ message: "Email already exists" })

        const { salt, hash, algo, iterations } = await hashPassword(String(password))

        const primaryDepartmentId =
            role === "STAFF"
                ? (winDepartmentIds[0] || selectedDepartmentIds[0] || null)
                : null

        const userPayload: any = {
            name: String(name).trim(),
            email: normalizedEmail,
            role,
            active: true,

            passwordSalt: salt,
            passwordHash: hash,
            passwordAlgo: algo,
            passwordIterations: iterations,

            assignedTransactionManager: role === "STAFF" ? effectiveManager || undefined : undefined,
            assignedDepartment:
                role === "STAFF" && primaryDepartmentId ? new Types.ObjectId(primaryDepartmentId) : undefined,
            assignedDepartments:
                role === "STAFF" ? selectedDepartmentIds.map((id) => new Types.ObjectId(id)) : undefined,
            assignedWindow: role === "STAFF" ? winParsed.value : undefined,
        }

        const user = await UserModel.create(userPayload)

        await AuditLogModel.create({
            ...actor(req),
            action: "ADMIN_CREATE_USER",
            entityType: "User",
            entityId: user._id as any,
            meta: {
                role,
                transactionManager: role === "STAFF" ? effectiveManager : undefined,
                departmentIds: role === "STAFF" ? selectedDepartmentIds : undefined,
                windowId: role === "STAFF" ? cleanId(windowIdRaw) : undefined,
            },
        })

        const responseDepartmentIds = extractUserDepartmentIds(user)

        return res.status(201).json({
            staff: {
                id: String(user._id),
                _id: String(user._id),
                name: user.name,
                email: user.email,
                role: user.role,
                active: user.active,
                assignedTransactionManager: user.assignedTransactionManager
                    ? String(user.assignedTransactionManager)
                    : null,
                assignedDepartment: user.assignedDepartment ? String(user.assignedDepartment) : null,
                assignedDepartments: responseDepartmentIds,
                assignedWindow: user.assignedWindow ? String(user.assignedWindow) : null,
            },
        })
    },

    updateStaff: async (req: Request, res: Response) => {
        const { id } = req.params
        const { name, active, password } = req.body || {}

        const roleRaw = (req.body || {}).role
        const nextRole: UserRole | undefined = isRole(roleRaw) ? roleRaw : undefined

        const hasDepartmentIdPatch = Object.prototype.hasOwnProperty.call(req.body || {}, "departmentId")
        const hasDepartmentIdsPatch = Object.prototype.hasOwnProperty.call(req.body || {}, "departmentIds")
        const hasWindowIdPatch = Object.prototype.hasOwnProperty.call(req.body || {}, "windowId")
        const hasTransactionManagerPatch = Object.prototype.hasOwnProperty.call(req.body || {}, "transactionManager")

        const departmentIdRaw = (req.body || {}).departmentId
        const departmentIdsRaw = (req.body || {}).departmentIds
        const windowIdRaw = (req.body || {}).windowId
        const transactionManagerRaw = (req.body || {}).transactionManager

        const user = await UserModel.findById(id)
        if (!user) return res.status(404).json({ message: "User not found" })

        if (name !== undefined) user.name = String(name).trim()
        if (active !== undefined) user.active = Boolean(active)

        if (nextRole) {
            user.role = nextRole
        }

        if (user.role === "STAFF") {
            let nextDepartmentIds = extractUserDepartmentIds(user)

            if (hasDepartmentIdsPatch) {
                const depArrayParsed = parseDepartmentIdArray(departmentIdsRaw, "departmentIds")
                if (depArrayParsed.error) return res.status(400).json({ message: depArrayParsed.error })
                nextDepartmentIds = depArrayParsed.value
            }

            if (hasDepartmentIdPatch) {
                const deptParsed = parseObjectId(departmentIdRaw, "departmentId")
                if (deptParsed.error) return res.status(400).json({ message: deptParsed.error })

                if (deptParsed.value) {
                    if (hasDepartmentIdsPatch) {
                        nextDepartmentIds = uniqueStringIds([...nextDepartmentIds, String(deptParsed.value)])
                    } else {
                        nextDepartmentIds = [String(deptParsed.value)]
                    }
                } else if (!hasDepartmentIdsPatch) {
                    nextDepartmentIds = []
                }
            }

            if (hasWindowIdPatch) {
                const winParsed = parseObjectId(windowIdRaw, "windowId")
                if (winParsed.error) return res.status(400).json({ message: winParsed.error })
                user.assignedWindow = winParsed.value
            }

            let winDoc: any = null
            let winDepartmentIds: string[] = []
            if (user.assignedWindow) {
                winDoc = await ServiceWindowModel.findById(user.assignedWindow)
                    .select("_id department departmentIds enabled")
                    .lean()

                if (!winDoc) return res.status(400).json({ message: "assignedWindow is invalid" })
                if (winDoc.enabled === false) return res.status(400).json({ message: "assignedWindow is disabled" })

                winDepartmentIds = extractWindowDepartmentIds(winDoc)
                if (winDepartmentIds.length === 0) {
                    return res.status(400).json({ message: "assignedWindow has no department bindings" })
                }

                // enforce one-window + multi-department rule:
                // if a window is assigned, all of its departments must be included.
                nextDepartmentIds = uniqueStringIds([...nextDepartmentIds, ...winDepartmentIds])

                // enforce one staff per window
                const existingAtWindow = await UserModel.findOne({
                    role: "STAFF",
                    assignedWindow: user.assignedWindow,
                    _id: { $ne: user._id },
                })
                    .select("_id name email")
                    .lean()

                if (existingAtWindow) {
                    return res.status(409).json({
                        message: "Selected window already has an assigned staff.",
                        assignedTo: {
                            id: String((existingAtWindow as any)._id),
                            name: (existingAtWindow as any).name ?? null,
                            email: (existingAtWindow as any).email ?? null,
                        },
                    })
                }
            }

            if (nextDepartmentIds.length === 0) {
                return res.status(400).json({ message: "At least one assigned department is required for STAFF" })
            }

            const depDocs = await DepartmentModel.find({ _id: { $in: nextDepartmentIds } })
                .select("_id transactionManager enabled")
                .lean()

            const depById = new Map<string, any>()
            for (const d of depDocs as any[]) depById.set(String(d._id), d)

            if (depById.size !== nextDepartmentIds.length) {
                return res.status(400).json({ message: "One or more assigned departments are invalid" })
            }

            const managers = new Set<string>()
            for (const depId of nextDepartmentIds) {
                const dep = depById.get(depId)
                if (!dep) return res.status(400).json({ message: `Invalid assignedDepartment: ${depId}` })
                if (dep.enabled === false) return res.status(400).json({ message: `Department is disabled: ${depId}` })

                const m = cleanManager(dep.transactionManager)
                if (!m) return res.status(400).json({ message: `Department has no transactionManager: ${depId}` })
                managers.add(m)
            }

            if (managers.size > 1) {
                return res.status(400).json({
                    message: "All assigned departments must belong to the same transaction manager",
                })
            }

            const departmentsManager = Array.from(managers)[0] ?? null
            const currentManager = cleanManager(user.assignedTransactionManager)
            const patchedManager = hasTransactionManagerPatch ? cleanManager(transactionManagerRaw) : null
            const effectiveManager = patchedManager || currentManager || departmentsManager || null

            if (!effectiveManager) {
                return res.status(400).json({ message: "transactionManager is required for STAFF" })
            }

            if (departmentsManager && departmentsManager !== effectiveManager) {
                return res.status(400).json({
                    message: `Selected departments belong to manager ${departmentsManager}, but received ${effectiveManager}`,
                })
            }

            ;(user as any).assignedDepartments = nextDepartmentIds.map((did) => new Types.ObjectId(did))

            const primaryDepartmentId = winDepartmentIds[0] || nextDepartmentIds[0]
            user.assignedDepartment = primaryDepartmentId ? new Types.ObjectId(primaryDepartmentId) : undefined
            user.assignedTransactionManager = effectiveManager
        } else {
            user.assignedTransactionManager = undefined
            user.assignedDepartment = undefined
            ;(user as any).assignedDepartments = undefined
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
                transactionManager: hasTransactionManagerPatch
                    ? cleanManager(transactionManagerRaw) ?? null
                    : undefined,
                departmentId: hasDepartmentIdPatch ? cleanId(departmentIdRaw) : undefined,
                departmentIds: hasDepartmentIdsPatch
                    ? (parseDepartmentIdArray(departmentIdsRaw, "departmentIds").value ?? [])
                    : undefined,
                windowId: hasWindowIdPatch ? cleanId(windowIdRaw) : undefined,
                passwordChanged: Boolean(password),
            },
        })

        const responseDepartmentIds = extractUserDepartmentIds(user)

        return res.json({
            staff: {
                id: String(user._id),
                _id: String(user._id),
                name: user.name,
                email: user.email,
                role: user.role,
                active: user.active,
                assignedTransactionManager: user.assignedTransactionManager
                    ? String(user.assignedTransactionManager)
                    : null,
                assignedDepartment: user.assignedDepartment ? String(user.assignedDepartment) : null,
                assignedDepartments: responseDepartmentIds,
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
