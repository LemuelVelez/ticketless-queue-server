import type { NextFunction, Request, Response } from "express"
import { Types } from "mongoose"
import { DepartmentService } from "../services/DepartmentService"
import {
    DepartmentModel,
    ServiceWindowModel,
    TicketModel,
    UserModel,
} from "../models/Model"
import { ControllerUtils } from "./ControllerUtils"

function isValidObjectId(value: string): boolean {
    return Types.ObjectId.isValid(String(value ?? "").trim())
}

function getBodyObject(req: Request): Record<string, unknown> {
    if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
        return req.body as Record<string, unknown>
    }

    return {}
}

function getString(value: unknown): string {
    if (Array.isArray(value)) return String(value[0] ?? "").trim()
    return String(value ?? "").trim()
}

function pickFirstString(...values: unknown[]): string {
    for (const value of values) {
        const normalized = getString(value)
        if (normalized) return normalized
    }

    return ""
}

function hasOwn(source: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(source, key)
}

function parseBooleanish(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") return value
    if (typeof value === "number") return value !== 0

    const normalized = getString(value).toLowerCase()
    if (!normalized) return fallback

    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false

    return fallback
}

function normalizeOptionalString(value: unknown): string | undefined {
    const normalized = getString(value)
    return normalized || undefined
}

function normalizeTransactionManager(value: unknown): string {
    return getString(value).toUpperCase()
}

function normalizeAudience(value: unknown): "INTERNAL" | "EXTERNAL" | "" {
    const normalized = getString(value).toUpperCase()
    if (normalized === "INTERNAL" || normalized === "EXTERNAL") return normalized
    return ""
}

function normalizeRegistrarTransactionGroups(value: unknown) {
    if (!Array.isArray(value)) return []

    return value
        .map((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
                return null
            }

            const record = entry as Record<string, unknown>
            const audience = normalizeAudience(record.audience)
            if (!audience) return null

            const rawItems = Array.isArray(record.items) ? record.items : []
            const items = Array.from(
                new Set(rawItems.map((item) => getString(item)).filter(Boolean))
            )

            return {
                audience,
                items,
            }
        })
        .filter(
            (
                group
            ): group is { audience: "INTERNAL" | "EXTERNAL"; items: string[] } =>
                Boolean(group)
        )
}

function isKnownBadRequest(error: unknown): error is Error {
    if (!(error instanceof Error)) return false

    return [
        "Department name is required",
        "transactionManager is required",
        "Invalid departmentId",
    ].includes(error.message)
}

export class DepartmentController {
    static async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const departmentId = ControllerUtils.getValue(req.params.id, req.params.departmentId)

            if (!departmentId) {
                ControllerUtils.sendBadRequest(res, "departmentId is required")
                return
            }

            if (!isValidObjectId(departmentId)) {
                ControllerUtils.sendBadRequest(res, "Invalid departmentId")
                return
            }

            const department = await DepartmentService.getById(departmentId)

            if (!department) {
                ControllerUtils.sendNotFound(res, "Department not found")
                return
            }

            res.status(200).json({ data: department })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const payload = getBodyObject(req)

            const name = getString(payload.name)
            const transactionManager = normalizeTransactionManager(payload.transactionManager)
            const code = normalizeOptionalString(payload.code)
            const enabled = hasOwn(payload, "enabled")
                ? parseBooleanish(payload.enabled, true)
                : true
            const registrarTransactionGroups = hasOwn(payload, "registrarTransactionGroups")
                ? normalizeRegistrarTransactionGroups(payload.registrarTransactionGroups)
                : []

            if (!name) {
                ControllerUtils.sendBadRequest(res, "Department name is required")
                return
            }

            if (!transactionManager) {
                ControllerUtils.sendBadRequest(res, "transactionManager is required")
                return
            }

            const department = await DepartmentModel.create({
                name,
                code,
                transactionManager,
                enabled,
                registrarTransactionGroups,
            })

            res.status(201).json({
                data: DepartmentService.toView(department),
                message: "Department created successfully",
            })
        } catch (error) {
            if (isKnownBadRequest(error)) {
                ControllerUtils.sendBadRequest(res, error.message)
                return
            }

            ControllerUtils.forwardError(error, next)
        }
    }

    static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const payload = getBodyObject(req)
            const departmentId = pickFirstString(
                req.params.id,
                req.params.departmentId,
                payload.id,
                payload._id,
                payload.departmentId
            )

            if (!departmentId) {
                ControllerUtils.sendBadRequest(res, "departmentId is required")
                return
            }

            if (!isValidObjectId(departmentId)) {
                ControllerUtils.sendBadRequest(res, "Invalid departmentId")
                return
            }

            const department = await DepartmentModel.findById(departmentId).exec()

            if (!department) {
                ControllerUtils.sendNotFound(res, "Department not found")
                return
            }

            if (hasOwn(payload, "name")) {
                const name = getString(payload.name)

                if (!name) {
                    ControllerUtils.sendBadRequest(res, "Department name is required")
                    return
                }

                department.name = name
            }

            if (hasOwn(payload, "code")) {
                department.code = normalizeOptionalString(payload.code)
            }

            if (hasOwn(payload, "transactionManager")) {
                const transactionManager = normalizeTransactionManager(payload.transactionManager)

                if (!transactionManager) {
                    ControllerUtils.sendBadRequest(res, "transactionManager is required")
                    return
                }

                department.transactionManager = transactionManager
            }

            if (hasOwn(payload, "enabled")) {
                department.enabled = parseBooleanish(payload.enabled, department.enabled)
            }

            if (hasOwn(payload, "registrarTransactionGroups")) {
                department.registrarTransactionGroups = normalizeRegistrarTransactionGroups(
                    payload.registrarTransactionGroups
                )
            }

            await department.save()

            res.status(200).json({
                data: DepartmentService.toView(department),
                message: "Department updated successfully",
            })
        } catch (error) {
            if (isKnownBadRequest(error)) {
                ControllerUtils.sendBadRequest(res, error.message)
                return
            }

            ControllerUtils.forwardError(error, next)
        }
    }

    static async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const payload = getBodyObject(req)
            const departmentId = pickFirstString(
                req.params.id,
                req.params.departmentId,
                payload.id,
                payload._id,
                payload.departmentId
            )

            if (!departmentId) {
                ControllerUtils.sendBadRequest(res, "departmentId is required")
                return
            }

            if (!isValidObjectId(departmentId)) {
                ControllerUtils.sendBadRequest(res, "Invalid departmentId")
                return
            }

            const departmentObjectId = new Types.ObjectId(departmentId)
            const department = await DepartmentModel.findById(departmentObjectId).exec()

            if (!department) {
                ControllerUtils.sendNotFound(res, "Department not found")
                return
            }

            const [serviceWindows, tickets, users] = await Promise.all([
                ServiceWindowModel.countDocuments({
                    $or: [
                        { department: departmentObjectId },
                        { departmentIds: departmentObjectId },
                    ],
                }).exec(),
                TicketModel.countDocuments({
                    department: departmentObjectId,
                }).exec(),
                UserModel.countDocuments({
                    $or: [
                        { assignedDepartment: departmentObjectId },
                        { assignedDepartments: departmentObjectId },
                        { departmentId: departmentObjectId },
                    ],
                }).exec(),
            ])

            if (serviceWindows > 0 || tickets > 0 || users > 0) {
                res.status(409).json({
                    message: "Department cannot be deleted because it is currently in use",
                    references: {
                        serviceWindows,
                        tickets,
                        users,
                    },
                })
                return
            }

            await DepartmentModel.deleteOne({ _id: departmentObjectId }).exec()

            res.status(200).json({
                data: {
                    id: departmentId,
                    deleted: true,
                },
                message: "Department deleted successfully",
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async listEnabled(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const departments = await DepartmentService.listEnabled()

            res.status(200).json({
                data: departments,
                count: departments.length,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async listByTransactionManager(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const transactionManager = ControllerUtils.getValue(
                req.params.transactionManager,
                req.query.transactionManager
            )

            if (!transactionManager) {
                ControllerUtils.sendBadRequest(res, "transactionManager is required")
                return
            }

            const includeDisabled = ControllerUtils.parseBoolean(
                req.query.includeDisabled,
                false
            )

            const departments = await DepartmentService.listByTransactionManager(
                transactionManager,
                includeDisabled
            )

            res.status(200).json({
                data: departments,
                count: departments.length,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }
}