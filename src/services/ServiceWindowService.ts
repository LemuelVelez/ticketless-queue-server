import { Types } from "mongoose"
import { ServiceWindowModel } from "../models/Model"
import { NameService } from "./NameService"

export type ServiceWindowView = {
    id: string
    name: string
    number: number
    displayName: string
    enabled: boolean
    primaryDepartmentId?: string
    primaryDepartmentName?: string
    departmentIds: string[]
    departmentNames: string[]
    createdAt?: Date
    updatedAt?: Date
}

function normalizeObjectIdString(
    value: string | Types.ObjectId | null | undefined
): string | null {
    const normalized = NameService.toIdString(value)
    if (!normalized) return null
    return Types.ObjectId.isValid(normalized) ? normalized : null
}

function collectWindowDepartments(window: any) {
    const out: Array<{ id: string; name?: string }> = []
    const seen = new Set<string>()

    const pushDepartment = (department: any) => {
        const id = NameService.toIdString(department?._id ?? department)
        if (!id || seen.has(id)) return

        seen.add(id)

        const name = String(NameService.getDepartmentName(department) ?? "").trim()

        out.push({
            id,
            name: name || undefined,
        })
    }

    pushDepartment(window?.department)

    const departments = Array.isArray(window?.departmentIds)
        ? window.departmentIds
        : []

    for (const department of departments) {
        pushDepartment(department)
    }

    return out
}

export class ServiceWindowService {
    static toView(window: any): ServiceWindowView {
        const primaryDepartment = window?.department
        const departmentEntries = collectWindowDepartments(window)

        const primaryDepartmentId =
            NameService.toIdString(primaryDepartment?._id ?? primaryDepartment) ??
            departmentEntries[0]?.id

        const resolvedPrimaryDepartmentName = String(
            primaryDepartment
                ? NameService.getDepartmentName(primaryDepartment)
                : departmentEntries[0]?.name ?? ""
        ).trim()

        return {
            id: NameService.toIdString(window?._id) ?? "",
            name: String(window?.name ?? "").trim(),
            number: Number(window?.number ?? 0),
            displayName: NameService.getWindowName(window),
            enabled: Boolean(window?.enabled),
            primaryDepartmentId: primaryDepartmentId || undefined,
            primaryDepartmentName: resolvedPrimaryDepartmentName || undefined,
            departmentIds: departmentEntries.map((department) => department.id),
            departmentNames: departmentEntries
                .map((department) => String(department.name ?? "").trim())
                .filter((value): value is string => Boolean(value)),
            createdAt: window?.createdAt,
            updatedAt: window?.updatedAt,
        }
    }

    static async getById(windowId: string | Types.ObjectId): Promise<ServiceWindowView | null> {
        const normalizedWindowId = normalizeObjectIdString(windowId)
        if (!normalizedWindowId) return null

        const window = await ServiceWindowModel.findById(normalizedWindowId)
            .populate("department", "name code")
            .populate("departmentIds", "name code")
            .exec()

        return window ? ServiceWindowService.toView(window) : null
    }

    static async list(options?: {
        includeDisabled?: boolean
        departmentId?: string | Types.ObjectId | null
    }): Promise<ServiceWindowView[]> {
        const includeDisabled = Boolean(options?.includeDisabled)
        const normalizedDepartmentId = normalizeObjectIdString(
            options?.departmentId ?? null
        )

        const filter: Record<string, unknown> = {}

        if (!includeDisabled) {
            filter.enabled = true
        }

        if (normalizedDepartmentId) {
            filter.$or = [
                { department: normalizedDepartmentId },
                { departmentIds: normalizedDepartmentId },
            ]
        }

        const windows = await ServiceWindowModel.find(filter)
            .populate("department", "name code")
            .populate("departmentIds", "name code")
            .sort({ number: 1, name: 1 })
            .exec()

        return windows.map((window) => ServiceWindowService.toView(window))
    }

    static async listEnabled(): Promise<ServiceWindowView[]> {
        return ServiceWindowService.list({ includeDisabled: false })
    }

    static async listByDepartment(
        departmentId: string | Types.ObjectId,
        includeDisabled = false
    ): Promise<ServiceWindowView[]> {
        return ServiceWindowService.list({
            departmentId,
            includeDisabled,
        })
    }

    static async getNameMap(
        ids: Array<string | Types.ObjectId | null | undefined>
    ): Promise<Map<string, string>> {
        const normalizedIds = Array.from(
            new Set(ids.map((id) => normalizeObjectIdString(id)).filter(Boolean) as string[])
        )

        if (!normalizedIds.length) return new Map()

        const windows = await ServiceWindowModel.find({ _id: { $in: normalizedIds } })
            .select("name number")
            .exec()

        const map = new Map<string, string>()

        for (const window of windows) {
            map.set(String(window._id), NameService.getWindowName(window))
        }

        return map
    }
}