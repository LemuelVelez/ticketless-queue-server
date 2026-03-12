import type { NextFunction, Request, Response } from "express"
import { ControllerUtils } from "./ControllerUtils"
import { AuthError, AuthService } from "../services/AuthService"
import type { AuthenticatedRequest } from "./middlewares"

function handleAuthError(
    error: unknown,
    res: Response,
    next: NextFunction
): void {
    if (error instanceof AuthError) {
        res.status(error.status).json({
            ok: false,
            message: error.message,
        })
        return
    }

    ControllerUtils.forwardError(error, next)
}

export class AuthController {
    static async register(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const result = await AuthService.registerParticipant(req.body ?? {})

            res.status(201).json({
                ok: true,
                message: "Registration successful",
                data: result,
            })
        } catch (error) {
            handleAuthError(error, res, next)
        }
    }

    static async login(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const result = await AuthService.login(req.body ?? {})

            res.status(200).json({
                ok: true,
                message: "Login successful",
                data: result,
            })
        } catch (error) {
            handleAuthError(error, res, next)
        }
    }

    static async forgotPassword(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const result = await AuthService.forgotPassword(req.body ?? {})

            res.status(200).json({
                ok: true,
                ...result,
            })
        } catch (error) {
            handleAuthError(error, res, next)
        }
    }

    static async resetPassword(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const result = await AuthService.resetPassword(req.body ?? {})

            res.status(200).json({
                ok: true,
                ...result,
            })
        } catch (error) {
            handleAuthError(error, res, next)
        }
    }

    static async me(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<void> {
        try {
            const authReq = req as AuthenticatedRequest
            const currentUser = authReq.currentUser

            if (!currentUser) {
                res.status(401).json({
                    ok: false,
                    message: "Authentication required",
                })
                return
            }

            res.status(200).json({
                ok: true,
                data: currentUser,
            })
        } catch (error) {
            handleAuthError(error, res, next)
        }
    }
}