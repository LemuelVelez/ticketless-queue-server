import type { NextFunction, Request, Response } from "express"
import { Types } from "mongoose"
import { ServiceWindowService } from "../services/ServiceWindowService"
import { ControllerUtils } from "./ControllerUtils"
import { DepartmentModel, ServiceWindowModel } from "../models/Model"

function isValidObjectId(value: string): boolean {
    return Types.ObjectId.isValid(String(value ?? "").trim())
}

function getString(value: unknown): string {
    if (Array.isArray(value)) return String(value[0] ?? "").trim()
    return String(value ?? "").trim()
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(object, key)
}

function getBodyObject(req: Request): Record<string, unknown> {
    if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
        return req.body as Record<string, unknown>
    }

    return {}
}

function parseBoolean(value: unknown, fallback = false): boolean {
    const raw = getString(value).toLowerCase()
    if (!raw) return fallback
    if (["1", "true", "yes", "y", "on"].includes(raw)) return true
    if (["0", "false", "no", "n", "off"].includes(raw)) return false
    return fallback
}

function parsePositiveInteger(
    value: unknown,
    fallback?: number
): number | null {
    const raw = getString(value)

    if (!raw) {
        if (
            typeof fallback === "number" &&
            Number.isInteger(fallback) &&
            fallback > 0
        ) {
            return fallback
        }

        return null
    }

    const parsed = Number.parseInt(raw, 10)
    if (!Number.isInteger(parsed) || parsed <= 0) return null
    return parsed
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
    const out: string[] = []
    const seen = new Set<string>()

    for (const value of values) {
        const clean = getString(value)
        if (!clean || seen.has(clean)) continue
        seen.add(clean)
        out.push(clean)
    }

    return out
}

function parseIdArray(value: unknown): string[] {
    if (!Array.isArray(value)) return []

    const out: string[] = []

    for (const item of value) {
        if (typeof item === "string" || typeof item === "number") {
            const id = getString(item)
            if (id) out.push(id)
            continue
        }

        if (isRecord(item)) {
            const id = getString(
                item._id ?? item.id ?? item.departmentId ?? item.value
            )
            if (id) out.push(id)
        }
    }

    return uniqueStrings(out)
}

function collectDepartmentIds(source: Record<string, unknown>): string[] {
    return uniqueStrings([
        ...parseIdArray(source.departmentIds),
        ...parseIdArray(source.departments),
        getString(source.departmentId),
        getString(source.department),
    ])
}

function extractExistingWindowState(source: unknown) {
    const record = isRecord(source) ? source : {}

    const departmentIds = uniqueStrings([
        ...parseIdArray(record.departmentIds),
        ...parseIdArray(record.departments),
        getString(record.departmentId),
        getString(record.department),
    ])

    const name =
        getString(record.name) ||
        getString(record.windowName) ||
        getString(record.label)

    const rawNumber =
        record.number !== undefined ? record.number : record.windowNumber

    const number = parsePositiveInteger(rawNumber)
    const enabled = hasOwn(record, "enabled")
        ? parseBoolean(record.enabled, true)
        : parseBoolean(record.isEnabled, true)

    return {
        departmentIds,
        name,
        number,
        enabled,
    }
}

async function validateDepartmentIds(
    departmentIds: string[]
): Promise<string | null> {
    for (const departmentId of departmentIds) {
        if (!isValidObjectId(departmentId)) {
            return "Invalid departmentId"
        }
    }

    if (!departmentIds.length) {
        return "At least one department is required"
    }

    const count = await DepartmentModel.countDocuments({
        _id: {
            $in: departmentIds.map((departmentId) => new Types.ObjectId(departmentId)),
        },
    })

    if (count !== departmentIds.length) {
        return "One or more departments do not exist"
    }

    return null
}

function buildWindowPayload(
    body: Record<string, unknown>,
    existing?: {
        departmentIds: string[]
        name: string
        number: number | null
        enabled: boolean
    }
) {
    const requestedDepartmentIds = collectDepartmentIds(body)
    const departmentIds = requestedDepartmentIds.length
        ? requestedDepartmentIds
        : (existing?.departmentIds ?? [])

    const name =
        getString(body.name) ||
        getString(body.windowName) ||
        getString(body.label) ||
        existing?.name ||
        ""

    const rawNumber = hasOwn(body, "number")
        ? body.number
        : hasOwn(body, "windowNumber")
          ? body.windowNumber
          : undefined

    const number = parsePositiveInteger(rawNumber, existing?.number ?? undefined)

    const enabled = hasOwn(body, "enabled")
        ? parseBoolean(body.enabled, existing?.enabled ?? true)
        : hasOwn(body, "isEnabled")
          ? parseBoolean(body.isEnabled, existing?.enabled ?? true)
          : (existing?.enabled ?? true)

    if (!departmentIds.length) {
        return {
            error: "At least one department is required",
        } as const
    }

    if (!name) {
        return {
            error: "Window name is required",
        } as const
    }

    if (!number) {
        return {
            error: "Window number must be a positive integer",
        } as const
    }

    const firstDepartmentId = departmentIds[0] ?? null

    return {
        payload: {
            name,
            windowName: name,
            number,
            windowNumber: number,
            enabled,
            isEnabled: enabled,
            departmentIds,
            departments: departmentIds,
            departmentId: firstDepartmentId,
            department: firstDepartmentId,
        },
    } as const
}

export class ServiceWindowController {
    static async list(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const departmentId = ControllerUtils.getValue(
                req.query.departmentId,
                req.params.departmentId
            )

            if (departmentId && !isValidObjectId(departmentId)) {
                ControllerUtils.sendBadRequest(res, "Invalid departmentId")
                return
            }

            const includeDisabled = ControllerUtils.parseBoolean(
                req.query.includeDisabled,
                false
            )

            const windows = await ServiceWindowService.list({
                includeDisabled,
                departmentId,
            })

            res.status(200).json({
                data: windows,
                count: windows.length,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async getById(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const windowId = ControllerUtils.getValue(req.params.id, req.params.windowId)

            if (!windowId) {
                ControllerUtils.sendBadRequest(res, "windowId is required")
                return
            }

            if (!isValidObjectId(windowId)) {
                ControllerUtils.sendBadRequest(res, "Invalid windowId")
                return
            }

            const window = await ServiceWindowService.getById(windowId)

            if (!window) {
                ControllerUtils.sendNotFound(res, "Service window not found")
                return
            }

            res.status(200).json({ data: window })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async create(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const body = getBodyObject(req)
            const built = buildWindowPayload(body)

            if ("error" in built) {
                ControllerUtils.sendBadRequest(res, built.error)
                return
            }

            const validationError = await validateDepartmentIds(
                built.payload.departmentIds
            )

            if (validationError) {
                ControllerUtils.sendBadRequest(res, validationError)
                return
            }

            const created = await ServiceWindowModel.create(built.payload)
            const createdView =
                (await ServiceWindowModel.findById(created._id).lean()) || created

            res.status(201).json({
                data: createdView,
                message: "Service window created successfully",
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async update(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const windowId = ControllerUtils.getValue(req.params.id, req.params.windowId)

            if (!windowId) {
                ControllerUtils.sendBadRequest(res, "windowId is required")
                return
            }

            if (!isValidObjectId(windowId)) {
                ControllerUtils.sendBadRequest(res, "Invalid windowId")
                return
            }

            const existing = await ServiceWindowModel.findById(windowId)

            if (!existing) {
                ControllerUtils.sendNotFound(res, "Service window not found")
                return
            }

            const body = getBodyObject(req)
            const existingState = extractExistingWindowState(
                typeof existing.toObject === "function" ? existing.toObject() : existing
            )

            const built = buildWindowPayload(body, existingState)

            if ("error" in built) {
                ControllerUtils.sendBadRequest(res, built.error)
                return
            }

            const validationError = await validateDepartmentIds(
                built.payload.departmentIds
            )

            if (validationError) {
                ControllerUtils.sendBadRequest(res, validationError)
                return
            }

            existing.set(built.payload)
            await existing.save()

            const updated =
                (await ServiceWindowModel.findById(windowId).lean()) || existing

            res.status(200).json({
                data: updated,
                message: "Service window updated successfully",
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const windowId = ControllerUtils.getValue(req.params.id, req.params.windowId)

            if (!windowId) {
                ControllerUtils.sendBadRequest(res, "windowId is required")
                return
            }

            if (!isValidObjectId(windowId)) {
                ControllerUtils.sendBadRequest(res, "Invalid windowId")
                return
            }

            const deleted = await ServiceWindowModel.findByIdAndDelete(windowId).lean()

            if (!deleted) {
                ControllerUtils.sendNotFound(res, "Service window not found")
                return
            }

            res.status(200).json({
                data: deleted,
                message: "Service window deleted successfully",
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async listEnabled(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const windows = await ServiceWindowService.listEnabled()

            res.status(200).json({
                data: windows,
                count: windows.length,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }

    static async listByDepartment(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const departmentId = ControllerUtils.getValue(
                req.params.departmentId,
                req.query.departmentId
            )

            if (!departmentId) {
                ControllerUtils.sendBadRequest(res, "departmentId is required")
                return
            }

            if (!isValidObjectId(departmentId)) {
                ControllerUtils.sendBadRequest(res, "Invalid departmentId")
                return
            }

            const includeDisabled = ControllerUtils.parseBoolean(
                req.query.includeDisabled,
                false
            )

            const windows = await ServiceWindowService.listByDepartment(
                departmentId,
                includeDisabled
            )

            res.status(200).json({
                data: windows,
                count: windows.length,
            })
        } catch (error) {
            ControllerUtils.forwardError(error, next)
        }
    }
}