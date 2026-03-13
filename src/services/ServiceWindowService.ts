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

export class ServiceWindowService {
    static toView(window: any): ServiceWindowView {
        const primaryDepartment = window?.department
        const departments = Array.isArray(window?.departmentIds) ? window.departmentIds : []

        return {
            id: NameService.toIdString(window?._id) ?? "",
            name: String(window?.name ?? "").trim(),
            number: Number(window?.number ?? 0),
            displayName: NameService.getWindowName(window),
            enabled: Boolean(window?.enabled),
            primaryDepartmentId: NameService.toIdString(
                primaryDepartment?._id ?? primaryDepartment
            ),
            primaryDepartmentName: primaryDepartment
                ? NameService.getDepartmentName(primaryDepartment)
                : undefined,
            departmentIds: departments
                .map((department: any) => NameService.toIdString(department?._id ?? department))
                .filter((value: string | undefined): value is string => Boolean(value)),
            departmentNames: departments.map((department: any) =>
                NameService.getDepartmentName(department)
            ),
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

    static async listEnabled(): Promise<ServiceWindowView[]> {
        const windows = await ServiceWindowModel.find({ enabled: true })
            .populate("department", "name code")
            .populate("departmentIds", "name code")
            .sort({ number: 1, name: 1 })
            .exec()

        return windows.map((window) => ServiceWindowService.toView(window))
    }

    static async listByDepartment(
        departmentId: string | Types.ObjectId,
        includeDisabled = false
    ): Promise<ServiceWindowView[]> {
        const normalizedDepartmentId = normalizeObjectIdString(departmentId)
        if (!normalizedDepartmentId) return []

        const filter: Record<string, unknown> = {
            $or: [{ department: normalizedDepartmentId }, { departmentIds: normalizedDepartmentId }],
        }

        if (!includeDisabled) filter.enabled = true

        const windows = await ServiceWindowModel.find(filter)
            .populate("department", "name code")
            .populate("departmentIds", "name code")
            .sort({ number: 1, name: 1 })
            .exec()

        return windows.map((window) => ServiceWindowService.toView(window))
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