import type { Request, Response } from "express"
import { Types } from "mongoose"

import { AuditLogModel } from "../models/AuditLog"
import { DepartmentModel } from "../models/Department"
import { ServiceWindowModel } from "../models/ServiceWindow"
import { SettingModel } from "../models/Setting"
import { TicketModel } from "../models/Ticket"
import { UserModel } from "../models/User"

import {
    getDateKeyManila,
    getDepartmentWindowAssignments,
    TicketTransactionSelectionModel,
} from "../services/queue.service"

function todayKey() {
    return getDateKeyManila()
}

function normalizeKey(v?: string) {
    return (v || "").trim().toUpperCase()
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

function normalizeIdString(value: unknown): string | null {
    if (value === null || value === undefined) return null

    if (typeof value === "string") {
        const s = value.trim()
        return s || null
    }

    if (value instanceof Types.ObjectId) {
        return String(value)
    }

    if (typeof value === "object") {
        const maybeId = (value as any)?._id
        if (maybeId) return normalizeIdString(maybeId)

        const str = String(value)
        if (str && str !== "[object Object]") return str
        return null
    }

    const s = String(value).trim()
    return s || null
}

type ParticipantType = "STUDENT" | "ALUMNI_VISITOR" | "GUEST"

function normalizeParticipantType(value: unknown): ParticipantType | null {
    const raw = String(value ?? "").trim().toUpperCase()
    if (!raw) return null

    if (raw === "STUDENT") return "STUDENT"
    if (raw === "GUEST") return "GUEST"
    if (raw === "ALUMNI_VISITOR" || raw === "ALUMNI/VISITOR" || raw === "ALUMNI" || raw === "VISITOR") {
        return "ALUMNI_VISITOR"
    }

    return null
}

function participantTypeLabel(value: ParticipantType | null | undefined): string | null {
    if (!value) return null
    if (value === "STUDENT") return "Student"
    if (value === "ALUMNI_VISITOR") return "Alumni / Visitor"
    if (value === "GUEST") return "Guest"
    return null
}

function humanizeTransactionKey(value: string) {
    return value
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase()
        .replace(/\b\w/g, (m) => m.toUpperCase())
}

function extractStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return []
    const out: string[] = []
    const seen = new Set<string>()

    for (const item of value) {
        const s = String(item ?? "").trim()
        if (!s || seen.has(s)) continue
        seen.add(s)
        out.push(s)
    }

    return out
}

function firstNonEmptyText(candidates: unknown[]): string {
    for (const candidate of candidates) {
        const text = String(candidate ?? "").trim()
        if (text) return text
    }
    return ""
}

function buildPersonFullName(personLike: any): string {
    /**
     * ✅ Match queue.service.ts behavior:
     * Prefer explicit name parts when available, then fallback to name, then fullName/displayName.
     */
    const first = String(personLike?.firstName ?? "").trim()
    const middle = String(personLike?.middleName ?? "").trim()
    const last = String(personLike?.lastName ?? "").trim()

    const composed = [first, middle, last].filter(Boolean).join(" ").trim()
    if (composed) return composed

    const name = String(personLike?.name ?? "").trim()
    if (name) return name

    const fullName = String(personLike?.fullName ?? personLike?.displayName ?? "").trim()
    if (fullName) return fullName

    return ""
}

function isLikelyHumanName(label: string, identifier?: string) {
    const s = String(label ?? "").trim()
    if (!s) return false
    if (identifier && s === String(identifier).trim()) return false

    const lower = s.toLowerCase()
    const reject = new Set(["student", "alumni / visitor", "alumni/visitor", "guest", "participant"])
    if (reject.has(lower)) return false

    // phone-like / numeric identifiers
    if (/^\+?\d[\d\s()-]{6,}$/.test(s)) return false
    if (!/[a-z]/i.test(s)) return false

    return true
}

function resolveQueuePurpose(ticket: any): string | null {
    // 1) Array label candidates (most readable)
    const arrayLabelCandidates = [
        ticket?.transactionLabels,
        ticket?.selectedTransactionLabels,
        ticket?.meta?.transactionLabels,
        ticket?.transactions?.transactionLabels,
        ticket?.transactions?.labels,
        ticket?.selection?.transactionLabels,
        ticket?.join?.transactionLabels,
    ]

    for (const candidate of arrayLabelCandidates) {
        const labels = extractStringArray(candidate)
        if (labels.length) return labels.join(" • ")
    }

    // 2) Array-of-object candidates
    const objectArrayCandidates = [
        ticket?.selectedTransactions,
        ticket?.transactionSelections,
        ticket?.transactions?.items,
        ticket?.transactions?.selected,
    ]

    for (const candidate of objectArrayCandidates) {
        if (!Array.isArray(candidate)) continue

        const labels = candidate
            .map((item: any) =>
                String(
                    item?.label ??
                    item?.name ??
                    item?.title ??
                    item?.transactionLabel ??
                    "",
                ).trim(),
            )
            .filter(Boolean)

        if (labels.length) return uniqueStringIds(labels).join(" • ")
    }

    // 3) Direct string candidates
    const direct = firstNonEmptyText([
        ticket?.queuePurpose,
        ticket?.purpose,
        ticket?.transactionLabel,
        ticket?.transaction?.label,
        ticket?.transactionName,
        ticket?.transactionTitle,
        ticket?.meta?.purpose,
        ticket?.meta?.transactionLabel,
        ticket?.transactionCategory,
        ticket?.meta?.transactionCategory,
    ])

    if (direct) return direct

    // 4) Key arrays -> humanized labels
    const keyArrayCandidates = [
        ticket?.transactionKeys,
        ticket?.selectedTransactionKeys,
        ticket?.meta?.transactionKeys,
        ticket?.transactions?.transactionKeys,
        ticket?.selection?.transactionKeys,
        ticket?.join?.transactionKeys,
    ]

    for (const candidate of keyArrayCandidates) {
        const keys = extractStringArray(candidate).map((k) => humanizeTransactionKey(k)).filter(Boolean)
        if (keys.length) return uniqueStringIds(keys).join(" • ")
    }

    // 5) Single key fallback
    const rawKey = firstNonEmptyText([
        ticket?.transactionKey,
        ticket?.transaction?.key,
        ticket?.meta?.transactionKey,
        ticket?.transactionCode,
    ])

    if (rawKey) return humanizeTransactionKey(rawKey)

    return null
}

function asObjectIdOrString(id: string) {
    try {
        return new Types.ObjectId(id)
    } catch {
        return id
    }
}

function staffCtx(req: Request) {
    const u = (req as any).user || {}

    const assignedDepartmentIds = Array.isArray(u.assignedDepartments)
        ? u.assignedDepartments.map((v: any) => String(v ?? "").trim()).filter(Boolean)
        : []

    return {
        staffId: String(u.id || ""),
        departmentId: String(u.assignedDepartment || ""),
        assignedDepartmentIds,
        windowId: String(u.assignedWindow || ""),
        assignedTransactionManager: String(u.assignedTransactionManager || ""),
        actor: u?.id,
        actorRole: u?.role,
    }
}

function parseLimit(req: Request, fallback = 25) {
    const raw = req.query.limit
    const n = typeof raw === "string" ? Number(raw) : Array.isArray(raw) ? Number(raw[0]) : NaN
    if (!Number.isFinite(n)) return fallback
    return Math.max(1, Math.min(100, Math.floor(n)))
}

function parseBool(v: unknown): boolean {
    if (typeof v === "boolean") return v
    if (typeof v !== "string") return false
    const s = v.trim().toLowerCase()
    return s === "1" || s === "true" || s === "yes" || s === "y" || s === "on"
}

function parseYmd(v: unknown, fallback: string) {
    const raw = typeof v === "string" ? v : Array.isArray(v) ? String(v[0] ?? "") : ""
    const s = raw.trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
    return fallback
}

function toPlainObject<T = any>(doc: T): any {
    if (doc && typeof (doc as any).toObject === "function") {
        return (doc as any).toObject()
    }
    return doc
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

async function resolveHandledDepartmentIds(departmentIds: string[], windowNumber?: number) {
    const fallbackIds = uniqueStringIds(departmentIds)

    if (!windowNumber) return fallbackIds

    const assignments = getDepartmentWindowAssignments()
    const groupCodes = assignments[windowNumber]
    if (!groupCodes?.length) return fallbackIds

    const enabledDepartments = await DepartmentModel.find({ enabled: true }).select("_id code name").lean()
    const normalizedCodes = new Set(groupCodes.map((c) => normalizeKey(c)))

    const ids = (enabledDepartments as any[])
        .filter((d) => normalizedCodes.has(normalizeKey(d.code || d.name)))
        .map((d) => String(d._id))

    return uniqueStringIds([...ids, ...fallbackIds])
}

function inHandledDepartments(ticketDepartment: unknown, handledDepartmentIds: string[]) {
    const value = String(ticketDepartment || "")
    if (!value) return false

    const set = new Set(handledDepartmentIds.map((id) => String(id)))
    return set.has(value)
}

function mapDepartmentPayload(row: any) {
    return {
        id: String(row?._id || ""),
        name: row?.name ? String(row.name) : "—",
        code: row?.code ? String(row.code) : null,
        transactionManager: row?.transactionManager ? String(row.transactionManager) : null,
        enabled: row?.enabled !== false,
    }
}

function mapWindowPayload(row: any) {
    if (!row) return null

    const id = String(row?._id || row?.id || "").trim()
    const departmentId = normalizeIdString(row?.department)
    const departmentIds = uniqueStringIds([
        ...(Array.isArray(row?.departmentIds) ? row.departmentIds.map((v: any) => String(v ?? "")) : []),
        departmentId || "",
    ])

    return {
        _id: id,
        id,
        name: row?.name ? String(row.name) : "Window",
        number: typeof row?.number === "number" ? Number(row.number) : Number(row?.number || 0),
        department: departmentId,
        departmentIds,
        enabled: row?.enabled !== false,
    }
}

function toWindowKeyById(windowId: unknown) {
    const id = normalizeIdString(windowId)
    return id ? `id:${id}` : null
}

function toWindowKeyByNumber(windowNumber: unknown) {
    const n = typeof windowNumber === "number" ? windowNumber : Number(windowNumber)
    if (!Number.isFinite(n)) return null
    return `num:${Math.floor(n)}`
}

function hasHandledDepartments(scope: { handledDepartmentIds?: string[] }) {
    return Array.isArray(scope.handledDepartmentIds) && scope.handledDepartmentIds.length > 0
}

async function enrichTickets(tickets: any[]) {
    const plainTickets = tickets.map((t) => toPlainObject(t))

    const ticketIds = uniqueStringIds(
        plainTickets
            .map((t) => normalizeIdString(t?._id))
            .filter((v): v is string => Boolean(v)),
    )

    const departmentIds = uniqueStringIds(
        plainTickets
            .map((t) => normalizeIdString(t?.department))
            .filter((v): v is string => Boolean(v)),
    )

    const windowIds = uniqueStringIds(
        plainTickets
            .map((t) => normalizeIdString(t?.window))
            .filter((v): v is string => Boolean(v)),
    )

    const studentIds = uniqueStringIds(
        plainTickets
            .map((t) => String(t?.studentId ?? "").trim())
            .filter(Boolean),
    )

    const [departmentRows, windowRows, participantRows, transactionSelectionRows] = await Promise.all([
        departmentIds.length
            ? DepartmentModel.find({ _id: { $in: departmentIds } }).select("_id name code").lean()
            : Promise.resolve([] as any[]),
        windowIds.length
            ? ServiceWindowModel.find({ _id: { $in: windowIds } }).select("_id name number").lean()
            : Promise.resolve([] as any[]),
        studentIds.length
            ? UserModel.find({
                $or: [{ studentId: { $in: studentIds } }, { tcNumber: { $in: studentIds } }],
            })
                // ✅ include fullName/displayName for compatibility with schemas that use them
                .select("_id name firstName middleName lastName fullName displayName role type studentId tcNumber")
                .lean()
            : Promise.resolve([] as any[]),
        ticketIds.length
            ? (TicketTransactionSelectionModel as any)
                .find({
                    ticket: { $in: ticketIds.map((id) => asObjectIdOrString(id)) },
                })
                .select("ticket participant participantType transactionKeys transactionLabels")
                // ✅ align with queue.service.ts populate fields so full names resolve reliably
                .populate({ path: "participant", select: "name firstName middleName lastName fullName displayName" })
                .lean()
            : Promise.resolve([] as any[]),
    ])

    const departmentMap = new Map<string, any>()
    for (const row of departmentRows as any[]) {
        departmentMap.set(String(row._id), row)
    }

    const windowMap = new Map<string, any>()
    for (const row of windowRows as any[]) {
        windowMap.set(String(row._id), row)
    }

    // ✅ Identity -> participant type AND full name (Students often live here)
    const participantTypeByIdentity = new Map<string, ParticipantType>()
    const participantNameByIdentity = new Map<string, string>()

    for (const row of participantRows as any[]) {
        const normalized =
            normalizeParticipantType(row?.type) ||
            normalizeParticipantType(row?.role)

        const fullName = buildPersonFullName(row)

        const keys = uniqueStringIds([
            String(row?.studentId ?? ""),
            String(row?.tcNumber ?? ""),
        ])

        for (const key of keys) {
            if (normalized) participantTypeByIdentity.set(key, normalized)
            if (fullName) participantNameByIdentity.set(key, fullName)
        }
    }

    const txSelectionByTicketId = new Map<
        string,
        {
            participantType: ParticipantType | null
            transactionKeys: string[]
            transactionLabels: string[]
            participantId: string | null
            participantFullName: string | null
        }
    >()

    for (const row of transactionSelectionRows as any[]) {
        const tid = normalizeIdString(row?.ticket)
        if (!tid) continue

        const existing = txSelectionByTicketId.get(tid) || {
            participantType: null as ParticipantType | null,
            transactionKeys: [] as string[],
            transactionLabels: [] as string[],
            participantId: null as string | null,
            participantFullName: null as string | null,
        }

        const p = normalizeParticipantType(row?.participantType)
        if (!existing.participantType && p) {
            existing.participantType = p
        }

        const participantId = normalizeIdString(row?.participant) || normalizeIdString(row?.participant?._id)
        if (!existing.participantId && participantId) {
            existing.participantId = participantId
        }

        const selectionName = buildPersonFullName(row?.participant)
        if (!existing.participantFullName && selectionName) {
            existing.participantFullName = selectionName
        }

        existing.transactionKeys = uniqueStringIds([
            ...existing.transactionKeys,
            ...extractStringArray(row?.transactionKeys),
        ])

        existing.transactionLabels = uniqueStringIds([
            ...existing.transactionLabels,
            ...extractStringArray(row?.transactionLabels),
        ])

        txSelectionByTicketId.set(tid, existing)
    }

    return plainTickets.map((t: any) => {
        const id = normalizeIdString(t?._id)
        const departmentId = normalizeIdString(t?.department)
        const windowId = normalizeIdString(t?.window)
        const studentId = String(t?.studentId ?? "").trim()

        const dep = departmentId ? departmentMap.get(departmentId) : null
        const win = windowId ? windowMap.get(windowId) : null
        const txSelection = id ? txSelectionByTicketId.get(id) || null : null

        const mergedTransactionKeys = uniqueStringIds([
            ...extractStringArray(t?.transactionKeys),
            ...extractStringArray(t?.selectedTransactionKeys),
            ...extractStringArray(t?.transactions?.transactionKeys),
            ...(txSelection?.transactionKeys ?? []),
        ])

        const mergedTransactionLabels = uniqueStringIds([
            ...extractStringArray(t?.transactionLabels),
            ...extractStringArray(t?.selectedTransactionLabels),
            ...extractStringArray(t?.transactions?.transactionLabels),
            ...extractStringArray(t?.transactions?.labels),
            ...(txSelection?.transactionLabels ?? []),
        ])

        const explicitParticipantType =
            normalizeParticipantType(
                t?.participantType ??
                t?.transactions?.participantType ??
                t?.meta?.participantType ??
                t?.participant ??
                t?.userType ??
                t?.role,
            ) || null

        const participantType =
            explicitParticipantType ||
            txSelection?.participantType ||
            (studentId ? participantTypeByIdentity.get(studentId) || null : null)

        const ticketLabelRaw = String(t?.participantLabel ?? "").trim()
        const ticketLabelCandidate = isLikelyHumanName(ticketLabelRaw, studentId) ? ticketLabelRaw : ""

        // ✅ full name priority:
        // 1) TicketTransactionSelection participant (Alumni/Guest/Student)
        // 2) Ticket.participantLabel (now persisted on joinQueue)
        // 3) UserModel name lookup (Student)
        const participantFullName =
            firstNonEmptyText([
                txSelection?.participantFullName,
                ticketLabelCandidate,
                studentId ? participantNameByIdentity.get(studentId) : "",
            ]) || null

        const transactionsPayload = {
            ...(t?.transactions && typeof t.transactions === "object" ? t.transactions : {}),
            participantType: participantType || null,
            participantTypeLabel: participantTypeLabel(participantType || null),
            transactionKey:
                firstNonEmptyText([
                    t?.transactions?.transactionKey,
                    t?.transactionKey,
                    mergedTransactionKeys[0],
                ]) || null,
            transactionKeys: mergedTransactionKeys,
            transactionLabel:
                firstNonEmptyText([
                    t?.transactions?.transactionLabel,
                    t?.transactionLabel,
                    mergedTransactionLabels[0],
                ]) || null,
            transactionLabels: mergedTransactionLabels,
            labels: mergedTransactionLabels,
        }

        const queuePurpose = resolveQueuePurpose({
            ...t,
            transactionKeys: mergedTransactionKeys,
            selectedTransactionKeys: mergedTransactionKeys,
            transactionLabels: mergedTransactionLabels,
            selectedTransactionLabels: mergedTransactionLabels,
            transactions: transactionsPayload,
        })

        return {
            ...t,
            id: id || "",
            departmentId,
            departmentName: dep?.name ? String(dep.name) : null,
            departmentCode: dep?.code ? String(dep.code) : null,
            windowId,
            windowName: win?.name ? String(win.name) : null,

            participantType: participantType || null,

            // ✅ expose full name directly (best for UI)
            participantFullName,

            // ✅ participantLabel is what most UIs already render -> prefer full name
            participantLabel:
                firstNonEmptyText([
                    participantFullName || "",
                    t?.participantLabel,
                    t?.transactions?.participantTypeLabel,
                    t?.meta?.participantLabel,
                    participantTypeLabel(participantType || null),
                ]) || null,

            transactionKeys: mergedTransactionKeys,
            selectedTransactionKeys: mergedTransactionKeys,
            transactionLabels: mergedTransactionLabels,
            selectedTransactionLabels: mergedTransactionLabels,

            transactions: transactionsPayload,
            transactionSelections: txSelection
                ? [
                    {
                        ticket: id || null,
                        participant: txSelection.participantId,
                        participantType: txSelection.participantType,
                        participantFullName: txSelection.participantFullName,
                        transactionKeys: txSelection.transactionKeys,
                        transactionLabels: txSelection.transactionLabels,
                    },
                ]
                : t?.transactionSelections ?? [],

            queuePurpose: queuePurpose || null,
        }
    })
}

async function resolveStaffScope(req: Request) {
    const base = staffCtx(req)

    const staffUser = base.staffId
        ? await UserModel.findById(base.staffId)
            .select(
                "_id name email role active assignedDepartment assignedDepartments assignedWindow assignedTransactionManager",
            )
            .lean()
        : null

    const fromToken = uniqueStringIds([...base.assignedDepartmentIds, base.departmentId || ""])
    let assignedDepartmentIds = staffUser ? extractUserDepartmentIds(staffUser) : fromToken
    assignedDepartmentIds = uniqueStringIds(assignedDepartmentIds)

    const managerRaw = (staffUser as any)?.assignedTransactionManager || base.assignedTransactionManager || ""
    const assignedTransactionManager = normalizeKey(managerRaw) || null

    // Fallback: if no direct department assignments but a transaction manager is present,
    // use enabled departments under that manager.
    if (!assignedDepartmentIds.length && assignedTransactionManager) {
        const managerDepartments = await DepartmentModel.find({
            transactionManager: assignedTransactionManager,
            enabled: true,
        })
            .select("_id")
            .lean()

        assignedDepartmentIds = uniqueStringIds((managerDepartments as any[]).map((d) => String(d._id)))
    }

    let resolvedWindowId = normalizeIdString((staffUser as any)?.assignedWindow) || base.windowId || ""

    let window = resolvedWindowId
        ? await ServiceWindowModel.findById(resolvedWindowId)
            .select("_id name number enabled department departmentIds")
            .lean()
        : null

    // Fallback: when a window is not explicitly assigned but there are enabled matching windows,
    // auto-resolve deterministically to avoid false "not assigned to a window" failures.
    if (!window && assignedDepartmentIds.length) {
        const departmentObjectIds = assignedDepartmentIds.map((id) => asObjectIdOrString(id))

        const candidateWindows = await ServiceWindowModel.find({
            enabled: true,
            $or: [
                { department: { $in: departmentObjectIds } },
                { departmentIds: { $in: departmentObjectIds } },
            ],
        })
            .select("_id name number enabled department departmentIds")
            .sort({ number: 1, _id: 1 })
            .lean()

        const candidates = candidateWindows as any[]
        if (candidates.length) {
            const primaryDeptId = assignedDepartmentIds[0] || ""
            const matchingPrimary = primaryDeptId
                ? candidates.filter((w) => extractWindowDepartmentIds(w).includes(primaryDeptId))
                : []

            // Prefer windows that explicitly handle the primary department first.
            const picked = (matchingPrimary.length ? matchingPrimary : candidates)[0]
            window = picked
            resolvedWindowId = String(picked._id)
        }
    }

    const windowNumber = typeof (window as any)?.number === "number" ? Number((window as any).number) : undefined
    const windowDepartmentIds = extractWindowDepartmentIds(window)
    assignedDepartmentIds = uniqueStringIds([...assignedDepartmentIds, ...windowDepartmentIds])

    const handledDepartmentIds = await resolveHandledDepartmentIds(assignedDepartmentIds, windowNumber)
    const handledDepartmentObjectIds = handledDepartmentIds.map((id) => asObjectIdOrString(id))

    // If explicit assignments are empty, expose handled departments as effective assignments.
    const resolvedAssignedDepartmentIds = assignedDepartmentIds.length ? assignedDepartmentIds : handledDepartmentIds

    const [assignedDepartmentRows, handledDepartmentRows] = await Promise.all([
        resolvedAssignedDepartmentIds.length
            ? DepartmentModel.find({ _id: { $in: resolvedAssignedDepartmentIds } })
                .select("_id name code transactionManager enabled")
                .lean()
            : Promise.resolve([] as any[]),
        handledDepartmentIds.length
            ? DepartmentModel.find({ _id: { $in: handledDepartmentIds } })
                .select("_id name code transactionManager enabled")
                .lean()
            : Promise.resolve([] as any[]),
    ])

    const assignedDepartmentMap = new Map<string, any>()
    for (const row of assignedDepartmentRows as any[]) {
        assignedDepartmentMap.set(String(row._id), row)
    }

    const handledDepartmentMap = new Map<string, any>()
    for (const row of handledDepartmentRows as any[]) {
        handledDepartmentMap.set(String(row._id), row)
    }

    const assignedDepartments = resolvedAssignedDepartmentIds.map((id) => {
        const row = assignedDepartmentMap.get(id) || handledDepartmentMap.get(id)
        if (!row) {
            return {
                id,
                name: "—",
                code: null,
                transactionManager: null,
                enabled: true,
            }
        }
        return mapDepartmentPayload(row)
    })

    const handledDepartments = handledDepartmentIds.map((id) => {
        const row = handledDepartmentMap.get(id) || assignedDepartmentMap.get(id)
        if (!row) {
            return {
                id,
                name: "—",
                code: null,
                transactionManager: null,
                enabled: true,
            }
        }
        return mapDepartmentPayload(row)
    })

    const primaryDepartmentId = resolvedAssignedDepartmentIds[0] || handledDepartmentIds[0] || ""

    const primaryDepartmentRow =
        (primaryDepartmentId && assignedDepartmentMap.get(primaryDepartmentId)) ||
        (primaryDepartmentId && handledDepartmentMap.get(primaryDepartmentId)) ||
        null

    return {
        ...base,
        user: staffUser,
        departmentId: primaryDepartmentId,
        assignedDepartmentIds: resolvedAssignedDepartmentIds,
        assignedDepartments,
        assignedTransactionManager,
        windowId: resolvedWindowId,
        window,
        windowNumber,
        handledDepartmentIds,
        handledDepartmentObjectIds,
        handledDepartments,
        primaryDepartment: primaryDepartmentRow ? mapDepartmentPayload(primaryDepartmentRow) : null,
    }
}

export const staffController = {
    myAssignment: async (req: Request, res: Response) => {
        const scope = await resolveStaffScope(req)

        return res.json({
            departmentId: scope.departmentId || null,
            departmentName: scope.primaryDepartment?.name || null,
            assignedTransactionManager: scope.assignedTransactionManager || null,
            assignedDepartmentIds: scope.assignedDepartmentIds,
            assignedDepartments: scope.assignedDepartments,
            window: mapWindowPayload(scope.window),
            handledDepartmentIds: scope.handledDepartmentIds,
            handledDepartments: scope.handledDepartments,
        })
    },

    /**
     * GET /staff/display/snapshot
     * - Backend-integrated snapshot for the staff display page and presentation windows.
     * - Includes multi-window board payload grouped by the current staff manager scope.
     */
    displaySnapshot: async (req: Request, res: Response) => {
        const scope = await resolveStaffScope(req)
        if (!hasHandledDepartments(scope)) return res.status(400).json({ message: "Staff not assigned" })

        const dateKey = todayKey()

        const settings = await SettingModel.findOne({}).lean()
        const upNextCountRaw = Number((settings as any)?.upNextCount ?? 5)
        const upNextCount = Number.isFinite(upNextCountRaw)
            ? Math.max(1, Math.min(20, Math.floor(upNextCountRaw)))
            : 5

        const nowServingQuery: any = {
            department: { $in: scope.handledDepartmentObjectIds },
            dateKey,
            status: "CALLED",
        }

        const windowOr: any[] = []
        if (scope.windowId) windowOr.push({ window: asObjectIdOrString(scope.windowId) })
        if (typeof scope.windowNumber === "number") windowOr.push({ windowNumber: scope.windowNumber })
        if (windowOr.length) nowServingQuery.$or = windowOr

        const nowServingDoc = await TicketModel.findOne(nowServingQuery)
            .sort({ calledAt: -1, updatedAt: -1 })
            .select("_id queueNumber department window windowNumber calledAt studentId participantType participantLabel")
            .lean()

        const upNextDocs = await TicketModel.find({
            department: { $in: scope.handledDepartmentObjectIds },
            dateKey,
            status: "WAITING",
        })
            .sort({ queueNumber: 1, waitingSince: 1 })
            .limit(upNextCount)
            .select("_id queueNumber department studentId participantType participantLabel")
            .lean()

        const [nowServingEnriched] = nowServingDoc ? await enrichTickets([nowServingDoc]) : [null]
        const upNextEnriched = await enrichTickets(upNextDocs as any[])

        // ===== Multi-window board snapshot =====
        const handledDepartmentIdSet = new Set(scope.handledDepartmentIds.map((id) => String(id)))
        const handledDepartmentMap = new Map<string, any>()
        for (const dep of scope.handledDepartments || []) {
            if (!dep?.id) continue
            handledDepartmentMap.set(String(dep.id), dep)
        }

        const boardWindowRowsRaw = await ServiceWindowModel.find({
            enabled: true,
            $or: [
                { department: { $in: scope.handledDepartmentObjectIds } },
                { departmentIds: { $in: scope.handledDepartmentObjectIds } },
            ],
        })
            .select("_id name number enabled department departmentIds")
            .sort({ number: 1, name: 1, _id: 1 })
            .lean()

        const boardWindowMap = new Map<string, any>()
        for (const row of boardWindowRowsRaw as any[]) {
            const id = normalizeIdString((row as any)?._id)
            if (!id) continue
            boardWindowMap.set(id, row)
        }

        // Ensure the assigned window is still included even if temporarily disabled or not matched by filter.
        if (scope.window) {
            const assignedWindowId = normalizeIdString((scope.window as any)?._id)
            if (assignedWindowId && !boardWindowMap.has(assignedWindowId)) {
                boardWindowMap.set(assignedWindowId, scope.window)
            }
        }

        const boardWindowRows = Array.from(boardWindowMap.values()).sort((a: any, b: any) => {
            const na = typeof a?.number === "number" ? a.number : Number(a?.number ?? 0)
            const nb = typeof b?.number === "number" ? b.number : Number(b?.number ?? 0)
            if (na !== nb) return na - nb
            const sa = String(a?.name ?? "")
            const sb = String(b?.name ?? "")
            return sa.localeCompare(sb)
        })

        const boardCalledRows = await TicketModel.find({
            department: { $in: scope.handledDepartmentObjectIds },
            dateKey,
            status: "CALLED",
        })
            .sort({ calledAt: -1, updatedAt: -1 })
            .select("_id queueNumber department window windowNumber calledAt studentId participantType participantLabel")
            .lean()

        // ✅ enrich once so we can show participant full names across the board
        const boardCalledEnriched = await enrichTickets(boardCalledRows as any[])
        const boardCalledById = new Map<string, any>()
        for (const row of boardCalledEnriched as any[]) {
            const tid = normalizeIdString(row?.id ?? row?._id)
            if (tid) boardCalledById.set(tid, row)
        }

        const latestCalledByWindowKey = new Map<string, any>()
        for (const row of boardCalledRows as any[]) {
            const keyById = toWindowKeyById((row as any)?.window)
            const keyByNumber = toWindowKeyByNumber((row as any)?.windowNumber)

            if (keyById && !latestCalledByWindowKey.has(keyById)) {
                latestCalledByWindowKey.set(keyById, row)
            }
            if (keyByNumber && !latestCalledByWindowKey.has(keyByNumber)) {
                latestCalledByWindowKey.set(keyByNumber, row)
            }
        }

        const boardWindows = boardWindowRows.map((row: any) => {
            const win = mapWindowPayload(row)
            const windowId = win?.id || ""
            const windowNumber =
                typeof win?.number === "number" && Number.isFinite(win.number) ? Number(win.number) : 0

            const windowDepartmentIds = uniqueStringIds([
                ...(Array.isArray(win?.departmentIds) ? win!.departmentIds : []),
                win?.department || "",
            ]).filter((id) => handledDepartmentIdSet.has(id))

            const departments = windowDepartmentIds.map((id) => {
                const dep = handledDepartmentMap.get(id)
                return {
                    id,
                    name: dep?.name ? String(dep.name) : "—",
                    code: dep?.code ? String(dep.code) : null,
                }
            })

            const calledKeyById = toWindowKeyById(windowId)
            const calledKeyByNumber = toWindowKeyByNumber(windowNumber)

            const called =
                (calledKeyById ? latestCalledByWindowKey.get(calledKeyById) : null) ||
                (calledKeyByNumber ? latestCalledByWindowKey.get(calledKeyByNumber) : null) ||
                null

            const calledId = normalizeIdString((called as any)?._id)
            const calledEnriched = calledId ? boardCalledById.get(calledId) || null : null

            const calledDepartmentId = normalizeIdString((called as any)?.department)
            const calledDepartment = calledDepartmentId ? handledDepartmentMap.get(calledDepartmentId) : null

            return {
                id: windowId,
                name: win?.name || "Window",
                number: windowNumber,
                departmentIds: windowDepartmentIds,
                departments,
                nowServing: called
                    ? {
                        id: String((called as any)?._id || ""),
                        queueNumber: Number((called as any)?.queueNumber || 0),
                        departmentId: calledDepartmentId || null,
                        departmentName: calledDepartment?.name ? String(calledDepartment.name) : null,
                        departmentCode: calledDepartment?.code ? String(calledDepartment.code) : null,
                        participantFullName: (calledEnriched as any)?.participantFullName ?? null,
                        participantLabel: (calledEnriched as any)?.participantLabel ?? null,
                        participantType: (calledEnriched as any)?.participantType ?? null,
                        participantTypeLabel: (calledEnriched as any)?.transactions?.participantTypeLabel ?? null,
                        calledAt: (called as any)?.calledAt ? new Date((called as any).calledAt).toISOString() : null,
                    }
                    : null,
            }
        })

        return res.json({
            department: {
                id: scope.departmentId || null,
                name: scope.primaryDepartment?.name || "—",
                code: scope.primaryDepartment?.code || null,
                handledDepartmentIds: scope.handledDepartmentIds,
                handledDepartments: scope.handledDepartments,
            },
            window: mapWindowPayload(scope.window),
            nowServing: nowServingEnriched
                ? {
                    id: String((nowServingEnriched as any).id || ""),
                    queueNumber: Number((nowServingEnriched as any).queueNumber || 0),
                    departmentId: (nowServingEnriched as any).departmentId || null,
                    departmentName: (nowServingEnriched as any).departmentName || null,
                    departmentCode: (nowServingEnriched as any).departmentCode || null,
                    windowId: (nowServingEnriched as any).windowId || null,
                    windowName:
                        (nowServingEnriched as any).windowName ||
                        (scope.window ? String((scope.window as any).name || "") : null) ||
                        null,
                    windowNumber:
                        typeof (nowServingEnriched as any).windowNumber === "number"
                            ? Number((nowServingEnriched as any).windowNumber)
                            : typeof scope.windowNumber === "number"
                                ? scope.windowNumber
                                : null,
                    participantFullName: (nowServingEnriched as any).participantFullName ?? null,
                    participantLabel: (nowServingEnriched as any).participantLabel ?? null,
                    participantType: (nowServingEnriched as any).participantType ?? null,
                    participantTypeLabel: (nowServingEnriched as any)?.transactions?.participantTypeLabel ?? null,
                    calledAt: (nowServingEnriched as any).calledAt
                        ? new Date((nowServingEnriched as any).calledAt).toISOString()
                        : null,
                }
                : null,
            upNext: upNextEnriched.map((row: any) => ({
                id: String(row.id || row._id),
                queueNumber: Number(row.queueNumber || 0),
                departmentId: row.departmentId || null,
                departmentName: row.departmentName || null,
                departmentCode: row.departmentCode || null,
                participantFullName: row.participantFullName ?? null,
                participantLabel: row.participantLabel ?? null,
                participantType: row.participantType ?? null,
                participantTypeLabel: row?.transactions?.participantTypeLabel ?? null,
            })),
            board: {
                transactionManager: scope.assignedTransactionManager || null,
                minimumPanels: 3,
                recommendedPanels: Math.max(3, boardWindows.length || 0),
                windows: boardWindows,
            },
            meta: {
                generatedAt: new Date().toISOString(),
                refreshMs: 5000,
                upNextCount,
            },
        })
    },

    /**
     * GET /staff/queue/waiting?limit=25
     */
    listWaiting: async (req: Request, res: Response) => {
        const scope = await resolveStaffScope(req)
        if (!hasHandledDepartments(scope)) return res.status(400).json({ message: "Staff not assigned" })

        const limit = parseLimit(req, 25)
        const dateKey = todayKey()

        const rows = await TicketModel.find({
            department: { $in: scope.handledDepartmentObjectIds },
            dateKey,
            status: "WAITING",
        })
            .sort({ queueNumber: 1, waitingSince: 1 })
            .limit(limit)
            .lean()
            .exec()

        const tickets = await enrichTickets(rows as any[])

        return res.json({
            tickets,
            context: {
                window: mapWindowPayload(scope.window),
                handledDepartments: scope.handledDepartments,
            },
        })
    },

    /**
     * GET /staff/queue/hold?limit=25
     */
    listHold: async (req: Request, res: Response) => {
        const scope = await resolveStaffScope(req)
        if (!hasHandledDepartments(scope)) return res.status(400).json({ message: "Staff not assigned" })

        const limit = parseLimit(req, 25)
        const dateKey = todayKey()

        const rows = await TicketModel.find({
            department: { $in: scope.handledDepartmentObjectIds },
            dateKey,
            status: "HOLD",
        })
            .sort({ updatedAt: -1, queueNumber: 1 })
            .limit(limit)
            .lean()
            .exec()

        const tickets = await enrichTickets(rows as any[])

        return res.json({
            tickets,
            context: {
                window: mapWindowPayload(scope.window),
                handledDepartments: scope.handledDepartments,
            },
        })
    },

    /**
     * GET /staff/queue/out?limit=25
     */
    listOut: async (req: Request, res: Response) => {
        const scope = await resolveStaffScope(req)
        if (!hasHandledDepartments(scope)) return res.status(400).json({ message: "Staff not assigned" })

        const limit = parseLimit(req, 25)
        const dateKey = todayKey()

        const rows = await TicketModel.find({
            department: { $in: scope.handledDepartmentObjectIds },
            dateKey,
            status: "OUT",
        })
            .sort({ outAt: -1, updatedAt: -1 })
            .limit(limit)
            .lean()
            .exec()

        const tickets = await enrichTickets(rows as any[])

        return res.json({
            tickets,
            context: {
                window: mapWindowPayload(scope.window),
                handledDepartments: scope.handledDepartments,
            },
        })
    },

    /**
     * GET /staff/queue/history?limit=25&mine=1
     * - mine=1 filters to tickets called to the staff's assigned window
     */
    listHistory: async (req: Request, res: Response) => {
        const scope = await resolveStaffScope(req)
        if (!hasHandledDepartments(scope)) return res.status(400).json({ message: "Staff not assigned" })

        const mine = parseBool(req.query.mine)
        if (mine && !scope.windowId) return res.status(400).json({ message: "Staff not assigned to a window" })

        const limit = parseLimit(req, 25)
        const dateKey = todayKey()

        const query: any = {
            department: { $in: scope.handledDepartmentObjectIds },
            dateKey,
            status: { $in: ["CALLED", "SERVED", "OUT"] },
        }

        if (mine) {
            const or: any[] = [{ window: asObjectIdOrString(scope.windowId) }]
            if (typeof scope.windowNumber === "number") {
                or.push({ windowNumber: scope.windowNumber })
            }
            query.$or = or
        }

        const rows = await TicketModel.find(query).sort({ updatedAt: -1 }).limit(limit).lean().exec()
        const tickets = await enrichTickets(rows as any[])

        return res.json({
            tickets,
            context: {
                mine,
                window: mapWindowPayload(scope.window),
                handledDepartments: scope.handledDepartments,
            },
        })
    },

    callNext: async (req: Request, res: Response) => {
        const scope = await resolveStaffScope(req)
        if (!hasHandledDepartments(scope) || !scope.windowId) {
            return res.status(400).json({ message: "Staff not assigned" })
        }

        const win = await ServiceWindowModel.findById(scope.windowId)
        if (!win || !win.enabled) return res.status(400).json({ message: "Assigned window not found/disabled" })

        const dateKey = todayKey()

        const next = await TicketModel.findOne({
            department: { $in: scope.handledDepartmentObjectIds },
            dateKey,
            status: "WAITING",
        })
            .sort({ queueNumber: 1, waitingSince: 1 })
            .exec()

        if (!next) return res.status(404).json({ message: "No waiting tickets" })

        next.status = "CALLED"
        next.calledAt = new Date()
        next.window = win._id as any
        next.windowNumber = win.number
        await next.save()

        await AuditLogModel.create({
            actor: scope.actor,
            actorRole: scope.actorRole,
            action: "STAFF_CALL_NEXT",
            entityType: "Ticket",
            entityId: next._id as any,
            meta: {
                windowId: String(win._id),
                windowName: win.name,
                windowNumber: win.number,
            },
        })

        const [ticket] = await enrichTickets([next])

        return res.json({ ticket })
    },

    currentCalledForWindow: async (req: Request, res: Response) => {
        const scope = await resolveStaffScope(req)
        if (!hasHandledDepartments(scope) || !scope.windowId) {
            return res.status(400).json({ message: "Staff not assigned" })
        }

        const dateKey = todayKey()
        const query: any = {
            department: { $in: scope.handledDepartmentObjectIds },
            dateKey,
            status: "CALLED",
            $or: [{ window: asObjectIdOrString(scope.windowId) }],
        }

        if (typeof scope.windowNumber === "number") {
            query.$or.push({ windowNumber: scope.windowNumber })
        }

        const ticketRaw = await TicketModel.findOne(query).sort({ calledAt: -1, updatedAt: -1 }).lean()
        if (!ticketRaw) return res.json({ ticket: null })

        const [ticket] = await enrichTickets([ticketRaw])
        return res.json({ ticket: ticket || null })
    },

    markServed: async (req: Request, res: Response) => {
        const { id } = req.params
        const scope = await resolveStaffScope(req)
        if (!hasHandledDepartments(scope) || !scope.windowId) {
            return res.status(400).json({ message: "Staff not assigned" })
        }

        const ticket = await TicketModel.findById(id)
        if (!ticket) return res.status(404).json({ message: "Ticket not found" })
        if (!inHandledDepartments(ticket.department, scope.handledDepartmentIds)) {
            return res.status(403).json({ message: "Forbidden" })
        }

        ticket.status = "SERVED"
        ticket.servedAt = new Date()
        await ticket.save()

        await AuditLogModel.create({
            actor: scope.actor,
            actorRole: scope.actorRole,
            action: "STAFF_MARK_SERVED",
            entityType: "Ticket",
            entityId: ticket._id as any,
        })

        const [enrichedTicket] = await enrichTickets([ticket])

        return res.json({ ticket: enrichedTicket })
    },

    holdNoShow: async (req: Request, res: Response) => {
        const { id } = req.params
        const scope = await resolveStaffScope(req)
        if (!hasHandledDepartments(scope)) return res.status(400).json({ message: "Staff not assigned" })

        const settings = await SettingModel.findOne({})
        const maxHoldAttempts = settings?.maxHoldAttempts ?? 4

        const ticket = await TicketModel.findById(id)
        if (!ticket) return res.status(404).json({ message: "Ticket not found" })
        if (!inHandledDepartments(ticket.department, scope.handledDepartmentIds)) {
            return res.status(403).json({ message: "Forbidden" })
        }

        ticket.holdAttempts = (ticket.holdAttempts || 0) + 1

        if (ticket.holdAttempts >= maxHoldAttempts) {
            ticket.status = "OUT"
            ticket.outAt = new Date()
        } else {
            ticket.status = "HOLD"
        }

        await ticket.save()

        await AuditLogModel.create({
            actor: scope.actor,
            actorRole: scope.actorRole,
            action: "STAFF_HOLD_NO_SHOW",
            entityType: "Ticket",
            entityId: ticket._id as any,
            meta: { holdAttempts: ticket.holdAttempts, maxHoldAttempts },
        })

        const [enrichedTicket] = await enrichTickets([ticket])

        return res.json({ ticket: enrichedTicket })
    },

    returnFromHold: async (req: Request, res: Response) => {
        const { id } = req.params
        const scope = await resolveStaffScope(req)
        if (!hasHandledDepartments(scope)) return res.status(400).json({ message: "Staff not assigned" })

        const ticket = await TicketModel.findById(id)
        if (!ticket) return res.status(404).json({ message: "Ticket not found" })
        if (!inHandledDepartments(ticket.department, scope.handledDepartmentIds)) {
            return res.status(403).json({ message: "Forbidden" })
        }

        if (ticket.status !== "HOLD") return res.status(400).json({ message: "Ticket is not on HOLD" })

        ticket.status = "WAITING"
        ticket.waitingSince = new Date()
        ticket.window = undefined
        ticket.windowNumber = undefined
        await ticket.save()

        await AuditLogModel.create({
            actor: scope.actor,
            actorRole: scope.actorRole,
            action: "STAFF_RETURN_FROM_HOLD",
            entityType: "Ticket",
            entityId: ticket._id as any,
        })

        const [enrichedTicket] = await enrichTickets([ticket])

        return res.json({ ticket: enrichedTicket })
    },

    /**
     * GET /staff/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
     * - Scoped to staff's assigned window group (or assigned department if no group mapping).
     */
    reportsSummary: async (req: Request, res: Response) => {
        const scope = await resolveStaffScope(req)
        if (!hasHandledDepartments(scope)) return res.status(400).json({ message: "Staff not assigned" })

        const fallback = todayKey()
        const from = parseYmd(req.query.from, fallback)
        const to = parseYmd(req.query.to, fallback)
        if (from > to) return res.status(400).json({ message: "Invalid date range" })

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

        const match: any = {
            department: { $in: scope.handledDepartmentObjectIds },
            dateKey: { $gte: from, $lte: to },
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
        ]).exec()

        const total = agg?.total?.[0]?.count ?? 0

        const byStatusArr: Array<{ _id: string; count: number }> = agg?.byStatus ?? []
        const byStatus: Record<string, number> = {
            WAITING: 0,
            CALLED: 0,
            HOLD: 0,
            OUT: 0,
            SERVED: 0,
        }
        for (const row of byStatusArr) byStatus[row._id] = row.count

        const timingRow = agg?.timings?.[0] ?? null
        const avgWaitMs = timingRow?.avgWaitMs ?? null
        const avgServiceMs = timingRow?.avgServiceMs ?? null

        const departments = (agg?.byDepartment ?? []).map((d: any) => ({
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
            context: {
                window: mapWindowPayload(scope.window),
                handledDepartments: scope.handledDepartments,
            },
        })
    },

    /**
     * GET /staff/reports/timeseries?from=YYYY-MM-DD&to=YYYY-MM-DD
     * - Scoped to staff's assigned window group (or assigned department if no group mapping).
     */
    reportsTimeseries: async (req: Request, res: Response) => {
        const scope = await resolveStaffScope(req)
        if (!hasHandledDepartments(scope)) return res.status(400).json({ message: "Staff not assigned" })

        const fallback = todayKey()
        const from = parseYmd(req.query.from, fallback)
        const to = parseYmd(req.query.to, fallback)
        if (from > to) return res.status(400).json({ message: "Invalid date range" })

        const match: any = {
            department: { $in: scope.handledDepartmentObjectIds },
            dateKey: { $gte: from, $lte: to },
        }

        const rows = await TicketModel.aggregate([
            { $match: match },
            {
                $group: {
                    _id: { dateKey: "$dateKey", status: "$status" },
                    count: { $sum: 1 },
                },
            },
            { $sort: { "_id.dateKey": 1 } },
        ]).exec()

        const byDate = new Map<string, any>()

        for (const r of rows) {
            const dateKey = String(r?._id?.dateKey ?? "")
            const status = String(r?._id?.status ?? "").toUpperCase()
            const count = Number(r?.count ?? 0)

            if (!dateKey) continue

            if (!byDate.has(dateKey)) {
                byDate.set(dateKey, {
                    dateKey,
                    total: 0,
                    waiting: 0,
                    called: 0,
                    hold: 0,
                    out: 0,
                    served: 0,
                })
            }

            const obj = byDate.get(dateKey)
            obj.total += count

            if (status === "WAITING") obj.waiting += count
            else if (status === "CALLED") obj.called += count
            else if (status === "HOLD") obj.hold += count
            else if (status === "OUT") obj.out += count
            else if (status === "SERVED") obj.served += count
        }

        const series = Array.from(byDate.values()).sort((a, b) => String(a.dateKey).localeCompare(String(b.dateKey)))

        return res.json({
            range: { from, to },
            series,
            context: {
                window: mapWindowPayload(scope.window),
                handledDepartments: scope.handledDepartments,
            },
        })
    },
}