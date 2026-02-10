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
import { ParticipantModel } from "../services/participantAuth.service"

function actor(req: Request) {
  const u = (req as any).user
  return { actor: u?.id, actorRole: u?.role }
}

function normalizeEmail(email: unknown) {
  return String(email ?? "").toLowerCase().trim()
}

/**
 * ADMIN / STAFF roles only.
 * Used where behavior is specific to staff accounts.
 */
function isRole(value: unknown): value is UserRole {
  return value === "ADMIN" || value === "STAFF"
}

/**
 * Any account role shown in Admin Accounts.
 */
function isAccountRole(value: unknown): value is UserRole {
  return value === "ADMIN" || value === "STAFF" || value === "STUDENT" || value === "ALUMNI_VISITOR" || value === "GUEST"
}

type ParticipantRole = "STUDENT" | "ALUMNI_VISITOR" | "GUEST"

function isParticipantRole(value: unknown): value is ParticipantRole {
  return value === "STUDENT" || value === "ALUMNI_VISITOR" || value === "GUEST"
}

function normalizeParticipantRole(value: unknown): ParticipantRole | null {
  const role = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s/-]+/g, "_")

  if (role === "STUDENT") return "STUDENT"
  if (role === "ALUMNI_VISITOR" || role === "ALUMNI" || role === "VISITOR") return "ALUMNI_VISITOR"
  if (role === "GUEST") return "GUEST"
  return null
}

function cleanText(value: unknown) {
  return String(value ?? "").trim()
}

function buildParticipantName(p: any) {
  const full = [cleanText(p?.firstName), cleanText(p?.middleName), cleanText(p?.lastName)]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()

  return full || cleanText(p?.name) || "—"
}

function mapParticipantForAdminResponse(p: any) {
  const mobile = cleanText(p?.mobileNumber)

  return {
    id: String(p._id),
    _id: String(p._id),
    name: buildParticipantName(p),
    email: mobile ? `Mobile: ${mobile}` : "—",
    role: normalizeParticipantRole(p?.type ?? p?.role) ?? "GUEST",
    active: Boolean(p?.active),
    assignedTransactionManager: null,
    assignedDepartment: p?.department ? String(p.department) : null,
    assignedDepartments: p?.department ? [String(p.department)] : [],
    assignedWindow: null,
  }
}

function assignParticipantName(participant: any, displayName: string) {
  const cleaned = String(displayName ?? "").trim()
  const parts = cleaned.split(/\s+/).filter(Boolean)

  if (parts.length === 0) return

  if (parts.length === 1) {
    participant.firstName = parts[0]
    participant.middleName = ""
    participant.lastName = ""
  } else if (parts.length === 2) {
    participant.firstName = parts[0]
    participant.middleName = ""
    participant.lastName = parts[1]
  } else {
    participant.firstName = parts[0]
    participant.lastName = parts[parts.length - 1]
    participant.middleName = parts.slice(1, -1).join(" ")
  }

  participant.name = cleaned
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

function requireManagerKey(value: unknown, fieldName = "transactionManager"): { value?: string; error?: string } {
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

function extractWindowDepartmentIds(windowDoc: any): string[] {
  if (!windowDoc) return []
  const arr = Array.isArray(windowDoc.departmentIds) ? (windowDoc.departmentIds as any[]).map((v) => String(v)) : []
  const single = windowDoc.department ? [String(windowDoc.department)] : []
  return uniqueStringIds([...arr, ...single])
}

function readUserDepartmentIds(userDoc: any): string[] {
  return uniqueStringIds([
    ...(Array.isArray(userDoc?.assignedDepartments) ? (userDoc.assignedDepartments as any[]).map((v) => String(v)) : []),
    userDoc?.assignedDepartment ? String(userDoc.assignedDepartment) : "",
  ])
}

function mapUserForAdminResponse(u: any) {
  const assignedDepartments = readUserDepartmentIds(u)

  return {
    id: String(u._id),
    _id: String(u._id),
    name: u.name,
    email: typeof u.email === "string" ? u.email : "",
    role: u.role,
    active: Boolean(u.active),

    assignedTransactionManager: cleanManager((u as any).assignedTransactionManager),
    assignedDepartment: assignedDepartments[0] ?? null,
    assignedDepartments,
    assignedWindow: cleanId((u as any).assignedWindow),
  }
}

type ResolvedStaffAssignment = {
  departmentIds: string[]
  windowId: string | null
  transactionManager: string | null
}

async function resolveStaffAssignment(input: {
  currentDepartmentIds: string[]
  currentWindowId: string | null
  currentTransactionManager: string | null

  hasDepartmentIdPatch: boolean
  hasDepartmentIdsPatch: boolean
  hasWindowIdPatch: boolean
  hasTransactionManagerPatch: boolean

  departmentId?: unknown
  departmentIds?: unknown
  windowId?: unknown
  transactionManager?: unknown
}): Promise<{ value?: ResolvedStaffAssignment; error?: string }> {
  let nextDepartmentIds = uniqueStringIds(input.currentDepartmentIds)
  let nextWindowId = cleanId(input.currentWindowId)
  let nextTransactionManager = cleanManager(input.currentTransactionManager)

  // departmentIds patch
  if (input.hasDepartmentIdsPatch) {
    const depArrayParsed = parseDepartmentIdArray(input.departmentIds, "departmentIds")
    if (depArrayParsed.error) return { error: depArrayParsed.error }
    nextDepartmentIds = depArrayParsed.value
  }

  // departmentId patch
  if (input.hasDepartmentIdPatch) {
    const depParsed = parseObjectId(input.departmentId, "departmentId")
    if (depParsed.error) return { error: depParsed.error }

    if (depParsed.value) {
      if (input.hasDepartmentIdsPatch) {
        nextDepartmentIds = uniqueStringIds([...nextDepartmentIds, String(depParsed.value)])
      } else {
        nextDepartmentIds = [String(depParsed.value)]
      }
    } else if (!input.hasDepartmentIdsPatch) {
      // explicit null/empty for single field, and no array patch => clear all
      nextDepartmentIds = []
    }
  }

  // window patch
  if (input.hasWindowIdPatch) {
    const winParsed = parseObjectId(input.windowId, "windowId")
    if (winParsed.error) return { error: winParsed.error }
    nextWindowId = winParsed.value ? String(winParsed.value) : null
  }

  // transactionManager patch
  if (input.hasTransactionManagerPatch) {
    const managerRaw = input.transactionManager
    if (managerRaw === null || managerRaw === undefined || String(managerRaw).trim() === "") {
      nextTransactionManager = null
    } else {
      const m = cleanManager(managerRaw)
      if (!m) return { error: "transactionManager is invalid" }
      nextTransactionManager = m
    }
  }

  // If window is assigned, merge window departments into staff departments.
  if (nextWindowId) {
    const win = await ServiceWindowModel.findById(nextWindowId).select("_id enabled department departmentIds").lean()

    if (!win) return { error: "windowId is invalid" }
    if ((win as any).enabled === false) return { error: "Cannot assign staff to a disabled window" }

    const winDepIds = extractWindowDepartmentIds(win)
    if (winDepIds.length === 0) {
      return { error: "Selected window has no departments configured" }
    }

    nextDepartmentIds = uniqueStringIds([...nextDepartmentIds, ...winDepIds])
  }

  // Validate department IDs and manager compatibility.
  if (nextDepartmentIds.length > 0) {
    const depDocs = await DepartmentModel.find({ _id: { $in: nextDepartmentIds } })
      .select("_id transactionManager enabled")
      .lean()

    const depById = new Map<string, any>()
    for (const d of depDocs as any[]) depById.set(String(d._id), d)

    if (depById.size !== nextDepartmentIds.length) {
      return { error: "One or more departmentIds are invalid" }
    }

    const managers = new Set<string>()
    for (const depId of nextDepartmentIds) {
      const dep = depById.get(depId)
      if (!dep) return { error: `Invalid departmentId: ${depId}` }
      if (dep.enabled === false) return { error: `Department is disabled: ${depId}` }

      const depManager = cleanManager(dep.transactionManager)
      if (!depManager) return { error: `Department has no transactionManager: ${depId}` }
      managers.add(depManager)
    }

    if (managers.size > 1) {
      return {
        error: "All assigned departments for one staff must belong to the same transaction manager",
      }
    }

    const onlyManager = Array.from(managers)[0] ?? null

    if (nextTransactionManager && onlyManager && nextTransactionManager !== onlyManager) {
      return {
        error: `transactionManager ${nextTransactionManager} does not match department manager ${onlyManager}`,
      }
    }

    if (!nextTransactionManager && onlyManager) {
      nextTransactionManager = onlyManager
    }
  }

  return {
    value: {
      departmentIds: nextDepartmentIds,
      windowId: nextWindowId,
      transactionManager: nextTransactionManager,
    },
  }
}

function toObjectId(id: string | Types.ObjectId) {
  return id instanceof Types.ObjectId ? id : new Types.ObjectId(id)
}

async function persistStaffAssignment(userId: string | Types.ObjectId, assignment: ResolvedStaffAssignment) {
  const uid = toObjectId(userId)

  const depObjectIds = assignment.departmentIds.map((id) => new Types.ObjectId(id))
  const primaryDepartment = depObjectIds[0] ?? null
  const windowObjectId = assignment.windowId ? new Types.ObjectId(assignment.windowId) : null

  await UserModel.collection.updateOne(
    { _id: uid },
    {
      $set: {
        assignedDepartment: primaryDepartment,
        assignedDepartments: depObjectIds,
        assignedWindow: windowObjectId,
        assignedTransactionManager: assignment.transactionManager ?? null,
      },
    } as any,
  )

  // Enforce one STAFF per window.
  if (windowObjectId) {
    await UserModel.collection.updateMany(
      {
        _id: { $ne: uid },
        role: "STAFF",
        assignedWindow: windowObjectId,
      } as any,
      {
        $set: { assignedWindow: null },
      } as any,
    )
  }
}

async function clearStaffAssignment(userId: string | Types.ObjectId) {
  const uid = toObjectId(userId)

  await UserModel.collection.updateOne(
    { _id: uid },
    {
      $set: {
        assignedDepartment: null,
        assignedDepartments: [],
        assignedWindow: null,
        assignedTransactionManager: null,
      },
    } as any,
  )
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

    const [windowCount, purposeRows, staffCount] = await Promise.all([
      ServiceWindowModel.countDocuments({
        $or: [{ department: parsed.value }, { departmentIds: parsed.value }],
      } as any),
      listTransactionDefinitions({
        includeDisabled: true,
        departmentId: String(parsed.value),
        matchDepartmentOrGlobal: true,
      }),
      UserModel.collection.countDocuments({
        role: "STAFF",
        $or: [{ assignedDepartment: parsed.value }, { assignedDepartments: parsed.value }],
      } as any),
    ])

    const purposeCount = (purposeRows || []).filter((p: any) =>
      Array.isArray(p?.departmentIds) ? p.departmentIds.includes(String(parsed.value)) : false,
    ).length

    if (windowCount > 0 || purposeCount > 0 || staffCount > 0) {
      return res.status(409).json({
        message: "Department cannot be deleted while it is referenced by windows, staff assignments, or transaction purposes.",
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

    const nextDepartmentIds: string[] = Array.isArray(patch.departmentIds) ? patch.departmentIds : [...(existing.departmentIds || [])]

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

    const selectedDepartmentIds = uniqueStringIds([...depArrayParsed.value, deptParsed.value ? String(deptParsed.value) : ""])

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
        departmentIds: hasDepartmentIdsPatch ? parseDepartmentIdArray(departmentIds, "departmentIds").value : undefined,
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

    const assignedStaffCount = await UserModel.collection.countDocuments({
      role: "STAFF",
      assignedWindow: win._id,
    } as any)

    if (assignedStaffCount > 0) {
      return res.status(409).json({
        message: "Window cannot be deleted while staff accounts are assigned to it.",
        references: { staff: assignedStaffCount },
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
    // Return ALL user and participant records so Admin Accounts page can display every account type.
    const [users, participants] = await Promise.all([
      UserModel.find({}).select("-passwordHash -passwordSalt -passwordIterations -passwordAlgo").sort({ createdAt: -1 }).lean(),
      ParticipantModel.find({}).select("-pinHash -pinSalt -pinIterations -pinAlgo").sort({ createdAt: -1 }).lean(),
    ])

    const fromUsers = (users as any[]).map((u) => mapUserForAdminResponse(u))
    const fromParticipants = (participants as any[]).map((p) => mapParticipantForAdminResponse(p))

    const staff = [...fromUsers, ...fromParticipants].sort((a, b) => {
      if (a.active === b.active) return String(a.name).localeCompare(String(b.name))
      return a.active ? -1 : 1
    })

    return res.json({ staff })
  },

  createStaff: async (req: Request, res: Response) => {
    const body = req.body || {}
    const { name, email, password } = body
    const roleRaw = body.role
    const role: UserRole = isRole(roleRaw) ? roleRaw : "STAFF"

    if (!name || !email || !password) {
      return res.status(400).json({ message: "name, email, password are required" })
    }

    const normalizedEmail = normalizeEmail(email)
    const existing = await UserModel.findOne({ email: normalizedEmail })
    if (existing) return res.status(409).json({ message: "Email already exists" })

    // Resolve assignment first so we fail before creating user if invalid.
    const hasDepartmentIdPatch = Object.prototype.hasOwnProperty.call(body, "departmentId")
    const hasDepartmentIdsPatch = Object.prototype.hasOwnProperty.call(body, "departmentIds")
    const hasWindowIdPatch = Object.prototype.hasOwnProperty.call(body, "windowId")
    const hasTransactionManagerPatch = Object.prototype.hasOwnProperty.call(body, "transactionManager")

    let resolvedAssignment: ResolvedStaffAssignment = {
      departmentIds: [],
      windowId: null,
      transactionManager: null,
    }

    if (role === "STAFF") {
      const resolved = await resolveStaffAssignment({
        currentDepartmentIds: [],
        currentWindowId: null,
        currentTransactionManager: null,

        hasDepartmentIdPatch,
        hasDepartmentIdsPatch,
        hasWindowIdPatch,
        hasTransactionManagerPatch,

        departmentId: body.departmentId,
        departmentIds: body.departmentIds,
        windowId: body.windowId,
        transactionManager: body.transactionManager,
      })
      if (resolved.error) return res.status(400).json({ message: resolved.error })
      resolvedAssignment = resolved.value!
    }

    const { salt, hash, algo, iterations } = await hashPassword(String(password))

    const userPayload: any = {
      name: String(name).trim(),
      email: normalizedEmail,
      role,
      active: true,

      passwordSalt: salt,
      passwordHash: hash,
      passwordAlgo: algo,
      passwordIterations: iterations,
    }

    const user = await UserModel.create(userPayload)

    if (role === "STAFF") {
      await persistStaffAssignment(user._id as any, resolvedAssignment)
    } else {
      await clearStaffAssignment(user._id as any)
    }

    const refreshed = await UserModel.findById(user._id).select("-passwordHash -passwordSalt -passwordIterations -passwordAlgo").lean()

    await AuditLogModel.create({
      ...actor(req),
      action: "ADMIN_CREATE_USER",
      entityType: "User",
      entityId: user._id as any,
      meta: {
        role,
        assignment:
          role === "STAFF"
            ? {
                transactionManager: resolvedAssignment.transactionManager,
                departmentIds: resolvedAssignment.departmentIds,
                windowId: resolvedAssignment.windowId,
              }
            : undefined,
      },
    })

    return res.status(201).json({
      staff: mapUserForAdminResponse(refreshed ?? user),
    })
  },

  updateStaff: async (req: Request, res: Response) => {
    const { id } = req.params
    const body = req.body || {}
    const { name, active, password } = body

    const roleRaw = body.role
    if (roleRaw !== undefined && !isAccountRole(roleRaw)) {
      return res.status(400).json({ message: "role must be ADMIN, STAFF, STUDENT, ALUMNI_VISITOR, or GUEST" })
    }
    const nextRole: UserRole | undefined = isAccountRole(roleRaw) ? roleRaw : undefined

    const hasDepartmentIdPatch = Object.prototype.hasOwnProperty.call(body, "departmentId")
    const hasDepartmentIdsPatch = Object.prototype.hasOwnProperty.call(body, "departmentIds")
    const hasWindowIdPatch = Object.prototype.hasOwnProperty.call(body, "windowId")
    const hasTransactionManagerPatch = Object.prototype.hasOwnProperty.call(body, "transactionManager")

    const user = await UserModel.findById(id)

    // Participant fallback for STUDENT / ALUMNI_VISITOR / GUEST records
    if (!user) {
      const participant = await ParticipantModel.findById(id)
      if (!participant) return res.status(404).json({ message: "User not found" })

      if (name !== undefined) {
        const displayName = String(name).trim()
        if (!displayName) return res.status(400).json({ message: "name cannot be empty" })
        assignParticipantName(participant as any, displayName)
      }

      if (active !== undefined) {
        ;(participant as any).active = Boolean(active)
      }

      if (roleRaw !== undefined) {
        const participantRole = normalizeParticipantRole(roleRaw)
        if (!participantRole || !isParticipantRole(participantRole)) {
          return res.status(400).json({ message: "Participant role must be STUDENT, ALUMNI_VISITOR, or GUEST" })
        }

        ;(participant as any).type = participantRole
        if (Object.prototype.hasOwnProperty.call(participant.toObject?.() ?? {}, "role")) {
          ;(participant as any).role = participantRole
        }
      }

      if (password) {
        const { salt, hash, algo, iterations } = await hashPassword(String(password))
        ;(participant as any).pinSalt = salt
        ;(participant as any).pinHash = hash
        ;(participant as any).pinAlgo = algo
        ;(participant as any).pinIterations = iterations
      }

      await (participant as any).save()

      const refreshedParticipant = await ParticipantModel.findById((participant as any)._id)
        .select("-pinHash -pinSalt -pinIterations -pinAlgo")
        .lean()

      await AuditLogModel.create({
        ...actor(req),
        action: "ADMIN_UPDATE_PARTICIPANT",
        entityType: "Participant",
        entityId: (participant as any)._id as any,
        meta: {
          name,
          active,
          role: roleRaw,
          credentialChanged: Boolean(password),
        },
      })

      return res.json({
        staff: mapParticipantForAdminResponse(refreshedParticipant ?? participant),
      })
    }

    const effectiveRole: UserRole = nextRole ?? user.role

    let resolvedAssignment: ResolvedStaffAssignment | null = null
    const shouldResolveAssignment =
      effectiveRole === "STAFF" &&
      (user.role !== "STAFF" || hasDepartmentIdPatch || hasDepartmentIdsPatch || hasWindowIdPatch || hasTransactionManagerPatch)

    if (shouldResolveAssignment) {
      const resolved = await resolveStaffAssignment({
        currentDepartmentIds: user.role === "STAFF" ? readUserDepartmentIds(user) : [],
        currentWindowId: user.role === "STAFF" ? cleanId((user as any).assignedWindow) : null,
        currentTransactionManager: user.role === "STAFF" ? cleanManager((user as any).assignedTransactionManager) : null,

        hasDepartmentIdPatch,
        hasDepartmentIdsPatch,
        hasWindowIdPatch,
        hasTransactionManagerPatch,

        departmentId: body.departmentId,
        departmentIds: body.departmentIds,
        windowId: body.windowId,
        transactionManager: body.transactionManager,
      })

      if (resolved.error) return res.status(400).json({ message: resolved.error })
      resolvedAssignment = resolved.value!
    }

    if (name !== undefined) user.name = String(name).trim()
    if (active !== undefined) user.active = Boolean(active)

    if (nextRole) {
      user.role = nextRole
    }

    if (password) {
      const { salt, hash, algo, iterations } = await hashPassword(String(password))
      user.passwordSalt = salt
      user.passwordHash = hash
      user.passwordAlgo = algo
      user.passwordIterations = iterations
    }

    await user.save()

    // Persist / clear assignments with collection-level update so it works even if schema paths changed.
    if (effectiveRole === "STAFF") {
      if (resolvedAssignment) {
        await persistStaffAssignment(user._id as any, resolvedAssignment)
      }
    } else {
      await clearStaffAssignment(user._id as any)
    }

    const refreshed = await UserModel.findById(user._id).select("-passwordHash -passwordSalt -passwordIterations -passwordAlgo").lean()

    await AuditLogModel.create({
      ...actor(req),
      action: "ADMIN_UPDATE_USER",
      entityType: "User",
      entityId: user._id as any,
      meta: {
        name,
        active,
        role: nextRole,
        passwordChanged: Boolean(password),
        assignmentPatched: hasDepartmentIdPatch || hasDepartmentIdsPatch || hasWindowIdPatch || hasTransactionManagerPatch,
        assignment:
          resolvedAssignment && effectiveRole === "STAFF"
            ? {
                transactionManager: resolvedAssignment.transactionManager,
                departmentIds: resolvedAssignment.departmentIds,
                windowId: resolvedAssignment.windowId,
              }
            : undefined,
      },
    })

    return res.json({
      staff: mapUserForAdminResponse(refreshed ?? user),
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

    if (!user) {
      const participant = await ParticipantModel.findById(id)
      if (!participant) return res.status(404).json({ message: "User not found" })

      await ParticipantModel.deleteOne({ _id: (participant as any)._id })

      await AuditLogModel.create({
        ...actor(req),
        action: "ADMIN_DELETE_PARTICIPANT",
        entityType: "Participant",
        entityId: (participant as any)._id as any,
        meta: {
          deletedType: (participant as any).type ?? null,
          deletedMobile: cleanText((participant as any).mobileNumber),
        },
      })

      return res.json({ ok: true })
    }

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
      $cond: [{ $and: [{ $ne: ["$calledAt", null] }, { $ne: ["$waitingSince", null] }] }, { $subtract: ["$calledAt", "$waitingSince"] }, null],
    }

    const serviceMsExpr = {
      $cond: [{ $and: [{ $ne: ["$servedAt", null] }, { $ne: ["$calledAt", null] }] }, { $subtract: ["$servedAt", "$calledAt"] }, null],
    }

    const [agg] = await TicketModel.aggregate([
      { $match: match },
      {
        $facet: {
          total: [{ $count: "count" }],
          byStatus: [{ $group: { _id: "$status", count: { $sum: 1 } } }, { $sort: { _id: 1 } }],
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

    const rows: Array<{ _id: { dateKey: string; status: TicketStatus }; count: number }> = await TicketModel.aggregate([
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
      actorId: l.actor?._id ? String(l.actor._id) : l.actor ? String(l.actor) : null,
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
