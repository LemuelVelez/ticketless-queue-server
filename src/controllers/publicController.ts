import type { Request, Response } from "express"

import { DepartmentModel } from "../models/Department"
import { QueueCounterModel } from "../models/QueueCounter"
import { SettingModel } from "../models/Setting"
import { TicketModel } from "../models/Ticket"

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
import { getTransactionsForParticipant } from "../services/registrarTransactions.service"

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

async function nextQueueNumber(departmentId: string, dateKey: string) {
    const counter = await QueueCounterModel.findOneAndUpdate(
        { department: departmentId, dateKey },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
    )
    return counter.seq
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
            const departmentId = asString(body.departmentId)

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
                departmentId: optional(departmentId),

                // compatibility aliases (old/new services)
                name: optional(asString(body.name)) || optional(fullName),
                studentId: optional(asString(body.studentId || tcNumber)),
                password: optional(asString(body.password || pin)),
                phone: optional(asString(body.phone || mobileNumber)),
            }

            const result = await signupStudent(payload)
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
            const departmentId = asString(body.departmentId)

            const fullName = composeName(firstName, middleName, lastName)

            const payload = {
                ...body,

                // canonical (new)
                firstName: optional(firstName),
                middleName: optional(middleName),
                lastName: optional(lastName),
                mobileNumber: optional(mobileNumber),
                pin: optional(pin),
                departmentId: optional(departmentId),

                // compatibility aliases (old/new services)
                name: optional(asString(body.name)) || optional(fullName),
                password: optional(asString(body.password || pin)),
                phone: optional(asString(body.phone || mobileNumber)),
            }

            const result = await signupAlumniVisitor(payload)
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

        return res.json({
            session: {
                expiresAt: state.session.expiresAt,
            },
            participant: state.profile,
            availableTransactions: getTransactionsForParticipant(state.participant.type),
        })
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

        // New participant-session based flow
        if (sessionToken) {
            try {
                const transactionKeys = Array.isArray(body.transactionKeys)
                    ? body.transactionKeys.map((x: unknown) => String(x).trim()).filter(Boolean)
                    : []

                const displayImmediately =
                    Boolean(body.presentDirectlyToDisplayMonitor) || asBoolean(body.shouldDisplayImmediately)

                const ticket = await joinQueueService({
                    sessionToken,
                    transactionKeys,
                    presentDirectlyToDisplayMonitor: displayImmediately,
                })

                return res.status(201).json({ ticket })
            } catch (err) {
                const message = err instanceof Error ? err.message : "Unable to join queue"
                return res.status(knownErrorStatus(message)).json({ message })
            }
        }

        // Legacy flow fallback (departmentId + studentId)
        const { departmentId, studentId, phone } = body
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
        if (!departmentId || !studentId) return res.status(400).json({ message: "departmentId and studentId are required" })

        const ticket = await TicketModel.findOne({
            department: String(departmentId),
            dateKey: todayKey(),
            studentId: String(studentId).trim(),
            status: { $in: ACTIVE_STATUSES as any },
        }).sort({ createdAt: -1 })

        return res.json({ ticket: ticket || null })
    },
}
