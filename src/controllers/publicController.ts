import type { Request, Response } from "express"
import mongoose, { Types } from "mongoose"

import { DepartmentModel } from "../models/Department"
import { QueueCounterModel } from "../models/QueueCounter"
import { SettingModel } from "../models/Setting"
import { TicketModel } from "../models/Ticket"
import { UserModel } from "../models/User"

import {
    loginAlumniVisitor,
    loginStudent,
    logoutParticipantSession,
    signupAlumniVisitor,
    signupStudent,
    verifyParticipantSession,
} from "../services/participantAuth.service"
import {
    getDateKeyManila,
    joinQueue as joinQueueService,
    presentDirectlyToDisplayMonitor,
    TicketTransactionSelectionModel,
} from "../services/queue.service"
import {
    getTransactionsForParticipant,
    getTransactionsForParticipantInDepartment,
    type ParticipantQueueType,
} from "../services/registrarTransactions.service"

const ACTIVE_STATUSES = ["WAITING", "CALLED", "HOLD"] as const

function todayKey() {
    return getDateKeyManila()
}

function asString(v: unknown) {
    if (typeof v === "string") return v.trim()
    if (Array.isArray(v) && v.length) return String(v[0] ?? "").trim()
    return ""
}

function asBoolean(v: unknown) {
    if (typeof v === "boolean") return v
    if (typeof v !== "string") return false
    const s = v.trim().toLowerCase()
    return s === "1" || s === "true" || s === "yes" || s === "y" || s === "on"
}

/**
 * Safely converts unknown input into a deduplicated string[].
 * Fixes TS2322 when passing transactionKeys into joinQueueService.
 */
function asStringArray(v: unknown): string[] {
    if (!Array.isArray(v)) return []

    const out: string[] = []
    const seen = new Set<string>()

    for (const item of v) {
        const s = String(item ?? "").trim()
        if (!s || seen.has(s)) continue
        seen.add(s)
        out.push(s)
    }

    return out
}

function knownErrorStatus(message: string) {
    const m = message.toLowerCase()
    if (m.includes("invalid credentials") || m.includes("please login")) return 401
    if (m.includes("not found")) return 404
    if (m.includes("already") || m.includes("duplicate")) return 409
    return 400
}

function getSessionToken(req: Request) {
    const auth = String(req.headers.authorization || "")
    if (auth.startsWith("Bearer ")) {
        const token = auth.slice(7).trim()
        if (token) return token
    }

    const headerToken = asString(req.headers["x-session-token"])
    if (headerToken) return headerToken

    const bodyToken = asString((req.body || {}).sessionToken)
    if (bodyToken) return bodyToken

    const queryToken = asString((req.query || {}).sessionToken)
    if (queryToken) return queryToken

    return ""
}

function composeName(firstName: string, middleName: string, lastName: string) {
    return [firstName, middleName, lastName]
        .map((x) => x.trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
}

function optional(value: string) {
    const v = value.trim()
    return v ? v : undefined
}

function safeObjectId(value: string) {
    const v = String(value ?? "").trim()
    if (!v) return null
    if (!Types.ObjectId.isValid(v)) return null
    return new Types.ObjectId(v)
}

/**
 * ✅ Narrow any unknown/string participant type into ParticipantQueueType
 * so TS is happy and runtime stays safe.
 */
function toParticipantQueueType(value: unknown): ParticipantQueueType {
    const raw = asString(value)
    const upper = raw.replace(/\s+/g, "_").toUpperCase()

    // Common canonical values
    if (upper === "STUDENT") return "STUDENT" as ParticipantQueueType
    if (upper === "ALUMNI_VISITOR") return "ALUMNI_VISITOR" as ParticipantQueueType
    if (upper === "GUEST") return "GUEST" as ParticipantQueueType

    // Common legacy/variants -> map safely
    if (upper === "ALUMNI-VISITOR" || upper === "ALUMNI") return "ALUMNI_VISITOR" as ParticipantQueueType
    if (upper === "VISITOR") return "GUEST" as ParticipantQueueType

    // Safe fallback (least privilege)
    return "GUEST" as ParticipantQueueType
}

async function nextQueueNumber(departmentId: string, dateKey: string) {
    const counter = await QueueCounterModel.findOneAndUpdate(
        { department: departmentId, dateKey },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
    )
    return counter.seq
}

/** -----------------------------
 * ✅ Robust participant resolution
 * Fixes: PATCH profile returning 404 "Participant not found"
 * when verifyParticipantSession returns an id/profile stored in a different model/shape.
 * ----------------------------- */

function isMongooseDoc(v: any): v is { _id: any; save: () => Promise<any>; toObject: () => any } {
    return Boolean(v && typeof v === "object" && v._id && typeof v.save === "function")
}

function looksLikeParticipantRecord(v: any) {
    if (!v || typeof v !== "object") return false
    const role = String((v as any).role ?? (v as any).type ?? "").toUpperCase()
    if (["STUDENT", "ALUMNI_VISITOR", "GUEST", "VISITOR"].includes(role)) return true

    // heuristic: participant records usually have at least one of these
    if ("mobileNumber" in v || "phone" in v || "tcNumber" in v || "studentId" in v || "departmentId" in v) return true
    return false
}

function extractId(val: any): string {
    if (!val) return ""
    if (typeof val === "string") return val.trim()

    if (typeof val === "object") {
        const candidates = [
            (val as any)._id,
            (val as any).id,
            (val as any).userId,
            (val as any).participantId,
        ]
        for (const c of candidates) {
            const s = String(c ?? "").trim()
            if (s) return s
        }
    }

    return ""
}

async function getParticipantIdFromState(state: any): Promise<string> {
    const candidates = [
        state?.participantId,
        state?.profileId,
        state?.userId,

        state?.participant,
        state?.profile,
        state?.user,

        state?.participant?._id,
        state?.participant?.id,

        state?.profile?._id,
        state?.profile?.id,
        state?.profile?.userId,
        state?.profile?.participantId,

        state?.user?._id,
        state?.user?.id,

        state?.session?.participantId,
        state?.session?.userId,
        state?.session?.participant?._id,
        state?.session?.participant?.id,
        state?.session?.profile?._id,
        state?.session?.profile?.id,

        state?.session?.user?._id,
        state?.session?.user?.id,
    ]

    for (const c of candidates) {
        const id = extractId(c)
        if (id) return id
    }

    return ""
}

const PARTICIPANT_MODEL_NAME_CANDIDATES = [
    "Participant",
    "Participants",
    "Student",
    "Students",
    "AlumniVisitor",
    "Alumni",
    "Guest",
    "Visitor",
    "Registrant",
    "PublicUser",
    "PublicAccount",
] as const

function modelProbablyStoresParticipants(Model: any) {
    const paths = Model?.schema?.paths
    if (!paths) return false
    return Boolean(
        paths.mobileNumber ||
            paths.phone ||
            paths.tcNumber ||
            paths.studentId ||
            paths.departmentId ||
            paths.department ||
            paths.type
    )
}

async function findParticipantDocById(id: string): Promise<any | null> {
    const clean = String(id ?? "").trim()
    if (!clean || !Types.ObjectId.isValid(clean)) return null

    // 1) Try the obvious model used throughout the codebase
    const userDoc = await UserModel.findById(clean)
    if (userDoc && looksLikeParticipantRecord(userDoc)) return userDoc

    // 2) Try well-known participant-ish model names if they exist
    for (const name of PARTICIPANT_MODEL_NAME_CANDIDATES) {
        const Model = (mongoose.models as any)?.[name]
        if (!Model || typeof Model.findById !== "function") continue
        const doc = await Model.findById(clean)
        if (doc && looksLikeParticipantRecord(doc)) return doc
    }

    // 3) Last resort: scan registered models that have participant-like fields
    for (const name of mongoose.modelNames()) {
        const Model = (mongoose.models as any)?.[name]
        if (!Model || typeof Model.findById !== "function") continue
        if (!modelProbablyStoresParticipants(Model)) continue

        const doc = await Model.findById(clean)
        if (doc && looksLikeParticipantRecord(doc)) return doc
    }

    return null
}

async function findParticipantLeanById(id: string): Promise<any | null> {
    const clean = String(id ?? "").trim()
    if (!clean || !Types.ObjectId.isValid(clean)) return null

    const user = await UserModel.findById(clean).lean()
    if (user && looksLikeParticipantRecord(user)) return user

    for (const name of PARTICIPANT_MODEL_NAME_CANDIDATES) {
        const Model = (mongoose.models as any)?.[name]
        if (!Model || typeof Model.findById !== "function") continue
        const doc = await Model.findById(clean).lean?.()
        if (doc && looksLikeParticipantRecord(doc)) return doc
    }

    for (const name of mongoose.modelNames()) {
        const Model = (mongoose.models as any)?.[name]
        if (!Model || typeof Model.findById !== "function") continue
        if (!modelProbablyStoresParticipants(Model)) continue

        const doc = await Model.findById(clean).lean?.()
        if (doc && looksLikeParticipantRecord(doc)) return doc
    }

    return null
}

function extractDepartmentIdFromProfileOrState(profile: any, state: any): string {
    // Prefer stored participant department (locked)
    const fromProfile =
        asString(profile?.departmentId) ||
        asString(profile?.department) ||
        asString(state?.profile?.departmentId) ||
        asString(state?.profile?.department) ||
        asString(state?.participant?.departmentId) ||
        asString(state?.participant?.department) ||
        asString(state?.participant?.department?.toString?.() ?? state?.participant?.department)

    return fromProfile
}

async function ensureEnabledDepartment(deptId: Types.ObjectId): Promise<boolean> {
    const exists = await DepartmentModel.exists({ _id: deptId, enabled: true })
    return Boolean(exists)
}

export const publicController = {
    listDepartments: async (_req: Request, res: Response) => {
        const departments = await DepartmentModel.find({ enabled: true }).sort({ name: 1 })
        return res.json({ departments })
    },

    signupStudent: async (req: Request, res: Response) => {
        try {
            const body = req.body || {}

            const firstName = asString(body.firstName)
            const middleName = asString(body.middleName)
            const lastName = asString(body.lastName)

            const tcNumber = asString(body.tcNumber || body.studentId)
            const pin = asString(body.pin || body.password)
            const mobileNumber = asString(body.mobileNumber || body.phone)
            const departmentId = asString(body.departmentId || body.department)

            if (!departmentId) return res.status(400).json({ message: "departmentId is required" })
            const deptObjId = safeObjectId(departmentId)
            if (!deptObjId) return res.status(400).json({ message: "Invalid departmentId" })

            const okDept = await ensureEnabledDepartment(deptObjId)
            if (!okDept) return res.status(404).json({ message: "Department not found/disabled" })

            const fullName = composeName(firstName, middleName, lastName)

            const payload = {
                ...body,

                // canonical (new)
                firstName: optional(firstName),
                middleName: optional(middleName),
                lastName: optional(lastName),
                tcNumber: optional(tcNumber),
                pin: optional(pin),
                mobileNumber: optional(mobileNumber),

                // IMPORTANT: always set canonical departmentId for participant records
                departmentId: String(deptObjId),

                // compatibility aliases (old/new services)
                department: optional(asString(body.department || departmentId)),
                name: optional(asString(body.name)) || optional(fullName),
                studentId: optional(asString(body.studentId || tcNumber)),
                password: optional(asString(body.password || pin)),
                phone: optional(asString(body.phone || mobileNumber)),
            }

            const result = await signupStudent(payload as any)
            return res.status(201).json(result)
        } catch (err) {
            const message = err instanceof Error ? err.message : "Unable to signup student"
            return res.status(knownErrorStatus(message)).json({ message })
        }
    },

    signupAlumniVisitor: async (req: Request, res: Response) => {
        try {
            const body = req.body || {}

            const firstName = asString(body.firstName)
            const middleName = asString(body.middleName)
            const lastName = asString(body.lastName)

            const mobileNumber = asString(body.mobileNumber || body.phone)
            const pin = asString(body.pin || body.password)
            const departmentId = asString(body.departmentId || body.department)

            if (!departmentId) return res.status(400).json({ message: "departmentId is required" })
            const deptObjId = safeObjectId(departmentId)
            if (!deptObjId) return res.status(400).json({ message: "Invalid departmentId" })

            const okDept = await ensureEnabledDepartment(deptObjId)
            if (!okDept) return res.status(404).json({ message: "Department not found/disabled" })

            const fullName = composeName(firstName, middleName, lastName)

            const payload = {
                ...body,

                // canonical (new)
                firstName: optional(firstName),
                middleName: optional(middleName),
                lastName: optional(lastName),
                mobileNumber: optional(mobileNumber),
                pin: optional(pin),

                // IMPORTANT: always set canonical departmentId for participant records
                departmentId: String(deptObjId),

                // compatibility aliases (old/new services)
                department: optional(asString(body.department || departmentId)),
                name: optional(asString(body.name)) || optional(fullName),
                password: optional(asString(body.password || pin)),
                phone: optional(asString(body.phone || mobileNumber)),
            }

            const result = await signupAlumniVisitor(payload as any)
            return res.status(201).json(result)
        } catch (err) {
            const message = err instanceof Error ? err.message : "Unable to signup alumni/visitor"
            return res.status(knownErrorStatus(message)).json({ message })
        }
    },

    loginStudent: async (req: Request, res: Response) => {
        try {
            const tcNumber = asString((req.body || {}).tcNumber || (req.body || {}).studentId)
            const pin = asString((req.body || {}).pin || (req.body || {}).password)

            if (!tcNumber || !pin) {
                return res.status(400).json({ message: "tcNumber and pin are required" })
            }

            const result = await loginStudent(tcNumber, pin)
            return res.json(result)
        } catch (err) {
            const message = err instanceof Error ? err.message : "Unable to login"
            return res.status(knownErrorStatus(message)).json({ message })
        }
    },

    loginAlumniVisitor: async (req: Request, res: Response) => {
        try {
            const mobileNumber = asString((req.body || {}).mobileNumber || (req.body || {}).phone)
            const pin = asString((req.body || {}).pin || (req.body || {}).password)

            if (!mobileNumber || !pin) {
                return res.status(400).json({ message: "mobileNumber and pin are required" })
            }

            const result = await loginAlumniVisitor(mobileNumber, pin)
            return res.json(result)
        } catch (err) {
            const message = err instanceof Error ? err.message : "Unable to login"
            return res.status(knownErrorStatus(message)).json({ message })
        }
    },

    participantSession: async (req: Request, res: Response) => {
        const sessionToken = getSessionToken(req)
        if (!sessionToken) return res.status(400).json({ message: "sessionToken is required" })

        const state = await verifyParticipantSession(sessionToken)
        if (!state) return res.status(401).json({ message: "Invalid or expired session" })

        // ✅ Always return the freshest profile from DB (prevents stale session profile after PATCH)
        let profile: any = state.profile || null
        try {
            const participantId = await getParticipantIdFromState(state)
            if (participantId) {
                const fresh = await findParticipantLeanById(participantId)
                if (fresh) profile = fresh
            }
        } catch {
            // ignore (fallback to state.profile)
        }

        // 🔒 Department is LOCKED to the participant record.
        // Do NOT allow overriding via query/body (prevents switching departments after registration).
        const participantDepartmentId = extractDepartmentIdFromProfileOrState(profile, state)

        const participantTypeRaw =
            asString(profile?.type) || asString(state.profile?.type) || asString(state.participant?.type) || ""

        const participantType = toParticipantQueueType(participantTypeRaw)

        let availableTransactions = getTransactionsForParticipant(participantType)

        if (participantDepartmentId) {
            try {
                availableTransactions = await getTransactionsForParticipantInDepartment(participantType, participantDepartmentId)
            } catch {
                // Fallback for invalid/missing department mappings.
                availableTransactions = getTransactionsForParticipant(participantType)
            }
        }

        return res.json({
            session: {
                expiresAt: state.session.expiresAt,
            },
            participant: profile,
            availableTransactions,
            // ✅ helps frontend lock department UI after registration
            departmentLocked: Boolean(participantDepartmentId),
        })
    },

    // ✅ Update participant profile (Student / Alumni-Visitor / Guest)
    updateParticipantProfile: async (req: Request, res: Response) => {
        try {
            const sessionToken = getSessionToken(req)
            if (!sessionToken) return res.status(400).json({ message: "sessionToken is required" })

            const state = await verifyParticipantSession(sessionToken)
            if (!state) return res.status(401).json({ message: "Invalid or expired session" })

            // ✅ Fix: resolve participant reliably (state shape + model can differ)
            let user: any = null

            if (isMongooseDoc(state?.profile) && looksLikeParticipantRecord(state.profile)) {
                user = state.profile
            } else if (isMongooseDoc(state?.participant) && looksLikeParticipantRecord(state.participant)) {
                user = state.participant
            } else {
                const participantId = await getParticipantIdFromState(state)
                if (!participantId) return res.status(404).json({ message: "Participant not found" })

                user = await findParticipantDocById(participantId)
                if (!user) return res.status(404).json({ message: "Participant not found" })
            }

            const body = req.body || {}

            const firstName = asString(body.firstName)
            const middleName = asString(body.middleName)
            const lastName = asString(body.lastName)

            const incomingType = toParticipantQueueType(
                body.type || body.participantType || (user as any).type || (user as any).role
            )
            const name = asString(body.name) || composeName(firstName, middleName, lastName)

            const tcNumber = asString(body.tcNumber || body.studentId)
            const mobileNumber = asString(body.mobileNumber || body.phone)

            // May be omitted after registration (because department becomes locked)
            const requestedDepartmentId = asString(body.departmentId || body.department)

            const smsUpdates = typeof body.smsUpdates === "boolean" ? Boolean(body.smsUpdates) : undefined

            // Basic validation (frontend sends required fields)
            if (!firstName) return res.status(400).json({ message: "firstName is required" })
            if (!lastName) return res.status(400).json({ message: "lastName is required" })
            if (!mobileNumber) return res.status(400).json({ message: "mobileNumber is required" })

            // 🔒 Department lock behavior:
            // - If participant already has a departmentId, it is LOCKED and cannot be changed.
            // - If participant has no departmentId yet, the first provided departmentId is saved and becomes locked.
            const currentDept =
                (user as any).departmentId ? String((user as any).departmentId) : (user as any).department ? String((user as any).department) : ""

            const departmentChangeIgnored = Boolean(currentDept && requestedDepartmentId && currentDept !== requestedDepartmentId)

            const deptToUse = currentDept || requestedDepartmentId
            if (!deptToUse) return res.status(400).json({ message: "departmentId is required" })

            const deptObjId = safeObjectId(deptToUse)
            if (!deptObjId) return res.status(400).json({ message: "Invalid departmentId" })

            // Only validate enabled department when it's being set for the first time
            if (!currentDept) {
                const okDept = await ensureEnabledDepartment(deptObjId)
                if (!okDept) return res.status(404).json({ message: "Department not found/disabled" })
            }

            ;(user as any).firstName = firstName
            ;(user as any).middleName = middleName || undefined
            ;(user as any).lastName = lastName
            ;(user as any).name = name

            ;(user as any).mobileNumber = mobileNumber
            ;(user as any).phone = mobileNumber // keep alias

            // ✅ Locked department persisted in canonical field
            ;(user as any).departmentId = deptObjId

            // Keep participant type aligned (safe for participant accounts)
            ;(user as any).type = incomingType
            const roleUpper = String((user as any).role || "").toUpperCase()
            if (roleUpper === "STUDENT" || roleUpper === "ALUMNI_VISITOR" || roleUpper === "GUEST" || !roleUpper) {
                ;(user as any).role = incomingType
            }

            // If this participant is a STUDENT, keep tcNumber + studentId synchronized
            if (incomingType === "STUDENT") {
                if (!tcNumber) return res.status(400).json({ message: "tcNumber is required for students" })
                ;(user as any).tcNumber = tcNumber
                ;(user as any).studentId = tcNumber
            }

            // Optional preference (safe even if older clients don’t send it)
            if (smsUpdates !== undefined) {
                ;(user as any).smsUpdates = smsUpdates
            }

            await (user as any).save()

            return res.json({
                ok: true,
                participant: typeof (user as any).toObject === "function" ? (user as any).toObject() : user,
                // ✅ tells UI that department is immutable once saved
                departmentLocked: Boolean((user as any).departmentId),
                // ✅ tells UI an attempted change was ignored (useful for showing a toast)
                departmentChangeIgnored,
            })
        } catch (err) {
            const message = err instanceof Error ? err.message : "Unable to update profile"
            return res.status(knownErrorStatus(message)).json({ message })
        }
    },

    logoutParticipant: async (req: Request, res: Response) => {
        const sessionToken = getSessionToken(req)
        if (!sessionToken) return res.status(400).json({ message: "sessionToken is required" })

        await logoutParticipantSession(sessionToken)
        return res.json({ ok: true })
    },

    joinQueue: async (req: Request, res: Response) => {
        const body = req.body || {}
        const sessionToken = getSessionToken(req)

        const hasModernPayload =
            Array.isArray(body.transactionKeys) ||
            body.presentDirectlyToDisplayMonitor !== undefined ||
            body.shouldDisplayImmediately !== undefined

        // New participant-session based flow
        if (sessionToken && hasModernPayload) {
            try {
                const state = await verifyParticipantSession(sessionToken)
                if (!state) return res.status(401).json({ message: "Invalid or expired session" })

                let profile: any = state.profile || null
                try {
                    const participantId = await getParticipantIdFromState(state)
                    if (participantId) {
                        const fresh = await findParticipantLeanById(participantId)
                        if (fresh) profile = fresh
                    }
                } catch {
                    // ignore
                }

                // 🔒 Department is LOCKED to the participant record.
                // Ignore any client-provided departmentId to prevent switching departments after registration.
                const lockedDepartmentId = extractDepartmentIdFromProfileOrState(profile, state)
                const fallbackDepartmentId = asString(body.departmentId || body.department)
                const departmentIdToUse = lockedDepartmentId || fallbackDepartmentId

                const transactionKeys: string[] = asStringArray(body.transactionKeys)

                const displayImmediately =
                    Boolean(body.presentDirectlyToDisplayMonitor) || asBoolean(body.shouldDisplayImmediately)

                const joined = await joinQueueService({
                    sessionToken,
                    transactionKeys,
                    presentDirectlyToDisplayMonitor: displayImmediately,
                    departmentId: optional(asString(departmentIdToUse)),
                    studentId: optional(asString(body.studentId)),
                    phone: optional(asString(body.phone)),
                })

                // Backward-compatible response shape expected by existing frontend (ticket object).
                const ticketDoc = await TicketModel.findById(joined.ticketId).populate("department", "name enabled")

                const fallbackTicket = {
                    _id: joined.ticketId,
                    queueNumber: joined.queueNumber,
                    dateKey: joined.dateKey,
                    status: joined.status,
                    windowNumber: joined.windowNumber ?? null,
                }

                return res.status(201).json({
                    ticket: ticketDoc ?? fallbackTicket,
                    join: joined,
                    departmentLocked: Boolean(lockedDepartmentId),
                })
            } catch (err) {
                const message = err instanceof Error ? err.message : "Unable to join queue"
                return res.status(knownErrorStatus(message)).json({ message })
            }
        }

        // Legacy flow fallback (departmentId + studentId)
        const departmentId = asString(body.departmentId)
        const studentId = asString(body.studentId)
        const phone = asString(body.phone)

        if (!departmentId || !studentId) {
            return res.status(400).json({ message: "departmentId and studentId are required" })
        }

        const dept = await DepartmentModel.findById(departmentId)
        if (!dept || !dept.enabled) return res.status(404).json({ message: "Department not found/disabled" })

        const settings = await SettingModel.findOne({})
        const disallowDup = settings?.disallowDuplicateActiveTickets ?? true

        const dateKey = todayKey()
        const sid = String(studentId).trim()

        if (disallowDup) {
            const existing = await TicketModel.findOne({
                department: departmentId,
                dateKey,
                studentId: sid,
                status: { $in: ACTIVE_STATUSES as any },
            })

            if (existing) {
                return res.status(409).json({
                    message: "Duplicate active ticket is not allowed for this department",
                    ticket: existing,
                })
            }
        }

        const queueNumber = await nextQueueNumber(String(departmentId), dateKey)

        const ticket = await TicketModel.create({
            department: departmentId,
            dateKey,
            queueNumber,
            studentId: sid,
            phone: phone ? String(phone).trim() : undefined,
            status: "WAITING",
            holdAttempts: 0,
            waitingSince: new Date(),
        })

        return res.status(201).json({ ticket })
    },

    presentToDisplayMonitor: async (req: Request, res: Response) => {
        const ticketId = asString((req.body || {}).ticketId)
        if (!ticketId) return res.status(400).json({ message: "ticketId is required" })

        try {
            const ticket = await presentDirectlyToDisplayMonitor(ticketId)
            return res.json({ ticket })
        } catch (err) {
            const message = err instanceof Error ? err.message : "Unable to present ticket"
            return res.status(knownErrorStatus(message)).json({ message })
        }
    },

    getTicket: async (req: Request, res: Response) => {
        const { id } = req.params

        const ticket = await TicketModel.findById(id).populate("department", "name enabled")
        if (!ticket) return res.status(404).json({ message: "Ticket not found" })

        const transactions = await TicketTransactionSelectionModel.findOne({ ticket: ticket._id })
            .select("transactionKeys transactionLabels participantType")
            .lean()

        return res.json({
            ticket,
            transactions: transactions
                ? {
                      transactionKeys: transactions.transactionKeys,
                      transactionLabels: transactions.transactionLabels,
                      participantType: transactions.participantType,
                  }
                : null,
        })
    },

    // Handy lookup for student side (optional)
    findActiveByStudent: async (req: Request, res: Response) => {
        const { departmentId, studentId } = req.query as any
        if (!departmentId || !studentId) {
            return res.status(400).json({ message: "departmentId and studentId are required" })
        }

        const ticket = await TicketModel.findOne({
            department: String(departmentId),
            dateKey: todayKey(),
            studentId: String(studentId).trim(),
            status: { $in: ACTIVE_STATUSES as any },
        }).sort({ createdAt: -1 })

        return res.json({ ticket: ticket || null })
    },
}