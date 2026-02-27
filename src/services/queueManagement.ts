import { Types } from "mongoose"
import { AuditLogModel } from "../models/AuditLog"
import { DepartmentModel, type DepartmentDoc } from "../models/Department"
import { QueueCounterModel } from "../models/QueueCounter"
import { ServiceWindowModel, type ServiceWindowDoc } from "../models/ServiceWindow"
import { SettingModel, type SettingDoc } from "../models/Setting"
import { TicketModel, type TicketParticipantType, type TicketStatus } from "../models/Ticket"
import { UserModel, type UserDoc, type UserRole } from "../models/User"

type WithId<T> = T & { _id: Types.ObjectId }

type DepartmentLean = WithId<DepartmentDoc>
type ServiceWindowLean = WithId<ServiceWindowDoc>

function isPopulatedDoc<T extends { _id: unknown }>(v: unknown): v is T {
    return Boolean(v && typeof v === "object" && "_id" in (v as any))
}

export type AuthActor = {
    _id?: Types.ObjectId | string
    role?: UserRole
    name?: string

    // participant fields (optional, depending on your auth middleware)
    tcNumber?: string
    studentId?: string
    mobileNumber?: string
    phone?: string
    departmentId?: Types.ObjectId | string

    // staff assignment fields (optional)
    assignedDepartment?: Types.ObjectId | string
    assignedDepartments?: (Types.ObjectId | string)[]
    assignedWindow?: Types.ObjectId | string
    assignedTransactionManager?: string
}

export type ManagerKey = string

export type QueueTicketCreateInput = {
    // If participant is logged-in, department is locked to their profile (if present).
    departmentId?: string

    // participant identity (fallback if not logged-in)
    studentId?: string
    phone?: string
    participantType?: TicketParticipantType

    // transaction context
    transactionCategory?: string
    transactionKey?: string
    transactionLabel?: string
    purpose?: string
}

export type QueueStateQuery = {
    dateKey?: string
    manager?: string
    departmentId?: string
    windowId?: string
}

export type Announcement = {
    id: string
    createdAt: string
    ticketId: string
    queueNumber: number
    departmentName: string
    windowNumber?: number
    windowName?: string
    participantName?: string
    participantType?: TicketParticipantType
    voiceText: string
}

export type TicketView = {
    id: string
    dateKey: string
    queueNumber: number
    status: TicketStatus

    department: { id: string; name: string; code?: string; transactionManager: string }
    participant: {
        studentId: string
        name?: string
        phone?: string
        type?: TicketParticipantType
    }

    transaction?: {
        category?: string
        key?: string
        label?: string
        purpose?: string
    }

    window?: { id: string; name: string; number: number }

    holdAttempts: number
    waitingSince: string
    calledAt?: string
    servedAt?: string
    outAt?: string

    createdAt: string
    updatedAt: string
}

export type PublicDisplayState = {
    manager: string
    serverTime: string
    dateKey: string

    windows: Array<{
        id: string
        name: string
        number: number
        enabled: boolean
        departments: Array<{ id: string; name: string; code?: string }>
        nowServing?: TicketView
    }>

    // helpful for landing page UI
    departments: Array<{ id: string; name: string; code?: string }>

    // up next tickets across this manager (deduped, user-friendly)
    upNext: TicketView[]

    announcements: Announcement[]
}

export type StaffQueueState = {
    serverTime: string
    dateKey: string

    scope: {
        manager?: string
        departmentId?: string
        windowId?: string
        departmentIds?: string[]
    }

    settings: Pick<SettingDoc, "upNextCount" | "maxHoldAttempts" | "disallowDuplicateActiveTickets">

    // if scoped to window, show what that window is serving
    nowServing?: TicketView

    // consolidated views (names first, still contains ids)
    waiting: TicketView[]
    hold: TicketView[]
    called: TicketView[]
    upNext: TicketView[]
}

class HttpError extends Error {
    status: number
    code: string
    meta?: Record<string, unknown>
    constructor(status: number, code: string, message: string, meta?: Record<string, unknown>) {
        super(message)
        this.status = status
        this.code = code
        this.meta = meta
    }
}

function asObjectId(id: string, fieldName: string) {
    if (!Types.ObjectId.isValid(id)) throw new HttpError(400, "INVALID_ID", `Invalid ${fieldName}.`)
    return new Types.ObjectId(id)
}

function normalizeManagerKey(v?: string): string | undefined {
    const s = String(v ?? "").trim()
    if (!s) return undefined
    return s.toUpperCase()
}

/**
 * Date key for “per-day queue” logic. Uses Asia/Manila to match your campus flow.
 * Example: "2026-02-26"
 */
export function getDateKey(now = new Date()): string {
    return now.toLocaleDateString("en-CA", { timeZone: "Asia/Manila" })
}

async function getOrCreateSettings(): Promise<SettingDoc> {
    const doc = await SettingModel.findOne().lean<WithId<SettingDoc>>().exec()
    if (doc) return doc

    const created = await SettingModel.create({})
    return created.toObject() as SettingDoc
}

async function updateSettings(patch: Partial<Pick<SettingDoc, "maxHoldAttempts" | "disallowDuplicateActiveTickets" | "upNextCount">>) {
    const existing = await SettingModel.findOne().exec()
    if (!existing) {
        const created = await SettingModel.create(patch)
        return created.toObject() as SettingDoc
    }
    if (typeof patch.maxHoldAttempts === "number") existing.maxHoldAttempts = patch.maxHoldAttempts
    if (typeof patch.disallowDuplicateActiveTickets === "boolean")
        existing.disallowDuplicateActiveTickets = patch.disallowDuplicateActiveTickets
    if (typeof patch.upNextCount === "number") existing.upNextCount = patch.upNextCount

    await existing.save()
    return existing.toObject() as SettingDoc
}

async function audit(actor: AuthActor | undefined, action: string, entityType?: string, entityId?: Types.ObjectId, meta?: Record<string, unknown>) {
    const actorId =
        actor?._id && Types.ObjectId.isValid(String(actor._id)) ? new Types.ObjectId(String(actor._id)) : undefined
    const actorRole =
        actor?.role === "ADMIN" || actor?.role === "STAFF" ? (actor.role as "ADMIN" | "STAFF") : undefined

    await AuditLogModel.create({
        actor: actorId,
        actorRole,
        action,
        entityType,
        entityId,
        meta,
        createdAt: new Date(),
    })
}

function pickParticipantDisplayName(u?: Partial<UserDoc> | null): string | undefined {
    if (!u) return undefined
    const n = String(u.name ?? "").trim()
    if (n) return n
    const composed = [u.firstName, u.middleName, u.lastName].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ")
    return composed || undefined
}

function pickParticipantStudentId(actorOrInput: { tcNumber?: string; studentId?: string } | undefined, fallback?: string) {
    const a = actorOrInput ?? {}
    const v = String(a.studentId ?? a.tcNumber ?? fallback ?? "").trim()
    if (!v) throw new HttpError(400, "MISSING_STUDENT_ID", "Student ID is required.")
    return v
}

async function hydrateParticipantMap(studentIds: string[]) {
    const unique = Array.from(new Set(studentIds.map((s) => String(s).trim()).filter(Boolean)))
    if (!unique.length) return new Map<string, { name?: string; phone?: string; type?: TicketParticipantType }>()

    const users = await UserModel.find({
        $or: [{ tcNumber: { $in: unique } }, { studentId: { $in: unique } }],
    })
        .select("name firstName middleName lastName tcNumber studentId mobileNumber phone type role")
        .lean<UserDoc[]>()
        .exec()

    const map = new Map<string, { name?: string; phone?: string; type?: TicketParticipantType }>()
    for (const u of users) {
        const sid = String(u.studentId ?? u.tcNumber ?? "").trim()
        if (!sid) continue
        map.set(sid, {
            name: pickParticipantDisplayName(u),
            phone: String(u.phone ?? u.mobileNumber ?? "").trim() || undefined,
            type: (u.type ?? (u.role as TicketParticipantType)) as TicketParticipantType | undefined,
        })
    }
    return map
}

function toTicketView(t: any): TicketView {
    const depObj = isPopulatedDoc<DepartmentLean>(t.department) ? (t.department as DepartmentLean) : undefined
    const winObj = isPopulatedDoc<ServiceWindowLean>(t.window) ? (t.window as ServiceWindowLean) : undefined

    const departmentId = depObj?._id ? String(depObj._id) : String(t.department)
    const departmentName = String(depObj?.name ?? "").trim() || "Department"
    const departmentCode = depObj?.code ? String(depObj.code) : undefined
    const transactionManager = String(depObj?.transactionManager ?? "").trim()

    return {
        id: String(t._id),
        dateKey: String(t.dateKey),
        queueNumber: Number(t.queueNumber),
        status: t.status as TicketStatus,

        department: {
            id: departmentId,
            name: departmentName,
            code: departmentCode,
            transactionManager,
        },

        participant: {
            studentId: String(t.studentId),
            name: t.__participantName ? String(t.__participantName) : undefined,
            phone: t.phone ? String(t.phone) : undefined,
            type: t.participantType ? (t.participantType as TicketParticipantType) : undefined,
        },

        transaction: {
            category: t.transactionCategory ? String(t.transactionCategory) : undefined,
            key: t.transactionKey ? String(t.transactionKey) : undefined,
            label: t.transactionLabel ? String(t.transactionLabel) : undefined,
            purpose: t.purpose ? String(t.purpose) : undefined,
        },

        window: winObj?._id
            ? { id: String(winObj._id), name: String(winObj.name ?? "Window"), number: Number(winObj.number ?? t.windowNumber) }
            : t.window
              ? { id: String(t.window), name: "Window", number: Number(t.windowNumber ?? 0) }
              : undefined,

        holdAttempts: Number(t.holdAttempts ?? 0),
        waitingSince: new Date(t.waitingSince).toISOString(),
        calledAt: t.calledAt ? new Date(t.calledAt).toISOString() : undefined,
        servedAt: t.servedAt ? new Date(t.servedAt).toISOString() : undefined,
        outAt: t.outAt ? new Date(t.outAt).toISOString() : undefined,

        createdAt: new Date(t.createdAt).toISOString(),
        updatedAt: new Date(t.updatedAt).toISOString(),
    }
}

async function attachParticipantNames(tickets: any[]) {
    const studentIds = tickets.map((t) => String(t.studentId))
    const map = await hydrateParticipantMap(studentIds)
    for (const t of tickets) {
        const sid = String(t.studentId)
        const info = map.get(sid)
        if (info?.name) t.__participantName = info.name
        if (!t.phone && info?.phone) t.phone = info.phone
        if (!t.participantType && info?.type) t.participantType = info.type
    }
}

async function nextQueueNumber(departmentId: Types.ObjectId, dateKey: string): Promise<number> {
    const counter = await QueueCounterModel.findOneAndUpdate(
        { department: departmentId, dateKey },
        { $inc: { seq: 1 } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    )
        .lean<{ seq: number }>()
        .exec()

    return Number(counter?.seq ?? 1)
}

async function resolveDepartmentOrFail(departmentId: string): Promise<DepartmentLean> {
    const depId = asObjectId(departmentId, "departmentId")
    const dep = await DepartmentModel.findById(depId).lean<DepartmentLean>().exec()
    if (!dep || !dep.enabled) throw new HttpError(404, "DEPARTMENT_NOT_FOUND", "Department not found or disabled.")
    return dep
}

async function resolveWindowOrFail(windowId: string): Promise<ServiceWindowLean> {
    const winId = asObjectId(windowId, "windowId")
    const win = await ServiceWindowModel.findById(winId).lean<ServiceWindowLean>().exec()
    if (!win || !win.enabled) throw new HttpError(404, "WINDOW_NOT_FOUND", "Service window not found or disabled.")
    return win
}

/**
 * PUBLIC: Managers list for landing page filter (dropdown/tabs).
 */
export async function listManagers(): Promise<string[]> {
    const managers = await DepartmentModel.distinct("transactionManager", { enabled: true }).exec()
    return managers.map((m) => String(m).trim()).filter(Boolean).sort((a, b) => a.localeCompare(b))
}

/**
 * PUBLIC: Departments under a given manager (names first).
 */
export async function listDepartmentsByManager(manager: string) {
    const key = normalizeManagerKey(manager)
    if (!key) throw new HttpError(400, "MISSING_MANAGER", "Manager is required.")
    const deps = await DepartmentModel.find({ enabled: true, transactionManager: key })
        .select("_id name code transactionManager")
        .sort({ name: 1 })
        .lean<DepartmentLean[]>()
        .exec()

    return deps.map((d) => ({
        id: String(d._id),
        name: d.name,
        code: d.code,
        transactionManager: d.transactionManager,
    }))
}

/**
 * PUBLIC: Windows under a manager (windows can belong to multiple departments).
 */
export async function listWindowsByManager(manager: string) {
    const key = normalizeManagerKey(manager)
    if (!key) throw new HttpError(400, "MISSING_MANAGER", "Manager is required.")

    const deps = await DepartmentModel.find({ enabled: true, transactionManager: key })
        .select("_id name code")
        .lean<(Pick<DepartmentDoc, "name" | "code"> & { _id: Types.ObjectId })[]>()
        .exec()

    const depIdSet = new Set(deps.map((d) => String(d._id)))
    const depMap = new Map(deps.map((d) => [String(d._id), { id: String(d._id), name: d.name, code: d.code }]))

    const wins = await ServiceWindowModel.find({
        enabled: true,
        $or: [{ department: { $in: deps.map((d) => d._id) } }, { departmentIds: { $in: deps.map((d) => d._id) } }],
    })
        .select("name number enabled department departmentIds")
        .sort({ number: 1, name: 1 })
        .lean<ServiceWindowLean[]>()
        .exec()

    return wins.map((w) => {
        const ids = (w.departmentIds?.length ? w.departmentIds : [w.department]).map((x) => String(x))
        const departments = ids.filter((id) => depIdSet.has(id)).map((id) => depMap.get(id)!).filter(Boolean)

        return { id: String(w._id), name: w.name, number: w.number, enabled: w.enabled, departments }
    })
}

/**
 * SETTINGS
 */
export async function getQueueSettings() {
    return getOrCreateSettings()
}

export async function patchQueueSettings(
    actor: AuthActor | undefined,
    patch: Partial<Pick<SettingDoc, "maxHoldAttempts" | "disallowDuplicateActiveTickets" | "upNextCount">>
) {
    const updated = await updateSettings(patch)
    await audit(actor, "QUEUE_SETTINGS_UPDATED", "Setting", undefined, patch as any)
    return updated
}

/**
 * STUDENT/PARTICIPANT: Create a ticket with centralized, duplicate-safe queue number generation.
 * - Locks department to participant profile (if present) to prevent abuse.
 * - Blocks duplicate active tickets if Setting.disallowDuplicateActiveTickets = true.
 */
export async function createTicket(actor: AuthActor | undefined, input: QueueTicketCreateInput) {
    const settings = await getOrCreateSettings()
    const dateKey = getDateKey()

    const participantRole = actor?.role === "STUDENT" || actor?.role === "ALUMNI_VISITOR" || actor?.role === "GUEST"
    const profileDeptId =
        actor?.departmentId && Types.ObjectId.isValid(String(actor.departmentId)) ? String(actor.departmentId) : undefined

    // ✅ lock department after registration (if participant has departmentId)
    const requestedDept = String(input.departmentId ?? "").trim()
    const departmentIdToUse = profileDeptId || requestedDept
    if (!departmentIdToUse) throw new HttpError(400, "MISSING_DEPARTMENT", "Department is required.")
    const dep = await resolveDepartmentOrFail(departmentIdToUse)

    const studentId = pickParticipantStudentId(actor, input.studentId)
    const phone = String(input.phone ?? actor?.phone ?? actor?.mobileNumber ?? "").trim() || undefined
    const participantType: TicketParticipantType | undefined =
        input.participantType || (participantRole ? (actor?.role as TicketParticipantType) : undefined) || undefined

    if (settings.disallowDuplicateActiveTickets) {
        const existing = await TicketModel.findOne({
            studentId,
            dateKey,
            status: { $in: ["WAITING", "CALLED", "HOLD"] },
        })
            .select("_id")
            .lean()
            .exec()

        if (existing) {
            throw new HttpError(
                409,
                "DUPLICATE_ACTIVE_TICKET",
                "You already have an active queue ticket today. Please wait for your turn."
            )
        }
    }

    // Centralized & duplicate-safe queue number generation + insert retry
    const departmentObjectId = dep._id
    let created: any | null = null

    for (let attempt = 0; attempt < 3; attempt++) {
        const queueNumber = await nextQueueNumber(departmentObjectId, dateKey)

        try {
            created = await TicketModel.create({
                department: departmentObjectId,
                dateKey,
                queueNumber,

                studentId,
                phone,
                participantType,

                transactionCategory: input.transactionCategory ? String(input.transactionCategory).trim().toUpperCase() : undefined,
                transactionKey: input.transactionKey ? String(input.transactionKey).trim().toLowerCase() : undefined,
                transactionLabel: input.transactionLabel ? String(input.transactionLabel).trim() : undefined,
                purpose: input.purpose ? String(input.purpose).trim() : undefined,

                status: "WAITING",
                holdAttempts: 0,
                waitingSince: new Date(),
            })

            break
        } catch (err: any) {
            if (err?.code === 11000) continue
            throw err
        }
    }

    if (!created) throw new HttpError(500, "TICKET_CREATE_FAILED", "Failed to create ticket. Please try again.")

    await audit(actor, "TICKET_CREATED", "Ticket", created._id, {
        dateKey,
        queueNumber: created.queueNumber,
        departmentId: String(dep._id),
        departmentName: dep.name,
        studentId,
        participantType,
        transactionKey: input.transactionKey,
    })

    const populated = await TicketModel.findById(created._id)
        .populate("department", "name code transactionManager")
        .populate("window", "name number")
        .lean()
        .exec()

    if (!populated) throw new HttpError(500, "TICKET_CREATE_FAILED", "Ticket created but not found.")

    await attachParticipantNames([populated])
    return toTicketView(populated)
}

/**
 * STAFF: Polling state (every 2–3 seconds) for dashboard synchronization.
 * - Works per manager, department, or window scope.
 * - Ensures every staff window sees the same centralized queue DB state.
 */
export async function getStaffQueueState(actor: AuthActor | undefined, query: QueueStateQuery): Promise<StaffQueueState> {
    const settings = await getOrCreateSettings()
    const dateKey = String(query.dateKey ?? getDateKey()).trim()

    const manager = normalizeManagerKey(query.manager)
    const departmentId = query.departmentId ? asObjectId(query.departmentId, "departmentId") : undefined
    const windowId = query.windowId ? asObjectId(query.windowId, "windowId") : undefined

    let scopedDepartmentIds: Types.ObjectId[] = []

    if (windowId) {
        const win = await ServiceWindowModel.findById(windowId).lean<ServiceWindowLean>().exec()
        if (!win) throw new HttpError(404, "WINDOW_NOT_FOUND", "Service window not found.")
        const ids = (win.departmentIds?.length ? win.departmentIds : [win.department]).filter(Boolean)
        scopedDepartmentIds = ids.map((x) => new Types.ObjectId(String(x)))
    } else if (departmentId) {
        scopedDepartmentIds = [departmentId]
    } else if (manager) {
        const deps = await DepartmentModel.find({ enabled: true, transactionManager: manager })
            .select("_id")
            .lean<{ _id: Types.ObjectId }[]>()
            .exec()
        scopedDepartmentIds = deps.map((d) => d._id)
    } else {
        const assigned = new Set<string>()
        if (actor?.assignedDepartment) assigned.add(String(actor.assignedDepartment))
        for (const d of actor?.assignedDepartments ?? []) assigned.add(String(d))
        scopedDepartmentIds = Array.from(assigned)
            .filter((id) => Types.ObjectId.isValid(id))
            .map((id) => new Types.ObjectId(id))
    }

    if (!scopedDepartmentIds.length) {
        throw new HttpError(400, "MISSING_SCOPE", "Please provide manager, departmentId, or windowId.")
    }

    const baseMatch: any = { dateKey, department: { $in: scopedDepartmentIds } }

    const [waiting, hold, called] = await Promise.all([
        TicketModel.find({ ...baseMatch, status: "WAITING" })
            .sort({ queueNumber: 1 })
            .limit(200)
            .populate("department", "name code transactionManager")
            .populate("window", "name number")
            .lean()
            .exec(),
        TicketModel.find({ ...baseMatch, status: "HOLD" })
            .sort({ updatedAt: 1 })
            .limit(200)
            .populate("department", "name code transactionManager")
            .populate("window", "name number")
            .lean()
            .exec(),
        TicketModel.find({ ...baseMatch, status: "CALLED" })
            .sort({ calledAt: -1 })
            .limit(200)
            .populate("department", "name code transactionManager")
            .populate("window", "name number")
            .lean()
            .exec(),
    ])

    const all = [...waiting, ...hold, ...called]
    await attachParticipantNames(all)

    const upNextCount = Number(settings.upNextCount ?? 5)
    const upNext = waiting.slice(0, upNextCount)

    let nowServing: any | undefined
    if (windowId) {
        nowServing = called.find((t: any) => String(t.window) === String(windowId)) || undefined
    }

    return {
        serverTime: new Date().toISOString(),
        dateKey,
        scope: {
            manager: manager || undefined,
            departmentId: departmentId ? String(departmentId) : undefined,
            windowId: windowId ? String(windowId) : undefined,
            departmentIds: scopedDepartmentIds.map((d) => String(d)),
        },
        settings: {
            upNextCount: Number(settings.upNextCount ?? 5),
            maxHoldAttempts: Number(settings.maxHoldAttempts ?? 4),
            disallowDuplicateActiveTickets: Boolean(settings.disallowDuplicateActiveTickets),
        },
        nowServing: nowServing ? toTicketView(nowServing) : undefined,
        waiting: waiting.map(toTicketView),
        hold: hold.map(toTicketView),
        called: called.map(toTicketView),
        upNext: upNext.map(toTicketView),
    }
}

async function ensureWindowHasNoActiveCall(windowId: Types.ObjectId, dateKey: string) {
    const existing = await TicketModel.findOne({
        dateKey,
        window: windowId,
        status: "CALLED",
    })
        .select("_id queueNumber")
        .lean()
        .exec()

    if (existing) {
        throw new HttpError(409, "WINDOW_ALREADY_SERVING", "This window is already serving a ticket.")
    }
}

/**
 * STAFF: Call the next queue ticket (centralized & race-safe).
 * - Uses findOneAndUpdate on WAITING sorted by queueNumber to prevent two staff from calling the same ticket.
 * - Writes an audit log entry that the Public Display can poll for announcements.
 */
export async function callNextQueue(actor: AuthActor | undefined, windowId: string) {
    const dateKey = getDateKey()
    const win = await resolveWindowOrFail(windowId)
    const winObjectId = asObjectId(windowId, "windowId")

    await ensureWindowHasNoActiveCall(winObjectId, dateKey)

    const departmentIds = (win.departmentIds?.length ? win.departmentIds : [win.department]).map(
        (x) => new Types.ObjectId(String(x))
    )

    const updated = await TicketModel.findOneAndUpdate(
        {
            dateKey,
            department: { $in: departmentIds },
            status: "WAITING",
        },
        {
            $set: {
                status: "CALLED",
                window: winObjectId,
                windowNumber: win.number,
                calledAt: new Date(),
            },
        },
        {
            new: true,
            sort: { queueNumber: 1 },
        }
    )
        .populate("department", "name code transactionManager")
        .populate("window", "name number")
        .lean()
        .exec()

    if (!updated) return null

    await attachParticipantNames([updated])
    const view = toTicketView(updated)

    const departmentName = view.department.name
    const participantName = view.participant.name
    const voiceTextParts = [
        `Now serving`,
        departmentName ? `for ${departmentName}` : "",
        `queue number ${view.queueNumber}.`,
        view.window?.number ? `Please proceed to window ${view.window.number}.` : "",
        participantName ? `Participant ${participantName}.` : "",
    ]
        .map((s) => String(s).trim())
        .filter(Boolean)

    const voiceText = voiceTextParts.join(" ")

    await audit(actor, "TICKET_CALLED", "Ticket", new Types.ObjectId(view.id), {
        ticketId: view.id,
        dateKey,
        queueNumber: view.queueNumber,
        departmentId: view.department.id,
        departmentName: view.department.name,
        windowId: view.window?.id,
        windowNumber: view.window?.number,
        windowName: view.window?.name,
        studentId: view.participant.studentId,
        participantName,
        participantType: view.participant.type,
        voiceText,
    })

    return view
}

/**
 * STAFF: Put a ticket on HOLD (with max attempts). If attempts exceeded, auto-OUT to prevent abuse.
 */
export async function holdTicket(actor: AuthActor | undefined, ticketId: string) {
    const settings = await getOrCreateSettings()
    const maxHold = Number(settings.maxHoldAttempts ?? 4)
    const id = asObjectId(ticketId, "ticketId")

    const ticket = await TicketModel.findById(id).exec()
    if (!ticket) throw new HttpError(404, "TICKET_NOT_FOUND", "Ticket not found.")

    if (ticket.status !== "CALLED") {
        throw new HttpError(409, "INVALID_STATUS", "Only CALLED tickets can be placed on HOLD.")
    }

    const nextAttempts = Number(ticket.holdAttempts ?? 0) + 1

    if (nextAttempts >= maxHold) {
        ticket.status = "OUT"
        ticket.outAt = new Date()
    } else {
        ticket.status = "HOLD"
    }

    ticket.holdAttempts = nextAttempts
    await ticket.save()

    await audit(actor, "TICKET_HOLD", "Ticket", id, {
        dateKey: ticket.dateKey,
        queueNumber: ticket.queueNumber,
        holdAttempts: ticket.holdAttempts,
        maxHoldAttempts: maxHold,
        finalStatus: ticket.status,
    })

    const populated = await TicketModel.findById(id)
        .populate("department", "name code transactionManager")
        .populate("window", "name number")
        .lean()
        .exec()

    if (!populated) throw new HttpError(500, "TICKET_UPDATE_FAILED", "Updated ticket not found.")
    await attachParticipantNames([populated])
    return toTicketView(populated)
}

/**
 * STAFF: Mark ticket as SERVED.
 */
export async function serveTicket(actor: AuthActor | undefined, ticketId: string) {
    const id = asObjectId(ticketId, "ticketId")
    const ticket = await TicketModel.findById(id).exec()
    if (!ticket) throw new HttpError(404, "TICKET_NOT_FOUND", "Ticket not found.")

    if (ticket.status !== "CALLED") throw new HttpError(409, "INVALID_STATUS", "Only CALLED tickets can be served.")

    ticket.status = "SERVED"
    ticket.servedAt = new Date()
    await ticket.save()

    await audit(actor, "TICKET_SERVED", "Ticket", id, {
        dateKey: ticket.dateKey,
        queueNumber: ticket.queueNumber,
        windowNumber: ticket.windowNumber,
    })

    const populated = await TicketModel.findById(id)
        .populate("department", "name code transactionManager")
        .populate("window", "name number")
        .lean()
        .exec()

    if (!populated) throw new HttpError(500, "TICKET_UPDATE_FAILED", "Updated ticket not found.")
    await attachParticipantNames([populated])
    return toTicketView(populated)
}

/**
 * STAFF: Mark ticket as OUT (no-show, cancelled, etc.)
 */
export async function outTicket(actor: AuthActor | undefined, ticketId: string, reason?: string) {
    const id = asObjectId(ticketId, "ticketId")
    const ticket = await TicketModel.findById(id).exec()
    if (!ticket) throw new HttpError(404, "TICKET_NOT_FOUND", "Ticket not found.")

    if (!["WAITING", "CALLED", "HOLD"].includes(ticket.status)) {
        throw new HttpError(409, "INVALID_STATUS", "Only active tickets can be marked OUT.")
    }

    ticket.status = "OUT"
    ticket.outAt = new Date()
    await ticket.save()

    await audit(actor, "TICKET_OUT", "Ticket", id, {
        dateKey: ticket.dateKey,
        queueNumber: ticket.queueNumber,
        windowNumber: ticket.windowNumber,
        reason: reason ? String(reason).trim() : undefined,
    })

    const populated = await TicketModel.findById(id)
        .populate("department", "name code transactionManager")
        .populate("window", "name number")
        .lean()
        .exec()

    if (!populated) throw new HttpError(500, "TICKET_UPDATE_FAILED", "Updated ticket not found.")
    await attachParticipantNames([populated])
    return toTicketView(populated)
}

async function getAnnouncements(manager: string, sinceIso?: string): Promise<Announcement[]> {
    const since = sinceIso ? new Date(sinceIso) : undefined
    if (sinceIso && String(since).includes("Invalid")) throw new HttpError(400, "INVALID_SINCE", "Invalid 'since' timestamp.")

    const match: any = { action: "TICKET_CALLED" }
    if (since) match.createdAt = { $gt: since }

    const logs = await AuditLogModel.find(match)
        .sort({ createdAt: -1 })
        .limit(50)
        .lean()
        .exec()

    const departmentIds = logs
        .map((l: any) => String(l?.meta?.departmentId ?? "").trim())
        .filter((id) => Types.ObjectId.isValid(id))

    const deps = await DepartmentModel.find({ _id: { $in: departmentIds }, transactionManager: manager })
        .select("_id name transactionManager")
        .lean<DepartmentLean[]>()
        .exec()

    const allowed = new Set(deps.map((d) => String(d._id)))

    const out: Announcement[] = []
    for (const l of logs) {
        const meta = (l as any).meta ?? {}
        const depId = String(meta.departmentId ?? "").trim()
        if (!allowed.has(depId)) continue

        out.push({
            id: String((l as any)._id),
            createdAt: new Date((l as any).createdAt).toISOString(),
            ticketId: String(meta.ticketId ?? meta.entityId ?? meta.ticketId ?? ""),
            queueNumber: Number(meta.queueNumber ?? 0),
            departmentName: String(meta.departmentName ?? ""),
            windowNumber: meta.windowNumber != null ? Number(meta.windowNumber) : undefined,
            windowName: meta.windowName ? String(meta.windowName) : undefined,
            participantName: meta.participantName ? String(meta.participantName) : undefined,
            participantType: meta.participantType ? (meta.participantType as TicketParticipantType) : undefined,
            voiceText: String(meta.voiceText ?? "").trim() || "Now serving.",
        })
    }

    return out.reverse()
}

/**
 * PUBLIC DISPLAY: Centralized state (landing page general display + manager switch)
 * Poll every 2–3 seconds.
 */
export async function getPublicDisplayState(manager: string, sinceIso?: string): Promise<PublicDisplayState> {
    const key = normalizeManagerKey(manager)
    if (!key) throw new HttpError(400, "MISSING_MANAGER", "Manager is required.")
    const dateKey = getDateKey()

    const deps = await DepartmentModel.find({ enabled: true, transactionManager: key })
        .select("_id name code transactionManager")
        .sort({ name: 1 })
        .lean<DepartmentLean[]>()
        .exec()

    const depIds = deps.map((d) => d._id)
    const depMap = new Map(deps.map((d) => [String(d._id), d]))

    const wins = await ServiceWindowModel.find({
        enabled: true,
        $or: [{ department: { $in: depIds } }, { departmentIds: { $in: depIds } }],
    })
        .select("_id name number enabled department departmentIds")
        .sort({ number: 1, name: 1 })
        .lean<ServiceWindowLean[]>()
        .exec()

    const calledTickets = await TicketModel.find({
        dateKey,
        status: "CALLED",
        department: { $in: depIds },
    })
        .populate("department", "name code transactionManager")
        .populate("window", "name number")
        .lean()
        .exec()

    const waitingTickets = await TicketModel.find({
        dateKey,
        status: "WAITING",
        department: { $in: depIds },
    })
        .sort({ queueNumber: 1 })
        .limit(200)
        .populate("department", "name code transactionManager")
        .populate("window", "name number")
        .lean()
        .exec()

    const all = [...calledTickets, ...waitingTickets]
    await attachParticipantNames(all)

    const calledByWindow = new Map<string, any>()
    for (const t of calledTickets) {
        const w = t.window ? String(t.window) : ""
        if (!w) continue
        if (!calledByWindow.has(w)) calledByWindow.set(w, t)
        else {
            const prev = calledByWindow.get(w)
            const prevAt = prev?.calledAt ? new Date(prev.calledAt).getTime() : 0
            const curAt = t?.calledAt ? new Date(t.calledAt).getTime() : 0
            if (curAt > prevAt) calledByWindow.set(w, t)
        }
    }

    const upNext = waitingTickets.slice(0, 10).map(toTicketView)

    const windows = wins.map((w) => {
        const ids = (w.departmentIds?.length ? w.departmentIds : [w.department]).map((x) => String(x))
        const departments = ids
            .map((id) => depMap.get(id))
            .filter(Boolean)
            .map((d) => ({ id: String((d as DepartmentLean)._id), name: (d as DepartmentLean).name, code: (d as DepartmentLean).code }))

        const nowServing = calledByWindow.get(String(w._id))
        return {
            id: String(w._id),
            name: w.name,
            number: w.number,
            enabled: w.enabled,
            departments,
            nowServing: nowServing ? toTicketView(nowServing) : undefined,
        }
    })

    const announcements = await getAnnouncements(key, sinceIso)

    return {
        manager: key,
        serverTime: new Date().toISOString(),
        dateKey,
        windows,
        departments: deps.map((d) => ({ id: String(d._id), name: d.name, code: d.code })),
        upNext,
        announcements,
    }
}

/**
 * Utility: expose HttpError type guards for controllers.
 */
export function isHttpError(err: any): err is HttpError {
    return Boolean(err && typeof err === "object" && typeof err.status === "number" && typeof err.code === "string")
}
export function toPublicError(err: any) {
    if (isHttpError(err)) {
        return { status: err.status, code: err.code, message: err.message, meta: err.meta }
    }
    return { status: 500, code: "INTERNAL_ERROR", message: "Something went wrong." }
}